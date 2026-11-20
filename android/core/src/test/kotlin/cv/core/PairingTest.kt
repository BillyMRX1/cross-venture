package cv.core

import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Test

class PairingTest {
    private fun encode(json: String): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(json.toByteArray(Charsets.UTF_8))

    @Test
    fun `valid pairing round trips`() {
        val json = """{"wsId":"ws-1","key":{"kty":"oct","k":"AAAAAAAAAAAAAAAAAAAAAA","alg":"A256GCM"}}"""
        val parsed = Pairing.parse(encode(json))
        assertEquals("ws-1", parsed.wsId)
        // key material round-trips into the JWK parser (32-byte check will reject the
        // 16-byte dummy, proving the JWK actually reached the parser):
        try {
            VaultCrypto.importKeyJwk(parsed.keyJwkJson)
            throw AssertionError("16-byte dummy key must be rejected")
        } catch (expected: CryptoException) {
            // JWK reached the crypto layer as expected
        }
    }

    @Test(expected = IllegalArgumentException::class) fun `empty string rejected`() {
        Pairing.parse("")
    }

    @Test(expected = IllegalArgumentException::class) fun `invalid base64 rejected`() {
        Pairing.parse("!!!not-base64!!!")
    }

    @Test(expected = IllegalArgumentException::class) fun `missing wsId rejected`() {
        Pairing.parse(encode("""{"key":{"kty":"oct","k":"AAA","alg":"A256GCM"}}"""))
    }

    @Test(expected = IllegalArgumentException::class) fun `missing key rejected`() {
        Pairing.parse(encode("""{"wsId":"ws-1"}"""))
    }

    @Test(expected = IllegalArgumentException::class) fun `blank wsId rejected`() {
        Pairing.parse(encode("""{"wsId":"  ","key":{"kty":"oct","k":"AAA","alg":"A256GCM"}}"""))
    }
}

class GraphSummaryTest {
    @Test fun `counts deals in graph payload`() {
        assertEquals(2, countDeals("""{"graph":{"deals":["a","b"]}}"""))
        assertEquals(1, countDeals("""{"graph":{"deals":["a"]}}"""))
    }

    @Test fun `malformed or missing structures count as zero`() {
        assertEquals(0, countDeals("""{"graph":{}}"""))
        assertEquals(0, countDeals("""{"other":1}"""))
        assertEquals(0, countDeals("not json"))
    }
}
