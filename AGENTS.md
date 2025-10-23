# Repository Guidelines

## Project Structure & Module Organization
The Vite client lives in `web/src`, with React views, hooks, and colocated `*.test.tsx`; shared helpers sit under `web/src/lib`, and global styles in `web/src/global.css`. Static assets ship from `web/public`. Fastify server code resides in `server/`, split into HTTP handlers (`server/routes`), agents (`server/agents`), models (`server/models`), and shared utilities (`server/services`, `server/config`). Reusable AI image logic is published from `packages/ai-image-gen`, while architecture decisions and notes are kept in `docs/`.

## Build, Test, and Development Commands
`npm run dev --prefix web` spins up the React dev server at http://localhost:5173 for live reloading. `npm run dev --prefix server` starts the Fastify API at http://localhost:8080 with auto-restart. Use `npm run build --prefix web` and `npm run build --prefix server` to produce production bundles; run both before tagging releases. From the repo root, `npm install` synchronizes workspace dependencies when package manifests change.

## Coding Style & Naming Conventions
All TypeScript should declare explicit return types, use 2-space indentation, single quotes, trailing commas, and favor `async/await`. Name React components in PascalCase (e.g., `OrderStatusCard.tsx`), hooks and utilities in camelCase (e.g., `useOrders.ts`), and server agents in kebab-case (e.g., `order-status-agent.ts`). Run `npm run format` prior to committing to apply Prettier and lint rules consistently.

## Testing Guidelines
Vitest powers unit and component coverage; keep tests colocated as `Component.test.tsx` and store snapshots under `__snapshots__/`. Aim for meaningful assertions over fixture sprawl, and avoid `.skip` without an owner. Execute `npm test --prefix web` before merging UI or shared utilities, and review any snapshot diffs line by line.

## Commit & Pull Request Guidelines
Commits follow `<type>: imperative summary` and stay within 72 characters, such as `feat: add order status agent`. Pull requests should outline scope, manual QA (dev servers + `npm test --prefix web`), linked issues, and include screenshots or logs when relevant. Highlight schema or environment updates explicitly and document follow-up tasks for any deferred work.

## Security & Configuration Tips
Keep credentials in environment-specific `.env` files and never commit tokens or API keys. Reuse existing middleware, agents, and helpers to reduce drift, and scrub sensitive data from logs, fixtures, and snapshots. Request maintainer review before introducing new third-party services or dependencies.
