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
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    if (Number.isInteger(n) && n >= 100 && n <= 599) return n;
  }
  // firebase/ai AIError shape: numeric HTTP status lives in customErrorData.status
  // (top-level `code` is a STRING like 'ai/fetch-error').
  const ced = e.customErrorData as Record<string, unknown> | undefined;
  if (ced) {
    const n = Number(ced.status);
    if (Number.isInteger(n) && n >= 100 && n <= 599) return n;
  }
  // Bracketed status in the fetch-error message, with optional statusText:
  // "[500 ]", "[503 Service Unavailable]", "[429 Too Many Requests]".
  const m = messageOf(err).match(/\[(\d{3})(?:\s+[^\]]*)?\]/);
  if (m) {
    const n = Number(m[1]);
    if (n >= 100 && n <= 599) return n;
  }
  return undefined;
}

/** Strict non-negative number parse: rejects null/undefined/empty/NaN. */
function parseNonNegativeNumber(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : undefined;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return undefined;
    const n = Number(s);
    if (Number.isFinite(n) && n >= 0) return n;
    // Duration strings like "7s" / "120s" (Google REST RetryInfo style).
    const sm = s.match(/^(\d+(?:\.\d+)?)s$/i);
    if (sm) return Number(sm[1]);
    // HTTP-date Retry-After — returned in SECONDS, like every other branch.
    const d = Date.parse(s);
    if (!Number.isNaN(d)) {
      const ms = d - Date.now();
      return ms > 0 ? ms / 1000 : 0;
    }
    return undefined;
  }
  return undefined;
}

function retryAfterMsOf(err: unknown): number | undefined {
  const e = err as Record<string, unknown> | null | undefined;
  if (!e) return undefined;
  // gRPC-style retry delay ({ seconds } / { nanos } / plain ms fields).
  const directMs = parseNonNegativeNumber(e.retryDelayMs ?? e.retryAfterMs);
  if (directMs !== undefined) return directMs;
  const delay = e.retryDelay as { seconds?: number; nanos?: number } | undefined;
  if (delay && (delay.seconds !== undefined || delay.nanos !== undefined)) {
    // Clamp negatives/garbage to 0 via the strict parser (never a negative sleep).
    const secs = parseNonNegativeNumber(delay.seconds ?? 0) ?? 0;
    const nanos = parseNonNegativeNumber(delay.nanos ?? 0) ?? 0;
    return Math.round(secs * 1000 + nanos / 1e6);
  }
  // HTTP Retry-After header if the SDK surfaced response headers.
  // NOTE: Headers.get returns NULL when absent — must NOT coerce to 0.
  const resp = e.response as { headers?: { get?: (k: string) => string | null } } | undefined;
  const headers = resp?.headers;
  if (headers && typeof headers.get === 'function') {
    const ra = headers.get('Retry-After') ?? headers.get('retry-after');
    const secs = parseNonNegativeNumber(ra);
    if (secs !== undefined) return secs * 1000;
  }
  const secs = parseNonNegativeNumber(e.retryAfter);
  if (secs !== undefined) return secs * 1000;
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
