"use client";
import { useState, useEffect } from "react";
import * as odoo from "@/lib/odoo";
import { loadUserPermissions, saveUserPermission, loadHiddenTools, saveHiddenTools,
         loadPrintConfigs, loadUserPrintConfigs, saveUserPrintConfig, clearUserPrintConfig,
         loadPrinterAliases, savePrinterAliases } from "@/lib/supabase";
import { listPrinters, type PrintNodePrinter } from "@/lib/printnode";
import FieldMapEditor from "@/components/FieldMapEditor";
import OdooDiagnosticScreen from "@/components/OdooDiagnosticScreen";
import ModelMapEditor from "@/components/ModelMapEditor";

const C = {
  bg: "#f8fafc", white: "#ffffff", text: "#1a1a2e", textSec: "#374151",
  textMuted: "#6b7280", border: "#e5e7eb", blue: "#2563eb", blueSoft: "#eff6ff",
  green: "#16a34a", greenSoft: "#f0fdf4", red: "#dc2626", purple: "#7c3aed",
  shadow: "0 1px 4px rgba(0,0,0,0.07)",
};

// Catalogue des outils contrôlables (key = identifiant interne, label = affichage).
//
// Il sert à RANGER les outils par thème et à leur donner un libellé lisible.
// Il ne fait PAS autorité sur ce qui existe : l'écran reçoit en plus la liste
// réelle des tuiles du menu (voir `menuTools`) et ajoute d'office celles qui
// manquent ici. Sans ça, chaque outil ajouté au WMS restait invisible dans la
// gestion des droits jusqu'à ce que quelqu'un pense à venir l'inscrire — ce qui
// n'arrivait jamais.
export const ALL_TOOLS: { key: string; label: string; group: string }[] = [
  { key: "transfer", label: "Transfert", group: "Opérations" },
  { key: "prep", label: "Préparation", group: "Opérations" },
  { key: "waitingOrders", label: "En attente", group: "Opérations" },
  { key: "packing", label: "Emballage", group: "Opérations" },
  { key: "arrival", label: "Arrivage", group: "Opérations" },
  { key: "eshop", label: "E-shop", group: "Opérations" },
  { key: "inventory", label: "Ajustement", group: "Stock" },
  { key: "inventoryCount", label: "Inventaire", group: "Stock" },
  { key: "freeScan", label: "Scan libre", group: "Stock" },
  { key: "negativeStock", label: "Stock négatif", group: "Stock" },
  { key: "locationManager", label: "Gestion emplacements", group: "Stock" },
  { key: "returns", label: "Retours", group: "Opérations" },
  { key: "eshopSorties", label: "Sorties e-shop", group: "E-shop" },
  { key: "productImport", label: "Gestion articles", group: "Articles" },
  { key: "supplierImport", label: "Import WALA", group: "Articles" },
  { key: "imparfaite", label: "Import Imparfaite", group: "Articles" },
  { key: "labels", label: "Étiquettes", group: "Outils" },
  { key: "reprintLabel", label: "Réimpr. étiq.", group: "Outils" },
  { key: "colissimo", label: "Envoi Colissimo", group: "Outils" },
  { key: "order", label: "Commande", group: "Outils" },
  { key: "fefo", label: "Analyse FEFO", group: "Analyse" },
  { key: "manufacturing", label: "Fabrication", group: "Stock" },
  { key: "invoiceAudit", label: "Factures", group: "Analyse" },
  { key: "dashboard", label: "Dashboard", group: "Analyse" },
];

/**
 * Catalogue effectif : le catalogue ci-dessus, complété par les tuiles du menu
 * qui n'y figurent pas.
 *
 * L'écran Administration est rendu par la page qui construit le menu : elle
 * peut donc lui passer la liste réelle des outils. Un outil ajouté demain
 * apparaîtra ici sans qu'on ait rien à inscrire, rangé dans « Autres » en
 * attendant qu'on lui donne un thème.
 */
export function catalogueEffectif(
  menuTools?: { key: string; label: string }[],
): { key: string; label: string; group: string }[] {
  if (!menuTools?.length) return ALL_TOOLS;
  const connus = new Set(ALL_TOOLS.map(t => t.key));
  const absents = menuTools
    .filter(t => t.key && !connus.has(t.key))
    .map(t => ({ key: t.key, label: t.label || t.key, group: "Autres" }));
  return [...ALL_TOOLS, ...absents];
}

interface Props {
  session: odoo.OdooSession;
  onBack: () => void;
  onToast: (msg: string, type?: "success" | "error" | "info") => void;
  /** Tuiles réellement présentes dans le menu — évite tout oubli au catalogue. */
  menuTools?: { key: string; label: string }[];
}

export default function AdminScreen({ session, onBack, onToast, menuTools }: Props) {
  // Catalogue effectif : les outils connus, plus ceux du menu qui n'y sont pas.
  const OUTILS = catalogueEffectif(menuTools);
  const [users, setUsers] = useState<{ id: number; name: string; login: string }[]>([]);
  const [perms, setPerms] = useState<Record<string, string[]>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"perms" | "menu" | "print" | "fields" | "models" | "diag">("perms");

  // Visibilité globale des tuiles du menu (outils masqués pour tout le monde).
  const [hiddenTools, setHiddenTools] = useState<string[]>([]);
  const [hiddenLoaded, setHiddenLoaded] = useState(false);
  const [savingMenu, setSavingMenu] = useState(false);
  useEffect(() => {
    loadHiddenTools().then(h => { setHiddenTools(h); setHiddenLoaded(true); }).catch(() => setHiddenLoaded(true));
  }, []);
  const toggleHidden = (key: string) =>
    setHiddenTools(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
  const saveMenu = async () => {
    setSavingMenu(true);
    try {
      await saveHiddenTools(hiddenTools);
      onToast("✓ Menu enregistré — rechargez l'app pour voir les changements", "success");
    } catch (e: any) { onToast("Erreur : " + (e?.message ?? e), "error"); }
    setSavingMenu(false);
  };

  const myLogin = (session.login || "").toLowerCase();

  const load = async () => {
    setLoading(true);
    try {
      const [u, p] = await Promise.all([odoo.getActiveUsers(session), loadUserPermissions()]);
      setUsers(u);
      setPerms(p);
    } catch (e: any) { onToast("Erreur chargement : " + (e?.message ?? e), "error"); }
    setLoading(false);
  };
  // Chargement UNE SEULE FOIS au montage (sinon un re-render du parent rechargerait
  // les droits depuis Supabase et écraserait les cases en cours d'édition).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);

  // Outils autorisés pour l'utilisateur sélectionné (par défaut : aucun = config vide).
  const current = selected ? (perms[selected] ?? []) : [];
  const hasConfig = selected ? perms[selected] !== undefined : false;

  const toggleTool = (key: string) => {
    if (!selected) return;
    setPerms(prev => {
      const cur = new Set(prev[selected] ?? []);
      cur.has(key) ? cur.delete(key) : cur.add(key);
      return { ...prev, [selected]: Array.from(cur) };
    });
  };

  const setAll = (on: boolean) => {
    if (!selected) return;
    setPerms(prev => ({ ...prev, [selected]: on ? OUTILS.map(t => t.key) : [] }));
  };

  const saveSelected = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await saveUserPermission(selected, perms[selected] ?? []);
      onToast("✓ Droits enregistrés", "success");
    } catch (e: any) { onToast("Erreur : " + (e?.message ?? e), "error"); }
    setSaving(false);
  };

  const filteredUsers = users.filter(u =>
    !search || u.name.toLowerCase().includes(search.toLowerCase()) || u.login.includes(search.toLowerCase())
  );

  const groups = Array.from(new Set(OUTILS.map(t => t.group)));

  return (
    <div style={{ padding: "16px 16px 60px", maxWidth: 760, margin: "0 auto", fontFamily: "'DM Sans', sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <button onClick={onBack} style={{ background: C.bg, border: "none", borderRadius: 10, padding: 8, cursor: "pointer", display: "flex" }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><path d="M19 12H5M12 5l-7 7 7 7" /></svg>
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: C.text }}>Administration</div>
          <div style={{ fontSize: 12, color: C.textMuted }}>{tab === "perms" ? "Droits d'accès aux outils, par utilisateur" : tab === "menu" ? "Afficher / masquer les tuiles du menu" : tab === "print" ? "Imprimante par personne et par tâche" : tab === "fields" ? "Mapping des champs Odoo" : "Mapping des modèles Odoo"}</div>
        </div>
        {tab === "perms" && <button onClick={load} title="Recharger" style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", cursor: "pointer", color: C.textSec }}>↻</button>}
      </div>

      {/* ── Onglets ── */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16, background: C.bg, padding: 4, borderRadius: 12 }}>
        {([
          { k: "perms" as const, label: "👤 Droits" },
          { k: "menu" as const, label: "☰ Menu" },
          { k: "print" as const, label: "🖨 Imprimantes" },
          { k: "fields" as const, label: "⚙️ Champs" },
          { k: "models" as const, label: "🗂️ Modèles" },
          { k: "diag" as const, label: "🩺 Diagnostic" },
        ]).map(t => (
          <button key={t.k} onClick={() => setTab(t.k)}
            style={{ flex: 1, padding: "9px 0", borderRadius: 9, border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 700,
              background: tab === t.k ? C.white : "transparent", color: tab === t.k ? C.text : C.textMuted,
              boxShadow: tab === t.k ? C.shadow : "none" }}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "print" ? (
        <PrintAssign users={filteredUsers} search={search} setSearch={setSearch} onToast={onToast} />
      ) : tab === "menu" ? (
        // ── Visibilité des tuiles du menu (global, tout le monde) ──
        !hiddenLoaded ? (
          <div style={{ textAlign: "center", color: C.textMuted, padding: 40 }}>Chargement…</div>
        ) : (
          <div>
            <div style={{ fontSize: 12.5, color: C.textMuted, marginBottom: 14, lineHeight: 1.5 }}>
              Décoche une tuile pour la <strong>masquer du menu</strong> pour tout le monde. Tu peux la
              réafficher ici à tout moment. (L'onglet Administration reste toujours visible.)
            </div>
            {groups.map(g => (
              <div key={g} style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>{g}</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  {OUTILS.filter(t => t.group === g).map(t => {
                    const visible = !hiddenTools.includes(t.key);
                    return (
                      <button key={t.key} onClick={() => toggleHidden(t.key)}
                        style={{
                          display: "flex", alignItems: "center", gap: 8, padding: "11px 12px",
                          borderRadius: 10, cursor: "pointer", fontFamily: "inherit", textAlign: "left",
                          border: `1.5px solid ${visible ? C.green : C.border}`,
                          background: visible ? C.greenSoft : "#f8fafc",
                        }}>
                        <span style={{ fontSize: 16 }}>{visible ? "👁" : "🚫"}</span>
                        <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: visible ? C.text : C.textMuted }}>{t.label}</span>
                        <span style={{ fontSize: 11, fontWeight: 700, color: visible ? C.green : C.textMuted }}>{visible ? "Affiché" : "Masqué"}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            <button onClick={saveMenu} disabled={savingMenu}
              style={{ width: "100%", marginTop: 8, padding: "14px 0", background: savingMenu ? C.border : C.blue, color: "#fff", border: "none", borderRadius: 12, fontSize: 14.5, fontWeight: 800, cursor: savingMenu ? "default" : "pointer", fontFamily: "inherit" }}>
              {savingMenu ? "Enregistrement…" : "Enregistrer le menu"}
            </button>
          </div>
        )
      ) : tab === "fields" ? (
        <FieldMapEditor session={session} onToast={onToast} />
      ) : tab === "diag" ? (
        <OdooDiagnosticScreen session={session} onBack={onBack} />
      ) : tab === "models" ? (
        <ModelMapEditor session={session} onToast={onToast} />
      ) : loading ? (
        <div style={{ textAlign: "center", color: C.textMuted, padding: 40 }}>Chargement…</div>
      ) : !selected ? (
        // ── Liste des utilisateurs ──
        <>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 Rechercher un utilisateur…"
            style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit", marginBottom: 12 }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {filteredUsers.map(u => {
              const isMe = u.login === myLogin;
              const count = (perms[u.login] ?? []).length;
              const configured = perms[u.login] !== undefined;
              return (
                <button key={u.id} onClick={() => setSelected(u.login)}
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, textAlign: "left", background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, padding: "12px 14px", cursor: "pointer", fontFamily: "inherit", boxShadow: C.shadow }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{u.name}{isMe && <span style={{ color: C.purple, fontSize: 11, marginLeft: 6 }}>(admin — toi)</span>}</div>
                    <div style={{ fontSize: 12, color: C.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.login}</div>
                  </div>
                  <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 700, color: configured ? C.blue : C.textMuted, background: configured ? C.blueSoft : C.bg, padding: "3px 9px", borderRadius: 99 }}>
                    {isMe ? "tous" : configured ? `${count} outil${count > 1 ? "s" : ""}` : "non configuré"}
                  </span>
                </button>
              );
            })}
            {!filteredUsers.length && <div style={{ textAlign: "center", padding: 30, color: C.textMuted, fontSize: 13 }}>Aucun utilisateur</div>}
          </div>
          <div style={{ marginTop: 16, fontSize: 12, color: C.textMuted, lineHeight: 1.5 }}>
            ℹ️ Un utilisateur « non configuré » voit un jeu d'outils de base par défaut. Coche les outils pour personnaliser. Toi (admin) vois toujours tout.
          </div>
        </>
      ) : (
        // ── Édition des droits d'un utilisateur ──
        <>
          <button onClick={() => setSelected(null)} style={{ background: "none", border: "none", color: C.blue, cursor: "pointer", fontSize: 13, fontWeight: 700, padding: 0, marginBottom: 12, fontFamily: "inherit" }}>← Tous les utilisateurs</button>
          {(() => {
            const u = users.find(x => x.login === selected);
            const isMe = selected === myLogin;
            return (
              <>
                <div style={{ fontSize: 16, fontWeight: 800, color: C.text }}>{u?.name || selected}</div>
                <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 14 }}>{selected}</div>
                {isMe ? (
                  <div style={{ background: C.greenSoft, border: `1px solid ${C.green}44`, borderRadius: 10, padding: "12px 14px", fontSize: 13, color: C.text }}>
                    🔒 Tu es administrateur : tu as accès à tous les outils. Ces droits ne sont pas modifiables (pour ne pas te verrouiller).
                  </div>
                ) : (
                  <>
                    <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                      <button onClick={() => setAll(true)} style={{ flex: 1, padding: "8px 0", borderRadius: 8, border: `1px solid ${C.blue}`, background: C.blueSoft, color: C.blue, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>Tout cocher</button>
                      <button onClick={() => setAll(false)} style={{ flex: 1, padding: "8px 0", borderRadius: 8, border: `1px solid ${C.border}`, background: C.white, color: C.textSec, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>Tout décocher</button>
                    </div>
                    {groups.map(g => (
                      <div key={g} style={{ marginBottom: 14 }}>
                        <div style={{ fontSize: 11, fontWeight: 800, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>{g}</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          {OUTILS.filter(t => t.group === g).map(t => {
                            const on = current.includes(t.key);
                            return (
                              <label key={t.key} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", background: on ? C.blueSoft : C.white, border: `1px solid ${on ? C.blue + "55" : C.border}`, borderRadius: 10, cursor: "pointer", fontSize: 14, color: C.text }}>
                                <input type="checkbox" checked={on} onChange={() => toggleTool(t.key)} style={{ width: 17, height: 17, accentColor: C.blue, cursor: "pointer" }} />
                                {t.label}
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                    <button onClick={saveSelected} disabled={saving}
                      style={{ width: "100%", padding: "13px 0", background: saving ? C.textMuted : C.green, color: "#fff", border: "none", borderRadius: 11, fontWeight: 800, fontSize: 15, cursor: saving ? "default" : "pointer", fontFamily: "inherit", marginTop: 4 }}>
                      {saving ? "Enregistrement…" : "💾 Enregistrer les droits"}
                    </button>
                  </>
                )}
              </>
            );
          })()}
        </>
      )}

    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// IMPRIMANTES PAR PERSONNE
// ═══════════════════════════════════════════════════════════════════════════
//
// Jusqu'ici, régler les imprimantes demandait de passer physiquement sur chaque
// poste. Impraticable dès qu'on a plus de deux préparateurs, et invérifiable :
// personne ne savait qui imprimait où.
//
// La configuration commune (wms_print_config) reste la valeur par défaut. On ne
// stocke ici que les EXCEPTIONS : un type laissé sur « configuration commune »
// n'écrit rien en base. Sans ça, chaque ajout d'imprimante aurait obligé à
// repasser sur toutes les personnes.

/** Tâches d'impression, dans l'ordre où elles se rencontrent sur le terrain. */
const TACHES: { type: string; label: string; aide: string }[] = [
  { type: "picking",           label: "Bon de préparation",     aide: "Imprimé à la validation d'un pick" },
  { type: "packingslip",       label: "Bon de livraison",       aide: "Imprimé à l'emballage" },
  { type: "packingslip_eshop", label: "BL e-shop",              aide: "Sorties e-shop" },
  // Un transporteur par ligne : les étiquettes n'ont ni le même format ni la
  // même imprimante, et les regrouper obligeait à rebasculer le réglage à
  // chaque changement de transporteur.
  { type: "sendcloud",         label: "Étiquette Sendcloud",    aide: "E-shop via Sendcloud" },
  { type: "tnt",               label: "Étiquette TNT",          aide: "Expéditions TNT" },
  { type: "colissimo",         label: "Étiquette Colissimo",    aide: "Envois La Poste" },
  { type: "bordereau",         label: "Bordereau de dépôt",     aide: "A4 — surtout pas une thermique" },
  { type: "product",           label: "Étiquette article",      aide: "Code-barres produit" },
  { type: "lot",               label: "Étiquette lot",          aide: "Numéro de lot et péremption" },
  { type: "location",          label: "Étiquette emplacement",  aide: "Allées et casiers" },
  { type: "palette",           label: "Étiquette palette",      aide: "Palette fournisseur" },
  { type: "palette_wms",       label: "Étiquette palette WMS",  aide: "Palette montée à l'entrepôt" },
  { type: "order_barcode",     label: "Code-barres commande",   aide: "Étiquette 70×35" },
  { type: "blank",             label: "Étiquette libre",        aide: "Saisie manuelle" },
];

function PrintAssign({ users, search, setSearch, onToast }: {
  users: { id: number; name: string; login: string }[];
  search: string;
  setSearch: (v: string) => void;
  onToast: (msg: string, type?: "success" | "error" | "info") => void;
}) {
  const [printers, setPrinters] = useState<PrintNodePrinter[]>([]);
  const [commun, setCommun] = useState<Record<string, { printer_id: number | null }>>({});
  const [perso, setPerso] = useState<Record<string, Record<string, { printer_id: number | null }>>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  // Noms d'usage : PrintNode renvoie le nom du pilote, souvent identique sur
  // plusieurs machines. Sans renommage, choisir la bonne relève du hasard.
  const [alias, setAlias] = useState<Record<string, string>>({});
  const [renommer, setRenommer] = useState(false);
  const [savingAlias, setSavingAlias] = useState(false);

  const recharger = async () => {
    const [p, a] = await Promise.all([listPrinters(), loadPrinterAliases().catch(() => ({}))]);
    setPrinters(p);
    setAlias(a);
  };

  useEffect(() => {
    (async () => {
      try {
        const [p, c, u, a] = await Promise.all([
          listPrinters(),
          loadPrintConfigs().catch(() => ({})),
          loadUserPrintConfigs().catch(() => ({})),
          loadPrinterAliases().catch(() => ({})),
        ]);
        setPrinters(p);
        setCommun(c as any);
        setPerso(u as any);
        setAlias(a);
      } catch (e: any) { setErreur(e?.message || "Chargement impossible"); }
      setChargement(false);
    })();
  }, []);

  const enregistrerAlias = async () => {
    setSavingAlias(true);
    try {
      await savePrinterAliases(alias);
      await recharger();
      setRenommer(false);
      onToast("✓ Noms enregistrés — visibles sur tous les postes", "success");
    } catch (e: any) { onToast("Erreur : " + (e?.message || e), "error"); }
    setSavingAlias(false);
  };

  const nomImprimante = (id: number | null | undefined) =>
    id ? (printers.find(p => p.id === id)?.name || `Imprimante ${id}`) : "";

  const changer = async (type: string, valeur: string) => {
    if (!selected) return;
    setBusy(type);
    try {
      if (valeur === "") {
        // Chaîne vide = « suivre la configuration commune ». On supprime la
        // ligne au lieu d'enregistrer null : une exception vide n'a pas de sens
        // et masquerait un futur changement de la config commune.
        await clearUserPrintConfig(selected, type);
        setPerso(prev => {
          const copie = { ...prev };
          if (copie[selected]) { const t = { ...copie[selected] }; delete t[type]; copie[selected] = t; }
          return copie;
        });
      } else {
        const id = Number(valeur);
        await saveUserPrintConfig(selected, type, id);
        setPerso(prev => ({ ...prev, [selected]: { ...(prev[selected] || {}), [type]: { printer_id: id } } }));
      }
      onToast("✓ Enregistré", "success");
    } catch (e: any) { onToast("Erreur : " + (e?.message || e), "error"); }
    setBusy(null);
  };

  if (chargement) return <div style={{ textAlign: "center", color: C.textMuted, padding: 40 }}>Chargement…</div>;

  if (!printers.length) {
    return (
      <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 12, padding: 14, fontSize: 13, color: "#92400e" }}>
        Aucune imprimante remontée par PrintNode. Vérifie que le client PrintNode tourne sur le poste relié aux imprimantes.
        {erreur && <div style={{ marginTop: 6, fontSize: 12 }}>{erreur}</div>}
      </div>
    );
  }

  const persoDe = selected ? (perso[selected] || {}) : {};
  const nbExceptions = Object.keys(persoDe).length;

  return (
    <div>
      <div style={{ fontSize: 12.5, color: C.textMuted, marginBottom: 12, lineHeight: 1.5 }}>
        Choisis une personne, puis son imprimante pour chaque tâche. Ce qui reste sur
        <strong> « configuration commune »</strong> suit le réglage général — inutile de tout renseigner.
        Les changements s&apos;appliquent à la prochaine connexion de la personne.
      </div>

      {/* ── Noms d'usage des imprimantes ── */}
      <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, padding: 12, marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>🏷️ Noms des imprimantes</div>
            <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 2 }}>
              PrintNode donne le nom du pilote, souvent le même partout. Renomme-les une fois, pour tout le monde.
            </div>
          </div>
          <button onClick={() => setRenommer(v => !v)}
            style={{ padding: "8px 13px", background: renommer ? C.bg : C.white, border: `1.5px solid ${C.border}`, borderRadius: 9, fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", color: C.textSec, flexShrink: 0 }}>
            {renommer ? "Fermer" : "Renommer"}
          </button>
        </div>

        {renommer && (
          <div style={{ marginTop: 12 }}>
            {printers.map(p => (
              <div key={p.id} style={{ marginBottom: 9 }}>
                {/* Le nom PrintNode reste affiché : c'est ce qui permet de
                    distinguer deux imprimantes homonymes par leur poste. */}
                <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 3 }}>
                  <span style={{ fontFamily: "monospace" }}>{p.nomPrintNode}</span>
                  {p.computer?.name && <> · poste {p.computer.name}</>}
                  <> · id {p.id}</>
                </div>
                <input
                  value={alias[String(p.id)] ?? ""}
                  onChange={e => setAlias(prev => ({ ...prev, [String(p.id)]: e.target.value }))}
                  placeholder={`Nom d'usage (vide = ${p.nomPrintNode})`}
                  style={{ width: "100%", boxSizing: "border-box", padding: "10px 11px", border: `1.5px solid ${C.border}`, borderRadius: 9, fontSize: 13, fontFamily: "inherit", outline: "none" }} />
              </div>
            ))}
            <button onClick={enregistrerAlias} disabled={savingAlias}
              style={{ width: "100%", marginTop: 4, padding: 11, background: C.blue, color: "#fff", border: "none", borderRadius: 10, fontSize: 13, fontWeight: 800, cursor: "pointer", fontFamily: "inherit", opacity: savingAlias ? .6 : 1 }}>
              {savingAlias ? "Enregistrement…" : "💾 Enregistrer les noms"}
            </button>
          </div>
        )}
      </div>

      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Rechercher un utilisateur…"
        style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 13.5, fontFamily: "inherit", outline: "none", marginBottom: 10 }} />

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>
        {users.map(u => {
          const n = Object.keys(perso[u.login.toLowerCase()] || {}).length;
          const actif = selected === u.login.toLowerCase();
          return (
            <button key={u.id} onClick={() => setSelected(actif ? null : u.login.toLowerCase())}
              style={{ padding: "9px 13px", borderRadius: 9, cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, fontWeight: 700,
                       border: `1.5px solid ${actif ? C.blue : C.border}`,
                       background: actif ? C.blueSoft : C.white, color: actif ? C.blue : C.textSec }}>
              {u.name}
              {n > 0 && <span style={{ marginLeft: 6, fontSize: 11, color: C.purple }}>· {n}</span>}
            </button>
          );
        })}
      </div>

      {!selected ? (
        <div style={{ textAlign: "center", color: C.textMuted, padding: 30, fontSize: 13 }}>
          Choisis un utilisateur pour régler ses imprimantes.
        </div>
      ) : (
        <>
          <div style={{ fontSize: 12.5, color: C.textMuted, marginBottom: 10 }}>
            {nbExceptions === 0
              ? "Aucun réglage particulier — cette personne suit entièrement la configuration commune."
              : `${nbExceptions} tâche(s) avec une imprimante propre à cette personne.`}
          </div>

          {TACHES.map(t => {
            const perso_ = persoDe[t.type]?.printer_id ?? null;
            const commun_ = commun[t.type]?.printer_id ?? null;
            return (
              <div key={t.type} style={{ background: C.white, border: `1px solid ${perso_ ? C.purple + "55" : C.border}`, borderRadius: 10, padding: 11, marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700, color: C.text }}>{t.label}</div>
                    <div style={{ fontSize: 11.5, color: C.textMuted }}>{t.aide}</div>
                  </div>
                  {perso_ != null && (
                    <span style={{ fontSize: 10.5, fontWeight: 800, color: C.purple, background: "#f5f3ff", padding: "2px 7px", borderRadius: 20, whiteSpace: "nowrap" }}>
                      PERSONNALISÉ
                    </span>
                  )}
                </div>
                <select value={perso_ ?? ""} disabled={busy === t.type}
                  onChange={e => changer(t.type, e.target.value)}
                  style={{ width: "100%", boxSizing: "border-box", padding: "10px 11px", border: `1.5px solid ${C.border}`, borderRadius: 9, fontSize: 13, fontFamily: "inherit", background: C.white, color: C.text }}>
                  <option value="">
                    Configuration commune{commun_ ? ` — ${nomImprimante(commun_)}` : " — non réglée"}
                  </option>
                  {printers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
