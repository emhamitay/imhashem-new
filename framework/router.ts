import { renderToReadableStream, decodeReply, decodeAction, decodeFormState } from "react-server-dom-webpack/server.edge";
import { createElement, type ComponentType } from "react";
import { getManifest } from "./rsc/manifest.ts";
import { getServerManifest, parseFnId } from "./rsc/server-fn.ts";

type PageProps = { params: Record<string, string> };
type LayoutProps = { params: Record<string, string>; children: React.ReactNode };

type RouteHandler = (req: Request) => Promise<Response>;
type RouteEntry = { GET: RouteHandler; POST: RouteHandler };

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
Build the page's React tree. Used by both GET (initial render and soft-nav)
and POST (auto-rerender after a Server Function call).
*/
async function renderRouteTree(
  normalizedFile: string,
  params: Record<string, string>,
): Promise<React.ReactNode> {
  const mod = await import(`${import.meta.dir}/../app/${normalizedFile}`);
  const Page = mod.default as ComponentType<PageProps>;
  const layouts = await resolveLayouts(normalizedFile);
  return wrapWithLayouts(createElement(Page, { params }), layouts, params);
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

/*
GET handler. Renders the route to RSC, then returns either the raw stream
(soft-nav) or an HTML shell with the payload embedded (initial load).
*/
function makeGetHandler(normalizedFile: string): RouteHandler {
  return async (req) => {
    const params = (req as unknown as { params?: Record<string, string> }).params ?? {};
    const tree = await renderRouteTree(normalizedFile, params);
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
}

/*
POST handler — Server Functions.

Two dispatch paths:

  1. JS-driven: client's callServer POSTs with `X-Bunframe-Action-Id: <id>`
     and an encodeReply'd body. We resolve the function by id (absPath +
     export name), decode args via decodeReply, await the call, then re-render
     the current route. The response is a flight stream encoding
     `{ returnValue, root }` so the client can hand returnValue back to the
     caller AND swap the live React tree (auto-rerender, like Next.js).

  2. Form submit (no JS, or progressive enhancement): the request is
     `multipart/form-data` carrying React-encoded action metadata. We use
     decodeAction to recover the bound function call, await it, then plumb
     decodeFormState into renderToReadableStream's `formState` option so
     useActionState sees the action's result on the next render.

For form submits with `Accept: text/x-component`, we still return the flight
stream (JS picked it up). For pure HTML form submits (no JS), we return the
HTML shell with the freshly-rendered RSC embedded — same shape as a GET.
*/
function makePostHandler(normalizedFile: string): RouteHandler {
  return async (req) => {
    const params = (req as unknown as { params?: Record<string, string> }).params ?? {};
    const actionId = req.headers.get("X-Bunframe-Action-Id");
    const contentType = req.headers.get("Content-Type") ?? "";

    let returnValue: unknown = null;
    let formState: unknown = null;

    if (actionId) {
      // JS path. encodeReply on the client returns either a string (simple
      // JSON-able args) or FormData (when args carry Blobs/Dates/Promises);
      // decodeReply accepts both. Pick based on Content-Type.
      const fnId = parseFnId(actionId);
      if (!fnId) {
        return new Response(`bad action id: ${actionId}`, { status: 400 });
      }
      const body: string | FormData = contentType.includes("multipart/form-data")
        ? await req.formData()
        : await req.text();
      const args = (await decodeReply(body, getServerManifest())) as unknown[];
      const mod = await import(fnId.absPath);
      const fn = (mod as Record<string, unknown>)[fnId.exportName];
      if (typeof fn !== "function") {
        return new Response(`action not found: ${actionId}`, { status: 404 });
      }
      returnValue = await (fn as (...a: unknown[]) => unknown)(...args);
    } else if (contentType.includes("multipart/form-data")) {
      // No-JS form path: decodeAction reads $ACTION_* fields and binds args.
      const formData = await req.formData();
      const action = await decodeAction(formData, getServerManifest());
      if (action) {
        returnValue = await action();
        formState = await decodeFormState(returnValue, formData, getServerManifest());
      }
    } else {
      return new Response("unsupported action POST shape", { status: 400 });
    }

    // Re-render the route. JS clients receive { returnValue, root } so they
    // can swap the live tree; HTML clients receive a fresh page with the
    // updated tree embedded.
    const tree = await renderRouteTree(normalizedFile, params);

    if (wantsRscOnly(req)) {
      const rscStream = renderToReadableStream(
        { returnValue, root: tree },
        getManifest(),
      );
      return new Response(rscStream, {
        headers: {
          "Content-Type": "text/x-component; charset=utf-8",
          "X-Bunframe-Params": JSON.stringify(params),
          "Cache-Control": "no-store",
        },
      });
    }

    // No-JS path: hand back HTML with the freshly-rendered route. The
    // formState lands in renderToReadableStream so useActionState picks it
    // up on the next render.
    const renderOpts = formState != null ? { formState } : undefined;
    const rscStream = renderToReadableStream(tree, getManifest(), renderOpts);
    const rscPayload = await streamToString(rscStream);
    const html = htmlShell(rscPayload, params);
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  };
}

export async function createRoutes() {
  const glob = new Bun.Glob("**/page.tsx");
  const routes: Record<string, RouteEntry> = {};

  for await (const file of glob.scan(`${import.meta.dir}/../app`)) {
    const { normalizedFile, route } = normalizeRoutePath(file);
    routes[route] = {
      GET: makeGetHandler(normalizedFile),
      POST: makePostHandler(normalizedFile),
    };
    console.log(`Registered route: ${route}`);
  }

  return routes;
}
