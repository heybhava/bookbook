# Folio ↔ Obsidian-level knowledge system — parity matrix

Status values: `NOT_STARTED` · `IN_PROGRESS` · `IMPLEMENTED_UNVERIFIED` · `VERIFIED` (automated test asserts the behaviour, run green) · `BLOCKED`.
"Verified" means *verified by the tests listed*, not "equal to Obsidian". Last updated: milestone 2 (Phases 0–4 partial, Phase 5 Bases). Test files: `tests/vault.test.ts` (3 parser tests + 12 API tests).

## Existing Folio (Phase 0 audit — all preserved)

| Area | Behaviour | Status | Location |
|---|---|---|---|
| Library, import (PDF/EPUB/DOCX/TXT/MD/HTML/images+OCR…), covers, collections | works | VERIFIED (existing 75-test suite) | `src/lib/ingest.ts`, `extract/`, `library.ts` |
| Reader (text + PDF.js), progress, bookmarks, themes, fonts, TTS | works | VERIFIED (existing) | `components/reader/*`, `lib/tts.ts` |
| Highlights / notes on books (SQLite `highlights`, `notes`) | works; **page-based locators** (page + text offsets / PDF ranges), not EPUB CFI | VERIFIED (existing) | `routes2.ts`, `db.ts` |
| Hybrid search (BM25 + embeddings) over books | works | VERIFIED (existing) | `rag.ts`, `routes4.ts` |
| Recall/FSRS, translation, AI (Ollama) | works | VERIFIED (existing) | `recall/`, `lang/`, `ai.ts` |

## New: vault foundation (this milestone)

| Feature | Reference behaviour | Status | Location | Tests | Known limitations |
|---|---|---|---|---|---|
| Create / open / list / rename / forget vaults | multiple vaults, open any folder | VERIFIED | `vault/store.ts`, `routes8.ts` | A, M | Folder is typed as a path (no native picker in a browser). "Forget" never deletes files. |
| Files are source of truth; index is a cache | plain `.md` on disk | VERIFIED | `store.ts` `scan()` | A, B, M | Index tables `v*` in migration 7 can be rebuilt with **Re-index**. |
| External change detection | detect create/modify/delete | VERIFIED (on every request + window focus + manual re-index) | `scan()` | B | **No live file-watcher**: changes are noticed when the app next asks, not instantly. Renames made outside Folio appear as delete+create (links are re-resolved but not rewritten). |
| Safe save with conflict detection | never overwrite external edits silently | VERIFIED | `writeFile(baseHash)` | B | Conflict UI offers "load disk" / "overwrite mine"; no 3-way merge. |
| Atomic writes, path safety | no traversal / symlink escape / reserved names | VERIFIED | `safePath`, `atomicWrite` | P | Windows reserved names + trailing dot/space rejected. Symlink escape rejected on write/read and skipped when scanning (symlink test is not automated). |
| Soft delete | `.trash` | VERIFIED | `deletePath` | N | No UI to browse `.trash` (files are plain folders you can open in the OS). |
| File Recovery (history) | snapshots + restore | VERIFIED | `snapshot/restore` | N | Snapshot on save at most once per 45 s while typing, 60 per file; restore is reversible. Stored under `data/vault-history`, not inside the vault. |
| Markdown: Source mode | raw editing | IMPLEMENTED_UNVERIFIED | `Vault.tsx` Editor | UI smoke only | Plain `<textarea>`: **no syntax highlighting, line numbers, folding, multi-cursor, Vim mode, find/replace UI, slash commands**. Has Ctrl+B/I/K, bracket pairing for selections, `[[` autocomplete, list continuation, Tab indent. |
| Markdown: Reading view | rendered doc | VERIFIED (server render) | `vault/render.ts` | C, P | GFM tables/tasks/footnotes, callouts (+foldable), `==highlight==`, tags, wikilinks, embeds of notes/headings/blocks/images/audio/video. **Math is shown as LaTeX source (not typeset); Mermaid not rendered; no syntax highlighting in code blocks; PDF embeds are links; raw HTML is escaped (not rendered).** |
| Markdown: Live Preview | WYSIWYG-ish | NOT_STARTED | — | — | Needs a CodeMirror 6 integration; deliberately not faked. Reading-view checkboxes are interactive and write back to the file. |
| Wikilinks / aliases / anchors / block ids / embeds | full syntax | VERIFIED (index + render) | `parse.ts`, `render.ts` | parser, D, C | Block ids are rendered/embeddable but there is no "create block id" command. |
| Link resolution | shortest-path, duplicates handled | VERIFIED | `resolveIn` | D, dup | Ambiguous names resolve to same-folder → shortest path and are flagged `ambiguous`. |
| Backlinks (incremental index) | linked + unlinked | VERIFIED | `backlinks()` | D | Linked mentions use the index; **unlinked mentions scan note text** (limit 60, fine to ~10k notes; not benchmarked). "Link it" converts a mention. |
| Outgoing links, unresolved links | | VERIFIED | `outgoing`, `unresolvedLinks` | D | Unresolved list endpoint exists; no dedicated panel yet. |
| Rename/move updates links | wikilinks + md links | VERIFIED | `movePath` | D | Folder moves rewrite links in all notes. Embeds, aliases and anchors preserved. |
| Properties (YAML) | typed editor, raw YAML | VERIFIED | `setProps`, `Props` | E, parser | Unknown keys, comments and body preserved. Types detected: text, number, boolean, date, datetime, list, tags. Nested objects are read-only in the field editor (use raw YAML). No type-conversion UI. |
| Tags view | nested tag tree + counts | VERIFIED | `tagTree` | UI, M | Tags are flat chips in the sidebar (hierarchy is computed, shown flattened). No tag rename/merge. |
| Search operators | file: path: content: tag: line: section: block: task: task-todo: task-done: [prop:value] "phrase" -x OR /regex/ match-case | VERIFIED (core ones) | `parseQuery/search` | K | Sorting by relevance/name/date in API; UI uses relevance. `ignore-case`/`match-case` are query-wide. No saved searches / history yet. Scans an in-memory candidate set (SQL prefilter on plain terms) — **not benchmarked at 10k notes**. |
| Quick switcher | fuzzy + create | VERIFIED (API), IMPLEMENTED_UNVERIFIED (modal) | `quickSwitch`, `Switcher` | K | Ctrl+O. |
| Outline | heading tree | IMPLEMENTED_UNVERIFIED | `Outline` | — | Not collapsible; clicking does not scroll. |
| Graph view (global + local) | force graph | VERIFIED (data), IMPLEMENTED_UNVERIFIED (renderer) | `graph()`, `ForceGraph` | G + browser smoke | Zoom/pan/drag/click-to-open, depth, tag filter, orphans/unresolved/attachment toggles, labels, repel & link-length sliders, hover highlight, embed edges dashed. **Missing:** colour groups UI, node-size/edge-opacity sliders, saved graph settings, bookmarked views, path/property filters, **book/highlight nodes**. SVG renderer — not tested on large graphs. |
| Import existing Obsidian vault / Markdown folder | open in place | VERIFIED (open in place) | `createVault(existing)` | M | `.obsidian/` untouched and ignored. **No** Notion/Evernote/etc. importers. |
| Attachments | stored in vault | IMPLEMENTED_UNVERIFIED | `/vault/upload` | upload not tested | No paste/drag-drop image UI yet; no attachment-folder setting. |

## New: Bases (Phase 5, milestone 2) — tests: `tests/bases.test.ts` (4 pure + 10 API)

| Feature | Status | Location | Limitations |
|---|---|---|---|
| `.base` file (YAML: `filters`, `formulas`, `properties.displayName`, `views[]` with `order/sort/groupBy/limit/filters`) | VERIFIED | `vault/bases.ts` | **Interoperability with Obsidian's `.base` files is by key-name convention and has NOT been tested against real Obsidian files.** Unknown top-level keys and comments survive a save (tested). |
| Safe expression language (parsed AST, no eval): operators, `if/date/now/today/number/min/max/round…`, string/list/date methods, `file.hasTag/inFolder/hasLink/hasProperty`, date ± durations (`"7d"`), formulas referencing formulas, cycle detection | VERIFIED | `vault/expr.ts` | Subset of Obsidian's function library: no lambdas/`map`/`filter`, no regex, no `link()` objects. Step budget 20 000, nesting 40, length 2 000. Prototype/`constructor` access returns null (tested). |
| Filters: global + per-view, AND/OR/NOT, nested | VERIFIED | `bases.ts` | UI is a text box (one expression per line, AND); OR/NOT/nesting need raw YAML or JSON in the box. |
| Table view: configurable columns, reorder (drag header), resize, display names, multi-rule sort (header click = primary), grouping with collapse, summaries (count/filled/empty/unique/sum/average/min/max/median), inline edit (double-click → writes the note's YAML), CSV export, new record | IMPLEMENTED_UNVERIFIED (UI) / VERIFIED (API) | `Bases.tsx` | Inline edit works for plain note properties (not file.* / formula.*). No multi-row operations, no copy-results button (CSV only). Column resize persists on **Save changes**. |
| Cards view (cover property, card width, grouping) | IMPLEMENTED_UNVERIFIED | `Bases.tsx` | Cover is a property holding a vault path or http(s) URL. |
| List view | IMPLEMENTED_UNVERIFIED | | Bulleted only (no numbered/preview mode). |
| Kanban (group-by property → columns, drag card to another column → **source note's property is rewritten**, empty-property column, collapse, "+ New" pre-filled with the column value and with values implied by simple `==`/tag/folder filters) | VERIFIED (API) + drag/drop observed in the browser | | **Card order inside a column is not persisted**; column rename and folder-based movement not built. |
| Multiple views per base, view switcher, add/delete view, unsaved-change preview with Save/Discard | IMPLEMENTED_UNVERIFIED | | |
| Embedded base: `![[Name.base]]` renders the first view (first 50 rows, read-only) in Reading View | VERIFIED | `render.ts` | No ```` ```base ```` code blocks; no view picker. |
| **Books and highlights as sources** (`source: books` / `highlights`): reading status, progress %, page count, highlight/annotation counts, collections, tags; highlight text/colour/book/page/annotation. Rows keep identity (`book:<id>`, `highlight:<id>`); click opens the book (highlight rows open its page). Read-only. | VERIFIED (API) | | Reading sessions, projects and review-queue sources are not exposed. Cannot mix notes and books in one base. |
| Map view; Reader/Library-specific view | NOT_STARTED | | |
| Templates for new records; "create from template" | NOT_STARTED | | |
| Custom aggregate functions | NOT_STARTED | | |

## Remaining Obsidian core plugins (29)

| # | Plugin | Status | Notes |
|---|---|---|---|
| 02 | Backlinks | VERIFIED | see above |
| 03 | Bases | VERIFIED (API) / IMPLEMENTED_UNVERIFIED (UI) | see Bases section |
| 06 | Command Palette | NOT_STARTED | existing Ctrl+K palette is for Folio, not wired to vault commands; no command registry yet |
| 08 | File Explorer | IMPLEMENTED_UNVERIFIED | tree, new note/folder, rename/move (prompt), delete; **no drag-and-drop move**, sorting options, or multi-select |
| 09 | File Recovery | VERIFIED | see above |
| 11 | Graph View | IMPLEMENTED_UNVERIFIED | see above |
| 13 | Outgoing Links | IMPLEMENTED_UNVERIFIED | panel tab |
| 14 | Outline | IMPLEMENTED_UNVERIFIED | |
| 16 | Properties View | VERIFIED | per-note panel; vault-wide property list via API only |
| 18 | Quick Switcher | IMPLEMENTED_UNVERIFIED | |
| 20 | Search | VERIFIED (partial) | |
| 24 | Tags View | IMPLEMENTED_UNVERIFIED | |
| 28 | Word Count | IMPLEMENTED_UNVERIFIED | status bar |
| 01 Audio Recorder, 04 Bookmarks, 05 Canvas, 07 Daily Notes, 10 Footnotes View, 12 Note Composer, 15 Page Preview, 17 Publish, 19 Random Note, 21 Slash Commands, 22 Slides, 23 Sync, 25 Templates, 26 Unique Note Creator, 27 Web Viewer, 29 Workspaces | **NOT_STARTED** | Phases 5–10 |

## Not started (by phase)

Phase 6 Canvas · Phase 7 books/highlights/annotations as vault objects (provenance links, unified highlight library, `folio://` URIs) · Phase 8 remaining core plugins · Phase 9 templates, importers, Web Clipper, plugin platform, CLI · Phase 10 native integrations, Sync, Publish · Phase 11 source-grounded AI over the vault · Phase 12 accessibility audit, 10k-note/100k-link performance runs, security review. **BLOCKED (needs infrastructure not present here):** Sync server, Publish hosting, native iOS/Android shells.

## Honest summary

Folio now has a real, tested, file-backed notes vault with links, backlinks, rename-safe linking, properties, tags, operator search, history/recovery and a graph. It is **not** at Obsidian parity: the editor is basic, and roughly two thirds of the required areas have not been started. Existing reader features are unchanged.
