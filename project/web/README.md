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

The SPA, the API and Zitadel share one origin by design: Caddy serves all
three at `https://localhost` in the compose stack. The Vite dev server adds
hot module replacement for UI work:

```bash
# Backend first: API + Zitadel at https://localhost.
docker compose up

# Vite dev server with hot module replacement (http://localhost:5173 by default).
npm run dev -w @cogeto/web
```

**The dev server is not wired to the backend by default**: this workspace
ships no `server.proxy` in `vite.config.ts`, and Caddy has no route to the
dev server. The SPA calls the API and starts its OIDC login on its own origin
(relative `/api` paths, redirect URI from `window.location.origin`), so the
backend must be reachable on the dev origin for the loop to work; the API
lives at `https://localhost`, not on Vite's port. A local, uncommitted
`server.proxy` override forwarding `/api` and the Zitadel paths to
`https://localhost` is the usual wiring. Full context:
[`../../docs/running-locally.md`](../../docs/running-locally.md).

`vite.config.ts` aliases `@cogeto/shared` to its TypeScript source, so a
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
