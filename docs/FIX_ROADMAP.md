# Fix roadmap — PROPOSED, awaiting your approval (no code has been changed)

Priorities: P0 critical (security / data loss) · P1 essential (core promise blocked) · P2 important (integrations, major missing features) · P3 improvements · P4 future.
Complexity: S ≤ 1 day · M 2–4 days · L 1–2 weeks · XL > 2 weeks (rough, single developer).
Evidence references point to `docs/AUDIT_REPORT.md`.

## Order of work
1. **Phase 0 (P0, first, small):** SEC-01, SEC-02, SEC-03, DATA-02 — protect the data and the network surface. Nothing else should ship before these.
2. **Phase 1 (P1):** DATA-01, REL-01, REL-02, then the **foundation for everything missing**: JOB-01 (scheduler/job runner) and NET-01 (outbound research client) — Goal OS, news, accountability all depend on them.
3. **Phase 2 (P2):** Goal OS cluster (GOAL-01 → GOAL-02 → RES-01 → LP-01 → PLAN-01 → NEWS-01 → ACC-01 → ANA-01), media generation (MEDIA-01…03), integrations (INT-*).
4. **Phase 3 (P3):** UX/mobile/a11y/performance/CI.
5. **Phase 4 (P4):** encryption at rest, multi-user, native shells, advanced models.

## P0 — critical
| ID | Feature | Exact problem | Evidence | Root cause | Proposed fix | Depends | Cx | Acceptance criteria |
|---|---|---|---|---|---|---|---|---|
| SEC-01 | Network exposure | Server answers on the LAN address with no authentication; private journal/books/notes readable by anyone on the network | LAN-address request → HTTP 200 on `/api/journal/entries`, `/api/books`, `/api/notes` | `next start/dev` binds all interfaces; no auth layer | Bind `127.0.0.1` by default in scripts, Dockerfile and docs; add an optional local passcode/token (cookie) that is required when `FOLIO_HOST` ≠ loopback; document LAN use as opt-in | – | S–M | request via LAN IP refused (connection refused or 401); loopback works; test covers both; README updated |
| SEC-02 | Host / DNS-rebinding / CSRF | `GET` with arbitrary `Host` returns data; non-GET without `Origin` accepted | `Host: evil.example` → 200; POST w/o Origin → processed | guard checks only non-GET with an Origin header | Allow-list `Host` (localhost, 127.0.0.1, [::1], configured names); require `Origin` or `Sec-Fetch-Site: same-origin` for state-changing methods; reject others | SEC-01 | S | tests: spoofed Host → 403; POST without Origin and without same-origin header → 403; normal UI still works |
| SEC-03 | Source & data safety | Project is untracked; git root is the home directory; no history | `git ls-files .` = 0 | folder never initialised as its own repo | Initialise a dedicated repo with `.gitignore` (`data/`, `.next*`, `node_modules`); first commit; add a documented, tested `GET /backup` restore path; optional scheduled local backup of `data/` | – | S | `git log` shows history; fresh clone builds; backup → restore on an empty data dir reproduces books, notes, journal (test) |
| DATA-02 | Test isolation | Test suite runs against the real DB and leaves residue | 8 `j_dismissed`, 2 test vaults registered, leftover bench folder, 1 langtest | tests use `./data` | Run tests with `BOOKREADER_DATA_DIR=<temp>` (test runner spawns its own server); add global cleanup | – | M | running the suite leaves the real data dir byte-identical (checked by test); suite passes against the temp server |

## P1 — essential
| ID | Feature | Exact problem | Evidence | Root cause | Fix | Depends | Cx | Acceptance |
|---|---|---|---|---|---|---|---|---|
| DATA-01 | Vault index integrity | Index tables keep rows for forgotten vaults | 20,167/20,168 `vlinks` orphaned, similar for 6 tables | no FK/cascade on `v*` tables; `forgetVault` deletes only `vaults` | additive migration: delete orphans, add triggers or explicit deletes; `forgetVault` removes all index rows | – | S | after forget, all `v*` counts for that vault are 0 (test); migration removes the existing orphans |
| REL-01 | Recall generation reliability | 1 question instead of ≥2 on small models | failed ≥4 full runs earlier; passes on rerun | single-shot JSON from a 4B model; top-up only once | sentence-level prompting + focused follow-ups (as done for journal notes), minimum-count retry | – | M | 20 consecutive generation runs on the fixture page yield ≥2 questions |
| REL-02 | Journal notes reliability | Sparse notes on a small model (fixed to 0/6 failures, not guaranteed) | earlier 30–50 % pipeline failures | model collapse on long single segments | keep sentence units; add a regression test over 3 fixtures | – | S | stress run ≥ 20 pipeline passes without a failure |
| JOB-01 | Scheduler / background jobs | No scheduler; only an in-process queue | grep: no cron/interval jobs | never built | persisted job table with schedule (cron/interval + IANA time zone), run history, retry with backoff, missed-run catch-up on startup, cancel/pause; one runner process | DATA-02 | L | a job scheduled for +1 min runs once, history row written; killed mid-run job resumes/marks failed; DST/time-zone test; survives restart |
| NET-01 | Outbound research client | No network code at all | zero non-local `fetch` | never built | module with allow-list, robots.txt respect, per-host rate limits, timeouts, size caps, content-type checks, URL validation (HEAD/GET status), canonicalisation + de-dup, source attribution + retrieval date; free providers only (OpenAlex, Crossref, arXiv, Open Library, Wikipedia, RSS, optional SearXNG); everything off by default with a visible privacy toggle | SEC-01, JOB-01 | L | fixtures + recorded responses (CI) and a live smoke test; invalid URL excluded; duplicates merged; nothing fetched while disabled |

## P2 — important (missing major features and integrations)
| ID | Feature | Problem | Proposed fix | Depends | Cx | Acceptance |
|---|---|---|---|---|---|---|
| GOAL-01 | Unified goal model | `goals` (learning) and `j_goals` (journal) are separate; no Goal OS | one `goals` model with areas/priority/deadline/status, linking to concepts, books, notes, journal entries; migrate both tables | – | M | both screens read/write the same rows; migration preserves data (test); no duplicates |
| GOAL-02 | Decomposition / roadmap | gap analysis returns empty path/exercises/actions; no milestones/tasks | LLM + deterministic validator that produces milestones → weekly tasks → daily actions with estimates; stored; editable; regenerate keeps history | GOAL-01 | L | 10 sample goals each yield ≥3 milestones with tasks; output schema-validated; unit tests for validator |
| RES-01 | Resource discovery & ranking | none | uses NET-01; returns real URLs with title/author/date/source, ranked by relevance + quality heuristics (publication, recency, citations from OpenAlex), de-duplicated; user can accept/reject | NET-01, GOAL-02 | L | every item has a 200-OK URL checked at retrieval time; duplicates collapsed; ranking explained |
| LP-01 | Learning paths | untested/empty | path = ordered resources/readings/exercises from RES-01 + library; progress persisted | RES-01 | M | path renders, progress survives reload (browser test) |
| PLAN-01 | Daily plan | study-only | planner merging due recall, goal tasks, journal prompt, time budget | GOAL-02 | M | plan respects budget; regenerating is idempotent |
| NEWS-01 | Daily briefing | none | scheduled collection from feeds/search for goal keywords, de-dup (URL + title similarity), summarise with citations, store briefings | JOB-01, NET-01 | L | job runs on schedule, briefing links open, repeated items suppressed (test), failures logged |
| ACC-01 | Accountability check-ins | no notifications | web-app notifications/PWA manifest + service worker, in-app check-in flow, streak-free tone, snooze/quiet hours | JOB-01 | M–L | check-in appears at the scheduled time (fake clock test) and answers update progress |
| ANA-01 | Goal progress analytics | none | progress derived from completed tasks, reviews, journal updates; charts-free summaries first | GOAL-02 | M | numbers reproduce from raw rows (test) |
| OUI-01 | OpenUI beyond recall | OpenUI only in recall | schema-validated dynamic panels for plan/briefing/goal dashboards using real data; persisted state | PLAN-01 | M | invalid output falls back; no arbitrary code; renders on 375 px |
| MEDIA-01 | Podcast generation | not implemented | script writer (grounded in pages) → TTS (SAPI/Piper) → ffmpeg mix → asset with transcript + player (speed, sync) | route+UI for assets | L | generates a playable file from a fixture chapter; transcript timestamps match audio ±1 s (test); pause/resume/speed verified |
| MEDIA-02 | Video generation | not implemented | slides/scenes + narration → ffmpeg; progress/cancel via task system | MEDIA-01 | XL | playable mp4 with narration and captions |
| MEDIA-03 | Interactive 2D/3D | unreachable code | add routes (`/books/:id/visual`), a renderer using `three` or SVG for validated scenes, UI entry in reader | – | L | open a page → generate → interact; invalid scene rejected; test |
| INT-01 | Journal ↔ books/notes/recall | no links | topic/quote → note, concept, recall question; grounded suggestions requiring approval | GOAL-01 | M | suggestion shows the exact passage; nothing linked without approval |
| INT-02 | Highlights ↔ vault (`folio://`) | none | stable highlight ids, URI scheme, citation in notes, click opens book at location | – | M | note link opens book at the exact page/offset after restart |
| INT-03 | Cross-book concept links | only `co-occurs` | embedding + LLM-verified relations with evidence quotes | – | L | relation shows both source passages |

## P3 — improvements
| ID | Item | Evidence | Fix | Cx | Acceptance |
|---|---|---|---|---|---|
| UX-01 | Vault/Bases mobile layout | 119 px editor at 375 px; right panel hidden | responsive drawers/tabs for explorer and side panels | M | all panels reachable at 375 px (browser test) |
| UX-02 | PWA/offline shell | no manifest/service worker | manifest + SW for shell caching | S–M | installable; shell loads offline |
| UX-03 | Journal i18n | labels English only | extend catalog for te/ta/hi/kn/ml | M | language switch changes all journal labels |
| A11Y-01 | Accessibility audit | none done | axe pass, keyboard paths, focus order | M | no serious axe violations on main views |
| TEST-01 | Lint + CI + UI tests | no eslint, no CI, no e2e | ESLint, Playwright smoke for reading/recall/journal, CI workflow | M | CI green on clean checkout |
| TEST-02 | Cover the 45 unmentioned routes | list in checklist | add tests (backup, tts, quizzes, collections, tasks…) | M | each route has an asserting test |
| PERF-01 | Scale tests | only 2k notes | 10k notes/100k links/1k books benchmark, virtualised lists, graph LOD | L | documented timings; budgets met |
| SEC-04 | Dependencies | `xlsx` high, `next/postcss` moderate | replace xlsx parsing (e.g. `exceljs` or sandboxed worker), upgrade Next when compatible | M | `npm audit --omit=dev` shows no high issues |
| SEC-05 | Archive limits | no decompression cap | caps on entries/size/ratio for zip-based formats | S | zip-bomb fixture rejected |
| DEBT-01 | Cleanup | dup helpers, dead code, long lines, giant route list | consolidate helpers, delete or wire dead modules, formatter, split route registry | M | no unused modules; formatter in CI |

## P4 — future
Encryption at rest + journal lock/PIN (SEC-06, L) · real multi-user auth + `user_id` on all tables (SEC-07, XL) · native mobile shells with share sheet/widgets · EPUB CFI locators · Live Preview editor (CodeMirror 6) · Canvas · Sync/Publish · measured Indic ASR + dedicated translation server (NLLB/IndicTrans2) · cross-language journal search.

## Decisions I need from you before starting
1. Approve Phase 0 as-is (SEC-01/02/03, DATA-02)?
2. Goal OS data sources: OK to allow free public APIs (OpenAlex, Crossref, arXiv, Open Library, Wikipedia, RSS) behind an off-by-default privacy switch?
3. Is single-user, localhost-only the intended deployment, or do you want accounts?
4. Priority between the Goal OS cluster and media generation (podcast/video).
