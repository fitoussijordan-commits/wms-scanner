// lib/chariotLocal.ts
// Cache mémoire de la liste des SKU du chariot e-shop, partagé entre l'écran
// d'accueil (détection des articles « Chariot Eshop » pendant le prélèvement) et
// l'écran de configuration. Doit rester dans UN SEUL module : deux copies
// donneraient deux caches désynchronisés.
// La source de vérité reste Odoo (ir.attachment), via odoo.loadChariotSkus().

let _chariotSkusCache: string[] | null = null;

export function getChariotSkusLocal(): string[] {
  if (_chariotSkusCache !== null) return _chariotSkusCache;
  _chariotSkusCache = [];
  return _chariotSkusCache;
}

export function setChariotSkusLocal(skus: string[]) {
  _chariotSkusCache = skus;
}
