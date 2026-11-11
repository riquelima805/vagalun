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
import androidx.compose.foundation.text.KeyboardOptions
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
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.*
import androidx.navigation.NavHostController
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
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
                Icon(Lucide.User, contentDescription = tr("Perfil e ajustes"), tint = VagalunColors.textPrimary)
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
fun Chevron() = Icon(Lucide.ChevronRight, contentDescription = null, tint = VagalunColors.textSecondary)

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
    val titles = listOf(tr("Guarde seus arquivos com segurança"), tr("Ceda espaço e ganhe"), tr("Cresça junto com o Brasil"))
    val texts = listOf(
        tr("Seus arquivos ficam divididos e protegidos pela rede, sem depender de uma única empresa."),
        tr("Deixe o app ligado e seu celular ajuda a rede. Você recebe recompensas pelo tempo contribuído."),
        tr("Convide amigos e ganhe mais conforme a rede cresce.")
    )
    Column(
        Modifier.fillMaxSize().background(VagalunColors.bg).padding(horizontal = 24.dp, vertical = 20.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            TextButton(onClick = onDone) { Text(tr("Pular"), color = VagalunColors.textSecondary, fontSize = 16.sp) }
        }
        Column(
            Modifier.weight(1f).fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center
        ) {
            when (step) {
                0 -> Image(painterResource(R.drawable.mascot_wave), "Vagalumin", Modifier.size(200.dp), contentScale = ContentScale.Fit)
                1 -> Image(painterResource(R.drawable.node_ativo), tr("Nó ativo"), Modifier.size(180.dp), contentScale = ContentScale.Fit)
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
            Text(if (step < 2) tr("Continuar") else tr("Começar"), color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
        }
    }
}

// ===================== INÍCIO =====================

private fun saudacao(): String {
    val h = java.util.Calendar.getInstance().get(java.util.Calendar.HOUR_OF_DAY)
    return when { h < 12 -> tr("Bom dia"); h < 18 -> tr("Boa tarde"); else -> tr("Boa noite") }
}

private const val POINTS_PER_LEVEL = 150L

/** Pontos do servidor + estatísticas de indicação (que somam o bônus por amigo ativo). */
data class PointsSnapshot(val info: PointsInfo?, val referral: ReferralStats?) {
    val bonus: Long get() = referral?.bonusPoints ?: 0L
    val totalPoints: Long? get() = info?.let { it.points + bonus }
}

suspend fun loadPointsSnapshot(signalingUrl: String, referralBaseUrl: String, pubkey: String): PointsSnapshot = coroutineScope {
    val points = async(Dispatchers.IO) { PointsClient.fetchPoints(signalingUrl, pubkey) }
    val referral = async(Dispatchers.IO) { ReferralClient.fetchStats(referralBaseUrl, pubkey) }
    PointsSnapshot(points.await(), referral.await())
}

private val InviteKeyboard = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, imeAction = ImeAction.Done)

/** Campo do código de convite: sempre maiúsculo, só letras/números, máximo 8. */
@Composable
fun InviteCodeField(
    value: String,
    onChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    isError: Boolean = false,
    errorText: String? = null
) {
    OutlinedTextField(
        value = value,
        onValueChange = { onChange(it.uppercase().filter { ch -> ch.isLetterOrDigit() }.take(8)) },
        label = { Text(label) },
        singleLine = true,
        isError = isError,
        supportingText = if (isError && errorText != null) { { Text(errorText) } } else null,
        keyboardOptions = InviteKeyboard,
        shape = RoundedCornerShape(18.dp),
        colors = OutlinedTextFieldDefaults.colors(
            focusedContainerColor = VagalunColors.bgCard,
            unfocusedContainerColor = VagalunColors.bgCard,
            focusedBorderColor = VagalunColors.red,
            unfocusedBorderColor = VagalunColors.cardBorder,
            errorBorderColor = VagalunColors.danger,
            focusedTextColor = VagalunColors.textPrimary,
            unfocusedTextColor = VagalunColors.textPrimary,
            focusedLabelColor = VagalunColors.red,
            unfocusedLabelColor = VagalunColors.textSecondary,
            cursorColor = VagalunColors.red
        ),
        modifier = modifier.fillMaxWidth()
    )
}

fun pointsFormatted(p: Long): String = java.text.NumberFormat.getIntegerInstance(Lang.locale).format(p)

@Composable
fun PointsHeroCard(points: Long?) {
    val p = points ?: 0L
    val level = (p / POINTS_PER_LEVEL).toInt() + 1
    val into = (p - (level - 1) * POINTS_PER_LEVEL).toFloat() / POINTS_PER_LEVEL
    val toNext = level * POINTS_PER_LEVEL - p
    ClaroCard(padding = 22.dp) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text(tr("Seus pontos"), style = VagalunTypography.bodySecondary)
            ClaroChip(tr("Nível %d", level))
        }
        Spacer(Modifier.height(6.dp))
        Text(
            if (points == null) "—" else pointsFormatted(p),
            style = VagalunTypography.titleLarge.copy(fontSize = 44.sp)
        )
        if (points != null) {
            Spacer(Modifier.height(16.dp))
            ClaroBar(into)
            Spacer(Modifier.height(8.dp))
            Text(tr("Faltam %d pontos para o nível %d", toNext, level + 1), style = VagalunTypography.small)
        }
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
    referralBaseUrl: String = "",
    onOpenSettings: () -> Unit = {},
    onOpenMap: () -> Unit = {}
) {
    var sliderValue by remember(capacityGb) { mutableStateOf(capacityGb.toFloat()) }
    var points by remember { mutableStateOf<Long?>(null) }
    LaunchedEffect(walletAddress, signalingUrl, referralBaseUrl) {
        if (walletAddress.isNotEmpty() && (signalingUrl.isNotBlank() || referralBaseUrl.isNotBlank())) {
            // Também avisa o servidor de convites que esta carteira existe (é isso que torna o código dela válido).
            points = loadPointsSnapshot(signalingUrl, referralBaseUrl, walletAddress).totalPoints
        }
    }
    // Animação do mascote: pulsa enquanto o nó está ativo.
    val infinite = rememberInfiniteTransition(label = "mascote")
    val pulse by infinite.animateFloat(
        initialValue = 1f, targetValue = 1.12f,
        animationSpec = infiniteRepeatable(tween(1100, easing = FastOutSlowInEasing), RepeatMode.Reverse),
        label = "pulso"
    )

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 16.dp)
    ) {
        ClaroHeader(saudacao(), tr("Sua rede hoje"), onOpenSettings)

        // Pontos reais (vêm do servidor), já convertidos em reais.
        PointsHeroCard(points)
        Spacer(Modifier.height(14.dp))

        ClaroCard(padding = 20.dp) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(64.dp).scale(if (nodeActive) pulse else 1f), contentAlignment = Alignment.Center) {
                    Image(
                        painter = painterResource(if (nodeActive) R.drawable.node_ativo else R.drawable.node_desativo),
                        contentDescription = if (nodeActive) tr("Nó ativo") else tr("Nó desativado"),
                        contentScale = ContentScale.Fit,
                        modifier = Modifier.size(64.dp)
                    )
                }
                Spacer(Modifier.width(16.dp))
                Column(Modifier.weight(1f)) {
                    Text(tr("Contribuindo com a rede"), style = VagalunTypography.titleMedium.copy(fontSize = 17.sp))
                    Spacer(Modifier.height(2.dp))
                    Text(
                        if (nodeActive) tr("Ativo agora") else tr("Pausado"),
                        color = if (nodeActive) VagalunColors.success else VagalunColors.textSecondary,
                        fontSize = 15.sp
                    )
                }
                ClaroSwitch(nodeActive) { onToggleNode(it) }
            }
        }
        Spacer(Modifier.height(14.dp))

        // Só dois números, ambos reais.
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            StatTile(tr("Tempo online"), formatUptime(nodeActive, activeSinceMillis), Modifier.weight(1f))
            StatTile(tr("Nós conectados"), peersConnected.toString(), Modifier.weight(1f))
        }
        Spacer(Modifier.height(14.dp))

        ClaroCard {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text(tr("Espaço compartilhado"), style = VagalunTypography.bodySecondary)
                Text("${sliderValue.toInt()} GB", style = VagalunTypography.body.copy(fontWeight = FontWeight.SemiBold))
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
            Text(tr("Você pode ceder até %d GB deste aparelho", maxOfferableGb), style = VagalunTypography.small)
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
            ClaroHeader(tr("Na rede"), tr("Arquivos"), onOpenSettings)

            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                placeholder = { Text(tr("Buscar arquivos"), style = VagalunTypography.bodySecondary.copy(fontSize = 16.sp)) },
                leadingIcon = { Icon(Lucide.Search, contentDescription = null, tint = VagalunColors.textSecondary) },
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
                            tr(tab.label),
                            color = if (selected) Color.White else VagalunColors.textSecondary,
                            fontSize = 15.sp, fontWeight = FontWeight.Medium
                        )
                    }
                }
            }
            Spacer(Modifier.height(14.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(tr("Espaço usado"), style = VagalunTypography.bodySecondary)
                Text(tr("%s de 2 GB", formatSize(usedBytes)), style = VagalunTypography.bodySecondary)
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
                    Icon(Lucide.Folder, contentDescription = null, tint = VagalunColors.textSecondary, modifier = Modifier.size(56.dp))
                    Spacer(Modifier.height(8.dp))
                    Text(if (files.isEmpty()) tr("Nenhum arquivo ainda") else tr("Nada encontrado"), style = VagalunTypography.titleMedium)
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
            Icon(Lucide.Plus, contentDescription = tr("Enviar arquivo"), tint = Color.White, modifier = Modifier.size(28.dp))
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
                Icon(Lucide.Trash, contentDescription = tr("Excluir"), tint = VagalunColors.textSecondary)
            }
        }
    )
    if (showConfirm) {
        AlertDialog(
            onDismissRequest = { showConfirm = false },
            title = { Text(tr("Excluir arquivo?")) },
            text = { Text(tr("Isso encerra o pagamento do contrato e avisa a rede para liberar o espaço.")) },
            confirmButton = {
                TextButton(onClick = { showConfirm = false; onDelete() }) { Text(tr("Excluir"), color = VagalunColors.danger) }
            },
            dismissButton = { TextButton(onClick = { showConfirm = false }) { Text(tr("Cancelar")) } }
        )
    }
}

// ===================== CARTEIRA (visual; a lógica fica na WalletScreen) =====================

@Composable
fun ClaroWalletContent(
    balanceText: AnnotatedString,
    brlLine: String,
    walletAddress: String,
    claiming: Boolean,
    showSeed: Boolean,
    seed: String,
    onRefresh: () -> Unit,
    onSend: () -> Unit,
    onReceive: () -> Unit,
    onClaim: () -> Unit,
    onToggleSeed: () -> Unit,
    onOpenSettings: () -> Unit,
    showDevTools: Boolean = false
) {
    var showPixSoon by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 16.dp)) {
        ClaroHeader(tr("Seu dinheiro"), tr("Carteira"), onOpenSettings)

        ClaroCard(padding = 21.dp) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.Top) {
                Text(tr("Saldo total"), style = VagalunTypography.bodySecondary)
                IconButton(onClick = onRefresh, modifier = Modifier.size(24.dp)) {
                    Icon(Lucide.Refresh, contentDescription = tr("Atualizar"), tint = VagalunColors.textSecondary)
                }
            }
            Spacer(Modifier.height(6.dp))
            Text(balanceText, style = VagalunTypography.titleLarge.copy(fontSize = 40.sp), maxLines = 1)
            if (brlLine.isNotBlank()) Text(brlLine, style = VagalunTypography.bodySecondary)
        }
        Spacer(Modifier.height(15.dp))

        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            ActionTile(tr("Enviar"), Lucide.Send, Modifier.weight(1f), primary = true, onClick = onSend)
            ActionTile(tr("Receber"), Lucide.Download, Modifier.weight(1f), onClick = onReceive)
            ActionTile(tr("Sacar Pix"), null, Modifier.weight(1f), imageRes = R.drawable.logo_pix, onClick = { showPixSoon = true })
        }
        Spacer(Modifier.height(15.dp))

        // Botão de teste (reivindicar época) escondido no lançamento. O claim automático continua rodando a cada 24h.
        if (showDevTools) {
            OutlinedButton(
                onClick = onClaim,
                enabled = !claiming,
                modifier = Modifier.fillMaxWidth().height(48.dp),
                shape = RoundedCornerShape(16.dp)
            ) {
                if (claiming) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = VagalunColors.red)
                else Text("Reivindicar época agora (teste)", color = VagalunColors.red, fontWeight = FontWeight.SemiBold)
            }
            Spacer(Modifier.height(15.dp))
        }

        Spacer(Modifier.height(22.dp))
        Text(tr("Movimentações"), style = VagalunTypography.titleMedium)
        Spacer(Modifier.height(8.dp))
        Text(tr("As recompensas da rede vão aparecer aqui em breve."), style = VagalunTypography.bodySecondary)

        Spacer(Modifier.height(24.dp))
        ClaroCard(padding = 8.dp) {
            if (walletAddress.isNotEmpty()) {
                Column(Modifier.padding(horizontal = 13.dp)) {
                    ClaroListRow(
                        tr("Endereço"), "${walletAddress.take(6)}...${walletAddress.takeLast(4)}",
                        trailing = { Icon(Lucide.Copy, contentDescription = tr("Copiar"), tint = VagalunColors.textSecondary) },
                        onClick = onReceive
                    )
                }
            }
            Column(Modifier.padding(horizontal = 13.dp)) {
                ClaroListRow(
                    tr("Chave secreta"), if (showSeed) tr("Toque para ocultar") else tr("Toque para revelar"),
                    trailing = { Chevron() }, onClick = onToggleSeed, divider = false
                )
                if (showSeed) {
                    Text(seed, style = VagalunTypography.body, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
                    Text(
                        tr("Nunca compartilhe isso com ninguém."),
                        color = VagalunColors.danger, fontSize = 12.sp,
                        modifier = Modifier.padding(vertical = 10.dp)
                    )
                }
            }
        }
        Spacer(Modifier.height(24.dp))
    }

    if (showPixSoon) {
        AlertDialog(
            onDismissRequest = { showPixSoon = false },
            icon = { Image(painterResource(R.drawable.logo_pix), contentDescription = "Pix", modifier = Modifier.size(52.dp)) },
            title = { Text(tr("Saque via Pix"), fontWeight = FontWeight.Bold) },
            text = {
                Text(
                    tr("Disponível em breve. Estamos finalizando essa etapa para que seus ganhos cheguem direto na sua conta, com segurança."),
                    textAlign = TextAlign.Center
                )
            },
            confirmButton = {
                TextButton(onClick = { showPixSoon = false }) { Text(tr("Entendi"), color = VagalunColors.red, fontWeight = FontWeight.SemiBold) }
            }
        )
    }
}

@Composable
private fun ActionTile(
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector?,
    modifier: Modifier,
    primary: Boolean = false,
    imageRes: Int? = null,
    onClick: () -> Unit
) {
    val shape = RoundedCornerShape(20.dp)
    Column(
        modifier.height(72.dp).clip(shape)
            .background(if (primary) VagalunColors.red else VagalunColors.bgCard)
            .border(1.dp, if (primary) VagalunColors.red else VagalunColors.cardBorder, shape)
            .clickable { onClick() },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        if (imageRes != null) {
            // Logo oficial do Pix, com as cores originais (sem tint).
            Image(painterResource(imageRes), contentDescription = null, modifier = Modifier.size(26.dp), contentScale = ContentScale.Fit)
        } else if (icon != null) {
            Icon(icon, contentDescription = null, tint = if (primary) Color.White else VagalunColors.textPrimary, modifier = Modifier.size(22.dp))
        }
        Spacer(Modifier.height(4.dp))
        Text(label, color = if (primary) Color.White else VagalunColors.textPrimary, fontSize = 15.sp, fontWeight = FontWeight.Medium)
    }
}

// ===================== MISSÕES =====================

@Composable
fun MissionsScreen(
    signalingUrl: String,
    referralBaseUrl: String = "",
    onRedeemCode: suspend (String) -> RedeemResult = { RedeemResult.Unavailable },
    walletAddress: String,
    nodeActive: Boolean,
    filesCount: Int = 0,
    onOpenSettings: () -> Unit = {}
) {
    var info by remember { mutableStateOf<PointsInfo?>(null) }
    var referral by remember { mutableStateOf<ReferralStats?>(null) }
    var reloadTick by remember { mutableStateOf(0) }
    var codeApplied by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf(false) }
    var leaderboard by remember { mutableStateOf<List<LeaderboardEntry>?>(null) }
    var leaderboardLoading by remember { mutableStateOf(true) }
    val context = LocalContext.current

    LaunchedEffect(walletAddress, signalingUrl, referralBaseUrl, reloadTick) {
        if (info == null) loading = true
        leaderboardLoading = true
        val snap = loadPointsSnapshot(signalingUrl, referralBaseUrl, walletAddress)
        info = snap.info
        referral = snap.referral
        error = snap.info == null
        loading = false
        leaderboard = withContext(Dispatchers.IO) { PointsClient.fetchLeaderboard(signalingUrl) }
        leaderboardLoading = false
    }

    val code = walletAddress.take(8).uppercase()
    fun copyCode() {
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
        cm.setPrimaryClip(android.content.ClipData.newPlainText("codigo", code))
    }
    fun share() {
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            val link = ReferralClient.inviteLink(referralBaseUrl, code)
            putExtra(Intent.EXTRA_TEXT, tr("Entre na Vagalun e ganhe com o espaço do seu celular. Meu código: %s", code) + if (link.isNotBlank()) "\n$link" else "")
        }
        try { context.startActivity(Intent(send).setPackage("com.whatsapp")) }
        catch (e: Exception) { context.startActivity(Intent.createChooser(send, tr("Compartilhar"))) }
    }

    val bonus = referral?.bonusPoints ?: 0L
    val points = (info?.points ?: 0L) + bonus
    val level = (points / POINTS_PER_LEVEL).toInt() + 1
    val intoLevel = (points - (level - 1) * POINTS_PER_LEVEL).toFloat() / POINTS_PER_LEVEL
    val toNext = level * POINTS_PER_LEVEL - points
    val uptimeS = info?.uptimeSeconds ?: 0L
    val goalS = 10L * 3600
    val firstFileDone = filesCount > 0
    val uptimeDone = uptimeS >= goalS
    val friendsGoal = 3
    val friendsActive = referral?.active ?: 0
    val friendsDone = friendsActive >= friendsGoal
    val totalMissions = 3
    val doneMissions = listOf(firstFileDone, uptimeDone, friendsDone).count { it }
    val perReferral = referral?.pointsPerReferral ?: ReferralClient.DEFAULT_POINTS_PER_REFERRAL

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 16.dp)) {
        ClaroHeader(tr("Seu progresso"), tr("Missões"), onOpenSettings)

        if (walletAddress.isEmpty()) {
            ClaroCard { Text(tr("Crie ou restaure sua carteira para acompanhar pontos e missões."), style = VagalunTypography.bodySecondary) }
        } else {
            // 1) Progresso: pontos + nível numa leitura só.
            ClaroCard {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text(tr("Seus pontos"), style = VagalunTypography.bodySecondary)
                    ClaroChip(tr("Nível %d", level))
                }
                Spacer(Modifier.height(6.dp))
                Text(if (loading) "…" else pointsFormatted(points), style = VagalunTypography.titleLarge.copy(fontSize = 40.sp))
                Spacer(Modifier.height(14.dp))
                ClaroBar(intoLevel)
                Spacer(Modifier.height(8.dp))
                Text(
                    if (error) tr("Não consegui carregar seus pontos agora.") else tr("Faltam %d pontos para o nível %d", toNext, level + 1),
                    style = VagalunTypography.small
                )
            }

            // 2) Missões: o que fazer agora.
            Spacer(Modifier.height(24.dp))
            SectionTitle(tr("Suas missões"), tr("%d de %d concluídas", doneMissions, totalMissions))
            ClaroCard(padding = 8.dp) {
                Column(Modifier.padding(horizontal = 13.dp)) {
                    MissionRow(
                        title = tr("Enviar o primeiro arquivo"),
                        sub = if (firstFileDone) tr("concluída") else tr("envie um arquivo para a rede"),
                        done = firstFileDone
                    )
                    MissionRow(
                        title = tr("Ficar 10 h online"),
                        sub = if (uptimeDone) tr("concluída") else tr("%s de 10h", formatUptimeSeconds(uptimeS)),
                        done = uptimeDone,
                        progress = (uptimeS.toFloat() / goalS).coerceIn(0f, 1f)
                    )
                    MissionRow(
                        title = tr("Convidar 3 amigos"),
                        sub = if (friendsDone) tr("concluída") else tr("%d de %d amigos ativos", friendsActive, friendsGoal),
                        done = friendsDone,
                        progress = (friendsActive.toFloat() / friendsGoal).coerceIn(0f, 1f),
                        divider = false
                    )
                }
            }

            // 3) Convite: principal motor de crescimento.
            Spacer(Modifier.height(24.dp))
            ClaroCard(padding = 18.dp) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(tr("Convide amigos"), style = VagalunTypography.titleMedium)
                        Spacer(Modifier.height(6.dp))
                        Text(tr("Ganhe %d pontos por cada amigo que ficar ativo na rede.", perReferral), style = VagalunTypography.bodySecondary.copy(fontSize = 15.sp))
                    }
                    Image(painterResource(R.drawable.mascot_gift_a), "Vagalumin", Modifier.size(72.dp), contentScale = ContentScale.Fit)
                }
                referral?.let { r ->
                    Spacer(Modifier.height(14.dp))
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        StatTile(tr("Amigos"), r.invited.toString(), Modifier.weight(1f))
                        StatTile(tr("Ativos"), r.active.toString(), Modifier.weight(1f))
                        StatTile(tr("Pontos"), "+" + pointsFormatted(r.bonusPoints), Modifier.weight(1f))
                    }
                    if (r.pending > 0) {
                        Spacer(Modifier.height(8.dp))
                        Text(
                            if (r.activeUptimeSeconds > 0) tr("Amigos aguardando ativação: %d (precisam de %d min online)", r.pending, r.activeUptimeSeconds / 60)
                            else tr("Amigos aguardando ativação: %d", r.pending),
                            style = VagalunTypography.small
                        )
                    }
                }
                Spacer(Modifier.height(14.dp))
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(VagalunColors.bg)
                        .border(1.dp, VagalunColors.cardBorder, RoundedCornerShape(16.dp))
                        .clickable { copyCode() }.padding(horizontal = 14.dp, vertical = 12.dp),
                    horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(tr("Seu código: %s", code), style = VagalunTypography.body.copy(fontSize = 16.sp))
                    Icon(Lucide.Copy, contentDescription = tr("Copiar código"), tint = VagalunColors.textSecondary, modifier = Modifier.size(20.dp))
                }
                Spacer(Modifier.height(12.dp))
                Button(
                    onClick = { share() },
                    modifier = Modifier.fillMaxWidth().height(52.dp),
                    shape = RoundedCornerShape(18.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = VagalunColors.red)
                ) { Text(tr("Compartilhar no WhatsApp"), color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 16.sp) }
            }

            // 3b) Quem veio por indicação digita o código aqui (uma única vez).
            if (codeApplied || (!loading && referral?.invitedBy == null)) {
                Spacer(Modifier.height(14.dp))
                InviteCodeCard(
                    onRedeem = onRedeemCode,
                    onApplied = { codeApplied = true; reloadTick++ }
                )
            }

            // 4) Ranking: top 5 + a posição do próprio usuário, mesmo fora do top 5.
            Spacer(Modifier.height(24.dp))
            SectionTitle(tr("Ranking"), null)
            Text(tr("Quem mais contribui com a rede"), style = VagalunTypography.bodySecondary, modifier = Modifier.padding(bottom = 10.dp))
            ClaroCard(padding = 8.dp) {
                val board = leaderboard
                when {
                    leaderboardLoading -> Text(tr("Carregando…"), style = VagalunTypography.bodySecondary, modifier = Modifier.padding(13.dp))
                    board == null -> Text(tr("Ranking indisponível agora."), style = VagalunTypography.bodySecondary, modifier = Modifier.padding(13.dp))
                    board.isEmpty() -> Text(tr("Ainda não há ninguém no ranking."), style = VagalunTypography.bodySecondary, modifier = Modifier.padding(13.dp))
                    else -> {
                        val top = board.take(5)
                        val myIdx = board.indexOfFirst { it.pubkey == walletAddress }
                        val showMeBelow = myIdx >= 5
                        Column(Modifier.padding(horizontal = 6.dp)) {
                            top.forEachIndexed { idx, e ->
                                RankRow(idx + 1, e, e.pubkey == walletAddress, divider = idx < top.lastIndex || showMeBelow, extraPoints = if (e.pubkey == walletAddress) bonus else 0L)
                            }
                            if (showMeBelow) {
                                Text("⋯", style = VagalunTypography.bodySecondary, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp))
                                RankRow(myIdx + 1, board[myIdx], true, divider = false, extraPoints = bonus)
                            }
                        }
                    }
                }
            }

            Spacer(Modifier.height(16.dp))
            Text(tr("Pontos não são dinheiro. A conversão será anunciada à parte."), style = VagalunTypography.small)
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun InviteCodeCard(onRedeem: suspend (String) -> RedeemResult, onApplied: () -> Unit) {
    val scope = rememberCoroutineScope()
    var input by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var success by remember { mutableStateOf<String?>(null) }

    ClaroCard(padding = 18.dp) {
        val done = success
        if (done != null) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Lucide.Check, contentDescription = null, tint = VagalunColors.success, modifier = Modifier.size(22.dp))
                Spacer(Modifier.width(10.dp))
                Text(done, style = VagalunTypography.body)
            }
        } else {
            Text(tr("Foi convidado por alguém?"), style = VagalunTypography.titleMedium)
            Spacer(Modifier.height(6.dp))
            Text(tr("Digite o código do seu amigo. Só dá para usar um código, uma única vez."), style = VagalunTypography.bodySecondary.copy(fontSize = 15.sp))
            Spacer(Modifier.height(12.dp))
            InviteCodeField(
                value = input,
                onChange = { input = it; error = null },
                label = tr("Código de convite"),
                isError = error != null,
                errorText = error
            )
            Spacer(Modifier.height(12.dp))
            Button(
                enabled = input.length == 8 && !busy,
                onClick = {
                    scope.launch {
                        busy = true
                        val r = onRedeem(input)
                        busy = false
                        if (r.isSuccess) { success = r.message(); onApplied() } else error = r.message()
                    }
                },
                modifier = Modifier.fillMaxWidth().height(52.dp),
                shape = RoundedCornerShape(18.dp),
                colors = ButtonDefaults.buttonColors(containerColor = VagalunColors.red)
            ) {
                if (busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = Color.White)
                else Text(tr("Aplicar código"), color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
            }
        }
    }
}

@Composable
private fun SectionTitle(title: String, trailing: String?) {
    Row(Modifier.fillMaxWidth().padding(bottom = 10.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.Bottom) {
        Text(title, style = VagalunTypography.titleMedium)
        if (trailing != null) Text(trailing, style = VagalunTypography.bodySecondary)
    }
}

@Composable
private fun MissionRow(
    title: String,
    sub: String,
    done: Boolean,
    progress: Float? = null,
    soon: Boolean = false,
    divider: Boolean = true
) {
    Column {
        Row(Modifier.fillMaxWidth().padding(vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(
                    title,
                    style = VagalunTypography.body.copy(
                        fontSize = 17.sp, fontWeight = FontWeight.Medium,
                        color = if (soon) VagalunColors.textSecondary else VagalunColors.textPrimary
                    )
                )
                Text(sub, style = VagalunTypography.bodySecondary)
                if (progress != null && !done) {
                    Spacer(Modifier.height(8.dp))
                    ClaroBar(progress)
                }
            }
            Spacer(Modifier.width(12.dp))
            if (soon) {
                Box(
                    Modifier.clip(RoundedCornerShape(14.dp)).background(VagalunColors.bgCard2)
                        .padding(horizontal = 9.dp, vertical = 6.dp)
                ) { Text(tr("Em breve"), color = VagalunColors.textSecondary, fontSize = 12.5.sp, fontWeight = FontWeight.Medium) }
            } else {
                Box(
                    Modifier.size(38.dp).clip(CircleShape)
                        .background(if (done) VagalunColors.success else VagalunColors.bgCard)
                        .border(1.dp, if (done) VagalunColors.success else VagalunColors.cardBorder, CircleShape),
                    contentAlignment = Alignment.Center
                ) { if (done) Icon(Lucide.Check, contentDescription = tr("Concluída"), tint = Color.White, modifier = Modifier.size(20.dp)) }
            }
        }
        if (divider) Divider(color = VagalunColors.cardBorder)
    }
}

@Composable
private fun RankRow(position: Int, entry: LeaderboardEntry, me: Boolean, divider: Boolean, extraPoints: Long = 0L) {
    // Ouro, prata e bronze para o pódio; cinza neutro para o resto.
    val medal: Color? = when (position) {
        1 -> Color(0xFFE0A526); 2 -> Color(0xFF9AA0A6); 3 -> Color(0xFFC17A44); else -> null
    }
    val badge = medal ?: VagalunColors.textSecondary
    Column {
        Row(
            Modifier.fillMaxWidth()
                .clip(RoundedCornerShape(14.dp))
                .background(if (me) VagalunColors.redTint else Color.Transparent)
                .padding(horizontal = 8.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(Modifier.size(32.dp).clip(CircleShape).background(badge.copy(alpha = 0.16f)), contentAlignment = Alignment.Center) {
                Text(position.toString(), color = badge, fontSize = 14.sp, fontWeight = FontWeight.Bold)
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    if (me) tr("Você") else shortenPubkey(entry.pubkey),
                    style = VagalunTypography.body.copy(fontSize = 16.sp, fontWeight = FontWeight.Medium),
                    maxLines = 1
                )
                Text(tr("%s online", formatUptimeSeconds(entry.uptimeSeconds)), style = VagalunTypography.small)
            }
            Text("${pointsFormatted(entry.points + extraPoints)} pts", style = VagalunTypography.body.copy(fontWeight = FontWeight.SemiBold))
        }
        if (divider) Divider(color = VagalunColors.cardBorder, modifier = Modifier.padding(horizontal = 8.dp))
    }
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
    onClearDeadShards: () -> Unit,
    langMode: Int = 0,
    onLangChange: (Int) -> Unit = {}
) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 20.dp)) {
        Text(tr("Configurações"), style = VagalunTypography.titleLarge)

        SettingsSection(tr("Conta"))
        ClaroCard(padding = 20.dp) {
            ClaroListRow(
                tr("Carteira"),
                if (walletAddress.isNotEmpty()) "${walletAddress.take(6)}...${walletAddress.takeLast(4)}" else null,
                trailing = { Chevron() }, onClick = onOpenWallet
            )
            ClaroListRow(
                tr("Idioma"),
                trailing = { Text(Lang.modeLabel(langMode), style = VagalunTypography.bodySecondary) },
                onClick = { onLangChange((langMode + 1) % 4) },
                divider = false
            )
        }

        SettingsSection(tr("Rede"))
        ClaroCard(padding = 20.dp) {
            ClaroListRow(tr("Sincronizar só no Wi-Fi"), trailing = { ClaroSwitch(wifiOnly, onWifiOnlyChange) })
            ClaroListRow(tr("Manter ativo em segundo plano"), trailing = { ClaroSwitch(backgroundSync, onBackgroundSyncChange) }, divider = false)
        }

        SettingsSection(tr("Aparência"))
        ClaroCard(padding = 20.dp) {
            ClaroListRow(
                tr("Tema"),
                trailing = { Text(listOf(tr("Automático"), tr("Claro"), tr("Escuro"))[themeMode.coerceIn(0, 2)], style = VagalunTypography.bodySecondary) },
                onClick = { onThemeChange((themeMode + 1) % 3) },
                divider = false
            )
        }

        SettingsSection(tr("Segurança"))
        ClaroCard(padding = 20.dp) {
            ClaroListRow(tr("Backup da carteira"), trailing = { Chevron() }, onClick = onOpenWallet, divider = false)
        }

        SettingsSection(tr("Ajuda"))
        ClaroCard(padding = 20.dp) {
            ClaroListRow(tr("Limpar cache"), tr("Remove só temporários; seus arquivos não são apagados"), trailing = { Chevron() }, onClick = onClearDeadShards, divider = false)
        }
        Spacer(Modifier.height(14.dp))
        Text(tr("Vagalun · versão beta"), style = VagalunTypography.bodySecondary, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(24.dp))
    }
}
