import { describe, expect, it, vi } from 'vitest';
import type { AnonymizedChunk } from '../types';
import { PayloadBlockedError, synthesizeGraph } from './graphExtractor';

const { generateMock } = vi.hoisted(() => ({ generateMock: vi.fn() }));
vi.mock('../hybrid', () => ({ generate: generateMock }));

// Batching whole documents into fewer cloud calls must not split a document,
// must not blur docName attribution, and must not weaken the pre-send gate.
// All fixtures below are invented synthetic documents (no real tester names).

// NOTE: no module-level beforeEach(mockReset) — see graphExtractor.gate.test.ts
// for the vitest unhandled-rejection mis-attribution this avoids. Reset inline.

const KNOWN_PARTNER = 'Rowan Vance'; // detected-but-blinded everywhere below

function chunk(docName: string, page: number, index: number, body: string): AnonymizedChunk {
  return {
    docName,
    page,
    index,
    text: body,
    detected: [{ text: KNOWN_PARTNER, token: '[PARTNER_1]', type: 'PARTNER' }],
  };
}

function para(sentences: number): string {
  return 'supply terms paragraph about margins, caps and lead times. '.repeat(sentences);
}

/** Stub that answers with one dealRule + one venture per document alias present. */
function stubGraphPerAliasInPrompt(): void {
  generateMock.mockImplementation(async (_stage: string, prompt: string) => {
    const aliases = [
      ...new Set(
        [...prompt.matchAll(/\[DOC_(\d+) p\.\d+ #\d+\]/g)].map((m) => `DOC_${m[1]}`),
      ),
    ];
    return {
      text: JSON.stringify({
        ventures: aliases.map((a) => ({
          venture_id: `v-${a}`,
          venture_token: '[VENTURE_1]',
          min_margin_pct_token: '[MARGIN_FLOOR_1]',
        })),
        partners: [],
        products: [],
        dealRules: aliases.map((a) => ({
          rule_id: `rule-${a}`,
          venture_id: `v-${a}`,
          max_discount_pct_token: '[DISCOUNT_CAP_1]',
          min_qty_condition: '',
          requires_partner_approval: true,
          source_doc_name: a,
          page_or_section: '1',
          verbatim_blinded_excerpt: '[PARTNER_1] agrees.',
        })),
      }),
      usedOnDevice: false,
      model: 'stub-model',
    };
  });
}

describe('document batching in synthesizeGraph', () => {
  it('four small documents need fewer cloud calls than documents', async () => {
    generateMock.mockReset();
    stubGraphPerAliasInPrompt();
    const docs = ['northwind-terms.md', 'harbor-mou.md', 'lakeside-rates.md', 'cedar-notes.md'];
    const blinded = docs.flatMap((d) => [chunk(d, 1, 0, para(5)), chunk(d, 1, 1, para(5))]);
    const { graph } = await synthesizeGraph(blinded, '');
    expect(generateMock.mock.calls.length).toBeLessThan(docs.length);
    expect(generateMock).toHaveBeenCalledTimes(1); // all four fit under the cap
    // Every alias in the single batch resolved back to its real docName.
    expect(graph.dealRules.map((r) => r.source_doc_name).sort()).toEqual([...docs].sort());
    expect(new Set(graph.ventures.map((v) => v.venture_id)).size).toBe(docs.length);
  });

  it('over-cap combined size splits into exactly two calls, never mid-document', async () => {
    generateMock.mockReset();
    stubGraphPerAliasInPrompt();
    // ~6200 chars per document: two fit under any sane cap, three would not.
    const docs = ['d-one.md', 'd-two.md', 'd-three.md', 'd-four.md'];
    const blinded = docs.flatMap((d) => [chunk(d, 1, 0, para(52)), chunk(d, 2, 1, para(52))]);
    const seen: Array<{ docName: string; cloudText: string }> = [];
    const { graph, payloadLog } = await synthesizeGraph(blinded, '', (e) =>
      seen.push({ docName: e.docName, cloudText: e.cloudText }),
    );
    expect(generateMock).toHaveBeenCalledTimes(2);

    // No document is split: both chunks of a doc share one exact prompt, and
    // that prompt exists verbatim among the calls actually sent.
    const prompts = generateMock.mock.calls.map((c) => String(c[1]));
    for (const doc of docs) {
      const texts = payloadLog.filter((e) => e.docName === doc).map((e) => e.cloudText);
      expect(new Set(texts).size).toBe(1);
      expect(prompts).toContain(texts[0]);
    }
    // Attribution survives across batches: each rule carries its real docName.
    expect(graph.dealRules.map((r) => r.source_doc_name).sort()).toEqual([...docs].sort());
    expect(graph.ventures.length).toBe(docs.length);

    // Whichever prompts carry DOC_1/DOC_2 must not leak into the other call.
    const first = prompts.find((p) => p.includes('[DOC_1 p.1 #0]'))!;
    expect(first).toContain('[DOC_2 p.2 #1]');
  });

  it('a planted known value in the second document of a batch blocks the whole batch, fail-closed', async () => {
    generateMock.mockReset();
    stubGraphPerAliasInPrompt();
    const clean = chunk('northwind-terms.md', 1, 0, para(5));
    const leaky: AnonymizedChunk = {
      docName: 'harbor-mou.md',
      page: 1,
      index: 0,
      // anonymizer regression: this detected value was NOT blinded in the text
      text: `sync at cafe with Mira Calloway on pricing. ${para(3)}`,
      detected: [
        { text: KNOWN_PARTNER, token: '[PARTNER_1]', type: 'PARTNER' },
        { text: 'Mira Calloway', token: '[PARTNER_2]', type: 'PARTNER' },
      ],
    };
    const onPayload = vi.fn();
    const err = await synthesizeGraph([clean, leaky], '', onPayload).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(PayloadBlockedError);
    expect(generateMock).not.toHaveBeenCalled(); // the WHOLE batch fails closed, nothing sent
    expect(onPayload).not.toHaveBeenCalled(); // nothing recorded as sent either
    const msg = (err as Error).message;
    expect(msg).toContain('[PARTNER_2]'); // names tokens only...
    expect(msg).not.toContain('Mira Calloway'); // ...never the raw value
  });

  it('every payloadLog entry carries the exact batched prompt actually sent', async () => {
    generateMock.mockReset();
    stubGraphPerAliasInPrompt();
    const small = ['northwind-terms.md', 'harbor-mou.md'].flatMap((d) => [chunk(d, 1, 0, para(4)), chunk(d, 1, 1, para(4))]);
    const { payloadLog } = await synthesizeGraph(small, '');
    expect(generateMock).toHaveBeenCalledTimes(1);
    const sent = String(generateMock.mock.calls[0][1]);
    expect(payloadLog.length).toBe(4);
    for (const entry of payloadLog) {
      expect(entry.cloudText).toBe(sent);
    }

    // Multi-batch run: each entry matches its own batch's prompt, not the other.
    generateMock.mockReset();
    stubGraphPerAliasInPrompt();
    const big = ['d-one.md', 'd-two.md', 'd-three.md', 'd-four.md'].flatMap((d) => [
      chunk(d, 1, 0, para(52)),
      chunk(d, 2, 1, para(52)),
    ]);
    const two = await synthesizeGraph(big, '');
    const prompts = generateMock.mock.calls.map((c) => String(c[1]));
    expect(prompts.length).toBe(2);
    for (const entry of two.payloadLog) {
      expect(prompts).toContain(entry.cloudText);
    }
  });

  it('progress names the documents of each planned call before it starts', async () => {
    generateMock.mockReset();
    stubGraphPerAliasInPrompt();
    const onProgress = vi.fn();
    const docs = ['d-one.md', 'd-two.md', 'd-three.md', 'd-four.md'];
    const blinded = docs.flatMap((d) => [chunk(d, 1, 0, para(52)), chunk(d, 2, 1, para(52))]);
    await synthesizeGraph(blinded, '', undefined, undefined, onProgress);
    expect(generateMock).toHaveBeenCalledTimes(2);
    const calls = onProgress.mock.calls.map((c) => c[0]);
    expect(calls.length).toBe(2);
    expect(calls[0]).toEqual({ call: 1, totalCalls: 2, docNames: ['d-one.md', 'd-two.md'] });
    expect(calls[1]).toEqual({ call: 2, totalCalls: 2, docNames: ['d-three.md', 'd-four.md'] });
  });
});
