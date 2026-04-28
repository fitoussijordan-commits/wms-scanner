// app/api/shopware-explore/route.ts — Exploration API Shopware 5 + Pickware
import { NextRequest, NextResponse } from "next/server";

const SW_URL = process.env.SHOPWARE_URL || "https://fr.hau.vonaffenfels.de";
const SW_USER = process.env.SHOPWARE_USER || "jordan";
const SW_KEY = process.env.SHOPWARE_API_KEY || "";

function getAuth() {
  return "Basic " + Buffer.from(`${SW_USER}:${SW_KEY}`).toString("base64");
}

async function swFetch(path: string) {
  const url = `${SW_URL}/api/v1${path}`;
  // Try Basic auth first, then Digest via query params
  const res = await fetch(url, {
    headers: {
      "Authorization": getAuth(),
      "Accept": "application/json",
    },
  });
  if (res.status === 401) {
    // Fallback: API key as query param (some SW5 setups)
    const url2 = `${SW_URL}/api/v1${path}${path.includes("?") ? "&" : "?"}username=${SW_USER}&api_key=${SW_KEY}`;
    return fetch(url2, { headers: { "Accept": "application/json" } });
  }
  return res;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action") || "ping";

  try {
    // ── ping: test auth + get one order ──
    if (action === "ping") {
      const res = await swFetch("/orders?limit=1");
      const text = await res.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch {}
      return NextResponse.json({ status: res.status, ok: res.ok, sample: json });
    }

    // ── orders: list recent orders with shipping info ──
    if (action === "orders") {
      const res = await swFetch("/orders?limit=10&sort[0][property]=orderTime&sort[0][direction]=DESC");
      const data = await res.json();
      const orders = (data.data || []).map((o: any) => ({
        id: o.id,
        number: o.number,
        status: o.orderStatusId,
        dispatch: o.dispatch?.name,
        dispatchId: o.dispatchId,
        shipping: o.shipping,
        customer: o.customer?.email,
        orderTime: o.orderTime,
      }));
      return NextResponse.json({ total: data.total, orders });
    }

    // ── dispatches: list all shipping methods ──
    if (action === "dispatches") {
      const res = await swFetch("/dispatches?limit=50");
      const data = await res.json();
      return NextResponse.json({ dispatches: data.data });
    }

    // ── order detail: full order with all fields ──
    if (action === "order") {
      const id = searchParams.get("id");
      if (!id) return NextResponse.json({ error: "id requis" }, { status: 400 });
      const res = await swFetch(`/orders/${id}`);
      const data = await res.json();
      return NextResponse.json({ order: data.data, keys: Object.keys(data.data || {}) });
    }

    // ── pickware: explore Pickware-specific endpoints ──
    if (action === "pickware") {
      const results: any = {};
      const paths = [
        "/pickware-shipping/shipments",
        "/PickwareShipping/shipments",
        "/pickware/shipments",
        "/shipments",
        "/pickware-erp/stock-movements",
        "/pickware-erp/warehouses",
      ];
      for (const p of paths) {
        try {
          const res = await fetch(`${SW_URL}/api/v1${p}?limit=1&username=${SW_USER}&api_key=${SW_KEY}`, {
            headers: { "Accept": "application/json" },
          });
          results[p] = { status: res.status };
          if (res.ok) {
            const t = await res.text();
            try { results[p].sample = JSON.parse(t); } catch { results[p].raw = t.substring(0, 200); }
          }
        } catch (e: any) {
          results[p] = { error: e.message };
        }
      }
      return NextResponse.json(results);
    }

    return NextResponse.json({ error: "actions: ping, orders, dispatches, order, pickware" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
