// app/api/lg-thinq/route.ts — Climatisation LG ThinQ (lecture + commande)
//
// L'API ThinQ passe par le cloud de LG : la clim est donc pilotable depuis
// n'importe où, sans être sur le réseau de l'entrepôt. Elle doit simplement être
// connectée à Internet.
//
// Le jeton personnel reste EXCLUSIVEMENT côté serveur, comme les identifiants
// Shopware : il ne transite jamais par le navigateur.
//
// Le jeton personnel (PAT) s'obtient sur https://connect-pat.lgthinq.com/ en se
// connectant avec le compte LG ThinQ auquel la clim est rattachée. Ce n'est PAS
// le portail thinq.developer.lge.com, qui est réservé aux partenaires
// industriels de LG (contrat, service_id/service_key délivrés par un
// commercial) et inutile pour un usage personnel.
//
// Variables d'environnement :
//   LG_THINQ_PAT        jeton personnel (obligatoire)
//   LG_THINQ_COUNTRY    code pays, ex. FR (obligatoire)
//   LG_THINQ_REGION     eu | us | kic  (défaut : eu)
//   LG_THINQ_API_KEY    clé publique du portail développeur
//   LG_THINQ_CLIENT_ID  identifiant client libre (un UUID stable suffit)
import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "@/lib/rateLimiter";

export const dynamic = "force-dynamic";

function cfg() {
  return {
    pat: process.env.LG_THINQ_PAT || "",
    country: process.env.LG_THINQ_COUNTRY || "FR",
    region: process.env.LG_THINQ_REGION || "eu",
    apiKey: process.env.LG_THINQ_API_KEY || "",
    clientId: process.env.LG_THINQ_CLIENT_ID || "",
  };
}

/**
 * Identifiant de message unique exigé par ThinQ.
 * Format attendu : base64url sans remplissage, environ 22 caractères.
 */
function messageId(): string {
  const uuid = crypto.randomUUID().replace(/-/g, "");
  return Buffer.from(uuid, "hex").toString("base64url");
}

async function thinq(path: string, method: "GET" | "POST" = "GET", body?: any) {
  const c = cfg();
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${c.pat}`,
    "x-country-code": c.country,
    "x-message-id": messageId(),
    "Content-Type": "application/json",
  };
  // Le portail LG fournit selon les cas une clé d'API et un identifiant client.
  // On n'envoie que ce qui est renseigné : un en-tête vide ferait échouer l'appel.
  if (c.apiKey) headers["x-api-key"] = c.apiKey;
  if (c.clientId) headers["x-client-id"] = c.clientId;

  const url = `https://${c.region}-ext.lgthinq.com${path}`;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const texte = await res.text().catch(() => "");
  let json: any = null;
  try { json = JSON.parse(texte); } catch { /* réponse non JSON */ }
  return { ok: res.ok, status: res.status, json, raw: texte.slice(0, 400) };
}

/**
 * Extrait température et état d'une réponse ThinQ.
 *
 * La structure varie selon le modèle de climatiseur : on cherche donc la valeur
 * là où elle peut se trouver, plutôt que de supposer un seul emplacement. Un
 * champ absent vaut null — jamais 0, qui serait une température plausible et
 * donc un mensonge.
 */
function lire(status: any) {
  const t = status?.temperature ?? {};
  const op = status?.operation ?? {};
  const nombre = (v: any) => (typeof v === "number" ? v : null);
  return {
    ambiante: nombre(t.currentTemperature ?? status?.currentTemperature),
    consigne: nombre(t.targetTemperature ?? status?.targetTemperature),
    unite: t.unit || "C",
    allumee: (op.airConOperationMode ?? op.operationMode) === "POWER_ON",
    mode: status?.airConJobMode?.currentJobMode ?? null,
  };
}

export async function GET(req: NextRequest) {
  const rl = checkRateLimit(`lg:${getClientIp(req)}`, 60, 60_000);
  if (!rl.allowed) return NextResponse.json({ error: "Trop de requêtes" }, { status: 429 });

  const c = cfg();
  if (!c.pat) {
    return NextResponse.json(
      { error: "Climatisation non configurée (LG_THINQ_PAT manquante)" }, { status: 503 });
  }

  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action") || "status";

  try {
    // Liste des appareils — sert à récupérer le deviceId une première fois.
    if (action === "devices") {
      const r = await thinq("/devices");
      if (!r.ok) return NextResponse.json({ error: r.json?.error?.message || r.raw }, { status: r.status });
      return NextResponse.json({ devices: r.json?.response || [] });
    }

    const deviceId = searchParams.get("deviceId") || process.env.LG_THINQ_DEVICE_ID || "";
    if (!deviceId) return NextResponse.json({ error: "deviceId requis" }, { status: 400 });

    if (action === "status") {
      const r = await thinq(`/devices/${deviceId}`);
      if (!r.ok) return NextResponse.json({ error: r.json?.error?.message || r.raw }, { status: r.status });
      const brut = r.json?.response || {};
      return NextResponse.json({ ...lire(brut), brut });
    }

    return NextResponse.json({ error: `Action inconnue : ${action}` }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Erreur ThinQ" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const rl = checkRateLimit(`lgw:${getClientIp(req)}`, 30, 60_000);
  if (!rl.allowed) return NextResponse.json({ error: "Trop de requêtes" }, { status: 429 });

  // Commander la clim modifie l'état d'un équipement : on exige le même jeton
  // interne que les autres écritures de l'application.
  const attendu = process.env.WMS_WRITE_TOKEN || "";
  if (!attendu || req.headers.get("x-wms-token") !== attendu) {
    return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  }

  const c = cfg();
  if (!c.pat) return NextResponse.json({ error: "Climatisation non configurée" }, { status: 503 });

  try {
    const { deviceId: fourni, power, target } = await req.json();
    const deviceId = fourni || process.env.LG_THINQ_DEVICE_ID || "";
    if (!deviceId) return NextResponse.json({ error: "deviceId requis" }, { status: 400 });

    const corps: any = {};
    if (power === "on" || power === "off") {
      corps.operation = { airConOperationMode: power === "on" ? "POWER_ON" : "POWER_OFF" };
    }
    if (typeof target === "number") {
      corps.temperature = { targetTemperature: target, unit: "C" };
    }
    if (!Object.keys(corps).length) {
      return NextResponse.json({ error: "Aucune commande fournie" }, { status: 400 });
    }

    const r = await thinq(`/devices/${deviceId}`, "POST", corps);
    if (!r.ok) return NextResponse.json({ error: r.json?.error?.message || r.raw }, { status: r.status });

    // Relecture : la commande peut être acceptée sans que l'appareil ait suivi.
    // On renvoie l'état réel plutôt que de supposer le succès.
    const apres = await thinq(`/devices/${deviceId}`);
    return NextResponse.json({ envoye: corps, etat: apres.ok ? lire(apres.json?.response || {}) : null });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Erreur ThinQ" }, { status: 500 });
  }
}
