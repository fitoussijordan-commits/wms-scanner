// app/api/packing/route.ts — Server-side packing list PDF parser
// Parses WALA packing list PDFs and returns structured pallet/carton data

import { NextRequest, NextResponse } from "next/server";

// We use pdf-parse (works server-side in Node)
// Must install: npm install pdf-parse

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File;
    if (!file) return NextResponse.json({ error: "Aucun fichier envoyé" }, { status: 400 });

    const buffer = Buffer.from(await file.arrayBuffer());

    // Dynamic import pdf-parse
    const pdfParse = (await import("pdf-parse")).default;
    const data = await pdfParse(buffer);
    const text = data.text;

    const parsed = parsePackingList(text);

    return NextResponse.json({
      success: true,
      transportNr: parsed.transportNr,
      date: parsed.date,
      totalPallets: parsed.pallets.length,
      totalCartons: parsed.pallets.reduce((s, p) => s + p.cartons.length, 0),
      pallets: parsed.pallets,
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
  const lines = text.split("\n").map((l) => l.trim());

  // Extract transport number
  let transportNr = "";
  const tnMatch = text.match(/TRANSPORT\s+NR\.?\s*[\n\r]*\s*(\S+)/i);
  if (tnMatch) transportNr = tnMatch[1];

  // Extract date
  let date = "";
  const dateMatch = text.match(
    /(?:Bad Boll|Eckwälden)[,\s]+(\d{2}\.\d{2}\.\d{4})/
  );
  if (dateMatch) date = dateMatch[1];

  const palletRe =
    /^(\d{10})\s+(\d{7,})\s+(\d+)\s+x\s+Euro\s+Pallet/i;
  const boxCountRe = /contains\s+(\d+)\s+box/i;
  const cartonRe =
    /^(\d{10})\s+(\d{7,})\s+(\d+)\s+x\s+CARTON\(?S?\)?\s*\(([^)]+)\)/i;
  const artRe =
    /Art\.:(\d+)\s+LOT-No\.:([A-Z0-9]+)\s+Expiry\s+Date:(\d{2}\.\d{4})/i;
  const qtyDescRe = /^(\d+)\s{2,}(.+)$/;
  const kgRe = /([\d,.]+)\s+([\d,.]+)\s*$/;

  const pallets: Pallet[] = [];
  let currentPallet: Pallet | null = null;
  let currentCarton: Carton | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    // Palette line
    let m = palletRe.exec(line);
    if (m) {
      currentPallet = {
        palletNo: m[2],
        boxCount: 0,
        dimensions: "",
        cartons: [],
      };
      // Try to extract dimensions from same line
      const dimMatch = line.match(/\(([^)]+cm)\)/);
      if (dimMatch) currentPallet.dimensions = dimMatch[1];
      pallets.push(currentPallet);
      currentCarton = null;
      continue;
    }

    // Box count
    const bcm = boxCountRe.exec(line);
    if (bcm && currentPallet) {
      currentPallet.boxCount = parseInt(bcm[1]);
      continue;
    }

    // Carton line
    m = cartonRe.exec(line);
    if (m) {
      // Extract kg from end of line
      const kgMatch = kgRe.exec(line);
      currentCarton = {
        tracking: m[2],
        qtyProduct: 0,
        productDesc: "",
        supplierRef: "",
        lot: "",
        expiry: "",
        dimensions: m[4],
        netKg: kgMatch ? kgMatch[1] : "",
        grossKg: kgMatch ? kgMatch[2] : "",
      };
      if (currentPallet) {
        currentPallet.cartons.push(currentCarton);
      }
      continue;
    }

    // Article info line
    const am = artRe.exec(line);
    if (am && currentCarton) {
      currentCarton.supplierRef = am[1];
      currentCarton.lot = am[2];
      currentCarton.expiry = am[3];
      continue;
    }

    // Qty + description line (e.g. "4   Display bowl for tester island")
    const qm = qtyDescRe.exec(line);
    if (qm && currentCarton && !currentCarton.productDesc) {
      currentCarton.qtyProduct = parseInt(qm[1]);
      currentCarton.productDesc = qm[2].trim();
      continue;
    }
  }

  return { transportNr, date, pallets };
}
