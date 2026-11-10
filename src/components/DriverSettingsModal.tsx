"use client";

import { useEffect, useRef, useState } from "react";
import { attachDialogA11y } from "./dialog-a11y";
import {
  getDriverSettings,
  saveDriverSettings,
  type DriverSettings,
} from "@/lib/voice/driver-settings";
import { SPOTIFY_MESSAGES } from "@/lib/voice/spotify-connection";
import type { VoiceController, VoiceView } from "@/lib/voice/voice-controller";

type TtsMode = DriverSettings["ttsMode"];

/** Saves the voice as soon as the driver taps an option: nothing is lost if the dialog is closed. */
export function chooseTtsMode(mode: TtsMode, save = saveDriverSettings): void {
  save({ ttsMode: mode, voiceProvider: "stt-tts" });
}

function DriverSettingsDialog({
  onClose,
  controller,
  view,
}: {
  onClose: () => void;
  controller: VoiceController;
  view: VoiceView;
}) {
  const [settings] = useState<DriverSettings>(() => getDriverSettings());
  const [ttsMode, setTtsMode] = useState<"native" | "openai">(settings.ttsMode);
  const spotify = view.spotify;
  const overlayRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    controller.setSettingsOpen(true);
    return () => controller.setSettingsOpen(false);
  }, [controller]);

  useEffect(() => {
    const root = overlayRef.current;
    if (!root) return;
    return attachDialogA11y({
      root,
      initialFocus: titleRef.current,
      onClose: () => onCloseRef.current(),
      doc: document,
    });
  }, []);

  const handleChooseTts = (mode: TtsMode) => {
    setTtsMode(mode);
    chooseTtsMode(mode);
  };

  return (
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="driver-settings-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-scrim p-0 sm:p-4"
    >
      <div className="flex max-h-[90dvh] w-full max-w-lg flex-col rounded-t-3xl sm:rounded-3xl border border-border bg-surface overflow-hidden animate-in fade-in duration-200">
        <header className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 id="driver-settings-title" ref={titleRef} tabIndex={-1} className="text-xl font-semibold text-foreground outline-none">
            Configurações
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-12 min-h-12 w-12 min-w-12 items-center justify-center rounded-full border border-border text-2xl text-muted transition-transform active:scale-95"
            aria-label="Fechar"
          >
            ×
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Voz do Assistente */}
          <section className="space-y-3">
            <h3 className="text-base font-semibold text-foreground">Voz do assistente</h3>
            <div role="radiogroup" aria-label="Voz do assistente" className="grid grid-cols-1 gap-2">
              <label
                className={`flex cursor-pointer flex-col rounded-2xl border p-4 transition-colors ${
                  ttsMode === "native"
                    ? "border-accent-ink bg-accent/10"
                    : "border-border bg-background/50 hover:border-muted"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-foreground">Voz rápida do aparelho</span>
                  <input
                    type="radio"
                    name="ttsMode"
                    value="native"
                    checked={ttsMode === "native"}
                    onChange={() => handleChooseTts("native")}
                    className="accent-accent-ink h-5 w-5"
                  />
                </div>
                <p className="mt-1 text-sm text-muted">
                  Usa a voz do celular. Responde na hora e não gasta dados.
                </p>
              </label>

              <label
                className={`flex cursor-pointer flex-col rounded-2xl border p-4 transition-colors ${
                  ttsMode === "openai"
                    ? "border-accent-ink bg-accent/10"
                    : "border-border bg-background/50 hover:border-muted"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-foreground">Voz natural (usa mais dados)</span>
                  <input
                    type="radio"
                    name="ttsMode"
                    value="openai"
                    checked={ttsMode === "openai"}
                    onChange={() => handleChooseTts("openai")}
                    className="accent-accent-ink h-5 w-5"
                  />
                </div>
                <p className="mt-1 text-sm text-muted">
                  Voz mais natural, que pode demorar um pouco mais para começar.
                </p>
              </label>
            </div>
          </section>

          {/* Spotify (o token fica no servidor; o aparelho só sabe se está conectado) */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-foreground">Spotify</h3>
              {spotify.status === "connected" && (
                <span className="rounded-full bg-accent/20 px-3 py-1 text-sm font-semibold text-accent-ink">Conectado</span>
              )}
              {spotify.status === "owner" && (
                <span className="rounded-full bg-accent/20 px-3 py-1 text-sm font-semibold text-accent-ink">
                  Spotify do servidor
                </span>
              )}
              {spotify.status === "disconnected" && (
                <span className="rounded-full bg-border px-3 py-1 text-sm font-semibold text-muted">Não conectado</span>
              )}
              {spotify.status === "loading" && <span className="text-sm text-muted">Verificando…</span>}
            </div>
            {spotify.status === "error" && (
              <p role="alert" className="rounded-2xl bg-danger/15 p-3 text-base text-danger">
                {spotify.message}
              </p>
            )}
            {spotify.status === "owner" && <p className="text-sm text-muted">{SPOTIFY_MESSAGES.notApplicable}</p>}
            <div className="flex flex-col gap-2">
              {(spotify.status === "disconnected" || spotify.status === "error") && (
                <button
                  type="button"
                  onClick={() => void controller.connectSpotify()}
                  className="min-h-14 w-full rounded-2xl bg-accent px-4 text-lg font-semibold text-on-accent transition-transform active:scale-[0.98]"
                >
                  Conectar Spotify
                </button>
              )}
              {spotify.status === "connected" && (
                <button
                  type="button"
                  onClick={() => void controller.disconnectSpotify()}
                  className="min-h-14 w-full rounded-2xl border-2 border-border bg-surface px-4 text-lg font-semibold text-foreground transition-transform active:scale-[0.98]"
                >
                  Desconectar
                </button>
              )}
            </div>
          </section>

          {/* Conta */}
          <section className="space-y-3">
            <h3 className="text-base font-semibold text-foreground">Conta</h3>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => {
                  onClose();
                  controller.openInvite();
                }}
                className="min-h-14 w-full rounded-2xl border-2 border-border bg-surface px-4 text-lg font-semibold text-foreground transition-transform active:scale-[0.98]"
              >
                Entrar com outro convite
              </button>
              <button
                type="button"
                onClick={() => {
                  if (window.confirm("Sair deste aparelho? Será preciso um convite para entrar de novo.")) {
                    onClose();
                    controller.signOut();
                  }
                }}
                className="min-h-14 w-full rounded-2xl border-2 border-danger/60 bg-surface px-4 text-lg font-semibold text-danger transition-transform active:scale-[0.98]"
              >
                Sair deste aparelho
              </button>
            </div>
          </section>

        </div>
      </div>
    </div>
  );
}

export function DriverSettingsModal({
  isOpen,
  onClose,
  controller,
  view,
}: {
  isOpen: boolean;
  onClose: () => void;
  controller: VoiceController;
  view: VoiceView;
}) {
  if (!isOpen) return null;

  return <DriverSettingsDialog onClose={onClose} controller={controller} view={view} />;
}
