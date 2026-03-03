"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import * as odoo from "@/lib/odoo";
import * as pn from "@/lib/printnode";

// ============================================
// DESIGN TOKENS
// ============================================
const C = {
  bg: "#f5f6f8", white: "#ffffff", card: "#ffffff", overlay: "rgba(0,0,0,0.04)",
  blue: "#2563eb", blueSoft: "#eff6ff", blueBorder: "#bfdbfe", blueDark: "#1d4ed8",
  green: "#16a34a", greenSoft: "#f0fdf4", greenBorder: "#bbf7d0",
  orange: "#ea580c", orangeSoft: "#fff7ed", orangeBorder: "#fed7aa",
  red: "#dc2626", redSoft: "#fef2f2", redBorder: "#fecaca",
  text: "#111827", textSec: "#4b5563", textMuted: "#9ca3af",
  border: "#e5e7eb", borderStrong: "#d1d5db",
  shadow: "0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04)",
  shadowLg: "0 4px 12px rgba(0,0,0,0.1)",
};

// ============================================
// HAPTICS
// ============================================
function vibrate(pattern: number | number[] = 30) {
  try { navigator?.vibrate?.(pattern); } catch {}
}
function vibrateSuccess() { vibrate([30, 50, 30]); }
function vibrateError() { vibrate([100, 30, 100]); }

// ============================================
// LABEL PRINTING — PrintNode ZPL → fallback popup
// ============================================
async function doPrintProduct(productName: string, barcode: string) {
  const printerId = pn.getSavedPrinterId();
  if (printerId && process.env.NEXT_PUBLIC_PRINTNODE_API_KEY) {
    return pn.printProductLabel(printerId, productName, barcode);
  }
  printLabelPopup(productName, barcode, barcode);
  return { success: true };
}

async function doPrintLot(lotName: string, productName: string, lotBarcode: string) {
  const printerId = pn.getSavedPrinterId();
  if (printerId && process.env.NEXT_PUBLIC_PRINTNODE_API_KEY) {
    return pn.printLotLabel(printerId, lotName, productName, lotBarcode);
  }
  printLabelPopup(`${lotName} — ${productName}`, lotBarcode, lotBarcode);
  return { success: true };
}

async function doPrintLocation(locationName: string, locationBarcode: string) {
  const printerId = pn.getSavedPrinterId();
  if (printerId && process.env.NEXT_PUBLIC_PRINTNODE_API_KEY) {
    return pn.printLocationLabel(printerId, locationName, locationBarcode);
  }
  printLabelPopup(locationName, locationBarcode, locationBarcode);
  return { success: true };
}

function printLabelPopup(title: string, barcode: string, displayCode: string) {
  const sz = pn.getLabelSize();
  const w = window.open("", "_blank", "width=400,height=320,menubar=no,toolbar=no");
  if (!w) return;

  const isEAN = /^\d{8}$|^\d{13}$/.test(barcode);
  const bcFormat = isEAN ? (barcode.length === 8 ? "EAN8" : "EAN13") : "CODE128";

  w.document.write(`<!DOCTYPE html>
<html><head>
<style>
  @page { size: ${sz.widthMM}mm ${sz.heightMM}mm; margin: 0; }
  @media print { body { margin: 0; padding: 0; } .no-print { display: none !important; } }
  body { margin: 0; padding: 8px; font-family: Arial, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; }
  .label { width: ${sz.widthMM - 4}mm; padding: 2mm; display: flex; flex-direction: column; align-items: center; text-align: center; }
  .title { font-size: 9pt; font-weight: 700; margin-bottom: 2mm; max-width: ${sz.widthMM - 6}mm; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; line-height: 1.2; }
  canvas { max-width: ${sz.widthMM - 8}mm; }
  .code { font-size: 7pt; font-family: monospace; margin-top: 1mm; letter-spacing: 1px; }
</style>
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"><\/script>
</head>
<body>
  <div class="label">
    <div class="title">${title.replace(/"/g, "&quot;")}</div>
    <canvas id="bc"></canvas>
    <div class="code">${displayCode}</div>
  </div>
  <button class="no-print" onclick="window.print()" style="margin-top:16px;padding:10px 24px;font-size:14px;font-weight:700;background:#2563eb;color:#fff;border:none;border-radius:8px;cursor:pointer;">Imprimer</button>
  <script>
    try { JsBarcode("#bc", "${barcode}", { format: "${bcFormat}", width: 2, height: 50, displayValue: false, margin: 0 }); }
    catch(e) { try { JsBarcode("#bc", "${barcode}", { format: "CODE128", width: 2, height: 50, displayValue: false, margin: 0 }); } catch(e2) {} }
    setTimeout(() => window.print(), 600);
  <\/script>
</body></html>`);
  w.document.close();
}

// ============================================
// HISTORY (localStorage)
// ============================================
const HIST_KEY = "wms_history";
interface HistoryEntry { date: string; from: string; to: string; lineCount: number; products: string[]; }
function saveHistory(entry: HistoryEntry) {
  try {
    const h: HistoryEntry[] = JSON.parse(localStorage.getItem(HIST_KEY) || "[]");
    h.unshift(entry);
    localStorage.setItem(HIST_KEY, JSON.stringify(h.slice(0, 30)));
  } catch {}
}
function loadHistory(): HistoryEntry[] {
  try { return JSON.parse(localStorage.getItem(HIST_KEY) || "[]"); } catch { return []; }
}

// ============================================
// SCANNER HOOK — Global Zebra key trapping
// ============================================
function useScannerListener(onScan: (code: string) => void, enabled: boolean) {
  const buf = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cb = useRef(onScan);
  cb.current = onScan;

  useEffect(() => {
    if (!enabled) return;
    const handle = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement;
      const inInput = tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.tagName === "SELECT";
      if (e.key === "Enter") {
        if (buf.current.length >= 3) {
          e.preventDefault(); e.stopPropagation();
          const code = buf.current; buf.current = "";
          if (timer.current) { clearTimeout(timer.current); timer.current = null; }
          cb.current(code);
          if (inInput && tgt instanceof HTMLInputElement) {
            const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
            if (s) { s.call(tgt, ""); tgt.dispatchEvent(new Event("input", { bubbles: true })); }
          }
          return;
        }
        buf.current = "";
        if (timer.current) { clearTimeout(timer.current); timer.current = null; }
        return;
      }
      if (e.key.length !== 1) return;
      buf.current += e.key;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => { buf.current = ""; timer.current = null; }, 50);
    };
    window.addEventListener("keydown", handle, true);
    return () => { window.removeEventListener("keydown", handle, true); if (timer.current) clearTimeout(timer.current); };
  }, [enabled]);
}

// Session
function saveSession(s: odoo.OdooSession) { try { sessionStorage.setItem("wms_s", JSON.stringify(s)); } catch {} }
function loadSess(): odoo.OdooSession | null { try { const s = sessionStorage.getItem("wms_s"); return s ? JSON.parse(s) : null; } catch { return null; } }
function clearSess() { try { sessionStorage.removeItem("wms_s"); } catch {} }
function saveCfg(u: string, d: string) { try { localStorage.setItem("wms_c", JSON.stringify({ u, d })); } catch {} }
function loadCfg(): { u: string; d: string } | null { try { const c = localStorage.getItem("wms_c"); return c ? JSON.parse(c) : null; } catch { return null; } }

// ============================================
// MAIN APP
// ============================================
export default function Page() {
  const [screen, setScreen] = useState<"login" | "home" | "transfer" | "done" | "prep" | "prepDetail" | "settings">("login");
  const [session, setSession] = useState<odoo.OdooSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [locations, setLocations] = useState<any[]>([]);
  const [toast, setToast] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  // Transfer mode
  const [transferMode, setTransferMode] = useState<"classic" | "quick">("classic");

  // Lookup
  const [lookupResult, setLookupResult] = useState<any>(null);
  const [lookupStock, setLookupStock] = useState<any[]>([]);
  const [lookupType, setLookupType] = useState("");

  // Transfer state
  const [src, setSrc] = useState<any>(null);
  const [dst, setDst] = useState<any>(null);
  const [srcContent, setSrcContent] = useState<any[]>([]);
  const [dstContent, setDstContent] = useState<any[]>([]);
  const [lines, setLines] = useState<any[]>([]);
  const [curProduct, setCurProduct] = useState<any>(null);
  const [curLot, setCurLot] = useState<any>(null);
  const [curStock, setCurStock] = useState<any[]>([]);
  const [allStock, setAllStock] = useState<any[]>([]);
  const [feedback, setFeedback] = useState<{ t: string; m: string } | null>(null);

  // Preparation state
  const [pickings, setPickings] = useState<any[]>([]);
  const [selectedPicking, setSelectedPicking] = useState<any>(null);
  const [pickingMoves, setPickingMoves] = useState<any[]>([]);
  const [pickingMoveLines, setPickingMoveLines] = useState<any[]>([]);
  const [prepScanned, setPrepScanned] = useState<Set<number>>(new Set());

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(""), 2200); };

  // Global scan
  const handleGlobalScan = useCallback((code: string) => {
    vibrate();
    showToast(`⚡ ${code}`);
    if (screen === "home") doLookup(code);
    else if (screen === "transfer") {
      if (transferMode === "classic") doClassicScan(code);
      else doQuickScan(code);
    }
    else if (screen === "prepDetail") doPrepScan(code);
    setTimeout(() => {
      document.querySelectorAll("input").forEach((el) => {
        if (el.value === code || el.value.includes(code)) {
          const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
          if (s) { s.call(el, ""); el.dispatchEvent(new Event("input", { bubbles: true })); }
        }
      });
    }, 10);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, session, src, dst, transferMode]);

  useScannerListener(handleGlobalScan, screen !== "login");

  // Init
  useEffect(() => {
    const s = loadSess();
    if (s) { setSession(s); setScreen("home"); setHistory(loadHistory()); odoo.getLocations(s).then(setLocations).catch(() => { clearSess(); setScreen("login"); }); }
  }, []);

  const login = async (url: string, db: string, user: string, pw: string) => {
    setLoading(true); setError("");
    try {
      const cfg = { url: url.replace(/\/$/, ""), db };
      const s = await odoo.authenticate(cfg, user, pw);
      setSession(s); saveSession(s); saveCfg(url, db);
      setLocations(await odoo.getLocations(s));
      setHistory(loadHistory());
      setScreen("home");
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const logout = () => { setSession(null); clearSess(); setScreen("login"); resetTransfer(); };
  const goHome = () => { setScreen("home"); resetTransfer(); clearLookup(); };

  // Lookup
  const clearLookup = () => { setLookupResult(null); setLookupStock([]); setLookupType(""); setError(""); };
  const doLookup = async (code: string) => {
    if (!code || !session) return;
    setLoading(true); setError(""); clearLookup();
    try {
      const r = await odoo.smartScan(session, code);
      if (r.type === "product") { setLookupResult(r.data); setLookupType("product"); setLookupStock(await odoo.getAllStockForProduct(session, r.data.id)); vibrateSuccess(); }
      else if (r.type === "lot") { setLookupResult(r.data); setLookupType("lot"); if (r.data.product) setLookupStock(await odoo.getStockForLot(session, r.data.lot.id, r.data.product.id)); vibrateSuccess(); }
      else if (r.type === "location") { setLookupResult(r.data); setLookupType("location"); setLookupStock(await odoo.getProductsAtLocation(session, r.data.id)); vibrateSuccess(); }
      else { setError(`"${code}" — introuvable`); vibrateError(); }
    } catch (e: any) { setError(e.message); vibrateError(); }
    setLoading(false);
  };

  // Transfer
  const resetTransfer = () => { setSrc(null); setDst(null); setSrcContent([]); setDstContent([]); setLines([]); setCurProduct(null); setCurLot(null); setCurStock([]); setAllStock([]); setFeedback(null); setError(""); };
  const loadContent = async (locId: number) => { if (!session) return []; try { return await odoo.getProductsAtLocation(session, locId); } catch { return []; } };

  // === CLASSIC MODE ===
  const doClassicScan = async (code: string) => {
    if (!code || !session) return;
    setLoading(true); setError(""); setFeedback(null); setCurProduct(null); setCurLot(null); setCurStock([]);
    try {
      const r = await odoo.smartScan(session, code);
      if (r.type === "location") {
        if (!src) { setSrc(r.data); setFeedback({ t: "ok", m: `Source → ${r.data.name}` }); setSrcContent(await loadContent(r.data.id)); vibrateSuccess(); }
        else if (!dst) { setDst(r.data); setFeedback({ t: "ok", m: `Dest → ${r.data.name}` }); setDstContent(await loadContent(r.data.id)); vibrateSuccess(); }
        else { setFeedback({ t: "info", m: `${r.data.name}` }); vibrate(); }
      } else if (r.type === "product") {
        if (!src) { setFeedback({ t: "warn", m: "Scanne un emplacement source d'abord" }); vibrateError(); }
        else { setCurProduct(r.data); setFeedback({ t: "ok", m: r.data.name }); setCurStock(await odoo.getStockAtLocation(session, r.data.id, src.id)); vibrateSuccess(); }
      } else if (r.type === "lot") {
        if (!src) { setFeedback({ t: "warn", m: "Scanne un emplacement source d'abord" }); vibrateError(); }
        else { setCurProduct(r.data.product); setCurLot(r.data.lot); setFeedback({ t: "ok", m: `Lot ${r.data.lot.name}` }); if (r.data.product) setCurStock(await odoo.getStockAtLocation(session, r.data.product.id, src.id)); vibrateSuccess(); }
      } else { setFeedback({ t: "err", m: `"${code}" introuvable` }); vibrateError(); }
    } catch (e: any) { setError(e.message); vibrateError(); }
    setLoading(false);
  };

  // === QUICK MODE ===
  const doQuickScan = async (code: string) => {
    if (!code || !session) return;
    setLoading(true); setError(""); setFeedback(null); setCurProduct(null); setCurLot(null); setCurStock([]); setAllStock([]); setSrc(null); setDst(null);
    try {
      const r = await odoo.smartScan(session, code);
      if (r.type === "product") {
        setCurProduct(r.data);
        const stock = await odoo.getAllStockForProduct(session, r.data.id);
        setAllStock(stock);
        setFeedback({ t: "ok", m: r.data.name });
        vibrateSuccess();
      } else if (r.type === "lot") {
        setCurProduct(r.data.product); setCurLot(r.data.lot);
        if (r.data.product) {
          const stock = await odoo.getAllStockForProduct(session, r.data.product.id);
          setAllStock(stock);
        }
        setFeedback({ t: "ok", m: `Lot ${r.data.lot.name}` });
        vibrateSuccess();
      } else if (r.type === "location") {
        setFeedback({ t: "info", m: `📍 ${r.data.name} — scanne un produit en mode rapide` });
        vibrate();
      } else { setFeedback({ t: "err", m: `"${code}" introuvable` }); vibrateError(); }
    } catch (e: any) { setError(e.message); vibrateError(); }
    setLoading(false);
  };

  const selectSrcFromStock = (loc: any) => {
    setSrc(loc);
    if (curProduct) {
      const filtered = allStock.filter((q: any) => q.location_id[0] === loc.id);
      setCurStock(filtered);
    }
    vibrateSuccess();
  };

  const addLine = (qty: number, lotId?: number | null, lotName?: string | null) => {
    if (!curProduct) return;
    const line = { productId: curProduct.id, productName: curProduct.name, productCode: curProduct.default_code, qty, uomId: curProduct.uom_id[0], uomName: curProduct.uom_id[1], lotId: lotId || curLot?.id || null, lotName: lotName || curLot?.name || null };

    if (transferMode === "quick" && src && dst) {
      // Mode rapide → validation immédiate
      quickValidate(line);
    } else {
      // Mode classique → ajouter à la liste
      setLines(p => [...p, line]);
      setCurProduct(null); setCurLot(null); setCurStock([]); setAllStock([]); setFeedback(null);
      vibrateSuccess();
    }
  };

  const quickValidate = async (line: any) => {
    if (!session || !src || !dst) return;
    setLoading(true); setError("");
    try {
      const pid = await odoo.createInternalTransfer(session, src.id, dst.id, [line]);
      await odoo.validatePicking(session, pid);
      const entry: HistoryEntry = { date: new Date().toISOString(), from: src.name, to: dst.name, lineCount: 1, products: [line.productName] };
      saveHistory(entry);
      setHistory(loadHistory());
      vibrateSuccess();
      // Reset pour le prochain scan — on reste en mode transfert rapide
      setCurProduct(null); setCurLot(null); setCurStock([]); setAllStock([]); setSrc(null); setDst(null);
      setFeedback({ t: "ok", m: `✅ ${line.productName} · ${line.qty} ${line.uomName} → ${dst.name}` });
    } catch (e: any) { setError(e.message); vibrateError(); }
    setLoading(false);
  };

  const validate = async () => {
    if (!session || !src || !dst || !lines.length) return;
    setLoading(true); setError("");
    try {
      const pid = await odoo.createInternalTransfer(session, src.id, dst.id, lines);
      await odoo.validatePicking(session, pid);
      const entry: HistoryEntry = { date: new Date().toISOString(), from: src.name, to: dst.name, lineCount: lines.length, products: lines.map(l => l.productName) };
      saveHistory(entry);
      setHistory(loadHistory());
      vibrateSuccess();
      setScreen("done");
    } catch (e: any) { setError(e.message); vibrateError(); }
    setLoading(false);
  };

  const rename = async (id: number, name: string) => {
    if (!session) return;
    try { await odoo.renameLocation(session, id, name); setLocations(await odoo.getLocations(session)); } catch {}
  };

  // ===================== PREPARATION =====================
  const loadPickings = async () => {
    if (!session) return;
    setLoading(true); setError("");
    try {
      const p = await odoo.getOutgoingPickings(session);
      setPickings(p);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const openPicking = async (picking: any) => {
    if (!session) return;
    setLoading(true); setError("");
    setSelectedPicking(picking);
    setPrepScanned(new Set());
    try {
      const moves = await odoo.getPickingMoves(session, picking.id);
      const mlines = await odoo.getPickingMoveLines(session, picking.id);
      setPickingMoves(moves);
      setPickingMoveLines(mlines);
      // Mark already done lines as scanned
      const done = new Set<number>();
      mlines.forEach((ml: any) => { if (ml.qty_done > 0) done.add(ml.id); });
      setPrepScanned(done);
      setScreen("prepDetail");
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const doPrepScan = async (code: string) => {
    if (!code || !session || !selectedPicking) return;
    setError("");
    try {
      const r = await odoo.smartScan(session, code);
      if (r.type === "product" || r.type === "lot") {
        const productId = r.type === "product" ? r.data.id : r.data.product?.id;
        const lotId = r.type === "lot" ? r.data.lot.id : null;
        if (!productId) { showToast("Produit inconnu"); vibrateError(); return; }

        // Find matching move line not yet scanned
        const ml = pickingMoveLines.find((m: any) =>
          m.product_id[0] === productId && !prepScanned.has(m.id) &&
          (!lotId || !m.lot_id || m.lot_id[0] === lotId)
        );
        if (ml) {
          const qtyToSet = ml.reserved_uom_qty || 1;
          await odoo.setMoveLineQtyDone(session, ml.id, qtyToSet, lotId);
          setPrepScanned(prev => { const n = new Set(Array.from(prev)); n.add(ml.id); return n; });
          // Refresh move lines
          setPickingMoveLines(await odoo.getPickingMoveLines(session, selectedPicking.id));
          vibrateSuccess();
          showToast(`✓ ${r.type === "lot" ? r.data.lot.name : r.data.name}`);
        } else {
          showToast("Déjà scanné ou pas dans cette commande");
          vibrateError();
        }
      } else {
        showToast(`"${code}" non trouvé dans cette commande`);
        vibrateError();
      }
    } catch (e: any) { setError(e.message); vibrateError(); }
  };

  const autoFillPicking = async () => {
    if (!session || !selectedPicking) return;
    setLoading(true);
    try {
      await odoo.autoFillPicking(session, selectedPicking.id);
      const mlines = await odoo.getPickingMoveLines(session, selectedPicking.id);
      setPickingMoveLines(mlines);
      const done = new Set<number>();
      mlines.forEach((ml: any) => { if (ml.qty_done > 0) done.add(ml.id); });
      setPrepScanned(done);
      vibrateSuccess();
      showToast("Toutes les quantités remplies");
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const validatePrepPicking = async () => {
    if (!session || !selectedPicking) return;
    setLoading(true); setError("");
    try {
      await odoo.validatePicking(session, selectedPicking.id);
      vibrateSuccess();
      showToast(`✅ ${selectedPicking.name} validé`);
      setScreen("prep");
      setSelectedPicking(null);
      await loadPickings(); // refresh list
    } catch (e: any) { setError(e.message); vibrateError(); }
    setLoading(false);
  };

  const checkPickingAvailability = async (pickingId: number) => {
    if (!session) return;
    setLoading(true);
    try {
      await odoo.checkAvailability(session, pickingId);
      await loadPickings();
      vibrateSuccess();
      showToast("Disponibilité vérifiée");
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const openPickingReport = (pickingId: number) => {
    if (!session) return;
    const url = odoo.getPickingReportUrl(session, pickingId);
    window.open(url, "_blank");
  };

  // ===================== RENDER =====================
  const classicStep = !src ? 0 : !dst ? 1 : 2;

  if (screen === "login") return <Login onLogin={login} loading={loading} error={error} />;

  return (
    <Shell toast={toast}>
      <Header name={session?.name} onLogout={logout} onHome={goHome} onSettings={() => setScreen("settings")} />

      <main style={{ maxWidth: 480, margin: "0 auto", padding: "16px 16px 100px" }}>

        {/* ===== HOME ===== */}
        {screen === "home" && <>
          <Section>
            <SectionHeader icon={scanIcon} title="Recherche rapide" sub="Scanne ou tape un code" />
            <InputBar onSubmit={doLookup} placeholder="Code-barres, référence, lot, emplacement..." />
          </Section>

          {error && <Alert type="error">{error}</Alert>}
          {lookupType === "product" && lookupResult && <ProductResult product={lookupResult} stock={lookupStock} />}
          {lookupType === "lot" && lookupResult && <LotResult lot={lookupResult.lot} product={lookupResult.product} stock={lookupStock} />}
          {lookupType === "location" && lookupResult && <LocationResult location={lookupResult} stock={lookupStock} />}

          <div style={{ marginTop: 16 }}>
            <BigButton icon={transferIcon("#fff")} label="Transfert interne" sub="Déplacer du stock entre emplacements" onClick={() => { resetTransfer(); setScreen("transfer"); }} />
            <div style={{ height: 10 }} />
            <BigButton icon={prepIcon} label="Préparation" sub="Commandes à préparer et expédier" color="#7c3aed" onClick={() => { loadPickings(); setScreen("prep"); }} />
          </div>

          {/* History */}
          {history.length > 0 && (
            <Section style={{ marginTop: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
                {clockIcon}
                Derniers transferts
              </div>
              {history.slice(0, 5).map((h, i) => (
                <div key={i} style={{ padding: "8px 0", borderBottom: i < Math.min(history.length, 5) - 1 ? `1px solid ${C.border}` : "none", fontSize: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontWeight: 600, color: C.text }}>{h.from} → {h.to}</span>
                    <span style={{ color: C.textMuted, fontSize: 10 }}>{new Date(h.date).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                  </div>
                  <div style={{ color: C.textMuted, fontSize: 11, marginTop: 2 }}>{h.lineCount} ligne(s) · {h.products.slice(0, 2).join(", ")}{h.products.length > 2 ? "..." : ""}</div>
                </div>
              ))}
            </Section>
          )}

          {/* PrintNode printer config — moved to settings */}
        </>}

        {/* ===== TRANSFER ===== */}
        {screen === "transfer" && <>
          {/* Mode toggle */}
          <div style={{ display: "flex", background: C.white, borderRadius: 10, border: `1px solid ${C.border}`, overflow: "hidden", marginBottom: 16 }}>
            {(["classic", "quick"] as const).map(m => (
              <button key={m} onClick={() => { setTransferMode(m); resetTransfer(); }}
                style={{ flex: 1, padding: "10px 0", fontSize: 13, fontWeight: 700, cursor: "pointer", border: "none", fontFamily: "inherit", transition: "all .15s",
                  background: transferMode === m ? C.blue : "transparent",
                  color: transferMode === m ? "#fff" : C.textSec,
                }}>
                {m === "classic" ? "📋 Classique" : "⚡ Rapide"}
              </button>
            ))}
          </div>

          {/* CLASSIC MODE */}
          {transferMode === "classic" && <>
            <StepIndicator step={classicStep} steps={["Source", "Destination", "Produits"]} />
            {src && <LocCard loc={src} label="Source" content={srcContent} color={C.blue} onRename={rename} onClear={() => { setSrc(null); setSrcContent([]); }} />}
            {dst && <LocCard loc={dst} label="Destination" content={dstContent} color={C.green} onRename={rename} onClear={() => { setDst(null); setDstContent([]); }} />}

            <Section>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>
                  {classicStep === 0 ? "Scanner la source" : classicStep === 1 ? "Scanner la destination" : "Scanner un produit"}
                </span>
                {loading && <Spinner />}
              </div>
              <AutoInput locations={locations} onScan={doClassicScan} onPickLoc={(loc: any) => {
                if (!src) { setSrc(loc); setSrcContent([]); loadContent(loc.id).then(setSrcContent); vibrateSuccess(); }
                else if (!dst) { setDst(loc); setDstContent([]); loadContent(loc.id).then(setDstContent); vibrateSuccess(); }
              }} placeholder={classicStep === 0 ? "Emplacement source..." : classicStep === 1 ? "Emplacement destination..." : "Code-barres, réf, lot..."} />
            </Section>
          </>}

          {/* QUICK MODE */}
          {transferMode === "quick" && <>
            <Alert type="info">Scanne un produit → choisis source et destination</Alert>
            <Section>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>Scanner un produit</span>
                {loading && <Spinner />}
              </div>
              <InputBar onSubmit={doQuickScan} placeholder="Code-barres, référence, lot..." />
            </Section>

            {/* Product found — show all stock locations to pick from */}
            {curProduct && allStock.length > 0 && !src && (
              <Section>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 4 }}>
                  {curProduct.name}
                  {curProduct.active === false && <Chip color={C.orange}>archivé</Chip>}
                </div>
                <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 12 }}>{curProduct.default_code || ""}</div>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>D'où vient le stock ? <span style={{ fontWeight: 400, color: C.textMuted }}>(clic pour choisir)</span></div>
                {groupStockByLocation(allStock).map((loc, i) => (
                  <button key={i} onClick={() => selectSrcFromStock({ id: loc.locId, name: loc.locName })}
                    style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", padding: "12px 14px", borderRadius: 10, marginBottom: 6,
                      background: C.white, border: `1.5px solid ${C.border}`, cursor: "pointer", fontFamily: "inherit", fontSize: 13, transition: "all .1s",
                    }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ color: C.blue }}>📍</span>
                      <span style={{ fontWeight: 600, color: C.text }}>{loc.locName}</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontWeight: 700, color: loc.avail > 0 ? C.green : C.orange }}>{loc.avail}</span>
                      <span style={{ color: C.textMuted, fontSize: 11 }}>dispo</span>
                      <span style={{ color: C.blue, fontSize: 16 }}>→</span>
                    </div>
                  </button>
                ))}
              </Section>
            )}

            {/* Source chosen — choose destination */}
            {curProduct && src && !dst && (
              <Section>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, padding: "8px 12px", background: C.blueSoft, borderRadius: 8 }}>
                  <span style={{ fontSize: 12, color: C.blue, fontWeight: 600 }}>Source: {src.name}</span>
                </div>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>Destination</div>
                <LocationDropdown locations={locations} onSelect={(loc) => { setDst(loc); vibrateSuccess(); }} excludeId={src.id} />
              </Section>
            )}

            {/* Quick mode: recent validations this session */}
            {!curProduct && history.length > 0 && (
              <Section style={{ marginTop: 4 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
                  {clockIcon} Validés récemment
                </div>
                {history.slice(0, 5).map((h, i) => (
                  <div key={i} style={{ padding: "6px 0", borderBottom: i < Math.min(history.length, 5) - 1 ? `1px solid ${C.border}` : "none", fontSize: 11 }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ color: C.green, fontWeight: 600 }}>✓ {h.products[0]}</span>
                      <span style={{ color: C.textMuted }}>{new Date(h.date).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</span>
                    </div>
                    <span style={{ color: C.textMuted }}>{h.from} → {h.to}</span>
                  </div>
                ))}
              </Section>
            )}
          </>}

          {/* Common: feedback / error */}
          {feedback && <Alert type={feedback.t === "ok" ? "success" : feedback.t === "warn" ? "warning" : feedback.t === "err" ? "error" : "info"}>{feedback.m}</Alert>}
          {error && <Alert type="error">{error}</Alert>}

          {/* Product picker (both modes) */}
          {curProduct && ((transferMode === "classic") || (transferMode === "quick" && src && dst)) && (
            <ProductPicker product={curProduct} lot={curLot} stock={curStock} srcName={src?.name} onAdd={addLine}
              quickMode={transferMode === "quick"} dstName={dst?.name} loading={loading} />
          )}

          {/* Lines — classic mode only */}
          {transferMode === "classic" && lines.length > 0 && (
            <Section>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 10 }}>
                Lignes de transfert
                <span style={{ marginLeft: 8, background: C.blue, color: "#fff", padding: "2px 8px", borderRadius: 10, fontSize: 11 }}>{lines.length}</span>
              </div>
              {lines.map((l, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: i < lines.length - 1 ? `1px solid ${C.border}` : "none" }}>
                  <div style={{ width: 32, height: 32, borderRadius: 8, background: C.blueSoft, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{boxIcon(C.blue, 14)}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{l.productName}</div>
                    <div style={{ fontSize: 11, color: C.textMuted }}>{l.productCode} · {l.qty} {l.uomName}{l.lotName ? ` · ${l.lotName}` : ""}</div>
                  </div>
                  <button onClick={() => setLines(p => p.filter((_, j) => j !== i))} style={{ ...iconBtn, color: C.red }}>{trashIcon}</button>
                </div>
              ))}
            </Section>
          )}

          {/* Classic mode: destination dropdown if not set */}
          {transferMode === "classic" && lines.length > 0 && !dst && (
            <Section>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>Ou choisis une destination</div>
              <LocationDropdown locations={locations} onSelect={(loc) => { setDst(loc); setDstContent([]); loadContent(loc.id).then(setDstContent); vibrateSuccess(); }} excludeId={src?.id} />
            </Section>
          )}

          {/* Validate — classic mode */}
          {transferMode === "classic" && lines.length > 0 && dst && src && (
            <div style={{ marginTop: 16 }}>
              <BigButton
                icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>}
                label={loading ? "Envoi..." : `Valider (${lines.length} ligne${lines.length > 1 ? "s" : ""})`}
                sub={`${src.name} → ${dst.name}`}
                color={C.green}
                onClick={validate}
                disabled={loading}
              />
            </div>
          )}
          {transferMode === "classic" && lines.length > 0 && !dst && <Alert type="warning">Choisis ou scanne une destination</Alert>}
        </>}

        {/* ===== DONE ===== */}
        {screen === "done" && (
          <div style={{ textAlign: "center", paddingTop: 50, animation: "slideUp .3s" }}>
            <div style={{ width: 72, height: 72, borderRadius: "50%", background: C.greenSoft, border: `2px solid ${C.greenBorder}`, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke={C.green} strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
            <h2 style={{ fontSize: 22, fontWeight: 700, color: C.text, marginBottom: 6 }}>Transfert validé !</h2>
            <p style={{ fontSize: 14, color: C.textSec, marginBottom: 32 }}>{lines.length} ligne(s) · {src?.name} → {dst?.name}</p>
            <BigButton icon={transferIcon("#fff")} label="Nouveau transfert" onClick={() => { resetTransfer(); setScreen("transfer"); }} />
            <button onClick={goHome} style={{ ...secondaryBtn, marginTop: 12 }}>Retour à l'accueil</button>
          </div>
        )}

        {/* ===== PREPARATION LIST ===== */}
        {screen === "prep" && (
          <PrepListScreen
            pickings={pickings}
            loading={loading}
            error={error}
            onOpen={openPicking}
            onCheckAvail={checkPickingAvailability}
            onRefresh={loadPickings}
            onReport={openPickingReport}
          />
        )}

        {/* ===== PREPARATION DETAIL ===== */}
        {screen === "prepDetail" && selectedPicking && (
          <PrepDetailScreen
            picking={selectedPicking}
            moves={pickingMoves}
            moveLines={pickingMoveLines}
            scanned={prepScanned}
            loading={loading}
            error={error}
            onScan={doPrepScan}
            onAutoFill={autoFillPicking}
            onValidate={validatePrepPicking}
            onBack={() => { setScreen("prep"); loadPickings(); }}
            onReport={openPickingReport}
          />
        )}

        {/* ===== SETTINGS ===== */}
        {screen === "settings" && (
          <SettingsScreen onBack={goHome} />
        )}
      </main>
    </Shell>
  );
}

// ============================================
// HELPER: group stock by location
// ============================================
function groupStockByLocation(stock: any[]) {
  const map: Record<number, { locId: number; locName: string; total: number; reserved: number; avail: number }> = {};
  for (const q of stock) {
    const id = q.location_id[0];
    if (!map[id]) map[id] = { locId: id, locName: q.location_id[1], total: 0, reserved: 0, avail: 0 };
    map[id].total += q.quantity;
    map[id].reserved += q.reserved_quantity || 0;
  }
  return Object.values(map).map(l => ({ ...l, avail: l.total - l.reserved })).sort((a, b) => b.avail - a.avail);
}

// ============================================
// LOCATION DROPDOWN
// ============================================
function LocationDropdown({ locations, onSelect, excludeId }: { locations: any[]; onSelect: (loc: any) => void; excludeId?: number }) {
  const [search, setSearch] = useState("");
  const filtered = locations.filter(l => l.id !== excludeId && (
    !search || (l.name || "").toLowerCase().includes(search.toLowerCase()) || (l.complete_name || "").toLowerCase().includes(search.toLowerCase()) || (l.barcode || "").toLowerCase().includes(search.toLowerCase())
  ));

  return (
    <div>
      <input style={inputStyle} value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => e.stopPropagation()}
        placeholder="Filtrer les emplacements..." />
      <div style={{ maxHeight: 200, overflowY: "auto", marginTop: 8, borderRadius: 10, border: `1px solid ${C.border}` }}>
        {filtered.slice(0, 50).map(loc => (
          <button key={loc.id} onClick={() => onSelect(loc)}
            style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", padding: "10px 14px", background: "none", border: "none", borderBottom: `1px solid ${C.border}`,
              color: C.text, fontSize: 13, cursor: "pointer", fontFamily: "inherit", textAlign: "left", transition: "background .1s",
            }}>
            <span style={{ fontWeight: 600 }}>{loc.name}</span>
            {loc.barcode && <span style={{ color: C.textMuted, fontSize: 11 }}>{loc.barcode}</span>}
          </button>
        ))}
        {filtered.length === 0 && <div style={{ padding: 12, textAlign: "center", fontSize: 12, color: C.textMuted }}>Aucun résultat</div>}
      </div>
    </div>
  );
}

// ============================================
// PRODUCT PICKER with +/- buttons
// ============================================
function ProductPicker({ product, lot, stock, srcName, onAdd, quickMode, dstName, loading: parentLoading }: any) {
  const [qty, setQty] = useState(1);
  const [selLot, setSelLot] = useState<{ id: number; name: string } | null>(lot ? { id: lot.id, name: lot.name } : null);
  const total = stock.reduce((s: number, q: any) => s + q.quantity, 0);
  const reserved = stock.reduce((s: number, q: any) => s + (q.reserved_quantity || 0), 0);
  const avail = total - reserved;
  const lots = stock.filter((q: any) => q.lot_id);

  useEffect(() => { if (lot) setSelLot({ id: lot.id, name: lot.name }); else setSelLot(null); }, [lot]);

  return (
    <Section>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
        <div style={{ width: 44, height: 44, borderRadius: 10, background: C.blueSoft, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{boxIcon(C.blue, 20)}</div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{product.name}{product.active === false && <Chip color={C.orange}>archivé</Chip>}</div>
          <div style={{ fontSize: 12, color: C.textMuted }}>{product.default_code || ""} {product.barcode ? `· ${product.barcode}` : ""}</div>
        </div>
      </div>

      {/* Stock bar */}
      <div style={{ display: "flex", gap: 1, borderRadius: 10, overflow: "hidden", marginBottom: 6 }}>
        <StatBox value={avail} label="DISPO" color={avail > 0 ? C.green : C.orange} />
        <StatBox value={total} label="STOCK" color={C.textSec} />
        {reserved > 0 && <StatBox value={reserved} label="RÉSERVÉ" color={C.orange} />}
      </div>
      {srcName && <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 14, textAlign: "center" }}>sur {srcName}</div>}

      {/* Lot chips */}
      {lots.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>Lot</div>
          <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 6 }}>
            {stock.map((q: any, i: number) => {
              if (!q.lot_id) return null;
              const sel = selLot?.id === q.lot_id[0];
              const lq = q.quantity - (q.reserved_quantity || 0);
              return (
                <button key={i} onClick={() => { sel ? setSelLot(null) : setSelLot({ id: q.lot_id[0], name: q.lot_id[1] }); vibrate(); }}
                  style={{ padding: "8px 12px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", transition: "all .15s",
                    background: sel ? C.blue : C.white, color: sel ? "#fff" : C.text,
                    border: `1.5px solid ${sel ? C.blue : C.border}`,
                  }}>
                  {q.lot_id[1]} <span style={{ fontWeight: 400, opacity: 0.7 }}>({lq})</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Qty with +/- */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 6 }}>Quantité</div>
        <div style={{ display: "flex", alignItems: "center", gap: 0, borderRadius: 10, overflow: "hidden", border: `1.5px solid ${C.border}` }}>
          <button onClick={() => { if (qty > 1) { setQty(qty - 1); vibrate(); } }} style={qtyBtn}>−</button>
          <input type="number" min="1" value={qty}
            onChange={e => { const v = parseInt(e.target.value); if (v > 0) setQty(v); }}
            onKeyDown={e => e.stopPropagation()}
            style={{ flex: 1, textAlign: "center", fontSize: 22, fontWeight: 800, border: "none", outline: "none", background: C.white, color: C.text, padding: "12px 0", fontFamily: "'DM Mono', monospace" }} />
          <button onClick={() => { setQty(qty + 1); vibrate(); }} style={qtyBtn}>+</button>
        </div>
        {/* Quick qty buttons */}
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          {[1, 5, 10, 25, 50].map(n => (
            <button key={n} onClick={() => { setQty(n); vibrate(); }}
              style={{ flex: 1, padding: "8px 0", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
                background: qty === n ? C.blue : C.bg, color: qty === n ? "#fff" : C.textSec,
                border: `1px solid ${qty === n ? C.blue : C.border}`, transition: "all .1s",
              }}>{n}</button>
          ))}
        </div>
      </div>

      {/* Quick mode: show route summary */}
      {quickMode && srcName && dstName && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginBottom: 12, padding: "10px 14px", background: C.greenSoft, borderRadius: 10, border: `1px solid ${C.greenBorder}` }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{srcName}</span>
          <span style={{ fontSize: 16, color: C.green }}>→</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{dstName}</span>
        </div>
      )}

      <button onClick={() => { if (qty > 0) onAdd(qty, selLot?.id, selLot?.name); }}
        disabled={parentLoading}
        style={{ width: "100%", padding: 14, background: quickMode ? C.green : C.blue, color: "#fff", border: "none", borderRadius: 10, fontSize: 15, fontWeight: 700,
          cursor: parentLoading ? "wait" : "pointer", fontFamily: "inherit", opacity: parentLoading ? 0.6 : 1, transition: "all .15s",
        }}>
        {parentLoading ? "Envoi en cours..." : quickMode ? `✓ Valider le transfert` : "Ajouter à la liste"}
      </button>
    </Section>
  );
}

// ============================================
// SHARED COMPONENTS
// ============================================
function Shell({ children, toast }: { children: React.ReactNode; toast: string }) {
  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: "'DM Sans', 'SF Pro Display', -apple-system, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap');
        @keyframes slideUp { from { opacity:0; transform:translateY(8px) } to { opacity:1; transform:translateY(0) } }
        @keyframes fadeIn { from { opacity:0 } to { opacity:1 } }
        @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:.5 } }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        input[type=number]::-webkit-inner-spin-button, input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
        input[type=number] { -moz-appearance: textfield; }
      `}</style>
      {toast && <div style={{ position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)", zIndex: 999, background: C.text, color: "#fff", padding: "10px 20px", borderRadius: 10, fontSize: 13, fontWeight: 600, boxShadow: C.shadowLg, animation: "fadeIn .15s" }}>{toast}</div>}
      {children}
    </div>
  );
}

function Header({ name, onLogout, onHome, onSettings }: { name?: string; onLogout: () => void; onHome: () => void; onSettings: () => void }) {
  return (
    <header style={{ background: C.white, borderBottom: `1px solid ${C.border}`, padding: "12px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 100 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button onClick={onHome} style={iconBtn}>{homeIcon}</button>
        <span style={{ fontSize: 17, fontWeight: 700, color: C.text }}>WMS</span>
        <span style={{ fontSize: 10, color: C.blue, fontWeight: 600, background: C.blueSoft, padding: "2px 6px", borderRadius: 4 }}>SCANNER</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: C.green, boxShadow: `0 0 6px ${C.green}` }} />
        <span style={{ fontSize: 12, color: C.textSec }}>{name}</span>
        <button onClick={onSettings} style={iconBtn}>{settingsIcon}</button>
        <button onClick={onLogout} style={iconBtn}>{logoutIcon}</button>
      </div>
    </header>
  );
}

function Section({ children, style: s }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ background: C.white, borderRadius: 14, padding: 16, marginBottom: 12, border: `1px solid ${C.border}`, boxShadow: C.shadow, animation: "slideUp .2s", ...s }}>{children}</div>;
}

function SectionHeader({ icon, title, sub }: { icon: React.ReactNode; title: string; sub: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
      <div style={{ width: 36, height: 36, borderRadius: 10, background: C.blueSoft, display: "flex", alignItems: "center", justifyContent: "center" }}>{icon}</div>
      <div>
        <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{title}</div>
        <div style={{ fontSize: 12, color: C.textMuted }}>{sub}</div>
      </div>
    </div>
  );
}

function Alert({ type, children }: { type: string; children: React.ReactNode }) {
  const m: Record<string, { bg: string; border: string; color: string; icon: string }> = {
    success: { bg: C.greenSoft, border: C.greenBorder, color: C.green, icon: "✓" },
    warning: { bg: C.orangeSoft, border: C.orangeBorder, color: C.orange, icon: "⚠" },
    error: { bg: C.redSoft, border: C.redBorder, color: C.red, icon: "✕" },
    info: { bg: C.blueSoft, border: C.blueBorder, color: C.blue, icon: "ℹ" },
  };
  const c = m[type] || m.info;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderRadius: 10, background: c.bg, border: `1px solid ${c.border}`, marginBottom: 12, animation: "slideUp .15s" }}>
      <span style={{ fontSize: 14, fontWeight: 700, color: c.color }}>{c.icon}</span>
      <span style={{ fontSize: 13, fontWeight: 500, color: c.color }}>{children}</span>
    </div>
  );
}

function BigButton({ icon, label, sub, color, onClick, disabled }: { icon: React.ReactNode; label: string; sub?: string; color?: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      width: "100%", display: "flex", alignItems: "center", gap: 14, padding: "16px 20px",
      background: color || C.blue, border: "none", borderRadius: 14, cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.6 : 1, boxShadow: `0 2px 8px ${(color || C.blue)}33`, fontFamily: "inherit",
    }}>
      <div style={{ width: 40, height: 40, borderRadius: 10, background: "rgba(255,255,255,0.2)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{icon}</div>
      <div style={{ textAlign: "left" }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}>{label}</div>
        {sub && <div style={{ fontSize: 12, color: "rgba(255,255,255,0.7)", marginTop: 2 }}>{sub}</div>}
      </div>
    </button>
  );
}

function StatBox({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <div style={{ flex: 1, padding: "10px 12px", background: C.overlay, textAlign: "center" }}>
      <div style={{ fontSize: 20, fontWeight: 800, color }}>{value}</div>
      <div style={{ fontSize: 10, color: C.textMuted, fontWeight: 600 }}>{label}</div>
    </div>
  );
}

function Chip({ color, children }: { color: string; children: React.ReactNode }) {
  return <span style={{ fontSize: 10, fontWeight: 600, color, marginLeft: 6, padding: "1px 6px", borderRadius: 4, background: `${color}15` }}>{children}</span>;
}

function Spinner() { return <span style={{ fontSize: 11, color: C.blue, animation: "pulse 1s infinite" }}>Chargement...</span>; }

function StepIndicator({ step, steps }: { step: number; steps: string[] }) {
  return (
    <div style={{ display: "flex", gap: 8, marginBottom: 20, alignItems: "center" }}>
      {steps.map((s, i) => (
        <div key={s} style={{ flex: 1, textAlign: "center" }}>
          <div style={{ width: 28, height: 28, borderRadius: "50%", margin: "0 auto 4px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700,
            background: step > i ? C.green : step === i ? C.blue : C.border,
            color: step >= i ? "#fff" : C.textMuted, transition: "all .2s",
          }}>{step > i ? "✓" : i + 1}</div>
          <div style={{ fontSize: 11, fontWeight: 600, color: step === i ? C.blue : step > i ? C.green : C.textMuted }}>{s}</div>
        </div>
      ))}
    </div>
  );
}

function InputBar({ onSubmit, placeholder }: { onSubmit: (v: string) => void; placeholder: string }) {
  const [v, setV] = useState("");
  return (
    <div style={{ display: "flex", gap: 8 }}>
      <input style={inputStyle} value={v} onChange={e => setV(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter" && v.trim()) { e.stopPropagation(); onSubmit(v.trim()); setV(""); } }}
        placeholder={placeholder} />
      <button onClick={() => { if (v.trim()) { onSubmit(v.trim()); setV(""); } }}
        style={{ padding: "0 18px", background: C.blue, color: "#fff", border: "none", borderRadius: 10, fontWeight: 700, fontSize: 16, cursor: "pointer", flexShrink: 0 }}>→</button>
    </div>
  );
}

function AutoInput({ locations, onScan, onPickLoc, placeholder }: any) {
  const [v, setV] = useState("");
  const [sugg, setSugg] = useState<any[]>([]);
  const [show, setShow] = useState(false);
  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value; setV(val);
    if (val.length >= 2) {
      const l = val.toLowerCase();
      const m = locations.filter((x: any) => (x.name||"").toLowerCase().includes(l) || (x.complete_name||"").toLowerCase().includes(l) || (x.barcode||"").toLowerCase().includes(l));
      // Sort: exact match > starts with > contains
      m.sort((a: any, b: any) => {
        const an = (a.name||"").toLowerCase(), bn = (b.name||"").toLowerCase();
        const ac = (a.complete_name||"").toLowerCase(), bc = (b.complete_name||"").toLowerCase();
        // Exact match on name
        const aExact = an === l || an.endsWith("-" + l) ? 0 : 1;
        const bExact = bn === l || bn.endsWith("-" + l) ? 0 : 1;
        if (aExact !== bExact) return aExact - bExact;
        // Starts with or segment starts with (after -)
        const aStarts = an.startsWith(l) || an.includes("-" + l) ? 0 : 1;
        const bStarts = bn.startsWith(l) || bn.includes("-" + l) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        // Shorter name = more precise
        return an.length - bn.length;
      });
      setSugg(m.slice(0, 15)); setShow(m.length > 0);
    } else { setSugg([]); setShow(false); }
  };
  return (
    <div style={{ position: "relative" }}>
      <input style={inputStyle} value={v} onChange={onChange}
        onKeyDown={e => { if (e.key === "Enter" && v.trim()) { e.stopPropagation(); setShow(false); onScan(v.trim()); setV(""); } }}
        onFocus={() => { if (sugg.length) setShow(true); }}
        onBlur={() => setTimeout(() => setShow(false), 200)}
        placeholder={placeholder} />
      {show && (
        <div style={{ position: "absolute", top: 50, left: 0, right: 0, zIndex: 50, background: C.white, border: `1px solid ${C.blue}`, borderRadius: 10, boxShadow: C.shadowLg, maxHeight: 200, overflowY: "auto" }}>
          {sugg.map((loc: any) => (
            <button key={loc.id} onMouseDown={() => { onPickLoc(loc); setV(""); setSugg([]); setShow(false); }}
              style={{ display: "flex", justifyContent: "space-between", width: "100%", padding: "10px 14px", background: "none", border: "none", borderBottom: `1px solid ${C.border}`, color: C.text, fontSize: 13, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
              <span style={{ fontWeight: 600 }}>{loc.name}</span>
              {loc.barcode && <span style={{ color: C.textMuted, fontSize: 11 }}>{loc.barcode}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function LocCard({ loc, label, content, color, onRename, onClear }: { loc: any; label: string; content: any[]; color: string; onRename: (id: number, n: string) => void; onClear: () => void }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(loc.name);
  useEffect(() => setName(loc.name), [loc.name]);
  const grouped = Object.values(content.reduce((a: any, q: any) => {
    const k = q.product_id[0];
    if (!a[k]) a[k] = { name: q.product_id[1], qty: 0, res: 0 };
    a[k].qty += q.quantity; a[k].res += q.reserved_quantity || 0;
    return a;
  }, {})) as any[];

  return (
    <div style={{ background: C.white, borderRadius: 14, border: `1px solid ${C.border}`, marginBottom: 12, overflow: "hidden", boxShadow: C.shadow }}>
      <div style={{ padding: "12px 16px", borderLeft: `4px solid ${color}` }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
            {editing ? (
              <div style={{ display: "flex", gap: 4, marginTop: 2 }}>
                <input style={{ ...inputStyle, fontSize: 14, padding: "4px 8px", fontWeight: 700 }} value={name} onChange={e => setName(e.target.value)}
                  onKeyDown={e => { e.stopPropagation(); if (e.key === "Enter") { onRename(loc.id, name); setEditing(false); } if (e.key === "Escape") setEditing(false); }} autoFocus />
              </div>
            ) : (
              <div style={{ fontSize: 16, fontWeight: 700, color: C.text, display: "flex", alignItems: "center", gap: 6 }}>
                {loc.name}
                <button onClick={() => setEditing(true)} style={{ ...iconBtn, width: 22, height: 22 }}>{editIcon}</button>
              </div>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button onClick={() => setOpen(!open)} style={{ ...iconBtn, fontSize: 12, color: C.textMuted }}>{grouped.length} réf {open ? "▲" : "▼"}</button>
            <button onClick={onClear} style={{ ...iconBtn, color: C.red, fontSize: 11 }}>✕</button>
          </div>
        </div>
      </div>
      {open && (
        <div style={{ padding: "0 16px 12px", borderTop: `1px solid ${C.border}` }}>
          {grouped.length === 0 && <div style={{ padding: "10px 0", fontSize: 12, color: C.textMuted, textAlign: "center" }}>Vide</div>}
          {grouped.slice(0, 20).map((p, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: i < grouped.length - 1 ? `1px solid ${C.border}` : "none", fontSize: 12 }}>
              <span style={{ color: C.text, fontWeight: 500, maxWidth: "70%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
              <span style={{ fontWeight: 700, color: (p.qty - p.res) > 0 ? C.green : C.orange }}>{p.qty - p.res}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================
// LOOKUP CARDS
// ============================================
function ProductResult({ product, stock }: { product: any; stock: any[] }) {
  const tQ = stock.reduce((s, q) => s + q.quantity, 0);
  const tR = stock.reduce((s, q) => s + (q.reserved_quantity || 0), 0);
  return (
    <Section>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 2 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{product.name}{product.active === false && <Chip color={C.orange}>archivé</Chip>}</div>
          <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 12 }}>{product.default_code || ""} {product.barcode ? `· ${product.barcode}` : ""}</div>
        </div>
        {product.barcode && (
          <button onClick={() => doPrintProduct(product.name, product.barcode)}
            style={{ ...iconBtn, background: C.bg, borderRadius: 8, padding: "6px 10px", marginLeft: 8, flexShrink: 0 }}
            title="Imprimer étiquette">
            {printerIcon}
          </button>
        )}
      </div>
      <div style={{ display: "flex", gap: 1, borderRadius: 10, overflow: "hidden", marginBottom: 14 }}>
        <StatBox value={tQ - tR} label="DISPO" color={C.green} />
        <StatBox value={tQ} label="STOCK" color={C.textSec} />
      </div>
      <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>Par emplacement</div>
      {stock.map((q, i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: i < stock.length - 1 ? `1px solid ${C.border}` : "", fontSize: 12 }}>
          <div><span style={{ fontWeight: 600 }}>{q.location_id[1]}</span>{q.lot_id && <span style={{ color: C.blue, marginLeft: 6 }}>{q.lot_id[1]}</span>}</div>
          <span style={{ fontWeight: 700, color: (q.quantity - (q.reserved_quantity||0)) > 0 ? C.green : C.orange }}>{q.quantity - (q.reserved_quantity||0)}</span>
        </div>
      ))}
    </Section>
  );
}

function LotResult({ lot, product, stock }: { lot: any; product: any; stock: any[] }) {
  const tQ = stock.reduce((s, q) => s + q.quantity, 0);
  const tR = stock.reduce((s, q) => s + (q.reserved_quantity || 0), 0);
  return (
    <Section>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 2 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>Lot {lot.name}</div>
          <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 12 }}>{product?.name}</div>
        </div>
        {lot.name && (
          <button onClick={() => doPrintLot(lot.name, product?.name || "", lot.name)}
            style={{ ...iconBtn, background: C.bg, borderRadius: 8, padding: "6px 10px", marginLeft: 8, flexShrink: 0 }}
            title="Imprimer étiquette lot">
            {printerIcon}
          </button>
        )}
      </div>
      <div style={{ display: "flex", gap: 1, borderRadius: 10, overflow: "hidden", marginBottom: 14 }}>
        <StatBox value={tQ - tR} label="DISPO" color={C.green} />
        <StatBox value={tQ} label="STOCK" color={C.textSec} />
      </div>
      {stock.map((q, i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: i < stock.length - 1 ? `1px solid ${C.border}` : "", fontSize: 12 }}>
          <span style={{ fontWeight: 600 }}>{q.location_id[1]}</span>
          <span style={{ fontWeight: 700, color: C.green }}>{q.quantity - (q.reserved_quantity||0)}</span>
        </div>
      ))}
    </Section>
  );
}

function LocationResult({ location, stock }: { location: any; stock: any[] }) {
  return (
    <Section>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 2 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 2 }}>{location.name}</div>
          <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 12 }}>{location.barcode || location.complete_name} · {stock.length} réf</div>
        </div>
        {location.barcode && (
          <button onClick={() => doPrintLocation(location.name, location.barcode)}
            style={{ ...iconBtn, background: C.bg, borderRadius: 8, padding: "6px 10px", marginLeft: 8, flexShrink: 0 }}
            title="Imprimer étiquette emplacement">
            {printerIcon}
          </button>
        )}
      </div>
      {stock.map((q, i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: i < stock.length - 1 ? `1px solid ${C.border}` : "", fontSize: 12 }}>
          <div><span style={{ fontWeight: 600 }}>{q.product_id[1]}</span>{q.lot_id && <span style={{ color: C.blue, marginLeft: 6 }}>{q.lot_id[1]}</span>}</div>
          <span style={{ fontWeight: 700, color: C.green }}>{q.quantity - (q.reserved_quantity||0)}</span>
        </div>
      ))}
    </Section>
  );
}

// ============================================
// LOGIN
// ============================================
// ============================================
// SETTINGS SCREEN
// ============================================
function SettingsScreen({ onBack }: { onBack: () => void }) {
  // Printer
  const [printerId, setPrinterId] = useState(() => { const s = pn.getSavedPrinterId(); return s ? String(s) : ""; });
  const [printers, setPrinters] = useState<pn.PrintNodePrinter[]>([]);
  const [loadingP, setLoadingP] = useState(false);
  const [msg, setMsg] = useState("");

  // Label size
  const [labelSize, setLabelSize] = useState<pn.LabelSize>(() => pn.getLabelSize());

  const hasKey = !!process.env.NEXT_PUBLIC_PRINTNODE_API_KEY;

  const fetchPrinters = async () => {
    setLoadingP(true); setMsg("");
    try {
      const list = await pn.listPrinters();
      setPrinters(list);
      if (!list.length) setMsg("Aucune imprimante trouvée");
    } catch (e: any) { setMsg("Erreur: " + e.message); }
    setLoadingP(false);
  };

  const savePrinter = () => {
    const id = parseInt(printerId, 10);
    if (id > 0) { pn.savePrinterId(id); setMsg("✓ Imprimante sauvegardée"); }
    else setMsg("ID invalide");
  };

  const saveSize = () => {
    if (labelSize.widthMM > 0 && labelSize.heightMM > 0) {
      pn.saveLabelSize(labelSize);
      setMsg("✓ Taille sauvegardée");
    }
  };

  const testProduct = async () => {
    const id = parseInt(printerId, 10);
    if (!id) { setMsg("Configure une imprimante d'abord"); return; }
    setMsg("Envoi test produit...");
    const r = await pn.printProductLabel(id, "TEST PRODUIT", "3401234567890");
    setMsg(r.success ? "✓ Étiquette produit envoyée" : "✕ " + r.error);
  };

  const testLot = async () => {
    const id = parseInt(printerId, 10);
    if (!id) { setMsg("Configure une imprimante d'abord"); return; }
    setMsg("Envoi test lot...");
    const r = await pn.printLotLabel(id, "A12345-01/2026", "Crème Purifiante 50ml", "A12345-01/2026");
    setMsg(r.success ? "✓ Étiquette lot envoyée" : "✕ " + r.error);
  };

  const testLocation = async () => {
    const id = parseInt(printerId, 10);
    if (!id) { setMsg("Configure une imprimante d'abord"); return; }
    setMsg("Envoi test emplacement...");
    const r = await pn.printLocationLabel(id, "A42-RKD1", "B-A42");
    setMsg(r.success ? "✓ Étiquette emplacement envoyée" : "✕ " + r.error);
  };

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
        <button onClick={onBack} style={{ ...iconBtn, background: C.bg, borderRadius: 8, padding: 8 }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: C.text }}>Paramètres</h2>
      </div>

      {/* LABEL SIZE */}
      <Section>
        <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
          📐 Taille des étiquettes
        </div>
        <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: C.textSec, display: "block", marginBottom: 4 }}>Largeur (mm)</label>
            <input type="number" style={inputStyle} value={labelSize.widthMM}
              onChange={e => setLabelSize(s => ({ ...s, widthMM: parseInt(e.target.value) || 0 }))}
              onKeyDown={e => e.stopPropagation()} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: C.textSec, display: "block", marginBottom: 4 }}>Hauteur (mm)</label>
            <input type="number" style={inputStyle} value={labelSize.heightMM}
              onChange={e => setLabelSize(s => ({ ...s, heightMM: parseInt(e.target.value) || 0 }))}
              onKeyDown={e => e.stopPropagation()} />
          </div>
        </div>
        <button onClick={saveSize} style={{ width: "100%", padding: 10, background: C.blue, color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
          Sauvegarder la taille
        </button>
        <div style={{ fontSize: 11, color: C.textMuted, marginTop: 6, textAlign: "center" }}>
          Tailles courantes : 50×30, 57×32, 70×45, 100×50
        </div>
      </Section>

      {/* PRINTER */}
      {hasKey ? (
        <Section>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
            🖨 Imprimante PrintNode
          </div>

          {/* Manual ID */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: C.textSec, display: "block", marginBottom: 4 }}>ID Imprimante</label>
            <div style={{ display: "flex", gap: 6 }}>
              <input type="number" style={{ ...inputStyle, flex: 1 }} value={printerId}
                onChange={e => setPrinterId(e.target.value)}
                onKeyDown={e => { e.stopPropagation(); if (e.key === "Enter") savePrinter(); }}
                placeholder="Ex: 70123456" />
              <button onClick={savePrinter} style={{ padding: "0 14px", background: C.blue, color: "#fff", border: "none", borderRadius: 10, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>OK</button>
            </div>
          </div>

          {/* List printers */}
          <button onClick={fetchPrinters} disabled={loadingP}
            style={{ width: "100%", padding: 10, background: C.bg, color: C.textSec, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", marginBottom: 10 }}>
            {loadingP ? "Chargement..." : "Rechercher les imprimantes"}
          </button>

          {printers.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              {printers.map(p => (
                <button key={p.id}
                  onClick={() => { setPrinterId(String(p.id)); pn.savePrinterId(p.id); setMsg(`✓ ${p.name} sélectionnée`); }}
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", padding: "10px 12px", marginBottom: 4,
                    background: String(p.id) === printerId ? C.blueSoft : C.bg,
                    border: `1.5px solid ${String(p.id) === printerId ? C.blue : C.border}`,
                    borderRadius: 8, cursor: "pointer", fontFamily: "inherit", fontSize: 12, textAlign: "left",
                  }}>
                  <div>
                    <div style={{ fontWeight: 600, color: C.text }}>{p.name}</div>
                    <div style={{ fontSize: 10, color: C.textMuted }}>{p.computer.name} · #{p.id}</div>
                  </div>
                  <span style={{ fontSize: 9, fontWeight: 600,
                    color: p.state === "online" ? C.green : C.orange,
                    background: p.state === "online" ? C.greenSoft : C.orangeSoft,
                    padding: "2px 6px", borderRadius: 4
                  }}>{p.state}</span>
                </button>
              ))}
            </div>
          )}

          {/* Test prints */}
          <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>Impressions test</div>
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            <button onClick={testProduct} style={testBtnStyle}>Produit</button>
            <button onClick={testLot} style={testBtnStyle}>Lot</button>
            <button onClick={testLocation} style={testBtnStyle}>Emplacement</button>
          </div>
        </Section>
      ) : (
        <Section>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 8 }}>🖨 Imprimante</div>
          <Alert type="info">Ajoute NEXT_PUBLIC_PRINTNODE_API_KEY dans les variables Vercel pour activer PrintNode.</Alert>
        </Section>
      )}

      {msg && (
        <div style={{ textAlign: "center", fontSize: 13, fontWeight: 600, padding: 12,
          color: msg.startsWith("✓") ? C.green : msg.startsWith("✕") ? C.red : C.textSec,
        }}>{msg}</div>
      )}
    </>
  );
}

// ============================================
// PREPARATION LIST SCREEN
// ============================================
function PrepListScreen({ pickings, loading, error, onOpen, onCheckAvail, onRefresh, onReport }: any) {
  // Group by scheduled_date
  const grouped: Record<string, any[]> = {};
  for (const p of pickings) {
    const d = p.scheduled_date ? new Date(p.scheduled_date).toLocaleDateString("fr-FR", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" }) : "Sans date";
    if (!grouped[d]) grouped[d] = [];
    grouped[d].push(p);
  }

  const stateLabel: Record<string, { text: string; color: string; bg: string }> = {
    confirmed: { text: "En attente", color: C.orange, bg: C.orangeSoft },
    assigned: { text: "Prêt", color: C.green, bg: C.greenSoft },
  };

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: C.text }}>Préparation</h2>
          <p style={{ fontSize: 12, color: C.textMuted }}>{pickings.length} commande(s) en cours</p>
        </div>
        <button onClick={onRefresh} disabled={loading} style={{ ...iconBtn, background: C.blueSoft, borderRadius: 10, padding: "8px 12px" }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={C.blue} strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
        </button>
      </div>

      {error && <Alert type="error">{error}</Alert>}
      {loading && pickings.length === 0 && <div style={{ textAlign: "center", padding: 40, color: C.textMuted }}>Chargement...</div>}
      {!loading && pickings.length === 0 && <Alert type="info">Aucune commande en attente ou prête</Alert>}

      {Object.entries(grouped).map(([date, items]) => (
        <div key={date} style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.blue, marginBottom: 8, padding: "6px 12px", background: C.blueSoft, borderRadius: 8, display: "inline-block" }}>
            📅 {date}
          </div>
          {items.map((p: any) => {
            const st = stateLabel[p.state] || stateLabel.confirmed;
            const moveCount = (p.move_ids_without_package || []).length;
            return (
              <div key={p.id} style={{ ...cardStyle, marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 8 }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{p.name}</div>
                    {p.partner_id && <div style={{ fontSize: 12, color: C.textSec }}>{p.partner_id[1]}</div>}
                    {p.origin && <div style={{ fontSize: 11, color: C.textMuted }}>Origine: {p.origin}</div>}
                  </div>
                  <span style={{ fontSize: 11, fontWeight: 700, color: st.color, background: st.bg, padding: "3px 8px", borderRadius: 6 }}>{st.text}</span>
                </div>
                <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 10 }}>{moveCount} article(s)</div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => onOpen(p)} style={{ flex: 2, padding: "10px 0", background: C.blue, color: "#fff", border: "none", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                    Préparer
                  </button>
                  {p.state === "confirmed" && (
                    <button onClick={() => onCheckAvail(p.id)} style={{ flex: 1, padding: "10px 0", background: C.orangeSoft, color: C.orange, border: `1px solid ${C.orangeBorder}`, borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                      Vérifier
                    </button>
                  )}
                  <button onClick={() => onReport(p.id)} style={{ padding: "10px 12px", background: C.bg, color: C.textSec, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                    🖨
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}

// ============================================
// PREPARATION DETAIL SCREEN
// ============================================
function PrepDetailScreen({ picking, moves, moveLines, scanned, loading, error, onScan, onAutoFill, onValidate, onBack, onReport }: any) {
  const totalLines = moveLines.length;
  const doneLines = moveLines.filter((ml: any) => ml.qty_done > 0).length;
  const progress = totalLines > 0 ? Math.round((doneLines / totalLines) * 100) : 0;
  const allDone = totalLines > 0 && doneLines === totalLines;

  // Group moves by product for display
  const movesByProduct = moves.map((m: any) => {
    const relatedLines = moveLines.filter((ml: any) => ml.product_id[0] === m.product_id[0]);
    const totalDone = relatedLines.reduce((s: number, ml: any) => s + (ml.qty_done || 0), 0);
    return { ...m, relatedLines, totalDone };
  });

  return (
    <>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <button onClick={onBack} style={{ ...iconBtn, background: C.bg, borderRadius: 8, padding: 8 }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{picking.name}</div>
          {picking.partner_id && <div style={{ fontSize: 12, color: C.textSec }}>{picking.partner_id[1]}</div>}
          {picking.origin && <div style={{ fontSize: 11, color: C.textMuted }}>{picking.origin}</div>}
        </div>
        <button onClick={() => onReport(picking.id)} style={{ ...iconBtn, background: C.bg, borderRadius: 8, padding: 8 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={C.textSec} strokeWidth="2"><path d="M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
        </button>
      </div>

      {/* Progress */}
      <Section>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>Progression</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: allDone ? C.green : C.blue }}>{doneLines}/{totalLines}</span>
        </div>
        <div style={{ height: 8, borderRadius: 4, background: C.bg, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${progress}%`, borderRadius: 4, background: allDone ? C.green : C.blue, transition: "width .3s" }} />
        </div>
        <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>{progress}% préparé</div>
      </Section>

      {/* Scan input */}
      <Section>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>Scanner un article</span>
          {loading && <Spinner />}
        </div>
        <InputBar onSubmit={onScan} placeholder="Code-barres, réf, lot..." />
      </Section>

      {error && <Alert type="error">{error}</Alert>}

      {/* Move lines */}
      <Section>
        <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 10 }}>Articles à préparer</div>
        {movesByProduct.map((m: any, i: number) => {
          const isDone = m.totalDone >= m.product_uom_qty;
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: i < movesByProduct.length - 1 ? `1px solid ${C.border}` : "none" }}>
              <div style={{ width: 32, height: 32, borderRadius: 8, background: isDone ? C.greenSoft : C.bg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                {isDone
                  ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={C.green} strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                  : boxIcon(C.textMuted, 14)
                }
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: isDone ? C.green : C.text }}>{m.product_id[1]}</div>
                {m.relatedLines.map((ml: any, j: number) => (
                  <div key={j} style={{ fontSize: 11, color: C.textMuted }}>
                    {ml.lot_id ? `Lot ${ml.lot_id[1]} · ` : ""}
                    {ml.location_id?.[1] || ""}
                  </div>
                ))}
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: isDone ? C.green : C.text }}>{m.totalDone} / {m.product_uom_qty}</div>
                <div style={{ fontSize: 10, color: C.textMuted }}>{m.product_uom?.[1] || ""}</div>
              </div>
            </div>
          );
        })}
      </Section>

      {/* Actions */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button onClick={onAutoFill} disabled={loading || allDone} style={{ flex: 1, padding: 12, background: C.blueSoft, color: C.blue, border: `1px solid ${C.blueBorder}`, borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", opacity: allDone ? 0.5 : 1 }}>
          Tout remplir
        </button>
        <button onClick={() => onReport(picking.id)} style={{ padding: "12px 16px", background: C.bg, color: C.textSec, border: `1px solid ${C.border}`, borderRadius: 10, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
          Bon de livraison
        </button>
      </div>

      <BigButton
        icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>}
        label={loading ? "Envoi..." : "Valider la préparation"}
        sub={`${doneLines}/${totalLines} articles préparés`}
        color={allDone ? C.green : C.orange}
        onClick={onValidate}
        disabled={loading || doneLines === 0}
      />
    </>
  );
}

function Login({ onLogin, loading, error }: { onLogin: (u: string, d: string, l: string, p: string) => void; loading: boolean; error: string }) {
  const cfg = typeof window !== "undefined" ? loadCfg() : null;
  const [url, setUrl] = useState(cfg?.u || ""); const [db, setDb] = useState(cfg?.d || "");
  const [user, setUser] = useState(""); const [pw, setPw] = useState("");
  const [showCfg, setShowCfg] = useState(!cfg);
  const go = () => { if (url && db && user && pw) onLogin(url, db, user, pw); };

  return (
    <Shell toast="">
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ width: "100%", maxWidth: 400, padding: 20 }}>
          <div style={{ textAlign: "center", marginBottom: 36 }}>
            <div style={{ width: 56, height: 56, borderRadius: 14, background: C.blue, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px" }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.5"><path d="M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M20 10v11M8 14v3M12 14v3M16 14v3"/></svg>
            </div>
            <h1 style={{ fontSize: 24, fontWeight: 700, color: C.text }}>WMS Scanner</h1>
            <p style={{ fontSize: 14, color: C.textMuted, marginTop: 4 }}>Connexion à votre entrepôt</p>
          </div>
          <Section>
            <button onClick={() => setShowCfg(!showCfg)} style={{ ...secondaryBtn, marginBottom: showCfg ? 12 : 0, fontSize: 12 }}>{showCfg ? "Masquer" : "Afficher"} la config serveur</button>
            {showCfg && <>
              <Field label="URL Odoo" value={url} onChange={setUrl} placeholder="https://monentreprise.odoo.com" />
              <Field label="Base de données" value={db} onChange={setDb} placeholder="nom_base" />
            </>}
            <Field label="Identifiant" value={user} onChange={setUser} placeholder="admin@company.com" />
            <Field label="Mot de passe" value={pw} onChange={setPw} placeholder="••••••••" type="password" onEnter={go} />
            {error && <Alert type="error">{error}</Alert>}
            <button onClick={go} disabled={loading} style={{ width: "100%", padding: 14, background: C.blue, color: "#fff", border: "none", borderRadius: 10, fontSize: 15, fontWeight: 700, cursor: loading ? "wait" : "pointer", marginTop: 8, fontFamily: "inherit" }}>
              {loading ? "Connexion..." : "Se connecter"}
            </button>
          </Section>
        </div>
      </div>
    </Shell>
  );
}

function Field({ label, value, onChange, placeholder, type, onEnter }: { label: string; value: string; onChange: (v: string) => void; placeholder: string; type?: string; onEnter?: () => void }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ fontSize: 12, fontWeight: 600, color: C.textSec, marginBottom: 4, display: "block" }}>{label}</label>
      <input type={type || "text"} style={inputStyle} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        onKeyDown={e => { if (e.key === "Enter" && onEnter) onEnter(); }} />
    </div>
  );
}

// ============================================
// STYLE CONSTANTS
// ============================================
const inputStyle: React.CSSProperties = {
  width: "100%", padding: "12px 14px", background: C.bg, border: `1.5px solid ${C.border}`, borderRadius: 10,
  color: C.text, fontSize: 14, fontFamily: "'DM Sans', sans-serif", outline: "none", boxSizing: "border-box",
};

const iconBtn: React.CSSProperties = {
  background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex", alignItems: "center", justifyContent: "center",
};

const secondaryBtn: React.CSSProperties = {
  width: "100%", padding: 12, background: "none", color: C.blue, border: `1.5px solid ${C.border}`, borderRadius: 10,
  fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans', sans-serif",
};

const qtyBtn: React.CSSProperties = {
  width: 56, background: C.bg, border: "none", fontSize: 22, fontWeight: 700, cursor: "pointer", color: C.blue, fontFamily: "inherit", padding: "12px 0",
};

// ============================================
// ICONS
// ============================================
const scanIcon = <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={C.blue} strokeWidth="2.5"><path d="M3 7V5a2 2 0 012-2h2M17 3h2a2 2 0 012 2v2M21 17v2a2 2 0 01-2 2h-2M7 21H5a2 2 0 01-2-2v-2"/><line x1="7" y1="12" x2="17" y2="12"/></svg>;
const homeIcon = <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={C.blue} strokeWidth="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>;
const logoutIcon = <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={C.textMuted} strokeWidth="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>;
const trashIcon = <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>;
const editIcon = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={C.textMuted} strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>;
const clockIcon = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.textMuted} strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>;
const printerIcon = <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={C.textSec} strokeWidth="2"><path d="M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>;
const settingsIcon = <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={C.textMuted} strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>;

const testBtnStyle: React.CSSProperties = {
  flex: 1, padding: "10px 0", background: C.bg, color: C.textSec,
  border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 11,
  fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
};
const transferIcon = (c: string) => <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 014-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>;
const prepIcon = <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 11l3 3L22 4"/><line x1="9" y1="17" x2="9" y2="17"/><line x1="13" y1="17" x2="13" y2="17"/></svg>;
const boxIcon = (c: string, s: number) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>;

const cardStyle: React.CSSProperties = { background: C.white, borderRadius: 14, padding: 16, border: `1px solid ${C.border}`, boxShadow: C.shadow };
