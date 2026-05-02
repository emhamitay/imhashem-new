"use client";

/*
Soft-navigation link. Renders a plain <a>, but for primary clicks on the
same origin it preventDefault()s and asks the client router to swap the
React tree in-place (no document reload).

We deliberately bail on:
  - non-primary buttons (middle/right click)
  - modifier keys (cmd/ctrl/shift/alt — the user is asking the browser to
    open in a new tab / window / save the link)
  - target="_blank" / target="_top" / etc.
  - download attribute (browser-handled file save)
  - cross-origin hrefs (different host means we can't render it ourselves)
  - URLs with a hash that point at the current page (let the browser scroll)
  - if the click was already preventDefault'd by something else

For anything we don't soft-nav, the native <a> behavior runs. That means
external links and downloads work as plain HTML — `<Link>` is opt-in for
SPA navigation, not a global hijack.
*/

import { createElement, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from "react";
import { navigate } from "./client-router.ts";

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  children?: ReactNode;
};

function isExternal(href: string): boolean {
  // Bare paths (start with /, ?, #) are always same-origin.
  if (/^[/?#]/.test(href)) return false;
  try {
    const url = new URL(href, window.location.href);
    return url.origin !== window.location.origin;
  } catch {
    return false;
  }
}

export function Link(props: LinkProps): ReactNode {
  const { href, onClick, target, download, children, ...rest } = props;

  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented) return;
    if (e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (target && target !== "_self") return;
    if (download != null) return;
    if (isExternal(href)) return;

    e.preventDefault();
    navigate(href);
  };

  return createElement(
    "a",
    { ...rest, href, target, download, onClick: handleClick },
    children,
  );
}
