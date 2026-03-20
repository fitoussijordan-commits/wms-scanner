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
  const W = 559;
  const H = 360;
  const cW = W - 20;

  const lines: string[] = [
    "^XA",
    "^CI28",
    `^PW${W}`,
    `^LL${H}`,
  ];

  // ── NUMÉRO — gros, gras, centré ──
  lines.push(`^FO10,25^A0N,100,96^FB${cW},1,0,C^FD${palette.numero}^FS`);

  // ── QR Code — centré ──
  lines.push(`^FO${Math.round((W - 150) / 2)},145^BQN,2,5^FDQA,${palette.numero}^FS`);

  // ── Date petit en bas ──
  lines.push(`^FO10,${H - 22}^A0N,16,16^FB${cW},1,0,C^FD${new Date(palette.created_at).toLocaleDateString("fr-FR")}^FS`);

  lines.push("^XZ");
  return lines.join("\n");
}

// ══════════════════════════════════════════
// PICKING SLOTS — emplacements picking + capacité
// ══════════════════════════════════════════
export interface WmsPickingSlot {
  id: number;
  emplacement: string;
  odoo_ref: string;
  product_name: string;
  capacite_colis: number;
  packaging_qty: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export async function loadPickingSlots(): Promise<WmsPickingSlot[]> {
  const { data, error } = await sb.from("wms_picking_slots").select("*").order("emplacement");
  if (error) throw new Error(error.message);
  return data || [];
}

export async function upsertPickingSlot(slot: Omit<WmsPickingSlot, "id" | "created_at" | "updated_at">): Promise<void> {
  const { data: existing } = await sb.from("wms_picking_slots")
    .select("id").eq("emplacement", slot.emplacement).eq("odoo_ref", slot.odoo_ref).single();
  if (existing) {
    const { error } = await sb.from("wms_picking_slots")
      .update({ ...slot, updated_at: new Date().toISOString() })
      .eq("id", existing.id);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await sb.from("wms_picking_slots").insert(slot);
    if (error) throw new Error(error.message);
  }
}

export async function deletePickingSlot(id: number): Promise<void> {
  const { error } = await sb.from("wms_picking_slots").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

// ── Calcul réappro FEFO ──
// Pour chaque slot picking, calcule combien il manque et d'où prendre (palette + lot avec DLV la plus proche)
export interface ReapproLine {
  slot: WmsPickingSlot;
  stockPicking: number;       // stock actuel estimé en picking (unités)
  stockPickingColis: number;  // idem en colis
  manqueColis: number;        // colis à réapprovisionner
  manqueUnites: number;       // unités à réapprovisionner
  source: {
    palette_id: number;
    palette_numero: string;
    palette_emplacement: string | null;
    lot: string | null;
    expiry_date: string | null;
    qty_dispo: number;        // qty disponible sur cette palette pour ce produit
  } | null;
}

export async function calcReappro(
  slots: WmsPickingSlot[],
  odooStockByRef: Record<string, number>  // stock Odoo total par ref
): Promise<ReapproLine[]> {
  // 1. Charger toutes les palettes actives + lignes
  const palettes = await loadPalettes("actif");
  const palData: { palette: WmsPalette; lignes: WmsPaletteLigne[] }[] = [];
  for (const pal of palettes) {
    const d = await loadPaletteDetail(pal.id);
    palData.push(d);
  }

  // 2. Calculer stock palette par ref
  const supaByRef: Record<string, number> = {};
  // 3. Construire la liste des sources par ref, triée FEFO
  const sourcesByRef: Record<string, { palette_id: number; palette_numero: string; palette_emplacement: string | null; lot: string | null; expiry_date: string | null; qty_dispo: number }[]> = {};

  for (const { palette, lignes } of palData) {
    for (const l of lignes) {
      supaByRef[l.odoo_ref] = (supaByRef[l.odoo_ref] || 0) + l.qty;
      if (!sourcesByRef[l.odoo_ref]) sourcesByRef[l.odoo_ref] = [];
      sourcesByRef[l.odoo_ref].push({
        palette_id: palette.id,
        palette_numero: palette.numero,
        palette_emplacement: palette.emplacement,
        lot: l.lot,
        expiry_date: l.expiry_date,
        qty_dispo: l.qty,
      });
    }
  }

  // Trier FEFO : expiry_date la plus proche en premier, null en dernier
  for (const ref of Object.keys(sourcesByRef)) {
    sourcesByRef[ref].sort((a, b) => {
      if (!a.expiry_date && !b.expiry_date) return 0;
      if (!a.expiry_date) return 1;
      if (!b.expiry_date) return -1;
      return a.expiry_date.localeCompare(b.expiry_date);
    });
  }

  // 4. Pour chaque slot, calculer le manque et la source FEFO
  const result: ReapproLine[] = [];
  for (const slot of slots) {
    const odooTotal = odooStockByRef[slot.odoo_ref] || 0;
    const supaTotal = supaByRef[slot.odoo_ref] || 0;
    const pickingUnites = Math.max(0, odooTotal - supaTotal);
    const pkg = slot.packaging_qty || 1;
    const pickingColis = Math.round(pickingUnites / pkg);
    const manqueColis = Math.max(0, slot.capacite_colis - pickingColis);
    const manqueUnites = manqueColis * pkg;

    const sources = sourcesByRef[slot.odoo_ref] || [];
    const source = manqueColis > 0 && sources.length > 0 ? sources[0] : null;

    result.push({
      slot,
      stockPicking: pickingUnites,
      stockPickingColis: pickingColis,
      manqueColis,
      manqueUnites,
      source,
    });
  }

  // Trier : les plus urgents (manque le plus) en premier
  result.sort((a, b) => b.manqueColis - a.manqueColis);
  return result;
}

// ── Picking Slots ──

// ── Recherche par lot dans toutes les palettes ──
export async function searchLotInPalettes(lot: string): Promise<(WmsPaletteLigne & { palette_numero: string; palette_emplacement: string | null })[]> {
  const { data, error } = await sb.from("wms_palette_lignes")
    .select("*, wms_palettes(numero, emplacement)")
    .eq("lot", lot)
    .gt("qty", 0);
  if (error) throw new Error(error.message);
  return (data || []).map((l: any) => ({
    ...l,
    palette_numero: l.wms_palettes?.numero,
    palette_emplacement: l.wms_palettes?.emplacement,
  }));
}

// ── Recherche par emplacement ──
export async function searchByEmplacement(empl: string): Promise<WmsPalette[]> {
  const { data, error } = await sb.from("wms_palettes")
    .select("*")
    .ilike("emplacement", "%" + empl + "%")
    .eq("statut", "actif")
    .order("emplacement");
  if (error) throw new Error(error.message);
  return data || [];
}
