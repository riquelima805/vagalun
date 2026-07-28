package com.decentstorage.app.network

import com.decentstorage.app.erasure.AvailableShard
import com.decentstorage.app.erasure.ReedSolomon
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.random.Random


class GossipRegistry(
    val selfNodeId: String,
    val selfHost: String,
    val selfPort: Int,
    val selfCapacityBytes: Long,
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

    data class FileMeta(
        val fileId: String,
        val fileName: String,
        val k: Int,
        val m: Int,
        val n: Int,
        val shardSize: Int,
        val cipherLength: Int,
        val originalLength: Int,
        val iv: String,
        val authTag: String,
        var placements: MutableList<Placement>
    )

    private val peers = ConcurrentHashMap<String, PeerInfo>()
    private val files = ConcurrentHashMap<String, FileMeta>()
    private val executor = Executors.newSingleThreadScheduledExecutor()

    private val ALIVE_TIMEOUT_MS = 15_000L

    fun addOrUpdatePeer(nodeId: String, host: String, port: Int) {
        if (nodeId == selfNodeId) return
        peers.compute(nodeId) { _, existing ->
            existing?.apply { lastSeen = System.currentTimeMillis(); alive = true }
                ?: PeerInfo(nodeId, host, port)
        }
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

    fun registerFile(meta: FileMeta) { files[meta.fileId] = meta }
    fun getFile(fileId: String): FileMeta? = files[fileId]
    fun knownPeers(): List<PeerInfo> = peers.values.toList()

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
            val response = peer.transport.gossip(payload) ?: continue
            mergePeers(response.optJSONArray("peers") ?: JSONArray())
            mergeFiles(response.optJSONArray("files") ?: JSONArray())
        }
    }

   
    fun handleIncomingGossip(payload: JSONObject): JSONObject {
        mergePeers(payload.optJSONArray("peers") ?: JSONArray())
        mergeFiles(payload.optJSONArray("files") ?: JSONArray())
        return JSONObject().put("peers", serializePeers()).put("files", serializeFiles())
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
            val placementsArr = JSONArray()
            for (p in f.placements) placementsArr.put(JSONObject().put("shardIndex", p.shardIndex).put("nodeId", p.nodeId))
            arr.put(
                JSONObject()
                    .put("fileId", f.fileId).put("fileName", f.fileName)
                    .put("k", f.k).put("m", f.m).put("n", f.n)
                    .put("shardSize", f.shardSize).put("cipherLength", f.cipherLength).put("originalLength", f.originalLength)
                    .put("iv", f.iv).put("authTag", f.authTag)
                    .put("placements", placementsArr)
            )
        }
        return arr
    }

    private fun mergeFiles(arr: JSONArray) {
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            val fileId = o.getString("fileId")
            if (files.containsKey(fileId)) continue 
            val placements = mutableListOf<Placement>()
            val pArr = o.getJSONArray("placements")
            for (j in 0 until pArr.length()) {
                val p = pArr.getJSONObject(j)
                placements.add(Placement(p.getInt("shardIndex"), p.getString("nodeId")))
            }
            files[fileId] = FileMeta(
                fileId, o.getString("fileName"), o.getInt("k"), o.getInt("m"), o.getInt("n"),
                o.getInt("shardSize"), o.getInt("cipherLength"), o.getInt("originalLength"),
                o.getString("iv"), o.getString("authTag"), placements
            )
        }
    }

   
    private fun reReplicateIfNeeded() {
        for (file in files.values) {
            val alivePlacements = file.placements.filter { peers[it.nodeId]?.alive == true || it.nodeId == selfNodeId }
            val missingCount = file.k + safetyMargin - alivePlacements.size
            if (missingCount <= 0) continue

            val missingShardIndices = (0 until file.n).filter { idx -> alivePlacements.none { it.shardIndex == idx } }
            val busyNodeIds = file.placements.map { it.nodeId }.toSet()
            val candidates = peers.values
                .filter { it.alive && it.nodeId !in busyNodeIds && it.freeBytes >= file.shardSize }
                .sortedByDescending { it.score }
                .toMutableList()

            for (shardIndex in missingShardIndices) {
                val target = candidates.removeFirstOrNull() ?: continue
                try {
                    migrateShard(file, shardIndex, target)
                    file.placements.removeAll { it.shardIndex == shardIndex }
                    file.placements.add(Placement(shardIndex, target.nodeId))
                    bumpScore(target.nodeId, +5)
                } catch (e: Exception) {
                    e.printStackTrace()
                }
            }
        }
    }

    private fun shardKeyFor(fileId: String, shardIndex: Int) = "${fileId}_$shardIndex"

    private fun migrateShard(file: FileMeta, shardIndex: Int, target: PeerInfo) {
        val alivePlacements = file.placements.filter { peers[it.nodeId]?.alive == true || it.nodeId == selfNodeId }
        require(alivePlacements.size >= file.k) { "shards vivos insuficientes para reconstruir" }

        val fetched = mutableListOf<AvailableShard>()
        for (p in alivePlacements.take(file.k)) {
            val bytes = if (p.nodeId == selfNodeId) {
                null 
            } else {
                val peer = peers[p.nodeId] ?: continue
                peer.transport.getShard(shardKeyFor(file.fileId, p.shardIndex))
            }
            if (bytes != null) fetched.add(AvailableShard(p.shardIndex, bytes))
        }
        require(fetched.size >= file.k) { "não foi possível buscar shards suficientes dos peers vivos" }

        val ciphertext = ReedSolomon.decode(fetched, file.cipherLength, file.shardSize, file.k, file.m)
        val reEncoded = ReedSolomon.encode(ciphertext, file.k, file.m)
        val missingShardData = reEncoded.shards[shardIndex]

        val ok = target.transport.putShard(shardKeyFor(file.fileId, shardIndex), missingShardData)
        require(ok) { "falha ao enviar shard reconstruído" }
    }
}
