// 北冥引擎 · 渲染器读 film.json 的最小子集（作品描述的完整校验归 engine/production，这里只取渲染要用的字段）。
// 兼容 v1（{ route, title, dur, fps, size }，frameCount = round(dur × fps)）与 v2（附录 C6：output{ profile, width, height,
// fps, frameCount }、shots[{ id, in, out, module }]，帧号含头不含尾）。不存在 film.json 时返回 null（例如《北冥》样片在仓库根）。
//   readFilm(dir)  → null | { file, version, id, title, route, backend, output, shots, aigc }
//   pickShot(film, id) / shotsByIds(film, ids)：按 id 取镜头；不认识的 id → usage.shot-unknown（列出可用 id）
import fs from 'node:fs';
import path from 'node:path';
import { RenderError } from './errors.mjs';

const int = v => (Number.isInteger(v) ? v : null);

export function readFilm(dir) {
  const file = path.join(dir, 'film.json');
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new RenderError('contract.film-json', `${file} 不是合法 JSON：${e.message}`, { hint: '先修好 film.json（node engine/production/film.js check 可逐项检查）' });
  }
  const v2 = j.schemaVersion === 2 || (j.output && typeof j.output === 'object');
  let output;
  if (v2) {
    const o = j.output ?? {};
    output = { profile: o.profile ?? null, width: int(o.width), height: int(o.height), fps: Number.isFinite(o.fps) ? o.fps : null, frameCount: int(o.frameCount) };
  } else {
    const fps = Number.isFinite(j.fps) ? j.fps : null;
    output = {
      profile: j.profile ?? null, width: int(j.size?.[0]), height: int(j.size?.[1]), fps,
      frameCount: Number.isFinite(j.dur) && fps ? Math.round(j.dur * fps) : null,
    };
  }
  const shots = Array.isArray(j.shots) ? j.shots.filter(s => s && typeof s.id === 'string').map(s => ({
    id: s.id, in: int(s.in), out: int(s.out), module: typeof s.module === 'string' ? s.module : null, raw: s,
  })) : [];
  for (const s of shots) {
    if (s.in === null || s.out === null || !(s.out > s.in)) {
      throw new RenderError('contract.film-shots', `${file} 的镜头 ${s.id} 的 in / out 要是整数帧号且 out > in（收到 in=${s.raw.in} out=${s.raw.out}）`, { hint: '帧号含头不含尾：镜头 [in, out)，下一个镜头的 in 等于上一个的 out' });
    }
  }
  return {
    file, version: v2 ? 2 : 1, id: typeof j.id === 'string' ? j.id : path.basename(path.resolve(dir)),
    title: j.title ?? null, route: j.route ?? null, backend: j.backend ?? null, output, shots,
    aigc: j.aigc && typeof j.aigc === 'object' ? j.aigc : null, raw: j,
  };
}

export function shotsByIds(film, ids) {
  if (!film?.shots?.length) throw new RenderError('usage.no-shots', 'film.json 里没有镜头表（v2 的 shots[]）', { hint: '--shot / --shots 要求 film.json v2 的 shots: [{ id, in, out, module }]；只要一段帧就用 --frames 起:止' });
  const known = new Map(film.shots.map(s => [s.id, s]));
  const bad = ids.filter(id => !known.has(id));
  if (bad.length) throw new RenderError('usage.shot-unknown', `film.json 里没有镜头 ${bad.join('、')}`, { hint: `可用：${film.shots.map(s => s.id).join(' / ')}` });
  return ids.map(id => known.get(id));
}
export const pickShot = (film, id) => shotsByIds(film, [id])[0];
