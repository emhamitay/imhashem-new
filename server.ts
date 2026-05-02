import { join } from "node:path";
import { existsSync } from "node:fs";
import { registerRscServerPlugin } from "./framework/rsc/plugin.ts";
import { scanForClientModules } from "./framework/rsc/scan.ts";
import { buildClient, publicPathToDisk, CLIENT_PUBLIC_PREFIX } from "./framework/rsc/build-client.ts";
import { createRoutes, setRouterConfig } from "./framework/router.ts";

const isDev = process.env.NODE_ENV === "development";
const projectRoot = import.meta.dir;
const clientOutdir = join(projectRoot, ".bunframe", "client");

// Order matters: register the RSC plugin BEFORE we ever import a page module
// from app/. Otherwise dynamic imports below won't go through the plugin and
// "use client" files would be loaded as real components on the server.
registerRscServerPlugin();

console.log("[BunFrame] Scanning for client modules...");
const { clientFiles } = await scanForClientModules([
  join(projectRoot, "app"),
  join(projectRoot, "components"),
  // framework/ contains client primitives like Link.tsx and hooks.ts that
  // ship to the browser as "use client" entry points.
  join(projectRoot, "framework"),
]);
console.log(`[BunFrame] Found ${clientFiles.length} client module(s)`);

console.log("[BunFrame] Building client bundle...");
const { bootstrapUrl } = await buildClient({
  entries: clientFiles,
  bootstrap: join(projectRoot, "client.ts"),
  outdir: clientOutdir,
  cwd: projectRoot,
  development: isDev,
});
console.log(`[BunFrame] Client bootstrap: ${bootstrapUrl}`);

setRouterConfig({ bootstrapUrl });

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
