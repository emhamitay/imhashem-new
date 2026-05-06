/*
SSR subprocess for HTML pre-render (Pass 2).

Runs WITHOUT --conditions react-server so react-dom/server resolves to the
real implementation instead of the stub that throws under that condition.
Spawned once at startup by server.ts; serves two request types:

  POST /init  — receives { [browserUrl]: absSourcePath } so the worker can
                import real client-module source files. Pre-loads them all
                eagerly so the RSC render doesn't hit cold import latency.

  POST /      — streams the RSC payload, deserializes it (resolving client
                references to real components via the webpack shims), and
                returns the prerendered HTML as a streaming response.

Client components that throw during SSR (e.g., they access browser globals)
are silently swallowed by SsrBoundary — the slot renders as null and the
browser fills it in via hydrateRoot once JS loads.
*/

import { createFromReadableStream } from "react-server-dom-webpack/client.edge";
import { renderToReadableStream as renderToHtmlStream } from "react-dom/server";
import { use, createElement, Suspense, Component, type ReactNode } from "react";

// Error boundary — catches any client component that throws during SSR
// (e.g., accesses window/document). Renders null so hydrateRoot fills it.
class SsrBoundary extends Component<
  { children: ReactNode },
  { caught: boolean }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { caught: false };
  }
  static getDerivedStateFromError() {
    return { caught: true };
  }
  render(): ReactNode {
    if (this.state.caught) return null;
    return this.props.children as ReactNode;
  }
}

// urlToSourcePath: browser chunk URL → absolute source file path.
// Populated by POST /init from server.ts.
const urlToSourcePath = new Map<string, string>();

// loaded: browser chunk URL → imported module (real or null-stub).
// Keyed by the same id that the RSC stream encodes in client references.
const loaded = new Map<string, object>();

// nullModule: fallback for any client module that hasn't been loaded or
// fails to import. Returns () => null for every property so React renders
// the component slot as null during SSR.
const nullModule = new Proxy(
  {},
  {
    get: () => () => null,
    getOwnPropertyDescriptor: (_t, _key) => ({
      value: () => null,
      writable: true,
      enumerable: true,
      configurable: true,
    }),
    has: () => true,
  },
);

const g = globalThis as Record<string, unknown>;

// __webpack_chunk_load__ is awaited by rsdw before __webpack_require__.
// If the module was pre-loaded in /init, this is a no-op. Otherwise we
// attempt a lazy import from the source path (dev fallback), or use nullModule.
g.__webpack_chunk_load__ = async (id: string): Promise<void> => {
  if (loaded.has(id)) return;
  const srcPath = urlToSourcePath.get(id);
  if (srcPath) {
    try {
      loaded.set(id, await import(srcPath) as object);
    } catch {
      loaded.set(id, nullModule);
    }
  } else {
    loaded.set(id, nullModule);
  }
};

g.__webpack_require__ = (id: string): object => loaded.get(id) ?? nullModule;
g.__webpack_get_script_filename__ = (id: string): string => id;

type SsrEntry = { id: string; chunks: string[]; name: string };
type SsrModuleMap = Record<string, Record<string, SsrEntry>>;

function RscRoot({ p }: { p: unknown }) {
  return use(p as Promise<React.ReactNode>);
}

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);

    // /init — receive { [browserUrl]: absSourcePath } and pre-load modules
    if (url.pathname === "/init") {
      if (req.method !== "POST" || !req.body) {
        return new Response("expected POST with body", { status: 400 });
      }
      const map = (await req.json()) as Record<string, string>;
      for (const [browserUrl, srcPath] of Object.entries(map)) {
        urlToSourcePath.set(browserUrl, srcPath);
        try {
          loaded.set(browserUrl, await import(srcPath) as object);
        } catch {
          loaded.set(browserUrl, nullModule);
        }
      }
      return new Response("ok");
    }

    // / — SSR render
    if (req.method !== "POST" || !req.body) {
      return new Response("expected POST with body", { status: 400 });
    }
    const manifestHeader = req.headers.get("X-SSR-Manifest");
    if (!manifestHeader) {
      return new Response("missing X-SSR-Manifest", { status: 400 });
    }

    const moduleMap = JSON.parse(manifestHeader) as SsrModuleMap;
    const serverConsumerManifest = {
      moduleMap,
      serverModuleMap: null,
      moduleLoading: null,
    };

    try {
      const rscPromise = createFromReadableStream(req.body, {
        serverConsumerManifest,
      });
      // SsrBoundary catches client components that throw on the server.
      // Suspense handles the async RSC promise.
      const element = createElement(
        Suspense,
        { fallback: null },
        createElement(
          SsrBoundary,
          null,
          createElement(RscRoot, { p: rscPromise }),
        ),
      );
      const htmlStream = await renderToHtmlStream(element, {
        onError(err) {
          console.warn("[SSR] render error (non-fatal):", err);
        },
      });
      return new Response(htmlStream, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    } catch (e) {
      console.error("[SSR] fatal render error:", e);
      return new Response(String(e), { status: 500 });
    }
  },
});

// Signal the parent process with our port so it can start routing SSR
// requests to us.
process.stdout.write(`SSR_PORT=${server.port}\n`);
