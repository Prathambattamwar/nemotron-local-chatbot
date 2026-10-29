'use strict';

// Local-only VoiceStudio bridge. Uses Node's built-in modules; no install required.
// The browser talks to this bridge, which proxies speech requests to VoiceStudio.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || Object.hasOwn(process.env, match[1])) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}
loadEnv(path.join(__dirname, '.env'));

const HOST = '127.0.0.1'; // Never expose the bridge to the LAN by default.
const PORT = Number.parseInt(process.env.VOICE_BRIDGE_PORT || '3905', 10);
const VOICESTUDIO_BASE_URL = String(process.env.VOICESTUDIO_BASE_URL || 'http://127.0.0.1:3900/v1').replace(/\/+$/, '');
// The documented local desktop API accepts loopback requests without Authorization.
// Do not send a placeholder Bearer token: some configurations reject it.
function getApiBase(value) {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/v1')) url.pathname += '/v1';
  url.search = ''; url.hash = '';
  return url.toString().replace(/\/$/, '');
}
const VOICESTUDIO_API_BASE = getApiBase(VOICESTUDIO_BASE_URL);
function getRootBase(value) { return value.replace(/\/v1$/, ''); }
const VOICESTUDIO_ROOT_BASE = getRootBase(VOICESTUDIO_API_BASE);
// This build targets VoiceStudio's k2-fsa/OmniVoice engine (API model id: omnivoice).
// Previous ZIPs used KittenTTS or the generic tts-1/default alias; migrate those stale
// settings to OmniVoice and the demo0001 profile returned by this installation's voices API.
const configuredModel = String(process.env.VOICESTUDIO_TTS_MODEL || '').trim();
const configuredVoice = String(process.env.VOICESTUDIO_TTS_VOICE || '').trim();
const modelLower = configuredModel.toLowerCase();
const voiceLower = configuredVoice.toLowerCase();
const LEGACY_MODELS = new Set(['', 'tts-1', 'tts-1-hd', 'kittentts']);
const LEGACY_VOICES = new Set(['', 'default', 'expr-voice-2-f']);
const VOICE_MODEL = LEGACY_MODELS.has(modelLower) ? 'omnivoice' : configuredModel;
const VOICE_NAME = LEGACY_VOICES.has(voiceLower) ? 'demo0001' : configuredVoice;
const VOICE_FORMAT = ['mp3', 'wav', 'opus', 'aac', 'flac', 'pcm'].includes(String(process.env.VOICESTUDIO_TTS_FORMAT || 'wav').toLowerCase()) ? String(process.env.VOICESTUDIO_TTS_FORMAT || 'wav').toLowerCase() : 'wav';
const VOICE_SPEED_RAW = Number.parseFloat(process.env.VOICESTUDIO_TTS_SPEED || '1.0');
const VOICE_SPEED = Number.isFinite(VOICE_SPEED_RAW) ? Math.max(0.25, Math.min(4, VOICE_SPEED_RAW)) : 1.0;
// Optional: support varies by VoiceStudio engine. Leave empty for maximum compatibility.
const VOICE_INSTRUCT = String(process.env.VOICESTUDIO_TTS_INSTRUCT || '').trim();
const ALLOWED_ORIGINS = new Set(String(process.env.PWA_ORIGINS || 'http://127.0.0.1:3000,http://localhost:3000')
  .split(',').map((origin) => origin.trim()).filter(Boolean));
const MAX_BODY_BYTES = 64 * 1024;
const MAX_INPUT_CHARS = 4096; // VoiceStudio's documented single-request limit.

function json(res, status, data) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}
function cors(req, res) {
  const origin = req.headers.origin;
  if (origin) {
    if (!ALLOWED_ORIGINS.has(origin)) return false;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    if (String(req.headers['access-control-request-private-network'] || '').toLowerCase() === 'true') {
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
  }
  return true;
}
async function parseJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Send a valid JSON request.'), { status: 400 }); }
}

function detailText(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    for (const key of ['message', 'detail', 'reason', 'hint', 'error', 'code']) {
      if (value[key] != null && value[key] !== value) {
        const nested = detailText(value[key]);
        if (nested) return nested;
      }
    }
    try { return JSON.stringify(value); } catch { return 'VoiceStudio returned structured error details.'; }
  }
  return String(value);
}

function isLoopbackHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

// Prefer IPv4 loopback first. On the user's Windows installation, the direct
// 127.0.0.1 test reached VoiceStudio while localhost returned HTTP 405. Try
// localhost only as a fallback; never route a local request off this machine.
function loopbackCandidates(baseUrl) {
  try {
    const original = new URL(baseUrl);
    if (!isLoopbackHost(original.hostname)) return [original.toString().replace(/\/$/, '')];
    const order = ['127.0.0.1', 'localhost'];
    const candidates = [];
    for (const hostname of order) {
      const candidate = new URL(original.toString());
      candidate.hostname = hostname;
      const value = candidate.toString().replace(/\/$/, '');
      if (!candidates.includes(value)) candidates.push(value);
    }
    return candidates;
  } catch { return [baseUrl]; }
}

function upstreamErrorText(bodyText) {
  let detail = bodyText.trim();
  try {
    const body = JSON.parse(bodyText);
    detail = detailText(body.detail ?? body.error ?? body.message ?? body);
  } catch {}
  return detail.slice(0, 900);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  if (!cors(req, res)) return json(res, 403, { ok: false, error: 'This website origin is not allowed. Add its exact origin to PWA_ORIGINS in voice-bridge/.env.' });
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    const healthBases = loopbackCandidates(VOICESTUDIO_ROOT_BASE);
    let lastFailure = null;
    for (const base of healthBases) {
      try {
        const upstream = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3500) });
        if (upstream.ok) {
          const health = await upstream.json().catch(() => ({}));
          let engineAvailable = null;
          let enginePresets = [];
          let engineReason = '';
          let speechMethods = [];
          let openApiChecked = false;
          const apiBases = loopbackCandidates(VOICESTUDIO_API_BASE);
          for (const apiBase of apiBases) {
            try {
              const voiceResponse = await fetch(`${apiBase}/audio/voices`, { signal: AbortSignal.timeout(1800), redirect: 'manual' });
              if (!voiceResponse.ok) continue;
              const voiceInfo = await voiceResponse.json().catch(() => ({}));
              const engine = Array.isArray(voiceInfo.engines) ? voiceInfo.engines.find((item) => item.id === VOICE_MODEL) : null;
              if (engine) {
                engineAvailable = Boolean(engine.available);
                enginePresets = Array.isArray(engine.preset_voices) ? engine.preset_voices : [];
                engineReason = String(engine.reason || engine.last_error || '');
              }
              break;
            } catch { /* try the other local hostname */ }
          }
          // Inspect the API schema automatically so the user can diagnose a missing
          // POST route from the PWA, without opening PowerShell.
          for (const base of healthBases) {
            try {
              const spec = await fetch(`${base}/openapi.json`, { signal: AbortSignal.timeout(1800), redirect: 'manual' });
              if (!spec.ok) continue;
              const schema = await spec.json();
              openApiChecked = true;
              const pathSpec = schema?.paths?.['/v1/audio/speech'] || schema?.paths?.['/audio/speech'];
              speechMethods = pathSpec ? Object.keys(pathSpec).filter((method) => ['get','post','put','patch','delete','options'].includes(method)) : [];
              break;
            } catch {}
          }
          return json(res, 200, { ok: true, service: 'VoiceStudio local bridge', version: health.version || null, device: health.device || null, voiceModel: VOICE_MODEL, voice: VOICE_NAME, engineAvailable, enginePresets, engineReason, speechRouteAdvertised: speechMethods.includes('post'), speechMethods, openApiChecked, apiBase: loopbackCandidates(VOICESTUDIO_API_BASE)[0] || VOICESTUDIO_API_BASE });
        }
        lastFailure = `VoiceStudio health endpoint returned HTTP ${upstream.status}.`;
      } catch (error) { lastFailure = error.message || 'Connection failed.'; }
    }
    return json(res, 503, { ok: false, error: `VoiceStudio is not healthy at ${VOICESTUDIO_ROOT_BASE}/health. ${lastFailure || ''}`.trim() });
  }

  if (req.method === 'POST' && url.pathname === '/api/tts/speech') {
    let payload;
    try { payload = await parseJson(req); }
    catch (error) { return json(res, error.status || 400, { error: error.message }); }
    const input = String(payload?.input || '').trim();
    if (!input) return json(res, 400, { error: 'There is no text to read aloud.' });
    if (input.length > MAX_INPUT_CHARS) return json(res, 413, { error: `VoiceStudio supports at most ${MAX_INPUT_CHARS.toLocaleString()} characters per speech request.` });

    try {
      const speechPayload = { model: VOICE_MODEL, voice: VOICE_NAME, input, response_format: VOICE_FORMAT, speed: VOICE_SPEED };
      if (VOICE_INSTRUCT) speechPayload.instruct = VOICE_INSTRUCT;
      const requestBody = JSON.stringify(speechPayload);
      const headers = { 'Content-Type': 'application/json', 'Accept': 'audio/*' };
      // Match the supplied VoiceStudio local API example: localhost calls need no API key.
      // First try the documented 127.0.0.1 endpoint, then try localhost only after a 403.
      const baseCandidates = loopbackCandidates(VOICESTUDIO_API_BASE);
      let finalStatus = 0;
      let finalDetail = '';
      let finalUrl = '';
      // Node fetch normally follows redirects automatically. On a 301/302/303,
      // it may turn POST into GET, which VoiceStudio then answers with 405.
      // Follow redirects manually, preserve POST+JSON, and allow only loopback HTTP
      // redirects on the same port to avoid forwarding local speech text elsewhere.
      async function postSpeechPreservingMethod(startBase) {
        let target = new URL(`${startBase.replace(/\/+$/, '')}/audio/speech`);
        for (let hop = 0; hop < 5; hop += 1) {
          const upstream = await fetch(target, {
            method: 'POST', headers, body: requestBody, redirect: 'manual',
            signal: AbortSignal.timeout(600000)
          });
          const isRedirect = [301, 302, 303, 307, 308].includes(upstream.status);
          const location = upstream.headers.get('location');
          if (!isRedirect || !location) return { upstream, target: target.toString() };
          const next = new URL(location, target);
          if (next.protocol !== 'http:' || !isLoopbackHost(next.hostname) || next.port !== target.port) {
            await upstream.body?.cancel().catch(() => {});
            return { upstream, target: target.toString(), unsafeRedirect: next.toString() };
          }
          await upstream.body?.cancel().catch(() => {});
          target = next;
        }
        throw new Error('VoiceStudio returned too many redirects for the speech endpoint.');
      }

      for (let i = 0; i < baseCandidates.length; i += 1) {
        let result;
        try {
          result = await postSpeechPreservingMethod(baseCandidates[i]);
        } catch (error) {
          finalDetail = error.message || 'Request failed.';
          if (i < baseCandidates.length - 1) continue;
          throw error;
        }
        const upstream = result.upstream;
        finalUrl = result.target;
        if (result.unsafeRedirect) finalDetail = `Refused unsafe redirect to ${result.unsafeRedirect}`;
        if (upstream.ok) {
          const audio = Buffer.from(await upstream.arrayBuffer());
          if (!audio.length) return json(res, 502, { error: 'VoiceStudio returned an empty audio file.' });
          if (audio.length > 32 * 1024 * 1024) return json(res, 502, { error: 'The generated audio is too large to return.' });
          res.writeHead(200, {
            'Content-Type': upstream.headers.get('content-type') || (VOICE_FORMAT === 'wav' ? 'audio/wav' : 'audio/mpeg'),
            'Content-Length': audio.length,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
          });
          return res.end(audio);
        }
        finalStatus = upstream.status;
        const bodyDetail = upstreamErrorText(await upstream.text().catch(() => ''));
        if (bodyDetail) finalDetail = bodyDetail;
        if ([403, 404, 405].includes(upstream.status) && i < baseCandidates.length - 1) continue;
        break;
      }
      // Compatibility path for VoiceStudio builds where the OpenAI-compatible
      // /v1/audio/speech route is absent or returns a JSON-decoder 400. The native
      // desktop API documents POST /generate as multipart/form-data and accepts
      // `text`, `engine`, `profile_id`, and speed controls.
      const shouldTryNativeGenerate = finalStatus === 404 || finalStatus === 405 ||
        (finalStatus === 400 && /json decode|json_invalid|decode error/i.test(finalDetail));
      if (shouldTryNativeGenerate) {
        for (const rootBase of loopbackCandidates(VOICESTUDIO_ROOT_BASE)) {
          const form = new FormData();
          form.set('text', input);
          form.set('engine', VOICE_MODEL);
          form.set('profile_id', VOICE_NAME);
          form.set('language', 'en');
          form.set('speed', String(VOICE_SPEED));
          form.set('max_chunk_chars', '240');
          form.set('crossfade_ms', '40');
          form.set('denoise', 'true');
          form.set('postprocess_output', 'true');
          form.set('pronounce', 'true');
          if (VOICE_INSTRUCT) form.set('instruct', VOICE_INSTRUCT);
          try {
            const nativeResponse = await fetch(`${rootBase}/generate`, {
              method: 'POST',
              body: form,
              redirect: 'manual',
              signal: AbortSignal.timeout(600000)
            });
            finalUrl = `${rootBase}/generate`;
            if ([301, 302, 303, 307, 308].includes(nativeResponse.status)) {
              const location = nativeResponse.headers.get('location');
              finalStatus = nativeResponse.status;
              finalDetail = `Native /generate returned redirect${location ? ` to ${location}` : ''}; the bridge did not follow it to avoid changing a POST or forwarding text unexpectedly.`;
              await nativeResponse.body?.cancel().catch(() => {});
              continue;
            }
            if (nativeResponse.ok) {
              const contentType = String(nativeResponse.headers.get('content-type') || '').toLowerCase();
              if (contentType.includes('application/json') || contentType.includes('text/json')) {
                const bodyText = await nativeResponse.text().catch(() => '');
                let body;
                try { body = JSON.parse(bodyText); } catch { body = null; }
                // Some builds may return an encoded audio payload rather than raw WAV.
                const encoded = body && (body.audio_base64 || body.audioBase64 || body.audio);
                if (typeof encoded === 'string' && encoded.length > 100) {
                  const audio = Buffer.from(encoded.replace(/^data:audio\/[^;]+;base64,/, ''), 'base64');
                  if (audio.length) {
                    res.writeHead(200, { 'Content-Type': body.content_type || 'audio/wav', 'Content-Length': audio.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-VoiceStudio-Route': 'native-generate' });
                    return res.end(audio);
                  }
                }
                finalStatus = 502;
                finalDetail = `Native /generate returned JSON instead of audio: ${detailText(body?.detail ?? body?.error ?? body?.message ?? body ?? bodyText)}`;
                continue;
              }
              const audio = Buffer.from(await nativeResponse.arrayBuffer());
              if (audio.length && audio.length <= 32 * 1024 * 1024) {
                res.writeHead(200, {
                  'Content-Type': nativeResponse.headers.get('content-type') || 'audio/wav',
                  'Content-Length': audio.length,
                  'Cache-Control': 'no-store',
                  'X-Content-Type-Options': 'nosniff',
                  'X-VoiceStudio-Route': 'native-generate'
                });
                return res.end(audio);
              }
              finalStatus = 502;
              finalDetail = audio.length ? 'Native /generate returned audio larger than 32 MB.' : 'Native /generate returned an empty response.';
              continue;
            }
            finalStatus = nativeResponse.status;
            finalDetail = upstreamErrorText(await nativeResponse.text().catch(() => '')) || `Native /generate returned HTTP ${nativeResponse.status}.`;
            if (![404, 405].includes(nativeResponse.status)) break;
          } catch (error) {
            finalStatus = 502;
            finalDetail = `Native /generate failed at ${rootBase}: ${error.message || 'request failed'}`;
          }
        }
      }

      let message = `VoiceStudio rejected speech generation (HTTP ${finalStatus || 502})`;
      if (finalDetail) message += `: ${finalDetail}`;
      if (finalStatus === 403) message += ' — the local API still denies the request. Test the exact curl command in voice-bridge/README.md; if curl also returns 403, check VoiceStudio local API access settings.';
      if (finalStatus === 401) message += ' — local requests normally do not need a key; check whether remote access is enabled.';
      if (finalStatus === 400) message += ` — current request uses model '${VOICE_MODEL}' and voice '${VOICE_NAME}'. Check that OmniVoice is available and the demo0001 profile exists in VoiceStudio.`;
      if (finalStatus === 405) message += ' — both the OpenAI-compatible speech route and the native /generate fallback rejected POST. Check the installed VoiceStudio version/API routes; /v1/audio/speech is not accepting POST and /generate did not succeed.';
      return json(res, 502, { error: message, status: finalStatus, model: VOICE_MODEL, voice: VOICE_NAME, endpoint: finalUrl || null });
    } catch (error) {
      const timeout = error.name === 'TimeoutError' || error.name === 'AbortError';
      return json(res, 502, { error: timeout ? 'VoiceStudio took too long to generate speech.' : 'Cannot reach VoiceStudio. Make sure the desktop app is running and its local API is available at 127.0.0.1:3900.' });
    }
  }
  return json(res, 404, { error: 'Not found.' });
});

server.listen(PORT, HOST, () => {
  console.log(`VoiceStudio bridge listening only on http://${HOST}:${PORT}`);
  console.log(`VoiceStudio API base (preferred): ${loopbackCandidates(VOICESTUDIO_API_BASE).join(' then ')}`);
  console.log(`Allowed PWA origins: ${[...ALLOWED_ORIGINS].join(', ')}`);
  console.log('Keep this terminal running while using Read aloud.');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
