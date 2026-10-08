'use strict';

/**
 * O pkg (empacotador do .exe) não sabe ler o formato de módulo mais novo
 * de algumas versões do pacote "uuid". O problema é que pacotes como
 * rpc-websockets (usado pelo @solana/web3.js) trazem sua PRÓPRIA cópia
 * aninhada de "uuid" dentro de node_modules/rpc-websockets/node_modules/,
 * e o "overrides" do package.json nem sempre alcança essa cópia aninhada
 * (depende da versão do npm).
 *
 * Esse script roda sozinho depois de "npm install" (ver "postinstall" no
 * package.json) e apaga qualquer cópia de "uuid" que não seja a de cima
 * (node_modules/uuid, essa sim já fixada numa versão compatível). Sem a
 * cópia aninhada, o Node volta a usar a de cima automaticamente — é assim
 * que a resolução de módulos do Node já funciona por padrão.
 */
const fs = require('fs');
const path = require('path');

const nodeModulesRoot = path.join(__dirname, '..', 'node_modules');
const topLevelUuid = path.join(nodeModulesRoot, 'uuid');

function walk(dir, removed) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return; // pasta não existe / sem permissão — ignora e segue
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);

    if (entry.name.startsWith('@')) {
      // pasta de escopo (ex: @solana/web3.js) — os pacotes de verdade
      // estão um nível abaixo, não tem node_modules aqui direto.
      walk(full, removed);
      continue;
    }

    if (entry.name === 'uuid' && full !== topLevelUuid) {
      fs.rmSync(full, { recursive: true, force: true });
      removed.push(full);
      continue;
    }

    const nested = path.join(full, 'node_modules');
    if (fs.existsSync(nested)) walk(nested, removed);
  }
}

if (!fs.existsSync(topLevelUuid)) {
  console.warn('[fix-uuid] aviso: node_modules/uuid não encontrado (rode "npm install" primeiro). Nada foi alterado.');
  process.exit(0);
}

const removed = [];
walk(nodeModulesRoot, removed);

if (removed.length) {
  console.log(`[fix-uuid] removida(s) ${removed.length} cópia(s) aninhada(s) de "uuid" incompatível(is) com o pkg:`);
  removed.forEach((p) => console.log('  - ' + path.relative(path.join(__dirname, '..'), p)));
} else {
  console.log('[fix-uuid] nenhuma cópia aninhada de "uuid" encontrada — nada pra corrigir.');
}