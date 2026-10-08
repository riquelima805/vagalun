'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const nacl = require('tweetnacl');
const bs58 = require('bs58').default || require('bs58');

const pricing = require('../pricing');
const { createReceiptService } = require('../service');
const { signReceipt, verifyTicket, issueTicket } = require('../receipt');
const delivery = require('../deliveryLedger');

const GB = 1e9, FILE = 100e6; // arquivo de 100 MB
const kp = () => { const k = nacl.sign.keyPair(); return { sk: k.secretKey, pk: bs58.encode(k.publicKey) }; };

function setup({ balanceUsd = 10, ip = '203.0.113.7', now } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcpt-'));
  process.env.RECEIPTS_DIR = dir;
  const owner = { balance: balanceUsd, charged: 0, batches: new Map(), failAfterApply: false };
  const registry = {
    listSites: () => ['video.vagalun.shop'],
    getSiteFull: () => ({ routes: new Map([['/v.mp4', { fileId: 'F1' }]]) }),
  };
  const hosting = { // espelha a lógica do endpoint do hosting: idempotente por batchId, nunca cobra além do saldo
    calls: 0,
    async charge(batchId, items) {
      this.calls++;
      if (!owner.batches.has(batchId)) {
        const results = items.map((it) => {
          const c = Math.min(it.usd, owner.balance);
          owner.balance -= c; owner.charged += c;
          return { domain: it.domain, requestedUsd: it.usd, chargedUsd: c };
        });
        owner.batches.set(batchId, results);
        if (owner.failAfterApply) { owner.failAfterApply = false; throw new Error('timeout depois de aplicar'); }
      }
      return { results: owner.batches.get(batchId) };
    },
  };
  const svc = createReceiptService({ registry, hosting, dir, now: now || (() => Date.now()) });
  const node = kp(), viewer = kp();
  const file = { fileId: 'F1', originalLength: FILE };
  const token = svc.issueForP2P({ file, vk: viewer.pk, ip, nodes: [node.pk] });
  const payload = verifyTicket(fs.readFileSync(path.join(dir, 'ticket-secret'), 'utf8').trim(), token);
  const receipt = (bytes, who = viewer, n = node.pk) => ({ node: n, bytes, sig: signReceipt(who.sk, payload, n, bytes) });
  return { dir, owner, svc, node, viewer, token, payload, receipt, ip, hosting };
}

test('preço: US$0,50 por 1000 min = US$0,0005/min; 1000 min na referência de 2,5 Mbps = US$0,50', () => {
  assert.equal(pricing.USD_PER_VIEWER_MINUTE, 0.0005);
  assert.ok(Math.abs(pricing.usdForBytes(pricing.REF_BYTES_PER_MINUTE * 1000) - 0.5) < 1e-9);
  assert.ok(Math.abs(pricing.usdForBytes(1e9) - 0.02667) < 1e-4); // ≈ US$0,0267/GB
});

test('caminho feliz: recibo válido -> dono é cobrado -> nó recebe 70% do que foi cobrado', async () => {
  const t = setup();
  const r = t.svc.submit({ ticket: t.token, receipts: [t.receipt(FILE)] }, t.ip);
  assert.equal(r.accepted.length, 1, JSON.stringify(r));
  const s = await t.svc.settleOnce();
  const gross = pricing.usdForBytes(FILE);
  assert.ok(Math.abs(t.owner.charged - gross) < 1e-9);
  const accrued = delivery.getUnpaidUsd(t.node.pk);
  assert.ok(Math.abs(accrued - gross * pricing.NODE_SHARE) < 1e-8, `accrued=${accrued}`);
  assert.ok(accrued < t.owner.charged, 'nó nunca recebe mais do que o dono pagou');
});

test('recibo assinado por OUTRA chave (forjado) é rejeitado', () => {
  const t = setup();
  const r = t.svc.submit({ ticket: t.token, receipts: [t.receipt(FILE, kp())] }, t.ip);
  assert.equal(r.accepted.length, 0);
  assert.equal(r.rejected[0].reason, 'assinatura inválida');
});

test('replay e cumulativo: reenviar não soma duas vezes; só o crescimento conta', () => {
  const t = setup();
  assert.equal(t.svc.submit({ ticket: t.token, receipts: [t.receipt(40e6)] }, t.ip).accepted[0].deltaBytes, 40e6);
  const again = t.svc.submit({ ticket: t.token, receipts: [t.receipt(40e6)] }, t.ip);
  assert.equal(again.accepted.length, 0); assert.equal(again.rejected[0].reason, 'duplicado/antigo');
  assert.equal(t.svc.submit({ ticket: t.token, receipts: [t.receipt(70e6)] }, t.ip).accepted[0].deltaBytes, 30e6);
  assert.equal(t.svc.submit({ ticket: t.token, receipts: [t.receipt(10e6)] }, t.ip).accepted.length, 0); // recibo antigo
});

test('nó que NÃO está no bilhete não ganha crédito', () => {
  const t = setup(); const other = kp();
  const r = t.svc.submit({ ticket: t.token, receipts: [{ node: other.pk, bytes: 1e6, sig: signReceipt(t.viewer.sk, t.payload, other.pk, 1e6) }] }, t.ip);
  assert.equal(r.accepted.length, 0); assert.equal(r.rejected[0].reason, 'nó fora do bilhete');
});

test('teto do bilhete: não dá pra declarar mais que o tamanho do arquivo (×1,25)', () => {
  const t = setup();
  const r = t.svc.submit({ ticket: t.token, receipts: [t.receipt(FILE * 10)] }, t.ip);
  assert.equal(r.accepted.length, 0); assert.equal(r.rejected[0].reason, 'acima do tamanho do arquivo');
  assert.equal(t.svc.submit({ ticket: t.token, receipts: [t.receipt(FILE * 1.2)] }, t.ip).accepted.length, 1);
});

test('bilhete adulterado ou expirado é rejeitado', () => {
  const t = setup();
  const [body, mac] = t.token.split('.');
  const fake = JSON.parse(Buffer.from(body, 'base64url')); fake.size = 1e12;
  const forged = Buffer.from(JSON.stringify(fake)).toString('base64url') + '.' + mac;
  assert.ok(t.svc.submit({ ticket: forged, receipts: [t.receipt(1e6)] }, t.ip).error);
  // expirado: emitido há 30 h com o MESMO segredo (TTL 6 h)
  const secret = fs.readFileSync(path.join(t.dir, 'ticket-secret'), 'utf8').trim();
  const old = issueTicket(secret, { fileId: 'F1', domain: 'd', size: FILE, nodes: [t.node.pk], vk: t.viewer.pk, now: Date.now() - 30 * 3600_000 });
  const r = t.svc.submit({ ticket: old.token, receipts: [{ node: t.node.pk, bytes: 1e6, sig: signReceipt(t.viewer.sk, old.payload, t.node.pk, 1e6) }] }, t.ip);
  assert.equal(r.error, 'bilhete expirado');
});

test('anti-Sybil: um IP não bombeia um nó além do teto IP→nó (aqui 150 MB)', () => {
  process.env.RECEIPT_MAX_IP_NODE_BYTES = String(150e6);
  try {
    const t = setup(); const v2 = kp();
    const t2 = t.svc.issueForP2P({ file: { fileId: 'F1', originalLength: FILE }, vk: v2.pk, ip: t.ip, nodes: [t.node.pk] });
    const p2 = verifyTicket(fs.readFileSync(path.join(t.dir, 'ticket-secret'), 'utf8').trim(), t2);
    assert.equal(t.svc.submit({ ticket: t.token, receipts: [t.receipt(FILE)] }, t.ip).accepted.length, 1);
    const r = t.svc.submit({ ticket: t2, receipts: [{ node: t.node.pk, bytes: FILE, sig: signReceipt(v2.sk, p2, t.node.pk, FILE) }] }, t.ip);
    assert.equal(r.accepted.length, 0); assert.equal(r.rejected[0].reason, 'teto IP→nó');
  } finally { delete process.env.RECEIPT_MAX_IP_NODE_BYTES; }
});

test('anti-Sybil: IP no teto de bilhetes não recebe mais bilhete (vídeo toca, não paga)', () => {
  process.env.RECEIPT_MAX_TICKETS_PER_IP = '2';
  try {
    const t = setup(); // 1º bilhete
    const mk = () => t.svc.issueForP2P({ file: { fileId: 'F1', originalLength: FILE }, vk: kp().pk, ip: t.ip, nodes: [t.node.pk] });
    assert.ok(mk()); assert.equal(mk(), null);
  } finally { delete process.env.RECEIPT_MAX_TICKETS_PER_IP; }
});

test('saldo insuficiente: nó só recebe o que o dono realmente pagou (nada é "impresso")', async () => {
  const gross = pricing.usdForBytes(FILE);
  const t = setup({ balanceUsd: gross / 4 });               // dono só tem 25% do necessário
  t.svc.submit({ ticket: t.token, receipts: [t.receipt(FILE)] }, t.ip);
  await t.svc.settleOnce();
  assert.ok(Math.abs(t.owner.charged - gross / 4) < 1e-9);
  assert.ok(Math.abs(delivery.getUnpaidUsd(t.node.pk) - (gross / 4) * pricing.NODE_SHARE) < 1e-8);
});

test('wash trading (dono = nó = viewer): gasta US$ X, recebe 70% de X de volta — prejuízo de 30%', async () => {
  const t = setup({ balanceUsd: 5 });
  t.svc.submit({ ticket: t.token, receipts: [t.receipt(FILE * 1.2)] }, t.ip);
  await t.svc.settleOnce();
  const spent = t.owner.charged, got = delivery.getUnpaidUsd(t.node.pk);
  assert.ok(got < spent && Math.abs(got / spent - pricing.NODE_SHARE) < 1e-6);
});

test('hosting cai DEPOIS de cobrar: a retentativa reusa o mesmo lote — dono cobrado 1x, nó creditado 1x', async () => {
  const t = setup(); t.owner.failAfterApply = true;
  t.svc.submit({ ticket: t.token, receipts: [t.receipt(FILE)] }, t.ip);
  await assert.rejects(() => t.svc.settleOnce(), /timeout/);
  assert.equal(delivery.getUnpaidUsd(t.node.pk), 0);          // nada creditado ainda
  await t.svc.settleOnce();                                      // retry, mesmo batchId
  await t.svc.settleOnce();                                      // nada novo
  assert.ok(Math.abs(t.owner.charged - pricing.usdForBytes(FILE)) < 1e-9);
  assert.ok(Math.abs(delivery.getUnpaidUsd(t.node.pk) - pricing.usdForBytes(FILE) * pricing.NODE_SHARE) < 1e-8);
  assert.equal(t.owner.batches.size, 1);
});

test('crédito de entrega: markPaid avança o cursor (mesmo molde do points.js)', async () => {
  const t = setup();
  t.svc.submit({ ticket: t.token, receipts: [t.receipt(FILE)] }, t.ip); await t.svc.settleOnce();
  const u = delivery.getUnpaidUsd(t.node.pk); assert.ok(u > 0);
  delivery.markPaid(t.node.pk, u); assert.equal(delivery.getUnpaidUsd(t.node.pk), 0);
});

test('nodeId que não é pubkey (ex.: app hoje) fica em "unclaimed", não é pago', async () => {
  const t = setup(); const appNode = 'app-node-123';
  const tk = t.svc.issueForP2P({ file: { fileId: 'F1', originalLength: FILE }, vk: t.viewer.pk, ip: '198.51.100.1', nodes: [appNode] });
  const p = verifyTicket(fs.readFileSync(path.join(t.dir, 'ticket-secret'), 'utf8').trim(), tk);
  t.svc.submit({ ticket: tk, receipts: [{ node: appNode, bytes: FILE, sig: signReceipt(t.viewer.sk, p, appNode, FILE) }] }, '198.51.100.1');
  await t.svc.settleOnce();
  const acc = JSON.parse(fs.readFileSync(path.join(t.dir, 'delivery-accrued.json'), 'utf8'));
  assert.ok(acc.unclaimed[appNode] > 0); assert.deepEqual(acc.accrued, {});
});
