"use client";

import { useEffect } from "react";

/** Registers the minimal service worker (installability only; it never caches /api). */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .catch((err) => console.warn("[pwa] service worker registration failed", err));
  }, []);
  return null;
}
