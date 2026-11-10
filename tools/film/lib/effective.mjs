// 北冥仓库 · 出片编排 · 本次生效的作品描述（运行目录里的 film.effective.json）。
//
// 为什么要有它：--profile 可以换成画幅、帧率都与 film.json 不同的档位（横屏作品出竖屏 30 fps 的工作版，G1 自检就这么跑）。
// 机器 QA 门（tools/qa，P07）有意要求「作品描述与档位的画幅、帧率一致，解码帧数等于作品描述的 frameCount」，文字组也按作品描述的
// 画幅开页面（docs/quality/QA-GATE.md §4.1 的 delivery.frame-count / frame-rate / duration / size；tools/qa/checks/texts.mjs 的视口）。
// 只把档位告诉 QA、作品描述仍给原 film.json，四项交付硬门必然不过，文字安全区也会在错误的视口上量。
// 所以本次的规格（画幅、帧率、帧数）与 film.json 不一致时，编排器在运行目录写一份换算好的作品描述，QA 的 --film 指向它：
//   output 的 profile / width / height / fps / frameCount 换成本次的值；v1 兼容镜像 dur / fps / size 有就一并改；
//   帧率变了时按比例换算所有按帧号写的字段：镜头 in/out（四舍五入后首尾相接，最后一镜止于 frameCount）、事件 frame / end
//   （落在所属镜头内）、停顿 holds、posterFrame、qa 的有意画面区间（intentional / holds / blackouts / flashes）与 qa.waivers 的
//   frames；按秒写的（事件 t、区间 t0 / t1、v1 的 poster）不变。换算口径与新建作品 tools/new-film.mjs 的 rescaleFrames（P02）相同。
//   id 显式写上（QA 在作品描述缺 id 时取所在目录名，而运行目录名不是作品 id）。
// 作品目录里的 film.json 一个字不改；run.json 的 filmEffective 记下这份文件、它从哪份 film.json 来、改了什么。
// 只给页面型路线（A / C）用：B 路线的原生运行时按 film.json 出片，档位与 film.json 不一致时编排器直接拒绝（profile-native-mismatch）。
//
//   specOf(film)                        → { width, height, fps, frames }（film.json 声明的规格）
//   differs(film, spec)                 → 本次规格与 film.json 是否不同（不同才需要生效描述）
//   retimeShots(shots, k, frames)       → 换算后的镜头表（首尾相接时保持首尾相接，最后一镜止于 frames）；空镜头抛 CONTRACT
//   effectiveFilm(film, spec)           → { raw, changes[] }；spec = { profileId, width, height, fps, frames }
//   writeEffectiveFilm(runDir, film, spec) → { path, sha256, from, fromSha256, profile, changes[] }（绝对路径；记进 run.json 前转相对）
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, FilmError } from './exit.mjs';
import { rel, sha256File } from './repo.mjs';

export const EFFECTIVE_NAME = 'film.effective.json';

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const isInt = Number.isInteger;
const clone = v => JSON.parse(JSON.stringify(v));
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

export const specOf = film => ({ width: film.width, height: film.height, fps: film.fps, frames: film.frameCount });

export function differs(film, spec) {
  return spec.width !== film.width || spec.height !== film.height || spec.fps !== film.fps || spec.frames !== film.frameCount;
}

// 镜头表按帧率比例换算。原表首尾相接（从 0 起、最后止于 frameCount）时换算后也首尾相接、最后一镜止于新帧数；
// 原表本身不合格时只按比例换算各自的 in / out（不合格之处由 QA 照原样告警）。换算后有镜头变空（太短的镜头换到更低帧率）时拒绝出片。
export function retimeShots(shots, k, frames, { oldFrames = null } = {}) {
  if (!Array.isArray(shots)) return shots;
  const f = x => (isInt(x) ? Math.round(x * k) : x);
  const out = shots.map(s => (isObj(s) ? { ...s, in: f(s.in), out: f(s.out) } : s));
  const ok = shots.length && shots.every(s => isObj(s) && isInt(s.in) && isInt(s.out) && s.in < s.out);
  const contiguous = ok && shots[0].in === 0 && (oldFrames === null || shots.at(-1).out === oldFrames) && shots.every((s, i) => !i || s.in === shots[i - 1].out);
  if (contiguous) {
    out.forEach((s, i) => {
      s.in = i ? out[i - 1].out : 0;
      if (i === out.length - 1) s.out = frames;
      if (isObj(s.actorClockOrigin)) for (const key of Object.keys(s.actorClockOrigin)) if (isInt(s.actorClockOrigin[key])) s.actorClockOrigin[key] = Math.min(f(s.actorClockOrigin[key]), s.in);
    });
    const empty = out.find(s => !(s.out > s.in));
    if (empty) {
      throw new FilmError(EXIT.CONTRACT, 'retime-empty-shot', `换到这个档位的帧率后，镜头 ${empty.id ?? '?'} 一帧都不剩（原镜头太短）`,
        '换一个与 film.json 同帧率的档位；或先把这个镜头加长（改 film.json 的 shots），再换帧率');
    }
  }
  return out;
}

// qa 里按帧号写的区间：{from,to} / {in,out} / {start,end} / {inFrame,outFrame}，整数才换算；t0 / t1 是秒，不动
const RANGE_KEYS = ['from', 'to', 'in', 'out', 'start', 'end', 'inFrame', 'outFrame'];
function retimeRange(r, k, frames) {
  if (!isObj(r)) return r;
  const o = { ...r };
  for (const key of RANGE_KEYS) if (isInt(o[key])) o[key] = clamp(Math.round(o[key] * k), 0, frames);
  return o;
}

export function effectiveFilm(film, spec) {
  const raw = clone(film.raw || {});
  const changes = [];
  const { profileId, width, height, fps, frames } = spec;
  const k = fps / film.fps;
  raw.id = film.id;
  const before = isObj(raw.output) ? raw.output : {};
  raw.output = { ...before, profile: profileId ?? before.profile ?? null, width, height, fps, frameCount: frames };
  if (before.profile !== raw.output.profile && raw.output.profile) changes.push(`output.profile ${before.profile ?? '（未写）'} → ${raw.output.profile}`);
  if (width !== film.width || height !== film.height) changes.push(`画幅 ${film.width}×${film.height} → ${width}×${height}`);
  if (fps !== film.fps) changes.push(`帧率 ${film.fps} → ${fps} fps`);
  if (frames !== film.frameCount) changes.push(`帧数 ${film.frameCount} → ${frames}`);
  // v1 兼容镜像（dur / fps / size）：有就跟着改，免得 QA 读到两套互相矛盾的数
  if ('fps' in raw) raw.fps = fps;
  if ('size' in raw) raw.size = [width, height];
  if ('dur' in raw) raw.dur = frames / fps;
  if (raw.schemaVersion === undefined && !('dur' in raw)) raw.schemaVersion = 2;

  if (k !== 1) {
    if (Array.isArray(raw.shots)) { raw.shots = retimeShots(raw.shots, k, frames, { oldFrames: film.frameCount }); changes.push(`镜头表按 ×${k.toFixed(4)} 换算`); }
    if (Array.isArray(raw.events)) {
      let n = 0;
      raw.events = raw.events.map(e => {
        if (!isObj(e) || !isInt(e.frame)) return e;
        const shot = Array.isArray(raw.shots) ? raw.shots.find(s => isObj(s) && s.id === e.shot && isInt(s.in) && isInt(s.out)) : null;
        const lo = shot ? shot.in : 0, hi = shot ? shot.out - 1 : frames - 1;
        const o = { ...e, frame: clamp(Math.round(e.frame * k), lo, hi) };
        if (isInt(e.end)) o.end = clamp(Math.round(e.end * k), o.frame + 1, frames);
        n++;
        return o;
      });
      if (n) changes.push(`${n} 个事件的帧号按比例换算（落在所属镜头内）`);
    }
    if (Array.isArray(raw.holds)) raw.holds = raw.holds.map(h => retimeRange(h, k, frames));
    if (isInt(raw.posterFrame)) raw.posterFrame = Math.min(Math.round(raw.posterFrame * k), frames - 1);
    if (isObj(raw.qa)) {
      for (const key of ['intentional', 'holds', 'blackouts', 'flashes']) if (Array.isArray(raw.qa[key])) raw.qa[key] = raw.qa[key].map(r => retimeRange(r, k, frames));
      if (Array.isArray(raw.qa.waivers)) {
        raw.qa.waivers = raw.qa.waivers.map(w => (isObj(w) && Array.isArray(w.frames) && w.frames.length === 2 && w.frames.every(isInt)
          ? { ...w, frames: [clamp(Math.round(w.frames[0] * k), 0, frames), clamp(Math.max(Math.round(w.frames[1] * k), Math.round(w.frames[0] * k) + 1), 0, frames)] } : w));
      }
      changes.push('qa 里按帧号写的区间与豁免帧段按比例换算');
    }
  }
  raw.$comment = `本次运行生效的作品描述（tools/film 生成，不要手改）：由 ${rel(film.file)} 换到本次规格 ${width}×${height}@${fps} fps × ${frames} 帧`
    + `（${changes.join('；') || '无改动'}）。机器 QA 的 --film 指向这份；作品目录里的 film.json 没有改。`;
  return { raw, changes };
}

export function writeEffectiveFilm(runDir, film, spec) {
  const { raw, changes } = effectiveFilm(film, spec);
  const file = path.join(runDir, EFFECTIVE_NAME);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return { path: file, sha256: sha256File(file), from: film.file, fromSha256: fs.existsSync(film.file) ? sha256File(film.file) : null, profile: spec.profileId ?? null, changes };
}
