// SQLite via Node's built-in node:sqlite (no native build step, FTS5 included).
// One SQLite database PER TENANT (<DATA_DIR>/users/<uuid>/app.db). db() resolves the connection from the current user context (see tenant.ts),
// so a query can only ever see the calling user's rows. Accounts/sessions live in a separate system database (auth/sysdb.ts).
import fs from 'node:fs';
import path from 'node:path';
import { me, tryMe, userDir, runAs, DATA_DIR, filesDir, coversDir, audioDir, assetDir, journalDir, vaultsDir, vaultHistoryDir, tmpDir } from './tenant';

export { me, tryMe, runAs, DATA_DIR, filesDir, coversDir, audioDir, assetDir, journalDir, vaultsDir, vaultHistoryDir, tmpDir };
type DB = import('node:sqlite').DatabaseSync;

const MIGRATIONS: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);

CREATE TABLE books (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, author TEXT, format TEXT NOT NULL, tags TEXT DEFAULT '',
  cover_path TEXT, page_count INTEGER DEFAULT 0, status TEXT NOT NULL DEFAULT 'queued',
  status_detail TEXT, language TEXT, created_at INTEGER NOT NULL, last_opened_at INTEGER
);
CREATE INDEX idx_books_user ON books(user_id, last_opened_at DESC);

-- Original binary lives on disk; the row only stores a path (originals are never modified).
CREATE TABLE documents (
  id TEXT PRIMARY KEY, book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL, original_name TEXT NOT NULL, mime TEXT, size INTEGER, sha256 TEXT
);
CREATE INDEX idx_documents_book ON documents(book_id);

CREATE TABLE chapters (
  id TEXT PRIMARY KEY, book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL, title TEXT NOT NULL, start_page INTEGER NOT NULL
);
CREATE INDEX idx_chapters_book ON chapters(book_id, idx);

-- One row per page. PDFs: real pages. Reflowable: virtual pages cut on paragraph boundaries.
CREATE TABLE pages (
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  page INTEGER NOT NULL, chapter_idx INTEGER, text TEXT NOT NULL, html TEXT,
  ocr INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (book_id, page)
);

CREATE TABLE chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  page_start INTEGER NOT NULL, page_end INTEGER NOT NULL, chapter_idx INTEGER,
  text TEXT NOT NULL, embedding BLOB, embed_model TEXT
);
CREATE INDEX idx_chunks_book ON chunks(book_id);
CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='id', tokenize='porter unicode61');
CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text); END;
CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text); END;

CREATE TABLE collections (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE book_collections (book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE, collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE, PRIMARY KEY (book_id, collection_id));

CREATE TABLE reading_progress (
  book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  page INTEGER NOT NULL DEFAULT 1, scroll REAL NOT NULL DEFAULT 0, percent REAL NOT NULL DEFAULT 0,
  audio_page INTEGER, audio_sentence INTEGER, updated_at INTEGER NOT NULL
);

CREATE TABLE bookmarks (id TEXT PRIMARY KEY, book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE, page INTEGER NOT NULL, label TEXT, created_at INTEGER NOT NULL);
CREATE INDEX idx_bookmarks_book ON bookmarks(book_id);

CREATE TABLE highlights (
  id TEXT PRIMARY KEY, book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  page INTEGER NOT NULL, text TEXT NOT NULL, color TEXT NOT NULL DEFAULT 'yellow',
  start_offset INTEGER, end_offset INTEGER, note TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX idx_highlights_book ON highlights(book_id, page);

CREATE TABLE notes (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id TEXT REFERENCES books(id) ON DELETE CASCADE, page INTEGER, title TEXT, body TEXT NOT NULL,
  tags TEXT DEFAULT '', source TEXT DEFAULT 'user', created_at INTEGER NOT NULL
);
CREATE INDEX idx_notes_book ON notes(book_id);
CREATE VIRTUAL TABLE notes_fts USING fts5(title, body, tags, content='notes', content_rowid='rowid');
CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN INSERT INTO notes_fts(rowid, title, body, tags) VALUES (new.rowid, new.title, new.body, new.tags); END;
CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN INSERT INTO notes_fts(notes_fts, rowid, title, body, tags) VALUES ('delete', old.rowid, old.title, old.body, old.tags); END;

CREATE TABLE vocabulary (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  word TEXT NOT NULL, definition TEXT, ipa TEXT, pos TEXT, sentence TEXT,
  book_id TEXT REFERENCES books(id) ON DELETE SET NULL, page INTEGER,
  status TEXT NOT NULL DEFAULT 'new', created_at INTEGER NOT NULL,
  ease REAL NOT NULL DEFAULT 2.5, interval_days REAL NOT NULL DEFAULT 0, due_at INTEGER NOT NULL, reps INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, word)
);
CREATE TABLE vocabulary_reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, vocabulary_id TEXT NOT NULL REFERENCES vocabulary(id) ON DELETE CASCADE, grade INTEGER NOT NULL, reviewed_at INTEGER NOT NULL);

CREATE TABLE goals (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT, level TEXT DEFAULT 'beginner', outcome TEXT, deadline TEXT,
  active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);

CREATE TABLE concepts (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, summary TEXT, kind TEXT DEFAULT 'concept', created_at INTEGER NOT NULL,
  UNIQUE (user_id, name)
);
-- A concept extracted for a specific goal at a specific place in a specific book.
CREATE TABLE goal_concepts (
  id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  book_id TEXT REFERENCES books(id) ON DELETE CASCADE, page INTEGER,
  why TEXT, category TEXT, detail TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX idx_gc_goal ON goal_concepts(goal_id);
CREATE TABLE concept_relationships (
  id TEXT PRIMARY KEY, a_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE, b_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, weight REAL DEFAULT 1, UNIQUE (a_id, b_id, kind)
);

CREATE TABLE flashcards (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id TEXT REFERENCES books(id) ON DELETE CASCADE, page INTEGER, front TEXT NOT NULL, back TEXT NOT NULL,
  source_text TEXT, kind TEXT DEFAULT 'qa', created_at INTEGER NOT NULL,
  ease REAL NOT NULL DEFAULT 2.5, interval_days REAL NOT NULL DEFAULT 0, due_at INTEGER NOT NULL, reps INTEGER NOT NULL DEFAULT 0, lapses INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_flash_due ON flashcards(user_id, due_at);
CREATE TABLE flashcard_reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, flashcard_id TEXT NOT NULL REFERENCES flashcards(id) ON DELETE CASCADE, grade INTEGER NOT NULL, reviewed_at INTEGER NOT NULL);

CREATE TABLE quizzes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, book_id TEXT REFERENCES books(id) ON DELETE CASCADE, title TEXT, scope TEXT, questions TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE quiz_attempts (id TEXT PRIMARY KEY, quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE, score REAL NOT NULL, total INTEGER NOT NULL, answers TEXT, created_at INTEGER NOT NULL);

CREATE TABLE conversations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, book_id TEXT REFERENCES books(id) ON DELETE CASCADE, title TEXT, persona TEXT, created_at INTEGER NOT NULL);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, citations TEXT, model TEXT, created_at INTEGER NOT NULL);
CREATE INDEX idx_messages_conv ON messages(conversation_id);

CREATE TABLE summaries (
  id TEXT PRIMARY KEY, book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  scope TEXT NOT NULL, kind TEXT NOT NULL, page_start INTEGER, page_end INTEGER, content TEXT NOT NULL, model TEXT, created_at INTEGER NOT NULL,
  UNIQUE (book_id, scope, kind, page_start, page_end)
);

CREATE TABLE generated_audio (id TEXT PRIMARY KEY, book_id TEXT, page INTEGER, engine TEXT NOT NULL, voice TEXT, text_hash TEXT NOT NULL UNIQUE, file_path TEXT NOT NULL, created_at INTEGER NOT NULL);

CREATE TABLE reading_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE, started_at INTEGER NOT NULL, seconds INTEGER NOT NULL DEFAULT 0, pages INTEGER NOT NULL DEFAULT 0);
CREATE TABLE preferences (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key));
CREATE TABLE jobs (id TEXT PRIMARY KEY, book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE, kind TEXT NOT NULL, status TEXT NOT NULL, progress REAL DEFAULT 0, error TEXT, created_at INTEGER NOT NULL);
`,
  },
  {
    // Additive only: existing notes keep working (kind defaults to 'note'); nothing is renamed or dropped.
    id: 2,
    sql: `
ALTER TABLE notes ADD COLUMN kind TEXT NOT NULL DEFAULT 'note';
ALTER TABLE notes ADD COLUMN chapter_idx INTEGER;
ALTER TABLE notes ADD COLUMN chapter_title TEXT;
ALTER TABLE notes ADD COLUMN section TEXT;
ALTER TABLE notes ADD COLUMN start_offset INTEGER;
ALTER TABLE notes ADD COLUMN end_offset INTEGER;
ALTER TABLE notes ADD COLUMN context TEXT;
ALTER TABLE notes ADD COLUMN quote TEXT;
ALTER TABLE notes ADD COLUMN collection TEXT;
ALTER TABLE notes ADD COLUMN norm_key TEXT;
ALTER TABLE notes ADD COLUMN updated_at INTEGER;
-- one captured note per exact passage per place
CREATE UNIQUE INDEX idx_notes_dedupe ON notes(user_id, book_id, page, norm_key) WHERE norm_key IS NOT NULL;
CREATE INDEX idx_notes_kind ON notes(user_id, kind, created_at DESC);

CREATE TABLE ignored_words (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, word TEXT NOT NULL, PRIMARY KEY (user_id, word));
CREATE TABLE note_links (a_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE, b_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE, PRIMARY KEY (a_id, b_id));

-- concept mastery from real learning interactions (quizzes, teach-back), not reading time
CREATE TABLE concept_mastery (concept_id TEXT PRIMARY KEY REFERENCES concepts(id) ON DELETE CASCADE, score REAL NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, last_at INTEGER);
CREATE TABLE concept_events (id INTEGER PRIMARY KEY AUTOINCREMENT, concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE, kind TEXT NOT NULL, score REAL NOT NULL, detail TEXT, created_at INTEGER NOT NULL);
CREATE TABLE teachbacks (id TEXT PRIMARY KEY, concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE, explanation TEXT NOT NULL, feedback TEXT NOT NULL, accuracy REAL, depth REAL, created_at INTEGER NOT NULL);

CREATE TABLE drafts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
`,
  },
  {
    // Fix: notes_fts is an external-content index; without an UPDATE trigger, editing a note left the index stale
    // and a later delete corrupted it. Rebuild from the notes table, then keep it in sync on update.
    id: 3,
    sql: `
INSERT INTO notes_fts(notes_fts) VALUES ('rebuild');
CREATE TRIGGER notes_au AFTER UPDATE OF title, body, tags ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body, tags) VALUES ('delete', old.rowid, old.title, old.body, old.tags);
  INSERT INTO notes_fts(rowid, title, body, tags) VALUES (new.rowid, new.title, new.body, new.tags);
END;
`,
  },
  {
    // Book -> World: page/book intelligence, generated experiences (assets), background tasks, course progress. Additive only.
    id: 4,
    sql: `
-- one record per page; 'basic' = deterministic analysis (instant), 'ai' = + local-model analysis. content_hash lets us skip unchanged pages.
CREATE TABLE page_intel (
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE, page INTEGER NOT NULL,
  content_hash TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'basic', data TEXT NOT NULL, model TEXT, error TEXT, updated_at INTEGER NOT NULL,
  PRIMARY KEY (book_id, page)
);

-- every generated experience (visualisation, podcast, video, course, conversation summary, study guide ...). Versioned: a regeneration adds a version row.
CREATE TABLE assets (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id TEXT REFERENCES books(id) ON DELETE CASCADE, kind TEXT NOT NULL, title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', progress REAL NOT NULL DEFAULT 0, detail TEXT,
  spec TEXT NOT NULL DEFAULT '{}', meta TEXT NOT NULL DEFAULT '{}', files TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1, group_id TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_assets_book ON assets(book_id, kind);
CREATE INDEX idx_assets_group ON assets(group_id, version);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY, book_id TEXT REFERENCES books(id) ON DELETE CASCADE, asset_id TEXT, kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', progress REAL NOT NULL DEFAULT 0, detail TEXT, error TEXT, payload TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_tasks_status ON tasks(status, created_at);

CREATE TABLE course_progress (asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE, lesson_key TEXT NOT NULL, done_at INTEGER NOT NULL, score REAL, PRIMARY KEY (asset_id, lesson_key));
`,
  },
  {
    // Universal Language Intelligence. Additive: new tables + nullable columns; originals are never modified.
    id: 5,
    sql: `
-- Every translation ever made (cache + history). 'key' identifies (text, languages, glossary state); newer versions of the same key stack up.
CREATE TABLE translations (
  id TEXT PRIMARY KEY, key TEXT NOT NULL, src_lang TEXT, tgt_lang TEXT NOT NULL, source TEXT NOT NULL, text TEXT NOT NULL,
  model TEXT, provider TEXT, version INTEGER NOT NULL DEFAULT 1, corrected INTEGER NOT NULL DEFAULT 0, warnings TEXT,
  book_id TEXT, page INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX idx_translations_key ON translations(key, version DESC);
CREATE INDEX idx_translations_book ON translations(book_id, page, tgt_lang);

-- per-book (or global when book_id is NULL) terminology: keep in the source language, translate, or show both
CREATE TABLE glossary (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, book_id TEXT REFERENCES books(id) ON DELETE CASCADE,
  term TEXT NOT NULL, lang TEXT NOT NULL, translation TEXT, mode TEXT NOT NULL DEFAULT 'keep', origin TEXT NOT NULL DEFAULT 'user', created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_glossary_unique ON glossary(user_id, COALESCE(book_id, ''), lower(term), lang);

ALTER TABLE vocabulary ADD COLUMN translations TEXT;
ALTER TABLE vocabulary ADD COLUMN user_notes TEXT;
ALTER TABLE vocabulary ADD COLUMN lang TEXT;

CREATE TABLE note_translations (note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE, lang TEXT NOT NULL, text TEXT NOT NULL, model TEXT, version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, PRIMARY KEY (note_id, lang));
`,
  },
  {
    // Active recall & long-term memory engine. Additive. Existing flashcards/vocabulary keep their own (SM-2) schedulers.
    id: 6,
    sql: `
CREATE TABLE recall_questions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  scope TEXT NOT NULL DEFAULT 'page', page INTEGER, page_end INTEGER, chapter_idx INTEGER, concept TEXT NOT NULL, objective TEXT,
  type TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 2, difficulty INTEGER NOT NULL DEFAULT 3,
  question TEXT NOT NULL, expected TEXT NOT NULL, key_points TEXT NOT NULL DEFAULT '[]', options TEXT, correct_index INTEGER, numeric TEXT,
  source_quote TEXT, sources TEXT NOT NULL DEFAULT '[]', quality TEXT NOT NULL DEFAULT '{}', content_hash TEXT, lang TEXT NOT NULL DEFAULT 'en',
  status TEXT NOT NULL DEFAULT 'active', model TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX idx_rq_book_page ON recall_questions(book_id, page, status);
CREATE INDEX idx_rq_concept ON recall_questions(user_id, book_id, concept);

-- FSRS state per question
CREATE TABLE recall_state (
  question_id TEXT PRIMARY KEY REFERENCES recall_questions(id) ON DELETE CASCADE,
  stability REAL NOT NULL DEFAULT 0, difficulty REAL NOT NULL DEFAULT 0, reps INTEGER NOT NULL DEFAULT 0, lapses INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'new', first_at INTEGER, last_review INTEGER, due_at INTEGER NOT NULL
);
CREATE INDEX idx_rs_due ON recall_state(due_at);

CREATE TABLE recall_sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, book_id TEXT REFERENCES books(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'active', planned INTEGER NOT NULL DEFAULT 0, answered INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL, ended_at INTEGER
);
CREATE INDEX idx_rsess_user ON recall_sessions(user_id, started_at DESC);

CREATE TABLE recall_attempts (
  id TEXT PRIMARY KEY, session_id TEXT REFERENCES recall_sessions(id) ON DELETE SET NULL, question_id TEXT NOT NULL REFERENCES recall_questions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL, answer TEXT NOT NULL, answer_lang TEXT, modality TEXT NOT NULL DEFAULT 'text', confidence INTEGER,
  score REAL NOT NULL, scores TEXT NOT NULL DEFAULT '{}', evaluation TEXT NOT NULL DEFAULT '{}', rating INTEGER NOT NULL, auto_rating INTEGER, time_ms INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX idx_ra_q ON recall_attempts(question_id, created_at);
CREATE INDEX idx_ra_user ON recall_attempts(user_id, created_at DESC);

CREATE TABLE blurts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE, page_from INTEGER NOT NULL, page_to INTEGER NOT NULL, answer TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE exams (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, book_id TEXT REFERENCES books(id) ON DELETE CASCADE, title TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '{}',
  question_ids TEXT NOT NULL, time_limit_sec INTEGER, started_at INTEGER, finished_at INTEGER, score REAL, result TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE mind_maps (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE, topic TEXT NOT NULL, map TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL);
`,
  },
  {
    // Vault (Obsidian-style knowledge base). The FILES ON DISK are the source of truth; every v* table is a rebuildable index/cache.
    id: 7,
    sql: `
CREATE TABLE vaults (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, root TEXT NOT NULL, created_at INTEGER NOT NULL, last_opened INTEGER);
CREATE TABLE vfiles (vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE, path TEXT NOT NULL, name TEXT NOT NULL, ext TEXT NOT NULL, mtime INTEGER NOT NULL, size INTEGER NOT NULL, hash TEXT, PRIMARY KEY (vault_id, path));
CREATE INDEX vfiles_name ON vfiles(vault_id, name COLLATE NOCASE);
CREATE TABLE vlinks (vault_id TEXT NOT NULL, src TEXT NOT NULL, raw TEXT NOT NULL, target TEXT, embed INTEGER NOT NULL DEFAULT 0, anchor TEXT, alias TEXT, md INTEGER NOT NULL DEFAULT 0, line INTEGER, ambiguous INTEGER NOT NULL DEFAULT 0);
CREATE INDEX vlinks_src ON vlinks(vault_id, src);
CREATE INDEX vlinks_target ON vlinks(vault_id, target);
CREATE TABLE vtags (vault_id TEXT NOT NULL, path TEXT NOT NULL, tag TEXT NOT NULL);
CREATE INDEX vtags_t ON vtags(vault_id, tag);
CREATE INDEX vtags_p ON vtags(vault_id, path);
CREATE TABLE vprops (vault_id TEXT NOT NULL, path TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, type TEXT NOT NULL);
CREATE INDEX vprops_p ON vprops(vault_id, path);
CREATE INDEX vprops_k ON vprops(vault_id, key);
CREATE TABLE vheads (vault_id TEXT NOT NULL, path TEXT NOT NULL, level INTEGER NOT NULL, text TEXT NOT NULL, line INTEGER NOT NULL);
CREATE INDEX vheads_p ON vheads(vault_id, path);
CREATE TABLE vtasks (vault_id TEXT NOT NULL, path TEXT NOT NULL, line INTEGER NOT NULL, done INTEGER NOT NULL, text TEXT NOT NULL);
CREATE INDEX vtasks_p ON vtasks(vault_id, path);
CREATE TABLE vcontent (vault_id TEXT NOT NULL, path TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (vault_id, path));
CREATE TABLE vhistory (id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX vhistory_p ON vhistory(vault_id, path, created_at);
`,
  },
  {
    // Life Journal. Three layers are kept apart: original media (files), verbatim transcript (j_segments.text, never edited), AI writing (j_docs).
    id: 8,
    sql: `
CREATE TABLE j_entries (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'written', mode TEXT, title TEXT, body TEXT NOT NULL DEFAULT '', mood TEXT, tags TEXT NOT NULL DEFAULT '[]', favourite INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX j_entries_day ON j_entries(user_id, day);
CREATE TABLE j_recordings (id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES j_entries(id) ON DELETE CASCADE, kind TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER, chunks INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'recording', title TEXT, lang TEXT, quality TEXT, started_at INTEGER NOT NULL, ended_at INTEGER, last_chunk_at INTEGER);
CREATE INDEX j_rec_entry ON j_recordings(entry_id);
CREATE TABLE j_transcripts (id TEXT PRIMARY KEY, recording_id TEXT NOT NULL REFERENCES j_recordings(id) ON DELETE CASCADE, lang TEXT, model TEXT, created_at INTEGER NOT NULL);
CREATE TABLE j_segments (id INTEGER PRIMARY KEY AUTOINCREMENT, transcript_id TEXT NOT NULL REFERENCES j_transcripts(id) ON DELETE CASCADE, idx INTEGER NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, text TEXT NOT NULL, corrected TEXT);
CREATE INDEX j_seg_t ON j_segments(transcript_id, idx);
CREATE TABLE j_docs (id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES j_entries(id) ON DELETE CASCADE, recording_id TEXT, kind TEXT NOT NULL, style TEXT, version INTEGER NOT NULL DEFAULT 1, body TEXT NOT NULL, data TEXT, model TEXT, edited INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE INDEX j_docs_entry ON j_docs(entry_id, kind);
CREATE TABLE j_jobs (id TEXT PRIMARY KEY, recording_id TEXT NOT NULL REFERENCES j_recordings(id) ON DELETE CASCADE, kind TEXT NOT NULL, status TEXT NOT NULL, progress REAL NOT NULL DEFAULT 0, detail TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX j_jobs_rec ON j_jobs(recording_id);
CREATE TABLE j_convs (id TEXT PRIMARY KEY, entry_id TEXT REFERENCES j_entries(id) ON DELETE SET NULL, mode TEXT NOT NULL, title TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE j_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, conv_id TEXT NOT NULL REFERENCES j_convs(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, saved INTEGER NOT NULL DEFAULT 0, safety INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE j_bookmarks (id TEXT PRIMARY KEY, recording_id TEXT NOT NULL REFERENCES j_recordings(id) ON DELETE CASCADE, at_ms INTEGER NOT NULL, label TEXT, created_at INTEGER NOT NULL);
`,
  },
  {
    // Life Journal phase 5: people, goals, milestones, period reports. Everything here is created or approved by the user; nothing is inferred into a profile.
    id: 9,
    sql: `
ALTER TABLE j_entries ADD COLUMN sensitive INTEGER NOT NULL DEFAULT 0;
CREATE TABLE j_people (id TEXT PRIMARY KEY, name TEXT NOT NULL, aliases TEXT NOT NULL DEFAULT '', relationship TEXT, notes TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE j_goals (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', deadline TEXT, status TEXT NOT NULL DEFAULT 'active', obstacles TEXT NOT NULL DEFAULT '', source_entry_id TEXT REFERENCES j_entries(id) ON DELETE SET NULL, source_at_ms INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE j_goal_updates (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES j_goals(id) ON DELETE CASCADE, kind TEXT NOT NULL DEFAULT 'progress', body TEXT NOT NULL, entry_id TEXT REFERENCES j_entries(id) ON DELETE SET NULL, created_at INTEGER NOT NULL);
CREATE TABLE j_milestones (id TEXT PRIMARY KEY, day TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'milestone', entry_id TEXT REFERENCES j_entries(id) ON DELETE SET NULL, recording_id TEXT, at_ms INTEGER, created_at INTEGER NOT NULL);
CREATE INDEX j_ms_day ON j_milestones(day);
CREATE TABLE j_reports (id TEXT PRIMARY KEY, kind TEXT NOT NULL, from_day TEXT NOT NULL, to_day TEXT NOT NULL, data TEXT NOT NULL, model TEXT, created_at INTEGER NOT NULL);
CREATE TABLE j_dismissed (key TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
`,
  },
  {
    // Life Journal multilingual layer: translated transcript segments (a separate layer, the verbatim text is never overwritten) and measured speech-recognition checks.
    id: 10,
    sql: `
CREATE TABLE j_seg_trans (transcript_id TEXT NOT NULL REFERENCES j_transcripts(id) ON DELETE CASCADE, idx INTEGER NOT NULL, lang TEXT NOT NULL, text TEXT NOT NULL, model TEXT, warnings TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (transcript_id, idx, lang));
CREATE TABLE j_langtests (id TEXT PRIMARY KEY, lang TEXT NOT NULL, model TEXT NOT NULL, expected TEXT NOT NULL, got TEXT NOT NULL, cer REAL NOT NULL, wer REAL NOT NULL, band TEXT NOT NULL, duration_ms INTEGER, created_at INTEGER NOT NULL);
`,
  },
  {
    // Assistant memory: facts the user wants remembered across conversations.
    id: 11,
    sql: `
CREATE TABLE memories (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, text TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, pinned INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'manual', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX memories_user ON memories(user_id, updated_at);
`,
  },
  {
    // Reading analytics: measured words and speed per session (additive columns; existing rows keep working).
    id: 12,
    sql: `
ALTER TABLE reading_sessions ADD COLUMN words INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reading_sessions ADD COLUMN wpm REAL;
ALTER TABLE reading_sessions ADD COLUMN mode TEXT;
CREATE INDEX IF NOT EXISTS idx_rsessions_user_time ON reading_sessions(user_id, started_at DESC);
`,
  },
];

const gl = globalThis as unknown as { __tenantDbs?: Map<string, DB> };
const OPEN = (gl.__tenantDbs ??= new Map<string, DB>());
const MAX_OPEN = Number(process.env.FOLIO_MAX_OPEN_DBS || 64);

function openTenantDb(uid: string): DB {
  fs.mkdirSync(userDir(uid), { recursive: true });
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
  const d = new DatabaseSync(path.join(userDir(uid), 'app.db'));
  d.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  d.exec('CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const applied = new Set((d.prepare('SELECT id FROM _migrations').all() as { id: number }[]).map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    d.exec('BEGIN');
    try { d.exec(m.sql); d.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)').run(m.id, Date.now()); d.exec('COMMIT'); }
    catch (e) { d.exec('ROLLBACK'); throw e; }
  }
  d.prepare('INSERT OR IGNORE INTO users (id, name, created_at) VALUES (?, ?, ?)').run(uid, 'Reader', Date.now());
  return d;
}

/** The current tenant's database. Throws if no user context is active. */
export function db(): DB {
  const uid = me();
  const hit = OPEN.get(uid);
  if (hit) { OPEN.delete(uid); OPEN.set(uid, hit); return hit; } // LRU touch
  const d = openTenantDb(uid);
  OPEN.set(uid, d);
  while (OPEN.size > MAX_OPEN) { const [old, od] = OPEN.entries().next().value as [string, DB]; OPEN.delete(old); try { od.close(); } catch { /* in use elsewhere: GC closes it */ } }
  return d;
}
/** Close a tenant's connection (used before deleting or restoring their data). */
export function closeTenantDb(uid: string) { const d = OPEN.get(uid); if (d) { OPEN.delete(uid); try { d.close(); } catch { /* ignore */ } } }

type Row = Record<string, any>;
export const all = <T = Row>(sql: string, ...p: any[]): T[] => db().prepare(sql).all(...p) as T[];
export const get = <T = Row>(sql: string, ...p: any[]): T | undefined => db().prepare(sql).get(...p) as T | undefined;
export const run = (sql: string, ...p: any[]) => db().prepare(sql).run(...p);
export const uid = () => crypto.randomUUID();

export function tx<T>(fn: () => T): T {
  const d = db();
  d.exec('BEGIN');
  try {
    const r = fn();
    d.exec('COMMIT');
    return r;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

/** Verify a book belongs to the current user (defence in depth: the tenant database already contains only their rows). */
export function ownBook(id: string) {
  return get<Row>('SELECT * FROM books WHERE id = ? AND user_id = ?', id, me());
}
