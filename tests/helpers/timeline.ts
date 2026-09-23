/**
 * Shared event log used to prove concurrency (UC7): the scripted model and the
 * fake Spotify both append timestamped events. Lives on globalThis so every
 * module instance (mock factories, helpers) writes to the same array.
 */

export interface TimelineEvent {
  t: number;
  event: string;
}

const g = globalThis as { __finnTimeline?: TimelineEvent[] };
export const timeline: TimelineEvent[] = (g.__finnTimeline ??= []);

export function mark(event: string): void {
  timeline.push({ t: performance.now(), event });
}

export function resetTimeline(): void {
  timeline.length = 0;
}

/** Timestamp of the first (or last) occurrence of `event`; throws if it never happened. */
export function at(event: string, which: "first" | "last" = "first"): number {
  const hits = timeline.filter((e) => e.event === event);
  const hit = which === "first" ? hits[0] : hits.at(-1);
  if (!hit) {
    throw new Error(
      `timeline has no "${event}" event. Recorded: ${timeline.map((e) => e.event).join(", ") || "(none)"}`,
    );
  }
  return hit.t;
}
