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
                           (or return raw RSC on Accept: text/x-component);
                           also handles POST for Server Function dispatch
  hooks.ts                 useParams (client-only)
  context.ts               request-scoped context (params, etc.)
  Link.tsx                 client component for soft navigation
  client-router.ts         browser-side navigate() + popstate handler
                           (uses the shared setRoot from rsc/call-server.ts)
  rsc/
    directives.ts          ECMAScript directive-prologue scanner
    plugin.ts              Bun runtime plugin: stubs "use client", appends
                           registerServerReference to "use server" modules
    scan.ts                pre-scan source tree for "use client" /
                           "use server" files
    build-client.ts        Bun.build for the browser bundle + manifests
                           (client refs + "use server" stubs)
    manifest.ts            shared client-manifest state + stub generator
    server-fn.ts           Server Function id helpers, server-reference
                           manifest, browser stubs, server-side wrapper
                           appendix, globalThis __webpack_* shims
    call-server.ts         browser-only callServer singleton + the React
                           setRoot used by both navigation and action
                           auto-rerender
client.ts                  browser bootstrap (createFromReadableStream + createRoot)
server.ts                  boot order: plugin → webpack shims → scan →
                           build → serve
tests/                     integration tests
note.txt                   design decisions + what's deferred + why
```

## Run / test

```
bun run dev          # NODE_ENV=development bun --conditions react-server --watch server.ts
bun test             # 53 cases (unit + integration) — must stay green
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

1. **Inline `"use server"` closures** — module-level Server Functions ship,
   but inline closures (`function() { "use server"; ... }` inside a server
   component) don't. Needs an AST pass for free-variable lifting + AES-GCM
   encryption of $$bound args (privilege-escalation hole otherwise).
   Full sketch in note.txt §7. Non-negotiable: crypto must land with it.
2. **HTML SSR pre-render (Pass 2)** — needs a worker thread or subprocess
   running React WITHOUT `--conditions react-server`. Biggest user-visible
   win (FCP). Sketch in note.txt §1.
3. **RSC HMR** — quality-of-life. Sketch in note.txt §4.
4. **Other gaps** — revalidation primitives, metadata API, full
   formState round-trip test (the no-JS dispatch path is covered, the
   $ACTION_REF_* path waits on SSR). See note.txt §8.

Done:
  - Client-side navigation (note.txt §2). `<Link>` for opt-in soft-nav;
    server returns raw RSC on `Accept: text/x-component`.
  - Module-level Server Functions (note.txt §3). Every export of a
    "use server" file is callable from client components, works as
    `<form action>`, integrates with `useActionState`. POST to the page
    route dispatches actions and re-renders in the same response.
  - No-JS form-submit dispatch path covered by integration tests
    (synthesized `$ACTION_ID_*` multipart POST). Full formState
    round-trip awaits SSR pre-render — see note.txt §8.

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
