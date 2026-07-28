package com.decentstorage.app.network

import android.content.Context
import org.json.JSONObject
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.Executors


class ShardServer(
    nodeId: String,
    private val port: Int,
    capacityBytes: Long,
    dataDir: File,
    context: Context,
    onGossip: ((JSONObject) -> JSONObject)? = null
) {
    private val requestHandler = ShardRequestHandler(nodeId, capacityBytes, dataDir, context, onGossip)
    private val executor = Executors.newCachedThreadPool()
    private var serverSocket: ServerSocket? = null
    @Volatile private var running = false

    fun start() {
        if (running) return
        running = true
        val ss = ServerSocket(port)
        serverSocket = ss
        executor.execute {
            while (running) {
                val socket = try {
                    ss.accept()
                } catch (e: Exception) {
                    if (running) e.printStackTrace() 
                    break
                }
                executor.execute { handleConnection(socket) }
            }
        }
    }

    private fun handleConnection(socket: Socket) {
        socket.use {
            try {
                val input = DataInputStream(socket.getInputStream())
                val output = DataOutputStream(socket.getOutputStream())
                val header = ShardProtocol.readJson(input)

                when (header.optString("op")) {
                    "put" -> {
                        val payload = ShardProtocol.readFrame(input)
                        val resp = requestHandler.handlePut(header.getString("shardKey"), payload)
                        ShardProtocol.writeJson(output, resp)
                    }
                    "get" -> {
                        val (resp, payload) = requestHandler.handleGet(header.getString("shardKey"))
                        ShardProtocol.writeJson(output, resp)
                        if (resp.optBoolean("ok", false) && payload != null) {
                            ShardProtocol.writeFrame(output, payload)
                        }
                    }
                    "delete" -> {
                        val resp = requestHandler.handleDelete(header.getString("shardKey"))
                        ShardProtocol.writeJson(output, resp)
                    }
                    "challenge" -> {
                        val resp = requestHandler.handleChallenge(header.getString("shardKey"), header.optString("nonce", ""))
                        ShardProtocol.writeJson(output, resp)
                    }
                    "status" -> {
                        ShardProtocol.writeJson(output, requestHandler.handleStatus())
                    }
                    "gossip" -> {
                        ShardProtocol.writeJson(output, requestHandler.handleGossip(header))
                    }
                    else -> {
                        ShardProtocol.writeJson(output, JSONObject().put("ok", false).put("error", "op desconhecida"))
                    }
                }
            } catch (e: Exception) {
                
            }
        }
    }

    fun stop() {
        running = false
        try { serverSocket?.close() } catch (_: Exception) {}
        executor.shutdownNow()
    }
}
