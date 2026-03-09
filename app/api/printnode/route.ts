// app/api/printnode/route.ts — Server-side proxy for PrintNode API
// API key stays server-side, never exposed to the browser
import { NextRequest, NextResponse } from "next/server";
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

/**
 * Convert ZPL to PDF via Labelary API
 * widthIn / heightIn in inches (e.g. 100mm = 3.937in, 150mm = 5.906in)
 */
async function zplToPdfBase64(zpl: string, widthMM: number = 100, heightMM: number = 150): Promise<string> {
  const widthIn = (widthMM / 25.4).toFixed(3);
  const heightIn = (heightMM / 25.4).toFixed(3);
  // Labelary: 8dpmm = 203dpi, 12dpmm = 300dpi
  const dpmm = "8dpmm";
  const url = `https://api.labelary.com/v1/printers/${dpmm}/labels/${widthIn}x${heightIn}/0/`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/pdf",
    },
    body: zpl,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Labelary error ${res.status}: ${errText}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const pdfBytes = Buffer.from(arrayBuffer);
  return pdfBytes.toString("base64");
}

export async function GET(req: NextRequest) {
  const apiKey = getApiKey();
  if (!apiKey) return NextResponse.json({ error: "PRINTNODE_API_KEY non configurée" }, { status: 500 });

  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");

  try {
    if (action === "printers") {
      const res = await fetch(`${API_URL}/printers`, { headers: pnHeaders() });
      if (!res.ok) return NextResponse.json({ error: `PrintNode ${res.status}` }, { status: res.status });
      const data = await res.json();
      return NextResponse.json(data);
    }
    return NextResponse.json({ error: "Action inconnue" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
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
        // Direct PDF from client (jsPDF) — no conversion needed
        finalContent = content;
        contentType = "pdf_base64";
      } else if (usePdf) {
        // ZPL → PDF via Labelary (legacy palette path)
        const zpl = Buffer.from(content, "base64").toString("utf-8");
        finalContent = await zplToPdfBase64(zpl, labelWidthMM || 100, labelHeightMM || 150);
        contentType = "pdf_base64";
      }

      const res = await fetch(`${API_URL}/printjobs`, {
        method: "POST",
        headers: pnHeaders(),
        body: JSON.stringify({
          printerId,
          title,
          contentType,
          content: finalContent,
          source: source || "WMS Scanner",
          ...(qty && qty > 1 ? { qty } : {}),
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        return NextResponse.json({ error: `PrintNode: ${errText}` }, { status: res.status });
      }

      const jobId = await res.json();
      return NextResponse.json({ jobId });
    }

    return NextResponse.json({ error: "Action inconnue" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
