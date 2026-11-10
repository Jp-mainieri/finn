"use client";

import { useState } from "react";
import { isRecoverable } from "@/lib/voice/state-machine";
import { statusText, wakeWordNotice, type StatusTone } from "@/lib/voice/status";
import type { VoiceController, VoiceView } from "@/lib/voice/voice-controller";
import { FinnWordmark } from "./FinnMark";
import { DriverSettingsModal } from "./DriverSettingsModal";

const TONE_CLASS: Record<StatusTone, string> = {
  idle: "text-foreground",
  ready: "text-foreground",
  active: "text-accent-ink",
  busy: "text-warn",
  error: "text-danger",
};

const BIG_BUTTON = "min-h-24 w-full rounded-3xl px-6 text-2xl font-semibold transition-transform active:scale-[0.98]";

export const FINN_UI_VERSION = "v0.5.8";

export function TripScreen({ view, controller }: { view: VoiceView; controller: VoiceController }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { voice } = view;
  const wakeReady = view.wakeWord?.available === true;
  const status = statusText(voice, wakeReady);
  const notice = wakeWordNotice(view.wakeWord);
  const inTrip = voice.state !== "idle";
  const conversing = voice.state === "connecting" || voice.state === "in-conversation";
  // Mic denied/lost/unsupported need a fresh tap to re-open the mic (iOS gesture rule).
  const needsMicTap = voice.state === "error" && !isRecoverable(voice.error) && voice.error?.kind !== "unauthorized";

  return (
    <div className="flex w-full flex-1 flex-col gap-5">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <FinnWordmark />
          <span
            title="Versão atual carregada no aparelho"
            className="rounded-full border border-border bg-surface px-2.5 py-0.5 font-mono text-xs text-accent-ink"
          >
            {FINN_UI_VERSION}
          </span>
        </div>
        <div className="flex gap-2">
          {inTrip && (
            <button onClick={() => controller.endTrip()} className="min-h-12 rounded-full border border-border px-4 text-base text-muted">
              Encerrar viagem
            </button>
          )}
          <button
            onClick={() => setSettingsOpen(true)}
            className="min-h-12 rounded-full border border-border px-4 text-base text-muted"
          >
            Configurações
          </button>
        </div>
      </header>

      {inTrip && notice && <p className="rounded-2xl bg-surface px-4 py-3 text-base text-muted">{notice}</p>}

      <section aria-live="polite" className="flex flex-1 flex-col justify-center gap-6 py-4">
        <p
          className={`break-words text-5xl leading-tight font-semibold sm:text-6xl ${TONE_CLASS[status.tone]} ${
            status.tone === "active" ? "animate-pulse" : ""
          }`}
        >
          {status.title}
        </p>
        {(view.userText || view.assistantText) && (
          <div className="space-y-3 text-xl">
            {view.userText && (
              <p className="break-words text-muted">
                <span className="font-semibold text-foreground">Você: </span>
                {view.userText}
              </p>
            )}
            {view.assistantText && (
              <p className="break-words text-muted">
                <span className="font-semibold text-accent-ink">Finn: </span>
                {view.assistantText}
              </p>
            )}
          </div>
        )}
      </section>

      {view.pendingActions.map((action) => (
        <div key={action.id} className="flex items-stretch gap-2">
          <a
            href={action.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => controller.dismissAction(action.id)}
            className={`${BIG_BUTTON} flex flex-1 items-center justify-center bg-accent text-center text-on-accent`}
          >
            {action.label}
          </a>
          <button
            aria-label="Dispensar"
            onClick={() => controller.dismissAction(action.id)}
            className="min-h-24 w-16 shrink-0 rounded-3xl border border-border text-3xl text-muted"
          >
            ×
          </button>
        </div>
      ))}

      {!inTrip || needsMicTap ? (
        <div className="space-y-3">
          <button onClick={() => controller.startTrip()} className={`${BIG_BUTTON} bg-accent text-on-accent`}>
            {inTrip ? "Retomar o Finn" : "Iniciar viagem"}
          </button>
          {!inTrip && (
            <p className="text-center text-base text-muted">
              Libera o microfone uma vez e deixa a tela ligada durante o trajeto.
            </p>
          )}
        </div>
      ) : conversing ? (
        <div className="space-y-3">
          {voice.activity !== "thinking" && (
            <button
              onClick={() => controller.commitSpeech()}
              className={`${BIG_BUTTON} bg-accent text-on-accent`}
            >
              Pronto, enviar fala
            </button>
          )}
          <button
            onClick={() => controller.hangUp()}
            className={`${BIG_BUTTON} border-2 border-border bg-surface text-foreground`}
          >
            Encerrar conversa
          </button>
        </div>
      ) : (
        <button
          onClick={() => controller.talk()}
          disabled={voice.state === "closing"}
          className={`${BIG_BUTTON} bg-accent text-on-accent disabled:opacity-40`}
        >
          Falar com o Finn
        </button>
      )}

      <DriverSettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} controller={controller} view={view} />
    </div>
  );
}
