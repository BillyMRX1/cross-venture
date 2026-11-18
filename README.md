# Cross-Venture Deal & Margin Memory

**#BuildHybridAI 2026** — an offline-first deal guardrail for multi-venture founders.
Ingest contracts privately on desktop, let Cloud Gemini synthesize a knowledge graph
from **anonymized text only**, then check live discount requests **offline on your
phone** with deterministic margin math and copy-ready WhatsApp replies.

Full product requirements: [`docs/project_blueprint_prd_buildhybridai_2026.md`](docs/project_blueprint_prd_buildhybridai_2026.md)

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
npm test                   # deterministic margin engine tests
```

Firebase setup: create a project → enable **AI Logic**, **Firestore**, **Auth
(anonymous)** → enable **App Check** (reCAPTCHA; hackathon debug tokens allowed) →
enable the **on-device Gemini Nano** experimental access in Chrome.

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
