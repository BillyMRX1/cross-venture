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

// Review F2: both raw-text stages must hold the invariant.
for (const stage of ['redact', 'query'] as const) {
  describe(`privacy routing for '${stage}' (Patch 6)`, () => {
    it(`initializeDeviceModel rejects -> HybridUnavailableError(stage='${stage}'), no model without ONLY_ON_DEVICE`, async () => {
      h.initImpl = async () => {
        throw new Error('device model download blocked');
      };
      const { generate, HybridUnavailableError } = await freshHybrid();
      // Review F1: rejects matcher (no try/catch that can pass vacuously).
      await expect(generate(stage, 'raw contract text')).rejects.toMatchObject({
        stage,
      });
      await expect(generate(stage, 'raw contract text')).rejects.toBeInstanceOf(
        HybridUnavailableError,
      );
      everyModelHadOnDeviceMode();
    });

    it(`generateContent rejects with a schema -> HybridUnavailableError, still no modeless model`, async () => {
      h.genImpl = async () => {
        throw new Error('schema violation');
      };
      const { generate, HybridUnavailableError } = await freshHybrid();
      await expect(generate(stage, 'raw text', { type: 'object' })).rejects.toThrow(
        HybridUnavailableError,
      );
      everyModelHadOnDeviceMode();
    });
  });
}

describe('anonymizer degradation (Patch 6)', () => {
  it('anonymizeChunks while the device route rejects: only on-device models built, raw values stay local', async () => {
    h.initImpl = async () => {
      throw new Error('device model unavailable');
    };
    vi.resetModules();
    const { anonymizeChunks } = await import('./ingest/anonymizer');
    const raw = 'harga 500 total, margin 55% floor';
    const { blinded } = await anonymizeChunks([
      { docName: 'deals.md', page: 1, index: 0, text: raw },
    ]);
    const text = blinded[0].text;
    // Review F3: robust checks instead of bare substring misses.
    expect(text).not.toBe(raw);
    expect(text).not.toMatch(/(^|[^\w.])500([^\w.]|$)/);
    expect(text).not.toMatch(/(^|[^\w.])55([^\w.]|$)/);
    // every model built during a raw-text stage was on-device only ('synthesize' never ran):
    for (const call of h.getModelMock.mock.calls) {
      expect((call[1] as ModelOpts).mode).toBe('ONLY_ON_DEVICE');
    }
    expect(h.getModelMock.mock.calls.length).toBeGreaterThan(0);
  });

  it('positive control (review F4): synthesize DOES create a modeless cloud model, so the mode check can detect one', async () => {
    const { generate } = await freshHybrid();
    await generate('synthesize', 'already blinded text');
    const modeless = h.getModelMock.mock.calls.filter(
      (call) => (call[1] as ModelOpts).mode === undefined,
    );
    expect(modeless.length).toBeGreaterThan(0);
  });
});
