"use client";
// components/ReturnsScreen.tsx — Gestion des retours WH/RET/

import { useState, useEffect, useCallback } from "react";
import * as odoo from "@/lib/odoo";
import type { OdooSession } from "@/lib/odoo";

// ── Palette de couleurs (reprend le thème WMS) ─────────────────────────────
const C = {
  bg:          "#f9fafb",
  card:        "#ffffff",
  border:      "#e5e7eb",
  primary:     "#2563eb",
  danger:      "#ef4444",
  success:     "#059669",
  warning:     "#f59e0b",
  orange:      "#ea580c",
  text:        "#111827",
  textMuted:   "#6b7280",
  labelBg:     "#eff6ff",
  labelText:   "#1d4ed8",
  retBg:       "#fef3c7",
  retText:     "#92400e",
};

interface ReturnLine {
  moveId:        number;
  moveLineId:    number | null;
  productId:     number;
  productName:   string;
  productRef:    string;
  lotId:         number | null;
  lotName:       string;
  demandQty:     number;
  doneQty:       number;
  uomName:       string;
}

interface ReturnPicking {
  id:               number;
  name:             string;
  state:            string;
  origin:           string;
  partnerId:        number | null;
  partnerName:      string;
  date:             string;
  locationDestId:   number;    // où les produits atterrissent après validation du retour
  locationDestName: string;
  lines:            ReturnLine[];
}

interface TransferResult {
  pickingId:   number;
  pickingName: string;
  lines:       { productName: string; qty: number; destLoc: string }[];
}

interface Props {
  session: OdooSession;
  onBack:  () => void;
  onToast: (msg: string, type?: "success" | "error" | "info") => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export default function ReturnsScreen({ session, onBack, onToast }: Props) {
  const [loading,      setLoading]      = useState(true);
  const [returns,      setReturns]      = useState<ReturnPicking[]>([]);
  const [selected,     setSelected]     = useState<ReturnPicking | null>(null);
  const [qtyEdits,     setQtyEdits]     = useState<Record<number, string>>({}); // moveId → qty string
  const [validating,   setValidating]   = useState(false);
  const [transferDone, setTransferDone] = useState<TransferResult | null>(null);
  const [error,        setError]        = useState("");
  const [scanCode,     setScanCode]     = useState("");
  const [scanError,    setScanError]    = useState("");

  // ── Load returns ────────────────────────────────────────────────────────────
  const loadReturns = useCallback(async (): Promise<ReturnPicking[]> => {
    setLoading(true);
    setError("");
    try {
      // 1. Find WH/RET/ picking type
      let typeIds: number[] = [];

      // Try by sequence_code first
      const bySeq = await odoo.searchRead(
        session, "stock.picking.type",
        [["sequence_code", "ilike", "RET"]],
        ["id", "name", "sequence_code", "code"], 20
      );
      typeIds = bySeq
        .filter((t: any) => t.sequence_code?.toUpperCase().includes("RET"))
        .map((t: any) => t.id);

      // Fallback: search by name containing RET
      if (!typeIds.length) {
        const byName = await odoo.searchRead(
          session, "stock.picking.type",
          [["name", "ilike", "retour"]],
          ["id", "name"], 10
        );
        typeIds = byName.map((t: any) => t.id);
      }

      if (!typeIds.length) {
        setError("Aucun type d'opération retour (WH/RET/) trouvé dans Odoo.");
        setLoading(false);
        return [];
      }

      // 2. Load pickings
      const pickings = await odoo.searchRead(
        session, "stock.picking",
        [
          ["picking_type_id", "in", typeIds],
          ["state", "in", ["confirmed", "assigned", "waiting", "partially_available"]],
        ],
        ["id", "name", "state", "origin", "partner_id", "scheduled_date", "date", "move_ids_without_package", "location_id", "location_dest_id"],
        100,
        "scheduled_date asc, id desc"
      );

      if (!pickings.length) {
        setReturns([]);
        setLoading(false);
        return [];
      }

      // 3. Load moves for all pickings
      const pickingIds = pickings.map((p: any) => p.id);
      const moves = await odoo.searchRead(
        session, "stock.move",
        [["picking_id", "in", pickingIds], ["state", "!=", "cancel"]],
        ["id", "picking_id", "product_id", "product_uom_qty", "quantity_done", "product_uom", "move_line_ids"],
        500
      );

      // 4. Load move lines
      const moveIds = moves.map((m: any) => m.id);
      const moveLines = moveIds.length
        ? await odoo.searchRead(
            session, "stock.move.line",
            [["move_id", "in", moveIds]],
            ["id", "move_id", "product_id", "lot_id", "reserved_uom_qty", "qty_done", "product_uom_id"],
            500
          )
        : [];

      // 5. Get product refs
      const productIds = Array.from(new Set(moves.map((m: any) => m.product_id[0]))) as number[];
      const products = productIds.length
        ? await odoo.searchRead(
            session, "product.product",
            [["id", "in", productIds]],
            ["id", "default_code"],
            productIds.length
          )
        : [];
      const refMap: Record<number, string> = {};
      for (const p of products) refMap[p.id] = p.default_code || "";

      // 6. Build ReturnPicking objects
      const mlByMove: Record<number, any[]> = {};
      for (const ml of moveLines) {
        const mid = Array.isArray(ml.move_id) ? ml.move_id[0] : ml.move_id;
        if (!mlByMove[mid]) mlByMove[mid] = [];
        mlByMove[mid].push(ml);
      }

      const movesByPicking: Record<number, any[]> = {};
      for (const m of moves) {
        const pid = Array.isArray(m.picking_id) ? m.picking_id[0] : m.picking_id;
        if (!movesByPicking[pid]) movesByPicking[pid] = [];
        movesByPicking[pid].push(m);
      }

      const result: ReturnPicking[] = pickings.map((p: any) => {
        const pMoves = movesByPicking[p.id] || [];
        const lines: ReturnLine[] = [];

        for (const m of pMoves) {
          const productId   = m.product_id[0];
          const productName = m.product_id[1] || "";
          const mls = mlByMove[m.id] || [];

          if (mls.length > 0) {
            // One line per move line (lot tracking)
            for (const ml of mls) {
              lines.push({
                moveId:      m.id,
                moveLineId:  ml.id,
                productId,
                productName,
                productRef:  refMap[productId] || "",
                lotId:       ml.lot_id ? ml.lot_id[0] : null,
                lotName:     ml.lot_id ? ml.lot_id[1] : "",
                demandQty:   ml.reserved_uom_qty || m.product_uom_qty || 0,
                doneQty:     ml.qty_done || 0,
                uomName:     Array.isArray(m.product_uom) ? m.product_uom[1] : "Unité(s)",
              });
            }
          } else {
            // No move lines yet
            lines.push({
              moveId:      m.id,
              moveLineId:  null,
              productId,
              productName,
              productRef:  refMap[productId] || "",
              lotId:       null,
              lotName:     "",
              demandQty:   m.product_uom_qty || 0,
              doneQty:     m.quantity_done || 0,
              uomName:     Array.isArray(m.product_uom) ? m.product_uom[1] : "Unité(s)",
            });
          }
        }

        return {
          id:               p.id,
          name:             p.name,
          state:            p.state,
          origin:           p.origin || "",
          partnerId:        p.partner_id ? p.partner_id[0] : null,
          partnerName:      p.partner_id ? p.partner_id[1] : "",
          date:             p.scheduled_date || p.date || "",
          locationDestId:   Array.isArray(p.location_dest_id) ? p.location_dest_id[0] : (p.location_dest_id || 0),
          locationDestName: Array.isArray(p.location_dest_id) ? (p.location_dest_id[1] || "") : "",
          lines,
        };
      });

      setReturns(result);
      return result;
    } catch (e: any) {
      setError(e.message);
      return [];
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => { loadReturns(); }, [loadReturns]);

  // ── Open a return ───────────────────────────────────────────────────────────
  const openReturn = (ret: ReturnPicking) => {
    setSelected(ret);
    setTransferDone(null);
    setError("");
    // Pre-fill qty edits with demandQty
    const edits: Record<number, string> = {};
    for (const l of ret.lines) {
      edits[l.moveLineId ?? l.moveId] = String(l.demandQty);
    }
    setQtyEdits(edits);
  };

  // ── Validate return + create internal transfer ──────────────────────────────
  const validateReturn = async () => {
    if (!selected) return;
    setValidating(true);
    setError("");
    try {
      // 1. Set qty_done on each move line
      for (const line of selected.lines) {
        const key   = line.moveLineId ?? line.moveId;
        const qty   = parseFloat(qtyEdits[key] ?? String(line.demandQty));
        const safeQty = isNaN(qty) ? line.demandQty : qty;

        if (line.moveLineId) {
          // Write qty_done on existing move line
          await odoo.write(session, "stock.move.line", [line.moveLineId], { qty_done: safeQty });
        } else {
          // No move line — write quantity_done on stock.move (triggers line creation)
          await odoo.write(session, "stock.move", [line.moveId], { quantity_done: safeQty });
        }
      }

      // 2. Validate the return picking
      await odoo.validatePicking(session, selected.id);

      // 3. Batch-fetch UOM for all moves (single request — no per-line loop)
      const allMoveIds = Array.from(new Set(selected.lines.map(l => l.moveId)));
      const movesForUom = allMoveIds.length
        ? await odoo.searchRead(session, "stock.move", [["id", "in", allMoveIds]], ["id", "product_uom"], allMoveIds.length)
        : [];
      const uomByMoveId: Record<number, number> = {};
      for (const m of movesForUom) {
        uomByMoveId[m.id] = Array.isArray(m.product_uom) ? m.product_uom[0] : (m.product_uom || 1);
      }

      // Build transfer lines
      const transferLines: { productId: number; productName: string; qty: number; uomId: number; lotId?: number | null }[] = [];
      for (const line of selected.lines) {
        const key     = line.moveLineId ?? line.moveId;
        const qty     = parseFloat(qtyEdits[key] ?? String(line.demandQty));
        const safeQty = isNaN(qty) ? line.demandQty : qty;
        if (safeQty <= 0) continue;

        transferLines.push({
          productId:   line.productId,
          productName: line.productName,
          qty:         safeQty,
          uomId:       uomByMoveId[line.moveId] ?? 1,
          lotId:       line.lotId || null,
        });
      }

      if (!transferLines.length) {
        onToast("Retour validé (aucune ligne à transférer)", "success");
        setSelected(null);
        loadReturns();
        setValidating(false);
        return;
      }

      // 4. Source = location_dest_id of the return picking itself (the sortie/output zone
      //    where products land after the customer return is validated)
      const sourceLocId   = selected.locationDestId;
      const sourceLocName = selected.locationDestName;
      if (!sourceLocId) throw new Error("Emplacement source du retour introuvable (location_dest_id manquant).");

      // 5. Find original storage locations per product (from the original order's PICK picking)
      const productIds = Array.from(new Set(transferLines.map(l => l.productId)));
      const origLocMap = await findOriginalLocations(selected.origin, productIds);

      // 6. Fallback: where the product currently has the most stock (excluding sortie zones)
      const currentLocMap = Object.keys(origLocMap).length < productIds.length
        ? await odoo.getProductLocations(session, productIds)
        : {};

      // 7. Default fallback location (WH/Stock)
      const stockLoc = await findDefaultStockLocation();

      // 8. Build enriched lines with per-product destination
      const enrichedLines = transferLines.map(line => {
        const orig    = origLocMap[line.productId];
        const current = currentLocMap[line.productId];
        const destId  = orig?.location_id   ?? current?.location_id   ?? stockLoc.id;
        const destNm  = orig?.location_name ?? current?.location_name ?? stockLoc.name;
        return { ...line, destLocationId: destId, destLocationName: destNm };
      });

      // 9. Un seul transfert interne pour tous les produits (destinations différentes par move)
      const pickingId = await odoo.createMultiDestTransfer(
        session,
        sourceLocId,
        stockLoc.id,
        enrichedLines
      );

      // Get picking name
      const [pick] = await odoo.searchRead(
        session, "stock.picking",
        [["id", "=", pickingId]],
        ["name"],
        1
      );
      const pickingName = pick?.name || `INT-${pickingId}`;

      // Auto-valider le transfert interne
      try {
        await odoo.validatePicking(session, pickingId);
      } catch (e: any) {
        console.warn(`Auto-validation ${pickingName} échouée:`, e.message);
      }

      const merged: TransferResult = {
        pickingId,
        pickingName,
        lines: enrichedLines.map(l => ({ productName: l.productName, qty: l.qty, destLoc: l.destLocationName })),
      };

      setTransferDone(merged);
      onToast(`✅ Retour validé — ${merged.pickingName} validé automatiquement`, "success");
      loadReturns();
    } catch (e: any) {
      setError(e.message);
      onToast("Erreur : " + e.message, "error");
    } finally {
      setValidating(false);
    }
  };

  // ── Find original storage locations from the originating order ─────────────
  // Traces: RET origin → OUT picking → group_id → done PICK pickings → move lines → source location per product
  const findOriginalLocations = async (
    origin: string,
    productIds: number[]
  ): Promise<Record<number, { location_id: number; location_name: string }>> => {
    const result: Record<number, { location_id: number; location_name: string }> = {};
    if (!origin || !productIds.length) return result;

    // Strip "Return of " prefix (Odoo sets origin = "Return of WH/OUT/XXXXX")
    const outName = origin.replace(/^Return\s+of\s+/i, "").trim();
    if (!outName) return result;

    // Find the OUT picking by name
    const outPickings = await odoo.searchRead(
      session, "stock.picking",
      [["name", "=", outName]],
      ["id", "name", "group_id"],
      1
    );
    if (!outPickings.length) return result;

    const groupIdVal = outPickings[0].group_id;
    const groupId: number | null = Array.isArray(groupIdVal) ? groupIdVal[0] : (groupIdVal || null);
    if (!groupId) return result;

    // Find done PICK (internal) pickings in the same procurement group
    const pickPickings = await odoo.searchRead(
      session, "stock.picking",
      [["group_id", "=", groupId], ["state", "=", "done"], ["picking_type_code", "=", "internal"]],
      ["id"],
      20
    );
    if (!pickPickings.length) return result;

    const pickPickingIds = pickPickings.map((p: any) => p.id);

    // Get done move lines — location_id = where the product was picked FROM (the bin/rack)
    const moveLines = await odoo.searchRead(
      session, "stock.move.line",
      [
        ["picking_id", "in", pickPickingIds],
        ["state", "=", "done"],
        ["product_id", "in", productIds],
      ],
      ["product_id", "location_id"],
      500
    );

    for (const ml of moveLines) {
      const pid = ml.product_id[0];
      if (!result[pid]) {
        result[pid] = {
          location_id:   ml.location_id[0],
          location_name: ml.location_id[1] || "",
        };
      }
    }

    return result;
  };

  // ── Find Output/Sortie location (kept as fallback helper) ───────────────────
  const findOutputLocation = async (): Promise<{ id: number; name: string }> => {
    // Try common names
    const candidates = await odoo.searchRead(
      session, "stock.location",
      [
        "|", "|", "|",
        ["complete_name", "ilike", "Sortie"],
        ["complete_name", "ilike", "Output"],
        ["name", "ilike", "Sortie"],
        ["name", "ilike", "Output"],
      ],
      ["id", "name", "complete_name", "usage"],
      10
    );
    // Prefer internal/transit usage
    const sorted = candidates.sort((a: any, b: any) => {
      const score = (l: any) => l.usage === "internal" ? 0 : l.usage === "transit" ? 1 : 2;
      return score(a) - score(b);
    });
    if (sorted.length > 0) return { id: sorted[0].id, name: sorted[0].complete_name || sorted[0].name };

    // Fallback: look at where the return picking's location_dest_id points
    throw new Error("Emplacement Sortie/Output introuvable. Vérifiez les emplacements Odoo.");
  };

  // ── Find fallback stock location ────────────────────────────────────────────
  const findDefaultStockLocation = async (): Promise<{ id: number; name: string }> => {
    const locs = await odoo.searchRead(
      session, "stock.location",
      [["complete_name", "ilike", "WH/Stock"], ["usage", "=", "internal"]],
      ["id", "name", "complete_name"],
      1
    );
    if (locs.length) return { id: locs[0].id, name: locs[0].complete_name || locs[0].name };

    // Broader fallback
    const locs2 = await odoo.searchRead(
      session, "stock.location",
      [["name", "ilike", "Stock"], ["usage", "=", "internal"]],
      ["id", "name", "complete_name"],
      1
    );
    if (locs2.length) return { id: locs2[0].id, name: locs2[0].complete_name || locs2[0].name };

    throw new Error("Emplacement stock par défaut introuvable.");
  };

  // ── Scan by name ────────────────────────────────────────────────────────────
  const handleScan = async (code: string) => {
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) return;
    setScanError("");
    // Search in already-loaded list first
    const found = returns.find(r => r.name.toUpperCase() === trimmed);
    if (found) { openReturn(found); setScanCode(""); return; }
    // Not in list — reload and search fresh data
    try {
      const fresh = await loadReturns();
      const foundFresh = fresh.find(r => r.name.toUpperCase() === trimmed);
      if (foundFresh) {
        openReturn(foundFresh);
        setScanCode("");
      } else {
        setScanError(`"${trimmed}" introuvable ou déjà traité`);
      }
    } catch (e: any) { setScanError((e as Error).message); }
  };

  // ── State label ─────────────────────────────────────────────────────────────
  const stateLabel = (s: string) => {
    if (s === "assigned") return { label: "Prêt", color: C.success };
    if (s === "partially_available") return { label: "Partiel", color: C.warning };
    if (s === "confirmed" || s === "waiting") return { label: "En attente", color: C.orange };
    return { label: s, color: C.textMuted };
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER — LIST VIEW
  // ─────────────────────────────────────────────────────────────────────────────

  if (!selected) {
    return (
      <>
        {/* Title row */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <button onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer", padding: "4px 2px", display: "flex", alignItems: "center", color: C.textMuted }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div style={{ flex: 1 }}>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: C.text, letterSpacing: -0.5 }}>Retours</h2>
            {!loading && <p style={{ margin: 0, fontSize: 12, color: C.textMuted }}>{returns.length} en attente</p>}
          </div>
          <button onClick={() => loadReturns()} disabled={loading} style={{ background: "none", border: "none", cursor: "pointer", padding: 6, color: C.textMuted }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
          </button>
        </div>

        {/* Scan bar */}
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <input
            style={{ flex: 1, padding: "11px 13px", border: `1px solid ${C.border}`, borderRadius: 9, fontSize: 14, fontFamily: "inherit", background: C.card, color: C.text, fontWeight: 600, outline: "none" }}
            value={scanCode}
            onChange={e => { setScanCode(e.target.value); if (scanError) setScanError(""); }}
            onKeyDown={e => {
              if (e.key === "Enter") {
                const val = (e.currentTarget as HTMLInputElement).value;
                if (val.trim()) { setScanCode(val); handleScan(val); }
              }
            }}
            placeholder="Scanner WH/RET/... pour ouvrir directement"
          />
          <button
            onClick={() => { if (scanCode.trim()) handleScan(scanCode); }}
            style={{ padding: "11px 16px", background: C.text, color: "#fff", border: "none", borderRadius: 9, fontWeight: 700, fontSize: 14, cursor: "pointer", whiteSpace: "nowrap" as const }}>
            →
          </button>
        </div>
        {scanError && (
          <div style={{ marginBottom: 10, padding: "8px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, fontSize: 13, color: C.danger, fontWeight: 600 }}>{scanError}</div>
        )}

        {loading && <div style={{ textAlign: "center", padding: 40, color: C.textMuted }}>Chargement…</div>}
        {!loading && error && (
          <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, padding: 14, color: C.danger, fontSize: 14 }}>{error}</div>
        )}
        {!loading && !error && returns.length === 0 && (
          <div style={{ textAlign: "center", padding: 50 }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>↩️</div>
            <div style={{ color: C.textMuted, fontSize: 15 }}>Aucun retour en attente</div>
          </div>
        )}
        {!loading && returns.map(ret => {
          const st = stateLabel(ret.state);
          const totalLines = ret.lines.length;
          const totalQty = ret.lines.reduce((s, l) => s + l.demandQty, 0);
          return (
            <div key={ret.id}
              style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, marginBottom: 10, boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
              {/* Row 1: name + state badge */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ fontSize: 18, fontWeight: 800, color: C.text, letterSpacing: -0.3 }}>{ret.name}</span>
                <span style={{ fontSize: 10, fontWeight: 700, color: st.color, background: st.color + "18", borderRadius: 6, padding: "2px 8px" }}>{st.label}</span>
              </div>
              {/* Row 2: client */}
              {ret.partnerName && <div style={{ fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 4 }}>{ret.partnerName}</div>}
              {/* Row 3: origin */}
              {ret.origin && (
                <div style={{ marginBottom: 8 }}>
                  <span style={{ fontSize: 11, color: C.textMuted }}>{ret.origin}</span>
                </div>
              )}
              {/* Row 4: articles + date */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <span style={{ fontSize: 11, color: C.textMuted }}>{totalLines} article{totalLines > 1 ? "s" : ""} · {totalQty} unité{totalQty > 1 ? "s" : ""}</span>
                {ret.date && <span style={{ fontSize: 11, color: C.textMuted }}>{new Date(ret.date).toLocaleDateString("fr-FR")}</span>}
              </div>
              {/* Action button */}
              <button
                onClick={() => openReturn(ret)}
                style={{ width: "100%", padding: "11px 0", background: C.text, color: "#fff", border: "none", borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                Traiter
              </button>
            </div>
          );
        })}
      </>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER — DETAIL VIEW (selected return)
  // ─────────────────────────────────────────────────────────────────────────────

  const allQtyFilled = selected.lines.every(l => {
    const key = l.moveLineId ?? l.moveId;
    const v = parseFloat(qtyEdits[key] ?? "");
    return !isNaN(v) && v >= 0;
  });

  if (transferDone) {
    return (
      <>
        {/* Back row */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <button onClick={() => { setSelected(null); setTransferDone(null); }} style={{ background: "none", border: "none", cursor: "pointer", padding: "4px 2px", display: "flex", alignItems: "center", color: C.textMuted }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: C.success }}>Retour validé ✓</h2>
        </div>

        {/* Success banner */}
        <div style={{ background: "#ecfdf5", border: "1px solid #6ee7b7", borderRadius: 12, padding: 18, marginBottom: 16, textAlign: "center" as const }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>✅</div>
          <div style={{ fontWeight: 700, fontSize: 16, color: C.success, marginBottom: 4 }}>Retour {selected.name} validé</div>
          <div style={{ fontSize: 13, color: "#065f46" }}>Transfert interne créé et validé automatiquement</div>
        </div>

        {/* Transfer info */}
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, marginBottom: 12 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: C.text, marginBottom: 10 }}>
            📋 {transferDone.pickingName}
          </div>
          {transferDone.lines.map((l, i) => (
            <div key={i} style={{ fontSize: 13, color: C.textMuted, padding: "6px 0", borderTop: i > 0 ? `1px solid ${C.border}` : "none" }}>
              <div style={{ fontWeight: 600, color: C.text }}>{l.productName}</div>
              <div style={{ marginTop: 2 }}>
                {l.qty} unité{l.qty > 1 ? "s" : ""} → <span style={{ color: C.primary }}>{l.destLoc}</span>
              </div>
            </div>
          ))}
        </div>

        <div style={{ fontSize: 12, color: C.textMuted, textAlign: "center" as const, marginBottom: 20 }}>
          Le stock a été remis à jour automatiquement dans Odoo.
        </div>

        <button
          onClick={() => { setSelected(null); setTransferDone(null); }}
          style={{ width: "100%", padding: "14px 0", background: C.primary, color: "#fff", border: "none", borderRadius: 12, fontSize: 15, fontWeight: 700, cursor: "pointer" }}>
          Retour à la liste
        </button>
      </>
    );
  }

  return (
    <>
      {/* Back row */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <button onClick={() => setSelected(null)} style={{ background: "none", border: "none", cursor: "pointer", padding: "4px 2px", display: "flex", alignItems: "center", color: C.textMuted }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: C.text, letterSpacing: -0.5 }}>{selected.name}</h2>
          {selected.partnerName && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 1 }}>{selected.partnerName}</div>}
        </div>
        <span style={{ fontSize: 11, fontWeight: 700, color: stateLabel(selected.state).color, background: stateLabel(selected.state).color + "18", borderRadius: 6, padding: "3px 8px" }}>
          {stateLabel(selected.state).label}
        </span>
      </div>

      {/* Origin */}
      {selected.origin && (
        <div style={{ background: C.retBg, border: `1px solid #fde68a`, borderRadius: 10, padding: "10px 14px", marginBottom: 12, fontSize: 13, color: C.retText }}>
          <strong>Origine :</strong> {selected.origin}
        </div>
      )}

      {error && (
        <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, padding: 12, marginBottom: 12, color: C.danger, fontSize: 13 }}>{error}</div>
      )}

      {/* Lines */}
      <div style={{ fontWeight: 700, fontSize: 11, color: C.textMuted, marginBottom: 8, letterSpacing: 0.5 }}>ARTICLES À RÉCEPTIONNER</div>

      <div style={{ paddingBottom: 100 }}>
        {selected.lines.map((line) => {
          const key = line.moveLineId ?? line.moveId;
          const currentVal = qtyEdits[key] ?? String(line.demandQty);
          return (
            <div key={key}
              style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 16px", marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 8 }}>
                <div style={{ flex: 1, paddingRight: 12 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: C.text, lineHeight: 1.3 }}>{line.productName}</div>
                  {line.productRef && (
                    <div style={{ fontSize: 12, color: C.primary, fontWeight: 600, marginTop: 2 }}>{line.productRef}</div>
                  )}
                  {line.lotName && (
                    <div style={{ fontSize: 12, color: C.textMuted, marginTop: 3 }}>
                      <span style={{ background: "#f0fdf4", color: "#15803d", borderRadius: 5, padding: "1px 6px", fontWeight: 600 }}>Lot {line.lotName}</span>
                    </div>
                  )}
                </div>
                {/* Qty editor */}
                <div style={{ display: "flex", flexDirection: "column" as const, alignItems: "flex-end", gap: 4 }}>
                  <div style={{ fontSize: 11, color: C.textMuted }}>Attendu : {line.demandQty}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <button
                      onClick={() => {
                        const v = parseFloat(currentVal) || 0;
                        if (v > 0) setQtyEdits(q => ({ ...q, [key]: String(Math.max(0, v - 1)) }));
                      }}
                      style={{ width: 32, height: 32, borderRadius: 8, border: `1px solid ${C.border}`, background: "#f3f4f6", cursor: "pointer", fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center", color: C.text, fontWeight: 700 }}>
                      −
                    </button>
                    <input
                      type="number"
                      value={currentVal}
                      onChange={e => setQtyEdits(q => ({ ...q, [key]: e.target.value }))}
                      style={{ width: 56, height: 36, textAlign: "center" as const, fontSize: 16, fontWeight: 700, color: C.text, border: `2px solid ${C.primary}`, borderRadius: 8, outline: "none", fontFamily: "inherit" }}
                    />
                    <button
                      onClick={() => {
                        const v = parseFloat(currentVal) || 0;
                        setQtyEdits(q => ({ ...q, [key]: String(v + 1) }));
                      }}
                      style={{ width: 32, height: 32, borderRadius: 8, border: `1px solid ${C.border}`, background: "#f3f4f6", cursor: "pointer", fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center", color: C.text, fontWeight: 700 }}>
                      +
                    </button>
                  </div>
                  <div style={{ fontSize: 11, color: C.textMuted }}>{line.uomName}</div>
                </div>
              </div>

              {/* Quick fill button */}
              {parseFloat(currentVal) !== line.demandQty && (
                <button
                  onClick={() => setQtyEdits(q => ({ ...q, [key]: String(line.demandQty) }))}
                  style={{ fontSize: 12, color: C.primary, background: C.labelBg, border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontWeight: 600 }}>
                  Copier qté attendue ({line.demandQty})
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Bottom actions — fixed */}
      <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: C.card, borderTop: `1px solid ${C.border}`, padding: "12px 14px", display: "flex", gap: 10 }}>
        <button
          onClick={() => {
            const edits: Record<number, string> = {};
            for (const l of selected.lines) {
              edits[l.moveLineId ?? l.moveId] = String(l.demandQty);
            }
            setQtyEdits(edits);
          }}
          style={{ flex: 1, padding: "13px 0", background: "#f3f4f6", border: `1px solid ${C.border}`, borderRadius: 12, fontSize: 14, fontWeight: 600, color: C.text, cursor: "pointer" }}>
          Tout valider
        </button>
        <button
          onClick={validateReturn}
          disabled={validating || !allQtyFilled}
          style={{ flex: 2, padding: "13px 0", background: validating ? "#93c5fd" : C.success, color: "#fff", border: "none", borderRadius: 12, fontSize: 15, fontWeight: 700, cursor: validating ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
          {validating ? (
            <>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" style={{ animation: "spin 1s linear infinite" }}><path d="M21 12a9 9 0 11-2.64-6.36"/></svg>
              Validation…
            </>
          ) : (
            <>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
              Valider le retour
            </>
          )}
        </button>
      </div>
    </>
  );
}
