import { logger } from "../logger.ts";

const queues = new Map<string, Promise<void>>();
const queueDepth = new Map<string, number>();

// A single task with no bound (a hung network call, a wedged DB connection) would
// otherwise jam this topic's queue forever: every later message, voice or text,
// piles up silently behind it with no error, until the process restarts. Cap it
// so one stuck task can only ever block its topic for this long.
const TASK_TIMEOUT_MS = 5 * 60_000;

/**
 * Race a queued task against timeoutMs so a hang can only ever block its topic
 * for that long. This only stops the QUEUE from waiting on the task — if the
 * task does eventually settle on its own, that happens in the background.
 * timeoutMs is a parameter (not read from TASK_TIMEOUT_MS directly) so tests
 * can exercise the timeout path without waiting out the real 5 minutes.
 */
export function runWithTimeout(task: () => Promise<void>, key: string, timeoutMs = TASK_TIMEOUT_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`topic queue task exceeded ${timeoutMs}ms for ${key}`)),
      timeoutMs,
    );
  });
  return Promise.race([task(), timeout]).finally(() => clearTimeout(timer));
}

/** Returns the number of tasks currently waiting (depth >= 1 means at least one running). */
export function getQueueDepth(key: string): number {
  return queueDepth.get(key) ?? 0;
}

/**
 * Enqueue a task for a specific topic key.
 * Tasks for the same key run sequentially; different keys run in parallel.
 * If onQueued is provided and there are already tasks waiting, it is called
 * immediately with the position in queue (1 = one task ahead, etc.).
 */
export function enqueueForTopic(
  key: string,
  task: () => Promise<void>,
  onQueued?: (position: number) => void,
): void {
  const depth = (queueDepth.get(key) ?? 0) + 1;
  queueDepth.set(key, depth);
  if (depth > 1 && onQueued) onQueued(depth - 1);

  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev
    .then(() => runWithTimeout(task, key))
    .catch((err) => logger.error({ err, key }, "topic queue task failed"))
    .finally(() => {
      const d = (queueDepth.get(key) ?? 1) - 1;
      if (d <= 0) queueDepth.delete(key);
      else queueDepth.set(key, d);
    });
  queues.set(key, next);
  next.finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
}

/**
 * Compute the queue key: "chatId:topicId" for forum messages, "chatId" for DMs.
 */
export function topicQueueKey(chatId: string, forumTopicId?: number | null): string {
  return forumTopicId ? `${chatId}:${forumTopicId}` : chatId;
}
