// 北冥引擎 · 画风注册表：按「id@版本」查画风锁定（style-lock），按「id@版本/预设名」解析每镜后期预设（lookPreset）。
// 浏览器（页面里 fetch）和 Node（工具、测试、仓库检查里同步读文件）通用；没登记的 id、版本、预设名一律抛 StyleError，不静默回退。
// 数据：engine/style/registry.json（登记表）+ 每个版本一份锁定文件（如 beiming-original.v1.json）；字段说明见
// routes/directing/templates/STYLE-LOCK.md，本注册表另加 lookDefaults、lookPresets、shadingDefaults、allowedOverrides[].paths。
//
//   parseStyleRef('beiming-original@v1')          → { id, version: 1 }（也接受 @1 与 { id, version }）
//   parseLookPreset('beiming-original@v1/wide')  → { id, version, preset }
//   styleKey({ id, version })                    → 'beiming-original@v1'
//   await loadRegistry() / loadRegistrySync()      登记表（Node 下同步读文件；浏览器用 fetch）
//   await loadStyle(ref) / loadStyleSync(ref)       一个版本的画风锁定
//   listLookPresets(registry)                     → 全部可解析的 'id@vN/预设' 字符串（给仓库检查用）
//   resolveLook(style, preset, overrides, { strict })
//       → { defaults, params, problems, refHeight, fogColor, paper }：defaults 交给 engine/look 的 createLook，
//         params 是该镜每帧参数（预设 + 覆盖）；problems 列出越出 allowedOverrides 的覆盖项，strict 时直接抛错
//   checkOverrides(style, overrides) → 问题列表     覆盖项的路径与数值是否在 allowedOverrides[].paths 允许的范围里
//   mixLook(a, b, k)                              两套后期参数逐数值插值（光的剧本：hero → hero-sunrise）
//   validateStyleLock(doc) → 问题列表             字段齐全、色值合法、强调色写了 only、approved 必须有证据……
// 纯数据与纯函数：不碰画布、不读时钟；同一份输入永远得到同一份参数。

const HERE = new URL('./', import.meta.url);
const IS_NODE = typeof window === 'undefined' && typeof process !== 'undefined' && !!(process.versions && process.versions.node);

export class StyleError extends Error {
  constructor(code, message, hint = '') { super(hint ? `${message}（${hint}）` : message); this.name = 'StyleError'; this.code = code; this.hint = hint; }
}

const SLUG = '[a-z0-9][a-z0-9-]*';
const REF_RE = new RegExp(`^(${SLUG})@v?(\\d+)$`);
const PRESET_RE = new RegExp(`^(${SLUG})@v?(\\d+)/(${SLUG})$`);

export function parseStyleRef(ref) {
  if (ref && typeof ref === 'object') {
    const v = typeof ref.version === 'string' ? Number(ref.version.replace(/^v/, '')) : ref.version;
    if (typeof ref.id === 'string' && new RegExp(`^${SLUG}$`).test(ref.id) && Number.isInteger(v) && v > 0) return { id: ref.id, version: v };
    throw new StyleError('bad-style-ref', `画风引用不合法：${JSON.stringify(ref)}`, '写成 { "id": "beiming-original", "version": 1 }');
  }
  const m = REF_RE.exec(String(ref ?? '').trim());
  if (!m) throw new StyleError('bad-style-ref', `画风引用写法不对：${JSON.stringify(ref)}`, '写成 <id>@v<版本>，例如 beiming-original@v1');
  return { id: m[1], version: Number(m[2]) };
}
export function parseLookPreset(str) {
  const m = PRESET_RE.exec(String(str ?? '').trim());
  if (!m) throw new StyleError('bad-look-preset', `lookPreset 写法不对：${JSON.stringify(str)}`, '写成 <画风 id>@v<版本>/<预设名>，例如 beiming-original@v1/wide');
  return { id: m[1], version: Number(m[2]), preset: m[3] };
}
export const styleKey = r => `${r.id}@v${r.version}`;

// ── 读文件：Node 同步（process.getBuiltinModule，Node ≥ 22.3），浏览器 fetch ──
function nodeFs() {
  const get = IS_NODE && process.getBuiltinModule;
  if (!get) throw new StyleError('no-sync-io', '同步读注册表只能在 Node ≥ 22.3 里用', '浏览器里用 await loadRegistry() / loadStyle()');
  return { fs: get('node:fs'), url: get('node:url') };
}
function readJsonSync(rel) {
  const { fs, url } = nodeFs();
  const file = url.fileURLToPath(new URL(rel, HERE));
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch { throw new StyleError('registry-missing', `找不到 ${file}`, '注册表文件在 engine/style/ 下，别移动'); }
  try { return JSON.parse(txt); } catch (e) { throw new StyleError('registry-bad-json', `${file} 不是合法 JSON：${e.message}`); }
}
async function readJson(rel) {
  if (IS_NODE) return readJsonSync(rel);
  const u = new URL(rel, HERE);
  const r = await fetch(u);
  if (!r.ok) throw new StyleError('registry-missing', `读不到 ${u.pathname}（HTTP ${r.status}）`, '页面要经仓库根的静态服务打开，engine/style/ 才取得到');
  try { return await r.json(); } catch (e) { throw new StyleError('registry-bad-json', `${u.pathname} 不是合法 JSON：${e.message}`); }
}

let REG = null;
const STYLES = new Map();
export async function loadRegistry() { return (REG ??= checkRegistry(await readJson('registry.json'))); }
export function loadRegistrySync() { return (REG ??= checkRegistry(readJsonSync('registry.json'))); }

function checkRegistry(reg) {
  if (!reg || reg.schema !== 'beiming.style-registry/1' || !Array.isArray(reg.styles))
    throw new StyleError('registry-bad', 'engine/style/registry.json 不是 beiming.style-registry/1');
  return reg;
}
function entryOf(reg, r) {
  const e = reg.styles.find(s => s.id === r.id && s.version === r.version);
  if (!e) {
    const known = reg.styles.map(styleKey).join('、') || '（空）';
    throw new StyleError('unknown-style', `画风 ${styleKey(r)} 没有登记`, `已登记：${known}；新画风按 routes/a-webgl/LOOKDEV.md 定调签认后再登记`);
  }
  return e;
}
function checkLoaded(doc, r, file) {
  const probs = validateStyleLock(doc);
  if (probs.length) throw new StyleError('style-invalid', `${file} 不合格：${probs.join('；')}`);
  if (doc.styleId !== r.id || doc.version !== `v${r.version}`) throw new StyleError('style-mismatch', `${file} 写的是 ${doc.styleId}@${doc.version}，登记表说它是 ${styleKey(r)}`);
  return doc;
}
export async function loadStyle(ref) {
  const r = parseStyleRef(ref), k = styleKey(r);
  if (!STYLES.has(k)) { const e = entryOf(await loadRegistry(), r); STYLES.set(k, checkLoaded(await readJson(e.file), r, e.file)); }
  return STYLES.get(k);
}
export function loadStyleSync(ref) {
  const r = parseStyleRef(ref), k = styleKey(r);
  if (!STYLES.has(k)) { const e = entryOf(loadRegistrySync(), r); STYLES.set(k, checkLoaded(readJsonSync(e.file), r, e.file)); }
  return STYLES.get(k);
}
export function listLookPresets(reg) {
  const out = [];
  for (const s of reg.styles) for (const p of s.lookPresets || []) out.push(`${styleKey(s)}/${p}`);
  return out;
}

// ── 参数合并与插值 ──
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export function mergeParams(base, over) {
  if (over === undefined) return clone(base);
  if (!isObj(base) || !isObj(over)) return clone(over);
  const out = clone(base);
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(out[k]) ? mergeParams(out[k], v) : clone(v);
  return out;
}
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export function mixLook(a, b, k) {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * k;
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) return a.map((x, i) => mixLook(x, b[i], k));
  if (isObj(a) && isObj(b)) {
    const out = {};
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) out[key] = key in a && key in b ? mixLook(a[key], b[key], k) : clone(key in a ? a[key] : b[key]);
    return out;
  }
  return clone(k < 0.5 ? a : b);
}

// 叶子路径：{ outline: { width: 2.4 } } → [['outline.width', 2.4]]；数组当叶子
function leaves(o, pre = '', out = []) {
  for (const [k, v] of Object.entries(o || {})) {
    const p = pre ? `${pre}.${k}` : k;
    if (isObj(v)) leaves(v, p, out); else out.push([p, v]);
  }
  return out;
}
export function checkOverrides(style, overrides) {
  const allow = {};
  for (const a of style.allowedOverrides || []) Object.assign(allow, a.paths || {});
  const probs = [];
  for (const [p, v] of leaves(overrides)) {
    if (p === 't' || p === 'debug' || p === 'target') continue;
    const rule = allow[p];
    if (rule === undefined) { probs.push(`${p} 不在 ${styleKey({ id: style.styleId, version: Number(style.version.slice(1)) })} 的 allowedOverrides 里（改它要升版本，见 STYLE-LOCK.md §3）`); continue; }
    if (rule === 'any') continue;
    const vals = Array.isArray(v) ? v : [v];
    for (const x of vals) if (typeof x === 'number' && (x < rule[0] - 1e-9 || x > rule[1] + 1e-9)) probs.push(`${p} = ${x} 超出允许范围 [${rule[0]}, ${rule[1]}]`);
  }
  return probs;
}

export function resolveLook(style, preset, overrides = {}, { strict = false } = {}) {
  const P = style.lookPresets && style.lookPresets[preset];
  if (!P) {
    const names = Object.keys(style.lookPresets || {}).join('、') || '（无）';
    throw new StyleError('unknown-preset', `画风 ${style.styleId}@${style.version} 没有预设「${preset}」`, `可用：${names}`);
  }
  const problems = checkOverrides(style, overrides);
  if (strict && problems.length) throw new StyleError('override-out-of-range', `镜头覆盖越界：${problems.join('；')}`);
  const D = style.lookDefaults || {};
  return { defaults: clone(D.params || {}), params: mergeParams(P.params, overrides), problems, refHeight: D.refHeight ?? 1080, fogColor: D.fogColor ?? '#ffffff', paper: D.paper || null, toonGlobals: clone(P.toonGlobals || null) };
}

// ── 锁定文件校验（与 STYLE-LOCK.md §2 的必填项一致） ──
const HEX = /^#[0-9a-fA-F]{6}$/;
export function validateStyleLock(doc) {
  const p = [];
  if (!isObj(doc)) return ['顶层必须是对象'];
  if (doc.schema !== 'beiming.style-lock/1') p.push(`schema 应为 beiming.style-lock/1，现在是 ${JSON.stringify(doc.schema)}`);
  if (!new RegExp(`^${SLUG}$`).test(doc.styleId || '')) p.push('styleId 应为小写字母、数字、连字符');
  if (!/^v\d+(\.\d+)?$/.test(doc.version || '')) p.push('version 应为 v1、v1.1 这样的写法');
  if (!['a', 'b', 'c', 'beiming', 'raea'].includes(doc.route)) p.push(`route 应为 a / b / c，现在是 ${JSON.stringify(doc.route)}`);
  if (typeof doc.sourceCommit !== 'string' || !doc.sourceCommit) p.push('sourceCommit 必填');
  const st = doc.status || {};
  if (!['none', 'rendered'].includes(st.output)) p.push('status.output 应为 none / rendered');
  if (!['not-reviewed', 'passed', 'failed'].includes(st.technical)) p.push('status.technical 应为 not-reviewed / passed / failed');
  if (!['none', 'indirect', 'approved', 'rejected'].includes(st.userApproval)) p.push('status.userApproval 应为 none / indirect / approved / rejected');
  if (st.userApproval === 'approved' && !(Array.isArray(st.approvalEvidence) && st.approvalEvidence.length && st.approvedBy && st.approvedAt))
    p.push('userApproval 写了 approved，就必须有 approvalEvidence、approvedBy、approvedAt（只有用户本人的话才算）');
  const colors = doc.palette && doc.palette.colors;
  if (!Array.isArray(colors) || !colors.length) p.push('palette.colors 必填');
  else for (const c of colors) {
    if (!c.id || !HEX.test(c.hex || '')) p.push(`色板项 ${JSON.stringify(c.id)} 的 hex 不合法：${JSON.stringify(c.hex)}`);
    if (!c.role) p.push(`色板项 ${c.id} 缺 role（职责）`);
  }
  for (const f of (doc.typography && doc.typography.fonts) || []) if (!f.license) p.push(`字体 ${f.family} 缺 license`);
  for (const [name, P] of Object.entries(doc.lookPresets || {})) if (!isObj(P.params)) p.push(`lookPresets.${name}.params 必须是对象`);
  for (const a of doc.allowedOverrides || []) {
    if (!a.param || !a.scope || !a.reason) p.push(`allowedOverrides 项缺 param / scope / reason：${JSON.stringify(a.param)}`);
    for (const [k, r] of Object.entries(a.paths || {}))
      if (!(r === 'any' || (Array.isArray(r) && r.length === 2 && r.every(Number.isFinite) && r[0] <= r[1]))) p.push(`allowedOverrides 的 ${k} 范围要写 [下限, 上限] 或 "any"`);
  }
  if (!Array.isArray(doc.newVersionWhen) || !doc.newVersionWhen.length) p.push('newVersionWhen 必填');
  return p;
}
