// app/api/odoo/report/route.ts
// Proxy binaire pour télécharger un rapport PDF Odoo + overlay date du jour
// Utilise /report/pdf/{report_name}/{record_id} — endpoint HTTP standard Odoo

import { NextRequest, NextResponse } from "next/server";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";

async function addDateOverlay(pdfBytes: ArrayBuffer): Promise<Uint8Array> {
  try {
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pages = pdfDoc.getPages();
    if (pages.length === 0) return new Uint8Array(pdfBytes);

    const page = pages[0];
    const { width } = page.getSize();

    // Date du jour au format DD/MM
    const now = new Date();
    const dateStr = now.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });

    const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontSize = 48;
    const textWidth = font.widthOfTextAtSize(dateStr, fontSize);

    // Positionné en haut à droite du logo (zone gauche, haut de page)
    // PDF coordinates: origin bottom-left
    const pageHeight = page.getSize().height;
    const x = width / 2 - textWidth / 2; // centré horizontalement
    const y = pageHeight - 90; // ~3cm du haut

    // Rectangle blanc semi-transparent derrière la date pour lisibilité
    page.drawRectangle({
      x: x - 10,
      y: y - 10,
      width: textWidth + 20,
      height: fontSize + 16,
      color: rgb(1, 1, 1),
      opacity: 0.85,
    });

    page.drawText(dateStr, {
      x,
      y,
      size: fontSize,
      font,
      color: rgb(0.08, 0.08, 0.08),
      opacity: 1,
    });

    return pdfDoc.save();
  } catch {
    // Si l'overlay échoue, retourner le PDF original
    return new Uint8Array(pdfBytes);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { odooUrl, sessionId, reportName, recordId } = await req.json();

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

    // Ajouter la date du jour en overlay sur la première page
    const pdfWithDate = await addDateOverlay(buffer);
    const base64 = Buffer.from(pdfWithDate).toString("base64");

    return NextResponse.json({ base64 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Erreur proxy rapport" }, { status: 500 });
  }
}
