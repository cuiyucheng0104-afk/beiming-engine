// 原生宿主的三个小工具：出层目录转多层 EXR（passes-exr.mjs）、场景包的内容摘要（rerender.mjs）、显卡上限全文
// （limits.mjs 读 core-render info --limits）。前两样不要显卡；第三样只用编好的那份程序，没有或拿不到显卡就跳过（不现编）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { OUT, sourceKey } from './build.mjs';
import { readLimits, rendererBin } from './limits.mjs';
import { passesToExr, readPasses } from './passes-exr.mjs';
import { checkPack, packDigest } from './rerender.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-host-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const EXE = process.platform === 'win32' ? '.exe' : '';

// 输出通道契约 3.1 的登记表：core 交的六个固定通道和各自分量的次序
const CONTRACT = { color: ['R', 'G', 'B', 'A'], depth: ['Z'], objectId: ['id', 'coverage'], normal: ['X', 'Y', 'Z'], denoiseAlbedo: ['R', 'G', 'B'], denoiseNormal: ['X', 'Y', 'Z'] };

/** 照 core-render write_passes 的写法造一个出层目录：每个分量的值是「通道序号 × 100 + 分量序号 + 像素序号 / 1000」 */
function fakePasses(dir, [w, h]) {
  fs.mkdirSync(dir, { recursive: true });
  const n = w * h, channels = [];
  Object.entries(CONTRACT).forEach(([name, comps], c) => {
    const types = comps.map(x => (name === 'objectId' && x === 'id' ? 'u32' : 'f32'));
    channels.push({ name, components: comps.map((x, j) => ({ name: x, type: types[j] })), colorSpace: 'none', sample: 'sub0', antialiased: false });
    const files = new Map();
    comps.forEach((x, j) => {
      const file = types[j] === types[0] ? `${name}.${types[j]}` : `${name}.${x}.${types[j]}`;
      if (!files.has(file)) files.set(file, []);
      files.get(file).push(j);
    });
    for (const [file, js] of files) {
      const T = file.endsWith('.u32') ? Uint32Array : Float32Array;
      const data = new T(n * js.length);
      for (let i = 0; i < n; i++) js.forEach((j, k) => { data[i * js.length + k] = T === Uint32Array ? c * 100 + j + i : c * 100 + j + i / 1000; });
      fs.writeFileSync(path.join(dir, file), Buffer.from(data.buffer));
    }
  });
  fs.writeFileSync(path.join(dir, 'passes.json'), JSON.stringify({ format: 'passes/0.1', channels }));
}

test('出层目录转 EXR：通道名照契约逐项、读回逐位相同、分量拆对了', () => {
  const dir = path.join(TMP, 'passes'), size = [5, 3];
  fakePasses(dir, size);
  const r = passesToExr(dir, size, { compression: 2 });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.names, Object.entries(CONTRACT).flatMap(([n, cs]) => cs.map(c => `${n}.${c}`)).sort());
  const { channels } = readPasses(dir, size);
  assert.equal(channels['objectId.id'].constructor, Uint32Array);
  assert.deepEqual([...channels['objectId.id'].slice(0, 3)], [200, 201, 202]);
  assert.equal(channels['color.B'][4], Math.fround(2 + 4 / 1000));
  assert.equal(channels['objectId.coverage'][1], Math.fround(201 + 1 / 1000));
});

test('出层目录转 EXR：尺寸不对、通道名不在登记表里都报出来', () => {
  const dir = path.join(TMP, 'bad'), size = [4, 2];
  fakePasses(dir, size);
  assert.throws(() => readPasses(dir, [3, 2]), /有 8 个像素/);
  const t = JSON.parse(fs.readFileSync(path.join(dir, 'passes.json'), 'utf8'));
  t.channels[1].name = 'zdepth';
  fs.writeFileSync(path.join(dir, 'passes.json'), JSON.stringify(t));
  fs.copyFileSync(path.join(dir, 'depth.f32'), path.join(dir, 'zdepth.f32'));
  assert.match(passesToExr(dir, size).problems.join(), /zdepth\.Z 不在输出通道契约的登记表里/);
});

test('负对照：写好 EXR 之后改坏一个通道的一个字节，往返比较必须报出来', () => {
  const dir = path.join(TMP, 'tamper'), size = [4, 3];
  fakePasses(dir, size);
  // 不压缩时文件的最后一个字节是最后一条扫描线里最后一个通道的最后一个像素
  const r = passesToExr(dir, size, { tamper: b => { b[b.length - 1] ^= 1; return b; } });
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /^\S+ 往返不逐位相同$/);
});

test('负对照：两遍里第二遍改了一个通道文件，same 为假、differ 正好列出它（假程序，不渲）', { skip: process.platform === 'win32' && '假程序是带 #! 的脚本' }, () => {
  const tpl = path.join(TMP, 'fake-passes'), size = [3, 2];
  fakePasses(tpl, size);
  const pack = path.join(TMP, 'fake-pack');
  fs.mkdirSync(pack, { recursive: true });
  fs.writeFileSync(path.join(pack, 'pack.json'), JSON.stringify({ id: 'pack:fake@1', frames: { count: 2 } }));
  // 照 render-pack 的参数写 PNG、线性颜色与出层；第二次调用时把 depth.f32 的第一个字节改掉
  const bin = path.join(TMP, 'fake-render.cjs');
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2), get = k => a[a.indexOf(k) + 1];
const count = path.join(__dirname, 'fake-render.count');
const n = fs.existsSync(count) ? Number(fs.readFileSync(count, 'utf8')) : 0;
fs.writeFileSync(count, String(n + 1));
fs.writeFileSync(get('-o'), 'png');
fs.writeFileSync(get('--hdr'), 'hdr');
fs.cpSync(${JSON.stringify(tpl)}, get('--passes'), { recursive: true });
if (n === 1) { const f = path.join(get('--passes'), 'depth.f32'), b = fs.readFileSync(f); b[0] ^= 1; fs.writeFileSync(f, b); }
console.log(JSON.stringify({ hwrt: false, denoise: 'atrous', timings_ms: { trace_ms: 1 } }));
`, { mode: 0o755 });
  const item = checkPack(bin, pack, path.join(TMP, 'fake-work'), { frame: 0, spp: 1, size, seed: 0, modes: ['sw'] });
  assert.equal(item.modes.sw.same, false);
  assert.deepEqual(item.modes.sw.differ, ['passes/depth.f32']);
  assert.equal(item.exr.roundTrip, true);
});

test('场景包的内容摘要：与目录在哪无关，改一个字节就变', () => {
  const a = path.join(TMP, 'pa'), b = path.join(TMP, 'pb');
  for (const d of [a, b]) {
    fs.mkdirSync(path.join(d, 'frames'), { recursive: true });
    fs.writeFileSync(path.join(d, 'pack.json'), '{}');
    fs.writeFileSync(path.join(d, 'frames', 'camera.f32'), Buffer.alloc(8));
  }
  assert.equal(packDigest(a), packDigest(b));
  fs.writeFileSync(path.join(b, 'frames', 'camera.f32'), Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]));
  assert.notEqual(packDigest(a), packDigest(b));
});

test('记录里的程序：给了程序时 kernel 取它文件名里的摘要，取不到是 null，sha256 是文件本身的', () => {
  const named = path.join(TMP, `core-render-0123456789abcdef${EXE}`), other = path.join(TMP, 'my-render');
  fs.writeFileSync(named, 'a');
  fs.writeFileSync(other, 'a');
  assert.deepEqual(rendererBin(named), { bin: named, key: '0123456789abcdef', sha256: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb' });
  assert.equal(rendererBin(other).key, null);
});

test('info --limits：适配器与设备的上限同一套键，设备的特性都在适配器的里面', t => {
  const bin = path.join(OUT, 'bin', `core-render-${sourceKey([])}${EXE}`);
  if (!fs.existsSync(bin)) return t.skip('没有编好的渲染程序');
  let r;
  try {
    r = readLimits(bin);
  } catch (e) {
    return t.skip(`拿不到显卡：${e.message}`);
  }
  assert.equal(r.format, 'core-limits/0.1');
  assert.deepEqual(Object.keys(r.deviceLimits).sort(), Object.keys(r.adapterLimits).sort());
  assert.ok(Object.values(r.deviceLimits).every(Number.isInteger));
  assert.ok(r.deviceFeatures.every(f => r.adapterFeatures.includes(f)));
  assert.equal(r.deviceLimits.max_storage_buffer_binding_size, r.adapterLimits.max_storage_buffer_binding_size);
});
