package com.decentstorage.app.network.webrtc

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Conexão com o signaling server — só troca SDP/ICE (texto, poucos KB), nunca bytes de
 * arquivo. A URL é configurável: qualquer instância do server.js (signaling-server/)
 * serve, não precisa ser uma infra específica de uma empresa.
 */
class SignalingClient(
    private val serverUrl: String, // ex: "wss://seu-signaling.exemplo.com" ou "ws://192.168.0.10:8787" pra testar local
    private val selfNodeId: String,
    // var (não val): permite plugar o handler depois de construir, pra resolver o ciclo
    // SignalingClient <-> WebRtcManager (o Manager precisa de um SignalingClient já pronto,
    // mas o handler de sinal dele só existe depois que o Manager foi criado). Ver README.
    var onSignal: (fromNodeId: String, payload: JSONObject) -> Unit,
    private val onStateChange: ((connected: Boolean) -> Unit)? = null
) {
    private var webSocket: WebSocket? = null
    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS) // mantém a conexão viva atrás de NAT/proxies
        .build()

    fun connect() {
        val request = Request.Builder().url(serverUrl).build()
        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(JSONObject().put("type", "register").put("nodeId", selfNodeId).toString())
                onStateChange?.invoke(true)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val msg = JSONObject(text)
                when (msg.optString("type")) {
                    "signal" -> onSignal(msg.getString("from"), msg.getJSONObject("payload"))
                    "error" -> { /* peer offline, etc — o chamador decide o que fazer (retry, avisar usuário) */ }
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                onStateChange?.invoke(false)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                onStateChange?.invoke(false)
            }
        })
    }

    /** Envia um SDP offer/answer ou candidato ICE pro nó de destino, via relay do signaling. */
    fun sendSignal(toNodeId: String, payload: JSONObject) {
        webSocket?.send(
            JSONObject()
                .put("type", "signal")
                .put("to", toNodeId)
                .put("from", selfNodeId)
                .put("payload", payload)
                .toString()
        )
    }

    fun disconnect() {
        webSocket?.close(1000, "bye")
        client.dispatcher.executorService.shutdown()
    }
}
