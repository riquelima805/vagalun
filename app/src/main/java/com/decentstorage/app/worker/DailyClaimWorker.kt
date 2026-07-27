package com.decentstorage.app.work

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.decentstorage.app.crypto.KeyManager
import com.decentstorage.app.wallet.AnchorStorageClient
import com.decentstorage.app.wallet.SolanaWallet
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/**
 * Roda 1x por dia (agendado via WorkManager, não um loop na Activity — assim continua
 * funcionando mesmo se o usuário fechar o app). Para cada shard que este dispositivo
 * ainda guarda fisicamente em disco (dataDir), gera um chunk_hash a partir do próprio
 * arquivo salvo e chama submit_paid_claim, cobrando a época corrente do vault.
 *
 * IMPORTANTE — placements.json: o app precisa persistir, junto de cada shard salvo, os
 * metadados de qual (placement PDA, fileVault PDA) aquele shard pertence — isso não
 * existia antes (só vivia em memória no GossipRegistry). Este worker assume um arquivo
 * `placements.json` dentro do dataDir no formato:
 *   [{"shardKey":"<fileId>_<idx>","placement":"<pda base58>","fileVault":"<pda base58>"}]
 * Se seu fluxo de upload/registro ainda não grava esse arquivo, adicione a gravação em
 * StorageClient.uploadFile / AnchorStorageClient.registerPlacement antes de confiar
 * neste worker em produção.
 *
 * A prova de Merkle real (merkle_proof) depende da árvore completa do shard, que também
 * precisa ser persistida no upload (hoje só o merkle_root vai para o contrato). Até isso
 * existir, este worker manda `merkleProof = emptyList()` — funciona apenas se o shard for
 * a única folha (árvore de 1 nível); para redundância k/n > 1 é preciso salvar a árvore
 * inteira no upload e reconstituir o caminho aqui.
 */
class DailyClaimWorker(appContext: Context, params: WorkerParameters) : CoroutineWorker(appContext, params) {

    companion object {
        private const val UNIQUE_WORK_NAME = "daily_claim"

        /** Chame uma vez, no início do app (ex: dentro de ensureEngineStarted). */
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
            if (!placementsFile.exists()) return Result.success() // nada registrado ainda

            val arr = org.json.JSONArray(placementsFile.readText())
            var failures = 0

            for (i in 0 until arr.length()) {
                val entry = arr.getJSONObject(i)
                try {
                    claimOne(entry, dataDir, anchorClient)
                } catch (e: Exception) {
                    failures++
                }
            }

            if (failures > 0 && failures == arr.length()) Result.retry() else Result.success()
        } catch (e: Exception) {
            Result.retry()
        }
    }

    private suspend fun claimOne(entry: JSONObject, dataDir: File, anchorClient: AnchorStorageClient) {
        val shardKey = entry.getString("shardKey")
        val placementPda = org.sol4k.PublicKey(entry.getString("placement"))
        val fileVaultPda = org.sol4k.PublicKey(entry.getString("fileVault"))

        val safe = shardKey.replace(Regex("[^a-zA-Z0-9_-]"), "")
        val shardFile = File(dataDir, "$safe.shard")
        if (!shardFile.exists()) return // não guardamos mais esse shard — não temos como provar posse, não reclama

        val chunkHash = sha256(shardFile.readBytes())

        anchorClient.submitPaidClaim(
            placement = placementPda,
            fileVault = fileVaultPda,
            chunkIndex = 0,
            chunkHash = chunkHash,
            merkleProof = emptyList() // ver nota de classe: só válido pra árvore de 1 folha
        )
    }
}
