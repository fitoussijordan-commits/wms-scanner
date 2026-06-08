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
  codeInterne?: string; // code recherché dans x_note_interne
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
  debugOrders?: { id: number; name: string; partnerName?: string }[];
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

// ── Odoo: récupérer le CA d'une offre ──────────────────────────────────────────
// L'offre est un produit "marqueur" dans la commande (souvent à 0€).
// On trouve les commandes via ce produit, puis on somme le CA des composants.
type StateFilter = "all" | "avenir" | "valide";
function statesDomain(filter: StateFilter): string[] {
  if (filter === "avenir") return ["sale"];
  if (filter === "valide") return ["done"];
  return ["sale", "done"];
}

async function fetchCAForOffre(session: odoo.OdooSession, offre: Offre, filter: StateFilter = "all"): Promise<Omit<OffreAnalyse, "offre" | "loading">> {
  const states = statesDomain(filter);

  // 1. Trouver le produit Odoo correspondant au code offre
  let offreProd = await odoo.searchRead(session, "product.product",
    [["default_code", "=ilike", offre.code.trim()]], ["id", "name", "default_code"], 1);
  if (!offreProd.length) offreProd = await odoo.searchRead(session, "product.product",
    [["default_code", "ilike", offre.code.trim()]], ["id", "name", "default_code"], 1);
  if (!offreProd.length) {
    return { caTotal: 0, qtyTotal: 0, produits: [], delegues: [], debugOrders: [], error: `Produit "${offre.code}" introuvable dans Odoo` };
  }
  const offreProductId = offreProd[0].id;

  // 2a. Commandes via lignes contenant le produit offre
  const offreLines = await odoo.searchRead(session, "sale.order.line",
    [
      ["product_id", "=", offreProductId],
      ["order_id.state", "in", states],
      ["display_type", "=", false],
      ["is_downpayment", "=", false],
    ],
    ["order_id", "product_uom_qty", "state"], 0
  );
  const activeOffreLines = offreLines.filter((l: any) => l.state !== "cancel");
  const orderIdsFromLines = new Set<number>(activeOffreLines.map((l: any) => l.order_id[0] as number));

  // Offres individuelles = uniquement via lignes produit (pas de note)
  const orderIds = Array.from(orderIdsFromLines) as number[];
  const qtyTotal = activeOffreLines.reduce((s: number, l: any) => s + (l.product_uom_qty || 0), 0);
  const noteOnlyOrderIds: number[] = [];

  if (!orderIds.length) {
    return { caTotal: 0, qtyTotal: 0, produits: [], delegues: [], debugOrders: [], error: null };
  }

  // 3. Debug : liste des commandes (avec tag source)
  const ords = await odoo.searchRead(session, "sale.order",
    [["id", "in", orderIds]], ["id", "name", "partner_id"], orderIds.length);
  const debugOrders: { id: number; name: string; partnerName?: string }[] = ords.map((o: any) => ({
    id: o.id,
    name: noteOnlyOrderIds.includes(o.id) ? `${o.name} (note)` : o.name,
    partnerName: o.partner_id ? o.partner_id[1] : undefined,
  }));

  // 4. Résoudre les produits composants (paramétrage)
  const resolveComp = async (ref: string): Promise<{ ref: string; productId: number; name: string } | null> => {
    let prods = await odoo.searchRead(session, "product.product",
      [["default_code", "=ilike", ref.trim()]], ["id", "name", "default_code"], 1);
    if (!prods.length) prods = await odoo.searchRead(session, "product.product",
      [["default_code", "ilike", ref.trim()]], ["id", "name", "default_code"], 1);
    if (!prods.length) return null;
    return { ref, productId: prods[0].id, name: prods[0].name };
  };
  const resolved = offre.produits.length
    ? (await Promise.all(offre.produits.map(resolveComp))).filter(Boolean) as { ref: string; productId: number; name: string }[]
    : [];

  // 5. CA des composants dans ces commandes
  let produits: ProduitCA[] = resolved.map(r => ({ ...r, qtyVendue: 0, ca: 0 }));
  let caTotal = 0;

  if (resolved.length > 0) {
    const compIds = resolved.map(r => r.productId);
    const compLines = await odoo.searchRead(session, "sale.order.line",
      [
        ["order_id", "in", orderIds],
        ["product_id", "in", compIds],
        ["display_type", "=", false],
        ["is_downpayment", "=", false],
      ],
      ["product_id", "product_uom_qty", "price_subtotal", "state"], 0
    );
    const activeComp = compLines.filter((l: any) => l.state !== "cancel");

    const prodMap: Record<number, { qty: number; ca: number }> = {};
    for (const l of activeComp) {
      const pid = l.product_id[0];
      if (!prodMap[pid]) prodMap[pid] = { qty: 0, ca: 0 };
      prodMap[pid].qty += l.product_uom_qty || 0;
      prodMap[pid].ca += l.price_subtotal || 0;
    }
    produits = resolved.map(r => ({
      ...r,
      qtyVendue: prodMap[r.productId]?.qty || 0,
      ca: prodMap[r.productId]?.ca || 0,
    }));
    caTotal = produits.reduce((s, p) => s + p.ca, 0);
  }

  // 6. Agréger par délégué
  const orders = await odoo.searchRead(session, "sale.order",
    [["id", "in", orderIds]], ["id", "user_id"], orderIds.length);
  const orderUserMap: Record<number, { userId: number; name: string }> = {};
  for (const o of orders) {
    if (o.user_id) orderUserMap[o.id] = { userId: o.user_id[0], name: o.user_id[1] };
  }
  const userMap: Record<number, { name: string; qty: number; ca: number }> = {};
  for (const l of activeOffreLines) {
    const user = orderUserMap[l.order_id[0]];
    if (!user) continue;
    if (!userMap[user.userId]) userMap[user.userId] = { name: user.name, qty: 0, ca: 0 };
    userMap[user.userId].qty += l.product_uom_qty || 0;
  }
  // Ajouter le CA composants aux délégués
  if (resolved.length > 0) {
    const compLines2 = await odoo.searchRead(session, "sale.order.line",
      [["order_id", "in", orderIds], ["product_id", "in", resolved.map(r => r.productId)],
       ["display_type", "=", false], ["is_downpayment", "=", false]],
      ["order_id", "price_subtotal", "state"], 0
    );
    for (const l of compLines2.filter((l: any) => l.state !== "cancel")) {
      const user = orderUserMap[l.order_id[0]];
      if (!user) continue;
      if (!userMap[user.userId]) userMap[user.userId] = { name: user.name, qty: 0, ca: 0 };
      userMap[user.userId].ca += l.price_subtotal || 0;
    }
  }
  const delegues: DelegueCA[] = Object.entries(userMap)
    .map(([uid, v]) => ({ userId: Number(uid), name: v.name, qtyVendue: v.qty, ca: v.ca }))
    .sort((a, b) => b.ca - a.ca);

  return { caTotal, qtyTotal, produits, delegues, debugOrders, error: null };
}

// Catch-all : commandes avec codeInterne dans la note mais PAS dans les offres listées
async function fetchCatchall(
  session: odoo.OdooSession,
  codeInterne: string,
  excludeOrderIds: number[],
  excludeOfferCodes: string[],
  filter: StateFilter
): Promise<Omit<OffreAnalyse, "offre" | "loading">> {
  const states = statesDomain(filter);
  const noteOrders = await odoo.searchRead(session, "sale.order",
    [["x_note_interne", "ilike", codeInterne.trim()], ["state", "in", states]],
    ["id", "name", "user_id", "partner_id"], 0
  );
  const excludeSet = new Set(excludeOrderIds);
  let orphans = noteOrders.filter((o: any) => !excludeSet.has(o.id));

  // Double-protection : exclure aussi les commandes qui ont une ligne avec un produit offre connu
  // (évite les doublons quand la ligne offre est annulée ou filtrée côté offre principale)
  if (orphans.length > 0 && excludeOfferCodes.length > 0) {
    const orphanIds = orphans.map((o: any) => o.id as number);
    // Étape 1 : résoudre les codes → IDs produits (domain direct, pas de traversée relationnelle)
    const offerProds = await odoo.searchRead(session, "product.product",
      [["default_code", "in", excludeOfferCodes]],
      ["id"], 0
    );
    const offerProdIds = offerProds.map((p: any) => p.id as number);
    if (offerProdIds.length > 0) {
      // Étape 2 : commandes orphelines qui ont une ligne avec ce produit
      const offerLines = await odoo.searchRead(session, "sale.order.line",
        [["order_id", "in", orphanIds], ["product_id", "in", offerProdIds], ["display_type", "=", false]],
        ["order_id"], 0
      );
      const ordersWithOfferLines = new Set(offerLines.map((l: any) => l.order_id[0] as number));
      orphans = orphans.filter((o: any) => !ordersWithOfferLines.has(o.id));
    }
  }
  if (!orphans.length) return { caTotal: 0, qtyTotal: 0, produits: [], delegues: [], debugOrders: [], error: null };

  const orphanIds = orphans.map((o: any) => o.id as number);
  const debugOrders = orphans.map((o: any) => ({ id: o.id, name: `${o.name} (note)`, partnerName: o.partner_id ? o.partner_id[1] : undefined }));

  const lines = await odoo.searchRead(session, "sale.order.line",
    [["order_id", "in", orphanIds], ["display_type", "=", false], ["is_downpayment", "=", false]],
    ["order_id", "product_id", "product_uom_qty", "price_subtotal", "state"], 0
  );
  const activeLines = lines.filter((l: any) => l.state !== "cancel"
    && l.price_subtotal > 0  // exclure les lignes gratuites (offres marqueurs)
  );
  const caTotal = activeLines.reduce((s: number, l: any) => s + (l.price_subtotal || 0), 0);

  // Agrégation par produit
  const prodMap: Record<number, { name: string; ref: string; qty: number; ca: number }> = {};
  for (const l of activeLines) {
    if (!l.product_id) continue;
    const pid = l.product_id[0];
    if (!prodMap[pid]) prodMap[pid] = { name: l.product_id[1], ref: l.product_id[1], qty: 0, ca: 0 };
    prodMap[pid].qty += l.product_uom_qty || 0;
    prodMap[pid].ca += l.price_subtotal || 0;
  }
  const produits: ProduitCA[] = Object.entries(prodMap)
    .map(([pid, v]) => ({ productId: Number(pid), ref: v.ref, name: v.name, qtyVendue: v.qty, ca: v.ca }))
    .sort((a, b) => b.ca - a.ca);

  // Agrégation par délégué
  const userMap: Record<number, { name: string; qty: number; ca: number }> = {};
  for (const o of orphans) {
    if (!o.user_id) continue;
    const uid = o.user_id[0];
    if (!userMap[uid]) userMap[uid] = { name: o.user_id[1], qty: 0, ca: 0 };
  }
  for (const l of activeLines) {
    const o = orphans.find((x: any) => x.id === l.order_id[0]);
    if (!o?.user_id) continue;
    const uid = o.user_id[0];
    if (userMap[uid]) { userMap[uid].qty += l.product_uom_qty || 0; userMap[uid].ca += l.price_subtotal || 0; }
  }
  const delegues: DelegueCA[] = Object.entries(userMap)
    .map(([uid, v]) => ({ userId: Number(uid), name: v.name, qtyVendue: v.qty, ca: v.ca }))
    .sort((a, b) => b.ca - a.ca);

  return { caTotal, qtyTotal: orphanIds.length, produits, delegues, debugOrders, error: null };
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
  const [formCodeInterne, setFormCodeInterne] = useState("");

  useEffect(() => { setOffres(loadOffres()); }, []);

  const openNew = () => {
    setEditId(null);
    setFormCode(""); setFormLabel(""); setFormProduits(""); setFormCodeInterne("");
    setShowForm(true);
  };

  const openEdit = (o: Offre) => {
    setEditId(o.id);
    setFormCode(o.code);
    setFormLabel(o.label);
    setFormProduits(o.produits.join("\n"));
    setFormCodeInterne(o.codeInterne || "");
    setShowForm(true);
  };

  const save = () => {
    const code = formCode.trim();
    const label = formLabel.trim();
    const produits = formProduits.split(/[\n\r,;]+/).map(r => r.trim()).filter(Boolean);
    const codeInterne = formCodeInterne.trim() || undefined;
    if (!code) { onToast("Code offre requis", "error"); return; }
    if (!produits.length) { onToast("Au moins un produit requis", "error"); return; }

    let updated: Offre[];
    if (editId) {
      updated = offres.map(o => o.id === editId ? { ...o, code, label, produits, codeInterne } : o);
    } else {
      if (offres.some(o => o.code.toLowerCase() === code.toLowerCase())) {
        onToast("Ce code offre existe déjà", "error"); return;
      }
      updated = [...offres, { id: genId(), code, label, produits, codeInterne }];
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
              Code interne <span style={{ fontWeight: 400, textTransform: "none" as const }}>(optionnel) — recherché dans la note interne Odoo</span>
            </label>
            <input value={formCodeInterne} onChange={e => setFormCodeInterne(e.target.value)} placeholder="Ex: CURE26"
              style={{ width: "100%", boxSizing: "border-box" as const, padding: "10px 12px", border: `1.5px solid ${formCodeInterne ? C.purple : C.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit", background: C.bg, color: C.text }} />
            <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>
              Si renseigné, les commandes avec ce code dans x_note_interne seront incluses même sans ligne offre
            </div>
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

// ── Export Excel (exceljs, Node.js) ──────────────────────────────────────────
async function exportToExcel(results: OffreAnalyse[], catchalls: CatchallResult[], onToast: Props["onToast"], setExporting: (v: boolean) => void) {
  setExporting(true);
  try {
    const payload = {
      results: results
        .filter(r => !r.loading && !r.error)
        .map(r => ({
          offre: r.offre,
          caTotal: r.caTotal,
          qtyTotal: r.qtyTotal,
          produits: r.produits,
          delegues: r.delegues,
          debugOrders: r.debugOrders ?? [],
        })),
      catchalls: catchalls
        .filter(c => !c.loading && c.data)
        .map(c => ({
          codeInterne: c.codeInterne,
          data: c.data,
        })),
    };

    const res = await fetch("/api/export-excel", {  // proxy Next.js — token ajouté côté serveur
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) throw new Error(`Erreur ${res.status}`);

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `analyse_offres_${new Date().toISOString().slice(0, 10)}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
    onToast("Export Excel téléchargé 🎉", "success");
  } catch (e: any) {
    onToast("Erreur export : " + e.message, "error");
  } finally {
    setExporting(false);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ONGLET ANALYSE
// ═══════════════════════════════════════════════════════════════════════════
// Résultat catch-all par codeInterne
interface CatchallResult {
  codeInterne: string;
  loading: boolean;
  data: Omit<OffreAnalyse, "offre" | "loading"> | null;
}

function AnalyseTab({ session, onToast, filter }: { session: odoo.OdooSession; onToast: Props["onToast"]; filter: StateFilter }) {
  const [configOffres, setConfigOffres] = useState<Offre[]>([]);
  const [results, setResults] = useState<OffreAnalyse[]>([]);
  const [catchalls, setCatchalls] = useState<CatchallResult[]>([]);
  const [pendingCodes, setPendingCodes] = useState<string[]>([]); // offres sélectionnées mais pas encore chargées
  const [inputVal, setInputVal] = useState("");
  const [globalLoading, setGlobalLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailMode, setDetailMode] = useState<Record<string, "produits" | "delegues" | "debug">>({});
  const [exporting, setExporting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setConfigOffres(loadOffres()); }, []);

  const findOffre = useCallback((code: string): Offre | null => {
    return configOffres.find(o => o.code.toLowerCase() === code.trim().toLowerCase()) || null;
  }, [configOffres]);

  // Ajoute à la liste d'attente (sans lancer le chargement)
  const stageCodes = (raw: string) => {
    const codes = raw.split(/[\n\r,;]+/).map(r => r.trim()).filter(Boolean);
    if (!codes.length) return;
    const alreadyLoaded = results.map(r => r.offre.code.toLowerCase());
    const notFound = codes.filter(c => !findOffre(c));
    if (notFound.length) { onToast(`Non configuré(es): ${notFound.join(", ")}`, "error"); }
    const valid = codes.filter(c => findOffre(c) && !alreadyLoaded.includes(c.toLowerCase()) && !pendingCodes.includes(c));
    if (valid.length) setPendingCodes(prev => [...prev, ...valid]);
    setInputVal("");
  };

  // Lance le chargement de TOUTES les offres en attente en une seule fois
  const analyseAll = async () => {
    if (!pendingCodes.length) return;
    const codesToLoad = [...pendingCodes];
    setPendingCodes([]);
    setGlobalLoading(true);

    const placeholders: OffreAnalyse[] = codesToLoad.map(code => ({
      offre: findOffre(code)!,
      loading: true, error: null, caTotal: 0, qtyTotal: 0, produits: [], delegues: []
    }));
    setResults(prev => [...prev, ...placeholders]);

    const localFinished: OffreAnalyse[] = [];
    await Promise.all(codesToLoad.map(async code => {
      const offre = findOffre(code)!;
      try {
        const data = await fetchCAForOffre(session, offre, filter);
        const finished: OffreAnalyse = { offre, loading: false, ...data };
        localFinished.push(finished);
        setResults(prev => prev.map(r => r.offre.code === code ? finished : r));
      } catch (e: any) {
        const failed: OffreAnalyse = { offre, loading: false, error: e.message || "Erreur Odoo", caTotal: 0, qtyTotal: 0, produits: [], delegues: [] };
        localFinished.push(failed);
        setResults(prev => prev.map(r => r.offre.code === code ? failed : r));
      }
    }));

    // Catchall calculé UNE SEULE FOIS avec toutes les offres chargées
    const prevLoaded = results.filter(r => !r.loading && !r.error);
    await runCatchalls([...prevLoaded, ...localFinished.filter(r => !r.error)]);
    setGlobalLoading(false);
    onToast(`${localFinished.length} offre(s) analysée(s)`, "success");
    inputRef.current?.focus();
  };

  const runCatchalls = async (currentResults: OffreAnalyse[]) => {
    // Uniquement les codeInterne des offres ACTUELLEMENT dans les résultats
    const codesInternes = Array.from(new Set(
      currentResults
        .filter(r => r.offre.codeInterne?.trim())
        .map(r => r.offre.codeInterne!.trim())
    ));
    if (!codesInternes.length) { setCatchalls([]); return; }

    // IDs des commandes déjà assignées aux offres individuelles
    const allOrderIds = currentResults.flatMap(r => (r.debugOrders || []).map(o => o.id));

    // Codes produits de toutes les offres connues → pour double-protection anti-doublon
    const allOfferCodes = currentResults.map(r => r.offre.code);

    setCatchalls(codesInternes.map(ci => ({ codeInterne: ci, loading: true, data: null })));
    await Promise.all(codesInternes.map(async ci => {
      try {
        const data = await fetchCatchall(session, ci, allOrderIds, allOfferCodes, filter);
        setCatchalls(prev => prev.map(c => c.codeInterne === ci ? { ...c, loading: false, data } : c));
      } catch {
        setCatchalls(prev => prev.map(c => c.codeInterne === ci ? { ...c, loading: false, data: null } : c));
      }
    }));
  };

  const removeResult = (code: string) => {
    setResults(prev => {
      const next = prev.filter(r => r.offre.code !== code);
      // Recalculer les catchalls avec les offres restantes (sans relancer les requêtes Odoo)
      const remainingCodes = Array.from(new Set(next.filter(r => r.offre.codeInterne?.trim()).map(r => r.offre.codeInterne!.trim())));
      setCatchalls(prev => prev.filter(c => remainingCodes.includes(c.codeInterne)));
      return next;
    });
  };

  const clearAll = () => {
    setResults([]);
    setCatchalls([]);
    setPendingCodes([]);
    setExpandedId(null);
  };

  const refreshAll = async () => {
    setGlobalLoading(true);
    setResults(prev => prev.map(r => ({ ...r, loading: true, error: null, delegues: [] })));
    const refreshed: OffreAnalyse[] = [];
    await Promise.all(results.map(async r => {
      try {
        const data = await fetchCAForOffre(session, r.offre, filter);
        const finished: OffreAnalyse = { ...r, ...data, loading: false };
        refreshed.push(finished);
        setResults(prev => prev.map(x => x.offre.code === r.offre.code ? finished : x));
      } catch (e: any) {
        const failed: OffreAnalyse = { ...r, loading: false, error: e.message || "Erreur" };
        refreshed.push(failed);
        setResults(prev => prev.map(x => x.offre.code === r.offre.code ? failed : x));
      }
    }));
    await runCatchalls(refreshed); // utilise les données fraîches, pas le state périmé
    setGlobalLoading(false);
    onToast("Données actualisées", "success");
  };

  const totalCA = results.filter(r => !r.loading && !r.error).reduce((s, r) => s + r.caTotal, 0)
    + catchalls.filter(c => !c.loading && c.data).reduce((s, c) => s + (c.data?.caTotal ?? 0), 0);
  const totalQty = results.filter(r => !r.loading && !r.error).reduce((s, r) => s + r.qtyTotal, 0)
    + catchalls.filter(c => !c.loading && c.data).reduce((s, c) => s + (c.data?.qtyTotal ?? 0), 0);
  const hasResults = results.some(r => !r.loading && !r.error);

  // Offres dispo = non encore dans results ET non dans pendingCodes
  const allOffres = configOffres.filter(o =>
    !results.some(r => r.offre.id === o.id) && !pendingCodes.includes(o.code)
  );

  return (
    <div style={{ paddingBottom: 40 }}>
      {/* Saisie */}
      <div style={{ background: C.white, border: `1.5px solid ${C.blue}`, borderRadius: 14, padding: 14, marginBottom: 16, boxShadow: `0 0 0 3px ${C.blueSoft}` }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.blue, textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 10 }}>Sélectionner les offres à analyser</div>

        {/* Chips en attente */}
        {pendingCodes.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 6, marginBottom: 10 }}>
            {pendingCodes.map(code => {
              const o = findOffre(code);
              return (
                <span key={code} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 10px", background: C.blueSoft, border: `1px solid ${C.blue}44`, borderRadius: 8, fontSize: 12, fontWeight: 600, color: C.blue }}>
                  {code}{o?.label ? ` · ${o.label}` : ""}
                  <button onClick={() => setPendingCodes(p => p.filter(c => c !== code))}
                    style={{ background: "none", border: "none", cursor: "pointer", color: C.blue, padding: 0, lineHeight: 1, fontSize: 14 }}>×</button>
                </span>
              );
            })}
          </div>
        )}

        {/* Input + bouton Analyser */}
        <div style={{ display: "flex", gap: 8 }}>
          <input
            ref={inputRef}
            value={inputVal}
            onChange={e => setInputVal(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") { stageCodes(inputVal); } }}
            onPaste={e => {
              const pasted = e.clipboardData.getData("text");
              if (/[\n\r,;]/.test(pasted)) { e.preventDefault(); stageCodes(pasted); }
            }}
            placeholder="Code offre (ex: 7131482)…"
            autoFocus
            style={{ flex: 1, padding: "10px 12px", border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit", background: C.bg, color: C.text, outline: "none" }}
          />
          {inputVal.trim() && (
            <button onClick={() => stageCodes(inputVal)}
              style={{ padding: "10px 14px", background: C.bg, color: C.blue, border: `1.5px solid ${C.blue}`, borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
              + Ajouter
            </button>
          )}
          <button onClick={analyseAll} disabled={!pendingCodes.length || globalLoading}
            style={{ padding: "10px 16px", background: pendingCodes.length && !globalLoading ? C.blue : C.border, color: pendingCodes.length && !globalLoading ? "#fff" : C.textMuted, border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: pendingCodes.length && !globalLoading ? "pointer" : "default", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6 }}>
            {globalLoading
              ? <><span style={{ width: 13, height: 13, borderRadius: "50%", border: "2px solid #fff4", borderTopColor: "#fff", display: "inline-block", animation: "spin 0.7s linear infinite" }} />Calcul…</>
              : "▶ Analyser"
            }
          </button>
        </div>

        {/* Suggestions depuis le paramétrage */}
        {allOffres.length > 0 && (
          <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap" as const, gap: 6 }}>
            {allOffres.map(o => (
              <button key={o.id} onClick={() => stageCodes(o.code)}
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
          <div style={{ display: "flex", flexDirection: "column" as const, gap: 6, flexShrink: 0 }}>
            {results.filter(r => !r.loading && !r.error).length > 0 && (
              <button onClick={refreshAll} disabled={globalLoading}
                style={{ flex: 1, padding: "0 12px", background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, cursor: "pointer", color: C.textMuted, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>
                </svg>
              </button>
            )}
            {results.filter(r => !r.loading && !r.error).length > 0 && (
              <button onClick={clearAll}
                style={{ flex: 1, padding: "0 12px", background: C.white, border: `1px solid ${C.red}44`, borderRadius: 10, cursor: "pointer", color: C.red, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
              </button>
            )}
            {results.filter(r => !r.loading && !r.error).length > 0 && (
              <button
                onClick={() => exportToExcel(results, catchalls, onToast, setExporting)}
                disabled={exporting}
                style={{ flex: 1, padding: "0 12px", background: exporting ? C.border : C.green, border: "none", borderRadius: 10, cursor: exporting ? "default" : "pointer", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", gap: 5, fontSize: 11, fontWeight: 700, fontFamily: "inherit" }}>
                {exporting ? "…" : (
                  <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>XLS</>
                )}
              </button>
            )}
          </div>
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
                      {r.debugOrders?.length} commandes incluses
                    </div>
                    <div style={{ display: "flex", flexDirection: "column" as const, gap: 4 }}>
                      {(r.debugOrders ?? []).sort((a, b) => a.name.localeCompare(b.name)).map(o => (
                        <a key={o.id} href={`https://wala-prod.odoo.com/web#id=${o.id}&menu_id=178&cids=1&action=301&model=sale.order&view_type=form`} target="_blank" rel="noreferrer"
                          style={{ display: "flex", flexDirection: "column" as const, padding: "7px 10px", background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, textDecoration: "none", gap: 1 }}>
                          <span style={{ fontSize: 12, fontWeight: 700, color: C.blue, fontFamily: "monospace" }}>{o.name}</span>
                          {o.partnerName && <span style={{ fontSize: 11, color: C.textMuted }}>{o.partnerName}</span>}
                        </a>
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

      {/* ── Sections catch-all par codeInterne ── */}
      {catchalls.map(c => {
        const d = c.data;
        if (!c.loading && (!d || (d.qtyTotal === 0 && d.caTotal === 0))) return null;
        const caKey = `catchall_${c.codeInterne}`;
        const isExp = expandedId === caKey;
        const mode = detailMode[caKey] || "delegues";
        return (
          <div key={c.codeInterne} style={{ marginTop: 12, border: `1.5px dashed ${C.orange}`, borderRadius: 14, overflow: "hidden", background: C.white }}>
            <div style={{ padding: "12px 14px", borderBottom: `1px solid ${C.border}`, background: C.orangeSoft, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 800, color: C.orange }}>{c.codeInterne}</div>
                <div style={{ fontSize: 11, color: C.orange, opacity: 0.8 }}>Commandes sans code offre spécifique (note interne)</div>
              </div>
              {c.loading && <div style={{ width: 16, height: 16, border: "2px solid " + C.orange, borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />}
            </div>
            {!c.loading && d && (
              <div style={{ padding: "12px 14px" }}>
                <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                  <div style={{ flex: 1, background: C.bg, borderRadius: 10, padding: "10px 12px" }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const, marginBottom: 4 }}>CA (lignes)</div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: C.teal }}>{fmtCA(d.caTotal)}</div>
                  </div>
                  <div style={{ flex: 1, background: C.bg, borderRadius: 10, padding: "10px 12px" }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const, marginBottom: 4 }}>Commandes</div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: C.orange }}>{d.qtyTotal}</div>
                  </div>
                </div>
                {/* Boutons détail */}
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => { setExpandedId(isExp && mode === "produits" ? null : caKey); setDetailMode(m => ({ ...m, [caKey]: "produits" })); }}
                    style={{ flex: 1, padding: "7px 0", background: isExp && mode === "produits" ? C.blueSoft : C.bg, border: `1px solid ${isExp && mode === "produits" ? C.blue : C.border}`, borderRadius: 8, cursor: "pointer", fontSize: 11, fontWeight: 600, color: isExp && mode === "produits" ? C.blue : C.textSec, fontFamily: "inherit" }}>
                    📦 Produits ({d.produits.length})
                  </button>
                  <button onClick={() => { setExpandedId(isExp && mode === "delegues" ? null : caKey); setDetailMode(m => ({ ...m, [caKey]: "delegues" })); }}
                    style={{ flex: 1, padding: "7px 0", background: isExp && mode === "delegues" ? C.purpleSoft : C.bg, border: `1px solid ${isExp && mode === "delegues" ? C.purple : C.border}`, borderRadius: 8, cursor: "pointer", fontSize: 11, fontWeight: 600, color: isExp && mode === "delegues" ? C.purple : C.textSec, fontFamily: "inherit" }}>
                    👤 Délégués ({d.delegues.length})
                  </button>
                  <button onClick={() => { setExpandedId(isExp && mode === "debug" ? null : caKey); setDetailMode(m => ({ ...m, [caKey]: "debug" })); }}
                    style={{ flex: 1, padding: "7px 0", background: isExp && mode === "debug" ? C.orangeSoft : C.bg, border: `1px solid ${isExp && mode === "debug" ? C.orange : C.border}`, borderRadius: 8, cursor: "pointer", fontSize: 11, fontWeight: 600, color: isExp && mode === "debug" ? C.orange : C.textSec, fontFamily: "inherit" }}>
                    🔍 Commandes ({d.debugOrders?.length ?? 0})
                  </button>
                </div>
              </div>
            )}
            {/* Détail produits */}
            {!c.loading && d && isExp && mode === "produits" && (
              <div style={{ borderTop: `1px solid ${C.border}`, background: C.bg }}>
                {d.produits.length === 0 ? (
                  <div style={{ padding: "12px 14px", color: C.textMuted, fontSize: 12, textAlign: "center" as const }}>Aucun produit</div>
                ) : d.produits.map((p, i) => (
                  <div key={p.productId} style={{ padding: "10px 14px", borderBottom: i < d.produits.length - 1 ? `1px solid ${C.border}` : undefined, display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{p.name}</div>
                    </div>
                    <div style={{ textAlign: "right" as const, flexShrink: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 800, color: C.teal }}>{fmtCA(p.ca)}</div>
                      <div style={{ fontSize: 11, color: C.textMuted }}>{Math.round(p.qtyVendue)} unités</div>
                    </div>
                    <div style={{ width: 40, height: 32, display: "flex", alignItems: "flex-end" }}>
                      <div style={{ width: "100%", height: `${Math.max(4, (p.ca / (d.caTotal || 1)) * 32)}px`, background: C.teal, borderRadius: 3, opacity: 0.7 }} />
                    </div>
                  </div>
                ))}
              </div>
            )}
            {/* Détail délégués */}
            {!c.loading && d && isExp && mode === "delegues" && (
              <div style={{ borderTop: `1px solid ${C.border}`, background: C.bg }}>
                {d.delegues.length === 0 ? (
                  <div style={{ padding: "12px 14px", color: C.textMuted, fontSize: 12, textAlign: "center" as const }}>Aucun délégué</div>
                ) : d.delegues.map((del, i) => (
                  <div key={del.userId} style={{ padding: "10px 14px", borderBottom: i < d.delegues.length - 1 ? `1px solid ${C.border}` : undefined, display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ width: 32, height: 32, borderRadius: 16, background: C.purpleSoft, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <span style={{ fontSize: 12, fontWeight: 800, color: C.purple }}>{del.name.split(" ").map((n: string) => n[0]).slice(0, 2).join("").toUpperCase()}</span>
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{del.name}</div>
                      <div style={{ fontSize: 11, color: C.textMuted }}>{del.qtyVendue} lignes</div>
                    </div>
                    <div style={{ textAlign: "right" as const }}>
                      <div style={{ fontSize: 14, fontWeight: 800, color: C.purple }}>{fmtCA(del.ca)}</div>
                      <div style={{ fontSize: 10, color: C.textMuted }}>{Math.round((del.ca / (d.caTotal || 1)) * 100)}%</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {/* Détail commandes */}
            {!c.loading && d && isExp && mode === "debug" && (
              <div style={{ borderTop: `1px solid ${C.border}`, background: C.bg, padding: "12px 14px" }}>
                <div style={{ display: "flex", flexDirection: "column" as const, gap: 4 }}>
                  {(d.debugOrders ?? []).sort((a, b) => a.name.localeCompare(b.name)).map(o => (
                    <a key={o.id} href={`https://wala-prod.odoo.com/web#id=${o.id}&menu_id=178&cids=1&action=301&model=sale.order&view_type=form`} target="_blank" rel="noreferrer"
                      style={{ display: "flex", flexDirection: "column" as const, padding: "7px 10px", background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, textDecoration: "none", gap: 1 }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: C.blue, fontFamily: "monospace" }}>{o.name}</span>
                      {o.partnerName && <span style={{ fontSize: 11, color: C.textMuted }}>{o.partnerName}</span>}
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPOSANT PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════════
export default function AnalyseScreen({ session, onBack, onToast }: Props) {
  const [tab, setTab] = useState<"all" | "avenir" | "valide" | "parametrage">("all");

  const TABS: [string, string, string][] = [
    ["all",        "📊 Tout",      C.blue],
    ["avenir",     "🔜 À venir",   C.orange],
    ["valide",     "✅ Validé",    C.green],
    ["parametrage","⚙️ Config",    C.textMuted],
  ];

  return (
    <div style={{ padding: "20px 16px", maxWidth: 480, margin: "0 auto", fontFamily: "'DM Sans', sans-serif" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <button onClick={onBack} style={{ background: C.bg, border: "none", borderRadius: 10, padding: 8, cursor: "pointer", display: "flex" }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
        </button>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>Analyse offres</div>
          <div style={{ fontSize: 12, color: C.textMuted }}>
            {tab === "avenir" ? "Commandes confirmées non expédiées" : tab === "valide" ? "Commandes expédiées / finalisées" : "CA généré par offre via Odoo"}
          </div>
        </div>
      </div>

      {/* Onglets */}
      <div style={{ display: "flex", gap: 4, marginBottom: 20, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, padding: 4 }}>
        {TABS.map(([key, label, color]) => (
          <button key={key} onClick={() => setTab(key as any)}
            style={{ flex: 1, padding: "8px 0", border: "none", borderRadius: 9, cursor: "pointer", fontFamily: "inherit", fontSize: 11, fontWeight: 700, transition: "all 0.15s",
              background: tab === key ? C.white : "transparent",
              color: tab === key ? color : C.textMuted,
              boxShadow: tab === key ? C.shadow : "none" }}>
            {label}
          </button>
        ))}
      </div>

      {tab === "parametrage" ? (
        <ParametrageTab onToast={onToast} />
      ) : (
        <AnalyseTab key={tab} session={session} onToast={onToast} filter={tab as StateFilter} />
      )}
    </div>
  );
}
