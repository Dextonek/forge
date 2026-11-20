// Checks the probe channel end to end without a model: connects as the server would, asks the open
// game page for a screenshot, and reports whether the image is blank. Usage: node scripts/probe-shot-test.mjs <threadId>
// (Runs its own tiny client against the test server's internal module; needs the game open in the Play tab.)
import fs from 'node:fs';
const [threadId] = process.argv.slice(2);
const port = Number(process.env.FORGE_PORT ?? 4317);
const r = await fetch(`http://127.0.0.1:${port}/api/threads/${threadId}/shot`, { method: 'POST', headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' }, body: '{}' });
const j = await r.json();
if (!j.image) { console.log('NO IMAGE:', JSON.stringify(j)); process.exit(1); }
const buf = Buffer.from(j.image.split(',')[1], 'base64');
fs.writeFileSync(process.argv[3] ?? 'shot.jpg', buf);
console.log(`image ${j.w}x${j.h}, ${buf.length} bytes, canvas ${j.canvas}`);
