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
import { hasUseClient, hasUseServer } from "./directives.ts";
import { buildStubSource, recordClientModule } from "./manifest.ts";

// Match user source files only — exclude anything under node_modules so the
// plugin doesn't intercept React's deep CJS files (which Bun must auto-detect
// as CJS to extract named exports). Negative lookahead is supported by Bun's
// regex flavor.
const FILE_FILTER = /^(?!.*\/node_modules\/).*\.(?:tsx?|jsx?|mjs|cjs)$/;

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
Bun's auto-JSX runtime emits `import { jsxDEV } from "react/jsx-dev-runtime"`.
Under --conditions react-server those subpaths resolve to wrapper files that
do `module.exports = require(NODE_ENV === "production" ? prod : dev)`.

Bun's runtime plugins can't intercept onResolve for bare specifiers (only
onLoad fires, with the already-resolved disk path), and Bun's static
CJS->ESM detector can't see through the dynamic require, so named imports
of jsxDEV/jsx fail.

Fix: when Bun loads the wrapper file, replace its contents with a tiny ESM
shim that re-exports from the *deep* CJS file (whose exports.X = function()
declarations Bun reads cleanly).
*/
const REACT_DIR = `${process.cwd()}/node_modules/react`;
const isDev = process.env.NODE_ENV !== "production";
const FLAVOR = isDev ? "development" : "production";

const WRAPPER_TO_DEEP: Record<string, string> = {
  [`${REACT_DIR}/jsx-runtime.react-server.js`]:
    `${REACT_DIR}/cjs/react-jsx-runtime.react-server.${FLAVOR}.js`,
  [`${REACT_DIR}/jsx-dev-runtime.react-server.js`]:
    `${REACT_DIR}/cjs/react-jsx-dev-runtime.react-server.${FLAVOR}.js`,
};

function buildJsxShim(deepPath: string): string {
  return [
    `import * as m from ${JSON.stringify(deepPath)};`,
    `export const Fragment = m.Fragment;`,
    `export const jsx = m.jsx;`,
    `export const jsxs = m.jsxs;`,
    `export const jsxDEV = m.jsxDEV;`,
    `export default m.default ?? m;`,
  ].join("\n");
}

export const rscServerPlugin: Bun.BunPlugin = {
  name: "bunframe-rsc-server",
  setup(build) {
    build.onLoad({ filter: /\/react\/jsx(-dev)?-runtime\.react-server\.js$/ }, ({ path }) => {
      const deep = WRAPPER_TO_DEEP[path];
      if (!deep) return undefined;
      return { contents: buildJsxShim(deep), loader: "js" };
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
