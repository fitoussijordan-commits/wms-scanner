"use client";
// components/ChariotConfigScreen.tsx
// Configuration du chariot e-shop : liste des SKU, stock chariot, envoi vers
// Shopware. Déplacé depuis l'écran Administration vers Sorties e-shop, où se
// trouve désormais tout ce qui concerne le chariot (réappro, sorties, audit).

import { useState, useEffect, useRef, useCallback } from "react";
import * as odoo from "@/lib/odoo";
import { writeHeaders } from "@/lib/writeToken";
import { setChariotSkusLocal } from "@/lib/chariotLocal";
import { getEshopMappingOverrides, saveEshopMappingOverride, type EshopMappingOverrides } from "@/lib/supabase";

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

type Toast = (msg: string, type?: "success" | "error" | "info") => void;

export default function ChariotConfigScreen({ session, onToast }: { session: any; onToast: Toast }) {
  return <EshopChariotSkus session={session} onToast={onToast} />;
}

function EshopChariotSkus({ session, onToast }: { session: any; onToast: Toast }) {
  // Ref pour appeler onToast depuis des callbacks sans le mettre en dépendance
  const onToastRef = useRef<Toast | null>(null);
  onToastRef.current = onToast;
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

  // ── Rattachement à une référence Odoo ───────────────────────────────────────
  // On réutilise le MÊME magasin que le bouton « corriger » de l'audit catalogue
  // (saveEshopMappingOverride). Il est déjà prioritaire sur la détection
  // automatique et déjà lu par le cron des sorties : une réf fixée ici vaut
  // partout. Surtout ne pas créer un second système parallèle.
  const [overrides, setOverrides] = useState<EshopMappingOverrides>({});
  const [mapOpen, setMapOpen] = useState<string | null>(null);   // SKU en cours de rattachement
  const [mapQuery, setMapQuery] = useState("");
  const [mapResults, setMapResults] = useState<any[]>([]);
  const [mapSearching, setMapSearching] = useState(false);
  const mapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { getEshopMappingOverrides().then(setOverrides).catch(() => {}); }, []);

  // Recherche contextuelle : suggestions dès 2 caractères, avec anti-rebond
  // pour ne pas lancer une requête Odoo à chaque frappe.
  const searchOdoo = useCallback((q: string) => {
    setMapQuery(q);
    if (mapTimer.current) clearTimeout(mapTimer.current);
    if (q.trim().length < 2) { setMapResults([]); setMapSearching(false); return; }
    setMapSearching(true);
    mapTimer.current = setTimeout(async () => {
      try {
        const r = await odoo.globalSearch(session, q.trim());
        setMapResults(r.filter((x: any) => x.type === "product").slice(0, 8));
      } catch { setMapResults([]); }
      setMapSearching(false);
    }, 300);
  }, [session]);

  const openMapping = (sku: string) => {
    setMapOpen(prev => prev === sku ? null : sku);
    setMapQuery(""); setMapResults([]); setMapSearching(false);
  };

  // `prod` = r.data d'un résultat globalSearch (même forme que le « corriger » de l'audit)
  const chooseProduct = async (sku: string, prod: any) => {
    try {
      const ref = prod.default_code || "";
      await saveEshopMappingOverride(sku, prod.id, ref, prod.name || "");
      setOverrides(prev => ({ ...prev, [sku]: { productId: prod.id, odooRef: ref, productName: prod.name || "" } }));
      setMapOpen(null); setMapQuery(""); setMapResults([]);
      setNames(prev => ({ ...prev, [sku]: { name: prod.name || "", ref } }));
      onToastRef.current?.(`✓ ${sku} rattaché à ${ref || prod.name}`, "success");
    } catch (e: any) {
      onToastRef.current?.("Erreur : " + e.message, "error");
    }
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

              {/* Rattachement Odoo — discret quand tout va bien, visible quand il manque */}
              {(() => {
                const ov = overrides[sku];
                const autoRef = info?.ref || "";
                const ref = ov?.odooRef || autoRef;
                const manual = !!ov;
                return (
                  <div
                    onClick={() => openMapping(sku)}
                    title={ref ? "Cliquer pour changer la référence Odoo" : "Cliquer pour choisir la référence Odoo"}
                    style={{
                      fontSize: 10.5, marginTop: 3, cursor: "pointer", display: "inline-flex",
                      alignItems: "center", gap: 4, borderRadius: 5, padding: "1px 4px", marginLeft: -4,
                      color: !ref ? "#854F0B" : manual ? C.blue : C.textMuted,
                      background: !ref ? "#FEF3C7" : "transparent",
                      fontWeight: !ref ? 700 : 400,
                    }}>
                    {ref ? (
                      <>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7l1.7-1.7"/></svg>
                        Odoo <span style={{ fontFamily: "monospace" }}>{ref}</span>
                        <span>· {manual ? "choisi" : "auto"}</span>
                      </>
                    ) : (
                      <>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13.5"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                        Pas de référence Odoo — cliquer pour choisir
                      </>
                    )}
                  </div>
                );
              })()}

              {/* Recherche contextuelle : suggestions dès 2 lettres */}
              {mapOpen === sku && (
                <div style={{ marginTop: 6, padding: 8, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8 }}>
                  <input
                    autoFocus
                    value={mapQuery}
                    onChange={e => searchOdoo(e.target.value)}
                    onKeyDown={e => { e.stopPropagation(); if (e.key === "Escape") setMapOpen(null); }}
                    placeholder="Tape les premières lettres — nom, réf ou EAN…"
                    style={{ width: "100%", padding: "7px 10px", border: `1.5px solid ${C.blue}`, borderRadius: 7, fontSize: 12, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }}
                  />
                  {mapSearching && <div style={{ fontSize: 11, color: C.textMuted, marginTop: 5 }}>Recherche…</div>}
                  {!mapSearching && mapQuery.trim().length >= 2 && mapResults.length === 0 && (
                    <div style={{ fontSize: 11, color: C.orange, marginTop: 5 }}>Aucun produit trouvé</div>
                  )}
                  {mapResults.map((r: any, k: number) => (
                    <button key={k} onClick={() => chooseProduct(sku, r.data)}
                      style={{ width: "100%", textAlign: "left", marginTop: 5, padding: "6px 9px", background: C.white, border: `1px solid ${C.border}`, borderRadius: 7, cursor: "pointer", fontFamily: "inherit", display: "block" }}>
                      <div style={{ fontSize: 11.5, fontWeight: 600, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.data.name}</div>
                      {r.data.default_code && <div style={{ fontSize: 10.5, color: C.blue, fontFamily: "monospace" }}>{r.data.default_code}</div>}
                    </button>
                  ))}
                  {overrides[sku] && (
                    <div style={{ fontSize: 10.5, color: C.textMuted, marginTop: 6 }}>
                      Rattachement manuel actuel — en choisir un autre le remplacera.
                    </div>
                  )}
                </div>
              )}
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
