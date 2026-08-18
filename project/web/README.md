# web: chat + dashboard frontend

The frontend for Cogeto's two surfaces (scope §4.0), served by the **app** process:

- **Chat** (primary): ask, act, approve; the fast path lives behind it.
- **Memory dashboard** (governance). See/search/edit/correct/delete memories, status
 flags, source links, the "Forgotten" section with deletion receipts (spec §11.1), and
 dead-letter job visibility (spec §15.4).

This is a UI layer only: it talks to the app process's API and holds no business
logic, approval is decided server-side, never here.

May depend on: the app API. Nothing in `src/` depends on it.

## Developing

The SPA, the API and Zitadel share one origin by design (`https://localhost`
via Caddy), and the frontend dev loop is the Vite dev server on top of the
compose stack:

```bash
# Backend first: API + Zitadel at https://localhost.
docker compose up

# Vite dev server with hot module replacement (http://localhost:5173 by default).
npm run dev -w @cogeto/web
```

Two things the loop depends on:

- The SPA calls the API and starts its OIDC login on its own origin (relative
  `/api` paths, redirect URI from `window.location.origin`), so the dev server
  must reach the compose backend on the Caddy origin; the API lives at
  `https://localhost`, not on Vite's port. See
  [`../../docs/running-locally.md`](../../docs/running-locally.md).
- `vite.config.ts` aliases `@cogeto/shared` to its TypeScript source, so a
  change in the shared workspace is picked up without a build step first.

### Tests

The web workspace has no vitest config: a spec that touches the DOM opts in
per file with `// @vitest-environment jsdom` as its first line (see
`src/components/nav.spec.tsx`). Run one spec from `project/web`, or the whole
workspace from the repo root:

```bash
npx vitest run src/components/nav.spec.tsx   # from project/web
npm run test -w @cogeto/web                  # whole workspace, from the repo root
```

### Production build

```bash
npm run build -w @cogeto/web   # tsc --noEmit + vite build
```

The build output is what the Caddy stage bakes into the edge image; no source
maps are shipped (issue #636).
