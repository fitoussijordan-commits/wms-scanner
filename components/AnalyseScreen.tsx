"use client";
import { useState, useRef } from "react";
import * as odoo from "@/lib/odoo";

const C = {
  bg: "#f8fafc", white: "#ffffff", text: "#1a1a2e", textSec: "#374151",
  textMuted: "#6b7280", border: "#e5e7eb", blue: "#3b82f6", blueSoft: "#eff6ff",
  green: "#22c55e", greenSoft: "#f0fdf4", red: "#ef4444", redSoft: "#fef2f2",
  orange: "#f97316", orangeSoft: "#fff7ed", purple: "#7c3aed", purpleSoft: "#f5f3ff",
  shadow: "0 1px 4px rgba(0,0,0,0.07)",
};

interface Props {
  session: odoo.OdooSession;
  onBack: () => void;
  onToast: (msg: string, type?: "success" | "error" | "info") => void;
}

interface OffreResult {
  ref: string;
  productId: number | null;
  productName: string;
  stockGeneral: number;      // qty on hand (internal)
  stockReserve: number;      // reserved
  stockDispo: number;        // on_hand - reserved
  vendues: number;           // confirmed + done sale lines qty
  loading: boolean;
  error: string | null;
}

async function fetchOffreData(session: odoo.OdooSession, ref: string): Promise<Omit<OffreResult, "ref" | "loading">> {
  // 1. Trouver le produit par référence interne
  let products = await odoo.searchRead(
    session, "product.product",
    [["default_code", "=ilike", ref.trim()]],
    ["id", "name", "default_code"], 1
  );
  if (!products.length) {
    // Fallback: recherche partielle
    products = await odoo.searchRead(
      session, "product.product",
      [["default_code", "ilike", ref.trim()]],
      ["id", "name", "default_code"], 1
    );
  }
  if (!products.length) {
    return { productId: null, productName: "", stockGeneral: 0, stockReserve: 0, stockDispo: 0, vendues: 0, error: "Référence introuvable" };
  }

  const product = products[0];
  const productId: number = product.id;

  // 2. Stock général (toutes les locations internes)
  const quants = await odoo.searchRead(
    session, "stock.quant",
    [["product_id", "=", productId], ["location_id.usage", "=", "internal"]],
    ["quantity", "reserved_quantity"], 500
  );
  const stockGeneral = quants.reduce((s: number, q: any) => s + (q.quantity || 0), 0);
  const stockReserve = quants.reduce((s: number, q: any) => s + (q.reserved_quantity || 0), 0);
  const stockDispo = stockGeneral - stockReserve;

  // 3. Offres vendues — lignes de commande confirmées/livrées
  // On cherche sur sale.order.line avec state sale ou done
  let vendues = 0;
  try {
    const saleLines = await odoo.searchRead(
      session, "sale.order.line",
      [
        ["product_id", "=", productId],
        ["order_id.state", "in", ["sale", "done"]],
      ],
      ["product_uom_qty", "qty_delivered"], 0
    );
    // On prend la quantité commandée sur les offres confirmées
    vendues = saleLines.reduce((s: number, l: any) => s + (l.product_uom_qty || 0), 0);
  } catch {
    // Modèle sale.order.line potentiellement absent — pas d'erreur bloquante
    vendues = 0;
  }

  return {
    productId,
    productName: product.name,
    stockGeneral,
    stockReserve,
    stockDispo,
    vendues,
    error: null,
  };
}

function StatBadge({ label, value, color, soft }: { label: string; value: number; color: string; soft: string }) {
  return (
    <div style={{ flex: 1, background: soft, border: `1px solid ${color}22`, borderRadius: 10, padding: "10px 12px", minWidth: 0 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color, textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 4, whiteSpace: "nowrap" as const, overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color, fontVariantNumeric: "tabular-nums" }}>{Math.round(value)}</div>
    </div>
  );
}

export default function AnalyseScreen({ session, onBack, onToast }: Props) {
  const [inputVal, setInputVal] = useState("");
  const [offres, setOffres] = useState<OffreResult[]>([]);
  const [globalLoading, setGlobalLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Traite une ou plusieurs refs (coller multi-lignes, virgules, points-virgules)
  const addRefs = async (raw: string) => {
    const refs = raw
      .split(/[\n\r,;]+/)
      .map(r => r.trim())
      .filter(Boolean);
    if (!refs.length) return;

    const currentRefs = offres.map(o => o.ref.toLowerCase());
    const newRefs = refs.filter(r => !currentRefs.includes(r.toLowerCase()));
    const skipped = refs.length - newRefs.length;

    if (!newRefs.length) {
      onToast(`${skipped > 1 ? "Toutes ces références sont" : "Référence"} déjà ajoutée${skipped > 1 ? "s" : ""}`, "info");
      setInputVal("");
      return;
    }

    // Ajouter tous les placeholders d'un coup
    const placeholders: OffreResult[] = newRefs.map(ref => ({
      ref, productId: null, productName: "", stockGeneral: 0, stockReserve: 0, stockDispo: 0, vendues: 0, loading: true, error: null
    }));
    setOffres(prev => [...prev, ...placeholders]);
    setInputVal("");

    // Charger toutes en parallèle
    await Promise.all(newRefs.map(async ref => {
      try {
        const data = await fetchOffreData(session, ref);
        setOffres(prev => prev.map(o => o.ref === ref ? { ...o, ...data, loading: false } : o));
      } catch (e: any) {
        setOffres(prev => prev.map(o => o.ref === ref ? { ...o, loading: false, error: e.message || "Erreur" } : o));
      }
    }));

    if (newRefs.length > 1) onToast(`${newRefs.length} références chargées`, "success");
    inputRef.current?.focus();
  };

  const addRef = (rawRef: string) => addRefs(rawRef);

  const removeRef = (ref: string) => {
    setOffres(prev => prev.filter(o => o.ref !== ref));
  };

  const refreshAll = async () => {
    setGlobalLoading(true);
    const refs = offres.map(o => o.ref);
    setOffres(prev => prev.map(o => ({ ...o, loading: true, error: null })));
    await Promise.all(refs.map(async ref => {
      try {
        const data = await fetchOffreData(session, ref);
        setOffres(prev => prev.map(o => o.ref === ref ? { ...o, ...data, loading: false } : o));
      } catch (e: any) {
        setOffres(prev => prev.map(o => o.ref === ref ? { ...o, loading: false, error: e.message || "Erreur" } : o));
      }
    }));
    setGlobalLoading(false);
    onToast("Données actualisées", "success");
  };

  // Totaux
  const totGeneral = offres.filter(o => !o.loading && !o.error).reduce((s, o) => s + o.stockGeneral, 0);
  const totDispo = offres.filter(o => !o.loading && !o.error).reduce((s, o) => s + o.stockDispo, 0);
  const totVendues = offres.filter(o => !o.loading && !o.error).reduce((s, o) => s + o.vendues, 0);
  const hasResults = offres.some(o => !o.loading && !o.error);

  return (
    <div style={{ padding: "20px 16px", maxWidth: 480, margin: "0 auto", fontFamily: "'DM Sans', sans-serif", paddingBottom: 40 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <button onClick={onBack} style={{ background: C.bg, border: "none", borderRadius: 10, padding: 8, cursor: "pointer", display: "flex" }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>Analyse offres</div>
          <div style={{ fontSize: 12, color: C.textMuted }}>Stock général vs stock dispo par ref</div>
        </div>
        {offres.length > 0 && (
          <button onClick={refreshAll} disabled={globalLoading} style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: "7px 10px", cursor: "pointer", display: "flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 600, color: C.textMuted }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ transform: globalLoading ? "rotate(360deg)" : undefined, transition: "transform 0.5s" }}>
              <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>
            </svg>
            Actualiser
          </button>
        )}
      </div>

      {/* Saisie référence */}
      <div style={{ background: C.white, border: `1.5px solid ${C.blue}`, borderRadius: 14, padding: 14, marginBottom: 20, boxShadow: `0 0 0 3px ${C.blueSoft}` }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.blue, textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 10 }}>Ajouter une référence</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            ref={inputRef}
            value={inputVal}
            onChange={e => setInputVal(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") addRef(inputVal); }}
            onPaste={e => {
              const pasted = e.clipboardData.getData("text");
              // Si le texte collé contient plusieurs refs (sauts de ligne ou virgules), on traite tout
              if (/[\n\r,;]/.test(pasted)) {
                e.preventDefault();
                addRefs(pasted);
              }
              // Sinon laisser le comportement normal (coller dans l'input)
            }}
            placeholder="Ex: OFFRE-001, REF123... (coller plusieurs refs séparées par des virgules ou sauts de ligne)"
            autoFocus
            style={{ flex: 1, padding: "10px 12px", border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit", background: C.bg, color: C.text, outline: "none" }}
          />
          <button
            onClick={() => addRef(inputVal)}
            disabled={!inputVal.trim()}
            style={{ padding: "10px 18px", background: inputVal.trim() ? C.blue : C.border, color: inputVal.trim() ? "#fff" : C.textMuted, border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: inputVal.trim() ? "pointer" : "default", fontFamily: "inherit", transition: "background 0.2s" }}>
            + Ajouter
          </button>
        </div>
        <div style={{ fontSize: 11, color: C.textMuted, marginTop: 8 }}>Appuie sur Entrée ou scanne un code-barres</div>
      </div>

      {/* Totaux */}
      {hasResults && (
        <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
          <StatBadge label="Stock général" value={totGeneral} color={C.purple} soft={C.purpleSoft} />
          <StatBadge label="Dispo" value={totDispo} color={C.green} soft={C.greenSoft} />
          <StatBadge label="Vendues" value={totVendues} color={C.orange} soft={C.orangeSoft} />
        </div>
      )}

      {/* Liste des offres */}
      {offres.length === 0 ? (
        <div style={{ textAlign: "center", padding: "40px 24px", color: C.textMuted }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>📊</div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Aucune référence</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>Ajoute une ou plusieurs références pour analyser leur stock</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column" as const, gap: 10 }}>
          {offres.map(offre => (
            <div key={offre.ref} style={{ background: C.white, border: `1px solid ${offre.error ? C.red : C.border}`, borderRadius: 14, padding: 14, boxShadow: C.shadow }}>
              {/* En-tête carte */}
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: offre.loading || offre.error ? 0 : 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 800, color: C.text, fontFamily: "monospace" }}>{offre.ref}</div>
                  {offre.productName && (
                    <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{offre.productName}</div>
                  )}
                </div>
                <button
                  onClick={() => removeRef(offre.ref)}
                  style={{ background: "none", border: "none", cursor: "pointer", color: C.textMuted, padding: 4, marginLeft: 8, flexShrink: 0 }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>

              {/* Loading */}
              {offre.loading && (
                <div style={{ fontSize: 12, color: C.textMuted, paddingTop: 6, display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ width: 10, height: 10, borderRadius: 5, border: `2px solid ${C.blue}`, borderTopColor: "transparent", animation: "spin 0.8s linear infinite" }} />
                  Chargement…
                </div>
              )}

              {/* Erreur */}
              {!offre.loading && offre.error && (
                <div style={{ fontSize: 12, color: C.red, paddingTop: 4, display: "flex", alignItems: "center", gap: 5 }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                  {offre.error}
                </div>
              )}

              {/* Stats */}
              {!offre.loading && !offre.error && (
                <>
                  <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                    <div style={{ flex: 1, background: C.purpleSoft, borderRadius: 8, padding: "8px 10px", textAlign: "center" as const }}>
                      <div style={{ fontSize: 9, fontWeight: 700, color: C.purple, textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>Général</div>
                      <div style={{ fontSize: 18, fontWeight: 800, color: C.purple }}>{Math.round(offre.stockGeneral)}</div>
                    </div>
                    <div style={{ flex: 1, background: "#f1f5f9", borderRadius: 8, padding: "8px 10px", textAlign: "center" as const }}>
                      <div style={{ fontSize: 9, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>Réservé</div>
                      <div style={{ fontSize: 18, fontWeight: 800, color: C.textSec }}>{Math.round(offre.stockReserve)}</div>
                    </div>
                    <div style={{ flex: 1, background: offre.stockDispo > 0 ? C.greenSoft : C.redSoft, borderRadius: 8, padding: "8px 10px", textAlign: "center" as const }}>
                      <div style={{ fontSize: 9, fontWeight: 700, color: offre.stockDispo > 0 ? C.green : C.red, textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>Dispo</div>
                      <div style={{ fontSize: 18, fontWeight: 800, color: offre.stockDispo > 0 ? C.green : C.red }}>{Math.round(offre.stockDispo)}</div>
                    </div>
                    <div style={{ flex: 1, background: C.orangeSoft, borderRadius: 8, padding: "8px 10px", textAlign: "center" as const }}>
                      <div style={{ fontSize: 9, fontWeight: 700, color: C.orange, textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>Vendues</div>
                      <div style={{ fontSize: 18, fontWeight: 800, color: C.orange }}>{Math.round(offre.vendues)}</div>
                    </div>
                  </div>

                  {/* Barre progression stock dispo vs général */}
                  {offre.stockGeneral > 0 && (
                    <div>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: C.textMuted, marginBottom: 3 }}>
                        <span>Stock dispo / Général</span>
                        <span style={{ fontWeight: 700 }}>{Math.round((offre.stockDispo / offre.stockGeneral) * 100)}%</span>
                      </div>
                      <div style={{ height: 6, background: C.border, borderRadius: 3, overflow: "hidden" }}>
                        <div style={{
                          height: "100%",
                          width: `${Math.min(100, Math.max(0, (offre.stockDispo / offre.stockGeneral) * 100))}%`,
                          background: offre.stockDispo / offre.stockGeneral > 0.5 ? C.green : offre.stockDispo / offre.stockGeneral > 0.2 ? C.orange : C.red,
                          borderRadius: 3, transition: "width 0.4s ease"
                        }} />
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
