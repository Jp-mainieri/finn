# Wake word "Finn" (Porcupine)

The PWA listens for "Finn" on-device with Picovoice Porcupine (WASM). Until the
files below exist, the app works with the big "Falar com o Finn" button and
shows a discreet "Palavra “Finn” não configurada" notice.

## What to add here

| File | Where it comes from |
| --- | --- |
| `finn_wasm.ppn` | Picovoice Console → Porcupine → type `Finn`, pick the language, platform **Web (WASM)** → download, rename to `finn_wasm.ppn` |
| `porcupine_params_pt.pv` | The model params for the **same language** as the keyword: <https://github.com/Picovoice/porcupine/tree/master/lib/common> (`porcupine_params_pt.pv` for Portuguese) |

And set `NEXT_PUBLIC_PICOVOICE_ACCESS_KEY` (Picovoice Console → AccessKey) in
`.env.local` / Vercel. It is compiled into the client bundle, so it is public
by nature (Porcupine validates it in the browser); the free personal tier is enough.

## Things that must match

- **Language**: a Portuguese keyword only works with `porcupine_params_pt.pv`;
  an English one needs `porcupine_params.pv`. If you train in English, either
  name the English file `porcupine_params_pt.pv` or change
  `PORCUPINE_MODEL_PATH` in `src/lib/voice/config.ts`.
- **Version**: the `.ppn`/`.pv` must be for Porcupine **v4** (the version of
  `@picovoice/porcupine-web` in `package.json`). Console downloads use the latest
  version; take the params file from the matching release branch of the repo.
- **Cache**: Porcupine caches both files in IndexedDB. After replacing either
  file, bump `PORCUPINE_MODEL_VERSION` in `src/lib/voice/config.ts`.

Paths, label and sensitivity live in `src/lib/voice/config.ts`
(`PORCUPINE_KEYWORD_PATH`, `PORCUPINE_MODEL_PATH`, `PORCUPINE_SENSITIVITY`).

If init fails (invalid AccessKey, language/version mismatch), the reason is
logged to the browser console as `[wake-word] Porcupine init failed` and the
tap-to-talk button keeps working.
