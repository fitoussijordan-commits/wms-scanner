// app/api/alert-lot/route.ts — RETIRÉ
// L'alerte de substitution de lot passe désormais par une notification in-app
// (table Supabase wms_notifications + cloche dans le header), plus par email Odoo.
// Cette route est conservée en stub pour ne pas casser d'éventuels appels en cache.

import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    { ok: false, error: "Route retirée — utiliser les notifications in-app" },
    { status: 410 },
  );
}
