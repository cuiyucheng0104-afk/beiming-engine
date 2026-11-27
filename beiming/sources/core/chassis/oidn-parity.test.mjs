// 对拍脚本 oidn-parity.mjs 的纯逻辑：判据、行序翻转、读 Blender 多部件 EXR 时拒绝别的写法，与 OIDN 库的锁文件核对（两档）、OIDN 2.3 档的
// 清单与 Cargo 锁。不要 Blender、不要显卡、不要真库。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CORE, OIDN_BUILDS, OIDN_LOCK, verifyOidnLibs } from './build.mjs';
import { compare, flipRows, readBlenderExr } from './oidn-parity.mjs';

test('判据：暗处看绝对差 1e-3，亮处看相对差 1e-3；最大绝对差与相对差照实记', () => {
  assert.equal(compare(new Float32Array([0.5009, 0, 0]), new Float32Array([0.5, 0, 0]), 1).pass, true);
  assert.equal(compare(new Float32Array([0.5011, 0, 0]), new Float32Array([0.5, 0, 0]), 1).pass, false);
  const bright = compare(new Float32Array([10.009, 0, 0]), new Float32Array([10, 0, 0]), 1);
  assert.equal(bright.pass, true);
  assert.ok(Math.abs(bright.maxAbs - 0.009) < 1e-5 && Math.abs(bright.maxRel - 0.0009) < 1e-6);
  assert.equal(compare(new Float32Array([NaN, 0, 0]), new Float32Array([1, 0, 0]), 1).pass, false);
});

test('行序翻转：翻两次回到原样，一次把第一行换到最后', () => {
  const px = Float32Array.from({ length: 2 * 3 * 3 }, (_, i) => i);
  const f = flipRows(px, 2, 3);
  assert.deepEqual([...f.slice(0, 6)], [...px.slice(12, 18)]);
  assert.deepEqual(flipRows(f, 2, 3), px);
});

test('读 Blender 的 EXR：不是 EXR、带压缩的都拒绝', () => {
  assert.throws(() => readBlenderExr(Buffer.alloc(16)), /不是 EXR/);
  const attr = (name, type, value) => Buffer.concat([Buffer.from(`${name}\0${type}\0`), Buffer.from(Int32Array.of(value.length).buffer), value]);
  const box = Buffer.from(Int32Array.of(0, 0, 0, 0).buffer);
  const head = Buffer.concat([Buffer.from(Int32Array.of(20000630, 2).buffer), attr('channels', 'chlist', Buffer.concat([Buffer.from('R\0'), Buffer.from(Int32Array.of(2, 0, 1, 1).buffer), Buffer.from([0])])), attr('compression', 'compression', Buffer.from([3])), attr('dataWindow', 'box2i', box), Buffer.from([0])]);
  assert.throws(() => readBlenderExr(head), /压缩方式 3/);
});

/** 锁文件某一档在这个平台的一项：库目录里放同名的假文件，内容对不上、多一个报 env.lib-mismatch，少一个报 env.missing-tool */
function lockCase(t, build) {
  const lock = JSON.parse(fs.readFileSync(OIDN_LOCK, 'utf8'));
  const platform = `${process.platform}-${process.arch}`;
  const entry = (build === 'oidn' ? lock : lock[build]).platforms[platform];
  if (!entry) {
    // 没有这一项时照样核对：报 env.missing-tool，不去找库
    assert.throws(() => verifyOidnLibs({ BEIMING_OIDN_LIB: os.tmpdir() }, build), e => e.missing && e.code === 'env.missing-tool' && e.message.includes(platform));
    return t.skip(`锁文件的 ${build} 档没有 ${platform} 这一项（${build === 'oidn23' ? 'Blender 4.5 只在 linux-x64 上' : '这个平台没有登记'}），只核了报码`);
  }
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-oidn-lock-')), 'lib');
  fs.mkdirSync(dir);
  try {
    for (const f of Object.keys(entry.files)) fs.writeFileSync(path.join(dir, f), 'x');
    const err = (() => { try { verifyOidnLibs({ BEIMING_OIDN_LIB: dir }, build); } catch (e) { return e; } })();
    assert.ok(err?.missing && err.code === 'env.lib-mismatch');
    assert.match(err.message, /sha256 对不上/);
    fs.writeFileSync(path.join(dir, 'libOpenImageDenoise_device_extra.so'), 'x');
    assert.throws(() => verifyOidnLibs({ BEIMING_OIDN_LIB: dir }, build), e => e.code === 'env.lib-mismatch' && /锁文件里没有 libOpenImageDenoise_device_extra\.so/.test(e.message));
    fs.rmSync(path.join(dir, Object.keys(entry.files)[0]));
    assert.throws(() => verifyOidnLibs({ BEIMING_OIDN_LIB: dir }, build), e => e.missing && e.code === 'env.missing-tool' && new RegExp(`缺 ${Object.keys(entry.files)[0].replace(/\./g, '\\.')}`).test(e.message));
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
}

test('OIDN 库的锁文件（OIDN 2.5 档）：内容对不上、多一个报 env.lib-mismatch，少一个报 env.missing-tool', t => lockCase(t, 'oidn'));

test('OIDN 库的锁文件（OIDN 2.3 档 oidn23）：同样的报码；没有的构建档直接拒绝', t => {
  assert.throws(() => verifyOidnLibs({}, 'oidn24'), /没有 oidn24 这个 OIDN 构建档/);
  lockCase(t, 'oidn23');
});

test('OIDN 2.3 档的清单与 Cargo 锁：照 path/Cargo.toml 改出来的清单只换 oidn 的版本与特性名，Cargo-oidn23.lock 只差 oidn 一个包', () => {
  const spec = OIDN_BUILDS.oidn23;
  let toml = fs.readFileSync(path.join(CORE, 'path', 'Cargo.toml'), 'utf8');
  for (const { file, from, to } of spec.manifest) {
    assert.equal(file, 'path/Cargo.toml');
    assert.equal(toml.split(from).length, 2, `Cargo.toml 里「${from}」要恰好一次`);
    toml = toml.replace(from, to);
  }
  assert.match(toml, /^oidn = \{ version = "=2\.3\.3", optional = true \}$/m);
  assert.match(toml, /^oidn23 = \["dep:oidn"\]$/m);
  assert.doesNotMatch(toml, /^oidn = \[/m);
  const blocks = file => fs.readFileSync(path.join(CORE, file), 'utf8').split('\n[[package]]\n');
  const oidnOf = bs => bs.find(b => b.startsWith('name = "oidn"\n'));
  const [main, alt] = [blocks('path/Cargo.lock'), blocks(spec.lock)];
  assert.match(oidnOf(alt), /^version = "2\.3\.3"$/m);
  assert.match(oidnOf(main), /^version = "2\.5\.1"$/m);
  assert.deepEqual(alt.filter(b => b !== oidnOf(alt)), main.filter(b => b !== oidnOf(main)), 'path/Cargo.lock 改过之后，Cargo-oidn23.lock 要照它重新生成（见 path/README.md）');
});
