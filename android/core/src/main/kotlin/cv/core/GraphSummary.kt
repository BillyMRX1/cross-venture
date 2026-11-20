package cv.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/**
 * Counts entities in a decrypted vault payload ({graph, tokenMap}).
 * Field names follow web/src/types.ts KnowledgeGraph:
 * {ventures: [], partners: [], products: [], dealRules: []} — F2 (review 2026-11-20).
 * Only counts are exposed: decrypted content must never be rendered or logged raw.
 */
data class GraphCounts(val ventures: Int, val partners: Int, val products: Int, val dealRules: Int)

fun summarizeGraph(plainJson: String): GraphCounts {
    return try {
        val root = Json.parseToJsonElement(plainJson).jsonObject
        val g = root["graph"] as? JsonObject ?: return GraphCounts(0, 0, 0, 0)
        fun size(key: String): Int = (g[key] as? JsonArray)?.size ?: 0
        GraphCounts(
            ventures = size("ventures"),
            partners = size("partners"),
            products = size("products"),
            dealRules = size("dealRules"),
        )
    } catch (_: Exception) {
        GraphCounts(0, 0, 0, 0)
    }
}
