/**
 * Generation heartbeat — periodic liveness lines for long, non-streaming LLM
 * calls. Non-interactive callers (automation agents polling stdout/NDJSON)
 * otherwise see total silence during the generate phase and treat the process
 * as wedged. Every provider's complete() wraps its await in startHeartbeat /
 * stop so a line is emitted every few seconds while the API call is in flight.
 */

export const DEFAULT_HEARTBEAT_MS = 10_000;

/**
 * Start emitting "<label> still generating… Ns elapsed" lines to onProgress
 * every intervalMs. Returns a stop function — always call it in a finally.
 * No-op (returns a no-op stop) when onProgress is not provided.
 */
export function startHeartbeat(
  onProgress: ((line: string) => void) | undefined,
  label: string,
  intervalMs = DEFAULT_HEARTBEAT_MS,
): () => void {
  if (!onProgress) return () => {};
  const started = Date.now();
  const timer = setInterval(() => {
    const elapsed = Math.round((Date.now() - started) / 1000);
    onProgress(`  ${label} still generating… ${elapsed}s elapsed`);
  }, intervalMs);
  // Never keep the process alive just for the heartbeat.
  timer.unref?.();
  return () => clearInterval(timer);
}
