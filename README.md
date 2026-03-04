# life-dashboard

Personal system dashboard -- single-file Node.js HTTP server with zero external dependencies.

## Setup

```bash
npm install   # (no deps -- this is a formality)
```

Requires self-signed SSL cert at `~/.ssl/localhost.{crt,key}`.

## Usage

```bash
npm run dev     # Start with file watching (node --watch)
npm start       # Start without watching
```

Dashboard: `https://localhost:3000`
API: `https://localhost:3000/api/state`

## Pages

| Route | Description |
|-------|-------------|
| `/` | Main dashboard -- system metrics, task registry, vault stats |
| `/stream` | Life Stream -- 15 data sources, auto-refresh |
| `/command` | Where Peretz is needed -- parses TASKS.md |
| `/machines` | Cross-machine status (Hearth/Anvil/NAS) |
| `/fleet` | Fleet status with Tailscale mesh |
| `/blockers` | Convergence view -- dynamically parses TASKS.md |
| `/agents` | Active AI agents |

## Architecture

Everything is `server.js` -- pure Node.js HTTP, no framework, no build step.

Three layers in one file:
1. **Data collection** -- shell commands (`df`, `uptime`, `memory_pressure`, `sqlite3`) for real-time metrics
2. **Task registry** -- hardcoded task array with status tracking
3. **Rendering** -- server-side HTML with inline CSS, dark terminal aesthetic, 30s auto-refresh

## Status

Production. Runs as a LaunchAgent (`com.practicelife.dashboard`), always on.
