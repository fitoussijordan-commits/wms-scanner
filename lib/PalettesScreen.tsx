"use client";
// app/palettes/page.tsx  — ou intégrer dans page.tsx comme screen "palettes"
// Screen de gestion des palettes WMS

import { useState, useEffect, useCallback } from "react";
import * as supa from "@/lib/supabase-palettes";
import type { WmsPalette, WmsPaletteLigne } from "@/lib/supabase-palettes";

const C = {
  bg: "#f5f6f8", white: "#ffffff",
  blue: "#2563eb", blueSoft: "#eff6ff", blueBorder: "#bfdbfe",
  green: "#16a34a", greenSoft: "#f0fdf4", greenBorder: "#bbf7d0",
  orange: "#ea580c", orangeSoft: "#fff7ed", orangeBorder: "#fed7aa",
  red: "#dc2626", redSoft: "#fef2f2", redBorder: "#fecaca",
  purple: "#7c3aed", purpleSoft: "#f5f3ff", purpleBorder: "#ddd6fe",
  text: "#111827", textSec: "#4b5563", textMuted: "#9ca3af",
  border: "#e5e7eb",
  shadow: "0 1px 3px rgba(0,0,0,0.08)",
};

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "11px 14px", border: `1.5px solid ${C.border}`,
  borderRadius: 10, fontSize: 14, fontFamily: "inherit",
  background: C.white, color: C.text, outline: "none", boxSizing: "border-box",
};

// ══════════════════════════════════════════════════════
// MAIN SCREEN
// ══════════════════════════════════════════════════════
export default function PalettesScreen({ onBack, session, printerId }: {
  onBack: () => void;
  session?: any;
  printerId?: number;
}) {
  const [view, setView] = useState<"list" | "detail" | "search">("list");
  const [palettes, setPalettes] = useState<WmsPalette[]>([]);
  const [selected, setSelected] = useState<WmsPalette | null>(null);
  const [lignes, setLignes] = useState<WmsPaletteLigne[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [searchRef, setSearchRef] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [statut, setStatut] = useState("actif");
  const [scanInput, setScanInput] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPalettes(await supa.loadPalettes(statut));
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  }, [statut]);

  useEffect(() => { load(); }, [load]);

  const openPalette = async (p: WmsPalette) => {
    setLoading(true);
    try {
      const { palette, lignes } = await supa.loadPaletteDetail(p.id);
      setSelected(palette);
      setLignes(lignes);
      setView("detail");
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const createPalette = async () => {
    setLoading(true);
    try {
      const p = await supa.createPalette();
      await openPalette(p);
      load();
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  // Scan palette numéro depuis la liste
  const handleScan = async (code: string) => {
    if (/^Pal-\d+$/i.test(code)) {
      const p = await supa.findPaletteByNumero(code);
      if (p) { openPalette(p); setScanInput(""); return; }
    }
    setError(`"${code}" non reconnu`);
    setScanInput("");
  };

  const searchProduct = async () => {
    if (!searchRef.trim()) return;
    setLoading(true);
    try {
      const r = await supa.searchProductInPalettes(searchRef.trim());
      setSearchResults(r);
      setView("search");
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  // ── DETAIL VIEW ──
  if (view === "detail" && selected) {
    return <PaletteDetail
      palette={selected}
      lignes={lignes}
      session={session}
      printerId={printerId}
      onBack={() => { setView("list"); load(); }}
      onRefresh={async () => {
        const { palette, lignes } = await supa.loadPaletteDetail(selected.id);
        setSelected(palette); setLignes(lignes);
      }}
    />;
  }

  // ── SEARCH VIEW ──
  if (view === "search") {
    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
          <button onClick={() => setView("list")} style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Résultats pour "{searchRef}"</div>
        </div>
        {searchResults.length === 0
          ? <div style={{ textAlign: "center", padding: 40, color: C.textMuted }}>Aucune palette trouvée</div>
          : searchResults.map((r, i) => (
            <div key={i} style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14, marginBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontWeight: 700, color: C.purple, fontSize: 15 }}>{r.palette_numero}</div>
                <div style={{ fontSize: 12, color: C.textMuted }}>{r.palette_emplacement || "—"}</div>
              </div>
              <div style={{ fontSize: 13, color: C.text, marginTop: 4 }}>{r.product_name}</div>
              <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>
                {r.lot ? `Lot: ${r.lot}` : "Sans lot"} · <strong style={{ color: C.green }}>{r.qty} {r.unite}</strong>
              </div>
            </div>
          ))
        }
      </div>
    );
  }

  // ── LIST VIEW ──
  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <button onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: C.text }}>Palettes WMS</div>
          <div style={{ fontSize: 12, color: C.textMuted }}>{palettes.length} palette{palettes.length > 1 ? "s" : ""}</div>
        </div>
        <button onClick={createPalette} disabled={loading} style={{ background: C.purple, color: "#fff", border: "none", borderRadius: 10, padding: "10px 16px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
          + Nouvelle
        </button>
      </div>

      {error && <div style={{ background: C.redSoft, border: `1px solid ${C.redBorder}`, borderRadius: 10, padding: "10px 14px", color: C.red, fontSize: 13, marginBottom: 12 }} onClick={() => setError("")}>{error} ✕</div>}

      {/* Scan palette */}
      <input style={{ ...inputStyle, borderColor: C.purple, marginBottom: 10 }}
        value={scanInput}
        onChange={e => setScanInput(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter" && scanInput.trim()) handleScan(scanInput.trim()); }}
        placeholder="📷 Scanner Pal-XXXX pour ouvrir..."
      />

      {/* Recherche produit */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input style={{ ...inputStyle, flex: 1 }} value={searchRef} onChange={e => setSearchRef(e.target.value)}
          onKeyDown={e => e.key === "Enter" && searchProduct()}
          placeholder="Rechercher une réf dans les palettes..." />
        <button onClick={searchProduct} disabled={loading || !searchRef.trim()} style={{ background: C.blue, color: "#fff", border: "none", borderRadius: 10, padding: "10px 14px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>🔍</button>
      </div>

      {/* Filtre statut */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        {["actif", "archive", "expedie"].map(s => (
          <button key={s} onClick={() => setStatut(s)} style={{ flex: 1, padding: "8px 0", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", border: "none", background: statut === s ? C.purple : C.bg, color: statut === s ? "#fff" : C.textSec }}>
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {loading && <div style={{ textAlign: "center", padding: 40, color: C.textMuted }}>Chargement...</div>}

      {/* Liste */}
      {palettes.map(p => {
        const age = Math.floor((Date.now() - new Date(p.updated_at).getTime()) / 86400000);
        return (
          <div key={p.id} onClick={() => openPalette(p)}
            style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 14, padding: "14px 16px", marginBottom: 8, cursor: "pointer", boxShadow: C.shadow }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontWeight: 800, fontSize: 16, color: C.purple }}>{p.numero}</div>
              <div style={{ fontSize: 11, color: C.textMuted }}>{age === 0 ? "Aujourd'hui" : `Il y a ${age}j`}</div>
            </div>
            <div style={{ fontSize: 12, color: C.textSec, marginTop: 4, display: "flex", gap: 12 }}>
              <span>📍 {p.emplacement || "—"}</span>
              {p.notes && <span style={{ color: C.textMuted }}>📝 {p.notes}</span>}
            </div>
          </div>
        );
      })}
      {!loading && palettes.length === 0 && <div style={{ textAlign: "center", padding: 40, color: C.textMuted }}>Aucune palette {statut}</div>}
    </div>
  );
}

// ══════════════════════════════════════════════════════
// PALETTE DETAIL
// ══════════════════════════════════════════════════════
function PaletteDetail({ palette, lignes, session, printerId, onBack, onRefresh }: {
  palette: WmsPalette;
  lignes: WmsPaletteLigne[];
  session?: any;
  printerId?: number;
  onBack: () => void;
  onRefresh: () => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [editEmplacement, setEditEmplacement] = useState(false);
  const [emplacement, setEmplacement] = useState(palette.emplacement || "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // Formulaire ajout ligne
  const [newRef, setNewRef] = useState("");
  const [newName, setNewName] = useState("");
  const [newLot, setNewLot] = useState("");
  const [newExpiry, setNewExpiry] = useState("");
  const [newQty, setNewQty] = useState("1");
  const [newUnite, setNewUnite] = useState("unité");

  const totalQty = lignes.reduce((s, l) => s + l.qty, 0);

  const addLigne = async () => {
    if (!newRef.trim() || !newQty) return;
    setLoading(true);
    try {
      await supa.upsertLigne(palette.id, {
        odoo_ref: newRef.trim(),
        product_name: newName.trim() || newRef.trim(),
        lot: newLot.trim() || null,
        expiry_date: newExpiry || null,
        qty: parseFloat(newQty),
        unite: newUnite,
        updated_at: new Date().toISOString(),
      });
      await onRefresh();
      setNewRef(""); setNewName(""); setNewLot(""); setNewExpiry(""); setNewQty("1");
      setAdding(false);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const changeQty = async (ligneId: number, qty: number) => {
    setLoading(true);
    try {
      await supa.updateLigneQty(ligneId, qty);
      await onRefresh();
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const saveEmplacement = async () => {
    setLoading(true);
    try {
      await supa.updatePalette(palette.id, { emplacement });
      setEditEmplacement(false);
      await onRefresh();
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const changeStatut = async (statut: WmsPalette["statut"]) => {
    setLoading(true);
    try {
      await supa.updatePalette(palette.id, { statut });
      await onRefresh();
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const printLabel = async () => {
    if (!printerId) { setError("Aucune imprimante configurée"); return; }
    const zpl = supa.generatePaletteZPL(palette, lignes);
    try {
      const res = await fetch("/api/printnode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ printerId, content: btoa(zpl), contentType: "raw_base64", title: palette.numero }),
      });
      if (!res.ok) throw new Error("Erreur impression");
    } catch (e: any) { setError(e.message); }
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <button onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#111827" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 22, fontWeight: 900, color: "#7c3aed" }}>{palette.numero}</div>
          <div style={{ fontSize: 12, color: "#9ca3af" }}>{lignes.length} réf · {totalQty} unités</div>
        </div>
        <button onClick={printLabel} style={{ background: "#f5f3ff", border: "1px solid #ddd6fe", borderRadius: 10, padding: "8px 12px", cursor: "pointer" }}>
          🖨️
        </button>
      </div>

      {error && <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, padding: "10px 14px", color: "#dc2626", fontSize: 13, marginBottom: 12 }} onClick={() => setError("")}>{error} ✕</div>}

      {/* Emplacement */}
      <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "12px 16px", marginBottom: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", marginBottom: 6, textTransform: "uppercase" }}>Emplacement</div>
        {editEmplacement ? (
          <div style={{ display: "flex", gap: 8 }}>
            <input style={{ ...inputStyle, flex: 1 }} value={emplacement} onChange={e => setEmplacement(e.target.value)} placeholder="ex: RKC1, A12..." autoFocus />
            <button onClick={saveEmplacement} style={{ background: "#16a34a", color: "#fff", border: "none", borderRadius: 8, padding: "8px 14px", fontWeight: 700, cursor: "pointer" }}>✓</button>
            <button onClick={() => setEditEmplacement(false)} style={{ background: "#f5f5f5", border: "1px solid #e5e7eb", borderRadius: 8, padding: "8px 14px", cursor: "pointer" }}>✕</button>
          </div>
        ) : (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: palette.emplacement ? "#2563eb" : "#9ca3af" }}>
              {palette.emplacement || "Non défini"}
            </span>
            <button onClick={() => setEditEmplacement(true)} style={{ background: "none", border: "none", cursor: "pointer", color: "#9ca3af", fontSize: 13 }}>✏️</button>
          </div>
        )}
      </div>

      {/* Statut */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        {(["actif", "archive", "expedie"] as const).map(s => (
          <button key={s} onClick={() => changeStatut(s)} style={{ flex: 1, padding: "8px 0", borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", border: "none", background: palette.statut === s ? "#7c3aed" : "#f5f6f8", color: palette.statut === s ? "#fff" : "#6b7280" }}>
            {s === "actif" ? "✅ Actif" : s === "archive" ? "📦 Archivé" : "🚚 Expédié"}
          </button>
        ))}
      </div>

      {/* Lignes */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>Contenu</div>
        <button onClick={() => setAdding(!adding)} style={{ background: adding ? "#fef2f2" : "#eff6ff", color: adding ? "#dc2626" : "#2563eb", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
          {adding ? "✕ Annuler" : "+ Ajouter"}
        </button>
      </div>

      {/* Formulaire ajout */}
      {adding && (
        <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 12, padding: 14, marginBottom: 14 }}>
          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ display: "flex", gap: 8 }}>
              <input style={{ ...inputStyle, flex: 2 }} value={newRef} onChange={e => setNewRef(e.target.value)} placeholder="Référence *" />
              <input style={{ ...inputStyle, flex: 3 }} value={newName} onChange={e => setNewName(e.target.value)} placeholder="Désignation" />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input style={{ ...inputStyle, flex: 2 }} value={newLot} onChange={e => setNewLot(e.target.value)} placeholder="Numéro de lot" />
              <input style={{ ...inputStyle, flex: 2 }} type="date" value={newExpiry} onChange={e => setNewExpiry(e.target.value)} />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input style={{ ...inputStyle, flex: 1 }} type="number" value={newQty} onChange={e => setNewQty(e.target.value)} placeholder="Qté" min="0.01" step="0.01" />
              <input style={{ ...inputStyle, flex: 1 }} value={newUnite} onChange={e => setNewUnite(e.target.value)} placeholder="unité" />
              <button onClick={addLigne} disabled={loading || !newRef.trim()} style={{ background: "#2563eb", color: "#fff", border: "none", borderRadius: 8, padding: "10px 18px", fontWeight: 700, cursor: "pointer" }}>
                {loading ? "..." : "✓"}
              </button>
            </div>
          </div>
        </div>
      )}

      {lignes.length === 0 && !adding && (
        <div style={{ textAlign: "center", padding: 32, color: "#9ca3af", fontSize: 13 }}>Palette vide — ajouter des articles</div>
      )}

      {lignes.map(l => (
        <div key={l.id} style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "12px 14px", marginBottom: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#2563eb", fontFamily: "monospace" }}>{l.odoo_ref}</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#111827", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.product_name}</div>
              <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2, display: "flex", gap: 10 }}>
                {l.lot && <span>🏷️ {l.lot}</span>}
                {l.expiry_date && <span>📅 {l.expiry_date}</span>}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
              <button onClick={() => changeQty(l.id, l.qty - 1)} style={{ width: 32, height: 32, borderRadius: 8, border: "1px solid #e5e7eb", background: "#fff", fontSize: 18, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: l.qty <= 1 ? "#dc2626" : "#374151" }}>−</button>
              <span style={{ fontSize: 16, fontWeight: 800, minWidth: 40, textAlign: "center", color: "#111827" }}>{l.qty}</span>
              <button onClick={() => changeQty(l.id, l.qty + 1)} style={{ width: 32, height: 32, borderRadius: 8, border: "1px solid #e5e7eb", background: "#fff", fontSize: 18, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#2563eb" }}>+</button>
            </div>
          </div>
        </div>
      ))}

      {/* Résumé */}
      {lignes.length > 0 && (
        <div style={{ background: "#f5f3ff", border: "1px solid #ddd6fe", borderRadius: 12, padding: "12px 16px", marginTop: 8 }}>
          <div style={{ fontSize: 13, color: "#7c3aed", fontWeight: 700 }}>
            {lignes.length} référence{lignes.length > 1 ? "s" : ""} · {totalQty} unité{totalQty > 1 ? "s" : ""} au total
          </div>
        </div>
      )}
    </div>
  );
}
