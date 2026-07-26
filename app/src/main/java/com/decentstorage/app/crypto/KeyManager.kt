package com.decentstorage.app.crypto

import io.github.novacrypto.bip39.MnemonicGenerator
import io.github.novacrypto.bip39.MnemonicValidator
import io.github.novacrypto.bip39.SeedCalculator
import io.github.novacrypto.bip39.Words
import io.github.novacrypto.bip39.wordlists.English
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Resolve o "a chave nunca pode depender só do app instalado": a chave mestra é
 * derivada de uma seed phrase de 12 palavras (BIP39), igual carteira cripto — e é
 * a MESMA seed usada pra derivar a wallet Solana (ver Slip10 + SolanaWallet). Ou seja,
 * uma única seed phrase recupera tanto o acesso aos arquivos quanto a wallet.
 *
 * NOTA DE DEPENDÊNCIA: usa io.github.novacrypto:BIP39 (verifique a versão mais recente
 * no Maven Central ao montar o projeto — API pode variar levemente entre versões).
 */
object KeyManager {

    data class Encrypted(val ciphertext: ByteArray, val iv: ByteArray, val authTag: ByteArray)

    fun generateSeedPhrase(): String {
        val entropy = ByteArray(16) // 128 bits -> 12 palavras
        SecureRandom().nextBytes(entropy)
        val sb = StringBuilder()
        MnemonicGenerator(English.INSTANCE).createMnemonic(entropy) { sb.append(it) }
        return sb.toString()
    }

    fun validateSeedPhrase(phrase: String): Boolean {
        return try {
            MnemonicValidator.ofWordList(English.INSTANCE).validate(normalize(phrase))
            true
        } catch (e: Exception) {
            false
        }
    }

    private fun normalize(seedPhrase: String): String =
        seedPhrase.trim().split(Regex("\\s+")).joinToString(" ")

    /** 64 bytes — usado tanto pra derivar a chave mestra AES quanto a seed da wallet Solana. */
    fun seedBytes(seedPhrase: String, passphrase: String = ""): ByteArray {
        val normalized = normalize(seedPhrase)
        require(validateSeedPhrase(normalized)) { "Seed phrase inválida" }
        return SeedCalculator().calculateSeed(normalized, passphrase)
    }

    /** Chave mestra AES-256 (32 bytes), derivada da seed via SHA-256 — mesma lógica do keyManager.js. */
    fun deriveMasterKey(seedPhrase: String, passphrase: String = ""): ByteArray {
        val seed = seedBytes(seedPhrase, passphrase)
        return MessageDigest.getInstance("SHA-256").digest(seed)
    }

    /** Deriva uma chave por-arquivo a partir da chave mestra + id do arquivo (HMAC, igual ao JS). */
    fun deriveFileKey(masterKey: ByteArray, fileId: String): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(masterKey, "HmacSHA256"))
        return mac.doFinal(fileId.toByteArray(Charsets.UTF_8))
    }

    /**
     * Cifra com AES-256-GCM. A cifragem acontece no dispositivo do dono, ANTES de
     * qualquer shard sair do aparelho — quem armazena o shard nunca vê o conteúdo em claro.
     */
    fun encryptBuffer(data: ByteArray, key: ByteArray): Encrypted {
        val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        val out = cipher.doFinal(data) // ciphertext + authTag(16) concatenados pelo JCE
        val ciphertext = out.copyOfRange(0, out.size - 16)
        val authTag = out.copyOfRange(out.size - 16, out.size)
        return Encrypted(ciphertext, iv, authTag)
    }

    fun decryptBuffer(enc: Encrypted, key: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, enc.iv))
        val combined = enc.ciphertext + enc.authTag
        return cipher.doFinal(combined)
    }

    fun fileIdFor(fileName: String): String {
        val random = ByteArray(8).also { SecureRandom().nextBytes(it) }
        val randomHex = random.joinToString("") { "%02x".format(it) }
        return MessageDigest.getInstance("SHA-256")
            .digest("$fileName:$randomHex".toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
    }
}
