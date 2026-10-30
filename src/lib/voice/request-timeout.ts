/**
 * Runs one request with a hard deadline. The deadline is enforced with a race, not only
 * with `AbortController`, so a fetch that ignores its signal still cannot hang the screen.
 * An external signal (sign out, another invite) cancels the same way. Rejects on timeout
 * or cancel; callers map every rejection to their fixed message.
 */
export const REQUEST_TIMEOUT_MS = 10_000;

export class RequestAbortedError extends Error {
  constructor() {
    super("Request aborted");
    this.name = "RequestAbortedError";
  }
}

export async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const { timeoutMs = REQUEST_TIMEOUT_MS, signal: external } = options;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onExternal: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    const stop = () => {
      controller.abort();
      reject(new RequestAbortedError());
    };
    timer = setTimeout(stop, timeoutMs);
    if (external) {
      if (external.aborted) stop();
      else {
        onExternal = stop;
        external.addEventListener("abort", stop, { once: true });
      }
    }
  });
  aborted.catch(() => undefined); // never an unhandled rejection when `run` wins
  try {
    return await Promise.race([run(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    if (external && onExternal) external.removeEventListener("abort", onExternal);
  }
}
