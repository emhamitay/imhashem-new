import { createContext, createElement, useContext, type ReactNode } from "react";

const ParamsContext = createContext<Record<string, string> | null>(null);

type RouteParamsProviderProps = {
  params: Record<string, string>;
  children?: ReactNode;
};

export function RouteParamsProvider({
  params,
  children,
}: RouteParamsProviderProps) {
  return createElement(ParamsContext.Provider, { value: params }, children);
}

/**
 * useParams() works on both server and client:
 * - Server: reads from RouteParamsProvider (set by the router)
 * - Client: falls back to window.__PARAMS__ (injected into the HTML)
 */
export function useParams<T = Record<string, string>>(): T {
  const contextParams = useContext(ParamsContext);
  if (contextParams) {
    return contextParams as T;
  }

  if (typeof window !== "undefined") {
    return ((window as any).__PARAMS__ ?? {}) as T;
  }

  return {} as T;
}