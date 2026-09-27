# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**PracticeLife OS — Living Dashboard (Ω₀)**. A personal system dashboard that tracks setup progress, system state, and digital artifact organization. Single-file Node.js HTTP server with zero external dependencies.

## Commands

```bash
npm run dev     # Start with file watching (node --watch server.js)
npm start       # Start without watching
```

**Dashboard runs at `https://localhost:3000` (HTTPS only with self-signed cert).**
- JSON API: `https://localhost:3000/api/state`
- History: `https://localhost:3000/api/history`
- Use `curl -k` for testing (ignores certificate warnings)

## Architecture

The entire app is `server.js` — a pure Node.js HTTP server (no framework, no build step).

**Three layers in one file:**
1. **Data collection** (`getState()`) — executes shell commands (`df`, `uptime`, `memory_pressure`, `find`, `ls`) to gather real-time system metrics, file counts, and Obsidian vault stats
2. **Task registry** (`TASKS` array) — hardcoded task list with statuses: `done`, `running`, `blocked`, `critical`, `pending`
3. **Rendering** (`renderHTML()`) — server-side rendered HTML with inline CSS. Dark terminal aesthetic, card grid layout, progress bar, task table. Auto-refreshes every 30 seconds via `<meta http-equiv="refresh">`.

**Two endpoints:**
- `GET /` — full HTML dashboard
- `GET /api/state` — JSON system state

**Key paths monitored:**
- Obsidian vault: `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/PracticeLife`
- Context file: `{VAULT}/Claude/Context.md` (timestamp shown in footer)
- Voice memos: `~/Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings/`
- Whisper output: `/tmp/whisper-output/`
- Downloads: `~/Downloads/`

**Shell command pattern:** All system queries use the `run(cmd, timeout)` helper which wraps `execSync` with a 5-second default timeout and returns `'—'` on failure.

## Practices

Shared engineering practices live in [`docs/PRACTICES.md`](docs/PRACTICES.md), a synced copy. Don't edit it here; changes go to the canonical file and sync back. The rules that matter most for this repo:

1. **This repo is public, so nothing personal goes into git.** No contact details, message text, health, benefits or money matters, location, household members' names or home-network addresses in `server.js`, the task registry or committed logs. Personal content is read at runtime from files outside the repo (such as `~/.claude/TASKS.md`) or from git-ignored paths (`data/`), and shown only on the local dashboard.
2. **Apple's stores are read-only.** The Life Stream probes `chat.db`, `Photos.sqlite`, `NoteStore.sqlite` and Safari's `History.db` in place. Open them read-only (`sqlite3 -readonly` or a `file:...?mode=ro` URI) and never write, checkpoint or vacuum them. The `sqliteQuery()` helper does not pass a read-only flag yet.
3. **Probes are short and bounded.** Each one returns counts, never message text. New queries on the big stores use a date window and a LIMIT.
4. **One failing source doesn't blank the page.** Each probe catches its own error and says why ("no Full Disk Access" is reported separately from "file not found"), and the other streams still render.
5. **Cloud sessions can't run this.** Every data source is on the Mac (`$HOME`, the LAN, Tailscale). A cloud session can edit code but can't verify it, so it writes the remaining steps under a dated `## Open threads` heading here, with exact commands, for a session on the Mac.
6. **Smoke-test against a fake `$HOME`.** `server.js` reads everything under `process.env.HOME`, so run it with `HOME` pointed at a temp dir holding synthetic stores (and a throwaway self-signed cert in `.ssl/`) before pushing.
