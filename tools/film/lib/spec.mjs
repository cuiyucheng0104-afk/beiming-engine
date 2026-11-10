// 北冥仓库 · 出片编排 · 读作品描述 film.json，整理成编排要用的视图（不替代 P05 的校验器）。
// 兼容两种写法（加固计划附录 C6）：
//   v1  { route, title, dur, fps, size: [w, h], poster?, cuecheck?, native? }            → frameCount = round(dur × fps)
//   v2  { schemaVersion: 2, id, title, route, backend, output: { profile, width, height, fps, frameCount }, shots[], events[],
//         audio: { mode: script|wav|none, script?, wav? }, gates: { look, animatic, final }, … }
// 本模块只做编排必需的最小检查（路线、帧数、画幅、镜头表能否用来标切点）；字段级的完整校验由
// `node engine/production/film.js check`（P05）负责，`film check` 与 `film build` 会转调它。
//
//   loadFilm(dir, { page }) → film；parseFilm(raw, { dir }) 同样的整理，但不读文件（规范检查核对模版用）
//     film = { dir, relDir, file, raw, schemaVersion, id, title, route, backend, fps, frameCount, dur, width, height,
//              profileId, shots[{id,in,out}], events[{id,frame,shot}], audio{mode,path}, gates{look,animatic,final},
//              cuecheck, posterFrame, native, pageDir, warnings[] }
//   ROUTE_INFO   路线 id → { slug, brand, renderer }；有 routes/routes.json（P02）时以它为准
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, FilmError } from './exit.mjs';
import { ROOT, rel } from './repo.mjs';

const BUILTIN_ROUTES = {
  a: { slug: 'a-webgl', brand: '北冥风格路线 · WebGL 三渲二', renderer: 'page', backend: 'three', legacy: ['beiming'] },
  b: { slug: 'b-native', brand: '北冥原生 · BNE', renderer: 'native', backend: 'native', legacy: ['raea'] },
  c: { slug: 'c-style', brand: '北冥代码动画风格 · 86 式', renderer: 'page', backend: 'page', legacy: [] },
};

function loadRegistry() {
  const f = path.join(ROOT, 'routes/routes.json');
  if (!fs.existsSync(f)) return BUILTIN_ROUTES;
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const list = Array.isArray(j) ? j : Array.isArray(j.routes) ? j.routes : Object.entries(j).map(([id, v]) => ({ id, ...v }));
    const out = {};
    for (const r of list) {
      if (!r || !['a', 'b', 'c'].includes(r.id)) continue;
      const base = BUILTIN_ROUTES[r.id];
      out[r.id] = { ...base, slug: r.slug || base.slug, brand: r.brand || base.brand, legacy: [...new Set([...(base.legacy || []), r.legacyId].filter(Boolean))] };
    }
    return Object.keys(out).length === 3 ? out : BUILTIN_ROUTES;
  } catch { return BUILTIN_ROUTES; }
}
export const ROUTE_INFO = loadRegistry();

export function normalizeRoute(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  for (const [id, r] of Object.entries(ROUTE_INFO)) {
    if (v === id || v === r.slug) return { id, legacy: false };
    if (r.legacy.includes(v)) return { id, legacy: true };
  }
  return null;
}

const isInt = v => Number.isInteger(v);
const posInt = v => isInt(v) && v > 0;
const evenSize = v => isInt(v) && v >= 16 && v % 2 === 0;

function bad(file, problems) {
  return new FilmError(EXIT.CONTRACT, 'film-json-invalid', `${rel(file)} 不能用来出片：${problems.join('；')}`,
    '按 docs/decisions/2026-11-10-industrial-baseline.md 与附录 C6 改 film.json；完整诊断跑 node tools/film/cli.mjs check <作品目录>');
}

export function loadFilm(dirArg, { page = null } = {}) {
  const dir = path.resolve(dirArg);
  const file = path.join(dir, 'film.json');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new FilmError(EXIT.USAGE, 'film-dir-missing', `作品目录不存在：${dirArg}`, '先 node tools/film/cli.mjs new <a|b|c> <名字> 新建，或检查路径（相对当前目录）');
  }
  if (!fs.existsSync(file)) {
    throw new FilmError(EXIT.USAGE, 'film-json-missing', `${rel(dir)} 下没有 film.json，不是作品目录`, '作品目录由 node tools/film/cli.mjs new 生成；《北冥》样片的作品描述在 films/beiming-10s/');
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw bad(file, [`不是合法 JSON（${e.message}）`]); }
  return parseFilm(raw, { dir, file, page });
}

// 不读文件的版本：raw 是已解析的 film.json，dir 是它所在的目录（声音脚本、页面按它解析）。
// 规范检查（tools/repo-check/rules/film）用它核对模版替换占位符后能不能直接出片。
export function parseFilm(raw, { dir, file = path.join(dir, 'film.json'), page = null } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad(file, ['顶层必须是对象']);
  const warnings = [];
  const problems = [];
  const v2 = raw.schemaVersion === 2 || (raw.output && typeof raw.output === 'object');
  if (raw.schemaVersion !== undefined && ![1, 2].includes(raw.schemaVersion)) problems.push(`schemaVersion 只能是 1 或 2，现在是 ${JSON.stringify(raw.schemaVersion)}`);

  const r = normalizeRoute(raw.route);
  if (!r) problems.push(`route 不认识：${JSON.stringify(raw.route)}（只能是 a / b / c）`);
  else if (r.legacy) warnings.push({ code: 'route-legacy-alias', message: `film.json 的 route 写的是旧名 ${JSON.stringify(raw.route)}，按 ${r.id} 处理；请改成 "${r.id}"` });

  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title) problems.push('title 不能为空');
  else if (/\{\{[A-Z_]+\}\}/.test(title)) problems.push('title 还是占位符：这是模版目录，先用 node tools/film/cli.mjs new 生成作品再出片');

  let fps, frameCount, width, height, profileId = null;
  if (v2) {
    const o = raw.output || {};
    ({ fps, frameCount, width, height } = o);
    profileId = typeof o.profile === 'string' && o.profile ? o.profile : null;
    if (!profileId) problems.push('output.profile 缺失（v2 必填，例如 "web-1080p24"）');
  } else {
    fps = raw.fps;
    if (!(typeof raw.dur === 'number' && Number.isFinite(raw.dur) && raw.dur > 0)) problems.push(`dur 应为正数（秒），现在是 ${JSON.stringify(raw.dur)}`);
    else if (posInt(fps)) frameCount = Math.round(raw.dur * fps);
    [width, height] = Array.isArray(raw.size) ? raw.size : [];
  }
  if (!posInt(fps)) problems.push(`fps 应为正整数，现在是 ${JSON.stringify(fps)}`);
  if (!posInt(frameCount)) problems.push(`frameCount 应为正整数，现在是 ${JSON.stringify(frameCount)}`);
  if (!evenSize(width) || !evenSize(height)) problems.push(`画幅应为 ≥16 的偶数宽高，现在是 ${JSON.stringify([width, height])}`);
  if (problems.length) throw bad(file, problems);
  if (!v2 && Math.abs(raw.dur * fps - frameCount) > 1e-6) warnings.push({ code: 'dur-not-whole-frames', message: `dur × fps = ${raw.dur * fps} 不是整数帧，按 ${frameCount} 帧处理` });
  const dur = frameCount / fps;

  // 镜头表：半开区间 [in, out)，首尾相接覆盖 [0, frameCount)；不合格时只用于提示，不拿来标切点
  let shots = [];
  if (Array.isArray(raw.shots) && raw.shots.length) {
    const s = raw.shots.map((x, i) => ({ id: String(x?.id ?? `S${i + 1}`), in: x?.in, out: x?.out }));
    const okShape = s.every(x => isInt(x.in) && isInt(x.out) && x.in < x.out);
    const contiguous = okShape && s[0].in === 0 && s.at(-1).out === frameCount && s.every((x, i) => !i || x.in === s[i - 1].out);
    if (contiguous) shots = s;
    else warnings.push({ code: 'shots-unusable', message: '镜头表不是首尾相接的半开区间 [in, out) 且覆盖整片：联系表不标切点（完整诊断看 film check）' });
  }
  if (!shots.length) shots = [{ id: 'S1', in: 0, out: frameCount, implicit: true }];
  const events = Array.isArray(raw.events) ? raw.events.filter(e => e && isInt(e.frame)).map(e => ({ id: String(e.id ?? ''), frame: e.frame, shot: e.shot ?? null })) : [];

  // 声音：v2 写 audio.mode；v1 按约定推断（A 模版 sound.py、C 模版 mix.py；B 由 native.audio 在准备阶段生成）
  let audio;
  if (r.id === 'b') audio = { mode: 'native' };
  else if (raw.audio && typeof raw.audio === 'object') {
    const mode = raw.audio.mode;
    if (mode === 'none') audio = { mode: 'none' };
    else if (mode === 'wav' && typeof (raw.audio.wav ?? raw.audio.file ?? raw.audio.path) === 'string') audio = { mode: 'wav', path: path.resolve(dir, raw.audio.wav ?? raw.audio.file ?? raw.audio.path) };
    else if (mode === 'script' && typeof raw.audio.script === 'string') audio = { mode: 'script', path: path.resolve(dir, raw.audio.script) };
    else throw bad(file, [`audio 要写成 { mode: "script", script } / { mode: "wav", wav } / { mode: "none" }，现在是 ${JSON.stringify(raw.audio)}`]);
  } else if (fs.existsSync(path.join(dir, 'sound.py'))) audio = { mode: 'script', path: path.join(dir, 'sound.py'), inferred: true };
  else if (fs.existsSync(path.join(dir, 'mix.py'))) audio = { mode: 'script', path: path.join(dir, 'mix.py'), inferred: true };
  else audio = { mode: 'none', inferred: true };
  if (audio.path && !fs.existsSync(audio.path)) throw bad(file, [`声音${audio.mode === 'wav' ? '文件' : '脚本'}不存在：${rel(audio.path)}`]);

  const g = raw.gates && typeof raw.gates === 'object' ? raw.gates : {};
  const gate = k => (['optional', 'skip', 'not-required'].includes(g[k]) ? 'optional' : 'required');
  const gates = { look: gate('look'), animatic: gate('animatic'), final: 'required' };

  let posterFrame;
  if (isInt(raw.posterFrame)) posterFrame = raw.posterFrame;
  else if (typeof raw.poster === 'number' && raw.poster >= 0) posterFrame = Math.round(raw.poster * fps);
  else posterFrame = Math.round(frameCount * 0.6);
  posterFrame = Math.min(frameCount - 1, Math.max(0, posterFrame));

  const pageRel = page ?? (typeof raw.page === 'string' && raw.page ? path.resolve(dir, raw.page) : dir);
  const pageDir = path.resolve(pageRel);

  return {
    dir, relDir: rel(dir), file, raw, schemaVersion: v2 ? 2 : 1,
    id: typeof raw.id === 'string' && raw.id ? raw.id : path.basename(dir),
    title, route: r.id, routeInfo: ROUTE_INFO[r.id], backend: typeof raw.backend === 'string' ? raw.backend : ROUTE_INFO[r.id].backend,
    fps, frameCount, dur, width, height, profileId, shots, events, audio, gates,
    cuecheck: raw.cuecheck && typeof raw.cuecheck === 'object' ? raw.cuecheck : null,
    posterFrame, native: raw.native || null, pageDir, warnings,
  };
}

// 镜头表按渲染帧率换算（档位帧率与 film.json 不同时）；返回切点（每个镜头的 in，第一镜除外）
export function shotsAt(film, fps) {
  const k = fps / film.fps;
  return film.shots.map(s => ({ id: s.id, in: Math.round(s.in * k), out: Math.round(s.out * k), implicit: !!s.implicit }));
}
export const cutsOf = shots => shots.slice(1).map(s => s.in);
