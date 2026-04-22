import { createRoutes, SHELL_PATH } from "./framework/router.ts"
import indexHtml from "./index.html"

const isDev = process.env.NODE_ENV === "development"

const pageRoutes = await createRoutes(isDev)

const server = Bun.serve({
  port: 3000,
  routes: {
    ...pageRoutes,
    [SHELL_PATH]: indexHtml,
  },
  development: isDev && {
    hmr: true,
    console: true,
  },
})

console.log(`BunFrame running at ${server.url}`)
