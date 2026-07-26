package com.decentstorage.app.erasure

/**
 * Aritmética em GF(256) — corpo finito usado pelo Reed-Solomon.
 * Polinômio primitivo: x^8 + x^4 + x^3 + x^2 + 1 (0x11d), gerador = 2.
 * Port direto de gf256.js (mesma tabela, mesmo resultado byte a byte).
 */
object GF256 {
    private val EXP = IntArray(512)
    private val LOG = IntArray(256)

    init {
        var x = 1
        for (i in 0 until 255) {
            EXP[i] = x
            LOG[x] = i
            x = x shl 1
            if (x and 0x100 != 0) x = x xor 0x11d
        }
        for (i in 255 until 512) EXP[i] = EXP[i - 255]
    }

    fun add(a: Int, b: Int): Int = a xor b

    fun mul(a: Int, b: Int): Int {
        if (a == 0 || b == 0) return 0
        return EXP[LOG[a] + LOG[b]]
    }

    fun div(a: Int, b: Int): Int {
        if (a == 0) return 0
        require(b != 0) { "Divisão por zero em GF(256)" }
        return EXP[(LOG[a] - LOG[b] + 255) % 255]
    }

    fun pow(a: Int, n: Int): Int {
        if (n == 0) return 1
        if (a == 0) return 0
        return EXP[(LOG[a] * n) % 255]
    }

    fun inv(a: Int): Int {
        require(a != 0) { "Zero não tem inverso em GF(256)" }
        return EXP[255 - LOG[a]]
    }
}
