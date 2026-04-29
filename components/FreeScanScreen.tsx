"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import * as odoo from "@/lib/odoo";
import { sb, WmsScanEntry, WmsScanSession, loadScanSessions, createScanSession, updateScanSessionEntries, deleteScanSession } from "@/lib/supabase";

const C = {
  bg: "#f8fafc", white: "#ffffff", text: "#1a1a2e", textSec: "#374151",
  textMuted: "#6b7280", border: "#e5e7eb", blue: "#3b82f6", blueSoft: "#eff6ff",
  green: "#22c55e", greenSoft: "#f0fdf4", red: "#ef4444", orange: "#f97316",
  shadow: "0 1px 4px rgba(0,0,0,0.07)",
};

interface Props {
  session: odoo.OdooSession;
  onBack: () => void;
  onToast: (msg: string, type?: "success" | "error" | "info") => void;
}

// ── Vue liste des sessions ────────────────────────────────────────────────────
function SessionListView({ session, onBack, onToast, onOpen }: Props & { onOpen: (s: WmsScanSession) => void }) {
  const [sessions, setSessions] = useState<WmsScanSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  const today = new Date();
  const dateStr = `${String(today.getDate()).padStart(2, "0")}/${String(today.getMonth() + 1).padStart(2, "0")}`;

  const load = useCallback(async () => {
    try { setSessions(await loadScanSessions()); }
    catch (e: any) { onToast("Erreur chargement : " + e.message, "error"); }
    setLoading(false);
  }, [onToast]);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    const name = newName.trim() || `Scan ${dateStr}`;
    setCreating(true);
    try {
      const s = await createScanSession(name);
      setNewName("");
      onOpen(s);
    } catch (e: any) { onToast("Erreur création : " + e.message, "error"); }
    setCreating(false);
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Supprimer cette session ?")) return;
    try {
      await deleteScanSession(id);
      setSessions(prev => prev.filter(s => s.id !== id));
    } catch (e: any) { onToast("Erreur suppression", "error"); }
  };

  const totalEntries = (s: WmsScanSession) => s.entries.reduce((n, e) => n + e.qty, 0);

  return (
    <div style={{ padding: "20px 16px", maxWidth: 480, margin: "0 auto", fontFamily: "'DM Sans', sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <button onClick={onBack} style={{ background: C.bg, border: "none", borderRadius: 10, padding: 8, cursor: "pointer", display: "flex" }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
        </button>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>Scan libre</div>
          <div style={{ fontSize: 12, color: C.textMuted }}>Sessions de scan cross-device</div>
        </div>
      </div>

      {/* Créer nouvelle session */}
      <div style={{ background: C.white, border: `1.5px solid ${C.blue}`, borderRadius: 14, padding: 14, marginBottom: 20, boxShadow: "0 0 0 3px #eff6ff" }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.blue, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>Nouvelle session</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") handleCreate(); }}
            placeholder={`Scan ${dateStr}`}
            style={{ flex: 1, padding: "10px 12px", border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit", background: C.bg, color: C.text }}
          />
          <button onClick={handleCreate} disabled={creating}
            style={{ padding: "10px 18px", background: C.blue, color: "#fff", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
            {creating ? "…" : "+ Créer"}
          </button>
        </div>
      </div>

      {/* Liste sessions */}
      {loading ? (
        <div style={{ textAlign: "center", padding: 40, color: C.textMuted }}>Chargement…</div>
      ) : sessions.length === 0 ? (
        <div style={{ textAlign: "center", padding: "40px 24px", color: C.textMuted }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>📋</div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Aucune session</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>Créez une session pour commencer à scanner</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {sessions.map(s => (
            <div key={s.id} onClick={() => onOpen(s)}
              style={{ background: C.white, border: `1.5px solid ${C.border}`, borderRadius: 12, padding: "12px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 12, boxShadow: C.shadow }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{s.name}</div>
                <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
                  {s.date} · {s.entries.length} réf(s) · {totalEntries(s)} unités
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 700, background: C.blueSoft, color: C.blue, padding: "3px 10px", borderRadius: 8 }}>
                  {totalEntries(s)} u
                </span>
                <button onClick={e => handleDelete(s.id, e)}
                  style={{ background: "none", border: "none", cursor: "pointer", padding: 4, color: C.textMuted }}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Vue scan d'une session ────────────────────────────────────────────────────
function SessionScanView({ session, scanSession, onBack, onToast }: Props & { scanSession: WmsScanSession }) {
  const [entries, setEntries] = useState<WmsScanEntry[]>(scanSession.entries || []);
  const [bufDisplay, setBufDisplay] = useState("");   // affichage seulement
  const [lastScanned, setLastScanned] = useState("");
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Refs pour éviter les stale closures dans le listener window
  const bufRef       = useRef("");
  const entriesRef   = useRef<WmsScanEntry[]>(entries);
  const flushTimer   = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { entriesRef.current = entries; }, [entries]);

  // Sauvegarder dans Supabase (debounced)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveToSupabase = useCallback((newEntries: WmsScanEntry[]) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaving(true);
      try { await updateScanSessionEntries(scanSession.id, newEntries); }
      catch { /* silencieux */ }
      setSaving(false);
    }, 800);
  }, [scanSession.id]);

  // Lookup Odoo barcode
  const lookupBarcode = useCallback(async (barcode: string): Promise<Omit<WmsScanEntry, "barcode" | "qty">> => {
    try {
      const r = await odoo.searchRead(session, "product.product", [["barcode", "=", barcode]], ["default_code", "name"], 1);
      if (r?.length) return { odooRef: r[0].default_code || "", productName: r[0].name || "", matched: true };
      const t = await odoo.searchRead(session, "product.template", [["barcode", "=", barcode]], ["default_code", "name"], 1);
      if (t?.length) return { odooRef: t[0].default_code || "", productName: t[0].name || "", matched: true };
    } catch {}
    return { odooRef: "", productName: "", matched: false };
  }, [session]);

  // Traiter un scan (utilise entriesRef pour éviter les stale closures)
  const handleScan = useCallback(async (barcode: string) => {
    const bc = barcode.trim();
    if (!bc || bc.length < 3) return;
    setLastScanned(bc);
    setBufDisplay("");

    const current = entriesRef.current;
    const idx = current.findIndex(e => e.barcode === bc);

    if (idx >= 0) {
      // Déjà dans la liste → incrémenter
      const updated = current.map((e, i) => i === idx ? { ...e, qty: e.qty + 1 } : e);
      entriesRef.current = updated;
      setEntries(updated);
      saveToSupabase(updated);
      return;
    }

    // Nouveau barcode → placeholder immédiat
    const placeholder: WmsScanEntry = { barcode: bc, qty: 1, odooRef: "…", productName: "Recherche…", matched: false };
    const withPlaceholder = [placeholder, ...current];
    entriesRef.current = withPlaceholder;
    setEntries(withPlaceholder);

    // Lookup Odoo async
    const match = await lookupBarcode(bc);
    setEntries(prev => {
      const updated = prev.map(e => e.barcode === bc && e.odooRef === "…" ? { ...e, ...match } : e);
      entriesRef.current = updated;
      saveToSupabase(updated);
      return updated;
    });
  }, [lookupBarcode, saveToSupabase]);

  // ── Listener window keydown — fonctionne sur Zebra DataWedge + PC ──────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ignorer si l'utilisateur tape dans un vrai champ texte (ex: nom de session)
      const tag = (document.activeElement?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea") return;

      if (e.key === "Enter" || e.key === "Tab") {
        const bc = bufRef.current.trim();
        bufRef.current = "";
        setBufDisplay("");
        if (flushTimer.current) { clearTimeout(flushTimer.current); flushTimer.current = null; }
        if (bc.length >= 3) handleScan(bc);
        return;
      }

      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        bufRef.current += e.key;
        setBufDisplay(bufRef.current);
        // Auto-flush 200ms après le dernier caractère (scanners sans Enter)
        if (flushTimer.current) clearTimeout(flushTimer.current);
        flushTimer.current = setTimeout(() => {
          const bc = bufRef.current.trim();
          bufRef.current = "";
          setBufDisplay("");
          if (bc.length >= 3) handleScan(bc);
        }, 200);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleScan]);

  const updateQty = (barcode: string, delta: number) => {
    setEntries(prev => {
      const updated = prev.map(e => e.barcode === barcode ? { ...e, qty: Math.max(0, e.qty + delta) } : e).filter(e => e.qty > 0);
      saveToSupabase(updated);
      return updated;
    });
  };

  const removeEntry = (barcode: string) => {
    setEntries(prev => {
      const updated = prev.filter(e => e.barcode !== barcode);
      saveToSupabase(updated);
      return updated;
    });
  };

  const exportExcel = async () => {
    if (!entries.length) { onToast("Aucun produit scanné", "error"); return; }
    setExporting(true);
    try {
      const XLSX = await import("xlsx");
      const rows = entries.map(e => ({
        "Réf interne Odoo": e.odooRef && e.odooRef !== "…" ? e.odooRef : "(non trouvé)",
        "Nom produit":      e.productName && e.productName !== "Recherche…" ? e.productName : e.barcode,
        "Code-barres":      e.barcode,
        "Quantité":         e.qty,
      }));
      const ws = XLSX.utils.json_to_sheet(rows);
      ws["!cols"] = [{ wch: 22 }, { wch: 42 }, { wch: 20 }, { wch: 12 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, scanSession.name);
      XLSX.writeFile(wb, `${scanSession.name.replace(/[^a-zA-Z0-9]/g, "_")}.xlsx`);
      onToast("Fichier exporté ✓", "success");
    } catch (e: any) { onToast("Erreur export : " + e.message, "error"); }
    setExporting(false);
  };

  const totalQty  = entries.reduce((s, e) => s + e.qty, 0);
  const unmatched = entries.filter(e => !e.matched && e.odooRef !== "…").length;

  return (
    <div style={{ padding: "20px 16px", maxWidth: 480, margin: "0 auto", fontFamily: "'DM Sans', sans-serif" }}>

      {/* Pas d'input : listener window.keydown capte tout le scanner directement */}

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <button onClick={onBack} style={{ background: C.bg, border: "none", borderRadius: 10, padding: 8, cursor: "pointer", display: "flex" }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: C.text }}>{scanSession.name}</div>
          <div style={{ fontSize: 11, color: C.textMuted }}>{scanSession.date} · {saving ? "Sauvegarde…" : "Synchronisé ✓"}</div>
        </div>
        <button onClick={exportExcel} disabled={exporting || entries.length === 0}
          style={{ padding: "8px 14px", background: C.green, color: "#fff", border: "none", borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", opacity: entries.length === 0 ? 0.4 : 1 }}>
          {exporting ? "…" : "⬇ Excel"}
        </button>
      </div>

      {/* Indicateur de scan actif */}
      <div style={{ background: C.white, border: `2px solid ${C.blue}`, borderRadius: 14, padding: "12px 16px", marginBottom: 14, display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 10, height: 10, borderRadius: "50%", background: C.blue, animation: "pulse 1.5s infinite", flexShrink: 0 }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.blue }}>Scanner actif — pointez et scannez</div>
          {lastScanned && <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>Dernier scan : <strong>{lastScanned}</strong></div>}
        </div>
        {bufDisplay && <div style={{ fontSize: 11, color: C.textMuted, fontFamily: "monospace" }}>{bufDisplay}…</div>}
      </div>

      {/* Stats */}
      {entries.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 14 }}>
          {[
            { label: "Références", value: entries.length, color: C.blue },
            { label: "Unités", value: totalQty, color: C.text },
            { label: "Non trouvés", value: unmatched, color: unmatched > 0 ? C.orange : C.green },
          ].map(s => (
            <div key={s.label} style={{ background: C.white, borderRadius: 10, padding: "10px 8px", textAlign: "center", border: `1px solid ${C.border}`, boxShadow: C.shadow }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 10, color: C.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginTop: 2 }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Liste */}
      {entries.length === 0 ? (
        <div style={{ textAlign: "center", padding: "40px 24px", color: C.textMuted }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>📦</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: C.textSec, marginBottom: 6 }}>Prêt à scanner</div>
          <div style={{ fontSize: 13 }}>Scannez un code-barres pour commencer.<br/>Chaque scan = 1 unité. Répéter = cumul.</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {entries.map(entry => (
            <div key={entry.barcode} style={{
              background: C.white, borderRadius: 12, padding: "11px 13px",
              border: `1.5px solid ${entry.odooRef === "…" ? C.border : entry.matched ? "#bbf7d0" : "#fed7aa"}`,
              boxShadow: C.shadow, display: "flex", alignItems: "center", gap: 10,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                {entry.odooRef === "…" ? (
                  <div style={{ fontSize: 12, color: C.textMuted }}>🔍 Recherche…</div>
                ) : (
                  <>
                    <div style={{ fontSize: 13, fontWeight: 700, color: entry.matched ? C.text : C.orange, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {entry.matched ? entry.productName : <span>{entry.barcode} <span style={{ fontSize: 10, fontWeight: 400 }}>(non trouvé)</span></span>}
                    </div>
                    <div style={{ fontSize: 11, color: C.textMuted, marginTop: 1 }}>
                      {entry.matched && entry.odooRef && <><strong>{entry.odooRef}</strong> · </>}
                      <span style={{ fontFamily: "monospace" }}>{entry.barcode}</span>
                    </div>
                  </>
                )}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
                <button onClick={() => updateQty(entry.barcode, -1)}
                  style={{ width: 26, height: 26, borderRadius: 7, border: `1.5px solid ${C.border}`, background: C.bg, fontSize: 15, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>−</button>
                <div style={{ fontSize: 16, fontWeight: 800, color: C.text, minWidth: 26, textAlign: "center" }}>{entry.qty}</div>
                <button onClick={() => updateQty(entry.barcode, +1)}
                  style={{ width: 26, height: 26, borderRadius: 7, border: `1.5px solid ${C.border}`, background: C.bg, fontSize: 15, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
              </div>
              <button onClick={() => removeEntry(entry.barcode)}
                style={{ background: "none", border: "none", cursor: "pointer", padding: 4, color: C.textMuted }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
              </button>
            </div>
          ))}
        </div>
      )}

      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }`}</style>
    </div>
  );
}

// ── Composant principal ───────────────────────────────────────────────────────
export default function FreeScanScreen(props: Props) {
  const [activeSession, setActiveSession] = useState<WmsScanSession | null>(null);

  if (activeSession) {
    return <SessionScanView {...props} scanSession={activeSession} onBack={() => setActiveSession(null)} />;
  }
  return <SessionListView {...props} onOpen={setActiveSession} />;
}
