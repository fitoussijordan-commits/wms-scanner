"use client";
// components/PlanningVsCommande.tsx
// ────────────────────────────────────────────────────────────────────────────
// Rapprochement mensuel Planning / Commande / Réception + Accuracy.
// Étape 1 : on plugue les fichiers sources (commande fournisseur, réception),
// on détecte/corrige le mapping des colonnes, on calcule le tableau mensuel
// et on exporte en .xlsx.
//
// Jointure : sur l'Article No. (code Wala allemand) présent dans les 2 fichiers.
// Réception : SOMME des quantités par article (plusieurs lots par article).
// ────────────────────────────────────────────────────────────────────────────
import { useState, useMemo } from "react";

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

async function readSheet(file: File): Promise<{ headers: string[]; rows: any[] }> {
  const XLSX = await loadXLSX();
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const arr: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
  let headerIdx = 0;
  for (let i = 0; i < Math.min(arr.length, 10); i++) {
    const nonEmpty = arr[i].filter((c) => String(c).trim()).length;
    if (nonEmpty >= 3) { headerIdx = i; break; }
  }
  const headers = arr[headerIdx].map((h, i) => String(h).trim() || `Col${i + 1}`);
  const rows = arr.slice(headerIdx + 1).map((r) => {
    const o: any = {};
    headers.forEach((h, i) => { o[h] = r[i]; });
    return o;
  });
  return { headers, rows };
}

function guessCol(headers: string[], keywords: string[]): string {
  const norm = (s: string) => s.toLowerCase().replace(/[\s._\-]/g, "");
  for (const kw of keywords) {
    const k = norm(kw);
    const hit = headers.find((h) => norm(h) === k) || headers.find((h) => norm(h).includes(k));
    if (hit) return hit;
  }
  return "";
}

const toNum = (v: any) => {
  if (v == null || v === "") return 0;
  const n = parseFloat(String(v).replace(/\s/g, "").replace(",", "."));
  return isNaN(n) ? 0 : n;
};

interface SourceFile { name: string; headers: string[]; rows: any[]; }

const C = {
  bg: "#f8fafc", white: "#fff", text: "#0f172a", muted: "#64748b", border: "#e2e8f0",
  blue: "#2563eb", blueSoft: "#eff6ff", green: "#16a34a", red: "#dc2626",
};

const MONTHS = ["Janvier","Février","Mars","Avril","Mai","Juin","Juillet","Août","Septembre","Octobre","Novembre","Décembre"];

export default function PlanningVsCommande() {
  const [month, setMonth] = useState<string>(MONTHS[new Date().getMonth()]);
  const [order, setOrder] = useState<SourceFile | null>(null);
  const [reception, setReception] = useState<SourceFile | null>(null);
  const [orderMap, setOrderMap] = useState({ article: "", qty: "", price: "", name: "" });
  const [recMap, setRecMap] = useState({ article: "", qty: "" });
  const [computed, setComputed] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);

  const onDrop = async (which: "order" | "reception", file: File) => {
    const { headers, rows } = await readSheet(file);
    if (which === "order") {
      setOrder({ name: file.name, headers, rows });
      setOrderMap({
        article: guessCol(headers, ["Article No.", "Article-No.", "ArticleNo", "articleno"]),
        qty: guessCol(headers, ["Order Qty.", "Order Qty", "OrderQty", "quantité commandée", "qty"]),
        price: guessCol(headers, ["Gross Price", "Prix", "Price", "prixcommande"]),
        name: guessCol(headers, ["Product Name French", "Product Name English", "Désignation", "Description"]),
      });
    } else {
      setReception({ name: file.name, headers, rows });
      setRecMap({
        article: guessCol(headers, ["Article-No.", "Article No.", "ArticleNo", "articleno"]),
        qty: guessCol(headers, ["Quantity", "Qty", "quantité", "reçu"]),
      });
    }
    setComputed(null);
  };

  const compute = () => {
    if (!order) return;
    setBusy(true);
    try {
      const recByArticle: Record<string, number> = {};
      if (reception && recMap.article && recMap.qty) {
        for (const r of reception.rows) {
          const art = String(r[recMap.article] ?? "").trim();
          if (!art) continue;
          recByArticle[art] = (recByArticle[art] || 0) + toNum(r[recMap.qty]);
        }
      }
      const out = order.rows
        .filter((r) => String(r[orderMap.article] ?? "").trim())
        .map((r) => {
          const article = String(r[orderMap.article]).trim();
          const orderQty = toNum(r[orderMap.qty]);
          const price = orderMap.price ? toNum(r[orderMap.price]) : 0;
          const name = orderMap.name ? String(r[orderMap.name] ?? "") : "";
          const received = recByArticle[article] ?? 0;
          const ruptQty = received - orderQty;
          const ruptEuro = ruptQty * price;
          const budgetOrder = orderQty * price;
          return { article, name, orderQty, price, budgetOrder, received, ruptQty, ruptEuro };
        });
      setComputed(out);
    } finally {
      setBusy(false);
    }
  };

  const totals = useMemo(() => {
    if (!computed) return null;
    const t = { order: 0, received: 0, budgetOrder: 0, ruptQty: 0, ruptEuro: 0, nbNonCmd: 0 };
    for (const r of computed) {
      t.order += r.orderQty; t.received += r.received; t.budgetOrder += r.budgetOrder;
      t.ruptQty += r.ruptQty; t.ruptEuro += r.ruptEuro;
      if (r.orderQty === 0) t.nbNonCmd++;
    }
    return t;
  }, [computed]);

  const exportXlsx = async () => {
    if (!computed) return;
    const XLSX = await loadXLSX();
    const data = computed.map((r) => ({
      "Article No.": r.article, "Désignation": r.name, "Order Qty.": r.orderQty,
      "Prix commande": r.price, "Budget commande": Math.round(r.budgetOrder * 100) / 100,
      "Réception finale": r.received, "Rupture Allemagne Qté": r.ruptQty,
      "Rupture Allemagne €": Math.round(r.ruptEuro * 100) / 100,
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, month.slice(0, 3));
    XLSX.writeFile(wb, `planning_vs_commande_${month}.xlsx`);
  };

  const DropZone = ({ label, src, which, mapUI }: { label: string; src: SourceFile | null; which: "order" | "reception"; mapUI: React.ReactNode }) => (
    <div style={{ background: C.white, border: `1.5px dashed ${src ? C.green : C.border}`, borderRadius: 12, padding: 16, flex: 1, minWidth: 260 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 8 }}>{label}</div>
      <label style={{ display: "inline-block", padding: "8px 14px", background: C.blueSoft, color: C.blue, borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>
        {src ? "Changer de fichier" : "📎 Choisir un fichier"}
        <input type="file" accept=".xlsx,.xls" style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onDrop(which, f); }} />
      </label>
      {src && <div style={{ fontSize: 11.5, color: C.muted, marginTop: 6 }}>{src.name} · {src.rows.length} lignes</div>}
      {src && <div style={{ marginTop: 10 }}>{mapUI}</div>}
    </div>
  );

  const MapSelect = ({ label, headers, value, onChange }: { label: string; headers: string[]; value: string; onChange: (v: string) => void }) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
      <span style={{ fontSize: 11.5, color: C.muted, minWidth: 90 }}>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        style={{ flex: 1, padding: "5px 8px", border: `1px solid ${value ? C.border : C.red}`, borderRadius: 6, fontSize: 12, background: C.white }}>
        <option value="">— colonne —</option>
        {headers.map((h) => <option key={h} value={h}>{h}</option>)}
      </select>
    </div>
  );

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", fontFamily: "'DM Sans', sans-serif" }}>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: C.text, margin: "0 0 4px" }}>Planning vs Commande</h2>
        <p style={{ fontSize: 12.5, color: C.muted, margin: 0 }}>Dépose la commande fournisseur et la réception, vérifie le mapping, calcule et exporte le mois.</p>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: C.muted }}>Mois :</span>
        <select value={month} onChange={(e) => setMonth(e.target.value)}
          style={{ padding: "7px 12px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, background: C.white }}>
          {MONTHS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 16 }}>
        <DropZone label="1. Commande fournisseur (Order Form)" src={order} which="order" mapUI={order && (
          <>
            <MapSelect label="Article No." headers={order.headers} value={orderMap.article} onChange={(v) => setOrderMap({ ...orderMap, article: v })} />
            <MapSelect label="Qté commandée" headers={order.headers} value={orderMap.qty} onChange={(v) => setOrderMap({ ...orderMap, qty: v })} />
            <MapSelect label="Prix" headers={order.headers} value={orderMap.price} onChange={(v) => setOrderMap({ ...orderMap, price: v })} />
            <MapSelect label="Désignation" headers={order.headers} value={orderMap.name} onChange={(v) => setOrderMap({ ...orderMap, name: v })} />
          </>
        )} />
        <DropZone label="2. Réception (RG Wala)" src={reception} which="reception" mapUI={reception && (
          <>
            <MapSelect label="Article-No." headers={reception.headers} value={recMap.article} onChange={(v) => setRecMap({ ...recMap, article: v })} />
            <MapSelect label="Qté reçue" headers={reception.headers} value={recMap.qty} onChange={(v) => setRecMap({ ...recMap, qty: v })} />
          </>
        )} />
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
        <button onClick={compute} disabled={!order || !orderMap.article || !orderMap.qty || busy}
          style={{ padding: "10px 18px", background: (order && orderMap.article && orderMap.qty) ? C.blue : C.border, color: "#fff", border: "none", borderRadius: 10, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
          {busy ? "Calcul…" : "🧮 Calculer le mois"}
        </button>
        {computed && (
          <button onClick={exportXlsx} style={{ padding: "10px 18px", background: C.green, color: "#fff", border: "none", borderRadius: 10, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
            📥 Exporter Excel
          </button>
        )}
      </div>

      {totals && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
          {[
            ["Commandé", totals.order.toLocaleString("fr-FR")],
            ["Reçu", totals.received.toLocaleString("fr-FR")],
            ["Budget commande €", Math.round(totals.budgetOrder).toLocaleString("fr-FR")],
            ["Rupture All. €", Math.round(totals.ruptEuro).toLocaleString("fr-FR")],
            ["Réfs non commandées", totals.nbNonCmd],
          ].map(([label, val]) => (
            <div key={label as string} style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: "10px 16px", minWidth: 120 }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: C.text }}>{val}</div>
              <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
            </div>
          ))}
        </div>
      )}

      {computed && (
        <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
          <div style={{ maxHeight: 460, overflow: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead style={{ position: "sticky", top: 0, background: C.bg }}>
                <tr>
                  {["Article No.", "Désignation", "Commandé", "Reçu", "Rupture Qté", "Rupture €"].map((h) => (
                    <th key={h} style={{ textAlign: h === "Désignation" ? "left" : "right", padding: "8px 12px", fontSize: 10.5, textTransform: "uppercase", color: C.muted, borderBottom: `1px solid ${C.border}` }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {computed.map((r, i) => (
                  <tr key={i} style={{ borderBottom: `1px solid ${C.bg}` }}>
                    <td style={{ padding: "6px 12px", fontFamily: "monospace" }}>{r.article}</td>
                    <td style={{ padding: "6px 12px", color: C.muted, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</td>
                    <td style={{ padding: "6px 12px", textAlign: "right" }}>{r.orderQty}</td>
                    <td style={{ padding: "6px 12px", textAlign: "right" }}>{r.received}</td>
                    <td style={{ padding: "6px 12px", textAlign: "right", color: r.ruptQty < 0 ? C.red : C.text, fontWeight: r.ruptQty < 0 ? 700 : 400 }}>{r.ruptQty}</td>
                    <td style={{ padding: "6px 12px", textAlign: "right", color: r.ruptEuro < 0 ? C.red : C.text }}>{Math.round(r.ruptEuro).toLocaleString("fr-FR")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
