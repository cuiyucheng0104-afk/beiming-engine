#!/usr/bin/env node
// 北冥仓库 · 出片编排命令（npm run film -- <子命令>）：一条 Node 命令依据作品描述 film.json 出片，三条路线、三个平台同一套参数。
//   node tools/film/cli.mjs <new|check|stills|animatic|build|render|review|status> … [--json] [--help]
// 约定（加固计划附录 C）：
//   退出码 C1：0 成功 · 1 运行失败 · 2 用法错误 · 3 缺环境 · 4 契约 / 验收 / 闸门不通过 · 5 资源忙 · 124 超时 · 130/143 中断
//   --json C2：stdout 只输出一个对象 { ok, exitCode, command, error, outputs[], runJson, warnings[] }；过程日志一律走 stderr
//   --help：打印到 stdout、退出码 0、没有任何副作用（不建目录、不启动浏览器或子进程）
//   运行目录 C4：films/<名>/out/<run-id>/ + latest 指针；run.json C8：每次运行都写（失败、被中断也写）
// 详细说明与对其它工作包的接口：tools/film/README.md。
import { EXIT, FilmError, asFilmError, usage } from './lib/exit.mjs';
import { parseArgs } from './lib/args.mjs';
import { envelope, emit } from './lib/output.mjs';
import { installSignals } from './lib/session.mjs';

const TOP_HELP = `北冥出片编排：npm run film -- <子命令> [参数]        （等价：node tools/film/cli.mjs <子命令> …）

做一部片的顺序（三道闸 look → animatic → final，决定 D08；每道闸都要用户看过、按原话记录）：
  new <a|b|c> <名字> [--title 标题]     新建作品（转调 tools/new-film.mjs）
  check <作品目录>                       只读检查：作品描述（P05）、页面契约 / 原生预检
  stills <作品目录>                      风格关键帧 + 联系表               → review approve look
  animatic <作品目录>                    低清动态预演 + 联系表 + 播放页     → review approve animatic
  build <作品目录> [--final]             整条出片链 → out/<run-id>/        → review approve final（之后才能称「已交付」）
  render <作品目录> --frames a:b|--shot S  只渲指定帧段或镜头（帧级复用）
  review approve|reject|waive|note|status …   闸门审阅记录（agent 不得自己批准）
  status <作品目录>                      闸门、最近运行与下一步

产物只写进 <作品>/out/<run-id>/（master.mp4 web.mp4 player.html contact.jpg run.json qa/report.json），最近一次成功的完整出片记在 out/latest。
每个子命令都有 --help；--json 时 stdout 只有一个 JSON 对象。
退出码：0 成功 · 1 运行失败 · 2 用法错误 · 3 缺环境 · 4 契约 / QA / 闸门不通过 · 5 作品被占用 · 124 超时 · 130/143 中断
《北冥》10 秒样片：sh build.sh（= build films/beiming-10s --page . --out-root out/beiming）。`;

async function main(argv) {
  const [cmd, ...rest] = argv;
  const json = rest.includes('--json') || argv.includes('--json');
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(TOP_HELP + '\n');
    return cmd ? EXIT.OK : EXIT.USAGE;
  }
  if (cmd === '--json') throw usage('缺少子命令', '可用：new check stills animatic build render review status');
  const wantsHelp = rest.includes('--help') || rest.includes('-h');

  switch (cmd) {
    case 'new': {
      const { newCommand, NEW_HELP } = await import('./commands/new.mjs');
      if (wantsHelp) { process.stdout.write(NEW_HELP + '\n'); return EXIT.OK; }
      const r = await newCommand(rest, { json });
      if (r.passthrough) { if (json) process.stdout.write(JSON.stringify(r.env) + '\n'); return r.exitCode; }
      return emit(r.env, { json, human: r.human });
    }
    case 'build':
    case 'animatic': {
      const m = await import('./commands/build.mjs');
      if (wantsHelp) { process.stdout.write((cmd === 'build' ? m.BUILD_HELP : m.ANIMATIC_HELP) + '\n'); return EXIT.OK; }
      const { opts, positionals } = parseArgs(rest, cmd === 'build' ? m.buildSpec : m.animaticSpec);
      const r = await m.buildCommand(opts, positionals, cmd);
      return emit(r.env, { json, human: r.human });
    }
    case 'stills':
    case 'render': {
      const m = await import('./commands/frames.mjs');
      if (wantsHelp) { process.stdout.write((cmd === 'stills' ? m.STILLS_HELP : m.RENDER_HELP) + '\n'); return EXIT.OK; }
      const { opts, positionals } = parseArgs(rest, cmd === 'stills' ? m.stillsSpec : m.renderSpec);
      const r = await m.framesCommand(cmd, opts, positionals);
      return emit(r.env, { json, human: r.human });
    }
    case 'review': {
      const m = await import('./commands/review.mjs');
      if (wantsHelp) { process.stdout.write(m.REVIEW_HELP + '\n'); return EXIT.OK; }
      const { opts, positionals } = parseArgs(rest, m.reviewSpec);
      const r = await m.reviewCommand(opts, positionals);
      return emit(r.env, { json, human: r.human });
    }
    case 'status': {
      const m = await import('./commands/status.mjs');
      if (wantsHelp) { process.stdout.write(m.STATUS_HELP + '\n'); return EXIT.OK; }
      const { opts, positionals } = parseArgs(rest, m.statusSpec);
      const r = await m.statusCommand(opts, positionals);
      return emit(r.env, { json, human: r.human });
    }
    case 'check': {
      const m = await import('./commands/check.mjs');
      if (wantsHelp) { process.stdout.write(m.CHECK_HELP + '\n'); return EXIT.OK; }
      const { opts, positionals } = parseArgs(rest, m.checkSpec);
      const r = await m.checkCommand(opts, positionals);
      return emit(r.env, { json, human: r.human });
    }
    default:
      throw usage(`不认识的子命令「${cmd}」`, '可用：new check stills animatic build render review status；npm run film -- --help 看说明');
  }
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
