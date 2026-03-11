// app/api/sendcloud/route.ts — Server-side proxy for SendCloud API
import { NextRequest, NextResponse } from "next/server";

const V3 = "https://panel.sendcloud.sc/api/v3";
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
    throw new Error(`SendCloud ${res.status}: ${text.substring(0, 300)}`);
  }
  return res;
}

export async function GET(req: NextRequest) {
  const auth = getAuth();
  if (!auth) return NextResponse.json({ error: "SENDCLOUD_PUBLIC_KEY / SENDCLOUD_SECRET_KEY non configurées" }, { status: 500 });

  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");

  try {
    // List parcels — try v3 first, fallback v2
    if (action === "parcels") {
      let parcels: any[] = [];

      try {
        // v3: /parcels returns { results: [...], next: ... }
        const res = await scFetch(`${V3}/parcels?limit=500`, auth);
        const data = await res.json();
        parcels = data.results || data.parcels || [];
      } catch {
        // Fallback v2
        const res = await scFetch(`${V2}/parcels?limit=500`, auth);
        const data = await res.json();
        parcels = data.parcels || data.results || [];
      }

      return NextResponse.json({ parcels });
    }

    // Get label PDF for a parcel
    if (action === "label") {
      const id = searchParams.get("id");
      if (!id) return NextResponse.json({ error: "id requis" }, { status: 400 });

      // Get parcel info (try v2 for label — v2 has label URLs directly)
      let parcel: any = null;
      try {
        const res = await scFetch(`${V2}/parcels/${id}`, auth);
        const data = await res.json();
        parcel = data.parcel || data;
      } catch {
        const res = await scFetch(`${V3}/parcels/${id}`, auth);
        parcel = await res.json();
      }

      // Find label URL
      const labelUrl = parcel?.label?.label_printer || parcel?.label?.normal_printer?.[0];
      if (!labelUrl) return NextResponse.json({ error: "Pas d'étiquette disponible pour ce parcel" }, { status: 404 });

      // Download label PDF
      const labelRes = await scFetch(labelUrl, auth);
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

      let parcels: any[] = [];
      try {
        const res = await scFetch(`${V2}/parcels?order_number=${encodeURIComponent(q)}`, auth);
        const data = await res.json();
        parcels = data.parcels || [];
      } catch {
        const res = await scFetch(`${V3}/parcels?order_number=${encodeURIComponent(q)}`, auth);
        const data = await res.json();
        parcels = data.results || [];
      }

      return NextResponse.json({ parcels });
    }

    // Debug — raw response from both v2 and v3
    if (action === "debug") {
      const results: any = {};

      try {
        const res2 = await scFetch(`${V2}/parcels?limit=3`, auth);
        const data2 = await res2.json();
        results.v2 = { keys: Object.keys(data2), count: (data2.parcels || []).length, sample: (data2.parcels || []).slice(0, 1) };
      } catch (e: any) { results.v2 = { error: e.message }; }

      try {
        const res3 = await scFetch(`${V3}/parcels?limit=3`, auth);
        const data3 = await res3.json();
        results.v3 = { keys: Object.keys(data3), count: (data3.results || data3.parcels || []).length, sample: (data3.results || data3.parcels || []).slice(0, 1) };
      } catch (e: any) { results.v3 = { error: e.message }; }

      return NextResponse.json(results);
    }

    return NextResponse.json({ error: "Actions: parcels, label, search, debug" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return NextResponse.json({ error: "POST non supporté" }, { status: 405 });
}
