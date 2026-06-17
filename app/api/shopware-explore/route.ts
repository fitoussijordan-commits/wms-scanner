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
      // Détail complet de la variante (contient binLocationMappings)
      if (!detail) {
        const vRes = await swFetch(`/variants/${encodeURIComponent(an)}?useNumberAsId=true`, creds);
        const vr = await safeJson(vRes);
        if (vr.json?.data) { detail = vr.json.data; }
      } else if (detail?.number) {
        // on a l'article mais on veut le détail complet de la variante (bin locations)
        const vRes = await swFetch(`/variants/${encodeURIComponent(detail.number)}?useNumberAsId=true`, creds);
        const vr = await safeJson(vRes);
        if (vr.json?.data) detail = vr.json.data;
      }
      // Extraire les bin locations (binLocationMappings) avec leur nom
      const binMaps = detail?.binLocationMappings || [];
      const bins = (Array.isArray(binMaps) ? binMaps : []).map((b: any) => ({
        id: b.binLocationId ?? b.id,
        code: b.binLocation?.code ?? b.code ?? null,
        stock: b.stock ?? null,
      }));
      return NextResponse.json({
        articleNumber: an,
        found: !!detail,
        native_inStock: detail?.inStock,
        detailId: detail?.id,
        articleId: detail?.articleId || article?.id,
        bins,                              // emplacements + stock
        binLocationMappings: binMaps,      // brut, pour comprendre la structure
        detailKeys: detail ? Object.keys(detail) : [],
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
    // ── activeProducts: liste TOUS les produits actifs avec leur stock (audit catalogue) ──
    if (action === "activeProducts") {
      // Liste des articles actifs (paginée). On récupère les variants pour avoir number + inStock.
      const all: any[] = [];
      const pageSize = 500;
      let start = 0;
      for (let page = 0; page < 20; page++) { // garde-fou 10000 max
        const url = `/articles?filter[0][property]=active&filter[0][value]=1&limit=${pageSize}&start=${start}`;
        const r = await safeJson(await swFetch(url, creds));
        const data = r.json?.data || [];
        if (!data.length) break;
        for (const a of data) {
          // mainDetail contient number + inStock
          const md = a.mainDetail || {};
          all.push({
            articleId: a.id,
            number: md.number || a.mainDetailId,
            name: a.name,
            active: a.active,
            inStock: md.inStock ?? null,
          });
        }
        if (data.length < pageSize) break;
        start += pageSize;
      }
      return NextResponse.json({ count: all.length, products: all });
    }

    // ── binList: liste rapide des bin locations (id + code) ──
    if (action === "binList") {
      const blRes = await safeJson(await swFetch("/ViisonPickwareERPBinLocations?limit=2000", creds));
      const bins = (blRes.json?.data || []).map((b: any) => ({ id: b.id, code: b.code, warehouseId: b.warehouseId }));
      return NextResponse.json({ count: bins.length, bins });
    }

    // ── binFindMapping: retrouve le(s) mapping(s) bin d'un detailId (LECTURE, parallèle) ──
    if (action === "binFindMapping") {
      const detailId = parseInt(searchParams.get("detailId") || "0", 10);
      if (!detailId) return NextResponse.json({ error: "detailId requis" }, { status: 400 });
      // 1) lister les bin locations
      const blRes = await safeJson(await swFetch("/ViisonPickwareERPBinLocations?limit=2000", creds));
      const bins = blRes.json?.data || [];
      const found: any[] = [];
      // 2) charger les détails EN PARALLÈLE par lots de 8
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
              found.push({
                binLocationId: d.id, binCode: d.code, warehouseId: d.warehouseId,
                mappingId: m.id, stock: m.stock, reservedStock: m.reservedStock,
                defaultMapping: m.defaultMapping,
              });
            }
          }
        }
        if (found.length) break; // on s'arrête dès qu'on a trouvé
      }
      return NextResponse.json({ detailId, binsScanned: bins.length, mappings: found });
    }

    // ── binSetStock: écrit le stock d'un detailId dans une bin (ÉCRITURE, confirm requis) ──
    if (action === "binSetStock") {
      const binLocationId = parseInt(searchParams.get("binLocationId") || "0", 10);
      const detailId = parseInt(searchParams.get("detailId") || "0", 10);
      const newStock = parseInt(searchParams.get("stock") || "NaN", 10);
      const confirm = searchParams.get("confirm") === "1";
      if (!binLocationId || !detailId || Number.isNaN(newStock)) {
        return NextResponse.json({ error: "binLocationId, detailId et stock requis" }, { status: 400 });
      }
      // 1) charger la bin location complète
      const one = await safeJson(await swFetch(`/ViisonPickwareERPBinLocations/${binLocationId}`, creds));
      if (!one.json?.data) return NextResponse.json({ error: "bin introuvable", raw: one.raw }, { status: 404 });
      const data = one.json.data;
      const maps = data.articleDetailBinLocationMappings || [];
      const target = maps.find((m: any) => m.articleDetailId === detailId);
      if (!target) return NextResponse.json({ error: "mapping introuvable pour ce detailId dans cette bin" }, { status: 404 });
      const oldStock = target.stock;
      // 2) construire le payload : on ne touche QUE le stock du mapping ciblé
      // Chaque mapping doit garder id + binLocationId + articleDetailId pour être traité
      // comme une MISE À JOUR (sinon Pickware tente de recréer la sous-ressource).
      const newMaps = maps.map((m: any) => ({
        id: m.id,
        binLocationId: m.binLocationId,
        articleDetailId: m.articleDetailId,
        stock: m.articleDetailId === detailId ? newStock : m.stock,
      }));
      // On n'envoie QUE les mappings (pas code/warehouseId, sinon "A12 existe déjà").
      const payload = { articleDetailBinLocationMappings: newMaps };
      if (!confirm) {
        // DRY-RUN : on montre exactement ce qui serait envoyé, sans écrire
        return NextResponse.json({
          dryRun: true, binLocationId, detailId, mappingId: target.id,
          oldStock, requested: newStock, payloadPreview: payload,
          note: "Ajoute &confirm=1 pour écrire réellement.",
        });
      }
      // 3) ÉCRITURE
      const put = await safeJson(await swFetch(`/ViisonPickwareERPBinLocations/${binLocationId}`, creds, "PUT", payload));
      // 4) relire pour vérifier
      const after = await safeJson(await swFetch(`/ViisonPickwareERPBinLocations/${binLocationId}`, creds));
      const afterMap = (after.json?.data?.articleDetailBinLocationMappings || []).find((m: any) => m.articleDetailId === detailId);
      return NextResponse.json({
        ok: put.ok, status: put.status, binLocationId, detailId, mappingId: target.id,
        oldStock, requested: newStock, newStock: afterMap?.stock ?? null,
        putRaw: put.raw, putResp: put.json,
      });
    }

    // ── binProbe5: confirmer l'endpoint du MAPPING (lecture par id) ──
    if (action === "binProbe5") {
      const results: any = {};
      const mappingId = searchParams.get("mappingId") || "64";
      const paths = [
        `/ViisonPickwareERPArticleDetailBinLocationMappings/${mappingId}`,
        `/ViisonPickwareERPArticleDetailBinLocationMappings?limit=2`,
        `/ViisonPickwareERPArticleDetailBinLocationMapping/${mappingId}`,
      ];
      for (const p of paths) {
        try {
          const r = await safeJson(await swFetch(p, creds));
          results[p] = { status: r.status, ok: r.ok };
          if (r.ok && r.json) results[p].sample = r.json.data ?? r.json;
          else results[p].raw = r.raw?.substring(0, 120);
        } catch (e: any) { results[p] = { error: e.message }; }
      }
      return NextResponse.json(results);
    }

    // ── binProbe4: derniers essais (singulier, import, stocking) ──
    if (action === "binProbe4") {
      const results: any = {};
      const paths = [
        "/ViisonPickwareERPWarehouse?limit=2",
        "/ViisonPickwareERPBinLocation?limit=2",
        "/ViisonPickwareERPStockings?limit=2",
        "/ViisonPickwareERPStocking?limit=2",
        "/ViisonPickwareERPGoodsIncoming?limit=2",
        "/ViisonPickwareERPGoodsIncomings?limit=2",
        "/ViisonPickwareERPStockTaking?limit=2",
        "/ViisonPickwareERPStockTakings?limit=2",
        "/ViisonPickwareERPSupplierOrders?limit=2",
        "/ViisonPickwareERPArticleConfigurations?limit=2",
        // bin location précise (id 1 vu précédemment) — voit-on le stock dedans ?
        "/ViisonPickwareERPBinLocations/1",
        "/ViisonPickwareERPWarehouses/1",
      ];
      for (const p of paths) {
        try {
          const r = await safeJson(await swFetch(p, creds));
          results[p] = { status: r.status, ok: r.ok };
          if (r.ok && r.json) results[p].sample = r.json.data ?? r.json;
        } catch (e: any) { results[p] = { error: e.message }; }
      }
      return NextResponse.json(results);
    }

    // ── binProbe3: trouver l'endpoint du STOCK par article/bin (Viison) ──
    if (action === "binProbe3") {
      const results: any = {};
      const paths = [
        "/ViisonPickwareERPStock?limit=3",
        "/ViisonPickwareERPArticleStock?limit=3",
        "/ViisonPickwareERPWarehouseStocks?limit=3",
        "/ViisonPickwareERPStockLedgerEntries?limit=3",
        "/ViisonPickwareERPStockLedgerEntry?limit=3",
        "/ViisonPickwareERPBinLocationStocks?limit=3",
        "/ViisonPickwareERPBinLocationStock?limit=3",
        "/ViisonPickwareERPArticleDetailStocks?limit=3",
        "/ViisonPickwareERPStockChanges?limit=3",
        "/ViisonPickwareERPStockingProcesses?limit=3",
        "/ViisonPickwareERPArticleDetailWarehouseConfigurations?limit=3",
        "/ViisonPickwareERPArticleBinLocationMappings?limit=3",
      ];
      for (const p of paths) {
        try {
          const r = await safeJson(await swFetch(p, creds));
          results[p] = { status: r.status, ok: r.ok };
          if (r.ok && r.json) results[p].sample = (r.json.data || []).slice(0, 1);
        } catch (e: any) { results[p] = { error: e.message }; }
      }
      return NextResponse.json(results);
    }

    // ── binProbe2: autres noms d'endpoints possibles pour stock par emplacement ──
    if (action === "binProbe2") {
      const an = searchParams.get("articleNumber") || "429000040";
      const results: any = {};
      const paths = [
        "/ViisonPickwareERPArticleStocks?limit=3",
        "/ViisonPickwareERPWarehouses?limit=10",
        "/ViisonPickwareERPBinLocations?limit=10",
        "/ViisonPickwareERPStocks?limit=3",
        "/articleStocks?limit=3",
        "/binLocations?limit=10",
        "/pickwareErpStocks?limit=3",
        "/PickwareErpArticleStock?limit=3",
        "/stocks?limit=3",
        // détail article complet (peut contenir mainDetail.binLocationMappings)
        `/articles?filter[0][property]=number&filter[0][value]=${encodeURIComponent(an)}`,
      ];
      for (const p of paths) {
        try {
          const r = await safeJson(await swFetch(p, creds));
          results[p] = { status: r.status, ok: r.ok };
          if (r.ok && r.json) {
            // pour l'article complet, on cherche les clés liées au stock/bin
            const d = r.json.data;
            results[p].sample = Array.isArray(d) ? d.slice(0, 1) : d;
          } else results[p].raw = r.raw?.substring(0, 150);
        } catch (e: any) { results[p] = { error: e.message }; }
      }
      return NextResponse.json(results);
    }

    // ── binStockProbe: explore l'API Pickware ERP stock/bin location (LECTURE) ──
    // ?articleNumber=429000040 — teste plusieurs endpoints et renvoie ce qui répond.
    if (action === "binStockProbe") {
      const an = searchParams.get("articleNumber") || "";
      const results: any = {};
      const paths = [
        "/PickwareErpWarehouses?limit=50",
        "/pickware-erp/warehouses?limit=50",
        "/PickwareErpBinLocations?limit=20",
        "/pickware-erp/binLocations?limit=20",
        "/PickwareErpStocks?limit=5",
        "/pickware-erp/stocks?limit=5",
        "/PickwareErpWarehouseStocks?limit=5",
        "/pickware-erp/stockLedgerEntries?limit=5",
        "/PickwareErpStockLedgerEntries?limit=5",
        an ? `/PickwareErpStocks?filter[0][property]=article.number&filter[0][value]=${encodeURIComponent(an)}&limit=10` : "",
      ].filter(Boolean);
      for (const p of paths) {
        try {
          const r = await safeJson(await swFetch(p, creds));
          results[p] = { status: r.status, ok: r.ok };
          if (r.json) results[p].sample = r.json; else results[p].raw = r.raw?.substring(0, 200);
        } catch (e: any) { results[p] = { error: e.message }; }
      }
      return NextResponse.json(results);
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
