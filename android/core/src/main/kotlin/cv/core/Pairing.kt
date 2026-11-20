package cv.core

import java.util.Base64
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Parses the web app's pairing string exactly as web/src/ui/sync.ts builds it:
 * b64url( JSON.stringify({ wsId, key: <base64url JWK string from exportVaultKey> }) ).
 * The key field is a STRING (not a JWK object) — F1 (review 2026-11-20).
 */
data class PairingData(val wsId: String, val keyB64Url: String) {
    /** Decodes the base64url JWK string into JWK JSON for VaultCrypto.importKeyJwk. */
    fun jwkJson(): String = String(VaultCrypto.decodeBase64Url(keyB64Url), Charsets.UTF_8)
}

object Pairing {
    private val WS_ID_RE = Regex("^[A-Za-z0-9_-]{1,128}$") // matches firestore.rules validEnvelope

    fun parse(pairString: String): PairingData {
        val trimmed = pairString.trim()
        require(trimmed.isNotEmpty()) { "pairing string is empty" }
        // ASCII-only base64url charset (Char.isLetterOrDigit() is Unicode-wide — F5).
        require(trimmed.all { it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '-' || it == '_' }) {
            "pairing string is not base64url"
        }
        val json = try {
            String(Base64.getUrlDecoder().decode(trimmed), Charsets.UTF_8)
        } catch (e: IllegalArgumentException) {
            throw IllegalArgumentException("pairing string is not valid base64url", e)
        }
        val parsed = try {
            Json.parseToJsonElement(json) as? JsonObject
                ?: throw IllegalArgumentException("pairing payload is not a JSON object")
        } catch (e: IllegalArgumentException) {
            throw e
        } catch (e: Exception) {
            throw IllegalArgumentException("pairing payload is not valid JSON", e)
        }
        val wsIdPrim = parsed["wsId"] as? JsonPrimitive
        require(wsIdPrim != null && wsIdPrim.isString) { "pairing payload missing wsId" }
        val wsId = wsIdPrim.content
        require(WS_ID_RE.matches(wsId)) { "wsId fails the workspace id pattern" }
        val keyPrim = parsed["key"] as? JsonPrimitive
        require(keyPrim != null && keyPrim.isString && keyPrim.content.isNotEmpty()) {
            "pairing payload missing key"
        }
        require(keyPrim.content.all { it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '-' || it == '_' }) {
            "key is not base64url"
        }
        return PairingData(wsId = wsId, keyB64Url = keyPrim.content)
    }
}
