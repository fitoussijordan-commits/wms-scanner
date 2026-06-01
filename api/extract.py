from http.server import BaseHTTPRequestHandler
import json
import io
import re
from collections import defaultdict

import pdfplumber


def to_float(s):
    try:
        return float(s.replace(",", ".").replace("\u00a0", "").replace(" ", ""))
    except (ValueError, AttributeError):
        return 0.0


REF_RE = re.compile(r"^S\d{4,}$")
NUM_RE = re.compile(r"^\d{1,3}(?:[.,]\d{1,3})?$")
SERVICE_TOKENS = {"EXP", "ENL", "RET", "INT", "IMP", "DOM"}


def extract_rows(pdf_bytes):
    """
    Extrait chaque ligne d'expédition de la facture FedEx/TNT.

    Colonnes repérées par position X (validées sur le format WALA):
      x~14  Date          x~376 Zone     x~387 Référence (Sxxxxx)
      x~487 N° tracking   x~547 Produit  x~572 Poids
      x~594 Service       x~645 Prix transport
      x~716 Service 2     x~755 Prix 2   x~812 Total
    """
    rows = []
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for page in pdf.pages:
            words = page.extract_words()
            lines = defaultdict(list)
            for w in words:
                lines[round(w["top"])].append(w)

            for top in sorted(lines.keys()):
                row = sorted(lines[top], key=lambda w: w["x0"])
                tokens = [w["text"] for w in row]

                # Référence S#####
                ref = next((t for t in tokens if REF_RE.match(t)), None)
                if not ref:
                    continue

                # Date = premier token à gauche au format jj/mm
                date = ""
                for w in row:
                    if w["x0"] < 40 and re.match(r"\d{2}/\d{2}", w["text"]):
                        date = w["text"]
                        break

                # Zone tarifaire (lettre seule autour de x=376)
                zone = ""
                for w in row:
                    if 360 < w["x0"] < 385 and len(w["text"]) == 1 and w["text"].isalpha():
                        zone = w["text"]
                        break

                # N° tracking = long nombre (>= 10 chiffres)
                tracking = next((t for t in tokens if t.isdigit() and len(t) >= 10), "")

                # Tous les nombres décimaux de la ligne, triés par X
                num_words = [w for w in row if NUM_RE.match(w["text"]) and "," in w["text"]]
                num_words.sort(key=lambda w: w["x0"])

                # Total = dernière colonne (X max)
                total = to_float(num_words[-1]["text"]) if num_words else 0.0

                # Poids = premier nombre décimal (avant le 1er service)
                weight = 0.0
                service_x = None
                for w in row:
                    if w["text"] in SERVICE_TOKENS:
                        service_x = w["x0"]
                        break
                if service_x is not None:
                    before = [w for w in num_words if w["x0"] < service_x]
                    if before:
                        weight = to_float(before[0]["text"])

                # Transport pur = 1er prix après le 1er token service
                transport = 0.0
                for i, w in enumerate(row):
                    if w["text"] in SERVICE_TOKENS:
                        for nxt in row[i + 1:]:
                            if NUM_RE.match(nxt["text"]) and "," in nxt["text"]:
                                transport = to_float(nxt["text"])
                                break
                        break

                rows.append({
                    "ref": ref,
                    "date": date,
                    "zone": zone,
                    "tracking": tracking,
                    "weight": weight,
                    "transport": round(transport, 2),
                    "total": round(total, 2),
                })
    return rows


def aggregate(rows):
    """Regroupe par référence (une commande peut avoir plusieurs colis)."""
    by_ref = {}
    for r in rows:
        k = r["ref"]
        if k not in by_ref:
            by_ref[k] = {
                "ref": k, "date": r["date"], "zone": r["zone"],
                "colis": 0, "weight": 0.0, "transport": 0.0, "total": 0.0,
            }
        agg = by_ref[k]
        agg["colis"] += 1
        agg["weight"] = round(agg["weight"] + r["weight"], 2)
        agg["transport"] = round(agg["transport"] + r["transport"], 2)
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

            self._send(200, {
                "lignes": lignes,
                "commandes": commandes,
                "stats": {
                    "nb_lignes": len(lignes),
                    "nb_commandes": len(commandes),
                    "total_transport": round(sum(r["transport"] for r in lignes), 2),
                    "total_facture": round(sum(r["total"] for r in lignes), 2),
                },
            })
        except Exception as e:
            self._send(500, {"error": str(e)})
