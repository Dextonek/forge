// Unit test for checkpoints: reject a file, then undo a later turn; the rejected change must not come back.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
process.env.FORGE_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ck-'));
const { beginTurn, backupFile, rejectFile, undoFrom, threadChanges } = await import('../server/checkpoints.mjs');

const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-proj-'));
const f = path.join(proj, 'a.js'), g = path.join(proj, 'b.js');
fs.writeFileSync(f, 'v1'); fs.writeFileSync(g, 'g1');
const th = 'test';
const t1 = beginTurn(th, proj); backupFile(th, t1, proj, f); fs.writeFileSync(f, 'v2'); backupFile(th, t1, proj, g); fs.writeFileSync(g, 'g2');
await new Promise((r) => setTimeout(r, 5));
const t2 = beginTurn(th, proj); backupFile(th, t2, proj, f); fs.writeFileSync(f, 'v3');
const ok = (c, msg) => console.log(c ? 'PASS' : 'FAIL', msg);

ok(threadChanges(th).map((c) => `${c.rel}:${c.original}->${c.current}`).join(',') === 'a.js:v1->v3,b.js:g1->g2', 'changes list shows net change per file');
rejectFile(th, 'a.js');
ok(fs.readFileSync(f, 'utf8') === 'v1', 'reject restores the original');
ok(threadChanges(th).map((c) => c.rel).join(',') === 'b.js', 'rejected file leaves the changes list');
undoFrom(th, t2); // turn 2 only touched a.js, which is rejected
ok(fs.readFileSync(f, 'utf8') === 'v1', 'undoing a later turn does not bring the rejected change back (stays v1, not v2)');
undoFrom(th, t1);
ok(fs.readFileSync(g, 'utf8') === 'g1' && fs.readFileSync(f, 'utf8') === 'v1', 'undoing turn 1 still restores the other file');
