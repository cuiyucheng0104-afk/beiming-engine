// 离屏出片 · 预览对拍（tools/offscreen/compare.mjs）：同一作品模块在 Chrome WebGPU（预览）与 Node + Dawn（出片）里渲同几帧，过质量门。
// 拿不到 GPU、缺可选依赖、或无头浏览器拿不到 WebGPU 适配器时（命令退出 3）跳过，跳过原因来自命令自己的报错。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const run = args => spawnSync(process.execPath, [join(ROOT, 'tools/offscreen/compare.mjs'), ...args, '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });

test('演示作品：预览与出片同帧过质量门（PSNR ≥ 50 dB，大差像素 ≤ 0.1%）', { timeout: 200000 }, t => {
  const r = run(['lab/offscreen/ink.mjs', '--frames', '0,5', '--size', '320x180']);
  const e = JSON.parse(r.stdout);
  if (r.status === 3) return t.skip(`离屏对拍不可用：${e.error.message}`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(e.ok, true);
  assert.equal(e.data.frames.length, 2);
  for (const f of e.data.frames) {
    assert.equal(f.ok, true, JSON.stringify(f));
    assert.ok(f.psnr === null || f.psnr >= 50, JSON.stringify(f));
  }
});

test('门槛收紧到做不到（--min-psnr 200）：退出 4、contract.offscreen-gate，逐帧写明原因', { timeout: 200000 }, t => {
  const r = run(['lab/offscreen/ink.mjs', '--frames', '3', '--size', '320x180', '--min-psnr', '200']);
  const e = JSON.parse(r.stdout);
  if (r.status === 3) return t.skip(`离屏对拍不可用：${e.error.message}`);
  // 预览与出片恰好逐字节相同时 PSNR 是无穷，任何门槛都过：那就没法验证这条，跳过
  if (r.status === 0 && e.data.frames.every(f => f.identical)) return t.skip('这台机器上预览与出片逐字节相同');
  assert.equal(r.status, 4, r.stderr);
  assert.equal(e.error.code, 'contract.offscreen-gate');
  assert.match(e.data.frames[0].reasons.join(' '), /低于 200 dB/);
});

test('用法错误：--frames 不是帧号列表、作品不在仓库里 → 退出 2（不需要 GPU）', () => {
  for (const [args, code] of [
    [['lab/offscreen/ink.mjs', '--frames', '0,x'], 'usage.bad-value'],
    [['/etc/hostname', '--frames', '0'], 'usage.work-outside-repo'],
  ]) {
    const r = run(args);
    assert.equal(r.status, 2, `${args.join(' ')}\n${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).error.code, code);
  }
});
