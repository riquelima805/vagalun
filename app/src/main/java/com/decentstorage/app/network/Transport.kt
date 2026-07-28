package com.decentstorage.app.network

import org.json.JSONObject


interface Transport {
    fun putShard(shardKey: String, data: ByteArray): Boolean
    fun getShard(shardKey: String): ByteArray?
    fun deleteShard(shardKey: String): Boolean
    fun challenge(shardKey: String, nonce: String): String?
    fun gossip(payload: JSONObject): JSONObject?
    fun status(): JSONObject?

 
    fun close() {}
}


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
