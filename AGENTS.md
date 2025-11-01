# Repository Guidelines

## Project Structure & Module Organization

Keep Fastify backend logic under `server/`, with routes in `server/routes`, agents in `server/agents`, models in `server/models`, and shared services or config in `server/services` and `server/config`. The Vite client lives in `web/src`; React views, hooks, and colocated tests belong beside their components, while shared helpers stay in `web/src/lib`. Place global styles in `web/src/global.css` and public assets under `web/public`. Workspace utilities, including the AI image generator, sit in `packages/ai-image-gen`, and architecture notes or ADRs belong in `docs/`.

## Build, Test, and Development Commands

Run `npm install` at the repo root to sync workspaces. Launch the React dev server with `npm run dev --prefix web` (http://localhost:5173) and the Fastify API with `npm run dev --prefix server` (http://localhost:8080). Build production bundles via `npm run build --prefix web` and `npm run build --prefix server`. Execute the Vitest suite using `npm test --prefix web` before merging UI or shared library changes.

## Coding Style & Naming Conventions

Write TypeScript with 2-space indentation, single quotes, trailing commas, and explicit return types. Components use PascalCase names (e.g., `OrderStatusCard.tsx`), hooks and utilities stay camelCase (e.g., `useOrders.ts`), and Fastify agents are kebab-case (`order-status-agent.ts`). Prefer `async/await`. Run `npm run format` prior to commits to apply Prettier and lint rules across packages.

## Testing Guidelines

Vitest handles unit and component coverage. Name test files `<Component>.test.tsx` adjacent to their subjects and store snapshots in `__snapshots__/`. Avoid `.skip` unless the owner is noted, and read snapshot diffs before approving changes. Always verify `npm test --prefix web` after modifying UI or shared helpers.

## Commit & Pull Request Guidelines

Use commit messages in the form `<type>: imperative summary` within 72 characters, such as `feat: add order status agent`. Pull requests must state scope, manual QA steps (include dev server spins and `npm test --prefix web`), linked issues, and relevant screenshots or logs for behavioral shifts. Call out schema or environment updates explicitly and document deferred work to keep reviewers aligned.

## Security & Configuration Tips

Keep credentials in environment-specific `.env` files and never commit secrets. Reuse established middleware, agents, and shared helpers to limit drift, and scrub sensitive data from logs, fixtures, and snapshots. Seek maintainer approval before introducing new dependencies or external services.
