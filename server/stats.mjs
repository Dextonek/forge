// Aggregates the usage history (data/usage.jsonl) for the Usage page.
import { readUsage } from './store.mjs';

const blank = () => ({ cost: 0, ifOpus: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, turns: 0 });
function add(acc, rec) {
  acc.cost += rec.cost; acc.ifOpus += rec.ifOpus; acc.turns += 1;
  for (const d of Object.values(rec.perModel)) { acc.in += d.in; acc.out += d.out; acc.cacheRead += d.cacheRead; acc.cacheWrite += d.cacheWrite; }
  return acc;
}
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export function usageStats({ projects, threads }, days = 30) {
  const recs = readUsage();
  const now = Date.now();
  const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
  const totals = { today: blank(), week: blank(), month: blank(), all: blank() };
  const byDay = {}, byModel = {}, byProject = {}, byThread = {}, byTier = {}, byKind = {};

  for (const r of recs) {
    add(totals.all, r);
    if (r.t >= startToday.getTime()) add(totals.today, r);
    if (r.t >= now - 7 * 864e5) add(totals.week, r);
    if (r.t >= now - 30 * 864e5) add(totals.month, r);
    if (r.t >= now - days * 864e5) add((byDay[dayKey(r.t)] ??= blank()), r);
    add((byProject[r.projectId] ??= blank()), r);
    if (r.threadId) add((byThread[r.threadId] ??= blank()), r);
    add((byTier[r.tier] ??= blank()), r);
    add((byKind[r.kind] ??= blank()), r);
    for (const [model, d] of Object.entries(r.perModel)) {
      const m = (byModel[model] ??= { ...blank(), turns: 0 });
      m.cost += d.cost; m.in += d.in; m.out += d.out; m.cacheRead += d.cacheRead; m.cacheWrite += d.cacheWrite; m.turns += 1;
    }
  }

  // Fill missing days so the chart has a continuous axis.
  const series = [];
  for (let i = days - 1; i >= 0; i--) { const k = dayKey(now - i * 864e5); series.push({ day: k, ...(byDay[k] ?? blank()) }); }

  const pName = (id) => projects.find((p) => p.id === id)?.name ?? '(removed project)';
  const tInfo = (id) => threads.find((t) => t.id === id);
  return {
    totals,
    series,
    byModel: Object.entries(byModel).map(([model, v]) => ({ model, ...v })).sort((a, b) => b.cost - a.cost),
    byProject: Object.entries(byProject).map(([id, v]) => ({ id, name: pName(id), ...v })).sort((a, b) => b.cost - a.cost),
    byThread: Object.entries(byThread).map(([id, v]) => ({ id, title: tInfo(id)?.title ?? '(deleted thread)', project: pName(tInfo(id)?.projectId), exists: !!tInfo(id), ...v })).sort((a, b) => b.cost - a.cost).slice(0, 50),
    byTier: Object.entries(byTier).map(([tier, v]) => ({ tier, ...v })),
    byKind: Object.entries(byKind).map(([kind, v]) => ({ kind, ...v })),
    recent: recs.slice(-100).reverse().map((r) => ({ ...r, title: r.threadId ? (tInfo(r.threadId)?.title ?? '(deleted thread)') : 'Project brief', project: pName(r.projectId) })),
  };
}
