import { describe, expect, test } from "bun:test";
import {
  buildStubSource,
  CLIENT_REFERENCE_TAG,
  recordClientModule,
  getClientModules,
  setManifest,
  getManifest,
} from "./manifest.ts";

describe("buildStubSource", () => {
  test("named export becomes a client-reference object", async () => {
    const src = buildStubSource("/abs/Counter.tsx", ["Counter"]);
    // Evaluate the generated module via a data: URL so we can inspect runtime behavior.
    const url = "data:text/javascript;base64," + Buffer.from(src).toString("base64");
    const mod = await import(url);
    expect(mod.Counter).toBeDefined();
    expect(mod.Counter.$$typeof).toBe(CLIENT_REFERENCE_TAG);
    expect(mod.Counter.$$id).toBe("/abs/Counter.tsx#Counter");
    expect(mod.Counter.$$async).toBe(false);
  });

  test("default export emits an export default", async () => {
    const src = buildStubSource("/abs/X.tsx", ["default"]);
    const url = "data:text/javascript;base64," + Buffer.from(src).toString("base64");
    const mod = await import(url);
    expect(mod.default).toBeDefined();
    expect(mod.default.$$typeof).toBe(CLIENT_REFERENCE_TAG);
    expect(mod.default.$$id).toBe("/abs/X.tsx#default");
  });

  test("default + named exports together", async () => {
    const src = buildStubSource("/abs/Y.tsx", ["default", "named"]);
    const url = "data:text/javascript;base64," + Buffer.from(src).toString("base64");
    const mod = await import(url);
    expect(mod.default.$$id).toBe("/abs/Y.tsx#default");
    expect(mod.named.$$id).toBe("/abs/Y.tsx#named");
  });

  test("$$id encoding survives module paths with hashes/spaces", () => {
    const src = buildStubSource("/abs/with space/Foo.tsx", ["A"]);
    expect(src).toContain(JSON.stringify("/abs/with space/Foo.tsx"));
    expect(src).toContain(`+ "#" + ${JSON.stringify("A")}`);
  });
});

describe("client-module registry", () => {
  test("recordClientModule populates getClientModules", () => {
    recordClientModule("/abs/A.tsx", ["A", "default"]);
    const map = getClientModules();
    expect(map.get("/abs/A.tsx")?.exports).toEqual(["A", "default"]);
  });
});

describe("manifest set/get", () => {
  test("round-trips", () => {
    const m = {
      "/abs/A.tsx": {
        id: "/__bunframe/client/A.js",
        chunks: ["/__bunframe/client/A.js", "/__bunframe/client/A.js"],
        name: "A",
        async: false,
      },
    };
    setManifest(m);
    expect(getManifest()).toBe(m);
  });
});
