import { describe, expect, it } from 'vitest';
import type { Workspace } from '../types';
import {
  MULTI_VENTURE_HINT_KEY,
  MULTI_VENTURE_HINT_TEXT,
  markMultiVentureHintSeen,
  shouldShowMultiVentureHint,
  uniqueVentureOptions,
} from './workspaceCue';

function makeWorkspace(
  ventures: Array<{ id: string; token: string; name?: string }>,
): Workspace {
  const tokenMap: Record<string, string> = {};
  for (const v of ventures) {
    if (v.name !== undefined) {
      tokenMap[v.token] = v.name;
    }
  }
  return {
    id: 'ws-test',
    name: 'Test Workspace',
    graph: {
      ventures: ventures.map((v, i) => ({
        venture_id: v.id,
        venture_token: v.token,
        min_margin_pct_token: `[MARGIN_FLOOR_${i + 1}]`,
      })),
      partners: [],
      products: [],
      dealRules: [],
    },
    tokenMap,
    docs: [],
    payloadLog: [],
    updatedAt: 1,
  };
}

function makeMemoryStorage(initial: Record<string, string> = {}) {
  const data: Record<string, string> = { ...initial };
  return {
    data,
    get: (k: string): string | null => (k in data ? data[k] : null),
    set: (k: string, v: string): void => {
      data[k] = v;
    },
  };
}

describe('uniqueVentureOptions', () => {
  it('returns an empty list for null or empty workspaces', () => {
    expect(uniqueVentureOptions(null)).toEqual([]);
    expect(uniqueVentureOptions(makeWorkspace([]))).toEqual([]);
  });

  it('deduplicates legal-suffix and punctuation variants of the same company', () => {
    const ws = makeWorkspace([
      { id: 'v-1', token: '[VENTURE_1]', name: 'Atelier Emily LLC' },
      { id: 'v-2', token: '[VENTURE_2]', name: 'Atelier Emily L.L.C.' },
      { id: 'v-3', token: '[VENTURE_3]', name: 'Atelier Emily' },
    ]);

    expect(uniqueVentureOptions(ws)).toEqual([
      { ventureId: 'v-1', label: 'Atelier Emily LLC' },
    ]);
  });

  it('deduplicates additional legal suffixes while preserving first-appearance order', () => {
    const ws = makeWorkspace([
      { id: 'v-1', token: '[VENTURE_1]', name: 'RoastLab Specialty Roasters Inc.' },
      { id: 'v-2', token: '[VENTURE_2]', name: 'RoastLab Specialty Roasters, Pte. Ltd.' },
      { id: 'v-3', token: '[VENTURE_3]', name: 'PT Atelier Emily' },
      { id: 'v-4', token: '[VENTURE_4]', name: 'Atelier Emily GmbH' },
      { id: 'v-5', token: '[VENTURE_5]', name: 'Nomad Studio Corp.' },
      { id: 'v-6', token: '[VENTURE_6]', name: 'Nomad Studio Co., Ltd.' },
    ]);

    expect(uniqueVentureOptions(ws)).toEqual([
      { ventureId: 'v-1', label: 'RoastLab Specialty Roasters Inc.' },
      { ventureId: 'v-3', label: 'PT Atelier Emily' },
      { ventureId: 'v-5', label: 'Nomad Studio Corp.' },
    ]);
  });

  it('keeps distinct ventures in order', () => {
    const ws = makeWorkspace([
      { id: 'v-ae', token: '[VENTURE_1]', name: 'Atelier Emily LLC' },
      { id: 'v-ns', token: '[VENTURE_2]', name: 'Nomad Studio LLC' },
      { id: 'v-rl', token: '[VENTURE_3]', name: 'RoastLab Specialty Roasters Inc.' },
    ]);

    expect(uniqueVentureOptions(ws)).toEqual([
      { ventureId: 'v-ae', label: 'Atelier Emily LLC' },
      { ventureId: 'v-ns', label: 'Nomad Studio LLC' },
      { ventureId: 'v-rl', label: 'RoastLab Specialty Roasters Inc.' },
    ]);
  });

  it('falls back to venture_id when token hydration is missing', () => {
    const ws = makeWorkspace([
      { id: 'v-raw-1', token: '[VENTURE_1]' },
      { id: 'v-raw-2', token: '[VENTURE_2]' },
    ]);

    expect(uniqueVentureOptions(ws)).toEqual([
      { ventureId: 'v-raw-1', label: 'v-raw-1' },
      { ventureId: 'v-raw-2', label: 'v-raw-2' },
    ]);
  });
});

describe('multi-venture hint visibility', () => {
  it('uses the exact product copy and storage key', () => {
    expect(MULTI_VENTURE_HINT_TEXT).toBe('Each company keeps its own rules and requests.');
    expect(MULTI_VENTURE_HINT_KEY).toBe('cv.multiVentureHintSeen');
  });

  it('returns false for 0 or 1 venture', () => {
    const storage = makeMemoryStorage();
    expect(shouldShowMultiVentureHint(0, storage)).toBe(false);
    expect(shouldShowMultiVentureHint(1, storage)).toBe(false);
  });

  it('returns true for 2+ ventures on first view when key is absent', () => {
    const storage = makeMemoryStorage();
    expect(shouldShowMultiVentureHint(2, storage)).toBe(true);
    expect(shouldShowMultiVentureHint(3, storage)).toBe(true);
  });

  it('returns false after markMultiVentureHintSeen even with 2+ ventures', () => {
    const storage = makeMemoryStorage();
    expect(shouldShowMultiVentureHint(2, storage)).toBe(true);

    markMultiVentureHintSeen(storage);

    expect(storage.data[MULTI_VENTURE_HINT_KEY]).toBe('1');
    expect(shouldShowMultiVentureHint(2, storage)).toBe(false);
    expect(shouldShowMultiVentureHint(5, storage)).toBe(false);
  });
});
