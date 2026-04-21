// app/api/odoo/print-bl/route.ts
// Pipeline serveur direct : Odoo PDF → overlay → PrintNode
// Évite le round-trip navigateur avec un gros PDF base64.
// Trajet : Odoo → Next.js → PrintNode (le navigateur ne touche pas le PDF)

import { NextRequest, NextResponse } from "next/server";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";

const PRINTNODE_API_URL = "https://api.printnode.com";

function pnHeaders() {
  const key = process.env.PRINTNODE_API_KEY || "";
  return {
    "Authorization": "Basic " + Buffer.from(key + ":").toString("base64"),
    "Content-Type": "application/json",
  };
}

async function addDateOverlay(
  pdfBytes: ArrayBuffer,
  overlayDate?: string,
  overlayIndex?: number,
  overlayTotal?: number
): Promise<Uint8Array> {
  try {
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pages = pdfDoc.getPages();
    if (pages.length === 0) return new Uint8Array(pdfBytes);

    const page = pages[0];
    const { width, height } = page.getSize();

    let dateStr: string;
    if (overlayDate) {
      const d = new Date(overlayDate);
      dateStr = isNaN(d.getTime())
        ? overlayDate.substring(0, 5)
        : d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
    } else {
      dateStr = new Date().toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
    }

    const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const dateFontSize = 48;
    const dateWidth = font.widthOfTextAtSize(dateStr, dateFontSize);
    const dateX = width / 2 - dateWidth / 2;
    const dateY = height - 90;

    const boxW = dateWidth + (overlayTotal && overlayTotal > 1 ? 120 : 20);
    const boxX = width / 2 - boxW / 2;
    page.drawRectangle({
      x: boxX, y: dateY - 10,
      width: boxW, height: dateFontSize + 16,
      color: rgb(1, 1, 1), opacity: 0.9,
    });
    page.drawText(dateStr, { x: dateX, y: dateY, size: dateFontSize, font, color: rgb(0.08, 0.08, 0.08) });

    if (overlayIndex !== undefined && overlayTotal !== undefined && overlayTotal > 1) {
      const posStr = `${overlayIndex}/${overlayTotal}`;
      const posFontSize = 36;
      const posWidth = font.widthOfTextAtSize(posStr, posFontSize);
      const posX = dateX + dateWidth + 12;
      const posY = dateY + (dateFontSize - posFontSize) / 2;
      page.drawText(posStr, { x: posX, y: posY, size: posFontSize, font, color: rgb(0.15, 0.45, 0.9) });
    }

    return pdfDoc.save();
  } catch {
    return new Uint8Array(pdfBytes);
  }
}

export async function POST(req: NextRequest) {
  try {
    const {
      odooUrl, sessionId, reportName, recordId,
      printerId, title,
      overlayDate, overlayIndex, overlayTotal,
    } = await req.json();

    if (!odooUrl || !reportName || !recordId || !printerId) {
      return NextResponse.json({ error: "odooUrl, reportName, recordId et printerId requis" }, { status: 400 });
    }

    // ── 1. Télécharger le PDF depuis Odoo ──────────────────────────────
    const pdfUrl = `${odooUrl.replace(/\/$/, "")}/report/pdf/${reportName}/${recordId}`;
    const headers: Record<string, string> = {};
    if (sessionId) headers["Cookie"] = `session_id=${sessionId}`;

    const pdfRes = await fetch(pdfUrl, { method: "GET", headers });
    if (!pdfRes.ok) {
      const text = await pdfRes.text().catch(() => "");
      return NextResponse.json({ error: `Odoo PDF ${pdfRes.status}: ${text.substring(0, 200)}` }, { status: pdfRes.status });
    }

    const contentType = pdfRes.headers.get("content-type") || "";
    if (!contentType.includes("pdf") && !contentType.includes("octet-stream")) {
      return NextResponse.json({ error: `Réponse Odoo inattendue: ${contentType}` }, { status: 400 });
    }

    // ── 2. Ajouter l'overlay date ──────────────────────────────────────
    const pdfBuffer = await pdfRes.arrayBuffer();
    const pdfWithOverlay = await addDateOverlay(pdfBuffer, overlayDate, overlayIndex, overlayTotal);
    const pdfBase64 = Buffer.from(pdfWithOverlay).toString("base64");

    // ── 3. Envoyer directement à PrintNode ────────────────────────────
    const pnRes = await fetch(`${PRINTNODE_API_URL}/printjobs`, {
      method: "POST",
      headers: pnHeaders(),
      body: JSON.stringify({
        printerId,
        title: title || `Bon_${recordId}.pdf`,
        contentType: "pdf_base64",
        content: pdfBase64,
        source: "WMS Scanner",
      }),
    });

    if (!pnRes.ok) {
      const err = await pnRes.text().catch(() => "");
      return NextResponse.json({ error: `PrintNode: ${err}` }, { status: pnRes.status });
    }

    const jobId = await pnRes.json();
    return NextResponse.json({ success: true, jobId });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Erreur print-bl" }, { status: 500 });
  }
}
