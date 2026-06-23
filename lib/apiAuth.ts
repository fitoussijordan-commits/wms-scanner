/**
 * Authentification interne des routes API sensibles.
 * Les routes qui écrivent (Shopware setStock, SendCloud labels…) ou coûtent (Anthropic)
 * exigent un token partagé `WMS_INTERNAL_TOKEN`, comparé en timing-safe.
 *
 * Le client doit envoyer l'entête `x-wms-token`.
 * Si WMS_INTERNAL_TOKEN n'est pas configuré côté serveur, on REFUSE (fail-closed)
 * pour ne jamais exposer une route sensible par défaut.
 */
import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

function timingSafeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Retourne null si autorisé, sinon une NextResponse 401/500 à renvoyer immédiatement.
 *   const denied = requireInternalToken(req); if (denied) return denied;
 */
export function requireInternalToken(req: NextRequest): NextResponse | null {
  const expected = process.env.WMS_INTERNAL_TOKEN || "";
  if (!expected) {
    return NextResponse.json({ error: "Configuration serveur manquante" }, { status: 500 });
  }
  const received = req.headers.get("x-wms-token") || "";
  if (!received || !timingSafeEqual(expected, received)) {
    return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  }
  return null;
}
