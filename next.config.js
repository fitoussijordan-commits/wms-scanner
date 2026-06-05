/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          // Empêche l'inclusion dans une iframe (clickjacking)
          { key: "X-Frame-Options", value: "DENY" },
          // Empêche le MIME-sniffing
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Limite les infos envoyées dans le Referer
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Désactive les anciennes fonctionnalités navigateur non utilisées
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        // CORS restrictif sur toutes les API routes — seul l'origine propre est autorisée
        source: "/api/(.*)",
        headers: [
          { key: "Access-Control-Allow-Origin", value: process.env.NEXT_PUBLIC_APP_URL || "same-origin" },
          { key: "Access-Control-Allow-Methods", value: "GET, POST, OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Content-Type, X-WMS-Token" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
