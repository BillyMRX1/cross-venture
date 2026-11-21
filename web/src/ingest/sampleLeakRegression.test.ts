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

  it('two distinct known values adjacent via a dot do not shift boundaries post-blinding', async () => {
    // '10%' and '55%' become known; the clause number '10.55' contains both.
    // The gate skips '55' in the RAW text (preceded by digit+dot) but would
    // flag it once '10' is blinded — Pass C must blind both.
    const chunks = chunkDocument('synthetic-adjacent.md', 'Discount cap 10%. Margin floor 55%. See clause 10.55 of the annex.');
    const anon = await anonymizeChunks(chunks);
    const { payloadLog } = await synthesizeGraph(anon.blinded, legendOf(anon));
    expect(payloadLog.length).toBeGreaterThan(0);
    for (const entry of payloadLog) {
      expect(findLeakedValues(anon.tokenMap, entry.cloudText, 'inspector').hits).toEqual([]);
    }
    const text = anon.blinded.map((c) => c.text).join('\n');
    // Either both halves are swept as VALUE tokens, or the clause number is
    // tokenized whole by a value detector — both leave no gate-visible literal.
    expect(text).toMatch(/clause \[[A-Z_]+_\d+\]/);
    expect(text).not.toMatch(/(?<![0-9])10(?![0-9])/);
    expect(text).not.toMatch(/(?<![0-9])55(?![0-9])/);
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
