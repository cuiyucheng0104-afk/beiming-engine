#!/usr/bin/env node
// 北冥仓库 · 出片编排命令（npm run film -- <子命令>）：一条 Node 命令依据作品描述 film.json 出片，三条路线、三个平台同一套参数。
//   node tools/film/cli.mjs <new|check|stills|animatic|build|mix|assemble|render|qa|review|approve|status> … [--json] [--help]
// 约定（加固计划附录 C）：
//   退出码 C1：0 成功 · 1 运行失败 · 2 用法错误 · 3 缺环境 · 4 契约 / 验收 / 闸门不通过 · 5 资源忙 · 124 超时 · 130/143 中断
//   --json C2：stdout 只输出一个对象 { ok, exitCode, command, error, outputs[], runJson, warnings[] }；过程日志一律走 stderr
//   --help：打印到 stdout、退出码 0、没有任何副作用（不建目录、不启动浏览器或子进程）
//   运行目录 C4：films/<名>/out/<run-id>/ + latest 指针；run.json C8：每次运行都写（失败、被中断也写）
// 详细说明与对其它工作包的接口：tools/film/README.md。
import { EXIT, asFilmError, usage } from './lib/exit.mjs';
import { parseArgs } from './lib/args.mjs';
import { envelope, emit } from './lib/output.mjs';
import { installSignals } from './lib/session.mjs';

const TOP_HELP = `北冥出片编排：npm run film -- <子命令> [参数]        （等价：node tools/film/cli.mjs <子命令> …）

做一部片的顺序（三道闸 look → animatic → final，决定 D08；每道闸都要用户看过、按原话记录，agent 不得自己批准）：
  new <a|b|c> <名字> [--title 标题]       新建作品（转调 tools/new-film.mjs）
  check <作品目录>                         只读检查：作品描述（P05）、页面契约 / 原生预检、档位与镜头表
  stills <作品目录>                        风格关键帧 + 联系表                  → review approve look
  animatic <作品目录>                      低清动态预演 + 联系表 + 播放页        → review approve animatic
  build <作品目录> [--final]               整条出片链 → out/<run-id>/           → review approve final（之后才能称「已交付」）
  mix <作品目录>                           只做声音（A / C 到声画拍点核对；B 原生素材准备）
  assemble <作品目录>                      画面与声音复用缓存，只重做封装及之后
  render <作品目录> --frames a:b|--shot S  只渲指定帧段或镜头（帧级复用）；--final 先查闸门
  qa <作品目录> [--run <run-id>]           对已出的片子补跑机器 QA 门（P07），回写 run.json
  review approve|reject|waive|note|status  闸门审阅记录；approve … 是 review approve … 的简写
  status <作品目录>                        闸门、最近运行与下一步

产物只写进 <作品>/out/<run-id>/（master.mp4 web.mp4 player.html contact.jpg poster.jpg run.json qa/report.json），
最近一次成功的完整出片记在 out/latest（指针文件）。每个子命令都有 --help；--json 时 stdout 只有一个 JSON 对象。
退出码：0 成功 · 1 运行失败 · 2 用法错误 · 3 缺环境 · 4 契约 / QA / 闸门不通过 · 5 作品被占用 · 124 超时 · 130/143 中断
《北冥》10 秒样片：sh build.sh（转调 build films/beiming-10s --page . --out-root out/beiming，再按旧文件名放进 out/）。`;

const COMMANDS = ['new', 'check', 'stills', 'animatic', 'build', 'mix', 'assemble', 'render', 'qa', 'review', 'approve', 'status'];

// 子命令 → { 模块, 用法文字, 参数表, 执行 }；模块按需加载（--help 不加载渲染相关的库）
const TABLE = {
  build: { mod: './commands/build.mjs', help: m => m.BUILD_HELP, spec: m => m.buildSpec, run: (m, o, p) => m.buildCommand(o, p, 'build') },
  animatic: { mod: './commands/build.mjs', help: m => m.ANIMATIC_HELP, spec: m => m.animaticSpec, run: (m, o, p) => m.buildCommand(o, p, 'animatic') },
  stills: { mod: './commands/frames.mjs', help: m => m.STILLS_HELP, spec: m => m.stillsSpec, run: (m, o, p) => m.framesCommand('stills', o, p) },
  render: { mod: './commands/frames.mjs', help: m => m.RENDER_HELP, spec: m => m.renderSpec, run: (m, o, p) => m.framesCommand('render', o, p) },
  mix: { mod: './commands/build.mjs', help: m => m.MIX_HELP, spec: m => m.mixSpec, run: (m, o, p) => m.mixCommand(o, p) },
  assemble: { mod: './commands/build.mjs', help: m => m.ASSEMBLE_HELP, spec: m => m.assembleSpec, run: (m, o, p) => m.assembleCommand(o, p) },
  qa: { mod: './commands/qa.mjs', help: m => m.QA_HELP, spec: m => m.qaSpec, run: (m, o, p) => m.qaCommand(o, p) },
  review: { mod: './commands/review.mjs', help: m => m.REVIEW_HELP, spec: m => m.reviewSpec, run: (m, o, p) => m.reviewCommand(o, p) },
  status: { mod: './commands/status.mjs', help: m => m.STATUS_HELP, spec: m => m.statusSpec, run: (m, o, p) => m.statusCommand(o, p) },
  check: { mod: './commands/check.mjs', help: m => m.CHECK_HELP, spec: m => m.checkSpec, run: (m, o, p) => m.checkCommand(o, p) },
};

async function main(argv) {
  let [cmd, ...rest] = argv;
  const json = argv.includes('--json');
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(TOP_HELP + '\n');
    return cmd ? EXIT.OK : EXIT.USAGE;
  }
  if (cmd.startsWith('-')) throw usage(`缺少子命令（收到选项 ${cmd}）`, `可用：${COMMANDS.join(' ')}；npm run film -- --help 看说明`);
  const wantsHelp = rest.includes('--help') || rest.includes('-h');

  if (cmd === 'new') {
    const { newCommand, NEW_HELP } = await import('./commands/new.mjs');
    if (wantsHelp) { process.stdout.write(NEW_HELP + '\n'); return EXIT.OK; }
    const r = await newCommand(rest, { json });
    if (r.passthrough) { if (json) process.stdout.write(JSON.stringify(r.env) + '\n'); return r.exitCode; }
    return emit(r.env, { json, human: r.human });
  }
  if (cmd === 'approve') { cmd = 'review'; rest = ['approve', ...rest]; }
  const t = TABLE[cmd];
  if (!t) throw usage(`不认识的子命令「${cmd}」`, `可用：${COMMANDS.join(' ')}；npm run film -- --help 看说明`);
  const m = await import(t.mod);
  if (wantsHelp) { process.stdout.write(t.help(m) + '\n'); return EXIT.OK; }
  const { opts, positionals } = parseArgs(rest, t.spec(m));
  // render --final 不给帧段 = 整片终渲（与 build --final 相同，闸门照查）
  if (cmd === 'render' && opts.final && !opts.frames && !opts.shot) {
    const b = await import('./commands/build.mjs');
    process.stderr.write('render --final 没给帧段：按整片终渲处理（等价 build --final）\n');
    const { clip, ...rest2 } = opts;
    if (clip) throw usage('--clip 只用于 --frames / --shot 帧段');
    const r = await b.buildCommand({ ...rest2 }, positionals, 'build', 'render');
    return emit(r.env, { json, human: r.human });
  }
  const r = await t.run(m, opts, positionals);
  return emit(r.env, { json, human: r.human });
}

installSignals();
const argv = process.argv.slice(2);
const json = argv.includes('--json');
let code;
try {
  code = await main(argv);
} catch (e) {
  const fe = asFilmError(e);
  const cmd = argv[0] && !argv[0].startsWith('-') ? `film ${argv[0]}` : 'film';
  code = emit(envelope({ command: cmd, exitCode: fe.exitCode, error: fe, outputs: e.outputs || [], runJson: e.runJson || null, warnings: e.warnings || [] }), { json });
  if (fe.code === 'internal' && process.env.FILM_DEBUG) process.stderr.write(`${fe.details?.stack || ''}\n`);
}
process.exitCode = code;
// 正常情况下事件循环自然结束；万一有句柄没关（例如第三方库的定时器），2 秒后按同一退出码结束，不让调用方挂住
setTimeout(() => process.exit(code), 2000).unref();
