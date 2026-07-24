// app/api/printnode/route.ts — Server-side proxy for PrintNode API
import { NextRequest, NextResponse } from "next/server";
import { fetchT } from "@/lib/fetchTimeout";
const API_URL = "https://api.printnode.com";

function getApiKey(): string {
  const key = process.env.PRINTNODE_API_KEY || "";
  if (!key) return "";
  return key;
}

function pnHeaders() {
  return {
    "Authorization": "Basic " + Buffer.from(getApiKey() + ":").toString("base64"),
    "Content-Type": "application/json",
  };
}

async function zplToPdfBase64(zpl: string, widthMM: number = 100, heightMM: number = 150): Promise<string> {
  const widthIn = (widthMM / 25.4).toFixed(3);
  const heightIn = (heightMM / 25.4).toFixed(3);
  // Sans index de page → retourne toutes les étiquettes en PDF multi-pages
  const url = `https://api.labelary.com/v1/printers/8dpmm/labels/${widthIn}x${heightIn}/`;
  const res = await fetchT(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/pdf" },
    body: zpl,
  });
  if (!res.ok) throw new Error(`Labelary error ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer()).toString("base64");
}

export async function GET(req: NextRequest) {
  const apiKey = getApiKey();
  if (!apiKey) return NextResponse.json({ error: "PRINTNODE_API_KEY non configurée" }, { status: 500 });
  const action = new URL(req.url).searchParams.get("action");
  try {
    if (action === "printers") {
      const res = await fetchT(`${API_URL}/printers`, { headers: pnHeaders() });
      if (!res.ok) return NextResponse.json({ error: `PrintNode ${res.status}` }, { status: res.status });
      return NextResponse.json(await res.json());
    }
    return NextResponse.json({ error: "Action inconnue" }, { status: 400 });
  } catch (e: any) { return NextResponse.json({ error: e.message }, { status: 500 }); }
}

export async function POST(req: NextRequest) {
  const apiKey = getApiKey();
  if (!apiKey) return NextResponse.json({ error: "PRINTNODE_API_KEY non configurée" }, { status: 500 });
  try {
    const body = await req.json();
    const { action } = body;

    if (action === "print") {
      const { printerId, title, content, source, usePdf, labelWidthMM, labelHeightMM, contentType: reqContentType, qty } = body;

      let finalContent = content;
      let contentType = "raw_base64";

      if (reqContentType === "pdf_base64") {
        finalContent = content;
        contentType = "pdf_base64";
      } else if (usePdf) {
        const zpl = Buffer.from(content, "base64").toString("latin1");
        finalContent = await zplToPdfBase64(zpl, labelWidthMM || 100, labelHeightMM || 150);
        contentType = "pdf_base64";
      }

      // Nombre de copies : PrintNode l'accepte via le champ "options.copies".
      // Sans ça, un template PDF ne sortait qu'en 1 exemplaire quelle que soit
      // la quantité demandée.
      const copies = Math.max(1, Math.round(Number(qty) || 1));

      const res = await fetchT(`${API_URL}/printjobs`, {
        method: "POST",
        headers: pnHeaders(),
        body: JSON.stringify({
          printerId, title, contentType,
          content: finalContent,
          source: source || "WMS Scanner",
          ...(copies > 1 ? { options: { copies } } : {}),
        }),
      });

      if (!res.ok) return NextResponse.json({ error: `PrintNode: ${await res.text()}` }, { status: res.status });
      return NextResponse.json({ jobId: await res.json() });
    }

    return NextResponse.json({ error: "Action inconnue" }, { status: 400 });
  } catch (e: any) { return NextResponse.json({ error: e.message }, { status: 500 }); }
}
