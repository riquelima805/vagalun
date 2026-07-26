package com.decentstorage.app

import com.decentstorage.app.crypto.KeyManager
import com.decentstorage.app.erasure.AvailableShard
import com.decentstorage.app.erasure.ReedSolomon
import com.decentstorage.app.network.GossipRegistry
import java.util.Base64

/**
 * Orquestra upload/download do ponto de vista do dono do arquivo.
 * Port direto de client.js, mas escolhendo peers a partir do GossipRegistry local
 * (visão distribuída da rede) em vez de perguntar pra um coordenador central.
 */
class StorageClient(private val registry: GossipRegistry) {

    data class UploadResult(val fileId: String, val k: Int, val m: Int, val n: Int, val peerIds: List<String>)

    fun shardKeyFor(fileId: String, shardIndex: Int) = "${fileId}_$shardIndex"

    /**
     * 1. cifra localmente (a chave nunca sai do dispositivo do dono)
     * 2. fragmenta o ciphertext em K+M shards (Reed-Solomon)
     * 3. escolhe os N melhores peers conhecidos (score/espaço livre)
     * 4. distribui um shard por peer
     * 5. registra os metadados (não o conteúdo) no GossipRegistry local, que propaga por gossip
     */
    fun uploadFile(buffer: ByteArray, fileName: String, masterKey: ByteArray, k: Int = 6, m: Int = 4): UploadResult {
        val n = k + m
        val fileId = KeyManager.fileIdFor(fileName)
        val fileKey = KeyManager.deriveFileKey(masterKey, fileId)

        val enc = KeyManager.encryptBuffer(buffer, fileKey)
        val encoded = ReedSolomon.encode(enc.ciphertext, k, m)

        val chosen = registry.bestPeersForUpload(n, encoded.shardSize.toLong())
        require(chosen.size >= n) { "rede não tem peers suficientes: precisa de $n, disponível ${chosen.size}" }

        val placements = mutableListOf<GossipRegistry.Placement>()
        for (i in 0 until n) {
            val peer = chosen[i]
            val ok = peer.transport.putShard(shardKeyFor(fileId, i), encoded.shards[i])
            require(ok) { "falha ao enviar shard $i para peer ${peer.nodeId}" }
            placements.add(GossipRegistry.Placement(i, peer.nodeId))
        }

        registry.registerFile(
            GossipRegistry.FileMeta(
                fileId = fileId,
                fileName = fileName,
                k = k, m = m, n = n,
                shardSize = encoded.shardSize,
                cipherLength = enc.ciphertext.size,
                originalLength = buffer.size,
                iv = Base64.getEncoder().encodeToString(enc.iv),
                authTag = Base64.getEncoder().encodeToString(enc.authTag),
                placements = placements
            )
        )

        return UploadResult(fileId, k, m, n, placements.map { it.nodeId })
    }

    /** Baixa e reconstrói um arquivo a partir de qualquer K peers que ainda respondam. */
    fun downloadFile(fileId: String, masterKey: ByteArray): ByteArray {
        val file = registry.getFile(fileId) ?: error("arquivo não encontrado nos metadados conhecidos (aguarde o gossip convergir ou verifique o fileId)")

        val fetched = mutableListOf<AvailableShard>()
        for (p in file.placements) {
            if (fetched.size >= file.k) break
            val peer = registry.knownPeers().find { it.nodeId == p.nodeId && it.alive } ?: continue
            val data = try {
                peer.transport.getShard(shardKeyFor(fileId, p.shardIndex))
            } catch (e: Exception) { null }
            if (data != null) fetched.add(AvailableShard(p.shardIndex, data))
        }
        require(fetched.size >= file.k) {
            "só consegui ${fetched.size} de ${file.k} shards necessários — rede degradada demais no momento"
        }

        val ciphertext = ReedSolomon.decode(fetched, file.cipherLength, file.shardSize, file.k, file.m)
        val fileKey = KeyManager.deriveFileKey(masterKey, fileId)
        return KeyManager.decryptBuffer(
            KeyManager.Encrypted(
                ciphertext = ciphertext,
                iv = Base64.getDecoder().decode(file.iv),
                authTag = Base64.getDecoder().decode(file.authTag)
            ),
            fileKey
        )
    }
}
