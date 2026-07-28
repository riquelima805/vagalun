package com.decentstorage.app.wallet

import org.sol4k.AccountMeta
import org.sol4k.Base58
import org.sol4k.Transaction
import org.sol4k.PublicKey
import org.sol4k.TransactionMessage
import org.sol4k.VersionedTransaction
import org.sol4k.instruction.BaseInstruction

class AnchorStorageClient(
    private val wallet: SolanaWallet,
    programIdBase58: String = "FPpM2qXfpddkNxuUNqoF2UZg7MJiwF4Un96EWKhVecS6",
    treasuryBase58: String = "DDE7RZCCbipWuBGwZLYszBQuMxvDSEF59225YoFzkFba"
) {
    private val programId = PublicKey(programIdBase58)
    private val programIdBytes = Base58.decode(programIdBase58)
    private val treasury = PublicKey(treasuryBase58)
    private val systemProgram = PublicKey("11111111111111111111111111111111111111111")

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
    fun freeContributionPda(provider: PublicKey, contentIdBytes32: ByteArray, shardIndex: Int): PublicKey =
        pda(listOf("free".toByteArray(), Base58.decode(provider.toBase58()), contentIdBytes32, byteArrayOf(shardIndex.toByte())))

    private suspend fun sendSingle(instructionData: ByteArray, accounts: List<AccountMeta>): String {
    return try {
        val instruction = BaseInstruction(instructionData, accounts, programId)
        val blockhash = wallet.connection.getLatestBlockhash()

        // Usa VersionedTransaction (mesma classe que já funciona no transferSol),
        // ao invés da classe legada Transaction, que tem um bug de buffer
        // que estoura quando a instrução tem várias contas (BufferOverflowException).
        val message = TransactionMessage.newMessage(wallet.publicKey, blockhash, instruction)
        val tx = VersionedTransaction(message)

        tx.sign(wallet.keypair)
        wallet.connection.sendTransaction(tx)

    } catch (e: Exception) {
        e.printStackTrace()
        "ERRO: ${e.message}"
    }
}
    
    suspend fun initAccount(): String {
        val data = PdaUtils.instructionDiscriminator("init_account")
        val accounts = listOf(
            AccountMeta.writable(userAccountPda()),
            AccountMeta.signerAndWritable(ownerPubkey()),
            AccountMeta.writable(systemProgram)
        )
        return sendSingle(data, accounts)
    }

    
    suspend fun purchaseTier(extraGb: Long): String {
        val payload = ByteArrayBuilder()
            .append(PdaUtils.instructionDiscriminator("purchase_tier"))
            .append(BorshWriter().writeU64(extraGb).toByteArray())
            .build()
        val accounts = listOf(
            AccountMeta.writable(userAccountPda()),
            AccountMeta.writable(marketConfigPda()),
            AccountMeta.signerAndWritable(ownerPubkey()),
            AccountMeta.writable(treasury),
            AccountMeta.writable(systemProgram)
        )
        return sendSingle(payload, accounts)
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
            AccountMeta.writable(systemProgram)
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
            AccountMeta.writable(systemProgram)
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
            AccountMeta.signerAndWritable(ownerPubkey()), // aqui "owner" = o provider assinando
            AccountMeta.writable(systemProgram)
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

   
    suspend fun registerFreeContribution(
        contentIdHex: String, shardIndex: Int, shardSizeBytes: Long, merkleRoot: ByteArray, provider: PublicKey
    ): String {
        val contentIdBytes = PdaUtils.fileIdHexToBytes32(contentIdHex)
        val payload = ByteArrayBuilder()
            .append(PdaUtils.instructionDiscriminator("register_free_contribution"))
            .append(contentIdBytes)
            .append(BorshWriter().writeU8(shardIndex).toByteArray())
            .append(BorshWriter().writeU64(shardSizeBytes).toByteArray())
            .append(merkleRoot)
            .build()
        val accounts = listOf(
            AccountMeta.writable(freeContributionPda(provider, contentIdBytes, shardIndex)),
            AccountMeta.signerAndWritable(ownerPubkey()),
            AccountMeta.writable(provider),
            AccountMeta.writable(systemProgram)
        )
        return sendSingle(payload, accounts)
    }

    suspend fun reportFreeTierProof(
        contribution: PublicKey, chunkIndex: Int, chunkHash: ByteArray, merkleProof: List<ByteArray>
    ): String {
        val payload = ByteArrayBuilder()
            .append(PdaUtils.instructionDiscriminator("report_free_tier_proof"))
            .append(BorshWriter().writeU32(chunkIndex).toByteArray())
            .append(chunkHash)
            .append(BorshWriter().writeVecOfFixedBytes(merkleProof).toByteArray())
            .build()
        val accounts = listOf(
            AccountMeta.writable(contribution),
            AccountMeta.writable(userAccountPda(ownerPubkey())),
            AccountMeta.writable(providerRecordPda(ownerPubkey())),
            AccountMeta.signerAndWritable(ownerPubkey()),
            AccountMeta.writable(systemProgram)
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
