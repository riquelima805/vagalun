package com.decentstorage.app

import android.content.SharedPreferences
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.decentstorage.app.crypto.KeyManager
import com.decentstorage.app.network.GossipRegistry
import com.decentstorage.app.network.PeerDiscovery
import com.decentstorage.app.network.ShardRequestHandler
import com.decentstorage.app.network.ShardServer
import com.decentstorage.app.network.webrtc.SignalingClient
import com.decentstorage.app.network.webrtc.WebRtcManager
import com.decentstorage.app.storage.DeviceStorage
import com.decentstorage.app.wallet.AnchorStorageClient
import com.decentstorage.app.wallet.SolanaWallet
import com.decentstorage.app.work.DailyClaimWorker
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.security.SecureRandom
import androidx.compose.foundation.clickable
import androidx.compose.ui.graphics.asImageBitmap


object VagalunColors {
    val bg = Color(0xFF0B0E13)
    val bgCard = Color(0xFF141924)
    val bgCard2 = Color(0xFF1B2230)
    val neonGreen = Color(0xFF00FFA3)
    val neonCyan = Color(0xFF00E5FF)
    val textPrimary = Color(0xFFE7F3F0)
    val textSecondary = Color(0xFF8A97A8)
    val danger = Color(0xFFFF5C5C)
    val warning = Color(0xFFFFC24B)
}


data class UiFileEntry(
    val fileId: String,
    val fileName: String,
    val sizeBytes: Long,
    val mimeType: String,
    val k: Int,
    val n: Int,
    val localBytes: ByteArray? = null
)

enum class HealthState { HEALTHY, DEGRADED, CRITICAL }

class MainActivity : ComponentActivity() {

    private lateinit var prefs: SharedPreferences

    private var registry: GossipRegistry? = null
    private var shardServer: ShardServer? = null
    private var discovery: PeerDiscovery? = null
    private var storageClient: StorageClient? = null
    private var masterKey: ByteArray? = null
    private var wallet: SolanaWallet? = null
    private var anchorClient: AnchorStorageClient? = null
    private var signalingClient: SignalingClient? = null
    private var webRtcManager: WebRtcManager? = null
    private var selfNodeId: String? = null
    
    private var selfCapacityBytes: Long = 15L * 1024 * 1024 * 1024
    private var selfDataDir: File? = null
    
    private var selfSignalingUrl: String = ""

    private var pendingFilePickedCallback: ((Uri) -> Unit)? = null
    private val pickFile = registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        uri?.let { pendingFilePickedCallback?.invoke(it); pendingFilePickedCallback = null }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = getSharedPreferences("decentstorage", MODE_PRIVATE)
        selfCapacityBytes = prefs.getLong("quotaBytes", selfCapacityBytes)
        
        selfCapacityBytes = ensureQuotaWithinPhysicalLimits(selfCapacityBytes)
        selfSignalingUrl = prefs.getString("signalingUrl", "") ?: ""

        setContent {
            MaterialTheme(colorScheme = darkColorScheme(
                background = VagalunColors.bg,
                surface = VagalunColors.bgCard,
                primary = VagalunColors.neonGreen,
                secondary = VagalunColors.neonCyan
            )) {
                VagalunApp()
            }
        }
    }

    private fun ensureQuotaWithinPhysicalLimits(requested: Long): Long {
        val maxOfferable = DeviceStorage.maxOfferableBytes(this)
        return requested.coerceAtMost(maxOfferable).coerceAtLeast(1L * 1024 * 1024) 
    }

    private fun ensureEngineStarted(seedPhrase: String, onReady: (walletAddr: String) -> Unit, onLog: (String) -> Unit) {
        if (registry != null) return
        val seedBytes = KeyManager.seedBytes(seedPhrase)
        masterKey = KeyManager.deriveMasterKey(seedPhrase)
        val nodeId = "node-" + SecureRandom().nextInt(1_000_000)
        selfNodeId = nodeId
        selfDataDir = File(filesDir, "shards").also { it.mkdirs() }

        val requestHandler = ShardRequestHandler(nodeId, selfCapacityBytes, selfDataDir!!, applicationContext) { gossipPayload ->
            registry?.handleIncomingGossip(gossipPayload) ?: JSONObject()
        }

        val reg = GossipRegistry(nodeId, "127.0.0.1", 8901, selfCapacityBytes)
        registry = reg
        reg.start()

        shardServer = ShardServer(nodeId, 8901, selfCapacityBytes, selfDataDir!!, applicationContext).also {
            it.start()
        }

        discovery = PeerDiscovery(this).also { disc ->
            disc.advertiseSelf(nodeId, 8901)
            disc.startDiscovery { peer -> reg.addOrUpdatePeer(peer.nodeId, peer.host, peer.port) }
        }

        storageClient = StorageClient(reg)

        wallet = SolanaWallet.fromSeedPhrase(seedBytes)
        anchorClient = AnchorStorageClient(wallet!!)

        DailyClaimWorker.schedule(applicationContext)

        if (selfSignalingUrl.isNotBlank()) {
            connectWan(selfSignalingUrl, onLog)
        } else {
            onLog("Nenhum servidor de signaling configurado — rodando só na Wi-Fi local. Configure em Config > Rede.")
        }

        onLog("Motor iniciado. nodeId=$nodeId")
        onReady(wallet!!.publicKey.toString())
    }

    private fun connectWan(signalingUrl: String, onLog: (String) -> Unit) {
        val nodeId = selfNodeId ?: return
        disconnectWan()

        val reqHandler = ShardRequestHandler(nodeId, selfCapacityBytes, selfDataDir!!, applicationContext) { gossipPayload ->
            registry?.handleIncomingGossip(gossipPayload) ?: JSONObject()
        }
        val sc = SignalingClient(signalingUrl, nodeId, onSignal = { _, _ -> }) { connected ->
            onLog(if (connected) "Signaling conectado (WAN ativa)" else "Signaling desconectado")
        }
        signalingClient = sc

        // O TURN foi removido - agora usamos apenas STUN público e (futuramente) Relay
        val mgr = WebRtcManager(
            context = this,
            signalingClient = sc,
            selfNodeId = nodeId,
            requestHandler = reqHandler,
            onTransportReady = { peerId, transport -> registry?.attachWanTransport(peerId, transport) },
            onTransportClosed = { peerId -> registry?.detachWanTransport(peerId) },
            iceServers = WebRtcManager.defaultIceServers()
        )
        webRtcManager = mgr
        sc.onSignal = { from, payload -> mgr.handleSignal(from, payload) }
        sc.connect()
    }

    private fun disconnectWan() {
        webRtcManager?.disconnectAll()
        signalingClient?.disconnect()
        webRtcManager = null
        signalingClient = null
    }

    private fun pickFileForUpload(callback: (Uri) -> Unit) {
        pendingFilePickedCallback = callback
        pickFile.launch("*/*")
    }

    @Composable
    fun VagalunApp() {
        val navController = rememberNavController()
        var hasWallet by remember { mutableStateOf(prefs.getString("seed", null) != null) }
        var seedPhrase by remember { mutableStateOf(prefs.getString("seed", "") ?: "") }
        var walletAddress by remember { mutableStateOf("") }
        var nodeActive by remember { mutableStateOf(false) }
        var logLines by remember { mutableStateOf(listOf<String>()) }
        var files by remember { mutableStateOf(listOf<UiFileEntry>()) }
        var startedAt by remember { mutableStateOf(0L) }
        var quotaGb by remember { mutableStateOf((selfCapacityBytes / (1024L * 1024 * 1024)).toInt().coerceAtLeast(1)) }
        var wifiOnly by remember { mutableStateOf(prefs.getBoolean("wifiOnly", true)) }
        var backgroundSync by remember { mutableStateOf(prefs.getBoolean("bgSync", true)) }
        val scope = rememberCoroutineScope()

        fun log(msg: String) { logLines = (listOf(msg) + logLines).take(50) }

        fun startNode() {
            if (nodeActive) return
            scope.launch {
                withContext(Dispatchers.IO) {
                    try {
                        ensureEngineStarted(seedPhrase, onReady = { addr ->
                            walletAddress = addr
                        }, onLog = { log(it) })
                        startedAt = System.currentTimeMillis()
                        nodeActive = true
                    } catch (e: Exception) {
                        log("Erro ao iniciar: ${e.message}")
                    }
                }
            }
        }

        if (!hasWallet) {
            WalletOnboardingScreen(
                onSeedReady = { phrase ->
                    prefs.edit().putString("seed", phrase).apply()
                    seedPhrase = phrase
                    hasWallet = true
                    startNode()
                }
            )
            return
        }

        LaunchedEffect(Unit) { startNode() }

        Scaffold(
            containerColor = VagalunColors.bg,
            bottomBar = { VagalunBottomBar(navController) }
        ) { padding ->
            NavHost(navController, startDestination = "dashboard", modifier = Modifier.padding(padding)) {
                composable("dashboard") {
                    DashboardScreen(
                        nodeActive = nodeActive,
                        onToggleNode = { turningOn ->
                            if (turningOn) {
                                startNode()
                                if (selfSignalingUrl.isNotBlank()) {
                                    scope.launch(Dispatchers.IO) { connectWan(selfSignalingUrl) { log(it) } }
                                }
                            } else {
                                disconnectWan()
                                nodeActive = false
                                log("Node desativado — desconectado da WAN (continua descobrível na Wi-Fi local via NSD).")
                            }
                        },
                        peersCount = registry?.knownPeers()?.size ?: 0,
                        uptimeMs = if (startedAt > 0) System.currentTimeMillis() - startedAt else 0,
                        walletAddress = walletAddress,
                        capacityGb = quotaGb,
                        usedFiles = files.size,
                        onNavFiles = { navController.navigate("files") },
                        logLines = logLines
                    )
                }
                composable("files") {
                    FilesScreen(
                        files = files,
                        onUpload = {
                            pickFileForUpload { uri ->
                                scope.launch {
                                    withContext(Dispatchers.IO) {
                                        try {
                                            val bytes = contentResolver.openInputStream(uri)?.readBytes() ?: return@withContext
                                            val name = uri.lastPathSegment ?: "arquivo_${System.currentTimeMillis()}"
                                            val mk = masterKey ?: return@withContext
                                            val result = storageClient?.uploadFile(bytes, name, mk) ?: return@withContext
                                            files = files + UiFileEntry(
                                                fileId = result.fileId,
                                                fileName = name,
                                                sizeBytes = bytes.size.toLong(),
                                                mimeType = contentResolver.getType(uri) ?: "application/octet-stream",
                                                k = result.k, n = result.n
                                            )
                                            log("Upload ok: $name (${result.peerIds.size} peers)")
                                        } catch (e: Exception) {
                                            log("Falha no upload: ${e.message}")
                                        }
                                    }
                                }
                            }
                        },
                        onDelete = { entry ->
                            files = files.filter { it.fileId != entry.fileId }
                            log("Arquivo removido: ${entry.fileId}")
                        },
                        onOpen = { entry, onLoaded ->
                            scope.launch {
                                withContext(Dispatchers.IO) {
                                    try {
                                        val mk = masterKey ?: return@withContext
                                        val data = storageClient?.downloadFile(entry.fileId, mk) ?: return@withContext
                                        withContext(Dispatchers.Main) { onLoaded(data) }
                                    } catch (e: Exception) {
                                        log("Falha ao abrir: ${e.message}")
                                    }
                                }
                            }
                        },
                        navController = navController
                    )
                }
                composable("player/{fileId}/{mime}") { backStackEntry ->
                    val fileId = backStackEntry.arguments?.getString("fileId") ?: ""
                    val mime = backStackEntry.arguments?.getString("mime") ?: ""
                    val entry = files.find { it.fileId == fileId }
                    MediaViewerScreen(
                        entry = entry,
                        mimeType = mime,
                        onLoadBytes = { onLoaded ->
                            scope.launch {
                                withContext(Dispatchers.IO) {
                                    try {
                                        val mk = masterKey ?: return@withContext
                                        val data = storageClient?.downloadFile(fileId, mk) ?: return@withContext
                                        withContext(Dispatchers.Main) { onLoaded(data) }
                                    } catch (e: Exception) {
                                        log("Falha ao carregar mídia: ${e.message}")
                                    }
                                }
                            }
                        },
                        onReport = { log("fileId $fileId denunciado — bloqueado localmente") },
                        onBack = { navController.popBackStack() }
                    )
                }
                composable("settings") {
                    var signalingUrlField by remember { mutableStateOf(selfSignalingUrl) }
                    SettingsScreen(
                        quotaGb = quotaGb,
                        maxOfferableGb = DeviceStorage.maxOfferableGb(this@MainActivity),
                        onQuotaChange = { newGb ->
                            val maxGb = DeviceStorage.maxOfferableGb(this@MainActivity)
                            val clamped = newGb.coerceAtMost(maxGb).coerceAtLeast(1)
                            quotaGb = clamped
                            selfCapacityBytes = clamped.toLong() * 1024 * 1024 * 1024
                            prefs.edit().putLong("quotaBytes", selfCapacityBytes).apply()
                        },
                        wifiOnly = wifiOnly,
                        onWifiOnlyChange = { wifiOnly = it; prefs.edit().putBoolean("wifiOnly", it).apply() },
                        backgroundSync = backgroundSync,
                        onBackgroundSyncChange = { backgroundSync = it; prefs.edit().putBoolean("bgSync", it).apply() },
                        onClearDeadShards = {
                            val dir = selfDataDir
                            var freed = 0L
                            dir?.listFiles()?.forEach { f -> freed += f.length(); f.delete() }
                            log("Cache limpo: ${freed / 1024} KB liberados")
                        },
                        signalingUrl = signalingUrlField,
                        onSignalingUrlChange = { signalingUrlField = it },
                        onSignalingUrlSave = {
                            selfSignalingUrl = signalingUrlField.trim()
                            prefs.edit().putString("signalingUrl", selfSignalingUrl).apply()
                            if (nodeActive && selfSignalingUrl.isNotBlank()) {
                                scope.launch(Dispatchers.IO) { connectWan(selfSignalingUrl) { log(it) } }
                                log("Reconectando WAN com nova URL...")
                            }
                        }
                    )
                }
                composable("wallet") {
                    WalletScreen(
                        seedPhrase = seedPhrase,
                        walletAddress = walletAddress,
                        wallet = wallet,
                        anchorClient = anchorClient,
                        scope = scope,
                        onLog = { log(it) }
                    )
                }
            }
        }
    }
}


@Composable
fun VagalunBottomBar(navController: NavHostController) {
    val backStackEntry by navController.currentBackStackEntryAsState()
    val current = backStackEntry?.destination?.route ?: "dashboard"

    NavigationBar(containerColor = VagalunColors.bgCard) {
        val items = listOf(
            Triple("dashboard", "Início", Icons.Filled.Home),
            Triple("files", "Arquivos", Icons.Filled.Folder),
            Triple("settings", "Config", Icons.Filled.Settings),
            Triple("wallet", "Carteira", Icons.Filled.AccountBalanceWallet)
        )
        items.forEach { (route, label, icon) ->
            NavigationBarItem(
                selected = current == route,
                onClick = { if (current != route) navController.navigate(route) { launchSingleTop = true } },
                icon = { Icon(icon, contentDescription = label) },
                label = { Text(label, fontSize = 11.sp) },
                colors = NavigationBarItemDefaults.colors(
                    selectedIconColor = VagalunColors.neonGreen,
                    selectedTextColor = VagalunColors.neonGreen,
                    unselectedIconColor = VagalunColors.textSecondary,
                    unselectedTextColor = VagalunColors.textSecondary,
                    indicatorColor = VagalunColors.bgCard2
                )
            )
        }
    }
}


@Composable
fun DashboardScreen(
    nodeActive: Boolean,
    onToggleNode: (Boolean) -> Unit,
    peersCount: Int,
    uptimeMs: Long,
    walletAddress: String,
    capacityGb: Int,
    usedFiles: Int,
    onNavFiles: () -> Unit,
    logLines: List<String> = emptyList()
) {
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("", fontSize = 28.sp)
            Spacer(Modifier.width(8.dp))
            Text("VAGALUN", color = VagalunColors.neonGreen, fontSize = 24.sp, fontWeight = FontWeight.Bold)
        }

        // ---- Status do nó ----
        Card(
            colors = CardDefaults.cardColors(containerColor = VagalunColors.bgCard),
            shape = RoundedCornerShape(20.dp),
            modifier = Modifier.fillMaxWidth()
        ) {
            Row(
                Modifier.padding(20.dp).fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column {
                    Text(
                        if (nodeActive) "Ativo" else "Adormecido",
                        color = VagalunColors.textPrimary, fontWeight = FontWeight.Bold, fontSize = 16.sp
                    )
                    Text(
                        if (nodeActive) "Participando da rede agora" else "Toque para ativar",
                        color = VagalunColors.textSecondary, fontSize = 12.sp
                    )
                }
                Switch(
                    checked = nodeActive,
                    onCheckedChange = onToggleNode,
                    colors = SwitchDefaults.colors(
                        checkedThumbColor = VagalunColors.neonGreen,
                        checkedTrackColor = VagalunColors.neonGreen.copy(alpha = 0.35f)
                    )
                )
            }
        }

        // ---- Estatísticas de rede (peers e uptime são reais; SOL do dia vem da carteira, ver aba Carteira) ----
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            StatChip(Modifier.weight(1f), " $peersCount", "Nodes ativos")
            StatChip(Modifier.weight(1f), formatUptime(uptimeMs), "uptime")
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            StatChip(Modifier.weight(1f), "$usedFiles", "arquivos na nuvem")
            StatChip(Modifier.weight(1f), "$capacityGb GB", "cota cedida")
        }

        if (walletAddress.isNotEmpty()) {
            Text(
                "Carteira: ${walletAddress.take(6)}...${walletAddress.takeLast(4)}",
                color = VagalunColors.textSecondary, fontSize = 12.sp
            )
        }

        Button(
            onClick = onNavFiles,
            colors = ButtonDefaults.buttonColors(containerColor = VagalunColors.neonGreen),
            shape = RoundedCornerShape(14.dp),
            modifier = Modifier.fillMaxWidth().height(52.dp)
        ) {
            Text("Ver meus arquivos", color = Color.Black, fontWeight = FontWeight.Bold)
        }

        // ---- Painel de log (mostra o que estava só sendo gravado internamente antes) ----
        if (logLines.isNotEmpty()) {
            Card(
                colors = CardDefaults.cardColors(containerColor = VagalunColors.bgCard),
                shape = RoundedCornerShape(16.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(Modifier.padding(16.dp)) {
                    Text(
                        "Log do sistema",
                        color = VagalunColors.textSecondary,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold
                    )
                    Spacer(Modifier.height(8.dp))
                    logLines.take(15).forEach { line ->
                        Text(
                            line,
                            color = VagalunColors.textSecondary,
                            fontSize = 11.sp,
                            modifier = Modifier.padding(vertical = 2.dp)
                        )
                    }
                }
            }
        }
    }
}

@Composable
fun StatChip(modifier: Modifier = Modifier, value: String, label: String) {
    Card(
        modifier = modifier,
        colors = CardDefaults.cardColors(containerColor = VagalunColors.bgCard),
        shape = RoundedCornerShape(16.dp)
    ) {
        Column(Modifier.padding(16.dp)) {
            Text(value, color = VagalunColors.neonCyan, fontWeight = FontWeight.Bold, fontSize = 18.sp)
            Text(label, color = VagalunColors.textSecondary, fontSize = 11.sp)
        }
    }
}

fun formatUptime(ms: Long): String {
    val totalMin = ms / 60000
    val h = totalMin / 60
    val m = totalMin % 60
    return "${h}h${m}m"
}


@Composable
fun FilesScreen(
    files: List<UiFileEntry>,
    onUpload: () -> Unit,
    onDelete: (UiFileEntry) -> Unit,
    onOpen: (UiFileEntry, (ByteArray) -> Unit) -> Unit,
    navController: NavHostController
) {
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().padding(16.dp)) {
            Text("Meus Arquivos", color = VagalunColors.textPrimary, fontSize = 22.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(4.dp))
            Text("${files.size} arquivo(s) na rede", color = VagalunColors.textSecondary, fontSize = 12.sp)
            Spacer(Modifier.height(16.dp))

            if (files.isEmpty()) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text("Nenhum arquivo ainda.\nToque em + para enviar.", color = VagalunColors.textSecondary, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                }
            } else {
                LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    items(files) { entry ->
                        FileRow(
                            entry = entry,
                            onClick = {
                                if (entry.mimeType.startsWith("image") || entry.mimeType.startsWith("video")) {
                                    navController.navigate("player/${entry.fileId}/${Uri.encode(entry.mimeType)}")
                                } else {
                                    onOpen(entry) { /* poderia disparar um "Salvar como" aqui */ }
                                }
                            },
                            onDelete = { onDelete(entry) }
                        )
                    }
                }
            }
        }

        FloatingActionButton(
            onClick = onUpload,
            containerColor = VagalunColors.neonGreen,
            modifier = Modifier.align(Alignment.BottomEnd).padding(20.dp)
        ) {
            Icon(Icons.Filled.Add, contentDescription = "Enviar arquivo", tint = Color.Black)
        }
    }
}

@Composable
fun FileRow(entry: UiFileEntry, onClick: () -> Unit, onDelete: () -> Unit) {
    var showConfirm by remember { mutableStateOf(false) }
    val health = if (entry.k <= entry.n - 2) HealthState.HEALTHY else if (entry.k < entry.n) HealthState.DEGRADED else HealthState.CRITICAL
    val healthColor = when (health) {
        HealthState.HEALTHY -> VagalunColors.neonGreen
        HealthState.DEGRADED -> VagalunColors.warning
        HealthState.CRITICAL -> VagalunColors.danger
    }

    Card(
        colors = CardDefaults.cardColors(containerColor = VagalunColors.bgCard),
        shape = RoundedCornerShape(16.dp),
        modifier = Modifier.fillMaxWidth()
    ) {
        Row(
            Modifier.fillMaxWidth().padding(14.dp).clip(RoundedCornerShape(16.dp)),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(
                when {
                    entry.mimeType.startsWith("video") -> Icons.Filled.Movie
                    entry.mimeType.startsWith("image") -> Icons.Filled.Image
                    entry.mimeType.startsWith("audio") -> Icons.Filled.MusicNote
                    else -> Icons.Filled.InsertDriveFile
                },
                contentDescription = null,
                tint = VagalunColors.neonCyan,
                modifier = Modifier.size(28.dp)
            )
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f).clickableSimple(onClick)) {
                Text(entry.fileName, color = VagalunColors.textPrimary, fontSize = 14.sp, maxLines = 1)
                Text("${entry.sizeBytes / 1024} KB · K=${entry.k} M=${entry.n - entry.k}", color = VagalunColors.textSecondary, fontSize = 11.sp)
            }
            Box(Modifier.size(10.dp).clip(CircleShape).background(healthColor))
            Spacer(Modifier.width(12.dp))
            IconButton(onClick = { showConfirm = true }) {
                Icon(Icons.Filled.Delete, contentDescription = "Excluir", tint = VagalunColors.danger)
            }
        }
    }

    if (showConfirm) {
        AlertDialog(
            onDismissRequest = { showConfirm = false },
            title = { Text("Excluir arquivo?") },
            text = { Text("Isso encerra o pagamento do contrato e avisa a rede (gossip) para liberar o espaço nos outros peers.") },
            confirmButton = {
                TextButton(onClick = { showConfirm = false; onDelete() }) { Text("Excluir", color = VagalunColors.danger) }
            },
            dismissButton = { TextButton(onClick = { showConfirm = false }) { Text("Cancelar") } }
        )
    }
}


fun Modifier.clickableSimple(onClick: () -> Unit): Modifier =
    this.clickable(onClick = onClick)


@Composable
fun MediaViewerScreen(
    entry: UiFileEntry?,
    mimeType: String,
    onLoadBytes: ((ByteArray) -> Unit) -> Unit,
    onReport: () -> Unit,
    onBack: () -> Unit
) {
    var bytes by remember { mutableStateOf<ByteArray?>(entry?.localBytes) }
    var loading by remember { mutableStateOf(bytes == null) }

    LaunchedEffect(entry?.fileId) {
        if (bytes == null) {
            onLoadBytes { data -> bytes = data; loading = false }
        }
    }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        when {
            loading -> Column(
                Modifier.align(Alignment.Center),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                CircularProgressIndicator(color = VagalunColors.neonGreen)
                Spacer(Modifier.height(12.dp))
                Text("Buscando shards na rede...", color = VagalunColors.textSecondary)
            }
            mimeType.startsWith("image") && bytes != null -> {
                val bmp = remember(bytes) {
                    android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes!!.size)
                }
                if (bmp != null) {
    androidx.compose.foundation.Image(
        bitmap = bmp.asImageBitmap(),
        contentDescription = entry?.fileName,
        modifier = Modifier.fillMaxSize()
    )
}
            }
            mimeType.startsWith("video") && bytes != null -> {
                VideoPlayerFromBytes(bytes!!, entry?.fileName ?: "video.mp4")
            }
        }

        
        Row(
            Modifier.fillMaxWidth().align(Alignment.TopCenter).padding(12.dp),
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.Filled.ArrowBack, contentDescription = "Voltar", tint = Color.White)
            }
            IconButton(onClick = onReport) {
                Icon(Icons.Filled.Flag, contentDescription = "Denunciar", tint = VagalunColors.danger)
            }
        }
    }
}

@Composable
fun BuyPackageButton(label: String, enabled: Boolean, onClick: () -> Unit) {
    Button(
        enabled = enabled,
        onClick = onClick,
        colors = ButtonDefaults.buttonColors(containerColor = VagalunColors.bgCard2),
        modifier = Modifier.fillMaxWidth().height(48.dp)
    ) { Text("Comprar $label", color = VagalunColors.neonGreen) }
}

@Composable
fun VideoPlayerFromBytes(bytes: ByteArray, fileName: String) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val tempFile = remember(bytes) {
        File(context.cacheDir, "play_${System.currentTimeMillis()}_$fileName").apply { writeBytes(bytes) }
    }
    DisposableEffect(tempFile) {
        onDispose { tempFile.delete() }
    }

    androidx.compose.ui.viewinterop.AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { ctx ->
            val playerView = com.google.android.exoplayer2.ui.PlayerView(ctx)
            val player = com.google.android.exoplayer2.ExoPlayer.Builder(ctx).build()
            val mediaItem = com.google.android.exoplayer2.MediaItem.fromUri(android.net.Uri.fromFile(tempFile))
            player.setMediaItem(mediaItem)
            player.prepare()
            player.playWhenReady = true
            playerView.player = player
            playerView.useController = true
            playerView
        }
    )
}


@Composable
fun SettingsScreen(
    quotaGb: Int,
    maxOfferableGb: Int,
    onQuotaChange: (Int) -> Unit,
    wifiOnly: Boolean,
    onWifiOnlyChange: (Boolean) -> Unit,
    backgroundSync: Boolean,
    onBackgroundSyncChange: (Boolean) -> Unit,
    onClearDeadShards: () -> Unit,
    signalingUrl: String,
    onSignalingUrlChange: (String) -> Unit,
    onSignalingUrlSave: () -> Unit
) {
    var sliderValue by remember { mutableStateOf(quotaGb.toFloat().coerceAtMost(maxOfferableGb.toFloat())) }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp)
    ) {
        Text("Configurações", color = VagalunColors.textPrimary, fontSize = 22.sp, fontWeight = FontWeight.Bold)

        Card(colors = CardDefaults.cardColors(containerColor = VagalunColors.bgCard), shape = RoundedCornerShape(18.dp)) {
            Column(Modifier.padding(18.dp)) {
                Text("Cota de disco cedida", color = VagalunColors.textSecondary, fontSize = 12.sp)
                Text("${sliderValue.toInt()} GB", color = VagalunColors.neonGreen, fontSize = 24.sp, fontWeight = FontWeight.Bold)
                Slider(
                    value = sliderValue,
                    onValueChange = { sliderValue = it },
                    onValueChangeFinished = { onQuotaChange(sliderValue.toInt()) },
                    
                    valueRange = 1f..maxOfferableGb.toFloat().coerceAtLeast(1f),
                    colors = SliderDefaults.colors(thumbColor = VagalunColors.neonGreen, activeTrackColor = VagalunColors.neonGreen)
                )
                Text(
                    "Máximo disponível agora neste aparelho: $maxOfferableGb GB)",
                    color = VagalunColors.textSecondary, fontSize = 11.sp
                )
            }
        }

        Card(colors = CardDefaults.cardColors(containerColor = VagalunColors.bgCard), shape = RoundedCornerShape(18.dp)) {
            Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                SettingsToggleRow("Sincronizar apenas no Wi-Fi", wifiOnly, onWifiOnlyChange)
                SettingsToggleRow("Rodar em segundo plano", backgroundSync, onBackgroundSyncChange)
            }
        }

        
        Card(colors = CardDefaults.cardColors(containerColor = VagalunColors.bgCard), shape = RoundedCornerShape(18.dp)) {
            Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Rede (WAN / internet)", color = VagalunColors.textPrimary, fontWeight = FontWeight.Bold)
                Text(
                    "Endereço do servidor de signaling (wss://...)." +
                        "" +
                        "",
                    color = VagalunColors.textSecondary, fontSize = 11.sp
                )
                OutlinedTextField(
                    value = signalingUrl,
                    onValueChange = onSignalingUrlChange,
                    label = { Text("wss://vagalun.com") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                Button(
                    onClick = onSignalingUrlSave,
                    colors = ButtonDefaults.buttonColors(containerColor = VagalunColors.neonCyan),
                    modifier = Modifier.fillMaxWidth().height(48.dp)
                ) { Text("Salvar e conectar", color = Color.Black, fontWeight = FontWeight.Bold) }
            }
        }

        Button(
            onClick = onClearDeadShards,
            colors = ButtonDefaults.buttonColors(containerColor = VagalunColors.bgCard2),
            shape = RoundedCornerShape(14.dp),
            modifier = Modifier.fillMaxWidth().height(52.dp)
        ) {
            Icon(Icons.Filled.CleaningServices, contentDescription = null, tint = VagalunColors.neonCyan)
            Spacer(Modifier.width(8.dp))
            Text("Limpar cache", color = VagalunColors.textPrimary)
        }
    }
}

@Composable
fun SettingsToggleRow(label: String, checked: Boolean, onCheckedChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(label, color = VagalunColors.textPrimary, fontSize = 14.sp)
        Switch(
            checked = checked, onCheckedChange = onCheckedChange,
            colors = SwitchDefaults.colors(checkedThumbColor = VagalunColors.neonGreen, checkedTrackColor = VagalunColors.neonGreen.copy(alpha = 0.35f))
        )
    }
}


@Composable
fun WalletOnboardingScreen(onSeedReady: (String) -> Unit) {
    var mode by remember { mutableStateOf("choose") } // choose | create | restore
    var generatedSeed by remember { mutableStateOf("") }
    var restoreInput by remember { mutableStateOf("") }
    var confirmed by remember { mutableStateOf(false) }

    Box(Modifier.fillMaxSize().background(VagalunColors.bg), contentAlignment = Alignment.Center) {
        Column(
            Modifier.fillMaxWidth().padding(28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(20.dp)
        ) {
            Text(" VAGALUN", color = VagalunColors.neonGreen, fontSize = 30.sp, fontWeight = FontWeight.Bold)
            Text("Sua chave, sua carteira Solana.", color = VagalunColors.textSecondary, textAlign = androidx.compose.ui.text.style.TextAlign.Center)

            when (mode) {
                "choose" -> {
                    Button(
                        onClick = { generatedSeed = KeyManager.generateSeedPhrase(); mode = "create" },
                        colors = ButtonDefaults.buttonColors(containerColor = VagalunColors.neonGreen),
                        modifier = Modifier.fillMaxWidth().height(52.dp)
                    ) { Text("Criar novo cofre", color = Color.Black, fontWeight = FontWeight.Bold) }

                    OutlinedButton(
                        onClick = { mode = "restore" },
                        modifier = Modifier.fillMaxWidth().height(52.dp)
                    ) { Text("Já tenho uma seed phrase", color = VagalunColors.neonCyan) }
                }
                "create" -> {
                    Card(colors = CardDefaults.cardColors(containerColor = VagalunColors.bgCard), shape = RoundedCornerShape(16.dp)) {
                        Text(
                            generatedSeed, color = VagalunColors.textPrimary, fontSize = 16.sp,
                            modifier = Modifier.padding(20.dp), textAlign = androidx.compose.ui.text.style.TextAlign.Center
                        )
                    }
                    Text("Anote as 12 palavras em papel. Sem elas você perde acesso pra sempre.", color = VagalunColors.warning, fontSize = 12.sp, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(checked = confirmed, onCheckedChange = { confirmed = it }, colors = CheckboxDefaults.colors(checkedColor = VagalunColors.neonGreen))
                        Text("Já anotei em local seguro", color = VagalunColors.textPrimary, fontSize = 12.sp)
                    }
                    Button(
                        enabled = confirmed,
                        onClick = { onSeedReady(generatedSeed) },
                        colors = ButtonDefaults.buttonColors(containerColor = VagalunColors.neonGreen),
                        modifier = Modifier.fillMaxWidth().height(52.dp)
                    ) { Text("Continuar", color = Color.Black, fontWeight = FontWeight.Bold) }
                }
                "restore" -> {
                    OutlinedTextField(
                        value = restoreInput, onValueChange = { restoreInput = it },
                        label = { Text("Digite as 12 palavras") },
                        modifier = Modifier.fillMaxWidth()
                    )
                    Button(
                        onClick = {
                            if (KeyManager.validateSeedPhrase(restoreInput)) onSeedReady(restoreInput)
                        },
                        colors = ButtonDefaults.buttonColors(containerColor = VagalunColors.neonGreen),
                        modifier = Modifier.fillMaxWidth().height(52.dp)
                    ) { Text("Restaurar", color = Color.Black, fontWeight = FontWeight.Bold) }
                }
            }
        }
    }
}


@Composable
fun WalletScreen(
    seedPhrase: String,
    walletAddress: String,
    wallet: SolanaWallet?,
    anchorClient: AnchorStorageClient?,
    scope: CoroutineScope,
    onLog: (String) -> Unit
) {
    var showSeed by remember { mutableStateOf(false) }
    var balanceLamports by remember { mutableStateOf<Long?>(null) }
    var toAddress by remember { mutableStateOf("") }
    var amountSol by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }

    suspend fun refreshBalance() {
        try {
            balanceLamports = wallet?.getBalanceLamports()
        } catch (e: Exception) {
            onLog("Falha ao consultar saldo: ${e.message}")
        }
    }

    LaunchedEffect(walletAddress) {
        if (wallet != null) withContext(Dispatchers.IO) { refreshBalance() }
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp)
    ) {
        Text("Carteira", color = VagalunColors.textPrimary, fontSize = 22.sp, fontWeight = FontWeight.Bold)

        
        Card(colors = CardDefaults.cardColors(containerColor = VagalunColors.bgCard), shape = RoundedCornerShape(18.dp)) {
            Column(Modifier.padding(18.dp)) {
                Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                    Text("Saldo (devnet)", color = VagalunColors.textSecondary, fontSize = 12.sp)
                    IconButton(onClick = { scope.launch(Dispatchers.IO) { refreshBalance() } }) {
                        Icon(Icons.Filled.Refresh, contentDescription = "Atualizar", tint = VagalunColors.neonCyan)
                    }
                }
                val lamports = balanceLamports
                Text(
                    if (lamports == null) "carregando..." else "%.6f SOL".format(lamports / 1_000_000_000.0),
                    color = VagalunColors.neonGreen, fontSize = 26.sp, fontWeight = FontWeight.Bold
                )
                Text("Endereço: ${walletAddress.ifEmpty { "iniciando..." }}", color = VagalunColors.textSecondary, fontSize = 12.sp)
            }
        }

      
        Card(colors = CardDefaults.cardColors(containerColor = VagalunColors.bgCard), shape = RoundedCornerShape(18.dp)) {
            Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Enviar SOL", color = VagalunColors.textPrimary, fontWeight = FontWeight.Bold)
                OutlinedTextField(
                    value = toAddress, onValueChange = { toAddress = it },
                    label = { Text("Endereço de destino") }, singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                OutlinedTextField(
                    value = amountSol, onValueChange = { amountSol = it },
                    label = { Text("Quantidade (SOL)") }, singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                Button(
                    enabled = !busy && toAddress.isNotBlank() && amountSol.toDoubleOrNull() != null,
                    onClick = {
                        busy = true
                        scope.launch(Dispatchers.IO) {
                            try {
                                val lamports = (amountSol.toDouble() * 1_000_000_000L).toLong()
                                val sig = wallet?.transferSol(toAddress, lamports)
                                onLog("SOL enviado. Assinatura: $sig")
                                refreshBalance()
                            } catch (e: Exception) {
                                onLog("Erro ao enviar SOL: ${e.message}")
                            } finally {
                                busy = false
                            }
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = VagalunColors.neonGreen),
                    modifier = Modifier.fillMaxWidth().height(48.dp)
                ) { Text(if (busy) "Enviando..." else "Enviar SOL", color = Color.Black, fontWeight = FontWeight.Bold) }

                
                OutlinedButton(
                    enabled = !busy,
                    onClick = {
                        busy = true
                        scope.launch(Dispatchers.IO) {
                            try {
                                val sig = anchorClient?.requestDevnetAirdrop()
                                onLog("Airdrop devnet solicitado: $sig")
                                refreshBalance()
                            } catch (e: Exception) {
                                onLog("Erro no airdrop: ${e.message}")
                            } finally {
                                busy = false
                            }
                        }
                    },
                    modifier = Modifier.fillMaxWidth()
                ) { Text("Pedir sol devnet", color = VagalunColors.neonCyan) }
            }
        }

        
        Card(colors = CardDefaults.cardColors(containerColor = VagalunColors.bgCard), shape = RoundedCornerShape(18.dp)) {
    Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("Comprar espaço extra", color = VagalunColors.textPrimary, fontWeight = FontWeight.Bold)
        Text("Paga on-chain via purchase_tier, direto no contrato.", color = VagalunColors.textSecondary, fontSize = 11.sp)

        fun buy(label: String, gb: Long) {
            onLog("Cliquei em Comprar $label")
            busy = true
            scope.launch(Dispatchers.IO) {
                try {
                    onLog("anchorClient é null? ${anchorClient == null}")
                    val sig = anchorClient?.purchaseTier(gb)
                    if (sig != null && sig.startsWith("ERRO")) {
                        // sendSingle() do AnchorStorageClient nunca propaga exceção — sempre
                        // retorna uma String. Se começar com "ERRO", a transação NUNCA foi
                        // confirmada on-chain (por isso o saldo não muda). Aqui mostramos a
                        // causa real, que normalmente é conta inexistente (market_config ou
                        // user_account nunca inicializados) ou programa não implantado nesse RPC.
                        onLog("Falha real na compra de $label: $sig")
                    } else {
                        onLog("Pacote $label comprado. Assinatura: $sig")
                    }
                    refreshBalance()
                } catch (e: Exception) {
                    onLog("Erro na compra de $label: ${e.message}")
                } finally {
                    busy = false
                }
            }
        }

        BuyPackageButton("+50 GB", !busy) { buy("+50 GB", 50L) }
        BuyPackageButton("+100 GB", !busy) { buy("+100 GB", 100L) }
        BuyPackageButton("+1 TB", !busy) { buy("+1 TB", 1000L) }
    }
}

        // ---- Seed phrase ----
        Card(colors = CardDefaults.cardColors(containerColor = VagalunColors.bgCard), shape = RoundedCornerShape(18.dp)) {
            Column(Modifier.padding(18.dp)) {
                Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                    Text("Seed phrase (chave mestra)", color = VagalunColors.textSecondary, fontSize = 12.sp)
                    TextButton(onClick = { showSeed = !showSeed }) {
                        Text(if (showSeed) "Ocultar" else "Mostrar", color = VagalunColors.neonGreen)
                    }
                }
                if (showSeed) {
                    Text(seedPhrase, color = VagalunColors.textPrimary, fontSize = 14.sp, modifier = Modifier.padding(top = 8.dp))
                } else {
                    Text("••• •••• ••• ••••• •• •••", color = VagalunColors.textSecondary, modifier = Modifier.padding(top = 8.dp))
                }
            }
        }

        Text(
            "Nunca compartilhe isso com ninguém.",
            color = VagalunColors.danger, fontSize = 12.sp
        )
    }
}
