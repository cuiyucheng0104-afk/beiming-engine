// B 路线命令约定（docs/CLI.md、附录 C1/C2）：每个入口都用 tools/lib/cli.mjs——--help 退出 0、输出到 stdout、不产生任何文件；
// 未知参数 exit 2；--json 时 stdout 只有一个 C2 信封；缺原生运行时的预检 exit 3，stderr 一行原因 + 一行下一步（验收 B1）。不启动 GPU。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ENTRIES = [
  'engine/render/native.mjs', 'engine/native/prepare.mjs', 'engine/native/sequence.mjs', 'engine/native/runtime.mjs',
  'engine/native/bridge/export.mjs', 'engine/native/bridge/validate.mjs',
  'examples/raea/tools/prepare.mjs', 'examples/raea/tools/render.mjs', 'examples/raea/tools/export-kun.mjs', 'examples/raea/tools/export-kun-validate.mjs',
];
const run = (args, env = process.env) => spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', env, timeout: 60000 });
const status = () => spawnSync('git', ['status', '--porcelain', '--untracked-files=all', '--ignored'], { cwd: ROOT, encoding: 'utf8', timeout: 30000 }).stdout;
const noRuntime = () => { const env = { ...process.env }; delete env.RAEA_BIN; return env; };

for (const entry of ENTRIES) {
  test(`${entry}：用命令约定库；--help 退出 0、写 stdout、不产生文件`, () => {
    const src = readFileSync(new URL(`../../${entry}`, import.meta.url), 'utf8');
    assert.match(src, /tools\/lib\/cli\.mjs['"]/, '入口直接 import tools/lib/cli.mjs（P02 契约测试按这个认）');
    assert.match(src, /\brunCli\(/);
    const before = status();
    const r = run([entry, '--help'], noRuntime());
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /用法/);
    assert.match(r.stdout, /退出码/);
    assert.equal(status(), before, '--help 不能有副作用');
  });
  test(`${entry}：未知参数 exit 2；--json 时 stdout 只有一个 C2 信封`, () => {
    const r = run([entry, '--no-such-flag', '--json'], noRuntime());
    assert.equal(r.status, 2, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.schemaVersion, 1);
    assert.equal(j.ok, false);
    assert.equal(j.exitCode, 2);
    assert.equal(j.error.code, 'usage.unknown-option');
    for (const k of ['command', 'outputs', 'runJson', 'warnings', 'data']) assert.ok(k in j, k);
  });
}

test('验收 B1：不设 RAEA_BIN 时预检 exit 3，stderr 是一行原因加一行下一步（不打堆栈）', () => {
  const r = run(['engine/render/native.mjs', 'routes/b-native/template', '--check-only'], noRuntime());
  assert.equal(r.status, 3, r.stderr);
  const lines = r.stderr.trim().split('\n');
  assert.equal(lines.length, 2, r.stderr);
  assert.match(lines[0], /^错误\[env\.no-runtime\]：.*RAEA_BIN/);
  assert.match(lines[1], /^提示：.*RAEA_BIN.*runtime\.mjs fetch --accept-license/);
  const j = JSON.parse(run(['engine/render/native.mjs', 'routes/b-native/template', '--check-only', '--json'], noRuntime()).stdout);
  assert.equal(j.exitCode, 3);
  assert.equal(j.error.code, 'env.no-runtime');
  assert.ok(j.error.hint.includes('RAEA_BIN'));
});

test('参数自相矛盾、越界、已停用的写法都是用法错误（exit 2），在启动任何东西之前', () => {
  for (const args of [['--at', '0', '--frame', '1'], ['--quality', 'ultra'], ['--at', '9999'], ['--at', '1,x'], ['--timeout', '-1'], ['--out', 'x.mp4'], ['--mux', 'mux.sh'], ['--profile', 'nope']]) {
    const r = run(['engine/render/native.mjs', 'routes/b-native/template', ...args], { ...noRuntime(), RAEA_BIN: '/no/such/raea' });
    assert.equal(r.status, 2, `${args.join(' ')} → ${r.status}：${r.stderr}`);
  }
});

test('给的不是 B 路线作品目录：exit 2', () => {
  assert.equal(run(['engine/render/native.mjs', 'routes/a-webgl/template', '--check-only'], noRuntime()).status, 2);
  assert.equal(run(['engine/render/native.mjs', 'no/such/film', '--check-only'], noRuntime()).status, 2);
});

test('native.mjs 登记的 VALIDATED 与 runtime.lock.json 的版本一致（tools/env/spec.json 读这一行）', async () => {
  const { VALIDATED } = await import('../../engine/render/native.mjs');
  const lock = JSON.parse(readFileSync(new URL('../../engine/native/runtime.lock.json', import.meta.url), 'utf8'));
  assert.equal(VALIDATED, lock.version);
  const spec = JSON.parse(readFileSync(new URL('../../tools/env/spec.json', import.meta.url), 'utf8')).raea;
  const src = readFileSync(new URL(`../../${spec.versionSource}`, import.meta.url), 'utf8');
  assert.equal(new RegExp(spec.versionPattern).exec(src)?.[1], lock.version, 'env:doctor 按 spec.json 的正则读到的版本要等于锁里的版本');
});
