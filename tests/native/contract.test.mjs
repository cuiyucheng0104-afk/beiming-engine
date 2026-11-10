// B 路线命令约定（加固计划附录 C1/C2）：每个入口 --help 退出 0、输出到 stdout、不产生任何文件；未知参数 exit 2；
// --json 时 stdout 只有一个 JSON 信封；缺原生运行时的预检是一行中文指引、exit 3（验收 B1）。不启动 GPU。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ENTRIES = [
  'engine/render/native.mjs', 'engine/native/prepare.mjs', 'engine/native/sequence.mjs', 'engine/native/runtime.mjs',
  'engine/native/bridge/export.mjs', 'engine/native/bridge/validate.mjs',
  'examples/raea/tools/prepare.mjs', 'examples/raea/tools/render.mjs', 'examples/raea/tools/export-kun.mjs', 'examples/raea/tools/export-kun-validate.mjs',
];
const run = (args, env = process.env) => spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', env, timeout: 60000 });
const status = () => spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: ROOT, encoding: 'utf8', timeout: 30000 }).stdout;
const noRuntime = () => { const env = { ...process.env }; delete env.RAEA_BIN; return env; };

for (const entry of ENTRIES) {
  test(`${entry}：--help 退出 0、写 stdout、不产生文件`, () => {
    const before = status();
    const r = run([entry, '--help'], noRuntime());
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.trim().length > 20, '用法要写到 stdout');
    assert.equal(status(), before, '--help 不能有副作用');
  });
  test(`${entry}：未知参数 exit 2；--json 时 stdout 只有一个信封`, () => {
    const r = run([entry, '--no-such-flag', '--json'], noRuntime());
    assert.equal(r.status, 2, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, false);
    assert.equal(j.exitCode, 2);
    assert.equal(j.error.code, 'usage');
    for (const k of ['command', 'outputs', 'runJson', 'warnings']) assert.ok(k in j, k);
  });
}

test('验收 B1：不设 RAEA_BIN 时预检是一行中文指引，exit 3', () => {
  const r = run(['engine/render/native.mjs', 'routes/b-native/template', '--check-only'], noRuntime());
  assert.equal(r.status, 3);
  const lines = r.stderr.trim().split('\n').filter(l => !l.startsWith('提示：'));
  assert.equal(lines.length, 1, r.stderr);
  assert.match(lines[0], /RAEA_BIN.*下一步/);
});

test('参数自相矛盾或越界都是用法错误（exit 2），在启动任何东西之前', () => {
  for (const args of [['--at', '0', '--frame', '1'], ['--quality', 'ultra'], ['--at', '9999'], ['--timeout', '-1'], ['--out', 'x.mp4']]) {
    const r = run(['engine/render/native.mjs', 'routes/b-native/template', ...args], { ...noRuntime(), RAEA_BIN: '/no/such/raea' });
    assert.equal(r.status, 2, `${args.join(' ')} → ${r.status}：${r.stderr}`);
  }
});

test('给的不是 B 路线作品目录：exit 2', () => {
  assert.equal(run(['engine/render/native.mjs', 'routes/a-webgl/template', '--check-only'], noRuntime()).status, 2);
  assert.equal(run(['engine/render/native.mjs', 'no/such/film', '--check-only'], noRuntime()).status, 2);
});
