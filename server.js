const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = 3000;
const VAULT = path.join(process.env.HOME, 'Library/Mobile Documents/iCloud~md~obsidian/Documents/PracticeLife');
const HISTORY_FILE = path.join(__dirname, 'history.jsonl');
const HISTORY_MAX = 2880; // 48 hours at 1 snapshot/minute

// Cache for expensive shell commands (reduces CPU/disk thrashing)
const cmdCache = new Map();
const CACHE_TTL = 30000; // 30 seconds

function run(cmd, timeout = 5000, cached = true) {
  if (cached && cmdCache.has(cmd)) {
    const { value, timestamp } = cmdCache.get(cmd);
    if (Date.now() - timestamp < CACHE_TTL) {
      return value;
    }
  }
  try {
    const value = execSync(cmd, { timeout, encoding: 'utf8' }).trim();
    if (cached) cmdCache.set(cmd, { value, timestamp: Date.now() });
    return value;
  } catch { return '—'; }
}

function getState() {
  const volumes = run('ls /Volumes/');
  const diskUsage = run("df -h / | tail -1 | awk '{print $5}'");
  const uptime = run('uptime');
  const downloads = run('ls ~/Downloads/ | wc -l').trim();
  const downloadsOrg = run('find ~/Downloads -mindepth 1 -maxdepth 1 -type d | wc -l').trim();
  const downloadsLoose = run('find ~/Downloads -maxdepth 1 -type f | wc -l').trim();
  const obsidianFiles = run(`find "${VAULT}" -name "*.md" | wc -l`).trim();
  const homeUpdated = run(`stat -f '%Sm' "${VAULT}/Dashboards/Home.md" 2>/dev/null || stat -f '%Sm' "${VAULT}/Claude/Context.md" 2>/dev/null`);

  // MemoryAtlas stats
  const atlasStats = run('~/tools/memoryatlas/.venv/bin/atlas status 2>/dev/null');
  const atlasTotal = (atlasStats.match(/Total assets:\s+(\d+)/) || [])[1] || '0';
  const atlasHours = (atlasStats.match(/Total hours:\s+([\d.]+)/) || [])[1] || '0';
  const atlasTranscribed = (atlasStats.match(/Transcribed:\s+(\d+)/) || [])[1] || '0';
  const atlasPublished = (atlasStats.match(/Published:\s+(\d+)/) || [])[1] || '0';

  // Session logs
  const SESSION_LOGS = path.join(process.env.HOME, '.claude/session-logs');
  let sessionLogs = [];
  try {
    sessionLogs = fs.readdirSync(SESSION_LOGS)
      .filter(f => f.endsWith('.md'))
      .map(f => ({ name: f.replace('.md', ''), modified: fs.statSync(path.join(SESSION_LOGS, f)).mtime }))
      .sort((a, b) => b.modified - a.modified)
      .slice(0, 5);
  } catch {}

  const protocolPath = path.join(process.env.HOME, 'agent-protocol.md');
  const protocolExists = fs.existsSync(protocolPath);
  const apiLive = run('curl -s -o /dev/null -w "%{http_code}" --max-time 1 https://127.0.0.1:3001/health 2>/dev/null') === '200';
  const promptBrowserLive = run('curl -s -o /dev/null -w "%{http_code}" --max-time 1 https://127.0.0.1:3002/api/stats 2>/dev/null') === '200';
  const contactVerifyLive = run('curl -s -o /dev/null -w "%{http_code}" --max-time 1 https://127.0.0.1:3003/ 2>/dev/null') === '200';
  const downloadDaemonLive = run('launchctl list | grep -q download-daemon && echo "1" || echo "0"', 1000) === '1';

  // Parse all session logs for instance history
  let instances = [];
  try {
    const allLogs = fs.readdirSync(SESSION_LOGS)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const content = fs.readFileSync(path.join(SESSION_LOGS, f), 'utf8');
        const modified = fs.statSync(path.join(SESSION_LOGS, f)).mtime;
        const nameMatch = content.match(/^# Session:\s*(.+)/m);
        const focusMatch = content.match(/\*\*Focus\*\*:\s*(.+)/);
        const pendingMatch = content.match(/## Pending[\s\S]*?(?=\n## |$)/);
        const pendingItems = pendingMatch
          ? pendingMatch[0].split('\n').filter(l => l.trim().startsWith('-')).map(l => l.replace(/^-\s*/, '').trim()).slice(0, 3)
          : [];
        const remainMatch = content.match(/## Remaining[\s\S]*?(?=\n## |$)/);
        const remainItems = remainMatch
          ? remainMatch[0].split('\n').filter(l => l.trim().startsWith('-')).map(l => l.replace(/^-\s*/, '').trim()).slice(0, 3)
          : [];
        const instanceMatch = content.match(/\*\*Instance\*\*:\s*(.+)/);
        return {
          file: f.replace('.md', ''),
          name: nameMatch ? nameMatch[1].trim() : f.replace('.md', ''),
          focus: focusMatch ? focusMatch[1].trim() : '',
          model: instanceMatch ? instanceMatch[1].trim() : '',
          modified: modified,
          date: f.slice(0, 10),
          pending: [...pendingItems, ...remainItems],
        };
      })
      .sort((a, b) => b.modified - a.modified);
    instances = allLogs;
  } catch {}

  // Parse agent protocol for worker status (fixed: 6-column table)
  let workers = [];
  let handoffs = [];
  if (protocolExists) {
    try {
      const proto = fs.readFileSync(protocolPath, 'utf8');
      const agentTableMatch = proto.match(/## Active Agents[\s\S]*?\|[-\s|]+\|([\s\S]*?)(?=\n##|\n$)/);
      if (agentTableMatch) {
        const rows = agentTableMatch[1].trim().split('\n').filter(r => r.includes('|'));
        for (const row of rows) {
          const cols = row.split('|').map(c => c.trim()).filter(Boolean);
          if (cols.length >= 6) {
            workers.push({ agent: cols[0], name: cols[1], model: cols[2], interface: cols[3], status: cols[4], focus: cols[5] });
          } else if (cols.length >= 5) {
            workers.push({ agent: cols[0], name: cols[0], model: cols[1], interface: cols[2], status: cols[3], focus: cols[4] });
          }
        }
      }
      // Parse last 3 handoffs
      const handoffSection = proto.match(/## Handoffs([\s\S]*$)/);
      if (handoffSection) {
        const entries = handoffSection[1].split(/\n### /).filter(Boolean).slice(-3).reverse();
        for (const entry of entries) {
          const titleLine = entry.split('\n')[0].trim();
          const parts = titleLine.split(' — ');
          const blockerMatch = entry.match(/\*\*Blockers?\*\*:\s*\n?-?\s*(.+)/i);
          const nextMatch = entry.match(/\*\*What's next\*\*:\s*\n?([\s\S]*?)(?=\n\*\*|\n###|$)/i);
          let nextSteps = [];
          if (nextMatch) {
            nextSteps = nextMatch[1].split('\n').filter(l => l.trim().startsWith('-')).map(l => l.replace(/^-\s*/, '').trim()).slice(0, 3);
          }
          handoffs.push({
            agent: parts[0] || titleLine,
            timestamp: parts[1] || '',
            title: parts[2] || '',
            blocker: blockerMatch ? blockerMatch[1].trim() : null,
            nextSteps,
          });
        }
      }
    } catch {}
  }

  // Calendar (Google Calendar synced via Apple Calendar / EventKit)
  let calEvents = [];
  let calFetched = null;
  try {
    const calRaw = run(`${__dirname}/cal-events 7 2>/dev/null`, 5000);
    if (calRaw && calRaw.startsWith('{')) {
      const calData = JSON.parse(calRaw);
      calEvents = (calData.events || []).map(e => ({
        title: e.title,
        start: e.start,
        end: e.end,
        calendar: e.calendar,
        allDay: e.allDay,
        location: e.location,
      }));
      calFetched = calData.fetched;
    }
  } catch {}

  // Prompt store stats
  const promptStats = run('node ~/.claude/prompt-store.js stats 2>/dev/null');
  const promptTotal = (promptStats.match(/Total prompts:\s+(\d+)/) || [])[1] || '0';
  const promptSessions = (promptStats.match(/Sessions:\s+(\d+)/) || [])[1] || '0';

  // Token usage / wallet
  let wallet = { total_tokens: 0, cost: { total: 0 }, saved_by_cache: 0 };
  try {
    const usageJson = run('node ~/.claude/prompt-store.js usage 2>/dev/null', 10000);
    wallet = JSON.parse(usageJson);
  } catch {}

  return {
    timestamp: new Date().toISOString(),
    system: { diskUsage, uptime: uptime.replace(/.*up/, 'up'), volumes: volumes.split('\n') },
    downloads: { total: downloads, organized_folders: downloadsOrg, loose_files: downloadsLoose },
    memoryatlas: { total: atlasTotal, hours: atlasHours, transcribed: atlasTranscribed, published: atlasPublished },
    vault: { total_notes: obsidianFiles, home_updated: homeUpdated },
    calendar: { events: calEvents, fetched: calFetched },
    agents: { sessionLogs, protocolActive: protocolExists, apiLive, promptBrowserLive, contactVerifyLive, downloadDaemonLive, workers, handoffs, promptTotal, promptSessions, instances },
    wallet,
  };
}

// ─── Dependencies: what's blocked on Peretz and what it holds up ──────

function getDependencies() {
  const HOME_MD = path.join(VAULT, 'Dashboards/Home.md');
  const SESSION_LOGS = path.join(process.env.HOME, '.claude/session-logs');

  // Current Claude work from latest session log
  let currentWork = [];
  try {
    const logs = fs.readdirSync(SESSION_LOGS)
      .filter(f => f.endsWith('.md'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(SESSION_LOGS, f)).mtime }))
      .sort((a, b) => b.mtime - a.mtime);
    if (logs.length > 0) {
      const latest = fs.readFileSync(path.join(SESSION_LOGS, logs[0].name), 'utf8');
      const agentMatch = latest.match(/\*\*Instance\*\*:\s*(.+)/);
      const focusMatch = latest.match(/\*\*Focus\*\*:\s*(.+)/);
      const timelineMatch = latest.match(/## Timeline([\s\S]*?)(?=\n## |$)/);
      const agent = agentMatch ? agentMatch[1].trim() : 'Claude';
      const focus = focusMatch ? focusMatch[1].trim() : '';
      let recentActions = [];
      if (timelineMatch) {
        const lines = timelineMatch[1].split('\n').filter(l => l.trim().startsWith('-')).slice(-5);
        recentActions = lines.map(l => l.replace(/^-\s*/, '').trim());
      }
      currentWork.push({ agent, focus, recentActions, session: logs[0].name.replace('.md', '') });
    }
  } catch {}

  // Blockers from vault Home.md "Blocked (Need Your Action)"
  let blockers = [];
  try {
    const home = fs.readFileSync(HOME_MD, 'utf8');
    const blockedSection = home.match(/## Blocked \(Need Your Action\)([\s\S]*?)(?=\n## |$)/);
    if (blockedSection) {
      const rows = blockedSection[1].split('\n').filter(l => l.includes('|') && !l.includes('---'));
      for (const row of rows.slice(1)) { // skip header
        const cols = row.split('|').map(c => c.trim()).filter(Boolean);
        if (cols.length >= 2) {
          blockers.push({ item: cols[0], blocker: cols[1], unblocks: [] });
        }
      }
    }
  } catch {}

  // What each blocker unblocks (from Active Threads)
  const threads = getThreads();
  for (const blocker of blockers) {
    for (const thread of threads) {
      if (thread.status === 'done') continue;
      const desc = thread.desc.toLowerCase();
      const item = blocker.item.toLowerCase();
      // Match explicit dependencies
      if (desc.includes('needs ' + item) || desc.includes('blocked') && desc.includes(item)) {
        blocker.unblocks.push(thread.name);
      }
      // Match common patterns
      else if (
        (item.includes('elements') && desc.includes('elements')) ||
        (item.includes('time machine') && (desc.includes('backup') || desc.includes('time machine'))) ||
        (item.includes('linkedin') && desc.includes('linkedin')) ||
        (item.includes('google') && desc.includes('location'))
      ) {
        blocker.unblocks.push(thread.name);
      }
    }
  }

  return { currentWork, blockers, timestamp: new Date().toISOString() };
}

// ─── Threads: parse MEMORY.md Active Threads ─────────────────────────

function getThreads() {
  const MEMORY_PATH = path.join(process.env.HOME, '.claude/projects/-Users-peretz-1/memory/MEMORY.md');
  let threads = [];
  try {
    const content = fs.readFileSync(MEMORY_PATH, 'utf8');
    const section = content.match(/## Active Threads\n([\s\S]*?)(?=\n## |\n# |$)/);
    if (!section) return threads;
    const lines = section[1].split('\n').filter(l => l.trim().startsWith('-'));
    for (const line of lines) {
      const stripped = line.replace(/^-\s*/, '').trim();
      // Match: **Name** — description
      const match = stripped.match(/^\*\*([^*]+)\*\*\s*[—–-]+\s*(.*)/);
      if (!match) continue;
      const name = match[1].trim();
      const desc = match[2].trim();
      // Detect status from keywords — order matters (most specific first)
      let status = 'pending';
      const u = desc.toUpperCase();
      if (/\b(TOP PRIORITY|CRITICAL|URGENT)\b/.test(u)) status = 'critical';
      else if (/\b(IN PROGRESS|RUNNING|LIVE)\b/.test(u)) status = 'running';
      else if (/\bCOMPLETE\b/.test(u) || /^DONE[^A-Z]/.test(u) || /:\s*DONE\b/.test(u)) status = 'done';
      else if (/\b(BLOCKED|WAITING)\b/.test(u)) status = 'blocked';
      else if (/\bNEW\b|\bVISION\b/.test(u)) status = 'running';
      else if (/\bDONE\b/.test(u)) status = 'done';
      // Extract next action — text after last period or colon
      const nextMatch = desc.match(/[:.]\s*([^.]+)$/);
      const next = nextMatch ? nextMatch[1].trim() : '';
      threads.push({ name, desc, status, next });
    }
  } catch {}
  return threads;
}

// ─── History: time-series metric snapshots ───────────────────────────

function recordHistory(state) {
  try {
    // Rate limit: 1 snapshot per minute
    if (fs.existsSync(HISTORY_FILE)) {
      const stat = fs.statSync(HISTORY_FILE);
      if (Date.now() - stat.mtimeMs < 55000) return;
    }
    const done = TASKS.filter(t => t.status === 'done').length;
    const running = TASKS.filter(t => t.status === 'running').length;
    const blocked = TASKS.filter(t => t.status === 'blocked').length;
    const snapshot = {
      t: Date.now(),
      done, running, blocked,
      disk: parseInt(state.system.diskUsage) || 0,
      notes: parseInt(state.vault.total_notes) || 0,
      atlas: parseInt(state.memoryatlas.total) || 0,
      atlasHrs: parseFloat(state.memoryatlas.hours) || 0,
      transcribed: parseInt(state.memoryatlas.transcribed) || 0,
      downloads: parseInt(state.downloads.loose_files) || 0,
      prompts: parseInt(state.agents.promptTotal) || 0,
      sessions: parseInt(state.agents.promptSessions) || 0,
      tokens: state.wallet.total_tokens || 0,
      cost: state.wallet.cost ? state.wallet.cost.total : 0,
      cache: state.wallet.saved_by_cache || 0,
      workers: state.agents.workers.length,
      workersActive: state.agents.workers.filter(w => w.status.toLowerCase().includes('active')).length,
    };
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(snapshot) + '\n');
    // Trim if over max
    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n');
    if (lines.length > HISTORY_MAX) {
      fs.writeFileSync(HISTORY_FILE, lines.slice(-HISTORY_MAX).join('\n') + '\n');
    }
  } catch {}
}

function getHistory(limit = 200) {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// ─── Task Registry ───────────────────────────────────────────────────

const TASKS = [
  // === TOP PRIORITY ===
  { id: 0, name: 'SDI Disability Appeal', status: 'critical', icon: '🔴', detail: 'Appeal doc submission, late 2500A explanation, monitor portal' },
  // === BLOCKED ===
  { id: 4, name: 'LinkedIn MCP Server', status: 'blocked', icon: '🔒', blocker: 'Need manual LinkedIn login in browser' },
  { id: 10, name: 'Time Machine Backup', status: 'blocked', icon: '🔒', blocker: 'Elements drive — new cable arrived 02/08, plug in to retry' },
  { id: 11, name: 'User Account Merge', status: 'blocked', icon: '🔒', blocker: 'Needs Time Machine backup first' },
  // === RUNNING ===
  { id: 32, name: 'MemoryAtlas', status: 'running', icon: '🔄', detail: 'Phase 1 LIVE (929 notes). Whisper installed + base model cached. Phase 2: test transcription' },
  { id: 16, name: 'Life Dashboard', status: 'running', icon: '🔄', detail: 'You are looking at it' },
  { id: 26, name: 'Password Merge', status: 'running', icon: '🔄', detail: 'Chrome encrypted on SD4Loco → Apple Passwords' },
  { id: 22, name: 'Google Drive Organization', status: 'done', icon: '✅', detail: '2.6GB IB archive cataloged — 2,198 files across 5 dirs. Manifest at ~/Documents/GoogleDrive-IB/' },
  { id: 17, name: 'Living Resume', status: 'done', icon: '✅', detail: 'Master resume consolidated (12KB) + 66-file inventory. At vault Efforts/Active/Living Resume/' },
  { id: 13, name: 'Contact Dedup', status: 'done', icon: '✅', detail: '9,506→6,061 clean (email-as-name 99.5%, 716 vault notes, relationship health, VCF export)' },
  { id: 34, name: 'Codex ↔ Claude Collaboration', status: 'running', icon: '🔄', detail: 'Multi-agent protocol live, PracticeLife API on :3001' },
  { id: 35, name: 'PracticeLife API', status: 'running', icon: '🔄', detail: 'Atlas + Vault + System + Agents endpoints at :3001' },
  // === PENDING ===
  { id: 38, name: 'Google Calendar (Ground Truth)', status: 'running', icon: '🔄', detail: 'EventKit binary reads Apple Calendar (synced from Google). Live on dashboard.' },
  { id: 33, name: 'Google Takeout (Location History)', status: 'pending', icon: '⏳', detail: 'For MemoryAtlas Phase 4 location enrichment' },
  { id: 14, name: 'Apple Notes → Obsidian', status: 'done', icon: '✅', detail: '948 notes exported to vault Resources/Reference/Apple Notes/' },
  { id: 15, name: 'Roam → Obsidian', status: 'pending', icon: '⏳', detail: 'No data on this Mac — needs web export from roamresearch.com' },
  { id: 18, name: 'Calendar Backfill', status: 'done', icon: '✅', detail: '425 daily notes backfilled from ICS files into Journal/Daily/' },
  { id: 39, name: 'Personal Body Kit — Charging Lane', status: 'pending', icon: '⏳', detail: 'Apple Watch + Shokz always wired at permanent station. Never leave uncharged.' },
  { id: 40, name: 'Amazon Household — Sofia + Kevin', status: 'pending', icon: '⏳', detail: 'amazon.com/myh/manage — add Sofia + Kevin as adult members. Shared Prime, food orders, house.' },
  { id: 19, name: 'VPN Setup (Mullvad+Tailscale)', status: 'pending', icon: '⏳' },
  { id: 20, name: 'Mastra.ai Bootstrap', status: 'pending', icon: '⏳' },
  { id: 23, name: 'UniFi Network Hardening', status: 'pending', icon: '⏳' },
  { id: 24, name: 'Cross-Device Phase Lock', status: 'pending', icon: '⏳' },
  { id: 28, name: 'Notion → Obsidian Migration', status: 'pending', icon: '⏳', detail: 'No Notion export found — needs workspace export from notion.so' },
  { id: 29, name: 'Evernote → Obsidian Migration', status: 'pending', icon: '⏳', detail: 'Local cache has titles only — needs ENEX export from evernote.com' },
  { id: 30, name: 'OpenAI/ChatGPT API Integration', status: 'pending', icon: '⏳' },
  // === DONE ===
  { id: 25, name: 'Vault Restructure', status: 'done', icon: '✅', detail: 'ACE+PARA — 7 clean dirs, zero loose files' },
  { id: 36, name: 'Prompt Browser App', status: 'done', icon: '✅', detail: 'port 3002, browse/search/sessions/stats' },
  { id: 41, name: 'Contact Verification Web App', status: 'running', icon: '🔄', detail: 'Privacy-first verification interface on port 3003. Deploy to verify.peretzpartensky.com pending.' },
  { id: 42, name: 'Self-Organizing Downloads', status: 'running', icon: '🔄', detail: 'LaunchAgent daemon monitoring ~/Downloads/ with 14 routing rules via fswatch. Auto-routes by type+context.' },
  { id: 37, name: 'Terminal Spruce-up', status: 'done', icon: '✅', detail: 'Starship, MOTD, fzf themed, LaunchAgent' },
  { id: 1, name: 'Terminal Power Config', status: 'done', icon: '✅' },
  { id: 2, name: 'GitHub Dual-Account Setup', status: 'done', icon: '✅' },
  { id: 3, name: 'Obsidian Vault Restored', status: 'done', icon: '✅' },
  { id: 6, name: 'Downloads Organization', status: 'done', icon: '✅', detail: '336 files categorized 02/08, 38 UUID remain' },
  { id: 7, name: 'OpSec Protocol', status: 'done', icon: '✅' },
  { id: 8, name: 'Browser Context Ingested', status: 'done', icon: '✅' },
  { id: 9, name: 'Mastra.ai Researched', status: 'done', icon: '✅' },
  { id: 12, name: 'Chrome Passwords Encrypted', status: 'done', icon: '✅', detail: 'AES-256, plaintext destroyed 02/06' },
  { id: 21, name: 'Email Archives → Thunderbird', status: 'done', icon: '✅', detail: '14GB imported 02/07' },
  { id: 27, name: 'Thunderbird Config', status: 'done', icon: '✅', detail: 'Validated + dedup addon installed 02/08' },
  { id: 31, name: 'Ollama Models Pulled', status: 'done', icon: '✅', detail: 'llama3.3:70b, qwen2.5:32b, codellama:34b, nomic-embed' },
];

// ─── Rendering ───────────────────────────────────────────────────────

function workerDotClass(status) {
  const s = (status || '').toLowerCase();
  if (s.includes('active')) return 'live';
  if (s.includes('parked')) return 'parked';
  if (s.includes('standby')) return 'standby';
  if (s.includes('down') || s.includes('error')) return 'down';
  return 'off';
}

function workerStatusColor(dotCls) {
  if (dotCls === 'live') return '#00ff88';
  if (dotCls === 'parked') return '#ffaa00';
  if (dotCls === 'down') return '#ff4444';
  return '#555';
}

// ─── Shared Navigation Bar ──────────────────────────────────────────────────

function renderNav(activePage = 'dashboard') {
  const pages = [
    { path: '/', name: 'Dashboard', key: 'dashboard' },
    { path: '/blockers', name: '🚧 Blockers', key: 'blockers' },
    { path: '/agents', name: 'Agents', key: 'agents' },
    { path: '/endpoints', name: 'API', key: 'endpoints' },
    { path: '/deps', name: 'Dependencies', key: 'deps' },
    { path: '/plan', name: 'Plan Tracker', key: 'plan' },
    { path: '/stream', name: 'Life Stream', key: 'stream' },
    { path: '/threads', name: 'Threads', key: 'threads' },
    { path: '/prompts', name: '🚀 Prompts', key: 'prompts' },
    { path: '/search', name: '🔍 Search', key: 'search' },
    { path: '/cheatsheet', name: '📋 Cheatsheet', key: 'cheatsheet' },
  ];

  return `<div class="nav" style="display:flex;gap:16px;margin-bottom:12px">\n` +
    pages.map(p => {
      const isActive = p.key === activePage;
      const color = isActive ? '#00ff88' : '#555';
      const border = isActive ? '#00ff88' : '#222';
      return `  <a href="${p.path}" style="color:${color};font-size:13px;padding:4px 12px;border:1px solid ${border};border-radius:6px;text-decoration:none">${p.name}</a>`;
    }).join('\n') +
    '\n</div>';
}

function renderHTML(state) {
  const done = TASKS.filter(t => t.status === 'done').length;
  const running = TASKS.filter(t => t.status === 'running').length;
  const blocked = TASKS.filter(t => t.status === 'blocked').length;
  const critical = TASKS.filter(t => t.status === 'critical').length;
  const pending = TASKS.filter(t => t.status === 'pending').length;
  const pct = Math.round((done / TASKS.length) * 100);

  const taskRows = TASKS.map(t => {
    const cls = t.status;
    const extra = t.blocker ? `<span class="blocker">BLOCKED: ${t.blocker}</span>` : (t.detail || '');
    return `<tr class="${cls}"><td>${t.icon}</td><td>${t.name}</td><td class="status-${cls}">${t.status.toUpperCase()}</td><td>${extra}</td></tr>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>Ω₀ PracticeLife Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0a0a0a; color: #e0e0e0; font-family: 'SF Mono', 'Fira Code', monospace; padding: 20px; }
  h1 { color: #00ff88; font-size: 28px; margin-bottom: 4px; }
  .subtitle { color: #666; margin-bottom: 20px; font-size: 13px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card { background: #151515; border: 1px solid #222; border-radius: 8px; padding: 16px; transition: border-color 0.3s, box-shadow 0.3s, transform 0.15s; }
  .card.clickable { cursor: pointer; }
  .card.clickable:hover { border-color: #00ff88; box-shadow: 0 0 16px #00ff8818; transform: translateY(-1px); }
  .card.clickable.active { border-color: #00ff88; box-shadow: 0 0 20px #00ff8822; }
  .card h3 { color: #888; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
  .card .value { font-size: 32px; font-weight: bold; color: #00ff88; }
  .card .value.warn { color: #ffaa00; }
  .card .value.crit { color: #ff4444; }
  .card .sub { color: #555; font-size: 12px; margin-top: 4px; }
  .progress-bar { width: 100%; height: 24px; background: #1a1a1a; border-radius: 12px; overflow: hidden; margin: 16px 0; border: 1px solid #333; }
  .progress-fill { height: 100%; background: linear-gradient(90deg, #00ff88, #00cc66); transition: width 0.8s ease; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: bold; color: #000; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; }
  th { text-align: left; color: #555; font-size: 11px; text-transform: uppercase; padding: 8px; border-bottom: 1px solid #222; }
  td { padding: 8px; border-bottom: 1px solid #151515; font-size: 13px; }
  tr.done td { opacity: 0.5; }
  .status-done { color: #00ff88; }
  .status-running { color: #00aaff; }
  .status-blocked { color: #ffaa00; }
  .status-critical { color: #ff4444; font-weight: bold; }
  .status-pending { color: #555; }
  .blocker { color: #ffaa00; font-size: 12px; }
  .volumes { display: flex; gap: 8px; flex-wrap: wrap; }
  .vol { background: #1a2a1a; color: #00ff88; padding: 4px 10px; border-radius: 4px; font-size: 12px; border: 1px solid #00ff8833; }
  .vol.missing { background: #2a1a1a; color: #ff4444; border-color: #ff444433; }
  .section { margin-top: 24px; }
  .section h2 { color: #00ff88; font-size: 16px; margin-bottom: 12px; border-bottom: 1px solid #222; padding-bottom: 8px; }
  .alignment { text-align: center; margin: 24px 0; padding: 20px; background: linear-gradient(135deg, #0a1a0a, #0a0a1a); border: 1px solid #00ff8833; border-radius: 12px; }
  .alignment .omega { font-size: 48px; color: #00ff88; animation: breathe 4s ease-in-out infinite; }
  .alignment .phrase { color: #00cc66; font-size: 14px; margin-top: 8px; }
  .timestamp { color: #333; font-size: 11px; text-align: right; margin-top: 16px; }
  .agent-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin-top: 12px; }
  .agent-card { background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 14px; }
  .agent-card h4 { color: #c9d1d9; font-size: 13px; margin-bottom: 8px; }
  .agent-card .agent-status { display: flex; align-items: center; gap: 6px; font-size: 12px; }
  .agent-card .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }

  /* Stoplight dot states */
  .dot.live { background: #00ff88; box-shadow: 0 0 6px #00ff88, 0 0 12px #00ff8844; animation: pulse 2s ease-in-out infinite; }
  .dot.parked { background: #ffaa00; box-shadow: 0 0 4px #ffaa00, 0 0 8px #ffaa0044; animation: pulse-slow 3s ease-in-out infinite; }
  .dot.standby { background: #555; box-shadow: 0 0 2px #55555588; }
  .dot.off { background: #333; }
  .dot.down { background: #ff4444; box-shadow: 0 0 6px #ff4444, 0 0 12px #ff444444; animation: pulse-fast 1s ease-in-out infinite; }

  @keyframes pulse { 0%, 100% { opacity: 1; box-shadow: 0 0 6px #00ff88, 0 0 12px #00ff8844; } 50% { opacity: 0.6; box-shadow: 0 0 2px #00ff8844; } }
  @keyframes pulse-slow { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
  @keyframes pulse-fast { 0%, 100% { opacity: 1; box-shadow: 0 0 8px #ff4444; } 50% { opacity: 0.4; box-shadow: 0 0 2px #ff444444; } }
  @keyframes breathe { 0%, 100% { opacity: 1; text-shadow: 0 0 20px #00ff8844; } 50% { opacity: 0.7; text-shadow: 0 0 40px #00ff8866; } }

  .session-list { list-style: none; margin-top: 8px; }
  .session-list li { color: #8b949e; font-size: 11px; padding: 2px 0; border-bottom: 1px solid #161b22; }
  .session-list li:last-child { border: none; }

  /* Chart panel */
  .chart-panel { display: none; background: #0d1117; border: 1px solid #00ff8844; border-radius: 12px; padding: 24px; margin: 0 0 24px 0; animation: slideDown 0.25s ease-out; }
  .chart-panel.visible { display: block; }
  .chart-panel .chart-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
  .chart-panel .chart-title { color: #00ff88; font-size: 16px; font-weight: bold; }
  .chart-panel .chart-close { cursor: pointer; color: #555; font-size: 18px; padding: 4px 8px; border-radius: 4px; }
  .chart-panel .chart-close:hover { color: #ff4444; background: #1a1111; }
  .chart-panel .chart-stats { display: flex; gap: 24px; margin-bottom: 16px; flex-wrap: wrap; }
  .chart-panel .chart-stat { }
  .chart-panel .chart-stat-label { color: #555; font-size: 10px; text-transform: uppercase; letter-spacing: 1px; }
  .chart-panel .chart-stat-value { color: #e0e0e0; font-size: 20px; font-weight: bold; margin-top: 2px; }
  .chart-panel .chart-stat-value.up { color: #00ff88; }
  .chart-panel .chart-stat-value.down { color: #ff4444; }
  .chart-panel .chart-stat-value.flat { color: #555; }
  .chart-panel svg { width: 100%; height: 160px; }
  .chart-panel .sparkline { fill: none; stroke: #00ff88; stroke-width: 2; }
  .chart-panel .sparkfill { fill: url(#sparkGrad); stroke: none; opacity: 0.3; }
  .chart-panel .projection { fill: none; stroke: #00ff88; stroke-width: 1.5; stroke-dasharray: 6,4; opacity: 0.5; }
  .chart-panel .grid-line { stroke: #222; stroke-width: 0.5; }
  .chart-panel .axis-label { fill: #444; font-size: 10px; font-family: 'SF Mono', monospace; }
  .chart-panel .data-dot { fill: #00ff88; r: 3; opacity: 0; transition: opacity 0.15s; }
  .chart-panel svg:hover .data-dot { opacity: 1; }

  @keyframes slideDown { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }

  /* Live indicator */
  .live-indicator { display: inline-flex; align-items: center; gap: 6px; color: #555; font-size: 11px; }
  .live-indicator .dot { width: 6px; height: 6px; }
</style>
</head><body>

${renderNav('dashboard')}

<h1>Ω₀ PracticeLife OS</h1>
<div class="subtitle">Alpha Omega — Iterate, Don't Annihilate <span class="live-indicator" style="margin-left:12px"><span class="dot live"></span> <span id="live-ago">live</span></span></div>

<div class="alignment">
  <div class="omega">Ω₀</div>
  <div class="phrase">Phase-locked. Aligned. Building together.</div>
</div>

<div class="grid" id="mission-grid">
  <div class="card clickable" data-metric="done" data-label="Mission Progress">
    <h3>Mission Progress</h3>
    <div class="value" id="v-progress">${pct}%</div>
    <div class="sub" id="s-progress">${done}/${TASKS.length} complete</div>
  </div>
  <div class="card clickable" data-metric="running" data-label="Active Tasks">
    <h3>Active Now</h3>
    <div class="value" style="color:#00aaff" id="v-running">${running}</div>
    <div class="sub">tasks running</div>
  </div>
  <div class="card clickable" data-metric="blocked" data-label="Blocked Tasks">
    <h3>Blocked (You)</h3>
    <div class="value ${blocked > 0 ? 'warn' : ''}" id="v-blocked">${blocked}</div>
    <div class="sub">need your action</div>
  </div>
  <div class="card clickable" data-metric="cost" data-label="Cloud Spend">
    <h3>Critical</h3>
    <div class="value ${critical > 0 ? 'crit' : ''}" id="v-critical">${critical}</div>
    <div class="sub">security items</div>
  </div>
  <div class="card clickable" data-metric="disk" data-label="Disk Usage">
    <h3>Disk Used</h3>
    <div class="value" id="v-disk">${state.system.diskUsage}</div>
    <div class="sub">main drive</div>
  </div>
  <div class="card clickable" data-metric="notes" data-label="Vault Notes">
    <h3>Vault Notes</h3>
    <div class="value" id="v-notes">${state.vault.total_notes}</div>
    <div class="sub">Obsidian markdown</div>
  </div>
  <div class="card clickable" data-metric="atlas" data-label="MemoryAtlas">
    <h3>MemoryAtlas</h3>
    <div class="value" id="v-atlas">${state.memoryatlas.total}</div>
    <div class="sub">${state.memoryatlas.hours}h recorded / ${state.memoryatlas.transcribed} transcribed</div>
  </div>
  <div class="card clickable" data-metric="downloads" data-label="Downloads">
    <h3>Downloads</h3>
    <div class="value" id="v-downloads">${state.downloads.loose_files}</div>
    <div class="sub">loose files (${state.downloads.organized_folders} folders)</div>
  </div>
</div>

<div id="chart-panel" class="chart-panel"></div>

<div class="progress-bar"><div class="progress-fill" id="progress-fill" style="width:${pct}%">${pct}% ALIGNED</div></div>

<div class="section">
  <h2>Digital Vitals</h2>
  <div class="grid">
    <div class="card clickable" style="border-color:#00ff8833" data-metric="tokens" data-label="Total Tokens">
      <h3>Total Tokens</h3>
      <div class="value" id="v-tokens">${state.wallet.total_tokens ? (state.wallet.total_tokens / 1e6).toFixed(1) + 'M' : '—'}</div>
      <div class="sub">${state.wallet.input_tokens ? (state.wallet.input_tokens / 1e3).toFixed(0) + 'K in / ' + (state.wallet.output_tokens / 1e3).toFixed(0) + 'K out' : 'across all sessions'}</div>
    </div>
    <div class="card clickable" style="border-color:#ffaa0033" data-metric="cost" data-label="Cloud Spend">
      <h3>Cloud Spend</h3>
      <div class="value warn" id="v-cost">$${state.wallet.cost ? state.wallet.cost.total.toFixed(0) : '—'}</div>
      <div class="sub">Opus API · ${state.wallet.sessions || 0} sessions</div>
    </div>
    <div class="card clickable" style="border-color:#00aaff33" data-metric="cache" data-label="Cache Savings">
      <h3>Cache Savings</h3>
      <div class="value" style="color:#00aaff" id="v-cache">$${state.wallet.saved_by_cache ? state.wallet.saved_by_cache.toFixed(0) : '—'}</div>
      <div class="sub">${state.wallet.cache_read_tokens ? (state.wallet.cache_read_tokens / 1e6).toFixed(0) + 'M tokens cached' : 'prompt caching'}</div>
    </div>
    <div class="card clickable" data-metric="disk" data-label="Disk Usage">
      <h3>Disk</h3>
      <div class="value">${state.system.diskUsage}</div>
      <div class="sub">main drive</div>
    </div>
    <div class="card clickable" data-metric="prompts" data-label="Prompts">
      <h3>Prompts</h3>
      <div class="value" id="v-prompts">${state.agents.promptTotal}</div>
      <div class="sub">${state.agents.promptSessions} sessions · <a href="https://localhost:3002" style="color:#00ff88;font-size:11px">browse →</a></div>
    </div>
    <div class="card clickable" data-metric="sessions" data-label="Sessions">
      <h3>Sessions</h3>
      <div class="value" id="v-sessions">${state.agents.promptSessions}</div>
      <div class="sub">Claude conversations</div>
    </div>
  </div>
</div>

<div class="section">
  <h2>Connected Drives</h2>
  <div class="volumes">
    ${state.system.volumes.map(v => `<div class="vol">${v}</div>`).join('')}
    ${state.system.volumes.includes('Elements') ? '' : '<div class="vol missing">⚠ Elements — NOT DETECTED</div>'}
  </div>
</div>

<div class="section">
  <h2>📅 Ground Truth Calendar <span style="color:#555;font-size:11px;font-weight:normal;margin-left:8px">Google Calendar · next 7 days · ${state.calendar.events.length} events</span></h2>
  ${state.calendar.events.length === 0 ? '<div style="color:#555;font-size:13px">No events found — calendar binary may need permissions. Run: <code style="color:#00ff88">~/life-dashboard/cal-events 7</code></div>' : ''}
  <table>
    <tr><th>When</th><th>Event</th><th>Calendar</th><th>Location</th></tr>
    ${state.calendar.events.map(e => {
      const d = new Date(e.start);
      const now = new Date();
      const isToday = d.toDateString() === now.toDateString();
      const isTomorrow = d.toDateString() === new Date(now.getTime() + 86400000).toDateString();
      const dayStr = isToday ? 'Today' : isTomorrow ? 'Tomorrow' : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      const timeStr = e.allDay ? 'All day' : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      const rowStyle = isToday ? 'background:#0a1a0a;' : '';
      return `<tr style="${rowStyle}">
        <td style="white-space:nowrap;color:${isToday ? '#00ff88' : '#888'}">${dayStr}<br><span style="color:#555;font-size:11px">${timeStr}</span></td>
        <td style="color:${isToday ? '#e0e0e0' : '#aaa'};font-weight:${isToday ? 'bold' : 'normal'}">${e.title}</td>
        <td style="color:#555;font-size:12px">${e.calendar}</td>
        <td style="color:#555;font-size:12px">${e.location || ''}</td>
      </tr>`;
    }).join('')}
  </table>
</div>

<div class="section">
  <h2>Agent Collaboration</h2>
  <div class="agent-grid">
    <div class="agent-card">
      <h4>Services</h4>
      <div class="agent-status"><span class="dot live"></span> <a href="https://localhost:3000" style="color:#e0e0e0">Dashboard</a> <span style="color:#555">:3000</span></div>
      <div class="agent-status"><span class="dot ${state.agents.apiLive ? 'live' : 'down'}"></span> <a href="https://localhost:3001" style="color:#e0e0e0">PracticeLife API</a> <span style="color:#555">:3001</span></div>
      <div class="agent-status"><span class="dot ${state.agents.promptBrowserLive ? 'live' : 'down'}"></span> <a href="https://localhost:3002" style="color:#e0e0e0">Prompt Browser</a> <span style="color:#555">:3002</span></div>
      <div class="agent-status"><span class="dot ${state.agents.contactVerifyLive ? 'live' : 'down'}"></span> <a href="https://localhost:3003" style="color:#e0e0e0">Contact Verify</a> <span style="color:#555">:3003</span></div>
      <div class="agent-status"><span class="dot ${state.agents.downloadDaemonLive ? 'live' : 'down'}"></span> Download Daemon <span style="color:#555">(bg)</span></div>
      <div class="agent-status"><span class="dot ${state.agents.protocolActive ? 'live' : 'off'}"></span> Agent Protocol</div>
      <div style="margin-top:8px;color:#555;font-size:11px">${state.agents.promptTotal} prompts · ${state.agents.promptSessions} sessions</div>
    </div>
    <div class="agent-card" style="grid-column: span 2">
      <h4>Workers</h4>
      <table style="width:100%;margin-top:4px">
        <tr>
          <th style="text-align:left;color:#444;font-size:10px;padding:4px 8px">AGENT</th>
          <th style="text-align:left;color:#444;font-size:10px;padding:4px 8px">NAME</th>
          <th style="text-align:left;color:#444;font-size:10px;padding:4px 8px">MODEL</th>
          <th style="text-align:left;color:#444;font-size:10px;padding:4px 8px">STATUS</th>
          <th style="text-align:left;color:#444;font-size:10px;padding:4px 8px">FOCUS</th>
        </tr>
        ${state.agents.workers.map(w => {
          const dotCls = workerDotClass(w.status);
          const statusClr = workerStatusColor(dotCls);
          return `<tr>
            <td style="padding:4px 8px;font-size:12px"><span class="dot ${dotCls}" style="display:inline-block;margin-right:6px"></span>${w.agent}</td>
            <td style="padding:4px 8px;font-size:12px;color:#c9d1d9;font-weight:bold">${w.name}</td>
            <td style="padding:4px 8px;font-size:11px;color:#888">${w.model}</td>
            <td style="padding:4px 8px;font-size:11px;color:${statusClr};font-weight:bold">${w.status}</td>
            <td style="padding:4px 8px;font-size:11px;color:#aaa">${w.focus}</td>
          </tr>`;
        }).join('')}
        ${state.agents.workers.length === 0 ? '<tr><td colspan="5" style="padding:4px 8px;color:#444;font-size:11px">No workers registered in protocol</td></tr>' : ''}
      </table>
    </div>
  </div>
  <div class="agent-grid" style="margin-top:12px">
    <div class="agent-card" style="grid-column: span 2">
      <h4>Latest Handoffs</h4>
      ${state.agents.handoffs.map(h => `
        <div style="border-bottom:1px solid #161b22;padding:8px 0;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="color:#00aaff;font-size:12px;font-weight:bold">${h.agent}</span>
            <span style="color:#444;font-size:10px">${h.timestamp}</span>
          </div>
          <div style="color:#999;font-size:11px;margin-top:2px">${h.title}</div>
          ${h.nextSteps.length ? `<div style="margin-top:4px">${h.nextSteps.map(s => `<div style="color:#888;font-size:11px;padding-left:12px">→ ${s}</div>`).join('')}</div>` : ''}
          ${h.blocker && !h.blocker.toLowerCase().includes('none') ? `<div style="color:#ffaa00;font-size:11px;margin-top:4px">⚠ ${h.blocker}</div>` : ''}
        </div>
      `).join('')}
      ${state.agents.handoffs.length === 0 ? '<div style="color:#444;font-size:11px">No handoffs recorded yet</div>' : ''}
    </div>
    <div class="agent-card">
      <h4>Recent Sessions</h4>
      <ul class="session-list">
        ${state.agents.sessionLogs.map(s => `<li>${s.name}</li>`).join('')}
        ${state.agents.sessionLogs.length === 0 ? '<li>No session logs yet</li>' : ''}
      </ul>
    </div>
  </div>
</div>

<div class="section">
  <h2>Instance History</h2>
  <div style="font-size:11px;color:#555;margin-bottom:12px">${state.agents.instances.length} sessions recorded · ${state.agents.promptTotal} prompts indexed</div>
  <table>
    <tr><th></th><th>Session</th><th>Model</th><th>Date</th><th>Focus / Pending</th></tr>
    ${state.agents.instances.map((inst, i) => {
      const isLatest = i === 0;
      const statusDot = isLatest ? '<span class="dot live" style="display:inline-block;margin-right:4px"></span>' : '<span class="dot off" style="display:inline-block;margin-right:4px"></span>';
      const statusLabel = isLatest ? 'LATEST' : 'PARKED';
      const pendingStr = inst.pending.length > 0
        ? inst.pending.map(p => '<div style="color:#888;font-size:10px;padding-left:8px">→ ' + p.slice(0, 60) + '</div>').join('')
        : '';
      return '<tr class="' + (isLatest ? 'running' : 'done') + '">' +
        '<td>' + statusDot + '</td>' +
        '<td><span style="color:' + (isLatest ? '#00ff88' : '#aaa') + ';font-size:12px">' + inst.name + '</span></td>' +
        '<td style="font-size:11px;color:#666">' + (inst.model || '—').replace('Claude Code CLI', 'CC').replace('Claude Opus 4.6 (', '').replace(')', '') + '</td>' +
        '<td style="font-size:11px;color:#555">' + inst.date + '</td>' +
        '<td><div style="font-size:11px;color:#999">' + (inst.focus || '—').slice(0, 60) + '</div>' + pendingStr + '</td>' +
        '</tr>';
    }).join('')}
  </table>
</div>

<div class="section">
  <h2>All Tasks</h2>
  <table>
    <tr><th></th><th>Task</th><th>Status</th><th>Detail</th></tr>
    ${taskRows}
  </table>
</div>

<div class="timestamp" id="footer-ts">Last refresh: ${state.timestamp} · <span id="refresh-countdown">15</span>s · Home: ${state.vault.home_updated}</div>

<script>
(function() {
  // ─── State ────────────────────────────────────────────────
  let lastRefresh = Date.now();
  let historyData = null;
  let activeMetric = null;

  // ─── Live refresh countdown ───────────────────────────────
  const countdownEl = document.getElementById('refresh-countdown');
  const agoEl = document.getElementById('live-ago');
  setInterval(() => {
    const elapsed = Math.floor((Date.now() - lastRefresh) / 1000);
    const remaining = Math.max(0, 15 - elapsed);
    if (countdownEl) countdownEl.textContent = remaining;
    if (agoEl) agoEl.textContent = elapsed < 5 ? 'live' : elapsed + 's ago';
  }, 1000);

  // ─── Auto-refresh via fetch ───────────────────────────────
  async function refresh() {
    try {
      const res = await fetch('/api/state');
      const state = await res.json();
      lastRefresh = Date.now();

      // Update values in-place (no full page reload)
      const u = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
      const tasks = ${JSON.stringify({ total: TASKS.length })};
      const doneCount = state.agents?.instances?.length || 0; // approximate

      // Wallet
      if (state.wallet) {
        u('v-tokens', state.wallet.total_tokens ? (state.wallet.total_tokens / 1e6).toFixed(1) + 'M' : '—');
        u('v-cost', '$' + (state.wallet.cost ? state.wallet.cost.total.toFixed(0) : '—'));
        u('v-cache', '$' + (state.wallet.saved_by_cache ? state.wallet.saved_by_cache.toFixed(0) : '—'));
      }
      // Agents
      u('v-prompts', state.agents?.promptTotal || '—');
      u('v-sessions', state.agents?.promptSessions || '—');
      // Vault
      u('v-notes', state.vault?.total_notes || '—');
      u('v-atlas', state.memoryatlas?.total || '—');
      u('v-downloads', state.downloads?.loose_files || '—');
      u('v-disk', state.system?.diskUsage || '—');
    } catch (e) {
      console.error('Refresh failed:', e);
    }
  }
  setInterval(refresh, 15000);

  // ─── Fetch history data ───────────────────────────────────
  async function loadHistory() {
    try {
      const res = await fetch('/api/history');
      historyData = await res.json();
    } catch { historyData = []; }
  }
  loadHistory();

  // ─── Sparkline chart rendering ────────────────────────────
  function renderChart(metric, label) {
    const panel = document.getElementById('chart-panel');
    if (!historyData || historyData.length < 2) {
      panel.innerHTML = '<div style="color:#555;padding:20px;text-align:center">Not enough history yet. Data points are recorded every minute — check back soon.</div>';
      panel.classList.add('visible');
      return;
    }

    const values = historyData.map(d => d[metric] ?? 0);
    const times = historyData.map(d => d.t);
    const current = values[values.length - 1];
    const first = values[0];
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const change = current - first;
    const changePct = first !== 0 ? ((change / first) * 100).toFixed(1) : '—';
    const trend = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
    const trendArrow = change > 0 ? '↑' : change < 0 ? '↓' : '→';

    // SVG dimensions
    const W = 800, H = 140, PAD = 30;
    const plotW = W - PAD * 2, plotH = H - PAD;

    // Generate points
    const points = values.map((v, i) => {
      const x = PAD + (i / (values.length - 1)) * plotW;
      const y = H - PAD - ((v - min) / range) * plotH;
      return x.toFixed(1) + ',' + y.toFixed(1);
    });
    const polyline = points.join(' ');
    const fillPoints = [PAD + ',' + H, ...points, (PAD + plotW) + ',' + H].join(' ');

    // Grid lines (5 horizontal)
    let gridLines = '';
    for (let i = 0; i <= 4; i++) {
      const y = H - PAD - (i / 4) * plotH;
      const val = (min + (i / 4) * range).toFixed(0);
      gridLines += '<line x1="' + PAD + '" y1="' + y.toFixed(1) + '" x2="' + (PAD + plotW) + '" y2="' + y.toFixed(1) + '" class="grid-line"/>';
      gridLines += '<text x="' + (PAD - 4) + '" y="' + (y + 3).toFixed(1) + '" class="axis-label" text-anchor="end">' + val + '</text>';
    }

    // Time labels
    const firstTime = new Date(times[0]);
    const lastTime = new Date(times[times.length - 1]);
    const fmtTime = d => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    gridLines += '<text x="' + PAD + '" y="' + (H - 2) + '" class="axis-label">' + fmtTime(firstTime) + '</text>';
    gridLines += '<text x="' + (PAD + plotW) + '" y="' + (H - 2) + '" class="axis-label" text-anchor="end">' + fmtTime(lastTime) + '</text>';

    // Projection (linear extrapolation from last 20% of data)
    let projLine = '';
    const projN = Math.max(5, Math.floor(values.length * 0.2));
    const recent = values.slice(-projN);
    if (recent.length >= 2) {
      // Simple linear regression
      const n = recent.length;
      let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
      for (let i = 0; i < n; i++) { sumX += i; sumY += recent[i]; sumXY += i * recent[i]; sumX2 += i * i; }
      const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
      const intercept = (sumY - slope * sumX) / n;
      const projPoints = [];
      const projSteps = Math.floor(values.length * 0.25);
      for (let i = 0; i <= projSteps; i++) {
        const fi = n - 1 + i;
        const globalI = values.length - 1 + i;
        const v = intercept + slope * fi;
        const x = PAD + (globalI / (values.length - 1 + projSteps)) * plotW;
        const y = H - PAD - ((v - min) / range) * plotH;
        const clampedY = Math.max(0, Math.min(H, y));
        projPoints.push(x.toFixed(1) + ',' + clampedY.toFixed(1));
      }
      // Rescale original points for extended x-axis
      const totalLen = values.length + projSteps;
      const rescaledPoints = values.map((v, i) => {
        const x = PAD + (i / (totalLen - 1)) * plotW;
        const y = H - PAD - ((v - min) / range) * plotH;
        return x.toFixed(1) + ',' + y.toFixed(1);
      });
      projLine = '<polyline points="' + projPoints.join(' ') + '" class="projection"/>';
      // Use rescaled points for main line when projection is active
    }

    // Data dots (last 30 only to avoid clutter)
    let dots = '';
    const dotStart = Math.max(0, values.length - 30);
    for (let i = dotStart; i < values.length; i++) {
      const x = PAD + (i / (values.length - 1)) * plotW;
      const y = H - PAD - ((values[i] - min) / range) * plotH;
      dots += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" class="data-dot"/>';
    }

    panel.innerHTML = \`
      <div class="chart-header">
        <span class="chart-title">\${label}</span>
        <span class="chart-close" onclick="closeChart()">✕</span>
      </div>
      <div class="chart-stats">
        <div class="chart-stat">
          <div class="chart-stat-label">Current</div>
          <div class="chart-stat-value">\${typeof current === 'number' ? current.toLocaleString() : current}</div>
        </div>
        <div class="chart-stat">
          <div class="chart-stat-label">Change</div>
          <div class="chart-stat-value \${trend}">\${trendArrow} \${Math.abs(change).toLocaleString()} (\${changePct}%)</div>
        </div>
        <div class="chart-stat">
          <div class="chart-stat-label">Min</div>
          <div class="chart-stat-value">\${min.toLocaleString()}</div>
        </div>
        <div class="chart-stat">
          <div class="chart-stat-label">Max</div>
          <div class="chart-stat-value">\${max.toLocaleString()}</div>
        </div>
        <div class="chart-stat">
          <div class="chart-stat-label">Data Points</div>
          <div class="chart-stat-value flat">\${values.length}</div>
        </div>
      </div>
      <svg viewBox="0 0 \${W} \${H}" preserveAspectRatio="none">
        <defs>
          <linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#00ff88" stop-opacity="0.3"/>
            <stop offset="100%" stop-color="#00ff88" stop-opacity="0"/>
          </linearGradient>
        </defs>
        \${gridLines}
        <polygon points="\${fillPoints}" class="sparkfill"/>
        <polyline points="\${polyline}" class="sparkline"/>
        \${projLine}
        \${dots}
      </svg>
    \`;
    panel.classList.add('visible');
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  window.closeChart = function() {
    const panel = document.getElementById('chart-panel');
    panel.classList.remove('visible');
    document.querySelectorAll('.card.clickable.active').forEach(c => c.classList.remove('active'));
    activeMetric = null;
  };

  // ─── Click handlers on metric cards ───────────────────────
  document.querySelectorAll('.card.clickable').forEach(card => {
    card.addEventListener('click', (e) => {
      e.preventDefault();
      // Don't intercept link clicks
      if (e.target.tagName === 'A') return;

      const metric = card.dataset.metric;
      const label = card.dataset.label || metric;

      if (activeMetric === metric) {
        closeChart();
        return;
      }

      document.querySelectorAll('.card.clickable.active').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      activeMetric = metric;
      renderChart(metric, label);
    });
  });
})();
</script>

</body></html>`;
}

// ─── Plan Execution Tracker ───────────────────────────────────────────

const PLAN_STATE_FILE = path.join(process.env.HOME, '.claude/plan-state.json');

function getPlanState() {
  try {
    if (!fs.existsSync(PLAN_STATE_FILE)) return null;
    return JSON.parse(fs.readFileSync(PLAN_STATE_FILE, 'utf8'));
  } catch { return null; }
}

function renderPlanHTML() {
  const plan = getPlanState();
  if (!plan) return renderNoPlanHTML();

  const waves = plan.waves || [];
  const blockers = plan.blockerTree || [];
  const log = (plan.activityLog || []).slice(-30).reverse();

  const doneWaves = waves.filter(w => w.status === 'done').length;
  const runningWaves = waves.filter(w => w.status === 'running').length;
  const wavePct = waves.length > 0 ? Math.round((doneWaves / waves.length) * 100) : 0;

  // Task progress from TASKS array
  const tasksDone = TASKS.filter(t => t.status === 'done').length;
  const tasksPct = Math.round((tasksDone / TASKS.length) * 100);

  const waveRows = waves.map(w => {
    const statusIcon = w.status === 'done' ? '<span style="color:#00ff88">DONE</span>'
      : w.status === 'running' ? '<span style="color:#00aaff;animation:pulse 2s infinite">RUNNING</span>'
      : '<span style="color:#555">PENDING</span>';
    const workerBadge = w.worker ? `<span style="background:#1a2a1a;color:#00ff88;padding:2px 6px;border-radius:3px;font-size:10px">${w.worker}</span>` : '';
    const duration = w.startedAt && w.completedAt
      ? `${Math.round((new Date(w.completedAt) - new Date(w.startedAt)) / 60000)}m`
      : w.startedAt ? `${Math.round((Date.now() - new Date(w.startedAt)) / 60000)}m...` : '';
    return `<tr style="border-bottom:1px solid #161b22">
      <td style="padding:10px 8px;font-size:24px;text-align:center;width:40px">${w.status === 'done' ? '&#x2705;' : w.status === 'running' ? '&#x1F525;' : '&#x23F3;'}</td>
      <td style="padding:10px 8px">
        <div style="color:#e0e0e0;font-size:14px;font-weight:bold">Wave ${w.id}: ${w.name}</div>
        <div style="color:#555;font-size:11px;margin-top:2px">${workerBadge} ${duration}</div>
      </td>
      <td style="padding:10px 8px;text-align:right">${statusIcon}</td>
    </tr>`;
  }).join('');

  const blockerRows = blockers.map(b => {
    const tierColor = b.tier === 1 ? '#ff4444' : b.tier === 2 ? '#ffaa00' : '#555';
    const statusIcon = b.status === 'done' ? '&#x2705;' : b.status === 'in_progress' ? '&#x1F3C3;' : '&#x23F3;';
    return `<tr style="border-bottom:1px solid #161b22">
      <td style="padding:8px;font-size:18px">${statusIcon}</td>
      <td style="padding:8px">
        <div style="color:#e0e0e0;font-size:13px">${b.action}</div>
        <div style="color:#555;font-size:11px">${b.unblocks.join(' → ')}</div>
      </td>
      <td style="padding:8px;text-align:right"><span style="background:${tierColor}22;color:${tierColor};padding:2px 8px;border-radius:3px;font-size:11px">T${b.tier} · ${b.time}</span></td>
    </tr>`;
  }).join('');

  const logRows = log.map(l => {
    const time = new Date(l.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const waveLabel = l.wave !== null && l.wave !== undefined ? `<span style="color:#00aaff;font-size:10px">W${l.wave}</span> ` : '';
    return `<div style="border-bottom:1px solid #0d1117;padding:6px 0;display:flex;gap:8px;align-items:baseline">
      <span style="color:#333;font-size:10px;min-width:65px">${time}</span>
      ${waveLabel}<span style="color:#999;font-size:12px">${l.action}</span>
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>Plan Tracker | PracticeLife</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0a0a0a; color: #e0e0e0; font-family: 'SF Mono', 'Fira Code', monospace; padding: 20px; }
  h1 { color: #00ff88; font-size: 24px; margin-bottom: 4px; }
  .subtitle { color: #666; margin-bottom: 20px; font-size: 13px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card { background: #151515; border: 1px solid #222; border-radius: 8px; padding: 16px; }
  .card h3 { color: #888; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
  .card .value { font-size: 32px; font-weight: bold; color: #00ff88; }
  .card .sub { color: #555; font-size: 12px; margin-top: 4px; }
  .progress-bar { width: 100%; height: 32px; background: #1a1a1a; border-radius: 16px; overflow: hidden; margin: 16px 0; border: 1px solid #333; position: relative; }
  .progress-fill { height: 100%; transition: width 0.8s ease; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: bold; color: #000; }
  .progress-target { position: absolute; top: 0; height: 100%; border-left: 2px dashed #ffaa00; }
  .section { margin-top: 24px; }
  .section h2 { color: #00ff88; font-size: 16px; margin-bottom: 12px; border-bottom: 1px solid #222; padding-bottom: 8px; }
  table { width: 100%; border-collapse: collapse; }
  .two-col { display: grid; grid-template-columns: 2fr 1fr; gap: 24px; }
  @media (max-width: 900px) { .two-col { grid-template-columns: 1fr; } }
  a { color: #00ff88; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .nav { display: flex; gap: 16px; margin-bottom: 20px; }
  .nav a { color: #555; font-size: 13px; padding: 4px 12px; border: 1px solid #222; border-radius: 6px; }
  .nav a:hover, .nav a.active { color: #00ff88; border-color: #00ff88; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
</style>
</head><body>

${renderNav('plan')}

<h1>${plan.planName || 'Execution Plan'}</h1>
<div class="subtitle">Started ${plan.startedAt ? new Date(plan.startedAt).toLocaleString() : 'unknown'} · Target: ${plan.targetPct || '??'}%</div>

<div class="grid">
  <div class="card">
    <h3>Wave Progress</h3>
    <div class="value">${doneWaves}/${waves.length}</div>
    <div class="sub">${runningWaves} running</div>
  </div>
  <div class="card">
    <h3>Mission Progress</h3>
    <div class="value">${tasksPct}%</div>
    <div class="sub">${tasksDone}/${TASKS.length} tasks done</div>
  </div>
  <div class="card">
    <h3>Target</h3>
    <div class="value" style="color:#ffaa00">${plan.targetPct || '??'}%</div>
    <div class="sub">${(plan.targetPct || 0) - tasksPct}% to go</div>
  </div>
  <div class="card">
    <h3>Blockers (You)</h3>
    <div class="value" style="color:#ff4444">${blockers.filter(b => b.status === 'pending').length}</div>
    <div class="sub">human actions needed</div>
  </div>
</div>

<div class="progress-bar">
  <div class="progress-fill" style="width:${tasksPct}%;background:linear-gradient(90deg, #00ff88, #00cc66)">${tasksPct}%</div>
  <div class="progress-target" style="left:${plan.targetPct || 0}%"><span style="position:absolute;top:-18px;left:-10px;color:#ffaa00;font-size:10px">${plan.targetPct}%</span></div>
</div>

<div class="two-col">
  <div>
    <div class="section">
      <h2>Execution Waves</h2>
      <table>${waveRows}</table>
    </div>

    <div class="section">
      <h2>Your Action Tree (Blockers)</h2>
      <div style="color:#555;font-size:11px;margin-bottom:8px">Do these to unblock more tasks. Ordered by impact.</div>
      <table>${blockerRows}</table>
    </div>
  </div>

  <div>
    <div class="section">
      <h2>Activity Feed</h2>
      <div style="background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:12px;max-height:600px;overflow-y:auto">
        ${logRows || '<div style="color:#444;font-size:11px">No activity yet</div>'}
      </div>
    </div>
  </div>
</div>

<div style="color:#333;font-size:11px;text-align:right;margin-top:16px">Auto-refreshes every 10s · <span id="ts">${new Date().toISOString()}</span></div>

<script>
setInterval(async () => {
  try { const r = await fetch('/plan'); const html = await r.text(); document.open(); document.write(html); document.close(); } catch {}
}, 10000);
</script>

</body></html>`;
}

function renderNoPlanHTML() {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Plan Tracker</title>
<style>body{background:#0a0a0a;color:#e0e0e0;font-family:'SF Mono',monospace;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column}
a{color:#00ff88}</style>
</head><body>
<h1 style="color:#555;font-size:48px">No Active Plan</h1>
<p style="color:#444;margin-top:12px">No plan-state.json found. <a href="/">Back to Dashboard</a></p>
</body></html>`;
}

// ─── Life Stream: Self-Assembling Personal Dashboard ──────────────────

const STREAM_MANIFEST = path.join(process.env.HOME, '.claude/stream-manifest.json');
const HOME = process.env.HOME;

function sqliteQuery(db, query) {
  const r = run(`sqlite3 "${db}" "${query}"`, 8000);
  return r === '—' ? null : r;
}

function sqliteCount(db, query) {
  const r = sqliteQuery(db, query);
  return r === null ? null : parseInt(r) || 0;
}

let _streamCache = null;
let _streamCacheTs = 0;

function probeAllStreams() {
  if (_streamCache && Date.now() - _streamCacheTs < 60000) return _streamCache;

  const streams = [];
  const log = [];
  const now = new Date().toISOString();

  // ─── iMessage ─────────────────────────────
  const msgDb = path.join(HOME, 'Library/Messages/chat.db');
  try {
    const total = sqliteCount(msgDb, 'SELECT COUNT(*) FROM message');
    const contacts = sqliteCount(msgDb, 'SELECT COUNT(DISTINCT handle_id) FROM message');
    const today = sqliteCount(msgDb, "SELECT COUNT(*) FROM message WHERE date/1000000000 > (strftime('%s','now') - 978307200 - 86400)");
    const week = sqliteCount(msgDb, "SELECT COUNT(*) FROM message WHERE date/1000000000 > (strftime('%s','now') - 978307200 - 604800)");
    if (total) {
      streams.push({
        id: 'imessage', domain: 'memory', valence: 'pulse', cadence: 'hourly',
        icon: '\u{1F4AC}', label: 'Messages',
        primary: total.toLocaleString(), secondary: `${(contacts || 0).toLocaleString()} people`,
        tertiary: `${today || 0} today \u00B7 ${week || 0} this week`,
        count: total, signal: total > 100000 ? 'strong' : total > 10000 ? 'medium' : 'weak',
      });
      log.push({ t: now, msg: `iMessage \u2014 ${total.toLocaleString()} messages across ${(contacts||0).toLocaleString()} contacts` });
    } else if (fs.existsSync(msgDb)) {
      log.push({ t: now, msg: `iMessage \u2014 database exists but not readable (grant Full Disk Access to node)` });
    }
  } catch(e) { log.push({ t: now, msg: `iMessage \u2014 ${e.message}` }); }

  // ─── Beeper ─────────────────────────────
  const beeperDb = path.join(HOME, 'Library/Application Support/BeeperTexts/index.db');
  try {
    const total = sqliteCount(beeperDb, 'SELECT COUNT(*) FROM mx_room_messages');
    const rooms = sqliteCount(beeperDb, 'SELECT COUNT(DISTINCT roomID) FROM mx_room_messages');
    const today = sqliteCount(beeperDb, `SELECT COUNT(*) FROM mx_room_messages WHERE timestamp > ${(Date.now() - 86400000)}`);
    const week = sqliteCount(beeperDb, `SELECT COUNT(*) FROM mx_room_messages WHERE timestamp > ${(Date.now() - 604800000)}`);
    if (total) {
      streams.push({
        id: 'beeper', domain: 'network', valence: 'pulse', cadence: 'hourly',
        icon: '\u{1F4E8}', label: 'Beeper',
        primary: total.toLocaleString(), secondary: `${(rooms || 0).toLocaleString()} conversations`,
        tertiary: `${today || 0} today \u00B7 ${week || 0} this week`,
        count: total, signal: total > 5000 ? 'strong' : total > 1000 ? 'medium' : 'weak',
      });
      log.push({ t: now, msg: `Beeper \u2014 ${total.toLocaleString()} messages across ${(rooms||0).toLocaleString()} conversations` });
    } else if (fs.existsSync(beeperDb)) {
      log.push({ t: now, msg: `Beeper \u2014 database exists but not readable` });
    }
  } catch(e) { log.push({ t: now, msg: `Beeper \u2014 ${e.message}` }); }

  // ─── Photos ─────────────────────────────
  const photosDb = path.join(HOME, 'Pictures/Photos Library.photoslibrary/database/Photos.sqlite');
  try {
    const total = sqliteCount(photosDb, 'SELECT COUNT(*) FROM ZASSET');
    if (total) {
      const videos = sqliteCount(photosDb, "SELECT COUNT(*) FROM ZASSET WHERE ZKIND = 1") || 0;
      const photos = total - videos;
      streams.push({
        id: 'photos', domain: 'memory', valence: 'growth', cadence: 'daily',
        icon: '\u{1F4F8}', label: 'Photos & Video',
        primary: total.toLocaleString(), secondary: `${photos.toLocaleString()} photos \u00B7 ${videos.toLocaleString()} videos`,
        count: total, signal: total > 100000 ? 'strong' : total > 10000 ? 'medium' : 'weak',
      });
      log.push({ t: now, msg: `Photos \u2014 ${total.toLocaleString()} assets in library` });
    }
  } catch(e) { log.push({ t: now, msg: `Photos \u2014 ${e.message.includes('locked') || e.message.includes('unable') ? 'database not accessible (privacy restriction or app lock)' : e.message}` }); }

  // ─── Safari ─────────────────────────────
  const safariDb = path.join(HOME, 'Library/Safari/History.db');
  try {
    const urls = sqliteCount(safariDb, 'SELECT COUNT(*) FROM history_items');
    const visits = sqliteCount(safariDb, 'SELECT COUNT(*) FROM history_visits');
    if (urls) {
      streams.push({
        id: 'safari', domain: 'orbit', valence: 'pulse', cadence: 'hourly',
        icon: '\u{1F310}', label: 'Safari',
        primary: (visits || 0).toLocaleString(), secondary: `${urls.toLocaleString()} unique URLs`,
        count: visits || 0, signal: (visits||0) > 10000 ? 'strong' : (visits||0) > 1000 ? 'medium' : 'weak',
      });
      log.push({ t: now, msg: `Safari \u2014 ${(visits||0).toLocaleString()} visits, ${urls.toLocaleString()} URLs` });
    } else if (fs.existsSync(safariDb)) {
      log.push({ t: now, msg: `Safari \u2014 database exists but not readable (Full Disk Access needed)` });
    }
  } catch(e) { log.push({ t: now, msg: `Safari \u2014 ${e.message}` }); }

  // ─── Apple Notes ─────────────────────────
  const notesDb = path.join(HOME, 'Library/Group Containers/group.com.apple.notes/NoteStore.sqlite');
  try {
    const total = sqliteCount(notesDb, "SELECT COUNT(*) FROM ZICCLOUDSYNCINGOBJECT WHERE ZTITLE IS NOT NULL");
    if (total) {
      const exported = parseInt(run(`ls "${VAULT}/Resources/Reference/Apple Notes/" 2>/dev/null | wc -l`)) || 0;
      streams.push({
        id: 'notes', domain: 'memory', valence: 'growth', cadence: 'daily',
        icon: '\u{1F4DD}', label: 'Apple Notes',
        primary: total.toLocaleString(), secondary: exported > 0 ? `${exported} exported to vault` : 'not yet exported',
        count: total, signal: total > 500 ? 'strong' : total > 100 ? 'medium' : 'weak',
      });
      log.push({ t: now, msg: `Apple Notes \u2014 ${total} in database, ${exported} exported` });
    } else if (fs.existsSync(notesDb)) {
      log.push({ t: now, msg: `Apple Notes \u2014 database exists but not readable (Full Disk Access needed)` });
    }
  } catch(e) { log.push({ t: now, msg: `Apple Notes \u2014 ${e.message}` }); }

  // ─── Apple Mail ─────────────────────────
  const mailDir = path.join(HOME, 'Library/Mail');
  try {
    const sizeRaw = run(`du -sh "${mailDir}" 2>/dev/null`);
    const size = sizeRaw !== '\u2014' ? sizeRaw.split('\t')[0] : null;
    if (size) {
      streams.push({
        id: 'mail', domain: 'network', valence: 'pulse', cadence: 'daily',
        icon: '\u{1F4E7}', label: 'Apple Mail',
        primary: size, secondary: 'on disk',
        count: parseFloat(size) || 0, signal: 'medium',
      });
      log.push({ t: now, msg: `Apple Mail \u2014 ${size} on disk` });
    }
  } catch(e) { log.push({ t: now, msg: `Mail \u2014 ${e.message}` }); }

  // ─── MemoryAtlas ────────────────────────
  try {
    const atlasStats = run(path.join(HOME, 'tools/memoryatlas/.venv/bin/atlas') + ' status 2>/dev/null', 8000);
    const total = parseInt((atlasStats.match(/Total assets:\s+(\d+)/) || [])[1]) || 0;
    const hours = parseFloat((atlasStats.match(/Total hours:\s+([\d.]+)/) || [])[1]) || 0;
    const transcribed = parseInt((atlasStats.match(/Transcribed:\s+(\d+)/) || [])[1]) || 0;
    if (total) {
      streams.push({
        id: 'memoryatlas', domain: 'memory', valence: 'growth', cadence: 'daily',
        icon: '\u{1F399}', label: 'Voice Memos',
        primary: total.toLocaleString(), secondary: `${hours.toFixed(1)}h recorded \u00B7 ${transcribed} transcribed`,
        count: total, signal: total > 500 ? 'strong' : total > 100 ? 'medium' : 'weak',
      });
      log.push({ t: now, msg: `MemoryAtlas \u2014 ${total} memos, ${hours.toFixed(1)}h, ${transcribed} transcribed` });
    }
  } catch(e) { log.push({ t: now, msg: `MemoryAtlas \u2014 ${e.message}` }); }

  // ─── Obsidian Vault ─────────────────────
  try {
    const noteCount = parseInt(run(`find "${VAULT}" -name "*.md" | wc -l`)) || 0;
    const dailyCount = parseInt(run(`ls "${VAULT}/Journal/Daily/" 2>/dev/null | wc -l`)) || 0;
    if (noteCount) {
      streams.push({
        id: 'vault', domain: 'mind', valence: 'growth', cadence: 'hourly',
        icon: '\u{1F4D3}', label: 'Obsidian Vault',
        primary: noteCount.toLocaleString(), secondary: `${dailyCount} daily notes \u00B7 ACE+PARA`,
        count: noteCount, signal: noteCount > 2000 ? 'strong' : noteCount > 500 ? 'medium' : 'weak',
      });
      log.push({ t: now, msg: `Vault \u2014 ${noteCount} files, ${dailyCount} daily notes` });
    }
  } catch(e) { log.push({ t: now, msg: `Vault \u2014 ${e.message}` }); }

  // ─── Claude Sessions ────────────────────
  try {
    const sessionDir = path.join(HOME, '.claude/session-logs');
    const sessionCount = fs.existsSync(sessionDir) ? fs.readdirSync(sessionDir).filter(f => f.endsWith('.md')).length : 0;
    const promptStats = run(`node ${HOME}/.claude/prompt-store.js stats 2>/dev/null`);
    const promptCount = parseInt((promptStats.match(/Total prompts:\s+(\d+)/) || [])[1]) || 0;
    const storeSessions = parseInt((promptStats.match(/Sessions:\s+(\d+)/) || [])[1]) || 0;
    streams.push({
      id: 'claude', domain: 'mind', valence: 'growth', cadence: 'minute',
      icon: '\u{1F9E0}', label: 'Claude Sessions',
      primary: promptCount.toLocaleString(), secondary: `${storeSessions || sessionCount} sessions \u00B7 ${sessionCount} logs`,
      count: promptCount, signal: promptCount > 200 ? 'strong' : promptCount > 50 ? 'medium' : 'weak',
    });
    log.push({ t: now, msg: `Claude \u2014 ${promptCount} prompts, ${storeSessions} sessions` });
  } catch(e) { log.push({ t: now, msg: `Claude \u2014 ${e.message}` }); }

  // ─── Git Repos ──────────────────────────
  try {
    const gitDirs = run(`find ${HOME} -maxdepth 2 -name ".git" -type d 2>/dev/null`, 5000).split('\n').filter(Boolean);
    let totalCommits = 0;
    const repoDetails = [];
    for (const gitDir of gitDirs.slice(0, 10)) {
      const repoPath = path.dirname(gitDir);
      const commits = parseInt(run(`git -C "${repoPath}" rev-list --count HEAD 2>/dev/null`)) || 0;
      totalCommits += commits;
      repoDetails.push(`${path.basename(repoPath)}:${commits}`);
    }
    if (gitDirs.length > 0) {
      streams.push({
        id: 'git', domain: 'mind', valence: 'growth', cadence: 'hourly',
        icon: '\u{1F4BB}', label: 'Git Repos',
        primary: totalCommits.toLocaleString(), secondary: `${gitDirs.length} repos`,
        tertiary: repoDetails.join(' \u00B7 '),
        count: totalCommits, signal: totalCommits > 100 ? 'strong' : totalCommits > 10 ? 'medium' : 'weak',
      });
      log.push({ t: now, msg: `Git \u2014 ${totalCommits} commits across ${gitDirs.length} repos` });
    }
  } catch(e) { log.push({ t: now, msg: `Git \u2014 ${e.message}` }); }

  // ─── Contacts ───────────────────────────
  try {
    const goldenPath = path.join(HOME, 'contacts-dedup/golden.csv');
    if (fs.existsSync(goldenPath)) {
      const lines = parseInt(run(`wc -l < "${goldenPath}"`)) || 0;
      const count = Math.max(0, lines - 1);
      streams.push({
        id: 'contacts', domain: 'network', valence: 'growth', cadence: 'weekly',
        icon: '\u{1F465}', label: 'Contacts',
        primary: count.toLocaleString(), secondary: 'golden records (deduplicated)',
        count: count, signal: count > 5000 ? 'strong' : count > 1000 ? 'medium' : 'weak',
      });
      log.push({ t: now, msg: `Contacts \u2014 ${count.toLocaleString()} golden records` });
    }
  } catch(e) { log.push({ t: now, msg: `Contacts \u2014 ${e.message}` }); }

  // ─── Calendar / Daily Notes ─────────────
  try {
    const dailyPath = path.join(VAULT, 'Journal/Daily');
    const count = parseInt(run(`ls "${dailyPath}" 2>/dev/null | wc -l`)) || 0;
    if (count > 0) {
      const oldest = run(`ls "${dailyPath}" 2>/dev/null | head -1`).replace('.md', '');
      const newest = run(`ls "${dailyPath}" 2>/dev/null | tail -1`).replace('.md', '');
      streams.push({
        id: 'calendar', domain: 'memory', valence: 'growth', cadence: 'daily',
        icon: '\u{1F4C5}', label: 'Daily Notes',
        primary: count.toLocaleString(), secondary: `${oldest} \u2192 ${newest}`,
        count: count, signal: count > 365 ? 'strong' : count > 100 ? 'medium' : 'weak',
      });
      log.push({ t: now, msg: `Calendar \u2014 ${count} daily notes (${oldest} to ${newest})` });
    }
  } catch(e) { log.push({ t: now, msg: `Calendar \u2014 ${e.message}` }); }

  // ─── Shell History ──────────────────────
  try {
    const histPath = path.join(HOME, '.zsh_history');
    const lines = parseInt(run(`wc -l < "${histPath}" 2>/dev/null`)) || 0;
    if (lines > 0) {
      streams.push({
        id: 'shell', domain: 'orbit', valence: 'pulse', cadence: 'minute',
        icon: '\u2328\uFE0F', label: 'Shell History',
        primary: lines.toLocaleString(), secondary: 'commands',
        count: lines, signal: lines > 10000 ? 'strong' : lines > 100 ? 'medium' : 'weak',
      });
      log.push({ t: now, msg: `Shell \u2014 ${lines} commands` });
    }
  } catch(e) { log.push({ t: now, msg: `Shell \u2014 ${e.message}` }); }

  // ─── Downloads ──────────────────────────
  try {
    const loose = parseInt(run(`find ${HOME}/Downloads -maxdepth 1 -type f 2>/dev/null | wc -l`)) || 0;
    const dirs = parseInt(run(`find ${HOME}/Downloads -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l`)) || 0;
    streams.push({
      id: 'downloads', domain: 'orbit', valence: 'decay', cadence: 'hourly',
      icon: '\u{1F4E5}', label: 'Downloads',
      primary: loose.toLocaleString(), secondary: `loose files \u00B7 ${dirs} folders`,
      count: loose, signal: 'medium',
    });
    log.push({ t: now, msg: `Downloads \u2014 ${loose} loose, ${dirs} folders` });
  } catch(e) { log.push({ t: now, msg: `Downloads \u2014 ${e.message}` }); }

  // ─── Health ─────────────────────────────
  try {
    const healthDir = path.join(HOME, 'Downloads/HealthSummary_Jan_30_2026');
    const medDir = path.join(HOME, 'Downloads/Medical-Health');
    const healthExists = fs.existsSync(healthDir);
    const medExists = fs.existsSync(medDir);
    if (healthExists || medExists) {
      const items = [];
      if (healthExists) items.push('Health Summary (Jan 2026)');
      if (medExists) items.push('Medical records');
      streams.push({
        id: 'health', domain: 'body', valence: 'care', cadence: 'weekly',
        icon: '\u2764\uFE0F', label: 'Health Data',
        primary: items.length.toString(), secondary: items.join(' \u00B7 '),
        tertiary: 'Export Apple Health from iPhone for full biometrics',
        count: items.length, signal: 'weak',
      });
      log.push({ t: now, msg: `Health \u2014 ${items.join(', ')}` });
    }
  } catch(e) { log.push({ t: now, msg: `Health \u2014 ${e.message}` }); }

  // ─── System ─────────────────────────────
  try {
    const disk = run("df -h / | tail -1 | awk '{print $5}'");
    const upRaw = run('uptime');
    const up = upRaw.replace(/.*up\s+/, 'up ').replace(/,\s*\d+ users?.*/, '').trim();
    streams.push({
      id: 'system', domain: 'orbit', valence: 'pulse', cadence: 'realtime',
      icon: '\u{1F4BD}', label: 'System',
      primary: disk, secondary: up,
      count: parseInt(disk) || 0, signal: 'strong',
    });
  } catch {}

  // ─── Assemble result ───────────────────
  const byDomain = {};
  const byValence = {};
  const signalValues = { strong: 3, medium: 2, weak: 1 };
  let signalSum = 0, signalMax = 0;
  for (const s of streams) {
    byDomain[s.domain] = (byDomain[s.domain] || 0) + 1;
    byValence[s.valence] = (byValence[s.valence] || 0) + 1;
    signalSum += signalValues[s.signal] || 0;
    signalMax += 3;
  }

  const result = {
    streams, log, probedAt: now,
    summary: {
      total: streams.length, byDomain, byValence,
      signalStrength: signalMax > 0 ? Math.round((signalSum / signalMax) * 100) : 0,
    },
  };

  _streamCache = result;
  _streamCacheTs = Date.now();
  saveStreamManifest(result);
  return result;
}

function loadStreamManifest() {
  try {
    if (fs.existsSync(STREAM_MANIFEST)) return JSON.parse(fs.readFileSync(STREAM_MANIFEST, 'utf8'));
  } catch {}
  return null;
}

function saveStreamManifest(probe) {
  try {
    const m = loadStreamManifest() || { version: 1, firstProbe: probe.probedAt, probeCount: 0, streams: {}, evolution: [] };
    m.lastProbe = probe.probedAt;
    m.probeCount = (m.probeCount || 0) + 1;

    const newStreams = [];
    for (const s of probe.streams) {
      if (!m.streams[s.id]) {
        m.streams[s.id] = { discovered: probe.probedAt, firstCount: s.count };
        newStreams.push(s.label);
      }
      m.streams[s.id].latestCount = s.count;
      m.streams[s.id].lastSeen = probe.probedAt;
    }

    if (newStreams.length > 0 && m.probeCount > 1) {
      m.evolution.push({ t: probe.probedAt, event: 'discovery', note: `New: ${newStreams.join(', ')}` });
    } else if (m.probeCount === 1) {
      m.evolution.push({ t: probe.probedAt, event: 'genesis', note: `First probe. ${probe.streams.length} streams discovered.` });
    }
    if (m.evolution.length > 100) m.evolution = m.evolution.slice(-100);

    fs.writeFileSync(STREAM_MANIFEST, JSON.stringify(m, null, 2));
  } catch {}
}

function renderStreamHTML() {
  const data = probeAllStreams();
  const manifest = loadStreamManifest();
  const { streams, log, summary } = data;

  // Domain definitions
  const domainDefs = {
    memory: { label: 'Memory', sub: 'Your accumulated life record', color: '#00ff88', icon: '\u{1F9EC}' },
    mind:   { label: 'Mind', sub: 'Knowledge and creative output', color: '#00aaff', icon: '\u{1F52E}' },
    network:{ label: 'Network', sub: 'People and communication', color: '#aa88ff', icon: '\u{1F30A}' },
    body:   { label: 'Body', sub: 'Health and biometrics', color: '#ff6688', icon: '\u2764\uFE0F' },
    orbit:  { label: 'Orbit', sub: 'Digital presence and tools', color: '#ffaa00', icon: '\u{1F6F8}' },
  };

  const valenceColors = { growth: '#00ff88', pulse: '#00aaff', decay: '#ffaa00', care: '#ff6688' };

  const grouped = {};
  for (const s of streams) {
    if (!grouped[s.domain]) grouped[s.domain] = [];
    grouped[s.domain].push(s);
  }

  // Build narrative
  const msgStream = streams.find(s => s.id === 'imessage');
  const photoStream = streams.find(s => s.id === 'photos');
  const vaultStream = streams.find(s => s.id === 'vault');
  const claudeStream = streams.find(s => s.id === 'claude');
  const calStream = streams.find(s => s.id === 'calendar');

  let narrative = 'Your digital life is coming into focus.';
  const parts = [];
  if (msgStream) parts.push(`${msgStream.primary} messages exchanged with ${msgStream.secondary.split(' ')[0]} people`);
  if (photoStream) parts.push(`${photoStream.primary} photos and videos captured`);
  if (vaultStream) parts.push(`${vaultStream.primary} notes in your knowledge vault`);
  if (claudeStream) parts.push(`${claudeStream.primary} prompts in ${claudeStream.secondary.split(' ')[0]} AI sessions`);
  if (calStream) parts.push(`${calStream.primary} days documented`);
  if (parts.length > 0) narrative = parts.join('. ') + '.';

  // Signal bar
  const pct = summary.signalStrength;
  const blocks = Math.round(pct / 10);
  const signalBarStr = '\u2588'.repeat(blocks) + '\u2591'.repeat(10 - blocks);

  // Render domain sections
  let sectionsHTML = '';
  for (const [dId, dDef] of Object.entries(domainDefs)) {
    const dStreams = grouped[dId] || [];
    if (dStreams.length === 0) continue;

    const cards = dStreams.map(s => {
      const vc = valenceColors[s.valence] || '#555';
      const sig = s.signal === 'strong' ? '\u25CF\u25CF\u25CF' : s.signal === 'medium' ? '\u25CF\u25CF\u25CB' : '\u25CF\u25CB\u25CB';
      return `<div class="sc" style="border-left:3px solid ${vc}">
        <div class="sc-icon">${s.icon}</div>
        <div class="sc-body">
          <div class="sc-label">${s.label}</div>
          <div class="sc-primary" style="color:${vc}">${s.primary}</div>
          <div class="sc-secondary">${s.secondary}</div>
          ${s.tertiary ? `<div class="sc-tertiary">${s.tertiary}</div>` : ''}
        </div>
        <div class="sc-signal" title="${s.signal} signal">${sig}</div>
      </div>`;
    }).join('');

    sectionsHTML += `<div class="ds">
      <div class="ds-header" style="border-color:${dDef.color}40">
        <span style="font-size:24px">${dDef.icon}</span>
        <div><div class="ds-label" style="color:${dDef.color}">${dDef.label}</div><div class="ds-sub">${dDef.sub}</div></div>
        <div style="margin-left:auto;color:#333;font-size:11px">${dStreams.length} stream${dStreams.length > 1 ? 's' : ''}</div>
      </div>
      <div class="sg">${cards}</div>
    </div>`;
  }

  // Discovery log
  const logHTML = log.slice(-20).reverse().map(l => {
    const time = new Date(l.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return `<div class="le"><span class="lt">${time}</span> ${l.msg}</div>`;
  }).join('');

  // Evolution
  const evoHTML = (manifest?.evolution || []).slice(-10).reverse().map(e => {
    const dt = new Date(e.t).toLocaleDateString();
    const badge = e.event === 'genesis' ? 'background:#1a1a2a;color:#aa88ff' : 'background:#1a2a1a;color:#00ff88';
    return `<div class="ee"><span style="${badge};padding:1px 6px;border-radius:3px;font-size:10px;text-transform:uppercase">${e.event}</span> <span style="color:#444">${dt}</span> ${e.note}</div>`;
  }).join('');

  // Recommendations
  const recs = [];
  if (!streams.find(s => s.id === 'photos')) recs.push('\u{1F4F8} Photos library not accessible \u2014 grant Full Disk Access or check path');
  if (streams.find(s => s.id === 'health' && s.signal === 'weak')) recs.push('\u2764\uFE0F Export Apple Health data from iPhone for sleep, steps, heart rate');
  if (streams.find(s => s.id === 'shell' && s.count < 100)) recs.push('\u2328\uFE0F Shell history is thin \u2014 fresh machine, will grow naturally');
  recs.push('\u{1F4CD} Request Google Takeout for location history \u2192 MemoryAtlas Phase 4');
  if (!streams.find(s => s.id === 'imessage')?.tertiary?.includes('today')) recs.push('\u{1F4AC} Messages probe includes daily/weekly cadence tracking');

  const recsHTML = recs.map(r => `<div class="ri">${r}</div>`).join('');

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>Life Stream | \u03A9\u2080</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#080808;color:#ddd;font-family:'SF Mono','Fira Code',monospace;padding:24px 32px;max-width:1200px;margin:0 auto}
.nav{display:flex;gap:16px;margin-bottom:24px}
.nav a{color:#555;font-size:13px;padding:4px 12px;border:1px solid #222;border-radius:6px;text-decoration:none}
.nav a:hover,.nav a.active{color:#00ff88;border-color:#00ff88}
h1{color:#00ff88;font-size:28px;margin-bottom:4px}
.sub{color:#555;font-size:13px;margin-bottom:8px}
.narrative{color:#999;font-size:14px;line-height:1.6;margin-bottom:24px;padding:16px 20px;background:#0c0c0c;border-left:3px solid #00ff8844;border-radius:0 8px 8px 0}
.signal{display:flex;align-items:center;gap:16px;margin-bottom:32px;padding:16px;background:#0d0d0d;border:1px solid #1a1a1a;border-radius:8px}
.signal .blocks{color:#00ff88;font-size:18px;letter-spacing:2px}
.signal .pct{color:#00ff88;font-size:28px;font-weight:bold}
.signal .detail{color:#444;font-size:11px;flex:1}
.ds{margin-bottom:36px}
.ds-header{display:flex;align-items:center;gap:12px;padding-bottom:10px;margin-bottom:16px;border-bottom:1px solid}
.ds-label{font-size:16px;font-weight:bold}
.ds-sub{color:#555;font-size:11px}
.sg{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.sc{background:#0d0d0d;border:1px solid #1a1a1a;border-radius:8px;padding:16px;display:flex;gap:14px;align-items:flex-start;transition:border-color .2s,box-shadow .2s}
.sc:hover{border-color:#2a2a2a;box-shadow:0 0 20px rgba(0,255,136,.04)}
.sc-icon{font-size:28px;min-width:36px;text-align:center;line-height:1.2}
.sc-body{flex:1;min-width:0}
.sc-label{color:#777;font-size:10px;text-transform:uppercase;letter-spacing:.8px;margin-bottom:4px}
.sc-primary{font-size:28px;font-weight:bold;line-height:1.1}
.sc-secondary{color:#777;font-size:12px;margin-top:5px}
.sc-tertiary{color:#444;font-size:11px;margin-top:3px;font-style:italic}
.sc-signal{color:#2a2a2a;font-size:10px;letter-spacing:1px;white-space:nowrap}
.two{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:36px}
@media(max-width:800px){.two{grid-template-columns:1fr}}
.panel{background:#0c0c0c;border:1px solid #1a1a1a;border-radius:8px;padding:16px}
.panel h2{color:#555;font-size:13px;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px}
.le{padding:4px 0;border-bottom:1px solid #111;font-size:12px;color:#666}
.lt{color:#333;min-width:70px;display:inline-block}
.ee{padding:6px 0;border-bottom:1px solid #111;font-size:12px;color:#777}
.rec{margin-top:24px}
.rec h2{color:#ffaa00;font-size:13px;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px}
.ri{padding:8px 12px;border-left:2px solid #1a1a1a;margin-bottom:8px;font-size:12px;color:#666}
.footer{color:#222;font-size:11px;text-align:right;margin-top:32px}
@keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
.sc{animation:fadeUp .35s ease-out both}
.sc:nth-child(2){animation-delay:.05s}.sc:nth-child(3){animation-delay:.1s}
.sc:nth-child(4){animation-delay:.15s}.sc:nth-child(5){animation-delay:.2s}
</style>
</head><body>

${renderNav('stream')}

<h1>\u03A9\u2080 Life Stream</h1>
<div class="sub">Self-assembling portrait of your digital life \u00B7 Probe #${manifest?.probeCount || 1}</div>

<div class="narrative">${narrative}</div>

<div class="signal">
<div>
<div style="color:#555;font-size:10px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Signal Strength</div>
<div class="blocks">${signalBarStr}</div>
</div>
<div class="pct">${pct}%</div>
<div class="detail">
${streams.length} streams discovered \u00B7
${Object.entries(summary.byDomain).map(([k,v]) => `${v} ${k}`).join(' \u00B7 ')}
</div>
</div>

${sectionsHTML}

<div class="two">
<div class="panel" style="max-height:400px;overflow-y:auto">
<h2>Discovery Log</h2>
${logHTML}
</div>
<div>
${evoHTML ? `<div class="panel" style="margin-bottom:16px"><h2>Evolution</h2>${evoHTML}</div>` : ''}
<div class="rec">
<h2>Unlock More Signal</h2>
${recsHTML}
</div>
</div>
</div>

<div class="footer">
Probed ${data.probedAt} \u00B7 Manifest: ~/.claude/stream-manifest.json \u00B7 Auto-refresh 60s
</div>

<script>
setInterval(async()=>{try{const r=await fetch('/stream');const h=await r.text();document.open();document.write(h);document.close()}catch{}},60000);
</script>

</body></html>`;
}

// ─── Threads page ────────────────────────────────────────────────────

function renderThreadsHTML() {
  const threads = getThreads();
  const statusOrder = { critical: 0, running: 1, blocked: 2, pending: 3, done: 4 };
  const sorted = [...threads].sort((a, b) => (statusOrder[a.status] ?? 5) - (statusOrder[b.status] ?? 5));

  const chip = {
    done:     { label: 'DONE',        color: '#00ff88', bg: '#00ff8811', border: '#00ff8833' },
    running:  { label: 'IN PROGRESS', color: '#00aaff', bg: '#00aaff11', border: '#00aaff33' },
    blocked:  { label: 'BLOCKED',     color: '#ffaa00', bg: '#ffaa0011', border: '#ffaa0033' },
    critical: { label: 'CRITICAL',    color: '#ff4444', bg: '#ff444411', border: '#ff444433' },
    pending:  { label: 'PENDING',     color: '#555',    bg: '#55555511', border: '#55555533' },
  };

  const counts = { critical: 0, running: 0, blocked: 0, pending: 0, done: 0 };
  for (const t of threads) counts[t.status] = (counts[t.status] || 0) + 1;

  const cards = sorted.map(t => {
    const c = chip[t.status] || chip.pending;
    const opacity = t.status === 'done' ? 'opacity:0.45;' : '';
    return `<div class="tcard" style="${opacity}border-left:3px solid ${c.border}">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
    <span class="tname">${t.name}</span>
    <span class="chip" style="color:${c.color};background:${c.bg};border:1px solid ${c.border}">${c.label}</span>
  </div>
  <div class="tdesc">${t.desc}</div>
  ${t.next ? `<div class="tnext">→ ${t.next}</div>` : ''}
</div>`;
  }).join('\n');

  return `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<title>Ω₀ Threads</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#0a0a0a; color:#e0e0e0; font-family:'SF Mono','Fira Code',monospace; padding:20px; }
h1 { color:#00ff88; font-size:28px; margin-bottom:4px; }
.subtitle { color:#666; margin-bottom:20px; font-size:13px; }
.nav { display:flex; gap:16px; margin-bottom:20px; }
.nav a { color:#555; font-size:13px; padding:4px 12px; border:1px solid #222; border-radius:6px; text-decoration:none; }
.nav a:hover, .nav a.active { color:#00ff88; border-color:#00ff88; }
.summary { display:flex; gap:16px; flex-wrap:wrap; margin-bottom:24px; }
.sstat { background:#151515; border:1px solid #222; border-radius:8px; padding:12px 20px; text-align:center; }
.sstat .sv { font-size:28px; font-weight:bold; }
.sstat .sl { color:#555; font-size:11px; text-transform:uppercase; letter-spacing:1px; margin-top:2px; }
.sv.critical { color:#ff4444; }
.sv.running  { color:#00aaff; }
.sv.blocked  { color:#ffaa00; }
.sv.pending  { color:#555; }
.sv.done     { color:#00ff88; }
.grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(340px,1fr)); gap:14px; }
.tcard { background:#111; border:1px solid #222; border-radius:8px; padding:16px; }
.tname { font-size:14px; font-weight:bold; color:#e0e0e0; }
.chip { font-size:10px; font-weight:bold; padding:2px 8px; border-radius:4px; letter-spacing:0.5px; white-space:nowrap; }
.tdesc { color:#666; font-size:12px; line-height:1.5; margin-top:4px; }
.tnext { color:#00aaff; font-size:12px; margin-top:8px; opacity:0.8; }
.timestamp { color:#333; font-size:11px; text-align:right; margin-top:24px; }
</style>
</head><body>
${renderNav('threads')}
<h1>Ω₀ Active Threads</h1>
<div class="subtitle">Source: MEMORY.md — Auto-refresh 60s</div>

<div class="summary">
  <div class="sstat"><div class="sv critical">${counts.critical}</div><div class="sl">Critical</div></div>
  <div class="sstat"><div class="sv running">${counts.running}</div><div class="sl">In Progress</div></div>
  <div class="sstat"><div class="sv blocked">${counts.blocked}</div><div class="sl">Blocked</div></div>
  <div class="sstat"><div class="sv pending">${counts.pending}</div><div class="sl">Pending</div></div>
  <div class="sstat"><div class="sv done">${counts.done}</div><div class="sl">Done</div></div>
</div>

<div class="grid">${cards}</div>
<div class="timestamp">Parsed ${new Date().toLocaleString()} · MEMORY.md</div>
<script>setInterval(async()=>{try{const r=await fetch('/threads');const h=await r.text();document.open();document.write(h);document.close()}catch{}},60000);</script>
</body></html>`;
}

// ─── Blockers (Peretz-only) ──────────────────────────────────────────

function getBlockers() {
  // Blockers that only Peretz can unblock
  // Each has: item, blocker, instructions, impact (1-10), unlocks array
  const blockers = [
    {
      item: 'Time Machine Backup',
      blocker: 'Need to configure Elements-Ready drive in System Preferences',
      impact: 9,
      unlocks: ['User Account Merge', 'Safe system upgrades', 'Data recovery safety net', 'Ability to test risky operations'],
      instructions: [
        'Open System Settings → General → Time Machine',
        'Click "+" to add backup disk',
        'Select "Elements-Ready" from the list',
        'Click "Set Up Disk"',
        'Choose encryption preference (recommended: encrypted)',
        'First backup will start automatically (may take several hours)',
      ],
    },
    {
      item: 'LinkedIn MCP Manual Login',
      blocker: 'Need to log into LinkedIn via Claude Desktop browser once',
      impact: 7,
      unlocks: ['Contact Dedup enrichment (716 T1 people)', 'LinkedIn profile data mining', 'Professional network mapping', 'Automated connection tracking'],
      instructions: [
        'Open Claude Desktop app',
        'LinkedIn MCP server is already configured',
        'Trigger any LinkedIn tool (search, profile lookup)',
        'Playwright browser will open',
        'Log into LinkedIn manually',
        'Session will be saved to ~/.linkedin-mcp-profile/',
        'Close browser when done',
      ],
    },
    {
      item: 'Google Takeout (Location History)',
      blocker: 'Need to request Location History export from Google',
      impact: 6,
      unlocks: ['MemoryAtlas Phase 4 (location enrichment)', 'Travel timeline reconstruction', 'Location-based memory triggers', 'Geocoded voice memos'],
      instructions: [
        'Go to takeout.google.com',
        'Deselect all products',
        'Select only "Location History"',
        'Choose file format: JSON',
        'Click "Next step" → "Create export"',
        'Wait for email notification (may take hours/days)',
        'Download archive when ready',
        'Extract to ~/Downloads/ or external drive',
      ],
    },
    {
      item: 'Cursor Privacy Mode Decision',
      blocker: 'Need to decide whether to enable Cursor Privacy Mode',
      impact: 5,
      unlocks: ['Secure coding in Cursor', 'Safe work on sensitive codebases', 'Peace of mind with proprietary code'],
      instructions: [
        'Open Cursor Settings',
        'Navigate to Privacy section',
        'Review Privacy Mode options:',
        '  - Disables telemetry',
        '  - Disables code snippets sent to Cursor servers',
        '  - May reduce some AI features',
        'Toggle Privacy Mode ON or OFF based on preference',
        'Document decision in ~/CURSOR-ROLE-STRATEGY.md',
      ],
    },
    {
      item: 'VPN Home Access Setup',
      blocker: 'Need router admin credentials and port forwarding setup',
      impact: 8,
      unlocks: ['Remote access to localhost services', 'Work from anywhere', 'Access Life Stream remotely', 'Secure tunnel to home network'],
      instructions: [
        'Find router IP (usually 192.168.1.1)',
        'Locate router admin credentials (on router label or password manager)',
        'Log into router admin panel',
        'Enable port forwarding for VPN (e.g., WireGuard port 51820)',
        'Set up dynamic DNS (or note static IP)',
        'Install Tailscale or WireGuard on Mac Studio',
        'Configure VPN client on remote devices',
        'Test connection from external network',
      ],
    },
    {
      item: 'Password Merge (Chrome → Apple)',
      blocker: 'Need to decrypt Chrome password vault on SD4Loco and import',
      impact: 4,
      unlocks: ['Unified password management', 'iCloud Keychain sync across devices', 'Auto-fill on iPhone/iPad', 'Decommission Chrome vault'],
      instructions: [
        'Open Chrome on Mac Studio',
        'Go to chrome://settings/passwords',
        'Click "Export passwords" (requires Mac password)',
        'Save CSV to secure location (e.g., ~/Documents/temp-passwords.csv)',
        'Open Safari → Preferences → Passwords',
        'Click "..." menu → Import Passwords',
        'Select the exported CSV file',
        'Verify import success',
        'Securely delete CSV file (rm + empty trash)',
      ],
    },
    {
      item: 'Domain Strategy (3 domains)',
      blocker: 'Need to decide hosting/deployment strategy for tolerableinsanity.com, jalalagood.com, peretzpartensky.com',
      impact: 6,
      unlocks: ['Public web presence (L4 Digital Self)', 'Professional portfolio', 'Personal brand', 'Shareable work showcase'],
      instructions: [
        'Review current domain status (registrar, expiration)',
        'Decide content strategy for each domain:',
        '  - peretzpartensky.com: professional portfolio?',
        '  - tolerableinsanity.com: blog/writing?',
        '  - jalalagood.com: project showcase?',
        'Choose hosting platform (Vercel, Netlify, GitHub Pages)',
        'Point DNS to chosen platform',
        'Deploy initial content or placeholder',
        'Document strategy in vault/Efforts/Active/Digital Self.md',
      ],
    },
  ];

  // Sort by impact (highest first)
  return blockers.sort((a, b) => b.impact - a.impact);
}

function renderBlockersHTML() {
  const blockers = getBlockers();
  const totalImpact = blockers.reduce((sum, b) => sum + b.impact, 0);
  const avgImpact = (totalImpact / blockers.length).toFixed(1);

  const blockerCards = blockers.map((b, i) => {
    const impactColor = b.impact >= 8 ? '#ff4444' : b.impact >= 6 ? '#ffaa00' : '#00aaff';
    const unlocksList = b.unlocks.map(u => `<li>${u}</li>`).join('');
    const instructionsList = b.instructions.map(s => `<li>${s}</li>`).join('');

    return `<details class="blocker-card" style="border-left:4px solid ${impactColor}">
  <summary class="blocker-summary">
    <div class="blocker-header">
      <span class="blocker-rank">#${i + 1}</span>
      <span class="blocker-item">${b.item}</span>
      <span class="blocker-impact" style="background:${impactColor}22;color:${impactColor}">Impact: ${b.impact}/10</span>
    </div>
    <div class="blocker-desc">${b.blocker}</div>
  </summary>
  <div class="blocker-content">
    <div class="blocker-section">
      <h4>🔓 This Unlocks:</h4>
      <ul class="blocker-list unlocks">${unlocksList}</ul>
      <div class="unlock-count">${b.unlocks.length} downstream items</div>
    </div>
    <div class="blocker-section">
      <h4>📋 How to Unblock (Peretz):</h4>
      <ol class="blocker-instructions">${instructionsList}</ol>
    </div>
  </div>
</details>`;
  }).join('');

  return `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<title>🚧 Blockers | PracticeLife</title>
<meta http-equiv="refresh" content="60">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#0a0a0a; color:#e0e0e0; font-family:'SF Mono','Fira Code',monospace; padding:20px; }
h1 { color:#00ff88; font-size:28px; margin-bottom:4px; }
.subtitle { color:#666; margin-bottom:20px; font-size:13px; }

.summary { display:flex; gap:16px; margin-bottom:24px; }
.scard { background:#151515; border:1px solid #222; border-radius:8px; padding:12px 20px; text-align:center; flex:1; }
.scard .num { font-size:32px; font-weight:bold; color:#ff4444; }
.scard .label { color:#555; font-size:11px; text-transform:uppercase; letter-spacing:1px; margin-top:4px; }
.scard.impact .num { color:#ffaa00; }
.scard.unlocks .num { color:#00aaff; }

.blocker-card { background:#111; border-radius:8px; padding:0; margin-bottom:16px; overflow:hidden; }
.blocker-summary { list-style:none; padding:20px; cursor:pointer; user-select:none; }
.blocker-summary::-webkit-details-marker { display:none; }
.blocker-summary::before { content:'▶'; display:inline-block; margin-right:12px; transition:transform 0.2s; color:#555; }
details[open] .blocker-summary::before { transform:rotate(90deg); }

.blocker-header { display:flex; align-items:center; gap:12px; margin-bottom:8px; }
.blocker-rank { font-size:20px; font-weight:bold; color:#333; min-width:40px; }
.blocker-item { font-size:16px; font-weight:bold; color:#e0e0e0; flex:1; }
.blocker-impact { font-size:11px; font-weight:bold; padding:4px 12px; border-radius:6px; white-space:nowrap; }
.blocker-desc { color:#999; font-size:13px; line-height:1.5; margin-left:52px; }

.blocker-content { padding:0 20px 20px 20px; border-top:1px solid #1a1a1a; margin-top:12px; padding-top:16px; }
.blocker-section { margin-bottom:20px; }
.blocker-section:last-child { margin-bottom:0; }
.blocker-section h4 { color:#00aaff; font-size:13px; margin-bottom:8px; text-transform:uppercase; letter-spacing:1px; }
.blocker-list { margin-left:20px; color:#aaa; font-size:13px; line-height:1.8; }
.blocker-list.unlocks li { color:#00ff88; }
.blocker-instructions { margin-left:20px; color:#ddd; font-size:13px; line-height:1.8; }
.blocker-instructions li { margin-bottom:6px; }
.unlock-count { color:#555; font-size:11px; margin-top:8px; margin-left:20px; }

.timestamp { color:#333; font-size:11px; text-align:right; margin-top:24px; }
</style>
</head><body>
${renderNav('blockers')}
<h1>🚧 Blockers (Peretz-Only)</h1>
<div class="subtitle">Ranked by estimated impact value · Click to expand instructions</div>

<div class="summary">
  <div class="scard">
    <div class="num">${blockers.length}</div>
    <div class="label">Active Blockers</div>
  </div>
  <div class="scard impact">
    <div class="num">${avgImpact}</div>
    <div class="label">Avg Impact</div>
  </div>
  <div class="scard unlocks">
    <div class="num">${blockers.reduce((sum, b) => sum + b.unlocks.length, 0)}</div>
    <div class="label">Items Blocked</div>
  </div>
</div>

${blockerCards}

<div class="timestamp">Last refresh: ${new Date().toLocaleString()}</div>
</body></html>`;
}

// ─── Server ──────────────────────────────────────────────────────────


// SSL certificate options
const sslOptions = {
  key: fs.readFileSync(path.join(process.env.HOME, '.ssl/localhost.key')),
  cert: fs.readFileSync(path.join(process.env.HOME, '.ssl/localhost.crt'))
};

const server = https.createServer(sslOptions, (req, res) => {
  if (req.url === '/api/state') {
    const state = getState();
    recordHistory(state);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(state, null, 2));
    return;
  }
  if (req.url === '/plan') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(renderPlanHTML());
    return;
  }
  if (req.url === '/api/plan') {
    const plan = getPlanState();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(plan, null, 2));
    return;
  }
  if (req.url === '/stream') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(renderStreamHTML());
    return;
  }
  if (req.url === '/api/stream') {
    const streamData = probeAllStreams();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(streamData, null, 2));
    return;
  }
  if (req.url === '/threads') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(renderThreadsHTML());
    return;
  }
  if (req.url === '/api/threads') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(getThreads(), null, 2));
    return;
  }
  if (req.url === '/endpoints') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(renderEndpointsHTML());
    return;
  }
  if (req.url === '/agents') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(renderAgentsHTML());
    return;
  }
  if (req.url === '/api/agents') {
    const state = getState();
    const agentData = {
      workers: state.agents.workers,
      handoffs: state.agents.handoffs,
      instances: state.agents.instances,
      blockers: getDependencies().blockers,
      timestamp: new Date().toISOString(),
    };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(agentData, null, 2));
    return;
  }
  if (req.url === '/deps') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(renderDepsHTML());
    return;
  }
  if (req.url === '/api/deps') {
    const deps = getDependencies();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(deps, null, 2));
    return;
  }
  if (req.url === '/api/history') {
    const history = getHistory();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(history));
    return;
  }
  if (req.url === '/blockers') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(renderBlockersHTML());
    return;
  }
  if (req.url === '/api/blockers') {
    const blockers = getBlockers();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(blockers, null, 2));
    return;
  }
  if (req.url === '/cheatsheet') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(renderCheatsheetHTML());
    return;
  }
  if (req.url === '/prompts') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(renderPromptsHTML());
    return;
  }
  if (req.url === '/api/prompts/suggested') {
    try {
      const prompts = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.claude/suggested-prompts.json'), 'utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(prompts, null, 2));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.url === '/tasks') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(renderTasksHTML());
    return;
  }
  if (req.url === '/api/tasks') {
    try {
      const prompts = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.claude/suggested-prompts.json'), 'utf8'));
      const tasks = {
        ready: prompts.prompts.filter(p => p.status === 'ready'),
        in_progress: prompts.prompts.filter(p => p.status === 'in_progress'),
        complete: prompts.prompts.filter(p => p.status === 'complete'),
        blocked: prompts.prompts.filter(p => p.status === 'blocked')
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(tasks, null, 2));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.url.startsWith('/search')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    const query = decodeURIComponent(req.url.split('?q=')[1] || '');
    res.end(renderSearchHTML(query));
    return;
  }
  const state = getState();
  recordHistory(state);
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(renderHTML(state));
});

// ─── Cheat Sheet Page ─────────────────────────────────────────────────

function renderCheatsheetHTML() {
  const cheatsheet = fs.readFileSync(path.join(process.env.HOME, '.claude/CHEAT-SHEET.md'), 'utf8');

  // Simple markdown-to-HTML conversion (basic headers, code blocks, lists)
  let html = cheatsheet
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/```bash\n([\s\S]+?)\n```/g, '<pre class="code-block">$1</pre>')
    .replace(/```\n([\s\S]+?)\n```/g, '<pre class="code-block">$1</pre>')
    .replace(/\| (.+) \|/g, (match) => {
      const cells = match.split('|').filter(c => c.trim()).map(c => `<td>${c.trim()}</td>`).join('');
      return `<tr>${cells}</tr>`;
    });

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>Claude Code Cheat Sheet | Ω₀</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#0a0a0a; color:#e0e0e0; font-family:'SF Mono','Fira Code',monospace; padding:20px; max-width:1200px; margin:0 auto; line-height:1.6; }
h1 { color:#00ff88; font-size:32px; margin:20px 0 10px 0; }
h2 { color:#00aaff; font-size:20px; margin:30px 0 10px 0; padding-bottom:6px; border-bottom:1px solid #222; }
h3 { color:#ffaa00; font-size:16px; margin:20px 0 8px 0; }
p { margin:10px 0; color:#ccc; }
code { background:#151515; padding:2px 6px; border-radius:3px; color:#00ff88; font-size:13px; }
pre.code-block { background:#0d0d0d; border:1px solid #222; border-left:3px solid #00ff88; padding:16px; border-radius:6px; overflow-x:auto; margin:16px 0; color:#e0e0e0; font-size:13px; line-height:1.4; }
ul { margin-left:20px; margin-top:8px; }
li { margin:4px 0; color:#aaa; }
table { width:100%; border-collapse:collapse; margin:16px 0; background:#0d0d0d; border-radius:6px; overflow:hidden; }
tr { border-bottom:1px solid #1a1a1a; }
td { padding:12px; font-size:13px; }
td:first-child { color:#00ff88; font-weight:600; }
strong { color:#fff; }
.nav { display:flex; gap:16px; margin-bottom:24px; padding-bottom:16px; border-bottom:1px solid #222; }
.nav a { color:#555; font-size:13px; padding:4px 12px; border:1px solid #222; border-radius:6px; text-decoration:none; }
.nav a:hover, .nav a.active { color:#00ff88; border-color:#00ff88; }
.updated { color:#444; font-size:11px; text-align:right; margin-top:32px; }
</style>
</head><body>
${renderNav('cheatsheet')}
${html}
<div class="updated">Last updated: 2026-02-21 | Location: ~/.claude/CHEAT-SHEET.md</div>
</body></html>`;
}

// ─── Suggested Prompts Page ───────────────────────────────────────────

function renderPromptsHTML() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.claude/suggested-prompts.json'), 'utf8'));
  } catch (e) {
    return `<!DOCTYPE html><html><body style="background:#0a0a0a;color:#e0e0e0;font-family:monospace;padding:40px;text-align:center">
      <h1 style="color:#ff4444">Error Loading Prompts</h1>
      <p style="color:#666;margin-top:12px">${e.message}</p>
    </body></html>`;
  }

  const categories = {};
  for (const p of data.prompts) {
    if (!categories[p.category]) categories[p.category] = [];
    categories[p.category].push(p);
  }

  const categoryHTML = Object.entries(categories).map(([cat, prompts]) => {
    const cards = prompts.map(p => {
      const statusBadge = p.status === 'complete'
        ? `<div class="status-badge complete">✓ Complete${p.completed_by ? ` by ${p.completed_by}` : ''}</div>`
        : p.status === 'in_progress'
        ? `<div class="status-badge progress">🔄 In Progress${p.completed_by ? ` by ${p.completed_by}` : ''}</div>`
        : p.status === 'partial'
        ? `<div class="status-badge partial">⚠️ Partial</div>`
        : `<div class="status-badge ready">📋 Ready to Execute</div>`;

      const notes = p.notes ? `<div class="prompt-notes">📝 ${p.notes}</div>` : '';

      return `
      <div class="prompt-card ${p.status}" data-id="${p.id}">
        <div class="prompt-header">
          <div class="prompt-title">${p.title}</div>
          <div class="prompt-id">#${p.id}</div>
        </div>
        ${statusBadge}
        <div class="prompt-template">${p.template}</div>
        <div class="prompt-meta">
          <span class="meta-item">⏱ ${p.estimated_time}</span>
          <span class="meta-item">💰 ${p.estimated_cost}</span>
        </div>
        <div class="prompt-outcome">→ ${p.expected_outcome}</div>
        ${notes}
        <div class="prompt-tags">${p.tags.map(t => `<span class="tag">${t}</span>`).join('')}</div>
        ${p.status !== 'complete' ? `<button class="copy-btn" onclick="copyPrompt('${p.id}')">Copy Template</button>` : ''}
      </div>
    `;
    }).join('');

    return `
      <div class="category-section">
        <h2 class="category-title">${cat} (${prompts.length})</h2>
        <div class="prompt-grid">${cards}</div>
      </div>
    `;
  }).join('');

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>Suggested Prompts | Ω₀</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#0a0a0a; color:#e0e0e0; font-family:'SF Mono','Fira Code',monospace; padding:20px; }
.container { max-width:1400px; margin:0 auto; }
h1 { color:#00ff88; font-size:28px; margin-bottom:8px; }
.subtitle { color:#666; font-size:13px; margin-bottom:24px; }
.category-section { margin-bottom:40px; }
.category-title { color:#00aaff; font-size:18px; margin-bottom:16px; padding-bottom:8px; border-bottom:1px solid #222; }
.prompt-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(400px,1fr)); gap:16px; }
.prompt-card { background:#0d0d0d; border:1px solid #1a1a1a; border-left:3px solid #00ff88; border-radius:8px; padding:16px; transition:border-color .2s,box-shadow .2s; }
.prompt-card:hover { border-left-color:#00aaff; box-shadow:0 0 20px rgba(0,255,136,.08); }
.prompt-card.complete { border-left-color:#00ff88; opacity:0.7; }
.prompt-card.in_progress { border-left-color:#00aaff; }
.prompt-card.partial { border-left-color:#ffaa00; }
.status-badge { font-size:11px; font-weight:600; padding:4px 10px; border-radius:4px; margin-bottom:10px; display:inline-block; }
.status-badge.complete { background:#00ff8822; color:#00ff88; border:1px solid #00ff8844; }
.status-badge.progress { background:#00aaff22; color:#00aaff; border:1px solid #00aaff44; }
.status-badge.partial { background:#ffaa0022; color:#ffaa00; border:1px solid #ffaa0044; }
.status-badge.ready { background:#55555522; color:#888; border:1px solid #55555544; }
.prompt-notes { background:#1a1a1a; border-left:2px solid #00aaff; padding:8px 12px; margin:8px 0; font-size:12px; color:#999; border-radius:4px; }
.prompt-header { display:flex; justify-content:space-between; align-items:start; margin-bottom:12px; }
.prompt-title { color:#fff; font-size:15px; font-weight:600; flex:1; }
.prompt-id { color:#444; font-size:11px; font-weight:600; background:#1a1a1a; padding:2px 8px; border-radius:4px; }
.prompt-template { color:#ccc; font-size:13px; line-height:1.6; margin-bottom:12px; }
.var { color:#ffaa00; font-weight:600; }
.prompt-meta { display:flex; gap:16px; margin-bottom:8px; }
.meta-item { color:#666; font-size:11px; }
.prompt-outcome { color:#00ff88; font-size:12px; margin-bottom:12px; font-style:italic; }
.prompt-tags { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:12px; }
.tag { background:#1a1a1a; color:#777; font-size:10px; padding:3px 8px; border-radius:4px; }
.copy-btn { background:#00ff8822; color:#00ff88; border:1px solid #00ff8844; padding:8px 16px; border-radius:6px; cursor:pointer; font-size:12px; font-family:inherit; width:100%; transition:all .2s; }
.copy-btn:hover { background:#00ff8833; border-color:#00ff88; }
.copy-btn:active { transform:scale(0.98); }
.stats { display:flex; gap:20px; margin-bottom:24px; }
.stat { background:#0d0d0d; border:1px solid #1a1a1a; border-radius:8px; padding:16px 24px; text-align:center; }
.stat-value { color:#00ff88; font-size:32px; font-weight:600; }
.stat-label { color:#666; font-size:11px; margin-top:4px; text-transform:uppercase; letter-spacing:1px; }
.toast { position:fixed; top:20px; right:20px; background:#00ff88; color:#0a0a0a; padding:12px 20px; border-radius:8px; font-weight:600; display:none; animation:slideIn .3s; }
.toast.show { display:block; }
@keyframes slideIn { from { transform:translateX(100%); opacity:0; } to { transform:translateX(0); opacity:1; } }
</style>
</head><body>
<div class="container">
${renderNav('prompts')}

<h1>🚀 Suggested Prompts</h1>
<div class="subtitle">Curated prompts from ThePromptReviewer based on ${data.meta.source}</div>

<div class="stats">
  <div class="stat">
    <div class="stat-value">${data.prompts.length}</div>
    <div class="stat-label">Total Prompts</div>
  </div>
  <div class="stat">
    <div class="stat-value">${Object.keys(categories).length}</div>
    <div class="stat-label">Categories</div>
  </div>
</div>

${categoryHTML}

<div id="toast" class="toast"></div>

<script>
const promptsData = ${JSON.stringify(data.prompts)};
function copyPrompt(id) {
  const p = promptsData.find(x => x.id === id);
  if (!p) return;
  navigator.clipboard.writeText(p.template).then(() => {
    const toast = document.getElementById('toast');
    toast.textContent = '✓ Copied to clipboard!';
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
  });
}
</script>

</div>
</body></html>`;
}

// ─── MemoryAtlas Search Page ──────────────────────────────────────────

function renderSearchHTML(query) {
  let results = [];
  if (query) {
    // Query MemoryAtlas database
    const atlasDb = path.join(process.env.HOME, 'tools/memoryatlas/data/atlas.db');
    if (fs.existsSync(atlasDb)) {
      const searchQuery = `SELECT id, title, duration, recorded, transcription_path FROM asset WHERE title LIKE '%${query.replace(/'/g, "''")}%' OR recording_path LIKE '%${query.replace(/'/g, "''")}%' LIMIT 50`;
      const raw = run(`sqlite3 "${atlasDb}" "${searchQuery}"`, 8000);
      if (raw !== '—') {
        results = raw.split('\n').filter(Boolean).map(line => {
          const [id, title, duration, recorded, transcription_path] = line.split('|');
          return { id, title, duration, recorded, transcription_path };
        });
      }
    }
  }

  const resultsHTML = results.length > 0
    ? results.map(r => `
        <div class="result-card">
          <div class="result-title">${r.title || 'Untitled'}</div>
          <div class="result-meta">
            <span>🎙 ${r.duration || 'Unknown'}</span>
            <span>📅 ${r.recorded || 'Unknown'}</span>
          </div>
          ${r.transcription_path ? `<div class="result-transcript">Transcription available</div>` : ''}
        </div>
      `).join('')
    : query
      ? '<div style="color:#666;text-align:center;padding:40px">No results found</div>'
      : '<div style="color:#666;text-align:center;padding:40px">Enter a search query above</div>';

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>MemoryAtlas Search | Ω₀</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#0a0a0a; color:#e0e0e0; font-family:'SF Mono','Fira Code',monospace; padding:20px; }
.container { max-width:1200px; margin:0 auto; }
h1 { color:#00ff88; font-size:28px; margin-bottom:24px; }
.search-box { margin-bottom:32px; }
.search-box input { width:100%; padding:16px; background:#0d0d0d; border:1px solid #222; border-radius:8px; color:#e0e0e0; font-family:inherit; font-size:16px; }
.search-box input:focus { outline:none; border-color:#00ff88; }
.results { }
.result-card { background:#0d0d0d; border:1px solid #1a1a1a; border-left:3px solid #00aaff; border-radius:8px; padding:16px; margin-bottom:12px; }
.result-title { color:#fff; font-size:16px; font-weight:600; margin-bottom:8px; }
.result-meta { display:flex; gap:16px; color:#666; font-size:12px; }
.result-transcript { color:#00ff88; font-size:11px; margin-top:8px; }
.count { color:#666; font-size:13px; margin-bottom:16px; }
</style>
</head><body>
<div class="container">
${renderNav('search')}

<h1>🔍 MemoryAtlas Search</h1>

<div class="search-box">
  <form method="GET" action="/search">
    <input type="text" name="q" placeholder="Search voice memos..." value="${query || ''}" autofocus>
  </form>
</div>

${query ? `<div class="count">Found ${results.length} results for "${query}"</div>` : ''}

<div class="results">
  ${resultsHTML}
</div>

</div>
</body></html>`;
}

// ─── Endpoints Index Page ─────────────────────────────────────────────

function renderEndpointsHTML() {
  const services = [
    {
      name: 'Life Dashboard',
      port: 3000,
      status: 'running',
      description: 'Main system dashboard with metrics, charts, and navigation',
      endpoints: [
        { method: 'GET', path: '/', desc: 'Main dashboard with system metrics' },
        { method: 'GET', path: '/agents', desc: 'Agent collaboration status' },
        { method: 'GET', path: '/stream', desc: 'Life Stream - 15 data source probes' },
        { method: 'GET', path: '/threads', desc: 'Active threads from MEMORY.md' },
        { method: 'GET', path: '/plan', desc: 'Plan execution tracker' },
        { method: 'GET', path: '/deps', desc: 'Dependency graph (blockers)' },
        { method: 'GET', path: '/endpoints', desc: 'This page - all endpoints index' },
        { method: 'GET', path: '/api/state', desc: 'JSON: System state snapshot' },
        { method: 'GET', path: '/api/stream', desc: 'JSON: Life Stream data' },
        { method: 'GET', path: '/api/threads', desc: 'JSON: Active threads' },
        { method: 'GET', path: '/api/agents', desc: 'JSON: Agent collaboration data' },
        { method: 'GET', path: '/api/plan', desc: 'JSON: Plan execution state' },
        { method: 'GET', path: '/api/deps', desc: 'JSON: Dependencies and blockers' },
        { method: 'GET', path: '/api/history', desc: 'JSON: Historical metrics' },
      ],
    },
    {
      name: 'PracticeLife API',
      port: 3001,
      status: 'running',
      description: 'Local-first personal API - unifies MemoryAtlas, vault, system state',
      endpoints: [
        { method: 'GET', path: '/', desc: 'API landing page (HTML)' },
        { method: 'GET', path: '/health', desc: 'Health check' },
        { method: 'GET', path: '/api', desc: 'API index with all endpoints' },
        { method: 'GET', path: '/api/atlas/assets', desc: 'List MemoryAtlas assets (?limit=50&offset=0)' },
        { method: 'GET', path: '/api/atlas/assets/:id', desc: 'Get single asset by ID' },
        { method: 'GET', path: '/api/atlas/stats', desc: 'MemoryAtlas statistics' },
        { method: 'GET', path: '/api/atlas/search/:query', desc: 'Search assets by title' },
        { method: 'GET', path: '/api/vault/stats', desc: 'Vault note count and path' },
        { method: 'GET', path: '/api/vault/notes', desc: 'List notes in directory (?dir=Efforts/Active)' },
        { method: 'GET', path: '/api/vault/note', desc: 'Read a note (?path=Dashboards/Home.md)' },
        { method: 'GET', path: '/api/vault/structure', desc: 'Top-level vault structure' },
        { method: 'GET', path: '/api/system/state', desc: 'System metrics (CPU, memory, disk)' },
        { method: 'GET', path: '/api/system/volumes', desc: 'Mounted volumes' },
        { method: 'GET', path: '/api/system/ollama', desc: 'Ollama model list' },
        { method: 'GET', path: '/api/agents/protocol', desc: 'Agent coordination protocol' },
        { method: 'GET', path: '/api/agents/sessions', desc: 'List Claude session logs' },
        { method: 'GET', path: '/api/agents/sessions/:name', desc: 'Read specific session log' },
        { method: 'GET', path: '/api/agents/collab-brief', desc: 'Codex-Claude collaboration brief' },
        { method: 'GET', path: '/api/ecosystem', desc: 'Complete PracticeLife OS map (?format=json|text)' },
      ],
    },
    {
      name: 'Prompt Browser',
      port: 3002,
      status: 'running',
      description: 'Browse and search all prompts sent to Claude',
      endpoints: [
        { method: 'GET', path: '/', desc: 'Prompt browser UI' },
        { method: 'GET', path: '/api/stats', desc: 'Prompt statistics (total, sessions, dates)' },
        { method: 'GET', path: '/api/prompts', desc: 'List prompts (?limit=50&offset=0)' },
        { method: 'GET', path: '/api/search', desc: 'Search prompts (?q=query)' },
        { method: 'GET', path: '/api/sessions', desc: 'List sessions' },
      ],
    },
    {
      name: 'Contact Verification',
      port: 3003,
      status: 'running',
      description: 'Web verification interface for contact updates',
      endpoints: [
        { method: 'GET', path: '/', desc: 'Admin panel - generate verification links' },
        { method: 'GET', path: '/verify/:token', desc: 'Contact verification form' },
        { method: 'POST', path: '/verify/:token', desc: 'Submit verified contact data' },
        { method: 'GET', path: '/api/contacts', desc: 'List contacts' },
      ],
    },
  ];

  const serviceCards = services.map(svc => {
    const statusDot = svc.status === 'running' ? '🟢' : '🔴';
    const endpointRows = svc.endpoints.map(e => `
      <tr>
        <td><span class="method ${e.method.toLowerCase()}">${e.method}</span></td>
        <td><code class="path">localhost:${svc.port}${e.path}</code></td>
        <td class="desc">${e.desc}</td>
      </tr>
    `).join('');

    return `
      <div class="service-card">
        <div class="service-header">
          <div>
            <div class="service-name">${statusDot} ${svc.name}</div>
            <div class="service-desc">${svc.description}</div>
          </div>
          <div class="service-port">:${svc.port}</div>
        </div>
        <table class="endpoints-table">
          <thead>
            <tr>
              <th style="width:70px">Method</th>
              <th style="width:350px">Endpoint</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            ${endpointRows}
          </tbody>
        </table>
      </div>
    `;
  }).join('');

  const totalEndpoints = services.reduce((sum, s) => sum + s.endpoints.length, 0);

  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>API Endpoints • PracticeLife</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', monospace;
  background: #0a0e14;
  color: #c7cdd8;
  padding: 20px;
  line-height: 1.6;
}
.container { max-width: 1400px; margin: 0 auto; }
h1 {
  color: #00ff88;
  margin-bottom: 10px;
  font-size: 28px;
  font-weight: 600;
}
.subtitle {
  color: #7d8590;
  margin-bottom: 30px;
  font-size: 14px;
}
.stats {
  display: flex;
  gap: 20px;
  margin-bottom: 30px;
}
.stat {
  background: #151920;
  border: 1px solid #1f2937;
  border-radius: 8px;
  padding: 15px 20px;
}
.stat-value {
  color: #00ff88;
  font-size: 32px;
  font-weight: 600;
}
.stat-label {
  color: #7d8590;
  font-size: 12px;
  margin-top: 5px;
}
.service-card {
  background: #151920;
  border: 1px solid #1f2937;
  border-radius: 8px;
  margin-bottom: 25px;
  overflow: hidden;
}
.service-header {
  padding: 20px;
  border-bottom: 1px solid #1f2937;
  display: flex;
  justify-content: space-between;
  align-items: start;
}
.service-name {
  color: #fff;
  font-size: 18px;
  font-weight: 600;
  margin-bottom: 5px;
}
.service-desc {
  color: #7d8590;
  font-size: 13px;
}
.service-port {
  color: #00aaff;
  font-size: 24px;
  font-weight: 600;
}
.endpoints-table {
  width: 100%;
  border-collapse: collapse;
}
.endpoints-table th {
  background: #0d1117;
  color: #7d8590;
  padding: 12px 20px;
  text-align: left;
  font-weight: 600;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.endpoints-table td {
  padding: 12px 20px;
  border-top: 1px solid #1f2937;
  font-size: 13px;
}
.method {
  display: inline-block;
  padding: 3px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
}
.method.get {
  background: rgba(0, 170, 255, 0.1);
  color: #00aaff;
}
.method.post {
  background: rgba(0, 255, 136, 0.1);
  color: #00ff88;
}
.path {
  color: #c7cdd8;
  background: #0d1117;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
}
.desc {
  color: #7d8590;
}
</style>
</head>
<body>
<div class="container">
  ${renderNav('endpoints')}

  <h1>API Endpoints</h1>
  <div class="subtitle">Complete catalog of all localhost services and their endpoints</div>

  <div class="stats">
    <div class="stat">
      <div class="stat-value">${services.length}</div>
      <div class="stat-label">Services Running</div>
    </div>
    <div class="stat">
      <div class="stat-value">${totalEndpoints}</div>
      <div class="stat-label">Total Endpoints</div>
    </div>
  </div>

  ${serviceCards}

</div>
</body></html>`;
}

// ─── Agent Collaboration Page ─────────────────────────────────────────

function renderAgentsHTML() {
  const state = getState();
  const workers = state.agents.workers || [];
  const handoffs = state.agents.handoffs || [];
  const instances = state.agents.instances || [];
  const blockers = getDependencies().blockers || [];

  // Active agents
  const activeWorkers = workers.filter(w => w.status === 'Active');
  const parkedWorkers = workers.filter(w => w.status === 'Parked');

  const workerCards = activeWorkers.map(w => {
    const statusDot = w.status === 'Active' ? '🟢' : '🟡';
    const latestSession = instances.find(i => i.name.includes(w.name));
    const activity = latestSession ? latestSession.focus : w.focus;
    const pending = latestSession ? latestSession.pending.slice(0, 3) : [];

    return `
      <div class="agent-card active">
        <div class="agent-header">
          <div class="agent-name">${statusDot} ${w.name}</div>
          <div class="agent-meta">${w.model} • ${w.interface}</div>
        </div>
        <div class="agent-focus">${activity}</div>
        ${pending.length > 0 ? `
          <div class="agent-pending">
            ${pending.map(p => `<div class="pending-item">→ ${p}</div>`).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');

  const parkedCards = parkedWorkers.map(w => `
    <div class="agent-card parked">
      <div class="agent-header">
        <div class="agent-name">💤 ${w.name}</div>
        <div class="agent-meta">${w.model}</div>
      </div>
      <div class="agent-focus">${w.focus}</div>
    </div>
  `).join('');

  // Blockers
  const blockerRows = blockers.map(b => {
    const unblocksList = b.unblocks.length > 0
      ? `<div class="unblocks">Unblocks: ${b.unblocks.slice(0, 3).join(', ')}</div>`
      : '';
    return `
      <tr>
        <td><strong>${b.item}</strong></td>
        <td>${b.blocker}${unblocksList}</td>
      </tr>
    `;
  }).join('');

  // Recent handoffs
  const handoffCards = handoffs.map(h => `
    <div class="handoff-card">
      <div class="handoff-header">
        <div class="handoff-agent">${h.agent}</div>
        <div class="handoff-time">${h.timestamp}</div>
      </div>
      <div class="handoff-title">${h.title}</div>
      ${h.blocker ? `<div class="handoff-blocker">🚫 ${h.blocker}</div>` : ''}
      ${h.nextSteps.length > 0 ? `
        <div class="handoff-next">
          ${h.nextSteps.map(s => `<div>→ ${s}</div>`).join('')}
        </div>
      ` : ''}
    </div>
  `).join('');

  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="60">
<title>Agent Collaboration • PracticeLife</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', monospace;
  background: #0a0e14;
  color: #c7cdd8;
  padding: 20px;
  line-height: 1.6;
}
.container { max-width: 1400px; margin: 0 auto; }
h1 {
  color: #00ff88;
  margin-bottom: 10px;
  font-size: 28px;
  font-weight: 600;
}
.subtitle {
  color: #7d8590;
  margin-bottom: 30px;
  font-size: 14px;
}
nav {
  margin-bottom: 30px;
  padding-bottom: 20px;
  border-bottom: 1px solid #1f2937;
}
nav a {
  color: #7d8590;
  text-decoration: none;
  margin-right: 20px;
  font-size: 14px;
}
nav a:hover { color: #00ff88; }
.section {
  margin-bottom: 40px;
}
.section-title {
  color: #00aaff;
  font-size: 18px;
  margin-bottom: 15px;
  font-weight: 600;
}
.agent-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
  gap: 15px;
  margin-bottom: 20px;
}
.agent-card {
  background: #151920;
  border: 1px solid #1f2937;
  border-radius: 8px;
  padding: 15px;
}
.agent-card.active {
  border-left: 3px solid #00ff88;
}
.agent-card.parked {
  border-left: 3px solid #ffa500;
  opacity: 0.7;
}
.agent-header {
  display: flex;
  justify-content: space-between;
  align-items: start;
  margin-bottom: 10px;
}
.agent-name {
  color: #fff;
  font-size: 16px;
  font-weight: 600;
}
.agent-meta {
  color: #7d8590;
  font-size: 12px;
  text-align: right;
}
.agent-focus {
  color: #c7cdd8;
  font-size: 13px;
  margin-bottom: 10px;
  font-style: italic;
}
.agent-pending {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid #1f2937;
}
.pending-item {
  color: #00aaff;
  font-size: 12px;
  padding: 3px 0;
}
table {
  width: 100%;
  border-collapse: collapse;
  background: #151920;
  border-radius: 8px;
  overflow: hidden;
}
th {
  background: #1f2937;
  color: #00ff88;
  padding: 12px;
  text-align: left;
  font-weight: 600;
  font-size: 13px;
}
td {
  padding: 12px;
  border-top: 1px solid #1f2937;
  font-size: 13px;
}
.unblocks {
  color: #7d8590;
  font-size: 11px;
  margin-top: 5px;
}
.handoff-card {
  background: #151920;
  border: 1px solid #1f2937;
  border-left: 3px solid #ffa500;
  border-radius: 8px;
  padding: 15px;
  margin-bottom: 15px;
}
.handoff-header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 8px;
}
.handoff-agent {
  color: #fff;
  font-weight: 600;
  font-size: 14px;
}
.handoff-time {
  color: #7d8590;
  font-size: 12px;
}
.handoff-title {
  color: #c7cdd8;
  font-size: 13px;
  margin-bottom: 8px;
}
.handoff-blocker {
  color: #ff5555;
  font-size: 12px;
  margin-top: 8px;
  padding: 5px 8px;
  background: rgba(255, 85, 85, 0.1);
  border-radius: 4px;
}
.handoff-next {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid #1f2937;
  font-size: 12px;
  color: #00aaff;
}
.stats {
  display: flex;
  gap: 20px;
  margin-bottom: 20px;
}
.stat {
  background: #151920;
  border: 1px solid #1f2937;
  border-radius: 8px;
  padding: 15px 20px;
  flex: 1;
}
.stat-value {
  color: #00ff88;
  font-size: 32px;
  font-weight: 600;
}
.stat-label {
  color: #7d8590;
  font-size: 12px;
  margin-top: 5px;
}
</style>
</head>
<body>
<div class="container">
  ${renderNav('agents')}

  <h1>Agent Collaboration</h1>
  <div class="subtitle">Real-time multi-agent coordination status</div>

  <div class="stats">
    <div class="stat">
      <div class="stat-value">${activeWorkers.length}</div>
      <div class="stat-label">Active Agents</div>
    </div>
    <div class="stat">
      <div class="stat-value">${parkedWorkers.length}</div>
      <div class="stat-label">Parked</div>
    </div>
    <div class="stat">
      <div class="stat-value">${blockers.length}</div>
      <div class="stat-label">Blockers</div>
    </div>
    <div class="stat">
      <div class="stat-value">${handoffs.length}</div>
      <div class="stat-label">Recent Handoffs</div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">🟢 Active Agents (${activeWorkers.length})</div>
    ${activeWorkers.length > 0 ? `
      <div class="agent-grid">${workerCards}</div>
    ` : '<p style="color:#7d8590">No active agents</p>'}
  </div>

  ${parkedWorkers.length > 0 ? `
    <div class="section">
      <div class="section-title">💤 Parked Agents (${parkedWorkers.length})</div>
      <div class="agent-grid">${parkedCards}</div>
    </div>
  ` : ''}

  ${blockers.length > 0 ? `
    <div class="section">
      <div class="section-title">🚫 Blockers (${blockers.length})</div>
      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th>Blocker</th>
          </tr>
        </thead>
        <tbody>
          ${blockerRows}
        </tbody>
      </table>
    </div>
  ` : ''}

  ${handoffs.length > 0 ? `
    <div class="section">
      <div class="section-title">📋 Recent Handoffs (${handoffs.length})</div>
      ${handoffCards}
    </div>
  ` : ''}

</div>
</body></html>`;
}

server.listen(PORT, () => {
  console.log(`\n  Ω₀ PracticeLife Dashboard`);
  console.log(`  ========================`);
  console.log(`  https://localhost:${PORT}`);
  console.log(`  API: https://localhost:${PORT}/api/state`);
  console.log(`  History: https://localhost:${PORT}/api/history\n`);
});

// ─── Dependencies page ───────────────────────────────────────────────

function renderDepsHTML() {
  const data = getDependencies();

  // Current work section
  const workHTML = data.currentWork.map(w => {
    const actions = w.recentActions.slice(0, 5).map(a =>
      `<div class="action">→ ${a.replace(/^\*\*[^*]+\*\*\s*[—–-]+\s*/, '')}</div>`
    ).join('');
    return `<div class="work-card">
  <div class="work-header">
    <span class="work-agent">${w.agent}</span>
    <span class="work-session">${w.session}</span>
  </div>
  <div class="work-focus">${w.focus}</div>
  <div class="work-recent">${actions || '<div class="action-empty">Starting up...</div>'}</div>
</div>`;
  }).join('');

  // Blockers section
  const blockersHTML = data.blockers.map(b => {
    const unblocksList = b.unblocks.length > 0
      ? b.unblocks.map(u => `<li>${u}</li>`).join('')
      : '<li class="empty">No downstream dependencies identified</li>';
    const count = b.unblocks.length;
    const countColor = count === 0 ? '#555' : count < 2 ? '#ffaa00' : '#ff4444';
    return `<div class="blocker-card">
  <div class="blocker-header">
    <span class="blocker-item">${b.item}</span>
    <span class="blocker-count" style="color:${countColor}">${count} blocked</span>
  </div>
  <div class="blocker-desc">${b.blocker}</div>
  <div class="blocker-unblocks">
    <div class="unblocks-label">This blocks:</div>
    <ul class="unblocks-list">${unblocksList}</ul>
  </div>
</div>`;
  }).join('');

  const blockerCount = data.blockers.length;
  const totalBlocked = data.blockers.reduce((sum, b) => sum + b.unblocks.length, 0);

  return `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<title>Ω₀ Dependencies</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#0a0a0a; color:#e0e0e0; font-family:'SF Mono','Fira Code',monospace; padding:20px; }
h1 { color:#00ff88; font-size:28px; margin-bottom:4px; }
.subtitle { color:#666; margin-bottom:20px; font-size:13px; }
.nav { display:flex; gap:16px; margin-bottom:20px; }
.nav a { color:#555; font-size:13px; padding:4px 12px; border:1px solid #222; border-radius:6px; text-decoration:none; }
.nav a:hover, .nav a.active { color:#00ff88; border-color:#00ff88; }

.summary { display:flex; gap:16px; margin-bottom:24px; }
.scard { background:#151515; border:1px solid #222; border-radius:8px; padding:12px 20px; text-align:center; }
.scard .num { font-size:32px; font-weight:bold; }
.scard .label { color:#555; font-size:11px; text-transform:uppercase; letter-spacing:1px; margin-top:4px; }
.num.blocker { color:#ff4444; }
.num.blocked { color:#ffaa00; }

.section { margin-bottom:32px; }
.section-title { color:#00aaff; font-size:14px; text-transform:uppercase; letter-spacing:1px; margin-bottom:12px; padding-bottom:6px; border-bottom:1px solid #222; }

.work-card { background:#111; border-left:3px solid #00ff88; border-radius:8px; padding:16px; margin-bottom:12px; }
.work-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; }
.work-agent { font-size:16px; font-weight:bold; color:#00ff88; }
.work-session { font-size:11px; color:#444; font-family:monospace; }
.work-focus { color:#999; font-size:13px; margin-bottom:12px; }
.work-recent { margin-top:12px; padding-top:12px; border-top:1px solid #1a1a1a; }
.action { color:#666; font-size:12px; padding:4px 0; line-height:1.4; }
.action-empty { color:#444; font-style:italic; }

.blocker-card { background:#111; border-left:3px solid #ff4444; border-radius:8px; padding:16px; margin-bottom:12px; }
.blocker-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; }
.blocker-item { font-size:15px; font-weight:bold; color:#ff4444; }
.blocker-count { font-size:11px; font-weight:bold; padding:2px 8px; background:#1a1a1a; border-radius:4px; }
.blocker-desc { color:#999; font-size:12px; margin-bottom:12px; }
.blocker-unblocks { margin-top:12px; padding-top:12px; border-top:1px solid #1a1a1a; }
.unblocks-label { color:#555; font-size:11px; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px; }
.unblocks-list { list-style:none; }
.unblocks-list li { color:#ffaa00; font-size:12px; padding:4px 0; padding-left:12px; position:relative; }
.unblocks-list li:before { content:'▸'; position:absolute; left:0; color:#ff4444; }
.unblocks-list li.empty { color:#444; font-style:italic; }
.unblocks-list li.empty:before { content:''; }

.timestamp { color:#333; font-size:11px; text-align:right; margin-top:24px; }
</style>
</head><body>
${renderNav('deps')}

<h1>Ω₀ Dependencies</h1>
<div class="subtitle">Real-time blocker tracking — What needs you, what it holds up — Auto-refresh 10s</div>

<div class="summary">
  <div class="scard">
    <div class="num blocker">${blockerCount}</div>
    <div class="label">Human Actions Needed</div>
  </div>
  <div class="scard">
    <div class="num blocked">${totalBlocked}</div>
    <div class="label">Threads Blocked</div>
  </div>
</div>

<div class="section">
  <div class="section-title">🤖 What Claude is Working On</div>
  ${workHTML || '<div style="color:#444;padding:12px;font-style:italic">No active work detected</div>'}
</div>

<div class="section">
  <div class="section-title">⏸️ Blocked on Peretz</div>
  ${blockersHTML || '<div style="color:#444;padding:12px;font-style:italic">Nothing blocked! 🎉</div>'}
</div>

<div class="timestamp">Updated ${new Date().toLocaleString()} · Sources: Home.md + session logs + MEMORY.md</div>

<script>
setInterval(async()=>{
  try{
    const r=await fetch('/deps');
    const h=await r.text();
    document.open();
    document.write(h);
    document.close();
  }catch{}
}, 10000);
</script>

</body></html>`;
}

// ─── Tasks Page ───────────────────────────────────────────────────────
function renderTasksHTML() {
  try {
    const prompts = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.claude/suggested-prompts.json'), 'utf8'));
    const byStatus = {
      ready: prompts.prompts.filter(p => p.status === 'ready'),
      in_progress: prompts.prompts.filter(p => p.status === 'in_progress'),
      complete: prompts.prompts.filter(p => p.status === 'complete'),
      blocked: prompts.prompts.filter(p => p.status === 'blocked'),
      partial: prompts.prompts.filter(p => p.status === 'partial')
    };
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Tasks | Ω₀</title><style>* { margin:0; padding:0; box-sizing:border-box; } body { background:#0a0a0a; color:#e0e0e0; font-family:'SF Mono','Fira Code',monospace; padding:20px; } .container { max-width:1200px; margin:0 auto; } h1 { color:#00ff88; font-size:28px; margin-bottom:20px; } .status-section { margin-bottom:40px; } .status-header { color:#00aaff; font-size:20px; margin-bottom:12px; } .task-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(350px,1fr)); gap:16px; } .task-card { background:#0d0d0d; border:1px solid #1a1a1a; border-left:3px solid #00ff88; border-radius:8px; padding:16px; } .task-card.in_progress { border-left-color:#00aaff; } .task-card.blocked { border-left-color:#ff4444; } .task-card.partial { border-left-color:#ffaa00; } .task-card.ready { border-left-color:#00ff88; } .task-title { color:#fff; font-size:14px; font-weight:600; margin-bottom:8px; } .task-meta { color:#666; font-size:11px; margin-bottom:4px; } .task-agent { color:#00aaff; font-size:12px; } .task-notes { background:#1a1a1a; padding:8px; margin-top:8px; font-size:11px; color:#999; border-radius:4px; }</style></head><body><div class="container">${renderNav('/tasks')}<h1>🎯 Task Delegation</h1><div class="status-section"><div class="status-header">📋 Ready (${byStatus.ready.length})</div><div class="task-grid">${byStatus.ready.map(t => `<div class="task-card ready"><div class="task-title">${t.title}</div><div class="task-meta">${t.category} · ${t.estimated_cost} · ${t.estimated_time}</div></div>`).join('')}</div></div><div class="status-section"><div class="status-header">🔄 In Progress (${byStatus.in_progress.length})</div><div class="task-grid">${byStatus.in_progress.map(t => `<div class="task-card in_progress"><div class="task-title">${t.title}</div><div class="task-meta">${t.category}</div>${t.completed_by ? `<div class="task-agent">Agent: ${t.completed_by}</div>` : ''}</div>`).join('')}</div></div><div class="status-section"><div class="status-header">✅ Complete (${byStatus.complete.length})</div><div class="task-grid">${byStatus.complete.slice(0, 6).map(t => `<div class="task-card complete" style="opacity:0.6"><div class="task-title">${t.title}</div>${t.completed_by ? `<div class="task-agent">${t.completed_by}</div>` : ''}${t.notes ? `<div class="task-notes">${t.notes.substring(0, 100)}...</div>` : ''}</div>`).join('')}</div></div>${byStatus.blocked.length > 0 ? `<div class="status-section"><div class="status-header">🚧 Blocked (${byStatus.blocked.length})</div><div class="task-grid">${byStatus.blocked.map(t => `<div class="task-card blocked"><div class="task-title">${t.title}</div>${t.notes ? `<div class="task-notes">${t.notes}</div>` : ''}</div>`).join('')}</div></div>` : ''}</div></body></html>`;
  } catch (e) {
    return `<!DOCTYPE html><html><body><h1>Error loading tasks</h1><pre>${e.message}</pre></body></html>`;
  }
}
