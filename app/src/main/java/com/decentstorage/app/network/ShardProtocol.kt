package com.decentstorage.app.network

import org.json.JSONObject
import java.io.DataInputStream
import java.io.DataOutputStream
import java.nio.charset.StandardCharsets


object ShardProtocol {

    fun writeFrame(out: DataOutputStream, bytes: ByteArray) {
        out.writeInt(bytes.size)
        out.write(bytes)
        out.flush()
    }

    fun writeJson(out: DataOutputStream, json: JSONObject) {
        writeFrame(out, json.toString().toByteArray(StandardCharsets.UTF_8))
    }

    fun readFrame(input: DataInputStream, maxSize: Int = 64 * 1024 * 1024): ByteArray {
        val size = input.readInt()
        require(size in 0..maxSize) { "frame de tamanho inválido: $size" }
        val buf = ByteArray(size)
        input.readFully(buf)
        return buf
    }

    fun readJson(input: DataInputStream): JSONObject {
        val bytes = readFrame(input, maxSize = 1024 * 1024)
        return JSONObject(String(bytes, StandardCharsets.UTF_8))
    }
}
