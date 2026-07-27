"use client";
// app/assistant/page.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Assistant WMS conversationnel — page mobile autonome.
// Pensée pour l'entrepôt avec juste un téléphone : on écrit une question en
// français ("il reste combien de 1010101 ?", "c'est rangé où", "les lots"),
// l'assistant interroge Odoo via /api/ai-odoo (Claude Haiku, LECTURE SEULE) et
// répond dans le fil.
//
// Autonome : son propre login + session localStorage (clé wms_assistant_s),
// pour qu'on puisse l'ouvrir seule et la mettre en favori sur l'écran d'accueil.
// À ajouter à l'écran d'accueil iOS : Partager → « Sur l'écran d'accueil ».
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef, useCallback } from "react";
import * as odoo from "@/lib/odoo";

const C = {
  bg: "#f8fafc", white: "#ffffff", text: "#0f172a", textSec: "#475569",
  textMuted: "#94a3b8", border: "#e2e8f0", blue: "#2563eb", blueSoft: "#eff6ff",
  green: "#16a34a", greenSoft: "#f0fdf4", red: "#dc2626", redSoft: "#fef2f2",
};

const LS_SESSION = "wms_assistant_s";
const LS_CFG     = "wms_assistant_cfg";

type Msg = { role: "user" | "assistant"; text: string; loading?: boolean };

function saveSession(s: odoo.OdooSession) { try { localStorage.setItem(LS_SESSION, JSON.stringify(s)); } catch {} }
function loadSession(): odoo.OdooSession | null {
  try { const s = localStorage.getItem(LS_SESSION); return s ? JSON.parse(s) : null; } catch { return null; }
}
function clearSession() { try { localStorage.removeItem(LS_SESSION); } catch {} }
function saveCfg(url: string, db: string) { try { localStorage.setItem(LS_CFG, JSON.stringify({ url, db })); } catch {} }
function loadCfg(): { url: string; db: string } | null {
  try { const c = localStorage.getItem(LS_CFG); return c ? JSON.parse(c) : null; } catch { return null; }
}

// Questions d'amorce (chips) — ce que l'opérateur tape le plus souvent.
const SUGGESTIONS = [
  "Stock de la 1010101",
  "C'est rangé où ?",
  "Les lots et DLUO",
  "Commandes en cours",
];

export default function AssistantPage() {
  const [session, setSession] = useState<odoo.OdooSession | null>(null);
  const [booting, setBooting] = useState(true);

  // Login
  const cfg0 = typeof window !== "undefined" ? loadCfg() : null;
  const [url, setUrl]   = useState(cfg0?.url || "https://drhauschka.odoo.com");
  const [db, setDb]     = useState(cfg0?.db || "");
  const [login, setLogin] = useState("");
  const [pw, setPw]     = useState("");
  const [loginErr, setLoginErr] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);

  // Chat
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<{ role: string; text: string }[]>([]);

  // Restaure la session au chargement, et vérifie qu'elle est encore valide.
  useEffect(() => {
    const s = loadSession();
    if (!s) { setBooting(false); return; }
    odoo.getLocations(s)
      .then(() => { setSession(s); setBooting(false); })
      .catch(() => { clearSession(); setBooting(false); });
  }, []);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const doLogin = async () => {
    if (loginBusy) return;
    setLoginErr("");
    if (!url || !db || !login || !pw) { setLoginErr("Remplis tous les champs"); return; }
    setLoginBusy(true);
    try {
      const s = await odoo.authenticate({ url: url.replace(/\/$/, ""), db }, login, pw);
      setSession(s); saveSession(s); saveCfg(url.replace(/\/$/, ""), db);
    } catch (e: any) {
      setLoginErr(e.message || "Connexion impossible");
    }
    setLoginBusy(false);
  };

  const logout = () => { clearSession(); setSession(null); setMessages([]); historyRef.current = []; };

  const send = useCallback(async (question?: string) => {
    const q = (question ?? input).trim();
    if (!q || busy || !session) return;
    setInput("");
    setMessages(prev => [...prev, { role: "user", text: q }, { role: "assistant", text: "", loading: true }]);
    setBusy(true);
    try {
      const resp = await fetch("/api/ai-odoo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: q,
          odooUrl: session.config.url,
          sessionId: session.sessionId,
          history: historyRef.current.slice(-6),
        }),
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      const answer = data.answer || "Pas de réponse.";
      setMessages(prev => { const n = [...prev]; n[n.length - 1] = { role: "assistant", text: answer }; return n; });
      historyRef.current.push({ role: "user", text: q }, { role: "assistant", text: answer });
    } catch (e: any) {
      const msg = `⚠ ${e.message || "Erreur"}`;
      setMessages(prev => { const n = [...prev]; n[n.length - 1] = { role: "assistant", text: msg }; return n; });
    }
    setBusy(false);
  }, [input, busy, session]);

  // ── Écran chargement ──
  if (booting) {
    return (
      <div style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", background: C.bg, fontFamily: "'DM Sans', system-ui, sans-serif", color: C.textMuted }}>
        Chargement…
      </div>
    );
  }

  // ── Écran login ──
  if (!session) {
    return (
      <div style={{ minHeight: "100dvh", background: C.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "'DM Sans', system-ui, sans-serif", boxSizing: "border-box" }}>
        <div style={{ width: "100%", maxWidth: 380 }}>
          <div style={{ textAlign: "center", marginBottom: 22 }}>
            <div style={{ width: 56, height: 56, borderRadius: 16, background: C.blueSoft, display: "inline-flex", alignItems: "center", justifyContent: "center", marginBottom: 12 }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={C.blue} strokeWidth="1.8"><rect x="3" y="8" width="18" height="12" rx="2"/><path d="M12 8V4M8 4h8"/><circle cx="8.5" cy="14" r="1"/><circle cx="15.5" cy="14" r="1"/></svg>
            </div>
            <h1 style={{ fontSize: 20, fontWeight: 700, color: C.text, margin: 0 }}>Assistant WMS</h1>
            <p style={{ fontSize: 13, color: C.textSec, margin: "4px 0 0" }}>Consulte le stock depuis ton téléphone</p>
          </div>
          <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 16, padding: 18 }}>
            {[
              { label: "URL Odoo", val: url, set: setUrl, type: "url", ph: "https://drhauschka.odoo.com" },
              { label: "Base (db)", val: db, set: setDb, type: "text", ph: "nom de la base" },
              { label: "Identifiant", val: login, set: setLogin, type: "text", ph: "prenom.nom@…" },
              { label: "Mot de passe", val: pw, set: setPw, type: "password", ph: "••••••••" },
            ].map((f, i) => (
              <div key={i} style={{ marginBottom: 12 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: C.textSec, display: "block", marginBottom: 5 }}>{f.label}</label>
                <input
                  value={f.val} type={f.type} placeholder={f.ph}
                  autoCapitalize="off" autoCorrect="off" spellCheck={false}
                  onChange={e => f.set(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") doLogin(); }}
                  style={{ width: "100%", padding: "11px 13px", borderRadius: 10, border: `1.5px solid ${C.border}`, fontSize: 15, fontFamily: "inherit", outline: "none", boxSizing: "border-box", color: C.text }}
                />
              </div>
            ))}
            {loginErr && <div style={{ fontSize: 13, color: C.red, marginBottom: 10 }}>{loginErr}</div>}
            <button onClick={doLogin} disabled={loginBusy}
              style={{ width: "100%", padding: "13px 0", borderRadius: 11, border: "none", background: loginBusy ? C.textMuted : C.blue, color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
              {loginBusy ? "Connexion…" : "Se connecter"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Écran chat ──
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100dvh", background: C.bg, fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", background: C.white, borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: C.blueSoft, display: "flex", alignItems: "center", justifyContent: "center", color: C.blue }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="8" width="18" height="12" rx="2"/><path d="M12 8V4M8 4h8"/><circle cx="8.5" cy="14" r="1"/><circle cx="15.5" cy="14" r="1"/></svg>
        </div>
        <div style={{ flex: 1, lineHeight: 1.3, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>Assistant WMS</div>
          <div style={{ fontSize: 11, color: C.textSec, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.name} · lecture seule</div>
        </div>
        <button onClick={logout} title="Déconnexion"
          style={{ background: "none", border: "none", cursor: "pointer", color: C.textMuted, padding: 4, display: "flex" }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>
        </button>
      </div>

      {/* Fil de discussion */}
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 12px", display: "flex", flexDirection: "column", gap: 12 }}>
        {messages.length === 0 && (
          <div style={{ textAlign: "center", color: C.textMuted, marginTop: 32 }}>
            <div style={{ fontSize: 14, color: C.textSec, marginBottom: 4, fontWeight: 600 }}>Pose ta question</div>
            <div style={{ fontSize: 13, marginBottom: 18, padding: "0 24px" }}>Écris une référence ou une phrase — l&apos;assistant lit le stock dans Odoo.</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", padding: "0 12px" }}>
              {SUGGESTIONS.map(s => (
                <button key={s} onClick={() => send(s)}
                  style={{ padding: "8px 13px", borderRadius: 18, border: `1px solid ${C.border}`, background: C.white, color: C.textSec, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          m.role === "user" ? (
            <div key={i} style={{ alignSelf: "flex-end", maxWidth: "82%", background: C.blue, color: "#fff", padding: "9px 13px", borderRadius: "14px 14px 4px 14px", fontSize: 14.5, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>
              {m.text}
            </div>
          ) : (
            <div key={i} style={{ alignSelf: "flex-start", maxWidth: "88%", background: C.white, border: `1px solid ${C.border}`, color: C.text, padding: "10px 13px", borderRadius: "14px 14px 14px 4px", fontSize: 14.5, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
              {m.loading ? <TypingDots /> : m.text}
            </div>
          )
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Barre de saisie */}
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end", padding: "10px 12px", background: C.white, borderTop: `1px solid ${C.border}`, flexShrink: 0, paddingBottom: "calc(10px + env(safe-area-inset-bottom))" }}>
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="Pose ta question…"
          rows={1}
          style={{ flex: 1, resize: "none", maxHeight: 120, padding: "11px 14px", borderRadius: 20, border: `1px solid ${C.border}`, fontSize: 15, fontFamily: "inherit", outline: "none", lineHeight: 1.4, color: C.text }}
        />
        <button onClick={() => send()} disabled={busy || !input.trim()}
          style={{ width: 44, height: 44, borderRadius: "50%", border: "none", background: busy || !input.trim() ? C.textMuted : C.blue, color: "#fff", cursor: busy || !input.trim() ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
        </button>
      </div>
    </div>
  );
}

function TypingDots() {
  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center", height: 18 }}>
      {[0, 1, 2].map(i => (
        <span key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: "#cbd5e1", animation: `wmsblink 1.2s ${i * 0.2}s infinite ease-in-out` }} />
      ))}
      <style>{`@keyframes wmsblink { 0%, 60%, 100% { opacity: 0.3 } 30% { opacity: 1 } }`}</style>
    </span>
  );
}
