// B 路线原生运行时的环境检查（tools/env/lib/checks.mjs 的 checkRaea）：版本声明、放行变量、已登记构建的哈希。
// 用临时目录里的假安装包（bin/raea + share/raea/VERSION）测，不需要真的运行时。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkRaea, raeaValidatedVersion, loadSpec } from '../../tools/env/lib/checks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SPEC = loadSpec(ROOT);
const KEY = `${process.platform}-${os.arch()}`;

function fakeRuntime(version, body = 'raea') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-raea-test-'));
  fs.mkdirSync(path.join(dir, 'bin'));
  const exe = path.join(dir, 'bin', process.platform === 'win32' ? 'raea.exe' : 'raea');
  fs.writeFileSync(exe, body, { mode: 0o755 });
  if (version !== null) { fs.mkdirSync(path.join(dir, 'share', 'raea'), { recursive: true }); fs.writeFileSync(path.join(dir, 'share', 'raea', 'VERSION'), version + '\n'); }
  return { dir, exe, sha: createHash('sha256').update(body).digest('hex') };
}

test('已验证版本从 engine/render/native.mjs 读，与 spec 的备用值一致', () => {
  assert.equal(raeaValidatedVersion(ROOT, SPEC), SPEC.raea.fallbackVersion);
});

test('checkRaea：没设、文件不存在、缺 VERSION、版本不对都判失败；BNE_ALLOW_VERSION 放行；非 B 路线只作提示', async () => {
  const want = raeaValidatedVersion(ROOT, SPEC);
  assert.equal((await checkRaea(ROOT, SPEC, { env: {} })).status, 'fail');
  assert.equal((await checkRaea(ROOT, SPEC, { env: {}, required: false })).status, 'info');
  assert.match((await checkRaea(ROOT, SPEC, { env: { RAEA_BIN: path.join(os.tmpdir(), `beiming-no-raea-${process.pid}`) } })).found, /不存在/);
  const noVer = fakeRuntime(null);
  const okRt = fakeRuntime(want);
  const other = fakeRuntime('9.9.9');
  try {
    assert.match((await checkRaea(ROOT, SPEC, { env: { RAEA_BIN: noVer.exe } })).found, /缺 /);
    const ok = await checkRaea(ROOT, SPEC, { env: { RAEA_BIN: okRt.exe } });
    assert.equal(ok.data.sha256, okRt.sha);
    const bad = await checkRaea(ROOT, SPEC, { env: { RAEA_BIN: other.exe } });
    assert.equal(bad.status, 'fail');
    assert.match(bad.fix, /BNE_ALLOW_VERSION=9\.9\.9/);
    assert.equal((await checkRaea(ROOT, SPEC, { env: { RAEA_BIN: other.exe, BNE_ALLOW_VERSION: '9.9.9' } })).status, 'pass');
  } finally { for (const r of [noVer, okRt, other]) fs.rmSync(r.dir, { recursive: true, force: true }); }
});

test('checkRaea：VERSION 相同但可执行文件与登记的已验证构建不同 → 告警（另一次构建）；一致 → 通过', async () => {
  const want = raeaValidatedVersion(ROOT, SPEC);
  const rt = fakeRuntime(want, 'some build');
  try {
    const spec = structuredClone(SPEC);
    spec.raea.knownBinaries = { [KEY]: { version: want, sha256: 'f'.repeat(64), recordedAt: '2026-11-10' } };
    const warn = await checkRaea(ROOT, spec, { env: { RAEA_BIN: rt.exe } });
    assert.equal(warn.status, 'warn');
    assert.match(warn.detail, /另一次构建/);
    assert.match(warn.fix, /knownBinaries/);
    spec.raea.knownBinaries[KEY].sha256 = rt.sha;
    assert.equal((await checkRaea(ROOT, spec, { env: { RAEA_BIN: rt.exe } })).status, 'pass');
  } finally { fs.rmSync(rt.dir, { recursive: true, force: true }); }
});
