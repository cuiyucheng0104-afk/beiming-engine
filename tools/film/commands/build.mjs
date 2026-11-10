// 北冥仓库 · film build / film animatic：按 film.json 的路线分派出片链，产物与运行记录只写进 <作品>/out/<run-id>/。
//   A / C 页面型：probe → mix → cuecheck → video → mux → web → poster → contact → player → qa   （步骤见 engine/render/build.mjs）
//   B 原生：      prepare → preflight → native → web → poster → contact → player → qa          （见 tools/film/lib/native-steps.mjs）
//   预演（animatic）：A / C probe → mix → video（半分辨率、previs=1）→ preview → contact → player；B prepare → preflight → native（draft）→ contact → player
// --final 先查闸门（D08）：required 的 look 与 animatic 必须是用户通过或带用户原话的豁免，否则退出码 4，一帧不渲。
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, FilmError, usage } from '../lib/exit.mjs';
import { rel } from '../lib/repo.mjs';
import { loadFilm } from '../lib/spec.mjs';
import { openSession, closeSession, addOutput, parseGpu } from '../lib/session.mjs';
import { runSteps } from '../lib/pipeline.mjs';
import { deliverSteps } from '../lib/deliver.mjs';
import { nativeSteps } from '../lib/native-steps.mjs';
import { pageSteps } from '../../../engine/render/build.mjs';
import { gateStatus, assertFinalAllowed, writeWaivers, GATES } from '../lib/gates.mjs';
import { envelope } from '../lib/output.mjs';

const COMMON = {
  '--profile': { type: 'string', arg: '<档位>', help: '交付档位（默认 film.json 的 output.profile）' },
  '--workers': { type: 'int', min: 1, max: 32, arg: '<n>', help: '页面渲染并行路数（默认 4）' },
  '--size': { type: 'string', arg: '<宽x高>', help: '改画幅（不能与 --final 同用；记进 run.json）' },
  '--query': { type: 'string', arg: '<k=v>', help: '原样传给页面的查询串' },
  '--audio': { type: 'string', arg: '<none|x.wav|x.py>', help: '覆盖 film.json 的声音：none、现成混音或声音脚本' },
  '--page': { type: 'string', arg: '<目录>', help: '页面目录（默认作品目录；《北冥》样片是仓库根 .）' },
  '--out-root': { type: 'string', arg: '<目录>', help: '运行目录的上层（默认 <作品>/out）' },
  '--gpu': { type: 'enum', values: ['required', 'any', 'software-ok'], arg: '<required|any|software-ok>', help: '落到软件渲染时：required 退出码 3（默认），any / software-ok 放行并记警告' },
  '--timeout': { type: 'int', min: 10, arg: '<秒>', help: '单步超时（默认按帧数估算）' },
  '--stall': { type: 'int', min: 30, arg: '<秒>', help: '单步无输出看门狗（默认 300–600 秒）' },
  '--embed': { type: 'enum', values: ['auto', 'always', 'never'], arg: '<auto|always|never>', help: '播放页是否内嵌视频（auto：40 MB 以内内嵌）' },
  '--json': { type: 'bool', help: 'stdout 只输出一个 JSON 对象（附录 C2）' },
  '--help': { type: 'bool', help: '只打印用法' },
};

export const buildSpec = {
  positionals: [{ name: '作品目录', required: true }],
  options: {
    '--final': { type: 'bool', help: '终渲：先查 look / animatic 闸，QA 必须可用且通过' },
    '--waive': { type: 'list', values: ['look', 'animatic'], arg: '<闸,闸>', help: '出片前先记豁免（要配 --reason；终渲只认带 --quote/--source 的用户豁免）' },
    '--reason': { type: 'string', arg: '<理由>', help: '豁免理由' },
    '--quote': { type: 'string', arg: '<用户原话>', help: '豁免依据的用户原话（逐字）' },
    '--source': { type: 'string', arg: '<出处>', help: '原话出处（会话、日期、消息位置）' },
    '--from': { type: 'string', arg: '<步骤>', help: '从这一步起强制重跑（前面的步骤复用缓存）' },
    '--to': { type: 'string', arg: '<步骤>', help: '跑到这一步为止（不更新 latest 指针）' },
    '--no-cache': { type: 'bool', help: '不复用任何步骤缓存' },
    '--no-qa': { type: 'bool', help: '不跑机器 QA（不能与 --final 同用）' },
    ...COMMON,
  },
};

export const animaticSpec = { positionals: [{ name: '作品目录', required: true }], options: { '--no-cache': buildSpec.options['--no-cache'], ...COMMON } };

export const BUILD_HELP = `用法：npm run film -- build <作品目录> [选项]        （等价：node tools/film/cli.mjs build …）
按 film.json 的路线分派整条出片链：
  A / C 页面型  probe → mix → cuecheck → video → mux → web → poster → contact → player → qa
  B 原生        prepare → preflight → native → web → poster → contact → player → qa
产物只写进 <作品>/out/<run-id>/：master.mp4 web.mp4 player.html contact.jpg poster.jpg run.json qa/report.json；
完整跑完且没失败时更新 <作品>/out/latest。输入没变的步骤直接复用缓存（out/cache/）。
终渲：--final 先查闸门（look → animatic → final，决定 D08）：没有用户通过或用户豁免记录时退出码 4，一帧不渲。

选项：
${fmt(buildSpec.options)}
退出码：0 成功 · 1 运行失败 · 2 用法错误 · 3 缺环境（ffmpeg、Python 包、RAEA_BIN、软件渲染）· 4 契约 / QA / 闸门不通过 · 5 作品正被另一次运行占用 · 124 超时 · 130/143 中断
例：
  npm run film -- build films/my-film                         工作版（不查闸门）
  npm run film -- build films/my-film --final                 终渲
  npm run film -- build films/my-film --from mux              只重跑封装及之后（前面复用缓存）
  npm run film -- build films/my-film --waive look,animatic --reason "用户说不用看预演" --quote "<原话>" --source "<出处>" --final`;

export const ANIMATIC_HELP = `用法：npm run film -- animatic <作品目录> [选项]
动态预演（D08 第二道闸，导演方法步骤 7.5）：时长、切点全部取自正片时间轴；半分辨率；页面加 previs=1（作品自己决定关掉哪些后期）；
临时声用作品混音，没有声音就按 film.json 的事件与切点生成提示音。B 路线用原生 --quality draft。
产物：<作品>/out/<run-id>/animatic.mp4 contact.jpg player.html run.json；更新 out/latest-animatic。
给用户看完，按用户原话记录：npm run film -- review approve animatic <作品目录> --quote "…" --source "…" --reviewer "…"

选项：
${fmt(animaticSpec.options)}`;

export function fmt(options) {
  return Object.entries(options).map(([k, d]) => `  ${(k + (d.arg ? ' ' + d.arg : '')).padEnd(34)} ${d.help || ''}`).join('\n');
}

function stepsFor(ctx) {
  const route = ctx.film.route === 'b' ? nativeSteps({ kind: ctx.kind }) : pageSteps({ kind: ctx.kind });
  return [...route, ...deliverSteps({ kind: ctx.kind })];
}

export async function runBuild(kind, opts, positionals, command = kind) {
  if (opts.final && kind !== 'build') throw usage('--final 只用于 build');
  if (opts.final && opts.noQa) throw usage('--final 不能跳过 QA（--no-qa）');
  if (opts.noCache && opts.from) throw usage('--no-cache 与 --from 不能同时用：--from 要复用前面步骤的缓存');
  if (opts.waive && !opts.reason) throw usage('--waive 要配 --reason <理由>', '豁免必须写理由；用户的原话用 --quote，出处用 --source');
  if ((opts.quote && !opts.source) || (!opts.quote && opts.source)) throw usage('--quote 与 --source 要一起给：原话和它的出处缺一不可');
  if ((opts.quote || opts.reason) && !opts.waive) throw usage('--reason / --quote / --source 只在 --waive 时使用', '审阅通过用：npm run film -- review approve <闸> <作品目录> …');

  // 闸门在开运行目录之前判：拒绝终渲时不留任何产物
  let gateBasis = null;
  if (opts.waive || opts.final) {
    const film = loadFilm(positionals[0], { page: opts.page ? path.resolve(opts.page) : null });
    if (opts.waive) {
      const at = new Date().toISOString();
      const list = opts.waive.map(g => ({ gate: g, reason: opts.reason, quote: opts.quote || null, source: opts.source || null, kind: opts.quote ? 'user' : 'internal', recordedAt: at, recordedBy: 'tools/film/cli.mjs build --waive' }));
      const file = await writeWaivers(film, list);
      process.stderr.write(`已记豁免 ${opts.waive.join('、')}（${opts.quote ? '带用户原话' : '内部，没有用户原话：不放行 --final'}）→ ${file}\n`);
    }
    if (opts.final) {
      const status = gateStatus(film);
      gateBasis = { checked: true, basis: assertFinalAllowed(film, status) };
    }
  }

  const ctx = await openSession({ command, kind, filmArg: positionals[0], opts: { workers: 4, gpu: 'required', ...opts } });
  ctx.gateBasis = gateBasis;
  let error = null, complete = false, output = null, frameHashes = null, status = 'passed';
  try {
    const steps = stepsFor(ctx);
    ({ complete } = await runSteps(ctx, steps, { from: opts.from || null, to: opts.to || null, noCache: !!opts.noCache }));
    // 汇总产物
    const main = kind === 'animatic' ? ctx.art.animatic : ctx.art.master;
    const kinds = { master: 'master', animatic: 'animatic', web: 'web', player: 'player', contact: 'contact', poster: 'poster', qaReport: 'qa-report', mix: 'audio', events: 'events', timeline: 'timeline', technical: 'technical', manifest: 'native-manifest', cuecheckLog: 'cuecheck' };
    for (const [k, kd] of Object.entries(kinds)) addOutput(ctx, ctx.art[k], kd);
    if (main && complete) {
      const info = await ctx.media.probe(ctx.exec, main);
      output = { path: rel(main), file: path.basename(main), sha256: ctx.outputs.find(o => o.path === rel(main))?.sha256 || null, width: info.width, height: info.height, fps: info.fps, frames: info.frames, duration: info.duration, pixFmt: info.pixFmt, color: info.color, audio: info.audio, codec: info.codec, level: info.level };
      const bad = [];
      if (info.frames !== ctx.frames) bad.push(`帧数 ${info.frames}（应为 ${ctx.frames}）`);
      if (info.width !== ctx.width || info.height !== ctx.height) bad.push(`画幅 ${info.width}×${info.height}（应为 ${ctx.width}×${ctx.height}）`);
      if (!info.audio) bad.push('没有音轨');
      if (bad.length) ctx.fail(4, 'output-contract', `${path.basename(main)} 与作品描述不符：${bad.join('、')}`, '看 logs/ 下对应步骤的输出');
      frameHashes = await ctx.media.framemd5(ctx.exec, main);
      if (ctx.film.route === 'b' && !ctx.nativeDevice && ctx.meta.native?.device) ctx.nativeDevice = ctx.meta.native.device;
      if (!ctx.nativeDevice && !ctx.gpu && ctx.meta.video?.gpu) ctx.gpu = ctx.meta.video.gpu;
      if (kind === 'build' && ctx.qa?.status === 'failed') {
        status = 'failed';
        error = new FilmError(EXIT.CONTRACT, 'qa-failed', ctx.qa.message, `逐项见 ${rel(ctx.qa.reportPath || path.join(ctx.run.dir, 'qa'))}；改完重跑 npm run film -- build ${ctx.film.relDir}（输入没变的步骤会复用）`);
      }
    }
  } catch (e) { error = e; }
  const body = await closeSession(ctx, { error, complete, status, output, frameHashes });
  if (error) { error.runJson = rel(path.join(ctx.run.dir, 'run.json')); error.outputs = ctx.outputs; throw error; }
  return { ctx, body };
}

export function summarize(ctx, body) {
  const lines = [];
  const tech = body.technicalAcceptance;
  const kindLabel = { build: ctx.final ? '终渲' : '工作版出片', animatic: '动态预演' }[ctx.kind] || ctx.kind;
  lines.push(`${kindLabel}完成：${ctx.film.relDir} → ${rel(ctx.run.dir)}/`);
  for (const o of ctx.outputs.filter(o => ['master', 'animatic', 'web', 'player', 'contact', 'poster', 'qa-report'].includes(o.kind))) lines.push(`  ${o.kind.padEnd(10)} ${o.path}`);
  lines.push(`  run.json   ${rel(path.join(ctx.run.dir, 'run.json'))}`);
  if (body.output) lines.push(`  规格       ${body.output.width}×${body.output.height} · ${body.output.fps} fps · ${body.output.frames} 帧 · ${body.output.color.range}/${body.output.color.space}${body.output.audio ? ` · ${body.output.audio.codec} ${body.output.audio.rate} Hz ×${body.output.audio.channels}` : ''}`);
  const dev = body.actualDevice ? `${body.actualDevice}（${body.actualGraphicsBackend || '?'}）` : '未记录';
  lines.push(`  设备       ${dev}${body.softwareFallback ? ' ⚠ 软件渲染' : ''}`);
  const cached = ctx.steps.filter(s => s.status === 'cached').map(s => s.id);
  if (cached.length) lines.push(`  复用缓存   ${cached.join('、')}`);
  lines.push(`状态：已输出 ✓ · 技术检查 ${tech.status === 'passed' ? '通过 ✓' : tech.status === 'failed' ? '不通过 ✗' : '未运行（没有机器 QA）'} · 人工认可 未审`);
  if (ctx.kind === 'animatic') lines.push(`下一步：把 animatic.mp4 与 contact.jpg 给用户看；用户认可后 npm run film -- review approve animatic ${ctx.film.relDir} --quote "<原话>" --source "<出处>" --reviewer "<审阅人>"`);
  else if (!ctx.final) lines.push(`下一步：这是工作版。终渲：npm run film -- build ${ctx.film.relDir} --final（要求 look / animatic 闸已通过）`);
  else lines.push(`下一步：成片给用户看；用户认可后 npm run film -- review approve final ${ctx.film.relDir} --quote "<原话>" --source "<出处>" --reviewer "<审阅人>"，之后才能称「已交付」`);
  if (ctx.warnings.length) lines.push(`警告 ${ctx.warnings.length} 条（--json 看全部）：${ctx.warnings.slice(0, 3).map(w => w.message).join('；')}${ctx.warnings.length > 3 ? ' …' : ''}`);
  return lines.join('\n');
}

export async function buildCommand(opts, positionals, kind = 'build') {
  const { ctx, body } = await runBuild(kind, opts, positionals);
  return {
    env: envelope({ command: `film ${kind}`, exitCode: 0, outputs: ctx.outputs, runJson: rel(path.join(ctx.run.dir, 'run.json')), warnings: ctx.warnings, data: { runId: ctx.run.id, runDir: rel(ctx.run.dir), status: body.status, technicalAcceptance: body.technicalAcceptance.status, steps: ctx.steps.map(s => ({ id: s.id, status: s.status, seconds: s.seconds })) } }),
    human: summarize(ctx, body),
  };
}

export { GATES, parseGpu, fs };
