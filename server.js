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

  // Philological pipeline stats
  const ATLAS_DB = path.join(process.env.HOME, 'tools/memoryatlas/data/atlas.db');
  const philoPolished = run(`sqlite3 "${ATLAS_DB}" "SELECT COUNT(*) FROM asset WHERE polished_at IS NOT NULL" 2>/dev/null`) || '0';
  const philoTotal = run(`sqlite3 "${ATLAS_DB}" "SELECT COUNT(*) FROM asset WHERE transcript_lang <> 'en' AND transcript_lang IS NOT NULL AND transcript_status = 'done'" 2>/dev/null`) || '0';
  const philoLangs = run(`sqlite3 "${ATLAS_DB}" "SELECT GROUP_CONCAT(DISTINCT transcript_lang) FROM asset WHERE transcript_lang <> 'en' AND transcript_lang IS NOT NULL AND transcript_status = 'done'" 2>/dev/null`) || '';
  const philoRunning = run(`ps aux | grep 'polish' | grep -v grep | wc -l 2>/dev/null`).trim() !== '0';

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
  const litellmLive = run('curl -s -o /dev/null -w "%{http_code}" --max-time 1 http://127.0.0.1:4000/health/readiness 2>/dev/null') === '200';
  const ollamaLive = run('curl -s -o /dev/null -w "%{http_code}" --max-time 1 http://127.0.0.1:11434/api/tags 2>/dev/null') === '200';
  const langfuseLive = run('curl -s -o /dev/null -w "%{http_code}" --max-time 1 http://127.0.0.1:3005 2>/dev/null') === '200';

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

  // Memory pressure alarm (crash prevention — WindowServer died at 141GB on 64GB)
  let memory = { free_gb: null, compressor_gb: null, alarm: false, alarm_reason: null };
  try {
    const vmstat = run('vm_stat 2>/dev/null', 3000);
    const pageSize = 16384; // Apple Silicon default
    const freePages = parseInt((vmstat.match(/Pages free:\s+(\d+)/) || [])[1] || '0');
    const compressorPages = parseInt((vmstat.match(/Pages occupied by compressor:\s+(\d+)/) || [])[1] || '0');
    memory.free_gb = parseFloat((freePages * pageSize / 1073741824).toFixed(1));
    memory.compressor_gb = parseFloat((compressorPages * pageSize / 1073741824).toFixed(1));
    if (memory.compressor_gb > 20) { memory.alarm = true; memory.alarm_reason = `Compressor ${memory.compressor_gb}GB (>20GB)`; }
    if (memory.free_gb < 2) { memory.alarm = true; memory.alarm_reason = `Free ${memory.free_gb}GB (<2GB)`; }
  } catch {}

  // Token usage / wallet
  let wallet = { total_tokens: 0, cost: { total: 0 }, saved_by_cache: 0 };
  try {
    const usageJson = run('node ~/.claude/prompt-store.js usage 2>/dev/null', 10000);
    wallet = JSON.parse(usageJson);
  } catch {}

  return {
    timestamp: new Date().toISOString(),
    system: { diskUsage, uptime: uptime.replace(/.*up/, 'up'), volumes: volumes.split('\n'), memory },
    downloads: { total: downloads, organized_folders: downloadsOrg, loose_files: downloadsLoose },
    memoryatlas: { total: atlasTotal, hours: atlasHours, transcribed: atlasTranscribed, published: atlasPublished },
    philological: { polished: philoPolished, total: philoTotal, languages: philoLangs, running: philoRunning },
    vault: { total_notes: obsidianFiles, home_updated: homeUpdated },
    calendar: { events: calEvents, fetched: calFetched },
    agents: { sessionLogs, protocolActive: protocolExists, apiLive, promptBrowserLive, contactVerifyLive, downloadDaemonLive, litellmLive, ollamaLive, langfuseLive, workers, handoffs, promptTotal, promptSessions, instances },
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
  { id: 43, name: 'Tailscale VPN', status: 'running', icon: '🔄', detail: 'Mac Studio connected (100.119.7.102). Next: Install app on iPhone/iPad, enable subnet routes in admin console.' },
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
    { path: '/command', name: 'Command', key: 'command' },
    { path: '/machines', name: 'Machines', key: 'machines' },
    { path: '/briefing', name: 'Briefing', key: 'briefing' },
    { path: '/blockers', name: 'Convergence', key: 'blockers' },
    { path: '/agents', name: 'Agents', key: 'agents' },
    { path: '/threads', name: 'Threads', key: 'threads' },
    { path: '/fleet', name: 'Fleet', key: 'fleet' },
    { path: '/stream', name: 'Life Stream', key: 'stream' },
    { path: '/deps', name: 'Dependencies', key: 'deps' },
    { path: '/plan', name: 'Plan Tracker', key: 'plan' },
    { path: '/endpoints', name: 'API', key: 'endpoints' },
    { path: '/philological', name: 'Philological', key: 'philological' },
    { path: '/prompts', name: 'Prompts', key: 'prompts' },
    { path: '/search', name: 'Search', key: 'search' },
    { path: '/cheatsheet', name: 'Cheatsheet', key: 'cheatsheet' },
    { path: '/queue', name: 'Queue', key: 'queue' },
    { path: '/files', name: 'Files', key: 'files' },
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
  <div class="card" style="border-left:3px solid ${state.philological.running ? '#ffaa00' : parseInt(state.philological.polished) === parseInt(state.philological.total) ? '#00ff88' : '#555'}">
    <h3><a href="/philological" style="color:inherit;text-decoration:none">Philological</a></h3>
    <div class="value">${state.philological.polished}/${state.philological.total}</div>
    <div class="sub">${state.philological.running ? '🔄 polishing...' : 'restored + translated'} · ${state.philological.languages || 'none'}</div>
  </div>
  <div class="card clickable" data-metric="downloads" data-label="Downloads">
    <h3>Downloads</h3>
    <div class="value" id="v-downloads">${state.downloads.loose_files}</div>
    <div class="sub">loose files (${state.downloads.organized_folders} folders)</div>
  </div>
</div>

<div id="spend-details" style="display:none; background:#0d1117; border:1px solid #30363d; border-radius:8px; padding:20px; margin:20px 0;">
  <h2 style="color:#ff4444; margin-bottom:16px;">💳 Real Bills You Actually Pay</h2>
  <div style="background:#1a1a2e; padding:16px; border-radius:6px; margin-bottom:16px; border-left:4px solid #ff4444;">
    <table style="width:100%; font-size:14px;">
      <tr><td><strong>Cursor Pro</strong></td><td style="text-align:right; color:#ff4444;"><strong>$20.00/mo</strong></td></tr>
      <tr><td style="padding-left:16px; color:#888; font-size:12px;">Unlimited tab completions + agent mode</td><td></td></tr>
      <tr style="height:12px;"><td colspan="2"></td></tr>
      <tr><td><strong>Claude Code / Anthropic API</strong></td><td style="text-align:right; color:#888;">Check console ⤵</td></tr>
      <tr><td colspan="2" style="padding-top:4px; font-size:12px; color:#888;">
        → <a href="https://console.anthropic.com/settings/billing" target="_blank" style="color:#00ff88;">console.anthropic.com/settings/billing</a><br>
        <span style="color:#666;">Depends on: Claude Pro subscription ($20/mo unlimited) vs API credits (pay-per-token)</span>
      </td></tr>
      <tr style="height:12px;"><td colspan="2"></td></tr>
      <tr style="border-top:1px solid #333;"><td><strong>Total Known</strong></td><td style="text-align:right; color:#ff4444;"><strong>$20-40/mo</strong></td></tr>
      <tr><td colspan="2" style="font-size:11px; color:#666; padding-top:4px;">Cursor confirmed · Claude depends on plan</td></tr>
    </table>
  </div>

  <h2 style="color:#888; margin:24px 0 16px 0;">📊 Token Metrics (Theoretical - Not Billed)</h2>
  <div style="background:#151515; padding:16px; border-radius:6px; margin-bottom:16px; border-left:4px solid #888;">
    <p style="margin-bottom:8px; color:#888;"><strong>What this is:</strong> Efficiency tracking based on token counts × published pricing.</p>
    <p style="font-size:13px; color:#666;">These numbers are NOT bills. They show what it WOULD cost if paying per-token, useful for tracking cache efficiency.</p>
  </div>
  <table style="width:100%; font-size:13px; color:#888;">
    <tr><td><strong style="color:#ccc;">Theoretical Cost (if paying per-token):</strong></td><td style="text-align:right; color:#888;">\$${state.wallet.cost ? state.wallet.cost.total.toFixed(2) : '0.00'}</td></tr>
    <tr><td style="padding-left:16px;">Input tokens</td><td style="text-align:right;">\$${state.wallet.cost ? state.wallet.cost.input.toFixed(2) : '0.00'}</td></tr>
    <tr><td style="padding-left:16px;">Output tokens</td><td style="text-align:right;">\$${state.wallet.cost ? state.wallet.cost.output.toFixed(2) : '0.00'}</td></tr>
    <tr><td style="padding-left:16px;">Cache create</td><td style="text-align:right;">\$${state.wallet.cost ? state.wallet.cost.cache_create.toFixed(2) : '0.00'}</td></tr>
    <tr><td style="padding-left:16px;">Cache read</td><td style="text-align:right;">\$${state.wallet.cost ? state.wallet.cost.cache_read.toFixed(2) : '0.00'}</td></tr>
    <tr style="border-top:1px solid #333;"><td><strong style="color:#00ff88;">Cache Efficiency Gain:</strong></td><td style="text-align:right; color:#00ff88;"><strong>\$${state.wallet.saved_by_cache ? state.wallet.saved_by_cache.toFixed(2) : '0.00'}</strong></td></tr>
    <tr><td colspan="2" style="font-size:12px; color:#666; padding-top:8px;">Without caching: \$${state.wallet.cost && state.wallet.saved_by_cache ? (state.wallet.cost.total + state.wallet.saved_by_cache).toFixed(2) : '0.00'} · <strong style="color:#00ff88;">${state.wallet.cost && state.wallet.saved_by_cache ? ((state.wallet.saved_by_cache / (state.wallet.cost.total + state.wallet.saved_by_cache)) * 100).toFixed(1) : '0'}% efficient</strong></td></tr>
  </table>
  <details style="margin-top:20px;">
    <summary style="cursor:pointer; color:#00ccff; font-weight:bold;">📊 View ${state.wallet.sessions || 0} Sessions (click to expand)</summary>
    <div style="max-height:400px; overflow-y:auto; margin-top:12px; background:#0a0a0a; padding:12px; border-radius:4px; font-family:monospace; font-size:11px;">
      ${state.wallet.by_session ? state.wallet.by_session.map(s => {
        const color = s.model.includes('opus') ? '#ffaa00' : s.model.includes('sonnet') ? '#00ccff' : '#00ff88';
        return `<div style="margin-bottom:8px; padding:8px; background:#151515; border-left:3px solid ${color}; border-radius:3px;">
          <strong>${s.session_id}</strong> · ${s.model}<br>
          <span style="color:#888;">In: ${(s.input/1000).toFixed(0)}K | Out: ${(s.output/1000).toFixed(0)}K | Cache: ${(s.cache_read/1e6).toFixed(1)}M | Total: ${(s.total/1e6).toFixed(1)}M</span>
        </div>`;
      }).join('') : 'No session data'}
    </div>
  </details>
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
    <div class="card clickable" style="border-color:#ff4444aa" data-metric="real-bills" data-label="Real Bills" onclick="document.getElementById('spend-details').style.display = document.getElementById('spend-details').style.display === 'none' ? 'block' : 'none'">
      <h3>💳 Real Bills <span style="font-size:14px">▼</span></h3>
      <div class="value" style="color:#ff4444" id="v-real-cost">$20</div>
      <div class="sub">Cursor Pro/mo · click to expand</div>
    </div>
    <div class="card clickable" style="border-color:#88888833" data-metric="token-metrics" data-label="Token Metrics">
      <h3>Token Metrics</h3>
      <div class="value" style="color:#888" id="v-theoretical">$${state.wallet.cost ? state.wallet.cost.total.toFixed(0) : '—'}</div>
      <div class="sub">theoretical · tracking only</div>
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
      <div class="agent-status"><span class="dot ${state.agents.litellmLive ? 'live' : 'down'}"></span> <a href="http://localhost:4000" style="color:#e0e0e0">LiteLLM Gateway</a> <span style="color:#555">:4000</span></div>
      <div class="agent-status"><span class="dot ${state.agents.ollamaLive ? 'live' : 'down'}"></span> <a href="http://localhost:11434" style="color:#e0e0e0">Ollama</a> <span style="color:#555">:11434</span></div>
      <div class="agent-status"><span class="dot ${state.agents.langfuseLive ? 'live' : 'down'}"></span> <a href="http://localhost:3005" style="color:#e0e0e0">Langfuse</a> <span style="color:#555">:3005</span></div>
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

// ─── Philological Pipeline Page ──────────────────────────────────────

function getPhilologicalData() {
  const ATLAS_DB = path.join(process.env.HOME, 'tools/memoryatlas/data/atlas.db');
  const polished = parseInt(run(`sqlite3 "${ATLAS_DB}" "SELECT COUNT(*) FROM asset WHERE polished_at IS NOT NULL" 2>/dev/null`)) || 0;
  const totalNonEn = parseInt(run(`sqlite3 "${ATLAS_DB}" "SELECT COUNT(*) FROM asset WHERE transcript_lang <> 'en' AND transcript_lang IS NOT NULL AND transcript_status = 'done'" 2>/dev/null`)) || 0;
  const isRunning = run(`ps aux | grep 'polish' | grep -v grep | wc -l 2>/dev/null`).trim() !== '0';

  // Language breakdown
  let langBreakdown = [];
  try {
    const langRows = run(`sqlite3 -json "${ATLAS_DB}" "SELECT transcript_lang as lang, COUNT(*) as total, SUM(CASE WHEN polished_at IS NOT NULL THEN 1 ELSE 0 END) as polished, ROUND(SUM(duration_sec)/60.0, 1) as minutes FROM asset WHERE transcript_lang <> 'en' AND transcript_lang IS NOT NULL AND transcript_status = 'done' GROUP BY transcript_lang ORDER BY total DESC" 2>/dev/null`, 5000);
    if (langRows && langRows.startsWith('[')) langBreakdown = JSON.parse(langRows);
  } catch {}

  // Recent polished samples (last 5)
  let recentSamples = [];
  try {
    const samplesRaw = run(`sqlite3 -json "${ATLAS_DB}" "SELECT title, transcript_lang, ROUND(duration_sec/60.0, 1) as minutes, polished_at, SUBSTR(translated_text, 1, 300) as translation_preview, SUBSTR(restored_text, 1, 300) as restored_preview FROM asset WHERE polished_at IS NOT NULL ORDER BY polished_at DESC LIMIT 5" 2>/dev/null`, 5000);
    if (samplesRaw && samplesRaw.startsWith('[')) recentSamples = JSON.parse(samplesRaw);
  } catch {}

  // Remaining to polish
  let remaining = [];
  try {
    const remainRaw = run(`sqlite3 -json "${ATLAS_DB}" "SELECT title, transcript_lang, ROUND(duration_sec/60.0, 1) as minutes FROM asset WHERE transcript_lang <> 'en' AND transcript_lang IS NOT NULL AND transcript_status = 'done' AND polished_at IS NULL ORDER BY duration_sec DESC LIMIT 10" 2>/dev/null`, 5000);
    if (remainRaw && remainRaw.startsWith('[')) remaining = JSON.parse(remainRaw);
  } catch {}

  // Total hours by status
  const totalHoursPolished = parseFloat(run(`sqlite3 "${ATLAS_DB}" "SELECT ROUND(SUM(duration_sec)/3600.0, 1) FROM asset WHERE polished_at IS NOT NULL" 2>/dev/null`)) || 0;
  const totalHoursRemaining = parseFloat(run(`sqlite3 "${ATLAS_DB}" "SELECT ROUND(SUM(duration_sec)/3600.0, 1) FROM asset WHERE transcript_lang <> 'en' AND transcript_lang IS NOT NULL AND transcript_status = 'done' AND polished_at IS NULL" 2>/dev/null`)) || 0;

  return {
    polished, total: totalNonEn, running: isRunning,
    pct: totalNonEn > 0 ? Math.round(polished / totalNonEn * 100) : 0,
    hoursPolished: totalHoursPolished, hoursRemaining: totalHoursRemaining,
    langBreakdown, recentSamples, remaining,
  };
}

function renderPhilologicalHTML() {
  const data = getPhilologicalData();
  const LANG_NAMES = { ru: 'Russian', ja: 'Japanese', ko: 'Korean', tr: 'Turkish', pt: 'Portuguese', is: 'Icelandic', zh: 'Chinese', de: 'German', fr: 'French' };
  const pct = data.pct;
  const barColor = data.running ? '#ffaa00' : pct === 100 ? '#00ff88' : '#4488ff';

  const langCards = data.langBreakdown.map(l => {
    const name = LANG_NAMES[l.lang] || l.lang;
    const lPct = l.total > 0 ? Math.round(l.polished / l.total * 100) : 0;
    const flag = { ru: '\u{1F1F7}\u{1F1FA}', ja: '\u{1F1EF}\u{1F1F5}', ko: '\u{1F1F0}\u{1F1F7}', tr: '\u{1F1F9}\u{1F1F7}', pt: '\u{1F1E7}\u{1F1F7}', is: '\u{1F1EE}\u{1F1F8}' }[l.lang] || '\u{1F310}';
    return `<div style="background:#111;border:1px solid #222;border-radius:8px;padding:16px;min-width:140px">
      <div style="font-size:24px;margin-bottom:4px">${flag}</div>
      <div style="font-size:18px;font-weight:bold;color:#eee">${name}</div>
      <div style="font-size:28px;font-weight:bold;color:${lPct===100?'#00ff88':'#4488ff'}">${l.polished}/${l.total}</div>
      <div style="font-size:12px;color:#888">${l.minutes} min · ${lPct}%</div>
      <div style="background:#222;border-radius:4px;height:4px;margin-top:8px">
        <div style="background:${lPct===100?'#00ff88':'#4488ff'};height:4px;border-radius:4px;width:${lPct}%"></div>
      </div>
    </div>`;
  }).join('\n');

  const sampleCards = data.recentSamples.map(s => {
    const tPreview = (s.translation_preview || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const rPreview = (s.restored_preview || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<div style="background:#111;border:1px solid #222;border-radius:8px;padding:16px;margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <span style="font-weight:bold;color:#eee">${(s.title || '').replace(/</g, '&lt;')}</span>
        <span style="font-size:12px;color:#666">${s.transcript_lang} · ${s.minutes}min · ${s.polished_at ? s.polished_at.slice(0, 16) : ''}</span>
      </div>
      <div style="background:#0a1628;border-left:3px solid #4488ff;padding:12px;border-radius:4px;margin-bottom:8px">
        <div style="font-size:11px;color:#4488ff;margin-bottom:4px;font-weight:bold">TRANSLATION</div>
        <div style="font-size:13px;color:#ccc;line-height:1.5">${tPreview}${tPreview.length >= 295 ? '...' : ''}</div>
      </div>
      <div style="background:#1a0a0a;border-left:3px solid #ff6644;padding:12px;border-radius:4px">
        <div style="font-size:11px;color:#ff6644;margin-bottom:4px;font-weight:bold">RESTORED SOURCE</div>
        <div style="font-size:13px;color:#aaa;line-height:1.5">${rPreview}${rPreview.length >= 295 ? '...' : ''}</div>
      </div>
    </div>`;
  }).join('\n');

  const remainingRows = data.remaining.map(r =>
    `<tr><td style="color:#eee">${(r.title || '').replace(/</g, '&lt;')}</td><td style="color:#888">${r.transcript_lang}</td><td style="text-align:right;color:#666">${r.minutes}min</td></tr>`
  ).join('\n');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Philological Pipeline</title>
<style>
  body { font-family: 'SF Mono', 'Menlo', monospace; background: #0a0a0a; color: #ccc; margin: 0; padding: 20px; }
  a { color: #00ff88; }
</style></head><body>
${renderNav('philological')}
<h1 style="color:#eee;margin-bottom:4px">\u{1F4DC} Philological Pipeline</h1>
<p style="color:#666;margin-top:0;font-size:13px">Source restoration + literary translation \u2014 not transcription, resurrection.</p>

<div style="display:flex;gap:24px;align-items:center;margin:20px 0;padding:20px;background:#111;border-radius:8px;border:1px solid #222">
  <div>
    <div style="font-size:48px;font-weight:bold;color:${barColor}">${data.polished}<span style="font-size:24px;color:#555">/${data.total}</span></div>
    <div style="font-size:13px;color:#888">${data.running ? '\u{1F7E1} Pipeline running...' : pct === 100 ? '\u2705 All polished' : '\u23F8 Idle'}</div>
  </div>
  <div style="flex:1">
    <div style="background:#222;border-radius:6px;height:20px;overflow:hidden">
      <div style="background:${barColor};height:20px;border-radius:6px;width:${pct}%;transition:width 0.5s;display:flex;align-items:center;justify-content:center">
        <span style="font-size:11px;font-weight:bold;color:#000">${pct}%</span>
      </div>
    </div>
    <div style="display:flex;justify-content:space-between;margin-top:6px;font-size:12px;color:#666">
      <span>${data.hoursPolished}h polished</span>
      <span>${data.hoursRemaining}h remaining</span>
      <span>${(data.hoursPolished + data.hoursRemaining).toFixed(1)}h total</span>
    </div>
  </div>
</div>

<h2 style="color:#888;font-size:16px;margin-top:28px">Languages</h2>
<div style="display:flex;gap:12px;flex-wrap:wrap">${langCards}</div>

<h2 style="color:#888;font-size:16px;margin-top:28px">Recent Translations</h2>
${sampleCards || '<div style="color:#555">No polished transcripts yet.</div>'}

${data.remaining.length > 0 ? `
<h2 style="color:#888;font-size:16px;margin-top:28px">Queue (${data.total - data.polished} remaining)</h2>
<table style="width:100%;font-size:13px;border-collapse:collapse">
  <tr style="border-bottom:1px solid #222"><th style="text-align:left;color:#555;padding:6px 0">Title</th><th style="color:#555">Lang</th><th style="text-align:right;color:#555">Duration</th></tr>
  ${remainingRows}
</table>
` : ''}

<div style="margin-top:32px;padding:16px;background:#0a1628;border-radius:8px;border:1px solid #1a3a6a">
  <h3 style="color:#4488ff;margin-top:0">The Principle</h3>
  <p style="color:#888;font-size:13px;line-height:1.6;margin-bottom:0">
    Peretz has an MPhil in Literature and a PhD in Biology. His father taught at Cornell in the building where Nabokov worked.
    The voice memos contain 675 hours of life \u2014 family stories, scientific discussions, immigration narratives, poetic observations.<br><br>
    Whisper transcribes accurately but flatly. It captures phonemes, not meaning.
    The philological pipeline restores meaning \u2014 first in the language it was spoken, then in the language it will be read.<br><br>
    <em style="color:#aaa">This is not a feature. It is an act of care.</em>
  </p>
</div>

<div style="margin-top:16px;font-size:12px;color:#333">
  Auto-refresh 30s \u00B7 <a href="/api/philological" style="color:#333">JSON</a> \u00B7 Model: qwen2.5:32b (local) \u00B7 Pipeline: <code>atlas polish</code>
</div>
<script>setInterval(async()=>{try{const r=await fetch('/philological');const h=await r.text();document.open();document.write(h);document.close()}catch{}},30000);</script>
</body></html>`;
}

// ─── Daily Briefing / Eisenhower Matrix ──────────────────────────────

const TASKS_FILE = path.join(process.env.HOME, '.claude/TASKS.md');

function getBriefingData() {
  let tasksContent = '';
  try { tasksContent = fs.readFileSync(TASKS_FILE, 'utf8'); } catch { return { quadrants: [], services: [], generated: new Date().toISOString() }; }

  // Parse TASKS.md — current format uses numbered sections with [OWNER] tags
  const items = [];
  const lines = tasksContent.split('\n');
  let currentSection = '';
  let currentTask = null;
  let skipSection = false;

  for (const line of lines) {
    // Section headers: ## 1. TIME-SENSITIVE, ## 2. POST-REBOOT, etc.
    if (line.startsWith('## ')) {
      if (currentTask) { items.push(currentTask); currentTask = null; }
      const sectionLower = line.toLowerCase();
      if (sectionLower.includes('time-sensitive')) { currentSection = 'urgent'; skipSection = false; }
      else if (sectionLower.includes('post-reboot') || sectionLower.includes('claude executes')) { currentSection = 'claude-do'; skipSection = false; }
      else if (sectionLower.includes('review queue')) { currentSection = 'review'; skipSection = false; }
      else if (sectionLower.includes('5-minute') || sectionLower.includes('low-hanging')) { currentSection = 'quick'; skipSection = false; }
      else if (sectionLower.includes('infrastructure')) { currentSection = 'infra'; skipSection = false; }
      else if (sectionLower.includes('data work')) { currentSection = 'data'; skipSection = false; }
      else if (sectionLower.includes('peretz-blocked') || sectionLower.includes('peretz blocked')) { currentSection = 'blocked'; skipSection = false; }
      else if (sectionLower.includes('someday') || sectionLower.includes('simmering')) { currentSection = 'simmering'; skipSection = false; }
      else if (sectionLower.includes('completed') || sectionLower.includes('anvil workload queue')) { currentSection = 'done'; skipSection = true; }
      else { skipSection = true; }
      continue;
    }
    if (skipSection) continue;

    // Task titles: ### 1a. [PERETZ] Title — extra
    const taskMatch = line.match(/^### \d+\w*\.\s*(.+)/);
    if (taskMatch) {
      if (currentTask) items.push(currentTask);
      const raw = taskMatch[1];
      // Skip DONE items
      if (/—\s*DONE\s*$/i.test(raw) || /—\s*COMPLETE\s*$/i.test(raw)) { currentTask = null; continue; }
      // Extract owner from [PERETZ], [CLAUDE], [TOGETHER]
      const ownerMatch = raw.match(/\[(\w+)\]\s*/);
      const owner = ownerMatch ? ownerMatch[1] : '';
      const title = raw.replace(/\[\w+\]\s*/, '').replace(/[🚨⚡🔴]/g, '').trim();
      currentTask = { title, section: currentSection, owner, details: [], status: '' };
      continue;
    }

    // Checkbox items in quick-action sections: - [ ] or - [x]
    if (currentSection === 'quick' && /^- \[[ x]\]/.test(line)) {
      if (/^- \[x\]/.test(line)) continue; // Skip done items
      if (currentTask) items.push(currentTask);
      const title = line.replace(/^- \[ \]\s*/, '').trim();
      currentTask = { title, section: 'quick', owner: 'PERETZ', details: [], status: '' };
      continue;
    }

    // Checkbox items in blocked section
    if (currentSection === 'blocked' && /^- \[[ x]\]/.test(line)) {
      if (/^- \[x\]/.test(line)) continue;
      if (currentTask) items.push(currentTask);
      const title = line.replace(/^- \[ \]\s*/, '').trim();
      currentTask = { title, section: 'blocked', owner: 'PERETZ', details: [], status: '' };
      continue;
    }

    // Simmering items are bare bullet points
    if (currentSection === 'simmering' && line.startsWith('- ')) {
      if (currentTask) items.push(currentTask);
      const title = line.replace(/^- /, '').trim();
      currentTask = { title, section: 'simmering', owner: '', details: [], status: '' };
      continue;
    }

    // Detail lines under current task
    if (currentTask && line.startsWith('- ') && !line.startsWith('- [x]')) {
      const detail = line.replace(/^- /, '').trim();
      if (!/— DONE|COMPLETE/i.test(detail)) currentTask.details.push(detail);
    }
  }
  if (currentTask) items.push(currentTask);

  // Eisenhower classification based on section
  const q1 = []; // DO NOW: time-sensitive + peretz-blocked
  const q2 = []; // SCHEDULE: infra + data + claude-do (not done)
  const q3 = []; // QUICK WINS: 5-min actions + review queue
  const q4 = []; // LATER: simmering

  for (const item of items) {
    switch (item.section) {
      case 'urgent':   q1.push(item); break;
      case 'blocked':  q1.push(item); break;
      case 'claude-do': q2.push(item); break;
      case 'infra':    q2.push(item); break;
      case 'data':     q2.push(item); break;
      case 'review':   q3.push(item); break;
      case 'quick':    q3.push(item); break;
      case 'simmering': q4.push(item); break;
      default:         q2.push(item); break;
    }
  }

  return {
    quadrants: [
      { name: 'DO NOW', emoji: '\u{1F534}', desc: 'Time-Sensitive + Blocked on Peretz', items: q1 },
      { name: 'SCHEDULE', emoji: '\u{1F7E1}', desc: 'Infrastructure + Data + Claude Work', items: q2 },
      { name: 'QUICK WINS', emoji: '\u26A1', desc: 'Review Queue + 5-min Actions', items: q3 },
      { name: 'LATER', emoji: '\u{1F535}', desc: 'Simmering / Someday', items: q4 },
    ],
    services: [],
    totalTasks: items.length,
    generated: new Date().toISOString(),
  };
}

function renderBriefingHTML() {
  const data = getBriefingData();
  const today = new Date();
  const dateStr = today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  const renderItem = (item) => {
    const ownerColors = { PERETZ: '#e67e22', CLAUDE: '#3498db', TOGETHER: '#9b59b6' };
    const ownerBadge = item.owner
      ? `<span style="background:${ownerColors[item.owner] || '#555'};padding:2px 6px;border-radius:3px;font-size:11px;margin-right:4px">${item.owner}</span>`
      : '';
    const detail = item.details.length > 0 ? `<div style="color:#999;font-size:12px;margin:2px 0 0 16px">${item.details[0].substring(0, 120)}${item.details[0].length > 120 ? '...' : ''}</div>` : '';
    return `<div style="margin:6px 0;padding:6px 8px;background:#1a1a2e;border-radius:4px">${ownerBadge}${item.title}${detail}</div>`;
  };

  const quadrantHTML = data.quadrants.map(q => `
    <div style="flex:1;min-width:300px;margin:8px;padding:12px;background:#0d1117;border:1px solid #30363d;border-radius:8px">
      <h3 style="margin:0 0 8px 0;color:#e6e6e6">${q.emoji} ${q.name} <span style="color:#666;font-size:13px">— ${q.desc}</span></h3>
      ${q.items.length === 0 ? '<div style="color:#555;font-style:italic;padding:8px">Clear</div>' : q.items.map(renderItem).join('')}
    </div>
  `).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Daily Briefing</title>
<meta http-equiv="refresh" content="300">
<style>
  body { background:#0a0a1a; color:#e6e6e6; font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text',system-ui,sans-serif; margin:0; padding:20px; }
  a { color:#58a6ff; text-decoration:none; }
  a:hover { text-decoration:underline; }
</style></head><body>
${renderNav('briefing')}
<div style="max-width:1200px;margin:0 auto">
  <h1 style="margin:16px 0 4px 0">Daily Briefing</h1>
  <div style="color:#888;margin-bottom:16px">${dateStr} — ${data.totalTasks} active tasks</div>

  <div style="display:flex;flex-wrap:wrap;margin:-8px">
    ${quadrantHTML}
  </div>

  <div style="margin-top:24px;padding:16px;background:#0d1117;border:1px solid #30363d;border-radius:8px">
    <h3 style="margin:0 0 8px 0">Quick Links</h3>
    <div style="display:flex;flex-wrap:wrap;gap:12px">
      <a href="/">Dashboard</a>
      <a href="/threads">Threads</a>
      <a href="/stream">Life Stream</a>
      <a href="/agents">Agents</a>
      <a href="/plan">Plan Tracker</a>
      <a href="https://localhost:3001/health" target="_blank">API Health</a>
      <a href="https://localhost:3002" target="_blank">Prompt Browser</a>
    </div>
  </div>

  <div style="margin-top:12px;color:#555;font-size:12px">
    Generated ${data.generated} — Source: ~/.claude/TASKS.md — Auto-refresh 5min
  </div>
</div>
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

  // ─── Philological Pipeline ────────────────
  try {
    const ATLAS_DB = path.join(HOME, 'tools/memoryatlas/data/atlas.db');
    const polished = parseInt(run(`sqlite3 "${ATLAS_DB}" "SELECT COUNT(*) FROM asset WHERE polished_at IS NOT NULL" 2>/dev/null`)) || 0;
    const totalNonEn = parseInt(run(`sqlite3 "${ATLAS_DB}" "SELECT COUNT(*) FROM asset WHERE transcript_lang <> 'en' AND transcript_lang IS NOT NULL AND transcript_status = 'done'" 2>/dev/null`)) || 0;
    const langs = run(`sqlite3 "${ATLAS_DB}" "SELECT GROUP_CONCAT(DISTINCT transcript_lang) FROM asset WHERE transcript_lang <> 'en' AND transcript_lang IS NOT NULL AND transcript_status = 'done'" 2>/dev/null`) || '';
    const isRunning = run(`ps aux | grep 'polish' | grep -v grep | wc -l 2>/dev/null`).trim() !== '0';
    const pct = totalNonEn > 0 ? Math.round(polished / totalNonEn * 100) : 0;
    if (totalNonEn > 0) {
      streams.push({
        id: 'philological', domain: 'memory', valence: isRunning ? 'active' : 'growth', cadence: 'daily',
        icon: '\u{1F4DC}', label: 'Philological Pipeline',
        primary: `${polished}/${totalNonEn}`, secondary: `${pct}% polished \u00B7 ${langs} \u00B7 ${isRunning ? 'RUNNING' : 'idle'}`,
        count: polished, signal: pct === 100 ? 'strong' : pct > 50 ? 'medium' : 'weak',
      });
      log.push({ t: now, msg: `Philological \u2014 ${polished}/${totalNonEn} polished (${pct}%), langs: ${langs}${isRunning ? ' [ACTIVE]' : ''}` });
    }
  } catch(e) { log.push({ t: now, msg: `Philological \u2014 ${e.message}` }); }

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

  // ─── Anvil (M3 Ultra) — Enhanced: probe dashboard API first, fallback to Ollama ──────────────────
  try {
    let anvilPrimary = '', anvilSecondary = '', anvilTertiary = '', anvilCount = 0, anvilSignal = 'weak';
    // Try the Anvil dashboard API first (richer data: GPU, jobs, temps)
    const dashRaw = run('curl -s --max-time 3 http://192.168.1.105:3000/api/status 2>/dev/null');
    if (dashRaw && dashRaw !== '\u2014' && dashRaw.startsWith('{')) {
      const dash = JSON.parse(dashRaw);
      const models = (dash.ollama && dash.ollama.available) || [];
      const modelCount = models.length;
      const metrics = dash.metrics || {};
      const sys = dash.system || {};
      const gpu = metrics.gpuUsage !== undefined ? Math.round(metrics.gpuUsage) + '% GPU' : '';
      const power = metrics.powerW ? Math.round(metrics.powerW) + 'W' : '';
      const ramUsed = metrics.ramUsedGB ? Math.round(metrics.ramUsedGB) : '';
      const gpuTemp = metrics.gpuTemp ? Math.round(metrics.gpuTemp) + '\u00B0C' : '';
      const activeJobs = (dash.jobs && dash.jobs.active) || 0;
      const completedJobs = (dash.jobs && dash.jobs.completed) || 0;
      const uptime = sys.uptime || '';
      anvilPrimary = `${modelCount} models${gpu ? ' \u00B7 ' + gpu : ''}${gpuTemp ? ' \u00B7 ' + gpuTemp : ''}`;
      anvilSecondary = `${ramUsed ? ramUsed + '/96GB RAM' : ''}${power ? ' \u00B7 ' + power : ''}${activeJobs > 0 ? ' \u00B7 ' + activeJobs + ' active' : ''}`;
      anvilTertiary = `${uptime ? 'up ' + uptime + ' \u00B7 ' : ''}192.168.1.105 \u00B7 M3 Ultra`;
      anvilCount = modelCount;
      anvilSignal = modelCount > 0 ? 'strong' : 'medium';
    } else {
      // Fallback: direct Ollama probe
      const anvilTags = run('curl -s --max-time 3 http://192.168.1.105:11434/api/tags 2>/dev/null');
      if (anvilTags && anvilTags !== '\u2014') {
        const anvilData = JSON.parse(anvilTags);
        const modelCount = (anvilData.models || []).length;
        const totalSize = (anvilData.models || []).reduce((s, m) => s + (m.size || 0), 0);
        const sizeGB = (totalSize / 1e9).toFixed(0);
        anvilPrimary = `${modelCount} models`;
        anvilSecondary = `${sizeGB} GB loaded`;
        anvilTertiary = '192.168.1.105 \u00B7 96GB \u00B7 Ollama';
        anvilCount = modelCount;
        anvilSignal = modelCount > 0 ? 'strong' : 'weak';
      }
    }
    if (anvilPrimary) {
      streams.push({
        id: 'anvil', domain: 'orbit', valence: 'pulse', cadence: 'realtime',
        icon: '\u{2692}\u{FE0F}', label: 'Anvil (M3 Ultra)',
        primary: anvilPrimary, secondary: anvilSecondary,
        tertiary: anvilTertiary,
        count: anvilCount, signal: anvilSignal,
      });
      log.push({ t: now, msg: `Anvil \u2014 ${anvilPrimary} \u00B7 ${anvilSecondary}` });
    }
  } catch(e) { log.push({ t: now, msg: `Anvil \u2014 ${e.message}` }); }

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
  // Dynamically parse TASKS.md for Peretz-blocked items and agent-ready items
  const tasksPath = path.join(process.env.HOME, '.claude/TASKS.md');
  let tasksContent = '';
  try { tasksContent = fs.readFileSync(tasksPath, 'utf8'); } catch { return { peretz: [], agent: [], completed: [], simmering: [] }; }

  const sections = {
    peretz: [],   // Blocked on Peretz
    agent: [],    // Claude can execute
    completed: [],// Recently done
    simmering: [],// Future
  };

  let currentSection = null;
  let currentTask = null;
  const lines = tasksContent.split('\n');

  for (const line of lines) {
    // Detect section headers
    if (line.startsWith('## Active — Peretz')) { currentSection = 'peretz'; continue; }
    if (line.startsWith('## Active — Claude')) { currentSection = 'agent'; continue; }
    if (line.startsWith('## Recently Completed') || line.startsWith('## Completed')) { currentSection = 'completed'; continue; }
    if (line.startsWith('## Simmering')) { currentSection = 'simmering'; continue; }
    if (line.startsWith('## Services')) { currentSection = null; continue; }

    if (!currentSection) continue;

    // Task title (### heading)
    if (line.startsWith('### ')) {
      if (currentTask) sections[currentSection].push(currentTask);
      const title = line.replace(/^###\s+/, '').replace(/[🚨✅⚠️🔥]/g, '').trim();
      const isDone = line.includes('DONE') || line.includes('ARRIVED') || line.includes('COMPLETE');
      currentTask = { title, priority: 'P2', details: [], isDone };
      continue;
    }

    // Completed section uses bullet points
    if (currentSection === 'completed' && line.match(/^-\s+✅/)) {
      sections.completed.push({ title: line.replace(/^-\s+✅\s*/, '').trim(), isDone: true });
      continue;
    }
    if (currentSection === 'simmering' && line.match(/^-\s+\*\*/)) {
      sections.simmering.push({ title: line.replace(/^-\s+\*\*/, '').replace(/\*\*.*/, '').trim() });
      continue;
    }

    if (currentTask && line.startsWith('**Priority**:')) {
      const pm = line.match(/P(\d)/);
      if (pm) currentTask.priority = 'P' + pm[1];
      const om = line.match(/Owner.*?:\s*(.+?)(\s*\||\s*$)/);
      if (om) currentTask.owner = om[1].trim();
      const tm = line.match(/Time.*?:\s*(.+?)(\s*\||\s*$)/);
      if (tm) currentTask.time = tm[1].trim();
      continue;
    }
    if (currentTask && line.startsWith('- ')) {
      currentTask.details.push(line.replace(/^-\s+/, '').trim());
    }
  }
  if (currentTask && currentSection) sections[currentSection].push(currentTask);

  // Filter out completed items from peretz section
  sections.peretz = sections.peretz.filter(t => !t.isDone);

  return sections;
}

function renderBlockersHTML() {
  const data = getBlockers();
  const peretzCount = data.peretz.length;
  const agentCount = data.agent.length;
  const completedCount = data.completed.length;
  const simmeringCount = data.simmering.length;
  const total = peretzCount + agentCount + simmeringCount;
  const convergence = total > 0 ? Math.round((completedCount / (completedCount + total)) * 100) : 100;

  const priorityColor = p => p === 'P0' ? '#ff4444' : p === 'P1' ? '#ffaa00' : p === 'P2' ? '#00aaff' : '#555';
  const priorityLabel = p => p === 'P0' ? 'CRITICAL' : p === 'P1' ? 'HIGH' : p === 'P2' ? 'MEDIUM' : 'LOW';

  const renderTask = (t, i, section) => {
    const pc = priorityColor(t.priority || 'P2');
    const detailsHTML = (t.details || []).map(d => `<li>${d}</li>`).join('');
    const ownerTag = t.owner ? `<span style="color:#888;font-size:11px;margin-left:8px">${t.owner}</span>` : '';
    const timeTag = t.time ? `<span style="color:#00ff88;font-size:11px;margin-left:8px">${t.time}</span>` : '';
    return `<details class="task-card" style="border-left:4px solid ${pc}">
  <summary class="task-summary">
    <div class="task-header">
      <span class="task-priority" style="background:${pc}22;color:${pc}">${t.priority || 'P2'}</span>
      <span class="task-title">${t.title}</span>
      ${ownerTag}${timeTag}
    </div>
  </summary>
  ${detailsHTML ? `<div class="task-details"><ul>${detailsHTML}</ul></div>` : ''}
</details>`;
  };

  const peretzCards = data.peretz.map((t, i) => renderTask(t, i, 'peretz')).join('');
  const agentCards = data.agent.map((t, i) => renderTask(t, i, 'agent')).join('');
  const simmeringList = data.simmering.map(t => `<li>${t.title}</li>`).join('');
  const completedList = data.completed.slice(0, 10).map(t => `<li style="color:#555">${t.title}</li>`).join('');

  return `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<title>Convergence | PracticeLife</title>
<meta http-equiv="refresh" content="60">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#0a0a0a; color:#e0e0e0; font-family:'SF Mono','Fira Code',monospace; padding:20px; }
h1 { color:#00ff88; font-size:28px; margin-bottom:4px; }
h2 { font-size:18px; margin:24px 0 12px 0; padding-bottom:8px; border-bottom:1px solid #222; }
.subtitle { color:#666; margin-bottom:20px; font-size:13px; }

.summary { display:flex; gap:16px; margin-bottom:24px; flex-wrap:wrap; }
.scard { background:#151515; border:1px solid #222; border-radius:8px; padding:12px 20px; text-align:center; flex:1; min-width:120px; }
.scard .num { font-size:32px; font-weight:bold; }
.scard .label { color:#555; font-size:11px; text-transform:uppercase; letter-spacing:1px; margin-top:4px; }

.convergence-bar { background:#151515; border:1px solid #222; border-radius:8px; padding:16px 20px; margin-bottom:24px; }
.convergence-bar .bar-bg { background:#1a1a1a; border-radius:4px; height:24px; overflow:hidden; margin-top:8px; }
.convergence-bar .bar-fill { height:100%; border-radius:4px; transition:width 0.5s; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:bold; }
.convergence-bar .label { color:#888; font-size:13px; }

.task-card { background:#111; border-radius:8px; padding:0; margin-bottom:8px; overflow:hidden; }
.task-summary { list-style:none; padding:14px 20px; cursor:pointer; user-select:none; }
.task-summary::-webkit-details-marker { display:none; }
.task-header { display:flex; align-items:center; gap:12px; }
.task-priority { font-size:10px; font-weight:bold; padding:3px 10px; border-radius:4px; white-space:nowrap; text-transform:uppercase; letter-spacing:1px; }
.task-title { font-size:14px; color:#e0e0e0; flex:1; }
.task-details { padding:0 20px 14px 20px; border-top:1px solid #1a1a1a; margin-top:0; padding-top:12px; }
.task-details ul { margin-left:16px; color:#999; font-size:12px; line-height:1.8; }

.section-agent h2 { color:#00aaff; }
.section-peretz h2 { color:#ff4444; }
.section-simmering h2 { color:#555; }
.section-completed h2 { color:#00ff88; }

.simmering-list, .completed-list { margin-left:20px; font-size:12px; line-height:2; color:#888; }
.completed-list { color:#555; }

.timestamp { color:#333; font-size:11px; text-align:right; margin-top:24px; }
.source { color:#333; font-size:11px; margin-top:8px; }
</style>
</head><body>
${renderNav('blockers')}
<h1>Phase-Lock Convergence</h1>
<div class="subtitle">Live from ~/.claude/TASKS.md · Where Peretz is needed vs what agents handle</div>

<div class="convergence-bar">
  <div class="label">Convergence: ${completedCount} done / ${completedCount + total} total threads</div>
  <div class="bar-bg">
    <div class="bar-fill" style="width:${convergence}%;background:${convergence > 70 ? '#00ff88' : convergence > 40 ? '#ffaa00' : '#ff4444'}">
      ${convergence}%
    </div>
  </div>
</div>

<div class="summary">
  <div class="scard">
    <div class="num" style="color:#ff4444">${peretzCount}</div>
    <div class="label">Blocked on Peretz</div>
  </div>
  <div class="scard">
    <div class="num" style="color:#00aaff">${agentCount}</div>
    <div class="label">Agent Can Execute</div>
  </div>
  <div class="scard">
    <div class="num" style="color:#00ff88">${completedCount}</div>
    <div class="label">Completed</div>
  </div>
  <div class="scard">
    <div class="num" style="color:#555">${simmeringCount}</div>
    <div class="label">Simmering</div>
  </div>
</div>

<div class="section-peretz">
  <h2>Blocked on Peretz (${peretzCount})</h2>
  ${peretzCards || '<div style="color:#555;padding:12px">No blockers! All clear.</div>'}
</div>

<div class="section-agent">
  <h2>Agent Can Execute Now (${agentCount})</h2>
  ${agentCards || '<div style="color:#555;padding:12px">No ready tasks.</div>'}
</div>

<div class="section-completed">
  <h2>Recently Completed (${completedCount})</h2>
  <ul class="completed-list">${completedList || '<li>None yet</li>'}</ul>
</div>

<div class="section-simmering">
  <h2>Simmering / Future (${simmeringCount})</h2>
  <ul class="simmering-list">${simmeringList || '<li>None</li>'}</ul>
</div>

<div class="source">Source: ~/.claude/TASKS.md · Updated by agents continuously</div>
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
  if (req.url === '/command') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(renderCommandHTML());
    return;
  }
  if (req.url === '/api/command') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(getCommandData(), null, 2));
    return;
  }
  if (req.url === '/machines') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(renderMachinesHTML());
    return;
  }
  if (req.url === '/api/machines') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(getMachineStatus(), null, 2));
    return;
  }
  if (req.url === '/philological') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(renderPhilologicalHTML());
    return;
  }
  if (req.url === '/api/philological') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(getPhilologicalData(), null, 2));
    return;
  }
  if (req.url === '/briefing') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(renderBriefingHTML());
    return;
  }
  if (req.url === '/api/briefing') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(getBriefingData(), null, 2));
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
  if (req.url === '/fleet') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(renderFleetHTML());
    return;
  }
  if (req.url === '/usage') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(renderUsageHTML());
    return;
  }
  if (req.url === '/api/usage') {
    try {
      const UsageTracker = require(path.join(process.env.HOME, '.claude/usage-tracker.js'));
      const tracker = new UsageTracker();
      const stats = tracker.getTodayStats();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(stats, null, 2));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.url === '/cheatsheet' || req.url === '/docs') {
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
  if (req.url === '/queue') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(renderQueueHTML());
    return;
  }
  // Intervene: open iTerm2 tab with task context from /queue page
  if (req.url.startsWith('/api/intervene/') && req.method === 'POST') {
    const taskId = req.url.split('/').pop();
    try {
      const taskJson = run('curl -sk https://localhost:3001/api/q/tasks/' + taskId + ' 2>/dev/null');
      const task = taskJson ? JSON.parse(taskJson) : null;
      if (!task) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Task not found' }));
        return;
      }
      const lastQ = (task.messages || []).filter(m => m.type === 'question' || m.type === 'clarification').pop();
      const ctxLines = [
        'Task #' + task.id + ': ' + task.title,
        'Owner: ' + (task.owner || '') + ' | Assignee: ' + (task.assignee || 'none') + ' | Status: ' + task.status,
        task.description ? task.description.replace(/\n/g, ' ').substring(0, 200) : '',
        lastQ ? 'QUESTION from ' + lastQ.author + ': ' + lastQ.content : '',
      ].filter(Boolean).join('\\n');
      const osa = 'tell application "iTerm2" to tell current window to create tab with default profile';
      run("osascript -e '" + osa + "'", 5000);
      // Small delay then send text to new tab
      const writeCmd = "osascript -e 'tell application \"iTerm2\" to tell current window to tell current session to write text \"echo \\\"" +
        "━━ INTERVENTION Task #" + taskId + " ━━\\n" + ctxLines.replace(/"/g, '\\"') + "\\n━━━━━━━━━━━━━━━━━━━━\\\"\"'";
      run(writeCmd, 5000);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, taskId: parseInt(taskId) }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.url === '/files' || req.url === '/downloads') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(renderFilesHTML());
    return;
  }
  if (req.url === '/api/files' || req.url === '/api/downloads') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(getDownloadsData(), null, 2));
    return;
  }
  if (req.url === '/api/downloads/rules' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const update = JSON.parse(body);
        handleDownloadsRuleUpdate(update, res);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (req.url === '/api/downloads/undo' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { filename, destination } = JSON.parse(body);
        handleDownloadsUndo(filename, destination, res);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (req.url === '/api/downloads/redirect' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { filename, from, to } = JSON.parse(body);
        handleDownloadsRedirect(filename, from, to, res);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (req.url === '/api/downloads/sendto' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { filename, to } = JSON.parse(body);
        handleDownloadsSendTo(filename, to, res);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (req.url === '/api/downloads/corrections') {
    try {
      const lines = fs.readFileSync(path.join(process.env.HOME, '.download-corrections.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ corrections: lines, total: lines.length }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ corrections: [], total: 0 }));
    }
    return;
  }
  if (req.url === '/api/downloads/pin' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { filename } = JSON.parse(body);
        handleDownloadsPin(filename, res);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  // ─── Downloads: Tags API ───
  if (req.url === '/api/downloads/tags' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { filename, tags } = JSON.parse(body);
        handleDownloadsTags(filename, tags, res);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  // ─── Downloads: Move to arbitrary path ───
  if (req.url === '/api/downloads/moveto' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { filename, destination } = JSON.parse(body);
        handleDownloadsMoveTo(filename, destination, res);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  // ─── Downloads: File metadata ───
  if (req.url.startsWith('/api/downloads/meta/')) {
    const filename = decodeURIComponent(req.url.replace('/api/downloads/meta/', ''));
    handleDownloadsMeta(filename, res);
    return;
  }
  // ─── Downloads: PDF preview (serve raw file) ───
  if (req.url.startsWith('/api/downloads/preview/')) {
    const filename = decodeURIComponent(req.url.replace('/api/downloads/preview/', ''));
    handleDownloadsPreview(filename, res);
    return;
  }
  // ─── Downloads: Browse directories ───
  if (req.url.startsWith('/api/downloads/browse')) {
    const dirPath = decodeURIComponent(req.url.split('?path=')[1] || process.env.HOME);
    handleDownloadsBrowse(dirPath, res);
    return;
  }
  // ─── Files Hub: Quarantine APIs ───
  if (req.url === '/api/files/agents') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ agents: getFileAgents(), quarantine: getQuarantineFiles(), suggestions: getRuleSuggestions() }, null, 2));
    return;
  }
  if (req.url === '/api/files/quarantine/restore' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { filepath, destination } = JSON.parse(body);
        if (!fs.existsSync(filepath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'File not found' }));
          return;
        }
        const dest = (destination || DOWNLOADS_DIR).replace(/^~/, process.env.HOME);
        if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
        const filename = path.basename(filepath);
        fs.renameSync(filepath, path.join(dest, filename));
        fs.appendFileSync(DOWNLOAD_LOG_FILE, `[${new Date().toISOString()}] ↩ QUARANTINE-RESTORE: ${filename} → ${dest.replace(process.env.HOME, '~')}\n`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, restored: path.join(dest, filename) }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (req.url === '/api/files/quarantine/delete' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { filepath } = JSON.parse(body);
        if (!fs.existsSync(filepath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'File not found' }));
          return;
        }
        fs.unlinkSync(filepath);
        fs.appendFileSync(DOWNLOAD_LOG_FILE, `[${new Date().toISOString()}] ✗ QUARANTINE-DELETE: ${path.basename(filepath)}\n`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, deleted: filepath }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  // ─── Files Hub: Agent Activity Feed ───
  if (req.url === '/api/files/activity') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ activity: getAgentActivity(50) }));
    return;
  }
  // ─── Files Hub: Data Sources Registry ───
  if (req.url === '/api/files/sources') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ sources: getDataSources() }));
    return;
  }
  if (req.url === '/api/files/sources/annotate' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { id, tags, pipelineTarget, notes } = JSON.parse(body);
        const updates = {};
        if (tags !== undefined) updates.tags = tags;
        if (pipelineTarget !== undefined) updates.pipelineTarget = pipelineTarget;
        if (notes !== undefined) updates.notes = notes;
        const source = updateDataSource(id, updates);
        if (source) {
          appendActivity('Dashboard', 'annotate', source.path, `Updated ${id}: ${Object.keys(updates).join(', ')}`, 'done');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, source }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Source not found: ' + id }));
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
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

// ─── Fleet Page — Multi-Machine Status ───────────────────────────────

function renderFleetHTML() {
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>Fleet — PracticeLife OS</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0a0a0a; color: #e0e0e0; font-family: 'SF Mono', 'Fira Code', monospace; padding: 20px; }
  h1 { color: #00ff88; font-size: 24px; margin-bottom: 4px; }
  .subtitle { color: #666; font-size: 12px; margin-bottom: 20px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .machine { background: #151515; border: 1px solid #222; border-radius: 12px; padding: 20px; position: relative; }
  .machine.primary { border-color: #00ff8855; }
  .machine.inference { border-color: #00aaff55; }
  .machine.storage { border-color: #ffaa0055; }
  .machine.mobile { border-color: #aa55ff55; }
  .machine h2 { font-size: 18px; margin-bottom: 4px; display: flex; align-items: center; gap: 8px; }
  .machine .role { color: #888; font-size: 11px; margin-bottom: 12px; }
  .machine .specs { color: #555; font-size: 11px; margin-bottom: 8px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .dot.up { background: #00ff88; box-shadow: 0 0 8px #00ff88; }
  .dot.down { background: #ff4444; box-shadow: 0 0 8px #ff4444; }
  .dot.offline { background: #555; }
  .services { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
  .svc { font-size: 11px; padding: 3px 8px; border-radius: 4px; border: 1px solid #333; }
  .svc.up { background: #0a1a0a; color: #00ff88; border-color: #00ff8833; }
  .svc.down { background: #1a0a0a; color: #ff4444; border-color: #ff444433; }
  .models { margin: 8px 0; }
  .model { font-size: 12px; padding: 4px 0; color: #ccc; display: flex; justify-content: space-between; }
  .model .size { color: #555; }
  .section { margin-top: 24px; }
  .section h2 { color: #00ff88; font-size: 16px; margin-bottom: 12px; border-bottom: 1px solid #222; padding-bottom: 8px; }
  .routes { margin: 12px 0; }
  .route { font-size: 12px; padding: 4px 10px; display: flex; justify-content: space-between; border-bottom: 1px solid #111; }
  .route .name { color: #00aaff; }
  .route .target { color: #555; }
  .flow { background: #111; border-radius: 8px; padding: 12px; margin: 12px 0; font-size: 12px; line-height: 1.8; }
  .flow .arrow { color: #00ff88; }
  .mesh { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
  .device { font-size: 11px; padding: 4px 10px; border-radius: 4px; border: 1px solid #333; display: flex; align-items: center; gap: 6px; }
  .device.online { border-color: #00ff8833; }
  .device.offline { border-color: #55555533; opacity: 0.5; }
  .latency { color: #00ff88; font-size: 11px; }
  .loading { color: #555; font-style: italic; }
  .error { color: #ff4444; }
  .capabilities { font-size: 11px; color: #888; line-height: 1.6; padding-left: 12px; }
  .capabilities li { margin: 2px 0; }
  .refresh { position: fixed; bottom: 20px; right: 20px; background: #151515; border: 1px solid #333; color: #00ff88; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-family: inherit; font-size: 12px; }
  .refresh:hover { border-color: #00ff88; }
  .stat { display: flex; justify-content: space-between; font-size: 12px; padding: 2px 0; }
  .stat .label { color: #888; }
  .stat .val { color: #00ff88; }
  .nav { display: flex; gap: 16px; margin-bottom: 12px; }
  .nav a { color: #555; font-size: 13px; padding: 4px 12px; border: 1px solid #222; border-radius: 6px; text-decoration: none; }
  .nav a.active { color: #00ff88; border-color: #00ff88; }
</style>
</head><body>
${renderNav('fleet')}
<h1>Fleet Status</h1>
<p class="subtitle">Multi-machine AI infrastructure — live probe</p>

<div id="fleet-content"><p class="loading">Probing fleet...</p></div>

<button class="refresh" onclick="loadFleet()">Refresh</button>

<script>
async function loadFleet() {
  const el = document.getElementById('fleet-content');
  try {
    const res = await fetch('https://localhost:3001/api/fleet');
    const d = await res.json();
    el.innerHTML = renderFleet(d);
  } catch (e) {
    el.innerHTML = '<p class="error">Failed to reach API at :3001 — ' + e.message + '</p>';
  }
}

function renderFleet(d) {
  const h = d.machines.hearth;
  const a = d.machines.anvil;
  const n = d.machines.nas;
  const mob = d.machines.mobile;
  const r = d.routing;
  const ts = d.tailscale;

  const svcHtml = (services) => Object.entries(services).map(([k, v]) =>
    '<span class="svc ' + v.status + '">' + k + ' :' + v.port + (v.latencyMs ? ' (' + v.latencyMs + 'ms)' : '') + '</span>'
  ).join('');

  const modelHtml = (models) => models.map(m =>
    '<div class="model"><span>' + m.name + '</span><span class="size">' + m.size + '</span></div>'
  ).join('');

  const deviceHtml = (devices) => devices.map(dev =>
    '<div class="device ' + (dev.online ? 'online' : 'offline') + '">' +
    '<span class="dot ' + (dev.online ? 'up' : 'offline') + '"></span>' +
    dev.name + ' <span style="color:#555">' + (dev.ip || '') + '</span></div>'
  ).join('');

  let html = '<div class="grid">';

  // Hearth
  html += '<div class="machine primary"><h2><span class="dot up"></span> ' + h.name + '</h2>';
  html += '<div class="role">' + h.role + '</div>';
  html += '<div class="specs">' + h.model + ' — ' + h.specs.ram + ' RAM, ' + h.specs.cpu + ' CPU, ' + h.specs.gpu + ' GPU</div>';
  if (h.system) {
    html += '<div class="stat"><span class="label">Load</span><span class="val">' + h.system.loadAvg.map(v => v.toFixed(1)).join(' / ') + '</span></div>';
    html += '<div class="stat"><span class="label">Free RAM</span><span class="val">' + h.system.freeMemGB + 'GB / ' + h.system.totalMemGB + 'GB</span></div>';
  }
  html += '<div style="margin-top:8px;font-size:11px;color:#888">Services</div>';
  html += '<div class="services">' + svcHtml(h.services) + '</div>';
  if (h.models.length > 0) {
    html += '<div style="font-size:11px;color:#888;margin-top:8px">Local Models</div>';
    html += '<div class="models">' + modelHtml(h.models) + '</div>';
  }
  html += '</div>';

  // Anvil
  const anvilUp = a.ollama.status === 'up';
  html += '<div class="machine inference"><h2><span class="dot ' + (anvilUp ? 'up' : 'down') + '"></span> ' + a.name + '</h2>';
  html += '<div class="role">' + a.role + '</div>';
  html += '<div class="specs">' + a.model + ' — ' + a.specs.ram + ' RAM, ' + a.specs.cpu + ' CPU, ' + a.specs.gpu + ' GPU, ' + a.specs.bandwidth + '</div>';
  html += '<div class="stat"><span class="label">LAN</span><span class="val">' + a.ip.lan + ' <span class="latency">(' + a.connectivity.lan.latencyMs + 'ms)</span></span></div>';
  html += '<div class="stat"><span class="label">Tailscale</span><span class="val">' + a.ip.tailscale + ' <span class="latency">(' + a.connectivity.tailscale.latencyMs + 'ms)</span></span></div>';
  if (a.system) {
    html += '<div class="stat"><span class="label">Uptime</span><span class="val">' + a.system.uptime + '</span></div>';
  }
  html += '<div style="font-size:11px;color:#888;margin-top:8px">Ollama Models (' + a.ollama.totalSizeGB + 'GB)</div>';
  html += '<div class="models">' + modelHtml(a.ollama.models) + '</div>';
  html += '</div>';

  // NAS
  html += '<div class="machine storage"><h2><span class="dot up"></span> ' + n.name + '</h2>';
  html += '<div class="role">' + n.role + '</div>';
  html += '<div class="specs">' + n.specs.ram + ' RAM, ' + n.specs.storage + ' storage, ' + n.specs.arch + '</div>';
  html += '<div class="stat"><span class="label">LAN</span><span class="val">' + n.ip.lan + '</span></div>';
  html += '<div class="stat"><span class="label">Tailscale</span><span class="val">' + n.ip.tailscale + '</span></div>';
  html += '<div class="services">' + n.services.map(s => '<span class="svc up">' + s + '</span>').join('') + '</div>';
  html += '</div>';

  // Mobile
  html += '<div class="machine mobile"><h2>Mobile Devices</h2>';
  html += '<div style="margin-bottom:12px"><strong style="color:#aa55ff">' + mob.ipad.name + '</strong>';
  html += '<div class="role">' + mob.ipad.role + '</div>';
  html += '<ul class="capabilities">' + mob.ipad.capabilities.map(c => '<li>' + c + '</li>').join('') + '</ul></div>';
  html += '<div><strong style="color:#aa55ff">' + mob.iphone.name + '</strong>';
  html += '<div class="role">' + mob.iphone.role + '</div>';
  html += '<ul class="capabilities">' + mob.iphone.capabilities.map(c => '<li>' + c + '</li>').join('') + '</ul></div>';
  html += '</div>';

  html += '</div>'; // end grid

  // Routing
  html += '<div class="section"><h2>AI Routing (LiteLLM :4000)</h2>';
  html += '<div class="routes">';
  r.litellm.models.forEach(m => {
    const target = m.startsWith('anvil/') ? 'Anvil :11434' : m.startsWith('local/') ? 'Hearth :11434' : m.startsWith('gpu/') ? 'GPU Box' : 'Cloud';
    html += '<div class="route"><span class="name">' + m + '</span><span class="target">' + target + '</span></div>';
  });
  html += '</div>';
  html += '<div class="flow">';
  r.flowDescription.forEach(f => {
    html += f.replace(/→/g, '<span class="arrow"> → </span>') + '<br>';
  });
  html += '</div></div>';

  // Tailscale Mesh
  html += '<div class="section"><h2>Tailscale Mesh (' + ts.meshSize + ' devices)</h2>';
  html += '<div class="mesh">' + deviceHtml(ts.devices) + '</div></div>';

  // Timestamp
  html += '<p style="color:#333;font-size:11px;margin-top:24px">Probed ' + new Date(d.timestamp).toLocaleString() + '</p>';

  return html;
}

loadFleet();
setInterval(loadFleet, 30000);
</script>
</body></html>`;
}

// ─── Cheat Sheet Page ─────────────────────────────────────────────────

function renderUsageHTML() {
  try {
    const UsageTracker = require(path.join(process.env.HOME, '.claude/usage-tracker.js'));
    const tracker = new UsageTracker();
    const stats = tracker.getTodayStats();
    const { summary, calls, topConsumers } = stats;

    const burnRate = (summary.burnRate * 100).toFixed(1);
    const remaining = (summary.remaining / 1000000).toFixed(2);
    const remainingPct = ((summary.remaining / summary.totalQuota) * 100).toFixed(0);

    let statusEmoji = '⚠️';
    let statusText = 'UNDERUTILIZED';
    if (summary.burnRate >= 0.95) {
      statusEmoji = '✅';
      statusText = 'EXCELLENT';
    } else if (summary.burnRate >= 0.80) {
      statusEmoji = '✓';
      statusText = 'GOOD';
    }

    const callsHTML = calls.map(c => `
      <tr>
        <td>${c.category}</td>
        <td>${(c.tokens / 1000).toFixed(0)}k</td>
        <td>$${c.cost.toFixed(2)}</td>
        <td>${c.call_count}</td>
        <td>${((c.tokens / summary.totalBurned) * 100).toFixed(0)}%</td>
      </tr>
    `).join('');

    const consumersHTML = topConsumers.map((item, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${item.purpose}</td>
        <td>${(item.tokens / 1000).toFixed(0)}k</td>
        <td>$${item.cost.toFixed(2)}</td>
        <td>${item.calls}</td>
      </tr>
    `).join('');

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="60">
  <title>Usage Tracker — ${stats.date}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0a0a0a;
      color: #e0e0e0;
      font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
      padding: 20px;
      font-size: 14px;
      line-height: 1.6;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 {
      font-size: 24px;
      margin-bottom: 20px;
      color: #00ff88;
      font-weight: 600;
    }
    .summary {
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 20px;
    }
    .metric {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid #222;
    }
    .metric:last-child { border-bottom: none; }
    .metric-label { color: #888; }
    .metric-value { color: #00ff88; font-weight: 600; }
    .status {
      font-size: 18px;
      padding: 12px;
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 8px;
      text-align: center;
      margin-bottom: 20px;
    }
    .status.excellent { border-color: #00ff88; color: #00ff88; }
    .status.good { border-color: #ffaa00; color: #ffaa00; }
    .status.underutilized { border-color: #ff3366; color: #ff3366; }
    .progress-bar {
      width: 100%;
      height: 30px;
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 8px;
      overflow: hidden;
      margin: 20px 0;
    }
    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #00ff88, #00cc66);
      transition: width 0.5s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #0a0a0a;
      font-weight: 600;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 8px;
      overflow: hidden;
      margin-bottom: 20px;
    }
    th {
      background: #222;
      color: #00ff88;
      padding: 12px;
      text-align: left;
      font-weight: 600;
    }
    td {
      padding: 10px 12px;
      border-top: 1px solid #222;
    }
    tr:hover { background: #1f1f1f; }
    .section-title {
      font-size: 18px;
      color: #00ff88;
      margin: 30px 0 15px;
    }
    a { color: #00ff88; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .footer {
      text-align: center;
      padding: 20px;
      color: #555;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🔥 Quota Burn Tracker — ${stats.date}</h1>

    <div class="status ${summary.burnRate >= 0.95 ? 'excellent' : summary.burnRate >= 0.80 ? 'good' : 'underutilized'}">
      ${statusEmoji} STATUS: ${statusText} — ${burnRate}% UTILIZED
    </div>

    <div class="progress-bar">
      <div class="progress-fill" style="width: ${burnRate}%">
        ${burnRate}%
      </div>
    </div>

    <div class="summary">
      <div class="metric">
        <span class="metric-label">Tokens Burned</span>
        <span class="metric-value">${(summary.totalBurned / 1000000).toFixed(2)}M / ${(summary.totalQuota / 1000000).toFixed(1)}M</span>
      </div>
      <div class="metric">
        <span class="metric-label">Cost</span>
        <span class="metric-value">$${summary.totalCost.toFixed(2)} / $${summary.totalBudget.toFixed(2)}</span>
      </div>
      <div class="metric">
        <span class="metric-label">Remaining</span>
        <span class="metric-value">${remaining}M tokens ($${summary.remainingCost.toFixed(2)})</span>
      </div>
      <div class="metric">
        <span class="metric-label">Remaining %</span>
        <span class="metric-value">${remainingPct}% LEFT ON TABLE</span>
      </div>
    </div>

    <h2 class="section-title">Allocation Breakdown</h2>
    <table>
      <thead>
        <tr>
          <th>Category</th>
          <th>Tokens</th>
          <th>Cost</th>
          <th>Calls</th>
          <th>% of Total</th>
        </tr>
      </thead>
      <tbody>
        ${callsHTML || '<tr><td colspan="5">No API calls yet today</td></tr>'}
      </tbody>
    </table>

    <h2 class="section-title">Top Consumers</h2>
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Purpose</th>
          <th>Tokens</th>
          <th>Cost</th>
          <th>Calls</th>
        </tr>
      </thead>
      <tbody>
        ${consumersHTML || '<tr><td colspan="5">No consumers yet</td></tr>'}
      </tbody>
    </table>

    <div class="footer">
      <a href="/">← Back to Dashboard</a> | <a href="/api/usage">JSON API</a> | Auto-refresh: 60s
    </div>
  </div>
</body>
</html>`;
  } catch (e) {
    return `<html><body><h1>Error</h1><pre>${e.message}\n${e.stack}</pre></body></html>`;
  }
}

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
        { method: 'GET', path: '/briefing', desc: 'Daily Briefing - Eisenhower priority matrix' },
        { method: 'GET', path: '/stream', desc: 'Life Stream - 18 data source probes (incl. Anvil)' },
        { method: 'GET', path: '/threads', desc: 'Active threads from MEMORY.md' },
        { method: 'GET', path: '/philological', desc: 'Philological pipeline - source restoration + literary translation' },
        { method: 'GET', path: '/plan', desc: 'Plan execution tracker' },
        { method: 'GET', path: '/deps', desc: 'Dependency graph (blockers)' },
        { method: 'GET', path: '/endpoints', desc: 'This page - all endpoints index' },
        { method: 'GET', path: '/api/state', desc: 'JSON: System state snapshot' },
        { method: 'GET', path: '/api/briefing', desc: 'JSON: Daily briefing Eisenhower matrix' },
        { method: 'GET', path: '/api/stream', desc: 'JSON: Life Stream data' },
        { method: 'GET', path: '/api/threads', desc: 'JSON: Active threads' },
        { method: 'GET', path: '/api/agents', desc: 'JSON: Agent collaboration data' },
        { method: 'GET', path: '/api/philological', desc: 'JSON: Philological pipeline data' },
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

// ─── Command Page — Where Peretz Is Needed ─────────────────────────────

function getCommandData() {
  const tasksFile = path.join(process.env.HOME, '.claude/TASKS.md');
  let tasksContent = '';
  try { tasksContent = fs.readFileSync(tasksFile, 'utf-8'); } catch { }

  // Parse Peretz-blocked tasks from TASKS.md
  const peretzSection = tasksContent.split('## Active — Peretz Action Required')[1] || '';
  const claudeSection = peretzSection.split('## Active — Claude Can Execute')[0] || '';

  const tasks = [];
  const lines = claudeSection.split('\n');
  let current = null;

  for (const line of lines) {
    if (line.startsWith('### ')) {
      if (current) tasks.push(current);
      const title = line.replace(/^###\s+/, '').replace(/[🚨✅]/g, '').trim();
      current = { title, priority: 'P2', time: '?', details: [], completed: title.includes('COMPLETE') };
    } else if (current && line.startsWith('**Priority**:')) {
      const pm = line.match(/P(\d)/);
      if (pm) current.priority = `P${pm[1]}`;
      const tm = line.match(/\*\*Time\*\*:\s*(\S+)/);
      if (tm) current.time = tm[1];
    } else if (current && line.startsWith('- ')) {
      current.details.push(line.replace(/^-\s+/, ''));
    }
  }
  if (current) tasks.push(current);

  // Parse Claude-advancing tasks
  const claudeAdvancing = [];
  const claudeSectionFull = tasksContent.split('## Active — Claude Can Execute')[1] || '';
  const claudeOnly = claudeSectionFull.split('## Simmering')[0] || '';
  let claudeCurrent = null;
  for (const line of claudeOnly.split('\n')) {
    if (line.startsWith('### ')) {
      if (claudeCurrent) claudeAdvancing.push(claudeCurrent);
      claudeCurrent = { title: line.replace(/^###\s+/, '').trim(), details: [] };
    } else if (claudeCurrent && line.startsWith('- ')) {
      claudeCurrent.details.push(line.replace(/^-\s+/, ''));
    }
  }
  if (claudeCurrent) claudeAdvancing.push(claudeCurrent);

  // Machine status
  const hearthOk = run('curl -sk --max-time 2 https://localhost:3001/health >/dev/null 2>&1 && echo ok || echo down') === 'ok';
  const anvilOk = run('curl -s --max-time 2 http://192.168.1.105:11434/api/tags >/dev/null 2>&1 && echo ok || echo down') === 'ok';
  const nasOk = run('ping -c 1 -W 1 192.168.1.57 >/dev/null 2>&1 && echo ok || echo down') === 'ok';

  return {
    peretzTasks: tasks.filter(t => !t.completed),
    completedTasks: tasks.filter(t => t.completed),
    claudeAdvancing,
    machines: { hearth: hearthOk, anvil: anvilOk, nas: nasOk },
    timestamp: new Date().toISOString()
  };
}

function renderCommandHTML() {
  const data = getCommandData();
  const p0 = data.peretzTasks.filter(t => t.priority === 'P0');
  const p1 = data.peretzTasks.filter(t => t.priority === 'P1');
  const p2 = data.peretzTasks.filter(t => t.priority === 'P2' || t.priority === 'P3');

  const dot = (ok) => ok
    ? '<span style="display:inline-block;width:10px;height:10px;background:#00ff88;border-radius:50%;margin-right:6px"></span>'
    : '<span style="display:inline-block;width:10px;height:10px;background:#ff4444;border-radius:50%;margin-right:6px"></span>';

  const taskCard = (t, color) => `
    <div style="background:#111;border-left:3px solid ${color};border-radius:6px;padding:14px;margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="color:#fff;font-weight:600;font-size:14px">${t.title}</span>
        <span style="color:${color};font-size:12px;font-weight:600">${t.priority}</span>
      </div>
      ${t.time !== '?' ? `<div style="color:#666;font-size:11px;margin-top:4px">Est: ${t.time}</div>` : ''}
      ${t.details.length > 0 ? `<div style="color:#888;font-size:12px;margin-top:6px">${t.details[0]}</div>` : ''}
    </div>`;

  const claudeCard = (t) => `
    <div style="background:#111;border-left:3px solid #00aaff;border-radius:6px;padding:12px;margin-bottom:8px">
      <span style="color:#ccc;font-size:13px">${t.title}</span>
    </div>`;

  return `<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>Command | Ω₀</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#0a0a0a; color:#e0e0e0; font-family:'SF Mono',Monaco,'Cascadia Code',monospace; padding:20px; font-size:14px; }
  .container { max-width:1000px; margin:0 auto; }
  h1 { color:#00ff88; font-size:24px; margin-bottom:6px; }
  .subtitle { color:#555; font-size:13px; margin-bottom:20px; }
  .section { margin-bottom:30px; }
  .section-title { color:#00aaff; font-size:16px; margin-bottom:12px; font-weight:600; }
  .machines { display:flex; gap:20px; margin-bottom:24px; }
  .machine { background:#111; border:1px solid #222; border-radius:8px; padding:12px 16px; flex:1; }
  .machine-name { color:#fff; font-size:14px; font-weight:600; }
  .machine-role { color:#666; font-size:11px; }
</style></head><body><div class="container">
${renderNav('command')}
<h1>COMMAND CENTER</h1>
<div class="subtitle">Where you are needed — updated ${new Date().toLocaleTimeString()}</div>

<div class="machines">
  <div class="machine">${dot(data.machines.hearth)}<span class="machine-name">Hearth</span><div class="machine-role">Orchestration</div></div>
  <div class="machine">${dot(data.machines.anvil)}<span class="machine-name">Anvil</span><div class="machine-role">AI Compute</div></div>
  <div class="machine">${dot(data.machines.nas)}<span class="machine-name">NAS</span><div class="machine-role">Storage</div></div>
</div>

${p0.length > 0 ? `<div class="section">
  <div class="section-title" style="color:#ff4444">CRITICAL (${p0.length})</div>
  ${p0.map(t => taskCard(t, '#ff4444')).join('')}
</div>` : ''}

${p1.length > 0 ? `<div class="section">
  <div class="section-title" style="color:#ffaa00">HIGH PRIORITY (${p1.length})</div>
  ${p1.map(t => taskCard(t, '#ffaa00')).join('')}
</div>` : ''}

${p2.length > 0 ? `<div class="section">
  <div class="section-title">NORMAL (${p2.length})</div>
  ${p2.map(t => taskCard(t, '#444')).join('')}
</div>` : ''}

<div class="section">
  <div class="section-title" style="color:#00aaff">CLAUDE ADVANCING (${data.claudeAdvancing.length} threads)</div>
  ${data.claudeAdvancing.map(t => claudeCard(t)).join('')}
</div>

${data.completedTasks.length > 0 ? `<div class="section" style="opacity:0.5">
  <div class="section-title">RECENTLY COMPLETED (${data.completedTasks.length})</div>
  ${data.completedTasks.map(t => `<div style="color:#555;font-size:12px;padding:4px 0">${t.title}</div>`).join('')}
</div>` : ''}

<div style="color:#333;font-size:11px;text-align:center;margin-top:30px">
  Source: ~/.claude/TASKS.md | Phase-lock: ~/.claude/PHASE-LOCK-STATUS.md | Auto-refresh 60s
</div>
</div></body></html>`;
}

// ─── Machines Page — Cross-Machine Status ─────────────────────────────

function getMachineStatus() {
  // Hearth
  const hearthDisk = run("df -h / | tail -1 | awk '{print $4, $5}'");
  const hearthMem = run("memory_pressure 2>/dev/null | head -1 || echo 'unknown'");
  const hearthUptime = run('uptime');
  const hearthServices = {
    dashboard: 'up', // self — if this code is running, dashboard is up
    api: run('curl -sk --max-time 2 https://localhost:3001/health >/dev/null 2>&1 && echo up || echo down'),
    promptBrowser: run('curl -sk --max-time 2 https://localhost:3002/api/stats >/dev/null 2>&1 && echo up || echo down'),
    litellm: run('curl -s --max-time 2 http://localhost:4000/health/readiness >/dev/null 2>&1 && echo up || echo down'),
  };

  // Anvil — single API call to Anvil dashboard (replaces multiple probes)
  const anvilPing = run('ping -c 1 -W 1 192.168.1.105 2>/dev/null | grep "time=" | sed "s/.*time=//" || echo "down"');
  const anvilDashJson = run('curl -s --max-time 3 http://192.168.1.105:3000/api/status 2>/dev/null || echo ""');
  let anvilDash = null;
  let anvilModels = [];
  let anvilLoaded = [];
  let anvilMetrics = null;
  let anvilJobs = null;
  let anvilSystem = null;
  try {
    anvilDash = JSON.parse(anvilDashJson);
    const o = anvilDash.ollama || {};
    anvilModels = (o.available || []).map(m => ({ name: m.name, size: m.sizeGB + ' GB' }));
    anvilLoaded = (o.loaded || []).map(m => m.name);
    anvilMetrics = anvilDash.metrics;
    anvilJobs = anvilDash.jobs;
    anvilSystem = anvilDash.system;
  } catch {
    // Fallback: try direct Ollama if dashboard is down
    const anvilOllama = run('curl -s --max-time 3 http://192.168.1.105:11434/api/tags 2>/dev/null || echo "down"');
    try {
      const data = JSON.parse(anvilOllama);
      anvilModels = (data.models || []).map(m => ({ name: m.name, size: (m.size / 1e9).toFixed(1) + ' GB' }));
    } catch { }
    const anvilPs = run('curl -s --max-time 3 http://192.168.1.105:11434/api/ps 2>/dev/null || echo "{}"');
    try {
      const psData = JSON.parse(anvilPs);
      anvilLoaded = (psData.models || []).map(m => m.name);
    } catch { }
  }

  // Anvil agents
  let anvilAgents = [];
  try {
    const agentJson = run('curl -s --max-time 3 http://192.168.1.105:3000/api/agent-status 2>/dev/null || echo ""');
    if (agentJson) {
      const parsed = JSON.parse(agentJson);
      anvilAgents = parsed.agents || [];
    }
  } catch {}

  // NAS
  const nasPing = run('ping -c 1 -W 1 192.168.1.57 2>/dev/null | grep "time=" | sed "s/.*time=//" || echo "down"');

  return {
    hearth: {
      hostname: 'Mac Studio M2 Max',
      codename: 'Hearth',
      role: 'Orchestration + UI',
      ip: '192.168.1.113',
      disk: hearthDisk,
      memory: hearthMem,
      uptime: hearthUptime,
      services: hearthServices,
    },
    anvil: {
      hostname: 'Mac Studio M3 Ultra',
      codename: 'Anvil',
      role: 'AI Compute',
      ip: '192.168.1.105',
      tailscale: '100.116.17.120',
      ping: anvilPing,
      models: anvilModels,
      loadedModels: anvilLoaded,
      ollamaUp: anvilModels.length > 0,
      dashboardUp: !!anvilDash,
      metrics: anvilMetrics,
      jobs: anvilJobs,
      system: anvilSystem,
      agents: anvilAgents,
    },
    nas: {
      hostname: 'Synology DS223j',
      codename: 'NAS',
      role: 'Storage + Hosting',
      ip: '192.168.1.57',
      tailscale: '100.93.227.12',
      ping: nasPing,
      reachable: !nasPing.includes('down'),
    },
    timestamp: new Date().toISOString()
  };
}

function renderMachinesHTML() {
  const m = getMachineStatus();
  const dot = (ok) => `<span style="display:inline-block;width:12px;height:12px;background:${ok ? '#00ff88' : '#ff4444'};border-radius:50%;margin-right:8px;box-shadow:0 0 6px ${ok ? '#00ff8844' : '#ff444444'}"></span>`;
  const svcDot = (status) => dot(status === 'up');

  const totalVRAM = m.anvil.models.reduce((s, md) => s + parseFloat(md.size), 0).toFixed(1);

  return `<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>Machines | Ω₀</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#0a0a0a; color:#e0e0e0; font-family:'SF Mono',Monaco,monospace; padding:20px; font-size:14px; }
  .container { max-width:1100px; margin:0 auto; }
  h1 { color:#00ff88; font-size:24px; margin-bottom:20px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); gap:16px; margin-bottom:24px; }
  .card { background:#111; border:1px solid #222; border-radius:10px; padding:20px; }
  .card-header { display:flex; align-items:center; margin-bottom:12px; }
  .card-name { color:#fff; font-size:18px; font-weight:700; }
  .card-role { color:#666; font-size:12px; margin-top:2px; }
  .card-ip { color:#00aaff; font-size:12px; }
  .metric { display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid #1a1a1a; }
  .metric:last-child { border-bottom:none; }
  .metric-label { color:#666; }
  .metric-value { color:#ccc; }
  .model-list { margin-top:8px; }
  .model { display:flex; justify-content:space-between; padding:4px 8px; background:#0a0a0a; border-radius:4px; margin-bottom:4px; }
  .model-name { color:#00aaff; font-size:12px; }
  .model-size { color:#555; font-size:12px; }
  .loaded { border-left:2px solid #00ff88; }
  .services { margin-top:8px; }
  .svc { display:flex; align-items:center; padding:3px 0; font-size:13px; }
  .topology { background:#111; border:1px solid #222; border-radius:10px; padding:20px; margin-top:16px; }
  .topo-title { color:#00aaff; font-size:16px; margin-bottom:12px; }
  pre.topo { color:#555; font-size:11px; line-height:1.4; }
  pre.topo span { color:#00ff88; }
</style></head><body><div class="container">
${renderNav('machines')}
<h1>MACHINE STATUS</h1>

<div class="grid">
  <div class="card">
    <div class="card-header">${dot(true)}<div><div class="card-name">Hearth</div><div class="card-role">Orchestration + UI</div></div></div>
    <div class="card-ip">LAN: ${m.hearth.ip}</div>
    <div style="margin-top:12px">
      <div class="metric"><span class="metric-label">Disk Free</span><span class="metric-value">${m.hearth.disk}</span></div>
      <div class="metric"><span class="metric-label">Memory</span><span class="metric-value">${m.hearth.memory.substring(0, 40)}</span></div>
    </div>
    <div class="services" style="margin-top:12px">
      <div style="color:#666;font-size:11px;margin-bottom:6px">SERVICES</div>
      <div class="svc">${svcDot(m.hearth.services.dashboard)} Dashboard :3000</div>
      <div class="svc">${svcDot(m.hearth.services.api)} API :3001</div>
      <div class="svc">${svcDot(m.hearth.services.promptBrowser)} Prompt Browser :3002</div>
      <div class="svc">${svcDot(m.hearth.services.litellm)} LiteLLM :4000</div>
    </div>
  </div>

  <div class="card">
    <div class="card-header">${dot(m.anvil.ollamaUp)}<div><div class="card-name">Anvil ${m.anvil.dashboardUp ? '<a href="http://192.168.1.105:3000" style="color:#00aaff;font-size:11px;font-weight:normal;margin-left:8px;text-decoration:none">dashboard</a>' : ''}</div><div class="card-role">AI Compute (M3 Ultra, 96GB)</div></div></div>
    <div class="card-ip">LAN: ${m.anvil.ip} | TS: ${m.anvil.tailscale}</div>
    <div style="margin-top:8px">
      <div class="metric"><span class="metric-label">Ping</span><span class="metric-value">${m.anvil.ping}</span></div>
      ${m.anvil.system ? `<div class="metric"><span class="metric-label">Uptime</span><span class="metric-value">${m.anvil.system.uptime}</span></div>` : ''}
      ${m.anvil.metrics ? `
      <div class="metric"><span class="metric-label">GPU</span><span class="metric-value" style="color:${m.anvil.metrics.gpuUsage > 50 ? '#ffaa00' : '#00ff88'}">${m.anvil.metrics.gpuUsage.toFixed(1)}%</span></div>
      <div class="metric"><span class="metric-label">CPU</span><span class="metric-value">E: ${m.anvil.metrics.ecpuUsage.toFixed(0)}% P: ${m.anvil.metrics.pcpuUsage.toFixed(0)}%</span></div>
      <div class="metric"><span class="metric-label">RAM</span><span class="metric-value">${m.anvil.metrics.ramUsedGB.toFixed(1)} / ${m.anvil.metrics.ramTotalGB.toFixed(0)} GB</span></div>
      <div class="metric"><span class="metric-label">Swap</span><span class="metric-value" style="color:${m.anvil.metrics.swapUsedGB > 1 ? '#ff4444' : '#888'}">${m.anvil.metrics.swapUsedGB.toFixed(2)} GB</span></div>
      <div class="metric"><span class="metric-label">Power</span><span class="metric-value">${m.anvil.metrics.powerW.toFixed(1)}W (CPU ${m.anvil.metrics.cpuPowerW.toFixed(1)}W GPU ${m.anvil.metrics.gpuPowerW.toFixed(1)}W)</span></div>
      <div class="metric"><span class="metric-label">Temp</span><span class="metric-value" style="color:${m.anvil.metrics.cpuTemp > 70 ? '#ff4444' : m.anvil.metrics.cpuTemp > 50 ? '#ffaa00' : '#888'}">CPU ${m.anvil.metrics.cpuTemp.toFixed(0)}&deg;C GPU ${m.anvil.metrics.gpuTemp.toFixed(0)}&deg;C</span></div>
      ` : ''}
      <div class="metric"><span class="metric-label">VRAM</span><span class="metric-value">${totalVRAM} / 96 GB</span></div>
      ${m.anvil.jobs ? `<div class="metric"><span class="metric-label">Jobs</span><span class="metric-value">${m.anvil.jobs.total} total, ${m.anvil.jobs.active} active, ${m.anvil.jobs.todayCount} today</span></div>` : ''}
    </div>
    <div class="model-list">
      <div style="color:#666;font-size:11px;margin:8px 0 4px">MODELS (${m.anvil.loadedModels.length} loaded)</div>
      ${m.anvil.models.map(md => `<div class="model ${m.anvil.loadedModels.includes(md.name) ? 'loaded' : ''}"><span class="model-name">${md.name}</span><span class="model-size">${md.size}</span></div>`).join('')}
    </div>
    ${m.anvil.agents && m.anvil.agents.length > 0 ? `<div style="margin-top:12px">
      <div style="color:#666;font-size:11px;margin-bottom:6px">AGENTS (${m.anvil.agents.filter(a => a.status === 'active').length} active)</div>
      ${m.anvil.agents.map(a => {
        const agentDot = a.status === 'active' ? dot(true) : '<span style="display:inline-block;width:12px;height:12px;background:#555;border-radius:50%;margin-right:8px"></span>';
        return '<div class="svc">' + agentDot + '<span style="color:#e0e0e0;font-weight:bold">' + (a.agent || 'unknown') + '</span><span style="color:#555;margin-left:8px;font-size:11px">' + (a.task || '') + '</span></div>';
      }).join('')}
    </div>` : ''}
  </div>

  <div class="card">
    <div class="card-header">${dot(m.nas.reachable)}<div><div class="card-name">NAS</div><div class="card-role">Storage + Hosting</div></div></div>
    <div class="card-ip">LAN: ${m.nas.ip} | TS: ${m.nas.tailscale}</div>
    <div style="margin-top:8px">
      <div class="metric"><span class="metric-label">Ping</span><span class="metric-value">${m.nas.ping}</span></div>
      <div class="metric"><span class="metric-label">Services</span><span class="metric-value">Caddy, cloudflared, Time Machine</span></div>
      <div class="metric"><span class="metric-label">Storage</span><span class="metric-value">16TB total, ~14TB free</span></div>
    </div>
  </div>
</div>

<div class="topology">
  <div class="topo-title">NETWORK TOPOLOGY</div>
  <pre class="topo">
  Internet <span>&lt;-&gt;</span> Cloudflare Tunnel <span>&lt;-&gt;</span> NAS (Caddy :8080/:8081)
                                           |
                                     LAN (1GbE*)
                           +----------+----------+
                           |          |          |
                        <span>Hearth</span>    <span>Anvil</span>      <span>NAS</span>
                        .113      .105       .57
                           |          |
                           +----+-----+
                                | <span>10GbE pending (QNAP in cart)</span>
                                |
                         Tailscale Mesh
                    +-------+-------+-------+
                  <span>iPad</span>   <span>iPhone</span>  <span>Hearth</span>  <span>Anvil</span>  <span>NAS</span>
  </pre>
</div>

<div style="color:#333;font-size:11px;text-align:center;margin-top:20px">
  Auto-refresh 30s | Docs: ~/.claude/HEARTH-ANVIL-COLLABORATION.md
</div>
</div></body></html>`;
}

// ─── Downloads Page — File Organization Visibility + Rule Management ───

const DOWNLOADS_DIR = path.join(process.env.HOME, 'Downloads');
const DOWNLOAD_RULES_FILE = path.join(DOWNLOADS_DIR, '.download-rules.json');
const DOWNLOAD_LOG_FILE = path.join(process.env.HOME, '.download-daemon.log');
const DOWNLOAD_PINS_FILE = path.join(DOWNLOADS_DIR, '.download-pinned.json');
const DOWNLOAD_CORRECTIONS_FILE = path.join(process.env.HOME, '.download-corrections.jsonl');
const PLAYWRIGHT_SEEN_FILE = path.join(process.env.HOME, '.playwright-bridge-seen.json');
const DOWNLOAD_TAGS_FILE = path.join(DOWNLOADS_DIR, '.download-tags.json');

// ─── File Management Hub: Agent & Daemon Status ───

const QUARANTINE_DIR = path.join(process.env.HOME, '.claude', 'quarantine');
const QUARANTINE_LOG = path.join(QUARANTINE_DIR, 'QUARANTINE-LOG.md');
const SKILLS_DIR = path.join(process.env.HOME, '.claude', 'skills');
const AGENT_ACTIVITY_FILE = path.join(process.env.HOME, '.claude', 'agent-activity.jsonl');
const DATA_SOURCES_FILE = path.join(process.env.HOME, '.claude', 'data-sources.json');

function getFileAgents() {
  const agents = [];

  // 1. Download daemon
  const daemonRunning = run('launchctl list | grep -q download-daemon && echo "1" || echo "0"', 1000) === '1';
  const daemonLog = path.join(process.env.HOME, '.download-daemon.log');
  let daemonLastActivity = null;
  try {
    const stat = fs.statSync(daemonLog);
    daemonLastActivity = stat.mtime.toISOString();
  } catch {}
  let daemonRuleCount = 0;
  try {
    const config = JSON.parse(fs.readFileSync(DOWNLOAD_RULES_FILE, 'utf8'));
    daemonRuleCount = (config.rules || []).length;
  } catch {}
  agents.push({
    name: 'Download Daemon',
    type: 'daemon',
    status: daemonRunning ? 'running' : 'stopped',
    icon: daemonRunning ? 'ON' : 'OFF',
    detail: `${daemonRuleCount} rules · fswatch ~/Downloads/`,
    lastActivity: daemonLastActivity,
    color: daemonRunning ? '#00ff88' : '#ff4444'
  });

  // 2. Playwright bridge
  let pwBridged = 0;
  try {
    const seen = JSON.parse(fs.readFileSync(PLAYWRIGHT_SEEN_FILE, 'utf8'));
    for (const v of Object.values(seen)) { if (v.bridged) pwBridged++; }
  } catch {}
  agents.push({
    name: 'Playwright Bridge',
    type: 'bridge',
    status: pwBridged > 0 ? 'active' : 'idle',
    icon: String(pwBridged),
    detail: `${pwBridged} files bridged from browser automation`,
    lastActivity: null,
    color: pwBridged > 0 ? '#ff6600' : '#555'
  });

  // 3. Quarantine system
  let quarantineCount = 0;
  let quarantineDirs = [];
  try {
    const entries = fs.readdirSync(QUARANTINE_DIR);
    for (const e of entries) {
      const fp = path.join(QUARANTINE_DIR, e);
      try {
        if (fs.statSync(fp).isDirectory()) {
          const files = fs.readdirSync(fp).filter(f => !f.startsWith('.'));
          quarantineCount += files.length;
          quarantineDirs.push({ date: e, count: files.length });
        }
      } catch {}
    }
  } catch {}
  agents.push({
    name: 'Quarantine',
    type: 'system',
    status: quarantineCount > 0 ? 'review' : 'clear',
    icon: String(quarantineCount),
    detail: quarantineCount > 0 ? `${quarantineCount} files awaiting review` : 'No files in quarantine',
    lastActivity: null,
    color: quarantineCount > 0 ? '#ffaa00' : '#555'
  });

  // 4. Skills (file management related)
  let skillCount = 0;
  let skillNames = [];
  try {
    const skills = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith('.md'));
    skillCount = skills.length;
    skillNames = skills.map(s => s.replace('.md', ''));
  } catch {}
  agents.push({
    name: 'Skills Engine',
    type: 'skills',
    status: skillCount > 0 ? 'loaded' : 'empty',
    icon: String(skillCount),
    detail: skillNames.join(', '),
    lastActivity: null,
    color: '#aa55ff'
  });

  // 5. IRS Transcripts (check latest)
  const irsDir = path.join(process.env.HOME, 'Documents', 'Finances', 'IRS-Transcripts');
  let irsCount = 0;
  try {
    const years = fs.readdirSync(irsDir).filter(d => /^\d{4}$/.test(d));
    for (const year of years) {
      const files = fs.readdirSync(path.join(irsDir, year)).filter(f => f.endsWith('.pdf'));
      irsCount += files.length;
    }
  } catch {}
  if (irsCount > 0) {
    agents.push({
      name: 'IRS Transcripts',
      type: 'archive',
      status: 'stored',
      icon: String(irsCount),
      detail: `${irsCount} PDFs organized by year`,
      lastActivity: null,
      color: '#00aaff'
    });
  }

  // 6. NAS sync status
  const nasAvail = run('mount | grep -q "/Volumes/home" && echo "1" || echo "0"', 2000) === '1';
  agents.push({
    name: 'NAS (DS223j)',
    type: 'storage',
    status: nasAvail ? 'mounted' : 'offline',
    icon: nasAvail ? 'ON' : 'OFF',
    detail: nasAvail ? 'SMB mounted at /Volumes/home' : 'Not mounted',
    lastActivity: null,
    color: nasAvail ? '#00ff88' : '#555'
  });

  return agents;
}

function getQuarantineFiles() {
  const items = [];
  try {
    const entries = fs.readdirSync(QUARANTINE_DIR).sort().reverse();
    for (const dateDir of entries) {
      const dp = path.join(QUARANTINE_DIR, dateDir);
      try {
        if (!fs.statSync(dp).isDirectory()) continue;
        const files = fs.readdirSync(dp).filter(f => !f.startsWith('.'));
        for (const file of files) {
          const fp = path.join(dp, file);
          try {
            const stat = fs.statSync(fp);
            items.push({
              filename: file,
              date: dateDir,
              size: stat.size,
              path: fp,
              isDir: stat.isDirectory()
            });
          } catch {}
        }
      } catch {}
    }
  } catch {}
  return items.slice(0, 50);
}

function getRuleSuggestions() {
  const suggestions = [];
  try {
    const corrections = fs.readFileSync(DOWNLOAD_CORRECTIONS_FILE, 'utf8')
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
    if (corrections.length < 2) return suggestions;

    // Group by extension + destination
    const groups = {};
    for (const c of corrections) {
      const key = `${c.extension}|${c.to}`;
      if (!groups[key]) groups[key] = { ext: c.extension, to: c.to, files: [], keywords: {} };
      groups[key].files.push(c.filename);
      for (const kw of (c.keywords || [])) {
        groups[key].keywords[kw] = (groups[key].keywords[kw] || 0) + 1;
      }
    }

    // Load existing rules to avoid duplicates
    let existingPatterns = new Set();
    try {
      const config = JSON.parse(fs.readFileSync(DOWNLOAD_RULES_FILE, 'utf8'));
      for (const r of config.rules) {
        for (const p of (r.patterns || [])) existingPatterns.add(p.toLowerCase());
      }
    } catch {}

    // Suggest rules for groups with 2+ corrections
    for (const [, g] of Object.entries(groups)) {
      if (g.files.length < 2) continue;
      const pattern = '*' + g.ext;
      // Skip if pattern already covered by existing rules
      if (existingPatterns.has(pattern)) continue;

      const topKeywords = Object.entries(g.keywords)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .filter(([, count]) => count >= 2)
        .map(([kw]) => kw);

      const shortDest = g.to.replace(process.env.HOME, '~');
      suggestions.push({
        pattern,
        contains: topKeywords,
        destination: shortDest,
        count: g.files.length,
        examples: g.files.slice(0, 3)
      });
    }
    suggestions.sort((a, b) => b.count - a.count);
  } catch {}
  return suggestions.slice(0, 5);
}

// ─── Agent Activity Feed ───

function getAgentActivity(limit = 30) {
  try {
    const lines = fs.readFileSync(AGENT_ACTIVITY_FILE, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).reverse().map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function appendActivity(agent, action, target, detail, status = 'done') {
  const entry = { timestamp: new Date().toISOString(), agent, action, target, detail, status };
  try { fs.appendFileSync(AGENT_ACTIVITY_FILE, JSON.stringify(entry) + '\n'); } catch {}
  return entry;
}

// ─── Data Sources Registry ───

function getDataSources() {
  try {
    return JSON.parse(fs.readFileSync(DATA_SOURCES_FILE, 'utf8'));
  } catch { return []; }
}

function updateDataSource(id, updates) {
  const sources = getDataSources();
  const idx = sources.findIndex(s => s.id === id);
  if (idx >= 0) {
    sources[idx] = { ...sources[idx], ...updates, lastUpdated: new Date().toISOString() };
    fs.writeFileSync(DATA_SOURCES_FILE, JSON.stringify(sources, null, 2));
    return sources[idx];
  }
  return null;
}

function getDownloadsData() {
  // Parse recent activity from daemon log
  const activity = [];
  try {
    const logContent = fs.readFileSync(DOWNLOAD_LOG_FILE, 'utf8');
    const lines = logContent.split('\n').filter(Boolean).slice(-200);
    for (const line of lines) {
      const tsMatch = line.match(/^\[([^\]]+)\]\s*(.*)/);
      if (!tsMatch) continue;
      const [, timestamp, msg] = tsMatch;
      if (msg.startsWith('✓ MOVED:') || msg.startsWith('✓ COPIED:')) {
        const moveMatch = msg.match(/✓ (MOVED|COPIED): (.+?) → (.+?) \(rule: (.+?)\)/);
        if (moveMatch) {
          activity.push({ type: moveMatch[1].toLowerCase(), filename: moveMatch[2], destination: moveMatch[3], rule: moveMatch[4], timestamp });
        }
      } else if (msg.startsWith('NO RULE:')) {
        const noMatch = msg.match(/NO RULE: (.+?) \(no matching rule found\)/);
        if (noMatch) activity.push({ type: 'no_rule', filename: noMatch[1], timestamp });
      } else if (msg.startsWith('SKIP:') && msg.includes('too recent')) {
        const skipMatch = msg.match(/SKIP: (.+?) \(too recent: (\d+)s < (\d+)s\)/);
        if (skipMatch) activity.push({ type: 'pending', filename: skipMatch[1], age: parseInt(skipMatch[2]), threshold: parseInt(skipMatch[3]), timestamp });
      } else if (msg.startsWith('SKIP:') && msg.includes('already exists')) {
        const skipMatch = msg.match(/SKIP: (.+?) → (.+?) \(already exists\)/);
        if (skipMatch) activity.push({ type: 'skipped_exists', filename: skipMatch[1], destination: skipMatch[2], timestamp });
      }
    }
  } catch {}

  // Current Downloads directory contents
  const pending = [];
  const pins = loadPins();
  try {
    const files = fs.readdirSync(DOWNLOADS_DIR);
    for (const file of files) {
      if (file.startsWith('.')) continue;
      const fp = path.join(DOWNLOADS_DIR, file);
      try {
        const stats = fs.statSync(fp);
        if (stats.isDirectory()) continue;
        const ageSec = Math.floor((Date.now() - stats.mtimeMs) / 1000);
        const pinned = pins.includes(file);
        // Predict which rule will match
        let matchingRule = null;
        try {
          const config = JSON.parse(fs.readFileSync(DOWNLOAD_RULES_FILE, 'utf8'));
          for (const rule of config.rules) {
            if (rule.disabled) continue;
            const patternsMatch = (rule.patterns || []).some(p => {
              const regex = new RegExp('^' + p.replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
              return regex.test(file);
            });
            if (!patternsMatch) continue;
            if (rule.contains && rule.contains.length > 0) {
              const hasKw = rule.contains.some(kw => file.toLowerCase().includes(kw.toLowerCase()));
              if (!hasKw) continue;
            }
            if (rule.exclude && rule.exclude.length > 0) {
              const hasEx = rule.exclude.some(kw => file.toLowerCase().includes(kw.toLowerCase()));
              if (hasEx) continue;
            }
            if (rule.size_gt) {
              const mult = { KB: 1024, MB: 1048576, GB: 1073741824 };
              const m = rule.size_gt.match(/^(\d+)(KB|MB|GB)?$/i);
              if (m) { const min = parseInt(m[1]) * (mult[(m[2]||'').toUpperCase()] || 1); if (stats.size <= min) continue; }
            }
            matchingRule = rule.name;
            break;
          }
        } catch {}
        pending.push({
          filename: file,
          size: stats.size,
          ageSec,
          countdown: Math.max(0, 300 - ageSec),
          matchingRule: pinned ? '(pinned)' : matchingRule,
          pinned
        });
      } catch {}
    }
    pending.sort((a, b) => a.countdown - b.countdown);
  } catch {}

  // Load rules
  let rules = [];
  try {
    const config = JSON.parse(fs.readFileSync(DOWNLOAD_RULES_FILE, 'utf8'));
    rules = config.rules.map((r, i) => ({ ...r, index: i }));
  } catch {}

  // Collect all known destinations (from rules + recent activity + common paths)
  const destSet = new Set();
  for (const r of rules) { if (r.destination) destSet.add(r.destination.replace('~', process.env.HOME)); }
  for (const a of activity) { if (a.destination) destSet.add(a.destination); }
  // Add common paths
  ['~/Documents/Personal/', '~/Documents/Work/', '~/Documents/Personal/Tax-2024/', '~/Documents/Personal/Tax-2023/',
   '~/Documents/Data/', '~/Documents/Presentations/', '~/Pictures/Downloads/', '~/Pictures/Screenshots/',
   '~/Movies/Downloads/', '~/Music/Downloads/', '~/Projects/', '~/Desktop/'].forEach(p => destSet.add(p.replace('~', process.env.HOME)));
  const destinations = [...destSet].sort();

  // Load corrections
  let corrections = [];
  try {
    corrections = fs.readFileSync(DOWNLOAD_CORRECTIONS_FILE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch {}

  // Stats
  const moved = activity.filter(a => a.type === 'moved' || a.type === 'copied');
  const noRule = activity.filter(a => a.type === 'no_rule');
  const uniqueNoRule = [...new Set(noRule.map(a => a.filename))];

  // Playwright bridge stats
  let playwrightBridged = 0, playwrightSkipped = 0, playwrightDirs = 0;
  try {
    const seen = JSON.parse(fs.readFileSync(PLAYWRIGHT_SEEN_FILE, 'utf8'));
    for (const v of Object.values(seen)) {
      if (v.bridged) playwrightBridged++;
      else if (v.skipped) playwrightSkipped++;
    }
    // Count active dirs
    const tmpDir = process.env.TMPDIR || '/tmp';
    try {
      for (const entry of fs.readdirSync(tmpDir)) {
        if (entry.startsWith('playwright-artifacts-')) playwrightDirs++;
      }
    } catch {}
  } catch {}

  return {
    activity: activity.reverse().slice(0, 50),
    pending,
    rules,
    pins,
    tags: loadTags(),
    destinations,
    corrections: corrections.slice(-20).reverse(),
    stats: {
      totalMoved: moved.length,
      totalNoRule: uniqueNoRule.length,
      totalPending: pending.length,
      totalRules: rules.length,
      totalCorrections: corrections.length,
      daemonRunning: run('launchctl list | grep -q download-daemon && echo "1" || echo "0"', 1000) === '1',
      playwrightBridged,
      playwrightSkipped,
      playwrightDirs
    },
    timestamp: new Date().toISOString()
  };
}

function loadPins() {
  try {
    return JSON.parse(fs.readFileSync(DOWNLOAD_PINS_FILE, 'utf8'));
  } catch { return []; }
}

function savePins(pins) {
  fs.writeFileSync(DOWNLOAD_PINS_FILE, JSON.stringify(pins, null, 2));
}

function handleDownloadsRuleUpdate(update, res) {
  const config = JSON.parse(fs.readFileSync(DOWNLOAD_RULES_FILE, 'utf8'));

  if (update.action === 'add') {
    config.rules.push(update.rule);
  } else if (update.action === 'delete') {
    config.rules.splice(update.index, 1);
  } else if (update.action === 'update') {
    config.rules[update.index] = { ...config.rules[update.index], ...update.rule };
  } else if (update.action === 'toggle') {
    config.rules[update.index].disabled = !config.rules[update.index].disabled;
  } else if (update.action === 'reorder') {
    const [removed] = config.rules.splice(update.from, 1);
    config.rules.splice(update.to, 0, removed);
  }

  fs.writeFileSync(DOWNLOAD_RULES_FILE, JSON.stringify(config, null, 2));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, rules: config.rules.length }));
}

function handleDownloadsUndo(filename, destination, res) {
  const src = path.join(destination, filename);
  const dest = path.join(DOWNLOADS_DIR, filename);
  if (!fs.existsSync(src)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `File not found: ${src}` }));
    return;
  }
  fs.renameSync(src, dest);
  fs.appendFileSync(DOWNLOAD_LOG_FILE, `[${new Date().toISOString()}] ↩ UNDO: ${filename} ← ${destination} (manual via dashboard)\n`);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, restored: dest }));
}

function handleDownloadsRedirect(filename, fromDir, toDir, res) {
  const src = path.join(fromDir, filename);
  if (!fs.existsSync(src)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `File not found: ${src}` }));
    return;
  }
  // Create destination if needed
  if (!fs.existsSync(toDir)) fs.mkdirSync(toDir, { recursive: true });
  const dest = path.join(toDir, filename);
  fs.renameSync(src, dest);

  // Log correction for learning
  const correction = {
    timestamp: new Date().toISOString(),
    filename,
    extension: path.extname(filename).toLowerCase(),
    from: fromDir,
    to: toDir,
    keywords: filename.replace(/[._-]/g, ' ').toLowerCase().split(/\s+/).filter(w => w.length > 2)
  };
  fs.appendFileSync(DOWNLOAD_CORRECTIONS_FILE, JSON.stringify(correction) + '\n');

  // Log in daemon log too
  const shortFrom = fromDir.replace(process.env.HOME, '~');
  const shortTo = toDir.replace(process.env.HOME, '~');
  fs.appendFileSync(DOWNLOAD_LOG_FILE, `[${new Date().toISOString()}] ⇄ REDIRECT: ${filename} | ${shortFrom} → ${shortTo} (manual via dashboard)\n`);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, moved: dest, correction }));
}

function handleDownloadsSendTo(filename, toDir, res) {
  const src = path.join(DOWNLOADS_DIR, filename);
  if (!fs.existsSync(src)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `File not found: ${src}` }));
    return;
  }
  if (!fs.existsSync(toDir)) fs.mkdirSync(toDir, { recursive: true });
  const dest = path.join(toDir, filename);
  fs.renameSync(src, dest);

  // Log as manual sort for learning
  const correction = {
    timestamp: new Date().toISOString(),
    filename,
    extension: path.extname(filename).toLowerCase(),
    from: DOWNLOADS_DIR,
    to: toDir,
    keywords: filename.replace(/[._-]/g, ' ').toLowerCase().split(/\s+/).filter(w => w.length > 2),
    source: 'pending_sendto'
  };
  fs.appendFileSync(DOWNLOAD_CORRECTIONS_FILE, JSON.stringify(correction) + '\n');
  fs.appendFileSync(DOWNLOAD_LOG_FILE, `[${new Date().toISOString()}] ✓ SENT: ${filename} → ${toDir.replace(process.env.HOME, '~')} (manual via dashboard)\n`);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, moved: dest }));
}

function handleDownloadsPin(filename, res) {
  const pins = loadPins();
  const idx = pins.indexOf(filename);
  if (idx >= 0) {
    pins.splice(idx, 1);
  } else {
    pins.push(filename);
  }
  savePins(pins);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, pinned: pins.includes(filename), pins }));
}

// ─── Downloads: Tag management ───

function loadTags() {
  try { return JSON.parse(fs.readFileSync(DOWNLOAD_TAGS_FILE, 'utf8')); }
  catch { return {}; }
}

function saveTags(tags) {
  fs.writeFileSync(DOWNLOAD_TAGS_FILE, JSON.stringify(tags, null, 2));
}

function handleDownloadsTags(filename, tags, res) {
  const allTags = loadTags();
  if (!tags || tags.length === 0) {
    delete allTags[filename];
  } else {
    allTags[filename] = tags;
  }
  saveTags(allTags);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, filename, tags }));
}

// ─── Downloads: Move to any folder ───

function handleDownloadsMoveTo(filename, destination, res) {
  const src = path.join(DOWNLOADS_DIR, filename);
  if (!fs.existsSync(src)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `File not found: ${filename}` }));
    return;
  }
  const dest = destination.replace(/^~/, process.env.HOME);
  if (!fs.existsSync(dest)) {
    try { fs.mkdirSync(dest, { recursive: true }); }
    catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Cannot create dir: ${e.message}` }));
      return;
    }
  }
  const destPath = path.join(dest, filename);
  try {
    fs.renameSync(src, destPath);
    const shortDest = dest.replace(process.env.HOME, '~');
    fs.appendFileSync(DOWNLOAD_LOG_FILE, `[${new Date().toISOString()}] ✓ SENT: ${filename} → ${shortDest} (manual moveto via dashboard)\n`);
    const correction = {
      timestamp: new Date().toISOString(), filename,
      extension: path.extname(filename).toLowerCase(),
      from: DOWNLOADS_DIR, to: dest,
      keywords: filename.replace(/[._-]/g, ' ').toLowerCase().split(/\s+/).filter(w => w.length > 2),
      source: 'moveto'
    };
    fs.appendFileSync(DOWNLOAD_CORRECTIONS_FILE, JSON.stringify(correction) + '\n');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, moved: destPath }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ─── Downloads: File metadata extraction ───

function handleDownloadsMeta(filename, res) {
  const filepath = path.join(DOWNLOADS_DIR, filename);
  if (!fs.existsSync(filepath)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  const stats = fs.statSync(filepath);
  const ext = path.extname(filename).toLowerCase();
  const mime = run(`file -b --mime-type "${filepath}"`, 3000);
  const meta = {
    filename, size: stats.size, ext, mime,
    created: stats.birthtime, modified: stats.mtime,
    tags: (loadTags()[filename] || [])
  };

  // PDF-specific: extract title, page count
  if (ext === '.pdf') {
    try {
      const buf = Buffer.alloc(16384);
      const fd = fs.openSync(filepath, 'r');
      fs.readSync(fd, buf, 0, 16384, 0);
      fs.closeSync(fd);
      const header = buf.toString('latin1');
      // Title
      if (header.includes('/Title')) {
        const idx = header.indexOf('/Title');
        const s = header.indexOf('(', idx);
        if (s > -1) { const e = header.indexOf(')', s); if (e > -1) meta.pdfTitle = header.substring(s + 1, e).trim(); }
      }
      // Page count (heuristic)
      const content = fs.readFileSync(filepath).toString('latin1');
      const pages = (content.match(/\/Type\s*\/Page[^s]/g) || []).length;
      if (pages > 0) meta.pdfPages = pages;
      // CreationDate
      const dateMatch = content.match(/\/CreationDate\s*\(D:(\d{4})(\d{2})(\d{2})/);
      if (dateMatch) meta.pdfDate = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
    } catch {}
  }

  // Image-specific
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic'].includes(ext)) {
    const dims = run(`sips -g pixelWidth -g pixelHeight "${filepath}" 2>/dev/null | grep pixel`, 3000);
    if (dims) {
      const wMatch = dims.match(/pixelWidth:\s*(\d+)/);
      const hMatch = dims.match(/pixelHeight:\s*(\d+)/);
      if (wMatch) meta.imgWidth = parseInt(wMatch[1]);
      if (hMatch) meta.imgHeight = parseInt(hMatch[1]);
    }
  }

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(meta, null, 2));
}

// ─── Downloads: Serve file for preview ───

function handleDownloadsPreview(filename, res) {
  const filepath = path.join(DOWNLOADS_DIR, filename);
  if (!fs.existsSync(filepath)) {
    res.writeHead(404); res.end('Not found');
    return;
  }
  const ext = path.extname(filename).toLowerCase();
  const mimeMap = {
    '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.svg': 'image/svg+xml', '.txt': 'text/plain', '.html': 'text/html',
    '.csv': 'text/csv', '.json': 'application/json', '.md': 'text/markdown'
  };
  const contentType = mimeMap[ext] || 'application/octet-stream';
  const stat = fs.statSync(filepath);
  res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': stat.size, 'Content-Disposition': 'inline' });
  fs.createReadStream(filepath).pipe(res);
}

// ─── Downloads: Directory browser ───

function handleDownloadsBrowse(dirPath, res) {
  const resolved = dirPath.replace(/^~/, process.env.HOME);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not a directory' }));
    return;
  }
  try {
    const entries = fs.readdirSync(resolved)
      .filter(e => !e.startsWith('.'))
      .map(e => {
        try {
          const full = path.join(resolved, e);
          const s = fs.statSync(full);
          return { name: e, isDir: s.isDirectory(), size: s.size };
        } catch { return null; }
      })
      .filter(Boolean)
      .filter(e => e.isDir) // Only show directories for move target selection
      .sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(resolved);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ path: resolved, parent, entries }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ─── Queue Page — Unified Task Queue ─────────────────────────────────────
// Fetches from API :3001 /api/q/* endpoints, renders multi-owner task board

function renderQueueHTML() {
  const API = 'https://localhost:3001/api/q';
  return `<!DOCTYPE html><html><head>
<meta charset="utf-8"><title>Queue | Ω₀</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0a;color:#e0e0e0;font-family:'SF Mono','Fira Code',monospace;padding:20px}
.container{max-width:1400px;margin:0 auto}
h1{color:#00ff88;font-size:24px;margin-bottom:4px}
.subtitle{color:#555;font-size:12px;margin-bottom:20px}
a{color:#00ff88;text-decoration:none}a:hover{text-decoration:underline}

.stats-bar{display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap}
.stat-chip{background:#111;border:1px solid #222;border-radius:8px;padding:10px 16px;min-width:100px}
.stat-chip .label{color:#555;font-size:10px;text-transform:uppercase;letter-spacing:.5px}
.stat-chip .val{color:#00ff88;font-size:22px;font-weight:bold}
.stat-chip .val.orange{color:#ffaa00}
.stat-chip .val.red{color:#ff4444}
.stat-chip .val.blue{color:#00aaff}

.owner-tabs{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
.owner-tab{background:#151515;border:1px solid #222;border-radius:6px;padding:6px 16px;cursor:pointer;font-size:12px;color:#888;transition:all .2s}
.owner-tab:hover{border-color:#00ff88;color:#ccc}
.owner-tab.active{background:#00ff8815;border-color:#00ff88;color:#00ff88}
.owner-tab .count{background:#00ff8825;color:#00ff88;padding:1px 6px;border-radius:4px;font-size:10px;margin-left:6px}

.board{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;margin-bottom:24px}
.column{background:#0d0d0d;border:1px solid #1a1a1a;border-radius:8px;padding:12px}
.column-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #1a1a1a}
.column-title{font-size:13px;text-transform:uppercase;letter-spacing:.5px}
.column-title.pending{color:#ffaa00}
.column-title.in_progress{color:#00aaff}
.column-title.blocked{color:#ff4444}
.column-title.completed{color:#00ff88}
.column-count{font-size:11px;color:#444}

.task-card{background:#111;border:1px solid #1e1e1e;border-radius:6px;padding:10px 12px;margin-bottom:8px;cursor:pointer;transition:border-color .2s}
.task-card:hover{border-color:#00ff8844}
.task-card.p1{border-left:3px solid #ff4444}
.task-card.p2{border-left:3px solid #ffaa00}
.task-card.p3{border-left:3px solid #00aaff}
.task-card.p4{border-left:3px solid #888}
.task-card.p5{border-left:3px solid #444}
.task-title{color:#e0e0e0;font-size:12px;font-weight:600;margin-bottom:4px}
.task-meta{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.task-tag{font-size:10px;padding:1px 6px;border-radius:3px}
.task-tag.owner{background:#00ff8815;color:#00ff88}
.task-tag.assignee{background:#00aaff15;color:#00aaff}
.task-tag.category{background:#aa88ff15;color:#aa88ff}
.task-tag.priority{background:#ffaa0015;color:#ffaa00}
.task-tag.messages{background:#ff444415;color:#ff8888}
.task-due{color:#ff4444;font-size:10px}

.thread-panel{display:none;position:fixed;top:0;right:0;width:500px;height:100vh;background:#0a0a0a;border-left:1px solid #222;z-index:100;overflow-y:auto;padding:20px}
.thread-panel.open{display:block}
.thread-close{position:absolute;top:12px;right:12px;color:#555;cursor:pointer;font-size:18px}
.thread-title{color:#00ff88;font-size:16px;margin-bottom:4px}
.thread-desc{color:#888;font-size:12px;margin-bottom:16px;white-space:pre-wrap}
.thread-msg{background:#111;border:1px solid #1e1e1e;border-radius:6px;padding:10px;margin-bottom:8px}
.thread-msg .msg-header{display:flex;justify-content:space-between;margin-bottom:4px}
.thread-msg .msg-author{color:#00aaff;font-size:11px;font-weight:600}
.thread-msg .msg-type{font-size:9px;padding:1px 4px;border-radius:3px;text-transform:uppercase}
.thread-msg .msg-type.question{background:#ffaa0020;color:#ffaa00}
.thread-msg .msg-type.answer{background:#00ff8820;color:#00ff88}
.thread-msg .msg-type.ack{background:#00aaff20;color:#00aaff}
.thread-msg .msg-type.update{background:#88888820;color:#888}
.thread-msg .msg-type.blocker{background:#ff444420;color:#ff4444}
.thread-msg .msg-type.note{background:#aa88ff20;color:#aa88ff}
.thread-msg .msg-content{color:#ccc;font-size:12px;white-space:pre-wrap}
.thread-msg .msg-time{color:#444;font-size:10px;margin-top:4px}

.msg-input{display:flex;gap:8px;margin-top:12px}
.msg-input input{flex:1;background:#111;border:1px solid #222;border-radius:4px;padding:8px;color:#e0e0e0;font-family:inherit;font-size:12px}
.msg-input button{background:#00ff8820;border:1px solid #00ff88;color:#00ff88;padding:8px 16px;border-radius:4px;cursor:pointer;font-family:inherit;font-size:12px}
.msg-input button:hover{background:#00ff8840}

.new-task-form{background:#111;border:1px solid #222;border-radius:8px;padding:16px;margin-bottom:20px;display:none}
.new-task-form.open{display:block}
.new-task-form input,.new-task-form select,.new-task-form textarea{background:#0d0d0d;border:1px solid #222;border-radius:4px;padding:8px;color:#e0e0e0;font-family:inherit;font-size:12px;width:100%;margin-bottom:8px}
.new-task-form textarea{height:60px;resize:vertical}
.form-row{display:flex;gap:8px}
.form-row>*{flex:1}
.btn{background:#00ff8820;border:1px solid #00ff88;color:#00ff88;padding:8px 16px;border-radius:4px;cursor:pointer;font-family:inherit;font-size:12px}
.btn:hover{background:#00ff8840}
.btn-secondary{background:#0d0d0d;border:1px solid #333;color:#888}
.btn-secondary:hover{background:#222}
.toggle-btn{color:#00ff88;cursor:pointer;font-size:12px;background:none;border:1px solid #00ff8844;padding:4px 12px;border-radius:4px;margin-bottom:16px}
.toggle-btn:hover{background:#00ff8815}

.footer{color:#333;font-size:10px;text-align:center;padding:16px;border-top:1px solid #111;margin-top:20px}
</style>
</head><body>
<div class="container">
${renderNav('queue')}
<h1>Task Queue</h1>
<div class="subtitle">Unified task management — Peretz, Kevin, agents. Per-task threads. Priority board.</div>

<div class="stats-bar" id="stats-bar"></div>

<button class="toggle-btn" onclick="toggleNewTask()">+ New Task</button>
<div class="new-task-form" id="new-task-form">
  <input type="text" id="nt-title" placeholder="Task title...">
  <textarea id="nt-desc" placeholder="Description (optional)..."></textarea>
  <div class="form-row">
    <select id="nt-owner"><option value="peretz">Peretz</option><option value="kevin">Kevin</option><option value="claude">Claude</option></select>
    <select id="nt-priority"><option value="1">P1 Critical</option><option value="2">P2 High</option><option value="3" selected>P3 Medium</option><option value="4">P4 Low</option><option value="5">P5 Someday</option></select>
    <select id="nt-category"><option value="">Category...</option><option value="time-sensitive">Time-Sensitive</option><option value="infrastructure">Infrastructure</option><option value="data-work">Data Work</option><option value="review">Review</option><option value="personal">Personal</option><option value="kevin">Kevin</option></select>
  </div>
  <div class="form-row" style="margin-top:8px">
    <button class="btn" onclick="createTask()">Create Task</button>
    <button class="btn btn-secondary" onclick="toggleNewTask()">Cancel</button>
  </div>
</div>

<div class="owner-tabs" id="owner-tabs"></div>
<div class="board" id="board"></div>

<div class="thread-panel" id="thread-panel">
  <span class="thread-close" onclick="closeThread()">✕</span>
  <div id="thread-content"></div>
</div>

<div class="footer">Task Queue · API at <a href="https://localhost:3001/api/q/stats">:3001/api/q</a> · Auto-refreshes every 15s</div>
</div>

<script>
const API = 'https://localhost:3001/api/q';
let currentOwner = null;
let allTasks = [];

async function api(path, opts) {
  try {
    const r = await fetch(API + path, opts);
    return await r.json();
  } catch(e) { console.error(e); return null; }
}

async function loadAll() {
  const [stats, tasks] = await Promise.all([
    api('/stats'),
    api('/tasks?limit=500')
  ]);

  if (stats) renderStats(stats);
  if (tasks) {
    allTasks = tasks.tasks || [];
    renderOwnerTabs(allTasks);
    renderBoard(filterTasks(allTasks));
  }
}

function renderStats(s) {
  const bar = document.getElementById('stats-bar');
  const statusMap = {};
  (s.byStatus || []).forEach(x => statusMap[x.status] = x.count);
  bar.innerHTML =
    chip('Total', s.total, '') +
    chip('Pending', statusMap.pending || 0, 'orange') +
    chip('In Progress', statusMap.in_progress || 0, 'blue') +
    chip('Blocked', statusMap.blocked || 0, 'red') +
    chip('Done Today', s.completedToday || 0, '') +
    chip('Messages (24h)', s.recentMessages || 0, 'blue');
}

function chip(label, val, cls) {
  return '<div class="stat-chip"><div class="label">' + label + '</div><div class="val ' + cls + '">' + val + '</div></div>';
}

function renderOwnerTabs(tasks) {
  const owners = {};
  tasks.forEach(t => {
    if (t.status === 'completed') return;
    owners[t.owner] = (owners[t.owner] || 0) + 1;
    if (t.assignee && t.assignee !== t.owner) owners[t.assignee] = (owners[t.assignee] || 0) + 1;
  });
  const all = tasks.filter(t => t.status !== 'completed').length;
  const tabs = document.getElementById('owner-tabs');
  let html = '<div class="owner-tab' + (currentOwner === null ? ' active' : '') + '" onclick="setOwner(null)">All<span class="count">' + all + '</span></div>';
  Object.entries(owners).sort((a,b) => b[1]-a[1]).forEach(([name, count]) => {
    html += '<div class="owner-tab' + (currentOwner === name ? ' active' : '') + '" onclick="setOwner(\\'' + name + '\\')">' + name + '<span class="count">' + count + '</span></div>';
  });
  tabs.innerHTML = html;
}

function setOwner(owner) {
  currentOwner = owner;
  renderOwnerTabs(allTasks);
  renderBoard(filterTasks(allTasks));
}

function filterTasks(tasks) {
  if (!currentOwner) return tasks;
  return tasks.filter(t => t.owner === currentOwner || t.assignee === currentOwner);
}

function renderBoard(tasks) {
  const cols = {
    pending: tasks.filter(t => t.status === 'pending'),
    in_progress: tasks.filter(t => t.status === 'in_progress'),
    blocked: tasks.filter(t => t.status === 'blocked'),
    completed: tasks.filter(t => t.status === 'completed').slice(0, 10)
  };
  const board = document.getElementById('board');
  board.innerHTML =
    renderColumn('Pending', 'pending', cols.pending) +
    renderColumn('In Progress', 'in_progress', cols.in_progress) +
    renderColumn('Blocked', 'blocked', cols.blocked) +
    renderColumn('Completed', 'completed', cols.completed);
}

function renderColumn(title, status, tasks) {
  const cards = tasks.map(t => renderCard(t)).join('');
  return '<div class="column"><div class="column-header"><span class="column-title ' + status + '">' + title + '</span><span class="column-count">' + tasks.length + '</span></div>' + (cards || '<div style="color:#333;font-size:11px;text-align:center;padding:20px">Empty</div>') + '</div>';
}

function renderCard(t) {
  const msgCount = t.messages ? t.messages.length : 0;
  let meta = '<span class="task-tag priority">P' + t.priority + '</span>';
  if (t.owner) meta += '<span class="task-tag owner">' + t.owner + '</span>';
  if (t.assignee && t.assignee !== t.owner) meta += '<span class="task-tag assignee">' + t.assignee + '</span>';
  if (t.category) meta += '<span class="task-tag category">' + t.category + '</span>';
  if (msgCount > 0) meta += '<span class="task-tag messages">' + msgCount + ' msg</span>';
  if (t.due_date) meta += '<span class="task-due">due ' + t.due_date + '</span>';
  return '<div class="task-card p' + t.priority + '" onclick="openThread(' + t.id + ')"><div class="task-title">' + esc(t.title) + '</div><div class="task-meta">' + meta + '</div></div>';
}

function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

async function openThread(id) {
  const task = await api('/tasks/' + id);
  if (!task) return;
  const panel = document.getElementById('thread-panel');
  const content = document.getElementById('thread-content');

  let statusBtns = '<div style="margin:12px 0;display:flex;gap:6px">';
  ['pending','in_progress','blocked','completed'].forEach(s => {
    const active = task.status === s ? 'background:#00ff8830;' : '';
    statusBtns += '<button style="' + active + 'border:1px solid #333;background:#111;color:#aaa;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:10px;font-family:inherit" onclick="updateStatus(' + id + ',\\'' + s + '\\')">' + s.replace('_',' ') + '</button>';
  });
  statusBtns += '</div>';

  let msgs = (task.messages || []).map(m => {
    return '<div class="thread-msg"><div class="msg-header"><span class="msg-author">' + esc(m.author) + '</span><span class="msg-type ' + m.type + '">' + m.type + '</span></div><div class="msg-content">' + esc(m.content) + '</div><div class="msg-time">' + m.created_at + '</div></div>';
  }).join('');

  content.innerHTML =
    '<div class="thread-title">' + esc(task.title) + '</div>' +
    '<div style="color:#555;font-size:11px;margin-bottom:4px">ID: ' + task.id + ' · Owner: ' + (task.owner||'') + ' · Assignee: ' + (task.assignee||'none') + '</div>' +
    statusBtns +
    (task.description ? '<div class="thread-desc">' + esc(task.description) + '</div>' : '') +
    '<div style="color:#555;font-size:11px;margin:12px 0 8px">Thread (' + (task.messages||[]).length + ')</div>' +
    msgs +
    '<div class="msg-input"><input id="msg-input" placeholder="Add message..." onkeydown="if(event.key===\\'Enter\\')sendMsg(' + id + ')"><button onclick="sendMsg(' + id + ')">Send</button></div>' +
    '<div style="margin-top:12px"><button style="background:#ff444420;border:1px solid #ff4444;color:#ff4444;padding:6px 16px;border-radius:4px;cursor:pointer;font-family:inherit;font-size:12px;font-weight:600" onclick="intervene(' + id + ')">Open Terminal to Intervene</button></div>';

  panel.classList.add('open');
}

function closeThread() {
  document.getElementById('thread-panel').classList.remove('open');
}

async function sendMsg(taskId) {
  const input = document.getElementById('msg-input');
  const content = input.value.trim();
  if (!content) return;
  await api('/tasks/' + taskId + '/messages', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ author: 'peretz', type: 'note', content })
  });
  input.value = '';
  openThread(taskId);
}

async function updateStatus(taskId, status) {
  await api('/tasks/' + taskId, {
    method: 'PATCH',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ status })
  });
  openThread(taskId);
  loadAll();
}

function toggleNewTask() {
  document.getElementById('new-task-form').classList.toggle('open');
}

async function createTask() {
  const title = document.getElementById('nt-title').value.trim();
  if (!title) return;
  await api('/tasks', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      title,
      description: document.getElementById('nt-desc').value.trim() || null,
      owner: document.getElementById('nt-owner').value,
      priority: parseInt(document.getElementById('nt-priority').value),
      category: document.getElementById('nt-category').value || null
    })
  });
  document.getElementById('nt-title').value = '';
  document.getElementById('nt-desc').value = '';
  toggleNewTask();
  loadAll();
}

async function intervene(id) {
  try { await fetch('/api/intervene/' + id, { method: 'POST' }); } catch(e) { console.error(e); }
}

loadAll();
setInterval(loadAll, 15000);
</script>
</body></html>`;
}

function renderFilesHTML() {
  const data = getDownloadsData();
  const agents = getFileAgents();
  const quarantine = getQuarantineFiles();
  const suggestions = getRuleSuggestions();
  const sources = getDataSources();
  const activityFeed = getAgentActivity(20);

  const formatSize = (bytes) => {
    if (bytes > 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
    if (bytes > 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
    if (bytes > 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return bytes + ' B';
  };

  const formatAge = (sec) => {
    if (sec > 3600) return Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
    if (sec > 60) return Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
    return sec + 's';
  };

  // Build destination options for dropdowns
  const destOptions = data.destinations.map(d => {
    const short = d.replace(process.env.HOME, '~');
    return `<option value="${d}">${short}</option>`;
  }).join('');

  // Night mode status
  const nowHour = new Date().getHours();
  const isNightMode = nowHour >= 2 && nowHour < 6;

  // Pending files table (with preview, tags, folder picker)
  const pendingRows = data.pending.map(f => {
    const ruleText = f.matchingRule || '<span style="color:#ff4444">no rule</span>';
    const pinBtn = `<button class="pin-btn ${f.pinned ? 'pinned' : ''}" onclick="togglePin('${f.filename.replace(/'/g, "\\'")}')">📌</button>`;
    const esc = f.filename.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const escAttr = f.filename.replace(/'/g, '&#39;').replace(/"/g, '&quot;');
    const ext = f.filename.includes('.') ? f.filename.split('.').pop().toLowerCase() : '';
    const previewable = ['pdf','png','jpg','jpeg','gif','webp','svg','txt','md','json','csv'].includes(ext);
    const tagList = data.tags[f.filename] || [];
    const tagChips = tagList.map(t => `<span class="tag-chip" onclick="removeTag('${esc}','${t}')">${t} x</span>`).join('');
    return `<tr class="file-row" data-filename="${escAttr}">
      <td class="filename" title="${f.filename}">
        <div style="display:flex;align-items:center;gap:6px">
          ${previewable ? `<button class="preview-btn" onclick="showPreview('${esc}')" title="Preview">&#x1f441;</button>` : '<span style="width:22px;display:inline-block"></span>'}
          <span class="fname-click" onclick="showPreview('${esc}')">${f.filename.length > 32 ? f.filename.slice(0, 29) + '...' : f.filename}</span>
        </div>
        <div class="tag-row">${tagChips}<button class="add-tag-btn" onclick="promptTag('${esc}')">+tag</button></div>
      </td>
      <td style="color:#555">${formatSize(f.size)}</td>
      <td>${ruleText}</td>
      <td class="actions-cell">
        ${pinBtn}
        <select class="dest-select" onchange="sendTo('${esc}',this.value);this.selectedIndex=0" title="Quick send">
          <option value="">Quick...</option>
          ${destOptions}
        </select>
        <button class="browse-btn" onclick="showFolderPicker('${esc}')" title="Browse & move">&#x1f4c2;</button>
      </td>
    </tr>`;
  }).join('');

  // Activity feed
  const activityItems = data.activity.filter(a => a.type === 'moved' || a.type === 'copied').slice(0, 30).map(a => {
    const time = new Date(a.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const shortDest = a.destination.replace(process.env.HOME, '~');
    const icon = a.type === 'moved' ? '→' : '⇒';
    const escFile = a.filename.replace(/'/g, "\\'");
    const escDest = a.destination.replace(/'/g, "\\'");
    return `<div class="activity-item">
      <span class="activity-time">${time}</span>
      <span class="activity-file" title="${a.filename}">${a.filename.length > 30 ? a.filename.slice(0, 27) + '...' : a.filename}</span>
      <span class="activity-arrow">${icon}</span>
      <span class="activity-dest">${shortDest}</span>
      <span class="activity-rule">${a.rule}</span>
      <select class="dest-select" onchange="redirectFile('${escFile}','${escDest}',this.value);this.selectedIndex=0" title="Move elsewhere...">
        <option value="">⇄</option>
        ${destOptions}
      </select>
      <button class="undo-btn" onclick="undoMove('${escFile}','${escDest}')">↩</button>
    </div>`;
  }).join('');

  // No-rule files
  const noRuleItems = [...new Set(data.activity.filter(a => a.type === 'no_rule').map(a => a.filename))].slice(0, 10);
  const noRuleHTML = noRuleItems.map(f =>
    `<div class="no-rule-item"><span>${f}</span><button class="small-btn" onclick="showAddRule('${f.replace(/'/g, "\\'")}')">+ Rule</button></div>`
  ).join('');

  // Rules list
  const rulesHTML = data.rules.map((r, i) => {
    const disabled = r.disabled ? ' disabled' : '';
    const patterns = (r.patterns || []).join(', ');
    const dest = (r.destination || '').replace('~', '~');
    const contains = (r.contains || []).length ? `contains: ${r.contains.join(', ')}` : '';
    const exclude = (r.exclude || []).length ? `exclude: ${r.exclude.join(', ')}` : '';
    const action = r.action || 'move';
    return `<div class="rule-card${disabled}" data-index="${i}">
      <div class="rule-header">
        <span class="rule-num">#${i + 1}</span>
        <span class="rule-name">${r.name}</span>
        <span class="rule-action ${action}">${action}</span>
        <div class="rule-controls">
          <button onclick="toggleRule(${i})" title="${r.disabled ? 'Enable' : 'Disable'}">${r.disabled ? '⏸' : '▶'}</button>
          <button onclick="showEditRule(${i})" title="Edit">✎</button>
          <button onclick="deleteRule(${i})" title="Delete">✕</button>
          ${i > 0 ? `<button onclick="moveRule(${i},${i - 1})" title="Move up">↑</button>` : ''}
          ${i < data.rules.length - 1 ? `<button onclick="moveRule(${i},${i + 1})" title="Move down">↓</button>` : ''}
        </div>
      </div>
      <div class="rule-detail">
        <span class="rule-patterns">${patterns}</span>
        ${contains ? `<span class="rule-filter">${contains}</span>` : ''}
        ${exclude ? `<span class="rule-filter exclude">${exclude}</span>` : ''}
        ${r.size_gt ? `<span class="rule-filter size">size > ${r.size_gt}</span>` : ''}
      </div>
      <div class="rule-dest">→ ${dest}</div>
    </div>`;
  }).join('');

  return `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<title>Files | PracticeLife</title>
<meta http-equiv="refresh" content="30">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#0a0a0a; color:#e0e0e0; font-family:'SF Mono','Fira Code',monospace; padding:20px; }
h1 { color:#00ff88; font-size:24px; margin-bottom:4px; }
h2 { font-size:16px; margin:20px 0 10px 0; padding-bottom:6px; border-bottom:1px solid #222; }
.subtitle { color:#666; font-size:12px; margin-bottom:16px; }

.summary { display:flex; gap:12px; margin-bottom:20px; flex-wrap:wrap; }
.scard { background:#151515; border:1px solid #222; border-radius:8px; padding:10px 16px; text-align:center; flex:1; min-width:100px; }
.scard .num { font-size:28px; font-weight:bold; }
.scard .label { color:#555; font-size:10px; text-transform:uppercase; letter-spacing:1px; margin-top:2px; }
.scard.daemon-on .num { color:#00ff88; }
.scard.daemon-off .num { color:#ff4444; }

.grid { display:grid; grid-template-columns:1fr 1fr; gap:20px; }
@media (max-width:1200px) { .grid { grid-template-columns:1fr; } }

.panel { background:#111; border:1px solid #222; border-radius:10px; padding:16px; }
.panel h2 { border:none; margin:0 0 12px 0; padding:0; }

table { width:100%; border-collapse:collapse; font-size:12px; }
th { text-align:left; color:#555; font-size:10px; text-transform:uppercase; letter-spacing:1px; padding:6px 8px; border-bottom:1px solid #222; }
td { padding:6px 8px; border-bottom:1px solid #1a1a1a; }
.filename { color:#ccc; max-width:250px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

.activity-item { display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid #1a1a1a; font-size:12px; }
.activity-time { color:#555; font-size:11px; min-width:50px; }
.activity-file { color:#ccc; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.activity-arrow { color:#00ff88; font-weight:bold; }
.activity-dest { color:#888; font-size:11px; max-width:200px; overflow:hidden; text-overflow:ellipsis; }
.activity-rule { color:#00aaff; font-size:10px; padding:2px 6px; background:#00aaff11; border-radius:3px; }

.undo-btn { background:none; border:1px solid #333; color:#ffaa00; border-radius:4px; padding:2px 6px; cursor:pointer; font-size:11px; }
.undo-btn:hover { background:#ffaa0022; border-color:#ffaa00; }

.pin-btn { background:none; border:none; cursor:pointer; font-size:14px; opacity:0.3; }
.pin-btn:hover, .pin-btn.pinned { opacity:1; }

.dest-select { background:#0a0a0a; border:1px solid #333; color:#888; border-radius:4px; padding:2px 4px; font-size:11px; font-family:inherit; cursor:pointer; max-width:80px; }
.dest-select:hover { border-color:#aa55ff; color:#e0e0e0; }
.dest-select:focus { outline:none; border-color:#aa55ff; }

.no-rule-item { display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid #1a1a1a; font-size:12px; color:#ff4444; }
.small-btn { background:none; border:1px solid #333; color:#00aaff; border-radius:4px; padding:2px 8px; cursor:pointer; font-size:11px; }
.small-btn:hover { background:#00aaff22; border-color:#00aaff; }

.rule-card { background:#0d0d0d; border:1px solid #222; border-radius:8px; padding:12px; margin-bottom:8px; }
.rule-card.disabled { opacity:0.4; }
.rule-header { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
.rule-num { color:#555; font-size:11px; min-width:24px; }
.rule-name { color:#e0e0e0; font-size:13px; font-weight:bold; flex:1; }
.rule-action { font-size:10px; padding:2px 6px; border-radius:3px; text-transform:uppercase; }
.rule-action.move { color:#00ff88; background:#00ff8811; }
.rule-action.copy { color:#00aaff; background:#00aaff11; }
.rule-controls { display:flex; gap:4px; }
.rule-controls button { background:none; border:1px solid #333; color:#888; border-radius:4px; padding:2px 6px; cursor:pointer; font-size:12px; }
.rule-controls button:hover { color:#e0e0e0; border-color:#555; }
.rule-detail { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:4px; }
.rule-patterns { color:#888; font-size:11px; }
.rule-filter { color:#555; font-size:10px; padding:1px 6px; background:#1a1a1a; border-radius:3px; }
.rule-filter.exclude { color:#ff4444; background:#ff444411; }
.rule-filter.size { color:#ffaa00; background:#ffaa0011; }
.rule-dest { color:#555; font-size:11px; margin-top:4px; }

.add-rule-btn { display:block; width:100%; background:#151515; border:2px dashed #333; color:#555; padding:12px; border-radius:8px; cursor:pointer; font-size:13px; font-family:inherit; margin-top:8px; }
.add-rule-btn:hover { border-color:#00ff88; color:#00ff88; }

.modal-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.8); z-index:100; justify-content:center; align-items:center; }
.modal-overlay.active { display:flex; }
.modal { background:#151515; border:1px solid #333; border-radius:12px; padding:24px; width:500px; max-width:90vw; }
.modal h3 { color:#00ff88; margin-bottom:16px; font-size:16px; }
.modal label { display:block; color:#888; font-size:11px; margin-bottom:4px; margin-top:12px; text-transform:uppercase; letter-spacing:1px; }
.modal input, .modal select { width:100%; background:#0a0a0a; border:1px solid #333; color:#e0e0e0; padding:8px 12px; border-radius:6px; font-family:inherit; font-size:13px; }
.modal input:focus, .modal select:focus { outline:none; border-color:#00ff88; }
.modal .modal-actions { display:flex; gap:8px; margin-top:20px; justify-content:flex-end; }
.modal button { padding:8px 16px; border-radius:6px; border:1px solid #333; background:#1a1a1a; color:#e0e0e0; cursor:pointer; font-family:inherit; font-size:13px; }
.modal button.primary { background:#00ff8822; border-color:#00ff88; color:#00ff88; }
.modal button:hover { opacity:0.8; }

.toast { position:fixed; bottom:20px; right:20px; background:#151515; border:1px solid #00ff88; color:#00ff88; padding:12px 20px; border-radius:8px; font-size:13px; z-index:200; display:none; }
.toast.error { border-color:#ff4444; color:#ff4444; }
.toast.active { display:block; animation: fadeIn 0.3s; }
@keyframes fadeIn { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }

.timestamp { color:#333; font-size:11px; text-align:right; margin-top:16px; }

/* Night mode badge */
.night-badge { display:inline-block; padding:3px 10px; border-radius:4px; font-size:11px; margin-left:8px; }
.night-badge.active { background:#00ff8822; color:#00ff88; border:1px solid #00ff8844; }
.night-badge.inactive { background:#ffaa0022; color:#ffaa00; border:1px solid #ffaa0044; }

/* Preview panel */
.preview-btn { background:none; border:none; cursor:pointer; font-size:14px; opacity:0.4; padding:0; }
.preview-btn:hover { opacity:1; }
.fname-click { cursor:pointer; color:#ccc; }
.fname-click:hover { color:#00ff88; text-decoration:underline; }
.preview-panel { display:none; position:fixed; top:0; right:0; width:50vw; height:100vh; background:#0d0d0d; border-left:2px solid #222; z-index:50; overflow:auto; }
.preview-panel.active { display:block; }
.preview-header { display:flex; justify-content:space-between; align-items:center; padding:12px 16px; border-bottom:1px solid #222; }
.preview-header h3 { color:#00ff88; font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
.preview-close { background:none; border:1px solid #333; color:#ff4444; border-radius:4px; padding:4px 10px; cursor:pointer; font-size:14px; }
.preview-meta { padding:8px 16px; font-size:11px; color:#888; display:flex; flex-wrap:wrap; gap:12px; border-bottom:1px solid #1a1a1a; }
.preview-meta .meta-item { display:flex; gap:4px; }
.preview-meta .meta-label { color:#555; }
.preview-meta .meta-value { color:#ccc; }
.preview-content { padding:16px; }
.preview-content iframe { width:100%; height:calc(100vh - 120px); border:none; border-radius:4px; }
.preview-content img { max-width:100%; border-radius:4px; }

/* Tags */
.tag-row { display:flex; flex-wrap:wrap; gap:3px; margin-top:3px; }
.tag-chip { font-size:9px; padding:1px 6px; background:#aa55ff22; color:#aa55ff; border-radius:3px; cursor:pointer; }
.tag-chip:hover { background:#aa55ff44; }
.add-tag-btn { font-size:9px; background:none; border:1px dashed #333; color:#555; border-radius:3px; padding:1px 4px; cursor:pointer; }
.add-tag-btn:hover { border-color:#aa55ff; color:#aa55ff; }

/* Folder picker */
.browse-btn { background:none; border:1px solid #333; border-radius:4px; padding:2px 6px; cursor:pointer; font-size:13px; }
.browse-btn:hover { border-color:#00ff88; }
/* Agents bar */
.agents-bar { display:flex; gap:10px; margin-bottom:16px; flex-wrap:wrap; }
.agent-card { background:#111; border:1px solid #222; border-radius:8px; padding:8px 14px; display:flex; align-items:center; gap:10px; flex:1; min-width:180px; }
.agent-icon { font-size:20px; font-weight:bold; min-width:30px; text-align:center; }
.agent-info { flex:1; }
.agent-name { font-size:12px; color:#e0e0e0; font-weight:bold; }
.agent-detail { font-size:10px; color:#555; margin-top:1px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:180px; }
.agent-dot { width:8px; height:8px; border-radius:50%; }

/* Quarantine */
.quarantine-item { display:flex; align-items:center; gap:10px; padding:6px 0; border-bottom:1px solid #1a1a1a; font-size:12px; }
.q-date { color:#555; min-width:80px; font-size:11px; }
.q-file { color:#ffaa00; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.q-size { color:#555; min-width:60px; text-align:right; font-size:11px; }

/* Rule suggestions */
.suggestion-card { background:#0d0d0d; border:1px solid #00aaff22; border-radius:8px; padding:10px 14px; margin-bottom:6px; cursor:pointer; }
.suggestion-card:hover { border-color:#00aaff; background:#00aaff08; }
.sugg-header { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.sugg-pattern { color:#00aaff; font-weight:bold; font-size:13px; }
.sugg-keywords { color:#888; font-size:10px; padding:1px 6px; background:#1a1a1a; border-radius:3px; }
.sugg-arrow { color:#00ff88; }
.sugg-dest { color:#00ff88; font-size:12px; }
.sugg-count { color:#555; font-size:10px; margin-left:auto; }
.sugg-examples { color:#444; font-size:10px; margin-top:3px; }

/* Pipeline Summary */
.pipeline-summary { display:flex; gap:8px; margin-bottom:12px; flex-wrap:wrap; }
.ps-card { background:#111; border:1px solid #222; border-radius:6px; padding:6px 14px; text-align:center; cursor:pointer; transition:border-color 0.2s; min-width:80px; }
.ps-card:hover { border-color:#00aaff; }
.ps-num { font-size:20px; font-weight:bold; }
.ps-label { color:#555; font-size:9px; text-transform:uppercase; letter-spacing:1px; }

/* Type Filters */
.type-filters { display:flex; gap:6px; margin-bottom:12px; flex-wrap:wrap; }
.type-filter { background:#111; border:1px solid #222; border-radius:16px; padding:4px 12px; font-size:11px; color:#888; cursor:pointer; font-family:inherit; transition:all 0.2s; }
.type-filter:hover { border-color:var(--filter-color, #00aaff); color:var(--filter-color, #00aaff); }
.type-filter.active { background:var(--filter-color, #00aaff)22; border-color:var(--filter-color, #00aaff); color:var(--filter-color, #00aaff); }

/* Data Sources */
.sources-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(340px, 1fr)); gap:10px; }
.source-card { background:#0d0d0d; border:1px solid #222; border-radius:8px; padding:12px; display:flex; gap:12px; cursor:pointer; transition:border-color 0.2s; }
.source-card:hover { border-color:#00aaff; background:#00aaff05; }
.source-icon { font-size:24px; min-width:32px; text-align:center; padding-top:2px; }
.source-info { flex:1; overflow:hidden; }
.source-name { font-size:13px; color:#e0e0e0; font-weight:bold; }
.source-type { font-size:10px; font-weight:normal; padding:1px 6px; border-radius:3px; background:currentColor; background-clip:text; -webkit-background-clip:text; border:1px solid currentColor; opacity:0.6; margin-left:6px; }
.source-path { font-size:10px; color:#444; margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.source-stats { font-size:11px; color:#666; margin-top:3px; }
.source-tags { display:flex; flex-wrap:wrap; gap:3px; margin-top:4px; }
.source-tag { font-size:9px; padding:1px 6px; background:#00aaff22; color:#00aaff; border-radius:3px; }

/* Agent Activity Feed */
.activity-feed { max-height:300px; overflow-y:auto; }
.feed-item { display:flex; align-items:center; gap:8px; padding:4px 0; border-bottom:1px solid #111; font-size:11px; }
.feed-dot { width:6px; height:6px; border-radius:50%; flex-shrink:0; }
.feed-time { color:#444; min-width:70px; font-size:10px; }
.feed-agent { color:#aa55ff; min-width:80px; font-size:10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:120px; }
.feed-action { color:#00aaff; min-width:50px; font-weight:bold; }
.feed-target { color:#888; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.feed-detail { color:#555; max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

/* Source detail modal */
.source-detail-modal { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.8); z-index:100; justify-content:center; align-items:center; }
.source-detail-modal.active { display:flex; }
.source-detail { background:#151515; border:1px solid #333; border-radius:12px; padding:24px; width:600px; max-width:90vw; max-height:80vh; overflow-y:auto; }

.actions-cell { display:flex; gap:4px; align-items:center; flex-wrap:wrap; }
.folder-list { max-height:400px; overflow-y:auto; }
.folder-item { display:flex; align-items:center; gap:8px; padding:6px 8px; cursor:pointer; border-radius:4px; font-size:13px; color:#ccc; }
.folder-item:hover { background:#1a1a1a; color:#00ff88; }
.folder-item .icon { color:#ffaa00; }
.folder-path { background:#0a0a0a; border:1px solid #333; border-radius:6px; padding:6px 10px; color:#888; font-size:12px; margin-bottom:12px; display:flex; align-items:center; gap:8px; }
.folder-path input { flex:1; background:none; border:none; color:#e0e0e0; font-family:inherit; font-size:12px; outline:none; }
.folder-up { background:none; border:1px solid #333; color:#888; border-radius:4px; padding:2px 8px; cursor:pointer; font-size:11px; }
.folder-up:hover { border-color:#00ff88; color:#00ff88; }
</style>
</head><body>
${renderNav('files')}
<h1>File Management Hub <span class="night-badge ${isNightMode ? 'active' : 'inactive'}">${isNightMode ? 'AUTO-ROUTE ON (2-6am)' : 'MANUAL (auto 2-6am)'}</span></h1>
<div class="subtitle">Daemons, agents, and skills working together · Quarantine review · Rule learning · ${data.stats.totalRules} routing rules active</div>

<!-- Agents & Daemons Status Bar -->
<div class="agents-bar">
${agents.map(a => `  <div class="agent-card" style="border-color:${a.color}33">
    <div class="agent-icon" style="color:${a.color}">${a.icon}</div>
    <div class="agent-info">
      <div class="agent-name">${a.name}</div>
      <div class="agent-detail">${a.detail}</div>
    </div>
    <div class="agent-dot" style="background:${a.status === 'running' || a.status === 'mounted' || a.status === 'active' || a.status === 'stored' || a.status === 'loaded' ? a.color : '#555'}"></div>
  </div>`).join('\n')}
</div>

<div class="summary">
  <div class="scard"><div class="num" style="color:#ffaa00">${data.stats.totalPending}</div><div class="label">Pending</div></div>
  <div class="scard"><div class="num" style="color:#00ff88">${data.stats.totalMoved}</div><div class="label">Routed</div></div>
  <div class="scard"><div class="num" style="color:#ff4444">${data.stats.totalNoRule}</div><div class="label">No Rule</div></div>
  <div class="scard"><div class="num" style="color:#00aaff">${data.stats.totalRules}</div><div class="label">Rules</div></div>
  <div class="scard"><div class="num" style="color:#aa55ff">${data.stats.totalCorrections}</div><div class="label">Corrections</div></div>
  <div class="scard"><div class="num" style="color:#ff6600">${data.stats.playwrightBridged}</div><div class="label">PW Bridged</div></div>
  <div class="scard"><div class="num" style="color:${quarantine.length > 0 ? '#ffaa00' : '#555'}">${quarantine.length}</div><div class="label">Quarantine</div></div>
</div>

<div class="grid">
  <div class="panel">
    <h2 style="color:#ffaa00">Pending Files (~/Downloads/)</h2>
    <table>
      <tr><th>File</th><th>Size</th><th>Night Rule</th><th>Actions</th></tr>
      ${pendingRows || '<tr><td colspan="5" style="color:#555;text-align:center;padding:20px">Downloads folder is empty</td></tr>'}
    </table>
  </div>

  <div class="panel">
    <h2 style="color:#00ff88">Recent Activity</h2>
    ${activityItems || '<div style="color:#555;text-align:center;padding:20px">No recent activity in log</div>'}
    ${noRuleItems.length ? `<h2 style="color:#ff4444;margin-top:16px">Unmatched Files</h2>${noRuleHTML}` : ''}
  </div>
</div>

<!-- Data Sources Registry -->
<div style="margin-top:20px">
  <h2 style="color:#00aaff">Data Sources <span style="color:#555;font-size:12px;font-weight:normal">(${sources.length} discovered)</span></h2>
  <div style="color:#555;font-size:11px;margin-bottom:12px">Click a source to annotate, tag, or connect to a processing pipeline. Agents use this registry to discover data for flows.</div>

  <!-- Pipeline Status Summary -->
  <div class="pipeline-summary">
    ${(() => {
      const counts = { complete: 0, active: 0, available: 0, none: 0 };
      let totalFiles = 0, totalSize = '';
      sources.forEach(s => { counts[s.pipelineStatus] = (counts[s.pipelineStatus] || 0) + 1; totalFiles += (s.fileCount || 0); });
      return `<div class="ps-card" onclick="filterSources('all')"><div class="ps-num" style="color:#00aaff">${sources.length}</div><div class="ps-label">Total</div></div>
        <div class="ps-card" onclick="filterSources('complete')"><div class="ps-num" style="color:#00ff88">${counts.complete}</div><div class="ps-label">Complete</div></div>
        <div class="ps-card" onclick="filterSources('active')"><div class="ps-num" style="color:#00aaff">${counts.active}</div><div class="ps-label">Active</div></div>
        <div class="ps-card" onclick="filterSources('available')"><div class="ps-num" style="color:#ffaa00">${counts.available}</div><div class="ps-label">Available</div></div>
        <div class="ps-card" onclick="filterSources('none')"><div class="ps-num" style="color:#ff4444">${counts.none}</div><div class="ps-label">No Pipeline</div></div>
        <div class="ps-card"><div class="ps-num" style="color:#e0e0e0">${totalFiles > 1000000 ? (totalFiles / 1000000).toFixed(1) + 'M' : totalFiles > 1000 ? Math.round(totalFiles / 1000) + 'K' : totalFiles}</div><div class="ps-label">Total Files</div></div>`;
    })()}
  </div>

  <!-- Type Filters -->
  <div class="type-filters">
    <button class="type-filter active" data-type="all" onclick="filterByType('all')">All</button>
    ${(() => {
      const typeCounts = {};
      sources.forEach(s => { typeCounts[s.type] = (typeCounts[s.type] || 0) + 1; });
      const typeColors2 = { contacts: '#ff6600', email: '#ffaa00', photos: '#00aaff', voice: '#aa55ff', documents: '#00ff88', financial: '#00ff88', archives: '#555', calendar: '#ff66aa', tasks: '#ff9900', automation: '#66ccff' };
      return Object.entries(typeCounts).sort((a,b) => b[1] - a[1]).map(([type, count]) =>
        `<button class="type-filter" data-type="${type}" onclick="filterByType('${type}')" style="--filter-color:${typeColors2[type] || '#555'}">${type} (${count})</button>`
      ).join('');
    })()}
  </div>

  <div class="sources-grid" id="sourcesGrid">
    ${sources.length > 0 ? sources.map(s => {
      const typeColors = { contacts: '#ff6600', email: '#ffaa00', photos: '#00aaff', voice: '#aa55ff', documents: '#00ff88', financial: '#00ff88', code: '#888', archives: '#555', calendar: '#ff66aa', tasks: '#ff9900', automation: '#66ccff' };
      const typeIcons = { contacts: '&#x1F464;', email: '&#x2709;', photos: '&#x1F4F7;', voice: '&#x1F3A4;', documents: '&#x1F4C4;', financial: '&#x1F4B0;', code: '&#x2699;', archives: '&#x1F4E6;', calendar: '&#x1F4C5;', tasks: '&#x2705;', automation: '&#x26A1;' };
      const color = typeColors[s.type] || '#555';
      const icon = typeIcons[s.type] || '&#x1F4C1;';
      const pipeline = s.pipelineStatus === 'complete' ? '<span style="color:#00ff88">complete</span>'
        : s.pipelineStatus === 'active' ? '<span style="color:#00aaff">active</span>'
        : s.pipelineStatus === 'available' ? '<span style="color:#ffaa00">available</span>'
        : '<span style="color:#555">none</span>';
      const shortPath = (s.path || '').replace(process.env.HOME, '~');
      const escId = (s.id || '').replace(/'/g, "\\'");
      const tagChips = (s.tags || []).map(t => `<span class="source-tag">${t}</span>`).join('');
      return `<div class="source-card" style="border-color:${color}33" data-type="${s.type}" data-pipeline="${s.pipelineStatus}" onclick="showSourceDetail('${escId}')">
        <div class="source-icon" style="color:${color}">${icon}</div>
        <div class="source-info">
          <div class="source-name">${s.name} <span class="source-type" style="color:${color}">${s.type}</span></div>
          <div class="source-path" title="${s.path}">${shortPath}</div>
          <div class="source-stats">${(s.fileCount || 0).toLocaleString()} files · ${s.sizeHuman || '?'} · pipeline: ${pipeline}</div>
          ${tagChips ? `<div class="source-tags">${tagChips}</div>` : ''}
        </div>
      </div>`;
    }).join('') : '<div style="color:#555;text-align:center;padding:20px">Scanning filesystem... Data sources will appear here shortly.</div>'}
  </div>
</div>

<!-- Agent Activity Feed -->
<div style="margin-top:20px">
  <h2 style="color:#aa55ff">Agent Activity Feed <span style="color:#555;font-size:12px;font-weight:normal">(live)</span></h2>
  <div style="color:#555;font-size:11px;margin-bottom:8px">Real-time log of what Claude agents are doing with your files. Auto-refreshes every 30s.</div>
  <div class="activity-feed">
    ${activityFeed.length > 0 ? activityFeed.slice(0, 20).map(a => {
      const statusColor = a.status === 'done' ? '#00ff88' : a.status === 'running' ? '#00aaff' : a.status === 'error' ? '#ff4444' : '#555';
      const time = new Date(a.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const shortTarget = (a.target || '').replace(process.env.HOME, '~');
      return `<div class="feed-item">
        <span class="feed-dot" style="background:${statusColor}"></span>
        <span class="feed-time">${time}</span>
        <span class="feed-agent">${a.agent || '?'}</span>
        <span class="feed-action">${a.action || '?'}</span>
        <span class="feed-target" title="${a.target}">${shortTarget.length > 40 ? shortTarget.slice(0, 37) + '...' : shortTarget}</span>
        <span class="feed-detail">${(a.detail || '').length > 50 ? a.detail.slice(0, 47) + '...' : a.detail || ''}</span>
      </div>`;
    }).join('') : '<div style="color:#555;text-align:center;padding:12px">No agent activity yet</div>'}
  </div>
</div>

<div style="margin-top:20px">
  <h2 style="color:#00aaff">Routing Rules (first match wins)</h2>
  ${rulesHTML}
  <button class="add-rule-btn" onclick="showAddRule()">+ Add New Rule</button>
</div>

${data.corrections.length ? `<div style="margin-top:20px">
  <h2 style="color:#aa55ff">Corrections Log (daemon learns from these)</h2>
  <div style="color:#555;font-size:11px;margin-bottom:12px">Every redirect and manual sort is recorded. Patterns here will inform future rule suggestions.</div>
  ${data.corrections.slice(0, 10).map(c => {
    const time = new Date(c.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const shortFrom = (c.from || '').replace(process.env.HOME, '~');
    const shortTo = (c.to || '').replace(process.env.HOME, '~');
    return `<div style="display:flex;gap:8px;padding:6px 0;border-bottom:1px solid #1a1a1a;font-size:12px;align-items:center">
      <span style="color:#555;min-width:90px">${time}</span>
      <span style="color:#ccc;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${c.filename}</span>
      <span style="color:#ff4444">${shortFrom}</span>
      <span style="color:#aa55ff">→</span>
      <span style="color:#00ff88">${shortTo}</span>
    </div>`;
  }).join('')}
</div>` : ''}

${quarantine.length > 0 ? `<div style="margin-top:20px">
  <h2 style="color:#ffaa00">Quarantine Review (${quarantine.length} files)</h2>
  <div style="color:#555;font-size:11px;margin-bottom:12px">Files moved here by agents for your review. Restore to Downloads or delete permanently.</div>
  ${quarantine.map(q => {
    const escPath = q.path.replace(/'/g, "\\'");
    const shortSize = q.size > 1048576 ? (q.size / 1048576).toFixed(1) + ' MB' : q.size > 1024 ? (q.size / 1024).toFixed(1) + ' KB' : q.size + ' B';
    return `<div class="quarantine-item">
      <span class="q-date">${q.date}</span>
      <span class="q-file" title="${q.filename}">${q.filename.length > 40 ? q.filename.slice(0, 37) + '...' : q.filename}</span>
      <span class="q-size">${shortSize}</span>
      <button class="small-btn" onclick="restoreQuarantine('${escPath}')" style="color:#00ff88;border-color:#00ff8844">Restore</button>
      <button class="small-btn" onclick="deleteQuarantine('${escPath}','${q.filename.replace(/'/g, "\\'")}')" style="color:#ff4444;border-color:#ff444444">Delete</button>
    </div>`;
  }).join('')}
</div>` : ''}

${suggestions.length > 0 ? `<div style="margin-top:20px">
  <h2 style="color:#00aaff">Rule Suggestions (from corrections)</h2>
  <div style="color:#555;font-size:11px;margin-bottom:12px">Based on ${data.stats.totalCorrections} manual corrections. Click to create a rule.</div>
  ${suggestions.map(s => {
    const escPattern = s.pattern.replace(/'/g, "\\'");
    const escContains = JSON.stringify(s.contains).replace(/'/g, "\\'");
    const escDest = s.destination.replace(/'/g, "\\'");
    return `<div class="suggestion-card" onclick="createFromSuggestion('${escPattern}',${escContains},'${escDest}')">
      <div class="sugg-header">
        <span class="sugg-pattern">${s.pattern}</span>
        ${s.contains.length ? `<span class="sugg-keywords">contains: ${s.contains.join(', ')}</span>` : ''}
        <span class="sugg-arrow">→</span>
        <span class="sugg-dest">${s.destination}</span>
        <span class="sugg-count">${s.count}x</span>
      </div>
      <div class="sugg-examples">e.g. ${s.examples.map(e => e.length > 30 ? e.slice(0, 27) + '...' : e).join(', ')}</div>
    </div>`;
  }).join('')}
</div>` : ''}

<div class="modal-overlay" id="ruleModal">
  <div class="modal">
    <h3 id="modalTitle">Add Rule</h3>
    <input type="hidden" id="ruleIndex" value="-1">
    <label>Rule Name</label>
    <input id="ruleName" placeholder="e.g. Tax Documents">
    <label>File Patterns (comma-separated globs)</label>
    <input id="rulePatterns" placeholder="e.g. *.pdf, *.doc">
    <label>Contains Keywords (optional, comma-separated)</label>
    <input id="ruleContains" placeholder="e.g. tax, irs, w2">
    <label>Exclude Keywords (optional)</label>
    <input id="ruleExclude" placeholder="e.g. resume, cv">
    <label>Destination</label>
    <input id="ruleDest" placeholder="e.g. ~/Documents/Tax/">
    <label>Action</label>
    <select id="ruleAction"><option value="move">Move</option><option value="copy">Copy</option></select>
    <div class="modal-actions">
      <button onclick="closeModal()">Cancel</button>
      <button class="primary" onclick="saveRule()">Save Rule</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<!-- Preview Panel (slide-in from right) -->
<div class="preview-panel" id="previewPanel">
  <div class="preview-header">
    <h3 id="previewTitle">Preview</h3>
    <button class="preview-close" onclick="closePreview()">X</button>
  </div>
  <div class="preview-meta" id="previewMeta"></div>
  <div class="preview-content" id="previewContent"></div>
</div>

<!-- Source Detail Modal -->
<div class="source-detail-modal" id="sourceModal">
  <div class="source-detail">
    <h3 style="color:#00aaff;margin-bottom:16px" id="sourceModalTitle">Source Detail</h3>
    <div id="sourceModalBody"></div>
    <div style="margin-top:16px">
      <label style="display:block;color:#888;font-size:11px;margin-bottom:4px;text-transform:uppercase;letter-spacing:1px">Tags (comma-separated)</label>
      <input id="sourceTagsInput" style="width:100%;background:#0a0a0a;border:1px solid #333;color:#e0e0e0;padding:8px 12px;border-radius:6px;font-family:inherit;font-size:13px" placeholder="e.g. contacts, importable, needs-dedup">
      <label style="display:block;color:#888;font-size:11px;margin-bottom:4px;margin-top:12px;text-transform:uppercase;letter-spacing:1px">Pipeline Target</label>
      <select id="sourcePipelineInput" style="width:100%;background:#0a0a0a;border:1px solid #333;color:#e0e0e0;padding:8px 12px;border-radius:6px;font-family:inherit;font-size:13px">
        <option value="">None</option>
        <option value="contact-dedup">Contact Dedup</option>
        <option value="memoryatlas">MemoryAtlas</option>
        <option value="era-metadata">ERA Metadata</option>
        <option value="email-import">Email Import</option>
        <option value="photo-index">Photo Index</option>
        <option value="financial-review">Financial Review</option>
        <option value="vault-import">Vault Import</option>
        <option value="vault-sync">Vault Sync</option>
        <option value="timeline-enrichment">Timeline Enrichment</option>
        <option value="daily-planning">Daily Planning</option>
        <option value="contact-extraction">Contact Extraction</option>
        <option value="document-index">Document Index</option>
      </select>
      <label style="display:block;color:#888;font-size:11px;margin-bottom:4px;margin-top:12px;text-transform:uppercase;letter-spacing:1px">Notes</label>
      <textarea id="sourceNotesInput" rows="3" style="width:100%;background:#0a0a0a;border:1px solid #333;color:#e0e0e0;padding:8px 12px;border-radius:6px;font-family:inherit;font-size:13px;resize:vertical" placeholder="What's in here? What should agents know?"></textarea>
    </div>
    <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
      <button onclick="closeSourceModal()" style="padding:8px 16px;border-radius:6px;border:1px solid #333;background:#1a1a1a;color:#e0e0e0;cursor:pointer;font-family:inherit;font-size:13px">Cancel</button>
      <button onclick="saveSourceAnnotation()" style="padding:8px 16px;border-radius:6px;border:1px solid #00aaff;background:#00aaff22;color:#00aaff;cursor:pointer;font-family:inherit;font-size:13px">Save</button>
    </div>
  </div>
</div>

<!-- Folder Picker Modal -->
<div class="modal-overlay" id="folderModal">
  <div class="modal" style="width:600px">
    <h3>Move <span id="folderFilename" style="color:#ffaa00"></span> to...</h3>
    <div class="folder-path">
      <button class="folder-up" onclick="folderUp()">&#x2191; Up</button>
      <input id="folderPathInput" onkeydown="if(event.key==='Enter')browseTo(this.value)" placeholder="Type path or browse...">
    </div>
    <div class="folder-list" id="folderList"></div>
    <div class="modal-actions">
      <button onclick="closeFolderModal()">Cancel</button>
      <button class="primary" onclick="confirmMove()">Move Here</button>
    </div>
  </div>
</div>

<div class="timestamp">${data.timestamp} · Auto-refresh 30s · ${isNightMode ? 'Night auto-route active' : 'Day mode — manual sorting'}</div>

<script>
function toast(msg, isError) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast active' + (isError ? ' error' : '');
  setTimeout(() => t.className = 'toast', 3000);
}

async function api(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

async function redirectFile(filename, from, to) {
  if (!to) return;
  const r = await api('/api/downloads/redirect', { filename, from, to });
  if (r.ok) { toast('Redirected: ' + filename + ' → ' + to.replace(/.*\\//, '').replace(/.*\\//, '')); setTimeout(() => location.reload(), 800); }
  else toast(r.error, true);
}

async function sendTo(filename, to) {
  if (!to) return;
  const r = await api('/api/downloads/sendto', { filename, to });
  if (r.ok) { toast('Sent: ' + filename); setTimeout(() => location.reload(), 800); }
  else toast(r.error, true);
}

async function undoMove(filename, destination) {
  if (!confirm('Move ' + filename + ' back to Downloads?')) return;
  const r = await api('/api/downloads/undo', { filename, destination });
  if (r.ok) { toast('Restored: ' + filename); setTimeout(() => location.reload(), 1000); }
  else toast(r.error, true);
}

async function togglePin(filename) {
  const r = await api('/api/downloads/pin', { filename });
  if (r.ok) { toast(r.pinned ? 'Pinned: ' + filename : 'Unpinned: ' + filename); setTimeout(() => location.reload(), 500); }
  else toast(r.error, true);
}

async function toggleRule(index) {
  const r = await api('/api/downloads/rules', { action: 'toggle', index });
  if (r.ok) { toast('Rule toggled'); setTimeout(() => location.reload(), 500); }
  else toast(r.error, true);
}

async function deleteRule(index) {
  if (!confirm('Delete this rule?')) return;
  const r = await api('/api/downloads/rules', { action: 'delete', index });
  if (r.ok) { toast('Rule deleted'); setTimeout(() => location.reload(), 500); }
  else toast(r.error, true);
}

async function moveRule(from, to) {
  const r = await api('/api/downloads/rules', { action: 'reorder', from, to });
  if (r.ok) setTimeout(() => location.reload(), 300);
}

function showAddRule(filename) {
  document.getElementById('ruleIndex').value = '-1';
  document.getElementById('modalTitle').textContent = 'Add Rule';
  document.getElementById('ruleName').value = '';
  document.getElementById('rulePatterns').value = filename ? '*' + (filename.includes('.') ? '.' + filename.split('.').pop() : '') : '';
  document.getElementById('ruleContains').value = '';
  document.getElementById('ruleExclude').value = '';
  document.getElementById('ruleDest').value = '';
  document.getElementById('ruleAction').value = 'move';
  document.getElementById('ruleModal').classList.add('active');
}

function showEditRule(index) {
  const rules = ${JSON.stringify(data.rules)};
  const r = rules[index];
  document.getElementById('ruleIndex').value = index;
  document.getElementById('modalTitle').textContent = 'Edit Rule: ' + r.name;
  document.getElementById('ruleName').value = r.name || '';
  document.getElementById('rulePatterns').value = (r.patterns || []).join(', ');
  document.getElementById('ruleContains').value = (r.contains || []).join(', ');
  document.getElementById('ruleExclude').value = (r.exclude || []).join(', ');
  document.getElementById('ruleDest').value = r.destination || '';
  document.getElementById('ruleAction').value = r.action || 'move';
  document.getElementById('ruleModal').classList.add('active');
}

function closeModal() { document.getElementById('ruleModal').classList.remove('active'); }

async function saveRule() {
  const idx = parseInt(document.getElementById('ruleIndex').value);
  const rule = {
    name: document.getElementById('ruleName').value,
    patterns: document.getElementById('rulePatterns').value.split(',').map(s => s.trim()).filter(Boolean),
    destination: document.getElementById('ruleDest').value,
    action: document.getElementById('ruleAction').value
  };
  const contains = document.getElementById('ruleContains').value.split(',').map(s => s.trim()).filter(Boolean);
  if (contains.length) rule.contains = contains;
  const exclude = document.getElementById('ruleExclude').value.split(',').map(s => s.trim()).filter(Boolean);
  if (exclude.length) rule.exclude = exclude;

  if (!rule.name || !rule.patterns.length || !rule.destination) {
    toast('Name, patterns, and destination are required', true);
    return;
  }

  const action = idx >= 0 ? 'update' : 'add';
  const body = idx >= 0 ? { action, index: idx, rule } : { action, rule };
  const r = await api('/api/downloads/rules', body);
  if (r.ok) { toast('Rule saved'); closeModal(); setTimeout(() => location.reload(), 500); }
  else toast(r.error, true);
}

document.getElementById('ruleModal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('ruleModal')) closeModal();
});
document.getElementById('folderModal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('folderModal')) closeFolderModal();
});

// ─── Preview Panel ───
async function showPreview(filename) {
  const panel = document.getElementById('previewPanel');
  const title = document.getElementById('previewTitle');
  const meta = document.getElementById('previewMeta');
  const content = document.getElementById('previewContent');

  title.textContent = filename;
  meta.innerHTML = '<span style="color:#555">Loading metadata...</span>';
  content.innerHTML = '';
  panel.classList.add('active');

  // Fetch metadata
  try {
    const r = await fetch('/api/downloads/meta/' + encodeURIComponent(filename));
    const m = await r.json();
    let metaHTML = '';
    metaHTML += '<div class="meta-item"><span class="meta-label">Size:</span><span class="meta-value">' + formatBytes(m.size) + '</span></div>';
    metaHTML += '<div class="meta-item"><span class="meta-label">Type:</span><span class="meta-value">' + (m.mime || m.ext) + '</span></div>';
    if (m.pdfTitle) metaHTML += '<div class="meta-item"><span class="meta-label">PDF Title:</span><span class="meta-value" style="color:#00ff88">' + m.pdfTitle + '</span></div>';
    if (m.pdfPages) metaHTML += '<div class="meta-item"><span class="meta-label">Pages:</span><span class="meta-value">' + m.pdfPages + '</span></div>';
    if (m.pdfDate) metaHTML += '<div class="meta-item"><span class="meta-label">PDF Date:</span><span class="meta-value" style="color:#ffaa00">' + m.pdfDate + '</span></div>';
    if (m.imgWidth) metaHTML += '<div class="meta-item"><span class="meta-label">Dimensions:</span><span class="meta-value">' + m.imgWidth + 'x' + m.imgHeight + '</span></div>';
    if (m.tags && m.tags.length) metaHTML += '<div class="meta-item"><span class="meta-label">Tags:</span><span class="meta-value">' + m.tags.join(', ') + '</span></div>';
    metaHTML += '<div class="meta-item"><span class="meta-label">Modified:</span><span class="meta-value">' + new Date(m.modified).toLocaleString() + '</span></div>';
    meta.innerHTML = metaHTML;
  } catch (e) {
    meta.innerHTML = '<span style="color:#ff4444">Failed to load metadata</span>';
  }

  // Render preview
  const ext = filename.split('.').pop().toLowerCase();
  if (ext === 'pdf') {
    content.innerHTML = '<iframe src="/api/downloads/preview/' + encodeURIComponent(filename) + '"></iframe>';
  } else if (['png','jpg','jpeg','gif','webp','svg'].includes(ext)) {
    content.innerHTML = '<img src="/api/downloads/preview/' + encodeURIComponent(filename) + '" alt="' + filename + '">';
  } else if (['txt','md','json','csv'].includes(ext)) {
    try {
      const r = await fetch('/api/downloads/preview/' + encodeURIComponent(filename));
      const text = await r.text();
      content.innerHTML = '<pre style="color:#ccc;font-size:12px;white-space:pre-wrap;max-height:80vh;overflow:auto">' + text.substring(0, 10000).replace(/</g,'&lt;') + '</pre>';
    } catch { content.innerHTML = '<div style="color:#555">Cannot preview this file</div>'; }
  } else {
    content.innerHTML = '<div style="color:#555;text-align:center;padding:40px">No preview available for .' + ext + ' files</div>';
  }
}

function closePreview() { document.getElementById('previewPanel').classList.remove('active'); }

function formatBytes(bytes) {
  if (bytes > 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
  if (bytes > 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes > 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

// ─── Tags ───
async function promptTag(filename) {
  const tag = prompt('Add tag to ' + filename + ':');
  if (!tag || !tag.trim()) return;
  const existing = ${JSON.stringify(data.tags)};
  const tags = [...(existing[filename] || []), tag.trim()];
  const r = await api('/api/downloads/tags', { filename, tags });
  if (r.ok) { toast('Tagged: ' + tag.trim()); setTimeout(() => location.reload(), 500); }
  else toast(r.error, true);
}

async function removeTag(filename, tag) {
  const existing = ${JSON.stringify(data.tags)};
  const tags = (existing[filename] || []).filter(t => t !== tag);
  const r = await api('/api/downloads/tags', { filename, tags });
  if (r.ok) { toast('Removed tag: ' + tag); setTimeout(() => location.reload(), 500); }
  else toast(r.error, true);
}

// ─── Folder Picker ───
let folderPickerFile = '';
let folderPickerPath = '${process.env.HOME}';

function showFolderPicker(filename) {
  folderPickerFile = filename;
  document.getElementById('folderFilename').textContent = filename;
  document.getElementById('folderModal').classList.add('active');
  browseTo(folderPickerPath);
}

function closeFolderModal() { document.getElementById('folderModal').classList.remove('active'); }

async function browseTo(dir) {
  folderPickerPath = dir;
  document.getElementById('folderPathInput').value = dir.replace('${process.env.HOME}', '~');
  const list = document.getElementById('folderList');
  list.innerHTML = '<div style="color:#555;padding:12px">Loading...</div>';
  try {
    const r = await fetch('/api/downloads/browse?path=' + encodeURIComponent(dir));
    const d = await r.json();
    if (d.error) { list.innerHTML = '<div style="color:#ff4444;padding:12px">' + d.error + '</div>'; return; }
    folderPickerPath = d.path;
    document.getElementById('folderPathInput').value = d.path.replace('${process.env.HOME}', '~');
    let html = '';
    for (const entry of d.entries) {
      html += '<div class="folder-item" ondblclick="browseTo(\\'' + d.path.replace(/'/g, "\\\\'") + '/' + entry.name.replace(/'/g, "\\\\'") + '\\')" onclick="selectFolder(this, \\'' + d.path.replace(/'/g, "\\\\'") + '/' + entry.name.replace(/'/g, "\\\\'") + '\\')">';
      html += '<span class="icon">&#x1f4c1;</span><span>' + entry.name + '</span></div>';
    }
    if (!d.entries.length) html = '<div style="color:#555;padding:12px;text-align:center">Empty directory</div>';
    list.innerHTML = html;
  } catch (e) {
    list.innerHTML = '<div style="color:#ff4444;padding:12px">Error: ' + e.message + '</div>';
  }
}

function selectFolder(el, path) {
  document.querySelectorAll('.folder-item').forEach(i => i.style.background = '');
  el.style.background = '#00ff8822';
  folderPickerPath = path;
  document.getElementById('folderPathInput').value = path.replace('${process.env.HOME}', '~');
}

function folderUp() {
  const parts = folderPickerPath.split('/');
  if (parts.length > 2) { parts.pop(); browseTo(parts.join('/')); }
}

async function confirmMove() {
  const dest = folderPickerPath;
  if (!dest) return;
  const r = await api('/api/downloads/moveto', { filename: folderPickerFile, destination: dest });
  if (r.ok) { toast('Moved: ' + folderPickerFile + ' -> ' + dest.replace('${process.env.HOME}', '~')); closeFolderModal(); setTimeout(() => location.reload(), 800); }
  else toast(r.error, true);
}

// ─── Source Filters ───
function filterSources(pipeline) {
  const cards = document.querySelectorAll('#sourcesGrid .source-card');
  cards.forEach(c => {
    if (pipeline === 'all') { c.style.display = ''; return; }
    c.style.display = c.dataset.pipeline === pipeline ? '' : 'none';
  });
}

function filterByType(type) {
  document.querySelectorAll('.type-filter').forEach(b => b.classList.remove('active'));
  document.querySelector('.type-filter[data-type="' + type + '"]').classList.add('active');
  const cards = document.querySelectorAll('#sourcesGrid .source-card');
  cards.forEach(c => {
    if (type === 'all') { c.style.display = ''; return; }
    c.style.display = c.dataset.type === type ? '' : 'none';
  });
}

// ─── Source Detail ───
const allSources = ${JSON.stringify(sources)};
let currentSourceId = null;

function showSourceDetail(id) {
  const s = allSources.find(x => x.id === id);
  if (!s) return;
  currentSourceId = id;
  document.getElementById('sourceModalTitle').textContent = s.name + ' (' + s.type + ')';
  const shortPath = (s.path || '').replace('${process.env.HOME}', '~');

  // Build rich detail view
  const pipelineColors = { complete: '#00ff88', active: '#00aaff', available: '#ffaa00', none: '#ff4444' };
  const pColor = pipelineColors[s.pipelineStatus] || '#555';
  let html = '<div style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px;margin-bottom:12px">';
  html += '<span style="color:#555">Path:</span><span style="color:#888;user-select:all">' + shortPath + '</span>';
  html += '<span style="color:#555">Files:</span><span style="color:#ccc">' + (s.fileCount || 0).toLocaleString() + '</span>';
  html += '<span style="color:#555">Size:</span><span style="color:#ccc">' + (s.sizeHuman || '?') + '</span>';
  if (s.formats && s.formats.length) html += '<span style="color:#555">Formats:</span><span style="color:#888">' + s.formats.join(', ') + '</span>';
  html += '<span style="color:#555">Pipeline:</span><span style="color:' + pColor + ';font-weight:bold">' + (s.pipelineStatus || 'none').toUpperCase() + (s.pipelineTarget ? ' → ' + s.pipelineTarget : '') + '</span>';
  if (s.lastUpdated) html += '<span style="color:#555">Updated:</span><span style="color:#888">' + new Date(s.lastUpdated).toLocaleString() + '</span>';
  html += '</div>';

  // Related sources (same type or shared tags)
  const related = allSources.filter(r => r.id !== s.id && (r.type === s.type || (s.tags || []).some(t => (r.tags || []).includes(t))));
  if (related.length > 0) {
    html += '<div style="margin-bottom:8px"><span style="color:#555;font-size:10px;text-transform:uppercase;letter-spacing:1px">Related Sources</span>';
    html += '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px">';
    related.slice(0, 6).forEach(r => {
      html += '<span style="font-size:10px;padding:2px 8px;background:#1a1a1a;border:1px solid #222;border-radius:4px;color:#888;cursor:pointer" onclick="closeSourceModal();showSourceDetail(\\'' + r.id + '\\')">' + r.name + '</span>';
    });
    html += '</div></div>';
  }

  if (s.notes) html += '<div style="color:#666;font-size:11px;background:#0a0a0a;padding:8px;border-radius:4px;margin-bottom:8px">' + s.notes + '</div>';
  document.getElementById('sourceModalBody').innerHTML = html;
  document.getElementById('sourceTagsInput').value = (s.tags || []).join(', ');
  document.getElementById('sourcePipelineInput').value = s.pipelineTarget || '';
  document.getElementById('sourceNotesInput').value = s.notes || '';
  document.getElementById('sourceModal').classList.add('active');
}

function closeSourceModal() { document.getElementById('sourceModal').classList.remove('active'); }

async function saveSourceAnnotation() {
  if (!currentSourceId) return;
  const tags = document.getElementById('sourceTagsInput').value.split(',').map(t => t.trim()).filter(Boolean);
  const pipelineTarget = document.getElementById('sourcePipelineInput').value || undefined;
  const notes = document.getElementById('sourceNotesInput').value || undefined;
  const r = await api('/api/files/sources/annotate', { id: currentSourceId, tags, pipelineTarget, notes });
  if (r.ok) { toast('Source updated'); closeSourceModal(); setTimeout(() => location.reload(), 800); }
  else toast(r.error || 'Failed', true);
}

document.getElementById('sourceModal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('sourceModal')) closeSourceModal();
});

// ─── Quarantine Actions ───
async function restoreQuarantine(filepath) {
  const r = await api('/api/files/quarantine/restore', { filepath, destination: '${DOWNLOADS_DIR}' });
  if (r.ok) { toast('Restored from quarantine'); setTimeout(() => location.reload(), 800); }
  else toast(r.error, true);
}

async function deleteQuarantine(filepath, filename) {
  if (!confirm('Permanently delete ' + filename + ' from quarantine?')) return;
  const r = await api('/api/files/quarantine/delete', { filepath });
  if (r.ok) { toast('Deleted from quarantine'); setTimeout(() => location.reload(), 800); }
  else toast(r.error, true);
}

// ─── Create Rule from Suggestion ───
function createFromSuggestion(pattern, contains, destination) {
  document.getElementById('ruleIndex').value = '-1';
  document.getElementById('modalTitle').textContent = 'Create Rule from Suggestion';
  document.getElementById('ruleName').value = '';
  document.getElementById('rulePatterns').value = pattern;
  document.getElementById('ruleContains').value = (contains || []).join(', ');
  document.getElementById('ruleExclude').value = '';
  document.getElementById('ruleDest').value = destination;
  document.getElementById('ruleAction').value = 'move';
  document.getElementById('ruleModal').classList.add('active');
  document.getElementById('ruleName').focus();
}

// Close preview on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closePreview(); closeFolderModal(); closeModal(); closeSourceModal(); }
});

// Auto-refresh activity feed every 30s
setInterval(async () => {
  try {
    const r = await fetch('/api/files/activity');
    const data = await r.json();
    if (data.activity && data.activity.length > 0) {
      const feed = document.querySelector('.activity-feed');
      if (!feed) return;
      const statusColors = { done: '#00ff88', running: '#00aaff', error: '#ff4444' };
      feed.innerHTML = data.activity.slice(0, 20).map(a => {
        const sc = statusColors[a.status] || '#555';
        const time = new Date(a.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const shortTarget = (a.target || '').replace('${process.env.HOME}', '~');
        return '<div class="feed-item"><span class="feed-dot" style="background:' + sc + '"></span><span class="feed-time">' + time + '</span><span class="feed-agent">' + (a.agent || '?') + '</span><span class="feed-action">' + (a.action || '?') + '</span><span class="feed-target" title="' + (a.target || '') + '">' + (shortTarget.length > 40 ? shortTarget.slice(0, 37) + '...' : shortTarget) + '</span><span class="feed-detail">' + ((a.detail || '').length > 50 ? a.detail.slice(0, 47) + '...' : a.detail || '') + '</span></div>';
      }).join('');
    }
  } catch(e) { /* silent fail */ }
}, 30000);
</script>
</body></html>`;
}


