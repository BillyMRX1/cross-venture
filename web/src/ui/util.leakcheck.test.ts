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

  it('catches leading currency CODES (review F1): "USD 1,250" vs "1,250" and "IDR 1.500.000" vs "1500000"', () => {
    expect(findLeakedValues({ '[COST_1]': 'USD 1,250' }, 'cost 1,250 net', 'x').hits.length).toBe(1);
    expect(findLeakedValues({ '[PRICE_1]': 'IDR 1.500.000' }, 'total 1500000 paid', 'x').hits.length).toBe(1);
  });

  it('numbers glued to separators still hit (review F2): "Rp.1250" and "a,1250" CSV', () => {
    expect(findLeakedValues({ '[COST_1]': '1250' }, 'harga Rp.1250 per unit', 'x').hits.length).toBe(1);
    expect(findLeakedValues({ '[COST_1]': '1250' }, 'sku-7,a,1250,2', 'x').hits.length).toBe(1);
  });

  it('boundary regression after F2: 40 still misses "1400" and "1.400"', () => {
    expect(findLeakedValues({ '[COST_1]': '40' }, 'batch of 1400 units', 'x').hits.length).toBe(0);
    expect(findLeakedValues({ '[COST_1]': '40' }, 'harga 1.400 perak', 'x').hits.length).toBe(0);
    expect(findLeakedValues({ '[COST_1]': '40' }, 'qty 1,400 pcs', 'x').hits.length).toBe(0);
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

describe('findLeakedValues — placeholder tokens are masked before scanning', () => {
  // Real-world PDF regression (2026-11-24): docs with 10+ tokens of a type put
  // strings like [COST_15] in the prompt; a known short value "15" matched the
  // digits INSIDE the token and the gate blocked every send.

  it('token index digits never count as a leak: [COST_15] with known "15" → no hit', () => {
    const prompt = 'body [COST_15] [DISCOUNT_CAP_10] [PRICE_22] [VALUE_28] end';
    const map = {
      '[COST_1]': '15',
      '[DISCOUNT_CAP_1]': '10',
      '[PRICE_1]': '22',
      '[MARGIN_FLOOR_1]': '28',
    };
    expect(findLeakedValues(map, prompt, 'x').hits).toEqual([]);
  });

  it('real values written next to tokens still hit: "[COST_1] 15%" with known "15%"', () => {
    const { hits } = findLeakedValues({ '[COST_1]': '15%' }, 'see [COST_1] 15% off list', 'x');
    expect(hits.length).toBe(1);
    expect(hits[0].token).toBe('[COST_1]');
  });

  it('legend entries do not self-trip: "[MARGIN_FLOOR_15] (type: MARGIN_FLOOR)" with known "15"', () => {
    const legend = '[MARGIN_FLOOR_15] (type: MARGIN_FLOOR)';
    expect(findLeakedValues({ '[COST_1]': '15' }, legend, 'x').hits).toEqual([]);
  });

  it('masking keeps boundaries for text values too: "[SKU_2] Widget Deluxe" still hits "Widget Deluxe"', () => {
    const { hits } = findLeakedValues({ '[SKU_1]': 'Widget Deluxe' }, 'order [SKU_2] Widget Deluxe now', 'x');
    expect(hits.length).toBe(1);
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
