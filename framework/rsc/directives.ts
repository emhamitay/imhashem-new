/*
Directive prologue scanner.

Per ECMAScript: a "directive prologue" is a sequence of expression-statements
whose expressions are single string literals, appearing at the very top of a
module/function body. The prologue ends at the first statement that is NOT a
string-literal expression.

Whitespace, line comments (//...), and block comments (...) may appear
between directives. We must skip them when looking for "use client" /
"use server" so that files like:

  // בס"ד
  "use client"

or

  /* בס"ד
     בעה"י
  *\/
  "use strict"
  "use client"

are detected correctly.
*/

const enum CC {
  BOM = 0xfeff,
  TAB = 0x09,
  LF = 0x0a,
  CR = 0x0d,
  SPACE = 0x20,
  NBSP = 0xa0,
  DQUOTE = 0x22,
  SQUOTE = 0x27,
  STAR = 0x2a,
  SLASH = 0x2f,
  SEMI = 0x3b,
  BACKSLASH = 0x5c,
}

function isWhitespace(c: number): boolean {
  return c === CC.SPACE || c === CC.TAB || c === CC.LF || c === CC.CR || c === CC.NBSP;
}

export function findDirectives(src: string): Set<string> {
  const directives = new Set<string>();
  let i = 0;

  if (src.charCodeAt(0) === CC.BOM) i = 1;

  while (i < src.length) {
    const c = src.charCodeAt(i);

    if (isWhitespace(c)) {
      i++;
      continue;
    }

    // line comment
    if (c === CC.SLASH && src.charCodeAt(i + 1) === CC.SLASH) {
      i += 2;
      while (i < src.length && src.charCodeAt(i) !== CC.LF) i++;
      continue;
    }

    // block comment
    if (c === CC.SLASH && src.charCodeAt(i + 1) === CC.STAR) {
      i += 2;
      while (i < src.length) {
        if (src.charCodeAt(i) === CC.STAR && src.charCodeAt(i + 1) === CC.SLASH) {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }

    // string literal: candidate directive
    if (c === CC.DQUOTE || c === CC.SQUOTE) {
      const quote = c;
      const start = i + 1;
      i++;
      let closed = false;
      while (i < src.length) {
        const ch = src.charCodeAt(i);
        if (ch === CC.BACKSLASH) {
          i += 2;
          continue;
        }
        if (ch === CC.LF || ch === CC.CR) break; // unterminated on this line
        if (ch === quote) {
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) return directives;
      directives.add(src.slice(start, i));
      i++; // past closing quote

      // skip the rest of the statement (optional `;` and trailing whitespace/comments)
      // until we either reach the start of the next prologue candidate or bail.
      while (i < src.length) {
        const ch = src.charCodeAt(i);
        if (ch === CC.SEMI || isWhitespace(ch)) {
          i++;
          continue;
        }
        if (ch === CC.SLASH && src.charCodeAt(i + 1) === CC.SLASH) {
          i += 2;
          while (i < src.length && src.charCodeAt(i) !== CC.LF) i++;
          continue;
        }
        if (ch === CC.SLASH && src.charCodeAt(i + 1) === CC.STAR) {
          i += 2;
          while (i < src.length) {
            if (src.charCodeAt(i) === CC.STAR && src.charCodeAt(i + 1) === CC.SLASH) {
              i += 2;
              break;
            }
            i++;
          }
          continue;
        }
        break;
      }
      continue;
    }

    // anything else: end of the directive prologue
    return directives;
  }

  return directives;
}

export function hasUseClient(src: string): boolean {
  return findDirectives(src).has("use client");
}

export function hasUseServer(src: string): boolean {
  return findDirectives(src).has("use server");
}
