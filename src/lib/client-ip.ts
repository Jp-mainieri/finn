import { isIP } from "node:net";

/**
 * Client IP for rate limiting. The ONLY place that reads IP headers.
 *
 * HYPOTHESIS (not verified against a live Vercel deployment): the platform overwrites
 * `x-forwarded-for` / `x-real-ip` with the connecting address (clients cannot spoof them)
 * and also sets `x-vercel-forwarded-for`. Precedence: x-vercel-forwarded-for, x-real-ip,
 * x-forwarded-for. Each header is split on commas, entries are tried left to right, and
 * the first one that is a valid IP wins (bare IPv4/IPv6, or IPv4 with :port, or
 * [IPv6] with optional :port; anything else is skipped). If nothing is valid the result
 * is null and the limiter uses its own "noip" bucket. Outside Vercel these headers are
 * client-controlled, so the result must not be trusted there. Never log the value.
 */
function parseCandidate(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (isIP(v)) return v;
  const bracket = v.match(/^\[([^\]]+)\](?::\d{1,5})?$/);
  if (bracket && isIP(bracket[1]) === 6) return bracket[1];
  const v4port = v.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/);
  if (v4port && isIP(v4port[1]) === 4) return v4port[1];
  return null;
}

export function getClientIp(request: Request): string | null {
  for (const name of ["x-vercel-forwarded-for", "x-real-ip", "x-forwarded-for"]) {
    const header = request.headers.get(name);
    if (!header) continue;
    for (const entry of header.split(",")) {
      const ip = parseCandidate(entry);
      if (ip) return ip;
    }
  }
  return null;
}
