/*
Builds the browser bundle for every "use client" module.

Each client file is a Bun.build entry. We use code splitting so React/ReactDOM
share one chunk across all client components. After the build completes we
walk the outputs and produce a ClientManifest that the server hands to
react-server-dom-webpack/server.edge during the RSC render.

The manifest's `id` and the chunks' first element are both the browser URL,
so the client-side __webpack_chunk_load__ and __webpack_require__ shims can
share a single Map keyed by URL.
*/

import { join, relative, resolve } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import type { ClientManifest } from "./manifest.ts";
import { setManifest, getClientModules } from "./manifest.ts";
import { hasUseServer } from "./directives.ts";
import {
  buildBrowserStubSource,
  getServerModules,
  setServerManifest,
  setCallServerPath,
} from "./server-fn.ts";

export const CLIENT_PUBLIC_PREFIX = "/__bunframe/client/";

export type BuildClientOptions = {
  entries: string[];
  serverFnEntries: string[];   // absolute paths of "use server" files (bundled as stubs)
  bootstrap: string;           // absolute path to the browser bootstrap (client.ts)
  callServer: string;          // absolute path to framework/rsc/call-server.ts
  outdir: string;              // absolute path to write chunks into
  cwd: string;                 // project root (used for naming)
  development: boolean;
};

export type BuildClientResult = {
  manifest: ClientManifest;          // client-reference manifest (passed to renderToReadableStream)
  serverManifest: ClientManifest;    // server-reference manifest (passed to decodeAction/decodeReply)
  outdir: string;
  bootstrapUrl: string;
};

/*
A Bun.build plugin that mirrors framework/rsc/plugin.ts but for the BROWSER
graph. When the bundler encounters a "use server" file, we replace its
contents with a stub of server-reference proxies. Without this, real server
code would end up in the browser bundle — a security hole.
*/
function makeUseServerStubPlugin(serverFnAbsPaths: Set<string>): Bun.BunPlugin {
  return {
    name: "bunframe-use-server-browser-stub",
    setup(build) {
      const filter = /\.(?:tsx?|jsx?|mjs|cjs)$/;
      build.onLoad({ filter }, async ({ path }) => {
        // Fast-path: only inspect files we discovered at scan time. Anything
        // else (node_modules, framework internals) gets the default loader.
        if (!serverFnAbsPaths.has(path)) {
          // Still need to defensively check files that might have been added
          // since scan: cheap text read, only matters for first import.
          const src = await Bun.file(path).text();
          if (!hasUseServer(src)) return undefined;
          // Fall through with discovered exports if any — but without scan
          // we don't have a clean export list, so do a transpiler scan now.
          const t = new Bun.Transpiler({ loader: "tsx" });
          const exports = t.scan(src).exports;
          return { contents: buildBrowserStubSource(path, exports), loader: "js" };
        }
        const src = await Bun.file(path).text();
        const t = new Bun.Transpiler({ loader: "tsx" });
        const exports = t.scan(src).exports;
        return { contents: buildBrowserStubSource(path, exports), loader: "js" };
      });
    },
  };
}

export async function buildClient(opts: BuildClientOptions): Promise<BuildClientResult> {
  const { entries, serverFnEntries, bootstrap, callServer, outdir, cwd, development } = opts;
  setCallServerPath(callServer);
  const serverFnSet = new Set(serverFnEntries.map((p) => resolve(p)));

  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  // Server-fn files are bundled into the browser graph as stubs (the plugin
  // intercepts onLoad and replaces their source). They MUST be present as
  // entry points so the bundler emits one chunk per file the manifest can
  // point to — though for v1 the browser stubs are only reached transitively
  // (a "use client" component imports them), so listing them as entries is
  // belt-and-suspenders for code-splitting and for tests that need to hit the
  // chunk URL directly.
  const allEntries = [bootstrap, ...entries, ...serverFnEntries];

  const result = await Bun.build({
    entrypoints: allEntries,
    outdir,
    target: "browser",
    format: "esm",
    splitting: true,
    sourcemap: development ? "inline" : "external",
    minify: !development,
    plugins: [makeUseServerStubPlugin(serverFnSet)],
    // The parent Bun process runs with `--conditions react-server` so React
    // resolves to its server-only build. Without overriding here, Bun.build
    // inherits that condition and the browser bundle ends up importing
    // `react/jsx-dev-runtime.react-server.js` — a dynamic-require wrapper
    // whose named exports (jsxDEV, jsx, jsxs) Bun can't statically read.
    // Force the standard browser conditions so React resolves to its normal
    // ESM browser build instead.
    conditions: ["browser", "module", "import", "default"],
    naming: development
      ? { entry: "[dir]/[name].[ext]", chunk: "chunks/[name]-[hash].[ext]" }
      : { entry: "[dir]/[name]-[hash].[ext]", chunk: "chunks/[name]-[hash].[ext]" },
    define: {
      "process.env.NODE_ENV": JSON.stringify(development ? "development" : "production"),
    },
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("[RSC] client build failed");
  }

  // Match source absolute path -> built output path by entry-point basename.
  // Bun's BuildOutput doesn't expose the source path of an entry on disk in
  // a stable way across versions, so we match by stripped-hash basename.
  const sourceToOutput = new Map<string, string>();
  for (const out of result.outputs) {
    if (out.kind !== "entry-point") continue;
    const baseNoHash = stripExt(stripHash(basename(out.path)));
    for (const entry of allEntries) {
      if (stripExt(basename(entry)) === baseNoHash) {
        sourceToOutput.set(resolve(entry), out.path);
        break;
      }
    }
  }

  const manifest: ClientManifest = {};
  for (const [absPath, info] of getClientModules()) {
    const outPath = sourceToOutput.get(absPath);
    if (!outPath) {
      console.warn(`[RSC] no client build output for ${absPath}`);
      continue;
    }
    const url = absToPublicUrl(outPath, outdir);
    manifest[absPath] = {
      id: url,
      chunks: [url, url],
      name: info.exports[0] ?? "default",
      async: false,
    };
  }

  const bootstrapOut = sourceToOutput.get(resolve(bootstrap));
  if (!bootstrapOut) {
    throw new Error(`[RSC] could not locate built bootstrap for ${bootstrap}`);
  }
  const bootstrapUrl = absToPublicUrl(bootstrapOut, outdir);

  // Build the SERVER-side manifest used by decodeAction/decodeReply when a
  // server reference comes in over the wire. Keys are absolute paths (the
  // same `id` we register with registerServerReference). The server-side
  // __webpack_require__ shim resolves these via dynamic import — see
  // installServerWebpackShims().
  const serverManifest: ClientManifest = {};
  for (const [absPath, info] of getServerModules()) {
    serverManifest[absPath] = {
      id: absPath,
      chunks: [absPath, absPath],
      name: info.exports[0] ?? "",
      async: false,
    };
  }

  setManifest(manifest);
  setServerManifest(serverManifest);
  void cwd;
  return { manifest, serverManifest, outdir, bootstrapUrl };
}

function basename(p: string): string {
  return p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);
}

function stripExt(p: string): string {
  const i = p.lastIndexOf(".");
  return i === -1 ? p : p.slice(0, i);
}

function stripHash(p: string): string {
  // Removes a "-<hash>" suffix from a basename like "Counter-abc123.js"
  return p.replace(/-[a-z0-9]+(\.[^.]+)$/i, "$1");
}

function absToPublicUrl(absPath: string, outdir: string): string {
  const rel = relative(outdir, absPath).replace(/\\/g, "/");
  return CLIENT_PUBLIC_PREFIX + rel;
}

export function publicPathToDisk(publicPath: string, outdir: string): string | null {
  if (!publicPath.startsWith(CLIENT_PUBLIC_PREFIX)) return null;
  const rel = publicPath.slice(CLIENT_PUBLIC_PREFIX.length);
  return join(outdir, rel);
}
