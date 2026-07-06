// app/api/sendcloud/route.ts — Server-side proxy for SendCloud API
import { NextRequest, NextResponse } from "next/server";
import { fetchT } from "@/lib/fetchTimeout";
import { checkRateLimit, getClientIp } from "@/lib/rateLimiter";

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
  return fetchT(url, { ...options, headers: { "Authorization": auth, "Content-Type": "application/json", ...(options?.headers || {}) } }, 15_000);
}

async function scJson(url: string, auth: string, options?: RequestInit) {
  const res = await scFetch(url, auth, options);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`SendCloud ${res.status}: ${text.substring(0, 300)}`);
  }
  return res.json();
}

// ─── Helpers partagés (négatifs / V2 direct) ─────────────────────────────────
const INTEGRATION_ID = 527093;

// Sort une commande V3 de la file SendCloud après qu'un colis a été créé via le
// fallback V2 (sinon l'order garde son bouton "créer étiquette" → risque de doublon).
// Stratégie : cancel d'abord (réversible), DELETE en secours. Le DELETE cible l'ID
// INTERNE Sendcloud (≠ order_id externe) — ce qui manquait dans l'ancienne version.
async function consumeV3Order(auth: string, orderNumber: string, externalOrderId?: string | number): Promise<void> {
  // Résoudre l'id interne par order_number
  let internalId: string | number | null = null;
  try {
    const list = await scJson(`${V3}/orders?integration_id=${INTEGRATION_ID}&order_number=${encodeURIComponent(orderNumber)}`, auth);
    const arr = list.data || list.results || list.orders || [];
    const found = arr.find((o: any) => String(o.order_number) === String(orderNumber)) || arr[0];
    if (found?.id) internalId = found.id;
  } catch {}

  // 1) cancel (le plus propre)
  try {
    await scJson(`${V3}/orders/cancel`, auth, {
      method: "POST",
      body: JSON.stringify({ orders: [{ order_number: orderNumber }] }),
    });
    console.log("[consume V3]", orderNumber, "annulée OK");
    return;
  } catch (e: any) {
    console.warn("[consume V3] cancel échoué pour", orderNumber, ":", e.message);
  }

  // 2) DELETE par id interne (puis external en dernier recours)
  const targetId = internalId ?? externalOrderId;
  if (targetId) {
    try {
      await scJson(`${V3}/orders/${encodeURIComponent(String(targetId))}`, auth, { method: "DELETE" });
      console.log("[consume V3]", orderNumber, "(id", targetId, ") supprimée OK");
      return;
    } catch (e: any) {
      console.warn("[consume V3] DELETE échoué pour", orderNumber, ":", e.message);
    }
  }
}

function hasNegativeItems(raw: any): boolean {
  if (!raw) return false;
  const items: any[] = raw.order_details?.order_items || raw.order_items || [];
  return items.some((i: any) => {
    const v = parseFloat(String(i.unit_price?.value ?? i.product_value ?? i.price ?? i.value ?? "0"));
    return v < 0;
  });
}

/**
 * Crée un colis V2 directement avec `request_label: true`.
 * Bypasse V3 create-labels-async (qui rejette les commandes avec prix négatifs).
 * Stratégie : on calcule le NET total (somme algébrique incluant les remises),
 * et on n'envoie que les parcel_items à prix positifs (les remises sont absorbées
 * dans total_order_value, ce que les transporteurs/douane acceptent).
 */
async function createParcelV2Direct(
  auth: string,
  orderId: string,
  orderNumber: string,
  raw: any,
  clientShipmentId?: number | null
): Promise<any> {
  // Si raw absent, on refetch
  let order = raw;
  if (!order || (!order.order_details && !order.order_items)) {
    const d = await scJson(`${V3}/orders/${orderId}`, auth);
    order = d.data || d;
  }
  const details = order.order_details || {};
  const rawItems: any[] = details.order_items || order.order_items || [];
  const addr = order.shipping_address || details.shipping_address || order.address || {};

  // Net total (peut contenir des négatifs) — borné à 0 minimum pour la douane
  const netTotal = rawItems.reduce((sum: number, i: any) => {
    const v = parseFloat(String(i.unit_price?.value ?? i.product_value ?? i.price ?? i.value ?? "0"));
    const q = Math.max(1, parseInt(String(i.quantity || 1)));
    return sum + v * q;
  }, 0);

  // parcel_items : on ne garde que les positifs (les remises sont absorbées dans total_order_value)
  const parcelItems = rawItems
    .filter((item: any) => {
      if (!item) return false;
      const v = parseFloat(String(item.unit_price?.value ?? item.product_value ?? item.price ?? item.value ?? "0"));
      if (v < 0) return false; // ignore les lignes de remise
      return !!(item.description || item.name || item.title || item.sku);
    })
    .map((item: any) => {
      const rawVal = item.unit_price?.value ?? item.product_value ?? item.price ?? item.value ?? "0";
      // poids : V3 l'imbrique dans measurement.weight.value
      const wRaw = item?.measurement?.weight?.value ?? item.weight ?? "0.1";
      return {
        description: String(item.name || item.description || item.title || item.sku || "Article").substring(0, 100),
        quantity: Math.max(1, parseInt(String(item.quantity || 1))),
        weight: String(Math.max(0.001, parseFloat(String(wRaw)) || 0.1).toFixed(3)),
        value: String(Math.max(0, parseFloat(String(rawVal))).toFixed(2)),
        hs_code: item.harmonized_system_code || item.hs_code || "",
        origin_country: item.origin_country || "DE",
        sku: item.sku || "",
      };
    });

  // Shipment ID : client → V3 → emprunt à un colis récent de la même intégration
  let shipmentId: number | null =
    clientShipmentId ||
    details.shipping_method_id ||
    order.shipping_details?.shipping_method_id ||
    order.sendcloud_shipping_method_id ||
    order.shipment?.id ||
    order.shipping_method?.id ||
    null;

  // Indicateur de livraison de la commande (ex: "2. Livraison à domicile - Colissimo"
  // ou "Point relais - Mondial Relay"). Sert à choisir la bonne méthode d'envoi.
  const deliveryIndicator: string = String(
    order.shipping_details?.delivery_indicator ||
    details.shipping_details?.delivery_indicator ||
    order.delivery_indicator || ""
  );
  // Un point relais est réellement présent sur la commande ?
  const resolvedSpId =
    order.shipping_details?.service_point_details?.id ??
    order.shipping_details?.service_point_details?.carrier_service_point_id ??
    details.shipping_details?.service_point_details?.id ??
    order.service_point_details?.id ??
    order.service_point_details?.carrier_service_point_id ??
    details.service_point_details?.id ??
    order.to_service_point ?? order.service_point_id ??
    order.service_point?.id ?? details.to_service_point ?? null;
  const hasServicePoint = resolvedSpId != null;
  // Le libellé Shopware peut dire "Point Relais" même quand le client est livré à
  // domicile (point relais non sélectionné). On ne traite en point relais QUE si un
  // point relais est réellement rattaché ; sinon → livraison à domicile (Colissimo Home).
  const indicatorSaysSp = /point\s*relais|relay|pickup|service\s*point/i.test(deliveryIndicator);
  const wantsServicePoint = indicatorSaysSp && hasServicePoint;

  const name =
    [addr.first_name, addr.last_name].filter(Boolean).join(" ") ||
    addr.company_name || addr.name || "Client";
  // V3 utilise address_line_1, V2 utilise street — on prend le bon selon ce qui est présent
  const streetBase = addr.street || addr.address_line_1 || addr.address_1 || addr.address || "";
  const houseNum   = addr.house_number || "";
  const street     = streetBase && houseNum ? `${streetBase} ${houseNum}` : streetBase || houseNum;

  // Poids total — la structure V3 imbrique le poids dans measurement.weight.value
  const itemWeight = (i: any): number => {
    const v = i?.measurement?.weight?.value ?? i?.weight ?? 0;
    const n = parseFloat(String(v));
    return isFinite(n) ? n : 0;
  };
  // Poids min 0.751 kg : certaines méthodes Colissimo refusent en dessous
  // ("Minimum weight is 0.751 kg"). On plancher à 0.8 kg pour être tranquille.
  const MIN_WEIGHT = 0.8;
  const totalWeight = Math.max(
    MIN_WEIGHT,
    rawItems.reduce((s: number, i: any) => {
      const q = Math.max(1, parseInt(String(i.quantity || 1)));
      return s + itemWeight(i) * q;
    }, 0)
  ).toFixed(3);

  // Résolution de la méthode d'envoi (shipping_method) — REQUISE par V2.
  // On interroge les méthodes SendCloud dispo pour le pays + poids, puis on choisit
  // celle qui correspond au transporteur de la commande, en excluant les méthodes
  // point relais sur une commande DOMICILE (et inversement).
  if (!shipmentId) {
    try {
      const country = addr.country || addr.country_code || addr.country_iso_2 || "FR";

      // Si point relais : récupérer le CARRIER réel du point (Mondial Relay, Colissimo…)
      // via l'API service-points → la méthode choisie doit être du MÊME carrier,
      // sinon SendCloud refuse "Service point carrier does not match shipping method".
      let spCarrier = "";
      const spId = order.shipping_details?.service_point_details?.id
        ?? details.shipping_details?.service_point_details?.id
        ?? order.service_point_details?.id ?? null;
      if (wantsServicePoint && spId) {
        try {
          // ⚠ API service-points sur un domaine dédié (≠ panel.sendcloud.sc)
          const sp = await scJson(`https://servicepoints.sendcloud.sc/api/v2/service-points/${encodeURIComponent(String(spId))}`, auth);
          spCarrier = String(sp?.carrier || sp?.service_point?.carrier || "").toLowerCase();
        } catch {}
      }

      const sm = await scJson(`${V2}/shipping_methods?to_country=${country}&from_country=FR`, auth);
      let methods: any[] = sm.shipping_methods || [];
      methods = methods.filter((m: any) => {
        const isSp = m.service_point_input && m.service_point_input !== "none";
        return wantsServicePoint ? isSp : !isSp;
      });
      // Filtre par carrier du point relais si connu
      if (spCarrier) {
        const sameCarrier = methods.filter((m: any) => String(m.carrier || "").toLowerCase() === spCarrier);
        if (sameCarrier.length) methods = sameCarrier;
      }
      const wNum = parseFloat(totalWeight);
      const inWeight = methods.filter((m: any) => {
        const min = parseFloat(m.min_weight ?? "0");
        const max = parseFloat(m.max_weight ?? "999");
        return wNum >= min && wNum <= max;
      });
      const pool = inWeight.length ? inWeight : methods;
      const lowerInd = deliveryIndicator.toLowerCase();
      const byCarrier = pool.find((m: any) => {
        const c = String(m.carrier || "").toLowerCase();
        const n = String(m.name || "").toLowerCase();
        if (spCarrier) return c === spCarrier; // point relais : carrier exact
        return (c && lowerInd.includes(c)) || (lowerInd.includes("colissimo") && (c.includes("colissimo") || n.includes("colissimo")));
      });
      const chosen = byCarrier || pool[0];
      if (chosen?.id) shipmentId = chosen.id;
    } catch {}
  }

  // ── Point relais (service point) ────────────────────────────────────────
  // Pour les envois en point relais, SendCloud EXIGE to_service_point (ID du point
  // choisi par le client), sinon : 400 "A service point is required".
  // On cherche l'ID dans tous les emplacements connus de la structure order V3/V2.
  const servicePointId =
    // Structure V3 : shipping_details.service_point_details.{id | carrier_service_point_id}
    order.shipping_details?.service_point_details?.id ??
    order.shipping_details?.service_point_details?.carrier_service_point_id ??
    details.shipping_details?.service_point_details?.id ??
    order.service_point_details?.id ??
    order.service_point_details?.carrier_service_point_id ??
    details.service_point_details?.id ??
    details.service_point_details?.carrier_service_point_id ??
    // Autres chemins connus (V2 / variations)
    order.to_service_point ??
    order.service_point_id ??
    order.servicePoint?.id ??
    order.service_point?.id ??
    details.to_service_point ??
    details.service_point_id ??
    details.service_point?.id ??
    order.shipping_address?.to_service_point ??
    addr.service_point_id ??
    addr.to_service_point ??
    order.checkout_payload?.service_point?.id ??
    order.checkout_payload?.to_service_point ??
    null;
  const postNumberSp = order.shipping_details?.service_point_details?.post_number ?? order.service_point_details?.post_number ?? null;
  // to_post_number : requis uniquement pour DHL Allemagne en point relais
  const postNumber =
    postNumberSp ??
    order.to_post_number ??
    details.to_post_number ??
    addr.to_post_number ??
    order.checkout_payload?.to_post_number ??
    null;

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
      telephone: order.telephone || addr.phone || addr.telephone || addr.phone_number || "",
      weight: totalWeight,
      order_number: orderNumber,
      external_order_id: String(orderId),
      total_order_value: Math.max(0, netTotal).toFixed(2),
      total_order_value_currency: order.currency || "EUR",
      request_label: true,
      ...(parcelItems.length > 0 && { parcel_items: parcelItems }),
      ...(shipmentId ? { shipment: { id: shipmentId } } : {}),
      ...(servicePointId ? { to_service_point: Number(servicePointId) } : {}),
      ...(postNumber ? { to_post_number: String(postNumber) } : {}),
    },
  };

  console.log("[V2 direct] order:", orderNumber, "| netTotal:", netTotal.toFixed(2), "| items+:", parcelItems.length, "| shipment:", shipmentId, "| servicePoint:", servicePointId, "| weight:", totalWeight);

  const result = await scJson(`${V2}/parcels`, auth, {
    method: "POST",
    body: JSON.stringify(v2Payload),
  });
  return result.parcel || null;
}

/**
 * Poll un parcel par id jusqu'à ce que son étiquette soit prête.
 */
async function pollLabel(auth: string, parcelId: number, attempts = 15, delayMs = 2500): Promise<any | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      const d = await scJson(`${V2}/parcels/${parcelId}`, auth);
      const c = d.parcel || d;
      if (c?.label?.label_printer || c?.label?.normal_printer?.[0]) return c;
    } catch {}
    await new Promise(r => setTimeout(r, delayMs));
  }
  return null;
}

export async function GET(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`sc:${ip}`, 90, 60_000);
  if (!rl.allowed) return NextResponse.json({ error: "Trop de requêtes" }, { status: 429, headers: { "Retry-After": String(Math.ceil(rl.resetIn / 1000)) } });

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
      const on = searchParams.get("order_number");
      const data = await scJson(`${V3}/orders?integration_id=527093&page_size=100`, auth);
      const orders = data.data || data.results || data.orders || [];
      const target = on ? orders.find((o: any) => String(o.order_number) === String(on)) : orders[0];
      return NextResponse.json({ full_raw: target });
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

      // Step 1.5: refetch V3 raw pour détecter les prix négatifs en amont
      let rawV3: any = null;
      try {
        const d = await scJson(`${V3}/orders/${orderId}`, auth);
        rawV3 = d.data || d;
      } catch {}
      const negativeDetectedGET = hasNegativeItems(rawV3);
      if (negativeDetectedGET) console.log("[label GET]", orderNumber, "→ prix négatifs détectés, bypass V3");

      // Step 2: create label if not already found with a label URL
      if (!parcel) {
        let createFailed = negativeDetectedGET; // skip V3 d'emblée si négatifs
        let createErrMsg = "";
        let asyncParcelId: number | null = null;

        if (!negativeDetectedGET) {
          try {
            const createRes = await scJson(`${V3}/orders/create-labels-async`, auth, {
              method: "POST",
              body: JSON.stringify({
                integration_id: INTEGRATION_ID,
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

        // ── (A) Retry V3 si échec ET pas de prix négatifs ──────────────────
        // Cas typique : point relais dont la résolution prend un léger délai côté
        // SendCloud (comme le bouton "1 clic" de l'interface). On laisse passer
        // ~3s, on re-déclenche create-labels-async sur l'order V3 déjà importé,
        // puis on re-poll. On NE fait ce retry QUE pour les commandes SANS prix
        // négatifs (les négatifs sont gérés par le fallback V2 plus bas).
        if (!parcel && createFailed && negativeDetectedGET === false) {
          console.log("[label] retry V3 create-labels-async pour:", orderNumber, "(échec initial, pas de négatifs)");
          await new Promise(r => setTimeout(r, 3000));
          let retryParcelId: number | null = null;
          try {
            const retryRes = await scJson(`${V3}/orders/create-labels-async`, auth, {
              method: "POST",
              body: JSON.stringify({
                integration_id: INTEGRATION_ID,
                orders: [{ order_number: orderNumber }],
              }),
            });
            const retryArr = retryRes?.data || [];
            if (retryArr.length > 0 && retryArr[0].parcel_id) {
              retryParcelId = retryArr[0].parcel_id;
              console.log("[label] retry V3 parcel_id:", retryParcelId);
            }
            // Le retry a abouti → on annule l'état d'échec pour ne PAS tomber
            // dans le fallback V2 (réservé aux prix négatifs).
            createFailed = false;
            createErrMsg = "";
          } catch (retryErr: any) {
            // Le retry a de nouveau échoué → on conserve le vrai message SendCloud
            createErrMsg = retryErr.message;
            console.warn("[label] retry V3 échoué:", retryErr.message);
          }

          // Re-poll si le retry a (re)lancé la génération (2500ms x 8)
          if (!createFailed) {
            if (retryParcelId) {
              for (let i = 0; i < 8; i++) {
                await new Promise(r => setTimeout(r, 2500));
                try {
                  const d = await scJson(`${V2}/parcels/${retryParcelId}`, auth);
                  const candidate = d.parcel || d;
                  if (candidate?.label?.label_printer || candidate?.label?.normal_printer?.[0]) {
                    parcel = candidate;
                    console.log("[label] label prête via retry V3 parcel_id:", retryParcelId);
                    break;
                  }
                } catch {}
              }
            } else {
              // Pas de parcel_id renvoyé → poll par order_number
              for (let i = 0; i < 8; i++) {
                await new Promise(r => setTimeout(r, 2500));
                const candidate = await findParcel();
                if (candidate?.label?.label_printer || candidate?.label?.normal_printer?.[0]) {
                  parcel = candidate;
                  break;
                }
              }
            }
            // Retry V3 OK mais étiquette pas encore prête → 202 pending (retry client)
            if (!parcel) {
              return NextResponse.json({
                parcelId: retryParcelId,
                tracking: "",
                carrier: "",
                labelBase64: null,
                labelPending: true,
                error: "Étiquette en cours de génération — réessaie dans 10 secondes",
              }, { status: 202 });
            }
          }
        }

        // ── (B) Fallback V2 direct — UNIQUEMENT pour les prix négatifs ──────
        // V3 rejette les commandes à prix négatifs : seul ce cas justifie de
        // recréer le colis à la main via V2. Pour tout autre échec V3 (ex :
        // point relais) après le retry V3 infructueux, on renvoie une 422 claire.
        if (!parcel && createFailed && negativeDetectedGET === true) {
          console.log("[label] fallback V2 direct pour:", orderNumber, "| prix négatifs");
          try {
            const v2Parcel = await createParcelV2Direct(auth, orderId!, orderNumber!, rawV3, clientShipmentId);
            if (v2Parcel?.label?.label_printer || v2Parcel?.label?.normal_printer?.[0]) {
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
            console.error("[label] V2 fallback échoué:", fallbackErr.message);
            return NextResponse.json({
              error: `Impossible de créer l'étiquette : ${createErrMsg || fallbackErr.message}`,
              hint: fallbackErr.message,
            }, { status: 422 });
          }
        } // fin if (!parcel && createFailed && négatifs)

        // ── (B bis) Autre échec V3 (non négatif) après retry → 422 claire ──
        // On NE tente PAS V2 ici (réservé aux négatifs) : on renvoie le vrai
        // message SendCloud pour aider à corriger (souvent un point relais/adresse).
        if (!parcel && createFailed && negativeDetectedGET === false) {
          console.warn("[label] échec V3 non récupérable (non négatif) pour:", orderNumber, "|", createErrMsg);
          return NextResponse.json({
            error: `Étiquette impossible : ${createErrMsg || "échec SendCloud V3"}`,
            hint: "Vérifie le point relais / l'adresse dans SendCloud",
          }, { status: 422 });
        }

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

    // ── DIAGNOSTIC point relais : cherche les points relais SendCloud autour d'un CP ──
    // Non destructif (lecture seule). Sert à vérifier si le code du fichier (ex 35699)
    // correspond bien à un point relais Mondial Relay retourné par SendCloud, et sous
    // quel format (pour ensuite router l'étiquette vers le bon point).
    // Usage : GET /api/sendcloud?action=sp_search&postal=75004&carrier=mondial_relay&code=35699
    if (action === "sp_search") {
      const postal = searchParams.get("postal") || "";
      const country = (searchParams.get("country") || "FR").toUpperCase();
      const carrier = searchParams.get("carrier") || "mondial_relay";
      const wanted = (searchParams.get("code") || "").trim(); // code MR du fichier (optionnel)
      const radius = searchParams.get("radius") || "20000";   // large pour ne rien rater
      if (!postal) return NextResponse.json({ error: "postal requis (code postal)" }, { status: 400 });

      const url = `https://servicepoints.sendcloud.sc/api/v2/service-points?country=${country}`
        + `&address=${encodeURIComponent(postal)}&radius=${radius}&carrier=${encodeURIComponent(carrier)}`;

      let raw: any;
      try {
        raw = await scJson(url, auth);
      } catch (e: any) {
        // Renvoie l'erreur brute pour diagnostiquer (contrat MR non activé, service points off…)
        return NextResponse.json({ ok: false, url, error: e.message }, { status: 200 });
      }

      const list: any[] = Array.isArray(raw) ? raw : (raw?.service_points || raw?.results || raw?.data || []);
      // On expose les champs utiles pour repérer le code du fichier.
      const points = list.map((sp: any) => ({
        id: sp.id,                                   // ← ID SendCloud (à mettre dans to_service_point)
        code: sp.code,                               // ← code point relais (à comparer avec le fichier)
        carrier_code: sp.carrier_code ?? sp.extra_data?.carrier_code ?? null,
        name: sp.name,
        street: sp.street,
        house_number: sp.house_number,
        postal_code: sp.postal_code,
        city: sp.city,
        carrier: sp.carrier,
      }));

      // Si un code est fourni, on tente de le retrouver (comparaison souple).
      let match: any = null;
      if (wanted) {
        const norm = (s: any) => String(s ?? "").replace(/^0+/, "").replace(/[^0-9a-z]/gi, "").toLowerCase();
        const w = norm(wanted);
        match = points.find((p) =>
          norm(p.code) === w || norm(p.carrier_code) === w ||
          norm(p.code).endsWith(w) || norm(p.carrier_code).endsWith(w)
        ) || null;
      }

      return NextResponse.json({
        ok: true,
        query: { postal, country, carrier, wanted, radius },
        count: points.length,
        matchFound: !!match,
        match,                    // le point qui correspond au code du fichier (ou null)
        points: points.slice(0, 30), // aperçu
      });
    }

    return NextResponse.json({ error: "Actions: parcels, label, debug, sp_search" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`sc-post:${ip}`, 40, 60_000);
  if (!rl.allowed) return NextResponse.json({ error: "Trop de requêtes" }, { status: 429, headers: { "Retry-After": String(Math.ceil(rl.resetIn / 1000)) } });

  const auth = getAuth();
  if (!auth) return NextResponse.json({ error: "Clés SendCloud manquantes" }, { status: 500 });

  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");

  if (action === "label") {
    try {
      const body = await req.json();
      const { order_id: orderId, order_number: orderNumber, order_raw: raw, shipment_id: clientShipmentId } = body;
      if (!orderId || !orderNumber) return NextResponse.json({ error: "order_id et order_number requis" }, { status: 400 });
      // Mémorise si le colis a été créé via le fallback V2 (→ il faut alors
      // sortir l'order V3 de la file SendCloud, que V2 ne consomme pas).
      let createdViaV2 = false;

      // Un colis est "annulé" si son statut le dit (id 1999/2000/2001 ou message "cancel").
      // On ne doit JAMAIS réutiliser un colis annulé : son étiquette est morte.
      const isCancelled = (p: any): boolean => {
        const id = p?.status?.id;
        const msg = String(p?.status?.message || "").toLowerCase();
        return id === 1999 || id === 2000 || id === 2001 || /cancel|annul/.test(msg);
      };

      // ── Helper: chercher un colis existant NON ANNULÉ par order_number ─────
      const findParcel = async (): Promise<any | null> => {
        try {
          const d = await scJson(`${V2}/parcels?order_number=${encodeURIComponent(orderNumber)}`, auth);
          const matches = (d.parcels || []).filter((p: any) => String(p.order_number) === String(orderNumber) && !isCancelled(p));
          // Préfère un colis qui a déjà une étiquette, sinon le plus récent
          const withLabel = matches.find((p: any) => p?.label?.label_printer || p?.label?.normal_printer?.[0]);
          if (withLabel) return withLabel;
          if (matches.length) return matches.sort((a: any, b: any) => (b.id || 0) - (a.id || 0))[0];
        } catch {}
        return null;
      };

      const hasLabel = (p: any) => p?.label?.label_printer || p?.label?.normal_printer?.[0];

      // ── Étape 1 : colis déjà existant avec étiquette ? ───────────────────
      let parcel: any = await findParcel();
      if (parcel && !hasLabel(parcel)) {
        // Colis existant mais sans label → on peut tenter de poll ou de recréer
        // Si async_status = ready alors l'étiquette devrait apparaître bientôt
        const polled = await pollLabel(auth, parcel.id, 6, 2500);
        if (polled) parcel = polled;
        else parcel = null;
      }

      // ── Étape 2 : détecter les prix négatifs AVANT d'appeler V3 ──────────
      // C'est la clé : create-labels-async V3 rejette systématiquement les
      // commandes avec des prix négatifs (lignes de remise). On bypass.
      const negativeDetected = hasNegativeItems(raw);
      if (negativeDetected) {
        console.log("[label POST]", orderNumber, "→ prix négatifs détectés, bypass V3 → V2 direct");
      }

      // ── Étape 3 : création ───────────────────────────────────────────────
      if (!parcel) {
        let asyncParcelId: number | null = null;
        let v3Failed = negativeDetected; // skip V3 d'emblée si négatifs

        // ─── Voie A : V3 create-labels-async (seulement si pas de négatifs) ──
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

          // Poll V3 si OK
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

          // ─── Retry V3 : si échec SANS prix négatifs (ex: point relais dont
          // la résolution prend un léger délai côté SendCloud, comme le 1-clic).
          // On NE bascule PAS en V2 (qui perd le point relais) : on redonne sa
          // chance à V3 avant d'abandonner.
          if (v3Failed && !negativeDetected) {
            console.log("[label POST] retry V3 pour", orderNumber, "(échec initial, pas de négatifs)");
            await new Promise(r => setTimeout(r, 3000));
            let retryParcelId: number | null = null;
            try {
              const retryRes = await scJson(`${V3}/orders/create-labels-async`, auth, {
                method: "POST",
                body: JSON.stringify({ integration_id: INTEGRATION_ID, orders: [{ order_number: orderNumber }] }),
              });
              retryParcelId = retryRes?.data?.[0]?.parcel_id || null;
              v3Failed = false; // le retry a relancé la génération → on ne tombe pas en V2
              console.log("[label POST] retry V3 OK, parcel_id:", retryParcelId);
            } catch (e: any) {
              console.warn("[label POST] retry V3 échoué:", e.message);
            }
            if (!v3Failed) {
              if (retryParcelId) {
                parcel = await pollLabel(auth, retryParcelId, 15, 3000);
              } else {
                for (let i = 0; i < 12; i++) {
                  await new Promise(r => setTimeout(r, 3000));
                  const c = await findParcel();
                  if (c && hasLabel(c)) { parcel = c; break; }
                }
              }
              // Retry V3 OK mais étiquette pas encore prête → 202 (retry client)
              if (!parcel) {
                return NextResponse.json({
                  parcelId: retryParcelId,
                  labelPending: true,
                  error: "Étiquette en cours — réessaie dans 10s",
                }, { status: 202 });
              }
            }
          }
        }

        // ─── Voie B : V2 direct — UNIQUEMENT pour les prix négatifs ──────────
        // (V3 rejette les prix négatifs ; c'est le seul cas qui justifie de
        // recréer le colis à la main. Pour les autres échecs V3, le retry
        // ci-dessus a déjà tranché et on renvoie une erreur claire en bas.)
        if (!parcel && v3Failed && negativeDetected) {
          try {
            const v2Parcel = await createParcelV2Direct(auth, orderId, orderNumber, raw, clientShipmentId);
            if (v2Parcel) {
              console.log("[label POST] V2 direct parcel créé:", v2Parcel.id, "label?", !!hasLabel(v2Parcel));
              createdViaV2 = true;
              // Si label déjà prêt dans la réponse → on prend
              if (hasLabel(v2Parcel)) {
                parcel = v2Parcel;
              } else {
                // sinon on poll par id
                parcel = await pollLabel(auth, v2Parcel.id, 15, 2500);
                if (!parcel) {
                  // colis V2 bien créé mais label pas encore prêt → on ferme déjà
                  // l'order V3 (le colis existe), puis 202 pour retry client
                  await consumeV3Order(auth, orderNumber, orderId);
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
            }
          } catch (v2Err: any) {
            console.error("[label POST] V2 direct échoué:", v2Err.message);
            const msg = v2Err.message || "";
            // On n'affiche le message "point relais" QUE si SendCloud parle vraiment
            // d'un service point manquant. Sinon on montre la vraie erreur SendCloud.
            const isServicePoint = /service.?point/i.test(msg) && /required|blank|not found|invalid|missing/i.test(msg);
            return NextResponse.json({
              error: isServicePoint
                ? `Commande en point relais sans point relais sélectionné — à compléter dans SendCloud avant d'imprimer.`
                : `Étiquette impossible (SendCloud) : ${msg}`,
              hint: msg,
            }, { status: 422 });
          }
        }

        // 202 si V3 OK mais pas encore prête
        if (!parcel && !v3Failed) {
          return NextResponse.json({ parcelId: asyncParcelId, labelPending: true, error: "Étiquette en cours — réessaie dans 10s" }, { status: 202 });
        }

        if (!parcel) {
          // V3 a échoué (et ce n'est pas un cas de prix négatifs traité en V2).
          // Souvent : point relais pas encore résolu côté SendCloud. On invite à
          // réessayer (le retry V3 marche généralement) ou à vérifier la commande.
          return NextResponse.json({
            error: "Étiquette pas encore prête côté SendCloud — réessaie dans quelques secondes. Si ça persiste, vérifie le point relais / l'adresse de la commande dans SendCloud.",
            labelPending: true,
          }, { status: 202 });
        }
      }

      if (!parcel) return NextResponse.json({ error: "Colis introuvable" }, { status: 404 });

      const labelUrl = parcel?.label?.label_printer || parcel?.label?.normal_printer?.[0];
      if (!labelUrl) {
        return NextResponse.json({ parcelId: parcel.id, labelPending: true, error: "Étiquette en cours — réessaie dans quelques secondes" }, { status: 202 });
      }

      const labelRes = await scFetch(labelUrl, auth);
      if (!labelRes.ok) return NextResponse.json({ error: `Erreur PDF: ${labelRes.status}` }, { status: labelRes.status });

      // Si le colis a été créé via le fallback V2, l'order V3 reste "Ouvert" :
      // on le marque fulfilled pour qu'il sorte des commandes ouvertes.
      if (createdViaV2) await consumeV3Order(auth, orderNumber, orderId);

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

  // ─── Liste des méthodes d'envoi (saisie manuelle d'étiquette) ───────────────
  if (action === "shipping_methods") {
    try {
      const body = await req.json().catch(() => ({}));
      const country = String(body.country || "FR").toUpperCase();
      const weight = parseFloat(String(body.weight || "1")) || 1;
      const sm = await scJson(`${V2}/shipping_methods?to_country=${country}&from_country=FR`, auth);
      let methods: any[] = sm.shipping_methods || [];
      // Ne garder que les méthodes compatibles avec le poids saisi
      methods = methods.filter((m: any) => {
        const min = parseFloat(m.min_weight ?? "0");
        const max = parseFloat(m.max_weight ?? "999");
        return weight >= min && weight <= max;
      });
      const list = methods
        .map((m: any) => ({ id: m.id, name: m.name, carrier: m.carrier, min_weight: m.min_weight, max_weight: m.max_weight }))
        .sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));
      return NextResponse.json({ methods: list });
    } catch (e: any) {
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
  }

  // ─── Création d'une étiquette à partir d'une saisie libre ───────────────────
  if (action === "manual_label") {
    try {
      const b = await req.json();
      const name = String(b.name || "").trim();
      const address = String(b.address || "").trim();
      const city = String(b.city || "").trim();
      const postal = String(b.postal_code || "").trim();
      const country = String(b.country || "FR").toUpperCase();
      const email = String(b.email || "").trim();
      const telephone = String(b.telephone || "").trim();
      const weight = Math.max(0.001, parseFloat(String(b.weight || "1")) || 1).toFixed(3);
      const methodId = b.shipping_method_id ? Number(b.shipping_method_id) : null;
      const orderNumber = String(b.order_number || `MANUEL-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Math.floor(Math.random() * 900 + 100)}`);

      if (!name || !address || !city || !postal) {
        return NextResponse.json({ error: "Nom, adresse, code postal et ville sont requis" }, { status: 400 });
      }
      if (!methodId) return NextResponse.json({ error: "Méthode d'envoi requise" }, { status: 400 });

      const payload = {
        parcel: {
          name,
          company_name: String(b.company_name || ""),
          address,
          address_2: String(b.address_2 || ""),
          city,
          postal_code: postal,
          country,
          email,
          telephone,
          weight: String(weight),
          order_number: orderNumber,
          request_label: true,
          shipment: { id: methodId },
        },
      };

      const created = await scJson(`${V2}/parcels`, auth, { method: "POST", body: JSON.stringify(payload) });
      let parcel = created.parcel || created;

      // L'étiquette peut ne pas être prête immédiatement → polling
      if (!(parcel?.label?.label_printer || parcel?.label?.normal_printer?.[0])) {
        parcel = (await pollLabel(auth, parcel.id, 15, 2500)) || parcel;
      }

      const labelUrl = parcel?.label?.label_printer || parcel?.label?.normal_printer?.[0];
      if (!labelUrl) {
        return NextResponse.json({
          parcelId: parcel.id,
          tracking: parcel.tracking_number || "",
          orderNumber,
          labelPending: true,
          error: "Étiquette en cours de génération — réessaie dans quelques secondes",
        }, { status: 202 });
      }

      const labelRes = await scFetch(labelUrl, auth);
      if (!labelRes.ok) return NextResponse.json({ error: `Erreur PDF: ${labelRes.status}` }, { status: labelRes.status });
      const pdfBuffer = Buffer.from(await labelRes.arrayBuffer());
      return NextResponse.json({
        parcelId: parcel.id,
        tracking: parcel.tracking_number || "",
        carrier: parcel.carrier?.code || "",
        orderNumber,
        labelBase64: pdfBuffer.toString("base64"),
      });
    } catch (e: any) {
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "POST: action non supportée" }, { status: 405 });
}
