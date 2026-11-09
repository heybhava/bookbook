// Regression: the production Content-Security-Policy has no 'unsafe-eval', so browser code must never evaluate strings.
// (pdf.js used to be loaded through `new Function('u','return import(u)')`, which worked in development and broke every PDF in the production/desktop build.)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
test('client code never evaluates strings (production CSP forbids it)', () => {
  const root = path.resolve(import.meta.dirname, '..', 'src');
  const clientFiles = [...walk(path.join(root, 'components')), path.join(root, 'app', 'page.tsx'), ...walk(path.join(root, 'lib')).filter((f) => /\.tsx?$/.test(f))].filter((f) => /\.tsx?$/.test(f) && fs.readFileSync(f, 'utf8').trimStart().startsWith("'use client'"));
  assert.ok(clientFiles.length > 10, 'found the client files');
  const bad = clientFiles.filter((f) => /\bnew Function\s*\(|\beval\s*\(/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(bad, [], 'string evaluation in client code');
});
test('production CSP does not allow unsafe-eval for scripts', () => {
  const mw = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'middleware.ts'), 'utf8');
  assert.match(mw, /\$\{prod \? '' : " 'unsafe-eval'"\}/, 'unsafe-eval is development-only');
});
