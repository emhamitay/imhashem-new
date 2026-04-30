import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanForClientModules } from "./scan.ts";
import { getClientModules } from "./manifest.ts";

let root = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "bunframe-scan-"));
  await mkdir(join(root, "components"), { recursive: true });
  await mkdir(join(root, "node_modules", "should-be-ignored"), { recursive: true });

  await writeFile(
    join(root, "components", "Client.tsx"),
    `// בס"ד\n"use client"\nimport {useState} from "react";\nexport function Client(){const[c,s]=useState(0);return null;}\n`,
  );
  await writeFile(
    join(root, "components", "Server.tsx"),
    `export default function S(){ return null; }\n`,
  );
  await writeFile(
    join(root, "components", "Default.tsx"),
    `"use client"\nexport default function D(){ return null; }\n`,
  );
  await writeFile(
    join(root, "node_modules", "should-be-ignored", "evil.tsx"),
    `"use client"\nexport const Evil = 1;\n`,
  );
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("scanForClientModules", () => {
  test("finds 'use client' files and skips others", async () => {
    const { clientFiles } = await scanForClientModules([root]);
    const basenames = clientFiles.map((p) => p.split("/").pop()).sort();
    expect(basenames).toEqual(["Client.tsx", "Default.tsx"]);
  });

  test("ignores files inside node_modules", async () => {
    const { clientFiles } = await scanForClientModules([root]);
    expect(clientFiles.some((p) => p.includes("/node_modules/"))).toBe(false);
  });

  test("populates the client-module registry with exports", async () => {
    await scanForClientModules([root]);
    const map = getClientModules();
    const client = [...map.entries()].find(([k]) => k.endsWith("/Client.tsx"));
    const def = [...map.entries()].find(([k]) => k.endsWith("/Default.tsx"));
    expect(client?.[1].exports).toContain("Client");
    expect(def?.[1].exports).toContain("default");
  });
});
