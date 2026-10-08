package com.decentstorage.app.network

import org.json.JSONObject

interface Transport {
    fun putShard(shardKey: String, data: ByteArray): Boolean
    fun getShard(shardKey: String): ByteArray?
    
    // Default: fallback para get inteiro + corte em memória. 
    // Funciona em qualquer Transport sem obrigar override.
    fun getShardRange(shardKey: String, offset: Long, length: Int): ByteArray? =
        getShard(shardKey)?.let { full ->
            if (offset < 0 || offset >= full.size) null
            else full.copyOfRange(offset.toInt(), minOf(offset.toInt() + length, full.size))
        }
        
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

    // Aqui usamos a rota otimizada TCP direto sem precisar baixar o shard inteiro
    override fun getShardRange(shardKey: String, offset: Long, length: Int): ByteArray? =
        ShardClient.getShardRange(host, port, shardKey, offset, length)

    override fun deleteShard(shardKey: String): Boolean =
        ShardClient.deleteShard(host, port, shardKey)

    override fun challenge(shardKey: String, nonce: String): String? =
        ShardClient.challenge(host, port, shardKey, nonce)

    override fun gossip(payload: JSONObject): JSONObject? =
        ShardClient.gossip(host, port, payload)

    override fun status(): JSONObject? =
        ShardClient.status(host, port)
}
