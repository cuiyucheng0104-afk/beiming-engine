// tools/lib/cli.mjs 的单元测试：严格解析、帮助无副作用、--json 信封、错误码与退出码、信号清理。
//   node --test tests/cli/cli-lib.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CliError, EXIT, defineCommand, envelope, exitCodeFor, formatHelp, parseArgs, runCli, suggest } from '../../tools/lib/cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function sink() {
  const chunks = [];
  return { write: s => { chunks.push(String(s)); return true; }, text: () => chunks.join('') };
}

function makeCmd(run = async () => ({ data: { ran: true } })) {
  let calls = 0;
  const cmd = defineCommand({
    name: 'demo',
    summary: '演示命令',
    usage: ['node demo.mjs <作品> [选项]'],
    positionals: [{ name: 'film', label: '<作品>', describe: '作品目录' }],
    options: {
      frames: { type: 'string', arg: '<a:b>', describe: '帧区间' },
      workers: { type: 'integer', min: 1, max: 64, describe: '并行数' },
      mode: { type: 'string', choices: ['draft', 'final'], describe: '档位' },
      only: { type: 'list', split: ',', describe: '只跑这些' },
      'dry-run': { type: 'boolean', describe: '演练' },
    },
    run: async ctx => { calls++; return run(ctx); },
  });
  return { cmd, calls: () => calls };
}

async function invoke(cmd, argv) {
  const stdout = sink(), stderr = sink();
  const code = await runCli(cmd, argv, { stdout, stderr, signals: false, setExitCode: false, env: {} });
  return { code, out: stdout.text(), err: stderr.text() };
}

test('退出码常量与附录 C1 一致', () => {
  assert.deepEqual({ ...EXIT }, { OK: 0, FAILURE: 1, USAGE: 2, ENVIRONMENT: 3, CONTRACT: 4, BUSY: 5, TIMEOUT: 124, SIGINT: 130, SIGTERM: 143 });
  assert.equal(exitCodeFor('usage.x'), 2);
  assert.equal(exitCodeFor('env.ffmpeg'), 3);
  assert.equal(exitCodeFor('contract.qa'), 4);
  assert.equal(exitCodeFor('busy.lock'), 5);
  assert.equal(exitCodeFor('timeout'), 124);
  assert.equal(exitCodeFor('failure.io'), 1);
  assert.equal(new CliError('contract.x', 'm').exitCode, 4);
  assert.equal(new CliError('usage.x', 'm', '直接给提示').hint, '直接给提示');
  assert.equal(new CliError('usage.x', 'm', { hint: '对象写法' }).hint, '对象写法');
});

test('位置参数可以在任意位置；--k v 与 --k=v 都行；-- 之后都是位置参数', () => {
  const { cmd } = makeCmd();
  const a = parseArgs(cmd, ['--workers', '4', 'films/x', '--frames=0:48', '--dry-run']);
  assert.equal(a.args.film, 'films/x');
  assert.equal(a.opts.workers, 4);
  assert.equal(a.opts.frames, '0:48');
  assert.equal(a.opts['dry-run'], true);
  const b = parseArgs(cmd, ['--', '--weird-dir']);
  assert.equal(b.args.film, '--weird-dir');
  const c = parseArgs(cmd, ['x', '--only', 'core,comp', '--only', 'agent']);
  assert.deepEqual(c.opts.only, ['core', 'comp', 'agent']);
});

test('未知选项、缺值、非法数值、越界、多余参数都是用法错误（2），并给建议', () => {
  const { cmd } = makeCmd();
  const cases = [
    [['x', '--no-such-flag'], 'usage.unknown-option'],
    [['x', '--worker', '2'], 'usage.unknown-option'],
    [['x', '--frames'], 'usage.missing-value'],
    [['x', '--frames', '--dry-run'], 'usage.missing-value'],
    [['x', '--workers', 'four'], 'usage.bad-value'],
    [['x', '--workers', '0'], 'usage.bad-value'],
    [['x', '--mode', 'fnial'], 'usage.bad-value'],
    [['x', 'y'], 'usage.extra-argument'],
    [[], 'usage.missing-argument'],
    [['x', '--frames', '1', '--frames', '2'], 'usage.repeated-option'],
    [['x', '-x'], 'usage.unknown-option'],
    [['x', '--dry-run=maybe'], 'usage.bad-value'],
  ];
  for (const [argv, code] of cases) {
    assert.throws(() => parseArgs(cmd, argv), e => e instanceof CliError && e.code === code && e.exitCode === 2, `${argv.join(' ')} → ${code}`);
  }
  try { parseArgs(cmd, ['x', '--worker', '2']); } catch (e) { assert.match(e.hint, /--workers/); }
  try { parseArgs(cmd, ['x', '--mode', 'fnial']); } catch (e) { assert.match(e.hint, /final/); }
  assert.equal(suggest('josn', ['json', 'quiet']), 'json');
  assert.equal(suggest('zzzzzz', ['json']), null);
});

test('--help / -h 打印到 stdout、退出 0、不执行 run，即使还带着非法参数', async () => {
  for (const argv of [['--help'], ['-h'], ['x', '--no-such-flag', '--help'], ['--json', '--help']]) {
    const { cmd, calls } = makeCmd();
    const r = await invoke(cmd, argv);
    assert.equal(r.code, 0, argv.join(' '));
    assert.equal(calls(), 0, 'run 不应被调用');
    assert.match(r.out, /用法：node demo\.mjs/);
    assert.match(r.out, /--dry-run/);
    assert.match(r.out, /-h, --help/);
    assert.equal(r.err, '');
  }
  const { cmd, calls } = makeCmd();
  const r = await invoke(cmd, ['--version']);
  assert.equal(r.code, 0);
  assert.equal(calls(), 0);
  assert.match(r.out, /^demo \d+\.\d+\.\d+/);
});

test('--json：stdout 只有一个对象，成功与失败都输出，日志走 stderr', async () => {
  const { cmd } = makeCmd(async ctx => { ctx.log.info('进度'); ctx.warn('demo.w', '有个提醒', '下一步'); ctx.out('给人看的'); return { data: { n: 1 }, outputs: [{ path: 'films/x/out/a.mp4', sha256: 'ab', kind: 'video' }] }; });
  const ok = await invoke(cmd, ['x', '--json']);
  assert.equal(ok.code, 0);
  const j = JSON.parse(ok.out);
  assert.deepEqual(Object.keys(j), ['schemaVersion', 'ok', 'exitCode', 'command', 'error', 'outputs', 'runJson', 'warnings', 'data']);
  assert.equal(j.ok, true);
  assert.equal(j.command, 'demo');
  assert.deepEqual(j.outputs, [{ path: 'films/x/out/a.mp4', sha256: 'ab', kind: 'video' }]);
  assert.deepEqual(j.warnings, [{ code: 'demo.w', message: '有个提醒', hint: '下一步' }]);
  assert.deepEqual(j.data, { n: 1 });
  assert.doesNotMatch(ok.out, /给人看的/);
  assert.match(ok.err, /进度/);

  const bad = await invoke(cmd, ['x', '--json', '--no-such-flag']);
  assert.equal(bad.code, 2);
  const e = JSON.parse(bad.out);
  assert.equal(e.ok, false);
  assert.equal(e.exitCode, 2);
  assert.equal(e.error.code, 'usage.unknown-option');
  assert.match(bad.err, /错误\[usage\.unknown-option\]/);
});

test('run 抛 CliError 时按错误码退出；返回 error 时带着 data 失败；未知异常是 1 且默认不打印堆栈', async () => {
  const thrower = makeCmd(async () => { throw new CliError('contract.demo', '契约不符', { hint: '改 film.json' }); }).cmd;
  const r1 = await invoke(thrower, ['x', '--json']);
  assert.equal(r1.code, 4);
  assert.equal(JSON.parse(r1.out).error.hint, '改 film.json');

  const soft = makeCmd(async () => ({ data: { errors: 3 }, error: { code: 'contract.repo-check', message: '3 个错误', hint: null } })).cmd;
  const r2 = await invoke(soft, ['x', '--json']);
  assert.equal(r2.code, 4);
  assert.deepEqual(JSON.parse(r2.out).data, { errors: 3 });

  const boom = makeCmd(async () => { throw new TypeError('炸了'); }).cmd;
  const r3 = await invoke(boom, ['x']);
  assert.equal(r3.code, 1);
  assert.match(r3.err, /failure\.internal/);
  assert.doesNotMatch(r3.err, /at .*cli-lib\.test/);
});

test('抛错时执行登记的清理；--quiet 关掉进度日志但保留警告', async () => {
  let cleaned = 0;
  const cmd = makeCmd(async ctx => { ctx.onCleanup(() => { cleaned++; }); throw new CliError('failure.io', '写不进去'); }).cmd;
  await invoke(cmd, ['x']);
  assert.equal(cleaned, 1);
  const q = makeCmd(async ctx => { ctx.log.info('进度'); ctx.warn('提醒一下'); return {}; }).cmd;
  const r = await invoke(q, ['x', '--quiet']);
  assert.doesNotMatch(r.err, /进度/);
  assert.match(r.err, /提醒一下/);
});

test('声明写错时 defineCommand 直接报错（程序员错误，不是用户错误）', () => {
  assert.throws(() => defineCommand({ name: 'x', summary: 's' }), /run/);
  assert.throws(() => defineCommand({ name: 'x', summary: 's', run() {}, options: { BadName: { type: 'boolean' } } }), /kebab/);
  assert.throws(() => defineCommand({ name: 'x', summary: 's', run() {}, options: { json: { type: 'boolean' } } }), /全局/);
  assert.throws(() => defineCommand({ name: 'x', summary: 's', run() {}, options: { a: { type: 'float' } } }), /类型/);
});

test('帮助文字列出参数、选项、示例与退出码', () => {
  const { cmd } = makeCmd();
  const h = formatHelp(cmd);
  for (const s of ['参数：', '<作品>', '--workers', '（draft / final）', '退出码：', 'docs/CLI.md']) assert.ok(h.includes(s), s);
});

test('envelope 规范化警告与错误', () => {
  const e = envelope({ command: 'c', exitCode: 3, error: new CliError('env.ffmpeg', '没有 ffmpeg', { hint: '装 FFmpeg 7' }), warnings: ['一句话'] });
  assert.equal(e.ok, false);
  assert.deepEqual(e.error, { code: 'env.ffmpeg', message: '没有 ffmpeg', hint: '装 FFmpeg 7' });
  assert.deepEqual(e.warnings, [{ code: 'warning', message: '一句话', hint: null }]);
});

test('SIGTERM：先执行清理再以 143 退出，--json 时照样输出信封', { skip: process.platform === 'win32' ? 'Windows 没有 POSIX 信号' : false }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-cli-'));
  const marker = path.join(dir, 'tmp-artifact');
  const script = path.join(dir, 'sig.mjs');
  fs.writeFileSync(script, `
import fs from 'node:fs';
import { defineCommand, runCli } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'tools/lib/cli.mjs')).href)};
const cmd = defineCommand({ name: 'sig', summary: 's', run: async ctx => {
  fs.writeFileSync(${JSON.stringify(marker)}, 'x');
  ctx.onCleanup(() => fs.rmSync(${JSON.stringify(marker)}, { force: true }));
  process.stderr.write('READY\\n');
  await new Promise(r => setTimeout(r, 20000));
  return {};
} });
await runCli(cmd);
`);
  try {
    const child = spawn(process.execPath, [script, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('子进程没有就绪')), 10000);
      child.stderr.on('data', d => { err += d; if (err.includes('READY')) { clearTimeout(t); resolve(); } });
    });
    child.kill('SIGTERM');
    const code = await new Promise(r => child.on('close', c => r(c)));
    assert.equal(code, 143);
    assert.equal(fs.existsSync(marker), false, '清理应删掉临时文件');
    const j = JSON.parse(out);
    assert.equal(j.exitCode, 143);
    assert.equal(j.error.code, 'signal.sigterm');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
