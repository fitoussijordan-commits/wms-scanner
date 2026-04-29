"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import * as odoo from "@/lib/odoo";

// ── Palette de couleurs (identique au reste du WMS) ──────────────────────────
const C = {
  bg: "#f8fafc", white: "#ffffff", text: "#1a1a2e", textSec: "#374151",
  textMuted: "#6b7280", border: "#e5e7eb", blue: "#3b82f6", blueSoft: "#eff6ff",
  green: "#22c55e", greenSoft: "#f0fdf4", red: "#ef4444", orange: "#f97316",
  shadow: "0 1px 4px rgba(0,0,0,0.07)",
};

// ── Types ─────────────────────────────────────────────────────────────────────
interface ScanEntry {
  barcode: string;
  qty: number;
  odooRef: string;       // default_code
  productName: string;
  productId: number | null;
  matched: boolean;
  loading: boolean;
}

interface Props {
  session: odoo.OdooSession;
  onBack: () => void;
  onToast: (msg: string, type?: "success" | "error" | "info") => void;
}

// ── Composant ─────────────────────────────────────────────────────────────────
export default function FreeScanScreen({ session, onBack, onToast }: Props) {
  const [entries, setEntries] = useState<ScanEntry[]>([]);
  const [scanInput, setScanInput] = useState("");
  const [exporting, setExporting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Garder le focus sur l'input après chaque scan
  useEffect(() => { inputRef.current?.focus(); }, [entries]);

  // ── Lookup Odoo par code-barres ───────────────────────────────────────────
  const lookupBarcode = useCallback(async (barcode: string): Promise<{ odooRef: string; productName: string; productId: number | null; matched: boolean }> => {
    try {
      const results = await odoo.searchRead(
        session, "product.product",
        [["barcode", "=", barcode]],
        ["id", "default_code", "name", "product_tmpl_id"],
        1
      );
      if (results && results.length > 0) {
        const p = results[0];
        return { odooRef: p.default_code || "", productName: p.name || "", productId: p.id ?? null, matched: true };
      }
      // Essai sur product.template si pas trouvé dans product.product
      const tplResults = await odoo.searchRead(
        session, "product.template",
        [["barcode", "=", barcode]],
        ["id", "default_code", "name"],
        1
      );
      if (tplResults && tplResults.length > 0) {
        const t = tplResults[0];
        return { odooRef: t.default_code || "", productName: t.name || "", productId: t.id ?? null, matched: true };
      }
    } catch {}
    return { odooRef: "", productName: "", productId: null, matched: false };
  }, [session]);

  // ── Handler scan ─────────────────────────────────────────────────────────
  const handleScan = useCallback(async (raw: string) => {
    const barcode = raw.trim();
    if (!barcode) return;
    setScanInput("");

    // Si code-barres déjà dans la liste → incrémenter qty immédiatement
    const existIdx = entries.findIndex(e => e.barcode === barcode);
    if (existIdx >= 0) {
      setEntries(prev => prev.map((e, i) => i === existIdx ? { ...e, qty: e.qty + 1 } : e));
      return;
    }

    // Nouveau barcode → ajouter en "loading" puis enrichir depuis Odoo
    const placeholder: ScanEntry = { barcode, qty: 1, odooRef: "", productName: barcode, productId: null, matched: false, loading: true };
    setEntries(prev => [placeholder, ...prev]);

    const match = await lookupBarcode(barcode);
    setEntries(prev => prev.map(e =>
      e.barcode === barcode && e.loading
        ? { ...e, ...match, loading: false }
        : e
    ));
  }, [entries, lookupBarcode]);

  // ── Modifier qty manuellement ─────────────────────────────────────────────
  const updateQty = (barcode: string, delta: number) => {
    setEntries(prev => prev.map(e => {
      if (e.barcode !== barcode) return e;
      const newQty = Math.max(0, e.qty + delta);
      return { ...e, qty: newQty };
    }).filter(e => e.qty > 0));
  };

  const removeEntry = (barcode: string) => {
    setEntries(prev => prev.filter(e => e.barcode !== barcode));
  };

  // ── Export Excel ──────────────────────────────────────────────────────────
  const exportExcel = async () => {
    if (entries.length === 0) { onToast("Aucun produit scanné", "error"); return; }
    setExporting(true);
    try {
      const XLSX = await import("xlsx");
      const rows = entries.map(e => ({
        "Réf interne Odoo": e.odooRef || "(non trouvé)",
        "Nom produit":      e.productName || e.barcode,
        "Code-barres":      e.barcode,
        "Quantité":         e.qty,
        "Statut":           e.matched ? "✓ Trouvé" : "⚠ Non trouvé",
      }));

      const ws = XLSX.utils.json_to_sheet(rows);

      // Largeur colonnes
      ws["!cols"] = [{ wch: 22 }, { wch: 40 }, { wch: 20 }, { wch: 12 }, { wch: 14 }];

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Scan libre");

      const date = new Date().toISOString().slice(0, 10);
      const fileName = `scan_libre_${date}.xlsx`;
      XLSX.writeFile(wb, fileName);
      onToast(`Fichier exporté : ${fileName}`, "success");
    } catch (e: any) {
      onToast("Erreur export : " + e.message, "error");
    }
    setExporting(false);
  };

  // ── Stats ─────────────────────────────────────────────────────────────────
  const totalQty    = entries.reduce((s, e) => s + e.qty, 0);
  const totalRefs   = entries.length;
  const unmatched   = entries.filter(e => !e.matched && !e.loading).length;

  // ── UI ────────────────────────────────────────────────────────────────────
  return (
    <div style={{ padding: "20px 16px", maxWidth: 480, margin: "0 auto", fontFamily: "'DM Sans', sans-serif" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <button onClick={onBack} style={{ background: C.bg, border: "none", borderRadius: 10, padding: 8, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
        </button>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>Scan libre</div>
          <div style={{ fontSize: 12, color: C.textMuted }}>Scannez des codes-barres en chaîne</div>
        </div>
      </div>

      {/* Zone de scan */}
      <div style={{ background: C.white, border: `2px solid ${C.blue}`, borderRadius: 14, padding: "14px 14px", marginBottom: 16, boxShadow: "0 0 0 4px #eff6ff" }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: C.blue, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
          📷 Zone de scan
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            ref={inputRef}
            value={scanInput}
            onChange={e => setScanInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") handleScan(scanInput); }}
            placeholder="Pointez le scanner ici…"
            autoFocus
            style={{ flex: 1, padding: "12px 14px", border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 15, fontFamily: "inherit", background: C.bg, color: C.text, outline: "none" }}
          />
          <button onClick={() => handleScan(scanInput)}
            style={{ padding: "12px 16px", background: C.blue, color: "#fff", border: "none", borderRadius: 10, fontSize: 16, fontWeight: 700, cursor: "pointer" }}>
            →
          </button>
        </div>
      </div>

      {/* Stats */}
      {entries.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 14 }}>
          {[
            { label: "Références", value: totalRefs, color: C.blue },
            { label: "Unités total", value: totalQty, color: C.text },
            { label: "Non trouvés", value: unmatched, color: unmatched > 0 ? C.orange : C.green },
          ].map(s => (
            <div key={s.label} style={{ background: C.white, borderRadius: 10, padding: "10px 8px", textAlign: "center", border: `1px solid ${C.border}`, boxShadow: C.shadow }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 10, color: C.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginTop: 2 }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Actions */}
      {entries.length > 0 && (
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <button onClick={exportExcel} disabled={exporting}
            style={{ flex: 2, padding: "12px 0", background: C.green, color: "#fff", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", opacity: exporting ? 0.7 : 1 }}>
            {exporting ? "Export en cours…" : "⬇ Exporter Excel"}
          </button>
          <button onClick={() => { if (confirm("Effacer tous les scans ?")) setEntries([]); }}
            style={{ flex: 1, padding: "12px 0", background: C.bg, color: C.red, border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
            🗑 Reset
          </button>
        </div>
      )}

      {/* Liste des scans */}
      {entries.length === 0 ? (
        <div style={{ textAlign: "center", padding: "48px 24px", color: C.textMuted }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>📦</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: C.textSec, marginBottom: 6 }}>Prêt à scanner</div>
          <div style={{ fontSize: 13 }}>Chaque scan ajoute 1 unité.<br/>Rescanner le même code-barres incrémente la quantité.</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {entries.map((entry) => (
            <div key={entry.barcode} style={{
              background: C.white, borderRadius: 12, padding: "12px 14px",
              border: `1.5px solid ${entry.loading ? C.border : entry.matched ? C.green : C.orange}`,
              boxShadow: C.shadow, display: "flex", alignItems: "center", gap: 10,
            }}>
              {/* Infos produit */}
              <div style={{ flex: 1, minWidth: 0 }}>
                {entry.loading ? (
                  <div style={{ fontSize: 13, color: C.textMuted }}>🔍 Recherche Odoo…</div>
                ) : (
                  <>
                    <div style={{ fontSize: 13, fontWeight: 700, color: entry.matched ? C.text : C.orange, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {entry.matched ? entry.productName : <span>{entry.barcode} <span style={{ fontSize: 10, fontWeight: 400 }}>(non trouvé)</span></span>}
                    </div>
                    <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
                      {entry.matched && entry.odooRef && <span>Réf: <strong>{entry.odooRef}</strong> · </span>}
                      <span style={{ fontFamily: "monospace" }}>{entry.barcode}</span>
                    </div>
                  </>
                )}
              </div>

              {/* Contrôle quantité */}
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                <button onClick={() => updateQty(entry.barcode, -1)}
                  style={{ width: 28, height: 28, borderRadius: 8, border: `1.5px solid ${C.border}`, background: C.bg, color: C.text, fontSize: 16, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>−</button>
                <div style={{ fontSize: 17, fontWeight: 800, color: C.text, minWidth: 28, textAlign: "center" }}>{entry.qty}</div>
                <button onClick={() => updateQty(entry.barcode, +1)}
                  style={{ width: 28, height: 28, borderRadius: 8, border: `1.5px solid ${C.border}`, background: C.bg, color: C.text, fontSize: 16, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
              </div>

              {/* Supprimer */}
              <button onClick={() => removeEntry(entry.barcode)}
                style={{ background: "none", border: "none", cursor: "pointer", padding: 4, color: C.textMuted, display: "flex", alignItems: "center" }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
