'use strict';

const $ = (selector) => document.querySelector(selector);
const appShell = $('#app');
const conversationList = $('#conversation-list');
const messageList = $('#message-list');
const welcome = $('#welcome');
const chatForm = $('#chat-form');
const messageInput = $('#message-input');
const sendButton = $('#send-button');
const characterCount = $('#character-count');
const chatScroll = $('#chat-scroll');
const toast = $('#toast');
const sidebar = $('#sidebar');
const mobileScrim = $('#mobile-scrim');
const VOICE_BRIDGE_URL = String(window.NEMOTRON_VOICE_BRIDGE_URL || 'http://127.0.0.1:3905').replace(/\/+$/, '');
const currentUser = { username: 'Guest' };

let conversations = [];
let currentConversationId = null;
let messages = [];
let isSending = false;
let toastTimer = null;
let localOwnerKey = null;
const activeObjectUrls = new Set();

async function api(url, options = {}) {
  const isMultipart = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.body && !isMultipart ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3600);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

// Small, safe Markdown renderer: raw HTML from the model is escaped before formatting.
function renderMarkdown(source) {
  let text = String(source ?? '').replace(/\r\n?/g, '\n');
  const codeBlocks = [];
  text = text.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_match, language, code) => {
    const token = `\u0000BLOCK${codeBlocks.length}\u0000`;
    codeBlocks.push(`<pre><code${language.trim() ? ` data-language="${escapeHtml(language.trim().slice(0, 24))}"` : ''}>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
    return token;
  });
  text = escapeHtml(text);
  text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/~~(.+?)~~/g, '<del>$1</del>');
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  const lines = text.split('\n');
  const output = [];
  let paragraph = [];
  let listType = null;
  function flushParagraph() {
    if (paragraph.length) {
      output.push(`<p>${paragraph.join('<br>')}</p>`);
      paragraph = [];
    }
  }
  function closeList() {
    if (listType) { output.push(`</${listType}>`); listType = null; }
  }
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\u0000BLOCK\d+\u0000$/.test(trimmed)) {
      flushParagraph(); closeList(); output.push(trimmed); continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushParagraph(); closeList();
      const level = heading[1].length;
      output.push(`<h${level}>${heading[2]}</h${level}>`); continue;
    }
    if (/^---+$/.test(trimmed)) { flushParagraph(); closeList(); output.push('<hr>'); continue; }
    const unordered = /^[-*+]\s+(.+)$/.exec(trimmed);
    const ordered = /^\d+[.)]\s+(.+)$/.exec(trimmed);
    if (unordered || ordered) {
      flushParagraph();
      const wanted = unordered ? 'ul' : 'ol';
      if (listType !== wanted) { closeList(); listType = wanted; output.push(`<${listType}>`); }
      output.push(`<li>${(unordered || ordered)[1]}</li>`); continue;
    }
    if (!trimmed) { flushParagraph(); closeList(); continue; }
    closeList(); paragraph.push(trimmed);
  }
  flushParagraph(); closeList();
  let html = output.join('');
  html = html.replace(/\u0000BLOCK(\d+)\u0000/g, (_match, index) => codeBlocks[Number(index)] || '');
  return html;
}

function formatTime(seconds) {
  if (!seconds) return '';
  return new Date(seconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function scrollToBottom() {
  requestAnimationFrame(() => { chatScroll.scrollTop = chatScroll.scrollHeight; });
}
function setCurrentTitle(title) {
  $('#current-title').textContent = title || 'New conversation';
}
function hideMobileSidebar() {
  sidebar.classList.remove('open');
  mobileScrim.classList.remove('visible');
}

function renderConversationList() {
  $('#history-count').textContent = String(conversations.length);
  conversationList.replaceChildren();
  if (!conversations.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = 'Your saved conversations will appear here.';
    conversationList.appendChild(empty);
    return;
  }
  for (const conversation of conversations) {
    const row = document.createElement('div');
    row.className = `history-item${conversation.id === currentConversationId ? ' active' : ''}`;
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'history-item';
    open.style.cssText = 'flex:1;min-width:0;width:auto;padding:0;border:0;background:transparent;margin:0;min-height:0;gap:7px;color:inherit';
    const symbol = document.createElement('span');
    symbol.className = 'history-symbol';
    symbol.textContent = '◷';
    const title = document.createElement('span');
    title.className = 'history-title';
    title.textContent = conversation.title || 'New chat';
    open.append(symbol, title);
    open.addEventListener('click', () => openConversation(conversation.id));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'delete-conversation';
    remove.setAttribute('aria-label', `Delete ${conversation.title || 'conversation'}`);
    remove.title = 'Delete conversation';
    remove.textContent = '×';
    remove.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (!window.confirm(`Delete “${conversation.title || 'New chat'}” and its messages? This cannot be undone.`)) return;
      try {
        await LocalChatDB.deleteConversation(localOwnerKey, conversation.id);
        conversations = conversations.filter((item) => item.id !== conversation.id);
        if (currentConversationId === conversation.id) {
          currentConversationId = null;
          messages = [];
          renderMessages();
          setCurrentTitle('New conversation');
        }
        renderConversationList();
        showToast('Conversation deleted.');
      } catch (error) { showToast(error.message, true); }
    });
    row.append(open, remove);
    conversationList.appendChild(row);
  }
}

function cleanTextForSpeech(value) {
  return String(value || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+] |\d+\.\s+)/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/[ *_~`]/g, ' ')
    .replace(/\\\[/g, '').replace(/\\\]/g, '')
    .replace(/\\\(/g, '').replace(/\\\)/g, '')
    .replace(/\\\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitTextForSpeech(value, maxChars = 240) {
  let remaining = cleanTextForSpeech(value);
  const chunks = [];
  while (remaining.length) {
    if (remaining.length <= maxChars) { chunks.push(remaining); break; }
    const window = remaining.slice(0, maxChars + 1);
    const minCut = Math.floor(maxChars * 0.55);
    let cut = -1;
    // Prefer a sentence or paragraph boundary so speech sounds less chopped up.
    for (const separator of ['. ', '! ', '? ', ': ', '; ', '\n\n', '\n', ', ']) {
      const candidate = window.lastIndexOf(separator);
      if (candidate >= minCut && candidate > cut) cut = candidate + (separator === '\n\n' ? 2 : separator === '\n' ? 1 : separator.length - 1);
    }
    if (cut < minCut) cut = window.lastIndexOf(' ');
    if (cut < 1) cut = maxChars;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  return chunks.filter(Boolean);
}

async function requestVoiceStudioSpeech(input) {
  let response;
  try { response = await fetch(`${VOICE_BRIDGE_URL}/api/tts/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ input }),
    signal: AbortSignal.timeout(600000)
  }); } catch {
    throw new Error('Cannot reach VoiceStudio on this PC. Start VoiceStudio and run voice-bridge/start-bridge.bat. For a hosted PWA, allow local-network access in the browser and add its origin to voice-bridge/.env.');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `VoiceStudio request failed (${response.status}).`);
  }
  const blob = await response.blob();
  if (!blob.size) throw new Error('VoiceStudio returned an empty audio file.');
  return blob;
}

async function refreshVoiceStudioStatus() {
  const chip = $('#tts-status');
  if (!chip) return;
  chip.dataset.state = 'checking';
  chip.textContent = 'VoiceStudio · checking';
  try {
    const response = await fetch(`${VOICE_BRIDGE_URL}/health`, { cache: 'no-store', signal: AbortSignal.timeout(6500) });
    const status = await response.json().catch(() => ({}));
    if (!response.ok || !status.ok) throw new Error(status.error || 'VoiceStudio offline');
    const testButton = $('#tts-test-button');
    if (status.engineAvailable === false) {
      chip.dataset.state = 'offline';
      chip.textContent = 'OmniVoice · unavailable';
      chip.title = status.engineReason || 'OmniVoice is not currently available in VoiceStudio Settings → Models → TTS.';
      if (testButton) testButton.disabled = true;
      return;
    }
    chip.dataset.state = status.openApiChecked && !status.speechRouteAdvertised ? 'warning' : 'online';
    chip.textContent = status.openApiChecked && !status.speechRouteAdvertised
      ? 'VoiceStudio · API mismatch'
      : (status.engineAvailable ? 'OmniVoice · available' : 'VoiceStudio · online');
    chip.title = `VoiceStudio ${status.version ? `v${status.version}` : ''} · explicit OmniVoice engine (${status.voice || 'voice profile'}). Availability means the engine is installed; first CPU synthesis may take longer. ${status.openApiChecked ? `OpenAPI advertises POST /v1/audio/speech: ${status.speechRouteAdvertised ? 'yes' : 'no'}.` : 'OpenAPI route could not be inspected.'}`;
    if (testButton) testButton.disabled = false;
  } catch {
    chip.dataset.state = 'offline';
    chip.textContent = 'VoiceStudio · offline';
    chip.title = 'Start VoiceStudio, then run voice-bridge/start-bridge.bat on this Windows PC.';
    const testButton = $('#tts-test-button');
    if (testButton) testButton.disabled = true;
  }
}

async function testVoiceStudioInApp() {
  const button = $('#tts-test-button');
  if (!button || button.disabled) return;
  const oldLabel = button.textContent;
  let audioUrl = '';
  let audio = null;
  button.disabled = true;
  button.textContent = 'Generating…';
  try {
    const blob = await requestVoiceStudioSpeech('Hello! This is a short OmniVoice voice test.');
    audioUrl = URL.createObjectURL(blob);
    audio = new Audio(audioUrl);
    audio.addEventListener('ended', () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      button.disabled = false;
      button.textContent = oldLabel;
    }, { once: true });
    audio.addEventListener('error', () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      button.disabled = false;
      button.textContent = oldLabel;
      showToast('VoiceStudio returned audio, but the browser could not play it.', true);
    }, { once: true });
    button.textContent = 'Playing…';
    await audio.play();
  } catch (error) {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    button.disabled = false;
    button.textContent = oldLabel;
    showToast(error.message || 'OmniVoice test failed.', true);
  }
}

function renderMessages(typing = false) {
  for (const url of activeObjectUrls) URL.revokeObjectURL(url);
  activeObjectUrls.clear();
  welcome.classList.toggle('hidden', messages.length > 0 || typing);
  messageList.classList.toggle('hidden', messages.length === 0 && !typing);
  messageList.replaceChildren();
  for (const message of messages) {
    const row = document.createElement('article');
    row.className = `message-row ${message.role}`;
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = message.role === 'assistant' ? 'N' : (currentUser?.username?.[0] || 'U').toUpperCase();
    const body = document.createElement('div');
    body.className = 'message-body';
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const name = document.createElement('span');
    name.className = 'message-name';
    name.textContent = message.role === 'assistant' ? 'Nemotron' : 'You';
    const time = document.createElement('span');
    time.className = 'message-time';
    time.textContent = message.pending ? 'Sending…' : formatTime(message.created_at);
    meta.append(name, time);
    const content = document.createElement('div');
    content.className = 'message-content';
    content.innerHTML = renderMarkdown(message.content);
    body.append(meta, content);
    if (message.role === 'assistant' && !message.pending) {
      const actions = document.createElement('div');
      actions.className = 'message-actions';
      const copy = document.createElement('button');
      copy.type = 'button'; copy.className = 'mini-action'; copy.textContent = 'Copy';
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(message.content); showToast('Answer copied.'); }
        catch { showToast('Clipboard access is unavailable in this browser.', true); }
      });
      const speak = document.createElement('button');
      speak.type = 'button'; speak.className = 'mini-action'; speak.textContent = '▶ Read aloud';
      speak.title = 'Generate speech using VoiceStudio on this Windows PC';
      const speechSlot = document.createElement('div');
      speechSlot.className = 'speech-slot';
      speak.addEventListener('click', async () => {
        const oldUrls = speechSlot._speechUrls || [];
        for (const url of oldUrls) { URL.revokeObjectURL(url); activeObjectUrls.delete(url); }
        speechSlot._speechUrls = [];
        speechSlot.replaceChildren();
        const chunks = splitTextForSpeech(message.content, 240);
        if (!chunks.length) return;

        speak.disabled = true;
        speak.textContent = 'Preparing first part…';
        const generatedUrls = [];
        speechSlot._speechUrls = generatedUrls;
        const readyUrls = new Array(chunks.length);
        const waiters = new Map();
        let producerError = null;
        let currentPart = 0;
        let player = null;
        const status = document.createElement('div');
        status.className = 'speech-status';
        status.textContent = `Preparing audio 1/${chunks.length}…`;
        speechSlot.appendChild(status);

        const publishUrl = (index, url) => {
          readyUrls[index] = url;
          for (const waiter of waiters.get(index) || []) waiter.resolve(url);
          waiters.delete(index);
        };
        const rejectWaiters = (error) => {
          for (const callbacks of waiters.values()) {
            for (const item of callbacks) item.reject(error);
          }
          waiters.clear();
        };
        const waitForUrl = (index) => {
          if (readyUrls[index]) return Promise.resolve(readyUrls[index]);
          if (producerError) return Promise.reject(producerError);
          return new Promise((resolve, reject) => {
            const callbacks = waiters.get(index) || [];
            callbacks.push({ resolve, reject });
            waiters.set(index, callbacks);
          });
        };
        const addAudioBlob = (index, blob) => {
          const url = URL.createObjectURL(blob);
          activeObjectUrls.add(url);
          generatedUrls.push(url);
          publishUrl(index, url);
          return url;
        };

        try {
          // Generate only the first small segment before showing the player.
          const firstBlob = await requestVoiceStudioSpeech(chunks[0]);
          addAudioBlob(0, firstBlob);
          player = document.createElement('audio');
          player.className = 'tts-audio-player';
          player.controls = true;
          player.preload = 'metadata';
          player.src = readyUrls[0];
          speechSlot.appendChild(player);

          const playPart = async (index) => {
            if (index >= chunks.length) {
              status.textContent = 'Speech finished.';
              return;
            }
            try {
              if (!readyUrls[index]) status.textContent = `Preparing section ${index + 1}/${chunks.length}…`;
              const url = await waitForUrl(index);
              currentPart = index;
              player.src = url;
              status.textContent = `Playing section ${index + 1}/${chunks.length}${producerError ? ' · remaining generation failed' : ''}`;
              try { await player.play(); }
              catch { showToast('Audio is ready. Press play on the audio player to continue.'); }
            } catch (error) {
              status.textContent = `Stopped at section ${index + 1}/${chunks.length}.`;
              showToast(error.message || 'Could not prepare the next speech section.', true);
            }
          };
          player.addEventListener('ended', () => { void playPart(currentPart + 1); });
          status.textContent = chunks.length > 1
            ? `First section ready; preparing ${chunks.length - 1} more in the background.`
            : 'Audio ready.';
          speak.textContent = '🔊 Playing / preparing…';
          try { await player.play(); }
          catch { showToast('First section is ready. Press play on the audio player; remaining sections are preparing.'); }

          if (chunks.length === 1) {
            speak.disabled = false;
            speak.textContent = '↻ Read aloud again';
            return;
          }

          // Generate the rest while the first segment is already playing.
          // Playback automatically advances to each segment as soon as it is ready.
          (async () => {
            try {
              for (let i = 1; i < chunks.length; i += 1) {
                speak.textContent = `Preparing section ${i + 1}/${chunks.length}…`;
                const blob = await requestVoiceStudioSpeech(chunks[i]);
                addAudioBlob(i, blob);
                if (i === 1 && currentPart === 0 && !player.paused && !player.ended) {
                  status.textContent = `Playing section 1/${chunks.length} · next section ready`;
                }
              }
              status.textContent = 'All sections ready. Playback continues in order.';
              speak.textContent = '↻ Read aloud again';
            } catch (error) {
              producerError = error;
              rejectWaiters(error);
              status.textContent = `Speech generation stopped after section ${generatedUrls.length}/${chunks.length}.`;
              showToast(error.message || 'VoiceStudio could not generate the remaining speech.', true);
              speak.textContent = '↻ Try read aloud again';
            } finally {
              speak.disabled = false;
            }
          })();
        } catch (error) {
          for (const url of generatedUrls) { URL.revokeObjectURL(url); activeObjectUrls.delete(url); }
          speechSlot._speechUrls = [];
          speechSlot.replaceChildren();
          showToast(error.message || 'VoiceStudio could not generate speech.', true);
          speak.textContent = '▶ Try read aloud again';
          speak.disabled = false;
        }
      });
      actions.append(copy, speak);
      body.append(actions, speechSlot);
    }
    row.append(avatar, body);
    messageList.appendChild(row);
  }
  if (typing) {
    const row = document.createElement('article');
    row.className = 'message-row assistant';
    row.innerHTML = '<div class="message-avatar">N</div><div class="message-body"><div class="message-meta"><span class="message-name">Nemotron</span><span class="message-time">Thinking</span></div><div class="typing-indicator" aria-label="Nemotron is responding"><i></i><i></i><i></i></div></div>';
    messageList.appendChild(row);
  }
  scrollToBottom();
}

async function refreshConversations() {
  conversations = await LocalChatDB.listConversations(localOwnerKey);
  renderConversationList();
}

async function openConversation(id) {
  if (isSending && id !== currentConversationId) {
    showToast('Wait until the current response finishes before switching conversations.', true);
    return;
  }
  currentConversationId = id;
  hideMobileSidebar();
  renderConversationList();
  try {
    const conversation = await LocalChatDB.getConversation(localOwnerKey, id);
    if (!conversation) throw new Error('Conversation not found on this device.');
    messages = await LocalChatDB.listMessages(localOwnerKey, id);
    setCurrentTitle(conversation.title || 'New conversation');
    renderMessages();
    messageInput.focus();
  } catch (error) { showToast(error.message, true); }
}

async function createConversation() {
  if (isSending) return showToast('Wait until the current response finishes.', true);
  const conversation = await LocalChatDB.createConversation(localOwnerKey);
  conversations.unshift(conversation);
  currentConversationId = conversation.id;
  messages = [];
  setCurrentTitle('New conversation');
  renderMessages();
  renderConversationList();
  hideMobileSidebar();
  messageInput.value = '';
  updateComposer();
  messageInput.focus();
}

async function sendMessage(rawText) {
  const text = String(rawText || '').trim();
  if (!text || isSending) return;
  if (!currentConversationId) {
    const conversation = await LocalChatDB.createConversation(localOwnerKey);
    conversations.unshift(conversation);
    currentConversationId = conversation.id;
    renderConversationList();
  }
  const targetConversationId = currentConversationId;
  const timestamp = Math.floor(Date.now() / 1000);
  const userMessage = { id: crypto.randomUUID(), role: 'user', content: text, created_at: timestamp, pending: true };
  messageInput.value = '';
  updateComposer();
  isSending = true;
  sendButton.disabled = true;
  messages.push(userMessage);
  await LocalChatDB.putMessage(localOwnerKey, targetConversationId, userMessage);
  const conv = await LocalChatDB.getConversation(localOwnerKey, targetConversationId);
  if (conv && conv.title === 'New chat') {
    conv.title = text.replace(/\s+/g, ' ').slice(0, 56);
    await LocalChatDB.putConversation(localOwnerKey, conv);
  }
  renderMessages(true);

  const history = messages.filter((m) => m.id !== userMessage.id).slice(-23).map((m) => ({ role: m.role, content: String(m.content || '') }));
  try {
    const data = await api('/api/generate', { method: 'POST', body: JSON.stringify({ message: text, history }) });
    userMessage.pending = false;
    if (data.aiSkipped) {
      userMessage.status = 'retry';
      userMessage.error = data.notice || 'AI service is temporarily busy. You can retry this message.';
      await LocalChatDB.putMessage(localOwnerKey, targetConversationId, userMessage);
      showToast(data.notice || 'AI service is temporarily busy. Your message remains saved on this device.', true);
    } else {
      await LocalChatDB.putMessage(localOwnerKey, targetConversationId, userMessage);
      const assistantMessage = { id: crypto.randomUUID(), role: 'assistant', content: data.message.content, created_at: data.message.created_at || Math.floor(Date.now() / 1000) };
      await LocalChatDB.putMessage(localOwnerKey, targetConversationId, assistantMessage);
      if (targetConversationId === currentConversationId) messages.push(assistantMessage);
    }
    await LocalChatDB.touchConversation(localOwnerKey, targetConversationId);
    await refreshConversations();
    const updated = conversations.find((c) => c.id === targetConversationId);
    if (updated && targetConversationId === currentConversationId) setCurrentTitle(updated.title);
    if (targetConversationId === currentConversationId) renderMessages();
  } catch (error) {
    userMessage.pending = false;
    userMessage.status = 'error';
    userMessage.error = error.message;
    await LocalChatDB.putMessage(localOwnerKey, targetConversationId, userMessage);
    if (targetConversationId === currentConversationId) renderMessages();
    showToast(`${error.message} Your message is still saved on this device.`, true);
  } finally {
    isSending = false;
    updateComposer();
    messageInput.focus();
  }
}

function updateComposer() {
  const length = messageInput.value.length;
  characterCount.textContent = `${length.toLocaleString()} / 16,000`;
  messageInput.style.height = 'auto';
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 230)}px`;
  sendButton.disabled = isSending || !messageInput.value.trim();
}

chatForm.addEventListener('submit', (event) => { event.preventDefault(); sendMessage(messageInput.value); });
messageInput.addEventListener('input', updateComposer);
messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (messageInput.value.trim()) sendMessage(messageInput.value);
  }
});
document.querySelectorAll('[data-prompt]').forEach((button) => {
  button.addEventListener('click', () => {
    messageInput.value = button.dataset.prompt || '';
    updateComposer();
    messageInput.focus();
    messageInput.setSelectionRange(messageInput.value.length, messageInput.value.length);
  });
});
$('#sidebar-open').addEventListener('click', () => { sidebar.classList.add('open'); mobileScrim.classList.add('visible'); });
$('#sidebar-close').addEventListener('click', hideMobileSidebar);
mobileScrim.addEventListener('click', hideMobileSidebar);
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault(); createConversation();
  }
  if (event.key === 'Escape') hideMobileSidebar();
});

(async function boot() {
  updateComposer();
  try {
    await LocalChatDB.open();
    const deviceKeyName = 'nemotron-device-local-key-v1';
    let deviceKey = localStorage.getItem(deviceKeyName);
    if (!deviceKey) {
      deviceKey = crypto.randomUUID();
      localStorage.setItem(deviceKeyName, deviceKey);
    }
    localOwnerKey = `device:${deviceKey}`;
    $('#sidebar-username').textContent = 'Guest';
    $('#avatar').textContent = 'G';
    appShell.classList.remove('hidden');
    await refreshConversations();
    if (conversations.length) await openConversation(conversations[0].id);
    else renderMessages();

    const health = await api('/api/health').catch(() => null);
    const modelLabel = document.querySelector('.model-status strong');
    const modelSub = document.querySelector('.model-status small');
    if (health && modelLabel && modelSub) {
      modelLabel.textContent = 'Nemotron Text';
      modelSub.textContent = `${health.model} · Text only`;
    }
    await refreshVoiceStudioStatus();
    $('#tts-test-button')?.addEventListener('click', testVoiceStudioInApp);
    window.addEventListener('focus', refreshVoiceStudioStatus);
    window.setInterval(() => { if (document.visibilityState === 'visible') refreshVoiceStudioStatus(); }, 30000);
  } catch (error) {
    showToast(`Could not initialize local conversation cache: ${error.message}`, true);
  }
})();
