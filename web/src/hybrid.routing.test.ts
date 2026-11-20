import { beforeEach, describe, expect, it, vi } from 'vitest';

// Patch 6 (security verification 2026-11-20): routing regression tests ONLY —
// no production-code changes. The privacy routing invariant: raw-text stages
// ('redact', 'query') may ONLY use InferenceMode.ONLY_ON_DEVICE; a cloud model
// (created without a `mode`) must never exist during those stages.

type ModelOpts = { mode?: string; model?: string };
type FakeModel = {
  initializeDeviceModel: () => Promise<void>;
  generateContent: (p: string) => Promise<{ response: { text: () => string } }>;
};

const h = vi.hoisted(() => ({
  getModelMock: vi.fn(),
  initImpl: null as null | (() => Promise<void>),
  genImpl: null as null | ((p: string) => Promise<{ response: { text: () => string } }>),
}));

vi.mock('firebase/ai', () => ({
  getGenerativeModel: h.getModelMock,
  InferenceMode: {
    ONLY_ON_DEVICE: 'ONLY_ON_DEVICE',
    CLOUD_WITH_ON_DEVICE_FALLBACK: 'CLOUD_WITH_ON_DEVICE_FALLBACK',
  },
}));

vi.mock('./firebase', () => ({
  getAIInstance: vi.fn(async () => ({ __ai: true })),
  isConfigured: () => true,
  cloudModel: () => 'gemini-test',
  onDeviceModel: () => 'pixel-ai-test',
}));

function defaultModel(): void {
  h.initImpl = async () => {};
  h.genImpl = async () => ({ response: { text: () => 'ok' } });
}

beforeEach(() => {
  h.getModelMock.mockReset();
  defaultModel();
  h.getModelMock.mockImplementation((_ai: unknown, _opts: ModelOpts): FakeModel => ({
    initializeDeviceModel: () => h.initImpl!(),
    generateContent: (p: string) => h.genImpl!(p),
  }));
});

async function freshHybrid() {
  vi.resetModules();
  return await import('./hybrid');
}

function everyModelHadOnDeviceMode(): void {
  const calls = h.getModelMock.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect((call[1] as ModelOpts).mode).toBe('ONLY_ON_DEVICE'); // never a modeless/cloud model
  }
}

describe('privacy routing regressions (Patch 6)', () => {
  it('initializeDeviceModel rejects -> HybridUnavailableError for redact, and NO model was ever created without ONLY_ON_DEVICE', async () => {
    h.initImpl = async () => {
      throw new Error('device model download blocked');
    };
    const { generate, HybridUnavailableError } = await freshHybrid();
    await expect(generate('redact', 'raw contract text')).rejects.toThrow(HybridUnavailableError);
    try {
      await generate('redact', 'raw contract text');
    } catch (e) {
      expect((e as InstanceType<typeof HybridUnavailableError>).stage).toBe('redact');
    }
    everyModelHadOnDeviceMode();
  });

  it('generateContent rejects with a schema -> HybridUnavailableError, still no modeless model', async () => {
    h.genImpl = async () => {
      throw new Error('schema violation');
    };
    const { generate, HybridUnavailableError } = await freshHybrid();
    await expect(generate('redact', 'raw text', { type: 'object' })).rejects.toThrow(HybridUnavailableError);
    everyModelHadOnDeviceMode();
  });

  it('anonymizeChunks while the model route rejects: redact stage never creates a cloud model, and raw values stay local', async () => {
    h.initImpl = async () => {
      throw new Error('device model unavailable');
    };
    vi.resetModules();
    const { anonymizeChunks } = await import('./ingest/anonymizer');
    const { blinded } = await anonymizeChunks([
      { docName: 'deals.md', page: 1, index: 0, text: 'harga 500 total, margin 55% floor' },
    ]);
    const text = blinded[0].text;
    expect(text).not.toContain('500');
    expect(text).not.toContain('55');
    // every model built during a raw-text stage was on-device only ('synthesize' never ran):
    for (const call of h.getModelMock.mock.calls) {
      expect((call[1] as ModelOpts).mode).toBe('ONLY_ON_DEVICE');
    }
    expect(h.getModelMock.mock.calls.length).toBeGreaterThan(0);
  });
});
