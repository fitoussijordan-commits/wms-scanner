"use client";
// components/ColissimoScreen.tsx — Expédition Colissimo en direct
//
// Remplace la ressaisie sur le portail La Poste : on scanne le OUT (ou le pick,
// ou la référence de commande), Odoo fournit l'adresse, l'opérateur choisit
// l'offre et le poids, l'étiquette sort sur l'imprimante.
//
// La saisie libre reste possible : tous les envois ne viennent pas d'un
// transfert Odoo, et un écran qui impose un préalable devient un écran qu'on
// contourne.

import { useState, useEffect, useCallback } from "react";
import * as odoo from "@/lib/odoo";
import { writeHeaders } from "@/lib/writeToken";
import { listPrinters, printPdfLabel, type PrintNodePrinter } from "@/lib/printnode";
import { useEcranEtroit } from "@/lib/useEcranEtroit";

const C = {
  bg: "#f8fafc", white: "#fff", text: "#0f172a", textSec: "#374151",
  textMuted: "#64748b", border: "#e2e8f0", blue: "#2563eb", blueSoft: "#eff6ff",
  green: "#16a34a", greenSoft: "#f0fdf4", red: "#dc2626", redSoft: "#fef2f2",
  orange: "#ea580c", orangeSoft: "#fff7ed",
};

interface Offre { code: string; libelle: string; relais: boolean }

interface Saisie {
  nom: string; societe: string; adresse: string; adresse2: string;
  cp: string; ville: string; pays: string; email: string; telephone: string;
  poids: string; reference: string; offre: string; pointRetrait: string;
}

const VIDE: Saisie = {
  nom: "", societe: "", adresse: "", adresse2: "", cp: "", ville: "", pays: "FR",
  email: "", telephone: "", poids: "", reference: "", offre: "DOM", pointRetrait: "",
};

export default function ColissimoScreen({
  session, onBack, onToast, refInitiale,
}: {
  session: odoo.OdooSession;
  onBack: () => void;
  onToast: (m: string, t?: "success" | "error" | "info") => void;
  /** Pré-remplissage immédiat, quand l'écran est ouvert depuis l'emballage. */
  refInitiale?: string;
}) {
  const etroit = useEcranEtroit();

  const [config, setConfig] = useState<{ configure: boolean; authentification: string; test: boolean; expediteurManquant: string[]; offres: Offre[] } | null>(null);
  const [recherche, setRecherche] = useState(refInitiale || "");
  const [chargement, setChargement] = useState(false);
  const [livraison, setLivraison] = useState<odoo.LivraisonColissimo | null>(null);
  const [s, setS] = useState<Saisie>(VIDE);
  const [envoi, setEnvoi] = useState(false);
  const [resultat, setResultat] = useState<{ numero: string; etiquetteBase64: string; test: boolean } | null>(null);
  const [imprimantes, setImprimantes] = useState<PrintNodePrinter[]>([]);
  const [imprimante, setImprimante] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/colissimo?action=config").then(r => r.json()).then(setConfig).catch(() => {});
    listPrinters().then(p => {
      setImprimantes(p);
      const memo = Number(localStorage.getItem("colissimo_printer") || "");
      setImprimante(memo && p.some(x => x.id === memo) ? memo : (p[0]?.id ?? null));
    }).catch(() => {});
  }, []);

  const charger = useCallback(async (ref: string) => {
    const q = ref.trim();
    if (!q) return;
    setChargement(true); setResultat(null);
    try {
      const l = await odoo.chargerLivraison(session, q);
      if (!l) { onToast(`Aucun transfert trouvé pour ${q}`, "error"); setChargement(false); return; }
      setLivraison(l);
      setS(prev => ({
        ...prev,
        nom: l.nom, societe: l.societe, adresse: l.adresse, adresse2: l.adresse2,
        cp: l.cp, ville: l.ville, pays: l.pays || "FR",
        email: l.email, telephone: l.telephone,
        poids: l.poids > 0 ? String(l.poids) : "",
        // Référence colis = commande de vente Odoo (S…). C'est le numéro que
        // le service client cherchera en cas de litige ; le nom du transfert
        // ne parle qu'au magasin.
        reference: l.commande || l.origin || l.pickingName,
      }));
      if (l.manquants.length) onToast(`À compléter : ${l.manquants.join(", ")}`, "info");
    } catch (e: any) { onToast("Erreur : " + (e?.message || e), "error"); }
    setChargement(false);
  }, [session, onToast]);

  useEffect(() => { if (refInitiale) charger(refInitiale); }, [refInitiale, charger]);

  const offreCourante = config?.offres.find(o => o.code === s.offre);

  const creer = async (verifier: boolean) => {
    if (!s.nom || !s.adresse || !s.cp || !s.ville) { onToast("Nom, adresse, code postal et ville sont requis", "error"); return; }
    const poids = parseFloat(String(s.poids).replace(",", "."));
    if (!(poids > 0)) { onToast("Poids requis (en kg)", "error"); return; }

    setEnvoi(true);
    try {
      const r = await fetch(`/api/colissimo?action=${verifier ? "check" : "label"}`, {
        method: "POST",
        headers: { ...writeHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ ...s, poids }),
      }).then(x => x.json());

      if (r?.error) throw new Error(r.error);

      if (verifier) { onToast("✓ Requête valide — aucun colis créé", "success"); setEnvoi(false); return; }

      setResultat({ numero: r.numero, etiquetteBase64: r.etiquetteBase64, test: !!r.test });
      onToast(`✓ Colis ${r.numero}`, "success");

      // Suivi dans Odoo : sans ça, le numéro n'existe que sur un bout de papier.
      if (livraison?.pickingId && r.numero) {
        try {
          await odoo.ecrireSuiviColissimo(session, livraison.pickingId, r.numero);
          setLivraison(prev => prev ? { ...prev, suiviExistant: r.numero } : prev);
        } catch (e: any) {
          onToast("Étiquette créée mais suivi non écrit dans Odoo : " + (e?.message || e), "error");
        }
      }

      // Impression immédiate. Un échec d'impression ne remet pas en cause le
      // colis : il est créé, l'étiquette reste téléchargeable.
      if (imprimante && r.etiquetteBase64) {
        const p = await printPdfLabel(imprimante, r.etiquetteBase64, `Colissimo ${r.numero}`);
        if (!p.success) onToast("Impression échouée — utilise « Télécharger »", "error");
      }
    } catch (e: any) {
      onToast("❌ " + (e?.message || e), "error");
    }
    setEnvoi(false);
  };

  const telecharger = () => {
    if (!resultat) return;
    const bin = atob(resultat.etiquetteBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    const a = document.createElement("a");
    a.href = url; a.download = `colissimo-${resultat.numero}.pdf`; a.click();
    URL.revokeObjectURL(url);
  };

  const champ = (cle: keyof Saisie, libelle: string, opts: { large?: boolean; type?: string; requis?: boolean; aide?: string } = {}) => (
    <div style={{ flex: opts.large ? "1 1 100%" : "1 1 160px", minWidth: 0 }}>
      <label style={{ fontSize: 10.5, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: .4, display: "block", marginBottom: 3 }}>
        {libelle}{opts.requis && <span style={{ color: C.red }}> *</span>}
      </label>
      <input
        value={s[cle]} type={opts.type || "text"}
        onChange={e => setS(prev => ({ ...prev, [cle]: e.target.value }))}
        onKeyDown={e => e.stopPropagation()}
        style={{ width: "100%", boxSizing: "border-box", padding: etroit ? "11px 12px" : "9px 11px",
                 border: `1.5px solid ${opts.requis && !s[cle] ? "#fca5a5" : C.border}`, borderRadius: 9,
                 fontSize: etroit ? 14.5 : 13.5, fontFamily: "inherit", outline: "none", color: C.text }} />
      {opts.aide && <div style={{ fontSize: 10.5, color: C.textMuted, marginTop: 2 }}>{opts.aide}</div>}
    </div>
  );

  return (
    <div style={{ padding: etroit ? 12 : 20, maxWidth: 760, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <button onClick={onBack} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.textMuted, padding: 4 }}>←</button>
        <div style={{ flex: 1 }}>
          <h2 style={{ fontSize: 18, fontWeight: 800, color: C.text, margin: 0 }}>📮 Expédition Colissimo</h2>
          <div style={{ fontSize: 12, color: C.textMuted }}>
            Étiquette La Poste en direct, sans ressaisie
            {config?.authentification && <span> · {config.authentification}</span>}
          </div>
        </div>
      </div>

      {/* État de la configuration : un écran qui échoue au moment d'affranchir
          fait perdre bien plus de temps qu'un avertissement à l'ouverture. */}
      {config && !config.configure && (
        <div style={{ background: C.redSoft, border: "1px solid #fecaca", borderRadius: 11, padding: 12, marginBottom: 14, fontSize: 12.5, color: "#7f1d1d" }}>
          <strong>Colissimo n&apos;est pas configuré.</strong> Il faut, au choix, <code>COLISSIMO_API_KEY</code> (clé générée depuis l&apos;espace client Colissimo), ou <code>COLISSIMO_CONTRACT</code> + <code>COLISSIMO_PASSWORD</code> (numéro de contrat et mot de passe fournis par La Poste).
        </div>
      )}
      {config?.configure && config.expediteurManquant.length > 0 && (
        <div style={{ background: C.orangeSoft, border: "1px solid #fed7aa", borderRadius: 11, padding: 12, marginBottom: 14, fontSize: 12.5, color: "#7c2d12" }}>
          <strong>Adresse expéditeur incomplète</strong> — à renseigner : {config.expediteurManquant.join(", ")}
        </div>
      )}
      {config?.test && (
        <div style={{ background: "#fefce8", border: "1px solid #fde047", borderRadius: 11, padding: 10, marginBottom: 14, fontSize: 12.5, color: "#854d0e", fontWeight: 600 }}>
          ⚠ Mode bac à sable — les étiquettes générées ne sont pas valables pour un envoi réel.
        </div>
      )}

      {/* Chargement depuis Odoo */}
      <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, padding: 12, marginBottom: 12 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: C.text, marginBottom: 6 }}>Charger depuis Odoo</div>
        <div style={{ display: "flex", gap: 6 }}>
          <input value={recherche} onChange={e => setRecherche(e.target.value)}
            onKeyDown={e => { e.stopPropagation(); if (e.key === "Enter") charger(recherche); }}
            placeholder="N° de commande (S…), de OUT ou de pick…"
            style={{ flex: 1, minWidth: 0, boxSizing: "border-box", padding: etroit ? "12px" : "10px 12px", border: `1.5px solid ${C.border}`, borderRadius: 9, fontSize: etroit ? 14.5 : 13.5, fontFamily: "inherit", outline: "none" }} />
          <button onClick={() => charger(recherche)} disabled={chargement}
            style={{ padding: etroit ? "12px 16px" : "10px 18px", background: C.blue, color: "#fff", border: "none", borderRadius: 9, fontSize: 13.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", opacity: chargement ? .6 : 1, flexShrink: 0 }}>
            {chargement ? "…" : "Charger"}
          </button>
        </div>
        <div style={{ fontSize: 11, color: C.textMuted, marginTop: 5 }}>
          Facultatif — tu peux aussi tout saisir à la main ci-dessous.
        </div>

        {livraison && (
          <div style={{ marginTop: 10, background: C.blueSoft, border: `1px solid #bfdbfe`, borderRadius: 9, padding: 10, fontSize: 12 }}>
            <div style={{ fontWeight: 700, color: C.text }}>
              {livraison.pickingName}
              {livraison.commande && <span style={{ color: C.textMuted, fontWeight: 500 }}> · commande {livraison.commande}</span>}
              {!livraison.commande && livraison.origin && <span style={{ color: C.textMuted, fontWeight: 500 }}> · {livraison.origin}</span>}
            </div>
            {livraison.transporteur && <div style={{ color: C.textSec, marginTop: 2 }}>Transporteur Odoo : {livraison.transporteur}</div>}
            {livraison.suiviExistant && (
              <div style={{ color: C.orange, fontWeight: 700, marginTop: 3 }}>
                ⚠ Ce transfert porte déjà le suivi {livraison.suiviExistant} — un nouvel affranchissement serait facturé en plus.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Destinataire */}
      <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, padding: 12, marginBottom: 12 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: C.text, marginBottom: 8 }}>Destinataire</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {champ("nom", "Nom", { requis: true, large: etroit })}
          {champ("societe", "Société", { large: etroit })}
          {champ("adresse", "Adresse", { requis: true, large: true })}
          {champ("adresse2", "Complément", { large: true })}
          {champ("cp", "Code postal", { requis: true })}
          {champ("ville", "Ville", { requis: true })}
          {champ("pays", "Pays", { aide: "Code à 2 lettres" })}
          {champ("email", "E-mail", { type: "email", large: etroit })}
          {champ("telephone", "Téléphone", { aide: "Requis pour les points de retrait" })}
        </div>
      </div>

      {/* Envoi */}
      <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, padding: 12, marginBottom: 12 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: C.text, marginBottom: 8 }}>Envoi</div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
          {(config?.offres || []).map(o => (
            <button key={o.code} onClick={() => setS(prev => ({ ...prev, offre: o.code }))}
              style={{ padding: etroit ? "11px 13px" : "9px 13px", borderRadius: 9, cursor: "pointer", fontFamily: "inherit",
                       border: `1.5px solid ${s.offre === o.code ? C.blue : C.border}`,
                       background: s.offre === o.code ? C.blueSoft : C.white,
                       color: s.offre === o.code ? C.blue : C.textSec,
                       fontSize: etroit ? 13 : 12.5, fontWeight: 700 }}>
              {o.libelle}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {champ("poids", "Poids (kg)", { requis: true, aide: livraison && livraison.poids > 0 ? "Repris du transfert Odoo" : "À peser" })}
          {champ("reference", "Référence", { aide: "Reportée sur l'étiquette" })}
        </div>

        {offreCourante?.relais && (
          <div style={{ marginTop: 10 }}>
            {champ("pointRetrait", "Identifiant du point de retrait", { requis: true, large: true })}
            <div style={{ fontSize: 11.5, color: "#7c2d12", background: C.orangeSoft, border: "1px solid #fed7aa", borderRadius: 8, padding: 8, marginTop: 6 }}>
              La recherche de points relais relève d&apos;une autre API La Poste, qui n&apos;est pas encore branchée. En attendant, l&apos;identifiant doit être collé à la main.
            </div>
          </div>
        )}
      </div>

      {/* Imprimante */}
      {imprimantes.length > 0 && (
        <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, padding: 12, marginBottom: 12 }}>
          <label style={{ fontSize: 10.5, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: .4, display: "block", marginBottom: 4 }}>Imprimante</label>
          <select value={imprimante ?? ""}
            onChange={e => { const v = Number(e.target.value); setImprimante(v); localStorage.setItem("colissimo_printer", String(v)); }}
            style={{ width: "100%", boxSizing: "border-box", padding: etroit ? "11px" : "9px 11px", border: `1.5px solid ${C.border}`, borderRadius: 9, fontSize: 13.5, fontFamily: "inherit", background: C.white }}>
            {imprimantes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      )}

      {/* Actions */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <button onClick={() => creer(true)} disabled={envoi || !config?.configure}
          title="Valide la requête auprès de La Poste sans créer de colis ni facturer"
          style={{ flex: "1 1 180px", padding: 13, background: C.white, color: C.textSec, border: `1.5px solid ${C.border}`, borderRadius: 11, fontSize: 13.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", opacity: envoi ? .6 : 1 }}>
          Vérifier sans créer
        </button>
        <button onClick={() => creer(false)} disabled={envoi || !config?.configure}
          style={{ flex: "2 1 240px", padding: 13, background: envoi ? "#94a3b8" : C.green, color: "#fff", border: "none", borderRadius: 11, fontSize: 15, fontWeight: 800, cursor: "pointer", fontFamily: "inherit" }}>
          {envoi ? "Création…" : "Créer l'étiquette et imprimer"}
        </button>
      </div>

      {/* Résultat */}
      {resultat && (
        <div style={{ background: C.greenSoft, border: "1px solid #bbf7d0", borderRadius: 12, padding: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: "#15803d" }}>✓ Colis créé</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: C.text, fontFamily: "monospace", margin: "6px 0", wordBreak: "break-all" }}>
            {resultat.numero}
          </div>
          {livraison?.pickingId && (
            <div style={{ fontSize: 12, color: "#166534" }}>Suivi inscrit sur {livraison.pickingName}.</div>
          )}
          <button onClick={telecharger}
            style={{ marginTop: 10, width: "100%", padding: 11, background: C.white, color: C.text, border: `1.5px solid ${C.border}`, borderRadius: 9, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
            ⬇ Télécharger l&apos;étiquette (PDF)
          </button>
        </div>
      )}
    </div>
  );
}
