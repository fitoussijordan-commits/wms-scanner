// app/api/sendcloud/route.ts — Server-side proxy for SendCloud API
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

const V2 = "https://panel.sendcloud.sc/api/v2";
const V3 = "https://panel.sendcloud.sc/api/v3";
const INTEGRATION_ID = 527093; // Dr. Hauschka Shop FR-FR

function getAuth(): string {
  const pub = process.env.SENDCLOUD_PUBLIC_KEY || "";
  const sec = process.env.SENDCLOUD_SECRET_KEY || "";
  if (!pub || !sec) return "";
  return "Basic " + Buffer.from(`${pub}:${sec}`).toString("base64");
}

async function scFetch(url: string, auth: string, options?: RequestInit): Promise<Response> {
  return fetch(url, { ...options, headers: { "Authorization": auth, "Content-Type": "application/json", ...(options?.headers || {}) } });
}

async function scJson(url: string, auth: string, options?: RequestInit) {
  const res = await scFetch(url, auth, options);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`SendCloud ${res.status}: ${text.substring(0, 300)}`);
  }
  return res.json();
}

// ─── Helpers négatifs / V2 direct ─────────────────────────────────────────────

function hasNegativeItems(raw: any): boolean {
  if (!raw) return false;
  const items: any[] = raw.order_details?.order_items || raw.order_items || [];
  return items.some((i: any) => {
    const v = parseFloat(String(i.unit_price?.value ?? i.product_value ?? i.price ?? i.value ?? "0"));
    return v < 0;
  });
}

const hasLabel = (p: any) => !!(p?.label?.label_printer || p?.label?.normal_printer?.[0]);

/**
 * Poll V2 /parcels/{id} jusqu'à ce que l'étiquette soit prête.
 */
async function pollLabel(auth: string, parcelId: number, attempts = 15, delayMs = 2500): Promise<any | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      const d = await scJson(`${V2}/parcels/${parcelId}`, auth);
      const c = d.parcel || d;
      if (hasLabel(c)) return c;
    } catch {}
    await new Promise(r => setTimeout(r, delayMs));
  }
  return null;
}

/**
 * Crée un colis directement via V2 /parcels avec `request_label: true`.
 *
 * Pourquoi : V3 `create-labels-async` rejette en 422 toute commande contenant
 * une ligne à prix négatif (remise/avoir). V2 est plus permissif — on lui passe
 * les parcel_items à prix positifs uniquement, et on absorbe les remises dans
 * `total_order_value` (= net total). C'est ce que les transporteurs/douane
 * attendent de toute façon.
 */
async function createParcelV2Direct(
  auth: string,
  orderId: string,
  orderNumber: string,
  raw: any,
  clientShipmentId?: number | null
): Promise<any> {
  // Si raw absent ou incomplet, refetch V3
  let order = raw;
  if (!order || (!order.order_details && !order.order_items)) {
    const d = await scJson(`${V3}/orders/${orderId}`, auth);
    order = d.data || d;
  }
  const details = order.order_details || {};
  const rawItems: any[] = details.order_items || order.order_items || [];
  const addr = order.shipping_address || details.shipping_address || order.address || {};

  // Net total (somme algébrique avec négatifs) — borné à 0 min pour la douane
  const netTotal = rawItems.reduce((sum: number, i: any) => {
    const v = parseFloat(String(i.unit_price?.value ?? i.product_value ?? i.price ?? i.value ?? "0"));
    const q = Math.max(1, parseInt(String(i.quantity || 1)));
    return sum + v * q;
  }, 0);

  // On ne garde que les lignes à prix >= 0 (les remises sont absorbées dans le total)
  const parcelItems = rawItems
    .filter((item: any) => {
      if (!item) return false;
      const v = parseFloat(String(item.unit_price?.value ?? item.product_value ?? item.price ?? item.value ?? "0"));
      if (v < 0) return false;
      return !!(item.description || item.name || item.title || item.sku);
    })
    .map((item: any) => {
      const rawVal = item.unit_price?.value ?? item.product_value ?? item.price ?? item.value ?? "0";
      return {
        description: String(item.description || item.name || item.title || item.sku || "Article").substring(0, 100),
        quantity: Math.max(1, parseInt(String(item.quantity || 1))),
        weight: String(Math.max(0.001, parseFloat(String(item.weight || "0.1"))).toFixed(3)),
        value: String(Math.max(0, parseFloat(String(rawVal))).toFixed(2)),
        hs_code: item.harmonized_system_code || item.hs_code || "",
        origin_country: item.origin_country || "DE",
        sku: item.sku || "",
      };
    });

  // Shipment ID : client → V3 → emprunt à un colis récent
  let shipmentId: number | null =
    clientShipmentId ||
    details.shipping_method_id ||
    order.shipping_details?.shipping_method_id ||
    order.sendcloud_shipping_method_id ||
    order.shipment?.id ||
    order.shipping_method?.id ||
    null;

  if (!shipmentId) {
    try {
      const recent = await scJson(`${V2}/parcels?integration_id=${INTEGRATION_ID}&limit=10`, auth);
      const rp = (recent.parcels || []).find((p: any) => p.shipment?.id);
      if (rp?.shipment?.id) shipmentId = rp.shipment.id;
    } catch {}
  }

  const name =
    [addr.first_name, addr.last_name].filter(Boolean).join(" ") ||
    addr.company_name || addr.name || "Client";
  const street =
    [addr.street, addr.house_number].filter(Boolean).join(" ") ||
    addr.address_line_1 || addr.address_1 || addr.address || "";

  // Poids total (somme items × qty, plancher 0.501 kg = minimum SendCloud)
  const totalWeight = Math.max(
    0.501,
    rawItems.reduce((s: number, i: any) => {
      const w = parseFloat(String(i.weight || "0"));
      const q = Math.max(1, parseInt(String(i.quantity || 1)));
      return s + (isFinite(w) ? w : 0) * q;
    }, 0)
  ).toFixed(3);

  // Service point (Mondial Relay / autres méthodes en point relais)
  // SendCloud V3 expose l'ID sur différents chemins selon l'intégration
  const servicePointId: number | null =
    parseInt(String(
      details.to_service_point ??
      details.service_point_id ??
      details.service_point?.id ??
      order.to_service_point ??
      order.service_point_id ??
      order.service_point?.id ??
      order.shipping_details?.to_service_point ??
      order.shipping_details?.service_point_id ??
      order.shipping_details?.service_point?.id ??
      ""
    )) || null;

  if (servicePointId) console.log("[V2 direct]", orderNumber, "→ service point:", servicePointId);

  const v2Payload: any = {
    parcel: {
      name,
      company_name: addr.company_name || "",
      address: street,
      address_2: addr.address_2 || addr.address_divided?.house_number_addition || "",
      city: addr.city || "",
      postal_code: addr.postal_code || "",
      country: addr.country || addr.country_code || addr.country_iso_2 || "FR",
      email: order.email || addr.email || "",
      telephone: order.telephone || addr.phone || addr.telephone || "",
      weight: totalWeight,
      order_number: orderNumber,
      external_order_id: String(orderId),
      total_order_value: Math.max(0, netTotal).toFixed(2),
      total_order_value_currency: order.currency || "EUR",
      request_label: true,
      ...(parcelItems.length > 0 && { parcel_items: parcelItems }),
      ...(shipmentId ? { shipment: { id: shipmentId } } : {}),
      ...(servicePointId ? { to_service_point: servicePointId } : {}),
    },
  };

  console.log("[V2 direct]", orderNumber, "| net:", netTotal.toFixed(2), "| items+:", parcelItems.length, "| shipment:", shipmentId, "| weight:", totalWeight, "| service_point:", servicePointId);

  const result = await scJson(`${V2}/parcels`, auth, {
    method: "POST",
    body: JSON.stringify(v2Payload),
  });
  return result.parcel || null;
}

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const auth = getAuth();
  if (!auth) return NextResponse.json({ error: "SENDCLOUD_PUBLIC_KEY / SENDCLOUD_SECRET_KEY non configurées" }, { status: 500 });

  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");

  try {
    // List parcels with optional status filter
    if (action === "parcels") {
      const statusFilter = searchParams.get("status") || "";
      const data = await scJson(`${V2}/parcels?limit=500&integration_id=${INTEGRATION_ID}`, auth);
      let parcels = data.parcels || [];
      if (statusFilter) {
        const ids = statusFilter.split(",").map((s: string) => parseInt(s.trim()));
        parcels = parcels.filter((p: any) => ids.includes(p.status?.id));
      }
      return NextResponse.json({ parcels });
    }

    // V3 orders — open orders not yet converted to parcels
    if (action === "orders") {
      const data = await scJson(`${V3}/orders?integration_id=${INTEGRATION_ID}&page_size=100`, auth);
      let orders = data.data || data.results || data.orders || [];
      const sample = orders[0] || {};
      if (!sample.order_items && !sample.order_details?.order_items) {
        orders = await Promise.all(
          orders.map((o: any) =>
            scJson(`${V3}/orders/${o.order_id}`, auth)
              .then((d: any) => d.data || d)
              .catch(() => o)
          )
        );
      }
      return NextResponse.json({ orders });
    }

    // V3 order detail
    if (action === "order") {
      const id = searchParams.get("id");
      if (!id) return NextResponse.json({ error: "id requis" }, { status: 400 });
      const data = await scJson(`${V3}/orders/${id}`, auth);
      return NextResponse.json({ order: data.data || data });
    }

    // Debug V3 orders structure
    if (action === "probe") {
      const data = await scJson(`${V3}/orders?integration_id=${INTEGRATION_ID}&page_size=3`, auth);
      return NextResponse.json({
        keys: Object.keys(data),
        count: data.count ?? data.total ?? "?",
        sample: (data.data || data.results || data.orders || []).slice(0, 2),
        first_order_keys: Object.keys((data.data || data.results || data.orders || [])[0] || {}),
        order_details_keys: Object.keys((data.data || data.results || data.orders || [])[0]?.order_details || {}),
        has_order_items_in_details: !!(data.data || data.results || data.orders || [])[0]?.order_details?.order_items
      });
    }

    // Debug : prix négatifs détectés sur une commande
    if (action === "label_debug") {
      const oid = searchParams.get("order_id");
      const on = searchParams.get("order_number");
      if (!oid && !on) return NextResponse.json({ error: "order_id ou order_number requis" }, { status: 400 });
      const out: any = {};
      if (oid) {
        try {
          const d = await scJson(`${V3}/orders/${oid}`, auth);
          const o = d.data || d;
          out.order_keys = Object.keys(o);
          out.details_keys = Object.keys(o.order_details || {});
          out.has_negative_prices = hasNegativeItems(o);
          out.shipping_method_id = o.order_details?.shipping_method_id || o.shipping_details?.shipping_method_id || o.sendcloud_shipping_method_id;
          out.service_point_candidates = {
            details_to_service_point: o.order_details?.to_service_point,
            details_service_point_id: o.order_details?.service_point_id,
            details_service_point: o.order_details?.service_point,
            order_to_service_point: o.to_service_point,
            order_service_point_id: o.service_point_id,
            order_service_point: o.service_point,
            shipping_details_to_service_point: o.shipping_details?.to_service_point,
            shipping_details_service_point_id: o.shipping_details?.service_point_id,
            shipping_details_service_point: o.shipping_details?.service_point,
          };
          const items = o.order_details?.order_items || o.order_items || [];
          out.items_summary = items.map((i: any) => ({
            description: i.description || i.name,
            qty: i.quantity,
            unit_price: i.unit_price?.value ?? i.price,
          }));
        } catch (e: any) { out.v3_error = e.message; }
      }
      if (on) {
        try {
          const d = await scJson(`${V2}/parcels?order_number=${encodeURIComponent(on)}`, auth);
          out.v2_parcels_found = (d.parcels || []).length;
          out.v2_parcel_sample = (d.parcels || []).slice(0, 1);
        } catch (e: any) { out.v2_error = e.message; }
      }
      return NextResponse.json(out);
    }

    // Get label PDF for a parcel
    if (action === "label") {
      const orderId = searchParams.get("order_id");
      const orderNumber = searchParams.get("order_number");
      const clientShipmentId = searchParams.get("shipment_id") ? Number(searchParams.get("shipment_id")) : null;
      if (!orderId || !orderNumber) return NextResponse.json({ error: "order_id et order_number requis" }, { status: 400 });

      // Cherche un colis existant (par order_number puis par external_order_id)
      const findParcel = async (): Promise<any | null> => {
        try {
          const d = await scJson(`${V2}/parcels?order_number=${encodeURIComponent(orderNumber!)}`, auth);
          const exact = (d.parcels || []).find((p: any) => String(p.order_number) === String(orderNumber));
          if (exact) return exact;
        } catch {}
        try {
          const d = await scJson(`${V2}/parcels?external_order_id=${encodeURIComponent(orderId!)}`, auth);
          const exact = (d.parcels || []).find((p: any) =>
            String(p.order_number) === String(orderNumber) ||
            String(p.external_order_id) === String(orderId)
          );
          if (exact) return exact;
        } catch {}
        return null;
      };

      // Step 1 : déjà un colis avec label ?
      let parcel: any = await findParcel();
      if (parcel && !hasLabel(parcel)) {
        const polled = await pollLabel(auth, parcel.id, 4, 2000);
        parcel = polled || null;
      }

      // Step 1.5 : refetch V3 pour détecter les négatifs en amont
      let rawV3: any = null;
      try {
        const d = await scJson(`${V3}/orders/${orderId}`, auth);
        rawV3 = d.data || d;
      } catch {}
      const negativeDetected = hasNegativeItems(rawV3);
      if (negativeDetected) console.log("[label GET]", orderNumber, "→ prix négatifs, bypass V3 → V2 direct");

      // Step 2 : création
      if (!parcel) {
        let v3Failed = negativeDetected; // skip V3 si négatifs détectés
        let asyncParcelId: number | null = null;
        let createErrMsg = "";

        // Voie A : V3 create-labels-async
        if (!negativeDetected) {
          try {
            const createRes = await scJson(`${V3}/orders/create-labels-async`, auth, {
              method: "POST",
              body: JSON.stringify({ integration_id: INTEGRATION_ID, orders: [{ order_number: orderNumber }] }),
            });
            asyncParcelId = createRes?.data?.[0]?.parcel_id || null;
          } catch (e: any) {
            console.warn("[label GET] V3 create-labels-async échoué:", e.message);
            v3Failed = true;
            createErrMsg = e.message;
          }
          // Poll V3
          if (!v3Failed) {
            if (asyncParcelId) {
              parcel = await pollLabel(auth, asyncParcelId, 10, 2500);
            } else {
              for (let i = 0; i < 6; i++) {
                await new Promise(r => setTimeout(r, 2500));
                const c = await findParcel();
                if (c && hasLabel(c)) { parcel = c; break; }
              }
            }
          }
        }

        // Voie B : V2 direct (fallback OU bypass négatifs)
        if (!parcel && v3Failed) {
          try {
            const v2Parcel = await createParcelV2Direct(auth, orderId!, orderNumber!, rawV3, clientShipmentId);
            if (v2Parcel && hasLabel(v2Parcel)) {
              parcel = v2Parcel;
            } else if (v2Parcel?.id) {
              parcel = await pollLabel(auth, v2Parcel.id, 15, 2500);
              if (!parcel) {
                return NextResponse.json({
                  parcelId: v2Parcel.id,
                  tracking: v2Parcel.tracking_number || "",
                  carrier: v2Parcel.carrier?.code || "",
                  labelBase64: null,
                  labelPending: true,
                  error: "Étiquette en cours — réessaie dans 10s",
                }, { status: 202 });
              }
            }
          } catch (fallbackErr: any) {
            console.error("[label GET] V2 direct échoué:", fallbackErr.message);
            return NextResponse.json({
              error: `Impossible de créer l'étiquette : ${createErrMsg || fallbackErr.message}`,
              hint: fallbackErr.message,
            }, { status: 422 });
          }
        }

        // 202 si V3 OK mais pas encore prête
        if (!parcel && !v3Failed) {
          return NextResponse.json({ parcelId: asyncParcelId, labelPending: true, error: "Étiquette en cours — réessaie dans 10s" }, { status: 202 });
        }

        // Last resort
        if (!parcel) parcel = await findParcel();
      }

      if (!parcel) return NextResponse.json({ error: "Colis non trouvé après création étiquette" }, { status: 404 });

      const labelUrl = parcel?.label?.label_printer || parcel?.label?.normal_printer?.[0];
      if (!labelUrl) {
        return NextResponse.json({
          parcelId: parcel.id,
          tracking: parcel.tracking_number || "",
          carrier: parcel.carrier?.code || "",
          labelBase64: null,
          labelPending: true,
          error: "Étiquette en cours de génération — réessaie dans quelques secondes",
        }, { status: 202 });
      }

      const labelRes = await scFetch(labelUrl, auth);
      if (!labelRes.ok) return NextResponse.json({ error: `Erreur étiquette: ${labelRes.status}` }, { status: labelRes.status });

      const pdfBuffer = Buffer.from(await labelRes.arrayBuffer());
      return NextResponse.json({
        parcelId: parcel.id,
        tracking: parcel.tracking_number || "",
        carrier: parcel.carrier?.code || "",
        labelBase64: pdfBuffer.toString("base64"),
      });
    }

    // Packing slip PDF from V2
    if (action === "packingslip") {
      const orderNumber = searchParams.get("order_number");
      if (!orderNumber) return NextResponse.json({ error: "order_number requis" }, { status: 400 });

      const parcelsData = await scJson(`${V2}/parcels?order_number=${orderNumber}`, auth);
      const parcel = (parcelsData.parcels || [])[0];
      if (!parcel) return NextResponse.json({ error: `Aucun colis trouvé — imprime d'abord l'étiquette` }, { status: 404 });

      const psRes = await scFetch(`${V2}/packing-slips?parcel_id=${parcel.id}`, auth);
      if (!psRes.ok) {
        const errText = await psRes.text().catch(() => "");
        return NextResponse.json({ error: `BL ${psRes.status}: ${errText.substring(0, 200)}` }, { status: psRes.status });
      }
      const ct = psRes.headers.get("content-type") || "";
      if (ct.includes("pdf")) {
        const pdfBuffer = Buffer.from(await psRes.arrayBuffer());
        return NextResponse.json({ pdfBase64: pdfBuffer.toString("base64") });
      }
      const psJson = await psRes.json().catch(() => null);
      return NextResponse.json({ debug: psJson, parcelId: parcel.id });
    }

    // Debug parcel structure
    if (action === "parcel_debug") {
      const orderNumber = searchParams.get("order_number");
      if (!orderNumber) return NextResponse.json({ error: "order_number requis" }, { status: 400 });
      const parcelsData = await scJson(`${V2}/parcels?order_number=${orderNumber}`, auth);
      const parcel = (parcelsData.parcels || [])[0];
      if (!parcel) return NextResponse.json({ error: "Pas de colis" }, { status: 404 });
      return NextResponse.json({ parcel });
    }

    // Debug — show all distinct statuses and try multiple endpoints
    if (action === "debug") {
      const results: any = {};
      try {
        const data = await scJson(`${V2}/parcels?limit=500&integration_id=${INTEGRATION_ID}`, auth);
        const parcels = data.parcels || [];
        const statusMap: Record<string, number> = {};
        for (const p of parcels) {
          const key = `${p.status?.id}_${p.status?.message}`;
          statusMap[key] = (statusMap[key] || 0) + 1;
        }
        results.parcels_statuses = statusMap;
        results.parcels_total = parcels.length;
        results.parcels_sample = parcels.slice(0, 1).map((p: any) => ({
          id: p.id, order_number: p.order_number, status: p.status,
          tracking: p.tracking_number, has_label: !!p.label?.label_printer,
        }));
      } catch (e: any) { results.parcels_error = e.message; }
      try {
        const data = await scJson(`${V3}/shipping/orders?integration_id=${INTEGRATION_ID}&page_size=5`, auth);
        results.v3_orders_count = data.count || 0;
        results.v3_orders_sample = (data.results || []).slice(0, 2).map((o: any) => ({
          id: o.id, order_number: o.order_number, status: o.status, items: (o.lines || []).length
        }));
      } catch (e: any) { results.v3_orders_error = e.message; }
      try {
        const data = await scJson(`${V2}/integrations`, auth);
        const integrations = data.integrations || data;
        results.integrations = Array.isArray(integrations)
          ? integrations.map((i: any) => ({ id: i.id, name: i.shop_name, system: i.system }))
          : integrations;
      } catch (e: any) { results.integrations_error = e.message; }
      for (const sid of [999, 1000, 1, 2, 12, 1999]) {
        try {
          const data = await scJson(`${V2}/parcels?limit=3&status=${sid}`, auth);
          const count = (data.parcels || []).length;
          if (count > 0) results[`status_${sid}_count`] = count;
        } catch {}
      }
      return NextResponse.json(results);
    }

    return NextResponse.json({ error: "Actions: parcels, label, debug" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// ─── POST ─────────────────────────────────────────────────────────────────────
// Le client peut envoyer le `order_raw` (objet V3 complet) directement dans le
// body → on évite un refetch V3 et on détecte les prix négatifs en amont.

export async function POST(req: NextRequest) {
  const auth = getAuth();
  if (!auth) return NextResponse.json({ error: "Clés SendCloud manquantes" }, { status: 500 });

  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");

  if (action === "label") {
    try {
      const body = await req.json();
      const { order_id: orderId, order_number: orderNumber, order_raw: raw, shipment_id: clientShipmentId } = body;
      if (!orderId || !orderNumber) return NextResponse.json({ error: "order_id et order_number requis" }, { status: 400 });

      const findParcel = async (): Promise<any | null> => {
        try {
          const d = await scJson(`${V2}/parcels?order_number=${encodeURIComponent(orderNumber)}`, auth);
          const exact = (d.parcels || []).find((p: any) => String(p.order_number) === String(orderNumber));
          if (exact) return exact;
        } catch {}
        return null;
      };

      // Step 1 : déjà un colis avec label ?
      let parcel: any = await findParcel();
      if (parcel && !hasLabel(parcel)) {
        const polled = await pollLabel(auth, parcel.id, 6, 2500);
        parcel = polled || null;
      }

      // Step 2 : détection des négatifs en amont
      const negativeDetected = hasNegativeItems(raw);
      if (negativeDetected) console.log("[label POST]", orderNumber, "→ prix négatifs, bypass V3 → V2 direct");

      // Step 3 : création
      if (!parcel) {
        let v3Failed = negativeDetected;
        let asyncParcelId: number | null = null;

        // Voie A : V3 create-labels-async
        if (!negativeDetected) {
          try {
            const createRes = await scJson(`${V3}/orders/create-labels-async`, auth, {
              method: "POST",
              body: JSON.stringify({ integration_id: INTEGRATION_ID, orders: [{ order_number: orderNumber }] }),
            });
            asyncParcelId = createRes?.data?.[0]?.parcel_id || null;
            console.log("[label POST] V3 create-labels-async OK, parcel_id:", asyncParcelId);
          } catch (e: any) {
            console.warn("[label POST] V3 create-labels-async échoué:", e.message);
            v3Failed = true;
          }

          if (!v3Failed) {
            if (asyncParcelId) {
              parcel = await pollLabel(auth, asyncParcelId, 20, 3000);
            } else {
              for (let i = 0; i < 20; i++) {
                await new Promise(r => setTimeout(r, 3000));
                const c = await findParcel();
                if (c && hasLabel(c)) { parcel = c; break; }
              }
            }
          }
        }

        // Voie B : V2 direct
        if (!parcel && v3Failed) {
          try {
            const v2Parcel = await createParcelV2Direct(auth, orderId, orderNumber, raw, clientShipmentId);
            if (v2Parcel && hasLabel(v2Parcel)) {
              parcel = v2Parcel;
            } else if (v2Parcel?.id) {
              parcel = await pollLabel(auth, v2Parcel.id, 15, 2500);
              if (!parcel) {
                return NextResponse.json({
                  parcelId: v2Parcel.id,
                  tracking: v2Parcel.tracking_number || "",
                  carrier: v2Parcel.carrier?.code || "",
                  labelBase64: null,
                  labelPending: true,
                  error: "Étiquette en cours — réessaie dans 10s",
                }, { status: 202 });
              }
            }
          } catch (v2Err: any) {
            console.error("[label POST] V2 direct échoué:", v2Err.message);
            return NextResponse.json({
              error: negativeDetected
                ? `Impossible de créer l'étiquette malgré le bypass V2 : ${v2Err.message}`
                : `V3 et V2 ont échoué : ${v2Err.message}`,
            }, { status: 422 });
          }
        }

        if (!parcel && !v3Failed) {
          return NextResponse.json({ parcelId: asyncParcelId, labelPending: true, error: "Étiquette en cours — réessaie dans 10s" }, { status: 202 });
        }

        if (!parcel) {
          return NextResponse.json({ error: "Impossible de créer l'étiquette. Crée-la manuellement sur SendCloud puis réessaie." }, { status: 422 });
        }
      }

      if (!parcel) return NextResponse.json({ error: "Colis introuvable" }, { status: 404 });

      const labelUrl = parcel?.label?.label_printer || parcel?.label?.normal_printer?.[0];
      if (!labelUrl) {
        return NextResponse.json({ parcelId: parcel.id, labelPending: true, error: "Étiquette en cours — réessaie dans quelques secondes" }, { status: 202 });
      }

      const labelRes = await scFetch(labelUrl, auth);
      if (!labelRes.ok) return NextResponse.json({ error: `Erreur PDF: ${labelRes.status}` }, { status: labelRes.status });

      const pdfBuffer = Buffer.from(await labelRes.arrayBuffer());
      return NextResponse.json({
        parcelId: parcel.id,
        tracking: parcel.tracking_number || "",
        carrier: parcel.carrier?.code || "",
        labelBase64: pdfBuffer.toString("base64"),
      });
    } catch (e: any) {
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "POST: action non supportée" }, { status: 405 });
}
