package cv.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/**
 * Counts deals in a decrypted vault payload ({graph: {deals: [...]}}).
 * Lives in :core so the app never needs its own JSON stack.
 * Returns 0 for malformed/missing structures (fails toward "nothing loaded").
 */
fun countDeals(plainJson: String): Int {
    return try {
        val root = Json.parseToJsonElement(plainJson).jsonObject
        ((root["graph"] as? JsonObject)?.get("deals") as? JsonArray)?.size ?: 0
    } catch (_: Exception) {
        0
    }
}
