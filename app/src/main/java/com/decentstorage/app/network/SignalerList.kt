package com.decentstorage.app.network.webrtc

import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** Onde guardar o que foi aprendido (SharedPreferences, arquivo...). Opcional. */
interface SignalerStorage {
    fun load(): String?
    fun save(json: String)
}

/**
 * De onde o cliente sabe QUAIS signalers existem. Ordem final (igual pra todo
 * mundo, o que maximiza a chance de dois peers caírem no MESMO signaler):
 *   1) seeds embutidos  2) listas remotas (GitHub, site próprio...)  3) aprendidos
 * Aprendidos (anunciados por outros signalers) entram só no fim, com teto — um
 * signaler malicioso consegue sugerir candidatos, não expulsar os seus.
 *
 * allowInsecure=false por padrão: o app tem usesCleartextTraffic="false", então
 * ws:// nunca conectaria e só ocuparia um dos slots.
 */
class SignalerList(
    seeds: List<String> = DEFAULT_SEEDS,
    private val remoteLists: List<String> = DEFAULT_REMOTE_LISTS,
    private val allowInsecure: Boolean = false,
    private val maxLearned: Int = 5,
    private val storage: SignalerStorage? = null
) {
    companion object {
        val DEFAULT_SEEDS = listOf("wss://signal.vagalun.shop")
        val DEFAULT_REMOTE_LISTS = listOf(
            "https://raw.githubusercontent.com/riquelima805/adla-nft-market/refs/heads/main/reley.json"
        )

        fun normalize(u: String?): String? {
            var s = u?.trim().orEmpty()
            if (s.isEmpty()) return null
            if (s.startsWith("https://")) s = "wss://" + s.removePrefix("https://")
            else if (s.startsWith("http://")) s = "ws://" + s.removePrefix("http://")
            if (!Regex("^wss?://[^\\s/]+.*").matches(s)) return null
            return s.trimEnd('/')
        }
    }

    private val lock = Any()
    private val seedUrls = seeds.mapNotNull { normalize(it) }
    private var remote: List<String> = emptyList()
    private var learned: List<String> = emptyList()

    /** Chamado (em qualquer thread) quando a lista efetiva muda. */
    @Volatile var onChange: (() -> Unit)? = null

    private val http = OkHttpClient.Builder()
        .connectTimeout(6, TimeUnit.SECONDS)
        .readTimeout(6, TimeUnit.SECONDS)
        .build()

    init {
        try {
            val raw = storage?.load()
            if (!raw.isNullOrBlank()) {
                val o = JSONObject(raw)
                remote = o.optJSONArray("remote").toUrlList()
                learned = o.optJSONArray("learned").toUrlList().take(maxLearned)
            }
        } catch (_: Exception) { /* storage corrompido: segue só com seeds */ }
    }

    private fun JSONArray?.toUrlList(): List<String> {
        if (this == null) return emptyList()
        return (0 until length()).mapNotNull { normalize(optString(it)) }
    }

    private fun ok(u: String) = allowInsecure || u.startsWith("wss://")

    /** Lista final, ordenada e sem duplicatas. */
    fun urls(): List<String> = synchronized(lock) {
        (seedUrls + remote + learned).filter { ok(it) }.distinct()
    }

    private fun persistAndNotify() {
        try {
            val o = JSONObject()
                .put("remote", JSONArray(synchronized(lock) { remote }))
                .put("learned", JSONArray(synchronized(lock) { learned }))
            storage?.save(o.toString())
        } catch (_: Exception) { }
        onChange?.invoke()
    }

    /** Signalers anunciados por outro signaler (msg "signalers"). Só acrescenta, com teto. */
    fun addLearned(raw: List<String>) {
        var added = false
        synchronized(lock) {
            val known = (seedUrls + remote + learned).toMutableSet()
            val next = learned.toMutableList()
            for (r in raw) {
                val u = normalize(r) ?: continue
                if (!ok(u) || u in known) continue
                if (next.size >= maxLearned) break
                next.add(u); known.add(u); added = true
            }
            learned = next
        }
        if (added) persistAndNotify()
    }

    /**
     * Busca todas as listas remotas (bloqueante — chame fora da main thread).
     * Aceita o formato antigo {"signalingUrl"|"url"|"wss"} e o novo {"signalers":[...]}.
     * Falha de uma fonte não afeta as outras.
     */
    fun refreshRemote() {
        val found = LinkedHashSet<String>()
        for (url in remoteLists) {
            try {
                http.newCall(Request.Builder().url(url).build()).execute().use { resp ->
                    if (!resp.isSuccessful) return@use
                    val body = resp.body?.string()?.trim().orEmpty()
                    val json = JSONObject(body)
                    json.optJSONArray("signalers").toUrlList().forEach { found.add(it) }
                    for (k in listOf("signalingUrl", "url", "wss")) normalize(json.optString(k, ""))?.let { found.add(it) }
                }
            } catch (_: Exception) { }
        }
        if (found.isEmpty()) return
        val changed = synchronized(lock) {
            val next = found.toList()
            if (next == remote) false else { remote = next; true }
        }
        if (changed) persistAndNotify()
    }
}
