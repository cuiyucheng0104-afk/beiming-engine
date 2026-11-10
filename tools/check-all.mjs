#!/usr/bin/env node
// 北冥仓库 · 检查总入口（npm run check）：规范检查、工程计划、测试、风格索引、案例库、导演规范、语法、更新日志，外加只报告不阻塞的 lint。
// 只读：不改仓库里的任何文件（各子检查本身也都是只读的）。
//   node tools/check-all.mjs                    全部步骤
//   node tools/check-all.mjs --skip tests       除测试外全部（CI 的 check job；测试由 unit job 跑）
//   node tools/check-all.mjs --only lint        只看 lint 告警数量（npm run lint）
//   node tools/check-all.mjs --list             列出步骤与对应命令，不执行
//   node tools/check-all.mjs --json             stdout 只输出一个 JSON 对象（附录 C2 信封 + steps）
//
// 步骤（id → 做什么；「阻塞」= 失败时整体非零退出）：
//   repo       仓库规范       node tools/repo-check.mjs                         阻塞
//   plan       工程计划       node tools/work-plan.mjs --check                  阻塞
//   tests      测试           node tools/run-tests.mjs --json                   阻塞
//   styles     风格索引       node tools/c-styles.mjs --check                   阻塞
//   cases      案例库         <python> tools/casebook.py check                  阻塞
//   directing  导演规范       <python> tools/check_directing_docs.py routes/directing（工具不在时跳过）
//   syntax     语法           node --check 全部 .js/.mjs/.cjs，Python 全部 .py 做 ast 解析，全部 .json 解析，sh -n 全部 .sh（cases/ 除外）
//   changelog  更新日志       node tests/ci/changelog.mjs check（Keep a Changelog 结构）
//   eslint     JS lint        只报告：eslint（devDependencies 里有才跑），列出错误 / 警告数量与最多的规则
//   ruff       Python lint    只报告：ruff check（ruff.toml），列出数量与最多的规则
// 分组别名：lint = eslint + ruff。
//
// 退出码（附录 C1）：0 全部阻塞步骤通过；有阻塞步骤未通过时按 3（环境缺失）> 124（超时）> 5（资源忙）> 4（契约）> 1（失败）取最重的一个；
//   2 用法错误；130 / 143 被中断（已清理子进程）。lint 的结果只进报告和 warnings，不影响退出码。
// 在 GitHub Actions 里每一步的输出折叠成一组，失败步骤写错误注解，汇总表写进 $GITHUB_STEP_SUMMARY。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import {
  ROOT, EXIT, CliError, parseArgs, envelope, writeReport, isMain, run, onSignals, resolvePython, pythonEnv,
  inActions, annotate, stepSummary, mdCell, table, fmtSec, probeCapability,
} from './run-tests.mjs';

const HERE = ROOT;   // 本仓库（check-all 自己的工具：run-tests、changelog、语法检查）
const STEP_IDS = ['repo', 'plan', 'tests', 'styles', 'cases', 'directing', 'syntax', 'changelog', 'eslint', 'ruff'];
const GROUPS = { lint: ['eslint', 'ruff'] };

// 每一步：title、blocking、tool（必须存在的文件，相对 --root）、build(ctx) → { cmd, args, parse? } 或 inline(ctx)
const STEPS = {
  repo: { title: '仓库规范', blocking: true, tool: 'tools/repo-check.mjs', build: c => ({ cmd: process.execPath, args: [c.at('tools/repo-check.mjs')] }) },
  plan: { title: '工程计划', blocking: true, tool: 'tools/work-plan.mjs', build: c => ({ cmd: process.execPath, args: [c.at('tools/work-plan.mjs'), '--check'] }) },
  tests: {
    title: '测试', blocking: true, timeoutSec: 900,
    build: c => ({ cmd: process.execPath, args: [path.join(HERE, 'tools/run-tests.mjs'), '--root', c.root, '--json', ...(c.opts.python ? ['--python', c.opts.python] : [])], json: true }),
    details: j => j && { summary: j.summary, suites: (j.suites || []).map(s => ({ id: s.id, status: s.status, counts: s.counts, skipReason: s.skipReason })) },
  },
  styles: { title: '风格索引', blocking: true, tool: 'tools/c-styles.mjs', build: c => ({ cmd: process.execPath, args: [c.at('tools/c-styles.mjs'), '--check'] }) },
  cases: { title: '案例库', blocking: true, tool: 'tools/casebook.py', python: true, build: c => ({ cmd: c.py.cmd, args: [...c.py.pre, c.at('tools/casebook.py'), 'check'], env: pythonEnv() }) },
  directing: {
    title: '导演规范', blocking: true, tool: 'tools/check_directing_docs.py', optional: true, python: true,
    build: c => ({ cmd: c.py.cmd, args: [...c.py.pre, c.at('tools/check_directing_docs.py'), c.at('routes/directing')], env: pythonEnv() }),
  },
  syntax: { title: '语法', blocking: true, inline: syntaxCheck },
  changelog: {
    title: '更新日志', blocking: true,
    build: c => ({ cmd: process.execPath, args: [path.join(HERE, 'tests/ci/changelog.mjs'), 'check', '--file', c.at('CHANGELOG.md'), '--json'], json: true }),
    details: j => j && { versions: j.versions, unreleasedEntries: j.unreleasedEntries },
  },
  eslint: { title: 'JS lint（只报告）', blocking: false, inline: eslintReport },
  ruff: { title: 'Python lint（只报告）', blocking: false, inline: ruffReport },
};

const SPEC = {
  only: { type: 'list' }, skip: { type: 'list' }, list: { type: 'bool' }, json: { type: 'bool' }, report: { type: 'string' },
  timeout: { type: 'int' }, 'fail-fast': { type: 'bool' }, python: { type: 'string' }, root: { type: 'string' }, help: { type: 'bool', short: 'h' },
};

export const HELP = `北冥仓库 · 检查总入口（npm run check）

用法：node tools/check-all.mjs [参数]
      npm run check -- [参数]

  --only <步骤,…>   只跑这些步骤（可重复；lint = eslint + ruff）
  --skip <步骤,…>   不跑这些步骤
  --list            列出步骤、命令与是否阻塞，不执行
  --fail-fast       第一个阻塞步骤失败就停，剩下的标为未运行
  --timeout <秒>    每一步的时限（默认 300；tests 默认 900）
  --python <解释器> 案例库、导演规范与测试里的 Python（默认依次找 BEIMING_PY、PYTHON、tools/env/py.mjs、.venv、python3…）
  --root <目录>     检查另一个检出（给 tests/ci 的夹具用）
  --json            stdout 只输出一个 JSON 对象（附录 C2 信封 + steps）；各步输出在 stderr
  --report <文件>   另把同一个 JSON 写进文件
  -h, --help        显示本说明（不做任何其他事）

步骤：${STEP_IDS.map(id => `${id}（${STEPS[id].title}${STEPS[id].blocking ? '' : '，不阻塞'}）`).join('、')}

退出码：0 阻塞步骤全部通过；1 失败；2 用法错误；3 环境缺失；4 契约不通过；124 超时；130/143 被中断。lint 只报告，不影响退出码。`;

const STATUS = { pass: '通过', fail: '失败', warn: '有告警', skip: '跳过', error: '出错', timeout: '超时', 'not-run': '未运行' };

export async function main(argv = process.argv.slice(2)) {
  let opts;
  const warnings = [];
  const finish = (exitCode, extra = {}, error = null) => {
    const env = envelope({ exitCode, command: 'check', error, warnings, ...extra });
    if (opts?.json) process.stdout.write(JSON.stringify(env, null, 2) + '\n');
    writeReport(opts?.report, env);
    return exitCode;
  };
  try { opts = parseArgs(argv, SPEC); } catch (e) {
    opts = { json: argv.includes('--json') };
    process.stderr.write(`${e.message}\n${e.hint}\n`);
    return finish(e.exitCode, {}, e);
  }
  if (opts.help) { process.stdout.write(HELP + '\n'); return EXIT.OK; }

  const expand = names => names.flatMap(n => GROUPS[n] || [n]);
  const only = expand(opts.only), skip = expand(opts.skip);
  const unknown = [...only, ...skip].filter(n => !STEP_IDS.includes(n));
  if (unknown.length) {
    const e = new CliError(EXIT.USAGE, 'usage.bad-value', `不认识的步骤：${[...new Set(unknown)].join('、')}`, `可用：${STEP_IDS.join('、')}、lint`);
    process.stderr.write(`${e.message}\n${e.hint}\n`);
    return finish(e.exitCode, {}, e);
  }
  if (opts.root && !fs.existsSync(path.resolve(opts.root))) {
    const e = new CliError(EXIT.USAGE, 'usage.bad-value', `--root 指向的目录不存在：${opts.root}`);
    process.stderr.write(e.message + '\n');
    return finish(e.exitCode, {}, e);
  }
  const root = opts.root ? fs.realpathSync(path.resolve(opts.root)) : ROOT;
  const ids = STEP_IDS.filter(id => (!only.length || only.includes(id)) && !skip.includes(id));
  let pyMemo;
  const ctx = {
    root, opts, warnings,
    at: rel => path.join(root, ...rel.split('/')),
    get py() { return pyMemo === undefined ? (pyMemo = resolvePython(root, opts.python)) : pyMemo; },
  };

  if (opts.list) {
    const listCtx = { root, opts, at: ctx.at, py: { cmd: '<python>', pre: [] } };   // 只列命令，不探测解释器
    const rows = ids.map(id => {
      const s = STEPS[id];
      const cmd = s.inline ? '（内置）' : (() => { try { const b = s.build(listCtx); return [b.cmd === process.execPath ? 'node' : b.cmd, ...b.args.map(a => path.isAbsolute(a) ? path.relative(root, a).split(path.sep).join('/') || '.' : a)].join(' '); } catch { return '?'; } })();
      return [id, s.title, s.blocking ? '阻塞' : '只报告', cmd];
    });
    const o = opts.json ? process.stderr : process.stdout;
    o.write(table(['步骤', '名称', '性质', '命令'], rows) + '\n');
    return finish(EXIT.OK, { steps: ids.map(id => ({ id, title: STEPS[id].title, blocking: STEPS[id].blocking, status: 'listed' })) });
  }

  const steps = ids.map(id => ({ id, title: STEPS[id].title, blocking: STEPS[id].blocking, status: 'not-run', exitCode: null, durationMs: 0, reason: null, details: null, logTail: [] }));
  let interrupted = false;
  onSignals(code => {
    interrupted = true;
    const e = new CliError(code, 'INTERRUPTED', `收到 ${code === EXIT.SIGINT ? 'SIGINT' : 'SIGTERM'}，已结束全部检查进程`);
    process.stderr.write(`\n${e.message}\n`);
    finish(code, { steps }, e);
  });

  let stop = false;
  for (const st of steps) {
    if (stop) break;
    const def = STEPS[st.id];
    const t0 = Date.now();
    process.stderr.write(`\n▶ ${st.id} · ${st.title}\n`);
    if (inActions()) process.stdout.write(`::group::${st.id} · ${st.title}\n`);
    try {
      await runStep(st, def, ctx);
    } catch (e) {
      st.status = 'error'; st.exitCode = e.exitCode ?? EXIT.FAIL; st.reason = e.message;
    }
    st.durationMs = Date.now() - t0;
    if (inActions()) process.stdout.write('::endgroup::\n');
    if (interrupted) return EXIT.SIGINT;
    if (!st.blocking && st.status !== 'pass' && st.status !== 'skip') warnings.push(`${st.id}（不阻塞）：${st.reason || STATUS[st.status]}`);
    if (st.blocking && ['fail', 'error', 'timeout'].includes(st.status) && opts['fail-fast']) stop = true;
    if (st.status === 'skip' && st.reason) warnings.push(`${st.id} 已跳过：${st.reason}`);
  }

  const bad = steps.filter(s => s.blocking && ['fail', 'error', 'timeout'].includes(s.status));
  const codes = bad.map(s => (s.status === 'timeout' ? EXIT.TIMEOUT : s.exitCode));
  const exitCode = !bad.length ? EXIT.OK : [EXIT.ENV, EXIT.TIMEOUT, EXIT.BUSY, EXIT.CONTRACT].find(c => codes.includes(c)) ?? EXIT.FAIL;
  const error = bad.length ? new CliError(exitCode, 'CHECKS_FAILED', `${bad.map(s => `${s.id}（${s.title}）`).join('、')} 未通过`,
    `单独重跑某一步：node tools/check-all.mjs --only ${bad[0].id}`) : null;
  printHuman(steps, opts);
  reportActions(steps);
  return finish(exitCode, { steps }, error);
}

// ───────────────────────── 单步执行 ─────────────────────────

async function runStep(st, def, ctx) {
  if (def.tool && !fs.existsSync(ctx.at(def.tool))) {
    if (def.optional) { st.status = 'skip'; st.reason = `${def.tool} 不存在`; return; }
    throw new CliError(EXIT.ENV, 'TOOL_MISSING', `缺少 ${def.tool}（这一步是必需的）`);
  }
  if (def.python && !ctx.py) throw new CliError(EXIT.ENV, 'PYTHON_MISSING', `找不到 Python 解释器（试过：${(resolvePython.tried || []).join('、')}）；用 --python 或 BEIMING_PY 指定`);
  if (def.inline) { await def.inline(st, ctx); return; }
  const b = def.build(ctx);
  st.command = [b.cmd === process.execPath ? 'node' : b.cmd, ...b.args].join(' ');
  const timeoutMs = 1000 * (ctx.opts.timeout || def.timeoutSec || 300);
  const r = await run(b.cmd, b.args, { cwd: ctx.root, env: b.env || process.env, timeoutMs, stdout: b.json ? 'capture' : 'pipe', stderr: 'pipe' });
  st.exitCode = r.code;
  st.logTail = tail(r.stdout + r.stderr, b.json ? 15 : 40);
  if (b.json) {
    let j = null;
    try { j = JSON.parse(r.stdout); } catch { /* 不是 JSON：按退出码判 */ }
    st.details = def.details ? def.details(j) : j;
    if (j?.error && r.code !== 0) st.reason = j.error.message;
  }
  if (r.error) { st.status = 'error'; st.exitCode = EXIT.ENV; st.reason = `启动失败：${r.error.message}`; }
  else if (r.timedOut) { st.status = 'timeout'; st.exitCode = EXIT.TIMEOUT; st.reason = `超过 ${timeoutMs / 1000} 秒，已结束整棵进程树`; }
  else if (r.code === 0) { st.status = 'pass'; st.reason = st.reason || shorten(st.logTail[st.logTail.length - 1] || ''); }
  else {
    st.status = 'fail';
    if (r.code === EXIT.USAGE) { st.exitCode = EXIT.FAIL; st.reason = st.reason || '子命令报用法错误：check-all 与该工具的参数约定不一致，需要修 check-all'; }
    else if (r.code === null) { st.exitCode = EXIT.FAIL; st.reason = st.reason || `被信号 ${r.signal} 结束`; }
    st.reason = st.reason || lastMeaningful(st.logTail) || `退出码 ${r.code}`;
  }
}

const tail = (text, n) => text.split(/\r?\n/).filter(l => l.trim()).slice(-n);
const shorten = (l, n = 90) => { const t = l.trim().replace(/^[✓✔·!]\s*/, ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const lastMeaningful = lines => [...lines].reverse().find(l => /[✗✖]|错误|error|Error|fail|FAIL|问题/.test(l)) || lines[lines.length - 1];

// ───────────────────────── 语法检查（内置） ─────────────────────────

function listFiles(root) {
  const g = spawnSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  let files;
  if (g.status === 0) files = g.stdout.split('\0').filter(Boolean);
  else {
    files = [];
    const skip = new Set(['.git', 'node_modules', 'out', '__pycache__', '.venv']);
    const walk = d => {
      for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
        if (skip.has(e.name)) continue;
        const r = d ? `${d}/${e.name}` : e.name;
        if (e.isDirectory()) walk(r); else if (e.isFile()) files.push(r);
      }
    };
    walk('');
  }
  // cases/ 是第三方快照与历史归档（只读、按字节校验）；films/<名>/out 与 out/ 是产物；fixtures/ 是测试夹具（里面可能有故意写坏的文件）
  return files.filter(f => !f.startsWith('cases/') && !/(^|\/)(node_modules|fixtures|__fixtures__)\//.test(f) && !/^films\/[^/]+\/out\//.test(f)
    && !f.startsWith('out/') && fs.existsSync(path.join(root, f)));
}

async function pool(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); }
  }));
  return results;
}

// JS 语法：一个子进程里用 V8 编译全部文件（不执行）。按 Node 的规则定模块类型：.mjs 是 ESM，.cjs 是 CommonJS，
// .js 看最近的 package.json 的 type。没有 type 时 Node 会「先按 CommonJS、失败再按 ESM」自动判断，而这种情况下
// `node --check` 遇到 ESM 写法的语法错误会直接返回 0（Node 24 实测），所以不用它判定，只在需要行号时借用。
const JS_SYNTAX = String.raw`
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
const root = process.env.BEIMING_SYNTAX_ROOT;
const types = new Map();
function pkgType(dir) {
  if (types.has(dir)) return types.get(dir);
  let t = null;
  try { t = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).type || 'auto'; } catch {
    const up = path.dirname(dir);
    t = dir === root || up === dir ? 'auto' : pkgType(up);
  }
  types.set(dir, t);
  return t;
}
const out = [];
for (const rel of JSON.parse(process.env.BEIMING_SYNTAX_FILES)) {
  const abs = path.join(root, rel), ext = path.extname(rel).toLowerCase();
  let src;
  try { src = fs.readFileSync(abs, 'utf8'); } catch (e) { out.push({ file: rel, line: 0, message: e.message, mode: null }); continue; }
  const type = ext === '.mjs' ? 'module' : ext === '.cjs' ? 'commonjs' : pkgType(path.dirname(abs));
  const cjs = () => vm.compileFunction(src, ['exports', 'require', 'module', '__filename', '__dirname'], { filename: abs });
  const esm = () => new vm.SourceTextModule(src, { identifier: abs });
  let err = null, mode = type;
  try {
    if (type === 'module') esm();
    else if (type === 'commonjs') cjs();
    else {
      try { cjs(); mode = 'commonjs'; } catch (e1) {
        try { esm(); mode = 'module'; } catch (e2) { const looksEsm = /^\s*(import|export)\b/m.test(src); err = looksEsm ? e2 : e1; mode = looksEsm ? 'module' : 'commonjs'; }
      }
    }
  } catch (e) { err = e; }
  if (err) {
    const m = /:(\d+)\s*$/.exec(String(err.stack || '').split(/\r?\n/)[0]);
    out.push({ file: rel, line: m ? +m[1] : 0, message: err.name + ': ' + err.message, mode });
  }
}
process.stdout.write(JSON.stringify(out));
`;

const PY_SYNTAX = String.raw`
import ast, json, os, sys, warnings
warnings.simplefilter('ignore')
bad = []
for f in json.loads(os.environ['BEIMING_SYNTAX_FILES']):
    try:
        with open(f, 'rb') as fh:
            ast.parse(fh.read(), filename=f)
    except SyntaxError as e:
        bad.append({'file': f, 'line': e.lineno or 0, 'message': e.msg})
    except Exception as e:
        bad.append({'file': f, 'line': 0, 'message': str(e)})
sys.stdout.write(json.dumps(bad, ensure_ascii=False))
`;

async function syntaxCheck(st, ctx) {
  const files = listFiles(ctx.root);
  const by = ext => files.filter(f => ext.includes(path.extname(f).toLowerCase()));
  const js = by(['.js', '.mjs', '.cjs']), py = by(['.py']), json = by(['.json']), sh = by(['.sh']);
  const bad = [];
  const n = Math.max(2, (os.availableParallelism?.() || os.cpus().length || 2));
  if (js.length) {
    const r = await run(process.execPath, ['--experimental-vm-modules', '--no-warnings', '--input-type=module', '-e', JS_SYNTAX], {
      cwd: ctx.root, env: { ...process.env, BEIMING_SYNTAX_ROOT: ctx.root, BEIMING_SYNTAX_FILES: JSON.stringify(js) }, stdout: 'capture', stderr: 'capture', timeoutMs: 120000,
    });
    let found;
    try { found = JSON.parse(r.stdout); } catch { found = [{ file: '(js)', line: 0, message: `JS 语法检查没能运行（退出码 ${r.code}）：${tail(r.stderr, 3).join(' ')}` }]; }
    // ESM 的编译错误不带位置：拷成临时 .mjs 交给 node --check 取行号（.mjs 不受模块类型自动判断的影响）
    await pool(found.filter(b => !b.line && b.mode === 'module'), n, async b => {
      const tmp = path.join(os.tmpdir(), `bm-syntax-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
      try {
        fs.copyFileSync(path.join(ctx.root, b.file), tmp);
        const c = await run(process.execPath, ['--check', tmp], { cwd: ctx.root, stdout: 'capture', stderr: 'capture', timeoutMs: 60000 });
        const m = /:(\d+)\s*$/.exec(c.stderr.split(/\r?\n/).find(l => l.startsWith(tmp)) || '');
        if (m) b.line = +m[1];
      } finally { fs.rmSync(tmp, { force: true }); }
    });
    bad.push(...found.map(({ file, line, message }) => ({ file, line, message })));
  }
  for (const f of json) {
    try { JSON.parse(fs.readFileSync(path.join(ctx.root, f), 'utf8').replace(/^\uFEFF/, '')); } catch (e) { bad.push({ file: f, line: 0, message: e.message }); }
  }
  let pyNote = '';
  if (py.length) {
    if (!ctx.py) throw new CliError(EXIT.ENV, 'PYTHON_MISSING', `有 ${py.length} 个 .py 要检查，但找不到 Python 解释器；用 --python 或 BEIMING_PY 指定`);
    const r = await run(ctx.py.cmd, [...ctx.py.pre, '-c', PY_SYNTAX], { cwd: ctx.root, env: pythonEnv({ BEIMING_SYNTAX_FILES: JSON.stringify(py) }), stdout: 'capture', stderr: 'capture', timeoutMs: 120000 });
    try { bad.push(...JSON.parse(r.stdout)); } catch { bad.push({ file: '(python)', line: 0, message: `Python 语法检查没能运行：${tail(r.stderr, 3).join(' ')}` }); }
    pyNote = `Python ${ctx.py.version}`;
  }
  let shNote = '';
  if (sh.length) {
    if (probeCapability('sh', ctx).ok) {
      await pool(sh, n, async f => {
        const r = await run('sh', ['-n', f], { cwd: ctx.root, stdout: 'capture', stderr: 'capture', timeoutMs: 30000 });
        if (r.code !== 0) bad.push({ file: f, line: +((/line (\d+)/.exec(r.stderr) || [])[1] || 0), message: tail(r.stderr, 1)[0] || `sh -n 退出码 ${r.code}` });
      });
    } else shNote = `没有 POSIX sh，${sh.length} 个 .sh 未检查`;
  }
  st.details = { js: js.length, json: json.length, py: py.length, sh: shNote ? 0 : sh.length, failures: bad };
  const counts = `${js.length} 个 JS、${json.length} 个 JSON、${py.length} 个 Python${pyNote ? `（${pyNote}）` : ''}、${shNote ? 0 : sh.length} 个 sh`;
  for (const b of bad) process.stderr.write(`  ✗ ${b.file}${b.line ? `:${b.line}` : ''}  ${b.message}\n`);
  if (shNote) { ctx.warnings.push(`syntax：${shNote}`); process.stderr.write(`  ! ${shNote}\n`); }
  st.exitCode = bad.length ? EXIT.FAIL : EXIT.OK;
  st.status = bad.length ? 'fail' : 'pass';
  st.reason = bad.length ? `${bad.length} 个文件有语法错误（共检查 ${counts}）` : `检查了 ${counts}`;
  process.stderr.write(`  ${bad.length ? '✗' : '✓'} ${st.reason}\n`);
}

// ───────────────────────── lint（只报告） ─────────────────────────

function topCounts(map, n = 8) {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n).map(([k, v]) => ({ key: k, count: v }));
}
const topDir = (root, f) => { const r = path.relative(root, f).split(path.sep).join('/'); return r.includes('/') ? r.split('/')[0] + '/' : r; };

async function eslintReport(st, ctx) {
  let bin;
  try {
    const req = createRequire(path.join(ctx.root, 'package.json'));
    const pj = req.resolve('eslint/package.json');
    const meta = JSON.parse(fs.readFileSync(pj, 'utf8'));
    bin = path.join(path.dirname(pj), typeof meta.bin === 'string' ? meta.bin : meta.bin.eslint);
    st.details = { version: meta.version };
  } catch {
    st.status = 'skip';
    st.reason = '没有安装 eslint：devDependencies 加上 eslint、@eslint/js、globals 后 npm ci（见 tests/ci/README.md「lint」）';
    process.stderr.write(`  · ${st.reason}\n`);
    return;
  }
  st.command = `node ${path.relative(ctx.root, bin).split(path.sep).join('/')} --format json .`;
  const r = await run(process.execPath, [bin, '--format', 'json', '.'], { cwd: ctx.root, stdout: 'capture', stderr: 'pipe', timeoutMs: 1000 * (ctx.opts.timeout || 300) });
  let res;
  try { res = JSON.parse(r.stdout); } catch {
    st.status = 'error'; st.exitCode = r.code; st.reason = `eslint 没有给出结果（退出码 ${r.code}）：${tail(r.stderr, 3).join(' ')}`;
    process.stderr.write(`  ✗ ${st.reason}\n`);
    return;
  }
  const rules = new Map(), dirs = new Map();
  let errors = 0, warns = 0, fatal = 0;
  for (const f of res) {
    errors += f.errorCount; warns += f.warningCount; fatal += f.fatalErrorCount || 0;
    for (const m of f.messages) {
      const k = m.ruleId || (m.fatal ? '解析错误' : '其他');
      rules.set(k, (rules.get(k) || 0) + 1);
      dirs.set(topDir(ctx.root, f.filePath), (dirs.get(topDir(ctx.root, f.filePath)) || 0) + 1);
    }
  }
  Object.assign(st.details, { files: res.length, errors, warnings: warns, fatal, byRule: topCounts(rules), byDir: topCounts(dirs) });
  st.exitCode = r.code;
  st.status = errors + warns ? 'warn' : 'pass';
  st.reason = `eslint ${st.details.version}：${res.length} 个文件，${errors} 个错误、${warns} 个警告${fatal ? `（其中 ${fatal} 个解析失败）` : ''}`;
  process.stderr.write(`  ${st.reason}\n`);
  for (const { key, count } of st.details.byRule) process.stderr.write(`    ${String(count).padStart(5)}  ${key}\n`);
  if (st.details.byDir.length) process.stderr.write(`    按目录：${st.details.byDir.map(d => `${d.key} ${d.count}`).join('，')}\n`);
}

async function ruffReport(st, ctx) {
  const cands = [['ruff', []]];
  if (ctx.py) cands.push([ctx.py.cmd, [...ctx.py.pre, '-m', 'ruff']]);
  const found = cands.find(([c, pre]) => spawnSync(c, [...pre, '--version'], { stdio: 'ignore', timeout: 20000, windowsHide: true }).status === 0);
  if (!found) {
    st.status = 'skip';
    st.reason = '没有 ruff：python -m pip install --require-hashes -r tests/ci/requirements-lint.txt（或 pip install ruff）';
    process.stderr.write(`  · ${st.reason}\n`);
    return;
  }
  const [cmd, pre] = found;
  const ver = spawnSync(cmd, [...pre, '--version'], { encoding: 'utf8', timeout: 20000, windowsHide: true }).stdout.trim();
  st.command = [cmd, ...pre, 'check', '--output-format', 'json', '--exit-zero', '.'].join(' ');
  const r = await run(cmd, [...pre, 'check', '--output-format', 'json', '--exit-zero', '.'], { cwd: ctx.root, env: pythonEnv(), stdout: 'capture', stderr: 'pipe', timeoutMs: 1000 * (ctx.opts.timeout || 300) });
  let res;
  try { res = JSON.parse(r.stdout); } catch {
    st.status = 'error'; st.exitCode = r.code; st.reason = `ruff 没有给出结果（退出码 ${r.code}）：${tail(r.stderr, 3).join(' ')}`;
    process.stderr.write(`  ✗ ${st.reason}\n`);
    return;
  }
  const rules = new Map(), dirs = new Map(), files = new Set();
  for (const d of res) {
    const k = d.code || '语法错误';
    rules.set(k, (rules.get(k) || 0) + 1);
    dirs.set(topDir(ctx.root, d.filename), (dirs.get(topDir(ctx.root, d.filename)) || 0) + 1);
    files.add(d.filename);
  }
  st.details = { version: ver, diagnostics: res.length, files: files.size, byRule: topCounts(rules), byDir: topCounts(dirs) };
  st.exitCode = r.code;
  st.status = res.length ? 'warn' : 'pass';
  st.reason = `${ver}：${res.length} 条告警，涉及 ${files.size} 个文件`;
  process.stderr.write(`  ${st.reason}\n`);
  for (const { key, count } of st.details.byRule) process.stderr.write(`    ${String(count).padStart(5)}  ${key}\n`);
  if (st.details.byDir.length) process.stderr.write(`    按目录：${st.details.byDir.map(d => `${d.key} ${d.count}`).join('，')}\n`);
}

// ───────────────────────── 输出 ─────────────────────────

function printHuman(steps, opts) {
  const rows = steps.map(s => [s.id, s.title, `${STATUS[s.status] || s.status}${s.blocking ? '' : '（不阻塞）'}`, s.durationMs ? fmtSec(s.durationMs) : '-', s.reason || '']);
  const bad = steps.filter(s => s.blocking && ['fail', 'error', 'timeout'].includes(s.status));
  const lines = ['\n检查汇总（tools/check-all.mjs）', table(['步骤', '名称', '结果', '用时', '说明'], rows)];
  const blocking = steps.filter(s => s.blocking), ran = blocking.filter(s => s.status !== 'skip');
  const notes = steps.filter(s => !s.blocking && s.status !== 'skip' && s.reason).map(s => `${s.id}：${s.reason}`);
  lines.push(bad.length ? `✗ ${bad.length} 个阻塞步骤未通过：${bad.map(s => s.id).join('、')}`
    : `✓ 阻塞步骤全部通过（${ran.filter(s => s.status === 'pass').length}/${ran.length}${blocking.length > ran.length ? `，另有 ${blocking.length - ran.length} 步跳过` : ''}）`);
  if (notes.length) lines.push(`  只报告、不影响退出码：${notes.join('；')}`);
  (opts.json ? process.stderr : process.stdout).write(lines.join('\n') + '\n');
}

function reportActions(steps) {
  if (!inActions()) return;
  for (const s of steps) {
    if (s.blocking && ['fail', 'error', 'timeout'].includes(s.status)) annotate('error', s.reason || STATUS[s.status], { title: `检查未通过：${s.id} · ${s.title}` });
    else if (!s.blocking && s.status === 'warn') annotate('warning', s.reason, { title: `${s.title}` });
    for (const f of (s.id === 'syntax' && s.details?.failures) || []) annotate('error', f.message, { title: '语法错误', file: f.file, line: f.line || undefined });
  }
  stepSummary(['### 检查（check-all）', '', '| 步骤 | 名称 | 结果 | 用时 | 说明 |', '|---|---|---|---|---|',
    ...steps.map(s => `| ${s.id} | ${mdCell(s.title)} | ${STATUS[s.status] || s.status}${s.blocking ? '' : '（不阻塞）'} | ${s.durationMs ? fmtSec(s.durationMs) : '-'} | ${mdCell(s.reason || '')} |`), ''].join('\n'));
}

if (isMain(import.meta.url)) process.exitCode = await main();
