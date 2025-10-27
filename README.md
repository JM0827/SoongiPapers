# Soongi Pagers

Soongi Pagers is a monorepo for an AI-assisted literary translation studio. The product combines a Vite/React client, a Fastify backend, BullMQ-powered job orchestration, and shared packages that coordinate machine translation, proofreading, quality review, and ebook delivery for long-form projects.

## Highlights
- Chat-first workspace that guides novel translations from origin ingest through proofreading, QA, and export.
- Monaco-powered editors with conversational rewrite tooling, translation memory, and localized UI copy.
- Fastify API that brokers OpenAI workflows, manages project state across PostgreSQL and MongoDB, and coordinates BullMQ workers via Redis.
- Modular agents for translation, proofreading, evaluation, dictionaries, and ebook generation, each with dedicated prompts and pipelines.
- Shared `@bookko/*` packages for AI image generation and strongly typed translation schemas.

## Repository Layout
```
.
├── web/                    # React + Vite client (src/, routes/, hooks/, components/, lib/)
├── server/                 # Fastify backend, agents, routes, services, db helpers
├── packages/
│   ├── ai-image-gen/       # Local package with reusable AI image helpers
│   └── translation-types/  # Shared TypeScript types used by the app and server
├── docs/                   # Architecture notes and UX plans (chat UX, conversational editing, etc.)
├── scripts/                # Utility scripts (e.g. SSL certificate generation)
├── AGENTS.md               # Reference documentation for automation agents
└── README.md
```

## Prerequisites
- Node.js 20+
- pnpm or npm (workspace-aware) – the team standardises on npm commands in this repo
- PostgreSQL 14+
- MongoDB 6+
- Redis 6+ (BullMQ queues)
- OpenAI API access for translation, rewrite, and evaluation agents

## Installation
From the repo root install all workspace dependencies:

```bash
npm install
```

The install step links the local packages (`packages/translation-types`, `packages/ai-image-gen`) so they can be imported as `@bookko/translation-types` and `@bookko/ai-image-gen` throughout the monorepo.

## Local Service Setup
Before running the Fastify API, make sure PostgreSQL, MongoDB, and Redis are installed and running locally (or point the environment variables at hosted instances).

### PostgreSQL
- Install version 14+ locally (for example `brew install postgresql@14 && brew services start postgresql@14` on macOS or `docker run --name soongi-postgres -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:14`).
- Create the database referenced by `server/.env` and apply the schema helpers via `psql -f server/db-init.sql` or `node server/db-init.ts`. Optional seed data lives in `server/db-seed.sql`.

### MongoDB
- Install MongoDB 6+ and run `mongod --dbpath <path>` or use Docker (`docker run --name soongi-mongo -p 27017:27017 mongo:6`).
- Bootstrap collections with `node server/db-mongo-schema.js`; the `server/db-mongo-flushoutData.js` script clears local data when you need a clean slate.

### Redis
- Install Redis 6+ (`brew install redis`, `apt install redis-server`, or `docker run --name soongi-redis -p 6379:6379 redis:6`) and start it before you launch the API.
- Set `REDIS_URL=redis://localhost:6379/0` (or point it to your managed instance). All BullMQ queues (`translation_drafts`, `translation_stage`, `translation_synthesis`, `translation_v2`) share this connection and the server exits early if Redis is unreachable.


## Local Development
- Start the Vite client: `npm run dev --prefix web`
- Start the Fastify API: `npm run dev --prefix server`
- Run both with one command (uses `concurrently`): `npm run dev`
- Enable HTTPS locally (generates self-signed certs once): `npm run generate-ssl`

The web dev server defaults to http://localhost:5173 and the API to http://localhost:8080. Adjust ports in the respective `.env` files if needed.

## Translation Pipelines
The platform currently supports the legacy literal -> style -> emotion -> QA workflow and the new Pipeline V2 centered on Draft -> Revise -> Micro-Checks. Use V2 when piloting GPT-5 as documented in `docs/translationOptimization.md`.

### Legacy multi-pass
- Remains the default when the V2 feature flag is disabled. Jobs traverse the stage queues (`translation_drafts`, `translation_stage`, `translation_synthesis`) shown in the timeline UI.

### Pipeline V2 (Draft -> Revise -> Micro-Checks)
- Generates multiple low-temperature Draft candidates, deliberates to pick a winner, runs the Revise agent, and gates the result through Micro-Checks before persisting final segments.
- Jobs enqueue on the `translation_v2` queue and log with the `[TRANSLATION_V2]` prefix, so keep Redis running before enabling the flag.

### Feature flags & tuning
- `TRANSLATION_PIPELINE_V2_ENABLED=true` switches every project to the new flow. Use `TRANSLATION_PIPELINE_V2_PROJECTS=projId1,projId2` to roll it out selectively.
- Override GPT models with `TRANSLATION_DRAFT_MODEL_V2`, `TRANSLATION_DRAFT_JUDGE_MODEL_V2`, and `TRANSLATION_REVISE_MODEL_V2`. Each falls back to the legacy envs (`TRANSLATION_DRAFT_MODEL`, `TRANSLATION_DRAFT_JUDGE_MODEL`, `TRANSLATION_REVISE_MODEL`) and finally `CHAT_MODEL`.
- Control the Draft n-best fan-out with `TRANSLATION_DRAFT_CANDIDATES` (accepted range 1-3). Runtime overrides for temperature and top-p are still respected if you pass them in job configs.


## Builds & Testing
- Create production bundles: `npm run build --prefix web` and `npm run build --prefix server`
- Front-end unit/component tests (Vitest): `npm test --prefix web`
- Backend tests (tsx test runner): `npm test --prefix server`
- Repository formatting (Prettier): `npm run format`

Always review snapshot diffs and run the relevant test suites before merging changes.

## Environment Configuration
Create `.env` files in both `web/` and `server/` with real credentials before running the stack. Key variables include:

**`web/.env`**
- `VITE_ALLOWED_HOSTS` – comma-separated hosts permitted for Vite dev server
- `VITE_HMR_HOST` – host used for hot module reloads behind HTTPS proxies
- `VITE_OAUTH_URL` – Fastify OAuth entrypoint exposed to the client

**`server/.env`**
- Database: `DATABASE_URL`, `PG_URI`, `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD`
- Mongo: `MONGO_URI`, `MONGO_DB`
- Redis: `REDIS_URL` (or individual host/port envs read by `createRedisClient`)
- Auth: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`, `OAUTH_SUCCESS_REDIRECT`, `JWT_SECRET`
- AI: `OPENAI_API_KEY`, optional `OPENAI_MODEL`, `OPENAI_EMBED_MODEL`
- Optional: `PORT`, `HTTPS_ENABLED`, additional agent/model overrides

Never commit populated `.env` files. Use environment-specific secrets management for production.

## Data & Queue Services
- PostgreSQL stores project metadata, workflow runs, and translation artifacts.
- MongoDB stores chat history, proofreading results, and quality assessments.
- Redis powers BullMQ queues (`translation_drafts`, `translation_stage`, `translation_synthesis`, and the new `translation_v2` pipeline) and must be reachable before the API boots; set `REDIS_URL` before starting the server.

Utility scripts in `server/db-*.sql` and `server/db-mongo-*.js` help bootstrap schemas for local development; run them manually when seeding fresh databases.

## Documentation & Design Assets
- `AGENTS.md` – catalog of translation, proofreading, evaluation, and ebook agents.
- `docs/chat-ux-enhancement-design.md` – plan for the Soongi assistant conversation model.
- `docs/conversational-editing-plan.md` – outlines Monaco selection workflows and rewrite flows.
- `docs/translationOptimization.md` – GPT-5 translation pipeline V2 execution plan, feature flags, and rollout phases.
- `docs/UX 재정비 설계서1.md` – Korean UX overhaul proposal (original reference).

Review these documents when making UX or agent changes to stay aligned with the product roadmap.

## Coding Standards & Contributions
- TypeScript files use explicit return types, 2-space indentation, single quotes, trailing commas, and `async/await`.
- Name React components in PascalCase, hooks/utilities in camelCase, server agents in kebab-case.
- Run `npm run format` before committing to ensure Prettier and ESLint rules are satisfied.
- Follow commit message format `<type>: imperative summary` (≤72 chars) and document manual QA + tests in pull requests.

For security, store credentials in environment-specific `.env` files only, avoid logging sensitive payloads, and request maintainer approval before adding new third-party services.

---
The Soongi Pagers stack is evolving quickly; if something in this README falls out of date, please update it alongside your change or open an issue so the team can keep the docs current.
