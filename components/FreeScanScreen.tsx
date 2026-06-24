"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import * as odoo from "@/lib/odoo";
import { sb, WmsScanEntry, WmsScanSession, loadScanSessions, createScanSession, updateScanSessionEntries, deleteScanSession,
  WmsPrepLine, WmsPrepList, loadPrepLists, createPrepList, updatePrepEntries, deletePrepList } from "@/lib/supabase";

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

// Barre d'onglets Scan libre / Prépa libre (style cohérent avec les autres outils).
function ScanTabBar({ active, onScan, onPrep }: { active: "scan" | "prep"; onScan: () => void; onPrep: () => void }) {
  return (
    <div style={{ display: "flex", gap: 4, padding: 4, background: C.bg, borderRadius: 12, marginBottom: 16 }}>
      {([["scan", "Sessions de scan", onScan], ["prep", "Prépa libre", onPrep]] as const).map(([k, label, fn]) => (
        <button key={k} onClick={fn} style={{
          flex: 1, padding: "9px 0", borderRadius: 9, border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 700,
          background: active === k ? C.white : "transparent", color: active === k ? C.text : C.textMuted,
          boxShadow: active === k ? "0 1px 4px rgba(0,0,0,0.08)" : "none", transition: "all 0.15s",
        }}>{label}</button>
      ))}
    </div>
  );
}

// ── Vue liste des sessions ────────────────────────────────────────────────────
function SessionListView({ session, onBack, onToast, onOpen, onPrepMode }: Props & { onOpen: (s: WmsScanSession) => void; onPrepMode: () => void }) {
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
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
        <button onClick={onBack} style={{ background: C.bg, border: "none", borderRadius: 10, padding: 8, cursor: "pointer", display: "flex" }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>Scan libre</div>
          <div style={{ fontSize: 12, color: C.textMuted }}>Sessions de scan cross-device</div>
        </div>
      </div>
      <ScanTabBar active="scan" onScan={() => {}} onPrep={onPrepMode} />

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
      const safeSheet = scanSession.name.replace(/[:\\\/\?\*\[\]]/g, "-").substring(0, 31);
      const safeFile  = scanSession.name.replace(/[^a-zA-Z0-9À-ÿ\s\-_]/g, "_");
      XLSX.utils.book_append_sheet(wb, ws, safeSheet);
      XLSX.writeFile(wb, `${safeFile}.xlsx`);
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
// ════════════════════════════════════════════════════════════════
//  PRÉPA LIBRE — colle un texte (réf + qté), génère une liste de prépa
//  triée par emplacement (pour re-préparer / vérifier le poids).
// ════════════════════════════════════════════════════════════════
interface PrepLine {
  ref: string;
  qty: number;
  found: boolean;
  productId: number;
  name: string;
  location: string;   // emplacement (court)
  stock: number;
}

function shortLoc(full: string): string { return (full || "").split("/").pop() || full; }

// Parse le texte collé. Structure Odoo : "[réf] Nom(peut contenir des chiffres)\tqté\tqté\tUnités".
// La QUANTITÉ est dans une colonne SÉPARÉE (tabulation), PAS dans le nom du produit.
// → on découpe sur tabulations / espaces multiples et on prend le nombre de la colonne quantité.
function parsePrepText(text: string): { ref: string; qty: number }[] {
  const out: { ref: string; qty: number }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const refM = line.match(/\[([A-Za-z0-9\-_.]+)\]/);
    if (!refM) continue;
    const ref = refM[1];

    // On coupe la ligne en colonnes sur les tabulations OU groupes de 2+ espaces.
    const after = line.slice(refM.index! + refM[0].length);
    const cols = after.split(/\t+|\s{2,}/).map(c => c.trim()).filter(Boolean);
    // La 1re colonne = nom (à ignorer, contient "- 145 ml" etc.). La quantité = 1re colonne
    // PUREMENT numérique parmi les suivantes (ex: "2,00"). On exclut donc le nom.
    let qty = 1;
    for (let i = 1; i < cols.length; i++) {
      const m = cols[i].match(/^(\d+(?:[.,]\d+)?)$/); // colonne entièrement numérique
      if (m) { qty = Math.round(parseFloat(m[1].replace(",", "."))); break; }
    }
    // Repli : si aucune colonne propre, on prend le DERNIER nombre avant "Unités".
    if (qty === 1 && !cols.slice(1).some(c => /^\d/.test(c))) {
      const nums = after.match(/\d+(?:[.,]\d+)?/g) || [];
      // on enlève les nombres collés à "ml"/"g" (taille produit dans le nom)
      const qtyNums = (after.replace(/\d+(?:[.,]\d+)?\s*(ml|g|cl|l|mg)\b/gi, " ").match(/\d+(?:[.,]\d+)?/g)) || nums;
      if (qtyNums[0]) qty = Math.round(parseFloat(qtyNums[0].replace(",", ".")));
    }
    out.push({ ref, qty: qty > 0 ? qty : 1 });
  }
  const byRef: Record<string, number> = {};
  for (const o of out) byRef[o.ref] = (byRef[o.ref] || 0) + o.qty;
  return Object.entries(byRef).map(([ref, qty]) => ({ ref, qty }));
}

// Tri par ORDRE DE PICKING : on classe sur le 1er tronçon de l'emplacement (A12, E31…),
// d'abord la lettre, puis le numéro (tri naturel). Non trouvés à la fin.
function pickingKey(loc: string): { letter: string; num: number } {
  const first = (loc || "").split("-")[0].trim();
  const m = first.match(/^([A-Za-z]*)(\d*)/);
  return { letter: (m?.[1] || "").toUpperCase(), num: m?.[2] ? parseInt(m[2], 10) : 0 };
}
function sortPicking(a: PrepLine, b: PrepLine): number {
  if (a.found !== b.found) return a.found ? -1 : 1;
  const ka = pickingKey(a.location), kb = pickingKey(b.location);
  if (ka.letter !== kb.letter) return ka.letter.localeCompare(kb.letter);
  if (ka.num !== kb.num) return ka.num - kb.num;
  return (a.location || "").localeCompare(b.location || "");
}

// ── Création d'une prépa libre (coller texte → générer → enregistrer partagé) ──
function FreePrepCreate({ session, onBack, onToast, onCreated }: Props & { onCreated: (p: WmsPrepList) => void }) {
  const [src, setSrc] = useState<"out" | "text">("out");
  const [text, setText] = useState("");
  const [outNums, setOutNums] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);

  // Création depuis des n° de OUT Odoo (WH/OUT/…).
  const generateFromOut = async () => {
    const nums = outNums.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
    if (!nums.length) { onToast("Donne au moins un n° de OUT", "error"); return; }
    setLoading(true);
    try {
      const { lines, foundPickings, missing } = await odoo.getOutPickingLines(session, nums);
      if (!lines.length) { onToast(`Aucune ligne trouvée${missing.length ? ` (introuvables : ${missing.join(", ")})` : ""}`, "error"); setLoading(false); return; }
      const sorted = [...lines].sort((a, b) => sortPicking(a as any, b as any));
      const entries: WmsPrepLine[] = sorted.map(l => ({ ref: l.ref, qty: l.qty, name: l.name, location: l.location, stock: l.stock, found: l.found, checked: false }));
      const list = await createPrepList(name.trim() || `OUT ${foundPickings.join("+")}`, entries);
      onToast(`Prépa créée depuis ${foundPickings.length} OUT${missing.length ? ` · ${missing.length} introuvable(s)` : ""} ✓`, "success");
      onCreated(list);
    } catch (e: any) { onToast("Erreur : " + (e?.message || e), "error"); }
    setLoading(false);
  };

  const generateAndSave = async () => {
    const parsed = parsePrepText(text);
    if (!parsed.length) { onToast("Aucune réf [XXXX] détectée", "error"); return; }
    setLoading(true);
    try {
      const refs = parsed.map(p => p.ref);
      const prods = await odoo.searchRead(session, "product.product", [["default_code", "in", refs]], ["id", "default_code", "name"], refs.length);
      const byCode: Record<string, { id: number; name: string }> = {};
      for (const p of prods) if (p.default_code) byCode[String(p.default_code)] = { id: p.id, name: p.name || "" };
      const ids = Object.values(byCode).map(p => p.id);
      const locMap = ids.length ? await odoo.getProductLocations(session, ids) as Record<number, any> : {};
      const lines: PrepLine[] = parsed.map(p => {
        const prod = byCode[p.ref];
        if (!prod) return { ref: p.ref, qty: p.qty, found: false, productId: 0, name: "", location: "", stock: 0 };
        const loc = locMap[prod.id];
        return { ref: p.ref, qty: p.qty, found: true, productId: prod.id, name: prod.name, location: loc ? shortLoc(loc.location_name) : "—", stock: loc ? Math.round(loc.quantity) : 0 };
      });
      lines.sort(sortPicking);
      const entries: WmsPrepLine[] = lines.map(l => ({ ref: l.ref, qty: l.qty, name: l.name, location: l.location, stock: l.stock, found: l.found, checked: false }));
      const today = `${String(new Date().getDate()).padStart(2, "0")}/${String(new Date().getMonth() + 1).padStart(2, "0")}`;
      const list = await createPrepList(name.trim() || `Prépa ${today}`, entries);
      onToast("Prépa créée (partagée) ✓", "success");
      onCreated(list);
    } catch (e: any) { onToast("Erreur : " + (e?.message || e), "error"); }
    setLoading(false);
  };

  return (
    <div style={{ padding: "20px 16px", maxWidth: 560, margin: "0 auto", fontFamily: "'DM Sans', sans-serif", paddingBottom: 90 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <button onClick={onBack} style={{ background: C.bg, border: "none", borderRadius: 10, padding: 8, cursor: "pointer", display: "flex" }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
        </button>
        <div><div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>Nouvelle prépa libre</div>
          <div style={{ fontSize: 12, color: C.textMuted }}>Depuis un OUT Odoo, ou en collant un texte → liste partagée triée picking</div></div>
      </div>

      {/* Source */}
      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        {([["out", "N° de OUT"], ["text", "Coller un texte"]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setSrc(k)} style={{ flex: 1, padding: "9px 0", borderRadius: 10, border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 700, background: src === k ? C.blue : C.white, color: src === k ? "#fff" : C.textSec, boxShadow: src === k ? "none" : `inset 0 0 0 1px ${C.border}` }}>{label}</button>
        ))}
      </div>

      <input value={name} onChange={e => setName(e.target.value)} placeholder="Nom de la prépa (optionnel)"
        style={{ width: "100%", boxSizing: "border-box", padding: "9px 12px", border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 13, fontFamily: "inherit", marginBottom: 8 }} />

      {src === "out" ? (
        <>
          <textarea value={outNums} onChange={e => setOutNums(e.target.value)} rows={3}
            placeholder={"N° de OUT (un ou plusieurs)\nWH/OUT/12345\nWH/OUT/12346"}
            style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 13, fontFamily: "monospace", background: C.white, color: C.text, resize: "vertical", marginBottom: 10 }} />
          <button onClick={generateFromOut} disabled={loading}
            style={{ width: "100%", padding: "12px 0", background: C.blue, color: "#fff", border: "none", borderRadius: 11, fontWeight: 800, fontSize: 15, cursor: "pointer", fontFamily: "inherit", opacity: loading ? 0.6 : 1 }}>
            {loading ? "Récupération Odoo…" : "Créer la prépa depuis le(s) OUT"}
          </button>
        </>
      ) : (
        <>
          <textarea value={text} onChange={e => setText(e.target.value)} rows={6}
            placeholder={"[1010361] Fluide de Jour Equilibrant - 50 ml\t1,00\t1,00\tUnités\n[1010310] Crème de Jour à la Rose - 30 ml\t2,00\t2,00\tUnités"}
            style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 13, fontFamily: "monospace", background: C.white, color: C.text, resize: "vertical", marginBottom: 10 }} />
          <button onClick={generateAndSave} disabled={loading}
            style={{ width: "100%", padding: "12px 0", background: C.blue, color: "#fff", border: "none", borderRadius: 11, fontWeight: 800, fontSize: 15, cursor: "pointer", fontFamily: "inherit", opacity: loading ? 0.6 : 1 }}>
            {loading ? "Génération…" : "Générer et partager la prépa"}
          </button>
        </>
      )}
    </div>
  );
}

// ── Ouverture d'une prépa partagée : cocher en temps réel ──
function FreePrepOpen({ onBack, onToast, prep }: Pick<Props, "onToast"> & { onBack: () => void; prep: WmsPrepList }) {
  const [entries, setEntries] = useState<WmsPrepLine[]>([...prep.entries].sort((a, b) =>
    sortPicking({ ...a, productId: 0 } as any, { ...b, productId: 0 } as any)));

  // Temps réel : si un autre poste coche, on reçoit la mise à jour.
  useEffect(() => {
    const ch = sb.channel(`prep-${prep.id}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "wms_scan_sessions", filter: `id=eq.${prep.id}` },
        (payload: any) => {
          const fresh = payload.new?.entries as WmsPrepLine[] | undefined;
          if (Array.isArray(fresh)) setEntries([...fresh].sort((a, b) => sortPicking({ ...a, productId: 0 } as any, { ...b, productId: 0 } as any)));
        })
      .subscribe();
    return () => { sb.removeChannel(ch); };
  }, [prep.id]);

  const toggle = async (ref: string) => {
    const next = entries.map(e => e.ref === ref ? { ...e, checked: !e.checked } : e);
    setEntries(next);
    try { await updatePrepEntries(prep.id, next); } catch (e: any) { onToast("Erreur sync : " + e.message, "error"); }
  };

  const doneCount = entries.filter(e => e.checked).length;

  return (
    <div style={{ padding: "20px 16px", maxWidth: 560, margin: "0 auto", fontFamily: "'DM Sans', sans-serif", paddingBottom: 90 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
        <button onClick={onBack} style={{ background: C.bg, border: "none", borderRadius: 10, padding: 8, cursor: "pointer", display: "flex" }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
        </button>
        <div style={{ flex: 1 }}><div style={{ fontSize: 17, fontWeight: 800, color: C.text }}>{prep.name}</div>
          <div style={{ fontSize: 12, color: C.textMuted }}>{doneCount}/{entries.length} préparé · temps réel · ordre picking</div></div>
      </div>

      {/* Barre de progression */}
      <div style={{ height: 8, background: C.bg, borderRadius: 99, overflow: "hidden", marginBottom: 14 }}>
        <div style={{ height: "100%", width: `${entries.length ? (doneCount / entries.length) * 100 : 0}%`, background: C.green, transition: "width .2s" }} />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {entries.map(l => {
          const ok = !!l.checked;
          return (
            <div key={l.ref} onClick={() => l.found && toggle(l.ref)}
              style={{ background: ok ? C.greenSoft : C.white, border: `1.5px solid ${ok ? C.green : !l.found ? "#fecaca" : C.border}`, borderRadius: 14, padding: "12px 14px", boxShadow: ok ? "none" : C.shadow, display: "flex", alignItems: "center", gap: 12, cursor: l.found ? "pointer" : "default" }}>
              {/* Produit + emplacement complet */}
              <div style={{ flex: 1, minWidth: 0 }}>
                {/* Emplacement COMPLET, en bandeau (peut passer à la ligne) */}
                <div style={{ display: "inline-block", padding: "3px 8px", borderRadius: 7, background: ok ? "#dcfce7" : l.found ? "#eef2ff" : "#fef2f2",
                  fontSize: 12, fontWeight: 800, fontFamily: "monospace", color: l.found ? (ok ? C.green : C.blue) : C.red, marginBottom: 5, wordBreak: "break-all" }}>
                  📍 {l.found ? l.location : "?"}
                </div>
                <div style={{ fontSize: 14, fontWeight: 700, color: ok ? C.textMuted : C.text, textDecoration: ok ? "line-through" : "none" }}>{l.found ? l.name : "Réf introuvable dans Odoo"}</div>
                <div style={{ fontSize: 11.5, fontFamily: "monospace", color: C.textMuted, marginTop: 1 }}>{l.ref}</div>
              </div>
              {/* Quantité */}
              <div style={{ minWidth: 46, height: 46, borderRadius: 12, background: ok ? C.green : "#0f172a", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 800, flexShrink: 0 }}>
                {ok ? "✓" : `×${l.qty}`}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Liste des prépas libres partagées ──
function FreePrepList({ session, onBack, onToast }: Props) {
  const [view, setView] = useState<"list" | "create">("list");
  const [open, setOpen] = useState<WmsPrepList | null>(null);
  const [lists, setLists] = useState<WmsPrepList[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => { try { setLists(await loadPrepLists()); } catch (e: any) { onToast("Erreur : " + e.message, "error"); } setLoading(false); };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  if (open) return <FreePrepOpen onBack={() => { setOpen(null); load(); }} onToast={onToast} prep={open} />;
  if (view === "create") return <FreePrepCreate session={session} onBack={() => setView("list")} onToast={onToast} onCreated={(p) => { setView("list"); setOpen(p); }} />;

  return (
    <div style={{ padding: "20px 16px", maxWidth: 560, margin: "0 auto", fontFamily: "'DM Sans', sans-serif", paddingBottom: 90 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
        <button onClick={onBack} style={{ background: C.bg, border: "none", borderRadius: 10, padding: 8, cursor: "pointer", display: "flex" }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
        </button>
        <div style={{ flex: 1 }}><div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>Scan libre</div>
          <div style={{ fontSize: 12, color: C.textMuted }}>Prépas partagées entre tous les postes</div></div>
      </div>
      <ScanTabBar active="prep" onScan={onBack} onPrep={() => {}} />
      <button onClick={() => setView("create")} style={{ width: "100%", background: C.blue, color: "#fff", border: "none", borderRadius: 11, padding: "11px 0", cursor: "pointer", fontSize: 14, fontWeight: 800, fontFamily: "inherit", marginBottom: 14 }}>+ Nouvelle prépa</button>
      {loading ? <div style={{ textAlign: "center", padding: 40, color: C.textMuted }}>Chargement…</div> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {lists.length === 0 && <div style={{ textAlign: "center", padding: 30, color: C.textMuted, fontSize: 13 }}>Aucune prépa. Crée-en une avec « + Nouvelle ».</div>}
          {lists.map(l => {
            const done = l.entries.filter(e => e.checked).length;
            return (
              <div key={l.id} onClick={() => setOpen(l)} style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, padding: "12px 14px", boxShadow: C.shadow, cursor: "pointer", display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{l.name}</div>
                  <div style={{ fontSize: 11, color: C.textMuted }}>{done}/{l.entries.length} préparé(s) · {l.date}</div>
                </div>
                <button onClick={(e) => { e.stopPropagation(); if (confirm("Supprimer cette prépa ?")) deletePrepList(l.id).then(load); }}
                  style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 13, fontWeight: 700 }}>🗑</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function FreeScanScreen(props: Props) {
  const [activeSession, setActiveSession] = useState<WmsScanSession | null>(null);
  const [mode, setMode] = useState<"sessions" | "prep">("sessions");

  if (mode === "prep") return <FreePrepList {...props} onBack={() => setMode("sessions")} />;
  if (activeSession) {
    return <SessionScanView {...props} scanSession={activeSession} onBack={() => setActiveSession(null)} />;
  }
  return <SessionListView {...props} onOpen={setActiveSession} onPrepMode={() => setMode("prep")} />;
}
