"use client";
// components/OdooDiagnosticScreen.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Diagnostic de compatibilité Odoo.
//
// POURQUOI CET ÉCRAN
// Le contrôle des champs (écran Champs) ne vérifie que les champs DÉCLARÉS dans
// le mapping. Or le code interroge beaucoup d'autres champs écrits en dur — par
// exemple quantity_done sur stock.move — que ce contrôle ne peut pas voir. On
// découvrait donc les incompatibilités une par une, écran par écran.
//
// Ici on appelle RÉELLEMENT les fonctions du WMS contre la base connectée et on
// remonte toutes les erreurs d'un coup. C'est le seul moyen fiable de savoir ce
// qui casse avant de s'en apercevoir en production.
//
// LECTURE SEULE : aucune de ces fonctions n'écrit dans Odoo.
// ─────────────────────────────────────────────────────────────────────────────
import { useState } from "react";
import * as odoo from "@/lib/odoo";

const C = {
  bg: "#f8fafc", white: "#fff", text: "#0f172a", textSec: "#475569",
  textMuted: "#94a3b8", border: "#e2e8f0", blue: "#2563eb",
  green: "#16a34a", greenSoft: "#f0fdf4", red: "#dc2626", redSoft: "#fef2f2",
  amber: "#d97706", amberSoft: "#fffbeb",
};

type Status = "pending" | "running" | "ok" | "fail";
interface Check {
  key: string;
  screen: string;      // écran impacté — pour savoir ce qui sera cassé
  label: string;
  run: (s: odoo.OdooSession) => Promise<string>;  // renvoie un résumé lisible
  status: Status;
  detail?: string;
}

export default function OdooDiagnosticScreen({
  session, onBack,
}: { session: odoo.OdooSession; onBack: () => void }) {

  // Chaque test appelle une fonction réellement utilisée par un écran.
  const build = (): Check[] => ([
    { key: "loc", screen: "Transfert · Scan libre", label: "Emplacements", status: "pending",
      run: async s => `${(await odoo.getLocations(s)).length} emplacement(s)` },
    { key: "wait", screen: "En attente", label: "Commandes en attente", status: "pending",
      run: async s => `${(await odoo.getWaitingPickings(s)).length} commande(s)` },
    { key: "prep", screen: "Préparation", label: "Préparations à faire", status: "pending",
      run: async s => `${(await odoo.getOutgoingPickings(s)).length} préparation(s)` },
    { key: "pack", screen: "Emballage", label: "Commandes à emballer", status: "pending",
      run: async s => `${(await odoo.getPackablePickings(s)).length} commande(s)` },
    { key: "search", screen: "Recherche · Accueil", label: "Recherche globale", status: "pending",
      run: async s => `${(await odoo.globalSearch(s, "10101")).length} résultat(s)` },
    { key: "prepared", screen: "E-shop", label: "Commandes préparées (mémo)", status: "pending",
      run: async s => `${(await odoo.loadPreparedOrders(s)).length} référence(s)` },
    { key: "chariot", screen: "E-shop · Chariot", label: "SKU du chariot", status: "pending",
      run: async s => `${(await odoo.loadChariotSkus(s)).length} SKU` },
    { key: "movelines", screen: "Préparation · détail", label: "Lignes d'un transfert", status: "pending",
      run: async s => {
        const picks = await odoo.getPackablePickings(s);
        if (!picks.length) return "aucun transfert disponible pour tester";
        const mls = await odoo.getPickingMoveLines(s, picks[0].id);
        return `${mls.length} ligne(s) sur ${picks[0].name}`;
      } },
    { key: "moves", screen: "Retours · Emballage", label: "Mouvements d'un transfert", status: "pending",
      run: async s => {
        const picks = await odoo.getPackablePickings(s);
        if (!picks.length) return "aucun transfert disponible pour tester";
        const mv = await odoo.getPickingMoves(s, picks[0].id);
        return `${mv.length} mouvement(s)`;
      } },
    { key: "progress", screen: "Préparation · progression", label: "Progression des préparations", status: "pending",
      run: async s => {
        const picks = await odoo.getOutgoingPickings(s);
        if (!picks.length) return "aucune préparation disponible pour tester";
        const p = await odoo.getPickingsProgress(s, picks.slice(0, 3).map((x: any) => x.id));
        return `${Object.keys(p).length} transfert(s) analysé(s)`;
      } },
    { key: "negstock", screen: "Stock négatif", label: "Stocks négatifs", status: "pending",
      run: async s => {
        const q = await odoo.searchRead(s, "stock.quant",
          [["quantity", "<", 0], ["location_id.usage", "=", "internal"]], ["product_id"], 50);
        return `${q.length} quant(s) négatif(s)`;
      } },
    { key: "returns", screen: "Retours", label: "Retours en attente", status: "pending",
      run: async s => {
        const types = await odoo.searchRead(s, "stock.picking.type", [["sequence_code", "ilike", "RET"]], ["id"], 20);
        const ids = types.map((t: any) => t.id);
        if (!ids.length) return "aucun type de retour configuré";
        const r = await odoo.searchRead(s, "stock.picking",
          [["picking_type_id", "in", ids], ["state", "in", ["confirmed", "assigned", "waiting"]]], ["id", "name"], 50);
        return `${r.length} retour(s)`;
      } },
  ]);

  const [checks, setChecks] = useState<Check[]>(build());
  const [running, setRunning] = useState(false);

  const runAll = async () => {
    if (running) return;
    setRunning(true);
    const list = build();
    setChecks(list);
    // Séquentiel volontairement : on veut des messages d'erreur lisibles et ne
    // pas saturer le proxy Odoo. Une douzaine d'appels, ça reste rapide.
    for (let i = 0; i < list.length; i++) {
      setChecks(prev => prev.map((c, j) => j === i ? { ...c, status: "running" } : c));
      try {
        const detail = await list[i].run(session);
        setChecks(prev => prev.map((c, j) => j === i ? { ...c, status: "ok", detail } : c));
      } catch (e: any) {
        setChecks(prev => prev.map((c, j) => j === i ? { ...c, status: "fail", detail: odoo.safeErrMsg?.(e) || e?.message || String(e) } : c));
      }
    }
    setRunning(false);
  };

  const failed = checks.filter(c => c.status === "fail");
  const okCount = checks.filter(c => c.status === "ok").length;
  const finished = !running && checks.some(c => c.status !== "pending");

  // Regroupe les erreurs identiques : un même champ casse souvent plusieurs écrans.
  const grouped = new Map<string, string[]>();
  for (const f of failed) {
    const k = f.detail || "erreur inconnue";
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k)!.push(f.screen);
  }

  const icon = (s: Status) =>
    s === "ok" ? "✓" : s === "fail" ? "✕" : s === "running" ? "…" : "·";
  const color = (s: Status) =>
    s === "ok" ? C.green : s === "fail" ? C.red : C.textMuted;

  return (
    <div style={{ padding: "16px 16px 40px", fontFamily: "'DM Sans', sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
        <button onClick={onBack} style={{ background: C.bg, border: "none", borderRadius: 10, padding: 8, cursor: "pointer", display: "flex" }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><path d="M19 12H5M12 5l-7 7 7 7" /></svg>
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>Diagnostic Odoo</div>
          <div style={{ fontSize: 12, color: C.textSec }}>Teste les fonctions du WMS contre la base connectée</div>
        </div>
      </div>

      <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14, marginBottom: 14 }}>
        <div style={{ fontSize: 12, color: C.textSec, marginBottom: 10, lineHeight: 1.6 }}>
          Le contrôle des champs ne voit que les champs déclarés dans le mapping. Beaucoup d&apos;autres
          sont écrits en dur dans le code et n&apos;y figurent pas — d&apos;où des erreurs découvertes
          écran par écran. Ce diagnostic appelle <strong>réellement</strong> les fonctions et remonte
          tout d&apos;un coup. <strong>Lecture seule</strong> : rien n&apos;est écrit dans Odoo.
        </div>
        <button onClick={runAll} disabled={running}
          style={{ padding: "10px 18px", background: running ? "#cbd5e1" : C.blue, color: "#fff", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: running ? "default" : "pointer", fontFamily: "inherit" }}>
          {running ? "Diagnostic en cours…" : "Lancer le diagnostic"}
        </button>
      </div>

      {finished && (
        <div style={{ background: failed.length ? C.redSoft : C.greenSoft, border: `1px solid ${failed.length ? "#fecaca" : "#bbf7d0"}`, borderRadius: 12, padding: 14, marginBottom: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: failed.length ? "#991b1b" : "#15803d", marginBottom: failed.length ? 8 : 0 }}>
            {failed.length ? `${failed.length} fonction(s) en échec · ${okCount} OK` : `Tout fonctionne — ${okCount} fonctions testées`}
          </div>
          {Array.from(grouped.entries()).map(([err, screens], i) => (
            <div key={i} style={{ marginTop: 8, paddingTop: 8, borderTop: i > 0 ? "1px solid #fecaca" : "none" }}>
              <div style={{ fontSize: 12.5, fontFamily: "monospace", color: "#991b1b", fontWeight: 700 }}>{err}</div>
              <div style={{ fontSize: 11.5, color: "#b91c1c", marginTop: 2 }}>
                Écrans impactés : {screens.join(" · ")}
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
        {checks.map((c, i) => (
          <div key={c.key} style={{ display: "flex", alignItems: "flex-start", gap: 11, padding: "10px 14px", borderTop: i > 0 ? `1px solid ${C.border}` : "none" }}>
            <span style={{ width: 16, textAlign: "center", fontSize: 14, fontWeight: 800, color: color(c.status), flexShrink: 0 }}>{icon(c.status)}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{c.label}</div>
              <div style={{ fontSize: 11, color: C.textMuted }}>{c.screen}</div>
              {c.detail && (
                <div style={{ fontSize: 11.5, marginTop: 3, color: c.status === "fail" ? C.red : C.textSec, fontFamily: c.status === "fail" ? "monospace" : "inherit", wordBreak: "break-word" as const }}>
                  {c.detail}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
