package com.decentstorage.app.network

import org.json.JSONArray
import java.net.URL

/**
 * Estratégia pra descoberta de peers FORA da rede local (pela internet).
 *
 * Isso é o ponto que precisa ser dito com clareza: NÃO existe P2P real pela internet
 * com "zero infraestrutura". Todo sistema sério tem algum mecanismo de rendezvous:
 *   - BitTorrent: trackers + DHT com nós de bootstrap hardcoded no cliente
 *   - IPFS/libp2p: lista de "bootstrap nodes" hardcoded
 *   - WebRTC: servidor STUN/TURN pra atravessar NAT
 * A diferença entre isso e um "servidor centralizado" tradicional é que aqui o bootstrap
 * NÃO guarda nem transporta dado nenhum — só ajuda dois peers a se acharem. Qualquer
 * pessoa pode rodar um (é só uma lista de endereços), e a rede sobrevive mesmo que um
 * bootstrap específico caia, desde que exista pelo menos um outro no ar ou que os peers
 * já se conheçam de uma sessão anterior (cache local).
 *
 * O que falta pra isso funcionar de verdade em produção (não implementado aqui, é
 * trabalho de infra separado):
 *   - NAT traversal (STUN, e TURN como fallback quando STUN falha)
 *   - Persistir peers conhecidos localmente entre execuções do app (hoje só em memória)
 *   - Um formato de bootstrap list assinado, pra evitar poisoning por endereço falso
 */
object BootstrapPeerList {

    data class BootstrapEntry(val nodeId: String, val host: String, val port: Int)

    /**
     * Busca uma lista de peers "sempre ligados" a partir de uma URL simples (JSON estático
     * ou dinâmico, hospedado onde for mais conveniente — GitHub raw, S3, o que for).
     * Formato esperado: [{"nodeId":"...","host":"...","port":1234}, ...]
     */
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

    /** Lista fixa opcional pra embutir no app (ex: alguns nós próprios rodando 24/7 no início). */
    fun hardcoded(): List<BootstrapEntry> = emptyList()
}
