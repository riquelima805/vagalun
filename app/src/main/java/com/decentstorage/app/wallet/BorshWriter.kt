package com.decentstorage.app.wallet

import java.io.ByteArrayOutputStream

/**
 * Serializador Borsh mínimo — só os tipos que os argumentos das instruções do programa
 * Anchor `storage_market` usam: u8, u32, u64, bytes/arrays de tamanho fixo (ex: [u8;32])
 * e Vec<[u8;32]> (o `merkle_proof`). Borsh é sempre little-endian; arrays de tamanho fixo
 * NÃO levam prefixo de tamanho, só Vec leva (u32 LE com a contagem, na frente dos elementos).
 *
 * Não é um serializador Borsh genérico — se o contrato ganhar um argumento de outro tipo
 * (i64, String, Option<T>, struct aninhada etc.) precisa adicionar o método aqui.
 */
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

    /** Bytes/array de tamanho fixo do Borsh ([u8;32] etc) — grava cru, sem prefixo de tamanho. */
    fun writeFixedBytes(bytes: ByteArray): BorshWriter {
        out.write(bytes)
        return this
    }

    /**
     * Vec<[u8;32]> — prefixo u32 LE com a contagem de elementos, seguido de cada elemento
     * cru (sem prefixo individual, já que cada um tem tamanho fixo conhecido). Usado pro
     * `merkle_proof: Vec<[u8;32]>` em submit_paid_claim / report_free_tier_proof.
     */
    fun writeVecOfFixedBytes(items: List<ByteArray>): BorshWriter {
        writeU32(items.size)
        for (item in items) writeFixedBytes(item)
        return this
    }

    fun toByteArray(): ByteArray = out.toByteArray()
}
