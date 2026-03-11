// app/api/sendcloud/route.ts — Server-side proxy for SendCloud API
import { NextRequest, NextResponse } from "next/server";

const V2 = "https://panel.sendcloud.sc/api/v2";

function getAuth(): string {
  const pub = process.env.SENDCLOUD_PUBLIC_KEY || "";
  const sec = process.env.SENDCLOUD_SECRET_KEY || "";
  if (!pub || !sec) return "";
  return "Basic " + Buffer.from(`${pub}:${sec}`).toString("base64");
}

async function scFetch(url: string, auth: string) {
  const res = await fetch(url, { headers: { "Authorization": auth } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`SendCloud ${res.status}: ${text.substring(0, 200)}`);
  }
  return res.json();
}

export async function GET(req: NextRequest) {
  const auth = getAuth();
  if (!auth) return NextResponse.json({ error: "SENDCLOUD_PUBLIC_KEY / SENDCLOUD_SECRET_KEY non configurées" }, { status: 500 });

  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");

  try {
    // List parcels
    if (action === "parcels") {
      const data = await scFetch(`${V2}/parcels?limit=500`, auth);
      return NextResponse.json({ parcels: data.parcels || data.results || [] });
    }

    // Get label PDF for a parcel
    if (action === "label") {
      const id = searchParams.get("id");
      if (!id) return NextResponse.json({ error: "id requis" }, { status: 400 });

      const data = await scFetch(`${V2}/parcels/${id}`, auth);
      const parcel = data.parcel || data;

      // Try label_printer first (ZPL-sized), then normal_printer
      const labelUrl = parcel?.label?.label_printer || parcel?.label?.normal_printer?.[0];
      if (!labelUrl) return NextResponse.json({ error: "Pas d'étiquette disponible" }, { status: 404 });

      const labelRes = await fetch(labelUrl, { headers: { "Authorization": auth } });
      if (!labelRes.ok) return NextResponse.json({ error: `Erreur étiquette: ${labelRes.status}` }, { status: labelRes.status });

      const pdfBuffer = Buffer.from(await labelRes.arrayBuffer());
      return NextResponse.json({
        parcelId: parcel.id,
        tracking: parcel.tracking_number || "",
        carrier: parcel.carrier?.code || "",
        labelBase64: pdfBuffer.toString("base64"),
      });
    }

    // Search by order number
    if (action === "search") {
      const q = searchParams.get("order_number") || "";
      if (!q) return NextResponse.json({ error: "order_number requis" }, { status: 400 });
      const data = await scFetch(`${V2}/parcels?order_number=${encodeURIComponent(q)}`, auth);
      return NextResponse.json({ parcels: data.parcels || [] });
    }

    // Debug — returns raw response so we can see structure
    if (action === "debug") {
      const parcelsData = await scFetch(`${V2}/parcels?limit=5`, auth);
      // Show first 2 parcels with all fields for debugging
      const sample = (parcelsData.parcels || parcelsData.results || []).slice(0, 2);
      return NextResponse.json({
        _keys: Object.keys(parcelsData),
        _sampleCount: sample.length,
        _sample: sample,
      });
    }

    return NextResponse.json({ error: "Action inconnue. Actions: parcels, label, search, debug" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return NextResponse.json({ error: "POST non supporté" }, { status: 405 });
}
