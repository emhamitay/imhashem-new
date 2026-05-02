/*
RSC client bootstrap.

Read the inline RSC payload embedded by the server, hand it to React's
react-server-dom-webpack/client.browser to deserialize back into a React
element tree, and mount it into #root.

We're not pre-rendering HTML on the server (see note.txt), so we use
createRoot rather than hydrateRoot — there's nothing to hydrate, just an
empty <div id="root">.

The current rscPromise lives in React state on Root so the client router
can swap it on navigation (`<Link>` clicks, popstate). registerSetRoot wires
the setter into the module-level singleton in client-router.ts.

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
import { registerSetRoot, initClientRouter } from "./framework/client-router.ts";

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
);

function Root(): ReactNode {
  const [promise, setPromise] = useState<Promise<ReactNode>>(initialPromise);
  useEffect(() => {
    registerSetRoot(setPromise);
    initClientRouter();
  }, []);
  return use(promise) as ReactNode;
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("[RSC] #root not found");
createRoot(rootEl).render(createElement(Root));
