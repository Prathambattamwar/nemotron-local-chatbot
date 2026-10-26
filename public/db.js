/* Device-only conversation storage. No conversation content is sent to the server except the context needed for the current AI request. */
'use strict';
window.LocalChatDB = (() => {
  const DB_NAME = 'nemotron-device-chat';
  const DB_VERSION = 1;
  let dbPromise;
  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('conversations')) {
          const store = db.createObjectStore('conversations', { keyPath: 'id' });
          store.createIndex('ownerKey', 'ownerKey', { unique: false });
          store.createIndex('updated_at', 'updated_at', { unique: false });
        }
        if (!db.objectStoreNames.contains('messages')) {
          const store = db.createObjectStore('messages', { keyPath: 'id' });
          store.createIndex('ownerKey', 'ownerKey', { unique: false });
          store.createIndex('conversationId', 'conversationId', { unique: false });
          store.createIndex('created_at', 'created_at', { unique: false });
        }
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open local conversation storage.'));
      request.onblocked = () => reject(new Error('Close other Nemotron tabs to upgrade local storage.'));
    });
    return dbPromise;
  }
  async function run(storeName, mode, operation) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      let result;
      try { result = operation(store); } catch (e) { reject(e); return; }
      tx.oncomplete = () => resolve(result?.result);
      tx.onerror = () => reject(tx.error || result?.error || new Error('Local database operation failed.'));
      tx.onabort = () => reject(tx.error || new Error('Local database transaction was aborted.'));
    });
  }
  async function get(storeName, key) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const req = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }
  async function getAllByIndex(storeName, indexName, value) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const req = db.transaction(storeName, 'readonly').objectStore(storeName).index(indexName).getAll(value);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }
  async function put(storeName, value) { return run(storeName, 'readwrite', store => store.put(value)); }
  async function listConversations(ownerKey) {
    return (await getAllByIndex('conversations', 'ownerKey', ownerKey)).sort((a,b) => b.updated_at - a.updated_at);
  }
  async function getConversation(ownerKey, id) {
    const value = await get('conversations', id);
    return value?.ownerKey === ownerKey ? value : null;
  }
  async function createConversation(ownerKey) {
    const now = Math.floor(Date.now()/1000);
    const conversation = { id: crypto.randomUUID(), ownerKey, title: 'New chat', created_at: now, updated_at: now };
    await put('conversations', conversation);
    return conversation;
  }
  async function putConversation(ownerKey, value) {
    if (value.ownerKey && value.ownerKey !== ownerKey) throw new Error('Conversation owner mismatch.');
    value.ownerKey = ownerKey;
    value.updated_at = Math.floor(Date.now()/1000);
    await put('conversations', value);
  }
  async function touchConversation(ownerKey, id) {
    const c = await getConversation(ownerKey, id);
    if (c) await putConversation(ownerKey, c);
  }
  async function putMessage(ownerKey, conversationId, message) {
    const record = { ...message, ownerKey, conversationId, order: message.order || Date.now() };
    await put('messages', record);
  }
  async function listMessages(ownerKey, conversationId) {
    return (await getAllByIndex('messages', 'conversationId', conversationId))
      .filter(m => m.ownerKey === ownerKey)
      .sort((a,b) => (a.order || a.created_at) - (b.order || b.created_at));
  }
  async function getSetting(key) { return get('settings', key); }
  async function putSetting(key, value) { return put('settings', { key, value }); }
  async function deleteConversation(ownerKey, id) {
    const c = await getConversation(ownerKey, id);
    if (!c) return;
    const messages = await listMessages(ownerKey, id);
    const db = await open();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['conversations','messages'], 'readwrite');
      tx.objectStore('conversations').delete(id);
      for (const m of messages) tx.objectStore('messages').delete(m.id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }
  return { open, listConversations, getConversation, createConversation, putConversation, touchConversation, putMessage, listMessages, deleteConversation, getSetting, putSetting };
})();
