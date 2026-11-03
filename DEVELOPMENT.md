# DEVELOPMENT

## Architecture

```
src/app/page.tsx              single-page shell (hash routed: #/read/<id>, #/review …)
src/app/api/[...path]/route.ts  one small router: all REST + NDJSON streaming endpoints
src/lib/db.ts                 node:sqlite (built-in, FTS5), versioned migrations, user-scoped helpers
src/lib/extract/index.ts      common document abstraction → {chapters, pages, cover, notes}
src/lib/ingest.ts             upload validation, single-lane background queue, converters, OCR, chunking, embeddings
src/lib/ollama.ts             model detection, per-task model choice, chat/stream/embed, JSON parsing
src/lib/rag.ts                hybrid retrieval (BM25 + cosine, RRF + page-proximity boost), personas, safety prompt
src/lib/ai.ts                 summaries (map-reduce), Goal Lens, flashcards, quizzes, word explanation
src/lib/dictionary.ts         offline WordNet 3.1 + CMU dict → IPA
src/lib/srs.ts                SM-2 scheduler
src/lib/tts.ts                client playback engine (browser speech / Piper), sentence+word sync
src/components/…              Library, reader (TextPage, PdfPage, Panels), Views
tests/                        unit + API integration tests
```

Design decisions
- **node:sqlite instead of Postgres/pgvector**: zero native builds, one file to back up. Vectors are Float32 blobs searched by brute-force cosine (fine to ~100k chunks); FTS5 gives BM25. Postgres/Prisma is *not* used.
- **Single page model**: every format becomes numbered pages (real pages for PDF, ~1,800-char virtual pages for reflowable formats). This is what makes citations, summaries, audio, progress and Goal Lens uniform.
- **PDF.js** renders PDFs client-side from `public/pdfjs` (copied from `pdfjs-dist@4.10.38`; refresh with `npm run vendor:pdfjs` after upgrading). **EPUB.js is not used**; EPUBs are parsed server-side with JSZip.
- **UI** is Tailwind v4 + Zustand with hand-written components (not shadcn/ui).
- Auth is not implemented (single local user). See README.

## Status

### Completed and verified (this machine: Windows, Node 24, Ollama + llama3.1:8b + nomic-embed-text)
- Upload (drag/drop, bulk, validation) → background extraction → library; EPUB, PDF, Markdown, long Markdown tested.
- PDF reader (canvas + text layer), EPUB/text reader, page nav, TOC, search, bookmarks, 5-colour highlights, notes, themes, typography, progress restored after reload.
- Offline dictionary + IPA, AI in-context meaning, save word, SRS.
- Page summaries (cached), map-reduce for 24 pages, grounded streamed chat with hybrid retrieval and citations.
- Browser TTS with word/sentence highlight and auto-advance (verified with real system voices).
- Scanned-PDF OCR: scanned PDF accepted, OCR button → pages recognised offline in-browser → re-indexed → searchable (verified on a 2-page image-only PDF).
- Goal Lens extract + save, knowledge library, graph, flashcard/quiz generation, review UI, stats, export, backup.
- `tsc` clean, `next build` clean, 18 automated tests pass (dev and production server).

### Implemented but not verified here
- MOBI/AZW/AZW3 (Calibre), DOC/PPT/ODT/RTF (LibreOffice), server-side image-upload OCR (tesseract.js; still uses its default CDN assets, unlike PDF OCR), FB2, XLSX/CSV, DOCX — code paths exist; no fixtures run except where noted above.
- Piper TTS bridge (`/api/tts`), Docker image/compose (not built in this session).
- Mobile/tablet layouts (panels become overlays below `lg`/`md`) — not manually tested on devices.

### Known limitations / issues
- No user authentication or multi-user separation beyond schema scoping.
- CBZ/CBR, continuous-scroll mode (paginated only), epub.js, inline images in reflowable formats: not implemented.
- PDF highlights and spoken-sentence overlay are matched by text-layer span content (approximate; very short repeated spans can over-highlight). Offsets are exact for reflowable formats.
- British/Australian *IPA* is not generated (CMU data is American); accent audio depends on installed OS voices.
- Small local models sometimes return malformed JSON (Goal Lens/flashcards/quiz); the app retries once, then shows an error.
- Etymology is AI-generated and labelled unverified; no offline etymology source is bundled.
- Cross-book "connections" are currently co-occurrence/shared-concept based, not embedding similarity.
- Backup is a zip download held in memory — very large libraries should copy `data/` directly.

## Personal-intelligence expansion (v2)

**Preservation approach.** Inventory before changes: 66 routes, 30 tables, 18 passing tests, all reader/library/AI/audio features working. All v2 work is additive: migrations 2–3 only `ALTER TABLE … ADD COLUMN`/create tables (existing notes keep working as `kind='note'`), new endpoints live in `routes2.ts`–`routes4.ts` registered alongside the originals, and the original 18 tests still pass unchanged (now 34 tests total).

Source layout additions: `capture.ts` (selection → note), `vocabdisc.ts` (discovery), `library.ts` (cross-book hybrid retrieval), `routes2` (capture, vocab discovery, inbox, export/import), `routes3` (reading modes, mastery, teach-back, goal gaps, reports), `routes4` (library Q&A, universal search, drafts), `components/Intel.tsx` (Inbox, Ask library, Write, learning UI, command palette), `components/reader/Companion.tsx` (discovery panel, suggestions, mode analysis).

### Feature checklist (✔ built and tested here, ◐ built, partly verified, ✖ not built)
| # | Feature | Status |
|---|---|---|
| 1 | Auto-capture of sentence/passage selections to Notes with book, author, chapter, section, page, offsets, timestamp, context, return-to-source; dedupe; unobtrusive toast with Undo; selection preserved; capture modes (sentences / all / highlight-only); word selection → vocabulary first | ✔ tested on EPUB and PDF in the browser + API tests |
| 2 | Vocabulary discovery: per-page analysis (10k-word frequency list + WordNet), subtle dotted underline (text view), Word-tab panel, save selected/all, +flashcards, "I know this", listen, word family, difficulty, idioms/terms (AI, verified against page text) | ✔ (underlines for reflowable text/Text view; not drawn on the PDF canvas) |
| 3 | Knowledge Inbox: notes, passages, highlights, vocabulary, concepts/lessons in one view; search, type/tag/collection/sort filters, edit, delete, bulk actions, link notes, convert → note/flashcard/concept/question/objective/action, export, import | ✔ API + render tested |
| 4 | Context-aware companion: knows book/chapter/page/selection/prev+next page/notes/vocab/goals; ≤4 contextual suggestion chips derived from the page; "Test my understanding"; AI length + custom instructions | ✔ |
| 5 | Reading modes (Learning, Deep, Critical, Exam, Research, Goal, Language): per-page analysis, document untouched | ◐ endpoint + UI built; model output quality not evaluated across modes |
| 6 | Cross-book Q&A ("Ask your library"): hybrid retrieval over all books + notes, modes answer / what I learned / compare / contradictions / teach, citations to real passages, evidence kept apart from interpretation, confidence + limitations | ✔ verified with 3 books |
| 7 | Goal Lens 2.0: choose extraction types (19 kinds), knowledge-gap analysis, learning path, "read next" from real retrieval over your library, exercises | ◐ gap analysis built; AI output not yet reviewed over many goals |
| 8 | Active learning: concept quizzes, Teach It Back, concept mastery score driven only by tested interactions, spaced repetition, report of what was done | ✔ mastery logic tested; teach-back/quiz need a model |
| 9 | Writing workspace: drafts, insert real quotes with book/page, AI assist grounded in library | ◐ built, API tested, UI render-checked |
| 10 | Analytics: weekly/monthly report (reading time, speed, captured, vocabulary recall, concepts tested, goals advanced) | ✔ |
| 11 | Export JSON/CSV/Markdown/HTML (PDF via browser print of HTML), import Folio JSON or Markdown | ✔ |
| 12 | Command palette (Ctrl/Cmd+K), universal search | ✔ |
| — | Contradiction/consensus detection | ◐ via Ask-library mode, model-based, not a stored structure |
| — | Knowledge timelines; custom dictionaries; pronunciation testing with speech recognition; reading-theme editor beyond light/sepia/dark; multi-language UI; automatic scheduled backups; batch bulk-tagging of vocabulary; research workspaces with saved book sets | ✖ not built |

Bugs found and fixed during v2: `notes_fts` lacked an UPDATE trigger (editing a note then deleting it corrupted the FTS index → "database disk image is malformed"); migration 3 rebuilds it and adds the trigger. Models sometimes return objects where strings were requested (crashed the Word panel with React error #31) — AI word explanations are now flattened server-side. The library Q&A prompt initially made the 8B model echo its sources; prompt tightened and prompt fences stripped in the UI.

Heuristic honesty: vocabulary difficulty is a word-rarity proxy (rank in a 10k frequency list; words outside it that exist in WordNet are "advanced"). It will flag some ordinary-but-uncommon words and miss unusual meanings of common words. Concept "coverage" in gap analysis reflects what the user saved, not what they know; mastery changes only from quiz answers and Teach-it-back, which are themselves judged by a local model.

## Active Recall & Long-Term Memory Engine (v4)

Code: `src/lib/recall/{fsrs,engine,ui-lib,ui-rules}.ts(x)`, `src/lib/routes7.ts`, `src/components/Recall.tsx`; tables from migration 6 (`recall_questions`, `recall_state`, `recall_sessions`, `recall_attempts`, `blurts`, `exams`, `mind_maps`). Existing flashcards/vocabulary keep their own SM-2 scheduler; nothing was duplicated or migrated.

| Capability | Status |
|---|---|
| Question generation per page / section / chapter (15+ types, 6 cognitive levels) with a **quality checker** (grounded in the source, no "this page" references, duplicate detection, MCQ validity, numeric answers verified by calculation, quotes verified verbatim, one top-up pass) | ✔ tested with a real model |
| Close-book session: the reader is **unmounted** (page text absent from the DOM), question only, written (or push-to-talk) answer, confidence, "I don't know"; answers/key points/source are withheld until after the attempt | ✔ tested in the browser |
| Evaluation: deterministic for MCQ and numeric; otherwise key points graded **by number** by the local model, then overruled by a lexical-evidence guard so long generic answers cannot score; accuracy/completeness/understanding/application kept separate; any answer language, feedback in a chosen language | ✔ (a long irrelevant answer scores < 0.5; junk ≈ 0; Telugu accepted) |
| FSRS-4.5 scheduler (stability, difficulty, retrievability, lapses, Again/Hard/Good/Easy + confidence; self-rating overrides the automatic rating; applied exactly once) | ✔ 8 unit tests |
| Triggers while reading: off / every page / 2 / 3 / 5 pages / chapter end / difficult pages / when leaving the book / manual; Later and Skip; **skipped sessions tracked separately** | ✔ (every-page trigger verified in the browser) |
| Mastery per concept in four separate dimensions (recognition, recall, understanding, application), retention estimate, calibration (over/under-confidence), status; gaps: weak, forgotten, untested-but-read, prerequisite candidates; targeted sessions | ✔ |
| Daily recall: due items first (lowest retrievability), new questions only from pages you have read, interleaved across concepts/books, capped to the chosen minutes, overflow postponed not lost | ✔ |
| Blurt (coverage map, wrong statements penalised, word count earns nothing), exams (chapter/range/book, format, timer, marked per question, spread across pages), cross-book questions with citations to both books | ✔ |
| Analytics from real attempts only (by skill, daily, weekly retention on repeat reviews, weakest chapters, completed vs skipped) | ✔ |
| **OpenUI** (`@openuidev/react-lang` + `lang-core`, MIT): the local model composes feedback and study-briefing panels from our component library (Callout, KeyPoints, Steps, Formula, Quote, Mnemonic, Compare); few-shot examples + OpenUI's own parser on the server + verbatim check of quotes/formulas + retries; falls back to the native view if invalid | ✔ (gemma3:4b succeeds first time with the examples; without them it emitted invalid syntax and an invented formula) |
| Socratic recall (`/recall/socratic`, ≤6 replies, tutor never states key ideas — leak check + evidence guard; finished dialogue saves an FSRS-linked attempt) | ✔ API tested with gemma3:4b; UI built, not clicked through in a browser |
| Blind mind map (`/recall/mindmap`; reference map extracted from ≤6 pages, each branch judged separately, links checked against the text; stored in `mind_maps`) | ✔ API tested (good map > unrelated map, 3 consecutive runs); UI built, not clicked through. Judgement quality depends on the local model — a 4B model is coarse |
| Recall while listening (`/recall/listen`; "Pause every N sentences to test me" in the Audio tab; predict-next or explain-what-you-heard, graded by meaning) | ✔ API tested; the pause/resume hook in `tts.ts` and the Audio-tab card are built but not exercised against real speech. Uses the existing audio reader, not the unfinished podcast engine. Checks are stored as retired questions: they count in analytics, never in the daily queue or mastery |
| Exam-date planner (`/recall/plan`; deterministic from date, minutes/day, chapters, question counts, mastery; feasibility warning; stored per book) | ✔ tested. Time estimates are heuristics (≈2.2 min/question, fewer once tested), not measured. "Start today's plan" button is not built — start sessions from the Practice tab |
| Spaced revision of Goal-Lens extracts | ✖ not built |

Honest limits: evaluation by a 4B local model is good for gist and key-point coverage but can misjudge subtle answers — the learner can always override the rating, and numeric/MCQ checks are deterministic. Voice answers use the browser's SpeechRecognition (cloud-backed in Chrome/Edge); no local recogniser is installed. Mastery/analytics describe answers given, not intelligence or permanent memory.

Bugs found while testing this engine and fixed: translation cache served stale entries after the glossary change (cache key is now versioned); formula placeholders `⟦n⟧` were mangled by models (now `[[Xn]]`); recall generation was flaky when the quality filter rejected most questions (second top-up pass); a long irrelevant answer scored 100 % (lexical evidence guard).

## Commands

```bash
npm install
npm run setup          # prerequisite check
npm run dev            # http://localhost:3100
npm run typecheck
npm test               # needs server running for API tests
npm run build && npm start
docker compose up -d --build
npm run vendor:pdfjs   # re-copy pdf.js into public/
```

## Required local dependencies
Node ≥ 22.5. Optional: Ollama (+ a chat model + `nomic-embed-text`), Calibre, LibreOffice, Piper.

## Next steps
1. Extra OCR languages; selectable text layer for OCR'd pages.
2. Continuous-scroll mode and per-chapter lazy loading for very large books.
3. Login + per-user data dirs if exposing beyond localhost.
4. Embedding-based cross-book concept linking; reranker pass.
5. CBZ/CBR import via image extraction + OCR.
6. Playwright end-to-end suite for the reader UI.
