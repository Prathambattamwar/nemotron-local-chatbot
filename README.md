# Nemotron PWA — Device-Only Conversations

A local-first PWA powered by NVIDIA `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`. Conversation history and original attachment blobs are stored in each browser profile using IndexedDB. The VPS handles authentication and stateless AI requests; it does not write new prompts, responses, or attachments to SQLite. Each browser/device keeps independent history; there is no cross-device sync. The existing SQLite database remains for account/session authentication and may contain legacy chat records until you verify migration and remove them separately.

## Multimodal and document input

- **Images:** JPEG/PNG/GIF/WebP/BMP/TIFF and formats supported by Sharp are normalized to JPEG and sent as an actual `image_url` data URI. Originals are stored as local IndexedDB blobs; only selected files are uploaded for a model request.
- **Audio:** WAV, MP3, and FLAC are sent as `audio_url` data URIs. Other audio formats are stored, but must be converted to WAV/MP3/FLAC for model understanding.
- **Video:** MP4 is sent as a `video_url` data URI. The request enables audio-in-video processing and samples video at up to 1 frame per second. NVIDIA documents a model limit of up to 2 minutes per video; keep clips short. Other video formats are stored but need conversion to MP4 for direct analysis.
- **PDF:** selectable text is extracted; the first 6 pages are rendered to JPEG so charts, scans, and visual layout can be included. Text extraction is capped at 80 pages and 50,000 characters per file.
- **Office documents:** DOCX/DOC, PPTX, XLSX/XLS, ODT/ODS/ODP are parsed to text/sheet/slide content. Up to six embedded images from DOCX/PPTX/XLSX/OpenDocument packages are also normalized and sent as image parts; PDF pages get visual sampling. PPTX slide text and OpenDocument content are extracted. Legacy `.ppt` has no binary slide-text parser in this version.
- **Text and data:** TXT, Markdown, CSV/TSV, JSON/JSONL, XML/HTML, source code, configuration files, SQL, and notebooks are read as text with a 50,000 character cap.
- **Other formats:** original files remain in the browser’s IndexedDB. Files without a content parser or supported model media format are not analyzed from raw bytes. Archives such as ZIP are not extracted.

For the current request, the app builds multimodal OpenAI-compatible content parts (`image_url`, `audio_url`, `video_url`) from files selected for the current request. PDF page images become image parts; extracted document text becomes text context. Raw media bytes are not replaced by filenames or metadata in the request. Prior text turns are sent as context, but prior binary media is not automatically resent; reattach a file if the model needs to inspect it again.

## Requirements

- Node.js 20+ (Node.js 22 LTS is recommended for dependency compatibility).
- NVIDIA API key with access to the model: <https://build.nvidia.com/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning>.
- Internet access while generating answers. Model inference runs through NVIDIA's hosted endpoint; conversation storage stays in the browser.

## Windows setup

1. Extract this ZIP to a regular writable folder, for example `C:\Projects\nemotron-local-chatbot`.
2. Open PowerShell in that folder.
3. Run `npm install` (or double-click `setup.bat`). This installs the database, image/PDF, office-document, and parsing dependencies.
4. If `.env` does not exist, run `Copy-Item .env.example .env`.
5. Open `.env` and set `NVIDIA_API_KEY` to your real NVIDIA API key. Do not share this file or commit it to Git. The default model is already set to Omni.
6. Run `npm start` (or double-click `start.bat`).
7. Open <http://127.0.0.1:3000> and create a local account.

If you already have this chatbot installed, back up `.env` and `data/chatbot.db`, then extract this version over the old project. Keep your existing `.env` and `data` folder for authentication and the one-time legacy history import. The server automatically switches the old starter default `nvidia/nemotron-3-ultra-550b-a55b` to the selected Omni model at runtime; you may also update the `NVIDIA_MODEL` line in `.env` for clarity. The server automatically creates the additional `attachment_parts` table; it does not need you to recreate users or conversations.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `NVIDIA_API_KEY` | required | NVIDIA API key |
| `NVIDIA_CHAT_BASE_URL` | `https://integrate.api.nvidia.com/v1` | API base URL |
| `NVIDIA_MODEL` | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | Multimodal model ID |
| `NVIDIA_ENABLE_THINKING` | `false` | Enable model thinking mode; false by default |
| `NVIDIA_MAX_TOKENS` | `4096` | Max output tokens |
| `NVIDIA_TEMPERATURE` | `0.2` | Sampling temperature |
| `DATABASE_PATH` | `./data/chatbot.db` | SQLite path for accounts and sessions (not new chat history) |
| `PORT` | `3000` | Local web server port |
| `SESSION_DAYS` | `30` | Session lifetime |

## Device-only storage and privacy

- IndexedDB database: `nemotron-device-chat`; stores conversations, messages, and attachment `Blob`s per browser origin.
- Local records are partitioned by username on the device. This is app-level separation, not a cryptographic security boundary.
- The PWA requests persistent browser storage only through normal browser support; browsers may deny it and users can clear site data. Use export/backup for anything important.
- Authentication still uses the Node.js server and SQLite. AI prompts, the selected recent text history, and selected files required for inference are sent to the VPS and NVIDIA. The server's `/api/generate` route does not insert those contents into SQLite.
- Legacy conversation GET routes remain temporarily available for a one-time import into IndexedDB. The first online sign-in attempts to import legacy conversations and attachment blobs. Verify local history before manually removing old server records.
- The PWA caches its application shell for offline opening. AI generation and login require a network connection; after a prior sign-in, cached local history can be viewed offline.
- File limits remain five attachments per message, 20 MB per file, and 40 MB total per message. Keep very large videos off local storage unless needed.
- When you send media, the relevant file content is sent to NVIDIA's hosted API for inference. Device-only history does not mean inference data never leaves the device.

## Troubleshooting

**`Cannot find module ...`** — Run `npm install` in the directory that contains `package.json`.

**SQLite native dependency install fails on Windows** — Use a current Node.js LTS release, preferably Node 22 LTS, then remove `node_modules` and `package-lock.json` if present and run `npm install` again.

**401/403 from NVIDIA** — Check the API key and that the model is enabled for your NVIDIA account.

**413/415 or media error** — Reduce file count/size and use JPEG/PNG images, WAV/MP3/FLAC audio, MP4 videos up to two minutes, or supported document formats. Oversized or unsupported media stays saved locally if upload succeeded.

**NVIDIA temporarily busy** — The server queues model requests from this app and automatically retries HTTP 429/503 responses with backoff. If NVIDIA remains overloaded, the app shows a friendly message while keeping your prompt and attachments saved locally; it will not display the raw `ResourceExhausted` worker error. NVIDIA's hosted capacity is external, so the app cannot guarantee an immediate model response.

## API routes

- `POST /api/register`, `POST /api/login`, `POST /api/logout`, `GET /api/me`
- `GET /api/conversations` (temporary legacy-history import endpoint; POST is retired)
- `GET /api/conversations/:id/messages` (temporary legacy-history import endpoint; PATCH/DELETE are retired)
- `POST /api/generate` (stateless multipart prompt/history plus up to five selected `attachments`)
- Legacy `POST /api/conversations/:id/messages` is retired and returns HTTP 410.
- `GET /api/attachments/:id/content` (used only for legacy-history import)
- `GET /api/storage/stats`, `GET /api/health`

## References

- [NVIDIA model card](https://build.nvidia.com/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning/modelcard)
- [NVIDIA multimodal API examples](https://docs.nvidia.com/nim/vision-language-models/1.7.0/examples/nemotron-3-nano-omni-30b-a3b-reasoning/api.html)

## Update notes

1. Back up `.env` and `data/chatbot.db` before updating.
2. Extract the ZIP, run `npm install`, and keep your existing `.env` and `data` folder.
3. On the first online sign-in, the PWA attempts to import existing server conversations and their attachment blobs into IndexedDB. Confirm the history on the device before deleting any old server-side chat rows.
4. Clearing browser/site data can permanently remove local history. This ZIP does not yet include a dedicated conversation export/import UI, so add that before relying on this for irreplaceable records. Device-only history does not synchronize to another browser or device.
