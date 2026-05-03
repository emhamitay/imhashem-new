/*
Walks the source tree to find every "use client" and "use server" module
before we boot the server. Returns absolute paths for each kind.

We pre-scan rather than discover lazily because the client bundle is built
once at startup; if a module is only imported on the second request it
would otherwise miss the first build (and for "use server" modules, miss
the manifest the form-action handler needs).
*/

import { Glob } from "bun";
import { resolve } from "node:path";
import { findDirectives } from "./directives.ts";
import { recordClientModule } from "./manifest.ts";
import { recordServerModule } from "./server-fn.ts";

export type ScanResult = {
  clientFiles: string[];
  serverFnFiles: string[];
};

const SOURCE_GLOB = "**/*.{ts,tsx,js,jsx,mjs,cjs}";
const IGNORE = /[\\/]node_modules[\\/]|[\\/]\.bunframe[\\/]|[\\/]dist[\\/]|[\\/]\.git[\\/]/;

const transpilers: Record<string, Bun.Transpiler> = {
  tsx: new Bun.Transpiler({ loader: "tsx" }),
  ts: new Bun.Transpiler({ loader: "ts" }),
  jsx: new Bun.Transpiler({ loader: "jsx" }),
  js: new Bun.Transpiler({ loader: "js" }),
  mjs: new Bun.Transpiler({ loader: "js" }),
  cjs: new Bun.Transpiler({ loader: "js" }),
};

function transpilerFor(path: string): Bun.Transpiler {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return transpilers[ext] ?? transpilers.tsx!;
}

export async function scanForClientModules(roots: string[]): Promise<ScanResult> {
  const clientFiles = new Set<string>();
  const serverFnFiles = new Set<string>();
  const glob = new Glob(SOURCE_GLOB);

  for (const root of roots) {
    const abs = resolve(root);
    for await (const rel of glob.scan({ cwd: abs, absolute: true })) {
      if (IGNORE.test(rel)) continue;
      const src = await Bun.file(rel).text();
      const directives = findDirectives(src);
      const isClient = directives.has("use client");
      const isServer = directives.has("use server");
      if (!isClient && !isServer) continue;

      const exports = transpilerFor(rel).scan(src).exports;
      if (isClient) {
        clientFiles.add(rel);
        // Pre-populate the manifest's client-module table so the client build
        // can produce a manifest entry for every file we discovered (the
        // runtime plugin's onLoad would otherwise only record modules that
        // get imported during request handling).
        recordClientModule(rel, exports);
      }
      if (isServer) {
        serverFnFiles.add(rel);
        recordServerModule(rel, exports);
      }
    }
  }

  return { clientFiles: [...clientFiles], serverFnFiles: [...serverFnFiles] };
}
