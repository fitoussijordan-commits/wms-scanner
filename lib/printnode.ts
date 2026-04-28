// lib/printnode.ts — Client-side PrintNode helper
// All API calls go through /api/printnode (server-side proxy)
// API key is NEVER exposed to the browser
import { loadPrintConfigs, savePrintConfig } from "./supabase";

// ============================================
// LABEL SIZE CONFIG
// ============================================
export interface LabelSize { widthMM: number; heightMM: number; }

const LABEL_SIZE_KEY = "wms_label_size";
const DEFAULT_SIZE: LabelSize = { widthMM: 70, heightMM: 45 };

export function getLabelSize(): LabelSize {
  try { const v = localStorage.getItem(LABEL_SIZE_KEY); return v ? JSON.parse(v) : DEFAULT_SIZE; }
  catch { return DEFAULT_SIZE; }
}

export function saveLabelSize(size: LabelSize) {
  try { localStorage.setItem(LABEL_SIZE_KEY, JSON.stringify(size)); } catch {}
}

function mm(v: number): number { return Math.round(v * 8); } // mm → dots @203dpi

// ============================================
// PRINTER
// ============================================
export interface PrintNodePrinter {
  id: number; name: string; description: string; state: string;
  computer: { id: number; name: string };
}

export async function listPrinters(): Promise<PrintNodePrinter[]> {
  const res = await fetch("/api/printnode?action=printers");
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Erreur ${res.status}`);
  }
  const data = await res.json();
  return data.map((p: any) => ({
    id: p.id, name: p.name, description: p.description || "", state: p.state,
    computer: { id: p.computer?.id, name: p.computer?.name },
  }));
}

// ============================================
// PRINT JOB (via server proxy)
// ============================================
async function submitPrintJob(printerId: number, title: string, zpl: string, qty: number = 1): Promise<number> {
  const fullZpl = qty > 1 ? Array(qty).fill(zpl).join("\n") : zpl;
  // Encode en UTF-8 base64 : ^CI28 dans le ZPL attend de l'UTF-8
  // btoa(fullZpl) seul encode en Latin-1 → les accents cassent l'impression
  const content = btoa(unescape(encodeURIComponent(fullZpl)));
  const res = await fetch("/api/printnode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "print",
      printerId,
      title,
      content,
      source: "WMS Scanner",
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Erreur impression ${res.status}`);
  }
  const data = await res.json();
  return data.jobId;
}

// Palette only: ZPL→PDF via Labelary. Latin1 encode for accents.
async function submitPaletteJob(printerId: number, title: string, zpl: string, labelWidthMM: number, labelHeightMM: number): Promise<number> {
  // Encode latin1 bytes safely for btoa
  const encoded = btoa(Array.from(zpl).map(c => {
    const code = c.charCodeAt(0);
    return code <= 255 ? String.fromCharCode(code) : "?";
  }).join(""));
  const res = await fetch("/api/printnode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "print",
      printerId,
      title,
      content: encoded,
      source: "WMS Scanner",
      usePdf: true,
      labelWidthMM,
      labelHeightMM,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Erreur impression ${res.status}`);
  }
  const data = await res.json();
  return data.jobId;
}

// ============================================
// PDF PRINT (base64 PDF direct to PrintNode)
// ============================================
async function submitPdfJob(printerId: number, title: string, pdfBase64: string, qty: number = 1): Promise<number> {
  const res = await fetch("/api/printnode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "print",
      printerId,
      title,
      content: pdfBase64,
      source: "WMS Scanner",
      contentType: "pdf_base64",
      qty,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Erreur impression ${res.status}`);
  }
  const data = await res.json();
  return data.jobId;
}

export async function printPdfLabel(
  printerId: number, pdfBase64: string, title: string = "Étiquette", qty: number = 1
): Promise<{ success: boolean; jobId?: number; error?: string }> {
  try {
    const jobId = await submitPdfJob(printerId, title, pdfBase64, qty);
    return { success: true, jobId };
  } catch (e: any) { return { success: false, error: e.message }; }
}

// ============================================
// ZPL HELPERS
// ============================================
function trunc(s: string, max: number): string {
  return s.length > max ? s.substring(0, max) : s;
}

function formatDate(d: string): string {
  try { const dt = new Date(d); return isNaN(dt.getTime()) ? d : dt.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" }); }
  catch { return d; }
}

// Extrait la valeur scannable d'un lot : "a1441135 - 02/28" → "a1441135"
// Supprime la partie après " - " (suffixe date/commentaire) et les "/" restants
function cleanLotForBarcode(lotName: string): string {
  const part = lotName.split(/\s+-\s+/)[0].trim();
  return part.replace(/\//g, "").trim() || lotName;
}

function barcodeZPL(barcode: string, labelW: number, y: number, height: number, preferredBarW: number = 3): string {
  const isEAN13 = /^\d{13}$/.test(barcode);
  const isEAN8 = /^\d{8}$/.test(barcode);

  let barW = preferredBarW;

  if (!isEAN13 && !isEAN8) {
    const modules = 11 * barcode.length + 35;
    const maxW = labelW - 40;
    barW = Math.min(preferredBarW, Math.max(1, Math.floor(maxW / modules)));
  }

  let bcPixelW: number;
  if (isEAN13) bcPixelW = 95 * barW;
  else if (isEAN8) bcPixelW = 67 * barW;
  else bcPixelW = (11 * barcode.length + 35) * barW;

  const x = Math.max(5, Math.round((labelW - bcPixelW) / 2));

  if (isEAN13) return `^BY${barW},3,${height}^FO${x},${y}^BEN,${height},Y,N^FD${barcode}^FS`;
  if (isEAN8) return `^BY${barW},3,${height}^FO${x},${y}^B8N,${height},Y,N^FD${barcode}^FS`;
  return `^BY${barW},3,${height}^FO${x},${y}^BCN,${height},Y,N,N^FD${barcode}^FS`;
}

// ============================================
// PRODUCT LABEL
// ============================================
export function generateProductZPL(productName: string, barcode: string, ref?: string, sz?: LabelSize): string {
  if (!sz) { try { sz = getLabelTypeConfig("product").labelSize; } catch { sz = getLabelSize(); } }
  const W = mm(sz.widthMM);
  const H = mm(sz.heightMM);
  const cW = W - 20;
  const cpl = Math.floor(cW / 13);
  const barW = sz.widthMM >= 60 ? 3 : 2;
  const bcH = Math.min(Math.round(H * 0.40), 130);
  const hasRef = !!ref;

  const refBlock = hasRef ? 46 : 0;
  const nameBlock = 30;
  const bcBlock = bcH + 24;
  const total = refBlock + nameBlock + bcBlock;
  const startY = Math.max(8, Math.round((H - total) / 2));

  let y = startY;
  const lines: string[] = ["^XA", `^PW${W}`, `^LL${H}`, "^CI28"];

  if (hasRef) {
    lines.push(`^FO10,${y}^A0N,40,40^FB${cW},1,0,C^FD${trunc(ref!, cpl)}^FS`);
    y += 46;
  }
  lines.push(`^FO10,${y}^A0N,26,26^FB${cW},1,0,C^FD${trunc(productName, cpl)}^FS`);
  y += nameBlock;
  lines.push(barcodeZPL(barcode, W, y, bcH, barW));
  lines.push("^XZ");

  return lines.join("\n");
}

// ============================================
// LOT LABEL
// ============================================
export function generateLotZPL(lotName: string, productName: string, lotBarcode: string, expiryDate?: string, sz?: LabelSize): string {
  if (!sz) { try { sz = getLabelTypeConfig("lot").labelSize; } catch { sz = getLabelSize(); } }
  const W = mm(sz.widthMM);
  const H = mm(sz.heightMM);
  const cW = W - 20;
  const cpl = Math.floor(cW / 13);
  const barW = sz.widthMM >= 60 ? 3 : 2;
  const bcH = Math.min(Math.round(H * 0.33), 110);
  const expStr = expiryDate ? formatDate(expiryDate) : "";

  const lotBlock = 46;
  const nameBlock = 26;
  const expBlock = expStr ? 24 : 0;
  const bcBlock = bcH + 22;
  const total = lotBlock + nameBlock + expBlock + bcBlock;
  const startY = Math.max(6, Math.round((H - total) / 2));

  let y = startY;
  const lines: string[] = ["^XA", `^PW${W}`, `^LL${H}`, "^CI28"];

  lines.push(`^FO10,${y}^A0N,40,40^FB${cW},1,0,C^FD${trunc(lotName, cpl)}^FS`);
  y += lotBlock;
  lines.push(`^FO10,${y}^A0N,22,22^FB${cW},1,0,C^FD${trunc(productName, cpl)}^FS`);
  y += nameBlock;

  if (expStr) {
    lines.push(`^FO10,${y}^A0N,22,22^FB${cW},1,0,C^FDDLUO: ${expStr}^FS`);
    y += expBlock;
  }

  // Code-barres lot: utilise lotBarcode ou lotName si barcode est un chemin
  const cleanLotBarcode = lotBarcode.includes("/") ? lotName : lotBarcode;
  lines.push(barcodeZPL(cleanLotBarcode, W, y, bcH, barW));
  lines.push("^XZ");

  return lines.join("\n");
}

// ============================================
// LOCATION LABEL
// ============================================
export function generateLocationZPL(locationName: string, locationBarcode: string, sz?: LabelSize): string {
  if (!sz) { try { sz = getLabelTypeConfig("location").labelSize; } catch { sz = getLabelSize(); } }
  const W = mm(sz.widthMM);
  const H = mm(sz.heightMM);
  const cW = W - 20;
  const barW = sz.widthMM >= 60 ? 3 : 2;
  const bcH = Math.min(Math.round(H * 0.42), 130);

  const nameBlock = 48;
  const bcBlock = bcH + 22;
  const total = nameBlock + bcBlock;
  const startY = Math.max(8, Math.round((H - total) / 2));

  let y = startY;
  const lines: string[] = ["^XA", `^PW${W}`, `^LL${H}`, "^CI28"];

  // Nom affiché: dernier segment du chemin, premier mot avant "-"
  // "WH/Stock/.../A12-RKC1" → "A12" | "B-A12" → "A12"
  const lastSegment = locationName.split("/").pop() || locationName;
  const shortName = lastSegment.replace(/^B-/i, "").split("-")[0];
  // Code-barres: valeur complète Odoo (ex: "B-A12") — ne pas stripper
  const locBarcode = locationBarcode || shortName;
  lines.push(`^FO10,${y}^A0N,40,40^FB${cW},1,0,C^FD${shortName}^FS`);
  y += nameBlock;
  lines.push(barcodeZPL(locBarcode, W, y, bcH, barW));
  lines.push("^XZ");

  return lines.join("\n");
}

// ============================================
// PALETTE LABEL (GS1 logistics label)
// ============================================
export interface PaletteRef {
  ref?: string;
  productName?: string;
  lot?: string;
  qty?: number;
}

export interface PaletteLabelData {
  paletteNumber?: number;
  // Expéditeur
  senderName?: string;
  senderAddress?: string;
  // Destinataire
  recipientName?: string;
  recipientAddress?: string;
  // Contenu palette — multi-produits
  refs?: PaletteRef[];          // liste de refs/produits
  productName?: string;         // fallback mono-produit
  ref?: string;
  lotNumber?: string;
  sscc: string;
  quantity?: number;
  unit?: string;
  expiryDate?: string;
  weight?: string;
  // Transport
  orderRef?: string;
  deliveryRef?: string;
}

// Normalize accents for ZPL CI28 — replace problematic chars
function zplSafe(s: string): string {
  if (!s) return "";
  return s
    .replace(/é/g, "\xE9").replace(/è/g, "\xE8").replace(/ê/g, "\xEA").replace(/ë/g, "\xEB")
    .replace(/à/g, "\xE0").replace(/â/g, "\xE2").replace(/ä/g, "\xE4")
    .replace(/î/g, "\xEE").replace(/ï/g, "\xEF")
    .replace(/ô/g, "\xF4").replace(/ö/g, "\xF6")
    .replace(/ù/g, "\xF9").replace(/û/g, "\xFB").replace(/ü/g, "\xFC")
    .replace(/ç/g, "\xE7").replace(/ñ/g, "\xF1")
    .replace(/É/g, "\xC9").replace(/È/g, "\xC8").replace(/Ê/g, "\xCA")
    .replace(/À/g, "\xC0").replace(/Â/g, "\xC2")
    .replace(/Î/g, "\xCE").replace(/Ô/g, "\xD4")
    .replace(/Ù/g, "\xD9").replace(/Û/g, "\xDB")
    .replace(/Ç/g, "\xC7")
    .replace(/[^\x20-\xFF]/g, "");
}

// Convert PaletteLabelData to LabelTemplate for jsPDF rendering
export function paletteDataToTemplate(data: PaletteLabelData, paletteNumber?: number): import("@/components/LabelEditor").LabelTemplate {
  const W = 100, H = 150;
  const elements: import("@/components/LabelEditor").LabelElement[] = [];
  let y = 4;
  const uid = () => Math.random().toString(36).slice(2, 8);

  // Big palette number — top right
  if (paletteNumber !== undefined) {
    elements.push({
      id: uid(), type: "text",
      x: W - 30, y: 1, w: 28, h: 28,
      text: "P" + paletteNumber,
      fontSize: 44, bold: true, align: "right",
    });
  }

  const addText = (text: string, fontSize: number, bold = false, align: "left"|"center"|"right" = "left", h = fontSize * 0.4) => {
    if (!text) return;
    elements.push({ id: uid(), type: "text", x: 4, y, w: W - 8, h: Math.max(h, fontSize * 0.4 + 1), text, fontSize, bold, align });
    y += fontSize * 0.4 + 2;
  };
  const addLine = () => {
    elements.push({ id: uid(), type: "line", x: 2, y, w: W - 4, h: 0.5, thickness: 0.3 });
    y += 2;
  };

  // Expéditeur
  addText("Expéditeur", 7, false, "left");
  if (data.senderName) addText(data.senderName, 9, true);
  if (data.senderAddress) addText(data.senderAddress, 8);
  y += 1; addLine();

  // Destinataire
  addText("Destinataire", 7);
  if (data.recipientName) addText(data.recipientName, 13, true);
  if (data.recipientAddress) addText(data.recipientAddress, 9);
  y += 1; addLine();

  // Contenu
  addText("Contenu", 7);
  const refs = data.refs && data.refs.length > 0
    ? data.refs
    : [{ ref: data.ref, productName: data.productName, lot: data.lotNumber, qty: data.quantity }];

  for (const r of refs) {
    if (r.productName) addText(r.productName, 10, true);
    const parts = [r.ref && `Réf: ${r.ref}`, r.lot && `Lot: ${r.lot}`, r.qty && `Qt: ${r.qty}${data.unit ? " " + data.unit : ""}`].filter(Boolean).join("  ");
    if (parts) addText(parts, 8);
  }
  if (data.weight) addText(`Poids: ${data.weight}`, 8);
  if (data.expiryDate) addText(`DLUO: ${data.expiryDate}`, 8);
  const refs2 = [data.orderRef && `CDE: ${data.orderRef}`, data.deliveryRef && `BL: ${data.deliveryRef}`].filter(Boolean).join("   ");
  if (refs2) addText(refs2, 8);

  y += 1; addLine();

  // SSCC barcode
  addText("SSCC (00)", 7);
  const ssccH = Math.min(H - y - 12, 22);
  elements.push({ id: uid(), type: "barcode", x: 4, y, w: W - 8, h: ssccH, value: `00${data.sscc}` });
  y += ssccH + 2;
  addText(`(00) ${data.sscc || ""}`, 7, false, "center");

  return { widthMM: W, heightMM: H, elements };
}

export function generatePaletteZPL(data: PaletteLabelData): string {
  const W = mm(100);
  const H = mm(150);
  const cW = W - 24;
  const sH = 22;   // small line height
  const mH = 28;   // medium
  const lH = 36;   // large
  const sectionGap = 8;

  const lines: string[] = ["^XA", `^PW${W}`, `^LL${H}`, "^CI28"];
  const hline = (yPos: number) => `^FO10,${yPos}^GB${W - 20},2,2^FS`;

  let y = 10;

  // ── NUMÉRO PALETTE (gros, coin haut droit) ──
  if (data.paletteNumber !== undefined) {
    lines.push(`^FO${W - 230},5^A0N,210,210^FB220,1,0,C^FDP${data.paletteNumber}^FS`);
    y = 225; // décale le contenu sous le gros numéro
  }

  // ── EXPÉDITEUR ──
  lines.push(`^FO10,${y}^A0N,18,18^FDExpediteur^FS`);
  y += 20;
  if (data.senderName) {
    lines.push(`^FO10,${y}^A0N,${mH},${mH}^FB${cW},2,0,L^FD${zplSafe(data.senderName)}^FS`);
    y += mH + 4;
  }
  if (data.senderAddress) {
    lines.push(`^FO10,${y}^A0N,${sH},${sH}^FB${cW},2,0,L^FD${zplSafe(data.senderAddress)}^FS`);
    y += sH * 2 + 2;
  }

  lines.push(hline(y)); y += sectionGap + 4;

  // ── DESTINATAIRE ──
  lines.push(`^FO10,${y}^A0N,18,18^FDDestinataire^FS`);
  y += 20;
  if (data.recipientName) {
    lines.push(`^FO10,${y}^A0N,${lH},${lH}^FB${cW},2,0,L^FD${zplSafe(data.recipientName)}^FS`);
    y += lH * 2 + 4;
  }
  if (data.recipientAddress) {
    lines.push(`^FO10,${y}^A0N,${sH},${sH}^FB${cW},2,0,L^FD${zplSafe(data.recipientAddress)}^FS`);
    y += sH * 2 + 2;
  }

  lines.push(hline(y)); y += sectionGap + 4;

  // ── CONTENU ──
  lines.push(`^FO10,${y}^A0N,18,18^FDContenu^FS`);
  y += 20;

  // Multi-refs (plusieurs produits sur la palette)
  const allRefs: PaletteRef[] = data.refs && data.refs.length > 0
    ? data.refs
    : [{ ref: data.ref, productName: data.productName, lot: data.lotNumber, qty: data.quantity }];

  for (const r of allRefs) {
    if (r.productName) {
      lines.push(`^FO10,${y}^A0N,${mH},${mH}^FB${cW},2,0,L^FD${zplSafe(r.productName)}^FS`);
      y += mH + 2;
    }
    // Ref + lot + qty on same line
    const parts: string[] = [];
    if (r.ref) parts.push(`Ref: ${r.ref}`);
    if (r.lot) parts.push(`Lot: ${r.lot}`);
    if (r.qty) parts.push(`Qt: ${r.qty}${data.unit ? " " + data.unit : " cartons"}`);
    if (parts.length > 0) {
      lines.push(`^FO10,${y}^A0N,${sH},${sH}^FB${cW},2,0,L^FD${zplSafe(parts.join(" / "))}^FS`);
      y += sH + 4;
    }
  }

  if (data.weight) {
    lines.push(`^FO10,${y}^A0N,${mH},${mH}^FDPoids: ${zplSafe(data.weight)}^FS`);
    y += mH + 4;
  }

  if (data.expiryDate) {
    lines.push(`^FO10,${y}^A0N,${sH},${sH}^FDDLUO: ${formatDate(data.expiryDate)}^FS`);
    y += sH + 4;
  }

  if (data.orderRef || data.deliveryRef) {
    const refs2 = [data.orderRef && `CDE: ${data.orderRef}`, data.deliveryRef && `BL: ${data.deliveryRef}`].filter(Boolean).join("   ");
    lines.push(`^FO10,${y}^A0N,${sH},${sH}^FB${cW},1,0,L^FD${zplSafe(refs2)}^FS`);
    y += sH + 4;
  }

  lines.push(hline(y + 2)); y += sectionGap + 8;

  // ── SSCC barcode ──
  lines.push(`^FO10,${y}^A0N,18,18^FDSSCC (00)^FS`);
  y += 20;

  const ssccPayload = `00${data.sscc}`;
  const bcH = Math.min(H - y - 32, 90);
  const barW = 3;
  const modules = 11 * ssccPayload.length + 35;
  const bcPixelW = modules * barW;
  const x = Math.max(10, Math.round((W - bcPixelW) / 2));

  lines.push(`^BY${barW},3,${bcH}^FO${x},${y}^BCN,${bcH},N,N,N^FD>:${ssccPayload}^FS`);
  y += bcH + 4;

  const ssccFormatted = `(00) ${data.sscc.replace(/(\d{2})(\d{7})(\d{9})/, "$1 $2 $3")}`;
  lines.push(`^FO10,${y}^A0N,20,20^FB${cW},1,0,C^FD${ssccFormatted}^FS`);

  lines.push("^XZ");
  return lines.join("\n");
}

// ============================================
// BLANK / CUSTOM LABEL
// ============================================
export interface BlankLabelLine {
  text: string;
  fontSize?: number;   // 16–60, default 26
  align?: "L" | "C" | "R";
  bold?: boolean;
}

export interface BlankLabelData {
  lines: BlankLabelLine[];
  barcode?: string;    // optional barcode at bottom
  barcodeLabel?: string; // text to show under barcode
}

export function generateBlankZPL(data: BlankLabelData): string {
  const sz = getLabelSize();
  const W = mm(sz.widthMM);
  const H = mm(sz.heightMM);
  const cW = W - 20;

  const zplLines: string[] = ["^XA", `^PW${W}`, `^LL${H}`, "^CI28"];

  // Calculate total height needed
  const lineHeights = data.lines.map(l => (l.fontSize ?? 26) + 6);
  const bcH = data.barcode ? Math.min(Math.round(H * 0.35), 100) : 0;
  const bcLabelH = data.barcode ? 26 : 0;
  const totalContent = lineHeights.reduce((a, b) => a + b, 0) + bcH + bcLabelH;
  let y = Math.max(8, Math.round((H - totalContent) / 2));

  for (const line of data.lines) {
    const fs = Math.min(60, Math.max(16, line.fontSize ?? 26));
    const align = line.align ?? "C";
    const cpl = Math.floor(cW / (fs * 0.6));
    zplLines.push(
      `^FO10,${y}^A0N,${fs},${fs}^FB${cW},1,0,${align}^FD${trunc(line.text, cpl)}^FS`
    );
    y += fs + 6;
  }

  if (data.barcode) {
    y += 6;
    const barW = sz.widthMM >= 60 ? 3 : 2;
    zplLines.push(barcodeZPL(data.barcode, W, y, bcH, barW));
    y += bcH + 4;
    if (data.barcodeLabel) {
      zplLines.push(`^FO10,${y}^A0N,20,20^FB${cW},1,0,C^FD${trunc(data.barcodeLabel, 40)}^FS`);
    }
  }

  zplLines.push("^XZ");
  return zplLines.join("\n");
}

// ============================================
// PRINT FUNCTIONS
// ============================================
export async function printProductLabel(
  printerId: number, productName: string, barcode: string, ref?: string, qty: number = 1
): Promise<{ success: boolean; jobId?: number; error?: string }> {
  try {
    console.log("[printProductLabel] start", { printerId, productName, barcode });
    const zpl = generateProductZPL(productName, barcode, ref);
    console.log("[printProductLabel] zpl ok, len:", zpl.length);
    const jobId = await submitPrintJob(printerId, `Produit: ${productName}`, zpl, qty);
    console.log("[printProductLabel] jobId:", jobId);
    return { success: true, jobId };
  } catch (e: any) {
    console.error("[printProductLabel] ERROR:", e.message, e.stack);
    return { success: false, error: e.message };
  }
}

export async function printLotLabel(
  printerId: number, lotName: string, productName: string, lotBarcode: string, expiryDate?: string, qty: number = 1
): Promise<{ success: boolean; jobId?: number; error?: string }> {
  try {
    const zpl = generateLotZPL(lotName, productName, lotBarcode, expiryDate);
    const jobId = await submitPrintJob(printerId, `Lot: ${lotName}`, zpl, qty);
    return { success: true, jobId };
  } catch (e: any) { return { success: false, error: e.message }; }
}

export async function printLocationLabel(
  printerId: number, locationName: string, locationBarcode: string, qty: number = 1
): Promise<{ success: boolean; jobId?: number; error?: string }> {
  try {
    const zpl = generateLocationZPL(locationName, locationBarcode);
    const jobId = await submitPrintJob(printerId, `Empl: ${locationName}`, zpl, qty);
    return { success: true, jobId };
  } catch (e: any) { return { success: false, error: e.message }; }
}

export async function printPaletteLabel(
  printerId: number, data: PaletteLabelData, qty: number = 1
): Promise<{ success: boolean; jobId?: number; error?: string }> {
  try {
    const zpl = generatePaletteZPL(data);
    const jobId = await submitPaletteJob(printerId, `Palette: ${data.recipientName || "dest"}`, zpl, 100, 150);
    return { success: true, jobId };
  } catch (e: any) { return { success: false, error: e.message }; }
}

export async function printBlankLabel(
  printerId: number, data: BlankLabelData, title: string = "Étiquette", qty: number = 1
): Promise<{ success: boolean; jobId?: number; error?: string }> {
  try {
    const zpl = generateBlankZPL(data);
    const jobId = await submitPrintJob(printerId, title, zpl, qty);
    return { success: true, jobId };
  } catch (e: any) { return { success: false, error: e.message }; }
}

export async function printLabel(
  printerId: number, productName: string, barcode: string
): Promise<{ success: boolean; jobId?: number; error?: string }> {
  return printProductLabel(printerId, productName, barcode);
}

// ============================================
// BIG LABEL — 150×100mm paysage (format palette)
// ============================================
function generateBigLandscapeZPL(
  type: string,
  title: string,
  barcode: string,
  opts: { ref?: string; lotName?: string; productName?: string; expiryDate?: string; locationName?: string } = {}
): string {
  // 150mm × 100mm paysage @203dpi
  const W = mm(150), H = mm(100);
  const cW = W - 30;
  const cpl = Math.floor(cW / 9);
  const barW = 4;
  const lines: string[] = ["^XA", `^PW${W}`, `^LL${H}`, "^CI28"];

  if (type === "lot") {
    const lotName = opts.lotName || title;
    const productName = opts.productName || "";
    const expStr = opts.expiryDate ? formatDate(opts.expiryDate) : "";
    // Text block en haut
    let y = 14;
    lines.push(`^FO15,${y}^A0N,70,70^FB${cW},1,0,C^FD${trunc(lotName, cpl)}^FS`); y += 80;
    lines.push(`^FO15,${y}^A0N,38,38^FB${cW},1,0,C^FD${trunc(productName, cpl)}^FS`); y += 46;
    if (expStr) { lines.push(`^FO15,${y}^A0N,30,30^FB${cW},1,0,C^FDDLUO: ${expStr}^FS`); y += 36; }
    // Barcode : extrait la partie scannable ("a1441135 - 02/28" → "a1441135")
    const cleanBarcode = cleanLotForBarcode(barcode.includes("/") ? lotName : barcode);
    const bcH = Math.max(50, H - y - 60);
    lines.push(barcodeZPL(cleanBarcode, W, y, bcH, barW));

  } else if (type === "location") {
    const locName = (opts.locationName || title || "").split("/").pop()?.split("-")[0] || title;
    let y = 20;
    lines.push(`^FO15,${y}^A0N,100,100^FB${cW},1,0,C^FD${trunc(locName, cpl)}^FS`); y += 118;
    const bcH = Math.max(50, H - y - 60);
    lines.push(barcodeZPL(barcode, W, y, bcH, barW));

  } else {
    // produit (défaut)
    const productName = opts.productName || title;
    let y = 14;
    if (opts.ref) {
      lines.push(`^FO15,${y}^A0N,38,38^FB${cW},1,0,C^FD${trunc(opts.ref, cpl)}^FS`); y += 46;
    }
    lines.push(`^FO15,${y}^A0N,60,60^FB${cW},2,0,C^FD${trunc(productName, cpl)}^FS`); y += 76;
    const bcH = Math.max(50, H - y - 60);
    lines.push(barcodeZPL(barcode, W, y, bcH, barW));
  }

  lines.push("^XZ");
  return lines.join("\n");
}

export async function printBigLabel(
  printerId: number,
  type: string,
  title: string,
  barcode: string,
  opts: { ref?: string; lotName?: string; productName?: string; expiryDate?: string; locationName?: string } = {},
  qty: number = 1
): Promise<{ success: boolean; jobId?: number; error?: string }> {
  try {
    const zpl = generateBigLandscapeZPL(type, title, barcode, opts);
    // 150×100 paysage
    const jobId = await submitPaletteJob(printerId, title, zpl, 150, 100);
    return { success: true, jobId };
  } catch (e: any) { return { success: false, error: e.message }; }
}

// ============================================
// CONFIG
// ============================================
const PRINTER_KEY = "wms_printer_id";

export function getSavedPrinterId(): number | null {
  try { const v = localStorage.getItem(PRINTER_KEY); return v ? parseInt(v, 10) : null; } catch { return null; }
}

export function savePrinterId(id: number) {
  try { localStorage.setItem(PRINTER_KEY, String(id)); } catch {}
}

export function isConfigured(): boolean {
  return !!getSavedPrinterId();
}

// ============================================
// PER-TYPE LABEL CONFIG
// ============================================
export type LabelType = "product" | "lot" | "location" | "palette" | "palette_wms" | "blank" | "picking" | "sendcloud" | "packingslip" | "packingslip_eshop" | "order_barcode";

export interface LabelTypeConfig {
  printerId: number | null;
  labelSize: LabelSize;
}

const TYPE_CONFIG_KEY = "wms_label_type_config";

export function getLabelTypeConfig(type: LabelType): LabelTypeConfig {
  try {
    const all = JSON.parse(localStorage.getItem(TYPE_CONFIG_KEY) || "{}");
    return all[type] || { printerId: getSavedPrinterId(), labelSize: getLabelSize() };
  } catch { return { printerId: getSavedPrinterId(), labelSize: getLabelSize() }; }
}

export function saveLabelTypeConfig(type: LabelType, config: Partial<LabelTypeConfig>) {
  try {
    const all = JSON.parse(localStorage.getItem(TYPE_CONFIG_KEY) || "{}");
    const merged = { ...getLabelTypeConfig(type), ...config };
    all[type] = merged;
    localStorage.setItem(TYPE_CONFIG_KEY, JSON.stringify(all));
    // Sync vers Supabase en arrière-plan (sans bloquer l'UI)
    savePrintConfig(
      type,
      merged.printerId,
      merged.labelSize.widthMM,
      merged.labelSize.heightMM
    ).catch(e => console.warn("[printnode] savePrintConfig Supabase:", e.message));
  } catch {}
}

export function getAllLabelTypeConfigs(): Record<LabelType, LabelTypeConfig> {
  const types: LabelType[] = ["product", "lot", "location", "palette", "palette_wms", "blank", "picking", "sendcloud", "packingslip", "packingslip_eshop", "order_barcode"];
  const result = {} as Record<LabelType, LabelTypeConfig>;
  for (const t of types) result[t] = getLabelTypeConfig(t);
  return result;
}

/**
 * Synchro bidirectionnelle config imprimante ↔ Supabase.
 * - Si Supabase est vide → pousse la config locale (premier poste configuré)
 * - Si Supabase a des données → les rapatrie en local (autres postes)
 * À appeler une fois au démarrage de l'app.
 */
export async function syncPrintConfigFromSupabase(): Promise<void> {
  try {
    const remote = await loadPrintConfigs();
    const local = JSON.parse(localStorage.getItem(TYPE_CONFIG_KEY) || "{}") as Record<string, LabelTypeConfig>;

    if (!Object.keys(remote).length) {
      // Supabase vide → on pousse toute la config locale existante
      const pushPromises: Promise<void>[] = [];
      const types: LabelType[] = ["product", "lot", "location", "palette", "palette_wms", "blank", "picking", "sendcloud", "packingslip", "packingslip_eshop", "order_barcode"];
      for (const type of types) {
        const cfg = local[type];
        if (cfg?.printerId) {
          pushPromises.push(
            savePrintConfig(type, cfg.printerId, cfg.labelSize.widthMM, cfg.labelSize.heightMM)
              .catch(e => console.warn("[printnode] push config:", e.message))
          );
        }
      }
      // Pousse aussi la config globale (wms_printer_id) si pas de config par type
      if (!pushPromises.length) {
        const pid = getSavedPrinterId();
        const sz = getLabelSize();
        if (pid) {
          for (const type of types) {
            pushPromises.push(
              savePrintConfig(type, pid, sz.widthMM, sz.heightMM)
                .catch(e => console.warn("[printnode] push global config:", e.message))
            );
          }
        }
      }
      await Promise.all(pushPromises);
      return;
    }

    // Supabase a des données → on écrase toujours le local avec la config distante
    const updated = { ...local };
    for (const [type, row] of Object.entries(remote)) {
      updated[type] = {
        printerId: row.printer_id,
        labelSize: { widthMM: Number(row.label_width_mm), heightMM: Number(row.label_height_mm) },
      };
    }
    localStorage.setItem(TYPE_CONFIG_KEY, JSON.stringify(updated));

    // Met à jour les clés globales si pas encore définies
    if (!getSavedPrinterId()) {
      const fallback = remote["product"] || remote["lot"] || Object.values(remote)[0];
      if (fallback?.printer_id) savePrinterId(fallback.printer_id);
    }
    if (!localStorage.getItem(LABEL_SIZE_KEY)) {
      const fallback = remote["product"] || remote["lot"] || Object.values(remote)[0];
      if (fallback) saveLabelSize({ widthMM: Number(fallback.label_width_mm), heightMM: Number(fallback.label_height_mm) });
    }
  } catch (e: any) {
    console.warn("[printnode] syncPrintConfigFromSupabase:", e.message);
  }
}

// ============================================
// ORDER BARCODE — 70x35mm ZPL (Code128)
// ============================================
/** Génère un ZPL Code128 pour une étiquette 70x35mm (203dpi) */
export function generateOrderBarcodeZPL(orderNumber: string, customerName: string = ""): string {
  const safe = (s: string) => s.replace(/[\^~]/g, "").trim();
  const W = 560; // 70mm × 8 dots/mm
  const H = 280; // 35mm × 8 dots/mm
  const lines = [
    "^XA",
    `^PW${W}`,
    `^LL${H}`,
    "^CI28",
    // Code128 barcode, human-readable below
    `^FO20,12^BY2,3,120^BCN,120,Y,N,N^FD${safe(orderNumber)}^FS`,
  ];
  const name = safe(customerName).substring(0, 28);
  if (name) lines.push(`^FO20,172^A0N,24,22^FD${name}^FS`);
  lines.push("^XZ");
  return lines.join("\n");
}

/** Imprime un code-barre de commande via PrintNode */
export async function printOrderBarcode(
  printerId: number,
  orderNumber: string,
  customerName: string = "",
  qty: number = 1
): Promise<{ success: boolean; error?: string }> {
  try {
    const zpl = generateOrderBarcodeZPL(orderNumber, customerName);
    await submitPrintJob(printerId, `Code-barre ${orderNumber}`, zpl, qty);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}
