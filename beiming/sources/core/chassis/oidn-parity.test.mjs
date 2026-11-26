// 对拍脚本 oidn-parity.mjs 的纯逻辑：判据、行序翻转、读 Blender 多部件 EXR 时拒绝别的写法，与 OIDN 库的锁文件核对。不要 Blender、不要显卡。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { OIDN_LOCK, verifyOidnLibs } from './build.mjs';
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

test('OIDN 库的锁文件：目录里多一个、少一个、内容对不上都报 env 类的错', t => {
  const entry = JSON.parse(fs.readFileSync(OIDN_LOCK, 'utf8')).platforms[`${process.platform}-${process.arch}`];
  if (!entry) return t.skip('锁文件里没有这个平台');
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-oidn-lock-')), 'lib');
  fs.mkdirSync(dir);
  try {
    for (const f of Object.keys(entry.files)) fs.writeFileSync(path.join(dir, f), 'x');
    const err = (() => { try { verifyOidnLibs({ BEIMING_OIDN_LIB: dir }); } catch (e) { return e; } })();
    assert.ok(err?.missing && err.code === 'env.missing-tool');
    assert.match(err.message, /sha256 对不上/);
    fs.writeFileSync(path.join(dir, 'libOpenImageDenoise_device_extra.so'), 'x');
    assert.throws(() => verifyOidnLibs({ BEIMING_OIDN_LIB: dir }), /锁文件里没有 libOpenImageDenoise_device_extra\.so/);
    fs.rmSync(path.join(dir, Object.keys(entry.files)[0]));
    assert.throws(() => verifyOidnLibs({ BEIMING_OIDN_LIB: dir }), new RegExp(`缺 ${Object.keys(entry.files)[0].replace(/\./g, '\\.')}`));
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});
