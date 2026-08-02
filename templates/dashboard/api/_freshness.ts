/**
 * Freshness of the combined `__all__` payload.
 *
 * The master tab asks for every dashboard at once, and the endpoint used to
 * answer with `generatedAt: new Date()` — the time of the request. That made
 * the header claim the data had just been generated on every page load, no
 * matter how old it actually was, while each individual tab reported its real
 * timestamp. The one view meant to summarise the workspace was the only one
 * lying about it.
 *
 * The honest answer is the newest timestamp among the dashboards being
 * returned: nothing in the payload is more recent than that.
 *
 * Underscore-prefixed so Vercel does not treat it as a serverless function.
 */

interface MaybeDated {
  generatedAt?: unknown;
}

/**
 * Newest `generatedAt` across the given dashboards, or undefined when none
 * carries one — in which case the caller should omit the field rather than
 * substitute the current time.
 */
export function newestGeneratedAt(dashboards: Record<string, unknown>): string | undefined {
  let newest: string | undefined;
  let newestMs = Number.NEGATIVE_INFINITY;

  for (const entry of Object.values(dashboards ?? {})) {
    if (typeof entry !== 'object' || entry === null) continue;
    const value = (entry as MaybeDated).generatedAt;
    if (typeof value !== 'string' || !value) continue;

    // Unparseable timestamps still beat inventing one, but a parseable value
    // always wins so ordering stays meaningful.
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) {
      if (newest === undefined) newest = value;
      continue;
    }
    if (ms > newestMs) {
      newestMs = ms;
      newest = value;
    }
  }

  return newest;
}
