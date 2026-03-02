// app/api/odoo/proxy/route.ts
// Proxy vers Odoo pour éviter les problèmes CORS
// Le navigateur appelle cette route, qui appelle Odoo côté serveur

import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { odooUrl, endpoint, params, sessionId } = body;

    if (!odooUrl || !endpoint) {
      return NextResponse.json(
        { error: "odooUrl et endpoint requis" },
        { status: 400 }
      );
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (sessionId) {
      headers["Cookie"] = `session_id=${sessionId}`;
    }

    const odooRes = await fetch(`${odooUrl}${endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "call",
        id: Date.now(),
        params,
      }),
    });

    const data = await odooRes.json();

    if (data.error) {
      const msg =
        data.error.data?.message || data.error.message || "Erreur Odoo";
      return NextResponse.json({ error: msg }, { status: 400 });
    }

    return NextResponse.json({ result: data.result });
  } catch (e: any) {
    console.error("Proxy Odoo error:", e);
    return NextResponse.json(
      { error: e.message || "Erreur proxy" },
      { status: 500 }
    );
  }
}
