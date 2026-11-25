// End-to-end acceptance test covering:
// - Loading the 4 sample docs TWICE + the 3 Atelier Emily sample docs again
//   through chunkDocument -> anonymizeChunks -> synthesizeGraph -> mergeWorkspaces
// - Asserting one venture per company, no duplicate documents, grouped docs per venture
// - Asserting clean product picker (only real product names, no sku_1 / price-field junk,
//   unnamed codes formatted at the bottom, filtered per venture)
// - Asserting exact demo numbers (Aurora Linen Dress 20% x 30 -> Margin breach 50.0%,
//   suggested 10% at $90 -> 55.6%, Emily Hartono, Sari Wijaya, Nomad solo)
// - Asserting privacy gate stays 0-leak throughout
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { KnowledgeGraph, TokenMap, Workspace } from './types';

function tokenForValue(tokenMap: TokenMap, prefix: string, needle: string): string {
  const lower = needle.toLowerCase();
  for (const [tok, val] of Object.entries(tokenMap)) {
    if (tok.startsWith(`[${prefix}_`) && val.trim().toLowerCase() === lower) {
      return tok;
    }
  }
  for (const [tok, val] of Object.entries(tokenMap)) {
    if (tok.startsWith(`[${prefix}_`) && val.trim().toLowerCase().includes(lower)) {
      return tok;
    }
  }
  return '';
}

function numTokenForValue(tokenMap: TokenMap, prefixes: string[], targetNum: string): string {
  for (const prefix of prefixes) {
    for (const [tok, val] of Object.entries(tokenMap)) {
      if (!tok.startsWith(`[${prefix}_`)) continue;
      const digits = val.replace(/[^0-9.]/g, '');
      if (digits === targetNum) return tok;
    }
  }
  return '';
}

let activeTokenMap: TokenMap = {};
let activeRunNumber = 0;

vi.mock('./hybrid', () => ({
  generate: vi.fn(async (stage: string, prompt: string) => {
    if (stage !== 'synthesize') {
      throw new Error('on-device unavailable in test');
    }
    const tm = activeTokenMap;
    const batchHasAtelier = /Partnership Agreement|Core collection|October Meeting Notes/i.test(prompt);
    const batchHasNomad = /Solo consulting terms|sole owner/i.test(prompt);

    const vAeToken = tokenForValue(tm, 'VENTURE', 'atelier emily');
    const vNsToken = tokenForValue(tm, 'VENTURE', 'nomad studio');
    const pEmilyToken = tokenForValue(tm, 'PARTNER', 'emily hartono');
    const pSariToken = tokenForValue(tm, 'PARTNER', 'sari wijaya');

    const skuDress = tokenForValue(tm, 'SKU', 'aurora linen dress');
    const skuBlouse = tokenForValue(tm, 'SKU', 'solstice silk blouse');
    const skuSkirt = tokenForValue(tm, 'SKU', 'meadow cotton skirt');

    const floor55 = numTokenForValue(tm, ['MARGIN_FLOOR', 'DISCOUNT_CAP'], '55');
    const cap10 = numTokenForValue(tm, ['DISCOUNT_CAP', 'MARGIN_FLOOR'], '10');

    const p100 = numTokenForValue(tm, ['PRICE', 'COST'], '100');
    const c40 = numTokenForValue(tm, ['COST', 'PRICE'], '40');
    const p140 = numTokenForValue(tm, ['PRICE', 'COST'], '140');
    const c63 = numTokenForValue(tm, ['COST', 'PRICE'], '63');
    const p70 = numTokenForValue(tm, ['PRICE', 'COST'], '70');
    const c28 = numTokenForValue(tm, ['COST', 'PRICE'], '28');
    const p250 = numTokenForValue(tm, ['PRICE', 'COST'], '250');
    const c90 = numTokenForValue(tm, ['COST', 'PRICE'], '90');

    const docAlias =
      /\[(DOC_\d+)\s+p\.\d+\s+#\d+\][^\n]*Partnership Agreement/i.exec(prompt)?.[1] ?? null;

    const suffix = `run${activeRunNumber}`;
    const graph: KnowledgeGraph = {
      ventures: [
        ...(batchHasAtelier && vAeToken
          ? [
              {
                venture_id: `v_ae_${suffix}`,
                venture_token: vAeToken,
                min_margin_pct_token: floor55,
              },
            ]
          : []),
        ...(batchHasNomad && vNsToken
          ? [
              {
                venture_id: `v_ns_${suffix}`,
                venture_token: vNsToken,
                min_margin_pct_token: floor55,
              },
            ]
          : []),
      ],
      partners: batchHasAtelier
        ? [
            {
              partner_id: `p_sari_${suffix}`,
              partner_token: pSariToken,
              venture_id: `v_ae_${suffix}`,
              approval_rules: 'consult where production capacity is affected',
            },
            {
              partner_id: `p_emily_${suffix}`,
              partner_token: pEmilyToken,
              venture_id: `v_ae_${suffix}`,
              approval_rules: 'signs off discounts above the 10% cap',
            },
          ]
        : [],
      products: [
        ...(batchHasAtelier
          ? [
              // Real products
              {
                sku_id: `sku_dress_${suffix}`,
                sku_token: skuDress,
                venture_id: `v_ae_${suffix}`,
                cogs_token: c40,
                list_price_token: p100,
              },
              {
                sku_id: `sku_blouse_${suffix}`,
                sku_token: skuBlouse,
                venture_id: `v_ae_${suffix}`,
                cogs_token: c63,
                list_price_token: p140,
              },
              {
                sku_id: `sku_skirt_${suffix}`,
                sku_token: skuSkirt,
                venture_id: `v_ae_${suffix}`,
                cogs_token: c28,
                list_price_token: p70,
              },
              // Realistic LLM junk products that MUST be stripped by the Product picker
              {
                sku_id: 'sku_1',
                sku_token: '[SKU_999]', // unresolved token -> must not fall back to sku_1
                venture_id: `v_ae_${suffix}`,
                cogs_token: '',
                list_price_token: '',
              },
              {
                sku_id: 'sku_2',
                sku_token: 'sku_2',
                venture_id: `v_ae_${suffix}`,
                cogs_token: '',
                list_price_token: '',
              },
              {
                sku_id: `sku_junk_net_${suffix}`,
                sku_token: 'Net Realized Unit Price',
                venture_id: `v_ae_${suffix}`,
                cogs_token: '',
                list_price_token: '',
              },
              {
                sku_id: `sku_junk_wl_${suffix}`,
                sku_token: 'Wholesale List Price',
                venture_id: `v_ae_${suffix}`,
                cogs_token: '',
                list_price_token: '',
              },
              {
                sku_id: `sku_junk_sl_${suffix}`,
                sku_token: 'Standard List Price',
                venture_id: `v_ae_${suffix}`,
                cogs_token: '',
                list_price_token: '',
              },
            ]
          : []),
        ...(batchHasNomad
          ? [
              {
                sku_id: `sku_advisory_${suffix}`,
                sku_token: 'Advisory day',
                venture_id: `v_ns_${suffix}`,
                cogs_token: c90,
                list_price_token: p250,
              },
            ]
          : []),
      ],
      dealRules:
        batchHasAtelier && docAlias
          ? [
              {
                rule_id: `R43_${suffix}`,
                venture_id: `v_ae_${suffix}`,
                max_discount_pct_token: cap10,
                min_qty_condition: '60 or more units',
                requires_partner_approval: true,
                source_doc_name: docAlias,
                page_or_section: '§4.3',
                verbatim_blinded_excerpt: `discounts of up to ${cap10} may be granted without co-founder approval`,
              },
            ]
          : [],
    };

    return {
      text: JSON.stringify(graph),
      usedOnDevice: false,
      model: 'mock-synth',
    };
  }),
}));

import { synthesizeGraph } from './cloud/graphExtractor';
import { anonymizeChunks } from './ingest/anonymizer';
import { chunkDocument } from './ingest/chunker';
import {
  groupDocumentsByVenture,
  mergeWorkspaces,
  removeDocumentFromWorkspace,
  removeVentureFromWorkspace,
} from './storage/workspaceOps';
import { cleanProductOptions } from './ui/productPicker';
import {
  approvalInfo,
  computeRecordDeal,
  fmtPct1,
  partnerNameOf,
  pricingRows,
  type RequestRecord,
} from './ui/requestModel';
import { findLeakedValues, hydrate } from './ui/util';
import { uniqueVentureOptions } from './ui/workspaceCue';

const here = dirname(fileURLToPath(import.meta.url));
const ALL_SAMPLE_FILES = [
  'A1-atelier-emily-partnership-agreement.md',
  'A2-october-meeting-notes.md',
  'A3-atelier-emily-cost-sheet.md',
  'B1-nomad-studio-solo-terms.md',
];
const THREE_ATELIER_DOCS = ALL_SAMPLE_FILES.slice(0, 3);

function legendOf(anon: Awaited<ReturnType<typeof anonymizeChunks>>): string {
  const types = new Map<string, string>();
  for (const c of anon.blinded) {
    for (const d of c.detected) {
      if (!types.has(d.token)) types.set(d.token, d.type);
    }
  }
  return Object.keys(anon.tokenMap)
    .map((t) => `${t} (type: ${types.get(t) ?? 'UNKNOWN'})`)
    .join('\n');
}

async function ingestFilesInto(
  existing: Workspace | null,
  fileNames: string[],
  runNumber: number,
): Promise<Workspace> {
  activeRunNumber = runNumber;
  const docs = fileNames.map((name) => ({
    name,
    text: readFileSync(join(here, '..', 'public', 'sample-docs', name), 'utf8'),
  }));
  const chunks = docs.flatMap((d) => chunkDocument(d.name, d.text, 600));
  const anon = await anonymizeChunks(chunks);
  activeTokenMap = anon.tokenMap;

  const { graph, payloadLog } = await synthesizeGraph(anon.blinded, legendOf(anon));
  for (const entry of payloadLog) {
    expect(findLeakedValues(anon.tokenMap, entry.cloudText, 'gate').hits).toEqual([]);
  }

  const incoming: Workspace = {
    id: existing?.id ?? 'ws-sample-test',
    name: fileNames.join(' + ').slice(0, 80),
    graph,
    tokenMap: anon.tokenMap,
    docs: anon.blinded.map((b) => ({
      docName: b.docName,
      page: b.page,
      index: b.index,
      blindedText: b.text,
    })),
    payloadLog,
    updatedAt: 1000 + runNumber,
  };

  return mergeWorkspaces(existing, incoming).workspace;
}

describe('sample workspace loaded TWICE plus the 3 sample docs again', () => {
  it('keeps exactly one venture per company, clean real product names, grouped docs, and exact demo numbers', async () => {
    // 1. Load sample workspace (all 4 docs)
    let ws = await ingestFilesInto(null, ALL_SAMPLE_FILES, 1);
    // 2. Load sample workspace a SECOND time (all 4 docs)
    ws = await ingestFilesInto(ws, ALL_SAMPLE_FILES, 2);
    // 3. Load the 3 Atelier Emily sample docs again
    ws = await ingestFilesInto(ws, THREE_ATELIER_DOCS, 3);

    // One venture per company (Atelier Emily + Nomad Studio = 2, never duplicated)
    expect(ws.graph.ventures).toHaveLength(2);
    const ventureNames = ws.graph.ventures
      .map((v) => hydrate(ws.tokenMap, v.venture_token))
      .sort();
    expect(ventureNames).toEqual(['Atelier Emily', 'Nomad Studio']);

    // Switcher also shows exactly 2 distinct ventures, never duplicates
    const switcherOpts = uniqueVentureOptions(ws);
    expect(switcherOpts).toHaveLength(2);
    expect(switcherOpts.map((o) => o.label).sort()).toEqual(['Atelier Emily', 'Nomad Studio']);

    // Documents are grouped under their venture name, with zero duplicate file copies
    const groups = groupDocumentsByVenture(ws);
    const aeGroup = groups.find((g) => g.ventureName === 'Atelier Emily');
    const nsGroup = groups.find((g) => g.ventureName === 'Nomad Studio');
    expect(aeGroup?.docs.map((d) => d.docName).sort()).toEqual([...THREE_ATELIER_DOCS].sort());
    expect(nsGroup?.docs.map((d) => d.docName)).toEqual(['B1-nomad-studio-solo-terms.md']);

    // Product list for Atelier Emily contains ONLY real product names, sorted & deduplicated
    const atelierVenture = ws.graph.ventures.find(
      (v) => hydrate(ws.tokenMap, v.venture_token) === 'Atelier Emily',
    )!;
    const nomadVenture = ws.graph.ventures.find(
      (v) => hydrate(ws.tokenMap, v.venture_token) === 'Nomad Studio',
    )!;

    const aeProducts = cleanProductOptions(ws, atelierVenture.venture_id);
    expect(aeProducts.map((p) => p.label)).toEqual([
      'Aurora Linen Dress',
      'Meadow Cotton Skirt',
      'Solstice Silk Blouse',
    ]);
    // Junk NEVER appears
    for (const bad of [
      'sku_1',
      'sku_2',
      'Net Realized Unit Price',
      'Wholesale List Price',
      'Standard List Price',
      'Advisory day', // belongs to Nomad Studio, not Atelier Emily
    ]) {
      expect(aeProducts.map((p) => p.label)).not.toContain(bad);
    }

    // Product list for Nomad Studio is filtered to Nomad Studio only
    const nsProducts = cleanProductOptions(ws, nomadVenture.venture_id);
    expect(nsProducts.map((p) => p.label)).toEqual(['Advisory day']);

    // Exact demo numbers check (Aurora Linen Dress, 20% off for 30 units -> Margin breach 50.0%,
    // suggested 10% at $90 -> 55.6%, Emily Hartono, Sari Wijaya, Nomad solo)
    const dressOpt = aeProducts.find((p) => p.label === 'Aurora Linen Dress')!;
    const aeReq: RequestRecord = {
      id: 'DR-0001',
      ventureId: atelierVenture.venture_id,
      createdAt: 1,
      customer: 'Lumen Boutique',
      skuId: dressOpt.skuId,
      discountPct: 20,
      qty: 30,
      activity: [{ at: 1, kind: 'created', note: 'Request created' }],
    };
    const deal = computeRecordDeal(ws, aeReq);
    expect(deal.errors).toEqual([]);
    expect(deal.verdict?.badge).toBe('MARGIN BREACH');
    const rows = pricingRows(deal)!;
    expect(fmtPct1(rows.requested.marginPct)).toBe('50.0%');
    expect(rows.suggested.discountPct).toBe(10);
    expect(rows.suggested.unitPrice).toBe(90);
    expect(fmtPct1(rows.suggested.marginPct)).toBe('55.6%');

    // Partners: Emily Hartono signs off; Sari Wijaya is also in the graph
    expect(partnerNameOf(ws, atelierVenture.venture_id)).toBe('Emily Hartono');
    const partnerNames = ws.graph.partners
      .filter((p) => p.venture_id === atelierVenture.venture_id)
      .map((p) => hydrate(ws.tokenMap, p.partner_token))
      .sort();
    expect(partnerNames).toEqual(['Emily Hartono', 'Sari Wijaya']);
    const approval = approvalInfo(deal);
    expect(approval.needed).toBe(true);
    expect(approval.buttonLabel).toContain('Emily Hartono');

    // Nomad Studio stays solo (no partner, no cap)
    expect(partnerNameOf(ws, nomadVenture.venture_id)).toBeNull();
    const nsReq: RequestRecord = {
      id: 'DR-0002',
      ventureId: nomadVenture.venture_id,
      createdAt: 2,
      customer: 'Solo Client',
      skuId: nsProducts[0].skuId,
      discountPct: 20,
      qty: 1,
      activity: [{ at: 2, kind: 'created', note: 'Request created' }],
    };
    const nsDeal = computeRecordDeal(ws, nsReq);
    expect(nsDeal.errors).toEqual([]);
    expect(nsDeal.cap).toBeNull();
    expect(nsDeal.partnerName).toBeNull();

    // Remove a single doc (A2 meeting notes): Atelier Emily keeps A1 + A3
    const afterDocRemove = removeDocumentFromWorkspace(ws, 'A2-october-meeting-notes.md');
    expect(afterDocRemove.workspace).not.toBeNull();
    expect(afterDocRemove.removedVentureIds).toEqual([]);
    expect(afterDocRemove.workspace!.graph.ventures).toHaveLength(2);

    // Remove Atelier Emily venture: Nomad Studio survives cleanly
    const afterVentureRemove = removeVentureFromWorkspace(
      afterDocRemove.workspace!,
      atelierVenture.venture_id,
    );
    expect(afterVentureRemove.workspace).not.toBeNull();
    expect(afterVentureRemove.workspace!.graph.ventures).toHaveLength(1);
    expect(
      hydrate(
        afterVentureRemove.workspace!.tokenMap,
        afterVentureRemove.workspace!.graph.ventures[0].venture_token,
      ),
    ).toBe('Nomad Studio');
  });
});
