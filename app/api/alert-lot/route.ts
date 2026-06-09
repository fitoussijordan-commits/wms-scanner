// app/api/alert-lot/route.ts
// Envoie un email d'alerte via le serveur mail Odoo quand un opérateur
// scanne un lot différent de celui réservé sur un bon de préparation.

import { NextRequest, NextResponse } from "next/server";
import { fetchT } from "@/lib/fetchTimeout";
import { checkRateLimit, getClientIp } from "@/lib/rateLimiter";

const ODOO_URL  = process.env.ODOO_URL   || "";
const ODOO_DB   = process.env.ODOO_DB    || "";
const ODOO_USER = process.env.ODOO_LOGIN || "";
const ODOO_PASS = process.env.ODOO_PASSWORD || "";
const ALERT_EMAIL = process.env.ALERT_EMAIL || ""; // email destinataire

async function odooRpc(endpoint: string, params: any, sessionId?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (sessionId) headers["Cookie"] = `session_id=${sessionId}`;
  const res = await fetchT(`${ODOO_URL.replace(/\/$/, "")}${endpoint}`, {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: Date.now(), params }),
  }, 10_000);
  const json = await res.json();
  if (json.error) throw new Error(json.error.data?.message || json.error.message);
  return json.result;
}

async function odooAuth(): Promise<string> {
  const res = await fetchT(`${ODOO_URL.replace(/\/$/, "")}/web/session/authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", method: "call", id: 1,
      params: { db: ODOO_DB, login: ODOO_USER, password: ODOO_PASS },
    }),
  }, 10_000);
  const json = await res.json();
  if (!json.result?.uid) throw new Error("Auth Odoo échouée");
  const cookie = res.headers.get("set-cookie") || "";
  return cookie.match(/session_id=([^;]+)/)?.[1] || json.result.session_id || "";
}

export async function POST(req: NextRequest) {
  // Rate limit : max 20 alertes / minute (évite les spams en cas de bug)
  const rl = checkRateLimit(`alert:${getClientIp(req)}`, 20, 60_000);
  if (!rl.allowed) return NextResponse.json({ ok: false }, { status: 429 });

  if (!ODOO_URL || !ALERT_EMAIL) {
    console.error("[alert-lot] config manquante", { hasOdooUrl: !!ODOO_URL, hasAlertEmail: !!ALERT_EMAIL });
    return NextResponse.json({ ok: false, error: "ODOO_URL ou ALERT_EMAIL non configuré" }, { status: 500 });
  }

  const { pickingName, productName, productCode, expectedLot, scannedLot, operatorName } = await req.json();

  const subject = `⚠️ WMS — Lot substitué sur ${pickingName}`;
  const bodyHtml = `
    <div style="font-family: sans-serif; max-width: 500px;">
      <h2 style="color: #dc2626;">⚠️ Substitution de lot détectée</h2>
      <table style="border-collapse: collapse; width: 100%;">
        <tr><td style="padding: 8px; font-weight: bold; color: #6b7280;">Bon de prépa</td><td style="padding: 8px;">${pickingName}</td></tr>
        <tr style="background: #f9fafb;"><td style="padding: 8px; font-weight: bold; color: #6b7280;">Opérateur</td><td style="padding: 8px;">${operatorName || "—"}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold; color: #6b7280;">Produit</td><td style="padding: 8px;">${productCode ? `[${productCode}] ` : ""}${productName}</td></tr>
        <tr style="background: #fef2f2;"><td style="padding: 8px; font-weight: bold; color: #dc2626;">Lot attendu</td><td style="padding: 8px; color: #dc2626; font-weight: bold;">${expectedLot || "—"}</td></tr>
        <tr style="background: #fef2f2;"><td style="padding: 8px; font-weight: bold; color: #dc2626;">Lot scanné</td><td style="padding: 8px; color: #dc2626; font-weight: bold;">${scannedLot || "—"}</td></tr>
      </table>
      <p style="color: #6b7280; font-size: 12px; margin-top: 16px;">Alerte automatique — WMS Dr. Hauschka</p>
    </div>
  `;

  try {
    const sid = await odooAuth();

    // Créer + envoyer un mail.mail directement via Odoo
    const mailId = await odooRpc("/web/dataset/call_kw", {
      model: "mail.mail", method: "create",
      args: [{
        subject,
        body_html: bodyHtml,
        email_to: ALERT_EMAIL,
        state: "outgoing",
        auto_delete: true,
      }],
      kwargs: {},
    }, sid);

    await odooRpc("/web/dataset/call_kw", {
      model: "mail.mail", method: "send",
      args: [[mailId]],
      kwargs: {},
    }, sid);

    return NextResponse.json({ ok: true, mailId });
  } catch (e: any) {
    console.error("[alert-lot]", e.message);
    // On ne bloque pas l'UI si l'alerte échoue
    return NextResponse.json({ ok: false, error: "Erreur envoi" }, { status: 500 });
  }
}
