// 底板准入检查的库（tools/plates/check.mjs 与 route-a 仓库规则共用）。
//   SIDES / POLICIES                          四条边；边策略的取值（与 assets/plates/plates.schema.json 一致）
//   policyOf(entry, side) → 策略字符串
//   validateEntry(entry) → { errors, warnings } 只看字段（不读文件）：必填、取值、命名、waived 要写 edgeNote；
//                                             名字与文件名必须是 ASCII，新底板建议全小写（已有的 shotB_sky 不改名：作品站在用）
//   loadProfiles(root) → { 档位: { width, height } }   优先读 engine/production/profiles.json，没有就用决定 D07 的默认表
//   density(entry, profiles) → [{ where, profile, texelPerPx, level }]   纹素密度：level ∈ ok / warn（< 1.0）/ fail（< 0.6）
//   checkPlates(file, { decode, profiles }) → { file, plates: [{ name, errors, warnings, edges? }], errors, warnings }
//     decode = false 时只核对字段与 PNG 文件头（尺寸、色彩类型），不逐像素读——给仓库规范检查用，快
// 判据：截断边、直线淡出、不透明底板的边，策略只能是 offscreen / covered / organic-mask / waived（审计 CRAFT-03）；
// 写 natural 的边不许出现硬边或直线淡出；纹素密度阈值同加固计划 P07 的底板项（4K 档低于 1.0 警告、低于 0.6 失败）。
import fs from 'node:fs';
import path from 'node:path';
import { readPngInfo, decodePng, PngError } from './png.mjs';
import { analyzeEdges } from './edges.mjs';

export const SIDES = ['left', 'right', 'top', 'bottom'];
export const POLICIES = ['offscreen', 'covered', 'organic-mask', 'natural', 'tiled', 'waived'];
const SAFE_FOR_BAD_EDGE = new Set(['offscreen', 'covered', 'organic-mask', 'waived', 'tiled']);
const SIDE_ZH = { left: '左', right: '右', top: '上', bottom: '下' };

// 决定 D07 的交付档位（engine/production/profiles.json 合入后以它为准）
const DEFAULT_PROFILES = {
  'web-1080p24': { width: 1920, height: 1080 }, 'master-1080p24': { width: 1920, height: 1080 }, 'uhd-2160p24': { width: 3840, height: 2160 },
  'vertical-1080x1920-30': { width: 1080, height: 1920 }, 'broadcast-1080p25': { width: 1920, height: 1080 }, 'beiming-1040p24': { width: 1920, height: 1040 },
};
export function loadProfiles(root) {
  const f = path.join(root, 'engine', 'production', 'profiles.json');
  if (!fs.existsSync(f)) return { ...DEFAULT_PROFILES };
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8')), list = j.profiles || j, out = {};
    for (const [id, p] of Object.entries(Array.isArray(list) ? Object.fromEntries(list.map(p => [p.id, p])) : list)) {
      const w = p.width ?? p.size?.[0], h = p.height ?? p.size?.[1];
      if (Number.isFinite(w) && Number.isFinite(h)) out[id] = { width: w, height: h };
    }
    return Object.keys(out).length ? out : { ...DEFAULT_PROFILES };
  } catch { return { ...DEFAULT_PROFILES }; }
}

export const policyOf = (e, side) => (typeof e.edgePolicy === 'string' ? e.edgePolicy : e.edgePolicy && e.edgePolicy[side]);

export function validateEntry(e) {
  const p = [], w = [];
  if (!e || typeof e !== 'object') return { errors: ['不是对象'], warnings: w };
  if (typeof e.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_]*$/.test(e.name)) p.push(`name ${JSON.stringify(e.name)} 要用 ASCII 字母、数字、下划线`);
  else if (/[A-Z]/.test(e.name)) w.push(`name ${e.name} 有大写字母：新底板一律小写加下划线（已有文件不改名）`);
  if (typeof e.file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_]*\.png$/.test(e.file)) p.push(`file ${JSON.stringify(e.file)} 要是 ASCII 字母、数字、下划线命名的 .png`);
  if (!(Array.isArray(e.size) && e.size.length === 2 && e.size.every(v => Number.isInteger(v) && v > 0))) p.push(`size 要是 [宽, 高] 正整数，现在是 ${JSON.stringify(e.size)}`);
  if (typeof e.transparent !== 'boolean') p.push('transparent 必填（true / false）');
  if (!['srgb', 'data'].includes(e.colorSpace)) p.push(`colorSpace 必填：srgb（彩色底板）或 data（纸纹这类数据贴图），现在是 ${JSON.stringify(e.colorSpace)}`);
  if (e.edgePolicy === undefined) p.push(`edgePolicy 必填：${POLICIES.join(' / ')}，或按 left/right/top/bottom 分别写`);
  else if (typeof e.edgePolicy === 'string') { if (!POLICIES.includes(e.edgePolicy)) p.push(`edgePolicy ${JSON.stringify(e.edgePolicy)} 不认识（可用：${POLICIES.join(' / ')}）`); }
  else if (e.edgePolicy && typeof e.edgePolicy === 'object') {
    for (const s of SIDES) if (!POLICIES.includes(e.edgePolicy[s])) p.push(`edgePolicy.${s} ${JSON.stringify(e.edgePolicy[s])} 不认识（可用：${POLICIES.join(' / ')}）`);
    for (const k of Object.keys(e.edgePolicy)) if (!SIDES.includes(k)) p.push(`edgePolicy 里多了 ${k}（只有 left / right / top / bottom）`);
  } else p.push('edgePolicy 要是字符串或对象');
  if (SIDES.some(s => policyOf(e, s) === 'waived') && !(typeof e.edgeNote === 'string' && e.edgeNote.trim())) p.push('有 waived 的边，就要在 edgeNote 写理由');
  if (e.usage !== undefined) {
    if (!Array.isArray(e.usage)) p.push('usage 要是数组');
    else for (const u of e.usage) if (!(u && typeof u.where === 'string' && u.screenWidth > 0 && u.designHeight > 0)) p.push(`usage 项要有 where、screenWidth、designHeight：${JSON.stringify(u)}`);
  }
  return { errors: p, warnings: w };
}

export function density(e, profiles) {
  const out = [];
  for (const u of e.usage || []) for (const [id, pr] of Object.entries(profiles)) {
    if (Array.isArray(u.profiles) && !u.profiles.includes(id)) continue;   // 用法写了只出哪些档位，就只算那些
    const v = e.size[0] / (u.screenWidth * pr.height / u.designHeight);
    out.push({ where: u.where, profile: id, texelPerPx: +v.toFixed(3), level: v < 0.6 ? 'fail' : v < 1 ? 'warn' : 'ok' });
  }
  return out;
}

export function checkPlates(file, { decode = true, profiles = DEFAULT_PROFILES, only = null } = {}) {
  const res = { file, plates: [], errors: [], warnings: [] };
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { res.errors.push(`读不了 ${file}：${e.message}`); return res; }
  if (!doc || !Array.isArray(doc.plates)) { res.errors.push(`${file} 要有 plates 数组`); return res; }
  const dir = path.dirname(file), seen = new Set();
  for (const e of doc.plates) {
    if (only && !only.includes(e?.name)) continue;
    const v = validateEntry(e), r = { name: e?.name ?? '(无名)', errors: v.errors, warnings: v.warnings };
    res.plates.push(r);
    if (seen.has(r.name)) r.errors.push('name 重复'); seen.add(r.name);
    if (r.errors.length) continue;
    const pf = path.join(dir, e.file);
    if (!fs.existsSync(pf)) { r.errors.push(`文件 ${e.file} 不存在`); continue; }
    let info;
    const buf = fs.readFileSync(pf);
    try { info = readPngInfo(buf); } catch (err) { r.errors.push(`${e.file}：${err.message}`); continue; }
    if (info.width !== e.size[0] || info.height !== e.size[1]) r.errors.push(`登记尺寸 ${e.size.join('×')} 与文件实际 ${info.width}×${info.height} 不符`);
    const hasAlpha = info.colorType === 4 || info.colorType === 6 || info.chunks.includes('tRNS');
    if (e.transparent && !hasAlpha) r.errors.push('登记为透明，但 PNG 没有 alpha 通道');
    if (info.iccp && !/srgb/i.test(info.iccp)) r.warnings.push(`带了 ICC 配置「${info.iccp}」：贴图按 sRGB 解码会偏色，导出时转成 sRGB 并去掉 ICC`);
    if (info.gamma && Math.abs(info.gamma - 0.45455) > 0.01 && !info.srgb) r.warnings.push(`gAMA = ${info.gamma}，不是 sRGB 的 1/2.2`);
    if (e.colorSpace === 'data' && info.colorType !== 0 && info.colorType !== 4) r.warnings.push('colorSpace 写的 data，却是彩色 PNG：确认它确实是数据贴图');
    for (const d of density(e, profiles)) {
      const msg = `${d.where} 在 ${d.profile} 档：纹素密度 ${d.texelPerPx}`;
      if (d.level === 'fail') r.errors.push(`${msg} < 0.6（放大太多，纹理会糊）：换更大的图，或在这个档位缩小摆放宽度`);
      else if (d.level === 'warn') r.warnings.push(`${msg} < 1.0`);
    }
    if (!decode) continue;
    let img;
    try { img = decodePng(buf); } catch (err) { r.errors.push(`${e.file}：${err instanceof PngError ? err.message : String(err)}`); continue; }
    const an = analyzeEdges(img);
    r.edges = an.sides;
    if (e.transparent && an.opaque) r.warnings.push('登记为透明，但没有任何透明像素');
    if (!e.transparent && !an.opaque) r.warnings.push('登记为不透明，但有透明像素');
    for (const s of SIDES) {
      const a = an.sides[s], pol = policyOf(e, s), bad = a.hard || a.straight;
      const what = a.hard ? `贴着图边仍不透明（最外一圈 alpha 最大 ${a.outerMax}）` : `直线淡出（${(a.line * 100).toFixed(0)}% 的${s === 'left' || s === 'right' ? '行' : '列'}在离边 ${a.median} px 的同一条线附近淡出）`;
      if (bad && !SAFE_FOR_BAD_EDGE.has(pol)) r.errors.push(`${SIDE_ZH[s]}边${what}，策略却是 ${pol}：改成 offscreen（留在画外）/ covered（被盖住）/ organic-mask（cropPlate 裁成有机外形），或 waived 并写理由`);
      if (!bad && pol === 'tiled' && !an.opaque) r.warnings.push(`${SIDE_ZH[s]}边策略是 tiled，但图有透明像素`);
    }
  }
  for (const r of res.plates) { res.errors.push(...r.errors.map(m => `${r.name}：${m}`)); res.warnings.push(...r.warnings.map(m => `${r.name}：${m}`)); }
  return res;
}
