/*
Webpack-flavored globals required by react-server-dom-webpack/client.browser.

This module exists separately from client.ts (and is imported BEFORE it reads
react-server-dom-webpack) because ES module imports are hoisted: any code
that lives in client.ts's body runs *after* every imported module has
initialized. react-server-dom-webpack reads __webpack_require__ at
module-init time, so the shim must be installed by an import that comes
before it.

In our manifest, both `id` and `chunkId` are the browser URL of the built
module, so a single Map keyed by URL backs both shims.
*/

declare global {
  interface Window {
    __webpack_chunk_load__: (id: string) => Promise<void>;
    __webpack_require__: (id: string) => unknown;
    __webpack_get_script_filename__: (id: string) => string;
  }
}

const moduleCache = new Map<string, unknown>();

window.__webpack_chunk_load__ = async (id: string) => {
  if (moduleCache.has(id)) return;
  const mod = await import(/* @vite-ignore */ id);
  moduleCache.set(id, mod);
};

window.__webpack_require__ = (id: string) => {
  const mod = moduleCache.get(id);
  if (mod === undefined) {
    throw new Error(`[RSC] module not loaded yet: ${id}`);
  }
  return mod;
};

// Our manifest stores the chunk's browser URL as its id, so the filename
// lookup is the identity function.
window.__webpack_get_script_filename__ = (id: string) => id;

export {};
