// Tech Lead integration test (Wave 2): FR-1 acceptance — blinded text must leak
// ZERO real names/values from the Scenario A sample docs. Runs headless in Node:
// with no Firebase config, generate('redact') throws HybridUnavailableError and
// the anonymizer must degrade to local heuristics only.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { anonymizeChunks } from './ingest/anonymizer';
import { chunkDocument } from './ingest/chunker';

const DOC = resolve(__dirname, '../public/sample-docs/A1-atelier-emily-partnership-agreement.md');

// Values that MUST NOT survive into cloud-safe text (Scenario A ground truth).
const FORBIDDEN = [
  'Emily',
  'Hartono',
  'Atelier',
  '$40',
  '$100',
  '40 USD',
  '55%',
  '10%',
  '15%',
];

describe('FR-1 privacy invariant: no plaintext secrets in blinded chunks', () => {
  it('chunker produces page-tagged chunks from a page-marked agreement', () => {
    const text = readFileSync(DOC, 'utf8');
    const chunks = chunkDocument('A1.md', text, 600);
    expect(chunks.length).toBeGreaterThan(3); // 3-page doc at 600 words
    for (const c of chunks) {
      expect(c.page).toBeGreaterThanOrEqual(1);
      expect(c.text.trim().length).toBeGreaterThan(0);
    }
    const pages = new Set(chunks.map((c) => c.page));
    expect(pages.size).toBeGreaterThanOrEqual(2); // page markers honored
  });

  it('anonymizer removes every sensitive name/number from blinded text (heuristic fallback)', async () => {
    const text = readFileSync(DOC, 'utf8');
    const chunks = chunkDocument('A1.md', text, 600);
    const { blinded, tokenMap } = await anonymizeChunks(chunks);

    expect(Object.keys(tokenMap).length).toBeGreaterThan(5);
    const allBlinded = blinded.map((c) => c.text).join('\n');

    for (const needle of FORBIDDEN) {
      expect(allBlinded, `blinded text leaked: ${needle}`).not.toContain(needle);
    }
    // every tokenMap real value must be absent too (values, not just samples)
    for (const [token, value] of Object.entries(tokenMap)) {
      expect(token).toMatch(/^\[[A-Z_]+_\d+\]$/);
      if (value.length >= 2) {
        expect(allBlinded, `token ${token} value leaked: ${value}`).not.toContain(value);
      }
    }
  });

  it('same real value maps to the same token (dedupe)', async () => {
    const text = readFileSync(DOC, 'utf8');
    const chunks = chunkDocument('A1.md', text, 600);
    const { tokenMap } = await anonymizeChunks(chunks);
    const byValue = new Map<string, string[]>();
    for (const [token, value] of Object.entries(tokenMap)) {
      byValue.set(value, [...(byValue.get(value) ?? []), token]);
    }
    for (const [value, tokens] of byValue) {
      expect(tokens.length, `value "${value}" got multiple tokens`).toBe(1);
    }
  });
});
