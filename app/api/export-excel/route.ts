// app/api/export-excel/route.ts
// Génération Excel directement en Node.js avec exceljs (plus de dépendance Python)

import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";

export const maxDuration = 30;

// ── Palette ──────────────────────────────────────────────────────────────────
const TEAL    = "0D9488";
const TEAL_S  = "F0FDFA";
const ORANGE  = "F97316";
const ORANGE_S= "FFF7ED";
const PURPLE  = "7C3AED";
const PURPLE_S= "F5F3FF";
const BLUE    = "3B82F6";
const BLUE_S  = "EFF6FF";
const DARK    = "1A1A2E";
const GRAY    = "6B7280";
const LGRAY   = "F1F5F9";
const WHITE   = "FFFFFF";
const GREEN   = "22C55E";

const PIE_COLORS = [TEAL, ORANGE, PURPLE, BLUE, GREEN,
  "F43F5E","EAB308","06B6D4","8B5CF6","EC4899",
  "14B8A6","F59E0B","6366F1","10B981","EF4444"];

function hdr(ws: ExcelJS.Worksheet, row: number, col: number, value: string, bgHex: string, colSpan?: number) {
  const cell = ws.getCell(row, col);
  cell.value = value;
  cell.font = { bold: true, color: { argb: "FF" + WHITE }, size: 11, name: "Calibri" };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + bgHex } };
  cell.alignment = { horizontal: "center", vertical: "middle" };
  if (colSpan) ws.mergeCells(row, col, row, col + colSpan - 1);
}

function dataCell(cell: ExcelJS.Cell, value: any, bgHex: string, align: "left"|"center"|"right" = "left") {
  cell.value = value;
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + bgHex } };
  cell.alignment = { horizontal: align, vertical: "middle" };
  cell.border = {
    top: { style: "thin", color: { argb: "FFE5E7EB" } },
    bottom: { style: "thin", color: { argb: "FFE5E7EB" } },
    left: { style: "thin", color: { argb: "FFE5E7EB" } },
    right: { style: "thin", color: { argb: "FFE5E7EB" } },
  };
  cell.font = { size: 10, name: "Calibri", color: { argb: "FF" + DARK } };
}

function fmtEur(cell: ExcelJS.Cell) { cell.numFmt = '#,##0 "€"'; }
function fmtPct(cell: ExcelJS.Cell) { cell.numFmt = '0.0%'; }

// ── Feuille Récapitulatif ────────────────────────────────────────────────────
function buildRecap(wb: ExcelJS.Workbook, results: any[], catchalls: any[]) {
  const ws = wb.addWorksheet("Récapitulatif");
  ws.views = [{ showGridLines: false }];

  // Titre
  ws.mergeCells("A1:F1");
  const title = ws.getCell("A1");
  title.value = "Analyse des Offres";
  title.font = { bold: true, size: 16, color: { argb: "FF" + WHITE }, name: "Calibri" };
  title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + TEAL } };
  title.alignment = { horizontal: "center", vertical: "middle" };
  ws.getRow(1).height = 36;

  // Sous-titre
  ws.mergeCells("A2:F2");
  const sub = ws.getCell("A2");
  const today = new Date().toLocaleDateString("fr-FR");
  sub.value = `Exporté le ${today} — CA Hors Taxes`;
  sub.font = { italic: true, size: 10, color: { argb: "FF" + GRAY }, name: "Calibri" };
  sub.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + TEAL_S } };
  sub.alignment = { horizontal: "center", vertical: "middle" };
  ws.getRow(2).height = 20;
  ws.getRow(3).height = 6;

  // En-têtes
  const hdrs = ["Code Offre", "Libellé", "CA HT Total", "Qté Vendue", "Commandes", "Délégués"];
  ws.addRow([]);
  const hRow = ws.addRow(hdrs);
  hRow.height = 24;
  hRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: "FF" + WHITE }, size: 10, name: "Calibri" };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + DARK } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = { top: { style: "thin", color: { argb: "FFE5E7EB" } }, bottom: { style: "thin", color: { argb: "FFE5E7EB" } }, left: { style: "thin", color: { argb: "FFE5E7EB" } }, right: { style: "thin", color: { argb: "FFE5E7EB" } } };
  });

  // Données offres
  const allRows = [...results, ...catchalls.map(c => ({
    offre: { code: c.codeInterne, label: "Note interne" },
    caTotal: c.data?.caTotal ?? 0,
    qtyTotal: c.data?.qtyTotal ?? 0,
    debugOrders: c.data?.debugOrders ?? [],
    delegues: c.data?.delegues ?? [],
    isCatchall: true,
  }))];

  allRows.forEach((r, i) => {
    const bg = i % 2 === 0 ? WHITE : LGRAY;
    const row = ws.addRow([
      r.offre?.code ?? "",
      r.offre?.label ?? "",
      r.caTotal ?? 0,
      r.qtyTotal ?? 0,
      (r.debugOrders ?? []).length,
      (r.delegues ?? []).length,
    ]);
    row.height = 22;
    row.eachCell((cell, col) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + bg } };
      cell.border = { top: { style: "thin", color: { argb: "FFE5E7EB" } }, bottom: { style: "thin", color: { argb: "FFE5E7EB" } }, left: { style: "thin", color: { argb: "FFE5E7EB" } }, right: { style: "thin", color: { argb: "FFE5E7EB" } } };
      cell.alignment = { horizontal: col <= 2 ? "left" : "center", vertical: "middle" };
      cell.font = { size: 10, name: "Calibri", color: { argb: "FF" + DARK } };
    });
    const caCell = row.getCell(3);
    caCell.font = { bold: true, color: { argb: "FF" + (r.isCatchall ? ORANGE : TEAL) }, size: 11, name: "Calibri" };
    fmtEur(caCell);
  });

  // Total — données démarrent ligne 6 (1=titre, 2=sous-titre, 3=spacer, 4=vide, 5=headers)
  const dataEnd = 5 + allRows.length;
  const totRow = ws.addRow(["TOTAL", "", { formula: `SUM(C6:C${dataEnd})` }, { formula: `SUM(D6:D${dataEnd})` }, "", ""]);
  totRow.height = 26;
  totRow.eachCell(cell => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + TEAL } };
    cell.font = { bold: true, color: { argb: "FF" + WHITE }, size: 11, name: "Calibri" };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = { top: { style: "thin", color: { argb: "FFE5E7EB" } }, bottom: { style: "thin", color: { argb: "FFE5E7EB" } }, left: { style: "thin", color: { argb: "FFE5E7EB" } }, right: { style: "thin", color: { argb: "FFE5E7EB" } } };
  });
  fmtEur(totRow.getCell(3));

  ws.columns = [
    { width: 14 }, { width: 28 }, { width: 16 },
    { width: 14 }, { width: 12 }, { width: 12 },
  ];
}

// ── Feuille par offre ────────────────────────────────────────────────────────
function buildOffreSheet(wb: ExcelJS.Workbook, r: any) {
  const code  = r.offre?.code ?? "Offre";
  const label = r.offre?.label ?? "";
  const ca    = r.caTotal ?? 0;
  const qty   = r.qtyTotal ?? 0;
  const prods = r.produits ?? [];
  const delegs= r.delegues ?? [];
  const orders= r.debugOrders ?? [];

  const ws = wb.addWorksheet(String(code).slice(0, 31));
  ws.views = [{ showGridLines: false }];

  // Titre
  ws.mergeCells("A1:G1");
  const t = ws.getCell("A1");
  t.value = `Offre ${code}${label ? " — " + label : ""}`;
  t.font = { bold: true, size: 15, color: { argb: "FF" + WHITE }, name: "Calibri" };
  t.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + TEAL } };
  t.alignment = { horizontal: "center", vertical: "middle" };
  ws.getRow(1).height = 38;

  // KPIs
  ws.mergeCells("A2:B2");
  const kCA = ws.getCell("A2"); kCA.value = "CA HT Total";
  kCA.font = { bold: true, color: { argb: "FF" + TEAL }, size: 10, name: "Calibri" };
  kCA.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + TEAL_S } };
  kCA.alignment = { horizontal: "center", vertical: "middle" };
  ws.mergeCells("C2:D2");
  const kCAv = ws.getCell("C2"); kCAv.value = ca;
  kCAv.font = { bold: true, color: { argb: "FF" + TEAL }, size: 16, name: "Calibri" };
  kCAv.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + TEAL_S } };
  kCAv.alignment = { horizontal: "center", vertical: "middle" };
  fmtEur(kCAv);
  const kQ = ws.getCell("E2"); kQ.value = "Qté"; kQ.font = { bold: true, color: { argb: "FF" + ORANGE }, size: 10, name: "Calibri" }; kQ.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + ORANGE_S } }; kQ.alignment = { horizontal: "center", vertical: "middle" };
  const kQv = ws.getCell("F2"); kQv.value = qty; kQv.font = { bold: true, color: { argb: "FF" + ORANGE }, size: 16, name: "Calibri" }; kQv.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + ORANGE_S } }; kQv.alignment = { horizontal: "center", vertical: "middle" };
  const kO = ws.getCell("G2"); kO.value = `${orders.length} commandes`; kO.font = { bold: true, color: { argb: "FF" + GRAY }, size: 10, name: "Calibri" }; kO.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + LGRAY } }; kO.alignment = { horizontal: "center", vertical: "middle" };
  ws.getRow(2).height = 36;
  ws.getRow(3).height = 8;

  let cursor = 4;

  // Produits
  if (prods.length > 0) {
    hdr(ws, cursor, 1, "Produits composants", BLUE, 5); ws.getRow(cursor).height = 24; cursor++;
    const ph = ws.addRow(["Référence", "Nom produit", "Qté vendue", "CA HT (€)", "% CA"]);
    ph.height = 20;
    ph.eachCell(cell => { cell.font = { bold: true, color: { argb: "FF1D4ED8" }, size: 10, name: "Calibri" }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFBFDBFE" } }; cell.alignment = { horizontal: "center", vertical: "middle" }; cell.border = { top: { style: "thin", color: { argb: "FFE5E7EB" } }, bottom: { style: "thin", color: { argb: "FFE5E7EB" } }, left: { style: "thin", color: { argb: "FFE5E7EB" } }, right: { style: "thin", color: { argb: "FFE5E7EB" } } }; });
    cursor++;
    const pdataStart = cursor;
    prods.forEach((p: any, i: number) => {
      const bg = i % 2 === 0 ? WHITE : BLUE_S;
      const row = ws.addRow([p.ref ?? "", p.name ?? "", p.qtyVendue ?? 0, p.ca ?? 0, ca > 0 ? (p.ca ?? 0) / ca : 0]);
      row.height = 20;
      row.eachCell((cell, col) => { dataCell(cell, cell.value, bg, col <= 2 ? "left" : "center"); });
      fmtEur(row.getCell(4)); fmtPct(row.getCell(5));
      cursor++;
    });
    const tot = ws.addRow(["TOTAL", "", { formula: `SUM(C${pdataStart}:C${cursor - 1})` }, { formula: `SUM(D${pdataStart}:D${cursor - 1})` }, ""]);
    tot.height = 22;
    tot.eachCell(cell => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + TEAL } }; cell.font = { bold: true, color: { argb: "FF" + WHITE }, size: 10, name: "Calibri" }; cell.alignment = { horizontal: "center", vertical: "middle" }; cell.border = { top: { style: "thin", color: { argb: "FFE5E7EB" } }, bottom: { style: "thin", color: { argb: "FFE5E7EB" } }, left: { style: "thin", color: { argb: "FFE5E7EB" } }, right: { style: "thin", color: { argb: "FFE5E7EB" } } }; });
    fmtEur(tot.getCell(4));
    cursor++;
    ws.getRow(cursor).height = 8; cursor++;
  }

  // Délégués
  if (delegs.length > 0) {
    hdr(ws, cursor, 1, "Par délégué", PURPLE, 4); ws.getRow(cursor).height = 24; cursor++;
    const dh = ws.addRow(["Délégué", "Qté vendue", "CA HT (€)", "% CA"]);
    dh.height = 20;
    dh.eachCell(cell => { cell.font = { bold: true, color: { argb: "FF" + PURPLE }, size: 10, name: "Calibri" }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEDE9FE" } }; cell.alignment = { horizontal: "center", vertical: "middle" }; cell.border = { top: { style: "thin", color: { argb: "FFE5E7EB" } }, bottom: { style: "thin", color: { argb: "FFE5E7EB" } }, left: { style: "thin", color: { argb: "FFE5E7EB" } }, right: { style: "thin", color: { argb: "FFE5E7EB" } } }; });
    cursor++;
    const ddStart = cursor;
    delegs.forEach((d: any, i: number) => {
      const bg = i % 2 === 0 ? WHITE : PURPLE_S;
      const row = ws.addRow([d.name ?? "", d.qtyVendue ?? 0, d.ca ?? 0, ca > 0 ? (d.ca ?? 0) / ca : 0]);
      row.height = 20;
      row.eachCell((cell, col) => { dataCell(cell, cell.value, bg, col === 1 ? "left" : "center"); });
      fmtEur(row.getCell(3)); fmtPct(row.getCell(4));
      cursor++;
    });
    const dtot = ws.addRow(["TOTAL", "", { formula: `SUM(C${ddStart}:C${cursor - 1})` }, ""]);
    dtot.height = 22;
    dtot.eachCell(cell => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + PURPLE } }; cell.font = { bold: true, color: { argb: "FF" + WHITE }, size: 10, name: "Calibri" }; cell.alignment = { horizontal: "center", vertical: "middle" }; cell.border = { top: { style: "thin", color: { argb: "FFE5E7EB" } }, bottom: { style: "thin", color: { argb: "FFE5E7EB" } }, left: { style: "thin", color: { argb: "FFE5E7EB" } }, right: { style: "thin", color: { argb: "FFE5E7EB" } } }; });
    fmtEur(dtot.getCell(3));
    cursor++;
  }

  ws.columns = [
    { width: 14 }, { width: 36 }, { width: 14 },
    { width: 16 }, { width: 10 }, { width: 3 }, { width: 16 },
  ];
}

// ── Feuille Commandes Note ───────────────────────────────────────────────────
function buildCommandesNote(wb: ExcelJS.Workbook, catchalls: any[]) {
  const ws = wb.addWorksheet("Commandes Note");
  ws.views = [{ showGridLines: false }];

  ws.mergeCells("A1:D1");
  const t = ws.getCell("A1"); t.value = "Commandes sans code offre (note interne)";
  t.font = { bold: true, size: 14, color: { argb: "FF" + WHITE }, name: "Calibri" };
  t.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + ORANGE } };
  t.alignment = { horizontal: "center", vertical: "middle" };
  ws.getRow(1).height = 34;
  ws.getRow(2).height = 6;

  const hRow = ws.addRow(["Commande", "Client", "Note interne", "CA HT (lignes)"]);
  hRow.height = 22;
  hRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: "FF" + WHITE }, size: 10, name: "Calibri" };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + DARK } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = { top: { style: "thin", color: { argb: "FFE5E7EB" } }, bottom: { style: "thin", color: { argb: "FFE5E7EB" } }, left: { style: "thin", color: { argb: "FFE5E7EB" } }, right: { style: "thin", color: { argb: "FFE5E7EB" } } };
  });

  let rowIdx = 0;
  for (const c of catchalls) {
    const orders = c.data?.debugOrders ?? [];
    const sorted = [...orders].sort((a: any, b: any) => a.name.localeCompare(b.name));
    for (const o of sorted) {
      const bg = rowIdx % 2 === 0 ? WHITE : ORANGE_S;
      const cleanName = o.name.replace(" (note)", "");
      const row = ws.addRow([cleanName, o.partnerName ?? "", c.codeInterne, ""]);
      row.height = 20;
      row.eachCell((cell, col) => { dataCell(cell, cell.value, bg, col === 4 ? "right" : "left"); });
      rowIdx++;
    }
  }

  ws.columns = [{ width: 14 }, { width: 40 }, { width: 16 }, { width: 16 }];
}

// ── Feuille Toutes Commandes ─────────────────────────────────────────────────
function buildToutesCommandes(wb: ExcelJS.Workbook, results: any[], catchalls: any[]) {
  const ws = wb.addWorksheet("Toutes Commandes");
  ws.views = [{ showGridLines: false }];

  ws.mergeCells("A1:E1");
  const t = ws.getCell("A1"); t.value = "Toutes les commandes — Offres + Notes";
  t.font = { bold: true, size: 14, color: { argb: "FF" + WHITE }, name: "Calibri" };
  t.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + DARK } };
  t.alignment = { horizontal: "center", vertical: "middle" };
  ws.getRow(1).height = 34;
  ws.getRow(2).height = 6;

  const hRow = ws.addRow(["Commande", "Client", "N° Offre", "Libellé offre", "Type"]);
  hRow.height = 22;
  hRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: "FF" + WHITE }, size: 10, name: "Calibri" };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + DARK } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = { top: { style: "thin", color: { argb: "FFE5E7EB" } }, bottom: { style: "thin", color: { argb: "FFE5E7EB" } }, left: { style: "thin", color: { argb: "FFE5E7EB" } }, right: { style: "thin", color: { argb: "FFE5E7EB" } } };
  });

  // Collecter toutes les commandes (dédupliquées)
  const seen = new Set<string>();
  const allOrders: { name: string; partnerName: string; offreCode: string; offreLabel: string; type: string }[] = [];

  for (const r of results) {
    for (const o of (r.debugOrders ?? [])) {
      const cleanName = String(o.name).replace(" (note)", "");
      if (!seen.has(cleanName)) {
        seen.add(cleanName);
        allOrders.push({ name: cleanName, partnerName: o.partnerName ?? "", offreCode: String(r.offre?.code ?? ""), offreLabel: r.offre?.label ?? "", type: "Offre" });
      }
    }
  }
  for (const c of catchalls) {
    for (const o of (c.data?.debugOrders ?? [])) {
      const cleanName = String(o.name).replace(" (note)", "");
      if (!seen.has(cleanName)) {
        seen.add(cleanName);
        allOrders.push({ name: cleanName, partnerName: o.partnerName ?? "", offreCode: String(c.codeInterne), offreLabel: "Note interne", type: "Note" });
      }
    }
  }

  allOrders.sort((a, b) => a.name.localeCompare(b.name));

  allOrders.forEach((o, i) => {
    const isNote = o.type === "Note";
    const bg = isNote ? ORANGE_S : (i % 2 === 0 ? WHITE : LGRAY);
    const row = ws.addRow([o.name, o.partnerName, o.offreCode, o.offreLabel, o.type]);
    row.height = 20;
    row.eachCell((cell, col) => {
      dataCell(cell, cell.value, bg, col === 3 ? "center" : col === 5 ? "center" : "left");
      // N° offre : gras teal (offre) ou orange (note)
      if (col === 3) {
        cell.font = { bold: true, color: { argb: "FF" + (isNote ? ORANGE : TEAL) }, size: 10, name: "Calibri" };
        cell.numFmt = "@"; // forcer texte pour éviter conversion numérique
      }
      if (col === 5 && isNote) {
        cell.font = { bold: true, color: { argb: "FF" + ORANGE }, size: 10, name: "Calibri" };
      }
    });
  });

  ws.columns = [{ width: 14 }, { width: 40 }, { width: 14 }, { width: 36 }, { width: 10 }];
}

// ── Feuille Synthèse par article ─────────────────────────────────────────────
function buildSynthese(wb: ExcelJS.Workbook, results: any[], catchalls: any[]) {
  const ws = wb.addWorksheet("Synthèse Articles");
  ws.views = [{ showGridLines: false }];

  ws.mergeCells("A1:E1");
  const t = ws.getCell("A1"); t.value = "Synthèse — Total vendu par article";
  t.font = { bold: true, size: 14, color: { argb: "FF" + WHITE }, name: "Calibri" };
  t.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + TEAL } };
  t.alignment = { horizontal: "center", vertical: "middle" };
  ws.getRow(1).height = 34;
  ws.getRow(2).height = 6;

  const hRow = ws.addRow(["Référence", "Nom article", "Qté totale vendue", "CA HT total", "% CA"]);
  hRow.height = 22;
  hRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: "FF" + WHITE }, size: 10, name: "Calibri" };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + DARK } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = { top: { style: "thin", color: { argb: "FFE5E7EB" } }, bottom: { style: "thin", color: { argb: "FFE5E7EB" } }, left: { style: "thin", color: { argb: "FFE5E7EB" } }, right: { style: "thin", color: { argb: "FFE5E7EB" } } };
  });

  // Agréger tous les produits toutes offres + catchalls confondus
  const artMap: Record<string, { name: string; qty: number; ca: number }> = {};

  for (const r of results) {
    for (const p of (r.produits ?? [])) {
      const key = p.ref || p.name || String(p.productId);
      if (!artMap[key]) artMap[key] = { name: p.name ?? key, qty: 0, ca: 0 };
      artMap[key].qty += p.qtyVendue ?? 0;
      artMap[key].ca += p.ca ?? 0;
    }
  }
  for (const c of catchalls) {
    for (const p of (c.data?.produits ?? [])) {
      const key = p.ref || p.name || String(p.productId);
      if (!artMap[key]) artMap[key] = { name: p.name ?? key, qty: 0, ca: 0 };
      artMap[key].qty += p.qtyVendue ?? 0;
      artMap[key].ca += p.ca ?? 0;
    }
  }

  const articles = Object.entries(artMap)
    .map(([ref, v]) => ({ ref, ...v }))
    .sort((a, b) => b.ca - a.ca);

  const totalCA = articles.reduce((s, a) => s + a.ca, 0);
  const dataStart = 4; // row après titre + spacer + header

  articles.forEach((a, i) => {
    const bg = i % 2 === 0 ? WHITE : TEAL_S;
    const row = ws.addRow([a.ref, a.name, a.qty, a.ca, totalCA > 0 ? a.ca / totalCA : 0]);
    row.height = 20;
    row.eachCell((cell, col) => {
      dataCell(cell, cell.value, bg, col <= 2 ? "left" : "center");
      if (col === 4) { fmtEur(cell); cell.font = { bold: true, color: { argb: "FF" + TEAL }, size: 10, name: "Calibri" }; }
      if (col === 5) fmtPct(cell);
      if (col === 3) { cell.font = { bold: true, color: { argb: "FF" + DARK }, size: 10, name: "Calibri" }; }
    });
  });

  // Total
  const totRow = ws.addRow(["TOTAL", "", { formula: `SUM(C${dataStart}:C${dataStart + articles.length - 1})` }, { formula: `SUM(D${dataStart}:D${dataStart + articles.length - 1})` }, ""]);
  totRow.height = 24;
  totRow.eachCell(cell => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + TEAL } };
    cell.font = { bold: true, color: { argb: "FF" + WHITE }, size: 11, name: "Calibri" };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = { top: { style: "thin", color: { argb: "FFE5E7EB" } }, bottom: { style: "thin", color: { argb: "FFE5E7EB" } }, left: { style: "thin", color: { argb: "FFE5E7EB" } }, right: { style: "thin", color: { argb: "FFE5E7EB" } } };
  });
  fmtEur(totRow.getCell(4));

  ws.columns = [{ width: 16 }, { width: 44 }, { width: 18 }, { width: 16 }, { width: 10 }];
}

// ── Handler ──────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const results: any[] = (body.results ?? []).filter((r: any) => !r.loading && !r.error);
    const catchalls: any[] = (body.catchalls ?? []).filter((c: any) => !c.loading && c.data);

    const wb = new ExcelJS.Workbook();
    wb.creator = "WMS Scanner";
    wb.created = new Date();

    buildRecap(wb, results, catchalls);
    buildSynthese(wb, results, catchalls);
    for (const r of results) buildOffreSheet(wb, r);
    if (catchalls.some(c => (c.data?.debugOrders ?? []).length > 0)) {
      buildCommandesNote(wb, catchalls);
    }
    if (results.length > 0 || catchalls.length > 0) {
      buildToutesCommandes(wb, results, catchalls);
    }

    const buffer = await wb.xlsx.writeBuffer();
    return new NextResponse(buffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename=analyse_offres_${new Date().toISOString().slice(0, 10)}.xlsx`,
      },
    });
  } catch (e: any) {
    console.error("[export-excel]", e);
    return NextResponse.json({ error: "Erreur génération Excel: " + e.message }, { status: 500 });
  }
}
