/**
 * runtime/single-flight.ts
 *
 * Wraps an async tick so a new call is dropped while the previous one is still
 * running. `setInterval` fires on the wall clock whether or not the last tick
 * finished, so a tick that outlasts its interval otherwise overlaps the next
 * one — and when the tick spawns CPU-heavy subprocesses, each overlap slows
 * every in-flight tick further until the process can no longer answer its
 * health probe.
 */

export interface SingleFlightOptions {
  /**
   * Called when a call is dropped because the previous one is still running.
   * Receives how long that run has been in flight, in milliseconds.
   */
  onSkip?: (inFlightMs: number) => void;
  /** Injected for tests; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Returns a function that runs `fn` unless a previous run is still in flight,
 * in which case it calls `onSkip` and resolves without running `fn`. A run
 * that rejects still releases the guard, and the rejection is passed through.
 */
export function singleFlight(
  fn: () => Promise<void>,
  options: SingleFlightOptions = {},
): () => Promise<void> {
  const now = options.now ?? Date.now;
  let startedAt: number | null = null;

  return async () => {
    if (startedAt !== null) {
      options.onSkip?.(now() - startedAt);
      return;
    }
    startedAt = now();
    try {
      await fn();
    } finally {
      startedAt = null;
    }
  };
}
