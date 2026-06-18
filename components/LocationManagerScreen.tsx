"use client";
import { useState, useEffect, useMemo } from "react";
import * as odoo from "@/lib/odoo";

const C = {
  bg: "#f8fafc", white: "#ffffff", text: "#1a1a2e", textSec: "#374151",
  textMuted: "#6b7280", border: "#e5e7eb", blue: "#3b82f6", blueSoft: "#eff6ff",
  green: "#22c55e", greenSoft: "#f0fdf4", red: "#ef4444", redSoft: "#fef2f2",
  orange: "#f97316", orangeSoft: "#fff7ed", purple: "#7c3aed", purpleSoft: "#f5f3ff",
  shadow: "0 1px 4px rgba(0,0,0,0.07)",
};

interface Loc {
  id: number;
  name: string;
  complete_name: string;
  barcode: string | false;
  usage: string;
  location_id: [number, string] | false;
}

interface Props {
  session: odoo.OdooSession;
  onBack: () => void;
  onToast: (msg: string, type?: "success" | "error" | "info") => void;
  // imprime l'étiquette emplacement (relié à requestPrint dans page.tsx)
  onPrintLocation: (name: string, barcode: string) => void;
}

export default function LocationManagerScreen({ session, onBack, onToast, onPrintLocation }: Props) {
  const [locs, setLocs] = useState<Loc[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  // formulaire de création (rempli par duplication)
  const [form, setForm] = useState<{ name: string; barcode: string; parentId: number; parentName: string; usage: string } | null>(null);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    setLoading(true);
    try { setLocs(await odoo.getLocations(session) as Loc[]); }
    catch (e: any) { onToast("Erreur chargement : " + e.message, "error"); }
    setLoading(false);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return locs;
    return locs.filter(l =>
      l.name.toLowerCase().includes(q) ||
      (l.complete_name || "").toLowerCase().includes(q) ||
      (l.barcode ? String(l.barcode).toLowerCase().includes(q) : false)
    );
  }, [locs, search]);

  // Duplique un emplacement → pré-remplit le formulaire (parent = même parent).
  const duplicate = (l: Loc) => {
    const parentId = Array.isArray(l.location_id) ? l.location_id[0] : 0;
    const parentName = Array.isArray(l.location_id) ? l.location_id[1] : "(racine)";
    setForm({
      name: l.name,
      barcode: l.barcode ? String(l.barcode) : "",
      parentId,
      parentName,
      usage: l.usage || "internal",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const create = async () => {
    if (!form) return;
    if (!form.name.trim()) { onToast("Nom requis", "error"); return; }
    if (!form.parentId) { onToast("Emplacement parent manquant", "error"); return; }
    setCreating(true);
    try {
      // garde-fou doublon code-barres
      if (form.barcode.trim()) {
        const exists = await odoo.locationBarcodeExists(session, form.barcode.trim());
        if (exists) { onToast("Ce code-barres existe déjà", "error"); setCreating(false); return; }
      }
      const id = await odoo.createLocation(session, {
        name: form.name, barcode: form.barcode, parentId: form.parentId, usage: form.usage,
      });
      onToast(`Emplacement « ${form.name} » créé ✓`, "success");
      const createdName = form.name.trim();
      const createdBarcode = (form.barcode || form.name).trim();
      setForm(null);
      await load();
      // impression proposée juste après création
      if (typeof window !== "undefined" && window.confirm(`Imprimer l'étiquette de « ${createdName} » ?`)) {
        onPrintLocation(createdName, createdBarcode);
      }
      void id;
    } catch (e: any) {
      onToast("Erreur création : " + (e?.message || String(e)), "error");
    }
    setCreating(false);
  };

  return (
    <div style={{ paddingBottom: 90 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <button onClick={onBack} style={{ background: C.bg, border: "none", borderRadius: 10, padding: 8, cursor: "pointer", display: "flex" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><path d="M19 12H5M12 5l-7 7 7 7" /></svg>
        </button>
        <div>
          <div style={{ fontSize: 17, fontWeight: 800, color: C.text }}>Gestion emplacements</div>
          <div style={{ fontSize: 12, color: C.textMuted }}>Duplique un emplacement, modifie nom + code-barres, crée et imprime</div>
        </div>
      </div>

      {/* Formulaire de création (apparaît après duplication) */}
      {form && (
        <div style={{ background: C.white, border: `1.5px solid ${C.blue}`, borderRadius: 14, padding: 16, marginBottom: 16, boxShadow: `0 0 0 3px ${C.blueSoft}` }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: C.blue, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 12 }}>Nouvel emplacement</div>
          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 10 }}>Parent : <b style={{ color: C.text }}>{form.parentName}</b> · type : {form.usage}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div>
              <label style={lbl}>Nom *</label>
              <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} autoFocus
                style={inp} placeholder="Ex: A13" />
            </div>
            <div>
              <label style={lbl}>Code-barres</label>
              <input value={form.barcode} onChange={e => setForm({ ...form, barcode: e.target.value })}
                style={{ ...inp, fontFamily: "monospace" }} placeholder="Ex: B-A13" />
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 3 }}>Laisse vide pour utiliser le nom comme code-barres.</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button onClick={create} disabled={creating}
              style={{ flex: 1, padding: "11px 0", background: C.green, color: "#fff", border: "none", borderRadius: 10, fontWeight: 800, fontSize: 14, cursor: "pointer", fontFamily: "inherit", opacity: creating ? 0.6 : 1 }}>
              {creating ? "Création…" : "Créer l'emplacement"}
            </button>
            <button onClick={() => setForm(null)} disabled={creating}
              style={{ padding: "11px 18px", background: C.white, color: C.textSec, border: `1.5px solid ${C.border}`, borderRadius: 10, fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}>
              Annuler
            </button>
          </div>
        </div>
      )}

      {/* Recherche */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 Rechercher un emplacement (nom, chemin, code-barres)…"
          style={{ flex: 1, minWidth: 0, padding: "9px 12px", border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 13, fontFamily: "inherit", background: C.white, color: C.text, outline: "none", boxSizing: "border-box" }} />
        {search && <button onClick={() => setSearch("")} style={{ padding: "9px 12px", background: C.white, border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 12, cursor: "pointer", color: C.textMuted }}>✕</button>}
        <button onClick={load} title="Recharger" style={{ padding: "9px 12px", background: C.white, border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 13, cursor: "pointer", color: C.textSec, fontFamily: "inherit" }}>↻</button>
      </div>

      {loading ? (
        <div style={{ textAlign: "center", padding: 40, color: C.textMuted, fontSize: 14 }}>Chargement…</div>
      ) : (
        <>
          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 8 }}>{filtered.length} emplacement{filtered.length > 1 ? "s" : ""}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {filtered.map(l => (
              <div key={l.id} style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, padding: "11px 14px", boxShadow: C.shadow, display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{l.name}</div>
                  <div style={{ fontSize: 11, color: C.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.complete_name}</div>
                  {l.barcode && <div style={{ fontSize: 11, fontFamily: "monospace", color: C.blue, marginTop: 1 }}>{l.barcode}</div>}
                </div>
                <button onClick={() => duplicate(l)} title="Dupliquer"
                  style={{ padding: "6px 12px", background: C.blueSoft, color: C.blue, border: `1px solid ${C.blue}44`, borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", flexShrink: 0 }}>
                  Dupliquer
                </button>
                <button onClick={() => onPrintLocation(l.name, l.barcode ? String(l.barcode) : l.name)} title="Imprimer l'étiquette"
                  style={{ padding: "6px 10px", background: C.bg, color: C.textSec, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, cursor: "pointer", fontFamily: "inherit", flexShrink: 0 }}>
                  🖨
                </button>
              </div>
            ))}
            {!filtered.length && <div style={{ textAlign: "center", padding: 30, color: C.textMuted, fontSize: 13 }}>Aucun emplacement</div>}
          </div>
        </>
      )}
    </div>
  );
}

const lbl: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 5 };
const inp: React.CSSProperties = { width: "100%", boxSizing: "border-box", padding: "10px 12px", border: "1.5px solid #e5e7eb", borderRadius: 10, fontSize: 14, fontFamily: "inherit", background: "#f8fafc", color: "#1a1a2e", outline: "none" };
