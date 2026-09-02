# Fleet Slack Bridge

Wire the Slack workspace to your **local fleet** (Oakland + Framingham) so an
`@mention` in Slack reaches a real machine in your house and the machine
answers in-thread.

Slack *Desktop* can't talk to local processes — but the Slack *platform* can,
via a bot. This is that bot's backend: a small **zero-dependency** daemon
(Node 22's built-in `WebSocket` + `fetch`, no npm installs) that each node
runs.

## Why Socket Mode

| Mode | Needs a public URL? | Fit for home machines |
|---|---|---|
| Events API (webhooks) | Yes — public HTTPS endpoint (tunnel/ngrok) | Fragile behind home NAT |
| **Socket Mode** | **No** — outbound WebSocket | **Ideal** — no port-forwarding |

Each node opens an *outbound* WebSocket to Slack. Nothing inbound to open on
your router.

## Topology

```
              Slack workspace
                    │  (one outbound Socket Mode connection per node)
        ┌───────────┴───────────┐
        ▼                       ▼
    bridge.js               bridge.js
    FLEET_NODE=bork-oak     FLEET_NODE=bork-fram
    (Oakland)               (Framingham)
        │                       │
        ▼                       ▼
    local handler           local handler
    claude -p / Ollama      claude -p / Ollama
```

Replies are prefixed with the node name (`*bork-oak* ▸ …`) so you can see
*which* machine answered — one Slack app is enough. (Want distinct avatars per
node? Create two Slack apps from `manifest.yaml`, one per node.)

## Setup (once)

1. **Create the app.** https://api.slack.com/apps → *From an app manifest* →
   paste `manifest.yaml` → create → **Install to Workspace**.
2. **Get the bot token.** OAuth & Permissions → *Bot User OAuth Token*
   (`xoxb-…`).
3. **Get the app token.** Basic Information → *App-Level Tokens* → generate one
   with the `connections:write` scope (`xapp-…`).
4. **Invite the bot** to the channel(s) you want it in: `/invite @borka`.

## Run (per node)

```bash
cp slack-bridge/env.example .env    # then fill in the tokens + FLEET_NODE
npm run bridge
```

Set `FLEET_HANDLER_CMD` to route messages to a local model, e.g. `claude -p`
or `ollama run llama3.1`. Leave it blank to run in safe echo mode first and
confirm the plumbing. Say `@borka ping` in Slack to check a node is alive.

Run it as a long-lived service (systemd / launchd / `pm2`) so each node stays
connected.

### Config

All config is via env vars — see `env.example` for the annotated list
(`SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, `FLEET_NODE`, `FLEET_PRESENCE_CHANNEL`,
`FLEET_HANDLER_CMD`, `FLEET_HANDLER_STDIN`, `FLEET_HANDLER_TIMEOUT_MS`,
`FLEET_ALLOW_CHANNELS`).

## The human playbook (fingers & eyeballs)

The bridge only helps if the humans' Slack is set up to match. Suggested:

- **One channel per concern**, threads for each task. The bridge replies in the
  thread it was pinged in, so threads keep a node's work self-contained.
- **Notifications:** set the coordination channel to *All new messages* on
  your phone so a node's reply pings you; mute high-volume log/presence
  channels to *Mentions only*.
- **Presence channel:** point `FLEET_PRESENCE_CHANNEL` at a low-traffic
  `#fleet` channel so nodes announce online/offline — that's how you *see* the
  fleet come alive instead of guessing.
- **Address a specific node** by pinging in a thread and reading the `*node* ▸`
  prefix; if both OAK and FRAM run the same app, both may answer — use
  `FLEET_ALLOW_CHANNELS` to keep a node scoped to certain channels.
- **Durable context lives in the repo, not Slack.** Anything every future
  session should know (fleet topology, naming, product vision) belongs in
  committed files so it loads automatically.

## Security notes

- Tokens live in `.env` (gitignored) or the service manager's secret store —
  never commit them. `manifest.yaml` and `env.example` are safe to commit
  (no secrets).
- The Slack message is passed to the handler as the **final argv element**,
  never interpolated into a shell string, so message text can't inject shell
  commands. Still, `FLEET_HANDLER_CMD` runs with the node user's privileges —
  point it at a sandboxed model runner, and use `FLEET_ALLOW_CHANNELS` to limit
  where it listens.
- The bridge ignores messages from bots and from itself, and de-dupes Slack
  redeliveries, to avoid loops.
