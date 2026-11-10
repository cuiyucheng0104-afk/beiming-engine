// 渲染核心的纯函数回归测试（不启动浏览器、不调 FFmpeg）：
// engine/render/args.mjs 的命令行校验、engine/render/page.mjs 的路径与软件渲染判断、
// engine/core/stroke.js 的退化笔触、engine/core/noise.js 的种子约定。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { UsageError, parseTime, positiveInt, positiveNumber, rangeTimes, takeOptions, timeLabel } from '../../engine/render/args.mjs';
import { chromeArgs, filmRelative, insideRoot, isSoftwareRenderer } from '../../engine/render/page.mjs';
import { inkStroke } from '../../engine/core/stroke.js';
import { createNoise2D, createNoise3D } from '../../engine/core/noise.js';
import { mulberry } from '../../engine/core/math.js';

const usage = fn => assert.throws(fn, e => e instanceof UsageError && e.exitCode === 2);

test('takeOptions：取走已知选项；不认识的选项、缺值报错；写两次以后一次为准', () => {
  const args = ['.', '--out', 'a.mp4', '--fps', '30', '--out', 'b.mp4'];
  assert.deepEqual(takeOptions(args, ['--out', '--fps']), { '--out': 'b.mp4', '--fps': '30' });
  assert.deepEqual(args, ['.']);
  usage(() => takeOptions(['.', '--sizee', '1920x1040'], ['--out']));
  usage(() => takeOptions(['.', '--out'], ['--out']));
  usage(() => takeOptions(['.', '--out', '--fps', '24'], ['--out', '--fps']));
});

test('takeOptions：不带值的开关（--any-fps）取走后记为 true，不吞掉后面的参数', () => {
  const args = ['.', '--any-fps', '--fps', '30'];
  assert.deepEqual(takeOptions(args, ['--fps'], { flags: ['--any-fps'] }), { '--any-fps': true, '--fps': '30' });
  assert.deepEqual(args, ['.']);
  assert.deepEqual(takeOptions(['.'], ['--fps'], { flags: ['--any-fps'] }), {});
  usage(() => takeOptions(['.', '--any-fps'], ['--fps']));   // 没登记为开关时仍是不认识的选项
});

test('filmRelative：经链接进仓库认得出；仓库里指向仓库外的影片目录照样算仓库内；仓库外的链接指回仓库内也认得出', { skip: process.platform === 'win32' && '需要创建符号链接的权限' }, () => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'beiming-rel-')));
  try {
    const root = path.join(base, 'repo'), outside = path.join(base, 'outside', 'film');
    mkdirSync(path.join(root, 'films', 'a'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, path.join(root, 'films', 'ext'));          // 仓库内的影片目录是指向仓库外的链接
    symlinkSync(root, path.join(base, 'link'));                      // 经链接进入仓库（Windows 目录联接同理）
    symlinkSync(path.join(root, 'films', 'a'), path.join(base, 'in')); // 仓库外的链接指回仓库内
    const rel = d => filmRelative(d, root);
    assert.equal(rel(root), '');
    assert.equal(rel(path.join(root, 'films', 'a')), path.join('films', 'a'));
    assert.equal(rel(path.join(root, 'films', 'ext')), path.join('films', 'ext'));
    assert.equal(rel(path.join(base, 'link', 'films', 'ext')), path.join('films', 'ext'));
    assert.equal(rel(path.join(base, 'link')), '');
    assert.equal(rel(path.join(base, 'in')), path.join('films', 'a'));
    assert.equal(rel(path.join(root, 'films', 'nope')), path.join('films', 'nope'));
    for (const d of [outside, base, path.join(base, 'outside')]) assert.equal(insideRoot(rel(d)), false, d);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('数值参数：--workers 正整数、--fps 正数、时刻是非负秒数', () => {
  assert.equal(positiveInt('8', '--workers'), 8);
  for (const bad of ['0', 'abc', '2.5', '-1', '']) usage(() => positiveInt(bad, '--workers'));
  assert.equal(positiveNumber('23.976', '--fps'), 23.976);
  for (const bad of ['0', 'abc', '-24', '', 'Infinity']) usage(() => positiveNumber(bad, '--fps'));
  assert.equal(parseTime('9.95'), 9.95);
  for (const bad of ['abc', '--sizee', '1920x1040', '-1', 'NaN', '']) usage(() => parseTime(bad));
});

test('--range：步长为 0 / 负数 / 漏写都报错，不会死循环或只出一张', () => {
  for (const bad of ['0:9.5:0', '0:9.5:-0.5', '0:9.5', '0:9.5:', 'a:b:c', '9.5:0:0.5', '0:1:0.00001']) usage(() => rangeTimes(bad));
});

test('--range：按整数下标生成，标签兼容两位小数，非整格时刻不取整', () => {
  const r = rangeTimes('0:9.5:0.5');
  assert.equal(r.length, 20);
  assert.deepEqual(r.map(x => x.label).slice(0, 3), ['0.00', '0.50', '1.00']);
  assert.equal(r.at(-1).label, '9.50');
  assert.ok(r.every(x => x.t === Number(x.label)));
  const g = rangeTimes('0:0.2:0.0416667');
  assert.deepEqual(g.map(x => x.label), ['0.00', '0.0416667', '0.0833334', '0.1250001', '0.1666668']);
  assert.ok(Math.abs(g[1].t - 0.0416667) < 1e-12, '按原值渲，不取整到 0.04');
  const tenth = rangeTimes('0:1:0.1');
  assert.equal(tenth[3].t, 0.3, '0.30000000000000004 这类浮点尾巴被消掉');
  assert.equal(new Set(tenth.map(x => x.label)).size, tenth.length);
  assert.equal(timeLabel(1 / 24), '0.041666667');
  assert.equal(timeLabel(0.125), '0.125');
});

test('insideRoot：..draft 在根内；..、../x、绝对路径在外', () => {
  assert.equal(insideRoot(''), true);
  assert.equal(insideRoot('..draft'), true);
  assert.equal(insideRoot(`..draft${path.sep}film`), true);
  assert.equal(insideRoot('..'), false);
  assert.equal(insideRoot(`..${path.sep}x`), false);
  assert.equal(insideRoot(path.resolve('/elsewhere')), false);
});

test('软件渲染识别覆盖 SwiftShader、llvmpipe 与 Windows WARP；硬件 GPU 不误报', () => {
  for (const name of ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0)), SwiftShader driver)', 'llvmpipe (LLVM 15.0.7, 256 bits)',
    'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)', 'WARP']) assert.equal(isSoftwareRenderer(name), true, name);
  for (const name of ['ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Unspecified Version)', 'ANGLE (NVIDIA, Vulkan 1.3.289 (NVIDIA GeForce RTX 5090 (0x00002B85)), NVIDIA)', '']) {
    assert.equal(isSoftwareRenderer(name), false, name);
  }
  assert.deepEqual(chromeArgs('vulkan').slice(0, 1), ['--use-angle=vulkan']);
  assert.ok(!chromeArgs('default').some(a => a.startsWith('--use-angle')));
});

// 非零环绕规则下点是否被填充
const filled = (poly, x, y) => {
  let w = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length], c = (x2 - x1) * (y - y1) - (x - x1) * (y2 - y1);
    if (y1 <= y) { if (y2 > y && c > 0) w++; } else if (y2 <= y && c < 0) w--;
  }
  return w !== 0;
};
const bbox = poly => [Math.min(...poly.map(p => p[0])), Math.max(...poly.map(p => p[0])), Math.min(...poly.map(p => p[1])), Math.max(...poly.map(p => p[1]))];

test('单点笔触画成整圆（不是朝 +x 的半圆）', () => {
  const poly = inkStroke([[10, 10, 0.5]], { size: 8 });
  const [x0, x1, y0, y1] = bbox(poly);
  assert.ok(Math.abs(x0 - 6) < 1e-9 && Math.abs(x1 - 14) < 1e-9 && Math.abs(y0 - 6) < 1e-9 && Math.abs(y1 - 14) < 1e-9, bbox(poly).join());
  for (const [x, y] of [[7, 10], [13, 10], [10, 7], [10, 13]]) assert.ok(filled(poly, x, y), `${x},${y}`);
});

test('streamline 0 时末端仍是背向笔触的圆头：向左、向上都对', () => {
  const left = inkStroke([[100, 50, 0.5], [50, 50, 0.5], [0, 50, 0.5]], { size: 8, streamline: 0 });
  assert.ok(Math.abs(bbox(left)[0] + 4) < 1e-9, '向左画的末端圆头伸到 x = -4');
  assert.ok(filled(left, -2, 50));
  const up = inkStroke([[50, 100, 0.5], [50, 50, 0.5], [50, 0, 0.5]], { size: 8, streamline: 0 });
  for (const [x, y] of [[52, -2], [48, -2], [50, -3]]) assert.ok(filled(up, x, y), `${x},${y}：圆头左右对称`);
});

test('非退化笔触的轮廓与修改前逐位一致（墨线、默认参数、导航线式短末段）', () => {
  const wave = n => Array.from({ length: n }, (_, i) => [i * 3.1, 40 + 12 * Math.sin(i * 0.37), 0.5 + 0.4 * Math.sin(i * 0.21)]);
  const hash = poly => createHash('sha256').update(JSON.stringify(poly.map(p => p.map(v => v.toFixed(9))))).digest('hex').slice(0, 16);
  // 期望值用修改前的 engine/core/stroke.js 算出
  assert.equal(hash(inkStroke(wave(40), { size: 5.2, thinning: 0.62, streamline: 0.16, start: { taper: 36 }, end: { taper: 36 } })), 'b5eaf7ff9d2780c9');
  assert.equal(hash(inkStroke(wave(25), { size: 8 })), '91f86fce629f5ac9');
  assert.equal(hash(inkStroke([[0, 0, 1], [20, 5, 0.8], [40, 12, 0.6], [40.1, 12.05, 0.5]], { size: 9.6, thinning: 0.8, streamline: 0 })), '33fc3898c694f1d6');
});

test('噪声必须给确定性随机函数；同一种子得到同一张噪声场', () => {
  assert.throws(() => createNoise2D(), TypeError);
  assert.throws(() => createNoise3D(), TypeError);
  assert.throws(() => createNoise3D(7), TypeError);
  const a = createNoise2D(mulberry(52511)), b = createNoise2D(mulberry(52511));
  assert.equal(a(0.37, 1.21), b(0.37, 1.21));
  assert.equal(createNoise3D(mulberry(7))(0.1, 0.2, 0.3), createNoise3D(mulberry(7))(0.1, 0.2, 0.3));
});
