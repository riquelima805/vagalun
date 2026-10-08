package com.decentstorage.app.browser

import android.content.ClipData
import android.content.ClipboardManager
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.View
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.core.content.ContextCompat
import com.decentstorage.app.R
import com.decentstorage.app.StorageClient
import com.decentstorage.app.network.GossipRegistry
import com.decentstorage.app.network.NodeIdentity
import com.decentstorage.app.network.ShardRequestHandler
import com.decentstorage.app.network.webrtc.WebRtcManager
import com.decentstorage.app.network.webrtc.RelayTransport
import com.decentstorage.app.network.webrtc.SignalerList
import com.decentstorage.app.network.webrtc.SignalerStorage
import com.decentstorage.app.network.webrtc.SignalingClient
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * App SEPARADO do node (com.decentstorage.browser, applicationId próprio — ver
 * build.gradle deste módulo). Não hospeda shard de ninguém, não tem wallet/anchor/
 * exoplayer: só entra no mesmo signaling que os nós usam, monta um GossipRegistry de
 * capacidade 0 (nunca aceita `put`, só participa do gossip e baixa via WebRTC) e
 * resolve domínio → manifesto → arquivo inteiramente client-side. Em nenhum momento
 * fala HTTP/DNS normal pra navegar — só WebSocket com o signaling (pra achar peers)
 * e WebRTC direto com eles (pra baixar shards).
 */
class BrowserActivity : ComponentActivity() {

    companion object { private const val TAG = "VagalunBrowser" }

    private lateinit var registry: GossipRegistry
    private lateinit var storageClient: StorageClient
    private lateinit var webView: WebView
    private lateinit var statusText: TextView
    private lateinit var statusDot: View
    private lateinit var statusChip: LinearLayout
    private lateinit var loadingBar: ProgressBar
    private lateinit var debugPanel: LinearLayout
    private lateinit var debugText: TextView
    private var currentDomain: String? = null
    private val prefs by lazy { getSharedPreferences("vagalun_browser", MODE_PRIVATE) }
    private val relayFallbackExecutor = Executors.newSingleThreadScheduledExecutor()
    private val RELAY_FALLBACK_DELAY_SECONDS = 12L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestWindowFeature(android.view.Window.FEATURE_NO_TITLE)
        actionBar?.hide()
        window.statusBarColor = ContextCompat.getColor(this, R.color.vgl_vermelho_escuro)
        startPeer()
        buildUi()
    }

    // Estado visual do chip de status: cor do ponto + fundo do chip. Mantido só na
    // camada de UI — nenhuma lógica de rede depende disso, é puramente cosmético.
    private enum class StatusState { CONECTANDO, CONECTADO, ERRO }

    private fun setStatus(text: String, state: StatusState = StatusState.CONECTANDO) {
        statusText.text = text
        val (dotColor, chipBg) = when (state) {
            StatusState.CONECTADO -> R.color.vgl_vermelho_primario to R.color.vgl_creme
            StatusState.CONECTANDO -> R.color.vgl_vermelho_claro to R.color.vgl_creme_escuro
            StatusState.ERRO -> R.color.vgl_vermelho_escuro to R.color.vgl_vermelho_claríssimo
        }
        (statusDot.background as GradientDrawable).setColor(ContextCompat.getColor(this, dotColor))
        (statusChip.background as GradientDrawable).setColor(ContextCompat.getColor(this, chipBg))
    }

    // Sobe só o suficiente pra ser um peer leve: nodeId estável, GossipRegistry sem
    // capacidade (nunca serve shard), signaling + WebRTC pra descobrir peers reais e
    // baixar deles. Nada de ShardServer TCP — este app nunca escuta conexão de
    // ninguém, só disca pra fora.
    private fun startPeer() {
        val nodeId = prefs.getString("nodeId", null) ?: run {
            val generated = "browser-" + SecureRandom().nextInt(1_000_000)
            prefs.edit().putString("nodeId", generated).apply()
            generated
        }

        val reg = GossipRegistry(nodeId, "127.0.0.1", 0, 0L, dataDir = filesDir)
        registry = reg
        reg.onEvent = { DebugLog.add(it) }
        reg.start()
        storageClient = StorageClient(reg)

        // Handler local: sempre recusa put/get (capacidade 0, dataDir vazio — não
        // hospeda nada), mas responde gossip normalmente, o que é o único op que
        // este app precisa atender quando é ELE quem recebe um pedido de sync.
        val reqHandler = ShardRequestHandler(nodeId, 0L, File(filesDir, "no-shards"), applicationContext) { payload ->
            reg.handleIncomingGossip(payload)
        }

        // Signaling federado: seeds embutidos + lista remota (buscada em segundo plano
        // pelo próprio SignalingClient). Não bloqueia mais esperando uma URL única.
        thread { connectSignaling(nodeId, reg, reqHandler) }
    }

    private fun connectSignaling(nodeId: String, reg: GossipRegistry, reqHandler: ShardRequestHandler) {
        // Desde o patch anti-hijack de nodeId no signaling, TODO register de
        // peer não-infra precisa provar posse via assinatura Ed25519
        // (pubkey+sig) — sem isso o servidor responde 'register_unauthorized'
        // e o app fica pra sempre com 0 peers, sem nenhum aviso. A identidade
        // aqui é local ao app (gerada uma vez, guardada em SharedPreferences),
        // não é a wallet do usuário — só prova "sou sempre o mesmo dono deste
        // nodeId entre sessões", que é tudo que o signaling exige.
        val identity = NodeIdentity.load(applicationContext)
        Log.d(TAG, "conectando ao signaling federado como $nodeId (pubkey=${identity.pubkeyBase58})")

        val signalerList = SignalerList(
            storage = object : SignalerStorage {
                override fun load(): String? = prefs.getString("signalers", null)
                override fun save(json: String) { prefs.edit().putString("signalers", json).apply() }
            }
        )

        val sc = SignalingClient(
            signalerList,
            nodeId,
            onSignal = { _, _ -> },
            onStateChange = { connected ->
                Log.d(TAG, "onStateChange connected=$connected peers=${reg.knownPeers().size}")
                DebugLog.add("SIGNALING onStateChange connected=$connected peers=${reg.knownPeers().size}")
                runOnUiThread {
                    if (connected) setStatus("conectado à rede (${reg.knownPeers().size} peer(s))", StatusState.CONECTADO)
                    else setStatus("desconectado do signaling", StatusState.ERRO)
                }
            },
            walletPubkeyBase58 = identity.pubkeyBase58,
            signNodeId = identity.sign
        )
        sc.onError = { reason, detail ->
            Log.e(TAG, "signaling onError reason=$reason detail=$detail")
            DebugLog.add("SIGNALING onError reason=$reason detail=$detail")
            runOnUiThread {
                setStatus("erro do signaling: $reason" + (detail?.let { " — $it" } ?: ""), StatusState.ERRO)
            }
        }

        val mgr = WebRtcManager(
            context = this,
            signalingClient = sc,
            selfNodeId = nodeId,
            requestHandler = reqHandler,
            onTransportReady = { peerId, transport ->
                Log.d(TAG, "WebRTC pronto com $peerId")
                DebugLog.add("WEBRTC pronto com $peerId")
                reg.attachWanTransport(peerId, transport)
            },
            onTransportClosed = { peerId ->
                Log.d(TAG, "WebRTC fechado com $peerId")
                DebugLog.add("WEBRTC fechado com $peerId")
                reg.detachWanTransport(peerId)
            },
            iceServers = WebRtcManager.defaultIceServers()
        )
        sc.onSignal = { from, payload -> mgr.handleSignal(from, payload) }

        // O navegador NUNCA precisa esperar ser chamado — ele só consome
        // (capacidade 0, nunca serve nada pra ninguém). A checagem "só
        // inicia se meu nodeId < peerId" existe pra evitar dois NÓS REAIS
        // discando um pro outro ao mesmo tempo (glare no WebRTC), mas como
        // nodeId aqui sempre começa com "browser-" (baixo na ordem
        // alfabética), essa checagem podia fazer o navegador nunca discar
        // pro node — e o node, por sua vez, nunca disca pro navegador (só
        // se importa com outros nós reais). Resultado: WebRTC nunca
        // conectava, o navegador nunca recebia gossip nenhum, e por isso
        // nenhum site aparecia nunca, mesmo com o signaling funcionando.
        sc.onPeerList = { peerIds ->
            Log.d(TAG, "onPeerList: $peerIds")
            DebugLog.add("SIGNALING onPeerList: $peerIds")
            peerIds.filter { it != nodeId }.forEach { peerId ->
                mgr.connectToPeer(peerId)
                scheduleRelayFallback(peerId, reg, sc)
            }
        }
        sc.onPeerJoined = { peerId ->
            Log.d(TAG, "onPeerJoined: $peerId")
            DebugLog.add("SIGNALING onPeerJoined: $peerId")
            if (peerId != nodeId) {
                mgr.connectToPeer(peerId)
                scheduleRelayFallback(peerId, reg, sc)
            }
        }
        sc.onPeerLeft = { peerId ->
            Log.d(TAG, "onPeerLeft: $peerId")
            DebugLog.add("SIGNALING onPeerLeft: $peerId")
            mgr.disconnect(peerId)
            reg.detachWanTransport(peerId)
        }

        sc.onRelayRequest = { from, requestId, header, payload ->
            DebugLog.add("RELAY <- pedido de $from: header=$header")
            val (respHeader, respPayload) = try {
                reqHandler.handle(header, payload)
            } catch (e: Exception) {
                JSONObject().put("ok", false).put("error", e.message ?: "erro") to null
            }
            sc.sendRelayResponse(from, requestId, respHeader, respPayload)
        }

        sc.connect()
    }

    // Mesma lógica do app-node: se o WebRTC direto não abrir em N segundos (NAT/
    // firewall difícil), usa o próprio signaling como relay pra shard/gossip. Sem
    // isso, um peer atrás de NAT restritivo nunca troca nada com o browser.
    private fun scheduleRelayFallback(peerId: String, reg: GossipRegistry, sc: SignalingClient) {
        relayFallbackExecutor.schedule({
            val alreadyConnected = reg.knownPeers().find { it.nodeId == peerId }?.webrtcTransport != null
            if (!alreadyConnected) {
                reg.attachWanTransport(peerId, RelayTransport(peerId, sc))
            }
        }, RELAY_FALLBACK_DELAY_SECONDS, TimeUnit.SECONDS)
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun buildUi() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(ContextCompat.getColor(this@BrowserActivity, R.color.vgl_creme))
        }

        // ---------- Toolbar (barra de endereço estilo navegador) ----------
        val toolbar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), dp(14), dp(12), dp(10))
            background = ContextCompat.getDrawable(this@BrowserActivity, R.drawable.bg_toolbar)
            elevation = dp(4).toFloat()
        }

        val refreshButton = ImageButton(this).apply {
            setImageResource(R.drawable.ic_refresh)
            background = ContextCompat.getDrawable(this@BrowserActivity, R.drawable.bg_button_ghost)
            layoutParams = LinearLayout.LayoutParams(dp(38), dp(38)).apply { marginEnd = dp(8) }
            setPadding(dp(9), dp(9), dp(9), dp(9))
            contentDescription = "Recarregar"
        }

        // Campo de endereço "pill": cadeado à esquerda (sinaliza que é P2P, não
        // HTTP/DNS normal), EditText transparente, botão "Ir" circular vermelho.
        val addressField = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = ContextCompat.getDrawable(this@BrowserActivity, R.drawable.bg_address_field)
            layoutParams = LinearLayout.LayoutParams(0, dp(46), 1f).apply { marginEnd = dp(8) }
            setPadding(dp(14), 0, dp(6), 0)
        }
        val lockIcon = android.widget.ImageView(this).apply {
            setImageResource(R.drawable.ic_lock)
            layoutParams = LinearLayout.LayoutParams(dp(16), dp(16))
        }
        val domainField = EditText(this).apply {
            hint = "dominio.vgl"
            setHintTextColor(ContextCompat.getColor(this@BrowserActivity, R.color.vgl_texto_secundario))
            setTextColor(ContextCompat.getColor(this@BrowserActivity, R.color.vgl_texto_principal))
            background = null
            setPadding(dp(10), 0, dp(4), 0)
            textSize = 15f
            imeOptions = android.view.inputmethod.EditorInfo.IME_ACTION_GO
            setSingleLine(true)
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f)
        }
        addressField.addView(lockIcon)
        addressField.addView(domainField)

        val goButton = ImageButton(this).apply {
            setImageResource(R.drawable.ic_go)
            background = ContextCompat.getDrawable(this@BrowserActivity, R.drawable.bg_button_primary)
            layoutParams = LinearLayout.LayoutParams(dp(42), dp(42)).apply { marginEnd = dp(6) }
            setPadding(dp(10), dp(10), dp(10), dp(10))
            contentDescription = "Ir"
        }

        val debugButton = ImageButton(this).apply {
            setImageResource(R.drawable.ic_bug)
            background = ContextCompat.getDrawable(this@BrowserActivity, R.drawable.bg_button_ghost)
            layoutParams = LinearLayout.LayoutParams(dp(38), dp(38))
            setPadding(dp(9), dp(9), dp(9), dp(9))
            contentDescription = "Debug"
        }

        toolbar.addView(refreshButton)
        toolbar.addView(addressField)
        toolbar.addView(goButton)
        toolbar.addView(debugButton)

        // Barra de progresso fininha estilo navegador, some quando não está carregando
        loadingBar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(3))
            isIndeterminate = true
            progressTintList = android.content.res.ColorStateList.valueOf(
                ContextCompat.getColor(this@BrowserActivity, R.color.vgl_vermelho_primario)
            )
            visibility = View.GONE
        }

        // ---------- Chip de status (ponto colorido + texto) ----------
        statusChip = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = ContextCompat.getDrawable(this@BrowserActivity, R.drawable.bg_status_chip)?.mutate()
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { setMargins(dp(14), dp(8), dp(14), dp(8)) }
            setPadding(dp(10), dp(6), dp(12), dp(6))
        }
        statusDot = View(this).apply {
            layoutParams = LinearLayout.LayoutParams(dp(8), dp(8)).apply { marginEnd = dp(8) }
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(ContextCompat.getColor(this@BrowserActivity, R.color.vgl_vermelho_claro))
            }
        }
        statusText = TextView(this).apply {
            text = "conectando..."
            textSize = 12.5f
            setTextColor(ContextCompat.getColor(this@BrowserActivity, R.color.vgl_texto_principal))
        }
        statusChip.addView(statusDot)
        statusChip.addView(statusText)

        // ---------- Painel de debug (log bruto embutido no próprio app) ----------
        // Tudo que o GossipRegistry manda/recebe (gossip cru), eventos de
        // signaling/WebRTC, e cada tentativa de download de shard (peer achado
        // ou não, sucesso/falha). Nada disso passa por logcat: dá pra ver e
        // copiar direto daqui, sem precisar de adb nem esperar timeout de nada.
        debugPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
            background = ContextCompat.getDrawable(this@BrowserActivity, R.drawable.bg_debug_panel)
            setPadding(dp(12), dp(12), dp(12), dp(12))
        }
        val debugTitle = TextView(this).apply {
            text = "Debug — log P2P"
            setTextColor(ContextCompat.getColor(this@BrowserActivity, R.color.vgl_debug_texto))
            textSize = 13f
            typeface = Typeface.DEFAULT_BOLD
            setPadding(dp(4), 0, dp(4), dp(8))
        }
        val debugActions = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, 0, 0, dp(8))
        }
        fun debugActionButton(label: String) = TextView(this).apply {
            text = label
            setTextColor(ContextCompat.getColor(this@BrowserActivity, R.color.vgl_debug_texto))
            textSize = 12f
            background = ContextCompat.getDrawable(this@BrowserActivity, R.drawable.bg_debug_button)
            setPadding(dp(14), dp(8), dp(14), dp(8))
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { marginEnd = dp(8) }
        }
        val copyButton = debugActionButton("Copiar tudo")
        val clearButton = debugActionButton("Limpar")
        val refreshDebugButton = debugActionButton("Atualizar")
        debugActions.addView(copyButton)
        debugActions.addView(clearButton)
        debugActions.addView(refreshDebugButton)

        debugText = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            textSize = 11f
            setTextColor(ContextCompat.getColor(this@BrowserActivity, R.color.vgl_debug_texto))
            setPadding(dp(6), dp(6), dp(6), dp(6))
            setTextIsSelectable(true)
        }
        val debugScroll = ScrollView(this).apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(280))
            addView(debugText)
        }
        debugPanel.addView(debugTitle)
        debugPanel.addView(debugActions)
        debugPanel.addView(debugScroll)

        fun refreshDebugText() {
            val content = DebugLog.getAll()
            debugText.text = if (content.isEmpty()) "(sem eventos registrados ainda)" else content
        }

        debugButton.setOnClickListener {
            val showing = debugPanel.visibility == View.VISIBLE
            debugPanel.visibility = if (showing) View.GONE else View.VISIBLE
            if (!showing) refreshDebugText()
        }
        refreshDebugButton.setOnClickListener { refreshDebugText() }
        clearButton.setOnClickListener { DebugLog.clear(); refreshDebugText() }
        copyButton.setOnClickListener {
            val cm = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("vagalun-debug-log", DebugLog.getAll()))
            Toast.makeText(this, "Log copiado (${DebugLog.getAll().length} chars)", Toast.LENGTH_SHORT).show()
        }

        // ---------- WebView ----------
        webView = WebView(this).apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f)
            setBackgroundColor(ContextCompat.getColor(this@BrowserActivity, R.color.vgl_branco))
            settings.javaScriptEnabled = true
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                    val domain = currentDomain ?: return super.shouldInterceptRequest(view, request)
                    val path = request.url.path?.takeIf { it.isNotEmpty() } ?: "/"
                    return resolveAndFetch(domain, path)?.let { (bytes, contentType) ->
                        WebResourceResponse(contentType, "utf-8", ByteArrayInputStream(bytes))
                    }
                }
            }
        }

        root.addView(toolbar)
        root.addView(loadingBar)
        root.addView(statusChip)
        root.addView(debugPanel)
        root.addView(webView)
        setContentView(root)

        setStatus("conectando...", StatusState.CONECTANDO)

        goButton.setOnClickListener {
            val domain = domainField.text.toString().trim()
            if (domain.isNotEmpty()) navigateTo(domain)
        }
        refreshButton.setOnClickListener {
            currentDomain?.let { navigateTo(it) }
        }
        domainField.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == android.view.inputmethod.EditorInfo.IME_ACTION_GO) {
                val domain = domainField.text.toString().trim()
                if (domain.isNotEmpty()) navigateTo(domain)
                true
            } else false
        }
        domainField.setOnFocusChangeListener { _, hasFocus ->
            addressField.background = ContextCompat.getDrawable(
                this,
                if (hasFocus) R.drawable.bg_address_field_focused else R.drawable.bg_address_field
            )
        }
    }

    private fun navigateTo(domain: String) {
        currentDomain = domain
        loadingBar.visibility = View.VISIBLE
        val (bytes, contentType) = resolveAndFetch(domain, "/") ?: run {
            loadingBar.visibility = View.GONE
            statusChip.visibility = View.VISIBLE
            setStatus(
                "não achei '$domain' no índice ainda (${registry.knownPeers().size} peer(s) conectados — " +
                    "gossip pode levar alguns segundos, ou o site nunca foi anunciado)",
                StatusState.ERRO
            )
            webView.loadData("", "text/plain", "utf-8")
            return
        }
        loadingBar.visibility = View.GONE
        statusChip.visibility = View.GONE
        if (contentType.startsWith("text/html")) {
            webView.loadDataWithBaseURL("https://$domain/", String(bytes, Charsets.UTF_8), contentType, "utf-8", null)
        } else {
            webView.loadData(Base64.getEncoder().encodeToString(bytes), contentType, "base64")
        }
    }

    private fun resolveAndFetch(domain: String, path: String): Pair<ByteArray, String>? {
        val known = registry.listSites()
        Log.d(TAG, "resolveAndFetch domain=$domain path=$path — sites conhecidos agora (${known.size}): $known")
        DebugLog.add("RESOLVE domain=$domain path=$path — sites conhecidos (${known.size}): $known")
        val site = registry.getSite(domain) ?: run {
            Log.d(TAG, "getSite($domain) retornou null — não está no índice local ainda")
            DebugLog.add("RESOLVE getSite($domain) = null — ainda não chegou via gossip")
            return null
        }
        Log.d(TAG, "site encontrado: $domain com ${site.routes.size} rota(s)")
        DebugLog.add("RESOLVE site encontrado: $domain rotas=${site.routes.map { "${it.path}->${it.fileId}" }}")
        val route = site.routes.find { it.path == path } ?: site.routes.find { it.path == "/" } ?: run {
            Log.d(TAG, "nenhuma rota bate com path=$path nem com '/' — rotas: ${site.routes.map { it.path }}")
            DebugLog.add("RESOLVE nenhuma rota bate com path=$path")
            return null
        }
        return try {
            val fileKey = Base64.getDecoder().decode(route.fileKeyB64)
            storageClient.downloadFileWithKey(route.fileId, fileKey) to route.contentType
        } catch (e: Exception) {
            Log.e(TAG, "falha ao baixar fileId=${route.fileId} via P2P", e)
            DebugLog.add("RESOLVE falha ao baixar fileId=${route.fileId}: ${e.message}")
            null
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        if (::registry.isInitialized) registry.stop()
        relayFallbackExecutor.shutdownNow()
    }
}
