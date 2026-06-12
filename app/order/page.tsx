"use client";
import { useState, useEffect } from "react";
import * as odoo from "@/lib/odoo";
import OrderScreen from "@/components/OrderScreen";

const LS_KEY = "wms_order_session";

export default function OrderPage() {
  const [session, setSession] = useState<odoo.OdooSession | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) setSession(JSON.parse(raw));
    } catch {}
    setReady(true);
  }, []);

  if (!ready) return null;

  if (!session) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", fontFamily: "'DM Sans', sans-serif", background: "#f8fafc", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 36 }}>🔒</div>
        <div style={{ fontSize: 16, fontWeight: 700, color: "#0f172a" }}>Session expirée</div>
        <div style={{ fontSize: 13, color: "#64748b" }}>Ouvre d'abord le WMS et réessaie.</div>
        <button onClick={() => window.close()} style={{ marginTop: 8, padding: "10px 20px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
          Fermer
        </button>
      </div>
    );
  }

  return (
    <OrderScreen
      session={session}
      onBack={() => window.close()}
      onToast={(msg) => console.log(msg)}
    />
  );
}
