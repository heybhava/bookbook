# bookbook — a free, local-first AI book reader

**Read anything. Understand everything. Remember what matters.**

Drop a book in, read it in a calm reader, and get an AI companion that works *from the book itself*: definitions with pronunciation, page summaries, cited answers, audio with word-by-word highlighting, flashcards and spaced repetition.

Everything is free and runs on your machine. **No API keys, no accounts, no cloud.** Books never leave your computer; AI runs through [Ollama](https://ollama.com).

## Windows download

Download `bookbook Setup 1.0.0.exe` from the project's Releases page and run it (no administrator rights needed; it installs for your user only). Verify the download against the `SHA256` value in the release notes with `certutil -hashfile "bookbook Setup 1.0.0.exe" SHA256`.

The installer is **not code-signed yet**, so Windows SmartScreen shows *"Windows protected your PC"* the first time: choose *More info → Run anyway* only if the checksum matches. Your library lives in `%APPDATA%\Folio` (the folder name is kept from the app's earlier name so existing libraries are not orphaned).

## Quick start

Requirements: **Node 22.5+** (24 recommended) and, for the AI features, **Ollama**.

```bash
npm install
npm run setup     # checks Node, Ollama, models, optional converters
npm run dev       # http://localhost:3100
```

Then open the app → **Settings & models** → *Download a model* (e.g. `qwen3:8b`, or `gemma3:4b` for lighter machines) and `nomic-embed-text` for semantic search. You can also do this in a terminal: `ollama pull qwen3:8b && ollama pull nomic-embed-text`.

Production: `npm run build && npm start`. Docker: `docker compose up -d --build` (includes an Ollama container).

Without Ollama you can still: import and read books, search, bookmark, highlight, take notes, look words up in the offline dictionary, hear pronunciations, listen with browser speech, and review saved flashcards/vocabulary. AI panels say clearly when no model is available — they never fake an answer.

## What it does

| Area | Details |
|---|---|
| **Library** | Drag-and-drop & bulk upload, grid/list, search, sort, filter, collections, tags, covers (EPUB), metadata editing, *Continue reading*, background processing — you can open a book as soon as text is extracted, while indexing continues. |
| **Reader** | PDFs render with the original layout (PDF.js + selectable text layer). Other formats use a typographic reflowable layout. Contents, in-book search, bookmarks, 5 highlight colours, annotations, serif/sans/mono, size, line-height, width, light/sepia/dark, fullscreen, keyboard shortcuts. Exact page + scroll position is restored. |
| **Smart vocabulary** | Select a word → offline definition(s), part of speech, IPA, synonyms, antonyms, related words, examples (WordNet + CMU dictionary, no network), pronunciation in British/American/Australian voices when your OS has them, plus an AI *in-context meaning*, examples and (labelled, unverified) etymology. Phrases get simplification, idioms, grammar and translation. Save word → spaced repetition. |
| **Summaries** | Quick, detailed, simple, technical, takeaways, terms, arguments, connections, memory — for a selection, page, next N pages, chapter or whole book (long ranges use section-by-section map-reduce and say so if sections were sampled). |
| **Ask (book-aware tutor)** | Hybrid retrieval (SQLite FTS5/BM25 + local embeddings, fused by RRF, boosted near the current page) → streamed answer with `[S1]`-style citations that map to real pages and passages. 7 tutor personalities. The model must label *From the book* vs *General knowledge* vs *My interpretation*; citations to sources that weren't supplied are flagged. |
| **Audio** | Word/sentence/paragraph/page/chapter/book playback with play/pause/skip, speed, volume, voice + accent choice, sleep timer, auto-advance across pages and chapters, live word & sentence highlight with auto-scroll, remembered position. Browser speech works immediately; Piper is supported as an optional local neural engine with on-disk audio cache. |
| **Knowledge** | Searchable library across books and goals, interactive graph (goals, concepts, books, vocabulary; concepts seen in 2+ books are marked as cross-book bridges), Markdown export of highlights/notes/vocab/knowledge. |
| **Active learning** | AI flashcards and quizzes (MCQ, true/false, short answer) with source page + quote; SM-2 spaced repetition for cards and vocabulary; stats: reading time, books finished, retention, quiz average, progress. |

### Personal intelligence (v2)

- **Capture as you read** — select a sentence or passage and it is saved to your Notes automatically (book, author, chapter, section, page, exact position, surrounding context, timestamp), with a small *Saved · Undo* toast. Re-selecting the same passage never duplicates. Click any note to jump back to that exact spot. Choose *always / sentences only / highlight only* in Settings.
- **Vocabulary discovery** — each page is scanned for words worth learning (offline), shown as faint dotted underlines and as a list in the Word tab: save one/all/selected, add flashcards, hear the pronunciation, mark "I know this".
- **Knowledge Inbox** — every note, passage, highlight, word, concept and lesson in one searchable place; tag, link, bulk-edit, convert to a flashcard / concept / question / objective / action, export or import.
- **Ask your library** — natural-language questions across all books and notes, with *compare authors*, *find contradictions*, *what I learned* and *teach me* modes. Every claim cites a real passage (book, chapter, page); evidence and AI interpretation are shown separately with a confidence note.
- **Companion** — contextual suggestions based on the page, seven reading modes (Learning, Deep understanding, Critical thinking, Exam, Research, Language) that never alter the document.
- **Active learning** — concept quizzes, *Teach it back* (your explanation is checked against the source), mastery scores that move only when you are tested, weekly/monthly learning report.
- **Write** — a drafting space that inserts real cited quotes from your library, plus AI help grounded in your sources.
- **Ctrl/Cmd+K** command palette searches books, notes, vocabulary and passages everywhere.

Word-difficulty data: the English 10k frequency list from the MIT-licensed `most-common-words-by-language` package is bundled in `public/dict/`.

### Formats

| Works natively | Needs a free converter you install | Not supported |
|---|---|---|
| PDF (text), EPUB, DOCX, TXT, Markdown, HTML, FB2, CSV, XLSX, JPG/PNG/WebP (Tesseract OCR) | MOBI, AZW, AZW3 → **Calibre** (`ebook-convert`); DOC, PPT, PPTX, ODT, RTF → **LibreOffice** (`soffice`) | CBZ/CBR comics; DRM-protected files (never circumvented) |

Honest notes: the converter-based formats are wired up but were **not** exercised end-to-end here (Calibre/LibreOffice were not installed on the dev machine). EPUB/DOCX/etc. are rendered from extracted text — inline images and exact CSS are not reproduced. OCR uses `tesseract.js` with the worker, wasm core and English data bundled in `public/tesseract` (no network); it recognises English only and the scan stays an image (no selectable text on OCR'd pages).

## Keyboard shortcuts

`←` `→` page · `B` bookmark · `/` search in book · `F` fullscreen · `[` / `]` toggle panels · `Space` pause/resume audio · `Esc` clear selection. In Review: `Space` reveal, `1–4` grade.

## Better OCR (optional, Unlimited-OCR)

For high-quality OCR of scanned PDFs, run [baidu/Unlimited-OCR](https://github.com/baidu/Unlimited-OCR) (MIT) with its SGLang server per its README (Linux/WSL2, NVIDIA GPU; the authors only document an 80 GB card, so check it fits yours) and set `UNLIMITED_OCR_URL=http://127.0.0.1:10000`. The OCR button then sends each page image to it. *Implemented but untested against a live server; the request format follows the OpenAI-compatible API and the prompt is overridable via `UNLIMITED_OCR_PROMPT`.* Without it, Tesseract is used.

## Better voices (optional, Piper)

Browser voices are generated by your OS. For neural voices, run a Piper HTTP server (e.g. `pip install piper-tts && python -m piper.http_server -m en_GB-alba-medium`) and set `PIPER_URL` in `.env`. The app POSTs `{text, voice}` and expects `audio/wav`; audio is cached in `data/audio`. *This integration is implemented but untested against a live Piper server.* Piper gives sentence-level highlighting (no per-word timing).

## Data, privacy, security

- All data lives in `data/` (`bookreader.db` SQLite, original files untouched in `data/files`, covers, audio cache).
- No telemetry, no external requests except to your local Ollama (and a one-time Tesseract language download if you OCR an image).
- Uploaded files are untrusted: size limit (`MAX_UPLOAD_MB`, default 500), extension allow-list, server-generated file names, text-only extraction (no scripts executed or rendered), PDF.js with eval disabled, document text fenced as data in every prompt with instructions never to obey it, cross-origin write requests rejected.
- **Single-user.** The schema has a `users` table and every query is scoped by user id, but there is no login screen: anyone who can reach the port can use it. Bind to localhost (default for `npm run dev`) or put it behind your own auth/reverse proxy before exposing it.
- Backup: *Settings → Full backup* downloads a zip (DB + originals). Restore: stop the app, unzip into `data/` (`files/`, `covers/`, `bookreader.db`), start.

## Tests

```bash
npm run typecheck
npm test            # unit tests + API integration tests (start the server first for the latter)
```

## Licences

All direct dependencies are permissive (MIT, BSD-2, ISC, Apache-2.0; `jszip` is used under MIT). WordNet 3.1 (Princeton licence) and the CMU Pronouncing Dictionary (BSD-style) ship inside npm packages. Models you download via Ollama carry their own licences — check each model's page.

## Copyright

Copyright (c) 2026 bookbook. **All rights reserved** - see `LICENSE`. This is not open-source software: you may install and use it, but you may not copy, modify, redistribute or sell it without written permission.
