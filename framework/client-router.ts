/*
Browser-side router for soft navigation.

The setRoot setter lives in framework/rsc/call-server.ts (since both
navigation and Server Function calls need it). We import it here rather
than maintaining a parallel singleton — one source of truth for "swap the
React tree".

This module is NOT marked "use client" because it isn't a component module
and it's never imported on the server — only the bootstrap and Link.tsx
(both browser-only) reach it. Bun.build with splitting:true hoists it into
a shared chunk so both entry points see the same module instance.

Params handling: route params live in `window.__PARAMS__` (the HTML shell
inlines them on first load; `useParams` reads from there). Soft-nav responses
echo the params back via `X-Bunframe-Params` so we can update that global
before the new tree renders. We resolve fetch headers (which arrive before
the body) inside a then() chained into createFromFetch's Response promise —
that guarantees __PARAMS__ is updated before any client component in the new
tree reads it.

callServer is plumbed into createFromFetch so server references that come
back inside the navigation payload (functions passed as props) are callable.
*/

import { createFromFetch } from "react-server-dom-webpack/client.browser";
import type { ReactNode } from "react";
import { callServer, getSetRoot } from "./rsc/call-server.ts";

let routerInitialized = false;

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
  return createFromFetch<ReactNode>(responsePromise, { callServer });
}

export function navigate(href: string): void {
  const setRoot = getSetRoot();
  if (!setRoot) return;
  setRoot(fetchRsc(href));
  history.pushState(null, "", href);
}

export function initClientRouter(): void {
  if (routerInitialized) return;
  routerInitialized = true;
  window.addEventListener("popstate", () => {
    const setRoot = getSetRoot();
    if (!setRoot) return;
    setRoot(fetchRsc(location.pathname + location.search));
  });
}
