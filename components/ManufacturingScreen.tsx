"use client";
// components/ManufacturingScreen.tsx
// ────────────────────────────────────────────────────────────────────────────
// Fabrication simplifiée — alternative légère à l'écran MRP d'Odoo.
//
// Flux : on scanne l'emplacement où sont stockés les composants, sa liste
// (produit + lot + dispo) s'affiche, et on tape directement dessus pour ajouter
// un composant — aucune re-saisie de référence. On indique la quantité PAR PACK,
// le WMS multiplie par le nombre de packs et crée l'ordre en état "Confirmé"
// (composants réservés, rien de consommé). La finalisation se fait dans Odoo.
// ────────────────────────────────────────────────────────────────────────────
import { useState, useEffect, useCallback, useRef } from "react";
import * as odoo from "@/lib/odoo";

const C = {
  bg: "#f8f9fb", white: "#fff", text: "#111827", textSec: "#374151",
  textMuted: "#6b7280", border: "#e5e7eb", blue: "#2563eb", blueSoft: "#eff6ff",
  green: "#16a34a", greenSoft: "#f0fdf4", red: "#dc2626", amber: "#b45309", amberSoft: "#fffbeb",
};

const S = {
  body: { flex: 1, padding: 16, display: "flex", flexDirection: "column" as const, gap: 12, maxWidth: 620, width: "100%", margin: "0 auto" },
  card: { background: C.white, borderRadius: 12, padding: "14px 16px", border: `1px solid ${C.border}` },
  label: { fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", color: C.textMuted, textTransform: "uppercase" as const, marginBottom: 4, display: "block" },
  input: { width: "100%", border: "1px solid #d1d5db", borderRadius: 8, padding: "9px 10px", fontSize: 14, color: C.text, fontFamily: "inherit", outline: "none", boxSizing: "border-box" as const },
  btn: { width: "100%", padding: 14, borderRadius: 10, border: "none", cursor: "pointer", fontSize: 15, fontWeight: 700, fontFamily: "inherit" },
};

const STATE_LABELS: Record<string, string> = {
  draft: "Brouillon", confirmed: "Confirmé", progress: "En cours",
  to_close: "À clôturer", done: "Terminé", cancel: "Annulé",
};

// Un composant retenu pour la fabrication : issu d'une ligne de l'emplacement.
interface Picked {
  key: string;           // productId + lotId — unicité d'une ligne de stock
  productId: number;
  productName: string;
  productRef: string;
  lotId: number | null;
  lotName: string;
  available: number;     // dispo net à l'emplacement (peut être 0 si tout réservé)
  onHand: number;        // stock physique présent
  qtyPerUnit: string;    // saisi par l'utilisateur
}

const fmtDate = (d: string) => {
  if (!d) return "";
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? "" : dt.toLocaleDateString("fr-FR", { month: "2-digit", year: "numeric" });
};

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

  // Emplacement de prélèvement + son contenu
  const [locQuery, setLocQuery] = useState("");
  const [location, setLocation] = useState<{ id: number; name: string } | null>(null);
  const [stock, setStock] = useState<odoo.LocationStockItem[]>([]);
  const [locLoading, setLocLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [locSugg, setLocSugg] = useState<{ id: number; complete_name?: string; name: string }[]>([]);
  const [locOpen, setLocOpen] = useState(false);

  const [picked, setPicked] = useState<Picked[]>([]);
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

  // ── Autocomplétion emplacement (dès 2 caractères) ──
  const locTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const q = locQuery.trim();
    if (location || q.length < 2) { setLocSugg([]); setLocOpen(false); return; }
    if (locTimer.current) clearTimeout(locTimer.current);
    locTimer.current = setTimeout(async () => {
      try {
        const r = await odoo.findLocationsByName(session, q);
        setLocSugg(r); setLocOpen(r.length > 0);
      } catch { setLocSugg([]); }
    }, 300);
    return () => { if (locTimer.current) clearTimeout(locTimer.current); };
  }, [locQuery, location, session]);

  // ── Scan / recherche d'emplacement ──
  const loadLocation = async (raw?: string) => {
    const q = (raw ?? locQuery).trim();
    if (!q) return;
    setLocLoading(true);
    try {
      const res = await odoo.getLocationStockForPicking(session, q);
      if (!res.location) {
        onToast(`❌ Emplacement "${q}" introuvable`, "error");
        setLocation(null); setStock([]);
      } else {
        setLocation(res.location);
        setStock(res.items);
        setLocQuery("");
        setLocSugg([]); setLocOpen(false);
        if (!res.items.length) onToast("Emplacement vide (aucun stock disponible)", "info");
      }
    } catch (e: any) {
      onToast(`Erreur : ${odoo.safeErrMsg(e)}`, "error");
    }
    setLocLoading(false);
  };

  const keyOf = (it: odoo.LocationStockItem) => `${it.productId}-${it.lotId ?? 0}`;

  const toggle = (it: odoo.LocationStockItem) => {
    const k = keyOf(it);
    setPicked(prev => prev.some(p => p.key === k)
      ? prev.filter(p => p.key !== k)
      : [...prev, {
          key: k, productId: it.productId, productName: it.productName, productRef: it.productRef,
          lotId: it.lotId, lotName: it.lotName, available: it.qty, onHand: it.onHand, qtyPerUnit: "1",
        }]);
  };

  const setQtyFor = (key: string, v: string) =>
    setPicked(prev => prev.map(p => p.key === key ? { ...p, qtyPerUnit: v } : p));

  const num = (s: string): number => {
    const n = parseFloat((s || "").replace(",", "."));
    return isNaN(n) ? 0 : n;
  };

  const qtyNum = num(qty);
  const validPicked = picked.filter(p => num(p.qtyPerUnit) > 0);
  const canCreate = !!product && qtyNum > 0 && validPicked.length > 0 && !creating;

  // Manque réel : même le stock physique de l'emplacement ne suffit pas.
  const shortages = validPicked.filter(p => num(p.qtyPerUnit) * qtyNum > p.onHand);
  // Stock présent mais réservé ailleurs → l'ordre sera créé en attente de dispo.
  const awaiting = validPicked.filter(p => {
    const total = num(p.qtyPerUnit) * qtyNum;
    return total <= p.onHand && total > p.available;
  });

  const visibleStock = filter.trim()
    ? stock.filter(it => `${it.productRef} ${it.productName} ${it.lotName}`.toLowerCase().includes(filter.trim().toLowerCase()))
    : stock;

  const reset = () => {
    setProduct(null); setProdQuery(""); setQty("1"); setPicked([]); setFilter("");
  };

  const create = async () => {
    if (!canCreate || !product) return;
    setCreating(true);
    try {
      const res = await odoo.createManufacturingOrder(
        session, product.id, qtyNum,
        // On n'impose le lot que s'il est réellement disponible : sinon Odoo
        // refuserait de créer la ligne de détail, alors qu'on veut justement que
        // l'ordre reste en attente et se réserve plus tard.
        validPicked.map(p => ({
          productId: p.productId,
          qtyPerUnit: num(p.qtyPerUnit),
          lotId: num(p.qtyPerUnit) * qtyNum <= p.available ? p.lotId : null,
        })),
        location?.id ?? null,
      );
      if (res.warning) onToast(`⚠️ ${res.name} — ${res.warning}`, "info");
      else onToast(`✅ ${res.name} créé et confirmé`, "success");
      reset();
      loadRecent();
      if (location) loadLocation(location.name); // stock rafraîchi après réservation
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
        {/* 1. Produit à fabriquer */}
        <div style={S.card}>
          <label style={S.label}>1 · Produit à fabriquer</label>
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
              <input style={S.input} value={prodQuery} onChange={e => setProdQuery(e.target.value)}
                placeholder="Référence, code-barres ou nom…" />
              {prodOpen && prodSugg.length > 0 && (
                <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 20, background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, marginTop: 4, maxHeight: 240, overflowY: "auto", boxShadow: "0 4px 14px rgba(0,0,0,.1)" }}>
                  {prodSugg.map(p => (
                    <button key={p.id} onClick={() => { setProduct(p); setProdOpen(false); setProdSugg([]); }}
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

        {/* 2. Emplacement de prélèvement */}
        <div style={S.card}>
          <label style={S.label}>2 · Emplacement des composants</label>
          {location ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, background: C.greenSoft, border: "1px solid #bbf7d0", borderRadius: 8, padding: "10px 12px" }}>
              <span style={{ fontSize: 16 }}>📍</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: C.text }}>{location.name}</div>
                <div style={{ fontSize: 11.5, color: C.textMuted }}>{stock.length} ligne(s) de stock disponible</div>
              </div>
              <button onClick={() => { setLocation(null); setStock([]); setPicked([]); setFilter(""); }}
                style={{ background: "none", border: "none", color: C.textMuted, fontSize: 18, cursor: "pointer", padding: 4 }}>×</button>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 8, position: "relative" }}>
              <input
                data-keep-scan="1"
                style={{ ...S.input, flex: 1 }}
                value={locQuery}
                onChange={e => setLocQuery(e.target.value)}
                onKeyDown={e => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  const v = (e.target as HTMLInputElement).value;
                  if (v.trim()) loadLocation(v);
                }}
                placeholder="Scanne ou tape l'emplacement…"
              />
              <button onClick={() => loadLocation()} disabled={locLoading || !locQuery.trim()}
                style={{ ...S.btn, width: "auto", padding: "0 18px", background: locLoading || !locQuery.trim() ? "#e5e7eb" : C.blue, color: locLoading || !locQuery.trim() ? "#9ca3af" : "#fff" }}>
                {locLoading ? "…" : "→"}
              </button>
              {locOpen && locSugg.length > 0 && (
                <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 20, background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, marginTop: 4, maxHeight: 240, overflowY: "auto", boxShadow: "0 4px 14px rgba(0,0,0,.1)" }}>
                  {locSugg.map(l => (
                    <button key={l.id} onClick={() => loadLocation(l.complete_name || l.name)}
                      style={{ display: "block", width: "100%", textAlign: "left", padding: "9px 12px", background: "none", border: "none", borderBottom: `1px solid ${C.border}`, cursor: "pointer", fontFamily: "inherit" }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>📍 {l.complete_name || l.name}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 3. Sélection des composants directement dans l'emplacement */}
        {location && stock.length > 0 && (
          <div style={S.card}>
            <label style={S.label}>3 · Touche un article pour l'ajouter</label>
            {stock.length > 6 && (
              <input style={{ ...S.input, marginBottom: 8 }} value={filter}
                onChange={e => setFilter(e.target.value)} placeholder="Filtrer la liste…" />
            )}
            <div style={{ maxHeight: 320, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
              {visibleStock.map(it => {
                const k = keyOf(it);
                const sel = picked.some(p => p.key === k);
                return (
                  <button key={k} onClick={() => toggle(it)}
                    style={{
                      display: "flex", alignItems: "center", gap: 10, textAlign: "left", width: "100%",
                      padding: "9px 11px", borderRadius: 8, cursor: "pointer", fontFamily: "inherit",
                      background: sel ? C.blueSoft : C.white,
                      border: `1.5px solid ${sel ? C.blue : C.border}`,
                    }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {it.productName}
                      </div>
                      <div style={{ fontSize: 11.5, color: C.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {it.productRef && `${it.productRef} · `}
                        {it.lotName ? `Lot ${it.lotName}` : "sans lot"}
                        {it.expirationDate && ` · ${fmtDate(it.expirationDate)}`}
                      </div>
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 700, color: it.qty > 0 ? C.textSec : C.amber }}>
                        {it.onHand}
                      </div>
                      {it.reserved > 0 && (
                        <div style={{ fontSize: 10.5, color: C.amber }}>
                          {it.qty > 0 ? `${it.qty} libre` : "tout réservé"}
                        </div>
                      )}
                    </div>
                    <span style={{ fontSize: 15, color: sel ? C.blue : "#d1d5db", flexShrink: 0 }}>{sel ? "✓" : "+"}</span>
                  </button>
                );
              })}
              {visibleStock.length === 0 && (
                <div style={{ fontSize: 13, color: C.textMuted, padding: "8px 0" }}>Aucun article ne correspond.</div>
              )}
            </div>
          </div>
        )}

        {/* 4. Quantités par pack pour les composants retenus */}
        {picked.length > 0 && (
          <div style={S.card}>
            <label style={S.label}>4 · Quantité PAR pack</label>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {picked.map(p => {
                const total = num(p.qtyPerUnit) * qtyNum;
                const short = total > p.onHand;          // même le physique ne suffit pas
                const wait = !short && total > p.available; // présent mais réservé ailleurs
                return (
                  <div key={p.key} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {p.productName}
                      </div>
                      <div style={{ fontSize: 11.5, color: short ? C.red : wait ? C.amber : C.textMuted }}>
                        {p.lotName ? `Lot ${p.lotName} · ` : ""}
                        {total > 0 ? `total ${total} / ${p.onHand} en stock` : `${p.onHand} en stock`}
                        {short && " ⚠️ insuffisant"}
                        {wait && " ⏳ en attente de dispo"}
                      </div>
                    </div>
                    <input
                      style={{ ...S.input, width: 74, flexShrink: 0, textAlign: "center", borderColor: short ? C.red : wait ? "#fed7aa" : "#d1d5db" }}
                      value={p.qtyPerUnit}
                      onChange={e => setQtyFor(p.key, e.target.value)}
                      inputMode="decimal"
                    />
                    <button onClick={() => setPicked(prev => prev.filter(x => x.key !== p.key))}
                      style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 8, color: C.textMuted, fontSize: 16, cursor: "pointer", padding: "8px 11px", flexShrink: 0 }}
                      aria-label="Retirer">×</button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Stock physique présent mais réservé ailleurs → l'ordre attend la dispo */}
        {awaiting.length > 0 && (
          <div style={{ ...S.card, background: C.amberSoft, borderColor: "#fed7aa" }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: "#9a3412", marginBottom: 4 }}>
              ⏳ En attente de disponibilité
            </div>
            <div style={{ fontSize: 12, color: "#7c2d12" }}>
              {awaiting.map(p => `${p.productName} : ${num(p.qtyPerUnit) * qtyNum} demandé, ${p.available} libre sur ${p.onHand}`).join(" · ")}
            </div>
            <div style={{ fontSize: 11.5, color: C.amber, marginTop: 4 }}>
              Le stock est là mais réservé par d'autres opérations. L'ordre sera créé et se
              réservera tout seul dès que les articles se libèrent.
            </div>
          </div>
        )}

        {/* Manque réel : même le stock physique ne couvre pas le besoin */}
        {shortages.length > 0 && (
          <div style={{ ...S.card, background: "#fef2f2", borderColor: "#fecaca" }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: "#991b1b", marginBottom: 4 }}>
              ⚠️ Stock insuffisant à cet emplacement
            </div>
            <div style={{ fontSize: 12, color: "#7f1d1d" }}>
              {shortages.map(p => `${p.productName} : ${num(p.qtyPerUnit) * qtyNum} demandé / ${p.onHand} en stock`).join(" · ")}
            </div>
            <div style={{ fontSize: 11.5, color: C.red, marginTop: 4 }}>
              L'ordre peut être créé quand même — il restera partiellement réservé.
            </div>
          </div>
        )}

        <button onClick={create} disabled={!canCreate}
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
