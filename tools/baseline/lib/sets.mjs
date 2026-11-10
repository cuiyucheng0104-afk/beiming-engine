// 北冥仓库 · 金标准集合：读 tools/baseline/sets.json，校验结构，把集合展开成「页面组」，再在页面打开后展开成帧。
//
//   loadSets(file)            → 校验过的 sets.json 对象；结构错误抛 CliError（exit 4）
//   setHash(sets, name)       → 集合定义（含引用的页面）的 sha256，写进清单，用来发现「集合改了但基线没更新」
//   expandSet(sets, name)     → [{ groupId, pageId, page, size, query, clip, times, fps }]
//   resolveTimes(times, DUR, fps) → [{ t, f? }]，四种写法：
//       [1.6, 4.0]                         显式秒数
//       { start, step, count }             t = start + step·i（四舍五入到 1e-6）
//       { uniformMid: n }                  t = (i + 0.5)·DUR / n（每段中点，避开切点与片尾）
//       { frames: [71, 72] }               整数帧，t = f / fps
//   frameId(group, entry)     → 帧编号，如 film@1920x1040#t=0.0500、lab:kun?test=kun@1920x1040#t=0.3333、film?dbg=edge@1920x1040#f=182
//   frameFile(id)             → 文件名（可移植：只含 ASCII 字母数字与 ._=-，附 8 位哈希防撞名）
import fs from 'node:fs';
import crypto from 'node:crypto';
import { CliError, EXIT } from './cli.mjs';

const fail = (msg, hint = '') => new CliError('bad-sets', `sets.json：${msg}`, { hint, exitCode: EXIT.CONTRACT });
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isSize = s => Array.isArray(s) && s.length === 2 && s.every(v => Number.isInteger(v) && v >= 16 && v % 2 === 0);

export function validateSets(j) {
  const errs = [];
  if (!j || j.schema !== 'beiming-golden-sets/v1') errs.push('schema 应为 "beiming-golden-sets/v1"');
  const pages = j?.pages || {}, sets = j?.sets || {};
  for (const [id, p] of Object.entries(pages)) {
    if (!/^[a-z0-9][a-z0-9:_-]*$/.test(id)) errs.push(`页面名 ${id} 只能用小写字母、数字、: _ -`);
    if (!!p.dir === !!p.template) errs.push(`页面 ${id} 要在 dir 与 template 里二选一`);
    if (p.query != null && typeof p.query !== 'string') errs.push(`页面 ${id} 的 query 要是字符串`);
    if (p.fps != null && !(Number.isInteger(p.fps) && p.fps > 0)) errs.push(`页面 ${id} 的 fps 要是正整数`);
    if (p.template && p.vars && !Object.values(p.vars).every(v => typeof v === 'string')) errs.push(`页面 ${id} 的 vars 只能是字符串`);
  }
  for (const [name, s] of Object.entries(sets)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) errs.push(`集合名 ${name} 只能用小写字母、数字和 -`);
    if (!Array.isArray(s.shots) || !s.shots.length) { errs.push(`集合 ${name} 没有 shots`); continue; }
    const tol = s.tolerance || {};
    for (const k of Object.keys(tol)) if (!['samePlatform', 'crossPlatform'].includes(k)) errs.push(`集合 ${name} 的 tolerance 只认 samePlatform / crossPlatform（多了 ${k}）`);
    s.shots.forEach((g, i) => {
      const at = `集合 ${name} 第 ${i + 1} 组`;
      if (!pages[g.page]) errs.push(`${at} 引用了不存在的页面 ${g.page}`);
      if (!(isSize(g.size) || g.size === 'film.json')) errs.push(`${at} 的 size 要是 [偶数宽, 偶数高] 或 "film.json"`);
      if (g.query != null && typeof g.query !== 'string') errs.push(`${at} 的 query 要是字符串`);
      if (g.clip != null && !(Array.isArray(g.clip) && g.clip.length === 4 && g.clip.every(v => Number.isInteger(v) && v >= 0))) errs.push(`${at} 的 clip 要是 [x, y, 宽, 高] 整数`);
      const t = g.times;
      const okTimes = (Array.isArray(t) && t.length && t.every(v => isNum(v) && v >= 0))
        || (t && isNum(t.start) && isNum(t.step) && Number.isInteger(t.count) && t.count > 0)
        || (t && Number.isInteger(t.uniformMid) && t.uniformMid > 0)
        || (t && Array.isArray(t.frames) && t.frames.length && t.frames.every(f => Number.isInteger(f) && f >= 0));
      if (!okTimes) errs.push(`${at} 的 times 写法不对（见 tools/baseline/lib/sets.mjs 开头的四种写法）`);
    });
  }
  return errs;
}

export function loadSets(file) {
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw fail(`读不出来（${e.message}）`); }
  const errs = validateSets(j);
  if (errs.length) throw fail(errs.join('；'), '照 tools/baseline/sets.json 里现有集合的写法改');
  return j;
}

const canon = v => JSON.stringify(v, Object.keys(v && typeof v === 'object' ? flattenKeys(v) : {}).sort());
function flattenKeys(o, acc = {}) {
  if (Array.isArray(o)) o.forEach(x => flattenKeys(x, acc));
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { acc[k] = 1; flattenKeys(v, acc); }
  return acc;
}
export function setHash(sets, name) {
  const s = sets.sets[name];
  const pages = Object.fromEntries([...new Set(s.shots.map(g => g.page))].sort().map(p => [p, sets.pages[p]]));
  const { description, 说明, ...rest } = s;
  return crypto.createHash('sha256').update(canon({ set: rest, pages })).digest('hex');
}

export function expandSet(sets, name) {
  const s = sets.sets[name];
  if (!s) throw new CliError('unknown-set', `没有集合 ${name}`, { hint: `可用集合：${Object.keys(sets.sets).join('、')}`, exitCode: EXIT.USAGE });
  return s.shots.map((g, i) => {
    const page = sets.pages[g.page];
    const query = [page.query, g.query].filter(Boolean).join('&');
    return { groupId: `${name}#${i + 1}`, pageId: g.page, page, size: g.size, query, clip: g.clip || null, times: g.times, fps: page.fps || 24 };
  });
}

const r6 = v => Math.round(v * 1e6) / 1e6;
export function resolveTimes(times, DUR, fps) {
  if (Array.isArray(times)) return times.map(t => ({ t }));
  if (times.frames) return times.frames.map(f => ({ t: f / fps, f }));
  if (times.uniformMid) return Array.from({ length: times.uniformMid }, (_, i) => ({ t: r6(((i + 0.5) * DUR) / times.uniformMid) }));
  return Array.from({ length: times.count }, (_, i) => ({ t: r6(times.start + times.step * i) }));
}

export function frameId({ pageId, query, clip }, w, h, e) {
  return `${pageId}${query ? `?${query}` : ''}@${w}x${h}${clip ? `[${clip.join(',')}]` : ''}#${e.f != null ? `f=${e.f}` : `t=${e.t.toFixed(4)}`}`;
}
export function frameFile(id) {
  const safe = id.replace(/[^A-Za-z0-9._=-]+/g, '_').replace(/_+/g, '_').slice(0, 96);
  return `${safe}-${crypto.createHash('sha256').update(id).digest('hex').slice(0, 8)}.png`;
}
