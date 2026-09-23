import { ALLOWED_CLIENT_EVENTS } from "./live-events";

/**
 * GPT-Live session configuration, built on the server by /api/realtime/session.
 * Client delegation: GPT-Live only handles the spoken conversation; every
 * action goes to our orchestrator (spec "GPT Realtime vs GPT-Live-1").
 * Prompt layout follows https://developers.openai.com/api/docs/guides/live-prompting
 * (the three delegation labels are kept in English on purpose, as the guide asks).
 */

export const LIVE_MODEL = "gpt-live-1";
/** Brazilian Portuguese voices: "tempo" (masculine) or "bossa" (feminine). */
export const DEFAULT_LIVE_VOICE = "tempo";

export const LIVE_INSTRUCTIONS = `Você é o Finn, um assistente de voz calmo e objetivo que ajuda quem está dirigindo.
Fale sempre em português do Brasil, com frases curtas (uma ou duas), em tom natural e tranquilo.
O motorista não pode olhar para a tela: nunca peça para ele ler ou tocar em nada, a não ser para abrir o Waze se ele não abrir sozinho.
Você não executa ações sozinho. Você não toca música nem abre navegação por conta própria.

Backchannel policy: Use poucos backchannels. Não interrompa o motorista.

Interruption policy: Pare de falar quando o motorista interromper e escute o que ele diz.

Delegation policy:
Backend tools:
- Música no Spotify: tocar uma playlist pelo nome, pausar, retomar, pular faixa e listar as playlists do motorista.
- Navegação no Waze: abrir a rota até um destino falado, inclusive endereços salvos como "casa" e "trabalho".

Delegate to the backend when:
- O motorista pede qualquer coisa sobre música ou navegação.
- O motorista responde a uma pergunta que veio do backend (por exemplo, o endereço completo de "casa").
- Uma correção muda um pedido que já foi feito.

Do not delegate to the backend when:
- O motorista só cumprimenta, agradece ou pede para você repetir um resultado que já foi dado.
- Você precisa de um esclarecimento curto para entender o pedido.

Delegate before giving an answer that depends on backend work.
Do not guess the result while waiting. Nunca diga que uma música começou a tocar ou que a rota foi aberta antes do resultado chegar.
Quando o resultado chegar, diga-o de forma curta e natural, sem detalhes técnicos.

Keep listening while the user pauses to think.
Do not treat music, radio, podcasts or nearby conversation as a new request.`;

export interface LiveSessionConfig {
  model: string;
  instructions: string;
  audio: { output: { voice: string } };
  delegation: { type: "client" };
  client: { data_channel: { allowed_client_events: string[] } };
}

export function buildLiveSessionConfig(voice: string = DEFAULT_LIVE_VOICE): LiveSessionConfig {
  return {
    model: LIVE_MODEL,
    instructions: LIVE_INSTRUCTIONS,
    // WebRTC negotiates the audio format over SDP, so `audio.format` is omitted.
    audio: { output: { voice } },
    delegation: { type: "client" },
    // The browser is an untrusted frontend: it may only send what Finn needs.
    client: { data_channel: { allowed_client_events: [...ALLOWED_CLIENT_EVENTS] } },
  };
}

/** What /api/realtime/session returns to the browser (never the API key). */
export interface LiveSessionResponse {
  sessionId: string;
  /** SDP answer to apply as the peer connection's remote description. */
  sdp: string;
}
