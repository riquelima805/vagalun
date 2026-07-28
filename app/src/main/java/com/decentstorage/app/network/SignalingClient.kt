package com.decentstorage.app.network.webrtc

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
                    "error" -> {  }
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

    fun disconnect() {
        webSocket?.close(1000, "bye")
        client.dispatcher.executorService.shutdown()
    }
}
