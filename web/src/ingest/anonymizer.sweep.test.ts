// Real-world PDF regression (2026-11-24): values detected once survived
// verbatim at other occurrences in the same document set (e.g. "SCHEDULE A"
// replaced at one place, left as-is elsewhere), and structural headings were
// tagged as SKUs. The pre-send gate matches text values case-insensitively,
// so the sweep must blind EVERY occurrence with the SAME token.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocChunk } from '../types';
import { anonymizeChunks } from './anonymizer';

const { generateMock } = vi.hoisted(() => ({ generateMock: vi.fn() }));
vi.mock('../hybrid', () => ({ generate: generateMock }));

beforeEach(() => generateMock.mockReset());

function doc(...texts: string[]): DocChunk[] {
  return texts.map((text, index) => ({ docName: 'agreement.md', page: index + 1, index, text }));
}

describe('anonymizer sweep consistency — every detected value blinded everywhere', () => {
  it('a name detected in one chunk is replaced in every other chunk, case-insensitively, same token', async () => {
    const { blinded } = await anonymizeChunks(
      doc(
        'Partner Sari Dewi signed for the Bright Sprouts company.',
        'SARI DEWI later approved, referring again to Bright Sprouts.',
      ),
    );
    expect(blinded[0].text).toContain('[PARTNER_1]');
    expect(blinded[1].text).toContain('[PARTNER_1]');
    expect(blinded[1].text).not.toMatch(/sari/i);
    expect(blinded[1].text).toContain('[VENTURE_1]');
    expect(blinded[1].text).not.toMatch(/bright sprouts/i);
  });

  it('a numeric value detected once is blinded at every occurrence across chunks', async () => {
    const { blinded } = await anonymizeChunks(
      doc(
        'The discount cap is 10% on every order.',
        'The bulk tier starts at 10 units minimum.',
      ),
    );
    expect(blinded[0].text).toContain('[DISCOUNT_CAP_1]');
    expect(blinded[1].text).not.toMatch(/(?<![0-9])10(?![0-9])/);
    expect(blinded[1].text).toMatch(/\[VALUE_\d+\]/);
  });
});

describe('anonymizer SKU labels — headings are not products', () => {
  it('"SCHEDULE A" / "Wholesale List Price" / "Standard List Price" are never tokenized as SKU', async () => {
    const { blinded } = await anonymizeChunks(
      doc(
        'SCHEDULE A SKUs follow the pricing rules below.',
        'Wholesale List Price SKUs are billed per the annex; see Standard List Price SKUs too.',
      ),
    );
    expect(blinded[0].text).toContain('SCHEDULE A');
    expect(blinded[1].text).toContain('Wholesale List Price');
    expect(blinded[1].text).toContain('Standard List Price');
    for (const chunk of blinded) expect(chunk.text).not.toMatch(/\[SKU_/);
  });

  it('real product names next to SKU keywords are still tokenized', async () => {
    const { blinded } = await anonymizeChunks(doc('SKUs: Aurora Linen Dress is the flagship product.'));
    expect(blinded[0].text).toContain('[SKU_1]');
    expect(blinded[0].text).not.toContain('Aurora Linen Dress');
  });
});
