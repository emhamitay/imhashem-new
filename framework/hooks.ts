"use client";

/*
useParams is a client-only hook. It reads the inlined params global the
router writes into the HTML shell. Server Components don't use it — they
receive `params` as a prop directly from the router (the RSC convention).
*/

export function useParams(): Record<string, string> {
  if (typeof window !== "undefined") {
    return ((window as any).__PARAMS__ ?? {}) as Record<string, string>;
  }
  return {};
}
