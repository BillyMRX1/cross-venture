import { describe, expect, it } from 'vitest';

// Guards against a developer's real web/.env leaking Firebase keys into tests.
describe('vitest env isolation', () => {
  it('blanks all Firebase / App Check env vars', () => {
    const env = import.meta.env as Record<string, string | undefined>;
    for (const key of [
      'VITE_FIREBASE_API_KEY',
      'VITE_FIREBASE_AUTH_DOMAIN',
      'VITE_FIREBASE_PROJECT_ID',
      'VITE_FIREBASE_STORAGE_BUCKET',
      'VITE_FIREBASE_MESSAGING_SENDER_ID',
      'VITE_FIREBASE_APP_ID',
      'VITE_APPCHECK_SITE_KEY',
      'VITE_APPCHECK_DEBUG',
    ]) {
      expect(env[key], key).toBe('');
    }
  });
});
