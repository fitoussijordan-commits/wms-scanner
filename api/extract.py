from http.server import BaseHTTPRequestHandler
import json
import io
import re
from collections import defaultdict

import pdfplumber


def to_float(s):
    """Convertit '1.674,49' ou '8,05' en float."""
    try:
        s = s.replace(" ", "").replace(" ", "")
        # format français : point = milliers, virgule = décimale
        if "," in s:
            s = s.replace(".", "").replace(",", ".")
        return float(s)
    except (ValueError, AttributeError):
        return 0.0


TRACK_RE = re.compile(r"^\d{14,}$")          # n° de tracking (>=14 chiffres)
DATE_RE = re.compile(r"^\d{2}/\d{2}")
REF_RE = re.compile(r"^[A-Z]{1,4}\d{3,}$")    # S62432, TBR3187991, etc.

# Bandes de colonnes (validées sur le format TNT/FedEx "Relevé d'opérations").
#   x~14 Date | x~376 Zone | x~387 Référence | x~487 Tracking
#   x~547 Produit | x~572 Poids | x~646 Prix transport
#   x~755 Prix options | x~812 Total ligne
COL_REF = (383, 480)
COL_POIDS = (560, 592)
COL_TRANSPORT = (635, 672)
COL_OPTIONS = (745, 775)
COL_TOTAL = (800, 835)


def _band_num(row, lo, hi):
    """Premier nombre décimal dont x0 tombe dans la bande [lo, hi)."""
    for w in row:
        if lo <= w["x0"] < hi and "," in w["text"]:
            return to_float(w["text"])
    return 0.0


def extract_rows(pdf_bytes):
    """Extrait chaque colis (ligne avec un n° de tracking) par position de colonne."""
    rows = []
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for page in pdf.pages:
            lines = defaultdict(list)
            for w in page.extract_words():
                lines[round(w["top"])].append(w)

            for top in sorted(lines.keys()):
                row = sorted(lines[top], key=lambda w: w["x0"])
                tokens = [w["text"] for w in row]

                # Une ligne de colis = présence d'un n° de tracking.
                tracking = next((t for t in tokens if TRACK_RE.match(t)), None)
                if not tracking:
                    continue

                # Référence : token alphanumérique dans la colonne réf (S…, TBR…).
                ref = ""
                for w in row:
                    if COL_REF[0] <= w["x0"] < COL_REF[1] and REF_RE.match(w["text"]):
                        ref = w["text"]
                        break
                if not ref:
                    ref = "SANS_REF"

                # Date (colonne gauche, format jj/mm).
                date = ""
                for w in row:
                    if w["x0"] < 40 and DATE_RE.match(w["text"]):
                        date = w["text"]
                        break

                # Zone tarifaire (lettre seule ~x376).
                zone = ""
                for w in row:
                    if 360 < w["x0"] < 385 and len(w["text"]) == 1 and w["text"].isalpha():
                        zone = w["text"]
                        break

                weight = _band_num(row, *COL_POIDS)
                transport = _band_num(row, *COL_TRANSPORT)
                options = _band_num(row, *COL_OPTIONS)
                total = _band_num(row, *COL_TOTAL)

                rows.append({
                    "ref": ref,
                    "date": date,
                    "zone": zone,
                    "tracking": tracking,
                    "weight": round(weight, 2),
                    "transport": round(transport, 2),
                    "options": round(options, 2),
                    "total": round(total, 2),
                })
    return rows


def extract_summary(pdf_bytes):
    """Récupère la surcharge carburant et le total général HT depuis le récap."""
    surcharge = 0.0
    total_ht = 0.0
    taux = 0.0
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for page in pdf.pages[:2] + pdf.pages[-2:]:
            txt = page.extract_text() or ""
            # Taux lu dynamiquement (évolue chaque mois) : "Surcharge Carburant 17,15% taux officiel 1.674,49"
            mt = re.search(r"Surcharge Carburant\s*([\d.]+,\d{1,2})\s*%", txt)
            if mt and not taux:
                taux = to_float(mt.group(1))
            m = re.search(r"Surcharge Carburant.*?taux officiel\s*([\d.]+,\d{2})", txt)
            if m and not surcharge:
                surcharge = to_float(m.group(1))
            m2 = re.search(r"TOTAL GENERAL.*?([\d.]+,\d{2})\s*E\s*UR", txt)
            if m2 and not total_ht:
                total_ht = to_float(m2.group(1))
    return round(surcharge, 2), round(total_ht, 2), round(taux, 2)


def aggregate(rows):
    """Regroupe par référence (une commande peut avoir plusieurs colis)."""
    by_ref = {}
    for r in rows:
        k = r["ref"]
        if k not in by_ref:
            by_ref[k] = {
                "ref": k, "date": r["date"], "zone": r["zone"],
                "colis": 0, "weight": 0.0, "transport": 0.0, "options": 0.0, "total": 0.0,
            }
        agg = by_ref[k]
        agg["colis"] += 1
        agg["weight"] = round(agg["weight"] + r["weight"], 2)
        agg["transport"] = round(agg["transport"] + r["transport"], 2)
        agg["options"] = round(agg["options"] + r["options"], 2)
        agg["total"] = round(agg["total"] + r["total"], 2)
    return sorted(by_ref.values(), key=lambda x: x["ref"])


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

            lignes = extract_rows(pdf_bytes)
            commandes = aggregate(lignes)
            surcharge, total_ht, taux = extract_summary(pdf_bytes)

            total_transport = round(sum(r["transport"] for r in lignes), 2)
            total_options = round(sum(r["options"] for r in lignes), 2)
            total_lignes = round(sum(r["total"] for r in lignes), 2)

            self._send(200, {
                "lignes": lignes,
                "commandes": commandes,
                "stats": {
                    "nb_lignes": len(lignes),
                    "nb_commandes": len(commandes),
                    "total_transport": total_transport,
                    "total_options": total_options,
                    "total_facture": total_lignes,
                    "surcharge_carburant": surcharge,
                    "surcharge_taux": taux,
                    "total_general_ht": total_ht or round(total_lignes + surcharge, 2),
                },
            })
        except Exception as e:
            self._send(500, {"error": str(e)})
