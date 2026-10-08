package com.decentstorage.app.wallet

import java.math.BigInteger
import java.security.MessageDigest

object PdaUtils {

   
    private val P: BigInteger = BigInteger.valueOf(2L).pow(255).subtract(BigInteger.valueOf(19))

    private val D: BigInteger by lazy {
        val numerator = BigInteger.valueOf(-121665).mod(P)
        val denominatorInv = BigInteger.valueOf(121666).modInverse(P)
        numerator.multiply(denominatorInv).mod(P)
    }

    
    private val SQRT_MINUS_ONE: BigInteger by lazy {
        BigInteger.valueOf(2L).modPow(P.subtract(BigInteger.ONE).divide(BigInteger.valueOf(4)), P)
    }

    private fun sha256(): MessageDigest = MessageDigest.getInstance("SHA-256")

    private fun leBytesToBigInt(bytes: ByteArray): BigInteger {
        return BigInteger(1, bytes.reversedArray())
    }

    fun isOnCurve(pointBytes32: ByteArray): Boolean {
        require(pointBytes32.size == 32) { "ponto precisa ter 32 bytes" }

        val signBit = (pointBytes32[31].toInt() ushr 7) and 1
        val yBytes = pointBytes32.copyOf()
        yBytes[31] = (yBytes[31].toInt() and 0x7F).toByte() // limpa o bit de sinal pra pegar y puro
        val y = leBytesToBigInt(yBytes).mod(P)

        val y2 = y.multiply(y).mod(P)
        val u = y2.subtract(BigInteger.ONE).mod(P)
        val v = D.multiply(y2).add(BigInteger.ONE).mod(P)

        val vInv = try {
            v.modInverse(P)
        } catch (e: ArithmeticException) {
            return false 
        }
        val x2 = u.multiply(vInv).mod(P)

        if (x2 == BigInteger.ZERO) {
            return signBit == 0
        }

        var x = x2.modPow(P.add(BigInteger.valueOf(3)).divide(BigInteger.valueOf(8)), P)
        if (x.multiply(x).mod(P) != x2) {
            x = x.multiply(SQRT_MINUS_ONE).mod(P)
        }
        if (x.multiply(x).mod(P) != x2) {
            return false 
        }

        if (x.testBit(0) != (signBit == 1)) {
            x = P.subtract(x).mod(P)
        }

        val x2Final = x.multiply(x).mod(P)
        val lhs = P.subtract(x2Final).add(y2).mod(P)
        val rhs = BigInteger.ONE.add(D.multiply(x2Final).multiply(y2)).mod(P)
        return lhs == rhs
    }

    fun findProgramAddress(seeds: List<ByteArray>, programId: ByteArray): Pair<ByteArray, Int> {
        require(seeds.size <= 16) { "Solana permite no máximo 16 seeds por PDA" }
        for (seed in seeds) require(seed.size <= 32) { "cada seed deve ter no máximo 32 bytes" }

        val marker = "ProgramDerivedAddress".toByteArray(Charsets.UTF_8)

        for (bump in 255 downTo 0) {
            val digest = sha256()
            for (seed in seeds) digest.update(seed)
            digest.update(byteArrayOf(bump.toByte()))
            digest.update(programId)
            digest.update(marker)
            val candidate = digest.digest()

            if (!isOnCurve(candidate)) {
                return candidate to bump
            }
        }
        throw IllegalStateException(
            "não foi possível achar uma PDA válida pra essas seeds (bump esgotado) — " +
                "extremamente improvável; confira se as seeds estão certas"
        )
    }

    fun instructionDiscriminator(instructionName: String): ByteArray =
        sha256().digest("global:$instructionName".toByteArray(Charsets.UTF_8)).copyOfRange(0, 8)

    fun accountDiscriminator(accountTypeName: String): ByteArray =
        sha256().digest("account:$accountTypeName".toByteArray(Charsets.UTF_8)).copyOfRange(0, 8)

    fun fileIdHexToBytes32(hex: String): ByteArray {
        val clean = hex.trim().removePrefix("0x")
        require(clean.length == 64) {
            "file_id precisa ser hex de 64 caracteres (32 bytes) — recebido: ${clean.length} chars"
        }
        val bytes = ByteArray(32)
        for (i in 0 until 32) {
            bytes[i] = clean.substring(i * 2, i * 2 + 2).toInt(16).toByte()
        }
        return bytes
    }
}
