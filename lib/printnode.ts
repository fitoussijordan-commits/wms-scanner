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
export interface PaletteLabelData {
  // Expéditeur
  senderName: string;
  senderAddress?: string;
  // Destinataire
  recipientName: string;
  recipientAddress?: string;
  // Contenu palette
  productName: string;
  ref?: string;
  lotNumber?: string;
  sscc: string;           // 18-digit Serial Shipping Container Code
  quantity: number;
  unit?: string;          // ex: "cartons", "kg", "unités"
  expiryDate?: string;    // DLUO / DLC
  weight?: string;        // ex: "250 kg"
  // Transport
  orderRef?: string;      // N° commande
  deliveryRef?: string;   // N° BL
}

export function generatePaletteZPL(data: PaletteLabelData): string {
  // Palette labels use a fixed large format: 100x150mm (A6 landscape-ish)
  // Overrides the user label size for palettes
  const W = mm(100); // 800 dots
  const H = mm(150); // 1200 dots
  const cW = W - 30;
  const lineH = 32;
  const smallH = 24;
  const sectionGap = 10;

  const lines: string[] = ["^XA", `^PW${W}`, `^LL${H}`, "^CI28"];

  // ── TOP SECTION: Expéditeur / Destinataire ──────────────────────
  let y = 12;

  // Separator line helper
  const hline = (yPos: number) =>
    `^FO10,${yPos}^GB${W - 20},2,2^FS`;

  // Header: EXPÉDITEUR
  lines.push(`^FO10,${y}^A0N,20,20^FDExpéditeur^FS`);
  y += 22;
  lines.push(`^FO10,${y}^A0N,${lineH},${lineH}^FB${Math.round(cW * 0.5)},1,0,L^FD${trunc(data.senderName, 20)}^FS`);
  if (data.senderAddress) {
    lines.push(`^FO10,${y + lineH - 2}^A0N,20,20^FB${Math.round(cW * 0.5)},1,0,L^FD${trunc(data.senderAddress, 30)}^FS`);
    y += 22;
  }
  y += lineH + 4;

  lines.push(hline(y));
  y += sectionGap + 4;

  // Header: DESTINATAIRE (larger, prominent)
  lines.push(`^FO10,${y}^A0N,20,20^FDDestinataire^FS`);
  y += 22;
  lines.push(`^FO10,${y}^A0N,38,38^FB${cW},1,0,L^FD${trunc(data.recipientName, 18)}^FS`);
  y += 40;
  if (data.recipientAddress) {
    lines.push(`^FO10,${y}^A0N,22,22^FB${cW},1,0,L^FD${trunc(data.recipientAddress, 35)}^FS`);
    y += 26;
  }

  lines.push(hline(y));
  y += sectionGap + 4;

  // ── MIDDLE SECTION: Contenu ──────────────────────────────────────
  lines.push(`^FO10,${y}^A0N,20,20^FDContenu^FS`);
  y += 22;

  // Product name (bold / larger)
  lines.push(`^FO10,${y}^A0N,30,30^FB${cW},1,0,L^FD${trunc(data.productName, 26)}^FS`);
  y += 34;

  if (data.ref) {
    lines.push(`^FO10,${y}^A0N,${smallH},${smallH}^FDRéf: ${trunc(data.ref, 20)}^FS`);
    y += smallH + 4;
  }

  // Quantity + unit on the left, lot on the right
  const qtyStr = `Qté: ${data.quantity}${data.unit ? " " + data.unit : ""}`;
  lines.push(`^FO10,${y}^A0N,${smallH},${smallH}^FD${qtyStr}^FS`);
  if (data.lotNumber) {
    lines.push(`^FO${Math.round(W / 2)},${y}^A0N,${smallH},${smallH}^FDLot: ${trunc(data.lotNumber, 14)}^FS`);
  }
  y += smallH + 4;

  if (data.expiryDate || data.weight) {
    if (data.expiryDate) {
      lines.push(`^FO10,${y}^A0N,${smallH},${smallH}^FDDLUO: ${formatDate(data.expiryDate)}^FS`);
    }
    if (data.weight) {
      lines.push(`^FO${Math.round(W / 2)},${y}^A0N,${smallH},${smallH}^FDPoids: ${data.weight}^FS`);
    }
    y += smallH + 4;
  }

  if (data.orderRef || data.deliveryRef) {
    if (data.orderRef) {
      lines.push(`^FO10,${y}^A0N,${smallH},${smallH}^FDCDE: ${trunc(data.orderRef, 14)}^FS`);
    }
    if (data.deliveryRef) {
      lines.push(`^FO${Math.round(W / 2)},${y}^A0N,${smallH},${smallH}^FDBL: ${trunc(data.deliveryRef, 14)}^FS`);
    }
    y += smallH + 4;
  }

  lines.push(hline(y + 4));
  y += sectionGap + 8;

  // ── BOTTOM SECTION: SSCC barcode (GS1-128) ──────────────────────
  lines.push(`^FO10,${y}^A0N,20,20^FDSSCC (00)^FS`);
  y += 22;

  // SSCC must be encoded as GS1-128 with AI (00) prefix
  const ssccPayload = `00${data.sscc}`;
  const bcH = Math.min(H - y - 30, 100);
  const barW = 3;
  const modules = 11 * ssccPayload.length + 35;
  const bcPixelW = modules * barW;
  const x = Math.max(10, Math.round((W - bcPixelW) / 2));

  lines.push(`^BY${barW},3,${bcH}^FO${x},${y}^BCN,${bcH},N,N,N^FD>:${ssccPayload}^FS`);
  y += bcH + 4;

  // SSCC in human-readable below barcode
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
    const cfg = getLabelTypeConfig("palette");
    const jobId = await submitPrintJob(printerId, `Palette: ${data.productName} → ${data.recipientName}`, zpl, qty, true, cfg.labelSize.widthMM, cfg.labelSize.heightMM);
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
