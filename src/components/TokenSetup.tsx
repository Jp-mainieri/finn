"use client";

import { useState } from "react";

export function TokenSetup({ onSave, rejected }: { onSave: (token: string) => void; rejected: boolean }) {
  const [token, setToken] = useState("");

  return (
    <form
      className="flex w-full flex-1 flex-col justify-center gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (token.trim()) onSave(token);
      }}
    >
      <div className="space-y-3">
        <h1 className="text-5xl font-bold tracking-tight">Finn</h1>
        <p className="text-lg text-muted">
          Cole o token de acesso (<code className="text-foreground">FINN_API_TOKEN</code>). Ele fica salvo só neste
          aparelho.
        </p>
        {rejected && (
          <p role="alert" className="rounded-2xl bg-danger/15 p-4 text-lg text-danger">
            O servidor recusou o token salvo. Cole o token de novo.
          </p>
        )}
      </div>
      <label className="sr-only" htmlFor="finn-token">
        Token de acesso
      </label>
      <input
        id="finn-token"
        type="password"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder="Token de acesso"
        className="w-full rounded-2xl border border-border bg-surface px-5 py-5 text-xl outline-none focus:border-accent"
      />
      <button
        type="submit"
        disabled={!token.trim()}
        className="min-h-20 w-full rounded-3xl bg-accent text-2xl font-semibold text-background disabled:opacity-40"
      >
        Salvar
      </button>
    </form>
  );
}
