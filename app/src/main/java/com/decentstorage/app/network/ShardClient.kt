package com.decentstorage.app.network

import org.json.JSONObject
import java.io.DataInputStream
import java.io.DataOutputStream
import java.net.Socket

object ShardClient {

    private const val TIMEOUT_MS = 8000

    private inline fun <T> withConnection(host: String, port: Int, block: (DataInputStream, DataOutputStream) -> T): T {
        Socket().use { socket ->
            socket.connect(java.net.InetSocketAddress(host, port), TIMEOUT_MS)
            socket.soTimeout = TIMEOUT_MS
            val input = DataInputStream(socket.getInputStream())
            val output = DataOutputStream(socket.getOutputStream())
            return block(input, output)
        }
    }

    fun putShard(host: String, port: Int, shardKey: String, data: ByteArray): Boolean = withConnection(host, port) { input, output ->
        ShardProtocol.writeJson(output, JSONObject().put("op", "put").put("shardKey", shardKey))
        ShardProtocol.writeFrame(output, data)
        ShardProtocol.readJson(input).optBoolean("ok", false)
    }

    fun getShard(host: String, port: Int, shardKey: String): ByteArray? = withConnection(host, port) { input, output ->
        ShardProtocol.writeJson(output, JSONObject().put("op", "get").put("shardKey", shardKey))
        val resp = ShardProtocol.readJson(input)
        if (!resp.optBoolean("ok", false)) return@withConnection null
        ShardProtocol.readFrame(input)
    }

    fun getShardRange(host: String, port: Int, shardKey: String, offset: Long, length: Int): ByteArray? =
        withConnection(host, port) { input, output ->
            ShardProtocol.writeJson(
                output,
                JSONObject().put("op", "get_range").put("shardKey", shardKey).put("offset", offset).put("length", length)
            )
            val resp = ShardProtocol.readJson(input)
            if (!resp.optBoolean("ok", false)) return@withConnection null
            ShardProtocol.readFrame(input)
        }

    fun deleteShard(host: String, port: Int, shardKey: String): Boolean = withConnection(host, port) { input, output ->
        ShardProtocol.writeJson(output, JSONObject().put("op", "delete").put("shardKey", shardKey))
        ShardProtocol.readJson(input).optBoolean("ok", false)
    }

    fun challenge(host: String, port: Int, shardKey: String, nonce: String): String? = withConnection(host, port) { input, output ->
        ShardProtocol.writeJson(output, JSONObject().put("op", "challenge").put("shardKey", shardKey).put("nonce", nonce))
        val resp = ShardProtocol.readJson(input)
        if (!resp.optBoolean("ok", false)) null else resp.optString("proof")
    }
  
    fun gossip(host: String, port: Int, payload: JSONObject): JSONObject? = try {
        withConnection(host, port) { input, output ->
            payload.put("op", "gossip")
            ShardProtocol.writeJson(output, payload)
            ShardProtocol.readJson(input)
        }
    } catch (e: Exception) {
        null
    }

    fun status(host: String, port: Int): JSONObject? = try {
        withConnection(host, port) { input, output ->
            ShardProtocol.writeJson(output, JSONObject().put("op", "status"))
            ShardProtocol.readJson(input)
        }
    } catch (e: Exception) {
        null
    }
}
