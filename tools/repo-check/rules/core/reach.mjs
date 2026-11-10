// core.reach：从 AGENTS.md 出发，沿 Markdown 相对链接不超过 3 跳能到达注册表里的每份路线手册（北极星验收 1）。
// 只沿 .md 链接走（不进 cases/ 的归档与快照）；找不到时报出已知的最短路径，方便补链接。
import path from 'node:path';

export const MAX_HOPS = 3;
const START = 'AGENTS.md';

function neighbours(ctx, f) {
  return ctx.memo(`reach:${f}`, () => {
    const out = new Set();
    let text;
    try { text = ctx.read(f); } catch { return out; }
    for (const l of ctx.md.links(text)) {
      const t = l.target.split('#')[0].split('?')[0];
      if (!t || /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(t)) continue;
      let dec = t;
      try { dec = decodeURIComponent(t); } catch { /* 原样 */ }
      const rel = dec.startsWith('/') ? path.posix.normalize(dec.slice(1)) : path.posix.normalize(path.posix.join(path.posix.dirname(f), dec));
      if (rel.startsWith('..') || !rel.toLowerCase().endsWith('.md') || rel.startsWith('cases/')) continue;
      if (ctx.exists(rel)) out.add(rel);
    }
    return out;
  });
}

export default {
  id: 'core.reach',
  title: `从 AGENTS.md 出发 ${MAX_HOPS} 跳内能到达三份路线手册`,
  run(ctx) {
    const reg = ctx.registry.registry;
    if (!reg) return [];
    if (!ctx.exists(START)) return [{ level: 'error', file: START, message: 'AGENTS.md 不存在：agent 没有入口', hint: '恢复 AGENTS.md' }];
    const dist = new Map([[START, 0]]);
    const prev = new Map();
    const queue = [START];
    while (queue.length) {
      const f = queue.shift();
      const d = dist.get(f);
      if (d >= 8) continue;
      for (const n of neighbours(ctx, f)) if (!dist.has(n)) { dist.set(n, d + 1); prev.set(n, f); queue.push(n); }
    }
    const pathTo = f => { const p = [f]; while (prev.has(p[0])) p.unshift(prev.get(p[0])); return p.join(' → '); };
    const out = [];
    const ok = [];
    for (const r of reg.routes) {
      const d = dist.get(r.manual);
      if (d !== undefined && d <= MAX_HOPS) { ok.push(`${r.id} ${d} 跳`); continue; }
      out.push({
        level: 'error', file: START,
        message: d === undefined ? `从 AGENTS.md 沿链接到不了 ${r.manual}` : `到 ${r.manual} 要 ${d} 跳（${pathTo(r.manual)}），超过 ${MAX_HOPS} 跳`,
        hint: 'AGENTS.md 直接链到 routes/README.md，routes/README.md 再链到三份手册',
        excerpt: r.manual,
      });
    }
    if (!out.length) out.push({ level: 'info', message: `三份手册：${ok.join('、')}（${pathTo(reg.routes[0].manual)}）` });
    return out;
  },
};
