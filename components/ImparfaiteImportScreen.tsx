"use client";
import { useState } from "react";
import * as odoo from "@/lib/odoo";
import { getProcessedImparfaiteOrders, markImparfaiteProcessed } from "@/lib/supabase";

const C = {
  bg: "#f8fafc", white: "#ffffff", text: "#1a1a2e", textSec: "#374151",
  textMuted: "#6b7280", border: "#e5e7eb", blue: "#2563eb", blueSoft: "#eff6ff",
  green: "#16a34a", greenSoft: "#f0fdf4", red: "#dc2626", redSoft: "#fef2f2",
  orange: "#ea580c", orangeSoft: "#fff7ed", purple: "#7c3aed", purpleSoft: "#f5f3ff",
  shadow: "0 1px 4px rgba(0,0,0,0.07)",
};

interface Props {
  session: odoo.OdooSession;
  onBack: () => void;
  onToast: (msg: string, type?: "success" | "error" | "info") => void;
}

interface RawLine {
  orderRef: string; date: string; articleName: string; qty: number; price: string; sku: string;
  name: string; company: string; email: string; phone: string;
  addr1: string; addr2: string; addr3: string; zip: string; city: string; country: string;
}
interface OrderItem { sku: string; articleName: string; qty: number; price: number; productId: number; odooRef: string; matched: boolean; }
interface OrderGroup {
  ref: string; date: string;
  client: { name: string; company: string; email: string; phone: string; addr1: string; addr2: string; addr3: string; zip: string; city: string; country: string };
  items: OrderItem[];
  alreadyImported: boolean;
}

async function loadXLSX(): Promise<any> {
  if ((window as any).XLSX) return (window as any).XLSX;
  await new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    s.onload = () => resolve(); s.onerror = () => reject(new Error("XLSX load failed"));
    document.head.appendChild(s);
  });
  return (window as any).XLSX;
}

// Lecture tolérante d'une cellule par mots-clés d'en-tête.
// exclude = mots-clés à NE PAS matcher (ex: "article" pour ne pas confondre "Nom" et "Nom de l'Article").
function pick(row: any, keys: string[], exclude: string[] = []): any {
  const rk = Object.keys(row);
  const norm = (s: string) => s.toLowerCase().replace(/[\s\-_*().']/g, "");
  const isExcluded = (k: string) => exclude.some(x => norm(k).includes(norm(x)));
  // 1) match EXACT d'abord (le plus fiable)
  let found = rk.find(k => !isExcluded(k) && keys.some(t => norm(k) === norm(t)));
  // 2) sinon, match par inclusion
  if (!found) found = rk.find(k => !isExcluded(k) && keys.some(t => norm(k).includes(norm(t))));
  return found ? row[found] : null;
}

export default function ImparfaiteImportScreen({ session, onBack, onToast }: Props) {
  const [step, setStep] = useState<"upload" | "preview" | "importing" | "done">("upload");
  const [fileName, setFileName] = useState("");
  const [groups, setGroups] = useState<OrderGroup[]>([]);
  const [error, setError] = useState("");
  const [drag, setDrag] = useState(false);
  const [fixRef, setFixRef] = useState<string | null>(null); // "orderRef|sku" en correction
  const [fixQuery, setFixQuery] = useState("");
  const [fixResults, setFixResults] = useState<any[]>([]);
  const [results, setResults] = useState<{ ref: string; ok: boolean; msg: string }[]>([]);

  const handleFile = async (file: File) => {
    setError(""); setFileName(file.name);
    try {
      const XLSX = await loadXLSX();
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const raw: any[] = XLSX.utils.sheet_to_json(sheet);
      if (!raw.length) { setError("Fichier vide ou format non reconnu"); return; }

      const lines: RawLine[] = raw.map(r => ({
        orderRef: String(pick(r, ["Référence de commande", "reference commande", "order"]) ?? "").trim(),
        date: String(pick(r, ["Date de commande", "date"]) ?? "").trim(),
        articleName: String(pick(r, ["Nom de l'Article", "nom article"]) ?? "").trim(),
        qty: Number(pick(r, ["Quantité", "quantite", "qty"]) ?? 1) || 1,
        price: String(pick(r, ["Prix de l'Article", "prix"]) ?? "0").trim(),
        sku: String(pick(r, ["SKU de l'Article", "sku"]) ?? "").trim(),
        name: String(pick(r, ["Nom"], ["article"]) ?? "").trim(),
        company: String(pick(r, ["Société", "societe"]) ?? "").trim(),
        email: String(pick(r, ["Email"]) ?? "").trim(),
        phone: String(pick(r, ["Téléphone", "telephone"]) ?? "").trim(),
        addr1: String(pick(r, ["Adresse Ligne 1", "adresse ligne1"]) ?? "").trim(),
        addr2: String(pick(r, ["Adresse Ligne 2", "adresse ligne2"]) ?? "").trim(),
        addr3: String(pick(r, ["Complément d'Adresse", "complement"]) ?? "").trim(),
        zip: String(pick(r, ["Code Postal", "code postal"]) ?? "").trim(),
        city: String(pick(r, ["Ville"]) ?? "").trim(),
        country: String(pick(r, ["Pays", "iso"]) ?? "FR").trim(),
      })).filter(l => l.orderRef && l.sku);

      if (!lines.length) { setError("Aucune ligne avec réf de commande + SKU détectée"); return; }

      // Regroupement par réf de commande
      const byRef: Record<string, RawLine[]> = {};
      for (const l of lines) (byRef[l.orderRef] ||= []).push(l);

      // Matching des SKU → produits Odoo
      const allSkus = Array.from(new Set(lines.map(l => l.sku)));
      const matches = await odoo.matchEshopSkus(session, allSkus);

      // Garde-fou : commandes déjà importées
      const refs = Object.keys(byRef);
      const processed = await getProcessedImparfaiteOrders(refs).catch(() => new Set<string>());

      const grps: OrderGroup[] = refs.map(ref => {
        const ls = byRef[ref];
        const first = ls[0];
        const items: OrderItem[] = ls.map(l => {
          const m: any = matches[l.sku];
          return {
            sku: l.sku, articleName: l.articleName, qty: l.qty, price: parseFloat(l.price) || 0,
            productId: m?.product_id || 0, odooRef: m?.default_code || "", matched: !!m?.product_id,
          };
        });
        return {
          ref, date: first.date,
          client: { name: first.name, company: first.company, email: first.email, phone: first.phone, addr1: first.addr1, addr2: first.addr2, addr3: first.addr3, zip: first.zip, city: first.city, country: first.country },
          items,
          alreadyImported: processed.has(ref),
        };
      });
      setGroups(grps);
      setStep("preview");
    } catch (e: any) { setError("Erreur lecture : " + (e?.message || String(e))); }
  };

  // Recherche produit Odoo pour corriger un SKU non trouvé
  const searchOdoo = async (q: string) => {
    if (q.trim().length < 2) { setFixResults([]); return; }
    try { const r = await odoo.globalSearch(session, q.trim()); setFixResults(r.filter((x: any) => x.type === "product").slice(0, 8)); } catch { setFixResults([]); }
  };
  const applyFix = (orderRef: string, sku: string, prod: any) => {
    setGroups(prev => prev.map(g => g.ref !== orderRef ? g : {
      ...g, items: g.items.map(it => it.sku === sku ? { ...it, matched: true, productId: prod.id, odooRef: prod.default_code || "" } : it),
    }));
    setFixRef(null); setFixQuery(""); setFixResults([]);
    onToast("Produit associé ✓", "success");
  };

  const importable = groups.filter(g => !g.alreadyImported && g.items.some(it => it.matched));

  const runImport = async () => {
    if (!importable.length) { onToast("Rien à importer", "info"); return; }
    if (!confirm(`Importer ${importable.length} commande(s) ? (crée un nouveau client + une commande confirmée par réf)`)) return;
    setStep("importing");
    const res: { ref: string; ok: boolean; msg: string }[] = [];
    for (const g of importable) {
      try {
        const lines = g.items.filter(it => it.matched).map(it => ({ productId: it.productId, qty: it.qty, name: it.articleName }));
        if (!lines.length) { res.push({ ref: g.ref, ok: false, msg: "aucune ligne mappée" }); continue; }
        // 1) nouveau client (toujours) — numéro client = réf commande, type de compte = Imparfaite
        const partnerId = await odoo.createMarketplaceClient(session, {
          name: g.client.name || g.client.company || "Client Imparfaite",
          ref: g.ref,
          email: g.client.email, phone: g.client.phone, company: g.client.company,
          street: g.client.addr1, street2: [g.client.addr2, g.client.addr3].filter(Boolean).join(" "),
          zip: g.client.zip, city: g.client.city, countryCode: g.client.country,
          typeCompteName: "Imparfaite",
        });
        // 2) commande confirmée + réservée, vendeur vide, pricelist offert, tag Imparfaite
        const order = await odoo.createMarketplaceOrder(session, partnerId, lines, {
          origin: `Imparfaite ${g.ref}`, confirm: true, assign: true, price0: true,
          pricelistName: "WALAOFFERT_2026", tag: "Imparfaite",
        });
        await markImparfaiteProcessed([g.ref], order.name).catch(() => {});
        res.push({ ref: g.ref, ok: true, msg: order.name });
      } catch (e: any) {
        res.push({ ref: g.ref, ok: false, msg: e?.message || "erreur" });
      }
    }
    setResults(res);
    setStep("done");
    const ok = res.filter(r => r.ok).length;
    onToast(`${ok}/${res.length} commande(s) importée(s)`, ok === res.length ? "success" : "error");
  };

  const reset = () => { setStep("upload"); setGroups([]); setResults([]); setFileName(""); setError(""); };

  // ── Rendu ──
  return (
    <div style={{ paddingBottom: 90 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <button onClick={onBack} style={{ background: C.bg, border: "none", borderRadius: 10, padding: 8, cursor: "pointer", display: "flex" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><path d="M19 12H5M12 5l-7 7 7 7" /></svg>
        </button>
        <div>
          <div style={{ fontSize: 17, fontWeight: 800, color: C.text }}>Import Imparfaite</div>
          <div style={{ fontSize: 12, color: C.textMuted }}>1 commande = 1 client + 1 commande Odoo (confirmée, lignes à 0 €)</div>
        </div>
      </div>

      {error && <div style={{ background: C.redSoft, border: "1px solid #fecaca", borderRadius: 10, padding: "10px 14px", color: C.red, fontSize: 13, marginBottom: 12 }}>{error}</div>}

      {step === "upload" && (
        <div
          onClick={() => document.getElementById("imp-file")?.click()}
          onDragOver={e => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={e => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
          style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, padding: "60px 24px", border: `2px dashed ${drag ? C.blue : C.border}`, borderRadius: 16, background: drag ? C.blueSoft : C.white, cursor: "pointer" }}>
          <input id="imp-file" type="file" accept=".xlsx,.xls" hidden onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])} />
          <div style={{ fontSize: 40 }}>📥</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>Dépose le fichier Imparfaite (.xlsx)</div>
          <div style={{ fontSize: 12, color: C.textMuted }}>ou clique pour parcourir</div>
        </div>
      )}

      {step === "preview" && (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: 12, color: C.textMuted }}>{fileName}</span>
            <span style={chip(C.blueSoft, C.blue)}>{groups.length} commande(s)</span>
            <span style={chip(C.greenSoft, C.green)}>{importable.length} à importer</span>
            {groups.some(g => g.alreadyImported) && <span style={chip(C.orangeSoft, C.orange)}>{groups.filter(g => g.alreadyImported).length} déjà importée(s)</span>}
            <div style={{ flex: 1 }} />
            <button onClick={reset} style={btn(C.white, C.textSec, C.border)}>Changer de fichier</button>
            <button onClick={runImport} disabled={!importable.length} style={btn(importable.length ? C.green : C.border, "#fff")}>Importer ({importable.length})</button>
          </div>

          {groups.map(g => (
            <div key={g.ref} style={{ background: C.white, border: `1px solid ${g.alreadyImported ? C.orange : C.border}`, borderRadius: 12, padding: 14, marginBottom: 10, boxShadow: C.shadow, opacity: g.alreadyImported ? 0.7 : 1 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: C.text }}>{g.ref}
                    {g.alreadyImported && <span style={{ ...chip(C.orangeSoft, C.orange), marginLeft: 8 }}>déjà importée</span>}
                  </div>
                  <div style={{ fontSize: 12, color: C.textSec }}>{g.client.name}{g.client.city ? ` · ${g.client.zip} ${g.client.city}` : ""}</div>
                  <div style={{ fontSize: 11, color: C.textMuted }}>{g.client.email}{g.client.phone ? ` · ${g.client.phone}` : ""}</div>
                </div>
                <div style={{ fontSize: 11, color: C.textMuted }}>{g.items.length} article(s)</div>
              </div>
              {g.items.map((it, k) => {
                const fixing = fixRef === `${g.ref}|${it.sku}`;
                return (
                  <div key={k} style={{ borderTop: `1px solid ${C.border}`, padding: "7px 0" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontFamily: "monospace", fontSize: 12, fontWeight: 700, color: C.text, minWidth: 0 }}>{it.sku}</span>
                      <span style={{ flex: 1, fontSize: 12, color: C.textSec, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.articleName}</span>
                      <span style={{ fontSize: 12, fontWeight: 700 }}>×{it.qty}</span>
                      {it.matched
                        ? <span style={{ fontSize: 11, color: C.green, fontWeight: 700 }}>✓ {it.odooRef || "ok"}</span>
                        : <button onClick={() => { setFixRef(fixing ? null : `${g.ref}|${it.sku}`); setFixQuery(""); setFixResults([]); }} style={{ fontSize: 11, color: C.red, fontWeight: 700, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}>{fixing ? "fermer" : "non trouvé → associer"}</button>}
                    </div>
                    {fixing && (
                      <div style={{ marginTop: 6 }}>
                        <input value={fixQuery} autoFocus onChange={e => { setFixQuery(e.target.value); searchOdoo(e.target.value); }}
                          placeholder="Chercher le produit Odoo…"
                          style={{ width: "100%", boxSizing: "border-box", padding: "8px 10px", border: `1.5px solid ${C.border}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", marginBottom: 6 }} />
                        {fixResults.map((x: any, j: number) => (
                          <button key={j} onClick={() => applyFix(g.ref, it.sku, x.data)}
                            style={{ display: "block", width: "100%", textAlign: "left", padding: "7px 10px", background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 4, cursor: "pointer", fontFamily: "inherit", fontSize: 12.5 }}>
                            <b style={{ fontFamily: "monospace" }}>{x.data.default_code || "—"}</b> · {x.data.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </>
      )}

      {step === "importing" && (
        <div style={{ textAlign: "center", padding: 50, color: C.textMuted }}>
          <div style={{ width: 40, height: 40, border: `3px solid ${C.border}`, borderTopColor: C.blue, borderRadius: "50%", animation: "spin 1s linear infinite", margin: "0 auto 14px" }} />
          Import en cours…
        </div>
      )}

      {step === "done" && (
        <div>
          <div style={{ fontSize: 15, fontWeight: 800, color: C.text, marginBottom: 12 }}>Import terminé</div>
          {results.map((r, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "8px 12px", background: r.ok ? C.greenSoft : C.redSoft, border: `1px solid ${r.ok ? "#bbf7d0" : "#fecaca"}`, borderRadius: 8, marginBottom: 6, fontSize: 13 }}>
              <span style={{ fontWeight: 700 }}>{r.ref}</span>
              <span style={{ color: r.ok ? C.green : C.red }}>{r.ok ? `✓ ${r.msg}` : `✕ ${r.msg}`}</span>
            </div>
          ))}
          <button onClick={reset} style={{ ...btn(C.blue, "#fff"), marginTop: 12, width: "100%" }}>Importer un autre fichier</button>
        </div>
      )}
    </div>
  );
}

function chip(bg: string, color: string): React.CSSProperties {
  return { background: bg, color, borderRadius: 8, padding: "3px 9px", fontWeight: 700, fontSize: 11 };
}
function btn(bg: string, color: string, border?: string): React.CSSProperties {
  return { padding: "9px 16px", background: bg, color, border: border ? `1.5px solid ${border}` : "none", borderRadius: 10, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" };
}
