package com.decentstorage.app.erasure

import kotlin.math.ceil

/**
 * Reed-Solomon sistemático: dado K shards de dados, gera M shards de paridade,
 * totalizando N = K + M shards. QUALQUER K dos N shards reconstroem o arquivo original.
 * Port direto de reedSolomon.js.
 */

data class EncodedShards(
    val shards: List<ByteArray>,
    val originalLength: Int,
    val shardSize: Int,
    val k: Int,
    val m: Int,
    val n: Int
)

data class AvailableShard(val index: Int, val data: ByteArray)

object ReedSolomon {

    private fun buildEncodingMatrix(k: Int, n: Int): Array<IntArray> {
        val vander = Array(n) { r -> IntArray(k) { c -> GF256.pow(r + 1, c) } }
        val top = Array(k) { i -> vander[i] }
        val topInv = invertMatrix(top)
        return Array(n) { r -> multiplyRowByMatrix(vander[r], topInv, k) }
    }

    private fun multiplyRowByMatrix(row: IntArray, matrix: Array<IntArray>, k: Int): IntArray {
        val result = IntArray(k)
        for (c in 0 until k) {
            var sum = 0
            for (i in 0 until k) sum = sum xor GF256.mul(row[i], matrix[i][c])
            result[c] = sum
        }
        return result
    }

    private fun invertMatrix(matrix: Array<IntArray>): Array<IntArray> {
        val n = matrix.size
        val aug = Array(n) { i ->
            IntArray(2 * n).also { row ->
                for (c in 0 until n) row[c] = matrix[i][c]
                row[n + i] = 1
            }
        }
        for (col in 0 until n) {
            var pivotRow = -1
            for (r in col until n) {
                if (aug[r][col] != 0) { pivotRow = r; break }
            }
            require(pivotRow != -1) { "Matriz singular — não é invertível (shards insuficientes ou combinação inválida)" }
            val tmp = aug[col]; aug[col] = aug[pivotRow]; aug[pivotRow] = tmp

            val invVal = GF256.inv(aug[col][col])
            for (c in 0 until 2 * n) aug[col][c] = GF256.mul(aug[col][c], invVal)

            for (r in 0 until n) {
                if (r == col) continue
                val factor = aug[r][col]
                if (factor == 0) continue
                for (c in 0 until 2 * n) aug[r][c] = aug[r][c] xor GF256.mul(factor, aug[col][c])
            }
        }
        return Array(n) { i -> aug[i].copyOfRange(n, 2 * n) }
    }

    /** Divide um ByteArray em K shards de dados + M shards de paridade. */
    fun encode(buffer: ByteArray, k: Int, m: Int): EncodedShards {
        val n = k + m
        val shardSize = ceil(buffer.size.toDouble() / k).toInt()
        val dataShards = Array(k) { i ->
            val shard = ByteArray(shardSize)
            val start = i * shardSize
            val end = minOf((i + 1) * shardSize, buffer.size)
            if (start < buffer.size) System.arraycopy(buffer, start, shard, 0, end - start)
            shard
        }

        val matrix = buildEncodingMatrix(k, n)
        val allShards = ArrayList<ByteArray>(n)
        for (row in 0 until n) {
            val out = ByteArray(shardSize)
            for (byteIdx in 0 until shardSize) {
                var sum = 0
                for (col in 0 until k) {
                    sum = sum xor GF256.mul(matrix[row][col], dataShards[col][byteIdx].toInt() and 0xFF)
                }
                out[byteIdx] = sum.toByte()
            }
            allShards.add(out)
        }
        return EncodedShards(allShards, buffer.size, shardSize, k, m, n)
    }

    /**
     * Reconstrói o buffer original a partir de QUALQUER K shards disponíveis.
     * `available` precisa ter pelo menos K entradas.
     */
    fun decode(available: List<AvailableShard>, originalLength: Int, shardSize: Int, k: Int, m: Int): ByteArray {
        val n = k + m
        require(available.size >= k) { "Shards insuficientes: precisa de $k, disponível ${available.size}" }
        val chosen = available.sortedBy { it.index }.take(k)
        val matrix = buildEncodingMatrix(k, n)
        val subMatrix = Array(k) { i -> matrix[chosen[i].index] }
        val inv = invertMatrix(subMatrix)

        val dataShards = ArrayList<ByteArray>(k)
        for (row in 0 until k) {
            val out = ByteArray(shardSize)
            for (byteIdx in 0 until shardSize) {
                var sum = 0
                for (col in 0 until k) {
                    sum = sum xor GF256.mul(inv[row][col], chosen[col].data[byteIdx].toInt() and 0xFF)
                }
                out[byteIdx] = sum.toByte()
            }
            dataShards.add(out)
        }
        val full = ByteArray(k * shardSize)
        var offset = 0
        for (s in dataShards) { System.arraycopy(s, 0, full, offset, s.size); offset += s.size }
        return full.copyOfRange(0, originalLength)
    }
}
