// lib/printnode.ts

const API_URL = "https://api.printnode.com";

function getApiKey(): string {
  const key = process.env.NEXT_PUBLIC_PRINTNODE_API_KEY || "";
  if (!key) throw new Error("NEXT_PUBLIC_PRINTNODE_API_KEY non configurée");
  return key;
}

function headers() {
  return {
    "Authorization": "Basic " + btoa(getApiKey() + ":"),
    "Content-Type": "application/json",
  };
}

// ============================================
// LABEL SIZE CONFIG
// ============================================
export interface LabelSize { widthMM: number; heightMM: number; }

const LABEL_SIZE_KEY = "wms_label_size";
const DEFAULT_SIZE: LabelSize = { widthMM: 70, heightMM: 45 };

export function getLabelSize(): LabelSize {
  try {
    const v = localStorage.getItem(LABEL_SIZE_KEY);
    return v ? JSON.parse(v) : DEFAULT_SIZE;
  } catch { return DEFAULT_SIZE; }
}

export function saveLabelSize(size: LabelSize) {
  try { localStorage.setItem(LABEL_SIZE_KEY, JSON.stringify(size)); } catch {}
}

// Convert mm to dots (203 dpi: 1mm ≈ 8 dots)
function mmToDots(mm: number): number { return Math.round(mm * 8); }

// ============================================
// PRINTER MANAGEMENT
// ============================================
export interface PrintNodePrinter {
  id: number;
  name: string;
  description: string;
  state: string;
  computer: { id: number; name: string };
}

export async function listPrinters(): Promise<PrintNodePrinter[]> {
  const res = await fetch(`${API_URL}/printers`, { headers: headers() });
  if (!res.ok) throw new Error(`PrintNode erreur ${res.status}`);
  const data = await res.json();
  return data.map((p: any) => ({
    id: p.id,
    name: p.name,
    description: p.description || "",
    state: p.state,
    computer: { id: p.computer?.id, name: p.computer?.name },
  }));
}

// ============================================
// PRINT JOB
// ============================================
interface PrintJobOptions {
  printerId: number;
  title: string;
  content: string;
  contentType: "raw_base64" | "pdf_base64";
}

async function submitPrintJob(opts: PrintJobOptions): Promise<number> {
  const res = await fetch(`${API_URL}/printjobs`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      printerId: opts.printerId,
      title: opts.title,
      contentType: opts.contentType,
      content: opts.content,
      source: "WMS Scanner",
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`PrintNode erreur: ${err}`);
  }
  return await res.json();
}

// ============================================
// ZPL HELPERS
// ============================================
function truncate(s: string, max: number): string {
  return s.length > max ? s.substring(0, max - 1) : s;
}

function barcodeZPL(barcode: string, x: number, y: number, height: number): string {
  const isEAN13 = /^\d{13}$/.test(barcode);
  const isEAN8 = /^\d{8}$/.test(barcode);
  if (isEAN13) return `^BY2,2,${height}^FO${x},${y}^BE,${height},Y,N^FD${barcode}^FS`;
  if (isEAN8) return `^BY2,2,${height}^FO${x},${y}^B8,${height},Y,N^FD${barcode}^FS`;
  return `^BY2,2,${height}^FO${x},${y}^BC,${height},Y,N,N^FD${barcode}^FS`;
}

// ============================================
// ZPL TEMPLATES
// ============================================

// PRODUCT: name + EAN barcode
export function generateProductZPL(productName: string, barcode: string): string {
  const sz = getLabelSize();
  const W = mmToDots(sz.widthMM);
  const H = mmToDots(sz.heightMM);
  const cW = W - 20;
  const cpl = Math.floor(cW / 12);
  const name1 = truncate(productName, cpl);
  const name2 = productName.length > cpl ? truncate(productName.substring(cpl), cpl) : "";
  const fs = sz.widthMM >= 60 ? 28 : 22;
  const bcH = Math.min(80, H - 140);
  const bcY = name2 ? 70 : 55;

  return [
    "^XA", `^PW${W}`, `^LL${H}`,
    `^FO10,15^A0N,${fs},${fs}^FB${cW},1,0,C^FD${name1}^FS`,
    name2 ? `^FO10,${15 + fs + 4}^A0N,${fs - 4},${fs - 4}^FB${cW},1,0,C^FD${name2}^FS` : "",
    barcodeZPL(barcode, 30, bcY, bcH),
    "^XZ",
  ].filter(Boolean).join("\n");
}

// LOT: lot name (big) + product name + barcode
export function generateLotZPL(lotName: string, productName: string, lotBarcode: string): string {
  const sz = getLabelSize();
  const W = mmToDots(sz.widthMM);
  const H = mmToDots(sz.heightMM);
  const cW = W - 20;
  const cpl = Math.floor(cW / 12);
  const fs = sz.widthMM >= 60 ? 24 : 20;
  const bcH = Math.min(70, H - 170);
  const prodY = 58;
  const bcY = prodY + fs * 2 + 12;

  return [
    "^XA", `^PW${W}`, `^LL${H}`,
    `^FO10,12^A0N,32,32^FB${cW},1,0,C^FD${truncate(lotName, cpl)}^FS`,
    `^FO20,48^GB${cW - 20},1,1^FS`,
    `^FO10,${prodY}^A0N,${fs},${fs}^FB${cW},2,0,C^FD${truncate(productName, cpl * 2)}^FS`,
    lotBarcode ? barcodeZPL(lotBarcode, 30, bcY, bcH) : "",
    "^XZ",
  ].filter(Boolean).join("\n");
}

// LOCATION: name (large) + barcode
export function generateLocationZPL(locationName: string, locationBarcode: string): string {
  const sz = getLabelSize();
  const W = mmToDots(sz.widthMM);
  const H = mmToDots(sz.heightMM);
  const cW = W - 20;
  const fs = sz.widthMM >= 60 ? 40 : 32;
  const bcH = Math.min(90, H - 120);

  return [
    "^XA", `^PW${W}`, `^LL${H}`,
    `^FO10,15^A0N,${fs},${fs}^FB${cW},1,0,C^FD${locationName}^FS`,
    locationBarcode ? barcodeZPL(locationBarcode, 30, 15 + fs + 20, bcH) : "",
    "^XZ",
  ].filter(Boolean).join("\n");
}

// ============================================
// PRINT FUNCTIONS
// ============================================
export async function printProductLabel(
  printerId: number, productName: string, barcode: string
): Promise<{ success: boolean; jobId?: number; error?: string }> {
  try {
    const zpl = generateProductZPL(productName, barcode);
    const jobId = await submitPrintJob({ printerId, title: `Produit: ${productName}`, content: btoa(zpl), contentType: "raw_base64" });
    return { success: true, jobId };
  } catch (e: any) { return { success: false, error: e.message }; }
}

export async function printLotLabel(
  printerId: number, lotName: string, productName: string, lotBarcode: string
): Promise<{ success: boolean; jobId?: number; error?: string }> {
  try {
    const zpl = generateLotZPL(lotName, productName, lotBarcode);
    const jobId = await submitPrintJob({ printerId, title: `Lot: ${lotName}`, content: btoa(zpl), contentType: "raw_base64" });
    return { success: true, jobId };
  } catch (e: any) { return { success: false, error: e.message }; }
}

export async function printLocationLabel(
  printerId: number, locationName: string, locationBarcode: string
): Promise<{ success: boolean; jobId?: number; error?: string }> {
  try {
    const zpl = generateLocationZPL(locationName, locationBarcode);
    const jobId = await submitPrintJob({ printerId, title: `Empl: ${locationName}`, content: btoa(zpl), contentType: "raw_base64" });
    return { success: true, jobId };
  } catch (e: any) { return { success: false, error: e.message }; }
}

// Legacy
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
  return !!process.env.NEXT_PUBLIC_PRINTNODE_API_KEY && !!getSavedPrinterId();
}
