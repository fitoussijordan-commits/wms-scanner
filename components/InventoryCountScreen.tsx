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

// Zones du plan magasin (libellés génériques — PAS des emplacements Odoo).
// 16 zones cliquables : A (rack gauche), B→I (colonnes Zone B), R1→R7 (rayons picking).
const ZONE_B = ["B", "C", "D", "E", "F", "G", "H", "I"];
const ZONE_R = ["R1", "R2", "R3", "R4", "R5", "R6", "R7"];

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

  // Écran étroit (PDA Zebra ~360px) → on empile pour éviter le chevauchement.
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const check = () => setNarrow(window.innerWidth < 420);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

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
      <div style={{ background: C.white, border: `1.5px solid ${C.blue}`, borderRadius: 14, padding: narrow ? 12 : 16, marginBottom: 20, boxShadow: narrow ? "none" : "0 0 0 3px #eff6ff", boxSizing: "border-box" }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.blue, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 12 }}>Nouvel inventaire</div>
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          {([["location", narrow ? "📍 Par emplacement" : "Par allée / emplacement"], ["scan", narrow ? "🔍 Scan libre" : "Scan libre"]] as const).map(([m, lbl]) => (
            <button key={m} onClick={() => setMode(m)}
              style={{ flex: 1, padding: "10px 6px", borderRadius: 10, border: `1.5px solid ${mode === m ? C.blue : C.border}`, background: mode === m ? C.blueSoft : C.white, color: mode === m ? C.blue : C.textSec, fontWeight: 700, fontSize: narrow ? 12 : 13, cursor: "pointer", fontFamily: "inherit", lineHeight: 1.2 }}>
              {lbl}
            </button>
          ))}
        </div>
        {/* PDA (écran étroit) : champ puis bouton plein largeur empilés → pas de chevauchement */}
        <div style={{ display: "flex", flexDirection: narrow ? "column" : "row", gap: 8 }}>
          <input value={newName} onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") handleCreate(); }}
            placeholder={`Inventaire ${dateStr}`}
            style={{ flex: 1, width: narrow ? "100%" : undefined, boxSizing: "border-box", padding: "11px 12px", border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit", background: C.bg, color: C.text }} />
          <button onClick={handleCreate} disabled={creating}
            style={{ padding: narrow ? "11px 0" : "0 18px", width: narrow ? "100%" : undefined, background: C.blue, color: "#fff", border: "none", borderRadius: 10, fontWeight: 700, fontSize: 14, cursor: "pointer", opacity: creating ? 0.6 : 1, fontFamily: "inherit" }}>
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
  const [activeAisle, setActiveAisle] = useState("");
  const [scanInput, setScanInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [matching, setMatching] = useState(false);
  const [applying, setApplying] = useState(false);
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (!flashKey) return;
    const t = setTimeout(() => setFlashKey(null), 1200);
    return () => clearTimeout(t);
  }, [flashKey]);

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

      // En mode emplacement : zone choisie. En scan libre : emplacement Odoo réel du lot/produit.
      let locName = sess.mode === "location" ? activeAisle : "";
      if (sess.mode !== "location") {
        try {
          const quants = lotId
            ? await odoo.getStockForLot(session, lotId, productId)
            : await odoo.getAllStockForProduct(session, productId);
          // emplacement avec le plus de stock
          const best = (quants || []).filter((q: any) => q.location_id).sort((a: any, b: any) => (b.quantity || 0) - (a.quantity || 0))[0];
          if (best?.location_id) {
            const full = String(best.location_id[1] || "");
            locName = full.split("/").pop()?.trim() || full;
          }
        } catch {}
      }

      // ligne existante = même produit + même lot + même allée
      const idx = entries.findIndex(e =>
        e.productId === productId && (e.lotId ?? 0) === (lotId ?? 0) && (e.locationName || "") === (locName || ""));
      if (idx >= 0) {
        // la ligne existe déjà → on ne touche PAS aux quantités, on signale juste
        setFlashKey(`${entries[idx].productId}-${entries[idx].lotId ?? 0}-${entries[idx].locationName || ""}`);
        onToast(`Déjà dans la liste : ${lotName || odooRef || productName}`, "info");
        setBusy(false); return;
      }
      // nouvelle ligne créée à 0 (colis + vrac à saisir au clavier)
      const e: WmsInventoryEntry = {
        productId, productName, odooRef, barcode, lotId, lotName,
        locationId: null, locationName: locName,
        colis: 0, unitsPerColis, vrac: 0, counted: 0,
      };
      const next = [e, ...entries];
      persist(next);
      setFlashKey(`${productId}-${lotId ?? 0}-${locName || ""}`);
      onToast(`Ligne ajoutée : ${lotName || odooRef || productName}`, "success");
    } catch (e: any) { onToast("Erreur : " + e.message, "error"); }
    setBusy(false);
  }, [session, entries, activeAisle, sess.mode, persist, onToast]);

  // Scan PDA/caméra routé depuis page.tsx — seulement si une zone est active (mode emplacement)
  useEffect(() => {
    if (scanCode) {
      if (sess.mode === "location" && !activeAisle) { onToast("Choisis d'abord une zone sur le plan", "info"); onScanConsumed?.(); return; }
      addByCode(scanCode); onScanConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanCode]);

  // Compte de lignes par zone (pour le statut de couleur sur le plan)
  const countByZone = (zone: string) => entries.filter(e => e.locationName === zone).length;

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
        quantQty: theo[i]?.quantQty ?? 0,
        matchedAt: new Date().toISOString(),
      }));
      persist(next);
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
        if (e.locationId == null) {
          // SCAN LIBRE : théorique = somme de tous les emplacements → on applique le DELTA
          // (écart) sur le quant cible, pas la valeur absolue (sinon sortie erronée).
          await odoo.applyInventoryDelta(session, e.quantId, e.quantQty ?? 0, counted - (e.theoretical ?? 0), reason);
        } else {
          await odoo.applyInventoryAdjustment(session, e.quantId, counted, reason);
        }
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
        if (e.quantId) {
          if (e.locationId == null) await odoo.applyInventoryDelta(session, e.quantId, e.quantQty ?? 0, counted - (e.theoretical ?? 0), reason);
          else await odoo.applyInventoryAdjustment(session, e.quantId, counted, reason);
        }
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
      const COLS = [{ wch: 22 }, { wch: 16 }, { wch: 40 }, { wch: 18 }, { wch: 8 }, { wch: 12 }, { wch: 8 }, { wch: 12 }, { wch: 14 }, { wch: 10 }];
      const rowOf = (e: WmsInventoryEntry) => {
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
      };
      // Nettoie un nom d'onglet Excel (max 31 chars, pas de caractères interdits)
      const sheetName = (s: string) => (s || "—").replace(/[:\\\/\?\*\[\]]/g, "-").substring(0, 31) || "—";

      const wb = XLSX.utils.book_new();
      if (sess.mode === "location") {
        // Un onglet par zone (ordre : zones du plan, puis le reste)
        const zones = Array.from(new Set(entries.map(e => e.locationName || "(sans zone)")));
        zones.sort((a, b) => a.localeCompare(b));
        const used = new Set<string>();
        for (const z of zones) {
          const rows = entries.filter(e => (e.locationName || "(sans zone)") === z).map(rowOf);
          if (!rows.length) continue;
          const ws = XLSX.utils.json_to_sheet(rows);
          ws["!cols"] = COLS;
          // garantit l'unicité du nom d'onglet
          let nm = sheetName(z); let n = 2;
          while (used.has(nm)) { nm = sheetName(z).substring(0, 28) + "_" + n; n++; }
          used.add(nm);
          XLSX.utils.book_append_sheet(wb, ws, nm);
        }
      } else {
        const ws = XLSX.utils.json_to_sheet(entries.map(rowOf));
        ws["!cols"] = COLS;
        XLSX.utils.book_append_sheet(wb, ws, sheetName(sess.name));
      }
      if (!wb.SheetNames.length) { onToast("Rien à exporter", "info"); return; }
      const safeFile = sess.name.replace(/[^a-zA-Z0-9À-ÿ\s\-_]/g, "_");
      XLSX.writeFile(wb, `${safeFile}.xlsx`);
      onToast("Excel exporté ✓", "success");
    } catch (e: any) { onToast("Erreur export : " + e.message, "error"); }
  };

  const matchedCount = entries.filter(e => e.matchedAt).length;
  const ecartCount = entries.filter(e => e.matchedAt && ecart(e) !== 0).length;
  const totalCounted = entries.reduce((n, e) => n + calcCounted(e), 0);

  return (
    <div style={{ padding: "14px 12px 110px", maxWidth: 980, margin: "0 auto", fontFamily: "'DM Sans', sans-serif" }}>
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

      {/* Mode emplacement, aucune zone choisie → PLAN CLIQUABLE plein écran */}
      {sess.mode === "location" && !activeAisle && (
        <WarehousePlan countByZone={countByZone} onPick={z => setActiveAisle(z)} />
      )}

      {/* Mode emplacement, zone active → bandeau zone + bouton retour plan */}
      {sess.mode === "location" && activeAisle && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, background: C.blueSoft, border: `1.5px solid ${C.blue}`, borderRadius: 12, padding: "10px 14px", marginBottom: 12 }}>
          <button onClick={() => setActiveAisle("")} style={{ background: C.white, border: `1px solid ${C.blue}`, color: C.blue, borderRadius: 8, padding: "6px 10px", fontWeight: 700, fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", gap: 5 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
            Plan
          </button>
          <div style={{ fontSize: 15, fontWeight: 800, color: C.blue }}>Zone {activeAisle}</div>
          <div style={{ fontSize: 12, color: C.textSec, marginLeft: "auto" }}>{countByZone(activeAisle)} ligne{countByZone(activeAisle) > 1 ? "s" : ""}</div>
        </div>
      )}

      {/* Scan manuel — caché tant qu'aucune zone n'est choisie en mode emplacement */}
      {!(sess.mode === "location" && !activeAisle) && (
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
      )}

      {/* Boutons matching / corrections — masqués sur l'écran plan */}
      {!(sess.mode === "location" && !activeAisle) && entries.length > 0 && (
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
      {!(sess.mode === "location" && !activeAisle) && matchedCount > 0 && (
        <div style={{ display: "flex", gap: 8, marginBottom: 12, fontSize: 12 }}>
          <span style={{ background: C.greenSoft, color: "#16a34a", borderRadius: 8, padding: "5px 10px", fontWeight: 700 }}>✓ {matchedCount - ecartCount} OK</span>
          <span style={{ background: C.redSoft, color: C.red, borderRadius: 8, padding: "5px 10px", fontWeight: 700 }}>⚠ {ecartCount} écart{ecartCount > 1 ? "s" : ""}</span>
          {!isAdmin && ecartCount > 0 && <span style={{ color: C.textMuted, alignSelf: "center" }}>(corrections réservées aux admins)</span>}
        </div>
      )}

      {/* Lignes — filtrées sur la zone active en mode emplacement (index réel conservé) */}
      {!(sess.mode === "location" && !activeAisle) && (
        (() => {
          const visible = entries
            .map((e, i) => ({ e, i }))
            .filter(({ e }) => sess.mode !== "location" || e.locationName === activeAisle);
          if (visible.length === 0) {
            return (
              <div style={{ textAlign: "center", color: C.textMuted, padding: 40, fontSize: 14 }}>
                {sess.mode === "location" ? `Scanne un lot pour l'ajouter à la zone ${activeAisle}` : "Scanne un lot ou une référence pour démarrer"}
              </div>
            );
          }
          return visible.map(({ e, i }) => {
        const counted = calcCounted(e);
        const hasMatch = !!e.matchedAt;
        const d = hasMatch ? counted - (e.theoretical ?? 0) : 0;
        const lineKey = `${e.productId}-${e.lotId ?? 0}-${e.locationName || ""}`;
        const isFlash = flashKey === lineKey;
        const bg = isFlash ? "#fef9c3" : !hasMatch ? C.white : d === 0 ? C.greenSoft : C.redSoft;
        const bd = isFlash ? "#facc15" : !hasMatch ? C.border : d === 0 ? "#bbf7d0" : "#fecaca";
        return (
          <div key={`${lineKey}-${i}`}
            style={{ background: bg, border: `1px solid ${bd}`, borderRadius: 12, padding: "12px 14px", marginBottom: 8, transition: "background .3s, border-color .3s" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  {e.locationName && (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11, fontWeight: 800, color: "#1d4ed8", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 6, padding: "1px 7px" }}>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
                      {e.locationName}
                    </span>
                  )}
                  <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{e.productName}</span>
                </div>
                <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>
                  {e.odooRef && <span>{e.odooRef}</span>}
                  {e.lotName && <span> · Lot {e.lotName}</span>}
                </div>
              </div>
              <button onClick={() => removeLine(i)} title="Retirer"
                style={{ background: "none", border: "none", cursor: "pointer", padding: 4, color: C.textMuted, flexShrink: 0 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>

            {/* Saisie colis + vrac (compact PDA) */}
            <div style={{ marginTop: 10 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 8, alignItems: "end", width: "100%" }}>
                <Field label="Colis" value={e.colis} onChange={v => updateField(i, "colis", v)} />
                <Field label="× U./colis" value={e.unitsPerColis} onChange={v => updateField(i, "unitsPerColis", v)} highlight={!e.unitsPerColis} />
                <Field label="+ Vrac" value={e.vrac} onChange={v => updateField(i, "vrac", v)} />
                <div style={{ textAlign: "right", paddingBottom: 4, minWidth: 48 }}>
                  <div style={{ fontSize: 9, color: C.textMuted, fontWeight: 700, letterSpacing: 0.3 }}>TOTAL</div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: counted > 0 ? C.text : C.textMuted }}>{counted}</div>
                </div>
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
          });
        })()
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
//  Sélecteur de zones — cartes en liste (PDA-friendly)
// ════════════════════════════════════════════════════════════════
function WarehousePlan({ countByZone, onPick }: { countByZone: (z: string) => number; onPick: (z: string) => void }) {
  const ZoneCard = ({ z }: { z: string }) => {
    const n = countByZone(z);
    const done = n > 0;
    return (
      <button onClick={() => onPick(z)}
        style={{
          display: "flex", flexDirection: "column", alignItems: "flex-start", justifyContent: "center",
          gap: 2, padding: "14px 12px", minHeight: 64, borderRadius: 12, cursor: "pointer",
          border: `1.5px solid ${done ? "#22c55e" : "#cbd5e1"}`,
          background: done ? "#dcfce7" : C.white,
          fontFamily: "inherit", textAlign: "left" as const, position: "relative" as const,
          transition: "transform .1s",
        }}>
        <span style={{ fontSize: 18, fontWeight: 800, color: done ? "#15803d" : C.text }}>{z}</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: done ? "#16a34a" : C.textMuted }}>
          {done ? `${n} ligne${n > 1 ? "s" : ""}` : "à faire"}
        </span>
        {done && <span style={{ position: "absolute", top: 10, right: 10, width: 9, height: 9, borderRadius: "50%", background: "#22c55e" }} />}
      </button>
    );
  };

  const Section = ({ title, zones, cols }: { title: string; zones: string[]; cols: number }) => (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 11, fontWeight: 800, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 10 }}>{title}</div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: 10 }}>
        {zones.map(z => <ZoneCard key={z} z={z} />)}
      </div>
    </div>
  );

  // Desktop = large écran non tactile → plan visuel SVG. Sinon (PDA/mobile) → cartes.
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    const check = () => setIsDesktop(!("ontouchstart" in window) && window.innerWidth >= 1024);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  return (
    <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 16, padding: "16px 14px", marginBottom: 14, boxShadow: "0 1px 6px rgba(15,23,42,0.06)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4, flexWrap: "wrap", gap: 6 }}>
        <div style={{ fontSize: 14, fontWeight: 800, color: C.text }}>Choisis une zone à compter</div>
      </div>
      <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 14 }}>Touche une carte pour démarrer le comptage</div>

      {isDesktop ? (
        <PlanSvg countByZone={countByZone} onPick={onPick} />
      ) : (
        <>
          <Section title="Racks de stockage" zones={["A", ...ZONE_B]} cols={3} />
          <Section title="Allées picking" zones={ZONE_R} cols={3} />
        </>
      )}
    </div>
  );
}

// Plan visuel SVG (desktop uniquement)
function PlanSvg({ countByZone, onPick }: { countByZone: (z: string) => number; onPick: (z: string) => void }) {
  const done = (z: string) => countByZone(z) > 0;
  const fill = (z: string) => (done(z) ? "#dcfce7" : "#f1f5f9");
  const stroke = (z: string) => (done(z) ? "#22c55e" : "#cbd5e1");
  const txt = (z: string) => (done(z) ? "#15803d" : "#334155");
  const Zone = ({ x, y, w, h, z }: { x: number; y: number; w: number; h: number; z: string }) => {
    const n = countByZone(z);
    return (
      <g style={{ cursor: "pointer" }} onClick={() => onPick(z)}>
        <rect x={x} y={y} width={w} height={h} rx={10} fill={fill(z)} stroke={stroke(z)} strokeWidth={2} />
        {done(z) && <circle cx={x + w - 12} cy={y + 12} r={5} fill="#22c55e" />}
        <text x={x + w / 2} y={y + h / 2 - (n > 0 ? 7 : 0)} textAnchor="middle" dominantBaseline="central" fontSize={17} fontWeight={800} fill={txt(z)}>{z}</text>
        {n > 0 && <text x={x + w / 2} y={y + h / 2 + 12} textAnchor="middle" dominantBaseline="central" fontSize={10} fontWeight={700} fill="#16a34a">{n} ligne{n > 1 ? "s" : ""}</text>}
      </g>
    );
  };
  const SectionLabel = ({ x, y, w, text }: { x: number; y: number; w: number; text: string }) => (
    <text x={x + w / 2} y={y} textAnchor="middle" fontSize={12} fontWeight={800} fill="#64748b" letterSpacing={0.5}>{text}</text>
  );
  // Rack "bibliothèque" vu de dessus : un casier vertical avec des traits = étagères.
  const Rack = ({ x, y, w, h, z, shelves = 4 }: { x: number; y: number; w: number; h: number; z: string; shelves?: number }) => {
    const n = countByZone(z);
    const isDone = done(z);
    return (
      <g style={{ cursor: "pointer" }} onClick={() => onPick(z)}>
        <rect x={x} y={y} width={w} height={h} rx={6} fill={fill(z)} stroke={stroke(z)} strokeWidth={2.5} />
        {/* étagères (traits horizontaux) façon bibliothèque */}
        {Array.from({ length: shelves - 1 }).map((_, i) => (
          <line key={i} x1={x + 4} y1={y + (h / shelves) * (i + 1)} x2={x + w - 4} y2={y + (h / shelves) * (i + 1)}
            stroke={isDone ? "#86efac" : "#e2e8f0"} strokeWidth={1.5} />
        ))}
        {isDone && <circle cx={x + w - 11} cy={y + 11} r={5} fill="#22c55e" />}
        {/* étiquette du rack sur un bandeau bas */}
        <rect x={x} y={y + h - 26} width={w} height={26} rx={0} fill={isDone ? "#bbf7d0" : "#e2e8f0"} />
        <text x={x + w / 2} y={y + h - 13} textAnchor="middle" dominantBaseline="central" fontSize={15} fontWeight={800} fill={txt(z)}>{z}</text>
        {n > 0 && <text x={x + w / 2} y={y + 16} textAnchor="middle" fontSize={9.5} fontWeight={700} fill="#16a34a">{n} l.</text>}
      </g>
    );
  };

  const W = 1240, H = 540;
  const PAD = 26;

  // ── ZONE B (haut) : paires de racks B-C / D-E / F-G / H-I, sous un bandeau "Rack" ──
  const pairs = [["B", "C"], ["D", "E"], ["F", "G"], ["H", "I"]];
  const zoneAW = 130;                          // largeur colonne "Zone A" à gauche
  const backX0 = PAD + zoneAW + 20;            // début des paires (après la zone A)
  const backW = W - PAD - backX0;
  const pairGap = 26;
  const pairW = (backW - pairGap * (pairs.length - 1)) / pairs.length; // largeur d'une paire
  const inGap = 8;
  const rackW = (pairW - inGap) / 2;           // largeur d'un rack dans la paire
  const backY = 60, backH = 150;

  // ── ZONE C (bas) : R1→R7 en allées ──
  const rGap = 12;
  const rW = (W - 2 * PAD - rGap * (ZONE_R.length - 1)) / ZONE_R.length;
  const rY = 330, rH = 160;

  const Band = ({ x, y, w, text, fill = "#eef2f7", color = "#475569" }: { x: number; y: number; w: number; text: string; fill?: string; color?: string }) => (
    <g>
      <rect x={x} y={y} width={w} height={20} rx={4} fill={fill} />
      <text x={x + w / 2} y={y + 13} textAnchor="middle" fontSize={11} fontWeight={800} fill={color}>{text}</text>
    </g>
  );

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }} fontFamily="'DM Sans', sans-serif">
      {/* sol + murs */}
      <rect x={6} y={6} width={W - 12} height={H - 12} rx={14} fill="#fbfcfe" stroke="#e5e7eb" strokeWidth={1.5} />
      <text x={W / 2} y={30} textAnchor="middle" fontSize={13} fontWeight={800} fill="#334155" letterSpacing={0.5}>PLAN MAGASIN — INVENTAIRE</text>

      {/* ZONE A (rack séparé, à gauche) */}
      <Band x={PAD} y={42} w={zoneAW} text="ZONE A — RACK" fill="#e0f2fe" color="#0369a1" />
      <Rack x={PAD} y={backY + 4} w={zoneAW} h={backH + 240} z="A" shelves={9} />

      {/* ZONE B : 4 paires de racks sous bandeaux "Rack" */}
      {pairs.map((pair, pi) => {
        const px = backX0 + pi * (pairW + pairGap);
        return (
          <g key={pi}>
            <Band x={px} y={42} w={pairW} text="RACK" />
            <Rack x={px} y={backY + 4} w={rackW} h={backH} z={pair[0]} shelves={5} />
            <Rack x={px + rackW + inGap} y={backY + 4} w={rackW} h={backH} z={pair[1]} shelves={5} />
          </g>
        );
      })}
      <Band x={backX0} y={backY + backH + 14} w={backW} text="ZONE B — RACK DE STOCKAGE" fill="#e9e6f5" color="#6d28d9" />

      {/* ZONE C : rayons picking R1→R7 */}
      <Band x={PAD} y={rY - 28} w={W - 2 * PAD} text="ZONE C — RAYONS PICKING" fill="#dcfce7" color="#15803d" />
      {ZONE_R.map((z, k) => (
        <Rack key={z} x={PAD + k * (rW + rGap)} y={rY} w={rW} h={rH} z={z} shelves={6} />
      ))}
      <text x={W / 2} y={rY + rH + 22} textAnchor="middle" fontSize={11} fontWeight={700} fill="#dc2626">
        R1 à R6 : picking devant + stock derrière le picking
      </text>
    </svg>
  );
}

function Field({ label, value, onChange, highlight }: { label: string; value: number; onChange: (v: string) => void; highlight?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
      <span style={{ fontSize: 10, color: highlight ? "#ea580c" : "#6b7280", fontWeight: 700, whiteSpace: "nowrap" }}>{label}</span>
      <input type="number" inputMode="numeric" value={value || ""} placeholder="0" onChange={e => onChange(e.target.value)}
        onFocus={e => e.target.select()}
        style={{ width: "100%", boxSizing: "border-box", padding: "10px 6px", border: `1.5px solid ${highlight ? "#fdba74" : "#e5e7eb"}`, borderRadius: 9, fontSize: 17, fontWeight: 700, textAlign: "center", fontFamily: "inherit", background: highlight ? "#fff7ed" : "#fff", color: "#1a1a2e", MozAppearance: "textfield" as any }} />
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
