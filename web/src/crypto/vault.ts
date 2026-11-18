interface BufferLike {
  toString(encoding: string): string;
}

interface BufferConstructorLike {
  from(input: Uint8Array): BufferLike;
  from(input: string, encoding: string): Uint8Array;
}

function getSubtle(): { cryptoApi: Crypto; subtle: SubtleCrypto } {
  const cryptoApi =
    globalThis.crypto ?? (globalThis as unknown as { webcrypto?: Crypto }).webcrypto;
  if (!cryptoApi?.subtle) {
    throw new Error('WebCrypto subtle API is unavailable in this environment');
  }
  return { cryptoApi, subtle: cryptoApi.subtle };
}

function getNodeBuffer(): BufferConstructorLike | undefined {
  return (globalThis as unknown as { Buffer?: BufferConstructorLike }).Buffer;
}

function toBase64Url(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  const Buf = getNodeBuffer();
  if (!Buf) {
    throw new Error('No base64 encoder available');
  }
  return Buf.from(bytes).toString('base64url');
}

function fromBase64Url(input: string): Uint8Array<ArrayBuffer> {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padLen);

  if (typeof atob === 'function') {
    const binary = atob(padded);
    const out = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  }

  const Buf = getNodeBuffer();
  if (!Buf) {
    throw new Error('No base64 decoder available');
  }
  const buf = Buf.from(padded, 'base64');
  const out = new Uint8Array(new ArrayBuffer(buf.length));
  out.set(buf);
  return out;
}

/**
 * Generates an extractable AES-256-GCM vault CryptoKey.
 */
export async function generateVaultKey(): Promise<CryptoKey> {
  const { subtle } = getSubtle();
  return subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

/**
 * Exports a vault CryptoKey as a base64url-encoded JWK string.
 */
export async function exportVaultKey(k: CryptoKey): Promise<string> {
  const { subtle } = getSubtle();
  const jwk = await subtle.exportKey('jwk', k);
  const bytes = new TextEncoder().encode(JSON.stringify(jwk));
  return toBase64Url(bytes);
}

/**
 * Imports a base64url-encoded JWK string back into an AES-256-GCM CryptoKey.
 */
export async function importVaultKey(s: string): Promise<CryptoKey> {
  const { subtle } = getSubtle();
  const bytes = fromBase64Url(s);
  const jwk = JSON.parse(new TextDecoder().decode(bytes)) as JsonWebKey;
  return subtle.importKey('jwk', jwk, { name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Encrypts a JSON-serializable value with AES-256-GCM and a fresh 12-byte random IV.
 */
export async function encryptJson(
  k: CryptoKey,
  obj: unknown
): Promise<{ iv: string; cipher: string }> {
  const { cryptoApi, subtle } = getSubtle();
  const iv = cryptoApi.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const plaintext = new TextEncoder().encode(JSON.stringify(obj));
  const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, k, plaintext);
  return {
    iv: toBase64Url(iv),
    cipher: toBase64Url(new Uint8Array(ciphertext)),
  };
}

/**
 * Decrypts an AES-256-GCM payload produced by encryptJson and parses its JSON body.
 */
export async function decryptJson<T = unknown>(
  k: CryptoKey,
  p: { iv: string; cipher: string }
): Promise<T> {
  const { subtle } = getSubtle();
  const iv = fromBase64Url(p.iv);
  const ciphertext = fromBase64Url(p.cipher);
  const plaintext = await subtle.decrypt({ name: 'AES-GCM', iv }, k, ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
