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
  ssrUrl?: string;
  ssrModuleMap?: Record<string, Record<string, { id: string; chunks: string[]; name: string }>>;
};

let bootstrapUrl = "";
let ssrUrl: string | undefined;
let ssrModuleMap: Record<string, Record<string, { id: string; chunks: string[]; name: string }>> | undefined;

export function setRouterConfig(cfg: RouterConfig): void {
  bootstrapUrl = cfg.bootstrapUrl;
  ssrUrl = cfg.ssrUrl;
  ssrModuleMap = cfg.ssrModuleMap;
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

function readActionId(req: Request): string | null {
  const raw = req.headers.get("X-Bunframe-Action-Id");
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/*
Send the RSC payload bytes to the SSR subprocess and return the prerendered
HTML as a ReadableStream, or null if SSR is unavailable or fails.

We take the already-collected RSC payload string (not a stream) to avoid a
Bun tee() + streaming-fetch-body race: tee'd branches of a sync RSC stream
can deliver an AbortError to the SSR worker before all bytes are consumed.
Buffering the payload first is safe — streamToString already ran before we
get here.
*/
async function fetchSSRStream(
  rscPayload: string,
): Promise<ReadableStream<Uint8Array> | null> {
  if (!ssrUrl || !ssrModuleMap) return null;
  try {
    const res = await fetch(ssrUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-SSR-Manifest": JSON.stringify(ssrModuleMap),
      },
      body: enc.encode(rscPayload),
    });
    return res.ok && res.body ? res.body : null;
  } catch {
    return null;
  }
}

const enc = new TextEncoder();

/*
Build a streaming HTML response. Emits head + <div id="root"> immediately
(low TTFB), awaits the RSC payload, sends it to the SSR worker, pipes the
SSR HTML stream into root, then closes the tag and appends the RSC payload
script + footer.
*/
function buildHtmlStream(
  params: Record<string, string>,
  rscPayloadPromise: Promise<string>,
): ReadableStream<Uint8Array> {
  const head =
    `<!DOCTYPE html>\n<html lang="en">\n<head>\n` +
    `<meta charset="UTF-8" />\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1.0" />\n` +
    `<title>BunFrame</title>\n` +
    `</head>\n<body>\n<div id="root">`;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(enc.encode(head));

      const rscPayload = await rscPayloadPromise;
      const ssrStream = await fetchSSRStream(rscPayload);
      if (ssrStream) {
        const reader = ssrStream.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      }

      const footer =
        `</div>\n` +
        `<script type="text/x-component" id="__BUNFRAME_RSC__">${escapeScriptText(rscPayload)}</script>\n` +
        `<script>window.__PARAMS__=${JSON.stringify(params)};${WEBPACK_SHIMS_INLINE}</script>\n` +
        `<script type="module" src="${bootstrapUrl}"></script>\n` +
        `</body>\n</html>`;
      controller.enqueue(enc.encode(footer));
      controller.close();
    },
  });
}

/*
GET handler. Renders the route to RSC, then returns either the raw stream
(soft-nav) or an HTML shell with the payload embedded (initial load).

For initial HTML loads, we tee() the RSC stream: one branch is collected as
the inline payload string; the other is streamed to the SSR subprocess which
renders server components to HTML. Both run concurrently. If SSR fails the
response falls back to an empty <div id="root">.
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

    const rscPayloadPromise = streamToString(rscStream);
    const htmlStream = buildHtmlStream(params, rscPayloadPromise);
    return new Response(htmlStream, {
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
    const actionId = readActionId(req);
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
    const rscPayloadPromise = streamToString(rscStream);
    const htmlStream = buildHtmlStream(params, rscPayloadPromise);
    return new Response(htmlStream, {
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
