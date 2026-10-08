package com.decentstorage.app.work

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.decentstorage.app.crypto.KeyManager
import com.decentstorage.app.wallet.AnchorStorageClient
import com.decentstorage.app.wallet.EpochPayoutClient
import com.decentstorage.app.wallet.SolanaWallet
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

class DailyClaimWorker(appContext: Context, params: WorkerParameters) : CoroutineWorker(appContext, params) {

    companion object {
        private const val UNIQUE_WORK_NAME = "daily_claim"

       
        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<DailyClaimWorker>(24, TimeUnit.HOURS).build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                UNIQUE_WORK_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                request
            )
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(UNIQUE_WORK_NAME)
        }
    }

    private fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)

    override suspend fun doWork(): Result {
        return try {
            val prefs = applicationContext.getSharedPreferences("decentstorage", Context.MODE_PRIVATE)
            val seedPhrase = prefs.getString("seed", null) ?: return Result.success() // sem carteira ainda, nada a fazer
            val seedBytes = KeyManager.seedBytes(seedPhrase)
            val wallet = SolanaWallet.fromSeedPhrase(seedBytes)
            val anchorClient = AnchorStorageClient(wallet)

            val dataDir = File(applicationContext.filesDir, "shards")
            val placementsFile = File(dataDir, "placements.json")

            var failures = 0
            if (placementsFile.exists()) {
                val arr = org.json.JSONArray(placementsFile.readText())
                for (i in 0 until arr.length()) {
                    val entry = arr.getJSONObject(i)
                    try {
                        claimOne(entry, dataDir, anchorClient)
                    } catch (e: Exception) {
                        failures++
                    }
                }
                if (failures > 0 && failures == arr.length()) {
                    // ainda tenta o claim de época antes de reportar falha —
                    // são caminhos independentes (Bloco 1 pago vs Bloco 2 rede)
                    claimEpochPayoutIfAny(prefs, wallet, anchorClient)
                    return Result.retry()
                }
            }

            claimEpochPayoutIfAny(prefs, wallet, anchorClient)

            Result.success()
        } catch (e: Exception) {
            Result.retry()
        }
    }

    // Bloco 2 (payout de rede por época) — mesmo signaling server que já serve
    // /points e /points/leaderboard (ver PointsClient em MainActivity.kt) também
    // expõe /epoch/:id/proof/:pubkey (epochApi.js). Reaproveita o mesmo host,
    // já salvo em prefs por RelayConfig quando o app conecta.
    private fun httpBaseFromSignaling(signalingUrl: String): String? {
        if (signalingUrl.isBlank()) return null
        return when {
            signalingUrl.startsWith("wss://") -> "https://" + signalingUrl.removePrefix("wss://").substringBefore("/")
            signalingUrl.startsWith("ws://") -> "http://" + signalingUrl.removePrefix("ws://").substringBefore("/")
            else -> null
        }
    }

    // Época é semanal (epochJob.js: Math.floor(Date.now()/1000/WEEK_SECONDS)) mas
    // esse worker roda a cada 24h — então numa mesma semana ele vai bater
    // "sem payout ainda" (404) na maioria dos dias, o que é esperado, não erro.
    // Tenta a época atual e a anterior, pra não perder uma época que só foi
    // publicada depois que a semana virou. Guarda em prefs quais epochId já
    // foram reivindicadas com sucesso pra não tentar de novo à toa (o programa
    // já rejeitaria via claim_receipt PDA existente, mas evita gastar gas/log
    // de erro repetido).
    private suspend fun claimEpochPayoutIfAny(
        prefs: android.content.SharedPreferences,
        wallet: SolanaWallet,
        anchorClient: AnchorStorageClient,
    ) {
        val signalingUrl = prefs.getString("signalingUrl", null) ?: return
        val baseUrl = httpBaseFromSignaling(signalingUrl) ?: return
        val payoutClient = EpochPayoutClient(baseUrl)
        val pubkey = wallet.publicKey.toBase58()

        val weekSeconds = 7L * 24 * 60 * 60
        val currentEpochId = System.currentTimeMillis() / 1000L / weekSeconds
        val alreadyClaimed = prefs.getStringSet("claimedEpochIds", emptySet()) ?: emptySet()

        for (epochId in listOf(currentEpochId, currentEpochId - 1)) {
            if (alreadyClaimed.contains(epochId.toString())) continue
            try {
                val proof = payoutClient.fetchProof(epochId, pubkey) ?: continue // sem payout nessa época — normal
                val sig = anchorClient.claimEpoch(proof.epochId, proof.amountLamports, proof.proof)
                if (!sig.startsWith("ERRO")) {
                    prefs.edit()
                        .putStringSet("claimedEpochIds", alreadyClaimed + epochId.toString())
                        .apply()
                }
            } catch (e: Exception) {
                // época ainda não publicada ou falha de rede pontual — tenta de novo no próximo run diário
            }
        }
    }

    private suspend fun claimOne(entry: JSONObject, dataDir: File, anchorClient: AnchorStorageClient) {
        val shardKey = entry.getString("shardKey")
        val placementPda = org.sol4k.PublicKey(entry.getString("placement"))
        val fileVaultPda = org.sol4k.PublicKey(entry.getString("fileVault"))

        val safe = shardKey.replace(Regex("[^a-zA-Z0-9_-]"), "")
        val shardFile = File(dataDir, "$safe.shard")
        if (!shardFile.exists()) return 

        val chunkHash = sha256(shardFile.readBytes())

        anchorClient.submitPaidClaim(
            placement = placementPda,
            fileVault = fileVaultPda,
            chunkIndex = 0,
            chunkHash = chunkHash,
            merkleProof = emptyList() 
        )
    }
}
