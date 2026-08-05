package com.decentstorage.app

import android.content.ClipboardManager
import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
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
import androidx.compose.ui.draw.graphicsLayer
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.decentstorage.app.crypto.KeyManager
import com.decentstorage.app.network.GossipRegistry
import com.decentstorage.app.network.ShardRequestHandler
import com.decentstorage.app.network.ShardServer
import com.decentstorage.app.network.webrtc.RelayTransport
import com.decentstorage.app.network.webrtc.SignalingClient
import com.decentstorage.app.network.webrtc.WebRtcManager
import com.decentstorage.app.storage.DeviceStorage
import com.decentstorage.app.wallet.AnchorStorageClient
import com.decentstorage.app.wallet.SolanaWallet
import com.decentstorage.app.work.DailyClaimWorker
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.security.SecureRandom
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

// ===================== DESIGN TOKENS =====================
object VagalunColors {
    val bg = Color(0xFF0D0D0D)
    val bgCard = Color(0xFF1A1A1A)
    val bgCard2 = Color(0xFF2A2A2A)
    val red = Color(0xFFFF3B3B)
    val redSoft = Color(0xFFFF5A5F)
    val redDim = Color(0xFF7A1116)
    val textPrimary = Color(0xFFFFFFFF)
    val textSecondary = Color(0xFFB0B0B0)
    val danger = Color(0xFFFF4D4D)
    val warning = Color(0xFFFFB020)
    val success = Color(0xFF4CAF50)
}

object VagalunTypography {
    val titleLarge = TextStyle(
        fontSize = 26.sp,
        fontWeight = FontWeight.Bold,
        color = VagalunColors.textPrimary
    )
    val titleMedium = TextStyle(
        fontSize = 18.sp,
        fontWeight = FontWeight.SemiBold,
        color = VagalunColors.textPrimary
    )
    val body = TextStyle(
        fontSize = 14.sp,
        color = VagalunColors.textPrimary
    )
    val bodySecondary = TextStyle(
        fontSize = 13.sp,
        color = VagalunColors.textSecondary
    )
    val small = TextStyle(
        fontSize = 11.sp,
        color = VagalunColors.textSecondary
    )
}

object VagalunShapes {
    val card = RoundedCornerShape(20.dp)
    val button = RoundedCornerShape(14.dp)
    val small = RoundedCornerShape(12.dp)
}

object VagalunSpacing {
    val small = 8.dp
    val medium = 16.dp
    val large = 20.dp
    val xlarge = 24.dp
}

// ===================== RELAY CONFIG =====================
object RelayConfig {
    private const val CONFIG_URL =
        "https://raw.githubusercontent.com/riquelima805/adla-nft-market/refs/heads/main/reley.json"

    private val client = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .build()

    fun fetchSignalingUrl(): String? {
        return try {
            val request = Request.Builder().url(CONFIG_URL).build()
            client.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return null
                val body = resp.body?.string()?.trim()
                if (body.isNullOrBlank()) return null
                val json = JSONObject(body)
                val url = json.optString("signalingUrl", json.optString("url", json.optString("wss", "")))
                url.trim().ifBlank { null }
            }
        } catch (e: Exception) {
            null
        }
    }
}

// ===================== DATA CLASSES =====================
const val FREE_STORAGE_BYTES: Long = 2L * 1024 * 1024 * 1024

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

// ===================== MAIN ACTIVITY =====================
class MainActivity : ComponentActivity() {

    private lateinit var prefs: SharedPreferences

    private var registry: GossipRegistry? = null
    private var shardServer: ShardServer? = null
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

    private val relayFallbackExecutor = Executors.newSingleThreadScheduledExecutor()
    private val RELAY_FALLBACK_DELAY_SECONDS = 12L

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
            MaterialTheme(
                colorScheme = darkColorScheme(
                    background = VagalunColors.bg,
                    surface = VagalunColors.bgCard,
                    primary = VagalunColors.red,
                    secondary = VagalunColors.redSoft
                )
            ) {
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

        shardServer = ShardServer(nodeId, 8901, selfCapacityBytes, selfDataDir!!, applicationContext).also { it.start() }

        storageClient = StorageClient(reg)

        wallet = SolanaWallet.fromSeedPhrase(seedBytes)
        anchorClient = AnchorStorageClient(wallet!!)

        DailyClaimWorker.schedule(applicationContext)

        refreshRelayAndConnect(onLog)

        onLog("Motor iniciado. nodeId=$nodeId")
        onReady(wallet!!.publicKey.toString())
    }

    private fun refreshRelayAndConnect(onLog: (String) -> Unit) {
        val fetched = RelayConfig.fetchSignalingUrl()
        when {
            fetched != null -> {
                selfSignalingUrl = fetched
                prefs.edit().putString("signalingUrl", fetched).apply()
                connectWan(fetched, onLog)
            }
            selfSignalingUrl.isNotBlank() -> {
                onLog("Relay remoto indisponível agora, usando último endereço salvo.")
                connectWan(selfSignalingUrl, onLog)
            }
            else -> {
                onLog("Relay ainda não disponível. O node segue ativo localmente (Wi-Fi) e tentará novamente em breve.")
            }
        }
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

        sc.onPeerList = { peerIds ->
            val others = peerIds.filter { it != nodeId }
            if (others.isNotEmpty()) onLog("Peers vistos no signaling: ${others.joinToString()}")
            others.forEach { peerId ->
                if (nodeId < peerId) {
                    mgr.connectToPeer(peerId)
                    scheduleRelayFallback(peerId, sc, reqHandler, onLog)
                }
            }
        }
        sc.onPeerJoined = { peerId ->
            if (peerId != nodeId) {
                onLog("Novo peer entrou na WAN: $peerId")
                if (nodeId < peerId) {
                    mgr.connectToPeer(peerId)
                    scheduleRelayFallback(peerId, sc, reqHandler, onLog)
                }
            }
        }
        sc.onPeerLeft = { peerId ->
            onLog("Peer saiu da WAN: $peerId")
            mgr.disconnect(peerId)
            registry?.detachWanTransport(peerId)
        }

        sc.onRelayRequest = { from, requestId, header, payload ->
            val (respHeader, respPayload) = try {
                reqHandler.handle(header, payload)
            } catch (e: Exception) {
                JSONObject().put("ok", false).put("error", e.message ?: "erro") to null
            }
            sc.sendRelayResponse(from, requestId, respHeader, respPayload)
        }

        sc.connect()
    }

    private fun scheduleRelayFallback(
        peerId: String,
        sc: SignalingClient,
        reqHandler: ShardRequestHandler,
        onLog: (String) -> Unit
    ) {
        relayFallbackExecutor.schedule({
            val reg = registry ?: return@schedule
            val alreadyConnected = reg.knownPeers().find { it.nodeId == peerId }?.webrtcTransport != null
            if (!alreadyConnected && signalingClient === sc) {
                onLog("WebRTC direto não abriu com $peerId — usando Relay via signaling.")
                reg.attachWanTransport(peerId, RelayTransport(peerId, sc))
            }
        }, RELAY_FALLBACK_DELAY_SECONDS, TimeUnit.SECONDS)
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

    // ===================== COMPOSE UI =====================
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
        val snackbarHostState = remember { SnackbarHostState() }
        var showSnackbarMessage by remember { mutableStateOf<String?>(null) }

        // Exibe snackbar quando houver mensagem
        LaunchedEffect(showSnackbarMessage) {
            showSnackbarMessage?.let {
                snackbarHostState.showSnackbar(it)
                showSnackbarMessage = null
            }
        }

        fun log(msg: String) {
            logLines = (listOf(msg) + logLines).take(50)
            showSnackbarMessage = msg
        }

        fun startNode() {
            if (nodeActive) return
            scope.launch {
                withContext(Dispatchers.IO) {
                    try {
                        ensureEngineStarted(seedPhrase, onReady = { addr ->
                            walletAddress = addr
                        }, onLog = { log(it) })

                        val sig = anchorClient?.initAccount()
                        if (sig != null && sig.startsWith("ERRO")) {
                            log("Conta já inicializada ou saldo de SOL insuficiente.")
                        } else {
                            log("Conta on-chain criada com sucesso!")
                        }

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
            bottomBar = { VagalunBottomBar(navController) },
            snackbarHost = { SnackbarHost(snackbarHostState) }
        ) { padding ->
            NavHost(
                navController = navController,
                startDestination = "dashboard",
                modifier = Modifier.padding(padding),
                enterTransition = {
                    fadeIn(animationSpec = tween(300)) +
                            slideInHorizontally(initialOffsetX = { 40 })
                },
                exitTransition = {
                    fadeOut(animationSpec = tween(200)) +
                            slideOutHorizontally(targetOffsetX = { -40 })
                },
                popEnterTransition = {
                    fadeIn(animationSpec = tween(300)) +
                            slideInHorizontally(initialOffsetX = { -40 })
                },
                popExitTransition = {
                    fadeOut(animationSpec = tween(200)) +
                            slideOutHorizontally(targetOffsetX = { 40 })
                }
            ) {
                composable("dashboard") {
                    DashboardScreen(
                        nodeActive = nodeActive,
                        onToggleNode = { turningOn ->
                            if (turningOn) {
                                startNode()
                                scope.launch(Dispatchers.IO) { refreshRelayAndConnect { log(it) } }
                            } else {
                                disconnectWan()
                                nodeActive = false
                                log("Sistema desativado")
                            }
                        },
                        walletAddress = walletAddress,
                        capacityGb = quotaGb,
                        maxOfferableGb = DeviceStorage.maxOfferableGb(this@MainActivity),
                        onQuotaChange = { newGb ->
                            val maxGb = DeviceStorage.maxOfferableGb(this@MainActivity)
                            val clamped = newGb.coerceAtMost(maxGb).coerceAtLeast(1)
                            quotaGb = clamped
                            selfCapacityBytes = clamped.toLong() * 1024 * 1024 * 1024
                            prefs.edit().putLong("quotaBytes", selfCapacityBytes).apply()
                        },
                        usedFreeBytes = files.sumOf { it.sizeBytes }
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
                                            log("Upload ok: $name")
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
                        onReport = { log("Arquivo denunciado") },
                        onBack = { navController.popBackStack() }
                    )
                }
                composable("settings") {
                    SettingsScreen(
                        wifiOnly = wifiOnly,
                        onWifiOnlyChange = { wifiOnly = it; prefs.edit().putBoolean("wifiOnly", it).apply() },
                        backgroundSync = backgroundSync,
                        onBackgroundSyncChange = { backgroundSync = it; prefs.edit().putBoolean("bgSync", it).apply() },
                        onClearDeadShards = {
                            val dir = selfDataDir
                            var freed = 0L
                            dir?.listFiles()?.forEach { f -> freed += f.length(); f.delete() }
                            log("Cache limpo: ${freed / 1024} KB liberados")
                        }
                    )
                }
                composable("wallet") {
                    WalletScreen(
                        seedPhrase = seedPhrase,
                        walletAddress = walletAddress,
                        wallet = wallet,
                        scope = scope,
                        onLog = { log(it) }
                    )
                }
            }
        }
    }
}

// ===================== BOTTOM BAR =====================
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
                    selectedIconColor = VagalunColors.red,
                    selectedTextColor = VagalunColors.red,
                    unselectedIconColor = VagalunColors.textSecondary,
                    unselectedTextColor = VagalunColors.textSecondary,
                    indicatorColor = VagalunColors.bgCard2
                )
            )
        }
    }
}

// ===================== DASHBOARD (COM ANIMAÇÕES) =====================
@Composable
fun DashboardScreen(
    nodeActive: Boolean,
    onToggleNode: (Boolean) -> Unit,
    walletAddress: String,
    capacityGb: Int,
    maxOfferableGb: Int,
    onQuotaChange: (Int) -> Unit,
    usedFreeBytes: Long
) {
    var sliderValue by remember(capacityGb) { mutableStateOf(capacityGb.toFloat()) }
    val alphaAnim by animateFloatAsState(targetValue = 1f, animationSpec = tween(500))

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(VagalunSpacing.large)
            .graphicsLayer { alpha = alphaAnim },
        verticalArrangement = Arrangement.spacedBy(VagalunSpacing.large)
    ) {
        // Logo
        Text("VAGALUN", style = VagalunTypography.titleLarge, color = VagalunColors.red)

        // Card de status + botão principal
        AnimatedCard {
            Column(Modifier.padding(VagalunSpacing.large)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        if (nodeActive) "🟢 Sistema ativo" else "⚪ Sistema pausado",
                        style = VagalunTypography.titleMedium
                    )
                    Spacer(Modifier.weight(1f))
                    if (nodeActive) {
                        Text("🌐", fontSize = 16.sp)
                    }
                }
                Spacer(Modifier.height(VagalunSpacing.small))
                Text(
                    if (nodeActive) "Seu dispositivo está contribuindo com a rede"
                    else "Ative para começar a ganhar recompensas",
                    style = VagalunTypography.bodySecondary
                )
                Spacer(Modifier.height(VagalunSpacing.medium))
                // Botão com animação de escala ao clicar
                var buttonScale by remember { mutableStateOf(1f) }
                Button(
                    onClick = {
                        buttonScale = 0.95f
                        onToggleNode(!nodeActive)
                    },
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(52.dp)
                        .scale(buttonScale),
                    shape = VagalunShapes.button,
                    colors = ButtonDefaults.buttonColors(containerColor = VagalunColors.red)
                ) {
                    Text(
                        if (nodeActive) "DESATIVAR" else "ATIVAR AGORA",
                        color = Color.White,
                        fontWeight = FontWeight.Bold,
                        fontSize = 15.sp
                    )
                }
                // Restaura escala após clique
                LaunchedEffect(buttonScale) {
                    if (buttonScale < 1f) {
                        delay(150)
                        buttonScale = 1f
                    }
                }
            }
        }

        // Card de armazenamento
        AnimatedCard {
            Column(Modifier.padding(VagalunSpacing.large)) {
                Text("Armazenamento", style = VagalunTypography.titleMedium)
                Spacer(Modifier.height(VagalunSpacing.small))
                val usedGb = usedFreeBytes / (1024f * 1024 * 1024)
                Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                    Text("Seu plano gratuito", style = VagalunTypography.bodySecondary)
                    Text("${"%.2f".format(usedGb)} GB de 2 GB", style = VagalunTypography.body)
                }
                Spacer(Modifier.height(VagalunSpacing.small))
                LinearProgressIndicator(
                    progress = (usedFreeBytes.toFloat() / FREE_STORAGE_BYTES.toFloat()).coerceIn(0f, 1f),
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(8.dp)
                        .clip(RoundedCornerShape(4.dp)),
                    color = VagalunColors.red,
                    trackColor = VagalunColors.bgCard2
                )
                Spacer(Modifier.height(VagalunSpacing.medium))
                Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                    Text("Compartilhando", style = VagalunTypography.bodySecondary)
                    Text("${sliderValue.toInt()} GB", style = VagalunTypography.body)
                }
                Slider(
                    value = sliderValue,
                    onValueChange = { sliderValue = it },
                    onValueChangeFinished = { onQuotaChange(sliderValue.toInt()) },
                    valueRange = 1f..maxOfferableGb.toFloat().coerceAtLeast(1f),
                    colors = SliderDefaults.colors(
                        thumbColor = VagalunColors.red,
                        activeTrackColor = VagalunColors.red,
                        inactiveTrackColor = VagalunColors.bgCard2
                    )
                )
                Text(
                    "Máximo disponível: $maxOfferableGb GB",
                    style = VagalunTypography.small
                )
            }
        }

        // Wallet resumido
        if (walletAddress.isNotEmpty()) {
            AnimatedCard {
                Row(Modifier.padding(VagalunSpacing.medium), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Filled.AccountBalanceWallet, tint = VagalunColors.red, contentDescription = null)
                    Spacer(Modifier.width(VagalunSpacing.small))
                    Text(
                        "Carteira: ${walletAddress.take(6)}...${walletAddress.takeLast(4)}",
                        style = VagalunTypography.bodySecondary
                    )
                }
            }
        }
    }
}

// Helper: Card com animação de fade-in e leve elevação
@Composable
fun AnimatedCard(content: @Composable () -> Unit) {
    val transition = updateTransition(targetState = true, label = "card")
    val alpha by transition.animateFloat(label = "alpha") { if (it) 1f else 0f }
    val scale by transition.animateFloat(label = "scale") { if (it) 1f else 0.95f }

    Card(
        shape = VagalunShapes.card,
        colors = CardDefaults.cardColors(containerColor = VagalunColors.bgCard),
        elevation = CardDefaults.cardElevation(defaultElevation = 4.dp),
        modifier = Modifier
            .fillMaxWidth()
            .graphicsLayer {
                this.alpha = alpha
                this.scaleX = scale
                this.scaleY = scale
            }
    ) {
        content()
    }
}

// ===================== FILES SCREEN =====================
@Composable
fun FilesScreen(
    files: List<UiFileEntry>,
    onUpload: () -> Unit,
    onDelete: (UiFileEntry) -> Unit,
    onOpen: (UiFileEntry, (ByteArray) -> Unit) -> Unit,
    navController: NavHostController
) {
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().padding(VagalunSpacing.medium)) {
            Text("Meus Arquivos", style = VagalunTypography.titleLarge)
            Spacer(Modifier.height(VagalunSpacing.small))
            Text("${files.size} arquivo(s) na rede", style = VagalunTypography.bodySecondary)
            Spacer(Modifier.height(VagalunSpacing.medium))

            if (files.isEmpty()) {
                Column(
                    Modifier.fillMaxSize(),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Icon(
                        Icons.Filled.Folder,
                        contentDescription = null,
                        tint = VagalunColors.textSecondary,
                        modifier = Modifier.size(64.dp)
                    )
                    Spacer(Modifier.height(VagalunSpacing.small))
                    Text("Nenhum arquivo ainda", style = VagalunTypography.titleMedium)
                    Spacer(Modifier.height(VagalunSpacing.medium))
                    Button(
                        onClick = onUpload,
                        colors = ButtonDefaults.buttonColors(containerColor = VagalunColors.red),
                        shape = VagalunShapes.button,
                        modifier = Modifier.height(48.dp)
                    ) {
                        Text("ENVIAR ARQUIVO", color = Color.White, fontWeight = FontWeight.Bold)
                    }
                }
            } else {
                LazyColumn(verticalArrangement = Arrangement.spacedBy(VagalunSpacing.small)) {
                    items(files) { entry ->
                        FileRow(
                            entry = entry,
                            onClick = {
                                if (entry.mimeType.startsWith("image") || entry.mimeType.startsWith("video")) {
                                    navController.navigate("player/${entry.fileId}/${Uri.encode(entry.mimeType)}")
                                } else {
                                    onOpen(entry) { /* salvar? */ }
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
            containerColor = VagalunColors.red,
            modifier = Modifier.align(Alignment.BottomEnd).padding(VagalunSpacing.large)
        ) {
            Icon(Icons.Filled.Add, contentDescription = "Enviar arquivo", tint = Color.White)
        }
    }
}

@Composable
fun FileRow(entry: UiFileEntry, onClick: () -> Unit, onDelete: () -> Unit) {
    var showConfirm by remember { mutableStateOf(false) }
    val health = if (entry.k <= entry.n - 2) HealthState.HEALTHY else if (entry.k < entry.n) HealthState.DEGRADED else HealthState.CRITICAL
    val healthColor = when (health) {
        HealthState.HEALTHY -> VagalunColors.success
        HealthState.DEGRADED -> VagalunColors.warning
        HealthState.CRITICAL -> VagalunColors.danger
    }

    Card(
        colors = CardDefaults.cardColors(containerColor = VagalunColors.bgCard),
        shape = RoundedCornerShape(16.dp),
        modifier = Modifier.fillMaxWidth()
    ) {
        Row(
            Modifier.fillMaxWidth().padding(VagalunSpacing.medium),
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
                tint = VagalunColors.redSoft,
                modifier = Modifier.size(28.dp)
            )
            Spacer(Modifier.width(VagalunSpacing.small))
            Column(Modifier.weight(1f).clickable { onClick() }) {
                Text(entry.fileName, style = VagalunTypography.body, maxLines = 1)
                Text("${entry.sizeBytes / 1024} KB", style = VagalunTypography.small)
            }
            Box(Modifier.size(10.dp).clip(CircleShape).background(healthColor))
            Spacer(Modifier.width(VagalunSpacing.small))
            IconButton(onClick = { showConfirm = true }) {
                Icon(Icons.Filled.Delete, contentDescription = "Excluir", tint = VagalunColors.danger)
            }
        }
    }

    if (showConfirm) {
        AlertDialog(
            onDismissRequest = { showConfirm = false },
            title = { Text("Excluir arquivo?") },
            text = { Text("Isso encerra o pagamento do contrato e avisa a rede para liberar o espaço.") },
            confirmButton = {
                TextButton(onClick = { showConfirm = false; onDelete() }) {
                    Text("Excluir", color = VagalunColors.danger)
                }
            },
            dismissButton = {
                TextButton(onClick = { showConfirm = false }) {
                    Text("Cancelar")
                }
            }
        )
    }
}

// ===================== MEDIA VIEWER =====================
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
                CircularProgressIndicator(
                    color = VagalunColors.red,
                    modifier = Modifier.size(48.dp)
                )
                Spacer(Modifier.height(VagalunSpacing.small))
                Text("Buscando shards na rede...", style = VagalunTypography.bodySecondary)
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
            Modifier.fillMaxWidth().align(Alignment.TopCenter).padding(VagalunSpacing.small),
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
fun VideoPlayerFromBytes(bytes: ByteArray, fileName: String) {
    val context = LocalContext.current
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
            val mediaItem = com.google.android.exoplayer2.MediaItem.fromUri(Uri.fromFile(tempFile))
            player.setMediaItem(mediaItem)
            player.prepare()
            player.playWhenReady = true
            playerView.player = player
            playerView.useController = true
            playerView
        }
    )
}

// ===================== SETTINGS =====================
@Composable
fun SettingsScreen(
    wifiOnly: Boolean,
    onWifiOnlyChange: (Boolean) -> Unit,
    backgroundSync: Boolean,
    onBackgroundSyncChange: (Boolean) -> Unit,
    onClearDeadShards: () -> Unit
) {
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(VagalunSpacing.large),
        verticalArrangement = Arrangement.spacedBy(VagalunSpacing.large)
    ) {
        Text("Configurações", style = VagalunTypography.titleLarge)

        AnimatedCard {
            Column(Modifier.padding(VagalunSpacing.medium), verticalArrangement = Arrangement.spacedBy(VagalunSpacing.small)) {
                SettingsToggleRow("Sincronizar apenas no Wi-Fi", wifiOnly, onWifiOnlyChange)
                SettingsToggleRow("Manter ativo em segundo plano", backgroundSync, onBackgroundSyncChange)
            }
        }

        Button(
            onClick = onClearDeadShards,
            colors = ButtonDefaults.buttonColors(containerColor = VagalunColors.bgCard2),
            shape = VagalunShapes.button,
            modifier = Modifier.fillMaxWidth().height(52.dp)
        ) {
            Icon(Icons.Filled.CleaningServices, contentDescription = null, tint = VagalunColors.redSoft)
            Spacer(Modifier.width(VagalunSpacing.small))
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
        Text(label, style = VagalunTypography.body)
        Switch(
            checked = checked,
            onCheckedChange = onCheckedChange,
            colors = SwitchDefaults.colors(
                checkedThumbColor = VagalunColors.red,
                checkedTrackColor = VagalunColors.red.copy(alpha = 0.35f)
            )
        )
    }
}

// ===================== ONBOARDING =====================
@Composable
fun WalletOnboardingScreen(onSeedReady: (String) -> Unit) {
    var mode by remember { mutableStateOf("choose") }
    var generatedSeed by remember { mutableStateOf("") }
    var restoreInput by remember { mutableStateOf("") }
    var confirmed by remember { mutableStateOf(false) }

    Box(Modifier.fillMaxSize().background(VagalunColors.bg), contentAlignment = Alignment.Center) {
        Column(
            Modifier.fillMaxWidth().padding(VagalunSpacing.xlarge),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(VagalunSpacing.large)
        ) {
            Text("VAGALUN", color = VagalunColors.red, style = VagalunTypography.titleLarge)
            Text("Sua chave, sua carteira Solana.", style = VagalunTypography.bodySecondary, textAlign = TextAlign.Center)

            when (mode) {
                "choose" -> {
                    Button(
                        onClick = { generatedSeed = KeyManager.generateSeedPhrase(); mode = "create" },
                        colors = ButtonDefaults.buttonColors(containerColor = VagalunColors.red),
                        modifier = Modifier.fillMaxWidth().height(52.dp)
                    ) {
                        Text("Criar novo cofre", color = Color.White, fontWeight = FontWeight.Bold)
                    }
                    OutlinedButton(
                        onClick = { mode = "restore" },
                        modifier = Modifier.fillMaxWidth().height(52.dp)
                    ) {
                        Text("Já tenho uma seed phrase", color = VagalunColors.redSoft)
                    }
                }
                "create" -> {
                    Card(
                        colors = CardDefaults.cardColors(containerColor = VagalunColors.bgCard),
                        shape = VagalunShapes.card
                    ) {
                        Text(
                            generatedSeed,
                            color = VagalunColors.textPrimary,
                            fontSize = 16.sp,
                            modifier = Modifier.padding(VagalunSpacing.large),
                            textAlign = TextAlign.Center
                        )
                    }
                    Text(
                        "Anote as 12 palavras em papel. Sem elas você perde acesso pra sempre.",
                        color = VagalunColors.warning,
                        fontSize = 12.sp,
                        textAlign = TextAlign.Center
                    )
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(
                            checked = confirmed,
                            onCheckedChange = { confirmed = it },
                            colors = CheckboxDefaults.colors(checkedColor = VagalunColors.red)
                        )
                        Text("Já anotei em local seguro", color = VagalunColors.textPrimary, fontSize = 12.sp)
                    }
                    Button(
                        enabled = confirmed,
                        onClick = { onSeedReady(generatedSeed) },
                        colors = ButtonDefaults.buttonColors(containerColor = VagalunColors.red),
                        modifier = Modifier.fillMaxWidth().height(52.dp)
                    ) {
                        Text("Continuar", color = Color.White, fontWeight = FontWeight.Bold)
                    }
                }
                "restore" -> {
                    OutlinedTextField(
                        value = restoreInput,
                        onValueChange = { restoreInput = it },
                        label = { Text("Digite as 12 palavras") },
                        modifier = Modifier.fillMaxWidth()
                    )
                    Button(
                        onClick = {
                            if (KeyManager.validateSeedPhrase(restoreInput)) onSeedReady(restoreInput)
                        },
                        colors = ButtonDefaults.buttonColors(containerColor = VagalunColors.red),
                        modifier = Modifier.fillMaxWidth().height(52.dp)
                    ) {
                        Text("Restaurar", color = Color.White, fontWeight = FontWeight.Bold)
                    }
                }
            }
        }
    }
}

// ===================== WALLET =====================
@Composable
fun WalletScreen(
    seedPhrase: String,
    walletAddress: String,
    wallet: SolanaWallet?,
    scope: CoroutineScope,
    onLog: (String) -> Unit
) {
    var showSeed by remember { mutableStateOf(false) }
    var balanceLamports by remember { mutableStateOf<Long?>(null) }
    var toAddress by remember { mutableStateOf("") }
    var amountSol by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val context = LocalContext.current

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

    fun copyAddress() {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = android.content.ClipData.newPlainText("wallet_address", walletAddress)
        clipboard.setPrimaryClip(clip)
        onLog("Endereço copiado")
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(VagalunSpacing.large),
        verticalArrangement = Arrangement.spacedBy(VagalunSpacing.large)
    ) {
        Text("Carteira", style = VagalunTypography.titleLarge)

        // Saldo
        AnimatedCard {
            Column(Modifier.padding(VagalunSpacing.large)) {
                Text("Saldo", style = VagalunTypography.bodySecondary)
                Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                    val lamports = balanceLamports
                    Text(
                        if (lamports == null) "carregando..." else "%.6f SOL".format(lamports / 1_000_000_000.0),
                        style = VagalunTypography.titleLarge.copy(fontSize = 28.sp)
                    )
                    IconButton(onClick = { scope.launch(Dispatchers.IO) { refreshBalance() } }) {
                        Icon(Icons.Filled.Refresh, contentDescription = "Atualizar", tint = VagalunColors.redSoft)
                    }
                }
            }
        }

        // Ações Enviar / Receber
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(VagalunSpacing.small)) {
            Button(
                onClick = { /* O formulário de envio está abaixo */ },
                modifier = Modifier.weight(1f).height(48.dp),
                colors = ButtonDefaults.buttonColors(containerColor = VagalunColors.red),
                shape = VagalunShapes.small
            ) {
                Icon(Icons.Filled.Send, contentDescription = null, tint = Color.White)
                Spacer(Modifier.width(VagalunSpacing.small))
                Text("Enviar", color = Color.White, fontWeight = FontWeight.Bold)
            }
            OutlinedButton(
                onClick = { copyAddress() },
                modifier = Modifier.weight(1f).height(48.dp),
                shape = VagalunShapes.small
            ) {
                Icon(Icons.Filled.Receipt, contentDescription = null, tint = VagalunColors.red)
                Spacer(Modifier.width(VagalunSpacing.small))
                Text("Receber", color = VagalunColors.red, fontWeight = FontWeight.Bold)
            }
        }

        
        if (walletAddress.isNotEmpty()) {
            AnimatedCard {
                Row(Modifier.padding(VagalunSpacing.medium), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "Endereço: ${walletAddress.take(6)}...${walletAddress.takeLast(4)}",
                        style = VagalunTypography.bodySecondary,
                        modifier = Modifier.weight(1f)
                    )
                    IconButton(onClick = { copyAddress() }) {
                        Icon(Icons.Filled.ContentCopy, contentDescription = "Copiar", tint = VagalunColors.redSoft)
                    }
                }
            }
        }

        
        AnimatedCard {
            Column(Modifier.padding(VagalunSpacing.medium), verticalArrangement = Arrangement.spacedBy(VagalunSpacing.small)) {
                Text("Enviar SOL", style = VagalunTypography.titleMedium)
                OutlinedTextField(
                    value = toAddress,
                    onValueChange = { toAddress = it },
                    label = { Text("Endereço de destino") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                OutlinedTextField(
                    value = amountSol,
                    onValueChange = { amountSol = it },
                    label = { Text("Quantidade (SOL)") },
                    singleLine = true,
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
                    colors = ButtonDefaults.buttonColors(containerColor = VagalunColors.red),
                    modifier = Modifier.fillMaxWidth().height(48.dp),
                    shape = VagalunShapes.small
                ) {
                    Text(if (busy) "Enviando..." else "Confirmar envio", color = Color.White, fontWeight = FontWeight.Bold)
                }
            }
        }

        // Segurança
        AnimatedCard {
            Column(Modifier.padding(VagalunSpacing.medium)) {
                Text("Segurança", style = VagalunTypography.bodySecondary)
                TextButton(onClick = { showSeed = !showSeed }, modifier = Modifier.fillMaxWidth()) {
                    Text(
                        if (showSeed) "Ocultar chave secreta" else "Ver chave secreta",
                        color = VagalunColors.red
                    )
                }
                if (showSeed) {
                    Spacer(Modifier.height(VagalunSpacing.small))
                    Text(seedPhrase, style = VagalunTypography.body, textAlign = TextAlign.Center)
                    Text(
                        "Nunca compartilhe isso com ninguém.",
                        color = VagalunColors.danger,
                        fontSize = 11.sp,
                        modifier = Modifier.padding(top = VagalunSpacing.small)
                    )
                }
            }
        }
    }
}
