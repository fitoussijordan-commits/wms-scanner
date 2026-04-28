// app/api/shopware-explore/route.ts — Exploration API Shopware 5 + Pickware + EshaTNT
import { NextRequest, NextResponse } from "next/server";

function getCreds(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  return {
    url: searchParams.get("sw_url") || process.env.SHOPWARE_URL || "https://fr.hau.vonaffenfels.de",
    user: searchParams.get("sw_user") || process.env.SHOPWARE_USER || "jordan",
    key: searchParams.get("sw_key") || process.env.SHOPWARE_API_KEY || "",
  };
}

async function swFetch(path: string, creds: { url: string; user: string; key: string }, method = "GET", body?: any) {
  const base64 = Buffer.from(`${creds.user}:${creds.key}`).toString("base64");
  const url = `${creds.url}/api/v1${path}`;
  return fetch(url, {
    method,
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Authorization": `Basic ${base64}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function safeJson(res: Response): Promise<{ ok: boolean; status: number; json?: any; raw?: string }> {
  const text = await res.text().catch(() => "");
  try {
    return { ok: res.ok, status: res.status, json: JSON.parse(text) };
  } catch {
    return { ok: res.ok, status: res.status, raw: text.substring(0, 500) };
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action") || "ping";
  const creds = getCreds(req);

  try {
    // ── ping: test auth ──
    if (action === "ping") {
      const res = await swFetch("/orders?limit=1", creds);
      const r = await safeJson(res);
      return NextResponse.json({ status: r.status, ok: r.ok, url: creds.url, user: creds.user, sample: r.json, raw: r.raw });
    }

    // ── orders: récentes commandes avec méthode d'expédition ──
    if (action === "orders") {
      const res = await swFetch("/orders?limit=20&sort[0][property]=orderTime&sort[0][direction]=DESC", creds);
      const r = await safeJson(res);
      if (!r.json) return NextResponse.json({ error: "Non-JSON response", raw: r.raw });
      const orders = (r.json.data || []).map((o: any) => ({
        id: o.id,
        number: o.number,
        orderStatus: o.orderStatusId,
        dispatchId: o.dispatchId,
        dispatchMethod: o.dispatchMethod || o.dispatch?.name,
        shippingProvider: o.shippingProduct?.provider,
        customer: o.customer?.email,
        orderTime: o.orderTime,
        trackingCode: o.trackingCode,
        pickwareShipmentGuid: o.attribute?.pickwareWmsShipmentGuid,
      }));
      return NextResponse.json({ total: r.json.total, orders });
    }

    // ── dispatches: méthodes de livraison ──
    if (action === "dispatches") {
      const res = await swFetch("/dispatches?limit=50", creds);
      const r = await safeJson(res);
      if (!r.json) return NextResponse.json({ error: "Non-JSON response", status: r.status, raw: r.raw });
      return NextResponse.json({ dispatches: (r.json.data || []).map((d: any) => ({ id: d.id, name: d.name, type: d.type })) });
    }

    // ── order: détail d'une commande par ID ──
    if (action === "order") {
      const id = searchParams.get("id");
      if (!id) return NextResponse.json({ error: "id requis" }, { status: 400 });
      const res = await swFetch(`/orders/${id}`, creds);
      const r = await safeJson(res);
      return NextResponse.json({
        status: r.status,
        order: r.json?.data,
        keys: r.json?.data ? Object.keys(r.json.data) : null,
        raw: r.raw,
      });
    }

    // ── findOrder: chercher commande par numéro + récupérer label ──
    if (action === "findOrder") {
      const number = searchParams.get("number");
      if (!number) return NextResponse.json({ error: "number requis" }, { status: 400 });
      // Filtre Shopware 5 par numéro de commande
      const searchRes = await swFetch(
        `/orders?filter[0][property]=number&filter[0][value]=${encodeURIComponent(number)}&limit=1`,
        creds
      );
      const searchR = await safeJson(searchRes);
      if (!searchR.json?.data?.length) {
        return NextResponse.json({ error: "Commande non trouvée", status: searchR.status, raw: searchR.raw, json: searchR.json });
      }
      const orderId = searchR.json.data[0].id;

      // Récupérer détail complet
      const detailRes = await swFetch(`/orders/${orderId}`, creds);
      const detailR = await safeJson(detailRes);
      const order = detailR.json?.data;

      // Essai récupération label via Pickware shipment GUID
      const guid = order?.attribute?.pickwareWmsShipmentGuid;
      let labelInfo: any = null;
      if (guid) {
        // Tenter d'accéder au label via endpoint Pickware
        const labelRes = await swFetch(`/warehouses?filter[0][property]=shipmentGuid&filter[0][value]=${guid}`, creds);
        const labelR = await safeJson(labelRes);
        labelInfo = { guid, attempt: { status: labelR.status, json: labelR.json, raw: labelR.raw?.substring(0, 300) } };
      }

      return NextResponse.json({
        orderId,
        number: order?.number,
        orderStatus: order?.orderStatusId,
        dispatchMethod: order?.dispatchMethod,
        shippingProvider: order?.shippingProduct?.provider,
        trackingCode: order?.trackingCode,
        pickwareShipmentGuid: guid,
        shippingDocuments: order?.shippingDocuments,
        documents: order?.documents,
        labelInfo,
        // URLs potentielles pour les documents
        documentUrls: (order?.documents || []).map((d: any) => ({
          id: d.id,
          typeId: d.typeId,
          hash: d.hash,
          url: d.hash ? `${creds.url}/backend/pdf?file=${d.hash}` : null,
        })),
      });
    }

    // ── pickware: explore les endpoints Pickware WMS / ERP ──
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
        "/warehouses",
        "/stockMovements",
      ];
      for (const p of paths) {
        try {
          const res = await swFetch(`${p}?limit=1`, creds);
          const r = await safeJson(res);
          results[p] = { status: r.status, ok: r.ok };
          if (r.json) results[p].sample = r.json;
          else results[p].raw = r.raw?.substring(0, 200);
        } catch (e: any) {
          results[p] = { error: e.message };
        }
      }
      return NextResponse.json(results);
    }

    // ── eshatnt: explore endpoints spécifiques EshaTNT ──
    if (action === "eshatnt") {
      const results: any = {};
      const paths = [
        "/EshaTNT/shipments",
        "/EshaTNT/labels",
        "/EshaTNT/orders",
        "/eshatnt/shipments",
        "/eshatnt/labels",
        "/eshaTNT/shipments",
        // Shopware backend plugin routes (via REST)
        "/labels",
        "/trackingCodes",
      ];
      for (const p of paths) {
        try {
          const res = await swFetch(`${p}?limit=1`, creds);
          const r = await safeJson(res);
          results[p] = { status: r.status, ok: r.ok };
          if (r.json) results[p].sample = r.json;
          else results[p].raw = r.raw?.substring(0, 200);
        } catch (e: any) {
          results[p] = { error: e.message };
        }
      }
      return NextResponse.json(results);
    }

    // ── generate: tenter de générer une étiquette TNT pour une commande ──
    if (action === "generate") {
      const orderId = searchParams.get("id");
      if (!orderId) return NextResponse.json({ error: "id requis" }, { status: 400 });

      // D'abord récupérer la commande
      const orderRes = await swFetch(`/orders/${orderId}`, creds);
      const orderR = await safeJson(orderRes);
      if (!orderR.json?.data) return NextResponse.json({ error: "Commande introuvable", raw: orderR.raw });
      const order = orderR.json.data;

      // Tentative 1: PUT sur l'ordre pour déclencher génération (Pickware)
      const putRes = await swFetch(`/orders/${orderId}`, creds, "PUT", {
        "shippingDocuments": [{ "type": "label" }]
      });
      const putR = await safeJson(putRes);

      return NextResponse.json({
        order: {
          id: order.id,
          number: order.number,
          dispatchMethod: order.dispatchMethod,
          shippingProvider: order.shippingProduct?.provider,
          shippingDocuments: order.shippingDocuments,
          pickwareShipmentGuid: order.attribute?.pickwareWmsShipmentGuid,
        },
        putAttempt: { status: putR.status, json: putR.json, raw: putR.raw },
      });
    }

    return NextResponse.json({ error: "actions: ping, orders, dispatches, order, pickware, eshatnt, generate" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
