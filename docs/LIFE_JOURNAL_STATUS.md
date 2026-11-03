# Life Journal — implementation checklist and honest status

Code: `src/lib/journal/{store,ai}.ts`, `src/lib/routes9.ts`, `src/components/Journal.tsx`, `scripts/transcribe.py`, migration 8 (`j_*` tables, additive). Tests: `tests/journal.test.ts` (10 tests; 9 pass, 1 skipped when the tools exist).
Everything runs locally: MediaRecorder in the browser → Folio's own server → ffmpeg → openai-whisper (Python) → Ollama. No paid or remote service, nothing uploaded.

## What was verified, and how
| Acceptance item (spec §22) | Status | Evidence |
|---|---|---|
| 1 camera/mic permission | partly | Permission-denied / no-device / busy-device messages are implemented. **Not tested against a real camera or permission prompt** — the built-in browser pane has no devices, so the recorder was driven with a synthetic canvas+oscillator stream. |
| 2–5 record, save, pause/resume, original accessible | **verified in a real browser** | Real `MediaRecorder` → 4 s chunks → server; pause froze the timer; stop saved a 12 s, 0.3 MB seekable WebM that plays and seeks (duration 12.038 s). Original download endpoint returns the stored file. |
| 6 audio extraction | verified | ffmpeg remux (fixes duration/seeking) + 16 kHz mono WAV + thumbnail; duration measured from audio. |
| 7–8 transcript + timestamps | verified | Real synthesised speech → Whisper `base`: transcript contained "manager, project, exercising, Chicago"; segments ordered with start/end ms. Click-to-seek UI built (observed in code path; transcript click not exercised in the browser). |
| 9–10 grounded notes, diary keeps meaning | verified (small model) | Every note must cite real segment numbers and pass a lexical support check or it is discarded (count shown); quotes are copied verbatim from the transcript (asserted equal). Diary is generated per ≤4.5k-char window; numbers/names absent from the transcript are listed as "worth checking". Quality depends on the local model (gemma3:4b here) and was only checked structurally, not for literary quality. |
| 11–12 edit diary, transcript unchanged | verified | Corrections go to a separate column; verbatim text asserted unchanged after correction and after diary edit. |
| 13 report links to statements | verified | Each item cites segments and shows a quoted excerpt; unsupported items dropped; clinical labels asserted absent. Disclaimer shown. |
| 14–15 follow-up conversation, saved independently | verified (API) | Ten conversation modes; reply received; message save; deleting the conversation leaves the entry. UI built, not exercised in a browser. |
| 16–17 several entries per date, calendar opens correct entry | verified | API + browser: month grid, thumbnail on the video day, day list opens the entry. |
| 18–19 search → transcript passage → media timestamp | verified (API) | Result carries `recordingId` + `atMs`. Keyword search only. "No hit → nothing shown" asserted. |
| 20 knowledge graph | partial | "Save to my vault" writes the entry as a normal note (frontmatter, `[mm:ss]` transcript lines) — it then appears in vault search, tags, graph and Bases. Not asserted in the graph itself; no automatic concept/book linking. |
| 21 export | verified | Markdown export (frontmatter + diary + timestamped transcript + cited notes) and raw media download. |
| 22 works without AI | verified | With AI disabled: write, record, calendar, search work; AI endpoints answer 403 with a clear message. |
| 23 survives interrupted processing | verified | Failed/garbage-audio job: no transcript invented, error recorded, original still served; jobs interrupted by a restart are marked failed with Retry. Interrupted recordings (closed tab) are kept and marked `interrupted`. |
| 24 permanent deletion | verified | Media, transcript, each diary version and conversation can be deleted separately; "delete everything" removes files + rows + search hits. |
| 25 existing features | verified | Full suite 114 passed / 0 failed / 1 skipped; all 13 existing views render with no console errors. |
| Safety | verified | Crisis language (self-harm phrases) gets a fixed, deterministic compassionate reply with emergency/988/findahelpline information, *before and independent of* the language model and even with AI disabled. |

## Built
Phase 1 (home, written journal with mood/tags/prompts, daily entries, storage, calendar), Phase 2 (video/voice recording with modes, pause/resume, device + quality selection, level meter, optional on-screen prompt, chunked crash-safe upload with retry/backoff, interrupted-recording recovery, library, audio extraction), Phase 3 (transcription, notes, diary styles + versions + compare tabs, important quotes/moments/decisions/actions/questions/people/topics), Phase 4 (single-entry reflection report, reflection conversation, thinking-pattern observations as tentative text), parts of Phase 6 (month calendar, video/voice libraries, search) and Phase 7 (Markdown export, note in vault).

## Phase 5 — life intelligence (added)
Code: `journal/life.ts`, `journal/cluster.ts` (pure), routes in `routes9.ts`, UI `JournalLife.tsx`; migration 9 (`j_people, j_goals, j_goal_updates, j_milestones, j_reports, j_dismissed`, `j_entries.sensitive`). Tests: `tests/journal-life.test.ts` (11).
| Capability | Status | How it stays honest |
|---|---|---|
| Recurring themes / concerns / things you keep planning / achievements across entries | **verified** | Groups similar wording from *different* entries (stemmed-word overlap — not semantic understanding, so paraphrases can be missed and unrelated items sharing two words can merge). Every theme shows first/last date, entry count and the speaker's own sentence per piece of evidence. Labelled `single entry` / `two entries` / `recurring (3+)`. Two statements within one entry never count as a pattern. |
| Opt-in | verified | Insights and reports return 403 until "Analyse patterns across my entries" is enabled (off by default). |
| "Keep out of memories & insights" | verified | Sensitive entries are excluded from insights, reports, suggestions, memories and the timeline immediately (tested), and counted but not shown. |
| Weekly / monthly / quarterly / annual / custom reports | **verified** (deterministic part) | Counts, user-selected moods, themes, goals with updates in period, milestones, people mentioned, reflection questions. Saved and deletable. |
| AI written summary of a period | verified structurally | Optional; every statement must cite numbered items (dated entries) and pass a word-overlap check or it is discarded; basis label shown. "What seems to have shifted" is only as good as the small local model — read it critically. Not claimed to detect changing self-perception. |
| People | verified | Created only by you (suggestions come from names in your own notes and can be dismissed). Profile = your own notes + plain name matching in *your* transcripts/writing with timestamps. No inference about third parties. Removing a person never touches entries. |
| Goals | verified | Suggested from "I want to / need to / should…" statements in your notes; created only when you accept; deadline, status, progress/obstacle/milestone/reflection updates, link to the entry+timestamp where you first said it. Not synced with the app's older Goals screen. |
| Milestones, memories, timeline | verified | Add manually, from notes, or from an entry. "This day last year / N years ago / a week ago / a month ago / this week last year", milestones on this date. Respects the resurfacing setting; never shows sensitive entries or emotional-reflection recordings. |
| Weekly reflection questions | built | Fixed four questions (progress / difficult / learned / change). |

Also fixed: Indic-script words were being split at combining marks in two similarity helpers (Telugu/Tamil/etc. words became empty tokens); now tokenised correctly and unit-tested on Telugu.
Test runner now executes files serially (`--test-concurrency=1`) because journal tests share global settings.

## Multilingual layer (added)
Code: `journal/langtest.ts` (pure), translation/language-check in `journal/ai.ts`, `/journal/languages`, `/journal/language-test`, migration 10 (`j_seg_trans`, `j_langtests`). Tests: `tests/journal-lang.test.ts` (10).
| Capability | Status | Honest notes |
|---|---|---|
| Spoken language selection (auto, en, te, ta, hi, kn, ml) per run or default | built | Passed straight to Whisper. Auto-detect uses only the first ~30 s. |
| **Measured** recognition accuracy per language | **verified mechanism** | Instead of promising support, Folio asks you to read a reference sentence (editable) aloud, transcribes it with the chosen model and stores character/word error rates (grapheme-based, Unicode-aware) per language+model; every language shows "not tested" until measured. Bands (good ≤15 %, fair ≤35 %, else poor) are coarse and based on one sentence. **I could not measure Telugu/Tamil/Hindi/Kannada/Malayalam accuracy myself: this machine has only English voices and I have no native recordings.** English audio read as Telugu was correctly scored "poor" (100 % errors), and clean synthetic English as good/fair. The Indic reference sentences were written by me — have a native speaker confirm them. |
| Code-switching | partial | Each transcript segment shows its own detected language chip, so mixed speech is visible and preserved. Whisper still transcribes a recording as *one* language, so heavily mixed speech may come out wrong; Latin-script Hinglish/Tanglish is detected as English. |
| Translated transcript | **verified** (English→Hindi tested end-to-end) | Machine translation through Folio's existing translation engine, stored as a separate layer (same timestamps, marked "machine", warnings shown). Original never changes. Switch Original / Translated / Both. Translations are searchable (result links to the media time) and deletable. Quality for low-resource languages depends on the installed model (gemma3:4b here is flagged "broad, weaker"); I checked script and alignment, **not translation quality**. |
| Translate a diary | verified | Stored as its own document; original untouched. |
| AI notes/diary/report/conversation in a preferred language | verified (Telugu script) | Setting "Write AI notes, diaries and reflections in…". Diary and conversation came out in Telugu script in tests; quality of the Telugu itself is not assessed. "Preserve my exact words" never translates. When the output language differs from the speaker's, notes can't be word-checked against the transcript and are labelled unchecked; the "details not in the transcript" check then covers numbers only. |
| Written journal in any language | works | Free text; not language-specific. |
| Search in other languages | partial | Matches the language you type, across the original and translated layers. No cross-language (Telugu query → English entry) search for the journal. |

Also: notes extraction now numbers *sentences* (Whisper often returns one long segment) and maps citations back to the transcript segment; thin answers trigger a retry and small focused follow-up questions. This fixed a ~30–50 % failure rate of the pipeline test on this small model. The journal UI strings themselves are still English only.

## NOT built (do not assume these work)
- **Phase 5 gaps:** semantic (meaning-based) clustering, trend/"changing self-perception" analysis beyond the optional cited summary, thinking-pattern tracking across time (e.g. recurring avoidance), habit tracking, automatic goal/person linking, reminders, relationship timelines. The single-entry reflection report still says "based on this one entry".
- **Calendar:** week/year/custom-range grids, content-type filter, future scheduled reflections (future-self messages are recorded but not scheduled). A chronological timeline now exists under Memories.
- **Multilingual gaps:** Indic-language recognition accuracy is unmeasured by me (see above), mixed-language speech is one-language transcription, translation quality is unreviewed, journal UI labels are English, no cross-language journal search. Transcribing a tone/no-speech recording produces no transcript rather than invented text.
- **Privacy:** no at-rest encryption (use disk encryption), no PIN/section locking, no separate user separation inside the app, no sharing (none by default is intentional).
- **Written journal:** no rich-text editor (Markdown text only), no photo/drawing attachments, no locations, no templates.
- **Recording:** background recording, camera switching on phones, and mobile-specific testing were **not tested**; teleprompter is a simple overlay. Very large (hour-long) recordings were not tested; memory use during upload is bounded by unacknowledged chunks only. Low-storage protection exists (stops at <200 MB free) but is untested.
- **Integration:** no automatic links to books/notes/goals/active recall; no Canvas integration; AI assistant context across the whole journal not provided.
- **Reports longer than ~14 000 transcript characters are refused** with an explanation (notes and diary handle any length by windowing).
- Hardware: transcription runs on CPU here; the `base` model took ~10–15 s for a 20 s clip. Longer recordings scale roughly linearly; there is a timeout of max(10 min, 4× duration).
