// A failed overview has no consumer for its remaining private queries.
// This signal belongs to one shared cache load, never to one HTTP subscriber.
export async function clientQueryBatch(tasks) {
  const abort = new AbortController();
  const results = new Array(tasks.length);
  let next = 0, failed = false, original;
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
  await Promise.all(Array.from({ length: Math.min(2, tasks.length) }, worker));
  if (failed) throw original;
  return results;
}
