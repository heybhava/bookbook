# Test plan

Run: `npm test` (parser tests need no server). API suites: build + `next start -p <port>`, then `BASE_URL=http://localhost:<port> npm test`.

## Directive workflow tests — status

| Test | What it asserts | Status |
|---|---|---|
| A Vault | create vault/note, file on disk equals content, listed again, create doesn't overwrite | **automated, passing** (server re-read; a true process restart is not automated — all state is on disk/SQLite) |
| B Filesystem | external edit/create/delete picked up; stale editor save refused with disk copy returned | **automated, passing** |
| C Markdown | rendering of headings/lists/tables/callouts/footnotes/embeds in Reading View; **Source ↔ Live Preview switching not testable (no Live Preview)** | partial |
| D Links | outgoing/backlinks, unresolved→resolved, rename keeps relationships and rewrites wikilink/alias/anchor/embed/md links | **passing** |
| E Properties | edit keeps unknown YAML; appears in props list and `[prop:value]` search; invalid YAML rejected | **passing** (Bases part: not built) |
| F Bases | table with formulas/sort/filter/group/limit/summaries; inline edit; kanban group + move rewrites the note; prefilled new record; cards/list views; base file round-trip; CSV; embeds; books/highlights sources | **passing** (API); Cards/Kanban drag verified in the browser by script, not by a real pointer |
| G Graph | real edges, tag filter, local depth, node = real file | **passing** (data); click-to-open verified manually in browser |
| H Canvas | — | not built |
| I/J Book highlight / note→book | — | existing highlight persistence tested in earlier suites; vault↔highlight linking not built |
| K Search | operators, regex, phrase, OR, exclusion, fuzzy switcher; across notes only (not yet highlights) | **passing** (notes) |
| L Workspace | — | not built |
| M Import | Obsidian-layout folder opened in place; tags/links/attachments indexed; foreign config untouched; forgetting never deletes | **passing** |
| N History | versions recorded, restore reversible, soft delete | **passing** |
| O Offline | everything is local; no test blocks the network | by design, not automated |
| P Security | XSS payloads escaped, `javascript:` links dropped, traversal/absolute/reserved/NUL names rejected, raw files sandboxed | **passing** |
| Q Sync | — | not built |
| R Regression | existing 75 tests | run each milestone |

## Performance workloads
Targets: 10 000 notes / 100 000 links / 1 000 books / large PDFs / large canvases. **Only one smaller run has been done** (2 000 synthetic notes × 10 links = 20 000 links, one machine, production build, local API calls, single run — indicative only):

| Operation | Measured |
|---|---|
| Initial full index | 7.6 s |
| Warm tree + change scan (no changes) | 80 ms |
| Search two plain words (2 000 hits) | 149 ms |
| Search `[status:done] tag:#t3` | 83 ms |
| Backlinks incl. unlinked-mention scan | 147 ms |
| Quick switcher | 63 ms |
| Global graph payload (2 000 nodes, ~20 000 edges) | 118 ms (rendering 20 000 edges in the SVG graph was **not** measured and will be slow) |
| Save one note (re-index 1 file) | 27 ms |
| Rename with link rewriting | 5.8 s *before* removing a redundant full re-index; the fix passes the tests but was **not re-measured** |

Not measured: 10 000-note / 100 000-link scale, editor input latency, graph layout time, memory, concurrent index updates, books/PDF workloads.
