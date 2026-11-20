package cv.core

import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Test

class PairingTest {
    private fun encode(json: String): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(json.toByteArray(Charsets.UTF_8))

    // Real production shape from web/src/ui/sync.ts:
    // b64url(JSON.stringify({wsId, key: <b64u JWK string>})).
    private val jwkJson32 =
        """{"kty":"oct","alg":"A256GCM","k":"${Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32) { it.toByte() })}"}"""

    private fun productionPairing(wsId: String = "ws-1"): String =
        encode("""{"wsId":"$wsId","key":"${Base64.getUrlEncoder().withoutPadding().encodeToString(jwkJson32.toByteArray(Charsets.UTF_8))}"}""")

    @Test
    fun `production pairing round trips into a real AES-256 key`() {
        val parsed = Pairing.parse(productionPairing())
        assertEquals("ws-1", parsed.wsId)
        // Full chain: jwkJson() decodes the base64url key string into JWK JSON the
        // crypto layer accepts (32-byte AES-256):
        VaultCrypto.importKeyJwk(parsed.jwkJson()) // must not throw
    }

    @Test(expected = IllegalArgumentException::class)
    fun `key-as-object (wrong format) is rejected`() {
        // Guards F1 regression: JWK object instead of the web's base64url string.
        Pairing.parse(encode("""{"wsId":"ws-1","key":{"kty":"oct","k":"AAA","alg":"A256GCM"}}"""))
    }

    @Test(expected = IllegalArgumentException::class) fun `empty string rejected`() {
        Pairing.parse("")
    }

    @Test(expected = IllegalArgumentException::class) fun `invalid base64 rejected`() {
        Pairing.parse("!!!not-base64!!!")
    }

    @Test(expected = IllegalArgumentException::class) fun `missing wsId rejected`() {
        Pairing.parse(encode("""{"key":"AAAA"}"""))
    }

    @Test(expected = IllegalArgumentException::class) fun `missing key rejected`() {
        Pairing.parse(encode("""{"wsId":"ws-1"}"""))
    }

    @Test(expected = IllegalArgumentException::class) fun `wsId violating rules pattern rejected`() {
        Pairing.parse(encode("""{"wsId":"bad/../id","key":"AAAA"}"""))
    }

    @Test(expected = IllegalArgumentException::class) fun `wsId too long rejected`() {
        Pairing.parse(encode("""{"wsId":"${"a".repeat(129)}","key":"AAAA"}"""))
    }

    @Test(expected = IllegalArgumentException::class) fun `key with non-base64url chars rejected`() {
        Pairing.parse(encode("""{"wsId":"ws-1","key":"not!base64"}"""))
    }
}

class GraphSummaryTest {
    @Test fun `counts follow KnowledgeGraph contract (F2)`() {
        val json = """{"graph":{"ventures":["a","b"],"partners":["p"],"products":["x","y","z"],"dealRules":["r"]},"tokenMap":{}}"""
        assertEquals(GraphCounts(ventures = 2, partners = 1, products = 3, dealRules = 1), summarizeGraph(json))
    }

    @Test fun `malformed or missing structures count as zero`() {
        assertEquals(GraphCounts(0, 0, 0, 0), summarizeGraph("""{"graph":{}}"""))
        assertEquals(GraphCounts(0, 0, 0, 0), summarizeGraph("""{"other":1}"""))
        assertEquals(GraphCounts(0, 0, 0, 0), summarizeGraph("not json"))
    }
}
