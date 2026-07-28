"use client";
// lib/useScannerListener.ts
// ─────────────────────────────────────────────────────────────────────────────
// Écoute globale du scanner physique (Zebra / DataWedge en mode clavier).
//
// Le scanner « tape » le code très vite puis envoie un terminateur (Entrée ou
// Tab). On accumule les caractères dans un tampon et on déclenche le callback
// au terminateur, ou après 80 ms de silence.
//
// Intérêt par rapport à un simple onKeyDown sur un <input> : le scan marche
// SANS que le champ ait le focus. Sur PDA, focaliser le champ ouvrirait le
// clavier virtuel par-dessus l'écran, ce qu'on ne veut pas.
//
// Un champ de saisie peut porter data-keep-scan="1" pour que le scan y reste
// écrit (ex : saisir un EAN) au lieu d'être vidé après traitement.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useRef } from "react";

export function useScannerListener(onScan: (code: string) => void, enabled: boolean) {
  const buf     = useRef("");
  const timer   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTgt = useRef<EventTarget | null>(null);
  const cb      = useRef(onScan);
  cb.current = onScan; // toujours la dernière version, évite les closures périmées

  useEffect(() => {
    if (!enabled) return;

    // Champ de texte libre = saisie manuelle au clavier, pas un scan.
    const isTextInput = (el: EventTarget | null) => {
      if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return false;
      if (el instanceof HTMLTextAreaElement) return true;
      const t = (el as HTMLInputElement).type;
      return !t || t === "text" || t === "search" || t === "email" || t === "tel" || t === "url" || t === "password";
    };

    const flush = (tgt?: HTMLElement) => {
      // Filtre les caractères de contrôle injectés par certains DataWedge
      const code = buf.current.replace(/[^\x20-\x7EÀ-ɏ]/g, "").trim();
      buf.current = "";
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      if (code.length >= 3) {
        cb.current(code);
        // Vide le champ si le scan y est tombé — sauf s'il est marqué keep-scan
        if (tgt instanceof HTMLInputElement && tgt.dataset.keepScan !== "1") {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
          if (setter) { setter.call(tgt, ""); tgt.dispatchEvent(new Event("input", { bubbles: true })); }
        }
      }
    };

    const handle = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement;
      // Entrée / Tab = terminateur DataWedge
      if (e.key === "Enter" || e.key === "Tab") {
        if (buf.current.length >= 3) { e.preventDefault(); e.stopPropagation(); }
        flush(tgt instanceof HTMLInputElement ? tgt : undefined);
        return;
      }
      if (e.key.length !== 1) return; // ignore Shift, Ctrl, F1…
      buf.current += e.key;
      lastTgt.current = e.target;
      if (timer.current) clearTimeout(timer.current);
      // 80 ms : au-delà, c'est de la frappe humaine, pas un scan.
      timer.current = setTimeout(() => {
        if (isTextInput(lastTgt.current)) { buf.current = ""; timer.current = null; return; }
        flush();
      }, 80);
    };

    window.addEventListener("keydown", handle, true);
    return () => {
      window.removeEventListener("keydown", handle, true);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [enabled]);
}

export default useScannerListener;
