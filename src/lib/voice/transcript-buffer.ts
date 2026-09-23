/**
 * GPT-Live client delegation carries no task text: the app rebuilds what the
 * driver asked from `session.input_transcript.delta` fragments
 * (https://developers.openai.com/api/docs/guides/live-delegation#keep-the-conversation-context-in-your-application).
 *
 * Fragments are kept in delivery order with their session-timeline times; a
 * delegation at `offset_ms` consumes every fragment that started before it.
 * Fragments that start later belong to the next request (full duplex: the
 * driver may keep talking while the backend works).
 */

export interface TranscriptFragment {
  delta: string;
  startMs: number;
  endMs: number;
}

export class TranscriptBuffer {
  private pending: TranscriptFragment[] = [];

  add(fragment: TranscriptFragment): void {
    this.pending.push(fragment);
  }

  /** True if some unconsumed fragment started before `offsetMs`. */
  hasTextBefore(offsetMs: number): boolean {
    return this.pending.some((f) => f.startMs < offsetMs && f.delta.trim() !== "");
  }

  /** Removes and joins the fragments that started before `offsetMs`. */
  takeUntil(offsetMs: number): string {
    const taken = this.pending.filter((f) => f.startMs < offsetMs);
    this.pending = this.pending.filter((f) => f.startMs >= offsetMs);
    return normalize(taken.map((f) => f.delta).join(""));
  }

  /** Everything not yet consumed (for on-screen captions). */
  peek(): string {
    return normalize(this.pending.map((f) => f.delta).join(""));
  }

  clear(): void {
    this.pending = [];
  }
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
