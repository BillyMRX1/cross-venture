/**
 * Bounded transient-error handling for cloud inference (CEO directive
 * OWNER_ROUND5_RESULT_20261122.md, 2026-11-22):
 * retry ONLY documented transient conditions — 500 "high demand", 503 and 429
 * (honoring Retry-After when the transport exposes it) — with exponential
 * backoff + jitter and a hard attempt cap. NEVER retry 4xx auth/model errors.
 * Pure logic; time/randomness/sleep are injectable so it is unit-testable.
 */

export interface TransientInfo {
  retryable: true;
  kind: 'high-demand-500' | 'unavailable-503' | 'resource-exhausted-429';
  /** Server-suggested wait when the error carries Retry-After / retryDelay. */
  retryAfterMs?: number;
  /** Best-effort HTTP-ish status seen on the error (for logs/tests). */
  status?: number;
}

export interface NonTransientInfo {
  retryable: false;
  reason: string;
}

export type ClassifiedError = TransientInfo | NonTransientInfo;

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err ?? '');
}

function numericStatus(err: unknown): number | undefined {
  const e = err as Record<string, unknown> | null | undefined;
  if (!e) return undefined;
  for (const key of ['customCode', 'status', 'httpStatus', 'code']) {
    const raw = e[key];
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    if (Number.isInteger(n) && n >= 100 && n <= 599) return n;
  }
  const m = messageOf(err).match(/\[(\d{3})\s*\]/);
  if (m) return Number(m[1]);
  return undefined;
}

function retryAfterMsOf(err: unknown): number | undefined {
  const e = err as Record<string, unknown> | null | undefined;
  if (!e) return undefined;
  // gRPC-style retry delay ({ seconds } / { nanos } / plain ms fields).
  for (const key of ['retryDelayMs', 'retryAfterMs']) {
    const n = Number(e[key]);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const delay = e.retryDelay as { seconds?: number; nanos?: number } | undefined;
  if (delay && (delay.seconds !== undefined || delay.nanos !== undefined)) {
    return Math.round((delay.seconds ?? 0) * 1000 + (delay.nanos ?? 0) / 1e6);
  }
  // HTTP Retry-After header if the SDK surfaced response headers.
  const resp = e.response as { headers?: { get?: (k: string) => string | null } } | undefined;
  const headers = resp?.headers;
  if (headers && typeof headers.get === 'function') {
    const ra = headers.get('Retry-After') ?? headers.get('retry-after');
    const n = Number(ra);
    if (Number.isFinite(n) && n >= 0) return n * 1000;
  }
  const ra = e.retryAfter;
  const n = Number(ra);
  if (Number.isFinite(n) && n >= 0) return n * 1000;
  return undefined;
}

/**
 * Classify whether an inference error is a DOCUMENTED transient condition.
 * Conservative: anything we cannot positively identify as transient (all 4xx,
 * generic network failures, unknown shapes) is NOT retried.
 */
export function classifyInferenceError(err: unknown): ClassifiedError {
  const msg = messageOf(err);
  const status = numericStatus(err);
  const retryAfterMs = retryAfterMsOf(err);

  if (status === 429) {
    return { retryable: true, kind: 'resource-exhausted-429', retryAfterMs, status };
  }
  if (status === 503) {
    return { retryable: true, kind: 'unavailable-503', retryAfterMs, status };
  }
  if (status === 500) {
    // Only Google's documented capacity signature; a generic 500 is not retried.
    if (/high demand|try again later/i.test(msg)) {
      return { retryable: true, kind: 'high-demand-500', retryAfterMs, status };
    }
    return { retryable: false, reason: 'status-500-without-transient-signature' };
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return { retryable: false, reason: `client-error-${status}` };
  }
  // gRPC UNAVAILABLE (14) / RESOURCE_EXHAUSTED (8) without an HTTP status.
  if (status === undefined) {
    if (/unavailable/i.test(msg) && /(503|UNAVAILABLE)/.test(msg)) {
      return { retryable: true, kind: 'unavailable-503', retryAfterMs };
    }
  }
  return { retryable: false, reason: status === undefined ? 'no-status-not-transient' : `status-${status}-not-transient` };
}

export class TransientExhaustedError extends Error {
  attempts: number;
  lastError: unknown;

  constructor(message: string, attempts: number, lastError: unknown) {
    super(message);
    this.name = 'TransientExhaustedError';
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  rng?: () => number;
  /** UI notice before each wait; attempt = the attempt that just failed (1-based). */
  onRetry?: (attempt: number, waitMs: number, kind: TransientInfo['kind']) => void;
}

export const TRANSIENT_BUSY_MESSAGE =
  'Gemini is busy right now — try again in a few minutes';

/**
 * Run `call` with bounded retries for classified-transient errors only.
 * Delay = min(maxDelay, base * 2^(attempt-1)) plus jitter (0..half), or the
 * server-suggested Retry-After when present. At most `maxAttempts` total calls.
 */
export async function withTransientRetry<T>(
  call: (attempt: number) => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const base = opts.baseDelayMs ?? 2000;
  const cap = opts.maxDelayMs ?? 15000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rng = opts.rng ?? Math.random;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await call(attempt);
    } catch (err) {
      lastErr = err;
      const info = classifyInferenceError(err);
      if (!info.retryable || attempt === maxAttempts) {
        if (err instanceof Error && err.constructor.name === 'TransientExhaustedError') throw err;
        if (info.retryable && attempt === maxAttempts) {
          throw new TransientExhaustedError(
            `${TRANSIENT_BUSY_MESSAGE} (gave up after ${maxAttempts} attempts; last condition: ${info.kind})`,
            attempt,
            err,
          );
        }
        throw err;
      }
      const backoff = Math.min(cap, base * 2 ** (attempt - 1));
      const jitter = backoff * rng() * 0.5;
      const wait = info.retryAfterMs !== undefined ? Math.min(cap, info.retryAfterMs) : backoff + jitter;
      opts.onRetry?.(attempt, Math.round(wait), info.kind);
      await sleep(Math.round(wait));
    }
  }
  // Unreachable: loop always returns or throws.
  throw lastErr;
}
