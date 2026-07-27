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

/**
 * Wallet Solana real (não custodial). A chave privada da wallet é derivada da MESMA
 * seed phrase de 12 palavras que protege os arquivos — path SLIP-0010 padrão
 * m/44'/501'/0'/0', igual Phantom/Solflare, então importar a seed em qualquer
 * carteira compatível mostra o mesmo endereço.
 *
 * NOTA DE DEPENDÊNCIA: usa net.i2p.crypto:eddsa (biblioteca Ed25519 pura Java,
 * amplamente usada — ex: pela SolanaKT) só pra expandir seed(32 bytes) -> par de
 * chaves Ed25519, porque sol4k não expõe derivação BIP39/SLIP10 diretamente
 * (ele trabalha com o secretKey de 64 bytes já pronto).
 */
class SolanaWallet private constructor(
    val keypair: Keypair,
    val connection: Connection
) {
    val publicKey: PublicKey get() = keypair.publicKey

    companion object {
        /**
         * Deriva a wallet a partir da seed phrase (mesma usada no KeyManager).
         * rpcUrl: use o link da DEVNET pra testes, troque pra mainnet quando for produção.
         */
        fun fromSeedPhrase(
            seed64: ByteArray, 
            account: Int = 0, 
            rpcUrl: String = "https://api.devnet.solana.com" // CORRIGIDO: Passando a String diretamente
        ): SolanaWallet {
            val ed25519Seed = Slip10.deriveSolanaSeed(seed64, account) // 32 bytes
            val secretKey64 = expandEd25519Seed(ed25519Seed) // 64 bytes: seed(32) + pubkey(32)
            val keypair = Keypair.fromSecretKey(secretKey64)
            return SolanaWallet(keypair, Connection(rpcUrl))
        }

        /** nacl.sign.keyPair.fromSeed equivalente: expande seed(32) -> secretKey(64) = seed + pubkey. */
        private fun expandEd25519Seed(seed32: ByteArray): ByteArray {
            val spec = EdDSANamedCurveTable.getByName(EdDSANamedCurveTable.ED_25519)
            val privSpec = EdDSAPrivateKeySpec(seed32, spec)
            val priv = EdDSAPrivateKey(privSpec)
            val pub = priv.abyte // encoding padrão de chave pública Ed25519 (32 bytes)
            return seed32 + pub
        }
    }

    // CORRIGIDO: Adicionado o .toLong() no final para bater com o retorno da função
    suspend fun getBalanceLamports(): Long = connection.getBalance(publicKey).toLong()

    /**
     * Transfere SOL para outro endereço. Usado, por exemplo, pra pagar por um tier
     * de armazenamento pago (a lógica de "quanto cobrar por quanto espaço" deve
     * ficar no smart contract, não hardcoded aqui — ver contract/ no repositório).
     */
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
