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
    // Sanity checks that the bootstrap actually contains the RSC client wiring
    expect(code).toContain("__BUNFRAME_RSC__");
    expect(code).toContain("__webpack_chunk_load__");
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
