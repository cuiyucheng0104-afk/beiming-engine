#!/usr/bin/env node
// 北冥仓库 · 开工前快速预检（给出片编排与各入口用）：只查文件、版本与可执行程序，不启动浏览器、不导入 Python 模块，
// 目标 2 秒内给出「缺什么、怎么补」，让失败发生在渲染第一帧之前。完整体检用 doctor。
//
// 库用法（P06 的 film 命令、各路线入口）：
//   import { preflight, assertPreflight } from '../env/preflight.mjs';
//   const r = await preflight(['browser', 'ffmpeg', 'python:audio']);   // → {ok, ms, checks:[…], failed:[…]}
//   await assertPreflight(['browser', 'ffmpeg', 'python:audio']);      // 不满足时抛 CliError（exitCode 3，hint = 第一条修复命令）
// 可选项：node、npm、browser、ffmpeg、python、python:audio、sh、raea、disk
//   python:audio = python + numpy / scipy / numba / soundfile / soxr 能找到（importlib.util.find_spec，不真正导入）
//
// 命令行：node tools/env/preflight.mjs --need browser,ffmpeg,python:audio [--json]
// 退出码：0 满足；3 不满足；2 用法错误。
import { EXIT, CliError, runCli, isMain, usageError } from './lib/cli.mjs';
import { run } from './lib/proc.mjs';
import { ROOT, resolvePython, pythonEnv } from './lib/python.mjs';
import * as C from './lib/checks.mjs';

export const NEEDS = ['node', 'npm', 'browser', 'ffmpeg', 'python', 'python:audio', 'sh', 'raea', 'disk'];

const HELP = `北冥仓库 · 开工前快速预检（约 1 秒，不启动浏览器、不导入 Python 模块）

用法：
  node tools/env/preflight.mjs --need <项目,…> [--json]

可选项目：${NEEDS.join('、')}
  python:audio  解释器为 Python 3.12，且 numpy / scipy / numba / soundfile / soxr 都找得到
例：node tools/env/preflight.mjs --need browser,ffmpeg,python:audio

完整体检（启动浏览器、核对锁文件、导入模块）用 npm run env:doctor。
退出码：0 满足；3 不满足（每项附修复命令）；2 用法错误。`;

async function pythonAudio(spec, env) {
  const py = await resolvePython({ env, root: ROOT, want: spec.python.version });
  if (!py.ok) return C.mk('python.interpreter', 'Python 解释器', { status: 'fail', found: py.error, fix: `npm run setup（${py.hint}）` });
  const [maj, min] = spec.python.version.split('.').map(Number);
  if (py.version[0] !== maj || py.version[1] !== min) {
    return C.mk('python.interpreter', 'Python 解释器', { status: 'fail', found: `${py.versionString}（${py.source}）`, expected: spec.python.version, fix: 'npm run setup（在仓库内建 Python 3.12 的 .venv）' });
  }
  const mods = [...new Set(spec.python.imports.map(m => m.split('.')[0]))];
  const code = `import importlib.util as u, json; print(json.dumps({m: u.find_spec(m) is not None for m in ${JSON.stringify(mods)}}))`;
  const r = await run(py.cmd, [...py.args, '-c', code], { env: pythonEnv(env, { root: ROOT }), timeout: 10_000 });
  let found = {};
  try { found = JSON.parse(r.stdout.trim()); } catch { /* 下面按缺失处理 */ }
  const miss = mods.filter(m => !found[m]);
  return C.mk('python.packages', 'Python 声音依赖', { status: miss.length ? 'fail' : 'pass', found: miss.length ? `${py.source} 缺 ${miss.join('、')}` : `${py.source}：${mods.join('、')} 齐全`,
    fix: miss.length ? 'npm run setup' : null });
}

export async function preflight(needs, { env = process.env } = {}) {
  const bad = needs.filter(n => !NEEDS.includes(n));
  if (bad.length) throw usageError(`不认识的预检项：${bad.join('、')}（可选：${NEEDS.join('、')}）`);
  const t0 = Date.now();
  const spec = C.loadSpec(ROOT);
  const jobs = [];
  for (const n of needs) {
    if (n === 'node') jobs.push(C.checkNode(spec));
    if (n === 'npm') jobs.push(C.checkNpm(ROOT), C.checkPlaywright(ROOT, spec));
    if (n === 'browser') jobs.push(C.checkHeadlessShell(ROOT, spec, env));
    if (n === 'ffmpeg') jobs.push(C.checkFfmpeg(spec, env, { full: false }).then(r => r.checks));
    if (n === 'python') jobs.push(C.checkPython(ROOT, spec, { env, imports: false }).then(r => r.checks));
    if (n === 'python:audio') jobs.push(pythonAudio(spec, env));
    if (n === 'sh') jobs.push(C.checkSh(spec, ROOT));
    if (n === 'raea') jobs.push(C.checkRaea(ROOT, spec, { env, required: true }));
    if (n === 'disk') jobs.push(C.checkDisk(ROOT, spec));
  }
  const checks = (await Promise.all(jobs)).flat();
  const failed = checks.filter(c => c.status === 'fail' && c.required);
  return { ok: failed.length === 0, ms: Date.now() - t0, checks, failed };
}

export async function assertPreflight(needs, opts) {
  const r = await preflight(needs, opts);
  if (!r.ok) {
    const e = new CliError(EXIT.ENV, 'preflight-failed', `开工前预检不通过：${r.failed.map(c => `${c.id}（${c.found}）`).join('；')}`, r.failed[0].fix);
    e.checks = r.checks;
    throw e;
  }
  return r;
}

if (isMain(import.meta.url)) {
  runCli({
    command: 'env:preflight', help: HELP,
    options: { need: { type: 'string', multiple: true } },
    run: async (o) => {
      const needs = (o.need || []).flatMap(s => s.split(',')).map(s => s.trim()).filter(Boolean);
      if (!needs.length) throw usageError('要用 --need 写明检查哪些项目', `例如 --need ${NEEDS.slice(2, 5).join(',')}`);
      const r = await preflight(needs);
      return {
        exitCode: r.ok ? EXIT.OK : EXIT.ENV,
        error: r.ok ? null : { code: 'preflight-failed', message: r.failed.map(c => `${c.id}：${c.found}`).join('；'), hint: r.failed[0].fix },
        checks: r.checks, ms: r.ms,
        human: r.checks.map(c => `${c.ok ? 'OK  ' : 'FAIL'}  ${c.id.padEnd(22)} ${c.found ?? ''}${c.ok || !c.fix ? '' : `\n      修复：${c.fix}`}`).join('\n') + `\n（${r.ms} 毫秒）`,
      };
    },
  });
}

