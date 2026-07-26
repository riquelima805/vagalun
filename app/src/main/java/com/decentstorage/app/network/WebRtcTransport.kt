package com.decentstorage.app.network.webrtc

import com.decentstorage.app.network.ShardRequestHandler
import com.decentstorage.app.network.Transport
import org.json.JSONObject
import org.webrtc.DataChannel
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Implementa Transport sobre um DataChannel WebRTC já em estado OPEN. Do ponto de vista
 * do GossipRegistry/StorageClient é indistinguível do TcpTransport — put/get/delete/etc
 * bloqueiam a thread chamadora até a resposta chegar (ou até `timeoutMs` estourar),
 * igual um socket TCP síncrono.
 *
 * Detalhe importante: o MESMO DataChannel é usado nas duas direções. Se o peer remoto
 * também guarda shards nossos, os pedidos dele chegam por `onMessage` misturados com as
 * respostas aos NOSSOS pedidos — por isso o `requestId` do WebRtcFrame e o `pending` map
 * abaixo. Pedidos recebidos (tipo=REQUEST) são resolvidos localmente via ShardRequestHandler
 * (mesma lógica que o ShardServer usa pra LAN) e respondidos na hora.
 */
class WebRtcTransport(
    val peerNodeId: String,
    private val dataChannel: DataChannel,
    private val requestHandler: ShardRequestHandler,
    private val timeoutMs: Long = 15_000
) : Transport, DataChannel.Observer {

    private val nextRequestId = AtomicInteger(0)
    private val pending = ConcurrentHashMap<Int, ArrayBlockingQueue<WebRtcFrame.Decoded>>()

    init {
        dataChannel.registerObserver(this)
    }

    private fun sendAndAwait(header: JSONObject, payload: ByteArray?): WebRtcFrame.Decoded? {
        if (dataChannel.state() != DataChannel.State.OPEN) return null
        val reqId = nextRequestId.incrementAndGet()
        val queue = ArrayBlockingQueue<WebRtcFrame.Decoded>(1)
        pending[reqId] = queue
        try {
            val frame = WebRtcFrame.encode(WebRtcFrame.TYPE_REQUEST, reqId, header, payload)
            val sent = dataChannel.send(DataChannel.Buffer(frame, true))
            if (!sent) return null
            return queue.poll(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            return null
        } finally {
            pending.remove(reqId)
        }
    }

    override fun putShard(shardKey: String, data: ByteArray): Boolean {
        val resp = sendAndAwait(JSONObject().put("op", "put").put("shardKey", shardKey), data) ?: return false
        return resp.header.optBoolean("ok", false)
    }

    override fun getShard(shardKey: String): ByteArray? {
        val resp = sendAndAwait(JSONObject().put("op", "get").put("shardKey", shardKey), null) ?: return null
        if (!resp.header.optBoolean("ok", false)) return null
        return resp.payload
    }

    override fun deleteShard(shardKey: String): Boolean {
        val resp = sendAndAwait(JSONObject().put("op", "delete").put("shardKey", shardKey), null) ?: return false
        return resp.header.optBoolean("ok", false)
    }

    override fun challenge(shardKey: String, nonce: String): String? {
        val resp = sendAndAwait(
            JSONObject().put("op", "challenge").put("shardKey", shardKey).put("nonce", nonce), null
        ) ?: return null
        return if (resp.header.optBoolean("ok", false)) resp.header.optString("proof") else null
    }

    override fun gossip(payload: JSONObject): JSONObject? {
        val resp = sendAndAwait(payload.put("op", "gossip"), null) ?: return null
        return resp.header
    }

    override fun status(): JSONObject? {
        val resp = sendAndAwait(JSONObject().put("op", "status"), null) ?: return null
        return resp.header
    }

    override fun close() {
        try { dataChannel.unregisterObserver() } catch (_: Exception) {}
        try { dataChannel.close() } catch (_: Exception) {}
        pending.clear()
    }

    // ---------------- DataChannel.Observer ----------------

    override fun onMessage(buffer: DataChannel.Buffer) {
        val decoded = try {
            WebRtcFrame.decode(buffer.data)
        } catch (e: Exception) {
            return // frame corrompida/incompleta — descarta, quem pediu vai tomar timeout
        }
        if (decoded.type == WebRtcFrame.TYPE_RESPONSE) {
            pending[decoded.requestId]?.offer(decoded)
        } else {
            handleIncomingRequest(decoded)
        }
    }

    /** O peer remoto está pedindo algo PRA GENTE (ex: guardar um shard dele) — trata local e responde. */
    private fun handleIncomingRequest(decoded: WebRtcFrame.Decoded) {
        val (respHeader, respPayload) = try {
            requestHandler.handle(decoded.header, decoded.payload)
        } catch (e: Exception) {
            JSONObject().put("ok", false).put("error", e.message ?: "erro") to null
        }
        try {
            val frame = WebRtcFrame.encode(WebRtcFrame.TYPE_RESPONSE, decoded.requestId, respHeader, respPayload)
            dataChannel.send(DataChannel.Buffer(frame, true))
        } catch (_: Exception) {
            // canal pode ter caído entre receber o pedido e responder — sem retry aqui,
            // quem pediu vai perceber pelo timeout e (no caso do GossipRegistry) tentar outro peer
        }
    }

    override fun onBufferedAmountChange(previousAmount: Long) {}

    override fun onStateChange() {
        // fechamento é tratado pelo WebRtcManager (que observa a PeerConnection/canal
        // pra saber quando remover a sessão e chamar onTransportClosed)
    }
}
