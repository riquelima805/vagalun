package com.decentstorage.app.network

import android.content.Context
import com.decentstorage.app.storage.DeviceStorage
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest

class ShardRequestHandler(
    private val nodeId: String,
    private val capacityBytes: Long,
    private val dataDir: File,
    private val context: Context,
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
            return JSONObject().put("ok", false).put("error", "capacidade insuficiente neste nó (cota configurada)")
        }
        
        val realFree = DeviceStorage.freeBytes(context)
        if (payload.size > realFree - DeviceStorage.SYSTEM_RESERVE_BYTES) {
            return JSONObject().put("ok", false).put("error", "sem espaço físico real disponível neste dispositivo")
        }
        shardFile(shardKey).writeBytes(payload)
        return JSONObject().put("ok", true).put("size", payload.size)
    }

    fun handleGet(shardKey: String): Pair<JSONObject, ByteArray?> {
        val f = shardFile(shardKey)
        if (!f.exists()) {
            return JSONObject().put("ok", false).put("error", "shard não encontrado") to null
        }
        return JSONObject().put("ok", true) to f.readBytes()
    }

    fun handleGetRange(shardKey: String, offset: Long, length: Int): Pair<JSONObject, ByteArray?> {
        val f = shardFile(shardKey)
        if (!f.exists()) {
            return JSONObject().put("ok", false).put("error", "shard não encontrado") to null
        }
        val fileLen = f.length()
        if (offset < 0 || offset >= fileLen) {
            return JSONObject().put("ok", false).put("error", "offset fora do shard") to null
        }
        val actualLength = minOf(length.toLong(), fileLen - offset).toInt()
        val buf = ByteArray(actualLength)
        RandomAccessFile(f, "r").use { raf ->
            raf.seek(offset)
            raf.readFully(buf)
        }
        return JSONObject().put("ok", true).put("offset", offset).put("length", actualLength) to buf
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

    fun handle(header: JSONObject, payload: ByteArray?): Pair<JSONObject, ByteArray?> {
        return when (header.optString("op")) {
            "put" -> handlePut(header.getString("shardKey"), payload ?: ByteArray(0)) to null
            "get" -> handleGet(header.getString("shardKey"))
            "get_range" -> handleGetRange(
                header.getString("shardKey"),
                header.getLong("offset"),
                header.getInt("length")
            )
            "delete" -> handleDelete(header.getString("shardKey")) to null
            "challenge" -> handleChallenge(header.getString("shardKey"), header.optString("nonce", "")) to null
            "status" -> handleStatus() to null
            "gossip" -> handleGossip(header) to null
            else -> (JSONObject().put("ok", false).put("error", "op desconhecida") to null)
        }
    }
}
