import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "WMS Scanner",
  description: "Scanner d'entrepôt Odoo — Transferts internes, recherche stock",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "WMS Scanner",
  },
  formatDetection: {
    telephone: false,
  },
  other: {
    "mobile-web-app-capable": "yes",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#2563eb",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="fr">
      <head>
        {/* Apple Touch Icon */}
        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />

        {/* iOS splash screens — main sizes */}
        <link rel="apple-touch-startup-image" href="/icons/icon-512.png" />

        {/* Prevent iOS from auto-detecting phone numbers */}
        <meta name="format-detection" content="telephone=no" />

        {/* Register service worker */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              if ('serviceWorker' in navigator) {
                window.addEventListener('load', () => {
                  navigator.serviceWorker.register('/sw.js')
                    .then(r => console.log('SW registered:', r.scope))
                    .catch(e => console.log('SW failed:', e));
                });
              }
            `,
          }}
        />
      </head>
      <body
        style={{
          margin: 0,
          padding: 0,
          WebkitTapHighlightColor: "transparent",
          WebkitTouchCallout: "none",
          overscrollBehavior: "none",
        }}
      >
        {children}
      </body>
    </html>
  );
}
