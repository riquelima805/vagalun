package com.decentstorage.app.network

import org.json.JSONObject
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.Executors

/**
 * Roda no dispositivo de quem EMPRESTA espaço pra rede (o "storage provider").
 * Equivalente direto do storageNode.js, mas por socket TCP puro em vez de Express/HTTP.
 * Nunca vê o conteúdo em claro dos arquivos — só recebe bytes já cifrados e já
 * fragmentados pelo dono do arquivo.
 */
class ShardServer(
    private val nodeId: String,
    private val port: Int,
    private val capacityBytes: Long,
    private val dataDir: File,
    /** Chamado quando chega uma mensagem op="gossip" — usado pelo GossipRegistry pra
     *  trocar metadados de arquivos/peers sem precisar de um segundo servidor/porta. */
    private val onGossip: ((JSONObject) -> JSONObject)? = null
) {
    private var serverSocket: ServerSocket? = null
    private val pool = Executors.newCachedThreadPool()
    @Volatile private var running = false

    // Mesma lógica de put/get/delete/challenge/status/gossip usada pelo transporte WebRTC
    // (network/webrtc/WebRtcTransport.kt) — só muda o cano (socket TCP aqui, DataChannel lá).
    private val handler = ShardRequestHandler(nodeId, capacityBytes, dataDir, onGossip)

    init {
        dataDir.mkdirs()
    }

    fun start() {
        running = true
        serverSocket = ServerSocket(port)
        pool.execute {
            while (running) {
                try {
                    val client = serverSocket!!.accept()
                    pool.execute { handleClient(client) }
                } catch (e: Exception) {
                    if (running) e.printStackTrace()
                }
            }
        }
    }

    fun stop() {
        running = false
        serverSocket?.close()
        pool.shutdownNow()
    }

    private fun handleClient(socket: Socket) {
        socket.use {
            val input = DataInputStream(it.getInputStream())
            val output = DataOutputStream(it.getOutputStream())
            try {
                val header = ShardProtocol.readJson(input)
                when (header.getString("op")) {
                    "put" -> handlePut(header, input, output)
                    "get" -> handleGet(header, output)
                    "delete" -> handleDelete(header, output)
                    "challenge" -> handleChallenge(header, output)
                    "status" -> handleStatus(output)
                    "gossip" -> handleGossip(header, output)
                    else -> ShardProtocol.writeJson(output, JSONObject().put("ok", false).put("error", "op desconhecida"))
                }
            } catch (e: Exception) {
                try {
                    ShardProtocol.writeJson(output, JSONObject().put("ok", false).put("error", e.message ?: "erro"))
                } catch (_: Exception) {}
            }
        }
    }

    private fun handlePut(header: JSONObject, input: DataInputStream, output: DataOutputStream) {
        val payload = ShardProtocol.readFrame(input)
        ShardProtocol.writeJson(output, handler.handlePut(header.getString("shardKey"), payload))
    }

    private fun handleGet(header: JSONObject, output: DataOutputStream) {
        val (resp, data) = handler.handleGet(header.getString("shardKey"))
        ShardProtocol.writeJson(output, resp)
        if (data != null) ShardProtocol.writeFrame(output, data)
    }

    private fun handleDelete(header: JSONObject, output: DataOutputStream) {
        ShardProtocol.writeJson(output, handler.handleDelete(header.getString("shardKey")))
    }

    /**
     * Prova de posse simplificada (MVP), igual ao storageNode.js: hash(shard || nonce).
     * ATENÇÃO (mesma ressalva do original): isso NÃO é um proof-of-storage
     * criptograficamente robusto. Produção real precisaria de algo tipo
     * Proof-of-Replication/PoSt, ou desafios com múltiplos nonces sobre offsets do shard.
     */
    private fun handleChallenge(header: JSONObject, output: DataOutputStream) {
        ShardProtocol.writeJson(output, handler.handleChallenge(header.getString("shardKey"), header.optString("nonce", "")))
    }

    private fun handleGossip(header: JSONObject, output: DataOutputStream) {
        ShardProtocol.writeJson(output, handler.handleGossip(header))
    }

    private fun handleStatus(output: DataOutputStream) {
        ShardProtocol.writeJson(output, handler.handleStatus())
    }
}
