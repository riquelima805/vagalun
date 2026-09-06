package com.decentstorage.app.wallet

import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec


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

   
    fun deriveHardened(parent: Node, index: Int): Node {
        val indexBytes = intToBigEndian(index or -0x80000000) 
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

   
    fun deriveSolanaSeed(seed64: ByteArray, account: Int = 0): ByteArray {
        var node = masterNode(seed64)
        node = deriveHardened(node, 44)
        node = deriveHardened(node, 501)
        node = deriveHardened(node, account)
        node = deriveHardened(node, 0)
        return node.key
    }
}
