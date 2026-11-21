import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // Review gate (cv-dbgtok-review): a registered App Check debug token must NEVER be inlined
  // into a production bundle. readEnv() uses dynamic import.meta.env access, which can inline
  // the whole env object, so enforce at build time instead of trusting build-machine hygiene.
  if (mode === "production") {
    const prodEnv = loadEnv(mode, process.cwd(), "VITE_");
    if (prodEnv.VITE_APPCHECK_DEBUG_TOKEN) {
      throw new Error(
        "Build blocked: VITE_APPCHECK_DEBUG_TOKEN must not be set for production builds (dev-only App Check debug token)."
      );
    }
  }
  return {
  // Tests must never read a developer's real web/.env (Firebase keys). Vitest runs in
  // mode "test": point Vite's .env loading at a directory that has no .env files, and
  // blank the variables too (belt and braces).
  envDir: mode === "test" ? "./test-env-isolated" : ".",
  server: { port: 5173 },
  build: {
    target: "es2022",
    rollupOptions: {
      output: {
        // Isolate the Firebase SDK into its own cacheable chunk so the app shell
        // stays small and SDK updates don't invalidate shell caches (M2 item:
        // firebase >500 kB chunk warning before Hosting deploy).
        manualChunks: (id: string) =>
          id.includes("node_modules/firebase/") || id.includes("node_modules/@firebase/")
            ? "firebase"
            : undefined,
      },
    },
  },
  test: {
    env: {
      VITE_FIREBASE_API_KEY: "",
      VITE_FIREBASE_AUTH_DOMAIN: "",
      VITE_FIREBASE_PROJECT_ID: "",
      VITE_FIREBASE_STORAGE_BUCKET: "",
      VITE_FIREBASE_MESSAGING_SENDER_ID: "",
      VITE_FIREBASE_APP_ID: "",
      VITE_APPCHECK_SITE_KEY: "",
      VITE_APPCHECK_DEBUG: "",
      VITE_APPCHECK_DEBUG_TOKEN: ""
    }
  }
  };
});
