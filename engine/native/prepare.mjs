#!/usr/bin/env node
// 北冥引擎 · 原生层 · 作品准备：按 <作品目录>/film.json 的 native 段，把原生场景要用的素材全部放进 <作品目录>/media/。
// 原生运行时只认作品自己的 media/（staticFile('x') = media/x），所以图片、模型、序列帧、声音都要先落到这里。
//
//   node engine/native/prepare.mjs <作品目录> [--only images,models,sequences,audio] [--preview]
//
// film.json → native 段（路径都相对作品目录；to 是 media/ 下的文件名）
//   images     [{ to, from }]                           复制图片 / 字体 / 许可文件
//   models     [{ to, from }]                           外部 GLB：复制 + 结构检查（validate 字段同 bridge/validate.mjs）
//              [{ to, module, export, args, … }]       由代码生成：engine/native/bridge/export.mjs（three.js 对象 → GLB + 回读）
//              [{ to, recipe, … }]                     由配方生成（复杂生物）
//   sequences  [{ to, page|video|frames, from, until, fps, size, cell }]
//                                                      序列帧图集：engine/native/sequence.mjs（page 指满足页面约定的作品目录）
//   audio      { script, out }                          运行 Python 声音脚本（PYTHONPATH = 仓库根，可直接 from engine.audio import …）
//                                                      环境变量 BNE_OUT（输出 wav 绝对路径）、BNE_DUR（秒）、BNE_FILM（作品目录）
// 最后写 media/prepared.json：每个产物的 SHA256，供复现核对。
// 环境变量：PYTHON（默认 python3）、FFMPEG、BEIMING_CHROME。
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exportModels, isGenerated } from './bridge/export.mjs';
import { validateGLB } from './bridge/validate.mjs';
import { makeSequence } from './sequence.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sha = async p => createHash('sha256').update(await readFile(p)).digest('hex');
const name = to => { if (!to || basename(to) !== to && !/^[\w.-]+\/[\w.-]+$/.test(to)) throw new Error(`to 只能是 media/ 下的文件名（可带一层子目录）：${to}`); return to; };

export async function readFilm(dir) {
  const film = JSON.parse(await readFile(resolve(dir, 'film.json'), 'utf8'));
  if (film.route !== 'b') throw new Error(`${dir}/film.json 的 route 是 ${film.route}，原生准备只处理 route = "b"`);
  for (const k of ['dur', 'fps']) if (!(film[k] > 0)) throw new Error(`film.json 缺少 ${k}`);
  if (!Array.isArray(film.size) || film.size.length !== 2) throw new Error('film.json 的 size 要写成 [宽, 高]');
  return film;
}

export async function prepare(dir, { only = null, preview = false, log = console.log } = {}) {
  dir = resolve(dir);
  const film = await readFilm(dir), N = film.native || {}, media = resolve(dir, 'media'), made = [];
  const want = k => !only || only.includes(k);
  await mkdir(media, { recursive: true });
  if (want('images')) for (const im of N.images || []) {
    const to = resolve(media, name(im.to)); await mkdir(dirname(to), { recursive: true });
    await copyFile(resolve(dir, im.from), to); made.push(im.to);
  }
  if (want('models')) {
    for (const m of (N.models || []).filter(m => !isGenerated(m))) {
      if (!m.from) throw new Error(`models 条目要有 from（外部模型）或 module / recipe（代码生成）：${JSON.stringify(m)}`);
      const to = resolve(media, name(m.to)); await mkdir(dirname(to), { recursive: true });
      await copyFile(resolve(dir, m.from), to);
      if (/\.glb$/i.test(m.to)) {
        const v = await validateGLB(to, m.validate || {});
        log(`外部模型 ${m.to}：${v.sceneTriangles} 三角面，${v.animations.map(a => `${a.name} ${a.duration}s`).join('、') || '无动画'}`);
      } else log(`外部模型 ${m.to}：.gltf 只复制不检查；它引用的 .bin / 贴图要一起列进 images`);
      made.push(m.to);
    }
    const gen = (N.models || []).filter(isGenerated);
    if (gen.length) { await exportModels(gen, { baseDir: dir, outDir: media, preview, log }); made.push(...gen.map(m => m.to)); }
  }
  if (want('sequences')) for (const s of N.sequences || []) {
    const kind = ['page', 'video', 'frames'].find(k => s[k] !== undefined);
    if (!kind) throw new Error(`sequences 条目要有 page / video / frames 之一：${JSON.stringify(s)}`);
    const sheet = await makeSequence({ kind, src: resolve(dir, s[kind]), from: s.from ?? 0, until: s.until, fps: s.fps ?? film.fps, size: s.size, cell: s.cell, out: resolve(media, name(s.to)), query: s.query || '' });
    log(`序列帧 ${s.to}：${kind} → ${sheet.frames} 帧，图集 ${sheet.grid.join('×')} 格`);
    made.push(s.to, s.to.replace(/\.png$/i, '.json'));
  }
  if (want('audio') && N.audio) {
    const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    const out = resolve(media, name(N.audio.out || 'mix.wav'));
    const p = spawnSync(python, [resolve(dir, N.audio.script)], { cwd: dir, encoding: 'utf8', env: { ...process.env, PYTHONPATH: [ROOT, process.env.PYTHONPATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'), BNE_OUT: out, BNE_DUR: String(film.dur), BNE_FILM: dir } });
    if (p.error) throw p.error;
    if (p.status !== 0) throw new Error(`声音脚本失败（${python}）：${p.stderr}\n${p.stdout}`);
    log(p.stdout.trim());
    made.push(N.audio.out || 'mix.wav');
  }
  const hashes = {};
  for (const f of made) if (existsSync(resolve(media, f))) hashes[f] = await sha(resolve(media, f));
  const old = existsSync(resolve(media, 'prepared.json')) ? JSON.parse(await readFile(resolve(media, 'prepared.json'), 'utf8')) : {};
  await writeFile(resolve(media, 'prepared.json'), JSON.stringify({ film: relative(ROOT, dir).split('\\').join('/'), assets: { ...(old.assets || {}), ...hashes } }, null, 2) + '\n');
  log(`已准备 ${relative(ROOT, media)}：${made.length} 个文件，哈希见 media/prepared.json`);
  return hashes;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), i = args.indexOf('--only');
  const dir = args.find((a, k) => !a.startsWith('--') && args[k - 1] !== '--only');
  if (!dir || args.includes('--help')) { console.log('node engine/native/prepare.mjs <作品目录> [--only images,models,sequences,audio] [--preview]'); process.exit(dir ? 0 : 2); }
  await prepare(dir, { only: i >= 0 ? args[i + 1].split(',') : null, preview: args.includes('--preview') });
}
