/**
 * Token envoyé par le client sur les actions d'ÉCRITURE Shopware (setStock…).
 * C'est un token "outil interne" (NEXT_PUBLIC) : il bloque les appels anonymes
 * externes/scanners, sans prétendre à une sécurité forte (il est lisible dans le bundle).
 * La vraie barrière reste : creds serveur uniquement + rate limit + repo privé.
 */
export const writeHeaders: Record<string, string> = (() => {
  const t = process.env.NEXT_PUBLIC_WMS_TOKEN || "";
  const h: Record<string, string> = {};
  if (t) h["x-wms-token"] = t;
  return h;
})();
