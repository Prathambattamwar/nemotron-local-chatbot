# Nemotron PWA — Cache Storage, Text Only

This version stores conversation history in the browser Cache API and removes SQLite, account registration, login, and server-side conversation persistence. The AI server receives a text prompt and the required recent text context, calls NVIDIA, and returns a text response without writing prompts or responses to disk.

## Requirements
- Node.js 20 or newer
- NVIDIA API key with access to the configured model

## Setup (Windows / PowerShell)
1. Back up your existing `.env` and `data/chatbot.db` before replacing your old project.
2. Extract this ZIP and open the extracted folder in VS Code.
3. Run `npm install`.
4. Copy `.env.example` to `.env` if `.env` does not already exist: `Copy-Item .env.example .env`.
5. Put your NVIDIA key in `.env`.
6. Run `npm start` and open `http://127.0.0.1:3000/`.

## Storage behavior
- Conversation metadata and text messages use Cache Storage, not IndexedDB/localStorage/database tables. localStorage stores only a random per-browser device key to namespace local cache entries.
- Records older than five days are removed when local history is read or a new message is stored.
- The service worker caches the app shell separately. It does not clear the conversation cache during updates.
- Browsers may evict site storage or users may clear it. This is not a backup system.
- History is per browser profile/device; there is no cross-device synchronization.

## Server behavior
- No SQLite package or database initialization. No database directory is created by this project.
- No sign-in or account requirement in the UI.
- `/api/health` reports model and storage mode. `/api/generate` calls NVIDIA and does not persist prompts or responses.
- Text-only input. Attachments are not sent to the model.
- Keep `NVIDIA_API_KEY` on the server. For public deployment, add HTTPS, request rate limiting, and access controls to prevent API abuse; device-only chat does not itself secure a publicly exposed inference endpoint.

## Existing database
This project does not read or delete your old `data/chatbot.db`. Back it up and remove it manually only after confirming you no longer need the old account or conversation data.
