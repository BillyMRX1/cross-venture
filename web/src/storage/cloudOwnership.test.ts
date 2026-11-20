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

import { pushEncrypted } from './db';

const ALICE = 'uid-alice';

describe('cloud workspace ownership (mocked transport, not Firestore rule verification)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockResolvedValue({ app: { name: 'mock-app' } });
    // The actual ensureSignedIn API returns a boolean, NOT a User object.
    mocks.ensureSignedIn.mockResolvedValue(true);
    mocks.getAuth.mockReturnValue({ currentUser: { uid: ALICE } });
    mocks.getDoc.mockResolvedValue({ exists: () => false, data: () => undefined });
  });

  it('persists the authenticated owner UID with a newly created encrypted workspace', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const payload: Parameters<typeof pushEncrypted>[1] = { graph: { ventures: [], partners: [], products: [], dealRules: [] }, tokenMap: {} };

    await pushEncrypted('ws-1', payload, key);

    expect(mocks.setDoc).toHaveBeenCalledTimes(1);
    const [ref, data] = mocks.setDoc.mock.calls[0];
    expect(ref).toEqual({ path: 'workspaces/ws-1' });
    expect(data).toMatchObject({ wsId: 'ws-1', ownerUid: ALICE });
    expect(typeof data.iv).toBe('string');
    expect(typeof data.cipher).toBe('string');
    expect(Object.keys(data).sort()).toEqual(['cipher', 'iv', 'ownerUid', 'updatedAt', 'wsId']);
  });
});
