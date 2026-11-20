import { describe, expect, it, vi } from 'vitest';
import type { AnonymizedChunk, PayloadLogEntry } from '../types';
import { PayloadBlockedError, synthesizeGraph } from './graphExtractor';

const { generateMock } = vi.hoisted(() => ({ generateMock: vi.fn() }));
vi.mock('../hybrid', () => ({ generate: generateMock }));

// NOTE: no module-level `beforeEach(() => mockReset())` here. vitest (4.x) mis-attributes
// a rejection settled under a beforeEach-reset config as an unhandled rejection when the
// mock rejects (verified repro 2026-11-20). Resetting inline at the top of each test works.

const validGraphJson = JSON.stringify({
  ventures: [], partners: [], products: [],
  dealRules: [{
    rule_id: 'r1', venture_id: 'v1', max_discount_pct_token: '[DISCOUNT_CAP_1]',
    min_qty_condition: '', requires_partner_approval: true,
    source_doc_name: 'DOC_1', page_or_section: '1',
    verbatim_blinded_excerpt: '[VENTURE_1] agrees with [PARTNER_1].',
  }],
});

const okResponse = { text: validGraphJson, usedOnDevice: false, model: 'test' };

function chunkA(): AnonymizedChunk {
  return {
    docName: 'a-agreement.md', page: 1, index: 0,
    text: '[VENTURE_1] agrees with [PARTNER_1]. Cap [DISCOUNT_CAP_1].',
    detected: [
      { text: 'Sari Dewi', token: '[PARTNER_1]', type: 'PARTNER' },
      { text: '40', token: '[COST_1]', type: 'COST' },
    ],
  };
}
function chunkB(): AnonymizedChunk {
  return {
    docName: 'b-notes.md', page: 1, index: 0,
    text: '[VENTURE_1] meeting notes.',
    detected: [{ text: 'Atelier Emily', token: '[VENTURE_1]', type: 'VENTURE' }],
  };
}

describe('pre-send privacy gate + record-before-send (CV-SEC-2)', () => {
  it('blocks the call and never reaches the model when a known value appears in the prompt', async () => {
    generateMock.mockReset();
    const leakyLegend = 'PARTNER_1 -> Sari Dewi'; // legend regressed to carrying real values
    const onPayload = vi.fn();
    await expect(synthesizeGraph([chunkA()], leakyLegend, onPayload)).rejects.toBeInstanceOf(PayloadBlockedError);
    expect(generateMock).not.toHaveBeenCalled();
    expect(onPayload).not.toHaveBeenCalled(); // nothing was sent, nothing recorded as sent
  });

  it('blocked error message names tokens only, never the raw values', async () => {
    generateMock.mockReset();
    const err = await synthesizeGraph([chunkA()], 'PARTNER_1 -> Sari Dewi').catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(PayloadBlockedError);
    const msg = (err as Error).message;
    expect(msg).toContain('[PARTNER_1]');
    expect(msg).not.toContain('Sari Dewi'); // raw partner name never surfaces
    expect(msg).not.toContain('40');        // raw value never surfaces
  });

  it('records the payload BEFORE the request: onPayload still sees it when generate rejects', async () => {
    generateMock.mockReset();
    generateMock.mockRejectedValue(new Error('network down'));
    const seen: PayloadLogEntry[] = [];
    let caught: Error | null = null;
    try {
      await synthesizeGraph([chunkA()], 'PARTNER_1 -> TYPE', (e) => seen.push(e));
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.message).toBe('network down');
    expect(seen.length).toBe(1);
    expect(seen[0].status).toBe('attempted');
    expect(seen[0].cloudText).toContain('[PARTNER_1]');
    expect(seen[0].sentAt).toBeGreaterThan(0);
    expect(seen[0].receivedAt).toBeUndefined();
  });

  it('keeps the first group recorded when the second group response is invalid JSON', async () => {
    generateMock.mockReset();
    generateMock
      .mockResolvedValueOnce(okResponse)
      .mockResolvedValueOnce({ text: 'not json at all', usedOnDevice: false, model: 'test' });
    const seen: PayloadLogEntry[] = [];
    await expect(synthesizeGraph([chunkA(), chunkB()], '', (e) => seen.push(e))).rejects.toThrow();
    expect(generateMock).toHaveBeenCalledTimes(2);
    const docNames = seen.map((e) => e.docName);
    expect(docNames).toContain('a-agreement.md');
    expect(docNames).toContain('b-notes.md');
    const aEntry = seen.find((e) => e.docName === 'a-agreement.md')!;
    expect(aEntry.status).toBe('responded'); // its cloud call completed
  });

  it('happy path: entry already exists (attempted) at the moment generate runs', async () => {
    generateMock.mockReset();
    const seen: PayloadLogEntry[] = [];
    let statusDuringCall: PayloadLogEntry['status'];
    generateMock.mockImplementation(async () => {
      statusDuringCall = seen[0]?.status; // observed from inside the outbound call
      return okResponse;
    });
    const { payloadLog } = await synthesizeGraph([chunkA()], '', (e) => seen.push(e));
    expect(statusDuringCall).toBe('attempted'); // record-before-send invariant
    expect(payloadLog.length).toBe(1);
    expect(payloadLog[0].status).toBe('responded');
    expect(payloadLog[0].receivedAt).toBeGreaterThanOrEqual(payloadLog[0].sentAt);
    expect(payloadLog[0].cloudText).toBe(generateMock.mock.calls[0][1]); // verbatim outbound string
  });

  it('blocks only the offending group: group 1 completes, group 2 never sends', async () => {
    generateMock.mockReset();
    generateMock.mockResolvedValue(okResponse);
    const leaked: AnonymizedChunk = {
      docName: 'b-notes.md', page: 1, index: 0,
      // anonymizer regression: this value was detected but NOT blinded in the text
      text: '[VENTURE_1] met Sari Dewi to discuss.',
      detected: [
        { text: 'Atelier Emily', token: '[VENTURE_1]', type: 'VENTURE' },
        { text: 'Sari Dewi', token: '[PARTNER_1]', type: 'PARTNER' },
      ],
    };
    const seen: PayloadLogEntry[] = [];
    let caught: Error | null = null;
    try {
      await synthesizeGraph([chunkA(), leaked], '', (e) => seen.push(e));
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(PayloadBlockedError);
    expect(generateMock).toHaveBeenCalledTimes(1); // group 2 never reached the model
    const group1 = seen.filter((e) => e.docName === 'a-agreement.md');
    expect(group1.length).toBe(1);
    expect(group1[0].status).toBe('responded');
    expect(seen.some((e) => e.docName === 'b-notes.md')).toBe(false); // blocked, never recorded as sent
  });

  it('distinct values sharing one token are each gated (no overwrite)', async () => {
    generateMock.mockReset();
    generateMock.mockResolvedValue(okResponse);
    // same token, two different values; the second chunk leaves the second value unblinded
    const first: AnonymizedChunk = {
      docName: 'a-agreement.md', page: 1, index: 0,
      text: 'terms with [PARTNER_1]',
      detected: [{ text: 'Sari Dewi', token: '[PARTNER_1]', type: 'PARTNER' }],
    };
    const second: AnonymizedChunk = {
      docName: 'b-notes.md', page: 1, index: 0,
      text: 'meeting with Emily Tan today.', // unblinded value for same token
      detected: [{ text: 'Emily Tan', token: '[PARTNER_1]', type: 'PARTNER' }],
    };
    await expect(synthesizeGraph([first, second], '')).rejects.toBeInstanceOf(PayloadBlockedError);
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it('existing callers without the optional callback keep working', async () => {
    generateMock.mockReset();
    generateMock.mockResolvedValue(okResponse);
    const { graph, payloadLog } = await synthesizeGraph([chunkA()], '');
    expect(graph.dealRules.length).toBe(1);
    expect(payloadLog[0].status).toBe('responded');
    expect(payloadLog[0].cloudText).toBe(generateMock.mock.calls[0][1]);
  });
});
