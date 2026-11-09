# bookbook 1.0.0 (Windows)

A free, local-first book reader. EPUBs open as the real book (publisher layout, fonts, images, spreads) with Apple Books-style themes, text size and paging; PDFs, DOCX, TXT, Markdown, HTML, FB2, CSV and XLSX are supported too. Your library stays on your computer.

## Download

**bookbook Setup 1.0.0.exe** (GitHub lists it as `bookbook.Setup.1.0.0.exe`) - 175,625,863 bytes (about 168 MiB), Windows 10/11, 64-bit, installs for the current user (no administrator rights).

SHA-256: `9f26c2ac168b2d5a0f54709546d3f57b68b7360d4542c41c138a852957ce0f5f`

Check it before running: `certutil -hashfile "bookbook Setup 1.0.0.exe" SHA256`

## Windows SmartScreen warning

The installer is **not code-signed**. Windows will show "Windows protected your PC". If the SHA-256 above matches, choose **More info -> Run anyway**. A code-signing certificate would remove this warning; it is not in place for 1.0.0.

## What's in this release

- Real-EPUB reader; goals feature removed; renamed from Folio to bookbook.
- Per-account data, sign-in, sessions with server-side revocation, CSRF and host checks (web mode). The desktop app is single-user and needs no sign-in.
- Fixes found during release verification: PDF import and PDF viewing failed in the packaged app (module resolution and a Content-Security-Policy conflict); uploads larger than 10 MB were truncated by the web server; a spurious server error when opening cover pages.
- Dependencies: 0 known vulnerabilities in production and development packages (root and desktop, `npm audit`).

## Your data

Stored in `%APPDATA%\Folio` (name kept from the app's earlier name so existing libraries are not orphaned). Uninstalling does not delete it.

## Known limitations

- Unsigned installer (above). No auto-update: install new versions over the old one.
- AI features (summaries, questions, Ask) need a local [Ollama](https://ollama.com) with a model; everything else works without it.
- The installed program's files contain the build machine's Windows username inside build paths.
- On narrow windows with the side panel open, a PDF page can extend slightly under the panel.
- Verified on Windows 11 Home x64 only.

## License

Copyright (c) 2026 bookbook. **All rights reserved.** Not open-source: you may install and use it, but may not copy, modify, redistribute or sell it without written permission. See `LICENSE`.
