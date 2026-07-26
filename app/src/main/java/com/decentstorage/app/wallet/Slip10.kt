package com.decentstorage.app.wallet

import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Derivação hierárquica SLIP-0010 para curva Ed25519 (só suporta índices "hardened",
 * que é o único modo válido em ed25519 — exatamente o que carteiras Solana usam).
 * Path padrão usado pelo Phantom/Solflare e por praticamente toda carteira Solana:
 *   m/44'/501'/0'/0'
 *
 * Referência do algoritmo: https://github.com/satoshilabs/slips/blob/master/slip-0010.md
 */
object Slip10 {

    data class Node(val key: ByteArray, val chainCode: ByteArray)

    private fun hmacSha512(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA512")
        mac.init(SecretKeySpec(key, "HmacSHA512"))
        return mac.doFinal(data)
    }

    fun masterNode(seed: ByteArray): Node {
        val i = hmacSha512("ed25519 seed".toByteArray(Charsets.UTF_8), seed)
        return Node(key = i.copyOfRange(0, 32), chainCode = i.copyOfRange(32, 64))
    }

    /** Deriva um filho "hardened" (índice já deve vir sem o offset 0x80000000). */
    fun deriveHardened(parent: Node, index: Int): Node {
        val indexBytes = intToBigEndian(index or -0x80000000) // seta o bit hardened (0x80000000)
        val data = ByteArray(1 + 32 + 4)
        data[0] = 0x00
        System.arraycopy(parent.key, 0, data, 1, 32)
        System.arraycopy(indexBytes, 0, data, 33, 4)
        val i = hmacSha512(parent.chainCode, data)
        return Node(key = i.copyOfRange(0, 32), chainCode = i.copyOfRange(32, 64))
    }

    private fun intToBigEndian(value: Int): ByteArray = byteArrayOf(
        (value ushr 24).toByte(),
        (value ushr 16).toByte(),
        (value ushr 8).toByte(),
        value.toByte()
    )

    /** Deriva a seed de 32 bytes para o path Solana padrão m/44'/501'/account'/0' */
    fun deriveSolanaSeed(seed64: ByteArray, account: Int = 0): ByteArray {
        var node = masterNode(seed64)
        node = deriveHardened(node, 44)
        node = deriveHardened(node, 501)
        node = deriveHardened(node, account)
        node = deriveHardened(node, 0)
        return node.key
    }
}
