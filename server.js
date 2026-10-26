'use strict';

require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { extractAttachmentContent } = require('./media');

const app = express();
const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const SESSION_DAYS = clampInt(process.env.SESSION_DAYS, 30, 1, 365);
const NVIDIA_BASE_URL = (process.env.NVIDIA_CHAT_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, '');
const REQUESTED_MODEL = String(process.env.NVIDIA_MODEL || '').trim();
// Automatically migrate the old starter-config default when an existing .env is retained.
const NVIDIA_MODEL = (!REQUESTED_MODEL || REQUESTED_MODEL === 'nvidia/nemotron-3-ultra-550b-a55b')
  ? 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning'
  : REQUESTED_MODEL;
const NVIDIA_MAX_TOKENS = clampInt(process.env.NVIDIA_MAX_TOKENS, 4096, 128, 16384);
const NVIDIA_TEMPERATURE = clampFloat(process.env.NVIDIA_TEMPERATURE, 0.2, 0, 2);
const NVIDIA_ENABLE_THINKING = String(process.env.NVIDIA_ENABLE_THINKING || 'false').toLowerCase() === 'true';
const SESSION_COOKIE = 'nemotron_chat_session';
const MAX_MESSAGE_CHARS = 16000;
const MAX_ATTACHMENT_FILES = 5;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 40 * 1024 * 1024;
const MAX_CONTEXT_MEDIA_BYTES = 8 * 1024 * 1024;
const MAX_HISTORY_MESSAGES = 24;
const MAX_EXTRACTED_HISTORY_CHARS = 30000;
const MAX_EXTRACTED_FILE_CHARS = 12000;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES, files: MAX_ATTACHMENT_FILES, fields: 2, parts: MAX_ATTACHMENT_FILES + 2 }
});

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}
function clampFloat(value, fallback, min, max) {
  const parsed = Number.parseFloat(value || '');
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}
function nowSeconds() { return Math.floor(Date.now() / 1000); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function randomToken() { return crypto.randomBytes(32).toString('base64url'); }
function sendError(res, status, error) { return res.status(status).json({ error }); }

// Serialize calls from this local app so a burst of users/tabs does not overwhelm
// the hosted inference worker. External NVIDIA capacity limits can still occur.
let nvidiaQueueTail = Promise.resolve();
function withNvidiaQueue(task) {
  const current = nvidiaQueueTail.then(task, task);
  nvidiaQueueTail = current.then(() => undefined, () => undefined);
  return current;
}
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function retryDelayMs(response, retryIndex) {
  const retryAfter = response.headers?.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const asDate = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(asDate) && asDate > 0) return Math.min(15000, Math.max(1000, asDate));
  }
  // 2s, 4s, 8s, with slight jitter to avoid synchronized retry storms.
  return Math.min(8000, 2000 * (2 ** retryIndex)) + Math.floor(Math.random() * 500);
}
async function fetchNvidiaWithBackoff(url, options, maxRetries = 3) {
  return withNvidiaQueue(async () => {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(240000) });
      const retryable = response.status === 429 || response.status === 503;
      if (!retryable || attempt >= maxRetries) return response;
      const delay = retryDelayMs(response, attempt);
      // Do not log provider response bodies: they can contain noisy internal errors.
      console.info(`AI service is busy; retrying automatically (${attempt + 1}/${maxRetries}).`);
      try { await response.body?.cancel(); } catch { /* response is already closed */ }
      await wait(delay);
    }
  });
}

function cleanTitle(text) {
  const oneLine = String(text || '').replace(/\s+/g, ' ').trim();
  return oneLine.length > 56 ? `${oneLine.slice(0, 53)}…` : (oneLine || 'New chat');
}

const dbPath = path.resolve(process.env.DATABASE_PATH || './data/chatbot.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT 'New chat',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_conversations_user_updated ON conversations(user_id, updated_at DESC);
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id, id);
  CREATE TABLE IF NOT EXISTS message_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    data_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    data BLOB NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_attachments_message ON message_attachments(message_id, id);
  CREATE INDEX IF NOT EXISTS idx_attachments_user_type ON message_attachments(user_id, data_type);
  CREATE TABLE IF NOT EXISTS attachment_parts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attachment_id INTEGER NOT NULL REFERENCES message_attachments(id) ON DELETE CASCADE,
    part_index INTEGER NOT NULL,
    part_type TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    data BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(attachment_id, part_index)
  );
  CREATE INDEX IF NOT EXISTS idx_attachment_parts_parent ON attachment_parts(attachment_id, part_index);
`);

// Expired sessions are cleared at startup and periodically during request handling.
db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowSeconds());

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

function auth(req, res, next) {
  const rawToken = req.cookiesToken || readCookie(req.headers.cookie, SESSION_COOKIE);
  if (!rawToken) return sendError(res, 401, 'Please sign in to continue.');

  const hashed = sha256(rawToken);
  const session = db.prepare(`
    SELECT s.user_id, s.expires_at, u.username
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `).get(hashed);
  if (!session || session.expires_at <= nowSeconds()) {
    if (session) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashed);
    clearSessionCookie(res);
    return sendError(res, 401, 'Your session expired. Please sign in again.');
  }
  req.user = { id: session.user_id, username: session.username };
  req.sessionHash = hashed;
  next();
}
function readCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const equals = part.indexOf('=');
    if (equals < 0) continue;
    if (part.slice(0, equals).trim() === name) {
      try { return decodeURIComponent(part.slice(equals + 1).trim()); } catch { return null; }
    }
  }
  return null;
}
function setSessionCookie(res, token) {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  // This is intended for localhost. HTTPS deployments should add the Secure flag.
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}
function ownedConversation(conversationId, userId) {
  return db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(conversationId, userId);
}
function classifyDataType(mimeType, fileName = '') {
  const mime = String(mimeType || '').toLowerCase();
  const name = String(fileName || '').toLowerCase();
  if (mime === 'image/svg+xml' || name.endsWith('.svg')) return 'document';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'application/json' || name.endsWith('.json') || mime === 'text/csv' || name.endsWith('.csv') || name.endsWith('.xml')) return 'data';
  if (mime === 'text/plain' || mime.startsWith('text/')) return 'text';
  if (mime.includes('pdf') || mime.includes('word') || mime.includes('officedocument') || mime.includes('presentation') || mime.includes('spreadsheet') || /\.(pdf|doc|docx|ppt|pptx|xls|xlsx|odt|ods|odp)$/i.test(name)) return 'document';
  if (mime.includes('zip') || mime.includes('compressed') || /\.(zip|7z|rar|tar|gz)$/i.test(name)) return 'archive';
  return 'file';
}
function safeOriginalName(value) {
  const name = String(value || 'attachment').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (name || 'attachment').slice(0, 255);
}
function parseJson(value, fallback = {}) {
  try { return JSON.parse(String(value || '')); } catch { return fallback; }
}
function publicAttachments(messageId, userId) {
  return db.prepare(`SELECT id, original_name, mime_type, data_type, size_bytes, sha256, metadata_json, created_at
    FROM message_attachments WHERE message_id = ? AND user_id = ? ORDER BY id ASC`)
    .all(messageId, userId).map((row) => {
      const metadata = parseJson(row.metadata_json);
      return {
        id: row.id,
        original_name: row.original_name,
        mime_type: row.mime_type,
        data_type: row.data_type,
        size_bytes: row.size_bytes,
        sha256: row.sha256,
        created_at: row.created_at,
        parsed: Boolean(metadata.extractedText || metadata.generatedPartCount),
        processing_note: metadata.note || '',
        parser: metadata.parser || 'none',
        url: `/api/attachments/${row.id}/content`
      };
    });
}
function publicMessage(row, userId) {
  return { ...row, attachments: publicAttachments(row.id, userId) };
}
function getUserMessages(conversationId, limit = 80, userId) {
  const rows = db.prepare(`SELECT id, role, content, created_at FROM messages
    WHERE conversation_id = ? ORDER BY id DESC LIMIT ?`).all(conversationId, limit).reverse();
  return rows.map((row) => ({ ...row, attachments: publicAttachments(row.id, userId) }));
}
function getInternalAttachments(messageId, userId) {
  return db.prepare(`SELECT id, original_name, mime_type, data_type, size_bytes, metadata_json
    FROM message_attachments WHERE message_id = ? AND user_id = ? ORDER BY id ASC`).all(messageId, userId)
    .map((row) => ({ ...row, metadata: parseJson(row.metadata_json) }));
}
function normalizedExtension(name) { return path.extname(String(name || '')).toLowerCase(); }
function bestEffortMime(file) {
  const ext = normalizedExtension(file.originalname);
  const map = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.heic': 'image/heic',
    '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.aac': 'audio/aac',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
    '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.csv': 'text/csv', '.json': 'application/json', '.txt': 'text/plain', '.md': 'text/markdown'
  };
  return map[ext] || String(file.mimetype || 'application/octet-stream').slice(0, 160);
}
function messageAttachmentsText(attachments, remainingBudget) {
  const chunks = [];
  let used = 0;
  for (const attachment of attachments) {
    const metadata = attachment.metadata || {};
    const extracted = String(metadata.extractedText || '').trim();
    if (extracted && remainingBudget.value > 0) {
      const allowance = Math.min(MAX_EXTRACTED_FILE_CHARS, remainingBudget.value);
      const clipped = extracted.length > allowance ? `${extracted.slice(0, allowance)}\n[Extracted text truncated for model context.]` : extracted;
      chunks.push(`[Extracted content from ${attachment.original_name}]\n${clipped}`);
      used += Math.min(extracted.length, allowance);
      remainingBudget.value -= Math.min(extracted.length, allowance);
    } else if (!extracted && metadata.note) {
      chunks.push(`[File processing note for ${attachment.original_name}: ${metadata.note}]`);
    }
  }
  return { text: chunks.join('\n\n'), used };
}
async function imagePartFromAttachment(attachmentId, userId) {
  const file = db.prepare(`SELECT original_name, mime_type, data FROM message_attachments WHERE id = ? AND user_id = ?`).get(attachmentId, userId);
  if (!file) return { parts: [], note: 'An attachment could not be loaded.' };
  try {
    // Normalize common browser image formats to JPEG; send pixels, not a filename, to Omni.
    const jpeg = await sharp(file.data, { animated: false, limitInputPixels: 40000000 })
      .rotate()
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    return { parts: [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } }], note: '' };
  } catch (error) {
    return { parts: [], note: `Image ${file.original_name} could not be converted for model input (${String(error.message || 'image decoding failed').slice(0, 120)}).` };
  }
}
function supportedAudioMime(file) {
  const ext = normalizedExtension(file.original_name);
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.flac') return 'audio/flac';
  const mime = String(file.mime_type || '').toLowerCase();
  if (mime === 'audio/wav' || mime === 'audio/x-wav') return 'audio/wav';
  if (mime === 'audio/mpeg' || mime === 'audio/mp3') return 'audio/mpeg';
  if (mime === 'audio/flac' || mime === 'audio/x-flac') return 'audio/flac';
  return null;
}
async function multimodalPartsForAttachment(attachment, userId) {
  const parts = [];
  const notes = [];
  const ext = normalizedExtension(attachment.original_name);
  const mime = String(attachment.mime_type || '').toLowerCase();
  if (attachment.data_type === 'image') {
    const result = await imagePartFromAttachment(attachment.id, userId);
    parts.push(...result.parts);
    if (result.note) notes.push(result.note);
  } else if (attachment.data_type === 'audio') {
    const audioMime = supportedAudioMime(attachment);
    if (!audioMime) {
      notes.push(`${attachment.original_name} is stored locally but the model API supports WAV, MP3, or FLAC audio input. Convert it to one of those formats to analyze it.`);
    } else {
      const row = db.prepare('SELECT data FROM message_attachments WHERE id = ? AND user_id = ?').get(attachment.id, userId);
      if (row) parts.push({ type: 'audio_url', audio_url: { url: `data:${audioMime};base64,${row.data.toString('base64')}` } });
    }
  } else if (attachment.data_type === 'video') {
    if (ext !== '.mp4' && mime !== 'video/mp4') {
      notes.push(`${attachment.original_name} is stored locally; direct video analysis requires MP4. Convert it to MP4 to analyze video/audio content.`);
    } else {
      const row = db.prepare('SELECT data FROM message_attachments WHERE id = ? AND user_id = ?').get(attachment.id, userId);
      if (row) parts.push({ type: 'video_url', video_url: { url: `data:video/mp4;base64,${row.data.toString('base64')}` } });
    }
  }
  if (attachment.data_type === 'document') {
    const derived = db.prepare(`SELECT part_type, mime_type, data FROM attachment_parts WHERE attachment_id = ? ORDER BY part_index LIMIT 6`).all(attachment.id);
    for (const part of derived) {
      if (part.mime_type === 'image/jpeg' || part.mime_type === 'image/png') {
        parts.push({ type: 'image_url', image_url: { url: `data:${part.mime_type};base64,${part.data.toString('base64')}` } });
      }
    }
  }
  return { parts, notes };
}
async function buildModelHistory(conversationId, userId, currentMessageId) {
  const rows = db.prepare(`SELECT id, role, content, created_at FROM messages
    WHERE conversation_id = ? ORDER BY id DESC LIMIT ?`).all(conversationId, MAX_HISTORY_MESSAGES).reverse();
  const messages = rows.map((row) => ({ ...row, internalAttachments: row.role === 'user' ? getInternalAttachments(row.id, userId) : [] }));
  const current = messages.find((row) => row.id === currentMessageId);
  const currentHasAttachments = Boolean(current?.internalAttachments.length);
  let contextualMediaMessageId = currentHasAttachments ? currentMessageId : null;
  if (!contextualMediaMessageId) {
    // Preserve short-term references to the most recently attached media, but avoid re-sending large files on every turn.
    const recent = messages.slice(-8).reverse().find((row) => row.role === 'user' && row.internalAttachments.length > 0);
    if (recent) {
      const total = recent.internalAttachments.reduce((sum, file) => sum + file.size_bytes, 0);
      if (total <= MAX_CONTEXT_MEDIA_BYTES) contextualMediaMessageId = recent.id;
    }
  }

  const budget = { value: MAX_EXTRACTED_HISTORY_CHARS };
  const output = [];
  for (const row of messages) {
    if (row.role !== 'user' || !row.internalAttachments.length) {
      output.push({ role: row.role, content: row.content });
      continue;
    }
    const extracted = messageAttachmentsText(row.internalAttachments, budget);
    const infoLines = [];
    for (const attachment of row.internalAttachments) {
      const meta = attachment.metadata;
      if (!meta.extractedText && !meta.generatedPartCount && !meta.note) {
        infoLines.push(`[Attachment: ${attachment.original_name}; ${attachment.data_type}; ${attachment.mime_type}; ${attachment.size_bytes} bytes.]`);
      }
    }
    let text = row.content;
    if (extracted.text) text += `\n\n${extracted.text}`;
    if (infoLines.length) text += `\n\n${infoLines.join('\n')}`;
    const mediaParts = [];
    if (row.id === contextualMediaMessageId) {
      for (const attachment of row.internalAttachments) {
        const result = await multimodalPartsForAttachment(attachment, userId);
        mediaParts.push(...result.parts);
        if (result.notes.length) text += `\n\n${result.notes.join('\n')}`;
      }
    } else if (row.internalAttachments.some((file) => ['image', 'audio', 'video'].includes(file.data_type))) {
      text += '\n[Media from this earlier turn is saved locally but is not included again in this request.]';
    }
    output.push({ role: 'user', content: mediaParts.length ? [{ type: 'text', text }, ...mediaParts] : text });
  }
  return { messages: output, hasMediaParts: output.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type !== 'text')) };
}

// Register a local account. Passwords are hashed; only the password hash is stored.
app.post('/api/register', async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!/^[a-zA-Z0-9_.-]{3,30}$/.test(username)) {
    return sendError(res, 400, 'Username must be 3–30 characters and use only letters, numbers, dots, dashes or underscores.');
  }
  if (password.length < 8 || password.length > 200) {
    return sendError(res, 400, 'Password must be at least 8 characters long.');
  }
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const result = db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
      .run(username, passwordHash, nowSeconds());
    const token = createSession(Number(result.lastInsertRowid));
    setSessionCookie(res, token);
    return res.status(201).json({ user: { id: Number(result.lastInsertRowid), username } });
  } catch (error) {
    if (String(error.code || '').includes('SQLITE_CONSTRAINT')) {
      return sendError(res, 409, 'That username is already taken. Choose another one.');
    }
    console.error('Registration failed:', error.message);
    return sendError(res, 500, 'Could not create the account. Please try again.');
  }
});

app.post('/api/login', async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const user = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return sendError(res, 401, 'Incorrect username or password.');
  }
  const token = createSession(user.id);
  setSessionCookie(res, token);
  return res.json({ user: { id: user.id, username: user.username } });
});

function createSession(userId) {
  const token = randomToken();
  const timestamp = nowSeconds();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), userId, timestamp + SESSION_DAYS * 24 * 60 * 60, timestamp);
  return token;
}

app.post('/api/logout', (req, res) => {
  const rawToken = readCookie(req.headers.cookie, SESSION_COOKIE);
  if (rawToken) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(rawToken));
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  res.json({ user: req.user });
});

app.get('/api/conversations', auth, (req, res) => {
  const conversations = db.prepare(`
    SELECT c.id, c.title, c.created_at, c.updated_at,
      (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message
    FROM conversations c WHERE c.user_id = ? ORDER BY c.updated_at DESC, c.created_at DESC
  `).all(req.user.id);
  res.json({ conversations });
});

app.post('/api/conversations', auth, (_req, res) => {
  return sendError(res, 410, 'Conversation creation is now device-only. Update the PWA to the local-first version.');
});

app.get('/api/conversations/:id/messages', auth, (req, res) => {
  const conversation = ownedConversation(req.params.id, req.user.id);
  if (!conversation) return sendError(res, 404, 'Conversation not found.');
  const rows = db.prepare('SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id ASC')
    .all(conversation.id);
  const messages = rows.map((row) => publicMessage(row, req.user.id));
  res.json({ conversation: { id: conversation.id, title: conversation.title }, messages });
});

app.patch('/api/conversations/:id', auth, (_req, res) => sendError(res, 410, 'Conversation edits are now device-only.'));


app.delete('/api/conversations/:id', auth, (_req, res) => sendError(res, 410, 'Delete conversations from the PWA local history.'));



// Stateless AI endpoint for device-only conversation history. The server receives only
// the context needed for this request and never inserts the prompt, response, or files into SQLite.
app.post('/api/generate', auth, upload.array('attachments', MAX_ATTACHMENT_FILES), async (req, res) => {
  const typedMessage = String(req.body?.message || '').trim();
  const files = Array.isArray(req.files) ? req.files : [];
  if (!typedMessage && files.length === 0) return sendError(res, 400, 'Type a message or attach at least one file.');
  if (typedMessage.length > MAX_MESSAGE_CHARS) return sendError(res, 413, `Messages must be ${MAX_MESSAGE_CHARS.toLocaleString()} characters or less.`);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) return sendError(res, 413, 'Attachments must total 40 MB or less per message.');
  if (!process.env.NVIDIA_API_KEY || process.env.NVIDIA_API_KEY === 'put_your_nvidia_api_key_here') {
    return sendError(res, 503, 'The NVIDIA API key is missing. Add NVIDIA_API_KEY to .env and restart the app. Your conversation remains saved on this device.');
  }
  let history = [];
  try { history = JSON.parse(String(req.body?.history || '[]')); } catch { return sendError(res, 400, 'The conversation context was invalid.'); }
  if (!Array.isArray(history)) return sendError(res, 400, 'The conversation context must be a message list.');
  history = history.slice(-MAX_HISTORY_MESSAGES + 1).filter(m => m && ['user','assistant'].includes(m.role) && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }));

  const currentText = typedMessage || 'Please analyze the attached file(s). Describe their contents and summarize the important details.';
  const contentParts = [{ type: 'text', text: currentText }];
  const notes = [];
  for (const file of files) {
    const originalName = safeOriginalName(file.originalname);
    const mimeType = bestEffortMime({ ...file, originalname: originalName });
    const dataType = classifyDataType(mimeType, originalName);
    if (dataType === 'image') {
      try {
        const jpeg = await sharp(file.buffer, { animated: false, limitInputPixels: 40000000 }).rotate()
          .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
        contentParts.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } });
      } catch { notes.push(`Image ${originalName} could not be decoded for analysis.`); }
    } else if (dataType === 'audio') {
      const ext = normalizedExtension(originalName);
      const audioMime = ext === '.wav' ? 'audio/wav' : ext === '.mp3' ? 'audio/mpeg' : ext === '.flac' ? 'audio/flac' : null;
      if (audioMime) contentParts.push({ type: 'audio_url', audio_url: { url: `data:${audioMime};base64,${file.buffer.toString('base64')}` } });
      else notes.push(`${originalName}: direct audio analysis supports WAV, MP3, or FLAC.`);
    } else if (dataType === 'video') {
      if (normalizedExtension(originalName) === '.mp4' || mimeType === 'video/mp4') {
        contentParts.push({ type: 'video_url', video_url: { url: `data:video/mp4;base64,${file.buffer.toString('base64')}` } });
      } else notes.push(`${originalName}: direct video analysis requires MP4.`);
    } else {
      try {
        const extracted = await extractAttachmentContent(file.buffer, originalName, mimeType);
        if (extracted.text) contentParts[0].text += `\n\n[Extracted content from ${originalName}]\n${String(extracted.text).slice(0, MAX_EXTRACTED_FILE_CHARS)}`;
        for (const part of (extracted.generatedParts || []).slice(0, 6)) {
          if ((part.mime_type === 'image/jpeg' || part.mime_type === 'image/png') && part.data) {
            contentParts.push({ type: 'image_url', image_url: { url: `data:${part.mime_type};base64,${Buffer.from(part.data).toString('base64')}` } });
          }
        }
        if (!extracted.text && !(extracted.generatedParts || []).length) notes.push(`${originalName} was received but no readable content could be extracted.`);
        if (extracted.note) notes.push(`${originalName}: ${String(extracted.note).slice(0, 300)}`);
      } catch { notes.push(`${originalName}: document parsing failed.`); }
    }
  }
  if (notes.length) contentParts[0].text += `\n\nFile processing notes:\n${notes.join('\n')}`;
  const modelMessages = [...history, { role: 'user', content: contentParts.length > 1 ? contentParts : contentParts[0].text }];
  const payload = {
    model: NVIDIA_MODEL,
    messages: [
      { role: 'system', content: 'You are a helpful, accurate, friendly multimodal assistant. Answer the user directly, structure longer answers clearly, and use Markdown when useful. Analyze only the content actually supplied in this request.' },
      ...modelMessages
    ],
    temperature: NVIDIA_TEMPERATURE, top_p: 0.95, max_tokens: NVIDIA_MAX_TOKENS, stream: false,
    chat_template_kwargs: { enable_thinking: NVIDIA_ENABLE_THINKING }
  };
  if (modelMessages.some(m => Array.isArray(m.content) && m.content.some(part => part.type === 'video_url'))) {
    payload.mm_processor_kwargs = { use_audio_in_video: true };
    payload.media_io_kwargs = { video: { fps: 1.0, num_frames: -1 } };
  }
  try {
    const response = await fetchNvidiaWithBackoff(`${NVIDIA_BASE_URL}/chat/completions`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload)
    }, 3);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 429 || response.status === 503) {
        return res.json({ aiSkipped: true, notice: 'The AI service is temporarily busy after automatic retries. Your message is still saved on this device; please try again shortly.' });
      }
      const publicMessage = response.status === 401 || response.status === 403
        ? 'NVIDIA rejected the API key. Check NVIDIA_API_KEY and model access.'
        : response.status === 413 || response.status === 415
          ? 'NVIDIA rejected the media payload. Try fewer or smaller supported files.'
          : `NVIDIA request failed (HTTP ${response.status}). Your message remains saved on this device.`;
      return sendError(res, 502, publicMessage);
    }
    const answer = body?.choices?.[0]?.message?.content;
    const answerText = typeof answer === 'string' ? answer : Array.isArray(answer) ? answer.map(p => typeof p === 'string' ? p : (p?.text || '')).join('\n').trim() : '';
    if (!answerText) return sendError(res, 502, 'NVIDIA returned an empty answer. Your prompt remains saved on this device.');
    return res.json({ message: { id: crypto.randomUUID(), role: 'assistant', content: answerText, created_at: nowSeconds() } });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return sendError(res, 504, 'NVIDIA took too long to answer. Your message remains saved on this device; try again with fewer or smaller files.');
    console.error('Stateless AI request failed:', error.message);
    return sendError(res, 502, 'Could not reach NVIDIA. Your message remains saved on this device. Check the network and API settings.');
  }
});

app.post('/api/conversations/:id/messages', auth, (_req, res) => sendError(res, 410, 'This endpoint is retired. Use the stateless /api/generate endpoint.'));

app.post('/api/conversations/:id/messages', auth, upload.array('attachments', MAX_ATTACHMENT_FILES), async (req, res) => {
  const conversation = ownedConversation(req.params.id, req.user.id);
  if (!conversation) return sendError(res, 404, 'Conversation not found.');

  const typedMessage = String(req.body?.message || '').trim();
  const files = Array.isArray(req.files) ? req.files : [];
  if (!typedMessage && files.length === 0) return sendError(res, 400, 'Type a message or attach at least one file.');
  if (typedMessage.length > MAX_MESSAGE_CHARS) return sendError(res, 413, `Messages must be ${MAX_MESSAGE_CHARS.toLocaleString()} characters or less.`);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
    return sendError(res, 413, 'Attachments must total 40 MB or less per message. Remove some files and try again.');
  }

  const timestamp = nowSeconds();
  const names = files.map((file) => safeOriginalName(file.originalname));
  const message = typedMessage || 'Please analyze the attached file(s). Describe their contents and summarize the important details.';
  const storedContent = message;
  const processedFiles = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const originalName = names[index];
    const mimeType = bestEffortMime({ ...file, originalname: originalName });
    const dataType = classifyDataType(mimeType, originalName);
    let extracted = { text: '', parser: 'native-multimodal', generatedParts: [], note: '' };
    // Native multimodal inputs are sent as image/audio/video parts. Other formats go through actual content extraction.
    if (!['image', 'audio', 'video'].includes(dataType)) {
      extracted = await extractAttachmentContent(file.buffer, originalName, mimeType);
    }
    processedFiles.push({ file, originalName, mimeType, dataType, extracted });
  }

  const alreadyHasMessages = db.prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?').get(conversation.id).count > 0;
  let userMessageId;
  const transaction = db.transaction(() => {
    const messageResult = db.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, \'user\', ?, ?)')
      .run(conversation.id, storedContent, timestamp);
    userMessageId = Number(messageResult.lastInsertRowid);
    const insertAttachment = db.prepare(`INSERT INTO message_attachments
      (message_id, user_id, original_name, mime_type, data_type, size_bytes, sha256, metadata_json, data, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertPart = db.prepare(`INSERT INTO attachment_parts
      (attachment_id, part_index, part_type, mime_type, metadata_json, data, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const entry of processedFiles) {
      const { file, originalName, mimeType, dataType, extracted } = entry;
      const metadata = {
        clientProvidedMimeType: file.mimetype || '',
        storage: 'sqlite-blob',
        parser: extracted.parser || 'none',
        extractedText: String(extracted.text || '').slice(0, 50000),
        note: String(extracted.note || '').slice(0, 500),
        generatedPartCount: Array.isArray(extracted.generatedParts) ? extracted.generatedParts.length : 0,
        extractionCompletedAt: timestamp
      };
      const insertResult = insertAttachment.run(
        userMessageId,
        req.user.id,
        originalName,
        mimeType,
        dataType,
        file.size,
        sha256(file.buffer),
        JSON.stringify(metadata),
        file.buffer,
        timestamp
      );
      const attachmentId = Number(insertResult.lastInsertRowid);
      for (let partIndex = 0; partIndex < (extracted.generatedParts || []).length; partIndex += 1) {
        const part = extracted.generatedParts[partIndex];
        insertPart.run(
          attachmentId,
          partIndex,
          String(part.part_type || 'derived_media'),
          String(part.mime_type || 'application/octet-stream'),
          JSON.stringify(part.metadata || {}),
          part.data,
          timestamp
        );
      }
    }
    if (!alreadyHasMessages && conversation.title === 'New chat') {
      db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?')
        .run(cleanTitle(typedMessage || names[0] || 'Uploaded files'), timestamp, conversation.id, req.user.id);
    } else {
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ? AND user_id = ?')
        .run(timestamp, conversation.id, req.user.id);
    }
  });
  transaction();

  const userMessage = publicMessage({ id: userMessageId, role: 'user', content: storedContent, created_at: timestamp }, req.user.id);
  if (!process.env.NVIDIA_API_KEY || process.env.NVIDIA_API_KEY === 'put_your_nvidia_api_key_here') {
    return sendError(res, 503, 'Your message and attachments were saved locally, but the NVIDIA API key is missing. Add NVIDIA_API_KEY to .env and restart the app.');
  }

  try {
    const history = await buildModelHistory(conversation.id, req.user.id, userMessageId);
    const payload = {
      model: NVIDIA_MODEL,
      messages: [
        { role: 'system', content: 'You are a helpful, accurate, friendly multimodal assistant. Answer the user directly, structure longer answers clearly, and use Markdown when useful. You can analyze supported image, audio, video, and document-derived inputs attached to user messages. Use extracted document text and any supplied media parts. Be explicit if a file could not be parsed or a media format was unsupported; never claim to have inspected content that was not actually supplied.' },
        ...history.messages
      ],
      temperature: NVIDIA_TEMPERATURE,
      top_p: 0.95,
      max_tokens: NVIDIA_MAX_TOKENS,
      stream: false,
      chat_template_kwargs: { enable_thinking: NVIDIA_ENABLE_THINKING }
    };
    const hasVideo = history.messages.some((modelMessage) => Array.isArray(modelMessage.content) && modelMessage.content.some((part) => part.type === 'video_url'));
    if (hasVideo) {
      payload.mm_processor_kwargs = { use_audio_in_video: true };
      payload.media_io_kwargs = { video: { fps: 1.0, num_frames: -1 } };
    }

    const response = await fetchNvidiaWithBackoff(`${NVIDIA_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload),
    }, 3);

    const responseBody = await response.json().catch(() => ({}));
    if (!response.ok) {
      // Don't expose the raw ResourceExhausted/worker-capacity error to the UI.
      // The user prompt and attachments have already been saved locally.
      if (response.status === 429 || response.status === 503) {
        console.info('AI service remains temporarily busy after automatic retries.');
        return res.json({
          aiSkipped: true,
          notice: 'Your message and files are saved. The AI service is temporarily busy; please try again in a little while.',
          userMessage,
          conversation: { id: conversation.id, title: cleanTitle(typedMessage || names[0] || 'Uploaded files') }
        });
      }
      console.error(`NVIDIA request failed with HTTP ${response.status}.`);
      const publicMessage = response.status === 401 || response.status === 403
        ? 'NVIDIA rejected the API key. Check that NVIDIA_API_KEY in .env is correct and has access to the Omni model.'
        : response.status === 413 || response.status === 415
          ? 'NVIDIA rejected the media payload. Try fewer/smaller files and use JPEG/PNG images, WAV/MP3/FLAC audio, MP4 video, or a supported document format.'
          : `NVIDIA request failed (HTTP ${response.status}). Your message and files are saved locally; check the API settings and media formats.`;
      return sendError(res, 502, publicMessage);
    }

    const answer = responseBody?.choices?.[0]?.message?.content;
    const answerText = typeof answer === 'string'
      ? answer
      : Array.isArray(answer) ? answer.map((part) => typeof part === 'string' ? part : (part?.text || '')).join('\n').trim() : '';
    if (!answerText) {
      console.error('NVIDIA API response did not contain a text message.');
      return sendError(res, 502, 'NVIDIA returned an empty answer. Try again or adjust the model settings in .env.');
    }

    const assistantTimestamp = nowSeconds();
    const result = db.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, \'assistant\', ?, ?)')
      .run(conversation.id, answerText, assistantTimestamp);
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ? AND user_id = ?')
      .run(assistantTimestamp, conversation.id, req.user.id);

    return res.json({
      message: publicMessage({ id: Number(result.lastInsertRowid), role: 'assistant', content: answerText, created_at: assistantTimestamp }, req.user.id),
      userMessage,
      conversation: { id: conversation.id, title: cleanTitle(typedMessage || names[0] || 'Uploaded files') }
    });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return sendError(res, 504, 'NVIDIA took too long to analyze the request. Your message and attachments were saved; try again with fewer or smaller files.');
    }
    console.error('Chat request failed:', error.message);
    return sendError(res, 502, 'Could not reach NVIDIA. Your message and attachments were saved locally. Check your internet connection, API key, and supported media formats.');
  }
});

app.get('/api/attachments/:id/content', auth, (req, res) => {
  const attachmentId = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(attachmentId) || attachmentId < 1) return sendError(res, 404, 'Attachment not found.');
  const attachment = db.prepare(`SELECT a.id, a.original_name, a.mime_type, a.size_bytes, a.data
    FROM message_attachments a
    JOIN messages m ON m.id = a.message_id
    JOIN conversations c ON c.id = m.conversation_id
    WHERE a.id = ? AND a.user_id = ? AND c.user_id = ?`).get(attachmentId, req.user.id, req.user.id);
  if (!attachment) return sendError(res, 404, 'Attachment not found.');

  const normalizedMime = String(attachment.mime_type || '').toLowerCase();
  // Inline only passive media. SVG and document formats are always downloaded.
  const inline = (normalizedMime.startsWith('image/') && normalizedMime !== 'image/svg+xml')
    || normalizedMime.startsWith('audio/')
    || normalizedMime.startsWith('video/');
  const mimeType = inline ? attachment.mime_type : 'application/octet-stream';
  const headerName = attachment.original_name.replace(/[\\"\r\n]/g, '_').replace(/[^\x20-\x7E]/g, '_').slice(0, 180) || 'attachment';
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Length', attachment.size_bytes);
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${headerName}"; filename*=UTF-8''${encodeURIComponent(attachment.original_name)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  return res.end(attachment.data);
});

app.get('/api/storage/stats', auth, (_req, res) => {
  const rows = db.prepare(`SELECT data_type, COUNT(*) AS files, COALESCE(SUM(size_bytes), 0) AS bytes
    FROM message_attachments WHERE user_id = ? GROUP BY data_type ORDER BY data_type`).all(_req.user.id);
  const totals = db.prepare(`SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes), 0) AS bytes
    FROM message_attachments WHERE user_id = ?`).get(_req.user.id);
  res.json({ types: rows, total: totals });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, model: NVIDIA_MODEL, database: path.basename(dbPath) });
});

// Return clear JSON errors for multipart uploads without exposing stack traces.
app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? 'Each attachment must be 20 MB or smaller.'
      : error.code === 'LIMIT_FILE_COUNT'
        ? `Attach no more than ${MAX_ATTACHMENT_FILES} files per message.`
        : 'The uploaded files could not be accepted. Check the file count and size limits.';
    return sendError(res, 413, message);
  }
  console.error('Request failed:', error.message);
  return sendError(res, 500, 'The request could not be completed.');
});

// Keep the SQLite database clean and release resources on shutdown.
const cleanup = setInterval(() => {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowSeconds());
}, 60 * 60 * 1000);
cleanup.unref();

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`Nemotron Local Chatbot running at http://127.0.0.1:${PORT}`);
  console.log(`Model: ${NVIDIA_MODEL}`);
  console.log(`SQLite: ${dbPath}`);
  if (!process.env.NVIDIA_API_KEY) console.log('Setup needed: copy .env.example to .env and add NVIDIA_API_KEY.');
});
function shutdown() {
  clearInterval(cleanup);
  server.close(() => { db.close(); process.exit(0); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
