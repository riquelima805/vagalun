package com.decentstorage.app.network.webrtc

import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets

/**
 * TCP dá um stream contínuo, então o ShardProtocol original manda o header JSON e o
 * payload binário como duas escritas separadas (readFully cuida de remontar). Um
 * DataChannel WebRTC não é um stream — cada `send()` chega inteiro ou não chega, como
 * uma mensagem única. Por isso aqui vai tudo (tipo + id de correlação + header + payload)
 * numa frame só:
 *
 *   [1 byte tipo: 0=request, 1=response]
 *   [4 bytes requestId, big-endian]
 *   [4 bytes tamanho do header JSON, big-endian]
 *   [header JSON em UTF-8]
 *   [payload binário (o resto da mensagem, pode ter tamanho 0)]
 *
 * O requestId existe porque o mesmo DataChannel é usado nas DUAS direções ao mesmo tempo
 * (eu posso pedir um shard pro peer enquanto ele me pede outro shard de volta) — sem id
 * não dá pra saber qual resposta é de qual pedido.
 */
object WebRtcFrame {
    const val TYPE_REQUEST = 0
    const val TYPE_RESPONSE = 1

    data class Decoded(val type: Int, val requestId: Int, val header: JSONObject, val payload: ByteArray?)

    fun encode(type: Int, requestId: Int, header: JSONObject, payload: ByteArray?): ByteBuffer {
        val headerBytes = header.toString().toByteArray(StandardCharsets.UTF_8)
        val payloadBytes = payload ?: ByteArray(0)
        val buf = ByteBuffer.allocate(1 + 4 + 4 + headerBytes.size + payloadBytes.size)
        buf.put(type.toByte())
        buf.putInt(requestId)
        buf.putInt(headerBytes.size)
        buf.put(headerBytes)
        buf.put(payloadBytes)
        buf.flip()
        return buf
    }

    fun decode(buffer: ByteBuffer): Decoded {
        val bb = buffer.duplicate() // não consome o buffer original, o WebRTC-SDK pode reusar
        val type = bb.get().toInt()
        val requestId = bb.int
        val headerLen = bb.int
        require(headerLen in 0..(4 * 1024 * 1024)) { "header de tamanho inválido: $headerLen" }
        val headerBytes = ByteArray(headerLen)
        bb.get(headerBytes)
        val payloadLen = bb.remaining()
        val payload = if (payloadLen > 0) ByteArray(payloadLen).also { bb.get(it) } else null
        return Decoded(type, requestId, JSONObject(String(headerBytes, StandardCharsets.UTF_8)), payload)
    }
}
