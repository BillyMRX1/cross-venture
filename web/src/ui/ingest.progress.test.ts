import { describe, expect, it } from 'vitest';
import type { KnowledgeGraph } from '../types';
import { formatSynthesizeProgress, mergeOrderedGraphSlots } from './ingest';

function graphFor(tag: string): KnowledgeGraph {
  return {
    ventures: [{ venture_id: `v-${tag}`, venture_token: '[VENTURE_1]', min_margin_pct_token: '[MARGIN_FLOOR_1]' }],
    partners: [],
    products: [],
    dealRules: [
      {
        rule_id: `r-${tag}`,
        venture_id: `v-${tag}`,
        max_discount_pct_token: '[DISCOUNT_CAP_1]',
        min_qty_condition: '',
        requires_partner_approval: false,
        source_doc_name: `${tag}.pdf`,
        page_or_section: '1',
        verbatim_blinded_excerpt: '[VENTURE_1]',
      },
    ],
  };
}

describe('stage 04 concurrent progress formatting', () => {
  it('shows done count, in-flight count, and active doc names', () => {
    const out = formatSynthesizeProgress({
      totalCalls: 5,
      inFlight: 2,
      done: 3,
      failed: 0,
      activeDocNames: ['d.pdf', 'e.pdf'],
      lastEvent: 'succeeded',
      call: 3,
      docNames: ['c.pdf'],
    });
    expect(out.text).toContain('3 of 5 done');
    expect(out.text).toContain('2 in flight');
    expect(out.text).toContain('d.pdf');
    expect(out.text).toContain('e.pdf');
    expect(out.metric).toBe('3/5 done');
  });

  it('notes failed count alongside done count when partial failures occur', () => {
    const out = formatSynthesizeProgress({
      totalCalls: 5,
      inFlight: 1,
      done: 3,
      failed: 1,
      activeDocNames: ['e.pdf'],
      lastEvent: 'failed',
      call: 3,
      docNames: ['c.pdf'],
    });
    expect(out.text).toContain('3 of 5 done');
    expect(out.text).toContain('1 failed');
    expect(out.text).toContain('1 in flight');
  });

  it('merges retried document slot back in original document order', () => {
    const slots = new Map<number, KnowledgeGraph>([
      [0, graphFor('doc1')],
      [1, graphFor('doc2')],
      [3, graphFor('doc4')],
      [4, graphFor('doc5')],
    ]);
    // Doc 3 (slot 2) succeeds on retry.
    slots.set(2, graphFor('doc3'));
    const merged = mergeOrderedGraphSlots(slots, 5);
    expect(merged.dealRules.map((r) => r.source_doc_name)).toEqual([
      'doc1.pdf',
      'doc2.pdf',
      'doc3.pdf',
      'doc4.pdf',
      'doc5.pdf',
    ]);
  });
});
