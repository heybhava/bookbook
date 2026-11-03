# Folio — Application Audit (2026-11-03)

Method: read-only inspection of the repository, a production build served on port 3140, the full automated suite, live HTTP probes, browser checks (desktop + 375 px), read-only SQLite introspection. **No source code was changed.** (Three throw-away probe records were created and deleted through the app's own API; temp scripts live in the session scratchpad, not the repo.) No secrets exist in the repo; none are quoted. No paid service was called (the only external call was `npm audit` against the public npm registry).

Evidence labels: **[T]** automated test passed · **[B]** observed in a real browser run · **[P]** live HTTP probe · **[C]** code inspection only · **UNVERIFIED** = could not be tested here, with the reason.

## A. Executive summary

Folio today is a strong **local-first reader + recall + notes + journal + vault** application. It is **not** the larger product described in your list: the entire **Goal OS / autonomous research / news / accountability / podcast / video** half **does not exist** in the repository. There is no code anywhere that makes an outbound network request (other than to the local Ollama/Piper/NLLB servers), no scheduler, no notification mechanism, and no podcast/video generator.

- **Works (proven):** book import → processing → reading/navigation/progress, highlights/notes/bookmarks, AI Q&A over books with sources, sentence capture, vocabulary + SRS, FSRS active recall (four extra modes), notes inbox/export/import, translation (te/ta/hi tested), the Obsidian-style vault (links, backlinks, rename-safe links, properties, search, history, graph), Bases (table/cards/list/kanban), Life Journal (record → transcribe with local Whisper → notes → diary → reflection → search → export → delete), multilingual journal layers.
- **Test results (this audit run, against the production build):** 136 tests, **135 pass, 0 fail, 1 skipped**, 183 s. `tsc --noEmit`: **0 errors**. No linter is configured (so lint = not run). 14 of 14 views render with no console errors; no horizontal overflow at 375 px.
- **Biggest risks:** (1) the server is reachable from the LAN with **no authentication** — I read the journal API through the machine's network address (HTTP 200); (2) Host-header spoofing is not blocked (DNS-rebinding shape); (3) **the project folder is not under version control** (git root is your home directory and the folder is untracked); (4) a block of Book→World code (visual/analysis/assets) is **unreachable** (no routes, no UI, `three.js` installed but never imported); (5) the test suite runs against the **real user database** and leaves residue.

## B. Feature status matrix (the 27 intended capabilities)

Status vocabulary as requested. "Partially" always lists what is missing in section D.

| # | Feature | UI | Backend | DB | E2E test | Status | Evidence |
|---|---|---|---|---|---|---|---|
| 1 | Universal Book Reader | yes | yes | yes | md, pdf | **PARTIALLY IMPLEMENTED** | [T] upload/process/chapters/search/progress/delete; [B] open 197-page PDF, Next page ×3 → progress 7→10 persisted; **EPUB/DOCX/XLSX/FB2/HTML/image-OCR extractors have no automated test** (UNVERIFIED); OCR/Calibre/LibreOffice paths UNVERIFIED |
| 2 | AI Book Tutor | yes | yes | yes | yes | **IMPLEMENTED & VERIFIED** | [T] "AI fails honestly without a model"; Telugu Q&A from the book; cross-book Q&A with real sources. Model: gemma3:4b local. Answer *quality* not graded |
| 3 | Notes & knowledge management | yes | yes | yes | yes | **IMPLEMENTED & VERIFIED** | [T] notes CRUD, edit/tag/link/convert, universal search, export/import round-trip (json/csv/md/html) |
| 4 | Automatic sentence/paragraph capture | yes | yes | yes | yes | **IMPLEMENTED & VERIFIED** | [T] selection → note with source metadata, de-dup, offset correction |
| 5 | Vocabulary intelligence | yes | yes | yes | yes | **IMPLEMENTED & VERIFIED** | [T] discovery, IPA, save, SM-2 review. `/ai/word`, `/define` routes untested |
| 6 | Active recall & spaced repetition | yes | yes | yes | yes | **IMPLEMENTED & VERIFIED** | [T] FSRS maths, grounded questions, evaluation, scheduling, exams, Socratic/mind-map/listening/planner (modes.test). **Flaky**: question generation produced 1 question in several earlier full runs (needs ≥2); passed in this run |
| 7 | AI video journal | yes | yes | yes | synthetic | **PARTIALLY IMPLEMENTED** | [B] MediaRecorder with a *synthetic* stream → 4 s chunks → pause/resume → saved, plays, seeks (duration 12.04 s); [T] real speech → WebM → Whisper → notes → diary → report. **Real camera + permission prompt UNVERIFIED** (pane has no devices); mobile UNVERIFIED |
| 8 | Voice journal | yes | yes | yes | yes | **PARTIALLY IMPLEMENTED** | same pipeline as 7 (audio-only [T]); real microphone UNVERIFIED; no background recording |
| 9 | Written diary | yes | yes | yes | yes | **PARTIALLY IMPLEMENTED** | [T] create/edit/mood/tags/many per day. No rich text, photos, drawing, location, templates |
| 10 | Personal reflection & AI conversations | yes | yes | yes | yes | **PARTIALLY IMPLEMENTED** | [T] cited single-entry report (no clinical labels asserted), 10 modes, crisis path deterministic, save/delete conversation. Cross-entry reflection only via opt-in insights. Quality not graded |
| 11 | Journal calendar & memory timeline | yes | yes | yes | yes | **PARTIALLY IMPLEMENTED** | [T]/[B] month grid, thumbnails, memories ("this day last year"), milestones, timeline. No week/year/custom views, filters, scheduled future messages |
| 12 | Goal OS | – | – | – | – | **NOT IMPLEMENTED** | no module; two unrelated goal tables exist (`goals`, `j_goals`) |
| 13 | Goal discovery & decomposition | partial | partial | yes | none | **PARTIALLY IMPLEMENTED** | [P] `POST /goals/:id/gaps` returned 12 model-generated topics (all "gap") but **`path`, `exercises`, `actions` were empty**. No test covers it. No decomposition into milestones/tasks |
| 14 | Autonomous research engine | – | – | – | – | **NOT IMPLEMENTED** | [C] zero outbound HTTP code; no scheduler |
| 15 | Daily news & intelligence monitoring | – | – | – | – | **NOT IMPLEMENTED** | [C] no RSS/news code, no briefing generator |
| 16 | Books/videos/papers/resource discovery | – | – | – | – | **NOT IMPLEMENTED** | [C] only in-library "nextReads"; no URLs, ranking or validation |
| 17 | Learning paths | yes | partial | partial | none | **PARTIALLY IMPLEMENTED** | see 13; Intel UI renders `path` if present; untested and empty in the live probe |
| 18 | OpenUI dynamic interfaces | yes | yes | – | yes | **PARTIALLY IMPLEMENTED** | `@openuidev/react-lang` + `lang-core` 1.0.2: used **only** for recall feedback and the practice plan; server validates syntax/orphans/verbatim quotes, 3 retries, native fallback [T][B]. Not used for goals/journal/briefings |
| 19 | Daily planning | yes | yes | yes | yes | **PARTIALLY IMPLEMENTED** | [T] recall daily session (time-boxed) and exam-date planner; no general daily plan |
| 20 | Accountability partner | – | – | – | – | **NOT IMPLEMENTED** | [C] no check-ins, no notification/PWA/service worker anywhere |
| 21 | Goal progress analytics | partial | partial | partial | partial | **PARTIALLY IMPLEMENTED** | [T] learning report; journal-goal updates counted. No progress analytics per goal |
| 22 | Knowledge graph & cross-book connections | yes | yes | yes | partial | **PARTIALLY IMPLEMENTED** | [T] vault graph (real edges); concept graph UI; concept links are only `co-occurs` from AI Q&A (`ai.ts:143`); no automatic cross-book concept linking; `GET /knowledge` untested |
| 23 | Multilingual translation & learning | yes | yes | yes | yes | **PARTIALLY IMPLEMENTED** | [T] te/ta/hi translation with script validation, glossary, cache, alignment; journal translation layer. Translation *quality* and Indic speech-recognition accuracy UNVERIFIED (English voices only here); UI labels mostly English |
| 24 | Podcast generation | – | – | partial | – | **NOT IMPLEMENTED** | [C] `KINDS` constant + recommendation text only; no generator, no route; TTS (`/tts`, SAPI/Piper) exists but is untested |
| 25 | Video generation | – | – | partial | – | **NOT IMPLEMENTED** | [C] same |
| 26 | Interactive 2D/3D learning | none | dead code | yes | lib only | **UI ONLY / NOT FUNCTIONAL** (no UI either) | `createVisualAsset` has **no caller**; task `analyse-book` is registered but never created; `three`, `@react-three/*` installed, **imported nowhere**; no scene renderer component |
| 27 | Local AI & free-only infrastructure | – | yes | – | yes | **IMPLEMENTED & VERIFIED** | [C][P] only localhost calls (Ollama/Piper/NLLB optional); Whisper, ffmpeg, SAPI local; 0 paid APIs |

**Counts:** IMPLEMENTED & VERIFIED = #2, 3, 4, 5, 6, 27 → **6**; PARTIALLY IMPLEMENTED = #1, 7, 8, 9, 10, 11, 13, 17, 18, 19, 21, 22, 23 → **13**; UI ONLY / NOT FUNCTIONAL = #26 → **1**; NOT IMPLEMENTED = #12, 14, 15, 16, 20, 24, 25 → **7**. Total 27.

### How the percentage is calculated
- **Strict:** 6 / 27 capabilities fully verified end-to-end = **22 %**.
- **Weighted** (verified = 1, partial = 0.5, others = 0): (6 + 13×0.5) / 27 = **46 %**.
- Code-level cross-checks: 254 API routes registered; 209 (82 %) are *mentioned* in at least one test — an upper bound (a mention is not an assertion); 45 are not mentioned (listed in the master checklist). There are **no UI/e2e tests**; UI behaviour was verified by hand in a browser only for the flows named above.
Neither number counts the 7 + 1 capabilities that do not exist as "failing"; they are simply absent.

## C. Working features (with evidence)
- **Reading:** upload md → background processing → readable + chapters [T]; in-book search page refs [T]; progress clamped and persisted [T]; PDF opened in the reader, Next page ×3 saved progress 7→10 and survives reload [B]; unsupported types rejected [T]; delete removes book and data [T].
- **Highlights/notes/bookmarks/vocabulary/goals(CRUD)/flashcards:** [T] `api.test.ts` (10 tests).
- **Capture + inbox + export/import + learning report + drafts:** [T] `intel.test.ts` (14).
- **Recall:** [T] `fsrs.test.ts` (FSRS rules), `recall.test.ts` (10), `modes.test.ts` (7: Socratic never leaks, mind map, listening check, planner).
- **Translation / language registry:** [T] `lang.test.ts` (15).
- **Vault:** [T] `vault.test.ts` (16): atomic save + conflict refusal, external edit detection, link resolution, rename rewrites links, history/restore, search operators, graph, traversal/XSS/unsafe-URL rejection, raw files sandboxed.
- **Bases:** [T] `bases.test.ts` (14): formulas without `eval`, kanban move rewrites the note, CSV formula-injection guard, books/highlights as sources.
- **Journal:** [T] `journal.test.ts` (10), `journal-life.test.ts` (11), `journal-lang.test.ts` (10): chunked upload idempotency/gap refusal, Range serving, separate deletion of layers, real speech → Whisper → grounded notes → diary → report → conversation → search → export → vault note, crisis response, opt-in cross-entry insights, sensitive-entry exclusion, translation layer, measured language checks.
- **Database:** 10 migrations applied, `PRAGMA integrity_check = ok`, `foreign_key_check` = 0 violations, 75 tables.
- **Mobile layout (375 px):** no page-level horizontal overflow on all 14 views [B].

## D. Partially working features — what exactly is missing
- **Reader (#1):** formats other than md/pdf untested; OCR (Tesseract in browser) and server-side converters (Calibre, LibreOffice) never exercised here; no EPUB CFI locators (page-based anchors only); TTS audio reader untested (`/tts` route not mentioned in any test; browser speech needs an audio device).
- **Journal media (#7/#8):** real devices, mobile permissions, > 30-minute recordings, low-disk behaviour (code exists, untested), background recording absent.
- **Journal writing (#9):** plain text + Markdown only.
- **Reflection (#10):** report and conversation are *per entry*; quality judged only structurally; `gemma3:4b` sometimes returns sparse notes (mitigated by retries and sentence-level extraction).
- **Calendar (#11):** month only; no week/year/range, no content filters; "future-self" recordings are not scheduled to resurface.
- **Learning path/decomposition (#13/#17):** model topics only; empty path/exercises/actions in the live run; untested.
- **OpenUI (#18):** a *fixed component library* (Panel, Callout, KeyPoints, Steps, Formula, Quote, Mnemonic, Compare, Pair) with LLM-written layouts, validated and grounded for recall only. State of generated interfaces is not persisted; no use elsewhere.
- **Daily planning (#19):** study-specific only.
- **Knowledge graph (#22):** see matrix.
- **Multilingual (#23):** Indic ASR accuracy, translation quality, journal UI strings, cross-language journal search.

## E. Broken features / defects found
| ID | Defect | Evidence | Effect |
|---|---|---|---|
| E1 | Orphaned index rows after a vault is "forgotten": 20,167 of 20,168 `vlinks`, 4,141/4,142 `vtags`, 4,551/4,558 `vprops`, 2,599/2,601 `vheads`, 2,291/2,296 `vcontent`, 131/133 `vhistory` belong to vaults that no longer exist | [P] read-only SQL | unbounded DB growth; wrong counts if ids ever collide; caused by index tables having no FK/cascade (`forgetVault` only deletes `vaults`→`vfiles`) |
| E2 | `POST /goals/:id/gaps` returns empty `path/exercises/actions` | [P] one live run | "learning path" promise not met |
| E3 | Recall question generation intermittently returns 1 question | [T] failed in ≥4 earlier full runs this session; passes on rerun | flaky suite, thin practice sets |
| E4 | Vault and Bases are unusable on phone widths: explorer fixed at 256 px leaves 119 px for the editor; right panel (`hidden lg:block`) is not reachable below 1024 px | [B] 375 px measurement | backlinks/properties/history inaccessible on mobile/tablet portrait |
| E5 | Stray/unreachable modules (see #26) | [C] grep | wasted complexity, false impression of a Book→World feature |

## F. UI-only features
- Interactive 2D/3D "Book→World" experiences: no UI at all; backend fragments unreachable (see #26). Nothing else was found that is purely cosmetic: every button inspected in the journal, vault and bases screens calls a real endpoint. (Not every screen of the older Views was clicked individually.)

## G. Missing features (vs. the intended product)
Goal OS (goal graph, life-area goals, OKRs), automatic goal discovery from reading/journal, decomposition into milestones/weekly tasks, resource discovery (books/papers/videos/courses with real URLs and ranking), autonomous research jobs, scheduled job runner (cron/time zones/retries/history), daily news/intelligence monitoring with de-duplication and briefings, accountability check-ins and reminders (notifications/PWA), goal progress analytics, daily planning across goals, podcast and video generation, interactive 2D/3D learning experiences, unified goal model across Goals/Journal/Vault, OpenUI-driven dashboards, cross-book concept linking, PWA/offline install, accessibility audit, authentication/multi-user.

## H. Technical debt
- `src/app/api/[...path]/route.ts` (536 lines) plus eight `routes*.ts` modules register 254 routes by hand in one global list; no schema validation layer (inputs checked ad hoc; zod is installed and unused for requests).
- **Two goal models** (`goals`/`goal_concepts` vs `j_goals`) and **two SRS schedulers** (SM-2 for vocab/flashcards, FSRS for recall) — the second is deliberate, the first is an integration gap.
- Duplicated helpers (`stems/sig/support/jacc` copied in `recall/engine.ts`, `journal/ai.ts`, `journal/cluster.ts`).
- Dead code: `intel/visual.ts` (generator), `intel/pageintel.ts` (`analyse-book` task), `intel/assets.ts`, `scene/*` — reachable only from tests/imports, not from routes or UI.
- `tsconfig.json` is rewritten by Next on every build with a different `NEXT_DIST_DIR` (the include list keeps growing).
- Source files use very long lines (dense one-liners), hurting reviewability.
- No ESLint, no CI, no Prettier config.
- `translateDoc` contains a convoluted kind check (works, but unreadable).

## I. Security and privacy
| ID | Finding | Evidence |
|---|---|---|
| S1 (critical) | **Server listens on all interfaces with no authentication.** A request to the machine's LAN address returned HTTP 200 for `/api/journal/entries`; `/api/books`, `/api/notes`, `/api/vaults`, `/api/journal/people` also answer 200 without credentials | [P] |
| S2 (high) | **Host header is not validated**: `GET` with `Host: evil.example` → 200 (DNS-rebinding shape). The CSRF guard only covers non-GET requests that carry an `Origin` header; a POST *without* Origin is accepted (400 only because the probe body was invalid) | [P][C] `route.ts:517-521` |
| S3 (high) | **Project not under version control**: `git ls-files .` = 0; git top-level is `C:/Users/talkt`; the folder shows as untracked | [P] |
| S4 (high) | `npm audit --omit=dev`: `xlsx` (high: prototype pollution GHSA-4r6h-8v6p-xvw6, ReDoS GHSA-5pgg-2g8v-p4x9, **no fix**) parses uploaded spreadsheets; `next`→`postcss` (moderate ×4) | [P] |
| S5 (medium) | No data isolation by design: `LOCAL_USER` constant used 234×; **16 of 22 journal tables have no `user_id`**; vault root can be any folder the process can read (by design, local) | [C][P] |
| S6 (medium) | No encryption at rest (SQLite + plain media files); no journal lock/PIN | [C] |
| S7 (low) | Uploaded originals are served as `application/pdf`/`octet-stream` with `nosniff` (safe); vault raw files served with `CSP: sandbox` (safe); Markdown/HTML rendering escapes raw HTML (tested) | [T] |
| S8 | Zip/archive handling (docx, epub, xlsx via `jszip/mammoth/xlsx`) has no explicit decompression-size cap in code | [C] not tested |

Verified positives: path traversal/absolute/reserved names rejected in vault [T]; cross-origin POST with `Origin` blocked (403) [P][T]; SVG/HTML attachments sandboxed [T]; crisis messages never routed only to the model [T]; no secrets in repo.

## J. Performance and reliability
- Build/type: `tsc` 0 errors; `next build` succeeded earlier in this session on identical source (not rebuilt during the audit to avoid touching `tsconfig.json`).
- Measured (2,000 synthetic notes / 20,000 links, single run): initial index 7.6 s; warm scan 80 ms; search 83–149 ms; backlinks 147 ms; save one note 27 ms; rename with link rewrite 5.8 s *before* a fix that was not re-measured. **No 10k-note / 100k-link run exists.** Graph SVG with ~20k edges not measured.
- Whisper `base` on CPU ≈ 10–15 s for 20 s of audio; timeouts = max(10 min, 4× duration); a 1-hour recording is untested.
- Background work: one in-process lane (`intel/tasks.ts` + journal pipeline queue); jobs interrupted by a restart are marked failed with Retry; there is **no scheduler**.
- **Tests write to the real database** (no isolated data dir) and leave residue: 8 `j_dismissed` rows, 2 test vaults still registered (`BasesUI`, `UI Test…`), a leftover `data/vaults/bench…` folder, 1 stored language test.
- Data volume now: DB 19 MB (+16 MB WAL), data folder 43 MB.

## K. Paid dependencies (free-only compliance)
**None found.** Inventory: Ollama (local, free), `gemma3:4b`/`llama3.1:8b`/`nomic-embed-text` (local), openai-whisper (local Python), ffmpeg, Windows SAPI TTS (local), optional Piper (`PIPER_URL`) and NLLB/IndicTrans2 (`NLLB_URL`) servers (not installed, unverified), Tesseract.js in-browser OCR. Only external URL strings in source: `ollama.com`, `libreoffice.org`, `calibre-ebook.com`, `github.com` (documentation/links). `xlsx` is free but vulnerable (S4). Future Goal OS research can stay free via OpenAlex, Crossref, arXiv, Open Library, Wikipedia/Wikidata, RSS feeds, optional self-hosted SearXNG — **none exists yet**.

## L. Integration gaps
1. Journal goals (`j_goals`) ↔ learning goals (`goals`) ↔ vault notes: three disconnected stores.
2. Journal ↔ books: no link from a journal topic to a book passage or concept (the spec's "compound interest" example is not possible).
3. Journal ↔ recall: journal questions/quotes cannot become recall questions or Notes with one click (only "save to vault").
4. Highlights/books ↔ vault: `Bases` can list books/highlights, but vault notes cannot cite a highlight and there is no `folio://` link scheme.
5. Recall ↔ Goals: gap analysis does not feed the daily recall queue.
6. OpenUI used only inside Recall.
7. Reading sessions ↔ journal calendar: no shared timeline.
8. Book→World modules ↔ routes/UI: unconnected.
9. No notifications channel to deliver any reminder, even for existing features.

## Appendix — commands and results
- `git ls-files .` → 0; `git rev-parse --show-toplevel` → home directory.
- `npx tsc --noEmit` → no output (0 errors). No eslint config/script.
- `BASE_URL=http://localhost:3140 npm test` → `tests 136, pass 135, fail 0, skipped 1, duration 182876 ms`.
- `npm audit --omit=dev` → 3 vulnerabilities (1 moderate, 2 high).
- Probes: LAN-address request → 200; spoofed Host → 200; POST no Origin → 400 (processed); POST with foreign Origin → 403.
- Read-only SQL: migrations 1–10, 75 tables, integrity ok, FK violations 0, orphan counts as in E1.
- Browser: 14 views at 375 px — no horizontal overflow; Vault layout measurement as in E4; console errors: none.
