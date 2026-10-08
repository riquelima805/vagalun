'use strict';

/**
 * siteManifest.js — formato canônico v2 do manifesto de site. PURO (só crypto do Node):
 * o gateway/registry usa isto sem precisar carregar @solana/web3.js.
 */

const crypto = require('crypto');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

const MAGIC = 'vagalun-site-v2';
const MAX_DOMAIN_LEN = 100;
const MIN_DOMAIN_LEN = 3;

/** Mesma regra do contrato (validate_domain): a-z 0-9 . - ; sem '..'; não começa/termina com . ou - */
function validateDomain(domain) {
  if (typeof domain !== 'string') throw new Error('domínio inválido');
  if (domain.length < MIN_DOMAIN_LEN || domain.length > MAX_DOMAIN_LEN) throw new Error('domínio inválido (tamanho)');
  if (!/^[a-z0-9.-]+$/.test(domain)) throw new Error('domínio inválido (use a-z, 0-9, . e -)');
  if (/^[.-]|[.-]$/.test(domain) || domain.includes('..')) throw new Error('domínio inválido (bordas/..)');
  return domain;
}

function field(name, v) {
  if (typeof v !== 'string') throw new Error(`${name} precisa ser string`);
  if (v.includes('\n') || v.includes('|')) throw new Error(`${name} não pode conter '|' nem quebra de linha`);
  return v;
}

/** Ordem por BYTES UTF-8 (igual em JS e Kotlin). O v1 usava localeCompare no JS e sortedBy no Kotlin: divergiam. */
function cmpUtf8(a, b) { return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')); }

/**
 *   vagalun-site-v2
 *   <domain>
 *   <version>
 *   <path>|<fileId>|<contentType>|<fileKeyB64>     (uma linha por rota, ordenadas por path)
 */
function canonicalManifestV2(domain, version, routes) {
  validateDomain(domain);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('version precisa ser inteiro >= 1');
  if (!Array.isArray(routes)) throw new Error('routes inválido');
  const seen = new Set();
  const lines = routes
    .map((r) => ({
      path: field('path', r.path),
      fileId: field('fileId', r.fileId),
      contentType: field('contentType', r.contentType || ''),
      fileKeyB64: field('fileKeyB64', r.fileKeyB64 || ''),
    }))
    .sort((x, y) => cmpUtf8(x.path, y.path))
    .map((r) => {
      if (seen.has(r.path)) throw new Error(`rota duplicada: ${r.path}`);
      seen.add(r.path);
      return `${r.path}|${r.fileId}|${r.contentType}|${r.fileKeyB64}`;
    });
  return [MAGIC, domain, String(version), ...lines].join('\n');
}

function manifestHash(domain, version, routes) {
  return sha256(Buffer.from(canonicalManifestV2(domain, version, routes), 'utf8'));
}


module.exports = { MAGIC, MAX_DOMAIN_LEN, MIN_DOMAIN_LEN, validateDomain, canonicalManifestV2, manifestHash, cmpUtf8, sha256 };
