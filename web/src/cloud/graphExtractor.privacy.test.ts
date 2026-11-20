import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnonymizedChunk } from '../types';
import { synthesizeGraph } from './graphExtractor';

const { generateMock } = vi.hoisted(() => ({ generateMock: vi.fn() }));
vi.mock('../hybrid', () => ({ generate: generateMock }));

beforeEach(() => generateMock.mockReset());

describe('cloud document metadata privacy', () => {
  it('keeps private filenames local while restoring source citations', async () => {
    const privateName = 'Sari_Dewi_private_contract_125000.pdf';
    const chunks: AnonymizedChunk[] = [{
      docName: privateName, page: 3, index: 0,
      text: '[VENTURE_1] agrees with [PARTNER_1].', detected: [],
    }];
    generateMock.mockResolvedValue({ text: JSON.stringify({
      ventures: [], partners: [], products: [], dealRules: [{
        rule_id: 'r1', venture_id: 'v1', max_discount_pct_token: '[DISCOUNT_CAP_1]',
        min_qty_condition: '', requires_partner_approval: true,
        source_doc_name: 'DOC_1', page_or_section: '3',
        verbatim_blinded_excerpt: '[VENTURE_1] agrees with [PARTNER_1].',
      }],
    }), usedOnDevice: false, model: 'synthetic-test' });

    const { graph, payloadLog } = await synthesizeGraph(chunks, '');
    const [stage, prompt] = generateMock.mock.calls[0];
    expect(stage).toBe('synthesize');
    expect(prompt).not.toContain(privateName);
    expect(prompt).not.toContain('Sari_Dewi');
    expect(prompt).toContain('DOC_1');
    expect(graph.dealRules[0].source_doc_name).toBe(privateName);
    expect(payloadLog[0].docName).toBe(privateName);
    expect(payloadLog[0].localText).toContain(privateName);
    expect(payloadLog[0].cloudText).toBe(prompt);
  });
});
