import type { Store } from "../db/store.ts";
interface Pool {
  used: number;
  queue: { count: number; start: () => void }[];
}
const pools = new WeakMap<Store, Pool>();
/** Keep device slots until the real owned research finishes, including work
 * whose caller timed out. A second tool call cannot multiply concurrency. */
export async function withResearchCapacity<T>(
  store: Store,
  count: number,
  fn: () => Promise<T>,
): Promise<T> {
  if (count < 1 || count > 2) throw new Error("Research concurrency must be 1..2");
  let pool = pools.get(store);
  if (!pool) {
    pool = { used: 0, queue: [] };
    pools.set(store, pool);
  }
  const current = pool;
  if (current.used + count > 2 || current.queue.length)
    await new Promise<void>((resolve) =>
      current.queue.push({
        count,
        start: () => {
          current.used += count;
          resolve();
        },
      }),
    );
  else current.used += count;
  try {
    return await fn();
  } finally {
    current.used -= count;
    while (current.queue[0] && current.used + current.queue[0].count <= 2)
      current.queue.shift()!.start();
  }
}
