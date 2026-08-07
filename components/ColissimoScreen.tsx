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

interface PointRetrait {
  id: string; nom: string; adresse: string; cp: string; ville: string;
  distance: number; type: string; poidsMaxKg: number | null;
  accesPMR: boolean; conges: boolean;
  horaires: Record<string, string>;
}

/**
 * Filtres de réseau proposés par La Poste.
 *
 * On n'expose pas les sept valeurs documentées : trois suffisent à couvrir les
 * cas réels, et un menu de sept lignes sur un PDA fait choisir au hasard.
 */
const FILTRES = [
  { code: "1", libelle: "Tous les points" },
  { code: "0", libelle: "Bureaux de poste" },
  { code: "3", libelle: "Commerçants Pickup" },
];

/** « 09:00-12:00 14:00-18:00 » ou « fermé » quand les deux plages sont nulles. */
function horaireLisible(h: string): string {
  if (!h) return "—";
  const plages = h.split(" ").filter(p => p && p !== "00:00-00:00");
  return plages.length ? plages.join("  ") : "fermé";
}

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

  // ── Points de retrait ──────────────────────────────────────────────────────
  const [points, setPoints] = useState<PointRetrait[] | null>(null);
  const [pointsBusy, setPointsBusy] = useState(false);
  const [pointsErreur, setPointsErreur] = useState("");
  const [filtre, setFiltre] = useState("1");
  const [pointChoisi, setPointChoisi] = useState<PointRetrait | null>(null);

  const chercherPoints = async (f = filtre) => {
    if (!s.cp || !s.ville) { onToast("Renseigne d'abord le code postal et la ville du destinataire", "error"); return; }
    setPointsBusy(true); setPointsErreur("");
    try {
      const r = await fetch("/api/colissimo?action=relais", {
        method: "POST",
        headers: { ...writeHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          adresse: s.adresse, cp: s.cp, ville: s.ville, pays: s.pays,
          poids: parseFloat(String(s.poids).replace(",", ".")) || 1,
          filtre: f, reference: s.reference,
        }),
      }).then(x => x.json());
      if (r?.error) throw new Error(r.error);
      setPoints(r.points || []);
      if (!r.points?.length) setPointsErreur("Aucun point trouvé autour de cette adresse.");
    } catch (e: any) {
      setPoints(null);
      setPointsErreur(e?.message || "Recherche impossible");
    }
    setPointsBusy(false);
  };

  const choisirPoint = (p: PointRetrait) => {
    setPointChoisi(p);
    setS(prev => ({ ...prev, pointRetrait: p.id }));
    setPoints(null);
  };

  // Changer d'offre ou d'adresse invalide le point retenu : le laisser en place
  // ferait partir un colis vers un point qui ne correspond plus.
  useEffect(() => { setPointChoisi(null); setPoints(null); setS(prev => ({ ...prev, pointRetrait: "" })); },
    [s.offre, s.cp, s.ville]);

  const creer = async (verifier: boolean) => {
    if (!s.nom || !s.adresse || !s.cp || !s.ville) { onToast("Nom, adresse, code postal et ville sont requis", "error"); return; }
    const poids = parseFloat(String(s.poids).replace(",", "."));
    if (!(poids > 0)) { onToast("Poids requis (en kg)", "error"); return; }

    if (offreCourante?.relais) {
      if (!s.pointRetrait) { onToast("Choisis d'abord un point de retrait", "error"); return; }
      // Le SMS de mise à disposition part sur le mobile du destinataire :
      // sans numéro, il ne saura pas que son colis est arrivé.
      if (!verifier && !s.telephone && !confirm(
        "Aucun téléphone pour le destinataire.\n\n" +
        "C'est par SMS que La Poste prévient qu'un colis est disponible en point de retrait.\n\n" +
        "Créer l'étiquette quand meme ?"
      )) return;
    }

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

      // Registre du WMS : un colis créé en saisie libre n'existe nulle part
      // dans Odoo. Sans cette trace, il sortirait du bordereau du soir — donc
      // partirait sans preuve de remise.
      try {
        const sb = await import("@/lib/supabase");
        await sb.enregistrerColisColissimo({
          numero: r.numero,
          pickingName: livraison?.pickingName,
          pickingId: livraison?.pickingId ?? null,
          client: s.nom,
          offre: s.offre,
          poids,
          reference: s.reference,
          creePar: session.name || session.login,
        });
      } catch (e: any) {
        onToast("Colis créé mais non inscrit au registre — à ajouter au bordereau à la main", "error");
      }

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
    telechargerPdf(resultat.etiquetteBase64, `colissimo-${resultat.numero}.pdf`);
  };

  // ── Bordereau de dépôt (fin de journée) ────────────────────────────────────
  // Une fois tamponné par La Poste, il atteste de la remise des colis. Sans lui,
  // un colis perdu est un colis dont on ne peut pas prouver qu'il est parti.
  const [bordOuvert, setBordOuvert] = useState(false);
  const [bordJour, setBordJour] = useState(() => new Date().toISOString().slice(0, 10));
  const [bordColis, setBordColis] = useState<{ numero: string; picking: string; client: string; remis?: string }[] | null>(null);
  const [bordExclus, setBordExclus] = useState<Set<string>>(new Set());
  const [bordBusy, setBordBusy] = useState(false);
  const [bordFait, setBordFait] = useState<{ numero: string; colis: number; pdfBase64: string } | null>(null);
  // Diagnostic : quand la liste sort vide alors qu'on a expédié, il faut savoir
  // OÙ ça coince — registre, date, ou nom du transporteur.
  const [bordDiag, setBordDiag] = useState<{ registre: number; odooTotal: number; transporteurs: string[]; retenus: number } | null>(null);

  /**
   * Colis du jour : registre du WMS ET transferts Odoo.
   *
   * Le registre couvre la saisie libre, Odoo couvre les colis affranchis avant
   * la mise en place du registre. On prend l'union — un colis oublié sur le
   * bordereau, c'est une preuve de remise en moins.
   */
  const listerColis = async () => {
    setBordBusy(true); setBordFait(null); setBordExclus(new Set());
    try {
      const sb = await import("@/lib/supabase");
      const diag = { trouves: 0, transporteurs: [] as string[] };
      const [registre, depuisOdoo] = await Promise.all([
        sb.colisColissimoDuJour(bordJour).catch(() => []),
        odoo.colisColissimoDuJour(session, bordJour, diag).catch(() => []),
      ]);
      setBordDiag({ registre: registre.length, odooTotal: diag.trouves, transporteurs: diag.transporteurs, retenus: depuisOdoo.length });

      const parNumero = new Map<string, { numero: string; picking: string; client: string; remis?: string }>();
      for (const c of registre) {
        parNumero.set(c.numero, {
          numero: c.numero,
          picking: c.picking_name || c.reference || "saisie libre",
          client: c.client || "",
          remis: c.bordereau || undefined,
        });
      }
      for (const c of depuisOdoo) if (!parNumero.has(c.numero)) parNumero.set(c.numero, c);

      const liste = Array.from(parNumero.values());
      setBordColis(liste);
      // Les colis déjà portés sur un bordereau sont décochés d'office : les
      // remettre créerait un second bordereau pour les mêmes colis.
      setBordExclus(new Set(liste.filter(c => c.remis).map(c => c.numero)));
      if (!liste.length) onToast("Aucun colis Colissimo affranchi ce jour-là", "info");
    } catch (e: any) { onToast("Erreur : " + (e?.message || e), "error"); }
    setBordBusy(false);
  };

  const editerBordereau = async () => {
    const retenus = (bordColis || []).filter(c => !bordExclus.has(c.numero)).map(c => c.numero);
    if (!retenus.length) { onToast("Aucun colis retenu", "error"); return; }
    setBordBusy(true);
    try {
      const r = await fetch("/api/colissimo?action=bordereau", {
        method: "POST",
        headers: { ...writeHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ numeros: retenus }),
      }).then(x => x.json());
      if (r?.error) throw new Error(r.error);
      setBordFait(r);
      onToast(`✓ Bordereau ${r.numero || ""} — ${r.colis} colis`, "success");

      // Marqués comme remis : ils ne réapparaîtront pas dans le bordereau
      // suivant, où ils feraient double emploi.
      try {
        const sb = await import("@/lib/supabase");
        await sb.marquerBordereau(retenus, r.numero || "");
        setBordColis(prev => prev?.map(c =>
          retenus.includes(c.numero) ? { ...c, remis: r.numero || "édité" } : c) || null);
        setBordExclus(new Set(retenus));
      } catch { /* le bordereau est édité, c'est l'essentiel */ }
      if (imprimante && r.pdfBase64) {
        const p = await printPdfLabel(imprimante, r.pdfBase64, `Bordereau ${r.numero || bordJour}`);
        if (!p.success) onToast("Impression échouée — utilise « Télécharger »", "error");
      }
    } catch (e: any) { onToast("❌ " + (e?.message || e), "error"); }
    setBordBusy(false);
  };

  /**
   * Ajout manuel de numéros de colis.
   *
   * Le WMS ne connaît que ce qu'il a lui-même affranchi. Un colis fait sur le
   * portail La Poste, ou avant la mise en service, n'apparaîtrait jamais — et
   * partirait donc sans figurer sur la preuve de remise. On peut coller ou
   * scanner les numéros manquants.
   */
  const [bordAjout, setBordAjout] = useState("");
  const ajouterNumeros = () => {
    // Un scanner enchaîne les numéros par retour ligne ; un copier-coller de
    // tableur les sépare par tabulation ou point-virgule. On accepte tout.
    const bruts = bordAjout.split(/[\s,;]+/).map(n => n.trim()).filter(Boolean);
    if (!bruts.length) return;
    const existants = new Set((bordColis || []).map(c => c.numero));
    const nouveaux = bruts
      .filter(n => !existants.has(n))
      .map(n => ({ numero: n, picking: "ajouté à la main", client: "" }));
    if (!nouveaux.length) { onToast("Ces numéros sont déjà dans la liste", "info"); setBordAjout(""); return; }
    setBordColis(prev => [...(prev || []), ...nouveaux]);
    setBordAjout("");
    onToast(`${nouveaux.length} colis ajouté(s)`, "success");
  };

  const [bordRelire, setBordRelire] = useState("");
  const relireBordereau = async () => {
    const num = bordRelire.trim();
    if (!num) return;
    setBordBusy(true);
    try {
      const r = await fetch("/api/colissimo?action=bordereau_relire", {
        method: "POST",
        headers: { ...writeHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ numero: num }),
      }).then(x => x.json());
      if (r?.error) throw new Error(r.error);
      setBordFait({ numero: r.numero, colis: 0, pdfBase64: r.pdfBase64 });
      if (imprimante && r.pdfBase64) await printPdfLabel(imprimante, r.pdfBase64, `Bordereau ${r.numero}`);
      onToast(`✓ Bordereau ${r.numero} récupéré`, "success");
    } catch (e: any) { onToast("❌ " + (e?.message || e), "error"); }
    setBordBusy(false);
  };

  const telechargerPdf = (base64: string, nom: string) => {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    const a = document.createElement("a");
    a.href = url; a.download = nom; a.click();
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

      {/* Bordereau de dépôt — replié, c'est une action de fin de journée */}
      <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, marginBottom: 12, overflow: "hidden" }}>
        <button onClick={() => { setBordOuvert(v => !v); if (!bordOuvert && !bordColis) listerColis(); }}
          style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: 12, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>📋 Bordereau de dépôt</div>
            <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 2 }}>
              Preuve de remise à faire tamponner par La Poste, en fin de journée
            </div>
          </div>
          <span style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, flexShrink: 0 }}>
            {bordOuvert ? "▲ Fermer" : "▼ Ouvrir"}
          </span>
        </button>

        {bordOuvert && (
          <div style={{ padding: "0 12px 12px" }}>
            <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
              <input type="date" value={bordJour} onChange={e => { setBordJour(e.target.value); setBordColis(null); setBordFait(null); }}
                style={{ flex: 1, minWidth: 0, boxSizing: "border-box", padding: etroit ? "11px" : "9px 11px", border: `1.5px solid ${C.border}`, borderRadius: 9, fontSize: 13.5, fontFamily: "inherit" }} />
              <button onClick={listerColis} disabled={bordBusy}
                style={{ padding: etroit ? "11px 15px" : "9px 16px", background: C.blue, color: "#fff", border: "none", borderRadius: 9, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", opacity: bordBusy ? .6 : 1, flexShrink: 0 }}>
                {bordBusy ? "…" : "Lister"}
              </button>
            </div>

            {bordColis && bordColis.length > 0 && (
              <>
                <div style={{ fontSize: 11.5, color: C.textMuted, marginBottom: 6 }}>
                  {bordColis.length - bordExclus.size} colis retenu(s) sur {bordColis.length}. Décoche ce qui ne part pas aujourd&apos;hui.
                </div>
                <div style={{ maxHeight: 240, overflowY: "auto", border: `1px solid ${C.border}`, borderRadius: 9, marginBottom: 10 }}>
                  {bordColis.map(c => {
                    const exclu = bordExclus.has(c.numero);
                    return (
                      <label key={c.numero} style={{ display: "flex", gap: 9, alignItems: "flex-start", padding: "9px 10px", borderBottom: `1px solid ${C.border}`, cursor: "pointer", opacity: exclu ? .45 : 1 }}>
                        <input type="checkbox" checked={!exclu}
                          onChange={() => setBordExclus(prev => {
                            const s2 = new Set(prev);
                            exclu ? s2.delete(c.numero) : s2.add(c.numero);
                            return s2;
                          })}
                          style={{ width: 17, height: 17, marginTop: 1, flexShrink: 0, accentColor: C.green }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "monospace", color: C.text, wordBreak: "break-all" }}>{c.numero}</div>
                          <div style={{ fontSize: 11.5, color: C.textMuted, lineHeight: 1.35 }}>
                            {c.picking}{c.client ? ` · ${c.client}` : ""}
                          </div>
                          {c.remis && (
                            <div style={{ fontSize: 11, color: C.orange, fontWeight: 700 }}>
                              Déjà porté sur le bordereau {c.remis}
                            </div>
                          )}
                        </div>
                      </label>
                    );
                  })}
                </div>
                <button onClick={editerBordereau} disabled={bordBusy || bordColis.length === bordExclus.size}
                  style={{ width: "100%", padding: 13, background: bordBusy ? "#94a3b8" : "#0f172a", color: "#fff", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 800, cursor: "pointer", fontFamily: "inherit" }}>
                  {bordBusy ? "Édition…" : `Éditer le bordereau (${bordColis.length - bordExclus.size} colis)`}
                </button>
              </>
            )}

            {bordColis && bordColis.length === 0 && (
              <div style={{ fontSize: 12.5, color: C.textMuted, marginBottom: 10 }}>
                Aucun colis affranchi depuis le WMS ce jour-là. Les colis créés sur le portail
                La Poste ne sont pas connus d&apos;ici — ajoute leurs numéros ci-dessous.
              </div>
            )}

            {/* Ce qu'on a réellement trouvé, source par source. Sans ça,
                « aucun colis » ne dit pas si c'est la date, le transporteur ou
                le registre qui est en cause. */}
            {bordDiag && (
              <details style={{ marginBottom: 10 }}>
                <summary style={{ fontSize: 11.5, color: C.textMuted, cursor: "pointer", fontWeight: 600 }}>
                  Détail de la recherche
                </summary>
                <div style={{ marginTop: 6, fontSize: 11.5, color: C.textMuted, lineHeight: 1.6, background: C.bg, borderRadius: 8, padding: 9 }}>
                  <div>Registre WMS : <strong>{bordDiag.registre}</strong> colis</div>
                  <div>Transferts Odoo avec un n° de suivi ce jour-là : <strong>{bordDiag.odooTotal}</strong></div>
                  <div>… dont retenus comme Colissimo : <strong>{bordDiag.retenus}</strong></div>
                  {bordDiag.transporteurs.length > 0 && (
                    <div style={{ marginTop: 3 }}>
                      Transporteurs rencontrés : {bordDiag.transporteurs.join(", ")}
                    </div>
                  )}
                  {bordDiag.odooTotal > 0 && bordDiag.retenus === 0 && (
                    <div style={{ color: C.orange, fontWeight: 700, marginTop: 4 }}>
                      Des transferts existent mais aucun transporteur n&apos;est reconnu comme La Poste — dis-moi le nom exact.
                    </div>
                  )}
                </div>
              </details>
            )}

            {/* Saisie manuelle : couvre les colis faits hors WMS. */}
            <div style={{ marginTop: bordColis?.length ? 4 : 0 }}>
              <div style={{ fontSize: 11.5, color: C.textMuted, marginBottom: 5 }}>
                Ajouter des numéros de colis (scan, ou collés à la suite) :
              </div>
              <textarea value={bordAjout} onChange={e => setBordAjout(e.target.value)}
                onKeyDown={e => e.stopPropagation()}
                rows={2}
                placeholder="6A12345678901&#10;6C98765432109"
                style={{ width: "100%", boxSizing: "border-box", padding: "10px 11px", border: `1.5px solid ${C.border}`, borderRadius: 9, fontSize: 13.5, fontFamily: "monospace", outline: "none", resize: "vertical" }} />
              <button onClick={ajouterNumeros} disabled={!bordAjout.trim()}
                style={{ width: "100%", marginTop: 6, padding: 10, background: C.white, color: C.text, border: `1.5px solid ${C.border}`, borderRadius: 9, fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                + Ajouter à la liste
              </button>
            </div>

            {/* Réimpression : le bordereau existe déjà chez La Poste, on le
                redemande au lieu d'en créer un second pour les mêmes colis. */}
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 11.5, color: C.textMuted, marginBottom: 5 }}>
                Réimprimer un bordereau déjà édité :
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <input value={bordRelire} onChange={e => setBordRelire(e.target.value)}
                  onKeyDown={e => e.stopPropagation()}
                  placeholder="N° de bordereau"
                  style={{ flex: 1, minWidth: 0, boxSizing: "border-box", padding: etroit ? "11px" : "9px 11px", border: `1.5px solid ${C.border}`, borderRadius: 9, fontSize: 13, fontFamily: "inherit", outline: "none" }} />
                <button onClick={relireBordereau} disabled={bordBusy || !bordRelire.trim()}
                  style={{ padding: etroit ? "11px 15px" : "9px 15px", background: C.white, color: C.textSec, border: `1.5px solid ${C.border}`, borderRadius: 9, fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", flexShrink: 0 }}>
                  Récupérer
                </button>
              </div>
            </div>

            {bordFait && (
              <div style={{ marginTop: 10, background: C.greenSoft, border: "1px solid #bbf7d0", borderRadius: 10, padding: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: "#15803d" }}>
                  ✓ Bordereau {bordFait.colis > 0 ? `édité — ${bordFait.colis} colis` : "récupéré"}
                </div>
                {bordFait.numero && (
                  <div style={{ fontSize: 16, fontWeight: 800, fontFamily: "monospace", color: C.text, marginTop: 4, wordBreak: "break-all" }}>{bordFait.numero}</div>
                )}
                <button onClick={() => telechargerPdf(bordFait.pdfBase64, `bordereau-${bordJour}.pdf`)}
                  style={{ marginTop: 9, width: "100%", padding: 10, background: C.white, color: C.text, border: `1.5px solid ${C.border}`, borderRadius: 9, fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                  ⬇ Télécharger le bordereau (PDF)
                </button>
              </div>
            )}
          </div>
        )}
      </div>

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
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: C.text, marginBottom: 6 }}>Point de retrait</div>

            {pointChoisi ? (
              <div style={{ background: C.greenSoft, border: "1px solid #bbf7d0", borderRadius: 10, padding: 11 }}>
                <div style={{ fontSize: 14, fontWeight: 800, color: C.text }}>{pointChoisi.nom}</div>
                <div style={{ fontSize: 12.5, color: C.textSec, marginTop: 2, lineHeight: 1.4 }}>
                  {pointChoisi.adresse}<br />{pointChoisi.cp} {pointChoisi.ville}
                </div>
                <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 4 }}>
                  N° <span style={{ fontFamily: "monospace", fontWeight: 700 }}>{pointChoisi.id}</span>
                  {pointChoisi.distance > 0 && <> · à {pointChoisi.distance} m</>}
                </div>
                <button onClick={() => { setPointChoisi(null); setS(prev => ({ ...prev, pointRetrait: "" })); }}
                  style={{ marginTop: 8, padding: "7px 12px", background: C.white, border: `1.5px solid ${C.border}`, borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", color: C.textSec }}>
                  Changer de point
                </button>
              </div>
            ) : (
              <>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                  {FILTRES.map(f => (
                    <button key={f.code} onClick={() => { setFiltre(f.code); if (points) chercherPoints(f.code); }}
                      style={{ padding: etroit ? "9px 12px" : "7px 12px", borderRadius: 8, cursor: "pointer", fontFamily: "inherit",
                               border: `1.5px solid ${filtre === f.code ? C.blue : C.border}`,
                               background: filtre === f.code ? C.blueSoft : C.white,
                               color: filtre === f.code ? C.blue : C.textSec, fontSize: 12.5, fontWeight: 700 }}>
                      {f.libelle}
                    </button>
                  ))}
                </div>

                <button onClick={() => chercherPoints()} disabled={pointsBusy}
                  style={{ width: "100%", padding: 12, background: C.blue, color: "#fff", border: "none", borderRadius: 10, fontSize: 13.5, fontWeight: 800, cursor: "pointer", fontFamily: "inherit", opacity: pointsBusy ? .6 : 1 }}>
                  {pointsBusy ? "Recherche…" : "🔍 Chercher les points près du destinataire"}
                </button>

                {pointsErreur && (
                  <div style={{ marginTop: 8, background: C.redSoft, border: "1px solid #fecaca", borderRadius: 9, padding: 10, fontSize: 12, color: "#7f1d1d" }}>
                    {pointsErreur}
                  </div>
                )}

                {points && points.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontSize: 11.5, color: C.textMuted, marginBottom: 6 }}>{points.length} point(s) — le plus proche en premier</div>
                    {points.map(p => {
                      const poids = parseFloat(String(s.poids).replace(",", ".")) || 0;
                      // Un point qui n'accepte pas le poids du colis ne doit pas
                      // être choisissable : La Poste refuserait l'affranchissement.
                      const tropLourd = p.poidsMaxKg != null && poids > p.poidsMaxKg;
                      return (
                        <div key={p.id} style={{ border: `1px solid ${tropLourd || p.conges ? "#fed7aa" : C.border}`,
                                                 background: tropLourd || p.conges ? C.orangeSoft : C.white,
                                                 borderRadius: 10, padding: 10, marginBottom: 6 }}>
                          <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                            <div style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 800, color: C.text, lineHeight: 1.3 }}>{p.nom}</div>
                            {p.distance > 0 && <div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, flexShrink: 0 }}>{p.distance} m</div>}
                          </div>
                          <div style={{ fontSize: 12.5, color: C.textSec, marginTop: 2, lineHeight: 1.4 }}>
                            {p.adresse}<br />{p.cp} {p.ville}
                          </div>
                          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4, lineHeight: 1.5 }}>
                            Lun {horaireLisible(p.horaires.lundi)} · Sam {horaireLisible(p.horaires.samedi)}
                            {p.poidsMaxKg != null && <> · max {p.poidsMaxKg} kg</>}
                            {p.accesPMR && <> · accès PMR</>}
                          </div>
                          {tropLourd && (
                            <div style={{ fontSize: 11.5, color: "#b45309", fontWeight: 700, marginTop: 5 }}>
                              ⚠ Colis de {poids} kg — ce point accepte {p.poidsMaxKg} kg au maximum.
                            </div>
                          )}
                          {p.conges && !tropLourd && (
                            <div style={{ fontSize: 11.5, color: "#b45309", fontWeight: 700, marginTop: 5 }}>
                              ⚠ Fermeture pour congés annoncée sur ce point.
                            </div>
                          )}
                          <button onClick={() => choisirPoint(p)} disabled={tropLourd}
                            style={{ marginTop: 8, width: "100%", padding: "9px 0", borderRadius: 8, border: "none",
                                     background: tropLourd ? "#e2e8f0" : C.green, color: tropLourd ? C.textMuted : "#fff",
                                     fontSize: 12.5, fontWeight: 800, cursor: tropLourd ? "default" : "pointer", fontFamily: "inherit" }}>
                            {tropLourd ? "Poids dépassé" : "Choisir ce point"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
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
