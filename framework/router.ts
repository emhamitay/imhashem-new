import { renderToReadableStream } from "react-dom/server";
import { createElement, type ComponentType } from "react";
import { runWithParams } from "./context.ts";

type RouteHandler = (req: Request) => Promise<Response>;

export const SHELL_PATH = "/__bunframe_shell__";

/*
normalizeRoutePath - handles Windows paths, 
strips app/ prefix, maps page.tsx to the right route
*/
function normalizeRoutePath(file: string) {
  const normalizedFile = file.replace(/\\/g, "/").replace(/^\.\//, "");
  const appRelativeFile = normalizedFile
    .replace(/^app\//, "")
    .replace(/^\/+/, "");
  const normalizedRoute = appRelativeFile
    .replace(/(?:^|\/)page\.tsx$/, "")
    .replace(/\([^)]*\)\//g, "") // strip (groupname)/ segments
    .replace(/\[([^\]]+)\]/g, ":$1") // [param] → :param
    .replace(/^\/+|\/+$/g, "");

  return {
    normalizedFile: appRelativeFile,
    route: normalizedRoute === "" ? "/" : `/${normalizedRoute}`,
  };
}

/*
fetchShell is clever — it fetches 
/__bunframe_shell__ so Bun injects the correct hashed client script tag automatically
*/
async function fetchShell(req: Request): Promise<string> {
  const shellUrl = new URL(SHELL_PATH, req.url);
  const response = await fetch(shellUrl);
  return response.text();
}

export async function createRoutes() {
  const glob = new Bun.Glob("**/page.tsx");
  const routes: Record<string, RouteHandler> = {};

  for await (const file of glob.scan(`${import.meta.dir}/../app`)) {
    const { normalizedFile, route } = normalizeRoutePath(file);

    // inside createRoutes(), replace the route handler:
    routes[route] = async (req) => {
      const params = (req as any).params ?? {};

      return runWithParams(params, async () => {
        const mod = await import(`${import.meta.dir}/../app/${normalizedFile}`);
        const Page = mod.default as ComponentType;

        const [shell, stream] = await Promise.all([
          fetchShell(req),
          renderToReadableStream(createElement(Page)),
        ]);
        await stream.allReady;
        const html = await new Response(stream).text();
        const fullPage = shell.replace("<!--SSR-->", html);

        return new Response(fullPage, {
          headers: { "Content-Type": "text/html" },
        });
      });
    };

    console.log(`Registered route: ${route}`);
  }

  return routes;
}
