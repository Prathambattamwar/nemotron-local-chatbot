/* Device-only text conversation storage using the Cache API. Records expire after 5 days. */
'use strict';
window.LocalChatDB = (() => {
  const CACHE_NAME = 'nemotron-chat-data-v1';
  const RETENTION_MS = 5 * 24 * 60 * 60 * 1000;
  const ROOT = new URL('/__nemotron_local_data__/', location.origin);
  let cachePromise;
  let lock = Promise.resolve();

  function urlFor(kind, ownerKey, id = '') {
    const url = new URL(encodeURIComponent(ownerKey) + '/' + (id ? encodeURIComponent(id) : '_index'), ROOT);
    url.searchParams.set('kind', kind);
    return url.href;
  }
  function requestFor(kind, ownerKey, id = '') { return new Request(urlFor(kind, ownerKey, id)); }
  async function cache() {
    if (!('caches' in window)) throw new Error('This browser does not support Cache Storage. Open the PWA in a supported browser on HTTPS or localhost.');
    if (!cachePromise) cachePromise = caches.open(CACHE_NAME);
    return cachePromise;
  }
  async function read(req) {
    const response = await (await cache()).match(req);
    if (!response) return null;
    try { return await response.json(); } catch { return null; }
  }
  async function write(req, value) {
    const response = new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    await (await cache()).put(req, response);
  }
  async function remove(req) { await (await cache()).delete(req); }
  function serialized(fn) {
    const result = lock.then(fn, fn);
    lock = result.catch(() => {});
    return result;
  }
  function recordTime(record) {
    const value = Number(record?.updated_at || record?.created_at || record?.timestamp || 0);
    return value > 0 && value < 1e12 ? value * 1000 : value;
  }
  async function entries(kind, ownerKey) {
    const c = await cache();
    const requests = await c.keys();
    const prefix = new URL(encodeURIComponent(ownerKey) + '/', ROOT).pathname;
    const out = [];
    for (const req of requests) {
      const u = new URL(req.url);
      if (!u.pathname.startsWith(prefix) || u.searchParams.get('kind') !== kind) continue;
      const value = await read(req);
      if (value) out.push({ req, value });
    }
    return out;
  }
  async function purgeExpired(ownerKey) {
    const cutoff = Date.now() - RETENTION_MS;
    const convs = await entries('conversation', ownerKey);
    const messages = await entries('message', ownerKey);
    const expiredIds = new Set();
    for (const { req, value } of convs) {
      if (!recordTime(value) || recordTime(value) < cutoff) {
        expiredIds.add(value.id);
        await remove(req);
      }
    }
    for (const { req, value } of messages) {
      if (expiredIds.has(value.conversationId) || !recordTime(value) || recordTime(value) < cutoff) await remove(req);
    }
  }
  async function open() { await cache(); return true; }
  async function listConversations(ownerKey) {
    await purgeExpired(ownerKey);
    return (await entries('conversation', ownerKey)).map(x => x.value).sort((a,b) => b.updated_at - a.updated_at);
  }
  async function getConversation(ownerKey, id) {
    await purgeExpired(ownerKey);
    const value = await read(requestFor('conversation', ownerKey, id));
    return value?.ownerKey === ownerKey ? value : null;
  }
  async function createConversation(ownerKey) {
    return serialized(async () => {
      await purgeExpired(ownerKey);
      const now = Math.floor(Date.now() / 1000);
      const value = { id: crypto.randomUUID(), ownerKey, title: 'New chat', created_at: now, updated_at: now };
      await write(requestFor('conversation', ownerKey, value.id), value);
      return value;
    });
  }
  async function putConversation(ownerKey, value) {
    return serialized(async () => {
      if (value.ownerKey && value.ownerKey !== ownerKey) throw new Error('Conversation owner mismatch.');
      const now = Math.floor(Date.now() / 1000);
      const record = { ...value, ownerKey, updated_at: now };
      await write(requestFor('conversation', ownerKey, record.id), record);
      return record;
    });
  }
  async function touchConversation(ownerKey, id) {
    const c = await getConversation(ownerKey, id);
    if (c) await putConversation(ownerKey, c);
  }
  async function putMessage(ownerKey, conversationId, message) {
    return serialized(async () => {
      const record = { ...message, attachments: [], ownerKey, conversationId, order: message.order || Date.now(), created_at: message.created_at || Math.floor(Date.now()/1000) };
      await write(requestFor('message', ownerKey, record.id), record);
      // Enforce the five-day rule immediately as well as during reads.
      await purgeExpired(ownerKey);
      return record;
    });
  }
  async function listMessages(ownerKey, conversationId) {
    await purgeExpired(ownerKey);
    return (await entries('message', ownerKey)).map(x => x.value).filter(m => m.ownerKey === ownerKey && m.conversationId === conversationId).sort((a,b) => (a.order || a.created_at) - (b.order || b.created_at));
  }
  async function getSetting(key) { return read(requestFor('setting', 'global', key)); }
  async function putSetting(key, value) { await write(requestFor('setting', 'global', key), { key, value, updated_at: Date.now() }); }
  async function deleteConversation(ownerKey, id) {
    const c = await cache();
    const convReq = requestFor('conversation', ownerKey, id);
    await remove(convReq);
    const all = await entries('message', ownerKey);
    for (const item of all) if (item.value.conversationId === id) await remove(item.req);
  }
  async function getRetentionInfo() { return { retentionDays: 5, storage: 'Cache API', warning: 'Browser data can still be cleared by the user or browser.' }; }
  return { open, listConversations, getConversation, createConversation, putConversation, touchConversation, putMessage, listMessages, deleteConversation, getSetting, putSetting, getRetentionInfo };
})();
