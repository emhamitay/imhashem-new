/*
Walks the source tree to find every "use client" module before we boot the
server. Returns absolute paths.

We pre-scan rather than discover lazily because the client bundle is built
once at startup; if a "use client" file is only imported on the second
request it would otherwise miss the first build.
*/

import { Glob } from "bun";
import { resolve } from "node:path";
import { hasUseClient } from "./directives.ts";
import { recordClientModule } from "./manifest.ts";

export type ScanResult = {
  clientFiles: string[];
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
  const glob = new Glob(SOURCE_GLOB);

  for (const root of roots) {
    const abs = resolve(root);
    for await (const rel of glob.scan({ cwd: abs, absolute: true })) {
      if (IGNORE.test(rel)) continue;
      const src = await Bun.file(rel).text();
      if (!hasUseClient(src)) continue;
      clientFiles.add(rel);
      const exports = transpilerFor(rel).scan(src).exports;
      // Pre-populate the manifest's client-module table so the client build
      // can produce a manifest entry for every file we discovered (the
      // runtime plugin's onLoad would otherwise only record modules that
      // get imported during request handling).
      recordClientModule(rel, exports);
    }
  }

  return { clientFiles: [...clientFiles] };
}
