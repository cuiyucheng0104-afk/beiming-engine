#!/usr/bin/env node
// 北冥引擎 · 原生层 · 作品准备：按 <作品目录>/film.json 的 native 段，把原生场景要用的素材全部放进 <作品目录>/media/。
// 原生运行时只认作品自己的 media/（staticFile('x') = media/x），所以图片、模型、序列帧、声音都要先落到这里。
//
//   node engine/native/prepare.mjs <作品目录> [--only images,models,sequences,audio] [--preview] [--json]
//
// film.json → native 段（路径都相对作品目录；to 是 media/ 下的文件名）
//   images     [{ to, from, edge? }]                    复制图片 / 字体 / 许可文件；edge 给透明底板的截断边烘有机软边（engine/native/edge.mjs）
//   models     [{ to, from }]                           外部 GLB：复制 + 结构检查（validate 字段同 bridge/validate.mjs）
//              [{ to, module, export, args, … }]       由代码生成：engine/native/bridge/export.mjs（three.js 对象 → GLB + 回读）
//              [{ to, recipe, … }]                     由配方生成（复杂生物）
//   sequences  [{ to, page|video|frames, from, until, fps, size, cell, output?, alpha?, crop? }]
//                                                      序列帧：engine/native/sequence.mjs（page 指满足页面约定的作品目录）
//   audio      { script, out }                          运行 Python 声音脚本（PYTHONPATH = 仓库根，可直接 from engine.audio import …）
//                                                      环境变量 BNE_OUT（输出 wav 绝对路径）、BNE_DUR（秒）、BNE_FILM（作品目录）
// 每个产物先写临时文件、通过检查后才换名到正式路径；最后原子地写 media/prepared.json：
//   { schemaVersion, film, preparedAt, tools{node, ffmpeg, python?}, inputs{来源相对路径: sha256}, assets{产物名: sha256} }
// 渲染入口会逐个核对 assets 的哈希，素材在 prepare 之后被改过就拒绝出片。
// 环境变量：PYTHON（默认 python3 / Windows python）、FFMPEG、BEIMING_CHROME、BNE_AUDIO_TIMEOUT / BNE_BRIDGE_TIMEOUT（秒）。
// 退出码：0 · 1 生成失败 · 2 用法 · 3 缺来源文件 / Python 依赖 / FFmpeg · 4 film.json 或产物不合格 · 124 超时 · 130 / 143 中断
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, EXIT, exitWith, isMain, log, runCli, runQuick, sha256File, spawnStream } from './cli.mjs';
import { readFilmSpec, hashAsset } from './film.mjs';
import { exportModels, isGenerated } from './bridge/export.mjs';
import { validateGLB } from './bridge/validate.mjs';
import { makeSequence } from './sequence.mjs';
import { applyEdge } from './edge.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const posix = p => p.split(sep).join('/');
const name = to => {
  if (typeof to !== 'string' || !to || to.includes('..') || /^[\\/]/.test(to) || !/^[\w.-]+(\/[\w.-]+)?\/?$/.test(to)) {
    throw new CliError(EXIT.CONTRACT, 'asset-name', `to 只能是 media/ 下的文件名（可带一层子目录，只用字母、数字、. _ -）：${JSON.stringify(to)}`);
  }
  return to.replace(/\/+$/, '');
};
const need = (p, what) => { if (!existsSync(p)) throw new CliError(EXIT.ENV, 'missing-input', `找不到${what}：${p}`, '检查 film.json 里的路径（相对作品目录）'); return p; };

export async function readFilm(dir) { return readFilmSpec(dir); }

export async function prepare(dir, { only = null, preview = false } = {}) {
  dir = resolve(dir);
  const spec = await readFilmSpec(dir), N = spec.native, media = resolve(dir, 'media'), made = [], inputs = {};
  const want = k => !only || only.includes(k);
  const recordInput = async p => { inputs[posix(relative(dir, p))] = await sha256File(p); };
  await mkdir(media, { recursive: true });
  const tools = { node: process.version };

  if (want('images')) for (const im of N.images || []) {
    const to = resolve(media, name(im.to)), from = need(resolve(dir, im.from), '图片');
    await mkdir(dirname(to), { recursive: true });
    await recordInput(from);
    if (im.edge) { await applyEdge(from, to, im.edge); log(`底板 ${im.to}：烘入有机软边 ${JSON.stringify(im.edge)}`); }
    else { await copyFile(from, `${to}.part`); await rename(`${to}.part`, to); }
    made.push(im.to);
  }
  if (want('models')) {
    for (const m of (N.models || []).filter(m => !isGenerated(m))) {
      if (!m.from) throw new CliError(EXIT.CONTRACT, 'model-entry', `models 条目要有 from（外部模型）或 module / recipe（代码生成）：${JSON.stringify(m)}`);
      const to = resolve(media, name(m.to)), from = need(resolve(dir, m.from), '模型');
      await mkdir(dirname(to), { recursive: true });
      await recordInput(from);
      await copyFile(from, `${to}.part`);
      if (/\.glb$/i.test(m.to)) {
        let v;
        try { v = await validateGLB(`${to}.part`, m.validate || {}); } catch (e) { await rm(`${to}.part`, { force: true }); throw new CliError(EXIT.CONTRACT, 'glb', `外部模型 ${m.to} 结构检查不通过：${e.message}`); }
        log(`外部模型 ${m.to}：${v.sceneTriangles} 三角面，${v.animations.map(a => `${a.name} ${a.duration}s`).join('、') || '无动画'}`);
      } else log(`外部模型 ${m.to}：.gltf 只复制不检查；它引用的 .bin / 贴图要一起列进 images`);
      await rename(`${to}.part`, to);
      made.push(m.to);
    }
    const gen = (N.models || []).filter(isGenerated);
    if (gen.length) {
      const reports = await exportModels(gen, { baseDir: dir, outDir: media, preview, timeoutMs: 1000 * Number(process.env.BNE_BRIDGE_TIMEOUT || 900) });
      for (const m of gen) { made.push(m.to, m.report || m.to.replace(/\.glb$/i, '-report.json')); for (const [f, h] of Object.entries(reports[m.to]?.sourceHashes || {})) inputs[`repo:${f}`] = h; }
    }
  }
  if (want('sequences')) for (const s of N.sequences || []) {
    const kind = ['page', 'video', 'frames'].find(k => s[k] !== undefined);
    if (!kind) throw new CliError(EXIT.CONTRACT, 'sequence-entry', `sequences 条目要有 page / video / frames 之一：${JSON.stringify(s)}`);
    const src = need(resolve(dir, s[kind]), kind === 'page' ? '页面作品目录' : kind === 'video' ? '视频' : '图片目录');
    const out = resolve(media, name(s.to));
    const sheet = await makeSequence({ kind, src, from: s.from ?? 0, until: s.until, fps: s.fps ?? spec.fps, size: s.size, cell: s.cell, out, query: s.query || '', output: s.output || 'atlas', alpha: Boolean(s.alpha), crop: s.crop });
    log(`序列帧 ${s.to}：${kind} → ${sheet.frames} 帧${sheet.grid ? `，图集 ${sheet.grid.join('×')} 格` : '，逐帧 PNG'}`);
    const base = name(s.to);
    made.push(base, s.output === 'frames' ? `${base}.json` : base.replace(/\.png$/i, '.json'));
  }
  if (want('audio') && N.audio) {
    const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    const script = need(resolve(dir, N.audio.script), '声音脚本');
    await recordInput(script);
    const outName = name(N.audio.out || 'mix.wav'), out = resolve(media, outName), part = `${out}.part.wav`;
    const pv = runQuick(python, ['-c', 'import sys; print(sys.version.split()[0])'], { label: `Python（${python}）`, timeoutMs: 20000 });
    tools.python = pv.stdout.trim() || null;
    log(`声音：${python} ${posix(relative(ROOT, script))}`);
    const p = await spawnStream(python, [script], {
      cwd: dir, timeoutMs: 1000 * Number(process.env.BNE_AUDIO_TIMEOUT || 600), label: '声音脚本',
      env: { ...process.env, PYTHONPATH: [ROOT, process.env.PYTHONPATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'), BNE_OUT: part, BNE_DUR: String(spec.dur), BNE_FILM: dir, PYTHONIOENCODING: 'utf-8' },
    });
    if (p.code !== 0) {
      await rm(part, { force: true });
      const miss = /ModuleNotFoundError: No module named '([^']+)'/.exec(p.stderr);
      if (miss) throw new CliError(EXIT.ENV, 'python-deps', `声音脚本缺 Python 包 ${miss[1]}（用的是 ${python}）`, '安装 requirements.txt：python3 -m pip install -r requirements.txt，或把 PYTHON 指向已装 numpy / scipy / soundfile / numba 的解释器');
      throw new CliError(EXIT.FAIL, 'audio', `声音脚本失败（${python}，退出码 ${p.code}）：${p.stderr.trim().split('\n').slice(-3).join(' ')}`);
    }
    if (!existsSync(part)) throw new CliError(EXIT.CONTRACT, 'audio', `声音脚本没有写出 BNE_OUT 指定的文件`, '脚本要把结果写到环境变量 BNE_OUT 给的路径');
    await rename(part, out);
    made.push(outName);
  }
  try { tools.ffmpeg = (/ffmpeg version \S+/.exec(runQuick(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-version'], { timeoutMs: 15000 }).stdout) || [null])[0]; } catch { tools.ffmpeg = null; }

  const hashes = {};
  for (const f of made) if (existsSync(resolve(media, f))) hashes[f] = await hashAsset(resolve(media, f));
  const old = existsSync(resolve(media, 'prepared.json')) ? JSON.parse(await readFile(resolve(media, 'prepared.json'), 'utf8')) : {};
  const record = {
    schemaVersion: 1, film: posix(relative(ROOT, dir)), preparedAt: new Date().toISOString(), tools,
    inputs: { ...(old.inputs || {}), ...inputs }, assets: { ...(old.assets || {}), ...hashes },
  };
  await writeFile(resolve(media, 'prepared.json.part'), JSON.stringify(record, null, 2) + '\n');
  await rename(resolve(media, 'prepared.json.part'), resolve(media, 'prepared.json'));
  log(`已准备 ${posix(relative(ROOT, media))}：${made.length} 个产物，哈希见 media/prepared.json`);
  return hashes;
}

const USAGE = `node engine/native/prepare.mjs <作品目录> [--only images,models,sequences,audio] [--preview] [--json]
  按 film.json 的 native 段把素材准备进 <作品目录>/media/，写 media/prepared.json（每个产物的 sha256）
  --only     只做其中几类（逗号分隔）；其余产物的旧哈希保留
  --preview  资产桥另存一张回读预览图（film.json 的 models[].preview）
  --json     stdout 只输出一个 JSON 信封
退出码：0 · 1 生成失败 · 2 用法 · 3 缺来源文件 / Python 依赖 / FFmpeg · 4 film.json 或产物不合格 · 124 超时`;

export async function main(argv = process.argv.slice(2)) {
  return runCli({
    command: 'prepare', usage: USAGE, argv, spec: { '--only': 'string', '--preview': 'bool' },
    main: async a => {
      if (a._.length !== 1) throw new CliError(EXIT.USAGE, 'usage', a._.length ? '只能给一个作品目录' : '缺少作品目录', '用法：node engine/native/prepare.mjs films/<名字>');
      const only = a.only ? a.only.split(',').map(s => s.trim()) : null;
      if (only) for (const k of only) if (!['images', 'models', 'sequences', 'audio'].includes(k)) throw new CliError(EXIT.USAGE, 'usage', `--only 不认识 ${k}`, '可用：images,models,sequences,audio');
      const hashes = await prepare(a._[0], { only, preview: Boolean(a.preview) });
      const media = resolve(a._[0], 'media');
      return { outputs: Object.entries(hashes).map(([f, sha256]) => ({ path: posix(relative(ROOT, resolve(media, f))), sha256, kind: 'asset' })), runJson: null };
    },
  });
}

if (isMain(import.meta.url)) await exitWith(main());
