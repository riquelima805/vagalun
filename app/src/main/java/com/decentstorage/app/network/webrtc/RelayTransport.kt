package com.decentstorage.app.network.webrtc

import com.decentstorage.app.network.Transport
import org.json.JSONObject
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class RelayTransport(
    private val peerNodeId: String,
    private val signalingClient: SignalingClient
) : Transport {

    
    private class RelayResponse(val header: JSONObject, val payload: ByteArray?)

    private val pending = ConcurrentHashMap<Int, ArrayBlockingQueue<RelayResponse>>()
    private val nextReqId = AtomicInteger(0)

    init {
        
        signalingClient.onRelayResponse = { from, requestId, header, payload ->
            if (from == peerNodeId) {
                pending[requestId]?.offer(RelayResponse(header, payload))
            }
        }
    }

    private fun sendAndAwait(
        header: JSONObject, 
        payload: ByteArray?, 
        timeoutMs: Long = 20_000
    ): RelayResponse? {
        val reqId = nextReqId.incrementAndGet()
        val q = ArrayBlockingQueue<RelayResponse>(1)
        pending[reqId] = q
        
        // Envia via WebSocket
        signalingClient.sendRelay(peerNodeId, reqId, header, payload)
        
        return try { 
            // Aguarda a resposta (bloqueia a thread atual até o limite do timeout)
            q.poll(timeoutMs, TimeUnit.MILLISECONDS) 
        } finally { 
            pending.remove(reqId) 
        }
    }

    override fun putShard(shardKey: String, data: ByteArray): Boolean {
        val resp = sendAndAwait(
            JSONObject().put("op", "put").put("shardKey", shardKey), 
            data
        ) ?: return false
        
        return resp.header.optBoolean("ok", false)
    }

    override fun getShard(shardKey: String): ByteArray? {
        val resp = sendAndAwait(
            JSONObject().put("op", "get").put("shardKey", shardKey), 
            null
        ) ?: return null
        
        return if (resp.header.optBoolean("ok", false)) resp.payload else null
    }

    override fun deleteShard(shardKey: String): Boolean {
        val resp = sendAndAwait(
            JSONObject().put("op", "delete").put("shardKey", shardKey), 
            null
        ) ?: return false
        
        return resp.header.optBoolean("ok", false)
    }

    override fun challenge(shardKey: String, nonce: String): String? {
        val resp = sendAndAwait(
            JSONObject().put("op", "challenge").put("shardKey", shardKey).put("nonce", nonce), 
            null
        ) ?: return null
        
        return resp.header.optString("proof").takeIf { it.isNotEmpty() }
    }

    override fun gossip(payload: JSONObject): JSONObject? {
        payload.put("op", "gossip")
        val resp = sendAndAwait(payload, null) ?: return null
        return resp.header
    }

    override fun status(): JSONObject? {
        val resp = sendAndAwait(JSONObject().put("op", "status"), null) ?: return null
        return resp.header
    }

    override fun close() {
        pending.clear()
    }
}
