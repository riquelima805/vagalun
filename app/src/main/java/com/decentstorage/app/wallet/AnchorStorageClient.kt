package com.decentstorage.app.wallet

import org.sol4k.AccountMeta
import org.sol4k.Base58
import org.sol4k.PublicKey
import org.sol4k.TransactionMessage
import org.sol4k.VersionedTransaction
import org.sol4k.instruction.BaseInstruction

class AnchorStorageClient(
    private val wallet: SolanaWallet,
    programIdBase58: String = "7CAZvZmgbUES9pzr9H1i1EDk7b1mjX2wib8JTVSt7kGk",
    treasuryBase58: String = "DDE7RZCCbipWuBGwZLYszBQuMxvDSEF59225YoFzkFba"
) {
    private val programId = PublicKey(programIdBase58)
    private val programIdBytes = Base58.decode(programIdBase58)
    private val treasury = PublicKey(treasuryBase58)
    private val systemProgram = PublicKey("11111111111111111111111111111111")

    private fun ownerPubkey(): PublicKey = wallet.publicKey
    private fun ownerBytes(): ByteArray = Base58.decode(wallet.publicKey.toBase58())

    private fun pda(seeds: List<ByteArray>): PublicKey {
        val (bytes, _bump) = PdaUtils.findProgramAddress(seeds, programIdBytes)
        return PublicKey(bytes)
    }

    fun marketConfigPda(): PublicKey = pda(listOf("market_config".toByteArray()))
    fun userAccountPda(owner: PublicKey = ownerPubkey()): PublicKey =
        pda(listOf("user".toByteArray(), Base58.decode(owner.toBase58())))
    fun fileVaultPda(fileIdBytes32: ByteArray): PublicKey =
        pda(listOf("vault".toByteArray(), fileIdBytes32))
    fun placementPda(fileVault: PublicKey, shardIndex: Int): PublicKey =
        pda(listOf("placement".toByteArray(), Base58.decode(fileVault.toBase58()), byteArrayOf(shardIndex.toByte())))
    fun providerRecordPda(provider: PublicKey): PublicKey =
        pda(listOf("provider_record".toByteArray(), Base58.decode(provider.toBase58())))

    // epoch_id como LE 8 bytes — precisa bater exatamente com `&epoch_id.to_le_bytes()`
    // do lado do programa (mesma convenção usada nas seeds ["epoch_root", epoch_id] e
    // ["claim", epoch_id, claimant] do lib.rs).
    private fun u64LeBytes(value: Long): ByteArray {
        require(value >= 0) { "epoch_id não pode ser negativo: $value" }
        val out = ByteArray(8)
        for (i in 0 until 8) out[i] = ((value ushr (8 * i)) and 0xFF).toByte()
        return out
    }

    fun epochRootPda(epochId: Long): PublicKey =
        pda(listOf("epoch_root".toByteArray(), u64LeBytes(epochId)))

    fun claimReceiptPda(epochId: Long, claimant: PublicKey = ownerPubkey()): PublicKey =
        pda(listOf("claim".toByteArray(), u64LeBytes(epochId), Base58.decode(claimant.toBase58())))

    private suspend fun sendSingle(instructionData: ByteArray, accounts: List<AccountMeta>): String {
        return try {
            val instruction = BaseInstruction(instructionData, accounts, programId)
            val blockhash = wallet.connection.getLatestBlockhash()

            val message = TransactionMessage.newMessage(wallet.publicKey, blockhash, instruction)
            val tx = VersionedTransaction(message)

            tx.sign(wallet.keypair)
            wallet.connection.sendTransaction(tx)

        } catch (e: Exception) {
            e.printStackTrace()
            "ERRO: ${e.message}"
        }
    }

    // ------------------------------------------------------------------
    // Bloco 1 — marketplace pago de armazenamento (escrow de SOL de quem
    // hospeda, drenado por prova de posse do shard). Continua igual.
    // ------------------------------------------------------------------

    // init_account ainda existe no lib.rs (seed "user") — mantido do contrato
    // anterior. purchase_tier / register_free_contribution / report_free_tier_proof
    // NÃO existem mais no programa atual (substituídos pelo fluxo de época/
    // claim_epoch abaixo) — por isso foram removidos daqui, chamá-los falharia
    // on-chain (discriminador de instrução desconhecido).
    suspend fun initAccount(): String {
        val data = PdaUtils.instructionDiscriminator("init_account")
        val accounts = listOf(
            AccountMeta.writable(userAccountPda()),
            AccountMeta.signerAndWritable(ownerPubkey()),
            AccountMeta(systemProgram, false, false)
        )
        return sendSingle(data, accounts)
    }

    suspend fun createFileVault(fileIdHex: String, shardSizeBytes: Long, k: Int, n: Int, days: Int): Pair<String, PublicKey> {
        val fileIdBytes = PdaUtils.fileIdHexToBytes32(fileIdHex)
        val vaultPda = fileVaultPda(fileIdBytes)
        val payload = ByteArrayBuilder()
            .append(PdaUtils.instructionDiscriminator("create_file_vault"))
            .append(fileIdBytes)
            .append(BorshWriter().writeU64(shardSizeBytes).toByteArray())
            .append(BorshWriter().writeU8(k).toByteArray())
            .append(BorshWriter().writeU8(n).toByteArray())
            .append(BorshWriter().writeU32(days).toByteArray())
            .build()
        val accounts = listOf(
            AccountMeta.writable(vaultPda),
            AccountMeta.writable(marketConfigPda()),
            AccountMeta.signerAndWritable(ownerPubkey()),
            AccountMeta(systemProgram, false, false)
        )
        val sig = sendSingle(payload, accounts)
        return sig to vaultPda
    }

    suspend fun registerPlacement(fileVault: PublicKey, shardIndex: Int, merkleRoot: ByteArray, provider: PublicKey): String {
        val payload = ByteArrayBuilder()
            .append(PdaUtils.instructionDiscriminator("register_placement"))
            .append(BorshWriter().writeU8(shardIndex).toByteArray())
            .append(merkleRoot)
            .build()
        val accounts = listOf(
            AccountMeta.writable(placementPda(fileVault, shardIndex)),
            AccountMeta.writable(fileVault),
            AccountMeta.signerAndWritable(ownerPubkey()),
            AccountMeta.writable(provider),
            AccountMeta(systemProgram, false, false)
        )
        return sendSingle(payload, accounts)
    }

    suspend fun submitPaidClaim(
        placement: PublicKey,
        fileVault: PublicKey,
        chunkIndex: Int,
        chunkHash: ByteArray,
        merkleProof: List<ByteArray>
    ): String {
        val payload = ByteArrayBuilder()
            .append(PdaUtils.instructionDiscriminator("submit_paid_claim"))
            .append(BorshWriter().writeU32(chunkIndex).toByteArray())
            .append(chunkHash)
            .append(BorshWriter().writeVecOfFixedBytes(merkleProof).toByteArray())
            .build()
        val accounts = listOf(
            AccountMeta.writable(placement),
            AccountMeta.writable(fileVault),
            AccountMeta.writable(providerRecordPda(ownerPubkey())),
            AccountMeta.signerAndWritable(ownerPubkey()),
            AccountMeta(systemProgram, false, false)
        )
        return sendSingle(payload, accounts)
    }

    suspend fun withdrawUnused(fileVault: PublicKey): String {
        val payload = PdaUtils.instructionDiscriminator("withdraw_unused")
        val accounts = listOf(
            AccountMeta.writable(fileVault),
            AccountMeta.signerAndWritable(ownerPubkey())
        )
        return sendSingle(payload, accounts)
    }

    // ------------------------------------------------------------------
    // Bloco 2 — payout de rede por época (uptime + banda + provas free-tier,
    // tudo já consolidado em pontos pelo backend e convertido numa raiz
    // merkle semanal). É o mesmo caminho pro celular e pro node de PC.
    // ------------------------------------------------------------------

    /**
     * Reivindica o payout da época `epochId`. `amountLamports` e `merkleProof`
     * vêm de `EpochPayoutClient.fetchProof(epochId, ownerPubkey)` — o app NUNCA
     * inventa esses valores, só repassa o que o backend devolveu pra essa
     * pubkey; se o valor ou a proof estiverem errados, `claim_epoch` rejeita
     * on-chain (raiz não bate), então não tem como o app "se pagar mais" nem
     * por bug nem por manipulação da resposta HTTP.
     *
     * Precisa ser assinado pela wallet PESSOAL do dono (`wallet` aqui), nunca
     * por uma chave efêmera só-de-heartbeat — é ela que tem SOL pra pagar o
     * gas dessa tx.
     */
    suspend fun claimEpoch(epochId: Long, amountLamports: Long, merkleProof: List<ByteArray>): String {
        val payload = ByteArrayBuilder()
            .append(PdaUtils.instructionDiscriminator("claim_epoch"))
            .append(BorshWriter().writeU64(epochId).toByteArray())
            .append(BorshWriter().writeU64(amountLamports).toByteArray())
            .append(BorshWriter().writeVecOfFixedBytes(merkleProof).toByteArray())
            .build()
        val accounts = listOf(
            AccountMeta.writable(epochRootPda(epochId)),
            AccountMeta.writable(claimReceiptPda(epochId)),
            AccountMeta.signerAndWritable(ownerPubkey()),
            AccountMeta(systemProgram, false, false)
        )
        return sendSingle(payload, accounts)
    }

    suspend fun requestDevnetAirdrop(lamports: Long = 1_000_000_000L): String =
        wallet.connection.requestAirdrop(wallet.publicKey, lamports)
}

private class ByteArrayBuilder {
    private val out = java.io.ByteArrayOutputStream()
    fun append(bytes: ByteArray): ByteArrayBuilder { out.write(bytes); return this }
    fun build(): ByteArray = out.toByteArray()
}
