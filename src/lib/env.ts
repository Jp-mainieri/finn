/**
 * Server-side env access. Secrets are read lazily so the app builds without
 * them and fails with a clear message only when a feature actually needs one.
 * Never import this from client components.
 */

export class MissingEnvError extends Error {
  constructor(public readonly variable: string) {
    super(`Missing required environment variable: ${variable}`);
    this.name = "MissingEnvError";
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new MissingEnvError(name);
  return value;
}

export function optionalEnv(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

/** When true, agents run against the mock Neuralake client (local dev / tests). */
export function mocksEnabled(): boolean {
  return process.env.FINN_USE_MOCKS === "1";
}
