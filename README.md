# Nemotron PWA + VoiceStudio TTS

This is a text-only NVIDIA Nemotron PWA. Conversation history is stored in the browser Cache API for five days. The project does not use SQLite, does not require login, and does not persist prompts or responses on the AI server.

## What is included

- **Text-only Nemotron chat** through the existing Node.js/Express API.
- **Device-only conversation history** stored as JSON entries in Cache Storage, with five-day retention.
- **VoiceStudio read-aloud** on assistant replies, through a small local bridge that runs on the user's Windows PC.
- **No database or login** in this build.
- Service-worker app-shell caching separated from the conversation cache.

## 1. Run the chatbot backend

Requirements: Node.js 20 or newer and an NVIDIA API key that has access to the configured model.

Windows PowerShell:

1. Extract the ZIP and open the extracted project folder.
2. Run `npm install`.
3. Copy `.env.example` to `.env` if `.env` does not exist: `Copy-Item .env.example .env`.
4. Put your NVIDIA API key in `.env` as `NVIDIA_API_KEY=...`.
5. Run `npm start`.
6. Open `http://127.0.0.1:3000/`.

Keep the NVIDIA key in the server-side `.env`; do not put it in `public/`.

## 2. Run VoiceStudio on Windows

1. Install and open VoiceStudio from https://voicestudio.sh/download.
2. Wait until VoiceStudio's local API is ready at `http://localhost:3900/health`.
3. In a second terminal, run `voice-bridge/start-bridge.bat` from this project. The bridge listens only on `127.0.0.1:3905` and forwards speech generation to VoiceStudio port `3900`.
4. Keep both VoiceStudio and the bridge terminal running while using Read aloud.
5. Refresh the PWA. Its top-right VoiceStudio status should show **ready**. Each completed assistant response has a **Read aloud** button.

The bridge uses Node.js built-ins only; it has no separate `npm install` step.

## 3. If the PWA is hosted on a VPS

VoiceStudio is a desktop app on the user's Windows PC. A VPS cannot call `127.0.0.1:3900` on that PC; `127.0.0.1` always refers to the machine making the request. This build correctly calls the **local bridge from the browser**, so the bridge must be running on the same Windows PC/browser that opens the PWA.

For local development, the bridge allows these origins by default:

- `http://127.0.0.1:3000`
- `http://localhost:3000`

For a hosted PWA, open `voice-bridge/.env` (created by the first run of `start-bridge.bat`) and add the exact web-app origin to `PWA_ORIGINS`. Example:

`PWA_ORIGINS=http://127.0.0.1:3000,http://localhost:3000,https://your-pwa.example.com`

Use only your real PWA origin. Do not include a path. Restart the bridge after editing this file. Your browser may also ask for permission to access a local-network device; allow it for your PWA if you want local speech to work.

The bridge binds only to loopback (`127.0.0.1`) and does not expose VoiceStudio to the LAN. Do not change it to `0.0.0.0` or port-forward it.

## 4. Text-to-speech behavior

- VoiceStudio's local API uses `POST /v1/audio/speech` on port `3900`.
- This build targets VoiceStudio’s `omnivoice` engine (the API ID for k2-fsa/OmniVoice) and uses the available `demo0001` profile shown by your installed voice list. Local loopback requests need no API key, and the bridge sends no Authorization header.
- VoiceStudio accepts up to 4,096 characters per request. The UI cleans up Markdown, splits answers into roughly 240-character sentence-aware chunks, starts playback as soon as the first chunk is ready, and generates the remaining chunks in the background. This reduces the wait before audio starts on long answers.
- Audio is generated only after the user clicks **Read aloud**. Generated audio blobs are temporary browser object URLs; they are not saved into conversation Cache Storage.
- TTS can be offline while text chat still works.

The default response format is WAV to match VoiceStudio's documented curl example. Speech speed defaults to `1.0` so audio is not artificially slowed down. Existing `voice-bridge/.env` files override this default; set `VOICESTUDIO_TTS_SPEED=1.0` there and restart the bridge if you previously configured `0.85`. To change model, voice, format or speech speed, edit `voice-bridge/.env` using the variables in `voice-bridge/.env.example`, then restart the bridge. `VOICESTUDIO_TTS_INSTRUCT` is optional and may only work with engines that support style instructions. If speech fails with HTTP 403, test the direct curl command in `voice-bridge/README.md` first. If the PWA port changes from `3905`, also edit `public/config.js`.

## 5. Storage and privacy notes

- The Cache API holds conversation JSON only; records older than five days are deleted when the local conversation database is accessed or a message is stored.
- Browser site data can still be cleared or evicted. This is not a backup system.
- Only the current prompt and required recent text context are sent to NVIDIA when a response is requested.
- Voice read-aloud sends the assistant's text to the local VoiceStudio app through the bridge. The bridge does not write request text or generated audio to disk.

## Troubleshooting

- **VoiceStudio · offline:** open VoiceStudio, check `http://localhost:3900/health`, and start `voice-bridge/start-bridge.bat`.
- **Origin not allowed:** add the exact PWA origin to `voice-bridge/.env` under `PWA_ORIGINS`, then restart the bridge.
- **Browser local network permission:** allow the PWA to access the local bridge when prompted.
- **TTS pacing:** the default is `VOICESTUDIO_TTS_SPEED=1.0`. Adjust within the supported `0.25`–`4.0` range, then restart the bridge.
- **TTS model/voice failure:** this build sends `model=omnivoice` and `voice=demo0001`. Check that OmniVoice is listed as available in VoiceStudio Settings → Models → TTS. Use the PWA’s **Test voice** button to generate a short sample directly in the app. The bridge automatically migrates older generic TTS and KittenTTS settings from earlier project versions.
- **Nemotron unavailable:** check `NVIDIA_API_KEY`, model access and the server terminal. TTS and Nemotron use separate services.


## VoiceStudio / OmniVoice

This version explicitly addresses the OmniVoice engine (`omnivoice`) and the `demo0001` voice profile, rather than relying on VoiceStudio’s active `tts-1` alias. Start VoiceStudio, then run `voice-bridge\start-bridge.bat`. Use the **Test voice** button in the PWA top bar; no PowerShell test is required. Old bridge `.env` values from generic TTS and KittenTTS builds are automatically upgraded in memory.


## VoiceStudio 0.5.7 compatibility update

The local TTS bridge prefers `http://127.0.0.1:3900/v1`, explicitly calls the installed `omnivoice` engine with the `demo0001` voice profile, and manually follows only loopback redirects while preserving POST and the request body. This prevents the Fetch API's automatic 301/302 redirect behavior from changing a speech POST into GET and returning 405. The PWA's Test voice button exercises the same bridge path. If VoiceStudio itself returns 405 on both loopback hosts, the issue is in that installed API route/version rather than local conversation storage.


### VoiceStudio 0.5.7 integration hardening

The bridge now prefers the documented `http://127.0.0.1:3900/v1` base URL, tries localhost as a fallback, disables automatic redirects for TTS, and follows only same-port loopback redirects while preserving POST and the JSON body. The PWA status tooltip also inspects VoiceStudio's OpenAPI schema and reports whether `POST /v1/audio/speech` is advertised. OmniVoice availability is labeled `available`, not `ready`, because installed does not mean the model is loaded.


## OmniVoice selection

This build sends `model=omnivoice` and `voice=demo0001`, based on the engine and profile surfaced by the local VoiceStudio `/v1/audio/voices` response. The underlying model is k2-fsa/OmniVoice. Since your current VoiceStudio reports CPU execution, the first speech generation may take much longer than normal; this build allows up to 10 minutes and requests shorter speech segments to get the first audio sooner.
