package com.decentstorage.app.wallet

import net.i2p.crypto.eddsa.EdDSAPrivateKey
import net.i2p.crypto.eddsa.spec.EdDSANamedCurveTable
import net.i2p.crypto.eddsa.spec.EdDSAPrivateKeySpec
import org.sol4k.Connection
import org.sol4k.Keypair
import org.sol4k.PublicKey
import org.sol4k.TransactionMessage
import org.sol4k.VersionedTransaction
import org.sol4k.instruction.TransferInstruction


class SolanaWallet private constructor(
    val keypair: Keypair,
    val connection: Connection
) {
    val publicKey: PublicKey get() = keypair.publicKey

    companion object {
       
        fun fromSeedPhrase(
            seed64: ByteArray, 
            account: Int = 0, 
            rpcUrl: String = "https://api.devnet.solana.com" 
        ): SolanaWallet {
            val ed25519Seed = Slip10.deriveSolanaSeed(seed64, account)
            val secretKey64 = expandEd25519Seed(ed25519Seed) 
            val keypair = Keypair.fromSecretKey(secretKey64)
            return SolanaWallet(keypair, Connection(rpcUrl))
        }

        
        private fun expandEd25519Seed(seed32: ByteArray): ByteArray {
            val spec = EdDSANamedCurveTable.getByName(EdDSANamedCurveTable.ED_25519)
            val privSpec = EdDSAPrivateKeySpec(seed32, spec)
            val priv = EdDSAPrivateKey(privSpec)
            val pub = priv.abyte 
            return seed32 + pub
        }
    }

    
    suspend fun getBalanceLamports(): Long = connection.getBalance(publicKey).toLong()

    
    suspend fun transferSol(toAddress: String, lamports: Long): String {
        val blockhash = connection.getLatestBlockhash()
        val receiver = PublicKey(toAddress)
        val instruction = TransferInstruction(publicKey, receiver, lamports)
        val message = TransactionMessage.newMessage(publicKey, blockhash, instruction)
        val transaction = VersionedTransaction(message)
        transaction.sign(keypair)
        return connection.sendTransaction(transaction)
    }
}
