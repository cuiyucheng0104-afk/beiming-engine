// 北冥引擎 · 原生层 · 作品描述读取：把 film.json（v1 最小字段，或附录 C6 的 v2）规整成原生入口要用的一份规格，
// 并核对帧数契约。只读文件，不改任何东西。P05 的作品描述库落地后，这里改为调用它，接口保持不变。
//
//   readFilmSpec(dir) → {
//     dir, id, title, route: 'b', fps, width, height, frames, dur,      帧数 = round(dur × fps)（v2 直接取 output.frameCount）
//     profile, profileSource,                                         交付档位名与来源（film.json / 推断）
//     audio: { targetLUFS?, truePeakDbTP? },                          v2 的 audio 段（没有就由交付档位给）
//     native: { entry, images, models, sequences, audio, edge? },     native 段（路径相对作品目录）
//     raw }                                                           原始 JSON
//   v1：{ route: "b", title, dur, fps, size: [宽, 高], native: {…} }
//   v2：{ schemaVersion: 2, id, title, route: "b", output: { profile, width, height, fps, frameCount }, audio, deliveries, native }
//   不合法时抛 CliError：路由不是 b → 2（用法：给错了目录）；字段缺失或不合法 → 4（契约）
//
//   declaredAssets(spec) → [{ name, kind: 'file' | 'frames', from }]   film.json 声明、prepare 会放进 media/ 的全部产物
//   referencedAssets(dir) → Set<name>     作品目录里 .tsx / .ts / .js 源码的字面量引用：staticFile('x') 与 'media/x'
//   hashAsset(path) → sha256              文件直接算；目录（逐帧 PNG 序列）按「相对名 + 每个文件的 sha256」排序后再算一次
//   sourceFiles(dir) → [相对路径]          作品自己的源码（不含 media/、out/），写进 run.json 的输入哈希
import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, join, relative, resolve, sep } from 'node:path';
import { EXIT, fail, sha256File } from './cli.mjs';

const contract = (message, hint) => fail(EXIT.CONTRACT, 'film-json', message, hint);

export async function readFilmSpec(dir) {
  dir = resolve(dir);
  let text;
  try { text = await readFile(resolve(dir, 'film.json'), 'utf8'); } catch {
    throw fail(EXIT.USAGE, 'no-film', `${dir} 下没有 film.json`, '参数要给作品目录（例如 films/<名字>），新作品用 node tools/new-film.mjs b <名字> 生成');
  }
  let raw;
  try { raw = JSON.parse(text); } catch (e) { throw contract(`film.json 不是合法 JSON：${e.message}`, '修好 film.json 的语法'); }
  const route = String(raw.route ?? '').toLowerCase();
  if (route !== 'b') throw fail(EXIT.USAGE, 'wrong-route', `film.json 的 route 是 ${JSON.stringify(raw.route)}，原生入口只处理 "b"`, 'A / C 路线的作品走各自的出片入口（见 routes/README.md）');
  const out = raw.output || {};
  const fps = out.fps ?? raw.fps;
  const [w1, h1] = Array.isArray(raw.size) ? raw.size : [];
  const width = out.width ?? w1, height = out.height ?? h1;
  if (!(Number.isInteger(fps) && fps > 0)) throw contract(`fps 必须是正整数：${JSON.stringify(fps)}`, 'film.json 写 "fps": 24（v2 写在 output.fps）');
  for (const [k, v] of [['宽', width], ['高', height]]) {
    if (!(Number.isInteger(v) && v >= 16 && v % 2 === 0)) throw contract(`画面${k}必须是不小于 16 的偶数：${JSON.stringify(v)}`, 'H.264 yuv420p 要求偶数尺寸；film.json 写 "size": [1920, 1080]');
  }
  let frames = out.frameCount, dur = raw.dur;
  if (frames === undefined) {
    if (!(typeof dur === 'number' && dur > 0)) throw contract(`dur 必须是正数（秒）：${JSON.stringify(dur)}`, 'film.json 写 "dur": 3（v2 写 output.frameCount）');
    frames = Math.round(dur * fps);
  }
  if (!(Number.isInteger(frames) && frames > 0)) throw contract(`帧数必须是正整数：${JSON.stringify(frames)}`);
  if (dur !== undefined && Math.round(dur * fps) !== frames) throw contract(`dur × fps = ${dur * fps}，与 output.frameCount ${frames} 不符`, '只保留一个时长来源，或让两者一致');
  dur = frames / fps;
  const native = { entry: 'film.tsx', images: [], models: [], sequences: [], ...(raw.native || {}) };
  if (typeof native.entry !== 'string' || !/\.(tsx|ts|jsx|js)$/.test(native.entry)) throw contract(`native.entry 要指向 .tsx 编排文件：${JSON.stringify(native.entry)}`);
  const profile = out.profile || (Array.isArray(raw.deliveries) ? raw.deliveries[0] : undefined) || native.profile;
  return {
    dir, id: raw.id || basename(dir), title: raw.title ?? basename(dir), route: 'b',
    fps, width, height, frames, dur,
    profile: profile || null, profileSource: profile ? 'film.json' : null,
    audio: raw.audio && typeof raw.audio === 'object' && !Array.isArray(raw.audio) ? raw.audio : {},
    native, raw,
  };
}

export function declaredAssets(spec) {
  const N = spec.native, out = [];
  for (const im of N.images || []) out.push({ name: im.to, kind: 'file', from: im.from });
  for (const m of N.models || []) out.push({ name: m.to, kind: 'file', from: m.from || m.module || m.recipe });
  for (const s of N.sequences || []) {
    if (s.output === 'frames') out.push({ name: s.to.replace(/\/+$/, ''), kind: 'frames', from: s.page ?? s.video ?? s.frames });
    else out.push({ name: s.to, kind: 'file', from: s.page ?? s.video ?? s.frames });
    out.push({ name: s.output === 'frames' ? `${s.to.replace(/\/+$/, '')}.json` : s.to.replace(/\.png$/i, '.json'), kind: 'file', from: 'sequence' });
  }
  if (N.audio) out.push({ name: N.audio.out || 'mix.wav', kind: 'file', from: N.audio.script });
  return out;
}

const SRC_EXT = /\.(tsx|ts|jsx|js|mjs)$/;
const SOURCE_LIKE = /\.(tsx|ts|jsx|js|mjs|json|py|board|md|html|css|glsl|wgsl|wesl)$/;
async function listSources(dir, base = dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (['media', 'out', 'delivery', 'node_modules', '.git'].includes(e.name) && dir === base) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await listSources(p, base, out);
    else if (e.isFile() && SOURCE_LIKE.test(e.name)) out.push(relative(base, p).split(sep).join('/'));
  }
  return out;
}
export async function sourceFiles(dir) { return (await listSources(dir)).sort(); }

export async function referencedAssets(dir) {
  const need = new Set();
  for (const f of (await sourceFiles(dir)).filter(f => SRC_EXT.test(f))) {
    const text = await readFile(join(dir, f), 'utf8');
    for (const m of text.matchAll(/staticFile\(\s*['"]([^'"`]+)['"]\s*\)/g)) need.add(m[1]);
    for (const m of text.matchAll(/['"]media\/([^'"`]+)['"]/g)) need.add(m[1]);
  }
  return need;
}

export async function hashAsset(path) {
  const st = await stat(path);
  if (!st.isDirectory()) return sha256File(path);
  const h = createHash('sha256');
  const files = (await readdir(path)).filter(f => !f.startsWith('.')).sort();
  for (const f of files) h.update(`${f} ${await sha256File(join(path, f))}\n`);
  return h.digest('hex');
}
