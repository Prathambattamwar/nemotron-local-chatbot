'use strict';
require('dotenv').config();
const express = require('express');
const crypto = require('node:crypto');
const app = express();
const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const NVIDIA_BASE_URL = (process.env.NVIDIA_CHAT_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, '');
const NVIDIA_MODEL = String(process.env.NVIDIA_MODEL || 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning').trim();
const MAX_MESSAGE_CHARS = 16000;
const MAX_HISTORY_MESSAGES = 24;
const NVIDIA_MAX_TOKENS = clampInt(process.env.NVIDIA_MAX_TOKENS, 4096, 128, 16384);
const NVIDIA_TEMPERATURE = clampFloat(process.env.NVIDIA_TEMPERATURE, 0.2, 0, 2);
const NVIDIA_ENABLE_THINKING = String(process.env.NVIDIA_ENABLE_THINKING || 'false').toLowerCase() === 'true';
function clampInt(value, fallback, min, max) { const n = Number.parseInt(value || '', 10); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback; }
function clampFloat(value, fallback, min, max) { const n = Number.parseFloat(value || ''); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback; }
function sendError(res, status, error) { return res.status(status).json({ error }); }
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
let queue = Promise.resolve();
function queued(task) { const p = queue.then(task, task); queue = p.then(() => undefined, () => undefined); return p; }
async function nvidiaFetch(url, options, retries=3) {
  return queued(async () => {
    for (let attempt=0;;attempt++) {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(240000) });
      if (![429,503].includes(response.status) || attempt >= retries) return response;
      try { await response.body?.cancel(); } catch {}
      const retryAfter = Number(response.headers.get('retry-after'));
      await wait(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(15000, retryAfter*1000) : Math.min(8000, 2000*2**attempt));
    }
  });
}
app.disable('x-powered-by');
app.use(express.json({ limit: '512kb' }));
app.use(express.static(require('node:path').join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/api/health', (_req,res) => res.json({ ok:true, model:NVIDIA_MODEL, storage:'browser-cache', retentionDays:5, mode:'text-only', serverConversationStorage:false }));
app.post('/api/generate', async (req,res) => {
  const message = String(req.body?.message || '').trim();
  if (!message) return sendError(res,400,'Type a message first.');
  if (message.length > MAX_MESSAGE_CHARS) return sendError(res,413,`Messages must be ${MAX_MESSAGE_CHARS.toLocaleString()} characters or less.`);
  if (!process.env.NVIDIA_API_KEY || process.env.NVIDIA_API_KEY === 'put_your_nvidia_api_key_here') return sendError(res,503,'NVIDIA_API_KEY is missing. Add it to .env and restart the server.');
  let history = req.body?.history ?? [];
  if (!Array.isArray(history)) return sendError(res,400,'Conversation context must be a message list.');
  history = history.slice(-(MAX_HISTORY_MESSAGES-1)).filter(m => m && ['user','assistant'].includes(m.role) && typeof m.content === 'string').map(m => ({ role:m.role, content:m.content.slice(0,MAX_MESSAGE_CHARS) }));
  const payload = { model:NVIDIA_MODEL, messages:[{ role:'system', content:'You are a helpful, accurate, friendly text-only assistant. Answer directly and use Markdown when useful. This interface accepts text only; do not claim to see images, hear audio, or inspect files.' }, ...history, { role:'user', content:message }], temperature:NVIDIA_TEMPERATURE, top_p:0.95, max_tokens:NVIDIA_MAX_TOKENS, stream:false, chat_template_kwargs:{ enable_thinking:NVIDIA_ENABLE_THINKING } };
  try {
    const response = await nvidiaFetch(`${NVIDIA_BASE_URL}/chat/completions`, { method:'POST', headers:{ Authorization:`Bearer ${process.env.NVIDIA_API_KEY}`, 'Content-Type':'application/json', Accept:'application/json' }, body:JSON.stringify(payload) });
    const body = await response.json().catch(()=>({}));
    if (!response.ok) {
      if ([429,503].includes(response.status)) return sendError(res,503,'NVIDIA is temporarily busy after automatic retries. Your conversation remains on this device; try again shortly.');
      if ([401,403].includes(response.status)) return sendError(res,502,'NVIDIA rejected the API key. Check NVIDIA_API_KEY and model access.');
      return sendError(res,502,`NVIDIA request failed (HTTP ${response.status}).`);
    }
    const answer = body?.choices?.[0]?.message?.content;
    const text = typeof answer === 'string' ? answer : Array.isArray(answer) ? answer.map(p=>typeof p==='string'?p:(p?.text||'')).join('\n').trim() : '';
    if (!text) return sendError(res,502,'NVIDIA returned an empty answer.');
    // No prompt, response, user, or conversation is written to disk or a database.
    return res.json({ message:{ id:crypto.randomUUID(), role:'assistant', content:text, created_at:Math.floor(Date.now()/1000) } });
  } catch (error) {
    console.error('NVIDIA request failed:', error.name || 'Error');
    return sendError(res, error.name==='TimeoutError'||error.name==='AbortError'?504:502, error.name==='TimeoutError'||error.name==='AbortError'?'NVIDIA took too long to answer. Try again.':'Could not reach NVIDIA. Check the network and API settings.');
  }
});
app.use((err,_req,res,_next)=>{ if (err instanceof SyntaxError && 'body' in err) return sendError(res,400,'Invalid JSON request.'); console.error('Request failed:',err.message); return sendError(res,500,'Unexpected server error.'); });
app.listen(PORT,()=>console.log(`Nemotron text chatbot running at http://127.0.0.1:${PORT}\nModel: ${NVIDIA_MODEL}\nConversation storage: browser Cache API (5-day retention)\nSQLite/authentication: disabled`));
