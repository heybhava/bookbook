# Folio architecture (as discovered, plus the vault layer)

## What exists (audit)

- **Stack:** Next.js 15 App Router (client-rendered single page, hash routing), TypeScript 5.9, Tailwind v4, Zustand. One catch-all API route (`src/app/api/[...path]/route.ts`) with `on(method, pattern, handler)`; features register via `registerX(kit)` modules (`routes2…routes8`).
- **Runtime/persistence:** the app is a **local server** (Node ≥ 22.5). Storage is `node:sqlite` (WAL, FTS5) at `data/bookreader.db` with versioned, additive migrations in `src/lib/db.ts` (1–7), plus files under `data/` (uploaded books, covers, audio). Single local user (`LOCAL_USER`), no auth, no cloud.
- **Reader:** books are extracted to `pages`/`chapters`/`chunks`; text pages render in `TextPage.tsx`, PDFs through vendored pdf.js (`PdfPage.tsx`) with a CSS-Custom-Highlight overlay and offline OCR. Highlights/notes are SQLite rows keyed by `book_id + page + char range` (PDF: ranges per text layer). **Locators are page-based, not EPUB CFI.**
- **AI:** Ollama-only (local), task→model routing, hybrid retrieval (BM25 + nomic embeddings). No paid APIs.
- **Tests:** `node --test tests/*.test.ts`; API tests run against a production build on a spare port.

## Source-of-truth decision

| Data | Source of truth | Index/cache |
|---|---|---|
| Vault notes, canvases, bases, attachments | **Files in the vault folder** (plain Markdown etc.) | `v*` tables in SQLite — rebuildable with *Re-index* |
| Books, highlights, book notes, reading progress, recall | SQLite (existing) | FTS/embeddings |
| Vault history | `data/vault-history/<vault>/<id>` + `vhistory` rows | — |

No data is stored in two places as "truth". Phase 7 will make book highlights addressable from the vault by **reference** (stable `folio://highlight/<id>` links resolved at read time), never by copying text into a second store; any generated literature note will keep user text outside clearly marked auto-generated blocks.

## Platform abstraction

Folio runs on the user's machine, so the *server* has real filesystem access and the browser only talks to the API. That means "browser vs native" file-permission differences do not apply to the current deployment; a hosted/PWA-only deployment would need a different adapter (File System Access API / OPFS), which is **not implemented**. All vault I/O is inside `src/lib/vault/store.ts` behind functions that take a `Vault`, so another adapter could be substituted.

## Vault layer (`src/lib/vault/`)

- `parse.ts` — pure functions: frontmatter split (YAML via `yaml`, comment-preserving edits), code masking, wikilinks/embeds/md links, tags, headings, tasks, property typing.
- `store.ts` — registry, `safePath` (rejects traversal, absolute paths, reserved names, symlink escapes), scan/index, read/write (atomic, hash-based conflict detection), move with link rewriting, history, backlinks, tags, props, search, quick switch, graph.
- `render.ts` — Markdown → HTML with `marked`; raw HTML escaped, URLs allow-listed, embeds depth-limited with cycle detection.
- `routes8.ts` — HTTP API (`/api/vaults`, `/api/vault/*`). Raw attachments are served with `CSP: sandbox` + `nosniff`.
- `components/Vault.tsx` — explorer, source editor, reading view, right panel (links/properties/outline/history), graph, quick switcher.

### Index model (migration 7)
`vfiles(path,mtime,size,hash)` · `vlinks(src,raw,target,embed,anchor,alias,ambiguous)` · `vtags` · `vprops(key,value JSON,type)` · `vheads` · `vtasks` · `vcontent(body)` · `vhistory`. A content edit re-indexes **one** file; links are re-resolved globally only when the *set of files* (or aliases) changes.

### Trade-offs
- Textarea editor now vs. CodeMirror 6 later: chosen to ship a correct file model first; Live Preview needs CM6 and will be added rather than imitated.
- Server-side rendering for Reading view: single sanitisation point; costs one request per render (debounced).
- No file-watcher: avoids platform flakiness; scanning is mtime+size based and cheap.
