import { generate } from '../hybrid';
import { findLeakedValues } from '../ui/util';
import type {
  AnonymizedChunk,
  DealRuleNode,
  DetectedSpan,
  KnowledgeGraph,
  PartnerNode,
  PayloadLogEntry,
  ProductNode,
  TokenMap,
  VentureNode,
} from '../types';

/**
 * The outbound prompt failed the pre-send privacy gate: a known real value
 * (from detection) appears verbatim in it. Fail closed — nothing was sent and
 * nothing was recorded as sent. The message names tokens and the local docName
 * only; raw values (partner names, amounts, ...) never appear in it.
 */
export class PayloadBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayloadBlockedError';
  }
}

const GRAPH_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    ventures: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          venture_id: { type: 'string' },
          venture_token: { type: 'string' },
          min_margin_pct_token: { type: 'string' },
        },
        required: ['venture_id', 'venture_token', 'min_margin_pct_token'],
      },
    },
    partners: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          partner_id: { type: 'string' },
          partner_token: { type: 'string' },
          venture_id: { type: 'string' },
          approval_rules: { type: 'string' },
        },
        required: ['partner_id', 'partner_token', 'venture_id', 'approval_rules'],
      },
    },
    products: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          sku_id: { type: 'string' },
          sku_token: { type: 'string' },
          venture_id: { type: 'string' },
          cogs_token: { type: 'string' },
          list_price_token: { type: 'string' },
        },
        required: ['sku_id', 'sku_token', 'venture_id', 'cogs_token', 'list_price_token'],
      },
    },
    dealRules: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          rule_id: { type: 'string' },
          venture_id: { type: 'string' },
          max_discount_pct_token: { type: 'string' },
          min_qty_condition: { type: 'string' },
          requires_partner_approval: { type: 'boolean' },
          source_doc_name: { type: 'string' },
          page_or_section: { type: 'string' },
          verbatim_blinded_excerpt: { type: 'string' },
        },
        required: [
          'rule_id',
          'venture_id',
          'max_discount_pct_token',
          'min_qty_condition',
          'requires_partner_approval',
          'source_doc_name',
          'page_or_section',
          'verbatim_blinded_excerpt',
        ],
      },
    },
  },
  required: ['ventures', 'partners', 'products', 'dealRules'],
} as const;

function asStr(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function normalizeVenture(raw: unknown): VentureNode {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    venture_id: asStr(r.venture_id),
    venture_token: asStr(r.venture_token),
    min_margin_pct_token: asStr(r.min_margin_pct_token),
  };
}

function normalizePartner(raw: unknown): PartnerNode {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    partner_id: asStr(r.partner_id),
    partner_token: asStr(r.partner_token),
    venture_id: asStr(r.venture_id),
    approval_rules: asStr(r.approval_rules),
  };
}

function normalizeProduct(raw: unknown): ProductNode {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    sku_id: asStr(r.sku_id),
    sku_token: asStr(r.sku_token),
    venture_id: asStr(r.venture_id),
    cogs_token: asStr(r.cogs_token),
    list_price_token: asStr(r.list_price_token),
  };
}

function normalizeDealRule(raw: unknown): DealRuleNode {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    rule_id: asStr(r.rule_id),
    venture_id: asStr(r.venture_id),
    max_discount_pct_token: asStr(r.max_discount_pct_token),
    min_qty_condition: asStr(r.min_qty_condition),
    requires_partner_approval: Boolean(r.requires_partner_approval),
    source_doc_name: asStr(r.source_doc_name),
    page_or_section: asStr(r.page_or_section),
    verbatim_blinded_excerpt: asStr(r.verbatim_blinded_excerpt),
  };
}

function parseGraphResponse(rawText: string, aliasToDocName: Map<string, string>): KnowledgeGraph {
  const cleaned = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const parsed = JSON.parse(cleaned) as Record<string, unknown>;

  return {
    ventures: Array.isArray(parsed.ventures) ? parsed.ventures.map(normalizeVenture) : [],
    partners: Array.isArray(parsed.partners) ? parsed.partners.map(normalizePartner) : [],
    products: Array.isArray(parsed.products) ? parsed.products.map(normalizeProduct) : [],
    dealRules: Array.isArray(parsed.dealRules)
      ? parsed.dealRules.map(normalizeDealRule).map((rule) => ({
          ...rule,
          // Restore the real filename locally; unknown values are left untouched (never guessed).
          source_doc_name: aliasToDocName.get(rule.source_doc_name.trim()) ?? rule.source_doc_name,
        }))
      : [],
  };
}

function formatChunkLine(chunk: AnonymizedChunk, bodyText: string, docLabel: string): string {
  return `[${docLabel} p.${chunk.page} #${chunk.index}] ${bodyText}`;
}

function rehydrateChunkText(text: string, detected: DetectedSpan[]): string {
  let out = text;
  for (const span of detected) {
    if (span.token) {
      out = out.split(span.token).join(span.text);
    }
  }
  return out;
}

function buildPrompt(chunks: AnonymizedChunk[], tokenLegend: string, alias: string): string {
  const instructions = [
    'Extract a structured deal knowledge graph from the BLINDED document chunks below.',
    'All sensitive entities have been replaced with bracketed placeholder tokens such as [VENTURE_1], [PARTNER_1], [SKU_1], [COST_1], [PRICE_1], [DISCOUNT_CAP_1], [MARGIN_FLOOR_1].',
    'Treat tokens as opaque identifiers. Do NOT attempt to guess, infer, or reveal real-world identities or raw values.',
    'Preserve exact token strings in *_token fields and in verbatim_blinded_excerpt.',
    'Link partners, products, and dealRules to their parent venture via venture_id.',
    'Documents are identified only by neutral aliases such as DOC_1. In source_doc_name, cite the exact alias shown in the chunk header (e.g. DOC_1).',
  ].join('\n');

  const body = chunks.map((c) => formatChunkLine(c, c.text, alias)).join('\n\n');
  const legendBlock = tokenLegend.trim() ? `Token Legend:\n${tokenLegend.trim()}\n\n` : '';
  return `${instructions}\n\n${legendBlock}Blinded Chunks:\n${body}`;
}

/**
 * Synthesizes a KnowledgeGraph from already-blinded chunks via one cloud call per document group.
 * Records the exact outbound prompt in payloadLog alongside local-only rehydrated text.
 * CV-SEC-2 (2026-11-20): every prompt passes a fail-closed pre-send gate (no known
 * real value may appear verbatim), and each payload entry is recorded BEFORE the
 * request — so a failed cloud call still leaves an honest 'attempted' record.
 * onPayload lets callers persist entries as they are recorded, surviving a later throw.
 */
export async function synthesizeGraph(
  blinded: AnonymizedChunk[],
  tokenLegend: string,
  onPayload?: (entry: PayloadLogEntry) => void,
  onRetryNotice?: (attempt: number, waitMs: number, kind: string) => void
): Promise<{ graph: KnowledgeGraph; payloadLog: PayloadLogEntry[] }> {
  const groups = new Map<string, AnonymizedChunk[]>();
  for (const chunk of blinded) {
    const existing = groups.get(chunk.docName);
    if (existing) {
      existing.push(chunk);
    } else {
      groups.set(chunk.docName, [chunk]);
    }
  }

  const merged: KnowledgeGraph = {
    ventures: [],
    partners: [],
    products: [],
    dealRules: [],
  };
  const payloadLog: PayloadLogEntry[] = [];

  // Known real values from detection (local-only source of truth). None of them
  // may appear verbatim in an outbound prompt — enforced before every send.
  // Distinct values sharing a token are ALL kept (suffixed keys), so no value
  // silently overwrites another (CV-SEC-2 review F1).
  const knownValues: TokenMap = {};
  for (const chunk of blinded) {
    for (const span of chunk.detected) {
      if (span.text.trim().length === 0) continue;
      if (!(span.token in knownValues)) {
        knownValues[span.token] = span.text;
      } else if (knownValues[span.token] !== span.text) {
        knownValues[`${span.token}#${Object.keys(knownValues).length}`] = span.text;
      }
    }
  }

  // Deterministic aliases by first appearance order; filenames never leave the device.
  let aliasCounter = 0;
  for (const [docName, chunks] of groups) {
    aliasCounter += 1;
    const alias = `DOC_${aliasCounter}`;
    const prompt = buildPrompt(chunks, tokenLegend, alias);

    const { hits: leaks } = findLeakedValues(knownValues, prompt, `pre-send ${alias}`);
    if (leaks.length > 0) {
      const tokens = [...new Set(leaks.map((h) => h.token.replace(/#\d+$/, '')))].sort().join(', ');
      throw new PayloadBlockedError(
        `Payload blocked before sending ${alias} (${docName}): prompt contained known values for ${tokens}. Nothing was sent.`,
      );
    }

    const entries: PayloadLogEntry[] = chunks.map((chunk) => ({
      docName: chunk.docName,
      page: chunk.page,
      localText: formatChunkLine(chunk, rehydrateChunkText(chunk.text, chunk.detected), chunk.docName),
      cloudText: prompt,
      sentAt: Date.now(),
      status: 'attempted' as const,
    }));
    for (const entry of entries) {
      payloadLog.push(entry);
      onPayload?.(entry);
    }

    const result = await generate('synthesize', prompt, GRAPH_RESPONSE_SCHEMA, { onRetry: onRetryNotice });
    const receivedAt = Date.now();
    for (const entry of entries) {
      entry.status = 'responded';
      entry.receivedAt = receivedAt;
    }
    const docGraph = parseGraphResponse(result.text, new Map([[alias, docName]]));

    merged.ventures.push(...docGraph.ventures);
    merged.partners.push(...docGraph.partners);
    merged.products.push(...docGraph.products);
    merged.dealRules.push(...docGraph.dealRules);
  }

  return { graph: merged, payloadLog };
}
