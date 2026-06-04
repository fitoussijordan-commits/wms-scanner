"use client";
import { useState, useRef, useEffect, useCallback } from "react";
import * as odoo from "@/lib/odoo";

// ── Couleurs ────────────────────────────────────────────────────────────────
const C = {
  bg: "#f8fafc", white: "#ffffff", text: "#1a1a2e", textSec: "#374151",
  textMuted: "#6b7280", border: "#e5e7eb",
  blue: "#3b82f6", blueSoft: "#eff6ff",
  green: "#22c55e", greenSoft: "#f0fdf4",
  red: "#ef4444", redSoft: "#fef2f2",
  orange: "#f97316", orangeSoft: "#fff7ed",
  purple: "#7c3aed", purpleSoft: "#f5f3ff",
  teal: "#0d9488", tealSoft: "#f0fdfa",
  shadow: "0 1px 4px rgba(0,0,0,0.07)",
  shadowMd: "0 4px 12px rgba(0,0,0,0.10)",
};

// ── Types ───────────────────────────────────────────────────────────────────
interface Offre {
  id: string;
  code: string;
  label: string;
  produits: string[]; // refs internes Odoo
}

interface ProduitCA {
  ref: string;
  name: string;
  productId: number;
  qtyVendue: number;
  ca: number;
}

interface DelegueCA {
  userId: number;
  name: string;
  qtyVendue: number;
  ca: number;
}

interface OffreAnalyse {
  offre: Offre;
  loading: boolean;
  error: string | null;
  caTotal: number;
  qtyTotal: number;
  produits: ProduitCA[];
  delegues: DelegueCA[];
  debugOrders?: { id: number; name: string }[];
}

interface Props {
  session: odoo.OdooSession;
  onBack: () => void;
  onToast: (msg: string, type?: "success" | "error" | "info") => void;
}

// ── LocalStorage helpers ─────────────────────────────────────────────────────
const LS_KEY = "wms_offres_config";

function loadOffres(): Offre[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveOffres(offres: Offre[]) {
  localStorage.setItem(LS_KEY, JSON.stringify(offres));
}

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

// ── Odoo: récupérer le CA d'une offre (le code offre EST un produit Odoo) ──────
async function fetchCAForOffre(session: odoo.OdooSession, offre: Offre): Promise<Omit<OffreAnalyse, "offre" | "loading">> {

  // 1. Trouver le produit Odoo par le code offre lui-même
  let offreProd = await odoo.searchRead(session, "product.product",
    [["default_code", "=ilike", offre.code.trim()]], ["id", "name", "default_code"], 1);
  if (!offreProd.length) offreProd = await odoo.searchRead(session, "product.product",
    [["default_code", "ilike", offre.code.trim()]], ["id", "name", "default_code"], 1);
  if (!offreProd.length) {
    return { caTotal: 0, qtyTotal: 0, produits: [], delegues: [], debugOrders: [], error: `Produit "${offre.code}" introuvable dans Odoo` };
  }

  const offreProductId = offreProd[0].id;

  // 2. Lignes de commande pour CE produit offre uniquement
  const lines = await odoo.searchRead(session, "sale.order.line",
    [
      ["product_id", "=", offreProductId],
      ["order_id.state", "in", ["sale", "done"]],
      ["display_type", "=", false],
      ["is_downpayment", "=", false],
    ],
    ["product_uom_qty", "price_subtotal", "state", "order_id"], 0
  );
  const activeLines = lines.filter((l: any) => l.state !== "cancel");

  const caTotal = activeLines.reduce((s: number, l: any) => s + (l.price_subtotal || 0), 0);
  const qtyTotal = activeLines.reduce((s: number, l: any) => s + (l.product_uom_qty || 0), 0);

  // 3. Debug : liste des commandes
  const debugOrderIds = Array.from(new Set(activeLines.map((l: any) => l.order_id[0]))) as number[];
  let debugOrders: { id: number; name: string }[] = [];
  if (debugOrderIds.length > 0) {
    const ords = await odoo.searchRead(session, "sale.order",
      [["id", "in", debugOrderIds]], ["id", "name"], debugOrderIds.length);
    debugOrders = ords.map((o: any) => ({ id: o.id, name: o.name }));
  }

  // 4. Agréger par délégué (user_id sur sale.order)
  let delegues: DelegueCA[] = [];
  if (debugOrderIds.length > 0) {
    const orders = await odoo.searchRead(session, "sale.order",
      [["id", "in", debugOrderIds]], ["id", "user_id"], debugOrderIds.length);
    const orderUserMap: Record<number, { userId: number; name: string }> = {};
    for (const o of orders) {
      if (o.user_id) orderUserMap[o.id] = { userId: o.user_id[0], name: o.user_id[1] };
    }
    const userMap: Record<number, { name: string; qty: number; ca: number }> = {};
    for (const l of activeLines) {
      const user = orderUserMap[l.order_id[0]];
      if (!user) continue;
      if (!userMap[user.userId]) userMap[user.userId] = { name: user.name, qty: 0, ca: 0 };
      userMap[user.userId].qty += l.product_uom_qty || 0;
      userMap[user.userId].ca += l.price_subtotal || 0;
    }
    delegues = Object.entries(userMap)
      .map(([uid, v]) => ({ userId: Number(uid), name: v.name, qtyVendue: v.qty, ca: v.ca }))
      .sort((a, b) => b.ca - a.ca);
  }

  // 5. Produits composants (depuis paramétrage) — affichage info uniquement
  const resolveComp = async (ref: string): Promise<ProduitCA | null> => {
    let prods = await odoo.searchRead(session, "product.product",
      [["default_code", "=ilike", ref.trim()]], ["id", "name", "default_code"], 1);
    if (!prods.length) prods = await odoo.searchRead(session, "product.product",
      [["default_code", "ilike", ref.trim()]], ["id", "name", "default_code"], 1);
    if (!prods.length) return null;
    return { ref, productId: prods[0].id, name: prods[0].name, qtyVendue: 0, ca: 0 };
  };
  const produits: ProduitCA[] = offre.produits.length
    ? (await Promise.all(offre.produits.map(resolveComp))).filter(Boolean) as ProduitCA[]
    : [];

  return { caTotal, qtyTotal, produits, delegues, debugOrders, error: null };
}


// ── Formatage ────────────────────────────────────────────────────────────────
function fmtCA(n: number) {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);
}

// ═══════════════════════════════════════════════════════════════════════════
// ONGLET PARAMÉTRAGE
// ═══════════════════════════════════════════════════════════════════════════
function ParametrageTab({ onToast }: { onToast: Props["onToast"] }) {
  const [offres, setOffres] = useState<Offre[]>([]);
  const [editId, setEditId] = useState<string | null>(null); // null = nouveau
  const [showForm, setShowForm] = useState(false);

  // Form state
  const [formCode, setFormCode] = useState("");
  const [formLabel, setFormLabel] = useState("");
  const [formProduits, setFormProduits] = useState(""); // un par ligne

  useEffect(() => { setOffres(loadOffres()); }, []);

  const openNew = () => {
    setEditId(null);
    setFormCode(""); setFormLabel(""); setFormProduits("");
    setShowForm(true);
  };

  const openEdit = (o: Offre) => {
    setEditId(o.id);
    setFormCode(o.code);
    setFormLabel(o.label);
    setFormProduits(o.produits.join("\n"));
    setShowForm(true);
  };

  const save = () => {
    const code = formCode.trim();
    const label = formLabel.trim();
    const produits = formProduits.split(/[\n\r,;]+/).map(r => r.trim()).filter(Boolean);
    if (!code) { onToast("Code offre requis", "error"); return; }
    if (!produits.length) { onToast("Au moins un produit requis", "error"); return; }

    let updated: Offre[];
    if (editId) {
      updated = offres.map(o => o.id === editId ? { ...o, code, label, produits } : o);
    } else {
      // Vérifier doublon code
      if (offres.some(o => o.code.toLowerCase() === code.toLowerCase())) {
        onToast("Ce code offre existe déjà", "error"); return;
      }
      updated = [...offres, { id: genId(), code, label, produits }];
    }
    saveOffres(updated);
    setOffres(updated);
    setShowForm(false);
    onToast(editId ? "Offre mise à jour" : "Offre créée", "success");
  };

  const deleteOffre = (id: string) => {
    if (!confirm("Supprimer cette offre ?")) return;
    const updated = offres.filter(o => o.id !== id);
    saveOffres(updated);
    setOffres(updated);
    onToast("Offre supprimée", "info");
  };

  if (showForm) {
    return (
      <div style={{ padding: "0 0 40px" }}>
        {/* Header form */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
          <button onClick={() => setShowForm(false)} style={{ background: C.bg, border: "none", borderRadius: 10, padding: 8, cursor: "pointer", display: "flex" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
          </button>
          <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{editId ? "Modifier l'offre" : "Nouvelle offre"}</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" as const, gap: 14 }}>
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.06em", display: "block", marginBottom: 6 }}>Code offre *</label>
            <input value={formCode} onChange={e => setFormCode(e.target.value)} placeholder="Ex: 7131482"
              style={{ width: "100%", boxSizing: "border-box" as const, padding: "10px 12px", border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit", background: C.bg, color: C.text }} />
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.06em", display: "block", marginBottom: 6 }}>Libellé (optionnel)</label>
            <input value={formLabel} onChange={e => setFormLabel(e.target.value)} placeholder="Ex: Offre été 2024"
              style={{ width: "100%", boxSizing: "border-box" as const, padding: "10px 12px", border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit", background: C.bg, color: C.text }} />
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.06em", display: "block", marginBottom: 6 }}>
              Références produits *
              <span style={{ fontWeight: 400, textTransform: "none" as const, marginLeft: 6 }}>— une par ligne (ou virgule / point-virgule)</span>
            </label>
            <textarea
              value={formProduits}
              onChange={e => setFormProduits(e.target.value)}
              placeholder={"REF001\nREF002\nREF003"}
              rows={6}
              style={{ width: "100%", boxSizing: "border-box" as const, padding: "10px 12px", border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 13, fontFamily: "monospace", background: C.bg, color: C.text, resize: "vertical" as const }}
            />
            <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>
              {formProduits.split(/[\n\r,;]+/).filter(r => r.trim()).length} produit(s) saisi(s)
            </div>
          </div>
        </div>

        <button onClick={save} style={{ marginTop: 20, width: "100%", padding: "13px 0", background: C.blue, color: "#fff", border: "none", borderRadius: 12, fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
          {editId ? "Enregistrer les modifications" : "Créer l'offre"}
        </button>
      </div>
    );
  }

  return (
    <div style={{ paddingBottom: 40 }}>
      <button onClick={openNew} style={{ width: "100%", padding: "12px 0", background: C.blue, color: "#fff", border: "none", borderRadius: 12, fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Nouvelle offre
      </button>

      {offres.length === 0 ? (
        <div style={{ textAlign: "center", padding: "40px 24px", color: C.textMuted }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>🗂️</div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Aucune offre configurée</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>Crée une offre et associe-lui ses références produits</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column" as const, gap: 10 }}>
          {offres.map(o => (
            <div key={o.id} style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 14, padding: 14, boxShadow: C.shadow }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" as const }}>
                    <span style={{ fontSize: 15, fontWeight: 800, color: C.text, fontFamily: "monospace" }}>{o.code}</span>
                    {o.label && <span style={{ fontSize: 12, color: C.textMuted }}>{o.label}</span>}
                  </div>
                  <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap" as const, gap: 4 }}>
                    {o.produits.map(p => (
                      <span key={p} style={{ fontSize: 11, fontFamily: "monospace", background: C.blueSoft, color: C.blue, borderRadius: 6, padding: "2px 7px", fontWeight: 600 }}>{p}</span>
                    ))}
                  </div>
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 6 }}>{o.produits.length} produit(s)</div>
                </div>
                <div style={{ display: "flex", gap: 6, marginLeft: 10, flexShrink: 0 }}>
                  <button onClick={() => openEdit(o)} style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: "6px 10px", cursor: "pointer", fontSize: 12, color: C.textSec }}>✏️</button>
                  <button onClick={() => deleteOffre(o.id)} style={{ background: C.redSoft, border: `1px solid ${C.red}22`, borderRadius: 8, padding: "6px 10px", cursor: "pointer", fontSize: 12, color: C.red }}>🗑</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ONGLET ANALYSE
// ═══════════════════════════════════════════════════════════════════════════
function AnalyseTab({ session, onToast }: { session: odoo.OdooSession; onToast: Props["onToast"] }) {
  const [configOffres, setConfigOffres] = useState<Offre[]>([]);
  const [results, setResults] = useState<OffreAnalyse[]>([]);
  const [inputVal, setInputVal] = useState("");
  const [globalLoading, setGlobalLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailMode, setDetailMode] = useState<Record<string, "produits" | "delegues" | "debug">>({});
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setConfigOffres(loadOffres()); }, []);

  const findOffre = useCallback((code: string): Offre | null => {
    return configOffres.find(o => o.code.toLowerCase() === code.trim().toLowerCase()) || null;
  }, [configOffres]);

  const addCodes = async (raw: string) => {
    const codes = raw.split(/[\n\r,;]+/).map(r => r.trim()).filter(Boolean);
    if (!codes.length) return;

    const currentCodes = results.map(r => r.offre.code.toLowerCase());
    const newCodes = codes.filter(c => !currentCodes.includes(c.toLowerCase()));
    const skipped = codes.length - newCodes.length;

    if (!newCodes.length) {
      onToast("Offres déjà analysées", "info");
      setInputVal("");
      return;
    }

    // Vérifier que les offres existent dans le paramétrage
    const notFound = newCodes.filter(c => !findOffre(c));
    if (notFound.length) {
      onToast(`Non configuré(es): ${notFound.join(", ")} — va dans Paramétrage`, "error");
      const found = newCodes.filter(c => findOffre(c));
      if (!found.length) { setInputVal(""); return; }
    }

    const validCodes = newCodes.filter(c => findOffre(c));
    const placeholders: OffreAnalyse[] = validCodes.map(code => ({
      offre: findOffre(code)!,
      loading: true, error: null, caTotal: 0, qtyTotal: 0, produits: [], delegues: []
    }));

    setResults(prev => [...prev, ...placeholders]);
    setInputVal("");

    await Promise.all(validCodes.map(async code => {
      const offre = findOffre(code)!;
      try {
        const data = await fetchCAForOffre(session, offre);
        setResults(prev => prev.map(r => r.offre.code === code ? { ...r, ...data, loading: false } : r));
      } catch (e: any) {
        setResults(prev => prev.map(r => r.offre.code === code ? { ...r, loading: false, error: e.message || "Erreur Odoo" } : r));
      }
    }));

    if (validCodes.length > 1) onToast(`${validCodes.length} offres analysées`, "success");
    inputRef.current?.focus();
  };

  const removeResult = (code: string) => setResults(prev => prev.filter(r => r.offre.code !== code));

  const refreshAll = async () => {
    setGlobalLoading(true);
    setResults(prev => prev.map(r => ({ ...r, loading: true, error: null, delegues: [] })));
    await Promise.all(results.map(async r => {
      try {
        const data = await fetchCAForOffre(session, r.offre);
        setResults(prev => prev.map(x => x.offre.code === r.offre.code ? { ...x, ...data, loading: false } : x));
      } catch (e: any) {
        setResults(prev => prev.map(x => x.offre.code === r.offre.code ? { ...x, loading: false, error: e.message || "Erreur" } : x));
      }
    }));
    setGlobalLoading(false);
    onToast("Données actualisées", "success");
  };

  const totalCA = results.filter(r => !r.loading && !r.error).reduce((s, r) => s + r.caTotal, 0);
  const totalQty = results.filter(r => !r.loading && !r.error).reduce((s, r) => s + r.qtyTotal, 0);
  const hasResults = results.some(r => !r.loading && !r.error);

  const allOffres = configOffres.filter(o => !results.some(r => r.offre.id === o.id));

  return (
    <div style={{ paddingBottom: 40 }}>
      {/* Saisie */}
      <div style={{ background: C.white, border: `1.5px solid ${C.blue}`, borderRadius: 14, padding: 14, marginBottom: 16, boxShadow: `0 0 0 3px ${C.blueSoft}` }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.blue, textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 10 }}>Ajouter une offre à analyser</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            ref={inputRef}
            value={inputVal}
            onChange={e => setInputVal(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") addCodes(inputVal); }}
            onPaste={e => {
              const pasted = e.clipboardData.getData("text");
              if (/[\n\r,;]/.test(pasted)) { e.preventDefault(); addCodes(pasted); }
            }}
            placeholder="Code offre (ex: 7131482)…"
            autoFocus
            style={{ flex: 1, padding: "10px 12px", border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit", background: C.bg, color: C.text, outline: "none" }}
          />
          <button onClick={() => addCodes(inputVal)} disabled={!inputVal.trim()}
            style={{ padding: "10px 16px", background: inputVal.trim() ? C.blue : C.border, color: inputVal.trim() ? "#fff" : C.textMuted, border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: inputVal.trim() ? "pointer" : "default", fontFamily: "inherit" }}>
            + Ajouter
          </button>
        </div>

        {/* Suggestions depuis le paramétrage */}
        {allOffres.length > 0 && (
          <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap" as const, gap: 6 }}>
            {allOffres.map(o => (
              <button key={o.id} onClick={() => addCodes(o.code)}
                style={{ padding: "4px 10px", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", color: C.text, fontFamily: "inherit" }}>
                {o.code}{o.label ? ` · ${o.label}` : ""}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Totaux */}
      {hasResults && (
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <div style={{ flex: 2, background: C.tealSoft, border: `1px solid ${C.teal}22`, borderRadius: 12, padding: "12px 14px" }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.teal, textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 4 }}>CA Total</div>
            <div style={{ fontSize: 24, fontWeight: 800, color: C.teal }}>{fmtCA(totalCA)}</div>
          </div>
          <div style={{ flex: 1, background: C.orangeSoft, border: `1px solid ${C.orange}22`, borderRadius: 12, padding: "12px 14px" }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.orange, textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 4 }}>Qté vendue</div>
            <div style={{ fontSize: 24, fontWeight: 800, color: C.orange }}>{Math.round(totalQty)}</div>
          </div>
          {results.filter(r => !r.loading && !r.error).length > 1 && (
            <button onClick={refreshAll} disabled={globalLoading}
              style={{ padding: "0 12px", background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, cursor: "pointer", color: C.textMuted, flexShrink: 0, display: "flex", alignItems: "center" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>
              </svg>
            </button>
          )}
        </div>
      )}

      {/* Résultats */}
      {results.length === 0 ? (
        configOffres.length === 0 ? (
          <div style={{ textAlign: "center", padding: "40px 24px", color: C.textMuted }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>⚙️</div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Aucune offre configurée</div>
            <div style={{ fontSize: 12, marginTop: 4 }}>Va dans l'onglet Paramétrage pour créer tes offres</div>
          </div>
        ) : (
          <div style={{ textAlign: "center", padding: "40px 24px", color: C.textMuted }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>📊</div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Ajoute une offre pour voir son CA</div>
            <div style={{ fontSize: 12, marginTop: 4 }}>Tape le code ou clique sur une suggestion ci-dessus</div>
          </div>
        )
      ) : (
        <div style={{ display: "flex", flexDirection: "column" as const, gap: 10 }}>
          {results.map(r => {
            const isExpanded = expandedId === r.offre.id;
            return (
              <div key={r.offre.id} style={{ background: C.white, border: `1px solid ${r.error ? C.red : C.border}`, borderRadius: 14, overflow: "hidden", boxShadow: C.shadow }}>
                {/* En-tête carte */}
                <div style={{ padding: 14 }}>
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: r.loading || r.error ? 0 : 12 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 15, fontWeight: 800, color: C.text, fontFamily: "monospace" }}>{r.offre.code}</div>
                      {r.offre.label && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 1 }}>{r.offre.label}</div>}
                      <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{r.offre.produits.length} produit(s)</div>
                    </div>
                    <button onClick={() => removeResult(r.offre.code)}
                      style={{ background: "none", border: "none", cursor: "pointer", color: C.textMuted, padding: 4, marginLeft: 8 }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                  </div>

                  {r.loading && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, color: C.textMuted, fontSize: 12, paddingTop: 4 }}>
                      <div style={{ width: 12, height: 12, borderRadius: 6, border: `2px solid ${C.blue}`, borderTopColor: "transparent", animation: "spin 0.8s linear infinite" }} />
                      Calcul du CA en cours…
                    </div>
                  )}

                  {!r.loading && r.error && (
                    <div style={{ color: C.red, fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                      {r.error}
                    </div>
                  )}

                  {!r.loading && !r.error && (
                    <>
                      <div style={{ display: "flex", gap: 8 }}>
                        <div style={{ flex: 2, background: C.tealSoft, borderRadius: 10, padding: "10px 12px" }}>
                          <div style={{ fontSize: 9, fontWeight: 700, color: C.teal, textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>CA généré</div>
                          <div style={{ fontSize: 20, fontWeight: 800, color: C.teal, marginTop: 2 }}>{fmtCA(r.caTotal)}</div>
                        </div>
                        <div style={{ flex: 1, background: C.orangeSoft, borderRadius: 10, padding: "10px 12px" }}>
                          <div style={{ fontSize: 9, fontWeight: 700, color: C.orange, textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>Qté vendue</div>
                          <div style={{ fontSize: 20, fontWeight: 800, color: C.orange, marginTop: 2 }}>{Math.round(r.qtyTotal)}</div>
                        </div>
                      </div>

                      {/* Toggles détail */}
                      {(r.produits.length > 0 || r.delegues.length > 0) && (
                        <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap" as const }}>
                          <button onClick={() => {
                            if (isExpanded && detailMode[r.offre.id] === "produits") { setExpandedId(null); }
                            else { setExpandedId(r.offre.id); setDetailMode(m => ({ ...m, [r.offre.id]: "produits" })); }
                          }} style={{ flex: 1, padding: "8px 0", background: isExpanded && detailMode[r.offre.id] === "produits" ? C.blueSoft : C.bg, border: `1px solid ${isExpanded && detailMode[r.offre.id] === "produits" ? C.blue : C.border}`, borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: 600, color: isExpanded && detailMode[r.offre.id] === "produits" ? C.blue : C.textSec, fontFamily: "inherit" }}>
                            📦 Produits ({r.produits.length})
                          </button>
                          <button onClick={() => {
                            if (isExpanded && detailMode[r.offre.id] === "delegues") { setExpandedId(null); }
                            else { setExpandedId(r.offre.id); setDetailMode(m => ({ ...m, [r.offre.id]: "delegues" })); }
                          }} style={{ flex: 1, padding: "8px 0", background: isExpanded && detailMode[r.offre.id] === "delegues" ? C.purpleSoft : C.bg, border: `1px solid ${isExpanded && detailMode[r.offre.id] === "delegues" ? C.purple : C.border}`, borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: 600, color: isExpanded && detailMode[r.offre.id] === "delegues" ? C.purple : C.textSec, fontFamily: "inherit" }}>
                            👤 Délégués ({r.delegues.length})
                          </button>
                          <button onClick={() => {
                            if (isExpanded && detailMode[r.offre.id] === "debug") { setExpandedId(null); }
                            else { setExpandedId(r.offre.id); setDetailMode(m => ({ ...m, [r.offre.id]: "debug" })); }
                          }} style={{ flex: 1, padding: "8px 0", background: isExpanded && detailMode[r.offre.id] === "debug" ? C.orangeSoft : C.bg, border: `1px solid ${isExpanded && detailMode[r.offre.id] === "debug" ? C.orange : C.border}`, borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: 600, color: isExpanded && detailMode[r.offre.id] === "debug" ? C.orange : C.textSec, fontFamily: "inherit" }}>
                            🔍 Commandes ({r.debugOrders?.length ?? 0})
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>

                {/* Détail par produit */}
                {!r.loading && !r.error && isExpanded && detailMode[r.offre.id] === "produits" && (
                  <div style={{ borderTop: `1px solid ${C.border}`, background: C.bg }}>
                    {r.produits.map((p, i) => (
                      <div key={p.productId} style={{ padding: "10px 14px", borderBottom: i < r.produits.length - 1 ? `1px solid ${C.border}` : undefined, display: "flex", alignItems: "center", gap: 10 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: C.text, fontFamily: "monospace" }}>{p.ref}</div>
                          <div style={{ fontSize: 11, color: C.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{p.name}</div>
                        </div>
                        <div style={{ textAlign: "right" as const, flexShrink: 0 }}>
                          <div style={{ fontSize: 14, fontWeight: 800, color: C.teal }}>{fmtCA(p.ca)}</div>
                          <div style={{ fontSize: 11, color: C.textMuted }}>{Math.round(p.qtyVendue)} unités</div>
                        </div>
                        <div style={{ width: 40, height: 32, display: "flex", alignItems: "flex-end" }}>
                          <div style={{ width: "100%", height: `${Math.max(4, (p.ca / (r.caTotal || 1)) * 32)}px`, background: C.teal, borderRadius: 3, opacity: 0.7 }} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Liste commandes (debug) */}
                {!r.loading && !r.error && isExpanded && detailMode[r.offre.id] === "debug" && (
                  <div style={{ borderTop: `1px solid ${C.border}`, background: C.bg, padding: "12px 14px" }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: C.orange, textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 8 }}>
                      {r.debugOrders?.length} commandes incluses — compare avec Odoo pour trouver l'écart
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 5 }}>
                      {(r.debugOrders ?? []).sort((a, b) => a.name.localeCompare(b.name)).map(o => (
                        <span key={o.id} style={{ fontSize: 11, fontFamily: "monospace", background: C.white, border: `1px solid ${C.border}`, borderRadius: 6, padding: "3px 8px", color: C.textSec }}>
                          {o.name}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Détail par délégué */}
                {!r.loading && !r.error && isExpanded && detailMode[r.offre.id] === "delegues" && (
                  <div style={{ borderTop: `1px solid ${C.border}`, background: C.bg }}>
                    {r.delegues.length === 0 ? (
                      <div style={{ padding: "16px 14px", color: C.textMuted, fontSize: 12, textAlign: "center" as const }}>Aucun délégué trouvé</div>
                    ) : r.delegues.map((d, i) => (
                      <div key={d.userId} style={{ padding: "10px 14px", borderBottom: i < r.delegues.length - 1 ? `1px solid ${C.border}` : undefined, display: "flex", alignItems: "center", gap: 10 }}>
                        {/* Avatar initiales */}
                        <div style={{ width: 32, height: 32, borderRadius: 16, background: C.purpleSoft, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                          <span style={{ fontSize: 12, fontWeight: 800, color: C.purple }}>
                            {d.name.split(" ").map((n: string) => n[0]).slice(0, 2).join("").toUpperCase()}
                          </span>
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{d.name}</div>
                          <div style={{ fontSize: 11, color: C.textMuted }}>{Math.round(d.qtyVendue)} unités</div>
                        </div>
                        <div style={{ textAlign: "right" as const, flexShrink: 0 }}>
                          <div style={{ fontSize: 14, fontWeight: 800, color: C.purple }}>{fmtCA(d.ca)}</div>
                          <div style={{ fontSize: 10, color: C.textMuted }}>{Math.round((d.ca / (r.caTotal || 1)) * 100)}% du CA</div>
                        </div>
                        {/* Barre proportionnelle */}
                        <div style={{ width: 40, height: 32, display: "flex", alignItems: "flex-end" }}>
                          <div style={{ width: "100%", height: `${Math.max(4, (d.ca / (r.caTotal || 1)) * 32)}px`, background: C.purple, borderRadius: 3, opacity: 0.6 }} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPOSANT PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════════
export default function AnalyseScreen({ session, onBack, onToast }: Props) {
  const [tab, setTab] = useState<"analyse" | "parametrage">("analyse");

  return (
    <div style={{ padding: "20px 16px", maxWidth: 480, margin: "0 auto", fontFamily: "'DM Sans', sans-serif" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <button onClick={onBack} style={{ background: C.bg, border: "none", borderRadius: 10, padding: 8, cursor: "pointer", display: "flex" }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
        </button>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>Analyse offres</div>
          <div style={{ fontSize: 12, color: C.textMuted }}>CA généré par offre via Odoo</div>
        </div>
      </div>

      {/* Onglets */}
      <div style={{ display: "flex", gap: 6, marginBottom: 20, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, padding: 4 }}>
        {([["analyse", "📊 Analyse"], ["parametrage", "⚙️ Paramétrage"]] as const).map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            style={{ flex: 1, padding: "9px 0", border: "none", borderRadius: 9, cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 700, transition: "all 0.15s",
              background: tab === key ? C.white : "transparent",
              color: tab === key ? C.text : C.textMuted,
              boxShadow: tab === key ? C.shadow : "none" }}>
            {label}
          </button>
        ))}
      </div>

      {tab === "analyse" ? (
        <AnalyseTab session={session} onToast={onToast} />
      ) : (
        <ParametrageTab onToast={onToast} />
      )}
    </div>
  );
}
