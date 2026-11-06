# Folio desktop

A Windows app that runs Folio entirely on your computer and keeps it running.

**How it works**
- `main.cjs` (Electron) starts the Folio server as a hidden child process on `127.0.0.1:38417`, signs you in automatically (no password on your own PC), and opens it in a window.
- Closing the window hides Folio in the system tray. It keeps running there; **Quit Folio** in the tray menu really exits.
- Starts with Windows by default (switch off in the tray menu). A second launch just brings the existing window forward.
- A watchdog checks the server every 5 s; if it stops answering, the app restarts it and reloads the window. It also recovers after the PC wakes from sleep, and restarts Ollama (the local AI runtime) if it is installed but not running.
- Your data lives in `%APPDATA%\Folio\data` (one database + your books, recordings, notes). A backup is made automatically every day (last 7 kept) in `%APPDATA%\Folio\backups`; logs are in `%APPDATA%\Folio\logs`.
- On first launch, data from the older Folio folder (`...\Book Reader\data`) is copied in (the original is left untouched).
- Memory: Settings → Memory holds facts the assistant remembers; the window position and the last place you were (book, page, screen) are restored on every launch.

**Build the installer**

```
cd desktop
npm install
npm run dist        # builds the server bundle, then dist\Folio Setup 1.0.0.exe
```

Needs Node 24+. AI features need [Ollama](https://ollama.com) with a model (e.g. `ollama pull gemma3:4b`); transcription needs Python `openai-whisper` and ffmpeg. Everything else works without them.

**Restore a backup**: quit Folio, then `node scripts/restore.mjs "%APPDATA%\Folio\backups\folio-<date>" "%APPDATA%\Folio\data" --force` (the current data is moved aside, not deleted).
