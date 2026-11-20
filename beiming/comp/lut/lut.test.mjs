// agx-mhc 查找表的自检。前半不要 Blender：对数整形、sRGB 编码、按 colorRef 分流、.cube 的读法和四面体插值、滤镜链的写法。
// 后半在本机有 Blender 时实跑：烘 65³ 的表，0 到 16 的十二级 HDR 灰阶过整形加查表，逐级对 Blender 自己存图直出的
// AgX Medium High Contrast 显示值；误差限和灰阶取自探针数据表「显示变换的整形曲线」一行，不在这里另定。
// 本机还有 ffmpeg 时，把同一批线性光像素喂给 ffmpegFilter 给出的滤镜链，核对它和 applyShaperAndLut 是同一条算式。
// 烘出的 .cube 和中间文件都在系统临时目录里，跑完删掉；Blender 带 -noaudio，ffmpeg 带 -an。
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import table from '../../calib/table/blender.json' with { type: 'json' };
import { applyShaperAndLut, bakeAgxLut, displayEncode, ffmpegFilter, parseCube, runBlenderJob, SHAPER, shaperEncode, srgbEncode } from './bake-agx.mjs';

const near = (got, want, tol, what) => assert.ok(Math.abs(got - want) <= tol, `${what}：期望 ${want} ± ${tol}，实际 ${got}`);
const code = (c) => (e) => e.code === c;
const gray = (v) => [v, v, v];
/** 0 到 1 的显示值 → 8 位显示码值 */
const to8 = (rgb) => rgb.map((v) => v * 255);
const maxDiff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

/** 写一张 .cube：size³ 个点，红变得最快；at(r, g, b) 给出这个网格点（坐标 0 到 1）的输出 */
function cubeText(size, at) {
  const lines = ['TITLE "test"', `LUT_3D_SIZE ${size}`, 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0'];
  const g = (i) => i / (size - 1);
  for (let b = 0; b < size; b++) for (let gi = 0; gi < size; gi++) for (let r = 0; r < size; r++) lines.push(at(g(r), g(gi), g(b)).map((v) => v.toFixed(6)).join(' '));
  return `${lines.join('\n')}\n`;
}

test('对数整形：0 落在 0，中灰落在分配范围的中点附近，0 到 16 单调递增并且不顶到 1', () => {
  assert.deepEqual(shaperEncode([0, -1, 0]), [0, 0, 0]);
  const span = SHAPER.maxStops - SHAPER.minStops;
  // 三个常数就是探针数据表「显示变换的整形曲线」一行写的：中灰 0.18，−12.47393 到 +12.5260688 档，合 25 档（差 1.2e-6 档）
  assert.deepEqual({ ...SHAPER }, { midGray: 0.18, minStops: -12.47393, maxStops: 12.5260688 });
  near(span, 25, 2e-6, '整形范围，档');
  near(shaperEncode(gray(SHAPER.midGray))[0], -SHAPER.minStops / span, 1e-12, '中灰的整形值');
  // 每亮一档，整形值加 1 / span
  near(shaperEncode(gray(2))[0] - shaperEncode(gray(1))[0], 1 / span, 1e-12, '一档的整形值之差');
  const ramp = [0, ...Array.from({ length: 81 }, (_, k) => 2 ** (-6 + k / 8))].map((v) => shaperEncode(gray(v))[0]);
  for (let i = 1; i < ramp.length; i++) assert.ok(ramp[i] > ramp[i - 1], `整形值在第 ${i} 级没有递增`);
  // 线性 16 离分配范围的上端（约 1061）还有 6 档：整形值 0.758，不顶到 1
  near(shaperEncode(gray(16))[0], (Math.log2(16 / 0.18) + 12.47393) / span, 1e-12, '线性 16 的整形值');
  assert.ok(shaperEncode(gray(16))[0] < 0.8);
  assert.deepEqual(shaperEncode([1e-9, 1e9, 4]).slice(0, 2), [0, 1]);
  // 三个分量各算各的
  assert.deepEqual(shaperEncode([1, 4, 16]), [shaperEncode(gray(1))[0], shaperEncode(gray(4))[0], shaperEncode(gray(16))[0]]);
});

test('sRGB 编码和按 colorRef 分流：display 只做 sRGB 编码，scene 走整形加查表', () => {
  srgbEncode([0, 1, 4]).forEach((v, i) => near(v, [0, 1, 1][i], 1e-15, `sRGB 编码先截到 0 到 1，分量 ${i}`));
  near(srgbEncode(gray(0.18))[0] * 255, 117.6458, 1e-3, '线性 0.18 的 sRGB 码值，8 位显示码值');
  near(srgbEncode(gray(0.002))[0], 12.92 * 0.002, 1e-15, 'sRGB 的直线段');
  near(srgbEncode(gray(0.0031308))[0], 1.055 * 0.0031308 ** (1 / 2.4) - 0.055, 1e-6, 'sRGB 两段在接点上相接');
  assert.deepEqual(displayEncode([0.2, 0.5, 2], 'display'), srgbEncode([0.2, 0.5, 2]));
  const lut = parseCube(cubeText(2, (r, g, b) => [1 - r, 1 - g, 1 - b]));
  assert.deepEqual(displayEncode([0.2, 0.5, 2], 'scene', lut), applyShaperAndLut([0.2, 0.5, 2], lut));
  near(displayEncode(gray(SHAPER.midGray), 'scene', lut)[0], 1 + SHAPER.minStops / (SHAPER.maxStops - SHAPER.minStops), 1e-12, '反相表上的中灰');
  assert.throws(() => displayEncode([0, 0, 0], 'log'), /colorRef/);
});

test('.cube 的读法和查表：红最快、四面体插值、坏文件报错', () => {
  const ident = parseCube(cubeText(5, (r, g, b) => [r, g, b]));
  assert.equal(ident.size, 5);
  assert.equal(ident.data.length, 5 ** 3 * 3);
  // 恒等表上查出来的就是整形值：四面体插值对一次函数是精确的
  for (const rgb of [[0.18, 0.18, 0.18], [3.2, 0.8, 0.4], [0.02, 0.5, 9], [16, 0, 1 / 64]]) {
    const got = applyShaperAndLut(rgb, ident), want = shaperEncode(rgb);
    got.forEach((v, i) => near(v, want[i], 1e-6, `恒等表上 ${rgb} 的分量 ${i}`));
  }
  // 次序：红变得最快。只有红轴亮的表，红分量跟着第一个坐标走
  const order = parseCube(cubeText(2, (r, g, b) => [r, 0.5 * g, 0.25 * b]));
  assert.deepEqual(Array.from(order.data.subarray(3, 6)), [1, 0, 0]);
  assert.deepEqual(Array.from(order.data.subarray(6, 9)), [0, 0.5, 0]);
  // 四面体和三线性在弯的表上不一样：输出 r × g 的 2³ 表，在整形值 (0.5, 0.25, 0) 上四面体是 0.25，三线性是 0.125
  const bent = parseCube(cubeText(2, (r, g) => [r * g, 0, 0]));
  const lin = (t) => SHAPER.midGray * 2 ** (SHAPER.minStops + t * (SHAPER.maxStops - SHAPER.minStops));
  near(applyShaperAndLut([lin(0.5), lin(0.25), 0], bent)[0], 0.25, 1e-9, '四面体插值');
  near(applyShaperAndLut([lin(0.25), lin(0.5), 0], bent)[0], 0.25, 1e-9, '四面体插值（换一条对角线）');

  assert.throws(() => parseCube('0 0 0\n'), /LUT_3D_SIZE/);
  // 数据行写成整数也认
  assert.deepEqual(Array.from(parseCube(`LUT_3D_SIZE 2\n${'0 1 0\n'.repeat(8)}`).data.subarray(0, 3)), [0, 1, 0]);
  assert.throws(() => parseCube('LUT_3D_SIZE 2\n0 0 0\n'), /8 行/);
  assert.throws(() => parseCube(cubeText(2, () => [0, 0, 0]).replace('DOMAIN_MAX 1.0 1.0 1.0', 'DOMAIN_MAX 16.0 16.0 16.0')), /定义域/);
  assert.throws(() => parseCube(cubeText(2, () => [0, 0, 0]).replace('LUT_3D_SIZE 2', 'LUT_1D_SIZE 2')), /不认识的关键字/);
  assert.throws(() => parseCube(cubeText(2, () => [0, 0, 0]).replace('0.000000 0.000000 0.000000', '0.0 nope 0.0')), /行数据/);
});

test('滤镜链的写法：scene 是整形加四面体 lut3d，display 不查表', () => {
  const scene = ffmpegFilter('scene', '/tmp/agx.cube');
  assert.match(scene, /^geq=r='[^']+':g='[^']+':b='[^']+',lut3d=file='\/tmp\/agx\.cube':interp=tetrahedral$/);
  for (const n of [SHAPER.midGray, SHAPER.minStops, SHAPER.maxStops - SHAPER.minStops]) assert.ok(scene.includes(String(n)), `滤镜链里没有整形常数 ${n}`);
  const display = ffmpegFilter('display');
  assert.match(display, /^geq=/);
  assert.ok(!display.includes('lut3d'));
  assert.throws(() => ffmpegFilter('log', '/tmp/agx.cube'), /colorRef/);
  for (const bad of ["/tmp/a'b.cube", ['C:', 'luts', 'agx.cube'].join('\\')]) assert.throws(() => ffmpegFilter('scene', bad), /路径/);
});

test('没有 Blender：报 env.missing-tool；gridSize 不对当场报错', async () => {
  await assert.rejects(() => bakeAgxLut({ blenderBin: null, outPath: join(tmpdir(), 'never-written.cube') }), code('env.missing-tool'));
  assert.throws(() => runBlenderJob(null, { mode: 'direct', values: [], outPath: '' }), code('env.missing-tool'));
  for (const gridSize of [1, 2.5, '33']) await assert.rejects(() => bakeAgxLut({ blenderBin: 'unused', gridSize, outPath: '' }), /gridSize/);
  assert.ok(!existsSync(join(tmpdir(), 'never-written.cube')));
});

test('烘表超时后保留原文件并清理中间文件', { skip: process.platform === 'win32' && 'POSIX shell 启动器' }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'beiming-bake-timeout-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const blenderBin = join(dir, 'launcher'), outPath = join(dir, 'agx.cube');
  await writeFile(blenderBin, '#!/bin/sh\nexec sleep 30\n', { mode: 0o700 });
  await writeFile(outPath, 'previous');
  await assert.rejects(() => bakeAgxLut({ blenderBin, outPath, limitMs: 100 }), /时限 100 毫秒/);
  assert.equal(await readFile(outPath, 'utf8'), 'previous');
  assert.deepEqual((await readdir(dir)).sort(), ['agx.cube', 'launcher']);
});

// 探针数据表里「显示变换的整形曲线」一行：十二级 HDR 灰阶各自的线性值、OCIO 直算的显示值、对数整形加 33³ 表量到的差
const PROBE = table.rows.find((r) => r.row === '显示变换的整形曲线').readings
  .filter((r) => r.what.includes('对数整形后查 33³ 表'))
  .map((r) => ({ linear: Number(/（([\d.]+)）/.exec(r.what)[1]), expected: r.expected, diff: r.diff }));
/** 误差限：探针在这十二级上量到的最大差，8 位显示码值 */
const PROBE_LIMIT = Math.max(...PROBE.map((p) => p.diff));

const onPath = (name) => (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, name));
const BLENDER = (process.env.BEIMING_BLENDER ? [process.env.BEIMING_BLENDER] : ['/Applications/Blender.app/Contents/MacOS/Blender', ...onPath('blender')]).find((p) => existsSync(p));
const FFMPEG = onPath('ffmpeg').find((p) => existsSync(p));
const run = (bin, args) => new Promise((ok, fail) => {
  execFile(bin, args, { timeout: 30000, killSignal: 'SIGKILL' }, (err, _out, stderr) => (err ? fail(new Error(`${bin} 失败：${stderr.trim().split('\n').slice(-4).join(' | ')}`)) : ok()));
});

/** 把一行线性光像素（每个是 [r, g, b]）过 ffmpeg 的滤镜链，读回同样多个像素。输入输出都是 32 位浮点平面格式，平面次序 G、B、R */
async function throughFfmpeg(dir, pixels, filter) {
  const w = pixels.length, raw = Buffer.alloc(w * 3 * 4), inPath = join(dir, 'in.raw'), outPath = join(dir, 'out.raw');
  [1, 2, 0].forEach((c, plane) => pixels.forEach((v, x) => raw.writeFloatLE(v[c], (plane * w + x) * 4)));
  await writeFile(inPath, raw);
  const fmt = ['-f', 'rawvideo', '-pix_fmt', 'gbrpf32le'];
  await run(FFMPEG, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...fmt, '-s', `${w}x1`, '-i', inPath, '-an', '-vf', filter, '-frames:v', '1', ...fmt, outPath]);
  const out = await readFile(outPath);
  assert.equal(out.length, raw.length, 'ffmpeg 交回的字节数');
  return pixels.map((_, x) => [2, 0, 1].map((plane) => out.readFloatLE((plane * w + x) * 4)));
}

test('探针数据表给的灰阶和误差限', () => {
  assert.deepEqual(PROBE.map((p) => p.linear), [0, ...Array.from({ length: 11 }, (_, k) => 2 ** (k - 6))]);
  assert.ok(PROBE_LIMIT > 0 && PROBE_LIMIT < 2, `探针量到的最大差应该在 1 个码值上下，读到 ${PROBE_LIMIT}`);
});

test('实跑：烘 agx-mhc 查找表，十二级 HDR 灰阶逐级对 Blender 直出', { skip: BLENDER ? false : '本机没有 Blender', timeout: 300000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'beiming-lut-test-'));
  try {
    const cube = join(dir, 'agx-mhc.cube');
    const hash = await bakeAgxLut({ blenderBin: BLENDER, outPath: cube });
    assert.match(hash, /^sha256:[0-9a-f]{64}$/);
    const text = await readFile(cube, 'utf8');
    assert.equal(hash, `sha256:${createHash('sha256').update(text).digest('hex')}`, '返回的哈希就是文件全部字节的 SHA-256');
    assert.equal(await bakeAgxLut({ blenderBin: BLENDER, outPath: join(dir, 'again.cube') }), hash, '同一个 Blender 再烘一遍逐字节相同');
    assert.match(text, /^TITLE "agx-mhc"\nLUT_3D_SIZE 65\nDOMAIN_MIN 0\.0 0\.0 0\.0\nDOMAIN_MAX 1\.0 1\.0 1\.0\n/);
    const lut = parseCube(text);
    assert.equal(lut.size, 65);
    assert.ok(lut.data.every((v) => v >= 0 && v <= 1), '表里的显示值都在 0 到 1');
    t.diagnostic(`65³ 的 .cube：${text.length} 字节，${hash}`);
    const small = join(dir, 'small.cube');
    await bakeAgxLut({ blenderBin: BLENDER, gridSize: 5, outPath: small });
    assert.equal(parseCube(await readFile(small, 'utf8')).size, 5);

    // 对照：同一批线性值走 Blender 存图的色彩管理（AgX 加 Medium High Contrast）直出
    const directPath = join(dir, 'direct.json');
    await runBlenderJob(BLENDER, { mode: 'direct', values: PROBE.map((p) => gray(p.linear)), outPath: directPath });
    const direct = JSON.parse(await readFile(directPath, 'utf8')).map(to8);
    assert.equal(direct.length, PROBE.length);
    // 这台机器上的直出先对探针表里 OCIO 直算的显示值：两边是同一份色彩配置，只差 16 位存图的量化（一步 0.0039 个码值）和存图路径的舍入，
    // 给到 0.05 个码值；视图或外观选错会差出几个到几十个码值
    const drift = Math.max(...PROBE.map((p, i) => maxDiff(direct[i], p.expected)));
    t.diagnostic(`Blender 直出对探针表的 OCIO 直算值：最大差 ${drift.toFixed(4)} 个 8 位码值`);
    assert.ok(drift <= 0.05, `Blender 直出和探针表差 ${drift} 个 8 位码值`);

    const through = PROBE.map((p) => to8(applyShaperAndLut(gray(p.linear), lut)));
    PROBE.forEach((p, i) => {
      const diff = maxDiff(through[i], direct[i]);
      t.diagnostic(`线性 ${p.linear}：直出 ${direct[i][0].toFixed(3)}，整形加查表 ${through[i][0].toFixed(3)}，差 ${diff.toFixed(3)} 个 8 位码值（探针限 ${PROBE_LIMIT}）`);
      assert.ok(diff <= PROBE_LIMIT, `线性 ${p.linear} 差 ${diff} 个 8 位码值，超过探针限 ${PROBE_LIMIT}`);
    });

    // 高光不切平：1.0 以上接着往上走。不整形的查法在 1.0 就到头了，1.0 的直出值就是那个切顶值
    const at = (v) => through[PROBE.findIndex((p) => p.linear === v)][0], clipped = direct[PROBE.findIndex((p) => p.linear === 1)][0];
    assert.ok(at(1) < at(2) && at(2) < at(4) && at(4) < at(8) && at(8) <= at(16), `1、2、4、8、16 的显示值没有递增：${[1, 2, 4, 8, 16].map(at)}`);
    assert.ok(at(4) > at(1) + 30 && at(16) > at(4) + 10, `4.0 和 16.0 被切平了：1.0 是 ${at(1)}，4.0 是 ${at(4)}，16.0 是 ${at(16)}`);
    assert.ok(at(4) > clipped + 30 && at(16) > clipped + 40, `4.0、16.0 应该远高于 1.0 的切顶值 ${clipped}`);
    // 0 到 16 细分的灰阶整条不回头
    const ramp = [0, ...Array.from({ length: 161 }, (_, k) => 2 ** (-6 + k / 16))].map((v) => applyShaperAndLut(gray(v), lut)[1]);
    for (let i = 1; i < ramp.length; i++) assert.ok(ramp[i] >= ramp[i - 1], `灰阶第 ${i} 级的显示值回头了`);

    // 三原色与三种二次色跨八档亮度，加测黄色分量开始抬升的折点。
    const mixtures = [[3.2, 0.8, 0.4], [0.05, 1, 0.3], [0.3, 0.05, 1]];
    const primaries = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, 0, 1], [0, 1, 1]];
    const tints = [...mixtures, [0.4, 0.4, 0], ...[0.125, 0.25, 0.5, 1, 2, 4, 8, 16].flatMap((v) => primaries.map((rgb) => rgb.map((c) => c * v)))];
    await runBlenderJob(BLENDER, { mode: 'direct', values: tints, outPath: directPath });
    const tintDirect = JSON.parse(await readFile(directPath, 'utf8')).map(to8);
    const diffs = tints.map((rgb, i) => maxDiff(to8(applyShaperAndLut(rgb, lut)), tintDirect[i]));
    // 独立复核量到 33³ 的饱和样本误差达 12.36，折点达 14.90 个码值。
    t.diagnostic(`彩色 ${tints.length} 项最大差 ${Math.max(...diffs).toFixed(3)}，(0.4, 0.4, 0) 差 ${diffs[mixtures.length].toFixed(3)} 个 8 位码值`);
    assert.ok(diffs[mixtures.length] <= 1, '黄色折点偏离 Blender 直出超过 1 个码值');
    diffs.forEach((diff, i) => assert.ok(diff <= (i < mixtures.length ? 1 : 8), `线性 (${tints[i]}) 差 ${diff} 个 8 位码值`));

    await t.test('FFmpeg 的滤镜链和 applyShaperAndLut 是同一条算式', { skip: FFMPEG ? false : '本机没有 ffmpeg' }, async (tt) => {
      const pixels = [...PROBE.map((p) => gray(p.linear)), [3.2, 0.8, 0.4], [0.02, 0.5, 9], [12, 0.001, 0.3], [0.7, 0.2, 0.05], [1e-6, 2000, 0.5], [-0.5, 0.3, 0.3]];
      // 两边都是 32 位浮点上的同一条算式，差只在舍入：给到千分之一个 8 位码值
      for (const colorRef of ['scene', 'display']) {
        const got = await throughFfmpeg(dir, pixels, ffmpegFilter(colorRef, cube));
        const worst = Math.max(...pixels.map((p, i) => maxDiff(to8(got[i]), to8(displayEncode(p, colorRef, lut)))));
        tt.diagnostic(`${colorRef}：${pixels.length} 个像素，ffmpeg 对 displayEncode 最大差 ${worst.toExponential(2)} 个 8 位码值`);
        assert.ok(worst <= 1e-3, `${colorRef} 一支 ffmpeg 和 displayEncode 差 ${worst} 个 8 位码值`);
        if (colorRef !== 'scene') continue;
        const ff = (v) => got[PROBE.findIndex((p) => p.linear === v)][0] * 255;
        assert.ok(ff(1) < ff(4) && ff(4) < ff(16) && ff(4) > clipped + 30, `ffmpeg 出来的 1.0、4.0、16.0：${[1, 4, 16].map(ff)}`);
      }
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.deepEqual((await readdir(tmpdir())).filter((n) => n.startsWith('beiming-lut-test-')), [], '临时目录跑完要删掉');
});
