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
import { useState, useMemo, useEffect } from "react";
import * as odoo from "@/lib/odoo";
import { loadPlanningSynthese, savePlanningMonth, type PlanningMonth } from "@/lib/supabase";

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

// Lit le workbook une fois → renvoie l'objet wb + la liste des feuilles.
async function readWorkbook(file: File): Promise<{ wb: any; sheets: string[] }> {
  const XLSX = await loadXLSX();
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  return { wb, sheets: wb.SheetNames as string[] };
}

// Extrait { headers, rows } d'une feuille donnée d'un workbook déjà lu.
function parseSheet(wb: any, sheetName: string): { headers: string[]; rows: any[] } {
  const XLSX = (window as any).XLSX;
  const ws = wb.Sheets[sheetName];
  const arr: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
  let headerIdx = 0;
  for (let i = 0; i < Math.min(arr.length, 10); i++) {
    const nonEmpty = arr[i].filter((c: any) => String(c).trim()).length;
    if (nonEmpty >= 3) { headerIdx = i; break; }
  }
  const headers = (arr[headerIdx] || []).map((h: any, i: number) => String(h).trim() || `Col${i + 1}`);
  const rows = arr.slice(headerIdx + 1).map((r) => {
    const o: any = {};
    headers.forEach((h: string, i: number) => { o[h] = r[i]; });
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

interface SourceFile { name: string; headers: string[]; rows: any[]; wb?: any; sheets?: string[]; sheet?: string; }

const C = {
  bg: "#f8fafc", white: "#fff", text: "#0f172a", muted: "#64748b", border: "#e2e8f0",
  blue: "#2563eb", blueSoft: "#eff6ff", green: "#16a34a", red: "#dc2626",
};

const MONTHS = ["Janvier","Février","Mars","Avril","Mai","Juin","Juillet","Août","Septembre","Octobre","Novembre","Décembre"];

// Liste Best Sellers (Ref FR + Gamme) — top produits à suivre. Modifiable ici si besoin.
const BEST_SELLERS: { ref: string; gamme: string }[] = [
  { ref: "1010101", gamme: "Visage" },
  { ref: "1010310", gamme: "Visage" },
  { ref: "1010359", gamme: "Visage" },
  { ref: "1010302", gamme: "Visage" },
  { ref: "1010601", gamme: "Visage" },
  { ref: "1010201", gamme: "Visage" },
  { ref: "1010102", gamme: "Visage" },
  { ref: "1010377", gamme: "Visage" },
  { ref: "1030704", gamme: "Corps" },
  { ref: "1030301", gamme: "Corps" },
  { ref: "1030703", gamme: "Corps" },
  { ref: "1020720", gamme: "Régénérant Visage" },
  { ref: "1010306", gamme: "Visage" },
  { ref: "1020301", gamme: "Régénérant Visage" },
  { ref: "1010305", gamme: "Visage" },
  { ref: "1020202", gamme: "Régénérant Visage" },
  { ref: "1050403", gamme: "Med" },
  { ref: "1010116", gamme: "Visage" },
  { ref: "1010353", gamme: "Visage" },
  { ref: "1010501", gamme: "Visage" },
  { ref: "1020718", gamme: "Régénérant Visage" },
  { ref: "1010202", gamme: "Visage" },
  { ref: "1010360", gamme: "Visage" },
  { ref: "1050406", gamme: "Med" },
  { ref: "1010209", gamme: "Visage" },
];

export default function PlanningVsCommande({ session }: { session: odoo.OdooSession | null }) {
  const [month, setMonth] = useState<string>(MONTHS[new Date().getMonth()]);
  const [matching, setMatching] = useState(false);
  const [order, setOrder] = useState<SourceFile | null>(null);
  const [reception, setReception] = useState<SourceFile | null>(null);
  const [forecastJ, setForecastJ] = useState<SourceFile | null>(null);
  const [forecastS, setForecastS] = useState<SourceFile | null>(null);
  const [orderMap, setOrderMap] = useState({ article: "", qty: "", price: "", name: "" });
  const [recMap, setRecMap] = useState({ article: "", qty: "" });
  // Forecast : clé Ref FR (ou code Wala) + colonne du mois choisi.
  const [fjMap, setFjMap] = useState({ ref: "", monthCol: "" });
  const [fsMap, setFsMap] = useState({ ref: "", monthCol: "" });
  const [computed, setComputed] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);
  const YEAR = new Date().getFullYear();
  const [savedMonths, setSavedMonths] = useState<PlanningMonth[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => { loadPlanningSynthese(YEAR).then(setSavedMonths).catch(() => {}); }, [YEAR]);

  const saveMonth = async () => {
    if (!totals) return;
    setSaving(true);
    try {
      const m: PlanningMonth = {
        month, forecast: totals.forecast, order: totals.order, received: totals.received,
        budgetOrder: totals.budgetOrder, ruptEuro: totals.ruptEuro, accuracy: totals.accuracy, nbNonCmd: totals.nbNonCmd,
        budgetSissi: totals.budgetFinal, budgetSissiEur: totals.budgetFinEur, budgetForecastEur: totals.budgetForecastEur,
        varBudgetQty: totals.order - totals.budgetFinal, varBudgetEur: totals.budgetOrder - totals.budgetFinEur,
      };
      await savePlanningMonth(YEAR, m);
      setSavedMonths(await loadPlanningSynthese(YEAR));
    } catch { /* silencieux */ }
    setSaving(false);
  };

  // Devine la colonne du mois. Les fichiers ont 12 colonnes-mois en initiales (J F M A M J J A S O N D).
  // On repère la SÉQUENCE de 12 colonnes dont l'en-tête est une initiale de mois, et on prend la idx-ième.
  const guessMonthCol = (headers: string[], monthName: string): string => {
    const idx = MONTHS.indexOf(monthName); // 0..11
    // Colonnes = initiale d'UN caractère parmi JFMASOND (les vraies colonnes-mois).
    const monthCols = headers.filter(h => /^[JFMASOND]$/i.test(String(h).trim()));
    if (monthCols.length >= 12) return monthCols[idx];                       // 12 initiales → idx-ième
    // Sinon : nom complet du mois en en-tête (ex "Juillet").
    const exact = headers.find(h => String(h).trim().toLowerCase() === monthName.toLowerCase());
    if (exact) return exact;
    // Dernier recours : abréviation 3 lettres qui commence par le mois.
    const abbr = headers.find(h => String(h).trim().toLowerCase().startsWith(monthName.toLowerCase().slice(0, 3)));
    return abbr || (monthCols[idx] || "");
  };

  // Quand on change de MOIS : recalcule la colonne-mois des forecasts déjà chargés.
  useEffect(() => {
    if (forecastJ) setFjMap(m => ({ ...m, monthCol: guessMonthCol(forecastJ.headers, month) }));
    if (forecastS) setFsMap(m => ({ ...m, monthCol: guessMonthCol(forecastS.headers, month) }));
    setComputed(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  // Applique le mapping auto d'une source selon son type, sur les en-têtes donnés.
  const autoMap = (kind: "order" | "reception" | "j" | "s", headers: string[]) => {
    if (kind === "order") setOrderMap({
      article: guessCol(headers, ["Article No.", "Article-No.", "ArticleNo", "articleno"]),
      qty: guessCol(headers, ["Order Qty.", "Order Qty", "OrderQty", "quantité commandée", "qty"]),
      price: guessCol(headers, ["Gross Price", "Prix", "Price", "prixcommande"]),
      name: guessCol(headers, ["Product Name French", "Product Name English", "Désignation", "Description"]),
    });
    else if (kind === "reception") setRecMap({
      article: guessCol(headers, ["Article-No.", "Article No.", "ArticleNo", "articleno"]),
      qty: guessCol(headers, ["Quantity", "Qty", "quantité", "reçu"]),
    });
    else if (kind === "j") setFjMap({ ref: guessCol(headers, ["REF FR", "RefFR", "Ref FR", "default_code"]), monthCol: guessMonthCol(headers, month) });
    else if (kind === "s") setFsMap({ ref: guessCol(headers, ["REF FR", "RefFR", "Ref FR", "default_code"]), monthCol: guessMonthCol(headers, month) });
  };

  // Choisit automatiquement la meilleure feuille selon le type (nom d'onglet).
  const pickBestSheet = (kind: "order" | "reception" | "j" | "s", sheets: string[]): string => {
    const rx: Record<string, RegExp> = {
      j: /pr[ée]vision|jordan|forecast/i,
      s: /budget|sissi|planning budget/i,
      reception: /rg|wala|r[ée]ception|sheet/i,
      order: /order|commande|tabelle/i,
    };
    return sheets.find(s => rx[kind].test(s)) || sheets[0];
  };

  const setSourceFromWb = (kind: "order" | "reception" | "j" | "s", name: string, wb: any, sheets: string[], sheet: string) => {
    const { headers, rows } = parseSheet(wb, sheet);
    const sf: SourceFile = { name, headers, rows, wb, sheets, sheet };
    if (kind === "order") setOrder(sf);
    else if (kind === "reception") setReception(sf);
    else if (kind === "j") setForecastJ(sf);
    else setForecastS(sf);
    autoMap(kind, headers);
    setComputed(null);
  };

  const onDropAny = async (kind: "order" | "reception" | "j" | "s", file: File) => {
    const { wb, sheets } = await readWorkbook(file);
    const best = pickBestSheet(kind, sheets);
    setSourceFromWb(kind, file.name, wb, sheets, best);
  };

  // Changer d'onglet sur une source déjà chargée (menu déroulant).
  const changeSheet = (kind: "order" | "reception" | "j" | "s", src: SourceFile, sheet: string) => {
    if (!src.wb) return;
    setSourceFromWb(kind, src.name, src.wb, src.sheets || [], sheet);
  };

  const onDropForecast = (which: "j" | "s", file: File) => onDropAny(which, file);
  const onDrop = (which: "order" | "reception", file: File) => onDropAny(which, file);

  const compute = async () => {
    if (!order) return;
    setBusy(true);
    try {
      // Réception : SOMME par article (plusieurs lots).
      const recByArticle: Record<string, number> = {};
      if (reception && recMap.article && recMap.qty) {
        for (const r of reception.rows) {
          const art = String(r[recMap.article] ?? "").trim();
          if (!art) continue;
          recByArticle[art] = (recByArticle[art] || 0) + toNum(r[recMap.qty]);
        }
      }

      const base = order.rows
        .filter((r) => String(r[orderMap.article] ?? "").trim())
        .map((r) => {
          const article = String(r[orderMap.article]).trim();
          const orderQty = toNum(r[orderMap.qty]);
          const price = orderMap.price ? toNum(r[orderMap.price]) : 0;
          const nameSrc = orderMap.name ? String(r[orderMap.name] ?? "") : "";
          const received = recByArticle[article] ?? 0;
          const ruptQty = received - orderQty;
          const ruptEuro = ruptQty * price;
          const budgetOrder = orderQty * price;
          return { article, nameSrc, orderQty, price, budgetOrder, received, ruptQty, ruptEuro };
        });

      // Matching Odoo : code fournisseur Wala (article) → Ref FR + désignation + prix d'achat Odoo.
      let odooMap: Record<string, { defaultCode: string; name: string }> = {};
      let priceMap: Record<string, number> = {};
      if (session) {
        setMatching(true);
        try {
          const codes = Array.from(new Set(base.map((b) => b.article)));
          const [m, prices] = await Promise.all([
            odoo.matchWalaArticles(session, codes),
            odoo.getWalaPurchasePrices(session, codes),
          ]);
          for (const [code, v] of Object.entries(m)) {
            odooMap[code] = { defaultCode: (v as any).defaultCode || "", name: (v as any).name || "" };
          }
          priceMap = prices;
        } catch { /* si le matching échoue, on garde les données brutes */ }
        setMatching(false);
      }

      // Index forecast par Ref FR ET par code Wala (double clé, robuste).
      const buildForecastIndex = (src: SourceFile | null, map: { ref: string; monthCol: string }) => {
        const idx: Record<string, number> = {};
        if (!src || !map.monthCol) return idx;
        for (const r of src.rows) {
          const qty = toNum(r[map.monthCol]);
          const refKey = map.ref ? String(r[map.ref] ?? "").trim() : "";
          if (refKey && refKey !== "#N/A") idx[refKey] = qty;
          // 2e clé : si le forecast a une colonne Material (code Wala), on l'indexe aussi
          const walaCol = src.headers.find(h => /material$|^material$|article/i.test(String(h)));
          if (walaCol) { const w = String(r[walaCol] ?? "").trim(); if (w) idx["W:" + w] = qty; }
        }
        return idx;
      };
      const fjIdx = buildForecastIndex(forecastJ, fjMap);
      const fsIdx = buildForecastIndex(forecastS, fsMap);
      const lookForecast = (idx: Record<string, number>, refFR: string, wala: string) =>
        (refFR && idx[refFR] != null) ? idx[refFR] : (idx["W:" + wala] != null ? idx["W:" + wala] : 0);

      const out = base.map((b) => {
        const od = odooMap[b.article];
        const refFR = od?.defaultCode || "";
        const D = b.orderQty;                                  // commandé
        const E = lookForecast(fjIdx, refFR, b.article);       // forecast Jordan
        const F = lookForecast(fsIdx, refFR, b.article);       // budget Sissi (planning final)
        // Prix d'achat = coût Odoo (standard_price) en priorité, sinon prix du fichier.
        const price = priceMap[b.article] != null && priceMap[b.article] > 0 ? priceMap[b.article] : b.price;
        // Recalcule budget et rupture € avec le prix Odoo.
        const budgetOrder = D * price;
        const ruptEuro = b.ruptQty * price;
        // Accuracy = min(Commandé, Forecast Jordan) / Forecast Jordan, cappé à 100%.
        // Dénominateur = E (Planning Jordan). "—" si E=0. (Sissi = comparaison à part.)
        const accRaw = E > 0 ? Math.min(D, E) / E : null;
        const accuracy = accRaw == null ? null : Math.min(accRaw, 1);
        // Emoji : ⬇️ si D<E, ⚠️ si reçu<commandé (rupture), 🔵 si D>E, ✅ si =.
        let accLabel = "—";
        if (E > 0) {
          const pct = Math.round((D / E) * 100);
          if (D < E) accLabel = `⬇️ ${pct}%`;
          else if (b.received < D) accLabel = `⚠️ ${pct}% (rupture)`;
          else if (D > E) accLabel = `🔵 ${pct}%`;
          else accLabel = "✅ 100%";
        }
        return {
          ...b,
          refFR, name: od?.name || "", matched: !!refFR,
          price, budgetOrder, ruptEuro,                        // ← recalculés avec le coût Odoo
          hasOdooPrice: priceMap[b.article] != null && priceMap[b.article] > 0,
          forecastJ: E, budgetFinal: F,
          diffQty: D - E,                                      // commandé - forecast Jordan
          budgetCmd: D * price, budgetForecast: E * price, budgetFin: F * price,
          accuracy, accLabel,
        };
      });
      setComputed(out);
    } finally {
      setBusy(false);
    }
  };

  const totals = useMemo(() => {
    if (!computed) return null;
    const t = { order: 0, received: 0, budgetOrder: 0, ruptQty: 0, ruptEuro: 0, nbNonCmd: 0,
      forecast: 0, budgetFinal: 0, budgetForecastEur: 0, budgetFinEur: 0, accuracy: 0 };
    // Accuracy globale = SOMME(min(Commandé, Forecast Jordan)) / SOMME(Forecast Jordan).
    let sumMinDE = 0, sumE = 0;
    for (const r of computed) {
      t.order += r.orderQty; t.received += r.received; t.budgetOrder += r.budgetOrder;
      t.ruptQty += r.ruptQty; t.ruptEuro += r.ruptEuro;
      t.forecast += r.forecastJ; t.budgetFinal += r.budgetFinal;
      t.budgetForecastEur += r.budgetForecast; t.budgetFinEur += r.budgetFin;
      if (r.orderQty === 0) t.nbNonCmd++;
      if (r.forecastJ > 0) { sumMinDE += Math.min(r.orderQty, r.forecastJ); sumE += r.forecastJ; }
    }
    t.accuracy = sumE > 0 ? sumMinDE / sumE : 0;
    return t;
  }, [computed]);

  // Top produits = lignes calculées dont la Ref FR est dans la liste Best Sellers (en dur).
  // Ordonnés selon l'ordre de la liste, avec la gamme attachée.
  const topProducts = useMemo(() => {
    if (!computed) return [] as any[];
    const info = new Map(BEST_SELLERS.map((b, i) => [b.ref, { i, gamme: b.gamme }]));
    return computed
      .filter(r => r.refFR && info.has(String(r.refFR).trim()))
      .map(r => ({ ...r, gamme: info.get(String(r.refFR).trim())!.gamme }))
      .sort((a, b) => info.get(String(a.refFR).trim())!.i - info.get(String(b.refFR).trim())!.i);
  }, [computed]);

  // Accuracy PAR GAMME : sur TOUTES les lignes calculées, regroupées par gamme
  // (gamme via la table Best Sellers ; les produits hors liste vont dans "Autres").
  const accuracyByGamme = useMemo(() => {
    if (!computed) return [] as { gamme: string; forecast: number; order: number; received: number; accuracy: number; nb: number }[];
    const gammeByRef = new Map(BEST_SELLERS.map(b => [b.ref, b.gamme]));
    const acc: Record<string, { forecast: number; order: number; received: number; sumMinDE: number; sumE: number; nb: number }> = {};
    for (const r of computed) {
      const g = gammeByRef.get(String(r.refFR).trim()) || "Autres";
      (acc[g] ||= { forecast: 0, order: 0, received: 0, sumMinDE: 0, sumE: 0, nb: 0 });
      acc[g].forecast += r.forecastJ; acc[g].order += r.orderQty; acc[g].received += r.received; acc[g].nb++;
      if (r.forecastJ > 0) { acc[g].sumMinDE += Math.min(r.orderQty, r.forecastJ); acc[g].sumE += r.forecastJ; }
    }
    return Object.entries(acc)
      .map(([gamme, v]) => ({ gamme, forecast: v.forecast, order: v.order, received: v.received, accuracy: v.sumE > 0 ? v.sumMinDE / v.sumE : 0, nb: v.nb }))
      .sort((a, b) => b.order - a.order);
  }, [computed]);

  const exportXlsx = async () => {
    if (!computed || !totals) return;
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    wb.creator = "WMS Scanner"; wb.created = new Date();

    const CL = {
      dark: "FF1E293B", accent: "FF2563EB", white: "FFFFFFFF", zebra: "FFF1F5F9",
      green: "FFDCFCE7", red: "FFFEE2E2", redT: "FFB91C1C", border: "FFE2E8F0", kpiBg: "FFEFF6FF",
    };
    const thin = { style: "thin" as const, color: { argb: CL.border } };
    const allB = { top: thin, left: thin, bottom: thin, right: thin };
    const eur = '#,##0.00 €'; const pct = '0 %';

    // ── Onglet DÉTAIL du mois ──
    const ws = wb.addWorksheet(month.slice(0, 3) + " 26");
    ws.columns = [
      { header: "Ref FR", key: "ref", width: 14 },
      { header: "Article No.", key: "art", width: 14 },
      { header: "Désignation", key: "name", width: 38 },
      { header: "Forecast", key: "fc", width: 11 },
      { header: "Commandé", key: "ord", width: 11 },
      { header: "Reçu", key: "rec", width: 11 },
      { header: "Prix", key: "price", width: 10 },
      { header: "Budget commande", key: "bud", width: 16 },
      { header: "Rupture Qté", key: "rq", width: 12 },
      { header: "Rupture €", key: "re", width: 13 },
      { header: "Accuracy", key: "acc", width: 12 },
    ];
    for (const r of computed) {
      ws.addRow({
        ref: r.refFR, art: r.article, name: r.name, fc: r.forecastJ, ord: r.orderQty, rec: r.received,
        price: r.price, bud: Math.round(r.budgetOrder * 100) / 100, rq: r.ruptQty,
        re: Math.round(r.ruptEuro * 100) / 100, acc: r.accLabel,
      });
    }
    // En-tête stylé
    const h = ws.getRow(1); h.height = 22;
    h.eachCell((c: any) => {
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CL.dark } };
      c.font = { bold: true, color: { argb: CL.white }, size: 11 };
      c.alignment = { vertical: "middle", horizontal: "center" }; c.border = allB;
    });
    ws.views = [{ state: "frozen", ySplit: 1 }];
    // Corps : formats, zebra, rupture en rouge
    for (let i = 2; i <= ws.rowCount; i++) {
      const row = ws.getRow(i);
      if (i % 2 === 0) row.eachCell((c: any) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CL.zebra } }; });
      row.eachCell((c: any) => { c.border = allB; });
      row.getCell("price").numFmt = eur; row.getCell("bud").numFmt = eur; row.getCell("re").numFmt = eur;
      const rq = row.getCell("rq"); if (Number(rq.value) < 0) { rq.font = { bold: true, color: { argb: CL.redT } }; }
      const re = row.getCell("re"); if (Number(re.value) < 0) { re.font = { color: { argb: CL.redT } }; }
    }

    // ── Onglet SYNTHÈSE (ligne du mois calculé + historique Supabase) ──
    const wsS = wb.addWorksheet("Synthèse");
    wsS.columns = [
      { header: "MOIS", key: "m", width: 14 },
      { header: "FORECAST", key: "fc", width: 12 },
      { header: "COMMANDÉ", key: "ord", width: 12 },
      { header: "REÇU", key: "rec", width: 12 },
      { header: "BUDGET CMD €", key: "bud", width: 16 },
      { header: "RUPTURE ALL €", key: "rupt", width: 16 },
      { header: "ACCURACY %", key: "acc", width: 13 },
      { header: "NB NON CMDÉS", key: "nb", width: 14 },
    ];
    const synthRows = [
      ...(savedMonths || []),
      { month, forecast: totals.forecast, order: totals.order, received: totals.received,
        budgetOrder: totals.budgetOrder, ruptEuro: totals.ruptEuro, accuracy: totals.accuracy, nbNonCmd: totals.nbNonCmd },
    ];
    // dédoublonne (garde la dernière version d'un mois), ordonne par calendrier
    const byMonth: Record<string, any> = {};
    for (const s of synthRows) byMonth[s.month] = s;
    const ordered = MONTHS.filter(m => byMonth[m]).map(m => byMonth[m]);
    for (const s of ordered) {
      wsS.addRow({ m: s.month, fc: Math.round(s.forecast), ord: Math.round(s.order), rec: Math.round(s.received),
        bud: Math.round(s.budgetOrder), rupt: Math.round(s.ruptEuro), acc: s.accuracy, nb: s.nbNonCmd });
    }
    const hS = wsS.getRow(1); hS.height = 22;
    hS.eachCell((c: any) => {
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CL.accent } };
      c.font = { bold: true, color: { argb: CL.white }, size: 11 };
      c.alignment = { vertical: "middle", horizontal: "center" }; c.border = allB;
    });
    for (let i = 2; i <= wsS.rowCount; i++) {
      const row = wsS.getRow(i);
      if (i % 2 === 0) row.eachCell((c: any) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CL.kpiBg } }; });
      row.eachCell((c: any) => { c.border = allB; });
      row.getCell("bud").numFmt = eur; row.getCell("rupt").numFmt = eur; row.getCell("acc").numFmt = pct;
    }

    // Helper : style d'en-tête + zebra + bordures pour un onglet.
    const styleSheet = (w: any, headerArgb: string, zebraArgb: string) => {
      const hh = w.getRow(1); hh.height = 22;
      hh.eachCell((c: any) => {
        c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: headerArgb } };
        c.font = { bold: true, color: { argb: CL.white }, size: 11 };
        c.alignment = { vertical: "middle", horizontal: "center" }; c.border = allB;
      });
      w.views = [{ state: "frozen", ySplit: 1 }];
      for (let i = 2; i <= w.rowCount; i++) {
        const row = w.getRow(i);
        if (i % 2 === 0) row.eachCell((c: any) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: zebraArgb } }; });
        row.eachCell((c: any) => { c.border = allB; });
      }
    };

    // ── Onglet ACCURACY PAR GAMME ──
    const wsG = wb.addWorksheet("Accuracy par gamme");
    wsG.columns = [
      { header: "GAMME", key: "g", width: 22 },
      { header: "NB RÉFS", key: "nb", width: 10 },
      { header: "FORECAST", key: "fc", width: 12 },
      { header: "COMMANDÉ", key: "ord", width: 12 },
      { header: "REÇU", key: "rec", width: 12 },
      { header: "ACCURACY %", key: "acc", width: 13 },
    ];
    for (const g of accuracyByGamme) {
      wsG.addRow({ g: g.gamme, nb: g.nb, fc: Math.round(g.forecast), ord: Math.round(g.order), rec: Math.round(g.received), acc: g.forecast > 0 ? g.accuracy : null });
    }
    styleSheet(wsG, "FF0891B2", "FFECFEFF");
    for (let i = 2; i <= wsG.rowCount; i++) wsG.getRow(i).getCell("acc").numFmt = pct;

    // ── Onglet TOP PRODUITS ──
    const wsT = wb.addWorksheet("Top produits");
    wsT.columns = [
      { header: "REF FR", key: "ref", width: 12 },
      { header: "PRODUIT", key: "name", width: 40 },
      { header: "GAMME", key: "gamme", width: 20 },
      { header: "FORECAST", key: "fc", width: 12 },
      { header: "COMMANDÉ", key: "ord", width: 12 },
      { header: "REÇU", key: "rec", width: 12 },
      { header: "ACCURACY", key: "acc", width: 14 },
    ];
    for (const r of topProducts) {
      wsT.addRow({ ref: r.refFR, name: r.name, gamme: r.gamme, fc: Math.round(r.forecastJ), ord: r.orderQty, rec: r.received, acc: r.accLabel });
    }
    styleSheet(wsT, "FFB45309", "FFFEF9C3");

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `planning_vs_commande_${month}.xlsx`; a.click();
    URL.revokeObjectURL(url);
  };

  const DropZone = ({ label, src, kind, onFile, mapUI }: { label: string; src: SourceFile | null; kind: "order" | "reception" | "j" | "s"; onFile: (f: File) => void; mapUI: React.ReactNode }) => (
    <div style={{ background: C.white, border: `1.5px dashed ${src ? C.green : C.border}`, borderRadius: 12, padding: 16, display: "flex", flexDirection: "column" }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 8 }}>{label}</div>
      <label style={{ display: "inline-block", padding: "8px 14px", background: C.blueSoft, color: C.blue, borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>
        {src ? "Changer de fichier" : "📎 Choisir un fichier"}
        <input type="file" accept=".xlsx,.xls,.xlsm" style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
      </label>
      {src && src.sheets && src.sheets.length > 1 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
          <span style={{ fontSize: 11.5, color: C.muted, width: 88, flexShrink: 0 }}>Onglet</span>
          <select value={src.sheet} onChange={(e) => changeSheet(kind, src, e.target.value)}
            style={{ flex: 1, minWidth: 0, padding: "5px 8px", border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12, background: C.white, fontWeight: 700 }}>
            {src.sheets.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      )}
      {src && <div style={{ fontSize: 11.5, color: C.muted, marginTop: 6 }}>{src.name} · {src.rows.length} lignes</div>}
      {src && <div style={{ marginTop: 10 }}>{mapUI}</div>}
    </div>
  );

  const MapSelect = ({ label, headers, value, onChange }: { label: string; headers: string[]; value: string; onChange: (v: string) => void }) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, minWidth: 0 }}>
      <span style={{ fontSize: 11.5, color: C.muted, width: 88, flexShrink: 0 }}>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        style={{ flex: 1, minWidth: 0, maxWidth: "100%", padding: "5px 8px", border: `1px solid ${value ? C.border : C.red}`, borderRadius: 6, fontSize: 12, background: C.white }}>
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

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14, marginBottom: 16, alignItems: "stretch" }}>
        <DropZone label="1. Commande fournisseur (Order Form)" src={order} kind="order" onFile={(f) => onDrop("order", f)} mapUI={order && (
          <>
            <MapSelect label="Article No." headers={order.headers} value={orderMap.article} onChange={(v) => setOrderMap({ ...orderMap, article: v })} />
            <MapSelect label="Qté commandée" headers={order.headers} value={orderMap.qty} onChange={(v) => setOrderMap({ ...orderMap, qty: v })} />
            <MapSelect label="Prix" headers={order.headers} value={orderMap.price} onChange={(v) => setOrderMap({ ...orderMap, price: v })} />
            <MapSelect label="Désignation" headers={order.headers} value={orderMap.name} onChange={(v) => setOrderMap({ ...orderMap, name: v })} />
          </>
        )} />
        <DropZone label="2. Réception (RG Wala)" src={reception} kind="reception" onFile={(f) => onDrop("reception", f)} mapUI={reception && (
          <>
            <MapSelect label="Article-No." headers={reception.headers} value={recMap.article} onChange={(v) => setRecMap({ ...recMap, article: v })} />
            <MapSelect label="Qté reçue" headers={reception.headers} value={recMap.qty} onChange={(v) => setRecMap({ ...recMap, qty: v })} />
          </>
        )} />
        <DropZone label="3. Forecast Jordan (optionnel)" src={forecastJ} kind="j" onFile={(f) => onDropForecast("j", f)} mapUI={forecastJ && (
          <>
            <MapSelect label="Ref FR" headers={forecastJ.headers} value={fjMap.ref} onChange={(v) => setFjMap({ ...fjMap, ref: v })} />
            <MapSelect label={`Colonne mois (${month})`} headers={forecastJ.headers} value={fjMap.monthCol} onChange={(v) => setFjMap({ ...fjMap, monthCol: v })} />
          </>
        )} />
        <DropZone label="4. Budget Sissi (optionnel)" src={forecastS} kind="s" onFile={(f) => onDropForecast("s", f)} mapUI={forecastS && (
          <>
            <MapSelect label="Ref FR" headers={forecastS.headers} value={fsMap.ref} onChange={(v) => setFsMap({ ...fsMap, ref: v })} />
            <MapSelect label={`Colonne mois (${month})`} headers={forecastS.headers} value={fsMap.monthCol} onChange={(v) => setFsMap({ ...fsMap, monthCol: v })} />
          </>
        )} />
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
        <button onClick={compute} disabled={!order || !orderMap.article || !orderMap.qty || busy}
          style={{ padding: "10px 18px", background: (order && orderMap.article && orderMap.qty) ? C.blue : C.border, color: "#fff", border: "none", borderRadius: 10, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
          {matching ? "Matching Odoo…" : busy ? "Calcul…" : "🧮 Calculer le mois"}
        </button>
        {computed && (
          <>
            <button onClick={exportXlsx} style={{ padding: "10px 18px", background: C.green, color: "#fff", border: "none", borderRadius: 10, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
              📥 Exporter Excel
            </button>
            <button onClick={saveMonth} disabled={saving} style={{ padding: "10px 18px", background: "#7c3aed", color: "#fff", border: "none", borderRadius: 10, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
              {saving ? "Enregistrement…" : `💾 Enregistrer ${month}`}
            </button>
          </>
        )}
      </div>

      {totals && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
          {[
            ["Forecast", Math.round(totals.forecast).toLocaleString("fr-FR")],
            ["Commandé", Math.round(totals.order).toLocaleString("fr-FR")],
            ["Reçu", Math.round(totals.received).toLocaleString("fr-FR")],
            ["Budget commande €", Math.round(totals.budgetOrder).toLocaleString("fr-FR")],
            ["Rupture All. €", Math.round(totals.ruptEuro).toLocaleString("fr-FR")],
            ["Accuracy", totals.forecast > 0 ? Math.round(totals.accuracy * 100) + "%" : "—"],
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
                  {["Ref FR", "Article No.", "Désignation", "Forecast", "Commandé", "Reçu", "Rupture Qté", "Accuracy"].map((h) => (
                    <th key={h} style={{ textAlign: (h === "Désignation" || h === "Ref FR" || h === "Article No.") ? "left" : "right", padding: "8px 12px", fontSize: 10.5, textTransform: "uppercase", color: C.muted, borderBottom: `1px solid ${C.border}` }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {computed.map((r, i) => (
                  <tr key={i} style={{ borderBottom: `1px solid ${C.bg}` }}>
                    <td style={{ padding: "6px 12px", fontFamily: "monospace", fontWeight: 700, color: r.matched ? C.text : C.red }}>{r.refFR || "—"}</td>
                    <td style={{ padding: "6px 12px", fontFamily: "monospace", color: C.muted }}>{r.article}</td>
                    <td style={{ padding: "6px 12px", color: C.muted, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</td>
                    <td style={{ padding: "6px 12px", textAlign: "right" }}>{r.forecastJ ? Math.round(r.forecastJ).toLocaleString("fr-FR") : "·"}</td>
                    <td style={{ padding: "6px 12px", textAlign: "right" }}>{r.orderQty}</td>
                    <td style={{ padding: "6px 12px", textAlign: "right" }}>{r.received}</td>
                    <td style={{ padding: "6px 12px", textAlign: "right", color: r.ruptQty < 0 ? C.red : C.text, fontWeight: r.ruptQty < 0 ? 700 : 400 }}>{r.ruptQty}</td>
                    <td style={{ padding: "6px 12px", textAlign: "right", whiteSpace: "nowrap" }}>{r.accLabel}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Synthèse annuelle (mois stockés Supabase) ── */}
      {savedMonths.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 8 }}>Synthèse {YEAR}</div>
          <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead style={{ background: C.blueSoft }}>
                <tr>
                  {["Mois", "Planif Sissi", "Commandé", "Reçu", "Budget Sissi €", "Budget cmd €", "Var budget €", "Rupture All. €", "Accuracy"].map((h) => (
                    <th key={h} style={{ textAlign: h === "Mois" ? "left" : "right", padding: "8px 12px", fontSize: 10.5, textTransform: "uppercase", color: C.blue, borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {MONTHS.filter(m => savedMonths.some(s => s.month === m)).map((m) => {
                  const s = savedMonths.find(x => x.month === m)!;
                  const varEur = s.varBudgetEur ?? (s.budgetOrder - (s.budgetSissiEur ?? 0));
                  return (
                    <tr key={m} style={{ borderBottom: `1px solid ${C.bg}` }}>
                      <td style={{ padding: "6px 12px", fontWeight: 700 }}>{m}</td>
                      <td style={{ padding: "6px 12px", textAlign: "right" }}>{Math.round(s.budgetSissi ?? 0).toLocaleString("fr-FR")}</td>
                      <td style={{ padding: "6px 12px", textAlign: "right" }}>{Math.round(s.order).toLocaleString("fr-FR")}</td>
                      <td style={{ padding: "6px 12px", textAlign: "right" }}>{Math.round(s.received).toLocaleString("fr-FR")}</td>
                      <td style={{ padding: "6px 12px", textAlign: "right" }}>{Math.round(s.budgetSissiEur ?? 0).toLocaleString("fr-FR")}</td>
                      <td style={{ padding: "6px 12px", textAlign: "right" }}>{Math.round(s.budgetOrder).toLocaleString("fr-FR")}</td>
                      <td style={{ padding: "6px 12px", textAlign: "right", color: varEur < 0 ? C.red : C.text, fontWeight: 700 }}>{Math.round(varEur).toLocaleString("fr-FR")}</td>
                      <td style={{ padding: "6px 12px", textAlign: "right", color: s.ruptEuro < 0 ? C.red : C.text }}>{Math.round(s.ruptEuro).toLocaleString("fr-FR")}</td>
                      <td style={{ padding: "6px 12px", textAlign: "right", fontWeight: 700 }}>{Math.round(s.accuracy * 100)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Accuracy par gamme ── */}
      {accuracyByGamme.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 8 }}>📊 Accuracy par gamme — {month}</div>
          <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead style={{ background: "#ecfeff" }}>
                <tr>
                  {["Gamme", "Nb réfs", "Forecast", "Commandé", "Reçu", "Accuracy"].map((h) => (
                    <th key={h} style={{ textAlign: h === "Gamme" ? "left" : "right", padding: "8px 12px", fontSize: 10.5, textTransform: "uppercase", color: "#0e7490", borderBottom: `1px solid ${C.border}` }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {accuracyByGamme.map((g, i) => (
                  <tr key={i} style={{ borderBottom: `1px solid ${C.bg}` }}>
                    <td style={{ padding: "6px 12px", fontWeight: 700 }}>{g.gamme}</td>
                    <td style={{ padding: "6px 12px", textAlign: "right", color: C.muted }}>{g.nb}</td>
                    <td style={{ padding: "6px 12px", textAlign: "right" }}>{Math.round(g.forecast).toLocaleString("fr-FR")}</td>
                    <td style={{ padding: "6px 12px", textAlign: "right" }}>{Math.round(g.order).toLocaleString("fr-FR")}</td>
                    <td style={{ padding: "6px 12px", textAlign: "right" }}>{Math.round(g.received).toLocaleString("fr-FR")}</td>
                    <td style={{ padding: "6px 12px", textAlign: "right", fontWeight: 700, color: g.forecast > 0 ? C.text : C.muted }}>{g.forecast > 0 ? Math.round(g.accuracy * 100) + "%" : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Top produits (Best Sellers) + leur accuracy pour le mois ── */}
      {topProducts.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 8 }}>⭐ Top produits — accuracy {month}</div>
          <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead style={{ background: "#fef9c3" }}>
                <tr>
                  {["Ref FR", "Produit", "Gamme", "Forecast", "Commandé", "Reçu", "Accuracy"].map((h) => (
                    <th key={h} style={{ textAlign: (h === "Ref FR" || h === "Produit" || h === "Gamme") ? "left" : "right", padding: "8px 12px", fontSize: 10.5, textTransform: "uppercase", color: "#854d0e", borderBottom: `1px solid ${C.border}` }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {topProducts.map((r, i) => (
                  <tr key={i} style={{ borderBottom: `1px solid ${C.bg}` }}>
                    <td style={{ padding: "6px 12px", fontFamily: "monospace", fontWeight: 700 }}>{r.refFR}</td>
                    <td style={{ padding: "6px 12px", color: C.muted, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</td>
                    <td style={{ padding: "6px 12px", color: C.muted }}>{r.gamme}</td>
                    <td style={{ padding: "6px 12px", textAlign: "right" }}>{r.forecastJ ? Math.round(r.forecastJ).toLocaleString("fr-FR") : "·"}</td>
                    <td style={{ padding: "6px 12px", textAlign: "right" }}>{r.orderQty}</td>
                    <td style={{ padding: "6px 12px", textAlign: "right" }}>{r.received}</td>
                    <td style={{ padding: "6px 12px", textAlign: "right", whiteSpace: "nowrap", fontWeight: 700 }}>{r.accLabel}</td>
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
