"use client";
// lib/useEcranEtroit.ts — détection de l'écran étroit d'un PDA
//
// Les écrans du WMS servent sur deux matériels très différents : un poste fixe
// et un scanner Zebra tenu à la main. Un tableau en colonnes est lisible sur le
// premier, illisible sur le second — la désignation est tronquée, les
// références s'écrasent, et les champs deviennent trop petits pour le doigt.
//
// Plutôt que de rétrécir des colonnes qui ne rentrent pas, les écrans
// concernés basculent sur une présentation en fiches empilées. Ce crochet dit
// simplement quand le faire, au même seuil partout : deux seuils différents
// finiraient par diverger.

import { useState, useEffect } from "react";

/** Largeur en dessous de laquelle un tableau en colonnes n'est plus lisible. */
export const SEUIL_ETROIT = 560;

export function useEcranEtroit(seuil: number = SEUIL_ETROIT): boolean {
  // Faux au premier rendu : le serveur ne connaît pas la taille de l'écran, et
  // supposer l'inverse provoquerait un décalage visible au chargement.
  const [etroit, setEtroit] = useState(false);

  useEffect(() => {
    const test = () => setEtroit(window.innerWidth < seuil);
    test();
    window.addEventListener("resize", test);
    // L'orientation compte autant que la taille : un PDA tourné en paysage
    // repasse au-dessus du seuil et retrouve le tableau.
    window.addEventListener("orientationchange", test);
    return () => {
      window.removeEventListener("resize", test);
      window.removeEventListener("orientationchange", test);
    };
  }, [seuil]);

  return etroit;
}
