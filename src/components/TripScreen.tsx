"use client";

import { isRecoverable } from "@/lib/voice/state-machine";
import { statusText, wakeWordNotice, type StatusTone } from "@/lib/voice/status";
import type { VoiceController, VoiceView } from "@/lib/voice/voice-controller";

const TONE_CLASS: Record<StatusTone, string> = {
  idle: "text-foreground",
  ready: "text-foreground",
  active: "text-accent",
  busy: "text-warn",
  error: "text-danger",
};

const BIG_BUTTON = "min-h-24 w-full rounded-3xl px-6 text-2xl font-semibold transition-transform active:scale-[0.98]";

export function TripScreen({ view, controller }: { view: VoiceView; controller: VoiceController }) {
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
        <span className="text-2xl font-bold">Finn</span>
        <div className="flex gap-2">
          {inTrip && (
            <button onClick={() => controller.endTrip()} className="min-h-12 rounded-full border border-border px-4 text-base text-muted">
              Encerrar viagem
            </button>
          )}
          <button
            onClick={() => {
              if (window.confirm("Apagar o token salvo neste aparelho?")) controller.resetToken();
            }}
            className="min-h-12 rounded-full border border-border px-4 text-base text-muted"
          >
            Token
          </button>
        </div>
      </header>

      {inTrip && notice && <p className="rounded-2xl bg-surface px-4 py-3 text-base text-muted">{notice}</p>}

      <section aria-live="polite" className="flex flex-1 flex-col justify-center gap-6 py-4">
        <p
          className={`break-words text-5xl leading-tight font-bold sm:text-6xl ${TONE_CLASS[status.tone]} ${
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
                <span className="font-semibold text-accent">Finn: </span>
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
            className={`${BIG_BUTTON} flex flex-1 items-center justify-center bg-accent text-center text-background`}
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
          <button onClick={() => controller.startTrip()} className={`${BIG_BUTTON} bg-accent text-background`}>
            {inTrip ? "Retomar o Finn" : "Iniciar viagem"}
          </button>
          {!inTrip && (
            <p className="text-center text-base text-muted">
              Libera o microfone uma vez e deixa a tela ligada durante o trajeto.
            </p>
          )}
        </div>
      ) : conversing ? (
        <button onClick={() => controller.hangUp()} className={`${BIG_BUTTON} border-2 border-border bg-surface text-foreground`}>
          Encerrar conversa
        </button>
      ) : (
        <button
          onClick={() => controller.talk()}
          disabled={voice.state === "closing"}
          className={`${BIG_BUTTON} bg-accent text-background disabled:opacity-40`}
        >
          Falar com o Finn
        </button>
      )}
    </div>
  );
}
