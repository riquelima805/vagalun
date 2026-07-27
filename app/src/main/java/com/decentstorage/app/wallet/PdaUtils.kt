package com.decentstorage.app.wallet

import java.math.BigInteger
import java.security.MessageDigest

/**
 * Utilitários pra falar com programas Anchor sem depender de nenhum "Anchor client" oficial
 * pra Kotlin (não existe um pronto pra Android) — só o sol4k, que fala RPC/transação cru.
 *
 * NÃO TESTADO contra a devnet real ainda (sem toolchain Solana disponível neste ambiente
 * de geração de código). A derivação de PDA e o discriminador de instrução seguem
 * exatamente o algoritmo público do Solana/Anchor, mas rode os testes reais (ver
 * AnchorStorageClientDevnetTest, se você pediu esse próximo passo) antes de confiar em
 * valores reais.
 */
object PdaUtils {

    // p = 2^255 - 19 (primo do corpo do Curve25519/Ed25519)
    private val P: BigInteger = BigInteger.TWO.pow(255).subtract(BigInteger.valueOf(19))

    // d = -121665/121666 mod p (constante da curva Edwards usada pelo Ed25519)
    private val D: BigInteger by lazy {
        val numerator = BigInteger.valueOf(-121665).mod(P)
        val denominatorInv = BigInteger.valueOf(121666).modInverse(P)
        numerator.multiply(denominatorInv).mod(P)
    }

    // I = sqrt(-1) mod p = 2^((p-1)/4) mod p — usado no algoritmo de raiz quadrada mod p
    private val SQRT_MINUS_ONE: BigInteger by lazy {
        BigInteger.TWO.modPow(P.subtract(BigInteger.ONE).divide(BigInteger.valueOf(4)), P)
    }

    private fun sha256(): MessageDigest = MessageDigest.getInstance("SHA-256")

    private fun leBytesToBigInt(bytes: ByteArray): BigInteger {
        // ByteArray de um ponto ed25519 vem em little-endian; BigInteger quer big-endian.
        return BigInteger(1, bytes.reversedArray())
    }

    /**
     * Decodifica os 32 bytes como se fossem um ponto Ed25519 comprimido e diz se é um ponto
     * VÁLIDO na curva. Uma PDA precisa cair FORA da curva (isso garante que ninguém tem a
     * chave privada correspondente) — é exatamente o mesmo teste que solana-web3.js/sol4k
     * fazem internamente em `PublicKey.isOnCurve` / `findProgramAddress`.
     */
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
            return false // v == 0, sem inverso -> não dá pra decodificar um x válido
        }
        val x2 = u.multiply(vInv).mod(P)

        if (x2 == BigInteger.ZERO) {
            // x = 0 só é uma decodificação válida se o bit de sinal também for 0
            return signBit == 0
        }

        var x = x2.modPow(P.add(BigInteger.valueOf(3)).divide(BigInteger.valueOf(8)), P)
        if (x.multiply(x).mod(P) != x2) {
            x = x.multiply(SQRT_MINUS_ONE).mod(P)
        }
        if (x.multiply(x).mod(P) != x2) {
            return false // não existe raiz quadrada de x2 mod p -> ponto inválido
        }

        if (x.testBit(0) != (signBit == 1)) {
            x = P.subtract(x).mod(P)
        }

        // confirma a equação da curva com o x final: -x^2 + y^2 == 1 + d*x^2*y^2 (mod p)
        val x2Final = x.multiply(x).mod(P)
        val lhs = P.subtract(x2Final).add(y2).mod(P)
        val rhs = BigInteger.ONE.add(D.multiply(x2Final).multiply(y2)).mod(P)
        return lhs == rhs
    }

    /**
     * Deriva uma Program Derived Address igual ao `PublicKey.findProgramAddressSync` do
     * Solana: concatena seeds + [bump] + programId + "ProgramDerivedAddress", faz sha256,
     * e testa bump de 255 até 0 até achar o primeiro hash que cai FORA da curva ed25519.
     *
     * @return par (endereço de 32 bytes, bump usado)
     */
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

    /** Discriminador de INSTRUÇÃO Anchor: primeiros 8 bytes de sha256("global:<nome_snake_case>"). */
    fun instructionDiscriminator(instructionName: String): ByteArray =
        sha256().digest("global:$instructionName".toByteArray(Charsets.UTF_8)).copyOfRange(0, 8)

    /**
     * Discriminador de CONTA Anchor: primeiros 8 bytes de sha256("account:<NomeDaConta>").
     * Não usado no client hoje (que só ENVIA instruções), mas fica pronto pro dia que
     * formos deserializar contas on-chain direto (ex: ler saldo do FileVault sem depender
     * do que o app já sabe localmente).
     */
    fun accountDiscriminator(accountTypeName: String): ByteArray =
        sha256().digest("account:$accountTypeName".toByteArray(Charsets.UTF_8)).copyOfRange(0, 8)

    /**
     * Converte o hex de 64 caracteres que `KeyManager.fileIdFor` gera (sha256 hex = 32 bytes)
     * pro `[u8; 32]` que o programa Anchor espera como `file_id`/`content_id`.
     */
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
