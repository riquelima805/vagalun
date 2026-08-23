package com.decentstorage.app

import android.content.ClipboardManager
import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
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
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.math.sin


object VagalunColors {
    val bg = Color(0xFF000000)          
    val bgCard = Color(0xFF121212)      
    val bgCard2 = Color(0xFF1E1E1E)     
    
    val red = Color(0xFFE50914)         
    val redSoft = Color(0xFFB71C1C)     
    
    val textPrimary = Color(0xFFFFFFFF) 
    val textSecondary = Color(0xFFA0A0A0) 
    

    val danger = Color(0xFFFF4D4D)
    val warning = Color(0xFFFFB020)
    val success = Color(0xFF2ECC71)
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

// ===================== POINTS CLIENT =====================

data class PointsInfo(val points: Long, val uptimeSeconds: Long, val sessions: Long, val lastSeen: Long)
data class LeaderboardEntry(val pubkey: String, val points: Long, val uptimeSeconds: Long)

object PointsClient {
    private val client = OkHttpClient.Builder()
        .connectTimeout(6, TimeUnit.SECONDS)
        .readTimeout(6, TimeUnit.SECONDS)
        .build()

    // O signaling roda WS na mesma porta HTTP — troca só o esquema pra consultar via REST.
    private fun httpBaseFromSignaling(signalingUrl: String): String? {
        if (signalingUrl.isBlank()) return null
        return when {
            signalingUrl.startsWith("wss://") -> "https://" + signalingUrl.removePrefix("wss://").substringBefore("/")
            signalingUrl.startsWith("ws://") -> "http://" + signalingUrl.removePrefix("ws://").substringBefore("/")
            else -> null
        }
    }

    fun fetchPoints(signalingUrl: String, pubkey: String): PointsInfo? {
        val base = httpBaseFromSignaling(signalingUrl) ?: return null
        if (pubkey.isBlank()) return null
        return try {
            val request = Request.Builder()
                .url("$base/points/${java.net.URLEncoder.encode(pubkey, "UTF-8")}")
                .build()
            client.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return null
                val json = JSONObject(resp.body?.string() ?: return null)
                PointsInfo(
                    points = json.optLong("points", 0L),
                    uptimeSeconds = json.optLong("uptimeSeconds", 0L),
                    sessions = json.optLong("sessions", 0L),
                    lastSeen = json.optLong("lastSeen", 0L)
                )
            }
        } catch (e: Exception) {
            null
        }
    }

    fun fetchLeaderboard(signalingUrl: String): List<LeaderboardEntry>? {
        val base = httpBaseFromSignaling(signalingUrl) ?: return null
        return try {
            val request = Request.Builder().url("$base/points/leaderboard").build()
            client.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return null
                val json = JSONObject(resp.body?.string() ?: return null)
                val arr = json.optJSONArray("leaderboard") ?: return emptyList()
                (0 until arr.length()).map { idx ->
                    val entry = arr.getJSONObject(idx)
                    LeaderboardEntry(
                        pubkey = entry.optString("pubkey", ""),
                        points = entry.optLong("points", 0L),
                        uptimeSeconds = entry.optLong("uptimeSeconds", 0L)
                    )
                }
            }
        } catch (e: Exception) {
            null
        }
    }
}

// ===================== MISSÕES / PONTOS =====================
@Composable
fun MissionsScreen(
    signalingUrl: String,
    walletAddress: String,
    nodeActive: Boolean
) {
    var info by remember { mutableStateOf<PointsInfo?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf(false) }
    var leaderboard by remember { mutableStateOf<List<LeaderboardEntry>?>(null) }
    var leaderboardLoading by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    suspend fun refresh() {
        loading = true
        val result = withContext(Dispatchers.IO) {
            PointsClient.fetchPoints(signalingUrl, walletAddress)
        }
        info = result
        error = result == null
        loading = false
    }

    suspend fun refreshLeaderboard() {
        leaderboardLoading = true
        leaderboard = withContext(Dispatchers.IO) {
            PointsClient.fetchLeaderboard(signalingUrl)
        }
        leaderboardLoading = false
    }

    LaunchedEffect(walletAddress, signalingUrl) {
        refresh()
        refreshLeaderboard()
    }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(VagalunSpacing.large),
        verticalArrangement = Arrangement.spacedBy(VagalunSpacing.large)
    ) {
        VagalunHeader()

        Image(
            painter = painterResource(id = R.drawable.mascot_gift_a),
            contentDescription = "Vagalumin",
            modifier = Modifier.fillMaxWidth().height(140.dp),
            contentScale = ContentScale.Fit
        )

        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(Modifier.weight(1f)) {
                Text("Missões e pontos", style = VagalunTypography.titleLarge)
            }
            IconButton(onClick = {
                scope.launch {
                    refresh()
                    refreshLeaderboard()
                }
            }) {
                if (loading || leaderboardLoading) {
                    CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp, color = VagalunColors.red)
                } else {
                    Icon(Icons.Default.Refresh, contentDescription = "Atualizar pontos", tint = VagalunColors.red)
                }
            }
        }
        Text(
            "Seus pontos vêm de tempo online verificado com sua carteira e de provas " +
                "reais de armazenamento na rede — nada aqui é estimado.",
            style = VagalunTypography.bodySecondary
        )

        when {
            walletAddress.isEmpty() -> AnimatedCard {
                Text(
                    "Crie ou restaure sua carteira primeiro pra começar a pontuar.",
                    modifier = Modifier.padding(VagalunSpacing.large),
                    style = VagalunTypography.body
                )
            }
            loading -> AnimatedCard {
                Box(Modifier.fillMaxWidth().padding(VagalunSpacing.xlarge), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = VagalunColors.red)
                }
            }
            error || info == null -> AnimatedCard {
                Column(Modifier.padding(VagalunSpacing.large)) {
                    Text("Sem dados ainda", style = VagalunTypography.titleMedium)
                    Spacer(Modifier.height(4.dp))
                    Text(
                        if (!nodeActive)
                            "Ative o node pelo menos uma vez com esta carteira conectada ao relay pra começar a acumular pontos."
                        else
                            "Não consegui falar com o servidor de pontos agora. Tente de novo em instantes.",
                        style = VagalunTypography.bodySecondary
                    )
                }
            }
            else -> {
                val i = info!!
                AnimatedCard {
                    Column(Modifier.padding(VagalunSpacing.large)) {
                        Text("Seus pontos", style = VagalunTypography.bodySecondary)
                        Text("${i.points} PTS", style = VagalunTypography.titleLarge, color = VagalunColors.red)
                    }
                }
                AnimatedCard {
                    Column(Modifier.padding(VagalunSpacing.large)) {
                        QuickSummaryRow("Tempo online verificado", formatUptimeSeconds(i.uptimeSeconds))
                        QuickSummaryRow("Sessões contadas", i.sessions.toString())
                        QuickSummaryRow(
                            "Última atividade",
                            if (i.lastSeen > 0) formatDate(i.lastSeen) else "—"
                        )
                    }
                }
                Text(
                    "A conversão desses pontos em airdrop de token ainda não está aberta — " +
                        "isso será anunciado separadamente quando o snapshot acontecer.",
                    style = VagalunTypography.small
                )
            }
        }

        // Placar — sempre exibido, independente de ter carteira/pontos próprios,
        // porque é um dado público (não depende de walletAddress).
        Text("Placar", style = VagalunTypography.titleMedium)
        when {
            leaderboardLoading && leaderboard == null -> AnimatedCard {
                Box(Modifier.fillMaxWidth().padding(VagalunSpacing.xlarge), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = VagalunColors.red)
                }
            }
            leaderboard.isNullOrEmpty() -> AnimatedCard {
                Text(
                    "Ninguém pontuou ainda nesta rede — seja o primeiro.",
                    modifier = Modifier.padding(VagalunSpacing.large),
                    style = VagalunTypography.bodySecondary
                )
            }
            else -> AnimatedCard {
                Column(Modifier.padding(VagalunSpacing.large)) {
                    leaderboard!!.forEachIndexed { idx, entry ->
                        val isMe = walletAddress.isNotEmpty() && entry.pubkey == walletAddress
                        Row(
                            Modifier.fillMaxWidth().padding(vertical = 6.dp),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(
                                "#${idx + 1}  ${shortenPubkey(entry.pubkey)}${if (isMe) " (você)" else ""}",
                                style = if (isMe) VagalunTypography.body.copy(color = VagalunColors.red) else VagalunTypography.body
                            )
                            Text("${entry.points} PTS", style = VagalunTypography.body)
                        }
                        if (idx < leaderboard!!.lastIndex) {
                            Divider(color = VagalunColors.red.copy(alpha = 0.1f))
                        }
                    }
                }
            }
        }
    }
}

fun shortenPubkey(pubkey: String): String =
    if (pubkey.length <= 10) pubkey else "${pubkey.take(4)}…${pubkey.takeLast(4)}"

fun formatUptimeSeconds(seconds: Long): String {
    val mins = seconds / 60
    return when {
        mins < 60 -> "$mins min"
        else -> "${mins / 60}h ${mins % 60}min"
    }
}

// ===================== DATA CLASSES =====================
const val FREE_STORAGE_BYTES: Long = 2L * 1024 * 1024 * 1024

// Preço "vitrine" usado só para estimar custo/ganho na tela de envio.
// TODO: substituir por preço real vindo do contrato on-chain / GossipRegistry.
const val PRICE_PER_GB_PER_DAY_SOL: Double = 0.00003
const val NETWORK_FEE_SOL: Double = 0.00001

enum class FilePrivacy(val label: String, val description: String) {
    PUBLIC("Público", "Qualquer pessoa pode acessar"),
    SHARED("Compartilhado", "Apenas com link"),
    PRIVATE("Privado", "Criptografado de ponta a ponta")
}

enum class FileFilterTab(val label: String) {
    TODOS("Todos"), IMAGENS("Imagens"), DOCUMENTOS("Documentos"), VIDEOS("Vídeos")
}

data class UiFileEntry(
    val fileId: String,
    val fileName: String,
    val sizeBytes: Long,
    val mimeType: String,
    val k: Int,
    val n: Int,
    val localBytes: ByteArray? = null,
    val privacy: FilePrivacy = FilePrivacy.SHARED,
    val retentionDays: Int = 30,
    val uploadedAt: Long = System.currentTimeMillis()
)

// Arquivo já escolhido no seletor do sistema, aguardando configuração antes do envio.
data class PendingUpload(
    val uri: Uri,
    val fileName: String,
    val sizeBytes: Long,
    val mimeType: String
)

enum class HealthState { HEALTHY, DEGRADED, CRITICAL }

// ===================== FORMAT HELPERS =====================
fun formatUptime(nodeActive: Boolean, activeSinceMillis: Long): String {
    if (!nodeActive || activeSinceMillis <= 0L) return "—"
    val elapsedMin = (System.currentTimeMillis() - activeSinceMillis) / 60000
    return when {
        elapsedMin < 1 -> "menos de 1 min"
        elapsedMin < 60 -> "$elapsedMin min"
        else -> "${elapsedMin / 60}h ${elapsedMin % 60}min"
    }
}

fun formatSize(bytes: Long): String = when {
    bytes >= 1024L * 1024 * 1024 -> "%.2f GB".format(bytes / (1024.0 * 1024 * 1024))
    bytes >= 1024L * 1024 -> "%.1f MB".format(bytes / (1024.0 * 1024))
    else -> "${(bytes / 1024).coerceAtLeast(1)} KB"
}

fun formatDate(millis: Long): String =
    SimpleDateFormat("dd/MM/yyyy", Locale("pt", "BR")).format(Date(millis))

fun fileCategoryMatches(entry: UiFileEntry, tab: FileFilterTab): Boolean = when (tab) {
    FileFilterTab.TODOS -> true
    FileFilterTab.IMAGENS -> entry.mimeType.startsWith("image")
    FileFilterTab.VIDEOS -> entry.mimeType.startsWith("video")
    FileFilterTab.DOCUMENTOS -> !entry.mimeType.startsWith("image") &&
            !entry.mimeType.startsWith("video") &&
            !entry.mimeType.startsWith("audio")
}

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

    // Exposto para a UI poder ler quantos peers estão realmente conectados.
    fun connectedPeersCount(): Int =
        registry?.knownPeers()?.count { it.webrtcTransport != null } ?: 0

    // Metadados (nome/tamanho/mime) de uma Uri escolhida no seletor do sistema.
    fun resolveUriMetadata(uri: Uri): Triple<String, Long, String> {
        var name = uri.lastPathSegment ?: "arquivo_${System.currentTimeMillis()}"
        var size = 0L
        contentResolver.query(uri, null, null, null, null)?.use { cursor ->
            val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            val sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE)
            if (cursor.moveToFirst()) {
                if (nameIdx >= 0) name = cursor.getString(nameIdx) ?: name
                if (sizeIdx >= 0) size = cursor.getLong(sizeIdx)
            }
        }
        val mime = contentResolver.getType(uri) ?: "application/octet-stream"
        return Triple(name, size, mime)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
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

        val sc = SignalingClient(
            signalingUrl,
            nodeId,
            onSignal = { _, _ -> },
            onStateChange = { connected ->
                onLog(if (connected) "Signaling conectado (WAN ativa)" else "Signaling desconectado")
            },
            walletPubkeyBase58 = wallet?.publicKey?.toString(),
            signNodeId = { bytes -> wallet?.signMessage(bytes) ?: ByteArray(0) }
        )
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
        var pendingUpload by remember { mutableStateOf<PendingUpload?>(null) }
        var peersConnected by remember { mutableStateOf(0) }
        val scope = rememberCoroutineScope()
        val snackbarHostState = remember { SnackbarHostState() }
        var showSnackbarMessage by remember { mutableStateOf<String?>(null) }

        LaunchedEffect(showSnackbarMessage) {
            showSnackbarMessage?.let {
                snackbarHostState.showSnackbar(it)
                showSnackbarMessage = null
            }
        }

        // Atualiza a contagem de peers conectados periodicamente para o card "Resumo rápido".
        LaunchedEffect(nodeActive) {
            while (nodeActive) {
                peersConnected = connectedPeersCount()
                delay(3000)
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
                            when {
                                sig.contains("already in use") ->
                                    log("Conta on-chain já existia — seguindo normalmente.")
                                sig.contains("insufficient") || sig.contains("Insufficient") ->
                                    log("Saldo de SOL insuficiente pra criar a conta on-chain.")
                                else ->
                                    log("Não deu pra criar a conta on-chain: $sig")
                            }
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
                        usedFreeBytes = files.sumOf { it.sizeBytes },
                        filesCount = files.size,
                        peersConnected = peersConnected,
                        activeSinceMillis = startedAt
                    )
                }
                composable("files") {
                    FilesScreen(
                        files = files,
                        onUploadTap = {
                            pickFileForUpload { uri ->
                                val (name, size, mime) = resolveUriMetadata(uri)
                                pendingUpload = PendingUpload(uri, name, size, mime)
                                navController.navigate("upload")
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
                composable("upload") {
                    val pending = pendingUpload
                    if (pending == null) {
                        // Nada pendente (ex: usuário voltou depois de já ter enviado) — volta pra lista.
                        LaunchedEffect(Unit) { navController.popBackStack() }
                    } else {
                        UploadScreen(
                            pending = pending,
                            onCancel = {
                                pendingUpload = null
                                navController.popBackStack()
                            },
                            onConfirm = { privacy, retentionDays ->
                                scope.launch {
                                    withContext(Dispatchers.IO) {
                                        try {
                                            val bytes = contentResolver.openInputStream(pending.uri)?.readBytes()
                                                ?: return@withContext
                                            val mk = masterKey ?: return@withContext
                                            val result = storageClient?.uploadFile(bytes, pending.fileName, mk)
                                                ?: return@withContext
                                            files = files + UiFileEntry(
                                                fileId = result.fileId,
                                                fileName = pending.fileName,
                                                sizeBytes = bytes.size.toLong(),
                                                mimeType = pending.mimeType,
                                                k = result.k,
                                                n = result.n,
                                                privacy = privacy,
                                                retentionDays = retentionDays
                                            )
                                            log("Upload ok: ${pending.fileName}")
                                            withContext(Dispatchers.Main) {
                                                pendingUpload = null
                                                navController.popBackStack()
                                            }
                                        } catch (e: Exception) {
                                            log("Falha no upload: ${e.message}")
                                        }
                                    }
                                }
                            }
                        )
                    }
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
                        walletAddress = walletAddress,
                        wallet = wallet,
                        scope = scope,
                        onLog = { log(it) },
                        onShowSeed = { seedPhrase }
                    ) { navController.navigate("send") }
                }
                composable("missions") {
                    MissionsScreen(
                        signalingUrl = selfSignalingUrl,
                        walletAddress = walletAddress,
                        nodeActive = nodeActive
                    )
                }
                composable("send") {
                    SendSolScreen(
                        wallet = wallet,
                        scope = scope,
                        onLog = { log(it) },
                        onBack = { navController.popBackStack() }
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
            Triple("dashboard", "Home", Icons.Filled.Home),
            Triple("files", "Arquivos", Icons.Filled.Folder),
            Triple("wallet", "Carteira", Icons.Filled.AccountBalanceWallet),
            Triple("missions", "Missões", Icons.Filled.EmojiEvents),
            Triple("settings", "Config", Icons.Filled.Settings)
        )
        items.forEach { (route, label, icon) ->
            val selected = current == route || (route == "wallet" && current == "send") ||
                    (route == "files" && current == "upload")
            NavigationBarItem(
                selected = selected,
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

// ===================== HEADER (logo) =====================
@Composable
fun VagalunHeader(notificationCount: Int = 0) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically
    ) {
        // Proporção real do arquivo: 891x230 (bem larga/retangular).
        Image(
            painter = painterResource(id = R.drawable.logo3),
            contentDescription = "Vagalun",
            contentScale = ContentScale.Fit,
            modifier = Modifier
                .height(36.dp)
                .width(36.dp * (891f / 230f))
        )
    }
}

// ===================== DASHBOARD =====================
@Composable
fun DashboardScreen(
    nodeActive: Boolean,
    onToggleNode: (Boolean) -> Unit,
    walletAddress: String,
    capacityGb: Int,
    maxOfferableGb: Int,
    onQuotaChange: (Int) -> Unit,
    usedFreeBytes: Long,
    filesCount: Int,
    peersConnected: Int,
    activeSinceMillis: Long = 0L
) {
    var sliderValue by remember(capacityGb) { mutableStateOf(capacityGb.toFloat()) }
    val alphaAnim by animateFloatAsState(targetValue = 1f, animationSpec = tween(500))

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(VagalunSpacing.large)
            .alpha(alphaAnim),
        verticalArrangement = Arrangement.spacedBy(VagalunSpacing.large)
    ) {
        VagalunHeader(notificationCount = 3)

        AnimatedCard {
            Column(Modifier.padding(VagalunSpacing.large)) {
                Text(
                    if (nodeActive) "🟢 Sistema ativo" else "⚪ Sistema pausado",
                    style = VagalunTypography.titleMedium
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    if (nodeActive) "Seu dispositivo está contribuindo com a rede"
                    else "Ative para começar a ganhar recompensas",
                    style = VagalunTypography.bodySecondary
                )

                Spacer(Modifier.height(VagalunSpacing.medium))

                // Imagem do nó ativo/desativado (arquivos 500x500, quadrados).
                // Centralizada e com tamanho fixo para não distorcer.
                Box(
                    Modifier.fillMaxWidth(),
                    contentAlignment = Alignment.Center
                ) {
                    Image(
                        painter = painterResource(
                            id = if (nodeActive) R.drawable.node_ativo else R.drawable.node_desativo
                        ),
                        contentDescription = if (nodeActive) "Nó ativo" else "Nó desativado",
                        contentScale = ContentScale.Fit,
                        modifier = Modifier
                            .size(150.dp)
                    )
                }

                Spacer(Modifier.height(VagalunSpacing.medium))

                var buttonScale by remember { mutableStateOf(1f) }
                Button(
                    onClick = {
                        buttonScale = 0.95f
                        onToggleNode(!nodeActive)
                    },
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(48.dp)
                        .scale(buttonScale),
                    shape = VagalunShapes.button,
                    colors = ButtonDefaults.buttonColors(containerColor = VagalunColors.red)
                ) {
                    Text(
                        if (nodeActive) "DESATIVAR" else "ATIVAR AGORA",
                        color = Color.White,
                        fontWeight = FontWeight.Bold,
                        fontSize = 14.sp
                    )
                }
                LaunchedEffect(buttonScale) {
                    if (buttonScale < 1f) {
                        delay(150)
                        buttonScale = 1f
                    }
                }
            }
        }

        EarningsCard(nodeActive = nodeActive)

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
                Text("Máximo disponível: $maxOfferableGb GB", style = VagalunTypography.small)
            }
        }

        AnimatedCard {
            Column(Modifier.padding(VagalunSpacing.large)) {
                Text("Resumo rápido", style = VagalunTypography.titleMedium)
                Spacer(Modifier.height(VagalunSpacing.small))
                QuickSummaryRow("Arquivos na rede", filesCount.toString())
                QuickSummaryRow("Nós conectados", peersConnected.toString())
                QuickSummaryRow("Ativo há", formatUptime(nodeActive, activeSinceMillis))
            }
        }

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

@Composable
fun QuickSummaryRow(label: String, value: String) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(label, style = VagalunTypography.bodySecondary)
        Text(value, style = VagalunTypography.body.copy(fontWeight = FontWeight.SemiBold))
    }
}

// Card "Ganhos de hoje" com um sparkline decorativo.
// TODO: alimentar earnedTodaySol com o valor real acumulado pelo DailyClaimWorker.
@Composable
fun EarningsCard(nodeActive: Boolean) {
    val earnedTodaySol = if (nodeActive) 0.00245 else 0.0
    AnimatedCard {
        Column(Modifier.padding(VagalunSpacing.large)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Ganhos de hoje", style = VagalunTypography.bodySecondary)
                Spacer(Modifier.weight(1f))
                if (nodeActive) {
                    Box(
                        Modifier
                            .clip(RoundedCornerShape(20.dp))
                            .background(VagalunColors.success.copy(alpha = 0.15f))
                            .padding(horizontal = 8.dp, vertical = 2.dp)
                    ) {
                        Text("+12%", color = VagalunColors.success, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                    }
                }
            }
            Spacer(Modifier.height(4.dp))
            Text(
                "%.5f SOL".format(earnedTodaySol),
                style = VagalunTypography.titleLarge.copy(fontSize = 26.sp)
            )
            Text(
                "≈ $${"%.2f".format(earnedTodaySol * 140.0)} USD",
                style = VagalunTypography.small
            )
            Spacer(Modifier.height(VagalunSpacing.small))
            Sparkline(active = nodeActive)
        }
    }
}

@Composable
fun Sparkline(active: Boolean) {
    Canvas(
        Modifier
            .fillMaxWidth()
            .height(60.dp)
    ) {
        if (!active) return@Canvas
        val points = 24
        val path = Path()
        for (i in 0 until points) {
            val x = size.width * i / (points - 1)
            val noise = sin(i * 0.7f) * 0.15f
            val trend = i / (points - 1).toFloat()
            val y = size.height * (1f - (trend * 0.75f + 0.15f + noise).coerceIn(0f, 1f))
            if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
        }
        drawPath(
            path = path,
            color = VagalunColors.red,
            style = androidx.compose.ui.graphics.drawscope.Stroke(width = 3f)
        )
    }
}

// Helper: Card com animação de fade-in e escala
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
            .alpha(alpha)
            .scale(scale)
    ) {
        content()
    }
}

// ===================== FILES SCREEN =====================
@Composable
fun FilesScreen(
    files: List<UiFileEntry>,
    onUploadTap: () -> Unit,
    onDelete: (UiFileEntry) -> Unit,
    onOpen: (UiFileEntry, (ByteArray) -> Unit) -> Unit,
    navController: NavHostController
) {
    var query by remember { mutableStateOf("") }
    var activeTab by remember { mutableStateOf(FileFilterTab.TODOS) }

    val filtered = files.filter {
        (query.isBlank() || it.fileName.contains(query, ignoreCase = true)) &&
                fileCategoryMatches(it, activeTab)
    }

    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().padding(VagalunSpacing.medium)) {
            Text("Meus Arquivos", style = VagalunTypography.titleLarge)
            Spacer(Modifier.height(VagalunSpacing.small))

            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                placeholder = { Text("Buscar arquivos", style = VagalunTypography.bodySecondary) },
                leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null, tint = VagalunColors.textSecondary) },
                singleLine = true,
                shape = VagalunShapes.small,
                modifier = Modifier.fillMaxWidth()
            )
            Spacer(Modifier.height(VagalunSpacing.small))

            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(FileFilterTab.values().toList()) { tab ->
                    val selected = tab == activeTab
                    FilterChip(
                        selected = selected,
                        onClick = { activeTab = tab },
                        label = { Text(tab.label) },
                        colors = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = VagalunColors.red,
                            selectedLabelColor = Color.White,
                            containerColor = VagalunColors.bgCard,
                            labelColor = VagalunColors.textSecondary
                        )
                    )
                }
            }

            Spacer(Modifier.height(VagalunSpacing.small))
            Text("${filtered.size} arquivo(s) na rede", style = VagalunTypography.bodySecondary)
            Spacer(Modifier.height(VagalunSpacing.medium))

            if (filtered.isEmpty()) {
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
                    Text(
                        if (files.isEmpty()) "Nenhum arquivo ainda" else "Nada encontrado",
                        style = VagalunTypography.titleMedium
                    )
                    Spacer(Modifier.height(VagalunSpacing.medium))
                    if (files.isEmpty()) {
                        Button(
                            onClick = onUploadTap,
                            colors = ButtonDefaults.buttonColors(containerColor = VagalunColors.red),
                            shape = VagalunShapes.button,
                            modifier = Modifier.height(48.dp)
                        ) {
                            Text("ENVIAR ARQUIVO", color = Color.White, fontWeight = FontWeight.Bold)
                        }
                    }
                }
            } else {
                LazyColumn(verticalArrangement = Arrangement.spacedBy(VagalunSpacing.small)) {
                    items(filtered) { entry ->
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
            onClick = onUploadTap,
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
                Text(
                    "${formatSize(entry.sizeBytes)} • ${formatDate(entry.uploadedAt)}",
                    style = VagalunTypography.small
                )
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

// ===================== UPLOAD SCREEN =====================
@Composable
fun UploadScreen(
    pending: PendingUpload,
    onCancel: () -> Unit,
    onConfirm: (FilePrivacy, Int) -> Unit
) {
    var privacy by remember { mutableStateOf(FilePrivacy.SHARED) }
    var retentionDays by remember { mutableStateOf(30) }
    var customRetention by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }

    val gb = pending.sizeBytes / (1024.0 * 1024 * 1024)
    val effectiveDays = customRetention.toIntOrNull() ?: retentionDays
    val custoEstimado = gb * PRICE_PER_GB_PER_DAY_SOL * effectiveDays
    val voceRecebe = custoEstimado * 0.1

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(VagalunSpacing.large),
        verticalArrangement = Arrangement.spacedBy(VagalunSpacing.large)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onCancel) {
                Icon(Icons.Filled.ArrowBack, contentDescription = "Voltar", tint = VagalunColors.textPrimary)
            }
            Spacer(Modifier.width(4.dp))
            Text("Enviar Arquivo", style = VagalunTypography.titleMedium)
        }

        // Preview do arquivo já escolhido no seletor do sistema (sem drag-and-drop — é celular).
        Card(
            colors = CardDefaults.cardColors(containerColor = VagalunColors.bgCard),
            shape = VagalunShapes.card,
            modifier = Modifier.fillMaxWidth()
        ) {
            Row(
                Modifier.fillMaxWidth().padding(VagalunSpacing.medium),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Icon(Icons.Filled.InsertDriveFile, contentDescription = null, tint = VagalunColors.redSoft, modifier = Modifier.size(28.dp))
                Spacer(Modifier.width(VagalunSpacing.small))
                Column(Modifier.weight(1f)) {
                    Text(pending.fileName, style = VagalunTypography.body, maxLines = 1)
                    Text(formatSize(pending.sizeBytes), style = VagalunTypography.small)
                }
                IconButton(onClick = onCancel) {
                    Icon(Icons.Filled.Close, contentDescription = "Remover", tint = VagalunColors.textSecondary)
                }
            }
        }

        Column {
            Text("Privacidade", style = VagalunTypography.titleMedium)
            Spacer(Modifier.height(VagalunSpacing.small))
            FilePrivacy.values().forEach { option ->
                PrivacyOptionRow(
                    option = option,
                    selected = privacy == option,
                    onSelect = { privacy = option }
                )
            }
        }

        Column {
            Text("Tempo de armazenamento", style = VagalunTypography.titleMedium)
            Spacer(Modifier.height(VagalunSpacing.small))
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(listOf(7, 30, 90)) { days ->
                    val selected = customRetention.isBlank() && retentionDays == days
                    FilterChip(
                        selected = selected,
                        onClick = { retentionDays = days; customRetention = "" },
                        label = { Text("$days dias") },
                        colors = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = VagalunColors.red,
                            selectedLabelColor = Color.White,
                            containerColor = VagalunColors.bgCard,
                            labelColor = VagalunColors.textSecondary
                        )
                    )
                }
                item {
                    FilterChip(
                        selected = customRetention.isNotBlank(),
                        onClick = { customRetention = if (customRetention.isBlank()) "$retentionDays" else customRetention },
                        label = { Text("Personalizado") },
                        colors = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = VagalunColors.red,
                            selectedLabelColor = Color.White,
                            containerColor = VagalunColors.bgCard,
                            labelColor = VagalunColors.textSecondary
                        )
                    )
                }
            }
            if (customRetention.isNotBlank() || retentionDays !in listOf(7, 30, 90)) {
                Spacer(Modifier.height(VagalunSpacing.small))
                OutlinedTextField(
                    value = customRetention,
                    onValueChange = { customRetention = it.filter(Char::isDigit) },
                    label = { Text("Dias") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
            }
        }

        AnimatedCard {
            Column(Modifier.padding(VagalunSpacing.medium)) {
                Text("Resumo", style = VagalunTypography.titleMedium)
                Spacer(Modifier.height(VagalunSpacing.small))
                SummaryRow("Tamanho", formatSize(pending.sizeBytes))
                SummaryRow("Custo estimado", "%.5f SOL".format(custoEstimado))
                SummaryRow("Você recebe (após taxas)", "%.5f SOL".format(voceRecebe))
            }
        }

        Button(
            enabled = !sending,
            onClick = {
                sending = true
                onConfirm(privacy, effectiveDays)
            },
            colors = ButtonDefaults.buttonColors(containerColor = VagalunColors.red),
            modifier = Modifier.fillMaxWidth().height(52.dp),
            shape = VagalunShapes.button
        ) {
            Icon(Icons.Filled.CloudUpload, contentDescription = null, tint = Color.White)
            Spacer(Modifier.width(VagalunSpacing.small))
            Text(if (sending) "Enviando..." else "Enviar para a rede", color = Color.White, fontWeight = FontWeight.Bold)
        }
        Text(
            "Seu arquivo será distribuído entre os nós da rede.",
            style = VagalunTypography.small,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth()
        )
    }
}

@Composable
fun PrivacyOptionRow(option: FilePrivacy, selected: Boolean, onSelect: () -> Unit) {
    // Antes usava um preenchimento "vinho" (redDim) — trocado por borda vermelha
    // sólida sobre o fundo padrão do card, igual ao mockup.
    Card(
        onClick = onSelect,
        colors = CardDefaults.cardColors(containerColor = VagalunColors.bgCard),
        border = if (selected) BorderStroke(1.5.dp, VagalunColors.red) else null,
        shape = VagalunShapes.small,
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)
    ) {
        Row(
            Modifier.fillMaxWidth().padding(VagalunSpacing.medium),
            verticalAlignment = Alignment.CenterVertically
        ) {
            RadioButton(
                selected = selected,
                onClick = onSelect,
                colors = RadioButtonDefaults.colors(selectedColor = VagalunColors.red)
            )
            Spacer(Modifier.width(VagalunSpacing.small))
            Column {
                Text(option.label, style = VagalunTypography.body)
                Text(option.description, style = VagalunTypography.small)
            }
        }
    }
}

@Composable
fun SummaryRow(label: String, value: String) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(label, style = VagalunTypography.bodySecondary)
        Text(value, style = VagalunTypography.body)
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
                CircularProgressIndicator(color = VagalunColors.red, modifier = Modifier.size(48.dp))
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
            Image(
                painter = painterResource(id = R.drawable.mascot_wave),
                contentDescription = "Vagalumin",
                modifier = Modifier.height(160.dp),
                contentScale = ContentScale.Fit
            )
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
    walletAddress: String,
    wallet: SolanaWallet?,
    scope: CoroutineScope,
    onLog: (String) -> Unit,
    onShowSeed: () -> String,
    onNavigateSend: () -> Unit
) {
    var showSeed by remember { mutableStateOf(false) }
    var balanceLamports by remember { mutableStateOf<Long?>(null) }
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

        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(VagalunSpacing.small)) {
            Button(
                onClick = onNavigateSend,
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
                    Text(onShowSeed(), style = VagalunTypography.body, textAlign = TextAlign.Center)
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

// ===================== SEND SOL (tela própria, fora da carteira) =====================
@Composable
fun SendSolScreen(
    wallet: SolanaWallet?,
    scope: CoroutineScope,
    onLog: (String) -> Unit,
    onBack: () -> Unit
) {
    var toAddress by remember { mutableStateOf("") }
    var savedName by remember { mutableStateOf("") }
    var amountSol by remember { mutableStateOf(0.010) }
    var message by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }

    val quickAmounts = listOf(0.001, 0.005, 0.010, 0.050)
    val total = amountSol + NETWORK_FEE_SOL

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(VagalunSpacing.large),
        verticalArrangement = Arrangement.spacedBy(VagalunSpacing.large)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) {
                Icon(Icons.Filled.ArrowBack, contentDescription = "Voltar", tint = VagalunColors.textPrimary)
            }
            Spacer(Modifier.width(4.dp))
            Text("Enviar SOL", style = VagalunTypography.titleMedium)
        }

        AnimatedCard {
            Column(Modifier.padding(VagalunSpacing.medium), verticalArrangement = Arrangement.spacedBy(VagalunSpacing.small)) {
                Text("Para quem você quer enviar?", style = VagalunTypography.bodySecondary)
                OutlinedTextField(
                    value = toAddress,
                    onValueChange = { toAddress = it },
                    placeholder = { Text("Endereço da carteira") },
                    singleLine = true,
                    trailingIcon = {
                        Icon(Icons.Filled.ContentCopy, contentDescription = null, tint = VagalunColors.textSecondary)
                    },
                    modifier = Modifier.fillMaxWidth()
                )
                Text("Nome salvo (opcional)", style = VagalunTypography.bodySecondary)
                OutlinedTextField(
                    value = savedName,
                    onValueChange = { savedName = it },
                    placeholder = { Text("Adicionar um apelido") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
            }
        }

        AnimatedCard {
            Column(Modifier.padding(VagalunSpacing.medium), verticalArrangement = Arrangement.spacedBy(VagalunSpacing.small)) {
                Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                    Text("Quanto você quer enviar?", style = VagalunTypography.bodySecondary)
                    TextButton(onClick = {
                        scope.launch(Dispatchers.IO) {
                            val lamports = wallet?.getBalanceLamports() ?: return@launch
                            val maxSol = (lamports / 1_000_000_000.0 - NETWORK_FEE_SOL).coerceAtLeast(0.0)
                            withContext(Dispatchers.Main) { amountSol = maxSol }
                        }
                    }) {
                        Text("Máx.", color = VagalunColors.red, fontSize = 12.sp)
                    }
                }
                Text("%.4f SOL".format(amountSol), style = VagalunTypography.titleLarge.copy(fontSize = 26.sp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    quickAmounts.forEach { amt ->
                        val selected = amountSol == amt
                        FilterChip(
                            selected = selected,
                            onClick = { amountSol = amt },
                            label = { Text("%.3f".format(amt)) },
                            colors = FilterChipDefaults.filterChipColors(
                                selectedContainerColor = VagalunColors.red,
                                selectedLabelColor = Color.White,
                                containerColor = VagalunColors.bgCard2,
                                labelColor = VagalunColors.textSecondary
                            )
                        )
                    }
                }
            }
        }

        AnimatedCard {
            Column(Modifier.padding(VagalunSpacing.medium)) {
                Text("Mensagem (opcional)", style = VagalunTypography.bodySecondary)
                OutlinedTextField(
                    value = message,
                    onValueChange = { message = it },
                    placeholder = { Text("Deixe uma mensagem") },
                    modifier = Modifier.fillMaxWidth()
                )
            }
        }

        AnimatedCard {
            Column(Modifier.padding(VagalunSpacing.medium)) {
                SummaryRow("Você envia", "%.4f SOL".format(amountSol))
                SummaryRow("Taxa da rede", "%.5f SOL".format(NETWORK_FEE_SOL))
                Divider(color = VagalunColors.bgCard2, modifier = Modifier.padding(vertical = 4.dp))
                Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                    Text("Total", style = VagalunTypography.titleMedium)
                    Text("%.5f SOL".format(total), style = VagalunTypography.titleMedium)
                }
            }
        }

        Button(
            enabled = !busy && toAddress.isNotBlank() && amountSol > 0.0,
            onClick = {
                busy = true
                scope.launch(Dispatchers.IO) {
                    try {
                        val lamports = (amountSol * 1_000_000_000L).toLong()
                        val sig = wallet?.transferSol(toAddress, lamports)
                        onLog("SOL enviado. Assinatura: $sig")
                    } catch (e: Exception) {
                        onLog("Erro ao enviar SOL: ${e.message}")
                    } finally {
                        busy = false
                    }
                }
            },
            colors = ButtonDefaults.buttonColors(containerColor = VagalunColors.red),
            modifier = Modifier.fillMaxWidth().height(52.dp),
            shape = VagalunShapes.button
        ) {
            Icon(Icons.Filled.Send, contentDescription = null, tint = Color.White)
            Spacer(Modifier.width(VagalunSpacing.small))
            Text(if (busy) "Enviando..." else "Enviar agora", color = Color.White, fontWeight = FontWeight.Bold)
        }
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(Icons.Filled.Lock, contentDescription = null, tint = VagalunColors.success, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(4.dp))
            Text("Transação segura e criptografada", style = VagalunTypography.small)
        }
    }
}
