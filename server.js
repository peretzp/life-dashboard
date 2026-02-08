const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = 3000;
const VAULT = path.join(process.env.HOME, 'Library/Mobile Documents/iCloud~md~obsidian/Documents/PracticeLife');

function run(cmd, timeout = 5000) {
  try { return execSync(cmd, { timeout, encoding: 'utf8' }).trim(); }
  catch { return '—'; }
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

  // MemoryAtlas stats (reads from atlas CLI)
  const atlasStats = run('~/tools/memoryatlas/.venv/bin/atlas status 2>/dev/null');
  const atlasTotal = (atlasStats.match(/Total assets:\s+(\d+)/) || [])[1] || '0';
  const atlasHours = (atlasStats.match(/Total hours:\s+([\d.]+)/) || [])[1] || '0';
  const atlasTranscribed = (atlasStats.match(/Transcribed:\s+(\d+)/) || [])[1] || '0';
  const atlasPublished = (atlasStats.match(/Published:\s+(\d+)/) || [])[1] || '0';

  // Agent collaboration status
  const SESSION_LOGS = path.join(process.env.HOME, '.claude/session-logs');
  let sessionLogs = [];
  try {
    sessionLogs = fs.readdirSync(SESSION_LOGS)
      .filter(f => f.endsWith('.md'))
      .map(f => ({ name: f.replace('.md', ''), modified: fs.statSync(path.join(SESSION_LOGS, f)).mtime }))
      .sort((a, b) => b.modified - a.modified)
      .slice(0, 5);
  } catch {}

  const protocolExists = fs.existsSync(path.join(process.env.HOME, 'agent-protocol.md'));
  const apiLive = run('curl -s -o /dev/null -w "%{http_code}" --max-time 1 http://127.0.0.1:3001/health 2>/dev/null') === '200';

  return {
    timestamp: new Date().toISOString(),
    system: { diskUsage, uptime: uptime.replace(/.*up/, 'up'), volumes: volumes.split('\n') },
    downloads: { total: downloads, organized_folders: downloadsOrg, loose_files: downloadsLoose },
    memoryatlas: { total: atlasTotal, hours: atlasHours, transcribed: atlasTranscribed, published: atlasPublished },
    vault: { total_notes: obsidianFiles, home_updated: homeUpdated },
    agents: { sessionLogs, protocolActive: protocolExists, apiLive },
  };
}

const TASKS = [
  // === TOP PRIORITY ===
  { id: 0, name: 'SDI Disability Appeal', status: 'critical', icon: '🔴', detail: 'Appeal doc submission, late 2500A explanation, monitor portal' },
  // === BLOCKED ===
  { id: 4, name: 'LinkedIn MCP Server', status: 'blocked', icon: '🔒', blocker: 'Need manual LinkedIn login in browser' },
  { id: 10, name: 'Time Machine Backup', status: 'blocked', icon: '🔒', blocker: 'Elements drive — new cable arrived 02/08, plug in to retry' },
  { id: 11, name: 'User Account Merge', status: 'blocked', icon: '🔒', blocker: 'Needs Time Machine backup first' },
  // === RUNNING ===
  { id: 32, name: 'MemoryAtlas', status: 'running', icon: '🔄', detail: 'Phase 1 LIVE (929 notes). Phase 2: Whisper turbo transcription next' },
  { id: 25, name: 'Vault Restructure', status: 'running', icon: '🔄', detail: 'ACE+PARA — executing now' },
  { id: 16, name: 'Life Dashboard', status: 'running', icon: '🔄', detail: 'You are looking at it' },
  { id: 26, name: 'Password Merge', status: 'running', icon: '🔄', detail: 'Chrome encrypted on SD4Loco → Apple Passwords' },
  { id: 22, name: 'Google Drive Organization', status: 'running', icon: '🔄', detail: '13GB IB backup found' },
  { id: 17, name: 'Living Resume', status: 'running', icon: '🔄', detail: '60 versions inventoried, consolidation pending' },
  // === PENDING ===
  { id: 33, name: 'Google Takeout (Location History)', status: 'pending', icon: '⏳', detail: 'For MemoryAtlas Phase 4 location enrichment' },
  { id: 13, name: 'Contact Dedup (~8,500)', status: 'running', icon: '🔄', detail: 'Phase 1: inventorying all sources + building dedup pipeline' },
  { id: 14, name: 'Apple Notes → Obsidian', status: 'pending', icon: '⏳', detail: '959 notes ready' },
  { id: 15, name: 'Roam → Obsidian', status: 'pending', icon: '⏳', detail: '602MB, needs web export' },
  { id: 18, name: 'Calendar Backfill', status: 'pending', icon: '⏳' },
  { id: 19, name: 'VPN Setup (Mullvad+Tailscale)', status: 'pending', icon: '⏳' },
  { id: 20, name: 'Mastra.ai Bootstrap', status: 'pending', icon: '⏳' },
  { id: 23, name: 'UniFi Network Hardening', status: 'pending', icon: '⏳' },
  { id: 24, name: 'Cross-Device Phase Lock', status: 'pending', icon: '⏳' },
  { id: 28, name: 'Notion → Obsidian Migration', status: 'pending', icon: '⏳' },
  { id: 29, name: 'Evernote → Obsidian Migration', status: 'pending', icon: '⏳' },
  { id: 30, name: 'OpenAI/ChatGPT API Integration', status: 'pending', icon: '⏳' },
  { id: 34, name: 'Codex ↔ Claude Collaboration', status: 'running', icon: '🔄', detail: 'Multi-agent protocol live, PracticeLife API on :3001' },
  { id: 35, name: 'PracticeLife API', status: 'running', icon: '🔄', detail: 'Atlas + Vault + System + Agents endpoints at :3001' },
  // === DONE ===
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
<meta http-equiv="refresh" content="30">
<title>Ω₀ PracticeLife Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0a0a0a; color: #e0e0e0; font-family: 'SF Mono', 'Fira Code', monospace; padding: 20px; }
  h1 { color: #00ff88; font-size: 28px; margin-bottom: 4px; }
  .subtitle { color: #666; margin-bottom: 20px; font-size: 13px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card { background: #151515; border: 1px solid #222; border-radius: 8px; padding: 16px; }
  .card h3 { color: #888; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
  .card .value { font-size: 32px; font-weight: bold; color: #00ff88; }
  .card .value.warn { color: #ffaa00; }
  .card .value.crit { color: #ff4444; }
  .card .sub { color: #555; font-size: 12px; margin-top: 4px; }
  .progress-bar { width: 100%; height: 24px; background: #1a1a1a; border-radius: 12px; overflow: hidden; margin: 16px 0; border: 1px solid #333; }
  .progress-fill { height: 100%; background: linear-gradient(90deg, #00ff88, #00cc66); transition: width 0.5s; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: bold; color: #000; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; }
  th { text-align: left; color: #555; font-size: 11px; text-transform: uppercase; padding: 8px; border-bottom: 1px solid #222; }
  td { padding: 8px; border-bottom: 1px solid #151515; font-size: 13px; }
  tr.done td { opacity: 0.5; }
  tr.blocked td { }
  tr.critical td { }
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
  .alignment .omega { font-size: 48px; color: #00ff88; }
  .alignment .phrase { color: #00cc66; font-size: 14px; margin-top: 8px; }
  .timestamp { color: #333; font-size: 11px; text-align: right; margin-top: 16px; }
  .agent-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin-top: 12px; }
  .agent-card { background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 14px; }
  .agent-card h4 { color: #c9d1d9; font-size: 13px; margin-bottom: 8px; }
  .agent-card .agent-status { display: flex; align-items: center; gap: 6px; font-size: 12px; }
  .agent-card .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .dot.live { background: #00ff88; box-shadow: 0 0 6px #00ff88; }
  .dot.off { background: #555; }
  .session-list { list-style: none; margin-top: 8px; }
  .session-list li { color: #8b949e; font-size: 11px; padding: 2px 0; border-bottom: 1px solid #161b22; }
  .session-list li:last-child { border: none; }
</style>
</head><body>

<h1>Ω₀ PracticeLife OS</h1>
<div class="subtitle">Alpha Omega — Iterate, Don't Annihilate</div>

<div class="alignment">
  <div class="omega">Ω₀</div>
  <div class="phrase">Phase-locked. Aligned. Building together.</div>
</div>

<div class="grid">
  <div class="card"><h3>Mission Progress</h3><div class="value">${pct}%</div><div class="sub">${done}/${TASKS.length} complete</div></div>
  <div class="card"><h3>Active Now</h3><div class="value" style="color:#00aaff">${running}</div><div class="sub">tasks running</div></div>
  <div class="card"><h3>Blocked (You)</h3><div class="value ${blocked > 0 ? 'warn' : ''}">${blocked}</div><div class="sub">need your action</div></div>
  <div class="card"><h3>Critical</h3><div class="value ${critical > 0 ? 'crit' : ''}">${critical}</div><div class="sub">security items</div></div>
  <div class="card"><h3>Disk Used</h3><div class="value">${state.system.diskUsage}</div><div class="sub">main drive</div></div>
  <div class="card"><h3>Vault Notes</h3><div class="value">${state.vault.total_notes}</div><div class="sub">Obsidian markdown</div></div>
  <div class="card"><h3>MemoryAtlas</h3><div class="value">${state.memoryatlas.total}</div><div class="sub">${state.memoryatlas.hours}h recorded / ${state.memoryatlas.transcribed} transcribed</div></div>
  <div class="card"><h3>Downloads</h3><div class="value">${state.downloads.loose_files}</div><div class="sub">loose files (${state.downloads.organized_folders} folders)</div></div>
</div>

<div class="progress-bar"><div class="progress-fill" style="width:${pct}%">${pct}% ALIGNED</div></div>

<div class="section">
  <h2>Connected Drives</h2>
  <div class="volumes">
    ${state.system.volumes.map(v => `<div class="vol">${v}</div>`).join('')}
    ${state.system.volumes.includes('Elements') ? '' : '<div class="vol missing">⚠ Elements — NOT DETECTED</div>'}
  </div>
</div>

<div class="section">
  <h2>Agent Collaboration</h2>
  <div class="agent-grid">
    <div class="agent-card">
      <h4>Services</h4>
      <div class="agent-status"><span class="dot live"></span> Dashboard <span style="color:#555">:3000</span></div>
      <div class="agent-status"><span class="dot ${state.agents.apiLive ? 'live' : 'off'}"></span> PracticeLife API <span style="color:#555">:3001</span></div>
      <div class="agent-status"><span class="dot ${state.agents.protocolActive ? 'live' : 'off'}"></span> Agent Protocol</div>
    </div>
    <div class="agent-card">
      <h4>Active Agents</h4>
      <div class="agent-status"><span class="dot live"></span> Claude Code <span style="color:#555">Opus 4.6</span></div>
      <div class="agent-status"><span class="dot live"></span> Codex <span style="color:#555">gpt-5.2-codex</span></div>
      <div class="agent-status"><span class="dot off"></span> Claude Desktop</div>
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
  <h2>All Tasks</h2>
  <table>
    <tr><th></th><th>Task</th><th>Status</th><th>Detail</th></tr>
    ${taskRows}
  </table>
</div>

<div class="timestamp">Last refresh: ${state.timestamp} · Auto-refreshes every 30s · Home: ${state.vault.home_updated}</div>

</body></html>`;
}

const server = http.createServer((req, res) => {
  if (req.url === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getState(), null, 2));
    return;
  }
  const state = getState();
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(renderHTML(state));
});

server.listen(PORT, () => {
  console.log(`\n  Ω₀ PracticeLife Dashboard`);
  console.log(`  ========================`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  API: http://localhost:${PORT}/api/state\n`);
});
