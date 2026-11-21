#!/usr/bin/env bash
# One-command, emulator-only Firestore rules acceptance.
# Loopback-only (localhost:8080/9099), demo project id, rules loaded from the REAL
# ../../firestore.rules. Never touches live Firebase, web/.env or any credentials.
set -euo pipefail
cd "$(dirname "$0")"

# --- safety pins: refuse anything that isn't the local demo target ---
if [[ "${FIRESTORE_EMULATOR_HOST:-localhost:8080}" != localhost:8080 && "${FIRESTORE_EMULATOR_HOST:-localhost:8080}" != 127.0.0.1:8080 ]]; then
  echo "FAIL: FIRESTORE_EMULATOR_HOST points off-loopback — refusing to run"; exit 2
fi
if [[ -e ../../web/.env ]]; then
  # hard guarantee: the harness must not inherit real project config
  unset VITE_FIREBASE_API_KEY VITE_FIREBASE_PROJECT_ID || true
fi

# --- java for the Firestore emulator (explicit FAIL, never fake PASS) ---
if ! java -version >/dev/null 2>&1; then
  if [[ -x "/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java" ]]; then
    export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
    export PATH="$JAVA_HOME/bin:$PATH"
  else
    echo "FAIL: no Java runtime found (PATH java missing, Android Studio JBR absent) — Firestore emulator cannot start"; exit 3
  fi
fi

if [[ ! -d node_modules ]]; then
  echo "installing pinned local dev deps (npm ci)..."
  npm ci --no-audit --no-fund
fi

# emulators:exec starts loopback emulators, runs the suite, tears the children down.
npx --yes firebase-tools emulators:exec \
  --project demo-cv-rules --only firestore,auth --config ./firebase.json \
  "node rules.test.mjs"
