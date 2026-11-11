#!/usr/bin/env node
// 北冥引擎 · 原生层 · 作品准备：按 <作品目录>/film.json 的 native 段，把原生场景要用的素材全部放进 <作品目录>/media/。
// 原生运行时只认作品自己的 media/（staticFile('x') = media/x），所以图片、模型、序列帧、声音都要先落到这里。
//
//   node engine/native/prepare.mjs <作品目录> [--only images,models,sequences,audio] [--preview] [--timeout 秒] [--frame-timeout 秒] [--json]
//
// film.json → native 段（路径都相对作品目录；to 是 media/ 下的文件名）
//   images     [{ to, from, edge?, crop?, flip? }]      复制图片 / 字体 / 许可文件；edge 给透明底板的截断边烘有机软边或圆形收边，
//                                                      crop / flip 从一张底板派生一块云片（engine/native/edge.mjs）
//   models     [{ to, from }]                           外部 GLB：复制 + 结构检查（validate 字段同 bridge/validate.mjs）
//              [{ to, module, export, args, … }]       由代码生成：engine/native/bridge/export.mjs（three.js 对象 → GLB + 回读）
//              [{ to, recipe, … }]                     由配方生成（复杂生物）
//   sequences  [{ to, page|video|frames, from, until, fps, size, cell, output?, alpha?, crop? }]
//                                                      序列帧：engine/native/sequence.mjs（page 指满足页面约定的作品目录）；
//                                                      fps 不写取作品帧率，size（page 的渲染尺寸）不写取作品画面尺寸
//   audio      { script, out }                          运行 Python 声音脚本（PYTHONPATH = 仓库根，可直接 from engine.audio import …）
//                                                      环境变量 BNE_OUT（输出 wav 绝对路径）、BNE_DUR（秒）、BNE_FILM（作品目录）
// 每个产物先写临时文件、通过检查后才换名到正式路径；最后原子地写 media/prepared.json：
//   { schemaVersion, film, preparedAt, tools{node, ffmpeg, python?}, inputs{来源相对路径: sha256}, assets{产物名: sha256},
//     specs{images|models|sequences|audio: 该类素材清单的 sha256} }
// 渲染入口会逐个核对 assets 的哈希（素材在 prepare 之后被改过就拒绝出片），并核对 specs（film.json 的素材清单在 prepare 之后
// 改过——例如改了 edge 参数却没重新准备——也拒绝，并说明要重做哪一类）。
// Python 用仓库统一的解释器查找（tools/env/lib/python.mjs：BEIMING_PYTHON → BEIMING_PY → PYTHON → .venv → python3 …；npm run setup 建 .venv），
// 子进程环境 PYTHONUTF8=1、PYTHONPATH 前置仓库根。FFmpeg 认 FFMPEG / FFPROBE（tools/env/lib/ffmpeg.mjs 的 ffmpegBins）。
// 环境变量：BEIMING_PYTHON / PYTHON、FFMPEG、BEIMING_CHROME。超时用选项：--timeout（资产桥整批、声音脚本各自的上限，默认 900 / 600 秒）、
// --frame-timeout（页面序列帧每帧 render(t)，默认 30 秒）。
// 退出码：0 · 1 生成失败 · 2 用法 · 3 缺来源文件 / Python 依赖 / FFmpeg · 4 film.json 或产物不合格 · 124 超时 · 130 / 143 中断
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, bind, exitWith, fail, log, runQuick, sha256File, spawnStream } from './cli.mjs';
import { defineCommand, isMain, runCli } from '../../tools/lib/cli.mjs';
import { ffmpegBins } from '../../tools/env/lib/ffmpeg.mjs';
import { pythonEnv, resolvePython } from '../../tools/env/lib/python.mjs';
import { readFilmSpec, hashAsset } from './film.mjs';
import { exportModels, isGenerated } from './bridge/export.mjs';
import { validateGLB } from './bridge/validate.mjs';
import { makeSequence } from './sequence.mjs';
import { applyEdge } from './edge.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const posix = p => p.split(sep).join('/');
const name = to => {
  if (typeof to !== 'string' || !to || to.includes('..') || /^[\\/]/.test(to) || !/^[\w.-]+(\/[\w.-]+)?\/?$/.test(to)) {
    throw fail(EXIT.CONTRACT, 'asset-name', `to 只能是 media/ 下的文件名（可带一层子目录，只用字母、数字、. _ -）：${JSON.stringify(to)}`);
  }
  return to.replace(/\/+$/, '');
};
const need = (p, what) => { if (!existsSync(p)) throw fail(EXIT.ENV, 'missing-input', `找不到${what}：${p}`, '检查 film.json 里的路径（相对作品目录）'); return p; };

export async function readFilm(dir) { return readFilmSpec(dir); }

// 每类素材清单的指纹（film.json native 段里对应的数组 / 对象，键排序后序列化）：渲染入口据此发现「清单改了、素材没重做」
export const SPEC_KINDS = ['images', 'models', 'sequences', 'audio'];
const canon = v => Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v ?? null);
// 没写与空数组算同一份清单（readFilmSpec 会把缺省的 images / models / sequences 补成 []）
export const specHash = (native, kind) => { const v = native?.[kind]; return createHash('sha256').update(canon(Array.isArray(v) && !v.length ? null : v ?? null)).digest('hex'); };

export async function prepare(dir, { only = null, preview = false, timeout = null, frameTimeout = 30 } = {}) {
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
    if (im.edge || im.crop || im.flip) {
      await applyEdge(from, to, im.edge, { crop: im.crop, flip: Boolean(im.flip) });
      log(`底板 ${im.to}：${[im.crop && `裁 ${JSON.stringify(im.crop)}`, im.flip && '水平翻转', im.edge && `${im.edge.round ? '圆形收边' : '有机软边'} ${JSON.stringify(im.edge)}`].filter(Boolean).join('，')}`);
    }
    else { await copyFile(from, `${to}.part`); await rename(`${to}.part`, to); }
    made.push(im.to);
  }
  if (want('models')) {
    for (const m of (N.models || []).filter(m => !isGenerated(m))) {
      if (!m.from) throw fail(EXIT.CONTRACT, 'model-entry', `models 条目要有 from（外部模型）或 module / recipe（代码生成）：${JSON.stringify(m)}`);
      const to = resolve(media, name(m.to)), from = need(resolve(dir, m.from), '模型');
      await mkdir(dirname(to), { recursive: true });
      await recordInput(from);
      await copyFile(from, `${to}.part`);
      if (/\.glb$/i.test(m.to)) {
        let v;
        try { v = await validateGLB(`${to}.part`, m.validate || {}); } catch (e) { await rm(`${to}.part`, { force: true }); throw fail(EXIT.CONTRACT, 'glb', `外部模型 ${m.to} 结构检查不通过：${e.message}`); }
        log(`外部模型 ${m.to}：${v.sceneTriangles} 三角面，${v.animations.map(a => `${a.name} ${a.duration}s`).join('、') || '无动画'}`);
      } else log(`外部模型 ${m.to}：.gltf 只复制不检查；它引用的 .bin / 贴图要一起列进 images`);
      await rename(`${to}.part`, to);
      made.push(m.to);
    }
    const gen = (N.models || []).filter(isGenerated);
    if (gen.length) {
      const reports = await exportModels(gen, { baseDir: dir, outDir: media, preview, timeoutMs: 1000 * (timeout ?? 900) });
      const rt = Object.values(reports).find(r => r?.runtime)?.runtime;
      if (rt) Object.assign(tools, { three: rt.three, playwright: rt.playwright, browser: rt.browser });
      for (const m of gen) { made.push(m.to, m.report || m.to.replace(/\.glb$/i, '-report.json')); for (const [f, h] of Object.entries(reports[m.to]?.sourceHashes || {})) inputs[`repo:${f}`] = h; }
    }
  }
  if (want('sequences') && (N.sequences || []).some(s => s.page !== undefined)) {
    try { tools.playwright ??= JSON.parse(await readFile(resolve(ROOT, 'node_modules/playwright-core/package.json'), 'utf8')).version; } catch { /* 没装时序列帧会自己报错 */ }
  }
  if (want('sequences')) for (const s of N.sequences || []) {
    const kind = ['page', 'video', 'frames'].find(k => s[k] !== undefined);
    if (!kind) throw fail(EXIT.CONTRACT, 'sequence-entry', `sequences 条目要有 page / video / frames 之一：${JSON.stringify(s)}`);
    const src = need(resolve(dir, s[kind]), kind === 'page' ? '页面作品目录' : kind === 'video' ? '视频' : '图片目录');
    const out = resolve(media, name(s.to));
    const sheet = await makeSequence({ kind, src, from: s.from ?? 0, until: s.until, fps: s.fps ?? spec.fps, size: s.size ?? [spec.width, spec.height], cell: s.cell, out, query: s.query || '', output: s.output || 'atlas', alpha: Boolean(s.alpha), crop: s.crop, frameTimeoutMs: 1000 * frameTimeout });
    log(`序列帧 ${s.to}：${kind} → ${sheet.frames} 帧${sheet.grid ? `，图集 ${sheet.grid.join('×')} 格` : '，逐帧 PNG'}`);
    const base = name(s.to);
    made.push(base, s.output === 'frames' ? `${base}.json` : base.replace(/\.png$/i, '.json'));
  }
  if (want('audio') && N.audio) {
    const script = need(resolve(dir, N.audio.script), '声音脚本');
    await recordInput(script);
    const outName = name(N.audio.out || 'mix.wav'), out = resolve(media, outName), part = `${out}.part.wav`;
    const py = await resolvePython({ env: process.env, want: '3.12' });
    if (!py.ok) throw fail(EXIT.ENV, 'python', `声音脚本要 Python：${py.error}`, py.hint || 'npm run setup');
    tools.python = py.versionString || null;
    const label = `${py.source}（${[py.cmd, ...py.args].join(' ')}）`;
    log(`声音：Python ${py.versionString}（${py.source}）运行 ${posix(relative(ROOT, script))}`);
    const p = await spawnStream(py.cmd, [...py.args, script], {
      cwd: dir, timeoutMs: 1000 * (timeout ?? 600), label: '声音脚本',
      env: { ...pythonEnv(process.env, { root: ROOT }), BNE_OUT: part, BNE_DUR: String(spec.dur), BNE_FILM: dir },
    });
    if (p.code !== 0) {
      await rm(part, { force: true });
      const miss = /ModuleNotFoundError: No module named '([^']+)'/.exec(p.stderr);
      if (miss) throw fail(EXIT.ENV, 'python-deps', `声音脚本缺 Python 包 ${miss[1]}（用的是 ${label}）`, '在仓库根运行 npm run setup（建 .venv 并按 requirements.lock 安装），或用 BEIMING_PYTHON 指向已装好依赖的解释器');
      throw fail(EXIT.FAIL, 'audio', `声音脚本失败（${label}，退出码 ${p.code}）：${p.stderr.trim().split('\n').slice(-3).join(' ')}`, `单独运行看完整报错：node tools/env/py.mjs ${posix(relative(ROOT, script))}`);
    }
    if (!existsSync(part)) throw fail(EXIT.CONTRACT, 'audio', `声音脚本没有写出 BNE_OUT 指定的文件`, '脚本要把结果写到环境变量 BNE_OUT 给的路径');
    await rename(part, out);
    made.push(outName);
  }
  try { tools.ffmpeg = (/ffmpeg version \S+/.exec(runQuick(ffmpegBins(process.env).ffmpeg, ['-hide_banner', '-version'], { timeoutMs: 15000 }).stdout) || [null])[0]; } catch { tools.ffmpeg = null; }

  const hashes = {};
  for (const f of made) if (existsSync(resolve(media, f))) hashes[f] = await hashAsset(resolve(media, f));
  // 只有 --only 时才沿用上次的记录（其余类别没重做）；完整准备从零记，film.json 里删掉的素材不会留在记录里
  let old = {};
  if (only && existsSync(resolve(media, 'prepared.json'))) { try { old = JSON.parse(await readFile(resolve(media, 'prepared.json'), 'utf8')); } catch { old = {}; } }
  const specs = { ...(old.specs || {}) };
  for (const k of SPEC_KINDS) if (want(k)) specs[k] = specHash(N, k);
  const record = {
    schemaVersion: 1, film: posix(relative(ROOT, dir)), preparedAt: new Date().toISOString(), tools: { ...(old.tools || {}), ...tools },
    inputs: { ...(old.inputs || {}), ...inputs }, assets: { ...(old.assets || {}), ...hashes }, specs,
  };
  await writeFile(resolve(media, 'prepared.json.part'), JSON.stringify(record, null, 2) + '\n');
  await rename(resolve(media, 'prepared.json.part'), resolve(media, 'prepared.json'));
  log(`已准备 ${posix(relative(ROOT, media))}：${made.length} 个产物，哈希见 media/prepared.json`);
  return hashes;
}

export const command = defineCommand({
  name: 'native:prepare',
  summary: '按 film.json 的 native 段把底板、模型、序列帧、声音准备进 <作品目录>/media/，写 media/prepared.json',
  usage: ['node engine/native/prepare.mjs <作品目录> [--only images,models,sequences,audio] [--preview] [--timeout <秒>] [--json]'],
  description: '每个产物先写临时文件、检查通过才换名；prepared.json 记每个产物的 sha256，渲染入口据此拒绝被改过的素材。',
  positionals: [{ name: 'film', label: '<作品目录>', describe: 'films/<名字>（B 路线作品，film.json 的 route 是 "b"）' }],
  options: {
    only: { type: 'list', split: ',', arg: '<类别,…>', choices: ['images', 'models', 'sequences', 'audio'], describe: '只做其中几类；其余产物的旧哈希保留' },
    preview: { type: 'boolean', describe: '资产桥另存一张回读预览图（film.json 的 models[].preview）' },
    timeout: { type: 'number', arg: '<秒>', min: 1, describe: '资产桥（整批）与声音脚本各自的超时（默认 900 秒、600 秒）' },
    'frame-timeout': { type: 'number', arg: '<秒>', min: 1, describe: '页面序列帧每帧 render(t) 的超时（默认 30 秒）' },
  },
  exitCodes: { 0: '成功', 1: '生成失败', 2: '用法错误', 3: '缺来源文件、Python 依赖或 FFmpeg', 4: 'film.json 或产物不合格', 124: '超时', 130: '中断（已清理）' },
  examples: ['node engine/native/prepare.mjs films/my-film', 'node engine/native/prepare.mjs films/my-film --only audio'],
  async run(ctx) {
    bind(ctx);
    const only = ctx.opts.only.length ? [...new Set(ctx.opts.only)] : null;
    const hashes = await prepare(ctx.args.film, { only, preview: ctx.opts.preview, timeout: ctx.opts.timeout, frameTimeout: ctx.opts['frame-timeout'] ?? 30 });
    const media = resolve(ctx.args.film, 'media');
    return { outputs: Object.entries(hashes).map(([f, sha256]) => ({ path: posix(relative(ROOT, resolve(media, f))), sha256, kind: 'asset' })) };
  },
});

if (isMain(import.meta.url)) await exitWith(runCli(command));
