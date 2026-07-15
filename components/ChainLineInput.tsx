"use client";
// components/ChainLineInput.tsx
// ────────────────────────────────────────────────────────────────────────────
// Ligne de saisie d'une palette (packing list "Chaîne") avec :
//  • autocomplétion produit Odoo sur le champ Réf/Désignation (mais saisie libre OK)
//  • choix du lot parmi les lots EN STOCK du produit (avec qté dispo), saisie libre OK
//  • champ quantité
// ────────────────────────────────────────────────────────────────────────────
import { useState, useEffect, useRef } from "react";
import * as odoo from "@/lib/odoo";

const C = { border: "#e5e7eb", text: "#1a1a2e", muted: "#6b7280", blue: "#2563eb", blueSoft: "#eff6ff", white: "#fff" };

interface Line { ref: string; lot: string; qty: string; productId?: number }

export default function ChainLineInput({
  session, line, onChange, onRemove, canRemove,
}: {
  session: odoo.OdooSession;
  line: Line;
  onChange: (l: Line) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const [prodSugg, setProdSugg] = useState<{ id: number; name: string; ref: string }[]>([]);
  const [prodOpen, setProdOpen] = useState(false);
  const [lots, setLots] = useState<{ lotId: number; lotName: string; qty: number }[]>([]);
  const [lotOpen, setLotOpen] = useState(false);
  const [loadingLots, setLoadingLots] = useState(false);
  const typing = useRef(false);

  // Autocomplétion produit (debounce). Ne se déclenche que si l'utilisateur tape.
  useEffect(() => {
    if (!typing.current) return;
    const q = line.ref.trim();
    if (q.length < 2) { setProdSugg([]); return; }
    const t = setTimeout(async () => {
      try { setProdSugg(await odoo.suggestProducts(session, q)); } catch { setProdSugg([]); }
    }, 300);
    return () => clearTimeout(t);
  }, [line.ref, session]);

  // Charge les lots en stock quand un productId est défini.
  const loadLots = async (pid: number) => {
    setLoadingLots(true);
    try { setLots(await odoo.getProductStockLots(session, pid)); } catch { setLots([]); }
    setLoadingLots(false);
  };

  const pickProduct = (p: { id: number; name: string; ref: string }) => {
    typing.current = false;
    onChange({ ...line, ref: `${p.ref} ${p.name}`.trim(), productId: p.id });
    setProdOpen(false); setProdSugg([]);
    loadLots(p.id);
  };

  const inp: React.CSSProperties = { padding: "7px 8px", border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box", background: C.white };

  return (
    <div style={{ display: "flex", gap: 5, marginBottom: 5, alignItems: "flex-start" }}>
      {/* Réf / Désignation avec autocomplétion */}
      <div style={{ flex: 2, minWidth: 0, position: "relative" }}>
        <input value={line.ref}
          onChange={e => { typing.current = true; onChange({ ...line, ref: e.target.value, productId: undefined }); setProdOpen(true); }}
          onFocus={() => setProdOpen(true)}
          placeholder="Réf / Désignation (tape pour chercher)"
          style={{ ...inp, width: "100%" }} />
        {prodOpen && prodSugg.length > 0 && (
          <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 30, background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, marginTop: 2, maxHeight: 220, overflowY: "auto", boxShadow: "0 8px 24px -8px rgba(0,0,0,.2)" }}>
            {prodSugg.map(p => (
              <button key={p.id} onClick={() => pickProduct(p)}
                style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 10px", border: "none", borderBottom: `1px solid #f3f4f6`, background: C.white, cursor: "pointer", fontSize: 12.5 }}>
                <span style={{ fontFamily: "monospace", fontWeight: 700, color: C.blue }}>{p.ref}</span>{" "}
                <span style={{ color: C.text }}>{p.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Lot avec menu des lots en stock */}
      <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
        <input value={line.lot}
          onChange={e => onChange({ ...line, lot: e.target.value })}
          onFocus={() => { setLotOpen(true); if (line.productId && !lots.length) loadLots(line.productId); }}
          placeholder="Lot"
          style={{ ...inp, width: "100%" }} />
        {lotOpen && line.productId && (
          <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 30, background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, marginTop: 2, maxHeight: 220, overflowY: "auto", boxShadow: "0 8px 24px -8px rgba(0,0,0,.2)" }}>
            {loadingLots && <div style={{ padding: "8px 10px", fontSize: 12, color: C.muted }}>Chargement des lots…</div>}
            {!loadingLots && !lots.length && <div style={{ padding: "8px 10px", fontSize: 12, color: C.muted }}>Aucun lot en stock</div>}
            {lots.map(l => (
              <button key={l.lotId} onClick={() => { onChange({ ...line, lot: l.lotName }); setLotOpen(false); }}
                style={{ display: "flex", justifyContent: "space-between", gap: 8, width: "100%", textAlign: "left", padding: "8px 10px", border: "none", borderBottom: `1px solid #f3f4f6`, background: C.white, cursor: "pointer", fontSize: 12.5 }}>
                <span style={{ fontFamily: "monospace", fontWeight: 700 }}>{l.lotName}</span>
                <span style={{ color: C.muted }}>dispo {l.qty}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <input value={line.qty} onChange={e => onChange({ ...line, qty: e.target.value })} placeholder="Qté"
        style={{ ...inp, width: 52, textAlign: "center" }} />
      {canRemove && (
        <button onClick={onRemove} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 16, lineHeight: 1, flexShrink: 0, padding: "7px 2px" }}>✕</button>
      )}
    </div>
  );
}
