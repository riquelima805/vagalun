package com.decentstorage.app.network.webrtc

import android.util.Base64
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class SignalingClient(
    private val serverUrl: String, 
    private val selfNodeId: String,
    var onSignal: (fromNodeId: String, payload: JSONObject) -> Unit,
    private val onStateChange: ((connected: Boolean) -> Unit)? = null
) {
    private var webSocket: WebSocket? = null
    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS) 
        .build()

    // Callbacks para o Relay
    var onRelayRequest: ((from: String, requestId: Int, header: JSONObject, payload: ByteArray?) -> Unit)? = null
    var onRelayResponse: ((from: String, requestId: Int, header: JSONObject, payload: ByteArray?) -> Unit)? = null

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
                    
                    "relay" -> {
                        val from = msg.getString("from")
                        val reqId = msg.getInt("requestId")
                        val header = msg.getJSONObject("header")
                        val payloadStr = msg.optString("payloadBase64", "")
                        val payload = if (payloadStr.isNotEmpty()) Base64.decode(payloadStr, Base64.DEFAULT) else null
                        
                        onRelayRequest?.invoke(from, reqId, header, payload)
                    }

                    "relay_response" -> {
                        val from = msg.getString("from")
                        val reqId = msg.getInt("requestId")
                        val header = msg.getJSONObject("header")
                        val payloadStr = msg.optString("payloadBase64", "")
                        val payload = if (payloadStr.isNotEmpty()) Base64.decode(payloadStr, Base64.DEFAULT) else null
                        
                        onRelayResponse?.invoke(from, reqId, header, payload)
                    }

                    "error", "relay_error" -> { 
                        // Opcional: Tratar erros como peer_offline para cancelar o timeout mais rápido
                    }
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

    // --- Funções de Envio do Relay ---
    fun sendRelay(toNodeId: String, requestId: Int, header: JSONObject, payload: ByteArray?) {
        val msg = JSONObject()
            .put("type", "relay")
            .put("to", toNodeId)
            .put("requestId", requestId)
            .put("header", header)

        if (payload != null) {
            msg.put("payloadBase64", Base64.encodeToString(payload, Base64.NO_WRAP))
        }
        
        webSocket?.send(msg.toString())
    }

    fun sendRelayResponse(toNodeId: String, requestId: Int, header: JSONObject, payload: ByteArray?) {
        val msg = JSONObject()
            .put("type", "relay_response")
            .put("to", toNodeId)
            .put("requestId", requestId)
            .put("header", header)

        if (payload != null) {
            msg.put("payloadBase64", Base64.encodeToString(payload, Base64.NO_WRAP))
        }
        
        webSocket?.send(msg.toString())
    }

    fun disconnect() {
        webSocket?.close(1000, "bye")
        client.dispatcher.executorService.shutdown()
    }
}
