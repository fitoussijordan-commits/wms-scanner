"use client";
import { useState, useRef, useEffect, useCallback } from "react";

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────
export type ElementType = "text" | "barcode" | "qrcode" | "line" | "image";

export interface LabelElement {
  id: string;
  type: ElementType;
  x: number; y: number;       // mm from top-left
  w: number; h: number;       // mm
  // text
  text?: string;
  fontSize?: number;          // pt
  bold?: boolean;
  align?: "left" | "center" | "right";
  // barcode/qr
  value?: string;
  // line
  thickness?: number;
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
// Constants
// ─────────────────────────────────────────────────────────────────
const PX_PER_MM = 3.78; // screen px per mm at 96dpi
const SNAP = 2;         // snap to grid mm

const C = {
  blue: "#2563eb", border: "#e2e8f0", bg: "#f8fafc",
  text: "#1e293b", textMuted: "#94a3b8", white: "#fff",
  red: "#ef4444", green: "#16a34a", orange: "#f59e0b",
};

function uid() { return Math.random().toString(36).slice(2, 8); }
function snap(v: number) { return Math.round(v / SNAP) * SNAP; }
function mm2px(mm: number) { return mm * PX_PER_MM; }
function px2mm(px: number) { return px / PX_PER_MM; }

// ─────────────────────────────────────────────────────────────────
// Barcode renderer (CODE128 via canvas)
// ─────────────────────────────────────────────────────────────────
function renderBarcode128(canvas: HTMLCanvasElement, value: string) {
  // Minimal Code128B encoding
  const encode: Record<string, number> = {};
  for (let i = 32; i <= 126; i++) encode[String.fromCharCode(i)] = i - 32;
  const START_B = 104, STOP = 106, CODE_B = 100;
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

// ─────────────────────────────────────────────────────────────────
// QR code (simple via API image)
// ─────────────────────────────────────────────────────────────────
function QRPreview({ value, size }: { value: string; size: number }) {
  // Use a data URI approach — simple checkered placeholder in editor
  return (
    <div style={{ width: size, height: size, background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", flexWrap: "wrap" as const }}>
      {Array.from({ length: 16 }).map((_, i) => (
        <div key={i} style={{ width: size / 4, height: size / 4, background: (i + Math.floor(i / 4)) % 2 === 0 ? "#000" : "#fff" }} />
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Single element renderer (preview)
// ─────────────────────────────────────────────────────────────────
function ElementPreview({ el, scale }: { el: LabelElement; scale: number }) {
  const barcodeRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (el.type === "barcode" && barcodeRef.current && el.value) {
      renderBarcode128(barcodeRef.current, el.value);
    }
  }, [el.type, el.value, el.w, el.h]);

  const w = el.w * scale * PX_PER_MM;
  const h = el.h * scale * PX_PER_MM;

  if (el.type === "text") return (
    <div style={{
      width: w, height: h, overflow: "hidden",
      fontSize: (el.fontSize || 12) * scale * 0.8,
      fontWeight: el.bold ? 700 : 400,
      textAlign: el.align || "left",
      lineHeight: 1.2,
      display: "flex", alignItems: "center",
      padding: "0 2px",
    }}>{el.text || "Texte"}</div>
  );

  if (el.type === "barcode") return (
    <canvas ref={barcodeRef} width={w} height={h} style={{ display: "block" }} />
  );

  if (el.type === "qrcode") return (
    <QRPreview value={el.value || "QR"} size={Math.min(w, h)} />
  );

  if (el.type === "line") return (
    <div style={{ width: w, height: Math.max(1, (el.thickness || 0.5) * scale * PX_PER_MM), background: "#000" }} />
  );

  if (el.type === "image" && el.dataUrl) return (
    <img src={el.dataUrl} style={{ width: w, height: h, objectFit: "contain" }} alt="" />
  );

  return <div style={{ width: w, height: h, background: "#f0f0f0", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#999" }}>img</div>;
}

// ─────────────────────────────────────────────────────────────────
// Properties panel
// ─────────────────────────────────────────────────────────────────
function PropsPanel({ el, onChange, onDelete }: { el: LabelElement; onChange: (e: LabelElement) => void; onDelete: () => void }) {
  const inp = (label: string, val: string | number, onCh: (v: string) => void, type = "text") => (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 10, color: C.textMuted, fontWeight: 700, textTransform: "uppercase" as const, marginBottom: 3 }}>{label}</div>
      <input type={type} value={val} onChange={e => onCh(e.target.value)}
        style={{ width: "100%", padding: "6px 8px", border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit", boxSizing: "border-box" as const }} />
    </div>
  );

  const row2 = (a: React.ReactNode, b: React.ReactNode) => (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>{a}{b}</div>
  );

  const numInp = (label: string, val: number, onCh: (v: number) => void) => (
    <div>
      <div style={{ fontSize: 10, color: C.textMuted, fontWeight: 700, textTransform: "uppercase" as const, marginBottom: 3 }}>{label}</div>
      <input type="number" value={val} onChange={e => onCh(Number(e.target.value))}
        style={{ width: "100%", padding: "6px 8px", border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit", boxSizing: "border-box" as const }} />
    </div>
  );

  return (
    <div style={{ padding: 12, background: C.white, borderRadius: 10, border: `1px solid ${C.border}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.text, textTransform: "capitalize" as const }}>{el.type}</div>
        <button onClick={onDelete} style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 18, lineHeight: 1 }}>🗑</button>
      </div>

      {row2(
        numInp("X (mm)", Math.round(el.x * 10) / 10, v => onChange({ ...el, x: v })),
        numInp("Y (mm)", Math.round(el.y * 10) / 10, v => onChange({ ...el, y: v }))
      )}
      {row2(
        numInp("Larg. (mm)", Math.round(el.w * 10) / 10, v => onChange({ ...el, w: Math.max(2, v) })),
        numInp("Haut. (mm)", Math.round(el.h * 10) / 10, v => onChange({ ...el, h: Math.max(1, v) }))
      )}

      {el.type === "text" && <>
        {inp("Texte", el.text || "", v => onChange({ ...el, text: v }))}
        {row2(
          numInp("Taille (pt)", el.fontSize || 12, v => onChange({ ...el, fontSize: Math.max(6, Math.min(72, v)) })),
          <div>
            <div style={{ fontSize: 10, color: C.textMuted, fontWeight: 700, textTransform: "uppercase" as const, marginBottom: 3 }}>Alignement</div>
            <select value={el.align || "left"} onChange={e => onChange({ ...el, align: e.target.value as any })}
              style={{ width: "100%", padding: "6px 8px", border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit" }}>
              <option value="left">Gauche</option>
              <option value="center">Centre</option>
              <option value="right">Droite</option>
            </select>
          </div>
        )}
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, cursor: "pointer" }}>
          <input type="checkbox" checked={el.bold || false} onChange={e => onChange({ ...el, bold: e.target.checked })} />
          Gras
        </label>
      </>}

      {(el.type === "barcode" || el.type === "qrcode") && inp("Valeur", el.value || "", v => onChange({ ...el, value: v }))}
      {el.type === "line" && numInp("Épaisseur (mm)", el.thickness || 0.5, v => onChange({ ...el, thickness: v }))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Main Editor
// ─────────────────────────────────────────────────────────────────
export default function LabelEditor({ template, onChange, onPrint, printing }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [dragging, setDragging] = useState<{ id: string; ox: number; oy: number } | null>(null);
  const [resizing, setResizing] = useState<{ id: string; ox: number; oy: number; ow: number; oh: number } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Auto-scale : le canvas ne dépasse jamais 300px de large (laisse place au panel propriétés)
  const MAX_CANVAS_PX = 300;
  const naturalW = template.widthMM * PX_PER_MM;
  const scale = Math.min(1, MAX_CANVAS_PX / naturalW);
  const canvasW = naturalW * scale;
  const canvasH = template.heightMM * PX_PER_MM * scale;

  const updateEl = useCallback((id: string, patch: Partial<LabelElement>) => {
    onChange({ ...template, elements: template.elements.map(e => e.id === id ? { ...e, ...patch } : e) });
  }, [template, onChange]);

  const deleteEl = useCallback((id: string) => {
    onChange({ ...template, elements: template.elements.filter(e => e.id !== id) });
    setSelected(null);
  }, [template, onChange]);

  const addElement = (type: ElementType) => {
    const defaults: Record<ElementType, Partial<LabelElement>> = {
      text:    { w: 40, h: 8,  text: "Texte", fontSize: 12, align: "left" },
      barcode: { w: 50, h: 12, value: "123456789" },
      qrcode:  { w: 15, h: 15, value: "https://wala.fr" },
      line:    { w: template.widthMM - 10, h: 1, thickness: 0.5 },
      image:   { w: 20, h: 20 },
    };
    const el: LabelElement = {
      id: uid(), type,
      x: 5, y: 5,
      ...defaults[type],
    } as LabelElement;
    onChange({ ...template, elements: [...template.elements, el] });
    setSelected(el.id);
  };

  // Drag
  const onMouseDown = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    e.preventDefault();
    setSelected(id);
    const el = template.elements.find(el => el.id === id)!;
    setDragging({ id, ox: e.clientX - mm2px(el.x) * scale, oy: e.clientY - mm2px(el.y) * scale });
  };

  const onResizeDown = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const el = template.elements.find(el => el.id === id)!;
    setResizing({ id, ox: e.clientX, oy: e.clientY, ow: el.w, oh: el.h });
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (dragging) {
        const x = snap(px2mm((e.clientX - dragging.ox) / scale));
        const y = snap(px2mm((e.clientY - dragging.oy) / scale));
        updateEl(dragging.id, {
          x: Math.max(0, Math.min(template.widthMM - 2, x)),
          y: Math.max(0, Math.min(template.heightMM - 1, y)),
        });
      }
      if (resizing) {
        const dw = px2mm((e.clientX - resizing.ox) / scale);
        const dh = px2mm((e.clientY - resizing.oy) / scale);
        updateEl(resizing.id, {
          w: Math.max(2, snap(resizing.ow + dw)),
          h: Math.max(1, snap(resizing.oh + dh)),
        });
      }
    };
    const onUp = () => { setDragging(null); setResizing(null); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [dragging, resizing, updateEl, template]);

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const dataUrl = ev.target?.result as string;
      const el: LabelElement = { id: uid(), type: "image", x: 5, y: 5, w: 20, h: 20, dataUrl };
      onChange({ ...template, elements: [...template.elements, el] });
      setSelected(el.id);
    };
    reader.readAsDataURL(file);
  };

  const selEl = template.elements.find(e => e.id === selected);

  return (
    <div>
      {/* Toolbar */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" as const, marginBottom: 10 }}>
        {([
          { type: "text" as ElementType, label: "T Texte" },
          { type: "barcode" as ElementType, label: "▐▌ Barcode" },
          { type: "qrcode" as ElementType, label: "⊞ QR" },
          { type: "line" as ElementType, label: "── Ligne" },
        ] as const).map(({ type, label }) => (
          <button key={type} onClick={() => addElement(type)}
            style={{ padding: "6px 10px", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: "pointer", color: C.text, fontFamily: "inherit" }}>
            {label}
          </button>
        ))}
        <button onClick={() => fileRef.current?.click()}
          style={{ padding: "6px 10px", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: "pointer", color: C.text, fontFamily: "inherit" }}>
          🖼 Image
        </button>
        <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleImageUpload} />
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        {/* Canvas */}
        <div>
          <div
            ref={canvasRef}
            onClick={() => setSelected(null)}
            style={{
              position: "relative",
              width: canvasW, height: canvasH,
              background: "#fff",
              border: "1.5px solid #000",
              boxShadow: "2px 2px 8px rgba(0,0,0,0.15)",
              cursor: "default",
              flexShrink: 0,
              overflow: "hidden",
            }}
          >
            {/* Grid dots */}
            <svg style={{ position: "absolute", inset: 0, pointerEvents: "none" }} width={canvasW} height={canvasH}>
              {Array.from({ length: Math.floor(template.widthMM / SNAP) + 1 }).map((_, xi) =>
                Array.from({ length: Math.floor(template.heightMM / SNAP) + 1 }).map((_, yi) => (
                  <circle key={`${xi}-${yi}`} cx={xi * SNAP * PX_PER_MM} cy={yi * SNAP * PX_PER_MM} r={0.5} fill="#e2e8f0" />
                ))
              )}
            </svg>

            {template.elements.map(el => {
              const isSel = el.id === selected;
              return (
                <div
                  key={el.id}
                  onMouseDown={e => onMouseDown(e, el.id)}
                  onClick={e => e.stopPropagation()}
                  style={{
                    position: "absolute",
                    left: el.x * PX_PER_MM * scale,
                    top: el.y * PX_PER_MM * scale,
                    width: el.w * PX_PER_MM * scale,
                    height: el.h * PX_PER_MM * scale,
                    outline: isSel ? `2px solid ${C.blue}` : "1px dashed transparent",
                    cursor: "move",
                    userSelect: "none" as const,
                    boxSizing: "border-box" as const,
                  }}
                >
                  <ElementPreview el={el} scale={scale} />
                  {isSel && (
                    <div
                      onMouseDown={e => onResizeDown(e, el.id)}
                      style={{
                        position: "absolute", right: -4, bottom: -4,
                        width: 8, height: 8, background: C.blue,
                        borderRadius: 2, cursor: "se-resize",
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
          <div style={{ fontSize: 10, color: C.textMuted, marginTop: 4, textAlign: "center" as const }}>
            {template.widthMM} × {template.heightMM} mm
          </div>
        </div>

        {/* Properties */}
        <div style={{ flex: 1, minWidth: 160 }}>
          {selEl ? (
            <PropsPanel
              el={selEl}
              onChange={el => onChange({ ...template, elements: template.elements.map(e => e.id === el.id ? el : e) })}
              onDelete={() => deleteEl(selEl.id)}
            />
          ) : (
            <div style={{ fontSize: 12, color: C.textMuted, padding: 12, textAlign: "center" as const, background: C.bg, borderRadius: 10, border: `1px dashed ${C.border}` }}>
              Clique sur un élément pour l'éditer
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// PDF generation via jsPDF
// ─────────────────────────────────────────────────────────────────
export async function generateLabelPDF(template: LabelTemplate): Promise<string> {
  // Dynamically import jsPDF
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({
    orientation: template.widthMM > template.heightMM ? "landscape" : "portrait",
    unit: "mm",
    format: [template.widthMM, template.heightMM],
  });

  for (const el of template.elements) {
    if (el.type === "text") {
      doc.setFontSize(el.fontSize || 12);
      doc.setFont("helvetica", el.bold ? "bold" : "normal");
      const x = el.type === "text" && el.align === "center" ? el.x + el.w / 2
        : el.align === "right" ? el.x + el.w : el.x;
      const align = (el.align === "center" ? "center" : el.align === "right" ? "right" : "left") as any;
      doc.text(el.text || "", x, el.y + (el.fontSize || 12) * 0.35, { align, maxWidth: el.w });
    }

    if (el.type === "line") {
      doc.setLineWidth(el.thickness || 0.5);
      doc.line(el.x, el.y, el.x + el.w, el.y);
    }

    if (el.type === "image" && el.dataUrl) {
      try {
        const fmt = el.dataUrl.includes("png") ? "PNG" : "JPEG";
        doc.addImage(el.dataUrl, fmt, el.x, el.y, el.w, el.h);
      } catch {}
    }

    if (el.type === "barcode" && el.value) {
      // Render barcode to canvas, then add as image
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(el.w * 8);
      canvas.height = Math.round(el.h * 8);
      renderBarcode128(canvas, el.value);
      const dataUrl = canvas.toDataURL("image/png");
      doc.addImage(dataUrl, "PNG", el.x, el.y, el.w, el.h);
    }

    if (el.type === "qrcode" && el.value) {
      // Simple QR placeholder — real QR needs qrcode lib
      // For now render a black square with text below
      doc.setFillColor(0, 0, 0);
      doc.rect(el.x, el.y, el.w, el.h, "F");
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(4);
      doc.text("QR", el.x + el.w / 2, el.y + el.h / 2, { align: "center" });
      doc.setTextColor(0, 0, 0);
    }
  }

  return doc.output("datauristring").split(",")[1];
}
