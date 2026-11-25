import { describe, expect, it, vi } from 'vitest';
import type { AnonymizedChunk } from '../types';
import { synthesizeGraph } from './graphExtractor';

const { generateMock } = vi.hoisted(() => ({ generateMock: vi.fn() }));
vi.mock('../hybrid', () => ({ generate: generateMock }));

// Honest model label (CEO round-6 directive): the UI must be able to show which
// model actually produced the graph — primary vs opt-in fallback.

function graphJsonFor(alias: string): string {
  return JSON.stringify({
    ventures: [], partners: [], products: [],
    dealRules: [{
      rule_id: 'r1', venture_id: 'v1', max_discount_pct_token: '[DISCOUNT_CAP_1]',
      min_qty_condition: '', requires_partner_approval: true,
      source_doc_name: alias, page_or_section: '1',
      verbatim_blinded_excerpt: '[VENTURE_1] agrees with [PARTNER_1].',
    }],
  });
}

// Padded past the batching cap (see MAX_COMBINED_CHUNK_CHARS) so each
// document keeps its own cloud call: this suite labels models across
// MULTIPLE calls. Batching itself is covered by graphExtractor.batch.test.ts.
function chunk(docName: string): AnonymizedChunk {
  return {
    docName, page: 1, index: 0,
    text: '[VENTURE_1] agrees with [PARTNER_1]. Cap [DISCOUNT_CAP_1]. '
      + 'terms of the supply agreement, reviewed locally. '.repeat(400),
    detected: [
      { text: 'Sari Dewi', token: '[PARTNER_1]', type: 'PARTNER' },
      { text: '40', token: '[COST_1]', type: 'COST' },
    ],
  };
}

describe('usedModels honest labeling', () => {
  it('reports the single model when the primary answers every group', async () => {
    generateMock.mockReset();
    let calls = 0;
    generateMock.mockImplementation(async () => {
      calls += 1;
      return { text: graphJsonFor(calls === 1 ? 'DOC_1' : 'DOC_2'), usedOnDevice: false, model: 'gemini-3.8-flash' };
    });
    const synth = await synthesizeGraph([chunk('a.md'), chunk('b.md')], '');
    expect(synth.usedModels).toEqual(['gemini-3.8-flash']);
  });

  it('lists BOTH models when a fallback answered mid-run (deduped, first-seen order)', async () => {
    generateMock.mockReset();
    let calls = 0;
    generateMock.mockImplementation(async () => {
      calls += 1;
      const model = calls === 1 ? 'gemini-3.8-flash' : 'gemini-3.6-flash';
      return { text: graphJsonFor(calls === 1 ? 'DOC_1' : 'DOC_2'), usedOnDevice: false, model };
    });
    const synth = await synthesizeGraph([chunk('a.md'), chunk('b.md')], '');
    expect(synth.graph.dealRules.length).toBe(2);
    expect(synth.usedModels).toEqual(['gemini-3.8-flash', 'gemini-3.6-flash']);
  });

  it('pins the empty contract: zero groups -> no models recorded', async () => {
    generateMock.mockReset();
    const synth = await synthesizeGraph([], '');
    expect(generateMock).not.toHaveBeenCalled();
    expect(synth.usedModels).toEqual([]);
  });
});
