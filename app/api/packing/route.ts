// app/api/packing/route.ts — Server-side packing list text parser
// PDF text extraction is done client-side with pdfjs-dist
// This route receives the extracted text and parses the WALA packing list format

import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { text } = body;

    if (!text || text.length < 50) {
      return NextResponse.json({ error: "Texte trop court ou vide" }, { status: 400 });
    }

    const parsed = parsePackingList(text);

    return NextResponse.json({
      success: true,
      transportNr: parsed.transportNr,
      date: parsed.date,
      totalPallets: parsed.pallets.length,
      totalCartons: parsed.pallets.reduce((s: number, p: Pallet) => s + p.cartons.length, 0),
      pallets: parsed.pallets,
      _debug_textPreview: undefined,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// ── Interfaces ────────────────────────────────────────────────────────────────

interface CartonArticle {
  qtyProduct: number;
  productDesc: string;
  supplierRef: string;
  lot: string;
  expiry: string;
}

interface Carton {
  tracking: string;
  isVrac: boolean;
  articles: CartonArticle[];
  // Backward compat : champs du premier article
  qtyProduct: number;
  productDesc: string;
  supplierRef: string;
  lot: string;
  expiry: string;
  dimensions: string;
  netKg: string;
  grossKg: string;
}

interface Pallet {
  palletNo: string;
  boxCount: number;
  dimensions: string;
  cartons: Carton[];
}

interface PackingListData {
  transportNr: string;
  date: string;
  pallets: Pallet[];
}

// ── Parser ────────────────────────────────────────────────────────────────────

function parsePackingList(text: string): PackingListData {
  const lines = text.split("\n").map((l: string) => l.trim());

  let transportNr = "";
  const tnMatch = text.match(/TRANSPORT\s+NR\.?\s*[\n\r]*\s*(\S+)/i);
  if (tnMatch) transportNr = tnMatch[1];

  let date = "";
  const dateMatch = text.match(/(\d{2}\.\d{2}\.\d{4})/);
  if (dateMatch) date = dateMatch[1];

  const palletRe  = /(\d{10})\s+(\d{7,})\s+(\d+)\s*x\s*Euro\s*Pallet/i;
  const boxCountRe = /contains\s+(\d+)\s+box/i;
  const cartonRe  = /(\d{10})\s+(\d{7,})\s+(\d+)\s*x\s*CARTON/i;
  const artRe     = /Art[\.\s]*:?\s*(\d{6,})\s+LOT[\-\s]*No[\.\s]*:?\s*([A-Z0-9]+)\s+Expiry\s*Date\s*:?\s*(\d{2}[\.\/-]\d{4})/i;
  const qtyDescRe = /^(\d+)\s+(.{3,})$/;
  const dimRe     = /\(([^)]*cm)\)/;
  const kgRe      = /([\d,.]+)\s+([\d,.]+)\s*$/;

  const pallets: Pallet[] = [];
  let currentPallet: Pallet | null = null;
  let currentCarton: Carton | null = null;
  let currentArticle: CartonArticle | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    // ── Palette ──────────────────────────────────────────────────────────────
    let m = palletRe.exec(line);
    if (m) {
      currentPallet  = { palletNo: m[2], boxCount: 0, dimensions: "", cartons: [] };
      const dimMatch = dimRe.exec(line);
      if (dimMatch) currentPallet.dimensions = dimMatch[1];
      pallets.push(currentPallet);
      currentCarton  = null;
      currentArticle = null;
      continue;
    }

    const bcm = boxCountRe.exec(line);
    if (bcm && currentPallet) {
      currentPallet.boxCount = parseInt(bcm[1]);
      continue;
    }

    // ── Carton ───────────────────────────────────────────────────────────────
    m = cartonRe.exec(line);
    if (m) {
      const kgMatch  = kgRe.exec(line);
      const dimMatch = dimRe.exec(line);
      currentCarton = {
        tracking: m[2], isVrac: false, articles: [],
        qtyProduct: 0, productDesc: "", supplierRef: "", lot: "", expiry: "",
        dimensions: dimMatch ? dimMatch[1] : "",
        netKg: kgMatch ? kgMatch[1] : "", grossKg: kgMatch ? kgMatch[2] : "",
      };
      currentArticle = null;
      if (currentPallet) currentPallet.cartons.push(currentCarton);
      continue;
    }

    if (!currentCarton) continue;

    // ── Art. / LOT / Expiry ───────────────────────────────────────────────────
    // Peut être sur la même ligne que qty+desc (format vrac compressé) ou sur la suivante
    const am = artRe.exec(line);
    if (am) {
      const artIdx   = am.index;
      const beforeArt = line.substring(0, artIdx).trim();
      const qmBefore  = qtyDescRe.exec(beforeArt);

      if (qmBefore) {
        // qty + desc + art sur la même ligne → article complet d'un seul coup
        currentArticle = {
          qtyProduct: parseInt(qmBefore[1]),
          productDesc: qmBefore[2].trim(),
          supplierRef: am[1], lot: am[2], expiry: am[3],
        };
        currentCarton.articles.push(currentArticle);
      } else if (currentArticle) {
        // Art. sur la ligne suivant le qty/desc
        currentArticle.supplierRef = am[1];
        currentArticle.lot         = am[2];
        currentArticle.expiry      = am[3];
      } else {
        // Art. sans qty/desc précédent (cas rare)
        currentArticle = { qtyProduct: 0, productDesc: "", supplierRef: am[1], lot: am[2], expiry: am[3] };
        currentCarton.articles.push(currentArticle);
      }
      continue;
    }

    // ── Qty + description (sans Art. sur la même ligne) ───────────────────────
    const qm = qtyDescRe.exec(line);
    if (qm) {
      currentArticle = { qtyProduct: parseInt(qm[1]), productDesc: qm[2].trim(), supplierRef: "", lot: "", expiry: "" };
      currentCarton.articles.push(currentArticle);
      continue;
    }
  }

  // ── Post-traitement : finaliser chaque carton ─────────────────────────────
  for (const pallet of pallets) {
    for (const carton of pallet.cartons) {
      carton.isVrac = carton.articles.length > 1;
      if (carton.articles.length > 0) {
        // Compat : expose les champs du premier article au niveau carton
        const a0           = carton.articles[0];
        carton.qtyProduct  = a0.qtyProduct;
        carton.productDesc = a0.productDesc;
        carton.supplierRef = a0.supplierRef;
        carton.lot         = a0.lot;
        carton.expiry      = a0.expiry;
      }
    }
  }

  return { transportNr, date, pallets };
}
