/*
End-to-end integration test.

Spawns the real server (bun --conditions react-server server.ts), waits for
it to log that it's listening, hits the routes, and asserts on the response
shape: HTTP 200, RSC payload embedded in the HTML shell, client chunks
served, and the client manifest entry actually points to a reachable file.

Bun.spawn is used directly so we control lifecycle / cleanup precisely —
the test runner can't be relied on to kill child processes after a fail.
*/

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..");
const PORT = 3457; // off the dev port so a parallel `bun dev` doesn't clash

let proc: Bun.Subprocess | null = null;
let baseUrl = "";

async function waitForReady(p: Bun.Subprocess, timeoutMs = 20000): Promise<string> {
  const reader = p.stdout.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let buffered = "";
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const m = buffered.match(/BunFrame running at (https?:\/\/[^\s]+)/);
    if (m) {
      reader.releaseLock();
      return m[1]!.replace(/\/$/, "");
    }
  }
  reader.releaseLock();
  throw new Error(`server didn't become ready in ${timeoutMs}ms\n--- stdout ---\n${buffered}`);
}

beforeAll(async () => {
  proc = Bun.spawn({
    cmd: ["bun", "--conditions", "react-server", "server.ts"],
    cwd: PROJECT_ROOT,
    env: { ...process.env, NODE_ENV: "development", PORT: String(PORT) },
    stdout: "pipe",
    stderr: "pipe",
  });
  baseUrl = await waitForReady(proc);
});

afterAll(async () => {
  if (proc) {
    proc.kill();
    await proc.exited;
  }
});

describe("server end-to-end", () => {
  test("home route returns 200 + HTML with inline RSC payload", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain('id="__BUNFRAME_RSC__"');
    // The script src that boots the browser runtime
    expect(html).toMatch(/<script type="module" src="\/__bunframe\/client\/[^"]+">/);
    // The RSC payload should reference the Counter client module by URL
    expect(html).toMatch(/\/__bunframe\/client\/.*Counter[^"]*\.js/);
  });

  test("login route returns 200 + carries layout + page content in the RSC payload", async () => {
    const res = await fetch(`${baseUrl}/login`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Welcome to layout.layout!");
    expect(html).toContain("Welcome to the Login Page");
  });

  test("client bootstrap chunk is served", async () => {
    const home = await (await fetch(`${baseUrl}/`)).text();
    const bootstrapMatch = home.match(/<script type="module" src="(\/__bunframe\/client\/[^"]+)"/);
    expect(bootstrapMatch).not.toBeNull();
    const res = await fetch(`${baseUrl}${bootstrapMatch![1]}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    const code = await res.text();
    // The bootstrap reads the inline payload by id — straight in the entry source.
    expect(code).toContain("__BUNFRAME_RSC__");
    // Code-splitting puts rsdw's webpack-flavored shim consumer in a chunk.
    // Walk imports the bootstrap declares and confirm one of them carries it.
    const chunkMatches = [...code.matchAll(/from ?"([./][^"]+)"/g)].map((m) => m[1]!);
    let foundShimConsumer = false;
    for (const rel of chunkMatches) {
      const url = new URL(rel, `http://x${bootstrapMatch![1]!}`).pathname;
      const r = await fetch(`${baseUrl}${url}`);
      if (!r.ok) continue;
      const c = await r.text();
      if (c.includes("__webpack_chunk_load__")) {
        foundShimConsumer = true;
        break;
      }
    }
    expect(foundShimConsumer).toBe(true);
  });

  test("client component chunk referenced by RSC payload is reachable", async () => {
    const home = await (await fetch(`${baseUrl}/`)).text();
    // Pull a client-reference URL out of the RSC `I` row
    const m = home.match(/(\/__bunframe\/client\/[^"\\]+\.js)/g);
    expect(m).not.toBeNull();
    const counterUrl = m!.find((u) => /Counter/i.test(u));
    expect(counterUrl).toBeDefined();
    const res = await fetch(`${baseUrl}${counterUrl}`);
    expect(res.status).toBe(200);
    const code = await res.text();
    // The built client module should re-export Counter
    expect(code).toMatch(/export\s*\{\s*Counter\s*\}/);
  });

  test("script-text escape: payload doesn't break HTML parsing on </script>", async () => {
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();
    // Inside our payload script tag, raw `</script` would close the script
    // element prematurely. The router escapes it as `<\/script`. Confirm there
    // is no unescaped `</script` between the opener and its terminator.
    const open = html.indexOf('<script type="text/x-component"');
    expect(open).toBeGreaterThan(-1);
    const close = html.indexOf("</script>", open);
    const between = html.slice(open + 1, close);
    expect(between).not.toMatch(/<\/script/i);
  });

  test("unknown route returns 404", async () => {
    const res = await fetch(`${baseUrl}/this-route-does-not-exist`);
    expect(res.status).toBe(404);
  });

  test("Accept: text/x-component returns raw RSC payload, not HTML", async () => {
    const res = await fetch(`${baseUrl}/login`, {
      headers: { Accept: "text/x-component" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/x-component/);
    expect(res.headers.get("x-bunframe-params")).toBe("{}");
    const body = await res.text();
    expect(body).not.toMatch(/<!doctype html/i);
    expect(body).not.toContain("__BUNFRAME_RSC__");
    // Page-rendered text is in the payload (RSC encodes JSX text content)
    expect(body).toContain("Welcome to the Login Page");
  });

  test("RSC-only response carries layout content for nested routes", async () => {
    const res = await fetch(`${baseUrl}/login`, {
      headers: { Accept: "text/x-component" },
    });
    const body = await res.text();
    // Layouts are wrapped server-side and serialized into the RSC payload, so
    // the layout's text is in the soft-nav response too — confirming the
    // wrapping path doesn't accidentally diverge between the two response
    // shapes.
    expect(body).toContain("Welcome to layout.layout!");
  });
});

describe("Server Functions", () => {
  test("POST without an action id is rejected", async () => {
    const res = await fetch(`${baseUrl}/`, {
      method: "POST",
      headers: { Accept: "text/x-component", "Content-Type": "text/plain" },
      body: "[1]",
    });
    expect(res.status).toBe(400);
  });

  test("POST with malformed action id is rejected", async () => {
    const res = await fetch(`${baseUrl}/`, {
      method: "POST",
      headers: {
        Accept: "text/x-component",
        "Content-Type": "text/plain",
        "X-Bunframe-Action-Id": "no-hash-in-here",
      },
      body: "[1]",
    });
    expect(res.status).toBe(400);
  });

  test("POST with a valid action id invokes the function and returns a flight payload", async () => {
    // Use the SAME rsdw the server uses (server.edge has encodeReply too in
    // 19.x — but actually only client.edge does; we feed in a hand-rolled
    // string body that decodeReply can parse, equivalent to a minimal arg).
    // Easier: a `text/plain` body of "[\"hello from test\"]" is what
    // decodeReply sees as field "0" of a synthetic FormData, then parses as a
    // flight value. For a single string arg that's just `"hello from test"`.
    const absPath = join(PROJECT_ROOT, "app", "actions.ts");
    const id = `${absPath}#echo`;

    // Build a flight-encoded args string by hand. Easier: round-trip through
    // encodeReply (importing client.edge under the test process is fine
    // because tests don't run with --conditions react-server).
    const { encodeReply } = await import("react-server-dom-webpack/client.edge");
    const body = await encodeReply(["hello from test"]);

    const res = await fetch(`${baseUrl}/`, {
      method: "POST",
      headers: {
        Accept: "text/x-component",
        "X-Bunframe-Action-Id": encodeURIComponent(id),
        "Content-Type":
          typeof body === "string" ? "text/plain;charset=utf-8" : "multipart/form-data",
      },
      body: body as BodyInit,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/x-component/);

    // Don't try to fully decode the flight stream — the payload contains the
    // re-rendered route (with client references like Link/Counter) and would
    // need a real serverConsumerManifest. Instead, scan the raw bytes for the
    // action's return-value string. Flight encodes string values as plain
    // JSON, so the string "hello from test" appears verbatim.
    const text = await res.text();
    expect(text).toContain("hello from test");
  });

  test("POST auto-rerenders the route — response carries returnValue and root", async () => {
    const { encodeReply } = await import("react-server-dom-webpack/client.edge");
    const absPath = join(PROJECT_ROOT, "app", "actions.ts");
    const id = `${absPath}#bump`;
    const body = await encodeReply([7]);

    const res = await fetch(`${baseUrl}/`, {
      method: "POST",
      headers: {
        Accept: "text/x-component",
        "X-Bunframe-Action-Id": encodeURIComponent(id),
        "Content-Type":
          typeof body === "string" ? "text/plain;charset=utf-8" : "multipart/form-data",
      },
      body: body as BodyInit,
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    // Flight serializes the top-level object's keys as a JSON-ish header row.
    // Both returnValue (the action's number) and root (the rendered tree) must
    // appear so we know the auto-rerender shape is intact.
    expect(text).toContain("returnValue");
    expect(text).toContain("root");
    // The rendered tree should include identifiable text from the home page.
    expect(text).toContain("BunFrame");
  });

  test("server-fn module is bundled as a stub in the browser graph", async () => {
    // Find the actions.ts chunk in the build outputs by walking what the home
    // page's RSC payload references and what the bootstrap imports. The stub
    // must contain createServerReference and must NOT contain the action body.
    const home = await (await fetch(`${baseUrl}/`)).text();
    const bootstrapMatch = home.match(/<script type="module" src="(\/__bunframe\/client\/[^"]+)"/);
    const bootstrap = await (await fetch(`${baseUrl}${bootstrapMatch![1]}`)).text();
    const chunkRels = [...bootstrap.matchAll(/from ?"([./][^"]+)"/g)].map((m) => m[1]!);
    // Also probe the directly-served entry-point output for actions.ts.
    const candidates = new Set<string>();
    for (const rel of chunkRels) {
      const url = new URL(rel, `http://x${bootstrapMatch![1]!}`).pathname;
      candidates.add(url);
    }
    candidates.add("/__bunframe/client/app/actions.js");

    let stubFound = false;
    let leaked = false;
    for (const url of candidates) {
      const r = await fetch(`${baseUrl}${url}`);
      if (!r.ok) continue;
      const code = await r.text();
      if (
        code.includes("createServerReference") &&
        code.includes("/app/actions.ts")
      ) {
        stubFound = true;
      }
      // Real action body (the in-process counter `let counter = 0`) must not
      // leak into the browser bundle.
      if (/let\s+counter\s*=\s*0/.test(code)) leaked = true;
    }
    expect(stubFound).toBe(true);
    expect(leaked).toBe(false);
  });
});
