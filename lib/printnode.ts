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
// ZPL LABEL GENERATION
// ============================================

export function generateZPL(productName: string, barcode: string): string {
  // Truncate name to fit label (~30 chars per line on 50mm)
  const name1 = productName.substring(0, 32);
  const name2 = productName.length > 32 ? productName.substring(32, 64) : "";

  // Determine barcode type
  const isEAN13 = /^\d{13}$/.test(barcode);
  const isEAN8 = /^\d{8}$/.test(barcode);

  let barcodeZPL: string;
  if (isEAN13) {
    barcodeZPL = `^BY2,2,60^FO30,95^BE,60,Y,N^FD${barcode}^FS`;
  } else if (isEAN8) {
    barcodeZPL = `^BY2,2,60^FO60,95^B8,60,Y,N^FD${barcode}^FS`;
  } else {
    // Code 128 for non-EAN
    barcodeZPL = `^BY2,2,60^FO20,95^BC,60,Y,N,N^FD${barcode}^FS`;
  }

  return [
    "^XA",
    // Label size: 50mm x 30mm ≈ 400x240 dots at 203dpi
    "^PW400",
    "^LL240",
    // Product name line 1 — centered
    `^FO10,15^A0N,22,22^FB380,1,0,C^FD${name1}^FS`,
    // Product name line 2 (if overflow)
    name2 ? `^FO10,42^A0N,20,20^FB380,1,0,C^FD${name2}^FS` : "",
    // Barcode
    barcodeZPL,
    "^XZ",
  ].filter(Boolean).join("\n");
}

// ============================================
// PRINT LABEL VIA ZPL (preferred)
// ============================================

export async function printLabelZPL(
  printerId: number,
  productName: string,
  barcode: string
): Promise<number> {
  const zpl = generateZPL(productName, barcode);
  const base64 = btoa(zpl);

  return submitPrintJob({
    printerId,
    title: `Étiquette: ${productName}`,
    content: base64,
    contentType: "raw_base64",
  });
}

// ============================================
// PRINT LABEL VIA PDF (fallback)
// ============================================

export async function printLabelPDF(
  printerId: number,
  productName: string,
  barcode: string
): Promise<number> {
  // Generate a minimal PDF with barcode using HTML-to-canvas approach
  // We'll create an HTML string rendered to PDF via a hidden canvas
  // For simplicity, send raw ZPL — PDF generation in browser is heavy
  // If ZPL fails, this serves as documentation for future PDF impl
  throw new Error("PDF fallback: utilise printLabelZPL à la place. Pour du PDF, passer par un endpoint serveur.");
}

// ============================================
// HIGH-LEVEL: Print with ZPL, fallback graceful
// ============================================

export async function printLabel(
  printerId: number,
  productName: string,
  barcode: string
): Promise<{ success: boolean; jobId?: number; error?: string }> {
  try {
    const jobId = await printLabelZPL(printerId, productName, barcode);
    return { success: true, jobId };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ============================================
// CONFIG persistence
// ============================================

const PRINTER_KEY = "wms_printer_id";

export function getSavedPrinterId(): number | null {
  try {
    const v = localStorage.getItem(PRINTER_KEY);
    return v ? parseInt(v, 10) : null;
  } catch { return null; }
}

export function savePrinterId(id: number) {
  try { localStorage.setItem(PRINTER_KEY, String(id)); } catch {}
}

export function isConfigured(): boolean {
  return !!process.env.NEXT_PUBLIC_PRINTNODE_API_KEY && !!getSavedPrinterId();
}
