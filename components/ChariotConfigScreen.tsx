"use client";
// components/ChariotConfigScreen.tsx
// Configuration du chariot e-shop : liste des SKU, stock chariot, envoi vers
// Shopware. Déplacé depuis l'écran Administration vers Sorties e-shop, où se
// trouve désormais tout ce qui concerne le chariot (réappro, sorties, audit).

import { useState, useEffect, useRef } from "react";
import * as odoo from "@/lib/odoo";
import { writeHeaders } from "@/lib/writeToken";
import { setChariotSkusLocal } from "@/lib/chariotLocal";

const C = {
  bg: "#f8fafc", white: "#ffffff", text: "#1a1a2e", textSec: "#374151",
  textMuted: "#6b7280", border: "#e5e7eb", blue: "#2563eb", blueSoft: "#eff6ff",
  green: "#16a34a", red: "#dc2626", orange: "#ea580c",
  shadow: "0 1px 4px rgba(0,0,0,0.07)",
};

// Conteneur repris de l'écran Administration, pour garder la même présentation.
function Section({ children, style: s }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ background: C.white, borderRadius: 16, padding: 16, marginBottom: 12, border: `1px solid ${C.border}`, boxShadow: C.shadow, ...s }}>{children}</div>;
}

export default function ChariotConfigScreen({ session }: { session: any }) {
  return <EshopChariotSkus session={session} />;
}

function EshopChariotSkus({ session }: { session: any }) {
  const [skus, setSkus] = useState<string[]>([]);
  const [newSku, setNewSku] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // Use ref to always have latest skus for Odoo save even if component unmounts
  const skusRef = useRef<string[]>([]);
  // Stock chariot par SKU (géré dans l'app, partagé via Supabase)
  const [stock, setStock] = useState<Record<string, number>>({});
  const [stockDraft, setStockDraft] = useState<Record<string, string>>({});
  const [stockError, setStockError] = useState("");
  // Désignation Odoo par SKU (rapprochement via réf / réf fournisseur / EAN / nom)
  const [names, setNames] = useState<Record<string, { name: string; ref: string }>>({});
  const [resolving, setResolving] = useState(false);

  // Résout les désignations Odoo pour une liste de SKU (incrémental — ne refait pas les déjà connus).
  const resolveNames = async (list: string[]) => {
    if (!session) return;
    const todo = list.filter(s => !names[s]);
    if (!todo.length) return;
    setResolving(true);
    try {
      const matches = await odoo.matchEshopSkus(session, todo);
      setNames(prev => {
        const next = { ...prev };
        for (const s of todo) {
          const m: any = matches[s];
          next[s] = { name: m?.product_name || "", ref: m?.default_code || "" };
        }
        return next;
      });
    } catch {}
    setResolving(false);
  };

  // Désignation + stock Shopware par SKU (catalogue actif).
  const [swNames, setSwNames] = useState<Record<string, string>>({});
  const [swStock, setSwStock] = useState<Record<string, number | null>>({});
  const [pushing, setPushing] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // Charge noms + stock Shopware (catalogue actif) — 1 appel pour tous les SKU.
  // Puis, pour les SKU absents du catalogue actif, on interroge stockInfo par SKU.
  const loadSwData = async (skuList: string[]) => {
    let smap: Record<string, number | null> = {};
    try {
      const r = await fetch("/api/shopware-explore?action=activeProducts").then(x => x.json());
      const nmap: Record<string, string> = {};
      for (const p of (r.products || [])) if (p.number) { nmap[String(p.number)] = p.name || ""; smap[String(p.number)] = p.inStock ?? null; }
      setSwNames(nmap); setSwStock({ ...smap });
    } catch {}
    // Fallback par SKU pour ceux non couverts (réf ≠ numéro d'article actif, produit inactif…)
    const missing = skuList.filter(s => smap[s] === undefined);
    await Promise.all(missing.map(async sku => {
      try {
        const r = await fetch(`/api/shopware-explore?action=stockInfo&articleNumber=${encodeURIComponent(sku)}`).then(x => x.json());
        setSwStock(prev => ({ ...prev, [sku]: r.found ? (r.native_inStock ?? null) : null }));
      } catch { setSwStock(prev => ({ ...prev, [sku]: null })); }
    }));
  };

  // Pousse le stock chariot d'un SKU vers Shopware (inStock).
  const pushToShopware = async (sku: string) => {
    const qty = stock[sku] ?? 0;
    setPushing(sku);
    try {
      const r = await fetch(`/api/shopware-explore?action=setStock&articleNumber=${encodeURIComponent(sku)}&qty=${qty}`, { headers: writeHeaders }).then(x => x.json());
      if (r.ok) setSwStock(prev => ({ ...prev, [sku]: r.newStock }));
    } catch {}
    setPushing(null);
  };

  useEffect(() => {
    if (!session) return;
    odoo.loadChariotSkus(session).then(p => { setSkus(p); skusRef.current = p; setChariotSkusLocal(p); resolveNames(p); loadSwData(p); }).catch(() => {});
    import("@/lib/supabase").then(sb => sb.getChariotStock().then(setStock).catch(() => {}));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Liste filtrée par recherche (réf ou désignation).
  const q = search.trim().toLowerCase();
  const visibleSkus = q
    ? skus.filter(s => s.toLowerCase().includes(q) || (names[s]?.name || "").toLowerCase().includes(q) || (swNames[s] || "").toLowerCase().includes(q))
    : skus;

  const saveStock = async (sku: string) => {
    const raw = stockDraft[sku];
    if (raw == null || raw === "") return;
    const v = parseInt(raw, 10);
    if (Number.isNaN(v) || v < 0) return;
    setStockError("");
    try {
      const sb = await import("@/lib/supabase");
      const next = await sb.setChariotStock(sku, v);
      // Vérifie que l'écriture a bien été PARTAGÉE (relit depuis Supabase).
      const check = await sb.getChariotStock();
      if ((check[sku] ?? -1) !== v) {
        setStockError(`⚠ Le stock de ${sku} n'a PAS été enregistré en base (partagé). Réessaie — si ça persiste, problème d'accès Supabase.`);
        return;
      }
      setStock(next);
      setStockDraft(prev => { const c = { ...prev }; delete c[sku]; return c; });
    } catch (e: any) {
      setStockError("⚠ Échec enregistrement stock : " + (e?.message || e) + " — la valeur n'est PAS partagée entre postes.");
    }
  };

  const save = (updated: string[]) => {
    skusRef.current = updated;
    setSkus(updated);
    setChariotSkusLocal(updated);
    setSaving(true);
    setSaved(false);
    // Fire and forget — use the ref value so unmount doesn't matter
    odoo.saveChariotSkus(session, updated)
      .then(() => { setSaving(false); setSaved(true); setTimeout(() => setSaved(false), 2000); })
      .catch(e => { console.error("[chariot] save error:", e); setSaving(false); });
  };

  const add = () => {
    const s = newSku.trim();
    if (s && !skusRef.current.includes(s)) { save([...skusRef.current, s]); setNewSku(""); resolveNames([s]); }
  };

  return (
    <Section>
      <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 4 }}>🛒 E-shop — Chariot Eshop</div>
      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 10 }}>
        Ces SKU seront affichés avec l'emplacement <strong>Chariot Eshop</strong> (partagé entre tous les utilisateurs)
      </div>
      {stockError && (
        <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#dc2626", borderRadius: 8, padding: "8px 12px", fontSize: 12, marginBottom: 10 }}>{stockError}</div>
      )}
      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        <input value={newSku} onChange={e => setNewSku(e.target.value)}
          onKeyDown={e => { e.stopPropagation(); if (e.key === "Enter") add(); }}
          placeholder="SKU..."
          style={{ flex: 1, padding: "8px 10px", border: `1.5px solid ${C.border}`, borderRadius: 8, fontSize: 12, fontFamily: "inherit", outline: "none" }} />
        <button onClick={add} style={{ padding: "8px 14px", background: saving ? C.textMuted : C.blue, color: "#fff", border: "none", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>{saving ? "⏳" : saved ? "✓" : "+"}</button>
      </div>
      {/* Recherche */}
      {skus.length > 0 && (
        <div style={{ display: "flex", gap: 6, marginBottom: 8, alignItems: "center" }}>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="🔍 Rechercher (réf ou désignation)…"
            style={{ flex: 1, minWidth: 0, padding: "8px 10px", border: `1.5px solid ${C.border}`, borderRadius: 8, fontSize: 12, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }} />
          {search && <button onClick={() => setSearch("")} style={{ padding: "8px 10px", background: C.white, border: `1.5px solid ${C.border}`, borderRadius: 8, fontSize: 11, cursor: "pointer", color: C.textMuted }}>✕</button>}
          <span style={{ fontSize: 11, color: C.textMuted, whiteSpace: "nowrap" }}>{visibleSkus.length}</span>
        </div>
      )}
      {skus.length === 0 && <div style={{ fontSize: 11, color: C.textMuted }}>Aucun SKU configuré</div>}
      {skus.length > 0 && (
        <div style={{ display: "flex", fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const, padding: "4px 0", borderBottom: `1px solid ${C.border}`, gap: 8 }}>
          <span style={{ flex: 1 }}>SKU / Désignation {resolving && <span style={{ fontWeight: 400, textTransform: "none" as const }}>· résolution…</span>}</span><span style={{ width: 70, textAlign: "center" }}>Stock SW</span><span style={{ width: 150, textAlign: "center" }}>Stock chariot</span><span style={{ width: 20 }} />
        </div>
      )}
      {visibleSkus.map(sku => {
        const cur = stock[sku] ?? 0;
        const draft = stockDraft[sku];
        const dirty = draft != null && draft !== String(cur);
        const info = names[sku];
        const sw = swStock[sku];
        const diff = sw != null && sw !== cur;
        return (
          <div key={sku} style={{ display: "flex", alignItems: "center", padding: "7px 0", borderBottom: `1px solid ${C.border}`, gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: C.text, fontFamily: "monospace" }}>{sku}</span>
              {info && (info.name
                ? <div style={{ fontSize: 11, color: C.textSec, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{info.name}{info.ref && info.ref !== sku ? <span style={{ color: C.textMuted }}> · {info.ref}</span> : ""}</div>
                : (swNames[sku]
                    ? <div style={{ fontSize: 11, color: C.textSec, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{swNames[sku]} <span style={{ color: C.orange, fontWeight: 700 }}>· Shopware</span></div>
                    : <div style={{ fontSize: 10.5, color: C.orange }}>non trouvé</div>))}
            </div>
            {/* Stock Shopware actuel (lecture) */}
            <div style={{ width: 70, textAlign: "center", fontSize: 13, fontWeight: 800, color: diff ? C.orange : C.text }}>
              {sw === undefined ? "…" : sw === null ? "—" : sw}
            </div>
            {/* Stock chariot + bouton pousser vers Shopware */}
            <div style={{ width: 150, display: "flex", alignItems: "center", gap: 4, justifyContent: "center" }}>
              <input type="number" min={0}
                value={draft ?? String(cur)}
                onChange={e => setStockDraft(prev => ({ ...prev, [sku]: e.target.value }))}
                onKeyDown={e => { e.stopPropagation(); if (e.key === "Enter") saveStock(sku); }}
                style={{ width: 52, padding: "5px 6px", border: `1.5px solid ${cur <= 0 ? C.red : C.border}`, borderRadius: 7, fontSize: 12, fontFamily: "inherit", textAlign: "center", boxSizing: "border-box", color: cur <= 0 ? C.red : C.text, fontWeight: 700 }} />
              {dirty
                ? <button onClick={() => saveStock(sku)} style={{ padding: "5px 8px", background: C.green, color: "#fff", border: "none", borderRadius: 7, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>OK</button>
                : <button onClick={() => pushToShopware(sku)} disabled={pushing === sku} title="Écrire ce stock dans Shopware"
                    style={{ padding: "5px 8px", background: C.blue, color: "#fff", border: "none", borderRadius: 7, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", opacity: pushing === sku ? 0.6 : 1 }}>{pushing === sku ? "…" : "→ SW"}</button>}
            </div>
            <button onClick={() => save(skusRef.current.filter(s => s !== sku))} style={{ width: 20, background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 12, fontWeight: 700 }}>✕</button>
          </div>
        );
      })}
      <div style={{ fontSize: 10.5, color: C.textMuted, marginTop: 8 }}>« → SW » écrit le stock chariot dans Shopware. Le stock chariot est aussi décrémenté automatiquement à chaque sortie e-shop validée.</div>
    </Section>
  );
}
