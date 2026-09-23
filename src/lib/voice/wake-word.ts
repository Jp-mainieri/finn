import {
  PICOVOICE_ACCESS_KEY,
  PORCUPINE_KEYWORD_PATH,
  PORCUPINE_MODEL_PATH,
  PORCUPINE_MODEL_VERSION,
  PORCUPINE_SENSITIVITY,
  WAKE_WORD_LABEL,
} from "./config";

/**
 * "Finn" wake word with Porcupine (on-device WASM, no network per detection).
 * API per the @picovoice/porcupine-web v4 README:
 * https://github.com/Picovoice/porcupine/tree/master/binding/web
 * `PorcupineWorker.create(accessKey, [keyword], callback, model)` then
 * `process(Int16Array)` with 16 kHz frames of `frameLength` samples, which
 * AudioIO produces from the shared mic stream.
 *
 * The engine (~3.7 MB incl. WASM) is imported lazily and only when the key and
 * both model files exist, so a missing setup costs nothing and the tap-to-talk
 * button keeps working.
 */

export type WakeWordUnavailableReason = "no-access-key" | "missing-files" | "init-failed" | "unsupported";

export type WakeWordStatus =
  | { available: true }
  | { available: false; reason: WakeWordUnavailableReason; detail?: string };

export interface WakeWordDetector {
  readonly frameLength: number;
  process(frame: Int16Array): void;
  release(): Promise<void>;
}

export async function createWakeWordDetector(
  onWake: () => void,
): Promise<{ detector: WakeWordDetector | null; status: WakeWordStatus }> {
  if (!PICOVOICE_ACCESS_KEY) return unavailable("no-access-key");
  if (typeof WebAssembly === "undefined" || typeof Worker === "undefined") return unavailable("unsupported");

  const missing = await missingFiles([PORCUPINE_KEYWORD_PATH, PORCUPINE_MODEL_PATH]);
  if (missing.length) return unavailable("missing-files", missing.join(", "));

  try {
    const { PorcupineWorker } = await import("@picovoice/porcupine-web");
    const worker = await PorcupineWorker.create(
      PICOVOICE_ACCESS_KEY,
      [
        {
          publicPath: PORCUPINE_KEYWORD_PATH,
          label: WAKE_WORD_LABEL,
          sensitivity: PORCUPINE_SENSITIVITY,
          customWritePath: "finn_keyword",
          version: PORCUPINE_MODEL_VERSION,
        },
      ],
      () => onWake(),
      {
        publicPath: PORCUPINE_MODEL_PATH,
        customWritePath: "finn_params",
        version: PORCUPINE_MODEL_VERSION,
      },
      { processErrorCallback: (error) => console.warn("[wake-word] processing error", error) },
    );
    return {
      status: { available: true },
      detector: {
        frameLength: worker.frameLength,
        process: (frame) => worker.process(frame),
        release: async () => {
          await worker.release().catch(() => undefined);
          worker.terminate();
        },
      },
    };
  } catch (err) {
    // Typical causes: invalid/expired AccessKey, keyword/params language or version mismatch.
    console.error("[wake-word] Porcupine init failed", err);
    return unavailable("init-failed", err instanceof Error ? err.message : String(err));
  }
}

async function missingFiles(paths: string[]): Promise<string[]> {
  const checks = await Promise.all(
    paths.map(async (path) => {
      try {
        const res = await fetch(path, { method: "HEAD", cache: "no-store" });
        return res.ok ? null : path;
      } catch {
        return path;
      }
    }),
  );
  return checks.filter((p): p is string => p !== null);
}

function unavailable(reason: WakeWordUnavailableReason, detail?: string) {
  return { detector: null, status: { available: false as const, reason, detail } };
}
