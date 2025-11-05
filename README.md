# Soongi Pagers

Soongi Pagers (Project-T1) is an AI-assisted literary translation studio that couples a React 19 front end with a Fastify API, BullMQ job runners, and shared TypeScript packages. The workspace guides long-form projects from origin ingest through GPT-5 powered translation, proofreading, quality review, cover design, and ebook delivery while keeping human translators in the loop.

## Highlights

- Chat-first studio where the orchestrator, timeline, and right-panel insights steer project context, guardrails, and follow-up work.
- Document ingestion pipeline that normalizes `.txt`, `.doc(x)`, `.pdf`, `.epub`, `.hwp`, and `.hwpx` sources with Python-assisted extractors and cleaning helpers.
- Sequential translation pipeline (draft → revise → micro-check) with retryable segments, translation memory, guard scoring, and NDJSON/Server-Sent Event streaming.
- Proofreading and quality agents that stream GPT-5 assessments, persist metrics, and expose admin dashboards for token usage, truncation, and fallback visibility.
- AI cover generation powered by the `@bookko/ai-image-gen` package (Gemini 2.5 Flash), plus ebook assembly and downloadable artifacts.
- Shared `@bookko/translation-types` package that centralizes schemas for workflows, LLM parameters, and project memory used across server and client.

## Tech Stack

- React 19, Vite 7, TanStack Query 5, Zustand, Tailwind utilities, Monaco editor integrations.
- Fastify 5 API with MongoDB (chat, proofreading, quality) and PostgreSQL (projects, jobs, translation memory).
- BullMQ + Redis queues for translation v2 workers, proofreading streams, and cover generation.
- OpenAI GPT-5 family for translation, proofreading, quality, and conversational agents; Google Gemini for cover art.
- TypeScript across client, server, and shared packages; Vitest + Testing Library on the front end, TSX test runner on the backend.

## Monorepo Layout

```
.
├── web/                    # React + Vite client (routes, components, hooks, agents, stores)
│   ├── src/assets/         # Static assets loaded by Vite
│   ├── src/components/     # Chat, layout, translation, proofreading, quality UI
│   ├── src/routes/         # Login, Project Hub, Studio, Admin, OAuth callback views
│   ├── src/services/       # REST + SSE clients, workflow helpers
│   └── src/store/          # Zustand stores for auth, projects, editing commands
├── server/                 # Fastify backend
│   ├── agents/             # Translation, proofreading, profile, workflow, dictionary agents
│   ├── config/             # Model defaults, app-control overrides, locale utilities
│   ├── routes/             # REST and SSE endpoints (chat, translation, proofread, quality, admin,…)
│   ├── services/           # Translation pipeline, cover generation, Redis, workflow manager
│   ├── db/                 # SQL helpers, schema/seed scripts, Mongo bootstrap utilities
│   ├── scripts/            # ensure-mongodb-search-index.js (postinstall)
│   └── storage/            # Local artifacts (covers, ebooks) written at runtime
├── packages/
│   ├── ai-image-gen/       # Gemini-based cover generator helpers (buildable package)
│   └── translation-types/  # Shared types for sequential translation + project memory
├── docs/                   # Process specs, release notes, design proposals, QA logs
├── scripts/                # generate-ssl-certs.js for local HTTPS
├── certs/                  # Self-signed certs generated locally (gitignored contents)
├── AGENTS.md               # Repo guidelines and contribution standards
└── README.md
```

## Prerequisites

- Node.js 20+
- npm 10+ (workspace-aware); pnpm is not required
- PostgreSQL 14+
- MongoDB 6+
- Redis 6+ (BullMQ queues)
- OpenAI API access (GPT-5 family) for translation, proofreading, quality, chat, and editing agents
- Google OAuth credentials for login flows
- Google Gemini API key (2.5 Flash) for cover generation (`@bookko/ai-image-gen`)
- Optional: Python 3 for HWP/HWPX extraction (`PYTHON_BIN` points at interpreter)

## Installation

From the repository root install all workspace dependencies and link local packages:

```bash
npm install
```

The `postinstall` hook ensures MongoDB search indexes exist by running `server/scripts/ensure-mongodb-search-index.js`.

## Local Development

- Front end: `npm run dev:web` (alias for `npm run dev --workspace=web`) → http://localhost:5173
- Fastify API: `npm run dev:backend` (alias for `npm run dev --workspace=server`) → http://localhost:8080
- Run both concurrently: `npm run dev`
- HTTPS dev servers (self-signed):
  - Generate certificates once: `npm run generate-ssl`
  - Launch both via `npm run dev:https`

Adjust ports and origins via `.env` files in `web/` and `server/` as needed. Redis must be reachable before the API boots because translation queues register processors during startup.

## Database & Queue Setup

### PostgreSQL

1. Start PostgreSQL 14+ locally (`brew services start postgresql@14`, `docker run postgres:14`, etc.).
2. Create the database referenced by `server/.env` (`DATABASE_URL`/`PG_URI`).
3. Apply schema helpers:
   - `psql -f server/db-postgredb-schema.sql`
   - Optional seeds: `psql -f server/db-seed.sql`
   - Node-based bootstrap alternative: `npm run db-init --workspace=server`

### MongoDB

1. Start MongoDB 6+ (`mongod` or Docker `mongo:6`).
2. Create the database specified by `MONGO_DB`.
3. Build indexes/collections with `node server/db-mongo-schema.js` (rerun as schemas evolve).
4. Clear local data with `node server/db-mongo-flushoutData.js` when you need a clean slate.

### Redis

- Start Redis 6+ locally (`brew install redis && redis-server`, `docker run redis:6`).
- Set `REDIS_URL=redis://localhost:6379/0` or provide host/port envs consumed by `server/services/redis`.
- Translation V2 (`translation_v2`), proofreading, and streaming metrics queues share this connection; the API exits early if Redis is unreachable.

## Testing & Quality Gates

- Front end (Vitest + Testing Library): `npm run test --workspace=web`
- Backend (TSX runner): `npm run test --workspace=server`
- Lint all workspaces: `npm run lint`
- Format with Prettier: `npm run format`
- Targeted backend tests (example):
  - `npm run test --workspace=server -- --test server/services/__tests__/proofreadStreamMeta.test.ts`

Run relevant suites before merging changes, inspect snapshot diffs, and keep tests collocated (`*.test.tsx` next to components).

## Build Commands

- Client production build: `npm run build --workspace=web`
- Server type check & build: `npm run build --workspace=server`
- Gemini helper package: `npm --prefix packages/ai-image-gen run build`

## Environment Configuration

Create `.env` files per workspace and never commit secrets.

### `web/.env`

```
VITE_API_BASE=http://localhost:8080
VITE_OAUTH_URL=/api/auth/google
VITE_SUPPORTED_LOCALES=ko,en
VITE_DEFAULT_LOCALE=ko
VITE_PROOFREAD_HEARTBEAT_MS=9000
VITE_PROOFREAD_STALL_MS=15000
# Optional: VITE_HMR_HOST, VITE_ALLOWED_HOSTS, VITE_HTTPS_ENABLED
```

### `server/.env`

```
# Fastify & runtime
NODE_ENV=development
PORT=8080
HTTPS_ENABLED=false
CLIENT_ORIGIN=http://localhost:5173
FASTIFY_LOGGER=true
FASTIFY_DISABLE_REQUEST_LOGS=0
LOG_LEVEL=info

# PostgreSQL
DATABASE_URL=postgres://user:pass@localhost:5432/soongi
PG_URI=${DATABASE_URL}
PG_HOST=localhost
PG_PORT=5432
PG_USER=user
PG_PASSWORD=pass
PG_DATABASE=soongi

# MongoDB
MONGO_URI=mongodb://localhost:27017
MONGO_DB=soongi

# Redis / queues
REDIS_URL=redis://localhost:6379/0

# OAuth / auth
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_CALLBACK_URL=http://localhost:8080/api/auth/google/callback
OAUTH_SUCCESS_REDIRECT=http://localhost:5173/app
JWT_SECRET=change_me
OAUTH_STATE_TTL_MS=600000

# OpenAI / GPT-5 models
OPENAI_API_KEY=sk-...
TRANSLATION_DRAFT_MODEL_V2=gpt-5
TRANSLATION_REVISE_MODEL_V2=gpt-5
TRANSLATION_DRAFT_JUDGE_MODEL_V2=gpt-5-mini
QUALITY_AGENT_MODEL=gpt-5-mini
PROOFREADING_MODEL=gpt-5
PROOFREADING_MODEL_FALLBACK=gpt-5-mini
CHAT_MODEL=gpt-5
CHAT_FALLBACK_MODEL=gpt-5-mini
CHAT_MAX_OUTPUT_TOKENS=900
CHAT_VERBOSITY=medium
CHAT_REASONING_EFFORT=medium
INTENT_CLASSIFIER_MODEL=gpt-5-mini
CHAT_ENTITY_MODEL=gpt-5-mini
EDITING_ASSIST_MODEL=gpt-5-mini
TRANSLATION_DRAFT_CANDIDATES=2
TRANSLATION_DRAFT_MAX_OUTPUT_TOKENS_V2=3600
TRANSLATION_REVISE_MAX_OUTPUT_TOKENS_V2=3200
MAX_SEGMENTS_PER_REQUEST=1
TRANSLATION_STREAM_PAGE_SIZE=40
SEQUENTIAL_DRAFT_MODEL=gpt-5
SEQUENTIAL_REVISE_MODEL=gpt-5
SEQUENTIAL_MICRO_CHECK_MODEL=gpt-5-mini

# Gemini cover generation
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash
COVER_STORAGE_DIR=./storage/covers
COVER_SVG_ARCHIVE_DIR=./storage/covers/svg

# Origin ingest / misc
PYTHON_BIN=python3
HWP_EXTRACT_TIMEOUT_MS=30000
DISABLE_STREAM_META_PERSIST=0
APP_CONTROL_CONFIG_PATH=./server/appControlConfiguration.json
```

Not every variable is required in development; undefined values fall back to sensible defaults described in `server/config` and `server/services`.

## Pipelines & Services

- **Translation:** Ingested documents are segmented (paragraph or sentence) and processed sequentially through draft, revise, and micro-check agents. Results stream to the client via NDJSON SSE, and translation memory is persisted in PostgreSQL (`translation_memory`, `translation_memory_versions`).
- **Proofreading:** GPT-5 runs produce quick/deep tiers, guard hints, and actionable issues. Proofread editor routes allow conflict resolution, selective updates, and SSE streaming for pagination.
- **Quality Review:** Aligns origin and translated segments, batches requests with token-aware budgets, and emits detailed chunk progress and fallback metadata.
- **Workflow Manager:** `server/services/workflowManager` records run states, cancellation, and completion events consumed by the React workflow timeline.
- **Cover Generation:** `server/services/cover` orchestrates Gemini image synthesis, persists assets to `storage/covers`, and exposes download endpoints.
- **Project Memory & Dictionary:** Context policies, term maps, locale resolution, and dictionary lookups live under `server/services/translation` and `server/routes/dictionary`.

## Workspace Utilities

- `packages/ai-image-gen`: Standalone Gemini helper (`npm --prefix packages/ai-image-gen run build/test`).
- `server/scripts/ensure-mongodb-search-index.js`: Keeps proofread/quality collections indexed; runs after installs but can be re-invoked manually.
- `scripts/generate-ssl-certs.js`: Generates self-signed certs into `certs/` for HTTPS dev flows.
- `server/db-init.ts` / `db-mongo-schema.js`: Bootstrap SQL and Mongo schemas.

## Documentation & References

Key documents live in `docs/`:

- `0.사용자인터페이스.md` – Studio UX overview and layout decisions.
- `1.원문처리프로세스.md` – Origin ingest, extraction, and normalization flows.
- `2.번역프로세스.md` and `gpt-5번역프로세스_v2.md` – Sequential translation architecture and rollout notes.
- `3.교정프로세스.md` – Proofreading guardrails, retry strategy, and streaming design.
- `4.품질검토프로세스.md` – Quality evaluation batching and result schema.
- `5.전자책프로세스.md` & `ebook-export-refresh-plan.md` – Ebook delivery pipeline and UX refresh plans.
- `Enhancement_Translation_Proofread.md`, `proofread-stream-a2a3-plan.md`, `milestone3-performance-ux.md` – Current initiative plans and performance targets.

Review these before altering workflows, UX flows, or agent prompts to stay aligned with the roadmap.

---

The stack evolves quickly. If you notice mismatches between the codebase and this README, update the relevant sections or open an issue so the team can keep our docs accurate.
