from http.server import BaseHTTPRequestHandler
import json
import re
import os
import hmac
from collections import defaultdict

import fitz  # PyMuPDF


def to_float(s):
    try:
        s = s.replace(" ", "").replace(" ", "")
        if "," in s:
            s = s.replace(".", "").replace(",", ".")
        return float(s)
    except (ValueError, AttributeError):
        return 0.0


DATE = re.compile(r"^\d{2}/\d{2}$")
NUM = re.compile(r"^\d{1,3}(?:[ . ]\d{3})*,\d{1,2}$")
REFODOO = re.compile(r"^S\d{4,6}$")
DPT = re.compile(r"^\d{2}$")

MOIS_FR = ["", "Janvier", "Février", "Mars", "Avril", "Mai", "Juin",
           "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"]


def parse_header(txt):
    """Numéro de facture, date, période et surcharge carburant depuis la 1re page."""
    num = ""
    m = re.search(r"FACTURE\s*N°\s*([0-9]{5,})", txt) or re.search(r"N°\s*([0-9]{7,})", txt)
    if m:
        num = m.group(1).strip()
    date_fac = ""
    md = re.search(r"\b(\d{2})/(\d{2})/(\d{4})\b", txt)
    if md:
        date_fac = f"{md.group(3)}-{md.group(2)}-{md.group(1)}"
    # Surcharge carburant : "MESSAGERIE 18.74% 2 068,69 387,67"
    carb = 0.0
    taux = 0.0
    mc = re.search(r"MESSAGERIE\s+([\d.,]+)\s*%\s+[\d ., ]+\s+([\d.,  ]+)\s*$",
                   txt, re.MULTILINE)
    if not mc:
        mc = re.search(r"GASOIL[^\n]*MESSAGERIE\s*[:]?\s*([\d.,]+)\s*%\s+[\d ., ]+\s+([\d.,  ]+)", txt)
    if mc:
        taux = to_float(mc.group(1).replace(".", ","))  # 18.74 -> 18,74
        carb = to_float(mc.group(2))
    return num, date_fac, round(carb, 2), round(taux, 2)


def extract_shipments(doc):
    """Renvoie la liste des expéditions BMV agrégées par n° de réception.
    Chaque expédition = ligne principale (Mt HT transport) + sous-lignes 'dont …'
    qui sont des DÉTAILS du Mt HT (déjà inclus, non additionnés)."""
    ships = {}
    order = []
    for pi in range(2, len(doc)):  # le détail commence page 3 (index 2)
        toks = [t for t in doc[pi].get_text().split("\n") if t.strip() != ""]
        j = 0
        while j < len(toks):
            if DATE.match(toks[j]) and j + 1 < len(toks) and toks[j + 1] == "MES":
                seg = [toks[j]]
                k = j + 1
                while k < len(toks):
                    if (DATE.match(toks[k]) and k + 1 < len(toks) and toks[k + 1] == "MES") \
                            or toks[k] in ("S/TOTAL", "TOTAL"):
                        break
                    seg.append(toks[k])
                    k += 1
                date = seg[0]
                recep = seg[2] if len(seg) > 2 else ""
                is_dont = any(x.startswith("dont") for x in seg)
                ref = ""
                idx = 3
                if idx < len(seg) and REFODOO.match(seg[idx]):
                    ref = seg[idx]
                    idx += 1
                nums = [to_float(x) for x in seg if NUM.match(x)]
                mt = nums[-1] if nums else 0.0  # Mt HT = dernier décimal de la ligne
                colis = 0
                # colis = avant-dernier entier "isolé" — on prend le plus gros entier court
                # (heuristique simple ; le poids/HT sont des décimaux)
                dest_parts = []
                for x in seg[idx:]:
                    if x.startswith("dont") or DPT.match(x) or x == "T" or NUM.match(x) or x.startswith("FR"):
                        break
                    dest_parts.append(x)
                dest = " ".join(dest_parts)
                dpt = next((x for x in seg if DPT.match(x)), "")
                ville = ""
                mv = [x for x in seg if x.startswith("FR -")]
                if mv:
                    ville = mv[0].replace("FR -", "").strip()

                if recep not in ships:
                    ships[recep] = {"date": date, "recep": recep, "ref": ref,
                                    "dest": dest, "dpt": dpt, "ville": ville,
                                    "transport": 0.0, "options": 0.0, "colis": 0}
                    order.append(recep)
                S = ships[recep]
                if ref and not S["ref"]:
                    S["ref"] = ref
                if dest and not S["dest"]:
                    S["dest"] = dest
                if dpt and not S["dpt"]:
                    S["dpt"] = dpt
                if ville and not S["ville"]:
                    S["ville"] = ville
                if is_dont:
                    S["options"] = round(S["options"] + mt, 2)
                else:
                    S["transport"] = round(S["transport"] + mt, 2)
                    S["colis"] += 1
                j = k
                continue
            j += 1
    return [ships[r] for r in order]


def extract_all(pdf_bytes):
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    txt_p1 = doc[0].get_text() if len(doc) else ""
    num, date_fac, carb, taux = parse_header(txt_p1)

    ships = extract_shipments(doc)
    tot_transport = round(sum(s["transport"] for s in ships), 2)
    total_general = round(tot_transport + carb, 2)

    # Coût réel par expédition = transport + quote-part de surcharge carburant
    # (répartie au prorata du transport) → réconcilie au total général HT.
    carb_dist = round((total_general - tot_transport), 2)
    if carb_dist < 0:
        carb_dist = carb
    for s in ships:
        share = carb_dist * (s["transport"] / tot_transport) if tot_transport else 0.0
        s["coutReel"] = round(s["transport"] + share, 2)
        s["date_iso"] = _iso_date(s["date"], date_fac)

    stats = {
        "num": num,
        "date_facture": date_fac,
        "nb_expeditions": len(ships),
        "total_transport": tot_transport,
        "surcharge_carburant": carb,
        "surcharge_taux": taux,
        "total_general_ht": total_general,
        "avec_ref": sum(1 for s in ships if s["ref"]),
        "sans_ref": sum(1 for s in ships if not s["ref"]),
    }
    return {"factures": [stats], "expeditions": ships, "stats": stats}


def _iso_date(jjmm, date_fac):
    """'04/05' + date facture (pour l'année) → 'YYYY-MM-DD'."""
    if not DATE.match(jjmm or ""):
        return ""
    dd, mm = jjmm.split("/")
    year = date_fac[:4] if date_fac else "2026"
    return f"{year}-{mm}-{dd}"


class handler(BaseHTTPRequestHandler):
    def _check_token(self) -> bool:
        expected = os.environ.get("WMS_INTERNAL_TOKEN", "")
        received = self.headers.get("X-WMS-Token", "")
        if not expected:
            return True
        return hmac.compare_digest(expected, received)

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
            self._send(500, {"error": "Erreur traitement PDF BMV"})
