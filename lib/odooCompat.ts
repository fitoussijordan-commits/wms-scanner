// lib/odooCompat.ts
// ─────────────────────────────────────────────────────────────────────────────
// Compatibilité entre versions d'Odoo sur les LIGNES DE MOUVEMENT.
//
// LE PROBLÈME
// Jusqu'à Odoo 16, une ligne portait deux quantités distinctes :
//   reserved_uom_qty = ce qu'il faut prélever
//   qty_done         = ce qui a été prélevé
// Le « reste à faire » se lisait donc : reserved - done.
//
// Depuis Odoo 17 (et donc en 19), les deux sont FUSIONNÉS :
//   quantity = la quantité de la ligne (pré-remplie avec la réservation)
//   picked   = booléen, la ligne a-t-elle été prélevée
// La notion de « partiellement prélevé » n'existe plus dans le modèle.
//
// POURQUOI CE FICHIER
// Remapper simplement les noms donnerait « quantity < quantity », toujours faux :
// la préparation considérerait tout comme déjà fait, SANS lever la moindre erreur.
// On expose donc des accesseurs qui ont le même SENS dans les deux versions, et
// le reste du code raisonne en « attendu / fait / restant » sans savoir quelle
// version d'Odoo est derrière.
// ─────────────────────────────────────────────────────────────────────────────

export interface StockShape {
  /** true = modèle fusionné (Odoo 17+/19) : quantity + picked */
  merged: boolean;
  /** Champ portant la quantité attendue (réservée) */
  reservedField: string;
  /** Champ portant la quantité faite */
  doneField: string;
  /** Champ booléen « ligne prélevée » (modèle fusionné uniquement) */
  pickedField: string | null;
}

export const SHAPE_LEGACY: StockShape = {
  merged: false,
  reservedField: "reserved_uom_qty",
  doneField: "qty_done",
  pickedField: null,
};

export const SHAPE_MERGED: StockShape = {
  merged: true,
  reservedField: "quantity",
  doneField: "quantity",
  pickedField: "picked",
};

// Détection faite UNE fois par session, puis mémorisée : fields_get est coûteux
// et la structure ne change évidemment pas en cours d'utilisation.
let _shape: StockShape | null = null;

/** Force une structure (tests, ou bascule manuelle). */
export function setStockShape(s: StockShape | null) { _shape = s; }

/** Structure connue, sans appel réseau. `null` si pas encore détectée. */
export function getStockShape(): StockShape | null { return _shape; }

/**
 * Détecte la structure réelle de stock.move.line dans la base connectée.
 * Critère : présence simultanée de `quantity` et `picked` → modèle fusionné.
 * En cas d'échec (droits, réseau), on retombe sur l'ancien modèle : c'est le
 * comportement historique, donc le repli le moins surprenant.
 */
export async function detectStockShape(
  callFieldsGet: (model: string) => Promise<Record<string, any>>,
  moveLineModel = "stock.move.line",
): Promise<StockShape> {
  if (_shape) return _shape;
  try {
    const fields = await callFieldsGet(moveLineModel);
    const has = (n: string) => !!fields && typeof fields === "object" && n in fields;
    _shape = (has("quantity") && has("picked")) ? SHAPE_MERGED : SHAPE_LEGACY;
  } catch {
    _shape = SHAPE_LEGACY;
  }
  return _shape;
}

// ── Accesseurs — le reste du code ne manipule QUE ceux-là ────────────────────

/** Champs à demander à Odoo pour raisonner sur une ligne. */
export function moveLineFields(shape: StockShape, extra: string[] = []): string[] {
  const base = shape.merged
    ? ["id", "quantity", "picked"]
    : ["id", "reserved_uom_qty", "qty_done"];
  return Array.from(new Set([...base, ...extra]));
}

/**
 * Quantité ATTENDUE sur la ligne.
 * Modèle fusionné : `quantity` porte la réservation tant que la ligne n'est pas
 * prélevée. Une fois prélevée, la quantité inscrite EST celle attendue.
 */
export function lineExpected(ml: any, shape: StockShape): number {
  if (!ml) return 0;
  return Number(shape.merged ? (ml.quantity ?? 0) : (ml.reserved_uom_qty ?? 0)) || 0;
}

/**
 * Quantité DÉJÀ FAITE sur la ligne.
 * Modèle fusionné : une ligne est tout ou rien — `picked` tranche. Il n'existe
 * pas d'état « 3 sur 5 » côté Odoo ; la progression fine reste locale au WMS.
 */
export function lineDone(ml: any, shape: StockShape): number {
  if (!ml) return 0;
  if (!shape.merged) return Number(ml.qty_done ?? 0) || 0;
  return ml.picked ? (Number(ml.quantity ?? 0) || 0) : 0;
}

/** Reste à prélever sur la ligne (jamais négatif). */
export function lineRemaining(ml: any, shape: StockShape): number {
  return Math.max(0, lineExpected(ml, shape) - lineDone(ml, shape));
}

/** La ligne est-elle terminée ? */
export function lineIsDone(ml: any, shape: StockShape): boolean {
  const exp = lineExpected(ml, shape);
  return exp > 0 && lineDone(ml, shape) >= exp;
}

/**
 * Valeurs à écrire pour enregistrer une quantité faite.
 * Modèle fusionné : on inscrit la quantité ET on marque `picked`. Marquer
 * `picked` sur une quantité partielle est volontaire — c'est ainsi qu'Odoo 17+
 * enregistre un prélèvement incomplet, le reliquat partant en backorder.
 */
export function doneVals(qty: number, shape: StockShape, opts?: { lotId?: number | null }): Record<string, any> {
  const vals: Record<string, any> = shape.merged
    ? { quantity: qty, picked: qty > 0 }
    : { qty_done: qty };
  if (opts?.lotId) vals.lot_id = opts.lotId;
  return vals;
}

/** Domaine « lignes ayant quelque chose à prélever », selon la version. */
export function pendingDomain(shape: StockShape): any[] {
  return shape.merged
    ? [["quantity", ">", 0], ["picked", "=", false]]
    : [["reserved_uom_qty", ">", 0]];
}
