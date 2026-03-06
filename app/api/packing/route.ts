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
      _debug_textPreview: text.substring(0, 1500),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

interface Carton {
  tracking: string;
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

function parsePackingList(text: string): PackingListData {
  const lines = text.split("\n").map((l: string) => l.trim());

  let transportNr = "";
  const tnMatch = text.match(/TRANSPORT\s+NR\.?\s*[\n\r]*\s*(\S+)/i);
  if (tnMatch) transportNr = tnMatch[1];

  let date = "";
  const dateMatch = text.match(/(\d{2}\.\d{2}\.\d{4})/);
  if (dateMatch) date = dateMatch[1];

  const palletRe = /(\d{10})\s+(\d{7,})\s+(\d+)\s*x\s*Euro\s*Pallet/i;
  const boxCountRe = /contains\s+(\d+)\s+box/i;
  const cartonRe = /(\d{10})\s+(\d{7,})\s+(\d+)\s*x\s*CARTON/i;
  const artRe = /Art[\.\s]*:?\s*(\d{6,})\s+LOT[\-\s]*No[\.\s]*:?\s*([A-Z0-9]+)\s+Expiry\s*Date\s*:?\s*(\d{2}[\.\/-]\d{4})/i;
  const qtyDescRe = /^(\d+)\s+(.{3,})$/;
  const dimRe = /\(([^)]*cm)\)/;
  const kgRe = /([\d,.]+)\s+([\d,.]+)\s*$/;

  const pallets: Pallet[] = [];
  let currentPallet: Pallet | null = null;
  let currentCarton: Carton | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    let m = palletRe.exec(line);
    if (m) {
      currentPallet = { palletNo: m[2], boxCount: 0, dimensions: "", cartons: [] };
      const dimMatch = dimRe.exec(line);
      if (dimMatch) currentPallet.dimensions = dimMatch[1];
      pallets.push(currentPallet);
      currentCarton = null;
      continue;
    }

    const bcm = boxCountRe.exec(line);
    if (bcm && currentPallet) {
      currentPallet.boxCount = parseInt(bcm[1]);
      continue;
    }

    m = cartonRe.exec(line);
    if (m) {
      const kgMatch = kgRe.exec(line);
      const dimMatch = dimRe.exec(line);
      currentCarton = {
        tracking: m[2], qtyProduct: 0, productDesc: "", supplierRef: "", lot: "", expiry: "",
        dimensions: dimMatch ? dimMatch[1] : "", netKg: kgMatch ? kgMatch[1] : "", grossKg: kgMatch ? kgMatch[2] : "",
      };
      if (currentPallet) currentPallet.cartons.push(currentCarton);
      continue;
    }

    const am = artRe.exec(line);
    if (am && currentCarton) {
      currentCarton.supplierRef = am[1];
      currentCarton.lot = am[2];
      currentCarton.expiry = am[3];
      continue;
    }

    const qm = qtyDescRe.exec(line);
    if (qm && currentCarton && !currentCarton.productDesc) {
      currentCarton.qtyProduct = parseInt(qm[1]);
      currentCarton.productDesc = qm[2].trim();
      continue;
    }
  }

  return { transportNr, date, pallets };
}
