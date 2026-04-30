/*
RSC client bootstrap.

Read the inline RSC payload embedded by the server, hand it to React's
react-server-dom-webpack/client.browser to deserialize back into a React
element tree, and mount it into #root.

We're not pre-rendering HTML on the server (see note.txt), so we use
createRoot rather than hydrateRoot — there's nothing to hydrate, just an
empty <div id="root">.

The webpack-shims import MUST come first: react-server-dom-webpack reads
__webpack_require__ at module-init time, and ES imports execute before any
top-level code in this file. See webpack-shims.ts for details.
*/

import "./webpack-shims.ts";
import { createRoot } from "react-dom/client";
import { createFromReadableStream } from "react-server-dom-webpack/client.browser";
import { use, type ReactNode } from "react";
import { createElement } from "react";

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
