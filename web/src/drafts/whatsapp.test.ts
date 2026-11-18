import { describe, expect, it } from 'vitest';
import { evaluateDeal } from '../calc/marginEngine';
import type { DealInput, DraftContext } from '../types';
import { buildDrafts } from './whatsapp';

const context = (partnerName: string | null = 'Emily'): DraftContext => ({
  buyerName: 'Dana',
  skuName: 'Linen Shirt',
  ventureName: 'Atelier Emily',
  partnerName,
  citation: 'Agreement.pdf p.3 S4.3',
});

function deal(overrides: Partial<DealInput> = {}): DealInput {
  return {
    listPrice: 100,
    cogs: 40,
    marginFloorPct: 55,
    discountCapPct: 10,
    requiresPartnerApproval: true,
    requestedDiscountPct: 20,
    qty: 30,
    ...overrides,
  };
}

describe('buildDrafts', () => {
  it('builds breach messages with a pending option and partner sign-off message', () => {
    const input = deal();
    const drafts = buildDrafts(input, evaluateDeal(input), context());
    expect(drafts.buyerReply).toContain('Dana');
    expect(drafts.buyerReply).toContain('10% off');
    expect(drafts.buyerReply).toContain('Linen Shirt');
    expect(drafts.buyerReply).toContain('11.11');
    expect(drafts.buyerReply).toContain('Rule source: Agreement.pdf p.3 S4.3');
    expect(drafts.buyerReply.endsWith('Rule source: Agreement.pdf p.3 S4.3')).toBe(true);
    expect(drafts.buyerReply).not.toContain('*');
    expect(drafts.partnerMessage).toContain('Emily');
    expect(drafts.partnerMessage).toContain('11.11');
    expect(drafts.partnerMessage).toContain('30 x Linen Shirt');
    expect(drafts.partnerMessage?.endsWith('Rule source: Agreement.pdf p.3 S4.3')).toBe(true);
  });

  it('omits a partner message for a solo venture', () => {
    const input = deal({
      listPrice: 250,
      cogs: 90,
      marginFloorPct: 55,
      discountCapPct: null,
      requiresPartnerApproval: false,
      requestedDiscountPct: 25,
      qty: 8,
    });
    const drafts = buildDrafts(input, evaluateDeal(input), context(null));
    expect(drafts.partnerMessage).toBe(null);
    expect(drafts.buyerReply).toContain('20% off');
    expect(drafts.buyerReply).toContain('Rule source: Agreement.pdf p.3 S4.3');
  });

  it('builds an approved buyer reply without a partner message', () => {
    const input = deal({ requestedDiscountPct: 5 });
    const drafts = buildDrafts(input, evaluateDeal(input), context());
    expect(drafts.buyerReply).toContain('5% off');
    expect(drafts.partnerMessage).toBe(null);
  });
});
