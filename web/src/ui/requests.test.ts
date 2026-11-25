// Request-record layer tests (Node environment — the pure half of the
// Requests page). Covers: localStorage persistence, live pricing rows from
// the margin engine, and the approval copy naming the graph partner.
import { describe, expect, it } from 'vitest';
import type { Workspace } from '../types';
import {
  approvalInfo,
  computeRecordDeal,
  fmtPct1,
  loadRequests,
  newRecord,
  nextRequestId,
  partnerNameOf,
  pricingRows,
  pushActivity,
  saveRequests,
  statusLabel,
  type RequestRecord,
} from './requestModel';

// state.ts persists through window.localStorage; stub it for the Node run.
const mem: Record<string, string> = {};
(globalThis as Record<string, unknown>).window = {
  localStorage: {
    getItem: (k: string): string | null => (k in mem ? mem[k] : null),
    setItem: (k: string, v: string): void => {
      mem[k] = v;
    },
  },
};

/* Scenario A: Atelier Emily — floor 55%, cap 10%, partner Emily Hartono.
   Founders in the document are Emily Hartono AND Sari Wijaya; the partner
   who signs off above-cap discounts is Emily. */
const ATELIER: Workspace = {
  id: 'ws-ae',
  name: 'Atelier Emily',
  graph: {
    ventures: [{ venture_id: 'v-ae', venture_token: '[VENTURE_1]', min_margin_pct_token: '[MARGIN_FLOOR_1]' }],
    partners: [
      { partner_id: 'p-sari', partner_token: '[PARTNER_2]', venture_id: 'v-ae', approval_rules: 'consult where production capacity is affected' },
      { partner_id: 'p-emily', partner_token: '[PARTNER_1]', venture_id: 'v-ae', approval_rules: 'signs off discounts above the 10% cap' },
    ],
    products: [{ sku_id: 'sku-dress', sku_token: '[SKU_1]', venture_id: 'v-ae', cogs_token: '[COST_1]', list_price_token: '[PRICE_1]' }],
    dealRules: [
      {
        rule_id: 'R-43',
        venture_id: 'v-ae',
        max_discount_pct_token: '[DISCOUNT_CAP_1]',
        min_qty_condition: '60 or more units',
        requires_partner_approval: true,
        source_doc_name: 'atelier-emily-partnership-agreement.md',
        page_or_section: '§4.3',
        verbatim_blinded_excerpt: 'discounts of up to [DISCOUNT_CAP_1] may be granted without co-founder approval',
      },
    ],
  },
  tokenMap: {
    '[VENTURE_1]': 'Atelier Emily',
    '[MARGIN_FLOOR_1]': '55',
    '[PARTNER_1]': 'Emily Hartono',
    '[PARTNER_2]': 'Sari Wijaya',
    '[SKU_1]': 'Aurora Linen Dress',
    '[COST_1]': '40',
    '[PRICE_1]': '100',
    '[DISCOUNT_CAP_1]': '10',
  },
  docs: [],
  payloadLog: [],
  updatedAt: 1,
};

/* Scenario B: Nomad Studio — solo, no partner, no cap. */
const SOLO: Workspace = {
  id: 'ws-ns',
  name: 'Nomad Studio',
  graph: {
    ventures: [{ venture_id: 'v-ns', venture_token: '[VENTURE_2]', min_margin_pct_token: '[MARGIN_FLOOR_2]' }],
    partners: [],
    products: [{ sku_id: 'sku-day', sku_token: '[SKU_2]', venture_id: 'v-ns', cogs_token: '[COST_2]', list_price_token: '[PRICE_2]' }],
    dealRules: [],
  },
  tokenMap: {
    '[VENTURE_2]': 'Nomad Studio',
    '[MARGIN_FLOOR_2]': '55',
    '[SKU_2]': 'Advisory day',
    '[COST_2]': '90',
    '[PRICE_2]': '250',
  },
  docs: [],
  payloadLog: [],
  updatedAt: 1,
};

function record(over: Partial<RequestRecord> = {}): RequestRecord {
  return {
    id: 'DR-0001',
    ventureId: 'v-ae',
    createdAt: 1,
    customer: 'Lumen Boutique',
    skuId: 'sku-dress',
    discountPct: 20,
    qty: 30,
    activity: [{ at: 1, kind: 'created', note: 'Request created' }],
    ...over,
  };
}

describe('request record persistence (localStorage)', () => {
  it('saves records under a stable key and reads them back', () => {
    expect(loadRequests()).toEqual([]);
    const rec = newRecord('v-ae');
    rec.id = nextRequestId(loadRequests());
    expect(rec.id).toBe('DR-0001');
    rec.customer = 'Lumen Boutique';
    rec.skuId = 'sku-dress';
    rec.discountPct = 20;
    rec.qty = 30;
    pushActivity(rec, 'applied', 'Applied suggested 10% and saved');
    saveRequests([rec]);

    const again = loadRequests();
    expect(again).toEqual([rec]);
    expect(again[0].activity.map((a) => a.kind)).toEqual(['created', 'applied']);
    expect(nextRequestId(again)).toBe('DR-0002');
  });

  it('ignores corrupt storage instead of crashing', () => {
    mem['cv.requests'] = '{not json';
    expect(loadRequests()).toEqual([]);
    delete mem['cv.requests'];
  });

  it('does not repeat identical consecutive activity events', () => {
    const rec = record();
    pushActivity(rec, 'checked', 'Checked — suggested 10%');
    pushActivity(rec, 'checked', 'Checked — suggested 10%');
    expect(rec.activity.filter((a) => a.kind === 'checked').length).toBe(1);
  });
});

describe('live pricing rows recompute from the margin engine', () => {
  it('20% × 30 units: requested 50.0% below floor; suggested 10% → $90 at 55.6%', () => {
    const deal = computeRecordDeal(ATELIER, record({ discountPct: 20, qty: 30 }));
    expect(deal.errors).toEqual([]);
    expect(deal.verdict?.badge).toBe('MARGIN BREACH');

    const rows = pricingRows(deal);
    expect(rows).not.toBeNull();
    const { requested, suggested } = rows!;
    expect(requested.discountPct).toBe(20);
    expect(requested.unitPrice).toBe(80);
    expect(fmtPct1(requested.marginPct)).toBe('50.0%');
    expect(requested.belowFloor).toBe(true);

    expect(suggested.discountPct).toBe(10);
    expect(suggested.unitPrice).toBe(90);
    expect(fmtPct1(suggested.marginPct)).toBe('55.6%');
    expect(suggested.belowFloor).toBe(false);
  });

  it('invalid edits surface guardrail errors instead of numbers', () => {
    const deal = computeRecordDeal(ATELIER, record({ discountPct: 120 }));
    expect(deal.errors.some((e) => e.includes('Discount'))).toBe(true);
    expect(deal.verdict).toBeNull();
    expect(pricingRows(deal)).toBeNull();
  });
});

describe('approval copy names the graph partner', () => {
  it('picks the signing partner (Emily), not the other founder', () => {
    expect(partnerNameOf(ATELIER, 'v-ae')).toBe('Emily Hartono');
  });

  it('above-cap case: partner draft and copy button both say Emily, never Sari', () => {
    const info = approvalInfo(computeRecordDeal(ATELIER, record({ discountPct: 20, qty: 30 })));
    expect(info.needed).toBe(true);
    expect(info.buttonLabel).toContain('Emily');
    expect(info.message).toContain('Emily');
    const blob = JSON.stringify(info);
    expect(blob).not.toContain('Sari');
  });

  it('solo venture: no partner UI at all, only the no-approval note', () => {
    expect(partnerNameOf(SOLO, 'v-ns')).toBeNull();
    const info = approvalInfo(computeRecordDeal(SOLO, record({ ventureId: 'v-ns', skuId: 'sku-day', discountPct: 20, qty: 1 })));
    expect(info.needed).toBe(false);
    expect(info.note).toBe('Suggested offer needs no partner approval');
    expect(info.message).toBeNull();
    expect(info.buttonLabel).toBeNull();
  });

  it('status badges use product copy for the three verdicts', () => {
    expect(statusLabel('APPROVED')).toBe('Approved');
    expect(statusLabel('PARTNER SIGN-OFF NEEDED')).toBe('Partner sign-off needed');
    expect(statusLabel('MARGIN BREACH')).toBe('Margin breach');
  });
});
