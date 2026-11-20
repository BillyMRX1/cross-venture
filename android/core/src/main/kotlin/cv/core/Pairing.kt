package cv.core

import java.util.Base64

/**
 * Parses the web app's pairing string: base64url (unpadded) of UTF-8 JSON
 * {"wsId": string, "key": {JWK}} — the same format produced by
 * web/src/crypto/vault.ts exportVaultKey + the Sync tab pairing generator.
 */
data class PairingData(val wsId: String, val keyJwkJson: String)

object Pairing {
    fun parse(pairString: String): PairingData {
        val trimmed = pairString.trim()
        require(trimmed.isNotEmpty()) { "pairing string is empty" }
        require(trimmed.all { it.isLetterOrDigit() || it == '-' || it == '_' }) {
            "pairing string is not base64url"
        }
        val json = try {
            String(Base64.getUrlDecoder().decode(trimmed), Charsets.UTF_8)
        } catch (e: IllegalArgumentException) {
            throw IllegalArgumentException("pairing string is not valid base64url", e)
        }
        val parsed = try {
            kotlinx.serialization.json.Json.parseToJsonElement(json)
                as? kotlinx.serialization.json.JsonObject
                ?: throw IllegalArgumentException("pairing payload is not a JSON object")
        } catch (e: IllegalArgumentException) {
            throw e
        } catch (e: Exception) {
            throw IllegalArgumentException("pairing payload is not valid JSON", e)
        }
        val wsId = (parsed["wsId"] as? kotlinx.serialization.json.JsonPrimitive)?.content
        require(!wsId.isNullOrBlank()) { "pairing payload missing wsId" }
        val key = parsed["key"] as? kotlinx.serialization.json.JsonObject
        requireNotNull(key) { "pairing payload missing key" }
        return PairingData(wsId = wsId, keyJwkJson = key.toString())
    }
}
