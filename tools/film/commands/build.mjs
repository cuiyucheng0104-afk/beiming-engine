// 北冥仓库 · film build / film animatic：按 film.json 的路线分派出片链，产物与运行记录只写进 <作品>/out/<run-id>/。
//   A / C 页面型：probe → mix → cuecheck → video → mux → web → poster → contact → player → qa   （步骤见 engine/render/build.mjs）
//   B 原生：      prepare → preflight → native → web → poster → contact → player → qa          （见 tools/film/lib/native-steps.mjs）
//   预演（animatic）：A / C probe → mix → video（半分辨率、previs=1）→ preview → contact → player；B prepare → preflight → native（draft）→ contact → player
// --final 先查闸门（D08）：required 的 look 与 animatic 必须是用户通过或带用户原话的豁免，否则退出码 4，一帧不渲。
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, FilmError, usage } from '../lib/exit.mjs';
import { rel, sha256File } from '../lib/repo.mjs';
import { loadFilm } from '../lib/spec.mjs';
import { openSession, closeSession, addOutput, parseGpu } from '../lib/session.mjs';
import { runSteps } from '../lib/pipeline.mjs';
import { deliverSteps } from '../lib/deliver.mjs';
import { nativeSteps } from '../lib/native-steps.mjs';
import { pageSteps } from '../../../engine/render/build.mjs';
import { gateStatus, assertFinalAllowed, recordWaivers, GATES, SOURCE_KINDS } from '../lib/gates.mjs';
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
};

export const buildSpec = {
  positionals: [{ name: '作品目录', describe: '作品目录，例如 films/my-film（相对当前目录）', required: true }],
  options: {
    '--final': { type: 'bool', help: '终渲：先查 look / animatic 闸，QA 必须可用且通过' },
    '--waive': { type: 'list', values: ['look', 'animatic'], arg: '<闸,闸>', help: '出片前先记豁免（要配 --reason；终渲只认带 --quote/--source 的用户豁免）' },
    '--reason': { type: 'string', arg: '<理由>', help: '豁免理由' },
    '--quote': { type: 'string', arg: '<用户原话>', help: '豁免依据的用户原话（逐字）' },
    '--source': { type: 'string', arg: '<出处>', help: '原话出处（会话、日期、消息位置）' },
    '--source-kind': { type: 'enum', values: ['session', 'chat', 'im', 'email', 'meeting', 'document', 'other'], arg: '<种类>', help: '出处种类（默认 session）' },
    '--said-at': { type: 'string', arg: '<ISO 时间>', help: '用户说这句话的时间（默认记录时刻）' },
    '--reviewer': { type: 'string', arg: '<审阅人>', help: '豁免由谁说的（默认「用户」）' },
    '--from': { type: 'string', arg: '<步骤>', help: '从这一步起强制重跑（前面的步骤复用缓存）' },
    '--to': { type: 'string', arg: '<步骤>', help: '跑到这一步为止（不更新 latest 指针）' },
    '--no-cache': { type: 'bool', help: '不复用任何步骤缓存' },
    '--no-qa': { type: 'bool', help: '不跑机器 QA（不能与 --final 同用）' },
    ...COMMON,
  },
};

export const animaticSpec = { positionals: [{ name: '作品目录', describe: '作品目录，例如 films/my-film（相对当前目录）', required: true }], options: { '--no-cache': buildSpec.options['--no-cache'], ...COMMON } };

export const BUILD_DOC = {
  summary: '整条出片链：按 film.json 的路线分派，产物与运行记录只写进 <作品>/out/<run-id>/',
  usage: ['npm run film -- build <作品目录> [选项]', 'node tools/film/cli.mjs build <作品目录> [选项]'],
  description: [
    '出片链（--from / --to 用这些步骤名）：',
    '  A / C 页面型  probe → mix → cuecheck → video → mux → web → label → poster → contact → player → qa',
    '  B 原生        prepare → preflight → native → web → label → poster → contact → player → qa',
    '产物：master.mp4 web.mp4 player.html contact.jpg poster.jpg run.json qa/report.json；整条链跑完且 QA 通过时更新 <作品>/out/latest。',
    '输入没变的步骤直接复用缓存（out/cache/）；film.json 的 aigc.contains = true 时 master.mp4 与 web.mp4 写入隐式 AIGC 标识（D11）。',
    '机器 QA 门（node tools/qa/cli.mjs report）硬门不通过时退出码 4，结论写进 run.json 的 technicalAcceptance。',
    '终渲：--final 先查闸门（look → animatic → final，决定 D08）：没有用户认可或带用户原话的豁免时退出码 4，一帧不渲。',
  ],
  examples: [
    'npm run film -- build films/my-film                         工作版（不查闸门）',
    'npm run film -- build films/my-film --final                 终渲',
    'npm run film -- build films/my-film --from mux              只重跑封装及之后（前面复用缓存）',
    'npm run film -- build films/my-film --profile vertical-1080x1920-30',
    'npm run film -- build films/my-film --waive look,animatic --reason "<理由>" --quote "<用户原话>" --source "<出处>" --final',
  ],
};

export const ANIMATIC_DOC = {
  summary: '动态预演（D08 第二道闸）：时长与切点同正片，半分辨率，给用户看节奏',
  usage: ['npm run film -- animatic <作品目录> [选项]'],
  description: [
    '时长、切点全部取自正片时间轴；半分辨率；页面加 previs=1（作品自己决定关掉哪些后期）；',
    '临时声用作品混音，没有声音就按 film.json 的事件与切点生成提示音。B 路线用原生 --quality draft。',
    '产物：<作品>/out/<run-id>/animatic.mp4 contact.jpg player.html run.json；更新 out/latest-animatic。',
    '给用户看完，按用户原话记录：npm run film -- review approve animatic <作品目录> --quote "…" --source "…" --reviewer "…"',
  ],
  examples: ['npm run film -- animatic films/my-film'],
};

export const mixSpec = { positionals: [{ name: '作品目录', describe: '作品目录，例如 films/my-film（相对当前目录）', required: true }], options: { '--no-cache': buildSpec.options['--no-cache'], ...COMMON } };
export const assembleSpec = { positionals: [{ name: '作品目录', describe: '作品目录，例如 films/my-film（相对当前目录）', required: true }], options: { '--no-qa': buildSpec.options['--no-qa'], ...COMMON } };

export const MIX_DOC = {
  summary: '只做声音：A / C 跑到声画拍点核对，B 跑原生素材准备（含声音）',
  usage: ['npm run film -- mix <作品目录> [选项]'],
  description: [
    'A / C：probe → mix → cuecheck（页面事件表 → 声音脚本 → 声画拍点核对）；B：原生素材准备（含声音）。',
    '改了声音脚本或事件时用它，比整片重出快；输入没变就复用缓存。等价 build --to cuecheck（B：--to prepare）。',
    '产物：A / C 在 <作品>/out/<run-id>/audio/（mix.wav、stems/、cuecheck.txt）；B 在作品的 media/。',
  ],
  examples: ['npm run film -- mix films/my-film'],
};

export const ASSEMBLE_DOC = {
  summary: '画面与声音复用缓存，只重做封装及之后',
  usage: ['npm run film -- assemble <作品目录> [选项]'],
  description: [
    'A / C 从 mux 起（封装 → 网页版 → 标识 → 海报 → 联系表 → 播放页 → QA），B 从 web 起（原生的画面与封装在同一步）。',
    '等价 build --from mux（B：--from web）；前面的步骤缺缓存时退出码 2 并说明是哪一步。',
  ],
  examples: ['npm run film -- assemble films/my-film'],
};

// mix / assemble：按路线换成 build 的 --to / --from
export async function mixCommand(opts, positionals) {
  const film = loadFilm(positionals[0], { page: opts.page ? path.resolve(opts.page) : null });
  return buildCommand({ ...opts, to: film.route === 'b' ? 'prepare' : 'cuecheck' }, positionals, 'build', 'mix');
}
export async function assembleCommand(opts, positionals) {
  const film = loadFilm(positionals[0], { page: opts.page ? path.resolve(opts.page) : null });
  return buildCommand({ ...opts, from: film.route === 'b' ? 'web' : 'mux' }, positionals, 'build', 'assemble');
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
  if ((opts.quote || opts.reason || opts.sourceKind || opts.saidAt || opts.reviewer) && !opts.waive) throw usage('--reason / --quote / --source / --source-kind / --said-at / --reviewer 只在 --waive 时使用', '审阅认可用：npm run film -- review approve <闸> <作品目录> …');

  // 闸门在开运行目录之前判：拒绝终渲时不留任何产物
  let gateBasis = null, waived = null;
  if (opts.waive || opts.final) {
    const film = loadFilm(positionals[0], { page: opts.page ? path.resolve(opts.page) : null });
    if (opts.waive) {
      const r = await recordWaivers(film, opts.waive, { reason: opts.reason, quote: opts.quote, source: opts.source, sourceKind: opts.sourceKind, saidAt: opts.saidAt, reviewer: opts.reviewer });
      process.stderr.write(`已记${r.kind === 'user' ? '用户豁免' : '内部豁免说明（没有用户原话，不放行 --final）'} ${opts.waive.join('、')} → ${r.files.join('、')}\n`);
      waived = r;
    }
    if (opts.final) {
      const status = await gateStatus(film);
      gateBasis = { checked: true, by: status.by, basis: assertFinalAllowed(film, status) };
    }
  }

  const ctx = await openSession({ command, kind, filmArg: positionals[0], opts: { workers: 4, gpu: 'required', ...opts } });
  ctx.gateBasis = gateBasis;
  if (waived) {
    ctx.waived = { gates: opts.waive, kind: waived.kind, records: waived.files };
    if (waived.kind === 'internal') ctx.warn('waiver-internal', `--waive ${opts.waive.join(',')} 没有 --quote / --source：只记了内部豁免说明，不放行终渲（--final）`);
  }
  let error = null, complete = false, output = null, frameHashes = null;
  try {
    const steps = stepsFor(ctx);
    ({ complete } = await runSteps(ctx, steps, { from: opts.from || null, to: opts.to || null, noCache: !!opts.noCache }));
    // 汇总产物
    const main = kind === 'animatic' ? ctx.art.animatic : ctx.art.master;
    const kinds = { master: 'master', animatic: 'animatic', web: 'web', player: 'player', contact: 'contact', poster: 'poster', qaReport: 'qa-report', qaMarkdown: 'qa-markdown', qaContact: 'qa-contact-sheet', mix: 'audio', events: 'events', timeline: 'timeline', technical: 'technical', manifest: 'native-manifest', cuecheckLog: 'cuecheck' };
    for (const [k, kd] of Object.entries(kinds)) addOutput(ctx, ctx.art[k], kd);
    if (ctx.film.route === 'b' && !ctx.nativeDevice && ctx.meta.native?.device) ctx.nativeDevice = ctx.meta.native.device;
    if (!ctx.nativeDevice && !ctx.gpu && ctx.meta.video?.gpu) ctx.gpu = ctx.meta.video.gpu;
    if (main && complete) {
      ({ output, frameHashes } = await checkOutput(ctx, main));
      if (kind === 'animatic') {
        // 预演不是交付件：技术验收就是编排器的规格核对（帧数、画幅、帧率、音轨），证据是 checks/output.json
        ctx.nonDeliverable = true;
        ctx.specCheck = { status: 'passed', evidence: [rel(path.join(ctx.run.dir, 'checks', 'output.json'))], by: 'tools/film 预演规格核对（帧数、画幅、帧率、音轨；不是交付 QA）', summary: `预演 ${output.frames} 帧 ${output.width}×${output.height}` };
      } else if (ctx.qa?.status === 'failed') {
        error = new FilmError(EXIT.CONTRACT, 'qa-failed', ctx.qa.message, `逐项见 ${rel(ctx.qa.reportPath || path.join(ctx.run.dir, 'qa'))}；改完重跑 npm run film -- build ${ctx.film.relDir}（输入没变的步骤会复用）`);
      }
    }
  } catch (e) { error = e; }
  const body = await closeSession(ctx, { error, complete, output, frameHashes });
  if (error) { error.runJson = rel(path.join(ctx.run.dir, 'run.json')); error.outputs = withRunJson(ctx); error.warnings = ctx.warnings; throw error; }
  return { ctx, body };
}

// 信封的 outputs：本次的产物（成片、网页版、播放页、联系表、QA 报告……）再加 run.json 本身，路径相对仓库根、带 sha256；
// 远程出片（tools/remote）按它取回并核对哈希
export function withRunJson(ctx) {
  const f = path.join(ctx.run.dir, 'run.json');
  const list = ctx.outputs.filter(o => o.kind !== 'run-json');
  if (fs.existsSync(f)) list.push({ path: rel(f), sha256: sha256File(f), kind: 'run-json' });
  return list;
}

// 主产物与作品描述逐项核对（完整解码计帧），结果写进 checks/output.json；不符即退出码 4
async function checkOutput(ctx, main) {
  const info = await ctx.media.probe(ctx.exec, main);
  const sha256 = ctx.outputs.find(o => o.path === rel(main))?.sha256 || null;
  const output = { path: rel(main), file: path.basename(main), sha256, width: info.width, height: info.height, fps: info.fps, frames: info.frames, duration: info.duration, pixFmt: info.pixFmt, color: info.color, audio: info.audio, codec: info.codec, profileName: info.profile, level: info.level };
  ctx.outputInfo = output;
  const problems = [];
  if (info.frames !== ctx.frames) problems.push(`帧数 ${info.frames}（应为 ${ctx.frames}）`);
  if (info.width !== ctx.width || info.height !== ctx.height) problems.push(`画幅 ${info.width}×${info.height}（应为 ${ctx.width}×${ctx.height}）`);
  if (Math.abs(info.fps - ctx.fps) > 1e-6) problems.push(`帧率 ${info.fpsRaw}（应为 ${ctx.fps}）`);
  if (!info.audio) problems.push('没有音轨');
  const dir = path.join(ctx.run.dir, 'checks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'output.json'), JSON.stringify({ schemaVersion: 1, by: 'tools/film（ffprobe -count_frames 完整解码）', checkedAt: new Date().toISOString(), expected: { frames: ctx.frames, width: ctx.width, height: ctx.height, fps: ctx.fps, audio: true }, measured: output, problems, ok: !problems.length }, null, 2) + '\n');
  if (problems.length) ctx.fail(4, 'output-contract', `${path.basename(main)} 与作品描述不符：${problems.join('、')}`, `核对记录见 ${rel(path.join(dir, 'output.json'))}；看 logs/ 下对应步骤的输出`);
  const frameHashes = await ctx.media.framemd5(ctx.exec, main);
  if (frameHashes.length !== ctx.frames) ctx.fail(4, 'output-decode', `${path.basename(main)} 逐帧解码只得到 ${frameHashes.length} 帧（应为 ${ctx.frames}）`, '成片可能损坏；看 logs/ 后重跑');
  return { output, frameHashes };
}

export function summarize(ctx, body) {
  const lines = [];
  const tech = body.technicalAcceptance;
  const kindLabel = { mix: '声音', assemble: '重新封装' }[ctx.command] || { build: ctx.final ? '终渲' : '工作版出片', animatic: '动态预演' }[ctx.kind] || ctx.kind;
  lines.push(`${kindLabel}完成：${ctx.film.relDir} → ${rel(ctx.run.dir)}/${body.outcome === 'partial' ? `（按要求只跑到 ${ctx.steps.at(-1)?.id}）` : ''}`);
  for (const o of ctx.outputs.filter(o => ['master', 'animatic', 'web', 'player', 'contact', 'poster', 'qa-report', ...(body.outcome === 'partial' ? ['audio', 'cuecheck', 'events'] : [])].includes(o.kind))) lines.push(`  ${o.kind.padEnd(10)} ${o.path}`);
  lines.push(`  run.json   ${rel(path.join(ctx.run.dir, 'run.json'))}`);
  if (body.output) lines.push(`  规格       ${body.output.width}×${body.output.height} · ${body.output.fps} fps · ${body.output.frames} 帧 · ${body.output.color.range}/${body.output.color.space}${body.output.audio ? ` · ${body.output.audio.codec} ${body.output.audio.rate} Hz ×${body.output.audio.channels}` : ''}`);
  const dev = body.actualDevice ? `${body.actualDevice}（${body.actualGraphicsBackend || '?'}）` : null;
  if (dev || body.outcome !== 'partial') lines.push(`  设备       ${dev || '未记录'}${body.softwareFallback ? ' ⚠ 软件渲染' : ''}`);
  const cached = ctx.steps.filter(s => s.status === 'cached').map(s => s.id);
  if (cached.length) lines.push(`  复用缓存   ${cached.join('、')}`);
  if (body.outcome === 'partial') {
    lines.push(`状态：只跑了一段（${ctx.steps.filter(s => s.status !== 'skipped').map(s => s.id).join(' → ')}），不是成片；整片出片：npm run film -- build ${ctx.film.relDir}`);
    if (ctx.warnings.length) lines.push(`警告 ${ctx.warnings.length} 条（--json 看全部）：${ctx.warnings.slice(0, 3).map(w => w.message).join('；')}${ctx.warnings.length > 3 ? ' …' : ''}`);
    return lines.join('\n');
  }
  const techText = tech.status === 'passed' ? (ctx.kind === 'animatic' ? '预演规格核对通过 ✓' : '机器 QA 通过 ✓') : tech.status === 'failed' ? '不通过 ✗' : `未运行（${tech.summary || '没有机器 QA'}）`;
  lines.push(`状态：已输出 ✓ · 技术检查 ${techText} · 人工认可 未审${body.status === 'blocked' ? '（run.json 记为 blocked：技术验收没做，不能交付）' : ''}`);
  if (ctx.kind === 'animatic') lines.push(`下一步：把 animatic.mp4 与 contact.jpg 给用户看；用户认可后 npm run film -- review approve animatic ${ctx.film.relDir} --quote "<原话>" --source "<出处>" --reviewer "<审阅人>"`);
  else if (!ctx.final) lines.push(`下一步：这是工作版。终渲：npm run film -- build ${ctx.film.relDir} --final（要求 look / animatic 闸已通过）`);
  else lines.push(`下一步：成片给用户看；用户认可后 npm run film -- review approve final ${ctx.film.relDir} --quote "<原话>" --source "<出处>" --reviewer "<审阅人>"，之后才能称「已交付」`);
  if (ctx.warnings.length) lines.push(`警告 ${ctx.warnings.length} 条（--json 看全部）：${ctx.warnings.slice(0, 3).map(w => w.message).join('；')}${ctx.warnings.length > 3 ? ' …' : ''}`);
  return lines.join('\n');
}

export async function buildCommand(opts, positionals, kind = 'build', command = kind) {
  const { ctx, body } = await runBuild(kind, opts, positionals, command);
  return {
    env: envelope({ command: `film ${command}`, exitCode: 0, outputs: withRunJson(ctx), runJson: rel(path.join(ctx.run.dir, 'run.json')), warnings: ctx.warnings, data: { runId: ctx.run.id, runDir: rel(ctx.run.dir), status: body.status, technicalAcceptance: body.technicalAcceptance.status, steps: ctx.steps.map(s => ({ id: s.id, status: s.status, seconds: s.seconds })) } }),
    human: summarize(ctx, body),
  };
}

export { GATES, parseGpu, fs };
