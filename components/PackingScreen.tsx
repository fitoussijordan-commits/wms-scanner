"use client";
// components/PackingScreen.tsx — Emballage + expédition automatique (pack & ship)

import { useState, useEffect, useCallback } from "react";
import * as odoo from "@/lib/odoo";
import * as pn from "@/lib/printnode";
import type { OdooSession } from "@/lib/odoo";

const C = {
  bg:        "#f9fafb",
  card:      "#ffffff",
  border:    "#e5e7eb",
  primary:   "#2563eb",
  teal:      "#0d9488",
  success:   "#059669",
  warning:   "#f59e0b",
  danger:    "#ef4444",
  text:      "#111827",
  textMuted: "#6b7280",
  labelBg:   "#eff6ff",
};

interface PackingLine {
  productName: string;
  productRef:  string;
  lotName:     string;
  qty:         number;
  uomName:     string;
}

interface PackablePicking {
  id:          number;
  name:        string;
  origin:      string;
  partnerName: string;
  carrierId:   string;
  lineCount:   number;
  date:        string;
}

interface DoneResult {
  pickingName:      string;
  labelCount:       number;
  blPrinted:        boolean;
  labelPrinted:     boolean;
  labelAttachments: { id: number; name: string; datas: string }[];
}

interface Props {
  session:          OdooSession;
  onBack:           () => void;
  onToast:          (msg: string, type?: "success" | "error" | "info") => void;
  initialPickingId?: number;   // si venu de "Valider + Emballer" — passe directement au détail
}

export default function PackingScreen({ session, onBack, onToast, initialPickingId }: Props) {
  const [view,           setView]           = useState<"list" | "detail">(initialPickingId ? "detail" : "list");
  const [loadingList,    setLoadingList]    = useState(true);
  const [pickings,       setPickings]       = useState<PackablePicking[]>([]);
  const [selectedId,     setSelectedId]     = useState<number | null>(initialPickingId ?? null);
  const [lines,          setLines]          = useState<PackingLine[]>([]);
  const [loadingDetail,  setLoadingDetail]  = useState(false);
  const [nPackages,      setNPackages]      = useState(1);
  const [weights,        setWeights]        = useState<string[]>([""]); // one per package
  const [packing,        setPacking]        = useState(false);
  const [done,           setDone]           = useState<DoneResult | null>(null);
  const [error,          setError]          = useState("");
  const [selectedName,   setSelectedName]   = useState("");
  const [selectedPartner,setSelectedPartner]= useState("");
  const [selectedOrigin, setSelectedOrigin] = useState("");
  const [scanCode,       setScanCode]       = useState("");
  const [scanError,      setScanError]      = useState("");

  // ── Sync weights array length to nPackages ──────────────────────────────────
  useEffect(() => {
    setWeights(prev => {
      if (prev.length === nPackages) return prev;
      if (prev.length < nPackages) return [...prev, ...Array(nPackages - prev.length).fill("")];
      return prev.slice(0, nPackages);
    });
  }, [nPackages]);

  // ── Load list ────────────────────────────────────────────────────────────────
  const loadList = useCallback(async () => {
    setLoadingList(true);
    setError("");
    try {
      const raw = await odoo.getPackablePickings(session);
      // Load move counts per picking
      const pickingIds = raw.map((p: any) => p.id);
      const mapped: PackablePicking[] = raw.map((p: any) => ({
        id:          p.id,
        name:        p.name,
        origin:      p.origin || "",
        partnerName: p.partner_id ? p.partner_id[1] : "",
        carrierId:   p.carrier_id ? p.carrier_id[1] : "",
        lineCount:   Array.isArray(p.move_ids_without_package) ? p.move_ids_without_package.length : 0,
        date:        p.date_deadline || p.scheduled_date || "",
      }));
      setPickings(mapped);
    } catch (e: any) { setError(e.message); }
    finally { setLoadingList(false); }
  }, [session]);

  useEffect(() => {
    if (view === "list") loadList();
  }, [view, loadList]);

  // ── Open detail ──────────────────────────────────────────────────────────────
  const openDetail = useCallback(async (pickingId: number, name: string, partner: string, origin: string) => {
    setSelectedId(pickingId);
    setSelectedName(name);
    setSelectedPartner(partner);
    setSelectedOrigin(origin);
    setView("detail");
    setDone(null);
    setError("");
    setNPackages(1);
    setWeights([""]);
    setLoadingDetail(true);
    try {
      const moveLines = await odoo.getPickingMoveLines(session, pickingId);
      // Also need moves for product refs + UOM
      const moves = await odoo.getPickingMoves(session, pickingId);
      const productIds = Array.from(new Set(moveLines.map((ml: any) => ml.product_id[0]))) as number[];
      const products = productIds.length
        ? await odoo.searchRead(session, "product.product", [["id", "in", productIds]], ["id", "default_code"], productIds.length)
        : [];
      const refMap: Record<number, string> = {};
      for (const p of products) refMap[p.id] = p.default_code || "";

      const moveMap: Record<number, any> = {};
      for (const m of moves) moveMap[m.id] = m;

      const parsed: PackingLine[] = moveLines.map((ml: any) => {
        const move = Array.isArray(ml.move_id) ? moveMap[ml.move_id[0]] : moveMap[ml.move_id];
        return {
          productName: ml.product_id[1] || "",
          productRef:  refMap[ml.product_id[0]] || "",
          lotName:     ml.lot_id ? ml.lot_id[1] : "",
          qty:         ml.reserved_uom_qty || 0,
          uomName:     move ? (Array.isArray(move.product_uom) ? move.product_uom[1] : "") : "",
        };
      }).filter((l: PackingLine) => l.qty > 0);
      setLines(parsed);
    } catch (e: any) { setError(e.message); }
    finally { setLoadingDetail(false); }
  }, [session]);

  // Auto-open if initialPickingId provided
  useEffect(() => {
    if (initialPickingId && view === "detail") {
      // Load details without going through the list
      setLoadingDetail(true);
      const load = async () => {
        try {
          const [pick] = await odoo.searchRead(session, "stock.picking",
            [["id", "=", initialPickingId]],
            ["id", "name", "origin", "partner_id", "carrier_id"], 1);
          if (pick) {
            setSelectedName(pick.name);
            setSelectedPartner(pick.partner_id ? pick.partner_id[1] : "");
            setSelectedOrigin(pick.origin || "");
            await openDetail(initialPickingId, pick.name, pick.partner_id?.[1] || "", pick.origin || "");
          }
        } catch (e: any) { setError((e as Error).message); }
        finally { setLoadingDetail(false); }
      };
      load();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Validate & Ship ──────────────────────────────────────────────────────────
  const validate = async () => {
    if (!selectedId) return;
    const parsedWeights = weights.map(w => parseFloat(w) || 0);
    if (parsedWeights.some(w => w <= 0)) {
      onToast("Renseignez le poids de chaque colis", "error");
      return;
    }
    setPacking(true); setError("");
    try {
      const blCfg      = pn.getLabelTypeConfig("packingslip");
      const blPrinterId    = blCfg.printerId || pn.getSavedPrinterId() || undefined;
      const labelPrinterId = blPrinterId; // même imprimante par défaut

      const result = await odoo.packAndShipOut(session, selectedId, parsedWeights, {
        blPrinterId:   blPrinterId ?? undefined,
        labelPrinterId: labelPrinterId ?? undefined,
        blReportName:  odoo.getSavedPrepReportName(),
      });

      // Imprimer étiquettes TNT via PrintNode si disponibles
      let labelPrinted = false;
      if (labelPrinterId && result.labelAttachments.length > 0) {
        for (const att of result.labelAttachments) {
          if (att.datas) {
            const r = await pn.printPdfLabel(labelPrinterId, att.datas, att.name || "Étiquette TNT");
            if (r.success) labelPrinted = true;
          }
        }
      }

      setDone({
        pickingName:      result.pickingName,
        labelCount:       result.labelAttachments.length,
        blPrinted:        !!blPrinterId,
        labelPrinted,
        labelAttachments: result.labelAttachments,
      });
      onToast(`✅ ${result.pickingName} expédié`, "success");
    } catch (e: any) {
      setError(e.message);
      onToast("Erreur : " + e.message, "error");
    } finally { setPacking(false); }
  };

  // ── Scan by name ─────────────────────────────────────────────────────────────
  const handleScan = useCallback(async (code: string) => {
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) return;
    setScanError("");
    // Search in loaded list first
    const found = pickings.find(p => p.name.toUpperCase() === trimmed);
    if (found) {
      openDetail(found.id, found.name, found.partnerName, found.origin);
      setScanCode("");
      return;
    }
    // Search Odoo directly
    try {
      const results = await odoo.searchRead(session, "stock.picking",
        [["name", "=", trimmed], ["state", "=", "assigned"]],
        ["id", "name", "origin", "partner_id", "carrier_id", "move_ids_without_package", "date_deadline", "scheduled_date"], 1);
      if (results.length) {
        const p = results[0];
        openDetail(p.id, p.name, p.partner_id ? p.partner_id[1] : "", p.origin || "");
        setScanCode("");
      } else {
        setScanError(`"${trimmed}" introuvable ou non prêt à emballer`);
      }
    } catch (e: any) { setScanError(e.message); }
  }, [pickings, session, openDetail]);

  const totalWeight = weights.reduce((s, w) => s + (parseFloat(w) || 0), 0);
  const allWeightsFilled = weights.every(w => parseFloat(w) > 0);

  // ────────────────────────────────────────────────────────────────────────────
  // RENDER — List
  // ────────────────────────────────────────────────────────────────────────────
  if (view === "list") {
    return (
      <div style={{ minHeight: "100vh", background: C.bg, fontFamily: "'Inter', sans-serif" }}>
        {/* Header */}
        <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: "14px 16px", display: "flex", alignItems: "center", gap: 12, position: "sticky", top: 0, zIndex: 10 }}>
          <button onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, color: C.textMuted }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div style={{ flex: 1 }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: C.text }}>Emballage</h2>
            <p style={{ margin: 0, fontSize: 12, color: C.textMuted, marginTop: 2 }}>{pickings.length} commande{pickings.length > 1 ? "s" : ""} prête{pickings.length > 1 ? "s" : ""} à expédier</p>
          </div>
          <button onClick={loadList} disabled={loadingList} style={{ background: "none", border: "none", cursor: "pointer", padding: 6, color: C.primary }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
          </button>
        </div>

        <div style={{ padding: "12px 14px" }}>
          {/* Scan bar */}
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <input
              style={{ flex: 1, padding: "11px 13px", border: `1px solid ${C.border}`, borderRadius: 9, fontSize: 14, fontFamily: "inherit", background: C.card, color: C.text, fontWeight: 600, outline: "none" }}
              value={scanCode}
              onChange={e => { setScanCode(e.target.value); if (scanError) setScanError(""); }}
              onKeyDown={e => { if (e.key === "Enter" && scanCode.trim()) handleScan(scanCode); }}
              placeholder="Scanner WH/OUT/... pour ouvrir directement"
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

          {loadingList && <div style={{ textAlign: "center", padding: 40, color: C.textMuted }}>Chargement…</div>}
          {!loadingList && error && (
            <div style={{ background: "#fef2f2", border: `1px solid #fecaca`, borderRadius: 10, padding: 14, color: C.danger, fontSize: 14 }}>{error}</div>
          )}
          {!loadingList && !error && pickings.length === 0 && (
            <div style={{ textAlign: "center", padding: 50 }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>📦</div>
              <div style={{ color: C.textMuted, fontSize: 15 }}>Aucune commande à emballer</div>
            </div>
          )}
          {!loadingList && pickings.map(p => (
            <div key={p.id}
              style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, marginBottom: 10, boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
              {/* Row 1: name + status */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ fontSize: 18, fontWeight: 800, color: C.text, letterSpacing: -0.3 }}>{p.name}</span>
                <span style={{ fontSize: 10, fontWeight: 700, color: C.teal, background: C.teal + "18", borderRadius: 6, padding: "2px 8px" }}>Prêt</span>
              </div>
              {/* Row 2: client */}
              {p.partnerName && <div style={{ fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 4 }}>{p.partnerName}</div>}
              {/* Row 3: origin + carrier chip */}
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10, flexWrap: "wrap" as const }}>
                {p.origin && <span style={{ fontSize: 11, color: C.textMuted }}>{p.origin}</span>}
                {p.carrierId && (
                  <span style={{ fontSize: 11, fontWeight: 700, color: "#7c3aed", background: "#f5f3ff", padding: "1px 7px", borderRadius: 5 }}>{p.carrierId}</span>
                )}
              </div>
              {/* Row 4: articles count + date */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <span style={{ fontSize: 11, color: C.textMuted }}>{p.lineCount} article{p.lineCount > 1 ? "s" : ""}</span>
                {p.date && <span style={{ fontSize: 11, color: C.textMuted }}>{new Date(p.date).toLocaleDateString("fr-FR")}</span>}
              </div>
              {/* Action button */}
              <button
                onClick={() => openDetail(p.id, p.name, p.partnerName, p.origin)}
                style={{ width: "100%", padding: "11px 0", background: C.text, color: "#fff", border: "none", borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                Emballer
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  // RENDER — Done (success)
  // ────────────────────────────────────────────────────────────────────────────
  if (done) {
    return (
      <div style={{ minHeight: "100vh", background: C.bg, fontFamily: "'Inter', sans-serif" }}>
        <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: "14px 16px", display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={() => { setDone(null); setView("list"); }} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, color: C.textMuted }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <h1 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: C.text }}>Expédié ✓</h1>
        </div>
        <div style={{ padding: "20px 14px" }}>
          <div style={{ background: "#ecfdf5", border: "1px solid #6ee7b7", borderRadius: 12, padding: 20, marginBottom: 16, textAlign: "center" }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>✅</div>
            <div style={{ fontWeight: 700, fontSize: 17, color: C.success, marginBottom: 4 }}>{done.pickingName}</div>
            <div style={{ fontSize: 13, color: "#065f46" }}>Commande expédiée et stock mis à jour</div>
          </div>

          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, marginBottom: 12 }}>
            <div style={{ fontSize: 13, color: C.textMuted, display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 16 }}>{done.blPrinted ? "🖨️" : "⚠️"}</span>
                <span style={{ color: done.blPrinted ? C.success : C.warning }}>
                  Bon de livraison {done.blPrinted ? "imprimé" : "non imprimé (aucune imprimante BL configurée)"}
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 16 }}>{done.labelPrinted ? "🖨️" : (done.labelCount > 0 ? "⚠️" : "ℹ️")}</span>
                <span style={{ color: done.labelPrinted ? C.success : (done.labelCount > 0 ? C.warning : C.textMuted) }}>
                  {done.labelCount > 0
                    ? `${done.labelCount} étiquette${done.labelCount > 1 ? "s" : ""} TNT ${done.labelPrinted ? "imprimée" + (done.labelCount > 1 ? "s" : "") : "disponible" + (done.labelCount > 1 ? "s" : "") + " (configurer imprimante)"}`
                    : "Aucune étiquette TNT générée (vérifier transporteur)"}
                </span>
              </div>
            </div>

            {/* Affichage des étiquettes si disponibles mais non imprimées */}
            {done.labelAttachments.length > 0 && !done.labelPrinted && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: C.textMuted, marginBottom: 6 }}>Étiquettes disponibles :</div>
                {done.labelAttachments.map((att, i) => (
                  <div key={i} style={{ fontSize: 12, color: C.primary }}>📄 {att.name || `Étiquette ${i + 1}`}</div>
                ))}
              </div>
            )}
          </div>

          <button
            onClick={() => { setDone(null); setView("list"); }}
            style={{ width: "100%", padding: "14px 0", background: C.primary, color: "#fff", border: "none", borderRadius: 12, fontSize: 15, fontWeight: 700, cursor: "pointer" }}>
            Commande suivante
          </button>
        </div>
      </div>
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  // RENDER — Detail (packing form)
  // ────────────────────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: "'Inter', sans-serif" }}>
      {/* Header */}
      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: "14px 16px", display: "flex", alignItems: "center", gap: 12, position: "sticky", top: 0, zIndex: 10 }}>
        <button
          onClick={() => initialPickingId ? onBack() : setView("list")}
          style={{ background: "none", border: "none", cursor: "pointer", padding: 4, color: C.textMuted }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div style={{ flex: 1 }}>
          <h1 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: C.text }}>{selectedName}</h1>
          {selectedPartner && <div style={{ fontSize: 12, color: C.textMuted }}>{selectedPartner}</div>}
        </div>
      </div>

      <div style={{ padding: "12px 14px 130px" }}>
        {selectedOrigin && (
          <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 10, padding: "8px 14px", marginBottom: 12, fontSize: 12, color: "#1d4ed8", fontWeight: 500 }}>
            Réf : {selectedOrigin}
          </div>
        )}

        {error && (
          <div style={{ background: "#fef2f2", border: `1px solid #fecaca`, borderRadius: 10, padding: 12, marginBottom: 12, color: C.danger, fontSize: 13 }}>{error}</div>
        )}

        {/* Articles */}
        {loadingDetail ? (
          <div style={{ textAlign: "center", padding: 30, color: C.textMuted }}>Chargement des articles…</div>
        ) : (
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14, marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, marginBottom: 10, textTransform: "uppercase", letterSpacing: 0.4 }}>
              Articles ({lines.length})
            </div>
            {lines.slice(0, 8).map((l, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "7px 0", borderTop: i > 0 ? `1px solid ${C.border}` : "none" }}>
                <div style={{ flex: 1, paddingRight: 8 }}>
                  {l.productRef && <div style={{ fontSize: 11, fontWeight: 700, color: C.primary }}>{l.productRef}</div>}
                  <div style={{ fontSize: 13, color: C.text, fontWeight: 500 }}>{l.productName}</div>
                  {l.lotName && <div style={{ fontSize: 11, color: C.textMuted }}>Lot {l.lotName}</div>}
                </div>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.text, whiteSpace: "nowrap" }}>
                  {l.qty} {l.uomName}
                </div>
              </div>
            ))}
            {lines.length > 8 && (
              <div style={{ fontSize: 12, color: C.textMuted, paddingTop: 8, borderTop: `1px solid ${C.border}` }}>
                +{lines.length - 8} article{lines.length - 8 > 1 ? "s" : ""} supplémentaires
              </div>
            )}
          </div>
        )}

        {/* Nombre de colis */}
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 14 }}>Conditionnement</div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
            <div style={{ fontSize: 14, color: C.text, fontWeight: 500 }}>Nombre de colis</div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button
                onClick={() => setNPackages(n => Math.max(1, n - 1))}
                style={{ width: 36, height: 36, borderRadius: 8, border: `1px solid ${C.border}`, background: "#f3f4f6", cursor: "pointer", fontSize: 20, display: "flex", alignItems: "center", justifyContent: "center", color: C.text, fontWeight: 700 }}>
                −
              </button>
              <span style={{ fontSize: 20, fontWeight: 800, color: C.text, minWidth: 32, textAlign: "center" }}>{nPackages}</span>
              <button
                onClick={() => setNPackages(n => Math.min(20, n + 1))}
                style={{ width: 36, height: 36, borderRadius: 8, border: `1px solid ${C.border}`, background: "#f3f4f6", cursor: "pointer", fontSize: 20, display: "flex", alignItems: "center", justifyContent: "center", color: C.text, fontWeight: 700 }}>
                +
              </button>
            </div>
          </div>

          {/* Poids par colis */}
          {weights.map((w, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <div style={{ fontSize: 13, color: C.text }}>
                Colis {i + 1}
                {nPackages === 1 && <span style={{ fontSize: 12, color: C.textMuted }}> (poids total)</span>}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="number"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={w}
                  onChange={e => setWeights(prev => { const next = [...prev]; next[i] = e.target.value; return next; })}
                  style={{ width: 80, height: 38, textAlign: "right", fontSize: 15, fontWeight: 700, color: C.text, border: `2px solid ${w && parseFloat(w) > 0 ? C.teal : C.border}`, borderRadius: 8, outline: "none", fontFamily: "inherit", paddingRight: 8 }}
                />
                <span style={{ fontSize: 13, color: C.textMuted, width: 24 }}>kg</span>
              </div>
            </div>
          ))}

          {/* Total */}
          {nPackages > 1 && totalWeight > 0 && (
            <div style={{ display: "flex", justifyContent: "flex-end", paddingTop: 10, borderTop: `1px solid ${C.border}`, marginTop: 4 }}>
              <span style={{ fontSize: 13, color: C.textMuted }}>Total : </span>
              <span style={{ fontSize: 13, fontWeight: 700, color: C.text, marginLeft: 6 }}>{totalWeight.toFixed(2)} kg</span>
            </div>
          )}
        </div>
      </div>

      {/* Bottom action */}
      <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: C.card, borderTop: `1px solid ${C.border}`, padding: "12px 14px" }}>
        <button
          onClick={validate}
          disabled={packing || !allWeightsFilled || loadingDetail}
          style={{
            width: "100%", padding: "15px 0",
            background: packing ? "#93c5fd" : !allWeightsFilled ? "#e5e7eb" : C.teal,
            color: !allWeightsFilled ? C.textMuted : "#fff",
            border: "none", borderRadius: 12, fontSize: 15, fontWeight: 700,
            cursor: packing || !allWeightsFilled ? "not-allowed" : "pointer",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
            fontFamily: "inherit",
          }}>
          {packing ? (
            <>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" style={{ animation: "spin 1s linear infinite" }}><path d="M21 12a9 9 0 11-2.64-6.36"/></svg>
              Expédition en cours…
            </>
          ) : (
            <>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              Valider & Imprimer
            </>
          )}
        </button>
        {!allWeightsFilled && !packing && (
          <div style={{ fontSize: 12, color: C.textMuted, textAlign: "center", marginTop: 6 }}>
            Renseignez le poids de chaque colis
          </div>
        )}
      </div>
    </div>
  );
}
