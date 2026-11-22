import { describe, expect, it, vi } from 'vitest';
import {
  TRANSIENT_BUSY_MESSAGE,
  TransientExhaustedError,
  classifyInferenceError,
  withTransientRetry,
} from './transient';

// Fake-fetch error shapes mirroring the SDK surfaces we must classify.
// Round-5 real error (owner, 2026-11-22) reproduced verbatim in message form.
function fetchError500HighDemand(): Error & { customCode?: number } {
  const e = new Error(
    'Error fetching from https://firebasevertexai.googleapis.com/v1beta/projects/cross-venture/models/gemini-3.8-flash:generateContent: [500 ] ' +
    'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.',
  ) as Error & { customCode?: number };
  e.customCode = 500;
  return e;
}

describe('classifyInferenceError', () => {
  it('retries the documented 500 high-demand signature', () => {
    const c = classifyInferenceError(fetchError500HighDemand());
    expect(c.retryable).toBe(true);
    expect(c.retryable && c.kind).toBe('high-demand-500');
    expect(c.retryable && c.status).toBe(500);
  });

  it('does NOT retry a bare 500 without the transient signature', () => {
    const e = new Error('internal server error') as Error & { customCode: number };
    e.customCode = 500;
    const c = classifyInferenceError(e);
    expect(c.retryable).toBe(false);
  });

  it('retries 503 and 429', () => {
    const e503 = new Error('error') as Error & { status: number };
    e503.status = 503;
    expect(classifyInferenceError(e503).retryable).toBe(true);
    const e429 = new Error('error [429]') as Error & { customCode: number };
    e429.customCode = 429;
    const c = classifyInferenceError(e429);
    expect(c.retryable && c.kind).toBe('resource-exhausted-429');
  });

  it('honors Retry-After (seconds) and gRPC retryDelay', () => {
    const e = new Error('too many') as Error & { customCode: number; retryAfter: number };
    e.customCode = 429;
    e.retryAfter = 7;
    const c = classifyInferenceError(e);
    expect(c.retryable && c.retryAfterMs).toBe(7000);

    const g = new Error('busy') as Error & { status: number; retryDelay: { seconds: number } };
    g.status = 503;
    g.retryDelay = { seconds: 2 };
    const cg = classifyInferenceError(g);
    expect(cg.retryable && cg.retryAfterMs).toBe(2000);
  });

  it('never retries 4xx auth/model errors or plain network failures', () => {
    for (const code of [400, 401, 403, 404]) {
      const e = new Error(`err [${code}]`) as Error & { customCode: number };
      e.customCode = code;
      expect(classifyInferenceError(e).retryable, `code ${code}`).toBe(false);
    }
    expect(classifyInferenceError(new TypeError('fetch failed'))).toEqual({
      retryable: false,
      reason: 'no-status-not-transient',
    });
  });

  it('catches bracketed statuses WITH statusText (HTTP/1.1 shapes)', () => {
    const e503 = new Error('Error fetching: [503 Service Unavailable] backend down');
    expect(classifyInferenceError(e503).retryable).toBe(true);
    const e429 = new Error('Error fetching: [429 Too Many Requests] slow down');
    const c429 = classifyInferenceError(e429);
    expect(c429.retryable && c429.kind).toBe('resource-exhausted-429');
    const e500hd = new Error('Error fetching: [500 Internal Server Error] ' +
      'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.');
    const c500hd = classifyInferenceError(e500hd);
    expect(c500hd.retryable && c500hd.kind).toBe('high-demand-500');
    const e500plain = new Error('Error fetching: [500 Internal Server Error] boom');
    expect(classifyInferenceError(e500plain).retryable).toBe(false);
  });

  it('reads firebase/ai AIError shape: status inside customErrorData', () => {
    const e = new Error('Error fetching from ...:generateContent: This model is currently experiencing high demand. Please try again later.') as Error & {
      code: string;
      customErrorData: { status: number };
    };
    e.code = 'ai/fetch-error';
    e.customErrorData = { status: 500 };
    const c = classifyInferenceError(e);
    expect(c.retryable && c.kind).toBe('high-demand-500');
    expect(c.retryable && c.status).toBe(500);

    const e404 = new Error('model not found') as Error & { code: string; customErrorData: { status: number } };
    e404.code = 'ai/not-found';
    e404.customErrorData = { status: 404 };
    expect(classifyInferenceError(e404).retryable).toBe(false);
  });

  it('a Headers.get returning null does NOT short-circuit backoff (no 0ms retry)', async () => {
    const err = new Error('busy [500 ] high demand, please try again later') as Error & {
      customErrorData: { status: number };
      response: { headers: { get: (k: string) => string | null } };
    };
    err.customErrorData = { status: 500 };
    err.response = { headers: { get: () => null } };
    const sleeps: number[] = [];
    let calls = 0;
    await withTransientRetry(
      async () => { calls += 1; if (calls < 2) throw err; return 'ok'; },
      { sleep: async (ms) => { sleeps.push(ms); }, rng: () => 0 },
    );
    expect(sleeps).toEqual([2000]); // exponential, NOT 0ms
  });
  it('parses "7s" durations, HTTP-date Retry-After (seconds), and rejects empty retryAfter', async () => {
    const e7s = new Error('slow [429]') as Error & { customCode: number; retryAfter: string };
    e7s.customCode = 429;
    e7s.retryAfter = '7s';
    const c7 = classifyInferenceError(e7s);
    expect(c7.retryable && c7.retryAfterMs).toBe(7000);

    const future = new Date(Date.now() + 30_000).toUTCString();
    const eDate = new Error('slow [429]') as Error & { customCode: number; retryAfter: string };
    eDate.customCode = 429;
    eDate.retryAfter = future;
    const cd = classifyInferenceError(eDate);
    expect(cd.retryable && cd.retryAfterMs !== undefined).toBe(true);
    // Must be ~30 000 ms, NOT 30 000 000 (unit regression guard).
    expect(cd.retryable && cd.retryAfterMs! > 20_000 && cd.retryable && cd.retryAfterMs! <= 31_000).toBe(true);

    const eEmpty = new Error('busy [503]') as Error & { status: number; retryAfter: string };
    eEmpty.status = 503;
    eEmpty.retryAfter = '';
    const ce = classifyInferenceError(eEmpty);
    expect(ce.retryable && ce.retryAfterMs).toBeUndefined();

    const eNeg = new Error('busy [503]') as Error & { status: number; retryDelay: { seconds: number } };
    eNeg.status = 503;
    eNeg.retryDelay = { seconds: -5 };
    const cn = classifyInferenceError(eNeg);
    expect(cn.retryable && cn.retryAfterMs).toBe(0); // clamped, never negative
  });
});

describe('withTransientRetry (fake sleep/rng)', () => {
  it('succeeds on the 3rd attempt of a transient sequence', async () => {
    const sleeps: number[] = [];
    const notices: Array<[number, number, string]> = [];
    let calls = 0;
    const out = await withTransientRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw fetchError500HighDemand();
        return 'ok';
      },
      {
        sleep: async (ms) => { sleeps.push(ms); },
        rng: () => 0, // deterministic: no jitter
        onRetry: (a, w, k) => notices.push([a, w, k]),
      },
    );
    expect(out).toBe('ok');
    expect(calls).toBe(3);
    expect(sleeps).toEqual([2000, 4000]); // exponential
    expect(notices).toEqual([[1, 2000, 'high-demand-500'], [2, 4000, 'high-demand-500']]);
  });

  it('adds bounded jitter with a different rng', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    await withTransientRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw fetchError500HighDemand();
        return 'ok';
      },
      { sleep: async (ms) => { sleeps.push(ms); }, rng: () => 1 },
    );
    expect(sleeps).toEqual([3000, 6000]); // base + 50% max jitter
  });

  it('caps total attempts at maxAttempts and throws a clear busy error', async () => {
    const err = fetchError500HighDemand();
    let calls = 0;
    await expect(
      withTransientRetry(async () => { calls += 1; throw err; }, { sleep: async () => {}, rng: () => 0 }),
    ).rejects.toThrowError(TransientExhaustedError);
    expect(calls).toBe(3);
    try {
      await withTransientRetry(async () => { throw err; }, { sleep: async () => {}, rng: () => 0 });
    } catch (e) {
      expect((e as TransientExhaustedError).message).toContain(TRANSIENT_BUSY_MESSAGE);
      expect((e as TransientExhaustedError).attempts).toBe(3);
    }
  });

  it('does NOT retry a 401 — exactly one call, original error rethrown', async () => {
    const e401 = new Error('token invalid [401]') as Error & { customCode: number };
    e401.customCode = 401;
    let calls = 0;
    await expect(
      withTransientRetry(async () => { calls += 1; throw e401; }, { sleep: async () => {} }),
    ).rejects.toBe(e401);
    expect(calls).toBe(1);
  });

  it('uses Retry-After instead of backoff when present (capped)', async () => {
    const e = new Error('too many [429]') as Error & { customCode: number; retryAfter: number };
    e.customCode = 429;
    e.retryAfter = 1; // 1s
    const sleeps: number[] = [];
    let calls = 0;
    await withTransientRetry(
      async () => { calls += 1; if (calls < 2) throw e; return 'ok'; },
      { sleep: async (ms) => { sleeps.push(ms); }, rng: () => 1 },
    );
    expect(sleeps).toEqual([1000]);
  });
});
