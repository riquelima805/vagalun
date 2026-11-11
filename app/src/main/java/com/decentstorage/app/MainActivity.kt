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
import androidx.compose.ui.unit.em
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.style.BaselineShift
import androidx.compose.foundation.isSystemInDarkTheme
import com.decentstorage.app.storage.UiFileStore
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.decentstorage.app.crypto.KeyManager
import com.decentstorage.app.network.GossipRegistry
import com.decentstorage.app.network.ShardRequestHandler
import com.decentstorage.app.network.EdgeReplicator
import com.decentstorage.app.network.ShardServer
import com.decentstorage.app.network.webrtc.RelayTransport
import com.decentstorage.app.network.webrtc.SignalingClient
import com.decentstorage.app.network.webrtc.WebRtcManager
import com.decentstorage.app.storage.DeviceStorage
import com.decentstorage.app.wallet.AnchorStorageClient
import com.decentstorage.app.wallet.EpochPayoutClient
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
    private val _dark = mutableStateOf(false)
    var dark: Boolean
        get() = _dark.value
        set(v) { _dark.value = v }

    private fun pick(light: Long, night: Long) = Color(if (dark) night else light)

    val bg: Color get() = pick(0xFFFFFFFF, 0xFF0F0F0E)
    val bgCard: Color get() = pick(0xFFF5F5F4, 0xFF1A1A19)
    val bgCard2: Color get() = pick(0xFFECECEA, 0xFF242423)
    val cardBorder: Color get() = pick(0xFFE6E6E4, 0xFF2E2E2C)

    val red: Color get() = pick(0xFFE5382B, 0xFFF0503F)
    val redSoft: Color get() = pick(0xFFE5382B, 0xFFF26A5C)
    val redTint: Color get() = pick(0xFFFCE4E1, 0xFF3A1F1C)

    val textPrimary: Color get() = pick(0xFF111111, 0xFFF2F2F0)
    val textSecondary: Color get() = pick(0xFF777777, 0xFFA0A09B)

    val danger: Color get() = pick(0xFFE5382B, 0xFFF0503F)
    val warning: Color get() = pick(0xFFC98A2C, 0xFFF0B04A)
    val success: Color get() = pick(0xFF1F9D55, 0xFF34C27A)
}

/**
 * Esquema Material 3 totalmente definido a partir das cores da Vagalun.
 * Antes só 6 cores eram definidas e o resto caía no roxo padrão do Material,
 * além do surfaceTint, que pintava barras e diálogos de avermelhado.
 */
fun vagalunColorScheme(dark: Boolean): androidx.compose.material3.ColorScheme {
    val c = VagalunColors
    return if (dark) darkColorScheme(
        primary = c.red, onPrimary = Color.White,
        primaryContainer = c.redTint, onPrimaryContainer = Color.White,
        secondary = c.redSoft, onSecondary = Color.White,
        secondaryContainer = c.bgCard2, onSecondaryContainer = c.textPrimary,
        tertiary = c.success, onTertiary = Color.White,
        background = c.bg, onBackground = c.textPrimary,
        surface = c.bg, onSurface = c.textPrimary,
        surfaceVariant = c.bgCard, onSurfaceVariant = c.textSecondary,
        surfaceTint = Color.Transparent,
        surfaceContainerLowest = c.bg, surfaceContainerLow = c.bgCard, surfaceContainer = c.bgCard,
        surfaceContainerHigh = c.bgCard2, surfaceContainerHighest = c.bgCard2,
        outline = c.textSecondary, outlineVariant = c.cardBorder,
        error = c.danger, onError = Color.White
    ) else lightColorScheme(
        primary = c.red, onPrimary = Color.White,
        primaryContainer = c.redTint, onPrimaryContainer = c.textPrimary,
        secondary = c.redSoft, onSecondary = Color.White,
        secondaryContainer = c.bgCard2, onSecondaryContainer = c.textPrimary,
        tertiary = c.success, onTertiary = Color.White,
        background = c.bg, onBackground = c.textPrimary,
        surface = c.bg, onSurface = c.textPrimary,
        surfaceVariant = c.bgCard, onSurfaceVariant = c.textSecondary,
        surfaceTint = Color.Transparent,
        surfaceContainerLowest = c.bg, surfaceContainerLow = c.bgCard, surfaceContainer = c.bgCard,
        surfaceContainerHigh = c.bgCard, surfaceContainerHighest = c.bgCard2,
        outline = c.textSecondary, outlineVariant = c.cardBorder,
        error = c.danger, onError = Color.White
    )
}

object VagalunTypography {
    val titleLarge get() = TextStyle(fontSize = 28.sp, fontWeight = FontWeight.Bold, color = VagalunColors.textPrimary)
    val titleMedium get() = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold, color = VagalunColors.textPrimary)
    val body get() = TextStyle(fontSize = 15.sp, color = VagalunColors.textPrimary)
    val bodySecondary get() = TextStyle(fontSize = 14.sp, color = VagalunColors.textSecondary)
    val small get() = TextStyle(fontSize = 12.sp, color = VagalunColors.textSecondary)
}

// ===================== VALORES EM REAIS =====================
/** Só usado se ainda não houve nenhuma cotação (sem internet na primeira abertura). */
const val FALLBACK_BRL_PER_SOL: Double = 700.0

object SolPrice {
    @Volatile var brlPerSol: Double = FALLBACK_BRL_PER_SOL

    fun load(prefs: SharedPreferences) {
        val v = prefs.getFloat("brlPerSol", 0f).toDouble()
        brlPerSol = if (v > 0) v else FALLBACK_BRL_PER_SOL
    }

    fun refresh(prefs: SharedPreferences) {
        try {
            val req = Request.Builder()
                .url("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=brl").build()
            OkHttpClient.Builder().callTimeout(8, TimeUnit.SECONDS).build().newCall(req).execute().use { r ->
                if (!r.isSuccessful) return
                val brl = JSONObject(r.body?.string() ?: return).getJSONObject("solana").getDouble("brl")
                if (brl > 0) { brlPerSol = brl; prefs.edit().putFloat("brlPerSol", brl.toFloat()).apply() }
            }
        } catch (_: Exception) { /* mantém a última cotação salva */ }
    }
}

fun solToBrl(sol: Double): Double = sol * SolPrice.brlPerSol

private fun brlParts(reais: Double): Triple<String, Int, Int> {
    val milli = Math.round(reais * 1000.0)
    val whole = java.text.NumberFormat.getIntegerInstance(Locale("pt", "BR")).format(milli / 1000)
    return Triple(whole, ((milli / 10) % 100).toInt(), (milli % 10).toInt())
}

/** Versão em texto puro (linhas de resumo, logs) com o dígito pequeno em sobrescrito Unicode. */
fun brlPlain(reais: Double): String {
    val (w, c, f) = brlParts(reais)
    return "R\$ $w,${"%02d".format(c)}" + "⁰¹²³⁴⁵⁶⁷⁸⁹"[f]
}

/** Saldo em SOL, ex.: "0,4521 SOL" (o "SOL" em tamanho menor). Até 4 casas; valores minúsculos mostram até 6 para não virar "0,00". */
fun solText(sol: Double): AnnotatedString {
    val nf = java.text.NumberFormat.getNumberInstance(Lang.locale)
    nf.minimumFractionDigits = 2
    nf.maximumFractionDigits = if (sol > 0.0 && sol < 0.01) 6 else 4
    return buildAnnotatedString {
        append(nf.format(sol))
        withStyle(SpanStyle(fontSize = 0.5f.em)) { append(" SOL") }
    }
}

/** Valor em reais simples, ex.: "R$ 12,34" (sem a fração de centavo usada nos pontos). */
fun brlSimple(reais: Double): String =
    java.text.NumberFormat.getCurrencyInstance(Locale("pt", "BR")).format(reais)

fun guessMimeType(name: String): String {
    val ext = name.substringAfterLast('.', "").lowercase(Locale.ROOT)
    return android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
}

object VagalunShapes {
    val card = RoundedCornerShape(22.dp)
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

    data class Config(val signalingUrl: String, val referralUrl: String?)

    fun fetchConfig(): Config? {
        return try {
            val request = Request.Builder().url(CONFIG_URL).build()
            client.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return null
                val body = resp.body?.string()?.trim()
                if (body.isNullOrBlank()) return null
                val json = JSONObject(body)
                val url = json.optString("signalingUrl", json.optString("url", json.optString("wss", ""))).trim()
                if (url.isBlank()) return null
                // Opcional: endereço do servidor de convites, se for diferente do signaling.
                val referral = json.optString("referralUrl", "").trim().trimEnd('/').ifBlank { null }
                Config(url, referral)
            }
        } catch (e: Exception) {
            null
        }
    }

    fun fetchSignalingUrl(): String? = fetchConfig()?.signalingUrl
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
        elapsedMin < 1 -> tr("menos de 1 min")
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
    SimpleDateFormat(if (Lang.code == "en") "MM/dd/yyyy" else "dd/MM/yyyy", Lang.locale).format(Date(millis))

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

    // ----- Convites (indicações) -----
    // Endereço do servidor de convites vindo do reley.json (vazio = mesmo servidor do signaling).
    private var selfReferralUrl: String = ""
    // Código digitado/recebido por link que ainda não foi resgatado. Espelho de prefs["pendingInvite"].
    private var pendingInvite by mutableStateOf<String?>(null)

    fun referralBase(): String = ReferralClient.baseUrl(selfReferralUrl, selfSignalingUrl)

    /** Guarda o código para resgatar assim que a carteira estiver pronta. false = código inválido ou já resgatado. */
    private fun acceptInviteCode(raw: String?): Boolean {
        val code = ReferralClient.normalizeCode(raw) ?: return false
        if (prefs.getBoolean("inviteRedeemed", false)) return false
        prefs.edit().putString("pendingInvite", code).apply()
        pendingInvite = code
        return true
    }

    /** Resgata [raw] com a carteira atual (assinando a mensagem). Chamar fora da thread principal. */
    fun redeemInviteCode(raw: String): RedeemResult {
        val code = ReferralClient.normalizeCode(raw) ?: return RedeemResult.InvalidCode
        val w = wallet ?: return RedeemResult.Unavailable
        val base = referralBase()
        if (base.isBlank()) return RedeemResult.Unavailable
        val pubkey = w.publicKey.toBase58()
        val signature = try {
            w.signMessage(ReferralClient.message(code, pubkey).toByteArray(Charsets.UTF_8))
        } catch (e: Exception) {
            return RedeemResult.Unavailable
        }
        val result = ReferralClient.redeem(base, code, pubkey, signature)
        if (result.isFinal) {
            // Resultado definitivo: não tenta de novo o mesmo código.
            prefs.edit().remove("pendingInvite").apply()
            pendingInvite = null
        }
        if (result.isSuccess) prefs.edit().putBoolean("inviteRedeemed", true).apply()
        return result
    }

    // Link de convite: vagalun://invite/CODIGO (aberto pela página /i/CODIGO do servidor).
    private fun handleInviteIntent(intent: android.content.Intent?) {
        val data = intent?.data ?: return
        if (data.scheme == "vagalun" && data.host == "invite") acceptInviteCode(data.lastPathSegment)
    }

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        handleInviteIntent(intent)
    }
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
        SolPrice.load(prefs)
        Lang.mode = prefs.getInt("langMode", 0)
        selfReferralUrl = prefs.getString("referralUrl", "") ?: ""
        pendingInvite = if (prefs.getBoolean("inviteRedeemed", false)) null else prefs.getString("pendingInvite", null)
        handleInviteIntent(intent)

        setContent {
            // 0 = automático (segue o sistema), 1 = claro, 2 = escuro
            var themeMode by remember { mutableStateOf(prefs.getInt("themeMode", 0)) }
            val dark = when (themeMode) { 1 -> false; 2 -> true; else -> isSystemInDarkTheme() }
            VagalunColors.dark = dark
            val scheme = vagalunColorScheme(dark)
            MaterialTheme(colorScheme = scheme) {
                VagalunApp(themeMode = themeMode, onThemeChange = {
                    themeMode = it
                    prefs.edit().putInt("themeMode", it).apply()
                })
            }
        }
    }

    // Salva o registry ao sair do app, sem esperar o timer de 250 ms.
    override fun onStop() {
        super.onStop()
        try { registry?.flushNow() } catch (_: Exception) {}
    }

    private fun ensureQuotaWithinPhysicalLimits(requested: Long): Long {
        val maxOfferable = DeviceStorage.maxOfferableBytes(this)
        return requested.coerceAtMost(maxOfferable).coerceAtLeast(1L * 1024 * 1024)
    }

    private fun ensureEngineStarted(seedPhrase: String, onReady: (walletAddr: String) -> Unit, onLog: (String) -> Unit) {
        if (registry != null) return
        val seedBytes = KeyManager.seedBytes(seedPhrase)
        masterKey = KeyManager.deriveMasterKey(seedPhrase)
        SolPrice.refresh(prefs)
        // nodeId precisa ser ESTÁVEL entre reconexões/restarts do app: é a
        // identidade que os outros peers usam pra saber "quem hospeda o quê"
        // (ver comentário em sever/gateway/registry.js sobre addPeer/
        // addRelayPeer — a persistência de peer no gateway só é segura
        // *porque* o nodeId do celular não muda). Sortear um nodeId novo a
        // cada boot, como era antes, invalidava silenciosamente todas as
        // placements existentes (o próprio nó e os outros peers passavam a
        // procurar o shard sob um nodeId que não existe mais).
        val nodeId = prefs.getString("nodeId", null) ?: run {
            val generated = "node-" + SecureRandom().nextInt(1_000_000)
            prefs.edit().putString("nodeId", generated).apply()
            generated
        }
        selfNodeId = nodeId
        selfDataDir = File(filesDir, "shards").also { it.mkdirs() }

        val requestHandler = ShardRequestHandler(nodeId, selfCapacityBytes, selfDataDir!!, applicationContext) { gossipPayload ->
            registry?.handleIncomingGossip(gossipPayload) ?: JSONObject()
        }

        val reg = GossipRegistry(nodeId, "127.0.0.1", 8901, selfCapacityBytes, dataDir = filesDir)
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
        val remote = RelayConfig.fetchConfig()
        val fetched = remote?.signalingUrl
        remote?.referralUrl?.let {
            selfReferralUrl = it
            prefs.edit().putString("referralUrl", it).apply()
        }
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
        // Réplica de borda peer a peer (pedida pelo gateway): baixa de outro celular, confere hash, grava.
        val edgeReplicator = EdgeReplicator({ registry }, reqHandler) { onLog(it) }

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
            if (header.optString("op") == EdgeReplicator.OP) {
                // Só aceita ordem de réplica vinda do gateway (nodeId de infra). Responde depois,
                // de outra thread, pra não travar o WebSocket do signaling.
                if (!from.startsWith("gateway")) {
                    sc.sendRelayResponse(from, requestId,
                        JSONObject().put("ok", false).put("code", "forbidden").put("error", "só o gateway pode pedir réplica"), null)
                } else {
                    edgeReplicator.handleAsync(header) { rh, rp -> sc.sendRelayResponse(from, requestId, rh, rp) }
                }
            } else {
                val (respHeader, respPayload) = try {
                    reqHandler.handle(header, payload)
                } catch (e: Exception) {
                    JSONObject().put("ok", false).put("error", e.message ?: "erro") to null
                }
                sc.sendRelayResponse(from, requestId, respHeader, respPayload)
            }
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
    fun VagalunApp(themeMode: Int = 0, onThemeChange: (Int) -> Unit = {}) {
        val navController = rememberNavController()
        var hasWallet by remember { mutableStateOf(prefs.getString("seed", null) != null) }
        var seedPhrase by remember { mutableStateOf(prefs.getString("seed", "") ?: "") }
        var walletAddress by remember { mutableStateOf("") }
        var nodeActive by remember { mutableStateOf(false) }
        var logLines by remember { mutableStateOf(listOf<String>()) }
        var files by remember { mutableStateOf(UiFileStore.load(filesDir)) }
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
                                    log(tr("Conta on-chain já existia — seguindo normalmente."))
                                sig.contains("insufficient") || sig.contains("Insufficient") ->
                                    log(tr("Saldo de SOL insuficiente pra criar a conta on-chain."))
                                else ->
                                    log(tr("Não deu pra criar a conta on-chain: %s", sig))
                            }
                        } else {
                            log(tr("Conta on-chain criada com sucesso!"))
                        }

                        startedAt = System.currentTimeMillis()
                        nodeActive = true
                    } catch (e: Exception) {
                        log(tr("Erro ao iniciar: %s", e.message))
                    }
                }
            }
        }

        var welcomeDone by remember { mutableStateOf(prefs.getBoolean("welcomeDone", false)) }
        if (!welcomeDone) {
            WelcomeScreen(onDone = {
                prefs.edit().putBoolean("welcomeDone", true).apply()
                welcomeDone = true
            })
            return
        }

        if (!hasWallet) {
            WalletOnboardingScreen(
                initialInviteCode = pendingInvite.orEmpty(),
                onSeedReady = { phrase, invite ->
                    acceptInviteCode(invite)
                    prefs.edit().putString("seed", phrase).apply()
                    seedPhrase = phrase
                    hasWallet = true
                    startNode()
                }
            )
            return
        }

        LaunchedEffect(Unit) { startNode() }
        // Salva a lista sempre que mudar: sobrevive a reinício do celular e a app fechado pelo sistema.
        LaunchedEffect(files) { withContext(Dispatchers.IO) { UiFileStore.save(filesDir, files) } }

        // Código de convite pendente (digitado na criação da conta ou vindo de link): resgata assim que
        // a carteira existe. Se a rede falhar, tenta de novo a cada 30 s (até 5 vezes).
        LaunchedEffect(walletAddress, pendingInvite) {
            var attempts = 0
            while (attempts < 5 && walletAddress.isNotEmpty()) {
                val code = pendingInvite ?: break
                val r = withContext(Dispatchers.IO) { redeemInviteCode(code) }
                if (r.isFinal) { log(r.message()); break }
                attempts++
                delay(30_000)
            }
        }

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
                                log(tr("Sistema desativado"))
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
                        activeSinceMillis = startedAt,
                        signalingUrl = selfSignalingUrl,
                        referralBaseUrl = referralBase(),
                        onOpenSettings = { navController.navigate("settings") },
                        onOpenMap = { navController.navigate("brasil") }
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
                            log(tr("Arquivo removido: %s", entry.fileId))
                        },
                        onOpen = { entry, onLoaded ->
                            scope.launch {
                                withContext(Dispatchers.IO) {
                                    try {
                                        val mk = masterKey ?: return@withContext
                                        val data = storageClient?.downloadFile(entry.fileId, mk) ?: return@withContext
                                        withContext(Dispatchers.Main) { onLoaded(data) }
                                    } catch (e: Exception) {
                                        log(tr("Falha ao abrir: %s", e.message))
                                    }
                                }
                            }
                        },
                        navController = navController,
                        onOpenSettings = { navController.navigate("settings") }
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
                                            log(tr("Upload ok: %s", pending.fileName))
                                            withContext(Dispatchers.Main) {
                                                pendingUpload = null
                                                navController.popBackStack()
                                            }
                                        } catch (e: Exception) {
                                            log(tr("Falha no upload: %s", e.message))
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
                                        log(tr("Falha ao carregar mídia: %s", e.message))
                                    }
                                }
                            }
                        },
                        onReport = { log(tr("Arquivo denunciado")) },
                        onBack = { navController.popBackStack() }
                    )
                }
                composable("settings") {
                    SettingsScreen(
                        wifiOnly = wifiOnly,
                        onWifiOnlyChange = { wifiOnly = it; prefs.edit().putBoolean("wifiOnly", it).apply() },
                        backgroundSync = backgroundSync,
                        onBackgroundSyncChange = { backgroundSync = it; prefs.edit().putBoolean("bgSync", it).apply() },
                        themeMode = themeMode,
                        onThemeChange = onThemeChange,
                        walletAddress = walletAddress,
                        onOpenWallet = { navController.navigate("wallet") { launchSingleTop = true } },
                        langMode = Lang.mode,
                        onLangChange = { Lang.mode = it; prefs.edit().putInt("langMode", it).apply() },
                        onClearDeadShards = {
                            // Só temporários: gravações incompletas e cache de reprodução.
                            // Os fragmentos (.shard) guardados neste nó NUNCA são apagados aqui.
                            var freed = 0L
                            selfDataDir?.listFiles { f -> f.name.endsWith(".tmp") }?.forEach { freed += it.length(); it.delete() }
                            cacheDir.listFiles()?.forEach { freed += it.length(); it.deleteRecursively() }
                            log(tr("Cache limpo: %d KB liberados. Seus arquivos na rede não foram tocados.", freed / 1024))
                        }
                    )
                }
                composable("wallet") {
                    WalletScreen(
                        walletAddress = walletAddress,
                        wallet = wallet,
                        anchorClient = anchorClient,
                        signalingUrl = selfSignalingUrl,
                        scope = scope,
                        onLog = { log(it) },
                        onShowSeed = { seedPhrase },
                        onOpenSettings = { navController.navigate("settings") }
                    ) { navController.navigate("send") }
                }
                composable("missions") {
                    MissionsScreen(
                        signalingUrl = selfSignalingUrl,
                        referralBaseUrl = referralBase(),
                        onRedeemCode = { code -> withContext(Dispatchers.IO) { redeemInviteCode(code) } },
                        walletAddress = walletAddress,
                        nodeActive = nodeActive,
                        filesCount = files.size,
                        onOpenSettings = { navController.navigate("settings") }
                    )
                }
                composable("brasil") {
                    BrasilNetworkScreen(onOpenSettings = { navController.navigate("settings") })
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

    Column {
        Divider(color = VagalunColors.cardBorder, thickness = 1.dp)
        NavigationBar(
            containerColor = VagalunColors.bg,
            tonalElevation = 0.dp
        ) {
            val items = listOf(
                Triple("dashboard", tr("Início"), Lucide.House),
                Triple("files", tr("Arquivos"), Lucide.Folder),
                Triple("wallet", tr("Carteira"), Lucide.Wallet),
                Triple("missions", tr("Missões"), Lucide.Trophy)
            )
            items.forEach { (route, label, icon) ->
                val selected = current == route || (route == "wallet" && current == "send") ||
                        (route == "files" && current == "upload") ||
                        (route == "dashboard" && (current == "settings" || current == "brasil"))
                NavigationBarItem(
                    selected = selected,
                    onClick = { if (current != route) navController.navigate(route) { launchSingleTop = true } },
                    icon = { Icon(icon, contentDescription = label, modifier = Modifier.size(24.dp)) },
                    label = { Text(label, fontSize = 11.sp, fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal) },
                    colors = NavigationBarItemDefaults.colors(
                        selectedIconColor = VagalunColors.textPrimary,
                        selectedTextColor = VagalunColors.textPrimary,
                        unselectedIconColor = VagalunColors.textSecondary,
                        unselectedTextColor = VagalunColors.textSecondary,
                        indicatorColor = VagalunColors.bgCard2
                    )
                )
            }
        }
    }
}

// ===================== DASHBOARD =====================


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
        border = BorderStroke(1.dp, VagalunColors.cardBorder),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
        modifier = Modifier
            .fillMaxWidth()
            .alpha(alpha)
            .scale(scale)
    ) {
        content()
    }
}

// ===================== FILES SCREEN =====================




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
                Icon(Lucide.ArrowLeft, contentDescription = tr("Voltar"), tint = VagalunColors.textPrimary)
            }
            Spacer(Modifier.width(4.dp))
            Text(tr("Enviar Arquivo"), style = VagalunTypography.titleMedium)
        }

        // Preview do arquivo já escolhido no seletor do sistema (sem drag-and-drop — é celular).
        Card(
            colors = CardDefaults.cardColors(containerColor = VagalunColors.bgCard),
            border = BorderStroke(1.dp, VagalunColors.cardBorder),
            elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
            shape = VagalunShapes.card,
            modifier = Modifier.fillMaxWidth()
        ) {
            Row(
                Modifier.fillMaxWidth().padding(VagalunSpacing.medium),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Icon(Lucide.File, contentDescription = null, tint = VagalunColors.redSoft, modifier = Modifier.size(28.dp))
                Spacer(Modifier.width(VagalunSpacing.small))
                Column(Modifier.weight(1f)) {
                    Text(pending.fileName, style = VagalunTypography.body, maxLines = 1)
                    Text(formatSize(pending.sizeBytes), style = VagalunTypography.small)
                }
                IconButton(onClick = onCancel) {
                    Icon(Lucide.X, contentDescription = tr("Remover"), tint = VagalunColors.textSecondary)
                }
            }
        }

        Column {
            Text(tr("Privacidade"), style = VagalunTypography.titleMedium)
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
            Text(tr("Tempo de armazenamento"), style = VagalunTypography.titleMedium)
            Spacer(Modifier.height(VagalunSpacing.small))
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(listOf(7, 30, 90)) { days ->
                    val selected = customRetention.isBlank() && retentionDays == days
                    FilterChip(
                        selected = selected,
                        onClick = { retentionDays = days; customRetention = "" },
                        label = { Text(tr("%d dias", days)) },
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
                        label = { Text(tr("Personalizado")) },
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
                    label = { Text(tr("Dias")) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
            }
        }

        AnimatedCard {
            Column(Modifier.padding(VagalunSpacing.medium)) {
                Text(tr("Resumo"), style = VagalunTypography.titleMedium)
                Spacer(Modifier.height(VagalunSpacing.small))
                SummaryRow(tr("Tamanho"), formatSize(pending.sizeBytes))
                SummaryRow(tr("Custo estimado"), brlPlain(solToBrl(custoEstimado)))
                SummaryRow(tr("Você recebe (após taxas)"), brlPlain(solToBrl(voceRecebe)))
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
            Icon(Lucide.CloudUpload, contentDescription = null, tint = Color.White)
            Spacer(Modifier.width(VagalunSpacing.small))
            Text(if (sending) tr("Enviando...") else tr("Enviar para a rede"), color = Color.White, fontWeight = FontWeight.Bold)
        }
        Text(
            tr("Seu arquivo será distribuído entre os nós da rede."),
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
        border = BorderStroke(if (selected) 1.5.dp else 1.dp, if (selected) VagalunColors.red else VagalunColors.cardBorder),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
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
                Text(tr(option.label), style = VagalunTypography.body)
                Text(tr(option.description), style = VagalunTypography.small)
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
                CircularProgressIndicator(color = VagalunColors.redSoft, modifier = Modifier.size(48.dp))
                Spacer(Modifier.height(VagalunSpacing.small))
                Text(
                    tr("Buscando shards na rede..."),
                    style = VagalunTypography.bodySecondary.copy(color = Color(0xFFCFC7BC))
                )
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
                Icon(Lucide.ArrowLeft, contentDescription = tr("Voltar"), tint = Color.White)
            }
            IconButton(onClick = onReport) {
                Icon(Lucide.Flag, contentDescription = tr("Denunciar"), tint = VagalunColors.danger)
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
                checkedThumbColor = Color.White,
                checkedTrackColor = VagalunColors.success
            )
        )
    }
}

// ===================== ONBOARDING =====================
@Composable
fun WalletOnboardingScreen(initialInviteCode: String = "", onSeedReady: (seed: String, inviteCode: String?) -> Unit) {
    var mode by remember { mutableStateOf("choose") }
    var inviteInput by remember { mutableStateOf(initialInviteCode) }
    val inviteInvalid = inviteInput.isNotEmpty() && ReferralClient.normalizeCode(inviteInput) == null
    val invite = ReferralClient.normalizeCode(inviteInput)
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
            Text(tr("Sua chave, sua carteira Solana."), style = VagalunTypography.bodySecondary, textAlign = TextAlign.Center)

            when (mode) {
                "choose" -> {
                    InviteCodeField(
                        value = inviteInput,
                        onChange = { inviteInput = it },
                        label = tr("Código de convite (opcional)"),
                        isError = inviteInvalid,
                        errorText = tr("O código tem 8 letras e números.")
                    )
                    Button(
                        enabled = !inviteInvalid,
                        onClick = { generatedSeed = KeyManager.generateSeedPhrase(); mode = "create" },
                        colors = ButtonDefaults.buttonColors(containerColor = VagalunColors.red),
                        modifier = Modifier.fillMaxWidth().height(52.dp)
                    ) {
                        Text(tr("Criar novo cofre"), color = Color.White, fontWeight = FontWeight.Bold)
                    }
                    OutlinedButton(
                        enabled = !inviteInvalid,
                        onClick = { mode = "restore" },
                        modifier = Modifier.fillMaxWidth().height(52.dp)
                    ) {
                        Text(tr("Já tenho uma seed phrase"), color = VagalunColors.redSoft)
                    }
                }
                "create" -> {
                    Card(
                        colors = CardDefaults.cardColors(containerColor = VagalunColors.bgCard),
                        border = BorderStroke(1.dp, VagalunColors.cardBorder),
                        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
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
                        tr("Anote as 12 palavras em papel. Sem elas você perde acesso pra sempre."),
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
                        Text(tr("Já anotei em local seguro"), color = VagalunColors.textPrimary, fontSize = 12.sp)
                    }
                    Button(
                        enabled = confirmed,
                        onClick = { onSeedReady(generatedSeed, invite) },
                        colors = ButtonDefaults.buttonColors(containerColor = VagalunColors.red),
                        modifier = Modifier.fillMaxWidth().height(52.dp)
                    ) {
                        Text(tr("Continuar"), color = Color.White, fontWeight = FontWeight.Bold)
                    }
                }
                "restore" -> {
                    OutlinedTextField(
                        value = restoreInput,
                        onValueChange = { restoreInput = it },
                        label = { Text(tr("Digite as 12 palavras")) },
                        modifier = Modifier.fillMaxWidth()
                    )
                    Button(
                        onClick = {
                            if (KeyManager.validateSeedPhrase(restoreInput)) onSeedReady(restoreInput, invite)
                        },
                        colors = ButtonDefaults.buttonColors(containerColor = VagalunColors.red),
                        modifier = Modifier.fillMaxWidth().height(52.dp)
                    ) {
                        Text(tr("Restaurar"), color = Color.White, fontWeight = FontWeight.Bold)
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
    anchorClient: AnchorStorageClient?,
    signalingUrl: String,
    scope: CoroutineScope,
    onLog: (String) -> Unit,
    onShowSeed: () -> String,
    onOpenSettings: () -> Unit = {},
    onNavigateSend: () -> Unit
) {
    var showSeed by remember { mutableStateOf(false) }
    var balanceLamports by remember { mutableStateOf<Long?>(null) }
    var claiming by remember { mutableStateOf(false) }
    val context = LocalContext.current

    // Botão de teste: faz manualmente o mesmo que o DailyClaimWorker faz
    // sozinho a cada 24h (época atual + anterior), sem precisar esperar
    // o WorkManager disparar.
    fun claimBaseUrl(): String? {
        if (signalingUrl.isBlank()) return null
        return when {
            signalingUrl.startsWith("wss://") -> "https://" + signalingUrl.removePrefix("wss://").substringBefore("/")
            signalingUrl.startsWith("ws://") -> "http://" + signalingUrl.removePrefix("ws://").substringBefore("/")
            else -> null
        }
    }

    fun claimEpochNow() {
        val client = anchorClient
        val base = claimBaseUrl()
        if (client == null || wallet == null) { onLog(tr("Carteira ainda não carregou")); return }
        if (base == null) { onLog("Sem signalingUrl configurada — conecte a um relay primeiro"); return }

        scope.launch(Dispatchers.IO) {
            claiming = true
            try {
                val payoutClient = EpochPayoutClient(base)
                val pubkey = wallet.publicKey.toBase58()
                val weekSeconds = 7L * 24 * 60 * 60
                val currentEpochId = System.currentTimeMillis() / 1000L / weekSeconds
                var achouAlgo = false

                for (epochId in listOf(currentEpochId, currentEpochId - 1)) {
                    val proof = try {
                        payoutClient.fetchProof(epochId, pubkey)
                    } catch (e: Exception) {
                        onLog("Época $epochId: erro ao buscar proof (${e.message})")
                        null
                    } ?: continue

                    achouAlgo = true
                    val sig = client.claimEpoch(proof.epochId, proof.amountLamports, proof.proof)
                    if (sig.startsWith("ERRO")) {
                        onLog("Época $epochId: claim falhou — $sig")
                    } else {
                        onLog("Época $epochId: claim OK, ${proof.amountLamports} lamports, tx $sig")
                        withContext(Dispatchers.IO) { balanceLamports = wallet.getBalanceLamports() }
                    }
                }
                if (!achouAlgo) onLog("Sem payout pendente nessa época nem na anterior pra essa wallet")
            } catch (e: Exception) {
                onLog("Falha no claim manual: ${e.message}")
            } finally {
                claiming = false
            }
        }
    }

    suspend fun refreshBalance() {
        try {
            balanceLamports = wallet?.getBalanceLamports()
        } catch (e: Exception) {
            onLog(tr("Falha ao consultar saldo: %s", e.message))
        }
    }

    LaunchedEffect(walletAddress) {
        if (wallet != null) withContext(Dispatchers.IO) { refreshBalance() }
    }

    fun copyAddress() {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = android.content.ClipData.newPlainText("wallet_address", walletAddress)
        clipboard.setPrimaryClip(clip)
        onLog(tr("Endereço copiado"))
    }

    val sol = balanceLamports?.let { it / 1_000_000_000.0 }
    ClaroWalletContent(
        balanceText = if (sol == null) AnnotatedString(tr("carregando...")) else solText(sol),
        brlLine = if (sol == null) "" else "≈ " + brlSimple(solToBrl(sol)),
        walletAddress = walletAddress,
        claiming = claiming,
        showSeed = showSeed,
        seed = if (showSeed) onShowSeed() else "",
        onRefresh = { scope.launch(Dispatchers.IO) { refreshBalance() } },
        onSend = onNavigateSend,
        onReceive = { copyAddress() },
        onClaim = { claimEpochNow() },
        onToggleSeed = { showSeed = !showSeed },
        onOpenSettings = onOpenSettings
    )
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
                Icon(Lucide.ArrowLeft, contentDescription = tr("Voltar"), tint = VagalunColors.textPrimary)
            }
            Spacer(Modifier.width(4.dp))
            Text(tr("Enviar SOL"), style = VagalunTypography.titleMedium)
        }

        AnimatedCard {
            Column(Modifier.padding(VagalunSpacing.medium), verticalArrangement = Arrangement.spacedBy(VagalunSpacing.small)) {
                Text(tr("Para quem você quer enviar?"), style = VagalunTypography.bodySecondary)
                OutlinedTextField(
                    value = toAddress,
                    onValueChange = { toAddress = it },
                    placeholder = { Text(tr("Endereço da carteira")) },
                    singleLine = true,
                    trailingIcon = {
                        Icon(Lucide.Copy, contentDescription = null, tint = VagalunColors.textSecondary)
                    },
                    modifier = Modifier.fillMaxWidth()
                )
                Text(tr("Nome salvo (opcional)"), style = VagalunTypography.bodySecondary)
                OutlinedTextField(
                    value = savedName,
                    onValueChange = { savedName = it },
                    placeholder = { Text(tr("Adicionar um apelido")) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
            }
        }

        AnimatedCard {
            Column(Modifier.padding(VagalunSpacing.medium), verticalArrangement = Arrangement.spacedBy(VagalunSpacing.small)) {
                Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                    Text(tr("Quanto você quer enviar?"), style = VagalunTypography.bodySecondary)
                    TextButton(onClick = {
                        scope.launch(Dispatchers.IO) {
                            val lamports = wallet?.getBalanceLamports() ?: return@launch
                            val maxSol = (lamports / 1_000_000_000.0 - NETWORK_FEE_SOL).coerceAtLeast(0.0)
                            withContext(Dispatchers.Main) { amountSol = maxSol }
                        }
                    }) {
                        Text(tr("Máx."), color = VagalunColors.red, fontSize = 12.sp)
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
                Text(tr("Mensagem (opcional)"), style = VagalunTypography.bodySecondary)
                OutlinedTextField(
                    value = message,
                    onValueChange = { message = it },
                    placeholder = { Text(tr("Deixe uma mensagem")) },
                    modifier = Modifier.fillMaxWidth()
                )
            }
        }

        AnimatedCard {
            Column(Modifier.padding(VagalunSpacing.medium)) {
                SummaryRow(tr("Você envia"), "%.4f SOL".format(amountSol))
                SummaryRow(tr("Taxa da rede"), "%.5f SOL".format(NETWORK_FEE_SOL))
                Divider(color = VagalunColors.bgCard2, modifier = Modifier.padding(vertical = 4.dp))
                Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                    Text(tr("Total"), style = VagalunTypography.titleMedium)
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
                        onLog(tr("SOL enviado. Assinatura: %s", sig))
                    } catch (e: Exception) {
                        onLog(tr("Erro ao enviar SOL: %s", e.message))
                    } finally {
                        busy = false
                    }
                }
            },
            colors = ButtonDefaults.buttonColors(containerColor = VagalunColors.red),
            modifier = Modifier.fillMaxWidth().height(52.dp),
            shape = VagalunShapes.button
        ) {
            Icon(Lucide.Send, contentDescription = null, tint = Color.White)
            Spacer(Modifier.width(VagalunSpacing.small))
            Text(if (busy) tr("Enviando...") else tr("Enviar agora"), color = Color.White, fontWeight = FontWeight.Bold)
        }
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(Lucide.Lock, contentDescription = null, tint = VagalunColors.success, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(4.dp))
            Text(tr("Transação segura e criptografada"), style = VagalunTypography.small)
        }
    }
}
