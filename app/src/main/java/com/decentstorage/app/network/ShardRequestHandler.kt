package com.decentstorage.app.network

import android.content.Context
import com.decentstorage.app.storage.DeviceStorage
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/**
 * O que fazer quando chega um op (put/get/delete/challenge/status/gossip) — extraído do
 * ShardServer pra poder ser reusado tanto pelo transporte TCP (LAN, socket puro) quanto
 * pelo DataChannel WebRTC (WAN). Os dois canais falam o mesmo protocolo de shard; só
 * muda o "cano" por onde o header JSON + payload binário passam.
 *
 * ATUALIZAÇÃO: `capacityBytes` (a cota que o usuário configurou no slider) deixou de ser
 * a única trava. Antes disso, um celular de 128GB podia "oferecer" 200GB de cota — o
 * número era só decorativo e o handlePut aceitava até o disco físico estourar. Agora
 * cada handlePut confere o espaço LIVRE real via DeviceStorage.freeBytes(context) e
 * recusa o shard se não houver espaço de verdade, mesmo que a cota configurada permita.
 *
 * Continua com a MESMA ressalva do storageNode.js original / ShardServer.kt:
 * `handleChallenge` é hash(shard || nonce) — não é um proof-of-storage robusto,
 * só o suficiente pra detectar um nó completamente ausente/mentiroso ingênuo.
 */
class ShardRequestHandler(
    private val nodeId: String,
    private val capacityBytes: Long,
    private val dataDir: File,
    private val context: Context,
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
        // 1) trava lógica: não pode passar da cota que o usuário configurou
        if (usedBytes() + payload.size > capacityBytes) {
            return JSONObject().put("ok", false).put("error", "capacidade insuficiente neste nó (cota configurada)")
        }
        // 2) trava FÍSICA: nunca escreve se isso for estourar o disco real do aparelho,
        // mesmo que a cota configurada (o slider) diga que "cabe". Essa é a trava que
        // faltava — sem ela, um celular de 128GB configurado com 200GB de cota
        // simplesmente enchia o disco de verdade e travava o sistema operacional.
        val realFree = DeviceStorage.freeBytes(context)
        if (payload.size > realFree - DeviceStorage.SYSTEM_RESERVE_BYTES) {
            return JSONObject().put("ok", false).put("error", "sem espaço físico real disponível neste dispositivo")
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

    /** Status agora reporta espaço livre REAL (min entre cota configurada e disco físico),
     *  não só a cota configurada — é isso que alimenta o `freeBytes` usado pelo
     *  GossipRegistry.bestPeersForUpload, então a rede inteira passa a enxergar a
     *  capacidade verdadeira de cada peer, não um número inflado. */
    fun handleStatus(): JSONObject {
        val used = usedBytes()
        val logicalFree = (capacityBytes - used).coerceAtLeast(0L)
        val physicalFree = (DeviceStorage.freeBytes(context) - DeviceStorage.SYSTEM_RESERVE_BYTES).coerceAtLeast(0L)
        val realFree = minOf(logicalFree, physicalFree)
        return JSONObject()
            .put("nodeId", nodeId)
            .put("capacityBytes", capacityBytes)
            .put("usedBytes", used)
            .put("freeBytes", realFree)
            .put("physicalFreeBytes", physicalFree)
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
