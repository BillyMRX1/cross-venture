import { afterEach, describe, expect, it } from 'vitest';
import type { Workspace } from '../types';
import {
  deduplicateWorkspace,
  docNamesByVenture,
  groupDocumentsByVenture,
  mergeWorkspaces,
  normalizeVentureName,
  removeDocumentFromWorkspace,
  removeVentureFromWorkspace,
} from './workspaceOps';
import {
  clearWorkspacesLocal,
  loadAndMigrateWorkspaceLocal,
  loadWorkspaceLocal,
  saveWorkspaceLocal,
} from './db';

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    name: 'Agreement.pdf',
    graph: {
      ventures: [],
      partners: [],
      products: [],
      dealRules: [],
    },
    tokenMap: {},
    docs: [],
    payloadLog: [],
    updatedAt: 1000,
    ...overrides,
  };
}

describe('normalizeVentureName', () => {
  it('normalizes LLC variants identically', () => {
    const variants = [
      'Atelier Emily',
      'Atelier Emily LLC',
      'Atelier Emily L.L.C.',
      'atelier emily, llc.',
      'Atelier Emily L L C',
      '  Atelier   Emily,  L.L.C. ',
    ];
    for (const v of variants) {
      expect(normalizeVentureName(v)).toBe('atelier emily');
    }
  });

  it('normalizes Nomad Studio and leading "The"', () => {
    expect(normalizeVentureName('Nomad Studio')).toBe('nomad studio');
    expect(normalizeVentureName('Nomad Studio LLC')).toBe('nomad studio');
    expect(normalizeVentureName('The Nomad Studio')).toBe('nomad studio');
    expect(normalizeVentureName('The Nomad Studio, Inc.')).toBe('nomad studio');
  });

  it('normalizes Inc / Incorporated variants identically', () => {
    expect(normalizeVentureName('RoastLab Specialty Roasters Inc.')).toBe(
      'roastlab specialty roasters'
    );
    expect(normalizeVentureName('RoastLab Specialty Roasters, Inc')).toBe(
      'roastlab specialty roasters'
    );
    expect(normalizeVentureName('RoastLab Specialty Roasters Incorporated')).toBe(
      'roastlab specialty roasters'
    );
  });

  it('strips Indonesian prefixes PT / CV after dot removal', () => {
    expect(normalizeVentureName('PT Kopi Nusantara')).toBe('kopi nusantara');
    expect(normalizeVentureName('PT. Kopi Nusantara')).toBe('kopi nusantara');
    expect(normalizeVentureName('P.T. Kopi Nusantara')).toBe('kopi nusantara');
    expect(normalizeVentureName('CV Maju Jaya')).toBe('maju jaya');
    expect(normalizeVentureName('C.V. Maju Jaya')).toBe('maju jaya');
  });

  it('strips repeated, punctuated, and international legal entity suffixes', () => {
    expect(normalizeVentureName('Acme Pte. Ltd.')).toBe('acme');
    expect(normalizeVentureName('Acme Co., Ltd.')).toBe('acme');
    expect(normalizeVentureName('Acme & Co.')).toBe('acme');
    expect(normalizeVentureName('Acme Corp.')).toBe('acme');
    expect(normalizeVentureName('Acme Corporation')).toBe('acme');
    expect(normalizeVentureName('Acme Limited')).toBe('acme');
    expect(normalizeVentureName('Acme Company')).toBe('acme');
    expect(normalizeVentureName('Acme GmbH')).toBe('acme');
    expect(normalizeVentureName('Acme S.A.')).toBe('acme');
    expect(normalizeVentureName('Acme B.V.')).toBe('acme');
    expect(normalizeVentureName('Acme AB')).toBe('acme');
    expect(normalizeVentureName('Acme LP')).toBe('acme');
    expect(normalizeVentureName('Acme L.L.P.')).toBe('acme');
    expect(normalizeVentureName('Acme PLC')).toBe('acme');
    expect(normalizeVentureName('Acme AG')).toBe('acme');
    expect(normalizeVentureName('Acme N.V.')).toBe('acme');
    expect(normalizeVentureName('Acme S.R.L.')).toBe('acme');
    expect(normalizeVentureName('Acme SAS')).toBe('acme');
    expect(normalizeVentureName('Acme K.K.')).toBe('acme');
    expect(normalizeVentureName('North-West "Craft" Goods, Ltd.')).toBe(
      'north west craft goods'
    );
  });

  it('returns empty string for empty or whitespace input', () => {
    expect(normalizeVentureName('')).toBe('');
    expect(normalizeVentureName('   ')).toBe('');
  });
});

describe('docNamesByVenture and groupDocumentsByVenture', () => {
  it('associates documents via dealRules and blindedText token scan, and groups unassigned docs', () => {
    const ws = makeWorkspace({
      tokenMap: {
        '[VENTURE_1]': 'Atelier Emily',
        '[VENTURE_2]': 'Nomad Studio',
        '[PARTNER_1]': 'Sarah Chen',
        '[SKU_1]': 'Silk Dress',
        '[SKU_2]': 'Canvas Tote',
        '[MARGIN_FLOOR_1]': '55%',
        '[DISCOUNT_CAP_1]': '15%',
        '[COST_1]': '40',
        '[PRICE_1]': '120',
      },
      graph: {
        ventures: [
          { venture_id: 'v1', venture_token: '[VENTURE_1]', min_margin_pct_token: '[MARGIN_FLOOR_1]' },
          { venture_id: 'v2', venture_token: '[VENTURE_2]', min_margin_pct_token: '' },
        ],
        partners: [
          { partner_id: 'p1', partner_token: '[PARTNER_1]', venture_id: 'v1', approval_rules: 'Over 15%' },
        ],
        products: [
          { sku_id: 's1', sku_token: '[SKU_1]', venture_id: 'v1', cogs_token: '[COST_1]', list_price_token: '[PRICE_1]' },
          { sku_id: 's2', sku_token: '[SKU_2]', venture_id: 'v2', cogs_token: '[COST_1]', list_price_token: '[PRICE_1]' },
        ],
        dealRules: [
          {
            rule_id: 'r1',
            venture_id: 'v1',
            max_discount_pct_token: '[DISCOUNT_CAP_1]',
            min_qty_condition: '>= 10',
            requires_partner_approval: true,
            source_doc_name: 'Agreement.pdf',
            page_or_section: 'p.1',
            verbatim_blinded_excerpt: 'Max discount [DISCOUNT_CAP_1]',
          },
          {
            rule_id: 'r2',
            venture_id: 'v1',
            max_discount_pct_token: '[DISCOUNT_CAP_1]',
            min_qty_condition: '>= 50',
            requires_partner_approval: false,
            source_doc_name: 'Agreement.pdf',
            page_or_section: 'p.2',
            verbatim_blinded_excerpt: 'Bulk terms',
          },
        ],
      },
      docs: [
        { docName: 'Agreement.pdf', page: 1, index: 0, blindedText: 'Terms for [VENTURE_1] with [PARTNER_1].' },
        { docName: 'Agreement.pdf', page: 1, index: 1, blindedText: 'Additional clause on page 1.' },
        { docName: 'Agreement.pdf', page: 2, index: 2, blindedText: 'Bulk terms for [SKU_1].' },
        { docName: 'Catalog.pdf', page: 1, index: 0, blindedText: 'Featured item: [SKU_2] list price [PRICE_1].' },
        { docName: 'MiscNotes.pdf', page: 1, index: 0, blindedText: 'General shipping FAQ with no venture tokens.' },
      ],
    });

    const byVenture = docNamesByVenture(ws);
    expect([...(byVenture.get('v1') ?? [])]).toEqual(['Agreement.pdf']);
    expect([...(byVenture.get('v2') ?? [])]).toEqual(['Catalog.pdf']);

    const groups = groupDocumentsByVenture(ws);
    expect(groups).toEqual([
      {
        ventureId: 'v1',
        ventureName: 'Atelier Emily',
        docs: [{ docName: 'Agreement.pdf', pages: 2, chunks: 3, ruleCount: 2 }],
      },
      {
        ventureId: 'v2',
        ventureName: 'Nomad Studio',
        docs: [{ docName: 'Catalog.pdf', pages: 1, chunks: 1, ruleCount: 0 }],
      },
      {
        ventureId: null,
        ventureName: 'Unassigned documents',
        docs: [{ docName: 'MiscNotes.pdf', pages: 1, chunks: 1, ruleCount: 0 }],
      },
    ]);
  });

  it('omits Unassigned documents group when all docs match at least one venture', () => {
    const ws = makeWorkspace({
      tokenMap: { '[VENTURE_1]': 'Atelier Emily' },
      graph: {
        ventures: [{ venture_id: 'v1', venture_token: '[VENTURE_1]', min_margin_pct_token: '' }],
        partners: [],
        products: [],
        dealRules: [],
      },
      docs: [{ docName: 'Doc.pdf', page: 1, index: 0, blindedText: 'Welcome to [VENTURE_1]' }],
    });

    const groups = groupDocumentsByVenture(ws);
    expect(groups).toHaveLength(1);
    expect(groups[0].ventureId).toBe('v1');
  });
});

describe('deduplicateWorkspace', () => {
  it('returns changed: false when workspace has no duplicates', () => {
    const ws = makeWorkspace({
      tokenMap: {
        '[VENTURE_1]': 'Atelier Emily',
        '[MARGIN_FLOOR_1]': '55%',
        '[SKU_1]': 'Silk Dress',
        '[COST_1]': '40',
        '[PRICE_1]': '120',
      },
      graph: {
        ventures: [{ venture_id: 'v1', venture_token: '[VENTURE_1]', min_margin_pct_token: '[MARGIN_FLOOR_1]' }],
        partners: [],
        products: [{ sku_id: 's1', sku_token: '[SKU_1]', venture_id: 'v1', cogs_token: '[COST_1]', list_price_token: '[PRICE_1]' }],
        dealRules: [],
      },
      docs: [{ docName: 'A.pdf', page: 1, index: 0, blindedText: '[VENTURE_1]' }],
    });

    const res = deduplicateWorkspace(ws);
    expect(res.changed).toBe(false);
    expect(res.ventureIdMap).toEqual({});
    expect(res.workspace.graph.ventures).toHaveLength(1);
  });

  it('merges duplicate ventures, remaps child references, upgrades missing margin floor, and dedupes partners/products/rules/docs', () => {
    const ws = makeWorkspace({
      tokenMap: {
        '[VENTURE_1]': 'Atelier Emily',
        '[VENTURE_2]': 'Atelier Emily LLC',
        '[MARGIN_FLOOR_1]': '55%',
        '[PARTNER_1]': 'Sarah Chen',
        '[PARTNER_2]': 'sarah chen',
        '[SKU_1]': 'Silk Dress',
        '[SKU_2]': 'silk dress',
        '[COST_1]': '40',
        '[PRICE_1]': '120',
        '[PRICE_BAD]': 'TBD',
        '[DISCOUNT_CAP_1]': '15%',
        '[DISCOUNT_CAP_2]': '15%',
      },
      graph: {
        ventures: [
          { venture_id: 'v1', venture_token: '[VENTURE_1]', min_margin_pct_token: '' },
          { venture_id: 'v2', venture_token: '[VENTURE_2]', min_margin_pct_token: '[MARGIN_FLOOR_1]' },
        ],
        partners: [
          { partner_id: 'p1', partner_token: '[PARTNER_1]', venture_id: 'v1', approval_rules: '' },
          { partner_id: 'p2', partner_token: '[PARTNER_2]', venture_id: 'v2', approval_rules: 'Required above 15% discount' },
        ],
        products: [
          { sku_id: 's1', sku_token: '[SKU_1]', venture_id: 'v1', cogs_token: '[COST_1]', list_price_token: '[PRICE_BAD]' },
          { sku_id: 's2', sku_token: '[SKU_2]', venture_id: 'v2', cogs_token: '[COST_1]', list_price_token: '[PRICE_1]' },
        ],
        dealRules: [
          {
            rule_id: 'r1',
            venture_id: 'v1',
            max_discount_pct_token: '[DISCOUNT_CAP_1]',
            min_qty_condition: '10+ units',
            requires_partner_approval: true,
            source_doc_name: 'Agreement.pdf',
            page_or_section: 'p.3 §4.1',
            verbatim_blinded_excerpt: 'Cap [DISCOUNT_CAP_1]',
          },
          {
            rule_id: 'r2',
            venture_id: 'v2',
            max_discount_pct_token: '[DISCOUNT_CAP_2]',
            min_qty_condition: '  10+ UNITS ',
            requires_partner_approval: true,
            source_doc_name: 'agreement.pdf',
            page_or_section: ' P.3 §4.1 ',
            verbatim_blinded_excerpt: 'Cap [DISCOUNT_CAP_2]',
          },
        ],
      },
      docs: [
        { docName: 'Agreement.pdf', page: 1, index: 0, blindedText: 'old chunk' },
        { docName: 'agreement.pdf', page: 1, index: 0, blindedText: 'latest chunk' },
      ],
    });

    const snapshotBefore = JSON.stringify(ws);
    const res = deduplicateWorkspace(ws);

    // Input must not be mutated
    expect(JSON.stringify(ws)).toBe(snapshotBefore);

    expect(res.changed).toBe(true);
    expect(res.ventureIdMap).toEqual({ v2: 'v1' });
    expect(res.workspace.graph.ventures).toHaveLength(1);
    expect(res.workspace.graph.ventures[0].venture_id).toBe('v1');
    // Preferred valid min_margin_pct_token from v2
    expect(res.workspace.graph.ventures[0].min_margin_pct_token).toBe('[MARGIN_FLOOR_1]');

    // Partners merged with longer approval_rules kept
    expect(res.workspace.graph.partners).toHaveLength(1);
    expect(res.workspace.graph.partners[0].venture_id).toBe('v1');
    expect(res.workspace.graph.partners[0].approval_rules).toBe('Required above 15% discount');

    // Products merged with both valid list_price_token and cogs_token preferred
    expect(res.workspace.graph.products).toHaveLength(1);
    expect(res.workspace.graph.products[0].venture_id).toBe('v1');
    expect(res.workspace.graph.products[0].cogs_token).toBe('[COST_1]');
    expect(res.workspace.graph.products[0].list_price_token).toBe('[PRICE_1]');

    // Deal rules deduped
    expect(res.workspace.graph.dealRules).toHaveLength(1);
    expect(res.workspace.graph.dealRules[0].venture_id).toBe('v1');

    // Docs deduped keeping latest occurrence
    expect(res.workspace.docs).toHaveLength(1);
    expect(res.workspace.docs[0].blindedText).toBe('latest chunk');
  });
});

describe('mergeWorkspaces', () => {
  it('deduplicates incoming when existing is null', () => {
    const incoming = makeWorkspace({
      id: 'ws-new',
      tokenMap: { '[VENTURE_1]': 'Nomad Studio', '[VENTURE_2]': 'Nomad Studio LLC' },
      graph: {
        ventures: [
          { venture_id: 'v1', venture_token: '[VENTURE_1]', min_margin_pct_token: '' },
          { venture_id: 'v2', venture_token: '[VENTURE_2]', min_margin_pct_token: '' },
        ],
        partners: [],
        products: [],
        dealRules: [],
      },
    });

    const res = mergeWorkspaces(null, incoming);
    expect(res.changed).toBe(true);
    expect(res.workspace.id).toBe('ws-new');
    expect(res.workspace.graph.ventures).toHaveLength(1);
  });

  it('prevents token collisions without double-rewriting, reuses matching same-type tokens, preserves payloadLog.cloudText, and merges duplicate ventures', () => {
    const existing = makeWorkspace({
      id: 'ws-existing',
      name: 'Agreement.pdf',
      updatedAt: 1000,
      tokenMap: {
        '[VENTURE_1]': 'Atelier Emily',
        '[COST_1]': '40',
        '[PRICE_1]': '120',
        '[SKU_1]': 'Silk Dress',
        '[MARGIN_FLOOR_1]': '55%',
      },
      graph: {
        ventures: [
          { venture_id: 'v1', venture_token: '[VENTURE_1]', min_margin_pct_token: '[MARGIN_FLOOR_1]' },
        ],
        partners: [],
        products: [
          { sku_id: 's1', sku_token: '[SKU_1]', venture_id: 'v1', cogs_token: '[COST_1]', list_price_token: '[PRICE_1]' },
        ],
        dealRules: [],
      },
      docs: [
        { docName: 'Agreement.pdf', page: 1, index: 0, blindedText: '[VENTURE_1] sells [SKU_1] at [PRICE_1] (cost [COST_1]).' },
      ],
      payloadLog: [
        { docName: 'Agreement.pdf', page: 1, localText: 'real', cloudText: 'CLOUD_EXISTING [COST_1]', sentAt: 900 },
      ],
    });

    // Incoming also starts counters at _1, has:
    // - [VENTURE_1] = "Atelier Emily LLC" (different string -> fresh [VENTURE_2], then deduped into v1!)
    // - [COST_1] = "50" (collides with existing [COST_1]="40" -> must become [COST_2], NOT corrupt [COST_2]!)
    // - [COST_2] = "40" (same value as existing [COST_1]="40" -> reuses [COST_1]!)
    // - [PRICE_1] = "40" (different type than [COST_1], collides with [PRICE_1]="120" -> fresh [PRICE_2]!)
    // - [SKU_1] = "Linen Jacket" (collides with [SKU_1]="Silk Dress" -> fresh [SKU_2])
    const incoming = makeWorkspace({
      id: 'ws-incoming',
      name: 'PriceSheet.pdf',
      updatedAt: 2000,
      tokenMap: {
        '[VENTURE_1]': 'Atelier Emily LLC',
        '[COST_1]': '50',
        '[COST_2]': '40',
        '[PRICE_1]': '40',
        '[SKU_1]': 'Linen Jacket',
        '[DISCOUNT_CAP_1]': '10%',
      },
      graph: {
        ventures: [
          { venture_id: 'v1', venture_token: '[VENTURE_1]', min_margin_pct_token: '' },
        ],
        partners: [],
        products: [
          { sku_id: 's1', sku_token: '[SKU_1]', venture_id: 'v1', cogs_token: '[COST_1]', list_price_token: '[PRICE_1]' },
        ],
        dealRules: [
          {
            rule_id: 'r1',
            venture_id: 'v1',
            max_discount_pct_token: '[DISCOUNT_CAP_1]',
            min_qty_condition: '5+',
            requires_partner_approval: false,
            source_doc_name: 'PriceSheet.pdf',
            page_or_section: 'p.1',
            verbatim_blinded_excerpt: '[SKU_1] cost [COST_1] alt [COST_2] cap [DISCOUNT_CAP_1]',
          },
        ],
      },
      docs: [
        { docName: 'PriceSheet.pdf', page: 1, index: 0, blindedText: '[VENTURE_1]: [SKU_1] costs [COST_1], base [COST_2], price [PRICE_1].' },
      ],
      payloadLog: [
        { docName: 'PriceSheet.pdf', page: 1, localText: 'real2', cloudText: 'EXACT_CLOUD_BYTES [COST_1] [COST_2]', sentAt: 1900 },
      ],
    });

    const existingBefore = JSON.stringify(existing);
    const res = mergeWorkspaces(existing, incoming);

    // Existing must not be mutated
    expect(JSON.stringify(existing)).toBe(existingBefore);

    // Preserves existing id and latest updatedAt
    expect(res.workspace.id).toBe('ws-existing');
    expect(res.workspace.updatedAt).toBe(2000);

    // NO DUPLICATE VENTURES: Atelier Emily + Atelier Emily LLC merged to 1 venture
    expect(res.workspace.graph.ventures).toHaveLength(1);
    expect(res.workspace.graph.ventures[0].venture_id).toBe('v1');
    expect(res.workspace.graph.ventures[0].min_margin_pct_token).toBe('[MARGIN_FLOOR_1]');

    // Both SKUs attached to canonical v1 with exact, non-corrupted hydrated values
    expect(res.workspace.graph.products).toHaveLength(2);
    const linen = res.workspace.graph.products.find(
      (p) => res.workspace.tokenMap[p.sku_token] === 'Linen Jacket'
    );
    expect(linen).toBeDefined();
    expect(linen!.venture_id).toBe('v1');
    expect(res.workspace.tokenMap[linen!.cogs_token]).toBe('50');
    expect(res.workspace.tokenMap[linen!.list_price_token]).toBe('40');
    // PRICE token stayed PRICE_*, not COST_1
    expect(linen!.list_price_token).toMatch(/^\[PRICE_\d+\]$/);
    // Original COST_1 stayed "40"
    expect(res.workspace.tokenMap['[COST_1]']).toBe('40');

    // Blinded text rewritten accurately in single pass (no double-rewrite!)
    const priceDoc = res.workspace.docs.find((d) => d.docName === 'PriceSheet.pdf')!;
    expect(priceDoc.blindedText).toContain(`costs ${linen!.cogs_token}, base [COST_1], price ${linen!.list_price_token}`);

    // Rule excerpt rewritten too
    expect(res.workspace.graph.dealRules).toHaveLength(1);
    expect(res.workspace.graph.dealRules[0].venture_id).toBe('v1');
    expect(res.workspace.graph.dealRules[0].verbatim_blinded_excerpt).toContain(
      `cost ${linen!.cogs_token} alt [COST_1]`
    );

    // payloadLog.cloudText MUST remain verbatim untouched!
    const incomingLog = res.workspace.payloadLog.find((l) => l.docName === 'PriceSheet.pdf')!;
    expect(incomingLog.cloudText).toBe('EXACT_CLOUD_BYTES [COST_1] [COST_2]');
  });

  it('keeps distinct ventures separate even when incoming reuses venture_id v1', () => {
    const existing = makeWorkspace({
      id: 'ws-1',
      tokenMap: { '[VENTURE_1]': 'Atelier Emily', '[SKU_1]': 'Silk Dress', '[COST_1]': '40', '[PRICE_1]': '120' },
      graph: {
        ventures: [{ venture_id: 'v1', venture_token: '[VENTURE_1]', min_margin_pct_token: '' }],
        partners: [],
        products: [{ sku_id: 's1', sku_token: '[SKU_1]', venture_id: 'v1', cogs_token: '[COST_1]', list_price_token: '[PRICE_1]' }],
        dealRules: [],
      },
      docs: [{ docName: 'Atelier.pdf', page: 1, index: 0, blindedText: '[VENTURE_1] [SKU_1]' }],
    });

    const incoming = makeWorkspace({
      id: 'ws-2',
      tokenMap: { '[VENTURE_1]': 'Nomad Studio', '[SKU_1]': 'Canvas Tote', '[COST_1]': '15', '[PRICE_1]': '60' },
      graph: {
        ventures: [{ venture_id: 'v1', venture_token: '[VENTURE_1]', min_margin_pct_token: '' }],
        partners: [],
        products: [{ sku_id: 's1', sku_token: '[SKU_1]', venture_id: 'v1', cogs_token: '[COST_1]', list_price_token: '[PRICE_1]' }],
        dealRules: [],
      },
      docs: [{ docName: 'Nomad.pdf', page: 1, index: 0, blindedText: '[VENTURE_1] [SKU_1]' }],
    });

    const res = mergeWorkspaces(existing, incoming);
    expect(res.workspace.graph.ventures).toHaveLength(2);
    const [vA, vB] = res.workspace.graph.ventures;
    expect(vA.venture_id).not.toBe(vB.venture_id);
    const nomadVenture = res.workspace.graph.ventures.find(
      (v) => res.workspace.tokenMap[v.venture_token] === 'Nomad Studio'
    )!;
    const nomadSku = res.workspace.graph.products.find(
      (p) => res.workspace.tokenMap[p.sku_token] === 'Canvas Tote'
    )!;
    expect(nomadSku.venture_id).toBe(nomadVenture.venture_id);
  });

  it('replaces earlier chunks, payloadLog, and dealRules when same filename is re-uploaded (case-insensitive)', () => {
    const existing = makeWorkspace({
      id: 'ws-1',
      tokenMap: { '[VENTURE_1]': 'Atelier Emily', '[DISCOUNT_CAP_1]': '20%' },
      graph: {
        ventures: [{ venture_id: 'v1', venture_token: '[VENTURE_1]', min_margin_pct_token: '' }],
        partners: [],
        products: [],
        dealRules: [
          {
            rule_id: 'r-old',
            venture_id: 'v1',
            max_discount_pct_token: '[DISCOUNT_CAP_1]',
            min_qty_condition: 'any',
            requires_partner_approval: false,
            source_doc_name: 'Agreement.pdf',
            page_or_section: 'p.1',
            verbatim_blinded_excerpt: 'Old 20% rule',
          },
          {
            rule_id: 'r-other',
            venture_id: 'v1',
            max_discount_pct_token: '[DISCOUNT_CAP_1]',
            min_qty_condition: 'any',
            requires_partner_approval: false,
            source_doc_name: 'Addendum.pdf',
            page_or_section: 'p.1',
            verbatim_blinded_excerpt: 'Keep this rule',
          },
        ],
      },
      docs: [
        { docName: 'Agreement.pdf', page: 1, index: 0, blindedText: 'Old agreement text [VENTURE_1]' },
        { docName: 'Addendum.pdf', page: 1, index: 0, blindedText: 'Addendum text [VENTURE_1]' },
      ],
      payloadLog: [
        { docName: 'Agreement.pdf', page: 1, localText: 'old', cloudText: 'old-cloud', sentAt: 100 },
        { docName: 'Addendum.pdf', page: 1, localText: 'keep', cloudText: 'keep-cloud', sentAt: 100 },
      ],
    });

    const incoming = makeWorkspace({
      id: 'ws-2',
      tokenMap: { '[VENTURE_1]': 'Atelier Emily', '[DISCOUNT_CAP_1]': '10%' },
      graph: {
        ventures: [{ venture_id: 'v1', venture_token: '[VENTURE_1]', min_margin_pct_token: '' }],
        partners: [],
        products: [],
        dealRules: [
          {
            rule_id: 'r-new',
            venture_id: 'v1',
            max_discount_pct_token: '[DISCOUNT_CAP_1]',
            min_qty_condition: 'any',
            requires_partner_approval: true,
            source_doc_name: 'agreement.pdf',
            page_or_section: 'p.1',
            verbatim_blinded_excerpt: 'Updated 10% rule',
          },
        ],
      },
      docs: [
        { docName: 'agreement.pdf', page: 1, index: 0, blindedText: 'Updated agreement text [VENTURE_1]' },
      ],
      payloadLog: [
        { docName: 'agreement.pdf', page: 1, localText: 'new', cloudText: 'new-cloud', sentAt: 500 },
      ],
    });

    const res = mergeWorkspaces(existing, incoming);
    expect(res.workspace.docs).toHaveLength(2);
    expect(res.workspace.docs.some((d) => d.blindedText.includes('Old agreement'))).toBe(false);
    expect(res.workspace.docs.some((d) => d.blindedText.includes('Updated agreement'))).toBe(true);
    expect(res.workspace.docs.some((d) => d.docName === 'Addendum.pdf')).toBe(true);

    expect(res.workspace.payloadLog).toHaveLength(2);
    expect(res.workspace.payloadLog.some((p) => p.cloudText === 'old-cloud')).toBe(false);
    expect(res.workspace.payloadLog.some((p) => p.cloudText === 'new-cloud')).toBe(true);
    expect(res.workspace.payloadLog.some((p) => p.cloudText === 'keep-cloud')).toBe(true);

    expect(res.workspace.graph.dealRules).toHaveLength(2);
    expect(res.workspace.graph.dealRules.some((r) => r.verbatim_blinded_excerpt === 'Old 20% rule')).toBe(false);
    expect(res.workspace.graph.dealRules.some((r) => r.verbatim_blinded_excerpt === 'Updated 10% rule')).toBe(true);
    expect(res.workspace.graph.dealRules.some((r) => r.source_doc_name === 'Addendum.pdf')).toBe(true);
  });
});

describe('removeVentureFromWorkspace', () => {
  it('removes venture, children, exclusive docs/payloads, prunes unused tokens, and preserves shared docs', () => {
    const ws = makeWorkspace({
      tokenMap: {
        '[VENTURE_1]': 'Atelier Emily',
        '[VENTURE_2]': 'Nomad Studio',
        '[PARTNER_1]': 'Sarah Chen',
        '[SKU_1]': 'Silk Dress',
        '[SKU_2]': 'Canvas Tote',
        '[COST_1]': '40',
        '[COST_2]': '15',
        '[PRICE_1]': '120',
        '[PRICE_2]': '60',
        '[DISCOUNT_CAP_1]': '15%',
      },
      graph: {
        ventures: [
          { venture_id: 'v1', venture_token: '[VENTURE_1]', min_margin_pct_token: '' },
          { venture_id: 'v2', venture_token: '[VENTURE_2]', min_margin_pct_token: '' },
        ],
        partners: [
          { partner_id: 'p1', partner_token: '[PARTNER_1]', venture_id: 'v1', approval_rules: 'Always' },
        ],
        products: [
          { sku_id: 's1', sku_token: '[SKU_1]', venture_id: 'v1', cogs_token: '[COST_1]', list_price_token: '[PRICE_1]' },
          { sku_id: 's2', sku_token: '[SKU_2]', venture_id: 'v2', cogs_token: '[COST_2]', list_price_token: '[PRICE_2]' },
        ],
        dealRules: [
          {
            rule_id: 'r1',
            venture_id: 'v1',
            max_discount_pct_token: '[DISCOUNT_CAP_1]',
            min_qty_condition: 'any',
            requires_partner_approval: true,
            source_doc_name: 'Atelier.pdf',
            page_or_section: 'p.1',
            verbatim_blinded_excerpt: 'Cap [DISCOUNT_CAP_1]',
          },
        ],
      },
      docs: [
        { docName: 'Atelier.pdf', page: 1, index: 0, blindedText: '[VENTURE_1] [SKU_1]' },
        { docName: 'Shared.pdf', page: 1, index: 0, blindedText: '[VENTURE_1] and [VENTURE_2] joint terms' },
        { docName: 'Nomad.pdf', page: 1, index: 0, blindedText: '[VENTURE_2] [SKU_2]' },
      ],
      payloadLog: [
        { docName: 'Atelier.pdf', page: 1, localText: 'a', cloudText: 'ca', sentAt: 1 },
        { docName: 'Shared.pdf', page: 1, localText: 's', cloudText: 'cs', sentAt: 2 },
        { docName: 'Nomad.pdf', page: 1, localText: 'n', cloudText: 'cn', sentAt: 3 },
      ],
    });

    const res = removeVentureFromWorkspace(ws, 'v1');
    expect(res.removedDocs).toEqual(['Atelier.pdf']);
    expect(res.removedRuleCount).toBe(1);
    expect(res.removedProductCount).toBe(1);
    expect(res.workspace).not.toBeNull();

    const next = res.workspace!;
    expect(next.graph.ventures.map((v) => v.venture_id)).toEqual(['v2']);
    expect(next.graph.partners).toHaveLength(0);
    expect(next.graph.products.map((p) => p.sku_id)).toEqual(['s2']);
    expect(next.graph.dealRules).toHaveLength(0);
    expect(next.docs.map((d) => d.docName)).toEqual(['Shared.pdf', 'Nomad.pdf']);
    expect(next.payloadLog.map((p) => p.docName)).toEqual(['Shared.pdf', 'Nomad.pdf']);

    // Unused tokens from removed venture & exclusive doc are pruned
    expect(next.tokenMap['[PARTNER_1]']).toBeUndefined();
    expect(next.tokenMap['[SKU_1]']).toBeUndefined();
    expect(next.tokenMap['[COST_1]']).toBeUndefined();
    expect(next.tokenMap['[DISCOUNT_CAP_1]']).toBeUndefined();
    // Tokens still referenced in remaining graph or Shared.pdf are kept
    expect(next.tokenMap['[VENTURE_2]']).toBe('Nomad Studio');
    expect(next.tokenMap['[SKU_2]']).toBe('Canvas Tote');
    expect(next.tokenMap['[VENTURE_1]']).toBe('Atelier Emily'); // still in Shared.pdf
  });

  it('returns workspace: null when removing the last venture leaves no ventures and no docs', () => {
    const ws = makeWorkspace({
      tokenMap: { '[VENTURE_1]': 'Atelier Emily' },
      graph: {
        ventures: [{ venture_id: 'v1', venture_token: '[VENTURE_1]', min_margin_pct_token: '' }],
        partners: [],
        products: [],
        dealRules: [],
      },
      docs: [{ docName: 'Atelier.pdf', page: 1, index: 0, blindedText: '[VENTURE_1]' }],
    });

    const res = removeVentureFromWorkspace(ws, 'v1');
    expect(res.workspace).toBeNull();
    expect(res.removedDocs).toEqual(['Atelier.pdf']);
  });
});

describe('removeDocumentFromWorkspace', () => {
  it('removes doc, payloadLog, rules, orphaned products, and now-empty ventures; prunes tokens', () => {
    const ws = makeWorkspace({
      tokenMap: {
        '[VENTURE_1]': 'Atelier Emily',
        '[VENTURE_2]': 'Nomad Studio',
        '[PARTNER_1]': 'Sarah Chen',
        '[SKU_1]': 'Silk Dress',
        '[SKU_2]': 'Linen Jacket',
        '[SKU_3]': 'Canvas Tote',
        '[COST_1]': '40',
        '[COST_2]': '50',
        '[COST_3]': '15',
        '[PRICE_1]': '120',
        '[PRICE_2]': '150',
        '[PRICE_3]': '60',
        '[DISCOUNT_CAP_1]': '15%',
      },
      graph: {
        ventures: [
          { venture_id: 'v1', venture_token: '[VENTURE_1]', min_margin_pct_token: '' },
          { venture_id: 'v2', venture_token: '[VENTURE_2]', min_margin_pct_token: '' },
        ],
        partners: [
          { partner_id: 'p1', partner_token: '[PARTNER_1]', venture_id: 'v1', approval_rules: 'Over 15%' },
        ],
        products: [
          { sku_id: 's1', sku_token: '[SKU_1]', venture_id: 'v1', cogs_token: '[COST_1]', list_price_token: '[PRICE_1]' },
          { sku_id: 's2', sku_token: '[SKU_2]', venture_id: 'v1', cogs_token: '[COST_2]', list_price_token: '[PRICE_2]' },
          { sku_id: 's3', sku_token: '[SKU_3]', venture_id: 'v2', cogs_token: '[COST_3]', list_price_token: '[PRICE_3]' },
        ],
        dealRules: [
          {
            rule_id: 'r1',
            venture_id: 'v1',
            max_discount_pct_token: '[DISCOUNT_CAP_1]',
            min_qty_condition: 'any',
            requires_partner_approval: true,
            source_doc_name: 'SpringLine.pdf',
            page_or_section: 'p.1',
            verbatim_blinded_excerpt: 'Cap [DISCOUNT_CAP_1]',
          },
        ],
      },
      docs: [
        { docName: 'SpringLine.pdf', page: 1, index: 0, blindedText: '[VENTURE_1] [SKU_1] [SKU_2]' },
        { docName: 'CoreLine.pdf', page: 1, index: 0, blindedText: '[VENTURE_1] [SKU_2]' },
        { docName: 'NomadOnly.pdf', page: 1, index: 0, blindedText: '[VENTURE_2] [SKU_3]' },
      ],
      payloadLog: [
        { docName: 'SpringLine.pdf', page: 1, localText: '1', cloudText: 'c1', sentAt: 1 },
        { docName: 'CoreLine.pdf', page: 1, localText: '2', cloudText: 'c2', sentAt: 2 },
        { docName: 'NomadOnly.pdf', page: 1, localText: '3', cloudText: 'c3', sentAt: 3 },
      ],
    });

    // Step 1: remove SpringLine.pdf (case-insensitive) -> v1 still has CoreLine.pdf, s1 is orphaned (only in SpringLine), s2 stays (in CoreLine)
    const step1 = removeDocumentFromWorkspace(ws, 'springline.pdf');
    expect(step1.removedRuleCount).toBe(1);
    expect(step1.removedVentureIds).toEqual([]);
    expect(step1.workspace).not.toBeNull();
    expect(step1.workspace!.docs.map((d) => d.docName)).toEqual(['CoreLine.pdf', 'NomadOnly.pdf']);
    expect(step1.workspace!.payloadLog.map((p) => p.docName)).toEqual(['CoreLine.pdf', 'NomadOnly.pdf']);
    expect(step1.workspace!.graph.products.map((p) => p.sku_id)).toEqual(['s2', 's3']);
    expect(step1.workspace!.tokenMap['[SKU_1]']).toBeUndefined();
    expect(step1.workspace!.tokenMap['[DISCOUNT_CAP_1]']).toBeUndefined();
    expect(step1.workspace!.tokenMap['[SKU_2]']).toBe('Linen Jacket');

    // Step 2: remove NomadOnly.pdf -> v2 now has no docs and is removed along with s3
    const step2 = removeDocumentFromWorkspace(step1.workspace!, 'NomadOnly.pdf');
    expect(step2.removedVentureIds).toEqual(['v2']);
    expect(step2.workspace).not.toBeNull();
    expect(step2.workspace!.graph.ventures.map((v) => v.venture_id)).toEqual(['v1']);
    expect(step2.workspace!.graph.products.map((p) => p.sku_id)).toEqual(['s2']);
    expect(step2.workspace!.tokenMap['[VENTURE_2]']).toBeUndefined();
    expect(step2.workspace!.tokenMap['[SKU_3]']).toBeUndefined();

    // Step 3: remove final doc CoreLine.pdf -> v1 removed, returns workspace: null
    const step3 = removeDocumentFromWorkspace(step2.workspace!, 'CoreLine.pdf');
    expect(step3.removedVentureIds).toEqual(['v1']);
    expect(step3.workspace).toBeNull();
  });
});

/* ---------- IndexedDB migration & clear tests ---------- */

function createMockIndexedDB() {
  const store = new Map<string, Workspace>();

  function makeReq<T>(fn: () => T): IDBRequest<T> {
    const req = {
      result: undefined as unknown as T,
      error: null as DOMException | null,
      onsuccess: null as ((ev: Event) => void) | null,
      onerror: null as ((ev: Event) => void) | null,
    };
    queueMicrotask(() => {
      try {
        req.result = fn();
        req.onsuccess?.({} as Event);
      } catch (err) {
        req.error = err as DOMException;
        req.onerror?.({} as Event);
      }
    });
    return req as unknown as IDBRequest<T>;
  }

  const fakeIdb = {
    open: () => {
      const openReq = {
        result: null as unknown as IDBDatabase,
        error: null as DOMException | null,
        onupgradeneeded: null as (() => void) | null,
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
      };
      const db = {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => ({}),
        close: () => {},
        transaction: (_storeName: string, _mode: string) => {
          const tx = {
            oncomplete: null as (() => void) | null,
            onerror: null as (() => void) | null,
            onabort: null as (() => void) | null,
            objectStore: () => ({
              put: (ws: Workspace) => {
                const req = makeReq(() => {
                  store.set(ws.id, structuredClone(ws));
                  queueMicrotask(() => tx.oncomplete?.());
                  return ws.id;
                });
                return req;
              },
              getAll: () => makeReq(() => Array.from(store.values()).map((w) => structuredClone(w))),
              clear: () => {
                const req = makeReq(() => {
                  store.clear();
                  queueMicrotask(() => tx.oncomplete?.());
                  return undefined;
                });
                return req;
              },
            }),
          };
          return tx;
        },
      };
      openReq.result = db as unknown as IDBDatabase;
      queueMicrotask(() => {
        openReq.onupgradeneeded?.();
        openReq.onsuccess?.();
      });
      return openReq;
    },
  };

  return { fakeIdb, store };
}

describe('db.ts local startup migration & clearWorkspacesLocal', () => {
  const originalIndexedDB = globalThis.indexedDB;

  afterEach(() => {
    Object.defineProperty(globalThis, 'indexedDB', {
      value: originalIndexedDB,
      configurable: true,
      writable: true,
    });
  });

  it('no-ops gracefully when indexedDB is undefined', async () => {
    Object.defineProperty(globalThis, 'indexedDB', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    await expect(clearWorkspacesLocal()).resolves.toBeUndefined();
    await expect(loadAndMigrateWorkspaceLocal()).resolves.toEqual({
      workspace: null,
      migrated: false,
      ventureIdMap: {},
    });
    await expect(loadWorkspaceLocal()).resolves.toBeNull();
  });

  it('migrates duplicate ventures on startup load, persists migrated workspace, and supports clearing', async () => {
    const { fakeIdb, store } = createMockIndexedDB();
    Object.defineProperty(globalThis, 'indexedDB', {
      value: fakeIdb,
      configurable: true,
      writable: true,
    });

    const dupWs = makeWorkspace({
      id: 'ws-dup',
      updatedAt: 5000,
      tokenMap: {
        '[VENTURE_1]': 'Atelier Emily',
        '[VENTURE_2]': 'Atelier Emily LLC',
        '[MARGIN_FLOOR_1]': '55%',
      },
      graph: {
        ventures: [
          { venture_id: 'v1', venture_token: '[VENTURE_1]', min_margin_pct_token: '' },
          { venture_id: 'v2', venture_token: '[VENTURE_2]', min_margin_pct_token: '[MARGIN_FLOOR_1]' },
        ],
        partners: [],
        products: [],
        dealRules: [],
      },
    });

    await saveWorkspaceLocal(dupWs);
    expect(store.get('ws-dup')?.graph.ventures).toHaveLength(2);

    // First startup load migrates and persists back to IndexedDB
    const first = await loadAndMigrateWorkspaceLocal();
    expect(first.migrated).toBe(true);
    expect(first.ventureIdMap).toEqual({ v2: 'v1' });
    expect(first.workspace?.graph.ventures).toHaveLength(1);
    expect(first.workspace?.graph.ventures[0].min_margin_pct_token).toBe('[MARGIN_FLOOR_1]');
    // Persisted in store
    expect(store.get('ws-dup')?.graph.ventures).toHaveLength(1);

    // Second startup load finds it already migrated
    const second = await loadAndMigrateWorkspaceLocal();
    expect(second.migrated).toBe(false);
    expect(second.ventureIdMap).toEqual({});

    // loadWorkspaceLocal also delegates to migration
    const dupWs2 = makeWorkspace({
      id: 'ws-dup-2',
      updatedAt: 9000,
      tokenMap: { '[VENTURE_1]': 'Nomad Studio', '[VENTURE_2]': 'Nomad Studio LLC' },
      graph: {
        ventures: [
          { venture_id: 'v1', venture_token: '[VENTURE_1]', min_margin_pct_token: '' },
          { venture_id: 'v2', venture_token: '[VENTURE_2]', min_margin_pct_token: '' },
        ],
        partners: [],
        products: [],
        dealRules: [],
      },
    });
    await saveWorkspaceLocal(dupWs2);
    const loaded = await loadWorkspaceLocal();
    expect(loaded?.id).toBe('ws-dup-2');
    expect(loaded?.graph.ventures).toHaveLength(1);
    expect(store.get('ws-dup-2')?.graph.ventures).toHaveLength(1);

    // clearWorkspacesLocal wipes all entries
    await clearWorkspacesLocal();
    expect(store.size).toBe(0);
    await expect(loadWorkspaceLocal()).resolves.toBeNull();
  });
});
