'use strict';

// Merkle tree com combinação de pares ORDENADA POR HASH (não por índice).
// É a escolha certa aqui porque não existe "índice de chunk" natural pra
// uma folha (pubkey, amount, epoch_id) — diferente do merkle de prova de
// armazenamento (verify_merkle_proof no programa, que usa leaf_index
// porque ali a folha É um chunk numerado de um shard).
//
// O programa Anchor precisa verificar com a MESMA convenção (menor
// primeiro, comparação lexicográfica dos 32 bytes) — ver verify_merkle_proof_sorted
// no lib.rs.

const { keccak256 } = require('js-sha3');
const bs58 = require('bs58').default || require('bs58');

/**
 * Folha = keccak256(pubkey(32 bytes) || amount_lamports (u64 LE, 8 bytes) || epoch_id (u64 LE, 8 bytes))
 * Precisa bater byte a byte com o `keccak::hashv(&[claimant, &amount.to_le_bytes(), &epoch_id.to_le_bytes()])`
 * do lado do programa.
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
  const preimage = Buffer.concat([Buffer.from(pubkeyBytes), amountBuf, epochBuf]);
  return Buffer.from(keccak256.arrayBuffer(preimage));
}

/** Combina dois hashes de 32 bytes com o menor sempre primeiro (convenção estável, sem depender de índice). */
function hashPair(a, b) {
  const [lo, hi] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
  return Buffer.from(keccak256.arrayBuffer(Buffer.concat([lo, hi])));
}

/**
 * Constrói a árvore a partir das folhas (na ordem dada — a ordem de
 * `leaves` define o `leafIndex` usado depois em getProof).
 * Nó ímpar sem par na camada sobe sem alteração (convenção padrão).
 */
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
        next.push(level[i]); // último elemento ímpar sobe sem par
      }
    }
    layers.push(next);
    level = next;
  }
  return { root: level[0], layers };
}

/** Devolve a lista de irmãos (bottom-up) necessária pra provar a folha `leafIndex`. */
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

/** Verificação local (útil em teste/debug) — mesma lógica que o programa faz on-chain. */
function verifyProof(leaf, proof, root) {
  let hash = leaf;
  for (const sibling of proof) {
    hash = hashPair(hash, sibling);
  }
  return hash.equals(root);
}

module.exports = { leafHash, hashPair, buildTree, getProof, verifyProof };
