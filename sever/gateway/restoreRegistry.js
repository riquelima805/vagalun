// Recuperação manual do registry a partir do backup replicado (item 12).
// Roda SÓ quando o operador decide — nunca automaticamente no boot do
// gateway, pra não sobrescrever sozinho uma recuperação que já esteja em
// andamento à mão, ou apagar um gateway-data.json que na verdade está bom.
//
// Uso:
//   REGISTRY_BACKUP_KEY=... REGISTRY_BACKUP_NODES=host:port,host:port \
//     node gateway/restoreRegistry.js
//
// Escreve o resultado em GATEWAY_DATA_FILE (mesma env var que registry.js
// usa) — ou no default gateway/gateway-data.json — DEPOIS de confirmar com
// o operador, e faz backup do arquivo atual (se existir) antes de
// sobrescrever, por segurança.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { restoreFromBackup } = require('./registryBackup');

const DATA_FILE = process.env.GATEWAY_DATA_FILE || path.join(__dirname, 'gateway-data.json');

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans); }));
}

async function main() {
  console.log('[restore] buscando snapshot nos nós de backup configurados...');
  const jsonStr = await restoreFromBackup();
  const parsed = JSON.parse(jsonStr);
  console.log(
    `[restore] snapshot encontrado: ${(parsed.peers || []).length} peer(s), ` +
    `${(parsed.files || []).length} arquivo(s), ${(parsed.sites || []).length} site(s)`
  );

  if (fs.existsSync(DATA_FILE)) {
    const ans = await ask(`[restore] já existe um ${DATA_FILE} — SOBRESCREVER com o snapshot do backup? (digite "sim" pra confirmar) `);
    if (ans.trim().toLowerCase() !== 'sim') {
      console.log('[restore] cancelado pelo operador.');
      process.exit(0);
    }
    const safetyCopy = `${DATA_FILE}.antes-do-restore.${Date.now()}.json`;
    fs.copyFileSync(DATA_FILE, safetyCopy);
    console.log(`[restore] arquivo atual salvo em ${safetyCopy} antes de sobrescrever`);
  }

  fs.writeFileSync(DATA_FILE, jsonStr);
  console.log(`[restore] pronto — ${DATA_FILE} restaurado. Pode subir o gateway normalmente agora.`);
}

main().catch((e) => {
  console.error('[restore] falhou:', e.message);
  process.exit(1);
});
