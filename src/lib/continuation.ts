/**
 * Bounds for a `continuation` coming from a client (/api/orchestrator body, A2A data part).
 * It is NOT signed: it carries no authority of its own (the driverId always comes from the server),
 * so the defence is size plus a strict parser inside each agent (closed list, unknown ignored).
 */
export const MAX_CONTINUATION_BYTES = 2048;

/** The value when it is JSON-serializable and at most 2 KB serialized; otherwise undefined (ignored). */
export function boundedContinuation<T>(value: T): T | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    const text = JSON.stringify(value);
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_CONTINUATION_BYTES) return undefined;
  } catch {
    return undefined;
  }
  return value;
}
