package com.decentstorage.app.network

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import java.util.concurrent.ConcurrentHashMap

/**
 * Descoberta de peers SEM nenhum servidor central: cada dispositivo anuncia a si mesmo
 * via NSD (mDNS/Bonjour, já embutido no Android) na rede local, e escuta os anúncios
 * dos outros. Isso substitui, na LAN, o /register + /nodes do coordinator.js.
 *
 * LIMITAÇÃO HONESTA: NSD só enxerga peers na mesma rede local (Wi-Fi/hotspot).
 * Pra funcionar pela internet (dois celulares em redes diferentes), todo sistema P2P
 * real (BitTorrent, IPFS/libp2p) depende de algum mecanismo de rendezvous/bootstrap —
 * não existe "P2P pela internet com zero infraestrutura" de verdade, por causa de NAT.
 * Ver BootstrapPeerList.kt para a estratégia usada aqui pra WAN (minimiza, não elimina,
 * a dependência de infraestrutura fixa).
 */
class PeerDiscovery(private val context: Context, private val serviceType: String = "_decentstorage._tcp.") {

    data class Peer(val nodeId: String, val host: String, val port: Int, var lastSeen: Long = System.currentTimeMillis())

    private val nsdManager = context.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val peers = ConcurrentHashMap<String, Peer>()
    private var registrationListener: NsdManager.RegistrationListener? = null
    private var discoveryListener: NsdManager.DiscoveryListener? = null

    fun currentPeers(): List<Peer> = peers.values.toList()

    fun advertiseSelf(nodeId: String, port: Int) {
        val serviceInfo = NsdServiceInfo().apply {
            serviceName = nodeId
            serviceType = this@PeerDiscovery.serviceType
            setPort(port)
        }
        registrationListener = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(info: NsdServiceInfo) {}
            override fun onRegistrationFailed(info: NsdServiceInfo, errorCode: Int) {}
            override fun onServiceUnregistered(info: NsdServiceInfo) {}
            override fun onUnregistrationFailed(info: NsdServiceInfo, errorCode: Int) {}
        }
        nsdManager.registerService(serviceInfo, NsdManager.PROTOCOL_DNS_SD, registrationListener)
    }

    fun startDiscovery(onPeerFound: (Peer) -> Unit = {}) {
        discoveryListener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(regType: String) {}
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {}
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
            override fun onDiscoveryStopped(serviceType: String) {}

            override fun onServiceFound(service: NsdServiceInfo) {
                nsdManager.resolveService(service, object : NsdManager.ResolveListener {
                    override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) {}
                    override fun onServiceResolved(info: NsdServiceInfo) {
                        val peer = Peer(info.serviceName, info.host.hostAddress ?: return, info.port)
                        peers[peer.nodeId] = peer
                        onPeerFound(peer)
                    }
                })
            }

            override fun onServiceLost(service: NsdServiceInfo) {
                peers.remove(service.serviceName)
            }
        }
        nsdManager.discoverServices(serviceType, NsdManager.PROTOCOL_DNS_SD, discoveryListener)
    }

    fun stop() {
        try { discoveryListener?.let { nsdManager.stopServiceDiscovery(it) } } catch (_: Exception) {}
        try { registrationListener?.let { nsdManager.unregisterService(it) } } catch (_: Exception) {}
    }
}
