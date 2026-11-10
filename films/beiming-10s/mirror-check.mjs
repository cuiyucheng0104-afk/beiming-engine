#!/usr/bin/env node
// 《北冥》10 秒样片镜像的一致性检查：films/beiming-10s/film.json 与冻结样片的源码、声音表必须描述同一条时间线。
// 样片的镜头表写在 src/timeline.js（TIMELINE：镜头起点与片长；DESIGN：编排按它写的设计稿镜头表），
// 再被 src/main.js（film.run 的 dur 与 shots、HUD_T 覆写）、src/girl.js（GIRL_SHOT）、src/shotC.js（C_START）、
// src/hud.js（HUD_T，设计稿秒，随镜头 C 平移）读取；src/birds.js（鸽群起飞 T0）和 audio/cues.json（声音表）各自写全局秒，
// 声音表不读 src/。这个检查只读这些文件（不改、不运行页面），按下面的规则推出"应该是多少帧"，与镜像逐项比对，任何漂移都失败。
// 源码里的时间写成数字、TIMELINE.X / DESIGN.X、本文件里的 const 名字和加减，这里用一个只认这几种写法的小求值器读出秒数；
// 写法超出它（例如函数调用）时报 mirror-parse，而不是猜。
//
//   node films/beiming-10s/mirror-check.mjs [--root <仓库根>] [--film <film.json>] [--json]
//   退出码：0 一致；4 有漂移（逐条列出）；2 用法错误；1 读不出文件
//
// 换算规则（与 engine/production/timeline.js 的 secondsToFrame 一致）：
//   镜头起止            t × fps 必须正好是整数帧（exact）
//   画面阈值事件        代码写 t ≥ T 时出现 → 帧 = ceil(T × fps)，即 t ≥ T 的第一帧（HUD_T 各项、片名书写起点）
//   声音事件            起音在第 floor(t × fps) 帧之内（画面先到、声音晚不到 1 帧）；有 t_end 时 end = ceil(t_end × fps)
//   同一时刻两处都写的  画面阈值与声音 cue 必须是同一个秒数，且声音相对结果帧的偏差在同步容差内（晚 ≤ 1 帧、早 ≤ 10 ms）
// 库接口：readSources(root) → { 相对路径: 文本 }；parseSources(texts)；expectedMirror(values)；checkMirror(film, texts, { root })
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = resolve(HERE, '../..');
export const SOURCE_FILES = Object.freeze(['src/timeline.js', 'src/main.js', 'src/girl.js', 'src/shotC.js', 'src/hud.js', 'src/birds.js', 'audio/cues.json']);

/**
 * 画面事件：从哪个时间常量来、怎么换成帧、是否与某条声音 cue 同一时刻。
 * HUD_T 是设计稿秒（src/hud.js 的 drawHUD / drawTitle / textsAt 先减去 shiftOf('C') 再比较），成片全局秒 = HUD_T + shiftC。
 */
export const VISUAL_EVENTS = Object.freeze([
  { id: 'girl.touch', rule: 'exact', at: v => v.girl.start + 0.5, from: 'GIRL_SHOT.start + 0.50（src/girl.js 注释：0.50 指腹贴上镜腿，一拍二）' },
  { id: 'hud.on', rule: 'ceil', at: v => v.hud.on + v.shiftC, from: 'HUD_T.on + shiftOf(C)' },
  { id: 'hud.remind', rule: 'ceil', at: v => v.hud.remindIn + v.shiftC, from: 'HUD_T.remindIn + shiftOf(C)' },
  { id: 'hud.scan', rule: 'ceil', at: v => v.hud.scan + v.shiftC, from: 'HUD_T.scan + shiftOf(C)', audio: 'ui_scan' },
  { id: 'hud.lock', rule: 'ceil', at: v => v.hud.scanLock + v.shiftC, from: 'HUD_T.scanLock + shiftOf(C)' },
  { id: 'hud.fail', rule: 'ceil', at: v => v.hud.fail + v.shiftC, from: 'HUD_T.fail + shiftOf(C)', audio: 'ui_fail' },
  { id: 'hud.nav', rule: 'ceil', at: v => v.hud.navIn + v.shiftC, from: 'HUD_T.navIn + shiftOf(C)', audio: 'ui_nav' },
  { id: 'hud.nav-done', rule: 'ceil', at: v => v.hud.navDone + v.shiftC, from: 'HUD_T.navDone + shiftOf(C)' },
  { id: 'hud.off', rule: 'ceil', at: v => v.hud.off + v.shiftC, from: 'HUD_T.off + shiftOf(C)' },
  { id: 'title.bei', rule: 'ceil', at: v => v.hud.titleA[0] + v.shiftC, from: 'HUD_T.titleA[0] + shiftOf(C)（src/main.js 覆写后）', audio: 'apex' },
  { id: 'title.ming', rule: 'ceil', at: v => v.hud.titleB[0] + v.shiftC, from: 'HUD_T.titleB[0] + shiftOf(C)（src/main.js 覆写后）' },
  { id: 'title.sub', rule: 'ceil', at: v => v.hud.subIn + v.shiftC, from: 'HUD_T.subIn + shiftOf(C)（src/main.js 覆写后）' },
]);
const SHOT_VARS = { shotA: 'A', shotB: 'B', shotC: 'C' };
const EARLY_MS = 10;

const toFrame = (t, fps, rule) => {
  const x = t * fps;
  if (rule === 'ceil') return Math.ceil(x - 1e-6);
  if (rule === 'floor') return Math.floor(x + 1e-6);
  const r = Math.round(x);
  return Math.abs(x - r) < 1e-6 ? r : null;   // exact：不落整帧返回 null
};

export function readSources(root = DEFAULT_ROOT) {
  const texts = {};
  for (const rel of SOURCE_FILES) {
    const p = join(root, rel);
    if (!existsSync(p)) throw Object.assign(new Error(`缺少样片源文件 ${rel}（在 ${root} 下找）`), { exitCode: 1 });
    texts[rel] = readFileSync(p, 'utf8');
  }
  return texts;
}

// 去掉行注释与块注释（跳过字符串里的斜杠）。
function stripComments(src) {
  let out = '', str = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (str) { out += c; if (c === '\\') out += src[++i] ?? ''; else if (c === str) str = null; continue; }
    if (c === '"' || c === "'" || c === '`') { str = c; out += c; continue; }
    if (c === '/' && src[i + 1] === '/') { const j = src.indexOf('\n', i); if (j < 0) break; i = j - 1; continue; }
    if (c === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2); if (j < 0) break; i = j + 1; continue; }
    out += c;
  }
  return out;
}

/**
 * 秒数表达式求值：只认数字、成员名（TIMELINE.B、DESIGN.C）、scope 里的名字（DUR）、一元负号、加减和括号。
 * 认不出就抛错（调用方报 mirror-parse），不去执行任意代码。
 */
export function evalSeconds(expr, scope = {}) {
  const tokens = String(expr).match(/\d+(?:\.\d+)?|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*|\S/g) ?? [];
  let i = 0;
  const primary = () => {
    const t = tokens[i++];
    if (t === undefined) throw new Error(`表达式不完整：${expr}`);
    if (t === '(') { const v = sum(); if (tokens[i++] !== ')') throw new Error(`缺右括号：${expr}`); return v; }
    if (t === '-') return -primary();
    if (t === '+') return primary();
    if (/^\d/.test(t)) return Number(t);
    if (/^[A-Za-z_$]/.test(t)) {
      const v = t.split('.').reduce((o, k) => (o !== null && typeof o === 'object' && Object.hasOwn(o, k) ? o[k] : undefined), scope);
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`不认识的名字 ${t}（${expr}）`);
      return v;
    }
    throw new Error(`不认识的写法 ${t}（${expr}）`);
  };
  const sum = () => {
    let v = primary();
    while (tokens[i] === '+' || tokens[i] === '-') { const op = tokens[i++]; const r = primary(); v = op === '+' ? v + r : v - r; }
    return v;
  };
  const v = sum();
  if (i !== tokens.length) throw new Error(`多余的写法 ${tokens[i]}（${expr}）`);
  return v;
}

/** 从 start（指向 open）起找配对的 close，跳过字符串；返回 close 的下标或 -1。 */
function matching(src, start, open, close) {
  let depth = 0, str = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (str) { if (c === '\\') i++; else if (c === str) str = null; continue; }
    if (c === '"' || c === "'" || c === '`') { str = c; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return i;
  }
  return -1;
}

/** 在顶层逗号处切开（括号、方括号、花括号、字符串里的逗号不切）。 */
function splitTop(text) {
  const parts = [];
  let depth = 0, str = null, from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (str) { if (c === '\\') i++; else if (c === str) str = null; continue; }
    if (c === '"' || c === "'" || c === '`') { str = c; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { parts.push(text.slice(from, i)); from = i + 1; }
  }
  parts.push(text.slice(from));
  return parts.map(s => s.trim()).filter(Boolean);
}

/**
 * 读出 anchor（以 { 结尾的正则）之后的对象字面量：值是数字表达式或数字表达式的数组；字符串值原样保留，
 * 其它写法记成 undefined 并把键名放进 unreadable。返回 null 表示没找到或括号不配对。
 */
export function objectAfter(src, anchor, scope = {}) {
  const text = stripComments(src);
  const m = anchor.exec(text);
  if (!m) return null;
  const start = text.indexOf('{', m.index + m[0].length - 1);
  const end = start < 0 ? -1 : matching(text, start, '{', '}');
  if (end < 0) return null;
  const obj = {}, unreadable = [];
  for (const entry of splitTop(text.slice(start + 1, end))) {
    const kv = /^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+)$/.exec(entry);
    if (!kv) { unreadable.push(entry.slice(0, 40)); continue; }
    const [, key, raw] = kv, value = raw.trim();
    try {
      if (/^(['"`])[\s\S]*\1$/.test(value)) obj[key] = value.slice(1, -1);
      else if (value.startsWith('[')) {
        const close = matching(value, 0, '[', ']');
        if (close !== value.length - 1) throw new Error('数组写法不认识');
        obj[key] = splitTop(value.slice(1, -1)).map(x => evalSeconds(x, scope));
      } else obj[key] = evalSeconds(value, scope);
    } catch {
      obj[key] = undefined;
      unreadable.push(key);
    }
  }
  Object.defineProperty(obj, 'unreadable', { value: unreadable, enumerable: false });
  return obj;
}

/** 读 const NAME = <表达式>（可以是 const A = …, B = …; 里的一项）。 */
function constAfter(src, name, scope) {
  const m = new RegExp(`(?:^|[\\s;,])(?:export\\s+)?(?:const|let)?\\s*\\b${name}\\s*=\\s*([^,;\\n]+)`).exec(stripComments(src));
  if (!m) return undefined;
  try { return evalSeconds(m[1].trim(), scope); } catch { return undefined; }
}

/** 从源码里读出时间常量。读不出就报 parse 诊断（写法变了也算漂移：要么改回，要么同步改本检查）。 */
export function parseSources(texts) {
  const diagnostics = [];
  const fail = (file, what) => diagnostics.push({ level: 'error', code: 'mirror-parse', path: file, message: `${file} 里读不出 ${what}`, hint: '样片源码的写法变了：src/ 是冻结基准，先确认这是有意改动，再同步 film.json 与本检查' });
  const tl = texts['src/timeline.js'], main = texts['src/main.js'], girlSrc = texts['src/girl.js'], shotC = texts['src/shotC.js'], hudSrc = texts['src/hud.js'], birds = texts['src/birds.js'];
  const v = {};

  // 1. 镜头表：src/timeline.js 的 TIMELINE（成片）与 DESIGN（设计稿）
  const timeline = objectAfter(tl ?? '', /export const TIMELINE\s*=\s*Object\.freeze\(\s*\{/);
  const design = objectAfter(tl ?? '', /export const DESIGN\s*=\s*Object\.freeze\(\s*\{/);
  const tlOk = o => o && ['A', 'B', 'C', 'end'].every(k => typeof o[k] === 'number');
  if (!tlOk(timeline)) fail('src/timeline.js', 'export const TIMELINE = Object.freeze({ A, B, C, end })');
  if (!tlOk(design)) fail('src/timeline.js', 'export const DESIGN = Object.freeze({ A, B, C, end })');
  v.timeline = timeline; v.design = design;
  const scope = { TIMELINE: timeline ?? {}, DESIGN: design ?? {} };
  v.shiftC = tlOk(timeline) && tlOk(design) ? timeline.C - design.C : 0;

  // 2. src/main.js：film.run 的 dur 与 shots（数字或 TIMELINE.X；dur 也可以是 const DUR = …）
  const mainText = stripComments(main ?? '');
  const runAt = mainText.search(/film\.run\(\s*\{/);
  const runOpen = runAt < 0 ? -1 : mainText.indexOf('{', runAt);
  const runClose = runOpen < 0 ? -1 : matching(mainText, runOpen, '{', '}');
  if (runClose < 0) fail('src/main.js', 'film.run({ … }) 调用');
  else {
    const body = mainText.slice(runOpen + 1, runClose);
    const mainScope = { ...scope };
    const durConst = constAfter(main ?? '', 'DUR', scope);
    if (durConst !== undefined) mainScope.DUR = durConst;
    const entries = Object.fromEntries(splitTop(body).map(e => /^([A-Za-z_$][\w$]*)\s*(?::\s*([\s\S]*))?$/.exec(e)).filter(Boolean).map(m => [m[1], (m[2] ?? m[1]).trim()]));
    try { v.dur = evalSeconds(entries.dur, mainScope); } catch { fail('src/main.js', `film.run 的 dur（写成 ${JSON.stringify(entries.dur ?? null)}）`); }
    const list = entries.shots?.startsWith('[') ? splitTop(entries.shots.slice(1, matching(entries.shots, 0, '[', ']'))) : [];
    const items = [];
    for (const it of list) {
      const m = /^\{\s*at\s*:\s*([^,}]+?)\s*,\s*shot\s*:\s*(\w+)\s*\}$/.exec(it);
      if (!m) { items.length = 0; break; }
      try { items.push({ at: evalSeconds(m[1], mainScope), shot: SHOT_VARS[m[2]] ?? m[2], expr: m[1] }); } catch { items.length = 0; break; }
    }
    if (items.length) v.shots = items; else fail('src/main.js', 'film.run 的 shots: [{ at, shot }, …]（at 写成数字或 TIMELINE.X）');
    try { v.fps = entries.fps !== undefined ? evalSeconds(entries.fps, mainScope) : 24; }   // engine/stage/film.js 的 run() 默认 24
    catch { fail('src/main.js', 'film.run 的 fps'); }
  }
  const dh = /createFilm\(\{\s*designHeight:\s*(\d+)\s*\}\)/.exec(mainText);
  if (dh) v.designHeight = Number(dh[1]); else fail('src/main.js', 'createFilm({ designHeight })');
  const names = /const NAMES = \[([^\]]*)\]/.exec(mainText);
  if (names) v.plates = [...names[1].matchAll(/'([^']+)'/g)].map(m => m[1]); else fail('src/main.js', '底板名单 NAMES');
  v.paper = /paperUrl:\s*'\.\/assets\/plates\/paper\.png'/.test(mainText);

  // 3. HUD_T（设计稿秒）与 main.js 的覆写
  const hud = objectAfter(hudSrc ?? '', /export const HUD_T\s*=\s*\{/, scope);
  if (!hud || hud.unreadable.length) fail('src/hud.js', `export const HUD_T = { … }${hud?.unreadable.length ? `（读不出 ${hud.unreadable.join('、')}）` : ''}`);
  const override = objectAfter(main ?? '', /Object\.assign\(HUD_T,\s*\{/, scope);
  if ((!override || override.unreadable.length) && /Object\.assign\(HUD_T/.test(mainText)) fail('src/main.js', 'Object.assign(HUD_T, { … }) 的覆写表');
  v.hud = hud ? { ...hud, ...(override ?? {}) } : null;
  v.hudOverride = override ?? {};

  // 4. 人物镜头、镜头 C 起点、鸽群
  const gs = objectAfter(girlSrc ?? '', /export const GIRL_SHOT\s*=\s*\{/, scope);
  if (!gs || typeof gs.start !== 'number' || typeof gs.dur !== 'number') fail('src/girl.js', 'GIRL_SHOT = { start, dur, … }');
  else v.girl = gs;
  const cs = constAfter(shotC ?? '', 'C_START', scope);
  if (cs !== undefined) v.cStart = cs; else fail('src/shotC.js', 'export const C_START = …;');
  const t0 = constAfter(birds ?? '', 'T0', scope);
  if (t0 !== undefined) v.birdsT0 = t0; else fail('src/birds.js', '鸽群起飞时刻 const T0 = …;');

  try { v.cues = JSON.parse(texts['audio/cues.json']); } catch (e) { diagnostics.push({ level: 'error', code: 'mirror-parse', path: 'audio/cues.json', message: `audio/cues.json 不是合法 JSON（${e.message}）`, hint: '' }); }
  return { values: v, diagnostics };
}

/** 由源码常量推出镜像应有的镜头表与事件表。 */
export function expectedMirror(v) {
  const fps = v.fps, diagnostics = [];
  const shots = [];
  const order = v.shots ?? [];
  order.forEach((s, i) => {
    const inF = toFrame(s.at, fps, 'exact'), endT = i + 1 < order.length ? order[i + 1].at : v.dur, outF = toFrame(endT, fps, 'exact');
    if (inF === null || outF === null) diagnostics.push({ level: 'error', code: 'mirror-off-frame', path: 'src/main.js', message: `镜头 ${s.shot} 的起止 ${s.at}–${endT} 秒不落整帧（${fps} fps）`, hint: '切点要落在整帧上' });
    shots.push({ id: s.shot, in: inF, out: outF });
  });
  const events = new Map();
  const claimed = new Set();
  if (v.hud && v.girl) {
    for (const e of VISUAL_EVENTS) {
      let t;
      try { t = e.at(v); } catch { t = undefined; }
      if (typeof t !== 'number') { diagnostics.push({ level: 'error', code: 'mirror-parse', path: e.from, message: `读不出 ${e.id} 的时间常量（${e.from}）`, hint: '' }); continue; }
      const frame = toFrame(t, fps, e.rule);
      if (frame === null) { diagnostics.push({ level: 'error', code: 'mirror-off-frame', path: e.from, message: `${e.id} 的 ${t} 秒不落整帧`, hint: '' }); continue; }
      events.set(e.id, { id: e.id, frame, seconds: t, audio: e.audio, from: e.from });
      if (e.audio) claimed.add(e.audio);
    }
  }
  for (const c of v.cues?.cues ?? []) {
    if (claimed.has(c.id)) continue;
    const id = `${String(c.shot).toLowerCase()}.${c.id}`;
    const ev = { id, frame: toFrame(c.t, fps, 'floor'), audio: c.id, shot: c.shot, from: `audio/cues.json ${c.id}.t = ${c.t}` };
    if (c.t_end !== undefined) ev.end = toFrame(c.t_end, fps, 'ceil');
    events.set(id, ev);
  }
  return { fps, frameCount: toFrame(v.dur ?? NaN, fps, 'exact'), shots, events, diagnostics };
}

/**
 * 比对镜像与源码。film 是 engine/production/film.js 读出的规范化对象（或原始 JSON）。
 * @returns {{ ok: boolean, diagnostics: object[], expected: object, values: object }}
 */
export function checkMirror(film, texts, { root = DEFAULT_ROOT } = {}) {
  const { values: v, diagnostics } = parseSources(texts);
  const d = (code, path, message, hint = '') => diagnostics.push({ level: 'error', code, path, message, hint });
  if (diagnostics.length) return { ok: false, diagnostics, expected: null, values: v };
  const exp = expectedMirror(v);
  diagnostics.push(...exp.diagnostics);
  const fps = film.output.fps, n = film.output.frameCount;

  // 1. 总长、帧率、画幅
  if (v.fps !== fps) d('mirror-fps', 'output.fps', `src/main.js 的 film.run 帧率是 ${v.fps}，镜像写 ${fps}`);
  if (exp.frameCount !== n) d('mirror-duration', 'output.frameCount', `src/main.js 的 dur = ${v.dur} 秒 = ${exp.frameCount ?? '非整数'} 帧，镜像写 ${n} 帧`);
  if (v.designHeight !== film.output.height) d('mirror-size', 'output.height', `src/main.js 按设计高 ${v.designHeight} 摆镜头，镜像的画幅高是 ${film.output.height}`);

  // 2. 镜头表：main.js 的 at、GIRL_SHOT、C_START、cues.json 的 shots
  const fs = film.shots.map(s => ({ id: s.id, in: s.in, out: s.out }));
  if (exp.shots.length !== fs.length) d('mirror-shots', 'shots', `src/main.js 有 ${exp.shots.length} 个镜头，镜像有 ${fs.length} 个`);
  exp.shots.forEach((s, i) => {
    const f = fs[i];
    if (!f) return;
    if (f.id !== s.id) d('mirror-shots', `shots[${i}].id`, `第 ${i + 1} 镜在 src/main.js 是 ${s.id}，镜像写 ${f.id}`);
    if (f.in !== s.in || f.out !== s.out) d('mirror-shots', `shots[${i}]`, `镜头 ${s.id}：src/main.js 推出 [${s.in}, ${s.out})，镜像写 [${f.in}, ${f.out})`, '改了样片的镜头起点？src/ 是冻结基准：确认有意后同步改镜像（film.js retime）');
  });
  const B = fs.find(s => s.id === 'B'), C = fs.find(s => s.id === 'C');
  if (B && v.girl) {
    const gi = toFrame(v.girl.start, fps, 'exact'), go = toFrame(v.girl.start + v.girl.dur, fps, 'exact');
    if (gi !== B.in || go !== B.out) d('mirror-girl-shot', 'shots[B]', `src/girl.js GIRL_SHOT { start: ${v.girl.start}, dur: ${v.girl.dur} } = [${gi}, ${go})，镜头 B 是 [${B.in}, ${B.out})`, '人物的局部时间从 GIRL_SHOT.start 起算，必须与镜头 B 的入点一致');
  }
  if (C && v.cStart !== undefined && toFrame(v.cStart, fps, 'exact') !== C.in) d('mirror-c-start', 'shots[C]', `src/shotC.js C_START = ${v.cStart} 秒，镜头 C 的入点是第 ${C.in} 帧`);
  const cues = v.cues ?? {};
  if (cues.fps !== fps) d('mirror-cues-fps', 'audio/cues.json', `cues.json 的 fps 是 ${cues.fps}，镜像是 ${fps}`);
  if (typeof cues.dur !== 'number' || Math.abs(cues.dur * fps - n) > 1e-6) d('mirror-cues-dur', 'audio/cues.json', `cues.json 的 dur = ${cues.dur} 秒，镜像整片 ${n} 帧（${n / fps} 秒）`);
  for (const s of cues.shots ?? []) {
    const f = fs.find(x => x.id === s.id);
    const si = toFrame(s.t, fps, 'exact'), so = toFrame(s.t_end, fps, 'exact');
    if (!f) d('mirror-cues-shots', 'audio/cues.json', `cues.json 有镜头 ${s.id}，镜像没有`);
    else if (si !== f.in || so !== f.out) d('mirror-cues-shots', 'audio/cues.json', `cues.json 的镜头 ${s.id} 是 ${s.t}–${s.t_end} 秒 = [${si}, ${so})，镜像写 [${f.in}, ${f.out})`, '画面切点变了，声音表的镜头时间要一起改');
  }
  if ((cues.shots ?? []).length !== fs.length) d('mirror-cues-shots', 'audio/cues.json', `cues.json 有 ${(cues.shots ?? []).length} 个镜头，镜像有 ${fs.length} 个`);
  for (const c of cues.cues ?? []) {
    if (typeof c.frame === 'number' && Math.abs(c.frame - c.t * fps) > 1e-6) d('mirror-cues-frame', `audio/cues.json ${c.id}`, `cues.json 里 ${c.id} 的 frame=${c.frame} ≠ t × fps = ${+(c.t * fps).toFixed(4)}`, '声音表内部的帧号字段与秒数漂移了');
    if (typeof c.frame_end === 'number' && Math.abs(c.frame_end - c.t_end * fps) > 1e-6) d('mirror-cues-frame', `audio/cues.json ${c.id}`, `cues.json 里 ${c.id} 的 frame_end=${c.frame_end} ≠ t_end × fps`);
  }

  // 3. 事件表：逐条比对，缺的、多的、帧号不对的都报
  const fe = new Map(film.events.map(e => [e.id, e]));
  for (const [id, e] of exp.events) {
    const f = fe.get(id);
    if (!f) { d('mirror-event-missing', 'events', `镜像缺事件 ${id}（来自 ${e.from}，应在第 ${e.frame} 帧）`); continue; }
    if (f.frame !== e.frame) d('mirror-event-frame', `events.${id}`, `事件 ${id}：${e.from} 推出第 ${e.frame} 帧，镜像写 ${f.frame}`);
    if ((f.end ?? null) !== (e.end ?? null)) d('mirror-event-end', `events.${id}`, `事件 ${id} 的 end：声音表推出 ${e.end ?? '无'}，镜像写 ${f.end ?? '无'}`);
    if ((f.audio ?? null) !== (e.audio ?? null)) d('mirror-event-audio', `events.${id}`, `事件 ${id} 应挂声音 cue ${e.audio ?? '（无）'}，镜像写 ${f.audio ?? '（无）'}`);
    if (e.shot && f.shot !== e.shot) d('mirror-event-shot', `events.${id}`, `事件 ${id} 在声音表里属于镜头 ${e.shot}，镜像写 ${f.shot}`);
  }
  for (const id of fe.keys()) if (!exp.events.has(id)) d('mirror-event-extra', `events.${id}`, `镜像多出事件 ${id}：样片的源码与声音表里找不到它的来源`, '镜像只记录样片里真有的时刻；新增事件请在新作品里做');

  // 4. 同一时刻两处都写的：画面阈值与声音 cue 必须同一个秒数，声音相对结果帧在同步容差内
  const cueById = new Map((cues.cues ?? []).map(c => [c.id, c]));
  for (const e of VISUAL_EVENTS) {
    if (!e.audio) continue;
    const c = cueById.get(e.audio), x = exp.events.get(e.id);
    if (!c) { d('mirror-cue-missing', `audio/cues.json`, `声音表里没有 ${e.audio}（${e.id} 的声音）`); continue; }
    if (!x) continue;
    if (Math.abs(c.t - x.seconds) > 1e-9) d('mirror-av-split', `events.${e.id}`, `画面 ${e.from} = ${x.seconds} 秒，声音 ${e.audio} = ${c.t} 秒：同一时刻两处写成了不同的数`, '一个事件只写一处：两边改成同一个时刻');
    const lateMs = (c.t - x.frame / fps) * 1000;
    if (lateMs < -EARLY_MS - 1e-6 || lateMs > 1000 / fps + 1e-6) d('mirror-av-sync', `events.${e.id}`, `声音 ${e.audio} 相对结果帧 ${x.frame} ${lateMs < 0 ? `早 ${(-lateMs).toFixed(1)}` : `晚 ${lateMs.toFixed(1)}`} ms，超出同步容差（晚 ≤ 1 帧、早 ≤ ${EARLY_MS} ms）`, '见 routes/directing/craft/animation.md §5.7');
  }
  const pigeons = cueById.get('pigeons');
  if (pigeons && v.birdsT0 !== undefined && Math.abs(pigeons.t - v.birdsT0) > 1e-9) d('mirror-av-split', 'src/birds.js', `鸽群起飞：画面 src/birds.js T0 = ${v.birdsT0} 秒，声音 pigeons = ${pigeons.t} 秒`);

  // 5. 资产与声音目标
  const assets = new Set(film.assets ?? []);
  for (const name of [...(v.plates ?? []), ...(v.paper ? ['paper'] : [])]) {
    if (!assets.has(`plate:${name}`)) d('mirror-asset-missing', 'assets', `src/main.js 加载底板 ${name}，镜像的 assets 没有 plate:${name}`);
  }
  for (const a of assets) {
    const m = /^(plate|model|character):([^@]+)(@.*)?$/.exec(a);
    if (!m) continue;
    const file = m[1] === 'plate' ? `assets/plates/${m[2]}.png` : `src/${m[2]}.js`;
    if (!existsSync(join(root, file))) d('mirror-asset-file', `assets`, `资产 ${a} 对应的 ${file} 不存在`);
    if (m[1] === 'plate' && m[2] !== 'paper' && !(v.plates ?? []).includes(m[2])) d('mirror-asset-extra', 'assets', `资产 ${a} 不在 src/main.js 的底板名单里`);
  }
  const tgt = cues.target ?? {};
  if (film.audio?.targetLUFS !== undefined && film.audio.targetLUFS !== tgt.integrated_lufs) d('mirror-audio-target', 'audio.targetLUFS', `cues.json 的混音目标 ${tgt.integrated_lufs} LUFS，镜像写 ${film.audio.targetLUFS}`);
  if (film.audio?.truePeakDbTP !== undefined && film.audio.truePeakDbTP !== tgt.true_peak_dbtp) d('mirror-audio-target', 'audio.truePeakDbTP', `cues.json 的真峰值目标 ${tgt.true_peak_dbtp} dBTP，镜像写 ${film.audio.truePeakDbTP}`);

  return { ok: !diagnostics.some(x => x.level === 'error'), diagnostics, expected: exp, values: v };
}

// ───────────────────────── 命令行 ─────────────────────────

const HELP = `node films/beiming-10s/mirror-check.mjs [--root <仓库根>] [--film <film.json>] [--json]
  比对 films/beiming-10s/film.json 与《北冥》样片源码（${SOURCE_FILES.join('、')}）。只读，不改文件。
  --root   去哪里读样片源码（默认本仓库根；测试时指向改过的临时副本）
  --film   镜像文件（默认与本脚本同目录的 film.json）
退出码：0 一致；4 有漂移；2 用法错误；1 读不出文件`;

async function main(argv) {
  const json = argv.includes('--json');
  const out = (env, text) => {
    if (json) process.stdout.write(`${JSON.stringify({ ok: env.ok, exitCode: env.exitCode, command: 'mirror-check', error: env.error ?? null, outputs: [], runJson: null, warnings: env.warnings ?? [], result: env.result ?? null }, null, 2)}\n`);
    else process[env.exitCode === 0 || env.exitCode === 4 ? 'stdout' : 'stderr'].write(`${text}\n`);
    return env.exitCode;
  };
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(`${HELP}\n`); return 0; }
  const opts = { root: DEFAULT_ROOT, film: join(HERE, 'film.json') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') continue;
    if (a === '--root' || a === '--film') {
      const val = argv[++i];
      if (val === undefined || val.startsWith('--')) return out({ ok: false, exitCode: 2, error: { code: 'usage', message: `${a} 后面要跟路径`, hint: HELP.split('\n')[0] } }, `${a} 后面要跟路径`);
      opts[a.slice(2)] = resolve(val);
      continue;
    }
    return out({ ok: false, exitCode: 2, error: { code: 'usage', message: `未知参数 ${a}`, hint: '可用：--root --film --json --help' } }, `未知参数 ${a}\n${HELP}`);
  }
  const { loadFilm, assertValidFilm } = await import('../../engine/production/film.js');
  let film, texts;
  try {
    film = assertValidFilm(loadFilm(opts.film), 'films/beiming-10s/film.json');
    texts = readSources(opts.root);
  } catch (error) {
    const code = error.exitCode ?? 1;
    return out({ ok: false, exitCode: code, error: { code: error.code ?? 'unreadable', message: error.message, hint: error.hint ?? '' } }, `${error.message}${error.hint ? `\n→ ${error.hint}` : ''}`);
  }
  const r = checkMirror(film, texts, { root: opts.root });
  const lines = r.ok
    ? [`✓ 镜像与样片一致：${film.shots.length} 镜 [${film.shots.map(s => `${s.id} ${s.in}–${s.out}`).join('，')}]，${film.events.length} 个事件，${film.output.frameCount} 帧`]
    : [`✗ 镜像与样片不一致（${r.diagnostics.length} 处）：`, ...r.diagnostics.map(x => `  [${x.code}] ${x.path}：${x.message}${x.hint ? `\n    → ${x.hint}` : ''}`)];
  return out({ ok: r.ok, exitCode: r.ok ? 0 : 4, error: r.ok ? null : { code: 'mirror-drift', message: r.diagnostics[0].message, hint: r.diagnostics[0].hint }, result: { diagnostics: r.diagnostics } }, lines.join('\n'));
}

const direct = (() => {
  try { return Boolean(process.argv[1]) && pathToFileURL(realpathSync(resolve(process.argv[1]))).href === import.meta.url; } catch { return false; }
})();
if (direct) main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.error(error?.stack ?? error); process.exitCode = 1; });
