// Sample-corpus privacy regression: the four repo-owned synthetic sample docs
// must pass the pre-send known-value gate untouched, and the gate itself must
// stay fail-closed. RED if any value leaks; RED-if-weakened if the gate stops
// blocking a hand-injected leak.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../hybrid', () => ({
  generate: vi.fn(async (stage: string, _prompt: string) => {
    if (stage !== 'synthesize') throw new Error('on-device unavailable in test');
    return {
      text: JSON.stringify({ ventures: [], partners: [], products: [], dealRules: [] }),
      usedOnDevice: false,
      model: 'mock',
    };
  }),
}));

import { generate } from '../hybrid';
import { synthesizeGraph, PayloadBlockedError } from '../cloud/graphExtractor';
import { findLeakedValues } from '../ui/util';
import { chunkDocument } from './chunker';
import { anonymizeChunks } from './anonymizer';

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLES = [
  'A1-atelier-emily-partnership-agreement.md',
  'A2-october-meeting-notes.md',
  'A3-atelier-emily-cost-sheet.md',
  'B1-nomad-studio-solo-terms.md',
];

function legendOf(res: Awaited<ReturnType<typeof anonymizeChunks>>): string {
  const types = new Map<string, string>();
  for (const c of res.blinded) for (const d of c.detected) if (!types.has(d.token)) types.set(d.token, d.type);
  return Object.keys(res.tokenMap).map((t) => `${t} (type: ${types.get(t) ?? 'UNKNOWN'})`).join('\n');
}

describe('sample corpus passes the pre-send privacy gate', () => {
  it('no known value appears verbatim in any outbound prompt', async () => {
    const docs = SAMPLES.map((name) => ({
      name,
      text: readFileSync(join(here, '..', '..', 'public', 'sample-docs', name), 'utf8'),
    }));
    const chunks = docs.flatMap((d) => chunkDocument(d.name, d.text));
    const anon = await anonymizeChunks(chunks);
    const { graph, payloadLog } = await synthesizeGraph(anon.blinded, legendOf(anon));
    expect(graph).toBeDefined();
    expect(payloadLog.length).toBeGreaterThan(0);
    for (const entry of payloadLog) {
      expect(findLeakedValues(anon.tokenMap, entry.cloudText, 'inspector').hits).toEqual([]);
    }
    // The A1 §4.5 '60 units' collision is swept into a neutral VALUE token
    // (no semantic type claim).
    const a1 = anon.blinded.filter((c) => c.docName === SAMPLES[0]).map((c) => c.text).join('\n');
    expect(a1).toMatch(/orders of \[VALUE_\d+\] units/);
    expect(a1).not.toMatch(/(?<![0-9])(?<![0-9][.,])60(?![0-9])/);
    // Hygiene: every VALUE token in tokenMap is actually used in blinded text,
    // every VALUE token maps to a numeric form, and no legend entry is UNKNOWN.
    const allText = anon.blinded.map((c) => c.text).join('\n');
    for (const [token, value] of Object.entries(anon.tokenMap)) {
      if (!token.startsWith('[VALUE_')) continue;
      expect(allText, `phantom token ${token}`).toContain(token);
      expect(value).toMatch(/^\d[\d.,]*$/);
    }
    expect(legendOf(anon)).not.toContain('UNKNOWN');
  });
});

describe('decimal-form collisions are fully swept', () => {
  it('known $50.25 also blinds bare 50 and grouped 50,25 as distinct tokens', async () => {
    const chunks = chunkDocument('synthetic-decimal.md', 'Pay $50.25 now. In another notation: 50,25. Bulk tier starts at 50 units.');
    const anon = await anonymizeChunks(chunks);
    const { payloadLog } = await synthesizeGraph(anon.blinded, legendOf(anon));
    expect(payloadLog.length).toBeGreaterThan(0);
    for (const entry of payloadLog) {
      expect(findLeakedValues(anon.tokenMap, entry.cloudText, 'inspector').hits).toEqual([]);
    }
    const text = anon.blinded.map((c) => c.text).join('\n');
    const valueTokens = new Set(text.match(/\[VALUE_\d+\]/g) ?? []);
    expect(valueTokens.size).toBeGreaterThanOrEqual(2);
    const values = [...valueTokens].map((t) => anon.tokenMap[t]);
    expect(new Set(values).size).toBe(valueTokens.size);
    expect(values).toContain('50,25');
    expect(values).toContain('50');
  });

  it('clause-number digits adjacent via a dot are both swept (gate-parity closure)', async () => {
    // '10%' and '55%' become known spans; '§10.55' is EXCLUDED from detection
    // (clause reference) so both digits stay literal unless Pass C sweeps them.
    // The gate skips '55' in raw '§10.55' (digit+dot prefix) but flags it once
    // '10' is blinded — so Pass C must blind both halves.
    const chunks = chunkDocument('synthetic-adjacent.md', 'Discount cap 10%. Margin floor 55%. See §10.55 of the annex.');
    const anon = await anonymizeChunks(chunks);
    const { payloadLog } = await synthesizeGraph(anon.blinded, legendOf(anon));
    expect(payloadLog.length).toBeGreaterThan(0);
    for (const entry of payloadLog) {
      expect(findLeakedValues(anon.tokenMap, entry.cloudText, 'inspector').hits).toEqual([]);
    }
    const text = anon.blinded.map((c) => c.text).join('\n');
    expect(text).toMatch(/§\[VALUE_\d+\]\.\[VALUE_\d+\]/);
  });

  it('grouped integer forms of a decimal value are swept (VALUE closure)', async () => {
    // $1,250.50 known -> gate form '1250'. The in-word 'v1250' is not caught by
    // any detector but IS swept by Pass C, registering VALUE '1250' — which at
    // gate time re-expands grouped forms '1,250'/'1.250'. Closure must therefore
    // also blind the in-word 'v1,250', or Pass C self-blocks the payload.
    const chunks = chunkDocument('synthetic-grouped.md', 'Invoice total $1,250.50 settled (ref v1250). The earlier informal quote code v1,250 no longer applies.');
    const anon = await anonymizeChunks(chunks);
    const { payloadLog } = await synthesizeGraph(anon.blinded, legendOf(anon));
    expect(payloadLog.length).toBeGreaterThan(0);
    for (const entry of payloadLog) {
      expect(findLeakedValues(anon.tokenMap, entry.cloudText, 'inspector').hits).toEqual([]);
    }
    const text = anon.blinded.map((c) => c.text).join('\n');
    expect(text).not.toContain('1,250');
    expect(text).toMatch(/ref v\[VALUE_\d+\]/);
    expect(text).toMatch(/code v\[VALUE_\d+\]/);
  });
});

describe('self-overlapping forms rescan past skipped matches', () => {
  it("'§500.100.100.100' leaves no verbatim '100.100' after a partial overlap skip", async () => {
    // '100.100' first matches INSIDE the already-swept '500.100' range; the
    // skip must rescan from inside that span, not past it, or the disjoint
    // '100.100' at +4 survives verbatim next to a blinded token.
    const chunks = chunkDocument('synthetic-selfoverlap.md', 'Cost $100,100. Price $500,100. See §500.100.100.100 of the annex.');
    const anon = await anonymizeChunks(chunks);
    const { payloadLog } = await synthesizeGraph(anon.blinded, legendOf(anon));
    expect(payloadLog.length).toBeGreaterThan(0);
    for (const entry of payloadLog) {
      expect(findLeakedValues(anon.tokenMap, entry.cloudText, 'inspector').hits).toEqual([]);
    }
    const text = anon.blinded.map((c) => c.text).join('\n');
    expect(text).not.toContain('100.100');
    expect(text).not.toContain('500.100');
  });
});

describe('overlap losers cannot leak known values (pre-sweep resolution)', () => {
  it("'15.20' losing to '20.50%' still has its uncovered '15' swept", async () => {
    // DECIMAL_RE emits '15.20' (len 5), PERCENT_RE emits '20.50%' (len 6) over
    // overlapping ranges; the loser's stale range must NOT reserve '15' for
    // Pass C, or literal '15' survives into the prompt next to [DISCOUNT_CAP].
    const chunks = chunkDocument('synthetic-overlap.md', 'Discount cap 15%. Version 15.20.50%.');
    const anon = await anonymizeChunks(chunks);
    const { payloadLog } = await synthesizeGraph(anon.blinded, legendOf(anon));
    expect(payloadLog.length).toBeGreaterThan(0);
    for (const entry of payloadLog) {
      expect(findLeakedValues(anon.tokenMap, entry.cloudText, 'inspector').hits).toEqual([]);
    }
    const text = anon.blinded.map((c) => c.text).join('\n');
    expect(text).not.toMatch(/(?<![0-9])15(?![0-9])/);
  });
});

describe('tagger prompt never advertises the internal VALUE type', () => {
  it('redact-stage prompts exclude VALUE', async () => {
    const chunks = chunkDocument('synthetic-tagger.md', 'Pay $50.25 now. The margin floor is 55% per order.');
    await anonymizeChunks(chunks);
    const redactCalls = vi
      .mocked(generate)
      .mock.calls.filter(([stage]) => stage === 'redact');
    expect(redactCalls.length).toBeGreaterThan(0);
    for (const [, prompt] of redactCalls) {
      expect(prompt).not.toContain('VALUE');
    }
  });
});

describe('pre-send gate stays strict (never weaken)', () => {
  it('a hand-crafted prompt leak still blocks the send and nothing is sent', async () => {
    const chunks = chunkDocument('synthetic-leak.md', 'The margin floor is 33% on every order.');
    const anon = await anonymizeChunks(chunks);
    // Inject a fake known-value registration while leaving the literal raw in text.
    const blinded = anon.blinded.map((c) => ({
      ...c,
      detected: [{ text: '33%', token: '[MARGIN_FLOOR_9]', type: 'MARGIN_FLOOR' as const }],
    }));
    blinded[0] = { ...blinded[0], text: 'The margin floor is 33% on every order.' };
    vi.mocked(generate).mockClear();
    await expect(synthesizeGraph(blinded, '[MARGIN_FLOOR_9] (type: MARGIN_FLOOR)')).rejects.toBeInstanceOf(PayloadBlockedError);
    expect(vi.mocked(generate)).not.toHaveBeenCalled();
  });
});
