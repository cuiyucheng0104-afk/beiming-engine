// 底板准入：node --test tests/style/plates.test.mjs
// 用合成的小 PNG 当夹具（仓库外的临时目录），验证 PNG 读写、四边 alpha 分析（硬边、直线淡出、有机外形）、
// 登记表校验、纹素密度与出血公式；最后对仓库真实的 13 张底板跑一遍准入检查。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodePng, decodePng, readPngInfo, PngError } from '../../tools/plates/png.mjs';
import { analyzeEdges } from '../../tools/plates/edges.mjs';
import { validateEntry, checkPlates, density, policyOf } from '../../tools/plates/lib.mjs';
import { bleed } from '../../tools/plates/bleed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const W = 240, H = 240;
// alpha(x, y) → 0..255，颜色固定
function img(alpha) {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const o = (y * W + x) * 4; data[o] = 200; data[o + 1] = 160; data[o + 2] = 220; data[o + 3] = alpha(x, y); }
  return { width: W, height: H, data };
}
const clamp255 = v => Math.max(0, Math.min(255, Math.round(v)));
// 有机外形：轮廓带起伏的椭圆（像一团云），软边，四边都淡到 0
const blob = (cx, a, x, y) => {
  const dx = (x - cx) / a, dy = (y - H / 2) / (H * 0.38), th = Math.atan2(dy, dx);
  return clamp255((1 - Math.hypot(dx, dy) / (1 + 0.12 * Math.sin(5 * th) + 0.07 * Math.sin(11 * th + 1))) / 0.25 * 255);
};
const organic = img((x, y) => blob(W / 2, W * 0.35, x, y));
// 一团比图还宽的云，左端被画幅截断后做了直线淡出（所有行都在 x = 30 附近淡出）——审计 CRAFT-03 的那种边
const straightLeft = img((x, y) => Math.round(blob(W * 0.3, W * 0.45, x, y) * Math.max(0, Math.min(1, (x - 20) / 20))));
// 右边贴着图边仍不透明
const hardRight = img((x, y) => (x > W * 0.3 ? 255 : 0));

test('PNG：编码后再解码逐字节一致；文件头信息；坏文件报 PngError', () => {
  const buf = encodePng(straightLeft);
  const back = decodePng(buf);
  assert.equal(back.width, W); assert.equal(back.height, H);
  assert.deepEqual(Buffer.from(back.data), Buffer.from(straightLeft.data));
  const info = readPngInfo(buf);
  assert.equal(info.colorType, 6); assert.equal(info.bitDepth, 8); assert.equal(info.interlace, 0);
  assert.throws(() => readPngInfo(Buffer.from('not a png')), PngError);
  assert.throws(() => decodePng(buf.subarray(0, 40)), PngError);
  const gray = encodePng({ width: 4, height: 2, channels: 1, data: Uint8Array.from([0, 64, 128, 255, 1, 2, 3, 4]) });
  assert.deepEqual([...decodePng(gray).data.subarray(0, 8)], [0, 0, 0, 255, 64, 64, 64, 255]);
});

test('四边分析：直线淡出、硬边、有机外形各自认得出', () => {
  const a = analyzeEdges(straightLeft).sides;
  assert.equal(a.left.straight, true, '左端直线淡出');
  assert.equal(a.left.hard, false);
  assert.ok(a.left.median >= 25 && a.left.median <= 35);
  for (const s of ['right', 'top', 'bottom']) assert.equal(a[s].straight || a[s].hard, false, `截断的只有左端，${s} 是有机外形`);
  const o = analyzeEdges(organic);
  assert.equal(o.opaque, false);
  for (const s of ['left', 'right', 'top', 'bottom']) { assert.equal(o.sides[s].hard, false, s); assert.equal(o.sides[s].straight, false, `${s} 是有机外形`); }
  const h = analyzeEdges(hardRight).sides;
  assert.equal(h.right.hard, true);
  assert.equal(analyzeEdges(img(() => 255)).opaque, true);
});

test('登记字段：必填、取值、waived 要写理由；大写名字只提示', () => {
  const ok = { name: 'cloud_a', file: 'cloud_a.png', size: [W, H], transparent: true, colorSpace: 'srgb', edgePolicy: 'natural' };
  assert.deepEqual(validateEntry(ok), { errors: [], warnings: [] });
  assert.match(validateEntry({ ...ok, edgePolicy: undefined }).errors.join(), /edgePolicy 必填/);
  assert.match(validateEntry({ ...ok, edgePolicy: { left: 'offscreen', right: 'natural', top: 'natural' } }).errors.join(), /edgePolicy\.bottom/);
  assert.match(validateEntry({ ...ok, edgePolicy: 'waived' }).errors.join(), /edgeNote/);
  assert.match(validateEntry({ ...ok, colorSpace: 'linear' }).errors.join(), /colorSpace/);
  assert.match(validateEntry({ ...ok, name: '云 a' }).errors.join(), /ASCII/);
  assert.equal(validateEntry({ ...ok, name: 'shotB_sky' }).errors.length, 0);
  assert.equal(validateEntry({ ...ok, name: 'shotB_sky' }).warnings.length, 1);
  assert.equal(policyOf({ edgePolicy: { left: 'covered' } }, 'left'), 'covered');
});

test('来源链与原图尺寸：AI 底板必须写「来源」八个字段（可写「待补」）；sourceSize × upscale 要对得上 size', () => {
  const ok = { name: 'sky_x', file: 'sky_x.png', size: [3548, 1774], transparent: false, colorSpace: 'srgb', edgePolicy: 'offscreen' };
  const src = { 工具: '待补', 模型: '待补', 日期: '待补', 提示词: '待补', 参考图: 'assets/ref/sky_test.png', 原图sha256: '待补', 操作: '待补', 人工修改: ['×2 放大'] };
  assert.match(validateEntry({ ...ok, aigc: true }).errors.join(), /要写「来源」/);
  assert.deepEqual(validateEntry({ ...ok, aigc: true, 来源: src, sourceSize: [1774, 887], upscale: { factor: 2, method: '待补' } }).errors, []);
  const { 模型: _drop, ...noModel } = src;
  assert.match(validateEntry({ ...ok, aigc: true, 来源: noModel }).errors.join(), /缺字段「模型」/);
  assert.match(validateEntry({ ...ok, aigc: true, 来源: { ...src, 原图sha256: 'abc' } }).errors.join(), /64 位/);
  assert.match(validateEntry({ ...ok, sourceSize: [1000, 500], upscale: { factor: 2, method: 'x' } }).errors.join(), /不等于 sourceSize/);
  assert.match(validateEntry({ ...ok, sourceSize: [1774, 887], upscale: null }).errors.join(), /写了没放大/);
  assert.match(validateEntry({ ...ok, upscale: { factor: 2, method: 'x' } }).errors.join(), /要写 sourceSize/);
  assert.equal(validateEntry({ ...ok, aigc: true, 来源: src }).warnings.length, 1, '没写 sourceSize 只提示');
  // 细节密度按原图算，只报告不判定
  const e = { ...ok, sourceSize: [1774, 887], upscale: { factor: 2, method: '待补' }, usage: [{ where: 's1', screenWidth: 2688, designHeight: 1080 }] };
  const d = density(e, { 'web-1080p24': { width: 1920, height: 1080 } })[0];
  assert.equal(d.level, 'ok'); assert.ok(Math.abs(d.detailPerPx - 0.66) < 0.01);
});

test('准入：直线淡出的边写 natural 不行；写 organic-mask 可以；尺寸不符报错', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-plates-'));
  try {
    fs.writeFileSync(path.join(d, 'cloud_a.png'), encodePng(straightLeft));
    fs.writeFileSync(path.join(d, 'blob.png'), encodePng(organic));
    const reg = plates => { const f = path.join(d, 'plates.json'); fs.writeFileSync(f, JSON.stringify({ plates })); return f; };
    const base = { file: 'cloud_a.png', size: [W, H], transparent: true, colorSpace: 'srgb' };
    let r = checkPlates(reg([{ name: 'cloud_a', ...base, edgePolicy: 'natural' }]));
    assert.match(r.errors.join(), /左边直线淡出/);
    r = checkPlates(reg([{ name: 'cloud_a', ...base, edgePolicy: { left: 'organic-mask', right: 'natural', top: 'natural', bottom: 'natural' } }, { name: 'blob', file: 'blob.png', size: [W, H], transparent: true, colorSpace: 'srgb', edgePolicy: 'natural' }]));
    assert.deepEqual(r.errors, []);
    r = checkPlates(reg([{ name: 'cloud_a', ...base, size: [W + 2, H], edgePolicy: 'offscreen' }]));
    assert.match(r.errors.join(), /实际 240×240/);
    r = checkPlates(reg([{ name: 'gone', ...base, file: 'gone.png', edgePolicy: 'offscreen' }]));
    assert.match(r.errors.join(), /不存在/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('纹素密度：按档位算，低于 1.0 提示、低于 0.6 失败；写了 profiles 只算那些档位', () => {
  const e = { size: [3548, 1774], usage: [{ where: 's1', screenWidth: 2688, designHeight: 1080 }] };
  const P = { 'web-1080p24': { width: 1920, height: 1080 }, 'uhd-2160p24': { width: 3840, height: 2160 }, x: { width: 7680, height: 4320 } };
  const d = Object.fromEntries(density(e, P).map(v => [v.profile, v]));
  assert.equal(d['web-1080p24'].level, 'ok'); assert.ok(Math.abs(d['web-1080p24'].texelPerPx - 1.32) < 0.01);
  assert.equal(d['uhd-2160p24'].level, 'warn');
  assert.equal(d.x.level, 'fail');
  assert.equal(density({ ...e, usage: [{ ...e.usage[0], profiles: ['web-1080p24'] }] }, P).length, 1);
});

test('出血公式：复算 craft/two-five-d.md §2.1 的镜头 A 拉镜算例（river 层约 40.7 px）', () => {
  const f = 3700, fov = 2 * Math.atan(520 / f) * 180 / Math.PI;
  const r = bleed({ D: 1450, fov, tx: 4, tz: -46, W: 1920, H: 1040 });
  assert.ok(Math.abs(r.leftRight.o - 40.7) < 0.3, `左右 o = ${r.leftRight.o}`);
  const push = bleed({ D: 1450, fov, tx: 4, tz: 46.016, W: 1920, H: 1040 });
  assert.ok(push.leftRight.o < 0, '推镜时扩张抵扣大于平移，不需要出血');
  assert.equal(push.leftRight.total, 16, '只剩安全余量 16 px');
});

test('仓库的 13 张底板全部通过准入（逐像素）；命令行退出码合约', () => {
  const r = checkPlates(path.join(ROOT, 'assets/plates/plates.json'));
  assert.deepEqual(r.errors, []);
  assert.equal(r.plates.length, 13);
  const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/plates/plates.json'), 'utf8'));
  for (const p of reg.plates) {
    assert.ok(p['来源'], `${p.name} 有逐张来源（D11）`);
    assert.ok(Array.isArray(p.sourceSize) && 'upscale' in p, `${p.name} 写了原图尺寸与放大方法（QA-A-004）`);
  }
  const straight = r.plates.filter(p => p.edges && Object.values(p.edges).some(s => s.straight && !s.hard)).map(p => p.name);
  for (const n of ['clouds_front_a', 'clouds_front_b', 'clouds_back']) assert.ok(straight.includes(n), `${n} 应当被标出直线淡出`);
  const cli = a => spawnSync(process.execPath, [path.join(ROOT, 'tools/plates/check.mjs'), ...a], { encoding: 'utf8' });
  assert.equal(cli(['--help']).status, 0);
  assert.equal(cli(['--bogus']).status, 2);
  const j = cli(['--quick', '--json']);
  assert.equal(j.status, 0);
  assert.equal(JSON.parse(j.stdout).ok, true);
});
