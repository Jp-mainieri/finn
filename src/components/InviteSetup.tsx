"use client";

import { useState } from "react";
import type { InviteResult } from "@/lib/voice/invite-client";

export function InviteSetup({
  onRedeem,
  onCancel,
  rejected,
}: {
  onRedeem: (code: string) => Promise<InviteResult>;
  /** Present only when a session is saved and the driver opened this screen on purpose. */
  onCancel?: () => void;
  rejected: boolean;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!code.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await onRedeem(code);
      if (!result.ok) setError(result.message);
      // On success the controller leaves this screen; the code is dropped with the component state.
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex w-full flex-1 flex-col justify-center gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="space-y-3">
        <h1 className="text-5xl font-bold tracking-tight">Finn</h1>
        <p className="text-lg text-muted">Digite o código do seu convite. Ele só é usado uma vez para entrar.</p>
        {rejected && !error && (
          <p role="alert" className="rounded-2xl bg-danger/15 p-4 text-lg text-danger">
            Sua sessão foi recusada. Entre com um convite de novo.
          </p>
        )}
        {error && (
          <p role="alert" className="rounded-2xl bg-danger/15 p-4 text-lg text-danger">
            {error}
          </p>
        )}
      </div>
      <label className="sr-only" htmlFor="finn-invite">
        Código do convite
      </label>
      <input
        id="finn-invite"
        type="text"
        inputMode="text"
        autoComplete="off"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="FINN-XXXX-XXXX"
        className="w-full rounded-2xl border border-border bg-surface px-5 py-5 text-center font-mono text-2xl uppercase tracking-widest outline-none focus:border-accent"
      />
      <button
        type="submit"
        disabled={!code.trim() || busy}
        className="min-h-20 w-full rounded-3xl bg-accent text-2xl font-semibold text-background disabled:opacity-40"
      >
        {busy ? "Entrando…" : "Entrar"}
      </button>
      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className="min-h-16 w-full rounded-3xl border-2 border-border bg-surface text-xl font-semibold text-foreground"
        >
          Cancelar
        </button>
      )}
    </form>
  );
}
