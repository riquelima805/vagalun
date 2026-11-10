package com.decentstorage.app.network

import org.json.JSONArray
import java.net.URL


object BootstrapPeerList {

    data class BootstrapEntry(val nodeId: String, val host: String, val port: Int)

  
    fun fetchFromUrl(url: String): List<BootstrapEntry> {
        return try {
            val text = URL(url).readText()
            val arr = JSONArray(text)
            (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                BootstrapEntry(o.getString("nodeId"), o.getString("host"), o.getInt("port"))
            }
        } catch (e: Exception) {
            emptyList()
        }
    }

   
    fun hardcoded(): List<BootstrapEntry> = emptyList()
}
