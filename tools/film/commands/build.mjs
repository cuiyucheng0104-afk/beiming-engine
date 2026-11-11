// 北冥仓库 · film build / film animatic：按 film.json 的路线分派出片链，产物与运行记录只写进 <作品>/out/<run-id>/。
//   A / C 页面型：probe → mix → cuecheck → video → mux → web → poster → contact → player → qa   （步骤见 engine/render/build.mjs）
//   B 原生：      prepare → preflight → native → web → poster → contact → player → qa          （见 tools/film/lib/native-steps.mjs）
//   预演（animatic）：A / C probe → mix → video（半分辨率、previs=1）→ preview → contact → player；B prepare → preflight → native（draft）→ contact → player
// 顺序：用法与契约检查（planSession：作品描述、页面、本片字体子集、档位、--size / --final、步骤名）→ 写审片记录（--waive）→ 闸门（--final）→ 开运行目录；
// 前面任何一项不过都直接退出，不写记录、不建目录。
// --final 先查闸门（D08）：required 的 look 与 animatic 必须是用户通过或带用户原话的豁免，否则退出码 4，一帧不渲。
// --profile 换了画幅或帧率时，QA 读运行目录里的 film.effective.json（tools/film/lib/effective.mjs）；--size 的工作版不跑交付 QA。
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, FilmError, usage } from '../lib/exit.mjs';
import { rel, sha256File } from '../lib/repo.mjs';
import { loadFilm } from '../lib/spec.mjs';
import { planSession, openSession, closeSession, addOutput, parseGpu } from '../lib/session.mjs';
import { runSteps, checkStepName } from '../lib/pipeline.mjs';
import { deliverSteps } from '../lib/deliver.mjs';
import { nativeSteps } from '../lib/native-steps.mjs';
import { pageSteps } from '../../../engine/render/build.mjs';
import { gateStatus, assertFinalAllowed, recordWaivers, GATES, SOURCE_KINDS } from '../lib/gates.mjs';
import { envelope } from '../lib/output.mjs';

const COMMON = {
  '--profile': { type: 'string', arg: '<档位>', help: '交付档位（默认 film.json 的 output.profile）' },
  '--workers': { type: 'int', min: 1, max: 32, arg: '<n>', help: '页面渲染并行路数（默认 4）' },
  '--size': { type: 'string', arg: '<宽x高>', help: '改画幅出工作版：不是交付件，不跑交付 QA（只核对规格）；不能与 --final 同用' },
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
    '产物：master.mp4 web.mp4 player.html contact.jpg poster.jpg run.json qa/report.json。',
    'out/latest：整条链跑完且没有失败时指向这次（--no-qa、--size 的工作版也更新，它们的 run.json 分别记 blocked、rendered）；',
    '  --to 提前停、失败、被中断都不更新。',
    '输入没变的步骤直接复用缓存（out/cache/）；film.json 的 aigc.contains = true 时 master.mp4 与 web.mp4 写入隐式 AIGC 标识（D11）。',
    '机器 QA 门（node tools/qa/cli.mjs report）硬门不通过时退出码 4，结论写进 run.json 的 technicalAcceptance。',
    '--profile 换成画幅或帧率与 film.json 不同的档位时，镜头表按帧率换算，交给 QA 的作品描述是运行目录里换算好的',
    '  film.effective.json（film.json 不改；run.json 的 filmEffective 记来源与改动）。',
    '--size 改画幅的是工作版、不是交付件：不跑交付 QA，只核对帧数、画幅、帧率与音轨（不符退出码 4），符合时退出码 0。',
    '终渲：--final 先查闸门（look → animatic → final，决定 D08）：没有用户认可或带用户原话的豁免时退出码 4，一帧不渲；',
    '  终渲档位要在 film.json 的 deliveries 里。用法与契约检查全部在写审片记录（--waive）和开运行目录之前做完。',
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
  // 终渲只认带用户原话的豁免：没有原话的 --waive 只能记成内部说明，放行不了 --final，记下来也只是一条用不上的记录
  if (opts.final && opts.waive && !opts.quote) throw usage('--final 只认带用户原话的豁免：--waive 要配 --quote <用户原话> --source <出处>', '没有用户原话时先出工作版（去掉 --final）；用户认可后用 npm run film -- review approve <闸> <作品目录> 记录');

  // 先把用法与契约全部查完（作品描述、页面目录、档位、--size / --final、步骤名），再写审片记录、判闸门、开运行目录：
  // 任何一项不过都在这里退出（2 / 4），review/ 里不会多出记录，也不建运行目录
  const o = { workers: 4, gpu: 'required', ...opts };
  const plan = planSession({ kind, filmArg: positionals[0], opts: o });
  const steps = stepsFor({ film: plan.film, kind });
  checkStepName(steps, opts.from, '--from');
  checkStepName(steps, opts.to, '--to');
  const ids = steps.map(s => s.id);
  if (opts.from && opts.to && ids.indexOf(opts.to) < ids.indexOf(opts.from)) throw new FilmError(EXIT.USAGE, 'step-order', `--to ${opts.to} 在 --from ${opts.from} 之前`, `步骤顺序：${ids.join(' → ')}`);

  // 闸门在开运行目录之前判：拒绝终渲时不留任何产物
  let gateBasis = null, waived = null;
  if (opts.waive) {
    const r = await recordWaivers(plan.film, opts.waive, { reason: opts.reason, quote: opts.quote, source: opts.source, sourceKind: opts.sourceKind, saidAt: opts.saidAt, reviewer: opts.reviewer });
    process.stderr.write(`已记${r.kind === 'user' ? '用户豁免' : '内部豁免说明（没有用户原话，不放行 --final）'} ${opts.waive.join('、')} → ${r.files.join('、')}\n`);
    waived = r;
  }
  if (opts.final) {
    const status = await gateStatus(plan.film);
    gateBasis = { checked: true, by: status.by, basis: assertFinalAllowed(plan.film, status) };
  }

  const ctx = await openSession({ command, kind, filmArg: positionals[0], opts: o, plan });
  ctx.gateBasis = gateBasis;
  if (waived) {
    ctx.waived = { gates: opts.waive, kind: waived.kind, records: waived.files };
    if (waived.kind === 'internal') ctx.warn('waiver-internal', `--waive ${opts.waive.join(',')} 没有 --quote / --source：只记了内部豁免说明，不放行终渲（--final）`);
  }
  let error = null, complete = false, output = null, frameHashes = null;
  try {
    ({ complete } = await runSteps(ctx, steps, { from: opts.from || null, to: opts.to || null, noCache: !!opts.noCache }));
    // 汇总产物
    const main = kind === 'animatic' ? ctx.art.animatic : ctx.art.master;
    const kinds = { master: 'master', animatic: 'animatic', web: 'web', player: 'player', contact: 'contact', poster: 'poster', qaReport: 'qa-report', qaMarkdown: 'qa-markdown', qaContact: 'qa-contact-sheet', mix: 'audio', events: 'events', timeline: 'timeline', technical: 'technical', manifest: 'native-manifest', cuecheckLog: 'cuecheck' };
    for (const [k, kd] of Object.entries(kinds)) addOutput(ctx, ctx.art[k], kd);
    if (ctx.film.route === 'b' && !ctx.nativeDevice && ctx.meta.native?.device) ctx.nativeDevice = ctx.meta.native.device;
    if (!ctx.nativeDevice && !ctx.gpu && ctx.meta.video?.gpu) ctx.gpu = ctx.meta.video.gpu;
    if (main && complete) {
      ({ output, frameHashes } = await checkOutput(ctx, main));
      if (kind === 'animatic' || ctx.sizeWork) {
        // 预演、改画幅（--size）的工作版不是交付件：不跑交付 QA，编排器核对规格（帧数、画幅、帧率、音轨），证据是 checks/output.json；
        // 规格不符时 checkOutput 已按退出码 4 失败
        ctx.nonDeliverable = true;
        const what = kind === 'animatic' ? '预演' : `改画幅的工作版（--size ${ctx.width}x${ctx.height}）`;
        ctx.specCheck = { status: 'passed', evidence: [rel(path.join(ctx.run.dir, 'checks', 'output.json'))], by: `tools/film ${kind === 'animatic' ? '预演' : '工作版'}规格核对（帧数、画幅、帧率、音轨；不是交付 QA）`, summary: `${what} ${output.frames} 帧 ${output.width}×${output.height}` };
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

// 主产物与作品描述逐项核对（完整解码计帧），结果写进 checks/output.json。机器 QA 门跑过并给了结论时，帧数、画幅、帧率、音轨
// 以 QA 为准（它查得更全，避免两处各判一遍）：这里只记录、不另判失败；没跑 QA（预演、--no-qa、QA 未提供）时不符即退出码 4。
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
  const qaDecided = ctx.qa && ['passed', 'failed'].includes(ctx.qa.status);
  if (problems.length && qaDecided) ctx.warn('output-contract', `${path.basename(main)} 与作品描述不符：${problems.join('、')}（以机器 QA 的结论为准）`);
  else if (problems.length) ctx.fail(4, 'output-contract', `${path.basename(main)} 与作品描述不符：${problems.join('、')}`, `核对记录见 ${rel(path.join(dir, 'output.json'))}；看 logs/ 下对应步骤的输出`);
  const frameHashes = await ctx.media.framemd5(ctx.exec, main);
  if (frameHashes.length !== ctx.frames) ctx.fail(4, 'output-decode', `${path.basename(main)} 逐帧解码只得到 ${frameHashes.length} 帧（应为 ${ctx.frames}）`, '成片可能损坏；看 logs/ 后重跑');
  return { output, frameHashes };
}

export function summarize(ctx, body) {
  const lines = [];
  const tech = body.technicalAcceptance;
  const kindLabel = { mix: '声音', assemble: '重新封装' }[ctx.command] || { build: ctx.final ? '终渲' : ctx.sizeWork ? '改画幅的工作版（不是交付件）' : '工作版出片', animatic: '动态预演' }[ctx.kind] || ctx.kind;
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
  const techText = tech.status === 'passed' ? (ctx.kind === 'animatic' ? '预演规格核对通过 ✓' : '机器 QA 通过 ✓') : tech.status === 'failed' ? '不通过 ✗' : ctx.sizeWork ? '未运行（不是交付件；规格核对通过 ✓）' : `未运行（${tech.summary || '没有机器 QA'}）`;
  lines.push(`状态：已输出 ✓ · 技术检查 ${techText} · 人工认可 未审${body.status === 'blocked' ? '（run.json 记为 blocked：技术验收没做，不能交付）' : ''}`);
  if (body.filmEffective) lines.push(`  生效描述   ${body.filmEffective.path}（${body.filmEffective.changes.join('；')}）`);
  if (ctx.kind === 'animatic') lines.push(`下一步：把 animatic.mp4 与 contact.jpg 给用户看；用户认可后 npm run film -- review approve animatic ${ctx.film.relDir} --quote "<原话>" --source "<出处>" --reviewer "<审阅人>"`);
  else if (ctx.sizeWork) lines.push(`下一步：这是改画幅的工作版，不能交付。要交付按档位出：npm run film -- build ${ctx.film.relDir} --profile <档位>`);
  else if (!ctx.final) lines.push(`下一步：这是工作版。终渲：npm run film -- build ${ctx.film.relDir} --final（要求 look / animatic 闸已通过）`);
  else lines.push(`下一步：成片给用户看；用户认可后 npm run film -- review approve final ${ctx.film.relDir} --quote "<原话>" --source "<出处>" --reviewer "<审阅人>"，之后才能称「已交付」`);
  if (ctx.warnings.length) lines.push(`警告 ${ctx.warnings.length} 条（--json 看全部）：${ctx.warnings.slice(0, 3).map(w => w.message).join('；')}${ctx.warnings.length > 3 ? ' …' : ''}`);
  return lines.join('\n');
}

export async function buildCommand(opts, positionals, kind = 'build', command = kind) {
  const { ctx, body } = await runBuild(kind, opts, positionals, command);
  return {
    env: envelope({ command: `film ${command}`, exitCode: 0, outputs: withRunJson(ctx), runJson: rel(path.join(ctx.run.dir, 'run.json')), warnings: ctx.warnings, data: { runId: ctx.run.id, runDir: rel(ctx.run.dir), status: body.status, deliverable: body.deliverable, technicalAcceptance: body.technicalAcceptance.status, filmEffective: body.filmEffective?.path || null, steps: ctx.steps.map(s => ({ id: s.id, status: s.status, seconds: s.seconds })) } }),
    human: summarize(ctx, body),
  };
}

export { GATES, parseGpu, fs };
