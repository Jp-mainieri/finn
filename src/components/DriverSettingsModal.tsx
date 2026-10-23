"use client";

import { useEffect, useState } from "react";
import {
  getDriverSettings,
  saveDriverSettings,
  type DriverSettings,
} from "@/lib/voice/driver-settings";

function DriverSettingsDialog({ onClose }: { onClose: () => void }) {
  const [settings] = useState<DriverSettings>(() => getDriverSettings());
  const [casa, setCasa] = useState(settings.casa ?? "");
  const [trabalho, setTrabalho] = useState(settings.trabalho ?? "");
  const [spotifyToken, setSpotifyToken] = useState(settings.spotifyRefreshToken ?? "");
  const [ttsMode, setTtsMode] = useState<"native" | "openai">(settings.ttsMode);
  const [savedNotice, setSavedNotice] = useState(false);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    saveDriverSettings({
      casa: casa.trim() || undefined,
      trabalho: trabalho.trim() || undefined,
      spotifyRefreshToken: spotifyToken.trim() || undefined,
      ttsMode,
      voiceProvider: "stt-tts",
    });
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

          {/* Endereços Salvos (Waze) */}
          <section className="space-y-3">
            <div>
              <h3 className="text-base font-semibold text-foreground">Endereços Salvos (Waze)</h3>
              <p className="text-sm text-muted">
                Diga &quot;leva pra casa&quot; ou &quot;pro trabalho&quot;. Endereços falados durante a viagem também são salvos aqui.
              </p>
            </div>

            <div className="space-y-2">
              <label htmlFor="input-casa" className="block text-sm font-medium text-muted">
                Casa
              </label>
              <input
                id="input-casa"
                type="text"
                value={casa}
                onChange={(e) => setCasa(e.target.value)}
                placeholder="Ex: Rua Augusta, 123, São Paulo"
                className="w-full rounded-2xl border border-border bg-background px-4 py-3 text-base text-foreground outline-none focus:border-accent"
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="input-trabalho" className="block text-sm font-medium text-muted">
                Trabalho
              </label>
              <input
                id="input-trabalho"
                type="text"
                value={trabalho}
                onChange={(e) => setTrabalho(e.target.value)}
                placeholder="Ex: Av. Paulista, 1000, São Paulo"
                className="w-full rounded-2xl border border-border bg-background px-4 py-3 text-base text-foreground outline-none focus:border-accent"
              />
            </div>
          </section>

          {/* Spotify */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-foreground">Spotify do Motorista</h3>
              {spotifyToken.trim() ? (
                <span className="rounded-full bg-accent/20 px-3 py-1 text-xs font-semibold text-accent">
                  ✓ Conectado
                </span>
              ) : (
                <span className="rounded-full bg-border px-3 py-1 text-xs font-semibold text-muted">
                  Padrão do Servidor
                </span>
              )}
            </div>
            <p className="text-sm text-muted">
              Você pode usar sua própria conta do Spotify no Finn conectando via login ou colando seu Refresh Token.
            </p>

            <div className="flex flex-col gap-2">
              <a
                href="/api/spotify/login"
                className="flex min-h-12 items-center justify-center rounded-2xl border border-border bg-surface px-4 text-center text-sm font-semibold text-foreground hover:bg-background transition"
              >
                Conectar meu Spotify via Web
              </a>

              <input
                type="password"
                value={spotifyToken}
                onChange={(e) => setSpotifyToken(e.target.value)}
                placeholder="Ou cole seu Spotify Refresh Token"
                className="w-full rounded-2xl border border-border bg-background px-4 py-3 text-sm text-foreground outline-none focus:border-accent"
              />
              {spotifyToken.trim() && (
                <button
                  type="button"
                  onClick={() => setSpotifyToken("")}
                  className="self-end text-xs text-danger hover:underline"
                >
                  Desconectar Spotify pessoal
                </button>
              )}
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
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const token =
      params.get("spotify_refresh_token") ||
      params.get("spotify_token") ||
      hash.get("spotify_refresh_token");

    if (token) {
      saveDriverSettings({ spotifyRefreshToken: token });
      const cleanUrl = window.location.pathname;
      window.history.replaceState({}, document.title, cleanUrl);
    }
  }, []);

  if (!isOpen) return null;

  return <DriverSettingsDialog onClose={onClose} />;
}
