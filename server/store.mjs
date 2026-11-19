// Tiny JSON persistence. State lives in ./data next to the app, never inside a game project.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// The desktop app sets FORGE_DATA to its per-user folder; `npm start` uses ./data next to the code.
export const DATA_DIR = path.resolve(process.env.FORGE_DATA ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data'));
const STATE_FILE = path.join(DATA_DIR, 'state.json');
fs.mkdirSync(path.join(DATA_DIR, 'threads'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'briefs'), { recursive: true });

export const newId = () => crypto.randomBytes(5).toString('hex');

let state = { projects: [], threads: [] };
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* first run */ }

// Written immediately (the file is small): a desktop app can be closed or killed at any moment.
export function save() {
  fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state, null, 2));
  fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
}
export const getState = () => state;

// Per-thread event log (what the UI renders), one JSON object per line.
const logPath = (threadId) => path.join(DATA_DIR, 'threads', `${threadId}.jsonl`);
export function appendEvent(threadId, ev) {
  fs.appendFileSync(logPath(threadId), JSON.stringify(ev) + '\n');
}
export function readEvents(threadId) {
  try {
    return fs.readFileSync(logPath(threadId), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

// Usage history: one record per turn (and per brief), kept even when a thread is deleted.
const USAGE_FILE = path.join(DATA_DIR, 'usage.jsonl');
export function appendUsage(rec) { fs.appendFileSync(USAGE_FILE, JSON.stringify(rec) + '\n'); }
export function readUsage() {
  try { return fs.readFileSync(USAGE_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
export function deleteThreadLog(threadId) { try { fs.rmSync(logPath(threadId)); } catch { /* none */ } }

export const briefPath =(projectId) => path.join(DATA_DIR, 'briefs', `${projectId}.md`);
export function readBrief(projectId) {
  try { return fs.readFileSync(briefPath(projectId), 'utf8'); } catch { return null; }
}
