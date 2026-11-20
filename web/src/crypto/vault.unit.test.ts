import { describe, expect, it } from 'vitest';

import {
  decryptJson,
  encryptJson,
  exportVaultKey,
  generateVaultKey,
  importVaultKey,
} from './vault';

// CV-SEC-6: vault crypto unit invariants (M3 exit criterion support:
// "Firestore stores only AES-256-GCM ciphertext"). These are local crypto
// guarantees, independent of any live transport.

type Payload = { graph: { deals: string[] }; tokenMap: Record<string, string> };

const sample: Payload = {
  graph: { deals: ['Nomad Studio $250 90'] },
  tokenMap: { '[PARTNER_1]': 'Marcus Tan', '[COST_1]': '90' },
};

describe('vault crypto invariants', () => {
  it('every encryptJson call uses a fresh IV and produces a distinct ciphertext', async () => {
    const key = await generateVaultKey();
    const a = await encryptJson(key, sample);
    const b = await encryptJson(key, sample);
    expect(a.iv).not.toBe(b.iv);
    expect(a.cipher).not.toBe(b.cipher);
    expect(await decryptJson<Payload>(key, a)).toEqual(sample);
    expect(await decryptJson<Payload>(key, b)).toEqual(sample);
  });

  it('iv and cipher are base64url-only (safe as Firestore string fields)', async () => {
    const key = await generateVaultKey();
    const enc = await encryptJson(key, sample);
    expect(enc.iv).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(enc.cipher).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(enc.iv.length).toBe(16); // 12 bytes -> 16 base64url chars, unpadded
  });

  it('tampered ciphertext fails closed (GCM auth, never garbage-out)', async () => {
    const key = await generateVaultKey();
    const enc = await encryptJson(key, sample);
    // Review F1: flip a REAL bit. Flipping the last base64url char can hit only
    // ignored padding bits (1/6 of trailing quanta) — decode would be identical.
    const bytes = Uint8Array.from(atob(enc.cipher.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    bytes[0] ^= 0x01; // first byte is entirely covered by char 0: always changes ciphertext body
    const tampered = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(tampered).not.toBe(enc.cipher);
    // Review F2: prove GCM auth rejection, not a decode/parse error.
    await expect(decryptJson(key, { ...enc, cipher: tampered })).rejects.toMatchObject({
      name: 'OperationError',
    });
  });

  it('swapped IVs between two messages fail closed', async () => {
    const key = await generateVaultKey();
    const a = await encryptJson(key, sample);
    const b = await encryptJson(key, { ...sample, graph: { deals: ['other'] } });
    await expect(decryptJson(key, { iv: b.iv, cipher: a.cipher })).rejects.toMatchObject({
      name: 'OperationError',
    });
  });

  it('wrong key fails closed', async () => {
    const key = await generateVaultKey();
    const other = await generateVaultKey();
    const enc = await encryptJson(key, sample);
    await expect(decryptJson(other, enc)).rejects.toMatchObject({ name: 'OperationError' });
  });

  it('key survives pairing export/import round trip (JWK, AES-256 oct)', async () => {
    const key = await generateVaultKey();
    const exported = await exportVaultKey(key);
    const jwk = JSON.parse(
      Buffer.from(exported, 'base64url').toString('utf8')
    ) as JsonWebKey;
    expect(jwk.kty).toBe('oct');
    expect(jwk.alg).toBe('A256GCM');
    const reimported = await importVaultKey(exported);
    const enc = await encryptJson(key, sample);
    expect(await decryptJson<Payload>(reimported, enc)).toEqual(sample);
  });

  it('unicode and nested values round trip byte-exactly', async () => {
    const key = await generateVaultKey();
    const value = { s: 'Harga Jual — Sari Dewi ✓ — 1.500.000 Rp 😀', n: 1, deep: { a: [1, '2'] } };
    const enc = await encryptJson(key, value);
    expect(await decryptJson(key, enc)).toEqual(value);
  });
});
