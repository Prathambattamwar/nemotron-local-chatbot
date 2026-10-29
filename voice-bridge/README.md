# VoiceStudio local bridge

This small service allows the Nemotron PWA to request text-to-speech from the VoiceStudio desktop application running on the same Windows PC. It uses Node.js built-ins only.

## 1. Verify VoiceStudio directly first

Start VoiceStudio and confirm its local health endpoint works: `http://127.0.0.1:3900/health`. The documented OpenAI-compatible base URL is `http://127.0.0.1:3900/v1`. Local loopback requests do not need an API key, and this bridge deliberately sends no Authorization header. The bridge tries `127.0.0.1` first, then `localhost`, regardless of an older `.env` host setting.

To isolate a VoiceStudio issue from the PWA bridge, run this in PowerShell:

```powershell
curl.exe http://127.0.0.1:3900/v1/audio/speech `
  -H "Content-Type: application/json" `
  -d '{"model":"tts-1","voice":"default","input":"Hello from VoiceStudio.","response_format":"wav"}' `
  --output speech.wav
```

If this direct request returns HTTP 403, the issue is in VoiceStudio's local API/access configuration; resolve that before testing the PWA. If it succeeds, the bridge should be able to use the same endpoint.

## 2. Start the bridge

1. Double-click `start-bridge.bat` (it creates `voice-bridge/.env` from `.env.example` on first run).
2. Keep the bridge window open while using the PWA.
3. Default bridge URL: `http://127.0.0.1:3905`. The bridge is loopback-only and is not exposed to your LAN.

The bridge first sends `POST http://127.0.0.1:3900/v1/audio/speech` with the documented OpenAI-compatible JSON body. If the installed VoiceStudio build returns 404/405 (or a JSON-decoder 400), it automatically falls back to the native `POST /generate` multipart endpoint with `text`, `engine=omnivoice`, `profile_id=demo0001`, language, and speed fields. The default speed is set to `1.0`; set `VOICESTUDIO_TTS_SPEED` in `voice-bridge/.env` between `0.25` and `4.0` to tune it. An optional `VOICESTUDIO_TTS_INSTRUCT` is available for engines that support style instructions; leave it blank otherwise. It does not send an Authorization header for local use. The default response format is WAV, matching the provided curl example. Redirects are handled manually so Node fetch cannot silently convert a redirected POST into GET (which can result in HTTP 405). Only HTTP redirects to localhost/127.0.0.1 on the same port are followed; the POST method and JSON body are preserved. For 403/404/405 the bridge retries the alternate loopback hostname; for 404/405 and JSON-decoder errors it also falls back to the documented native `/generate` multipart route. On success, the bridge returns the raw audio bytes to the PWA, and the response includes `X-VoiceStudio-Route: native-generate` for debugging.

## 3. If the PWA is hosted online

For a hosted PWA, add its exact origin to `PWA_ORIGINS` in `voice-bridge/.env`, for example `https://your-pwa.example.com`, and restart the bridge. Do not add a path. The browser may ask for local-network permission to access the bridge. VoiceStudio and the bridge must run on the same PC that opens the PWA. Do not expose port 3905 with router port forwarding or bind the bridge to `0.0.0.0`.

## Troubleshooting

- **VoiceStudio offline:** open VoiceStudio and check `http://127.0.0.1:3900/health`.
- **Direct curl gets 403:** inspect VoiceStudio local API access settings; the PWA bridge cannot fix a refusal from the direct API.
- **Bridge says origin not allowed:** add the exact PWA origin to `PWA_ORIGINS`, then restart the bridge.
- **PWA says local bridge unavailable:** ensure `start-bridge.bat` is running and port 3905 is free.
- **Speech model/voice errors:** this project uses `omnivoice` and the installed `demo0001` profile. The bridge automatically migrates old generic TTS and KittenTTS settings to this engine/profile pair. The app status chip reports whether VoiceStudio lists OmniVoice as available (this does not mean the model is already loaded; first synthesis may load it). The bridge automatically inspects `/openapi.json` for the advertised speech route and includes that information in the PWA status tooltip, so you can diagnose an API mismatch from the app without PowerShell. Use the app’s **Test voice** button to hear a short sample. If speech sounds too fast, change `VOICESTUDIO_TTS_SPEED` toward `0.85` and restart the bridge. OmniVoice supports many languages and can be slow on CPU.


For OmniVoice on a CPU, initial speech synthesis can take a while. The bridge timeout is 10 minutes; the PWA divides text into short segments so playback can begin after the first segment finishes.
