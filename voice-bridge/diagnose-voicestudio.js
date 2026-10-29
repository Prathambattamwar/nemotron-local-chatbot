"use strict";
const fs = require("node:fs");
const path = require("node:path");
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || Object.hasOwn(process.env, m[1])) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[m[1]] = value;
  }
}
loadEnv(path.join(__dirname, ".env"));
const key = String(process.env.VOICESTUDIO_API_KEY ?? "local").trim();
const candidates = [
  "http://localhost:3900/v1/audio/speech",
  "http://127.0.0.1:3900/v1/audio/speech"
];
const payload = JSON.stringify({ model: "tts-1", voice: "default", input: "Hello from the VoiceStudio diagnostic test.", response_format: "wav", speed: 1 });
(async () => {
  console.log("VoiceStudio direct endpoint diagnostic\n");
  for (const url of candidates) {
    console.log(`Testing POST ${url}`);
    try {
      const headers = { "Content-Type": "application/json", "Accept": "audio/*" };
      if (key) headers.Authorization = `Bearer ${key}`;
      const response = await fetch(url, { method: "POST", headers, body: payload, redirect: "manual", signal: AbortSignal.timeout(120000) });
      console.log(`HTTP ${response.status} ${response.statusText}`);
      console.log(`Allow: ${response.headers.get("allow") || "(not sent)"}`);
      console.log(`Location: ${response.headers.get("location") || "(not sent)"}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (response.ok && bytes.length) {
        const output = path.join(__dirname, `speech-test-${url.includes("localhost") ? "localhost" : "127001"}.wav`);
        fs.writeFileSync(output, bytes);
        console.log(`Audio saved: ${output} (${bytes.length} bytes)`);
      } else {
        console.log(`Response: ${bytes.toString("utf8", 0, Math.min(bytes.length, 600)) || "(empty body)"}`);
      }
    } catch (error) {
      console.log(`Request failed: ${error.message}`);
    }
    console.log("");
  }
  console.log("If both POST requests return 405, share the output above; the status and headers identify the route/method the installed VoiceStudio API accepts.");
})();
