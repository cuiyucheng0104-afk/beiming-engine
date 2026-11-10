#!/usr/bin/env node
// 北冥仓库 · 出片编排命令（npm run film -- <子命令>）：一条 Node 命令依据作品描述 film.json 出片，三条路线、三个平台同一套参数。
//   node tools/film/cli.mjs <new|check|stills|animatic|build|mix|assemble|render|qa|review|approve|status> … [--json] [--help]
// 参数解析、--help、--json 信封与退出码都用命令约定库 tools/lib/cli.mjs（P02，docs/CLI.md）：
//   退出码 C1：0 成功 · 1 运行失败 · 2 用法错误 · 3 缺环境 · 4 契约 / 验收 / 闸门不通过 · 5 资源忙 · 124 超时 · 130/143 中断
//   --json C2：stdout 只输出一个对象 { schemaVersion, ok, exitCode, command, error, outputs[], runJson, warnings[], data }；过程日志一律走 stderr
//   --help：打印到 stdout、退出码 0、没有任何副作用（不建目录、不启动浏览器或子进程）
//   运行目录 C4：films/<名>/out/<run-id>/ + latest 指针；run.json C8：每次运行都写（失败、被中断也写）
// 中断（SIGINT / SIGTERM / SIGHUP）由 lib/session.mjs 处理：结束子进程树、还原旧位置、写好 run.json、放锁，再输出同一格式的信封。
// 详细说明与对其它工作包的接口：tools/film/README.md。
import { CliError, EXIT, defineCommand, isMain, runCli } from '../lib/cli.mjs';
import { FilmError, asFilmError } from './lib/exit.mjs';
import { camel } from './lib/args.mjs';
import { installSignals } from './lib/session.mjs';

const EXIT_CODES = {
  0: '成功', 1: '运行失败', 2: '用法错误', 3: '缺环境（ffmpeg、Python 包、浏览器、RAEA_BIN、软件渲染）',
  4: '契约 / QA / 闸门不通过', 5: '作品正被另一次运行占用', 124: '超时', 130: '收到 SIGINT，已清理', 143: '收到 SIGTERM，已清理',
};

// 子命令表：模块按需加载（--help 只读模块里的声明，不加载渲染相关的库也不起子进程）
export const SUBCOMMANDS = {
  new: { mod: './commands/new.mjs', spec: 'newSpec', doc: 'NEW_DOC', run: (m, o, p) => m.newCommand(o, p) },
  check: { mod: './commands/check.mjs', spec: 'checkSpec', doc: 'CHECK_DOC', run: (m, o, p) => m.checkCommand(o, p) },
  stills: { mod: './commands/frames.mjs', spec: 'stillsSpec', doc: 'STILLS_DOC', run: (m, o, p) => m.framesCommand('stills', o, p) },
  animatic: { mod: './commands/build.mjs', spec: 'animaticSpec', doc: 'ANIMATIC_DOC', run: (m, o, p) => m.buildCommand(o, p, 'animatic') },
  build: { mod: './commands/build.mjs', spec: 'buildSpec', doc: 'BUILD_DOC', run: (m, o, p) => m.buildCommand(o, p, 'build') },
  mix: { mod: './commands/build.mjs', spec: 'mixSpec', doc: 'MIX_DOC', run: (m, o, p) => m.mixCommand(o, p) },
  assemble: { mod: './commands/build.mjs', spec: 'assembleSpec', doc: 'ASSEMBLE_DOC', run: (m, o, p) => m.assembleCommand(o, p) },
  render: { mod: './commands/frames.mjs', spec: 'renderSpec', doc: 'RENDER_DOC', run: (m, o, p) => m.renderEntry(o, p) },
  qa: { mod: './commands/qa.mjs', spec: 'qaSpec', doc: 'QA_DOC', run: (m, o, p) => m.qaCommand(o, p) },
  review: { mod: './commands/review.mjs', spec: 'reviewSpec', doc: 'REVIEW_DOC', run: (m, o, p) => m.reviewCommand(o, p) },
  status: { mod: './commands/status.mjs', spec: 'statusSpec', doc: 'STATUS_DOC', run: (m, o, p) => m.statusCommand(o, p) },
};
const ALIASES = { approve: ['review', 'approve'] };

const TOP_DESCRIPTION = [
  '做一部片的顺序（三道闸 look → animatic → final，决定 D08；每道闸都要用户看过、按原话记录，agent 不得自己批准）：',
  '  new <a|b|c> <名字> [--title 标题]       新建作品（转调 tools/new-film.mjs）',
  '  check <作品目录>                         只读检查：作品描述（P05）、页面契约 / 原生预检、档位与镜头表',
  '  stills <作品目录>                        风格关键帧 + 联系表                  → review approve look',
  '  animatic <作品目录>                      低清动态预演 + 联系表 + 播放页        → review approve animatic',
  '  build <作品目录> [--final]               整条出片链 → out/<run-id>/           → review approve final（之后才能称「已交付」）',
  '  mix <作品目录>                           只做声音（A / C 到声画拍点核对；B 原生素材准备）',
  '  assemble <作品目录>                      画面与声音复用缓存，只重做封装及之后',
  '  render <作品目录> --frames a:b|--shot S  只渲指定帧段或镜头（帧级复用）；--final 先查闸门',
  '  qa <作品目录> [--run <run-id>]           对已出的片子补跑机器 QA 门（tools/qa），回写 run.json',
  '  review approve|reject|waive|note|status  闸门审阅记录；approve … 是 review approve … 的简写',
  '  status <作品目录>                        闸门、最近运行与下一步',
  '',
  '产物只写进 <作品>/out/<run-id>/（master.mp4 web.mp4 player.html contact.jpg poster.jpg run.json qa/report.json），',
  '最近一次跑完的出片记在 out/latest（指针文件）。每个子命令都有 --help；--json 时 stdout 只有一个 JSON 对象。',
  '《北冥》10 秒样片：npm run beiming:build（= node tools/film/beiming.mjs；sh build.sh 是同一件事的兼容壳）。',
  '说明：tools/film/README.md；命令约定：docs/CLI.md。',
];

export const topCommand = defineCommand({
  name: 'film',
  summary: '北冥出片编排：依据作品描述 film.json 出片（三条路线、三个平台同一套参数与退出码）',
  usage: ['npm run film -- <子命令> [参数]', 'node tools/film/cli.mjs <子命令> [参数]'],
  description: TOP_DESCRIPTION,
  positionals: [
    { name: 'subcommand', label: '<子命令>', describe: `${Object.keys(SUBCOMMANDS).join(' / ')} / approve`, required: true },
    { name: 'rest', label: '[参数…]', describe: '子命令自己的参数（见 <子命令> --help）', variadic: true, required: false },
  ],
  examples: [
    'npm run film -- new c my-film --title 晨渡',
    'npm run film -- build films/my-film',
    'npm run film -- build films/my-film --final',
    'npm run film -- build --help',
  ],
  exitCodes: EXIT_CODES,
  run(ctx) {
    const sub = ctx.args.subcommand;
    if (SUBCOMMANDS[sub] || ALIASES[sub]) {
      throw new CliError('usage.options-before-subcommand', `选项要写在子命令之后：npm run film -- ${sub} … ${process.argv.slice(2).filter(a => a.startsWith('-')).join(' ')}`.trim(), { hint: `例：npm run film -- ${sub} films/<名字> --json` });
    }
    const near = Object.keys(SUBCOMMANDS).find(k => k.startsWith(String(sub).slice(0, 3)));
    throw new CliError('usage.unknown-subcommand', `不认识的子命令「${sub}」`, { hint: `${near ? `是不是想写 ${near}？` : ''}可用：${[...Object.keys(SUBCOMMANDS), 'approve'].join(' ')}；npm run film -- --help 看说明` });
  },
});

// 旧格式的参数表（{ '--no-cache': { type: 'bool', help } }）→ 命令约定库的声明（{ 'no-cache': { type: 'boolean', describe } }）
export function toOptions(spec) {
  const out = {};
  for (const [flag, d] of Object.entries(spec.options || {})) {
    const name = flag.replace(/^--/, '');
    if (['json', 'help', 'quiet', 'version'].includes(name)) continue;
    const base = { describe: d.help || '', ...(d.arg ? { arg: d.arg } : {}) };
    if (d.type === 'bool') out[name] = { type: 'boolean', describe: base.describe };
    else if (d.type === 'int') out[name] = { ...base, type: 'integer', ...(d.min !== undefined ? { min: d.min } : {}), ...(d.max !== undefined ? { max: d.max } : {}) };
    else if (d.type === 'number') out[name] = { ...base, type: 'number', ...(d.min !== undefined ? { min: d.min } : {}) };
    else if (d.type === 'enum') out[name] = { ...base, type: 'string', choices: d.values };
    else if (d.type === 'list') out[name] = { ...base, type: 'list', split: ',', ...(d.values ? { choices: d.values } : {}) };
    else out[name] = { ...base, type: 'string' };
  }
  return out;
}

const toPositionals = spec => (spec.positionals || []).map((p, i) => ({
  name: p.key || `p${i}`, label: p.label || `<${p.name}>`, describe: p.describe || p.name, required: !!p.required,
}));

/** 一个子命令 → 命令约定库的声明。m 是已加载的子命令模块。 */
export function subcommand(name, m, t = SUBCOMMANDS[name]) {
  const spec = m[t.spec], doc = m[t.doc] || {};
  const positionals = toPositionals(spec);
  return defineCommand({
    name: `film ${name}`,
    summary: doc.summary || name,
    usage: doc.usage,
    description: doc.description,
    examples: doc.examples,
    exitCodes: doc.exitCodes || EXIT_CODES,
    positionals,
    options: toOptions(spec),
    async run(ctx) {
      const opts = { json: ctx.json };
      for (const [k, v] of Object.entries(ctx.opts)) if (!['json', 'quiet', 'help', 'version'].includes(k)) opts[camel(k)] = v;
      for (const [k, v] of Object.entries(opts)) if (v === null || (Array.isArray(v) && !v.length)) delete opts[k];
      const pos = positionals.map(p => ctx.args[p.name]);
      while (pos.length && (pos.at(-1) === null || pos.at(-1) === undefined)) pos.pop();
      let r;
      try { r = await t.run(m, opts, pos); } catch (e) {
        const fe = asFilmError(e);
        if (fe.short === 'internal' && fe.details?.stack && (process.env.BEIMING_DEBUG || process.env.FILM_DEBUG)) process.stderr.write(`${fe.details.stack}\n`);
        return { exitCode: fe.exitCode, error: fe, outputs: e?.outputs || [], runJson: e?.runJson || null, warnings: e?.warnings || [], data: e?.data ?? null };
      }
      if (r.human) ctx.out(r.human);
      const env = r.env || {};
      return { exitCode: env.exitCode ?? 0, error: env.error || null, outputs: env.outputs || [], runJson: env.runJson || null, warnings: env.warnings || [], data: env.data ?? null };
    },
  });
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const [first, ...rest] = argv;
  const alias = ALIASES[first];
  const name = alias ? alias[0] : first;
  const t = SUBCOMMANDS[name];
  if (!t) return runCli(topCommand, argv, { signals: false, ...io });
  const m = await import(t.mod);
  const cmd = subcommand(name, m, t);
  return runCli(cmd, alias ? [...alias.slice(1), ...rest] : rest, { signals: false, ...io });
}

if (isMain(import.meta.url)) {
  installSignals();
  const code = await main();
  // 正常情况下事件循环自然结束；万一有句柄没关（例如第三方库的定时器），2 秒后按同一退出码结束，不让调用方挂住
  setTimeout(() => process.exit(code), 2000).unref();
}

export { FilmError, EXIT };
