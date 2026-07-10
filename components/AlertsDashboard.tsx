"use client";
// components/AlertsDashboard.tsx
// ────────────────────────────────────────────────────────────────────────────
// Tableau de bord des alertes WMS — agent de surveillance.
// Collecte en direct les anomalies (stock négatif, retours en souffrance,
// DLV courtes, stock non vendable…) et les affiche groupées par sévérité.
// ────────────────────────────────────────────────────────────────────────────
import { useState, useEffect, useCallback } from "react";
import * as odoo from "@/lib/odoo";

const SEV = {
  critical: { label: "Critique", color: "#dc2626", bg: "#fef2f2", border: "#fecaca" },
  warning: { label: "À surveiller", color: "#d97706", bg: "#fffbeb", border: "#fed7aa" },
  info: { label: "Info", color: "#2563eb", bg: "#eff6ff", border: "#bfdbfe" },
};

export default function AlertsDashboard({ session }: { session: odoo.OdooSession | null }) {
  const [groups, setGroups] = useState<odoo.AlertGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [lastRun, setLastRun] = useState<Date | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const g = await odoo.collectAlerts(session);
      setGroups(g);
      setLastRun(new Date());
    } catch { /* affiché via error par groupe */ }
    setLoading(false);
  }, [session]);

  useEffect(() => { load(); }, [load]);

  const totalCritical = groups.filter(g => g.severity === "critical").reduce((s, g) => s + g.count, 0);
  const totalWarning = groups.filter(g => g.severity === "warning").reduce((s, g) => s + g.count, 0);

  // Résumé texte (email-ready) — priorisé.
  const summary = groups.filter(g => g.count > 0)
    .sort((a, b) => (a.severity === b.severity ? b.count - a.count : a.severity === "critical" ? -1 : b.severity === "critical" ? 1 : a.severity === "warning" ? -1 : 1))
    .map(g => `${g.icon} ${g.count} ${g.title.toLowerCase()}`)
    .join(" · ");

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto", fontFamily: "'DM Sans', sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 0 12px", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 800, color: "var(--text-primary, #0f172a)" }}>🔔 Tableau de bord alertes</div>
          <div style={{ fontSize: 12.5, color: "var(--text-muted, #64748b)" }}>
            Surveillance automatique du WMS {lastRun && `· dernière analyse ${lastRun.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`}
          </div>
        </div>
        <button onClick={load} disabled={loading}
          style={{ padding: "9px 16px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 10, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
          {loading ? "Analyse…" : "↻ Actualiser"}
        </button>
      </div>

      {/* Bandeau résumé */}
      {summary && (
        <div style={{ padding: "12px 16px", borderRadius: 12, background: totalCritical > 0 ? "#fef2f2" : "#f0fdf4", border: `1px solid ${totalCritical > 0 ? "#fecaca" : "#bbf7d0"}`, marginBottom: 16, fontSize: 13.5, color: "#0f172a", lineHeight: 1.6 }}>
          <strong>{totalCritical > 0 ? `${totalCritical} point(s) critique(s)` : "Aucune alerte critique"}{totalWarning > 0 ? ` · ${totalWarning} à surveiller` : ""}</strong>
          <div style={{ color: "#475569", marginTop: 2 }}>{summary}</div>
        </div>
      )}

      {/* Cartes par catégorie */}
      <div style={{ display: "grid", gap: 12 }}>
        {groups.map((g) => {
          const s = SEV[g.severity];
          const isOpen = open[g.key];
          return (
            <div key={g.key} style={{ background: "#fff", border: `1px solid ${g.count > 0 ? s.border : "#e2e8f0"}`, borderRadius: 12, overflow: "hidden" }}>
              <button onClick={() => setOpen(p => ({ ...p, [g.key]: !p[g.key] }))}
                style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", background: g.count > 0 ? s.bg : "#fff", border: "none", cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
                <span style={{ fontSize: 22 }}>{g.icon}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "#0f172a" }}>{g.title}</div>
                  {g.error && <div style={{ fontSize: 11.5, color: "#dc2626" }}>⚠ {g.error}</div>}
                </div>
                <span style={{ fontSize: 20, fontWeight: 800, color: g.count > 0 ? s.color : "#94a3b8", minWidth: 40, textAlign: "right" }}>{g.count}</span>
                {g.count > 0 && <span style={{ fontSize: 11, fontWeight: 700, color: s.color, background: "#fff", border: `1px solid ${s.border}`, padding: "2px 8px", borderRadius: 99 }}>{s.label}</span>}
                <span style={{ color: "#94a3b8", fontSize: 12 }}>{isOpen ? "▲" : "▼"}</span>
              </button>
              {isOpen && g.items.length > 0 && (
                <div style={{ maxHeight: 340, overflowY: "auto", borderTop: `1px solid ${s.border}` }}>
                  {g.items.map((it, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 16px", borderBottom: "1px solid #f1f5f9", fontSize: 12.5 }}>
                      <span style={{ flex: 1, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.label}</span>
                      {it.detail && <span style={{ color: "#64748b", flexShrink: 0 }}>{it.detail}</span>}
                      {it.extra && <span style={{ color: s.color, fontWeight: 700, flexShrink: 0 }}>{it.extra}</span>}
                      {it.qty != null && <span style={{ fontFamily: "monospace", fontWeight: 700, color: it.qty < 0 ? "#dc2626" : "#0f172a", flexShrink: 0, minWidth: 50, textAlign: "right" }}>{it.qty}</span>}
                    </div>
                  ))}
                  {g.count > g.items.length && <div style={{ padding: "8px 16px", fontSize: 11.5, color: "#94a3b8" }}>… et {g.count - g.items.length} de plus</div>}
                </div>
              )}
            </div>
          );
        })}
        {!groups.length && !loading && <div style={{ textAlign: "center", padding: 40, color: "#94a3b8" }}>Aucune donnée. Clique sur Actualiser.</div>}
      </div>
    </div>
  );
}
