"use client";
// components/PackingScreen.tsx — Emballage + expédition automatique (pack & ship)

import { useState, useEffect, useCallback } from "react";
import * as odoo from "@/lib/odoo";
import * as pn from "@/lib/printnode";
import type { OdooSession } from "@/lib/odoo";

// ── Clés localStorage session-only (jamais syncées Supabase) ──────────────────
const LS_BL_PRINTER    = "wms_packing_bl_printer";
const LS_LABEL_PRINTER = "wms_packing_label_printer";
const LS_BL_REPORT     = "wms_packing_bl_report";   // template rapport BL (session-local)

function readLocalPrinter(key: string): number | null {
  try { const v = localStorage.getItem(key); return v ? parseInt(v, 10) : null; } catch { return null; }
}
function saveLocalPrinter(key: string, id: number | null) {
  try { if (id === null) localStorage.removeItem(key); else localStorage.setItem(key, String(id)); } catch {}
}
function readLocalStr(key: string, fallback: string): string {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}
function saveLocalStr(key: string, val: string) {
  try { localStorage.setItem(key, val); } catch {}
}

/** Convertit "4,6" ou "4.6" en nombre float */
function parseWeight(s: string): number {
  return parseFloat(s.replace(",", ".")) || 0;
}

const C = {
  bg:        "#f9fafb",
  card:      "#ffffff",
  border:    "#e5e7eb",
  primary:   "#2563eb",
  blue:      "#2563eb",
  blueSoft:  "#eff6ff",
  teal:      "#0d9488",
  success:   "#059669",
  green:     "#16a34a",
  greenSoft: "#f0fdf4",
  warning:   "#f59e0b",
  danger:    "#ef4444",
  text:      "#111827",
  textSec:   "#374151",
  textMuted: "#6b7280",
  shadow:    "0 1px 4px rgba(0,0,0,0.06)",
  white:     "#ffffff",
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

interface PickingReport { id: number; name: string; report_name: string; }

interface Props {
  session:          OdooSession;
  onBack:           () => void;
  onToast:          (msg: string, type?: "success" | "error" | "info") => void;
  initialPickingId?: number;
}

/** Vérifie si un numéro S scanné correspond à un champ origin (qui peut contenir "S66191, S66192") */
function matchOrigin(origin: string, query: string): boolean {
  const up = origin.toUpperCase();
  const q  = query.toUpperCase().trim();
  if (!q) return false;
  if (up === q) return true;
  // Split sur virgule / espace pour gérer plusieurs SO
  return up.split(/[,\s]+/).map(s => s.trim()).some(s => s === q);
}

export default function PackingScreen({ session, onBack, onToast, initialPickingId }: Props) {
  const [view,           setView]           = useState<"list" | "detail">(initialPickingId ? "detail" : "list");
  const [loadingList,    setLoadingList]    = useState(true);
  const [pickings,       setPickings]       = useState<PackablePicking[]>([]);
  const [selectedId,     setSelectedId]     = useState<number | null>(initialPickingId ?? null);
  const [lines,          setLines]          = useState<PackingLine[]>([]);
  const [loadingDetail,  setLoadingDetail]  = useState(false);
  const [nPackages,      setNPackages]      = useState(1);
  const [weights,        setWeights]        = useState<string[]>([""]);
  const [packing,        setPacking]        = useState(false);
  const [done,           setDone]           = useState<DoneResult | null>(null);
  const [error,          setError]          = useState("");
  const [showAllLines,   setShowAllLines]   = useState(false);
  const [selectedName,   setSelectedName]   = useState("");
  const [selectedPartner,setSelectedPartner]= useState("");
  const [selectedOrigin, setSelectedOrigin] = useState("");
  const [scanCode,       setScanCode]       = useState("");
  const [scanError,      setScanError]      = useState("");

  // ── Imprimantes + template session-local ─────────────────────────────────────
  const [blPrinterId,      setBlPrinterId]      = useState<number | null>(() => readLocalPrinter(LS_BL_PRINTER));
  const [labelPrinterId,   setLabelPrinterId]   = useState<number | null>(() => readLocalPrinter(LS_LABEL_PRINTER));
  const [blReportName,     setBlReportName]     = useState<string>(() => readLocalStr(LS_BL_REPORT, "stock.report_picking"));
  const [showPrinterModal, setShowPrinterModal] = useState(false);
  const [printerList,      setPrinterList]      = useState<pn.PrintNodePrinter[]>([]);
  const [reportList,       setReportList]       = useState<PickingReport[]>([]);
  const [loadingPrinters,  setLoadingPrinters]  = useState(false);
  const [printerError,     setPrinterError]     = useState("");

  // ── Sync weights length ──────────────────────────────────────────────────────
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
      return mapped;
    } catch (e: any) { setError(e.message); return []; }
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
    setShowAllLines(false);
    setLoadingDetail(true);
    try {
      const moveLines = await odoo.getPickingMoveLines(session, pickingId);
      const moves     = await odoo.getPickingMoves(session, pickingId);
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
      const load = async () => {
        setLoadingDetail(true);
        try {
          const [pick] = await odoo.searchRead(session, "stock.picking",
            [["id", "=", initialPickingId]],
            ["id", "name", "origin", "partner_id", "carrier_id"], 1);
          if (pick) await openDetail(initialPickingId, pick.name, pick.partner_id?.[1] || "", pick.origin || "");
        } catch (e: any) { setError((e as Error).message); }
        finally { setLoadingDetail(false); }
      };
      load();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Charger imprimantes + templates PrintNode ────────────────────────────────
  const openPrinterModal = async () => {
    setShowPrinterModal(true);
    setPrinterError("");
    if (printerList.length && reportList.length) return;   // déjà chargé
    setLoadingPrinters(true);
    try {
      const [printers, reports] = await Promise.all([
        pn.listPrinters(),
        odoo.getPickingReportList(session),
      ]);
      setPrinterList(printers);
      setReportList(reports);
    } catch (e: any) { setPrinterError(e.message); }
    finally { setLoadingPrinters(false); }
  };

  // ── Scan par nom WH/OUT/... OU par numéro S (origin) ────────────────────────
  const handleScan = useCallback(async (code: string) => {
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) return;
    setScanError("");

    // 1. Cherche dans la liste déjà chargée (par nom exact)
    const foundByName = pickings.find(p => p.name.toUpperCase() === trimmed);
    if (foundByName) {
      openDetail(foundByName.id, foundByName.name, foundByName.partnerName, foundByName.origin);
      setScanCode(""); return;
    }

    // 2. Cherche dans la liste par origin (numéro S — gère "S66191, S66192")
    const foundByOrigin = pickings.find(p => matchOrigin(p.origin, trimmed));
    if (foundByOrigin) {
      openDetail(foundByOrigin.id, foundByOrigin.name, foundByOrigin.partnerName, foundByOrigin.origin);
      setScanCode(""); return;
    }

    // 3. Recherche Odoo — on évite picking_type_code (champ relaté, pas toujours filtrable)
    try {
      // 3a. Par nom exact
      let results: any[] = await odoo.searchRead(session, "stock.picking",
        [["name", "=", trimmed], ["state", "=", "assigned"]],
        ["id", "name", "origin", "partner_id", "carrier_id", "move_ids_without_package", "date_deadline", "scheduled_date"], 1);

      // 3b. Par origin (numéro S) — pas de filtre picking_type_code, on filtre sur le nom ensuite
      if (!results.length) {
        const byOrigin: any[] = await odoo.searchRead(session, "stock.picking",
          [["origin", "ilike", trimmed], ["state", "in", ["assigned", "partially_available"]]],
          ["id", "name", "origin", "partner_id", "carrier_id", "move_ids_without_package", "date_deadline", "scheduled_date"], 20);

        // Garder uniquement les OUT (nom contient /OUT/)
        const outOnly = byOrigin.filter((r: any) => (r.name || "").includes("/OUT/"));

        // Priorité : origin exact ou qui commence par le S scanné
        const exact = outOnly.find((r: any) => matchOrigin(r.origin || "", trimmed));
        results = exact ? [exact] : outOnly.slice(0, 1);
      }

      if (results.length) {
        const p = results[0];
        openDetail(p.id, p.name, p.partner_id ? p.partner_id[1] : "", p.origin || "");
        setScanCode("");
      } else {
        setScanError(`"${trimmed}" introuvable — scanne WH/OUT/... ou le numéro S (ex: S66191)`);
      }
    } catch (e: any) { setScanError((e as Error).message); }
  }, [pickings, session, openDetail]);

  // ── Validate & Ship ──────────────────────────────────────────────────────────
  const validate = async () => {
    if (!selectedId) return;
    // Accepte virgule française (4,6 → 4.6)
    const parsedWeights = weights.map(w => parseWeight(w));
    if (parsedWeights.some(w => w <= 0)) { onToast("Renseignez le poids de chaque colis", "error"); return; }
    setPacking(true); setError("");
    try {
      const result = await odoo.packAndShipOut(session, selectedId, parsedWeights, {
        blPrinterId:    blPrinterId ?? undefined,
        labelPrinterId: labelPrinterId ?? undefined,
        blReportName:   blReportName,
      });

      // Imprimer uniquement le bon nombre d'étiquettes (1 par colis)
      let labelPrinted = false;
      if (labelPrinterId && result.labelAttachments.length > 0) {
        const toprint = result.labelAttachments.slice(0, nPackages);
        for (const att of toprint) {
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

  const totalWeight      = weights.reduce((s, w) => s + parseWeight(w), 0);
  const allWeightsFilled = weights.every(w => parseWeight(w) > 0);

  // ── Modal sélection imprimante + template ────────────────────────────────────
  const PrinterModal = () => (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: C.white, borderRadius: 16, padding: 24, width: "100%", maxWidth: 420, maxHeight: "90vh", overflowY: "auto" as const }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: C.text }}>🖨️ Imprimantes Emballage</div>
          <button onClick={() => setShowPrinterModal(false)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 20, color: C.textMuted, lineHeight: 1 }}>✕</button>
        </div>
        <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 16, padding: "8px 12px", background: C.blueSoft, borderRadius: 8, lineHeight: 1.5 }}>
          Ces réglages sont <strong>propres à ce poste</strong> (stockés localement, non partagés).
        </div>

        {loadingPrinters && <div style={{ textAlign: "center", padding: 20, color: C.textMuted }}>Chargement…</div>}
        {printerError && <div style={{ color: C.danger, fontSize: 13, marginBottom: 12 }}>{printerError}</div>}

        {!loadingPrinters && (<>
          {/* Template BL */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: 0.5, marginBottom: 6 }}>
              Template bon de livraison (BL)
            </div>
            {reportList.length === 0 ? (
              <div style={{ fontSize: 13, color: C.textMuted }}>Aucun rapport disponible</div>
            ) : (
              <select
                value={blReportName}
                onChange={e => { setBlReportName(e.target.value); saveLocalStr(LS_BL_REPORT, e.target.value); }}
                style={{ width: "100%", padding: "10px 12px", border: `1.5px solid ${C.teal}`, borderRadius: 9, fontSize: 13, fontFamily: "inherit", background: C.bg, color: C.text, outline: "none" }}>
                <option value="stock.report_picking">Standard (stock.report_picking)</option>
                {reportList.map(r => (
                  <option key={r.id} value={r.report_name}>{r.name}</option>
                ))}
              </select>
            )}
          </div>

          {/* Imprimante BL */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: 0.5, marginBottom: 6 }}>
              Imprimante BL
            </div>
            {printerList.length === 0 ? (
              <div style={{ fontSize: 13, color: C.textMuted }}>Aucune imprimante PrintNode</div>
            ) : (
              <select
                value={blPrinterId ?? ""}
                onChange={e => {
                  const v = e.target.value ? parseInt(e.target.value, 10) : null;
                  setBlPrinterId(v); saveLocalPrinter(LS_BL_PRINTER, v);
                }}
                style={{ width: "100%", padding: "10px 12px", border: `1.5px solid ${blPrinterId ? C.teal : C.border}`, borderRadius: 9, fontSize: 13, fontFamily: "inherit", background: C.bg, color: C.text, outline: "none" }}>
                <option value="">— Aucune (pas d'impression BL) —</option>
                {printerList.map(pr => (
                  <option key={pr.id} value={pr.id}>{pr.name} ({pr.computer.name})</option>
                ))}
              </select>
            )}
          </div>

          {/* Imprimante étiquette TNT */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: 0.5, marginBottom: 6 }}>
              Imprimante étiquette transporteur
            </div>
            {printerList.length === 0 ? (
              <div style={{ fontSize: 13, color: C.textMuted }}>Aucune imprimante PrintNode</div>
            ) : (
              <select
                value={labelPrinterId ?? ""}
                onChange={e => {
                  const v = e.target.value ? parseInt(e.target.value, 10) : null;
                  setLabelPrinterId(v); saveLocalPrinter(LS_LABEL_PRINTER, v);
                }}
                style={{ width: "100%", padding: "10px 12px", border: `1.5px solid ${labelPrinterId ? C.teal : C.border}`, borderRadius: 9, fontSize: 13, fontFamily: "inherit", background: C.bg, color: C.text, outline: "none" }}>
                <option value="">— Aucune (pas d'impression étiquette) —</option>
                {printerList.map(pr => (
                  <option key={pr.id} value={pr.id}>{pr.name} ({pr.computer.name})</option>
                ))}
              </select>
            )}
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => {
              setBlPrinterId(null); saveLocalPrinter(LS_BL_PRINTER, null);
              setLabelPrinterId(null); saveLocalPrinter(LS_LABEL_PRINTER, null);
              setBlReportName("stock.report_picking"); saveLocalStr(LS_BL_REPORT, "stock.report_picking");
            }}
              style={{ flex: 1, padding: "10px 0", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 9, fontSize: 13, fontWeight: 600, color: C.textMuted, cursor: "pointer", fontFamily: "inherit" }}>
              Effacer
            </button>
            <button onClick={() => setShowPrinterModal(false)}
              style={{ flex: 2, padding: "10px 0", background: C.teal, color: "#fff", border: "none", borderRadius: 9, fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
              ✓ Confirmer
            </button>
          </div>
        </>)}
      </div>
    </div>
  );

  // ────────────────────────────────────────────────────────────────────────────
  // RENDER — Success
  // ────────────────────────────────────────────────────────────────────────────
  if (done) {
    return (
      <>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
          <button onClick={() => { setDone(null); setView("list"); }} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, color: C.textMuted, display: "flex" }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <span style={{ fontSize: 16, fontWeight: 800, color: C.text }}>Expédié ✓</span>
        </div>
        <div style={{ background: "#ecfdf5", border: "1px solid #6ee7b7", borderRadius: 12, padding: 20, marginBottom: 16, textAlign: "center" as const }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>✅</div>
          <div style={{ fontWeight: 700, fontSize: 17, color: C.green, marginBottom: 4 }}>{done.pickingName}</div>
          <div style={{ fontSize: 13, color: "#065f46" }}>Commande expédiée et stock mis à jour</div>
        </div>
        <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, marginBottom: 12 }}>
          <div style={{ fontSize: 13, color: C.textMuted, display: "flex", flexDirection: "column" as const, gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 16 }}>{done.blPrinted ? "🖨️" : "⚠️"}</span>
              <span style={{ color: done.blPrinted ? C.green : C.warning }}>
                Bon de livraison {done.blPrinted ? "imprimé" : "non imprimé (configurer imprimante BL)"}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 16 }}>{done.labelPrinted ? "🖨️" : (done.labelCount > 0 ? "⚠️" : "ℹ️")}</span>
              <span style={{ color: done.labelPrinted ? C.green : (done.labelCount > 0 ? C.warning : C.textMuted) }}>
                {done.labelCount > 0
                  ? `${Math.min(done.labelCount, nPackages)} étiquette${nPackages > 1 ? "s" : ""} ${done.labelPrinted ? "imprimée" + (nPackages > 1 ? "s" : "") : "disponible" + (nPackages > 1 ? "s" : "") + " (configurer imprimante)"}`
                  : "Aucune étiquette TNT (vérifier transporteur)"}
              </span>
            </div>
          </div>
        </div>
        <button onClick={() => { setDone(null); setView("list"); }}
          style={{ width: "100%", padding: "14px 0", background: C.blue, color: "#fff", border: "none", borderRadius: 12, fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
          Commande suivante
        </button>
        {showPrinterModal && <PrinterModal />}
      </>
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  // RENDER — Detail
  // ────────────────────────────────────────────────────────────────────────────
  if (view === "detail") {
    return (
      <>
        {/* Back row */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <button onClick={() => initialPickingId ? onBack() : setView("list")}
            style={{ background: "none", border: "none", cursor: "pointer", padding: 4, color: C.textMuted, display: "flex" }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 800, color: C.text, letterSpacing: -0.3 }}>{selectedName}</div>
            {selectedPartner && <div style={{ fontSize: 12, color: C.textMuted }}>{selectedPartner}</div>}
          </div>
          <button onClick={openPrinterModal} title="Imprimantes"
            style={{ position: "relative", background: (blPrinterId || labelPrinterId) ? C.teal + "18" : "none", border: "none", cursor: "pointer", padding: 6, color: (blPrinterId || labelPrinterId) ? C.teal : C.textMuted, borderRadius: 8 }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/>
              <rect x="6" y="14" width="12" height="8"/>
            </svg>
            {(blPrinterId || labelPrinterId) && (
              <span style={{ position: "absolute", top: 2, right: 2, width: 6, height: 6, background: C.teal, borderRadius: "50%", border: "1.5px solid #fff" }} />
            )}
          </button>
        </div>

        {selectedOrigin && (
          <div style={{ background: C.blueSoft, border: "1px solid #bfdbfe", borderRadius: 10, padding: "8px 14px", marginBottom: 12, fontSize: 12, color: "#1d4ed8", fontWeight: 500 }}>
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
          <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14, marginBottom: 16, boxShadow: C.shadow }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: 0.4 }}>
                Articles ({lines.length})
              </div>
              {lines.length > 8 && (
                <button onClick={() => setShowAllLines(v => !v)}
                  style={{ fontSize: 12, fontWeight: 600, color: C.blue, background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                  {showAllLines ? "Réduire ▲" : `Voir tout (${lines.length}) ▼`}
                </button>
              )}
            </div>
            {(showAllLines ? lines : lines.slice(0, 8)).map((l, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "7px 0", borderTop: i > 0 ? `1px solid ${C.border}` : "none" }}>
                <div style={{ flex: 1, paddingRight: 8 }}>
                  {l.productRef && <div style={{ fontSize: 11, fontWeight: 700, color: C.blue }}>{l.productRef}</div>}
                  <div style={{ fontSize: 13, color: C.text, fontWeight: 500 }}>{l.productName}</div>
                  {l.lotName && <div style={{ fontSize: 11, color: C.textMuted }}>Lot {l.lotName}</div>}
                </div>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.text, whiteSpace: "nowrap" as const }}>
                  {l.qty} {l.uomName}
                </div>
              </div>
            ))}
            {!showAllLines && lines.length > 8 && (
              <button onClick={() => setShowAllLines(true)}
                style={{ width: "100%", marginTop: 8, paddingTop: 8, paddingBottom: 2, fontSize: 12, color: C.blue, fontWeight: 600, background: "none", border: "none", borderTop: `1px solid ${C.border}`, cursor: "pointer", textAlign: "center" as const }}>
                +{lines.length - 8} article{lines.length - 8 > 1 ? "s" : ""} — Voir tout ▼
              </button>
            )}
          </div>
        )}

        {/* Conditionnement */}
        <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, marginBottom: 14, boxShadow: C.shadow }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 14 }}>Conditionnement</div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
            <div style={{ fontSize: 14, color: C.text, fontWeight: 500 }}>Nombre de colis</div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button onClick={() => setNPackages(n => Math.max(1, n - 1))}
                style={{ width: 36, height: 36, borderRadius: 8, border: `1px solid ${C.border}`, background: C.bg, cursor: "pointer", fontSize: 20, display: "flex", alignItems: "center", justifyContent: "center", color: C.text, fontWeight: 700 }}>−</button>
              <span style={{ fontSize: 20, fontWeight: 800, color: C.text, minWidth: 32, textAlign: "center" as const }}>{nPackages}</span>
              <button onClick={() => setNPackages(n => Math.min(20, n + 1))}
                style={{ width: 36, height: 36, borderRadius: 8, border: `1px solid ${C.border}`, background: C.bg, cursor: "pointer", fontSize: 20, display: "flex", alignItems: "center", justifyContent: "center", color: C.text, fontWeight: 700 }}>+</button>
            </div>
          </div>
          {weights.map((w, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <div style={{ fontSize: 13, color: C.text }}>
                Colis {i + 1}{nPackages === 1 && <span style={{ fontSize: 12, color: C.textMuted }}> (poids total)</span>}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={w}
                  onChange={e => setWeights(prev => { const next = [...prev]; next[i] = e.target.value; return next; })}
                  style={{ width: 80, height: 38, textAlign: "right" as const, fontSize: 15, fontWeight: 700, color: C.text, border: `2px solid ${w && parseWeight(w) > 0 ? C.teal : C.border}`, borderRadius: 8, outline: "none", fontFamily: "inherit", paddingRight: 8 }}
                />
                <span style={{ fontSize: 13, color: C.textMuted, width: 24 }}>kg</span>
              </div>
            </div>
          ))}
          {nPackages > 1 && totalWeight > 0 && (
            <div style={{ display: "flex", justifyContent: "flex-end", paddingTop: 10, borderTop: `1px solid ${C.border}`, marginTop: 4 }}>
              <span style={{ fontSize: 13, color: C.textMuted }}>Total : </span>
              <span style={{ fontSize: 13, fontWeight: 700, color: C.text, marginLeft: 6 }}>{totalWeight.toFixed(2)} kg</span>
            </div>
          )}
        </div>

        {/* Imprimantes configurées */}
        <div style={{ display: "flex", gap: 8, marginBottom: 80, flexWrap: "wrap" as const }}>
          {blPrinterId ? (
            <span style={{ fontSize: 11, color: C.teal, background: C.teal + "12", borderRadius: 6, padding: "3px 8px", fontWeight: 600 }}>
              🖨️ BL : {printerList.find(p => p.id === blPrinterId)?.name || `#${blPrinterId}`}
            </span>
          ) : (
            <span style={{ fontSize: 11, color: C.textMuted, background: C.bg, borderRadius: 6, padding: "3px 8px" }}>⚠️ Aucune imprimante BL</span>
          )}
          {labelPrinterId ? (
            <span style={{ fontSize: 11, color: C.teal, background: C.teal + "12", borderRadius: 6, padding: "3px 8px", fontWeight: 600 }}>
              🏷️ Étiq. : {printerList.find(p => p.id === labelPrinterId)?.name || `#${labelPrinterId}`}
            </span>
          ) : (
            <span style={{ fontSize: 11, color: C.textMuted, background: C.bg, borderRadius: 6, padding: "3px 8px" }}>⚠️ Aucune imprimante étiquette</span>
          )}
        </div>

        {/* Bottom fixed button */}
        <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: C.white, borderTop: `1px solid ${C.border}`, padding: "12px 16px" }}>
          <button onClick={validate} disabled={packing || !allWeightsFilled || loadingDetail}
            style={{ width: "100%", padding: "15px 0", background: packing ? "#93c5fd" : !allWeightsFilled ? "#e5e7eb" : C.teal, color: !allWeightsFilled ? C.textMuted : "#fff", border: "none", borderRadius: 12, fontSize: 15, fontWeight: 700, cursor: packing || !allWeightsFilled ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, fontFamily: "inherit" }}>
            {packing ? (
              <><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" style={{ animation: "spin 1s linear infinite" }}><path d="M21 12a9 9 0 11-2.64-6.36"/></svg>Expédition en cours…</>
            ) : (
              <><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>Valider & Imprimer</>
            )}
          </button>
          {!allWeightsFilled && !packing && (
            <div style={{ fontSize: 12, color: C.textMuted, textAlign: "center" as const, marginTop: 6 }}>Renseignez le poids de chaque colis</div>
          )}
        </div>

        {showPrinterModal && <PrinterModal />}
      </>
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  // RENDER — List
  // ────────────────────────────────────────────────────────────────────────────
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: C.text, margin: 0 }}>Emballage</h2>
          <p style={{ fontSize: 12, color: C.textMuted, margin: 0, marginTop: 2 }}>{pickings.length} commande{pickings.length > 1 ? "s" : ""} prête{pickings.length > 1 ? "s" : ""} à expédier</p>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={openPrinterModal} title="Configurer imprimantes"
            style={{ position: "relative", background: (blPrinterId || labelPrinterId) ? C.teal + "18" : C.blueSoft, border: "none", cursor: "pointer", padding: "8px 10px", borderRadius: 10, color: (blPrinterId || labelPrinterId) ? C.teal : C.textMuted }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/>
              <rect x="6" y="14" width="12" height="8"/>
            </svg>
            {(blPrinterId || labelPrinterId) && (
              <span style={{ position: "absolute", top: 4, right: 4, width: 6, height: 6, background: C.teal, borderRadius: "50%", border: "1.5px solid #fff" }} />
            )}
          </button>
          <button onClick={loadList} disabled={loadingList} style={{ background: C.blueSoft, border: "none", cursor: "pointer", padding: "8px 12px", borderRadius: 10, color: C.blue }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
          </button>
        </div>
      </div>

      {/* Scan bar */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          style={{ flex: 1, padding: "11px 13px", border: `1px solid ${C.border}`, borderRadius: 9, fontSize: 14, fontFamily: "inherit", background: C.white, color: C.text, fontWeight: 600, outline: "none" }}
          value={scanCode}
          onChange={e => { setScanCode(e.target.value); if (scanError) setScanError(""); }}
          onKeyDown={e => {
            if (e.key === "Enter") {
              // Lire la valeur DOM directement (évite la closure périmée quand le scanner tape vite)
              const val = (e.currentTarget as HTMLInputElement).value;
              if (val.trim()) { setScanCode(val); handleScan(val); }
            }
          }}
          placeholder="Scanner WH/OUT/... ou numéro S (ex: S66191)"
        />
        <button onClick={() => { if (scanCode.trim()) handleScan(scanCode); }}
          style={{ padding: "11px 16px", background: C.text, color: "#fff", border: "none", borderRadius: 9, fontWeight: 700, fontSize: 14, cursor: "pointer", whiteSpace: "nowrap" as const }}>
          →
        </button>
      </div>
      {scanError && (
        <div style={{ marginBottom: 10, padding: "8px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, fontSize: 13, color: C.danger, fontWeight: 600 }}>{scanError}</div>
      )}

      {loadingList && <div style={{ textAlign: "center", padding: 40, color: C.textMuted }}>Chargement…</div>}
      {!loadingList && error && <div style={{ background: "#fef2f2", border: `1px solid #fecaca`, borderRadius: 10, padding: 14, color: C.danger, fontSize: 14 }}>{error}</div>}
      {!loadingList && !error && pickings.length === 0 && (
        <div style={{ textAlign: "center", padding: 50 }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>📦</div>
          <div style={{ color: C.textMuted, fontSize: 15 }}>Aucune commande à emballer</div>
        </div>
      )}

      {!loadingList && pickings.map(p => (
        <div key={p.id} style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, marginBottom: 10, boxShadow: C.shadow }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
            <span style={{ fontSize: 18, fontWeight: 800, color: C.text, letterSpacing: -0.3 }}>{p.name}</span>
            <span style={{ fontSize: 10, fontWeight: 700, color: C.teal, background: C.teal + "18", borderRadius: 6, padding: "2px 8px" }}>Prêt</span>
          </div>
          {p.partnerName && <div style={{ fontSize: 13, fontWeight: 600, color: C.textSec, marginBottom: 4 }}>{p.partnerName}</div>}
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10, flexWrap: "wrap" as const }}>
            {p.origin && <span style={{ fontSize: 11, color: C.textMuted }}>{p.origin}</span>}
            {p.carrierId && <span style={{ fontSize: 11, fontWeight: 700, color: "#7c3aed", background: "#f5f3ff", padding: "1px 7px", borderRadius: 5 }}>{p.carrierId}</span>}
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <span style={{ fontSize: 11, color: C.textMuted }}>{p.lineCount} article{p.lineCount > 1 ? "s" : ""}</span>
            {p.date && <span style={{ fontSize: 11, color: C.textMuted }}>{new Date(p.date).toLocaleDateString("fr-FR")}</span>}
          </div>
          <button onClick={() => openDetail(p.id, p.name, p.partnerName, p.origin)}
            style={{ width: "100%", padding: "11px 0", background: C.text, color: "#fff", border: "none", borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
            Emballer
          </button>
        </div>
      ))}

      {showPrinterModal && <PrinterModal />}
    </>
  );
}
