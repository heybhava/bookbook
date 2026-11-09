// Draws the bookbook app icon (rounded square + serif "b") to build/icon.png (512×512).
import { createCanvas } from '../node_modules/@napi-rs/canvas/index.js';
import fs from 'node:fs'; import path from 'node:path';
const S = 512; const c = createCanvas(S, S); const g = c.getContext('2d');
g.fillStyle = '#17171a'; g.beginPath(); g.roundRect(16, 16, S - 32, S - 32, 112); g.fill();
const grad = g.createLinearGradient(0, 0, S, S); grad.addColorStop(0, '#e8c98a'); grad.addColorStop(1, '#c98a4b'); g.fillStyle = grad; g.beginPath(); g.roundRect(56, 56, S - 112, S - 112, 84); g.fill();
g.fillStyle = '#17171a'; g.font = 'bold 330px Georgia, "Times New Roman", serif'; g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.fillText('b', S / 2, 372);
fs.mkdirSync(path.join(import.meta.dirname, 'build'), { recursive: true }); fs.writeFileSync(path.join(import.meta.dirname, 'build', 'icon.png'), c.toBuffer('image/png')); console.log('icon written');
