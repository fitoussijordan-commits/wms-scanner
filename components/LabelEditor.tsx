"use client";
import { useState, useRef, useEffect, useCallback } from "react";

// ─────────────────────────────────────────────────────────────────
// Types (INCHANGÉS — l'impression generateLabelPDF en dépend)
// ─────────────────────────────────────────────────────────────────
export type ElementType = "text" | "barcode" | "qrcode" | "line" | "image" | "rect";

export interface LabelElement {
  id: string;
  type: ElementType;
  x: number; y: number;       // mm depuis le coin haut-gauche
  w: number; h: number;       // mm
  // text
  text?: string;
  fontSize?: number;          // pt
  bold?: boolean;
  align?: "left" | "center" | "right";
  // barcode/qr
  value?: string;
  // line / rect
  thickness?: number;
  filled?: boolean;           // rectangle plein ou contour
  // image
  dataUrl?: string;
}

export interface LabelTemplate {
  widthMM: number;
  heightMM: number;
  elements: LabelElement[];
}

interface Props {
  template: LabelTemplate;
  onChange: (t: LabelTemplate) => void;
  onPrint: (pdfBase64: string) => void;
  printing?: boolean;
}

// ─────────────────────────────────────────────────────────────────
const PX_PER_MM = 3.78;
const C = {
  blue: "#2563eb", blueSoft: "#eff6ff", border: "#e2e8f0", bg: "#f8fafc",
  text: "#1e293b", textMuted: "#94a3b8", white: "#fff",
  red: "#ef4444", green: "#16a34a",
};

function uid() { return Math.random().toString(36).slice(2, 8); }

// ─────────────────────────────────────────────────────────────────
// Barcode Code128B → canvas (INCHANGÉ)
// ─────────────────────────────────────────────────────────────────
function renderBarcode128(canvas: HTMLCanvasElement, value: string) {
  const encode: Record<string, number> = {};
  for (let i = 32; i <= 126; i++) encode[String.fromCharCode(i)] = i - 32;
  const START_B = 104, STOP = 106;
  const bars = [
    "11011001100","11001101100","11001100110","10010011000","10010001100",
    "10001001100","10011001000","10011000100","10001100100","11001001000",
    "11001000100","11000100100","10110011100","10011011100","10011001110",
    "10111001100","10011101100","10011100110","11001110010","11001011100",
    "11001001110","11011100100","11001110100","11101101110","11101001100",
    "11100101100","11100100110","11101100100","11100110100","11100110010",
    "11011011000","11011000110","11000110110","10100011000","10001011000",
    "10001000110","10110001000","10001101000","10001100010","11010001000",
    "11000101000","11000100010","10110111000","10110001110","10001101110",
    "10111011000","10111000110","10001110110","11101110110","11010001110",
    "11000101110","11011101000","11011100010","11011101110","11101011000",
    "11101000110","11100010110","11101101000","11101100010","11100011010",
    "11101111010","11001000010","11110001010","10100110000","10100001100",
    "10010110000","10010000110","10000101100","10000100110","10110010000",
    "10110000100","10011010000","10011000010","10000110100","10000110010",
    "11000010010","11001010000","11110111010","11000010100","10001111010",
    "10100111100","10010111100","10010011110","10111100100","10011110100",
    "10011110010","11110100100","11110010100","11110010010","11011011110",
    "11011110110","11110110110","10101111000","10100011110","10001011110",
    "10111101000","10111100010","11110101000","11110100010","10111011110",
    "10111101110","11101011110","11110101110","11010000100","11010010000",
    "11010011100","1100011101011",
  ];
  const ctx = canvas.getContext("2d")!;
  const w = canvas.width, h = canvas.height;
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
  const codes: number[] = [START_B];
  let check = START_B;
  for (let i = 0; i < value.length; i++) {
    const c = encode[value[i]] ?? 0;
    codes.push(c);
    check += c * (i + 1);
  }
  codes.push(check % 103);
  codes.push(STOP);
  const pattern = codes.map(c => bars[c] || "").join("");
  const barW = w / pattern.length;
  ctx.fillStyle = "#000";
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "1") ctx.fillRect(Math.floor(i * barW), 0, Math.ceil(barW), h);
  }
}

// QR réel via la lib qrcode (import dynamique → pas alourdir le bundle initial).
async function makeQrDataUrl(value: string, sizePx: number): Promise<string | null> {
  try {
    const QR = (await import("qrcode")).default;
    return await QR.toDataURL(value || " ", { margin: 0, width: Math.max(40, Math.round(sizePx)) });
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────
// Aperçu d'un élément (rendu à l'échelle du canvas)
// ─────────────────────────────────────────────────────────────────
function ElementPreview({ el, scale }: { el: LabelElement; scale: number }) {
  const barcodeRef = useRef<HTMLCanvasElement>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const w = el.w * scale * PX_PER_MM;
  const h = el.h * scale * PX_PER_MM;

  useEffect(() => {
    if (el.type === "barcode" && barcodeRef.current && el.value) {
      renderBarcode128(barcodeRef.current, el.value);
    }
  }, [el.type, el.value, w, h]);

  useEffect(() => {
    let alive = true;
    if (el.type === "qrcode") {
      makeQrDataUrl(el.value || " ", Math.max(60, Math.min(w, h) * 2)).then(u => { if (alive) setQrUrl(u); });
    }
    return () => { alive = false; };
  }, [el.type, el.value, w, h]);

  if (el.type === "text") return (
    <div style={{
      width: w, height: h, overflow: "hidden",
      // fontSize est en POINTS (comme le PDF). À l'écran on convertit pt→px
      // (1pt = 1.3333px) puis on applique l'échelle du canvas, pour que l'aperçu
      // corresponde à la taille réellement imprimée. Pas de facteur arbitraire.
      fontSize: (el.fontSize || 12) * 1.3333 * scale,
      fontWeight: el.bold ? 700 : 400,
      textAlign: el.align || "left",
      lineHeight: 1, color: "#000",
      display: "flex", alignItems: "center",
      justifyContent: el.align === "center" ? "center" : el.align === "right" ? "flex-end" : "flex-start",
      padding: 0, boxSizing: "border-box",
      whiteSpace: "nowrap",
    }}>{el.text || "Texte"}</div>
  );

  if (el.type === "barcode") return <canvas ref={barcodeRef} width={Math.max(1, w)} height={Math.max(1, h)} style={{ display: "block", width: w, height: h }} />;

  if (el.type === "qrcode") return qrUrl
    ? <img src={qrUrl} style={{ width: w, height: h }} alt="" />
    : <div style={{ width: w, height: h, background: "#000" }} />;

  if (el.type === "line") return (
    <div style={{ width: w, height: "100%", display: "flex", alignItems: "center" }}>
      <div style={{ width: "100%", height: Math.max(1, (el.thickness || 0.5) * scale * PX_PER_MM), background: "#000" }} />
    </div>
  );

  if (el.type === "rect") return (
    <div style={{ width: w, height: h, boxSizing: "border-box", background: el.filled ? "#000" : "transparent", border: el.filled ? "none" : `${Math.max(1, (el.thickness || 0.5) * scale * PX_PER_MM)}px solid #000` }} />
  );

  if (el.type === "image" && el.dataUrl) return <img src={el.dataUrl} style={{ width: w, height: h, objectFit: "contain" }} alt="" />;

  return <div style={{ width: w, height: h, background: "#f0f0f0", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#999" }}>image</div>;
}

// ─────────────────────────────────────────────────────────────────
// Éditeur principal — tactile, drag & resize au doigt
// ─────────────────────────────────────────────────────────────────
export default function LabelEditor({ template, onChange, onPrint, printing }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Geste en cours (drag ou resize), suivi via pointer events (souris + tactile).
  const gesture = useRef<
    | { kind: "drag"; id: string; startX: number; startY: number; elX: number; elY: number }
    | { kind: "resize"; id: string; startX: number; startY: number; elW: number; elH: number }
    | null
  >(null);

  // Canvas large : occupe la largeur dispo (jusqu'à 560px), ratio de l'étiquette.
  const MAX_W = 560;
  const scale = Math.min(1.8, MAX_W / (template.widthMM * PX_PER_MM));
  const canvasW = template.widthMM * PX_PER_MM * scale;
  const canvasH = template.heightMM * PX_PER_MM * scale;

  const updateEl = useCallback((id: string, patch: Partial<LabelElement>) => {
    onChange({ ...template, elements: template.elements.map(e => e.id === id ? { ...e, ...patch } : e) });
  }, [template, onChange]);

  const deleteEl = useCallback((id: string) => {
    onChange({ ...template, elements: template.elements.filter(e => e.id !== id) });
    setSelected(null);
  }, [template, onChange]);

  const duplicateEl = useCallback((id: string) => {
    const el = template.elements.find(e => e.id === id);
    if (!el) return;
    const copy = { ...el, id: uid(), x: Math.min(template.widthMM - el.w, el.x + 3), y: Math.min(template.heightMM - el.h, el.y + 3) };
    onChange({ ...template, elements: [...template.elements, copy] });
    setSelected(copy.id);
  }, [template, onChange]);

  const addElement = (type: ElementType) => {
    const cx = template.widthMM / 2, cy = template.heightMM / 2;
    const defaults: Record<ElementType, Partial<LabelElement>> = {
      text:    { w: Math.min(50, template.widthMM - 10), h: 8, text: "Texte", fontSize: 14, align: "left", bold: false },
      barcode: { w: Math.min(55, template.widthMM - 10), h: 14, value: "123456789" },
      qrcode:  { w: 20, h: 20, value: "https://wala.fr" },
      line:    { w: template.widthMM - 12, h: 1, thickness: 0.5 },
      rect:    { w: Math.min(40, template.widthMM - 10), h: 20, thickness: 0.5, filled: false },
      image:   { w: 25, h: 25 },
    };
    const d = defaults[type];
    const el: LabelElement = {
      id: uid(), type,
      x: Math.max(2, Math.round(cx - (d.w || 20) / 2)),
      y: Math.max(2, Math.round(cy - (d.h || 10) / 2)),
      ...d,
    } as LabelElement;
    onChange({ ...template, elements: [...template.elements, el] });
    setSelected(el.id);
  };

  // Position pointeur → mm (dans le repère de l'étiquette).
  const pointerMM = (clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      x: (clientX - rect.left) / scale / PX_PER_MM,
      y: (clientY - rect.top) / scale / PX_PER_MM,
    };
  };

  const onPointerDownEl = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    setSelected(id);
    const el = template.elements.find(x => x.id === id)!;
    const p = pointerMM(e.clientX, e.clientY);
    gesture.current = { kind: "drag", id, startX: p.x, startY: p.y, elX: el.x, elY: el.y };
  };

  const onPointerDownResize = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const el = template.elements.find(x => x.id === id)!;
    const p = pointerMM(e.clientX, e.clientY);
    gesture.current = { kind: "resize", id, startX: p.x, startY: p.y, elW: el.w, elH: el.h };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    const p = pointerMM(e.clientX, e.clientY);
    if (g.kind === "drag") {
      const el = template.elements.find(x => x.id === g.id);
      if (!el) return;
      const nx = g.elX + (p.x - g.startX);
      const ny = g.elY + (p.y - g.startY);
      updateEl(g.id, {
        x: Math.max(0, Math.min(template.widthMM - el.w, Math.round(nx * 2) / 2)),
        y: Math.max(0, Math.min(template.heightMM - el.h, Math.round(ny * 2) / 2)),
      });
    } else {
      updateEl(g.id, {
        w: Math.max(3, Math.min(template.widthMM, Math.round((g.elW + (p.x - g.startX)) * 2) / 2)),
        h: Math.max(2, Math.min(template.heightMM, Math.round((g.elH + (p.y - g.startY)) * 2) / 2)),
      });
    }
  };

  const endGesture = () => { gesture.current = null; };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const dataUrl = ev.target?.result as string;
      const el: LabelElement = { id: uid(), type: "image", x: 4, y: 4, w: 25, h: 25, dataUrl };
      onChange({ ...template, elements: [...template.elements, el] });
      setSelected(el.id);
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const selEl = template.elements.find(e => e.id === selected);

  const tools: { type: ElementType; label: string; onClick?: () => void }[] = [
    { type: "text", label: "T  Texte" },
    { type: "barcode", label: "▐▌ Code-barres" },
    { type: "qrcode", label: "⊞ QR" },
    { type: "line", label: "— Ligne" },
    { type: "rect", label: "▭ Forme" },
  ];

  // Bouton d'ajout : grand, tactile.
  const toolBtn = (label: string, onClick: () => void, key: string) => (
    <button key={key} onClick={onClick}
      style={{ flex: "1 1 auto", minWidth: 92, padding: "12px 10px", background: C.white, border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: "pointer", color: C.text, fontFamily: "inherit" }}>
      {label}
    </button>
  );

  return (
    <div>
      {/* Barre d'outils — ajout d'éléments */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        {tools.map(t => toolBtn(t.label, () => addElement(t.type), t.type))}
        {toolBtn("🖼 Image", () => fileRef.current?.click(), "image")}
        <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleImageUpload} />
      </div>

      {/* Canevas — grand, centré, avec grille légère */}
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
        <div
          ref={canvasRef}
          onPointerMove={onPointerMove}
          onPointerUp={endGesture}
          onPointerCancel={endGesture}
          onPointerDown={() => setSelected(null)}
          style={{
            position: "relative", width: canvasW, height: canvasH,
            background: "#fff", border: "1.5px solid #cbd5e1",
            boxShadow: "0 4px 16px rgba(15,23,42,0.12)",
            touchAction: "none", flexShrink: 0, overflow: "hidden",
            backgroundImage: "radial-gradient(#e2e8f0 0.6px, transparent 0.6px)",
            backgroundSize: `${5 * PX_PER_MM * scale}px ${5 * PX_PER_MM * scale}px`,
          }}
        >
          {template.elements.map(el => {
            const isSel = el.id === selected;
            return (
              <div key={el.id}
                onPointerDown={e => onPointerDownEl(e, el.id)}
                style={{
                  position: "absolute",
                  left: el.x * PX_PER_MM * scale,
                  top: el.y * PX_PER_MM * scale,
                  width: el.w * PX_PER_MM * scale,
                  height: el.h * PX_PER_MM * scale,
                  outline: isSel ? `2px solid ${C.blue}` : "1px dashed rgba(148,163,184,0.5)",
                  outlineOffset: 0,
                  cursor: "move", touchAction: "none",
                  userSelect: "none", boxSizing: "border-box",
                }}>
                <ElementPreview el={el} scale={scale} />
                {isSel && (
                  <>
                    {/* Poignée de redimensionnement — large pour le doigt */}
                    <div onPointerDown={e => onPointerDownResize(e, el.id)}
                      style={{ position: "absolute", right: -13, bottom: -13, width: 26, height: 26, background: C.blue, border: "2px solid #fff", borderRadius: "50%", cursor: "nwse-resize", touchAction: "none", boxShadow: "0 1px 4px rgba(0,0,0,0.3)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5"><path d="M8 3H5a2 2 0 00-2 2v3M21 8V5a2 2 0 00-2-2h-3M16 21h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/></svg>
                    </div>
                    {/* Suppression rapide */}
                    <div onPointerDown={e => { e.stopPropagation(); deleteEl(el.id); }}
                      style={{ position: "absolute", left: -13, top: -13, width: 26, height: 26, background: C.red, border: "2px solid #fff", borderRadius: "50%", cursor: "pointer", touchAction: "none", boxShadow: "0 1px 4px rgba(0,0,0,0.3)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 16, lineHeight: 1 }}>×</div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ fontSize: 11, color: C.textMuted, textAlign: "center", marginBottom: 14 }}>
        {template.widthMM} × {template.heightMM} mm · glisse les éléments au doigt
      </div>

      {/* Panneau de propriétés de l'élément sélectionné.
          (Pas de bouton Imprimer ici : l'écran Étiquettes fournit déjà son bouton
          d'impression global, qui gère l'imprimante et la quantité.) */}
      {selEl ? (
        <ElementProps el={selEl}
          onChange={el => onChange({ ...template, elements: template.elements.map(e => e.id === el.id ? el : e) })}
          onDelete={() => deleteEl(selEl.id)}
          onDuplicate={() => duplicateEl(selEl.id)} />
      ) : (
        <div style={{ fontSize: 13, color: C.textMuted, padding: 18, textAlign: "center", background: C.bg, borderRadius: 12, border: `1px dashed ${C.border}` }}>
          Ajoute un élément ci-dessus, puis touche-le pour l'éditer.
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Panneau propriétés — gros contrôles, lisibles au doigt
// ─────────────────────────────────────────────────────────────────
function ElementProps({ el, onChange, onDelete, onDuplicate }: {
  el: LabelElement; onChange: (e: LabelElement) => void; onDelete: () => void; onDuplicate: () => void;
}) {
  const field = (label: string, node: React.ReactNode) => (
    <div>
      <div style={{ fontSize: 10.5, color: C.textMuted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>{label}</div>
      {node}
    </div>
  );
  const inputStyle: React.CSSProperties = { width: "100%", padding: "10px 12px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 14, fontFamily: "inherit", boxSizing: "border-box" };

  const NumBox = ({ label, value, onCh, step = 1 }: { label: string; value: number; onCh: (v: number) => void; step?: number }) => {
    const [local, setLocal] = useState(String(value));
    useEffect(() => { setLocal(String(value)); }, [value]);
    return field(label,
      <input type="number" step={step} inputMode="decimal" value={local}
        onChange={e => setLocal(e.target.value)}
        onBlur={() => { const n = Number(local.replace(",", ".")); if (!isNaN(n)) onCh(n); }}
        style={inputStyle} />
    );
  };

  return (
    <div style={{ background: C.white, borderRadius: 12, border: `1px solid ${C.border}`, padding: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: C.text, flex: 1, textTransform: "capitalize" }}>
          {({ text: "Texte", barcode: "Code-barres", qrcode: "QR code", line: "Ligne", rect: "Forme", image: "Image" } as Record<string, string>)[el.type] || el.type}
        </div>
        <button onClick={onDuplicate} style={{ padding: "7px 12px", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: "pointer", color: C.text, fontFamily: "inherit" }}>Dupliquer</button>
        <button onClick={onDelete} style={{ padding: "7px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: "pointer", color: C.red, fontFamily: "inherit" }}>Supprimer</button>
      </div>

      {/* Contenu selon le type */}
      {el.type === "text" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 12 }}>
          {field("Texte", <input value={el.text || ""} onChange={e => onChange({ ...el, text: e.target.value })} style={inputStyle} placeholder="Votre texte…" />)}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <NumBox label="Taille (pt)" value={el.fontSize || 14} onCh={v => onChange({ ...el, fontSize: Math.max(6, Math.min(288, v)) })} />
            {field("Alignement",
              <div style={{ display: "flex", gap: 4 }}>
                {(["left", "center", "right"] as const).map(a => (
                  <button key={a} onClick={() => onChange({ ...el, align: a })}
                    style={{ flex: 1, padding: "9px 0", border: `1.5px solid ${el.align === a || (!el.align && a === "left") ? C.blue : C.border}`, background: el.align === a || (!el.align && a === "left") ? C.blueSoft : C.white, borderRadius: 8, cursor: "pointer", fontSize: 15, color: C.text }}>
                    {a === "left" ? "⯇" : a === "center" ? "≡" : "⯈"}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button onClick={() => onChange({ ...el, bold: !el.bold })}
            style={{ padding: "10px 0", border: `1.5px solid ${el.bold ? C.blue : C.border}`, background: el.bold ? C.blueSoft : C.white, borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 800, color: C.text, fontFamily: "inherit" }}>
            {el.bold ? "✓ Gras" : "Gras"}
          </button>
        </div>
      )}

      {(el.type === "barcode" || el.type === "qrcode") && (
        <div style={{ marginBottom: 12 }}>
          {field(el.type === "barcode" ? "Valeur du code-barres" : "Contenu du QR", <input value={el.value || ""} onChange={e => onChange({ ...el, value: e.target.value })} style={inputStyle} placeholder={el.type === "barcode" ? "123456789" : "Texte ou lien" } />)}
        </div>
      )}

      {el.type === "line" && (
        <div style={{ marginBottom: 12 }}>
          <NumBox label="Épaisseur (mm)" value={el.thickness || 0.5} onCh={v => onChange({ ...el, thickness: Math.max(0.1, v) })} step={0.1} />
        </div>
      )}

      {el.type === "rect" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 12 }}>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => onChange({ ...el, filled: false })}
              style={{ flex: 1, padding: "10px 0", border: `1.5px solid ${!el.filled ? C.blue : C.border}`, background: !el.filled ? C.blueSoft : C.white, borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 700, color: C.text, fontFamily: "inherit" }}>Contour</button>
            <button onClick={() => onChange({ ...el, filled: true })}
              style={{ flex: 1, padding: "10px 0", border: `1.5px solid ${el.filled ? C.blue : C.border}`, background: el.filled ? C.blueSoft : C.white, borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 700, color: C.text, fontFamily: "inherit" }}>Plein</button>
          </div>
          {!el.filled && <NumBox label="Épaisseur (mm)" value={el.thickness || 0.5} onCh={v => onChange({ ...el, thickness: Math.max(0.1, v) })} step={0.1} />}
        </div>
      )}

      {/* Position & taille — commun à tous */}
      <div style={{ fontSize: 10.5, color: C.textMuted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6 }}>Position &amp; taille (mm)</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
        <NumBox label="X" value={Math.round(el.x * 10) / 10} onCh={v => onChange({ ...el, x: Math.max(0, v) })} step={0.5} />
        <NumBox label="Y" value={Math.round(el.y * 10) / 10} onCh={v => onChange({ ...el, y: Math.max(0, v) })} step={0.5} />
        <NumBox label="Larg." value={Math.round(el.w * 10) / 10} onCh={v => onChange({ ...el, w: Math.max(3, v) })} step={0.5} />
        <NumBox label="Haut." value={Math.round(el.h * 10) / 10} onCh={v => onChange({ ...el, h: Math.max(2, v) })} step={0.5} />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Génération PDF via jsPDF (barcode inchangé ; QR réel ; rect ajouté)
// ─────────────────────────────────────────────────────────────────
export async function generateLabelPDF(template: LabelTemplate): Promise<string> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({
    orientation: template.widthMM > template.heightMM ? "landscape" : "portrait",
    unit: "mm",
    format: [template.widthMM, template.heightMM],
  });

  for (const el of template.elements) {
    if (el.type === "text") {
      const fs = el.fontSize || 12;
      doc.setFontSize(fs);
      doc.setFont("helvetica", el.bold ? "bold" : "normal");
      const x = el.align === "center" ? el.x + el.w / 2 : el.align === "right" ? el.x + el.w : el.x;
      const align = (el.align === "center" ? "center" : el.align === "right" ? "right" : "left") as any;
      // Centrage vertical dans la boîte, comme à l'écran (alignItems:center).
      // 1 pt = 0.3528 mm ; on place la baseline au milieu + ~un tiers de la hauteur
      // de casse pour centrer optiquement.
      const fsMM = fs * 0.3528;
      const baselineY = el.y + el.h / 2 + fsMM * 0.35;
      doc.text(el.text || "", x, baselineY, { align, maxWidth: el.w, baseline: "alphabetic" });
    }

    if (el.type === "line") {
      doc.setLineWidth(el.thickness || 0.5);
      doc.line(el.x, el.y + el.h / 2, el.x + el.w, el.y + el.h / 2);
    }

    if (el.type === "rect") {
      if (el.filled) {
        doc.setFillColor(0, 0, 0);
        doc.rect(el.x, el.y, el.w, el.h, "F");
      } else {
        doc.setLineWidth(el.thickness || 0.5);
        doc.rect(el.x, el.y, el.w, el.h, "S");
      }
    }

    if (el.type === "image" && el.dataUrl) {
      try {
        const fmt = el.dataUrl.includes("png") ? "PNG" : "JPEG";
        doc.addImage(el.dataUrl, fmt, el.x, el.y, el.w, el.h);
      } catch {}
    }

    if (el.type === "barcode" && el.value) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(el.w * 8);
      canvas.height = Math.round(el.h * 8);
      renderBarcode128(canvas, el.value);
      doc.addImage(canvas.toDataURL("image/png"), "PNG", el.x, el.y, el.w, el.h);
    }

    if (el.type === "qrcode" && el.value) {
      const url = await makeQrDataUrl(el.value, Math.round(Math.min(el.w, el.h) * 12));
      if (url) {
        doc.addImage(url, "PNG", el.x, el.y, el.w, el.h);
      } else {
        // Fallback si la lib QR est indispo : carré noir (mieux que rien).
        doc.setFillColor(0, 0, 0);
        doc.rect(el.x, el.y, el.w, el.h, "F");
      }
    }
  }

  return doc.output("datauristring").split(",")[1];
}
