package cv.core

import java.io.InputStreamReader
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Web-vault interop: decrypts real AES-256-GCM payloads generated with the
 * web app's exact semantics (node webcrypto, base64url unpadded) from
 * src/test/resources/vectors.json. A missing fixture file FAILS (F7):
 * silent skips would let crypto regressions pass CI.
 */
class VaultInteropTest {
    private fun vectorsRoot(): JsonObject {
        val stream = javaClass.classLoader.getResourceAsStream("vectors.json")
            ?: throw AssertionError("vectors.json fixture missing")
        return stream.use {
            Json.parseToJsonElement(InputStreamReader(it, Charsets.UTF_8).readText()) as JsonObject
        }
    }

    @Test
    fun `web-generated vectors decrypt byte-exactly`() {
        val vectors = vectorsRoot()["vectors"] as JsonArray
        assertEquals(2, vectors.size)
        for (v in vectors) {
            val o = v.jsonObject
            val name = (o["name"] as JsonPrimitive).content
            val key = VaultCrypto.importKeyJwk(o["keyJwk"]!!.toString())
            val iv = (o["ivB64Url"] as JsonPrimitive).content
            val cipher = (o["cipherB64Url"] as JsonPrimitive).content
            val plain = (o["plainJson"] as JsonPrimitive).content
            val decrypted = VaultCrypto.decryptJson(key, iv, cipher)
            assertEquals("$name:", plain, decrypted)
            if (name == "v1") {
                assertEquals(GraphCounts(1, 1, 1, 1), summarizeGraph(decrypted))
            }
        }
    }

    @Test
    fun `tampered ciphertext fails closed`() {
        val v = (vectorsRoot()["vectors"] as JsonArray)[0].jsonObject
        val key = VaultCrypto.importKeyJwk(v["keyJwk"]!!.toString())
        val iv = (v["ivB64Url"] as JsonPrimitive).content
        val cipher = (v["cipherB64Url"] as JsonPrimitive).content
        val bytes = VaultCrypto.decodeBase64Url(cipher)
        bytes[0] = (bytes[0].toInt() xor 0x01).toByte()
        val tampered = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
        try {
            VaultCrypto.decryptJson(key, iv, tampered)
            throw AssertionError("tampered ciphertext must not decrypt")
        } catch (expected: CryptoException) {
            // fail closed as required
        }
    }
}
