/*
Browser-side router for soft navigation.

Holds a single React state setter (registered by the bootstrap on mount) that
swaps the root rscPromise. `<Link>` and `popstate` both go through navigate()
to refresh that promise after fetching a new RSC payload from the server.

This module is NOT marked "use client" because it isn't a component module
and it's never imported on the server — only the bootstrap and Link.tsx
(both browser-only) reach it. Bun.build with splitting:true hoists it into a
shared chunk so both entry points see the same module instance, which is
load-bearing: registerSetRoot writes the same variable navigate reads.

Params handling: route params live in `window.__PARAMS__` (the HTML shell
inlines them on first load; `useParams` reads from there). Soft-nav responses
echo the params back via `X-Bunframe-Params` so we can update that global
before the new tree renders. We resolve fetch headers (which arrive before
the body) inside a then() chained into createFromFetch's Response promise —
that guarantees __PARAMS__ is updated before any client component in the new
tree reads it.
*/

import { createFromFetch } from "react-server-dom-webpack/client.browser";
import type { ReactNode } from "react";

type SetRoot = (next: Promise<ReactNode>) => void;

let setRoot: SetRoot | null = null;
let routerInitialized = false;

export function registerSetRoot(fn: SetRoot): void {
  setRoot = fn;
}

function fetchRsc(href: string): Promise<ReactNode> {
  const responsePromise = fetch(href, {
    headers: { Accept: "text/x-component" },
  }).then((res) => {
    const params = res.headers.get("X-Bunframe-Params");
    if (params) {
      try {
        (window as { __PARAMS__?: unknown }).__PARAMS__ = JSON.parse(params);
      } catch {
        // malformed header: leave the previous params in place
      }
    }
    return res;
  });
  return createFromFetch<ReactNode>(responsePromise);
}

export function navigate(href: string): void {
  if (!setRoot) return;
  setRoot(fetchRsc(href));
  history.pushState(null, "", href);
}

export function initClientRouter(): void {
  if (routerInitialized) return;
  routerInitialized = true;
  window.addEventListener("popstate", () => {
    if (!setRoot) return;
    setRoot(fetchRsc(location.pathname + location.search));
  });
}
