// Per-turn file checkpoints, so any turn can be undone, even in game folders that are not git repos.
// Before Claude edits a file (Edit/Write/MultiEdit/NotebookEdit, also inside helper agents), the file is
// copied into data/checkpoints/<thread>/<turn>/. Files created in the turn are recorded as "did not exist".
// Changes made through shell commands (Bash) are NOT covered.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, newId } from './store.mjs';

const root = (threadId) => path.join(DATA_DIR, 'checkpoints', threadId);
const manifestPath = (threadId, turnId) => path.join(root(threadId), turnId, 'manifest.json');
const readManifest = (threadId, turnId) => JSON.parse(fs.readFileSync(manifestPath(threadId, turnId), 'utf8'));
const writeManifest = (threadId, m) => fs.writeFileSync(manifestPath(threadId, m.turnId), JSON.stringify(m, null, 1));

const inside = (dir, p) => { const r = path.resolve(dir), f = path.resolve(p); return f === r || f.startsWith(r + path.sep); };

export function beginTurn(threadId, cwd) {
  const turnId = `${Date.now()}-${newId()}`; // sortable
  fs.mkdirSync(path.join(root(threadId), turnId), { recursive: true });
  writeManifest(threadId, { turnId, t: Date.now(), cwd, files: [], undone: false });
  return turnId;
}

// Called from the PreToolUse hook. Only the first touch of a file in a turn is backed up.
export function backupFile(threadId, turnId, cwd, filePath) {
  if (!filePath) return;
  const abs = path.resolve(cwd, filePath);
  if (!inside(cwd, abs)) return; // never track or restore files outside the project
  const m = readManifest(threadId, turnId);
  if (m.files.some((f) => f.path === abs)) return;
  const entry = { path: abs, rel: path.relative(cwd, abs).split(path.sep).join('/'), existed: fs.existsSync(abs) };
  if (entry.existed) {
    entry.backup = `${m.files.length}.bak`;
    fs.copyFileSync(abs, path.join(root(threadId), turnId, entry.backup));
  }
  m.files.push(entry);
  writeManifest(threadId, m);
}

export function turnFiles(threadId, turnId) {
  try { return readManifest(threadId, turnId).files.map((f) => f.rel); } catch { return []; }
}

export function listTurns(threadId) {
  try {
    return fs.readdirSync(root(threadId)).sort().map((id) => { try { return readManifest(threadId, id); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// Restores the project to how it was before `turnId`: that turn and every later turn are undone,
// newest first. Returns the restored relative paths.
export function undoFrom(threadId, turnId) {
  const turns = listTurns(threadId).filter((m) => !m.undone && m.turnId >= turnId).reverse();
  if (!turns.length) throw new Error('nothing to undo for that turn');
  const restored = new Set();
  for (const m of turns) {
    for (const f of [...m.files].reverse()) {
      if (!inside(m.cwd, f.path) || f.rejected) continue; // a rejected file was already put back
      if (f.existed) {
        fs.mkdirSync(path.dirname(f.path), { recursive: true });
        fs.copyFileSync(path.join(root(threadId), m.turnId, f.backup), f.path);
      } else {
        try { fs.rmSync(f.path); } catch { /* already gone */ }
      }
      restored.add(f.rel);
    }
    m.undone = true;
    writeManifest(threadId, m);
  }
  return { turns: turns.map((m) => m.turnId), files: [...restored] };
}

// Net changes of a thread, per file: content before the first (still active) turn that touched it vs now.
export function threadChanges(threadId) {
  const byFile = new Map();
  for (const m of listTurns(threadId)) {
    if (m.undone) continue;
    for (const f of m.files) {
      if (f.rejected || byFile.has(f.path)) continue;
      let original = null;
      if (f.existed) { try { original = fs.readFileSync(path.join(root(threadId), m.turnId, f.backup), 'utf8'); } catch { original = ''; } }
      byFile.set(f.path, { rel: f.rel, path: f.path, existed: f.existed, original, since: m.turnId });
    }
  }
  return [...byFile.values()].map((c) => {
    let current = null;
    try { current = fs.readFileSync(c.path, 'utf8'); } catch { /* deleted */ }
    return { ...c, current };
  }).filter((c) => c.original !== c.current);
}

// Puts one file back as it was before the thread changed it, and marks it rejected in every active turn,
// so a later Undo of any of those turns cannot bring the rejected change back.
export function rejectFile(threadId, rel) {
  const turns = listTurns(threadId).filter((m) => !m.undone);
  let restored = false;
  for (const m of turns) {
    let touched = false;
    for (const f of m.files) {
      if (f.rel !== rel || f.rejected || !inside(m.cwd, f.path)) continue;
      if (!restored) {
        if (f.existed) { fs.mkdirSync(path.dirname(f.path), { recursive: true }); fs.copyFileSync(path.join(root(threadId), m.turnId, f.backup), f.path); }
        else { try { fs.rmSync(f.path); } catch { /* gone */ } }
        restored = true;
      }
      f.rejected = true; touched = true;
    }
    if (touched) writeManifest(threadId, m);
  }
  if (!restored) throw new Error('no change to reject for that file');
  return { file: rel };
}

export function deleteCheckpoints(threadId) { try { fs.rmSync(root(threadId), { recursive: true, force: true }); } catch { /* none */ } }
