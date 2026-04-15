/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config, { isServer }) => {
    // pdfjs-dist v5 est ESM pur (.mjs) — webpack doit traiter ces fichiers comme JS modules
    config.module.rules.push({
      test: /\.mjs$/,
      include: /node_modules/,
      type: "javascript/auto",
    });

    // pdfjs-dist essaie d'importer 'canvas' côté Node — on le désactive côté browser
    if (!isServer) {
      config.resolve.alias = {
        ...config.resolve.alias,
        canvas: false,
      };
    }

    return config;
  },
};

module.exports = nextConfig;
