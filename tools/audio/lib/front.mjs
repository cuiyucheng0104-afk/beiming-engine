// 北冥仓库 · 声音命令的 Node 入口（npm run audio:* 都经这里）：参数按命令约定库 tools/lib/cli.mjs 严格解析，--help 不起 Python、
// 不读任何文件；真正的活交给 Python（engine/audio 的模块或 audio/ 下的脚本），解释器由 tools/env/py.mjs 选（三个平台同一个）。
//
//   pythonCommand({ name, summary, usage, description, examples, exitCodes, positionals, options, module | script, cwd })
//     → defineCommand 的声明。run 时把解析好的参数还原成 Python 的命令行（位置参数在前，选项按声明顺序），
//       普通模式下子进程的 stdout / stderr 直接接到终端；--json 时收下子进程 stdout 里的那一个信封，转成本命令的信封
//       （stdout 仍然只有一个 JSON 对象）。Ctrl+C / SIGTERM 时先结束子进程再退出（130 / 143）。
//   toPythonArgv(decl, opts, args) → 字符串数组（导出给测试：Node 声明与 Python 的 argparse 要一一对应）
//
// 选项名两边一样（kebab-case）。list 类型按 split 拼回一个值（Python 一侧收逗号分隔的字符串）。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, EXIT, defineCommand } from '../../lib/cli.mjs';
import { pythonEnv, resolvePython } from '../../env/py.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GLOBAL = new Set(['json', 'quiet', 'help', 'version']);

export const PY_EXIT_CODES = Object.freeze({
  0: '通过', 1: '运行失败', 2: '用法错误', 3: '环境或依赖缺失（Python 包、ffmpeg、输入文件）', 4: '验收不通过（硬项不达标）',
  130: '收到 SIGINT，已清理', 143: '收到 SIGTERM，已清理',
});

export function toPythonArgv(decl, opts, args) {
  const out = [];
  for (const p of decl.positionals) {
    const v = args[p.name];
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) out.push(...v.map(String)); else out.push(String(v));
  }
  for (const o of Object.values(decl.options)) {
    if (GLOBAL.has(o.name)) continue;
    const v = opts[o.name];
    if (o.type === 'boolean') { if (v) out.push(`--${o.name}`); continue; }
    if (o.type === 'list') { if (v?.length) out.push(`--${o.name}`, v.join(o.split ?? ',')); continue; }
    if (v === null || v === undefined) continue;
    out.push(`--${o.name}`, String(v));
  }
  return out;
}

function parseEnvelope(text) {
  const s = (text || '').trim();
  if (!s) return null;
  try {
    const e = JSON.parse(s);
    return e && typeof e === 'object' && !Array.isArray(e) && Number.isInteger(e.exitCode) ? e : null;
  } catch { return null; }
}

export function pythonCommand({ module, script, cwd = ROOT, ...spec }) {
  if (!module === !script) throw new Error('pythonCommand 要且只要 module 或 script 之一');
  let decl = null;
  decl = defineCommand({
    exitCodes: PY_EXIT_CODES,
    ...spec,
    async run(ctx) {
      const py = await resolvePython({ env: ctx.env });
      if (!py.ok) throw new CliError('env.python', py.error, { hint: py.hint });
      const target = module ? ['-m', module] : [path.join(ROOT, ...script.split('/'))];
      const argv = [...py.args, ...target, ...toPythonArgv(decl, ctx.opts, ctx.args)];
      if (ctx.json) argv.push('--json');
      if (ctx.quiet) argv.push('--quiet');
      const child = spawn(py.cmd, argv, { cwd, env: pythonEnv(ctx.env), stdio: ['ignore', ctx.json ? 'pipe' : 'inherit', 'inherit'], windowsHide: true });
      const closed = new Promise((resolve, reject) => {
        child.on('error', e => reject(new CliError('env.python', `起不来 Python（${py.cmd}）：${e.message}`, { hint: 'node tools/env/py.mjs --which 看选中的解释器' })));
        child.on('close', (c, sig) => resolve(c ?? (sig === 'SIGINT' ? EXIT.SIGINT : sig === 'SIGTERM' ? EXIT.SIGTERM : EXIT.FAILURE)));
      });
      const undo = ctx.onCleanup(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill('SIGTERM'); } catch { /* 已经退出 */ }
          await closed.catch(() => {});
        }
      });
      let stdout = '';
      if (ctx.json) { child.stdout.setEncoding('utf8'); child.stdout.on('data', d => { stdout += d; }); }
      let code;
      try { code = await closed; } finally { undo(); }
      if (!ctx.json) return { exitCode: code };
      const env = parseEnvelope(stdout);
      if (!env) {
        return { exitCode: code || EXIT.FAILURE, error: { code: 'failure.python-output', message: `Python 一侧没有输出可解析的 --json 信封（退出码 ${code}）`, hint: '去掉 --json 重跑，看原始输出' } };
      }
      return { exitCode: env.exitCode, error: env.error, data: env.data ?? null, outputs: env.outputs ?? [], warnings: env.warnings ?? [], runJson: env.runJson ?? null };
    },
  });
  return decl;
}
