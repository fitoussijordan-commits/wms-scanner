// app/api/odoo/report/route.ts
// Proxy binaire pour télécharger un rapport PDF Odoo + overlay date du jour
// Utilise /report/pdf/{report_name}/{record_id} — endpoint HTTP standard Odoo

import { NextRequest, NextResponse } from "next/server";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";

async function addDateOverlay(pdfBytes: ArrayBuffer, overlayDate?: string, overlayIndex?: number, overlayTotal?: number): Promise<Uint8Array> {
  try {
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pages = pdfDoc.getPages();
    if (pages.length === 0) return new Uint8Array(pdfBytes);

    const page = pages[0];
    const { width, height } = page.getSize();

    // Date du BL au format DD/MM
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

    // -- Date en gros au centre --
    const dateFontSize = 48;
    const dateWidth = font.widthOfTextAtSize(dateStr, dateFontSize);
    const dateX = width / 2 - dateWidth / 2;
    const dateY = height - 90;

    // Fond blanc derrière la date
    const boxW = dateWidth + (overlayTotal && overlayTotal > 1 ? 120 : 20);
    const boxX = width / 2 - boxW / 2;
    page.drawRectangle({
      x: boxX,
      y: dateY - 10,
      width: boxW,
      height: dateFontSize + 16,
      color: rgb(1, 1, 1),
      opacity: 0.9,
    });

    page.drawText(dateStr, {
      x: dateX,
      y: dateY,
      size: dateFontSize,
      font,
      color: rgb(0.08, 0.08, 0.08),
    });

    // -- Numéro de position (ex: 2/3) si groupe --
    if (overlayIndex !== undefined && overlayTotal !== undefined && overlayTotal > 1) {
      const posStr = `${overlayIndex}/${overlayTotal}`;
      const posFontSize = 36;
      const posWidth = font.widthOfTextAtSize(posStr, posFontSize);
      const posX = dateX + dateWidth + 12;
      const posY = dateY + (dateFontSize - posFontSize) / 2;

      page.drawText(posStr, {
        x: posX,
        y: posY,
        size: posFontSize,
        font,
        color: rgb(0.15, 0.45, 0.9), // bleu
      });
    }

    return pdfDoc.save();
  } catch {
    return new Uint8Array(pdfBytes);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { odooUrl, sessionId, reportName, recordId, overlayDate, overlayIndex, overlayTotal } = await req.json();

    if (!odooUrl || !reportName || !recordId) {
      return NextResponse.json({ error: "odooUrl, reportName et recordId requis" }, { status: 400 });
    }

    const url = `${odooUrl.replace(/\/$/, "")}/report/pdf/${reportName}/${recordId}`;

    const headers: Record<string, string> = {};
    if (sessionId) headers["Cookie"] = `session_id=${sessionId}`;

    const res = await fetch(url, { method: "GET", headers });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `Odoo rapport ${res.status}: ${text.substring(0, 200)}` },
        { status: res.status }
      );
    }

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("pdf") && !contentType.includes("octet-stream")) {
      return NextResponse.json(
        { error: `Réponse inattendue d'Odoo (pas un PDF). Content-Type: ${contentType}` },
        { status: 400 }
      );
    }

    const buffer = await res.arrayBuffer();

    // Ajouter la date du BL + numéro de position en overlay sur la première page
    const pdfWithDate = await addDateOverlay(buffer, overlayDate, overlayIndex, overlayTotal);
    const base64 = Buffer.from(pdfWithDate).toString("base64");

    return NextResponse.json({ base64 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Erreur proxy rapport" }, { status: 500 });
  }
}
