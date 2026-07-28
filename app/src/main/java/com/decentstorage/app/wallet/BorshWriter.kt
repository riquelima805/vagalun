package com.decentstorage.app.wallet

import java.io.ByteArrayOutputStream


class BorshWriter {
    private val out = ByteArrayOutputStream()

    fun writeU8(value: Int): BorshWriter {
        require(value in 0..255) { "u8 fora do intervalo (0-255): $value" }
        out.write(value)
        return this
    }

    fun writeU32(value: Int): BorshWriter {
        require(value >= 0) { "u32 não pode ser negativo: $value" }
        for (i in 0 until 4) out.write((value ushr (8 * i)) and 0xFF)
        return this
    }

    fun writeU64(value: Long): BorshWriter {
        require(value >= 0) { "u64 não pode ser negativo: $value" }
        for (i in 0 until 8) out.write(((value ushr (8 * i)) and 0xFF).toInt())
        return this
    }

   
    fun writeFixedBytes(bytes: ByteArray): BorshWriter {
        out.write(bytes)
        return this
    }

   
    fun writeVecOfFixedBytes(items: List<ByteArray>): BorshWriter {
        writeU32(items.size)
        for (item in items) writeFixedBytes(item)
        return this
    }

    fun toByteArray(): ByteArray = out.toByteArray()
}
