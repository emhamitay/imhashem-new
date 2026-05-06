import { join } from "node:path";
import { existsSync } from "node:fs";
import { registerRscServerPlugin } from "./framework/rsc/plugin.ts";
import { scanForClientModules } from "./framework/rsc/scan.ts";
import { buildClient, publicPathToDisk, CLIENT_PUBLIC_PREFIX } from "./framework/rsc/build-client.ts";
import { createRoutes, setRouterConfig } from "./framework/router.ts";
import { installServerWebpackShims } from "./framework/rsc/server-fn.ts";
import { getManifest } from "./framework/rsc/manifest.ts";

const isDev = process.env.NODE_ENV === "development";
const projectRoot = import.meta.dir;
const clientOutdir = join(projectRoot, ".bunframe", "client");

// Order matters: register the RSC plugin BEFORE we ever import a page module
// from app/. Otherwise dynamic imports below won't go through the plugin and
// "use client" files would be loaded as real components on the server.
registerRscServerPlugin();

// Install __webpack_require__ / __webpack_chunk_load__ on globalThis so
// rsdw/server.edge can resolve server references during decodeAction or
// when a flight stream encodes a server function. The shim defers each id
// to a Bun-native dynamic import.
installServerWebpackShims();

console.log("[BunFrame] Scanning for client and server-fn modules...");
const { clientFiles, serverFnFiles } = await scanForClientModules([
  join(projectRoot, "app"),
  join(projectRoot, "components"),
  // framework/ contains client primitives like Link.tsx and hooks.ts that
  // ship to the browser as "use client" entry points.
  join(projectRoot, "framework"),
]);
console.log(
  `[BunFrame] Found ${clientFiles.length} client module(s), ${serverFnFiles.length} server-fn module(s)`,
);

console.log("[BunFrame] Building client bundle...");
const { bootstrapUrl } = await buildClient({
  entries: clientFiles,
  serverFnEntries: serverFnFiles,
  bootstrap: join(projectRoot, "client.ts"),
  callServer: join(projectRoot, "framework", "rsc", "call-server.ts"),
  outdir: clientOutdir,
  cwd: projectRoot,
  development: isDev,
});
console.log(`[BunFrame] Client bootstrap: ${bootstrapUrl}`);

// Spawn the SSR subprocess. It runs WITHOUT --conditions react-server so
// react-dom/server resolves to the real implementation. It signals its port
// on stdout; we wait up to 10 s. On failure we continue without SSR.
const ssrWorkerPath = join(projectRoot, "framework", "ssr-worker.ts");
const ssrProc = Bun.spawn({
  cmd: ["bun", ssrWorkerPath],
  cwd: projectRoot,
  env: { ...process.env },
  stdout: "pipe",
  stderr: "inherit",
});

async function readSsrPort(proc: Bun.Subprocess, timeoutMs = 10_000): Promise<number | null> {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let buf = "";
  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const m = buf.match(/SSR_PORT=(\d+)/);
      if (m) { reader.releaseLock(); return Number(m[1]); }
    }
  } catch {
    // fall through
  }
  reader.releaseLock();
  return null;
}

const ssrPort = await readSsrPort(ssrProc);
const ssrUrl = ssrPort ? `http://127.0.0.1:${ssrPort}` : undefined;
if (ssrUrl) console.log(`[BunFrame] SSR worker: ${ssrUrl}`);
else console.warn("[BunFrame] SSR worker failed to start — falling back to client-only rendering");

// Build the SSR module map once: maps browser chunk URL → wildcard entry so
// createFromReadableStream in the SSR subprocess can resolve client references.
const ssrModuleMap = buildSsrModuleMap();
function buildSsrModuleMap(): Record<string, Record<string, { id: string; chunks: string[]; name: string }>> {
  const map: Record<string, Record<string, { id: string; chunks: string[]; name: string }>> = {};
  for (const entry of Object.values(getManifest())) {
    map[entry.id] = { "*": { id: entry.id, chunks: entry.chunks, name: entry.name } };
  }
  return map;
}

setRouterConfig({ bootstrapUrl, ssrUrl, ssrModuleMap });

const pageRoutes = await createRoutes();

const server = Bun.serve({
  port: Number(process.env.PORT) || 3000,

  routes: pageRoutes,

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith(CLIENT_PUBLIC_PREFIX)) {
      const diskPath = publicPathToDisk(url.pathname, clientOutdir);
      if (diskPath && existsSync(diskPath)) {
        return new Response(Bun.file(diskPath), {
          headers: {
            "Content-Type": "text/javascript; charset=utf-8",
            "Cache-Control": isDev ? "no-cache" : "public, max-age=31536000, immutable",
          },
        });
      }
    }
    return new Response("Not found", { status: 404 });
  },

  development: isDev && {
    hmr: false, // RSC HMR is its own thing — deferred (see note.txt)
    console: true,
  },
});

console.log(`BunFrame running at ${server.url}`);
