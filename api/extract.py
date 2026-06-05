from http.server import BaseHTTPRequestHandler
import json
import io
import re
import os
import hmac
from collections import defaultdict

import fitz  # PyMuPDF — ~10-50× plus rapide que pdfplumber


def to_float(s):
    try:
        s = s.replace(" ", "").replace(" ", "")
        if "," in s:
            s = s.replace(".", "").replace(",", ".")
        return float(s)
    except (ValueError, AttributeError):
        return 0.0


TRACK_RE = re.compile(r"^\d{14,}$")
DATE_RE = re.compile(r"^\d{2}/\d{2}")
REF_RE = re.compile(r"^[A-Z]{1,4}\d{3,}$")

# Bandes de colonnes (format TNT/FedEx "Relevé d'opérations", coordonnées pivotées).
COL_REF = (383, 480)
COL_POIDS = (560, 592)
COL_TRANSPORT = (635, 672)
COL_OPTIONS = (745, 775)
COL_TOTAL = (800, 835)

MOIS_FR = ["", "Janvier", "Février", "Mars", "Avril", "Mai", "Juin",
           "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"]


def _page_rows(page):
    """Renvoie les lignes de la page sous forme de listes de (x0, texte),
    en appliquant la rotation de page pour retrouver les colonnes visuelles."""
    mat = page.rotation_matrix
    lines = defaultdict(list)
    for w in page.get_text("words"):
        r = fitz.Rect(w[:4]) * mat
        lines[round(r.y0)].append((r.x0, w[4]))
    out = []
    for top in sorted(lines.keys()):
        out.append(sorted(lines[top], key=lambda t: t[0]))
    return out


def _band_num(row, lo, hi):
    for x0, t in row:
        if lo <= x0 < hi and "," in t:
            return to_float(t)
    return 0.0


def _row_from_words(row):
    tokens = [t for _, t in row]
    tracking = next((t for t in tokens if TRACK_RE.match(t)), None)
    if not tracking:
        return None
    ref = ""
    for x0, t in row:
        if COL_REF[0] <= x0 < COL_REF[1] and REF_RE.match(t):
            ref = t
            break
    if not ref:
        ref = "SANS_REF"
    date = ""
    for x0, t in row:
        if x0 < 40 and DATE_RE.match(t):
            date = t
            break
    zone = ""
    for x0, t in row:
        if 360 < x0 < 385 and len(t) == 1 and t.isalpha():
            zone = t
            break
    return {
        "ref": ref, "date": date, "zone": zone, "tracking": tracking,
        "weight": round(_band_num(row, *COL_POIDS), 2),
        "transport": round(_band_num(row, *COL_TRANSPORT), 2),
        "options": round(_band_num(row, *COL_OPTIONS), 2),
        "total": round(_band_num(row, *COL_TOTAL), 2),
    }


def aggregate(rows):
    by_ref = {}
    for r in rows:
        k = r["ref"]
        if k not in by_ref:
            by_ref[k] = {"ref": k, "date": r["date"], "zone": r["zone"], "mois": r.get("mois", ""),
                         "colis": 0, "weight": 0.0, "transport": 0.0, "options": 0.0, "total": 0.0}
        a = by_ref[k]
        a["colis"] += 1
        a["weight"] = round(a["weight"] + r["weight"], 2)
        a["transport"] = round(a["transport"] + r["transport"], 2)
        a["options"] = round(a["options"] + r["options"], 2)
        a["total"] = round(a["total"] + r["total"], 2)
    return sorted(by_ref.values(), key=lambda x: x["ref"])


def parse_summary_text(txt):
    """Renvoie (carburant_reel, taux, total_general_ht).

    Le montant carburant réel = somme des lignes par COMPTE :
    'NNNNNNNN : Surcharge Carburant 17,15% taux officiel 1.064,42'
    (une par compte, sans doublon — la ligne récap non préfixée est ignorée)."""
    taux = total_ht = 0.0
    carb = 0.0
    for line in txt.split("\n"):
        m = re.match(r"\s*\d+\s*:\s*Surcharge Carburant\s*([\d.]+,\d{1,2})\s*%.*?taux officiel\s*([\d.]+,\d{2})", line)
        if m:
            if not taux:
                taux = to_float(m.group(1))
            carb += to_float(m.group(2))
    mt = re.search(r"Surcharge Carburant\s*([\d.]+,\d{1,2})\s*%", txt)
    if mt and not taux:
        taux = to_float(mt.group(1))
    m2 = re.search(r"TOTAL GENERAL.*?([\d.]+,\d{2})\s*E\s*UR", txt)
    if m2:
        total_ht = to_float(m2.group(1))
    return round(carb, 2), round(taux, 2), round(total_ht, 2)


def _stats_for(lignes, carb_reel, taux, total_ht):
    commandes = aggregate(lignes)
    tt = round(sum(r["transport"] for r in lignes), 2)
    to = round(sum(r["options"] for r in lignes), 2)
    tl = round(sum(r["total"] for r in lignes), 2)
    total_general = total_ht or round(tl + carb_reel, 2)
    # Montant carburant AFFICHÉ = valeur réelle lue par compte sur la facture.
    carb_aff = carb_reel
    # Montant carburant RÉPARTI pour le coût réel = écart au TOTAL GÉNÉRAL, afin que
    # la somme des coûts réels réconcilie au centime (absorbe les petits écarts de parsing).
    carb_dist = round(total_general - tl, 2)
    if carb_dist < 0:
        carb_dist = carb_reel
    for c in commandes:
        share = carb_dist * (c["transport"] / tt) if tt else 0.0
        c["coutReel"] = round(c["total"] + share, 2)
    for l in lignes:
        share = carb_dist * (l["transport"] / tt) if tt else 0.0
        l["coutReel"] = round(l["total"] + share, 2)
    return commandes, {
        "nb_lignes": len(lignes), "nb_commandes": len(commandes),
        "total_transport": tt, "total_options": to, "total_facture": tl,
        "surcharge_carburant": carb_aff, "surcharge_taux": taux,
        "total_general_ht": round(total_general, 2),
    }


def extract_all(pdf_bytes):
    factures = []
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    cur = None
    for page in doc:
        rows = _page_rows(page)
        txt = "\n".join(" ".join(t for _, t in row) for row in rows)
        mper = re.search(r"Période facturée : du (\d+)/(\d+)/(\d+) au (\d+)/(\d+)/(\d+)", txt)
        mnum = re.search(r"FACTURE N°\s*([0-9 ]+)", txt)
        if mper:
            mois = int(mper.group(2)); an = mper.group(3)
            cur = {
                "num": (mnum.group(1).strip() if mnum else ""),
                "periode_debut": f"{int(mper.group(3)):04d}-{int(mper.group(2)):02d}-{int(mper.group(1)):02d}",
                "periode_fin": f"{int(mper.group(6)):04d}-{int(mper.group(5)):02d}-{int(mper.group(4)):02d}",
                "mois_label": f"{MOIS_FR[mois]} {an}", "mois_key": f"{an}-{mois:02d}",
                "_text": "", "lignes": [],
            }
            factures.append(cur)
        if cur is None:
            continue
        cur["_text"] += "\n" + txt
        for row in rows:
            r = _row_from_words(row)
            if r:
                r["mois"] = cur["mois_label"]
                cur["lignes"].append(r)

    # Fallback : aucun en-tête de période détecté → une seule facture sur tout le doc.
    if not factures:
        cur = {"num": "", "periode_debut": "", "periode_fin": "", "mois_label": "Facture",
               "mois_key": "", "_text": "", "lignes": []}
        for page in doc:
            rows = _page_rows(page)
            cur["_text"] += "\n" + "\n".join(" ".join(t for _, t in row) for row in rows)
            for row in rows:
                r = _row_from_words(row)
                if r:
                    cur["lignes"].append(r)
        factures = [cur]

    all_lignes = []
    out_factures = []
    for f in factures:
        carb_reel, taux, tot = parse_summary_text(f["_text"])
        commandes, stats = _stats_for(f["lignes"], carb_reel, taux, tot)
        all_lignes.extend(f["lignes"])
        out_factures.append({
            "num": f["num"], "mois_label": f["mois_label"], "mois_key": f["mois_key"],
            "periode_debut": f["periode_debut"], "periode_fin": f["periode_fin"], "stats": stats,
        })
    out_factures.sort(key=lambda x: x["mois_key"])

    comb_surch = round(sum(f["stats"]["surcharge_carburant"] for f in out_factures), 2)
    comb_total = round(sum(f["stats"]["total_general_ht"] for f in out_factures), 2)
    commandes_comb = aggregate(all_lignes)
    cr_by_ref = defaultdict(float)
    for l in all_lignes:
        cr_by_ref[l["ref"]] += l.get("coutReel", l["total"])
    for c in commandes_comb:
        c["coutReel"] = round(cr_by_ref.get(c["ref"], c["total"]), 2)
    stats_comb = {
        "nb_lignes": len(all_lignes), "nb_commandes": len(commandes_comb),
        "total_transport": round(sum(l["transport"] for l in all_lignes), 2),
        "total_options": round(sum(l["options"] for l in all_lignes), 2),
        "total_facture": round(sum(l["total"] for l in all_lignes), 2),
        "surcharge_carburant": comb_surch, "surcharge_taux": 0.0,
        "total_general_ht": comb_total,
    }

    LIGNES_MAX = 8000
    lignes_omises = len(all_lignes) > LIGNES_MAX
    return {
        "multi": len(out_factures) > 1,
        "factures": out_factures,
        "lignes": [] if lignes_omises else all_lignes,
        "lignes_omises": lignes_omises,
        "commandes": commandes_comb,
        "stats": stats_comb,
    }


class handler(BaseHTTPRequestHandler):
    def _check_token(self) -> bool:
        expected = os.environ.get("WMS_INTERNAL_TOKEN", "")
        received = self.headers.get("X-WMS-Token", "")
        if not expected:
            return True  # pas de token configuré → pas de blocage
        return hmac.compare_digest(expected, received)  # timing-safe

    def _send(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "same-origin")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-WMS-Token")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(200, {"ok": True})

    def do_POST(self):
        if not self._check_token():
            self._send(401, {"error": "Non autorisé"})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            pdf_bytes = self.rfile.read(length)
            if not pdf_bytes:
                self._send(400, {"error": "Aucun fichier reçu"})
                return
            self._send(200, extract_all(pdf_bytes))
        except Exception as e:
            self._send(500, {"error": "Erreur traitement PDF"})
