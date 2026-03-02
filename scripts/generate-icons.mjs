// scripts/generate-icons.mjs
// Run: node scripts/generate-icons.mjs
// Requires: npm install sharp

import sharp from 'sharp';
import { mkdirSync } from 'fs';

const SVG = `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#2563eb"/>
      <stop offset="100%" style="stop-color:#1d4ed8"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="96" fill="url(#bg)"/>
  <!-- Warehouse -->
  <path d="M128 400h256M128 220h256M160 180l96-60 96 60M144 220v180M368 220v180" 
        stroke="white" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  <!-- Shelves -->
  <path d="M200 280v60M256 280v60M312 280v60" 
        stroke="white" stroke-width="14" stroke-linecap="round" fill="none"/>
  <!-- Scan line -->
  <line x1="176" y1="370" x2="336" y2="370" stroke="#60a5fa" stroke-width="6" stroke-linecap="round" opacity="0.8"/>
</svg>`;

try { mkdirSync('public/icons', { recursive: true }); } catch {}

const buf = Buffer.from(SVG);

await sharp(buf).resize(192, 192).png().toFile('public/icons/icon-192.png');
await sharp(buf).resize(512, 512).png().toFile('public/icons/icon-512.png');
// Apple touch icon
await sharp(buf).resize(180, 180).png().toFile('public/icons/apple-touch-icon.png');

console.log('✅ Icons generated in public/icons/');
