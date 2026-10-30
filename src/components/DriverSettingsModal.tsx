"use client";

import { useEffect, useState } from "react";
import {
  getDriverSettings,
  saveDriverSettings,
  type DriverSettings,
} from "@/lib/voice/driver-settings";
import { SPOTIFY_MESSAGES } from "@/lib/voice/spotify-connection";
import type { VoiceController, VoiceView } from "@/lib/voice/voice-controller";

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
  const [savedNotice, setSavedNotice] = useState(false);
  const spotify = view.spotify;

  useEffect(() => {
    controller.setSettingsOpen(true);
    return () => controller.setSettingsOpen(false);
  }, [controller]);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    saveDriverSettings({ ttsMode, voiceProvider: "stt-tts" });
    setSavedNotice(true);
    setTimeout(() => {
      setSavedNotice(false);
      onClose();
    }, 400);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Configurações do Motorista"
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75 p-0 sm:p-4 backdrop-blur-sm"
    >
      <div className="flex max-h-[90dvh] w-full max-w-lg flex-col rounded-t-3xl sm:rounded-3xl border border-border bg-surface shadow-2xl overflow-hidden animate-in fade-in duration-200">
        <header className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 className="text-xl font-bold text-foreground">Configurações</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-border text-2xl text-muted transition active:scale-95"
            aria-label="Fechar"
          >
            ×
          </button>
        </header>

        <form onSubmit={handleSave} className="flex-1 overflow-y-auto p-6 space-y-6">
          {savedNotice && (
            <div className="rounded-2xl bg-accent/20 border border-accent/40 p-4 text-center font-medium text-accent">
              ✓ Configurações salvas no aparelho!
            </div>
          )}

          {/* Voz do Assistente */}
          <section className="space-y-3">
            <h3 className="text-base font-semibold text-foreground">Voz do Assistente</h3>
            <div className="grid grid-cols-1 gap-2">
              <label
                className={`flex cursor-pointer flex-col rounded-2xl border p-4 transition ${
                  ttsMode === "native"
                    ? "border-accent bg-accent/10"
                    : "border-border bg-background/50 hover:border-muted"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-foreground">Rápida e Gratuita</span>
                  <input
                    type="radio"
                    name="ttsMode"
                    value="native"
                    checked={ttsMode === "native"}
                    onChange={() => setTtsMode("native")}
                    className="accent-accent"
                  />
                </div>
                <p className="mt-1 text-sm text-muted">
                  Voz nativa do aparelho (iOS / Siri / Luciana). Latência imediata e sem custo de tokens de áudio.
                </p>
              </label>

              <label
                className={`flex cursor-pointer flex-col rounded-2xl border p-4 transition ${
                  ttsMode === "openai"
                    ? "border-accent bg-accent/10"
                    : "border-border bg-background/50 hover:border-muted"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-foreground">Voz HD (OpenAI TTS)</span>
                  <input
                    type="radio"
                    name="ttsMode"
                    value="openai"
                    checked={ttsMode === "openai"}
                    onChange={() => setTtsMode("openai")}
                    className="accent-accent"
                  />
                </div>
                <p className="mt-1 text-sm text-muted">
                  Síntese neural ultra-natural em alta definição via OpenAI.
                </p>
              </label>
            </div>
          </section>

          {/* Motor de Sessão */}
          <section className="space-y-2">
            <span className="block text-sm font-semibold text-foreground">Motor de Voz</span>
            <div className="space-y-2">
              <div className="flex items-center justify-between rounded-2xl border border-accent bg-accent/10 px-4 py-3">
                <span className="text-base font-medium text-foreground">Whisper STT + TTS (Ativo)</span>
                <span className="rounded-full bg-accent/20 px-2.5 py-0.5 text-xs font-semibold text-accent">
                  Padrão
                </span>
              </div>
              <div
                aria-disabled="true"
                className="flex cursor-not-allowed items-center justify-between rounded-2xl border border-border bg-background/40 px-4 py-3 opacity-60"
              >
                <span className="text-base text-muted">GPT-Live-1 (WebRTC Full-Duplex)</span>
                <span className="rounded-full border border-border bg-surface px-2.5 py-0.5 text-xs font-semibold text-muted">
                  EM BREVE
                </span>
              </div>
            </div>
          </section>

          {/* Spotify (o token fica no servidor; o aparelho só sabe se está conectado) */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-foreground">Spotify</h3>
              {spotify.status === "connected" && (
                <span className="rounded-full bg-accent/20 px-3 py-1 text-sm font-semibold text-accent">Conectado</span>
              )}
              {spotify.status === "owner" && (
                <span className="rounded-full bg-accent/20 px-3 py-1 text-sm font-semibold text-accent">
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
                  className="min-h-14 w-full rounded-2xl bg-accent px-4 text-lg font-semibold text-background transition active:scale-98"
                >
                  Conectar Spotify
                </button>
              )}
              {spotify.status === "connected" && (
                <button
                  type="button"
                  onClick={() => void controller.disconnectSpotify()}
                  className="min-h-14 w-full rounded-2xl border-2 border-border bg-surface px-4 text-lg font-semibold text-foreground transition active:scale-98"
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
                className="min-h-14 w-full rounded-2xl border-2 border-border bg-surface px-4 text-lg font-semibold text-foreground transition active:scale-98"
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
                className="min-h-14 w-full rounded-2xl border-2 border-danger/60 bg-surface px-4 text-lg font-semibold text-danger transition active:scale-98"
              >
                Sair deste aparelho
              </button>
            </div>
          </section>

          <footer className="pt-2">
            <button
              type="submit"
              className="min-h-16 w-full rounded-3xl bg-accent text-xl font-semibold text-background transition active:scale-98"
            >
              Salvar Alterações
            </button>
          </footer>
        </form>
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
