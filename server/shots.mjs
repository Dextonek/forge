// Screenshots (verify, pick, playtest) are stored as files, not inside the chat log.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, newId } from './store.mjs';

const dir = (threadId) => path.join(DATA_DIR, 'shots', threadId);

// Saves a data-URL JPEG; returns the file name, or null.
export function saveShot(threadId, dataUrl) {
  const m = /^data:image\/(jpeg|png);base64,(.+)$/.exec(dataUrl ?? '');
  if (!m) return null;
  fs.mkdirSync(dir(threadId), { recursive: true });
  const file = `${Date.now()}-${newId()}.${m[1] === 'png' ? 'png' : 'jpg'}`;
  fs.writeFileSync(path.join(dir(threadId), file), Buffer.from(m[2], 'base64'));
  return file;
}
export const shotUrl = (threadId, file) => (file ? `/api/shots/${threadId}/${file}` : null);

export function readShot(threadId, file) {
  if (!/^[\w-]+\.(jpg|png)$/.test(file)) return null; // no paths
  try { return fs.readFileSync(path.join(dir(threadId), file)); } catch { return null; }
}
export function deleteShots(threadId) { try { fs.rmSync(dir(threadId), { recursive: true, force: true }); } catch { /* none */ } }
