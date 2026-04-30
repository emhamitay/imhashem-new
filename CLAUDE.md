# BunFrame — agent guide

This file orients an AI assistant joining the project mid-stream. Read it
first, then `note.txt`, then the headers of files in `framework/rsc/`.

## What this is

A small framework: Bun runtime + React 19 + React Server Components. Pages
live in `app/`, file-based routing, "use client" / "use server" semantics.

## Repository map

```
app/                       file-routed pages (Server Components by default)
components/                shared components ("use client" allowed)
framework/
  router.ts                glob app/, render RSC payload, embed in HTML shell
  hooks.ts                 useParams (client-only)
  rsc/
    directives.ts          ECMAScript directive-prologue scanner
    plugin.ts              Bun runtime plugin: stubs "use client", JSX shim
    scan.ts                pre-scan source tree for "use client" files
    build-client.ts        Bun.build for the browser bundle + manifest
    manifest.ts            shared client-manifest state + stub generator
client.ts                  browser bootstrap (createFromReadableStream + createRoot)
server.ts                  boot order: plugin → scan → build → serve
tests/                     integration tests
note.txt                   design decisions + what's deferred + why
```

## Run / test

```
bun run dev          # NODE_ENV=development bun --conditions react-server --watch server.ts
bun test             # 33 cases (unit + integration) — must stay green
```

The `--conditions react-server` flag is mandatory: under it React resolves to
its server-only build.

## Conventions for working on this repo

1. **Ask before architectural changes.** Don't restructure the plugin /
   router / build pipeline without surfacing the trade-off first.
2. **Tests stay green.** If a change requires a test update, update the test
   in the same change and explain why in the commit. Don't skip / disable
   tests to land work.
3. **Don't add features beyond the task.** No "while I'm here" refactors.
4. **Don't add comments that restate the code.** Headers and "why this is
   non-obvious" comments only. The existing files set the bar.
5. **Branch discipline.** All work continues on
   `claude/add-react-server-components-bQzZn` unless told otherwise.

## What is intentionally missing (priority order)

`note.txt` has the full reasoning. Short version, in the order I'd tackle:

1. **Client-side navigation (`?_rsc=1`)** — without it every link click is a
   full document load. Returns RSC payload only on `Accept: text/x-component`,
   browser-side router updates a top-level state holding the current
   `rscPromise`. Sketch in note.txt §2.
2. **`"use server"` / Server Functions** — directive scanner already
   detects it, plugin has the branch reserved. Need: client-side fetch
   stub generation, `/__fn/:id` route handler, registry. Sketch in note.txt §3.
3. **HTML SSR pre-render (Pass 2)** — needs a worker thread or subprocess
   running React WITHOUT `--conditions react-server`. Biggest lift, mostly
   improves first-contentful-paint. Sketch in note.txt §1.
4. **RSC HMR** — quality-of-life. Lowest priority. Sketch in note.txt §4.

## Two Bun-specific gotchas already encountered

These are documented in `framework/rsc/plugin.ts`. Don't re-discover:

- The plugin's general `onLoad` filter must exclude `node_modules` (negative
  lookahead). Otherwise it clobbers Bun's auto-CJS-detection on React's
  internal CJS files and `import * as m` returns an empty namespace.
- `react/jsx(-dev)?-runtime.react-server.js` is a dynamic-require wrapper
  Bun can't statically read named exports from. The plugin shims it by
  redirecting onLoad to the deep `cjs/...development.js` file.

## When picking up the next task

Tell me which item from the priority list above. Read `note.txt` for its
sketch. Confirm the plan, then start.
