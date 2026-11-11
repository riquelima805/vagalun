package com.decentstorage.app

import com.decentstorage.app.crypto.KeyManager
import com.decentstorage.app.erasure.AvailableShard
import com.decentstorage.app.erasure.ReedSolomon
import com.decentstorage.app.network.GossipRegistry
import com.decentstorage.app.network.ShardKeys
import java.util.Base64

class StorageClient(private val registry: GossipRegistry) {

    data class UploadResult(val fileId: String, val k: Int, val m: Int, val n: Int, val blockCount: Int)

    companion object {
        const val DEFAULT_BLOCK_SIZE = 1 * 1024 * 1024 // 1MB — ajustável por upload
    }

    fun uploadFile(
        buffer: ByteArray,
        fileName: String,
        masterKey: ByteArray,
        k: Int = 1,
        m: Int = 0,
        blockSize: Int = DEFAULT_BLOCK_SIZE
    ): UploadResult {
        val n = k + m
        val fileId = KeyManager.fileIdFor(fileName)
        val fileKey = KeyManager.deriveFileKey(masterKey, fileId)

        val blocks = mutableListOf<GossipRegistry.BlockMeta>()
        var offset = 0
        var blockIndex = 0

        while (offset < buffer.size) {
            val end = minOf(offset + blockSize, buffer.size)
            val plainChunk = buffer.copyOfRange(offset, end)

            // Criptografia independente por bloco — IV/tag próprios
            val enc = KeyManager.encryptBuffer(plainChunk, fileKey)
            val encoded = ReedSolomon.encode(enc.ciphertext, k, m)

            val chosen = registry.bestPeersForUpload(n, encoded.shardSize.toLong())
            require(chosen.size >= n) { "rede não tem peers suficientes pro bloco $blockIndex: precisa de $n, disponível ${chosen.size}" }

            val placements = mutableListOf<GossipRegistry.Placement>()
            for (i in 0 until n) {
                val peer = chosen[i]
                val ok = peer.transport.putShard(ShardKeys.of(fileId, blockIndex, i), encoded.shards[i])
                require(ok) { "falha ao enviar shard $i do bloco $blockIndex pro peer ${peer.nodeId}" }
                placements.add(GossipRegistry.Placement(i, peer.nodeId))
            }

            blocks.add(
                GossipRegistry.BlockMeta(
                    blockIndex = blockIndex,
                    plainLength = plainChunk.size,
                    shardSize = encoded.shardSize,
                    iv = Base64.getEncoder().encodeToString(enc.iv),
                    authTag = Base64.getEncoder().encodeToString(enc.authTag),
                    placements = placements
                )
            )

            offset = end
            blockIndex++
        }

        registry.registerFile(
            GossipRegistry.FileMeta(
                fileId = fileId, 
                fileName = fileName, 
                k = k, 
                m = m, 
                n = n,
                blockSize = blockSize, 
                originalLength = buffer.size, 
                blocks = blocks
            )
        )

        return UploadResult(fileId, k, m, n, blocks.size)
    }

    fun downloadFile(fileId: String, masterKey: ByteArray): ByteArray {
        val file = registry.getFile(fileId) ?: error("arquivo não encontrado nos metadados conhecidos")
        val fileKey = KeyManager.deriveFileKey(masterKey, fileId)
        val out = java.io.ByteArrayOutputStream(file.originalLength)

        for (block in file.blocks.sortedBy { it.blockIndex }) {
            out.write(downloadBlock(file, block, fileKey))
        }
        return out.toByteArray()
    }

    // Extraído pra ser reaproveitado depois pelo range/streaming
    private fun downloadBlock(file: GossipRegistry.FileMeta, block: GossipRegistry.BlockMeta, fileKey: ByteArray): ByteArray {
        val fetched = mutableListOf<AvailableShard>()
        for (p in block.placements) {
            if (fetched.size >= file.k) break
            val peer = registry.knownPeers().find { it.nodeId == p.nodeId && it.alive } ?: continue
            val data = try {
                peer.transport.getShard(ShardKeys.of(file.fileId, block.blockIndex, p.shardIndex))
            } catch (e: Exception) { null }
            if (data != null) fetched.add(AvailableShard(p.shardIndex, data))
        }
        require(fetched.size >= file.k) {
            "bloco ${block.blockIndex}: só consegui ${fetched.size} de ${file.k} shards necessários"
        }

        val ciphertext = ReedSolomon.decode(fetched, block.plainLength, block.shardSize, file.k, file.m)
        return KeyManager.decryptBuffer(
            KeyManager.Encrypted(
                ciphertext = ciphertext,
                iv = Base64.getDecoder().decode(block.iv),
                authTag = Base64.getDecoder().decode(block.authTag)
            ),
            fileKey
        )
    }
}
