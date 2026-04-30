/*
Bun runtime plugin for RSC.

Registered globally via Bun.plugin() at server startup. Intercepts every
.ts/.tsx/.js/.jsx import and:

  - if the file starts with a "use client" directive (after comments), it is
    replaced with a stub module that exports client-reference objects. The
    React server renderer recognizes these by their $$typeof symbol and emits
    them as client references in the RSC payload — the real component code
    never runs on the server.

  - "use server" detection is wired up but the runtime piece (registering
    server-function endpoints) is intentionally left for a follow-up. Files
    with "use server" pass through unchanged for now.

Export discovery uses Bun.Transpiler.scan() — handles default + named exports,
re-exports, TS/JSX, renamed exports, all without a regex.
*/

import { plugin } from "bun";
import { dirname, resolve as pathResolve } from "node:path";
import { hasUseClient, hasUseServer } from "./directives.ts";
import { buildStubSource, recordClientModule } from "./manifest.ts";

// Match user source files only — exclude anything under node_modules so the
// plugin doesn't intercept React's deep CJS files (which Bun must auto-detect
// as CJS to extract named exports). Negative lookahead is supported by Bun's
// regex flavor.
// Path separators are normalized to forward-or-backslash matches so this works
// on both POSIX and Windows (Bun passes native paths to onLoad filters).
const FILE_FILTER = /^(?!.*[\/\\]node_modules[\/\\]).*\.(?:tsx?|jsx?|mjs|cjs)$/;

const transpilers: Record<string, Bun.Transpiler> = {
  tsx: new Bun.Transpiler({ loader: "tsx" }),
  ts: new Bun.Transpiler({ loader: "ts" }),
  jsx: new Bun.Transpiler({ loader: "jsx" }),
  js: new Bun.Transpiler({ loader: "js" }),
  mjs: new Bun.Transpiler({ loader: "js" }),
  cjs: new Bun.Transpiler({ loader: "js" }),
};

function transpilerFor(path: string): Bun.Transpiler {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return transpilers[ext] ?? transpilers.tsx!;
}

function extractExports(source: string, path: string): string[] {
  const t = transpilerFor(path);
  const { exports } = t.scan(source);
  return exports;
}

/*
Bun's auto-JSX runtime emits `import { jsxDEV } from "react/jsx-dev-runtime"`
under NODE_ENV=development, and `import { jsx } from "react/jsx-runtime"` under
NODE_ENV=production. There is no Bun.Transpiler option to flip that off — the
choice is hard-wired to NODE_ENV. So we can't avoid the import, only fix the
target.

Under --conditions react-server those subpaths resolve to wrapper files that
do `module.exports = require(NODE_ENV === "production" ? prod : dev)`. Bun's
runtime plugins can't intercept onResolve for bare specifiers (only onLoad
fires, with the resolved disk path), and Bun's static CJS->ESM detector can't
see through a dynamic require — so named imports of jsxDEV/jsx fail with
"Export named 'jsxDEV' not found".

Fix: when Bun loads the wrapper, parse its own `require('./cjs/...')` calls
to discover the deep CJS file, then return an ESM shim that re-exports from
that deep file (whose `exports.X = function()` declarations Bun reads cleanly).

We deliberately do NOT hardcode the React directory or the deep filenames:
the wrapper tells us where to look. That keeps this working across React
upgrades, monorepos, and hoisted node_modules.
*/

const JSX_WRAPPER_FILTER = /[\/\\]react[\/\\]jsx(?:-dev)?-runtime\.react-server\.js$/;
const REQUIRE_PATH_RE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;

function pickDeepPath(wrapperPath: string, wrapperSource: string): string | undefined {
  const wrapperDir = dirname(wrapperPath);
  const wantProd = process.env.NODE_ENV === "production";
  const candidates: string[] = [];
  for (const m of wrapperSource.matchAll(REQUIRE_PATH_RE)) {
    candidates.push(pathResolve(wrapperDir, m[1]!));
  }
  if (candidates.length === 0) return undefined;

  // Wrapper layout is always `if (NODE_ENV === 'production') require(prod) else require(dev)`.
  // Pick by filename hint, fall back to first/last on layout drift.
  const byFlavor = candidates.find((p) =>
    wantProd ? /\.production(?:\.min)?\.js$/.test(p) : /\.development\.js$/.test(p),
  );
  if (byFlavor) return byFlavor;
  return wantProd ? candidates[candidates.length - 1] : candidates[0];
}

function buildJsxShim(deepPath: string, deepSource: string): string {
  // Discover the actual export names from the deep file so we don't drop new
  // names (e.g. a future jsxProd, Profiler) on a React upgrade.
  const names = new Set<string>();
  for (const m of deepSource.matchAll(/^\s*exports\.([A-Za-z_$][\w$]*)\s*=/gm)) {
    names.add(m[1]!);
  }
  // Always expose the canonical four even if the regex missed one — they're
  // load-bearing for the JSX runtime.
  for (const k of ["Fragment", "jsx", "jsxs", "jsxDEV"]) names.add(k);

  const lines = [`import * as m from ${JSON.stringify(deepPath)};`];
  for (const n of names) lines.push(`export const ${n} = m.${n};`);
  lines.push(`export default m.default ?? m;`);
  return lines.join("\n");
}

export const rscServerPlugin: Bun.BunPlugin = {
  name: "bunframe-rsc-server",
  setup(build) {
    build.onLoad({ filter: JSX_WRAPPER_FILTER }, async ({ path }) => {
      const wrapperSource = await Bun.file(path).text();
      const deep = pickDeepPath(path, wrapperSource);
      if (!deep) return undefined;
      const deepSource = await Bun.file(deep).text();
      return { contents: buildJsxShim(deep, deepSource), loader: "js" };
    });

    build.onLoad({ filter: FILE_FILTER }, async ({ path, loader }) => {
      const source = await Bun.file(path).text();

      if (hasUseClient(source)) {
        const exports = extractExports(source, path);
        recordClientModule(path, exports);
        return {
          contents: buildStubSource(path, exports),
          loader: "js",
        };
      }

      if (hasUseServer(source)) {
        // Reserved for the upcoming server-functions pass. For now, leave the
        // module untouched — server code will still execute correctly when
        // imported from another server module. The transform that turns each
        // export into a POST endpoint will live here.
      }

      return { contents: source, loader };
    });
  },
};

let registered = false;
export function registerRscServerPlugin(): void {
  if (registered) return;
  registered = true;
  plugin(rscServerPlugin);
}
