package com.decentstorage.app.network.webrtc

import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.util.concurrent.ConcurrentHashMap

/**
 * Protocolo binário do data channel WebRTC. Mesmo layout tem que existir
 * nos dois lados — aqui (node Android) e em src/p2p/shardFrame.js (player
 * web) — qualquer mudança aqui precisa ser espelhada lá, senão os dois
 * param de se entender.
 *
 * FIX (chunking): antes cada frame lógico (header JSON + payload binário —
 * ex.: um shard inteiro, até `DEFAULT_BLOCK_SIZE / k` bytes, ver
 * StorageClient.kt, ou seja, facilmente várias centenas de KB) virava UMA
 * ÚNICA mensagem SCTP no data channel via `dataChannel.send()`. Isso podia
 * estourar o limite de tamanho de mensagem do canal (negociado por SDP,
 * varia por peer/versão de WebRTC, nem sempre dá pra saber de antemão) e o
 * `send()` falhava — DEPOIS que o node já tinha lido o shard inteiro do
 * disco e montado a resposta. Como esse erro era engolido em silêncio (ver
 * histórico de WebRtcTransport.handleIncomingRequest), o requisitante só
 * via timeout, exatamente como um peer que nunca respondeu — mesmo com o
 * shard existindo e sendo encontrado. Só não acontecia quando a resposta
 * era pequena (ex.: "shard não encontrado"), daí o sintoma de "só falha
 * quando o arquivo existe de verdade".
 *
 * Fix: todo frame lógico agora é fatiado em N mensagens de no máximo
 * [CHUNK_SIZE] bytes cada, remontadas do outro lado por (type, requestId)
 * via [Reassembler]. CHUNK_SIZE é conservador de propósito — bem abaixo de
 * qualquer limite conhecido de implementação de data channel — pra não
 * depender de negociar `max-message-size` no SDP.
 */
object WebRtcFrame {
    const val TYPE_REQUEST = 0
    const val TYPE_RESPONSE = 1

    // 15 KB de conteúdo útil por chunk + 13 bytes de cabeçalho de chunk =
    // 15.373 bytes por mensagem no fio, com folga confortável abaixo de
    // 16 KB (o limite mais restritivo que existe por aí sem negociação de
    // max-message-size). Espelhado em CHUNK_SIZE no shardFrame.js — se
    // mudar aqui, muda lá também.
    const val CHUNK_SIZE = 15 * 1024

    // Cabeçalho de CADA chunk no fio:
    //   [1B msgType][4B requestId][4B chunkIndex][4B totalChunks][4B totalLength][... bytes do chunk]
    private const val CHUNK_HEADER_SIZE = 1 + 4 + 4 + 4 + 4

    data class Decoded(val type: Int, val requestId: Int, val header: JSONObject, val payload: ByteArray?)
    data class ChunkHeader(
        val type: Int,
        val requestId: Int,
        val chunkIndex: Int,
        val totalChunks: Int,
        val totalLength: Int,
        val chunkBytes: ByteArray
    )

    /** Codifica o frame lógico inteiro (header + payload), sem fatiar — usado só por [chunksFor]. */
    private fun encodeInner(header: JSONObject, payload: ByteArray?): ByteArray {
        val headerBytes = header.toString().toByteArray(StandardCharsets.UTF_8)
        val payloadBytes = payload ?: ByteArray(0)
        val buf = ByteBuffer.allocate(4 + headerBytes.size + payloadBytes.size)
        buf.putInt(headerBytes.size)
        buf.put(headerBytes)
        buf.put(payloadBytes)
        return buf.array()
    }

    /**
     * Gera a lista de chunks — já prontos pra `dataChannel.send()`, um de
     * cada vez, NA ORDEM — que representam um frame lógico inteiro. Sempre
     * pelo menos 1 chunk, mesmo pra frames pequenos/vazios: mantém um único
     * caminho de código dos dois lados, sem "caso especial" de mensagem
     * pequena não-fatiada.
     */
    fun chunksFor(type: Int, requestId: Int, header: JSONObject, payload: ByteArray?): List<ByteBuffer> {
        val inner = encodeInner(header, payload)
        val totalLength = inner.size
        val totalChunks = maxOf(1, (totalLength + CHUNK_SIZE - 1) / CHUNK_SIZE)
        val chunks = ArrayList<ByteBuffer>(totalChunks)
        for (i in 0 until totalChunks) {
            val start = i * CHUNK_SIZE
            val end = minOf(start + CHUNK_SIZE, totalLength)
            val chunkLen = end - start
            val buf = ByteBuffer.allocate(CHUNK_HEADER_SIZE + chunkLen)
            buf.put(type.toByte())
            buf.putInt(requestId)
            buf.putInt(i)
            buf.putInt(totalChunks)
            buf.putInt(totalLength)
            if (chunkLen > 0) buf.put(inner, start, chunkLen)
            buf.flip()
            chunks.add(buf)
        }
        return chunks
    }

    fun decodeChunk(buffer: ByteBuffer): ChunkHeader {
        val bb = buffer.duplicate()
        val type = bb.get().toInt()
        val requestId = bb.int
        val chunkIndex = bb.int
        val totalChunks = bb.int
        val totalLength = bb.int
        require(totalChunks in 1..1_000_000) { "totalChunks inválido: $totalChunks" }
        require(totalLength in 0..(256 * 1024 * 1024)) { "totalLength inválido: $totalLength" }
        require(chunkIndex in 0 until totalChunks) { "chunkIndex fora do range: $chunkIndex/$totalChunks" }
        val chunkBytes = ByteArray(bb.remaining())
        bb.get(chunkBytes)
        return ChunkHeader(type, requestId, chunkIndex, totalChunks, totalLength, chunkBytes)
    }

    private fun decodeInner(bytes: ByteArray): Pair<JSONObject, ByteArray?> {
        val bb = ByteBuffer.wrap(bytes)
        val headerLen = bb.int
        require(headerLen in 0..(4 * 1024 * 1024)) { "header de tamanho inválido: $headerLen" }
        val headerBytes = ByteArray(headerLen)
        bb.get(headerBytes)
        val payloadLen = bb.remaining()
        val payload = if (payloadLen > 0) ByteArray(payloadLen).also { bb.get(it) } else null
        return JSONObject(String(headerBytes, StandardCharsets.UTF_8)) to payload
    }

    /**
     * Remonta os chunks recebidos em um [Decoded] só quando o último chunk
     * daquele (type, requestId) chega. Remonta por índice (não por ordem de
     * chegada) — o data channel é `ordered = true` então na prática chega
     * tudo em ordem mesmo, mas isso custa nada e evita corrupção silenciosa
     * se um dia isso mudar. Uma instância por [WebRtcTransport] (por peer).
     */
    class Reassembler {
        private class InProgress(val totalLength: Int, parts: Int) {
            val chunks = arrayOfNulls<ByteArray>(parts)
            var received = 0
        }

        private val inProgress = ConcurrentHashMap<String, InProgress>()

        /** @return o [Decoded] completo quando esse era o último chunk faltando pra esse frame, senão null. */
        fun accept(chunk: ChunkHeader): Decoded? {
            val key = "${chunk.type}:${chunk.requestId}"
            val entry = inProgress.getOrPut(key) { InProgress(chunk.totalLength, chunk.totalChunks) }

            if (chunk.chunkIndex !in entry.chunks.indices) return null // chunk malformado/fora do range — ignora
            if (entry.chunks[chunk.chunkIndex] == null) {
                entry.chunks[chunk.chunkIndex] = chunk.chunkBytes
                entry.received++
            }
            if (entry.received < entry.chunks.size) return null

            inProgress.remove(key)
            val inner = ByteArray(entry.totalLength)
            var offset = 0
            for (part in entry.chunks) {
                part!!.copyInto(inner, offset)
                offset += part.size
            }
            val (header, payload) = decodeInner(inner)
            return Decoded(chunk.type, chunk.requestId, header, payload)
        }

        /** Descarta transferências incompletas — chamar no close() do transport. */
        fun clear() = inProgress.clear()
    }
}
