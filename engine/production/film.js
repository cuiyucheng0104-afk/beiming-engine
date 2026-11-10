#!/usr/bin/env node
// 北冥引擎 · 作品描述 film.json v2：每部作品唯一的时间源与记录（计划附录 C6、决策 D07 / D08）。
// 镜头表 shots 与事件表 events 用整数帧写，秒只由 帧 / fps 推出；交付规格只引用 profiles.json 的档位；
// 创作闸门只写在 films/<名>/review/（见 review.js、state.js），这里只登记 gates 必须全开。
//
// 命令行（退出码按附录 C1：0 通过、2 用法错误、4 契约不通过、1 运行失败；--json 输出附录 C2 的信封）：
//   node engine/production/film.js check <作品目录|film.json> [--template] [--strict] [--no-files] [--json]
//   node engine/production/film.js --help          其余子命令（status / gate / review / retime / expect / export / upgrade / validate-result / profiles）
//
// 库接口：
//   loadFilm(target, opts) → { ok, film, raw, diagnostics, upgraded, notes, filmDir, file, pathBase }
//   validateFilm(json, { filmDir, template, checkFiles, profiles, registry }) → { ok, film, upgraded, notes, diagnostics }
//       film 是补齐默认值后的 v2 对象（events / holds / gates / deliveries / drive / entry / audio）；diagnostics 每条 { level, code, path, message, hint }
//   upgradeFilm(v1, { dirName, template, has }) → { film, notes }      v1 { route, title, dur, fps, size, native?, poster?, cuecheck? } → v2
//   retime(raw, shotId, change, opts)                                  改切点（ripple / roll），见 timeline.js 的 retimeShot
//   qaExpectations(film) → 尺寸、帧率、帧数、像素格式、色彩、音频、响度窗口、安全区、切点、事件、停顿、AIGC 标识（QA 的全部期望值）
//   loadProfiles() / getProfile(id) / matchProfile({ width, height, fps }) / ffprobeExpect(id)
//   loadRouteRegistry() / resolveRoute(value)                          路线注册表（routes/routes.json 存在时读它，否则用内置三条；实现在 routes.js）
//   toProjectSpec(film, opts) / fromProjectSpec(spec)                  与 engine/production/project.js 的 ProjectSpec v1 互相映射（路线 a / b / c，旧值 beiming / raea 作别名）
//   formatFilmJson / writeFilmJson                                     稳定排版、原子写
// 路径一律相对"路径基准"：普通作品是作品目录；镜像作品（mirror.paths = "repo"，如 films/beiming-10s）是仓库根。
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalRoute, normalizeRelativePath, validateProjectSpec } from './project.js';
import { BUILTIN_ROUTES, loadRouteRegistry, resolveRoute } from './routes.js';
import { REPO_ROOT, formatJson, readJsonFile, repoRelative, sha256Text, writeJsonAtomic } from './io.js';
import {
  FRAME_EPS, TimelineError, beatGrid, checkShots, frameOfBeat, offGrid, retimeShot, secondsToFrame, stableStringify, timingOf,
} from './timeline.js';

export const FILM_SCHEMA_VERSION = 2;
export const FILM_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHOT_OR_TRACK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ASSET_ID = /^[a-z][a-z0-9-]*(?::[A-Za-z0-9._-]+)?(?:@v?\d+(?:\.\d+)*)?$/;
const PLACEHOLDER = /\{\{\s*([^{}\s]*)\s*\}\}/g;

export const EVALUATIONS = Object.freeze(['absolute', 'baked', 'sequential']);
export const TRANSITIONS = Object.freeze(['cut', 'continuous', 'dissolve', 'fade']);
export const EVENT_DOMAINS = Object.freeze(['picture', 'ui', 'text', 'sfx', 'music', 'vo', 'amb', 'mix']);
export const AUDIO_MODES = Object.freeze(['script', 'wav', 'none', 'native']);
export const DRIVES = Object.freeze(['picture', 'beat', 'voice']);
export const HOLD_KINDS = Object.freeze(['freeze', 'black']);
export const GATE_KEYS = Object.freeze(['look', 'animatic', 'final']);
export const AIGC_MARK = '含 AI 生成画面';

const FIELDS = {
  top: ['schemaVersion', '$comment', 'id', 'title', 'route', 'backend', 'entry', 'output', 'shots', 'events', 'holds', 'drive', 'timeline',
    'audio', 'deliveries', 'style', 'assets', 'credits', 'aigc', 'gates', 'native', 'cuecheck', 'posterFrame', 'docs', 'methodRefs', 'mirror', 'notes'],
  compat: ['dur', 'fps', 'size'],
  output: ['profile', 'width', 'height', 'fps', 'frameCount'],
  shot: ['id', 'in', 'out', 'name', 'purpose', 'module', 'backend', 'evaluation', 'lookPreset', 'transition', 'tracks', 'actorClockOrigin',
    'framing', 'angle', 'camera', 'sound', 'desc', 'note'],
  event: ['id', 'frame', 'shot', 'end', 'audio', 'visual', 'domain', 'sync', 'beat', 'cue', 'source', 'desc', 'note'],
  hold: ['in', 'out', 'kind', 'reason', 'shot'],
  timeline: ['sections', 'beats', 'bars', 'meter', 'start', 'id', 'note'],
  audio: ['mode', 'script', 'wav', 'cues', 'targetLUFS', 'truePeakDbTP', 'note'],
  style: ['id', 'version', 'preset', 'baseline', 'lock', 'note'],
  credit: ['what', 'owner', 'license', 'source', 'note'],
  aigc: ['contains', 'note', 'marking', 'sources'],
  docs: ['brief', 'treatment', 'bible', 'styleLock', 'review'],
  mirror: ['of', 'paths', 'outDir', 'check', 'frozen', 'note'],
  native: ['entry', 'output', 'mux', 'images', 'models', 'sequences', 'audio', 'note'],
  cuecheck: ['grid', 'tolMs', 'silence', 'quietDb'],
  methodRef: ['caseId', 'path', 'catalogStatus', 'borrowed', 'upstreamStyle', 'vendorPath', 'license'],
};
/** 看起来像时间的字段名：出现在白名单之外就是"没有消费者的时间字段"（附录 C6），判错。 */
const TIME_LIKE = /^(t|t0|t1|t_end|tend|time|times|sec|secs|seconds|dur|duration|durationseconds|starttime|endtime|offsetsec|offsetms|inframe|outframe|atframe|frame_end|frameend|start|end|at|frames|bpm|fpb|poster)$/i;
const TIME_HINTS = {
  poster: 'v2 的海报帧写 posterFrame（整数帧），不写 poster 秒数',
  dur: '时长由 output.frameCount / output.fps 推出，不单独写',
  duration: '时长由 output.frameCount / output.fps 推出，不单独写',
  inframe: 'v2 的镜头区间写 in / out',
  outframe: 'v2 的镜头区间写 in / out',
};

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = v => typeof v === 'string' && v.trim().length > 0;
const posInt = v => Number.isInteger(v) && v > 0;
const nonNegInt = v => Number.isInteger(v) && v >= 0;
const finite = v => typeof v === 'number' && Number.isFinite(v);
const clone = v => structuredClone(v);

/** 命令与库共用的错误：exitCode 按附录 C1。 */
export class FilmError extends Error {
  constructor(code, message, { hint = '', exitCode = 4, diagnostics = [] } = {}) {
    super(message);
    this.name = 'FilmError';
    this.code = code;
    this.hint = hint;
    this.exitCode = exitCode;
    this.diagnostics = diagnostics;
  }
}

// ───────────────────────── 交付档位 ─────────────────────────

const PROFILES_FILE = join(dirname(fileURLToPath(import.meta.url)), 'profiles.json');
let profilesCache = null;

export function loadProfiles({ file = PROFILES_FILE, fresh = false } = {}) {
  if (profilesCache && !fresh && file === PROFILES_FILE) return profilesCache;
  const r = readJsonFile(file);
  if (!r.ok) throw new FilmError('profiles-unreadable', `交付档位表读不出来：${r.message}`, { exitCode: 1, hint: '它随仓库提供（engine/production/profiles.json）；被删改过就从版本库恢复' });
  const doc = r.value, problems = [];
  if (!isObj(doc?.profiles) || !Object.keys(doc.profiles).length) problems.push('缺少 profiles 对象');
  for (const [id, p] of Object.entries(doc?.profiles ?? {})) {
    const v = p?.video, a = p?.audio;
    if (!posInt(v?.width) || !posInt(v?.height) || v.width % 2 || v.height % 2) problems.push(`${id}.video 宽高必须是正偶数`);
    if (!posInt(v?.fps)) problems.push(`${id}.video.fps 必须是正整数`);
    if (!isObj(v?.color)) problems.push(`${id}.video.color 缺失`);
    if (!finite(a?.loudness?.integratedLUFS) || !finite(a?.loudness?.toleranceLU) || !finite(a?.truePeakMaxDbTP)) problems.push(`${id}.audio 响度或真峰值缺失`);
    if (!isObj(p?.safeArea?.title) || !isObj(p?.safeArea?.action)) problems.push(`${id}.safeArea 缺失`);
  }
  if (doc?.default && !doc.profiles?.[doc.default]) problems.push(`default 指向不存在的档位 ${doc.default}`);
  if (problems.length) throw new FilmError('profiles-invalid', `交付档位表不合格：${problems.join('；')}`, { exitCode: 1, hint: '从版本库恢复 engine/production/profiles.json，或按报错补字段' });
  const value = { default: doc.default ?? 'web-1080p24', profiles: doc.profiles, ffprobeFields: doc.ffprobeFields ?? {} };
  if (file === PROFILES_FILE) profilesCache = value;
  return value;
}

export function getProfile(id, profiles = loadProfiles()) {
  const p = profiles.profiles[id];
  if (!p) throw new FilmError('profile-unknown', `没有交付档位 ${JSON.stringify(id)}`, { hint: `可用：${Object.keys(profiles.profiles).join('、')}（默认 ${profiles.default}）` });
  return { id, ...p };
}

export function matchProfile({ width, height, fps }, profiles = loadProfiles()) {
  const hits = Object.entries(profiles.profiles).filter(([, p]) => p.video.width === width && p.video.height === height && p.video.fps === fps).map(([id]) => id);
  if (!hits.length) return null;
  if (hits.includes(profiles.default)) return profiles.default;
  return hits.find(id => profiles.profiles[id].role !== 'master') ?? hits[0];
}

/** 档位 → ffprobe 输出里应该看到的值（QA 直接逐项比对）。 */
export function ffprobeExpect(profileOrId, profiles = loadProfiles()) {
  const p = typeof profileOrId === 'string' ? getProfile(profileOrId, profiles) : profileOrId;
  const v = p.video, a = p.audio;
  return {
    video: {
      codec_name: v.codec, profile: v.codecProfile, pix_fmt: v.pixFmt, width: v.width, height: v.height,
      r_frame_rate: `${v.fps}/1`, avg_frame_rate: `${v.fps}/1`, sample_aspect_ratio: v.sar, field_order: v.fieldOrder,
      color_range: v.color.range, color_space: v.color.matrix, color_primaries: v.color.primaries, color_transfer: v.color.transfer,
    },
    audio: { codec_name: a.codec, sample_rate: String(a.sampleRate), channels: a.channels, channel_layout: a.channelLayout },
  };
}

// ───────────────────────── 路线注册表 ─────────────────────────

// 读取与别名解析在 routes.js（project.js 也用它）；这里转出，保持 film.js 的库接口不变
export { BUILTIN_ROUTES, loadRouteRegistry, resolveRoute };

// ───────────────────────── v1 → v2 ─────────────────────────

const DEFAULT_BACKEND = { a: 'three', b: 'native', c: 'canvas' };

/**
 * v1 记录 { route, title, dur, fps, size, native?, poster?, cuecheck? } 升级成 v2。纯函数：has(相对路径) 告诉它作品目录里有哪些文件。
 */
export function upgradeFilm(v1, { dirName, template = false, has = () => false, profiles = loadProfiles() } = {}) {
  const notes = [];
  const t = timingOf(v1);
  const [width, height] = Array.isArray(v1.size) ? v1.size : [undefined, undefined];
  const exact = Math.abs(v1.dur * v1.fps - t.frameCount) < 1e-6;
  notes.push(`v1 → v2：frameCount = round(dur × fps) = round(${v1.dur} × ${v1.fps}) = ${t.frameCount}${exact ? '' : '（dur × fps 不是整数，已取整）'}`);
  const profile = matchProfile({ width, height, fps: v1.fps }, profiles);
  notes.push(profile ? `按 ${width}×${height}@${v1.fps} 推断交付档位 ${profile}` : `${width}×${height}@${v1.fps} 不对应任何交付档位`);
  const route = typeof v1.route === 'string' ? v1.route.toLowerCase() : v1.route;
  const film = {
    schemaVersion: FILM_SCHEMA_VERSION,
    id: template ? '{{NAME}}' : dirName,
    title: v1.title,
    route,
    backend: DEFAULT_BACKEND[route] ?? undefined,
    output: { profile: profile ?? undefined, width, height, fps: v1.fps, frameCount: t.frameCount },
    shots: [{ id: 'S1', in: 0, out: t.frameCount }],
    events: [],
  };
  notes.push('整片视为一个镜头 S1 [0, frameCount)；分镜后改写 shots');
  if (route === 'a' && has('sound.py')) film.audio = { mode: 'script', script: 'sound.py' };
  else if (route === 'c' && has('mix.py')) film.audio = { mode: 'script', script: 'mix.py' };
  else if (route === 'b') film.audio = { mode: v1.native?.audio ? 'native' : 'none' };
  if (v1.poster !== undefined) {
    if (finite(v1.poster)) {
      film.posterFrame = secondsToFrame(v1.poster, v1.fps, 'round');
      notes.push(`poster ${v1.poster} 秒 → posterFrame ${film.posterFrame}`);
    } else notes.push(`poster ${JSON.stringify(v1.poster)} 不是秒数，未迁移`);
  }
  if (v1.native !== undefined) film.native = clone(v1.native);
  if (v1.cuecheck !== undefined) film.cuecheck = clone(v1.cuecheck);
  for (const k of Object.keys(v1)) {
    if (!['route', 'title', 'dur', 'fps', 'size', 'native', 'poster', 'cuecheck', 'schemaVersion', '$comment'].includes(k)) {
      film[k] = clone(v1[k]);
      notes.push(`保留 v1 未知字段 ${k}（v2 校验会再判一次）`);
    }
  }
  if (v1.$comment !== undefined) film.$comment = v1.$comment;
  return { film, notes };
}

// ───────────────────────── 校验 ─────────────────────────

function collectPlaceholders(value, path = '$', out = []) {
  if (typeof value === 'string') { for (const m of value.matchAll(PLACEHOLDER)) out.push({ name: m[1], path }); }
  else if (Array.isArray(value)) value.forEach((v, i) => collectPlaceholders(v, `${path}[${i}]`, out));
  else if (isObj(value)) for (const [k, v] of Object.entries(value)) collectPlaceholders(v, `${path}.${k}`, out);
  return out;
}
function substitute(value) {
  if (typeof value === 'string') return value.replaceAll('{{NAME}}', 'template').replaceAll('{{TITLE}}', '模版标题');
  if (Array.isArray(value)) return value.map(substitute);
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v)]));
  return value;
}
const lcm = (a, b) => { const g = (x, y) => (y ? g(y, x % y) : x); return a / g(a, b) * b; };
const route0 = v => (typeof v?.route === 'string' ? v.route.toLowerCase() : null);

/**
 * 校验 film.json（v1 自动升级）。不抛错，返回结构化诊断。
 * @param {unknown} input
 * @param {{ filmDir?: string, template?: boolean, checkFiles?: boolean, profiles?: object, registry?: object, dirName?: string }} [opts]
 */
export function validateFilm(input, opts = {}) {
  const { filmDir = null, template = false, profiles = loadProfiles(), registry = loadRouteRegistry() } = opts;
  const checkFiles = opts.checkFiles ?? Boolean(filmDir);
  const dirName = opts.dirName ?? (filmDir ? basename(resolve(filmDir)) : undefined);
  const diagnostics = [];
  const err = (code, path, message, hint = '') => diagnostics.push({ level: 'error', code, path, message, hint });
  const warn = (code, path, message, hint = '') => diagnostics.push({ level: 'warning', code, path, message, hint });
  const done = (film = null, extra = {}) => ({ ok: !diagnostics.some(d => d.level === 'error'), film, diagnostics, upgraded: false, notes: [], ...extra });

  if (!isObj(input)) { err('film-invalid', '$', 'film.json 顶层必须是 JSON 对象'); return done(); }

  // 1. 版本：v2 直接校验；v1（没有 schemaVersion、有 dur / fps / size）自动升级；其他一律拒绝
  let source = input, upgraded = false, notes = [];
  if (input.schemaVersion === undefined) {
    if (input.dur === undefined || input.fps === undefined) {
      err('schema-version-missing', 'schemaVersion', '没有 schemaVersion，也不是 v1 记录（v1 至少有 dur 与 fps）', '新作品写 "schemaVersion": 2，字段见 engine/production/README.md');
      return done();
    }
    try {
      const has = rel => Boolean(filmDir) && existsSync(join(filmDir, rel));
      ({ film: source, notes } = upgradeFilm(input, { dirName, template, has, profiles }));
      upgraded = true;
      const where = (filmDir && repoRelative(resolve(filmDir))) || '<作品目录>';
      warn('v1-upgraded', '$', `v1 记录已自动升级读取（${notes.join('；')}）`, `迁到 v2：node engine/production/film.js upgrade ${where}${template ? ' --template' : ''} --write，再补 credits / aigc${route0(input) === 'a' ? ' / style' : ''}`);
    } catch (error) {
      if (!(error instanceof TimelineError)) throw error;
      err(error.code, '$', `v1 记录读不出时间：${error.message}`, error.hint);
      return done();
    }
  } else if (input.schemaVersion === 1 && (input.projectId !== undefined || input.execution !== undefined)) {
    err('projectspec-not-film', 'schemaVersion', '这是 ProjectSpec v1（engine/production/project.js），不是 film.json', '用 fromProjectSpec() 转换，或另写 film.json v2');
    return done();
  } else if (input.schemaVersion !== FILM_SCHEMA_VERSION) {
    err('schema-version-unknown', 'schemaVersion', `未知的 schemaVersion：${JSON.stringify(input.schemaVersion)}；只接受 2（v1 不写 schemaVersion）`);
    return done();
  }

  // 2. 占位符：模版只能用 {{NAME}} / {{TITLE}}；作品里不能残留
  for (const ph of collectPlaceholders(source)) {
    if (!template) err('placeholder-left', ph.path, `残留占位符 {{${ph.name}}}`, '作品应由 node tools/new-film.mjs <a|b|c> <名字> 生成；手建的作品把占位符换成真值');
    else if (!['NAME', 'TITLE'].includes(ph.name)) err('placeholder-unknown', ph.path, `模版只允许 {{NAME}} / {{TITLE}}，这里是 {{${ph.name}}}`);
  }
  const f = template ? substitute(source) : clone(source);

  // 3. 字段白名单与"没有消费者的时间字段"
  const known = (obj, list, path, { compat = [] } = {}) => {
    if (!isObj(obj)) return;
    for (const k of Object.keys(obj)) {
      if (list.includes(k) || compat.includes(k)) continue;
      const where = path === '$' ? k : `${path}.${k}`;
      if (TIME_LIKE.test(k)) err('orphan-time-field', where, `${where} 是没有消费者的时间字段`, TIME_HINTS[k.toLowerCase()] ?? '时间只写在 shots（in/out）、events（frame/end）、holds、timeline、posterFrame，全部用整数帧；秒由帧数推出');
      else warn('unknown-field', where, `未知字段 ${where}（校验器不认识，消费者也不会读）`, '拼写错了就改正；确需新字段先在 engine/production/README.md 登记');
    }
  };
  known(f, FIELDS.top, '$', { compat: upgraded ? [] : FIELDS.compat });

  // 4. 身份与路线
  if (template) {
    if (source.id !== '{{NAME}}') err('template-id', 'id', `模版的 id 应为 "{{NAME}}"（由 new-film 替换），收到 ${JSON.stringify(source.id)}`);
    if (source.title !== '{{TITLE}}') err('template-title', 'title', `模版的 title 应为 "{{TITLE}}"，收到 ${JSON.stringify(source.title)}`);
  } else {
    if (!isStr(f.id)) err('id-missing', 'id', 'id 必须是非空字符串（与作品目录名相同）');
    else if (!FILM_ID.test(f.id)) err('id-invalid', 'id', `id 只能用小写字母、数字和短横线，字母或数字开头：${JSON.stringify(f.id)}`);
    else if (dirName && f.id !== dirName && !f.mirror) warn('id-dir-mismatch', 'id', `id「${f.id}」与目录名「${dirName}」不同`, '作品目录名就是 id');
    if (!isStr(f.title)) err('title-missing', 'title', 'title 必须是非空标题');
    else if (/["\\`<>\n]/.test(f.title)) err('title-invalid', 'title', 'title 不能含 " \\ ` < > 或换行（会直接写进 HTML / 脚本）');
  }
  const r = resolveRoute(f.route, registry);
  let route = null;
  if (!r) err('route-invalid', 'route', `route 必须是路线注册表里的值：${registry.routes.map(x => x.id).join(' / ')}，收到 ${JSON.stringify(f.route)}`, `注册表来源：${registry.source}`);
  else {
    route = r.route;
    if (r.alias) warn('route-alias', 'route', `route 写成了别名 ${JSON.stringify(f.route)}，规范值是 "${r.id}"`, `改成 "route": "${r.id}"`);
  }
  if (route) {
    if (f.backend === undefined) { if (!upgraded) err('backend-missing', 'backend', `backend 必填；${route.id} 路线可选：${route.backends.join(' / ')}`); }
    else if (Array.isArray(route.backends) && !route.backends.includes(f.backend)) err('backend-invalid', 'backend', `${route.brand} 的 backend 只能是 ${route.backends.join(' / ')}，收到 ${JSON.stringify(f.backend)}`);
  }

  // 5. 输出：帧数是唯一时长来源；尺寸与帧率必须等于档位
  const o = f.output;
  let fps = null, frameCount = null, profile = null;
  if (!isObj(o)) err('output-missing', 'output', 'output 必须是对象：{ profile, width, height, fps, frameCount }');
  else {
    known(o, FIELDS.output, 'output');
    if (!isStr(o.profile)) {
      if (upgraded) err('profile-unmatched', 'output.profile', `v1 记录的 ${o.width}×${o.height}@${o.fps} 不对应任何交付档位`, `迁到 v2 时写 output.profile，并按档位改画幅（新作品默认 ${profiles.default}）`);
      else err('profile-missing', 'output.profile', `output.profile 必填，取 profiles.json 里的档位（新作品默认 ${profiles.default}）`);
    } else if (!profiles.profiles[o.profile]) err('profile-unknown', 'output.profile', `没有交付档位 ${o.profile}`, `可用：${Object.keys(profiles.profiles).join('、')}`);
    else profile = getProfile(o.profile, profiles);
    for (const k of ['width', 'height']) {
      if (!posInt(o[k])) err('output-invalid', `output.${k}`, `${k} 必须是正整数像素`);
      else if (o[k] % 2) err('output-dimension-odd', `output.${k}`, `${k}=${o[k]} 是奇数；H.264 yuv420p 要求偶数`);
    }
    if (!posInt(o.fps)) err('output-invalid', 'output.fps', 'fps 必须是正整数'); else fps = o.fps;
    if (!posInt(o.frameCount)) err('output-invalid', 'output.frameCount', 'frameCount 必须是正整数：整片帧数是时长的唯一来源'); else frameCount = o.frameCount;
    if (profile) {
      const diff = ['width', 'height', 'fps'].filter(k => o[k] !== profile.video[k]).map(k => `${k} ${o[k]} ≠ ${profile.video[k]}`);
      if (diff.length) err('output-profile-mismatch', 'output', `output 与档位 ${profile.id} 不一致：${diff.join('，')}`, `按档位写 ${profile.video.width}×${profile.video.height}@${profile.video.fps}，或换一个匹配的档位`);
      if (profile.id === 'beiming-1040p24' && !f.mirror) warn('profile-reserved', 'output.profile', 'beiming-1040p24 是《北冥》样片专用档', `新作品默认 ${profiles.default}（决策 D07）；${template ? '模版迁到 v2 时写明 output.profile' : '确实沿用样片画幅就保留'}`);
    }
  }

  // 6. v1 兼容镜像字段（过渡期给旧版 repo-check / build.mjs 读）：必须与 output 一致
  if (!upgraded) {
    const mirrors = FIELDS.compat.filter(k => f[k] !== undefined);
    if (mirrors.length && isObj(o)) {
      const bad = [];
      if (f.dur !== undefined && !(finite(f.dur) && posInt(o.fps) && posInt(o.frameCount) && Math.abs(f.dur - o.frameCount / o.fps) < 1e-9)) bad.push(`dur=${JSON.stringify(f.dur)}（应为 ${o.frameCount}/${o.fps}）`);
      if (f.fps !== undefined && f.fps !== o.fps) bad.push(`fps=${JSON.stringify(f.fps)}（应为 ${o.fps}）`);
      if (f.size !== undefined && !(Array.isArray(f.size) && f.size[0] === o.width && f.size[1] === o.height && f.size.length === 2)) bad.push(`size=${JSON.stringify(f.size)}（应为 [${o.width}, ${o.height}]）`);
      if (bad.length) err('legacy-mirror-mismatch', '$', `v1 兼容镜像字段与 output 不一致：${bad.join('；')}`, '镜像字段只是 output 的抄本：删掉，或改成与 output 相同（retime 会同步改 dur）');
      else warn('legacy-mirror', '$', `保留了 v1 兼容镜像字段 ${mirrors.join('、')}（与 output 一致）`, '过渡期给旧版 tools/repo-check.mjs 与 engine/render/build.mjs 读；它们改读 film.js 后删除');
    }
  }

  // 7. 路径基准
  const isMirror = isObj(f.mirror);
  const pathBase = isMirror && f.mirror.paths === 'repo' ? REPO_ROOT : (filmDir ? resolve(filmDir) : null);
  const baseLabel = isMirror ? '仓库根' : '作品目录';
  // 模版里引用仓库资源的 ../../x 按复制后的位置 films/<名>/ 解析（与 tools/repo-check.mjs 的模版链接规则一致）
  const upBase = template ? join(REPO_ROOT, 'films', '__template__') : pathBase;
  const checkPath = (value, path, { output = false, required = false, dir = false, up = false } = {}) => {
    if (value === undefined || value === null) { if (required) err('path-missing', path, `${path} 必填`); return null; }
    if (!isStr(value)) { err('path-invalid', path, `${path} 必须是非空的相对路径`); return null; }
    const goesUp = up && /^(\.\.[\\/])+/.test(value.replace(/^\.[\\/]/, ''));
    if (goesUp) {
      const posix = value.replace(/\\/g, '/');
      if (isAbsolute(value) || /^[A-Za-z]:/.test(value) || /[\u0000-\u001f<>:"|?*]/.test(posix)) { err('path-invalid', path, `只能用相对路径：${value}`); return null; }
      if (upBase) {
        const abs = resolve(upBase, posix);
        const inRepo = relative(REPO_ROOT, abs);
        if (!inRepo || inRepo.startsWith('..') || isAbsolute(inRepo)) { err('path-invalid', path, `${value} 指到了仓库外`, '共享素材放仓库里（assets/、fonts/），从作品目录用 ../../ 引用'); return null; }
        if (checkFiles && !output && !existsSync(abs)) err('file-missing', path, `${value} 不存在（按${template ? '复制后的 films/<名>/' : baseLabel}解析）`);
      }
      return posix;
    }
    const n = normalizeRelativePath(value);
    if (!n.ok) { err('path-invalid', path, `${n.message}（收到 ${value}）`, `路径相对${baseLabel}，用正斜杠，不出界${up ? '（仓库里的共享素材可以用 ../../ 引用）' : ''}`); return null; }
    if (checkFiles && pathBase && !output) {
      const abs = resolve(pathBase, ...n.segments);
      if (!existsSync(abs)) err('file-missing', path, `${value} 不存在（按${baseLabel}解析）`);
      else if (dir !== statSync(abs).isDirectory()) err('path-kind', path, `${value} 应是${dir ? '目录' : '文件'}`);
    }
    return n.path;
  };

  if (isMirror) {
    known(f.mirror, FIELDS.mirror, 'mirror');
    if (f.mirror.paths !== 'repo') err('mirror-invalid', 'mirror.paths', 'mirror.paths 只能是 "repo"（镜像作品的路径相对仓库根）');
    if (!isStr(f.mirror.of)) err('mirror-invalid', 'mirror.of', 'mirror.of 写明镜像的是哪部样片');
    checkPath(f.mirror.outDir, 'mirror.outDir', { output: true, required: true });
    checkPath(f.mirror.check, 'mirror.check', { required: true });
    if (f.mirror.frozen !== true) err('mirror-invalid', 'mirror.frozen', '镜像作品的源码是冻结基准：mirror.frozen 必须是 true');
  }

  // 8. 入口
  const defaultEntry = route?.id === 'b' ? (f.native?.entry ?? 'film.tsx') : 'index.html';
  checkPath(f.entry ?? defaultEntry, f.entry === undefined ? 'entry（默认）' : 'entry');

  // 9. 镜头表
  const shots = Array.isArray(f.shots) ? f.shots : null;
  const shotDiag = checkShots(f.shots, frameCount);
  for (const d of shotDiag) err(d.code, d.path, d.message, d.hint);
  const shotsOk = !shotDiag.length && frameCount !== null;
  const shotById = new Map();
  if (shots) shots.forEach((s, i) => {
    const p = `shots[${i}]`;
    if (!isObj(s)) return;
    if (isStr(s.id)) shotById.set(s.id, s);
    for (const legacy of ['inFrame', 'outFrame']) if (s[legacy] !== undefined) err('shot-legacy-field', `${p}.${legacy}`, `v2 的镜头区间写 in / out（不是 ${legacy}）`);
    if (s.visibleEvents !== undefined) err('shot-events-inline', `${p}.visibleEvents`, '事件统一写在顶层 events[]（一个事件只写一处）', '每条写 { id, frame, shot, visual }');
    known(Object.fromEntries(Object.entries(s).filter(([k]) => !['inFrame', 'outFrame', 'visibleEvents'].includes(k))), FIELDS.shot, p);
    if (s.module !== undefined) checkPath(s.module, `${p}.module`);
    if (s.backend !== undefined && route && Array.isArray(route.backends) && !route.backends.includes(s.backend)) err('backend-invalid', `${p}.backend`, `镜头后端只能是 ${route.backends.join(' / ')}`);
    if (s.evaluation !== undefined && !EVALUATIONS.includes(s.evaluation)) err('shot-evaluation-invalid', `${p}.evaluation`, `evaluation 只能是 ${EVALUATIONS.join(' / ')}（docs/routes/contracts.md §5）`);
    if (s.transition !== undefined) {
      if (!TRANSITIONS.includes(s.transition)) err('shot-transition-invalid', `${p}.transition`, `transition（进入本镜的方式）只能是 ${TRANSITIONS.join(' / ')}`);
      else if (i === 0 && !['cut', 'fade'].includes(s.transition)) err('shot-transition-invalid', `${p}.transition`, '第一镜只能是 cut（直接开始）或 fade（从黑场淡入）');
    }
    for (const k of ['name', 'purpose', 'lookPreset', 'framing', 'angle', 'desc', 'note']) if (s[k] !== undefined && !isStr(s[k])) err('shot-field-invalid', `${p}.${k}`, `${k} 必须是非空字符串`);
    const tracks = s.tracks;
    const trackIds = new Set();
    if (tracks !== undefined) {
      if (!Array.isArray(tracks)) err('shot-tracks-invalid', `${p}.tracks`, 'tracks 必须是 [{ id, step }] 数组');
      else tracks.forEach((tr, k) => {
        if (!isObj(tr) || !SHOT_OR_TRACK_ID.test(tr.id ?? '')) { err('shot-tracks-invalid', `${p}.tracks[${k}]`, '每条轨道要有合法 id'); return; }
        if (trackIds.has(tr.id)) err('shot-tracks-invalid', `${p}.tracks[${k}]`, `轨道 id 重复：${tr.id}`);
        trackIds.add(tr.id);
        if (!(Number.isInteger(tr.step) && tr.step >= 1 && tr.step <= 12)) err('shot-tracks-invalid', `${p}.tracks[${k}].step`, 'step（一拍几）必须是 1–12 的整数');
        known(tr, ['id', 'step', 'note'], `${p}.tracks[${k}]`);
      });
    }
    const origins = s.actorClockOrigin;
    if (origins !== undefined) {
      if (!isObj(origins)) err('shot-origin-invalid', `${p}.actorClockOrigin`, 'actorClockOrigin 是 { 轨道 id: 全局起点帧 }');
      else for (const [tk, fr] of Object.entries(origins)) {
        if (!nonNegInt(fr)) err('shot-origin-invalid', `${p}.actorClockOrigin.${tk}`, '角色起点必须是非负整数帧（全局帧）');
        else if (nonNegInt(s.in) && fr > s.in) err('shot-origin-invalid', `${p}.actorClockOrigin.${tk}`, `角色起点 ${fr} 晚于镜头入点 ${s.in}`, '延迟启动用轨道内的事件表达（docs/routes/contracts.md §3）');
        if (tracks !== undefined && !trackIds.has(tk)) warn('shot-origin-orphan', `${p}.actorClockOrigin.${tk}`, `轨道 ${tk} 没在 tracks 里声明`);
      }
    }
    if (Array.isArray(tracks) && nonNegInt(s.in) && nonNegInt(s.out)) {
      for (const tr of tracks) {
        if (!(Number.isInteger(tr?.step) && tr.step > 1)) continue;
        const origin = nonNegInt(origins?.[tr.id]) ? origins[tr.id] : 0;
        const bad = [['入点', s.in], ['出点', s.out]].filter(([, fr]) => (fr - origin) % tr.step !== 0);
        if (bad.length) {
          const m = tracks.filter(x => Number.isInteger(x?.step) && x.step > 1).reduce((acc, x) => lcm(acc, x.step), 1);
          warn('cut-off-step', p, `镜头 ${s.id} 的${bad.map(([k, fr]) => `${k} ${fr}`).join('、')}没落在轨道 ${tr.id}（一拍 ${tr.step}，起点 ${origin}）的画格上，切点会截出半拍`,
            `切点放在本镜各轨道的公倍数帧（这里是 ${m} 的倍数）；见 routes/directing/craft/animation.md §2.3`);
        }
      }
    }
  });

  // 10. 节拍
  let grid = null;
  if (f.drive !== undefined && !DRIVES.includes(f.drive)) err('drive-invalid', 'drive', `drive 只能是 ${DRIVES.join(' / ')}（画面 / 节拍 / 旁白主导）`);
  if (f.timeline !== undefined) {
    known(f.timeline, FIELDS.timeline, 'timeline');
    if (fps && frameCount) {
      try {
        grid = beatGrid(f.timeline, { fps, frameCount });
        const off = offGrid(grid);
        if (off.length) {
          const worst = off.reduce((a, b) => (b.errorMs > a.errorMs ? b : a));
          warn('beats-off-frame', 'timeline', `${off.length} 个拍点不落整帧（最大 ${worst.errorMs.toFixed(2)} ms，第 ${worst.beat} 拍）`, `事件帧按 floor 取（画面先到）；想每拍整帧就选 fps × 60 / BPM 为整数的速度（${fps} fps 下如 ${[60, 72, 90, 120, 144].filter(b => Number.isInteger(fps * 60 / b)).join(' / ')} BPM）`);
        }
      } catch (error) {
        if (!(error instanceof TimelineError)) throw error;
        err(error.code, 'timeline', error.message, error.hint);
      }
    }
  } else if (f.drive === 'beat') err('timeline-missing', 'timeline', 'drive 为 beat（节拍主导）时必须写 timeline');

  // 11. 事件
  const events = f.events ?? [];
  const eventIds = new Set();
  if (!Array.isArray(events)) err('events-invalid', 'events', 'events 必须是数组');
  else events.forEach((e, i) => {
    const p = `events[${i}]`;
    if (!isObj(e)) { err('event-invalid', p, '事件必须是对象'); return; }
    known(e, FIELDS.event, p);
    if (!isStr(e.id) || !EVENT_ID.test(e.id)) err('event-id-invalid', `${p}.id`, `事件 id 用「组.名[.序号]」（字母数字点下划线冒号短横线）：${JSON.stringify(e.id)}`);
    else if (eventIds.has(e.id)) err('event-id-duplicate', `${p}.id`, `事件 id 重复：${e.id}`);
    else eventIds.add(e.id);
    if (!nonNegInt(e.frame)) { err('event-frame-invalid', `${p}.frame`, `frame 必须是非负整数帧（结果帧），收到 ${JSON.stringify(e.frame)}`); return; }
    if (frameCount !== null && e.frame >= frameCount) err('event-out-of-range', `${p}.frame`, `第 ${e.frame} 帧超出整片 [0, ${frameCount})`);
    if (!isStr(e.shot)) err('event-shot-missing', `${p}.shot`, '每个事件写明所属镜头 shot（结果帧所在的镜头）');
    else if (!shotById.has(e.shot)) err('event-shot-unknown', `${p}.shot`, `没有镜头 ${e.shot}`, `可用：${[...shotById.keys()].join('、')}`);
    else if (shotsOk) {
      const s = shotById.get(e.shot);
      if (e.frame < s.in || e.frame >= s.out) {
        const real = shots.find(x => e.frame >= x.in && e.frame < x.out);
        err('event-outside-shot', `${p}.frame`, `事件 ${e.id} 的第 ${e.frame} 帧不在镜头 ${e.shot} [${s.in}, ${s.out}) 里${real ? `（它落在 ${real.id}）` : ''}`,
          '镜头改过切点却没动事件：用 film.js retime 改切点，事件会跟着镜头走');
      }
    }
    if (e.end !== undefined) {
      if (!nonNegInt(e.end) || e.end <= e.frame) err('event-end-invalid', `${p}.end`, `end（不含）必须是大于 frame 的整数帧，收到 ${JSON.stringify(e.end)}`);
      else if (frameCount !== null && e.end > frameCount) err('event-end-invalid', `${p}.end`, `end=${e.end} 超出整片 ${frameCount}`);
    }
    if (e.audio !== undefined && !(isStr(e.audio) && CUE_ID.test(e.audio))) err('event-audio-invalid', `${p}.audio`, 'audio 是声音表里的 cue id（字符串）');
    if (e.visual !== undefined && !isStr(e.visual)) err('event-visual-invalid', `${p}.visual`, 'visual 是这一帧看得见的结果（非空字符串）');
    if (e.audio === undefined && e.visual === undefined && e.domain === undefined) warn('event-empty', p, `事件 ${e.id} 既没有 visual 也没有 audio`, '写明这一帧看见什么（visual）或响什么（audio），否则没人消费它');
    if (e.domain !== undefined && !EVENT_DOMAINS.includes(e.domain)) err('event-domain-invalid', `${p}.domain`, `domain 只能是 ${EVENT_DOMAINS.join(' / ')}`);
    if (e.sync !== undefined && typeof e.sync !== 'boolean') err('event-sync-invalid', `${p}.sync`, 'sync 是布尔值：false = 渐入 / 铺底类，不做起音对拍');
    if (e.source !== undefined && !['plan', 'probe'].includes(e.source)) err('event-source-invalid', `${p}.source`, 'source 只能是 plan（计划时刻）或 probe（按画面实测）');
    if (e.cue !== undefined && typeof e.cue !== 'boolean') err('event-cue-invalid', `${p}.cue`, 'cue 是布尔值：true = 画面打点（cuecheck 对拍）');
    if (e.beat !== undefined) {
      if (!(finite(e.beat) && e.beat >= 0)) err('event-beat-invalid', `${p}.beat`, 'beat 是从 0 起的绝对拍号（可带小数）');
      else if (f.timeline === undefined) err('event-beat-without-timeline', `${p}.beat`, '事件写了 beat，但 film.json 没有 timeline');
      else if (grid) {
        try {
          const at = frameOfBeat(grid, e.beat), want = Math.floor(at + FRAME_EPS);
          if (want !== e.frame) err('event-beat-mismatch', `${p}.frame`, `第 ${e.beat} 拍在第 ${+at.toFixed(3)} 帧（取 floor → ${want}），事件写的是 ${e.frame}`, '拍点与帧号同源：改其中一个，不要两处各写');
        } catch (error) {
          if (!(error instanceof TimelineError)) throw error;
          err(error.code, `${p}.beat`, error.message, error.hint);
        }
      }
    }
    for (const k of ['desc', 'note']) if (e[k] !== undefined && !isStr(e[k])) err('event-field-invalid', `${p}.${k}`, `${k} 必须是非空字符串`);
  });

  // 12. 停顿（QA 的黑场 / 静帧豁免依据）
  if (f.holds !== undefined) {
    if (!Array.isArray(f.holds)) err('holds-invalid', 'holds', 'holds 是 [{ in, out, kind, reason }]');
    else f.holds.forEach((h, i) => {
      const p = `holds[${i}]`;
      if (!isObj(h)) { err('hold-invalid', p, '停顿必须是对象'); return; }
      known(h, FIELDS.hold, p);
      if (!nonNegInt(h.in) || !nonNegInt(h.out) || h.out <= h.in) err('hold-invalid', p, '停顿是半开区间 [in, out)，整数帧，out > in');
      else if (frameCount !== null && h.out > frameCount) err('hold-invalid', p, `停顿 [${h.in}, ${h.out}) 超出整片 ${frameCount}`);
      if (!HOLD_KINDS.includes(h.kind)) err('hold-invalid', `${p}.kind`, `kind 只能是 ${HOLD_KINDS.join(' / ')}`);
      if (!isStr(h.reason)) err('hold-invalid', `${p}.reason`, '写明为什么要这段停顿或黑场（QA 据此豁免）');
    });
  }
  if (f.posterFrame !== undefined && !(nonNegInt(f.posterFrame) && (frameCount === null || f.posterFrame < frameCount))) {
    err('poster-invalid', 'posterFrame', `posterFrame 是 [0, ${frameCount ?? 'frameCount'}) 里的整数帧`);
  }

  // 13. 声音
  const profileAudio = profile?.audio;
  if (f.audio === undefined) {
    if (!upgraded && route && route.id !== 'b') warn('audio-missing', 'audio', '没写 audio：按无声片处理', '有声音就写 { "mode": "script", "script": "sound.py" } 或 { "mode": "wav", "wav": "…" }');
  } else if (!isObj(f.audio)) err('audio-invalid', 'audio', 'audio 必须是对象');
  else {
    const a = f.audio;
    known(a, FIELDS.audio, 'audio');
    if (!AUDIO_MODES.includes(a.mode)) err('audio-mode-invalid', 'audio.mode', `audio.mode 只能是 ${AUDIO_MODES.join(' / ')}`);
    else if (a.mode === 'native' && route?.id !== 'b') err('audio-mode-invalid', 'audio.mode', 'mode = native 只用于 B 路线（声音由 native.audio 准备）');
    if (a.mode === 'script') checkPath(a.script, 'audio.script', { required: true });
    if (a.mode === 'wav') checkPath(a.wav, 'audio.wav', { output: true, required: true });
    if (a.mode === 'none' && (a.script || a.wav)) warn('audio-mode-conflict', 'audio', 'mode = none 却写了 script / wav：不会被执行');
    if (a.cues !== undefined) checkPath(a.cues, 'audio.cues');
    if (a.mode === 'script' && route?.id === 'b' && f.native?.audio?.script && a.script !== f.native.audio.script) {
      err('audio-native-conflict', 'audio.script', `audio.script（${a.script}）与 native.audio.script（${f.native.audio.script}）不一致`, 'B 路线的声音写在 native.audio；film.audio 写 { "mode": "native" }');
    }
    if (a.targetLUFS !== undefined) {
      if (!finite(a.targetLUFS)) err('audio-target-invalid', 'audio.targetLUFS', 'targetLUFS 必须是数字');
      else if (profileAudio && Math.abs(a.targetLUFS - profileAudio.loudness.integratedLUFS) > profileAudio.loudness.toleranceLU + 1e-9) {
        err('audio-target-profile', 'audio.targetLUFS', `混音目标 ${a.targetLUFS} LUFS 落在档位 ${profile.id} 的窗口外（${profileAudio.loudness.integratedLUFS} ± ${profileAudio.loudness.toleranceLU} LU）`, '删掉 targetLUFS 就按档位取值');
      }
    }
    if (a.truePeakDbTP !== undefined) {
      if (!finite(a.truePeakDbTP) || a.truePeakDbTP > 0) err('audio-target-invalid', 'audio.truePeakDbTP', 'truePeakDbTP 必须是 ≤ 0 的数字');
      else if (profileAudio && a.truePeakDbTP > profileAudio.truePeakMaxDbTP + 1e-9) err('audio-target-profile', 'audio.truePeakDbTP', `真峰值目标 ${a.truePeakDbTP} dBTP 高于档位上限 ${profileAudio.truePeakMaxDbTP}`);
    }
  }

  // 14. 交付清单
  if (f.deliveries !== undefined) {
    if (!Array.isArray(f.deliveries) || !f.deliveries.length || !f.deliveries.every(isStr)) err('deliveries-invalid', 'deliveries', 'deliveries 是档位 id 的非空数组');
    else {
      if (new Set(f.deliveries).size !== f.deliveries.length) err('deliveries-invalid', 'deliveries', 'deliveries 有重复');
      for (const [i, id] of f.deliveries.entries()) {
        const p = profiles.profiles[id];
        if (!p) { err('profile-unknown', `deliveries[${i}]`, `没有交付档位 ${id}`); continue; }
        if (profile && p.video.fps !== profile.video.fps) err('delivery-fps-mismatch', `deliveries[${i}]`, `${id} 是 ${p.video.fps} fps，渲染档 ${profile.id} 是 ${profile.video.fps} fps`, '帧率不同的交付要单独的作品描述（一拍 n 与全部帧号都会变）');
        if (profile && Math.abs(p.video.width / p.video.height - profile.video.width / profile.video.height) > 0.01) err('delivery-aspect-mismatch', `deliveries[${i}]`, `${id} 的画幅比与渲染档 ${profile.id} 不同`, '换画幅比要重新做版式（另一份作品描述），不能直接缩放');
      }
      if (isStr(o?.profile) && !f.deliveries.includes(o.profile)) warn('delivery-without-render-profile', 'deliveries', `deliveries 不含渲染档 ${o.profile}`);
    }
  }

  // 15. 风格、资产、署名、AIGC
  if (f.style === undefined) {
    if (route?.id === 'a') (upgraded || template ? warn : err)('style-missing', 'style', '北冥风格路线必须写 style：{ id, version, baseline }（视觉基准）');
  } else if (!isObj(f.style)) err('style-invalid', 'style', 'style 必须是对象');
  else {
    known(f.style, FIELDS.style, 'style');
    if (!isStr(f.style.id)) err('style-invalid', 'style.id', 'style.id 必须是非空字符串');
    if (!(posInt(f.style.version) || (isStr(f.style.version) && /^v?\d+(\.\d+)*$/.test(f.style.version)))) err('style-invalid', 'style.version', 'style.version 是正整数或 v1.1 这类版本号');
    if (f.style.baseline !== undefined) checkPath(f.style.baseline, 'style.baseline', { up: true });
    else if (route?.id === 'a') warn('style-baseline-missing', 'style.baseline', '北冥风格路线最好写视觉基准（基准帧或风格锁定文件）');
    if (f.style.lock !== undefined) checkPath(f.style.lock, 'style.lock', { up: true });
  }
  if (f.assets !== undefined) {
    if (!Array.isArray(f.assets)) err('assets-invalid', 'assets', 'assets 是资产 id 数组，如 ["kun@v1", "plate:sky_dawn"]');
    else {
      f.assets.forEach((a, i) => { if (!(typeof a === 'string' && ASSET_ID.test(a))) err('asset-id-invalid', `assets[${i}]`, `资产 id 写成「种类:名字@版本」，收到 ${JSON.stringify(a)}`); });
      if (new Set(f.assets).size !== f.assets.length) err('assets-invalid', 'assets', 'assets 有重复');
    }
  }
  if (f.credits === undefined) (upgraded ? warn : err)('credits-missing', 'credits', '没有 credits：列出字体、采样、素材、第三方代码的署名与许可（没有就写 []）');
  else if (!Array.isArray(f.credits)) err('credits-invalid', 'credits', 'credits 是 [{ what, owner, license, source }]');
  else f.credits.forEach((c, i) => {
    const p = `credits[${i}]`;
    if (!isObj(c)) { err('credit-invalid', p, '署名条目必须是对象'); return; }
    known(c, FIELDS.credit, p);
    if (!isStr(c.what)) err('credit-invalid', `${p}.what`, 'what（署名的是什么）必填');
    if (!isStr(c.license)) err('credit-invalid', `${p}.license`, 'license 必填（SPDX 标识或授权说明）');
    else if (/待补|unknown|TBD/i.test(c.license)) warn('credit-license-pending', `${p}.license`, `${c.what ?? '该条'} 的许可还是「${c.license}」`, '授权状态登记在 docs/rights/；交付前补齐');
    if (!isStr(c.owner) && !isStr(c.source)) warn('credit-incomplete', p, `${c.what ?? '该条'} 没写 owner 或 source`);
  });
  if (f.aigc === undefined) (upgraded ? warn : err)('aigc-missing', 'aigc', `没有 aigc：写明是否含 AI 生成内容（决策 D11：含则片尾或说明写「${AIGC_MARK}」，mp4 comment 元数据同写）`);
  else if (!isObj(f.aigc)) err('aigc-invalid', 'aigc', 'aigc 是 { contains, note }');
  else {
    known(f.aigc, FIELDS.aigc, 'aigc');
    if (typeof f.aigc.contains !== 'boolean') err('aigc-invalid', 'aigc.contains', 'contains 必须是 true / false');
    if (f.aigc.contains === true && !isStr(f.aigc.note)) err('aigc-invalid', 'aigc.note', '含 AI 生成内容时写明哪些部分、怎么生成、怎么整理');
  }

  // 16. 闸门：只能全开，跳过要有用户原话的豁免记录
  if (f.gates !== undefined) {
    if (!isObj(f.gates)) err('gates-invalid', 'gates', 'gates 是 { look, animatic, final }');
    else for (const [k, v] of Object.entries(f.gates)) {
      if (!GATE_KEYS.includes(k)) err('gates-invalid', `gates.${k}`, `闸门只有 ${GATE_KEYS.join(' / ')}（⛔1 结构确认只记录不阻断，不写在这里）`);
      else if (v !== 'required') err('gates-relaxed', `gates.${k}`, `闸门不能在 film.json 里关掉（收到 ${JSON.stringify(v)}）`, `用户同意跳过时记录豁免：node engine/production/film.js review <作品> --gate ${k} --decision waive --quote "<用户原话>" --source-ref "<出处>"`);
    }
  }

  // 17. 路线专属段
  if (f.native !== undefined) {
    if (route && route.id !== 'b') err('native-wrong-route', 'native', 'native 段只属于 B 路线（北冥原生 · BNE）');
    else validateNative(f.native, { err, warn, known, checkPath });
  } else if (route?.id === 'b' && !template && !upgraded) warn('native-missing', 'native', 'B 路线没有 native 段：入口、素材与封装都按默认值');
  if (f.cuecheck !== undefined) {
    if (route && route.id === 'b') err('cuecheck-wrong-route', 'cuecheck', 'cuecheck 段用于页面型路线（A / C）；B 路线用原生运行时的检查');
    else if (!isObj(f.cuecheck)) err('cuecheck-invalid', 'cuecheck', 'cuecheck 是 { grid, tolMs, silence, quietDb }');
    else {
      const c = f.cuecheck;
      known(c, FIELDS.cuecheck, 'cuecheck');
      if (c.grid !== undefined && !posInt(c.grid)) err('cuecheck-invalid', 'cuecheck.grid', 'grid（拍内细分）必须是正整数：2 = 八分音符');
      if (c.tolMs !== undefined && !(finite(c.tolMs) && c.tolMs >= 0)) err('cuecheck-invalid', 'cuecheck.tolMs', 'tolMs 必须是 ≥ 0 的毫秒数');
      if (c.silence !== undefined && !(Array.isArray(c.silence) && c.silence.every(isStr))) err('cuecheck-invalid', 'cuecheck.silence', 'silence 是要求安静的段落 id 数组');
      if (c.quietDb !== undefined && !finite(c.quietDb)) err('cuecheck-invalid', 'cuecheck.quietDb', 'quietDb 必须是数字（dB）');
    }
  }

  // 18. 文档与方法出处
  if (f.docs !== undefined) {
    if (!isObj(f.docs)) err('docs-invalid', 'docs', 'docs 是 { brief, treatment, bible, styleLock, review }');
    else { known(f.docs, FIELDS.docs, 'docs'); for (const k of FIELDS.docs) if (f.docs[k] !== undefined) checkPath(f.docs[k], `docs.${k}`, { dir: k === 'review' }); }
  }
  if (f.methodRefs !== undefined) {
    if (!Array.isArray(f.methodRefs)) err('method-refs-invalid', 'methodRefs', 'methodRefs 是 [{ caseId, borrowed, license, … }]');
    else f.methodRefs.forEach((m, i) => {
      const p = `methodRefs[${i}]`;
      if (!isObj(m)) { err('method-ref-invalid', p, '必须是对象'); return; }
      known(m, FIELDS.methodRef, p);
      if (!isStr(m.caseId) || !isStr(m.borrowed)) err('method-ref-invalid', p, 'caseId 与 borrowed（借了什么）必填');
      if (m.catalogStatus === 'rejected') err('method-ref-rejected', `${p}.catalogStatus`, `${m.caseId} 是被用户否定的作品，只能当反例，不能作正面依据`, '见 routes/directing/DIRECTING.md §0');
      if (!isStr(m.license)) warn('method-ref-license', `${p}.license`, '写明被借部分的许可（第三方代码保留原作者版权声明）');
    });
  }
  if (f.notes !== undefined && !isStr(f.notes)) err('notes-invalid', 'notes', 'notes 是说明文字');

  // 19. 页面自带的时间常量（页面也是时间源时必须一致）
  if (filmDir && !isMirror && fps && frameCount) {
    const tl = join(filmDir, 'timeline.js');
    if (existsSync(tl)) {
      const src = readFileSync(tl, 'utf8');
      const dur = /export\s+const\s+DUR\s*=\s*(\d+(?:\.\d+)?)\s*;/.exec(src), pf = /export\s+const\s+FPS\s*=\s*(\d+)\s*;/.exec(src);
      if (pf && +pf[1] !== fps) err('page-timing-mismatch', 'timeline.js', `timeline.js 的 FPS=${pf[1]} 与 film.json 的 ${fps} 不同`, '页面的时间常量要从 film.json 读，或与它保持一致');
      if (dur && Math.abs(+dur[1] * (pf ? +pf[1] : fps) - frameCount) > 1e-6) err('page-timing-mismatch', 'timeline.js', `timeline.js 的 DUR=${dur[1]} 秒 × ${pf ? pf[1] : fps} fps ≠ frameCount ${frameCount}`, `改成 DUR = ${frameCount / fps}，或让页面读 film.json`);
    }
  }

  const film = diagnostics.some(d => d.level === 'error') ? null : normalize(source, { route, profile });
  return { ok: !diagnostics.some(d => d.level === 'error'), film, diagnostics, upgraded, notes };
}

function validateNative(n, { err, warn, known, checkPath }) {
  if (!isObj(n)) { err('native-invalid', 'native', 'native 段必须是对象'); return; }
  known(n, FIELDS.native, 'native');
  const mediaName = (to, path) => {
    if (!(typeof to === 'string' && to && (/^[\w.-]+$/.test(to) || /^[\w.-]+\/[\w.-]+$/.test(to)))) err('native-invalid', path, `to 只能是 media/ 下的文件名（可带一层子目录），收到 ${JSON.stringify(to)}`);
  };
  if (n.entry !== undefined) checkPath(n.entry, 'native.entry');
  if (n.output !== undefined) checkPath(n.output, 'native.output', { output: true });
  if (n.mux !== undefined && !['mux.sh', 'copy'].includes(n.mux)) err('native-invalid', 'native.mux', 'mux 只能是 mux.sh 或 copy');
  for (const list of ['images', 'models', 'sequences']) {
    if (n[list] === undefined) continue;
    if (!Array.isArray(n[list])) { err('native-invalid', `native.${list}`, `${list} 必须是数组`); continue; }
    n[list].forEach((x, i) => {
      const p = `native.${list}[${i}]`;
      if (!isObj(x)) { err('native-invalid', p, '必须是对象'); return; }
      mediaName(x.to, `${p}.to`);
      if (list === 'images') checkPath(x.from, `${p}.from`, { required: true, up: true });
      if (list === 'models') {
        const kinds = ['from', 'module', 'recipe'].filter(k => x[k] !== undefined);
        if (kinds.length !== 1) err('native-invalid', p, '模型条目要有且只有 from（外部文件）/ module（代码生成）/ recipe（配方）之一');
        if (x.from !== undefined) checkPath(x.from, `${p}.from`, { up: true });
        if (x.module !== undefined) { checkPath(x.module, `${p}.module`); if (!isStr(x.export)) err('native-invalid', `${p}.export`, '代码生成的模型要写导出函数名 export'); }
        if (x.clip?.duration !== undefined && !(finite(x.clip.duration) && x.clip.duration > 0)) err('native-invalid', `${p}.clip.duration`, '动画片段时长必须是正数（秒，导出器读）');
      }
      if (list === 'sequences') {
        const kinds = ['page', 'video', 'frames'].filter(k => x[k] !== undefined);
        if (kinds.length !== 1) err('native-invalid', p, '序列帧条目要有且只有 page / video / frames 之一');
        else checkPath(x[kinds[0]], `${p}.${kinds[0]}`, { up: true, dir: kinds[0] !== 'video' });
        for (const k of ['from', 'until']) if (x[k] !== undefined && !(finite(x[k]) && x[k] >= 0)) err('native-invalid', `${p}.${k}`, `${k} 必须是 ≥ 0 的数字`);
        if (finite(x.from) && finite(x.until) && x.until <= x.from) err('native-invalid', p, 'until 必须大于 from');
      }
    });
  }
  if (n.audio !== undefined) {
    if (!isObj(n.audio)) err('native-invalid', 'native.audio', 'native.audio 是 { script, out }');
    else {
      checkPath(n.audio.script, 'native.audio.script', { required: true });
      if (n.audio.out !== undefined) mediaName(n.audio.out, 'native.audio.out');
    }
  }
}

/** 补齐默认值（不改入参）。 */
function normalize(source, { route, profile }) {
  const f = clone(source);
  f.route = route?.id ?? f.route;
  f.events = Array.isArray(f.events) ? f.events : [];
  f.holds = Array.isArray(f.holds) ? f.holds : [];
  f.drive = f.drive ?? 'picture';
  f.gates = { look: 'required', animatic: 'required', final: 'required' };
  f.deliveries = Array.isArray(f.deliveries) ? f.deliveries : [f.output.profile];
  f.entry = f.entry ?? (f.route === 'b' ? (f.native?.entry ?? 'film.tsx') : 'index.html');
  const a = f.audio ?? { mode: f.route === 'b' ? (f.native?.audio ? 'native' : 'none') : 'none' };
  f.audio = { ...a, targetLUFS: a.targetLUFS ?? profile?.audio.loudness.integratedLUFS, truePeakDbTP: a.truePeakDbTP ?? profile?.audio.truePeakMaxDbTP };
  for (const k of FIELDS.compat) delete f[k];
  return f;
}

// ───────────────────────── 载入、写回、改切点 ─────────────────────────

/** target 是作品目录或 film.json 路径。文件问题抛 FilmError（不存在 → 2，坏 JSON → 4，读不出 → 1）；校验问题放在 diagnostics。 */
export function loadFilm(target, opts = {}) {
  if (!isStr(target)) throw new FilmError('usage', '要给出作品目录或 film.json 路径', { exitCode: 2 });
  const abs = resolve(target);
  let file = abs;
  if (existsSync(abs) && statSync(abs).isDirectory()) file = join(abs, 'film.json');
  else if (!abs.toLowerCase().endsWith('.json')) file = join(abs, 'film.json');
  const filmDir = dirname(file);
  const r = readJsonFile(file);
  if (!r.ok) {
    if (r.code === 'not-found') throw new FilmError('not-found', r.message, { exitCode: 2, hint: '给作品目录（films/<名>）或 film.json 的路径；新建作品用 node tools/new-film.mjs' });
    if (r.code === 'json-invalid') throw new FilmError('json-invalid', r.message, { exitCode: 4, hint: '修好 JSON 语法（多余逗号、注释、引号）再试' });
    throw new FilmError('unreadable', r.message, { exitCode: 1 });
  }
  const result = validateFilm(r.value, { ...opts, filmDir });
  const pathBase = isObj(r.value.mirror) && r.value.mirror.paths === 'repo' ? REPO_ROOT : filmDir;
  return { ...result, raw: r.value, text: r.text, filmDir, file, pathBase };
}

export function assertValidFilm(result, label = 'film.json') {
  if (result.ok) return result.film;
  const errors = result.diagnostics.filter(d => d.level === 'error');
  throw new FilmError('contract', `${label} 不合格：${errors.length} 个错误；第一个：[${errors[0].code}] ${errors[0].path}：${errors[0].message}`, { exitCode: 4, hint: errors[0].hint || '运行 node engine/production/film.js check <作品> 看全部诊断', diagnostics: result.diagnostics });
}

export const formatFilmJson = value => formatJson(value);
export function writeFilmJson(file, value) {
  return writeJsonAtomic(file, value);
}

/** 在原始记录上改切点（保留作者写的结构），改完重新校验；不合格时抛 FilmError，不写文件。 */
export function retime(raw, shotId, change, { mode = 'ripple', filmDir = null } = {}) {
  if (raw?.schemaVersion !== FILM_SCHEMA_VERSION) throw new FilmError('retime-v1', 'v1 记录没有镜头表，不能改切点', { hint: '先迁到 v2：node engine/production/film.js upgrade <作品> --write' });
  let res;
  try { res = retimeShot(raw, shotId, change, { mode }); } catch (error) {
    if (error instanceof TimelineError) throw new FilmError(error.code, error.message, { hint: error.hint, exitCode: error.code === 'shot-unknown' || error.code === 'retime-args' || error.code === 'mode-invalid' ? 2 : 4 });
    throw error;
  }
  const check = validateFilm(res.film, { filmDir, checkFiles: false });
  if (!check.ok) assertValidFilm(check, '改切点后的 film.json');
  return { ...res, film: res.film, normalized: check.film, diagnostics: check.diagnostics };
}

// ───────────────────────── QA 期望值 ─────────────────────────

/** 一部作品交给 QA 的全部期望值。改 film.json（例如某镜的 out），这里的帧数、切点、事件随之变化。 */
export function qaExpectations(film, { profiles = loadProfiles() } = {}) {
  const p = getProfile(film.output.profile, profiles);
  const fps = film.output.fps, n = film.output.frameCount;
  return {
    schemaVersion: 1,
    film: film.id,
    profile: p.id,
    deliveries: film.deliveries ?? [p.id],
    video: { width: p.video.width, height: p.video.height, fps, frameCount: n, durationSeconds: n / fps, codec: p.video.codec, codecProfile: p.video.codecProfile, pixFmt: p.video.pixFmt, sar: p.video.sar, cfr: p.video.cfr, fieldOrder: p.video.fieldOrder, color: { ...p.video.color } },
    audio: {
      expected: film.audio?.mode !== 'none',
      codec: p.audio.codec, sampleRate: p.audio.sampleRate, channels: p.audio.channels, channelLayout: p.audio.channelLayout,
      loudness: { integratedLUFS: p.audio.loudness.integratedLUFS, toleranceLU: p.audio.loudness.toleranceLU, min: p.audio.loudness.integratedLUFS - p.audio.loudness.toleranceLU, max: p.audio.loudness.integratedLUFS + p.audio.loudness.toleranceLU, measure: p.audio.loudness.measure },
      truePeakMaxDbTP: p.audio.truePeakMaxDbTP,
      mixTarget: { integratedLUFS: film.audio?.targetLUFS ?? p.audio.loudness.integratedLUFS, truePeakDbTP: film.audio?.truePeakDbTP ?? p.audio.truePeakMaxDbTP },
    },
    ffprobe: ffprobeExpect(p),
    container: { ...p.container },
    sync: { ...p.sync },
    safeArea: clone(p.safeArea),
    shots: film.shots.map(s => ({ id: s.id, in: s.in, out: s.out, length: s.out - s.in, seconds: [s.in / fps, s.out / fps], transition: s.transition ?? 'cut' })),
    cuts: film.shots.slice(1).map((s, i) => ({ frame: s.in, seconds: s.in / fps, from: film.shots[i].id, to: s.id, transition: s.transition ?? 'cut', hard: (s.transition ?? 'cut') === 'cut' })),
    events: film.events.map(e => ({ id: e.id, frame: e.frame, seconds: e.frame / fps, shot: e.shot, end: e.end, audio: e.audio, visual: e.visual, sync: e.sync ?? (e.audio !== undefined), beat: e.beat })),
    holds: film.holds.map(h => ({ ...h, seconds: [h.in / fps, h.out / fps] })),
    posterFrame: film.posterFrame ?? null,
    aigc: { contains: film.aigc?.contains ?? null, markerRequired: film.aigc?.contains === true, marker: AIGC_MARK, metadataKey: 'comment' },
  };
}

// ───────────────────────── 与 ProjectSpec v1 的映射 ─────────────────────────

/**
 * film v2 → ProjectSpec v1（engine/production/project.js）。返回 { spec, diagnostics }；spec 已用 validateProjectSpec 自检。
 * 路线写注册表 id（a / b / c），后端照抄（B 路线是 native）。runtime / execution 是 ProjectSpec 必填而 film.json 不记录的内容，由调用方给出。
 * 镜像作品（mirror.paths = repo）的路径本来就相对仓库根；普通作品的路径相对作品目录，给出 filmDir（仓库相对）时换成仓库相对路径。
 */
export function toProjectSpec(film, { runtime = null, execution = null, outputDir = null, filmDir = null, profiles = loadProfiles() } = {}) {
  const diagnostics = [];
  const p = getProfile(film.output.profile, profiles);
  const isMirror = film.mirror?.paths === 'repo';
  const base = isMirror ? '' : (typeof filmDir === 'string' && filmDir ? `${filmDir.replace(/\\/g, '/').replace(/\/+$/, '')}/` : '');
  const rel = x => (typeof x === 'string' ? posix.normalize(`${base}${x.replace(/\\/g, '/')}`) : x);   // ../../media/x.jpg 这类上溯路径按作品目录折算成仓库相对路径
  const spec = {
    schemaVersion: 1,
    projectId: film.id,
    route: film.route,
    backend: film.backend,
    entry: rel(film.entry),
    runtime: runtime ?? {},
    output: { width: film.output.width, height: film.output.height, fps: film.output.fps, frameCount: film.output.frameCount, outputDir: outputDir ?? (isMirror ? `${film.mirror.outDir}/` : `${base}out/`) },
    style: film.style
      ? { id: film.style.id, version: typeof film.style.version === 'number' ? `v${film.style.version}` : String(film.style.version), baseline: film.style.baseline ? rel(film.style.baseline) : null }
      : { id: 'unspecified', version: 'v0', baseline: null },
    assets: { inline: (film.assets ?? []).map(id => ({ id })), scope: '来自 film.json v2 的资产 id；文件与 sha256 见 engine/assets' },
    audio: { sampleRate: p.audio.sampleRate, channels: p.audio.channels, targetLUFS: film.audio?.targetLUFS ?? p.audio.loudness.integratedLUFS, truePeakLimitDbTP: film.audio?.truePeakDbTP ?? p.audio.truePeakMaxDbTP },
    execution: execution ?? { target: 'local', graphicsBackend: 'auto', evidence: null },
  };
  const hints = {
    'runtime-incomplete': '传入 runtime：A / C 路线 { three: "<three 版本>", sourceCommit: "<提交>" }，B 路线 { package: "<原生运行时版本>", sourceSnapshot: "<快照>" }',
    'style-baseline-missing': 'A 路线在 film.json 的 style.baseline 写视觉基准',
    'style-migration-required': 'A 风格搬到原生执行要在 ProjectSpec 里补 style.migration',
  };
  for (const d of validateProjectSpec(spec).diagnostics) diagnostics.push({ level: 'error', ...d, hint: hints[d.code] ?? '' });
  return { spec, diagnostics };
}

/** ProjectSpec v1 → film v2 的骨架（单镜头、无事件；credits / aigc 需要补）。路线接受 a / b / c 与旧值 beiming / raea。 */
export function fromProjectSpec(spec, { profiles = loadProfiles() } = {}) {
  const diagnostics = [];
  const { routeId: route, backend } = canonicalRoute(spec ?? {});
  if (!route) diagnostics.push({ level: 'error', code: 'projectspec-route-unknown', path: 'route', message: `不认识的 ProjectSpec 路线 ${JSON.stringify(spec?.route)}`, hint: '路线写 a / b / c（旧值 beiming、raea）' });
  if (route === 'a' && backend === 'native') {
    diagnostics.push({ level: 'error', code: 'projectspec-migration', path: 'backend', message: 'A 风格的原生迁移（route a + backend native）在 film.json 里是 B 路线作品：route 改 b，style 写北冥风格并在 notes 里说明迁移状态', hint: '' });
  }
  const o = spec?.output ?? {};
  const profile = matchProfile({ width: o.width, height: o.height, fps: o.fps }, profiles);
  if (!profile) diagnostics.push({ level: 'error', code: 'profile-unmatched', path: 'output', message: `${o.width}×${o.height}@${o.fps} 不对应任何交付档位` });
  const version = typeof spec?.style?.version === 'string' && /^v\d+$/.test(spec.style.version) ? Number(spec.style.version.slice(1)) : spec?.style?.version;
  const film = {
    schemaVersion: FILM_SCHEMA_VERSION,
    id: String(spec?.projectId ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, ''),
    title: spec?.projectId,
    route: route === 'a' && backend === 'native' ? 'b' : route,
    backend: route === 'a' && backend === 'native' ? 'native' : (backend ?? (route ? DEFAULT_BACKEND[route] : undefined)),
    entry: spec?.entry,
    output: { profile: profile ?? undefined, width: o.width, height: o.height, fps: o.fps, frameCount: o.frameCount },
    shots: [{ id: 'S1', in: 0, out: o.frameCount }],
    events: [],
    style: spec?.style ? { id: spec.style.id, version, ...(spec.style.baseline ? { baseline: spec.style.baseline } : {}) } : undefined,
    audio: { mode: 'none', targetLUFS: spec?.audio?.targetLUFS },
    credits: [],
    aigc: undefined,
  };
  diagnostics.push({ level: 'warning', code: 'projectspec-partial', path: '$', message: 'ProjectSpec 不含镜头表、事件、署名与 AIGC 标识：转换结果只是骨架，要补 shots / events / credits / aigc；路径相对仓库根，放进作品目录时改成相对作品目录' });
  return { film, diagnostics };
}

export function filmSummary(film) {
  return {
    id: film.id, title: film.title, route: film.route, backend: film.backend, profile: film.output.profile,
    size: `${film.output.width}x${film.output.height}`, fps: film.output.fps, frameCount: film.output.frameCount,
    seconds: film.output.frameCount / film.output.fps, shots: film.shots.length, events: film.events.length,
  };
}

/** 作品内容指纹（排版无关）：给运行记录与缓存用。 */
export const filmFingerprint = raw => sha256Text(stableStringify(raw));

// ───────────────────────── 命令行入口 ─────────────────────────

const invokedDirectly = (() => {
  if (typeof process === 'undefined' || !process.argv?.[1]) return false;
  if (typeof import.meta.main === 'boolean') return import.meta.main;
  try { return pathToFileURL(realpathSync(resolve(process.argv[1]))).href === import.meta.url; } catch { return false; }
})();
// 不用顶层 await：cli.js 反过来 import 本模块，顶层 await 会让两者互相等待
if (invokedDirectly) {
  import('./cli.js').then(({ main }) => main(process.argv.slice(2))).then(code => { process.exitCode = code; }, error => {
    console.error(`film.js 内部错误：${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}
