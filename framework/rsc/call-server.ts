/*
Browser-side runtime for Server Functions.

The singleton `callServer(id, args)` is what every server-reference stub
ends up calling. It encodes args via rsdw's encodeReply, POSTs to the
current page URL with X-Bunframe-Action-Id, and parses the response as a
flight payload encoding `{ returnValue, root }` — the action's result plus
the freshly-rendered route tree. We hand returnValue back to the caller
and swap the live React tree to root, so an action implicitly refreshes
the page (Next.js's revalidation behavior, achieved here by the same
mechanism that powers `<Link>` soft-nav).

This module is browser-only: it imports rsdw/client.browser at module top.
It must NOT be imported from any server-side file. Only the generated
"use server" client stubs and the bootstrap reach it.
*/

import {
  createFromReadableStream,
  encodeReply,
} from "react-server-dom-webpack/client.browser";
import type { ReactNode } from "react";

type SetRoot = (next: ReactNode | Promise<ReactNode>) => void;

let setRoot: SetRoot | null = null;

export function registerSetRoot(fn: SetRoot): void {
  setRoot = fn;
}

export function getSetRoot(): SetRoot | null {
  return setRoot;
}

type ActionResponse = { returnValue: unknown; root: ReactNode };

export async function callServer(id: string, args: unknown[]): Promise<unknown> {
  const body = await encodeReply(args);
  const res = await fetch(location.pathname + location.search, {
    method: "POST",
    headers: {
      Accept: "text/x-component",
      "X-Bunframe-Action-Id": id,
    },
    body: body as BodyInit,
  });
  if (!res.ok || !res.body) {
    throw new Error(`[RSC] action POST failed: ${res.status}`);
  }
  const decoded = await createFromReadableStream<ActionResponse>(res.body, {
    callServer,
  });
  if (setRoot && decoded.root !== undefined) {
    setRoot(decoded.root);
  }
  return decoded.returnValue;
}
