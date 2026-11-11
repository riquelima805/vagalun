package com.decentstorage.app

import android.util.Base64
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** Números de indicação de uma carteira, vindos do servidor de convites. */
data class ReferralStats(
    val code: String,
    val invited: Int,
    val active: Int,
    val pending: Int,
    val bonusPoints: Long,
    val pointsPerReferral: Int,
    val activeUptimeSeconds: Long,
    /** Código que esta carteira já usou para entrar (null = ainda não usou nenhum). */
    val invitedBy: String?
)

sealed class RedeemResult {
    object Ok : RedeemResult()
    object AlreadyRedeemed : RedeemResult()
    object InvalidCode : RedeemResult()
    object UnknownCode : RedeemResult()
    object SelfReferral : RedeemResult()
    /** Recusado de forma definitiva (ex.: assinatura inválida). */
    object Rejected : RedeemResult()
    /** Temporário: vale tentar de novo depois. */
    object RateLimited : RedeemResult()
    object Unavailable : RedeemResult()

    /** Resultado final = não adianta tentar de novo com o mesmo código. */
    val isFinal: Boolean get() = this !is RateLimited && this !is Unavailable
    val isSuccess: Boolean get() = this is Ok || this is AlreadyRedeemed

    fun message(): String = when (this) {
        Ok -> tr("Código aplicado! Seu amigo ganha pontos quando você ficar ativo.")
        AlreadyRedeemed -> tr("Você já usou um código de convite.")
        InvalidCode -> tr("Código inválido. Ele tem 8 letras e números.")
        UnknownCode -> tr("Não encontramos esse código. Confira com seu amigo.")
        SelfReferral -> tr("Você não pode usar o seu próprio código.")
        Rejected -> tr("Não foi possível aplicar o código.")
        RateLimited -> tr("Muitas tentativas. Tente de novo mais tarde.")
        Unavailable -> tr("Sem conexão com o servidor. Tente de novo em instantes.")
    }
}

object ReferralClient {
    const val DEFAULT_POINTS_PER_REFERRAL = 100

    private val CODE_RE = Regex("^[1-9A-Z]{8}$")
    private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
    private val client = OkHttpClient.Builder()
        .connectTimeout(6, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .build()

    /** O código de convite é o começo da carteira, em maiúsculas. */
    fun codeFor(walletAddress: String): String = walletAddress.take(8).uppercase()

    /** Aceita "abcd 1234", "ABCD-1234" etc. Devolve null se não for um código válido. */
    fun normalizeCode(raw: String?): String? {
        val c = raw.orEmpty().trim().uppercase().replace(" ", "").replace("-", "")
        return if (CODE_RE.matches(c)) c else null
    }

    /** Texto assinado pela carteira. Tem que ser idêntico ao do servidor (referral.js). */
    fun message(code: String, pubkey: String): String = "vagalun-referral:v1:$code:$pubkey"

    /**
     * Endereço do servidor de convites. Prioridade: "referralUrl" do reley.json;
     * se não existir, assume que as rotas rodam no mesmo servidor do signaling.
     */
    fun baseUrl(referralUrl: String, signalingUrl: String): String {
        val explicit = referralUrl.trim().trimEnd('/')
        if (explicit.startsWith("https://") || explicit.startsWith("http://")) return explicit
        return when {
            signalingUrl.startsWith("wss://") -> "https://" + signalingUrl.removePrefix("wss://").substringBefore("/")
            signalingUrl.startsWith("ws://") -> "http://" + signalingUrl.removePrefix("ws://").substringBefore("/")
            else -> ""
        }
    }

    fun inviteLink(base: String, code: String): String = if (base.isBlank()) "" else "$base/i/$code"

    fun fetchStats(base: String, pubkey: String): ReferralStats? {
        if (base.isBlank() || pubkey.isBlank()) return null
        return try {
            val req = Request.Builder().url("$base/referral/stats/${java.net.URLEncoder.encode(pubkey, "UTF-8")}").build()
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return null
                val j = JSONObject(resp.body?.string() ?: return null)
                ReferralStats(
                    code = j.optString("code", codeFor(pubkey)),
                    invited = j.optInt("invited", 0),
                    active = j.optInt("active", 0),
                    pending = j.optInt("pending", 0),
                    bonusPoints = j.optLong("bonusPoints", 0L),
                    pointsPerReferral = j.optInt("pointsPerReferral", DEFAULT_POINTS_PER_REFERRAL),
                    activeUptimeSeconds = j.optLong("activeUptimeSeconds", 0L),
                    invitedBy = if (j.isNull("invitedBy")) null else j.optString("invitedBy").ifBlank { null }
                )
            }
        } catch (e: Exception) {
            null
        }
    }

    /** [signature] = carteira assinando [message]. Chamar fora da thread principal. */
    fun redeem(base: String, code: String, pubkey: String, signature: ByteArray): RedeemResult {
        if (base.isBlank()) return RedeemResult.Unavailable
        return try {
            val body = JSONObject()
                .put("code", code)
                .put("pubkey", pubkey)
                .put("signature", Base64.encodeToString(signature, Base64.NO_WRAP))
                .toString()
                .toRequestBody(JSON_MEDIA)
            val req = Request.Builder().url("$base/referral/redeem").post(body).build()
            client.newCall(req).execute().use { resp ->
                val err = try { JSONObject(resp.body?.string() ?: "{}").optString("error", "") } catch (_: Exception) { "" }
                when {
                    resp.isSuccessful -> RedeemResult.Ok
                    resp.code == 409 -> RedeemResult.AlreadyRedeemed
                    resp.code == 404 -> RedeemResult.UnknownCode
                    resp.code == 429 -> RedeemResult.RateLimited
                    resp.code == 400 && err == "self_referral" -> RedeemResult.SelfReferral
                    resp.code == 400 && err == "invalid_code" -> RedeemResult.InvalidCode
                    resp.code in 500..599 -> RedeemResult.Unavailable
                    else -> RedeemResult.Rejected
                }
            }
        } catch (e: Exception) {
            RedeemResult.Unavailable
        }
    }
}
