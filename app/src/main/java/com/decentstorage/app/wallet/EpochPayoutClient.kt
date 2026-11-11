package com.decentstorage.app.wallet

import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.coroutines.suspendCoroutine

/**
 * Busca no backend (rota GET /epoch/:id/proof/:pubkey de epochApi.js) o valor
 * e a merkle proof que essa wallet tem direito a reivindicar numa época — nunca
 * calcula isso localmente, só repassa pro AnchorStorageClient.claimEpoch, que
 * por sua vez deixa o programa validar a proof contra a raiz publicada on-chain.
 */
class EpochPayoutClient(
    private val baseUrl: String, // ex.: "https://api.vagalun.com"
) {
    private val client = OkHttpClient()

    data class EpochProof(
        val epochId: Long,
        val root: String,
        val amountLamports: Long,
        val proof: List<ByteArray>,
    )

    /**
     * @return a proof, ou null se essa pubkey não tem payout nessa época (abaixo
     * do mínimo de saque, ou sem contribuição no período — ver epochApi.js, que
     * devolve 404 nesse caso, não é erro de rede).
     * @throws IOException se a época ainda não foi publicada ou a chamada falhar de verdade.
     */
    suspend fun fetchProof(epochId: Long, pubkeyBase58: String): EpochProof? =
        suspendCoroutine { cont ->
            val request = Request.Builder()
                .url("$baseUrl/epoch/$epochId/proof/$pubkeyBase58")
                .get()
                .build()

            client.newCall(request).enqueue(object : okhttp3.Callback {
                override fun onFailure(call: okhttp3.Call, e: IOException) {
                    cont.resumeWithException(e)
                }

                override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) {
                    response.use {
                        val bodyStr = it.body?.string().orEmpty()
                        when (it.code) {
                            200 -> {
                                try {
                                    val json = JSONObject(bodyStr)
                                    val proofArray = json.getJSONArray("proof")
                                    val proof = (0 until proofArray.length()).map { i ->
                                        hexToBytes(proofArray.getString(i))
                                    }
                                    cont.resume(
                                        EpochProof(
                                            epochId = json.getLong("epochId"),
                                            root = json.getString("root"),
                                            amountLamports = json.getLong("amountLamports"),
                                            proof = proof,
                                        )
                                    )
                                } catch (e: Exception) {
                                    cont.resumeWithException(IOException("resposta inesperada do backend: $bodyStr", e))
                                }
                            }
                            404 -> cont.resume(null) // sem payout nessa época — não é erro
                            else -> cont.resumeWithException(IOException("epochApi devolveu ${it.code}: $bodyStr"))
                        }
                    }
                }
            })
        }

    private fun hexToBytes(hex: String): ByteArray {
        val clean = hex.trim()
        require(clean.length % 2 == 0) { "hex com tamanho ímpar: $clean" }
        val out = ByteArray(clean.length / 2)
        for (i in out.indices) {
            out[i] = clean.substring(i * 2, i * 2 + 2).toInt(16).toByte()
        }
        return out
    }
}

/**
 * Uso típico (ex.: dentro de uma corrotina no app, quando o usuário abre a
 * tela "Meus ganhos" ou quando um worker periódico checa se tem payout novo):
 *
 *   val payoutClient = EpochPayoutClient(baseUrl = "https://api.vagalun.com")
 *   val proof = payoutClient.fetchProof(epochId, wallet.publicKey.toBase58())
 *   if (proof != null) {
 *       val sig = anchorClient.claimEpoch(proof.epochId, proof.amountLamports, proof.proof)
 *       // mostra sig/erro pro usuário
 *   } else {
 *       // essa época ainda não tem payout pra essa wallet — normal, não é erro
 *   }
 */
