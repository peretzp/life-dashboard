#!/usr/bin/env node
'use strict';

/**
 * PracticeLife OS — Fleet Slack Bridge (Ω₀)
 *
 * A zero-dependency Slack Socket Mode client. Each fleet node (OAK / FRAM)
 * runs one copy with its own FLEET_NODE name and bot token. It receives
 * @mentions and DMs over an OUTBOUND WebSocket (works behind home NAT — no
 * public URL or port-forwarding), routes them to a local handler
 * (claude -p, Ollama, or any command), and posts the reply back in-thread.
 *
 * Built on Node 22's global `WebSocket` and `fetch` — no npm dependencies.
 * See slack-bridge/README.md for setup.
 */

const os = require('os');
const { spawn } = require('child_process');

const SLACK_API = 'https://slack.com/api';

// Load a local .env into process.env if present (Node 22 built-in — no
// dependency). A missing file is fine; real environment vars still work.
try { process.loadEnvFile('.env'); } catch { /* no .env — use process.env as-is */ }

// ---- config -----------------------------------------------------------
const APP_TOKEN = process.env.SLACK_APP_TOKEN || '';   // xapp-... (Socket Mode)
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';   // xoxb-... (Web API)
const NODE_NAME = process.env.FLEET_NODE || os.hostname();
const PRESENCE_CHANNEL = process.env.FLEET_PRESENCE_CHANNEL || '';
const HANDLER_CMD = process.env.FLEET_HANDLER_CMD || '';   // e.g. "claude -p"
const HANDLER_STDIN = process.env.FLEET_HANDLER_STDIN === '1';
const HANDLER_TIMEOUT = Number(process.env.FLEET_HANDLER_TIMEOUT_MS || 120000);
const ALLOW_CHANNELS = (process.env.FLEET_ALLOW_CHANNELS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

if (!APP_TOKEN || !BOT_TOKEN) {
  console.error('[bridge] Missing SLACK_APP_TOKEN and/or SLACK_BOT_TOKEN. See slack-bridge/README.md');
  process.exit(1);
}

let BOT_USER_ID = null;      // resolved at startup via auth.test
const seen = new Set();      // event_id dedup for redeliveries
const SEEN_CAP = 5000;

function log(...a) { console.log(`[bridge:${NODE_NAME}]`, ...a); }

// ---- slack web api ----------------------------------------------------
async function slack(method, body) {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${BOT_TOKEN}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json();
  if (!json.ok) log(`slack ${method} error:`, json.error);
  return json;
}

function post(channel, text, thread_ts) {
  return slack('chat.postMessage', { channel, text, thread_ts, unfurl_links: false });
}

// ---- handler: dispatch to a local model / claude ----------------------
// The user's message is passed as the FINAL argv element (never interpolated
// into a shell string) so Slack text cannot inject shell commands.
function runHandler(prompt) {
  return new Promise((resolve) => {
    if (!HANDLER_CMD) {
      resolve(
        `heard you, but no local handler is wired on this node yet.\n` +
        `Set \`FLEET_HANDLER_CMD\` (e.g. \`claude -p\`) in this node's env to route to a local model.\n` +
        `> ${prompt}`
      );
      return;
    }
    const parts = HANDLER_CMD.split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);
    if (!HANDLER_STDIN) args.push(prompt);
    let child;
    try {
      child = spawn(cmd, args, { shell: false });
    } catch (e) {
      resolve(`handler failed to start on ${NODE_NAME}: ${e.message}`);
      return;
    }
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, HANDLER_TIMEOUT);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); resolve(`handler error on ${NODE_NAME}: ${e.message}`); });
    child.on('close', code => {
      clearTimeout(timer);
      const body = out.trim() || err.trim() || `(no output, exit ${code})`;
      resolve(body.length > 3500 ? body.slice(0, 3500) + '\n…(truncated)' : body);
    });
    if (HANDLER_STDIN) {
      child.stdin.on('error', () => {});   // handler may exit before reading — ignore EPIPE
      child.stdin.write(prompt);
      child.stdin.end();
    }
  });
}

// ---- event handling ---------------------------------------------------
function stripMention(text) {
  return (text || '').replace(/<@[^>]+>/g, '').trim();
}

async function handleEvent(ev) {
  if (!ev) return;
  // ignore bots, our own messages, and message edits/deletes/joins to avoid
  // loops and spurious re-runs (message_changed/message_deleted carry a subtype)
  if (ev.bot_id) return;
  if (ev.type === 'message' && ev.subtype) return;
  if (BOT_USER_ID && ev.user === BOT_USER_ID) return;

  const isMention = ev.type === 'app_mention';
  const isDM = ev.type === 'message' && ev.channel_type === 'im';
  if (!isMention && !isDM) return;
  if (ALLOW_CHANNELS.length && !ALLOW_CHANNELS.includes(ev.channel)) return;

  const prompt = stripMention(ev.text);
  const thread = ev.thread_ts || ev.ts;

  const low = prompt.toLowerCase();
  if (low === 'ping' || low === 'fleet ping') {
    await post(ev.channel, `🟢 *${NODE_NAME}* here on \`${os.hostname()}\` — awake and listening.`, thread);
    return;
  }

  await post(ev.channel, `⏳ *${NODE_NAME}* is on it…`, thread);
  const reply = await runHandler(prompt);
  await post(ev.channel, `*${NODE_NAME}* ▸ ${reply}`, thread);
}

// ---- socket mode ------------------------------------------------------
async function openConnection() {
  const res = await fetch(`${SLACK_API}/apps.connections.open`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${APP_TOKEN}` },
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`apps.connections.open failed: ${json.error}`);
  return json.url;
}

function remember(id) {
  if (!id) return false;
  if (seen.has(id)) return true;
  seen.add(id);
  if (seen.size > SEEN_CAP) seen.clear();
  return false;
}

let backoff = 1000;

async function connect() {
  let url;
  try {
    url = await openConnection();
  } catch (e) {
    log('connect error:', e.message, `— retrying in ${backoff}ms`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30000);
    return;
  }

  const ws = new WebSocket(url);

  ws.addEventListener('open', () => log('socket open'));

  ws.addEventListener('message', (msg) => {
    let data;
    try { data = JSON.parse(msg.data); } catch { return; }

    if (data.type === 'hello') {
      backoff = 1000;
      log(`connected — ${data.num_connections} connection(s)`);
      return;
    }
    if (data.type === 'disconnect') {
      log('server asked to disconnect:', data.reason);
      try { ws.close(); } catch {}
      return;
    }
    // ack anything with an envelope_id immediately (Slack requires < 3s)
    if (data.envelope_id) {
      ws.send(JSON.stringify({ envelope_id: data.envelope_id }));
    }
    if (data.type === 'events_api' && data.payload) {
      const p = data.payload;
      if (remember(p.event_id)) return;   // drop redeliveries
      handleEvent(p.event).catch(e => log('handleEvent error:', e.message));
    }
  });

  ws.addEventListener('close', () => {
    log('socket closed — reconnecting');
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30000);
  });

  ws.addEventListener('error', (e) => {
    log('socket error:', (e && (e.message || e.type)) || e);
    try { ws.close(); } catch {}
  });
}

// ---- startup ----------------------------------------------------------
async function main() {
  const auth = await slack('auth.test', {});
  if (auth.ok) {
    BOT_USER_ID = auth.user_id;
    log(`authenticated as ${auth.user} (${auth.user_id}) in ${auth.team}`);
  } else {
    log('auth.test failed:', auth.error, '— check SLACK_BOT_TOKEN');
  }
  if (PRESENCE_CHANNEL) {
    await post(PRESENCE_CHANNEL, `🟢 *${NODE_NAME}* online — \`${os.hostname()}\` joined the fleet.`);
  }
  await connect();
}

async function shutdown(signal) {
  log(`shutting down (${signal})`);
  if (PRESENCE_CHANNEL) {
    try { await post(PRESENCE_CHANNEL, `⚪️ *${NODE_NAME}* going offline.`); } catch {}
  }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch(e => { console.error('[bridge] fatal:', e); process.exit(1); });
