/*
Server Functions support — module-level "use server" only.

Two halves of the same picture:

  1. Server side (this process). Every "use server" file is left intact at
     runtime so server components can call its exports normally. In addition,
     the plugin appends `registerServerReference(fn, absPath, name)` calls so
     React's flight encoder will serialize the function as a reference when
     it's passed as a prop to a client component (rather than throwing
     "functions aren't serializable").

  2. Browser side. The client build replaces every "use server" file with a
     stub whose exports are server-reference proxies built via
     `createServerReference(id, callServer)` from rsdw/client.browser. When
     called, they POST to the page URL with X-Bunframe-Action-Id and the
     encoded reply body; the response carries the action's return value plus
     the re-rendered route, and the live React tree updates in-place.

ID format: `${absPath}#${exportName}` — same scheme manifest.ts uses for
client references. Stable across restarts on the same disk; no hash registry
to maintain.

Inline `"use server"` (closures inside server components) is NOT supported in
this pass. See note.txt §7 for the sketch.
*/

import type { ClientManifest } from "./manifest.ts";

const serverModules = new Map<string, { exports: string[] }>();
let serverManifest: ClientManifest = {};

export function recordServerModule(absPath: string, exports: string[]): void {
  serverModules.set(absPath, { exports });
}

export function getServerModules(): ReadonlyMap<string, { exports: string[] }> {
  return serverModules;
}

export function setServerManifest(next: ClientManifest): void {
  serverManifest = next;
}

export function getServerManifest(): ClientManifest {
  return serverManifest;
}

export function serverFnId(absPath: string, exportName: string): string {
  return `${absPath}#${exportName}`;
}

export function parseFnId(id: string): { absPath: string; exportName: string } | null {
  const idx = id.lastIndexOf("#");
  if (idx === -1) return null;
  return { absPath: id.slice(0, idx), exportName: id.slice(idx + 1) };
}

/*
React's flight machinery calls __webpack_require__/__webpack_chunk_load__ at
two points on the server: when decoding form-action submissions
(decodeAction) and when encoding a server reference whose module hasn't been
imported yet. We give it a Bun-native ESM loader keyed by absolute path —
the same key we use as the manifest ID.

Re-entrancy: each id maps to one cached promise, then to its module exports.
This matches the semantics rsdw expects (preloadModule returns a chunk
promise; requireModule returns the module synchronously after).
*/
export function installServerWebpackShims(): void {
  const g = globalThis as Record<string, unknown>;
  if (g.__webpack_require__ !== undefined) return;

  const loaded = new Map<string, unknown>();
  const inflight = new Map<string, Promise<unknown>>();

  g.__webpack_chunk_load__ = async (id: string): Promise<void> => {
    if (loaded.has(id)) return;
    let p = inflight.get(id);
    if (!p) {
      p = import(id).then((mod) => {
        loaded.set(id, mod);
        inflight.delete(id);
        return mod;
      });
      inflight.set(id, p);
    }
    await p;
  };

  g.__webpack_require__ = (id: string): unknown => {
    const mod = loaded.get(id);
    if (mod === undefined) {
      throw new Error(`[RSC] server module not loaded: ${id}`);
    }
    return mod;
  };
}

/*
Browser-side stub for a "use server" module. Each export becomes a server
reference; calling it POSTs through the singleton callServer (see
framework/rsc/call-server.ts).

Default exports are skipped in v1 — without an AST pass we can't reliably
introduce a binding for an anonymous default expression. Use named exports.
*/
export function buildBrowserStubSource(absPath: string, exports: string[]): string {
  const lines: string[] = [
    `import { createServerReference } from "react-server-dom-webpack/client.browser";`,
    `import { callServer } from ${JSON.stringify(callServerImportPath())};`,
    `const MOD = ${JSON.stringify(absPath)};`,
  ];
  const exposed: string[] = [];
  for (const name of exports) {
    if (name === "default") continue;
    const local = `_${name}`;
    lines.push(
      `const ${local} = createServerReference(MOD + "#" + ${JSON.stringify(name)}, callServer);`,
    );
    exposed.push(`${local} as ${name}`);
  }
  if (exposed.length > 0) lines.push(`export { ${exposed.join(", ")} };`);
  return lines.join("\n") + "\n";
}

/*
Source appended to a "use server" file on the server side. The original code
runs as written; afterward we tag every named function export with
registerServerReference so the flight encoder can serialize it when passed
as a prop. The `if typeof === "function"` guard keeps non-function exports
(constants, classes the user happened to put here) from blowing up.
*/
export function buildServerWrapperAppendix(absPath: string, exports: string[]): string {
  const lines: string[] = [
    `import { registerServerReference as __bf_registerSF } from "react-server-dom-webpack/server.edge";`,
  ];
  for (const name of exports) {
    if (name === "default") continue;
    lines.push(
      `if (typeof ${name} === "function") __bf_registerSF(${name}, ${JSON.stringify(absPath)}, ${JSON.stringify(name)});`,
    );
  }
  return "\n" + lines.join("\n") + "\n";
}

/*
Resolved at build time so the stub file in the .bunframe/ output can
import the call-server runtime by absolute path. Computed lazily — at module
load time we don't know the project root yet.
*/
let callServerPath: string | null = null;
export function setCallServerPath(absPath: string): void {
  callServerPath = absPath;
}
function callServerImportPath(): string {
  if (!callServerPath) {
    throw new Error(
      "[RSC] call-server import path not set. setCallServerPath() must run before the client build.",
    );
  }
  return callServerPath;
}
