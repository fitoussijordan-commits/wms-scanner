// lib/supabase-palettes.ts
import { sb } from "@/lib/supabase";

export interface WmsPalette {
  id: number;
  numero: string;
  numero_seq: number;
  emplacement: string | null;
  statut: "actif" | "archive" | "expedie";
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface WmsPaletteLigne {
  id: number;
  palette_id: number;
  odoo_ref: string;
  product_name: string;
  lot: string | null;
  expiry_date: string | null;
  qty: number;
  unite: string;
  packaging_qty: number | null;
  created_at: string;
}

// ── Créer une nouvelle palette (numéro auto) ──
export async function createPalette(emplacement?: string, notes?: string): Promise<WmsPalette> {
  const { data, error } = await sb.rpc("create_next_palette", {
    p_emplacement: emplacement || null,
    p_notes: notes || null,
  });
  if (error) throw new Error(error.message);
  return data as WmsPalette;
}

// ── Lister les palettes ──
export async function loadPalettes(statut?: string): Promise<WmsPalette[]> {
  let q = sb.from("wms_palettes").select("*").order("numero_seq", { ascending: false });
  if (statut) q = q.eq("statut", statut);
  const { data, error } = await q.limit(200);
  if (error) throw new Error(error.message);
  return data || [];
}

// ── Charger une palette + ses lignes ──
export async function loadPaletteDetail(paletteId: number): Promise<{ palette: WmsPalette; lignes: WmsPaletteLigne[] }> {
  const [{ data: palette, error: e1 }, { data: lignes, error: e2 }] = await Promise.all([
    sb.from("wms_palettes").select("*").eq("id", paletteId).single(),
    sb.from("wms_palette_lignes").select("*").eq("palette_id", paletteId).order("created_at"),
  ]);
  if (e1) throw new Error(e1.message);
  if (e2) throw new Error(e2.message);
  return { palette: palette as WmsPalette, lignes: lignes || [] };
}

// ── Chercher palette par numéro (scan) ──
export async function findPaletteByNumero(numero: string): Promise<WmsPalette | null> {
  const { data, error } = await sb.from("wms_palettes").select("*").eq("numero", numero).single();
  if (error) return null;
  return data as WmsPalette;
}

// ── Ajouter/mettre à jour une ligne ──
export async function upsertLigne(paletteId: number, ligne: Partial<Omit<WmsPaletteLigne, "id" | "palette_id" | "created_at">> & { odoo_ref: string; product_name: string; qty: number; unite: string }): Promise<void> {
  // Si même ref+lot existe → additionne la qty
  const { data: existing } = await sb.from("wms_palette_lignes")
    .select("id, qty")
    .eq("palette_id", paletteId)
    .eq("odoo_ref", ligne.odoo_ref)
    .eq("lot", ligne.lot || "")
    .single();

  if (existing) {
    const updateData: any = { qty: existing.qty + ligne.qty, updated_at: new Date().toISOString() };
    if (ligne.packaging_qty !== undefined) updateData.packaging_qty = ligne.packaging_qty;
    const { error } = await sb.from("wms_palette_lignes")
      .update(updateData)
      .eq("id", existing.id);
    if (error) throw new Error(error.message);
  } else {
    const insertData: any = { palette_id: paletteId, odoo_ref: ligne.odoo_ref, product_name: ligne.product_name, lot: ligne.lot || null, expiry_date: ligne.expiry_date || null, qty: ligne.qty, unite: ligne.unite };
    if (ligne.packaging_qty !== undefined) insertData.packaging_qty = ligne.packaging_qty;
    const { error } = await sb.from("wms_palette_lignes").insert(insertData);
    if (error) throw new Error(error.message);
  }
  // Update palette updated_at
  await sb.from("wms_palettes").update({ updated_at: new Date().toISOString() }).eq("id", paletteId);
}

// ── Modifier qty d'une ligne ──
export async function updateLigneQty(ligneId: number, qty: number): Promise<void> {
  if (qty <= 0) {
    const { error } = await sb.from("wms_palette_lignes").delete().eq("id", ligneId);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await sb.from("wms_palette_lignes").update({ qty, updated_at: new Date().toISOString() }).eq("id", ligneId);
    if (error) throw new Error(error.message);
  }
}

// ── Mettre à jour emplacement/statut/notes ──
export async function updatePalette(paletteId: number, updates: Partial<Pick<WmsPalette, "emplacement" | "statut" | "notes">>): Promise<void> {
  const { error } = await sb.from("wms_palettes").update({ ...updates, updated_at: new Date().toISOString() }).eq("id", paletteId);
  if (error) throw new Error(error.message);
}

// ── Recherche produit dans toutes les palettes ──
export async function searchProductInPalettes(odooRef: string): Promise<(WmsPaletteLigne & { palette_numero: string; palette_emplacement: string | null })[]> {
  const { data, error } = await sb.from("wms_palette_lignes")
    .select("*, wms_palettes(numero, emplacement)")
    .eq("odoo_ref", odooRef)
    .gt("qty", 0);
  if (error) throw new Error(error.message);
  return (data || []).map((l: any) => ({
    ...l,
    palette_numero: l.wms_palettes?.numero,
    palette_emplacement: l.wms_palettes?.emplacement,
  }));
}

// ── ZPL 70×45mm pour PrintNode ──
export function generatePaletteZPL(palette: WmsPalette, lignes: WmsPaletteLigne[]): string {
  // 70mm x 45mm @ 203dpi = 559 x 360 dots
  const topLines = lignes.slice(0, 4).map((l, i) =>
    `^FO20,${130 + i * 30}^A0N,20,20^FD${l.odoo_ref} ${l.lot ? `Lot:${l.lot}` : ""} x${l.qty}^FS`
  ).join("\n");

  return `^XA
^CI28
^FO20,15^A0N,40,40^FD${palette.numero}^FS
^FO20,60^A0N,22,22^FD${palette.emplacement || ""}^FS
^FO20,88^GB519,2,2^FS
^FO200,10^BQN,2,6^FDQA,${palette.numero}^FS
${topLines}
^FO20,342^A0N,18,18^FD${new Date(palette.created_at).toLocaleDateString("fr-FR")}^FS
^XZ`;
}
