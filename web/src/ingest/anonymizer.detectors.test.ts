import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocChunk } from '../types';
import { anonymizeChunks } from './anonymizer';

const { generateMock } = vi.hoisted(() => ({ generateMock: vi.fn() }));
vi.mock('../hybrid', () => ({ generate: generateMock }));

beforeEach(() => generateMock.mockReset());

function chunk(text: string): DocChunk[] {
  return [{ docName: 'terms.md', page: 1, index: 0, text }];
}

async function blindedText(text: string): Promise<string> {
  const { blinded } = await anonymizeChunks(chunk(text));
  return blinded[0].text;
}

describe('anonymizer detectors — CV-SEC-4 (security Patch 5)', () => {
  it('blinds bare integers in table columns typed Modal/Harga Jual', async () => {
    const table =
      'pricing table\n\n| SKU | Modal | Harga Jual |\n|---|---|---|\n| SKU-7 | 45000 | 90000 |\n';
    const out = await blindedText(table);
    expect(out).not.toContain('45000');
    expect(out).not.toContain('90000');
    // 'harga' maps to COST under the existing keyword precedence (Modal, Harga Jual).
    expect((out.match(/\[COST_\d+\]/g) ?? []).length).toBe(2);
    expect(out).toContain('SKU-7'); // the 7 in the SKU name is untouched
  });

  it('detects Indonesian thousands: "Rp 1.500.000" becomes Rp [token] with no stray digits', async () => {
    const out = await blindedText('Harga Rp 1.500.000 total');
    expect(out).not.toContain('1.500.000');
    expect(out).toContain('Rp [');
    expect(out).not.toContain('1.');
  });

  it('"1.500.000 IDR" fully blinded — no stray "1." left behind', async () => {
    const out = await blindedText('Harga 1.500.000 IDR total');
    expect(out).not.toContain('1.500.000');
    expect(out).toContain('IDR');
    expect(out).not.toContain('1.');
  });

  it('regression: en grouping and decimals still blinded', async () => {
    const out = await blindedText('harga 1,250.00 total and cost 45.5');
    expect(out).not.toContain('1,250.00');
    expect(out).not.toContain('45.5');
  });

  // Patch 5 follow-ups (tracked by the security verification doc; not in this slice):
  it.todo('single-word venture names');
  it.todo('signature-block names');
  it.todo('emails and phone numbers');
});
