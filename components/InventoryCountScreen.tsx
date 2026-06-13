"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import * as odoo from "@/lib/odoo";
import {
  WmsInventoryEntry, WmsInventorySession,
  loadInventorySessions, createInventorySession, updateInventoryEntries,
  setInventoryStatus, deleteInventorySession,
} from "@/lib/supabase";

const C = {
  bg: "#f8fafc", white: "#ffffff", text: "#1a1a2e", textSec: "#374151",
  textMuted: "#6b7280", border: "#e5e7eb", blue: "#3b82f6", blueSoft: "#eff6ff",
  green: "#22c55e", greenSoft: "#f0fdf4", red: "#ef4444", redSoft: "#fef2f2",
  orange: "#f97316", orangeSoft: "#fff7ed", amber: "#f59e0b", amberSoft: "#fffbeb",
  purple: "#7c3aed", purpleSoft: "#f5f3ff",
  shadow: "0 1px 4px rgba(0,0,0,0.07)",
};

interface Props {
  session: odoo.OdooSession;
  onBack: () => void;
  onToast: (msg: string, type?: "success" | "error" | "info") => void;
  /** Code scanné (PDA / caméra) routé depuis page.tsx quand l'écran est actif */
  scanCode?: string | null;
  onScanConsumed?: () => void;
}

const calcCounted = (e: WmsInventoryEntry) =>
  (Number(e.colis) || 0) * (Number(e.unitsPerColis) || 0) + (Number(e.vrac) || 0);

// ════════════════════════════════════════════════════════════════
//  VUE 1 — liste des sessions d'inventaire
// ════════════════════════════════════════════════════════════════
function SessionList({ onBack, onToast, onOpen }: Props & { onOpen: (s: WmsInventorySession) => void }) {
  const [sessions, setSessions] = useState<WmsInventorySession[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [mode, setMode] = useState<"location" | "scan">("location");
  const [creating, setCreating] = useState(false);

  const today = new Date();
  const dateStr = `${String(today.getDate()).padStart(2, "0")}/${String(today.getMonth() + 1).padStart(2, "0")}`;

  const load = useCallback(async () => {
    try { setSessions(await loadInventorySessions()); }
    catch (e: any) { onToast("Erreur chargement : " + e.message, "error"); }
    setLoading(false);
  }, [onToast]);
  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    const name = newName.trim() || `Inventaire ${dateStr}`;
    setCreating(true);
    try {
      const s = await createInventorySession(name, mode);
      setNewName("");
      onOpen(s);
    } catch (e: any) { onToast("Erreur création : " + e.message, "error"); }
    setCreating(false);
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Supprimer cet inventaire ?")) return;
    try { await deleteInventorySession(id); setSessions(prev => prev.filter(s => s.id !== id)); }
    catch { onToast("Erreur suppression", "error"); }
  };

  return (
    <div style={{ padding: "20px 16px", maxWidth: 640, margin: "0 auto", fontFamily: "'DM Sans', sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <button onClick={onBack} style={{ background: C.bg, border: "none", borderRadius: 10, padding: 8, cursor: "pointer", display: "flex" }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
        </button>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>Inventaire tournant</div>
          <div style={{ fontSize: 12, color: C.textMuted }}>Comptage, matching Odoo & corrections</div>
        </div>
      </div>

      {/* Nouvelle session */}
      <div style={{ background: C.white, border: `1.5px solid ${C.blue}`, borderRadius: 14, padding: 16, marginBottom: 20, boxShadow: "0 0 0 3px #eff6ff" }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.blue, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 12 }}>Nouvel inventaire</div>
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          {([["location", "Par allée / emplacement"], ["scan", "Scan libre"]] as const).map(([m, lbl]) => (
            <button key={m} onClick={() => setMode(m)}
              style={{ flex: 1, padding: "10px 8px", borderRadius: 10, border: `1.5px solid ${mode === m ? C.blue : C.border}`, background: mode === m ? C.blueSoft : C.white, color: mode === m ? C.blue : C.textSec, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
              {lbl}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={newName} onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") handleCreate(); }}
            placeholder={`Inventaire ${dateStr}`}
            style={{ flex: 1, padding: "10px 12px", border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit", background: C.bg, color: C.text }} />
          <button onClick={handleCreate} disabled={creating}
            style={{ padding: "0 18px", background: C.blue, color: "#fff", border: "none", borderRadius: 10, fontWeight: 700, fontSize: 14, cursor: "pointer", opacity: creating ? 0.6 : 1 }}>
            {creating ? "…" : "Créer →"}
          </button>
        </div>
      </div>

      {/* Liste */}
      {loading ? (
        <div style={{ textAlign: "center", color: C.textMuted, padding: 40 }}>Chargement…</div>
      ) : sessions.length === 0 ? (
        <div style={{ textAlign: "center", color: C.textMuted, padding: 40, fontSize: 14 }}>Aucun inventaire pour l'instant</div>
      ) : sessions.map(s => {
        const total = s.entries.reduce((n, e) => n + calcCounted(e), 0);
        return (
          <div key={s.id} onClick={() => onOpen(s)}
            style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 16px", marginBottom: 10, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", boxShadow: C.shadow }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{s.name}</div>
              <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>
                {s.mode === "location" ? "📍 Par emplacement" : "🔍 Scan libre"} · {s.entries.length} ligne{s.entries.length > 1 ? "s" : ""} · {total} u. comptées
                {s.status === "closed" && <span style={{ color: C.green, fontWeight: 700 }}> · ✓ clôturé</span>}
              </div>
            </div>
            <button onClick={e => handleDelete(s.id, e)} title="Supprimer"
              style={{ background: "none", border: "none", cursor: "pointer", padding: 6, color: C.textMuted, display: "flex" }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
//  VUE 2 — comptage d'une session
// ════════════════════════════════════════════════════════════════
function CountView({ session, sess, onBack, onToast, scanCode, onScanConsumed }: Props & { sess: WmsInventorySession }) {
  const isAdmin = odoo.isAdmin(session);
  const [entries, setEntries] = useState<WmsInventoryEntry[]>(sess.entries || []);
  const [locInput, setLocInput] = useState("");
  const [activeLoc, setActiveLoc] = useState<{ id: number; name: string } | null>(null);
  const [scanInput, setScanInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [matching, setMatching] = useState(false);
  const [applying, setApplying] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();

  // Persistance debouncée vers Supabase
  const persist = useCallback((next: WmsInventoryEntry[]) => {
    setEntries(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      updateInventoryEntries(sess.id, next).catch(() => onToast("⚠ Sauvegarde échouée", "error"));
    }, 600);
  }, [sess.id, onToast]);

  // ── Ajouter / incrémenter une ligne à partir d'un code scanné ──
  const addByCode = useCallback(async (code: string) => {
    const trimmed = code.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const r = await odoo.smartScan(session, trimmed);
      let productId = 0, productName = "", odooRef = "", barcode = trimmed, lotId: number | null = null, lotName = "";
      if (r.type === "product") {
        productId = r.data.id; productName = r.data.name; odooRef = r.data.default_code || ""; barcode = r.data.barcode || trimmed;
      } else if (r.type === "lot" && r.data.product) {
        productId = r.data.product.id; productName = r.data.product.name; odooRef = r.data.product.default_code || "";
        barcode = r.data.product.barcode || ""; lotId = r.data.lot.id; lotName = r.data.lot.name;
      } else {
        onToast(`"${trimmed}" introuvable`, "error");
        setBusy(false); return;
      }

      // packaging (unités/colis) depuis Odoo
      const packMap = await odoo.getPackagingQtyForProducts(session, [productId]);
      const unitsPerColis = packMap[productId] || 0;

      const locId = sess.mode === "location" ? (activeLoc?.id ?? null) : null;
      const locName = sess.mode === "location" ? (activeLoc?.name ?? "") : "";

      // ligne existante = même produit + même lot + même emplacement
      const idx = entries.findIndex(e =>
        e.productId === productId && (e.lotId ?? 0) === (lotId ?? 0) && (e.locationId ?? 0) === (locId ?? 0));
      let next: WmsInventoryEntry[];
      if (idx >= 0) {
        next = [...entries];
        next[idx] = { ...next[idx], vrac: (Number(next[idx].vrac) || 0) + 1 };
      } else {
        const e: WmsInventoryEntry = {
          productId, productName, odooRef, barcode, lotId, lotName,
          locationId: locId, locationName: locName,
          colis: 0, unitsPerColis, vrac: 1, counted: 0,
        };
        next = [e, ...entries];
      }
      persist(next);
      onToast(lotName ? `+1 ${lotName}` : `+1 ${odooRef || productName}`, "success");
    } catch (e: any) { onToast("Erreur : " + e.message, "error"); }
    setBusy(false);
  }, [session, entries, activeLoc, sess.mode, persist, onToast]);

  // Scan PDA/caméra routé depuis page.tsx
  useEffect(() => {
    if (scanCode) { addByCode(scanCode); onScanConsumed?.(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanCode]);

  // ── Charger le théorique d'un emplacement (mode allée) → pré-remplit les lignes à compter ──
  const loadLocation = async () => {
    const q = locInput.trim();
    if (!q) return;
    setBusy(true);
    try {
      const locs = await odoo.findLocationsByName(session, q);
      if (!locs.length) { onToast(`Emplacement "${q}" introuvable`, "error"); setBusy(false); return; }
      const loc = locs[0];
      setActiveLoc({ id: loc.id, name: loc.complete_name || loc.name });
      // pré-charge les produits présents (théorique) pour cet emplacement, à 0 compté
      const quants = await odoo.getProductsAtLocation(session, loc.id);
      const productIds = Array.from(new Set(quants.map((qq: any) => qq.product_id[0]))) as number[];
      const packMap = await odoo.getPackagingQtyForProducts(session, productIds);
      const preload: WmsInventoryEntry[] = quants.map((qq: any) => ({
        productId: qq.product_id[0],
        productName: qq.product_id[1],
        odooRef: qq.product_ref || "",
        barcode: qq.product_barcode || "",
        lotId: qq.lot_id ? qq.lot_id[0] : null,
        lotName: qq.lot_name || (qq.lot_id ? qq.lot_id[1] : ""),
        locationId: loc.id,
        locationName: loc.complete_name || loc.name,
        colis: 0, unitsPerColis: packMap[qq.product_id[0]] || 0, vrac: 0, counted: 0,
      }));
      // fusionne sans écraser les lignes déjà comptées de cet emplacement
      const existing = entries.filter(e => e.locationId === loc.id);
      const merged = [...entries];
      for (const p of preload) {
        const has = existing.find(e => e.productId === p.productId && (e.lotId ?? 0) === (p.lotId ?? 0));
        if (!has) merged.unshift(p);
      }
      persist(merged);
      setLocInput("");
      onToast(`📍 ${loc.complete_name || loc.name} — ${preload.length} réf. à compter`, "info");
    } catch (e: any) { onToast("Erreur : " + e.message, "error"); }
    setBusy(false);
  };

  const updateField = (i: number, field: "colis" | "unitsPerColis" | "vrac", val: string) => {
    const n = Math.max(0, Number(val) || 0);
    const next = [...entries]; next[i] = { ...next[i], [field]: n };
    persist(next);
  };
  const removeLine = (i: number) => { const next = entries.filter((_, k) => k !== i); persist(next); };

  // ── MATCHING : compare le compté au théorique Odoo temps réel ──
  const runMatching = async () => {
    if (!entries.length) { onToast("Rien à comparer", "info"); return; }
    setMatching(true);
    try {
      const keys = entries.map(e => ({ productId: e.productId, lotId: e.lotId, locationId: e.locationId }));
      const theo = await odoo.getInventoryTheoretical(session, keys);
      const next = entries.map((e, i) => ({
        ...e,
        counted: calcCounted(e),
        theoretical: theo[i]?.theoretical ?? 0,
        quantId: theo[i]?.quantId ?? null,
        matchedAt: new Date().toISOString(),
      }));
      persist(next);
      setShowResults(true);
      onToast("Matching effectué ✓", "success");
    } catch (e: any) { onToast("Erreur matching : " + e.message, "error"); }
    setMatching(false);
  };

  const ecart = (e: WmsInventoryEntry) => calcCounted(e) - (e.theoretical ?? 0);

  // ── Appliquer une correction unique dans Odoo ──
  const applyOne = async (i: number) => {
    if (!isAdmin) { onToast("Réservé aux admins", "error"); return; }
    const e = entries[i];
    const counted = calcCounted(e);
    if (!confirm(`Ajuster ${e.lotName || e.odooRef} → ${counted} unités dans Odoo ?\n(théorique actuel : ${e.theoretical ?? "?"})`)) return;
    setApplying(true);
    try {
      const reason = `Inventaire tournant ${sess.name} (${new Date().toLocaleDateString("fr-FR")})`;
      if (e.quantId) {
        await odoo.applyInventoryAdjustment(session, e.quantId, counted, reason);
      } else {
        // pas de quant existant → en crée un (produit absent du théorique)
        const locId = e.locationId;
        if (!locId) { onToast("Impossible : pas d'emplacement pour créer le stock", "error"); setApplying(false); return; }
        await odoo.createInventoryAdjustment(session, e.productId, locId, counted, e.lotId || undefined, reason);
      }
      // marque la ligne corrigée : théorique = compté
      const next = [...entries]; next[i] = { ...next[i], theoretical: counted };
      persist(next);
      onToast("✓ Stock ajusté dans Odoo", "success");
    } catch (err: any) { onToast("Erreur Odoo : " + err.message, "error"); }
    setApplying(false);
  };

  // ── Appliquer TOUTES les corrections en écart ──
  const applyAll = async () => {
    if (!isAdmin) { onToast("Réservé aux admins", "error"); return; }
    const idxs = entries.map((e, i) => ({ e, i })).filter(({ e }) => e.matchedAt && ecart(e) !== 0);
    if (!idxs.length) { onToast("Aucun écart à corriger", "info"); return; }
    if (!confirm(`Appliquer ${idxs.length} correction(s) dans Odoo ?`)) return;
    setApplying(true);
    const reason = `Inventaire tournant ${sess.name} (${new Date().toLocaleDateString("fr-FR")})`;
    let ok = 0, fail = 0;
    const next = [...entries];
    for (const { e, i } of idxs) {
      const counted = calcCounted(e);
      try {
        if (e.quantId) await odoo.applyInventoryAdjustment(session, e.quantId, counted, reason);
        else if (e.locationId) await odoo.createInventoryAdjustment(session, e.productId, e.locationId, counted, e.lotId || undefined, reason);
        else { fail++; continue; }
        next[i] = { ...next[i], theoretical: counted };
        ok++;
      } catch { fail++; }
    }
    persist(next);
    setApplying(false);
    onToast(`${ok} corrigé(s)${fail ? `, ${fail} échec(s)` : ""}`, fail ? "error" : "success");
  };

  // ── Export Excel ──
  const exportExcel = async () => {
    try {
      const XLSX = await import("xlsx");
      const matched = entries.some(e => e.matchedAt);
      const rows = entries.map(e => {
        const counted = calcCounted(e);
        const base: any = {
          "Emplacement": e.locationName || "(scan libre)",
          "Réf interne": e.odooRef || "",
          "Produit": e.productName,
          "Lot": e.lotName || "",
          "Colis": e.colis,
          "Unités/colis": e.unitsPerColis,
          "Vrac": e.vrac,
          "Qté comptée": counted,
        };
        if (matched) {
          base["Théorique Odoo"] = e.theoretical ?? "";
          base["Écart"] = e.matchedAt ? counted - (e.theoretical ?? 0) : "";
        }
        return base;
      });
      const ws = XLSX.utils.json_to_sheet(rows);
      ws["!cols"] = [{ wch: 22 }, { wch: 16 }, { wch: 40 }, { wch: 18 }, { wch: 8 }, { wch: 12 }, { wch: 8 }, { wch: 12 }, { wch: 14 }, { wch: 10 }];
      const wb = XLSX.utils.book_new();
      const safeSheet = sess.name.replace(/[:\\\/\?\*\[\]]/g, "-").substring(0, 31);
      const safeFile = sess.name.replace(/[^a-zA-Z0-9À-ÿ\s\-_]/g, "_");
      XLSX.utils.book_append_sheet(wb, ws, safeSheet);
      XLSX.writeFile(wb, `${safeFile}.xlsx`);
      onToast("Excel exporté ✓", "success");
    } catch (e: any) { onToast("Erreur export : " + e.message, "error"); }
  };

  const matchedCount = entries.filter(e => e.matchedAt).length;
  const ecartCount = entries.filter(e => e.matchedAt && ecart(e) !== 0).length;
  const totalCounted = entries.reduce((n, e) => n + calcCounted(e), 0);

  return (
    <div style={{ padding: "16px 14px 100px", maxWidth: 980, margin: "0 auto", fontFamily: "'DM Sans', sans-serif" }}>
      {/* En-tête */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <button onClick={onBack} style={{ background: C.bg, border: "none", borderRadius: 10, padding: 8, cursor: "pointer", display: "flex" }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: C.text }}>{sess.name}</div>
          <div style={{ fontSize: 12, color: C.textMuted }}>
            {sess.mode === "location" ? "📍 Par emplacement" : "🔍 Scan libre"} · {entries.length} ligne{entries.length > 1 ? "s" : ""} · {totalCounted} u. comptées
          </div>
        </div>
        <button onClick={exportExcel} title="Export Excel"
          style={{ background: C.greenSoft, border: `1px solid #bbf7d0`, color: "#16a34a", borderRadius: 10, padding: "8px 12px", fontWeight: 700, fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Excel
        </button>
      </div>

      {/* Mode emplacement : charger une allée */}
      {sess.mode === "location" && (
        <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, padding: 12, marginBottom: 12, boxShadow: C.shadow }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Allée / emplacement à compter</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input value={locInput} onChange={e => setLocInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") loadLocation(); }}
              placeholder="Nom ou code d'emplacement (ex: A-01)"
              style={{ flex: 1, padding: "10px 12px", border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit", background: C.bg }} />
            <button onClick={loadLocation} disabled={busy}
              style={{ padding: "0 16px", background: C.blue, color: "#fff", border: "none", borderRadius: 10, fontWeight: 700, fontSize: 14, cursor: "pointer", opacity: busy ? 0.6 : 1 }}>Charger</button>
          </div>
          {activeLoc && <div style={{ marginTop: 8, fontSize: 13, color: C.blue, fontWeight: 600 }}>📍 Emplacement actif : {activeLoc.name}</div>}
        </div>
      )}

      {/* Scan manuel (complément au PDA/caméra) */}
      <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, padding: 12, marginBottom: 14, boxShadow: C.shadow }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Scanner un lot / une référence</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={scanInput} onChange={e => setScanInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && scanInput.trim()) { addByCode(scanInput); setScanInput(""); } }}
            placeholder="Lot, code-barres ou réf…"
            style={{ flex: 1, padding: "10px 12px", border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit", background: C.bg }} />
          <button onClick={() => { if (scanInput.trim()) { addByCode(scanInput); setScanInput(""); } }} disabled={busy}
            style={{ padding: "0 16px", background: C.purple, color: "#fff", border: "none", borderRadius: 10, fontWeight: 700, fontSize: 14, cursor: "pointer", opacity: busy ? 0.6 : 1 }}>+ Ajouter</button>
        </div>
      </div>

      {/* Boutons matching / corrections */}
      {entries.length > 0 && (
        <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
          <button onClick={runMatching} disabled={matching}
            style={{ flex: 1, minWidth: 160, padding: "12px", background: C.amber, color: "#fff", border: "none", borderRadius: 11, fontWeight: 800, fontSize: 14, cursor: "pointer", opacity: matching ? 0.6 : 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>
            {matching ? "Comparaison…" : "Faire le matching"}
          </button>
          {matchedCount > 0 && isAdmin && (
            <button onClick={applyAll} disabled={applying || ecartCount === 0}
              style={{ flex: 1, minWidth: 160, padding: "12px", background: ecartCount ? C.red : "#cbd5e1", color: "#fff", border: "none", borderRadius: 11, fontWeight: 800, fontSize: 14, cursor: ecartCount ? "pointer" : "default", opacity: applying ? 0.6 : 1 }}>
              {applying ? "Application…" : `Corriger tout (${ecartCount})`}
            </button>
          )}
        </div>
      )}

      {/* Bandeau résultats matching */}
      {matchedCount > 0 && (
        <div style={{ display: "flex", gap: 8, marginBottom: 12, fontSize: 12 }}>
          <span style={{ background: C.greenSoft, color: "#16a34a", borderRadius: 8, padding: "5px 10px", fontWeight: 700 }}>✓ {matchedCount - ecartCount} OK</span>
          <span style={{ background: C.redSoft, color: C.red, borderRadius: 8, padding: "5px 10px", fontWeight: 700 }}>⚠ {ecartCount} écart{ecartCount > 1 ? "s" : ""}</span>
          {!isAdmin && ecartCount > 0 && <span style={{ color: C.textMuted, alignSelf: "center" }}>(corrections réservées aux admins)</span>}
        </div>
      )}

      {/* Lignes */}
      {entries.length === 0 ? (
        <div style={{ textAlign: "center", color: C.textMuted, padding: 40, fontSize: 14 }}>
          {sess.mode === "location" ? "Charge un emplacement ou scanne un lot pour démarrer" : "Scanne un lot ou une référence pour démarrer"}
        </div>
      ) : entries.map((e, i) => {
        const counted = calcCounted(e);
        const hasMatch = !!e.matchedAt;
        const d = hasMatch ? counted - (e.theoretical ?? 0) : 0;
        const bg = !hasMatch ? C.white : d === 0 ? C.greenSoft : C.redSoft;
        const bd = !hasMatch ? C.border : d === 0 ? "#bbf7d0" : "#fecaca";
        return (
          <div key={`${e.productId}-${e.lotId ?? 0}-${e.locationId ?? 0}-${i}`}
            style={{ background: bg, border: `1px solid ${bd}`, borderRadius: 12, padding: "12px 14px", marginBottom: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.text, overflow: "hidden", textOverflow: "ellipsis" }}>{e.productName}</div>
                <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>
                  {e.odooRef && <span>{e.odooRef}</span>}
                  {e.lotName && <span> · Lot {e.lotName}</span>}
                  {e.locationName && <span> · {e.locationName}</span>}
                </div>
              </div>
              <button onClick={() => removeLine(i)} title="Retirer"
                style={{ background: "none", border: "none", cursor: "pointer", padding: 4, color: C.textMuted, flexShrink: 0 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>

            {/* Saisie colis + vrac */}
            <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
              <Field label="Colis" value={e.colis} onChange={v => updateField(i, "colis", v)} />
              <span style={{ color: C.textMuted, paddingBottom: 8 }}>×</span>
              <Field label="U./colis" value={e.unitsPerColis} onChange={v => updateField(i, "unitsPerColis", v)} highlight={!e.unitsPerColis} />
              <span style={{ color: C.textMuted, paddingBottom: 8 }}>+</span>
              <Field label="Vrac" value={e.vrac} onChange={v => updateField(i, "vrac", v)} />
              <div style={{ marginLeft: "auto", textAlign: "right", paddingBottom: 2 }}>
                <div style={{ fontSize: 10, color: C.textMuted, fontWeight: 700 }}>TOTAL COMPTÉ</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: C.text }}>{counted}</div>
              </div>
            </div>

            {/* Résultat matching */}
            {hasMatch && (
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px dashed ${bd}`, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <span style={{ fontSize: 13, color: C.textSec }}>Théorique Odoo : <b>{e.theoretical}</b></span>
                <span style={{ fontSize: 13, fontWeight: 800, color: d === 0 ? "#16a34a" : C.red }}>
                  {d === 0 ? "✓ Conforme" : `Écart : ${d > 0 ? "+" : ""}${d}`}
                </span>
                {d !== 0 && isAdmin && (
                  <button onClick={() => applyOne(i)} disabled={applying}
                    style={{ marginLeft: "auto", padding: "6px 14px", background: C.red, color: "#fff", border: "none", borderRadius: 8, fontWeight: 700, fontSize: 12, cursor: "pointer", opacity: applying ? 0.6 : 1 }}>
                    Corriger → {counted}
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Field({ label, value, onChange, highlight }: { label: string; value: number; onChange: (v: string) => void; highlight?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontSize: 10, color: highlight ? "#ea580c" : "#6b7280", fontWeight: 700 }}>{label}</span>
      <input type="number" inputMode="numeric" value={value || ""} onChange={e => onChange(e.target.value)}
        onFocus={e => e.target.select()}
        style={{ width: 64, padding: "7px 8px", border: `1.5px solid ${highlight ? "#fdba74" : "#e5e7eb"}`, borderRadius: 8, fontSize: 15, fontWeight: 700, textAlign: "center", fontFamily: "inherit", background: highlight ? "#fff7ed" : "#fff", color: "#1a1a2e" }} />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
//  Wrapper
// ════════════════════════════════════════════════════════════════
export default function InventoryCountScreen(props: Props) {
  const [open, setOpen] = useState<WmsInventorySession | null>(null);
  if (open) return <CountView {...props} sess={open} onBack={() => setOpen(null)} />;
  return <SessionList {...props} onOpen={setOpen} />;
}
