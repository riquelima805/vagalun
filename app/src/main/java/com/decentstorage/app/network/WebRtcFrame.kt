package com.decentstorage.app.network.webrtc

import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets


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
        val bb = buffer.duplicate() 
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
