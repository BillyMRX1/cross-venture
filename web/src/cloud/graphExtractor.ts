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

function buildPrompt(
  entries: Array<{ chunk: AnonymizedChunk; alias: string }>,
  tokenLegend: string,
): string {
  const instructions = [
    'Extract a structured deal knowledge graph from the BLINDED document chunks below. They may come from several documents.',
    'All sensitive entities have been replaced with bracketed placeholder tokens such as [VENTURE_1], [PARTNER_1], [SKU_1], [COST_1], [PRICE_1], [DISCOUNT_CAP_1], [MARGIN_FLOOR_1].',
    'Treat tokens as opaque identifiers. Do NOT attempt to guess, infer, or reveal real-world identities or raw values.',
    'Preserve exact token strings in *_token fields and in verbatim_blinded_excerpt.',
    'Link partners, products, and dealRules to their parent venture via venture_id.',
    'Documents are identified only by neutral aliases such as DOC_1; every chunk header names its document alias. In source_doc_name, cite the exact alias shown in that chunk\'s header (e.g. DOC_2).',
  ].join('\n');

  const body = entries.map((e) => formatChunkLine(e.chunk, e.chunk.text, e.alias)).join('\n\n');
  const legendBlock = tokenLegend.trim() ? `Token Legend:\n${tokenLegend.trim()}\n\n` : '';
  return `${instructions}\n\n${legendBlock}Blinded Chunks:\n${body}`;
}

/**
 * Size cap (combined blinded chunk characters) for one cloud call.
 * Left at 16,000 characters by design (numbers-backed):
 * - Input context is not the limit: Gemini Flash accepts ~1M tokens (~4M chars),
 *   so even five 27k-char contracts (~135k chars ≈ 34k tokens) fit in input.
 * - Output size, per-call latency, and retry blast radius ARE the limits:
 *   each 11–27k-char blinded contract (~3–7k input tokens) produces ~10–30
 *   structured deal rules with verbatim blinded excerpts (~3–6k chars /
 *   ~800–1,500 output tokens of JSON) and takes ~20–40s to generate. Packing
 *   two ~20k contracts into one ~40k prompt roughly doubles output generation
 *   time, raises the risk of JSON truncation near default output limits (~8k
 *   tokens), eliminates parallelism across the 3-slot pool, and turns a single
 *   transient failure into two lost contracts instead of one.
 * - At 16,000 chars: small sample/demo corpora (~10k total across 4 docs) still
 *   pack into 1 call, while large real contracts (11–27k chars each) stay at
 *   1 contract per call and run concurrently in the 3-slot pool with isolated
 *   per-document retry.
 * Whole documents only: one document is NEVER split across two calls, and a
 * document larger than the cap keeps its own call.
 */
const MAX_COMBINED_CHUNK_CHARS = 16000;

/** Default concurrent cloud synthesis pool size (single source of truth). */
export const SYNTHESIZE_CONCURRENCY = 3;

/** One planned cloud call, known locally BEFORE anything is sent. */
export interface SynthesizeCallProgress {
  call: number; // 1-based index of this call
  totalCalls: number; // planned calls for this run
  docNames: string[]; // documents packed into this call (local names only)
}

/** Live pool progress emitted as calls start and finish concurrently. */
export interface SynthesizePoolProgress {
  totalCalls: number;
  inFlight: number;
  done: number;
  failed: number;
  activeDocNames: string[]; // local names of documents currently in flight
  lastEvent: 'started' | 'succeeded' | 'failed';
  call: number; // 1-based index of the call that triggered this update
  docNames: string[];
}

/** Details for a batch that still failed after bounded retries. */
export interface SynthesizeBatchFailure {
  call: number; // 1-based index of the failed batch
  docNames: string[]; // local names of documents in the failed batch
  chunks: AnonymizedChunk[]; // exact blinded chunks for one-click document retry
  error: unknown;
  message: string;
}

export interface SynthesizeOptions {
  /** Override the default pool size (SYNTHESIZE_CONCURRENCY = 3). */
  concurrency?: number;
  /**
   * When true, non-gate batch errors are returned in `failures` while the other
   * calls still finish and merge into `graph`. Privacy-gate blocks
   * (PayloadBlockedError) always throw fail-closed.
   */
  allowPartial?: boolean;
  /** Extra known real values (e.g. full workspace tokenMap) checked by the pre-send gate on single-doc retries. */
  extraKnownValues?: TokenMap;
  /** Live pool progress (calls in flight and done). */
  onPoolProgress?: (progress: SynthesizePoolProgress) => void;
  /** Per-batch retry notice identifying which documents are waiting on backoff. */
  onBatchRetry?: (info: { call: number; docNames: string[]; attempt: number; waitMs: number; kind: string }) => void;
}

export interface SynthesizeResult {
  graph: KnowledgeGraph;
  payloadLog: PayloadLogEntry[];
  usedModels: string[];
  failures: SynthesizeBatchFailure[];
  /** Per-batch graphs indexed by batch position (null when that batch failed). */
  batchGraphs: Array<KnowledgeGraph | null>;
}

/** Merge multiple KnowledgeGraph fragments in exact array order. */
export function mergeKnowledgeGraphs(graphs: KnowledgeGraph[]): KnowledgeGraph {
  const merged: KnowledgeGraph = {
    ventures: [],
    partners: [],
    products: [],
    dealRules: [],
  };
  for (const g of graphs) {
    merged.ventures.push(...g.ventures);
    merged.partners.push(...g.partners);
    merged.products.push(...g.products);
    merged.dealRules.push(...g.dealRules);
  }
  return merged;
}

/**
 * Synthesizes a KnowledgeGraph from already-blinded chunks via concurrent cloud
 * calls (pool size SYNTHESIZE_CONCURRENCY = 3) that pack WHOLE documents up to
 * MAX_COMBINED_CHUNK_CHARS combined blinded characters (a document is never
 * split across calls; an over-cap document keeps its own call). Results are
 * merged in deterministic document order regardless of completion order.
 * Records the exact outbound prompt in payloadLog per chunk alongside
 * local-only rehydrated text.
 * CV-SEC-2 (2026-11-20): every prompt — the EXACT batched string about to be
 * sent, whatever the batching — passes a fail-closed pre-send gate (no known
 * real value may appear verbatim) BEFORE any generate() call, and each payload
 * entry is recorded BEFORE the request — so a failed cloud call still leaves
 * an honest 'attempted' record. A blocked batch sends nothing at all.
 * onPayload lets callers persist entries as they are recorded, surviving a later throw.
 * onCallProgress reports each planned call (call number, total, document
 * names) before it starts, so the UI can show honest per-call progress.
 */
export async function synthesizeGraph(
  blinded: AnonymizedChunk[],
  tokenLegend: string,
  onPayload?: (entry: PayloadLogEntry) => void,
  onRetryNotice?: (attempt: number, waitMs: number, kind: string) => void,
  onCallProgress?: (progress: SynthesizeCallProgress) => void,
  options?: SynthesizeOptions,
): Promise<SynthesizeResult> {
  const groups = new Map<string, AnonymizedChunk[]>();
  for (const chunk of blinded) {
    const existing = groups.get(chunk.docName);
    if (existing) {
      existing.push(chunk);
    } else {
      groups.set(chunk.docName, [chunk]);
    }
  }

  // Deterministic aliases by first appearance order; filenames never leave the device.
  const docs = [...groups.entries()].map(([docName, chunks], i) => ({
    docName,
    alias: `DOC_${i + 1}`,
    chunks,
    chars: chunks.reduce((n, c) => n + c.text.length, 0),
  }));

  // Pack whole documents into batches (see MAX_COMBINED_CHUNK_CHARS). A
  // document is never split; an over-cap document still stands alone.
  const batches: (typeof docs)[] = [];
  let current: typeof docs = [];
  let currentChars = 0;
  for (const doc of docs) {
    if (current.length > 0 && currentChars + doc.chars > MAX_COMBINED_CHUNK_CHARS) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(doc);
    currentChars += doc.chars;
  }
  if (current.length > 0) batches.push(current);

  const merged: KnowledgeGraph = {
    ventures: [],
    partners: [],
    products: [],
    dealRules: [],
  };
  const payloadLog: PayloadLogEntry[] = [];
  const usedModels = new Set<string>();

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
  if (options?.extraKnownValues) {
    for (const [token, value] of Object.entries(options.extraKnownValues)) {
      if (value.trim().length === 0) continue;
      if (!(token in knownValues)) {
        knownValues[token] = value;
      } else if (knownValues[token] !== value) {
        knownValues[`${token}#${Object.keys(knownValues).length}`] = value;
      }
    }
  }

  const batchGraphs: Array<KnowledgeGraph | null> = new Array(batches.length).fill(null);
  const batchModels: Array<string | null> = new Array(batches.length).fill(null);
  const batchPayloads: PayloadLogEntry[][] = Array.from({ length: batches.length }, () => []);
  const batchFailures: Array<SynthesizeBatchFailure | null> = new Array(batches.length).fill(null);
  let blockedError: PayloadBlockedError | null = null;

  const activeCalls = new Map<number, string[]>();
  let doneCount = 0;
  let failedCount = 0;

  function emitPoolProgress(lastEvent: SynthesizePoolProgress['lastEvent'], idx: number, docNames: string[]): void {
    options?.onPoolProgress?.({
      totalCalls: batches.length,
      inFlight: activeCalls.size,
      done: doneCount,
      failed: failedCount,
      activeDocNames: [...activeCalls.entries()]
        .sort((a, b) => a[0] - b[0])
        .flatMap(([, names]) => names),
      lastEvent,
      call: idx + 1,
      docNames,
    });
  }

  const poolSize = Math.max(1, Math.min(options?.concurrency ?? SYNTHESIZE_CONCURRENCY, batches.length));
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      if (blockedError) return;
      const i = nextIndex++;
      if (i >= batches.length) return;

      const batch = batches[i];
      const batchDocNames = batch.map((d) => d.docName);
      const prompt = buildPrompt(
        batch.flatMap((doc) => doc.chunks.map((chunk) => ({ chunk, alias: doc.alias }))),
        tokenLegend,
      );
      onCallProgress?.({ call: i + 1, totalCalls: batches.length, docNames: batchDocNames });

      try {
        // The gate scans the EXACT batched prompt that will be sent — nothing is
        // sent, and nothing is recorded, if any known value appears anywhere in it.
        const aliasList = batch.map((d) => d.alias).join(', ');
        const docList = batch.map((d) => d.docName).join(', ');
        const { hits: leaks } = findLeakedValues(knownValues, prompt, `pre-send ${aliasList}`);
        if (leaks.length > 0) {
          const tokens = [...new Set(leaks.map((h) => h.token.replace(/#\d+$/, '')))].sort().join(', ');
          throw new PayloadBlockedError(
            `Payload blocked before sending ${aliasList} (${docList}): prompt contained known values for ${tokens}. Nothing was sent.`,
          );
        }

        const entries: PayloadLogEntry[] = batch.flatMap((doc) =>
          doc.chunks.map((chunk) => ({
            docName: chunk.docName,
            page: chunk.page,
            localText: formatChunkLine(chunk, rehydrateChunkText(chunk.text, chunk.detected), chunk.docName),
            cloudText: prompt,
            sentAt: Date.now(),
            status: 'attempted' as const,
          })),
        );
        batchPayloads[i] = entries;
        for (const entry of entries) {
          onPayload?.(entry);
        }

        activeCalls.set(i, batchDocNames);
        emitPoolProgress('started', i, batchDocNames);

        const result = await generate('synthesize', prompt, GRAPH_RESPONSE_SCHEMA, {
          onRetry: (attempt, waitMs, kind) => {
            onRetryNotice?.(attempt, waitMs, kind);
            options?.onBatchRetry?.({ call: i + 1, docNames: batchDocNames, attempt, waitMs, kind });
          },
        });
        const receivedAt = Date.now();
        for (const entry of entries) {
          entry.status = 'responded';
          entry.receivedAt = receivedAt;
        }
        // Cover EVERY alias in this batch so each rule resolves to its own document.
        const aliasToDocName = new Map(batch.map((d) => [d.alias, d.docName]));
        const batchGraph = parseGraphResponse(result.text, aliasToDocName);
        // Honest label: record which model actually ANSWERED — only after its reply
        // parsed (a model whose output is rejected contributed nothing; CEO round-6 directive).
        batchModels[i] = result.model;
        batchGraphs[i] = batchGraph;
        activeCalls.delete(i);
        doneCount += 1;
        emitPoolProgress('succeeded', i, batchDocNames);
      } catch (err) {
        activeCalls.delete(i);
        if (err instanceof PayloadBlockedError) {
          if (!blockedError) blockedError = err;
          return;
        }
        failedCount += 1;
        batchFailures[i] = {
          call: i + 1,
          docNames: batchDocNames,
          chunks: batch.flatMap((d) => d.chunks),
          error: err,
          message: err instanceof Error ? err.message || err.name : String(err),
        };
        emitPoolProgress('failed', i, batchDocNames);
      }
    }
  }

  if (batches.length > 0) {
    await Promise.all(Array.from({ length: poolSize }, () => runWorker()));
  }

  if (blockedError) {
    throw blockedError;
  }

  // Reassemble results in deterministic document order regardless of completion order.
  const failures: SynthesizeBatchFailure[] = [];
  for (let i = 0; i < batches.length; i++) {
    const batchGraph = batchGraphs[i];
    if (batchGraph) {
      merged.ventures.push(...batchGraph.ventures);
      merged.partners.push(...batchGraph.partners);
      merged.products.push(...batchGraph.products);
      merged.dealRules.push(...batchGraph.dealRules);
    }
    const model = batchModels[i];
    if (model) usedModels.add(model);
    payloadLog.push(...batchPayloads[i]);
    const failure = batchFailures[i];
    if (failure) failures.push(failure);
  }

  if (failures.length > 0 && !options?.allowPartial) {
    throw failures[0].error;
  }

  return { graph: merged, payloadLog, usedModels: [...usedModels], failures, batchGraphs };
}

/**
 * Re-synthesizes a single failed document without re-running the rest of the
 * workspace. Uses the exact same pre-send privacy gate and payload logger.
 */
export async function retrySynthesizeDocument(
  docChunks: AnonymizedChunk[],
  tokenLegend: string,
  onPayload?: (entry: PayloadLogEntry) => void,
  onRetryNotice?: (attempt: number, waitMs: number, kind: string) => void,
  onCallProgress?: (progress: SynthesizeCallProgress) => void,
  options?: SynthesizeOptions,
): Promise<SynthesizeResult> {
  return synthesizeGraph(docChunks, tokenLegend, onPayload, onRetryNotice, onCallProgress, {
    ...options,
    concurrency: 1,
  });
}
