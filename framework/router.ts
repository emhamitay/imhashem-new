import { renderToReadableStream } from "react-dom/server"
import { createElement, type ComponentType } from "react"

type RouteHandler = (req: Request) => Promise<Response>

export const SHELL_PATH = "/__bunframe_shell__"

function normalizeRoutePath(file: string) {
  const normalizedFile = file.replace(/\\/g, "/").replace(/^\.\//, "")
  const appRelativeFile = normalizedFile.replace(/^app\//, "").replace(/^\/+/, "")
  const normalizedRoute = appRelativeFile
    .replace(/(?:^|\/)page\.tsx$/, "")
    .replace(/^\/+|\/+$/g, "")

  return {
    normalizedFile: appRelativeFile,
    route: normalizedRoute === "" ? "/" : `/${normalizedRoute}`,
  }
}

async function fetchShell(req: Request): Promise<string> {
  const shellUrl = new URL(SHELL_PATH, req.url)
  const response = await fetch(shellUrl)
  return response.text()
}

export async function createRoutes(isDev: boolean) {
  const glob = new Bun.Glob("**/page.tsx")
  const routes: Record<string, RouteHandler> = {}

  for await (const file of glob.scan("./app")) {
    const { normalizedFile, route } = normalizeRoutePath(file)

    routes[route] = async (req) => {
      const suffix = isDev ? `?t=${Date.now()}` : ""
      const mod = await import(`../app/${normalizedFile}${suffix}`)
      const Page = mod.default as ComponentType

      const [shell, stream] = await Promise.all([
        fetchShell(req),
        renderToReadableStream(createElement(Page)),
      ])
      await stream.allReady
      const html = await new Response(stream).text()
      const fullPage = shell.replace("<!--SSR-->", html)

      return new Response(fullPage, {
        headers: { "Content-Type": "text/html" },
      })
    }

    console.log(`Registered route: ${route}`)
  }

  return routes
}
