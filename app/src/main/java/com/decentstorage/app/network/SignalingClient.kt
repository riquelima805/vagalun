package com.decentstorage.app.network.webrtc

import android.util.Base64
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import kotlin.math.min

/**
 * SignalingClient FEDERADO. Mesma API pública do antigo (serve app-node e
 * browser: connect/disconnect/sendSignal/sendRelay/sendRelayResponse + callbacks
 * onSignal, onPeerList, onPeerJoined, onPeerLeft, onRelayRequest,
 * onRelayResponse, onError, onStateChange), então WebRtcManager/RelayTransport
 * não mudam.
 *
 * Por baixo:
 *  - mantém até [maxActive] conexões AO MESMO TEMPO, pegando os primeiros
 *    signalers saudáveis da lista (mesma ordem pra todos => overlap de peers);
 *  - link caiu -> backoff nele e promove o próximo da lista;
 *  - signal vai por todos os links que conhecem o destino; o receptor deduplica
 *    por "_mid";
 *  - relay vai por UM link e tenta outro se vier relay_error;
 *  - peers = união dos links. onPeerLeft só dispara quando NENHUM link vê o peer.
 *    Queda de link NÃO gera onPeerLeft (canal WebRTC já aberto não depende dele).
 *
 * NÃO COMPILADO AQUI (sem Android SDK no ambiente) — revisar no Android Studio.
 */
class SignalingClient(
    private val list: SignalerList,
    private val selfNodeId: String,
    var onSignal: (fromNodeId: String, payload: JSONObject) -> Unit,
    private val onStateChange: ((connected: Boolean) -> Unit)? = null,
    // Se fornecidos, o cliente prova posse da wallet assinando o próprio nodeId
    // (uma assinatura só, reaproveitada em todos os signalers).
    private val walletPubkeyBase58: String? = null,
    private val signNodeId: ((ByteArray) -> ByteArray)? = null,
    private val maxActive: Int = 3
) {
    /** Compat: chamada antiga com UMA url (aceita ws:// porque foi pedida explicitamente). */
    constructor(
        serverUrl: String,
        selfNodeId: String,
        onSignal: (fromNodeId: String, payload: JSONObject) -> Unit,
        onStateChange: ((connected: Boolean) -> Unit)? = null,
        walletPubkeyBase58: String? = null,
        signNodeId: ((ByteArray) -> ByteArray)? = null
    ) : this(
        SignalerList(seeds = listOf(serverUrl), remoteLists = emptyList(), allowInsecure = true),
        selfNodeId, onSignal, onStateChange, walletPubkeyBase58, signNodeId
    )

    var onRelayRequest: ((from: String, requestId: Int, header: JSONObject, payload: ByteArray?) -> Unit)? = null
    var onRelayResponse: ((from: String, requestId: Int, header: JSONObject, payload: ByteArray?) -> Unit)? = null
    var onPeerList: ((List<String>) -> Unit)? = null
    var onPeerJoined: ((String) -> Unit)? = null
    var onPeerLeft: ((String) -> Unit)? = null
    var onError: ((reason: String, detail: String?) -> Unit)? = null

    private class Link(val url: String) {
        @Volatile var ws: WebSocket? = null
        @Volatile var open = false
        @Volatile var connecting = false
        @Volatile var gen = 0
        var failures = 0
        var nextTry = 0L
    }

    private class PendingSig(var sent: Int, var offline: Int, var t: Long)
    private class PendingRelay(val to: String, val header: JSONObject, val payload: ByteArray?, val t: Long) {
        val tried = HashSet<String>()
    }

    private val lock = Any()
    private val links = LinkedHashMap<String, Link>()
    private val known = HashMap<String, MutableSet<String>>()      // peerId -> urls que o veem
    private val seen = LinkedHashMap<String, Long>()               // _mid já entregues
    private val pendingSig = HashMap<String, PendingSig>()
    private val pendingRelay = HashMap<Int, PendingRelay>()
    private val relayOrigin = HashMap<String, String>()            // "from:requestId" -> url

    private val client = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()
    private var scheduler: ScheduledExecutorService? = null
    @Volatile private var closed = true
    private var wasConnected = false

    /** URLs com conexão aberta agora (debug/painel). */
    fun activeUrls(): List<String> = synchronized(lock) { links.values.filter { it.open }.map { it.url } }
    val connected: Boolean get() = synchronized(lock) { links.values.any { it.open } }

    fun connect() {
        synchronized(lock) {
            if (!closed) return
            closed = false
        }
        list.onChange = { reconcile() }
        val s = Executors.newSingleThreadScheduledExecutor()
        scheduler = s
        s.scheduleWithFixedDelay({ try { reconcile() } catch (_: Exception) { } }, 0, 3, TimeUnit.SECONDS)
        // lista remota em segundo plano: não bloqueia a 1ª conexão (seeds já bastam)
        Thread { try { list.refreshRemote() } catch (_: Exception) { } }.apply { isDaemon = true }.start()
    }

    fun disconnect() {
        val toClose: List<WebSocket>
        synchronized(lock) {
            closed = true
            toClose = links.values.mapNotNull { it.ws }
            links.clear(); known.clear()
        }
        scheduler?.shutdownNow()
        toClose.forEach { try { it.close(1000, "bye") } catch (_: Exception) { } }
        emitState()
        client.dispatcher.executorService.shutdown()
    }

    // ---------- gerência de links ----------

    private fun reconcile() {
        if (closed) return
        val now = System.currentTimeMillis()
        val toOpen = ArrayList<Link>()
        synchronized(lock) {
            var active = links.values.count { it.open || it.connecting }
            for (url in list.urls()) {
                if (active >= maxActive) break
                val l = links.getOrPut(url) { Link(url) }
                if (l.open || l.connecting || l.nextTry > now) continue
                l.connecting = true
                l.gen += 1
                toOpen.add(l); active++
            }
            prune(now)
        }
        toOpen.forEach { openLink(it) }
    }

    private fun openLink(l: Link) {
        val myGen = l.gen
        val req = try { Request.Builder().url(l.url).build() } catch (e: Exception) { linkDown(l, myGen); return }
        client.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                synchronized(lock) {
                    if (l.gen != myGen || closed) { webSocket.close(1000, "stale"); return }
                    l.ws = webSocket; l.open = true; l.connecting = false; l.failures = 0
                }
                val reg = JSONObject().put("type", "register").put("nodeId", selfNodeId)
                if (walletPubkeyBase58 != null && signNodeId != null) {
                    val sig = signNodeId.invoke(selfNodeId.toByteArray(Charsets.UTF_8))
                    reg.put("pubkey", walletPubkeyBase58).put("sig", Base64.encodeToString(sig, Base64.NO_WRAP))
                }
                webSocket.send(reg.toString())
                emitState()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (l.gen != myGen) return
                try { handleMessage(l, text) } catch (_: Exception) { }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { linkDown(l, myGen) }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { linkDown(l, myGen) }
        })
    }

    private fun linkDown(l: Link, gen: Int) {
        var wasOpen = false
        synchronized(lock) {
            if (l.gen != gen || (!l.open && !l.connecting)) return
            wasOpen = l.open
            l.open = false; l.connecting = false; l.ws = null
            l.failures += 1
            val backoff = min(60_000L, 1000L shl min(l.failures, 6))
            l.nextTry = System.currentTimeMillis() + backoff + (Math.random() * 500).toLong()
            // esquece este link como fonte de peers (sem emitir onPeerLeft — ver doc da classe)
            for (s in known.values) s.remove(l.url)
            known.entries.removeAll { it.value.isEmpty() }
        }
        if (wasOpen) emitState()
        reconcile() // promove o próximo da lista já
    }

    private fun emitState() {
        val now: Boolean
        val changed: Boolean
        synchronized(lock) {
            now = links.values.any { it.open }
            changed = now != wasConnected
            wasConnected = now
        }
        if (changed) onStateChange?.invoke(now)
    }

    // ---------- recepção ----------

    private fun addSource(peerId: String, url: String): Boolean = synchronized(lock) {
        val s = known[peerId]
        if (s == null) { known[peerId] = hashSetOf(url); true } else { s.add(url); false }
    }

    private fun decode(msg: JSONObject): ByteArray? {
        val s = msg.optString("payloadBase64", "")
        return if (s.isNotEmpty()) Base64.decode(s, Base64.DEFAULT) else null
    }

    private fun handleMessage(l: Link, text: String) {
        val msg = JSONObject(text)
        when (msg.optString("type")) {
            "peers" -> {
                val arr = msg.optJSONArray("nodeIds") ?: return
                val fresh = ArrayList<String>()
                for (i in 0 until arr.length()) {
                    val id = arr.getString(i)
                    if (id != selfNodeId && addSource(id, l.url)) fresh.add(id)
                }
                if (fresh.isNotEmpty()) onPeerList?.invoke(fresh)
            }
            "peer_joined" -> {
                val id = msg.getString("nodeId")
                if (id != selfNodeId && addSource(id, l.url)) onPeerJoined?.invoke(id)
            }
            "peer_left" -> {
                val id = msg.getString("nodeId")
                val gone = synchronized(lock) {
                    val s = known[id]
                    if (s == null) false else { s.remove(l.url); if (s.isEmpty()) { known.remove(id); true } else false }
                }
                if (gone) onPeerLeft?.invoke(id)
            }
            "signal" -> {
                val from = msg.getString("from")
                val payload = msg.getJSONObject("payload")
                val mid = payload.optString("_mid", "")
                if (mid.isNotEmpty()) {
                    val dup = synchronized(lock) {
                        if (seen.containsKey(mid)) true else { seen[mid] = System.currentTimeMillis(); false }
                    }
                    if (dup) return          // cópia que chegou por outro signaler
                    payload.remove("_mid")
                }
                onSignal(from, payload)
            }
            "relay" -> {
                val from = msg.getString("from")
                val reqId = msg.getInt("requestId")
                synchronized(lock) { relayOrigin["$from:$reqId"] = l.url }
                onRelayRequest?.invoke(from, reqId, msg.getJSONObject("header"), decode(msg))
            }
            "relay_response" -> {
                val reqId = msg.getInt("requestId")
                synchronized(lock) { pendingRelay.remove(reqId) }
                onRelayResponse?.invoke(msg.getString("from"), reqId, msg.getJSONObject("header"), decode(msg))
            }
            "relay_error" -> {
                val reqId = msg.optInt("requestId", -1)
                val pr = synchronized(lock) { pendingRelay[reqId] }
                if (pr != null && resendRelay(reqId, pr)) return     // outro signaler tentou
                synchronized(lock) { pendingRelay.remove(reqId) }
                onError?.invoke(msg.optString("reason", "relay_error"), null)
            }
            "error" -> {
                val reason = msg.optString("reason", "erro_desconhecido")
                val to = msg.optString("to", "")
                if (reason == "peer_offline" && to.isNotEmpty()) {
                    // só reporta se TODOS os signalers pra onde mandamos disseram "offline"
                    val report = synchronized(lock) {
                        val p = pendingSig[to]
                        if (p == null) true else { p.offline += 1; if (p.offline >= p.sent) { pendingSig.remove(to); true } else false }
                    }
                    if (!report) return
                }
                onError?.invoke(reason, msg.optString("detail", "").takeIf { it.isNotEmpty() })
            }
            "signalers" -> {
                val arr = msg.optJSONArray("urls") ?: return
                list.addLearned((0 until arr.length()).map { arr.optString(it) })
            }
        }
    }

    // ---------- envio ----------

    private fun openLinks(): List<Link> = synchronized(lock) { links.values.filter { it.open } }

    /** Links que conhecem [to]; se nenhum conhece (lista ainda não chegou), todos os abertos. */
    private fun targetsFor(to: String): List<Link> = synchronized(lock) {
        val open = links.values.filter { it.open }
        val knowing = open.filter { known[to]?.contains(it.url) == true }
        if (knowing.isNotEmpty()) knowing else open
    }

    fun sendSignal(toNodeId: String, payload: JSONObject) {
        val targets = targetsFor(toNodeId)
        if (targets.isEmpty()) return
        val body = JSONObject(payload.toString()).put("_mid", UUID.randomUUID().toString())
        val text = JSONObject()
            .put("type", "signal").put("to", toNodeId).put("from", selfNodeId).put("payload", body)
            .toString()
        var sent = 0
        for (l in targets) if (l.ws?.send(text) == true) sent++
        synchronized(lock) {
            val p = pendingSig.getOrPut(toNodeId) { PendingSig(0, 0, 0) }
            p.sent += sent; p.t = System.currentTimeMillis()
        }
    }

    fun sendRelay(toNodeId: String, requestId: Int, header: JSONObject, payload: ByteArray?) {
        val e = PendingRelay(toNodeId, header, payload, System.currentTimeMillis())
        synchronized(lock) { pendingRelay[requestId] = e }
        if (!resendRelay(requestId, e)) {
            synchronized(lock) { pendingRelay.remove(requestId) }
            onError?.invoke("no_signaler", null)
        }
    }

    private fun resendRelay(requestId: Int, e: PendingRelay): Boolean {
        val l = synchronized(lock) {
            (targetsFor(e.to).firstOrNull { it.url !in e.tried } ?: openLinks().firstOrNull { it.url !in e.tried })
                ?.also { e.tried.add(it.url) }
        } ?: return false
        val msg = JSONObject().put("type", "relay").put("to", e.to).put("requestId", requestId).put("header", e.header)
        if (e.payload != null) msg.put("payloadBase64", Base64.encodeToString(e.payload, Base64.NO_WRAP))
        return l.ws?.send(msg.toString()) == true
    }

    fun sendRelayResponse(toNodeId: String, requestId: Int, header: JSONObject, payload: ByteArray?) {
        val l = synchronized(lock) {
            val origin = relayOrigin.remove("$toNodeId:$requestId")
            origin?.let { links[it] }?.takeIf { it.open }
        } ?: targetsFor(toNodeId).firstOrNull() ?: return
        val msg = JSONObject().put("type", "relay_response").put("to", toNodeId).put("requestId", requestId).put("header", header)
        if (payload != null) msg.put("payloadBase64", Base64.encodeToString(payload, Base64.NO_WRAP))
        l.ws?.send(msg.toString())
    }

    private fun prune(now: Long) {   // chamado com lock
        if (seen.size > 1000) {
            val it = seen.entries.iterator()
            var drop = seen.size - 500
            while (it.hasNext() && drop-- > 0) { it.next(); it.remove() }
        }
        pendingSig.entries.removeAll { now - it.value.t > 10_000 }
        pendingRelay.entries.removeAll { now - it.value.t > 30_000 }
        if (relayOrigin.size > 2000) relayOrigin.clear()
    }
}
