// A failed overview has no consumer for its remaining private queries.
// This signal belongs to one shared cache load, never to one HTTP subscriber.
export async function clientQueryBatch(tasks) {
  const abort = new AbortController();
  const pending = tasks.map(task => Promise.resolve().then(() => task(abort.signal)));
  try {
    return await Promise.all(pending);
  } catch (error) {
    abort.abort();
    await Promise.allSettled(pending);
    throw error;
  }
}
