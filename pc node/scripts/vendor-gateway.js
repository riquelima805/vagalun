#!/usr/bin/env node
'use strict';
// Copia o gateway (sever/gateway + sever/chain) pra ./gateway-lib, porque o PC node é um pacote
// separado (pkg) e não pode require() fora da própria pasta. Rode antes de `npm run build:*`.
//   node scripts/vendor-gateway.js [caminho/pra/sever]      (padrão: ../sever)
const fs = require('fs');
const path = require('path');

const SEVER = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'sever'));
const OUT = path.join(__dirname, '..', 'gateway-lib');
if (!fs.existsSync(path.join(SEVER, 'gateway', 'gateway.js'))) {
  console.error(`não achei ${path.join(SEVER, 'gateway', 'gateway.js')} — passe o caminho do sever/ como argumento`);
  process.exit(1);
}
const SKIP = new Set(['test', 'node_modules', 'gateway-data', 'backups', '.git']);
function copy(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    if (SKIP.has(path.basename(src))) return;
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src)) copy(path.join(src, f), path.join(dst, f));
  } else if (!/^gateway-data.*\.json$|\.(log|bak)$/.test(path.basename(src))) {
    fs.copyFileSync(src, dst); // dados locais do gateway (registry) nunca vão junto
  }
}
fs.rmSync(OUT, { recursive: true, force: true });
copy(path.join(SEVER, 'gateway'), path.join(OUT, 'gateway'));
fs.mkdirSync(path.join(OUT, 'chain'), { recursive: true });
for (const f of ['siteManifest.js', 'siteChain.js']) {
  const p = path.join(SEVER, 'chain', f);
  if (fs.existsSync(p)) fs.copyFileSync(p, path.join(OUT, 'chain', f));
}
console.log(`gateway copiado pra ${OUT}`);
