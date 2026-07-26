package com.decentstorage.app

import android.content.SharedPreferences
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.decentstorage.app.crypto.KeyManager
import com.decentstorage.app.network.GossipRegistry
import com.decentstorage.app.network.PeerDiscovery
import com.decentstorage.app.network.ShardRequestHandler
import com.decentstorage.app.network.ShardServer
import com.decentstorage.app.network.webrtc.SignalingClient
import com.decentstorage.app.network.webrtc.WebRtcManager
import com.decentstorage.app.wallet.SolanaWallet
import org.json.JSONObject
import org.sol4k.RpcUrl
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.security.SecureRandom

/**
 * Tela única, funcional, pra exercitar o fluxo de ponta a ponta:
 *   gerar/importar seed -> subir ShardServer local -> descobrir peers (NSD)
 *   -> derivar wallet Solana -> upload de arquivo -> download de arquivo.
 * Não é a UI final do produto — é o suficiente pra provar que a base funciona
 * de verdade num dispositivo Android real.
 */
class MainActivity : ComponentActivity() {

    private lateinit var prefs: SharedPreferences
    private var registry: GossipRegistry? = null
    private var shardServer: ShardServer? = null
    private var discovery: PeerDiscovery? = null
    private var storageClient: StorageClient? = null
    private var masterKey: ByteArray? = null
    private var wallet: SolanaWallet? = null
    private var signalingClient: SignalingClient? = null
    private var webRtcManager: WebRtcManager? = null
    private var selfNodeId: String? = null
    private var selfCapacityBytes: Long = 0L
    private var selfDataDir: File? = null

    private val pickFile = registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        uri?.let { onFilePicked(it) }
    }

    private var pendingFilePickedCallback: ((android.net.Uri) -> Unit)? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = getSharedPreferences("decentstorage", MODE_PRIVATE)

        setContent {
            MaterialTheme { AppScreen() }
        }
    }

    private fun onFilePicked(uri: android.net.Uri) {
        pendingFilePickedCallback?.invoke(uri)
        pendingFilePickedCallback = null
    }

    @Composable
    fun AppScreen() {
        var seedPhrase by remember { mutableStateOf(prefs.getString("seed", "") ?: "") }
        var log by remember { mutableStateOf("") }
        var walletAddress by remember { mutableStateOf("") }
        var balanceLamports by remember { mutableStateOf(-1L) }
        var networkStarted by remember { mutableStateOf(false) }
        var lastUploadedFileId by remember { mutableStateOf("") }
        var signalingUrl by remember { mutableStateOf(prefs.getString("signalingUrl", "wss://seu-signaling.exemplo.com") ?: "") }
        var wanConnected by remember { mutableStateOf(false) }
        var wanPeerNodeId by remember { mutableStateOf("") }
        var kText by remember { mutableStateOf("6") }
        var mText by remember { mutableStateOf("4") }
        val scope = rememberCoroutineScope()

        fun appendLog(msg: String) { log = "$msg\n$log" }

        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Text("Armazenamento Descentralizado", style = MaterialTheme.typography.titleLarge)

            OutlinedTextField(
                value = seedPhrase,
                onValueChange = { seedPhrase = it },
                label = { Text("Seed phrase (12 palavras)") },
                modifier = Modifier.fillMaxWidth()
            )

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = {
                    seedPhrase = KeyManager.generateSeedPhrase()
                    prefs.edit().putString("seed", seedPhrase).apply()
                    appendLog("Seed gerada. GUARDE essas 12 palavras fora do app — sem elas você perde acesso pra sempre.")
                }) { Text("Gerar nova seed") }

                Button(onClick = {
                    if (!KeyManager.validateSeedPhrase(seedPhrase)) {
                        appendLog("Seed phrase inválida.")
                        return@Button
                    }
                    prefs.edit().putString("seed", seedPhrase).apply()
                    masterKey = KeyManager.deriveMasterKey(seedPhrase)
                    val seed64 = KeyManager.seedBytes(seedPhrase)
                    wallet = SolanaWallet.fromSeedPhrase(seed64, rpcUrl = RpcUrl.DEVNET)
                    walletAddress = wallet!!.publicKey.toString()
                    appendLog("Chaves derivadas. Endereço da wallet: $walletAddress")
                }) { Text("Usar essa seed") }
            }

            Button(onClick = {
                val nodeId = prefs.getString("nodeId", null) ?: run {
                    val id = "node-" + ByteArray(4).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
                    prefs.edit().putString("nodeId", id).apply()
                    id
                }
                val port = 5000 + (nodeId.hashCode() and 0xFF)
                val dataDir = File(filesDir, "shards")
                val capacityBytes = 500L * 1024 * 1024 // tier free: 500MB, ajuste por tier/pagamento
                selfNodeId = nodeId
                selfCapacityBytes = capacityBytes
                selfDataDir = dataDir

                val reg = GossipRegistry(nodeId, "0.0.0.0", port, capacityBytes)
                registry = reg
                storageClient = StorageClient(reg)

                val server = ShardServer(nodeId, port, capacityBytes, dataDir, onGossip = { reg.handleIncomingGossip(it) })
                server.start()
                shardServer = server

                val disc = PeerDiscovery(this@MainActivity)
                disc.advertiseSelf(nodeId, port)
                disc.startDiscovery { peer -> reg.addOrUpdatePeer(peer.nodeId, peer.host, peer.port) }
                discovery = disc

                reg.start()
                networkStarted = true
                appendLog("Rede iniciada: nó $nodeId na porta $port (tier free: 500MB). Descobrindo peers na rede local...")
            }, enabled = !networkStarted) { Text("Entrar na rede (LAN)") }

            Divider()
            Text("Conexão pela internet (WAN)", style = MaterialTheme.typography.titleMedium)
            Text(
                "Sem isso, PeerDiscovery (NSD) só acha peers na mesma Wi-Fi. Aqui usa o " +
                        "signaling server (troca só SDP/ICE, nunca bytes de arquivo) + WebRTC pra " +
                        "conectar direto com um peer em qualquer rede.",
                style = MaterialTheme.typography.bodySmall
            )
            OutlinedTextField(
                value = signalingUrl,
                onValueChange = { signalingUrl = it },
                label = { Text("URL do signaling (wss://...)") },
                modifier = Modifier.fillMaxWidth()
            )
            Button(onClick = {
                val nodeId = selfNodeId
                val dataDir = selfDataDir
                if (nodeId == null || dataDir == null) {
                    appendLog("Entre na rede (LAN) primeiro — precisa do nodeId/porta/capacidade já definidos.")
                    return@Button
                }
                prefs.edit().putString("signalingUrl", signalingUrl).apply()

                val handler = ShardRequestHandler(nodeId, selfCapacityBytes, dataDir) { payload ->
                    registry?.handleIncomingGossip(payload) ?: JSONObject().put("ok", false)
                }

                lateinit var mgr: WebRtcManager
                val signaling = SignalingClient(
                    serverUrl = signalingUrl,
                    selfNodeId = nodeId,
                    onSignal = { _, _ -> }, // placeholder, substituído logo abaixo
                    onStateChange = { connected -> wanConnected = connected }
                )
                mgr = WebRtcManager(
                    context = this@MainActivity,
                    signalingClient = signaling,
                    selfNodeId = nodeId,
                    requestHandler = handler,
                    onTransportReady = { peerNodeId, transport ->
                        registry?.attachWanTransport(peerNodeId, transport)
                        appendLog("WAN conectado com $peerNodeId (DataChannel aberto)")
                    },
                    onTransportClosed = { peerNodeId ->
                        registry?.detachWanTransport(peerNodeId)
                        appendLog("WAN caiu com $peerNodeId")
                    }
                )
                signaling.onSignal = { from, payload -> mgr.handleSignal(from, payload) }
                signaling.connect()
                signalingClient = signaling
                webRtcManager = mgr
                appendLog("Registrado no signaling como $nodeId. Pronto pra conectar com um peer por nodeId.")
            }, enabled = selfNodeId != null && signalingClient == null) { Text("Conectar ao signaling") }

            if (signalingClient != null) {
                Text(if (wanConnected) "Signaling: conectado" else "Signaling: desconectado")
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = wanPeerNodeId,
                        onValueChange = { wanPeerNodeId = it },
                        label = { Text("nodeId do peer (WAN)") },
                        modifier = Modifier.weight(1f)
                    )
                    Button(onClick = {
                        if (wanPeerNodeId.isBlank()) return@Button
                        webRtcManager?.connectToPeer(wanPeerNodeId)
                        appendLog("Oferta WebRTC enviada pra $wanPeerNodeId, aguardando resposta...")
                    }) { Text("Conectar") }
                }
            }

            if (walletAddress.isNotEmpty()) {
                Text("Wallet: $walletAddress")
                Button(onClick = {
                    scope.launch {
                        val bal = withContext(Dispatchers.IO) { wallet!!.getBalanceLamports() }
                        balanceLamports = bal
                    }
                }) { Text("Consultar saldo (devnet)") }
                if (balanceLamports >= 0) Text("Saldo: ${balanceLamports / 1_000_000_000.0} SOL")
            }

            Divider()

            Divider()
            Text("Redundância (K de N)", style = MaterialTheme.typography.titleMedium)
            Text(
                "N = K+M peers recebem um pedaço; QUALQUER K deles reconstrói o arquivo. " +
                        "Default (6+4=10) é pra rede grande — em teste com poucos aparelhos, baixe " +
                        "os dois números (ex: K=1, M=1 funciona com só 2 peers vivos).",
                style = MaterialTheme.typography.bodySmall
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = kText,
                    onValueChange = { kText = it.filter(Char::isDigit) },
                    label = { Text("K (dados)") },
                    modifier = Modifier.weight(1f)
                )
                OutlinedTextField(
                    value = mText,
                    onValueChange = { mText = it.filter(Char::isDigit) },
                    label = { Text("M (paridade)") },
                    modifier = Modifier.weight(1f)
                )
            }
            if (networkStarted) {
                val alivePeers = registry?.knownPeers()?.count { it.alive } ?: 0
                Text("Peers vivos conhecidos agora (sem contar este aparelho): $alivePeers", style = MaterialTheme.typography.bodySmall)
            }

            Button(onClick = {
                pendingFilePickedCallback = { uri ->
                    scope.launch {
                        try {
                            val k = kText.toIntOrNull()
                            val m = mText.toIntOrNull()
                            if (k == null || k < 1 || m == null || m < 0) {
                                appendLog("K/M inválidos — K precisa ser >= 1, M >= 0.")
                                return@launch
                            }
                            val bytes = withContext(Dispatchers.IO) {
                                contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: ByteArray(0)
                            }
                            val name = uri.lastPathSegment ?: "arquivo"
                            val result = withContext(Dispatchers.IO) {
                                storageClient!!.uploadFile(bytes, name, masterKey!!, k = k, m = m)
                            }
                            lastUploadedFileId = result.fileId
                            appendLog("Upload OK. fileId=${result.fileId} distribuído em ${result.n} peers (K=${result.k})")
                        } catch (e: Exception) {
                            appendLog("Erro no upload: ${e.message}")
                        }
                    }
                }
                pickFile.launch("*/*")
            }, enabled = networkStarted && masterKey != null) { Text("Escolher e enviar arquivo") }

            if (lastUploadedFileId.isNotEmpty()) {
                Text("Último fileId: $lastUploadedFileId")
                Button(onClick = {
                    scope.launch {
                        try {
                            val plaintext = withContext(Dispatchers.IO) {
                                storageClient!!.downloadFile(lastUploadedFileId, masterKey!!)
                            }
                            val out = File(getExternalFilesDir(null), "baixado_${lastUploadedFileId.take(8)}")
                            out.writeBytes(plaintext)
                            appendLog("Download OK, ${plaintext.size} bytes salvos em ${out.absolutePath}")
                        } catch (e: Exception) {
                            appendLog("Erro no download: ${e.message}")
                        }
                    }
                }) { Text("Baixar de volta (teste)") }
            }

            Divider()
            Text("Log:", style = MaterialTheme.typography.titleMedium)
            Text(log)
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        discovery?.stop()
        registry?.stop()
        shardServer?.stop()
        webRtcManager?.disconnectAll()
        signalingClient?.disconnect()
    }
}
