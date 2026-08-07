// lib/emplacements.ts — décodage des noms d'emplacement composés
//
// Odoo réserve mal quand un article est présent sur plusieurs emplacements. La
// parade retenue à l'entrepôt : un SEUL emplacement par article, dont le nom
// assemble la face de picking et ses racks de réserve.
//
//     A12-RKC1-RKC11-RKC21
//     └┬┘ └──────┬───────┘
//   picking      réserves
//
// Odoo n'y voit qu'un texte. Ce module lui rend sa structure, sans rien
// modifier dans Odoo : c'est une lecture, pas une migration.
//
// Raccourci d'écriture toléré sur le terrain : le préfixe alphabétique du
// segment précédent se propage. « RKF1-F2-F3 » vaut RKF1, RKF2, RKF3.

export interface EmplacementDecode {
  /** Nom d'origine, tel qu'il est dans Odoo. */
  brut: string;
  /** Face de picking — là où l'on prélève. */
  picking: string;
  /** Racks de réserve, préfixes rétablis. */
  reserves: string[];
  /** Vrai si au moins un segment a été complété par propagation de préfixe. */
  abrege: boolean;
}

/** Sépare les lettres de tête des chiffres de queue : « RKF12 » → RKF / 12. */
function decouper(segment: string): { lettres: string; reste: string } {
  const m = /^([A-Za-z]*)(.*)$/.exec(segment.trim());
  return { lettres: (m?.[1] || "").toUpperCase(), reste: m?.[2] || "" };
}

/**
 * Rétablit le préfixe d'un segment abrégé.
 *
 * « F2 » après « RKF1 » : les lettres du précédent sont RKF, celles du segment
 * courant F. RKF se termine par F, donc il manque RK en tête → RKF2.
 *
 * Si les lettres du segment courant ne terminent pas celles du précédent, on ne
 * touche à rien : mieux vaut un nom non complété qu'un nom inventé.
 */
function completer(segment: string, precedent: string): { valeur: string; complete: boolean } {
  const cur = decouper(segment);
  const prev = decouper(precedent);
  if (!cur.lettres) {
    // Segment purement numérique (« 3 » après « RKF1 ») : on reprend tout le
    // préfixe alphabétique du précédent.
    return prev.lettres
      ? { valeur: prev.lettres + cur.reste, complete: true }
      : { valeur: segment, complete: false };
  }
  if (cur.lettres.length >= prev.lettres.length) return { valeur: segment.toUpperCase(), complete: false };
  if (!prev.lettres.endsWith(cur.lettres)) return { valeur: segment.toUpperCase(), complete: false };
  const manquant = prev.lettres.slice(0, prev.lettres.length - cur.lettres.length);
  return { valeur: manquant + cur.lettres + cur.reste, complete: true };
}

/**
 * Décode un nom d'emplacement composé.
 *
 * Le nom peut arriver sous forme complète (« WH/Stock/Allée 1/A12-RKC1 ») :
 * seul le dernier maillon nous intéresse, les précédents sont l'arborescence
 * Odoo.
 */
export function decoderEmplacement(nom: string): EmplacementDecode {
  const brut = (nom || "").trim();
  const dernier = brut.split("/").pop()?.trim() || "";
  const segments = dernier.split("-").map(s => s.trim()).filter(Boolean);

  if (segments.length === 0) return { brut, picking: "", reserves: [], abrege: false };
  if (segments.length === 1) return { brut, picking: segments[0].toUpperCase(), reserves: [], abrege: false };

  const picking = segments[0].toUpperCase();
  const reserves: string[] = [];
  let abrege = false;
  let precedent = "";

  for (const seg of segments.slice(1)) {
    if (!precedent) {
      // Premier rack : rien à propager, il est écrit en entier par convention.
      reserves.push(seg.toUpperCase());
      precedent = seg;
      continue;
    }
    const { valeur, complete } = completer(seg, precedent);
    reserves.push(valeur);
    if (complete) abrege = true;
    // On propage à partir de la valeur COMPLÉTÉE : dans « RKF1-F2-3 », le
    // troisième segment doit hériter de RKF, pas de F.
    precedent = valeur;
  }

  return { brut, picking, reserves, abrege };
}

/** Tous les codes d'un emplacement — face de picking incluse. */
export function codesEmplacement(nom: string): string[] {
  const d = decoderEmplacement(nom);
  return [d.picking, ...d.reserves].filter(Boolean);
}

/**
 * Le code scanné correspond-il à cet emplacement ?
 *
 * Sert au scan d'une étiquette de rack : l'opérateur scanne « RKC11 », le WMS
 * doit reconnaître la ligne dont l'emplacement est « A12-RKC1-RKC11-RKC21 ».
 */
export function correspondAuCode(nomEmplacement: string, code: string): boolean {
  const cherche = (code || "").trim().toUpperCase();
  if (!cherche) return false;
  return codesEmplacement(nomEmplacement).includes(cherche);
}

export interface EmplacementRef { id: number; nom: string; articles: string[] }

export interface CollisionRack {
  code: string;
  emplacements: EmplacementRef[];
}

/**
 * Racks partagés par plusieurs emplacements.
 *
 * Un même rack déclaré sur deux articles, c'est soit une erreur de saisie, soit
 * deux articles réellement rangés au même endroit — dans les deux cas il faut
 * le savoir. On ne tranche pas : on montre.
 */
export function trouverCollisions(
  emplacements: EmplacementRef[],
): CollisionRack[] {
  const parCode: Record<string, EmplacementRef[]> = {};

  for (const e of emplacements) {
    const d = decoderEmplacement(e.nom);
    // La face de picking est exclue : plusieurs articles peuvent légitimement
    // partager une allée. Ce sont les RÉSERVES qui doivent être uniques.
    for (const rack of d.reserves) {
      (parCode[rack] ||= []).push(e);
    }
  }

  return Object.entries(parCode)
    .filter(([, liste]) => liste.length > 1)
    .map(([code, liste]) => ({ code, emplacements: liste }))
    .sort((a, b) => b.emplacements.length - a.emplacements.length || a.code.localeCompare(b.code));
}
