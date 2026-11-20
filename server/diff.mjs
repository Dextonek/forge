// Small line diff (LCS) producing unified-style hunks, for the Changes tab and approval cards.
const MAX_CELLS = 6_000_000; // ~2450x2450 lines; larger files get a summary instead

export function lineDiff(before, after, context = 3) {
  const a = before == null ? [] : String(before).split(/\r?\n/);
  const b = after == null ? [] : String(after).split(/\r?\n/);
  // Trim common prefix/suffix first: most edits touch a small part of a file.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf), Bm = b.slice(pre, b.length - suf);
  const n = A.length, m = Bm.length;
  if ((n + 1) * (m + 1) > MAX_CELLS) return { tooLarge: true, added: m, removed: n, hunks: [] };

  // LCS table (lengths), then walk it to produce operations.
  const W = m + 1, L = new Uint32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    L[i * W + j] = A[i] === Bm[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
  }
  const ops = [];
  for (let k = 0; k < pre; k++) ops.push({ t: ' ', text: a[k], o: k + 1, n: k + 1 });
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === Bm[j]) { ops.push({ t: ' ', text: A[i], o: pre + i + 1, n: pre + j + 1 }); i++; j++; }
    else if (i < n && (j >= m || L[(i + 1) * W + j] >= L[i * W + j + 1])) { ops.push({ t: '-', text: A[i], o: pre + i + 1 }); i++; } // removals first
    else { ops.push({ t: '+', text: Bm[j], n: pre + j + 1 }); j++; }
  }
  for (let k = 0; k < suf; k++) ops.push({ t: ' ', text: a[a.length - suf + k], o: a.length - suf + k + 1, n: b.length - suf + k + 1 });

  // Group into hunks with context.
  const hunks = [];
  let cur = null, lastChange = -Infinity;
  ops.forEach((op, idx) => {
    if (op.t === ' ') return;
    if (!cur || idx - lastChange > context * 2) {
      cur = { from: Math.max(0, idx - context), to: idx };
      hunks.push(cur);
    }
    cur.to = idx; lastChange = idx;
  });
  const out = hunks.map((h) => ops.slice(h.from, Math.min(ops.length, h.to + context + 1)).map((op) => ({ ...op, text: op.text.length > 400 ? op.text.slice(0, 400) + '…' : op.text })));
  return { added: ops.filter((o) => o.t === '+').length, removed: ops.filter((o) => o.t === '-').length, hunks: out };
}
