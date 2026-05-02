import { renderToReadableStream } from "react-server-dom-webpack/server.edge";
import { createElement, type ComponentType } from "react";
import { getManifest } from "./rsc/manifest.ts";

type PageProps = { params: Record<string, string> };
type LayoutProps = { params: Record<string, string>; children: React.ReactNode };

type RouteHandler = (req: Request) => Promise<Response>;

export type RouterConfig = {
  bootstrapUrl: string;
};

let bootstrapUrl = "";
export function setRouterConfig(cfg: RouterConfig): void {
  bootstrapUrl = cfg.bootstrapUrl;
}

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
): Promise<ComponentType<LayoutProps>[]> {
  const layouts: ComponentType<LayoutProps>[] = [];
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
  layouts: ComponentType<LayoutProps>[],
  params: Record<string, string>,
): React.ReactNode {
  return layouts.reduceRight(
    (children, Layout) => createElement(Layout, { params }, children),
    page,
  );
}

/*
HTML shell.

The RSC payload is embedded as the body of a <script type="text/x-component">.
Inside HTML, the only sequence the parser recognizes as ending a script is
literally "</script" (case-insensitive). We escape that with a backslash so
the payload can carry arbitrary text without breaking the document.
*/
function escapeScriptText(s: string): string {
  return s.replace(/<\/(script)/gi, "<\\/$1");
}

/*
The webpack shims MUST be installed before the module bundle starts evaluating.
With code-splitting on, Bun lifts react-server-dom-webpack into a shared chunk;
that chunk's top-level body materializes the rsdw CJS module (which reads
`__webpack_require__.u` at init), and shared chunks evaluate before any entry
body. So an `import "./webpack-shims.ts"` inside client.ts is too late — by
the time the entry body runs, the shared chunk has already thrown. Inlining
the shim as a plain <script> before the module script is the only point that
predates chunk evaluation.
*/
const WEBPACK_SHIMS_INLINE = `(()=>{const c=new Map;window.__webpack_chunk_load__=async i=>{if(c.has(i))return;c.set(i,await import(i))};window.__webpack_require__=i=>{const m=c.get(i);if(m===undefined)throw new Error("[RSC] module not loaded yet: "+i);return m};window.__webpack_get_script_filename__=i=>i;})();`;

function htmlShell(rscPayload: string, params: Record<string, string>): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>BunFrame</title>
</head>
<body>
<div id="root"></div>
<script type="text/x-component" id="__BUNFRAME_RSC__">${escapeScriptText(rscPayload)}</script>
<script>window.__PARAMS__=${JSON.stringify(params)};${WEBPACK_SHIMS_INLINE}</script>
<script type="module" src="${bootstrapUrl}"></script>
</body>
</html>`;
}

async function streamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

/*
Soft-navigation requests come from the browser-side router with
`Accept: text/x-component`. They get back the raw RSC stream — no HTML shell,
no bootstrap script — which the client deserializes and swaps into the live
React tree. Same URL as the HTML response; the Accept header is the only
difference, so the cache key story matches a normal page (no `?_rsc=1` query).

`X-Bunframe-Params` carries the route params back out so the client can refresh
`window.__PARAMS__` (which the HTML shell inlines on first load) before the
new tree renders — otherwise client components reading params via useParams
would see stale values across navigation.
*/
function wantsRscOnly(req: Request): boolean {
  return req.headers.get("Accept") === "text/x-component";
}

export async function createRoutes() {
  const glob = new Bun.Glob("**/page.tsx");
  const routes: Record<string, RouteHandler> = {};

  for await (const file of glob.scan(`${import.meta.dir}/../app`)) {
    const { normalizedFile, route } = normalizeRoutePath(file);

    routes[route] = async (req) => {
      const params = (req as any).params ?? {};

      const mod = await import(`${import.meta.dir}/../app/${normalizedFile}`);
      const Page = mod.default as ComponentType<PageProps>;

      const layouts = await resolveLayouts(normalizedFile);
      const tree = wrapWithLayouts(createElement(Page, { params }), layouts, params);

      const rscStream = renderToReadableStream(tree, getManifest());

      if (wantsRscOnly(req)) {
        return new Response(rscStream, {
          headers: {
            "Content-Type": "text/x-component; charset=utf-8",
            "X-Bunframe-Params": JSON.stringify(params),
            "Cache-Control": "no-store",
          },
        });
      }

      const rscPayload = await streamToString(rscStream);
      const html = htmlShell(rscPayload, params);
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    };

    console.log(`Registered route: ${route}`);
  }

  return routes;
}
