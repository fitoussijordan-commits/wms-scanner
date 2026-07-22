"use client";
// components/ManufacturingScreen.tsx
// ────────────────────────────────────────────────────────────────────────────
// Fabrication simplifiée — alternative légère à l'écran MRP d'Odoo.
// On choisit un produit à fabriquer, une quantité de packs, et les composants
// consommés PAR PACK. Le WMS multiplie par la quantité et crée l'ordre de
// fabrication en état "Confirmé" (composants réservés, rien de consommé).
// La finalisation (marquer comme fait) reste à faire dans Odoo.
// ────────────────────────────────────────────────────────────────────────────
import { useState, useEffect, useCallback, useRef } from "react";
import * as odoo from "@/lib/odoo";

const C = {
  bg: "#f8f9fb", white: "#fff", text: "#111827", textSec: "#374151",
  textMuted: "#6b7280", border: "#e5e7eb", blue: "#2563eb", blueSoft: "#eff6ff",
  green: "#16a34a", red: "#dc2626",
};

const S = {
  body: { flex: 1, padding: 16, display: "flex", flexDirection: "column" as const, gap: 12, maxWidth: 620, width: "100%", margin: "0 auto" },
  card: { background: C.white, borderRadius: 12, padding: "14px 16px", border: `1px solid ${C.border}` },
  label: { fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", color: C.textMuted, textTransform: "uppercase" as const, marginBottom: 4, display: "block" },
  input: { width: "100%", border: `1px solid #d1d5db`, borderRadius: 8, padding: "9px 10px", fontSize: 14, color: C.text, fontFamily: "inherit", outline: "none", boxSizing: "border-box" as const },
  btn: { width: "100%", padding: 14, borderRadius: 10, border: "none", cursor: "pointer", fontSize: 15, fontWeight: 700, fontFamily: "inherit" },
};

// Libellés FR des états Odoo d'un ordre de fabrication.
const STATE_LABELS: Record<string, string> = {
  draft: "Brouillon", confirmed: "Confirmé", progress: "En cours",
  to_close: "À clôturer", done: "Terminé", cancel: "Annulé",
};

interface Line {
  key: string;
  productId: number | null;
  label: string;
  qtyPerUnit: string;
  query: string;
  sugg: { id: number; name: string; ref: string }[];
  open: boolean;
}

const newLine = (): Line => ({
  key: Math.random().toString(36).slice(2),
  productId: null, label: "", qtyPerUnit: "1", query: "", sugg: [], open: false,
});

export default function ManufacturingScreen({ session, onBack, onToast }: {
  session: odoo.OdooSession;
  onBack: () => void;
  onToast: (msg: string, type?: "success" | "error" | "info") => void;
}) {
  // Produit à fabriquer
  const [prodQuery, setProdQuery] = useState("");
  const [prodSugg, setProdSugg] = useState<{ id: number; name: string; ref: string }[]>([]);
  const [prodOpen, setProdOpen] = useState(false);
  const [product, setProduct] = useState<{ id: number; name: string; ref: string } | null>(null);
  const [qty, setQty] = useState("1");

  const [lines, setLines] = useState<Line[]>([newLine()]);
  const [creating, setCreating] = useState(false);
  const [recent, setRecent] = useState<{ id: number; name: string; product: string; qty: number; state: string; date: string }[]>([]);

  const loadRecent = useCallback(() => {
    odoo.getRecentManufacturingOrders(session, 10).then(setRecent).catch(() => setRecent([]));
  }, [session]);
  useEffect(() => { loadRecent(); }, [loadRecent]);

  // ── Autocomplétion produit fini ──
  const prodTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const q = prodQuery.trim();
    if (product || q.length < 2) { setProdSugg([]); return; }
    if (prodTimer.current) clearTimeout(prodTimer.current);
    prodTimer.current = setTimeout(async () => {
      try {
        const r = await odoo.suggestProducts(session, q);
        setProdSugg(r); setProdOpen(r.length > 0);
      } catch { setProdSugg([]); }
    }, 300);
    return () => { if (prodTimer.current) clearTimeout(prodTimer.current); };
  }, [prodQuery, product, session]);

  // ── Autocomplétion composants (une recherche par ligne, debouncée) ──
  const lineTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const searchLine = (key: string, q: string) => {
    setLines(prev => prev.map(l => l.key === key ? { ...l, query: q, productId: null, label: "" } : l));
    if (lineTimers.current[key]) clearTimeout(lineTimers.current[key]);
    if (q.trim().length < 2) {
      setLines(prev => prev.map(l => l.key === key ? { ...l, sugg: [], open: false } : l));
      return;
    }
    lineTimers.current[key] = setTimeout(async () => {
      try {
        const r = await odoo.suggestProducts(session, q.trim());
        setLines(prev => prev.map(l => l.key === key ? { ...l, sugg: r, open: r.length > 0 } : l));
      } catch {
        setLines(prev => prev.map(l => l.key === key ? { ...l, sugg: [], open: false } : l));
      }
    }, 300);
  };

  const pickLine = (key: string, p: { id: number; name: string; ref: string }) => {
    setLines(prev => prev.map(l => l.key === key
      ? { ...l, productId: p.id, label: `${p.ref ? p.ref + " — " : ""}${p.name}`, query: `${p.ref ? p.ref + " — " : ""}${p.name}`, sugg: [], open: false }
      : l));
  };

  const setLineQty = (key: string, v: string) =>
    setLines(prev => prev.map(l => l.key === key ? { ...l, qtyPerUnit: v } : l));

  const num = (s: string): number => {
    const n = parseFloat((s || "").replace(",", "."));
    return isNaN(n) ? 0 : n;
  };

  const qtyNum = num(qty);
  const validLines = lines.filter(l => l.productId && num(l.qtyPerUnit) > 0);
  const canCreate = !!product && qtyNum > 0 && validLines.length > 0 && !creating;

  const reset = () => {
    setProduct(null); setProdQuery(""); setQty("1"); setLines([newLine()]);
  };

  const create = async () => {
    if (!canCreate || !product) return;
    setCreating(true);
    try {
      const res = await odoo.createManufacturingOrder(
        session, product.id, qtyNum,
        validLines.map(l => ({ productId: l.productId as number, qtyPerUnit: num(l.qtyPerUnit) })),
      );
      if (res.warning) onToast(`⚠️ ${res.name} — ${res.warning}`, "info");
      else onToast(`✅ ${res.name} créé et confirmé`, "success");
      reset();
      loadRecent();
    } catch (e: any) {
      onToast(`Erreur : ${odoo.safeErrMsg(e)}`, "error");
    }
    setCreating(false);
  };

  return (
    <div style={{ minHeight: "100dvh", background: C.bg, display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", background: C.white, borderBottom: `1px solid ${C.border}` }}>
        <button onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer", padding: 6, display: "flex", color: C.textMuted }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg>
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>Fabrication</div>
          <div style={{ fontSize: 11.5, color: C.textMuted }}>Crée un ordre confirmé — la finalisation se fait dans Odoo</div>
        </div>
      </div>

      <div style={S.body}>
        {/* Produit à fabriquer */}
        <div style={S.card}>
          <label style={S.label}>Produit à fabriquer</label>
          {product ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, background: C.blueSoft, border: "1px solid #bfdbfe", borderRadius: 8, padding: "10px 12px" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{product.name}</div>
                {product.ref && <div style={{ fontSize: 12, color: C.blue, fontWeight: 600 }}>{product.ref}</div>}
              </div>
              <button onClick={() => { setProduct(null); setProdQuery(""); }}
                style={{ background: "none", border: "none", color: C.textMuted, fontSize: 18, cursor: "pointer", padding: 4 }}>×</button>
            </div>
          ) : (
            <div style={{ position: "relative" }}>
              <input
                style={S.input}
                value={prodQuery}
                onChange={e => setProdQuery(e.target.value)}
                placeholder="Référence, code-barres ou nom…"
              />
              {prodOpen && prodSugg.length > 0 && (
                <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 20, background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, marginTop: 4, maxHeight: 240, overflowY: "auto", boxShadow: "0 4px 14px rgba(0,0,0,.1)" }}>
                  {prodSugg.map(p => (
                    <button key={p.id}
                      onClick={() => { setProduct(p); setProdOpen(false); setProdSugg([]); }}
                      style={{ display: "block", width: "100%", textAlign: "left", padding: "9px 12px", background: "none", border: "none", borderBottom: `1px solid ${C.border}`, cursor: "pointer", fontFamily: "inherit" }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{p.name}</div>
                      {p.ref && <div style={{ fontSize: 11.5, color: C.textMuted }}>{p.ref}</div>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div style={{ marginTop: 12 }}>
            <label style={S.label}>Quantité à fabriquer (packs)</label>
            <input style={S.input} value={qty} onChange={e => setQty(e.target.value)} inputMode="decimal" />
          </div>
        </div>

        {/* Composants */}
        <div style={S.card}>
          <label style={S.label}>Composants — quantité PAR pack</label>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {lines.map(l => (
              <div key={l.key} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
                  <input
                    style={S.input}
                    value={l.query}
                    onChange={e => searchLine(l.key, e.target.value)}
                    placeholder="Composant…"
                  />
                  {l.open && l.sugg.length > 0 && (
                    <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 20, background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, marginTop: 4, maxHeight: 220, overflowY: "auto", boxShadow: "0 4px 14px rgba(0,0,0,.1)" }}>
                      {l.sugg.map(p => (
                        <button key={p.id} onClick={() => pickLine(l.key, p)}
                          style={{ display: "block", width: "100%", textAlign: "left", padding: "9px 12px", background: "none", border: "none", borderBottom: `1px solid ${C.border}`, cursor: "pointer", fontFamily: "inherit" }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{p.name}</div>
                          {p.ref && <div style={{ fontSize: 11.5, color: C.textMuted }}>{p.ref}</div>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <input
                  style={{ ...S.input, width: 78, flexShrink: 0, textAlign: "center" }}
                  value={l.qtyPerUnit}
                  onChange={e => setLineQty(l.key, e.target.value)}
                  inputMode="decimal"
                />
                <button
                  onClick={() => setLines(prev => prev.length === 1 ? [newLine()] : prev.filter(x => x.key !== l.key))}
                  style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 8, color: C.textMuted, fontSize: 16, cursor: "pointer", padding: "8px 11px", flexShrink: 0 }}
                  aria-label="Retirer">×</button>
              </div>
            ))}
          </div>
          <button
            onClick={() => setLines(prev => [...prev, newLine()])}
            style={{ marginTop: 10, background: "none", border: "none", color: C.blue, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", padding: 0 }}>
            + Ajouter un composant
          </button>
        </div>

        {/* Récapitulatif des quantités totales — évite l'erreur classique
            "j'ai saisi le total au lieu du par-pack". */}
        {product && qtyNum > 0 && validLines.length > 0 && (
          <div style={{ ...S.card, background: "#fffbeb", borderColor: "#fed7aa" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#9a3412", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
              Sera consommé au total
            </div>
            {validLines.map(l => (
              <div key={l.key} style={{ fontSize: 13, color: "#7c2d12", display: "flex", justifyContent: "space-between", gap: 10 }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.label}</span>
                <strong style={{ flexShrink: 0 }}>{num(l.qtyPerUnit) * qtyNum}</strong>
              </div>
            ))}
          </div>
        )}

        <button
          onClick={create}
          disabled={!canCreate}
          style={{ ...S.btn, background: canCreate ? C.green : "#e5e7eb", color: canCreate ? "#fff" : "#9ca3af" }}>
          {creating ? "Création…" : "✓ Créer et confirmer l'ordre"}
        </button>

        {/* Derniers ordres */}
        <div style={S.card}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <div style={{ ...S.label, marginBottom: 0, flex: 1 }}>Derniers ordres</div>
            <button onClick={loadRecent}
              style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 11, fontWeight: 700, color: C.textSec, cursor: "pointer", padding: "4px 9px", fontFamily: "inherit" }}>
              ↻
            </button>
          </div>
          {recent.length === 0 ? (
            <div style={{ fontSize: 13, color: C.textMuted }}>Aucun ordre récent.</div>
          ) : recent.map(r => (
            <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderBottom: `1px solid ${C.border}` }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{r.name}</div>
                <div style={{ fontSize: 11.5, color: C.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.qty} × {r.product}
                </div>
              </div>
              <span style={{
                fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 99, flexShrink: 0,
                background: r.state === "done" ? "#dcfce7" : r.state === "cancel" ? "#fee2e2" : C.blueSoft,
                color: r.state === "done" ? "#166534" : r.state === "cancel" ? "#991b1b" : C.blue,
              }}>
                {STATE_LABELS[r.state] || r.state}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
