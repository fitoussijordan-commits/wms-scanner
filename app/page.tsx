"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import * as odoo from "@/lib/odoo";
import * as pn from "@/lib/printnode";

const DH_LOGO = "data:image/png;base64,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ZUDLG4IY/DPfxtn0zPbM231v3/vfm+2u+v+de6Z79vV2z/T09OjSoASEAkKBtqDAp59+qh588EG1xhprWONZunSpOuyww9TGG29spTcjMm/ePDVz5kzVs2dPq/kVK1aoMWPGqL59+1rp7RzpIQyunadHxlY1Crz++utq2LBhLNrPPPOM2n333dm8MhOnTp2aMFOuzffff78lTJbru5601VAJHLsI9O7dOym++uqrq379+mW+NkXa6sSy+JouWrSIHfqAAQPUOuusw+YVTfzqq68UXigOBg4c2FFfUg4HSctSYJVVVskmfpey6qqrevMkg6fAah988IEaOnQon5sjdc0111SbbbaZ2nrrrdX++++vtt9++5Z8ZXIMrWlF3nvvPe9X9tprr1UXXnhhKX2/8MILCU25xlr1Nef6ljShQKdQIJHgfIPdYIMNEubVq1evRFKDxPbNN9+oV199Vb377rtJtS+//DKJI23SpElpU2eddZY655xz1LbbbpumxRIIfWX79OlTGpqguw/ka+6jjKQLBf5PgSCDu/jii4PSCFTbl156KVkUhd5O4ZZbblH4O/jgg9X111+vhgwZQrMlLBQQCggFmk4Bv8Kfo2swreOOO0498sgjyVrRFVdckan16KOPJirwb3/720yeJAgFhAJCgWZSoCEGRweG7evf/OY36sUXX6TJaRjMb88990zjEhAKCAWEAs2mQGkMzgx0xIgR6p133jFR64mFcdjyCAgFhAJCgVZQoHQGh0FjV9UnyWGtTtTVVkyt9CEUEAo0hcGBrJDkzjvvPJbCUFeL2t6xDUmiUEAoIBQIUKBpDA59cpsOZiznnnuuCcpTKCAUEAo0hQJNZXCw6PdJcU888YTCsRQBoYBQQCjQLAo0lcFh0D/60Y+8Y7///vu9eY1k4CiVgFDAUADvA07s4K9V7wb6aVVfBk95ZikQNPTNFi+eEjocfOWVV6o//OEP3kbnzJmjXnvtNTb/pJNOstKfe+459etf/1pBMjQwa9YsNXLkSBOt/BNnWx977DGFjR6cOsEpFAPYGBo1alRyzA7PoudpZ8yYkTAQ0555wivG0UcfbaI1nxMnTmQZww477KB23HHHmvVNAYzn3nvvVXfffbdJSp84oQMjdnjGKMM7Bxgn+nv44YfVU089ZdEVnR511FHqoosuatq7aPqfMmWKmj9/ftI/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atmyZUk7K1euVGeccYbafffdG2q3rMrTp09XF110kdp4442VkczuuOOOdI3NjLus/qSdzqWAMLjOnbu6R/7ll19m6i5fvtxKmzZtmiUFHXDAAW3D4BYuXKheffXV5M8MGgzOwDfffGOC6ZPDOc2UQLQUEBU12qn1I8apo717904rrLHGGspV6T766KM0v7sD7ljcsa6++uqZIXI4ZwpJQnQUEAYX3ZTWRuiDDz7IFOKYAi0Eg+B2AXcsrnS29tprK/xRWLx4MY1KuCIUEAZXkYk2aGIB/qWXXjLR5Alm0K9fvzQNa3Au0zAnH9JC3Rjo27dvsHfkb7rpplaZ2bNnR7dTbCEoEZYCwuBYssSbyEkygwcPVlBLDUBCcnchXYkITJD+mbrNeKIfCu5YkOduLGADwgUOd7eMxOOigDC4uOazJjaQZFzYZpttrCSXWSDTPcM5cuRItcUWWyR/kJjuv/9+q41GImhrhx12SP623nprhb4ouGNBnrvGtttuu9EqSdiVXDMFJCE6CsguanRTGkbo3nvvzRTADikF7FK6QFVY5GEXkwLHFGl+kfCHH36YaZ/Wd8eCvLlz56ptt902LTZ8+PA0bAIPPvigOu6440xUnhWggEhwFZhkiiJ37hRSEgUwCxc22mgjN8mKG3s0K7HOSK22uLHMnz/f6m377be34ohMnTo1kyYJcVNAGFzc82thN2PGDCtuIq4KyDHBQYMGmeLsYr1rqpEWriNA1wNNdXqUjEpqJv+6664zweS52WabWXET8dHA5MszLgoIg4trPoPYPPLII5n8o446KpM2adIkKw3eRyjTmTdvnpWPyPe///1MWr0JG264Yabq22+/baXBOwgF7PpSJoi88847jxZJwhwNMoUkIRoKCIOLZirDiGAncvz48ZlCRx99tJXmuhlC5hFHHGGVcdVBZK633npWmUYirokH2nrttdesJg8//HArjghOX1A47LDDaDQJ33nnncnubyZDEqKkgDC4KKc1i9Szzz6bTdQpe+21l5XO7YYeeOCBVpnHH3/cikM95Uw3rEIFIpy66/a59957Z1p0N1C4nVRIej5aZBqUhM6nQJdAJShw6KGHdum31frTap6Fu/7xW/kor5mNVearr75K0mhbWoW1ypQR0ZsE1lgwDvRNAWl0HAi/8847tEjXySefnCmj1XKrjETipYBIcPpX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";
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
// LABEL PRINTING — Modal + PrintNode/fallback
// ============================================
interface PrintRequest {
  type: "product" | "lot" | "location";
  title: string;
  barcode: string;
  ref?: string;
  lotName?: string;
  productName?: string;
  expiryDate?: string;
  locationName?: string;
}

// Global print state — set by components, read by modal
let _setPrintReq: ((r: PrintRequest | null) => void) | null = null;

function requestPrint(req: PrintRequest) {
  if (_setPrintReq) _setPrintReq(req);
}

async function executePrint(req: PrintRequest, copies: number) {
  const printerId = pn.getSavedPrinterId();
  if (printerId) {
    if (req.type === "product") return pn.printProductLabel(printerId, req.productName || req.title, req.barcode, req.ref, copies);
    if (req.type === "lot") return pn.printLotLabel(printerId, req.lotName || "", req.productName || "", req.barcode, req.expiryDate, copies);
    if (req.type === "location") return pn.printLocationLabel(printerId, req.locationName || req.title, req.barcode, copies);
  }
  // Fallback popup (single copy)
  printLabelPopup(req.title, req.barcode, req.barcode);
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
    try { JsBarcode("#bc", "${barcode}", { format: "${bcFormat}", width: 2, height: 60, displayValue: false, margin: 0 }); }
    catch(e) { try { JsBarcode("#bc", "${barcode}", { format: "CODE128", width: 2, height: 60, displayValue: false, margin: 0 }); } catch(e2) {} }
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
function clearHistory() {
  try { localStorage.removeItem(HIST_KEY); } catch {}
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
  const [screen, setScreen] = useState<"login" | "home" | "transfer" | "done" | "prep" | "prepDetail" | "settings" | "history" | "arrival">("login");
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
  // 2-step preparation: step 1 = scan location, step 2 = scan lot/barcode → +1 qty each scan
  const [prepStep, setPrepStep] = useState<{ locId: number; locName: string; lineId: number; productName: string; lotName?: string; remaining: number } | null>(null);

  // Print modal
  const [printReq, setPrintReq] = useState<PrintRequest | null>(null);
  useEffect(() => { _setPrintReq = setPrintReq; return () => { _setPrintReq = null; }; }, []);

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
    setPrepStep(null);
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

      // STEP 1: No active step → expect a location scan
      if (!prepStep) {
        if (r.type === "location") {
          // Find move lines at this location that still need qty
          const locId = r.data.id;
          const pending = pickingMoveLines.filter((ml: any) =>
            ml.location_id && ml.location_id[0] === locId && (ml.qty_done || 0) < (ml.reserved_uom_qty || 0)
          );
          if (pending.length === 0) {
            showToast(`Aucun article à prendre à ${r.data.name}`);
            vibrateError();
            return;
          }
          // Lock on first pending line at this location
          const ml = pending[0];
          const remaining = (ml.reserved_uom_qty || 0) - (ml.qty_done || 0);
          setPrepStep({
            locId, locName: r.data.name, lineId: ml.id,
            productName: ml.product_id[1], lotName: ml.lot_id?.[1] || undefined,
            remaining,
          });
          vibrateSuccess();
          showToast(`📍 ${r.data.name} → Scannez ${ml.lot_id ? "lot " + ml.lot_id[1] : ml.product_id[1]}`);
        } else {
          showToast("⚠ Scannez d'abord un emplacement source");
          vibrateError();
        }
        return;
      }

      // STEP 2: Location already scanned → expect product or lot
      if (r.type === "product" || r.type === "lot") {
        const productId = r.type === "product" ? r.data.id : r.data.product?.id;
        const lotId = r.type === "lot" ? r.data.lot.id : null;
        const lotName = r.type === "lot" ? r.data.lot.name : null;
        if (!productId) { showToast("Produit inconnu"); vibrateError(); return; }

        // Find matching move line at the locked location
        const ml = pickingMoveLines.find((m: any) =>
          m.location_id && m.location_id[0] === prepStep.locId &&
          m.product_id[0] === productId &&
          (m.qty_done || 0) < (m.reserved_uom_qty || 0) &&
          (!lotId || !m.lot_id || m.lot_id[0] === lotId)
        );
        if (!ml) {
          showToast("Pas dans cette commande ou déjà complet");
          vibrateError();
          return;
        }

        // Increment qty_done by 1
        const newQty = (ml.qty_done || 0) + 1;
        await odoo.setMoveLineQtyDone(session, ml.id, newQty, lotId);

        // Refresh
        const updatedLines = await odoo.getPickingMoveLines(session, selectedPicking.id);
        setPickingMoveLines(updatedLines);

        // Mark as scanned if fully done
        if (newQty >= (ml.reserved_uom_qty || 0)) {
          setPrepScanned(prev => { const n = new Set(Array.from(prev)); n.add(ml.id); return n; });
        }

        const remaining = (ml.reserved_uom_qty || 0) - newQty;
        vibrateSuccess();
        showToast(`✓ ${lotName || r.data.name} · ${newQty}/${ml.reserved_uom_qty || 0}`);

        // Check if more lines at this location
        const morePending = updatedLines.filter((m: any) =>
          m.location_id && m.location_id[0] === prepStep.locId && (m.qty_done || 0) < (m.reserved_uom_qty || 0)
        );
        if (morePending.length === 0) {
          setPrepStep(null); // all done at this location
          showToast(`✓ Emplacement ${prepStep.locName} terminé`);
        } else if (remaining <= 0) {
          // Current line done, move to next at same location
          const next = morePending[0];
          const nextRemaining = (next.reserved_uom_qty || 0) - (next.qty_done || 0);
          setPrepStep({
            locId: prepStep.locId, locName: prepStep.locName, lineId: next.id,
            productName: next.product_id[1], lotName: next.lot_id?.[1] || undefined,
            remaining: nextRemaining,
          });
        } else {
          setPrepStep(prev => prev ? { ...prev, lineId: ml.id, remaining } : null);
        }
      } else if (r.type === "location") {
        // Scanning a new location resets the step
        setPrepStep(null);
        doPrepScan(code); // re-enter as step 1
      } else {
        showToast(`"${code}" non trouvé`);
        vibrateError();
      }
    } catch (e: any) { setError(e.message); vibrateError(); }
  };

  // "Tout prendre" — fill all remaining qty for the current location
  const prepTakeAll = async () => {
    if (!session || !selectedPicking || !prepStep) return;
    setLoading(true);
    try {
      const pending = pickingMoveLines.filter((ml: any) =>
        ml.location_id && ml.location_id[0] === prepStep.locId && (ml.qty_done || 0) < (ml.reserved_uom_qty || 0)
      );
      for (const ml of pending) {
        await odoo.setMoveLineQtyDone(session, ml.id, ml.reserved_uom_qty || 0, ml.lot_id?.[0] || null);
      }
      const updatedLines = await odoo.getPickingMoveLines(session, selectedPicking.id);
      setPickingMoveLines(updatedLines);
      const done = new Set(Array.from(prepScanned));
      pending.forEach((ml: any) => done.add(ml.id));
      setPrepScanned(done);
      setPrepStep(null);
      vibrateSuccess();
      showToast(`✓ Tout pris à ${prepStep.locName}`);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
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
          {lookupType === "location" && lookupResult && <LocationResult location={lookupResult} stock={lookupStock} onRename={rename} />}

          <div style={{ marginTop: 16 }}>
            <BigButton icon={transferIcon("#fff")} label="Transfert interne" sub="Déplacer du stock entre emplacements" onClick={() => { resetTransfer(); setScreen("transfer"); }} />
            <div style={{ height: 10 }} />
            <BigButton icon={prepIcon} label="Préparation" sub="Commandes à préparer et expédier" color="#7c3aed" onClick={() => { loadPickings(); setScreen("prep"); }} />
            <div style={{ height: 10 }} />
            <BigButton icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 002 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0022 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>} label="Arrivage" sub="Importer une packing list WALA" color="#059669" onClick={() => setScreen("arrival")} />
            {history.length > 0 && <>
              <div style={{ height: 10 }} />
              <BigButton icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>} label="Historique" sub={`${history.length} transfert${history.length > 1 ? "s" : ""} enregistré${history.length > 1 ? "s" : ""}`} color="#64748b" onClick={() => setScreen("history")} />
            </>}
          </div>

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
            prepStep={prepStep}
            onScan={doPrepScan}
            onTakeAll={prepTakeAll}
            onCancelStep={() => setPrepStep(null)}
            onAutoFill={autoFillPicking}
            onValidate={validatePrepPicking}
            onBack={() => { setScreen("prep"); setPrepStep(null); loadPickings(); }}
            onReport={openPickingReport}
          />
        )}

        {/* ===== SETTINGS ===== */}
        {screen === "settings" && (
          <SettingsScreen onBack={goHome} />
        )}

        {/* ===== HISTORY ===== */}
        {screen === "history" && (
          <HistoryScreen history={history} onClear={() => { clearHistory(); setHistory([]); goHome(); }} onBack={goHome} />
        )}

        {screen === "arrival" && session && (
          <ArrivalScreen session={session} onBack={goHome} onToast={showToast} />
        )}
      </main>

      {/* Print Modal — rendered at root level for z-index */}
      {printReq && <PrintModal req={printReq} onClose={() => setPrintReq(null)} onToast={showToast} />}
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
          <input type="number" min="1" value={qty === 0 ? "" : qty}
            onChange={e => { const raw = e.target.value; if (raw === "") { setQty(0); return; } const v = parseInt(raw); if (!isNaN(v) && v >= 0) setQty(v); }}
            onBlur={() => { if (qty === 0) setQty(1); }}
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
        <img src={DH_LOGO} alt="Dr. Hauschka" style={{ height: 28, marginLeft: 2, objectFit: "contain" }} />
        <span style={{ fontSize: 9, color: C.blue, fontWeight: 600, background: C.blueSoft, padding: "2px 5px", borderRadius: 4, marginLeft: 4 }}>WMS</span>
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
          <button onClick={() => requestPrint({ type: "product", title: product.name, barcode: product.barcode, ref: product.default_code, productName: product.name })}
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
        <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: i < stock.length - 1 ? `1px solid ${C.border}` : "", fontSize: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, color: C.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{q.location_id[1]}</div>
            {q.lot_id && (
              <button
                onClick={() => requestPrint({
                  type: "lot", title: `${q.lot_name || q.lot_id[1]} — ${product.name}`,
                  barcode: q.lot_name || q.lot_id[1], lotName: q.lot_name || q.lot_id[1], productName: product.name,
                  expiryDate: q.expiration_date || "",
                })}
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit",
                  fontSize: 11, color: C.blue, fontWeight: 600, display: "flex", alignItems: "center", gap: 4, marginTop: 2 }}>
                {printerSmallIcon} {q.lot_id[1]}
                {q.expiration_date && <span style={{ color: C.textMuted, fontWeight: 400 }}> · {(() => { try { return new Date(q.expiration_date).toLocaleDateString("fr-FR", { month: "2-digit", year: "numeric" }); } catch { return ""; } })()}</span>}
              </button>
            )}
          </div>
          <span style={{ fontWeight: 700, marginLeft: 8, color: (q.quantity - (q.reserved_quantity||0)) > 0 ? C.green : C.orange }}>{q.quantity - (q.reserved_quantity||0)}</span>
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
          <button onClick={() => requestPrint({ type: "lot", title: `${lot.name} — ${product?.name || ""}`, barcode: lot.name, lotName: lot.name, productName: product?.name || "", expiryDate: lot.expiration_date || lot.use_date || lot.removal_date || "" })}
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

function LocationResult({ location, stock, onRename }: { location: any; stock: any[]; onRename?: (id: number, name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [locName, setLocName] = useState(location.name);
  useEffect(() => setLocName(location.name), [location.name]);

  return (
    <Section>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 2 }}>
        <div style={{ flex: 1 }}>
          {editing ? (
            <div style={{ display: "flex", gap: 4, marginBottom: 4 }}>
              <input style={{ ...inputStyle, fontSize: 15, padding: "4px 8px", fontWeight: 700 }} value={locName}
                onChange={e => setLocName(e.target.value)}
                onKeyDown={e => { e.stopPropagation(); if (e.key === "Enter" && onRename) { onRename(location.id, locName); setEditing(false); } if (e.key === "Escape") { setLocName(location.name); setEditing(false); } }}
                autoFocus />
            </div>
          ) : (
            <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 2, display: "flex", alignItems: "center", gap: 6 }}>
              {location.name}
              {onRename && <button onClick={() => setEditing(true)} style={{ ...iconBtn, width: 22, height: 22 }}>{editIcon}</button>}
            </div>
          )}
          <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 12 }}>{location.barcode || location.complete_name} · {stock.length} réf</div>
        </div>
        {location.barcode && (
          <button onClick={() => requestPrint({ type: "location", title: location.name, barcode: location.barcode, locationName: location.name })}
            style={{ ...iconBtn, background: C.bg, borderRadius: 8, padding: "6px 10px", marginLeft: 8, flexShrink: 0 }}
            title="Imprimer étiquette emplacement">
            {printerIcon}
          </button>
        )}
      </div>
      {stock.map((q, i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: i < stock.length - 1 ? `1px solid ${C.border}` : "", fontSize: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontWeight: 600 }}>{q.product_id[1]}</span>
              {q.product_barcode && (
                <button onClick={() => requestPrint({
                  type: "product", title: q.product_id[1], barcode: q.product_barcode, ref: q.product_ref, productName: q.product_id[1],
                })}
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", display: "inline-flex", alignItems: "center" }}
                title="Imprimer étiquette produit">
                  {printerSmallIcon}
                </button>
              )}
            </div>
            {q.lot_id && (
              <button onClick={() => requestPrint({
                type: "lot", title: `${q.lot_name || q.lot_id[1]} — ${q.product_id[1]}`,
                barcode: q.lot_name || q.lot_id[1], lotName: q.lot_name || q.lot_id[1], productName: q.product_id[1],
                expiryDate: q.expiration_date || "",
              })}
              style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit",
                fontSize: 11, color: C.blue, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 3, marginTop: 2 }}>
                {printerSmallIcon} {q.lot_name || q.lot_id[1]}
                {q.expiration_date && <span style={{ color: C.textMuted, fontWeight: 400 }}> · {(() => { try { return new Date(q.expiration_date).toLocaleDateString("fr-FR", { month: "2-digit", year: "numeric" }); } catch { return ""; } })()}</span>}
              </button>
            )}
          </div>
          <span style={{ fontWeight: 700, color: C.green, marginLeft: 8 }}>{q.quantity - (q.reserved_quantity||0)}</span>
        </div>
      ))}
    </Section>
  );
}

// ============================================
// LOGIN
// ============================================
// ============================================
// PRINT MODAL — choose quantity before printing
// ============================================
function PrintModal({ req, onClose, onToast }: { req: PrintRequest; onClose: () => void; onToast: (m: string) => void }) {
  const [copies, setCopies] = useState(1);
  const [sending, setSending] = useState(false);

  const typeLabels: Record<string, string> = { product: "Produit", lot: "Lot", location: "Emplacement" };
  const typeColors: Record<string, string> = { product: C.blue, lot: C.green, location: "#7c3aed" };

  const doPrint = async () => {
    setSending(true);
    const result = await executePrint(req, copies);
    setSending(false);
    if (result.success) {
      onToast(`✓ ${copies} étiquette(s) envoyée(s)`);
      vibrateSuccess();
    } else {
      onToast("✕ Erreur impression");
      vibrateError();
    }
    onClose();
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "flex-end", justifyContent: "center", background: "rgba(0,0,0,0.4)", animation: "fadeIn .15s" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ width: "100%", maxWidth: 440, background: C.white, borderRadius: "20px 20px 0 0", padding: "24px 20px 32px", boxShadow: "0 -4px 30px rgba(0,0,0,0.15)", animation: "slideUp .2s" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {printerIcon}
            <span style={{ fontSize: 16, fontWeight: 700, color: C.text }}>Imprimer</span>
            <span style={{ fontSize: 11, fontWeight: 600, color: typeColors[req.type] || C.blue, background: `${typeColors[req.type] || C.blue}15`, padding: "2px 8px", borderRadius: 6 }}>
              {typeLabels[req.type] || req.type}
            </span>
          </div>
          <button onClick={onClose} style={{ ...iconBtn, background: C.bg, borderRadius: 8, padding: 6 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={C.textMuted} strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        {/* Label preview info */}
        <div style={{ background: C.bg, borderRadius: 12, padding: 14, marginBottom: 16 }}>
          {req.type === "product" && <>
            {req.ref && <div style={{ fontSize: 13, fontWeight: 700, color: C.blue, marginBottom: 2 }}>{req.ref}</div>}
            <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 4 }}>{req.productName || req.title}</div>
            <div style={{ fontSize: 11, color: C.textMuted, fontFamily: "monospace" }}>{req.barcode}</div>
          </>}
          {req.type === "lot" && <>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 2 }}>{req.lotName}</div>
            <div style={{ fontSize: 12, color: C.textSec, marginBottom: 4 }}>{req.productName}</div>
            {req.expiryDate && <div style={{ fontSize: 12, color: C.orange, fontWeight: 600 }}>
              DLUO: {(() => { try { return new Date(req.expiryDate).toLocaleDateString("fr-FR"); } catch { return req.expiryDate; } })()}
            </div>}
            <div style={{ fontSize: 11, color: C.textMuted, fontFamily: "monospace", marginTop: 4 }}>{req.barcode}</div>
          </>}
          {req.type === "location" && <>
            <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 2 }}>{req.locationName || req.title}</div>
            <div style={{ fontSize: 11, color: C.textMuted, fontFamily: "monospace" }}>{req.barcode}</div>
          </>}
        </div>

        {/* Quantity */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>Nombre d'étiquettes</div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12 }}>
            <button onClick={() => setCopies(c => Math.max(1, c - 1))} style={qtyBtnStyle}>−</button>
            <input type="number" value={copies} min={1} max={99}
              onChange={e => { const v = parseInt(e.target.value); if (v > 0 && v <= 99) setCopies(v); }}
              onKeyDown={e => e.stopPropagation()}
              style={{ width: 60, textAlign: "center", fontSize: 22, fontWeight: 800, fontFamily: "'DM Mono', monospace", border: `2px solid ${C.border}`, borderRadius: 10, padding: "8px 0", background: C.white, color: C.text }} />
            <button onClick={() => setCopies(c => Math.min(99, c + 1))} style={qtyBtnStyle}>+</button>
          </div>
          {/* Presets */}
          <div style={{ display: "flex", justifyContent: "center", gap: 6, marginTop: 10 }}>
            {[1, 2, 5, 10, 25].map(n => (
              <button key={n} onClick={() => setCopies(n)}
                style={{ padding: "6px 12px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                  background: copies === n ? C.blue : C.bg, color: copies === n ? "#fff" : C.textSec,
                  border: `1px solid ${copies === n ? C.blue : C.border}`, transition: "all .1s",
                }}>{n}</button>
            ))}
          </div>
        </div>

        {/* Print button */}
        <button onClick={doPrint} disabled={sending}
          style={{ width: "100%", padding: 16, background: typeColors[req.type] || C.blue, color: "#fff", border: "none", borderRadius: 12, fontSize: 16, fontWeight: 700,
            cursor: sending ? "wait" : "pointer", fontFamily: "inherit", opacity: sending ? 0.6 : 1, transition: "all .15s",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
          }}>
          {printerIconWhite}
          {sending ? "Envoi en cours..." : `Imprimer ${copies} étiquette${copies > 1 ? "s" : ""}`}
        </button>
      </div>
    </div>
  );
}

const qtyBtnStyle: React.CSSProperties = {
  width: 44, height: 44, borderRadius: 12, border: `2px solid ${C.border}`, background: C.bg,
  fontSize: 22, fontWeight: 700, color: C.text, cursor: "pointer", fontFamily: "inherit",
  display: "flex", alignItems: "center", justifyContent: "center",
};

const printerIconWhite = <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><path d="M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>;

// ============================================
// ARRIVAL SCREEN — Packing List Import
// ============================================
function ArrivalScreen({ session, onBack, onToast }: { session: any; onBack: () => void; onToast: (m: string) => void }) {
  const [step, setStep] = useState<"upload" | "result">("upload");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [packingData, setPackingData] = useState<any>(null);
  const [matchData, setMatchData] = useState<Record<string, any>>({});
  const [locationData, setLocationData] = useState<Record<number, any>>({});
  const [openPallets, setOpenPallets] = useState<Record<string, boolean>>({});

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoading(true); setError("");
    try {
      // 1. Parse PDF
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/packing", { method: "POST", body: formData });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error || "Erreur parsing PDF"); }
      const data = await res.json();
      setPackingData(data);

      // 2. Match supplier refs with Odoo
      const allRefs = Array.from(new Set(
        data.pallets.flatMap((p: any) => p.cartons.map((c: any) => c.supplierRef)).filter(Boolean)
      ));
      if (allRefs.length > 0 && session) {
        const matches = await odoo.matchSupplierRefs(session, allRefs);
        setMatchData(matches);

        // 3. Get stock locations for matched products
        const productIds = Array.from(new Set(
          Object.values(matches).map((m: any) => m.product_id).filter(Boolean)
        )) as number[];
        if (productIds.length > 0) {
          const locs = await odoo.getProductLocations(session, productIds);
          setLocationData(locs);
        }
      }

      // Open first pallet by default
      if (data.pallets.length > 0) {
        setOpenPallets({ [data.pallets[0].palletNo]: true });
      }
      setStep("result");
      onToast(`✓ ${data.totalPallets} palette(s), ${data.totalCartons} carton(s) importé(s)`);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const togglePallet = (no: string) => setOpenPallets(prev => ({ ...prev, [no]: !prev[no] }));

  const getMatch = (supplierRef: string) => matchData[supplierRef];
  const getLocation = (supplierRef: string) => {
    const match = getMatch(supplierRef);
    if (match?.product_id) return locationData[match.product_id];
    return null;
  };

  // Summary stats
  const totalRefs = packingData ? Array.from(new Set(packingData.pallets.flatMap((p: any) => p.cartons.map((c: any) => c.supplierRef)))).length : 0;
  const matchedRefs = Object.keys(matchData).length;
  const unmatchedRefs = totalRefs - matchedRefs;

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <button onClick={onBack} style={{ ...iconBtn, background: C.bg, borderRadius: 8, padding: 8 }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: C.text }}>Arrivage</h2>
          <p style={{ fontSize: 12, color: C.textMuted }}>Importer une packing list WALA</p>
        </div>
      </div>

      {step === "upload" && (
        <Section>
          <div style={{ textAlign: "center", padding: "30px 20px" }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>📦</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 8 }}>Importer la Packing List</div>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 20 }}>
              Sélectionne le PDF de la packing list WALA. L'app va parser les palettes, matcher les références fournisseur et suggérer les emplacements de rangement.
            </div>
            <label style={{
              display: "inline-block", padding: "14px 32px", background: "#059669", color: "#fff",
              borderRadius: 12, fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
            }}>
              {loading ? "Analyse en cours..." : "Choisir le PDF"}
              <input type="file" accept=".pdf" onChange={handleUpload} style={{ display: "none" }} disabled={loading} />
            </label>
          </div>
          {error && <Alert type="error">{error}</Alert>}
        </Section>
      )}

      {step === "result" && packingData && (
        <>
          {/* Summary */}
          <Section>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>Transport {packingData.transportNr || "N/A"}</div>
                {packingData.date && <div style={{ fontSize: 11, color: C.textMuted }}>{packingData.date}</div>}
              </div>
              <button onClick={() => { setStep("upload"); setPackingData(null); setMatchData({}); setLocationData({}); }}
                style={{ ...iconBtn, background: C.bg, borderRadius: 8, padding: "6px 10px", fontSize: 11, fontWeight: 600, color: C.textSec, border: `1px solid ${C.border}` }}>
                Nouveau
              </button>
            </div>
            <div style={{ display: "flex", gap: 1, borderRadius: 10, overflow: "hidden" }}>
              <StatBox value={packingData.totalPallets} label="PALETTES" color="#059669" />
              <StatBox value={packingData.totalCartons} label="CARTONS" color={C.blue} />
              <StatBox value={matchedRefs} label="MATCHÉS" color={C.green} />
              {unmatchedRefs > 0 && <StatBox value={unmatchedRefs} label="INCONNUS" color={C.red} />}
            </div>
          </Section>

          {error && <Alert type="error">{error}</Alert>}

          {/* Palettes */}
          {packingData.pallets.map((pallet: any, pi: number) => {
            const isOpen = !!openPallets[pallet.palletNo];
            // Aggregate products on this pallet
            const prodSummary: Record<string, { supplierRef: string; desc: string; lot: string; expiry: string; totalQty: number; cartonCount: number }> = {};
            for (const c of pallet.cartons) {
              const key = `${c.supplierRef}_${c.lot}`;
              if (!prodSummary[key]) {
                prodSummary[key] = { supplierRef: c.supplierRef, desc: c.productDesc, lot: c.lot, expiry: c.expiry, totalQty: 0, cartonCount: 0 };
              }
              prodSummary[key].totalQty += c.qtyProduct;
              prodSummary[key].cartonCount += 1;
            }
            const products = Object.values(prodSummary);

            return (
              <div key={pi} style={{ marginBottom: 10 }}>
                <button onClick={() => togglePallet(pallet.palletNo)} style={{
                  width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "12px 14px", background: C.white, border: `1px solid ${C.border}`, borderRadius: 10,
                  cursor: "pointer", fontFamily: "inherit", boxShadow: C.shadow,
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 16 }}>🔷</span>
                    <div style={{ textAlign: "left" }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>Palette {pallet.palletNo}</div>
                      <div style={{ fontSize: 11, color: C.textMuted }}>{pallet.cartons.length} carton(s) · {products.length} réf(s){pallet.dimensions ? ` · ${pallet.dimensions}` : ""}</div>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: "#059669", background: "#ecfdf5", padding: "2px 8px", borderRadius: 10 }}>{pallet.cartons.length}</span>
                    <span style={{ fontSize: 12, color: C.textMuted, transition: "transform .2s", transform: isOpen ? "rotate(180deg)" : "rotate(0)" }}>▼</span>
                  </div>
                </button>

                {isOpen && (
                  <div style={{ marginTop: 6 }}>
                    {products.map((prod, j) => {
                      const match = getMatch(prod.supplierRef);
                      const loc = getLocation(prod.supplierRef);
                      const isMatched = !!match;
                      return (
                        <div key={j} style={{ ...cardStyle, marginBottom: 6, borderLeft: `3px solid ${isMatched ? C.green : C.orange}` }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                            <div style={{ flex: 1 }}>
                              {isMatched ? (
                                <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{match.product_name}</div>
                              ) : (
                                <div style={{ fontSize: 13, fontWeight: 700, color: C.orange }}>{prod.desc} <span style={{ fontSize: 10, fontWeight: 400 }}>(non trouvé)</span></div>
                              )}
                              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
                                Réf fourn: {prod.supplierRef}
                                {match?.default_code && <span> · Réf interne: {match.default_code}</span>}
                              </div>
                            </div>
                            <div style={{ textAlign: "right", flexShrink: 0 }}>
                              <div style={{ fontSize: 16, fontWeight: 800, color: C.text }}>{prod.totalQty}</div>
                              <div style={{ fontSize: 10, color: C.textMuted }}>{prod.cartonCount} crt</div>
                            </div>
                          </div>
                          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                            {prod.lot && (
                              <span style={{ fontSize: 11, fontWeight: 600, color: C.blue, background: C.blueSoft, padding: "2px 8px", borderRadius: 6 }}>
                                Lot {prod.lot}
                              </span>
                            )}
                            {prod.expiry && (
                              <span style={{ fontSize: 11, color: C.textMuted, background: C.bg, padding: "2px 8px", borderRadius: 6 }}>
                                Exp: {prod.expiry}
                              </span>
                            )}
                            {loc && (
                              <span style={{ fontSize: 11, fontWeight: 600, color: "#059669", background: "#ecfdf5", padding: "2px 8px", borderRadius: 6 }}>
                                📍 {loc.location_name} ({loc.quantity} en stock)
                              </span>
                            )}
                            {isMatched && !loc && (
                              <span style={{ fontSize: 11, color: C.orange, background: C.orangeSoft, padding: "2px 8px", borderRadius: 6 }}>
                                📍 Nouveau produit — pas d'emplacement
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}
    </>
  );
}

// ============================================
// HISTORY SCREEN
// ============================================
function HistoryScreen({ history, onClear, onBack }: { history: HistoryEntry[]; onClear: () => void; onBack: () => void }) {
  const [confirmClear, setConfirmClear] = useState(false);

  // Group by day
  const grouped: Record<string, HistoryEntry[]> = {};
  for (const h of history) {
    const day = new Date(h.date).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
    if (!grouped[day]) grouped[day] = [];
    grouped[day].push(h);
  }

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button onClick={onBack} style={{ ...iconBtn, background: C.bg, borderRadius: 8, padding: 8 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: C.text }}>Historique</h2>
          <span style={{ fontSize: 11, fontWeight: 600, color: C.textMuted, background: C.bg, padding: "2px 8px", borderRadius: 6 }}>{history.length}</span>
        </div>
        {history.length > 0 && (
          <button onClick={() => confirmClear ? onClear() : setConfirmClear(true)}
            style={{ fontSize: 11, fontWeight: 600, color: confirmClear ? C.red : C.textMuted, background: confirmClear ? `${C.red}12` : "none", border: "none", cursor: "pointer", fontFamily: "inherit", padding: "6px 10px", borderRadius: 6 }}>
            {confirmClear ? "Confirmer la suppression ?" : "Vider"}
          </button>
        )}
      </div>

      {history.length === 0 ? (
        <Section>
          <div style={{ textAlign: "center", padding: 32, color: C.textMuted, fontSize: 13 }}>Aucun transfert enregistré</div>
        </Section>
      ) : (
        Object.entries(grouped).map(([day, entries]) => (
          <div key={day} style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "capitalize", marginBottom: 8, padding: "0 4px" }}>{day}</div>
            <Section>
              {entries.map((h, i) => (
                <div key={i} style={{ padding: "10px 0", borderBottom: i < entries.length - 1 ? `1px solid ${C.border}` : "none" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ width: 32, height: 32, borderRadius: 8, background: C.blueSoft, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.blue} strokeWidth="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                      </div>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{h.from} → {h.to}</div>
                        <div style={{ fontSize: 11, color: C.textMuted, marginTop: 1 }}>{h.lineCount} ligne{h.lineCount > 1 ? "s" : ""} · {h.products.slice(0, 2).join(", ")}{h.products.length > 2 ? ` +${h.products.length - 2}` : ""}</div>
                      </div>
                    </div>
                    <span style={{ fontSize: 10, color: C.textMuted, whiteSpace: "nowrap" }}>
                      {new Date(h.date).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                </div>
              ))}
            </Section>
          </div>
        ))
      )}
    </>
  );
}

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

  const [hasKey, setHasKey] = useState(true); // assume configured, check on load

  const fetchPrinters = async () => {
    setLoadingP(true); setMsg("");
    try {
      const list = await pn.listPrinters();
      setPrinters(list);
      setHasKey(true);
      if (!list.length) setMsg("Aucune imprimante trouvée");
    } catch (e: any) {
      if (e.message?.includes("non configurée") || e.message?.includes("500")) {
        setHasKey(false);
      }
      setMsg("Erreur: " + e.message);
    }
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
          <Alert type="info">Ajoute PRINTNODE_API_KEY dans les variables d'environnement Vercel pour activer PrintNode.</Alert>
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
  // Group by shipping_date (date d'expédition prévue), fallback date_deadline, then scheduled_date
  const grouped: Record<string, any[]> = {};
  for (const p of pickings) {
    const rawDate = p.shipping_date || p.date_deadline || p.scheduled_date;
    const d = rawDate ? new Date(rawDate).toLocaleDateString("fr-FR", { weekday: "long", day: "2-digit", month: "long", year: "numeric" }) : "Sans date";
    if (!grouped[d]) grouped[d] = [];
    grouped[d].push(p);
  }
  const days = Object.keys(grouped);
  const [openDays, setOpenDays] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    if (days.length > 0) init[days[0]] = true; // first day open by default
    return init;
  });
  const toggle = (d: string) => setOpenDays(prev => ({ ...prev, [d]: !prev[d] }));

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: C.text }}>Préparation</h2>
          <p style={{ fontSize: 12, color: C.textMuted }}>{pickings.length} commande(s) prête(s)</p>
        </div>
        <button onClick={onRefresh} disabled={loading} style={{ ...iconBtn, background: C.blueSoft, borderRadius: 10, padding: "8px 12px" }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={C.blue} strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
        </button>
      </div>

      {error && <Alert type="error">{error}</Alert>}
      {loading && pickings.length === 0 && <div style={{ textAlign: "center", padding: 40, color: C.textMuted }}>Chargement...</div>}
      {!loading && pickings.length === 0 && <Alert type="info">Aucune commande prête à préparer</Alert>}

      {days.map(date => {
        const items = grouped[date];
        const isOpen = !!openDays[date];
        return (
          <div key={date} style={{ marginBottom: 12 }}>
            <button onClick={() => toggle(date)} style={{
              width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "10px 14px", background: C.white, border: `1px solid ${C.border}`, borderRadius: 10,
              cursor: "pointer", fontFamily: "inherit", boxShadow: C.shadow,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 14 }}>📅</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{date}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: C.blue, background: C.blueSoft, padding: "2px 8px", borderRadius: 10 }}>{items.length}</span>
                <span style={{ fontSize: 12, color: C.textMuted, transition: "transform .2s", transform: isOpen ? "rotate(180deg)" : "rotate(0)" }}>▼</span>
              </div>
            </button>

            {isOpen && (
              <div style={{ marginTop: 8, paddingLeft: 4 }}>
                {items.map((p: any) => {
                  const moveCount = (p.move_ids_without_package || []).length;
                  return (
                    <div key={p.id} style={{ ...cardStyle, marginBottom: 8 }}>
                      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 8 }}>
                        <div>
                          <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{p.name}</div>
                          {p.partner_id && <div style={{ fontSize: 12, color: C.textSec }}>{p.partner_id[1]}</div>}
                          {p.origin && <div style={{ fontSize: 11, color: C.textMuted }}>Origine: {p.origin}</div>}
                        </div>
                        <span style={{ fontSize: 11, fontWeight: 700, color: C.green, background: C.greenSoft, padding: "3px 8px", borderRadius: 6 }}>Prêt</span>
                      </div>
                      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 10 }}>{moveCount} article(s)</div>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button onClick={() => onOpen(p)} style={{ flex: 2, padding: "10px 0", background: C.blue, color: "#fff", border: "none", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                          Préparer
                        </button>
                        <button onClick={() => onReport(p.id)} style={{ padding: "10px 12px", background: C.bg, color: C.textSec, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                          🖨
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

// ============================================
// PREPARATION DETAIL SCREEN
// ============================================
function PrepDetailScreen({ picking, moves, moveLines, scanned, loading, error, prepStep, onScan, onTakeAll, onCancelStep, onAutoFill, onValidate, onBack, onReport }: any) {
  const totalLines = moveLines.length;
  const doneLines = moveLines.filter((ml: any) => (ml.qty_done || 0) >= (ml.reserved_uom_qty || 0)).length;
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

      {/* Scan input — 2 step process */}
      <Section>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>
            {!prepStep ? "① Scanner un emplacement" : "② Scanner le lot / produit"}
          </span>
          {loading && <Spinner />}
        </div>
        {prepStep && (
          <div style={{ background: C.blueSoft, border: `1px solid ${C.blueBorder}`, borderRadius: 8, padding: "8px 12px", marginBottom: 10, fontSize: 12 }}>
            <div style={{ fontWeight: 700, color: C.blue }}>📍 {prepStep.locName}</div>
            <div style={{ color: C.text, marginTop: 2 }}>
              → {prepStep.lotName ? `Lot ${prepStep.lotName}` : prepStep.productName}
              <span style={{ color: C.textMuted }}> · reste {prepStep.remaining}</span>
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <button onClick={onTakeAll} disabled={loading} style={{
                flex: 1, padding: "8px 0", background: C.green, color: "#fff", border: "none", borderRadius: 8,
                fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit"
              }}>
                Tout prendre ({prepStep.locName})
              </button>
              <button onClick={onCancelStep} style={{
                padding: "8px 12px", background: C.bg, color: C.textMuted, border: `1px solid ${C.border}`, borderRadius: 8,
                fontSize: 11, cursor: "pointer", fontFamily: "inherit"
              }}>
                ✕
              </button>
            </div>
          </div>
        )}
        <InputBar onSubmit={onScan} placeholder={prepStep ? "Lot, code-barres, réf..." : "Scanner l'emplacement source..."} />
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
                {m.relatedLines.length > 0 ? m.relatedLines.map((ml: any, j: number) => (
                  <div key={j} style={{ fontSize: 11, color: C.textMuted, display: "flex", gap: 4 }}>
                    <span style={{ color: C.blue }}>📍 {ml.location_id?.[1] || "?"}</span>
                    {ml.lot_id && <span>· Lot {ml.lot_id[1]}</span>}
                    <span>· {ml.qty_done || 0}/{ml.reserved_uom_qty || 0}</span>
                  </div>
                )) : (
                  <div style={{ fontSize: 11, color: C.textMuted, display: "flex", gap: 4 }}>
                    <span style={{ color: C.blue }}>📍 {m.location_id?.[1] || "?"}</span>
                    <span>· 0/{m.product_uom_qty}</span>
                  </div>
                )}
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
            <img src={DH_LOGO} alt="Dr. Hauschka" style={{ height: 44, objectFit: "contain", marginBottom: 12 }} />
            <h1 style={{ fontSize: 20, fontWeight: 700, color: C.text }}>WMS Scanner</h1>
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
const printerSmallIcon = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={C.blue} strokeWidth="2.5"><path d="M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>;
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
