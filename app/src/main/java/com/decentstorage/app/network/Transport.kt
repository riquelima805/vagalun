package com.decentstorage.app.network

import org.json.JSONObject

/**
 * Abstração de transporte pra falar shard-a-shard com um peer, independente de COMO
 * os bytes chegam lá. Duas implementações existem hoje:
 *   - TcpTransport: socket TCP direto (mesma rede local, peer achado via PeerDiscovery/NSD)
 *   - WebRtcTransport (em network/webrtc/): DataChannel WebRTC (WAN, atrás de NAT,
 *     peer achado via BootstrapPeerList + SignalingClient)
 *
 * GossipRegistry e StorageClient falam só com essa interface — não sabem nem precisam
 * saber qual dos dois está em uso pra um peer específico. Isso é o que fecha o buraco
 * que o README apontava: "PeerDiscovery só funciona na LAN, falta o transporte WAN".
 */
interface Transport {
    fun putShard(shardKey: String, data: ByteArray): Boolean
    fun getShard(shardKey: String): ByteArray?
    fun deleteShard(shardKey: String): Boolean
    fun challenge(shardKey: String, nonce: String): String?
    fun gossip(payload: JSONObject): JSONObject?
    fun status(): JSONObject?

    /** No-op pra TCP (cada chamada já abre/fecha o próprio socket); relevante pro WebRTC,
     *  que mantém um DataChannel vivo e precisa liberar o observer/canal ao descartar o peer. */
    fun close() {}
}

/** Transporte de hoje (LAN): abre um socket TCP novo por chamada, igual o ShardClient já fazia. */
class TcpTransport(private val host: String, private val port: Int) : Transport {
    override fun putShard(shardKey: String, data: ByteArray): Boolean =
        ShardClient.putShard(host, port, shardKey, data)

    override fun getShard(shardKey: String): ByteArray? =
        ShardClient.getShard(host, port, shardKey)

    override fun deleteShard(shardKey: String): Boolean =
        ShardClient.deleteShard(host, port, shardKey)

    override fun challenge(shardKey: String, nonce: String): String? =
        ShardClient.challenge(host, port, shardKey, nonce)

    override fun gossip(payload: JSONObject): JSONObject? =
        ShardClient.gossip(host, port, payload)

    override fun status(): JSONObject? =
        ShardClient.status(host, port)
}
