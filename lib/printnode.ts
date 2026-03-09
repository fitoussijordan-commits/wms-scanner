// lib/printnode.ts — Client-side PrintNode helper
// All API calls go through /api/printnode (server-side proxy)
// API key is NEVER exposed to the browser

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
async function submitPrintJob(printerId: number, title: string, zpl: string, qty: number = 1, usePdf: boolean = false, labelWidthMM?: number, labelHeightMM?: number): Promise<number> {
  const fullZpl = qty > 1 ? Array(qty).fill(zpl).join("\n") : zpl;
  console.log("[submitPrintJob] usePdf:", usePdf, "w:", labelWidthMM, "h:", labelHeightMM, "zplLen:", fullZpl.length);
  const res = await fetch("/api/printnode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "print",
      printerId,
      title,
      content: btoa(fullZpl),
      source: "WMS Scanner",
      usePdf,
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
  // Repeat PDF for multiple copies by sending qty in the job
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
export function generateProductZPL(productName: string, barcode: string, ref?: string): string {
  const sz = getLabelSize();
  const W = mm(sz.widthMM);
  const H = mm(sz.heightMM);
  const cW = W - 20;
  const cpl = Math.floor(cW / 13);
  const barW = sz.widthMM >= 60 ? 3 : 2;
  const bcH = Math.min(Math.round(H * 0.40), 130);
  const hasRef = !!ref;

  const refBlock = hasRef ? 26 : 0;
  const nameBlock = 30;
  const bcBlock = bcH + 24;
  const total = refBlock + nameBlock + bcBlock;
  const startY = Math.max(8, Math.round((H - total) / 2));

  let y = startY;
  const lines: string[] = ["^XA", `^PW${W}`, `^LL${H}`, "^CI28"];

  if (hasRef) {
    lines.push(`^FO10,${y}^A0N,20,20^FB${cW},1,0,C^FD${trunc(ref!, cpl)}^FS`);
    y += 26;
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
export function generateLotZPL(lotName: string, productName: string, lotBarcode: string, expiryDate?: string): string {
  const sz = getLabelSize();
  const W = mm(sz.widthMM);
  const H = mm(sz.heightMM);
  const cW = W - 20;
  const cpl = Math.floor(cW / 13);
  const barW = sz.widthMM >= 60 ? 3 : 2;
  const bcH = Math.min(Math.round(H * 0.33), 110);
  const expStr = expiryDate ? formatDate(expiryDate) : "";

  const lotBlock = 36;
  const nameBlock = 26;
  const expBlock = expStr ? 24 : 0;
  const bcBlock = bcH + 22;
  const total = lotBlock + nameBlock + expBlock + bcBlock;
  const startY = Math.max(6, Math.round((H - total) / 2));

  let y = startY;
  const lines: string[] = ["^XA", `^PW${W}`, `^LL${H}`, "^CI28"];

  lines.push(`^FO10,${y}^A0N,30,30^FB${cW},1,0,C^FD${trunc(lotName, cpl)}^FS`);
  y += lotBlock;
  lines.push(`^FO10,${y}^A0N,22,22^FB${cW},1,0,C^FD${trunc(productName, cpl)}^FS`);
  y += nameBlock;

  if (expStr) {
    lines.push(`^FO10,${y}^A0N,22,22^FB${cW},1,0,C^FDDLUO: ${expStr}^FS`);
    y += expBlock;
  }

  lines.push(barcodeZPL(lotBarcode, W, y, bcH, barW));
  lines.push("^XZ");

  return lines.join("\n");
}

// ============================================
// LOCATION LABEL
// ============================================
export function generateLocationZPL(locationName: string, locationBarcode: string): string {
  const sz = getLabelSize();
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

  lines.push(`^FO10,${y}^A0N,40,40^FB${cW},1,0,C^FD${locationName}^FS`);
  y += nameBlock;

  if (locationBarcode) {
    lines.push(barcodeZPL(locationBarcode, W, y, bcH, barW));
  }
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

  // ── NUMÉRO PALETTE ──
  if (data.paletteNumber !== undefined) {
    lines.push(`^FO${W - 110},8^A0N,70,70^FD P${data.paletteNumber}^FS`);
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
    const zpl = generateProductZPL(productName, barcode, ref);
    const jobId = await submitPrintJob(printerId, `Produit: ${productName}`, zpl, qty);
    return { success: true, jobId };
  } catch (e: any) { return { success: false, error: e.message }; }
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
    // Always use 100x150mm for palette labels
    const W = 100, H = 150;
    console.log("[printPaletteLabel] zpl length:", zpl.length, "printer:", printerId, "size:", W+"x"+H);
    console.log("[printPaletteLabel] ZPL preview:", zpl.substring(0, 200));
    const jobId = await submitPrintJob(printerId, `Palette: ${data.recipientName || "dest"}`, zpl, qty, true, W, H);
    return { success: true, jobId };
  } catch (e: any) {
    console.error("[printPaletteLabel] error:", e.message);
    return { success: false, error: e.message };
  }
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
export type LabelType = "product" | "lot" | "location" | "palette" | "blank" | "picking";

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
    all[type] = { ...getLabelTypeConfig(type), ...config };
    localStorage.setItem(TYPE_CONFIG_KEY, JSON.stringify(all));
  } catch {}
}

export function getAllLabelTypeConfigs(): Record<LabelType, LabelTypeConfig> {
  const types: LabelType[] = ["product", "lot", "location", "palette", "blank", "picking"];
  const result = {} as Record<LabelType, LabelTypeConfig>;
  for (const t of types) result[t] = getLabelTypeConfig(t);
  return result;
}
