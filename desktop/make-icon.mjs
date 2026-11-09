// Builds every bookbook icon from the brand mark in build/logo-source.png (black "b" book on white):
//   build/icon.png (512, app + tray icon), ../src/app/icon.png (favicon), ../public/logo.png (in-app logo).
import { createCanvas, loadImage } from '../node_modules/@napi-rs/canvas/index.js';
import fs from 'node:fs'; import path from 'node:path';
const HERE = import.meta.dirname; const img = await loadImage(path.join(HERE, 'build', 'logo-source.png'));
// Find the mark's bounding box (dark pixels) so the artwork can be centred with even padding.
const probe = createCanvas(img.width, img.height); const pg = probe.getContext('2d'); pg.drawImage(img, 0, 0); const { data } = pg.getImageData(0, 0, img.width, img.height);
let x0 = img.width, y0 = img.height, x1 = 0, y1 = 0;
for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) { const i = (y * img.width + x) * 4; if (data[i + 3] > 128 && data[i] < 110) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
function tile(S, pad, radius) {
  const c = createCanvas(S, S); const g = c.getContext('2d'); g.fillStyle = '#ffffff'; g.beginPath(); g.roundRect(0, 0, S, S, radius); g.fill();
  const k = (S - 2 * pad) / Math.max(bw, bh); const w = bw * k, h = bh * k; g.imageSmoothingQuality = 'high'; g.drawImage(img, x0, y0, bw, bh, (S - w) / 2, (S - h) / 2, w, h); return c.toBuffer('image/png');
}
const out = (p, buf) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); };
out(path.join(HERE, 'build', 'icon.png'), tile(512, 120, 112));
out(path.join(HERE, '..', 'src', 'app', 'icon.png'), tile(128, 28, 28));
out(path.join(HERE, '..', 'public', 'logo.png'), tile(256, 60, 56));
console.log('icons written from logo-source.png');
