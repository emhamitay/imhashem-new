import { describe, expect, test, beforeAll } from "bun:test";
import {
  buildBrowserStubSource,
  buildServerWrapperAppendix,
  installServerWebpackShims,
  parseFnId,
  recordServerModule,
  getServerModules,
  serverFnId,
  setCallServerPath,
  setServerManifest,
  getServerManifest,
} from "./server-fn.ts";

describe("serverFnId / parseFnId", () => {
  test("round-trip a simple case", () => {
    const id = serverFnId("/abs/actions.ts", "bump");
    expect(id).toBe("/abs/actions.ts#bump");
    expect(parseFnId(id)).toEqual({ absPath: "/abs/actions.ts", exportName: "bump" });
  });

  test("handles paths that themselves contain '#' by splitting on the LAST one", () => {
    const id = serverFnId("/abs/wei#rd/actions.ts", "doIt");
    expect(parseFnId(id)).toEqual({
      absPath: "/abs/wei#rd/actions.ts",
      exportName: "doIt",
    });
  });

  test("missing '#' yields null (not a server-fn id)", () => {
    expect(parseFnId("just-a-path")).toBeNull();
  });
});

describe("buildBrowserStubSource", () => {
  beforeAll(() => {
    setCallServerPath("/abs/framework/rsc/call-server.ts");
  });

  test("emits createServerReference per named export", () => {
    const src = buildBrowserStubSource("/abs/actions.ts", ["bump", "echo"]);
    expect(src).toContain('import { createServerReference } from "react-server-dom-webpack/client.browser"');
    expect(src).toContain('import { callServer } from "/abs/framework/rsc/call-server.ts"');
    expect(src).toContain('MOD + "#" + "bump"');
    expect(src).toContain('MOD + "#" + "echo"');
    expect(src).toContain("export { _bump as bump, _echo as echo }");
  });

  test("default exports are skipped (documented v1 limitation)", () => {
    const src = buildBrowserStubSource("/abs/x.ts", ["default", "named"]);
    expect(src).not.toMatch(/_default/);
    expect(src).toContain("_named");
  });

  test("module path is preserved verbatim in MOD", () => {
    const src = buildBrowserStubSource("/abs/with space/a.ts", ["x"]);
    expect(src).toContain(JSON.stringify("/abs/with space/a.ts"));
  });
});

describe("buildServerWrapperAppendix", () => {
  test("emits one register call per named export, guarded by typeof", () => {
    const src = buildServerWrapperAppendix("/abs/a.ts", ["one", "two"]);
    expect(src).toContain('from "react-server-dom-webpack/server.edge"');
    expect(src).toContain('typeof one === "function"');
    expect(src).toContain('typeof two === "function"');
    expect(src).toContain('"/abs/a.ts"');
  });

  test("default exports are skipped", () => {
    const src = buildServerWrapperAppendix("/abs/a.ts", ["default", "named"]);
    expect(src).not.toContain('"default"');
    expect(src).toContain('"named"');
  });
});

describe("installServerWebpackShims", () => {
  test("populates __webpack_require__ and __webpack_chunk_load__ on globalThis", async () => {
    installServerWebpackShims();
    const g = globalThis as Record<string, unknown>;
    expect(typeof g.__webpack_require__).toBe("function");
    expect(typeof g.__webpack_chunk_load__).toBe("function");
  });

  test("__webpack_require__ throws if module not preloaded", () => {
    installServerWebpackShims();
    const g = globalThis as Record<string, (id: string) => unknown>;
    expect(() => g.__webpack_require__!("/never/loaded.ts")).toThrow();
  });
});

describe("server-module registry / manifest", () => {
  test("recordServerModule + getServerModules round-trip", () => {
    recordServerModule("/abs/actions.ts", ["bump"]);
    expect(getServerModules().get("/abs/actions.ts")?.exports).toEqual(["bump"]);
  });

  test("setServerManifest / getServerManifest round-trip", () => {
    const m = {
      "/abs/actions.ts": {
        id: "/abs/actions.ts",
        chunks: ["/abs/actions.ts", "/abs/actions.ts"],
        name: "bump",
        async: false,
      },
    };
    setServerManifest(m);
    expect(getServerManifest()).toBe(m);
  });
});
