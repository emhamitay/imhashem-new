import { describe, expect, test } from "bun:test";
import { findDirectives, hasUseClient, hasUseServer } from "./directives.ts";

describe("directive scanner", () => {
  test("plain use client", () => {
    expect(hasUseClient(`"use client"\nexport const x = 1;`)).toBe(true);
  });

  test("single quotes", () => {
    expect(hasUseClient(`'use client'\nexport const x = 1;`)).toBe(true);
  });

  test("line comment with Hebrew before directive", () => {
    expect(hasUseClient(`// בס"ד\n"use client"\nexport const x = 1;`)).toBe(true);
  });

  test("block comment with embedded quotes", () => {
    const src = `/* בס"ד\nבעה"י\nאי"ב */\n"use client"\nexport const x = 1;`;
    expect(hasUseClient(src)).toBe(true);
  });

  test("multiple stacked comments", () => {
    expect(hasUseClient(`// a\n// b\n/* c */\n"use client"`)).toBe(true);
  });

  test("BOM before directive", () => {
    expect(hasUseClient(`﻿"use client"`)).toBe(true);
  });

  test("use strict before use client (multi-directive prologue)", () => {
    expect(hasUseClient(`"use strict"\n"use client"\nexport const x = 1;`)).toBe(true);
    expect(findDirectives(`"use strict"\n"use client"`)).toEqual(
      new Set(["use strict", "use client"]),
    );
  });

  test("trailing semicolons + comments between directives", () => {
    const src = `"use strict"; // a\n/* b */\n"use client";`;
    expect(hasUseClient(src)).toBe(true);
  });

  test("directive AFTER an import is not a directive", () => {
    expect(hasUseClient(`import x from "y"\n"use client"`)).toBe(false);
  });

  test("string literal containing 'use client' inside an expression", () => {
    expect(hasUseClient(`const x = "use client"; export const a = 1;`)).toBe(false);
  });

  test("JSX after directive is fine", () => {
    expect(hasUseClient(`"use client"\nexport const x = <div/>;`)).toBe(true);
  });

  test("empty file", () => {
    expect(hasUseClient(``)).toBe(false);
  });

  test("comment-only file", () => {
    expect(hasUseClient(`// hi`)).toBe(false);
  });

  test("CRLF line endings", () => {
    expect(hasUseClient(`// hi\r\n"use client"\r\nexport const x = 1;`)).toBe(true);
  });

  test("use server detected the same way", () => {
    expect(hasUseServer(`/* note */\n"use server"\nexport async function f(){}`)).toBe(true);
    expect(hasUseServer(`"use client"\nexport const x = 1;`)).toBe(false);
  });

  test("nested block comment-like sequences in strings dont break scan", () => {
    // a directive followed by a string that contains '*/' should still parse.
    expect(hasUseClient(`"use client"\nconst x = "*/";`)).toBe(true);
  });

  test("escaped quote inside directive string still terminates correctly", () => {
    // "use \"client" is NOT 'use client' — it's literally `use "client`.
    expect(hasUseClient(`"use \\"client"\nexport const x = 1;`)).toBe(false);
  });

  test("unterminated string literal does not crash", () => {
    expect(() => hasUseClient(`"use client`)).not.toThrow();
    expect(hasUseClient(`"use client`)).toBe(false);
  });
});
