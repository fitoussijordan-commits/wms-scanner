"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import * as odoo from "@/lib/odoo";
import { loadPalettes as palLoad, loadPaletteDetail as palDetail, findPaletteByNumero as palFind, createPalette as palCreate, upsertLigne as palUpsert, updateLigneQty as palUpdateQty, updatePalette as palUpdate, searchProductInPalettes as palSearch, generatePaletteZPL as palZPL } from "@/lib/supabase-palettes";
import type { WmsPalette, WmsPaletteLigne } from "@/lib/supabase-palettes";

const C = {
  bg: "#f5f6f8", white: "#ffffff", card: "#ffffff", overlay: "rgba(0,0,0,0.04)",
  blue: "#2563eb", blueSoft: "#eff6ff", blueBorder: "#bfdbfe", blueDark: "#1d4ed8",
  green: "#16a34a", greenSoft: "#f0fdf4", greenBorder: "#bbf7d0",
  orange: "#ea580c", orangeSoft: "#fff7ed", orangeBorder: "#fed7aa",
  red: "#dc2626", redSoft: "#fef2f2", redBorder: "#fecaca",
  text: "#111827", textSec: "#4b5563", textMuted: "#9ca3af",
  border: "#e5e7eb", borderStrong: "#d1d5db",
  shadow: "0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04)",
  shadowLg: "0 4px 12px rgba(0,0,0,0.1)",
};

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "12px 14px", background: C.bg, border: `1.5px solid ${C.border}`, borderRadius: 10,
  color: C.text, fontSize: 14, fontFamily: "'DM Sans', sans-serif", outline: "none", boxSizing: "border-box",
};

const secondaryBtn: React.CSSProperties = {
  width: "100%", padding: 12, background: "none", color: C.blue, border: `1.5px solid ${C.border}`, borderRadius: 10,
  fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans', sans-serif",
};

const cardStyle: React.CSSProperties = { background: C.white, borderRadius: 14, padding: 16, border: `1px solid ${C.border}`, boxShadow: C.shadow };

const printerSmallIcon = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={C.blue} strokeWidth="2.5"><path d="M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>;

function Section({ children, style: s }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ ...cardStyle, ...s }}>{children}</div>;
}

function SectionHeader({ icon, title, sub }: { icon: React.ReactNode; title: string; sub: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
      <div style={{ width: 36, height: 36, borderRadius: 10, background: C.blueSoft, display: "flex", alignItems: "center", justifyContent: "center" }}>{icon}</div>
      <div>
        <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{title}</div>
        <div style={{ fontSize: 12, color: C.textMuted }}>{sub}</div>
      </div>
    </div>
  );
}

function Alert({ type, children }: { type: string; children: React.ReactNode }) {
  const m: Record<string, { bg: string; border: string; color: string }> = {
    success: { bg: C.greenSoft, border: C.greenBorder, color: C.green },
    error: { bg: C.redSoft, border: C.redBorder, color: C.red },
  };
  const s = m[type] || m.success;
  return <div style={{ background: s.bg, border: `1px solid ${s.border}`, borderRadius: 10, padding: "10px 14px", color: s.color, fontSize: 13, fontWeight: 700, marginBottom: 10 }}>{children}</div>;
}

function Spinner() { return <span style={{ fontSize: 11, color: C.blue, animation: "pulse 1s infinite" }}>Chargement...</span>; }

function BigButton({ icon, label, sub, color, onClick, disabled }: { icon: React.ReactNode; label: string; sub?: string; color?: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      width: "100%", display: "flex", alignItems: "center", gap: 14, padding: "16px 20px",
      background: color || C.blue, border: "none", borderRadius: 14, cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.6 : 1, boxShadow: `0 2px 8px ${(color || C.blue)}33`, fontFamily: "inherit",
    }}>
      <div style={{ width: 40, height: 40, borderRadius: 10, background: "rgba(255,255,255,0.2)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{icon}</div>
      <div style={{ textAlign: "left" }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}>{label}</div>
        {sub && <div style={{ fontSize: 12, color: "rgba(255,255,255,0.7)", marginTop: 2 }}>{sub}</div>}
      </div>
    </button>
  );
}

function requestPrint(req: any) {}

}

type PaletteView = "menu" | "scan" | "lookup" | "stock";

export default function PalettesScreen({ onBack, session, getPalettePrinter, onScanRef }: {
  onBack: () => void;
  session?: any;
  getPalettePrinter?: () => number | null;
  onScanRef?: React.MutableRefObject<((code: string) => void) | null>;
}) {
  const [view, setView] = useState<PaletteView>("menu");
  const [scanInput, setScanInput] = useState("");
  const [currentPalette, setCurrentPalette] = useState<WmsPalette | null>(null);
  const [lignes, setLignes] = useState<WmsPaletteLigne[]>([]);
  const currentPaletteRef = useRef<WmsPalette | null>(null);
  const setCurPalette = (p: WmsPalette | null) => { currentPaletteRef.current = p; setCurrentPalette(p); };
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [successMsg, setSuccessMsg] = useState("");
  const [batchQty, setBatchQty] = useState("5");
  const [editingLigne, setEditingLigne] = useState<number | null>(null);
  const [editQty, setEditQty] = useState("");
  const [editEmpl, setEditEmpl] = useState(false);
  const [editEmplValue, setEditEmplValue] = useState("");
  const [sortingLigne, setSortingLigne] = useState<number | null>(null);
  const [sortQty, setSortQty] = useState("");
  const [stockData, setStockData] = useState<{ ref: string; name: string; odoo: number; supabase: number; picking: number }[]>([]);
  const [stockLoading, setStockLoading] = useState(false);
  // Config form
  const [cfgEmpl, setCfgEmpl] = useState("");
  const [cfgRef, setCfgRef] = useState("");
  const [cfgName, setCfgName] = useState("");
  const [cfgCapa, setCfgCapa] = useState("5");


  // Scan step: 0=scan palette, 1=scan ref, 2=lot, 3=qty, 4=emplacement
  const [step, setStep] = useState(0);
  const stepRef = useRef(0);
  const updateStep = (v: number) => { stepRef.current = v; setStep(v); };
  const [newRef, setNewRef] = useState("");
  const [newName, setNewName] = useState("");
  const [newLot, setNewLot] = useState("");
  const [newQty, setNewQty] = useState("1");
  const [newEmplacement, setNewEmplacement] = useState("");
  const [packaging, setPackaging] = useState<number | null>(null); // qty par conditionnement
  const [qtyMode, setQtyMode] = useState<"colis" | "libre">("colis");

  // Lookup
  const [lookupInput, setLookupInput] = useState("");
  const [lookupResults, setLookupResults] = useState<{ palette: WmsPalette; lignes: WmsPaletteLigne[] }[]>([]);

  const showSuccess = (msg: string) => { setSuccessMsg(msg); setTimeout(() => setSuccessMsg(""), 2500); };

  // Scan callback — simple ref, mis à jour via onScanRef directement
  // Le parent appelle paletteScanRef.current(code) qui délègue à handleScanRef
  const handleScanRef = useRef<(code: string) => void>(() => {});
  useEffect(() => {
    if (onScanRef) onScanRef.current = (code: string) => handleScanRef.current(code);
    return () => { if (onScanRef) onScanRef.current = null; };
  }, [onScanRef]);

  const printPalette = async (p: WmsPalette, ls: WmsPaletteLigne[]) => {
    const printId = getPalettePrinter?.();
    if (!printId) { setError("Aucune imprimante Palettes WMS configurée (Paramètres → Imprimantes)"); return; }
    const zpl = palZPL(p, ls);
    try {
      const res = await fetch("/api/printnode", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "print", printerId: printId, title: p.numero, content: btoa(unescape(encodeURIComponent(zpl))), source: "WMS Scanner" }),
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || `PrintNode ${res.status}`); }
      showSuccess(`🖨️ ${p.numero} envoyée`);
    } catch (e: any) { setError(`Impression échouée: ${e.message}`); }
  };

  // Fetch packaging qty from Odoo
  const fetchPackaging = async (productId: number): Promise<number | null> => {
    if (!session) return null;
    try {
      const pkgs = await odoo.searchRead(session, "product.packaging",
        [["product_id", "=", productId]], ["qty", "name"], 5);
      if (pkgs.length > 0) return pkgs[0].qty || null;
    } catch {}
    return null;
  };

  const handleScan = async (code: string) => {
    if (!code.trim()) {
      // Step 0 + vide = créer nouvelle palette
      if (stepRef.current === 0) {
        setLoading(true);
        try {
          const p = await palCreate();
          const { lignes: ls } = await palDetail(p.id);
          setCurPalette(p); setLignes(ls); updateStep(1);
          await printPalette(p, ls);
          showSuccess(`✓ ${p.numero} créée`);
        } catch (e: any) { setError(e.message); }
        setLoading(false);
      }
      return;
    }
    setScanInput(""); setError("");

    // ── Si on scanne un numéro de palette à n'importe quel step → reset et ouvrir ──
    if (/^Pal-\d+$/i.test(code.trim()) && stepRef.current !== 0) {
      setLoading(true);
      try {
        const p = await palFind(code.trim());
        if (p) {
          const { lignes: ls } = await palDetail(p.id);
          setCurPalette(p); setLignes(ls); updateStep(1);
          setNewRef(""); setNewName(""); setNewLot(""); setNewQty("1"); setNewEmplacement(""); setPackaging(null); setQtyMode("colis");
          showSuccess(`✓ ${p.numero} chargée`);
          setLoading(false);
          return;
        }
      } catch {}
      setLoading(false);
    }

    // Step 0 — scan palette
    if (stepRef.current === 0) {
      setLoading(true);
      try {
        let p: WmsPalette | null = null;
        if (/^Pal-\d+$/i.test(code.trim())) {
          p = await palFind(code.trim());
        }
        if (!p) {
          p = await palCreate();
          const { lignes: ls } = await palDetail(p.id);
          setCurPalette(p); setLignes(ls); updateStep(1);
          await printPalette(p, ls);
          showSuccess(`✓ ${p.numero} créée`);
        } else {
          const { lignes: ls } = await palDetail(p.id);
          setCurPalette(p); setLignes(ls); updateStep(1);
          showSuccess(`✓ ${p.numero} chargée`);
        }
      } catch (e: any) { setError(e.message); }
      setLoading(false);
      return;
    }

    // Step 1 — référence produit
    if (stepRef.current === 1) {
      setPackaging(null); setQtyMode("colis");
      if (session) {
        setLoading(true);
        try {
          const r = await odoo.smartScan(session, code.trim());
          if (r.type === "product") {
            setNewRef(r.data.default_code || code.trim()); setNewName(r.data.name);
            const pkg = await fetchPackaging(r.data.id);
            setPackaging(pkg);
            showSuccess(`✓ ${r.data.name}${pkg ? ` (cond. ${pkg})` : ""}`);
            updateStep(2); setLoading(false); return;
          } else if (r.type === "lot") {
            setNewRef(r.data.product?.default_code || code.trim()); setNewName(r.data.product?.name || "");
            setNewLot(r.data.lot.name);
            if (r.data.product?.id) {
              const pkg = await fetchPackaging(r.data.product.id);
              setPackaging(pkg);
            }
            showSuccess(`✓ Lot ${r.data.lot.name}`); updateStep(3); setLoading(false); return;
          }
        } catch {}
        setLoading(false);
      }
      setNewRef(code.trim()); setNewName(""); showSuccess(`Réf: ${code.trim()}`); updateStep(2);
      return;
    }

    // Step 2 — lot
    if (stepRef.current === 2) { setNewLot(code.trim()); showSuccess(`Lot: ${code.trim()}`); updateStep(3); return; }

    // Step 3 — qty (colis × packaging ou libre)
    if (stepRef.current === 3) {
      const n = parseFloat(code.trim());
      if (!isNaN(n) && n > 0) {
        const totalQty = (packaging && qtyMode === "colis") ? n * packaging : n;
        setNewQty(String(totalQty));
        showSuccess(packaging && qtyMode === "colis" ? `${n} × ${packaging} = ${totalQty} unités` : `Qté: ${totalQty}`);
        updateStep(4);
      } else {
        setError("Quantité invalide");
      }
      return;
    }

    // Step 4 — emplacement
    if (stepRef.current === 4) { setNewEmplacement(code.trim()); showSuccess(`Emplacement: ${code.trim()}`); return; }
  };
  // Lookup avec un code directement (pour le scanner physique)
  const handleLookupScan = async (code: string) => {
    if (!code.trim()) return;
    setLoading(true); setError(""); setLookupResults([]);
    setLookupInput(code.trim());
    try {
      const p = await palFind(code.trim());
      if (p) {
        const { palette, lignes } = await palDetail(p.id);
        setLookupResults([{ palette, lignes }]);
      } else {
        const results = await palSearch(code.trim());
        if (results.length) {
          const palMap = new Map<number, { palette: WmsPalette; lignes: WmsPaletteLigne[] }>();
          for (const r of results) {
            if (!palMap.has(r.palette_id)) {
              try { const d = await palDetail(r.palette_id); palMap.set(r.palette_id, d); } catch {}
            }
          }
          setLookupResults(Array.from(palMap.values()));
        } else {
          setError(`"${code}" — introuvable`);
        }
      }
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  // Route le scan physique selon la vue active
  const routeScan = useCallback((code: string) => {
    if (view === "lookup") handleLookupScan(code);
    else if (view === "scan" || view === "menu") handleScan(code);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);
  useEffect(() => { handleScanRef.current = routeScan; }, [routeScan]);

  const validateLine = async () => {
    if (!currentPalette || !newRef.trim()) return;
    setLoading(true);
    try {
      const ligneData: any = {
        odoo_ref: newRef.trim(), product_name: newName.trim() || newRef.trim(),
        lot: newLot.trim() || null, expiry_date: null, qty: parseFloat(newQty) || 1, unite: "unité",
      };
      if (packaging) ligneData.packaging_qty = packaging;
      await palUpsert(currentPalette.id, ligneData);
      if (newEmplacement.trim()) await palUpdate(currentPalette.id, { emplacement: newEmplacement.trim() });
      const { palette: p, lignes: ls } = await palDetail(currentPalette.id);
      setCurPalette(p); setLignes(ls);
      showSuccess("✓ Ligne ajoutée");
      // Reset complet — prêt pour une nouvelle palette
      setNewRef(""); setNewName(""); setNewLot(""); setNewQty("1"); setNewEmplacement(""); setPackaging(null); setQtyMode("colis");
      setCurPalette(null); setLignes([]); updateStep(0);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const handleLookup = async () => {
    if (!lookupInput.trim()) return;
    setLoading(true); setError(""); setLookupResults([]);
    try {
      const p = await palFind(lookupInput.trim());
      if (p) {
        const { palette, lignes } = await palDetail(p.id);
        setLookupResults([{ palette, lignes }]);
      } else {
        const results = await palSearch(lookupInput.trim());
        if (results.length) {
          const palMap = new Map<number, { palette: WmsPalette; lignes: WmsPaletteLigne[] }>();
          for (const r of results) {
            if (!palMap.has(r.palette_id)) {
              try { const d = await palDetail(r.palette_id); palMap.set(r.palette_id, d); } catch {}
            }
          }
          setLookupResults(Array.from(palMap.values()));
        } else {
          setError(`"${lookupInput}" — introuvable`);
        }
      }
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const stepLabels = ["Palette", "Référence", "Lot", "Quantité", "Emplacement"];

  // Batch: créer et imprimer N palettes vierges d'un coup
  const batchPrint = async () => {
    const n = parseInt(batchQty) || 0;
    if (n < 1 || n > 50) { setError("Entre 1 et 50 max"); return; }
    const printId = getPalettePrinter?.();
    if (!printId) { setError("Aucune imprimante Palettes WMS configurée"); return; }
    setLoading(true); setError("");
    let ok = 0;
    for (let i = 0; i < n; i++) {
      try {
        const p = await palCreate();
        const zpl = palZPL(p, []);
        await fetch("/api/printnode", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "print", printerId: printId, title: p.numero, content: btoa(unescape(encodeURIComponent(zpl))), source: "WMS Scanner" }),
        });
        ok++;
      } catch {}
    }
    showSuccess(`✓ ${ok} étiquette${ok > 1 ? "s" : ""} palette${ok > 1 ? "s" : ""} imprimée${ok > 1 ? "s" : ""}`);
    setLoading(false);
  };

  // Sortir X unités d'une ligne palette → décrémente Supabase
  const sortirVersPicking = async (ligneId: number, qtySortie: number) => {
    if (qtySortie <= 0 || !currentPalette) return;
    setLoading(true);
    try {
      const ligne = lignes.find(l => l.id === ligneId);
      if (!ligne) throw new Error("Ligne introuvable");
      const newQty = ligne.qty - qtySortie;
      await palUpdateQty(ligneId, Math.max(0, newQty));
      const { palette: p, lignes: ls } = await palDetail(currentPalette.id);
      setCurPalette(p); setLignes(ls);
      setSortingLigne(null); setSortQty("");
      showSuccess(`✓ ${qtySortie} sorti${qtySortie > 1 ? "s" : ""} vers picking`);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  // Charger stock théorique picking = Odoo total - Supabase total par ref
  const loadStockPicking = async () => {
    if (!session) return;
    setStockLoading(true); setError("");
    try {
      // 1. Charger toutes les palettes actives depuis Supabase
      const palettes = await palLoad("actif");
      const supaMap: Record<string, { qty: number; name: string }> = {};
      for (const pal of palettes) {
        const { lignes: ls } = await palDetail(pal.id);
        for (const l of ls) {
          if (!supaMap[l.odoo_ref]) supaMap[l.odoo_ref] = { qty: 0, name: l.product_name };
          supaMap[l.odoo_ref].qty += l.qty;
        }
      }
      // 2. Pour chaque ref, chercher le stock Odoo total
      const refs = Object.keys(supaMap);
      const result: typeof stockData = [];
      for (const ref of refs) {
        try {
          const prods = await odoo.searchRead(session, "product.product", [["default_code", "=", ref]], ["id", "name"], 1);
          if (prods.length > 0) {
            const quants = await odoo.searchRead(session, "stock.quant",
              [["product_id", "=", prods[0].id], ["location_id.usage", "=", "internal"]],
              ["quantity"], 100);
            const odooTotal = quants.reduce((s: number, q: any) => s + (q.quantity || 0), 0);
            const supaTotal = supaMap[ref].qty;
            result.push({ ref, name: supaMap[ref].name, odoo: odooTotal, supabase: supaTotal, picking: Math.max(0, odooTotal - supaTotal) });
          }
        } catch {}
      }
      result.sort((a, b) => b.picking - a.picking);
      setStockData(result);
    } catch (e: any) { setError(e.message); }
    setStockLoading(false);
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <button onClick={view === "menu" ? onBack : () => { setView("menu"); setError(""); }}
          style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: C.text }}>Palettes WMS</div>
          {view !== "menu" && <div style={{ fontSize: 12, color: C.textMuted }}>
            {view === "scan" ? "Scanner / Remplir" : view === "lookup" ? "Recherche" : "Stock picking"}
          </div>}
        </div>
        {currentPalette && view === "scan" && <div style={{ fontSize: 12, color: "#7c3aed", fontWeight: 700 }}>{currentPalette.numero} · {lignes.length} réf</div>}
      </div>

      {/* Messages */}
      {successMsg && <Alert type="success">{successMsg}</Alert>}
      {error && <div style={{ background: C.redSoft, border: `1px solid ${C.redBorder}`, borderRadius: 10, padding: "10px 14px", color: C.red, fontSize: 13, marginBottom: 10, cursor: "pointer" }} onClick={() => setError("")}>{error} ✕</div>}

      {/* ── MENU ── */}
      {view === "menu" && (
        <div>
          <BigButton
            icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2"/><line x1="12" y1="12" x2="12" y2="17"/><line x1="9" y1="15" x2="15" y2="15"/></svg>}
            label="Scanner / Remplir"
            sub="Créer, scanner et remplir des palettes"
            color="#7c3aed"
            onClick={() => setView("scan")}
          />
          <div style={{ height: 10 }} />
          <BigButton
            icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>}
            label="Recherche palette"
            sub="Chercher par numéro ou référence produit"
            color="#2563eb"
            onClick={() => setView("lookup")}
          />
          <div style={{ height: 10 }} />
          <BigButton
            icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/></svg>}
            label="Stock picking théorique"
            sub="Odoo − Palettes = ce qui reste en picking"
            color="#ea580c"
            onClick={() => setView("stock")}
          />

      {/* ── LOOKUP VIEW ── */}
      {view === "lookup" && (
        <Section>
          <SectionHeader icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>} title="Rechercher" sub="Numéro palette ou référence produit" />
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <input style={{ ...inputStyle, flex: 1, borderColor: "#7c3aed" }}
              value={lookupInput} onChange={e => setLookupInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleLookup()}
              placeholder="Pal-0001 ou référence produit..." />
            <button onClick={handleLookup} disabled={loading}
              style={{ background: "#7c3aed", color: "#fff", border: "none", borderRadius: 10, padding: "10px 18px", fontWeight: 700, cursor: "pointer", fontSize: 14 }}>
              {loading ? "..." : "→"}
            </button>
          </div>
          {lookupResults.map(({ palette, lignes: ls }) => {
            const totalQ = ls.reduce((s, l) => s + l.qty, 0);
            return (
              <div key={palette.id} style={{ background: C.white, border: `1.5px solid #ddd6fe`, borderRadius: 14, padding: "14px 16px", marginBottom: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <div>
                    <div style={{ fontSize: 18, fontWeight: 900, color: "#7c3aed" }}>{palette.numero}</div>
                    <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>
                      📍 {palette.emplacement || "—"} · {ls.length} réf · {totalQ} unités ·{" "}
                      <span style={{ color: palette.statut === "actif" ? C.green : C.orange, fontWeight: 600 }}>{palette.statut}</span>
                    </div>
                  </div>
                  <button onClick={() => printPalette(palette, ls)}
                    style={{ background: "#f5f3ff", border: "1px solid #ddd6fe", borderRadius: 8, padding: "6px 10px", cursor: "pointer", flexShrink: 0 }}>
                    🖨️
                  </button>
                </div>
                {ls.length === 0
                  ? <div style={{ textAlign: "center", color: C.textMuted, padding: 12, fontSize: 13 }}>Palette vide</div>
                  : ls.map((l, i) => (
                    <div key={l.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderTop: i > 0 ? `1px solid ${C.border}` : "", fontSize: 12 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ fontWeight: 700, color: C.blue, fontFamily: "monospace" }}>{l.odoo_ref}</span>
                        <span style={{ color: C.text, marginLeft: 6 }}>{l.product_name}</span>
                        {l.lot && <span style={{ color: C.textMuted, marginLeft: 6 }}>🏷️ {l.lot}</span>}
                      </div>
                      <div style={{ textAlign: "right" as const, flexShrink: 0, marginLeft: 8 }}>
                        <div style={{ fontWeight: 800, fontSize: 14, color: C.text }}>{l.qty}</div>
                        {l.packaging_qty && l.packaging_qty > 1 && <div style={{ fontSize: 10, color: "#7c3aed", fontWeight: 600 }}>{Math.round(l.qty / l.packaging_qty)} × {l.packaging_qty}</div>}
                      </div>
                    </div>
                  ))
                }
              </div>
            );
          })}
        </Section>
      )}

      {/* ── SCAN VIEW ── */}
      {view === "scan" && (
        <div>
          {/* Step bar */}
          <div style={{ display: "flex", gap: 2, marginBottom: 14 }}>
            {stepLabels.map((label, i) => (
              <div key={i} style={{ flex: 1, textAlign: "center" as const }}>
                <div style={{ height: 4, borderRadius: 2, marginBottom: 4, background: i < step ? C.green : i === step ? "#7c3aed" : C.border, transition: "background .2s" }} />
                <div style={{ fontSize: 10, fontWeight: i === step ? 700 : 500, color: i === step ? "#7c3aed" : i < step ? C.green : C.textMuted }}>
                  {i < step ? "✓" : ""} {label}
                </div>
              </div>
            ))}
          </div>

          {/* Batch print — imprimer des palettes vierges pour aller en stock */}
          {step === 0 && !currentPalette && (
            <Section style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 8 }}>🖨️ Étiquettes palettes vierges</div>
              <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 10 }}>Imprimer un lot d'étiquettes avant d'aller en stock</div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {[3, 5, 10, 20].map(n => (
                  <button key={n} onClick={() => setBatchQty(String(n))}
                    style={{ padding: "8px 0", flex: 1, borderRadius: 8, border: `1.5px solid ${batchQty === String(n) ? "#7c3aed" : C.border}`, background: batchQty === String(n) ? "#f5f3ff" : C.white, color: batchQty === String(n) ? "#7c3aed" : C.textSec, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
                    {n}
                  </button>
                ))}
                <input
                  style={{ ...inputStyle, width: 60, textAlign: "center" as const, padding: "8px 4px", fontSize: 14, fontWeight: 700 }}
                  value={batchQty} onChange={e => setBatchQty(e.target.value.replace(/\D/g, ""))}
                  type="text" inputMode="numeric" placeholder="N"
                />
              </div>
              <button onClick={batchPrint} disabled={loading || !batchQty}
                style={{ marginTop: 10, width: "100%", padding: 12, background: "#7c3aed", color: "#fff", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: loading ? "wait" : "pointer" }}>
                {loading ? `Impression en cours...` : `🖨️ Imprimer ${batchQty || 0} étiquette${parseInt(batchQty) > 1 ? "s" : ""}`}
              </button>
            </Section>
          )}

          {/* Current palette badge */}
          {currentPalette && (
            <div style={{ ...cardStyle, padding: "10px 14px", marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center", borderColor: "#ddd6fe" }}>
              <div>
                <span style={{ fontWeight: 800, fontSize: 16, color: "#7c3aed" }}>{currentPalette.numero}</span>
                {currentPalette.emplacement && <span style={{ fontSize: 12, color: C.textMuted, marginLeft: 8 }}>📍 {currentPalette.emplacement}</span>}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={() => currentPalette && printPalette(currentPalette, lignes)}
                  style={{ background: "#f5f3ff", border: "1px solid #ddd6fe", borderRadius: 8, padding: "6px 10px", cursor: "pointer", fontSize: 12 }}>
                  🖨️
                </button>
                <button onClick={() => { setCurPalette(null); setLignes([]); updateStep(0); setNewRef(""); setNewLot(""); setNewQty("1"); setNewEmplacement(""); setPackaging(null); setQtyMode("colis"); }}
                  style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: "6px 10px", cursor: "pointer", fontSize: 11, fontWeight: 600, color: C.textSec }}>
                  ✕
                </button>
              </div>
            </div>
          )}

          {/* Scan input */}
          <Section>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#7c3aed", marginBottom: 8 }}>
              {["📦", "🔍", "🏷️", "🔢", "📍"][step]} {stepLabels[step]}
              {step === 0 && <span style={{ color: C.textMuted, fontWeight: 400 }}> — scanner ou Entrée pour créer</span>}
              {step === 3 && packaging && <span style={{ color: C.green, fontWeight: 600 }}> (× {packaging} par colis)</span>}
              {loading && <Spinner />}
            </div>
            {/* Toggle colis / unités libres */}
            {step === 3 && packaging && (
              <div style={{ display: "flex", background: C.white, borderRadius: 8, border: `1px solid ${C.border}`, overflow: "hidden", marginBottom: 8 }}>
                {(["colis", "libre"] as const).map(m => (
                  <button key={m} onClick={() => setQtyMode(m)}
                    style={{ flex: 1, padding: "8px 0", fontSize: 12, fontWeight: 700, cursor: "pointer", border: "none", fontFamily: "inherit",
                      background: qtyMode === m ? "#7c3aed" : "transparent",
                      color: qtyMode === m ? "#fff" : C.textSec }}>
                    {m === "colis" ? `📦 Colis (× ${packaging})` : "🔢 Unités libres"}
                  </button>
                ))}
              </div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <input
                style={{ ...inputStyle, flex: 1, borderColor: "#7c3aed", fontSize: 15 }}
                value={scanInput}
                onChange={e => setScanInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") handleScan(scanInput); }}
                placeholder={
                  step === 0 ? "Pal-XXXX ou Entrée pour créer..." :
                  step === 1 ? "Code-barres produit..." :
                  step === 2 ? "Numéro de lot..." :
                  step === 3 ? (packaging && qtyMode === "colis" ? `Nb colis (× ${packaging})...` : "Quantité...") :
                  "Emplacement (optionnel)..."
                }
                type={step === 3 ? "number" : "text"}
              />
              <button onClick={() => handleScan(scanInput)} disabled={loading}
                style={{ background: "#7c3aed", color: "#fff", border: "none", borderRadius: 10, padding: "10px 18px", fontWeight: 700, fontSize: 16, cursor: "pointer", minWidth: 56 }}>
                →
              </button>
            </div>
            {/* Skip / confirm buttons */}
            {step === 2 && (
              <button onClick={() => { setNewLot(""); updateStep(3); }}
                style={{ marginTop: 8, width: "100%", padding: 10, ...secondaryBtn, fontSize: 13 }}>
                ⏭ Passer (sans lot)
              </button>
            )}
            {step === 3 && scanInput && (
              <button onClick={() => handleScan(scanInput)} disabled={loading}
                style={{ marginTop: 8, width: "100%", padding: 12, background: C.green, border: "none", borderRadius: 10, cursor: "pointer", fontSize: 14, fontWeight: 700, color: "#fff" }}>
                {packaging && qtyMode === "colis" ? `Confirmer ${scanInput} × ${packaging} = ${parseFloat(scanInput || "0") * packaging} →` : `Confirmer ${scanInput} unités →`}
              </button>
            )}
            {step === 4 && (
              <button onClick={validateLine} disabled={loading}
                style={{ marginTop: 8, width: "100%", padding: 12, background: C.green, border: "none", borderRadius: 10, cursor: "pointer", fontSize: 14, fontWeight: 700, color: "#fff" }}>
                {loading ? "..." : `✓ Valider la ligne${newEmplacement ? "" : " (sans emplacement)"}`}
              </button>
            )}
          </Section>

          {/* Summary of current entry */}
          {step > 1 && (
            <div style={{ ...cardStyle, padding: "10px 14px", marginBottom: 12, fontSize: 13 }}>
              {newRef && <div><strong>Réf:</strong> {newRef} {newName && <span style={{ color: C.textMuted }}>— {newName}</span>}</div>}
              {newLot && <div><strong>Lot:</strong> {newLot}</div>}
              {step >= 4 && <div><strong>Qté:</strong> {newQty} unités{packaging ? ` (${Math.round(parseFloat(newQty) / packaging)} colis × ${packaging})` : ""}</div>}
              {newEmplacement && <div><strong>Emplacement:</strong> {newEmplacement}</div>}
            </div>
          )}

          {/* Emplacement palette */}
          {currentPalette && (
            <div style={{ ...cardStyle, padding: "10px 14px", marginBottom: 12, borderColor: "#ddd6fe" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, marginBottom: 4, textTransform: "uppercase" as const }}>Emplacement</div>
              {editEmpl ? (
                <div style={{ display: "flex", gap: 8 }}>
                  <input style={{ ...inputStyle, flex: 1, fontSize: 14 }} value={editEmplValue} onChange={e => setEditEmplValue(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter" && editEmplValue.trim()) { palUpdate(currentPalette.id, { emplacement: editEmplValue.trim() }).then(() => palDetail(currentPalette.id)).then(({ palette: p }) => { setCurPalette(p); setEditEmpl(false); showSuccess("✓ Emplacement mis à jour"); }); } }}
                    placeholder="Scanner ou taper..." />
                  <button onClick={async () => { if (editEmplValue.trim()) { await palUpdate(currentPalette.id, { emplacement: editEmplValue.trim() }); const { palette: p } = await palDetail(currentPalette.id); setCurPalette(p); showSuccess("✓"); } setEditEmpl(false); }}
                    style={{ background: C.green, color: "#fff", border: "none", borderRadius: 8, padding: "8px 14px", fontWeight: 700, cursor: "pointer" }}>✓</button>
                  <button onClick={() => setEditEmpl(false)} style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", cursor: "pointer" }}>✕</button>
                </div>
              ) : (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: currentPalette.emplacement ? C.blue : C.textMuted }}>
                    📍 {currentPalette.emplacement || "Non défini"}
                  </span>
                  <button onClick={() => { setEditEmplValue(currentPalette.emplacement || ""); setEditEmpl(true); }}
                    style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, color: C.textMuted }}>✏️</button>
                </div>
              )}
            </div>
          )}

          {/* Lignes déjà ajoutées */}
          {lignes.length > 0 && (
            <Section>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const }}>
                  Contenu ({lignes.length} réf · {lignes.reduce((s, l) => s + l.qty, 0)} unités)
                </div>
                <button onClick={() => currentPalette && printPalette(currentPalette, lignes)}
                  style={{ background: "#f5f3ff", border: "1px solid #ddd6fe", borderRadius: 8, padding: "5px 12px", cursor: "pointer", fontSize: 12, fontWeight: 700, color: "#7c3aed" }}>
                  🖨️ Imprimer
                </button>
              </div>
              {lignes.map(l => (
                <div key={l.id} style={{ padding: "8px 0", borderBottom: `1px solid ${C.border}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: C.blue, fontFamily: "monospace" }}>{l.odoo_ref}</div>
                      <div style={{ fontSize: 12, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{l.product_name}</div>
                      {l.lot && <div style={{ fontSize: 11, color: C.textMuted }}>🏷️ {l.lot}</div>}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                      {editingLigne === l.id ? (
                        <>
                          <input style={{ width: 60, padding: "4px 6px", border: `1.5px solid ${C.blue}`, borderRadius: 6, fontSize: 14, fontWeight: 700, textAlign: "center" as const, fontFamily: "inherit" }}
                            value={editQty} onChange={e => setEditQty(e.target.value)} type="number" inputMode="numeric"
                            onKeyDown={e => { if (e.key === "Enter") { const nq = parseFloat(editQty); if (nq > 0) { palUpdateQty(l.id, nq).then(() => palDetail(currentPalette!.id)).then(({ lignes: ls }) => { setLignes(ls); setEditingLigne(null); }); } } }} />
                          <button onClick={async () => { const nq = parseFloat(editQty); if (nq > 0) { await palUpdateQty(l.id, nq); const { lignes: ls } = await palDetail(currentPalette!.id); setLignes(ls); } setEditingLigne(null); }}
                            style={{ width: 28, height: 28, borderRadius: 6, border: "none", background: C.greenSoft, color: C.green, cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>✓</button>
                        </>
                      ) : sortingLigne === l.id ? (
                        <>
                          <input style={{ width: 60, padding: "4px 6px", border: `1.5px solid ${C.orange}`, borderRadius: 6, fontSize: 14, fontWeight: 700, textAlign: "center" as const, fontFamily: "inherit" }}
                            value={sortQty} onChange={e => setSortQty(e.target.value)} type="number" inputMode="numeric"
                            placeholder={l.packaging_qty ? `× ${l.packaging_qty}` : "qty"}
                            onKeyDown={e => { if (e.key === "Enter") { const n = parseFloat(sortQty); const total = l.packaging_qty && l.packaging_qty > 1 ? n * l.packaging_qty : n; if (total > 0) sortirVersPicking(l.id, total); } }} />
                          <button onClick={() => { const n = parseFloat(sortQty); const total = l.packaging_qty && l.packaging_qty > 1 ? n * l.packaging_qty : n; if (total > 0) sortirVersPicking(l.id, total); }}
                            style={{ width: 28, height: 28, borderRadius: 6, border: "none", background: C.orangeSoft, color: C.orange, cursor: "pointer", fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>→</button>
                          <button onClick={() => { setSortingLigne(null); setSortQty(""); }}
                            style={{ width: 28, height: 28, borderRadius: 6, border: "none", background: C.bg, color: C.textMuted, cursor: "pointer", fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => { setSortingLigne(l.id); setSortQty(""); setEditingLigne(null); }}
                            style={{ padding: "3px 8px", borderRadius: 6, border: "none", background: C.orangeSoft, color: C.orange, cursor: "pointer", fontSize: 10, fontWeight: 700 }}>📤</button>
                          <button onClick={() => { setEditingLigne(l.id); setEditQty(String(l.qty)); setSortingLigne(null); }}
                            style={{ fontSize: 16, fontWeight: 800, color: C.text, background: "none", border: "none", cursor: "pointer", padding: "2px 4px" }}>{l.qty}</button>
                          <button onClick={async () => { await palUpdateQty(l.id, 0); const { lignes: ls } = await palDetail(currentPalette!.id); setLignes(ls); }}
                            style={{ width: 24, height: 24, borderRadius: 6, border: "none", background: C.redSoft, color: C.red, cursor: "pointer", fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>
                        </>
                      )}
                    </div>
                  </div>
                  {sortingLigne === l.id && l.packaging_qty && l.packaging_qty > 1 && sortQty && (
                    <div style={{ fontSize: 11, color: C.orange, fontWeight: 600, marginTop: 4, textAlign: "right" as const }}>
                      {sortQty} colis × {l.packaging_qty} = {parseFloat(sortQty || "0") * l.packaging_qty} unités à sortir
                    </div>
                  )}
                </div>
              ))}
            </Section>
          )}
        </div>
      )}

      {/* ── STOCK PICKING VIEW ── */}
      {view === "stock" && (
        <div>
          <Section>
            <SectionHeader icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2.5"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/></svg>} title="Stock picking théorique" sub="Odoo total − Palettes WMS = Picking" />
            <button onClick={loadStockPicking} disabled={stockLoading}
              style={{ width: "100%", padding: 12, background: "#7c3aed", color: "#fff", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: stockLoading ? "wait" : "pointer", marginBottom: 14 }}>
              {stockLoading ? "Calcul en cours..." : "🔄 Calculer le stock picking"}
            </button>
            <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 12 }}>
              Stock Odoo (emplacements internes) − Stock palettes WMS (actives) = Ce qui reste en picking
            </div>
          </Section>

          {stockData.length > 0 && (
            <Section>
              {/* Header */}
              <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: `2px solid ${C.border}`, fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const }}>
                <div style={{ flex: 1 }}>Réf</div>
                <div style={{ width: 55, textAlign: "right" as const }}>Odoo</div>
                <div style={{ width: 55, textAlign: "right" as const }}>Palettes</div>
                <div style={{ width: 55, textAlign: "right" as const, color: C.orange }}>Picking</div>
              </div>
              {stockData.map((s, i) => (
                <div key={s.ref} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: i < stockData.length - 1 ? `1px solid ${C.border}` : "" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: C.blue, fontFamily: "monospace" }}>{s.ref}</div>
                    <div style={{ fontSize: 11, color: C.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{s.name}</div>
                  </div>
                  <div style={{ width: 55, textAlign: "right" as const, fontSize: 13, fontWeight: 600, color: C.textSec }}>{s.odoo}</div>
                  <div style={{ width: 55, textAlign: "right" as const, fontSize: 13, fontWeight: 600, color: "#7c3aed" }}>{s.supabase}</div>
                  <div style={{ width: 55, textAlign: "right" as const, fontSize: 14, fontWeight: 800, color: s.picking > 0 ? C.orange : C.green }}>{s.picking}</div>
                </div>
              ))}
              <div style={{ marginTop: 12, padding: "10px 14px", background: C.orangeSoft, border: `1px solid ${C.orangeBorder}`, borderRadius: 10, fontSize: 12, color: C.orange, fontWeight: 600 }}>
                Total picking estimé : {stockData.reduce((s, d) => s + d.picking, 0)} unités sur {stockData.filter(d => d.picking > 0).length} réf
              </div>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}


function Login({ onLogin, loading, error }: { onLogin: (u: string, d: string, l: string, p: string) => void; loading: boolean; error: string }) {
  const cfg = typeof window !== "undefined" ? loadCfg() : null;
  const [url, setUrl] = useState(cfg?.u || ""); const [db, setDb] = useState(cfg?.d || "");
