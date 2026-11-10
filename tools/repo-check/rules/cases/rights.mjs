// cases.rights：catalog 里每个案例的权利字段与合规包的登记册计算一致（COMP-06、D02）。
// casebook.py 的 rights 命令是 tools/compliance/lib/rights.mjs computeInventory 的 Python 移植；本规则直接调用 JS 原版
// 交叉核对两边：每个登记类别涉及的案例集合相同；客户、第三方 IP、参考图、商标类整案命中（整个案例或成片用到）的案例是 internal，
// 其余是 public；客户与 IP 集中的分组（ppt-stories、ppt-keynote）每个案例都是 internal。只读，不跑 Python。
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
import { computeInventory, SENSITIVE_GROUPS } from '../../../compliance/lib/rights.mjs';

const INTERNAL_KINDS = new Set(['third-party-ip', 'client-material', 'reference-images', 'trademark']);
const HINT = '运行 node tools/env/py.mjs tools/casebook.py rights --write 按登记册重新生成；两边算法不一致时同步改 casebook.py 的 register_hits';

export default {
  id: 'cases.rights',
  title: 'catalog 的权利字段与授权登记册（合规包的 computeInventory）一致',
  run(ctx) {
    if (!ctx.exists('cases/catalog.json') || !ctx.exists('docs/rights/register.json')) return [];
    const catalog = ctx.readJson('cases/catalog.json');
    if ((catalog.schemaVersion ?? 1) < 2) return [{ level: 'warn', file: 'cases/catalog.json', message: 'catalog 还是第 1 版，没有权利字段', hint: HINT }];
    const register = ctx.readJson('docs/rights/register.json');
    const kinds = new Map(register.categories.map(c => [c.id, c.kind]));
    const inv = computeInventory(register, catalog, { root: ctx.root });
    const out = [];
    const expectInternal = new Set();
    for (const cat of inv.categories) {
      if (!cat.matched) continue;
      const want = new Set(cat.cases.map(c => c.id));
      const have = new Set(catalog.cases.filter(c => (c.rights?.register ?? []).includes(cat.id)).map(c => c.id));
      const missing = [...want].filter(id => !have.has(id));
      const extra = [...have].filter(id => !want.has(id));
      if (missing.length || extra.length) {
        out.push({ level: 'error', file: 'cases/catalog.json', message: `登记类别 ${cat.id} 的案例与登记册计算不一致：`
          + [missing.length ? `catalog 漏了 ${missing.join('、')}` : '', extra.length ? `catalog 多了 ${extra.join('、')}` : ''].filter(Boolean).join('；'), hint: HINT });
      }
      if (INTERNAL_KINDS.has(kinds.get(cat.id))) for (const c of cat.cases) if (c.how !== 'files') expectInternal.add(c.id);
    }
    for (const c of catalog.cases) {
      const clearance = c.rights?.clearance;
      const want = expectInternal.has(c.id) ? 'internal' : 'public';
      if (clearance !== want) out.push({ level: 'error', file: `cases/entries/${c.id}.md`, message: `${c.id} 的 rights.clearance 是 ${clearance ?? '（缺）'}，按登记册应为 ${want}`, hint: HINT });
      else if (SENSITIVE_GROUPS.includes(c.group) && clearance !== 'internal') out.push({ level: 'error', file: `cases/entries/${c.id}.md`, message: `${c.id} 属于客户与 IP 集中的分组 ${c.group}，却标为 ${clearance}`, hint: '在 docs/rights/register.json 补登记，再运行 rights --write' });
    }
    if (!out.length) {
      const internal = catalog.cases.filter(c => c.rights?.clearance === 'internal').length;
      out.push({ level: 'info', file: 'cases/catalog.json', message: `${inv.categories.filter(c => c.matched).length} 个登记类别与 catalog 一致；内部案例 ${internal} 个` });
    }
    return out;
  },
};
