package com.decentstorage.app.network

import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/**
 * O que fazer quando chega um op (put/get/delete/challenge/status/gossip) — extraído do
 * ShardServer pra poder ser reusado tanto pelo transporte TCP (LAN, socket puro) quanto
 * pelo DataChannel WebRTC (WAN). Os dois canais falam o mesmo protocolo de shard; só
 * muda o "cano" por onde o header JSON + payload binário passam.
 *
 * Continua com a MESMA ressalva do storageNode.js original / ShardServer.kt:
 * `handleChallenge` é hash(shard || nonce) — não é um proof-of-storage robusto,
 * só o suficiente pra detectar um nó completamente ausente/mentiroso ingênuo.
 */
class ShardRequestHandler(
    private val nodeId: String,
    private val capacityBytes: Long,
    private val dataDir: File,
    /** Chamado quando chega op="gossip" — o GossipRegistry passa handleIncomingGossip aqui. */
    private val onGossip: ((JSONObject) -> JSONObject)? = null
) {
    init { dataDir.mkdirs() }

    private fun shardFile(shardKey: String): File {
        val safe = shardKey.replace(Regex("[^a-zA-Z0-9_-]"), "")
        return File(dataDir, "$safe.shard")
    }

    private fun usedBytes(): Long = dataDir.listFiles()?.sumOf { it.length() } ?: 0L

    fun handlePut(shardKey: String, payload: ByteArray): JSONObject {
        if (usedBytes() + payload.size > capacityBytes) {
            return JSONObject().put("ok", false).put("error", "capacidade insuficiente neste nó")
        }
        shardFile(shardKey).writeBytes(payload)
        return JSONObject().put("ok", true).put("size", payload.size)
    }

    /** Retorna (header de resposta, bytes do shard se ok). */
    fun handleGet(shardKey: String): Pair<JSONObject, ByteArray?> {
        val f = shardFile(shardKey)
        if (!f.exists()) {
            return JSONObject().put("ok", false).put("error", "shard não encontrado") to null
        }
        return JSONObject().put("ok", true) to f.readBytes()
    }

    fun handleDelete(shardKey: String): JSONObject {
        val f = shardFile(shardKey)
        if (f.exists()) f.delete()
        return JSONObject().put("ok", true)
    }

    fun handleChallenge(shardKey: String, nonce: String): JSONObject {
        val f = shardFile(shardKey)
        if (!f.exists()) {
            return JSONObject().put("ok", false).put("error", "shard não encontrado")
        }
        val digest = MessageDigest.getInstance("SHA-256")
        digest.update(f.readBytes())
        digest.update(nonce.toByteArray())
        val proof = digest.digest().joinToString("") { "%02x".format(it) }
        return JSONObject().put("ok", true).put("proof", proof)
    }

    fun handleStatus(): JSONObject {
        val used = usedBytes()
        return JSONObject()
            .put("nodeId", nodeId)
            .put("capacityBytes", capacityBytes)
            .put("usedBytes", used)
            .put("freeBytes", capacityBytes - used)
    }

    fun handleGossip(header: JSONObject): JSONObject {
        val handler = onGossip
            ?: return JSONObject().put("ok", false).put("error", "gossip não habilitado neste nó")
        return handler(header)
    }

    /**
     * Roteador genérico por op — usado pelo WebRtcTransport, que recebe header+payload já
     * decodificados de uma frame só (DataChannel não tem "stream" de socket, é uma
     * mensagem por vez). Retorna (header de resposta, payload binário de resposta se houver).
     */
    fun handle(header: JSONObject, payload: ByteArray?): Pair<JSONObject, ByteArray?> {
        return when (header.optString("op")) {
            "put" -> handlePut(header.getString("shardKey"), payload ?: ByteArray(0)) to null
            "get" -> handleGet(header.getString("shardKey"))
            "delete" -> handleDelete(header.getString("shardKey")) to null
            "challenge" -> handleChallenge(header.getString("shardKey"), header.optString("nonce", "")) to null
            "status" -> handleStatus() to null
            "gossip" -> handleGossip(header) to null
            else -> (JSONObject().put("ok", false).put("error", "op desconhecida") to null)
        }
    }
}
