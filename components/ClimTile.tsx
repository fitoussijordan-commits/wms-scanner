"use client";
// components/ClimTile.tsx — Climatisation LG ThinQ sur l'accueil
//
// L'entrepôt stocke des cosmétiques : la température ambiante n'est pas un
// confort, elle conditionne la conservation. La voir dès l'ouverture du WMS,
// sans passer par l'application LG, fait gagner le geste et surtout évite de
// découvrir un problème trop tard.
//
// La tuile disparaît entièrement si la climatisation n'est pas configurée : une
// carte en erreur permanente sur l'accueil finit par être ignorée.
import { useState, useEffect, useCallback } from "react";
import { writeHeaders } from "@/lib/writeToken";

interface Etat {
  ambiante: number | null;
  consigne: number | null;
  unite: string;
  allumee: boolean;
  mode: string | null;
}

export default function ClimTile({ onToast, desktop }: { onToast: (m: string) => void; desktop?: boolean }) {
  const [etat, setEtat] = useState<Etat | null>(null);
  const [absente, setAbsente] = useState(false);
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState("");

  const lire = useCallback(async () => {
    try {
      const r = await fetch("/api/lg-thinq?action=status").then(x => x.json());
      if (r?.error) {
        // Non configurée : on se retire sans bruit. Toute autre erreur est dite.
        if (String(r.error).includes("non configurée")) { setAbsente(true); return; }
        setErreur(r.error); return;
      }
      setEtat(r); setErreur("");
    } catch { setErreur("Climatisation injoignable"); }
  }, []);

  useEffect(() => {
    lire();
    // Rafraîchissement lent : une température évolue en minutes, pas en secondes,
    // et chaque appel passe par le cloud de LG.
    const t = setInterval(lire, 120_000);
    return () => clearInterval(t);
  }, [lire]);

  const commander = async (corps: any) => {
    if (occupe) return;
    setOccupe(true);
    try {
      const r = await fetch("/api/lg-thinq", {
        method: "POST",
        headers: { ...writeHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(corps),
      }).then(x => x.json());
      if (r?.error) throw new Error(r.error);
      if (r.etat) setEtat(r.etat);
      onToast("Climatisation mise à jour");
    } catch (e: any) {
      onToast("Commande refusée : " + (e?.message || e));
    }
    setOccupe(false);
  };

  if (absente) return null;

  const C = { border: "#e8ecf3", text: "#0f172a", muted: "#64748b", blue: "#2563eb" };
  const consigne = etat?.consigne ?? null;

  return (
    <div style={{ background: "#fff", border: `1px solid ${C.border}`, borderRadius: 14, padding: 16,
                  boxShadow: "0 1px 2px rgba(15,23,42,.04)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: .4 }}>
          Climatisation
        </div>
        {etat && (
          <button onClick={() => commander({ power: etat.allumee ? "off" : "on" })} disabled={occupe}
            style={{ padding: "5px 12px", borderRadius: 8, border: "none", cursor: occupe ? "default" : "pointer",
                     fontSize: 12, fontWeight: 800, fontFamily: "inherit",
                     background: etat.allumee ? "#16a34a" : "#e2e8f0",
                     color: etat.allumee ? "#fff" : C.muted }}>
            {etat.allumee ? "EN MARCHE" : "ARRÊTÉE"}
          </button>
        )}
      </div>

      {erreur ? (
        <div style={{ fontSize: 12.5, color: "#dc2626" }}>{erreur}</div>
      ) : !etat ? (
        <div style={{ fontSize: 12.5, color: C.muted }}>Lecture…</div>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: desktop ? 34 : 30, fontWeight: 800, color: C.text, lineHeight: 1 }}>
                {etat.ambiante != null ? `${etat.ambiante}°` : "—"}
              </div>
              <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>ambiante</div>
            </div>
            <div>
              <div style={{ fontSize: 18, fontWeight: 700, color: C.blue, lineHeight: 1 }}>
                {consigne != null ? `${consigne}°` : "—"}
              </div>
              <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>consigne</div>
            </div>
          </div>

          {consigne != null && (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button onClick={() => commander({ target: consigne - 1 })} disabled={occupe || consigne <= 16}
                style={{ flex: 1, padding: "10px 0", borderRadius: 9, border: `1.5px solid ${C.border}`,
                         background: "#fff", fontSize: 17, fontWeight: 800, cursor: "pointer", fontFamily: "inherit" }}>
                −
              </button>
              <button onClick={() => commander({ target: consigne + 1 })} disabled={occupe || consigne >= 30}
                style={{ flex: 1, padding: "10px 0", borderRadius: 9, border: `1.5px solid ${C.border}`,
                         background: "#fff", fontSize: 17, fontWeight: 800, cursor: "pointer", fontFamily: "inherit" }}>
                +
              </button>
            </div>
          )}
          {/* Bornes 16–30 °C : au-delà, la plupart des climatiseurs refusent la
              consigne et la commande échouerait sans raison visible. */}
        </>
      )}
    </div>
  );
}
