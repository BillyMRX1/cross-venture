// Privacy gaps seen in blinded output of real contract PDFs (2026-11-25).
// All text below is synthetic: names, companies and figures are invented for
// these tests and do not come from the tester documents.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocChunk } from '../types';
import { anonymizeChunks } from './anonymizer';

const { generateMock } = vi.hoisted(() => ({ generateMock: vi.fn() }));
vi.mock('../hybrid', () => ({ generate: generateMock }));

beforeEach(() => generateMock.mockReset());

function doc(...texts: string[]): DocChunk[] {
  return texts.map((text, index) => ({ docName: 'agreement.md', page: index + 1, index, text }));
}

describe('gap 1 — person names without role keywords leak', () => {
  it('prose, signature-block and honorific names become PARTNER and are swept everywhere', async () => {
    const { blinded } = await anonymizeChunks(
      doc(
        'Delivery may proceed without separate written sign-off from Greta Lindqvist, yielding the release note.',
        'By: Jonas Meijer\nName: Priya Anand\nTitle: Managing Member',
        'Priya Anand approved the variation. Lindqvist was copied on the thread.',
        'Dr. Amara Okafor countersigned on behalf of the studio.',
      ),
    );
    // Full name caught by the "sign-off from" context.
    const greta = /\[PARTNER_(\d+)\]/.exec(blinded[0].text);
    expect(greta, 'sign-off-from name not tokenized').not.toBeNull();
    expect(blinded[0].text).not.toMatch(/greta|lindqvist/i);
    // Signature block lines "By:" / "Name:".
    expect(blinded[1].text).toMatch(/By: \[PARTNER_\d+\]/);
    expect(blinded[1].text).not.toMatch(/jonas|meijer/i);
    const priya = /Name: \[PARTNER_(\d+)\]/.exec(blinded[1].text);
    expect(priya, 'Name: signature line not tokenized').not.toBeNull();
    // "Title: Managing Member" is a job title, not a person: no PARTNER token
    // may claim the words "Managing" or "Member".
    expect(blinded[1].text).toContain('Title: Managing Member');
    // Full name and surname alone share the first name's token (Pass B sweep).
    expect(blinded[2].text).toContain(`[PARTNER_${priya![1]}]`);
    expect(blinded[2].text).not.toMatch(/priya|anand/i);
    expect(blinded[2].text).not.toMatch(/lindqvist/i);
    expect(blinded[2].text).toContain(`[PARTNER_${greta![1]}]`);
    // Honorific.
    expect(blinded[3].text).toMatch(/Dr\. \[PARTNER_\d+\]/);
    expect(blinded[3].text).not.toMatch(/amara|okafor/i);
  });
});

describe('gap 2 — legal entity names leak or are mis-typed as SKU', () => {
  it('names ending LLC/Inc./GmbH/B.V. are VENTURE whole (suffix included), never SKU', async () => {
    const { blinded, tokenMap } = await anonymizeChunks(
      doc(
        'The Willowmere Holdings LLC SKUs are catalogued by Marigold Textiles GmbH.',
        'Roastly Coffee Inc. invoices and Bluefin Studio B.V. terms were filed.',
      ),
    );
    for (const chunk of blinded) {
      expect(chunk.text).not.toMatch(/willowmere|marigold|roastly|bluefin/i);
      expect(chunk.text).not.toMatch(/\bLLC\b|\bGmbH\b|\bInc\b|\bB\.V\./);
      expect(chunk.text).not.toMatch(/\[SKU_/);
    }
    expect(blinded[0].text).toContain('SKUs'); // the word itself is not a token
    // The whole name including the suffix is the VENTURE value.
    const ventureValues = Object.entries(tokenMap)
      .filter(([token]) => token.startsWith('[VENTURE_'))
      .map(([, value]) => value);
    expect(ventureValues).toContain('Willowmere Holdings LLC');
    expect(ventureValues).toContain('Marigold Textiles GmbH');
    expect(ventureValues).toContain('Roastly Coffee Inc.');
    expect(ventureValues).toContain('Bluefin Studio B.V.');
    // Never a bare suffix-less SKU.
    expect(Object.values(tokenMap)).not.toContain('Willowmere Holdings');
    expect(Object.values(tokenMap)).not.toContain('Willowmere');
  });
});

describe('gap 3 — spelled-out amounts leak next to their blinded digits', () => {
  it('"Two Hundred Sixty Thousand Dollars (260,000)" blinds phrase and figure with one token', async () => {
    const { blinded } = await anonymizeChunks(
      doc(
        'Payment of Two Hundred Sixty Thousand Dollars (260,000) is due in full.',
        'An older memo wires 260000 to the same account.',
      ),
    );
    const phrase = blinded[0].text;
    expect(phrase).toMatch(/Payment of \[(?:COST|PRICE)_(\d+)\] \(\[(?:COST|PRICE)_\1\]/);
    expect(phrase).not.toMatch(/two hundred/i);
    expect(phrase).not.toMatch(/260/);
    // Numeric-form closure: the bare digits elsewhere are swept too.
    expect(blinded[1].text).not.toMatch(/260000/);
    expect(blinded[1].text).toMatch(/\[VALUE_\d+\]/);
  });
});

describe('gap 4 — page furniture, IDs, unit quantities and years are over-blinded', () => {
  it('Page N of M, hyphenated doc codes, glued measurement units and plain years stay literal; money and percent stay blinded', async () => {
    const source = [
      'Wholesale price list — Page 4 of 9.',
      'The list price is 12,500 USD per order.',
      'Order form NS-MSA-7-V2 covers 40-kilogram sacks (40 kg each) at a flat 2,400 Rupiah rate per sack.',
      'Section 3, dated in 2019, sets a rate cap of 22%.',
      'Lead time is 14 days; a 300 ml sample bottle costs 3,600 Rupiah.',
    ].join('\n');
    const { blinded } = await anonymizeChunks(doc(source));
    const text = blinded[0].text;
    expect(text).toContain('Page 4 of 9');
    expect(text).toContain('NS-MSA-7-V2');
    expect(text).toContain('40-kilogram');
    expect(text).toContain('(40 kg each)');
    expect(text).toContain('Section 3');
    expect(text).toContain('2019');
    expect(text).toContain('14 days');
    expect(text).toContain('300 ml');
    // In doubt we keep blinding money and percentages.
    expect(text).not.toMatch(/12,500/);
    expect(text).not.toMatch(/2,400/);
    expect(text).not.toMatch(/3,600/);
    expect(text).not.toMatch(/22%/);
    expect(text).toMatch(/\[[A-Z_]+_\d+\]/);
  });
});

describe('anonymizer gaps — round 2 (coordinator)', () => {
  it('durations with spelled numbers are not amounts; bare number words never become known values', async () => {
    const { blinded } = await anonymizeChunks(
      doc('Meetings occur within fifteen (15) days. Rounded to two decimal places over thirty-six (36) monthly installments.'),
    );
    for (const chunk of blinded) {
      for (const span of chunk.detected) expect(span.text.trim()).not.toMatch(/^(?:two|fifteen|thirty(?:-six)?)$/i);
    }
  });

  it('a defined short company alias is blinded everywhere, generic defined terms are not', async () => {
    const { blinded } = await anonymizeChunks(
      doc(
        'Brightwell Ceramics Inc., a Texas corporation (the "Company" or "Brightwell").',
        'Brightwell shall keep books; the Company may audit them.',
      ),
    );
    for (const chunk of blinded) expect(chunk.text).not.toMatch(/Brightwell/);
    expect(blinded[1].text).toContain('the Company');
  });
});
