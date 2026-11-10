#!/usr/bin/env node
// 北冥引擎 · 共享资产注册表（T02；差距 ORCH-15）：造型、角色、材质、底板、字体、风格参考都有稳定的资产 id 与 sha256。
// film.json 的 assets 只写资产 id，校验器（engine/production/film.js）用这里核对存在与哈希；渲染缓存键用 assetFingerprint。
// 文件位置不动（造型与角色仍在 src/，底板在 assets/plates/，字体在 fonts/）；这里只登记，不另起 assets/index.json。
//
// 资产 id：<种类>:<名字>[@v<版本>]
//   model:kun  model:kun_qinglv …   3D 造型（JS 模块）        character:girl  character:birds   2D 角色（JS 模块）
//   material:toon …                 卡通着色材质（JS 模块）   plate:sky_dawn …                  2D 底板（取自 assets/plates/plates.json）
//   font:noto-sans-sc …             字体子集                  ref:sky_test                      风格参考图
//   local:<作品目录里的相对路径>     作品自带的文件（不进注册表，只核对存在）
//   只写名字（kun@v1）时按名字在注册表里找，唯一才算数。
// JS 模块的哈希覆盖它在 src/ 里的相对 import 闭包（例如 model:kun = src/kun.js + toon.js + shadow.js + eye_shade.js）；
// engine/ 的模块不计入（引擎版本由运行记录的 sourceCommit 表达）。文本文件把 CRLF 当 LF 算，Windows 检出与 macOS 得到同一个哈希。
//
// 库接口：
//   loadRegistry({ root })                    → { assets: Map<id, entry>, byName, problems }
//   resolveAsset(ref, registry)               → { id, kind, name, version, entry } | { error, message, hint }
//   hashAsset(entry, { root })                → { sha256, files: [{ path, sha256, size }] }（文件缺失时抛 AssetError）
//   checkAssets(refs, { root, filmDir, lock }) → { ok, diagnostics, resolved }：不认识 / 版本不对 / 文件缺失判错，哈希与锁文件不符只提示
//   assetFingerprint(refs, opts)              → 所用资产哈希的总指纹（缓存键材料）
//   readLock() / buildLock()                  锁文件 engine/assets/assets.lock.json
// 命令行（tools/lib/cli.mjs，docs/CLI.md：0 通过、2 用法错误、4 不认识或缺文件、1 运行失败；--json 的结果在 data）：
//   node engine/assets/manifest.js list [--kind <种类>] [--json]
//   node engine/assets/manifest.js check [<资产 id>…] [--film <作品目录>] [--strict] [--json]
//   node engine/assets/manifest.js lock [--write] [--json]
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, defineCommand, isMain, runCli, suggest } from '../../tools/lib/cli.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '../..');
export const LOCK_FILE = join(HERE, 'assets.lock.json');
export const KINDS = Object.freeze(['model', 'character', 'material', 'plate', 'font', 'ref', 'local']);
export const ASSET_REF = /^(?:([a-z]+):)?([A-Za-z0-9][A-Za-z0-9._/-]*)(?:@v?(\d+))?$/;
const TEXT_EXT = /\.(js|mjs|json|md|txt|glsl|svg|css|html)$/i;

// 权利口径取自仓库 LICENSE：src/ 等处的原创代码是 MIT；影片《北冥》的画面与底板图（assets/）保留所有权利；字体是 OFL-1.1。
// AI 生成素材的来源与授权登记在 docs/rights/（决策 D02），没登记的写「待补」，不编造。
const PLATE_RIGHTS = '保留所有权利（LICENSE）；AI 生成来源的权利登记待补（docs/rights/）';
const CODE_RIGHTS = 'MIT（代码，LICENSE）';
const OWN = '北冥引擎 Beiming Engine';

/** 手工登记的部分（底板从 assets/plates/plates.json 读，见 loadRegistry）。 */
const STATIC = [
  { id: 'model:kun', name: '鲲（《北冥》正片版：三渲二卡通着色、背上海草森林）', module: 'src/kun.js', usedBy: ['films/beiming-10s'] },
  { id: 'model:kun_qinglv', name: '青绿仙山鲲（作品站首屏实时渲染）', module: 'src/kun_qinglv.js', usedBy: ['site/'] },
  { id: 'model:kun_bronze', name: '青铜古鲲（自测页 ?test=kun_bronze）', module: 'src/kun_bronze.js' },
  { id: 'model:kun_peng', name: '鲲鹏（自测页 ?test=kun_peng）', module: 'src/kun_peng.js' },
  { id: 'model:kun_refine', name: '精修鲲（自测页 ?test=kun_refine）', module: 'src/kun_refine.js' },
  { id: 'model:kun_xuan', name: '玄鲲（自测页 ?test=kun_xuan）', module: 'src/kun_xuan.js' },
  { id: 'model:ferry', name: '渡船（红绿航行灯、甲板）', module: 'src/ferry.js', usedBy: ['films/beiming-10s'] },
  { id: 'character:girl', name: '女孩（2D 手绘路径，一拍二，镜头 B）', module: 'src/girl.js', usedBy: ['films/beiming-10s'] },
  { id: 'character:birds', name: '鸽群（被汽笛惊起，镜头 A）', module: 'src/birds.js', usedBy: ['films/beiming-10s'] },
  { id: 'material:toon', name: '卡通着色（三档色阶、背光边缘光、锈斑）', module: 'src/toon.js' },
  { id: 'material:toon_qinglv', name: '青绿山水着色', module: 'src/toon_qinglv.js', usedBy: ['site/'] },
  { id: 'material:toon_bronze', name: '青铜着色', module: 'src/toon_bronze.js' },
  { id: 'material:toon_peng', name: '鲲鹏着色', module: 'src/toon_peng.js' },
  { id: 'material:toon_refine', name: '精修着色', module: 'src/toon_refine.js' },
  { id: 'material:toon_xuan', name: '玄鲲着色', module: 'src/toon_xuan.js' },
  { id: 'font:noto-sans-sc', name: 'Noto Sans SC 可变字重子集（显示层中文）', files: ['fonts/NotoSansSC-var.woff2'], license: 'OFL-1.1', owner: 'Adobe / Google', source: 'fonts/LICENSE.md' },
  { id: 'font:barlow', name: 'Barlow 300 / 400 / 500 子集（显示层数字）', files: ['fonts/Barlow-300.woff2', 'fonts/Barlow-400.woff2', 'fonts/Barlow-500.woff2'], license: 'OFL-1.1', owner: 'The Barlow Project Authors', source: 'fonts/LICENSE.md' },
  { id: 'font:ma-shan-zheng', name: '马善政毛笔楷书子集（片名「北」「冥」）', files: ['fonts/MaShanZheng-400.woff2'], license: 'OFL-1.1', owner: 'The Ma Shan Zheng Project Authors', source: 'fonts/LICENSE.md' },
  { id: 'ref:sky_test', name: '底板共用的风格参考图（带 C2PA 信息）', files: ['assets/ref/sky_test.png'], license: PLATE_RIGHTS, owner: OWN, source: 'assets/plates/plates.json「生成」' },
];

export class AssetError extends Error {
  constructor(code, message, { hint = '', exitCode = 4 } = {}) {
    super(message);
    this.name = 'AssetError';
    this.code = code;
    this.hint = hint;
    this.exitCode = exitCode;
  }
}

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha = buf => createHash('sha256').update(buf).digest('hex');

function readJson(path) {
  const text = readFileSync(path, 'utf8');
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

/** 注册表：手工登记 + plates.json 的底板。读不出 plates.json 时登记一条问题，不抛错。 */
export function loadRegistry({ root = REPO_ROOT } = {}) {
  const assets = new Map(), problems = [];
  const add = e => {
    const entry = { version: 1, license: e.license ?? (e.module ? CODE_RIGHTS : PLATE_RIGHTS), owner: e.owner ?? OWN, source: e.source ?? e.module ?? e.files?.[0], ...e };
    entry.kind = entry.id.split(':')[0];
    entry.name = entry.name ?? entry.id;
    if (assets.has(entry.id)) problems.push(`资产 id 重复：${entry.id}`);
    assets.set(entry.id, entry);
  };
  STATIC.forEach(add);
  const platesFile = join(root, 'assets', 'plates', 'plates.json');
  try {
    const doc = readJson(platesFile);
    for (const p of doc.plates ?? []) {
      if (!p?.name || !p?.file) { problems.push(`plates.json 有条目缺 name / file：${JSON.stringify(p).slice(0, 80)}`); continue; }
      add({ id: `plate:${p.name}`, name: p['用途'] ? `${p.name}：${String(p['用途']).split('：')[0].slice(0, 40)}` : p.name, files: [`assets/plates/${p.file}`],
        license: PLATE_RIGHTS, owner: `${OWN}（AI 生成后手工整理）`, source: 'assets/plates/plates.json', shots: Array.isArray(p['镜头']) ? p['镜头'] : undefined });
    }
  } catch (error) {
    problems.push(`读不出 assets/plates/plates.json（${error.code ?? error.message}）：底板没有登记`);
  }
  const byName = new Map();
  for (const e of assets.values()) {
    const n = e.id.split(':')[1];
    byName.set(n, [...(byName.get(n) ?? []), e.id]);
  }
  return { assets, byName, problems, root };
}

/** 资产引用 → 注册表条目。local: 不查注册表。 */
export function resolveAsset(ref, registry) {
  const m = typeof ref === 'string' ? ASSET_REF.exec(ref.trim()) : null;
  if (!m) return { error: 'asset-id-invalid', message: `资产 id 写成「种类:名字@v版本」，收到 ${JSON.stringify(ref)}`, hint: `种类：${KINDS.join(' / ')}` };
  const [, kind, name, ver] = m;
  const version = ver === undefined ? null : Number(ver);
  if (kind === 'local') return { id: `local:${name}`, kind, name, version, entry: null };
  if (kind && !KINDS.includes(kind)) return { error: 'asset-kind-unknown', message: `不认识的资产种类 ${kind}`, hint: `种类：${KINDS.join(' / ')}` };
  if (name.includes('/')) return { error: 'asset-id-invalid', message: `注册表资产的名字不含斜杠：${ref}`, hint: '作品自带的文件写 local:<相对路径>' };
  let id = kind ? `${kind}:${name}` : null;
  if (!id) {
    const hits = registry.byName.get(name) ?? [];
    if (hits.length !== 1) return { error: hits.length ? 'asset-ambiguous' : 'asset-unknown', message: hits.length ? `资产名 ${name} 对应多个资产：${hits.join('、')}` : `注册表里没有资产 ${name}`, hint: hits.length ? '写全种类，例如 model:kun@v1' : '看 node engine/assets/manifest.js list' };
    id = hits[0];
  }
  const entry = registry.assets.get(id);
  if (!entry) {
    const near = [...registry.assets.keys()].filter(k => k.endsWith(`:${name}`) || k.startsWith(`${kind}:`)).slice(0, 6);
    return { error: 'asset-unknown', message: `注册表里没有资产 ${id}`, hint: near.length ? `相近的：${near.join('、')}；全部见 node engine/assets/manifest.js list` : '共享资产先在 engine/assets/manifest.js 登记；作品自带的文件写 local:<相对路径>' };
  }
  if (version !== null && version !== entry.version) return { error: 'asset-version-unknown', message: `${id} 只有 v${entry.version}，没有 v${version}`, hint: `写 ${id}@v${entry.version}` };
  return { id, kind: entry.kind, name, version: entry.version, entry };
}

/** JS 模块在 src/ 里的相对 import 闭包（只认静态 import / export … from './x.js'）。 */
export function moduleClosure(module, { root = REPO_ROOT } = {}) {
  const seen = new Set(), order = [];
  const visit = rel => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const abs = join(root, ...rel.split('/'));
    if (!existsSync(abs)) throw new AssetError('asset-file-missing', `资产文件不存在：${rel}`, { hint: '文件被移动或删除了：恢复它，或改注册表（engine/assets/manifest.js）' });
    order.push(rel);
    const text = readFileSync(abs, 'utf8');
    for (const m of text.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]/gm)) {
      const dep = posix.normalize(posix.join(posix.dirname(rel), m[1]));
      if (dep.startsWith('src/')) visit(dep);
    }
  };
  visit(module);
  return order.sort();
}

export function filesOf(entry, { root = REPO_ROOT } = {}) {
  return entry.module ? moduleClosure(entry.module, { root }) : [...(entry.files ?? [])].sort();
}

export function hashAsset(entry, { root = REPO_ROOT } = {}) {
  const files = filesOf(entry, { root }).map(rel => {
    const abs = join(root, ...rel.split('/'));
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new AssetError('asset-file-missing', `资产 ${entry.id} 的文件不存在：${rel}`, { hint: '恢复文件，或改注册表' });
    let buf = readFileSync(abs);
    if (TEXT_EXT.test(rel)) buf = Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
    return { path: rel, sha256: sha(buf), size: buf.length };
  });
  return { sha256: sha(files.map(f => `${f.path}\0${f.sha256}`).join('\n')), files };
}

export function readLock(file = LOCK_FILE) {
  if (!existsSync(file)) return null;
  try { return readJson(file); } catch (error) { throw new AssetError('lock-invalid', `资产锁文件读不出来：${error.message}`, { exitCode: 1, hint: '重新生成：node engine/assets/manifest.js lock --write' }); }
}

export function buildLock({ root = REPO_ROOT } = {}) {
  const reg = loadRegistry({ root });
  const assets = {};
  for (const e of [...reg.assets.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const h = hashAsset(e, { root });
    assets[`${e.id}@v${e.version}`] = { sha256: h.sha256, files: Object.fromEntries(h.files.map(f => [f.path, f.sha256])) };
  }
  return { schemaVersion: 1, $comment: '共享资产的 sha256（engine/assets/manifest.js 生成：node engine/assets/manifest.js lock --write）。资产文件改了而这里没更新时，film.js check 提示「资产哈希变化」：依赖它的镜头缓存失效，用户认可过的风格帧要复核。', assets };
}

/**
 * 核对一组资产引用。filmDir 给出时 local: 按作品目录核对存在。
 * @returns {{ ok: boolean, diagnostics: Array<{ level, code, path, message, hint }>, resolved: Array<{ ref, id, sha256, files }> }}
 */
export function checkAssets(refs, { root = REPO_ROOT, filmDir = null, lock = undefined, registry = null, path = 'assets' } = {}) {
  const reg = registry ?? loadRegistry({ root });
  const lk = lock === undefined ? readLock() : lock;
  const diagnostics = [], resolved = [];
  const push = (level, code, p, message, hint = '') => diagnostics.push({ level, code, path: p, message, hint });
  for (const pr of reg.problems) push('warning', 'asset-registry', 'engine/assets', pr);
  (Array.isArray(refs) ? refs : []).forEach((ref, i) => {
    const p = `${path}[${i}]`;
    const r = resolveAsset(ref, reg);
    if (r.error) { push('error', r.error, p, r.message, r.hint); return; }
    if (r.kind === 'local') {
      const n = posix.normalize(r.name);
      if (n.startsWith('../') || n.startsWith('/')) { push('error', 'asset-id-invalid', p, `local: 只能指作品目录里的文件：${ref}`); return; }
      if (filmDir && !existsSync(join(filmDir, ...n.split('/')))) push('error', 'asset-file-missing', p, `作品自带的资产 ${n} 不存在（按作品目录）`);
      resolved.push({ ref, id: r.id, sha256: null, files: [n] });
      return;
    }
    let h;
    try { h = hashAsset(r.entry, { root }); } catch (error) {
      if (!(error instanceof AssetError)) throw error;
      push('error', error.code, p, error.message, error.hint);
      return;
    }
    resolved.push({ ref, id: `${r.id}@v${r.version}`, sha256: h.sha256, files: h.files.map(f => f.path) });
    const locked = lk?.assets?.[`${r.id}@v${r.version}`];
    if (lk && !locked) push('warning', 'asset-unlocked', p, `${r.id} 还没写进资产锁文件`, 'node engine/assets/manifest.js lock --write');
    else if (locked && locked.sha256 !== h.sha256) {
      const changed = h.files.filter(f => locked.files?.[f.path] !== f.sha256).map(f => f.path);
      const gone = Object.keys(locked.files ?? {}).filter(f => !h.files.some(x => x.path === f));
      push('warning', 'asset-changed', p, `资产 ${r.id} 的哈希变了（${[...changed, ...gone.map(g => `${g}（已不在闭包里）`)].join('、') || '文件集合变了'}）：用到它的镜头缓存失效，用户认可过的风格帧要复核`,
        '确认是有意改动后更新锁文件：node engine/assets/manifest.js lock --write');
    }
  });
  return { ok: !diagnostics.some(d => d.level === 'error'), diagnostics, resolved };
}

export function assetFingerprint(refs, opts = {}) {
  const r = checkAssets(refs, opts);
  if (!r.ok) {
    const e = r.diagnostics.find(d => d.level === 'error');
    throw new AssetError(e.code, e.message, { hint: e.hint });
  }
  return sha(r.resolved.map(x => `${x.id}=${x.sha256 ?? x.files.join(',')}`).sort().join('\n'));
}

// ───────────────────────── 命令行（tools/lib/cli.mjs：docs/CLI.md 的约定，--json 的结果在 data） ─────────────────────────

const toCli = e => (e instanceof AssetError
  ? new CliError(`${{ 2: 'usage', 4: 'contract' }[e.exitCode] ?? 'failure'}.${e.code}`, e.message, { hint: e.hint || null, exitCode: e.exitCode })
  : e);
const guard = fn => async ctx => { try { return await fn(ctx); } catch (e) { throw toCli(e); } };
const fmt = d => `${d.level === 'error' ? '✗' : '!'} [${d.code}] ${d.path}：${d.message}${d.hint ? `\n    → ${d.hint}` : ''}`;

const listCmd = defineCommand({
  name: 'manifest.js list',
  summary: '列出共享资产：id@版本、来源文件、许可',
  usage: ['node engine/assets/manifest.js list [--kind <种类>] [--json]'],
  options: { kind: { type: 'string', arg: '<种类>', choices: KINDS.filter(k => k !== 'local'), describe: '只列这一类' } },
  exitCodes: { 0: '成功', 2: '用法错误', 1: '运行失败' },
  run: guard(ctx => {
    const reg = loadRegistry();
    const rows = [...reg.assets.values()].filter(e => !ctx.opts.kind || e.kind === ctx.opts.kind).map(e => ({ id: `${e.id}@v${e.version}`, name: e.name, source: e.module ?? e.files.join(' '), license: e.license }));
    ctx.out(rows.map(r => `${r.id.padEnd(30)} ${r.source.padEnd(34)} ${r.license}  ${r.name}`).join('\n'));
    return { data: { assets: rows, problems: reg.problems }, warnings: reg.problems.map(p => ({ code: 'asset-registry', message: String(p), hint: null })) };
  }),
});

const checkCmd = defineCommand({
  name: 'manifest.js check',
  summary: '核对资产：认得、版本对、文件在；哈希与锁文件不符只提示（--strict 时也算失败）',
  usage: ['node engine/assets/manifest.js check [<资产 id>…] [--film <作品目录>] [--strict] [--json]'],
  positionals: [{ name: 'ids', label: '[<资产 id>…]', required: false, variadic: true, describe: '不给时核对注册表里的全部资产' }],
  options: {
    film: { type: 'string', arg: '<作品目录>', describe: '核对作品 film.json 的 assets' },
    strict: { type: 'boolean', describe: '哈希与锁文件不符也算失败' },
  },
  exitCodes: { 0: '通过', 4: '资产不认识 / 版本不对 / 文件缺失（--strict 时含哈希变化）', 2: '用法错误或找不到作品', 1: '运行失败' },
  run: guard(ctx => {
    let refs = ctx.args.ids, filmDir = null;
    if (ctx.opts.film) {
      if (refs.length) throw new CliError('usage.conflict', '--film 与资产 id 只给一种', '核对作品用 --film，核对单个资产直接写 id');
      filmDir = resolve(ctx.opts.film);
      const f = join(filmDir, 'film.json');
      if (!existsSync(f)) throw new CliError('usage.not-found', `找不到作品描述：${ctx.opts.film.replace(/\\/g, '/').replace(/\/+$/, '')}/film.json`, '给作品目录（films/<名>）');
      const raw = readJson(f);
      refs = Array.isArray(raw.assets) ? raw.assets : [];
      if (raw.mirror?.paths === 'repo') filmDir = REPO_ROOT;
    } else if (!refs.length) refs = [...loadRegistry().assets.keys()];
    const r = checkAssets(refs, { filmDir });
    const errs = r.diagnostics.filter(d => d.level === 'error'), warns = r.diagnostics.filter(d => d.level === 'warning');
    const ok = !errs.length && !(ctx.opts.strict && warns.length);
    ctx.out([`${ok ? '✓' : '✗'} ${r.resolved.length}/${refs.length} 个资产核对通过`, ...r.diagnostics.map(fmt)].join('\n'));
    const data = { ok: r.ok, resolved: r.resolved, diagnostics: r.diagnostics };
    const warnings = warns.map(d => ({ code: d.code, message: `${d.path}：${d.message}`, hint: d.hint || null }));
    if (ok) return { data, warnings };
    const e = errs[0] ?? warns[0];
    return { exitCode: 4, data, warnings, error: { code: `contract.${e.code}`, message: e.message, hint: e.hint || null } };
  }),
});

const lockCmd = defineCommand({
  name: 'manifest.js lock',
  summary: '重算全部资产的 sha256，与锁文件 engine/assets/assets.lock.json 比对；--write 写回',
  usage: ['node engine/assets/manifest.js lock [--write] [--json]'],
  options: { write: { type: 'boolean', describe: '原子地写回锁文件（确认资产改动是有意的之后）' } },
  exitCodes: { 0: '成功（预览或已写回）', 2: '用法错误', 1: '运行失败' },
  run: guard(async ctx => {
    const next = buildLock(), prev = readLock();
    const diff = Object.keys(next.assets).filter(k => prev?.assets?.[k]?.sha256 !== next.assets[k].sha256);
    const removed = Object.keys(prev?.assets ?? {}).filter(k => !next.assets[k]);
    const outputs = [];
    if (ctx.opts.write && (diff.length || removed.length || !prev)) {
      const { cleanupTemps, writeJsonAtomic } = await import('../production/io.js');
      ctx.onCleanup(cleanupTemps);
      const w = writeJsonAtomic(LOCK_FILE, next);
      outputs.push({ path: 'engine/assets/assets.lock.json', sha256: w.sha256, kind: 'lock' });
    }
    ctx.out([`${Object.keys(next.assets).length} 个资产；与锁文件不同 ${diff.length} 个${diff.length ? `：${diff.join('、')}` : ''}${removed.length ? `；锁文件里多出 ${removed.join('、')}` : ''}`,
      outputs.length ? '✓ 已写 engine/assets/assets.lock.json' : (ctx.opts.write ? '锁文件已是最新' : '（预览：加 --write 写回锁文件）')].join('\n'));
    return { outputs, data: { changed: diff, removed, written: outputs.length > 0 } };
  }),
});

export const SUBCOMMANDS = Object.freeze({ list: listCmd, check: checkCmd, lock: lockCmd });

const top = defineCommand({
  name: 'manifest.js',
  summary: '北冥引擎 · 共享资产注册表（造型、角色、材质、底板、字体、风格参考的 id 与 sha256）',
  usage: ['node engine/assets/manifest.js <list|check|lock> [参数] [--json]', 'node engine/assets/manifest.js <子命令> --help'],
  positionals: [{ name: 'command', label: '<子命令>', required: false, describe: 'list / check / lock' }, { name: 'rest', label: '[参数…]', required: false, variadic: true }],
  description: () => Object.entries(SUBCOMMANDS).map(([k, c]) => `  ${k.padEnd(6)} ${c.summary}`),
  exitCodes: { 0: '成功', 2: '用法错误', 4: '资产核对不通过', 1: '运行失败' },
  run: ctx => {
    const name = ctx.args.command;
    if (!name) throw new CliError('usage.missing-subcommand', '缺少子命令', '可用：list / check / lock；看 --help');
    const s = suggest(name, Object.keys(SUBCOMMANDS));
    throw new CliError('usage.unknown-subcommand', `没有子命令 ${name}`, `${s ? `是不是想写 ${s}？` : ''}可用：list / check / lock`);
  },
});

export async function main(argv) {
  const i = argv.findIndex(a => a === '--' || !a.startsWith('-'));
  const name = i >= 0 && argv[i] !== '--' ? argv[i] : null;
  if (name === 'help') return runCli(top, ['--help']);
  if (name && Object.hasOwn(SUBCOMMANDS, name)) return runCli(SUBCOMMANDS[name], [...argv.slice(0, i), ...argv.slice(i + 1)]);
  return runCli(top, argv);
}

if (isMain(import.meta.url)) await main(process.argv.slice(2));
