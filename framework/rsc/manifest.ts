/*
Shared state for the RSC client manifest.

The manifest is consumed by react-server-dom-webpack/server.edge during the
RSC render. Format expected by React (see ReactFlightWebpackBundlerConfig in
React source):

  manifest[moduleId] = { id, chunks, name, async }

Stub objects emitted for "use client" modules carry $$id = `${moduleId}#${exportName}`.
React strips the trailing `#name` to look up the manifest entry, then uses
`name` from the stub. This lets one manifest entry serve every export of a
module.

In our Bun-native ESM world:
  - moduleId   = absolute filesystem path of the source file
  - id         = browser URL of the built chunk (e.g. "/__bunframe/client/Counter.abc.js")
  - chunks     = [chunkId, chunkFilename]
                 We make chunkId === id so __webpack_require__ can pull from
                 the same cache key __webpack_chunk_load__ filled.
*/

export type ManifestEntry = {
  id: string;
  chunks: string[];
  name: string;
  async: boolean;
};

export type ClientManifest = Record<string, ManifestEntry>;

const clientModules = new Map<string, { exports: string[] }>();
let manifest: ClientManifest = {};

export function recordClientModule(absPath: string, exports: string[]): void {
  clientModules.set(absPath, { exports });
}

export function getClientModules(): ReadonlyMap<string, { exports: string[] }> {
  return clientModules;
}

export function setManifest(next: ClientManifest): void {
  manifest = next;
}

export function getManifest(): ClientManifest {
  return manifest;
}

export const CLIENT_REFERENCE_TAG = Symbol.for("react.client.reference");

export function buildStubSource(absPath: string, exports: string[]): string {
  // Emit one stub object per export. $$id encodes the export name so the
  // manifest only needs one entry per module.
  const lines: string[] = [
    `const TAG = Symbol.for("react.client.reference");`,
    `const MOD = ${JSON.stringify(absPath)};`,
  ];

  const exposed: string[] = [];
  for (const name of exports) {
    const localId = name === "default" ? "_default" : `_${name}`;
    lines.push(
      `const ${localId} = { $$typeof: TAG, $$id: MOD + "#" + ${JSON.stringify(name)}, $$async: false };`,
    );
    if (name === "default") {
      lines.push(`export default ${localId};`);
    } else {
      exposed.push(`${localId} as ${name}`);
    }
  }

  if (exposed.length > 0) {
    lines.push(`export { ${exposed.join(", ")} };`);
  }

  return lines.join("\n") + "\n";
}
