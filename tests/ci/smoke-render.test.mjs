// tests/ci/smoke-render.mjs 的命令行约定（不真出片）：--help 与 --plan 没有副作用、参数错误 exit 2、环境不全时出片前就 exit 3，
// 以及画面与色彩判定的纯函数。真正的出片由 CI 的 smoke-render job 跑（本机复现见 tests/ci/README.md）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { notBlank, isBt709Tv, explainFailure } from './smoke-render.mjs';
import { runNode, REPO } from './helpers.mjs';

const TOOL = path.join(REPO, 'tests/ci/smoke-render.mjs');
const smokeFilms = () => (fs.existsSync(path.join(REPO, 'films')) ? fs.readdirSync(path.join(REPO, 'films')).filter(d => d.startsWith('ci-smoke-')) : []);
const tmpOut = () => path.join(fs.realpathSync(os.tmpdir()), `bm-smoke-${process.pid}-${Math.random().toString(36).slice(2)}`);

test('--help 只打印用法、exit 0', async () => {
  const r = await runNode(TOOL, ['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /用法：node tests\/ci\/smoke-render\.mjs/);
  assert.match(r.stdout, /b-render/);
});

test('参数错误 exit 2，信封里写明原因', async () => {
  const cases = [
    [['--only', 'x'], /不认识的阶段/],
    [['--size-a', '385x208'], /偶数/],
    [['--size-c', '8x8'], /≥16/],
    [['--golden', 'maybe'], /auto、compare、capture、off/],
    [['--nope'], /不认识的选项 --nope/],
  ];
  for (const [args, re] of cases) {
    const r = await runNode(TOOL, [...args, '--json']);
    assert.equal(r.code, 2, `${args.join(' ')}：${r.stderr}`);
    assert.match(r.json.error.code, /^usage\./);
    assert.match(r.json.error.message, re);
  }
  const nonSoftware = await runNode(TOOL, ['--golden', 'compare', '--json'], { env: { BEIMING_ANGLE: 'metal' } });
  assert.equal(nonSoftware.code, 2);
  assert.match(nonSoftware.json.error.message, /--platform/);
});

test('--plan：列出每段的命令，不建作品、不建输出目录', async () => {
  const out = tmpOut(), before = smokeFilms();
  const r = await runNode(TOOL, ['--plan', '--out', out, '--json'], { env: { BEIMING_ANGLE: 'swiftshader', RAEA_BIN: '' } });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.phases.map(p => p.id), ['a', 'c', 'b', 'b-render', 'beiming', 'golden']);
  assert.match(r.json.phases[0].commands.join('\n'), /node tools\/new-film\.mjs a ci-smoke-a-[0-9a-f]{6}/);
  assert.match(r.json.phases[3].commands[0], /跳过：没有设 RAEA_BIN/);
  assert.match(r.json.phases[5].commands[0], /tests\/golden\/(darwin|linux|win)-swiftshader\/manifest\.json/);
  assert.equal(fs.existsSync(out), false);
  assert.deepEqual(smokeFilms(), before);
  const gpu = await runNode(TOOL, ['--plan', '--only', 'golden', '--json'], { env: { BEIMING_ANGLE: 'metal' } });
  assert.match(gpu.json.phases[0].commands[0], /跳过：不是软件渲染/);
});

test('环境不全：出片前就 exit 3，列出哪一段缺什么，不留临时作品', async () => {
  const out = tmpOut(), before = smokeFilms();
  const r = await runNode(TOOL, ['--only', 'a', '--python', path.join(out, 'no-python'), '--out', out, '--json']);
  assert.equal(r.code, 3, r.stderr);
  assert.equal(r.json.error.code, 'ENV_MISSING');
  assert.match(r.json.error.message, /a 需要 python/);
  assert.equal(fs.existsSync(out), false);
  assert.deepEqual(smokeFilms(), before);
});

test('notBlank：黑屏、纯色判为空，正常画面不判空', () => {
  assert.equal(notBlank({ ymin: 0, ylow: 0, yavg: 0, yhigh: 0, ymax: 0 }), false);
  assert.equal(notBlank({ ymin: 120, ylow: 128, yavg: 128, yhigh: 130, ymax: 140 }), false);
  assert.equal(notBlank({ ymin: 16, ylow: 95, yavg: 140, yhigh: 188, ymax: 255 }), true);
  assert.equal(notBlank({ ymin: null, ylow: null, yavg: null, yhigh: null, ymax: null }), false);
});

test('isBt709Tv：四项标注齐全且是有限范围才算', () => {
  assert.equal(isBt709Tv({ range: 'tv', space: 'bt709', primaries: 'bt709', transfer: 'bt709' }), true);
  assert.equal(isBt709Tv({ range: 'pc', space: 'bt709', primaries: 'bt709', transfer: 'bt709' }), false);
  assert.equal(isBt709Tv({ range: 'tv', space: 'bt470bg', primaries: null, transfer: null }), false);
  assert.equal(isBt709Tv(null), false);
});

test('explainFailure：从子命令输出里挑出根因那一行', () => {
  const out = [
    '▶ 4/7 逐帧', '渲染失败： 第 2 段第 36 帧（t=1.5000s）render 出错：page.evaluate: Error: 故意改坏的 render',
    'node:internal/errors:985', '  const err = new Error(message);', '        ^', 'Error: Command failed: node engine/render/video.mjs …',
    '    at genericNodeError (node:internal/errors:985:15)', '  status: 1,', '}', 'Node.js v24.13.1',
  ].join('\n');
  assert.equal(explainFailure(out), '渲染失败： 第 2 段第 36 帧（t=1.5000s）render 出错：page.evaluate: Error: 故意改坏的 render');
  assert.equal(explainFailure('x\n    at f (a.js:1:1)\nTypeError: boom\nNode.js v24.13.1'), 'TypeError: boom');
  assert.equal(explainFailure('a\nb\nc\nd'), 'b / c / d');
});
