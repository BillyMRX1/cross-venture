import { describe, expect, it } from 'vitest';
import { shouldUseAppCheckDebug, appCheckDebugFlagValue } from './firebase';

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

describe('appCheckDebugFlagValue', () => {
  it('passes a non-empty registered token value through as a trimmed string', () => {
    expect(appCheckDebugFlagValue('  some-uuid-value  ')).toBe('some-uuid-value');
  });

  it('falls back to true when no token value is supplied', () => {
    expect(appCheckDebugFlagValue(undefined)).toBe(true);
    expect(appCheckDebugFlagValue('   ')).toBe(true);
  });
});
