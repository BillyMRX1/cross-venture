import { describe, expect, it } from 'vitest';
import type { ProductNode, TokenMap, Workspace } from '../types';
import {
  cleanProductOptions,
  cleanSkuLabel,
  isContractOrPriceLabel,
  isRawPlaceholderId,
  isUnnamedSkuCode,
  resolveProductName,
} from './productPicker';

function makeWorkspace(products: ProductNode[], tokenMap: TokenMap = {}): Workspace {
  return {
    id: 'ws-test',
    name: 'Test Workspace',
    graph: {
      ventures: [
        { venture_id: 'v1', venture_token: '[VENTURE_1]', min_margin_pct_token: '[MARGIN_FLOOR_1]' },
        { venture_id: 'v2', venture_token: '[VENTURE_2]', min_margin_pct_token: '[MARGIN_FLOOR_2]' },
      ],
      partners: [],
      products,
      dealRules: [],
    },
    tokenMap,
    docs: [],
    payloadLog: [],
    updatedAt: 0,
  };
}

describe('isRawPlaceholderId', () => {
  it('rejects empty and whitespace-only strings', () => {
    expect(isRawPlaceholderId('')).toBe(true);
    expect(isRawPlaceholderId('   ')).toBe(true);
    expect(isRawPlaceholderId('\t\n')).toBe(true);
  });

  it('rejects unresolved placeholder tokens (bracketed and unbracketed)', () => {
    for (const s of [
      '[SKU_1]',
      '[PRODUCT_2]',
      '[COST_1]',
      '[SKU_1#2]',
      'SKU_1',
      'VENTURE_2',
      'PARTNER_3',
      'Dress [SKU_1]',
    ]) {
      expect(isRawPlaceholderId(s), s).toBe(true);
    }
  });

  it('rejects raw placeholder-style ids', () => {
    for (const s of [
      'sku_1',
      'sku_2',
      'sku_3',
      'sku_4',
      'sku-1',
      'sku1',
      'SKU-1',
      'prod_1',
      'product_2',
      'item_3',
      'p_1',
      'p1',
    ]) {
      expect(isRawPlaceholderId(s), s).toBe(true);
    }
  });

  it('rejects pure numeric, currency, and percent strings', () => {
    for (const s of ['40', '$100', '$1,250.00', '55%', '12.5%', '100 USD', '€50', 'Rp 50.000']) {
      expect(isRawPlaceholderId(s), s).toBe(true);
    }
  });

  it('accepts real product names and real document SKU codes', () => {
    for (const s of [
      'Aurora Linen Dress',
      'House Blend 250g',
      'Advisory day',
      'SKU-RL01',
      'SKU-RL02',
      'RL-01',
      'AE-DR01',
      'PRD-104A',
      'ITEM-A01',
      'RL01',
    ]) {
      expect(isRawPlaceholderId(s), s).toBe(false);
    }
  });
});

describe('isContractOrPriceLabel', () => {
  it('rejects structural document headings', () => {
    for (const s of [
      'Schedule A',
      'Appendix B',
      'Exhibit 1',
      'Annex II',
      'Attachment 1',
      'Article 4',
      'Section 4.3',
      'Clause 5',
      'Part A',
      'Item 2',
      'Table 1',
      'Figure 3',
      'Form 1',
      'Page 2',
      'Recitals',
      'Definitions',
      'Core Collection',
      'Notes',
      'Summary',
      'Terms and Conditions',
    ]) {
      expect(isContractOrPriceLabel(s), s).toBe(true);
    }
  });

  it('rejects price-field, financial, and contract header labels', () => {
    for (const s of [
      'Net Realized Unit Price',
      'Wholesale List Price',
      'Standard List Price',
      'List Price',
      'Price List',
      'Retail Price',
      'Unit Price',
      'Net Selling Price',
      'Unit Cost',
      'Direct Unit Cost',
      'Cost of Goods Sold',
      'COGS',
      'Gross Margin',
      'Net Margin',
      'Margin Floor',
      'Discount Cap',
      'Wholesale Price',
      'Published Retail Price',
      'Realized Unit Price',
      'Net Unit Price',
      'Suggested Retail Price',
      'MSRP',
      'Rate Card',
      'Minimum Margin Floor',
      'Maximum Discount Cap',
      'Unit Price ($)',
      'Gross Margin (%)',
      'Total Revenue',
      'Subtotal',
    ]) {
      expect(isContractOrPriceLabel(s), s).toBe(true);
    }
  });

  it('never rejects real product names or unnamed SKU codes', () => {
    for (const s of [
      'Aurora Linen Dress',
      'Solstice Silk Blouse',
      'Meadow Cotton Skirt',
      'Advisory day',
      'Single Origin Espresso',
      'House Blend 250g',
      'Cold Brew Concentrate',
      'Espresso Cap',
      'SKU-RL01',
      'RL-01',
      'CAP-01',
    ]) {
      expect(isContractOrPriceLabel(s), s).toBe(false);
    }
  });
});

describe('isUnnamedSkuCode', () => {
  it('recognizes real document SKU codes without human names', () => {
    for (const s of [
      'SKU-RL01',
      'SKU-RL02',
      'SKU-RL03',
      'RL-01',
      'AE-DR01',
      'PRD-104A',
      'ITEM-A01',
      'RL01',
      'DR100',
      'RL/01',
    ]) {
      expect(isUnnamedSkuCode(s), s).toBe(true);
    }
  });

  it('returns false for raw placeholder ids, multi-word product names, and non-codes', () => {
    for (const s of [
      'sku_1',
      'sku_2',
      'SKU_1',
      '[SKU_1]',
      'prod_1',
      'p1',
      'Aurora Linen Dress',
      'House Blend 250g',
      'Cold Brew Concentrate',
      '40',
      'ABC',
      'A1',
      'A'.repeat(24) + '1',
    ]) {
      expect(isUnnamedSkuCode(s), s).toBe(false);
    }
  });
});

describe('resolveProductName', () => {
  it('hydrates bracketed sku_token from ws.tokenMap', () => {
    const ws = makeWorkspace([], { '[SKU_1]': '  Aurora Linen Dress  ' });
    const p: ProductNode = {
      sku_id: 'sku_1',
      sku_token: '[SKU_1]',
      venture_id: 'v1',
      cogs_token: '[COST_1]',
      list_price_token: '[PRICE_1]',
    };
    expect(resolveProductName(ws, p)).toBe('Aurora Linen Dress');
  });

  it('rehydrates composite strings containing bracketed tokens', () => {
    const ws = makeWorkspace([], { '[SKU_1]': 'House Blend' });
    const p: ProductNode = {
      sku_id: 'sku_1',
      sku_token: '[SKU_1] 250g',
      venture_id: 'v1',
      cogs_token: '',
      list_price_token: '',
    };
    expect(resolveProductName(ws, p)).toBe('House Blend 250g');
  });

  it('returns null when bracketed sku_token is missing from tokenMap (never falls back to sku_id)', () => {
    const ws = makeWorkspace([], {});
    const p1: ProductNode = {
      sku_id: 'sku_1',
      sku_token: '[SKU_1]',
      venture_id: 'v1',
      cogs_token: '',
      list_price_token: '',
    };
    const p2: ProductNode = {
      sku_id: 'SKU-RL01',
      sku_token: '[SKU_99]',
      venture_id: 'v1',
      cogs_token: '',
      list_price_token: '',
    };
    const p3: ProductNode = {
      sku_id: 'sku_3',
      sku_token: '[SKU_99] 250g',
      venture_id: 'v1',
      cogs_token: '',
      list_price_token: '',
    };
    expect(resolveProductName(ws, p1)).toBeNull();
    expect(resolveProductName(ws, p2)).toBeNull();
    expect(resolveProductName(ws, p3)).toBeNull();
  });

  it('uses literal non-bracketed sku_token when valid (e.g. SKU-RL01)', () => {
    const ws = makeWorkspace([], {});
    const p: ProductNode = {
      sku_id: 'sku_5',
      sku_token: 'SKU-RL01',
      venture_id: 'v1',
      cogs_token: '',
      list_price_token: '',
    };
    expect(resolveProductName(ws, p)).toBe('SKU-RL01');
  });

  it('only falls back to sku_id when sku_token is empty AND sku_id is a valid unnamed SKU code', () => {
    const ws = makeWorkspace([], {});
    const validCode: ProductNode = {
      sku_id: 'SKU-RL02',
      sku_token: '',
      venture_id: 'v1',
      cogs_token: '',
      list_price_token: '',
    };
    const rawId: ProductNode = {
      sku_id: 'sku_1',
      sku_token: '',
      venture_id: 'v1',
      cogs_token: '',
      list_price_token: '',
    };
    expect(resolveProductName(ws, validCode)).toBe('SKU-RL02');
    expect(resolveProductName(ws, rawId)).toBeNull();
  });

  it('drops hydrated contract headings, price-field labels, and currency values', () => {
    const ws = makeWorkspace([], {
      '[SKU_1]': 'Net Realized Unit Price',
      '[SKU_2]': 'Wholesale List Price',
      '[SKU_3]': 'Schedule A',
      '[SKU_4]': '$100',
    });
    for (const idx of [1, 2, 3, 4]) {
      const p: ProductNode = {
        sku_id: `sku_${idx}`,
        sku_token: `[SKU_${idx}]`,
        venture_id: 'v1',
        cogs_token: '',
        list_price_token: '',
      };
      expect(resolveProductName(ws, p)).toBeNull();
    }
  });
});

describe('cleanProductOptions', () => {
  it('filters by ventureId, removes junk, formats unnamed codes, and sorts named first then codes numerically', () => {
    const ws = makeWorkspace(
      [
        // Junk from real tester screenshot
        { sku_id: 'sku_1', sku_token: '[SKU_MISSING_1]', venture_id: 'v1', cogs_token: '', list_price_token: '' },
        { sku_id: 'sku_2', sku_token: 'sku_2', venture_id: 'v1', cogs_token: '', list_price_token: '' },
        { sku_id: 'sku_3', sku_token: '[SKU_3]', venture_id: 'v1', cogs_token: '', list_price_token: '' }, // Net Realized Unit Price
        { sku_id: 'sku_4', sku_token: '[SKU_4]', venture_id: 'v1', cogs_token: '', list_price_token: '' }, // Wholesale List Price
        { sku_id: 'sku_5', sku_token: '[SKU_5]', venture_id: 'v1', cogs_token: '', list_price_token: '' }, // Standard List Price
        // Unnamed codes (out of order)
        { sku_id: 'c10', sku_token: 'SKU-RL10', venture_id: 'v1', cogs_token: '[COST_1]', list_price_token: '[PRICE_1]' },
        { sku_id: 'c2', sku_token: 'SKU-RL02', venture_id: 'v1', cogs_token: '[COST_1]', list_price_token: '[PRICE_1]' },
        { sku_id: 'c1', sku_token: 'SKU-RL01', venture_id: 'v1', cogs_token: '[COST_1]', list_price_token: '[PRICE_1]' },
        // Named products (out of order)
        { sku_id: 'p_sol', sku_token: '[SKU_10]', venture_id: 'v1', cogs_token: '[COST_1]', list_price_token: '[PRICE_1]' },
        { sku_id: 'p_aur', sku_token: '[SKU_11]', venture_id: 'v1', cogs_token: '[COST_1]', list_price_token: '[PRICE_1]' },
        { sku_id: 'p_mea', sku_token: '[SKU_12]', venture_id: 'v1', cogs_token: '[COST_1]', list_price_token: '[PRICE_1]' },
        // Another venture — must be excluded
        { sku_id: 'p_other', sku_token: '[SKU_13]', venture_id: 'v2', cogs_token: '[COST_1]', list_price_token: '[PRICE_1]' },
      ],
      {
        '[SKU_3]': 'Net Realized Unit Price',
        '[SKU_4]': 'Wholesale List Price',
        '[SKU_5]': 'Standard List Price',
        '[SKU_10]': 'Solstice Silk Blouse',
        '[SKU_11]': 'Aurora Linen Dress',
        '[SKU_12]': 'Meadow Cotton Skirt',
        '[SKU_13]': 'Single Origin Espresso',
        '[COST_1]': '$40',
        '[PRICE_1]': '$120',
      },
    );

    const options = cleanProductOptions(ws, 'v1');
    expect(options).toEqual([
      { skuId: 'p_aur', label: 'Aurora Linen Dress', rawName: 'Aurora Linen Dress', isUnnamedCode: false },
      { skuId: 'p_mea', label: 'Meadow Cotton Skirt', rawName: 'Meadow Cotton Skirt', isUnnamedCode: false },
      { skuId: 'p_sol', label: 'Solstice Silk Blouse', rawName: 'Solstice Silk Blouse', isUnnamedCode: false },
      { skuId: 'c1', label: 'SKU-RL01 (no name in documents)', rawName: 'SKU-RL01', isUnnamedCode: true },
      { skuId: 'c2', label: 'SKU-RL02 (no name in documents)', rawName: 'SKU-RL02', isUnnamedCode: true },
      { skuId: 'c10', label: 'SKU-RL10 (no name in documents)', rawName: 'SKU-RL10', isUnnamedCode: true },
    ]);
  });

  it('deduplicates by normalized label and prefers richer pricing data (both > one > first)', () => {
    const ws = makeWorkspace(
      [
        // Neither valid
        { sku_id: 'a0', sku_token: '[SKU_21]', venture_id: 'v1', cogs_token: '', list_price_token: '' },
        // One valid
        { sku_id: 'a1', sku_token: '[SKU_22]', venture_id: 'v1', cogs_token: '', list_price_token: '[PRICE_1]' },
        // Both valid — should win
        { sku_id: 'a2', sku_token: '[SKU_23]', venture_id: 'v1', cogs_token: '[COST_1]', list_price_token: '[PRICE_1]' },
        // Another with both valid — tie goes to earlier winner (a2)
        { sku_id: 'a3', sku_token: '[SKU_21]', venture_id: 'v1', cogs_token: '[COST_1]', list_price_token: '[PRICE_1]' },
      ],
      {
        '[SKU_21]': 'Aurora Linen Dress',
        '[SKU_22]': 'aurora   linen dress',
        '[SKU_23]': 'Aurora Linen Dress ',
        '[COST_1]': '$40',
        '[PRICE_1]': '$120',
      },
    );

    const options = cleanProductOptions(ws, 'v1');
    expect(options).toHaveLength(1);
    expect(options[0].skuId).toBe('a2');
  });
});

describe('cleanSkuLabel', () => {
  it('returns real name, unnamed code label, or empty string for junk/missing', () => {
    const ws = makeWorkspace(
      [
        { sku_id: 'p1', sku_token: '[SKU_1]', venture_id: 'v1', cogs_token: '', list_price_token: '' },
        { sku_id: 'p2', sku_token: 'SKU-RL01', venture_id: 'v1', cogs_token: '', list_price_token: '' },
        { sku_id: 'p3', sku_token: '[SKU_3]', venture_id: 'v1', cogs_token: '', list_price_token: '' },
        { sku_id: 'p4', sku_token: '[SKU_99]', venture_id: 'v1', cogs_token: '', list_price_token: '' },
      ],
      {
        '[SKU_1]': 'Aurora Linen Dress',
        '[SKU_3]': 'Net Realized Unit Price',
      },
    );

    expect(cleanSkuLabel(ws, 'p1')).toBe('Aurora Linen Dress');
    expect(cleanSkuLabel(ws, 'p2')).toBe('SKU-RL01 (no name in documents)');
    expect(cleanSkuLabel(ws, 'p3')).toBe('');
    expect(cleanSkuLabel(ws, 'p4')).toBe('');
    expect(cleanSkuLabel(ws, 'nonexistent')).toBe('');
  });
});
