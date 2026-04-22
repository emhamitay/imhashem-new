import type { Elysia } from "elysia"
import { watch } from "node:fs"

type Client = { send: (data: string) => void }

const clients = new Set<Client>()
let watcherStarted = false
let debounceTimer: ReturnType<typeof setTimeout> | null = null

async function rebuild() {
  await Bun.build({
    entrypoints: ["./client.ts"],
    outdir: "./.bunframe",
    naming: "bundle.js",
    target: "browser",
  })
}

function shouldIgnore(path: string) {
  const normalized = path.replace(/\\/g, "/")
  return (
    normalized.startsWith("node_modules/") ||
    normalized.includes("/node_modules/") ||
    normalized.startsWith(".git/") ||
    normalized.includes("/.git/") ||
    normalized.startsWith(".bunframe/") ||
    normalized.includes("/.bunframe/")
  )
}

function startWatcher() {
  if (watcherStarted) return
  watcherStarted = true

  watch(".", { recursive: true }, (_event, filename) => {
    if (!filename) return
    const path = filename.toString()
    if (shouldIgnore(path)) return
    if (!path.endsWith(".ts") && !path.endsWith(".tsx")) return

    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(async () => {
      debounceTimer = null
      try {
        await rebuild()
        for (const client of clients) {
          client.send("reload")
        }
        console.log("[HMR] Reloaded clients after rebuild")
      } catch (err) {
        console.error("[HMR] Rebuild failed:", err)
      }
    }, 75)
  })

  console.log("[HMR] Watching for file changes")
}

export function setupHMR(app: Elysia) {
  startWatcher()

  return app.ws("/hmr", {
    open(ws) {
      clients.add(ws as unknown as Client)
    },
    close(ws) {
      clients.delete(ws as unknown as Client)
    },
  })
}
