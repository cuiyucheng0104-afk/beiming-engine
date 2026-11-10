// 控制机 ↔ 工作站（tools/remote）：参数编码、机器档案校验，以及用本机目录传输（local）走完整流程——
// 按提交建工作树、整机槽位锁、运行、取回并核对 sha256、清理；远端失败的退出码透传；槽位被占 exit 5；中断时远端清理干净。
// 端到端部分在临时目录里建一个只含 tools/remote 与 tools/env/lib/cli.mjs 的小仓库，代码包只有几 KB。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { shQuote, psQuote, encodePowerShell, remoteCommand, encodeToken, decodeToken } from '../../tools/remote/lib/shell.mjs';
import { validateMachine, resolveMachine, machinesFile } from '../../tools/remote/lib/profiles.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sha = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

test('参数编码：POSIX 单引号、PowerShell -EncodedCommand（UTF-16LE）、令牌只含 base64url 字符', () => {
  assert.equal(shQuote("it's"), `'it'\\''s'`);
  assert.equal(psQuote("it's"), `'it''s'`);
  const cmd = remoteCommand('powershell', ['node', 'D:/beiming-remote/bin/agent.mjs', 'run', "a b'c 中文"]);
  assert.match(cmd, /^powershell -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
  const script = Buffer.from(cmd.split(' ').pop(), 'base64').toString('utf16le');
  assert.match(script, /& 'node' 'D:\/beiming-remote\/bin\/agent\.mjs' 'run' 'a b''c 中文'; exit \$LASTEXITCODE$/);
  assert.equal(Buffer.from(encodePowerShell('x'), 'base64').toString('utf16le'), 'x');
  assert.equal(remoteCommand('posix', ['node', 'a b']), `'node' 'a b'`);
  const obj = { root: 'D:/r', cmd: ['node', '-e', 'console.log("引号\'与空格")'], env: { BEIMING_ANGLE: 'vulkan' } };
  const tok = encodeToken(obj);
  assert.match(tok, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeToken(tok), obj);
});

test('机器档案：root 只许 ASCII 且不含空格；ssh 传输要有目标；slots、env 的类型', () => {
  const ok = validateMachine('rtx', { ssh: 'u@h', shell: 'powershell', root: 'D:/beiming-remote' });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.machine.slots, 1);
  const bad = validateMachine('x', { transport: 'ssh', shell: 'cmd', root: 'D:/北冥 远程', slots: 0, env: { A: 1 } });
  assert.equal(bad.errors.length, 5, bad.errors.join('\n'));
  assert.ok(bad.errors.some(e => /缺 ssh/.test(e)) && bad.errors.some(e => /不能有空格或中文/.test(e)));
  assert.equal(machinesFile({ BEIMING_MACHINES: '/x/m.json' }), path.resolve('/x/m.json'));
  assert.equal(machinesFile({ XDG_CONFIG_HOME: '/cfg' }), path.join('/cfg', 'beiming', 'machines.json'));
  const adhoc = resolveMachine('adhoc', { file: path.join(os.tmpdir(), `beiming-no-machines-${process.pid}.json`), overrides: { transport: 'local', root: '/tmp/r' } });
  assert.equal(adhoc.name, 'adhoc');
  assert.throws(() => resolveMachine('rtx', { file: path.join(os.tmpdir(), `beiming-no-machines-${process.pid}.json`) }), /机器档案里没有「rtx」/);
});

// ── 端到端（local 传输）──
function miniRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-remote-test-'));
  const repo = path.join(base, 'repo');
  for (const rel of ['tools/remote/cli.mjs', 'tools/remote/agent.mjs', 'tools/remote/lib/profiles.mjs', 'tools/remote/lib/shell.mjs', 'tools/remote/lib/transport.mjs', 'tools/env/lib/cli.mjs']) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(repo, rel));
  }
  fs.writeFileSync(path.join(repo, '.gitignore'), 'out/\n');
  const g = (...a) => { const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'mini');
  return { base, repo, remote: path.join(base, 'remote'), head: g('rev-parse', 'HEAD') };
}
const cli = (m, args, opts = {}) => spawnSync(process.execPath, [path.join(m.repo, 'tools/remote/cli.mjs'), ...args], { cwd: m.repo, encoding: 'utf8', timeout: 120_000, ...opts });
const local = m => ['adhoc', '--transport', 'local', '--root', m.remote];
// 远端命令：写两个文件；一个由 --fetch 指定，另一个写进 --json 信封的 outputs 让 agent 自动取回
const WRITE = "const fs=require('fs');fs.mkdirSync('out/sub',{recursive:true});fs.writeFileSync('out/a.txt','甲'.repeat(1000));fs.writeFileSync('out/sub/b.bin',Buffer.alloc(70000,9));" +
  "console.log(JSON.stringify({ok:true,exitCode:0,command:'t',error:null,outputs:[{path:'out/sub/b.bin',sha256:null,kind:'t'}],runJson:null,warnings:[]}))";

test('remote run（local）：按提交建工作树运行，取回文件逐个核对 sha256，运行记录完整，远端清理干净', () => {
  const m = miniRepo();
  try {
    const r = cli(m, ['run', ...local(m), '--no-setup', '--fetch', 'out/a.txt', '--json', '--', 'node', '-e', WRITE]);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, true);
    const got = Object.fromEntries(j.outputs.filter(o => o.kind === 'remote-output').map(o => [o.path.split('/').slice(-2).join('/'), o]));
    assert.deepEqual(Object.keys(got).sort(), ['out/a.txt', 'sub/b.bin']);
    for (const o of j.outputs) assert.equal(sha(path.join(m.repo, o.path)), o.sha256, `${o.path} 的哈希与信封不符`);
    const run = JSON.parse(fs.readFileSync(path.join(m.repo, j.runJson), 'utf8'));
    assert.equal(run.sha, m.head);
    assert.equal(run.exitCode, 0);
    assert.ok(run.machine.hostname && run.machine.node && run.machine.platform);
    assert.deepEqual(run.fetchProblems, []);
    assert.equal(run.files.length, 2);
    // 远端：工作树删掉了，锁释放了，缓存仓库留着（下次只发增量）
    assert.deepEqual(fs.readdirSync(path.join(m.remote, 'runs')).filter(n => !n.endsWith('.json')), []);
    assert.deepEqual(fs.readdirSync(path.join(m.remote, 'locks')), []);
    assert.ok(fs.existsSync(path.join(m.remote, 'repo.git', 'HEAD')));
    // 第二次：缓存仓库已有这个提交，不再发代码包
    const r2 = cli(m, ['run', ...local(m), '--no-setup', '--json', '--', 'node', '-e', 'console.log(1)']);
    assert.equal(r2.status, 0, r2.stderr);
    assert.doesNotMatch(r2.stderr, /发送代码包/);
  } finally { fs.rmSync(m.base, { recursive: true, force: true }); }
});

test('remote run（local）：远端命令的退出码原样返回；槽位被占时 exit 5；工作区有未提交改动时拒绝', () => {
  const m = miniRepo();
  try {
    const fail = cli(m, ['run', ...local(m), '--no-setup', '--json', '--', 'node', '-e', 'process.exit(6)']);
    assert.equal(fail.status, 6, fail.stderr);
    assert.equal(JSON.parse(fail.stdout).exitCode, 6);
    // 用一个活着的进程（本测试进程）占住唯一的槽位
    fs.mkdirSync(path.join(m.remote, 'locks'), { recursive: true });
    fs.writeFileSync(path.join(m.remote, 'locks', 'slot-0.json'), JSON.stringify({ pid: process.pid, host: os.hostname(), runId: 'other-run-0001', startedAt: 'x' }));
    const busy = cli(m, ['run', ...local(m), '--no-setup', '--json', '--', 'node', '-e', '0']);
    assert.equal(busy.status, 5, busy.stderr);
    assert.match(JSON.parse(busy.stdout).error.message, /other-run-0001/);
    assert.deepEqual(fs.readdirSync(path.join(m.remote, 'runs')).filter(n => !n.endsWith('.json')), [], '槽位被占时也要删掉刚建的工作树');
    fs.rmSync(path.join(m.remote, 'locks', 'slot-0.json'));
    fs.appendFileSync(path.join(m.repo, 'tools/remote/README.txt'), 'x');
    spawnSync('git', ['add', 'tools/remote/README.txt'], { cwd: m.repo });
    const dirty = cli(m, ['run', ...local(m), '--no-setup', '--json', '--', 'node', '-e', '0']);
    assert.equal(dirty.status, 2);
    assert.match(JSON.parse(dirty.stdout).error.message, /未提交的改动/);
  } finally { fs.rmSync(m.base, { recursive: true, force: true }); }
});

// Windows 上 child.kill('SIGINT') 直接结束进程、不触发清理（真实的 Ctrl+C 走控制台事件），这条只在 POSIX 上跑
test('remote run（local）：控制机被中断时，远端结束子进程、删除工作树、释放锁，控制机 exit 130', { skip: process.platform === 'win32' && 'Windows 上无法用信号模拟 Ctrl+C' }, async () => {
  const m = miniRepo();
  const pidFile = path.join(m.base, 'child.pid');
  try {
    const child = spawn(process.execPath, [path.join(m.repo, 'tools/remote/cli.mjs'), 'run', ...local(m), '--no-setup', '--json', '--', 'node', '-e',
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 120000)`], { cwd: m.repo, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    const t0 = Date.now();
    while (!fs.existsSync(pidFile) && Date.now() - t0 < 30_000) await new Promise(r => setTimeout(r, 100));
    assert.ok(fs.existsSync(pidFile), '远端命令没有启动');
    const remotePid = +fs.readFileSync(pidFile, 'utf8');
    child.kill('SIGINT');
    const code = await new Promise(r => child.on('close', r));
    assert.equal(code, 130);
    assert.equal(JSON.parse(out).error.code, 'interrupted');
    await new Promise(r => setTimeout(r, 300));
    assert.throws(() => process.kill(remotePid, 0), /ESRCH/, '远端命令在中断后还活着');
    assert.deepEqual(fs.readdirSync(path.join(m.remote, 'runs')).filter(n => !n.endsWith('.json')), []);
    assert.deepEqual(fs.readdirSync(path.join(m.remote, 'locks')), []);
  } finally { fs.rmSync(m.base, { recursive: true, force: true }); }
});
