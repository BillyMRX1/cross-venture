import { beforeEach, describe, expect, it, vi } from 'vitest';

// Transient-retry wiring for the CLOUD synthesize path (CEO 2026-11-22):
// the retry wrapper must fire on 500 high-demand / 503 / 429 ONLY, must never
// retry 4xx, and the opt-in fallback model must stay off by default.

type FakeResult = { response: { text: () => string } };

const h = vi.hoisted(() => ({
  getModelMock: vi.fn(),
  genImpl: null as null | ((p: string) => Promise<FakeResult>),
  fallback: '' as string,
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
  cloudModelFallback: () => h.fallback,
  onDeviceModel: () => 'pixel-ai-test',
}));

import { TransientExhaustedError, TRANSIENT_BUSY_MESSAGE } from './cloud/transient';
import { SYNTHESIZE_MAX_ATTEMPTS, generate } from './hybrid';

function transient500(): Error & { customCode: number } {
  const e = new Error(
    'Error fetching from https://firebasevertexai.googleapis.com/.../models/gemini-test:generateContent: [500 ] ' +
    'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.',
  ) as Error & { customCode: number };
  e.customCode = 500;
  return e;
}

function modelReturning(...fails: Array<Error | null>): void {
  let i = 0;
  h.getModelMock.mockImplementation((_ai: unknown, opts: { model?: string }) => ({
    model: opts?.model,
    generateContent: async () => {
      const f = fails[i++];
      if (f) throw f;
      return { response: { text: () => `json-for:${opts?.model}` } } as FakeResult;
    },
  }));
}

beforeEach(() => {
  h.getModelMock.mockReset();
  h.genImpl = null;
  h.fallback = '';
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('generate(synthesize) transient handling', () => {
  it('retries 500 high-demand and succeeds on the 3rd call (max 3 total)', async () => {
    modelReturning(transient500(), transient500(), null);
    const notices: Array<[number, number]> = [];
    const r = await generate(
      'synthesize',
      'prompt',
      {},
      { onRetry: (a, w) => notices.push([a, w]) },
    );
    expect(r.text).toBe('json-for:gemini-test');
    expect(r.usedOnDevice).toBe(false);
    expect(h.getModelMock).toHaveBeenCalledTimes(1); // one cloud model handle
    expect(notices.length).toBe(2);
  }, 15000); // real backoff sleeps (~2s + ~4s)

  it('never retries 401: exactly one call, original error propagates', async () => {
    const e401 = new Error('token invalid [401]') as Error & { customCode: number };
    e401.customCode = 401;
    let calls = 0;
    h.getModelMock.mockImplementation(() => ({
      generateContent: async () => { calls += 1; throw e401; },
    }));
    await expect(generate('synthesize', 'prompt', {})).rejects.toBe(e401);
    expect(calls).toBe(1);
  });

  it('fallback is OFF by default: exhausted primary never creates a second model', async () => {
    modelReturning(transient500(), transient500(), transient500());
    const err = await generate('synthesize', 'prompt', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientExhaustedError);
    expect((err as Error).message).toContain(TRANSIENT_BUSY_MESSAGE);
    expect(h.getModelMock.mock.calls.map((c) => (c[1] as { model?: string }).model))
      .toEqual(['gemini-test']);
  }, 15000);

  it('opt-in fallback: after primary exhaustion, exactly one call on the fallback model', async () => {
    h.fallback = 'gemini-test-fb';
    modelReturning(transient500(), transient500(), transient500(), null);
    const r = await generate('synthesize', 'prompt', {});
    expect(r.text).toBe('json-for:gemini-test-fb');
    expect(r.model).toBe('gemini-test-fb');
    expect(h.getModelMock.mock.calls.map((c) => (c[1] as { model?: string }).model))
      .toEqual(['gemini-test', 'gemini-test-fb']);
  }, 15000);

  it('opt-in fallback with a 4xx error surfaces the RAW error, not "busy"', async () => {
    h.fallback = 'gemini-test-fb-missing';
    const e404 = new Error('model not found [404]') as Error & { customCode: number };
    e404.customCode = 404;
    modelReturning(transient500(), transient500(), e404);
    const err = await generate('synthesize', 'prompt', {}).catch((e: unknown) => e);
    expect(err).toBe(e404); // honest surfacing, never dressed as busy
  }, 15000);

  it('adds jitter to concurrent retries (including Retry-After) and caps attempts at SYNTHESIZE_MAX_ATTEMPTS', async () => {
    expect(SYNTHESIZE_MAX_ATTEMPTS).toBe(3);

    // Two concurrent calls both hit Retry-After: 2s — jitter spreads their wait times so they do not stampede.
    const waitsA: number[] = [];
    const waitsB: number[] = [];
    const err429 = () => {
      const e = new Error('rate limited [429]') as Error & { customCode: number; retryAfter: number };
      e.customCode = 429;
      e.retryAfter = 2;
      return e;
    };

    const callCounts = new Map<string, number>();
    h.getModelMock.mockImplementation(() => ({
      generateContent: async (prompt: string) => {
        const n = (callCounts.get(prompt) ?? 0) + 1;
        callCounts.set(prompt, n);
        if (n < 3) throw err429();
        return { response: { text: () => `ok:${prompt}` } } as FakeResult;
      },
    }));

    const [ra, rb] = await Promise.all([
      generate('synthesize', 'docA', {}, {
        onRetry: (_a, w) => waitsA.push(w),
        rng: () => 0.1,
        sleep: async () => {},
      }),
      generate('synthesize', 'docB', {}, {
        onRetry: (_a, w) => waitsB.push(w),
        rng: () => 0.9,
        sleep: async () => {},
      }),
    ]);

    expect(ra.text).toBe('ok:docA');
    expect(rb.text).toBe('ok:docB');
    expect(callCounts.get('docA')).toBe(3);
    expect(callCounts.get('docB')).toBe(3);
    expect(waitsA.length).toBe(2);
    expect(waitsB.length).toBe(2);
    // Jittered waits must differ between concurrent callers so retries do not stampede.
    expect(waitsB[0]).toBeGreaterThan(waitsA[0]);
  });
});
