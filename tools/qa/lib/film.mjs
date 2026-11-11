// 北冥 QA · 作品描述读取：把 film.json（v2，附录 C6；或自动升级的 v1 {route,title,dur,fps,size}）读成 QA 需要的期望值。
// 只读、宽容：字段的权威校验在 P05 的 engine/production/film.js（film check），这里遇到不一致只记 warning，不替它判定。
// P05 合入后，normalizeFilm 改为先调用其升级函数，再取下面这些字段（见 docs/quality/QA-GATE.md「接口」）。
//
//   findFilm({ film, input })          → film.json 的绝对路径或 null：显式参数优先；否则从成片所在目录往上找最近的 film.json
//                                        （films/<名>/out/<run-id>/master.mp4 → films/<名>/film.json），找到仓库根为止；
//                                        《北冥》样片的运行目录 out/beiming/<run-id>/ 与旧产物 out/beiming*.mp4 对应 films/beiming-10s/film.json（P05 的镜像）
//   repoRootOf(p)                      → p 所在的仓库根（往上第一个同时有 package.json 与 engine/ 的目录），没有返回 null
//   loadFilm(file)                     → normalizeFilm(JSON, file)
//   normalizeFilm(raw, file)           → { id, title, route, fps, width, height, frameCount, profile, shots, cuts, events, audioMode, aigc, native, qa, warnings }
//   loadEvents(file, fps)              → 事件表（film.json / events.json 两种写法）规范成 [{ id, frame, t, needsSound, kind, soft }]
//   runDirOf(input)                    → 成片所在的运行目录（films/<名>/out/<run-id>/ 或 out/beiming/<run-id>/），不在运行目录里返回 null
import fs from 'node:fs';
import path from 'node:path';
import { QaError, EXIT } from './cli-kit.mjs';
import { parseFps } from './profiles.mjs';

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const isInt = v => Number.isInteger(v);
export const BEIMING_FILM = 'films/beiming-10s/film.json';

export function repoRootOf(p) {
  let d = path.resolve(p);
  try { if (!fs.statSync(d).isDirectory()) d = path.dirname(d); } catch { d = path.dirname(d); }
  for (;;) {
    if (fs.existsSync(path.join(d, 'package.json')) && fs.existsSync(path.join(d, 'engine'))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

export function findFilm({ film = null, input = null }) {
  if (film) {
    const p = path.resolve(film);
    if (!fs.existsSync(p)) throw new QaError('usage.no-file', `找不到作品描述：${film}`, { hint: '--film 给作品目录或它的 film.json', exitCode: EXIT.USAGE });
    if (fs.statSync(p).isDirectory()) {
      const f = path.join(p, 'film.json');
      if (!fs.existsSync(f)) throw new QaError('usage.no-file', `目录 ${film} 里没有 film.json`, { exitCode: EXIT.USAGE });
      return f;
    }
    return p;
  }
  if (input) {
    const root = repoRootOf(input);
    let d = path.dirname(path.resolve(input));
    for (;;) {
      if (root && d === root) break;
      const f = path.join(d, 'film.json');
      if (fs.existsSync(f)) return f;
      const up = path.dirname(d);
      if (up === d || !root) break;
      d = up;
    }
    // 《北冥》样片：新运行目录 out/beiming/<run-id>/，或 build.sh 的旧产物 out/beiming.mp4、beiming_4k.mp4、beiming_web.mp4
    const relIn = root ? path.relative(root, path.resolve(input)).split(path.sep).join('/') : '';
    const beiming = (runDirOf(input) && path.basename(path.dirname(runDirOf(input))) === 'beiming') || /^out\/beiming(_4k|_web)?\.mp4$/.test(relIn);
    if (root && beiming) {
      const f = path.join(root, BEIMING_FILM);
      if (fs.existsSync(f)) return f;
    }
  }
  return null;
}

export function runDirOf(input) {
  const dir = path.dirname(path.resolve(input));
  const parent = path.basename(path.dirname(dir));
  if (/^\d{8}-\d{6}-[0-9a-f]{4,40}(-dirty)?$/i.test(path.basename(dir)) && (parent === 'out' || parent === 'beiming')) return dir;
  return null;
}

export function loadFilm(file) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    throw new QaError('input.film', `作品描述 ${file} 读不出来：${e.message}`, { hint: '先修好 JSON（node engine/production/film.js check 可定位问题）', exitCode: EXIT.USAGE });
  }
  return normalizeFilm(raw, file);
}

function range(o, fps) {
  if (!isObj(o)) return null;
  let from = o.from ?? o.in ?? o.start ?? o.inFrame;
  let to = o.to ?? o.out ?? o.end ?? o.outFrame;
  if (from === undefined && o.t0 !== undefined && fps) from = Math.round(o.t0 * fps);
  if (to === undefined && o.t1 !== undefined && fps) to = Math.round(o.t1 * fps);
  if (!isInt(from) || !isInt(to) || to <= from) return null;
  return [from, to];
}

export function normalizeQa(q, fps, warnings) {
  const out = { intentional: [], waivers: [], safeArea: null, texts: null, visual: null, sync: null, plates: null, clearColor: null };
  if (q == null) return out;
  if (!isObj(q)) { warnings.push('qa 字段应是对象，已忽略'); return out; }
  const add = (list, kind) => {
    if (list === undefined) return;
    if (!Array.isArray(list)) { warnings.push(`qa.${kind} 应是数组，已忽略`); return; }
    for (const it of list) {
      const r = range(it, fps);
      const k = it?.kind || kind;
      if (!r) { warnings.push(`qa 里有一条 ${k} 区间写法不对（要 {from, to} 整数帧、半开区间），已忽略`); continue; }
      if (!['freeze', 'black', 'flash'].includes(k)) { warnings.push(`qa 的有意画面只认 freeze / black / flash，收到 ${k}`); continue; }
      out.intentional.push({ kind: k, from: r[0], to: r[1], reason: String(it.reason || '') });
    }
  };
  add(q.intentional, 'freeze');
  add(q.holds, 'freeze');
  add(q.blackouts, 'black');
  add(q.flashes, 'flash');
  if (Array.isArray(q.waivers)) out.waivers = q.waivers;
  for (const k of ['safeArea', 'texts', 'visual', 'sync', 'plates']) if (isObj(q[k])) out[k] = q[k];
  if (typeof q.clearColor === 'string') out.clearColor = q.clearColor;
  return out;
}

export function normalizeFilm(raw, file = null) {
  const warnings = [];
  if (!isObj(raw)) throw new QaError('input.film', '作品描述必须是 JSON 对象', { exitCode: EXIT.USAGE });
  const output = isObj(raw.output) ? raw.output : {};
  const fps = parseFps(output.fps ?? raw.fps);
  const size = Array.isArray(raw.size) ? raw.size : null;
  const width = output.width ?? size?.[0] ?? null;
  const height = output.height ?? size?.[1] ?? null;
  let frameCount = isInt(output.frameCount) ? output.frameCount : null;
  if (frameCount === null && typeof raw.dur === 'number' && fps) frameCount = Math.round(raw.dur * fps.value);
  if (isInt(output.frameCount) && typeof raw.dur === 'number' && fps && Math.round(raw.dur * fps.value) !== output.frameCount) {
    warnings.push(`film.json 的 dur×fps（${Math.round(raw.dur * fps.value)}）与 output.frameCount（${output.frameCount}）不一致，按 frameCount 判定`);
  }
  const shots = Array.isArray(raw.shots) ? raw.shots.filter(isObj).map((s, i) => ({
    id: String(s.id ?? `S${i + 1}`), in: s.in, out: s.out, transition: s.transition || 'cut',
  })) : [];
  const badShot = shots.find(s => !isInt(s.in) || !isInt(s.out) || s.out <= s.in);
  if (badShot) warnings.push(`镜头 ${badShot.id} 的 in/out 不是递增的整数帧，切点核对可能不准`);
  for (let i = 1; i < shots.length; i++) {
    if (shots[i].in !== shots[i - 1].out) warnings.push(`镜头 ${shots[i - 1].id} 与 ${shots[i].id} 不首尾相接（${shots[i - 1].out} ≠ ${shots[i].in}）`);
  }
  const cuts = shots.slice(1).filter(s => isInt(s.in)).map(s => ({ frame: s.in, shot: s.id, transition: s.transition }));
  const events = Array.isArray(raw.events) ? raw.events.filter(isObj).map((e, i) => normEvent(e, i, fps)).filter(Boolean) : [];
  const audioMode = isObj(raw.audio) ? raw.audio.mode : undefined;
  const profile = output.profile || (Array.isArray(raw.deliveries) ? raw.deliveries[0] : null) || null;
  const qa = normalizeQa(raw.qa, fps?.value, warnings);
  return {
    file, dir: file ? path.dirname(file) : null,
    schemaVersion: raw.schemaVersion ?? 1,
    id: raw.id || (file ? path.basename(path.dirname(file)) : null),
    title: raw.title ?? null,
    route: raw.route ?? null,
    fps, width, height, frameCount, profile,
    shots, cuts, events, audioMode,
    aigc: isObj(raw.aigc) ? raw.aigc : null,
    native: isObj(raw.native) ? raw.native : null,
    qa, warnings,
  };
}

function normEvent(e, i, fps) {
  const id = String(e.id ?? e.cue ?? `${e.type || 'ev'}#${i}`);
  let frame = isInt(e.frame) ? e.frame : null;
  let t = typeof e.t === 'number' ? e.t : null;
  if (frame === null && t === null) return null;
  if (t === null && fps) t = frame / fps.value;
  if (frame !== null && fps) t = frame / fps.value;
  const sync = e.sync ?? null;
  const needsSound = sync !== 'none' && (Boolean(e.audio) || e.sfx === true || e.cue != null);
  const kind = sync === 'lip' || e.visual === 'lip' ? 'lip' : 'default';
  return { id, frame, t, needsSound, kind, soft: sync === 'soft', audio: typeof e.audio === 'string' ? e.audio : null, shot: e.shot ?? null };
}

// 事件表文件：film.json（events[]）、events.json（{ dur, ev: [{ t, type, cue }] }，C 路线 engine/render/events.mjs 导出）、
// 或 PRODUCTION-SPEC 的 { fps, ev: [{ id, frame, t, sfx }] }
export function loadEvents(file, fps) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    throw new QaError('usage.bad-value', `事件表 ${file} 读不出来：${e.message}`, { exitCode: EXIT.USAGE });
  }
  const f = parseFps(raw.fps) || fps;
  const list = Array.isArray(raw) ? raw : Array.isArray(raw.events) ? raw.events : Array.isArray(raw.ev) ? raw.ev : null;
  if (!list) throw new QaError('usage.bad-value', `事件表 ${file} 里找不到 events[] 或 ev[]`, { exitCode: EXIT.USAGE });
  return list.filter(isObj).map((e, i) => normEvent(e, i, f)).filter(Boolean);
}
