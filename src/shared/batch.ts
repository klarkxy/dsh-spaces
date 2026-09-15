export interface BatchResult<T> {
  succeeded: T[];
  failed?: { item: T; error: string };
  skipped: T[];
}

/** Run items in order. The first failure ends the batch; later items are not run. */
export async function runBatch<T>(
  items: readonly T[],
  run: (item: T) => Promise<void>,
): Promise<BatchResult<T>> {
  const succeeded: T[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    try {
      await run(item);
      succeeded.push(item);
    } catch (error) {
      return {
        succeeded,
        failed: { item, error: error instanceof Error ? error.message : String(error) },
        skipped: items.slice(i + 1),
      };
    }
  }
  return { succeeded, skipped: [] };
}
