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

    // Get label PDF for a parcel
    if (action === "label") {
      const orderId = searchParams.get("order_id");
      const orderNumber = searchParams.get("order_number");
      if (!orderId || !orderNumber) return NextResponse.json({ error: "order_id et order_number requis" }, { status: 400 });

      // Adresse passée directement par le client (évite un re-fetch V3 incertain)
      const clientAddr = {
        name: searchParams.get("addr_name") || "",
        address_line_1: searchParams.get("addr_line1") || "",
        house_number: searchParams.get("addr_house") || "",
        city: searchParams.get("addr_city") || "",
        postal_code: searchParams.get("addr_postal") || "",
        country: searchParams.get("addr_country") || "FR",
        email: searchParams.get("addr_email") || "",
        phone: searchParams.get("addr_phone") || "",
        ship_method_id: searchParams.get("ship_method_id") || "",
      };

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

      // Helper: fetch fresh parcel by ID from V2 (always gets latest label URL)
      const fetchParcelById = async (id: number): Promise<any | null> => {
        try {
          const pd = await scJson(`${V2}/parcels/${id}`, auth);
          return pd?.parcel || null;
        } catch { return null; }
      };

      // Helper: poll parcel by ID until label URL is ready (max ~16s)
      const pollParcelById = async (parcelId: number): Promise<any | null> => {
        for (let i = 0; i < 4; i++) {
          await new Promise(r => setTimeout(r, 2000));
          const p = await fetchParcelById(parcelId);
          if (p?.label?.label_printer || p?.label?.normal_printer?.[0]) return p;
        }
        return null;
      };

      // Helper: build & POST a V2 parcel directly (bypasses V3 price validation)
      let v2CreateError = "";
      const createV2Parcel = async (): Promise<any | null> => {
        // Utilise l'adresse passée par le client — pas de re-fetch V3 incertain
        const countryCode = (clientAddr.country || "FR").slice(0, 2).toUpperCase();

        // V2 payload — country doit être une string ISO-2, pas un objet
        const parcelPayload: any = {
          name: clientAddr.name || "Client",
          address: clientAddr.address_line_1,
          house_number: clientAddr.house_number,
          city: clientAddr.city,
          postal_code: clientAddr.postal_code,
          country: countryCode,           // string "FR", pas { iso_2: "FR" }
          email: clientAddr.email,
          telephone: clientAddr.phone,
          weight: "1.000",
          order_number: orderNumber,
          request_label: true,
        };

        const shipMethodId = clientAddr.ship_method_id;
        if (shipMethodId) parcelPayload.shipment = { id: Number(shipMethodId) };

        console.error("[label] createV2 payload:", JSON.stringify(parcelPayload).substring(0, 400));

        try {
          const created = await scJson(`${V2}/parcels`, auth, {
            method: "POST",
            body: JSON.stringify({ parcel: parcelPayload }),
          });
          const p = created?.parcel;
          if (!p) {
            v2CreateError = `V2 unexpected response: ${JSON.stringify(created).substring(0, 200)}`;
            console.error("[label] createV2:", v2CreateError);
          }
          return p || null;
        } catch (e: any) {
          v2CreateError = e.message;
          console.error("[label] createV2: POST error:", e.message);
          return null;
        }
      };

      // ── MAIN FLOW ──────────────────────────────────────────────────────────
      // Step 1: check if parcel already exists in SendCloud
      let parcel: any = await findParcel();
      console.warn("[label] step1 findParcel:", parcel ? `id=${parcel.id} hasLabel=${!!(parcel?.label?.label_printer || parcel?.label?.normal_printer?.[0])}` : "null");

      // If parcel exists, always re-fetch by ID to get the freshest label URL
      if (parcel) {
        const fresh = await fetchParcelById(parcel.id);
        if (fresh) parcel = fresh;
        console.warn("[label] step1 refreshed parcel label:", !!(parcel?.label?.label_printer || parcel?.label?.normal_printer?.[0]));
      }

      // Step 2: if no parcel (or no label), create via V2 directly (bypasses V3 price validation)
      if (!parcel || !(parcel?.label?.label_printer || parcel?.label?.normal_printer?.[0])) {
        console.warn("[label] step2: no valid parcel/label — trying V2 direct creation");
        const v2Parcel = await createV2Parcel();
        if (v2Parcel) {
          // Poll for label if not immediately available
          if (v2Parcel.label?.label_printer || v2Parcel.label?.normal_printer?.[0]) {
            parcel = v2Parcel;
          } else {
            const polled = await pollParcelById(v2Parcel.id);
            parcel = polled || v2Parcel;
            console.warn("[label] step2 poll result:", polled ? "got label" : "no label yet");
          }
        } else {
          // V2 creation failed (parcel may already exist) — search again
          console.warn("[label] step2: V2 failed, last findParcel attempt");
          for (let i = 0; i < 3; i++) {
            await new Promise(r => setTimeout(r, 2000));
            const candidate = await findParcel();
            if (candidate) {
              const fresh = await fetchParcelById(candidate.id);
              parcel = fresh || candidate;
              if (parcel?.label?.label_printer || parcel?.label?.normal_printer?.[0]) break;
            }
          }
        }
      }

      if (!parcel) return NextResponse.json({ error: `Colis non trouvé — ${v2CreateError || "V2 création échouée sans détail"}` }, { status: 404 });

      const labelUrl = parcel?.label?.label_printer || parcel?.label?.normal_printer?.[0];
      console.warn("[label] final labelUrl:", labelUrl ? "present" : "absent", "parcel id:", parcel.id);

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

      // Download label PDF — re-fetch fresh URL if stale
      let labelRes = await scFetch(labelUrl, auth);
      if (!labelRes.ok) {
        console.warn("[label] labelUrl fetch failed:", labelRes.status, "— fetching fresh parcel");
        const freshP = await fetchParcelById(parcel.id);
        const freshUrl = freshP?.label?.label_printer || freshP?.label?.normal_printer?.[0];
        if (freshUrl && freshUrl !== labelUrl) {
          labelRes = await scFetch(freshUrl, auth);
          console.warn("[label] fresh labelUrl fetch:", labelRes.status);
        }
        if (!labelRes.ok) return NextResponse.json({ error: `Erreur téléchargement étiquette: ${labelRes.status}` }, { status: labelRes.status });
      }

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

    // Debug V3 order + V2 parcel pour une commande donnée
    if (action === "probe_order") {
      const orderNumber = searchParams.get("order_number");
      const orderId = searchParams.get("order_id");
      if (!orderNumber) return NextResponse.json({ error: "order_number requis" }, { status: 400 });

      const result: any = { order_number: orderNumber, order_id: orderId };

      // 1. Fetch V3 order
      if (orderId) {
        try {
          const d = await scJson(`${V3}/orders/${orderId}`, auth);
          const od = d?.data || d || {};
          result.v3_order_keys = Object.keys(od);
          result.v3_shipping_address = od.shipping_address || null;
          result.v3_shipping_details = od.shipping_details || null;
          result.v3_order_details = od.order_details || null;
          result.v3_carrier = od.carrier || null;
          result.v3_shipping_method = od.shipping_method || null;
        } catch (e: any) { result.v3_error = e.message; }
      }

      // 2. Search V2 parcel by order_number
      try {
        const pd = await scJson(`${V2}/parcels?order_number=${encodeURIComponent(orderNumber)}`, auth);
        result.v2_parcels_found = (pd.parcels || []).length;
        result.v2_parcels = (pd.parcels || []).map((p: any) => ({
          id: p.id, order_number: p.order_number, status: p.status,
          shipment: p.shipment, has_label: !!(p.label?.label_printer || p.label?.normal_printer?.[0])
        }));
      } catch (e: any) { result.v2_search_error = e.message; }

      // 3. Test V2 POST (dry-run: create without request_label to check validation)
      if (result.v3_shipping_address) {
        const addr = result.v3_shipping_address;
        const sd = result.v3_shipping_details || {};
        const shipMethodId = sd.shipping_method_id || sd.id || result.v3_carrier?.id;
        result.detected_ship_method_id = shipMethodId ?? null;
        result.v2_payload_preview = {
          name: addr.name || addr.company_name || "Client",
          address: addr.address_line_1 || addr.street || "",
          house_number: addr.house_number || "",
          city: addr.city || "",
          postal_code: addr.postal_code || "",
          country: { iso_2: (addr.country_iso_2 || addr.country_code || addr.country || "FR").slice(0, 2).toUpperCase() },
          weight: "1.000",
          order_number: orderNumber,
          shipment: shipMethodId ? { id: shipMethodId } : "MISSING",
        };
      }

      return NextResponse.json(result);
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
  return NextResponse.json({ error: "POST non supporté" }, { status: 405 });
}
