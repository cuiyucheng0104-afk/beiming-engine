// 北冥 QA · 交付档位：读取权威档位表 engine/production/profiles.json（P05），缺失或缺字段时用 tools/qa/profiles.builtin.json 兜底并报 warn。
// 所有期望值（尺寸、帧率、色彩、响度、安全区、文字与画面阈值）都从这里来，检查代码里不写死数字。
//
//   loadProfiles({ root, file })  → { profiles: Map<id, 档位>, source, warnings }
//        file 给了就只读这一个文件（测试或试验用，报告里会标明来源）；否则先读 engine/production/profiles.json
//   resolveProfile(store, id, film) → 档位（深拷贝，已叠加 film.json 的 qa 覆盖项），找不到抛用法错误并列出可选值
//   fpsOf(档位) → { num, den, value }
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QaError, EXIT } from './cli-kit.mjs';

export const QA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(QA_DIR, '../..');
export const AUTHORITATIVE = 'engine/production/profiles.json';
const BUILTIN = path.join(QA_DIR, 'profiles.builtin.json');

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function merge(base, over) {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over || {})) {
    if (k.startsWith('$')) continue;
    out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : structuredClone(v);
  }
  return out;
}

export function parseFps(v) {
  if (v == null) return null;
  if (typeof v === 'number' && v > 0) return Number.isInteger(v) ? { num: v, den: 1, value: v } : { num: Math.round(v * 1001), den: 1001, value: v };
  const m = /^(\d+)(?:\/(\d+))?$/.exec(String(v).trim());
  if (!m) return null;
  const num = +m[1], den = m[2] ? +m[2] : 1;
  return den > 0 && num > 0 ? { num, den, value: num / den } : null;
}
export const fpsOf = p => parseFps(p.fps);

// 把外部档位（字段名可能是另一套写法）映射到 QA 的内部写法；只取认得的字段
function adapt(raw) {
  const p = {};
  const v = raw.video || {}, a = raw.audio || {}, c = v.color || raw.color || {};
  const size = raw.size || v.size;
  p.label = raw.label || raw.name || raw.title;
  p.width = raw.width ?? v.width ?? (Array.isArray(size) ? size[0] : undefined);
  p.height = raw.height ?? v.height ?? (Array.isArray(size) ? size[1] : undefined);
  p.fps = raw.fps ?? v.fps ?? raw.frameRate ?? v.frameRate;
  const video = {};
  const pick = (dst, k, ...vals) => { const x = vals.find(y => y !== undefined && y !== null); if (x !== undefined) dst[k] = x; };
  pick(video, 'codec', v.codec, raw.codec);
  pick(video, 'profiles', Array.isArray(v.profiles) ? v.profiles : (v.profile ? [v.profile] : undefined));
  pick(video, 'pixFmt', v.pixFmt, v.pix_fmt, raw.pixFmt);
  pick(video, 'colorRange', c.range, v.colorRange, v.color_range);
  pick(video, 'colorSpace', c.space, c.matrix, v.colorSpace, v.colorspace, v.matrix);
  pick(video, 'colorPrimaries', c.primaries, v.colorPrimaries, v.color_primaries);
  pick(video, 'colorTransfer', c.transfer, c.trc, v.colorTransfer, v.color_trc);
  pick(video, 'maxLevel', v.maxLevel, v.level);
  if (Object.keys(video).length) p.video = video;
  const audio = {};
  const loud = a.loudness || {};
  pick(audio, 'codec', a.codec);
  pick(audio, 'sampleRate', a.sampleRate, a.sample_rate, a.rate);
  pick(audio, 'channels', a.channels);
  pick(audio, 'integratedLufs', loud.integrated, loud.target, a.targetLUFS, a.integratedLufs, a.lufs, raw.targetLUFS);
  pick(audio, 'lufsTolerance', loud.tolerance, a.lufsTolerance, a.tolerance);
  pick(audio, 'truePeakMaxDbtp', loud.truePeak, a.truePeakDbTP, a.truePeakMaxDbtp, a.truePeak, raw.truePeakDbTP);
  if (Object.keys(audio).length) p.audio = audio;
  if (raw.safeArea) p.safeArea = normalizeSafe(raw.safeArea);
  for (const k of ['texts', 'visual', 'sync', 'plates', 'container', 'aigc']) if (isObj(raw[k])) p[k] = raw[k];
  for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k];
  return p;
}
function sides(v) {
  if (typeof v === 'number') return { top: v, right: v, bottom: v, left: v };
  if (isObj(v)) return { top: v.top ?? v.y ?? 0, right: v.right ?? v.x ?? 0, bottom: v.bottom ?? v.y ?? 0, left: v.left ?? v.x ?? 0 };
  return undefined;
}
// 安全区写法：{ title: 0.05 }、{ title: { top, right, bottom, left } }、{ titleSafe: 0.05 }；百分数（>1）按 % 处理
function normalizeSafe(s) {
  const out = {};
  const t = s.title ?? s.titleSafe ?? s.graphics, a = s.action ?? s.actionSafe;
  const pct = o => o && Object.fromEntries(Object.entries(o).map(([k, x]) => [k, x > 1 ? x / 100 : x]));
  if (t !== undefined) out.title = pct(sides(t));
  if (a !== undefined) out.action = pct(sides(a));
  return out;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    throw new QaError('input.profiles', `档位文件 ${file} 不是合法 JSON：${e.message}`, { hint: '修好 JSON 后重跑', exitCode: EXIT.USAGE });
  }
}
function entries(doc) {
  const src = isObj(doc.profiles) ? doc.profiles : Array.isArray(doc.profiles) ? doc.profiles : Array.isArray(doc) ? doc : doc;
  if (Array.isArray(src)) return src.filter(isObj).map(p => [p.id, p]).filter(([id]) => typeof id === 'string');
  return Object.entries(src).filter(([k, v]) => !k.startsWith('$') && isObj(v) && !['defaults', 'schemaVersion'].includes(k));
}

const REQUIRED = ['width', 'height', 'fps', 'video.pixFmt', 'video.colorRange', 'video.colorSpace', 'video.colorPrimaries', 'video.colorTransfer',
  'audio.sampleRate', 'audio.channels', 'audio.integratedLufs', 'audio.lufsTolerance', 'audio.truePeakMaxDbtp', 'safeArea.title'];
const get = (o, k) => k.split('.').reduce((x, y) => (x == null ? x : x[y]), o);

export const BUILTIN_SOURCE = 'tools/qa/profiles.builtin.json';

// 档位的来源与兜底：外部表里有的用外部（缺字段逐项兜底），外部表里没有的用内置；兜底都记进该档位的 warnings
export function loadProfiles({ root = REPO_ROOT, file = null } = {}) {
  const builtin = readJson(BUILTIN);
  const defaults = builtin.defaults;
  const profiles = new Map();
  for (const [id, p] of entries(builtin)) profiles.set(id, { ...merge(defaults, p), id, source: BUILTIN_SOURCE, warnings: [] });
  const warnings = [];
  let source = BUILTIN_SOURCE;
  const extPath = file ? path.resolve(file) : path.join(root, AUTHORITATIVE);
  if (fs.existsSync(extPath)) {
    const extSource = file ? path.resolve(file) : AUTHORITATIVE;
    const doc = readJson(extPath);
    let n = 0;
    for (const [id, raw] of entries(doc)) {
      const base = profiles.get(id) || merge(defaults, {});
      const adapted = adapt(raw);
      const filled = REQUIRED.filter(k => get(adapted, k) === undefined && get(base, k) !== undefined);
      const p = { ...merge(base, adapted), id, source: extSource, warnings: [] };
      if (filled.length) p.warnings.push(`档位 ${id} 在 ${extSource} 里没写 ${filled.join('、')}，这些项用 QA 内置值（${BUILTIN_SOURCE}）`);
      profiles.set(id, p);
      n++;
    }
    if (n) source = extSource;
    else warnings.push(`${extSource} 里没有可识别的档位，改用 QA 内置档位`);
    for (const p of profiles.values()) {
      if (p.source === BUILTIN_SOURCE && n) p.warnings.push(`档位 ${p.id} 不在 ${extSource} 里，用 QA 内置值`);
    }
  } else if (file) {
    throw new QaError('usage', `找不到档位文件 ${file}`, { exitCode: EXIT.USAGE });
  } else {
    for (const p of profiles.values()) p.warnings.push(`${AUTHORITATIVE} 还不存在（由 P05 维护），按 QA 内置档位判定（与 D07、附录 C7 一致）`);
  }
  return { profiles, source, warnings };
}

export function resolveProfile(store, id, film = null) {
  const want = id || film?.profile || 'web-1080p24';
  const base = store.profiles.get(want);
  if (!base) {
    throw new QaError('usage', `没有档位 ${want}`, { hint: `可选：${[...store.profiles.keys()].join('、')}；或用 --profiles-file 指定档位表`, exitCode: EXIT.USAGE });
  }
  let p = structuredClone(base);
  if (!id && !film?.profile) p.warnings.push('没有用 --profile 指定档位，作品描述里也没写 output.profile，按默认档 web-1080p24 判定');
  const q = film?.qa || {};
  if (q.safeArea) p.safeArea = merge(p.safeArea || {}, normalizeSafe(q.safeArea));
  for (const k of ['texts', 'visual', 'sync', 'plates']) if (isObj(q[k])) p[k] = merge(p[k] || {}, q[k]);
  if (film && film.audioMode === 'none') p = merge(p, { audio: { required: false } });
  return p;
}
