/**
 * GmDashboardPage — the server-rendered GM operations dashboard (PLAN-gm-tools
 * §2), served by the lobby at GET /admin.
 *
 * Self-contained HTML/CSS/JS, no build step, no external assets — this is an
 * ops page, NOT a game client (§2). It has its own admin login (so it is
 * independent of the SPA's origin/localStorage), then:
 *   - Fleet view: every game server + its live sim-health metrics + alarm
 *     badges, from the lobby's POST /api/admin/fleet (shared-SQLite data).
 *   - Per-game drill-down: metric timeline + audit tail (lobby), plus live
 *     inspect + rollback-target snapshots + the verb buttons, which POST
 *     directly to that game server's own /api/gm/<verb> plane (browser→game
 *     port, same admin token — the proven admin path).
 *   - Ban list: account ban/unban via the lobby.
 *   - Client crashes: `client_errors` grouped by stack hash (top crashers,
 *     first/last seen, build range, affected games) with a per-group
 *     drill-down and export-to-JSON — PLAN-client-resilience.md task 4.
 *
 * The raw-string delimiter is )HTML" so the page body's own )" sequences don't
 * terminate the literal early.
 */
#pragma once

inline constexpr const char* kGmDashboardHtml = R"HTML(<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spring RTS — GM Operations</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
         background: #0d1017; color: #cdd6e4; }
  header { display: flex; align-items: center; gap: 12px; padding: 10px 16px;
           background: #151a23; border-bottom: 1px solid #232a36; position: sticky; top: 0; z-index: 5; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; color: #e6ecf5; }
  header .who { margin-left: auto; color: #7d8797; }
  button { font: inherit; background: #1e2530; color: #cdd6e4; border: 1px solid #313a48;
           border-radius: 5px; padding: 4px 10px; cursor: pointer; }
  button:hover { background: #283040; }
  button.danger { border-color: #5a2530; color: #ff9ba6; }
  button.danger:hover { background: #3a1a20; }
  button.primary { background: #2b5c8a; border-color: #367; color: #eaf3ff; }
  input, select { font: inherit; background: #0f131b; color: #cdd6e4; border: 1px solid #313a48;
                  border-radius: 5px; padding: 5px 8px; }
  main { padding: 16px; max-width: 1400px; margin: 0 auto; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #1c2330; white-space: nowrap; }
  th { color: #7d8797; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  tr.game { cursor: pointer; }
  tr.game:hover td { background: #141a24; }
  .st { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; }
  .st.running { background: #16351f; color: #74e08c; }
  .st.starting { background: #33300f; color: #e0d074; }
  .st.crashed { background: #3a171d; color: #ff9ba6; }
  .st.ended, .st.hibernated { background: #23262e; color: #98a2b3; }
  .badge { display: inline-block; margin-left: 5px; padding: 0 6px; border-radius: 8px;
           font-size: 10px; background: #3a2a10; color: #ffcf70; }
  .badge.crit { background: #3a171d; color: #ff9ba6; }
  .muted { color: #6b7482; }
  .card { background: #12161f; border: 1px solid #212938; border-radius: 8px; padding: 14px; margin-top: 14px; }
  .card h2 { font-size: 13px; margin: 0 0 10px; color: #e6ecf5; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .row + .row { margin-top: 8px; }
  .verbs button { min-width: 74px; }
  .spark { display: flex; align-items: flex-end; gap: 1px; height: 40px; }
  .spark i { width: 3px; background: #2b5c8a; display: inline-block; }
  .log { font-size: 12px; max-height: 220px; overflow: auto; border-top: 1px solid #1c2330; }
  .log div { padding: 3px 0; border-bottom: 1px solid #161c27; }
  .log .act { color: #86b4e0; }
  tr.crash { cursor: pointer; }
  tr.crash:hover td { background: #141a24; }
  td.msg { white-space: normal; max-width: 460px; word-break: break-word; }
  .hash { color: #7d8797; font-size: 11px; }
  pre.stack { margin: 6px 0 0; padding: 8px; background: #0f131b; border: 1px solid #212938;
              border-radius: 6px; max-height: 240px; overflow: auto; font-size: 11px;
              white-space: pre-wrap; word-break: break-all; }
  #login { max-width: 320px; margin: 80px auto; }
  #err { color: #ff9ba6; min-height: 18px; }
  #toast { position: fixed; bottom: 18px; right: 18px; display: flex; flex-direction: column; gap: 6px; z-index: 20; }
  #toast div { background: #1e2530; border: 1px solid #367; border-radius: 6px; padding: 8px 12px; max-width: 360px; }
  #toast div.bad { border-color: #5a2530; color: #ff9ba6; }
  a.link { color: #86b4e0; cursor: pointer; }
</style>
</head>
<body>
<div id="app"></div>
<div id="toast"></div>
<script>
const $ = (s, r=document) => r.querySelector(s);
const app = $('#app');
let TOKEN = localStorage.getItem('gm-token') || '';
let ME = null;
let openRoom = null;

function toast(msg, bad) {
  const t = $('#toast'); const d = document.createElement('div');
  d.textContent = msg; if (bad) d.className = 'bad'; t.appendChild(d);
  setTimeout(() => d.remove(), 5000);
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function fmtBytes(n) { if (!n) return '—'; const u=['B','KB','MB','GB']; let i=0; while(n>=1024&&i<3){n/=1024;i++;} return n.toFixed(i?1:0)+u[i]; }
function fmtDur(s) { if(!s&&s!==0) return '—'; const h=Math.floor(s/3600),m=Math.floor(s%3600/60); return h?`${h}h${m}m`:`${m}m`; }

async function api(path, body) {
  const r = await fetch(path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
    body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, j };
}
// Per-game verb → the game server's own /api/gm plane (browser→game port).
async function gm(port, verb, body) {
  const url = `${location.protocol}//${location.hostname}:${port}/api/gm/${verb}`;
  try {
    const r = await fetch(url, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
      body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, j };
  } catch (e) { return { ok: false, status: 0, j: { error: 'game server unreachable on :' + port } }; }
}

function renderLogin(msg) {
  ME = null;
  app.innerHTML = `<div id="login" class="card"><h2>GM Operations — sign in</h2>
    <div class="row"><input id="u" placeholder="admin username" style="flex:1"></div>
    <div class="row"><input id="p" type="password" placeholder="password" style="flex:1"></div>
    <div class="row"><button class="primary" id="go" style="flex:1">Sign in</button></div>
    <div id="err">${msg ? esc(msg) : ''}</div></div>`;
  $('#go').onclick = doLogin;
  $('#p').onkeydown = e => { if (e.key === 'Enter') doLogin(); };
}
async function doLogin() {
  const username = $('#u').value.trim(), password = $('#p').value;
  const r = await fetch('/api/auth/login', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return $('#err').textContent = j.error || 'login failed';
  if (j.role !== 'admin') return $('#err').textContent = 'not an admin account';
  TOKEN = j.token; ME = j.username; localStorage.setItem('gm-token', TOKEN);
  renderShell(); refresh();
}

function renderShell() {
  app.innerHTML = `<header><h1>⚔ GM Operations</h1>
      <span class="who">${esc(ME||'')} · admin</span>
      <button id="logout">Sign out</button></header>
    <main>
      <div class="card"><h2>Fleet <span class="muted" id="ftime"></span></h2>
        <div id="fleet">loading…</div></div>
      <div id="drill"></div>
      <div class="card"><h2>Client crashes <span class="muted" id="crashmeta"></span></h2>
        <div class="row">
          <select id="crashsince">
            <option value="1">last 24h</option>
            <option value="7" selected>last 7 days</option>
            <option value="30">last 30 days</option>
            <option value="0">all retained</option>
          </select>
          <button id="crashrefresh">Refresh</button></div>
        <div id="crashes" style="margin-top:10px">loading…</div>
        <div id="crashdrill"></div></div>
      <div class="card"><h2>Ban list</h2>
        <div class="row"><input id="banu" placeholder="username">
          <button class="danger" id="banbtn">Ban</button>
          <button id="unbanbtn">Unban</button></div>
        <div id="banned" class="log" style="margin-top:10px"></div></div>
    </main>`;
  $('#logout').onclick = () => { localStorage.removeItem('gm-token'); TOKEN=''; renderLogin(); };
  $('#banbtn').onclick = () => doBan(true);
  $('#unbanbtn').onclick = () => doBan(false);
  $('#crashrefresh').onclick = loadCrashes;
  $('#crashsince').onchange = loadCrashes;
  loadBanned();
  loadCrashes();
}

function alarmBadges(g) {
  let h = '';
  for (const a of (g.alarms || [])) h += `<span class="badge ${a.crit?'crit':''}">${esc(a.label)}</span>`;
  return h;
}

async function refresh() {
  if (!TOKEN) return;
  const { ok, status, j } = await api('/api/admin/fleet');
  if (status === 401 || status === 403) return renderLogin('session expired — sign in again');
  if (!ok) return;
  $('#ftime').textContent = '· ' + new Date().toLocaleTimeString();
  const games = j.games || [];
  if (!games.length) { $('#fleet').innerHTML = '<div class="muted">no game servers running</div>'; return; }
  let h = `<table><thead><tr><th>room</th><th>game</th><th>map</th><th>state</th>
    <th>players</th><th>frame</th><th>p95 tick</th><th>behind</th><th>entities</th>
    <th>fps</th><th>uptime</th><th>db</th></tr></thead><tbody>`;
  for (const g of games) {
    const p95 = g.tick_p95_us != null ? (g.tick_p95_us/1000).toFixed(1)+'ms' : '—';
    h += `<tr class="game" data-room="${g.room_id}"><td>#${g.room_id}${alarmBadges(g)}</td>
      <td>${esc(g.game_id||'—')}</td><td>${esc(g.map_id||'—')}</td>
      <td><span class="st ${esc(g.state||'')}">${esc(g.state||'?')}</span></td>
      <td>${g.client_count ?? '—'}</td><td>${g.frame ?? '—'}</td><td>${p95}</td>
      <td>${g.frames_behind ?? '—'}</td><td>${g.entity_count ?? '—'}</td>
      <td>${g.sim_fps != null ? g.sim_fps.toFixed(1) : '—'}</td>
      <td>${fmtDur(g.uptime_sec)}</td><td>${fmtBytes(g.db_size_bytes)}</td></tr>`;
  }
  h += '</tbody></table>';
  $('#fleet').innerHTML = h;
  $('#fleet').querySelectorAll('tr.game').forEach(tr =>
    tr.onclick = () => openDrill(+tr.dataset.room, games.find(x => x.room_id == tr.dataset.room)));
}

async function openDrill(roomId, g) {
  openRoom = roomId;
  const port = g.port;
  const { j } = await api('/api/admin/game', { roomId });
  const timeline = j.timeline || [];
  const audit = j.audit || [];
  const spark = timeline.slice().reverse().map(m => {
    const v = Math.min(40, (m.tick_p95_us||0)/1000*2);
    return `<i style="height:${Math.max(2,v)}px" title="f${m.frame} ${(m.tick_p95_us/1000).toFixed(1)}ms"></i>`;
  }).join('');
  const d = $('#drill');
  d.innerHTML = `<div class="card"><h2>Room #${roomId} — ${esc(g.game_id||'')} <span class="muted">port ${port}</span>
      <a class="link" style="float:right" id="closed">close ✕</a></h2>
    <div class="row verbs">
      <button data-v="pause">Pause</button><button data-v="resume">Resume</button>
      <button data-v="broadcast">Broadcast</button><button data-v="grant">Grant</button>
      <button data-v="kick">Kick</button><button data-v="checkpoint">Checkpoint</button>
      <button class="danger" data-v="rollback">Rollback…</button>
      <button id="inspectbtn">Inspect</button></div>
    <div class="row" style="margin-top:12px"><div><div class="muted">tick p95 timeline</div>
      <div class="spark">${spark || '<span class="muted">no metrics yet</span>'}</div></div></div>
    <div id="inspect" class="row" style="margin-top:10px"></div>
    <h2 style="margin-top:14px;font-size:12px" class="muted">Audit trail (this game)</h2>
    <div class="log" id="audit">${audit.map(a =>
      `<div><span class="muted">${esc(a.createdAt||'')}</span> <span class="act">${esc(a.action)}</span>
       <b>${esc(a.username)}</b> ${esc(a.target)} <span class="muted">${esc(a.argsDigest)}</span></div>`
    ).join('') || '<div class="muted">no admin actions logged</div>'}</div></div>`;
  $('#closed').onclick = () => { openRoom = null; d.innerHTML = ''; };
  $('#inspectbtn').onclick = () => doInspect(port);
  d.querySelectorAll('.verbs button[data-v]').forEach(b =>
    b.onclick = () => doVerb(port, b.dataset.v, g));
  doInspect(port);
}

async function doInspect(port) {
  const { ok, j } = await gm(port, 'inspect');
  if (!ok) { $('#inspect').innerHTML = `<span class="muted">${esc(j.error||'inspect failed')}</span>`; return; }
  const players = (j.players||[]).map(p => `${esc(p.username)}(t${p.team})`).join(', ') || '—';
  $('#inspect').innerHTML = `<div class="card" style="margin:0;flex:1">
    frame <b>${j.frame}</b> · ${j.paused?'<span style="color:#ffcf70">PAUSED</span>':'running'} ·
    speed ${j.speed} · entities ${j.entities} · teams ${j.teams} · fps ${(j.simFps||0).toFixed(1)}<br>
    <span class="muted">players:</span> ${players}</div>`;
}

async function doVerb(port, verb, g) {
  if (verb === 'pause' || verb === 'resume' || verb === 'checkpoint') {
    const { ok, j } = await gm(port, verb);
    toast(ok ? `${verb}: ok` : `${verb}: ${j.error||j.status||'failed'}`, !ok);
    if (openRoom) setTimeout(() => doInspect(port), 300);
  } else if (verb === 'broadcast') {
    const message = prompt('Broadcast to all players in room #' + g.room_id + ':');
    if (!message) return;
    const { ok, j } = await gm(port, 'broadcast', { message });
    toast(ok ? `broadcast → ${j.delivered} clients` : `broadcast failed: ${j.error||''}`, !ok);
  } else if (verb === 'kick') {
    const player = prompt('Kick which player (username)?'); if (!player) return;
    const { ok, j } = await gm(port, 'kick', { player });
    toast(ok ? `kicked ${player}` : `kick failed: ${j.error||''}`, !ok);
  } else if (verb === 'grant') {
    const target = prompt('Grant to (team|player):', 'team'); if (!target) return;
    const id = prompt('Team/player id:', '0'); if (id === null) return;
    const amount = prompt('Authority amount:', '500'); if (amount === null) return;
    const reason = prompt('Reason (shown to players — E3 transparency):', ''); if (reason === null) return;
    const { ok, j } = await gm(port, 'grant', { target, id: +id, amount: +amount, reason });
    toast(ok ? `granted ${amount} → ${target} ${id}` : `grant: ${j.error||''}`, !ok);
  } else if (verb === 'rollback') {
    doRollback(port, g);
  }
}

async function doRollback(port, g) {
  const { ok, j } = await gm(port, 'snapshots');
  if (!j.available) {
    toast('Rollback unavailable: persistence layer (snapshots) not built yet — PLAN-persistence.', true);
    return;
  }
  const snaps = j.snapshots || [];
  if (!snaps.length) { toast('No snapshots to roll back to.', true); return; }
  const list = snaps.map(s => `frame ${s.frame} (${s.label})`).join('\n');
  const frame = prompt('Roll back room #' + g.room_id + ' to which frame?\n\n' + list, snaps[0].frame);
  if (frame === null) return;
  const reason = prompt('Reason (mandatory — audited + shown to players):', '');
  if (!reason) { toast('Rollback needs a reason.', true); return; }
  if (!confirm(`Roll back room #${g.room_id} to frame ${frame}? All players full-reboot.`)) return;
  const { ok: rok, j: r } = await gm(port, 'rollback', { frame: +frame, reason });
  toast(rok ? `rolled back to frame ${frame} (undo: ${r.preCheckpointFrame})` : `rollback: ${r.error||''}`, !rok);
}

async function loadBanned() {
  const { j } = await api('/api/admin/banned');
  const b = j.banned || [];
  $('#banned').innerHTML = b.length ? b.map(u =>
    `<div><b>${esc(u.username)}</b> <span class="muted">#${u.id} · ${esc(u.role)}</span>
     <a class="link" style="float:right" data-u="${esc(u.username)}">unban</a></div>`).join('')
    : '<div class="muted">no banned accounts</div>';
  $('#banned').querySelectorAll('a[data-u]').forEach(a =>
    a.onclick = () => doBan(false, a.dataset.u));
}
async function doBan(ban, uname) {
  const username = uname || $('#banu').value.trim();
  if (!username) return;
  if (ban && !confirm('Ban account "' + username + '"? Their sessions are revoked immediately.')) return;
  const { ok, j } = await api(ban ? '/api/admin/ban' : '/api/admin/unban', { username });
  toast(ok ? `${ban?'banned':'unbanned'} ${username}` : `${j.error||'failed'}`, !ok);
  if (ok) { $('#banu').value=''; loadBanned(); }
}

// --- Client crashes (PLAN-client-resilience task 4) ---
// Rows are grouped by stack HASH, not by message: stacks arrive minified
// (no source-map upload pipeline exists — task 3's documented residual), so
// the frames are unreadable but the hash is a stable per-crash-site identity.
let openHash = null;

async function loadCrashes() {
  const sinceDays = +$('#crashsince').value;
  const { ok, j } = await api('/api/admin/client-errors', { sinceDays, limit: 100 });
  if (!ok) { $('#crashes').innerHTML = `<div class="muted">${esc(j.error||'failed to load crash reports')}</div>`; return; }
  const groups = j.groups || [];
  $('#crashmeta').textContent = `· retention ${j.retention_days > 0 ? j.retention_days + 'd' : 'off'}`;
  if (!groups.length) {
    $('#crashes').innerHTML = '<div class="muted">no client crash reports in this window</div>';
    $('#crashdrill').innerHTML = ''; openHash = null; return;
  }
  let h = `<table><thead><tr><th>error</th><th>occurrences</th><th>reports</th><th>users</th>
    <th>first seen</th><th>last seen</th><th>builds</th><th>rung</th><th>games</th></tr></thead><tbody>`;
  for (const g of groups) {
    const builds = g.first_build && g.first_build !== g.last_build
      ? `${esc(g.first_build)} → ${esc(g.last_build)}` : esc(g.last_build || '—');
    h += `<tr class="crash" data-h="${esc(g.stack_hash)}">
      <td class="msg"><b>${esc(g.error_class||'Error')}</b>: ${esc(g.message||'—')}
        <div class="hash">${esc(g.stack_hash)}</div></td>
      <td>${g.occurrences}</td><td>${g.reports}</td><td>${g.users}</td>
      <td>${esc(g.first_seen||'—')}</td><td>${esc(g.last_seen||'—')}</td>
      <td>${builds}</td><td>${esc(g.recovery_rung||'—')}</td>
      <td>${esc(g.games||'—')}</td></tr>`;
  }
  h += '</tbody></table>';
  $('#crashes').innerHTML = h;
  $('#crashes').querySelectorAll('tr.crash').forEach(tr =>
    tr.onclick = () => openCrash(tr.dataset.h));
  if (openHash) openCrash(openHash);
}

async function openCrash(stackHash) {
  const { ok, j } = await api('/api/admin/client-errors/detail', { stack_hash: stackHash });
  const d = $('#crashdrill');
  if (!ok) { d.innerHTML = `<div class="muted">${esc(j.error||'detail failed')}</div>`; return; }
  openHash = stackHash;
  const reports = j.reports || [];
  const top = reports[0] || {};
  d.innerHTML = `<div class="card"><h2>${esc(top.error_class||'Error')} <span class="hash">${esc(stackHash)}</span>
      <a class="link" style="float:right" id="crashclose">close ✕</a>
      <button id="crashexport" style="float:right;margin-right:10px">Export JSON</button></h2>
    <div class="muted">${reports.length} stored report(s) · newest ${esc(top.created_at||'—')} ·
      frame ${top.frame ?? '—'} · phase ${esc(top.phase||'—')} · entities ${top.entity_count ?? '—'} ·
      rung ${esc(top.recovery_rung||'—')} · ${esc(top.gpu_renderer||'unknown gpu')}</div>
    <pre class="stack">${esc(top.stack||'(no stack)')}</pre>
    <h2 style="margin-top:14px;font-size:12px" class="muted">Last log-ring lines</h2>
    <pre class="stack">${esc(top.log_ring||'(none)')}</pre>
    <h2 style="margin-top:14px;font-size:12px" class="muted">Occurrences</h2>
    <div class="log">${reports.map(r =>
      `<div><span class="muted">${esc(r.created_at||'')}</span> user #${r.user_id}
        · ${esc(r.game_id||'—')}/${esc(r.map_id||'—')} · f${r.frame}
        · build ${esc(r.build_stamp||'—')} · ×${r.count}</div>`).join('')}</div></div>`;
  $('#crashclose').onclick = () => { openHash = null; d.innerHTML = ''; };
  $('#crashexport').onclick = () => exportCrash(stackHash, j);
}

// Export-to-JSON: the detail response verbatim, so a filed issue carries the
// same bytes the operator was looking at.
function exportCrash(stackHash, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `client-errors-${stackHash.slice(0, 16) || 'group'}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function boot() {
  if (!TOKEN) return renderLogin();
  // Validate the stored token; fall back to login if it's expired/not-admin.
  try {
    const v = await fetch('/api/auth/validate', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN }, body: '{}' });
    const j = await v.json().catch(() => ({}));
    if (j.valid && j.role === 'admin') { ME = j.username; renderShell(); refresh(); }
    else renderLogin();
  } catch (e) { renderLogin(); }
}
boot();

setInterval(() => { if (ME) refresh(); }, 5000);
</script>
</body>
</html>
)HTML";
