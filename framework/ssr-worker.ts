/*
SSR subprocess for HTML pre-render (Pass 2).

Runs WITHOUT --conditions react-server so react-dom/server resolves to the
real implementation instead of the stub that throws under that condition.
Spawned once at startup by server.ts; serves one SSR request per GET.

Protocol:
  POST /
  X-SSR-Manifest: <JSON ssrModuleMap>
  body: raw RSC stream bytes

  Response: prerendered HTML string (content for <div id="root">)

Client components resolve to null-returning stubs via our local webpack
shims. This means server component content is prerendered; client component
slots are empty and filled in by hydrateRoot in the browser.
*/

import { createFromReadableStream } from "react-server-dom-webpack/client.edge";
import { renderToReadableStream as renderToHtmlStream } from "react-dom/server";
import { use, createElement, Suspense } from "react";

// Install webpack shims before any rsdw/client.edge module resolution.
// All client module chunk loads resolve immediately with a Proxy that returns
// () => null for every property access so React renders client component
// slots as null (empty). Browser hydrateRoot fills them in from the RSC
// payload.
const nullModule = new Proxy(
  {},
  {
    get: () => () => null,
    getOwnPropertyDescriptor: (_t, key) => ({
      value: () => null,
      writable: true,
      enumerable: true,
      configurable: true,
    }),
    has: () => true,
  },
);

const loaded = new Map<string, object>();
const g = globalThis as Record<string, unknown>;
g.__webpack_require__ = (id: string): object => loaded.get(id) ?? nullModule;
g.__webpack_chunk_load__ = (id: string): Promise<void> => {
  loaded.set(id, nullModule);
  return Promise.resolve();
};
g.__webpack_get_script_filename__ = (id: string): string => id;

type SsrEntry = { id: string; chunks: string[]; name: string };
type SsrModuleMap = Record<string, Record<string, SsrEntry>>;

function RscRoot({ p }: { p: unknown }) {
  return use(p as Promise<React.ReactNode>);
}

async function streamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return chunks.join("");
}

const server = Bun.serve({
  port: 0,
  async fetch(req) {
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
      // Wrap in Suspense so react-dom/server handles the pending RSC promise
      // gracefully (renders null fallback initially, then the resolved tree).
      const element = createElement(
        Suspense,
        { fallback: null },
        createElement(RscRoot, { p: rscPromise }),
      );
      const htmlStream = await renderToHtmlStream(element);
      const html = await streamToString(htmlStream);
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    } catch (e) {
      console.error("[SSR] render error:", e);
      return new Response(String(e), { status: 500 });
    }
  },
});

// Signal the parent process with our port so it can start routing SSR
// requests to us.
process.stdout.write(`SSR_PORT=${server.port}\n`);
