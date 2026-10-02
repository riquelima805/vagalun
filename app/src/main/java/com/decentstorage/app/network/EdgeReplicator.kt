package com.decentstorage.app.network

import com.decentstorage.app.network.webrtc.RelayTransport
import org.json.JSONObject
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Réplica de borda peer a peer.
 *
 * O gateway (sever/gateway/edge.js) manda ao celular ALVO:
 *   { op: "replicate_from", source: "<nodeId do celular de origem>",
 *     blocks: [ { shardKey, shardSize, shardHash }, ... ] }
 *
 * O alvo baixa cada bloco direto da origem (WebRTC; se o WebRTC não abriu, o registry já
 * deixou um RelayTransport no lugar — ver scheduleRelayFallback em MainActivity), confere o
 * sha256 contra o shardHash do publish e grava com handlePut (mesma cota/espaço de qualquer
 * put). Se qualquer bloco falhar, apaga o que já gravou e responde ok=false com um `code`.
 *
 * Roda numa thread própria e responde quando termina: o gateway espera a resposta (timeout
 * dele é 120 s por padrão). NÃO pode rodar na thread do WebSocket do signaling, porque o
 * RelayTransport espera respostas chegarem justamente por essa thread.
 *
 * Códigos de erro: bad_request, too_big, busy, no_channel, source_failed, hash_mismatch,
 * put_refused, exception.
 */
class EdgeReplicator(
    private val registryProvider: () -> GossipRegistry?,
    private val handler: ShardRequestHandler,
    private val maxTotalBytes: Long = 64L * 1024 * 1024,
    private val log: (String) -> Unit = {}
) {
    companion object {
        const val OP = "replicate_from"
    }

    private val executor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "edge-replicator").apply { isDaemon = true }
    }
    private val busy = AtomicBoolean(false)

    /** Retorna na hora; `reply` é chamado depois, de outra thread, com o resultado. */
    fun handleAsync(header: JSONObject, reply: (JSONObject, ByteArray?) -> Unit) {
        if (!busy.compareAndSet(false, true)) {
            reply(err("busy", "já estou replicando outro arquivo"), null)
            return
        }
        try {
            executor.execute {
                val result = try {
                    run(header)
                } catch (e: Throwable) {
                    err("exception", e.message ?: e.javaClass.simpleName)
                } finally {
                    busy.set(false)
                }
                try { reply(result, null) } catch (_: Exception) {}
            }
        } catch (e: Exception) {
            busy.set(false)
            reply(err("exception", e.message ?: "executor recusou"), null)
        }
    }

    private fun run(h: JSONObject): JSONObject {
        val source = h.optString("source")
        val blocks = h.optJSONArray("blocks")
        if (source.isBlank() || blocks == null || blocks.length() == 0) {
            return err("bad_request", "faltou source ou blocks")
        }

        var total = 0L
        for (i in 0 until blocks.length()) total += blocks.getJSONObject(i).optLong("shardSize", 0L)
        if (total <= 0L || total > maxTotalBytes) return err("too_big", "tamanho total inválido ($total bytes)")

        // Só usa canal que já está aberto (WebRTC ou relay). `peer.transport` cairia num
        // TcpTransport com host "webrtc:..." e ficaria tentando conectar à toa.
        val peer = registryProvider()?.knownPeers()?.firstOrNull { it.nodeId == source }
        val transport = peer?.webrtcTransport
            ?: return err("no_channel", "sem canal aberto com a origem $source")
        val via = if (transport is RelayTransport) "relay" else "webrtc"

        val stored = mutableListOf<String>()
        try {
            for (i in 0 until blocks.length()) {
                val b = blocks.getJSONObject(i)
                val key = b.getString("shardKey")
                val wantHash = b.getString("shardHash").lowercase()

                val data = transport.getShard(key)
                    ?: return rollback(stored, "source_failed", "a origem não devolveu o bloco $key")
                if (sha256Hex(data) != wantHash) {
                    return rollback(stored, "hash_mismatch", "bloco $key não bate com o hash do publish")
                }

                val r = handler.handlePut(key, data)
                if (!r.optBoolean("ok", false)) {
                    return rollback(stored, "put_refused", r.optString("error", "put recusado"))
                }
                stored.add(key)
            }
        } catch (e: Exception) {
            return rollback(stored, "exception", e.message ?: e.javaClass.simpleName)
        }

        log("Réplica de borda: ${stored.size} bloco(s) copiados de $source via $via")
        return JSONObject().put("ok", true).put("blocks", stored.size).put("via", via)
    }

    private fun rollback(stored: List<String>, code: String, msg: String): JSONObject {
        for (k in stored) {
            try { handler.handleDelete(k) } catch (_: Exception) {}
        }
        log("Réplica de borda falhou ($code): $msg")
        return err(code, msg)
    }

    private fun err(code: String, msg: String): JSONObject =
        JSONObject().put("ok", false).put("code", code).put("error", msg)

    private fun sha256Hex(data: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it) }
}
