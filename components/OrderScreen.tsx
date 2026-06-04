"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import * as odoo from "@/lib/odoo";

// ── Palette ───────────────────────────────────────────────────────────────────
const C = {
  bg: "#f8fafc", white: "#fff", text: "#0f172a", textSec: "#334155",
  muted: "#94a3b8", border: "#e2e8f0",
  teal: "#0d9488", tealDark: "#0f766e", tealSoft: "#f0fdfa", tealMid: "#ccfbf1",
  purple: "#7c3aed", purpleSoft: "#f5f3ff",
  orange: "#ea580c", orangeSoft: "#fff7ed",
  green: "#16a34a", greenSoft: "#f0fdf4",
  red: "#dc2626", redSoft: "#fef2f2",
  blue: "#2563eb", blueSoft: "#eff6ff",
  shadow: "0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.05)",
  shadowMd: "0 4px 6px rgba(0,0,0,0.07), 0 2px 4px rgba(0,0,0,0.05)",
  shadowXl: "0 20px 25px rgba(0,0,0,0.10), 0 8px 10px rgba(0,0,0,0.04)",
};

// ── Types ─────────────────────────────────────────────────────────────────────
interface Props {
  session: odoo.OdooSession;
  onBack: () => void;
  onToast: (msg: string, type?: "success" | "error" | "info") => void;
}
interface CartItem { product: any; qty: number; unitPrice: number; }
interface FreeRule {
  id: string; name: string; triggerQty: number; freeQty: number;
  allProducts: boolean; productRefs: string[];
}
interface FreeItem { product: any; qty: number; ruleName: string; }

const LS_RULES = "wms_order_rules_v2";
function loadRules(): FreeRule[] { try { return JSON.parse(localStorage.getItem(LS_RULES) || "[]"); } catch { return []; } }
function saveRules(r: FreeRule[]) { localStorage.setItem(LS_RULES, JSON.stringify(r)); }
function uid() { return Math.random().toString(36).slice(2, 9); }
function fmtPrice(n: number) { return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(n); }

function computeFreeItems(cart: Record<number, CartItem>, rules: FreeRule[]): FreeItem[] {
  const out: FreeItem[] = [];
  for (const rule of rules) {
    let total = 0;
    const matched: any[] = [];
    for (const item of Object.values(cart)) {
      const ref = item.product.default_code || "";
      if (rule.allProducts || rule.productRefs.includes(ref)) { total += item.qty; matched.push(item.product); }
    }
    if (total >= rule.triggerQty && matched.length > 0) {
      const sets = Math.floor(total / rule.triggerQty);
      const top = matched.sort((a, b) => (cart[b.id]?.qty || 0) - (cart[a.id]?.qty || 0))[0];
      out.push({ product: top, qty: sets * rule.freeQty, ruleName: rule.name });
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
export default function OrderScreen({ session, onBack, onToast }: Props) {
  const [step, setStep] = useState<"client" | "catalog" | "confirm">("client");
  const [client, setClient] = useState<any>(null);
  const [cart, setCart] = useState<Record<number, CartItem>>({});
  const [rules, setRules] = useState<FreeRule[]>([]);
  const [freeItems, setFreeItems] = useState<FreeItem[]>([]);
  const [showRules, setShowRules] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<{ mainId: number; freeId: number | null } | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => { setRules(loadRules()); }, []);
  useEffect(() => { setFreeItems(computeFreeItems(cart, rules)); }, [cart, rules]);

  const cartCount = Object.values(cart).reduce((s, i) => s + i.qty, 0);
  const cartTotal = Object.values(cart).reduce((s, i) => s + i.qty * i.unitPrice, 0);
  const freeCount = freeItems.reduce((s, i) => s + i.qty, 0);

  const setQty = (product: any, qty: number) => {
    setCart(prev => {
      if (qty <= 0) { const n = { ...prev }; delete n[product.id]; return n; }
      return { ...prev, [product.id]: { product, qty, unitPrice: product.lst_price || 0 } };
    });
  };

  const handleValidate = async () => {
    setSubmitting(true);
    try {
      const pricelistId = client.property_product_pricelist?.[0] || false;
      const mainId = await odoo.create(session, "sale.order", {
        partner_id: client.id, state: "draft",
        ...(pricelistId ? { pricelist_id: pricelistId } : {}),
        note: note || "",
      });
      for (const item of Object.values(cart)) {
        await odoo.create(session, "sale.order.line", { order_id: mainId, product_id: item.product.id, product_uom_qty: item.qty, price_unit: item.unitPrice });
      }
      let freeId: number | null = null;
      if (freeItems.length > 0) {
        freeId = await odoo.create(session, "sale.order", { partner_id: client.id, state: "draft", note: `Articles offerts — lié au devis #${mainId}` });
        for (const fi of freeItems) {
          await odoo.create(session, "sale.order.line", { order_id: freeId, product_id: fi.product.id, product_uom_qty: fi.qty, price_unit: 0 });
        }
      }
      setDone({ mainId, freeId });
    } catch (e: any) { onToast("Erreur : " + e.message, "error"); }
    setSubmitting(false);
  };

  // Écran confirmation finale
  if (done) return (
    <div style={{ position: "fixed", inset: 0, background: "linear-gradient(135deg, #0f766e 0%, #7c3aed 100%)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'DM Sans', sans-serif" }}>
      <div style={{ background: "#fff", borderRadius: 24, padding: "48px 40px", maxWidth: 480, width: "90%", textAlign: "center", boxShadow: C.shadowXl }}>
        <div style={{ fontSize: 64, marginBottom: 16 }}>🎉</div>
        <div style={{ fontSize: 26, fontWeight: 800, color: C.text, marginBottom: 8 }}>Devis créé !</div>
        <div style={{ fontSize: 15, color: C.muted, lineHeight: 1.6, marginBottom: 32 }}>
          Devis principal <span style={{ color: C.teal, fontWeight: 700 }}>#{done.mainId}</span> dans Odoo
          {done.freeId && <><br/>BC gratuit <span style={{ color: C.purple, fontWeight: 700 }}>#{done.freeId}</span> créé automatiquement</>}
        </div>
        <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
          <button onClick={() => { setDone(null); setCart({}); setClient(null); setNote(""); setStep("client"); }}
            style={{ padding: "14px 28px", background: C.teal, color: "#fff", border: "none", borderRadius: 12, fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
            Nouvelle commande
          </button>
          <button onClick={onBack}
            style={{ padding: "14px 24px", background: C.bg, color: C.muted, border: `1px solid ${C.border}`, borderRadius: 12, fontSize: 15, cursor: "pointer", fontFamily: "inherit" }}>
            Menu
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div style={{ position: "fixed", inset: 0, background: C.bg, display: "flex", flexDirection: "column" as const, fontFamily: "'DM Sans', sans-serif", overflow: "hidden" }}>

      {/* ── Top bar ── */}
      <div style={{ height: 56, background: "#fff", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", padding: "0 20px", gap: 16, flexShrink: 0, boxShadow: C.shadow }}>
        <button onClick={onBack} style={{ width: 36, height: 36, borderRadius: 10, background: C.bg, border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2.5"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
        </button>

        {/* Breadcrumb / steps */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {(["client", "catalog", "confirm"] as const).map((s, i) => {
            const labels = ["Client", "Catalogue", "Validation"];
            const done_ = ["client", "catalog", "confirm"].indexOf(step) > i;
            const active = step === s;
            return (
              <div key={s} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {i > 0 && <div style={{ width: 20, height: 1, background: C.border }} />}
                <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 20,
                  background: active ? C.teal : done_ ? C.tealMid : C.bg,
                  cursor: done_ ? "pointer" : "default" }}
                  onClick={() => done_ && setStep(s)}>
                  <div style={{ width: 18, height: 18, borderRadius: 9, background: active ? "#fff" : done_ ? C.teal : C.border, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 800, color: active ? C.teal : done_ ? "#fff" : C.muted }}>
                    {done_ ? "✓" : i + 1}
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 600, color: active ? "#fff" : done_ ? C.tealDark : C.muted }}>{labels[i]}</span>
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ flex: 1 }} />

        {/* Client badge */}
        {client && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", background: C.tealSoft, borderRadius: 10, border: `1px solid ${C.tealMid}` }}>
            <div style={{ width: 28, height: 28, borderRadius: 8, background: C.teal, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 12, fontWeight: 700 }}>
              {client.name.charAt(0).toUpperCase()}
            </div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.tealDark }}>{client.name}</div>
              {client.property_product_pricelist && <div style={{ fontSize: 10, color: C.teal }}>{client.property_product_pricelist[1]}</div>}
            </div>
            {step !== "client" && <button onClick={() => { setClient(null); setCart({}); setStep("client"); }} style={{ background: "none", border: "none", cursor: "pointer", color: C.muted, fontSize: 14, lineHeight: 1 }}>✕</button>}
          </div>
        )}

        {/* Panier badge */}
        {cartCount > 0 && step === "catalog" && (
          <button onClick={() => setStep("confirm")} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 16px", background: C.teal, color: "#fff", border: "none", borderRadius: 10, cursor: "pointer", fontFamily: "inherit", fontWeight: 700, fontSize: 13 }}>
            🛒 {cartCount} article{cartCount > 1 ? "s" : ""}
            {freeCount > 0 && <span style={{ background: "rgba(255,255,255,0.25)", borderRadius: 6, padding: "1px 6px", fontSize: 11 }}>+{freeCount} offerts</span>}
            <span style={{ opacity: 0.85, fontSize: 13 }}>{fmtPrice(cartTotal)}</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M9 18l6-6-6-6"/></svg>
          </button>
        )}

        <button onClick={() => setShowRules(!showRules)} style={{ width: 36, height: 36, borderRadius: 10, background: showRules ? C.purpleSoft : C.bg, border: `1px solid ${showRules ? C.purple : C.border}`, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>
          ⚙️
        </button>
      </div>

      {/* ── Panneau règles (overlay) ── */}
      {showRules && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 100, display: "flex", alignItems: "flex-end", justifyContent: "flex-end" }} onClick={() => setShowRules(false)}>
          <div style={{ width: 400, height: "100%", background: "#fff", boxShadow: C.shadowXl, overflowY: "auto" as const }} onClick={e => e.stopPropagation()}>
            <RulesPanel rules={rules} onChange={r => { setRules(r); saveRules(r); }} onClose={() => setShowRules(false)} />
          </div>
        </div>
      )}

      {/* ── Étapes ── */}
      {step === "client" && <ClientStep session={session} onSelect={c => { setClient(c); setStep("catalog"); }} />}
      {step === "catalog" && client && (
        <CatalogStep session={session} cart={cart} onQtyChange={setQty} freeItems={freeItems} />
      )}
      {step === "confirm" && client && (
        <ConfirmStep cart={cart} freeItems={freeItems} total={cartTotal} client={client}
          note={note} setNote={setNote} onQtyChange={setQty}
          onBack={() => setStep("catalog")} onSubmit={handleValidate} submitting={submitting} />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ÉTAPE 1 — Sélection client
// ═══════════════════════════════════════════════════════════════════════════
function ClientStep({ session, onSelect }: { session: odoo.OdooSession; onSelect: (c: any) => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const timer = useRef<any>(null);

  useEffect(() => {
    if (q.length < 2) { setResults([]); return; }
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await odoo.searchRead(session, "res.partner",
          ["|", ["name", "ilike", q], ["ref", "ilike", q], ["customer_rank", ">", 0], ["active", "=", true]],
          ["id", "name", "ref", "city", "country_id", "property_product_pricelist", "email", "phone"], 30);
        setResults(r);
      } catch {}
      setLoading(false);
    }, 300);
  }, [q, session]);

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column" as const, alignItems: "center", justifyContent: "center", padding: 40 }}>
      <div style={{ width: "100%", maxWidth: 560 }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ width: 72, height: 72, borderRadius: 20, background: "linear-gradient(135deg, #0d9488, #7c3aed)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px", fontSize: 32 }}>👤</div>
          <div style={{ fontSize: 26, fontWeight: 800, color: C.text }}>Choisir un client</div>
          <div style={{ fontSize: 14, color: C.muted, marginTop: 6 }}>Recherche par nom, référence ou ville</div>
        </div>

        <div style={{ position: "relative" as const, marginBottom: 16 }}>
          <svg style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)" }} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={C.muted} strokeWidth="2">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
          <input autoFocus value={q} onChange={e => setQ(e.target.value)}
            placeholder="Nom du client..."
            style={{ width: "100%", boxSizing: "border-box" as const, padding: "14px 14px 14px 44px", border: `1.5px solid ${C.border}`, borderRadius: 14, fontSize: 16, fontFamily: "inherit", background: C.white, color: C.text, boxShadow: C.shadowMd, outline: "none" }} />
        </div>

        {loading && <div style={{ textAlign: "center", color: C.muted, padding: 12, fontSize: 14 }}>Recherche en cours…</div>}

        <div style={{ display: "flex", flexDirection: "column" as const, gap: 8, maxHeight: "50vh", overflowY: "auto" as const }}>
          {results.map(c => (
            <button key={c.id} onClick={() => onSelect(c)}
              style={{ padding: "14px 16px", background: C.white, border: `1.5px solid ${C.border}`, borderRadius: 14, cursor: "pointer", textAlign: "left" as const, fontFamily: "inherit", boxShadow: C.shadow, transition: "all 0.12s", display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ width: 42, height: 42, borderRadius: 12, background: `hsl(${c.id % 360}, 60%, 90%)`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 800, color: `hsl(${c.id % 360}, 60%, 35%)`, flexShrink: 0 }}>
                {c.name.charAt(0).toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{c.name}</div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 2, display: "flex", gap: 10, flexWrap: "wrap" as const }}>
                  {c.ref && <span>Réf: {c.ref}</span>}
                  {c.city && <span>📍 {c.city}</span>}
                  {c.phone && <span>📞 {c.phone}</span>}
                </div>
              </div>
              {c.property_product_pricelist && (
                <div style={{ fontSize: 11, fontWeight: 600, color: C.teal, background: C.tealSoft, borderRadius: 8, padding: "3px 8px", flexShrink: 0 }}>
                  {c.property_product_pricelist[1]}
                </div>
              )}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={C.muted} strokeWidth="2"><path d="M9 18l6-6-6-6"/></svg>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ÉTAPE 2 — Catalogue
// ═══════════════════════════════════════════════════════════════════════════
function CatalogStep({ session, cart, onQtyChange, freeItems }: {
  session: odoo.OdooSession; cart: Record<number, CartItem>;
  onQtyChange: (p: any, q: number) => void; freeItems: FreeItem[];
}) {
  const [cats, setCats] = useState<any[]>([]);
  const [catId, setCatId] = useState<number | null>(null);
  const [products, setProducts] = useState<any[]>([]);
  const [loading, setProdLoading] = useState(false);
  const [search, setSearch] = useState("");
  const searchTimer = useRef<any>(null);

  useEffect(() => {
    odoo.searchRead(session, "product.category", [], ["id", "name", "parent_id"], 200, "complete_name")
      .then(c => setCats(c)).catch(() => {});
  }, [session]);

  const load = useCallback(async (cId: number | null, q: string) => {
    setProdLoading(true);
    const domain: any[] = [["sale_ok", "=", true], ["active", "=", true]];
    if (cId) domain.push(["categ_id", "=", cId]);
    if (q.trim().length >= 2) {
      domain.push("|");
      domain.push(["name", "ilike", q.trim()]);
      domain.push(["default_code", "ilike", q.trim()]);
    }
    try {
      const p = await odoo.searchRead(session, "product.product", domain,
        ["id", "name", "default_code", "lst_price", "uom_id", "categ_id", "virtual_available", "qty_available", "image_128"], 80, "name");
      setProducts(p);
    } catch {}
    setProdLoading(false);
  }, [session]);

  useEffect(() => {
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => load(catId, search), search ? 300 : 0);
  }, [catId, search, load]);

  const freeProductIds = new Set(freeItems.map(f => f.product.id));

  return (
    <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>

      {/* Sidebar catégories */}
      <div style={{ width: 180, background: C.white, borderRight: `1px solid ${C.border}`, overflowY: "auto" as const, flexShrink: 0 }}>
        <div style={{ padding: "12px 12px 6px", fontSize: 10, fontWeight: 700, color: C.muted, textTransform: "uppercase" as const, letterSpacing: "0.08em" }}>Catégories</div>
        {[{ id: null, name: "Tous les produits" }, ...cats].map(cat => (
          <button key={cat.id ?? "all"} onClick={() => setCatId(cat.id)}
            style={{ width: "100%", padding: "10px 12px", background: catId === cat.id ? C.tealSoft : "transparent", border: "none", borderLeft: `3px solid ${catId === cat.id ? C.teal : "transparent"}`, cursor: "pointer", textAlign: "left" as const, fontSize: 12, fontWeight: catId === cat.id ? 700 : 400, color: catId === cat.id ? C.tealDark : C.textSec, fontFamily: "inherit", transition: "all 0.1s" }}>
            {cat.name}
          </button>
        ))}
      </div>

      {/* Zone principale */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column" as const, overflow: "hidden", minWidth: 0 }}>

        {/* Barre recherche */}
        <div style={{ padding: "10px 16px", background: C.white, borderBottom: `1px solid ${C.border}`, display: "flex", gap: 10, alignItems: "center" }}>
          <div style={{ position: "relative" as const, flex: 1 }}>
            <svg style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)" }} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={C.muted} strokeWidth="2">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Rechercher par nom ou référence..."
              style={{ width: "100%", boxSizing: "border-box" as const, padding: "9px 9px 9px 34px", border: `1px solid ${C.border}`, borderRadius: 10, fontSize: 13, fontFamily: "inherit", background: C.bg }} />
          </div>
          {freeItems.length > 0 && (
            <div style={{ padding: "6px 12px", background: C.greenSoft, border: `1px solid ${C.green}33`, borderRadius: 10, fontSize: 12, fontWeight: 600, color: C.green, flexShrink: 0 }}>
              🎁 {freeItems.reduce((s, i) => s + i.qty, 0)} offerts
            </div>
          )}
        </div>

        {/* Grille produits */}
        <div style={{ flex: 1, overflowY: "auto" as const, padding: 16 }}>
          {loading ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 200, color: C.muted }}>Chargement…</div>
          ) : !catId && !search ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 300, flexDirection: "column" as const, gap: 12, color: C.muted }}>
              <div style={{ fontSize: 48 }}>👈</div>
              <div style={{ fontSize: 15, fontWeight: 600 }}>Sélectionne une catégorie</div>
              <div style={{ fontSize: 13 }}>ou utilise la recherche</div>
            </div>
          ) : products.length === 0 ? (
            <div style={{ textAlign: "center", padding: 60, color: C.muted }}>Aucun produit trouvé</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(175px, 1fr))", gap: 12 }}>
              {products.map(p => {
                const qty = cart[p.id]?.qty || 0;
                const isFree = freeProductIds.has(p.id);
                const stock = Math.max(0, Math.round(p.virtual_available || 0));
                return (
                  <div key={p.id} style={{ background: C.white, borderRadius: 16, overflow: "hidden", border: `2px solid ${qty > 0 ? C.teal : isFree ? C.green : C.border}`, boxShadow: qty > 0 ? `0 0 0 4px ${C.tealSoft}` : C.shadow, transition: "all 0.15s" }}>
                    {/* Image */}
                    <div style={{ height: 90, background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", position: "relative" as const }}>
                      {p.image_128
                        ? <img src={`data:image/png;base64,${p.image_128}`} alt="" style={{ height: 80, objectFit: "contain" }} />
                        : <div style={{ fontSize: 36 }}>📦</div>}
                      {isFree && <div style={{ position: "absolute", top: 6, right: 6, background: C.green, color: "#fff", fontSize: 9, fontWeight: 700, borderRadius: 6, padding: "2px 6px" }}>OFFERT</div>}
                      {qty > 0 && <div style={{ position: "absolute", top: 6, left: 6, background: C.teal, color: "#fff", fontSize: 11, fontWeight: 800, borderRadius: 8, padding: "2px 8px" }}>{qty}</div>}
                    </div>
                    {/* Infos */}
                    <div style={{ padding: "10px 12px 12px" }}>
                      <div style={{ fontSize: 10, color: C.muted, fontFamily: "monospace", marginBottom: 2 }}>{p.default_code}</div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: C.text, lineHeight: 1.35, height: 32, overflow: "hidden" }}>{p.name}</div>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6, marginBottom: 8 }}>
                        <span style={{ fontSize: 14, fontWeight: 800, color: C.tealDark }}>{p.lst_price > 0 ? fmtPrice(p.lst_price) : "—"}</span>
                        <span style={{ fontSize: 10, fontWeight: 600, color: stock > 0 ? C.green : C.red, background: stock > 0 ? C.greenSoft : C.redSoft, borderRadius: 6, padding: "2px 6px" }}>
                          {stock > 0 ? `${stock}` : "Rupture"}
                        </span>
                      </div>
                      {/* Stepper */}
                      <div style={{ display: "flex", background: qty > 0 ? C.tealSoft : C.bg, borderRadius: 10, overflow: "hidden", border: `1px solid ${qty > 0 ? C.tealMid : C.border}` }}>
                        <button onClick={() => onQtyChange(p, qty - 1)} style={{ flex: 1, padding: "8px 0", background: "transparent", border: "none", cursor: "pointer", fontSize: 18, fontWeight: 700, color: qty > 0 ? C.red : C.muted, lineHeight: 1 }}>−</button>
                        <span style={{ flex: 1, textAlign: "center" as const, fontSize: 15, fontWeight: 800, color: qty > 0 ? C.tealDark : C.muted, lineHeight: "34px" }}>{qty}</span>
                        <button onClick={() => onQtyChange(p, qty + 1)} style={{ flex: 1, padding: "8px 0", background: "transparent", border: "none", cursor: "pointer", fontSize: 18, fontWeight: 700, color: C.teal, lineHeight: 1 }}>+</button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ÉTAPE 3 — Confirmation
// ═══════════════════════════════════════════════════════════════════════════
function ConfirmStep({ cart, freeItems, total, client, note, setNote, onQtyChange, onBack, onSubmit, submitting }: {
  cart: Record<number, CartItem>; freeItems: FreeItem[]; total: number;
  client: any; note: string; setNote: (n: string) => void;
  onQtyChange: (p: any, q: number) => void;
  onBack: () => void; onSubmit: () => void; submitting: boolean;
}) {
  return (
    <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>
      {/* Liste articles */}
      <div style={{ flex: 1, overflowY: "auto" as const, padding: 24 }}>
        <div style={{ fontSize: 18, fontWeight: 800, color: C.text, marginBottom: 16 }}>Récapitulatif de la commande</div>

        {/* Articles commandés */}
        <div style={{ background: C.white, borderRadius: 16, overflow: "hidden", border: `1px solid ${C.border}`, marginBottom: 16, boxShadow: C.shadow }}>
          <div style={{ padding: "12px 16px", background: C.teal, color: "#fff", fontSize: 12, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>
            📦 Articles ({Object.values(cart).reduce((s, i) => s + i.qty, 0)} unités)
          </div>
          {Object.values(cart).map((item, i) => (
            <div key={item.product.id} style={{ padding: "12px 16px", borderBottom: i < Object.values(cart).length - 1 ? `1px solid ${C.border}` : undefined, display: "flex", alignItems: "center", gap: 12 }}>
              {item.product.image_128 && <img src={`data:image/png;base64,${item.product.image_128}`} alt="" style={{ width: 44, height: 44, objectFit: "contain", borderRadius: 8, background: C.bg, flexShrink: 0 }} />}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{item.product.name}</div>
                <div style={{ fontSize: 11, color: C.muted }}>{item.product.default_code} · {fmtPrice(item.unitPrice)} / unité</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                <div style={{ display: "flex", background: C.bg, borderRadius: 8, overflow: "hidden", border: `1px solid ${C.border}` }}>
                  <button onClick={() => onQtyChange(item.product, item.qty - 1)} style={{ padding: "5px 10px", background: "none", border: "none", cursor: "pointer", fontSize: 15, color: C.red, fontWeight: 700 }}>−</button>
                  <span style={{ padding: "5px 8px", fontSize: 14, fontWeight: 800, color: C.text }}>{item.qty}</span>
                  <button onClick={() => onQtyChange(item.product, item.qty + 1)} style={{ padding: "5px 10px", background: "none", border: "none", cursor: "pointer", fontSize: 15, color: C.teal, fontWeight: 700 }}>+</button>
                </div>
                <span style={{ fontSize: 14, fontWeight: 800, color: C.tealDark, minWidth: 70, textAlign: "right" as const }}>{fmtPrice(item.qty * item.unitPrice)}</span>
              </div>
            </div>
          ))}
        </div>

        {/* BC gratuit */}
        {freeItems.length > 0 && (
          <div style={{ background: C.greenSoft, borderRadius: 16, overflow: "hidden", border: `1px solid ${C.green}33`, marginBottom: 16 }}>
            <div style={{ padding: "12px 16px", background: C.green, color: "#fff", fontSize: 12, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>
              🎁 BC Gratuit séparé (créé automatiquement)
            </div>
            {freeItems.map((fi, i) => (
              <div key={i} style={{ padding: "12px 16px", borderBottom: i < freeItems.length - 1 ? `1px solid ${C.green}22` : undefined, display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.green }}>{fi.product.name}</div>
                  <div style={{ fontSize: 11, color: C.green, opacity: 0.8 }}>{fi.ruleName}</div>
                </div>
                <div style={{ fontSize: 14, fontWeight: 800, color: C.green }}>{fi.qty} × 0,00 €</div>
              </div>
            ))}
          </div>
        )}

        {/* Note */}
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: C.muted, marginBottom: 6 }}>Note interne</div>
          <textarea value={note} onChange={e => setNote(e.target.value)} placeholder="Informations complémentaires..."
            rows={3} style={{ width: "100%", boxSizing: "border-box" as const, padding: "10px 12px", border: `1px solid ${C.border}`, borderRadius: 12, fontSize: 13, fontFamily: "inherit", resize: "none" as const, background: C.white }} />
        </div>
      </div>

      {/* Panneau latéral total */}
      <div style={{ width: 300, background: C.white, borderLeft: `1px solid ${C.border}`, display: "flex", flexDirection: "column" as const, padding: 24, gap: 16 }}>
        <div>
          <div style={{ fontSize: 11, color: C.muted, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 4 }}>Client</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{client.name}</div>
          {client.property_product_pricelist && <div style={{ fontSize: 12, color: C.teal, marginTop: 2 }}>📋 {client.property_product_pricelist[1]}</div>}
        </div>

        <div style={{ border: `1px solid ${C.border}`, borderRadius: 14, padding: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontSize: 13, color: C.muted }}>Sous-total</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{fmtPrice(total)}</span>
          </div>
          {freeItems.length > 0 && (
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <span style={{ fontSize: 13, color: C.green }}>🎁 Articles offerts</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: C.green }}>BC séparé</span>
            </div>
          )}
          <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 8, display: "flex", justifyContent: "space-between" }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: C.text }}>Total HT</span>
            <span style={{ fontSize: 18, fontWeight: 800, color: C.tealDark }}>{fmtPrice(total)}</span>
          </div>
          <div style={{ fontSize: 10, color: C.muted, marginTop: 4, textAlign: "center" as const }}>Prix Odoo appliqués à la création</div>
        </div>

        <div style={{ marginTop: "auto", display: "flex", flexDirection: "column" as const, gap: 10 }}>
          <button onClick={onSubmit} disabled={submitting}
            style={{ padding: "16px 0", background: submitting ? C.muted : "linear-gradient(135deg, #0d9488, #0f766e)", color: "#fff", border: "none", borderRadius: 14, fontSize: 16, fontWeight: 800, cursor: submitting ? "default" : "pointer", fontFamily: "inherit", boxShadow: submitting ? "none" : "0 4px 14px rgba(13,148,136,0.4)" }}>
            {submitting ? "Création en cours…" : `Créer le devis${freeItems.length > 0 ? " + BC gratuit" : ""}`}
          </button>
          <button onClick={onBack}
            style={{ padding: "12px 0", background: "transparent", color: C.muted, border: `1px solid ${C.border}`, borderRadius: 12, fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}>
            ← Modifier le panier
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PANNEAU RÈGLES
// ═══════════════════════════════════════════════════════════════════════════
function RulesPanel({ rules, onChange, onClose }: { rules: FreeRule[]; onChange: (r: FreeRule[]) => void; onClose: () => void }) {
  const [form, setForm] = useState<FreeRule | null>(null);

  const newRule = (): FreeRule => ({ id: uid(), name: "", triggerQty: 10, freeQty: 1, allProducts: true, productRefs: [] });

  const save = (r: FreeRule) => {
    if (rules.find(x => x.id === r.id)) onChange(rules.map(x => x.id === r.id ? r : x));
    else onChange([...rules, r]);
    setForm(null);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column" as const, height: "100%", fontFamily: "'DM Sans', sans-serif" }}>
      <div style={{ padding: "16px 20px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={onClose} style={{ background: C.bg, border: "none", borderRadius: 8, padding: 7, cursor: "pointer", display: "flex" }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><path d="M18 6l-12 12M6 6l12 12"/></svg>
        </button>
        <div style={{ fontSize: 16, fontWeight: 700, color: C.text, flex: 1 }}>Règles de gratuité</div>
        <button onClick={() => setForm(newRule())} style={{ padding: "7px 14px", background: C.purple, color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>+ Règle</button>
      </div>

      <div style={{ flex: 1, overflowY: "auto" as const, padding: 16 }}>
        {form && (
          <RuleForm rule={form} onChange={setForm} onSave={() => save(form!)} onCancel={() => setForm(null)} />
        )}

        {!form && rules.length === 0 && (
          <div style={{ textAlign: "center", padding: "48px 24px", color: C.muted }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>🎁</div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Aucune règle configurée</div>
            <div style={{ fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>Exemple : 10 achetés → 2 offerts dans un BC séparé automatique</div>
          </div>
        )}

        {!form && rules.map(r => (
          <div key={r.id} style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 14, padding: 14, marginBottom: 10, display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 44, height: 44, borderRadius: 12, background: C.purpleSoft, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, flexShrink: 0 }}>🎁</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{r.name || `${r.triggerQty} → ${r.freeQty} gratuits`}</div>
              <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
                {r.triggerQty} achetés → <span style={{ color: C.green, fontWeight: 700 }}>{r.freeQty} offerts</span>
                {" · "}{r.allProducts ? "Tous produits" : `${r.productRefs.length} refs`}
              </div>
            </div>
            <button onClick={() => setForm(r)} style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: "5px 10px", cursor: "pointer", fontSize: 13 }}>✏️</button>
            <button onClick={() => onChange(rules.filter(x => x.id !== r.id))} style={{ background: C.redSoft, border: "none", borderRadius: 8, padding: "5px 10px", cursor: "pointer", fontSize: 13, color: C.red }}>🗑</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function RuleForm({ rule, onChange, onSave, onCancel }: { rule: FreeRule; onChange: (r: FreeRule) => void; onSave: () => void; onCancel: () => void }) {
  const refsStr = rule.productRefs.join("\n");
  const inp = (field: keyof FreeRule, value: any) => onChange({ ...rule, [field]: value });
  return (
    <div style={{ background: C.white, border: `1.5px solid ${C.purple}`, borderRadius: 16, padding: 16, marginBottom: 16, display: "flex", flexDirection: "column" as const, gap: 14 }}>
      <div>
        <label style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase" as const, letterSpacing: "0.06em", display: "block", marginBottom: 5 }}>Nom de la règle</label>
        <input value={rule.name} onChange={e => inp("name", e.target.value)} placeholder="Ex: 10+1 gratuit"
          style={{ width: "100%", boxSizing: "border-box" as const, padding: "9px 12px", border: `1px solid ${C.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit" }} />
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase" as const, letterSpacing: "0.06em", display: "block", marginBottom: 5 }}>Qté achetée</label>
          <input type="number" value={rule.triggerQty} onChange={e => inp("triggerQty", Number(e.target.value))} min="1"
            style={{ width: "100%", boxSizing: "border-box" as const, padding: "9px 12px", border: `1px solid ${C.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit" }} />
        </div>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase" as const, letterSpacing: "0.06em", display: "block", marginBottom: 5 }}>Qté offerte</label>
          <input type="number" value={rule.freeQty} onChange={e => inp("freeQty", Number(e.target.value))} min="1"
            style={{ width: "100%", boxSizing: "border-box" as const, padding: "9px 12px", border: `1px solid ${C.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit" }} />
        </div>
      </div>
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 8 }}>S'applique à</div>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          {([true, false] as const).map(v => (
            <button key={String(v)} onClick={() => inp("allProducts", v)}
              style={{ flex: 1, padding: "8px 0", background: rule.allProducts === v ? C.tealSoft : C.bg, border: `1px solid ${rule.allProducts === v ? C.teal : C.border}`, borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: 600, color: rule.allProducts === v ? C.tealDark : C.muted, fontFamily: "inherit" }}>
              {v ? "Tous les produits" : "Références spécifiques"}
            </button>
          ))}
        </div>
        {!rule.allProducts && (
          <textarea value={refsStr} onChange={e => inp("productRefs", e.target.value.split(/[\n,;]+/).map((r: string) => r.trim()).filter(Boolean))}
            placeholder={"REF001\nREF002"} rows={3}
            style={{ width: "100%", boxSizing: "border-box" as const, padding: "8px 10px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, fontFamily: "monospace", resize: "none" as const }} />
        )}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={onCancel} style={{ flex: 1, padding: "10px 0", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" }}>Annuler</button>
        <button onClick={onSave} style={{ flex: 2, padding: "10px 0", background: C.purple, color: "#fff", border: "none", borderRadius: 10, cursor: "pointer", fontSize: 13, fontWeight: 700, fontFamily: "inherit" }}>Enregistrer</button>
      </div>
    </div>
  );
}
