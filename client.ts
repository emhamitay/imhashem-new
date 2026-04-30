/*
RSC client bootstrap.

Read the inline RSC payload embedded by the server, hand it to React's
react-server-dom-webpack/client.browser to deserialize back into a React
element tree, and mount it into #root.

We're not pre-rendering HTML on the server (see note.txt), so we use
createRoot rather than hydrateRoot — there's nothing to hydrate, just an
empty <div id="root">.

react-server-dom-webpack uses two webpack-flavored globals to load referenced
client modules:

  __webpack_chunk_load__(id)  -> Promise that resolves once the chunk is loaded
  __webpack_require__(id)     -> the module's exports, synchronously, after it's loaded

In our manifest, both id and chunkId are the browser URL of the built module.
The shims below dynamic-import the module on chunk-load and serve it back
from a cache on require.
*/

import { createRoot } from "react-dom/client";
import { createFromReadableStream } from "react-server-dom-webpack/client.browser";
import { use, type ReactNode } from "react";
import { createElement } from "react";

declare global {
  interface Window {
    __webpack_chunk_load__: (id: string) => Promise<void>;
    __webpack_require__: (id: string) => unknown;
  }
}

const moduleCache = new Map<string, unknown>();

window.__webpack_chunk_load__ = async (id: string) => {
  if (moduleCache.has(id)) return;
  const mod = await import(/* @vite-ignore */ id);
  moduleCache.set(id, mod);
};

window.__webpack_require__ = (id: string) => {
  const mod = moduleCache.get(id);
  if (mod === undefined) {
    throw new Error(`[RSC] module not loaded yet: ${id}`);
  }
  return mod;
};

function getInlineRscPayload(): string {
  const el = document.getElementById("__BUNFRAME_RSC__");
  if (!el) throw new Error("[RSC] inline payload missing — did the server include it?");
  return el.textContent ?? "";
}

function payloadToStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

const rootPromise = createFromReadableStream<ReactNode>(
  payloadToStream(getInlineRscPayload()),
);

function Root(): ReactNode {
  return use(rootPromise) as ReactNode;
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("[RSC] #root not found");
createRoot(rootEl).render(createElement(Root));
