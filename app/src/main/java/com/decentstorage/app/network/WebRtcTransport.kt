package com.decentstorage.app.network.webrtc

import com.decentstorage.app.network.ShardRequestHandler
import com.decentstorage.app.network.Transport
import org.json.JSONObject
import org.webrtc.DataChannel
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Request/response em cima do RTCDataChannel, com fatiamento automático de
 * frames grandes (ver [WebRtcFrame.chunksFor] / [WebRtcFrame.Reassembler] —
 * motivo completo comentado em WebRtcFrame.kt). Cada frame lógico agora é
 * 1+ mensagens no fio.
 *
 * O envio da RESPOSTA a um pedido recebido roda em [responseExecutor], NUNCA
 * dentro do callback [onMessage] do WebRTC, porque:
 *   1) mandar um shard de várias centenas de KB em dezenas de chunks
 *      sequenciais (um `dataChannel.send()` atrás do outro, com espera de
 *      backpressure no meio) é lento demais pra rodar na thread interna do
 *      WebRTC — travaria sinalização/ICE de TODOS os peers desse app
 *      enquanto isso não terminasse;
 *   2) assim dá pra esperar o `bufferedAmount` baixar (backpressure) sem
 *      travar mais nada além dessa resposta específica.
 * Já o envio de um REQUEST (`sendAndAwait`, chamado pelo código da
 * aplicação, não pelo WebRTC) roda direto na thread de quem chamou — ela já
 * é uma chamada bloqueante por natureza (espera a resposta de qualquer
 * forma), não precisa de executor próprio.
 */
class WebRtcTransport(
    val peerNodeId: String,
    private val dataChannel: DataChannel,
    private val requestHandler: ShardRequestHandler,
    private val timeoutMs: Long = 20_000
) : Transport, DataChannel.Observer {

    companion object {
        private const val TAG = "VagalunTransport"

        // Não deixa mais que ~2MB de chunks enfileirados no buffer do SCTP de
        // uma vez — acima disso, espera baixar antes de mandar o próximo
        // chunk. Evita estourar o buffer interno do data channel quando o
        // peer do outro lado está lento pra consumir (ex.: celular fraco).
        private const val BUFFERED_AMOUNT_HIGH_WATERMARK = 2L * 1024 * 1024
        private const val BACKPRESSURE_POLL_MS = 15L
    }

    private val nextRequestId = AtomicInteger(0)
    private val pending = ConcurrentHashMap<Int, ArrayBlockingQueue<WebRtcFrame.Decoded>>()
    private val reassembler = WebRtcFrame.Reassembler()

    // Uma thread só: serializa o envio das respostas (o envio dos chunks de
    // uma resposta não pode ficar intercalado dentro dele mesmo) e tira esse
    // trabalho da thread interna do WebRTC.
    private val responseExecutor = Executors.newSingleThreadExecutor()

    init {
        dataChannel.registerObserver(this)
    }

    // --- Envio (com fatiamento + backpressure) ---

    /** Manda todos os chunks de um frame lógico, em ordem. @return false se o canal caiu no meio do envio. */
    private fun sendFrame(type: Int, requestId: Int, header: JSONObject, payload: ByteArray?): Boolean {
        val chunks = WebRtcFrame.chunksFor(type, requestId, header, payload)
        for (chunk in chunks) {
            if (dataChannel.state() != DataChannel.State.OPEN) {
                android.util.Log.w(TAG, "canal com $peerNodeId não está mais OPEN no meio do envio (requestId=$requestId)")
                return false
            }
            waitForBufferedAmountBelowWatermark()
            val sent = try {
                dataChannel.send(DataChannel.Buffer(chunk, true))
            } catch (e: Exception) {
                android.util.Log.w(TAG, "dataChannel.send() lançou exceção mandando chunk pra $peerNodeId (requestId=$requestId): ${e.message}")
                return false
            }
            if (!sent) {
                android.util.Log.w(TAG, "dataChannel.send() retornou false mandando chunk pra $peerNodeId (requestId=$requestId) — canal fechou/buffer recusou no meio do envio")
                return false
            }
        }
        return true
    }

    private fun waitForBufferedAmountBelowWatermark() {
        // Polling simples numa thread que já não é a do WebRTC — mais simples
        // de acertar do que coordenar com onBufferedAmountChange.
        while (dataChannel.bufferedAmount() > BUFFERED_AMOUNT_HIGH_WATERMARK &&
            dataChannel.state() == DataChannel.State.OPEN
        ) {
            try {
                Thread.sleep(BACKPRESSURE_POLL_MS)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
                return
            }
        }
    }

    private fun sendAndAwait(header: JSONObject, payload: ByteArray?): WebRtcFrame.Decoded? {
        if (dataChannel.state() != DataChannel.State.OPEN) return null
        val reqId = nextRequestId.incrementAndGet()
        val queue = ArrayBlockingQueue<WebRtcFrame.Decoded>(1)
        pending[reqId] = queue
        try {
            val sent = sendFrame(WebRtcFrame.TYPE_REQUEST, reqId, header, payload)
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
        try { dataChannel.unregisterObserver() } catch (e: Exception) { android.util.Log.w(TAG, "erro fechando observer com $peerNodeId: ${e.message}") }
        try { dataChannel.close() } catch (e: Exception) { android.util.Log.w(TAG, "erro fechando data channel com $peerNodeId: ${e.message}") }
        pending.clear()
        reassembler.clear()
        responseExecutor.shutdownNow()
    }

    // --- Recebimento (remontagem de chunks) ---

    override fun onMessage(buffer: DataChannel.Buffer) {
        val chunk = try {
            WebRtcFrame.decodeChunk(buffer.data)
        } catch (e: Exception) {
            android.util.Log.w(TAG, "chunk ilegível de $peerNodeId, descartando: ${e.message}")
            return
        }
        val decoded = try {
            reassembler.accept(chunk)
        } catch (e: Exception) {
            android.util.Log.w(TAG, "falha remontando frame de $peerNodeId (requestId=${chunk.requestId}): ${e.message}")
            return
        } ?: return // frame ainda incompleto, esperando mais chunks

        if (decoded.type == WebRtcFrame.TYPE_RESPONSE) {
            pending[decoded.requestId]?.offer(decoded)
        } else {
            handleIncomingRequest(decoded)
        }
    }

    private fun handleIncomingRequest(decoded: WebRtcFrame.Decoded) {
        val (respHeader, respPayload) = try {
            requestHandler.handle(decoded.header, decoded.payload)
        } catch (e: Exception) {
            android.util.Log.w(TAG, "requestHandler.handle() lançou erro processando pedido de $peerNodeId (op=${decoded.header.optString("op")}): ${e.message}")
            JSONObject().put("ok", false).put("error", e.message ?: "erro") to null
        }
        responseExecutor.execute {
            val ok = sendFrame(WebRtcFrame.TYPE_RESPONSE, decoded.requestId, respHeader, respPayload)
            if (!ok) {
                android.util.Log.w(TAG, "resposta pra $peerNodeId (requestId=${decoded.requestId}) NÃO foi entregue por completo — canal deve ter caído no meio do envio")
            }
        }
    }

    override fun onBufferedAmountChange(previousAmount: Long) {}

    override fun onStateChange() {}
}
