// 北冥仓库 · 授权登记册：docs/rights/register.json（人工登记）＋ cases/catalog.json（案例目录）→ docs/rights/register.md（生成）。
// 登记册的每一类写明权利方、授权方、授权范围、期限、书面证据存放位置与状态；用户没给的字段写「待补」，不推断、不编造。
// 本模块按每类的 match 规则从案例目录里算出受影响的案例、仓库内文件、Release 附件与预览，保证「找全」可复现。
// 接口：
//   loadRegister(root) → register（结构不对时抛错）
//   loadCatalog(root) → catalog
//   computeInventory(register, catalog) → { categories: [{ id, cases:[{id,title,group,how,files}], gitFiles, packs, previews, posters, artifacts }] }
//   renderRegister(register, inventory) → Markdown 文本（确定性：同样输入同样输出）
//   rightsReport({ root }) → { problems, stats }：登记册结构、生成物是否过期、客户与 IP 作品有没有漏登
// match 规则：
//   cases: [id]        整个案例受影响（全部文件、成片、预览、海报）
//   groups: [group]    该组全部案例受影响
//   files: [{ case: id|'*', path: 通配 }]   只有匹配的文件受影响；同一张图（同 sha256）出现在别的案例里也一并算上
//   text: [{ path: 通配, pattern: 正则 }]   仓库里的归档源码匹配到该文字的案例算「用到」（成片、预览、海报受影响）
//   uses: [id]         这些案例的成片用到了该类素材（成片、预览、海报受影响；源文件不列）
//   exclude: [{ case, path }]               从 files 的结果里去掉
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
import fs from 'node:fs';
import path from 'node:path';
import { globToRegExp } from './reuse.mjs';

export const PENDING = '待补';
export const STATUS = {
  'user-declared': '用户声明已获授权，书面证据待补',
  'unverified': '授权状态待用户确认',
  'license-known': '公开许可，按许可义务使用',
  'terms-check': '服务条款与套餐待核对',
  'own-work': '本项目作品，权利主体待补',
};
const REQUIRED = ['id', 'title', 'holder', 'licensor', 'scope', 'term', 'writtenEvidence', 'status', 'evidence', 'obligations', 'agentRule'];
export const REGISTER_JSON = 'docs/rights/register.json';
export const REGISTER_MD = 'docs/rights/register.md';
export const CATALOG = 'cases/catalog.json';
// 客户与第三方 IP 集中的分组：其中每个案例都必须被至少一类登记覆盖。
export const SENSITIVE_GROUPS = ['ppt-stories', 'ppt-keynote'];
const REFS_RE = /(^|\/)refs?\//i;

export function loadRegister(root) {
  const file = path.join(root, REGISTER_JSON);
  if (!fs.existsSync(file)) throw new Error(`缺少 ${REGISTER_JSON}`);
  const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (reg.schemaVersion !== 1 || !Array.isArray(reg.categories)) throw new Error(`${REGISTER_JSON} 要有 schemaVersion: 1 与 categories 数组`);
  const ids = new Set();
  for (const c of reg.categories) {
    for (const k of REQUIRED) if (c[k] == null || (typeof c[k] === 'string' && !c[k].trim())) throw new Error(`${REGISTER_JSON} 的 ${c.id || '某一类'} 缺字段 ${k}（不知道就写「${PENDING}」）`);
    if (!/^R\d{2}$/.test(c.id)) throw new Error(`${REGISTER_JSON}：编号 ${c.id} 应写成 R01 这样`);
    if (ids.has(c.id)) throw new Error(`${REGISTER_JSON}：编号 ${c.id} 重复`);
    ids.add(c.id);
    if (!STATUS[c.status]) throw new Error(`${REGISTER_JSON} 的 ${c.id}：status 只能是 ${Object.keys(STATUS).join(' / ')}`);
    if (!Array.isArray(c.evidence) || !c.evidence.length) throw new Error(`${REGISTER_JSON} 的 ${c.id}：evidence 至少写一条（证据位置）`);
  }
  return reg;
}

export function loadCatalog(root) {
  const file = path.join(root, CATALOG);
  if (!fs.existsSync(file)) throw new Error(`缺少 ${CATALOG}（案例目录）；如果案例库已拆成 cases/manifests/，需要同步更新本模块的读取方式`);
  const cat = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(cat.cases) || typeof cat.assets !== 'object') throw new Error(`${CATALOG} 结构变了：找不到 cases 数组或 assets 表`);
  return cat;
}

const uniqSorted = a => [...new Set(a)].sort((x, y) => x.localeCompare(y));

export function computeInventory(register, catalog, { root = null } = {}) {
  const byId = new Map(catalog.cases.map(c => [c.id, c]));
  const packOf = f => (f.asset ? (catalog.assets[f.asset] || {}).pack : null);
  const textCache = new Map();
  const readSource = rel => {
    if (!root) return '';
    if (textCache.has(rel)) return textCache.get(rel);
    let t = '';
    try { t = fs.readFileSync(path.join(root, 'cases', rel), 'utf8'); } catch { t = ''; }
    textCache.set(rel, t);
    return t;
  };
  const categories = [];
  for (const cat of register.categories) {
    const m = cat.match;
    if (!m) { categories.push({ id: cat.id, matched: false }); continue; }
    const hits = new Map();   // caseId → { how, files:Set }
    const mark = (id, how, file) => {
      const h = hits.get(id) || { how, files: new Set() };
      const rank = { whole: 3, uses: 2, files: 1 };
      if (rank[how] > rank[h.how]) h.how = how;
      if (file) h.files.add(file);
      hits.set(id, h);
    };
    for (const id of m.cases || []) if (byId.has(id)) mark(id, 'whole');
    for (const id of m.uses || []) if (byId.has(id)) mark(id, 'uses');
    for (const g of m.groups || []) for (const c of catalog.cases) if (c.group === g) mark(c.id, 'whole');
    const excl = (m.exclude || []).map(x => ({ case: x.case || '*', re: globToRegExp(x.path) }));
    const shas = new Set();
    for (const rule of m.files || []) {
      const re = globToRegExp(rule.path);
      for (const c of catalog.cases) {
        if (rule.case !== '*' && rule.case !== c.id) continue;
        for (const f of c.files) {
          if (!re.test(f.path)) continue;
          if (excl.some(x => (x.case === '*' || x.case === c.id) && x.re.test(f.path))) continue;
          mark(c.id, 'files', f.path);
          shas.add(f.sha256);
        }
      }
    }
    if (shas.size && m.propagate !== false) {
      for (const c of catalog.cases) for (const f of c.files) if (shas.has(f.sha256)) mark(c.id, 'files', f.path);
    }
    for (const rule of m.text || []) {
      const re = globToRegExp(rule.path), pat = new RegExp(rule.pattern, rule.flags || '');
      for (const c of catalog.cases) {
        if (hits.has(c.id) && hits.get(c.id).how === 'whole') continue;
        const f = c.files.find(f => f.source && re.test(f.path) && pat.test(readSource(f.source)));
        if (f) mark(c.id, 'uses', f.path);
      }
    }
    const cases = [], gitFiles = [], packs = [], previews = [], posters = [], artifacts = [];
    for (const [id, h] of [...hits].sort((a, b) => a[0].localeCompare(b[0]))) {
      const c = byId.get(id);
      const files = h.how === 'whole' ? c.files : c.files.filter(f => h.files.has(f.path));
      cases.push({ id, title: c.title, group: c.group, how: h.how, files: h.how === 'uses' ? 0 : files.length });
      if (h.how !== 'uses') for (const f of files) { if (f.source) gitFiles.push(`cases/${f.source}`); else if (packOf(f)) packs.push(packOf(f)); }
      if (h.how !== 'files') {
        for (const a of c.artifacts || []) { if (a.pack) packs.push(a.pack); artifacts.push(`${a.pack}:${a.member || a.filename}`); }
        if (c.preview && c.preview.filename) previews.push(c.preview.filename);
        if (c.poster) posters.push(`cases/${c.poster}`);
      }
    }
    categories.push({ id: cat.id, matched: true, cases, gitFiles: uniqSorted(gitFiles), packs: uniqSorted(packs), previews: uniqSorted(previews),
      posters: uniqSorted(posters), artifacts: uniqSorted(artifacts) });
  }
  return { release: catalog.release || null, categories };
}

const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const HOW = { whole: '整个案例', files: '部分文件', uses: '成片用到' };

export function renderRegister(register, inv) {
  const L = [];
  const inventoryOf = id => inv.categories.find(c => c.id === id) || { matched: false };
  L.push('# 授权与权利登记册', '');
  L.push(`> 本页由 \`node tools/compliance/rights-inventory.mjs --write\` 从 [register.json](register.json) 与 \`cases/catalog.json\` 生成，**不要手改**：改登记内容请改 register.json，再重新生成；\`--check\` 核对本页是否过期（规范检查 \`comp.rights-register\` 也会查）。登记日期：${register.updated}。`, '');
  const st = register.statement;
  L.push('## 登记口径', '');
  L.push(`- **用户声明**（${st.date}）：「${st.text}」。记录于 ${st.recordedIn}。`);
  L.push(`- 字段写「${PENDING}」表示用户还没有提供，**不推断、不编造**；合同与授权书正文不进仓库，只登记存放位置。`);
  L.push('- 「仓库内自述」是历史文件自己写的口径，只作线索，不等于授权范围；与授权范围冲突时以书面授权为准，书面授权补齐前按更严的口径执行。');
  L.push('- **授权不等于可以复用**：登记在册的第三方与客户素材只用于登记所列的作品；要用到新作品、模版、作品站新页面或其他对外物料，先在本册对应条目写明授权范围覆盖该用途，否则不用。');
  L.push(`- 受影响清单按 \`cases/catalog.json\`（Release \`${inv.release || '—'}\`）计算：「整个案例」= 全部文件、成片、预览与海报；「部分文件」= 只有列出的文件（同一张图出现在别的案例里也算上）；「成片用到」= 成片、预览与海报。`);
  L.push('');
  L.push('## 一览', '');
  L.push('| 编号 | 类别 | 权利方 | 授权方 | 授权范围 | 期限 | 书面证据 | 状态 | 受影响案例 |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const c of register.categories) {
    const iv = inventoryOf(c.id);
    L.push(`| ${c.id} | ${esc(c.title)} | ${esc(c.holder)} | ${esc(c.licensor)} | ${esc(c.scope)} | ${esc(c.term)} | ${esc(c.writtenEvidence)} | ${STATUS[c.status]} | ${iv.matched ? iv.cases.length : '—'} |`);
  }
  L.push('');
  for (const c of register.categories) {
    const iv = inventoryOf(c.id);
    L.push(`## ${c.id} ${c.title}`, '');
    L.push(`- **权利方**：${c.holder}${c.holderBasis ? `（依据：${c.holderBasis}）` : ''}`);
    L.push(`- **授权方**：${c.licensor}`);
    L.push(`- **授权范围**：${c.scope}`);
    if (c.scopeNotes) L.push(`- **仓库内自述（不等于授权范围）**：${c.scopeNotes}`);
    L.push(`- **期限**：${c.term}`);
    L.push(`- **书面证据存放位置**：${c.writtenEvidence}`);
    L.push(`- **状态**：${STATUS[c.status]}${c.statusNote ? `；${c.statusNote}` : ''}`);
    L.push('- **证据位置**：');
    for (const e of c.evidence) L.push(`  - ${e}`);
    L.push(`- **义务与做法**：${c.obligations}`);
    L.push(`- **agent 规则**：${c.agentRule}`);
    if (c.distribution) L.push(`- **对外分发点**：${c.distribution}`);
    if (c.gitPaths && c.gitPaths.length) L.push(`- **仓库主体里的相关文件**：${c.gitPaths.map(p => `\`${p}\``).join('、')}`);
    if (iv.matched) {
      L.push('', `**受影响案例（${iv.cases.length}）**`, '');
      if (iv.cases.length) {
        L.push('| 案例 | 标题 | 分组 | 受影响范围 | 文件数 |', '|---|---|---|---|---|');
        for (const k of iv.cases) L.push(`| \`${k.id}\` | ${esc(k.title)} | ${k.group} | ${HOW[k.how]} | ${k.how === 'uses' ? '—' : k.files} |`);
      }
      L.push('');
      L.push(`- **Release 附件（${inv.release || '—'}）**：${iv.packs.length ? iv.packs.map(p => `\`${p}\``).join('、') : '无'}`);
      L.push(`- **Release 预览（${iv.previews.length}）**：${iv.previews.length ? iv.previews.map(p => `\`${p}\``).join('、') : '无'}`);
      if (iv.artifacts.length) L.push(`- **成片（包内路径，${iv.artifacts.length}）**：${iv.artifacts.map(p => `\`${p}\``).join('、')}`);
      L.push(`- **仓库内的海报（${iv.posters.length}）**：${iv.posters.length ? iv.posters.map(p => `\`${p}\``).join('、') : '无'}`);
      L.push(`- **仓库内的归档源文件**：${iv.gitFiles.length} 个${iv.gitFiles.length ? `（如 \`${iv.gitFiles[0]}\`；完整清单用 \`node tools/compliance/rights-inventory.mjs --json\`）` : ''}`);
    }
    L.push('');
  }
  L.push('## 怎么更新', '');
  L.push('1. 用户补来授权信息：改 `docs/rights/register.json` 对应字段（权利方、授权方、范围、期限、书面证据存放位置），把 status 改成相应状态。');
  L.push('2. 新增第三方或客户素材：先在 register.json 加一类或扩展 match，再入库或发布。');
  L.push('3. 重新生成并核对：`node tools/compliance/rights-inventory.mjs --write`，然后 `node tools/compliance/rights-inventory.mjs --check`。');
  L.push('');
  return L.join('\n');
}

export function rightsReport({ root }) {
  const problems = [];
  const err = (file, message, hint, level = 'error') => problems.push({ level, file, message, hint });
  let reg, cat;
  try { reg = loadRegister(root); } catch (e) { err(REGISTER_JSON, e.message, '照 docs/rights/README.md 的字段说明修好 register.json'); return { problems, stats: null }; }
  try { cat = loadCatalog(root); } catch (e) { err(CATALOG, e.message, '案例目录读不出来时先修目录；目录换了格式要同步改 tools/compliance/lib/rights.mjs'); return { problems, stats: null }; }
  const inv = computeInventory(reg, cat, { root });
  const md = renderRegister(reg, inv);
  const mdPath = path.join(root, REGISTER_MD);
  const cur = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8').replace(/\r\n/g, '\n') : null;
  if (cur == null) err(REGISTER_MD, `${REGISTER_MD} 不存在`, '运行 node tools/compliance/rights-inventory.mjs --write 生成');
  else if (cur !== md) err(REGISTER_MD, `${REGISTER_MD} 与 register.json / 案例目录不一致（过期了）`, '运行 node tools/compliance/rights-inventory.mjs --write 重新生成并提交');
  for (const c of inv.categories) if (c.matched && !c.cases.length) err(REGISTER_JSON, `${c.id} 的 match 规则一个案例都没匹配上`, '检查案例 id 与路径通配是否写错');
  // 客户与 IP 集中的分组、所有参考图都必须登记
  const covered = new Set(inv.categories.flatMap(c => (c.cases || []).map(k => k.id)));
  for (const c of cat.cases) if (SENSITIVE_GROUPS.includes(c.group) && !covered.has(c.id)) err(REGISTER_JSON, `案例 ${c.id}（${c.group}）含客户或第三方 IP 素材，却不在任何登记类别里`, '在 register.json 里把它归入对应类别（客户、IP、委托方待补等）');
  const refCovered = new Set(inv.categories.flatMap(c => (c.cases || []).filter(k => k.how !== 'uses').map(k => k.id)));
  for (const c of cat.cases) if (c.files.some(f => REFS_RE.test(f.path)) && !refCovered.has(c.id)) err(REGISTER_JSON, `案例 ${c.id} 有 refs/ 参考图，却不在任何登记类别里`, '在 register.json 的参考图类别里加上它');
  for (const c of reg.categories) for (const p of c.gitPaths || []) {
    const base = p.replace(/\/\*\*$/, '');
    if (!fs.existsSync(path.join(root, base))) err(REGISTER_JSON, `${c.id} 登记的仓库路径不存在：${p}`, '路径改名或删除后同步改 register.json');
  }
  const pending = reg.categories.reduce((n, c) => n + ['holder', 'licensor', 'scope', 'term', 'writtenEvidence'].filter(k => String(c[k]).includes(PENDING)).length, 0);
  if (pending) err(REGISTER_MD, `授权登记册还有 ${pending} 个字段待补（权利方、授权方、范围、期限、书面证据）`, '向用户索取后改 docs/rights/register.json；不得自行推断', 'warn');
  return { problems, stats: { categories: reg.categories.length, pending, cases: covered.size }, inventory: inv, markdown: md };
}
