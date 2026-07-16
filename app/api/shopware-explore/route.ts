// app/api/shopware-explore/route.ts — Exploration API Shopware 5 + Pickware + EshaTNT
import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "@/lib/rateLimiter";

// Credentials Shopware : UNIQUEMENT depuis l'environnement serveur.
// (Plus de lecture depuis l'URL → la clé ne transite plus en query param/logs,
//  plus de domaine/user en dur dans un dépôt public.)
function getCreds() {
  return {
    url: process.env.SHOPWARE_URL || "",
    user: process.env.SHOPWARE_USER || "",
    key: process.env.SHOPWARE_API_KEY || "",
  };
}

// Actions qui ÉCRIVENT dans Shopware → exigent le token interne (x-wms-token).
const WRITE_ACTIONS = new Set(["setStock", "binSetStock", "duplicateOrder"]);

async function swFetch(path: string, creds: { url: string; user: string; key: string }, method = "GET", body?: any) {
  const base64 = Buffer.from(`${creds.user}:${creds.key}`).toString("base64");
  // API REST Shopware 5 = <domaine>/api (PAS /backend/api/v1, qui tombe sur le login admin).
  // On retire un éventuel /backend final et le slash, puis on ajoute /api.
  const baseUrl = creds.url.replace(/\/+$/, "").replace(/\/backend$/i, "");
  const url = `${baseUrl}/api${path}`;
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

  // ── Rate limiting : 120 req / 60s par IP ──
  const ip = getClientIp(req);
  const rl = checkRateLimit(`sw:${ip}`, 120, 60_000);
  if (!rl.allowed) {
    return NextResponse.json({ error: "Trop de requêtes" }, { status: 429, headers: { "Retry-After": String(Math.ceil(rl.resetIn / 1000)) } });
  }

  // ── Actions d'écriture : token interne obligatoire ──
  // WMS_WRITE_TOKEN (serveur) doit valoir NEXT_PUBLIC_WMS_TOKEN (client).
  if (WRITE_ACTIONS.has(action)) {
    const expected = process.env.WMS_WRITE_TOKEN || "";
    const received = req.headers.get("x-wms-token") || "";
    if (!expected || received !== expected) {
      return NextResponse.json({ error: "Non autorisé (écriture)" }, { status: 401 });
    }
  }

  const creds = getCreds();
  if (!creds.url || !creds.key) {
    return NextResponse.json({ error: "Shopware non configuré (env serveur)" }, { status: 500 });
  }

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

    // ── dailySales: ventes d'une journée (lecture seule, pour exploration) ──
    // Renvoie les commandes du jour avec leurs lignes (articleNumber, ean, qty, statut).
    if (action === "dailySales") {
      // Plage de dates + heures optionnelles.
      // from/to peuvent être "YYYY-MM-DD" ou "YYYY-MM-DD HH:MM". Heures par défaut : 00:00 → 23:59.
      const single = searchParams.get("date");
      const fromRaw = searchParams.get("from") || single || new Date().toISOString().slice(0, 10);
      const toRaw = searchParams.get("to") || single || fromRaw;
      const fromTime = searchParams.get("fromTime") || ""; // "HH:MM" optionnel
      const toTime = searchParams.get("toTime") || "";
      const start = fromTime ? `${fromRaw} ${fromTime}:00` : (fromRaw.includes(" ") ? fromRaw : `${fromRaw} 00:00:00`);
      const end = toTime ? `${toRaw} ${toTime}:59` : (toRaw.includes(" ") ? toRaw : `${toRaw} 23:59:59`);
      const date = `${start} → ${end}`;
      // Filtre Shopware 5 sur orderTime (>= début ET <= fin)
      const q = `/orders?limit=200`
        + `&filter[0][property]=orderTime&filter[0][expression]=>=&filter[0][value]=${encodeURIComponent(start)}`
        + `&filter[1][property]=orderTime&filter[1][expression]=<=&filter[1][value]=${encodeURIComponent(end)}`
        + `&sort[0][property]=orderTime&sort[0][direction]=ASC`;
      const res = await swFetch(q, creds);
      const r = await safeJson(res);
      if (!r.json) return NextResponse.json({ error: "Non-JSON response", status: r.status, raw: r.raw });
      const list = r.json.data || [];

      // La liste /orders ne contient pas toujours les details → on enrichit chaque commande
      const orders: any[] = [];
      const statusTally: Record<string, number> = {};
      for (const o of list) {
        let details = o.details;
        if (!details) {
          const dRes = await swFetch(`/orders/${o.id}`, creds);
          const dr = await safeJson(dRes);
          details = dr.json?.data?.details || [];
        }
        const st = String(o.orderStatusId);
        statusTally[st] = (statusTally[st] || 0) + 1;
        orders.push({
          id: o.id,
          number: o.number,
          orderStatusId: o.orderStatusId,
          paymentStatusId: o.paymentStatusId,
          dispatchId: o.dispatchId,
          orderTime: o.orderTime,
          lines: (details || []).map((d: any) => ({
            articleNumber: d.articleNumber,
            ean: d.articleDetail?.ean || "",
            name: d.articleName,
            quantity: d.quantity,
            mode: d.mode, // 0 = produit réel ; ≠0 = remise/frais (à ignorer)
          })),
        });
      }
      return NextResponse.json({ date, total: r.json.total, count: orders.length, statusTally, orders });
    }

    // ── orderStatuses: libellés des statuts de commande (pour comprendre 0/5/…) ──
    if (action === "orderStatuses") {
      const res = await swFetch("/orderStatuses?limit=100", creds);
      const r = await safeJson(res);
      if (!r.json) return NextResponse.json({ error: "Non-JSON", status: r.status, raw: r.raw });
      return NextResponse.json({ statuses: (r.json.data || []).map((s: any) => ({ id: s.id, name: s.name, description: s.description })) });
    }

    // ── paymentStatuses: libellés des statuts de paiement ──
    if (action === "paymentStatuses") {
      const res = await swFetch("/paymentStatuses?limit=100", creds);
      const r = await safeJson(res);
      if (!r.json) return NextResponse.json({ error: "Non-JSON", status: r.status, raw: r.raw });
      return NextResponse.json({ statuses: (r.json.data || []).map((s: any) => ({ id: s.id, name: s.name, description: s.description })) });
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

    // ── stockInfo: structure stock d'un article (LECTURE SEULE, diagnostic avant écriture) ──
    // ?articleNumber=429000040  → montre inStock natif + données Pickware
    if (action === "stockInfo") {
      const an = searchParams.get("articleNumber");
      if (!an) return NextResponse.json({ error: "articleNumber requis" }, { status: 400 });
      // 1) Trouver l'article variant par numéro (article.detail)
      const adRes = await swFetch(`/articles?filter[0][property]=mainDetail.number&filter[0][value]=${encodeURIComponent(an)}&limit=1`, creds);
      const adr = await safeJson(adRes);
      // Recherche directe via variants si besoin
      let detail: any = null, article: any = null;
      const data = adr.json?.data;
      if (Array.isArray(data) && data.length) { article = data[0]; detail = data[0]?.mainDetail; }
      // Détail complet de la variante
      if (!detail) {
        const vRes = await swFetch(`/variants/${encodeURIComponent(an)}?useNumberAsId=true`, creds);
        const vr = await safeJson(vRes);
        if (vr.json?.data) { detail = vr.json.data; }
      }
      // NB : l'emplacement (bin location) n'est PAS exposé ici — utiliser action=binInfo.
      return NextResponse.json({
        articleNumber: an,
        found: !!detail,
        native_inStock: detail?.inStock,
        detailId: detail?.id,
        articleId: detail?.articleId || article?.id,
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


    // ── generate: tenter de générer une étiquette TNT pour une commande ──
    // ── activeProducts: liste TOUS les produits actifs avec leur stock (audit catalogue) ──
    if (action === "activeProducts") {
      // Liste des articles actifs. 1re page → total, puis pages suivantes EN PARALLÈLE.
      const pageSize = 500;
      const mapArticle = (a: any) => {
        const md = a.mainDetail || {};
        return { articleId: a.id, detailId: md.id || a.mainDetailId, number: md.number || a.mainDetailId, name: a.name, active: a.active, inStock: md.inStock ?? null };
      };
      const buildUrl = (start: number) => `/articles?filter[0][property]=active&filter[0][value]=1&limit=${pageSize}&start=${start}`;

      const first = await safeJson(await swFetch(buildUrl(0), creds));
      const firstData = first.json?.data || [];
      const total: number = first.json?.total ?? firstData.length;
      const all: any[] = firstData.map(mapArticle);

      if (total > pageSize) {
        // Toutes les pages restantes lancées d'un coup (parallèle).
        const starts: number[] = [];
        for (let s = pageSize; s < total && s < 10000; s += pageSize) starts.push(s);
        const pages = await Promise.all(starts.map(async (s) => safeJson(await swFetch(buildUrl(s), creds))));
        for (const p of pages) for (const a of (p.json?.data || [])) all.push(mapArticle(a));
      }
      return NextResponse.json({ count: all.length, products: all });
    }

    // ── binInfo: emplacement(s) Pickware d'un article (LECTURE) ──
    // ?articleNumber=XXX → { inStock, hasLocation, locations:[{code, stock}] }
    // On retrouve le detailId via /variants, puis on scanne les bin locations
    // (le stock par emplacement est imbriqué dans /ViisonPickwareERPBinLocations/{id}).
    if (action === "binInfo") {
      const an = searchParams.get("articleNumber");
      if (!an) return NextResponse.json({ error: "articleNumber requis" }, { status: 400 });
      // 1) detailId + inStock de la variante
      const vr = await safeJson(await swFetch(`/variants/${encodeURIComponent(an)}?useNumberAsId=true`, creds));
      const detail = vr.json?.data;
      if (!detail) return NextResponse.json({ articleNumber: an, found: false }, { status: 404 });
      const detailId = detail.id;
      // 2) scanner les bin locations (sauf la bin nulle id 1) en parallèle
      const blRes = await safeJson(await swFetch("/ViisonPickwareERPBinLocations?limit=2000", creds));
      const bins = (blRes.json?.data || []).filter((b: any) => b.code !== "pickware_null_bin_location");
      const locations: any[] = [];
      const batchSize = 8;
      for (let i = 0; i < bins.length; i += batchSize) {
        const slice = bins.slice(i, i + batchSize);
        const details = await Promise.all(
          slice.map(async (b: any) => safeJson(await swFetch(`/ViisonPickwareERPBinLocations/${b.id}`, creds)))
        );
        for (const one of details) {
          const d = one.json?.data;
          const maps = d?.articleDetailBinLocationMappings || [];
          for (const m of maps) {
            if (m.articleDetailId === detailId) {
              locations.push({ binLocationId: d.id, code: d.code, stock: m.stock, mappingId: m.id });
            }
          }
        }
      }
      return NextResponse.json({
        articleNumber: an, found: true, detailId,
        inStock: detail.inStock,
        hasLocation: locations.length > 0,
        locations, // emplacements physiques (code + stock)
      });
    }

    // ── binAll: TOUS les emplacements en une fois → map detailId → {code, stock} (LECTURE) ──
    // Permet de précharger les emplacements au lancement de l'audit (1 seul scan).
    if (action === "binAll") {
      const blRes = await safeJson(await swFetch("/ViisonPickwareERPBinLocations?limit=2000", creds));
      const bins = (blRes.json?.data || []).filter((b: any) => b.code !== "pickware_null_bin_location");
      const byDetail: Record<string, { code: string; stock: number }> = {};
      const batchSize = 20; // parallélisme accru (chargement audit plus rapide)
      for (let i = 0; i < bins.length; i += batchSize) {
        const slice = bins.slice(i, i + batchSize);
        const details = await Promise.all(
          slice.map(async (b: any) => safeJson(await swFetch(`/ViisonPickwareERPBinLocations/${b.id}`, creds)))
        );
        for (const one of details) {
          const d = one.json?.data;
          const maps = d?.articleDetailBinLocationMappings || [];
          for (const m of maps) {
            // on garde le 1er emplacement non-nul rencontré pour chaque detailId
            if (!byDetail[m.articleDetailId]) byDetail[m.articleDetailId] = { code: d.code, stock: m.stock };
          }
        }
      }
      return NextResponse.json({ count: Object.keys(byDetail).length, byDetail });
    }

    // ── setStock: ÉCRIT le stock (inStock) d'un article Shopware. ⚠ ÉCRITURE ──
    // ?articleNumber=XXX&qty=N — écrit via la variante (useNumberAsId).
    if (action === "setStock") {
      const an = searchParams.get("articleNumber");
      const qty = searchParams.get("qty");
      if (!an || qty == null) return NextResponse.json({ error: "articleNumber et qty requis" }, { status: 400 });
      const n = parseInt(qty, 10);
      if (isNaN(n) || n < 0) return NextResponse.json({ error: "qty invalide" }, { status: 400 });
      // Lecture avant (pour confirmer le changement)
      const beforeRes = await swFetch(`/variants/${encodeURIComponent(an)}?useNumberAsId=true`, creds);
      const before = (await safeJson(beforeRes)).json?.data;
      if (!before) return NextResponse.json({ error: `Article ${an} introuvable` }, { status: 404 });
      const oldStock = before.inStock;
      // Écriture
      const putRes = await swFetch(`/variants/${encodeURIComponent(an)}?useNumberAsId=true`, creds, "PUT", { inStock: n });
      const putR = await safeJson(putRes);
      if (!putR.ok) return NextResponse.json({ error: `Échec écriture (${putR.status})`, raw: putR.raw }, { status: putR.status });
      // Relecture
      const afterRes = await swFetch(`/variants/${encodeURIComponent(an)}?useNumberAsId=true`, creds);
      const after = (await safeJson(afterRes)).json?.data;
      return NextResponse.json({ ok: true, articleNumber: an, oldStock, requested: n, newStock: after?.inStock });
    }

    // ── duplicateOrder: recrée une commande (renvoi gratuit) à partir d'une commande existante. ⚠ ÉCRITURE ──
    // ?number=20001 — copie client + adresses + lignes produit de la commande source, montant à 0€
    // (invoiceAmount/invoiceShipping = 0), paymentStatusId=12 (payée) pour que ça remonte normalement
    // dans le flux e-shop du WMS. La nouvelle commande a un NOUVEAU numéro Shopware généré par Shopware.
    if (action === "duplicateOrder") {
      const number = searchParams.get("number");
      if (!number) return NextResponse.json({ error: "number requis" }, { status: 400 });

      // 1) Retrouver la commande source par numéro.
      const searchRes = await swFetch(
        `/orders?filter[0][property]=number&filter[0][value]=${encodeURIComponent(number)}&limit=1`,
        creds
      );
      const searchR = await safeJson(searchRes);
      if (!searchR.json?.data?.length) {
        return NextResponse.json({ error: `Commande ${number} introuvable`, raw: searchR.raw }, { status: 404 });
      }
      const orderId = searchR.json.data[0].id;

      // 2) Détail complet (lignes, client, adresses).
      const detailRes = await swFetch(`/orders/${orderId}`, creds);
      const detailR = await safeJson(detailRes);
      const src = detailR.json?.data;
      if (!src) return NextResponse.json({ error: "Détail commande introuvable", raw: detailR.raw }, { status: 404 });

      // Lignes produit réelles uniquement (mode 0 = article normal ; on exclut les frais/remises mode 4,
      // sinon on redemande de la port/remise sans raison sur un renvoi gratuit).
      const details = (src.details || [])
        .filter((d: any) => d.mode === 0)
        .map((d: any) => ({
          articleId: d.articleId,
          taxId: d.taxId,
          taxRate: d.taxRate,
          statusId: 0,
          articleNumber: d.articleNumber,
          price: 0,
          quantity: d.quantity,
          articleName: d.articleName,
          shipped: 0,
          shippedGroup: 0,
          mode: 0,
          esdArticle: d.esdArticle || 0,
        }));
      if (!details.length) return NextResponse.json({ error: "Aucune ligne article à dupliquer (commande vide ?)" }, { status: 400 });

      const stripAddr = (a: any) => a ? ({
        countryId: a.countryId, stateId: a.stateId, customerId: a.customerId,
        company: a.company || "", department: a.department || "", salutation: a.salutation || "mr",
        firstName: a.firstName, lastName: a.lastName, street: a.street,
        zipCode: a.zipCode, city: a.city, phone: a.phone || "", additionalAddressLine1: a.additionalAddressLine1 || "",
        additionalAddressLine2: a.additionalAddressLine2 || "",
      }) : undefined;

      const payload: any = {
        customerId: src.customerId,
        paymentId: src.paymentId,
        dispatchId: src.dispatchId,
        partnerId: src.partnerId || "",
        shopId: src.shopId || 1,
        invoiceAmount: 0,
        invoiceAmountNet: 0,
        invoiceShipping: 0,
        invoiceShippingNet: 0,
        orderTime: new Date().toISOString().slice(0, 19).replace("T", " "),
        net: src.net || 0,
        taxFree: src.taxFree || 0,
        languageIso: src.languageIso || "1",
        currency: src.currency || "EUR",
        currencyFactor: src.currencyFactor || 1,
        remoteAddress: "",
        details,
        documents: [],
        billing: stripAddr(src.billing),
        shipping: stripAddr(src.shipping || src.billing),
        paymentStatusId: 12, // payée — pour remonter normalement dans le flux e-shop (renvoi gratuit)
        orderStatusId: 0,
        // Shopware génère lui-même le "number" (impossible à forcer via l'API) — on rend la
        // traçabilité explicite dans le commentaire interne + trackingCode, visibles dans le backend.
        internalComment: `RENVOI GRATUIT — duplicata de la commande ${src.number}`,
        comment: `Renvoi (copie de ${src.number})`,
      };

      const createRes = await swFetch(`/orders`, creds, "POST", payload);
      const createR = await safeJson(createRes);
      if (!createR.ok) {
        return NextResponse.json({ error: `Échec création (${createR.status})`, raw: createR.raw, json: createR.json }, { status: createR.status || 500 });
      }
      // La réponse de création peut varier selon la version (id à la racine, ou dans .data).
      const newOrderId = createR.json?.id ?? createR.json?.data?.id ?? null;

      // Relecture pour récupérer le VRAI numéro de commande Shopware (généré par Shopware,
      // différent de l'id interne) — c'est ce numéro qui sert à retrouver la commande dans
      // Shopware / SendCloud.
      let newOrderNumber: string | null = null;
      if (newOrderId) {
        try {
          const rereadRes = await swFetch(`/orders/${newOrderId}`, creds);
          const rereadR = await safeJson(rereadRes);
          newOrderNumber = rereadR.json?.data?.number ?? null;
        } catch { /* non bloquant */ }
      }

      return NextResponse.json({
        ok: true,
        sourceNumber: src.number,
        newOrderId,
        newOrderNumber,
        raw: newOrderId ? undefined : createR.json, // debug si l'id n'a pas été trouvé
      });
    }

    return NextResponse.json({ error: "actions: ping, orders, dispatches, order, pickware" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
