// app/api/sendcloud/route.ts — Server-side proxy for SendCloud API
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

const V2 = "https://panel.sendcloud.sc/api/v2";
const V3 = "https://panel.sendcloud.sc/api/v3";

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

export async function GET(req: NextRequest) {
  const auth = getAuth();
  if (!auth) return NextResponse.json({ error: "SENDCLOUD_PUBLIC_KEY / SENDCLOUD_SECRET_KEY non configurées" }, { status: 500 });

  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");

  try {
    // List parcels with optional status filter
    if (action === "parcels") {
      const statusFilter = searchParams.get("status") || "";
      // Filter by integration 527093 (Dr. Hauschka Shop FR-FR)
      const data = await scJson(`${V2}/parcels?limit=500&integration_id=527093`, auth);
      let parcels = data.parcels || [];
      if (statusFilter) {
        const ids = statusFilter.split(",").map((s: string) => parseInt(s.trim()));
        parcels = parcels.filter((p: any) => ids.includes(p.status?.id));
      }
      return NextResponse.json({ parcels });
    }

    // V3 orders — open orders not yet converted to parcels
    if (action === "orders") {
      const data = await scJson(`${V3}/orders?integration_id=527093&page_size=100`, auth);
      let orders = data.data || data.results || data.orders || [];
      // If order_items not in list response, fetch each order individually
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
      const data = await scJson(`${V3}/orders?integration_id=527093&page_size=3`, auth);
      return NextResponse.json({ 
        keys: Object.keys(data), 
        count: data.count ?? data.total ?? "?",
        sample: (data.data || data.results || data.orders || []).slice(0, 2),
        first_order_keys: Object.keys((data.data || data.results || data.orders || [])[0] || {}),
        order_details_keys: Object.keys((data.data || data.results || data.orders || [])[0]?.order_details || {}),
        has_order_items_in_details: !!(data.data || data.results || data.orders || [])[0]?.order_details?.order_items
      });
    }

    // Debug complet d'une commande V3 par order_number
    if (action === "label_debug") {
      const on = searchParams.get("order_number");
      const oid = searchParams.get("order_id");
      if (!on && !oid) return NextResponse.json({ error: "order_number ou order_id requis" }, { status: 400 });
      const results: any = {};
      // V3 order by ID
      if (oid) {
        try {
          const d = await scJson(`${V3}/orders/${oid}`, auth);
          const o = d.data || d;
          results.v3_order_keys = Object.keys(o);
          results.v3_order_details_keys = Object.keys(o.order_details || {});
          results.v3_shipping_keys = Object.keys(o.shipping_address || {});
          results.sendcloud_shipping_method_id = o.sendcloud_shipping_method_id;
          results.order_details_shipping_method_id = o.order_details?.shipping_method_id;
          results.shipment = o.shipment;
          results.shipping_method = o.shipping_method;
          results.carrier = o.carrier;
          results.order_details_carrier = o.order_details?.carrier;
          results.order_items_count = (o.order_details?.order_items || o.order_items || []).length;
          results.order_items_sample = (o.order_details?.order_items || o.order_items || []).slice(0, 2);
          results.has_negative_prices = (o.order_details?.order_items || o.order_items || []).some(
            (i: any) => parseFloat(i.unit_price?.value ?? i.price ?? 0) < 0
          );
          results.full_order = o; // full raw structure
        } catch (e: any) { results.v3_order_error = e.message; }
      }
      // V2 parcel search
      if (on) {
        try {
          const d = await scJson(`${V2}/parcels?order_number=${encodeURIComponent(on)}`, auth);
          results.v2_parcels_found = (d.parcels || []).length;
          results.v2_parcel_sample = (d.parcels || []).slice(0, 1);
        } catch (e: any) { results.v2_error = e.message; }
      }
      return NextResponse.json(results);
    }

    // Get label PDF for a parcel
    if (action === "label") {
      const orderId = searchParams.get("order_id");
      const orderNumber = searchParams.get("order_number");
      const clientShipmentId = searchParams.get("shipment_id") ? Number(searchParams.get("shipment_id")) : null;
      if (!orderId || !orderNumber) return NextResponse.json({ error: "order_id et order_number requis" }, { status: 400 });

      // Helper: find a parcel for this order via multiple strategies
      // IMPORTANT: always verify exact order_number match to avoid returning a wrong parcel
      const findParcel = async (): Promise<any | null> => {
        // 1. By order_number — verify exact match in response
        try {
          const d = await scJson(`${V2}/parcels?order_number=${encodeURIComponent(orderNumber!)}`, auth);
          const list: any[] = d.parcels || [];
          // SendCloud may do partial/fuzzy search — filter strictly
          const exact = list.find((p: any) => String(p.order_number) === String(orderNumber));
          if (exact) return exact;
        } catch {}
        // 2. By order_id — verify exact match
        try {
          const d = await scJson(`${V2}/parcels?external_order_id=${encodeURIComponent(orderId!)}`, auth);
          const list: any[] = d.parcels || [];
          const exact = list.find((p: any) =>
            String(p.order_number) === String(orderNumber) ||
            String(p.external_order_id) === String(orderId)
          );
          if (exact) return exact;
        } catch {}
        return null;
      }

      // Step 1: check if parcel already exists with a label
      let parcel: any = await findParcel();
      if (parcel && !(parcel?.label?.label_printer || parcel?.label?.normal_printer?.[0])) {
        // Parcel exists but no label yet — fall through to create
        parcel = null;
      }

      // Step 2: create label if not already found with a label URL
      if (!parcel) {
        let createFailed = false;
        let createErrMsg = "";
        let asyncParcelId: number | null = null;

        try {
          const createRes = await scJson(`${V3}/orders/create-labels-async`, auth, {
            method: "POST",
            body: JSON.stringify({
              integration_id: 527093,
              orders: [{ order_number: orderNumber }],
            }),
          });
          // La réponse contient le parcel_id → on l'utilise pour poll direct (plus fiable)
          const dataArr = createRes?.data || [];
          if (dataArr.length > 0 && dataArr[0].parcel_id) {
            asyncParcelId = dataArr[0].parcel_id;
            console.log("[label] create-labels-async parcel_id:", asyncParcelId);
          }
        } catch (createErr: any) {
          createFailed = true;
          createErrMsg = createErr.message;
          console.warn("[label] create-labels-async error:", createErr.message);
        }

        // Poll si pas d'erreur — stratégie : poll direct par parcel_id si dispo, sinon par order_number
        if (!createFailed) {
          // Poll spécifique par parcel_id (beaucoup plus fiable)
          if (asyncParcelId) {
            for (let i = 0; i < 10; i++) {
              await new Promise(r => setTimeout(r, 2500));
              try {
                const d = await scJson(`${V2}/parcels/${asyncParcelId}`, auth);
                const candidate = d.parcel || d;
                if (candidate?.label?.label_printer || candidate?.label?.normal_printer?.[0]) {
                  parcel = candidate;
                  console.log("[label] label prête via parcel_id direct:", asyncParcelId);
                  break;
                }
              } catch {}
            }
          } else {
            // Fallback : poll par order_number
            for (let i = 0; i < 6; i++) {
              await new Promise(r => setTimeout(r, 2500));
              const candidate = await findParcel();
              if (candidate?.label?.label_printer || candidate?.label?.normal_printer?.[0]) {
                parcel = candidate;
                break;
              }
            }
          }
          // create-labels-async a réussi mais colis pas encore prêt → 202 pending
          if (!parcel) {
            return NextResponse.json({
              parcelId: asyncParcelId,
              tracking: "",
              carrier: "",
              labelBase64: null,
              labelPending: true,
              error: "Étiquette en cours de génération — réessaie dans 10 secondes",
            }, { status: 202 });
          }
        }

        // ── Fallback V2 direct quand create-labels-async échoue (422 prix négatifs) ──
        if (!parcel && createFailed) {
          console.log("[label] 422 détecté → fallback V2 direct pour:", orderNumber);
          try {
            // Récupérer le détail de la commande V3
            const orderDetail = await scJson(`${V3}/orders/${orderId}`, auth);
            const order = orderDetail.data || orderDetail;
            const details = order.order_details || {};
            const rawItems: any[] = details.order_items || order.order_items || [];
            const addr = order.shipping_address || order.address || {};

            console.log("[label] V3 order keys:", Object.keys(order));
            console.log("[label] V3 details keys:", Object.keys(details));
            console.log("[label] shipping_details:", order.shipping_details);

            // Shipment ID : client en priorité, sinon on fouille tous les champs
            let shipmentId: number | null = clientShipmentId
              || details.shipping_method_id
              || order.shipping_details?.shipping_method_id
              || order.sendcloud_shipping_method_id
              || order.shipment?.id
              || order.shipping_method?.id
              || null;

            // Si toujours pas → emprunter d'un colis récent de la même intégration
            if (!shipmentId) {
              try {
                const recent = await scJson(`${V2}/parcels?integration_id=527093&limit=5`, auth);
                const rp = (recent.parcels || []).find((p: any) => p.shipment?.id);
                if (rp?.shipment?.id) { shipmentId = rp.shipment.id; console.log("[label] shipmentId emprunté:", shipmentId); }
              } catch {}
            }

            console.log("[label] shipmentId final:", shipmentId);

            // Items avec prix ≥ 0 (remises zeroisées)
            const parcelItems = rawItems
              .filter((item: any) => item && (item.description || item.name || item.title || item.sku))
              .map((item: any) => {
                const rawVal = item.unit_price?.value ?? item.product_value ?? item.price ?? item.value ?? "0";
                return {
                  description: (item.description || item.name || item.title || item.sku || "Article").substring(0, 100),
                  quantity: Math.max(1, parseInt(String(item.quantity || 1))),
                  weight: String(Math.max(0.001, parseFloat(String(item.weight || "0.1"))).toFixed(3)),
                  value: String(Math.max(0, parseFloat(String(rawVal))).toFixed(2)),
                  hs_code: item.harmonized_system_code || item.hs_code || "",
                  origin_country: item.origin_country || "DE",
                  sku: item.sku || "",
                };
              });

            const totalValue = Math.max(0, parcelItems.reduce(
              (s: number, i: any) => s + parseFloat(i.value) * i.quantity, 0
            ));

            const name = [addr.first_name, addr.last_name].filter(Boolean).join(" ")
              || addr.company_name || addr.name || "Client";
            const street = [addr.street, addr.house_number].filter(Boolean).join(" ")
              || addr.address_line_1 || addr.address_1 || addr.address || "";

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
                weight: "1.000",
                order_number: orderNumber,
                total_order_value: totalValue.toFixed(2),
                total_order_value_currency: order.currency || "EUR",
                request_label: true,
                ...(parcelItems.length > 0 && { parcel_items: parcelItems }),
                ...(shipmentId ? { shipment: { id: shipmentId } } : {}),
              }
            };

            console.log("[label] V2 payload shipment:", v2Payload.parcel.shipment, "| name:", name, "| addr:", street);

            const v2Result = await scJson(`${V2}/parcels`, auth, {
              method: "POST",
              body: JSON.stringify(v2Payload),
            });
            parcel = v2Result.parcel || null;
            if (parcel) console.log("[label] V2 parcel créé:", parcel.id, "label:", parcel?.label?.label_printer);
          } catch (fallbackErr: any) {
            console.error("[label] V2 fallback échoué:", fallbackErr.message);
            return NextResponse.json({
              error: `Impossible de créer l'étiquette (prix négatif/remise) : ${createErrMsg}`,
              hint: fallbackErr.message,
            }, { status: 422 });
          }
        } // fin if (!parcel && createFailed)

        // Last resort: return whatever parcel we find even without a label (client can retry)
        if (!parcel) {
          parcel = await findParcel();
        }
      }

      if (!parcel) return NextResponse.json({ error: "Colis non trouvé après création étiquette" }, { status: 404 });

      const labelUrl = parcel?.label?.label_printer || parcel?.label?.normal_printer?.[0];
      if (!labelUrl) {
        // Return parcel info so client knows it exists but label isn't ready
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

      // Get parcel to find its id
      const parcelsData = await scJson(`${V2}/parcels?order_number=${orderNumber}`, auth);
      const parcel = (parcelsData.parcels || [])[0];
      if (!parcel) return NextResponse.json({ error: `Aucun colis trouvé — imprime d'abord l'étiquette` }, { status: 404 });

      // Packing slip endpoint: GET /api/v2/packing-slips?parcel_id=XXX
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
      // JSON response — log it to understand structure
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
      // Return full parcel to see all fields including label URLs
      return NextResponse.json({ parcel });
    }

    // Debug — show all distinct statuses and try multiple endpoints
    if (action === "debug") {
      const results: any = {};

      // 1. Parcels endpoint — get all statuses
      try {
        const data = await scJson(`${V2}/parcels?limit=500&integration_id=527093`, auth);
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

      // 2. Try V3 orders
      try {
        const data = await scJson(`${V3}/shipping/orders?integration_id=527093&page_size=5`, auth);
        results.v3_orders_count = data.count || 0;
        results.v3_orders_sample = (data.results || []).slice(0, 2).map((o: any) => ({
          id: o.id, order_number: o.order_number, status: o.status, items: (o.lines || []).length
        }));
      } catch (e: any) { results.v3_orders_error = e.message; }

      // 3. Try /integrations endpoint (for open orders)
      try {
        const data = await scJson(`${V2}/integrations`, auth);
        const integrations = data.integrations || data;
        results.integrations = Array.isArray(integrations) 
          ? integrations.map((i: any) => ({ id: i.id, name: i.shop_name, system: i.system }))
          : integrations;
      } catch (e: any) { results.integrations_error = e.message; }

      // 3. Try /parcels with specific statuses
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

export async function POST(req: NextRequest) {
  const auth = getAuth();
  if (!auth) return NextResponse.json({ error: "Clés SendCloud manquantes" }, { status: 500 });

  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");

  if (action === "label") {
    try {
      const body = await req.json();
      const { order_id: orderId, order_number: orderNumber, order_raw: raw } = body;
      if (!orderId || !orderNumber) return NextResponse.json({ error: "order_id et order_number requis" }, { status: 400 });

      // ── Helper: chercher un colis existant par order_number ──────────────
      const findParcel = async (): Promise<any | null> => {
        try {
          const d = await scJson(`${V2}/parcels?order_number=${encodeURIComponent(orderNumber)}`, auth);
          const exact = (d.parcels || []).find((p: any) => String(p.order_number) === String(orderNumber));
          if (exact) return exact;
        } catch {}
        return null;
      };

      // ── Étape 1 : colis déjà existant avec étiquette ? ───────────────────
      let parcel: any = await findParcel();
      const hasLabel = (p: any) => p?.label?.label_printer || p?.label?.normal_printer?.[0];
      if (parcel && !hasLabel(parcel)) parcel = null;

      // ── Étape 2 : créer le colis V2 directement — sans logique articles ──
      // On évite create-labels-async qui valide les prix de l'ordre stocké dans SendCloud
      if (!parcel) {
        // Récupérer le détail complet V3 par order_number (pour service point + shipment)
        let fullOrder: any = raw || {};
        try {
          const allOrders = await scJson(`${V3}/orders?integration_id=527093&page_size=100`, auth);
          const found = (allOrders.data || allOrders.results || allOrders.orders || [])
            .find((o: any) => String(o.order_number) === String(orderNumber));
          if (found?.order_id) {
            const detail = await scJson(`${V3}/orders/${found.order_id}`, auth);
            fullOrder = detail.data || detail;
            console.log("[label-post] V3 detail keys:", Object.keys(fullOrder).join(","));
          }
        } catch (e: any) {
          console.warn("[label-post] fetch V3 detail échoué, utilise raw:", e.message);
        }

        const addr = fullOrder.shipping_address || raw?.shipping_address || {};
        const details = fullOrder.order_details || raw?.order_details || {};

        // Shipment method
        const shipmentId: number | null =
          details.shipping_method_id
          || fullOrder.shipping_details?.shipping_method_id
          || fullOrder.sendcloud_shipping_method_id
          || raw?.shipping_details?.shipping_method_id
          || null;

        // Service point (Mondial Relay)
        const spRaw =
          fullOrder.to_service_point
          || fullOrder.service_point_id
          || details.to_service_point
          || raw?.to_service_point
          || null;
        const servicePointId = typeof spRaw === "object" && spRaw !== null ? spRaw.id : spRaw;

        console.log("[label-post] shipmentId:", shipmentId, "| servicePointId:", servicePointId, "| to_service_point raw:", fullOrder.to_service_point);

        const name = [addr.first_name, addr.last_name].filter(Boolean).join(" ")
          || addr.company_name || addr.name || "Client";
        const street = [addr.street, addr.house_number].filter(Boolean).join(" ")
          || addr.address_line_1 || addr.address || "";

        const v2Payload: any = {
          parcel: {
            name,
            company_name: addr.company_name || "",
            address: street,
            address_2: addr.address_2 || "",
            city: addr.city || "",
            postal_code: addr.postal_code || "",
            country: addr.country || addr.country_code || "FR",
            email: fullOrder.email || raw?.email || addr.email || "",
            telephone: fullOrder.telephone || raw?.telephone || addr.phone || "",
            weight: "0.500",
            order_number: orderNumber,
            request_label: true,
            ...(shipmentId ? { shipment: { id: shipmentId } } : {}),
            ...(servicePointId ? { to_service_point: servicePointId } : {}),
          }
        };

        console.log("[label-post] V2 POST payload (sans articles):", JSON.stringify(v2Payload).substring(0, 400));

        try {
          const v2Result = await scJson(`${V2}/parcels`, auth, {
            method: "POST",
            body: JSON.stringify(v2Payload),
          });
          parcel = v2Result.parcel || null;
          console.log("[label-post] V2 créé:", parcel?.id, "label:", !!parcel?.label?.label_printer);
        } catch (e: any) {
          console.error("[label-post] V2 échoué:", e.message);
          return NextResponse.json({ error: e.message }, { status: 422 });
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
