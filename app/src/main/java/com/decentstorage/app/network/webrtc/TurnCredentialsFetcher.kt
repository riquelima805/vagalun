package com.decentstorage.app.network.webrtc

import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.webrtc.PeerConnection
import java.util.concurrent.TimeUnit

/**
 * Busca a lista de ICE servers (STUN + TURN) no seu próprio signaling server,
 * que por sua vez guarda a API key da Metered e faz o proxy.
 *
 * Nunca chame a Metered direto daqui com a API key embutida no app —
 * qualquer um decompila o APK e rouba a key.
 */
object TurnCredentialsFetcher {

    private val client = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .build()

    /**
     * @param signalingHttpUrl algo como "http://seuservidor.com:8787/ice-servers"
     *        (mesma máquina do seu wss://, só que em http:// e path /ice-servers)
     */
    fun fetch(signalingHttpUrl: String): List<PeerConnection.IceServer> {
        val request = Request.Builder().url(signalingHttpUrl).build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                throw IllegalStateException("servidor respondeu ${response.code} ao buscar ICE servers")
            }
            val body = response.body?.string() ?: throw IllegalStateException("resposta vazia do servidor")
            return parseIceServers(body)
        }
    }

    private fun parseIceServers(json: String): List<PeerConnection.IceServer> {
        val arr = JSONArray(json)
        val servers = mutableListOf<PeerConnection.IceServer>()
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            val urls = o.getString("urls")
            val builder = PeerConnection.IceServer.builder(urls)
            if (o.has("username") && !o.isNull("username")) builder.setUsername(o.getString("username"))
            if (o.has("credential") && !o.isNull("credential")) builder.setPassword(o.getString("credential"))
            servers.add(builder.createIceServer())
        }
        return servers
    }
}
