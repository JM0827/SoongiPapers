# Repository Guidelines

## Project Structure & Module Organization
- `web/src` hosts the Vite client with React views, hooks, and colocated `*.test.tsx`; shared utilities live in `web/src/lib`, and global styles sit in `web/src/global.css`.
- `web/public` stores static assets shipped with the client bundle.
- `server/` contains the Fastify backend: HTTP handlers in `server/routes`, agents under `server/agents`, models in `server/models`, and shared helpers within `server/services` and `server/config`.
- `packages/ai-image-gen` houses the reusable `@bookko/ai-image-gen` package, while architecture notes live in `docs/`.

## Build, Test, and Development Commands
- `npm run dev --prefix web` starts the Vite dev server at http://localhost:5173 for rapid UI iteration.
- `npm run dev --prefix server` launches the Fastify API on http://localhost:8080 with auto-reload.
- `npm run build --prefix web` and `npm run build --prefix server` produce production artifacts; run both before tagging releases.

## Coding Style & Naming Conventions
- Write TypeScript with explicit return types, 2-space indentation, single quotes, trailing commas, and prefer `async/await` over raw promises.
- Name React components in PascalCase (e.g., `OrderStatusCard.tsx`), hooks/utilities in camelCase (e.g., `useOrders.ts`), and agents in kebab-case (e.g., `order-status-agent.ts`).
- Run `npm run format` prior to committing to align Prettier and linting expectations.

## Testing Guidelines
- Use Vitest for unit and component coverage; co-locate tests beside implementations as `Component.test.tsx`, and store snapshots under `__snapshots__/`.
- Keep fixtures minimal and avoid `.skip` without a tracked follow-up.
- Execute `npm test --prefix web` before merging UI or shared logic changes and review snapshot diffs.

## Commit & Pull Request Guidelines
- Follow `<type>: imperative summary` commit messages capped at 72 characters (e.g., `feat: add order status agent`).
- PRs should outline scope, document manual QA (dev servers + web tests), link tracking issues, and include screenshots or logs when relevant.
- Flag schema or environment changes explicitly and call out any skipped tests with an action plan.

## Security & Configuration Tips
- Store secrets in environment-specific `.env` files and never commit tokens or API keys.
- Reuse existing middleware, agents, and helpers; scrub sensitive data from logs, fixtures, and snapshots.
- Request maintainer review before adding third-party dependencies or external services.
