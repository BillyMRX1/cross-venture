import { initializeApp, getApps, getApp as getFirebaseApp, type FirebaseApp, type FirebaseOptions } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider, type AppCheck } from 'firebase/app-check';
import { getAI, GoogleAIBackend, type AI } from 'firebase/ai';
import {
  initializeFirestore,
  getFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from 'firebase/firestore';
import { getAuth, signInAnonymously } from 'firebase/auth';

function readEnv(key: string): string | undefined {
  const metaEnv =
    typeof import.meta !== 'undefined'
      ? (import.meta as { env?: Record<string, string | undefined> }).env
      : undefined;
  const raw = metaEnv?.[key];
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
}

function readFirebaseOptions(): FirebaseOptions | null {
  const apiKey = readEnv('VITE_FIREBASE_API_KEY');
  const authDomain = readEnv('VITE_FIREBASE_AUTH_DOMAIN');
  const projectId = readEnv('VITE_FIREBASE_PROJECT_ID');
  const appId = readEnv('VITE_FIREBASE_APP_ID');

  if (!apiKey || !authDomain || !projectId || !appId) {
    return null;
  }

  return {
    apiKey,
    authDomain,
    projectId,
    appId,
    storageBucket: readEnv('VITE_FIREBASE_STORAGE_BUCKET'),
    messagingSenderId: readEnv('VITE_FIREBASE_MESSAGING_SENDER_ID'),
  };
}

let appPromise: Promise<FirebaseApp | null> | null = null;
let appCheckInstance: AppCheck | null = null;
let aiPromise: Promise<AI | null> | null = null;
let dbPromise: Promise<Firestore | null> | null = null;

/**
 * Returns true iff the required Firebase web config env vars are present.
 * Has no side effects.
 */
export function isConfigured(): boolean {
  return readFirebaseOptions() !== null;
}

/**
 * Default cloud Gemini model name from env or fallback.
 */
export function cloudModel(): string {
  return readEnv('VITE_CLOUD_MODEL') ?? 'gemini-2.5-flash';
}

/**
 * Default on-device Gemini Nano model label from env or fallback.
 */
export function onDeviceModel(): string {
  return readEnv('VITE_ONDEVICE_MODEL') ?? 'gemini-nano';
}

/**
 * Pure decision: whether to enable the App Check debug token. Only in dev builds with VITE_APPCHECK_DEBUG === 'true'.
 */
export function shouldUseAppCheckDebug(isDev: boolean, flag: string | undefined): boolean {
  return isDev && flag === 'true';
}

/**
 * Activates Firebase App Check with ReCaptchaEnterpriseProvider (reCAPTCHA Enterprise / Fraud Defense site key) when VITE_APPCHECK_SITE_KEY is set.
 * Safe to call repeatedly; guarded for non-browser environments.
 */
export function activateAppCheck(app: FirebaseApp): AppCheck | null {
  if (appCheckInstance) {
    return appCheckInstance;
  }
  const siteKey = readEnv('VITE_APPCHECK_SITE_KEY');
  if (!siteKey) {
    return null;
  }
  const metaEnv = (import.meta as { env?: Record<string, string | boolean | undefined> }).env;
  if (
    shouldUseAppCheckDebug(metaEnv?.DEV === true, metaEnv?.VITE_APPCHECK_DEBUG as string | undefined) &&
    typeof self !== 'undefined'
  ) {
    (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean | string }).FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  }
  try {
    appCheckInstance = initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(siteKey),
      isTokenAutoRefreshEnabled: true,
    });
    return appCheckInstance;
  } catch (err) {
    console.warn('[firebase] App Check initialization skipped:', err);
    return null;
  }
}

/**
 * Lazily initializes and caches the FirebaseApp instance (plus App Check when configured).
 * Returns null if Firebase config is absent or initialization fails.
 */
export async function getApp(): Promise<FirebaseApp | null> {
  if (!appPromise) {
    appPromise = (async () => {
      const options = readFirebaseOptions();
      if (!options) {
        return null;
      }
      try {
        const app = getApps().length > 0 ? getFirebaseApp() : initializeApp(options);
        activateAppCheck(app);
        return app;
      } catch (err) {
        console.warn('[firebase] initializeApp failed:', err);
        return null;
      }
    })();
  }
  return appPromise;
}

/**
 * Lazily initializes and caches the Firebase AI Logic instance with GoogleAIBackend.
 * Returns null when Firebase is not configured.
 */
export async function getAIInstance(): Promise<AI | null> {
  if (!aiPromise) {
    aiPromise = (async () => {
      const app = await getApp();
      if (!app) {
        return null;
      }
      try {
        return getAI(app, { backend: new GoogleAIBackend() });
      } catch (err) {
        console.warn('[firebase] getAI failed:', err);
        return null;
      }
    })();
  }
  return aiPromise;
}

/**
 * Lazily initializes and caches Firestore with persistent multi-tab local cache.
 * Returns null when Firebase is not configured or Firestore cannot initialize.
 */
export async function getDb(): Promise<Firestore | null> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const app = await getApp();
      if (!app) {
        return null;
      }
      try {
        return initializeFirestore(app, {
          localCache: persistentLocalCache({
            tabManager: persistentMultipleTabManager(),
          }),
        });
      } catch (err) {
        try {
          return getFirestore(app);
        } catch {
          console.warn('[firebase] Firestore initialization failed:', err);
          return null;
        }
      }
    })();
  }
  return dbPromise;
}

/**
 * Ensures an anonymous Firebase Auth session exists, reusing currentUser when present.
 * Returns false on failure without throwing.
 */
export async function ensureSignedIn(): Promise<boolean> {
  const app = await getApp();
  if (!app) {
    return false;
  }
  try {
    const auth = getAuth(app);
    if (auth.currentUser) {
      return true;
    }
    await signInAnonymously(auth);
    return true;
  } catch (err) {
    console.warn('[firebase] Anonymous sign-in failed:', err);
    return false;
  }
}
