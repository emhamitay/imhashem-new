/*
RSC client bootstrap.

Read the inline RSC payload embedded by the server, hand it to React's
react-server-dom-webpack/client.browser to deserialize back into a React
element tree, and mount it into #root.

We're not pre-rendering HTML on the server (see note.txt), so we use
createRoot rather than hydrateRoot — there's nothing to hydrate, just an
empty <div id="root">.

The current rscPromise lives in React state on Root so the client router AND
the Server Function dispatcher can swap it. registerSetRoot writes the setter
into the singleton in framework/rsc/call-server.ts; client-router.ts reads
it from there too, so navigation and action auto-rerender share one path.

The webpack-flavored globals (__webpack_require__ etc.) that rsdw reads at
module-init time are installed by an inline <script> in the HTML shell
(see framework/router.ts). Doing it from a sibling import here would be
too late: with code-splitting, rsdw is lifted into a shared chunk that
evaluates before this entry's body runs.
*/

import { createRoot } from "react-dom/client";
import { createFromReadableStream } from "react-server-dom-webpack/client.browser";
import { use, useEffect, useState, type ReactNode } from "react";
import { createElement } from "react";
import { initClientRouter } from "./framework/client-router.ts";
import { callServer, registerSetRoot } from "./framework/rsc/call-server.ts";

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

const initialPromise = createFromReadableStream<ReactNode>(
  payloadToStream(getInlineRscPayload()),
  { callServer },
);

function Root(): ReactNode {
  const [node, setNode] = useState<ReactNode | Promise<ReactNode>>(initialPromise);
  useEffect(() => {
    registerSetRoot(setNode);
    initClientRouter();
  }, []);
  // `use` accepts both a thenable and a plain value. Initial mount passes the
  // promise from the inline payload; navigation/action paths pass the already
  // -resolved tree (or another promise from createFromFetch).
  return (typeof (node as { then?: unknown })?.then === "function"
    ? use(node as Promise<ReactNode>)
    : (node as ReactNode));
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("[RSC] #root not found");
createRoot(rootEl).render(createElement(Root));
