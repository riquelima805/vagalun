package com.decentstorage.app.network

import com.decentstorage.app.erasure.AvailableShard
import com.decentstorage.app.erasure.ReedSolomon
import net.i2p.crypto.eddsa.EdDSAEngine
import net.i2p.crypto.eddsa.EdDSAPublicKey
import net.i2p.crypto.eddsa.spec.EdDSANamedCurveTable
import net.i2p.crypto.eddsa.spec.EdDSAPublicKeySpec
import org.json.JSONArray
import org.json.JSONObject
import org.sol4k.Base58
import java.io.File
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit


class GossipRegistry(
    val selfNodeId: String,
    val selfHost: String,
    val selfPort: Int,
    val selfCapacityBytes: Long,
    private val dataDir: File? = null,
    private val safetyMargin: Int = 1
) {
    data class PeerInfo(
        val nodeId: String,
        val host: String,
        val port: Int,
        var score: Int = 70,
        var lastSeen: Long = System.currentTimeMillis(),
        var alive: Boolean = true,
        var freeBytes: Long = 0,
        
        var webrtcTransport: Transport? = null
    ) {
        val transport: Transport
            get() = webrtcTransport ?: TcpTransport(host, port)
    }

    data class Placement(val shardIndex: Int, val nodeId: String)

    data class BlockMeta(
        val blockIndex: Int,
        val plainLength: Int,
        val shardSize: Int,
        val iv: String,
        val authTag: String,
        var placements: MutableList<Placement>
    )

    data class FileMeta(
        val fileId: String,
        val fileName: String,
        val k: Int,
        val m: Int,
        val n: Int,
        val blockSize: Int,
        val originalLength: Int,
        var blocks: MutableList<BlockMeta>
    )

    // --- Índice de sites (navegador P2P) ---
  
    data class SiteRoute(val path: String, val fileId: String, val contentType: String, val fileKeyB64: String)
    data class SiteMeta(
        val domain: String,
        val ownerPubkeyB58: String,
        val routes: List<SiteRoute>,
        val signatureB64: String,
        val updatedAt: Long
    )

    private val sites = ConcurrentHashMap<String, SiteMeta>()

    private val peers = ConcurrentHashMap<String, PeerInfo>()
    private val files = ConcurrentHashMap<String, FileMeta>()
    private val executor = Executors.newSingleThreadScheduledExecutor()

    private val ALIVE_TIMEOUT_MS = 15_000L

    // --- Persistência em disco (mesmo padrão do gateway-data.json) ---
    private val dataFile: File? = dataDir?.let { File(it, "gossip-registry.json") }
    private var saveScheduled = false

    init {
        loadFromDisk()
    }

    private fun loadFromDisk() {
        val file = dataFile ?: return
        if (!file.exists()) return
        try {
            val raw = JSONObject(file.readText())
            mergeFiles(raw.optJSONArray("files") ?: JSONArray())
            mergeSites(raw.optJSONArray("sites") ?: JSONArray())
            val peersArr = raw.optJSONArray("peers") ?: JSONArray()
            for (i in 0 until peersArr.length()) {
                val o = peersArr.getJSONObject(i)
                addOrUpdatePeer(o.getString("nodeId"), o.getString("host"), o.getInt("port"))
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun scheduleSave() {
        val file = dataFile ?: return
        if (saveScheduled) return
        saveScheduled = true
        executor.schedule({
            saveScheduled = false
            try {
                val out = JSONObject()
                    .put("peers", serializePeersForPersistence())
                    .put("files", serializeFiles())
                    .put("sites", serializeSites())
                val tmp = File(file.parentFile, "${file.name}.tmp")
                tmp.writeText(out.toString())
                if (!tmp.renameTo(file)) {
                    // fallback caso rename atômico falhe (ex.: filesystem diferente)
                    file.writeText(out.toString())
                    tmp.delete()
                }
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }, 250, TimeUnit.MILLISECONDS)
    }

    // Só nodeId/host/port — o resto (score, alive, freeBytes, transport) é
    // estado efêmero que faz sentido recalcular do zero a cada boot via
    // healthCheck()/gossip, não persistir.
    private fun serializePeersForPersistence(): JSONArray {
        val arr = JSONArray()
        for (p in peers.values) {
            arr.put(JSONObject().put("nodeId", p.nodeId).put("host", p.host).put("port", p.port))
        }
        return arr
    }

    fun addOrUpdatePeer(nodeId: String, host: String, port: Int) {
        if (nodeId == selfNodeId) return
        var isNew = false
        peers.compute(nodeId) { _, existing ->
            if (existing != null) {
                existing.apply { lastSeen = System.currentTimeMillis(); alive = true }
            } else {
                isNew = true
                PeerInfo(nodeId, host, port)
            }
        }
        // só persiste quando é peer novo — atualizar lastSeen a cada gossip
        // (que roda de poucos em poucos segundos) geraria escrita constante.
        if (isNew) scheduleSave()
    }

    fun attachWanTransport(nodeId: String, transport: Transport) {
        if (nodeId == selfNodeId) return
        peers.compute(nodeId) { _, existing ->
            val peer = existing ?: PeerInfo(nodeId, host = "webrtc:$nodeId", port = 0)
            peer.webrtcTransport = transport
            peer.lastSeen = System.currentTimeMillis()
            peer.alive = true
            peer
        }
    }

    fun detachWanTransport(nodeId: String) {
        peers[nodeId]?.webrtcTransport = null
    }

    fun registerFile(meta: FileMeta) { files[meta.fileId] = meta; scheduleSave() }
    fun getFile(fileId: String): FileMeta? = files[fileId]
    fun knownPeers(): List<PeerInfo> = peers.values.toList()

    // Mesma fórmula do gateway.js: assina/verifica "domain\npath|fileId|contentType"
    // ordenado por path — string canônica, sem espaço pra ambiguidade.
    fun canonicalManifest(domain: String, routes: List<SiteRoute>): String {
        val sorted = routes.sortedBy { it.path }
        val body = sorted.joinToString("\n") { "${it.path}|${it.fileId}|${it.contentType}" }
        return "$domain\n$body"
    }

    private fun verifySiteSignature(domain: String, ownerPubkeyB58: String, routes: List<SiteRoute>, signatureB64: String): Boolean {
        return try {
            val message = canonicalManifest(domain, routes).toByteArray(Charsets.UTF_8)
            val sig = Base64.getDecoder().decode(signatureB64)
            val pubkeyBytes = Base58.decode(ownerPubkeyB58)
            val spec = EdDSANamedCurveTable.getByName(EdDSANamedCurveTable.ED_25519)
            val pub = EdDSAPublicKey(EdDSAPublicKeySpec(pubkeyBytes, spec))
            val engine = EdDSAEngine()
            engine.initVerify(pub)
            engine.update(message)
            engine.verify(sig)
        } catch (e: Exception) {
            false
        }
    }

    // Este node NUNCA confia num manifesto que não conseguiu verificar sozinho —
    // seja publicado localmente, seja aprendido de outro peer (ou do gateway,
    // via meshBridge) via gossip.
    fun registerSite(domain: String, ownerPubkeyB58: String, routes: List<SiteRoute>, signatureB64: String): Boolean {
        if (!verifySiteSignature(domain, ownerPubkeyB58, routes, signatureB64)) return false
        val candidate = SiteMeta(domain, ownerPubkeyB58, routes, signatureB64, System.currentTimeMillis())
        sites[domain] = candidate
        scheduleSave()
        return true
    }

    fun getSite(domain: String): SiteMeta? = sites[domain]
    fun listSites(): List<String> = sites.keys.toList()

    private fun bumpScore(nodeId: String, delta: Int) {
        peers[nodeId]?.let { it.score = (it.score + delta).coerceIn(0, 100) }
    }

    fun bestPeersForUpload(n: Int, shardSizeHint: Long): List<PeerInfo> =
        peers.values.filter { it.alive && it.freeBytes >= shardSizeHint }
            .sortedWith(compareByDescending<PeerInfo> { it.score }.thenByDescending { it.freeBytes })
            .take(n)

    fun start() {
        executor.scheduleWithFixedDelay({ safeRun { healthCheck() } }, 0, 4, TimeUnit.SECONDS)
        executor.scheduleWithFixedDelay({ safeRun { gossipRound() } }, 1, 6, TimeUnit.SECONDS)
        executor.scheduleWithFixedDelay({ safeRun { reReplicateIfNeeded() } }, 2, 8, TimeUnit.SECONDS)
    }

    fun stop() { executor.shutdownNow() }

    private fun safeRun(block: () -> Unit) {
        try { block() } catch (e: Exception) { e.printStackTrace() }
    }

    private fun healthCheck() {
        for (peer in peers.values) {
            val status = peer.transport.status()
            if (status != null) {
                peer.alive = true
                peer.lastSeen = System.currentTimeMillis()
                peer.freeBytes = status.optLong("freeBytes", peer.freeBytes)
                bumpScore(peer.nodeId, +1)
            } else if (System.currentTimeMillis() - peer.lastSeen > ALIVE_TIMEOUT_MS) {
                if (peer.alive) bumpScore(peer.nodeId, -30)
                peer.alive = false
            }
        }
    }

    private fun gossipRound() {
        val sample = peers.values.filter { it.alive }.shuffled().take(3)
        for (peer in sample) {
            val payload = JSONObject()
                .put("peers", serializePeers())
                .put("files", serializeFiles())
                .put("sites", serializeSites())
            val response = peer.transport.gossip(payload) ?: continue
            mergePeers(response.optJSONArray("peers") ?: JSONArray())
            mergeFiles(response.optJSONArray("files") ?: JSONArray())
            mergeSites(response.optJSONArray("sites") ?: JSONArray())
        }
    }

    fun handleIncomingGossip(payload: JSONObject): JSONObject {
        mergePeers(payload.optJSONArray("peers") ?: JSONArray())
        mergeFiles(payload.optJSONArray("files") ?: JSONArray())
        mergeSites(payload.optJSONArray("sites") ?: JSONArray())
        return JSONObject().put("peers", serializePeers()).put("files", serializeFiles()).put("sites", serializeSites())
    }

    private fun serializeSites(): JSONArray {
        val arr = JSONArray()
        for (s in sites.values) {
            val routesArr = JSONArray()
            for (r in s.routes) {
                routesArr.put(
                    JSONObject().put("path", r.path).put("fileId", r.fileId)
                        .put("contentType", r.contentType).put("fileKeyB64", r.fileKeyB64)
                )
            }
            arr.put(
                JSONObject()
                    .put("domain", s.domain).put("ownerPubkeyB58", s.ownerPubkeyB58)
                    .put("routes", routesArr).put("signatureB64", s.signatureB64)
                    .put("updatedAt", s.updatedAt)
            )
        }
        return arr
    }

    // Re-verifica a assinatura de todo manifesto vindo de outro peer antes de aceitar —
    // gossip é só transporte, confiança continua sendo 100% criptográfica, nunca "confio
    // porque veio de um peer que eu já conhecia".
    private fun mergeSites(arr: JSONArray) {
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            val domain = o.getString("domain")
            val incomingUpdatedAt = o.optLong("updatedAt", 0)
            val existing = sites[domain]
            if (existing != null && existing.updatedAt >= incomingUpdatedAt) continue

            val routesArr = o.getJSONArray("routes")
            val routes = mutableListOf<SiteRoute>()
            for (j in 0 until routesArr.length()) {
                val r = routesArr.getJSONObject(j)
                routes.add(SiteRoute(r.getString("path"), r.getString("fileId"), r.getString("contentType"), r.optString("fileKeyB64", "")))
            }
            val ownerPubkeyB58 = o.getString("ownerPubkeyB58")
            val signatureB64 = o.getString("signatureB64")
            if (!verifySiteSignature(domain, ownerPubkeyB58, routes, signatureB64)) continue // manifesto forjado/corrompido: ignora

            sites[domain] = SiteMeta(domain, ownerPubkeyB58, routes, signatureB64, incomingUpdatedAt)
            scheduleSave()
        }
    }

    private fun serializePeers(): JSONArray {
        val arr = JSONArray()
        arr.put(JSONObject().put("nodeId", selfNodeId).put("host", selfHost).put("port", selfPort).put("score", 100))
        for (p in peers.values) {
            arr.put(JSONObject().put("nodeId", p.nodeId).put("host", p.host).put("port", p.port).put("score", p.score))
        }
        return arr
    }

    private fun mergePeers(arr: JSONArray) {
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            addOrUpdatePeer(o.getString("nodeId"), o.getString("host"), o.getInt("port"))
        }
    }

    private fun serializeFiles(): JSONArray {
        val arr = JSONArray()
        for (f in files.values) {
            val blocksArr = JSONArray()
            for (b in f.blocks) {
                val placementsArr = JSONArray()
                for (p in b.placements) placementsArr.put(JSONObject().put("shardIndex", p.shardIndex).put("nodeId", p.nodeId))
                
                blocksArr.put(
                    JSONObject()
                        .put("blockIndex", b.blockIndex)
                        .put("plainLength", b.plainLength)
                        .put("shardSize", b.shardSize)
                        .put("iv", b.iv)
                        .put("authTag", b.authTag)
                        .put("placements", placementsArr)
                )
            }
            arr.put(
                JSONObject()
                    .put("fileId", f.fileId).put("fileName", f.fileName)
                    .put("k", f.k).put("m", f.m).put("n", f.n)
                    .put("blockSize", f.blockSize).put("originalLength", f.originalLength)
                    .put("blocks", blocksArr)
            )
        }
        return arr
    }

    private fun mergeFiles(arr: JSONArray) {
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            val fileId = o.getString("fileId")
            if (files.containsKey(fileId)) continue
            
            val blocks = mutableListOf<BlockMeta>()
            val bArr = o.getJSONArray("blocks")
            
            for (j in 0 until bArr.length()) {
                val b = bArr.getJSONObject(j)
                val placements = mutableListOf<Placement>()
                val pArr = b.getJSONArray("placements")
                for (x in 0 until pArr.length()) {
                    val p = pArr.getJSONObject(x)
                    placements.add(Placement(p.getInt("shardIndex"), p.getString("nodeId")))
                }
                
                blocks.add(
                    BlockMeta(
                        b.getInt("blockIndex"), b.getInt("plainLength"), b.getInt("shardSize"),
                        b.getString("iv"), b.getString("authTag"), placements
                    )
                )
            }
            
            files[fileId] = FileMeta(
                fileId, o.getString("fileName"), o.getInt("k"), o.getInt("m"), o.getInt("n"),
                o.getInt("blockSize"), o.getInt("originalLength"), blocks
            )
            scheduleSave()
        }
    }

    private fun reReplicateIfNeeded() {
        for (file in files.values) {
            for (block in file.blocks) {
                val alivePlacements = block.placements.filter { peers[it.nodeId]?.alive == true || it.nodeId == selfNodeId }
                val missingCount = file.k + safetyMargin - alivePlacements.size
                if (missingCount <= 0) continue

                val missingShardIndices = (0 until file.n).filter { idx -> alivePlacements.none { it.shardIndex == idx } }
                val busyNodeIds = block.placements.map { it.nodeId }.toSet()
                val candidates = peers.values
                    .filter { it.alive && it.nodeId !in busyNodeIds && it.freeBytes >= block.shardSize }
                    .sortedByDescending { it.score }
                    .toMutableList()

                for (shardIndex in missingShardIndices) {
                    val target = candidates.removeFirstOrNull() ?: continue
                    try {
                        migrateShard(file, block, shardIndex, target)
                        block.placements.removeAll { it.shardIndex == shardIndex }
                        block.placements.add(Placement(shardIndex, target.nodeId))
                        bumpScore(target.nodeId, +5)
                        scheduleSave() // placement mudou — persistir, senão volta pro nó antigo (morto) depois de um restart
                    } catch (e: Exception) {
                        e.printStackTrace()
                    }
                }
            }
        }
    }

    private fun migrateShard(file: FileMeta, block: BlockMeta, shardIndex: Int, target: PeerInfo) {
        val alivePlacements = block.placements.filter { peers[it.nodeId]?.alive == true || it.nodeId == selfNodeId }
        require(alivePlacements.size >= file.k) { "shards vivos insuficientes para reconstruir o bloco ${block.blockIndex}" }

        val fetched = mutableListOf<AvailableShard>()
        for (p in alivePlacements.take(file.k)) {
            val bytes = if (p.nodeId == selfNodeId) {
                null 
            } else {
                val peer = peers[p.nodeId] ?: continue
                peer.transport.getShard(ShardKeys.of(file.fileId, block.blockIndex, p.shardIndex))
            }
            if (bytes != null) fetched.add(AvailableShard(p.shardIndex, bytes))
        }
        require(fetched.size >= file.k) { "não foi possível buscar shards suficientes dos peers vivos para o bloco ${block.blockIndex}" }

        val ciphertext = ReedSolomon.decode(fetched, block.plainLength, block.shardSize, file.k, file.m)
        val reEncoded = ReedSolomon.encode(ciphertext, file.k, file.m)
        val missingShardData = reEncoded.shards[shardIndex]

        val ok = target.transport.putShard(ShardKeys.of(file.fileId, block.blockIndex, shardIndex), missingShardData)
        require(ok) { "falha ao enviar shard reconstruído do bloco ${block.blockIndex}" }
    }
}
