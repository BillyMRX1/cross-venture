import { describe, expect, it, vi } from 'vitest';
import type { AnonymizedChunk, KnowledgeGraph, PayloadLogEntry } from '../types';
import { withTransientRetry } from './transient';
import {
  PayloadBlockedError,
  SYNTHESIZE_CONCURRENCY,
  mergeKnowledgeGraphs,
  retrySynthesizeDocument,
  synthesizeGraph,
  type SynthesizePoolProgress,
} from './graphExtractor';
import * as util from '../ui/util';

const { generateMock } = vi.hoisted(() => ({ generateMock: vi.fn() }));
vi.mock('../hybrid', () => ({ generate: generateMock }));

// Synthetic large contract chunks (> MAX_COMBINED_CHUNK_CHARS = 16000 each)
// so 5 documents produce 5 separate cloud calls, matching the live PDF workload.
const FILLER = 'supply terms paragraph about margins, caps and lead times. '.repeat(300); // 17,700 chars

function largeDocChunk(docName: string, partnerName: string, token: string): AnonymizedChunk {
  return {
    docName,
    page: 1,
    index: 0,
    text: `[VENTURE_1] contract with ${token}. ${FILLER}`,
    detected: [{ text: partnerName, token, type: 'PARTNER' }],
  };
}

function fiveLargeDocs(): AnonymizedChunk[] {
  return [
    largeDocChunk('contract-1.pdf', 'Rowan Vance', '[PARTNER_1]'),
    largeDocChunk('contract-2.pdf', 'Mira Calloway', '[PARTNER_2]'),
    largeDocChunk('contract-3.pdf', 'Nadia Okafor', '[PARTNER_3]'),
    largeDocChunk('contract-4.pdf', 'Devon Sato', '[PARTNER_4]'),
    largeDocChunk('contract-5.pdf', 'Tessa Lindholm', '[PARTNER_5]'),
  ];
}

function responseForPrompt(prompt: string, model = 'gemini-3.8-flash'): { text: string; usedOnDevice: false; model: string } {
  const aliases = [...new Set([...prompt.matchAll(/\[DOC_(\d+) p\.\d+ #\d+\]/g)].map((m) => `DOC_${m[1]}`))];
  return {
    text: JSON.stringify({
      ventures: aliases.map((a) => ({
        venture_id: `v-${a}`,
        venture_token: '[VENTURE_1]',
        min_margin_pct_token: '[MARGIN_FLOOR_1]',
      })),
      partners: aliases.map((a) => ({
        partner_id: `p-${a}`,
        partner_token: '[PARTNER_1]',
        venture_id: `v-${a}`,
        approval_rules: `rule-${a}`,
      })),
      products: aliases.map((a) => ({
        sku_id: `sku-${a}`,
        sku_token: '[SKU_1]',
        venture_id: `v-${a}`,
        cogs_token: '[COST_1]',
        list_price_token: '[PRICE_1]',
      })),
      dealRules: aliases.map((a) => ({
        rule_id: `rule-${a}`,
        venture_id: `v-${a}`,
        max_discount_pct_token: '[DISCOUNT_CAP_1]',
        min_qty_condition: '',
        requires_partner_approval: true,
        source_doc_name: a,
        page_or_section: '1',
        verbatim_blinded_excerpt: '[VENTURE_1] terms.',
      })),
    }),
    usedOnDevice: false,
    model,
  };
}

function transient500(): Error & { customCode: number } {
  const e = new Error(
    'Error fetching from https://firebasevertexai.googleapis.com/...:generateContent: [500 ] ' +
    'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.',
  ) as Error & { customCode: number };
  e.customCode = 500;
  return e;
}

describe('concurrent synthesis pool (stage 04 speed)', () => {
  it('defaults to pool size 3 and never exceeds concurrency limit across 5 docs', async () => {
    expect(SYNTHESIZE_CONCURRENCY).toBe(3);
    generateMock.mockReset();

    let inFlight = 0;
    let maxInFlight = 0;
    generateMock.mockImplementation(async (_stage: string, prompt: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 25));
      inFlight -= 1;
      return responseForPrompt(prompt);
    });

    const poolEvents: SynthesizePoolProgress[] = [];
    const res = await synthesizeGraph(fiveLargeDocs(), '', undefined, undefined, undefined, {
      onPoolProgress: (p) => poolEvents.push(p),
    });

    expect(generateMock).toHaveBeenCalledTimes(5);
    expect(maxInFlight).toBe(3);
    expect(res.failures).toEqual([]);
    // Pool progress reports both in-flight and done counts up to 5 of 5 done.
    expect(poolEvents.some((e) => e.inFlight === 3)).toBe(true);
    expect(poolEvents[poolEvents.length - 1]).toMatchObject({ totalCalls: 5, done: 5, inFlight: 0, failed: 0 });
  });

  it('preserves document order even when later batches finish first', async () => {
    generateMock.mockReset();
    // Reverse delays so DOC_3 finishes before DOC_2 before DOC_1, and DOC_5 before DOC_4.
    const delayByAlias: Record<string, number> = {
      DOC_1: 60,
      DOC_2: 35,
      DOC_3: 10,
      DOC_4: 40,
      DOC_5: 5,
    };
    const modelByAlias: Record<string, string> = {
      DOC_1: 'model-a',
      DOC_2: 'model-b',
      DOC_3: 'model-c',
      DOC_4: 'model-a',
      DOC_5: 'model-d',
    };

    generateMock.mockImplementation(async (_stage: string, prompt: string) => {
      const m = prompt.match(/\[(DOC_\d+) p\.\d+ #\d+\]/);
      const alias = m?.[1] ?? 'DOC_1';
      await new Promise((r) => setTimeout(r, delayByAlias[alias] ?? 10));
      return responseForPrompt(prompt, modelByAlias[alias]);
    });

    const res = await synthesizeGraph(fiveLargeDocs(), '');
    expect(res.graph.ventures.map((v) => v.venture_id)).toEqual(['v-DOC_1', 'v-DOC_2', 'v-DOC_3', 'v-DOC_4', 'v-DOC_5']);
    expect(res.graph.partners.map((p) => p.partner_id)).toEqual(['p-DOC_1', 'p-DOC_2', 'p-DOC_3', 'p-DOC_4', 'p-DOC_5']);
    expect(res.graph.products.map((p) => p.sku_id)).toEqual(['sku-DOC_1', 'sku-DOC_2', 'sku-DOC_3', 'sku-DOC_4', 'sku-DOC_5']);
    expect(res.graph.dealRules.map((r) => r.source_doc_name)).toEqual([
      'contract-1.pdf',
      'contract-2.pdf',
      'contract-3.pdf',
      'contract-4.pdf',
      'contract-5.pdf',
    ]);
    expect(res.payloadLog.map((e) => e.docName)).toEqual([
      'contract-1.pdf',
      'contract-2.pdf',
      'contract-3.pdf',
      'contract-4.pdf',
      'contract-5.pdf',
    ]);
    expect(res.usedModels).toEqual(['model-a', 'model-b', 'model-c', 'model-d']);
  });

  it('calls findLeakedValues once per prompt before its send under concurrency with delays and busy retries', async () => {
    generateMock.mockReset();
    const gateSpy = vi.spyOn(util, 'findLeakedValues');
    const timeline: string[] = [];

    gateSpy.mockImplementation((tokenMap, cloudText, where) => {
      timeline.push(`gate:${where}`);
      return { hits: [], checked: Object.keys(tokenMap).length };
    });

    const attempts = new Map<string, number>();
    generateMock.mockImplementation(async (_stage: string, prompt: string, _schema: unknown, opts?: { onRetry?: (a: number, w: number, k: string) => void }) => {
      const alias = prompt.match(/\[(DOC_\d+) p\.\d+ #\d+\]/)?.[1] ?? 'DOC_1';
      timeline.push(`send:${alias}`);
      return withTransientRetry(
        async () => {
          const n = (attempts.get(alias) ?? 0) + 1;
          attempts.set(alias, n);
          if ((alias === 'DOC_2' || alias === 'DOC_4') && n <= 2) {
            throw transient500();
          }
          await new Promise((r) => setTimeout(r, 10));
          return responseForPrompt(prompt);
        },
        { sleep: async () => {}, rng: () => 0, onRetry: opts?.onRetry },
      );
    });

    try {
      const seen: PayloadLogEntry[] = [];
      const res = await synthesizeGraph(fiveLargeDocs(), '', (e) => seen.push(e));
      expect(gateSpy).toHaveBeenCalledTimes(5);
      // One payload-log entry per call (5 single-chunk docs -> 5 entries, never duplicated on retry).
      expect(res.payloadLog.length).toBe(5);
      expect(seen.length).toBe(5);

      for (let i = 1; i <= 5; i++) {
        const alias = `DOC_${i}`;
        const gateIdx = timeline.indexOf(`gate:pre-send ${alias}`);
        const sendIdx = timeline.indexOf(`send:${alias}`);
        expect(gateIdx, `gate must run for ${alias}`).toBeGreaterThanOrEqual(0);
        expect(sendIdx, `send must run for ${alias}`).toBeGreaterThan(gateIdx);
      }
    } finally {
      gateSpy.mockRestore();
    }
  });

  it('blocked call under concurrency sends nothing and records nothing for the leaked doc', async () => {
    generateMock.mockReset();
    generateMock.mockImplementation(async (_stage: string, prompt: string) => {
      await new Promise((r) => setTimeout(r, 15));
      return responseForPrompt(prompt);
    });

    const docs = fiveLargeDocs();
    // Plant an unblinded real value in doc 2.
    docs[1] = {
      ...docs[1],
      text: `${docs[1].text} signed by Mira Calloway.`,
    };
    const seen: PayloadLogEntry[] = [];
    const err = await synthesizeGraph(docs, '', (e) => seen.push(e), undefined, undefined, { allowPartial: true }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PayloadBlockedError);
    // Doc 2 was blocked before send and never logged.
    expect(seen.some((e) => e.docName === 'contract-2.pdf')).toBe(false);
    const sentPrompts = generateMock.mock.calls.map((c) => String(c[1]));
    expect(sentPrompts.some((p) => p.includes('Mira Calloway'))).toBe(false);
  });

  it('a failed doc does not fail the other docs when allowPartial is enabled', async () => {
    generateMock.mockReset();
    generateMock.mockImplementation(async (_stage: string, prompt: string) => {
      const alias = prompt.match(/\[(DOC_\d+) p\.\d+ #\d+\]/)?.[1] ?? 'DOC_1';
      await new Promise((r) => setTimeout(r, 10));
      if (alias === 'DOC_3') {
        throw new Error('Gemini is busy right now — try again in a few minutes (gave up after 3 attempts)');
      }
      return responseForPrompt(prompt);
    });

    const seen: PayloadLogEntry[] = [];
    const res = await synthesizeGraph(fiveLargeDocs(), '', (e) => seen.push(e), undefined, undefined, {
      allowPartial: true,
    });

    expect(generateMock).toHaveBeenCalledTimes(5);
    expect(res.graph.dealRules.map((r) => r.source_doc_name)).toEqual([
      'contract-1.pdf',
      'contract-2.pdf',
      'contract-4.pdf',
      'contract-5.pdf',
    ]);
    expect(res.failures.length).toBe(1);
    expect(res.failures[0].docNames).toEqual(['contract-3.pdf']);
    expect(res.failures[0].chunks.length).toBe(1);
    expect(res.failures[0].message).toContain('Gemini is busy');
    // Failed doc still left its honest pre-send 'attempted' record, while others flipped to 'responded'.
    expect(seen.find((e) => e.docName === 'contract-3.pdf')?.status).toBe('attempted');
    expect(seen.filter((e) => e.status === 'responded').length).toBe(4);
  });

  it('retry-one-document sends only the failed document and merges back cleanly', async () => {
    generateMock.mockReset();
    let failDoc3 = true;
    generateMock.mockImplementation(async (_stage: string, prompt: string) => {
      const alias = prompt.match(/\[(DOC_\d+) p\.\d+ #\d+\]/)?.[1] ?? 'DOC_1';
      const isDoc3Retry = !failDoc3 && prompt.includes('[PARTNER_3]');
      if (failDoc3 && alias === 'DOC_3') {
        throw new Error('Gemini is busy right now');
      }
      return responseForPrompt(prompt, isDoc3Retry ? 'gemini-3.8-flash' : 'gemini-3.8-flash');
    });

    const docs = fiveLargeDocs();
    const initial = await synthesizeGraph(docs, '', undefined, undefined, undefined, { allowPartial: true });
    expect(initial.failures.length).toBe(1);
    expect(initial.failures[0].docNames).toEqual(['contract-3.pdf']);
    expect(generateMock).toHaveBeenCalledTimes(5);

    // Retry ONLY contract-3.pdf (not a full re-run).
    failDoc3 = false;
    generateMock.mockClear();
    const fullKnownValues = {
      '[PARTNER_1]': 'Rowan Vance',
      '[PARTNER_2]': 'Mira Calloway',
      '[PARTNER_3]': 'Nadia Okafor',
      '[PARTNER_4]': 'Devon Sato',
      '[PARTNER_5]': 'Tessa Lindholm',
    };
    const retried = await retrySynthesizeDocument(
      initial.failures[0].chunks,
      '[PARTNER_3] (type: PARTNER)',
      undefined,
      undefined,
      undefined,
      { extraKnownValues: fullKnownValues },
    );

    expect(generateMock).toHaveBeenCalledTimes(1); // ONLY 1 call, not 5!
    expect(retried.failures).toEqual([]);
    expect(retried.graph.dealRules.map((r) => r.source_doc_name)).toEqual(['contract-3.pdf']);
    expect(retried.payloadLog.length).toBe(1);
    expect(retried.payloadLog[0].status).toBe('responded');

    const combined: KnowledgeGraph = mergeKnowledgeGraphs([initial.graph, retried.graph]);
    expect(combined.dealRules.map((r) => r.source_doc_name).sort()).toEqual([
      'contract-1.pdf',
      'contract-2.pdf',
      'contract-3.pdf',
      'contract-4.pdf',
      'contract-5.pdf',
    ]);
  });

  it('wall-time benchmark: 5 calls × 20s sleep with 2 busy retries on 2 of 5 calls (sequential vs concurrent)', async () => {
    vi.useFakeTimers();
    try {
      const makeMockedGenerate = () => {
        const attempts = new Map<string, number>();
        generateMock.mockReset();
        generateMock.mockImplementation(
          async (
            _stage: string,
            prompt: string,
            _schema: unknown,
            opts?: { onRetry?: (a: number, w: number, k: string) => void },
          ) => {
            const alias = prompt.match(/\[(DOC_\d+) p\.\d+ #\d+\]/)?.[1] ?? 'DOC_1';
            return withTransientRetry(
              async () => {
                const n = (attempts.get(alias) ?? 0) + 1;
                attempts.set(alias, n);
                // 2 of 5 calls return busy twice before succeeding.
                if ((alias === 'DOC_2' || alias === 'DOC_4') && n <= 2) {
                  throw transient500();
                }
                await new Promise<void>((r) => setTimeout(r, 20_000));
                return responseForPrompt(prompt);
              },
              {
                maxAttempts: 3,
                // Deterministic mid-range jitter (25% of backoff: 2.5s + 5.0s = 7.5s per busy doc).
                rng: () => 0.5,
                onRetry: opts?.onRetry,
              },
            );
          },
        );
      };

      // Sequential baseline (concurrency = 1)
      makeMockedGenerate();
      const seqStart = Date.now();
      const seqPromise = synthesizeGraph(fiveLargeDocs(), '', undefined, undefined, undefined, { concurrency: 1 });
      await vi.runAllTimersAsync();
      const seqRes = await seqPromise;
      const seqWallMs = Date.now() - seqStart;

      // Concurrent pool (default SYNTHESIZE_CONCURRENCY = 3)
      makeMockedGenerate();
      const concStart = Date.now();
      const concPromise = synthesizeGraph(fiveLargeDocs(), '');
      await vi.runAllTimersAsync();
      const concRes = await concPromise;
      const concWallMs = Date.now() - concStart;

      console.log(
        `[stage-04 wall-time benchmark] 5 docs × 20s (+2 busy retries on 2 docs): sequential=${(seqWallMs / 1000).toFixed(2)}s, concurrent(pool=${SYNTHESIZE_CONCURRENCY})=${(concWallMs / 1000).toFixed(2)}s (speedup=${(seqWallMs / concWallMs).toFixed(2)}x)`,
      );

      expect(seqRes.graph.dealRules.map((r) => r.source_doc_name)).toEqual(
        concRes.graph.dealRules.map((r) => r.source_doc_name),
      );
      expect(seqWallMs).toBeGreaterThanOrEqual(110_000);
      expect(concWallMs).toBeLessThan(60_000);
      expect(concWallMs).toBeLessThan(seqWallMs / 2);
    } finally {
      vi.useRealTimers();
    }
  });
});
