/**
 * Client IP for rate limiting. The ONLY place that reads IP headers.
 *
 * HYPOTHESIS (not verified against a live Vercel deployment): the platform overwrites
 * `x-forwarded-for` / `x-real-ip` with the connecting address (clients cannot spoof them)
 * and also sets `x-vercel-forwarded-for`. Order: x-vercel-forwarded-for, x-real-ip,
 * then the first x-forwarded-for entry. Outside Vercel (local dev, other proxies) these
 * headers are client-controlled, so the result must not be trusted there.
 * Missing/blank returns null; the rate limiter then uses its own "noip" bucket.
 * Never log the value.
 */
export function getClientIp(request: Request): string | null {
  const h = request.headers;
  const candidates = [h.get("x-vercel-forwarded-for"), h.get("x-real-ip"), h.get("x-forwarded-for")?.split(",")[0]];
  for (const c of candidates) {
    const v = c?.trim();
    if (v) return v;
  }
  return null;
}
