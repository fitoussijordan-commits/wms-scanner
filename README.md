# WMS Scanner - Odoo Barcode App Custom

App de scan pour transferts internes Odoo avec affichage du stock en temps réel.

## Setup

```bash
npm install
npm run dev
```

Ouvrir http://localhost:3000

## Déploiement Vercel

```bash
git init
git add .
git commit -m "init"
# Sur GitHub : créer repo "wms-scanner"
git remote add origin git@github.com:TON_USER/wms-scanner.git
git push -u origin main
```

Puis connecter le repo sur vercel.com → Import Project.

## Config

Au login, renseigner l'URL Odoo et le nom de la base de données.
