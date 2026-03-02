"use client";

import { useState, useEffect, useRef } from "react";
import * as odoo from "@/lib/odoo";

const T = {
  bg: "#0a0f1a", surface: "#111827", surfaceLight: "#1a2236", border: "#1e2d45",
  accent: "#22d3ee", accentDim: "rgba(34,211,238,0.1)",
  success: "#34d399", successDim: "rgba(52,211,153,0.1)",
  warning: "#fbbf24", warningDim: "rgba(251,191,36,0.1)",
  danger: "#f87171", dangerDim: "rgba(248,113,113,0.1)",
  text: "#e2e8f0", textDim: "#64748b", textMuted: "#475569",
};

const Icon = {
  scan: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7V5a2 2 0 012-2h2M17 3h2a2 2 0 012 2v2M21 17v2a2 2 0 01-2 2h-2M7 21H5a2 2 0 01-2-2v-2"/><line x1="7" y1="12" x2="17" y2="12"/></svg>,
  box: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>,
  location: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>,
  check: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>,
  arrow: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>,
  trash: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>,
  back: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>,
  warehouse: <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M20 10v11M8 14v3M12 14v3M16 14v3"/></svg>,
  logout: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>,
  search: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
  transfer: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 014-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>,
  edit: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
};

// ============================================
// SESSION PERSISTENCE (survit au refresh)
// ============================================
const SESSION_KEY = "wms_session";
const CONFIG_KEY = "wms_config";

function saveSession(session: odoo.OdooSession) {
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch {}
}
function loadSession(): odoo.OdooSession | null {
  try {
    const s = sessionStorage.getItem(SESSION_KEY);
    return s ? JSON.parse(s) : null;
  } catch { return null; }
}
function clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch {}
}
function saveConfig(url: string, db: string) {
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify({ url, db })); } catch {}
}
function loadConfig(): { url: string; db: string } | null {
  try {
    const c = localStorage.getItem(CONFIG_KEY);
    return c ? JSON.parse(c) : null;
  } catch { return null; }
}

// ============================================
// MAIN APP
// ============================================
export default function Page() {
  const [screen, setScreen] = useState<"login" | "home" | "scan" | "confirm">("login");
  const [session, setSession] = useState<odoo.OdooSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [locations, setLocations] = useState<any[]>([]);

  // Lookup
  const [lookupResult, setLookupResult] = useState<any>(null);
  const [lookupStock, setLookupStock] = useState<any[]>([]);
  const [lookupType, setLookupType] = useState<string>("");

  // Transfer
  const [sourceLocation, setSourceLocation] = useState<any>(null);
  const [destLocation, setDestLocation] = useState<any>(null);
  const [transferLines, setTransferLines] = useState<any[]>([]);
  const [lastProduct, setLastProduct] = useState<any>(null);
  const [lastLot, setLastLot] = useState<any>(null);
  const [stockInfo, setStockInfo] = useState<any[]>([]);
  const [scanFeedback, setScanFeedback] = useState<{ type: string; message: string } | null>(null);

  // Restore session on load
  useEffect(() => {
    const saved = loadSession();
    if (saved) {
      setSession(saved);
      setScreen("home");
      // Reload locations
      odoo.getLocations(saved).then(setLocations).catch(() => {
        // Session expirée, re-login
        clearSession();
        setScreen("login");
      });
    }
  }, []);

  const handleLogin = async (url: string, db: string, login: string, password: string) => {
    setLoading(true); setError("");
    try {
      const config = { url: url.replace(/\/$/, ""), db };
      const sess = await odoo.authenticate(config, login, password);
      setSession(sess);
      saveSession(sess);
      saveConfig(url, db);
      const locs = await odoo.getLocations(sess);
      setLocations(locs);
      setScreen("home");
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const handleLogout = () => { setSession(null); clearSession(); setScreen("login"); resetTransfer(); clearLookup(); };
  const clearLookup = () => { setLookupResult(null); setLookupStock([]); setLookupType(""); setError(""); };

  // === LOOKUP ===
  const handleLookup = async (code: string) => {
    if (!code || !session) return;
    setLoading(true); setError(""); clearLookup();
    try {
      const result = await odoo.smartScan(session, code);
      switch (result.type) {
        case "product":
          setLookupResult(result.data); setLookupType("product");
          setLookupStock(await odoo.getAllStockForProduct(session, result.data.id));
          break;
        case "lot":
          setLookupResult(result.data); setLookupType("lot");
          if (result.data.product) {
            // Chercher le stock spécifique à ce lot
            const lotStock = await odoo.getStockForLot(session, result.data.lot.id, result.data.product.id);
            setLookupStock(lotStock);
          }
          break;
        case "location":
          setLookupResult(result.data); setLookupType("location");
          setLookupStock(await odoo.getProductsAtLocation(session, result.data.id));
          break;
        case "not_found":
          setError(`"${code}" non reconnu`);
          break;
      }
    } catch (e: any) {
      if (e.message?.includes("Session") || e.message?.includes("session")) {
        clearSession(); setScreen("login"); setError("Session expirée, reconnectez-vous");
      } else { setError(e.message); }
    }
    setLoading(false);
  };

  // === RENAME ===
  const handleRenameLocation = async (locationId: number, newName: string) => {
    if (!session || !newName.trim()) return;
    setLoading(true);
    try {
      await odoo.renameLocation(session, locationId, newName.trim());
      const locs = await odoo.getLocations(session);
      setLocations(locs);
      if (sourceLocation?.id === locationId) setSourceLocation({ ...sourceLocation, name: newName.trim() });
      if (destLocation?.id === locationId) setDestLocation({ ...destLocation, name: newName.trim() });
      if (lookupResult?.id === locationId) setLookupResult({ ...lookupResult, name: newName.trim() });
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  // === TRANSFER ===
  const resetTransfer = () => {
    setSourceLocation(null); setDestLocation(null); setTransferLines([]);
    setLastProduct(null); setLastLot(null); setStockInfo([]);
    setError(""); setScanFeedback(null);
  };
  const startTransfer = () => { resetTransfer(); setScreen("scan"); };

  const handleSmartScan = async (code: string) => {
    if (!code || !session) return;
    setLoading(true); setError(""); setScanFeedback(null);
    setLastProduct(null); setLastLot(null); setStockInfo([]);
    try {
      const result = await odoo.smartScan(session, code);
      switch (result.type) {
        case "location":
          if (!sourceLocation) { setSourceLocation(result.data); setScanFeedback({ type: "success", message: `📍 Source : ${result.data.complete_name || result.data.name}` }); }
          else if (!destLocation) { setDestLocation(result.data); setScanFeedback({ type: "success", message: `📍 Dest : ${result.data.complete_name || result.data.name}` }); }
          else setScanFeedback({ type: "info", message: `📍 ${result.data.complete_name || result.data.name}` });
          break;
        case "product":
          if (!sourceLocation) { setScanFeedback({ type: "warning", message: "Scanne d'abord un emplacement source" }); break; }
          setLastProduct(result.data);
          setScanFeedback({ type: "success", message: `📦 ${result.data.name}` });
          setStockInfo(await odoo.getStockAtLocation(session, result.data.id, sourceLocation.id));
          break;
        case "lot":
          if (!sourceLocation) { setScanFeedback({ type: "warning", message: "Scanne d'abord un emplacement source" }); break; }
          setLastProduct(result.data.product); setLastLot(result.data.lot);
          setScanFeedback({ type: "success", message: `🏷️ Lot ${result.data.lot.name} → ${result.data.product?.name}` });
          if (result.data.product) setStockInfo(await odoo.getStockAtLocation(session, result.data.product.id, sourceLocation.id));
          break;
        case "not_found":
          setScanFeedback({ type: "error", message: `"${code}" non reconnu` });
          break;
      }
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const selectLocation = (loc: any) => {
    if (!sourceLocation) { setSourceLocation(loc); setScanFeedback({ type: "success", message: `📍 Source : ${loc.complete_name || loc.name}` }); }
    else if (!destLocation) { setDestLocation(loc); setScanFeedback({ type: "success", message: `📍 Dest : ${loc.complete_name || loc.name}` }); }
  };

  const addLine = (qty: number, selectedLotId?: number | null, selectedLotName?: string | null) => {
    if (!lastProduct) return;
    setTransferLines((prev) => [...prev, {
      productId: lastProduct.id, productName: lastProduct.name, productCode: lastProduct.default_code,
      qty, uomId: lastProduct.uom_id[0], uomName: lastProduct.uom_id[1],
      lotId: selectedLotId || lastLot?.id || null, lotName: selectedLotName || lastLot?.name || null,
    }]);
    setLastProduct(null); setLastLot(null); setStockInfo([]); setScanFeedback(null);
  };

  const removeLine = (i: number) => setTransferLines((prev) => prev.filter((_, idx) => idx !== i));

  const handleValidate = async () => {
    if (!session || !sourceLocation || !destLocation || !transferLines.length) return;
    setLoading(true); setError("");
    try {
      const pickingId = await odoo.createInternalTransfer(session, sourceLocation.id, destLocation.id, transferLines);
      await odoo.validatePicking(session, pickingId);
      setScreen("confirm");
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const baseStyle: React.CSSProperties = {
    minHeight: "100vh", background: `linear-gradient(180deg, ${T.bg} 0%, #0d1424 100%)`,
    color: T.text, fontFamily: "'JetBrains Mono', 'SF Mono', monospace", maxWidth: 480, margin: "0 auto",
  };
  const currentStep = !sourceLocation ? "source" : !destLocation ? "dest" : "product";

  if (screen === "login") return <LoginScreen onLogin={handleLogin} loading={loading} error={error} />;

  if (screen === "confirm") return (
    <div style={baseStyle}>
      <Header name={session?.name} onLogout={handleLogout} />
      <div style={{ padding: 20, textAlign: "center", paddingTop: 60 }}>
        <div style={{ width: 80, height: 80, borderRadius: "50%", background: T.successDim, border: `2px solid ${T.success}`, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke={T.success} strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
        </div>
        <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Transfert validé !</h2>
        <p style={{ color: T.textDim, fontSize: 13, marginBottom: 30 }}>{transferLines.length} ligne(s) • {sourceLocation?.name} → {destLocation?.name}</p>
        <button style={btnStyle()} onClick={startTransfer}>Nouveau transfert</button>
        <button style={btnSecondary()} onClick={() => setScreen("home")}>Retour accueil</button>
      </div>
    </div>
  );

  // HOME
  if (screen === "home") return (
    <div style={baseStyle}>
      <Header name={session?.name} onLogout={handleLogout} />
      <div style={{ padding: 20 }}>
        <div style={{ ...cardStyle(), border: `1px solid rgba(34,211,238,0.3)`, padding: 20, marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <span style={{ color: T.accent }}>{Icon.search}</span>
            <span style={{ fontSize: 14, fontWeight: 700 }}>Scan libre</span>
          </div>
          <p style={{ fontSize: 11, color: T.textDim, margin: "0 0 12px 0" }}>Code-barres, référence, lot, emplacement</p>
          <ScanField onScan={handleLookup} loading={loading} placeholder="Scanne ou tape n'importe quoi..." />
        </div>

        {error && <div style={{ ...cardStyle(), background: T.dangerDim, borderColor: "rgba(248,113,113,0.3)", color: T.danger, fontSize: 13, textAlign: "center" }}>{error}</div>}

        {lookupType === "product" && lookupResult && <LookupProductCard product={lookupResult} stock={lookupStock} />}
        {lookupType === "lot" && lookupResult && <LookupLotCard lot={lookupResult.lot} product={lookupResult.product} stock={lookupStock} />}
        {lookupType === "location" && lookupResult && <LookupLocationCard location={lookupResult} stock={lookupStock} session={session} onRename={handleRenameLocation} />}

        <button style={{ ...btnStyle(), display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginTop: 12 }} onClick={startTransfer}>
          {Icon.transfer} Nouveau transfert
        </button>
      </div>
    </div>
  );

  // TRANSFER
  return (
    <div style={baseStyle}>
      <Header name={session?.name} onLogout={handleLogout} showBack onBack={() => { setScreen("home"); resetTransfer(); }} />
      <div style={{ padding: 20 }}>
        <div style={{ display: "flex", gap: 4, marginBottom: 20 }}>
          {(["source", "dest", "product"] as const).map((step, i) => (
            <div key={step} style={{ flex: 1, height: 3, borderRadius: 2, background: currentStep === step ? T.accent : (["source","dest","product"].indexOf(currentStep) > i ? T.success : T.border) }}/>
          ))}
        </div>

        {sourceLocation && (
          <div style={{ ...cardStyle(), display: "flex", alignItems: "center", gap: 12, padding: "12px 16px" }}>
            <span style={{ color: T.success }}>{Icon.location}</span>
            <EditableLocation location={sourceLocation} onRename={handleRenameLocation} label="Source" />
            {destLocation && <>
              <span style={{ color: T.textMuted }}>{Icon.arrow}</span>
              <EditableLocation location={destLocation} onRename={handleRenameLocation} label="Dest" />
            </>}
          </div>
        )}

        <div style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <label style={{ ...labelStyle(), marginBottom: 0 }}>Scan intelligent</label>
            {loading && <span style={{ fontSize: 11, color: T.accent }}>Recherche...</span>}
          </div>
          <ScanField onScan={handleSmartScan} loading={loading} placeholder="Code-barres / Réf / Lot / Emplacement..." />
          <p style={{ fontSize: 11, color: T.textMuted, textAlign: "center", marginTop: 6 }}>
            {currentStep === "source" ? "Scanne un emplacement source" : currentStep === "dest" ? "Scanne la destination" : "Scanne produit, réf ou lot"}
          </p>
          <LocationPicker locations={locations} onSelect={selectLocation} />
        </div>

        {scanFeedback && <FeedbackCard feedback={scanFeedback} />}
        {error && <div style={{ ...cardStyle(), background: T.dangerDim, borderColor: "rgba(248,113,113,0.3)", color: T.danger, fontSize: 13, textAlign: "center" }}>{error}</div>}
        {lastProduct && <ProductStockCard product={lastProduct} lot={lastLot} stockInfo={stockInfo} sourceLocation={sourceLocation} onAdd={addLine} />}

        {transferLines.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div style={labelStyle()}>Lignes ({transferLines.length})</div>
            {transferLines.map((line, i) => (
              <div key={i} style={{ ...cardStyle(), display: "flex", alignItems: "center", gap: 12, padding: "10px 14px" }}>
                <span style={{ color: T.accent }}>{Icon.box}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{line.productName}</div>
                  <div style={{ fontSize: 11, color: T.textDim }}>
                    {line.productCode} • {line.qty} {line.uomName}
                    {line.lotName && <span style={{ color: T.accent }}> • Lot {line.lotName}</span>}
                  </div>
                </div>
                <button onClick={() => removeLine(i)} style={{ background: "transparent", border: "none", color: T.danger, cursor: "pointer", padding: 4 }}>{Icon.trash}</button>
              </div>
            ))}
            {!destLocation && <div style={{ ...cardStyle(), background: T.warningDim, borderColor: "rgba(251,191,36,0.3)", color: T.warning, fontSize: 12, textAlign: "center" }}>Scanne une destination</div>}
            {destLocation && (
              <button style={{ ...btnStyle(`linear-gradient(135deg, ${T.success}, #10b981)`), marginTop: 12 }} onClick={handleValidate} disabled={loading}>
                {loading ? "Envoi..." : `Valider (${transferLines.length} ligne${transferLines.length > 1 ? "s" : ""})`}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================
// COMPONENTS
// ============================================

function EditableLocation({ location, onRename, label }: { location: any; onRename: (id: number, name: string) => void; label: string }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(location.name);
  useEffect(() => { setName(location.name); }, [location.name]);
  const save = () => { if (name.trim() && name.trim() !== location.name) onRename(location.id, name.trim()); setEditing(false); };
  return (
    <div style={{ flex: 1 }}>
      {label && <div style={{ fontSize: 11, color: T.textDim }}>{label}</div>}
      {editing ? (
        <div style={{ display: "flex", gap: 4, marginTop: 2 }}>
          <input style={{ ...inputStyle(), fontSize: 12, padding: "4px 8px", flex: 1 }} value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }} autoFocus />
          <button onClick={save} style={{ background: "transparent", border: "none", color: T.success, cursor: "pointer", padding: 2 }}>{Icon.check}</button>
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{location.name}</div>
          <button onClick={() => setEditing(true)} style={{ background: "transparent", border: "none", color: T.textMuted, cursor: "pointer", padding: 2 }}>{Icon.edit}</button>
        </div>
      )}
    </div>
  );
}

function ProductStockCard({ product, lot, stockInfo, sourceLocation, onAdd }: any) {
  const [qty, setQty] = useState("1");
  const [selectedLotId, setSelectedLotId] = useState<number | null>(lot?.id || null);
  const [selectedLotName, setSelectedLotName] = useState<string | null>(lot?.name || null);
  const totalStock = stockInfo.reduce((s: number, q: any) => s + q.quantity, 0);
  const totalReserved = stockInfo.reduce((s: number, q: any) => s + (q.reserved_quantity || 0), 0);
  const available = totalStock - totalReserved;
  const lotsAvailable = stockInfo.filter((q: any) => q.lot_id);

  useEffect(() => { if (lot) { setSelectedLotId(lot.id); setSelectedLotName(lot.name); } else { setSelectedLotId(null); setSelectedLotName(null); } }, [lot]);

  return (
    <div style={{ ...cardStyle(), border: `1px solid rgba(34,211,238,0.3)` }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 14 }}>
        <div style={{ width: 44, height: 44, borderRadius: 10, background: T.accentDim, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{Icon.box}</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 2 }}>{product.name}</div>
          <div style={{ fontSize: 11, color: T.textDim }}>{product.default_code && `Réf: ${product.default_code}`}{product.barcode && ` • EAN: ${product.barcode}`}</div>
        </div>
      </div>

      <div style={{ background: available > 0 ? T.successDim : T.warningDim, border: `1px solid ${available > 0 ? "rgba(52,211,153,0.3)" : "rgba(251,191,36,0.3)"}`, borderRadius: 8, padding: "12px 14px", marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: T.textDim, marginBottom: 6 }}>Stock sur {sourceLocation?.name}</div>
        <div style={{ display: "flex", gap: 16 }}>
          <div><div style={{ fontSize: 22, fontWeight: 800, color: available > 0 ? T.success : T.warning }}>{available}</div><div style={{ fontSize: 10, color: T.textDim }}>Dispo</div></div>
          <div><div style={{ fontSize: 22, fontWeight: 800, color: T.textDim }}>{totalStock}</div><div style={{ fontSize: 10, color: T.textDim }}>Stock</div></div>
          {totalReserved > 0 && <div><div style={{ fontSize: 22, fontWeight: 800, color: T.warning }}>{totalReserved}</div><div style={{ fontSize: 10, color: T.textDim }}>Réservé</div></div>}
        </div>
      </div>

      {lotsAvailable.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle()}>Sélectionner un lot</label>
          {stockInfo.map((q: any, i: number) => {
            if (!q.lot_id) return null;
            const lotQty = q.quantity - (q.reserved_quantity || 0);
            const isSelected = selectedLotId === q.lot_id[0];
            return (
              <button key={i} onClick={() => { if (isSelected) { setSelectedLotId(null); setSelectedLotName(null); } else { setSelectedLotId(q.lot_id[0]); setSelectedLotName(q.lot_id[1]); } }}
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", padding: "10px 12px", borderRadius: 8, marginBottom: 4,
                  background: isSelected ? T.accentDim : T.surfaceLight, border: `1px solid ${isSelected ? T.accent : T.border}`,
                  color: T.text, cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 18, height: 18, borderRadius: 4, border: `2px solid ${isSelected ? T.accent : T.textMuted}`, background: isSelected ? T.accent : "transparent", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    {isSelected && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>}
                  </div>
                  <span style={{ fontWeight: 600 }}>{q.lot_id[1]}</span>
                </div>
                <span style={{ color: lotQty > 0 ? T.success : T.warning, fontWeight: 700 }}>{lotQty} dispo</span>
              </button>
            );
          })}
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle()}>Quantité</label>
          <input style={{ ...inputStyle(), textAlign: "center" as const, fontSize: 16, fontWeight: 700 }} type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} />
        </div>
        <div style={{ display: "flex", alignItems: "flex-end" }}>
          <button style={{ ...btnStyle(), width: "auto", padding: "12px 20px", display: "flex", alignItems: "center", gap: 6 }}
            onClick={() => { if (parseFloat(qty) > 0) onAdd(parseFloat(qty), selectedLotId, selectedLotName); }}>
            {Icon.check} OK
          </button>
        </div>
      </div>
      {available <= 0 && <div style={{ marginTop: 8, fontSize: 11, color: T.warning, textAlign: "center" as const }}>Stock insuffisant</div>}
    </div>
  );
}

// LOOKUP CARDS
function LookupProductCard({ product, stock }: { product: any; stock: any[] }) {
  const totalQty = stock.reduce((s, q) => s + q.quantity, 0);
  const totalRes = stock.reduce((s, q) => s + (q.reserved_quantity || 0), 0);
  return (
    <div style={{ ...cardStyle(), border: `1px solid rgba(34,211,238,0.3)` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
        <div style={{ width: 44, height: 44, borderRadius: 10, background: T.accentDim, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{Icon.box}</div>
        <div><div style={{ fontSize: 14, fontWeight: 700 }}>{product.name}</div><div style={{ fontSize: 11, color: T.textDim }}>{product.default_code && `Réf: ${product.default_code}`}{product.barcode && ` • EAN: ${product.barcode}`}</div></div>
      </div>
      <div style={{ display: "flex", gap: 16, marginBottom: 14, padding: "10px 14px", background: T.successDim, borderRadius: 8, border: `1px solid rgba(52,211,153,0.2)` }}>
        <div><div style={{ fontSize: 22, fontWeight: 800, color: T.success }}>{totalQty - totalRes}</div><div style={{ fontSize: 10, color: T.textDim }}>Dispo total</div></div>
        <div><div style={{ fontSize: 22, fontWeight: 800, color: T.textDim }}>{totalQty}</div><div style={{ fontSize: 10, color: T.textDim }}>Stock total</div></div>
        {totalRes > 0 && <div><div style={{ fontSize: 22, fontWeight: 800, color: T.warning }}>{totalRes}</div><div style={{ fontSize: 10, color: T.textDim }}>Réservé</div></div>}
      </div>
      <div style={labelStyle()}>Par emplacement</div>
      {stock.length === 0 && <div style={{ fontSize: 12, color: T.textMuted, textAlign: "center", padding: 10 }}>Aucun stock</div>}
      {stock.map((q, i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: i < stock.length - 1 ? `1px solid ${T.border}` : "none" }}>
          <div><div style={{ fontSize: 12, fontWeight: 600 }}>{q.location_id[1]}</div>{q.lot_id && <div style={{ fontSize: 10, color: T.accent }}>Lot: {q.lot_id[1]}</div>}</div>
          <div><span style={{ fontSize: 14, fontWeight: 700, color: (q.quantity - (q.reserved_quantity || 0)) > 0 ? T.success : T.warning }}>{q.quantity - (q.reserved_quantity || 0)}</span><span style={{ fontSize: 11, color: T.textDim }}> / {q.quantity}</span></div>
        </div>
      ))}
    </div>
  );
}

function LookupLotCard({ lot, product, stock }: { lot: any; product: any; stock: any[] }) {
  const totalQty = stock.reduce((s, q) => s + q.quantity, 0);
  const totalRes = stock.reduce((s, q) => s + (q.reserved_quantity || 0), 0);
  return (
    <div style={{ ...cardStyle(), border: `1px solid rgba(251,191,36,0.3)` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
        <div style={{ width: 44, height: 44, borderRadius: 10, background: T.warningDim, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: 20 }}>🏷️</div>
        <div><div style={{ fontSize: 14, fontWeight: 700 }}>Lot: {lot.name}</div><div style={{ fontSize: 11, color: T.textDim }}>{product?.name}</div>{product?.default_code && <div style={{ fontSize: 10, color: T.textMuted }}>Réf: {product.default_code}</div>}</div>
      </div>
      <div style={{ display: "flex", gap: 16, marginBottom: 14, padding: "10px 14px", background: T.warningDim, borderRadius: 8, border: `1px solid rgba(251,191,36,0.2)` }}>
        <div><div style={{ fontSize: 22, fontWeight: 800, color: T.warning }}>{totalQty - totalRes}</div><div style={{ fontSize: 10, color: T.textDim }}>Dispo</div></div>
        <div><div style={{ fontSize: 22, fontWeight: 800, color: T.textDim }}>{totalQty}</div><div style={{ fontSize: 10, color: T.textDim }}>Stock</div></div>
      </div>
      <div style={labelStyle()}>Par emplacement</div>
      {stock.length === 0 && <div style={{ fontSize: 12, color: T.textMuted, textAlign: "center", padding: 10 }}>Aucun stock pour ce lot</div>}
      {stock.map((q, i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: i < stock.length - 1 ? `1px solid ${T.border}` : "none" }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>{q.location_id[1]}</div>
          <span style={{ fontSize: 14, fontWeight: 700, color: T.success }}>{q.quantity - (q.reserved_quantity || 0)}</span>
        </div>
      ))}
    </div>
  );
}

function LookupLocationCard({ location, stock, session, onRename }: { location: any; stock: any[]; session: any; onRename: (id: number, name: string) => void }) {
  const totalItems = stock.reduce((s, q) => s + q.quantity, 0);
  return (
    <div style={{ ...cardStyle(), border: `1px solid rgba(52,211,153,0.3)` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
        <div style={{ width: 44, height: 44, borderRadius: 10, background: T.successDim, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{Icon.location}</div>
        <div style={{ flex: 1 }}>
          <EditableLocation location={location} onRename={onRename} label="" />
          {location.barcode && <div style={{ fontSize: 11, color: T.textDim }}>Code: {location.barcode}</div>}
          <div style={{ fontSize: 11, color: T.accent }}>{stock.length} réf • {totalItems} unités</div>
        </div>
      </div>
      <div style={labelStyle()}>Contenu</div>
      {stock.length === 0 && <div style={{ fontSize: 12, color: T.textMuted, textAlign: "center", padding: 10 }}>Vide</div>}
      {stock.map((q, i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: i < stock.length - 1 ? `1px solid ${T.border}` : "none" }}>
          <div><div style={{ fontSize: 12, fontWeight: 600 }}>{q.product_id[1]}</div>{q.lot_id && <div style={{ fontSize: 10, color: T.accent }}>Lot: {q.lot_id[1]}</div>}</div>
          <div><span style={{ fontSize: 14, fontWeight: 700, color: T.success }}>{q.quantity - (q.reserved_quantity || 0)}</span><span style={{ fontSize: 11, color: T.textDim }}> / {q.quantity}</span></div>
        </div>
      ))}
    </div>
  );
}

// SHARED
function ScanField({ onScan, loading, placeholder }: { onScan: (c: string) => void; loading: boolean; placeholder: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <input ref={ref} style={{
      width: "100%", padding: "14px 20px", background: T.surfaceLight, border: `2px solid ${T.accent}`, borderRadius: 12,
      color: T.text, fontSize: 16, fontFamily: "inherit", outline: "none", boxSizing: "border-box" as const,
      textAlign: "center" as const, letterSpacing: "0.08em", boxShadow: `0 0 20px ${T.accentDim}`,
    }} value={value} onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter" && value.trim()) { onScan(value.trim()); setValue(""); } }}
      placeholder={placeholder} autoFocus />
  );
}

function FeedbackCard({ feedback }: { feedback: { type: string; message: string } }) {
  const c: Record<string, any> = {
    success: { bg: T.successDim, border: "rgba(52,211,153,0.3)", text: T.success },
    warning: { bg: T.warningDim, border: "rgba(251,191,36,0.3)", text: T.warning },
    error: { bg: T.dangerDim, border: "rgba(248,113,113,0.3)", text: T.danger },
    info: { bg: T.accentDim, border: "rgba(34,211,238,0.3)", text: T.accent },
  };
  const s = c[feedback.type] || c.info;
  return <div style={{ ...cardStyle(), background: s.bg, borderColor: s.border, color: s.text, fontSize: 13, textAlign: "center" }}>{feedback.message}</div>;
}

function LocationPicker({ locations, onSelect }: { locations: any[]; onSelect: (l: any) => void }) {
  const [show, setShow] = useState(false);
  const [filter, setFilter] = useState("");
  const filtered = locations.filter((l) => (l.complete_name || l.name).toLowerCase().includes(filter.toLowerCase()) || (l.barcode && l.barcode.toLowerCase().includes(filter.toLowerCase())));
  return (<>
    <button style={{ ...btnSecondary(), marginTop: 4, fontSize: 12 }} onClick={() => setShow(!show)}>{show ? "Fermer" : "Choisir manuellement"}</button>
    {show && (
      <div style={{ ...cardStyle(), marginTop: 8, maxHeight: 200, overflowY: "auto" as const }}>
        <input style={{ ...inputStyle(), marginBottom: 8, fontSize: 12 }} placeholder="Filtrer..." value={filter} onChange={(e) => setFilter(e.target.value)} />
        {filtered.slice(0, 30).map((loc) => (
          <button key={loc.id} onClick={() => { onSelect(loc); setShow(false); setFilter(""); }}
            style={{ display: "block", width: "100%", padding: "8px 10px", background: "transparent", border: "none", borderBottom: `1px solid ${T.border}`, color: T.text, fontSize: 12, textAlign: "left" as const, cursor: "pointer", fontFamily: "inherit" }}>
            <span style={{ fontWeight: 600 }}>{loc.complete_name || loc.name}</span>
            {loc.barcode && <span style={{ color: T.textDim, marginLeft: 8 }}>[{loc.barcode}]</span>}
          </button>
        ))}
      </div>
    )}
  </>);
}

function Header({ name, onLogout, showBack, onBack }: { name?: string; onLogout: () => void; showBack?: boolean; onBack?: () => void }) {
  return (
    <div style={{ padding: "16px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: `1px solid ${T.border}`, background: "rgba(17,24,39,0.8)", backdropFilter: "blur(20px)", position: "sticky", top: 0, zIndex: 100 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {showBack && <button onClick={onBack} style={{ background: "transparent", border: "none", color: T.textDim, cursor: "pointer", padding: 0 }}>{Icon.back}</button>}
        <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase" as const, color: T.accent }}>⬡ WMS</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ fontSize: 12, color: T.textDim }}>{name}</span>
        <button onClick={onLogout} style={{ background: "transparent", border: "none", color: T.textDim, cursor: "pointer", padding: 0 }}>{Icon.logout}</button>
      </div>
    </div>
  );
}

function LoginScreen({ onLogin, loading, error }: { onLogin: (u: string, d: string, l: string, p: string) => void; loading: boolean; error: string }) {
  const savedConfig = typeof window !== "undefined" ? loadConfig() : null;
  const [url, setUrl] = useState(savedConfig?.url || ""); const [db, setDb] = useState(savedConfig?.db || "");
  const [login, setLogin] = useState(""); const [pw, setPw] = useState("");
  const [showConfig, setShowConfig] = useState(!savedConfig);
  const submit = () => { if (url && db && login && pw) onLogin(url, db, login, pw); };
  return (
    <div style={{ minHeight: "100vh", background: `linear-gradient(180deg, ${T.bg} 0%, #0d1424 100%)`, color: T.text, fontFamily: "'JetBrains Mono', 'SF Mono', monospace", maxWidth: 480, margin: "0 auto" }}>
      <div style={{ padding: 20, paddingTop: 60 }}>
        <div style={{ textAlign: "center", marginBottom: 40 }}>
          <div style={{ width: 64, height: 64, borderRadius: 16, background: T.accentDim, border: `1px solid ${T.accent}`, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>{Icon.warehouse}</div>
          <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>WMS Scanner</h1>
          <p style={{ color: T.textDim, fontSize: 13 }}>Connexion Odoo</p>
        </div>
        <button style={btnSecondary()} onClick={() => setShowConfig(!showConfig)}>{showConfig ? "Masquer" : "Afficher"} config serveur</button>
        {showConfig && (<div style={{ ...cardStyle(), marginTop: 12 }}>
          <div style={{ marginBottom: 12 }}><label style={labelStyle()}>URL Odoo</label><input style={inputStyle()} placeholder="https://monentreprise.odoo.com" value={url} onChange={(e) => setUrl(e.target.value)} /></div>
          <div><label style={labelStyle()}>Base de données</label><input style={inputStyle()} placeholder="nom_de_la_base" value={db} onChange={(e) => setDb(e.target.value)} /></div>
        </div>)}
        <div style={{ marginTop: 16, marginBottom: 12 }}><label style={labelStyle()}>Identifiant</label><input style={inputStyle()} placeholder="admin@company.com" value={login} onChange={(e) => setLogin(e.target.value)} /></div>
        <div style={{ marginBottom: 20 }}><label style={labelStyle()}>Mot de passe</label><input style={inputStyle()} type="password" placeholder="••••••••" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} /></div>
        {error && <div style={{ ...cardStyle(), background: T.dangerDim, borderColor: "rgba(248,113,113,0.3)", color: T.danger, fontSize: 13, textAlign: "center", marginBottom: 16 }}>{error}</div>}
        <button style={btnStyle()} onClick={submit} disabled={loading}>{loading ? "Connexion..." : "Se connecter"}</button>
      </div>
    </div>
  );
}

function cardStyle(): React.CSSProperties { return { background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: 16, marginBottom: 12 }; }
function labelStyle(): React.CSSProperties { return { fontSize: 11, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.08em", color: T.textDim, marginBottom: 6, display: "block" }; }
function inputStyle(): React.CSSProperties { return { width: "100%", padding: "12px 16px", background: T.surfaceLight, border: `1px solid ${T.border}`, borderRadius: 8, color: T.text, fontSize: 14, fontFamily: "inherit", outline: "none", boxSizing: "border-box" as const }; }
function btnStyle(bg?: string): React.CSSProperties { return { width: "100%", padding: "14px", background: bg || `linear-gradient(135deg, ${T.accent}, #06b6d4)`, color: "#000", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, fontFamily: "inherit", cursor: "pointer", letterSpacing: "0.03em", textTransform: "uppercase" as const }; }
function btnSecondary(): React.CSSProperties { return { width: "100%", padding: "12px", background: "transparent", color: T.accent, border: `1px solid ${T.border}`, borderRadius: 10, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", marginTop: 10 }; }
