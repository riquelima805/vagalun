package com.decentstorage.app.network

import android.content.Context
import android.util.Base64
import net.i2p.crypto.eddsa.EdDSAEngine
import net.i2p.crypto.eddsa.EdDSAPrivateKey
import net.i2p.crypto.eddsa.EdDSAPublicKey
import net.i2p.crypto.eddsa.spec.EdDSANamedCurveTable
import net.i2p.crypto.eddsa.spec.EdDSAPrivateKeySpec
import net.i2p.crypto.eddsa.spec.EdDSAPublicKeySpec
import org.sol4k.Base58
import java.security.SecureRandom

/**
 * Identidade Ed25519 local do app-browser, gerada e guardada na primeira
 * execução (SharedPreferences, mesmo arquivo de prefs do nodeId em
 * BrowserActivity). NÃO é a wallet Solana do usuário — é só um par de
 * chaves descartável, criado localmente, só pra provar posse do próprio
 * nodeId no `register` do signaling, exatamente como o app-node já faz
 * (sever/server.js exige pubkey+sig em toda conexão não-infra desde o
 * patch anti-hijack de nodeId).
 *
 * Sem exigir NENHUMA mudança no signaling server: ele já aceita qualquer
 * pubkey Ed25519 válida como "dona" do nodeId — não precisa ser
 * especificamente a wallet do usuário, só precisa ser consistente (a
 * mesma chave sempre, pra não perder a posse do nodeId entre sessões).
 */
object NodeIdentity {
    private const val PREFS_NAME = "vagalun_browser"
    private const val KEY_SEED = "ed25519_seed_b64"

    private val spec = EdDSANamedCurveTable.getByName(EdDSANamedCurveTable.ED_25519)

    data class Identity(val pubkeyBase58: String, val sign: (ByteArray) -> ByteArray)

    fun load(context: Context): Identity {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val seed = prefs.getString(KEY_SEED, null)?.let { Base64.decode(it, Base64.NO_WRAP) }
            ?: ByteArray(32).also {
                SecureRandom().nextBytes(it)
                prefs.edit().putString(KEY_SEED, Base64.encodeToString(it, Base64.NO_WRAP)).apply()
            }

        val privSpec = EdDSAPrivateKeySpec(seed, spec)
        val privKey = EdDSAPrivateKey(privSpec)
        val pubSpec = EdDSAPublicKeySpec(privSpec.a, spec)
        val pubKey = EdDSAPublicKey(pubSpec)
        val pubkeyBase58 = Base58.encode(pubKey.abyte)

        val sign: (ByteArray) -> ByteArray = { message ->
            val engine = EdDSAEngine()
            engine.initSign(privKey)
            engine.update(message)
            engine.sign()
        }

        return Identity(pubkeyBase58, sign)
    }
}
