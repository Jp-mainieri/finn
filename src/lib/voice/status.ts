import type { VoiceSnapshot } from "./state-machine";
import type { WakeWordStatus } from "./wake-word";

export type StatusTone = "idle" | "ready" | "active" | "busy" | "error";

export interface StatusText {
  title: string;
  tone: StatusTone;
}

/** The one big line the driver can glance at. */
export function statusText(voice: VoiceSnapshot, wakeWordReady: boolean): StatusText {
  switch (voice.state) {
    case "idle":
      return { title: "Pronto para a viagem", tone: "idle" };
    case "listening-wake":
      return { title: wakeWordReady ? "Diga “Finn”" : "Toque para falar", tone: "ready" };
    case "connecting":
      return { title: "Conectando…", tone: "busy" };
    case "in-conversation":
      if (voice.activity === "thinking") return { title: "Pensando…", tone: "busy" };
      if (voice.activity === "speaking") return { title: "Falando…", tone: "active" };
      return { title: "Ouvindo…", tone: "active" };
    case "closing":
      return { title: "Encerrando…", tone: "busy" };
    case "error":
      return { title: voice.error?.message ?? "Algo deu errado.", tone: "error" };
  }
}

/** Discreet notice when "Finn" can't be heard; null when the wake word works or is loading. */
export function wakeWordNotice(status: WakeWordStatus | { available: "loading" } | null): string | null {
  if (!status || status.available !== false) return null;
  switch (status.reason) {
    case "no-access-key":
    case "missing-files":
      return "Palavra “Finn” não configurada — use o botão.";
    case "unsupported":
      return "Este navegador não suporta a palavra “Finn” — use o botão.";
    case "init-failed":
      return "Não consegui ativar a palavra “Finn” — use o botão.";
  }
}
