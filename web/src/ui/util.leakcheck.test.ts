import { describe, expect, it } from 'vitest';
import { findLeakedValues } from './util';

// CV-SEC-3 (security verification 2026-11-20, Patch 4): matcher accuracy +
// honest checked-count. Each positive case below was a MISS before the patch.

describe('findLeakedValues — numeric form coverage', () => {
  it('catches grouping/currency variants: $1,250.00 value vs "1,250.00" text', () => {
    const { hits } = findLeakedValues({ '[COST_1]': '$1,250.00' }, 'unit price 1,250.00 net', 'x');
    expect(hits.length).toBe(1);
    expect(hits[0].token).toBe('[COST_1]');
  });

  it('catches Indonesian grouping: value 1250 vs "Rp 1.250" text', () => {
    const { hits } = findLeakedValues({ '[COST_1]': '1250' }, 'harga Rp 1.250 per unit', 'x');
    expect(hits.length).toBe(1);
  });

  it('catches value 1.500.000 (id grouping) vs plain 1500000 in text', () => {
    const { hits } = findLeakedValues({ '[PRICE_1]': '1.500.000' }, 'total 1500000 rupiah', 'x');
    expect(hits.length).toBe(1);
  });

  it('catches percent spellings: value 55% vs "55 percent" text', () => {
    const { hits } = findLeakedValues({ '[MARGIN_FLOOR_1]': '55%' }, 'margin floor is 55 percent', 'x');
    expect(hits.length).toBe(1);
  });

  it('catches EUR prefix + grouping vs plain digits + suffix: €1,200 vs "1200 EUR"', () => {
    const { hits } = findLeakedValues({ '[PRICE_1]': '€1,200' }, 'listed at 1200 EUR', 'x');
    expect(hits.length).toBe(1);
  });

  it('keeps digit-boundary guards: value 40 does NOT hit "1400" or "[COST_1]"', () => {
    expect(findLeakedValues({ '[COST_1]': '40' }, 'batch of 1400 units', 'x').hits.length).toBe(0);
    expect(findLeakedValues({ '[COST_1]': '40' }, 'see [COST_1] token', 'x').hits.length).toBe(0);
  });
});

describe('findLeakedValues — PARTNER name partials (mirrors anonymizer sweep pass B)', () => {
  it('PARTNER first word: value "Sari Dewi" vs "Sari signed the deal"', () => {
    const { hits } = findLeakedValues({ '[PARTNER_1]': 'Sari Dewi' }, 'Sari signed the deal', 'x');
    expect(hits.length).toBe(1);
  });

  it('PARTNER last word: value "Sari Dewi" vs "Dewi approved"', () => {
    const { hits } = findLeakedValues({ '[PARTNER_1]': 'Sari Dewi' }, 'Dewi approved', 'x');
    expect(hits.length).toBe(1);
  });

  it('non-PARTNER tokens are NOT partial-matched: "Atelier Emily" vs "Emily said" → no hit', () => {
    const { hits } = findLeakedValues({ '[VENTURE_1]': 'Atelier Emily' }, 'Emily said', 'x');
    expect(hits.length).toBe(0);
  });
});

describe('findLeakedValues — honest checked count', () => {
  it('counts only values actually scanned (skips <2-char values)', () => {
    const map = { '[COST_1]': '40', '[PARTNER_1]': 'Sari Dewi', '[X_1]': 'X' };
    const scan = findLeakedValues(map, 'nothing relevant here', 'x');
    expect(scan.checked).toBe(2);
    expect(scan.hits.length).toBe(0);
  });
});
