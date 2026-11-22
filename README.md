# Cross-Venture Deal & Margin Memory

**#BuildHybridAI 2026** — an offline-first deal guardrail for multi-venture founders.
Ingest contracts privately on desktop, let Cloud Gemini synthesize a knowledge graph
from **anonymized text only**, then check live discount requests **offline on your
phone** with deterministic margin math and copy-ready WhatsApp replies.

Full product requirements: [`docs/project_blueprint_prd_buildhybridai_2026.md`](docs/project_blueprint_prd_buildhybridai_2026.md)

## Value proposition

Founders running several ventures answer dozens of discount requests over chat — "can
you do 20% off?" — and one careless yes silently breaks a negotiated margin floor.
Cross-Venture is the guardrail in their pocket: contract terms become a structured,
cited knowledge graph; every live deal request gets a deterministic breach/counter-offer
verdict computed by unit-tested math (the LLM never does arithmetic); and the whole
cloud leg runs on **symbolically redacted text only** — real names, costs and
percentages never leave the device, provable in-app via the Privacy Firewall Inspector.

## How Firebase AI Logic is used (hybrid inference)

| Stage | Where | Mode |
| :-- | :-- | :-- |
| Entity role tagging during redaction | Desktop Chrome | `ON_DEVICE_ONLY` (Gemini Nano) — raw text never leaves the device, even as fallback |
| Cross-clause knowledge graph synthesis | Cloud Gemini | `IN_CLOUD`, structured JSON — input is pre-blinded symbolic text only |
| Pocket query parsing ("20% off 30 units on the linen dress") | Phone | `PREFER_ON_DEVICE` (Gemini Nano 4 / Apple FM) with local regex fallback |
| Margin math & counter-offer | Phone / laptop | **No LLM** — deterministic formulas only |

**Privacy proof:** the *Privacy Firewall Inspector* tab shows the exact outbound cloud
payload side-by-side with local plaintext, plus an automated PASS/FAIL scan proving no
real names, costs, or percentages appear in what the cloud received. Firestore stores
only AES-256-GCM ciphertext; the vault key never leaves your devices.

## Quickstart (web, Phase 1)

```bash
cd web
cp .env.example .env       # fill in Firebase keys (optional: app runs in degraded local mode without them)
npm install
npm run dev                # http://localhost:5173
npm test                   # deterministic margin engine + redaction/sync/retry suites
```

More test surfaces (all hermetic, no cloud calls):

```bash
bash tools/rules-test/run.sh          # 26 adversarial cases vs the real firestore.rules on a loopback emulator
cd android && ./gradlew :core:test    # 13 tests incl. web<->Android AES-256-GCM vault interop vectors
```

Firebase setup: create a project → enable **AI Logic**, **Firestore**, **Auth
(anonymous)** → enable **App Check** (reCAPTCHA; hackathon debug tokens allowed) →
enable the **on-device Gemini Nano** experimental access in Chrome.

## Where Firebase AI Logic is called (file:line)

Every model call in the project goes through the official `firebase/ai` SDK — cloud and
on-device — and nothing else. `npm run dev`, then "Load sample workspace" exercises the
cloud path live (accepted end-to-end in a real browser on 2026-11-22: 4 ventures /
5 SKUs / 6 rules from 9 blinded chunks, with the UI honestly labeling the answering
model).

| Call site | What it runs |
| :-- | :-- |
| `web/src/firebase.ts:3` | `import { getAI, GoogleAIBackend } from 'firebase/ai'` |
| `web/src/firebase.ts:163` | `getAI(app, { backend: new GoogleAIBackend() })` — the single AI entry point |
| `web/src/hybrid.ts:40` | on-device Gemini Nano base model (`InferenceMode.ONLY_ON_DEVICE`, via the same SDK) |
| `web/src/hybrid.ts:93` | cloud primary model (`generateContent` for graph synthesis) |
| `web/src/hybrid.ts:112` | opt-in fallback model (only after bounded transient retries exhaust; default OFF) |
| `web/src/hybrid.ts:155` | structured pocket-query path — strictly `InferenceMode.ONLY_ON_DEVICE` with a schema constraint (`redact`/`query` stages never fall back to cloud, `hybrid.ts:73`; `synthesize` is the only `IN_CLOUD` stage, `hybrid.ts:81`) |

A repo-wide grep shows the only `fetch()` calls outside the SDK are static-asset loads
(sample docs, service-worker probe) — no direct provider endpoints anywhere.

## Built during the hackathon period (after Nov 11, 2026)

Repo history starts 2026-11-18 (64 commits): full Vite+TypeScript web app (ingest +
symbolic anonymizer, blinded cloud graph, AES-256-GCM vault, deterministic calc engine,
WhatsApp drafts); six rounds of security hardening with independent review; a
reproducible Firestore rules emulator suite; live Firestore provisioning + rules deploy
+ real cross-device sync acceptance; Kotlin/Compose Android companion with
web↔Android crypto interop tests; App Check (reCAPTCHA Enterprise) end-to-end; transient
capacity retry + opt-in fallback + honest model labeling; live hybrid inference
acceptance 2026-11-22.

## Tech Lead decisions (TD-1 … TD-6 from the PRD)

- **TD-1 Option C** — TypeScript web app (desktop Chrome) + Kotlin/Compose Android phone companion. Web ships first (judges get a free URL); Android covers the airplane-mode pocket scenario.
- **TD-2 Option B** — desktop Chrome as the desktop runtime: physically testable and recordable; Android large-screen demo added if emulator AICore behaves.
- **TD-3 Option A (no OCR)** — `.txt`/`.md` + text-layer PDFs via pdf.js. Reliable chunking beats fragile OCR.
- **TD-4 Option A** — Cloud Firestore + client-side AES-256-GCM; pairing via a copyable key string (QR render = polish).
- **TD-5 Option A** — in-app Quick Deal Simulator is the primary entry; Android share sheet in Phase 2.
- **TD-6 Option A** — pre-seeded sample workspace (both demo scenarios) + upload button.
- **Deviation notice (privacy hardening):** where the PRD implies cloud fallback for the local redaction stage, we deliberately do **not** fall back to cloud — if Gemini Nano is unavailable we use local regex/heuristics only. Rationale: Principle 1 ("zero-knowledge cloud") must hold in degraded mode too.

## Repo map

```
web/                 Phase-1 web app (Vite + TypeScript)
  src/ingest/        FR-1 chunking + symbolic anonymizer (local-only)
  src/cloud/         FR-2 blinded graph extraction (IN_CLOUD)
  src/crypto/        TD-4 vault (AES-256-GCM)
  src/storage/       Firestore encrypted sync + IndexedDB cache
  src/calc/          FR-4 deterministic engine (unit-tested)
  src/drafts/        FR-5 WhatsApp drafts
  public/sample-docs/  Scenario A/B demo documents
docs/                PRD, milestones, frozen contracts
android/             Phase-2 Kotlin/Compose companion (M4)
```

## Demo script (3-minute video skeleton)

1. Ingest the 3 "Atelier Emily" docs → Privacy Inspector PASS banner: `Emily`, `$40`, `55%` all tokenized to `[PARTNER_1] [COST_1] [PCT_x]` before any cloud call. *(0:00–0:50)*
2. Cloud Gemini returns the 4-collection graph with clause citations. *(0:50–1:20)*
3. Push encrypted vault to phone (ciphertext-only Firestore doc visible in Console). *(1:20–1:40)*
4. Airplane mode ON → query *"buyer wants 20% off, 30 units"* → **MARGIN BREACH** badge, cited §4.3, counter-offer 10%, one-tap WhatsApp drafts for buyer *and* Emily. *(1:40–2:50)*
5. Switch venture → **Nomad Studio**: different guardrails, no partner drafts. *(2:50–3:00)*

## License

Apache 2.0 — see [LICENSE](LICENSE).
