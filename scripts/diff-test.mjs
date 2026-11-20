import { lineDiff } from '../server/diff.mjs';
const a = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj', b = 'a\nb\nC\nd\ne\nf\ng\nh\ni\nj\nk';
const d = lineDiff(a, b, 1); console.log(d.added, d.removed, JSON.stringify(d.hunks.map(h => h.map(o => o.t + o.text))));
console.log(JSON.stringify(lineDiff(null, 'x\ny').hunks), lineDiff('x', null).removed);
const big = Array.from({length: 3000}, (_, i) => 'line ' + i).join('\n'); const big2 = big.replace('line 1500', 'LINE 1500');
const t0 = Date.now(); const db = lineDiff(big, big2); console.log('3000 lines:', db.added, db.removed, (Date.now()-t0)+'ms');
