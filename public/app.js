'use strict';

const $ = (selector) => document.querySelector(selector);
const authScreen = $('#auth-screen');
const appShell = $('#app');
const authForm = $('#auth-form');
const authUsername = $('#auth-username');
const authPassword = $('#auth-password');
const authTitle = $('#auth-title');
const authSubmit = $('#auth-submit');
const authError = $('#auth-error');
const authSwitch = $('#auth-switch');
const authSwitchCopy = $('#auth-switch-copy');
const conversationList = $('#conversation-list');
const messageList = $('#message-list');
const welcome = $('#welcome');
const chatForm = $('#chat-form');
const messageInput = $('#message-input');
const sendButton = $('#send-button');
const fileInput = $('#file-input');
const selectedAttachments = $('#selected-attachments');
const characterCount = $('#character-count');
const chatScroll = $('#chat-scroll');
const toast = $('#toast');
const sidebar = $('#sidebar');
const mobileScrim = $('#mobile-scrim');

let authMode = 'login';
let currentUser = null;
let conversations = [];
let currentConversationId = null;
let messages = [];
let isSending = false;
let selectedFiles = [];
let toastTimer = null;
let localOwnerKey = null;
const activeObjectUrls = new Set();
const MAX_FILES = 5;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 40 * 1024 * 1024;

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

function setAuthVisible(visible) {
  authScreen.classList.toggle('hidden', !visible);
  appShell.classList.toggle('hidden', visible);
  if (visible) {
    authPassword.value = '';
    authError.textContent = '';
    setTimeout(() => authUsername.focus(), 30);
  }
}

function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === 'register';
  authTitle.textContent = registering ? 'Create your private space.' : 'Your own AI workspace.';
  authSubmit.textContent = registering ? 'Create account' : 'Sign in';
  authSwitchCopy.textContent = registering ? 'Already have an account?' : 'New here?';
  authSwitch.textContent = registering ? 'Sign in' : 'Create an account';
  authPassword.autocomplete = registering ? 'new-password' : 'current-password';
  authError.textContent = '';
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

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function attachmentElement(attachment) {
  let url = attachment.url || attachment.preview_url;
  if (!url && attachment.blob instanceof Blob) { url = URL.createObjectURL(attachment.blob); activeObjectUrls.add(url); }
  const type = attachment.data_type || (
    String(attachment.mime_type || attachment.type || '').startsWith('image/') ? 'image' :
    String(attachment.mime_type || attachment.type || '').startsWith('audio/') ? 'audio' :
    String(attachment.mime_type || attachment.type || '').startsWith('video/') ? 'video' : 'file'
  );
  const name = attachment.original_name || attachment.name || 'Attachment';
  const wrap = document.createElement('div');
  wrap.className = `message-attachment attachment-${type}`;

  if (type === 'image' && url) {
    const link = document.createElement('a');
    link.className = 'image-attachment-link';
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const img = document.createElement('img');
    img.src = url;
    img.alt = name;
    img.loading = 'lazy';
    link.appendChild(img);
    wrap.appendChild(link);
    const caption = document.createElement('div');
    caption.className = 'attachment-caption';
    caption.textContent = `${name} · ${formatBytes(attachment.size_bytes ?? attachment.size)}`;
    wrap.appendChild(caption);
    return wrap;
  }

  if ((type === 'video' || type === 'audio') && url) {
    const media = document.createElement(type);
    media.controls = true;
    media.preload = 'metadata';
    media.src = url;
    if (type === 'video') media.playsInline = true;
    wrap.appendChild(media);
    const caption = document.createElement('div');
    caption.className = 'attachment-caption';
    caption.textContent = `${name} · ${formatBytes(attachment.size_bytes ?? attachment.size)}`;
    wrap.appendChild(caption);
    return wrap;
  }

  const link = document.createElement('a');
  link.className = 'attachment-file-card';
  if (url) link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.title = name;
  const icon = document.createElement('span');
  icon.className = 'attachment-file-icon';
  icon.textContent = type === 'document' ? 'DOC' : type === 'data' ? 'DATA' : type === 'archive' ? 'ZIP' : type.toUpperCase().slice(0, 4);
  const details = document.createElement('span');
  details.className = 'attachment-file-details';
  const title = document.createElement('strong');
  title.textContent = name;
  const meta = document.createElement('small');
  const parseStatus = attachment.parsed ? ' · content parsed' : '';
  meta.textContent = `${attachment.mime_type || 'Unknown type'} · ${formatBytes(attachment.size_bytes ?? attachment.size)}${parseStatus}`;
  details.append(title, meta);
  if (attachment.processing_note) {
    const note = document.createElement('small');
    note.className = 'attachment-processing-note';
    note.textContent = attachment.processing_note;
    details.appendChild(note);
  }
  const arrow = document.createElement('span');
  arrow.className = 'attachment-download';
  arrow.textContent = '↗';
  link.append(icon, details, arrow);
  wrap.appendChild(link);
  return wrap;
}

function renderMessageAttachments(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return null;
  const list = document.createElement('div');
  list.className = 'message-attachments';
  for (const attachment of attachments) list.appendChild(attachmentElement(attachment));
  return list;
}

function renderSelectedFiles() {
  selectedAttachments.replaceChildren();
  selectedAttachments.classList.toggle('hidden', selectedFiles.length === 0);
  for (let index = 0; index < selectedFiles.length; index += 1) {
    const item = selectedFiles[index];
    const chip = document.createElement('div');
    chip.className = 'selected-file-chip';
    const label = document.createElement('span');
    label.className = 'selected-file-name';
    label.textContent = `${item.file.name} · ${formatBytes(item.file.size)}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-selected-file';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${item.file.name}`);
    remove.addEventListener('click', () => {
      URL.revokeObjectURL(item.previewUrl);
      selectedFiles = selectedFiles.filter((entry) => entry !== item);
      renderSelectedFiles();
      updateComposer();
    });
    chip.append(label, remove);
    selectedAttachments.appendChild(chip);
  }
}

function clearSelectedFiles() {
  for (const item of selectedFiles) URL.revokeObjectURL(item.previewUrl);
  selectedFiles = [];
  if (fileInput) fileInput.value = '';
  renderSelectedFiles();
  updateComposer();
}

function addSelectedFiles(fileList) {
  const incoming = Array.from(fileList || []);
  const additions = [];
  let totalBytes = selectedFiles.reduce((sum, item) => sum + item.file.size, 0);
  for (const file of incoming) {
    if (selectedFiles.length + additions.length >= MAX_FILES) {
      showToast(`Attach no more than ${MAX_FILES} files per message.`, true);
      break;
    }
    if (file.size > MAX_FILE_BYTES) {
      showToast(`${file.name} is larger than 20 MB and was not added.`, true);
      continue;
    }
    if (totalBytes + file.size > MAX_TOTAL_FILE_BYTES) {
      showToast('Attachments must total 40 MB or less per message.', true);
      continue;
    }
    const duplicate = [...selectedFiles, ...additions].some((item) => item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified);
    if (duplicate) continue;
    totalBytes += file.size;
    additions.push({ file, previewUrl: URL.createObjectURL(file) });
  }
  selectedFiles.push(...additions);
  renderSelectedFiles();
  updateComposer();
  if (additions.length) showToast(`${additions.length} file${additions.length === 1 ? '' : 's'} ready to save locally.`);
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
    const attachmentList = renderMessageAttachments(message.attachments);
    if (attachmentList) body.appendChild(attachmentList);
    if (message.role === 'assistant' && !message.pending) {
      const actions = document.createElement('div');
      actions.className = 'message-actions';
      const copy = document.createElement('button');
      copy.type = 'button'; copy.className = 'mini-action'; copy.textContent = 'Copy';
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(message.content); showToast('Answer copied.'); }
        catch { showToast('Clipboard access is unavailable in this browser.', true); }
      });
      actions.append(copy); body.append(actions);
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
  clearSelectedFiles();
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
  clearSelectedFiles();
  updateComposer();
  messageInput.focus();
}

async function sendMessage(rawText) {
  const text = String(rawText || '').trim();
  if ((!text && !selectedFiles.length) || isSending) return;
  if (!currentConversationId) {
    const conversation = await LocalChatDB.createConversation(localOwnerKey);
    conversations.unshift(conversation);
    currentConversationId = conversation.id;
    renderConversationList();
  }
  const targetConversationId = currentConversationId;
  const filesToSend = [...selectedFiles];
  const timestamp = Math.floor(Date.now() / 1000);
  const pendingContent = text || `Please analyze ${filesToSend.length} attached file${filesToSend.length === 1 ? '' : 's'}.`;
  const userMessage = {
    id: crypto.randomUUID(), role: 'user', content: pendingContent, created_at: timestamp, pending: true,
    attachments: filesToSend.map(({ file }) => ({
      id: crypto.randomUUID(), original_name: file.name, name: file.name,
      mime_type: file.type || 'application/octet-stream',
      data_type: file.type.startsWith('image/') ? 'image' : file.type.startsWith('audio/') ? 'audio' : file.type.startsWith('video/') ? 'video' : 'file',
      size_bytes: file.size, blob: file, parsed: false
    }))
  };
  messageInput.value = '';
  selectedFiles = [];
  renderSelectedFiles();
  updateComposer();
  isSending = true;
  sendButton.disabled = true;
  messages.push(userMessage);
  await LocalChatDB.putMessage(localOwnerKey, targetConversationId, userMessage);
  const conv = await LocalChatDB.getConversation(localOwnerKey, targetConversationId);
  if (conv && conv.title === 'New chat') {
    conv.title = (text || filesToSend[0]?.file.name || 'Uploaded files').replace(/\s+/g, ' ').slice(0, 56);
    await LocalChatDB.putConversation(localOwnerKey, conv);
  }
  renderMessages(true);

  const formData = new FormData();
  formData.append('message', text);
  const history = messages.filter((m) => m.id !== userMessage.id).slice(-23).map((m) => ({ role: m.role, content: m.content }));
  formData.append('history', JSON.stringify(history));
  for (const item of filesToSend) formData.append('attachments', item.file, item.file.name);
  try {
    const data = await api('/api/generate', { method: 'POST', body: formData });
    userMessage.pending = false;
    if (data.aiSkipped) {
      userMessage.status = 'retry';
      userMessage.error = data.notice || 'AI service is temporarily busy. You can retry this message.';
      await LocalChatDB.putMessage(localOwnerKey, targetConversationId, userMessage);
      showToast(data.notice || 'AI service is temporarily busy. Your message remains saved on this device.', true);
    } else {
      await LocalChatDB.putMessage(localOwnerKey, targetConversationId, userMessage);
      const assistantMessage = { id: crypto.randomUUID(), role: 'assistant', content: data.message.content, created_at: data.message.created_at || Math.floor(Date.now() / 1000), attachments: [] };
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
    for (const item of filesToSend) URL.revokeObjectURL(item.previewUrl);
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
  sendButton.disabled = isSending || (!messageInput.value.trim() && selectedFiles.length === 0);
}

async function migrateLegacyHistoryOnce() {
  const marker = await LocalChatDB.getSetting(`legacy-import:${localOwnerKey}`);
  if (marker?.value) return;
  try {
    const response = await api('/api/conversations');
    for (const conversation of (response.conversations || [])) {
      const existing = await LocalChatDB.getConversation(localOwnerKey, conversation.id);
      if (!existing) await LocalChatDB.putConversation(localOwnerKey, { ...conversation, ownerKey: localOwnerKey });
      const history = await api(`/api/conversations/${encodeURIComponent(conversation.id)}/messages`);
      for (const source of (history.messages || [])) {
        const attachments = [];
        for (const attachment of (source.attachments || [])) {
          let blob = null;
          try { const fileResponse = await fetch(attachment.url, { credentials: 'same-origin' }); if (fileResponse.ok) blob = await fileResponse.blob(); } catch { /* keep metadata if file retrieval fails */ }
          attachments.push({ ...attachment, blob: blob || undefined, url: undefined, preview_url: undefined });
        }
        const localMessage = { ...source, attachments, pending: false };
        await LocalChatDB.putMessage(localOwnerKey, conversation.id, localMessage);
      }
    }
    await LocalChatDB.putSetting(`legacy-import:${localOwnerKey}`, { completedAt: Date.now() });
    showToast('Existing server history was imported to this device. Verify it before removing old server records.');
  } catch (error) {
    // Old server history may be unavailable. Local history remains usable.
    console.info('Legacy history import skipped:', error.message);
  }
}

async function initializeWorkspace(user) {
  currentUser = user;
  localOwnerKey = `user:${String(user.username || 'user').toLowerCase()}`;
  await LocalChatDB.open();
  localStorage.setItem('nemotron-last-local-user', String(user.username || 'user'));
  await migrateLegacyHistoryOnce();
  $('#sidebar-username').textContent = user.username;
  $('#avatar').textContent = user.username.slice(0, 1).toUpperCase();
  setAuthVisible(false);
  messages = [];
  currentConversationId = null;
  setCurrentTitle('New conversation');
  renderMessages();
  try {
    await refreshConversations();
    if (conversations.length) await openConversation(conversations[0].id);
  } catch (error) { showToast(error.message, true); }
}

authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  authError.textContent = '';
  authSubmit.disabled = true;
  authSubmit.textContent = authMode === 'register' ? 'Creating account…' : 'Signing in…';
  try {
    const endpoint = authMode === 'register' ? '/api/register' : '/api/login';
    const data = await api(endpoint, { method: 'POST', body: JSON.stringify({ username: authUsername.value.trim(), password: authPassword.value }) });
    await initializeWorkspace(data.user);
  } catch (error) {
    authError.textContent = error.message;
  } finally {
    authSubmit.disabled = false;
    authSubmit.textContent = authMode === 'register' ? 'Create account' : 'Sign in';
  }
});

authSwitch.addEventListener('click', () => setAuthMode(authMode === 'login' ? 'register' : 'login'));
$('#new-chat').addEventListener('click', createConversation);
$('#logout-button').addEventListener('click', async () => {
  if (isSending) return showToast('Wait until the current response finishes before signing out.', true);
  try { await api('/api/logout', { method: 'POST', body: JSON.stringify({}) }); } catch { /* show sign-in screen even if the session already expired */ }
  currentUser = null; localOwnerKey = null; conversations = []; currentConversationId = null; messages = [];
  clearSelectedFiles();
  setAuthMode('login'); setAuthVisible(true); hideMobileSidebar();
});
fileInput.addEventListener('change', () => { addSelectedFiles(fileInput.files); fileInput.value = ''; });
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
    const data = await api('/api/me');
    await initializeWorkspace(data.user);
  } catch {
    const cachedUsername = localStorage.getItem('nemotron-last-local-user');
    if (cachedUsername) {
      await initializeWorkspace({ username: cachedUsername, offlineLocalOnly: true });
      showToast('Offline mode: local history is available, but AI requests and sign-in require a connection.');
    } else {
      setAuthMode('login');
      setAuthVisible(true);
    }
  }
})();
