/** Waze universal link that starts turn-by-turn navigation to `address` (opened by the PWA). */
export function wazeDeepLink(address: string): string {
  return `https://waze.com/ul?q=${encodeURIComponent(address)}&navigate=yes`;
}
