import { describe, expect, it } from 'vitest';
import { shouldUseAppCheckDebug } from './firebase';

describe('shouldUseAppCheckDebug', () => {
  it('is true in dev when the flag is "true"', () => {
    expect(shouldUseAppCheckDebug(true, 'true')).toBe(true);
  });

  it('is false in dev when the flag is undefined', () => {
    expect(shouldUseAppCheckDebug(true, undefined)).toBe(false);
  });

  it('is false in production even when the flag is "true"', () => {
    expect(shouldUseAppCheckDebug(false, 'true')).toBe(false);
  });
});
