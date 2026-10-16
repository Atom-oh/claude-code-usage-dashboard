import { AsyncLocalStorage } from "node:async_hooks";

const context = new AsyncLocalStorage();

export class QueryDeadlineError extends Error {
  constructor() {
    super("shared query load deadline exceeded");
    this.name = "QueryDeadlineError";
  }
}

export function querySignal(external) {
  const owned = context.getStore();
  if (!owned || owned === external) return external || owned;
  return external ? AbortSignal.any([owned, external]) : owned;
}

// A factor request belongs to all subscribers, not its first caller's deadline.
export function withoutQueryContext(load) {
  return context.run(undefined, load);
}

export function createQueryDeadline(milliseconds) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 2_147_483_647)
    throw new RangeError("invalid query deadline");
  const abort = new AbortController();
  const expires = performance.now() + milliseconds;
  const reason = new QueryDeadlineError();
  const timer = setTimeout(() => abort.abort(reason), milliseconds);
  timer.unref();
  return {
    signal: abort.signal,
    run(load) { return context.run(abort.signal, load); },
    cancel(error) { abort.abort(error); },
    check() {
      // Synchronous parsing/serialization can delay the timer callback.
      if (!abort.signal.aborted && performance.now() >= expires) abort.abort(reason);
      abort.signal.throwIfAborted();
    },
    dispose() { clearTimeout(timer); },
  };
}
