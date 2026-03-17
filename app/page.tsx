"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import * as odoo from "@/lib/odoo";
import * as pn from "@/lib/printnode";

import LabelEditor, { generateLabelPDF, LabelTemplate, LabelElement } from "@/components/LabelEditor";


// ── E-shop Packing Slip PDF (reproduit le format SendCloud) ────────────────────
async function generateEshopPackingSlipPDF(order: {
  order_number: string;
  order_date?: string;
  shipping_method?: string;
  recipient_name: string;
  recipient_address: string;
  recipient_postal: string;
  recipient_city: string;
  recipient_country: string;
  items: Array<{ name: string; sku: string; quantity: number; properties?: string }>;
}): Promise<string> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const W = 210; const M = 14;

  const BLACK = [0, 0, 0] as [number,number,number];
  const GRAY  = [100, 100, 100] as [number,number,number];
  const WHITE = [255, 255, 255] as [number,number,number];
  const BORDER = [180, 180, 180] as [number,number,number];
  const DARK = [30, 30, 30] as [number,number,number];

  let y = M;

  // ── Logo zone ──
  // Dr. Hauschka logo text (bold, large)
  doc.setFont("helvetica", "bold");
  doc.setFontSize(22);
  doc.setTextColor(...BLACK);
  doc.text("Dr. Hauschka", M, y + 10);

  // WALA logo circle symbol (simulate with ellipse lines)
  const cx = M + 6; const cy = y + 20;
  doc.setDrawColor(...BLACK);
  doc.setLineWidth(0.8);
  doc.ellipse(cx, cy, 5.5, 5.5);
  // Inner swirl lines to simulate WALA logo
  doc.setLineWidth(0.5);
  doc.ellipse(cx, cy, 3, 5);
  doc.ellipse(cx, cy, 5.5, 3);

  // WALA France bold under logo
  doc.setFontSize(13);
  doc.setFont("helvetica", "bold");
  doc.text("WALA France", M, y + 30);

  // ── Barcode (right side) ──
  const bcW = 65; const bcH = 18;
  const bcX = W - M - bcW; const bcY = y;
  doc.setDrawColor(...BLACK);
  // Draw barcode bars
  const bars = 80;
  for (let i = 0; i < bars; i++) {
    const thick = (i % 5 === 0 || i % 7 === 0) ? 1.2 : (i % 3 === 0 ? 0.6 : 0.3);
    doc.setLineWidth(thick);
    const x = bcX + (i / bars) * bcW;
    if (i % 2 === 0) doc.line(x, bcY, x, bcY + bcH);
  }
  // Barcode number under
  doc.setLineWidth(0.3);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(...BLACK);
  doc.text(`PS${order.order_number.padStart(16, "0")}`, bcX + bcW / 2, bcY + bcH + 4.5, { align: "center" });

  y += 36;

  // ── 3-column info table ──
  // Full-width bordered table
  const tW = W - M * 2;
  const col1W = 50; const col2W = 65; const col3W = tW - col1W - col2W;
  const col1X = M; const col2X = M + col1W; const col3X = M + col1W + col2W;
  const tH = 52;

  // Draw table border
  doc.setDrawColor(...BORDER);
  doc.setLineWidth(0.5);
  doc.rect(col1X, y, tW, tH);
  // Vertical separators
  doc.line(col2X, y, col2X, y + tH);
  doc.line(col3X, y, col3X, y + tH);

  let iy = y + 5;

  // Row 1 headers
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(...DARK);
  doc.text("Date de la\ncommande", col1X + 3, iy, { lineHeightFactor: 1.4 });
  doc.text("Expéditeur", col2X + 3, iy);
  doc.text("Destinataire", col3X + 3, iy);
  iy += 10;

  // Date value
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  const dateStr = order.order_date || new Date().toLocaleDateString("fr-FR", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  doc.text(dateStr, col1X + 3, iy);
  // Expéditeur value (bold name, normal rest)
  doc.setFont("helvetica", "bold");
  doc.text("WALA France", col2X + 3, iy);
  // Destinataire value (bold name)
  doc.text(order.recipient_name, col3X + 3, iy);
  iy += 5;

  // "Numéro de commande" label
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.text("Numéro de\ncommande", col1X + 3, iy, { lineHeightFactor: 1.4 });
  // Expéditeur continued
  doc.setFont("helvetica", "normal");
  doc.text("+33143553242", col2X + 3, iy);
  // Destinataire address
  doc.text(order.recipient_address, col3X + 3, iy);
  iy += 9;

  // Order number value
  doc.setFont("helvetica", "normal");
  doc.text(order.order_number, col1X + 3, iy);
  doc.text("35 Rue d'Hauteville", col2X + 3, iy);
  doc.text(order.recipient_postal, col3X + 3, iy);
  iy += 5;

  // Shipping method label
  doc.setFont("helvetica", "bold");
  doc.text("Méthode\nd'expédition", col1X + 3, iy, { lineHeightFactor: 1.4 });
  doc.setFont("helvetica", "normal");
  doc.text("75010", col2X + 3, iy);
  doc.text(order.recipient_city, col3X + 3, iy);
  iy += 9;

  // Shipping method value
  if (order.shipping_method) {
    const methodLines = doc.splitTextToSize(order.shipping_method, col1W - 6);
    methodLines.forEach((l: string, i: number) => doc.text(l, col1X + 3, iy + i * 4.5));
  }
  doc.text("Paris", col2X + 3, iy);
  doc.text("France", col3X + 3, iy);
  iy += 5;
  doc.text("France", col2X + 3, iy);

  y += tH + 10;

  // ── Articles table header ──
  const artTW = W - M * 2;
  const qtyW = 20;
  const artW = artTW - qtyW;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(...BLACK);
  doc.text("Article", M, y);
  doc.text("QTÉ", W - M - qtyW + 3, y);
  y += 3;

  // Bold separator line under header
  doc.setDrawColor(...BLACK);
  doc.setLineWidth(0.8);
  doc.line(M, y, W - M, y);
  y += 5;

  // ── Article rows ──
  doc.setLineWidth(0.4);
  doc.setDrawColor(...BORDER);

  for (const item of order.items) {
    const nameLines = doc.splitTextToSize(item.name, artW - 6);
    const hasProps = !!item.properties;
    const rowH = nameLines.length * 5 + (hasProps ? 5 : 0) + 6;

    // Article name — bold
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9.5);
    doc.setTextColor(...BLACK);
    nameLines.forEach((l: string, i: number) => doc.text(l, M, y + i * 5));

    // Properties — normal gray
    if (hasProps) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(...GRAY);
      doc.text(item.properties!, M, y + nameLines.length * 5);
    }

    // Quantity — right aligned
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    doc.setTextColor(...BLACK);
    doc.text(String(item.quantity), W - M - qtyW + 3, y);

    y += rowH;

    // Separator line
    doc.setDrawColor(...BORDER);
    doc.line(M, y, W - M, y);
    y += 4;
  }

  // ── Page footer ──
  y = 287 - M; // near bottom
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(...BLACK);
  doc.text("Page 1 / 1", M, y);

  return doc.output("datauristring").split(",")[1];
}

// ── Packing list PDF (A4, client-side via jsPDF) ──────────────────────────────
async function generatePackingListPDF(chain: {
  recipientName: string; recipientAddress: string;
  senderName: string; unit: string; orderRef: string;
  palettes: Array<{ id: string; lines: Array<{ ref: string; lot: string; qty: string }> }>;
}): Promise<void> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const W = 210; const margin = 14;
  const contentW = W - margin * 2;

  // ── Colors ──
  const DARK_BLUE  = [31, 73, 125]   as [number,number,number];
  const MID_BLUE   = [68, 114, 196]  as [number,number,number];
  const LIGHT_BLUE = [189, 215, 238] as [number,number,number];
  const YELLOW     = [255, 242, 102] as [number,number,number];
  const TOTAL_BG   = [213, 226, 242] as [number,number,number];
  const GRAY_LINE  = [220, 220, 220] as [number,number,number];
  const WHITE      = [255, 255, 255] as [number,number,number];
  const BLACK      = [0, 0, 0]       as [number,number,number];

  let y = margin;

  // ── Header band ──
  doc.setFillColor(...DARK_BLUE);
  doc.rect(0, 0, W, 18, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.setTextColor(...WHITE);
  doc.text("PACKING LIST  /  LISTE DE COLISAGE", W / 2, 11.5, { align: "center" });
  y = 26;

  // ── Sender / Recipient block ──
  const half = contentW / 2 - 3;
  // Left box — Expéditeur
  doc.setFillColor(245, 248, 255);
  doc.setDrawColor(...LIGHT_BLUE);
  doc.roundedRect(margin, y, half, 30, 2, 2, "FD");
  // Right box — Destinataire
  doc.roundedRect(margin + half + 6, y, half, 30, 2, 2, "FD");

  // Labels
  doc.setFontSize(7.5);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...MID_BLUE);
  doc.text("EXPÉDITEUR", margin + 4, y + 5);
  doc.text("DESTINATAIRE", margin + half + 10, y + 5);

  // Separator line under labels
  doc.setDrawColor(...LIGHT_BLUE);
  doc.line(margin + 4, y + 6.5, margin + half - 4, y + 6.5);
  doc.line(margin + half + 10, y + 6.5, margin + contentW - 4, y + 6.5);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(...BLACK);
  const senderLines = (chain.senderName || "WALA France").split("\n");
  senderLines.forEach((l, i) => doc.text(l, margin + 4, y + 11 + i * 4.5));

  const recipLines = [chain.recipientName, chain.recipientAddress].filter(Boolean) as string[];
  doc.setFont("helvetica", "bold");
  doc.text(recipLines[0] || "", margin + half + 10, y + 11);
  doc.setFont("helvetica", "normal");
  (recipLines.slice(1) as string[]).forEach((l, i) => doc.text(l, margin + half + 10, y + 15.5 + i * 4.5));
  y += 36;

  // ── Meta row (Date / N° CDE) ──
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8.5);
  doc.setTextColor(...DARK_BLUE);
  doc.text("Date :", margin, y + 5);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(...BLACK);
  doc.text(new Date().toLocaleDateString("fr-FR"), margin + 13, y + 5);
  if (chain.orderRef) {
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...DARK_BLUE);
    doc.text("N° CDE :", margin + 60, y + 5);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...BLACK);
    doc.text(chain.orderRef, margin + 79, y + 5);
  }
  y += 13;

  // ── Table ──
  const cols = [
    { label: "N°",          w: 14,  align: "center" as const },
    { label: "Code Article",w: 32,  align: "center" as const },
    { label: "Description", w: 72,  align: "left"   as const },
    { label: "Lot",         w: 36,  align: "center" as const },
    { label: "Quantité",    w: 28,  align: "center" as const },
  ];
  // Compute x positions
  let cx = margin;
  const colXs = cols.map(c => { const x = cx; cx += c.w; return x; });

  const rowH = 7;
  const headerH = 8;

  // Header
  doc.setFillColor(...MID_BLUE);
  doc.rect(margin, y, contentW, headerH, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8.5);
  doc.setTextColor(...WHITE);
  cols.forEach((c, i) => {
    const tx = c.align === "center" ? colXs[i] + c.w / 2 : colXs[i] + 2;
    doc.text(c.label, tx, y + 5.5, { align: c.align === "left" ? "left" : "center" });
  });
  y += headerH;

  // Rows
  const allRows: Array<{ pNum: number; ref: string; lot: string; qty: number }> = [];
  chain.palettes.forEach((pal, pi) => {
    pal.lines.filter(l => l.ref.trim()).forEach(l => {
      allRows.push({ pNum: pi + 1, ref: l.ref.trim(), lot: l.lot?.trim() || "", qty: Number(l.qty) || 0 });
    });
  });

  allRows.forEach((row, ri) => {
    const isOdd = row.pNum % 2 === 1;
    doc.setFillColor(...(isOdd ? YELLOW : LIGHT_BLUE));
    doc.rect(margin, y, contentW, rowH, "F");

    // subtle row border
    doc.setDrawColor(...GRAY_LINE);
    doc.setLineWidth(0.2);
    doc.line(margin, y + rowH, margin + contentW, y + rowH);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(8.5);
    doc.setTextColor(isOdd ? 120 : 40, isOdd ? 80 : 80, isOdd ? 0 : 120);
    doc.text("P" + row.pNum, colXs[0] + cols[0].w / 2, y + 4.8, { align: "center" });

    doc.setFont("helvetica", "normal");
    doc.setTextColor(...BLACK);
    doc.text(row.ref, colXs[1] + cols[1].w / 2, y + 4.8, { align: "center" });

    const descFit = doc.splitTextToSize(row.ref, cols[2].w - 3);
    doc.text(descFit[0] || "", colXs[2] + 2, y + 4.8);
    doc.text(row.lot || "", colXs[3] + cols[3].w / 2, y + 4.8, { align: "center" });
    doc.text(row.qty > 0 ? String(row.qty) : "", colXs[4] + cols[4].w / 2, y + 4.8, { align: "center" });

    y += rowH;
    if (y > 260) { doc.addPage(); y = margin; }
  });

  // Total row
  y += 1;
  const totalQty = allRows.reduce((s, r) => s + r.qty, 0);
  doc.setFillColor(...TOTAL_BG);
  doc.rect(margin, y, contentW, rowH + 1, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(...DARK_BLUE);
  doc.text("TOTAL", margin + contentW * 0.52, y + 5.5, { align: "center" });
  doc.text(String(totalQty), colXs[4] + cols[4].w / 2, y + 5.5, { align: "center" });
  y += rowH + 9;

  // ── Footer stats ──
  const uniqueRefs = new Set(allRows.map(r => r.ref)).size;
  const stats = [
    ["Nombre de références :", String(uniqueRefs)],
    ["Quantité totale :", String(totalQty)],
    ["Unité :", chain.unit || "Unités"],
  ];
  doc.setFontSize(9);
  stats.forEach(([label, val]) => {
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...DARK_BLUE);
    doc.text(label, margin + 50, y, { align: "right" });
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...BLACK);
    doc.text(val, margin + 53, y);
    y += 5.5;
  });

  // ── Footer line ──
  doc.setDrawColor(...MID_BLUE);
  doc.setLineWidth(0.5);
  doc.line(margin, 280, W - margin, 280);
  doc.setFontSize(7);
  doc.setTextColor(150, 150, 150);
  doc.text("Document généré automatiquement — WMS Scanner", W / 2, 284, { align: "center" });

  const blob = doc.output("blob");
  window.open(URL.createObjectURL(blob), "_blank");
}

const DH_LOGO = "data:image/png;base64,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ZUDLG4IY/DPfxtn0zPbM231v3/vfm+2u+v+de6Z79vV2z/T09OjSoASEAkKBtqDAp59+qh588EG1xhprWONZunSpOuyww9TGG29spTcjMm/ePDVz5kzVs2dPq/kVK1aoMWPGqL59+1rp7RzpIQyunadHxlY1Crz++utq2LBhLNrPPPOM2n333dm8MhOnTp2aMFOuzffff78lTJbru5601VAJHLsI9O7dOym++uqrq379+mW+NkXa6sSy+JouWrSIHfqAAQPUOuusw+YVTfzqq68UXigOBg4c2FFfUg4HSctSYJVVVskmfpey6qqrevMkg6fAah988IEaOnQon5sjdc0111SbbbaZ2nrrrdX++++vtt9++5Z8ZXIMrWlF3nvvPe9X9tprr1UXXnhhKX2/8MILCU25xlr1Nef6ljShQKdQIJHgfIPdYIMNEubVq1evRFKDxPbNN9+oV199Vb377rtJtS+//DKJI23SpElpU2eddZY655xz1LbbbpumxRIIfWX79OlTGpqguw/ka+6jjKQLBf5PgSCDu/jii4PSCFTbl156KVkUhd5O4ZZbblH4O/jgg9X111+vhgwZQrMlLBQQCggFmk4Bv8Kfo2swreOOO0498sgjyVrRFVdckan16KOPJirwb3/720yeJAgFhAJCgWZSoCEGRweG7evf/OY36sUXX6TJaRjMb88990zjEhAKCAWEAs2mQGkMzgx0xIgR6p133jFR64mFcdjyCAgFhAJCgVZQoHQGh0FjV9UnyWGtTtTVVkyt9CEUEAo0hcGBrJDkzjvvPJbCUFeL2t6xDUmiUEAoIBQIUKBpDA59cpsOZiznnnuuCcpTKCAUEAo0hQJNZXCw6PdJcU888YTCsRQBoYBQQCjQLAo0lcFh0D/60Y+8Y7///vu9eY1k4CiVgFDAUADvA07s4K9V7wb6aVVfBk95ZikQNPTNFi+eEjocfOWVV6o//OEP3kbnzJmjXnvtNTb/pJNOstKfe+459etf/1pBMjQwa9YsNXLkSBOt/BNnWx977DGFjR6cOsEpFAPYGBo1alRyzA7PoudpZ8yYkTAQ0555wivG0UcfbaI1nxMnTmQZww477KB23HHHmvVNAYzn3nvvVXfffbdJSp84oQMjdnjGKMM7Bxgn+nv44YfVU089ZdEVnR511FHqoosuatq7aPqfMmWKmj9/ftI/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atmyZUk7K1euVGeccYbafffdG2q3rMrTp09XF110kdp4442VkczuuOOOdI3NjLus/qSdzqWAMLjOnbu6R/7ll19m6i5fvtxKmzZtmiUFHXDAAW3D4BYuXKheffXV5M8MGgzOwDfffGOC6ZPDOc2UQLQUEBU12qn1I8apo717904rrLHGGspV6T766KM0v7sD7ljcsa6++uqZIXI4ZwpJQnQUEAYX3ZTWRuiDDz7IFOKYAi0Eg+B2AXcsrnS29tprK/xRWLx4MY1KuCIUEAZXkYk2aGIB/qWXXjLR5Alm0K9fvzQNa3Au0zAnH9JC3Rjo27dvsHfkb7rpplaZ2bNnR7dTbCEoEZYCwuBYssSbyEkygwcPVlBLDUBCcnchXYkITJD+mbrNeKIfCu5YkOduLGADwgUOd7eMxOOigDC4uOazJjaQZFzYZpttrCSXWSDTPcM5cuRItcUWWyR/kJjuv/9+q41GImhrhx12SP623nprhb4ouGNBnrvGtttuu9EqSdiVXDMFJCE6CsguanRTGkbo3nvvzRTADikF7FK6QFVY5GEXkwLHFGl+kfCHH36YaZ/Wd8eCvLlz56ptt902LTZ8+PA0bAIPPvigOu6440xUnhWggEhwFZhkiiJ37hRSEgUwCxc22mgjN8mKG3s0K7HOSK22uLHMnz/f6m377be34ohMnTo1kyYJcVNAGFzc82thN2PGDCtuIq4KyDHBQYMGmeLsYr1rqpEWriNA1wNNdXqUjEpqJv+6664zweS52WabWXET8dHA5MszLgoIg4trPoPYPPLII5n8o446KpM2adIkKw3eRyjTmTdvnpWPyPe///1MWr0JG264Yabq22+/baXBOwgF7PpSJoi88847jxZJwhwNMoUkIRoKCIOLZirDiGAncvz48ZlCRx99tJXmuhlC5hFHHGGVcdVBZK633npWmUYirokH2nrttdesJg8//HArjghOX1A47LDDaDQJ33nnncnubyZDEqKkgDC4KKc1i9Szzz6bTdQpe+21l5XO7YYeeOCBVpnHH3/cikM95Uw3rEIFIpy66/a59957Z1p0N1C4nVRIej5aZBqUhM6nQJdAJShw6KGHdum31frTap6Fu/7xW/kor5mNVearr75K0mhbWoW1ypQR0ZsE1lgwDvRNAWl0HAi/8847tEjXySefnCmj1XKrjETipYBIcPpX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";
// ============================================
// DESIGN TOKENS
// ============================================
const C = {
  bg: "#f5f6f8", white: "#ffffff", card: "#ffffff", overlay: "rgba(0,0,0,0.04)",
  blue: "#2563eb", blueSoft: "#eff6ff", blueBorder: "#bfdbfe", blueDark: "#1d4ed8",
  green: "#16a34a", greenSoft: "#f0fdf4", greenBorder: "#bbf7d0",
  orange: "#ea580c", orangeSoft: "#fff7ed", orangeBorder: "#fed7aa",
  red: "#dc2626", redSoft: "#fef2f2", redBorder: "#fecaca",
  text: "#111827", textSec: "#4b5563", textMuted: "#9ca3af",
  border: "#e5e7eb", borderStrong: "#d1d5db",
  shadow: "0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04)",
  shadowLg: "0 4px 12px rgba(0,0,0,0.1)",
};

// ============================================
// HAPTICS
// ============================================
function vibrate(pattern: number | number[] = 30) {
  try { navigator?.vibrate?.(pattern); } catch {}
}
function vibrateSuccess() { vibrate([30, 50, 30]); }
function vibrateError() { vibrate([100, 30, 100]); }

// ============================================
// LABEL PRINTING — Modal + PrintNode/fallback
// ============================================
interface PrintRequest {
  type: "product" | "lot" | "location" | "picking";
  title: string;
  barcode: string;
  ref?: string;
  lotName?: string;
  productName?: string;
  expiryDate?: string;
  locationName?: string;
}

// Global print state — set by components, read by modal
let _setPrintReq: ((r: PrintRequest | null) => void) | null = null;

function requestPrint(req: PrintRequest) {
  if (_setPrintReq) _setPrintReq(req);
}

async function executePrint(req: PrintRequest, copies: number) {
  const cfg = pn.getLabelTypeConfig(req.type as pn.LabelType);
  const printerId = cfg.printerId || pn.getSavedPrinterId();
  console.log("[executePrint] type:", req.type, "printerId:", printerId, "title:", req.title, "barcode:", req.barcode, "locationName:", req.locationName);
  if (printerId) {
    if (req.type === "product") return pn.printProductLabel(printerId, req.productName || req.title, req.barcode, req.ref, copies);
    if (req.type === "lot") return pn.printLotLabel(printerId, req.lotName || "", req.productName || "", req.barcode, req.expiryDate, copies);
    if (req.type === "location") return pn.printLocationLabel(printerId, req.locationName || req.title, req.barcode, copies);
    if (req.type === "picking") { const pickCfg = pn.getLabelTypeConfig("picking"); const pickPrinter = pickCfg.printerId || printerId; return pn.printBlankLabel(pickPrinter, { lines: [{ text: req.title, fontSize: 24, align: "C" as "C" }], barcode: req.barcode }, req.title, copies); }
  }
  // Fallback popup (single copy)
  printLabelPopup(req.title, req.barcode, req.barcode);
  return { success: true };
}

function printLabelPopup(title: string, barcode: string, displayCode: string) {
  const sz = pn.getLabelSize();
  const w = window.open("", "_blank", "width=400,height=320,menubar=no,toolbar=no");
  if (!w) return;
  const isEAN = /^\d{8}$|^\d{13}$/.test(barcode);
  const bcFormat = isEAN ? (barcode.length === 8 ? "EAN8" : "EAN13") : "CODE128";
  w.document.write(`<!DOCTYPE html>
<html><head>
<style>
  @page { size: ${sz.widthMM}mm ${sz.heightMM}mm; margin: 0; }
  @media print { body { margin: 0; padding: 0; } .no-print { display: none !important; } }
  body { margin: 0; padding: 8px; font-family: Arial, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; }
  .label { width: ${sz.widthMM - 4}mm; padding: 2mm; display: flex; flex-direction: column; align-items: center; text-align: center; }
  .title { font-size: 9pt; font-weight: 700; margin-bottom: 2mm; max-width: ${sz.widthMM - 6}mm; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; line-height: 1.2; }
  canvas { max-width: ${sz.widthMM - 8}mm; }
  .code { font-size: 7pt; font-family: monospace; margin-top: 1mm; letter-spacing: 1px; }
</style>
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"><\/script>
</head>
<body>
  <div class="label">
    <div class="title">${title.replace(/"/g, "&quot;")}</div>
    <canvas id="bc"></canvas>
    <div class="code">${displayCode}</div>
  </div>
  <button class="no-print" onclick="window.print()" style="margin-top:16px;padding:10px 24px;font-size:14px;font-weight:700;background:#2563eb;color:#fff;border:none;border-radius:8px;cursor:pointer;">Imprimer</button>
  <script>
    try { JsBarcode("#bc", "${barcode}", { format: "${bcFormat}", width: 2, height: 60, displayValue: false, margin: 0 }); }
    catch(e) { try { JsBarcode("#bc", "${barcode}", { format: "CODE128", width: 2, height: 60, displayValue: false, margin: 0 }); } catch(e2) {} }
    setTimeout(() => window.print(), 600);
  <\/script>
</body></html>`);
  w.document.close();
}

// ============================================
// HISTORY (localStorage)
// ============================================
const HIST_KEY = "wms_history";
interface HistoryEntry { date: string; from: string; to: string; lineCount: number; products: string[]; }
function saveHistory(entry: HistoryEntry) {
  try {
    const h: HistoryEntry[] = JSON.parse(localStorage.getItem(HIST_KEY) || "[]");
    h.unshift(entry);
    localStorage.setItem(HIST_KEY, JSON.stringify(h.slice(0, 30)));
  } catch {}
}
function loadHistory(): HistoryEntry[] {
  try { return JSON.parse(localStorage.getItem(HIST_KEY) || "[]"); } catch { return []; }
}
function clearHistory() {
  try { localStorage.removeItem(HIST_KEY); } catch {}
}

// ============================================
// SCANNER HOOK — Global Zebra key trapping
// ============================================
function useScannerListener(onScan: (code: string) => void, enabled: boolean) {
  const buf = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cb = useRef(onScan);
  cb.current = onScan;

  useEffect(() => {
    if (!enabled) return;
    const handle = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement;
      const inInput = tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.tagName === "SELECT";
      if (e.key === "Enter") {
        if (buf.current.length >= 3) {
          e.preventDefault(); e.stopPropagation();
          const code = buf.current; buf.current = "";
          if (timer.current) { clearTimeout(timer.current); timer.current = null; }
          cb.current(code);
          if (inInput && tgt instanceof HTMLInputElement) {
            const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
            if (s) { s.call(tgt, ""); tgt.dispatchEvent(new Event("input", { bubbles: true })); }
          }
          return;
        }
        buf.current = "";
        if (timer.current) { clearTimeout(timer.current); timer.current = null; }
        return;
      }
      if (e.key.length !== 1) return;
      buf.current += e.key;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => { buf.current = ""; timer.current = null; }, 50);
    };
    window.addEventListener("keydown", handle, true);
    return () => { window.removeEventListener("keydown", handle, true); if (timer.current) clearTimeout(timer.current); };
  }, [enabled]);
}

// Session
function saveSession(s: odoo.OdooSession) { try { sessionStorage.setItem("wms_s", JSON.stringify(s)); } catch {} }
function loadSess(): odoo.OdooSession | null { try { const s = sessionStorage.getItem("wms_s"); return s ? JSON.parse(s) : null; } catch { return null; } }
function clearSess() { try { sessionStorage.removeItem("wms_s"); } catch {} }
function saveCfg(u: string, d: string) { try { localStorage.setItem("wms_c", JSON.stringify({ u, d })); } catch {} }
function loadCfg(): { u: string; d: string } | null { try { const c = localStorage.getItem("wms_c"); return c ? JSON.parse(c) : null; } catch { return null; } }

// ============================================
// MAIN APP
// ============================================
export default function Page() {
  const [screen, setScreen] = useState<"login" | "home" | "transfer" | "done" | "prep" | "prepDetail" | "settings" | "history" | "arrival" | "labels" | "inventory" | "eshop" | "palettes">("login");
  const [session, setSession] = useState<odoo.OdooSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [locations, setLocations] = useState<any[]>([]);
  const [toast, setToast] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  // Transfer mode
  const [transferMode, setTransferMode] = useState<"classic" | "quick">("classic");

  // Lookup
  const [lookupResult, setLookupResult] = useState<any>(null);
  const [lookupStock, setLookupStock] = useState<any[]>([]);
  const [lookupType, setLookupType] = useState("");

  // Transfer state
  const [src, setSrc] = useState<any>(null);
  const [dst, setDst] = useState<any>(null);
  const [srcContent, setSrcContent] = useState<any[]>([]);
  const [dstContent, setDstContent] = useState<any[]>([]);
  const [lines, setLines] = useState<any[]>([]);
  const [curProduct, setCurProduct] = useState<any>(null);
  const [curLot, setCurLot] = useState<any>(null);
  const [curStock, setCurStock] = useState<any[]>([]);
  const [allStock, setAllStock] = useState<any[]>([]);
  const [feedback, setFeedback] = useState<{ t: string; m: string } | null>(null);

  // Preparation state
  const [pickings, setPickings] = useState<any[]>([]);
  const [selectedPicking, setSelectedPicking] = useState<any>(null);
  const [pickingMoves, setPickingMoves] = useState<any[]>([]);
  const [pickingMoveLines, setPickingMoveLines] = useState<any[]>([]);
  const [prepScanned, setPrepScanned] = useState<Set<number>>(new Set());
  // 2-step preparation: step 1 = scan location, step 2 = scan lot/barcode → +1 qty each scan
  const [prepStep, setPrepStep] = useState<{ locId: number; locName: string; lineId: number; productName: string; lotName?: string; remaining: number } | null>(null);
  // Refs so doPrepScan always reads current values (avoids stale closure)
  const prepStepRef = useRef<typeof prepStep>(null);
  const pickingMoveLinesRef = useRef<any[]>([]);
  const selectedPickingRef = useRef<any>(null);

  // Wrapper: updates both state and ref immediately (no async useEffect delay)
  const updatePrepStep = (val: typeof prepStep | ((prev: typeof prepStep) => typeof prepStep)) => {
    const newVal = typeof val === "function" ? val(prepStepRef.current) : val;
    prepStepRef.current = newVal;
    // Si on remet à null (fin d'emplacement), vider la queue pour éviter scans parasites
    if (newVal === null) scanQueueRef.current = [];
    setPrepStep(newVal);
  };

  // Print modal
  const [printReq, setPrintReq] = useState<PrintRequest | null>(null);
  useEffect(() => { _setPrintReq = setPrintReq; return () => { _setPrintReq = null; }; }, []);

  // Sync refs with state
  useEffect(() => { pickingMoveLinesRef.current = pickingMoveLines; }, [pickingMoveLines]);
  useEffect(() => { selectedPickingRef.current = selectedPicking; }, [selectedPicking]);

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(""), 2200); };

  // Global scan
  const handleGlobalScan = useCallback((code: string) => {
    vibrate();
    showToast(`⚡ ${code}`);
    if (screen === "home") doLookup(code);
    else if (screen === "transfer") {
      if (transferMode === "classic") doClassicScan(code);
      else doQuickScan(code);
    }
    else if (screen === "prep") {
      if (/^WH\//i.test(code)) { openPickingByName(code); return; }
    }
    else if (screen === "prepDetail") {
      scanQueueRef.current.push(code);
      processScanQueue();
    }
    setTimeout(() => {
      document.querySelectorAll("input").forEach((el) => {
        if (el.value === code || el.value.includes(code)) {
          const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
          if (s) { s.call(el, ""); el.dispatchEvent(new Event("input", { bubbles: true })); }
        }
      });
    }, 10);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, session, src, dst, transferMode]);

  useScannerListener(handleGlobalScan, screen !== "login");

  // Init
  useEffect(() => {
    const s = loadSess();
    if (s) { setSession(s); setScreen("home"); setHistory(loadHistory()); odoo.getLocations(s).then(setLocations).catch(() => { clearSess(); setScreen("login"); }); }
  }, []);

  const login = async (url: string, db: string, user: string, pw: string) => {
    setLoading(true); setError("");
    try {
      const cfg = { url: url.replace(/\/$/, ""), db };
      const s = await odoo.authenticate(cfg, user, pw);
      setSession(s); saveSession(s); saveCfg(url, db);
      setLocations(await odoo.getLocations(s));
      setHistory(loadHistory());
      setScreen("home");
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const logout = () => { setSession(null); clearSess(); setScreen("login"); resetTransfer(); };
  const goHome = () => { setScreen("home"); resetTransfer(); clearLookup(); };

  // Lookup
  const clearLookup = () => { setLookupResult(null); setLookupStock([]); setLookupType(""); setError(""); };
  const doLookup = async (code: string) => {
    if (!code || !session) return;
    setLoading(true); setError(""); clearLookup();
    try {
      const r = await odoo.smartScan(session, code);
      if (r.type === "product") { setLookupResult(r.data); setLookupType("product"); setLookupStock(await odoo.getAllStockForProduct(session, r.data.id)); vibrateSuccess(); }
      else if (r.type === "lot") { setLookupResult(r.data); setLookupType("lot"); if (r.data.product) setLookupStock(await odoo.getStockForLot(session, r.data.lot.id, r.data.product.id)); vibrateSuccess(); }
      else if (r.type === "location") { setLookupResult(r.data); setLookupType("location"); setLookupStock(await odoo.getProductsAtLocation(session, r.data.id)); vibrateSuccess(); }
      else { setError(`"${code}" — introuvable`); vibrateError(); }
    } catch (e: any) { setError(e.message); vibrateError(); }
    setLoading(false);
  };

  // Transfer
  const resetTransfer = () => { setSrc(null); setDst(null); setSrcContent([]); setDstContent([]); setLines([]); setCurProduct(null); setCurLot(null); setCurStock([]); setAllStock([]); setFeedback(null); setError(""); };
  const loadContent = async (locId: number) => { if (!session) return []; try { return await odoo.getProductsAtLocation(session, locId); } catch { return []; } };

  // === CLASSIC MODE ===
  const doClassicScan = async (code: string) => {
    if (!code || !session) return;
    setLoading(true); setError(""); setFeedback(null); setCurProduct(null); setCurLot(null); setCurStock([]);
    try {
      const r = await odoo.smartScan(session, code);
      if (r.type === "location") {
        if (!src) { setSrc(r.data); setFeedback({ t: "ok", m: `Source → ${r.data.name}` }); setSrcContent(await loadContent(r.data.id)); vibrateSuccess(); }
        else if (!dst) { setDst(r.data); setFeedback({ t: "ok", m: `Dest → ${r.data.name}` }); setDstContent(await loadContent(r.data.id)); vibrateSuccess(); }
        else { setFeedback({ t: "info", m: `${r.data.name}` }); vibrate(); }
      } else if (r.type === "product") {
        if (!src) { setFeedback({ t: "warn", m: "Scanne un emplacement source d'abord" }); vibrateError(); }
        else { setCurProduct(r.data); setFeedback({ t: "ok", m: r.data.name }); setCurStock(await odoo.getStockAtLocation(session, r.data.id, src.id)); vibrateSuccess(); }
      } else if (r.type === "lot") {
        if (!src) { setFeedback({ t: "warn", m: "Scanne un emplacement source d'abord" }); vibrateError(); }
        else { setCurProduct(r.data.product); setCurLot(r.data.lot); setFeedback({ t: "ok", m: `Lot ${r.data.lot.name}` }); if (r.data.product) setCurStock(await odoo.getStockAtLocation(session, r.data.product.id, src.id)); vibrateSuccess(); }
      } else { setFeedback({ t: "err", m: `"${code}" introuvable` }); vibrateError(); }
    } catch (e: any) { setError(e.message); vibrateError(); }
    setLoading(false);
  };

  // === QUICK MODE ===
  const doQuickScan = async (code: string) => {
    if (!code || !session) return;
    setLoading(true); setError(""); setFeedback(null); setCurProduct(null); setCurLot(null); setCurStock([]); setAllStock([]); setSrc(null); setDst(null);
    try {
      const r = await odoo.smartScan(session, code);
      if (r.type === "product") {
        setCurProduct(r.data);
        const stock = await odoo.getAllStockForProduct(session, r.data.id);
        setAllStock(stock);
        setFeedback({ t: "ok", m: r.data.name });
        vibrateSuccess();
      } else if (r.type === "lot") {
        setCurProduct(r.data.product); setCurLot(r.data.lot);
        if (r.data.product) {
          const stock = await odoo.getAllStockForProduct(session, r.data.product.id);
          setAllStock(stock);
        }
        setFeedback({ t: "ok", m: `Lot ${r.data.lot.name}` });
        vibrateSuccess();
      } else if (r.type === "location") {
        setFeedback({ t: "info", m: `📍 ${r.data.name} — scanne un produit en mode rapide` });
        vibrate();
      } else { setFeedback({ t: "err", m: `"${code}" introuvable` }); vibrateError(); }
    } catch (e: any) { setError(e.message); vibrateError(); }
    setLoading(false);
  };

  const selectSrcFromStock = (loc: any) => {
    setSrc(loc);
    if (curProduct) {
      const filtered = allStock.filter((q: any) => q.location_id[0] === loc.id);
      setCurStock(filtered);
    }
    vibrateSuccess();
  };

  const addLine = (qty: number, lotId?: number | null, lotName?: string | null) => {
    if (!curProduct) return;
    const line = { productId: curProduct.id, productName: curProduct.name, productCode: curProduct.default_code, qty, uomId: curProduct.uom_id[0], uomName: curProduct.uom_id[1], lotId: lotId || curLot?.id || null, lotName: lotName || curLot?.name || null };

    if (transferMode === "quick" && src && dst) {
      // Mode rapide → validation immédiate
      quickValidate(line);
    } else {
      // Mode classique → ajouter à la liste
      setLines(p => [...p, line]);
      setCurProduct(null); setCurLot(null); setCurStock([]); setAllStock([]); setFeedback(null);
      vibrateSuccess();
    }
  };

  const quickValidate = async (line: any) => {
    if (!session || !src || !dst) return;
    console.log("[quickValidate] src:", src.id, src.name, "dst:", dst.id, dst.name);
    setLoading(true); setError("");
    try {
      const pid = await odoo.createInternalTransfer(session, src.id, dst.id, [line]);
      await odoo.validatePicking(session, pid);
      const entry: HistoryEntry = { date: new Date().toISOString(), from: src.name, to: dst.name, lineCount: 1, products: [line.productName] };
      saveHistory(entry);
      setHistory(loadHistory());
      vibrateSuccess();
      // Reset pour le prochain scan — on reste en mode transfert rapide
      setCurProduct(null); setCurLot(null); setCurStock([]); setAllStock([]); setSrc(null); setDst(null);
      setFeedback({ t: "ok", m: `✅ ${line.productName} · ${line.qty} ${line.uomName} → ${dst.name}` });
    } catch (e: any) { setError(e.message); vibrateError(); }
    setLoading(false);
  };

  const validate = async () => {
    if (!session || !src || !dst || !lines.length) return;
    setLoading(true); setError("");
    try {
      const pid = await odoo.createInternalTransfer(session, src.id, dst.id, lines);
      await odoo.validatePicking(session, pid);
      const entry: HistoryEntry = { date: new Date().toISOString(), from: src.name, to: dst.name, lineCount: lines.length, products: lines.map(l => l.productName) };
      saveHistory(entry);
      setHistory(loadHistory());
      vibrateSuccess();
      setScreen("done");
    } catch (e: any) { setError(e.message); vibrateError(); }
    setLoading(false);
  };

  const rename = async (id: number, name: string) => {
    if (!session) return;
    try { await odoo.renameLocation(session, id, name); setLocations(await odoo.getLocations(session)); } catch {}
  };

  // ===================== PREPARATION =====================
  const loadPickings = async () => {
    if (!session) return;
    setLoading(true); setError("");
    try {
      const p = await odoo.getOutgoingPickings(session);
      setPickings(p);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const openPickingByName = async (name: string) => {
    if (!session) return;
    const trimmed = name.trim();
    // 1. Search in already loaded pickings
    const found = pickings.find((p: any) => (p.name || "").toUpperCase() === trimmed.toUpperCase());
    if (found) { openPicking(found); return; }
    // 2. Search Odoo — only basic fields to avoid invalid field errors
    setLoading(true); setError("");
    try {
      const results = await odoo.searchRead(
        session, "stock.picking",
        [["name", "=", trimmed], ["state", "in", ["assigned", "waiting", "confirmed"]]],
        ["id", "name", "partner_id", "scheduled_date", "state", "priority"],
        1
      );
      if (results.length) {
        // Enrich with shipping_date via getOutgoingPickings if possible, else use basic data
        const p = { ...results[0], shipping_date: results[0].scheduled_date };
        openPicking(p);
      } else {
        showToast(`❌ "${trimmed}" introuvable`);
        setLoading(false);
      }
    } catch (e: any) { setError(e.message); setLoading(false); }
  };

  const openPicking = async (picking: any) => {
    if (!session) return;
    setLoading(true); setError("");
    setSelectedPicking(picking);
    setPrepScanned(new Set());
    setPrepStep(null);
    try {
      const moves = await odoo.getPickingMoves(session, picking.id);
      const mlines = await odoo.getPickingMoveLines(session, picking.id);
      setPickingMoves(moves);
      setPickingMoveLines(mlines);
      // Mark already done lines as scanned
      const done = new Set<number>();
      mlines.forEach((ml: any) => { if (ml.qty_done > 0) done.add(ml.id); });
      setPrepScanned(done);
      setScreen("prepDetail");
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const doPrepScan = async (code: string) => {
    const currentStep = prepStepRef.current;
    const currentLines = pickingMoveLinesRef.current;
    const currentPicking = selectedPickingRef.current;
    if (!code || !session || !currentPicking) return;
    setError("");
    try {
      // Optimisation : requête ciblée selon le step (au lieu de 8 requêtes smartScan)
      let r: any;
      if (!currentStep) {
        // Step 1 : on attend un emplacement
        const locs = await odoo.searchRead(session, "stock.location",
          [["barcode", "=", code.trim()]], ["id", "name", "complete_name", "barcode"], 1);
        r = locs.length ? { type: "location", data: locs[0] }
          : (await odoo.searchRead(session, "stock.location",
              [["barcode", "ilike", code.trim()]], ["id", "name", "complete_name", "barcode"], 1))
            .map((l: any) => ({ type: "location", data: l }))[0]
            || { type: "not_found", code };
      } else {
        // Step 2 : on attend un lot
        const lots = await odoo.searchRead(session, "stock.lot",
          [["name", "=", code.trim()]], ["id", "name", "product_id"], 1);
        if (lots.length) {
          r = { type: "lot", data: { lot: lots[0], product: { id: lots[0].product_id?.[0] } } };
        } else {
          const lotsI = await odoo.searchRead(session, "stock.lot",
            [["name", "ilike", code.trim()]], ["id", "name", "product_id"], 1);
          r = lotsI.length
            ? { type: "lot", data: { lot: lotsI[0], product: { id: lotsI[0].product_id?.[0] } } }
            : { type: "not_found", code };
        }
      }
      // STEP 1: No active step → expect a location scan
      if (!currentStep) {
        if (r.type === "location") {
          // Find move lines at this location that still need qty
          const locId = r.data.id;
          const pending = currentLines.filter((ml: any) =>
            ml.location_id && ml.location_id[0] === locId && (ml.qty_done || 0) < (ml.reserved_uom_qty || 0)
          );
          if (pending.length === 0) {
            showToast(`Aucun article à prendre à ${r.data.name}`);
            vibrateError();
            return;
          }
          // Lock on first pending line at this location
          const ml = pending[0];
          const remaining = (ml.reserved_uom_qty || 0) - (ml.qty_done || 0);
          updatePrepStep({
            locId, locName: r.data.name, lineId: ml.id,
            productName: ml.product_id[1], lotName: ml.lot_id?.[1] || undefined,
            remaining,
          });
          vibrateSuccess();
          showToast(`📍 ${r.data.name} → Scannez ${ml.lot_id ? ml.lot_id[1] : ml.product_id[1]}`);
        } else {
          showToast("⚠ Scannez d'abord un emplacement source");
          vibrateError();
        }
        return;
      }

      // STEP 2: Location already scanned → expect product or lot
      // Also handle raw code as lot name if smartScan returns nothing useful
      let productId: number | null = null;
      let lotId: number | null = null;
      let lotName: string | null = null;
      let scannedCode = code;

      if (r.type === "product") {
        productId = r.data.id;
      } else if (r.type === "lot") {
        productId = r.data.product?.id || null;
        lotId = r.data.lot.id;
        lotName = r.data.lot.name;
      } else if (r.type === "location") {
        // Re-scanning a location while step is active → reset step and re-process
        updatePrepStep(null);
        doPrepScan(code);
        return;
      } else {
        // Unknown barcode — treat as raw lot name (common on carton labels)
        const rawLots = await odoo.searchRead(session, "stock.lot", [["name", "=", code.trim()]], ["id", "name", "product_id"], 1);
        if (rawLots.length) {
          lotId = rawLots[0].id;
          lotName = rawLots[0].name;
          productId = rawLots[0].product_id?.[0] || null;
        } else {
          // Last resort: try ilike (partial match)
          const rawLotsLike = await odoo.searchRead(session, "stock.lot", [["name", "ilike", code.trim()]], ["id", "name", "product_id"], 5);
          if (rawLotsLike.length === 1) {
            lotId = rawLotsLike[0].id;
            lotName = rawLotsLike[0].name;
            productId = rawLotsLike[0].product_id?.[0] || null;
          } else {
            showToast(`⚠ Lot "${code}" introuvable`);
            vibrateError();
            return;
          }
        }
      }

      // Find the move line — by lineId first, then by product+location if not found
      let ml = currentLines.find((m: any) => m.id === currentStep!.lineId);
      if (!ml && productId) {
        // Fallback: find by product at this location with qty remaining
        ml = currentLines.find((m: any) =>
          m.location_id?.[0] === currentStep!.locId &&
          m.product_id[0] === productId &&
          (m.qty_done || 0) < (m.reserved_uom_qty || 0)
        );
      }
      if (!ml) {
        // Last fallback: any line at this location with qty remaining
        ml = currentLines.find((m: any) =>
          m.location_id?.[0] === currentStep!.locId &&
          (m.qty_done || 0) < (m.reserved_uom_qty || 0)
        );
      }
      if (!ml) { showToast("Ligne introuvable à cet emplacement"); vibrateError(); return; }

      // Check if product matches (only if we got product info from scan)
      if (productId && ml.product_id[0] !== productId) {
        showToast(`⚠ Mauvais produit — attendu: ${ml.product_id[1]}`);
        vibrateError();
        return;
      }

      // Lot différent du lot attendu → warning orange mais on accepte
      if (lotName && ml.lot_id && ml.lot_id[1] !== lotName) {
        showToast(`🟠 Lot différent: ${lotName} (attendu ${ml.lot_id[1]}) — accepté`);
        // Use the scanned lot id for the write
      }

      // Increment qty_done by 1
      const newQty = (ml.qty_done || 0) + 1;
      await odoo.setMoveLineQtyDone(session, ml.id, newQty, lotId || ml.lot_id?.[0] || null);

      // Refresh
      const updatedLines = await odoo.getPickingMoveLines(session, currentPicking.id);
      setPickingMoveLines(updatedLines);

      if (newQty >= (ml.reserved_uom_qty || 0)) {
        setPrepScanned(prev => { const n = new Set(Array.from(prev)); n.add(ml.id); return n; });
      }

      const remaining = (ml.reserved_uom_qty || 0) - newQty;
      vibrateSuccess();
      showToast(`✓ ${lotName || ml.product_id[1]} · ${newQty}/${ml.reserved_uom_qty || 0}`);

      const morePending = updatedLines.filter((m: any) =>
        m.location_id && m.location_id[0] === currentStep!.locId && (m.qty_done || 0) < (m.reserved_uom_qty || 0)
      );
      if (morePending.length === 0) {
        updatePrepStep(null);
        showToast(`✓ Emplacement ${currentStep!.locName} terminé`);
      } else if (remaining <= 0) {
        const next = morePending[0];
        const nextRemaining = (next.reserved_uom_qty || 0) - (next.qty_done || 0);
        updatePrepStep({ locId: currentStep!.locId, locName: currentStep!.locName, lineId: next.id, productName: next.product_id[1], lotName: next.lot_id?.[1] || undefined, remaining: nextRemaining });
      } else {
        updatePrepStep(prev => prev ? { ...prev, lineId: ml.id, remaining } : null);
      }
    } catch (e: any) { setError(e.message); vibrateError(); }
  };

  // Ref to always call latest doPrepScan (avoids stale closure)
  const doPrepScanRef = useRef<(code: string) => Promise<void>>(async () => {});
  useEffect(() => { doPrepScanRef.current = doPrepScan; });

  // Scan queue — accumule les scans pendant qu'un traitement est en cours
  const scanQueueRef = useRef<string[]>([]);
  const scanProcessingRef = useRef(false);
  const processScanQueue = useCallback(async () => {
    if (scanProcessingRef.current) return;
    scanProcessingRef.current = true;
    while (scanQueueRef.current.length > 0) {
      const code = scanQueueRef.current.shift()!;
      await doPrepScanRef.current(code);
      // Petit délai pour laisser le ref se mettre à jour avant le prochain scan
      await new Promise(r => setTimeout(r, 50));
    }
    scanProcessingRef.current = false;
  }, []);

  // "Tout prendre" — fill all remaining qty for the current location
  const prepTakeAll = async () => {
    if (!session || !selectedPicking || !prepStep) return;
    setLoading(true);
    try {
      const pending = pickingMoveLines.filter((ml: any) =>
        ml.location_id && ml.location_id[0] === prepStep.locId && (ml.qty_done || 0) < (ml.reserved_uom_qty || 0)
      );
      for (const ml of pending) {
        await odoo.setMoveLineQtyDone(session, ml.id, ml.reserved_uom_qty || 0, ml.lot_id?.[0] || null);
      }
      const updatedLines = await odoo.getPickingMoveLines(session, selectedPicking.id);
      setPickingMoveLines(updatedLines);
      const done = new Set(Array.from(prepScanned));
      pending.forEach((ml: any) => done.add(ml.id));
      setPrepScanned(done);
      updatePrepStep(null);
      vibrateSuccess();
      showToast(`✓ Tout pris à ${prepStep.locName}`);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const autoFillPicking = async () => {
    if (!session || !selectedPicking) return;
    setLoading(true);
    try {
      await odoo.autoFillPicking(session, selectedPicking.id);
      const mlines = await odoo.getPickingMoveLines(session, selectedPicking.id);
      setPickingMoveLines(mlines);
      const done = new Set<number>();
      mlines.forEach((ml: any) => { if (ml.qty_done > 0) done.add(ml.id); });
      setPrepScanned(done);
      vibrateSuccess();
      showToast("Toutes les quantités remplies");
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  // Optimistic qty override: { [moveLineId]: qty }
  const [qtyOverrides, setQtyOverrides] = useState<Record<number, number>>({});
  const debounceTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});

  // +1 / -1 / tout mettre — optimistic update + debounced Odoo sync
  const adjustMoveLineQty = (moveLineId: number, newQty: number) => {
    const ml = pickingMoveLines.find((m: any) => m.id === moveLineId);
    if (!ml || !session) return;
    const clamped = Math.max(0, Math.min(newQty, ml.reserved_uom_qty || 0));
    // Update display immediately
    setQtyOverrides(prev => ({ ...prev, [moveLineId]: clamped }));
    if (clamped >= (ml.reserved_uom_qty || 0)) vibrateSuccess();
    // Debounce Odoo write — 800ms after last action
    clearTimeout(debounceTimers.current[moveLineId]);
    debounceTimers.current[moveLineId] = setTimeout(async () => {
      try {
        await odoo.setMoveLineQtyDone(session, moveLineId, clamped, ml.lot_id?.[0] || null);
        // Refresh only this line silently
        const updatedLines = await odoo.getPickingMoveLines(session, selectedPicking!.id);
        setPickingMoveLines(updatedLines);
        setQtyOverrides(prev => { const n = { ...prev }; delete n[moveLineId]; return n; });
        if (clamped >= (ml.reserved_uom_qty || 0)) {
          setPrepScanned(prev => { const n = new Set(Array.from(prev)); n.add(moveLineId); return n; });
        }
      } catch (e: any) { setError(e.message); }
    }, 800);
  };

  const validatePrepPicking = async () => {
    if (!session || !selectedPicking) return;
    setLoading(true); setError("");
    try {
      await odoo.validatePicking(session, selectedPicking.id);
      vibrateSuccess();
      showToast(`✅ ${selectedPicking.name} validé`);
      setScreen("prep");
      setSelectedPicking(null);
      await loadPickings(); // refresh list
    } catch (e: any) { setError(e.message); vibrateError(); }
    setLoading(false);
  };

  const checkPickingAvailability = async (pickingId: number) => {
    if (!session) return;
    setLoading(true);
    try {
      await odoo.checkAvailability(session, pickingId);
      await loadPickings();
      vibrateSuccess();
      showToast("Disponibilité vérifiée");
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const openPickingReport = (pickingId: number) => {
    if (!session) return;
    const url = odoo.getPickingReportUrl(session, pickingId);
    window.open(url, "_blank");
  };

  // ===================== RENDER =====================
  const classicStep = !src ? 0 : !dst ? 1 : 2;

  if (screen === "login") return <Login onLogin={login} loading={loading} error={error} />;

  return (
    <Shell toast={toast}>
      <Header name={session?.name} onLogout={logout} onHome={goHome} onSettings={() => setScreen("settings")} />

      <main style={{ maxWidth: 480, margin: "0 auto", padding: "16px 16px 100px" }}>

        {/* ===== HOME ===== */}
        {screen === "home" && <>
          <Section>
            <SectionHeader icon={scanIcon} title="Recherche rapide" sub="Scanne ou tape un code" />
            <InputBar onSubmit={doLookup} placeholder="Code-barres, référence, lot, emplacement..." />
          </Section>

          {error && <Alert type="error">{error}</Alert>}
          {lookupType === "product" && lookupResult && <ProductResult product={lookupResult} stock={lookupStock} onRename={rename} />}
          {lookupType === "lot" && lookupResult && <LotResult lot={lookupResult.lot} product={lookupResult.product} stock={lookupStock} />}
          {lookupType === "location" && lookupResult && <LocationResult location={lookupResult} stock={lookupStock} onRename={rename} />}

          <div style={{ marginTop: 16 }}>
            <BigButton icon={transferIcon("#fff")} label="Transfert interne" sub="Déplacer du stock entre emplacements" onClick={() => { resetTransfer(); setScreen("transfer"); }} />
            <div style={{ height: 10 }} />
            <BigButton icon={prepIcon} label="Préparation" sub="Commandes à préparer et expédier" color="#7c3aed" onClick={() => { loadPickings(); setScreen("prep"); }} />
            <div style={{ height: 10 }} />
            <BigButton icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 002 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0022 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>} label="Arrivage" sub="Importer une packing list WALA" color="#059669" onClick={() => setScreen("arrival")} />
            <div style={{ height: 10 }} />
            <a href="/dashboard" style={{ textDecoration: "none", display: "block" }}>
              <BigButton icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>} label="Dashboard" sub="Alertes stock, consommation, livraisons" color="#1d4ed8" onClick={() => {}} />
            </a>

            {/* HIDDEN: E-shop button — pas au point
            <BigButton icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>} label="E-shop" sub="Préparer les commandes SendCloud" color="#f59e0b" onClick={() => setScreen("eshop")} />
            */}
            {history.length > 0 && <>
              <div style={{ height: 10 }} />
              <BigButton icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>} label="Historique" sub={`${history.length} transfert${history.length > 1 ? "s" : ""} enregistré${history.length > 1 ? "s" : ""}`} color="#64748b" onClick={() => setScreen("history")} />
            </>}
            <div style={{ height: 10 }} />
            <BigButton icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="9" x2="9" y2="21"/></svg>} label="Impression étiquettes" sub="Palette, vierge, produit" color="#0891b2" onClick={() => setScreen("labels")} />
            <div style={{ height: 10 }} />
            <BigButton icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2"/><line x1="12" y1="12" x2="12" y2="17"/><line x1="9" y1="15" x2="15" y2="15"/></svg>} label="Palettes WMS" sub="Stock physique par palette" color="#7c3aed" onClick={() => setScreen("palettes")} />
            <div style={{ height: 10 }} />
            <BigButton icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>} label="Ajustement inventaire" sub="Corriger les quantités en stock" color="#8b5cf6" onClick={() => setScreen("inventory")} />
          </div>

          {/* PrintNode printer config — moved to settings */}
        </>}

        {/* ===== TRANSFER ===== */}
        {screen === "transfer" && <>
          {/* Mode toggle */}
          <div style={{ display: "flex", background: C.white, borderRadius: 10, border: `1px solid ${C.border}`, overflow: "hidden", marginBottom: 16 }}>
            {(["classic", "quick"] as const).map(m => (
              <button key={m} onClick={() => { setTransferMode(m); resetTransfer(); }}
                style={{ flex: 1, padding: "10px 0", fontSize: 13, fontWeight: 700, cursor: "pointer", border: "none", fontFamily: "inherit", transition: "all .15s",
                  background: transferMode === m ? C.blue : "transparent",
                  color: transferMode === m ? "#fff" : C.textSec,
                }}>
                {m === "classic" ? "📋 Classique" : "⚡ Rapide"}
              </button>
            ))}
          </div>

          {/* CLASSIC MODE */}
          {transferMode === "classic" && <>
            <StepIndicator step={classicStep} steps={["Source", "Destination", "Produits"]} />
            {src && <LocCard loc={src} label="Source" content={srcContent} color={C.blue} onRename={rename} onClear={() => { setSrc(null); setSrcContent([]); }} />}
            {dst && <LocCard loc={dst} label="Destination" content={dstContent} color={C.green} onRename={rename} onClear={() => { setDst(null); setDstContent([]); }} />}

            <Section>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>
                  {classicStep === 0 ? "Scanner la source" : classicStep === 1 ? "Scanner la destination" : "Scanner un produit"}
                </span>
                {loading && <Spinner />}
              </div>
              <AutoInput locations={locations} onScan={doClassicScan} onPickLoc={(loc: any) => {
                if (!src) { setSrc(loc); setSrcContent([]); loadContent(loc.id).then(setSrcContent); vibrateSuccess(); }
                else if (!dst) { setDst(loc); setDstContent([]); loadContent(loc.id).then(setDstContent); vibrateSuccess(); }
              }} placeholder={classicStep === 0 ? "Emplacement source..." : classicStep === 1 ? "Emplacement destination..." : "Code-barres, réf, lot..."} />
            </Section>
          </>}

          {/* QUICK MODE */}
          {transferMode === "quick" && <>
            <Alert type="info">Scanne un produit → choisis source et destination</Alert>
            <Section>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>Scanner un produit</span>
                {loading && <Spinner />}
              </div>
              <InputBar onSubmit={doQuickScan} placeholder="Code-barres, référence, lot..." />
            </Section>

            {/* Product found — show all stock locations to pick from */}
            {curProduct && allStock.length > 0 && !src && (
              <Section>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 4 }}>
                  {curProduct.name}
                  {curProduct.active === false && <Chip color={C.orange}>archivé</Chip>}
                </div>
                <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 12 }}>{curProduct.default_code || ""}</div>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>D'où vient le stock ? <span style={{ fontWeight: 400, color: C.textMuted }}>(clic pour choisir)</span></div>
                {groupStockByLocation(allStock).map((loc, i) => (
                  <button key={i} onClick={() => selectSrcFromStock({ id: loc.locId, name: loc.locName })}
                    style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", padding: "12px 14px", borderRadius: 10, marginBottom: 6,
                      background: C.white, border: `1.5px solid ${C.border}`, cursor: "pointer", fontFamily: "inherit", fontSize: 13, transition: "all .1s",
                    }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ color: C.blue }}>📍</span>
                      <span style={{ fontWeight: 600, color: C.text }}>{loc.locName}</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontWeight: 700, color: loc.avail > 0 ? C.green : C.orange }}>{loc.avail}</span>
                      <span style={{ color: C.textMuted, fontSize: 11 }}>dispo</span>
                      <span style={{ color: C.blue, fontSize: 16 }}>→</span>
                    </div>
                  </button>
                ))}
              </Section>
            )}

            {/* Source chosen — choose destination */}
            {curProduct && src && !dst && (
              <Section>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, padding: "8px 12px", background: C.blueSoft, borderRadius: 8 }}>
                  <span style={{ fontSize: 12, color: C.blue, fontWeight: 600 }}>Source: {src.name}</span>
                </div>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>Destination</div>
                {/* Suggestions : emplacements où ce produit est déjà en stock */}
                {allStock.filter(q => q.location_id[0] !== src.id && q.quantity > 0).length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, marginBottom: 6, textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>📦 Déjà en stock ici</div>
                    {allStock.filter(q => q.location_id[0] !== src.id && q.quantity > 0).map((q, i) => (
                      <button key={i} onClick={() => {
                        const loc = locations.find((l: any) => l.id === q.location_id[0]);
                        if (loc) { setDst(loc); vibrateSuccess(); }
                      }} style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px", background: C.greenSoft, border: `1.5px solid ${C.green}`, borderRadius: 8, marginBottom: 6, cursor: "pointer", fontFamily: "inherit" }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{q.location_id[1]}</span>
                        <span style={{ fontSize: 12, fontWeight: 700, color: C.green }}>{q.quantity} en stock</span>
                      </button>
                    ))}
                    <div style={{ fontSize: 11, color: C.textMuted, margin: "8px 0 6px" }}>Ou choisir un autre emplacement :</div>
                  </div>
                )}
                <LocationDropdown locations={locations} onSelect={(loc) => { setDst(loc); vibrateSuccess(); }} excludeId={src.id} />
              </Section>
            )}

            {/* Quick mode: recent validations this session */}
            {!curProduct && history.length > 0 && (
              <Section style={{ marginTop: 4 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
                  {clockIcon} Validés récemment
                </div>
                {history.slice(0, 5).map((h, i) => (
                  <div key={i} style={{ padding: "6px 0", borderBottom: i < Math.min(history.length, 5) - 1 ? `1px solid ${C.border}` : "none", fontSize: 11 }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ color: C.green, fontWeight: 600 }}>✓ {h.products[0]}</span>
                      <span style={{ color: C.textMuted }}>{new Date(h.date).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</span>
                    </div>
                    <span style={{ color: C.textMuted }}>{h.from} → {h.to}</span>
                  </div>
                ))}
              </Section>
            )}
          </>}

          {/* Common: feedback / error */}
          {feedback && <Alert type={feedback.t === "ok" ? "success" : feedback.t === "warn" ? "warning" : feedback.t === "err" ? "error" : "info"}>{feedback.m}</Alert>}
          {error && <Alert type="error">{error}</Alert>}

          {/* Product picker (both modes) */}
          {curProduct && ((transferMode === "classic") || (transferMode === "quick" && src && dst)) && (
            <ProductPicker product={curProduct} lot={curLot} stock={curStock} srcName={src?.name} onAdd={addLine}
              quickMode={transferMode === "quick"} dstName={dst?.name} loading={loading} />
          )}

          {/* Lines — classic mode only */}
          {transferMode === "classic" && lines.length > 0 && (
            <Section>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 10 }}>
                Lignes de transfert
                <span style={{ marginLeft: 8, background: C.blue, color: "#fff", padding: "2px 8px", borderRadius: 10, fontSize: 11 }}>{lines.length}</span>
              </div>
              {lines.map((l, i) => (
                <EditableLine key={i} line={l}
                  onDelete={() => setLines(p => p.filter((_, j) => j !== i))}
                  onUpdate={(u: any) => setLines(p => p.map((x, j) => j === i ? { ...x, ...u } : x))}
                />
              ))}
            </Section>
          )}

          {/* Classic mode: destination dropdown if not set */}
          {transferMode === "classic" && lines.length > 0 && !dst && (
            <Section>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>Ou choisis une destination</div>
              <LocationDropdown locations={locations} onSelect={(loc) => { setDst(loc); setDstContent([]); loadContent(loc.id).then(setDstContent); vibrateSuccess(); }} excludeId={src?.id} />
            </Section>
          )}

          {/* Validate — classic mode */}
          {transferMode === "classic" && lines.length > 0 && dst && src && (
            <div style={{ marginTop: 16 }}>
              <BigButton
                icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>}
                label={loading ? "Envoi..." : `Valider (${lines.length} ligne${lines.length > 1 ? "s" : ""})`}
                sub={`${src.name} → ${dst.name}`}
                color={C.green}
                onClick={validate}
                disabled={loading}
              />
            </div>
          )}
          {transferMode === "classic" && lines.length > 0 && !dst && <Alert type="warning">Choisis ou scanne une destination</Alert>}
        </>}

        {/* ===== DONE ===== */}
        {screen === "done" && (
          <div style={{ textAlign: "center", paddingTop: 50, animation: "slideUp .3s" }}>
            <div style={{ width: 72, height: 72, borderRadius: "50%", background: C.greenSoft, border: `2px solid ${C.greenBorder}`, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke={C.green} strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
            <h2 style={{ fontSize: 22, fontWeight: 700, color: C.text, marginBottom: 6 }}>Transfert validé !</h2>
            <p style={{ fontSize: 14, color: C.textSec, marginBottom: 32 }}>{lines.length} ligne(s) · {src?.name} → {dst?.name}</p>
            <BigButton icon={transferIcon("#fff")} label="Nouveau transfert" onClick={() => { resetTransfer(); setScreen("transfer"); }} />
            <button onClick={goHome} style={{ ...secondaryBtn, marginTop: 12 }}>Retour à l'accueil</button>
          </div>
        )}

        {/* ===== PREPARATION LIST ===== */}
        {screen === "prep" && (
          <PrepListScreen
            pickings={pickings}
            loading={loading}
            error={error}
            onOpen={openPicking}
            onScanPicking={openPickingByName}
            onCheckAvail={checkPickingAvailability}
            onRefresh={loadPickings}
            onReport={openPickingReport}
          />
        )}

        {/* ===== PREPARATION DETAIL ===== */}
        {screen === "prepDetail" && selectedPicking && (
          <PrepDetailScreen
            picking={selectedPicking}
            moves={pickingMoves}
            moveLines={pickingMoveLines}
            scanned={prepScanned}
            loading={loading}
            error={error}
            prepStep={prepStep}
            onScan={doPrepScan}
            onTakeAll={prepTakeAll}
            onCancelStep={() => setPrepStep(null)}
            onAutoFill={autoFillPicking}
            onAdjustQty={adjustMoveLineQty}
            qtyOverrides={qtyOverrides}
            onValidate={validatePrepPicking}
            onBack={() => { setScreen("prep"); setPrepStep(null); loadPickings(); }}
            onReport={openPickingReport}
          />
        )}

        {/* ===== SETTINGS ===== */}
        {screen === "settings" && (
          <SettingsScreen onBack={goHome} session={session} />
        )}

        {/* ===== HISTORY ===== */}
        {screen === "history" && (
          <HistoryScreen history={history} onClear={() => { clearHistory(); setHistory([]); goHome(); }} onBack={goHome} />
        )}

        {screen === "arrival" && session && (
          <ArrivalScreen session={session} onBack={goHome} onToast={showToast} />
        )}

        {/* ===== LABELS ===== */}
        {screen === "labels" && (
          <LabelsScreen onBack={goHome} onToast={showToast} session={session} />
        )}

        {/* ===== INVENTORY ===== */}
        {screen === "palettes" && session && (
          <PalettesScreen onBack={goHome} session={session} />
        )}

        {screen === "inventory" && session && (
          <InventoryScreen session={session} onBack={goHome} onToast={showToast} />
        )}

        {/* HIDDEN: E-shop screen — pas au point
        {screen === "eshop" && session && (
          <EshopScreen session={session} onBack={goHome} onToast={showToast} />
        )}
        */}
      </main>

      {/* Print Modal — rendered at root level for z-index */}
      {printReq && <PrintModal req={printReq} onClose={() => setPrintReq(null)} onToast={showToast} />}
    </Shell>
  );
}

// ============================================
// HELPER: group stock by location
// ============================================
function groupStockByLocation(stock: any[]) {
  const map: Record<number, { locId: number; locName: string; total: number; reserved: number; avail: number }> = {};
  for (const q of stock) {
    const id = q.location_id[0];
    if (!map[id]) map[id] = { locId: id, locName: q.location_id[1], total: 0, reserved: 0, avail: 0 };
    map[id].total += q.quantity;
    map[id].reserved += q.reserved_quantity || 0;
  }
  return Object.values(map).map(l => ({ ...l, avail: l.total - l.reserved })).sort((a, b) => b.avail - a.avail);
}

// ============================================
// LOCATION DROPDOWN
// ============================================
// ============================================
// EDITABLE LINE
// ============================================
function EditableLine({ line, onDelete, onUpdate }: { line: any; onDelete: () => void; onUpdate: (u: any) => void }) {
  const [editing, setEditing] = useState(false);
  const [qty, setQty] = useState(String(line.qty));
  const [lotName, setLotName] = useState(line.lotName || "");

  const save = () => {
    const newQty = parseFloat(qty);
    if (!isNaN(newQty) && newQty > 0) onUpdate({ qty: newQty, lotName: lotName || undefined });
    setEditing(false);
  };

  if (editing) return (
    <div style={{ padding: "12px 0", borderBottom: `1px solid ${C.border}` }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 8 }}>{line.productName}</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div style={{ display: "flex", flexDirection: "column" as const, gap: 4, flex: 1, minWidth: 80 }}>
          <span style={{ fontSize: 11, color: C.textMuted }}>Qté</span>
          <input style={inputStyle} type="number" value={qty} onChange={e => setQty(e.target.value)} autoFocus />
        </div>
        <div style={{ display: "flex", flexDirection: "column" as const, gap: 4, flex: 2, minWidth: 120 }}>
          <span style={{ fontSize: 11, color: C.textMuted }}>Lot</span>
          <input style={inputStyle} value={lotName} onChange={e => setLotName(e.target.value)} placeholder="N° de lot..." />
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={save} style={{ padding: "10px 14px", background: C.green, color: "#fff", border: "none", borderRadius: 8, fontWeight: 700, cursor: "pointer" }}>✓</button>
          <button onClick={() => setEditing(false)} style={{ padding: "10px 14px", background: C.border, color: C.text, border: "none", borderRadius: 8, cursor: "pointer" }}>✕</button>
        </div>
      </div>
    </div>
  );

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
      <div style={{ width: 32, height: 32, borderRadius: 8, background: C.blueSoft, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{boxIcon(C.blue, 14)}</div>
      <div style={{ flex: 1 }} onClick={() => setEditing(true)} role="button">
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{line.productName}</div>
        <div style={{ fontSize: 11, color: C.textMuted }}>{line.productCode} · <strong>{line.qty}</strong> {line.uomName}{line.lotName ? ` · ${line.lotName}` : ""}</div>
      </div>
      <button onClick={() => setEditing(true)} style={{ ...iconBtn, color: C.blue }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </button>
      <button onClick={onDelete} style={{ ...iconBtn, color: C.red }}>{trashIcon}</button>
    </div>
  );
}

function LocationDropdown({ locations, onSelect, excludeId }: { locations: any[]; onSelect: (loc: any) => void; excludeId?: number }) {
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const filtered = locations.filter(l => l.id !== excludeId && (
    !search || (l.name || "").toLowerCase().includes(search.toLowerCase()) || (l.complete_name || "").toLowerCase().includes(search.toLowerCase()) || (l.barcode || "").toLowerCase().includes(search.toLowerCase())
  ));

  useEffect(() => {
    // Ne pas auto-ouvrir le clavier sur mobile/PDA
    const isMobile = /Mobi|Android|iPad|iPhone/i.test(navigator.userAgent);
    if (!isMobile) setTimeout(() => inputRef.current?.focus(), 80);
  }, []);

  const trySelect = (val: string) => {
    // Exact barcode match → auto-select
    const exact = locations.find(l => l.id !== excludeId && l.barcode && l.barcode.toLowerCase() === val.trim().toLowerCase());
    if (exact) { onSelect(exact); setSearch(""); return true; }
    return false;
  };

  return (
    <div>
      <input
        ref={inputRef}
        style={{ ...inputStyle, borderColor: C.blue }}
        value={search}
        onChange={e => { const v = e.target.value; setSearch(v); trySelect(v); }}
        onKeyDown={e => {
          e.stopPropagation();
          if (e.key === "Enter") {
            if (trySelect(search)) return;
            if (filtered.length === 1) { onSelect(filtered[0]); setSearch(""); }
          }
        }}
        placeholder="📷 Scanner ou taper l'emplacement..."
      />
      {search.length > 0 && (
        <div style={{ maxHeight: 220, overflowY: "auto", marginTop: 8, borderRadius: 10, border: `1px solid ${C.border}` }}>
          {filtered.slice(0, 50).map(loc => (
            <button key={loc.id} onClick={() => { onSelect(loc); setSearch(""); }}
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", padding: "10px 14px", background: "none", border: "none", borderBottom: `1px solid ${C.border}`,
                color: C.text, fontSize: 13, cursor: "pointer", fontFamily: "inherit", textAlign: "left",
              }}>
              <span style={{ fontWeight: 600 }}>{loc.name}</span>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {loc.barcode && <span style={{ color: C.textMuted, fontSize: 11 }}>{loc.barcode}</span>}
                <span style={{ color: C.blue }}>→</span>
              </div>
            </button>
          ))}
          {filtered.length === 0 && <div style={{ padding: 12, textAlign: "center", fontSize: 12, color: C.textMuted }}>Aucun résultat</div>}
        </div>
      )}
    </div>
  );
}

// ============================================
// PRODUCT PICKER with +/- buttons
// ============================================
function ProductPicker({ product, lot, stock, srcName, onAdd, quickMode, dstName, loading: parentLoading }: any) {
  const [qty, setQty] = useState(1);
  const [selLot, setSelLot] = useState<{ id: number; name: string } | null>(lot ? { id: lot.id, name: lot.name } : null);
  const total = stock.reduce((s: number, q: any) => s + q.quantity, 0);
  const reserved = stock.reduce((s: number, q: any) => s + (q.reserved_quantity || 0), 0);
  const avail = total - reserved;
  const lots = stock.filter((q: any) => q.lot_id);

  useEffect(() => { if (lot) setSelLot({ id: lot.id, name: lot.name }); else setSelLot(null); }, [lot]);

  return (
    <Section>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
        <div style={{ width: 44, height: 44, borderRadius: 10, background: C.blueSoft, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{boxIcon(C.blue, 20)}</div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{product.name}{product.active === false && <Chip color={C.orange}>archivé</Chip>}</div>
          <div style={{ fontSize: 12, color: C.textMuted }}>{product.default_code || ""} {product.barcode ? `· ${product.barcode}` : ""}</div>
        </div>
      </div>

      {/* Stock bar */}
      <div style={{ display: "flex", gap: 1, borderRadius: 10, overflow: "hidden", marginBottom: 6 }}>
        <StatBox value={avail} label="DISPO" color={avail > 0 ? C.green : C.orange} />
        <StatBox value={total} label="STOCK" color={C.textSec} />
        {reserved > 0 && <StatBox value={reserved} label="RÉSERVÉ" color={C.orange} />}
      </div>
      {srcName && <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 14, textAlign: "center" }}>sur {srcName}</div>}

      {/* Lot chips */}
      {lots.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>Lot</div>
          <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 6 }}>
            {stock.map((q: any, i: number) => {
              if (!q.lot_id) return null;
              const sel = selLot?.id === q.lot_id[0];
              const lq = q.quantity - (q.reserved_quantity || 0);
              return (
                <button key={i} onClick={() => { sel ? setSelLot(null) : setSelLot({ id: q.lot_id[0], name: q.lot_id[1] }); vibrate(); }}
                  style={{ padding: "8px 12px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", transition: "all .15s",
                    background: sel ? C.blue : C.white, color: sel ? "#fff" : C.text,
                    border: `1.5px solid ${sel ? C.blue : C.border}`,
                  }}>
                  {q.lot_id[1]} <span style={{ fontWeight: 400, opacity: 0.7 }}>({lq})</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Qty with +/- */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 6 }}>Quantité</div>
        <div style={{ display: "flex", alignItems: "stretch", gap: 0, border: `1.5px solid ${C.border}`, borderRadius: 12, overflow: "hidden", background: C.white }}>
          <button onClick={() => { if (qty > 1) { setQty(qty - 1); vibrate(); } }}
            style={{ width: 64, flexShrink: 0, background: C.bg, border: "none", fontSize: 26, fontWeight: 700, color: C.blue, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", touchAction: "manipulation", borderRight: `1px solid ${C.border}` }}>−</button>
          <input type="number" min="1" value={qty === 0 ? "" : qty}
            onChange={e => { const raw = e.target.value; if (raw === "") { setQty(0); return; } const v = parseInt(raw); if (!isNaN(v) && v >= 0) setQty(v); }}
            onBlur={() => { if (qty === 0) setQty(1); }}
            onKeyDown={e => e.stopPropagation()}
            style={{ flex: 1, minWidth: 0, textAlign: "center", fontSize: 28, fontWeight: 800, border: "none", outline: "none", background: C.white, color: C.text, padding: "14px 4px", fontFamily: "'DM Mono', monospace" }} />
          <button onClick={() => { setQty(qty + 1); vibrate(); }}
            style={{ width: 64, flexShrink: 0, background: C.blue, border: "none", fontSize: 26, fontWeight: 700, color: "#fff", cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", touchAction: "manipulation", borderLeft: `1px solid ${C.blue}` }}>+</button>
        </div>
        {/* Quick qty buttons */}
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          {[1, 5, 10, 25, 50].map(n => (
            <button key={n} onClick={() => { setQty(n); vibrate(); }}
              style={{ flex: 1, padding: "8px 0", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
                background: qty === n ? C.blue : C.bg, color: qty === n ? "#fff" : C.textSec,
                border: `1px solid ${qty === n ? C.blue : C.border}`, transition: "all .1s",
              }}>{n}</button>
          ))}
        </div>
      </div>

      {/* Quick mode: show route summary */}
      {quickMode && srcName && dstName && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginBottom: 12, padding: "10px 14px", background: C.greenSoft, borderRadius: 10, border: `1px solid ${C.greenBorder}` }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{srcName}</span>
          <span style={{ fontSize: 16, color: C.green }}>→</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{dstName}</span>
        </div>
      )}

      <button onClick={() => { if (qty > 0) onAdd(qty, selLot?.id, selLot?.name); }}
        disabled={parentLoading}
        style={{ width: "100%", padding: 14, background: quickMode ? C.green : C.blue, color: "#fff", border: "none", borderRadius: 10, fontSize: 15, fontWeight: 700,
          cursor: parentLoading ? "wait" : "pointer", fontFamily: "inherit", opacity: parentLoading ? 0.6 : 1, transition: "all .15s",
        }}>
        {parentLoading ? "Envoi en cours..." : quickMode ? `✓ Valider le transfert` : "Ajouter à la liste"}
      </button>
    </Section>
  );
}

// ============================================
// SHARED COMPONENTS
// ============================================
function Shell({ children, toast }: { children: React.ReactNode; toast: string }) {
  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: "'DM Sans', 'SF Pro Display', -apple-system, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap');
        @keyframes slideUp { from { opacity:0; transform:translateY(8px) } to { opacity:1; transform:translateY(0) } }
        @keyframes fadeIn { from { opacity:0 } to { opacity:1 } }
        @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:.5 } }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        input[type=number]::-webkit-inner-spin-button, input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
        input[type=number] { -moz-appearance: textfield; }
      `}</style>
      {toast && <div style={{ position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)", zIndex: 999, background: C.text, color: "#fff", padding: "10px 20px", borderRadius: 10, fontSize: 13, fontWeight: 600, boxShadow: C.shadowLg, animation: "fadeIn .15s" }}>{toast}</div>}
      {children}
    </div>
  );
}

function Header({ name, onLogout, onHome, onSettings }: { name?: string; onLogout: () => void; onHome: () => void; onSettings: () => void }) {
  return (
    <header style={{ background: C.white, borderBottom: `1px solid ${C.border}`, padding: "12px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 100 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button onClick={onHome} style={iconBtn}>{homeIcon}</button>
        <img src={DH_LOGO} alt="Dr. Hauschka" style={{ height: 28, marginLeft: 2, objectFit: "contain" }} />
        <span style={{ fontSize: 9, color: C.blue, fontWeight: 600, background: C.blueSoft, padding: "2px 5px", borderRadius: 4, marginLeft: 4 }}>WMS</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: C.green, boxShadow: `0 0 6px ${C.green}` }} />
        <span style={{ fontSize: 12, color: C.textSec }}>{name}</span>
        <button onClick={onSettings} style={iconBtn}>{settingsIcon}</button>
        <button onClick={onLogout} style={iconBtn}>{logoutIcon}</button>
      </div>
    </header>
  );
}

function Section({ children, style: s }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ background: C.white, borderRadius: 14, padding: 16, marginBottom: 12, border: `1px solid ${C.border}`, boxShadow: C.shadow, animation: "slideUp .2s", ...s }}>{children}</div>;
}

function SectionHeader({ icon, title, sub }: { icon: React.ReactNode; title: string; sub: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
      <div style={{ width: 36, height: 36, borderRadius: 10, background: C.blueSoft, display: "flex", alignItems: "center", justifyContent: "center" }}>{icon}</div>
      <div>
        <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{title}</div>
        <div style={{ fontSize: 12, color: C.textMuted }}>{sub}</div>
      </div>
    </div>
  );
}

function Alert({ type, children }: { type: string; children: React.ReactNode }) {
  const m: Record<string, { bg: string; border: string; color: string; icon: string }> = {
    success: { bg: C.greenSoft, border: C.greenBorder, color: C.green, icon: "✓" },
    warning: { bg: C.orangeSoft, border: C.orangeBorder, color: C.orange, icon: "⚠" },
    error: { bg: C.redSoft, border: C.redBorder, color: C.red, icon: "✕" },
    info: { bg: C.blueSoft, border: C.blueBorder, color: C.blue, icon: "ℹ" },
  };
  const c = m[type] || m.info;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderRadius: 10, background: c.bg, border: `1px solid ${c.border}`, marginBottom: 12, animation: "slideUp .15s" }}>
      <span style={{ fontSize: 14, fontWeight: 700, color: c.color }}>{c.icon}</span>
      <span style={{ fontSize: 13, fontWeight: 500, color: c.color }}>{children}</span>
    </div>
  );
}

// ============================================
// LABELS SCREEN
// ============================================
function LabelsScreen({ onBack, onToast, session }: { onBack: () => void; onToast: (msg: string) => void; session: any }) {
  const [tab, setTab] = useState<"blank" | "palette" | "chain">("blank");
  const getDefaultTemplate = (): LabelTemplate => {
    const cfg = pn.getLabelTypeConfig("blank");
    return { widthMM: cfg.labelSize.widthMM, heightMM: cfg.labelSize.heightMM, elements: [] };
  };
  const [labelTemplate, setLabelTemplate] = useState<LabelTemplate>(getDefaultTemplate);

  // Update printer/size when tab changes to reflect per-type settings
  const [printers, setPrinters] = useState<pn.PrintNodePrinter[]>([]);
  // Use per-type config from settings (palette & blank have their own)
  const getPrinterForTab = (t: "blank" | "palette" | "chain") => {
    const cfg = pn.getLabelTypeConfig(t === "chain" ? "palette" : t);
    return cfg.printerId || pn.getSavedPrinterId();
  };
  const getSizeForTab = (t: "blank" | "palette" | "chain") => {
    const cfg = pn.getLabelTypeConfig(t === "chain" ? "palette" : t);
    return cfg.labelSize;
  };
  const [printerId, setPrinterId] = useState<number | null>(() => getPrinterForTab("blank"));
  const [labelSize, setLabelSize] = useState<pn.LabelSize>(() => getSizeForTab("blank"));

  // Sync canvas size when label size changes
  useEffect(() => {
    if (tab === "blank") {
      setLabelTemplate(prev => ({ ...prev, widthMM: labelSize.widthMM, heightMM: labelSize.heightMM }));
    }
  }, [labelSize, tab]);

  // Sync canvas size when label size changes
  useEffect(() => {
    if (tab === "blank") {
      setLabelTemplate(prev => ({ ...prev, widthMM: labelSize.widthMM, heightMM: labelSize.heightMM }));
    }
  }, [labelSize, tab]);
  const [qty, setQty] = useState(1);
  const [loading, setLoading] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [showChainPreview, setShowChainPreview] = useState(false);
  // ── CHAIN (impression palette en chaîne) ──
  const emptyChainPalette = () => ({
    id: Math.random().toString(36).slice(2, 8),
    lines: [{ ref: "", qty: "", lot: "" }] as { ref: string; qty: string; lot: string }[],
  });
  type ChainState = { recipientName: string; recipientAddress: string; senderName: string; unit: string; orderRef: string; palettes: { id: string; lines: { ref: string; qty: string; lot: string }[] }[]; _savedAt?: number };
  const [chain, setChain] = useState<ChainState>({
    recipientName: "", recipientAddress: "", senderName: "", unit: "cartons", orderRef: "", palettes: [emptyChainPalette()],
  });
  useEffect(() => {
    try {
      const saved = localStorage.getItem("wms_last_chain");
      if (saved) setChain(JSON.parse(saved) as ChainState);
    } catch {}
  }, []);

  const isDesktop = typeof window !== "undefined" && window.innerWidth >= 1024;

  // Blank label state
  const [blankLines, setBlankLines] = useState([{ text: "", fontSize: 26, align: "C" as "L"|"C"|"R" }]);
  const [blankBarcode, setBlankBarcode] = useState("");

  // Palette label state
  const [pal, setPal] = useState({
    senderName: "", senderAddress: "",
    recipientName: "", recipientAddress: "",
    refs: [{ productName: "", ref: "", lotNumber: "", quantity: 1, unit: "cartons", expiryDate: "", unitsPerCarton: "", unitWeight: "", weight: "" }],
    sscc: "", orderRef: "", deliveryRef: "",
  });

  // Odoo search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [activeRefIdx, setActiveRefIdx] = useState<number | null>(null);

  useEffect(() => {
    pn.listPrinters().then(setPrinters).catch(() => {});
  }, []);

  const savePrinter = (id: number) => { setPrinterId(id); pn.savePrinterId(id); };
  const saveSize = (s: pn.LabelSize) => { setLabelSize(s); pn.saveLabelSize(s); };

  // Odoo product search
  const searchOdoo = async (query: string, refIdx: number) => {
    if (!session || query.length < 2) { setSearchResults([]); return; }
    setSearchLoading(true);
    try {
      const r = await (window as any).__odooSearch?.(query) || null;
      // fallback: use smartScan
      if (!r) {
        const res = await import("@/lib/odoo").then(m => m.smartScan(session, query));
        if (res?.type === "product") {
          setSearchResults([{ id: res.data.id, name: res.data.name, ref: res.data.default_code || "", barcode: res.data.barcode || "", weight: res.data.weight || null }]);
        } else if (res?.type === "lot") {
          setSearchResults([{ id: res.data.product?.id, name: res.data.product?.name || "", ref: res.data.product?.default_code || "", lotNumber: res.data.lot?.name || "", expiryDate: res.data.lot?.expiration_date || "", weight: res.data.product?.weight || null }]);
        } else { setSearchResults([]); }
      }
    } catch { setSearchResults([]); }
    setSearchLoading(false);
  };

  const applySearchResult = (result: any, refIdx: number) => {
    const newRefs = [...pal.refs];
    const currentQty = Number(newRefs[refIdx].quantity) || 1;
    const upc = parseFloat(newRefs[refIdx].unitsPerCarton) || 1;
    const unitWeight = result.weight ? String(result.weight) : newRefs[refIdx].unitWeight;
    const totalWeight = unitWeight && currentQty ? `${(parseFloat(unitWeight) * upc * currentQty).toFixed(2)} kg` : newRefs[refIdx].weight;
    newRefs[refIdx] = {
      ...newRefs[refIdx],
      productName: result.name || newRefs[refIdx].productName,
      ref: result.ref || newRefs[refIdx].ref,
      lotNumber: result.lotNumber || newRefs[refIdx].lotNumber,
      expiryDate: result.expiryDate || newRefs[refIdx].expiryDate,
      unitWeight: unitWeight || newRefs[refIdx].unitWeight,
      weight: totalWeight,
    };
    setPal({ ...pal, refs: newRefs });
    setSearchResults([]);
    setSearchQuery("");
    setActiveRefIdx(null);
  };

  const addRef = () => setPal({ ...pal, refs: [...pal.refs, { productName: "", ref: "", lotNumber: "", quantity: 1, unit: "cartons", expiryDate: "", unitsPerCarton: "", unitWeight: "", weight: "" }] });
  const removeRef = (i: number) => setPal({ ...pal, refs: pal.refs.filter((_, j) => j !== i) });
  const updateRef = (i: number, key: string, val: any) => {
    const newRefs = [...pal.refs];
    const updated = { ...newRefs[i], [key]: val };
    // Recalculate total weight when quantity or unitsPerCarton changes
    if ((key === "quantity" || key === "unitsPerCarton") && updated.unitWeight) {
      const qty = Number(key === "quantity" ? val : updated.quantity) || 0;
      const upc = parseFloat(key === "unitsPerCarton" ? val : updated.unitsPerCarton) || 1;
      const uw = parseFloat(updated.unitWeight) || 0;
      updated.weight = `${(uw * upc * qty).toFixed(2)} kg`;
    }
    newRefs[i] = updated;
    setPal({ ...pal, refs: newRefs });
  };

  const handlePrint = async () => {
    if (!printerId) { onToast("⚠️ Sélectionne une imprimante"); return; }
    setLoading(true);
    let result: { success: boolean; error?: string };
    try {
      if (tab === "chain") {
        // Impression en chaîne — une palette à la fois
        if (!chain.recipientName) { onToast("⚠️ Destinataire requis"); setLoading(false); return; }
        const validPalettes = chain.palettes.filter((p: any) => p.lines.some((l: any) => l.ref.trim()));
        if (!validPalettes.length) { onToast("⚠️ Ajoute au moins une référence"); setLoading(false); return; }
        let ok = 0;
        // Use palette printer (chain uses same config as palette)
        // Use the printer currently selected in the UI dropdown
        const chainPrinter = printerId || getPrinterForTab("chain");
        if (!chainPrinter) { onToast("⚠️ Sélectionne une imprimante"); setLoading(false); return; }
        console.log("[chain] using printer:", chainPrinter, "printerId state:", printerId);
        for (const p of validPalettes) {
          const sscc = (() => {
            const serial = String(Date.now() + ok).slice(-9);
            const raw = "0" + "7383773" + serial;
            const digits = raw.split("").map(Number);
            const check = (10 - (digits.reduce((s: number, d: number, i: number) => s + d * (i % 2 === 0 ? 3 : 1), 0) % 10)) % 10;
            return raw + check;
          })();
          const refs = p.lines.filter(l => l.ref.trim()).map(l => ({ ref: l.ref, lot: l.lot, qty: l.qty ? Number(l.qty) : undefined }));
          const palData: pn.PaletteLabelData = {
            senderName: chain.senderName, recipientName: chain.recipientName,
            recipientAddress: chain.recipientAddress, refs, sscc, unit: chain.unit,
            orderRef: chain.orderRef,
          };
          // Add palette number to refs display via productName hack
          const palDataWithNum = { ...palData, paletteNumber: ok + 1 };
          console.log("[chain] sending palette", ok + 1, "printer:", chainPrinter, "via ZPL");
          const r = await pn.printPaletteLabel(chainPrinter, palDataWithNum, 1);
          console.log("[chain] result palette", ok + 1, r);
          if (r.success) ok++; else { onToast("❌ Palette " + (ok + 1) + ": " + (r.error || "erreur")); break; }
          await new Promise(res => setTimeout(res, 800)); // zebra needs time between jobs
        }
        if (ok === validPalettes.length) {
          onToast(`✅ ${ok} palette(s) envoyées`);
          try { localStorage.setItem("wms_last_chain", JSON.stringify({ ...chain, _savedAt: Date.now() })); } catch {}
        }
        setLoading(false); return;
      }
      if (tab === "blank") {
        if (!labelTemplate.elements.length) { onToast("⚠️ Ajoute au moins un élément"); setLoading(false); return; }
        const pdfB64 = await generateLabelPDF(labelTemplate);
        result = await pn.printPdfLabel(printerId, pdfB64, "Étiquette vierge", qty);
      } else {
        // Auto-generate SSCC if empty (GS1-128: company prefix 7383773 + serial + check digit)
        const sscc = pal.sscc || (() => {
          const serial = String(Date.now()).slice(-9);
          const raw = "0" + "7383773" + serial;
          const digits = raw.split("").map(Number);
          const check = (10 - (digits.reduce((s, d, i) => s + d * (i % 2 === 0 ? 3 : 1), 0) % 10)) % 10;
          return raw + check;
        })();
        if (sscc !== pal.sscc) setPal((p: any) => ({ ...p, sscc }));
        const mainRef = pal.refs[0] || {};
        // Pass all refs as array — ZPL handles multi-product display
        const palData: pn.PaletteLabelData = {
          senderName: pal.senderName, senderAddress: pal.senderAddress,
          recipientName: pal.recipientName, recipientAddress: pal.recipientAddress,
          refs: pal.refs.map((r: any) => ({ ref: r.ref, productName: r.productName, lot: r.lotNumber, qty: r.quantity })),
          sscc: sscc,
          unit: mainRef.unit,
          expiryDate: mainRef.expiryDate,
          weight: pal.refs.find((r: any) => r.weight)?.weight,
          orderRef: pal.orderRef, deliveryRef: pal.deliveryRef,
        };
        // Use ZPL → Labelary → PDF (reliable path for Zebra)
        result = await pn.printPaletteLabel(printerId, palData, qty);
      }
      if (result.success) onToast("✅ Impression envoyée");
      else onToast("❌ " + (result.error || "Erreur impression"));
    } catch (e: any) { onToast("❌ " + e.message); }
    setLoading(false);
  };

  const inp = (val: string, onChange: (v: string) => void, placeholder: string, label: string) => (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 4 }}>{label}</div>
      <input value={val} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        style={{ width: "100%", padding: "10px 12px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 14, fontFamily: "inherit", outline: "none", boxSizing: "border-box" as const, background: C.white }} />
    </div>
  );

  const SIZES = [
    { label: "70×45", w: 70, h: 45 }, { label: "100×150", w: 100, h: 150 },
    { label: "100×70", w: 100, h: 70 }, { label: "50×30", w: 50, h: 30 },
  ];

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
        <button onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex", alignItems: "center", color: C.blue }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div>
          <div style={{ fontSize: 18, fontWeight: 800, color: C.text }}>Impression étiquettes</div>
          <div style={{ fontSize: 12, color: C.textMuted }}>Configure et imprime tes étiquettes</div>
        </div>
      </div>

      {/* Printer + Size */}
      <div style={{ background: C.white, borderRadius: 12, border: `1px solid ${C.border}`, padding: 14, marginBottom: 14, boxShadow: C.shadow }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 10 }}>Configuration</div>
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 4 }}>Imprimante</div>
          <select value={printerId ?? ""} onChange={e => savePrinter(Number(e.target.value))}
            style={{ width: "100%", padding: "10px 12px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 14, fontFamily: "inherit", background: C.white, outline: "none" }}>
            <option value="">-- Sélectionner --</option>
            {printers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 4 }}>Taille (mm)</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" as const }}>
              {SIZES.map(s => (
                <button key={s.label} onClick={() => saveSize({ widthMM: s.w, heightMM: s.h })}
                  style={{ padding: "6px 10px", borderRadius: 6, border: `1px solid ${labelSize.widthMM === s.w && labelSize.heightMM === s.h ? C.blue : C.border}`,
                    background: labelSize.widthMM === s.w && labelSize.heightMM === s.h ? C.blueSoft : C.white,
                    color: labelSize.widthMM === s.w && labelSize.heightMM === s.h ? C.blue : C.text,
                    fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                  {s.label}
                </button>
              ))}
              <input type="number" value={labelSize.widthMM} onChange={e => saveSize({ ...labelSize, widthMM: Number(e.target.value) })}
                style={{ width: 50, padding: "6px 8px", border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12, textAlign: "center" as const, fontFamily: "inherit" }} />
              <span style={{ fontSize: 11, color: C.textMuted, alignSelf: "center" }}>×</span>
              <input type="number" value={labelSize.heightMM} onChange={e => saveSize({ ...labelSize, heightMM: Number(e.target.value) })}
                style={{ width: 50, padding: "6px 8px", border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12, textAlign: "center" as const, fontFamily: "inherit" }} />
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 4 }}>Qté</div>
            <input type="number" min={1} max={99} value={qty} onChange={e => setQty(Math.max(1, Number(e.target.value)))}
              style={{ width: 60, padding: "10px 8px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 14, textAlign: "center" as const, fontFamily: "inherit" }} />
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", background: C.white, borderRadius: 10, border: `1px solid ${C.border}`, overflow: "hidden", marginBottom: 14 }}>
        {([["blank", "✏️ Vierge"], ["palette", "🏭 Palette"], ["chain", "🔗 Chaîne"]] as const).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            style={{ flex: 1, padding: "11px 0", fontSize: 13, fontWeight: 700, cursor: "pointer", border: "none", fontFamily: "inherit",
              background: tab === id ? C.blue : "transparent", color: tab === id ? "#fff" : C.textSec }}>
            {label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ background: C.white, borderRadius: 12, border: `1px solid ${C.border}`, padding: 14, marginBottom: 14, boxShadow: C.shadow }}>

        {/* ── BLANK — éditeur visuel ── */}
        {tab === "blank" && (
          <div>
            <LabelEditor
              template={labelTemplate}
              onChange={setLabelTemplate}
              onPrint={async (pdfB64) => {
                const cfg = pn.getLabelTypeConfig("blank");
                const pid = cfg.printerId || pn.getSavedPrinterId();
                if (!pid) { onToast("⚠️ Sélectionne une imprimante"); return; }
                const r = await pn.printPdfLabel(pid, pdfB64, "Étiquette vierge", qty);
                if (r.success) onToast("✅ Impression envoyée");
                else onToast("❌ " + (r.error || "Erreur"));
              }}
              printing={loading}
            />
          </div>
        )}

        {/* ── PALETTE ── */}
        {tab === "palette" && (
          <div>
            {/* Expéditeur / Destinataire */}
            <div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 10 }}>Expéditeur</div>
            {inp(pal.senderName, v => setPal({ ...pal, senderName: v }), "Nom expéditeur", "Nom")}
            {inp(pal.senderAddress, v => setPal({ ...pal, senderAddress: v }), "Adresse, ville", "Adresse")}
            <div style={{ height: 2, background: C.border, margin: "12px 0" }} />
            <div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 10 }}>Destinataire *</div>
            {inp(pal.recipientName, v => setPal({ ...pal, recipientName: v }), "Nom destinataire *", "Nom *")}
            {inp(pal.recipientAddress, v => setPal({ ...pal, recipientAddress: v }), "Adresse, ville", "Adresse")}
            <div style={{ height: 2, background: C.border, margin: "12px 0" }} />

            {/* Références produits */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>Références produits *</div>
              <button onClick={addRef} style={{ fontSize: 12, color: C.blue, background: "none", border: "none", cursor: "pointer", fontWeight: 700, fontFamily: "inherit" }}>+ Ajouter</button>
            </div>

            {pal.refs.map((ref, i) => (
              <div key={i} style={{ background: C.bg, borderRadius: 10, padding: 12, marginBottom: 10, border: `1px solid ${C.border}` }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: C.textSec }}>Produit {i + 1}</div>
                  {pal.refs.length > 1 && (
                    <button onClick={() => removeRef(i)} style={{ fontSize: 11, color: C.red, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}>Supprimer</button>
                  )}
                </div>

                {/* Odoo search */}
                {session && (
                  <div style={{ position: "relative", marginBottom: 8 }}>
                    <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 4 }}>🔍 Recherche Odoo</div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <input
                        value={activeRefIdx === i ? searchQuery : ""}
                        onChange={e => { setSearchQuery(e.target.value); setActiveRefIdx(i); }}
                        onFocus={() => setActiveRefIdx(i)}
                        placeholder="Réf, nom, code-barres..."
                        style={{ flex: 1, padding: "9px 10px", border: `1px solid ${C.blueBorder}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", background: C.blueSoft }} />
                      <button onClick={() => searchOdoo(searchQuery, i)} disabled={searchLoading}
                        style={{ padding: "9px 12px", borderRadius: 7, border: "none", background: C.blue, color: "#fff", cursor: "pointer", fontSize: 13, fontFamily: "inherit" }}>
                        {searchLoading && activeRefIdx === i ? "..." : "OK"}
                      </button>
                    </div>
                    {activeRefIdx === i && searchResults.length > 0 && (
                      <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, zIndex: 100, boxShadow: C.shadowLg, marginTop: 4 }}>
                        {searchResults.map((r, ri) => (
                          <button key={ri} onClick={() => applySearchResult(r, i)}
                            style={{ width: "100%", padding: "10px 12px", textAlign: "left" as const, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", borderBottom: ri < searchResults.length - 1 ? `1px solid ${C.border}` : "none" }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{r.name}</div>
                            <div style={{ fontSize: 11, color: C.textMuted }}>{[r.ref, r.lotNumber].filter(Boolean).join(" · ")}</div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <div>
                    <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 3 }}>Produit *</div>
                    <input value={ref.productName} onChange={e => updateRef(i, "productName", e.target.value)} placeholder="Nom produit"
                      style={{ width: "100%", padding: "8px 10px", border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" as const }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 3 }}>Référence</div>
                    <input value={ref.ref} onChange={e => updateRef(i, "ref", e.target.value)} placeholder="Réf interne"
                      style={{ width: "100%", padding: "8px 10px", border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" as const }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 3 }}>N° lot</div>
                    <input value={ref.lotNumber} onChange={e => updateRef(i, "lotNumber", e.target.value)} placeholder="Lot"
                      style={{ width: "100%", padding: "8px 10px", border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" as const }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 3 }}>DLUO</div>
                    <input value={ref.expiryDate} onChange={e => updateRef(i, "expiryDate", e.target.value)} placeholder="YYYY-MM-DD"
                      style={{ width: "100%", padding: "8px 10px", border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" as const }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 3 }}>Qté</div>
                    <input type="number" min={1} value={ref.quantity} onChange={e => updateRef(i, "quantity", Number(e.target.value))}
                      style={{ width: "100%", padding: "8px 10px", border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" as const }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 3 }}>Unité</div>
                    <input value={ref.unit} onChange={e => updateRef(i, "unit", e.target.value)} placeholder="cartons, kg…"
                      style={{ width: "100%", padding: "8px 10px", border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" as const }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 3 }}>Unités/carton</div>
                    <input type="number" min={1} value={ref.unitsPerCarton} onChange={e => updateRef(i, "unitsPerCarton", e.target.value)} placeholder="Ex: 6"
                      style={{ width: "100%", padding: "8px 10px", border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" as const }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 3 }}>Poids unitaire (kg)</div>
                    <input type="number" min={0} step={0.01} value={ref.unitWeight}
                      onChange={e => {
                        const uw = e.target.value;
                        const upc = parseFloat(ref.unitsPerCarton) || 1;
                        const qty = Number(ref.quantity) || 0;
                        const total = uw && qty ? `${(parseFloat(uw) * upc * qty).toFixed(2)} kg` : "";
                        const newRefs = [...pal.refs]; newRefs[i] = { ...newRefs[i], unitWeight: uw, weight: total }; setPal({ ...pal, refs: newRefs });
                      }}
                      placeholder="kg/unité"
                      style={{ width: "100%", padding: "8px 10px", border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" as const }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 3 }}>Poids total</div>
                    <input value={ref.weight} onChange={e => updateRef(i, "weight", e.target.value)} placeholder="Calculé auto"
                      style={{ width: "100%", padding: "8px 10px", border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" as const, background: ref.unitWeight ? "#f0fdf4" : undefined }} />
                  </div>
                </div>
              </div>
            ))}

            <div style={{ height: 2, background: C.border, margin: "12px 0" }} />
            <div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 10 }}>Transport</div>
            {inp(pal.sscc, v => setPal({ ...pal, sscc: v }), "18 chiffres *", "SSCC *")}
            {inp(pal.orderRef, v => setPal({ ...pal, orderRef: v }), "N° commande", "N° commande")}
            {inp(pal.deliveryRef, v => setPal({ ...pal, deliveryRef: v }), "N° BL", "N° BL")}
          </div>
        )}
      </div>


        {/* ── CHAÎNE ── */}
        {tab === "chain" && (
          <div>
            {/* Destinataire commun */}
            <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 8 }}>Destinataire commun</div>
            <input value={chain.recipientName} onChange={e => setChain({ ...chain, recipientName: e.target.value })}
              placeholder="Nom destinataire"
              style={{ width: "100%", padding: "9px 10px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 14, fontFamily: "inherit", marginBottom: 6, boxSizing: "border-box" as const }} />
            <input value={chain.recipientAddress} onChange={e => setChain({ ...chain, recipientAddress: e.target.value })}
              placeholder="Adresse (optionnel)"
              style={{ width: "100%", padding: "9px 10px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 14, fontFamily: "inherit", marginBottom: 6, boxSizing: "border-box" as const }} />
            <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
              <input value={chain.senderName} onChange={e => setChain({ ...chain, senderName: e.target.value })}
                placeholder="Expéditeur"
                style={{ flex: 1, minWidth: 0, padding: "8px 10px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" as const }} />
              <input value={chain.unit} onChange={e => setChain({ ...chain, unit: e.target.value })}
                placeholder="Unité"
                style={{ width: 80, padding: "8px 8px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" as const }} />
              <input value={chain.orderRef} onChange={e => setChain({ ...chain, orderRef: e.target.value })}
                placeholder="N° CDE"
                style={{ width: 90, padding: "8px 8px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" as const }} />
            </div>

            {/* Palettes */}
            {chain.palettes.map((pal2, pi) => (
              <div key={pal2.id} style={{ background: C.bg, border: `1.5px solid ${C.border}`, borderRadius: 12, marginBottom: 10, overflow: "hidden" }}>
                {/* Header palette avec grand numéro */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: C.white, borderBottom: `1px solid ${C.border}` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ width: 56, height: 56, borderRadius: 12, background: C.blue, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26, fontWeight: 900, letterSpacing: -1, boxShadow: "0 2px 8px rgba(37,99,235,0.4)" }}>
                      P{pi + 1}
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 800, color: C.text }}>Palette {pi + 1}</div>
                  </div>
                  {chain.palettes.length > 1 && (
                    <button onClick={() => setChain({ ...chain, palettes: chain.palettes.filter((_, j) => j !== pi) })}
                      style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>Supprimer</button>
                  )}
                </div>
                {/* Lignes ref */}
                <div style={{ padding: "8px 10px" }}>
                  {pal2.lines.map((line, li) => (
                    <div key={li} style={{ display: "flex", gap: 5, marginBottom: 5, alignItems: "center" }}>
                      <input value={line.ref} onChange={e => {
                        const ps = [...chain.palettes]; ps[pi].lines[li].ref = e.target.value; setChain({ ...chain, palettes: ps });
                      }} placeholder="Réf / Désignation"
                        style={{ flex: 2, minWidth: 0, padding: "7px 8px", border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" as const }} />
                      <input value={line.lot} onChange={e => {
                        const ps = [...chain.palettes]; ps[pi].lines[li].lot = e.target.value; setChain({ ...chain, palettes: ps });
                      }} placeholder="Lot"
                        style={{ flex: 1, minWidth: 0, padding: "7px 6px", border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" as const }} />
                      <input value={line.qty} onChange={e => {
                        const ps = [...chain.palettes]; ps[pi].lines[li].qty = e.target.value; setChain({ ...chain, palettes: ps });
                      }} placeholder="Qté"
                        style={{ width: 52, padding: "7px 4px", border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", textAlign: "center" as const, boxSizing: "border-box" as const }} />
                      {pal2.lines.length > 1 && (
                        <button onClick={() => {
                          const ps = [...chain.palettes]; ps[pi].lines = ps[pi].lines.filter((_, j) => j !== li); setChain({ ...chain, palettes: ps });
                        }} style={{ background: "none", border: "none", color: C.textMuted, cursor: "pointer", fontSize: 16, lineHeight: 1, flexShrink: 0 }}>✕</button>
                      )}
                    </div>
                  ))}
                  <button onClick={() => {
                    const ps = [...chain.palettes]; ps[pi].lines.push({ ref: "", qty: "", lot: "" }); setChain({ ...chain, palettes: ps });
                  }} style={{ width: "100%", padding: "5px", border: `1px dashed ${C.border}`, borderRadius: 6, background: "transparent", color: C.textMuted, cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>
                    + Ligne
                  </button>
                </div>
              </div>
            ))}

            <button onClick={() => setChain({ ...chain, palettes: [...chain.palettes, emptyChainPalette()] })}
              style={{ width: "100%", padding: 10, border: `1px dashed ${C.blue}`, borderRadius: 8, background: C.blueSoft, color: C.blue, cursor: "pointer", fontSize: 13, fontWeight: 700, fontFamily: "inherit", marginBottom: 10 }}>
              + Palette {chain.palettes.length + 1}
            </button>

            {/* Dernier envoi */}
            {(() => {
              try {
                const saved = localStorage.getItem("wms_last_chain");
                if (!saved) return null;
                const last = JSON.parse(saved);
                const date = last._savedAt ? new Date(last._savedAt).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
                return (
                  <div style={{ marginBottom: 10, padding: "10px 12px", background: "#f8faff", border: `1px solid ${C.blueBorder}`, borderRadius: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: C.blue, textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>
                        🕐 Dernier envoi{date ? " · " + date : ""}
                      </div>
                      <button onClick={() => {
                        try {
                          const s = localStorage.getItem("wms_last_chain");
                          if (s) setChain(JSON.parse(s));
                          onToast("✅ Dernier envoi rechargé");
                        } catch {}
                      }} style={{ fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 6, border: `1px solid ${C.blue}`, background: C.blueSoft, color: C.blue, cursor: "pointer", fontFamily: "inherit" }}>
                        ↩ Recharger
                      </button>
                    </div>
                    <div style={{ fontSize: 12, color: C.textSec }}>
                      <span style={{ fontWeight: 600 }}>{last.recipientName || "—"}</span>
                      {last.orderRef ? <span style={{ color: C.textMuted }}> · {last.orderRef}</span> : null}
                      <span style={{ color: C.textMuted }}> · {last.palettes?.length || 0} palette(s)</span>
                    </div>
                  </div>
                );
              } catch { return null; }
            })()}

            {/* Packing list button */}
            <button onClick={() => generatePackingListPDF(chain)}
              style={{ width: "100%", padding: "11px", borderRadius: 10, border: `1.5px solid ${C.green}`,
                background: "#f0fdf4", color: C.green, fontSize: 14, fontWeight: 700,
                fontFamily: "inherit", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
              📋 Générer Packing List A4
            </button>
          </div>
        )}


      {/* Preview modal — chain tab, desktop only */}
      {showChainPreview && tab === "chain" && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ background: C.white, borderRadius: 16, width: "100%", maxWidth: 900, maxHeight: "90vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.4)" }}>
            <div style={{ padding: "16px 20px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontWeight: 800, fontSize: 16, color: C.text }}>👁 Aperçu — {chain.palettes.length} palette(s)</div>
              <button onClick={() => setShowChainPreview(false)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 20, color: C.textMuted }}>✕</button>
            </div>
            <div style={{ padding: 20, display: "flex", gap: 16, flexWrap: "wrap" as const }}>
              {chain.palettes.filter(p => p.lines.some(l => l.ref.trim())).map((p, pi) => {
                const sscc = "0" + "7383773" + String(Date.now() + pi).slice(-9) + "0";
                const palData: pn.PaletteLabelData = {
                  senderName: chain.senderName, recipientName: chain.recipientName,
                  recipientAddress: chain.recipientAddress,
                  refs: p.lines.filter(l => l.ref.trim()).map(l => ({ ref: l.ref, lot: l.lot, qty: l.qty ? Number(l.qty) : undefined })),
                  sscc, unit: chain.unit, orderRef: chain.orderRef,
                };
                return (
                  <div key={p.id} style={{ flex: "0 0 auto" }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: C.blue, marginBottom: 6, textAlign: "center" as const }}>P{pi + 1}</div>
                    <PalettePreview pal={{ ...palData, _paletteNumber: pi + 1 }} />
                  </div>
                );
              })}
            </div>
            <div style={{ padding: "14px 20px", borderTop: `1px solid ${C.border}`, display: "flex", gap: 10 }}>
              <button onClick={() => setShowChainPreview(false)}
                style={{ flex: 1, padding: 12, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", color: C.textSec }}>
                Modifier
              </button>
              <button onClick={() => { setShowChainPreview(false); handlePrint(); }} disabled={loading}
                style={{ flex: 2, padding: 12, background: C.blue, border: "none", borderRadius: 10, fontSize: 14, fontWeight: 800, cursor: "pointer", fontFamily: "inherit", color: "#fff" }}>
                {loading ? "Envoi..." : "🖨️ Imprimer " + chain.palettes.length + " palette(s)"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Preview modal — desktop only, palette tab only */}
      {showPreview && tab === "palette" && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ background: C.white, borderRadius: 16, width: "100%", maxWidth: 680, maxHeight: "90vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.4)" }}>
            <div style={{ padding: "16px 20px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontWeight: 800, fontSize: 16, color: C.text }}>👁 Aperçu étiquette palette</div>
              <button onClick={() => setShowPreview(false)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 20, color: C.textMuted }}>✕</button>
            </div>
            <div style={{ padding: 20 }}>
              <PalettePreview pal={pal} />
            </div>
            <div style={{ padding: "14px 20px", borderTop: `1px solid ${C.border}`, display: "flex", gap: 10 }}>
              <button onClick={() => setShowPreview(false)}
                style={{ flex: 1, padding: 12, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", color: C.textSec }}>
                Modifier
              </button>
              <button onClick={() => { setShowPreview(false); handlePrint(); }} disabled={loading}
                style={{ flex: 2, padding: 12, background: C.blue, border: "none", borderRadius: 10, fontSize: 14, fontWeight: 800, cursor: "pointer", fontFamily: "inherit", color: "#fff" }}>
                {loading ? "Envoi..." : ("🖨️ Imprimer" + (qty > 1 ? " (×" + qty + ")" : ""))}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Print / Preview buttons */}
      {(tab === "palette" || tab === "chain") && isDesktop ? (
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={() => tab === "chain" ? setShowChainPreview(true) : setShowPreview(true)}
            style={{ flex: 1, padding: "14px", borderRadius: 12, border: `2px solid ${C.blue}`, cursor: "pointer",
              background: C.white, color: C.blue, fontSize: 14, fontWeight: 800, fontFamily: "inherit" }}>
            👁 Aperçu
          </button>
          <button onClick={handlePrint} disabled={loading || !printerId}
            style={{ flex: 2, padding: "14px", borderRadius: 12, border: "none", cursor: loading || !printerId ? "not-allowed" : "pointer",
              background: loading || !printerId ? C.borderStrong : C.blue, color: "#fff",
              fontSize: 15, fontWeight: 800, fontFamily: "inherit" }}>
            {loading ? "Envoi en cours..." : ("🖨️ Imprimer" + (qty > 1 ? " (×" + qty + ")" : ""))}
          </button>
        </div>
      ) : (
        <button onClick={handlePrint} disabled={loading || !printerId}
          style={{ width: "100%", padding: "14px", borderRadius: 12, border: "none", cursor: loading || !printerId ? "not-allowed" : "pointer",
            background: loading || !printerId ? C.borderStrong : C.blue, color: "#fff",
            fontSize: 15, fontWeight: 800, fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
          {loading ? "Envoi en cours..." : ("🖨️ Imprimer" + (qty > 1 ? " (×" + qty + ")" : ""))}
        </button>
      )}
    </div>
  );
}

// ============================================
// PALETTE LABEL PREVIEW (desktop only)
// ============================================
function PalettePreview({ pal }: { pal: any }) {
  const refs = pal.refs || [];
  const mainRef = refs[0] || {};
  const totalWeight = refs.reduce((sum: number, r: any) => {
    const w = parseFloat(r.weight) || 0; return sum + w;
  }, 0);

  return (
    <div style={{
      border: "2px solid #000", borderRadius: 4, fontFamily: "monospace",
      width: "100%", maxWidth: 500, margin: "0 auto",
      background: "#fff", fontSize: 12,
    }}>
      {/* Header: sender / recipient */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", borderBottom: "2px solid #000" }}>
        <div style={{ padding: "10px 12px", borderRight: "1px solid #000" }}>
          <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", color: "#666", marginBottom: 3 }}>Expéditeur</div>
          <div style={{ fontWeight: 700, fontSize: 13 }}>{pal.senderName || "—"}</div>
          {pal.senderAddress && <div style={{ fontSize: 11, color: "#444" }}>{pal.senderAddress}</div>}
        </div>
        <div style={{ padding: "10px 12px" }}>
          <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", color: "#666", marginBottom: 3 }}>Destinataire</div>
          <div style={{ fontWeight: 700, fontSize: 13 }}>{pal.recipientName || "—"}</div>
          {pal.recipientAddress && <div style={{ fontSize: 11, color: "#444" }}>{pal.recipientAddress}</div>}
        </div>
      </div>

      {/* Refs */}
      <div style={{ padding: "10px 12px", borderBottom: "2px solid #000" }}>
        <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", color: "#666", marginBottom: 6 }}>Références produits</div>
        {refs.map((r: any, i: number) => (
          <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderBottom: i < refs.length - 1 ? "1px dashed #ddd" : "none" }}>
            <div>
              <span style={{ fontWeight: 700, fontSize: 13 }}>{r.productName || "—"}</span>
              {r.ref && <span style={{ fontSize: 10, color: "#666", marginLeft: 6 }}>({r.ref})</span>}
              {r.lotNumber && <span style={{ fontSize: 10, color: "#444", marginLeft: 6 }}>Lot: {r.lotNumber}</span>}
            </div>
            <div style={{ textAlign: "right" as const, fontSize: 11 }}>
              <div style={{ fontWeight: 700 }}>{r.quantity} {r.unit}</div>
              {r.expiryDate && <div style={{ color: "#666" }}>DLUO: {r.expiryDate}</div>}
              {r.weight && <div style={{ color: "#444" }}>{r.weight}</div>}
            </div>
          </div>
        ))}
        {totalWeight > 0 && (
          <div style={{ marginTop: 6, textAlign: "right" as const, fontWeight: 700, fontSize: 13 }}>
            Poids total : {totalWeight.toFixed(2)} kg
          </div>
        )}
      </div>

      {/* Refs orders */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", borderBottom: "2px solid #000" }}>
        <div style={{ padding: "8px 12px", borderRight: "1px solid #000" }}>
          <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", color: "#666", marginBottom: 2 }}>N° Commande</div>
          <div style={{ fontWeight: 700, fontSize: 13 }}>{pal.orderRef || "—"}</div>
        </div>
        <div style={{ padding: "8px 12px" }}>
          <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", color: "#666", marginBottom: 2 }}>N° BL</div>
          <div style={{ fontWeight: 700, fontSize: 13 }}>{pal.deliveryRef || "—"}</div>
        </div>
      </div>

      {/* SSCC barcode mockup */}
      <div style={{ padding: "12px", textAlign: "center" as const }}>
        <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", color: "#666", marginBottom: 6 }}>Code SSCC (GS1-128)</div>
        <div style={{
          background: "#000", height: 48, borderRadius: 2, marginBottom: 4,
          backgroundImage: "repeating-linear-gradient(90deg, #000 0px, #000 2px, #fff 2px, #fff 4px)",
          opacity: pal.sscc ? 1 : 0.2,
        }} />
        <div style={{ fontFamily: "monospace", fontSize: 11, letterSpacing: "0.1em", fontWeight: 700 }}>
          {pal.sscc ? `(00)${pal.sscc}` : "SSCC non renseigné"}
        </div>
      </div>
    </div>
  );
}


function BigButton({ icon, label, sub, color, onClick, disabled }: { icon: React.ReactNode; label: string; sub?: string; color?: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      width: "100%", display: "flex", alignItems: "center", gap: 14, padding: "16px 20px",
      background: color || C.blue, border: "none", borderRadius: 14, cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.6 : 1, boxShadow: `0 2px 8px ${(color || C.blue)}33`, fontFamily: "inherit",
    }}>
      <div style={{ width: 40, height: 40, borderRadius: 10, background: "rgba(255,255,255,0.2)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{icon}</div>
      <div style={{ textAlign: "left" }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}>{label}</div>
        {sub && <div style={{ fontSize: 12, color: "rgba(255,255,255,0.7)", marginTop: 2 }}>{sub}</div>}
      </div>
    </button>
  );
}

function StatBox({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <div style={{ flex: 1, padding: "10px 12px", background: C.overlay, textAlign: "center" }}>
      <div style={{ fontSize: 20, fontWeight: 800, color }}>{value}</div>
      <div style={{ fontSize: 10, color: C.textMuted, fontWeight: 600 }}>{label}</div>
    </div>
  );
}

function Chip({ color, children }: { color: string; children: React.ReactNode }) {
  return <span style={{ fontSize: 10, fontWeight: 600, color, marginLeft: 6, padding: "1px 6px", borderRadius: 4, background: `${color}15` }}>{children}</span>;
}

function Spinner() { return <span style={{ fontSize: 11, color: C.blue, animation: "pulse 1s infinite" }}>Chargement...</span>; }

function StepIndicator({ step, steps }: { step: number; steps: string[] }) {
  return (
    <div style={{ display: "flex", gap: 8, marginBottom: 20, alignItems: "center" }}>
      {steps.map((s, i) => (
        <div key={s} style={{ flex: 1, textAlign: "center" }}>
          <div style={{ width: 28, height: 28, borderRadius: "50%", margin: "0 auto 4px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700,
            background: step > i ? C.green : step === i ? C.blue : C.border,
            color: step >= i ? "#fff" : C.textMuted, transition: "all .2s",
          }}>{step > i ? "✓" : i + 1}</div>
          <div style={{ fontSize: 11, fontWeight: 600, color: step === i ? C.blue : step > i ? C.green : C.textMuted }}>{s}</div>
        </div>
      ))}
    </div>
  );
}

function InputBar({ onSubmit, placeholder }: { onSubmit: (v: string) => void; placeholder: string }) {
  const [v, setV] = useState("");
  return (
    <div style={{ display: "flex", gap: 8 }}>
      <input style={inputStyle} value={v} onChange={e => setV(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter" && v.trim()) { e.stopPropagation(); onSubmit(v.trim()); setV(""); } }}
        placeholder={placeholder} />
      <button onClick={() => { if (v.trim()) { onSubmit(v.trim()); setV(""); } }}
        style={{ padding: "0 18px", background: C.blue, color: "#fff", border: "none", borderRadius: 10, fontWeight: 700, fontSize: 16, cursor: "pointer", flexShrink: 0 }}>→</button>
    </div>
  );
}

function AutoInput({ locations, onScan, onPickLoc, placeholder }: any) {
  const [v, setV] = useState("");
  const [sugg, setSugg] = useState<any[]>([]);
  const [show, setShow] = useState(false);
  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value; setV(val);
    if (val.length >= 2) {
      const l = val.toLowerCase();
      const m = locations.filter((x: any) => (x.name||"").toLowerCase().includes(l) || (x.complete_name||"").toLowerCase().includes(l) || (x.barcode||"").toLowerCase().includes(l));
      // Sort: exact match > starts with > contains
      m.sort((a: any, b: any) => {
        const an = (a.name||"").toLowerCase(), bn = (b.name||"").toLowerCase();
        const ac = (a.complete_name||"").toLowerCase(), bc = (b.complete_name||"").toLowerCase();
        // Exact match on name
        const aExact = an === l || an.endsWith("-" + l) ? 0 : 1;
        const bExact = bn === l || bn.endsWith("-" + l) ? 0 : 1;
        if (aExact !== bExact) return aExact - bExact;
        // Starts with or segment starts with (after -)
        const aStarts = an.startsWith(l) || an.includes("-" + l) ? 0 : 1;
        const bStarts = bn.startsWith(l) || bn.includes("-" + l) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        // Shorter name = more precise
        return an.length - bn.length;
      });
      setSugg(m.slice(0, 15)); setShow(m.length > 0);
    } else { setSugg([]); setShow(false); }
  };
  return (
    <div style={{ position: "relative" }}>
      <input style={inputStyle} value={v} onChange={onChange}
        onKeyDown={e => { if (e.key === "Enter" && v.trim()) { e.stopPropagation(); setShow(false); onScan(v.trim()); setV(""); } }}
        onFocus={() => { if (sugg.length) setShow(true); }}
        onBlur={() => setTimeout(() => setShow(false), 200)}
        placeholder={placeholder} />
      {show && (
        <div style={{ position: "absolute", top: 50, left: 0, right: 0, zIndex: 50, background: C.white, border: `1px solid ${C.blue}`, borderRadius: 10, boxShadow: C.shadowLg, maxHeight: 200, overflowY: "auto" }}>
          {sugg.map((loc: any) => (
            <button key={loc.id} onMouseDown={() => { onPickLoc(loc); setV(""); setSugg([]); setShow(false); }}
              style={{ display: "flex", justifyContent: "space-between", width: "100%", padding: "10px 14px", background: "none", border: "none", borderBottom: `1px solid ${C.border}`, color: C.text, fontSize: 13, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
              <span style={{ fontWeight: 600 }}>{loc.name}</span>
              {loc.barcode && <span style={{ color: C.textMuted, fontSize: 11 }}>{loc.barcode}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function LocCard({ loc, label, content, color, onRename, onClear }: { loc: any; label: string; content: any[]; color: string; onRename: (id: number, n: string) => void; onClear: () => void }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(loc.name);
  useEffect(() => setName(loc.name), [loc.name]);
  const grouped = Object.values(content.reduce((a: any, q: any) => {
    const k = q.product_id[0];
    if (!a[k]) a[k] = { name: q.product_id[1], qty: 0, res: 0 };
    a[k].qty += q.quantity; a[k].res += q.reserved_quantity || 0;
    return a;
  }, {})) as any[];

  return (
    <div style={{ background: C.white, borderRadius: 14, border: `1px solid ${C.border}`, marginBottom: 12, overflow: "hidden", boxShadow: C.shadow }}>
      <div style={{ padding: "12px 16px", borderLeft: `4px solid ${color}` }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
            {editing ? (
              <div style={{ display: "flex", gap: 4, marginTop: 2 }}>
                <input style={{ ...inputStyle, fontSize: 14, padding: "4px 8px", fontWeight: 700 }} value={name} onChange={e => setName(e.target.value)}
                  onKeyDown={e => { e.stopPropagation(); if (e.key === "Enter") { onRename(loc.id, name); setEditing(false); } if (e.key === "Escape") setEditing(false); }} autoFocus />
              </div>
            ) : (
              <div style={{ fontSize: 16, fontWeight: 700, color: C.text, display: "flex", alignItems: "center", gap: 6 }}>
                {loc.name}
                <button onClick={() => setEditing(true)} style={{ ...iconBtn, width: 22, height: 22 }}>{editIcon}</button>
              </div>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button onClick={() => setOpen(!open)} style={{ ...iconBtn, fontSize: 12, color: C.textMuted }}>{grouped.length} réf {open ? "▲" : "▼"}</button>
            <button onClick={onClear} style={{ ...iconBtn, color: C.red, fontSize: 11 }}>✕</button>
          </div>
        </div>
      </div>
      {open && (
        <div style={{ padding: "0 16px 12px", borderTop: `1px solid ${C.border}` }}>
          {grouped.length === 0 && <div style={{ padding: "10px 0", fontSize: 12, color: C.textMuted, textAlign: "center" }}>Vide</div>}
          {grouped.slice(0, 20).map((p, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: i < grouped.length - 1 ? `1px solid ${C.border}` : "none", fontSize: 12 }}>
              <span style={{ color: C.text, fontWeight: 500, maxWidth: "70%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
              <span style={{ fontWeight: 700, color: (p.qty - p.res) > 0 ? C.green : C.orange }}>{p.qty - p.res}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================
// LOOKUP CARDS
// ============================================
function ProductResult({ product, stock, onRename }: { product: any; stock: any[]; onRename?: (id: number, name: string) => void }) {
  const [editingLocId, setEditingLocId] = useState<number | null>(null);
  const [editLocName, setEditLocName] = useState("");
  const tQ = stock.reduce((s, q) => s + q.quantity, 0);
  const tR = stock.reduce((s, q) => s + (q.reserved_quantity || 0), 0);
  return (
    <Section>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 2 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{product.name}{product.active === false && <Chip color={C.orange}>archivé</Chip>}</div>
          <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 12 }}>{product.default_code || ""} {product.barcode ? `· ${product.barcode}` : ""}</div>
        </div>
        {product.barcode && (
          <button onClick={() => requestPrint({ type: "product", title: product.name, barcode: product.barcode, ref: product.default_code, productName: product.name })}
            style={{ ...iconBtn, background: C.bg, borderRadius: 8, padding: "6px 10px", marginLeft: 8, flexShrink: 0 }}
            title="Imprimer étiquette">
            {printerIcon}
          </button>
        )}
      </div>
      <div style={{ display: "flex", gap: 1, borderRadius: 10, overflow: "hidden", marginBottom: 14 }}>
        <StatBox value={tQ - tR} label="DISPO" color={C.green} />
        <StatBox value={tQ} label="STOCK" color={C.textSec} />
      </div>
      <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>Par emplacement</div>
      {stock.map((q, i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: i < stock.length - 1 ? `1px solid ${C.border}` : "", fontSize: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              {editingLocId === q.location_id[0] ? (
                <form onSubmit={(e) => { e.preventDefault(); if (onRename && editLocName.trim()) { onRename(q.location_id[0], editLocName.trim()); setEditingLocId(null); } }} style={{ display: "flex", gap: 4, flex: 1 }}>
                  <input value={editLocName} onChange={e => setEditLocName(e.target.value)} autoFocus
                    style={{ flex: 1, padding: "4px 8px", border: `1.5px solid ${C.blue}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit", outline: "none" }} />
                  <button type="submit" style={{ padding: "4px 8px", background: C.blue, color: "#fff", border: "none", borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>OK</button>
                  <button type="button" onClick={() => setEditingLocId(null)} style={{ padding: "4px 8px", background: C.bg, color: C.textMuted, border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 11, cursor: "pointer" }}>✕</button>
                </form>
              ) : (
                <>
                  <span style={{ fontWeight: 600, color: C.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{q.location_id[1]}</span>

                  {onRename && (
                    <button onClick={() => { setEditingLocId(q.location_id[0]); setEditLocName(q.location_id[1].split("/").pop() || ""); }}
                      style={{ background: "none", border: "none", padding: 0, cursor: "pointer", flexShrink: 0, display: "inline-flex" }}
                      title="Renommer l'emplacement">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={C.textMuted} strokeWidth="2"><path d="M17 3a2.85 2.85 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
                    </button>
                  )}
                </>
              )}
            </div>
            {q.lot_id && (
              <button
                onClick={() => requestPrint({
                  type: "lot", title: `${q.lot_name || q.lot_id[1]} — ${product.name}`,
                  barcode: q.lot_name || q.lot_id[1], lotName: q.lot_name || q.lot_id[1], productName: product.name,
                  expiryDate: q.expiration_date || "",
                })}
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit",
                  fontSize: 11, color: C.blue, fontWeight: 600, display: "flex", alignItems: "center", gap: 4, marginTop: 2 }}>
                {printerSmallIcon} {q.lot_id[1]}
                {q.expiration_date && <span style={{ color: C.textMuted, fontWeight: 400 }}> · {(() => { try { return new Date(q.expiration_date).toLocaleDateString("fr-FR", { month: "2-digit", year: "numeric" }); } catch { return ""; } })()}</span>}
              </button>
            )}
          </div>
          <span style={{ fontWeight: 700, marginLeft: 8, color: (q.quantity - (q.reserved_quantity||0)) > 0 ? C.green : C.orange }}>{q.quantity - (q.reserved_quantity||0)}</span>
        </div>
      ))}
    </Section>
  );
}

function LotResult({ lot, product, stock }: { lot: any; product: any; stock: any[] }) {
  const tQ = stock.reduce((s, q) => s + q.quantity, 0);
  const tR = stock.reduce((s, q) => s + (q.reserved_quantity || 0), 0);
  return (
    <Section>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 2 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>Lot {lot.name}</div>
          <div style={{ fontSize: 12, color: C.textMuted }}>{product?.name}</div>
          {product?.default_code && <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 12 }}>Réf: {product.default_code}</div>}
        </div>
        {lot.name && (
          <button onClick={() => requestPrint({ type: "lot", title: `${lot.name} — ${product?.name || ""}`, barcode: lot.name, lotName: lot.name, productName: product?.name || "", expiryDate: lot.expiration_date || lot.use_date || lot.removal_date || "" })}
            style={{ ...iconBtn, background: C.bg, borderRadius: 8, padding: "6px 10px", marginLeft: 8, flexShrink: 0 }}
            title="Imprimer étiquette lot">
            {printerIcon}
          </button>
        )}
      </div>
      <div style={{ display: "flex", gap: 1, borderRadius: 10, overflow: "hidden", marginBottom: 14 }}>
        <StatBox value={tQ - tR} label="DISPO" color={C.green} />
        <StatBox value={tQ} label="STOCK" color={C.textSec} />
      </div>
      {stock.map((q, i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: i < stock.length - 1 ? `1px solid ${C.border}` : "", fontSize: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ fontWeight: 600 }}>{q.location_id[1]}</span>

          </div>
          <span style={{ fontWeight: 700, color: C.green }}>{q.quantity - (q.reserved_quantity||0)}</span>
        </div>
      ))}
    </Section>
  );
}

function LocationResult({ location, stock, onRename }: { location: any; stock: any[]; onRename?: (id: number, name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [locName, setLocName] = useState(location.name);
  useEffect(() => setLocName(location.name), [location.name]);

  return (
    <Section>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 2 }}>
        <div style={{ flex: 1 }}>
          {editing ? (
            <div style={{ display: "flex", gap: 4, marginBottom: 4 }}>
              <input style={{ ...inputStyle, fontSize: 15, padding: "4px 8px", fontWeight: 700 }} value={locName}
                onChange={e => setLocName(e.target.value)}
                onKeyDown={e => { e.stopPropagation(); if (e.key === "Enter" && onRename) { onRename(location.id, locName); setEditing(false); } if (e.key === "Escape") { setLocName(location.name); setEditing(false); } }}
                autoFocus />
            </div>
          ) : (
            <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 2, display: "flex", alignItems: "center", gap: 6 }}>
              {location.name}
              {onRename && <button onClick={() => setEditing(true)} style={{ ...iconBtn, width: 22, height: 22 }}>{editIcon}</button>}
            </div>
          )}
          <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 12 }}>{location.barcode || location.complete_name} · {stock.length} réf</div>
        </div>
        {location.barcode && (
          <button onClick={() => requestPrint({ type: "location", title: location.name, barcode: location.barcode, locationName: location.name })}
            style={{ ...iconBtn, background: C.bg, borderRadius: 8, padding: "6px 10px", marginLeft: 8, flexShrink: 0 }}
            title="Imprimer étiquette emplacement">
            {printerIcon}
          </button>
        )}
      </div>
      {stock.map((q, i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: i < stock.length - 1 ? `1px solid ${C.border}` : "", fontSize: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontWeight: 600 }}>{q.product_id[1]}</span>
              {q.product_barcode && (
                <button onClick={() => requestPrint({
                  type: "product", title: q.product_id[1], barcode: q.product_barcode, ref: q.product_ref, productName: q.product_id[1],
                })}
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", display: "inline-flex", alignItems: "center" }}
                title="Imprimer étiquette produit">
                  {printerSmallIcon}
                </button>
              )}
            </div>
            {q.lot_id && (
              <button onClick={() => requestPrint({
                type: "lot", title: `${q.lot_name || q.lot_id[1]} — ${q.product_id[1]}`,
                barcode: q.lot_name || q.lot_id[1], lotName: q.lot_name || q.lot_id[1], productName: q.product_id[1],
                expiryDate: q.expiration_date || "",
              })}
              style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit",
                fontSize: 11, color: C.blue, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 3, marginTop: 2 }}>
                {printerSmallIcon} {q.lot_name || q.lot_id[1]}
                {q.expiration_date && <span style={{ color: C.textMuted, fontWeight: 400 }}> · {(() => { try { return new Date(q.expiration_date).toLocaleDateString("fr-FR", { month: "2-digit", year: "numeric" }); } catch { return ""; } })()}</span>}
              </button>
            )}
          </div>
          <span style={{ fontWeight: 700, color: C.green, marginLeft: 8 }}>{q.quantity - (q.reserved_quantity||0)}</span>
        </div>
      ))}
    </Section>
  );
}

// ============================================
// LOGIN
// ============================================
// ============================================
// PRINT MODAL — choose quantity before printing
// ============================================
function PrintModal({ req, onClose, onToast }: { req: PrintRequest; onClose: () => void; onToast: (m: string) => void }) {
  const [copies, setCopies] = useState(1);
  const [sending, setSending] = useState(false);

  const typeLabels: Record<string, string> = {
    product: "Produit", lot: "Lot", location: "Emplacement", picking: "Colis" };
  const typeColors: Record<string, string> = { product: C.blue, lot: C.green, location: "#7c3aed", picking: "#0891b2" };

  const doPrint = async () => {
    setSending(true);
    const result = await executePrint(req, copies);
    setSending(false);
    if (result.success) {
      onToast(`✓ ${copies} étiquette(s) envoyée(s)`);
      vibrateSuccess();
    } else {
      onToast("✕ Erreur impression");
      vibrateError();
    }
    onClose();
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "flex-end", justifyContent: "center", background: "rgba(0,0,0,0.4)", animation: "fadeIn .15s" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ width: "100%", maxWidth: 440, background: C.white, borderRadius: "20px 20px 0 0", padding: "24px 20px 32px", boxShadow: "0 -4px 30px rgba(0,0,0,0.15)", animation: "slideUp .2s" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {printerIcon}
            <span style={{ fontSize: 16, fontWeight: 700, color: C.text }}>Imprimer</span>
            <span style={{ fontSize: 11, fontWeight: 600, color: typeColors[req.type] || C.blue, background: `${typeColors[req.type] || C.blue}15`, padding: "2px 8px", borderRadius: 6 }}>
              {typeLabels[req.type] || req.type}
            </span>
          </div>
          <button onClick={onClose} style={{ ...iconBtn, background: C.bg, borderRadius: 8, padding: 6 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={C.textMuted} strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        {/* Label preview info */}
        <div style={{ background: C.bg, borderRadius: 12, padding: 14, marginBottom: 16 }}>
          {req.type === "product" && <>
            {req.ref && <div style={{ fontSize: 13, fontWeight: 700, color: C.blue, marginBottom: 2 }}>{req.ref}</div>}
            <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 4 }}>{req.productName || req.title}</div>
            <div style={{ fontSize: 11, color: C.textMuted, fontFamily: "monospace" }}>{req.barcode}</div>
          </>}
          {req.type === "lot" && <>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 2 }}>{req.lotName}</div>
            <div style={{ fontSize: 12, color: C.textSec, marginBottom: 4 }}>{req.productName}</div>
            {req.expiryDate && <div style={{ fontSize: 12, color: C.orange, fontWeight: 600 }}>
              DLUO: {(() => { try { return new Date(req.expiryDate).toLocaleDateString("fr-FR"); } catch { return req.expiryDate; } })()}
            </div>}
            <div style={{ fontSize: 11, color: C.textMuted, fontFamily: "monospace", marginTop: 4 }}>{req.barcode}</div>
          </>}
          {req.type === "location" && <>
            <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 2 }}>{(req.locationName || req.title || "").split("/").pop()?.split("-")[0] || req.title}</div>
            <div style={{ fontSize: 11, color: C.textMuted, fontFamily: "monospace" }}>{req.barcode}</div>
          </>}
        </div>

        {/* Quantity */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>Nombre d'étiquettes</div>
          <div style={{ display: "flex", alignItems: "stretch", gap: 0, border: `1.5px solid ${C.border}`, borderRadius: 12, overflow: "hidden", background: C.white, maxWidth: 220, margin: "0 auto" }}>
            <button onClick={() => setCopies(c => Math.max(1, c - 1))}
              style={{ width: 56, flexShrink: 0, background: C.bg, border: "none", fontSize: 22, fontWeight: 700, color: C.text, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", borderRight: `1px solid ${C.border}` }}>−</button>
            <input type="number" value={copies} min={1} max={99}
              onChange={e => { const v = parseInt(e.target.value); if (v > 0 && v <= 99) setCopies(v); }}
              onKeyDown={e => e.stopPropagation()}
              style={{ flex: 1, minWidth: 0, textAlign: "center", fontSize: 22, fontWeight: 800, fontFamily: "'DM Mono', monospace", border: "none", padding: "10px 0", background: C.white, color: C.text, outline: "none" }} />
            <button onClick={() => setCopies(c => Math.min(99, c + 1))}
              style={{ width: 56, flexShrink: 0, background: C.blue, border: "none", fontSize: 22, fontWeight: 700, color: "#fff", cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", borderLeft: `1px solid ${C.blue}` }}>+</button>
          </div>
          {/* Presets */}
          <div style={{ display: "flex", justifyContent: "center", gap: 6, marginTop: 10 }}>
            {[1, 2, 5, 10, 25].map(n => (
              <button key={n} onClick={() => setCopies(n)}
                style={{ padding: "6px 12px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                  background: copies === n ? C.blue : C.bg, color: copies === n ? "#fff" : C.textSec,
                  border: `1px solid ${copies === n ? C.blue : C.border}`, transition: "all .1s",
                }}>{n}</button>
            ))}
          </div>
        </div>

        {/* Print button */}
        <button onClick={doPrint} disabled={sending}
          style={{ width: "100%", padding: 16, background: typeColors[req.type] || C.blue, color: "#fff", border: "none", borderRadius: 12, fontSize: 16, fontWeight: 700,
            cursor: sending ? "wait" : "pointer", fontFamily: "inherit", opacity: sending ? 0.6 : 1, transition: "all .15s",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
          }}>
          {printerIconWhite}
          {sending ? "Envoi en cours..." : `Imprimer ${copies} étiquette${copies > 1 ? "s" : ""}`}
        </button>
      </div>
    </div>
  );
}

const qtyBtnStyle: React.CSSProperties = {
  width: 44, height: 44, borderRadius: 12, border: `2px solid ${C.border}`, background: C.bg,
  fontSize: 22, fontWeight: 700, color: C.text, cursor: "pointer", fontFamily: "inherit",
  display: "flex", alignItems: "center", justifyContent: "center",
};

const printerIconWhite = <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><path d="M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>;

// ============================================
// E-SHOP SCREEN — SendCloud order preparation
// ============================================
function EshopScreen({ session, onBack, onToast }: { session: any; onBack: () => void; onToast: (m: string) => void }) {
  const [parcels, setParcels] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedParcel, setSelectedParcel] = useState<any>(null);
  const [matchData, setMatchData] = useState<Record<string, any>>({});
  const [locationData, setLocationData] = useState<Record<number, any>>({});
  const [preparedIds, setPreparedIds] = useState<Set<string>>(new Set());
  const [printing, setPrinting] = useState(false);
  const [filter, setFilter] = useState<"pending" | "prepared" | "all">("pending");
  const [chariotSkus, setChariotSkus] = useState<string[]>([]);
  const [chariotLoaded, setChariotLoaded] = useState(false);

  const savePrepared = async (ids: Set<string>) => {
    setPreparedIds(ids);
    try { await odoo.savePreparedOrders(session, Array.from(ids)); } catch(e) { console.error("savePrepared:", e); }
  };

  // Load orders from SendCloud V3
  // Load shared state from Odoo on mount
  useEffect(() => {
    if (!session) return;
    odoo.getConfigParam(session, "wms_eshop_chariot_skus").then(val => {
      console.log("[chariot] val from Odoo:", val);
      if (val) { try { const p = JSON.parse(val); setChariotSkus(p); setChariotSkusLocal(p); } catch {} }
      setChariotLoaded(true);
    }).catch((e) => { console.log("[chariot] error:", e); setChariotLoaded(true); });
    odoo.loadPreparedOrders(session).then(orders => {
      if (orders.length) setPreparedIds(new Set<string>(orders));
    }).catch(() => {});
  }, [session]);

  const loadParcels = async () => {
    setLoading(true); setError("");
    try {
      const res = await fetch("/api/sendcloud?action=orders");
      if (!res.ok) { const err = await res.json(); throw new Error(err.error || `Erreur ${res.status}`); }
      const data = await res.json();
      // Normalize V3 order structure to match UI expectations
      const allParcels = (data.orders || []).map((o: any) => ({
        id: o.id,
        order_number: o.order_number,
        name: o.shipping_address?.name || "",
        company_name: o.shipping_address?.company_name || "",
        address: [o.shipping_address?.address_line_1, o.shipping_address?.house_number].filter(Boolean).join(" "),
        postal_code: o.shipping_address?.postal_code || "",
        city: o.shipping_address?.city || "",
        country: { name: o.shipping_address?.country_code || "" },
        email: o.shipping_address?.email || "",
        telephone: o.shipping_address?.phone_number || "",
        parcel_items: (o.order_items || o.order_details?.order_items || []).map((item: any) => ({
          sku: item.sku,
          description: item.name,
          quantity: item.quantity,
          value: item.unit_price?.value ?? 0,
          properties: Object.entries(item.properties || {}).map(([k, v]) => `${k}: ${v}`).join(", ") || undefined,
        })),
        status: { id: 1000, message: o.order_details?.status?.message || "Ouvert" },
        _raw: o,
      }));
      // Filter: status "Ouvert" (code "0") + exclude Unstamped letter
      const allowedParcels = allParcels.filter((o: any) => {
        const statusCode = o._raw?.order_details?.status?.code ?? o._raw?.status?.code;
        if (statusCode !== "0") return false;
        const delivery = (o._raw?.shipping_details?.delivery_indicator || "").toLowerCase();
        return !delivery.includes("unstamped") && !delivery.includes("letter") && !delivery.includes("briefmarke");
      });
      setParcels(allowedParcels);

      // Match SKUs with Odoo
      const allRefs = Array.from(new Set(
        allParcels.flatMap((p: any) => (p.parcel_items || []).map((item: any) => item.sku)).filter(Boolean)
      )) as string[];
      if (allRefs.length > 0 && session) {
        const matches = await odoo.matchSupplierRefs(session, allRefs);
        setMatchData(matches);
        const productIds = Array.from(new Set(
          Object.values(matches).map((m: any) => m.product_id).filter(Boolean)
        )) as number[];
        if (productIds.length > 0) {
          const locs = await odoo.getProductLocations(session, productIds);
          setLocationData(locs);
        }
      }
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  useEffect(() => { loadParcels(); }, []);

  // Print SendCloud label
  const printPackingSlip = async (p: any) => {
    try {
      const items = (p.parcel_items || []).map((item: any) => {
        const match = matchData[item.sku];
        return {
          name: match?.product_name || item.description || item.sku,
          sku: item.sku,
          quantity: item.quantity || 1,
          properties: item.properties || undefined,
        };
      });
      const raw = p._raw || {};
      const addr = raw.shipping_address || {};
      const pdfBase64 = await generateEshopPackingSlipPDF({
        order_number: p.order_number,
        order_date: raw.order_details?.order_created_at ? new Date(raw.order_details.order_created_at).toLocaleDateString("fr-FR", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : undefined,
        shipping_method: raw.shipping_details?.delivery_indicator,
        recipient_name: addr.name || p.name,
        recipient_address: addr.address_line_1 || p.address,
        recipient_postal: addr.postal_code || p.postal_code,
        recipient_city: addr.city || p.city,
        recipient_country: addr.country_code || "FR",
        items,
      });
      const psCfg = pn.getLabelTypeConfig("packingslip");
      const printerId = psCfg.printerId || pn.getSavedPrinterId();
      if (printerId) {
        await pn.printPdfLabel(printerId, pdfBase64, `BL ${p.order_number}`);
        onToast(`✓ BL ${p.order_number} imprimé`);
      } else {
        const byteArray = Uint8Array.from(atob(pdfBase64), c => c.charCodeAt(0));
        const blob = new Blob([byteArray], { type: "application/pdf" });
        window.open(URL.createObjectURL(blob), "_blank");
        onToast("BL ouvert dans un nouvel onglet");
      }
    } catch (e: any) { onToast(`⚠ BL: ${e.message}`); }
  };

  const printLabel = async (p: any) => {
    setPrinting(true);
    try {
      const orderId = p._raw?.order_id || p.id;
      const orderNumber = p.order_number;
      const res = await fetch(`/api/sendcloud?action=label&order_id=${orderId}&order_number=${orderNumber}`);
      if (!res.ok) { const err = await res.json(); throw new Error(err.error || "Erreur étiquette"); }
      const data = await res.json();

      const scCfg = pn.getLabelTypeConfig("sendcloud");
      const printerId = scCfg.printerId || pn.getSavedPrinterId();
      if (printerId && data.labelBase64) {
        const result = await pn.printPdfLabel(printerId, data.labelBase64, `SendCloud ${orderNumber}`);
        if (result.success) {
          onToast(`✓ Étiquette ${data.tracking || orderNumber} imprimée`);
          vibrateSuccess();
        } else {
          throw new Error(result.error || "Erreur impression");
        }
      } else {
        // Fallback: download PDF
        const byteArray = Uint8Array.from(atob(data.labelBase64), c => c.charCodeAt(0));
        const blob = new Blob([byteArray], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);
        window.open(url, "_blank");
        onToast("PDF ouvert dans un nouvel onglet");
      }
    } catch (e: any) { setError(e.message); vibrateError(); }
    setPrinting(false);
  };

  const markPrepared = async (parcelId: string) => {
    const newSet = new Set(Array.from(preparedIds));
    newSet.add(parcelId);
    savePrepared(newSet);
    vibrateSuccess();
    onToast("✓ Marqué préparé");
  };

  const unmarkPrepared = async (parcelId: string) => {
    const newSet = new Set(Array.from(preparedIds));
    newSet.delete(parcelId);
    savePrepared(newSet);
  };

  const getMatch = (sku: string) => matchData[sku];
  const getLocation = (sku: string) => {
    const match = getMatch(sku);
    if (match?.product_id) return locationData[match.product_id];
    return null;
  };

  // Include prepared orders that may no longer appear in SendCloud open list
  const allVisibleParcels = [
    ...parcels,
    // Add prepared orders not already in parcels list (fetched from prepared state)
    ...Array.from(preparedIds)
      .filter(on => !parcels.find((p: any) => p.order_number === on))
      .map(on => ({ order_number: on, _preparedOnly: true, id: on, name: "—", city: "", parcel_items: [] }))
  ];

  const filteredParcels = allVisibleParcels.filter((p: any) => {
    if (filter === "pending") return !preparedIds.has(p.order_number);
    if (filter === "prepared") return preparedIds.has(p.order_number);
    return true;
  });

  const pendingCount = allVisibleParcels.filter((p: any) => !preparedIds.has(p.order_number)).length;
  const preparedCount = preparedIds.size;

  // Detail view — scan-based preparation
  const [scannedSkus, setScannedSkus] = useState<Record<string, number>>({});
  const [scanError, setScanError] = useState("");

  // Reset scan state when opening a new parcel
  const openParcel = async (p: any) => {
    setScannedSkus({});
    setScanError("");
    // Refresh chariot SKUs from Odoo each time we open a parcel
    if (session) {
      try {
        const parsed = await odoo.loadChariotSkus(session); setChariotSkus(parsed); setChariotSkusLocal(parsed);
      } catch {}
    }
    setSelectedParcel(p);
  };

  const handleEshopScan = (code: string) => {
    if (!selectedParcel) return;
    const p = selectedParcel;
    const items = (p.parcel_items || p.lines || []).filter((item: any) => {
      const val = parseFloat(item.value || "0");
      const sku = (item.sku || "").toLowerCase();
      if (val < 0 || sku.startsWith("offre_") || item.description === "Bon de réduction") return false;
      return true;
    }).map((item: any) => ({
      ...item,
      _isChariot: chariotSkus.some(ex => ex.toLowerCase() === (item.sku || "").toLowerCase()),
    }));
    setScanError("");
    const trimmed = code.trim();
    const matched = items.find((item: any) => {
      const match = getMatch(item.sku);
      return item.sku === trimmed || match?.default_code === trimmed || match?.barcode === trimmed;
    });
    if (!matched) {
      setScanError(`❌ "${trimmed}" — article non trouvé dans cette commande`);
      vibrateError();
      return;
    }
    const required = matched.quantity || 1;
    const current = scannedSkus[matched.sku] || 0;
    if (current >= required) {
      setScanError(`⚠ "${matched.description || matched.sku}" déjà scanné (${required}/${required})`);
      return;
    }
    const newCount = current + 1;
    setScannedSkus(prev => ({ ...prev, [matched.sku]: newCount }));
    if (newCount >= required) { vibrateSuccess(); onToast(`✓ ${matched.description || matched.sku}`); }
  };

  useScannerListener(handleEshopScan, !!selectedParcel && !preparedIds.has(selectedParcel?.order_number));

  if (selectedParcel) {
    const p = selectedParcel;
    const items = (p.parcel_items || p.lines || []).filter((item: any) => {
      const val = parseFloat(item.value || "0");
      const sku = (item.sku || "").toLowerCase();
      if (val < 0 || sku.startsWith("offre_") || item.description === "Bon de réduction") return false;
      return true;
    }).map((item: any) => ({
      ...item,
      _isChariot: chariotSkus.some(ex => ex.toLowerCase() === (item.sku || "").toLowerCase()),
    }));
    const isPrepared = preparedIds.has(p.order_number);

    // Sort items by location for optimal picking path
    items.sort((a: any, b: any) => {
      const locA = getLocation(a.sku)?.location_name || "zzz";
      const locB = getLocation(b.sku)?.location_name || "zzz";
      return locA.localeCompare(locB);
    });

    // For each item: qty required vs qty scanned (chariot items auto-validated)
    const getScanned = (item: any) => item._isChariot ? (item.quantity || 1) : (scannedSkus[item.sku] || 0);
    const allScanned = items.length > 0 && items.every((item: any) => getScanned(item) >= (item.quantity || 1));

    // Scan handler — match by SKU or Odoo default_code or barcode
    const handleScan = (code: string) => {
      setScanError("");
      const trimmed = code.trim();
      // Find item by SKU or odoo ref
      const matched = items.find((item: any) => {
        const match = getMatch(item.sku);
        return item.sku === trimmed
          || match?.default_code === trimmed
          || match?.barcode === trimmed;
      });
      if (!matched) {
        setScanError(`❌ "${trimmed}" — article non trouvé dans cette commande`);
        vibrateError();
        return;
      }
      const required = matched.quantity || 1;
      const current = scannedSkus[matched.sku] || 0;
      if (current >= required) {
        setScanError(`⚠ "${matched.description || matched.sku}" déjà scanné (${required}/${required})`);
        return;
      }
      const newCount = current + 1;
      setScannedSkus(prev => ({ ...prev, [matched.sku]: newCount }));
      if (newCount >= required) {
        vibrateSuccess();
        onToast(`✓ ${matched.description || matched.sku}`);
      }
    };

    return (
      <>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <button onClick={() => setSelectedParcel(null)} style={{ ...iconBtn, background: C.bg, borderRadius: 8, padding: 8 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{p.order_number || `#${p.id}`}</div>
            <div style={{ fontSize: 12, color: C.textSec }}>{p.name} — {p.city}</div>
          </div>
          {isPrepared
            ? <span style={{ fontSize: 11, fontWeight: 700, color: C.green, background: C.greenSoft, padding: "3px 8px", borderRadius: 6 }}>✓ Préparé</span>
            : allScanned
              ? <span style={{ fontSize: 11, fontWeight: 700, color: C.green, background: C.greenSoft, padding: "3px 8px", borderRadius: 6 }}>✓ Prêt</span>
              : <span style={{ fontSize: 11, fontWeight: 700, color: C.orange, background: C.orangeSoft, padding: "3px 8px", borderRadius: 6 }}>{items.filter((it: any) => getScanned(it) >= (it.quantity || 1)).length}/{items.length} scannés</span>
          }
        </div>

        {/* Customer info */}
        <Section>
          <div style={{ fontSize: 12, color: C.textSec }}>
            <div style={{ fontWeight: 600 }}>{p.name}</div>
            {p.company_name && <div>{p.company_name}</div>}
            <div>{p.address}</div>
            <div>{p.postal_code} {p.city}</div>
            {p.email && <div style={{ color: C.blue, marginTop: 4 }}>{p.email}</div>}
            {p.telephone && <div>{p.telephone}</div>}
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
            {p._raw?.shipping_details?.delivery_indicator && (
              <span style={{ fontSize: 11, fontWeight: 600, color: "#7c3aed", background: "#f3e8ff", padding: "2px 8px", borderRadius: 6 }}>
                🚚 {p._raw.shipping_details.delivery_indicator}
              </span>
            )}
          </div>
        </Section>

        {/* Articles */}
        <Section>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 10 }}>Articles à préparer</div>
          {items.length === 0 && <div style={{ fontSize: 12, color: C.textMuted }}>Aucun article détaillé</div>}
          {items.map((item: any, i: number) => {
            const match = getMatch(item.sku);
            const loc = getLocation(item.sku);
            const required = item.quantity || 1;
            const scanned = getScanned(item);
            const done = scanned >= required;
            return (
              <div key={i} style={{
                padding: "10px 0",
                borderBottom: i < items.length - 1 ? `1px solid ${C.border}` : "",
                display: "flex", gap: 10, alignItems: "flex-start",
                opacity: done ? 0.6 : 1,
              }}>
                {/* Status icon */}
                <div style={{
                  width: 36, height: 36, borderRadius: 8, flexShrink: 0,
                  background: done ? C.greenSoft : C.border,
                  display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18,
                }}>
                  {done ? "✅" : item._isChariot ? "🛒" : "⬜"}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{match?.product_name || item.description || item.sku}</div>
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
                    SKU: {item.sku || "N/A"}
                    {match?.default_code && <span> · Réf: {match.default_code}</span>}
                  </div>
                  {item._isChariot ? (
                    <div style={{ fontSize: 11, fontWeight: 600, color: "#7c3aed", marginTop: 4 }}>🛒 Chariot Eshop</div>
                  ) : loc ? (
                    <div style={{ fontSize: 11, fontWeight: 600, color: "#059669", marginTop: 4 }}>
                      📍 {loc.location_name} <span style={{ fontWeight: 400, color: C.textMuted }}>({loc.quantity} en stock)</span>
                    </div>
                  ) : match ? (
                    <div style={{ fontSize: 11, color: C.orange, marginTop: 4 }}>⚠ Pas de stock trouvé</div>
                  ) : null}
                </div>
                {/* Qty counter */}
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div style={{ fontSize: 18, fontWeight: 800, color: done ? C.green : C.text }}>
                    {scanned}<span style={{ fontSize: 12, color: C.textMuted }}>/{required}</span>
                  </div>
                  {!done && !item._isChariot && !isPrepared && (
                    <button onClick={() => handleEshopScan(item.sku)}
                      style={{ fontSize: 10, color: C.blue, background: C.blueSoft, border: "none", borderRadius: 4, padding: "2px 6px", cursor: "pointer", marginTop: 2, fontFamily: "inherit" }}>
                      +1
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </Section>

        {scanError && (
          <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "8px 12px", marginBottom: 8, fontSize: 12, color: "#dc2626" }}>
            {scanError}
          </div>
        )}
        {error && <Alert type="error">{error}</Alert>}

        {/* Actions */}
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <button onClick={() => printLabel(p)} disabled={printing}
            style={{ flex: 1, padding: 12, background: C.blueSoft, color: C.blue, border: `1px solid ${C.blueBorder}`, borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
            {printing ? "⏳" : "🚚 Étiquette"}
          </button>
          <button onClick={() => printPackingSlip(p)} disabled={printing}
            style={{ flex: 1, padding: 12, background: C.greenSoft, color: C.green, border: `1px solid ${C.greenBorder}`, borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
            📄 BL
          </button>
        </div>

        {!isPrepared ? (
          <BigButton
            icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>}
            label={allScanned ? "Confirmer la préparation" : "Forcer comme préparé"}
            sub={allScanned ? `${items.length} article(s) tous scannés` : `${items.filter((it: any) => getScanned(it) >= (it.quantity || 1)).length}/${items.length} scannés`}
            color={allScanned ? C.green : C.orange}
            onClick={async () => {
              onToast("⏳ Impression étiquette + BL...");
              await printLabel(p);
              await printPackingSlip(p);
              await markPrepared(p.order_number);
              setSelectedParcel(null);
              onToast("✓ Préparation confirmée");
            }}
          />
        ) : (
          <BigButton
            icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>}
            label="Annuler la préparation"
            color={C.orange}
            onClick={async () => { await unmarkPrepared(p.order_number); setSelectedParcel(null); }}
          />
        )}
      </>
    );
  }

  // List view
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button onClick={onBack} style={{ ...iconBtn, background: C.bg, borderRadius: 8, padding: 8 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: C.text }}>E-shop</h2>
            <p style={{ fontSize: 12, color: C.textMuted }}>{parcels.length} commande(s) SendCloud</p>
          </div>
        </div>
        <button onClick={loadParcels} disabled={loading} style={{ ...iconBtn, background: C.blueSoft, borderRadius: 10, padding: "8px 12px" }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={C.blue} strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
        </button>
      </div>

      {/* Filter tabs */}
      <div style={{ display: "flex", gap: 4, marginBottom: 14 }}>
        {([["pending", `À préparer (${pendingCount})`], ["prepared", `Préparées (${preparedCount})`], ["all", "Tout"]] as [string, string][]).map(([key, label]) => (
          <button key={key} onClick={() => setFilter(key as any)} style={{
            flex: 1, padding: "8px 0", border: `1.5px solid ${filter === key ? "#f59e0b" : C.border}`,
            background: filter === key ? "#fef3c7" : C.white, color: filter === key ? "#92400e" : C.textSec,
            borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
          }}>{label}</button>
        ))}
      </div>

      {error && <Alert type="error">{error}</Alert>}
      {loading && parcels.length === 0 && <div style={{ textAlign: "center", padding: 40, color: C.textMuted }}>Chargement des commandes SendCloud...</div>}
      {!loading && parcels.length === 0 && <Alert type="info">Aucune commande trouvée. Vérifie les clés API SendCloud dans les variables Vercel.</Alert>}

      {filteredParcels.map((p: any) => {
        const isPrepared = preparedIds.has(p.order_number);
        const items = p.parcel_items || p.lines || [];
        const statusMsg = p.status?.message || "";
        return (
          <div key={p.id} style={{ ...cardStyle, marginBottom: 8, borderLeft: `3px solid ${isPrepared ? C.green : "#f59e0b"}`, cursor: "pointer" }}
            onClick={() => openParcel(p)}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{p.order_number || `#${p.id}`}</div>
                <div style={{ fontSize: 12, color: C.textSec }}>{p.name}</div>
                <div style={{ fontSize: 11, color: C.textMuted }}>{p.postal_code} {p.city} · {p.country?.name || p.country_iso_2 || ""}</div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                {isPrepared ? (
                  <span style={{ fontSize: 10, fontWeight: 700, color: C.green, background: C.greenSoft, padding: "2px 8px", borderRadius: 6 }}>✓ Préparé</span>
                ) : (
                  <span style={{ fontSize: 10, fontWeight: 700, color: "#92400e", background: "#fef3c7", padding: "2px 8px", borderRadius: 6 }}>{statusMsg || "En attente"}</span>
                )}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
              {items.length > 0 && <span style={{ fontSize: 10, color: C.textMuted, background: C.bg, padding: "2px 6px", borderRadius: 4 }}>{items.length} art.</span>}
              {p.carrier?.code && <span style={{ fontSize: 10, color: "#7c3aed", background: "#f3e8ff", padding: "2px 6px", borderRadius: 4 }}>{p.carrier.code}</span>}
              {p.tracking_number && <span style={{ fontSize: 10, color: C.textMuted, background: C.bg, padding: "2px 6px", borderRadius: 4 }}>📦 {p.tracking_number}</span>}
            </div>
          </div>
        );
      })}
    </>
  );
}

// ============================================
// ARRIVAL SCREEN — Packing List Import
// ============================================
// ============================================
// PALLET REF SEARCH
// ============================================
function PalletRefSearch({ packingData, matchData }: { packingData: any; matchData: Record<string, any> }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ palletNo: string; supplierRef: string; productName: string; lot: string; expiry: string; qty: number; cartonCount: number }[]>([]);

  const search = () => {
    if (!query.trim()) { setResults([]); return; }
    const q = query.trim().toLowerCase();
    const found: typeof results = [];
    for (const pallet of packingData.pallets) {
      const summary: Record<string, any> = {};
      for (const c of pallet.cartons) {
        const key = `${c.supplierRef}_${c.lot}`;
        if (!summary[key]) summary[key] = { palletNo: pallet.palletNo, supplierRef: c.supplierRef, lot: c.lot, expiry: c.expiry, qty: 0, cartonCount: 0 };
        summary[key].qty += c.qtyProduct;
        summary[key].cartonCount += 1;
      }
      for (const v of Object.values(summary) as any[]) {
        const match = matchData[v.supplierRef];
        const name = match?.product_name || match?.default_code || v.supplierRef;
        if (
          v.supplierRef?.toLowerCase().includes(q) ||
          name?.toLowerCase().includes(q) ||
          match?.default_code?.toLowerCase().includes(q) ||
          v.lot?.toLowerCase().includes(q)
        ) {
          found.push({ ...v, productName: name });
        }
      }
    }
    setResults(found);
  };

  return (
    <div style={{ background: "#fff", borderRadius: 12, border: `1px solid ${C.border}`, padding: 14, marginBottom: 14, boxShadow: C.shadow }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 10 }}>🔍 Trouver une référence</div>
      <div style={{ display: "flex", gap: 8 }}>
        <input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === "Enter" && search()}
          placeholder="Réf fournisseur, nom produit, lot..."
          style={{ flex: 1, padding: "10px 12px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 14, fontFamily: "inherit", outline: "none" }} />
        <button onClick={search}
          style={{ padding: "10px 16px", background: C.blue, color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontWeight: 700, fontFamily: "inherit", fontSize: 13 }}>
          OK
        </button>
      </div>
      {results.length > 0 && (
        <div style={{ marginTop: 10 }}>
          {results.map((r, i) => (
            <div key={i} style={{ padding: "10px 12px", background: C.bg, borderRadius: 8, marginBottom: 6, borderLeft: `3px solid ${C.blue}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{r.productName}</div>
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>Réf: {r.supplierRef}{r.lot ? ` · Lot: ${r.lot}` : ""}{r.expiry ? ` · Exp: ${r.expiry}` : ""}</div>
                </div>
                <div style={{ textAlign: "right" as const, flexShrink: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 800, color: C.blue }}>Palette {r.palletNo}</div>
                  <div style={{ fontSize: 11, color: C.textMuted }}>{r.cartonCount} colis · {r.qty} unités</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {results.length === 0 && query && (
        <div style={{ marginTop: 8, fontSize: 12, color: C.textMuted, textAlign: "center" as const }}>Aucun résultat pour "{query}"</div>
      )}
    </div>
  );
}

function ArrivalScreen({ session, onBack, onToast }: { session: any; onBack: () => void; onToast: (m: string) => void }) {
  const [step, setStep] = useState<"list" | "result">("list");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [packingData, setPackingData] = useState<any>(null);
  const [matchData, setMatchData] = useState<Record<string, any>>({});
  const [locationData, setLocationData] = useState<Record<number, any>>({});
  const [openPallets, setOpenPallets] = useState<Record<string, boolean>>({});
  const [savedList, setSavedList] = useState<any[]>([]);

  // Load saved packing lists on mount
  useEffect(() => { loadSavedList(); }, []);
  const loadSavedList = async () => {
    if (!session) return;
    try {
      const list = await odoo.listPackingLists(session);
      setSavedList(list);
    } catch {}
  };

  // Enrich packing data with Odoo matches
  const enrichWithOdoo = async (data: any) => {
    const allRefs = Array.from(new Set(
      data.pallets.flatMap((p: any) => p.cartons.map((c: any) => c.supplierRef)).filter(Boolean)
    )) as string[];
    if (allRefs.length > 0 && session) {
      const matches = await odoo.matchSupplierRefs(session, allRefs);
      setMatchData(matches);
      const productIds = Array.from(new Set(
        Object.values(matches).map((m: any) => m.product_id).filter(Boolean)
      )) as number[];
      if (productIds.length > 0) {
        const locs = await odoo.getProductLocations(session, productIds);
        setLocationData(locs);
      }
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoading(true); setError("");
    try {
      const arrayBuffer = await file.arrayBuffer();
      const PDFJS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174";
      let pdfjsLib = (window as any).pdfjsLib;
      if (!pdfjsLib) {
        await new Promise<void>((resolve, reject) => {
          const s = document.createElement("script");
          s.src = `${PDFJS_CDN}/pdf.min.js`;
          s.onload = () => resolve();
          s.onerror = () => reject(new Error("Impossible de charger pdf.js"));
          document.head.appendChild(s);
        });
        pdfjsLib = (window as any).pdfjsLib;
        pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_CDN}/pdf.worker.min.js`;
      }
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      let fullText = "";
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        let lastY: number | null = null;
        let lineText = "";
        for (const item of content.items) {
          const it = item as any;
          if (!it.str) continue;
          const y = it.transform ? it.transform[5] : null;
          if (lastY !== null && y !== null && Math.abs(y - lastY) > 3) {
            fullText += lineText.trim() + "\n";
            lineText = "";
          }
          lineText += it.str + " ";
          lastY = y;
        }
        if (lineText.trim()) fullText += lineText.trim() + "\n";
        fullText += "\n";
      }

      const res = await fetch("/api/packing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: fullText }),
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error || "Erreur parsing"); }
      const data = await res.json();
      setPackingData(data);

      // Save to Odoo for sharing (non-blocking)
      const saveName = data.transportNr || `import_${Date.now()}`;
      try { await odoo.savePackingList(session, saveName, data); } catch (saveErr: any) { console.warn("Sauvegarde packing list:", saveErr.message); }

      await enrichWithOdoo(data);

      if (data.pallets.length > 0) {
        setOpenPallets({ [data.pallets[0].palletNo]: true });
      }
      setStep("result");
      onToast(`✓ ${data.totalPallets} palette(s), ${data.totalCartons} carton(s) — sauvegardé`);
      loadSavedList();
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const loadSaved = async (attachment: any) => {
    setLoading(true); setError("");
    try {
      const name = attachment.name.replace("packing_", "").replace(".json", "");
      const data = await odoo.loadPackingList(session, name);
      if (!data) throw new Error("Données introuvables");
      setPackingData(data);
      await enrichWithOdoo(data);
      if (data.pallets?.length > 0) {
        setOpenPallets({ [data.pallets[0].palletNo]: true });
      }
      setStep("result");
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const deleteSaved = async (id: number) => {
    try {
      await odoo.deletePackingList(session, id);
      setSavedList(prev => prev.filter(a => a.id !== id));
      onToast("✓ Supprimé");
    } catch {}
  };

  const togglePallet = (no: string) => setOpenPallets(prev => ({ ...prev, [no]: !prev[no] }));

  const getMatch = (supplierRef: string) => matchData[supplierRef];
  const getLocation = (supplierRef: string) => {
    const match = getMatch(supplierRef);
    if (match?.product_id) return locationData[match.product_id];
    return null;
  };

  const totalRefs = packingData ? Array.from(new Set(packingData.pallets.flatMap((p: any) => p.cartons.map((c: any) => c.supplierRef)))).length : 0;
  const matchedRefs = Object.keys(matchData).length;
  const unmatchedRefs = totalRefs - matchedRefs;

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <button onClick={onBack} style={{ ...iconBtn, background: C.bg, borderRadius: 8, padding: 8 }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: C.text }}>Arrivage</h2>
          <p style={{ fontSize: 12, color: C.textMuted }}>Importer une packing list WALA</p>
        </div>
      </div>

      {step === "list" && (
        <>
          {/* Upload new */}
          <Section>
            <div style={{ textAlign: "center", padding: "20px 16px" }}>
              <div style={{ fontSize: 36, marginBottom: 12 }}>📦</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 6 }}>Importer une Packing List</div>
              <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 16 }}>
                Le PDF sera analysé et partagé sur tous les appareils connectés.
              </div>
              <label style={{
                display: "inline-block", padding: "12px 28px", background: "#059669", color: "#fff",
                borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
                opacity: loading ? 0.6 : 1,
              }}>
                {loading ? "Analyse en cours..." : "Choisir le PDF"}
                <input type="file" accept=".pdf" onChange={handleUpload} style={{ display: "none" }} disabled={loading} />
              </label>
            </div>
          </Section>

          {error && <Alert type="error">{error}</Alert>}

          {/* Saved packing lists */}
          {savedList.length > 0 && (
            <Section>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 10 }}>Packing lists enregistrées</div>
              {savedList.map((a) => {
                const name = a.name.replace("packing_", "").replace(".json", "");
                const dateStr = a.write_date ? new Date(a.write_date).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
                return (
                  <div key={a.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
                    <button onClick={() => loadSaved(a)} style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", textAlign: "left", flex: 1, padding: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: C.blue }}>{name}</div>
                      <div style={{ fontSize: 11, color: C.textMuted }}>{dateStr}</div>
                    </button>
                    <button onClick={() => deleteSaved(a.id)} style={{ ...iconBtn, background: C.bg, borderRadius: 6, padding: "4px 8px", fontSize: 11, color: C.red }}>
                      ✕
                    </button>
                  </div>
                );
              })}
            </Section>
          )}
        </>
      )}

      {step === "result" && packingData && (
        <>
          {/* Summary */}
          <Section>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>Transport {packingData.transportNr || "N/A"}</div>
                {packingData.date && <div style={{ fontSize: 11, color: C.textMuted }}>{packingData.date}</div>}
              </div>
              <button onClick={() => { setStep("list"); setPackingData(null); setMatchData({}); setLocationData({}); loadSavedList(); }}
                style={{ ...iconBtn, background: C.bg, borderRadius: 8, padding: "6px 10px", fontSize: 11, fontWeight: 600, color: C.textSec, border: `1px solid ${C.border}` }}>
                Nouveau
              </button>
            </div>
            <div style={{ display: "flex", gap: 1, borderRadius: 10, overflow: "hidden" }}>
              <StatBox value={packingData.totalPallets} label="PALETTES" color="#059669" />
              <StatBox value={packingData.totalCartons} label="CARTONS" color={C.blue} />
              <StatBox value={matchedRefs} label="MATCHÉS" color={C.green} />
              {unmatchedRefs > 0 && <StatBox value={unmatchedRefs} label="INCONNUS" color={C.red} />}
            </div>
          </Section>

          {error && <Alert type="error">{error}</Alert>}

          {/* Search by ref */}
          {packingData && (
            <PalletRefSearch packingData={packingData} matchData={matchData} />
          )}

          {/* Palettes */}
          {packingData.pallets.map((pallet: any, pi: number) => {
            const isOpen = !!openPallets[pallet.palletNo];
            // Aggregate products on this pallet
            const prodSummary: Record<string, { supplierRef: string; desc: string; lot: string; expiry: string; totalQty: number; cartonCount: number }> = {};
            for (const c of pallet.cartons) {
              const key = `${c.supplierRef}_${c.lot}`;
              if (!prodSummary[key]) {
                prodSummary[key] = { supplierRef: c.supplierRef, desc: c.productDesc, lot: c.lot, expiry: c.expiry, totalQty: 0, cartonCount: 0 };
              }
              prodSummary[key].totalQty += c.qtyProduct;
              prodSummary[key].cartonCount += 1;
            }
            const products = Object.values(prodSummary);

            return (
              <div key={pi} style={{ marginBottom: 10 }}>
                <button onClick={() => togglePallet(pallet.palletNo)} style={{
                  width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "12px 14px", background: C.white, border: `1px solid ${C.border}`, borderRadius: 10,
                  cursor: "pointer", fontFamily: "inherit", boxShadow: C.shadow,
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 16 }}>🔷</span>
                    <div style={{ textAlign: "left" }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>Palette {pallet.palletNo}</div>
                      <div style={{ fontSize: 11, color: C.textMuted }}><span style={{ fontWeight: 700, color: C.text }}>{pallet.cartons.length} colis</span> · {products.length} réf(s){pallet.dimensions ? ` · ${pallet.dimensions}` : ""}</div>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 800, color: "#059669", background: "#ecfdf5", padding: "2px 10px", borderRadius: 10 }}>{pallet.cartons.length}<span style={{ fontSize: 10, fontWeight: 500, marginLeft: 2 }}>colis</span></span>
                    <span style={{ fontSize: 12, color: C.textMuted, transition: "transform .2s", transform: isOpen ? "rotate(180deg)" : "rotate(0)" }}>▼</span>
                  </div>
                </button>

                {isOpen && (
                  <div style={{ marginTop: 6 }}>
                    {products.map((prod, j) => {
                      const match = getMatch(prod.supplierRef);
                      const loc = getLocation(prod.supplierRef);
                      const isMatched = !!match;
                      return (
                        <div key={j} style={{ ...cardStyle, marginBottom: 6, borderLeft: `3px solid ${isMatched ? C.green : C.orange}` }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                            <div style={{ flex: 1 }}>
                              {isMatched ? (
                                <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{match.product_name}</div>
                              ) : (
                                <div style={{ fontSize: 13, fontWeight: 700, color: C.orange }}>{prod.desc} <span style={{ fontSize: 10, fontWeight: 400 }}>(non trouvé)</span></div>
                              )}
                              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
                                Réf fourn: {prod.supplierRef}
                                {match?.default_code && <span> · Réf interne: {match.default_code}</span>}
                              </div>
                            </div>
                            <div style={{ textAlign: "right", flexShrink: 0 }}>
                              <div style={{ fontSize: 16, fontWeight: 800, color: C.text }}>{prod.cartonCount} <span style={{ fontSize: 11, fontWeight: 500 }}>crt</span></div>
                              <div style={{ fontSize: 11, color: C.textMuted }}>{prod.totalQty} unités</div>
                            </div>
                          </div>
                          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" as const, alignItems: "center" }}>
                            {prod.lot && (
                              <button
                                onClick={() => requestPrint({ type: "lot", title: prod.lot, barcode: prod.lot, lotName: prod.lot, productName: match?.product_name || prod.desc, expiryDate: prod.expiry })}
                                title="Imprimer étiquette lot"
                                style={{ fontSize: 11, fontWeight: 600, color: C.blue, background: C.blueSoft, padding: "2px 8px", borderRadius: 6, border: `1px solid ${C.blue}`, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 4 }}>
                                🖨 Lot {prod.lot}
                              </button>
                            )}
                            {match?.default_code && (
                              <button
                                onClick={() => requestPrint({ type: "product", title: match.product_name || prod.desc, barcode: match.barcode || match.default_code, ref: match.default_code, productName: match.product_name || prod.desc })}
                                title="Imprimer étiquette produit"
                                style={{ fontSize: 11, fontWeight: 600, color: "#7c3aed", background: "#f5f3ff", padding: "2px 8px", borderRadius: 6, border: "1px solid #7c3aed", cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 4 }}>
                                🖨 {match.default_code}
                              </button>
                            )}
                            {prod.expiry && (
                              <span style={{ fontSize: 11, color: C.textMuted, background: C.bg, padding: "2px 8px", borderRadius: 6 }}>
                                Exp: {prod.expiry}
                              </span>
                            )}
                            {loc && (
                              <span style={{ fontSize: 11, fontWeight: 600, color: "#059669", background: "#ecfdf5", padding: "2px 8px", borderRadius: 6, border: "1px solid #059669", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 4 }}>
                                📍 {loc.location_name} ({loc.quantity} en stock)
                              </span>
                            )}
                            {isMatched && !loc && (
                              <span style={{ fontSize: 11, color: C.orange, background: C.orangeSoft, padding: "2px 8px", borderRadius: 6 }}>
                                📍 Nouveau produit — pas d'emplacement
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}
    </>
  );
}

// ============================================
// HISTORY SCREEN
// ============================================
// ============================================
// INVENTORY ADJUSTMENT SCREEN
// ============================================
function InventoryScreen({ session, onBack, onToast }: { session: any; onBack: () => void; onToast: (m: string) => void }) {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<any>(null);
  const [selectedLocation, setSelectedLocation] = useState<any>(null);
  const [quants, setQuants] = useState<any[]>([]);
  const [loadingQuants, setLoadingQuants] = useState(false);
  const [adjustments, setAdjustments] = useState<Record<number, string>>({}); // quantId -> new qty string
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const searchProducts = async (forceVal?: string) => {
    const val = (forceVal ?? query).trim();
    if (!val) return;
    setSearching(true);
    try {
      const result = await odoo.smartScan(session, val);
      if (result.type === "product") {
        setSearchResults([{ kind: "product", productName: result.data.name, ref: result.data.default_code, id: result.data.id, barcode: result.data.barcode }]);
      } else if (result.type === "lot") {
        const prod = result.data.product;
        setSearchResults([{ kind: "product", productName: prod?.name || result.data.lot.product_id[1], ref: prod?.default_code, id: prod?.id || result.data.lot.product_id[0], lotName: result.data.lot.name }]);
      } else if (result.type === "location") {
        setSearchResults([{ kind: "location", locationName: result.data.complete_name || result.data.name, id: result.data.id }]);
      } else {
        setSearchResults([]);
        onToast("Aucun résultat trouvé");
      }
    } catch (e: any) { onToast("Erreur: " + e.message); }
    setSearching(false);
  };

  useScannerListener((code) => {
    setQuery(code);
    searchProducts(code);
  }, true);

  const selectItem = async (result: any) => {
    setSearchResults([]);
    setQuery("");
    setAdjustments({});
    setLoadingQuants(true);
    setTimeout(() => searchInputRef.current?.focus(), 300);
    if (result.kind === "location") {
      setSelectedLocation(result);
      setSelectedProduct(null);
      try {
        const data = await odoo.getProductsAtLocation(session, result.id);
        setQuants(data);
        const init: Record<number, string> = {};
        for (const q of data) init[q.id] = String(q.quantity);
        setAdjustments(init);
      } catch (e: any) { onToast("Erreur chargement stock: " + e.message); }
    } else {
      setSelectedProduct(result);
      setSelectedLocation(null);
      try {
        const data = await odoo.getQuantsForProduct(session, result.id);
        setQuants(data);
        const init: Record<number, string> = {};
        for (const q of data) init[q.id] = String(q.quantity);
        setAdjustments(init);
      } catch (e: any) { onToast("Erreur chargement stock: " + e.message); }
    }
    setLoadingQuants(false);
  };

  const hasChanges = quants.some(q => {
    const newQty = parseFloat(adjustments[q.id] ?? String(q.quantity));
    return !isNaN(newQty) && newQty !== q.quantity;
  });

  const changedQuants = quants.filter(q => {
    const newQty = parseFloat(adjustments[q.id] ?? String(q.quantity));
    return !isNaN(newQty) && newQty !== q.quantity;
  });

  const saveAdjustments = async () => {
    setSaving(true);
    setConfirmOpen(false);
    let errors = 0;
    for (const q of changedQuants) {
      const newQty = parseFloat(adjustments[q.id]);
      try {
        await odoo.applyInventoryAdjustment(session, q.id, newQty);
        // Update local state
        setQuants(prev => prev.map(pq => pq.id === q.id ? { ...pq, quantity: newQty } : pq));
        setAdjustments(prev => ({ ...prev, [q.id]: String(newQty) }));
      } catch (e: any) { errors++; onToast("Erreur: " + e.message); }
    }
    setSaving(false);
    if (errors === 0) onToast(`✅ ${changedQuants.length} ajustement(s) appliqué(s)`);
  };

  return (
    <>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <button onClick={onBack} style={{ ...iconBtn, background: C.bg, borderRadius: 8, padding: 8 }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: C.text }}>Ajustement inventaire</h2>
          <p style={{ fontSize: 12, color: C.textMuted }}>Corriger les quantités en stock</p>
        </div>
      </div>

      {/* Search */}
      <Section>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 8 }}>Rechercher un produit</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            ref={searchInputRef}
            autoFocus
            value={query} onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") { const val = (e.target as HTMLInputElement).value.trim(); if (val) searchProducts(val); } }}
            placeholder="Scanner ou taper Réf, lot, code-barres..."
            style={{ flex: 1, padding: "10px 12px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 14, fontFamily: "inherit", outline: "none" }}
          />
          <button onClick={() => searchProducts()} disabled={searching}
            style={{ padding: "10px 16px", background: C.blue, color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
            {searching ? "..." : "OK"}
          </button>
        </div>

        {/* Results dropdown */}
        {searchResults.length > 0 && (
          <div style={{ marginTop: 8 }}>
            {searchResults.map((r, i) => (
              <button key={i} onClick={() => selectItem(r)}
                style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, cursor: "pointer", fontFamily: "inherit", textAlign: "left" as const, marginBottom: 4 }}>
                <div>
                  {r.kind === "location" ? (
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#059669" }}>📍 {r.locationName}</div>
                  ) : (
                    <>
                      <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{r.productName}</div>
                      {r.ref && <div style={{ fontSize: 11, color: C.textMuted }}>Réf: {r.ref}</div>}
                      {r.lotName && <div style={{ fontSize: 11, color: C.blue }}>Lot: {r.lotName}</div>}
                    </>
                  )}
                </div>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={C.textMuted} strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
              </button>
            ))}
          </div>
        )}
      </Section>

      {/* Selected product + quants */}
      {(selectedProduct || selectedLocation) && (
        <>
          <Section>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div>
                {selectedLocation ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={{ fontSize: 15, fontWeight: 800, color: "#059669" }}>📍 {selectedLocation.locationName}</div>
                    <button onClick={() => { const newName = prompt("Renommer l'emplacement:", selectedLocation.locationName); if (newName && newName.trim()) { odoo.renameLocation(session, selectedLocation.id, newName.trim()).then(() => onToast("Emplacement renommé")).catch(() => onToast("Erreur renommage")); } }}
                      style={{ background: "none", border: "none", padding: 0, cursor: "pointer", display: "inline-flex", opacity: 0.5 }}
                      title="Renommer l'emplacement">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>
                  </div>
                ) : (
                  <>
                    <div style={{ fontSize: 15, fontWeight: 800, color: C.text }}>{selectedProduct.productName}</div>
                    {selectedProduct.ref && <div style={{ fontSize: 12, color: C.textMuted }}>Réf: {selectedProduct.ref}</div>}
                    {selectedProduct.lotName && <div style={{ fontSize: 12, color: C.blue, fontWeight: 600 }}>Lot: {selectedProduct.lotName}</div>}
                  </>
                )}
              </div>
              <button onClick={() => { setSelectedProduct(null); setSelectedLocation(null); setQuants([]); setAdjustments({}); }}
                style={{ fontSize: 11, color: C.textMuted, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}>✕ Changer</button>
            </div>

            {loadingQuants ? (
              <div style={{ textAlign: "center", padding: 20, color: C.textMuted, fontSize: 13 }}>Chargement du stock...</div>
            ) : quants.length === 0 ? (
              <div style={{ textAlign: "center", padding: 20, color: C.orange, fontSize: 13 }}>⚠️ Aucun stock trouvé pour ce produit</div>
            ) : (
              <>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 10 }}>
                  Stock par emplacement
                </div>
                {quants.map((q) => {
                  const currentQty = q.quantity;
                  const newQtyStr = adjustments[q.id] ?? String(currentQty);
                  const newQty = parseFloat(newQtyStr);
                  const changed = !isNaN(newQty) && newQty !== currentQty;
                  const diff = isNaN(newQty) ? 0 : newQty - currentQty;

                  return (
                    <div key={q.id} style={{
                      padding: "12px 14px", marginBottom: 8, borderRadius: 10,
                      border: `1.5px solid ${changed ? C.orange : C.border}`,
                      background: changed ? "#fffbeb" : C.white,
                    }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>
                            {selectedLocation ? (q.product_id?.[1] || "Produit") : q.location_id[1]}
                          </div>
                          {selectedLocation && q.product_ref && <div style={{ fontSize: 11, color: C.textMuted }}>Réf: {q.product_ref}</div>}
                          {q.lot_id && <div style={{ fontSize: 11, color: C.blue }}>Lot: {q.lot_id[1]}{q.expiry || q.expiration_date ? ` · Exp: ${new Date(q.expiry || q.expiration_date).toLocaleDateString("fr-FR")}` : ""}</div>}
                          {q.reserved_quantity > 0 && <div style={{ fontSize: 10, color: C.orange }}>Réservé: {q.reserved_quantity}</div>}
                        </div>
                        {changed && (
                          <span style={{ fontSize: 11, fontWeight: 700, color: diff > 0 ? C.green : C.red, background: diff > 0 ? C.greenSoft : "#fef2f2", padding: "2px 8px", borderRadius: 6 }}>
                            {diff > 0 ? "+" : ""}{diff}
                          </span>
                        )}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <div style={{ fontSize: 12, color: C.textMuted, minWidth: 80 }}>
                          Actuel: <strong>{currentQty}</strong>
                        </div>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.textMuted} strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1 }}>
                          <button onClick={() => setAdjustments(prev => ({ ...prev, [q.id]: String(Math.max(0, (parseFloat(prev[q.id] ?? String(currentQty)) || 0) - 1) ) }))}
                            style={{ width: 32, height: 32, borderRadius: 8, border: `1px solid ${C.border}`, background: C.bg, fontSize: 18, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>−</button>
                          <input
                            type="number" min={0} value={newQtyStr}
                            onChange={e => setAdjustments(prev => ({ ...prev, [q.id]: e.target.value }))}
                            onKeyDown={e => e.stopPropagation()}
                            style={{ width: 70, padding: "6px 8px", border: `1.5px solid ${changed ? C.orange : C.border}`, borderRadius: 8, fontSize: 16, fontWeight: 700, textAlign: "center" as const, fontFamily: "inherit", background: changed ? "#fffbeb" : C.white }}
                          />
                          <button onClick={() => setAdjustments(prev => ({ ...prev, [q.id]: String((parseFloat(prev[q.id] ?? String(currentQty)) || 0) + 1) }))}
                            style={{ width: 32, height: 32, borderRadius: 8, border: `1px solid ${C.border}`, background: C.bg, fontSize: 18, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>+</button>
                          {changed && (
                            <button onClick={() => setAdjustments(prev => ({ ...prev, [q.id]: String(currentQty) }))}
                              style={{ fontSize: 11, color: C.textMuted, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", marginLeft: 4 }}>↩ Reset</button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </Section>

          {/* Confirm modal */}
          {confirmOpen && (
            <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
              <div style={{ background: C.white, borderRadius: 16, padding: 24, maxWidth: 360, width: "100%", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
                <div style={{ fontSize: 16, fontWeight: 800, color: C.text, marginBottom: 8 }}>Confirmer l'ajustement</div>
                <div style={{ fontSize: 13, color: C.textSec, marginBottom: 16 }}>
                  {changedQuants.length} emplacement(s) vont être modifiés dans Odoo :
                </div>
                {changedQuants.map(q => {
                  const newQty = parseFloat(adjustments[q.id]);
                  const diff = newQty - q.quantity;
                  return (
                    <div key={q.id} style={{ padding: "6px 0", borderBottom: `1px solid ${C.border}`, fontSize: 12 }}>
                      <span style={{ fontWeight: 700 }}>{q.location_id[1]}</span>
                      {q.lot_id && <span style={{ color: C.blue }}> · Lot {q.lot_id[1]}</span>}
                      <span style={{ color: C.textMuted }}> : {q.quantity} → </span>
                      <span style={{ fontWeight: 700, color: diff > 0 ? C.green : C.red }}>{newQty} ({diff > 0 ? "+" : ""}{diff})</span>
                    </div>
                  );
                })}
                <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
                  <button onClick={() => setConfirmOpen(false)}
                    style={{ flex: 1, padding: 12, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", color: C.textSec }}>
                    Annuler
                  </button>
                  <button onClick={saveAdjustments} disabled={saving}
                    style={{ flex: 2, padding: 12, background: "#8b5cf6", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 800, cursor: "pointer", fontFamily: "inherit", color: "#fff" }}>
                    {saving ? "Application..." : "✅ Confirmer"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Save button */}
          {hasChanges && !confirmOpen && (
            <button onClick={() => setConfirmOpen(true)}
              style={{ width: "100%", padding: 14, background: "#8b5cf6", border: "none", borderRadius: 12, fontSize: 15, fontWeight: 800, cursor: "pointer", fontFamily: "inherit", color: "#fff", marginTop: 8 }}>
              Appliquer {changedQuants.length} ajustement(s) dans Odoo
            </button>
          )}
        </>
      )}
    </>
  );
}

function HistoryScreen({ history, onClear, onBack }: { history: HistoryEntry[]; onClear: () => void; onBack: () => void }) {
  const [confirmClear, setConfirmClear] = useState(false);

  // Group by day
  const grouped: Record<string, HistoryEntry[]> = {};
  for (const h of history) {
    const day = new Date(h.date).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
    if (!grouped[day]) grouped[day] = [];
    grouped[day].push(h);
  }

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button onClick={onBack} style={{ ...iconBtn, background: C.bg, borderRadius: 8, padding: 8 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: C.text }}>Historique</h2>
          <span style={{ fontSize: 11, fontWeight: 600, color: C.textMuted, background: C.bg, padding: "2px 8px", borderRadius: 6 }}>{history.length}</span>
        </div>
        {history.length > 0 && (
          <button onClick={() => confirmClear ? onClear() : setConfirmClear(true)}
            style={{ fontSize: 11, fontWeight: 600, color: confirmClear ? C.red : C.textMuted, background: confirmClear ? `${C.red}12` : "none", border: "none", cursor: "pointer", fontFamily: "inherit", padding: "6px 10px", borderRadius: 6 }}>
            {confirmClear ? "Confirmer la suppression ?" : "Vider"}
          </button>
        )}
      </div>

      {history.length === 0 ? (
        <Section>
          <div style={{ textAlign: "center", padding: 32, color: C.textMuted, fontSize: 13 }}>Aucun transfert enregistré</div>
        </Section>
      ) : (
        Object.entries(grouped).map(([day, entries]) => (
          <div key={day} style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "capitalize", marginBottom: 8, padding: "0 4px" }}>{day}</div>
            <Section>
              {entries.map((h, i) => (
                <div key={i} style={{ padding: "10px 0", borderBottom: i < entries.length - 1 ? `1px solid ${C.border}` : "none" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ width: 32, height: 32, borderRadius: 8, background: C.blueSoft, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.blue} strokeWidth="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                      </div>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{h.from} → {h.to}</div>
                        <div style={{ fontSize: 11, color: C.textMuted, marginTop: 1 }}>{h.lineCount} ligne{h.lineCount > 1 ? "s" : ""} · {h.products.slice(0, 2).join(", ")}{h.products.length > 2 ? ` +${h.products.length - 2}` : ""}</div>
                      </div>
                    </div>
                    <span style={{ fontSize: 10, color: C.textMuted, whiteSpace: "nowrap" }}>
                      {new Date(h.date).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                </div>
              ))}
            </Section>
          </div>
        ))
      )}
    </>
  );
}

// ============================================
// SETTINGS SCREEN
// ============================================
// ============================================
// E-SHOP EXCLUDED SKUS (stored in localStorage)
// ============================================
const ESHOP_CHARIOT_KEY = "wms_eshop_chariot_skus";

// Local cache for chariot SKUs loaded from Odoo
let _chariotSkusCache: string[] | null = null;

function getChariotSkusLocal(): string[] {
  if (_chariotSkusCache !== null) return _chariotSkusCache;
  _chariotSkusCache = [];
  return _chariotSkusCache!;
}

function setChariotSkusLocal(skus: string[]) {
  _chariotSkusCache = skus;

}

function EshopChariotSkus({ session }: { session: any }) {
  const [skus, setSkus] = useState<string[]>([]);
  const [newSku, setNewSku] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // Use ref to always have latest skus for Odoo save even if component unmounts
  const skusRef = useRef<string[]>([]);

  useEffect(() => {
    if (!session) return;
    odoo.loadChariotSkus(session).then(p => { setSkus(p); skusRef.current = p; setChariotSkusLocal(p); }).catch(() => {});
  }, [session]);

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
    if (s && !skusRef.current.includes(s)) { save([...skusRef.current, s]); setNewSku(""); }
  };

  return (
    <Section>
      <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 4 }}>🛒 E-shop — Chariot Eshop</div>
      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 10 }}>
        Ces SKU seront affichés avec l'emplacement <strong>Chariot Eshop</strong> (partagé entre tous les utilisateurs)
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        <input value={newSku} onChange={e => setNewSku(e.target.value)}
          onKeyDown={e => { e.stopPropagation(); if (e.key === "Enter") add(); }}
          placeholder="SKU..."
          style={{ flex: 1, padding: "8px 10px", border: `1.5px solid ${C.border}`, borderRadius: 8, fontSize: 12, fontFamily: "inherit", outline: "none" }} />
        <button onClick={add} style={{ padding: "8px 14px", background: saving ? C.textMuted : C.blue, color: "#fff", border: "none", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>{saving ? "⏳" : saved ? "✓" : "+"}</button>
      </div>
      {skus.length === 0 && <div style={{ fontSize: 11, color: C.textMuted }}>Aucun SKU configuré</div>}
      {skus.map(sku => (
        <div key={sku} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: `1px solid ${C.border}` }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: C.text, fontFamily: "monospace" }}>{sku}</span>
          <button onClick={() => save(skusRef.current.filter(s => s !== sku))} style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 12, fontWeight: 700 }}>✕</button>
        </div>
      ))}
    </Section>
  );
}

function SettingsScreen({ onBack, session }: { onBack: () => void; session: any }) {
  const [printers, setPrinters] = useState<pn.PrintNodePrinter[]>([]);
  const [loadingP, setLoadingP] = useState(false);
  const [msg, setMsg] = useState("");
  const [hasKey, setHasKey] = useState(true);

  // Per-type config state
  type LabelType = pn.LabelType;
  const LABEL_TYPES: { key: LabelType; label: string; icon: string; hasSize: boolean }[] = [
    { key: "product", label: "Étiquette produit", icon: "📦", hasSize: true },
    { key: "lot", label: "Étiquette lot", icon: "🏷️", hasSize: true },
    { key: "location", label: "Étiquette emplacement", icon: "📍", hasSize: true },
    { key: "palette", label: "Étiquette palette", icon: "🏭", hasSize: true },
    { key: "blank", label: "Étiquette vierge", icon: "✏️", hasSize: true },
    { key: "picking", label: "Étiquette colis (picking)", icon: "📦", hasSize: true },
    // HIDDEN: E-shop — pas au point
    // { key: "sendcloud", label: "Étiquette SendCloud", icon: "🚚", hasSize: false },
    // { key: "packingslip", label: "Bon de livraison (BL)", icon: "📄", hasSize: false },
  ];

  const [configs, setConfigs] = useState<Record<LabelType, pn.LabelTypeConfig>>(() => pn.getAllLabelTypeConfigs());
  const [openType, setOpenType] = useState<LabelType | null>(null);

  const SIZES = [
    { label: "50×30", w: 50, h: 30 }, { label: "70×45", w: 70, h: 45 },
    { label: "100×70", w: 100, h: 70 }, { label: "100×150", w: 100, h: 150 },
  ];

  const fetchPrinters = async () => {
    setLoadingP(true); setMsg("");
    try {
      const list = await pn.listPrinters();
      setPrinters(list); setHasKey(true);
      if (!list.length) setMsg("Aucune imprimante trouvée");
    } catch (e: any) {
      if (e.message?.includes("non configurée") || e.message?.includes("500")) setHasKey(false);
      setMsg("Erreur: " + e.message);
    }
    setLoadingP(false);
  };

  const updateTypeConfig = (type: LabelType, patch: Partial<pn.LabelTypeConfig>) => {
    const updated = { ...configs[type], ...patch };
    pn.saveLabelTypeConfig(type, patch);
    setConfigs(prev => ({ ...prev, [type]: updated }));
    setMsg("✓ Sauvegardé");
    setTimeout(() => setMsg(""), 2000);
  };

  const testPrint = async (type: LabelType) => {
    const cfg = configs[type];
    if (!cfg.printerId) { setMsg("⚠️ Configure une imprimante pour ce type"); return; }
    setMsg("Envoi test...");
    let r: any;
    if (type === "product") r = await pn.printProductLabel(cfg.printerId, "TEST PRODUIT", "3401234567890");
    else if (type === "lot") r = await pn.printLotLabel(cfg.printerId, "LOT-001", "Produit Test", "LOT-001");
    else if (type === "location") r = await pn.printLocationLabel(cfg.printerId, "A42-RKD1", "B-A42");
    else if (type === "palette") r = await pn.printPaletteLabel(cfg.printerId, { senderName: "TEST", recipientName: "DEST", productName: "Produit Test", ref: "REF001", lotNumber: "LOT001", quantity: 10, unit: "cartons", expiryDate: "", weight: "50 kg", sscc: "000123456789012340", orderRef: "CMD-TEST", deliveryRef: "BL-TEST" });
    else if (type === "picking") r = await pn.printBlankLabel(cfg.printerId, { lines: [{ text: "WH/PICK/TEST", fontSize: 24, align: "C" as "C" }], barcode: "WH/PICK/TEST" });
    else r = await pn.printBlankLabel(cfg.printerId, { lines: [{ text: "TEST VIERGE", fontSize: 30, align: "C" }] });
    setMsg(r?.success ? "✓ Test envoyé" : "✕ " + r?.error);
  };

  const printerName = (id: number | null) => {
    if (!id) return "Non configurée";
    const p = printers.find(p => p.id === id);
    return p ? p.name : `#${id}`;
  };

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
        <button onClick={onBack} style={{ ...iconBtn, background: C.bg, borderRadius: 8, padding: 8 }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: C.text }}>Paramètres</h2>
      </div>

      {/* Load printers */}
      {hasKey && (
        <Section>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 10 }}>🖨 Imprimantes disponibles</div>
          <button onClick={fetchPrinters} disabled={loadingP}
            style={{ width: "100%", padding: 10, background: C.bg, color: C.textSec, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
            {loadingP ? "Chargement..." : printers.length > 0 ? `${printers.length} imprimante(s) trouvée(s) — Actualiser` : "Rechercher les imprimantes"}
          </button>
          {printers.length > 0 && (
            <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap" as const, gap: 4 }}>
              {printers.map(p => (
                <div key={p.id} style={{ fontSize: 11, padding: "3px 8px", borderRadius: 12, background: p.state === "online" ? C.greenSoft : C.orangeSoft, color: p.state === "online" ? C.green : C.orange, fontWeight: 600 }}>
                  {p.name} #{p.id}
                </div>
              ))}
            </div>
          )}
        </Section>
      )}

      {!hasKey && (
        <Section>
          <Alert type="info">Ajoute PRINTNODE_API_KEY dans les variables Vercel pour activer PrintNode.</Alert>
        </Section>
      )}

      {/* Per-type configs */}
      <Section>
        <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 12 }}>⚙️ Configuration par type d'étiquette</div>
        {LABEL_TYPES.map(({ key, label, icon }) => {
          const cfg = configs[key];
          const isOpen = openType === key;
          return (
            <div key={key} style={{ marginBottom: 8, border: `1.5px solid ${isOpen ? C.blue : C.border}`, borderRadius: 10, overflow: "hidden" }}>
              {/* Header row */}
              <button onClick={() => setOpenType(isOpen ? null : key)}
                style={{ width: "100%", padding: "11px 14px", background: isOpen ? C.blueSoft : C.white, border: "none", cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 16 }}>{icon}</span>
                  <div style={{ textAlign: "left" as const }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{label}</div>
                    <div style={{ fontSize: 10, color: C.textMuted }}>
                      {printerName(cfg.printerId)} · {cfg.labelSize.widthMM}×{cfg.labelSize.heightMM}mm
                    </div>
                  </div>
                </div>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.textMuted} strokeWidth="2">
                  {isOpen ? <polyline points="18 15 12 9 6 15"/> : <polyline points="6 9 12 15 18 9"/>}
                </svg>
              </button>

              {/* Expanded config */}
              {isOpen && (
                <div style={{ padding: "12px 14px", background: C.white, borderTop: `1px solid ${C.border}` }}>
                  {/* Printer selector */}
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 5 }}>Imprimante</div>
                    {printers.length > 0 ? (
                      <select value={cfg.printerId ?? ""} onChange={e => updateTypeConfig(key, { printerId: Number(e.target.value) || null })}
                        style={{ width: "100%", padding: "8px 10px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", background: C.white }}>
                        <option value="">-- Aucune --</option>
                        {printers.map(p => <option key={p.id} value={p.id}>{p.name} (#{p.id})</option>)}
                      </select>
                    ) : (
                      <div style={{ display: "flex", gap: 6 }}>
                        <input type="number" value={cfg.printerId ?? ""} placeholder="ID imprimante"
                          onChange={e => updateTypeConfig(key, { printerId: Number(e.target.value) || null })}
                          onKeyDown={e => e.stopPropagation()}
                          style={{ flex: 1, padding: "8px 10px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }} />
                        <div style={{ fontSize: 10, color: C.textMuted, alignSelf: "center" }}>Recherche les imprimantes d'abord</div>
                      </div>
                    )}
                  </div>

                  {/* Size */}
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 5 }}>Format étiquette</div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" as const, marginBottom: 6 }}>
                      {SIZES.map(s => (
                        <button key={s.label} onClick={() => updateTypeConfig(key, { labelSize: { widthMM: s.w, heightMM: s.h } })}
                          style={{ padding: "5px 10px", borderRadius: 6, border: `1.5px solid ${cfg.labelSize.widthMM === s.w && cfg.labelSize.heightMM === s.h ? C.blue : C.border}`,
                            background: cfg.labelSize.widthMM === s.w && cfg.labelSize.heightMM === s.h ? C.blueSoft : C.white,
                            color: cfg.labelSize.widthMM === s.w && cfg.labelSize.heightMM === s.h ? C.blue : C.text,
                            fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                          {s.label}
                        </button>
                      ))}
                    </div>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <input type="number" value={cfg.labelSize.widthMM}
                        onChange={e => updateTypeConfig(key, { labelSize: { ...cfg.labelSize, widthMM: Number(e.target.value) } })}
                        onKeyDown={e => e.stopPropagation()}
                        style={{ width: 60, padding: "6px 8px", border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12, textAlign: "center" as const, fontFamily: "inherit" }} />
                      <span style={{ color: C.textMuted, fontSize: 12 }}>×</span>
                      <input type="number" value={cfg.labelSize.heightMM}
                        onChange={e => updateTypeConfig(key, { labelSize: { ...cfg.labelSize, heightMM: Number(e.target.value) } })}
                        onKeyDown={e => e.stopPropagation()}
                        style={{ width: 60, padding: "6px 8px", border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12, textAlign: "center" as const, fontFamily: "inherit" }} />
                      <span style={{ color: C.textMuted, fontSize: 11 }}>mm</span>
                    </div>
                  </div>

                  {/* Test button */}
                  {hasKey && cfg.printerId && (
                    <button onClick={() => testPrint(key)}
                      style={{ padding: "7px 14px", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", color: C.textSec }}>
                      🖨 Imprimer test
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </Section>

      {msg && (
        <div style={{ textAlign: "center", fontSize: 13, fontWeight: 600, padding: 12,
          color: msg.startsWith("✓") ? C.green : msg.startsWith("✕") || msg.startsWith("⚠") ? C.red : C.textSec,
        }}>{msg}</div>
      )}

      {/* HIDDEN: E-shop chariot — pas au point
      <EshopChariotSkus session={session} />
      */}
    </>
  );
}
// ============================================
// PREPARATION LIST SCREEN
// ============================================
function PrepListScreen({ pickings, loading, error, onOpen, onScanPicking, onCheckAvail, onRefresh, onReport }: any) {
  const [scanCode, setScanCode] = useState("");
  // Group by shipping_date (date d'expédition prévue), fallback date_deadline, then scheduled_date
  const grouped: Record<string, any[]> = {};
  for (const p of pickings) {
    const rawDate = p.shipping_date || p.date_deadline || p.scheduled_date;
    const d = rawDate ? new Date(rawDate).toLocaleDateString("fr-FR", { weekday: "long", day: "2-digit", month: "long", year: "numeric" }) : "Sans date";
    if (!grouped[d]) grouped[d] = [];
    grouped[d].push(p);
  }
  const days = Object.keys(grouped);
  const [openDays, setOpenDays] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    if (days.length > 0) init[days[0]] = true; // first day open by default
    return init;
  });
  const toggle = (d: string) => setOpenDays(prev => ({ ...prev, [d]: !prev[d] }));

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: C.text }}>Préparation</h2>
          <p style={{ fontSize: 12, color: C.textMuted }}>{pickings.length} commande(s) prête(s)</p>
        </div>
        <button onClick={onRefresh} disabled={loading} style={{ ...iconBtn, background: C.blueSoft, borderRadius: 10, padding: "8px 12px" }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={C.blue} strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
        </button>
      </div>

      {/* Scan direct par nom WH/PICK/xxxxx */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          style={{ ...inputStyle, flex: 1, borderColor: "#7c3aed" }}
          value={scanCode}
          onChange={e => setScanCode(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && scanCode.trim()) { onScanPicking(scanCode.trim()); setScanCode(""); }
          }}
          placeholder="📷 Scanner WH/PICK/... pour ouvrir directement"
        />
        <button
          onClick={() => { if (scanCode.trim()) { onScanPicking(scanCode.trim()); setScanCode(""); } }}
          style={{ padding: "10px 16px", background: "#7c3aed", color: "#fff", border: "none", borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: "pointer", whiteSpace: "nowrap" as const }}>
          Ouvrir
        </button>
      </div>

      {error && <Alert type="error">{error}</Alert>}
      {loading && pickings.length === 0 && <div style={{ textAlign: "center", padding: 40, color: C.textMuted }}>Chargement...</div>}
      {!loading && pickings.length === 0 && <Alert type="info">Aucune commande prête à préparer</Alert>}

      {days.map(date => {
        const items = grouped[date];
        const isOpen = !!openDays[date];
        return (
          <div key={date} style={{ marginBottom: 12 }}>
            <button onClick={() => toggle(date)} style={{
              width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "10px 14px", background: C.white, border: `1px solid ${C.border}`, borderRadius: 10,
              cursor: "pointer", fontFamily: "inherit", boxShadow: C.shadow,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 14 }}>📅</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{date}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: C.blue, background: C.blueSoft, padding: "2px 8px", borderRadius: 10 }}>{items.length}</span>
                <span style={{ fontSize: 12, color: C.textMuted, transition: "transform .2s", transform: isOpen ? "rotate(180deg)" : "rotate(0)" }}>▼</span>
              </div>
            </button>

            {isOpen && (
              <div style={{ marginTop: 8, paddingLeft: 4 }}>
                {items.map((p: any) => {
                  const moveCount = (p.move_ids_without_package || []).length;
                  return (
                    <div key={p.id} style={{ ...cardStyle, marginBottom: 8 }}>
                      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 8 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{p.name}</div>
                          {p.partner_id && <div style={{ fontSize: 12, color: C.textSec }}>{p.partner_id[1]}</div>}
                          {p.origin && <div style={{ fontSize: 11, color: C.textMuted }}>Origine: {p.origin}</div>}
                          {p.carrier_id && (
                            <div style={{ fontSize: 11, fontWeight: 700, color: "#7c3aed", background: "#f5f3ff", display: "inline-block", padding: "2px 8px", borderRadius: 6, marginTop: 4 }}>
                              🚚 {p.carrier_id[1]}
                            </div>
                          )}
                        </div>
                        <span style={{ fontSize: 11, fontWeight: 700, color: C.green, background: C.greenSoft, padding: "3px 8px", borderRadius: 6, flexShrink: 0 }}>Prêt</span>
                      </div>
                      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 10 }}>{moveCount} article(s)</div>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button onClick={() => onOpen(p)} style={{ flex: 2, padding: "10px 0", background: C.blue, color: "#fff", border: "none", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                          Préparer
                        </button>
                        <button onClick={() => requestPrint({ type: "picking", title: p.name, barcode: p.name })}
                          style={{ padding: "10px 12px", background: C.bg, color: C.textSec, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}
                          title="Imprimer code-barres colis">
                          {printerSmallIcon}
                        </button>
                        <button onClick={() => onReport(p.id)} style={{ padding: "10px 12px", background: C.bg, color: C.textSec, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                          📄
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

// ============================================
// PREPARATION DETAIL SCREEN
// ============================================
function PrepDetailScreen({ picking, moves, moveLines, scanned, loading, error, prepStep, onScan, onTakeAll, onCancelStep, onAutoFill, onAdjustQty, qtyOverrides, onValidate, onBack, onReport }: any) {
  // ── qty helper: overrides take priority over moveLines data ──
  const getQty = (ml: any) => qtyOverrides?.[ml.id] !== undefined ? qtyOverrides[ml.id] : (ml.qty_done || 0);

  // ── Colis state (local) ──
  const [colis, setColis] = useState<{ id: number; lines: number[] }[]>([]);
  const [currentColisId, setCurrentColisId] = useState<number | null>(null);
  const [colisLines, setColisLines] = useState<Set<number>>(new Set());
  const [showColisSummary, setShowColisSummary] = useState(false);
  const [locOk, setLocOk] = useState(false);

  // ── Compute sorted move lines one per card ──
  const allLines = useMemo(() => {
    return [...moveLines].sort((a: any, b: any) => {
      const la = (a.location_id?.[1] || "").toLowerCase();
      const lb = (b.location_id?.[1] || "").toLowerCase();
      return la < lb ? -1 : la > lb ? 1 : 0;
    });
  }, [moveLines]);

  const currentLine = useMemo(() => {
    return allLines.find((ml: any) => getQty(ml) < (ml.reserved_uom_qty || 0));
  }, [allLines]);

  const doneLines = allLines.filter((ml: any) => getQty(ml) >= (ml.reserved_uom_qty || 0)).length;
  const totalLines = allLines.length;
  const allDone = totalLines > 0 && doneLines === totalLines;
  const progress = totalLines > 0 ? Math.round((doneLines / totalLines) * 100) : 0;

  // When a new line becomes current, reset locOk
  const currentLineId = currentLine?.id;
  useEffect(() => { setLocOk(false); }, [currentLineId]);

  // Track when loc scan succeeds via prepStep changes
  useEffect(() => {
    if (prepStep) setLocOk(true);
  }, [prepStep?.locId]);

  // ── Colis helpers ──
  const openNewColis = () => {
    const newId = colis.length + 1;
    setColis(prev => [...prev, { id: newId, lines: [] }]);
    setCurrentColisId(newId);
  };
  const closeColis = () => {
    if (currentColisId === null) return;
    setCurrentColisId(null);
  };
  const addLineToColis = (lineId: number) => {
    if (currentColisId === null) return;
    setColisLines(prev => { const s = new Set(Array.from(prev)); s.add(lineId); return s; });
    setColis(prev => prev.map(c => c.id === currentColisId ? { ...c, lines: [...c.lines, lineId] } : c));
  };

  // ── Emplacement display helper ──
  const shortLoc = (fullName: string) => (fullName || "").split("/").pop() || fullName;

  if (showColisSummary) return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
        <button onClick={() => setShowColisSummary(false)} style={{ ...iconBtn, background: C.bg, borderRadius: 8, padding: 8 }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>Récapitulatif colis</div>
      </div>
      {colis.length === 0 && <div style={{ color: C.textMuted, fontSize: 14, textAlign: "center", padding: 20 }}>Aucun colis créé</div>}
      {colis.map(c => (
        <div key={c.id} style={{ background: C.bg, border: `1.5px solid ${C.border}`, borderRadius: 14, padding: 14, marginBottom: 10 }}>
          <div style={{ fontWeight: 700, color: C.text, marginBottom: 8 }}>📦 Colis {c.id}</div>
          {c.lines.length === 0
            ? <div style={{ fontSize: 12, color: C.textMuted }}>Vide</div>
            : c.lines.map(lid => {
                const ml = allLines.find((l: any) => l.id === lid);
                if (!ml) return null;
                return <div key={lid} style={{ fontSize: 12, color: C.text, paddingBottom: 4, borderBottom: `1px solid ${C.border}`, marginBottom: 4 }}>
                  {ml.product_id[1]}{ml.lot_id ? ` · Lot ${ml.lot_id[1]}` : ""} · {ml.qty_done || 0} u
                </div>;
              })
          }
        </div>
      ))}
      <BigButton
        icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>}
        label={loading ? "Envoi..." : "Valider la préparation"}
        sub={`${doneLines}/${totalLines} articles préparés`}
        color={allDone ? C.green : C.orange}
        onClick={onValidate}
        disabled={loading || doneLines === 0}
      />
    </>
  );

  return (
    <>
      {/* ── Header ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <button onClick={onBack} style={{ ...iconBtn, background: C.bg, borderRadius: 8, padding: 8 }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{picking.name}</div>
          {picking.partner_id && <div style={{ fontSize: 12, color: C.textSec }}>{picking.partner_id[1]}</div>}
        </div>
        <button onClick={() => onReport(picking.id)} style={{ ...iconBtn, background: C.bg, borderRadius: 8, padding: 8 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={C.textSec} strokeWidth="2"><path d="M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
        </button>
      </div>

      {/* ── Progress bar ── */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>Progression</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: allDone ? C.green : C.blue }}>{doneLines}/{totalLines}</span>
        </div>
        <div style={{ height: 8, borderRadius: 4, background: C.bg, overflow: "hidden", border: `1px solid ${C.border}` }}>
          <div style={{ height: "100%", width: `${progress}%`, borderRadius: 4, background: allDone ? C.green : C.blue, transition: "width .3s" }} />
        </div>
      </div>

      {/* ── Colis indicator ── */}
      {currentColisId !== null && (
        <div style={{ background: "#fff7ed", border: "1.5px solid #fed7aa", borderRadius: 12, padding: "10px 14px", marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#c2410c" }}>
            📦 Colis {currentColisId} en cours — {colis.find(c => c.id === currentColisId)?.lines.length || 0} article(s)
          </div>
          <button onClick={closeColis} style={{ fontSize: 11, fontWeight: 700, color: "#c2410c", background: "#fed7aa", border: "none", borderRadius: 8, padding: "4px 10px", cursor: "pointer", fontFamily: "inherit" }}>
            Fermer colis
          </button>
        </div>
      )}

      {/* ── Carte article courant ── */}
      {allDone ? (
        <div style={{ background: C.greenSoft, border: `2px solid ${C.green}`, borderRadius: 20, padding: 32, textAlign: "center", marginBottom: 16 }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>✅</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: C.green }}>Tout préparé !</div>
          <div style={{ fontSize: 13, color: C.textSec, marginTop: 4 }}>{totalLines} articles scannés</div>
        </div>
      ) : currentLine ? (
        <div style={{
          background: locOk && prepStep ? "#f0fdf4" : "#f8fafc",
          border: `2px solid ${locOk && prepStep ? C.green : C.blue}`,
          borderRadius: 20, padding: 20, marginBottom: 16,
          transition: "background .3s, border-color .3s"
        }}>
          {/* Étape */}
          <div style={{ fontSize: 11, fontWeight: 700, color: locOk && prepStep ? C.green : C.blue, letterSpacing: 0.5, marginBottom: 12, display: "flex", alignItems: "center", gap: 6 }}>
            {!locOk
              ? <><span style={{ background: C.blue, color: "#fff", borderRadius: "50%", width: 20, height: 20, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11 }}>1</span> SCANNER L'EMPLACEMENT</>
              : <><span style={{ background: C.green, color: "#fff", borderRadius: "50%", width: 20, height: 20, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11 }}>✓</span> EMPLACEMENT OK — SCANNER LE LOT</>
            }
          </div>

          {/* Emplacement */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
            <div style={{ background: locOk ? C.greenSoft : C.blueSoft, border: `1px solid ${locOk ? C.greenBorder : C.blueBorder}`, borderRadius: 10, padding: "6px 12px", fontSize: 18, fontWeight: 900, color: locOk ? C.green : C.blue, letterSpacing: 0.5, flex: 1, textAlign: "center" }}>
              📍 {shortLoc(currentLine.location_id?.[1] || "—")}
            </div>
            {locOk && <div style={{ width: 32, height: 32, borderRadius: "50%", background: C.green, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
            </div>}
          </div>

          {/* Produit */}
          <div style={{ fontSize: 15, fontWeight: 800, color: "#1e293b", marginBottom: 6, lineHeight: 1.3 }}>
            {currentLine.product_id[1]}
          </div>

          {/* Lot */}
          {currentLine.lot_id && (
            <div style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "#f1f5f9", border: "1px solid #e2e8f0", borderRadius: 8, padding: "4px 10px", fontSize: 12, fontWeight: 700, color: "#475569", marginBottom: 10 }}>
              🏷️ Lot {currentLine.lot_id[1]}
            </div>
          )}

          {/* Quantité + contrôles */}
          <div style={{ marginTop: 12 }}>
            {/* Compteur +/- */}
            <div style={{ display: "flex", alignItems: "stretch", gap: 0, border: `1.5px solid ${C.border}`, borderRadius: 14, overflow: "hidden", background: C.white, marginBottom: 10 }}>
              <button
                onClick={() => onAdjustQty(currentLine.id, getQty(currentLine) - 1)}
                disabled={loading || (currentLine.qty_done || 0) <= 0}
                style={{ width: 64, flexShrink: 0, background: C.bg, border: "none", fontSize: 24, fontWeight: 700, color: C.text, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", touchAction: "manipulation", borderRight: `1px solid ${C.border}`, opacity: getQty(currentLine) <= 0 ? 0.3 : 1 }}>
                −
              </button>
              <div style={{ flex: 1, textAlign: "center", padding: "12px 4px", minWidth: 0 }}>
                <span style={{ fontSize: 36, fontWeight: 900, color: C.text }}>{getQty(currentLine)}</span>
                <span style={{ fontSize: 18, color: C.textMuted, margin: "0 4px" }}>/</span>
                <span style={{ fontSize: 20, fontWeight: 700, color: C.textSec }}>{currentLine.reserved_uom_qty || 0}</span>
                <span style={{ fontSize: 12, color: C.textMuted, marginLeft: 4 }}>{currentLine.product_uom_id?.[1] || ""}</span>
              </div>
              <button
                onClick={() => onAdjustQty(currentLine.id, getQty(currentLine) + 1)}
                disabled={loading || (currentLine.qty_done || 0) >= (currentLine.reserved_uom_qty || 0)}
                style={{ width: 64, flexShrink: 0, background: C.blue, border: "none", fontSize: 24, fontWeight: 700, color: "#fff", cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", touchAction: "manipulation", borderLeft: `1px solid ${C.blue}`, opacity: getQty(currentLine) >= (currentLine.reserved_uom_qty || 0) ? 0.3 : 1 }}>
                +
              </button>
            </div>
            {/* Bouton "Tout mettre" — visible dès qu'on a scanné au moins 1 */}
            {locOk && getQty(currentLine) > 0 && getQty(currentLine) < (currentLine.reserved_uom_qty || 0) && (
              <button
                onClick={() => onAdjustQty(currentLine.id, currentLine.reserved_uom_qty || 0)}
                disabled={loading}
                style={{ width: "100%", padding: "11px 0", borderRadius: 12, border: "none", background: C.green, color: "#fff", fontSize: 13, fontWeight: 800, cursor: "pointer", fontFamily: "inherit", boxShadow: "0 2px 8px rgba(34,197,94,0.35)", letterSpacing: 0.3 }}>
                ✓ Tout mettre — {currentLine.reserved_uom_qty || 0} {currentLine.product_uom_id?.[1] || ""}
              </button>
            )}
          </div>
        </div>
      ) : null}

      {/* ── Input scan ── */}
      {!allDone && (
        <div style={{ marginBottom: 12 }}>
          <InputBar
            onSubmit={(code: string) => {
              onScan(code);
              if (currentLine && locOk) {
                // Line will be done after scan — add to current colis
                const newQty = (currentLine.qty_done || 0) + 1;
                if (newQty >= (currentLine.reserved_uom_qty || 0)) {
                  addLineToColis(currentLine.id);
                }
              }
            }}
            placeholder={!locOk ? "Scanner l'emplacement..." : "Scanner le lot / produit..."}
          />
          {error && <Alert type="error">{error}</Alert>}
        </div>
      )}

      {/* ── Actions colis + validation ── */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        {currentColisId === null ? (
          <button onClick={openNewColis} style={{ flex: 1, padding: 12, background: "#fff7ed", color: "#c2410c", border: "1.5px solid #fed7aa", borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
            📦 Nouveau colis
          </button>
        ) : (
          <button onClick={closeColis} style={{ flex: 1, padding: 12, background: "#fff7ed", color: "#c2410c", border: "1.5px solid #fed7aa", borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
            ✓ Fermer colis {currentColisId}
          </button>
        )}
        <button onClick={() => setShowColisSummary(true)} style={{ padding: "12px 14px", background: C.bg, color: C.textSec, border: `1px solid ${C.border}`, borderRadius: 10, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
          {colis.length > 0 ? `📦 ${colis.length} colis` : "Colis"}
        </button>
      </div>

      {/* ── Articles déjà préparés — cliquables pour corriger ── */}
      {doneLines > 0 && (
        <details style={{ marginBottom: 16 }}>
          <summary style={{ fontSize: 12, fontWeight: 700, color: C.green, cursor: "pointer", letterSpacing: 0.5, textTransform: "uppercase", padding: "8px 0", userSelect: "none" }}>
            ✓ Préparés ({doneLines}) — appuyer pour modifier
          </summary>
          <div style={{ marginTop: 8 }}>
            {allLines.filter((ml: any) => getQty(ml) >= (ml.reserved_uom_qty || 0)).map((ml: any) => (
              <div key={ml.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", marginBottom: 6, background: C.greenSoft, border: `1px solid ${C.greenBorder}`, borderRadius: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ml.product_id[1]}</div>
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
                    {shortLoc(ml.location_id?.[1] || "")}
                    {ml.lot_id && ` · ${ml.lot_id[1]}`}
                    <span style={{ color: C.green, fontWeight: 700, marginLeft: 6 }}>{getQty(ml)}/{ml.reserved_uom_qty || 0}</span>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                  <button onClick={() => onAdjustQty(ml.id, getQty(ml) - 1)} style={{ width: 36, height: 36, borderRadius: 8, border: `1px solid ${C.border}`, background: C.white, fontSize: 18, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: C.red }}>−</button>
                  <button onClick={() => onAdjustQty(ml.id, getQty(ml) + 1)} disabled={getQty(ml) >= (ml.reserved_uom_qty || 0)} style={{ width: 36, height: 36, borderRadius: 8, border: `1px solid ${C.border}`, background: C.white, fontSize: 18, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: C.blue, opacity: getQty(ml) >= (ml.reserved_uom_qty || 0) ? 0.3 : 1 }}>+</button>
                </div>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* ── Liste rapide des articles restants ── */}
      {!allDone && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>
            Restant ({totalLines - doneLines})
          </div>
          {allLines.filter((ml: any) => getQty(ml) < (ml.reserved_uom_qty || 0)).slice(0, 8).map((ml: any, i: number) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: `1px solid ${C.border}`, opacity: ml.id === currentLine?.id ? 1 : 0.5 }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: ml.id === currentLine?.id ? C.blue : C.border, flexShrink: 0 }} />
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: ml.id === currentLine?.id ? C.blue : C.border, flexShrink: 0 }} />
              <div style={{ flex: 1, fontSize: 12, color: C.text, fontWeight: ml.id === currentLine?.id ? 700 : 400 }}>{ml.product_id[1]}</div>
              <div style={{ fontSize: 11, color: C.textMuted }}>{shortLoc(ml.location_id?.[1] || "")}</div>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.textSec }}>{getQty(ml)}/{ml.reserved_uom_qty || 0}</div>
            </div>
          ))}
        </div>
      )}

      <BigButton
        icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>}
        label={loading ? "Envoi..." : "Valider la préparation"}
        sub={allDone ? "Tout préparé — prêt à valider" : `${doneLines}/${totalLines} articles préparés`}
        color={allDone ? C.green : C.orange}
        onClick={onValidate}
        disabled={loading || doneLines === 0}
      />
    </>
  );
}



// ══════════════════════════════════════════
// PALETTES WMS
// ══════════════════════════════════════════
// ══════════════════════════════════════════════════════
// MAIN SCREEN
// ══════════════════════════════════════════════════════
interface WmsPalette {
  id: number; numero: string; numero_seq: number;
  emplacement: string | null; statut: "actif" | "archive" | "expedie";
  notes: string | null; created_at: string; updated_at: string;
}
interface WmsPaletteLigne {
  id: number; palette_id: number; odoo_ref: string; product_name: string;
  lot: string | null; expiry_date: string | null; qty: number; unite: string; created_at: string;
}

function PalettesScreen({ onBack, session, printerId }: {
  onBack: () => void;
  session?: any;
  printerId?: number;
}) {
  const [view, setView] = useState<"list" | "detail" | "search">("list");
  const [palettes, setPalettes] = useState<WmsPalette[]>([]);
  const [selected, setSelected] = useState<WmsPalette | null>(null);
  const [lignes, setLignes] = useState<WmsPaletteLigne[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [searchRef, setSearchRef] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [statut, setStatut] = useState("actif");
  const [scanInput, setScanInput] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPalettes(await supaPalettes.loadPalettes(statut));
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  }, [statut]);

  useEffect(() => { load(); }, [load]);

  const openPalette = async (p: supaPalettes.WmsPalette) => {
    setLoading(true);
    try {
      const { palette, lignes } = await supaPalettes.loadPaletteDetail(p.id);
      setSelected(palette);
      setLignes(lignes);
      setView("detail");
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const createPalette = async () => {
    setLoading(true);
    try {
      const p = await supaPalettes.createPalette();
      await openPalette(p);
      load();
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  // Scan palette numéro depuis la liste
  const handleScan = async (code: string) => {
    if (/^Pal-\d+$/i.test(code)) {
      const p = await supaPalettes.findPaletteByNumero(code);
      if (p) { openPalette(p); setScanInput(""); return; }
    }
    setError(`"${code}" non reconnu`);
    setScanInput("");
  };

  const searchProduct = async () => {
    if (!searchRef.trim()) return;
    setLoading(true);
    try {
      const r = await supaPalettes.searchProductInPalettes(searchRef.trim());
      setSearchResults(r);
      setView("search");
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  // ── DETAIL VIEW ──
  if (view === "detail" && selected) {
    return <PaletteDetail
      palette={selected}
      lignes={lignes}
      session={session}
      printerId={printerId}
      onBack={() => { setView("list"); load(); }}
      onRefresh={async () => {
        const { palette, lignes } = await supaPalettes.loadPaletteDetail(selected.id);
        setSelected(palette); setLignes(lignes);
      }}
    />;
  }

  // ── SEARCH VIEW ──
  if (view === "search") {
    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
          <button onClick={() => setView("list")} style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Résultats pour "{searchRef}"</div>
        </div>
        {searchResults.length === 0
          ? <div style={{ textAlign: "center", padding: 40, color: C.textMuted }}>Aucune palette trouvée</div>
          : searchResults.map((r, i) => (
            <div key={i} style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14, marginBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontWeight: 700, color: C.purple, fontSize: 15 }}>{r.palette_numero}</div>
                <div style={{ fontSize: 12, color: C.textMuted }}>{r.palette_emplacement || "—"}</div>
              </div>
              <div style={{ fontSize: 13, color: C.text, marginTop: 4 }}>{r.product_name}</div>
              <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>
                {r.lot ? `Lot: ${r.lot}` : "Sans lot"} · <strong style={{ color: C.green }}>{r.qty} {r.unite}</strong>
              </div>
            </div>
          ))
        }
      </div>
    );
  }

  // ── LIST VIEW ──
  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <button onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: C.text }}>Palettes WMS</div>
          <div style={{ fontSize: 12, color: C.textMuted }}>{palettes.length} palette{palettes.length > 1 ? "s" : ""}</div>
        </div>
        <button onClick={createPalette} disabled={loading} style={{ background: C.purple, color: "#fff", border: "none", borderRadius: 10, padding: "10px 16px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
          + Nouvelle
        </button>
      </div>

      {error && <div style={{ background: C.redSoft, border: `1px solid ${C.redBorder}`, borderRadius: 10, padding: "10px 14px", color: C.red, fontSize: 13, marginBottom: 12 }} onClick={() => setError("")}>{error} ✕</div>}

      {/* Scan palette */}
      <input style={{ ...inputStyle, borderColor: C.purple, marginBottom: 10 }}
        value={scanInput}
        onChange={e => setScanInput(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter" && scanInput.trim()) handleScan(scanInput.trim()); }}
        placeholder="📷 Scanner Pal-XXXX pour ouvrir..."
      />

      {/* Recherche produit */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input style={{ ...inputStyle, flex: 1 }} value={searchRef} onChange={e => setSearchRef(e.target.value)}
          onKeyDown={e => e.key === "Enter" && searchProduct()}
          placeholder="Rechercher une réf dans les palettes..." />
        <button onClick={searchProduct} disabled={loading || !searchRef.trim()} style={{ background: C.blue, color: "#fff", border: "none", borderRadius: 10, padding: "10px 14px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>🔍</button>
      </div>

      {/* Filtre statut */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        {["actif", "archive", "expedie"].map(s => (
          <button key={s} onClick={() => setStatut(s)} style={{ flex: 1, padding: "8px 0", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", border: "none", background: statut === s ? C.purple : C.bg, color: statut === s ? "#fff" : C.textSec }}>
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {loading && <div style={{ textAlign: "center", padding: 40, color: C.textMuted }}>Chargement...</div>}

      {/* Liste */}
      {palettes.map(p => {
        const age = Math.floor((Date.now() - new Date(p.updated_at).getTime()) / 86400000);
        return (
          <div key={p.id} onClick={() => openPalette(p)}
            style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 14, padding: "14px 16px", marginBottom: 8, cursor: "pointer", boxShadow: C.shadow }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontWeight: 800, fontSize: 16, color: C.purple }}>{p.numero}</div>
              <div style={{ fontSize: 11, color: C.textMuted }}>{age === 0 ? "Aujourd'hui" : `Il y a ${age}j`}</div>
            </div>
            <div style={{ fontSize: 12, color: C.textSec, marginTop: 4, display: "flex", gap: 12 }}>
              <span>📍 {p.emplacement || "—"}</span>
              {p.notes && <span style={{ color: C.textMuted }}>📝 {p.notes}</span>}
            </div>
          </div>
        );
      })}
      {!loading && palettes.length === 0 && <div style={{ textAlign: "center", padding: 40, color: C.textMuted }}>Aucune palette {statut}</div>}
    </div>
  );
}

// ══════════════════════════════════════════════════════
// PALETTE DETAIL
// ══════════════════════════════════════════════════════
function PaletteDetail({ palette, lignes, session, printerId, onBack, onRefresh }: {
  palette: supaPalettes.WmsPalette;
  lignes: supaPalettes.WmsPaletteLigne[];
  session?: any;
  printerId?: number;
  onBack: () => void;
  onRefresh: () => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [editEmplacement, setEditEmplacement] = useState(false);
  const [emplacement, setEmplacement] = useState(palette.emplacement || "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // Formulaire ajout ligne
  const [newRef, setNewRef] = useState("");
  const [newName, setNewName] = useState("");
  const [newLot, setNewLot] = useState("");
  const [newExpiry, setNewExpiry] = useState("");
  const [newQty, setNewQty] = useState("1");
  const [newUnite, setNewUnite] = useState("unité");

  const totalQty = lignes.reduce((s, l) => s + l.qty, 0);

  const addLigne = async () => {
    if (!newRef.trim() || !newQty) return;
    setLoading(true);
    try {
      await supaPalettes.upsertLigne(palette.id, {
        odoo_ref: newRef.trim(),
        product_name: newName.trim() || newRef.trim(),
        lot: newLot.trim() || null,
        expiry_date: newExpiry || null,
        qty: parseFloat(newQty),
        unite: newUnite,
        updated_at: new Date().toISOString(),
      });
      await onRefresh();
      setNewRef(""); setNewName(""); setNewLot(""); setNewExpiry(""); setNewQty("1");
      setAdding(false);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const changeQty = async (ligneId: number, qty: number) => {
    setLoading(true);
    try {
      await supaPalettes.updateLigneQty(ligneId, qty);
      await onRefresh();
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const saveEmplacement = async () => {
    setLoading(true);
    try {
      await supaPalettes.updatePalette(palette.id, { emplacement });
      setEditEmplacement(false);
      await onRefresh();
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const changeStatut = async (statut: supaPalettes.supaPalettes.WmsPalette["statut"]) => {
    setLoading(true);
    try {
      await supaPalettes.updatePalette(palette.id, { statut });
      await onRefresh();
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const printLabel = async () => {
    if (!printerId) { setError("Aucune imprimante configurée"); return; }
    const zpl = supaPalettes.generatePaletteZPL(palette, lignes);
    try {
      const res = await fetch("/api/printnode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ printerId, content: btoa(zpl), contentType: "raw_base64", title: palette.numero }),
      });
      if (!res.ok) throw new Error("Erreur impression");
    } catch (e: any) { setError(e.message); }
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <button onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#111827" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 22, fontWeight: 900, color: "#7c3aed" }}>{palette.numero}</div>
          <div style={{ fontSize: 12, color: "#9ca3af" }}>{lignes.length} réf · {totalQty} unités</div>
        </div>
        <button onClick={printLabel} style={{ background: "#f5f3ff", border: "1px solid #ddd6fe", borderRadius: 10, padding: "8px 12px", cursor: "pointer" }}>
          🖨️
        </button>
      </div>

      {error && <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, padding: "10px 14px", color: "#dc2626", fontSize: 13, marginBottom: 12 }} onClick={() => setError("")}>{error} ✕</div>}

      {/* Emplacement */}
      <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "12px 16px", marginBottom: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", marginBottom: 6, textTransform: "uppercase" }}>Emplacement</div>
        {editEmplacement ? (
          <div style={{ display: "flex", gap: 8 }}>
            <input style={{ ...inputStyle, flex: 1 }} value={emplacement} onChange={e => setEmplacement(e.target.value)} placeholder="ex: RKC1, A12..." autoFocus />
            <button onClick={saveEmplacement} style={{ background: "#16a34a", color: "#fff", border: "none", borderRadius: 8, padding: "8px 14px", fontWeight: 700, cursor: "pointer" }}>✓</button>
            <button onClick={() => setEditEmplacement(false)} style={{ background: "#f5f5f5", border: "1px solid #e5e7eb", borderRadius: 8, padding: "8px 14px", cursor: "pointer" }}>✕</button>
          </div>
        ) : (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: palette.emplacement ? "#2563eb" : "#9ca3af" }}>
              {palette.emplacement || "Non défini"}
            </span>
            <button onClick={() => setEditEmplacement(true)} style={{ background: "none", border: "none", cursor: "pointer", color: "#9ca3af", fontSize: 13 }}>✏️</button>
          </div>
        )}
      </div>

      {/* Statut */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        {(["actif", "archive", "expedie"] as const).map(s => (
          <button key={s} onClick={() => changeStatut(s)} style={{ flex: 1, padding: "8px 0", borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", border: "none", background: palette.statut === s ? "#7c3aed" : "#f5f6f8", color: palette.statut === s ? "#fff" : "#6b7280" }}>
            {s === "actif" ? "✅ Actif" : s === "archive" ? "📦 Archivé" : "🚚 Expédié"}
          </button>
        ))}
      </div>

      {/* Lignes */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>Contenu</div>
        <button onClick={() => setAdding(!adding)} style={{ background: adding ? "#fef2f2" : "#eff6ff", color: adding ? "#dc2626" : "#2563eb", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
          {adding ? "✕ Annuler" : "+ Ajouter"}
        </button>
      </div>

      {/* Formulaire ajout */}
      {adding && (
        <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 12, padding: 14, marginBottom: 14 }}>
          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ display: "flex", gap: 8 }}>
              <input style={{ ...inputStyle, flex: 2 }} value={newRef} onChange={e => setNewRef(e.target.value)} placeholder="Référence *" />
              <input style={{ ...inputStyle, flex: 3 }} value={newName} onChange={e => setNewName(e.target.value)} placeholder="Désignation" />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input style={{ ...inputStyle, flex: 2 }} value={newLot} onChange={e => setNewLot(e.target.value)} placeholder="Numéro de lot" />
              <input style={{ ...inputStyle, flex: 2 }} type="date" value={newExpiry} onChange={e => setNewExpiry(e.target.value)} />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input style={{ ...inputStyle, flex: 1 }} type="number" value={newQty} onChange={e => setNewQty(e.target.value)} placeholder="Qté" min="0.01" step="0.01" />
              <input style={{ ...inputStyle, flex: 1 }} value={newUnite} onChange={e => setNewUnite(e.target.value)} placeholder="unité" />
              <button onClick={addLigne} disabled={loading || !newRef.trim()} style={{ background: "#2563eb", color: "#fff", border: "none", borderRadius: 8, padding: "10px 18px", fontWeight: 700, cursor: "pointer" }}>
                {loading ? "..." : "✓"}
              </button>
            </div>
          </div>
        </div>
      )}

      {lignes.length === 0 && !adding && (
        <div style={{ textAlign: "center", padding: 32, color: "#9ca3af", fontSize: 13 }}>Palette vide — ajouter des articles</div>
      )}

      {lignes.map(l => (
        <div key={l.id} style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "12px 14px", marginBottom: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#2563eb", fontFamily: "monospace" }}>{l.odoo_ref}</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#111827", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.product_name}</div>
              <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2, display: "flex", gap: 10 }}>
                {l.lot && <span>🏷️ {l.lot}</span>}
                {l.expiry_date && <span>📅 {l.expiry_date}</span>}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
              <button onClick={() => changeQty(l.id, l.qty - 1)} style={{ width: 32, height: 32, borderRadius: 8, border: "1px solid #e5e7eb", background: "#fff", fontSize: 18, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: l.qty <= 1 ? "#dc2626" : "#374151" }}>−</button>
              <span style={{ fontSize: 16, fontWeight: 800, minWidth: 40, textAlign: "center", color: "#111827" }}>{l.qty}</span>
              <button onClick={() => changeQty(l.id, l.qty + 1)} style={{ width: 32, height: 32, borderRadius: 8, border: "1px solid #e5e7eb", background: "#fff", fontSize: 18, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#2563eb" }}>+</button>
            </div>
          </div>
        </div>
      ))}

      {/* Résumé */}
      {lignes.length > 0 && (
        <div style={{ background: "#f5f3ff", border: "1px solid #ddd6fe", borderRadius: 12, padding: "12px 16px", marginTop: 8 }}>
          <div style={{ fontSize: 13, color: "#7c3aed", fontWeight: 700 }}>
            {lignes.length} référence{lignes.length > 1 ? "s" : ""} · {totalQty} unité{totalQty > 1 ? "s" : ""} au total
          </div>
        </div>
      )}
    </div>
  );
}

function Login({ onLogin, loading, error }: { onLogin: (u: string, d: string, l: string, p: string) => void; loading: boolean; error: string }) {
  const cfg = typeof window !== "undefined" ? loadCfg() : null;
  const [url, setUrl] = useState(cfg?.u || ""); const [db, setDb] = useState(cfg?.d || "");
  const [user, setUser] = useState(""); const [pw, setPw] = useState("");
  const [showCfg, setShowCfg] = useState(!cfg);
  const go = () => { if (url && db && user && pw) onLogin(url, db, user, pw); };

  return (
    <Shell toast="">
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ width: "100%", maxWidth: 400, padding: 20 }}>
          <div style={{ textAlign: "center", marginBottom: 36 }}>
            <div style={{ width: 56, height: 56, borderRadius: 14, background: C.blue, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px" }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.5"><path d="M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M20 10v11M8 14v3M12 14v3M16 14v3"/></svg>
            </div>
            <img src={DH_LOGO} alt="Dr. Hauschka" style={{ height: 44, objectFit: "contain", marginBottom: 12 }} />
            <h1 style={{ fontSize: 20, fontWeight: 700, color: C.text }}>WMS Scanner</h1>
            <p style={{ fontSize: 14, color: C.textMuted, marginTop: 4 }}>Connexion à votre entrepôt</p>
          </div>
          <Section>
            <button onClick={() => setShowCfg(!showCfg)} style={{ ...secondaryBtn, marginBottom: showCfg ? 12 : 0, fontSize: 12 }}>{showCfg ? "Masquer" : "Afficher"} la config serveur</button>
            {showCfg && <>
              <Field label="URL Odoo" value={url} onChange={setUrl} placeholder="https://monentreprise.odoo.com" />
              <Field label="Base de données" value={db} onChange={setDb} placeholder="nom_base" />
            </>}
            <Field label="Identifiant" value={user} onChange={setUser} placeholder="admin@company.com" />
            <Field label="Mot de passe" value={pw} onChange={setPw} placeholder="••••••••" type="password" onEnter={go} />
            {error && <Alert type="error">{error}</Alert>}
            <button onClick={go} disabled={loading} style={{ width: "100%", padding: 14, background: C.blue, color: "#fff", border: "none", borderRadius: 10, fontSize: 15, fontWeight: 700, cursor: loading ? "wait" : "pointer", marginTop: 8, fontFamily: "inherit" }}>
              {loading ? "Connexion..." : "Se connecter"}
            </button>
          </Section>
        </div>
      </div>
    </Shell>
  );
}

function Field({ label, value, onChange, placeholder, type, onEnter }: { label: string; value: string; onChange: (v: string) => void; placeholder: string; type?: string; onEnter?: () => void }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ fontSize: 12, fontWeight: 600, color: C.textSec, marginBottom: 4, display: "block" }}>{label}</label>
      <input type={type || "text"} style={inputStyle} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        onKeyDown={e => { if (e.key === "Enter" && onEnter) onEnter(); }} />
    </div>
  );
}

// ============================================
// STYLE CONSTANTS
// ============================================
const inputStyle: React.CSSProperties = {
  width: "100%", padding: "12px 14px", background: C.bg, border: `1.5px solid ${C.border}`, borderRadius: 10,
  color: C.text, fontSize: 14, fontFamily: "'DM Sans', sans-serif", outline: "none", boxSizing: "border-box",
};

const iconBtn: React.CSSProperties = {
  background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex", alignItems: "center", justifyContent: "center",
};

const secondaryBtn: React.CSSProperties = {
  width: "100%", padding: 12, background: "none", color: C.blue, border: `1.5px solid ${C.border}`, borderRadius: 10,
  fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans', sans-serif",
};

const qtyBtn: React.CSSProperties = {
  width: 58, height: 58, flexShrink: 0,
  background: C.blue, color: "#fff",
  border: "none", borderRadius: 10, fontSize: 28, fontWeight: 700,
  cursor: "pointer", fontFamily: "inherit",
  display: "flex", alignItems: "center", justifyContent: "center",
  touchAction: "manipulation",
};

// ============================================
// ICONS
// ============================================
const scanIcon = <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={C.blue} strokeWidth="2.5"><path d="M3 7V5a2 2 0 012-2h2M17 3h2a2 2 0 012 2v2M21 17v2a2 2 0 01-2 2h-2M7 21H5a2 2 0 01-2-2v-2"/><line x1="7" y1="12" x2="17" y2="12"/></svg>;
const homeIcon = <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={C.blue} strokeWidth="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>;
const logoutIcon = <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={C.textMuted} strokeWidth="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>;
const trashIcon = <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>;
const editIcon = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={C.textMuted} strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>;
const clockIcon = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.textMuted} strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>;
const printerIcon = <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={C.textSec} strokeWidth="2"><path d="M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>;
const printerSmallIcon = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={C.blue} strokeWidth="2.5"><path d="M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>;
const settingsIcon = <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={C.textMuted} strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>;

const testBtnStyle: React.CSSProperties = {
  flex: 1, padding: "10px 0", background: C.bg, color: C.textSec,
  border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 11,
  fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
};
const transferIcon = (c: string) => <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 014-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>;
const prepIcon = <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 11l3 3L22 4"/><line x1="9" y1="17" x2="9" y2="17"/><line x1="13" y1="17" x2="13" y2="17"/></svg>;
const boxIcon = (c: string, s: number) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>;

const cardStyle: React.CSSProperties = { background: C.white, borderRadius: 14, padding: 16, border: `1px solid ${C.border}`, boxShadow: C.shadow };
