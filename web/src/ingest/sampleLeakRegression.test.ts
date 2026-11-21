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
  });
});

describe('decimal-form collisions are fully swept', () => {
  it('known $50.25 also blinds bare 50 and grouped 50,25', async () => {
    const chunks = chunkDocument('synthetic-decimal.md', 'Pay $50.25 now. In another notation: 50,25. Bulk tier starts at 50 units.');
    const anon = await anonymizeChunks(chunks);
    const { payloadLog } = await synthesizeGraph(anon.blinded, legendOf(anon));
    expect(payloadLog.length).toBeGreaterThan(0);
    for (const entry of payloadLog) {
      expect(findLeakedValues(anon.tokenMap, entry.cloudText, 'inspector').hits).toEqual([]);
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
