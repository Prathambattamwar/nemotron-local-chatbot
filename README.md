# Nemotron Local Chatbot — Multimodal Edition

A local multi-user chatbot powered by NVIDIA `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`. User accounts, conversations, messages, original attachment bytes, and derived document page images are stored locally in SQLite. Each account can only access its own conversations and attachments.

## Multimodal and document input

- **Images:** JPEG/PNG/GIF/WebP/BMP/TIFF and formats supported by Sharp are normalized to JPEG and sent as an actual `image_url` data URI. Originals remain stored in SQLite.
- **Audio:** WAV, MP3, and FLAC are sent as `audio_url` data URIs. Other audio formats are stored, but must be converted to WAV/MP3/FLAC for model understanding.
- **Video:** MP4 is sent as a `video_url` data URI. The request enables audio-in-video processing and samples video at up to 1 frame per second. NVIDIA documents a model limit of up to 2 minutes per video; keep clips short. Other video formats are stored but need conversion to MP4 for direct analysis.
- **PDF:** selectable text is extracted; the first 6 pages are rendered to JPEG so charts, scans, and visual layout can be included. Text extraction is capped at 80 pages and 50,000 characters per file.
- **Office documents:** DOCX/DOC, PPTX, XLSX/XLS, ODT/ODS/ODP are parsed to text/sheet/slide content. Up to six embedded images from DOCX/PPTX/XLSX/OpenDocument packages are also normalized and sent as image parts; PDF pages get visual sampling. PPTX slide text and OpenDocument content are extracted. Legacy `.ppt` has no binary slide-text parser in this version.
- **Text and data:** TXT, Markdown, CSV/TSV, JSON/JSONL, XML/HTML, source code, configuration files, SQL, and notebooks are read as text with a 50,000 character cap.
- **Other formats:** all file types can be stored as SQLite BLOBs, but files without a content parser or model media format are not analyzed from raw bytes. Archives such as ZIP are stored, not extracted.

The app builds multimodal OpenAI-compatible content parts (`image_url`, `audio_url`, `video_url`) from the bytes stored in SQLite. PDF page images become image parts; extracted document text becomes text context. Raw media bytes are not replaced by filenames or metadata in the request. A small recent-attachment context is resent for immediate follow-up questions, subject to an 8 MB context-media limit.

## Requirements

- Node.js 20+ (Node.js 22 LTS is recommended for dependency compatibility).
- NVIDIA API key with access to the model: <https://build.nvidia.com/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning>.
- Internet access while chatting. Model inference runs through NVIDIA's hosted endpoint; SQLite storage stays local.

## Windows setup

1. Extract this ZIP to a regular writable folder, for example `C:\Projects\nemotron-local-chatbot`.
2. Open PowerShell in that folder.
3. Run `npm install` (or double-click `setup.bat`). This installs the database, image/PDF, office-document, and parsing dependencies.
4. If `.env` does not exist, run `Copy-Item .env.example .env`.
5. Open `.env` and set `NVIDIA_API_KEY` to your real NVIDIA API key. Do not share this file or commit it to Git. The default model is already set to Omni.
6. Run `npm start` (or double-click `start.bat`).
7. Open <http://127.0.0.1:3000> and create a local account.

If you already have this chatbot installed, back up `.env` and `data/chatbot.db`, then extract this version over the old project. Keep your existing `.env` and `data` folder. The server automatically switches the old starter default `nvidia/nemotron-3-ultra-550b-a55b` to the selected Omni model at runtime; you may also update the `NVIDIA_MODEL` line in `.env` for clarity. The server automatically creates the additional `attachment_parts` table; it does not need you to recreate users or conversations.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `NVIDIA_API_KEY` | required | NVIDIA API key |
| `NVIDIA_CHAT_BASE_URL` | `https://integrate.api.nvidia.com/v1` | API base URL |
| `NVIDIA_MODEL` | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | Multimodal model ID |
| `NVIDIA_ENABLE_THINKING` | `false` | Enable model thinking mode; false by default |
| `NVIDIA_MAX_TOKENS` | `4096` | Max output tokens |
| `NVIDIA_TEMPERATURE` | `0.2` | Sampling temperature |
| `DATABASE_PATH` | `./data/chatbot.db` | Local SQLite database path |
| `PORT` | `3000` | Local web server port |
| `SESSION_DAYS` | `30` | Session lifetime |

## Database and privacy

- `users`: usernames and salted password hashes.
- `sessions`: hashed session tokens and expiry.
- `conversations` and `messages`: per-user chat history.
- `message_attachments`: original file BLOBs, file metadata and extracted document text.
- `attachment_parts`: derived image parts, such as rendered PDF pages, for multimodal inference.
- Foreign keys and owner checks prevent one account from listing/opening another user's conversations or attachments. Deleting a conversation cascades to messages, files, and derived parts.
- The app listens on `127.0.0.1` by default.
- Back up by stopping the app and copying `data/chatbot.db` plus any `-wal`/`-shm` files, or use SQLite's backup tooling.
- When you send a message with media, the relevant file content is sent to NVIDIA's hosted API for inference. It is not kept solely on the local machine during analysis. Do not upload sensitive content unless you are comfortable with the service's terms.
- The local database may grow quickly; videos and audio are stored as SQLite BLOBs. The default limit is 5 files, 20 MB per file, and 40 MB total per message.

## Troubleshooting

**`Cannot find module ...`** — Run `npm install` in the directory that contains `package.json`.

**SQLite native dependency install fails on Windows** — Use a current Node.js LTS release, preferably Node 22 LTS, then remove `node_modules` and `package-lock.json` if present and run `npm install` again.

**401/403 from NVIDIA** — Check the API key and that the model is enabled for your NVIDIA account.

**413/415 or media error** — Reduce file count/size and use JPEG/PNG images, WAV/MP3/FLAC audio, MP4 videos up to two minutes, or supported document formats. Oversized or unsupported media stays saved locally if upload succeeded.

**NVIDIA temporarily busy** — The server queues model requests from this app and automatically retries HTTP 429/503 responses with backoff. If NVIDIA remains overloaded, the app shows a friendly message while keeping your prompt and attachments saved locally; it will not display the raw `ResourceExhausted` worker error. NVIDIA's hosted capacity is external, so the app cannot guarantee an immediate model response.

## API routes

- `POST /api/register`, `POST /api/login`, `POST /api/logout`, `GET /api/me`
- `GET /api/conversations`, `POST /api/conversations`
- `GET /api/conversations/:id/messages`, `PATCH /api/conversations/:id`, `DELETE /api/conversations/:id`
- `POST /api/conversations/:id/messages` (multipart `message` plus up to five `attachments`)
- `GET /api/attachments/:id/content` (owner-checked download/view)
- `GET /api/storage/stats`, `GET /api/health`

## References

- [NVIDIA model card](https://build.nvidia.com/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning/modelcard)
- [NVIDIA multimodal API examples](https://docs.nvidia.com/nim/vision-language-models/1.7.0/examples/nemotron-3-nano-omni-30b-a3b-reasoning/api.html)
