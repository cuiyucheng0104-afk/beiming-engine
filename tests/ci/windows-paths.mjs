#!/usr/bin/env node
// 北冥仓库 · 路径与编码可移植性检查（CI 的 windows-paths job；macOS / Linux 上也能跑）：
// 工作站上仓库常经目录联接（D:\北冥 → D:\beiming）或带空格、带中文的路径进入，命令行是 PowerShell，控制台是 GBK。
// 这里把这几种情况造出来，逐项确认工具「要么正确工作，要么清楚地报错」，不许静默什么都不做却 exit 0。
//   node tests/ci/windows-paths.mjs [--json] [--report 文件] [--keep]
//
// 检查项：
//   eol            已跟踪的文本文件（cases/ 除外）有没有被检出成 CRLF（缺 .gitattributes 时 Windows 默认会转，sh 脚本与按字节校验的工具会坏）→ 只提示
//   alias          在临时目录建一个带空格和中文的别名「北冥 别名」指向仓库根（Windows 用目录联接，其他系统用符号链接）
//   new-film       经别名的绝对路径运行 tools/new-film.mjs：必须真的建出作品（不能 exit 0 却什么都没做）
//   new-film-cwd   以别名为当前目录、用相对路径运行 new-film（Windows 上 cwd 保留联接路径，与上一项是两种情况）
//   repo-check     经别名运行 tools/repo-check.mjs --json，结果要与真实路径下一致
//   run-tests      经别名运行 tools/run-tests.mjs --list --json，发现的测试组要与真实路径下一致
//   check-all      经别名运行 tools/check-all.mjs 的几个快速步骤
//   python-gbk     PYTHONIOENCODING=gbk 时 tools/casebook.py list 输出到管道仍要 exit 0（中文 Windows 控制台的情况）
// 建的作品与别名在结束、出错或被中断时都会删掉（--keep 保留）。删别名只删链接本身，绝不递归进目标目录。
// 退出码：0 全部通过（eol 只提示）；1 有检查未通过；2 用法错误；130 / 143 被中断（已清理）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  ROOT, EXIT, CliError, parseArgs, envelope, writeReport, isMain, run, onSignals, resolvePython,
  inActions, annotate, stepSummary, mdCell, table, fmtSec,
} from '../../tools/run-tests.mjs';

const SPEC = { json: { type: 'bool' }, report: { type: 'string' }, keep: { type: 'bool' }, python: { type: 'string' }, help: { type: 'bool', short: 'h' } };
export const HELP = `北冥仓库 · 路径与编码可移植性检查（CI windows-paths）

用法：node tests/ci/windows-paths.mjs [--json] [--report 文件] [--keep] [--python 解释器]

检查：eol、alias、new-film、new-film-cwd、repo-check、run-tests、check-all、python-gbk（说明见文件开头）。
退出码：0 通过（eol 只提示）；1 有检查未通过；2 用法错误；130/143 被中断（已清理）`;

const TEXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.md', '.py', '.sh', '.html', '.css', '.yml', '.yaml', '.toml', '.txt']);

// 已跟踪的文本文件里有多少是 CRLF（cases/ 是按字节归档的快照，不算）
export function crlfFiles(root) {
  const g = spawnSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (g.status !== 0) return null;
  const hits = [];
  for (const f of g.stdout.split('\0').filter(Boolean)) {
    if (f.startsWith('cases/') || !TEXT.has(path.extname(f).toLowerCase())) continue;
    try { if (fs.readFileSync(path.join(root, f)).includes('\r\n')) hits.push(f); } catch { /* 被删或不可读 */ }
  }
  return hits;
}

const filesUnder = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) filesUnder(p, out); else out.push(p); } return out; };

// 建别名：Windows 目录联接（不需要管理员权限），其他系统符号链接；返回 { base, alias }
export function makeAlias(target) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-paths-'));
  const alias = path.join(base, '北冥 别名');
  fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  return { base, alias };
}
// 只删链接本身：POSIX unlink，Windows 对联接用 rmdir（只移除联接点）；最后删空的临时目录。绝不递归删除。
export function removeAlias({ base, alias }) {
  try {
    const st = fs.lstatSync(alias);
    if (!st.isSymbolicLink()) throw new Error(`${alias} 不是链接，拒绝删除`);
    if (process.platform === 'win32') fs.rmdirSync(alias); else fs.unlinkSync(alias);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  try { fs.rmdirSync(base); } catch { /* 不空就留着，交给系统清理 */ }
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  const warnings = [], checks = [];
  const finish = (exitCode, extra = {}, error = null) => {
    const env = envelope({ exitCode, command: 'windows-paths', error, warnings, ...extra });
    if (opts?.json) process.stdout.write(JSON.stringify(env, null, 2) + '\n');
    writeReport(opts?.report, env);
    if (error) process.stderr.write(`${error.message}${error.hint ? `\n${error.hint}` : ''}\n`);
    return exitCode;
  };
  try { opts = parseArgs(argv, SPEC); } catch (e) { opts = { json: argv.includes('--json') }; return finish(e.exitCode, {}, e); }
  if (opts.help) { process.stdout.write(HELP + '\n'); return EXIT.OK; }

  const tag = crypto.randomBytes(3).toString('hex');
  const films = [], filmsDir = path.join(ROOT, 'films'), hadFilms = fs.existsSync(filmsDir);
  let link = null;
  const cleanup = () => {
    if (opts.keep) return;
    for (const f of films) fs.rmSync(path.join(filmsDir, f), { recursive: true, force: true });   // 真实路径，不经别名
    if (!hadFilms) { try { fs.rmdirSync(filmsDir); } catch { /* 不空 */ } }
    if (link) { try { removeAlias(link); } catch (e) { warnings.push(`删除别名失败：${e.message}`); } }
  };
  onSignals(code => { cleanup(); finish(code, { checks }, new CliError(code, 'INTERRUPTED', '被中断，已清理别名与临时作品')); });

  const add = (id, title, status, detail, extra = {}) => {
    checks.push({ id, title, status, detail, ...extra });
    process.stderr.write(`  ${status === 'pass' ? '✓' : status === 'warn' ? '!' : status === 'skip' ? '·' : '✗'} ${id} · ${title}：${detail}\n`);
  };
  const node = (args, { cwd = ROOT, env = process.env } = {}) => run(process.execPath, args, { cwd, env, stdout: 'capture', stderr: 'capture', timeoutMs: 300000 });
  const t0 = Date.now();
  process.stderr.write(`平台 ${process.platform}/${process.arch}，Node ${process.versions.node}，仓库 ${ROOT}\n`);

  try {
    // eol
    const crlf = crlfFiles(ROOT);
    const autocrlf = spawnSync('git', ['-C', ROOT, 'config', '--get', 'core.autocrlf'], { encoding: 'utf8' }).stdout.trim() || '未设置';
    if (crlf === null) add('eol', '换行', 'skip', '不是 git 检出，跳过');
    else if (crlf.length) add('eol', '换行', 'warn', `${crlf.length} 个已跟踪文本文件是 CRLF（例如 ${crlf.slice(0, 3).join('、')}）；core.autocrlf=${autocrlf}。仓库需要 .gitattributes（* text=auto eol=lf，cases/** -text）`, { files: crlf.length });
    else add('eol', '换行', 'pass', `已跟踪文本文件都是 LF（core.autocrlf=${autocrlf}）`);

    // alias
    try { link = makeAlias(ROOT); add('alias', '别名路径', 'pass', `${link.alias} → ${ROOT}`); } catch (e) { add('alias', '别名路径', 'fail', `建不了别名：${e.message}`); }

    if (link) {
      const A = link.alias;
      // new-film：绝对路径经别名
      for (const [id, route, how] of [['new-film', 'a', 'abs'], ['new-film-cwd', 'c', 'cwd']]) {
        const name = `ci-win-${route}-${tag}`;
        films.push(name);
        const script = how === 'abs' ? path.join(A, 'tools', 'new-film.mjs') : path.join('tools', 'new-film.mjs');
        const r = await node([script, route, name, '--title', '视窗 试映'], { cwd: A });
        const fj = path.join(filmsDir, name, 'film.json');
        const made = fs.existsSync(fj);
        let detail = `${how === 'abs' ? '经别名的绝对路径' : '别名作 cwd、相对路径'}运行，退出码 ${r.code}`;
        let ok = r.code === 0 && made;
        if (made) {
          const j = JSON.parse(fs.readFileSync(fj, 'utf8'));
          const left = filesUnder(path.join(filmsDir, name)).filter(f => TEXT.has(path.extname(f).toLowerCase()) && /\{\{(NAME|TITLE)\}\}/.test(fs.readFileSync(f, 'utf8')));
          if (j.title !== '视窗 试映') { ok = false; detail += `；标题是 ${JSON.stringify(j.title)}`; }
          if (left.length) { ok = false; detail += `；残留占位符：${left.map(f => path.basename(f)).join('、')}`; }
        } else if (r.code === 0) detail += '，但没有建出作品（静默无操作：入口判断没认出经链接调用，见 tests/ci/README.md「已知问题」）';
        else detail += `：${(r.stderr || r.stdout).trim().split(/\r?\n/).pop()}`;
        add(id, `新建作品（${route}）`, ok ? 'pass' : 'fail', detail);
      }
      // repo-check：经别名与真实路径结果一致
      const [ra, rr] = await Promise.all([node([path.join(A, 'tools', 'repo-check.mjs'), '--json'], { cwd: A }), node([path.join(ROOT, 'tools', 'repo-check.mjs'), '--json'])]);
      const sum = r => { try { const j = JSON.parse(r.stdout); return { code: r.code, errors: j.errors ?? j.error ?? null, warnings: j.warnings?.length ?? j.warnings ?? null }; } catch { return { code: r.code, errors: '非 JSON', warnings: null }; } };
      const sa = sum(ra), sr = sum(rr);
      add('repo-check', '仓库规范（经别名）', JSON.stringify(sa) === JSON.stringify(sr) ? 'pass' : 'fail',
        `别名：退出码 ${sa.code}、${sa.errors} 个错误；真实路径：退出码 ${sr.code}、${sr.errors} 个错误${JSON.stringify(sa) === JSON.stringify(sr) ? '（一致）' : '（不一致）'}`);
      // run-tests：发现结果一致
      const [ta, tr] = await Promise.all([node([path.join(A, 'tools', 'run-tests.mjs'), '--list', '--json'], { cwd: A }), node([path.join(ROOT, 'tools', 'run-tests.mjs'), '--list', '--json'])]);
      const ids = r => { try { return JSON.parse(r.stdout).suites.map(s => `${s.id}:${s.files.length}`).join(','); } catch { return `退出码 ${r.code}`; } };
      add('run-tests', '测试发现（经别名）', ta.code === 0 && ids(ta) === ids(tr) ? 'pass' : 'fail', `别名：${ids(ta) || '无'}；真实路径：${ids(tr) || '无'}`);
      // check-all：几个快速步骤
      const ca = await node([path.join(A, 'tools', 'check-all.mjs'), '--only', 'plan,styles,changelog', '--json'], { cwd: A });
      let caDetail = `退出码 ${ca.code}`;
      try { caDetail += '：' + JSON.parse(ca.stdout).steps.map(s => `${s.id} ${s.status}`).join('，'); } catch { /* 原样 */ }
      add('check-all', '检查总入口（经别名）', ca.code === 0 ? 'pass' : 'fail', caDetail);
    }

    // python-gbk：中文 Windows 控制台的编码
    const py = resolvePython(ROOT, opts.python);
    if (!py) add('python-gbk', 'Python 输出到 GBK 管道', 'skip', '找不到 Python 解释器');
    else {
      const env = { ...process.env, PYTHONIOENCODING: 'gbk' };
      delete env.PYTHONUTF8;
      // 输出按 GBK 编码：按字节收回来再用 GBK 解码，报错信息才不是乱码
      const r = spawnSync(py.cmd, [...py.pre, path.join(ROOT, 'tools', 'casebook.py'), 'list'], { cwd: ROOT, env, timeout: 120000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      const decode = b => { try { return new TextDecoder('gbk').decode(b || Buffer.alloc(0)); } catch { return Buffer.from(b || '').toString('utf8'); } };
      const err = decode(r.stderr).trim().split(/\r?\n/).pop() || (r.error ? r.error.message : '');
      add('python-gbk', 'Python 输出到 GBK 管道', r.status === 0 ? 'pass' : 'fail',
        r.status === 0 ? `casebook list 正常（${py.label}）`
          : `casebook list 退出码 ${r.status}：${err}（中文 Windows 上把输出重定向到文件时会遇到；Python 入口要把标准输出改成 UTF-8，或经 tools/env/py.mjs 运行）`);
    }
  } finally {
    cleanup();
  }

  const bad = checks.filter(c => c.status === 'fail');
  for (const c of checks.filter(c => c.status === 'warn')) warnings.push(`${c.id}：${c.detail}`);
  process.stderr.write(`\n路径与编码检查汇总（tests/ci/windows-paths.mjs）\n${table(['检查', '名称', '结果'], checks.map(c => [c.id, c.title, { pass: '通过', fail: '失败', warn: '提示', skip: '跳过' }[c.status]]))}\n用时 ${fmtSec(Date.now() - t0)}\n`);
  if (inActions()) {
    for (const c of checks) if (c.status === 'fail') annotate('error', c.detail, { title: `路径检查未通过：${c.id}` }); else if (c.status === 'warn') annotate('warning', c.detail, { title: `路径检查提示：${c.id}` });
    stepSummary(['### 路径与编码（windows-paths）', '', '| 检查 | 名称 | 结果 | 说明 |', '|---|---|---|---|',
      ...checks.map(c => `| ${c.id} | ${mdCell(c.title)} | ${c.status} | ${mdCell(c.detail)} |`), ''].join('\n'));
  }
  const error = bad.length ? new CliError(EXIT.FAIL, 'PORTABILITY_FAILED', `${bad.map(c => c.id).join('、')} 未通过`, '逐项看上面的说明；已知问题与负责的工作包见 tests/ci/README.md') : null;
  return finish(bad.length ? EXIT.FAIL : EXIT.OK, { platform: `${process.platform}-${process.arch}`, checks }, error);
}

if (isMain(import.meta.url)) process.exitCode = await main();
