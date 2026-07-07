# omni-playground

A local web playground for **multimodal generation** — realtime voice, chat, text-to-image, image
editing, video generation, TTS and streaming video chat against a
[vLLM-omni](https://github.com/vllm-project/vllm-omni) server.
Ships as a single npm package with zero runtime dependencies: run one command, get a UI.

```
npx omni-playground --target http://<your-vllm-omni-host>:8091 --open
```

That starts the server on <http://127.0.0.1:3888> (and opens it with `--open`). Pick a page in the
left rail; open **Settings** to change the target, set an API key, or free/restore GPU memory.

## What you get

| Page  | Endpoint                              | Highlights                                                                 |
| ----- | ------------------------------------- | -------------------------------------------------------------------------- |
| Realtime | `WS /v1/realtime`                  | Voice chat — mic in (PCM16 @ 16 kHz) → text + voice reply (PCM16 @ 24 kHz), inline player + WAV download per reply. **Auto mode** uses client-side VAD for hands-free turns (speech starts a turn, silence ends it, auto re-arm); **push-to-talk** for manual control. No server VAD (`session.update` → `commit` → `append` → `commit final`) |
| Chat  | `POST /v1/chat/completions`           | SSE streaming, image & audio attachments, sampling controls, markdown       |
| Image | `POST /v1/images/generations`         | negative prompt, steps / guidance / cfg / seed, gallery + download          |
| Edit  | `POST /v1/images/edits`               | multi-image upload (multipart), strength, source vs. result comparison      |
| Video | `POST /v1/videos` (async jobs)        | t2v / i2v via reference image, live progress polling, inline playback, download, per-stage timing & peak-memory metrics |
| Audio | `POST /v1/audio/speech` · `/v1/audio/generate` · `WS /v1/audio/speech/stream` | TTS with voice picker (`/v1/audio/voices`), speed, zero-shot voice clone (ref audio + transcript), voice library upload/delete; text-to-sound with length / steps / guidance; optional streaming TTS with progressive per-sentence playback |
| Vid Chat | `WS /v1/video/chat/stream` · `WS /v1/realtime/video` | **Chat:** sample frames from an uploaded clip in-browser, stream them up, get a text + spoken reply. **Generate:** prompt → generated video streamed back as fragmented-MP4 chunks (needs a video-generation model) |

All requests are proxied through the local server (`/api/* → target`), so the browser never talks
to the inference host directly and no CORS configuration is needed on the vLLM side. WebSocket
upgrades on `/api/*` are tunneled through the same gateway, so the realtime/streaming endpoints
work with no extra setup.

The four streaming endpoints (`/v1/realtime`, `/v1/audio/speech/stream`, `/v1/video/chat/stream`,
`/v1/realtime/video`) are **WebSocket** routes — they don't appear in the target's `openapi.json`
(FastAPI omits WebSocket routes). Their event protocols are implemented in `web/src/lib/realtime.ts`
(realtime voice) and `web/src/lib/streams.ts` (the other three).

## CLI

```
omni-playground [options]

  -t, --target <url>   vLLM-omni base URL   (default http://127.0.0.1:8091, env OMNI_TARGET)
  -p, --port <port>    port to listen on    (default 3888, env OMNI_PORT)
  -H, --host <host>    host to bind         (default 127.0.0.1, env OMNI_HOST)
      --open           open the browser after start
```

The target can also be changed at runtime from the **Settings** drawer in the UI. An optional API
key set in Settings is forwarded as a `Bearer` token. The Settings drawer also has **GPU memory**
controls (`/v1/omni/sleep` · `/v1/omni/wakeup`) to offload/reload pipeline stages between runs; the
per-stage acks are surfaced, so you can tell when a backend doesn't support sleep.

## Development

```bash
npm install
OMNI_TARGET=http://127.0.0.1:8091 npm run dev   # vite dev server on :3889, /api proxied
npm run build                                   # type-check + build to dist/web
npm start -- --target http://127.0.0.1:8091     # run the packaged CLI locally
```

The upstream API surface is captured in
[`docs/vllm-omni-openapi.json`](https://github.com/FayeSpica/omni-playground/blob/main/docs/vllm-omni-openapi.json);
`web/src/lib/types.ts` is hand-distilled from it.

## Notes

- Which pages actually produce output depends on what the target server has loaded: an omni chat
  model serves the Chat/Realtime/Vid-Chat pages, diffusion models serve the Image/Edit/Video pages,
  a TTS model serves the Audio page. Endpoints that are not backed by a loaded model return an
  error, which the UI surfaces verbatim.
- **Realtime** and **Vid Chat → Chat** need an omni model that supports the streaming path; the
  first reply on a large model warms up slowly (tens of seconds) before tokens/audio start.
- Node.js ≥ 18 is required. Microphone / webcam pages need a secure context — `127.0.0.1` counts, so
  a local run is fine without HTTPS.

## License

Apache-2.0
