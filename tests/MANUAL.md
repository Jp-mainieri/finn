# Finn — manual test checklist (iPhone PWA + car)

Automated suites cover the backend (`npm test`, `npm run test:smoke`, `npm run test:live`).
This checklist covers what only a real phone, a real car and a real voice can prove.
Run it on the deployed build (Vercel preview or prod), not `next dev`.

**Record for each run:** date, build URL / commit, iPhone model + iOS version, car audio (Bluetooth / CarPlay audio / phone speaker), network (4G/5G/Wi-Fi).
Mark each item ✅ / ❌ / ⚠️ and add a note for anything that isn't ✅.

## 0. Before you drive (parked)

- [ ] `npm run test:smoke` against the same URL passes with `FINN_API_TOKEN` set. The authenticated A2A check runs only if `FINN_A2A_TOKEN` is also set (64 hex, different from `FINN_API_TOKEN`); without it the smoke skips that check with a warning, and a 503 from `/api/agents/*` means A2A is off.
- [ ] Spotify: account is Premium, the app is logged in, and something played on the phone at least once today.
- [ ] Waze installed and logged in; location permission set to "While Using".
- [ ] Phone: Low Power Mode **off** (it throttles mic/background audio), volume up, Silent switch noted (see 4.4).

## 1. Install and setup

- [ ] Safari → build URL → Share → **Add to Home Screen**. The icon and name "Finn" look right.
- [ ] Opening from the icon runs standalone (no Safari address bar).
- [ ] First launch shows the **invite screen** (field `FINN-XXXX-XXXX`), not a token field. Typing the code in lower case works.
- [ ] A wrong code shows only "Convite inválido."; a mistyped one (too short / strange characters) shows "Confira o código."; none of them is a blank screen or silence.
- [ ] Redeem a test invite: the app enters. Kill the app (swipe up) and reopen: still signed in (session token in `localStorage`); no prompt again.
- [ ] Settings → **Entrar com outro convite**: redeeming a second invite replaces the session (check by who the Spotify state belongs to); "Cancelar" returns without changing anything.
- [ ] Settings → **Sair deste aparelho** asks for confirmation, then shows the invite screen again; reopening the app still shows it.
- [ ] Rate limit (parked, test environment only): after repeated wrong codes the screen shows "Muitas tentativas, tente em N min." with a plausible N (rounded up).
- [ ] First launch asks for **microphone permission** once, with context on why. Denying it shows a clear message and a way to retry.
- [ ] After allowing, reopening does not ask again.

## 2. Wake word "Finn"

- [ ] Parked, quiet car: saying "Finn" opens a session within ~1 s, with an audible cue.
- [ ] Engine on, A/C on, windows closed: "Finn" still triggers from the driver's seat without raising your voice.
- [ ] With music playing through the car speakers, "Finn" still triggers.
- [ ] False positives: a 10-minute drive with radio or talk and no "Finn" produces **zero** activations. Note any that happen.
- [ ] Similar words ("fim", "Flynn", "sim") don't trigger, or rarely do. Note which ones do.
- [ ] Nothing reaches the network before the wake word. Optional check: Safari Web Inspector → Network is quiet while idle.

## 3. Use cases by voice (after "Finn")

Speak naturally, as you would while driving. For each one, note **time from the end of speech to the first audio of the reply** (see §6).

| # | Say | Expected |
|---|-----|----------|
| UC1 | "toca a playlist *\<exact name>*" | That playlist starts on the active device; a short spoken confirmation; no IDs or URLs read aloud |
| UC2a | "pausa a música" | Pauses; short confirmation |
| UC2b | "continua" / "retoma a música" | Resumes the same track |
| UC2c | "pula essa música" / "próxima" | Next track |
| UC3 | "me leva pra Avenida Paulista, mil" | Waze opens with the route to that address (see §4) |
| UC4 | "quais playlists eu tenho?" | Reads a few names, not all 50, and doesn't read IDs |
| UC5 | "toca a playlist *\<approximate name>*" (e.g. drop a word, wrong gender/plural) | Plays the right one |
| UC5b | "toca a playlist *\<nonsense>*" | Plays nothing; says it didn't find it and suggests one or two |
| UC6 | (see §5) | Short spoken failure; the conversation keeps working |
| UC7 | "toca *\<playlist>* e me leva pro *\<place>*" | Music starts **and** Waze opens; **one** combined reply covering both |

- [ ] Each agent ignores the other half of a double command: Spotify doesn't search for "aeroporto"; Waze doesn't route to "Rock Nacional".
- [ ] Out-of-scope request ("que horas são?"): a polite "I can play music or take you somewhere" style reply, no crash.

### Saved addresses (casa / trabalho)

- [ ] Settings has **no** address fields and **no** field to paste a Spotify token (both live on the server now).
- [ ] With nothing saved: "me leva pra casa" → Finn asks for the full address and Waze does **not** open.
- [ ] In the **same** session, answer only with the address ("Rua Augusta, cento e vinte e três"): Waze opens to it. Check the number was transcribed correctly.
- [ ] Close the session and wait for it to end. Later, "Finn, me leva pra casa" goes straight to the saved address without asking.
- [ ] "meu trabalho" / "escritório" behave the same for *trabalho*. A seeded `WAZE_SAVED_ADDRESSES` entry is used without asking.
- [ ] Ask for the address, then say nothing until the session times out. Next session: "toca rock" is **not** treated as an address.
- [ ] ⚠️ Known risk: saved addresses live in server memory. After a redeploy or cold start (test the next morning), is "casa" still remembered? Note the result.

### Spotify connection (installed PWA, standalone, preview with Redis and `FINN_TOKEN_ENC_KEY`)

Answers the open question that decides whether the OAuth callback gets tied to the browser (contract `pwa-convite-e-dono.md`, option b). Record each answer.

- [ ] Settings → Spotify shows "Não conectado" for a guest driver. Tap **Conectar Spotify**: does the Spotify consent page open **inside** the app or **outside** (Safari)? ___
- [ ] After consenting, does the app come back **by itself** or do you have to open it again? ___ Does the status change to "Conectado" when you return (re-read on return, no manual refresh)? ___
- [ ] Does the flow complete at all, and **where** (in the app or in Safari)? Note it even if the cookie `finn_spotify_oauth_state` is irrelevant in production. ___
- [ ] Play a song by voice with the connected account ("toca *\<playlist>*").
- [ ] **Desconectar** returns to "Não conectado"; "toca ..." then asks to connect Spotify.
- [ ] The owner session shows "Spotify do servidor"; tapping connect (if shown) says it does not apply, with no error.
- [ ] With Redis or the key off (preview without them): a short, fixed message, no stack or JSON on screen.

### Server-down and throttling lines (spoken by the phone, no network)

- [ ] Force a 503 (preview without Redis, or a stopped backend) and give a command: you hear "O Finn está fora do ar agora, tente de novo daqui a pouco."
- [ ] Force a 429 (exceed the rate limit in the test environment) and give a command: you hear "Muitas tentativas, tente de novo em instantes."
- [ ] With the mic active on iOS, native speech can be muted by the system: note whether these lines are audible or only appear on screen.
- [ ] A 401 mid-trip (revoke the driver) sends you back to the invite screen with a short on-screen notice.

## 4. Waze deep link on iOS

- [ ] When the reply arrives, Waze **opens automatically** with navigation started. Note whether iOS showed an "Open in Waze?" confirmation.
- [ ] If iOS blocks the automatic open (common without a recent tap), a **big fallback button** ("Navegar para …") appears and works with one tap.
- [ ] After Waze opens, can you get back to Finn? Does the wake word still work while Waze is in the foreground? (PWAs in the background usually lose the mic, so note the behavior.)
- [ ] Silent switch **on**: is Finn's reply still audible?
- [ ] Waze voice guidance and Finn's replies don't cut each other off badly.

## 5. Failure behavior (UC6)

- [ ] **No active Spotify device** (force-quit Spotify, wait a minute): "toca *\<playlist>*" → Finn says to open Spotify on some device, briefly and without technical terms. After opening Spotify, the same command works.
- [ ] **No network** (Airplane Mode after the wake word): a short spoken error or a clear on-screen message, with no endless silence. When the network returns, the next command works.
- [ ] **Poor signal** (garage / tunnel): note how long until Finn replies or gives up. The backend gives each agent 8 s.
- [ ] **Double command with Spotify failing** (Spotify closed + "toca X e me leva pra Y"): Waze still opens and Finn mentions the music problem.
- [ ] No reply ever contains "erro 401", "token", "spotify:playlist", URLs or English.

## 6. Session and latency perception

- [ ] After the reply, the session **closes on its own** after a period of silence (note how many seconds), with a cue, and the wake word works again right after.
- [ ] A follow-up spoken right after a reply, without saying "Finn" again, is still heard (full-duplex window).
- [ ] Interrupting Finn mid-reply works (barge-in).
- [ ] Latency from end of speech to start of the reply, 5 samples each:
  - UC2 pause: ___ / ___ / ___ / ___ / ___ (target: under ~1.5 s)
  - UC1 play: ___ / ___ / ___ / ___ / ___
  - UC5 inexact (3 model round-trips): ___ / ___ / ___ / ___ / ___
  - UC7 double: ___ / ___ / ___ / ___ / ___ (should be about the slower of the two, not their sum)
- [ ] Does any pause **feel** long enough that you'd reach for the phone? Note which command.
- [ ] 30-minute drive: battery drain ___ % and phone temperature (normal / warm / hot).

## 7. Safety / UX sanity

- [ ] Every use case above was possible **without touching the screen** after the trip began, except the iOS deep-link fallback, if needed.
- [ ] On-screen text is readable at a glance, and nothing requires reading while driving.
- [ ] Replies are short (one sentence, two for UC7) and in natural pt-BR.
