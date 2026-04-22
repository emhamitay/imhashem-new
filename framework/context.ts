import { AsyncLocalStorage } from "async_hooks"

const paramsStorage = new AsyncLocalStorage<Record<string, string>>()

export function runWithParams<T>(
  params: Record<string, string>,
  fn: () => Promise<T>
): Promise<T> {
  return paramsStorage.run(params, fn)
}

export function getParams<T = Record<string, string>>(): T {
  return (paramsStorage.getStore() ?? {}) as T
}