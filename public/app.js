import { routeMessage, TIERS } from '/router.mjs';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const icon = (name) => `<svg class="i"><use href="#i-${name}"/></svg>`;
const api = async (url, opts = {}) => {
  const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = r.status === 204 ? {} : await r.json();
  if (!r.ok) throw new Error(data.error ?? r.statusText);
  return data;
};
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* unavailable */ } } };

// ---------------- formatting ----------------
const tok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n ?? 0)));
const usd = (n) => '$' + (n ?? 0).toFixed(n >= 1 ? 2 : n >= 0.01 ? 3 : 4);
const short = (m) => String(m).replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/^./, (c) => c.toUpperCase());
const agoShort = (t) => {
  if (!t) return '';
  const s = (Date.now() - t) / 1000;
  return s < 60 ? 'now' : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : s < 604800 ? `${Math.floor(s / 86400)}d` : new Date(t).toLocaleDateString();
};
const ago = (t) => { const a = agoShort(t); return a === 'now' ? 'just now' : /\d[mhd]$/.test(a) ? a + ' ago' : a; };
const hitRate = (u) => { const all = (u.in ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0); return all ? Math.round(((u.cacheRead ?? 0) / all) * 100) : 0; };
const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const initials = (name) => { const w = String(name).split(/[^a-zA-Z0-9]+/).filter(Boolean); return (w.length > 1 ? w[0][0] + w[1][0] : String(name).slice(0, 2)).toUpperCase(); };
const chip = (p) => { const h = hash(p?.id) % 360; return `<span class="chip" style="background:hsl(${h} 40% 16%);color:hsl(${h} 70% 62%)">${esc(initials(p?.name ?? '?'))}</span>`; };

// ---------------- state ----------------
let S = { projects: [], threads: [] };
const gameBase = () => `${location.protocol}//${location.hostname}:${S.gamePort}`; // games run on their own origin
let current = null;
const thread = () => S.threads.find((t) => t.id === current);
const projectOf = (t) => S.projects.find((p) => p.id === t?.projectId);
const unread = new Set(JSON.parse(store.get('forge.unread') ?? '[]'));
const saveUnread = () => store.set('forge.unread', JSON.stringify([...unread]));
let grouped = store.get('forge.grouped') === '1';
const desktop = window.forgeDesktop;
if (desktop) document.body.classList.add('desktop');

// ---------------- layout toggles ----------------
function setSide(show) { document.body.classList.toggle('noSide', !show); $('#showSide').hidden = show; store.set('forge.side', show ? '1' : '0'); }
function setPanel(show) { document.body.classList.toggle('noPanel', !show); $('#togglePanel').classList.toggle('on', show); store.set('forge.panel', show ? '1' : '0'); }
$('#toggleSide').addEventListener('click', () => setSide(false));
$('#showSide').addEventListener('click', () => setSide(true));
$('#togglePanel').addEventListener('click', () => setPanel(document.body.classList.contains('noPanel')));
setSide(store.get('forge.side') !== '0');
setPanel(store.get('forge.panel') !== '0');

// ---------------- sidebar ----------------
function statusOf(t) {
  if (t.awaiting > 0) return `<span class="status st-approval">${icon('shield')}Approval</span>`;
  if (t.running) return '<span class="status st-working"><span class="spin"></span>Working</span>';
  if (unread.has(t.id)) return `<span class="status st-done">${icon('check')}Done</span>`;
  return `<span class="status">${agoShort(t.updated ?? t.created)}</span>`;
}
function threadRow(t) {
  const p = projectOf(t);
  const l3 = t.worktree ? `${icon('branch')}forge/${esc(t.id)}` : `${icon('route')}${t.model && t.model !== 'auto' ? esc(modelName(t.model)) : t.lastTier ? 'Auto · ' + esc(TIERS[t.lastTier]?.label.replace(/^\w+ \((.+)\)$/, '$1') ?? t.lastTier) : 'Auto'}${t.usage ? ` · ${usd(t.usage.costUsd)} · ${t.usage.turns ?? 0} turns` : ''}`;
  return `<div class="thr ${t.id === current ? 'on' : ''}" data-thread="${t.id}">
    <div class="l1">${chip(p)}<span>${esc(p?.name)}</span>${statusOf(t)}</div>
    <div class="l2 tt">${esc(t.title)}</div>
    <div class="l3">${l3}</div>
    <span class="thrActs"><button class="ib" data-rename="${t.id}" title="Rename">${icon('edit')}</button><button class="ib" data-del="${t.id}" title="Delete">${icon('trash')}</button></span>
  </div>`;
}
function renderSide() {
  const q = $('#search').value.trim().toLowerCase();
  const match = (t) => !q || t.title.toLowerCase().includes(q) || (projectOf(t)?.name ?? '').toLowerCase().includes(q);
  const byRecent = (a, b) => (b.updated ?? b.created) - (a.updated ?? a.created);
  $('#groupToggle').classList.toggle('on', grouped);
  let html;
  if (!S.projects.length) {
    html = `<div class="emptySide">No projects yet.<br>Use ${icon('folder-plus')} to open a game folder.</div>`;
  } else if (grouped) {
    html = S.projects.map((p) => {
      const ts = S.threads.filter((t) => t.projectId === p.id && match(t)).sort(byRecent);
      if (q && !ts.length) return '';
      const cost = S.threads.filter((t) => t.projectId === p.id).reduce((s, t) => s + (t.usage?.costUsd ?? 0), 0);
      return `<div class="groupHead" title="${esc(p.path)}">${chip(p)}<span>${esc(p.name)}</span><span class="dim">${esc(p.engine)}</span><span class="grow"></span><span>${cost ? usd(cost) : ''}</span>
        <button class="ib" data-new="${p.id}" title="New thread">${icon('edit')}</button><button class="ib" data-delproj="${p.id}" title="Remove from Forge (files stay)">${icon('x')}</button></div>
        ${ts.map(threadRow).join('')}`;
    }).join('');
  } else {
    const ts = S.threads.filter(match).sort(byRecent);
    html = ts.map(threadRow).join('') || `<div class="emptySide">${q ? 'No matching threads.' : `No threads yet. Use ${icon('edit')} to start one.`}</div>`;
  }
  $('#threads').innerHTML = html;
}
$('#search').addEventListener('input', renderSide);
$('#groupToggle').addEventListener('click', () => { grouped = !grouped; store.set('forge.grouped', grouped ? '1' : '0'); renderSide(); });

async function newThread(projectId, worktree = false) {
  try { const th = await api('/api/threads', { method: 'POST', body: { projectId, worktree, ...defaults() } }); S.threads.push(th); openThread(th.id); $('#msg').focus(); }
  catch (err) { alert(err.message); }
}
$('#threads').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (btn?.dataset.new) return newThread(btn.dataset.new);
  if (btn?.dataset.delproj) {
    const p = S.projects.find((x) => x.id === btn.dataset.delproj);
    if (!confirm(`Remove "${p.name}" and its ${S.threads.filter((t) => t.projectId === p.id).length} threads from Forge?\nYour game files are not touched. Usage history is kept.`)) return;
    try { await api(`/api/projects/${p.id}`, { method: 'DELETE' }); await reloadState(); } catch (err) { alert(err.message); }
    return;
  }
  if (btn?.dataset.del) {
    const t = S.threads.find((x) => x.id === btn.dataset.del);
    if (!confirm(`Delete thread "${t.title}" and its chat history?\nUsage history is kept.${t.worktree ? '\nIts worktree folder stays on disk.' : ''}`)) return;
    try { await api(`/api/threads/${t.id}`, { method: 'DELETE' }); unread.delete(t.id); saveUnread(); if (current === t.id) closeThread(); await reloadState(); } catch (err) { alert(err.message); }
    return;
  }
  if (btn?.dataset.rename) return startRename(btn.dataset.rename);
  const row = e.target.closest('[data-thread]');
  if (row) openThread(row.dataset.thread);
});

// New-thread button: one project → start right away; several → pick from a menu.
$('#newThread').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!S.projects.length) return addFolder();
  const cur = projectOf(thread());
  if (S.projects.length === 1) return newThread(S.projects[0].id);
  $('#newMenu').innerHTML = '<div class="menuTitle">New thread in</div>' + [...S.projects].sort((a, b) => (b.id === cur?.id) - (a.id === cur?.id))
    .map((p) => `<button class="mi" data-np="${p.id}">${chip(p)}${esc(p.name)}<span class="grow"></span><span class="dim">${esc(p.engine)}</span></button>${p.repo ? `<button class="mi" data-np="${p.id}" data-wt="1"><span style="width:22px"></span><span class="dim">${esc(p.name)} in its own worktree</span></button>` : ''}`).join('');
  $('#newMenu').hidden = false;
});
$('#newMenu').addEventListener('click', (e) => { const b = e.target.closest('[data-np]'); if (b) { $('#newMenu').hidden = true; newThread(b.dataset.np, !!b.dataset.wt); } });
document.addEventListener('click', (e) => {
  if (!e.target.closest('#newMenu')) $('#newMenu').hidden = true;
  if (!e.target.closest('#optsMenu') && !e.target.closest('#optsBtn')) $('#optsMenu').hidden = true;
});

async function addProject(dir) {
  try {
    const p = await api('/api/projects', { method: 'POST', body: { path: dir } });
    if (!S.projects.some((x) => x.id === p.id)) S.projects.push(p);
    $('#projectPath').value = ''; $('#addProject').hidden = true; renderSide();
    if (!S.threads.some((t) => t.projectId === p.id)) newThread(p.id);
  } catch (err) { alert(err.message); }
}
async function addFolder() {
  if (desktop) { const dir = await desktop.pickFolder(); if (dir) addProject(dir); }
  else { $('#addProject').hidden = !$('#addProject').hidden; $('#projectPath').focus(); }
}
$('#addFolder').addEventListener('click', addFolder);
$('#addProject').addEventListener('submit', (e) => { e.preventDefault(); if ($('#projectPath').value.trim()) addProject($('#projectPath').value.trim()); });
if (desktop) { $('#openFolder').hidden = false; $('#openFolder').addEventListener('click', () => thread() && desktop.openPath(thread().cwd)); }

// Inline rename (window.prompt does not exist in the desktop app).
function startRename(id) {
  const t = S.threads.find((x) => x.id === id);
  const el = document.querySelector(`[data-thread="${id}"] .tt`) ?? (id === current ? $('#crumbThread') : null);
  if (!el) return;
  const input = document.createElement('input');
  input.value = t.title; input.className = 'renameBox';
  el.replaceWith(input); input.focus(); input.select();
  let done = false;
  const finish = async (keep) => {
    if (done) return; done = true;
    const title = input.value.trim();
    if (keep && title && title !== t.title) { t.title = title; await api(`/api/threads/${id}`, { method: 'PATCH', body: { title } }).catch((err) => alert(err.message)); }
    if (!input.isConnected) return;
    if (el.id === 'crumbThread') { input.replaceWith(el); }
    renderSide(); renderCrumbs();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}
$('#crumbThread').addEventListener('dblclick', () => current && startRename(current));

// ---------------- views ----------------
function renderCrumbs() {
  const usage = !$('#usageView').hidden;
  const t = thread(), p = projectOf(t);
  $('#crumbProject').innerHTML = usage ? 'Usage' : p ? `${chip(p)}${esc(p.name)}` : '';
  $('#crumbSep').hidden = usage || !t;
  $('#crumbThread').textContent = usage ? '' : t?.title ?? '';
}
function setView(v) {
  document.body.classList.toggle('usageMode', v === 'usage');
  $('#usageView').hidden = v !== 'usage';
  $('#usageBtn').classList.toggle('on', v === 'usage');
  renderCrumbs();
  if (v === 'usage') loadUsage();
}
$('#usageBtn').addEventListener('click', () => setView($('#usageView').hidden ? 'usage' : 'threads'));
$('#todayBox').addEventListener('click', () => setView('usage'));

// ---------------- thread view ----------------
const welcome = () => `<div class="empty"><b>Forge</b><br>${S.projects.length ? 'Pick a thread on the left, or start a new one.' : 'Open a game folder to start.'}</div>`;
function closeThread() {
  current = null; act = null;
  $('#composer').hidden = true;
  $('#col').innerHTML = welcome();
  renderCrumbs();
}

async function openThread(id) {
  setView('threads');
  current = id; act = null;
  store.set('forge.lastThread', id);
  if (unread.delete(id)) saveUnread();
  const t = thread();
  renderSide(); renderCrumbs();
  $('#composer').hidden = false;
  $('#optWeb').checked = !!t.web; $('#optBudget').value = t.budgetUsd ?? '';
  renderThreadUsage(); renderPills(); setRunning(t.running);
  $('#col').innerHTML = '';
  live = null; liveText = '';
  picks = []; renderPicks();
  if (!$('#viewer').hidden) import('/viewer.js').then((v) => v.closeViewer());
  toolEls.clear();
  const events = await api(`/api/threads/${id}/events`);
  if (!events.length) $('#col').innerHTML = `<div class="empty"><b>${esc(projectOf(t)?.name)}</b><br>Ask for a change, a fix or a new feature.<br><span class="small">Quick tweaks go to Haiku, normal work to Sonnet, hard problems to Opus.</span></div>`;
  for (const ev of events) renderEvent(ev, true);
  scrollLog();
  loadPlay(); loadErrors(); loadTab();
}

function renderThreadUsage() {
  const t = thread();
  if (!t) return;
  const u = t.usage;
  const big = (t.lastContextTokens ?? 0) > 60_000;
  $('#ctxInfo').innerHTML = [t.lastContextTokens ? `<span class="${big ? 'warnTxt' : ''}">${tok(t.lastContextTokens)} context</span>` : '', u ? `${usd(u.costUsd)} · ${u.turns ?? 0} turns` : ''].filter(Boolean).join(' · ')
    + (big ? ` · <a href="#" id="handoffLink" title="Every message re-reads this context. A fresh thread from a summary starts small.">start fresh</a>` : '');
  $('#ctxInfo').title = 'Context = tokens the model reads on every request in this thread. Lower is cheaper.';
  $('#threadUsage').innerHTML = u ? `<div>Thread ${usd(u.costUsd)} · saved vs all-Opus ≈ <span class="saved">${usd(Math.max(0, u.ifAllOpusUsd - u.costUsd))}</span></div>` +
    Object.entries(u.byModel ?? {}).map(([m, x]) => `<div>${esc(short(m))}: ${usd(x.cost)} · ${tok(x.in + x.cacheRead + x.cacheWrite)} in (${hitRate(x)}% cached) · ${tok(x.out)} out</div>`).join('') : 'No usage yet.';
}

// Chat rendering. Tool calls of a turn collapse into one "Worked for …" line, like T3 Code.
const toolEls = new Map();
let act = null; // current turn's activity group { el, body, n }
const col = () => $('#col');
function ensureAct() {
  if (!act) {
    const d = document.createElement('details');
    d.className = 'activity';
    d.innerHTML = `<summary><span class="lbl">Working…</span>${icon('chevron')}</summary><div class="actBody"></div>`;
    col().appendChild(d);
    act = { el: d, body: d.querySelector('.actBody'), n: 0 };
  }
  return act;
}
const setActLabel = (text) => { if (act) act.el.querySelector('.lbl').textContent = text; };
const mdLite = (s) => esc(s)
  .replace(/```[\w-]*\n([\s\S]*?)```/g, (_, c) => `<pre>${c}</pre>`)
  .replace(/`([^`\n]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  .replace(/^[-*] (.+)$/gm, '• $1')
  .replace(/^#{1,4} (.+)$/gm, '<span class="h">$1</span>')
  .split(/\n{2,}/).map((p) => (p.startsWith('<pre>') ? p : `<p>${p.replace(/\n/g, '<br>')}</p>`)).join('');

function turnMeta(ev) {
  const parts = Object.entries(ev.turn?.perModel ?? {}).map(([m, d]) =>
    `<span title="input ${d.in} · cache read ${d.cacheRead} · cache write ${d.cacheWrite} · output ${d.out}"><b>${esc(short(m))}</b> ${tok(d.in + d.cacheRead + d.cacheWrite)} in · ${hitRate(d)}% cached · ${tok(d.out)} out · ${usd(d.cost)}</span>`);
  if (ev.ctx) parts.push(`<span>context ${tok(ev.ctx)}</span>`);
  return parts.join('');
}

function renderEvent(ev, replay = false) {
  col().querySelector('.empty')?.remove();
  const el = document.createElement('div');
  switch (ev.type) {
    case 'user': {
      act = null;
      el.className = 'user'; el.textContent = ev.text;
      if (ev.picks?.length) el.insertAdjacentHTML('afterbegin', `<div class="userPicks">${ev.picks.map((p) => `<span class="chipPick"><img src="${esc(p.src)}" alt=""><span>${esc(p.label)}</span></span>`).join('')}</div>`);
      col().appendChild(el);
      const meta = document.createElement('div');
      meta.className = 'userMeta';
      const label = ev.model ? `${modelInfo(ev.model)?.displayName ?? short(ev.model)}${ev.effort ? ' · ' + effortName(ev.effort) : ''}` : TIERS[ev.tier]?.label ?? ev.tier;
      const perm = ev.permissionMode && ev.permissionMode !== 'default' ? ` · ${esc(PERMS.find((p) => p.id === ev.permissionMode)?.label ?? ev.permissionMode)}` : '';
      meta.innerHTML = `<span class="t-${ev.tier}">${esc(label)}</span>${perm} · ${esc(ev.reason)}${ev.t ? ` · ${new Date(ev.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}`;
      col().appendChild(meta);
      return;
    }
    case 'info': { const a = ensureAct(); el.className = 'info'; el.textContent = ev.text; a.body.appendChild(el); return; }
    case 'toolImage': {
      const a = ensureAct();
      el.className = 'shot' + (ev.sub ? ' sub' : '');
      el.innerHTML = `<div class="dim small">${icon('image')} ${esc(ev.tool.replace(/^mcp__(\w+)__/, '$1: '))}</div><img src="${esc(ev.src)}" alt="Image returned by ${esc(ev.tool)}">`;
      a.body.appendChild(el);
      return;
    }
    case 'playtest': {
      const a = ensureAct();
      el.className = 'shot';
      el.innerHTML = `<div class="dim small">${icon('play')} Playtest · ${ev.steps.length} steps${ev.errors ? ` · <span class="errTxt">${ev.errors} runtime error${ev.errors === 1 ? '' : 's'}</span>` : ''}</div>
        <pre class="ptLog">${esc(ev.steps.join('\n'))}</pre>
        <div class="ptShots">${(ev.shots ?? []).map((s) => `<figure><img src="${esc(s.src)}" alt=""><figcaption>${esc(s.label)}</figcaption></figure>`).join('')}</div>`;
      a.body.appendChild(el);
      return;
    }
    case 'shot': {
      // What Claude saw when it checked the game: shown inside the turn's activity group.
      const a = ensureAct();
      el.className = 'shot';
      el.innerHTML = `<div class="dim small">${icon('play')} Checked the game · ${ev.errors ? `<span class="errTxt">${ev.errors} runtime error${ev.errors === 1 ? '' : 's'}</span>` : 'no runtime errors'}${ev.warnings ? ` · ${ev.warnings} warning${ev.warnings === 1 ? '' : 's'}` : ''}</div>${ev.src || ev.image ? `<img src="${esc(ev.src ?? ev.image)}" alt="Screenshot Claude took of the game">` : `<div class="dim small">No screenshot: ${esc(ev.note)}</div>`}`;
      a.body.appendChild(el);
      return;
    }
    case 'tool': {
      const a = ensureAct(); a.n++;
      el.className = 'tool' + (ev.sub ? ' sub' : '');
      el.innerHTML = `<b>${esc(ev.name.replace('mcp__forge__', 'forge:'))}</b> ${esc(ev.summary)}`;
      toolEls.set(ev.id, el); a.body.appendChild(el);
      setActLabel(`Working… · ${a.n} step${a.n === 1 ? '' : 's'}`);
      return;
    }
    case 'tool_result': {
      const host = toolEls.get(ev.id);
      if (!host) return;
      if (ev.isError) host.classList.add('err');
      host.insertAdjacentHTML('beforeend', `<details><summary>${ev.isError ? 'error' : 'output'} · ${ev.text.length} chars</summary><pre>${esc(ev.text)}</pre></details>`);
      return;
    }
    case 'text':
      if (ev.sub) { const a = ensureAct(); el.className = 'actText sub'; el.innerHTML = mdLite(ev.text); a.body.appendChild(el); return; }
      dropLive(); // the finished block replaces the streamed preview
      el.className = 'text'; el.innerHTML = mdLite(ev.text); break;
    case 'handoff':
      el.className = 'planCard';
      el.innerHTML = `<div class="apLabel">↳ Continues “${esc(ev.from)}”</div><div class="text">${mdLite(ev.note)}</div><div class="dim small">Claude gets this note with your first message here (summary cost ${usd(ev.costUsd)}).</div>`;
      break;
    case 'plan':
      el.className = 'planCard';
      el.innerHTML = `<div class="apLabel">${icon('map')} Plan</div><div class="text">${mdLite(ev.text)}</div>
        <div class="planBtns"><button class="apAllow" data-run="acceptEdits">Approve &amp; run</button><button class="apAlways" data-run="default">Run, but ask before each change</button><span class="dim small">or type changes to the plan below</span></div>`;
      break;
    case 'approval':
      el.className = 'approval'; el.dataset.req = ev.reqId;
      el.innerHTML = `<div class="apLabel">Approval needed</div><div class="apTool">${esc(ev.tool)}</div><div class="apCmd">${esc(ev.summary)}${ev.diff ? ` · <span class="add">+${ev.diff.added}</span> <span class="del">−${ev.diff.removed}</span>` : ''}</div>
        ${ev.diff ? diffHtml(ev.diff) : ''}
        <details><summary>details</summary><pre>${esc(ev.input)}</pre></details>
        <div class="apBtns"><button class="apAllow" data-d="allow">Allow once</button><button class="apAlways" data-d="always">Allow for this thread</button><button class="apDeny" data-d="deny">Decline</button></div>`;
      break;
    case 'approval_done': {
      const a = col().querySelector(`[data-req="${ev.reqId}"]`);
      // Once answered, the card shrinks to one line (T3 only shows the big card while it waits).
      if (a) {
        const label = { allow: 'Allowed once', always: 'Allowed for this thread', deny: 'Declined' }[ev.decision] ?? ev.decision;
        a.className = 'apDone' + (ev.decision === 'deny' ? ' denied' : '');
        a.innerHTML = `${icon(ev.decision === 'deny' ? 'x' : 'check')}<b>${esc(a.querySelector('.apTool')?.textContent)}</b> ${esc(a.querySelector('.apCmd')?.textContent)} · ${esc(label)}`;
      }
      return;
    }
    case 'result': {
      const secs = ((ev.turnMs ?? 0) / 1000).toFixed(1);
      const stopped = ev.isError && ev.text === 'error_during_execution';
      if (act) setActLabel(`${stopped ? 'Stopped after' : 'Worked for'} ${secs}s · ${act.n} step${act.n === 1 ? '' : 's'}`);
      else if (stopped) { el.className = 'turnMeta'; el.textContent = `Stopped after ${secs}s`; col().appendChild(el); }
      if (ev.isError && !stopped) { const e = document.createElement('div'); e.className = 'error'; e.textContent = `Turn failed: ${ev.text}`; col().appendChild(e); }
      dropLive();
      if (ev.changed?.length) {
        const ch = document.createElement('div');
        ch.className = 'changes'; ch.dataset.turn = ev.turnId;
        ch.innerHTML = `${icon('pen')}<span>${ev.changed.length} file${ev.changed.length === 1 ? '' : 's'} changed: ${ev.changed.map((f) => `<code>${esc(f)}</code>`).join(' ')}</span>
          <button class="btn small undoBtn" data-undo="${esc(ev.turnId)}" title="Put these files back as they were before this turn (later turns are undone too). Changes made by shell commands are not covered.">Undo</button>`;
        col().appendChild(ch);
      }
      const meta = document.createElement('div'); meta.className = 'turnMeta'; meta.innerHTML = turnMeta(ev);
      col().appendChild(meta);
      act = null;
      if (!replay) { refreshToday(); }
      return;
    }
    case 'undone':
      for (const id of ev.turns ?? []) {
        const ch = col().querySelector(`.changes[data-turn="${CSS.escape(id)}"]`);
        if (ch) { ch.classList.add('undone'); ch.querySelector('.undoBtn')?.replaceWith(Object.assign(document.createElement('span'), { className: 'dim small', textContent: 'Undone' })); }
      }
      el.className = 'turnMeta';
      el.innerHTML = `↺ Undid ${ev.turns?.length ?? 1} turn${ev.turns?.length === 1 ? '' : 's'} · restored ${ev.files?.length ? ev.files.map((f) => `<code>${esc(f)}</code>`).join(' ') : 'nothing'}. Claude will be told on your next message.`;
      break;
    case 'models':
      el.className = 'changes';
      el.innerHTML = `${icon('image')}<span>${ev.files.length} 3D model${ev.files.length === 1 ? '' : 's'} written: ${ev.files.map((f) => `<code>${esc(f)}</code>`).join(' ')}</span>
        ${ev.files.map((f) => `<button class="btn small" data-view3d="${esc(f)}" data-project="${esc(ev.projectId)}">View ${esc(f.split('/').pop())} in 3D</button>`).join('')}`;
      break;
    case 'rejected':
      el.className = 'turnMeta';
      el.innerHTML = `✕ Rejected this thread's changes to <code>${esc(ev.file)}</code>; it is back to how it was. Claude will be told on your next message.`;
      break;
    case 'error': el.className = 'error'; el.textContent = ev.text; break;
    default: return;
  }
  col().appendChild(el);
}
const scrollLog = () => { const l = $('#log'); l.scrollTop = l.scrollHeight; };

// Streaming: a live preview of the text Claude is writing; replaced by the finished block.
let live = null, liveText = '', liveFrame = 0;
function dropLive() { live?.remove(); live = null; liveText = ''; }
function onDelta(text) {
  if (!live) { live = document.createElement('div'); live.className = 'text live'; col().appendChild(live); }
  liveText += text;
  if (!liveFrame) liveFrame = requestAnimationFrame(() => { liveFrame = 0; if (live) { live.innerHTML = mdLite(liveText); scrollLog(); } });
}

$('#col').addEventListener('click', async (e) => {
  const v3 = e.target.closest('[data-view3d]');
  if (v3) {
    setPanel(true);
    document.querySelector('.tabs button[data-tab="assets"]').click();
    const f = v3.dataset.view3d;
    const { openViewer } = await import('/viewer.js');
    openViewer($('#viewer'), `${gameBase()}/files/${v3.dataset.project}/${f.split('/').map(encodeURIComponent).join('/')}`, f);
    return;
  }
  const u = e.target.closest('[data-undo]');
  if (u) {
    const ch = u.closest('.changes');
    const later = [...col().querySelectorAll('.changes:not(.undone)')].filter((x) => x.dataset.turn > ch.dataset.turn).length;
    if (!confirm(`Undo this turn${later ? ` and the ${later} later turn${later === 1 ? '' : 's'} that changed files` : ''}?\nThe changed files go back to how they were before it.\nChanges made by shell commands are not covered.`)) return;
    u.disabled = true;
    try { await api(`/api/threads/${current}/undo`, { method: 'POST', body: { turnId: ch.dataset.turn } }); }
    catch (err) { alert(err.message); u.disabled = false; }
    return;
  }
  const run = e.target.closest('[data-run]');
  if (run) {
    if (thread()?.running) return;
    const t = thread();
    t.permMode = run.dataset.run; renderPills();
    run.closest('.planBtns').innerHTML = `<span class="dim small">${run.dataset.run === 'acceptEdits' ? 'Approved, running with auto-accept edits…' : 'Running, asking before each change…'}</span>`;
    try {
      await patchThread({ permMode: t.permMode });
      await api(`/api/threads/${current}/message`, { method: 'POST', body: { text: 'The plan is approved. Implement it now, then check the game for errors.' } });
      setRunning(true);
    } catch (err) { alert(err.message); }
    return;
  }
  const b = e.target.closest('[data-d]');
  if (!b) return;
  const req = b.closest('[data-req]').dataset.req;
  b.parentElement.querySelectorAll('button').forEach((x) => (x.disabled = true));
  await api(`/api/approvals/${req}`, { method: 'POST', body: { decision: b.dataset.d } }).catch((err) => alert(err.message));
});

function setRunning(on) { $('#stop').hidden = !on; $('#send').hidden = !!on; }

// ---------------- composer ----------------
function updateRouteHint() {
  const t = thread();
  const text = $('#msg').value.trim();
  $('#msg').style.height = 'auto'; $('#msg').style.height = Math.min(260, $('#msg').scrollHeight) + 'px';
  if (!text || (t?.model ?? 'auto') !== 'auto') { $('#routeHint').textContent = ''; return; }
  const r = routeMessage(text, { override: 'auto', lastTier: t?.lastTier, lastContextTokens: t?.lastContextTokens ?? 0 });
  $('#routeHint').textContent = `→ ${TIERS[r.tier].label}`;
  $('#routeHint').title = r.reason;
}
$('#msg').addEventListener('input', updateRouteHint);
$('#msg').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#composer').requestSubmit(); });
$('#composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#msg').value.trim();
  if (!text || !current) return;
  try {
    await api(`/api/threads/${current}/message`, { method: 'POST', body: { text, attachments: picks.map((p) => ({ kind: 'pick', ...p })) } });
    $('#msg').value = ''; picks = []; renderPicks(); updateRouteHint(); setRunning(true);
  } catch (err) { alert(err.message); }
});

// ---------------- pick in game ----------------
// Click "Pick", then click something in the Play tab: Forge attaches a marked screenshot and (for three.js)
// the object under the click to your next message. Nothing is sent until you press Send.
let picks = [];
function renderPicks() {
  $('#attach').hidden = !picks.length;
  $('#attach').innerHTML = picks.map((p, i) => {
    const o = p.objects?.[0];
    const label = o ? `${o.type}${o.name ? ` “${o.name}”` : ''}${o.color ? ` · ${o.color}` : ''}` : `point ${p.x}, ${p.y}`;
    return `<span class="chipPick"><img src="${esc(p.src)}" alt=""><span>${esc(label)}</span><button type="button" class="ib" data-unpick="${i}" title="Remove">${icon('x')}</button></span>`;
  }).join('');
}
$('#attach').addEventListener('click', (e) => { const b = e.target.closest('[data-unpick]'); if (b) { picks.splice(Number(b.dataset.unpick), 1); renderPicks(); } });
let picking = false;
$('#pickBtn').addEventListener('click', async () => {
  if (!current) return;
  if (picking) { picking = false; api(`/api/threads/${current}/unpick`, { method: 'POST' }); return; }
  if (!projectOf(thread())?.web) return alert('Pick works with browser games shown in the Play tab.');
  setPanel(true);
  document.querySelector('.tabs button[data-tab="play"]').click();
  picking = true;
  $('#pickBtn').classList.add('on'); $('#pickBtn').querySelector('span').textContent = 'Click in the game… (Esc)';
  try {
    const r = await api(`/api/threads/${current}/pick`, { method: 'POST' });
    if (r.error) alert(r.error);
    else if (!r.cancelled) { picks.push(r); renderPicks(); $('#msg').focus(); }
  } catch (err) { alert(err.message); }
  picking = false;
  $('#pickBtn').classList.remove('on'); $('#pickBtn').querySelector('span').textContent = 'Pick';
});
$('#stop').addEventListener('click', () => api(`/api/threads/${current}/interrupt`, { method: 'POST' }));
$('#optsBtn').addEventListener('click', () => { renderThreadUsage(); renderBlender(); toggleMenu('#optsMenu'); });

// ---------------- Blender ----------------
async function renderBlender() {
  const p = projectOf(thread());
  $('#optBlender').checked = !!p?.blender;
  $('#blenderState').textContent = '…';
  try {
    const s = await api('/api/blender');
    const busy = s.holder && s.holder !== current ? ' · in use by another thread' : '';
    $('#blenderState').textContent = { ready: '· connected', 'not-running': '· Blender not running', 'not-installed': '· MCP not installed' }[s.state] + busy;
    $('#blenderState').title = s.text;
  } catch { $('#blenderState').textContent = ''; }
}
async function setBlender(on) {
  const p = projectOf(thread());
  if (!p) return;
  p.blender = on;
  await api(`/api/projects/${p.id}`, { method: 'PATCH', body: { blender: on } }).catch((err) => alert(err.message));
  renderBlender();
  if (tab === 'assets') loadTab();
}
$('#optBlender').addEventListener('change', (e) => setBlender(e.target.checked));
$('#assets').addEventListener('click', async (e) => {
  if (e.target.id === 'blendOn') return setBlender(true);
  const m = e.target.closest('.asset.viewable');
  if (m) {
    const { openViewer } = await import('/viewer.js'); // loads three.js only when a model is opened
    openViewer($('#viewer'), m.dataset.url, m.dataset.name);
  }
});

async function handoff() {
  const t = thread();
  if (!t || t.running) return;
  $('#optsMenu').hidden = true;
  $('#ctxInfo').textContent = 'Writing a handoff summary…';
  try { const nt = await api(`/api/threads/${t.id}/handoff`, { method: 'POST' }); S.threads.push(nt); await openThread(nt.id); $('#msg').focus(); }
  catch (err) { alert(err.message); renderThreadUsage(); }
}
$('#handoffBtn').addEventListener('click', handoff);
$('#ctxInfo').addEventListener('click', (e) => { if (e.target.id === 'handoffLink') { e.preventDefault(); handoff(); } });

const patchThread = (body) => api(`/api/threads/${current}`, { method: 'PATCH', body });

// ---------------- model + permission menus ----------------
let MODELS = [];
const MAIN_MODELS = ['fable', 'opus', 'sonnet', 'haiku'];
const EFFORTS = [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']];
const PERMS = [
  { id: 'default', label: 'Ask', icon: 'lock', title: 'Ask every time', desc: 'Claude asks before each edit and command.' },
  { id: 'acceptEdits', label: 'Auto-edit', icon: 'pen', title: 'Auto-accept edits', desc: 'File edits run straight away; commands still ask.' },
  { id: 'auto', label: 'Auto', icon: 'shield', title: 'Auto', desc: 'A safety classifier approves routine actions and asks only when unsure.' },
  { id: 'plan', label: 'Plan', icon: 'map', title: 'Plan only', desc: 'Read-only. Claude investigates and writes a plan, changes nothing.' },
  { id: 'bypassPermissions', label: 'Full access', icon: 'unlock', title: 'Full access', desc: 'Never asks. Edits and commands run without approval. Use with care.', warn: true },
];
const modelInfo = (value) => MODELS.find((m) => m.value === value);
const modelName = (value) => (!value || value === 'auto' ? 'Auto' : modelInfo(value)?.displayName ?? short(value));
const effortName = (e) => EFFORTS.find(([v]) => v === e)?.[1] ?? e;
const defaults = () => JSON.parse(store.get('forge.defaults') ?? '{}');
const rememberDefaults = (patch) => store.set('forge.defaults', JSON.stringify({ ...defaults(), ...patch }));

function toggleMenu(sel) {
  const el = $(sel), open = el.hidden;
  ['#modelMenu', '#permMenu', '#optsMenu', '#newMenu'].forEach((m) => ($(m).hidden = true));
  el.hidden = !open;
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.menu') && !e.target.closest('#modelBtn,#permBtn,#optsBtn,#newThread')) ['#modelMenu', '#permMenu', '#optsMenu'].forEach((m) => ($(m).hidden = true));
});

function renderPills() {
  const t = thread();
  if (!t) return;
  const model = t.model ?? 'auto', effort = t.effort ?? 'auto';
  $('#modelBtn').innerHTML = `${icon('spark').replace('class="i"', 'class="i spark"')}<span>${esc(modelName(model))}</span>${effort !== 'auto' ? `<span class="dim">${esc(effortName(effort))}</span>` : ''}${icon('down')}`;
  const perm = PERMS.find((p) => p.id === (t.permMode ?? (t.autoEdits ? 'acceptEdits' : 'default'))) ?? PERMS[0];
  $('#permBtn').innerHTML = `${icon(perm.icon)}<span>${esc(perm.label)}</span>${icon('down')}`;
  $('#permBtn').classList.toggle('warn', !!perm.warn);
  updateRouteHint();
}

function renderModelMenu() {
  const t = thread();
  const model = t.model ?? 'auto', effort = t.effort ?? 'auto';
  const row = (value, title, desc) => `<button class="mi pick ${value === model ? 'sel' : ''}" data-model="${esc(value)}">
    <span class="tick">${value === model ? icon('check') : ''}</span><span class="miText"><span>${esc(title)}</span><span class="dim">${esc(desc)}</span></span></button>`;
  const main = MAIN_MODELS.map(modelInfo).filter(Boolean);
  const more = MODELS.filter((m) => !MAIN_MODELS.includes(m.value));
  const levels = model === 'auto' ? EFFORTS : EFFORTS.filter(([v]) => v === 'auto' || (modelInfo(model)?.supportedEffortLevels ?? []).includes(v));
  $('#modelMenu').innerHTML = `<div class="menuTitle">Model</div>
    ${row('auto', 'Auto', 'Haiku for tweaks, Sonnet for features, Opus for hard problems. Cheapest.')}
    ${main.map((m) => row(m.value, m.displayName, m.description)).join('')}
    ${more.length ? `<details class="more"><summary class="mi">${icon('chevron')}More models</summary>${more.map((m) => row(m.value, m.displayName, m.description)).join('')}</details>` : ''}
    <div class="menuTitle">Effort</div>
    <div class="seg">${levels.map(([v, l]) => `<button class="${v === effort ? 'on' : ''}" data-effort="${v}" title="${v === 'auto' ? 'Auto: low for Haiku, medium for Sonnet, high for Opus' : ''}">${l}</button>`).join('')}</div>
    <div class="menuHint dim">Higher effort thinks longer and costs more. Auto picks it per message.</div>`;
}
function renderPermMenu() {
  const t = thread();
  const cur = t.permMode ?? (t.autoEdits ? 'acceptEdits' : 'default');
  $('#permMenu').innerHTML = `<div class="menuTitle">Permissions</div>` + PERMS.map((p) => `<button class="mi pick ${p.id === cur ? 'sel' : ''} ${p.warn ? 'warnRow' : ''}" data-perm="${p.id}">
    <span class="tick">${p.id === cur ? icon('check') : ''}</span>${icon(p.icon)}<span class="miText"><span>${esc(p.title)}</span><span class="dim">${esc(p.desc)}</span></span></button>`).join('');
}
$('#modelBtn').addEventListener('click', async () => {
  if (!MODELS.length) MODELS = await api('/api/models').catch(() => []);
  renderModelMenu(); toggleMenu('#modelMenu');
});
$('#permBtn').addEventListener('click', () => { renderPermMenu(); toggleMenu('#permMenu'); });
$('#modelMenu').addEventListener('click', async (e) => {
  const m = e.target.closest('[data-model]'), ef = e.target.closest('[data-effort]');
  if (!m && !ef) return;
  const t = thread();
  const patch = m ? { model: m.dataset.model } : { effort: ef.dataset.effort };
  // An effort the new model doesn't support falls back to Auto.
  if (m && t.effort && t.effort !== 'auto' && m.dataset.model !== 'auto' && !(modelInfo(m.dataset.model)?.supportedEffortLevels ?? []).includes(t.effort)) patch.effort = 'auto';
  Object.assign(t, patch); rememberDefaults(patch);
  renderPills(); renderModelMenu();
  if (m) $('#modelMenu').hidden = true;
  await patchThread(patch).catch((err) => alert(err.message));
});
$('#permMenu').addEventListener('click', async (e) => {
  const p = e.target.closest('[data-perm]');
  if (!p) return;
  if (p.dataset.perm === 'bypassPermissions' && !confirm('Full access: Claude will edit files and run commands in this project without asking.\nUse it only on projects under version control or with a backup. Continue?')) return;
  const t = thread();
  t.permMode = p.dataset.perm; rememberDefaults({ permMode: t.permMode === 'bypassPermissions' ? 'default' : t.permMode }); // never default new threads to full access
  $('#permMenu').hidden = true; renderPills();
  await patchThread({ permMode: t.permMode }).catch((err) => alert(err.message));
});
$('#optWeb').addEventListener('change', (e) => patchThread({ web: e.target.checked }));
$('#optBudget').addEventListener('change', (e) => patchThread({ budgetUsd: e.target.value ? Number(e.target.value) : null }));

// ---------------- right panel ----------------
let tab = 'play';
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  tab = b.dataset.tab;
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tab').forEach((x) => (x.hidden = x.id !== `tab-${tab}`));
  loadTab();
}));
function loadPlay() {
  const t = thread(), p = projectOf(t);
  if (!p?.web) { $('#game').removeAttribute('src'); $('#game').srcdoc = `<p style="color:#777;font:13px system-ui;padding:1em">Live preview is for browser games. Detected engine: ${esc(p?.engine ?? '—')}.</p>`; return; }
  $('#game').removeAttribute('srcdoc');
  $('#game').src = $('#openTab').href = `${gameBase()}/play/${t.id}/`;
}
$('#reload').addEventListener('click', loadPlay);
async function loadErrors() {
  if (!current) return;
  const errs = await api(`/api/threads/${current}/errors`);
  $('#errors').innerHTML = errs.map((e) => `<li class="${e.kind === 'warn' ? 'warn' : ''}">[${esc(e.kind)}]${e.count > 1 ? ` ×${e.count}` : ''} ${esc(e.msg)}</li>`).join('') || '<li class="dim" style="color:var(--dim)">None since the last reload.</li>';
  $('#errCount').textContent = errs.length;
}
async function loadTab() {
  const t = thread(), p = projectOf(t);
  if (!t) return;
  if (tab === 'assets') {
    const list = (await api(`/api/projects/${p.id}/assets`)).filter((a) => a.kind !== 'code');
    const ic = { model: '🧊', audio: '🔊', font: '🔤', scene: '🎬', other: '📄', image: '🖼' };
    const blends = list.filter((a) => /\.blend$/i.test(a.path)).length;
    const hint = blends && !p.blender ? `<div class="blendHint">${blends} Blender file${blends === 1 ? '' : 's'} here. <button class="btn small" id="blendOn">Turn on the Blender helper</button><span class="dim small">Claude can then inspect your open Blender scene and export models into this game.</span></div>` : '';
    const fileUrl = (a) => `${gameBase()}/files/${p.id}/${a.path.split('/').map(encodeURIComponent).join('/')}`;
    $('#assets').innerHTML = hint + (list.length ? list.map((a) => `<div class="asset${/\.(glb|gltf)$/i.test(a.path) ? ' viewable' : ''}" title="${esc(a.path)} · ${Math.round(a.size / 1024)}KB${/\.(glb|gltf)$/i.test(a.path) ? ' · click to view in 3D' : ''}" data-url="${esc(fileUrl(a))}" data-name="${esc(a.path)}">
      ${a.kind === 'image' && !/\.(psd|exr|hdr|ktx2)$/i.test(a.path) ? `<img loading="lazy" src="${gameBase()}/files/${p.id}/${a.path.split('/').map(encodeURIComponent).join('/')}" alt="">` : `<div class="ic">${ic[a.kind]}</div>`}
      ${esc(a.path.split('/').pop())}</div>`).join('') : '<p class="dim small">No asset files found.</p>');
  } else if (tab === 'diff') {
    const d = await api(`/api/threads/${t.id}/changes`);
    $('#commitRow').hidden = !d.repo;
    $('#changes').innerHTML = d.files.length ? d.files.map((f) => `<div class="cfile" data-file="${esc(f.file)}">
      <div class="cfHead"><code>${esc(f.file)}</code>${f.isNew ? '<span class="pill">new</span>' : ''}${f.deleted ? '<span class="pill">deleted</span>' : ''}
        <span class="add">+${f.added}</span><span class="del">−${f.removed}</span><span class="grow"></span>
        <button class="btn small" data-reject="${esc(f.file)}" title="Put this file back as it was before this thread">Reject</button></div>
      ${f.tooLarge ? '<div class="dim small">Too large to show line by line.</div>' : diffHtml(f, true)}</div>`).join('')
      : '<p class="dim small">No changes in this thread (or they were undone).</p>';
  } else if (tab === 'brief') {
    const { brief } = await api(`/api/projects/${p.id}/brief`);
    $('#brief').textContent = brief ?? 'No brief yet. Building one costs a fraction of a cent of Haiku once and saves exploration on every later turn.';
  }
}
$('#refreshDiff').addEventListener('click', loadTab);

// Diff rendering shared by the Changes tab and approval cards.
function diffHtml(d, commentable = false) {
  if (!d?.hunks?.length) return '';
  return `<div class="dview">${d.hunks.map((h) => `<div class="hunk">${h.map((op) => `<div class="dl ${op.t === '+' ? 'add' : op.t === '-' ? 'del' : ''}${commentable && op.t !== '-' ? ' cl' : ''}" data-line="${op.n ?? ''}" data-text="${esc(op.text)}"><span class="ln">${op.t === '-' ? op.o : op.n}</span><span class="mk">${op.t}</span><span class="tx">${esc(op.text) || ' '}</span></div>`).join('')}</div>`).join('<div class="hsep">⋯</div>')}</div>`;
}
$('#changes').addEventListener('click', async (e) => {
  const rj = e.target.closest('[data-reject]');
  if (rj) {
    if (!confirm(`Reject all of this thread's changes to ${rj.dataset.reject}?\nThe file goes back to how it was before the thread. Claude is told on your next message.`)) return;
    try { await api(`/api/threads/${current}/reject`, { method: 'POST', body: { file: rj.dataset.reject } }); loadTab(); } catch (err) { alert(err.message); }
    return;
  }
  // Comment on a line: adds a quoted note to the message box (sent only when you press Send).
  const line = e.target.closest('.dl.cl');
  if (!line || line.querySelector('.cbox') || e.target.closest('.cbox')) return;
  const file = line.closest('.cfile').dataset.file;
  line.insertAdjacentHTML('beforeend', `<div class="cbox"><input placeholder="Comment on this line…"><button class="btn small">Add to message</button></div>`);
  const box = line.querySelector('.cbox'), input = box.querySelector('input');
  input.focus();
  const add = () => {
    const c = input.value.trim();
    if (c) { const t = $('#msg'); t.value = `${t.value ? t.value.trimEnd() + '\n' : ''}In ${file} line ${line.dataset.line} (\`${line.dataset.text.trim().slice(0, 120)}\`): ${c}`; updateRouteHint(); t.focus(); }
    box.remove();
  };
  box.querySelector('button').addEventListener('click', (ev) => { ev.stopPropagation(); add(); });
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') add(); if (ev.key === 'Escape') box.remove(); });
});
$('#commit').addEventListener('click', async () => {
  try { await api(`/api/threads/${current}/commit`, { method: 'POST', body: { message: $('#commitMsg').value } }); $('#commitMsg').value = ''; loadTab(); }
  catch (err) { alert(err.message); }
});
$('#buildBrief').addEventListener('click', async (e) => {
  const p = projectOf(thread());
  e.target.disabled = true; $('#brief').textContent = 'Haiku is reading the project…';
  try { const r = await api(`/api/projects/${p.id}/brief`, { method: 'POST' }); $('#brief').textContent = `${r.brief}\n\n(cost ≈ ${usd(r.costUsd)})`; refreshToday(); }
  catch (err) { $('#brief').textContent = 'Failed: ' + err.message; }
  e.target.disabled = false;
});

// ---------------- usage statistics ----------------
const table = (cols, rows, rowAttr = () => '') => rows.length
  ? `<table><thead><tr>${cols.map((c) => `<th class="${c.num ? 'num' : ''}">${c.h}</th>`).join('')}</tr></thead><tbody>${
    rows.map((r) => `<tr ${rowAttr(r)}>${cols.map((c) => `<td class="${c.num ? 'num' : ''}">${c.f(r)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
  : '<p class="dim small">Nothing yet.</p>';
const tokCols = [
  { h: 'Cost', num: 1, f: (r) => usd(r.cost) },
  { h: 'Turns', num: 1, f: (r) => r.turns },
  { h: 'Input', num: 1, f: (r) => tok(r.in + r.cacheRead + r.cacheWrite) },
  { h: 'Output', num: 1, f: (r) => tok(r.out) },
  { h: 'Cached', num: 1, f: (r) => hitRate(r) + '%' },
];
const tierCls = { quick: 'tq', standard: 'ts', deep: 'td' };

async function loadUsage() {
  const u = await api('/api/usage');
  const card = (label, x) => `<div class="card"><div class="dim small">${label}</div><div class="big">${usd(x.cost)}</div>
    <div class="dim small">${x.turns} turns · ${tok(x.in + x.cacheRead + x.cacheWrite)} in · ${tok(x.out)} out</div>
    <div class="dim small">${hitRate(x)}% cached · <span class="saved">saved ≈ ${usd(Math.max(0, x.ifOpus - x.cost))}</span></div></div>`;
  $('#cards').innerHTML = card('Today', u.totals.today) + card('Last 7 days', u.totals.week) + card('Last 30 days', u.totals.month) + card('All time', u.totals.all);

  const max = Math.max(...u.series.map((d) => d.cost), 0.0001);
  const W = 720, Hh = 150, bw = W / u.series.length;
  $('#chart').innerHTML = `<svg viewBox="0 0 ${W} ${Hh + 22}" preserveAspectRatio="none" role="img" aria-label="Cost per day">
    ${u.series.map((d, i) => { const h = (d.cost / max) * (Hh - 20); return `<rect x="${i * bw + 2}" y="${Hh - h}" width="${bw - 4}" height="${Math.max(h, d.cost ? 2 : 0)}" rx="2"><title>${d.day}: ${usd(d.cost)} · ${d.turns} turns · ${tok(d.in + d.cacheRead + d.cacheWrite)} in</title></rect>`; }).join('')}
    <text x="0" y="${Hh + 16}">${u.series[0].day.slice(5)}</text><text x="${W}" y="${Hh + 16}" text-anchor="end">${u.series.at(-1).day.slice(5)}</text>
    <text x="4" y="12">max ${usd(max)}/day</text></svg>`;

  $('#tModels').innerHTML = table([{ h: 'Model', f: (r) => esc(short(r.model)) }, ...tokCols], u.byModel);
  $('#tTiers').innerHTML = table([{ h: 'Route', f: (r) => `<span class="${tierCls[r.tier] ?? ''}">${esc(TIERS[r.tier]?.label ?? r.tier)}</span>` }, ...tokCols], u.byTier);
  const pById = (id) => S.projects.find((p) => p.id === id);
  $('#tProjects').innerHTML = table([{ h: 'Project', f: (r) => `${pById(r.id) ? chip(pById(r.id)) + ' ' : ''}${esc(r.name)}` }, ...tokCols], u.byProject);
  $('#tThreads').innerHTML = table([{ h: 'Thread', f: (r) => `${esc(r.title)}<div class="dim">${esc(r.project)}</div>` }, ...tokCols.slice(0, 3)], u.byThread,
    (r) => (r.exists ? `class="link" data-open="${r.id}"` : ''));
  $('#tRecent').innerHTML = table([
    { h: 'When', f: (r) => `${ago(r.t)}<div class="dim">${new Date(r.t).toLocaleString()}</div>` },
    { h: 'Thread', f: (r) => `${esc(r.title)}<div class="dim">${esc(r.project)}${r.kind === 'brief' ? ' · brief' : r.kind === 'handoff' ? ' · handoff summary' : ''}${r.error ? ' · stopped/failed' : ''}</div>` },
    { h: 'Route', f: (r) => `<span class="${tierCls[r.tier] ?? ''}">${esc(r.tier)}</span>` },
    { h: 'Models', f: (r) => Object.keys(r.perModel).map(short).join(', ') || '—' },
    { h: 'Input', num: 1, f: (r) => tok(Object.values(r.perModel).reduce((s, d) => s + d.in + d.cacheRead + d.cacheWrite, 0)) },
    { h: 'Output', num: 1, f: (r) => tok(Object.values(r.perModel).reduce((s, d) => s + d.out, 0)) },
    { h: 'Context', num: 1, f: (r) => (r.ctx ? tok(r.ctx) : '—') },
    { h: 'Cost', num: 1, f: (r) => usd(r.cost) },
  ], u.recent, (r) => (S.threads.some((t) => t.id === r.threadId) ? `class="link" data-open="${r.threadId}"` : ''));
}
$('#usageView').addEventListener('click', (e) => { const r = e.target.closest('[data-open]'); if (r) openThread(r.dataset.open); });
$('#refreshUsage').addEventListener('click', loadUsage);

async function refreshToday() {
  try {
    const u = await api('/api/usage');
    const d = u.totals.today;
    $('#todayBox').innerHTML = `<b>Today ${usd(d.cost)}</b> · ${d.turns} turns · ${tok(d.in + d.cacheRead + d.cacheWrite)} in`;
    if (!$('#usageView').hidden) loadUsage();
  } catch { /* ignore */ }
}

// ---------------- live events ----------------
async function reloadState() {
  S = await api('/api/state');
  if (current && !thread()) closeThread();
  renderSide();
}
function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.type === 'event') {
      const t = S.threads.find((x) => x.id === msg.threadId);
      if (t) {
        if (msg.ev.type === 'approval') t.awaiting = (t.awaiting ?? 0) + 1;
        if (msg.ev.type === 'approval_done') t.awaiting = Math.max(0, (t.awaiting ?? 0) - 1);
        if (msg.ev.type === 'result') {
          t.awaiting = 0; t.updated = Date.now();
          if (msg.threadId !== current) { unread.add(t.id); saveUnread(); }
        }
        if (['approval', 'approval_done', 'result'].includes(msg.ev.type)) renderSide();
      }
      if (msg.threadId === current) { renderEvent(msg.ev); scrollLog(); }
    }
    if (msg.type === 'delta' && msg.threadId === current) onDelta(msg.text);
    if (msg.type === 'running') {
      const t = S.threads.find((x) => x.id === msg.threadId);
      if (t) t.running = msg.running;
      if (msg.threadId === current) setRunning(msg.running);
      renderSide();
    }
    if (msg.type === 'thread') {
      const i = S.threads.findIndex((x) => x.id === msg.thread.id);
      if (i >= 0) S.threads[i] = msg.thread;
      if (msg.thread.id === current) { renderCrumbs(); renderThreadUsage(); }
      renderSide();
    }
    if (msg.type === 'state') {
      const wasWeb = projectOf(thread())?.web;
      reloadState().then(() => { if (current && projectOf(thread())?.web !== wasWeb) { renderCrumbs(); loadPlay(); loadTab(); } });
    }
    if (msg.type === 'reload' && $('#autoReload').checked && msg.dir === thread()?.cwd) loadPlay();
    if (msg.type === 'gameError' && msg.threadId === current) loadErrors();
  };
  ws.onclose = () => setTimeout(connect, 1500);
}

MODELS = await api('/api/models').catch(() => []);
await reloadState();
closeThread();
connect();
refreshToday();
setInterval(renderSide, 60_000); // keep "24m" labels fresh
const last = store.get('forge.lastThread');
const reopen = S.threads.find((t) => t.id === last) ?? [...S.threads].sort((a, b) => (b.updated ?? b.created) - (a.updated ?? a.created))[0];
if (reopen) openThread(reopen.id);
