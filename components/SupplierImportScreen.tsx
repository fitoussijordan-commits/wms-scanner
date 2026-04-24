"use client";

import { useState, useCallback } from "react";
import * as odoo from "@/lib/odoo";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PackingLine {
  articleNo: string;
  description: string;
  qty: number;
  price: number;
  lotNo: string;
  expiryDate: string; // YYYY-MM-DD
  invoiceNo: string;
}

interface MatchedLine extends PackingLine {
  productId: number;
  templateId: number;
  name: string;       // nom Odoo du produit
  defaultCode: string;
  uomId: number;
  uomName: string;
}

interface ImportResult {
  poName: string;
  pickingName: string;
  lotsCreated: number;
  lotsDuplicate: string[];
  linesCount: number;
}

type Step = "upload" | "preview" | "importing" | "done";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getCellValue(row: any, keys: string[]): any {
  const rowKeys = Object.keys(row);
  const found = rowKeys.find(k => keys.some(t => k.toLowerCase().replace(/[\s\-_]/g, "").includes(t.toLowerCase().replace(/[\s\-_]/g, ""))));
  return found ? row[found] : null;
}

function parseExcelDate(val: any): string {
  if (!val) return "";
  if (typeof val === "number") {
    const d = new Date((val - 25569) * 86400 * 1000);
    return d.toISOString().split("T")[0];
  }
  const s = String(val).trim();
  // Try DD.MM.YYYY or DD/MM/YYYY
  const m = s.match(/^(\d{2})[./](\d{2})[./](\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  // Try YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return s;
}

async function loadXLSX(): Promise<any> {
  if ((window as any).XLSX) return (window as any).XLSX;
  await new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Impossible de charger xlsx.js"));
    document.head.appendChild(s);
  });
  return (window as any).XLSX;
}

function parsePackingList(data: any[]): PackingLine[] {
  return data
    .map(row => ({
      articleNo: String(getCellValue(row, ["ArticleNo", "Article-No", "ProductCode"]) || "").trim(),
      description: String(getCellValue(row, ["Description", "Designation", "Libelle"]) || "").trim(),
      qty: parseFloat(String(getCellValue(row, ["Quantity", "Qty", "Quantite"]) || "0").replace(",", ".")) || 0,
      price: parseFloat(String(getCellValue(row, ["PriceNet", "Price", "Prix"]) || "0").replace(",", ".")) || 0,
      lotNo: String(getCellValue(row, ["Batch", "Lot", "BatchNo", "LotNo", "NumeroLot"]) || "").trim(),
      expiryDate: parseExcelDate(getCellValue(row, ["ExpiryDate", "Expiry", "BestBefore", "BBD", "MHD", "DateExpiration", "Expiration"])),
      invoiceNo: String(getCellValue(row, ["InvoiceNo", "Invoice", "FactureNo", "Facture"]) || "").trim(),
    }))
    .filter(l => l.articleNo && l.qty > 0);
}

// ─── Progress log ─────────────────────────────────────────────────────────────

function LogLine({ text, status }: { text: string; status: "pending" | "ok" | "warn" | "error" | "running" }) {
  const icons: Record<string, string> = { pending: "⏳", ok: "✅", warn: "⚠️", error: "❌", running: "⏳" };
  const colors: Record<string, string> = { pending: "#9ca3af", ok: "#059669", warn: "#d97706", error: "#dc2626", running: "#6366f1" };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", fontSize: 13, color: colors[status], borderBottom: "1px solid #f3f4f6" }}>
      <span style={{ fontSize: 14, flexShrink: 0 }}>{icons[status]}</span>
      <span style={{ fontFamily: status === "running" ? "inherit" : "inherit", fontWeight: status === "running" ? 600 : 400 }}>{text}</span>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function SupplierImportScreen({
  session,
  onBack,
  onToast,
}: {
  session: odoo.OdooSession;
  onBack: () => void;
  onToast: (msg: string) => void;
}) {
  const [step, setStep] = useState<Step>("upload");
  const [packingLines, setPackingLines] = useState<PackingLine[]>([]);
  const [matchedLines, setMatchedLines] = useState<MatchedLine[]>([]);
  const [missingArticles, setMissingArticles] = useState<{ articleNo: string; description: string }[]>([]);
  const [fileName, setFileName] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState("");

  const [importLogs, setImportLogs] = useState<{ text: string; status: "pending" | "ok" | "warn" | "error" | "running" }[]>([]);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState("");

  const addLog = useCallback((text: string, status: "pending" | "ok" | "warn" | "error" | "running") => {
    setImportLogs(prev => [...prev, { text, status }]);
  }, []);

  const updateLastLog = useCallback((text: string, status: "pending" | "ok" | "warn" | "error" | "running") => {
    setImportLogs(prev => {
      const copy = [...prev];
      copy[copy.length - 1] = { text, status };
      return copy;
    });
  }, []);

  // ── Upload + parse + match ────────────────────────────────────────────────

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAnalyzing(true);
    setAnalyzeError("");
    setFileName(file.name);

    try {
      const XLSX = await loadXLSX();
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const raw = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
      const parsed = parsePackingList(raw);

      if (!parsed.length) throw new Error("Aucune ligne valide trouvée dans la packing list (vérifiez les colonnes Article-No, Quantity, Batch)");

      setPackingLines(parsed);

      // Match products in Odoo
      const articleCodes = Array.from(new Set(parsed.map(l => l.articleNo)));
      const mapping = await odoo.matchWalaArticles(session, articleCodes);

      const matched: MatchedLine[] = [];
      const missing: { articleNo: string; description: string }[] = [];

      for (const pl of parsed) {
        const m = mapping[pl.articleNo];
        if (m) {
          matched.push({ ...pl, ...m });
        } else {
          // Only add once per article
          if (!missing.find(x => x.articleNo === pl.articleNo)) {
            missing.push({ articleNo: pl.articleNo, description: pl.description });
          }
        }
      }

      setMatchedLines(matched);
      setMissingArticles(missing);
      setStep("preview");
    } catch (err: any) {
      setAnalyzeError(err.message || "Erreur lors de l'analyse du fichier");
    } finally {
      setAnalyzing(false);
      // Reset input
      e.target.value = "";
    }
  };

  // ── Import Odoo ──────────────────────────────────────────────────────────

  const runImport = async () => {
    setStep("importing");
    setImportLogs([]);
    setImportError("");

    const lotsDuplicate: string[] = [];
    let lotsCreated = 0;

    try {
      // 1. Fournisseur
      addLog("Recherche du fournisseur WALA Heilmittel GmbH…", "running");
      const partnerId = await odoo.getWalaPartnerId(session);
      updateLastLog(`Fournisseur trouvé (ID ${partnerId})`, "ok");

      // 2. Créer le bon de commande
      addLog("Création du bon de commande fournisseur…", "running");
      const poLines: odoo.WalaPOLine[] = matchedLines.map(l => ({
        productId: l.productId,
        qty: l.qty,
        price: l.price,
        name: `[${l.defaultCode}] ${l.name}`,
        uomId: l.uomId,
      }));
      const invoiceNo = matchedLines[0]?.invoiceNo || "";
      const poResult = await odoo.createAndConfirmPO(session, partnerId, poLines, { partnerRef: invoiceNo });
      updateLastLog(`Bon de commande créé et confirmé : ${poResult.poName}`, "ok");

      // 3. Réception
      addLog(`Réception générée : ${poResult.pickingName}`, "ok");

      // 4. Créer les lots
      addLog(`Création des lots (${matchedLines.length} lignes)…`, "running");
      const receptionLines: odoo.ReceptionLotLine[] = [];

      for (const line of matchedLines) {
        if (!line.lotNo) continue;
        const { id: lotId, existed } = await odoo.getOrCreateLot(session, line.productId, line.lotNo, line.expiryDate);
        if (existed) {
          if (!lotsDuplicate.includes(line.lotNo)) lotsDuplicate.push(line.lotNo);
        } else {
          lotsCreated++;
        }
        receptionLines.push({ productId: line.productId, lotId, lotName: line.lotNo, qty: line.qty, uomId: line.uomId });
      }

      if (lotsDuplicate.length > 0) {
        updateLastLog(`Lots traités — ${lotsCreated} créés, ${lotsDuplicate.length} déjà existants (réutilisés)`, "warn");
      } else {
        updateLastLog(`${lotsCreated} lots créés`, "ok");
      }

      // 5. Affecter lots + qté à la réception
      addLog("Affectation des lots et quantités à la réception…", "running");
      await odoo.setReceptionLots(session, poResult.pickingId, poResult.locationId, poResult.locationDestId, receptionLines);
      updateLastLog("Lots et quantités affectés — réception prête à valider dans Odoo", "ok");

      setImportResult({
        poName: poResult.poName,
        pickingName: poResult.pickingName,
        lotsCreated,
        lotsDuplicate,
        linesCount: matchedLines.length,
      });
      setStep("done");
      onToast(`Import réussi — ${poResult.poName} · ${poResult.pickingName}`);
    } catch (err: any) {
      updateLastLog(`Erreur : ${err.message}`, "error");
      setImportError(err.message || "Erreur inconnue");
    }
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  const S = styles;

  return (
    <div style={S.screen}>
      {/* Header */}
      <div style={S.header}>
        <button onClick={onBack} style={S.backBtn}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div>
          <div style={S.headerTitle}>Import fournisseur WALA</div>
          <div style={S.headerSub}>Packing list → Odoo automatique</div>
        </div>
      </div>

      {/* Steps indicator */}
      <div style={S.stepsBar}>
        {(["upload", "preview", "importing", "done"] as Step[]).map((s, i) => {
          const labels = ["Fichier", "Vérification", "Import", "Terminé"];
          const idx = ["upload", "preview", "importing", "done"].indexOf(step);
          const active = s === step;
          const done = i < idx;
          return (
            <div key={s} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {i > 0 && <div style={{ width: 24, height: 1, background: done || active ? "#6366f1" : "#e5e7eb" }} />}
              <div style={{
                width: 28, height: 28, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 12, fontWeight: 700,
                background: done ? "#059669" : active ? "#6366f1" : "#f3f4f6",
                color: done || active ? "#fff" : "#9ca3af",
              }}>
                {done ? "✓" : i + 1}
              </div>
              <span style={{ fontSize: 11, color: active ? "#6366f1" : done ? "#059669" : "#9ca3af", fontWeight: active ? 700 : 400 }}>{labels[i]}</span>
            </div>
          );
        })}
      </div>

      <div style={S.body}>

        {/* ── STEP: UPLOAD ─────────────────────────────────────────────────── */}
        {step === "upload" && (
          <div>
            <div style={S.card}>
              <div style={S.cardTitle}>📦 Packing List WALA</div>
              <p style={S.hint}>Chargez le fichier Excel de packing list reçu du fournisseur. L'outil va automatiquement créer le bon de commande, les lots et valider la réception dans Odoo.</p>

              <label style={{ ...S.dropzone, ...(analyzing ? S.dropzoneDisabled : {}) }}>
                <input type="file" accept=".xlsx,.xls" onChange={handleFile} disabled={analyzing} style={{ display: "none" }} />
                {analyzing ? (
                  <div style={{ textAlign: "center" }}>
                    <div style={S.spinner} />
                    <div style={{ color: "#6366f1", fontWeight: 600, marginTop: 8 }}>Analyse en cours…</div>
                  </div>
                ) : (
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 40, marginBottom: 8 }}>📂</div>
                    <div style={{ fontWeight: 600, color: "#374151" }}>Cliquez pour sélectionner</div>
                    <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 4 }}>Fichier Excel WALA (.xlsx)</div>
                  </div>
                )}
              </label>

              {analyzeError && (
                <div style={S.errorBox}>
                  <strong>Erreur :</strong> {analyzeError}
                </div>
              )}
            </div>

            <div style={S.infoBox}>
              <div style={{ fontWeight: 600, marginBottom: 6, color: "#1e40af" }}>Ce qui sera créé automatiquement dans Odoo :</div>
              <div style={{ fontSize: 13, color: "#1d4ed8", lineHeight: 1.8 }}>
                ① Bon de commande fournisseur WALA<br />
                ② Lots de traçabilité avec dates d'expiration<br />
                ③ Validation de la réception avec quantités réelles
              </div>
            </div>
          </div>
        )}

        {/* ── STEP: PREVIEW ────────────────────────────────────────────────── */}
        {step === "preview" && (
          <div>
            {/* Fichier chargé */}
            <div style={{ ...S.card, background: "#f0fdf4", border: "1px solid #bbf7d0" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 20 }}>📄</span>
                <div>
                  <div style={{ fontWeight: 600, color: "#15803d" }}>{fileName}</div>
                  <div style={{ fontSize: 12, color: "#16a34a" }}>{packingLines.length} lignes parsées</div>
                </div>
              </div>
            </div>

            {/* Refs manquantes — BLOQUANT */}
            {missingArticles.length > 0 && (
              <div style={S.errorCard}>
                <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 8 }}>
                  ❌ {missingArticles.length} référence{missingArticles.length > 1 ? "s" : ""} introuvable{missingArticles.length > 1 ? "s" : ""} dans Odoo
                </div>
                <p style={{ fontSize: 13, color: "#7f1d1d", marginBottom: 10 }}>
                  Ces articles n'ont pas de correspondance dans Odoo (champ <code>x_studio_code_produit_fournisseur</code>). L'import ne peut pas continuer tant qu'ils ne sont pas configurés.
                </p>
                <div style={{ maxHeight: 160, overflowY: "auto", background: "#fff5f5", borderRadius: 6, padding: 10 }}>
                  {missingArticles.map(a => (
                    <div key={a.articleNo} style={{ display: "flex", gap: 8, padding: "4px 0", borderBottom: "1px solid #fecaca", fontSize: 13 }}>
                      <code style={{ color: "#dc2626", fontWeight: 700, minWidth: 90 }}>{a.articleNo}</code>
                      <span style={{ color: "#374151" }}>{a.description}</span>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 10, fontSize: 12, color: "#9ca3af" }}>
                  Les {matchedLines.length} autres articles correspondants ne seront pas importés non plus.
                </div>
              </div>
            )}

            {/* Articles matchés */}
            {matchedLines.length > 0 && (
              <div style={S.card}>
                <div style={S.cardTitle}>
                  ✅ {matchedLines.length} ligne{matchedLines.length > 1 ? "s" : ""} prête{matchedLines.length > 1 ? "s" : ""} à l'import
                </div>
                <div style={{ maxHeight: 240, overflowY: "auto" }}>
                  <table style={S.table}>
                    <thead>
                      <tr>
                        {["Code WALA", "Réf. interne", "Produit", "Qté", "Lot", "Expiration"].map(h => (
                          <th key={h} style={S.th}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {matchedLines.map((l, i) => (
                        <tr key={i} style={{ background: i % 2 === 0 ? "#fafafa" : "#fff" }}>
                          <td style={S.td}><code style={{ fontSize: 11 }}>{l.articleNo}</code></td>
                          <td style={S.td}><code style={{ fontSize: 11, color: "#6366f1" }}>{l.defaultCode}</code></td>
                          <td style={{ ...S.td, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.name}</td>
                          <td style={{ ...S.td, textAlign: "right" }}>{l.qty} {l.uomName}</td>
                          <td style={S.td}><code style={{ fontSize: 11 }}>{l.lotNo || "—"}</code></td>
                          <td style={S.td}>{l.expiryDate || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Boutons */}
            <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
              <button onClick={() => { setStep("upload"); setMatchedLines([]); setMissingArticles([]); }} style={S.btnSecondary}>
                ← Changer de fichier
              </button>
              {missingArticles.length === 0 && matchedLines.length > 0 && (
                <button onClick={runImport} style={S.btnPrimary}>
                  🚀 Lancer l'import Odoo
                </button>
              )}
            </div>
          </div>
        )}

        {/* ── STEP: IMPORTING ──────────────────────────────────────────────── */}
        {step === "importing" && (
          <div style={S.card}>
            <div style={S.cardTitle}>⏳ Import en cours…</div>
            <p style={{ fontSize: 13, color: "#6b7280", marginBottom: 16 }}>Ne fermez pas cette page.</p>
            <div>
              {importLogs.map((log, i) => (
                <LogLine key={i} text={log.text} status={log.status} />
              ))}
              {!importError && importLogs.length > 0 && importLogs[importLogs.length - 1].status === "running" && (
                <div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}>
                  <div style={S.spinner} />
                </div>
              )}
            </div>
            {importError && (
              <div style={{ ...S.errorBox, marginTop: 16 }}>
                <strong>Import échoué :</strong> {importError}
                <br /><br />
                <button onClick={() => setStep("preview")} style={S.btnSecondary}>← Retour</button>
              </div>
            )}
          </div>
        )}

        {/* ── STEP: DONE ───────────────────────────────────────────────────── */}
        {step === "done" && importResult && (
          <div>
            <div style={{ ...S.card, background: "#f0fdf4", border: "1px solid #86efac", textAlign: "center" }}>
              <div style={{ fontSize: 48, marginBottom: 8 }}>🎉</div>
              <div style={{ fontWeight: 700, fontSize: 18, color: "#15803d", marginBottom: 4 }}>Import réussi !</div>
              <div style={{ fontSize: 13, color: "#16a34a" }}>BDC créé · Lots affectés · À toi de valider la réception dans Odoo</div>
            </div>

            <div style={S.card}>
              <div style={S.cardTitle}>Récapitulatif</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div style={S.statBox}>
                  <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 2 }}>Bon de commande</div>
                  <div style={{ fontWeight: 700, color: "#374151" }}>{importResult.poName}</div>
                </div>
                <div style={S.statBox}>
                  <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 2 }}>Réception</div>
                  <div style={{ fontWeight: 700, color: "#374151" }}>{importResult.pickingName}</div>
                </div>
                <div style={S.statBox}>
                  <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 2 }}>Lignes importées</div>
                  <div style={{ fontWeight: 700, fontSize: 22, color: "#6366f1" }}>{importResult.linesCount}</div>
                </div>
                <div style={S.statBox}>
                  <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 2 }}>Lots créés</div>
                  <div style={{ fontWeight: 700, fontSize: 22, color: "#059669" }}>{importResult.lotsCreated}</div>
                </div>
              </div>

              {importResult.lotsDuplicate.length > 0 && (
                <div style={{ ...S.warnBox, marginTop: 12 }}>
                  <strong>⚠️ {importResult.lotsDuplicate.length} lot{importResult.lotsDuplicate.length > 1 ? "s" : ""} déjà existant{importResult.lotsDuplicate.length > 1 ? "s" : ""} (réutilisés) :</strong>
                  <div style={{ fontFamily: "monospace", fontSize: 12, marginTop: 6, color: "#92400e" }}>
                    {importResult.lotsDuplicate.join(", ")}
                  </div>
                </div>
              )}

              {/* Log détail */}
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 6 }}>Détail des opérations :</div>
                {importLogs.map((log, i) => (
                  <LogLine key={i} text={log.text} status={log.status} />
                ))}
              </div>
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => { setStep("upload"); setMatchedLines([]); setMissingArticles([]); setImportResult(null); setImportLogs([]); }} style={S.btnPrimary}>
                + Nouvel import
              </button>
              <button onClick={onBack} style={S.btnSecondary}>
                ← Accueil
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  screen: {
    minHeight: "100vh",
    background: "#f9fafb",
    display: "flex",
    flexDirection: "column",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "16px 20px",
    background: "#fff",
    borderBottom: "1px solid #e5e7eb",
    position: "sticky",
    top: 0,
    zIndex: 10,
  },
  backBtn: {
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: 6,
    borderRadius: 8,
    color: "#374151",
    display: "flex",
    alignItems: "center",
  },
  headerTitle: {
    fontWeight: 700,
    fontSize: 16,
    color: "#111827",
  },
  headerSub: {
    fontSize: 12,
    color: "#6b7280",
  },
  stepsBar: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "14px 20px",
    background: "#fff",
    borderBottom: "1px solid #f3f4f6",
    overflowX: "auto",
  },
  body: {
    flex: 1,
    padding: "16px 16px 32px",
    maxWidth: 680,
    width: "100%",
    margin: "0 auto",
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },
  card: {
    background: "#fff",
    borderRadius: 12,
    padding: "18px 20px",
    boxShadow: "0 1px 3px rgba(0,0,0,0.07)",
    border: "1px solid #e5e7eb",
  },
  cardTitle: {
    fontWeight: 700,
    fontSize: 15,
    color: "#111827",
    marginBottom: 12,
  },
  hint: {
    fontSize: 13,
    color: "#6b7280",
    lineHeight: 1.6,
    marginBottom: 16,
  },
  dropzone: {
    display: "block",
    border: "2px dashed #d1d5db",
    borderRadius: 10,
    padding: "40px 20px",
    textAlign: "center",
    cursor: "pointer",
    transition: "all 0.2s",
    background: "#fafafa",
  },
  dropzoneDisabled: {
    opacity: 0.7,
    cursor: "not-allowed",
    background: "#f3f4f6",
  },
  infoBox: {
    background: "#eff6ff",
    border: "1px solid #bfdbfe",
    borderRadius: 10,
    padding: "14px 16px",
  },
  errorCard: {
    background: "#fef2f2",
    border: "1px solid #fecaca",
    borderRadius: 12,
    padding: "16px 18px",
    color: "#7f1d1d",
  },
  errorBox: {
    background: "#fef2f2",
    border: "1px solid #fecaca",
    borderRadius: 8,
    padding: "12px 14px",
    color: "#991b1b",
    fontSize: 13,
  },
  warnBox: {
    background: "#fffbeb",
    border: "1px solid #fde68a",
    borderRadius: 8,
    padding: "12px 14px",
    color: "#78350f",
    fontSize: 13,
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: 12,
  },
  th: {
    padding: "6px 8px",
    textAlign: "left" as const,
    fontWeight: 600,
    color: "#6b7280",
    fontSize: 11,
    borderBottom: "2px solid #e5e7eb",
    whiteSpace: "nowrap" as const,
  },
  td: {
    padding: "6px 8px",
    color: "#374151",
    borderBottom: "1px solid #f3f4f6",
    fontSize: 12,
  },
  btnPrimary: {
    flex: 1,
    padding: "14px 20px",
    background: "linear-gradient(135deg, #6366f1, #4f46e5)",
    color: "#fff",
    border: "none",
    borderRadius: 10,
    fontWeight: 700,
    fontSize: 14,
    cursor: "pointer",
  },
  btnSecondary: {
    flex: 1,
    padding: "14px 20px",
    background: "#f9fafb",
    color: "#374151",
    border: "1px solid #e5e7eb",
    borderRadius: 10,
    fontWeight: 600,
    fontSize: 14,
    cursor: "pointer",
  },
  statBox: {
    background: "#f9fafb",
    border: "1px solid #e5e7eb",
    borderRadius: 8,
    padding: "12px 14px",
  },
  spinner: {
    width: 28,
    height: 28,
    border: "3px solid #e5e7eb",
    borderTop: "3px solid #6366f1",
    borderRadius: "50%",
    animation: "spin 0.8s linear infinite",
  },
};
