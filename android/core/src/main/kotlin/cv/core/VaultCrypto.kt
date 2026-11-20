package cv.core

import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

class CryptoException(message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * AES-256-GCM vault compatible with web/src/crypto/vault.ts:
 * - key: JWK {"kty":"oct","k":<base64url 32 bytes>,"alg":"A256GCM"}
 * - payload: iv (12 bytes, base64url) + cipher (base64url, GCM 128-bit tag appended)
 * Everything fails closed: malformed input or auth failure throws, never returns garbage.
 */
object VaultCrypto {
    fun decodeBase64Url(s: String): ByteArray {
        // Fail closed through the CryptoException contract (F4), not require().
        if (s.isEmpty()) throw CryptoException("empty base64url")
        if (s.any { it == '+' || it == '/' || it == '=' }) throw CryptoException("not base64url (unpadded)")
        return try {
            Base64.getUrlDecoder().decode(s)
        } catch (e: IllegalArgumentException) {
            throw CryptoException("invalid base64url input", e)
        }
    }

    fun importKeyJwk(jwkJson: String): SecretKeySpec {
        val obj = try {
            Json.parseToJsonElement(jwkJson) as? JsonObject
                ?: throw CryptoException("JWK is not a JSON object")
        } catch (e: CryptoException) {
            throw e
        } catch (e: Exception) {
            throw CryptoException("JWK is not valid JSON", e)
        }
        val kty = (obj["kty"] as? JsonPrimitive)?.content
        val alg = (obj["alg"] as? JsonPrimitive)?.content
        val k = (obj["k"] as? JsonPrimitive)?.content
        if (kty != "oct") throw CryptoException("JWK kty must be oct, got $kty")
        if (alg != "A256GCM") throw CryptoException("JWK alg must be A256GCM, got $alg")
        if (k.isNullOrEmpty()) throw CryptoException("JWK missing k")
        val bytes = decodeBase64Url(k)
        if (bytes.size != 32) throw CryptoException("AES-256 key must be 32 bytes, got ${bytes.size}")
        return SecretKeySpec(bytes, "AES")
    }

    fun decryptJson(key: SecretKeySpec, ivB64Url: String, cipherB64Url: String): String {
        val iv = decodeBase64Url(ivB64Url)
        if (iv.size != 12) throw CryptoException("IV must be 12 bytes, got ${iv.size}")
        val cipherBytes = decodeBase64Url(cipherB64Url)
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv))
            String(cipher.doFinal(cipherBytes), Charsets.UTF_8)
        } catch (e: Exception) {
            // GCM auth failure or bad input: fail closed, never return partial data.
            throw CryptoException("GCM decryption failed (auth or input)", e)
        }
    }
}
