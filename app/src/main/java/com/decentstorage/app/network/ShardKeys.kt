package com.decentstorage.app.network

object ShardKeys {
    fun of(fileId: String, blockIndex: Int, shardIndex: Int) = "${fileId}_b${blockIndex}_s${shardIndex}"
}
