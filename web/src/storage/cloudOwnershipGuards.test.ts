import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setDoc: vi.fn(),
  getDoc: vi.fn(),
  doc: vi.fn((_db: unknown, collection: string, id: string) => ({ path: `${collection}/${id}` })),
  ensureSignedIn: vi.fn(),
  getDb: vi.fn(),
  getAuth: vi.fn(),
}));

vi.mock('firebase/firestore', () => ({ doc: mocks.doc, getDoc: mocks.getDoc, setDoc: mocks.setDoc }));
vi.mock('firebase/auth', () => ({ getAuth: mocks.getAuth }));
vi.mock('../firebase', () => ({ ensureSignedIn: mocks.ensureSignedIn, getDb: mocks.getDb }));

import { pullAndDecrypt, pushEncrypted, ReadOnlyWorkspaceError } from './db';
import { encryptJson, exportVaultKey, generateVaultKey } from '../crypto/vault';

type Payload = Parameters<typeof pushEncrypted>[1];
const payload: Payload = { graph: { ventures: [], partners: [], products: [], dealRules: [] }, tokenMap: {} };

function existing(data: Record<string, unknown>) {
  mocks.getDoc.mockResolvedValue({ exists: () => true, data: () => data });
}
function b64url(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('cloud ownership guards (mocked transport; NOT Firestore rule verification)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockResolvedValue({ app: { name: 'mock-app' } });
    mocks.ensureSignedIn.mockResolvedValue(true);
    mocks.getAuth.mockReturnValue({ currentUser: { uid: 'uid-alice' } });
    mocks.getDoc.mockResolvedValue({ exists: () => false, data: () => undefined });
  });

  it('owner updates their own doc and keeps ownerUid unchanged', async () => {
    const key = await generateVaultKey();
    existing({ wsId: 'ws-1', ownerUid: 'uid-alice', iv: 'x', cipher: 'y', updatedAt: 1 });
    await pushEncrypted('ws-1', payload, key);
    expect(mocks.setDoc).toHaveBeenCalledTimes(1);
    expect(mocks.setDoc.mock.calls[0][1].ownerUid).toBe('uid-alice');
  });

  it('refuses to overwrite a doc owned by another uid (read-only paired device)', async () => {
    const key = await generateVaultKey();
    existing({ wsId: 'ws-1', ownerUid: 'uid-bob', iv: 'x', cipher: 'y', updatedAt: 1 });
    await expect(pushEncrypted('ws-1', payload, key)).rejects.toBeInstanceOf(ReadOnlyWorkspaceError);
    expect(mocks.setDoc).not.toHaveBeenCalled();
  });

  it('never claims an unowned legacy doc', async () => {
    const key = await generateVaultKey();
    existing({ wsId: 'ws-1', iv: 'x', cipher: 'y', updatedAt: 1 });
    await expect(pushEncrypted('ws-1', payload, key)).rejects.toBeInstanceOf(ReadOnlyWorkspaceError);
    expect(mocks.setDoc).not.toHaveBeenCalled();
  });

  it('fails closed when there is no authenticated uid', async () => {
    const key = await generateVaultKey();
    mocks.getAuth.mockReturnValue({ currentUser: null });
    await expect(pushEncrypted('ws-1', payload, key)).rejects.toThrow(/No authenticated Firebase user/);
    expect(mocks.setDoc).not.toHaveBeenCalled();
  });

  it('never writes key material, plaintext or token map as document fields', async () => {
    const key = await generateVaultKey();
    const secretPayload: Payload = { ...payload, tokenMap: { '[PARTNER_1]': 'Secret Corp' } };
    await pushEncrypted('ws-1', secretPayload, key);
    const written = JSON.stringify(mocks.setDoc.mock.calls[0][1]);
    expect(written).not.toContain('Secret Corp');
    expect(written).not.toContain(await exportVaultKey(key));
    expect(mocks.setDoc.mock.calls[0][1]).not.toHaveProperty('tokenMap');
  });

  it('a reader with a different uid can fetch and decrypt a known-id doc', async () => {
    const key = await generateVaultKey();
    const enc = await encryptJson(key, payload);
    existing({ wsId: 'ws-1', ownerUid: 'uid-alice', ...enc, updatedAt: 1 });
    mocks.getAuth.mockReturnValue({ currentUser: { uid: 'uid-phone' } });
    const pair = b64url(JSON.stringify({ wsId: 'ws-1', key: await exportVaultKey(key) }));
    await expect(pullAndDecrypt(pair)).resolves.toEqual(payload);
    expect(mocks.setDoc).not.toHaveBeenCalled();
  });
});
