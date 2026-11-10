import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DriverSettingsModal, chooseTtsMode } from "./DriverSettingsModal";
import type { VoiceController, VoiceView } from "@/lib/voice/voice-controller";

const markup = () =>
  renderToStaticMarkup(
    createElement(DriverSettingsModal, {
      isOpen: true,
      onClose: () => {},
      controller: {} as unknown as VoiceController,
      view: { spotify: { status: "disconnected" } } as unknown as VoiceView,
    }),
  );

describe("DriverSettingsModal", () => {
  it("is a labelled modal dialog with a title that can receive focus", () => {
    const html = markup();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="driver-settings-title"');
    expect(html).toMatch(/<h2 id="driver-settings-title"[^>]*tabindex="-1"/);
  });

  it("close button is at least 48x48 px", () => {
    expect(markup()).toMatch(/<button[^>]*class="[^"]*\bh-12\b[^"]*\bw-12\b[^"]*"[^>]*aria-label="Fechar"/);
  });

  it("has no save button, no engine section, no 'Em breve' and no jargon", () => {
    const html = markup();
    for (const gone of ["Salvar alterações", "Motor de voz", "Em breve", "Whisper", "GPT-Live", "OpenAI", "tokens", "Siri", "!"]) {
      expect(html).not.toContain(gone);
    }
    expect(html).not.toContain('type="submit"');
    expect(html).toContain("Voz rápida do aparelho");
    expect(html).toContain("Voz natural (usa mais dados)");
  });

  it("tapping an option saves the voice right away", () => {
    const save = vi.fn();
    chooseTtsMode("openai", save);
    expect(save).toHaveBeenCalledWith({ ttsMode: "openai", voiceProvider: "stt-tts" });
    chooseTtsMode("native", save);
    expect(save).toHaveBeenLastCalledWith({ ttsMode: "native", voiceProvider: "stt-tts" });
  });
});
