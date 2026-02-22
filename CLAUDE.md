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
