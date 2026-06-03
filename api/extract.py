from http.server import BaseHTTPRequestHandler
import json
import io
import re
from collections import defaultdict

import pdfplumber


def to_float(s):
    """Convertit '1.674,49' ou '8,05' en float."""
    try:
        s = s.replace(" ", "").replace(" ", "")
        if "," in s:
            s = s.replace(".", "").replace(",", ".")
        return float(s)
    except (ValueError, AttributeError):
        return 0.0


TRACK_RE = re.compile(r"^\d{14,}$")          # n° de tracking (>=14 chiffres)
DATE_RE = re.compile(r"^\d{2}/\d{2}")
REF_RE = re.compile(r"^[A-Z]{1,4}\d{3,}$")    # S62432, TBR3187991, etc.

# Bandes de colonnes (format TNT/FedEx "Relevé d'opérations").
COL_REF = (383, 480)
COL_POIDS = (560, 592)
COL_TRANSPORT = (635, 672)
COL_OPTIONS = (745, 775)
COL_TOTAL = (800, 835)

MOIS_FR = ["", "Janvier", "Février", "Mars", "Avril", "Mai", "Juin",
           "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"]


def _band_num(row, lo, hi):
    for w in row:
        if lo <= w["x0"] < hi and "," in w["text"]:
            return to_float(w["text"])
    return 0.0


def _row_from_words(row):
    """Construit une ligne de colis depuis les mots d'une ligne, ou None."""
    tokens = [w["text"] for w in row]
    tracking = next((t for t in tokens if TRACK_RE.match(t)), None)
    if not tracking:
        return None
    ref = ""
    for w in row:
        if COL_REF[0] <= w["x0"] < COL_REF[1] and REF_RE.match(w["text"]):
            ref = w["text"]
            break
    if not ref:
        ref = "SANS_REF"
    date = ""
    for w in row:
        if w["x0"] < 40 and DATE_RE.match(w["text"]):
            date = w["text"]
            break
    zone = ""
    for w in row:
        if 360 < w["x0"] < 385 and len(w["text"]) == 1 and w["text"].isalpha():
            zone = w["text"]
            break
    return {
        "ref": ref, "date": date, "zone": zone, "tracking": tracking,
        "weight": round(_band_num(row, *COL_POIDS), 2),
        "transport": round(_band_num(row, *COL_TRANSPORT), 2),
        "options": round(_band_num(row, *COL_OPTIONS), 2),
        "total": round(_band_num(row, *COL_TOTAL), 2),
    }


def aggregate(rows):
    """Regroupe par référence (une commande = plusieurs colis)."""
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
    """Extrait surcharge carburant (montant + taux) et total général HT d'un texte."""
    taux = total_ht = 0.0
    mt = re.search(r"Surcharge Carburant\s*([\d.]+,\d{1,2})\s*%", txt)
    if mt:
        taux = to_float(mt.group(1))
    # Une facture peut avoir plusieurs comptes → plusieurs lignes de surcharge : on les somme.
    # On ne garde qu'une occurrence par ligne (le montant est répété 2x dans le relevé).
    surcharge = 0.0
    seen = set()
    for line in txt.split("\n"):
        m = re.search(r"Surcharge Carburant.*?taux officiel\s*([\d.]+,\d{2})", line)
        if m:
            key = line.strip()
            if key in seen:
                continue
            seen.add(key)
            surcharge += to_float(m.group(1))
    m2 = re.search(r"TOTAL GENERAL.*?([\d.]+,\d{2})\s*E\s*UR", txt)
    if m2:
        total_ht = to_float(m2.group(1))
    return round(surcharge, 2), round(taux, 2), round(total_ht, 2)


def _stats_for(lignes, surcharge, taux, total_ht):
    commandes = aggregate(lignes)
    tt = round(sum(r["transport"] for r in lignes), 2)
    to = round(sum(r["options"] for r in lignes), 2)
    tl = round(sum(r["total"] for r in lignes), 2)
    total_general = total_ht or round(tl + surcharge, 2)
    # Surcharge à répartir = écart entre le TOTAL GÉNÉRAL (HT facture) et la somme
    # des totaux de lignes. Réconcilie au centime, robuste aux comptes multiples.
    carb = round(total_general - tl, 2)
    if carb < 0:
        carb = surcharge
    # Coût réel par commande = total ligne + quote-part carburant (réparti au transport).
    for c in commandes:
        share = carb * (c["transport"] / tt) if tt else 0.0
        c["coutReel"] = round(c["total"] + share, 2)
    for l in lignes:
        share = carb * (l["transport"] / tt) if tt else 0.0
        l["coutReel"] = round(l["total"] + share, 2)
    return commandes, {
        "nb_lignes": len(lignes), "nb_commandes": len(commandes),
        "total_transport": tt, "total_options": to, "total_facture": tl,
        "surcharge_carburant": carb, "surcharge_taux": taux,
        "total_general_ht": total_general,
    }


def extract_all(pdf_bytes):
    """Segmente le PDF par facture, parse chaque mois + le combiné annuel."""
    factures = []
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        cur = None
        for page in pdf.pages:
            # Un seul parsing de la page (extract_words) ; le texte est reconstruit
            # depuis les mots pour éviter un second passage coûteux (extract_text).
            lines = defaultdict(list)
            for w in page.extract_words():
                lines[round(w["top"])].append(w)
            sorted_tops = sorted(lines.keys())
            text_rows = []
            for top in sorted_tops:
                row = sorted(lines[top], key=lambda w: w["x0"])
                text_rows.append(" ".join(w["text"] for w in row))
            txt = "\n".join(text_rows)
            mper = re.search(r"Période facturée : du (\d+)/(\d+)/(\d+) au (\d+)/(\d+)/(\d+)", txt)
            mnum = re.search(r"FACTURE N°\s*([0-9 ]+)", txt)
            if mper:
                mois = int(mper.group(2))
                an = mper.group(3)
                cur = {
                    "num": (mnum.group(1).strip() if mnum else ""),
                    "periode_debut": f"{int(mper.group(3)):04d}-{int(mper.group(2)):02d}-{int(mper.group(1)):02d}",
                    "periode_fin": f"{int(mper.group(6)):04d}-{int(mper.group(5)):02d}-{int(mper.group(4)):02d}",
                    "mois_label": f"{MOIS_FR[mois]} {an}",
                    "mois_key": f"{an}-{mois:02d}",
                    "_text": "", "lignes": [],
                }
                factures.append(cur)
            if cur is None:
                continue
            cur["_text"] += "\n" + txt
            for top in sorted_tops:
                row = sorted(lines[top], key=lambda w: w["x0"])
                r = _row_from_words(row)
                if r:
                    r["mois"] = cur["mois_label"]
                    cur["lignes"].append(r)

    # Finalise chaque facture
    all_lignes = []
    out_factures = []
    for f in factures:
        surch, taux, tot = parse_summary_text(f["_text"])
        commandes, stats = _stats_for(f["lignes"], surch, taux, tot)
        all_lignes.extend(f["lignes"])
        # commandes/lignes par mois non renvoyées (le front filtre le combiné par mois) → payload léger
        out_factures.append({
            "num": f["num"], "mois_label": f["mois_label"], "mois_key": f["mois_key"],
            "periode_debut": f["periode_debut"], "periode_fin": f["periode_fin"],
            "stats": stats,
        })
    out_factures.sort(key=lambda x: x["mois_key"])

    # Combiné (toutes factures) : utilisé pour le croisement Odoo global.
    comb_surch = round(sum(f["stats"]["surcharge_carburant"] for f in out_factures), 2)
    comb_total = round(sum(f["stats"]["total_general_ht"] for f in out_factures), 2)
    commandes_comb = aggregate(all_lignes)
    # coutReel combiné : somme déjà calculée par ligne → on agrège par ref
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
    # La réponse Vercel est limitée à ~4,5 Mo. Le détail par colis (lignes) est
    # le plus volumineux : on l'omet au-delà d'un seuil (l'analyse reste au niveau
    # commande). ~8000 colis ≈ 2,5 Mo de payload, marge confortable.
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
    def _send(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(200, {"ok": True})

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            pdf_bytes = self.rfile.read(length)
            if not pdf_bytes:
                self._send(400, {"error": "Aucun fichier reçu"})
                return
            self._send(200, extract_all(pdf_bytes))
        except Exception as e:
            self._send(500, {"error": str(e)})
