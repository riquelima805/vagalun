'use strict';

// Merkle tree com combinação de pares ORDENADA POR HASH (não por índice)
// + prefixos de domínio (RFC 6962 / OpenZeppelin), pra bater EXATAMENTE
// com verify_merkle_proof_sorted no lib.rs. Sem os prefixos, a raiz
// calculada aqui != raiz recalculada on-chain e todo claim_epoch falha
// com InvalidProof.

const { keccak256 } = require('js-sha3');
const bs58 = require('bs58').default || require('bs58');

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

/**
 * Folha = keccak256(0x00 || pubkey(32) || amount_lamports LE(8) || epoch_id LE(8))
 * O 0x00 aqui precisa bater com o hash inicial que claim_epoch já aplica
 * na leaf ANTES de entrar no loop de proof (keccak::hashv([LEAF_PREFIX, &leaf])).
 */
function leafHash(pubkeyBase58, amountLamports, epochId) {
  const pubkeyBytes = bs58.decode(pubkeyBase58);
  if (pubkeyBytes.length !== 32) {
    throw new Error(`pubkey inválida (${pubkeyBase58}): esperado 32 bytes, veio ${pubkeyBytes.length}`);
  }
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(BigInt(amountLamports));
  const epochBuf = Buffer.alloc(8);
  epochBuf.writeBigUInt64LE(BigInt(epochId));
  const rawLeaf = Buffer.concat([Buffer.from(pubkeyBytes), amountBuf, epochBuf]);
  const rawLeafHash = Buffer.from(keccak256.arrayBuffer(rawLeaf));
  // aplica o mesmo prefixo de folha que o programa aplica dentro de claim_epoch
  return Buffer.from(keccak256.arrayBuffer(Buffer.concat([LEAF_PREFIX, rawLeafHash])));
}

/** Combina dois nós já prefixados, menor sempre primeiro, com prefixo de nó interno. */
function hashPair(a, b) {
  const [lo, hi] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
  return Buffer.from(keccak256.arrayBuffer(Buffer.concat([NODE_PREFIX, lo, hi])));
}

function buildTree(leaves) {
  if (leaves.length === 0) throw new Error('buildTree: lista de folhas vazia');
  let level = leaves.slice();
  const layers = [level];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        next.push(hashPair(level[i], level[i + 1]));
      } else {
        next.push(level[i]);
      }
    }
    layers.push(next);
    level = next;
  }
  return { root: level[0], layers };
}

function getProof(layers, leafIndex) {
  const proof = [];
  let idx = leafIndex;
  for (let l = 0; l < layers.length - 1; l++) {
    const layer = layers[l];
    const pairIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
    if (pairIdx < layer.length) proof.push(layer[pairIdx]);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

function verifyProof(leaf, proof, root) {
  let hash = leaf;
  for (const sibling of proof) {
    hash = hashPair(hash, sibling);
  }
  return hash.equals(root);
}

module.exports = { leafHash, hashPair, buildTree, getProof, verifyProof };
