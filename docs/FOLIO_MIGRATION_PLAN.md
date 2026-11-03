# Migration & compatibility plan

- **Database:** migration 7 is additive (new `vaults`, `vfiles`, `vlinks`, `vtags`, `vprops`, `vheads`, `vtasks`, `vcontent`, `vhistory`). No existing table is altered. Rolling back = ignoring the tables.
- **Existing data:** books, highlights, notes, recall, translations are untouched. The legacy "Notes & highlights" view and the SQLite `notes` table keep working; they are *not* migrated into the vault. A later phase will *reference* them from the vault (see architecture), not copy them.
- **Vaults:** a vault is any folder. Opening an existing Obsidian vault or Markdown folder indexes it in place and writes nothing to it (Folio keeps its own state in the database and `data/vault-history`). `.obsidian/`, `.trash/`, `.git/` and dot-folders are ignored.
- **Formats:** Markdown with YAML frontmatter, wikilinks, embeds, callouts are read and written unchanged. Editing frontmatter through the Properties panel preserves unknown keys and comments (tested). `.canvas` / `.base` are not yet read or written.
- **Book metadata → canonical properties** (title, author, reading_status, …): planned for Phase 7 as a read-only adapter; existing book fields are not renamed.
- **Backups:** the vault is plain files (back up the folder); `data/vault-history` holds recoverable versions. The existing library backup/export is unchanged.
- **Planned (not done):** importers for Notion, Evernote, OneNote, Apple Notes, Keep, Logseq, Roam, Bear, Craft, CSV/HTML; each needs fixtures and adapter tests before it is exposed.
