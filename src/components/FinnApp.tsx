"use client";

import { useEffect, useSyncExternalStore } from "react";
import { TokenStore } from "@/lib/voice/token-store";
import { VoiceController, type VoiceView } from "@/lib/voice/voice-controller";
import { TokenSetup } from "./TokenSetup";
import { TripScreen } from "./TripScreen";

// One controller per page load (it owns the mic and the audio context).
let controller: VoiceController | null = null;
function getController(): VoiceController {
  controller ??= new VoiceController(new TokenStore());
  return controller;
}

const subscribe = (listener: () => void) => getController().subscribe(listener);
const getView = () => getController().getView();
const getServerView = (): VoiceView | null => null;

export function FinnApp() {
  const view = useSyncExternalStore(subscribe, getView, getServerView);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") void getController().onVisible();
      else getController().onHidden();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]">
      {!view ? (
        <div className="flex flex-1 items-center justify-center text-5xl font-bold">Finn</div>
      ) : view.needsToken ? (
        <TokenSetup rejected={view.tokenRejected} onSave={(token) => getController().saveToken(token)} />
      ) : (
        <TripScreen view={view} controller={getController()} />
      )}
    </main>
  );
}
