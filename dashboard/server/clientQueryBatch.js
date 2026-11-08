// A failed overview has no consumer for its remaining private queries.
// A shared cache load has no subscriber signal. A private, uncached analysis
// invocation may pass its own signal; it cannot cancel a shared cache load.
export async function clientQueryBatch(tasks, externalSignal) {
  externalSignal?.throwIfAborted();
  const abort = new AbortController();
  const results = new Array(tasks.length);
  let next = 0, failed = false, original;
  const onAbort = () => {
    if (!failed) { failed = true; original = externalSignal.reason; }
    abort.abort(externalSignal.reason);
  };
  externalSignal?.addEventListener("abort", onAbort, { once: true });
  // At most two private queries per overview enter the shared DB budget at once.
  // Keep result order and stop unstarted work after the first failure.
  const worker = async () => {
    while (!failed && next < tasks.length) {
      const index = next++;
      try { results[index] = await tasks[index](abort.signal); }
      catch (error) {
        if (!failed) {
          failed = true;
          original = error;
          abort.abort(error);
        }
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(2, tasks.length) }, worker));
  } finally {
    externalSignal?.removeEventListener("abort", onAbort);
  }
  if (failed) throw original;
  return results;
}
