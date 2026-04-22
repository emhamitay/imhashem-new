import { renderToReadableStream } from "react-dom/server";
import { createElement, type ComponentType } from "react";
import { RouteParamsProvider } from "./hooks.ts";

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

/*
For "dashboard/settings/page.tsx" returns:
["layout.tsx", "dashboard/layout.tsx", "dashboard/settings/layout.tsx"]
*/
function getLayoutPaths(normalizedFile: string): string[] {
  const segments = normalizedFile
    .replace(/\/?page\.tsx$/, "")
    .split("/")
    .filter(Boolean);

  const paths = ["layout.tsx"];
  for (let i = 0; i < segments.length; i++) {
    paths.push([...segments.slice(0, i + 1), "layout.tsx"].join("/"));
  }
  return paths;
}

async function resolveLayouts(
  normalizedFile: string,
): Promise<ComponentType<{ children: React.ReactNode }>[]> {
  const layouts: ComponentType<{ children: React.ReactNode }>[] = [];

  for (const layoutPath of getLayoutPaths(normalizedFile)) {
    try {
      const mod = await import(`${import.meta.dir}/../app/${layoutPath}`);
      if (mod.default) layouts.push(mod.default);
    } catch {
      // no layout at this segment, skip
    }
  }

  return layouts;
}

function wrapWithLayouts(
  page: React.ReactNode,
  layouts: ComponentType<{ children: React.ReactNode }>[],
): React.ReactNode {
  return layouts.reduceRight(
    (children, Layout) => createElement(Layout, null, children),
    page,
  );
}

export async function createRoutes() {
  const glob = new Bun.Glob("**/page.tsx");
  const routes: Record<string, RouteHandler> = {};

  for await (const file of glob.scan(`${import.meta.dir}/../app`)) {
    const { normalizedFile, route } = normalizeRoutePath(file);

    routes[route] = async (req) => {
      const params = (req as any).params ?? {};

      const mod = await import(`${import.meta.dir}/../app/${normalizedFile}`);
      const Page = mod.default as ComponentType;

      const layouts = await resolveLayouts(normalizedFile);
      const pageTree = wrapWithLayouts(createElement(Page), layouts);
      const tree = createElement(RouteParamsProvider, { params }, pageTree);

      const [shell, stream] = await Promise.all([
        fetchShell(req),
        renderToReadableStream(tree),
      ]);
      await stream.allReady;
      const html = await new Response(stream).text();
      const fullPage = shell
        .replace("<!--SSR-->", html)
        .replace(
          "</body>",
          `<script>window.__PARAMS__=${JSON.stringify(params)}</script></body>`,
        );

      return new Response(fullPage, {
        headers: { "Content-Type": "text/html" },
      });
    };

    console.log(`Registered route: ${route}`);
  }

  return routes;
}
