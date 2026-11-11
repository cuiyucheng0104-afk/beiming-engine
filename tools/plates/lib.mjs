// 底板准入检查的库（tools/plates/check.mjs 与 route-a 仓库规则共用）。
//   SIDES / POLICIES                          四条边；边策略的取值（与 assets/plates/plates.schema.json 一致）
//   SOURCE_KEYS                               逐张「来源」对象的八个字段（docs/rights/aigc.md「来源链」，决定 D11）
//   policyOf(entry, side) → 策略字符串
//   validateEntry(entry) → { errors, warnings } 只看字段（不读文件）：必填、取值、命名、waived 要写 edgeNote；
//                                             AI 生成的底板（aigc: true）必须有「来源」，不知道的字段写「待补」；
//                                             sourceSize / upscale（原图尺寸与放大方法）要和 size 对得上；
//                                             名字与文件名必须是 ASCII，新底板建议全小写（已有的 shotB_sky 不改名：作品站在用）
//   loadProfiles(root) → { 档位: { width, height } }   优先读 engine/production/profiles.json，没有就用决定 D07 的默认表
//   density(entry, profiles) → [{ where, profile, texelPerPx, detailPerPx, level }]
//       texelPerPx 按文件像素算（与 QA 的 plates.density 同口径：< 1.0 提示、< 0.6 不通过）；
//       detailPerPx 按原图像素 sourceSize 算（放大过的底板真实细节更少，只报告、不判定）
//   checkPlates(file, { decode, profiles }) → { file, plates: [{ name, errors, warnings, info, edges? }], errors, warnings }
//     decode = false 时只核对字段与 PNG 文件头（尺寸、色彩类型），不逐像素读——给仓库规范检查用，快
// 判据：截断边、直线淡出、不透明底板的边，策略只能是 offscreen / covered / organic-mask / waived（审计 CRAFT-03）；
// 写 natural 的边不许出现硬边或直线淡出；纹素密度阈值同 QA 门 tools/qa 的 plates.density（低于 1.0 提示、低于 0.6 不通过）。
import fs from 'node:fs';
import path from 'node:path';
import { readPngInfo, decodePng, PngError } from './png.mjs';
import { analyzeEdges } from './edges.mjs';

export const SIDES = ['left', 'right', 'top', 'bottom'];
export const SOURCE_KEYS = ['工具', '模型', '日期', '提示词', '参考图', '原图sha256', '操作', '人工修改'];
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
  if (e.aigc !== undefined && typeof e.aigc !== 'boolean') p.push('aigc 要是 true / false（是否 AI 生成，决定 D11）');
  const src = e['来源'];
  if (e.aigc === true && src === undefined) p.push('AI 生成的底板（aigc: true）要写「来源」对象（docs/rights/aigc.md「来源链」）：不知道的字段写「待补」，不要编');
  if (src !== undefined) {
    if (!src || typeof src !== 'object' || Array.isArray(src)) p.push('「来源」要是对象');
    else {
      for (const k of SOURCE_KEYS) if (!(k in src)) p.push(`「来源」缺字段「${k}」（不知道就写「待补」）`);
      for (const [k, v] of Object.entries(src)) {
        if (k === '人工修改') { if (!(typeof v === 'string' || (Array.isArray(v) && v.every(x => typeof x === 'string')))) p.push('「来源」的「人工修改」要是字符串数组（或「待补」）'); }
        else if (typeof v !== 'string' || !v.trim()) p.push(`「来源」的「${k}」要是非空字符串（不知道就写「待补」）`);
      }
      if (typeof src['原图sha256'] === 'string' && !/^待补/.test(src['原图sha256']) && !/^[0-9a-f]{64}$/.test(src['原图sha256'])) p.push('「来源」的「原图sha256」要是 64 位小写十六进制，或「待补」');
    }
  }
  const sizeOk = Array.isArray(e.size) && e.size.length === 2 && e.size.every(v => Number.isInteger(v) && v > 0);
  if (e.sourceSize !== undefined && !(Array.isArray(e.sourceSize) && e.sourceSize.length === 2 && e.sourceSize.every(v => Number.isInteger(v) && v > 0))) p.push(`sourceSize 要是原图的 [宽, 高] 正整数，现在是 ${JSON.stringify(e.sourceSize)}`);
  if (e.upscale !== undefined && e.upscale !== null) {
    const u = e.upscale;
    if (typeof u !== 'object' || Array.isArray(u) || !(typeof u.factor === 'number' && u.factor >= 1) || typeof u.method !== 'string' || !u.method) p.push('upscale 要是 { factor: ≥1 的数, method: 放大方法（不知道写「待补」）}，没放大写 null');
    else if (Array.isArray(e.sourceSize) && sizeOk && e.sourceSize.every(Number.isInteger)) {
      const off = [0, 1].map(i => Math.abs(e.size[i] - e.sourceSize[i] * u.factor));
      if (off.some(d => d > Math.max(2, u.factor))) p.push(`size ${e.size.join('×')} 不等于 sourceSize ${e.sourceSize.join('×')} × upscale.factor ${u.factor}`);
    }
    if (e.sourceSize === undefined) p.push('写了 upscale 就要写 sourceSize（原图尺寸）');
  } else if (e.upscale === null && Array.isArray(e.sourceSize) && sizeOk && (e.sourceSize[0] !== e.size[0] || e.sourceSize[1] !== e.size[1])) p.push(`sourceSize ${e.sourceSize.join('×')} 与 size ${e.size.join('×')} 不同，却写了没放大（upscale: null）`);
  if (e.aigc === true && e.sourceSize === undefined) w.push('AI 生成的底板最好写 sourceSize 与 upscale（原图尺寸、放大方法）：4K 交付要据此说明哪些层是放大来的（QA-A-004）');
  if (e.usage !== undefined) {
    if (!Array.isArray(e.usage)) p.push('usage 要是数组');
    else for (const u of e.usage) if (!(u && typeof u.where === 'string' && u.screenWidth > 0 && u.designHeight > 0)) p.push(`usage 项要有 where、screenWidth、designHeight：${JSON.stringify(u)}`);
  }
  return { errors: p, warnings: w };
}

export function density(e, profiles) {
  const out = [];
  const srcW = Array.isArray(e.sourceSize) ? e.sourceSize[0] : e.size[0];
  for (const u of e.usage || []) for (const [id, pr] of Object.entries(profiles)) {
    if (Array.isArray(u.profiles) && !u.profiles.includes(id)) continue;   // 用法写了只出哪些档位，就只算那些
    const px = u.screenWidth * pr.height / u.designHeight, v = e.size[0] / px;
    out.push({ where: u.where, profile: id, texelPerPx: +v.toFixed(3), detailPerPx: +(srcW / px).toFixed(3), level: v < 0.6 ? 'fail' : v < 1 ? 'warn' : 'ok' });
  }
  return out;
}

export function checkPlates(file, { decode = true, profiles = DEFAULT_PROFILES, only = null } = {}) {
  const res = { file, plates: [], errors: [], warnings: [], info: [] };
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { res.errors.push(`读不了 ${file}：${e.message}`); return res; }
  if (!doc || !Array.isArray(doc.plates)) { res.errors.push(`${file} 要有 plates 数组`); return res; }
  const dir = path.dirname(file), seen = new Set();
  for (const e of doc.plates) {
    if (only && !only.includes(e?.name)) continue;
    const v = validateEntry(e), r = { name: e?.name ?? '(无名)', errors: v.errors, warnings: v.warnings, info: [] };
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
      if (e.upscale && d.detailPerPx < 1) r.info.push(`${msg}；按原图 ${e.sourceSize.join('×')} 算的细节密度只有 ${d.detailPerPx}（文件是 ×${e.upscale.factor} 放大，方法 ${e.upscale.method}）`);
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
  for (const r of res.plates) {
    res.errors.push(...r.errors.map(m => `${r.name}：${m}`));
    res.warnings.push(...r.warnings.map(m => `${r.name}：${m}`));
    res.info.push(...r.info.map(m => `${r.name}：${m}`));
  }
  return res;
}
