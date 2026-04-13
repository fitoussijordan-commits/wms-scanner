// app/api/odoo/report/route.ts
// Proxy binaire pour télécharger un rapport PDF Odoo
// Utilise /report/pdf/{report_name}/{record_id} — endpoint HTTP standard Odoo

import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const { odooUrl, sessionId, reportName, recordId } = await req.json();

    if (!odooUrl || !reportName || !recordId) {
      return NextResponse.json({ error: "odooUrl, reportName et recordId requis" }, { status: 400 });
    }

    const url = `${odooUrl.replace(/\/$/, "")}/report/pdf/${reportName}/${recordId}`;

    const headers: Record<string, string> = {};
    if (sessionId) {
      headers["Cookie"] = `session_id=${sessionId}`;
    }

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
      // Odoo a retourné du HTML (probablement une erreur ou page de login)
      const text = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `Réponse inattendue d'Odoo (pas un PDF). Content-Type: ${contentType}` },
        { status: 400 }
      );
    }

    const buffer = await res.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");

    return NextResponse.json({ base64 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Erreur proxy rapport" }, { status: 500 });
  }
}
