package com.decentstorage.app.crypto

import org.web3j.crypto.MnemonicUtils
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

object KeyManager {

    data class Encrypted(val ciphertext: ByteArray, val iv: ByteArray, val authTag: ByteArray)

    fun generateSeedPhrase(): String {
        val entropy = ByteArray(16) 
        SecureRandom().nextBytes(entropy)
      
        return MnemonicUtils.generateMnemonic(entropy)
    }

    fun validateSeedPhrase(phrase: String): Boolean {
        return try {
            val normalized = normalize(phrase)
            val words = normalized.split(" ")
            if (words.size !in listOf(12, 15, 18, 21, 24)) return false
            
           
            MnemonicUtils.generateSeed(normalized, "")
            true
        } catch (e: Exception) {
            false
        }
    }

    private fun normalize(seedPhrase: String): String =
        seedPhrase.trim().split(Regex("\\s+")).joinToString(" ")

   
    fun seedBytes(seedPhrase: String, passphrase: String = ""): ByteArray {
        val normalized = normalize(seedPhrase)
        require(validateSeedPhrase(normalized)) { "Seed phrase inválida" }
      
        return MnemonicUtils.generateSeed(normalized, passphrase)
    }

  
    fun deriveMasterKey(seedPhrase: String, passphrase: String = ""): ByteArray {
        val seed = seedBytes(seedPhrase, passphrase)
        return MessageDigest.getInstance("SHA-256").digest(seed)
    }

   
    fun deriveFileKey(masterKey: ByteArray, fileId: String): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(masterKey, "HmacSHA256"))
        return mac.doFinal(fileId.toByteArray(Charsets.UTF_8))
    }

  
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
