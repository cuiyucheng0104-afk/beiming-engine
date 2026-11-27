// 对拍阶梯第 6 级（level6.mjs）的测试。纯逻辑部分任何机器都跑：门读阈值文件、色彩样本、读数与判法、特征层的差、帧源出片链的
// 调用写法。实跑部分：色彩一半要本机 Blender（没有就跳过）；负对照要另编一份改坏 post.rs 的程序，只在 BEIMING_CHASSIS_E2E=1 时跑
// （不设就跳过，不在这里现编）；降噪一半与特征层对比要 Blender、OIDN 库与参考包，由命令行跑，不进测试。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { THRESHOLDS } from '../../../verify/floorgate.mjs';
import { findBlender } from './build.mjs';
import { DELIVERED, LIMITS, POST_INJECT, colorPass, colorSamples, colorStatus, compareColor, featureDiff, runColor, runIsolation } from './level6.mjs';
import { TOLERANCE } from './oidn-parity.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const E2E = process.env.BEIMING_CHASSIS_E2E === '1';

test('门读阈值文件：降噪 1e-3（oidn-parity 用同一个数），色彩浮点 1e-4、8 位 1 级', () => {
  assert.deepEqual({ ...LIMITS }, { denoise: 1e-3, colorFloat: 1e-4, color8bit: 1 });
  assert.equal(LIMITS, THRESHOLDS.math.level6);
  assert.equal(TOLERANCE, LIMITS.denoise);
});

test('色彩样本：灰阶 0 到 16 每 1/8 档，饱和色跨八档亮度，折点一带含 (0.4, 0.4, 0)', () => {
  const { gray, saturated, knee } = colorSamples();
  assert.equal(gray.length, 82);
  assert.deepEqual(gray[0], [0, 0, 0]);
  assert.deepEqual(gray.at(-1), [16, 16, 16]);
  assert.equal(saturated.length, 3 + 6 * 8);
  assert.ok(saturated.some((p) => p[0] === 16 && p[1] === 0 && p[2] === 0));
  assert.deepEqual(knee[0], [0.4, 0.4, 0]);
  assert.ok(knee.every((p) => p[0] === p[1] && p[2] === 0));
});

test('色彩读数：浮点最大绝对差、8 位先截再取整的级差；门两项都要过', () => {
  const values = [[0, 0, 0], [1, 1, 1]];
  const r = compareColor(values, [[0.5, 0.5, 0.5], [1.2, 1, 1]], [[0.50005, 0.5, 0.5], [1, 1, 1]], [[128 / 255, 128 / 255, 128 / 255], [1, 1, 1]]);
  assert.ok(Math.abs(r.floatMaxAbs - 0.2) < 1e-12, '最大差在第二个样本的 R（1.2 对 1）');
  assert.equal(r.worst.channel, 'R');
  assert.equal(r.levels8, 0, '1.2 截到 1 之后和 255 级相同；0.5 取整 128');
  assert.equal(compareColor([[0, 0, 0]], [[NaN, 0, 0]], [[0, 0, 0]], [[0, 0, 0]]).floatMaxAbs, Infinity, '非有限数算最坏');
  const ok = { a: { floatMaxAbs: LIMITS.colorFloat, levels8: LIMITS.color8bit } };
  assert.equal(colorPass(ok), true);
  assert.equal(colorPass({ ...ok, b: { floatMaxAbs: 2e-4, levels8: 0 } }), false);
  assert.equal(colorPass({ ...ok, b: { floatMaxAbs: 0, levels8: 2 } }), false);
});

test('色彩一半判交付链的那一种：交付链不过、候选过是 blocked-on-contract，不算过', () => {
  assert.equal(DELIVERED, 'lut65');
  assert.equal(colorStatus({ lut65: { pass: true }, chain: { pass: false } }), 'pass');
  assert.equal(colorStatus({ lut65: { pass: false }, chain: { pass: true } }), 'blocked-on-contract');
  assert.equal(colorStatus({ lut65: { pass: false }, chain: { pass: false } }), 'fail');
});

test('特征层的差：平均、99 分位、最大，与任一分量差超过 0.01 的像素占比；大小不同拒收', () => {
  const ref = new Float32Array(300);
  const core = new Float32Array(300);
  core[0] = 0.5;
  core[4] = 0.005;
  const d = featureDiff(core, ref);
  assert.ok(Math.abs(d.maxAbs - 0.5) < 1e-7);
  assert.equal(d.over, 1 / 100);
  assert.ok(Math.abs(d.meanAbs - 0.505 / 300) < 1e-7);
  assert.throws(() => featureDiff(new Float32Array(3), new Float32Array(6)), /大小不同/);
});

test('帧源出片链的写法：render-pack 带 --no-denoise 与 --passes，层只从出层文件读，预览 PNG 只是 -o 的去处', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'source.mjs'), 'utf8');
  const call = src.split('\n').find((l) => l.includes("'render-pack'"));
  assert.ok(call.includes("'--no-denoise'") && call.includes("'--passes'") && !call.includes("'--hdr'"), call);
  assert.equal(src.match(/preview\.png/g)?.length, 1, '预览 PNG 只出现在 -o 的参数里');
  const layers = /const LAYERS = \{([\s\S]*?)\n\};/.exec(src)[1];
  const files = [...layers.matchAll(/: \['([^']+)'/g)].map(([, f]) => f);
  assert.equal(files.length, 6, layers);
  assert.ok(files.every((f) => /\.(f32|u32)$/.test(f)), layers);
  // 负对照改的那一句在 post.rs 里恰好一次
  const post = fs.readFileSync(path.join(HERE, '..', 'path', 'src', 'post.rs'), 'utf8');
  assert.equal(post.split(POST_INJECT[0].from).length, 2);
});

test('实跑：色彩一半，65³ 表与 Blender 自带算子链各对 Blender 直出', { skip: findBlender() ? false : '本机没有 Blender', timeout: 600000 }, async (t) => {
  const r = await runColor({ blenderBin: findBlender() });
  for (const [name, m] of Object.entries(r.methods)) t.diagnostic(`${name}：${Object.entries(m.sets).map(([k, s]) => `${k} 浮点 ${s.floatMaxAbs.toExponential(3)}、8 位 ${s.levels8} 级`).join('；')}`);
  t.diagnostic(`OCIO 直算对 16 位 PNG ${r.ocioVs16.toExponential(3)}；交付链 ${r.delivered}，结论 ${r.status}`);
  // OCIO 直算就是 Blender 存图的那一条：差只在 16 位量化（一级 1.5e-5）与存图的舍入
  assert.ok(r.ocioVs16 <= 1e-4, `OCIO 直算对 Blender 存的 16 位 PNG 差 ${r.ocioVs16}`);
  assert.match(r.methods.lut65.lock, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(r.methods.chain.lock.map((f) => f.file).sort(), ['AgX_Base_sRGB.cube', 'config.ocio', 'luminance_compensation_bt2020.cube']);
  assert.equal(r.methods.chain.pass, true, '算子链照做应当过门');
  assert.equal(r.delivered, 'lut65');
  assert.equal(r.status, colorStatus(r.methods));
  assert.equal(r.pass, r.methods.lut65.pass, '判的是交付链的那一种，不按候选算');
});

test('负对照：post::finish 改坏，帧源出片链的 color 层逐字节不变、预览 PNG 变了', { skip: E2E ? false : '要另编一份程序（设 BEIMING_CHASSIS_E2E=1）', timeout: 3600000 }, async () => {
  const r = await runIsolation();
  assert.equal(r.previewChanged, true, '预览 PNG 没变：改动没生效，这个负对照不成立');
  assert.equal(r.colorSame, true, 'color 层跟着 post.rs 变了：帧源出片链经过了调色');
});
