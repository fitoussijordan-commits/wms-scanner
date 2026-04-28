// app/api/shopware-explore/route.ts — Exploration API Shopware 5 + Pickware
import { NextRequest, NextResponse } from "next/server";

// Credentials: from env or query params (for testing)
function getCreds(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  return {
    url: searchParams.get("sw_url") || process.env.SHOPWARE_URL || "https://fr.hau.vonaffenfels.de",
    user: searchParams.get("sw_user") || process.env.SHOPWARE_USER || "jordan",
    key: searchParams.get("sw_key") || process.env.SHOPWARE_API_KEY || "",
  };
}

async function swFetch(path: string, creds: { url: string; user: string; key: string }) {
  // Shopware 5: Basic auth (username:api_key)
  const base64 = Buffer.from(`${creds.user}:${creds.key}`).toString("base64");
  const url = `${creds.url}/api/v1${path}`;
  return fetch(url, {
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Authorization": `Basic ${base64}`,
    },
  });
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action") || "ping";
  const creds = getCreds(req);

  try {
    // ── ping: test auth + get one order ──
    if (action === "ping") {
      const res = await swFetch("/orders?limit=1", creds);
      const text = await res.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch {}
      return NextResponse.json({ status: res.status, ok: res.ok, url: creds.url, user: creds.user, sample: json });
    }

    // ── orders: list recent orders with shipping info ──
    if (action === "orders") {
      const res = await swFetch("/orders?limit=10&sort[0][property]=orderTime&sort[0][direction]=DESC", creds);
      const data = await res.json();
      const orders = (data.data || []).map((o: any) => ({
        id: o.id,
        number: o.number,
        status: o.orderStatusId,
        dispatch: o.dispatch?.name,
        dispatchId: o.dispatchId,
        customer: o.customer?.email,
        orderTime: o.orderTime,
      }));
      return NextResponse.json({ total: data.total, orders });
    }

    // ── dispatches: list all shipping methods ──
    if (action === "dispatches") {
      const res = await swFetch("/dispatches?limit=50", creds);
      const data = await res.json();
      return NextResponse.json({ dispatches: (data.data || []).map((d: any) => ({ id: d.id, name: d.name, type: d.type })) });
    }

    // ── order detail: full order with all fields ──
    if (action === "order") {
      const id = searchParams.get("id");
      if (!id) return NextResponse.json({ error: "id requis" }, { status: 400 });
      const res = await swFetch(`/orders/${id}`, creds);
      const data = await res.json();
      return NextResponse.json({ order: data.data, keys: Object.keys(data.data || {}) });
    }

    // ── pickware: explore Pickware-specific endpoints ──
    if (action === "pickware") {
      const results: any = {};
      const paths = [
        "/pickware-shipping/shipments",
        "/PickwareShipping/shipments",
        "/PickwareWMS/shipments",
        "/pickware/shipments",
        "/shipments",
        "/pickware-erp/warehouses",
        "/pickware-erp/stockMovements",
        "/PickwareERP/warehouses",
      ];
      for (const p of paths) {
        try {
          const res = await swFetch(`${p}?limit=1`, creds);
          results[p] = { status: res.status };
          if (res.ok) {
            const t = await res.text();
            try { results[p].sample = JSON.parse(t); } catch { results[p].raw = t.substring(0, 300); }
          } else {
            const t = await res.text().catch(() => "");
            results[p].body = t.substring(0, 200);
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
