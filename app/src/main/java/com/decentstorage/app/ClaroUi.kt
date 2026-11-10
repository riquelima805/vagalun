package com.decentstorage.app

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.animation.core.*
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.draw.*
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.*
import androidx.navigation.NavHostController
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

// ===================== COMPONENTES BASE (layout Claro) =====================

@Composable
fun ClaroCard(
    modifier: Modifier = Modifier,
    padding: Dp = 21.dp,
    content: @Composable ColumnScope.() -> Unit
) {
    Column(
        modifier
            .fillMaxWidth()
            .clip(VagalunShapes.card)
            .background(VagalunColors.bgCard)
            .border(1.dp, VagalunColors.cardBorder, VagalunShapes.card)
            .padding(padding),
        content = content
    )
}

@Composable
fun ClaroHeader(label: String, title: String, onProfile: (() -> Unit)? = null) {
    Row(
        Modifier.fillMaxWidth().padding(bottom = 20.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.Top
    ) {
        Column(Modifier.weight(1f)) {
            Text(label, style = VagalunTypography.bodySecondary)
            Text(title, style = VagalunTypography.titleLarge)
        }
        if (onProfile != null) {
            Box(
                Modifier
                    .size(46.dp)
                    .clip(CircleShape)
                    .background(VagalunColors.bgCard)
                    .border(1.dp, VagalunColors.cardBorder, CircleShape)
                    .clickable { onProfile() },
                contentAlignment = Alignment.Center
            ) {
                Icon(Icons.Filled.Person, contentDescription = "Perfil e ajustes", tint = VagalunColors.textPrimary)
            }
        }
    }
}

@Composable
fun ClaroSwitch(checked: Boolean, onChange: (Boolean) -> Unit) {
    Switch(
        checked = checked,
        onCheckedChange = onChange,
        colors = SwitchDefaults.colors(
            checkedThumbColor = Color.White,
            checkedTrackColor = VagalunColors.success,
            checkedBorderColor = Color.Transparent,
            uncheckedThumbColor = Color.White,
            uncheckedTrackColor = if (VagalunColors.dark) Color(0xFF3A3A38) else Color(0xFFD6D6D4),
            uncheckedBorderColor = Color.Transparent
        )
    )
}

@Composable
fun ClaroChip(text: String) {
    Box(
        Modifier
            .clip(RoundedCornerShape(14.dp))
            .background(VagalunColors.success.copy(alpha = 0.14f))
            .padding(horizontal = 9.dp, vertical = 6.dp)
    ) {
        Text(text, color = VagalunColors.success, fontSize = 12.5.sp, fontWeight = FontWeight.Medium)
    }
}

@Composable
fun ClaroBar(progress: Float, modifier: Modifier = Modifier) {
    Box(
        modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(3.dp)).background(VagalunColors.cardBorder)
    ) {
        Box(
            Modifier.fillMaxWidth(progress.coerceIn(0f, 1f)).fillMaxHeight()
                .clip(RoundedCornerShape(3.dp)).background(VagalunColors.red)
        )
    }
}

@Composable
fun StatTile(label: String, value: String, modifier: Modifier = Modifier) {
    Column(
        modifier
            .clip(RoundedCornerShape(16.dp))
            .background(VagalunColors.bgCard)
            .border(1.dp, VagalunColors.cardBorder, RoundedCornerShape(16.dp))
            .padding(horizontal = 14.dp, vertical = 15.dp)
    ) {
        Text(label, style = VagalunTypography.small)
        Spacer(Modifier.height(4.dp))
        Text(value, style = VagalunTypography.body.copy(fontSize = 17.sp, fontWeight = FontWeight.Medium), maxLines = 1)
    }
}

@Composable
fun ClaroListRow(title: String, subtitle: String? = null, trailing: @Composable (() -> Unit)? = null, onClick: (() -> Unit)? = null, divider: Boolean = true) {
    Column {
        Row(
            Modifier.fillMaxWidth()
                .then(if (onClick != null) Modifier.clickable { onClick() } else Modifier)
                .padding(vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(Modifier.weight(1f)) {
                Text(title, style = VagalunTypography.body.copy(fontSize = 17.sp, fontWeight = FontWeight.Medium))
                if (subtitle != null) Text(subtitle, style = VagalunTypography.bodySecondary)
            }
            if (trailing != null) trailing()
        }
        if (divider) Divider(color = VagalunColors.cardBorder)
    }
}

@Composable
fun Chevron() = Icon(Icons.Filled.ChevronRight, contentDescription = null, tint = VagalunColors.textSecondary)

// ===================== MAPA DE PONTOS DO BRASIL =====================

private val BR_POLY = listOf(
    262f to 238f, 300f to 238f, 310f to 265f, 385f to 255f, 430f to 260f, 440f to 285f, 520f to 290f,
    560f to 320f, 600f to 335f, 640f to 375f, 655f to 405f, 640f to 430f, 610f to 460f, 595f to 490f,
    585f to 520f, 582f to 560f, 565f to 605f, 540f to 640f, 470f to 670f, 455f to 700f, 430f to 730f,
    405f to 750f, 380f to 750f, 350f to 725f, 360f to 700f, 380f to 660f, 365f to 610f, 330f to 585f,
    330f to 540f, 300f to 510f, 235f to 475f, 220f to 445f, 140f to 435f, 125f to 400f, 140f to 375f,
    160f to 340f, 175f to 290f, 240f to 270f
)

// x, y, grande?  (pontos de exemplo, como no layout)
private val BR_MARKS = listOf(
    Triple(298f, 337f, false), Triple(460f, 314f, false), Triple(601f, 345f, false), Triple(652f, 407f, false),
    Triple(601f, 476f, false), Triple(354f, 513f, false), Triple(470f, 516f, false), Triple(449f, 529f, false),
    Triple(526f, 573f, false), Triple(487f, 625f, true), Triple(536f, 615f, true), Triple(449f, 653f, false),
    Triple(422f, 716f, false)
)

private val BR_DOTS: List<Pair<Float, Float>> by lazy {
    fun inside(x: Float, y: Float): Boolean {
        var c = false
        var j = BR_POLY.size - 1
        for (i in BR_POLY.indices) {
            val (a, b) = BR_POLY[i]
            val (d, e) = BR_POLY[j]
            if ((b > y) != (e > y) && x < (d - a) * (y - b) / (e - b) + a) c = !c
            j = i
        }
        return c
    }
    val out = ArrayList<Pair<Float, Float>>()
    var y = 240f
    while (y < 752f) {
        var x = 122f
        while (x < 658f) {
            if (inside(x, y)) out.add(x to y)
            x += 17.5f
        }
        y += 17.5f
    }
    out
}

@Composable
fun BrazilDotMap(modifier: Modifier = Modifier) {
    val dotColor = if (VagalunColors.dark) Color(0xFF3A3A38) else Color(0xFFE4E4E2)
    val red = VagalunColors.red
    Canvas(modifier.aspectRatio(565f / 540f)) {
        val k = size.width / 565f
        fun p(x: Float, y: Float) = Offset((x - 115f) * k, (y - 225f) * k)
        BR_DOTS.forEach { (x, y) -> drawCircle(dotColor, 3.2f * k, p(x, y)) }
        BR_MARKS.forEach { (x, y, big) ->
            drawCircle(red.copy(alpha = 0.16f), (if (big) 20f else 14f) * k, p(x, y))
            drawCircle(red, (if (big) 9f else 5.5f) * k, p(x, y))
        }
    }
}

// ===================== BOAS-VINDAS (3 passos) =====================

@Composable
fun WelcomeScreen(onDone: () -> Unit) {
    var step by remember { mutableStateOf(0) }
    val titles = listOf("Guarde seus arquivos com segurança", "Ceda espaço e ganhe", "Cresça junto com o Brasil")
    val texts = listOf(
        "Seus arquivos ficam divididos e protegidos pela rede, sem depender de uma única empresa.",
        "Deixe o app ligado e seu celular ajuda a rede. Você recebe recompensas pelo tempo contribuído.",
        "Acompanhe a rede crescendo pelos estados e convide amigos para ganhar mais."
    )
    Column(
        Modifier.fillMaxSize().background(VagalunColors.bg).padding(horizontal = 24.dp, vertical = 20.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            TextButton(onClick = onDone) { Text("Pular", color = VagalunColors.textSecondary, fontSize = 16.sp) }
        }
        Column(
            Modifier.weight(1f).fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center
        ) {
            when (step) {
                0 -> Image(painterResource(R.drawable.mascot_wave), "Vagalumin", Modifier.size(200.dp), contentScale = ContentScale.Fit)
                1 -> Image(painterResource(R.drawable.node_ativo), "Nó ativo", Modifier.size(180.dp), contentScale = ContentScale.Fit)
                else -> BrazilDotMap(Modifier.width(190.dp))
            }
            Spacer(Modifier.height(34.dp))
            Text(titles[step], style = VagalunTypography.titleLarge, textAlign = TextAlign.Center)
            Spacer(Modifier.height(16.dp))
            Text(texts[step], style = VagalunTypography.bodySecondary.copy(fontSize = 16.sp), textAlign = TextAlign.Center)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(bottom = 28.dp)) {
            repeat(3) { i ->
                Box(
                    Modifier.height(8.dp).width(if (i == step) 22.dp else 8.dp)
                        .clip(RoundedCornerShape(4.dp))
                        .background(if (i == step) VagalunColors.red else VagalunColors.cardBorder)
                )
            }
        }
        Button(
            onClick = { if (step < 2) step++ else onDone() },
            modifier = Modifier.fillMaxWidth().height(52.dp),
            shape = RoundedCornerShape(20.dp),
            colors = ButtonDefaults.buttonColors(containerColor = VagalunColors.red)
        ) {
            Text(if (step < 2) "Continuar" else "Começar", color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
        }
    }
}

// ===================== INÍCIO =====================

@Composable
fun EarningsCard(nodeActive: Boolean) {
    val earnedTodaySol = if (nodeActive) 0.00245 else 0.0
    ClaroCard {
        Text("Ganhos de hoje", style = VagalunTypography.bodySecondary)
        Spacer(Modifier.height(6.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(brlText(solToBrl(earnedTodaySol)), style = VagalunTypography.titleLarge.copy(fontSize = 40.sp))
            if (nodeActive) {
                Spacer(Modifier.width(10.dp))
                ClaroChip("+12% vs. ontem")
            }
        }
        Text("%.5f SOL".format(earnedTodaySol), style = VagalunTypography.bodySecondary)
        Spacer(Modifier.height(12.dp))
        Sparkline(active = nodeActive)
        Text("Últimos 7 dias", style = VagalunTypography.small)
    }
}

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
    activeSinceMillis: Long = 0L,
    signalingUrl: String = "",
    onOpenSettings: () -> Unit = {},
    onOpenMap: () -> Unit = {}
) {
    var sliderValue by remember(capacityGb) { mutableStateOf(capacityGb.toFloat()) }
    var points by remember { mutableStateOf<Long?>(null) }
    LaunchedEffect(walletAddress, signalingUrl) {
        if (walletAddress.isNotEmpty() && signalingUrl.isNotBlank()) {
            points = withContext(Dispatchers.IO) { PointsClient.fetchPoints(signalingUrl, walletAddress)?.points }
        }
    }
    // Animação do mascote: pulsa enquanto o nó está ativo.
    val infinite = rememberInfiniteTransition(label = "mascote")
    val pulse by infinite.animateFloat(
        initialValue = 1f, targetValue = 1.12f,
        animationSpec = infiniteRepeatable(tween(1100, easing = FastOutSlowInEasing), RepeatMode.Reverse),
        label = "pulso"
    )
    val usedGb = usedFreeBytes / (1024f * 1024 * 1024)

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 16.dp)
    ) {
        VagalunHeader()
        Spacer(Modifier.height(14.dp))
        ClaroHeader("Bom dia", "Sua rede hoje", onOpenSettings)

        EarningsCard(nodeActive)
        Spacer(Modifier.height(15.dp))

        ClaroCard(padding = 18.dp) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(60.dp).scale(if (nodeActive) pulse else 1f), contentAlignment = Alignment.Center) {
                    Image(
                        painter = painterResource(if (nodeActive) R.drawable.node_ativo else R.drawable.node_desativo),
                        contentDescription = if (nodeActive) "Nó ativo" else "Nó desativado",
                        contentScale = ContentScale.Fit,
                        modifier = Modifier.size(60.dp)
                    )
                }
                Spacer(Modifier.width(14.dp))
                Column(Modifier.weight(1f)) {
                    Text("Contribuindo com a rede", style = VagalunTypography.titleMedium.copy(fontSize = 17.sp))
                    Text(
                        if (nodeActive) "Ativo agora" else "Pausado",
                        color = if (nodeActive) VagalunColors.success else VagalunColors.textSecondary,
                        fontSize = 15.sp
                    )
                }
                ClaroSwitch(nodeActive) { onToggleNode(it) }
            }
        }
        Spacer(Modifier.height(15.dp))

        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            StatTile("Espaço", "${"%.1f".format(usedGb)} de 2 GB", Modifier.weight(1f))
            StatTile("Online", formatUptime(nodeActive, activeSinceMillis), Modifier.weight(1f))
            StatTile("Pontos", points?.toString() ?: "—", Modifier.weight(1f))
        }
        Spacer(Modifier.height(15.dp))

        ClaroCard(Modifier.clickable { onOpenMap() }, padding = 20.dp) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Sua rede no Brasil", style = VagalunTypography.titleMedium.copy(fontSize = 17.sp))
                    Spacer(Modifier.height(6.dp))
                    Text("14 de 27 estados ativos", style = VagalunTypography.bodySecondary.copy(fontSize = 15.sp))
                    Spacer(Modifier.height(18.dp))
                    Text("Ver mapa →", color = VagalunColors.red, fontSize = 16.sp, fontWeight = FontWeight.Medium)
                }
                BrazilDotMap(Modifier.width(118.dp))
            }
        }
        Spacer(Modifier.height(15.dp))

        ClaroCard {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
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
                    inactiveTrackColor = VagalunColors.cardBorder
                )
            )
            Text("Máximo disponível: $maxOfferableGb GB", style = VagalunTypography.small)
            Spacer(Modifier.height(10.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("Arquivos na rede", style = VagalunTypography.bodySecondary)
                Text(filesCount.toString(), style = VagalunTypography.body)
            }
            Spacer(Modifier.height(6.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("Nós conectados", style = VagalunTypography.bodySecondary)
                Text(peersConnected.toString(), style = VagalunTypography.body)
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

// ===================== REDE NO BRASIL =====================

@Composable
fun BrasilNetworkScreen(onOpenSettings: () -> Unit = {}) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 16.dp)) {
        ClaroHeader("Ao vivo · dados de exemplo", "Rede no Brasil", onOpenSettings)
        ClaroCard(padding = 28.dp) {
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                BrazilDotMap(Modifier.width(262.dp))
            }
        }
        Spacer(Modifier.height(15.dp))
        ClaroCard(padding = 20.dp) {
            Text("Estados com mais nós", style = VagalunTypography.titleMedium)
            Spacer(Modifier.height(8.dp))
            listOf(Triple("São Paulo", 240, 0.75f), Triple("Rio de Janeiro", 150, 0.47f), Triple("Minas Gerais", 110, 0.34f))
                .forEach { (nome, nos, p) ->
                    Spacer(Modifier.height(8.dp))
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(nome, style = VagalunTypography.body.copy(fontSize = 16.sp))
                        Text("$nos nós", style = VagalunTypography.bodySecondary.copy(fontSize = 16.sp))
                    }
                    Spacer(Modifier.height(6.dp))
                    ClaroBar(p)
                }
        }
        Spacer(Modifier.height(24.dp))
    }
}

// ===================== ARQUIVOS =====================

@Composable
fun FilesScreen(
    files: List<UiFileEntry>,
    onUploadTap: () -> Unit,
    onDelete: (UiFileEntry) -> Unit,
    onOpen: (UiFileEntry, (ByteArray) -> Unit) -> Unit,
    navController: NavHostController,
    onOpenSettings: () -> Unit = {}
) {
    var query by remember { mutableStateOf("") }
    var activeTab by remember { mutableStateOf(FileFilterTab.TODOS) }
    val filtered = files.filter {
        (query.isBlank() || it.fileName.contains(query, ignoreCase = true)) && fileCategoryMatches(it, activeTab)
    }
    val usedBytes = files.sumOf { it.sizeBytes }

    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().padding(horizontal = 20.dp, vertical = 16.dp)) {
            ClaroHeader("Na rede", "Arquivos", onOpenSettings)

            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                placeholder = { Text("Buscar arquivos", style = VagalunTypography.bodySecondary.copy(fontSize = 16.sp)) },
                leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null, tint = VagalunColors.textSecondary) },
                singleLine = true,
                shape = RoundedCornerShape(18.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedContainerColor = VagalunColors.bgCard,
                    unfocusedContainerColor = VagalunColors.bgCard,
                    focusedBorderColor = VagalunColors.red,
                    unfocusedBorderColor = VagalunColors.cardBorder,
                    focusedTextColor = VagalunColors.textPrimary,
                    unfocusedTextColor = VagalunColors.textPrimary,
                    cursorColor = VagalunColors.red
                ),
                modifier = Modifier.fillMaxWidth()
            )
            Spacer(Modifier.height(14.dp))

            LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                items(FileFilterTab.values().toList()) { tab ->
                    val selected = tab == activeTab
                    Box(
                        Modifier
                            .clip(RoundedCornerShape(22.dp))
                            .background(if (selected) VagalunColors.red else VagalunColors.bgCard)
                            .border(1.dp, if (selected) VagalunColors.red else VagalunColors.cardBorder, RoundedCornerShape(22.dp))
                            .clickable { activeTab = tab }
                            .padding(horizontal = 18.dp, vertical = 11.dp)
                    ) {
                        Text(
                            tab.label,
                            color = if (selected) Color.White else VagalunColors.textSecondary,
                            fontSize = 15.sp, fontWeight = FontWeight.Medium
                        )
                    }
                }
            }
            Spacer(Modifier.height(14.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("Espaço usado", style = VagalunTypography.bodySecondary)
                Text("${formatSize(usedBytes)} de 2 GB", style = VagalunTypography.bodySecondary)
            }
            Spacer(Modifier.height(8.dp))
            ClaroBar(usedBytes.toFloat() / FREE_STORAGE_BYTES.toFloat())
            Spacer(Modifier.height(10.dp))

            if (filtered.isEmpty()) {
                Column(
                    Modifier.fillMaxSize(),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Icon(Icons.Filled.Folder, contentDescription = null, tint = VagalunColors.textSecondary, modifier = Modifier.size(56.dp))
                    Spacer(Modifier.height(8.dp))
                    Text(if (files.isEmpty()) "Nenhum arquivo ainda" else "Nada encontrado", style = VagalunTypography.titleMedium)
                }
            } else {
                androidx.compose.foundation.lazy.LazyColumn(Modifier.fillMaxSize()) {
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
        Box(
            Modifier.align(Alignment.BottomEnd).padding(20.dp).size(56.dp)
                .clip(RoundedCornerShape(18.dp)).background(VagalunColors.red).clickable { onUploadTap() },
            contentAlignment = Alignment.Center
        ) {
            Icon(Icons.Filled.Add, contentDescription = "Enviar arquivo", tint = Color.White, modifier = Modifier.size(28.dp))
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
    ClaroListRow(
        title = entry.fileName,
        subtitle = "${formatSize(entry.sizeBytes)} · ${formatDate(entry.uploadedAt)}",
        onClick = onClick,
        trailing = {
            Box(Modifier.size(10.dp).clip(CircleShape).background(healthColor))
            IconButton(onClick = { showConfirm = true }) {
                Icon(Icons.Filled.Delete, contentDescription = "Excluir", tint = VagalunColors.textSecondary)
            }
            Chevron()
        }
    )
    if (showConfirm) {
        AlertDialog(
            onDismissRequest = { showConfirm = false },
            title = { Text("Excluir arquivo?") },
            text = { Text("Isso encerra o pagamento do contrato e avisa a rede para liberar o espaço.") },
            confirmButton = {
                TextButton(onClick = { showConfirm = false; onDelete() }) { Text("Excluir", color = VagalunColors.danger) }
            },
            dismissButton = { TextButton(onClick = { showConfirm = false }) { Text("Cancelar") } }
        )
    }
}

// ===================== CARTEIRA (visual; a lógica fica na WalletScreen) =====================

@Composable
fun ClaroWalletContent(
    balanceText: AnnotatedString,
    solLine: String,
    walletAddress: String,
    claiming: Boolean,
    showSeed: Boolean,
    seed: String,
    onRefresh: () -> Unit,
    onSend: () -> Unit,
    onReceive: () -> Unit,
    onClaim: () -> Unit,
    onToggleSeed: () -> Unit,
    onOpenSettings: () -> Unit
) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 16.dp)) {
        ClaroHeader("Seu dinheiro", "Carteira", onOpenSettings)

        ClaroCard(padding = 21.dp) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.Top) {
                Text("Saldo total", style = VagalunTypography.bodySecondary)
                IconButton(onClick = onRefresh, modifier = Modifier.size(24.dp)) {
                    Icon(Icons.Filled.Refresh, contentDescription = "Atualizar", tint = VagalunColors.textSecondary)
                }
            }
            Spacer(Modifier.height(6.dp))
            Text(balanceText, style = VagalunTypography.titleLarge.copy(fontSize = 40.sp))
            Text(solLine, style = VagalunTypography.bodySecondary)
        }
        Spacer(Modifier.height(15.dp))

        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            ActionTile("Enviar", Icons.Filled.Send, Modifier.weight(1f), primary = true, onClick = onSend)
            ActionTile("Receber", Icons.Filled.Download, Modifier.weight(1f), onClick = onReceive)
            ActionTile("Sacar Pix", Icons.Filled.Diamond, Modifier.weight(1f), note = "em breve", enabled = false, onClick = {})
        }
        Spacer(Modifier.height(15.dp))

        OutlinedButton(
            onClick = onClaim,
            enabled = !claiming,
            modifier = Modifier.fillMaxWidth().height(48.dp),
            shape = RoundedCornerShape(16.dp)
        ) {
            if (claiming) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = VagalunColors.red)
            else Text("Reivindicar época agora (teste)", color = VagalunColors.red, fontWeight = FontWeight.SemiBold)
        }

        Spacer(Modifier.height(22.dp))
        Text("Movimentações", style = VagalunTypography.titleMedium)
        Spacer(Modifier.height(8.dp))
        Text("As recompensas da rede vão aparecer aqui em breve.", style = VagalunTypography.bodySecondary)

        Spacer(Modifier.height(24.dp))
        ClaroCard(padding = 8.dp) {
            if (walletAddress.isNotEmpty()) {
                Column(Modifier.padding(horizontal = 13.dp)) {
                    ClaroListRow(
                        "Endereço", "${walletAddress.take(6)}...${walletAddress.takeLast(4)}",
                        trailing = { Icon(Icons.Filled.ContentCopy, contentDescription = "Copiar", tint = VagalunColors.textSecondary) },
                        onClick = onReceive
                    )
                }
            }
            Column(Modifier.padding(horizontal = 13.dp)) {
                ClaroListRow(
                    "Chave secreta", if (showSeed) "Toque para ocultar" else "Toque para revelar",
                    trailing = { Chevron() }, onClick = onToggleSeed, divider = false
                )
                if (showSeed) {
                    Text(seed, style = VagalunTypography.body, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
                    Text(
                        "Nunca compartilhe isso com ninguém.",
                        color = VagalunColors.danger, fontSize = 12.sp,
                        modifier = Modifier.padding(vertical = 10.dp)
                    )
                }
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun ActionTile(
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    modifier: Modifier,
    primary: Boolean = false,
    note: String? = null,
    enabled: Boolean = true,
    onClick: () -> Unit
) {
    val shape = RoundedCornerShape(20.dp)
    Column(
        modifier.height(64.dp).clip(shape)
            .background(if (primary) VagalunColors.red else VagalunColors.bgCard)
            .border(1.dp, if (primary) VagalunColors.red else VagalunColors.cardBorder, shape)
            .then(if (enabled) Modifier.clickable { onClick() } else Modifier),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Icon(icon, contentDescription = null, tint = if (primary) Color.White else VagalunColors.textPrimary, modifier = Modifier.size(22.dp))
        Text(label, color = if (primary) Color.White else VagalunColors.textPrimary, fontSize = 15.sp, fontWeight = FontWeight.Medium)
        if (note != null) Text(note, style = VagalunTypography.small.copy(fontSize = 11.sp))
    }
}

// ===================== MISSÕES =====================

@Composable
fun MissionsScreen(
    signalingUrl: String,
    walletAddress: String,
    nodeActive: Boolean,
    filesCount: Int = 0,
    onOpenSettings: () -> Unit = {}
) {
    var info by remember { mutableStateOf<PointsInfo?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf(false) }
    var leaderboard by remember { mutableStateOf<List<LeaderboardEntry>?>(null) }
    val context = LocalContext.current

    LaunchedEffect(walletAddress, signalingUrl) {
        loading = true
        val r = withContext(Dispatchers.IO) { PointsClient.fetchPoints(signalingUrl, walletAddress) }
        info = r
        error = r == null
        loading = false
        leaderboard = withContext(Dispatchers.IO) { PointsClient.fetchLeaderboard(signalingUrl) }
    }

    val code = walletAddress.take(8).uppercase()
    fun copyCode() {
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
        cm.setPrimaryClip(android.content.ClipData.newPlainText("codigo", code))
    }
    fun share() {
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, "Entre na Vagalun e ganhe com o espaço do seu celular. Meu código: $code")
        }
        try { context.startActivity(Intent(send).setPackage("com.whatsapp")) }
        catch (e: Exception) { context.startActivity(Intent.createChooser(send, "Compartilhar")) }
    }

    val points = info?.points ?: 0L
    val step = 150L
    val level = (points / step).toInt() + 1
    val intoLevel = (points - (level - 1) * step).toFloat() / step
    val toNext = level * step - points
    val uptimeS = info?.uptimeSeconds ?: 0L
    val goalS = 10L * 3600

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 16.dp)) {
        ClaroHeader("Seu progresso", "Missões", onOpenSettings)

        if (walletAddress.isEmpty()) {
            ClaroCard { Text("Crie ou restaure sua carteira para acompanhar pontos e missões.", style = VagalunTypography.bodySecondary) }
        } else {
            ClaroCard {
                Text("Seus pontos", style = VagalunTypography.bodySecondary)
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.Bottom) {
                    Text(if (loading) "…" else points.toString(), style = VagalunTypography.titleLarge.copy(fontSize = 40.sp))
                    Text("Nível $level", color = VagalunColors.red, fontSize = 16.sp, fontWeight = FontWeight.Medium, modifier = Modifier.padding(bottom = 6.dp))
                }
                Text(
                    buildAnnotatedString { append("≈ "); append(brlText(pointsToBrl(points))) },
                    style = VagalunTypography.bodySecondary
                )
                Spacer(Modifier.height(12.dp))
                ClaroBar(intoLevel)
                Spacer(Modifier.height(10.dp))
                Text(
                    if (error) "Não consegui carregar seus pontos agora." else "$toNext pts para o nível ${level + 1}",
                    style = VagalunTypography.bodySecondary
                )
            }
            Spacer(Modifier.height(15.dp))

            ClaroCard(padding = 18.dp) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Convide amigos", style = VagalunTypography.titleMedium)
                        Spacer(Modifier.height(6.dp))
                        Text("Você ganha pontos quando um amigo fica ativo na rede.", style = VagalunTypography.bodySecondary.copy(fontSize = 15.sp))
                    }
                    Image(painterResource(R.drawable.mascot_gift_a), "Vagalumin", Modifier.size(72.dp), contentScale = ContentScale.Fit)
                }
                Spacer(Modifier.height(14.dp))
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(VagalunColors.bg)
                        .border(1.dp, VagalunColors.cardBorder, RoundedCornerShape(16.dp))
                        .clickable { copyCode() }.padding(horizontal = 14.dp, vertical = 12.dp),
                    horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically
                ) {
                    Text("Seu código: $code", style = VagalunTypography.body.copy(fontSize = 16.sp))
                    Icon(Icons.Filled.ContentCopy, contentDescription = "Copiar código", tint = VagalunColors.textSecondary, modifier = Modifier.size(20.dp))
                }
                Spacer(Modifier.height(12.dp))
                Button(
                    onClick = { share() },
                    modifier = Modifier.fillMaxWidth().height(52.dp),
                    shape = RoundedCornerShape(18.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = VagalunColors.red)
                ) { Text("Compartilhar no WhatsApp", color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 16.sp) }
            }

            Spacer(Modifier.height(22.dp))
            Text("Missões", style = VagalunTypography.titleMedium)
            MissionRow("Enviar o primeiro arquivo", if (filesCount > 0) "concluída" else "envie um arquivo para a rede", filesCount > 0)
            MissionRow(
                "Ficar 10 h online",
                if (uptimeS >= goalS) "concluída" else "${formatUptimeSeconds(uptimeS)} de 10h",
                uptimeS >= goalS
            )
            MissionRow("Convidar 3 amigos", "0 de 3", false)
            Spacer(Modifier.height(10.dp))
            Text("Pontos não são dinheiro. A conversão será anunciada à parte.", style = VagalunTypography.bodySecondary)

            leaderboard?.takeIf { it.isNotEmpty() }?.let { board ->
                Spacer(Modifier.height(22.dp))
                Text("Ranking", style = VagalunTypography.titleMedium)
                board.take(10).forEachIndexed { idx, e ->
                    val me = e.pubkey == walletAddress
                    ClaroListRow(
                        "#${idx + 1}  ${shortenPubkey(e.pubkey)}${if (me) " (você)" else ""}",
                        trailing = { Text("${e.points} pts · ${brlPlain(pointsToBrl(e.points))}", style = VagalunTypography.bodySecondary) }
                    )
                }
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun MissionRow(title: String, sub: String, done: Boolean) {
    ClaroListRow(
        title, sub,
        trailing = {
            Box(
                Modifier.size(38.dp).clip(CircleShape)
                    .background(if (done) VagalunColors.success else VagalunColors.bgCard)
                    .border(1.dp, if (done) VagalunColors.success else VagalunColors.cardBorder, CircleShape),
                contentAlignment = Alignment.Center
            ) { if (done) Icon(Icons.Filled.Check, contentDescription = "Concluída", tint = Color.White, modifier = Modifier.size(20.dp)) }
        }
    )
}

// ===================== CONFIGURAÇÕES =====================

@Composable
private fun SettingsSection(label: String) {
    Text(label.uppercase(), style = VagalunTypography.small.copy(fontSize = 13.sp, letterSpacing = 1.sp), modifier = Modifier.padding(start = 6.dp, top = 18.dp, bottom = 6.dp))
}

@Composable
fun SettingsScreen(
    wifiOnly: Boolean,
    onWifiOnlyChange: (Boolean) -> Unit,
    backgroundSync: Boolean,
    onBackgroundSyncChange: (Boolean) -> Unit,
    themeMode: Int = 0,
    onThemeChange: (Int) -> Unit = {},
    walletAddress: String = "",
    onOpenWallet: () -> Unit = {},
    onClearDeadShards: () -> Unit
) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 20.dp)) {
        Text("Configurações", style = VagalunTypography.titleLarge)

        SettingsSection("Conta")
        ClaroCard(padding = 20.dp) {
            ClaroListRow(
                "Carteira",
                if (walletAddress.isNotEmpty()) "${walletAddress.take(6)}...${walletAddress.takeLast(4)}" else null,
                trailing = { Chevron() }, onClick = onOpenWallet
            )
            ClaroListRow("Idioma", "Português (Brasil)", divider = false)
        }

        SettingsSection("Rede")
        ClaroCard(padding = 20.dp) {
            ClaroListRow("Sincronizar só no Wi-Fi", trailing = { ClaroSwitch(wifiOnly, onWifiOnlyChange) })
            ClaroListRow("Manter ativo em segundo plano", trailing = { ClaroSwitch(backgroundSync, onBackgroundSyncChange) }, divider = false)
        }

        SettingsSection("Aparência")
        ClaroCard(padding = 20.dp) {
            ClaroListRow(
                "Tema",
                trailing = { Text(listOf("Automático", "Claro", "Escuro")[themeMode.coerceIn(0, 2)], style = VagalunTypography.bodySecondary) },
                onClick = { onThemeChange((themeMode + 1) % 3) },
                divider = false
            )
        }

        SettingsSection("Segurança")
        ClaroCard(padding = 20.dp) {
            ClaroListRow("Backup da carteira", trailing = { Chevron() }, onClick = onOpenWallet, divider = false)
        }

        SettingsSection("Ajuda")
        ClaroCard(padding = 20.dp) {
            ClaroListRow("Limpar cache", "Remove só temporários; seus arquivos não são apagados", trailing = { Chevron() }, onClick = onClearDeadShards, divider = false)
        }
        Spacer(Modifier.height(14.dp))
        Text("Versão 0.1", style = VagalunTypography.bodySecondary, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(24.dp))
    }
}
