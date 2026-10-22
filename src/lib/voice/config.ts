/**
 * Tunables for the voice layer. Browser-safe (no secrets): only the Picovoice
 * AccessKey is read here, and it is public by design (Porcupine runs on-device).
 */

/** Close the Live session after this long without speech, playback or pending work. */
export const IDLE_TIMEOUT_MS = 10_000;
/** Hard cap for one conversation window, so a stuck session can't bill forever. */
export const MAX_CONVERSATION_MS = 5 * 60_000;
/** Give up on `session.closed` after this long and tear the connection down anyway. */
export const CLOSE_TIMEOUT_MS = 5_000;
/** Give up on WebRTC setup (SDP exchange + `session.started`) after this long. */
export const CONNECT_TIMEOUT_MS = 15_000;

/** After a recoverable error (e.g. connection failed), listen for "Finn" again after this long. */
export const ERROR_RECOVERY_MS = 4_000;

/**
 * GPT-Live's delegation event carries no text; the user's words come from
 * `session.input_transcript.delta`, which may land slightly after it.
 */
export const DELEGATION_SETTLE_MS = 150;
export const DELEGATION_TRANSCRIPT_WAIT_MS = 1_200;
/** The orchestrator's own agent budget is 8s; leave room for the network. */
export const ORCHESTRATOR_TIMEOUT_MS = 12_000;
/** Live accepts up to 500 tokens per append; keep spoken results well under it. */
export const MAX_SPOKEN_CHARS = 1_200;

/**
 * Deep links (Waze) are opened automatically once the confirmation has been
 * spoken; an on-screen button is always shown as well (iOS may block the
 * automatic attempt). See `client-actions.ts`.
 */
export const AUTO_OPEN_CLIENT_ACTIONS = true;
/** Wait this long without assistant speech before auto-opening, capped by the max. */
export const AUTO_OPEN_QUIET_MS = 1_500;
export const AUTO_OPEN_MAX_WAIT_MS = 8_000;

/** Remote (assistant) audio above this RMS level counts as "still speaking". */
export const SPEAKING_RMS_THRESHOLD = 0.02;

// --- Porcupine wake word ------------------------------------------------------
// Train "Finn" in Picovoice Console for platform "Web (WASM)" and drop the files
// in public/porcupine/ (see public/porcupine/README.md). A Portuguese keyword
// needs the Portuguese params file; an English one needs porcupine_params.pv.

export const WAKE_WORD_LABEL = "Finn";
export const PORCUPINE_KEYWORD_PATH = "/porcupine/finn_wasm.ppn";
export const PORCUPINE_MODEL_PATH = "/porcupine/porcupine_params_pt.pv";
/** Bump when either file changes: Porcupine caches them in IndexedDB. */
export const PORCUPINE_MODEL_VERSION = 1;
/** 0..1 — higher catches more "Finn"s but also more false alarms (road noise, radio). */
export const PORCUPINE_SENSITIVITY = 0.6;

/** Inlined at build time by Next.js. Public by nature: Porcupine validates it in the browser. */
export const PICOVOICE_ACCESS_KEY = process.env.NEXT_PUBLIC_PICOVOICE_ACCESS_KEY ?? "";

/** AudioWorklet that turns the mic stream into 16 kHz Int16 frames for Porcupine. */
export const PCM_WORKLET_PATH = "/voice/pcm-frame-processor.js";

// --- Backend -----------------------------------------------------------------

export const ORCHESTRATOR_PATH = "/api/orchestrator";
export const LIVE_SESSION_PATH = "/api/realtime/session";
export const TRANSCRIBE_PATH = "/api/realtime/transcribe";
export const TTS_PATH = "/api/realtime/tts";
export const TOKEN_STORAGE_KEY = "finn.apiToken";
export const DRIVER_SETTINGS_STORAGE_KEY = "finn.driverSettings";

// --- STT / TTS & VAD Tunables ------------------------------------------------
export const VAD_SPEECH_THRESHOLD = 0.008;
export const VAD_SILENCE_MS = 850;
export const MAX_UTTERANCE_MS = 12_000;
export const MIN_SPEECH_MS = 200;

