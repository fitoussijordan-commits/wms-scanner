"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import * as odoo from "@/lib/odoo";

// ── Couleurs ─────────────────────────────────────────────────────────────────
const C = {
  bg: "#f8fafc", white: "#fff", text: "#1a1a2e", textSec: "#374151",
  textMuted: "#6b7280", border: "#e5e7eb",
  blue: "#3b82f6", blueSoft: "#eff6ff",
  green: "#16a34a", greenSoft: "#f0fdf4",
  red: "#ef4444", redSoft: "#fef2f2",
  orange: "#f97316", orangeSoft: "#fff7ed",
  teal: "#0d9488", tealSoft: "#f0fdfa",
  purple: "#7c3aed", purpleSoft: "#f5f3ff",
  shadow: "0 1px 4px rgba(0,0,0,0.08)",
  shadowLg: "0 4px 20px rgba(0,0,0,0.12)",
};

// ── Types ─────────────────────────────────────────────────────────────────────
interface Props {
  session: odoo.OdooSession;
  onBack: () => void;
  onToast: (msg: string, type?: "success" | "error" | "info") => void;
}

interface CartItem {
  product: any;
  qty: number;
  unitPrice: number;
}

interface FreeRule {
  id: string;
  name: string;
  triggerQty: number;
  freeQty: number;
  allProducts: boolean;
  productRefs: string[];
}

interface FreeItem {
  product: any;
  qty: number;
  ruleId: string;
  ruleName: string;
}

const LS_RULES_KEY = "wms_order_rules";

function loadRules(): FreeRule[] {
  try { return JSON.parse(localStorage.getItem(LS_RULES_KEY) || "[]"); } catch { return []; }
}
function saveRules(r: FreeRule[]) { localStorage.setItem(LS_RULES_KEY, JSON.stringify(r)); }
function genId() { return Math.random().toString(36).slice(2, 9); }

// ── Calcul articles gratuits ──────────────────────────────────────────────────
function computeFreeItems(cart: Record<number, CartItem>, rules: FreeRule[], products: any[]): FreeItem[] {
  const result: FreeItem[] = [];
  const refToProduct: Record<string, any> = {};
  for (const p of products) if (p.default_code) refToProduct[p.default_code] = p;

  for (const rule of rules) {
    let totalTrigger = 0;
    const matchedProducts: any[] = [];

    for (const item of Object.values(cart)) {
      const ref = item.product.default_code || "";
      const matches = rule.allProducts || rule.productRefs.includes(ref);
      if (matches) {
        totalTrigger += item.qty;
        matchedProducts.push(item.product);
      }
    }

    if (totalTrigger >= rule.triggerQty && matchedProducts.length > 0) {
      const sets = Math.floor(totalTrigger / rule.triggerQty);
      const freeQty = sets * rule.freeQty;
      // Donner les gratuits sur le produit le + commandé
      const topProduct = matchedProducts.sort((a, b) =>
        (cart[b.id]?.qty || 0) - (cart[a.id]?.qty || 0))[0];
      result.push({ product: topProduct, qty: freeQty, ruleId: rule.id, ruleName: rule.name });
    }
  }
  return result;
}

// ── Création commande Odoo ────────────────────────────────────────────────────
async function createOrderInOdoo(
  session: odoo.OdooSession,
  client: any,
  cart: Record<number, CartItem>,
  freeItems: FreeItem[],
  note: string
): Promise<{ mainId: number; freeId: number | null }> {
  const partnerId = client.id;
  const pricelistId = client.property_product_pricelist?.[0] || false;

  const mainOrderId = await odoo.create(session, "sale.order", {
    partner_id: partnerId,
    ...(pricelistId ? { pricelist_id: pricelistId } : {}),
    note: note || "",
    state: "draft",
  });

  // Lignes commande principale
  for (const item of Object.values(cart)) {
    await odoo.create(session, "sale.order.line", {
      order_id: mainOrderId,
      product_id: item.product.id,
      product_uom_qty: item.qty,
      price_unit: item.unitPrice,
    });
  }

  // BC gratuit séparé si besoin
  let freeId: number | null = null;
  if (freeItems.length > 0) {
    freeId = await odoo.create(session, "sale.order", {
      partner_id: partnerId,
      note: `Articles offerts — lié au devis ${mainOrderId}`,
      state: "draft",
    });
    for (const fi of freeItems) {
      await odoo.create(session, "sale.order.line", {
        order_id: freeId,
        product_id: fi.product.id,
        product_uom_qty: fi.qty,
        price_unit: 0,
      });
    }
  }

  return { mainId: mainOrderId, freeId };
}

// ── Composant principal ───────────────────────────────────────────────────────
export default function OrderScreen({ session, onBack, onToast }: Props) {
  const [tab, setTab] = useState<"order" | "rules">("order");
  const [client, setClient] = useState<any | null>(null);
  const [clientSearch, setClientSearch] = useState("");
  const [clientResults, setClientResults] = useState<any[]>([]);
  const [clientLoading, setClientLoading] = useState(false);

  const [categories, setCategories] = useState<any[]>([]);
  const [catId, setCatId] = useState<number | null>(null);
  const [products, setProducts] = useState<any[]>([]);
  const [allProducts, setAllProducts] = useState<any[]>([]); // pour les règles
  const [prodLoading, setProdLoading] = useState(false);
  const [prodSearch, setProdSearch] = useState("");

  const [cart, setCart] = useState<Record<number, CartItem>>({});
  const [cartOpen, setCartOpen] = useState(false);
  const [rules, setRules] = useState<FreeRule[]>([]);
  const [freeItems, setFreeItems] = useState<FreeItem[]>([]);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [orderDone, setOrderDone] = useState<{ mainId: number; freeId: number | null } | null>(null);

  const searchTimer = useRef<any>(null);

  useEffect(() => { setRules(loadRules()); }, []);

  // Charger les catégories Odoo
  useEffect(() => {
    odoo.searchRead(session, "product.category", [], ["id", "name", "parent_id"], 200, "complete_name")
      .then(cats => setCategories(cats))
      .catch(() => {});
  }, [session]);

  // Recalculer les articles gratuits quand le panier change
  useEffect(() => {
    setFreeItems(computeFreeItems(cart, rules, allProducts));
  }, [cart, rules, allProducts]);

  // Recherche clients
  useEffect(() => {
    if (!clientSearch.trim() || clientSearch.length < 2) { setClientResults([]); return; }
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      setClientLoading(true);
      try {
        const res = await odoo.searchRead(session, "res.partner",
          ["|", ["name", "ilike", clientSearch], ["ref", "ilike", clientSearch],
           ["customer_rank", ">", 0], ["active", "=", true]],
          ["id", "name", "ref", "city", "property_product_pricelist"], 20);
        setClientResults(res);
      } catch {}
      setClientLoading(false);
    }, 350);
  }, [clientSearch, session]);

  // Charger les produits de la catégorie
  const loadProducts = useCallback(async (cId: number | null, search: string) => {
    setProdLoading(true);
    try {
      const domain: any[] = [["sale_ok", "=", true], ["active", "=", true]];
      if (cId) domain.push(["categ_id", "=", cId]);
      if (search.trim().length >= 2) {
        domain.push("|");
        domain.push(["name", "ilike", search.trim()]);
        domain.push(["default_code", "ilike", search.trim()]);
      }
      const prods = await odoo.searchRead(session, "product.product",
        domain,
        ["id", "name", "default_code", "lst_price", "uom_id", "categ_id",
         "virtual_available", "qty_available", "image_128"],
        80, "name");
      setProducts(prods);
      if (!search) setAllProducts(prev => {
        const ids = new Set(prev.map((p: any) => p.id));
        return [...prev, ...prods.filter((p: any) => !ids.has(p.id))];
      });
    } catch { onToast("Erreur chargement produits", "error"); }
    setProdLoading(false);
  }, [session, onToast]);

  useEffect(() => {
    if (catId !== null) loadProducts(catId, prodSearch);
  }, [catId, prodSearch, loadProducts]);

  const setQty = (product: any, qty: number) => {
    setCart(prev => {
      if (qty <= 0) {
        const next = { ...prev };
        delete next[product.id];
        return next;
      }
      return { ...prev, [product.id]: { product, qty, unitPrice: product.lst_price || 0 } };
    });
  };

  const cartCount = Object.values(cart).reduce((s, i) => s + i.qty, 0);
  const cartTotal = Object.values(cart).reduce((s, i) => s + i.qty * i.unitPrice, 0);
  const freeTotal = freeItems.reduce((s, i) => s + i.qty, 0);

  const handleValidate = async () => {
    if (!client) { onToast("Choisis un client", "error"); return; }
    if (Object.keys(cart).length === 0) { onToast("Panier vide", "error"); return; }
    setSubmitting(true);
    try {
      const result = await createOrderInOdoo(session, client, cart, freeItems, note);
      setOrderDone(result);
      onToast(`Devis créé${result.freeId ? " + BC gratuit" : ""}`, "success");
    } catch (e: any) {
      onToast("Erreur création : " + e.message, "error");
    }
    setSubmitting(false);
  };

  const resetOrder = () => {
    setCart({}); setClient(null); setClientSearch(""); setNote("");
    setOrderDone(null); setCatId(null); setProducts([]);
  };

  if (orderDone) {
    return (
      <div style={{ padding: 32, maxWidth: 540, margin: "0 auto", fontFamily: "'DM Sans', sans-serif", textAlign: "center" as const }}>
        <div style={{ fontSize: 56, marginBottom: 16 }}>🎉</div>
        <div style={{ fontSize: 22, fontWeight: 800, color: C.text, marginBottom: 8 }}>Devis créé !</div>
        <div style={{ fontSize: 14, color: C.textMuted, marginBottom: 24 }}>
          Devis principal <strong style={{ color: C.teal }}>#{orderDone.mainId}</strong> créé dans Odoo
          {orderDone.freeId && <><br/>BC gratuit <strong style={{ color: C.orange }}>#{orderDone.freeId}</strong> créé automatiquement</>}
        </div>
        <button onClick={resetOrder} style={{ padding: "13px 28px", background: C.teal, color: "#fff", border: "none", borderRadius: 12, fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
          Nouvelle commande
        </button>
        <button onClick={onBack} style={{ display: "block", margin: "12px auto 0", background: "none", border: "none", color: C.textMuted, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
          Retour au menu
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column" as const, height: "100dvh", fontFamily: "'DM Sans', sans-serif", background: C.bg, overflow: "hidden" }}>

      {/* ── Header ── */}
      <div style={{ background: C.teal, padding: "10px 14px", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        <button onClick={onBack} style={{ background: "rgba(255,255,255,0.15)", border: "none", borderRadius: 8, padding: 7, cursor: "pointer", display: "flex" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
        </button>
        <div style={{ flex: 1, color: "#fff", fontWeight: 700, fontSize: 16 }}>Prise de commande</div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => setTab(tab === "rules" ? "order" : "rules")}
            style={{ background: tab === "rules" ? "#fff" : "rgba(255,255,255,0.15)", border: "none", borderRadius: 8, padding: "6px 10px", cursor: "pointer", fontSize: 12, fontWeight: 600, color: tab === "rules" ? C.teal : "#fff" }}>
            ⚙️ Règles
          </button>
          <button onClick={() => setCartOpen(!cartOpen)} style={{ position: "relative" as const, background: cartCount > 0 ? C.orange : "rgba(255,255,255,0.15)", border: "none", borderRadius: 8, padding: "6px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, color: "#fff" }}>
            🛒 {cartCount > 0 ? cartCount : ""}
            {freeTotal > 0 && <span style={{ background: C.green, borderRadius: 6, padding: "1px 5px", fontSize: 10 }}>+{freeTotal} offerts</span>}
          </button>
        </div>
      </div>

      {/* ── Onglet Règles ── */}
      {tab === "rules" && (
        <RulesTab rules={rules} setRules={(r) => { setRules(r); saveRules(r); }} onClose={() => setTab("order")} />
      )}

      {/* ── Onglet Commande ── */}
      {tab === "order" && (
        <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>

          {/* Sélection client */}
          {!client && (
            <ClientSelector
              search={clientSearch} setSearch={setClientSearch}
              results={clientResults} loading={clientLoading}
              onSelect={(c) => { setClient(c); setClientSearch(""); setClientResults([]); }}
            />
          )}

          {/* Catalogue + panier */}
          {client && (
            <>
              {/* Colonne catégories */}
              <div style={{ width: 120, background: C.white, borderRight: `1px solid ${C.border}`, overflowY: "auto" as const, flexShrink: 0 }}>
                <div style={{ padding: "8px 6px", fontSize: 9, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>Catégories</div>
                <button onClick={() => { setCatId(null); setProdSearch(""); loadProducts(null, ""); }}
                  style={{ width: "100%", padding: "8px 8px", background: catId === null ? C.tealSoft : "transparent", border: "none", borderLeft: catId === null ? `3px solid ${C.teal}` : "3px solid transparent", cursor: "pointer", textAlign: "left" as const, fontSize: 11, fontWeight: catId === null ? 700 : 400, color: catId === null ? C.teal : C.textSec, fontFamily: "inherit" }}>
                  Tous
                </button>
                {categories.map(cat => (
                  <button key={cat.id} onClick={() => { setCatId(cat.id); setProdSearch(""); }}
                    style={{ width: "100%", padding: "8px 8px", background: catId === cat.id ? C.tealSoft : "transparent", border: "none", borderLeft: catId === cat.id ? `3px solid ${C.teal}` : "3px solid transparent", cursor: "pointer", textAlign: "left" as const, fontSize: 11, fontWeight: catId === cat.id ? 700 : 400, color: catId === cat.id ? C.teal : C.textSec, fontFamily: "inherit", wordBreak: "break-word" as const }}>
                    {cat.name}
                  </button>
                ))}
              </div>

              {/* Catalogue produits */}
              <div style={{ flex: 1, display: "flex", flexDirection: "column" as const, overflow: "hidden", minWidth: 0 }}>
                {/* Barre client + recherche */}
                <div style={{ padding: "8px 10px", background: C.white, borderBottom: `1px solid ${C.border}`, display: "flex", gap: 8, alignItems: "center" }}>
                  <div style={{ background: C.tealSoft, borderRadius: 8, padding: "4px 10px", fontSize: 12, fontWeight: 700, color: C.teal, cursor: "pointer" }} onClick={() => setClient(null)}>
                    👤 {client.name} ✕
                  </div>
                  <input value={prodSearch} onChange={e => setProdSearch(e.target.value)}
                    placeholder="Rechercher un produit..."
                    style={{ flex: 1, padding: "7px 10px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", background: C.bg, color: C.text }} />
                </div>

                {/* Grille produits */}
                <div style={{ flex: 1, overflowY: "auto" as const, padding: 10 }}>
                  {prodLoading ? (
                    <div style={{ textAlign: "center", padding: 40, color: C.textMuted }}>Chargement…</div>
                  ) : products.length === 0 ? (
                    <div style={{ textAlign: "center", padding: 40, color: C.textMuted }}>
                      {catId ? "Sélectionne une catégorie" : "Aucun produit"}
                    </div>
                  ) : (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 8 }}>
                      {products.map(p => (
                        <ProductCard key={p.id} product={p} qty={cart[p.id]?.qty || 0} onQtyChange={(q) => setQty(p, q)} />
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Panel panier (slide-in) */}
              {cartOpen && (
                <CartPanel
                  cart={cart} freeItems={freeItems} total={cartTotal}
                  note={note} setNote={setNote}
                  onQtyChange={(p, q) => setQty(p, q)}
                  onValidate={handleValidate}
                  submitting={submitting}
                  onClose={() => setCartOpen(false)}
                  clientName={client.name}
                />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Sélection client ──────────────────────────────────────────────────────────
function ClientSelector({ search, setSearch, results, loading, onSelect }: {
  search: string; setSearch: (s: string) => void;
  results: any[]; loading: boolean; onSelect: (c: any) => void;
}) {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column" as const, alignItems: "center", justifyContent: "flex-start", padding: "40px 24px" }}>
      <div style={{ fontSize: 32, marginBottom: 8 }}>👤</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: C.text, marginBottom: 4 }}>Choisir un client</div>
      <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 24 }}>Recherche par nom ou référence</div>
      <input autoFocus value={search} onChange={e => setSearch(e.target.value)}
        placeholder="Nom du client..."
        style={{ width: "100%", maxWidth: 400, padding: "12px 14px", border: `1.5px solid ${C.border}`, borderRadius: 12, fontSize: 15, fontFamily: "inherit", background: C.white, color: C.text, marginBottom: 12 }} />
      {loading && <div style={{ color: C.textMuted, fontSize: 13 }}>Recherche…</div>}
      <div style={{ width: "100%", maxWidth: 400, display: "flex", flexDirection: "column" as const, gap: 6 }}>
        {results.map(c => (
          <button key={c.id} onClick={() => onSelect(c)}
            style={{ padding: "12px 14px", background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, cursor: "pointer", textAlign: "left" as const, fontFamily: "inherit", boxShadow: C.shadow }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{c.name}</div>
            <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
              {c.ref && <span style={{ marginRight: 8 }}>Réf: {c.ref}</span>}
              {c.city && <span>{c.city}</span>}
              {c.property_product_pricelist && <span style={{ marginLeft: 8, color: C.teal }}>• {c.property_product_pricelist[1]}</span>}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Carte produit ─────────────────────────────────────────────────────────────
function ProductCard({ product: p, qty, onQtyChange }: { product: any; qty: number; onQtyChange: (q: number) => void }) {
  const stock = Math.max(0, Math.round(p.virtual_available || 0));
  const inCart = qty > 0;
  return (
    <div style={{ background: C.white, border: `1.5px solid ${inCart ? C.teal : C.border}`, borderRadius: 12, padding: 10, boxShadow: inCart ? `0 0 0 2px ${C.tealSoft}` : C.shadow, transition: "all 0.15s" }}>
      {p.image_128 && (
        <img src={`data:image/png;base64,${p.image_128}`} alt="" style={{ width: "100%", height: 70, objectFit: "contain", marginBottom: 6 }} />
      )}
      <div style={{ fontSize: 10, color: C.textMuted, fontFamily: "monospace", marginBottom: 2 }}>{p.default_code}</div>
      <div style={{ fontSize: 12, fontWeight: 700, color: C.text, lineHeight: 1.3, marginBottom: 4, minHeight: 30 }}>{p.name}</div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 800, color: C.teal }}>
          {p.lst_price > 0 ? `${p.lst_price.toFixed(2)} €` : "—"}
        </span>
        <span style={{ fontSize: 10, color: stock > 0 ? C.green : C.red, fontWeight: 600 }}>
          {stock > 0 ? `${stock} dispo` : "rupture"}
        </span>
      </div>
      {/* Contrôle quantité */}
      <div style={{ display: "flex", alignItems: "center", gap: 0, background: C.bg, borderRadius: 8, overflow: "hidden" }}>
        <button onClick={() => onQtyChange(qty - 1)} style={{ flex: 1, padding: "6px 0", background: "none", border: "none", cursor: "pointer", fontSize: 16, color: qty > 0 ? C.red : C.textMuted, fontWeight: 700 }}>−</button>
        <span style={{ flex: 1, textAlign: "center" as const, fontSize: 14, fontWeight: 800, color: inCart ? C.teal : C.textMuted }}>{qty}</span>
        <button onClick={() => onQtyChange(qty + 1)} style={{ flex: 1, padding: "6px 0", background: "none", border: "none", cursor: "pointer", fontSize: 16, color: C.teal, fontWeight: 700 }}>+</button>
      </div>
    </div>
  );
}

// ── Panel panier ──────────────────────────────────────────────────────────────
function CartPanel({ cart, freeItems, total, note, setNote, onQtyChange, onValidate, submitting, onClose, clientName }: {
  cart: Record<number, CartItem>; freeItems: FreeItem[]; total: number;
  note: string; setNote: (n: string) => void;
  onQtyChange: (p: any, q: number) => void;
  onValidate: () => void; submitting: boolean;
  onClose: () => void; clientName: string;
}) {
  return (
    <div style={{ width: 300, minWidth: 280, background: C.white, borderLeft: `1px solid ${C.border}`, display: "flex", flexDirection: "column" as const, boxShadow: C.shadowLg }}>
      <div style={{ padding: "12px 14px", background: C.teal, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ color: "#fff", fontWeight: 700, fontSize: 14 }}>🛒 Panier</div>
          <div style={{ color: "rgba(255,255,255,0.8)", fontSize: 11 }}>{clientName}</div>
        </div>
        <button onClick={onClose} style={{ background: "rgba(255,255,255,0.15)", border: "none", borderRadius: 8, padding: 6, cursor: "pointer", color: "#fff", fontSize: 14 }}>✕</button>
      </div>

      <div style={{ flex: 1, overflowY: "auto" as const, padding: "10px 12px" }}>
        {/* Articles commandés */}
        {Object.values(cart).map(item => (
          <div key={item.product.id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, padding: "6px 8px", background: C.bg, borderRadius: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{item.product.name}</div>
              <div style={{ fontSize: 10, color: C.textMuted }}>{item.product.default_code} · {(item.qty * item.unitPrice).toFixed(2)} €</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
              <button onClick={() => onQtyChange(item.product, item.qty - 1)} style={{ width: 22, height: 22, borderRadius: 4, background: C.redSoft, border: "none", cursor: "pointer", color: C.red, fontSize: 14, fontWeight: 700 }}>−</button>
              <span style={{ fontSize: 13, fontWeight: 800, color: C.text, minWidth: 20, textAlign: "center" as const }}>{item.qty}</span>
              <button onClick={() => onQtyChange(item.product, item.qty + 1)} style={{ width: 22, height: 22, borderRadius: 4, background: C.tealSoft, border: "none", cursor: "pointer", color: C.teal, fontSize: 14, fontWeight: 700 }}>+</button>
            </div>
          </div>
        ))}

        {/* Articles gratuits */}
        {freeItems.length > 0 && (
          <div style={{ margin: "8px 0", padding: 8, background: C.greenSoft, border: `1px solid ${C.green}33`, borderRadius: 8 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.green, textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 6 }}>🎁 BC gratuit (séparé)</div>
            {freeItems.map((fi, i) => (
              <div key={i} style={{ fontSize: 11, color: C.green, marginBottom: 2 }}>
                <strong>{fi.qty}×</strong> {fi.product.name} <span style={{ opacity: 0.7 }}>({fi.ruleName})</span>
              </div>
            ))}
          </div>
        )}

        {/* Note */}
        <textarea value={note} onChange={e => setNote(e.target.value)}
          placeholder="Note interne (optionnel)..."
          rows={2}
          style={{ width: "100%", boxSizing: "border-box" as const, marginTop: 6, padding: "8px 10px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, fontFamily: "inherit", resize: "none" as const, background: C.bg }} />
      </div>

      {/* Total + valider */}
      <div style={{ padding: "12px 14px", borderTop: `1px solid ${C.border}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
          <span style={{ fontSize: 12, color: C.textMuted }}>Total indicatif HT</span>
          <span style={{ fontSize: 16, fontWeight: 800, color: C.teal }}>{total.toFixed(2)} €</span>
        </div>
        <button onClick={onValidate} disabled={submitting}
          style={{ width: "100%", padding: "13px 0", background: submitting ? C.border : C.teal, color: "#fff", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: submitting ? "default" : "pointer", fontFamily: "inherit" }}>
          {submitting ? "Création…" : `Créer le devis${freeItems.length > 0 ? " + BC gratuit" : ""}`}
        </button>
        <div style={{ fontSize: 10, color: C.textMuted, textAlign: "center" as const, marginTop: 6 }}>Prix Odoo appliqués à la création</div>
      </div>
    </div>
  );
}

// ── Onglet Règles ─────────────────────────────────────────────────────────────
function RulesTab({ rules, setRules, onClose }: { rules: FreeRule[]; setRules: (r: FreeRule[]) => void; onClose: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [triggerQty, setTriggerQty] = useState("10");
  const [freeQty, setFreeQty] = useState("1");
  const [allProducts, setAllProducts] = useState(true);
  const [productRefs, setProductRefs] = useState("");

  const openNew = () => { setEditId(null); setName(""); setTriggerQty("10"); setFreeQty("1"); setAllProducts(true); setProductRefs(""); setShowForm(true); };
  const openEdit = (r: FreeRule) => { setEditId(r.id); setName(r.name); setTriggerQty(String(r.triggerQty)); setFreeQty(String(r.freeQty)); setAllProducts(r.allProducts); setProductRefs(r.productRefs.join("\n")); setShowForm(true); };

  const save = () => {
    const refs = productRefs.split(/[\n,;]+/).map(r => r.trim()).filter(Boolean);
    const rule: FreeRule = { id: editId || genId(), name: name || `${triggerQty}+${freeQty} gratuits`, triggerQty: Number(triggerQty), freeQty: Number(freeQty), allProducts, productRefs: refs };
    if (editId) setRules(rules.map(r => r.id === editId ? rule : r));
    else setRules([...rules, rule]);
    setShowForm(false);
  };

  return (
    <div style={{ flex: 1, overflowY: "auto" as const, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <button onClick={onClose} style={{ background: C.bg, border: "none", borderRadius: 8, padding: 7, cursor: "pointer" }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
        </button>
        <div style={{ fontSize: 16, fontWeight: 700, color: C.text, flex: 1 }}>Règles de gratuité</div>
        {!showForm && <button onClick={openNew} style={{ padding: "7px 14px", background: C.teal, color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>+ Nouvelle règle</button>}
      </div>

      {showForm ? (
        <div style={{ background: C.white, border: `1.5px solid ${C.teal}`, borderRadius: 14, padding: 16, display: "flex", flexDirection: "column" as const, gap: 12 }}>
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.06em", display: "block", marginBottom: 4 }}>Nom de la règle</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Ex: 10+2 gratuits"
              style={{ width: "100%", boxSizing: "border-box" as const, padding: "9px 12px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 14, fontFamily: "inherit" }} />
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.06em", display: "block", marginBottom: 4 }}>Qté déclencheur</label>
              <input type="number" value={triggerQty} onChange={e => setTriggerQty(e.target.value)} min="1"
                style={{ width: "100%", boxSizing: "border-box" as const, padding: "9px 12px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 14, fontFamily: "inherit" }} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.06em", display: "block", marginBottom: 4 }}>Qté gratuite</label>
              <input type="number" value={freeQty} onChange={e => setFreeQty(e.target.value)} min="1"
                style={{ width: "100%", boxSizing: "border-box" as const, padding: "9px 12px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 14, fontFamily: "inherit" }} />
            </div>
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.06em", display: "block", marginBottom: 4 }}>S'applique à</label>
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              {[true, false].map(v => (
                <button key={String(v)} onClick={() => setAllProducts(v)}
                  style={{ flex: 1, padding: "8px 0", background: allProducts === v ? C.tealSoft : C.bg, border: `1px solid ${allProducts === v ? C.teal : C.border}`, borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: 600, color: allProducts === v ? C.teal : C.textSec, fontFamily: "inherit" }}>
                  {v ? "Tous les produits" : "Refs spécifiques"}
                </button>
              ))}
            </div>
            {!allProducts && (
              <textarea value={productRefs} onChange={e => setProductRefs(e.target.value)}
                placeholder={"REF001\nREF002"} rows={3}
                style={{ width: "100%", boxSizing: "border-box" as const, padding: "8px 10px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, fontFamily: "monospace", resize: "none" as const }} />
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setShowForm(false)} style={{ flex: 1, padding: "10px 0", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" }}>Annuler</button>
            <button onClick={save} style={{ flex: 2, padding: "10px 0", background: C.teal, color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 700, fontFamily: "inherit" }}>Enregistrer</button>
          </div>
        </div>
      ) : rules.length === 0 ? (
        <div style={{ textAlign: "center", padding: "40px 24px", color: C.textMuted }}>
          <div style={{ fontSize: 32, marginBottom: 10 }}>🎁</div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Aucune règle</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>Ex : 10 achetés → 2 offerts dans un BC séparé</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column" as const, gap: 8 }}>
          {rules.map(r => (
            <div key={r.id} style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14, display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 44, height: 44, borderRadius: 10, background: C.greenSoft, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>🎁</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{r.name}</div>
                <div style={{ fontSize: 12, color: C.textMuted }}>
                  À partir de <strong>{r.triggerQty}</strong> unités → <strong style={{ color: C.green }}>{r.freeQty} offerts</strong>
                  {r.allProducts ? " (tous produits)" : ` (${r.productRefs.length} refs)`}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={() => openEdit(r)} style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: "5px 10px", cursor: "pointer", fontSize: 12 }}>✏️</button>
                <button onClick={() => setRules(rules.filter(x => x.id !== r.id))} style={{ background: C.redSoft, border: `1px solid ${C.red}22`, borderRadius: 8, padding: "5px 10px", cursor: "pointer", fontSize: 12, color: C.red }}>🗑</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
