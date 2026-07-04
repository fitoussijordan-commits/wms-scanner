// lib/fieldMap.ts
// ════════════════════════════════════════════════════════════════════════════
// REGISTRE CENTRAL DES CHAMPS ODOO
// ────────────────────────────────────────────────────────────────────────────
// But : ne plus écrire les noms techniques Odoo en dur dans le code.
// Chaque champ possède une CLÉ LOGIQUE stable (ex. "SHIPPING_DATE") qui pointe
// vers un NOM TECHNIQUE Odoo (ex. "x_studio_date_dexpdition_prvue").
//
// Le code applicatif utilise TOUJOURS la clé logique via le helper F("SHIPPING_DATE").
// Le nom technique, lui, peut être changé SANS TOUCHER AU CODE :
//   • depuis le menu Admin (onglet « Champs Odoo »)
//   • depuis la roue crantée ⚙️ d'un écran
// Les modifications sont enregistrées dans Supabase (wms_sync_meta / clé
// "odoo_field_map") et fusionnées par-dessus les valeurs par défaut ci-dessous.
//
// >>> Passage à Odoo 19 : si un champ est renommé côté Odoo, il suffit de mettre
//     à jour sa valeur dans l'admin. Aucun redéploiement de code nécessaire. <<<
// ════════════════════════════════════════════════════════════════════════════

// ── Type d'une définition de champ ──────────────────────────────────────────
export interface FieldDef {
  /** Nom technique Odoo par défaut (Odoo 17/18 actuel). */
  default: string;
  /** Modèle Odoo auquel ce champ appartient (ex. "stock.picking"). Info/regroupement. */
  model: string;
  /** Libellé lisible affiché dans l'UI admin (FR). */
  label: string;
  /** Description courte : à quoi sert ce champ dans l'app. */
  hint?: string;
  /** true = champ custom Odoo Studio (x_studio_*, x_*) → le plus à risque en migration. */
  custom?: boolean;
  /** Fonctions/écrans qui consomment ce champ (pour la roue crantée contextuelle). */
  screens?: string[];
}

// ── Catégories logiques (regroupement UI) ───────────────────────────────────
export type FieldGroup =
  | "Livraison / Picking"
  | "Produit"
  | "Stock / Emplacement"
  | "Lot / Péremption"
  | "Vente / Commande"
  | "Fournisseur"
  | "Partenaire"
  | "Pièces jointes"
  | "Custom (Studio)";

// ════════════════════════════════════════════════════════════════════════════
// DÉFINITIONS — la source de vérité des valeurs PAR DÉFAUT.
// La clé (à gauche) est la clé logique STABLE utilisée dans tout le code.
// ════════════════════════════════════════════════════════════════════════════
export const FIELD_DEFS = {
  // ─────────────── CUSTOM STUDIO (prioritaires — cassent en Odoo 19) ───────────────
  SHIPPING_DATE: {
    default: "x_studio_date_dexpdition_prvue",
    model: "stock.picking",
    label: "Date d'expédition prévue",
    hint: "Date d'expédition planifiée affichée dans « En attente » et le tri des commandes.",
    custom: true,
    screens: ["waitingOrders", "prep", "packing", "dashboard"],
  },
  ORDER_TAGS: {
    default: "x_studio_etiquettes_commande",
    model: "stock.picking",
    label: "Étiquettes de commande",
    hint: "Tags (crm.tag) utilisés pour filtrer les commandes transmises.",
    custom: true,
    screens: ["waitingOrders", "prep"],
  },
  CLIENT_ORDER: {
    default: "x_studio_cde_client",
    model: "stock.picking",
    label: "Commande client",
    hint: "Référence de commande client affichée à l'emballage.",
    custom: true,
    screens: ["packing"],
  },
  SUPPLIER_PRODUCT_CODE: {
    default: "x_studio_code_produit_fournisseur",
    model: "product.product",
    label: "Code produit fournisseur",
    hint: "Code produit chez le fournisseur (import WALA, dashboard).",
    custom: true,
    screens: ["supplierImport", "dashboard"],
  },
  CLIENT_CODE_CALENDAR: {
    default: "x_studio_code_client_cli_calendar",
    model: "res.partner",
    label: "Code client (calendrier)",
    hint: "Code client utilisé pour le calendrier de rendez-vous.",
    custom: true,
    screens: ["order"],
  },
  PRODUCT_DIMENSIONS: {
    default: "x_dimensions",
    model: "product.template",
    label: "Dimensions produit",
    hint: "Dimensions personnalisées du produit (calcul carton d'emballage).",
    custom: true,
    screens: ["packing"],
  },
  PARTNER_ACCOUNT_TYPE: {
    default: "x_type_de_compte",
    model: "res.partner",
    label: "Type de compte partenaire",
    hint: "Type de compte client/fournisseur.",
    custom: true,
    screens: ["order"],
  },

  // ─────────────── PRODUIT (product.product / product.template) ───────────────
  PRODUCT_DEFAULT_CODE: {
    default: "default_code",
    model: "product.product",
    label: "Référence interne (default_code)",
    hint: "La réf interne Odoo, pivot de quasiment tous les écrans.",
    screens: ["*"],
  },
  PRODUCT_BARCODE: {
    default: "barcode",
    model: "product.product",
    label: "Code-barres",
    hint: "Code-barres scanné.",
    screens: ["*"],
  },
  PRODUCT_NAME: {
    default: "name",
    model: "product.product",
    label: "Nom du produit",
    screens: ["*"],
  },
  PRODUCT_TMPL_ID: {
    default: "product_tmpl_id",
    model: "product.product",
    label: "Modèle de produit (product_tmpl_id)",
  },
  PRODUCT_UOM_ID: {
    default: "uom_id",
    model: "product.product",
    label: "Unité de mesure",
  },
  PRODUCT_VOLUME: {
    default: "volume",
    model: "product.product",
    label: "Volume",
  },

  // ─────────────── STOCK.PICKING ───────────────
  PICKING_NAME: { default: "name", model: "stock.picking", label: "Nom du transfert (WH/…)" },
  PICKING_STATE: { default: "state", model: "stock.picking", label: "État du transfert" },
  PICKING_ORIGIN: { default: "origin", model: "stock.picking", label: "Document d'origine" },
  PICKING_SCHEDULED_DATE: { default: "scheduled_date", model: "stock.picking", label: "Date prévue" },
  PICKING_DATE_DEADLINE: { default: "date_deadline", model: "stock.picking", label: "Date limite" },
  PICKING_DATE_DONE: { default: "date_done", model: "stock.picking", label: "Date de réalisation" },
  PICKING_TYPE_ID: { default: "picking_type_id", model: "stock.picking", label: "Type d'opération" },
  PICKING_TYPE_CODE: { default: "picking_type_code", model: "stock.picking", label: "Code type d'opération" },
  PICKING_PARTNER_ID: { default: "partner_id", model: "stock.picking", label: "Partenaire" },
  PICKING_CARRIER_ID: { default: "carrier_id", model: "stock.picking", label: "Transporteur" },
  PICKING_CARRIER_TRACKING: { default: "carrier_tracking_ref", model: "stock.picking", label: "N° de suivi transporteur" },
  PICKING_GROUP_ID: { default: "group_id", model: "stock.picking", label: "Groupe de procurement" },
  PICKING_SALE_ID: { default: "sale_id", model: "stock.picking", label: "Commande de vente liée" },

  // ─────────────── STOCK.MOVE.LINE ───────────────
  ML_PRODUCT_ID: { default: "product_id", model: "stock.move.line", label: "Produit (ligne)" },
  ML_PICKING_ID: { default: "picking_id", model: "stock.move.line", label: "Transfert (ligne)" },
  ML_LOT_ID: { default: "lot_id", model: "stock.move.line", label: "Lot (ligne)" },
  ML_LOCATION_ID: { default: "location_id", model: "stock.move.line", label: "Emplacement source (ligne)" },
  ML_LOCATION_DEST_ID: { default: "location_dest_id", model: "stock.move.line", label: "Emplacement dest. (ligne)" },
  ML_QTY_DONE: { default: "qty_done", model: "stock.move.line", label: "Quantité faite (qty_done)", hint: "⚠️ Renommé en Odoo 17+ (quantity). À vérifier en Odoo 19." },
  ML_QUANTITY: { default: "quantity", model: "stock.move.line", label: "Quantité (quantity)" },
  ML_RESERVED_UOM_QTY: { default: "reserved_uom_qty", model: "stock.move.line", label: "Quantité réservée" },

  // ─────────────── STOCK.MOVE ───────────────
  MOVE_PRODUCT_ID: { default: "product_id", model: "stock.move", label: "Produit (move)" },
  MOVE_PRODUCT_UOM_QTY: { default: "product_uom_qty", model: "stock.move", label: "Quantité demandée" },
  MOVE_PRODUCT_UOM: { default: "product_uom", model: "stock.move", label: "Unité de mesure (move)" },

  // ─────────────── STOCK.QUANT ───────────────
  QUANT_PRODUCT_ID: { default: "product_id", model: "stock.quant", label: "Produit (quant)" },
  QUANT_LOCATION_ID: { default: "location_id", model: "stock.quant", label: "Emplacement (quant)" },
  QUANT_LOT_ID: { default: "lot_id", model: "stock.quant", label: "Lot (quant)" },
  QUANT_QUANTITY: { default: "quantity", model: "stock.quant", label: "Quantité en stock" },
  QUANT_RESERVED_QTY: { default: "reserved_quantity", model: "stock.quant", label: "Quantité réservée (quant)" },

  // ─────────────── STOCK.LOCATION ───────────────
  LOCATION_NAME: { default: "name", model: "stock.location", label: "Nom emplacement" },
  LOCATION_COMPLETE_NAME: { default: "complete_name", model: "stock.location", label: "Nom complet emplacement" },
  LOCATION_USAGE: { default: "usage", model: "stock.location", label: "Usage emplacement" },
  LOCATION_BARCODE: { default: "barcode", model: "stock.location", label: "Code-barres emplacement" },

  // ─────────────── STOCK.LOT ───────────────
  LOT_NAME: { default: "name", model: "stock.lot", label: "Nom du lot" },
  LOT_PRODUCT_ID: { default: "product_id", model: "stock.lot", label: "Produit (lot)" },
  LOT_EXPIRATION_DATE: { default: "expiration_date", model: "stock.lot", label: "Date d'expiration" },
  LOT_USE_DATE: { default: "use_date", model: "stock.lot", label: "Date d'utilisation (DLC)" },
  LOT_REMOVAL_DATE: { default: "removal_date", model: "stock.lot", label: "Date de retrait" },

  // ─────────────── SALE.ORDER ───────────────
  SALE_NAME: { default: "name", model: "sale.order", label: "Référence commande de vente" },
  SALE_ORIGIN: { default: "origin", model: "sale.order", label: "Origine commande" },
  SALE_DATE_ORDER: { default: "date_order", model: "sale.order", label: "Date de commande" },
  SALE_COMMITMENT_DATE: { default: "commitment_date", model: "sale.order", label: "Date d'engagement" },
  SALE_EXPECTED_DATE: { default: "expected_date", model: "sale.order", label: "Date attendue" },
  SALE_PARTNER_ID: { default: "partner_id", model: "sale.order", label: "Client" },

  // ─────────────── PRODUCT.SUPPLIERINFO ───────────────
  SUPPLIERINFO_PRODUCT_CODE: { default: "product_code", model: "product.supplierinfo", label: "Code produit fournisseur (supplierinfo)" },
  SUPPLIERINFO_PARTNER_ID: { default: "partner_id", model: "product.supplierinfo", label: "Fournisseur (supplierinfo)" },

  // ─────────────── RES.PARTNER ───────────────
  PARTNER_NAME: { default: "name", model: "res.partner", label: "Nom partenaire" },
  PARTNER_REF: { default: "ref", model: "res.partner", label: "Référence partenaire" },

  // ─────────────── IR.ATTACHMENT ───────────────
  ATTACH_DATAS: { default: "datas", model: "ir.attachment", label: "Données (base64)" },
  ATTACH_MIMETYPE: { default: "mimetype", model: "ir.attachment", label: "Type MIME" },
  ATTACH_RES_MODEL: { default: "res_model", model: "ir.attachment", label: "Modèle lié" },
  ATTACH_RES_ID: { default: "res_id", model: "ir.attachment", label: "ID lié" },
} as const satisfies Record<string, FieldDef>;

// ── Type dérivé : l'ensemble des clés logiques valides ──────────────────────
export type FieldKey = keyof typeof FIELD_DEFS;

// ════════════════════════════════════════════════════════════════════════════
// RÉSOLUTION RUNTIME
// ────────────────────────────────────────────────────────────────────────────
// _overrides = valeurs venant de Supabase (chargées une fois au démarrage).
// F(key) renvoie le nom technique effectif : override si présent, sinon défaut.
// ════════════════════════════════════════════════════════════════════════════

let _overrides: Partial<Record<FieldKey, string>> = {};

/** Injecte les overrides chargés depuis Supabase (appelé une fois au boot). */
export function setFieldOverrides(overrides: Record<string, string> | null | undefined): void {
  const clean: Partial<Record<FieldKey, string>> = {};
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      if (k in FIELD_DEFS && typeof v === "string" && v.trim()) {
        clean[k as FieldKey] = v.trim();
      }
    }
  }
  _overrides = clean;
}

/** Renvoie les overrides actuellement en mémoire (pour l'UI admin). */
export function getFieldOverrides(): Partial<Record<FieldKey, string>> {
  return { ..._overrides };
}

/**
 * F("SHIPPING_DATE") → nom technique Odoo effectif.
 * C'EST LA SEULE FAÇON dont le code doit référencer un champ Odoo.
 */
export function F(key: FieldKey): string {
  return _overrides[key] ?? FIELD_DEFS[key].default;
}

/**
 * Résout plusieurs clés d'un coup → tableau de noms techniques.
 * Pratique pour construire un `fields: [...]` de searchRead.
 * Ex: fieldsFor("PRODUCT_DEFAULT_CODE", "PRODUCT_NAME", "PRODUCT_BARCODE")
 */
export function fieldsFor(...keys: FieldKey[]): string[] {
  return keys.map(F);
}

/** Nom technique effectif d'une clé, ou undefined si la clé n'existe pas. */
export function resolveField(key: string): string | undefined {
  if (key in FIELD_DEFS) return F(key as FieldKey);
  return undefined;
}

/** true si la clé a un override actif (≠ valeur par défaut). */
export function isOverridden(key: FieldKey): boolean {
  return _overrides[key] !== undefined && _overrides[key] !== FIELD_DEFS[key].default;
}

// ── Helpers pour l'UI ───────────────────────────────────────────────────────

/** Toutes les clés, avec leur def + valeur effective, triées par modèle. */
export function listFields(): Array<{ key: FieldKey; def: FieldDef; effective: string; overridden: boolean }> {
  return (Object.keys(FIELD_DEFS) as FieldKey[])
    .map((key) => ({
      key,
      def: FIELD_DEFS[key] as FieldDef,
      effective: F(key),
      overridden: isOverridden(key),
    }))
    .sort((a, b) => a.def.model.localeCompare(b.def.model) || a.def.label.localeCompare(b.def.label));
}

/** Clés utilisées par un écran donné (pour la roue crantée contextuelle). */
export function fieldsForScreen(screen: string): FieldKey[] {
  return (Object.keys(FIELD_DEFS) as FieldKey[]).filter((key) => {
    const s = (FIELD_DEFS[key] as FieldDef).screens;
    return s && (s.includes(screen) || s.includes("*"));
  });
}

/** Liste des modèles Odoo distincts référencés par les champs (info). */
export function listFieldModels(): string[] {
  return Array.from(new Set(Object.values(FIELD_DEFS).map((d) => (d as FieldDef).model))).sort();
}

// ════════════════════════════════════════════════════════════════════════════
// REGISTRE DES MODÈLES ODOO
// ────────────────────────────────────────────────────────────────────────────
// Même principe que les champs, mais pour les MODÈLES (product.product, etc.).
// Le code utilise M("MODEL_PRODUCT") au lieu du littéral "product.product".
// Si Odoo 19 renomme un modèle, on change sa valeur dans l'admin — pas le code.
// ════════════════════════════════════════════════════════════════════════════

export interface ModelDef {
  /** Nom technique Odoo par défaut (ex. "product.product"). */
  default: string;
  /** Libellé lisible (FR). */
  label: string;
  hint?: string;
}

export const MODEL_DEFS = {
  MODEL_PRODUCT:            { default: "product.product",       label: "Produit (variante)" },
  MODEL_PRODUCT_TEMPLATE:  { default: "product.template",       label: "Modèle de produit" },
  MODEL_PRODUCT_SUPPLIER:  { default: "product.supplierinfo",   label: "Info fournisseur produit" },
  MODEL_PRODUCT_PRICELIST: { default: "product.pricelist",      label: "Liste de prix" },
  MODEL_PRODUCT_PACKAGING: { default: "product.packaging",      label: "Conditionnement produit" },
  MODEL_PICKING:           { default: "stock.picking",          label: "Transfert (picking)" },
  MODEL_PICKING_TYPE:      { default: "stock.picking.type",     label: "Type d'opération" },
  MODEL_MOVE:              { default: "stock.move",             label: "Mouvement de stock" },
  MODEL_MOVE_LINE:         { default: "stock.move.line",        label: "Ligne de mouvement" },
  MODEL_QUANT:             { default: "stock.quant",            label: "Quant (stock physique)" },
  MODEL_QUANT_PACKAGE:     { default: "stock.quant.package",    label: "Colis" },
  MODEL_PACKAGE_LEVEL:     { default: "stock.package.level",    label: "Niveau de colis" },
  MODEL_LOT:               { default: "stock.lot",              label: "Lot / numéro de série", hint: "⚠️ Était 'stock.production.lot' avant Odoo 16." },
  MODEL_LOCATION:          { default: "stock.location",         label: "Emplacement" },
  MODEL_IMMEDIATE_TRANSFER:{ default: "stock.immediate.transfer", label: "Transfert immédiat", hint: "⚠️ Supprimé dans les versions récentes d'Odoo." },
  MODEL_BACKORDER_CONFIRM: { default: "stock.backorder.confirmation", label: "Confirmation de reliquat" },
  MODEL_INVENTORY_ADJ_NAME:{ default: "stock.inventory.adjustment.name", label: "Nom d'ajustement d'inventaire" },
  MODEL_SALE_ORDER:        { default: "sale.order",             label: "Commande de vente" },
  MODEL_PURCHASE_ORDER:    { default: "purchase.order",         label: "Commande d'achat" },
  MODEL_PARTNER:           { default: "res.partner",            label: "Partenaire (client/fournisseur)" },
  MODEL_PARTNER_CATEGORY:  { default: "res.partner.category",   label: "Catégorie de partenaire" },
  MODEL_USERS:             { default: "res.users",              label: "Utilisateurs" },
  MODEL_COUNTRY:           { default: "res.country",            label: "Pays" },
  MODEL_UOM:               { default: "uom.uom",                label: "Unité de mesure" },
  MODEL_CRM_TAG:           { default: "crm.tag",                label: "Étiquette CRM" },
  MODEL_ATTACHMENT:        { default: "ir.attachment",          label: "Pièce jointe" },
  MODEL_CONFIG_PARAM:      { default: "ir.config_parameter",    label: "Paramètre système" },
  MODEL_ACTIONS_REPORT:    { default: "ir.actions.report",      label: "Rapport" },
  MODEL_REPORT_PICKING:    { default: "stock.report_picking",   label: "Rapport de picking" },
  MODEL_TNT_SHIPPING:      { default: "tnt.shipping.service",   label: "Service d'expédition TNT" },
} as const satisfies Record<string, ModelDef>;

export type ModelKey = keyof typeof MODEL_DEFS;

let _modelOverrides: Partial<Record<ModelKey, string>> = {};

export function setModelOverrides(overrides: Record<string, string> | null | undefined): void {
  const clean: Partial<Record<ModelKey, string>> = {};
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      if (k in MODEL_DEFS && typeof v === "string" && v.trim()) clean[k as ModelKey] = v.trim();
    }
  }
  _modelOverrides = clean;
}

export function getModelOverrides(): Partial<Record<ModelKey, string>> {
  return { ..._modelOverrides };
}

/** M("MODEL_PRODUCT") → nom technique de modèle Odoo effectif. */
export function M(key: ModelKey): string {
  return _modelOverrides[key] ?? MODEL_DEFS[key].default;
}

export function isModelOverridden(key: ModelKey): boolean {
  return _modelOverrides[key] !== undefined && _modelOverrides[key] !== MODEL_DEFS[key].default;
}

/** Tous les modèles avec def + valeur effective (pour l'UI admin). */
export function listModels(): Array<{ key: ModelKey; def: ModelDef; effective: string; overridden: boolean }> {
  return (Object.keys(MODEL_DEFS) as ModelKey[])
    .map((key) => ({ key, def: MODEL_DEFS[key] as ModelDef, effective: M(key), overridden: isModelOverridden(key) }))
    .sort((a, b) => a.def.label.localeCompare(b.def.label));
}
