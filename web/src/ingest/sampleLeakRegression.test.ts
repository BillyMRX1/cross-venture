// Sample-corpus privacy regression: the four repo-owned synthetic sample docs
// must pass the pre-send known-value gate untouched. RED if any value leaks.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../hybrid', () => ({
  generate: vi.fn(async (stage: string, prompt: string) => {
    if (stage !== 'synthesize') throw new Error('on-device unavailable in test');
    return {
      text: JSON.stringify({ ventures: [], partners: [], products: [], dealRules: [] }),
      usedOnDevice: false,
      model: 'mock',
    };
  }),
}));

import { synthesizeGraph, PayloadBlockedError } from '../cloud/graphExtractor';
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
    const result = synthesizeGraph(anon.blinded, legendOf(anon));
    // RED today: PayloadBlockedError for DISCOUNT_CAP_2 on DOC_1 (A1).
    await expect(result).resolves.toBeDefined();
  });
});

describe('pre-send gate stays strict (never weaken)', () => {
  it('a hand-crafted prompt leak still blocks the send', async () => {
    const docName = 'synthetic-leak.md';
    const chunks = chunkDocument(docName, 'The margin floor is 33% on every order.');
    const anon = await anonymizeChunks(chunks);
    // Inject a fake detected span (known value) while leaving the literal in text.
    const blinded = anon.blinded.map((c) => ({
      ...c,
      detected: [{ text: '33%', token: 'MARGIN_FLOOR_9', type: 'MARGIN_FLOOR' as const }],
    }));
    // Force the leak: strip the token back to the raw value for one chunk.
    blinded[0] = { ...blinded[0], text: 'The margin floor is 33% on every order.' };
    await expect(synthesizeGraph(blinded, 'MARGIN_FLOOR_9 (type: MARGIN_FLOOR)')).rejects.toBeInstanceOf(PayloadBlockedError);
  });
});
