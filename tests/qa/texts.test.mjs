// qa texts：文字夹具页面（tests/qa/fixtures/texts-page）里 5 条字各踩一项：缺字、出画、停留太短、对比度低，合格的那条什么都不报。
// 需要无头浏览器（npm run setup 装的 chromium-headless-shell）；没有就跳过并写明原因。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { qa, check, haveBrowser, FIXTURES, TEST_PROFILES } from './helpers.mjs';
import { readingUnits, parseFontSpec, measureContrast } from '../../tools/qa/checks/texts.mjs';

const skip = haveBrowser() ? false : '没有无头浏览器（npm run setup 安装 playwright-core 1.63.0 配套的 headless shell），跳过';
const PAGE = path.join(FIXTURES, 'texts-page');

let r;
const bad = id => (check(r.env, id)?.findings || []).filter(f => f.status === 'fail').map(f => f.target);

test('文字夹具：每项检查只抓到它该抓的那条字，exit 4', { skip }, () => {
  r = qa(['texts', '--film', PAGE, '--profiles-file', TEST_PROFILES]);
  assert.equal(r.code, 4, r.stderr);
  assert.equal(check(r.env, 'texts.contract').status, 'pass');
  assert.deepEqual(bad('texts.glyphs'), ['图']);
  assert.deepEqual(bad('texts.inframe'), ['out']);
  assert.deepEqual(bad('texts.safe-area'), ['out']);
  assert.deepEqual(bad('texts.duration'), ['short']);
  assert.deepEqual(bad('texts.contrast'), ['lowc']);
  const ok = r.env.result.checks.flatMap(c => (c.findings || []).filter(f => f.target === 'ok' && f.status === 'fail'));
  assert.deepEqual(ok, [], '合格的那条字不该有硬失败');
});

test('缺字按 cmap 判：报出「图」和字体名，不是只看 document.fonts.check', { skip }, () => {
  const g = check(r.env, 'texts.glyphs');
  const f = g.findings.find(x => x.target === '图');
  assert.match(f.message, /U\+56FE/);
  assert.match(f.message, /QA SC/);
  const face = g.evidence.faces.find(x => x.family === 'QA SC');
  assert.equal(face.status, 'loaded', '字体本身加载成功（document.fonts.check 会说没问题），缺的是子集里的字');
  assert.ok(face.glyphs > 50);
});

test('豁免：用户批准的豁免把停留时长那条放行；agent 自己批准的无效', { skip }, () => {
  const ok = path.join(FIXTURES, 'waivers.sample.json');
  const r2 = qa(['texts', '--film', PAGE, '--profiles-file', TEST_PROFILES, '--waivers', ok, '--no-contrast']);
  const d = check(r2.env, 'texts.duration');
  const short = d.findings.find(f => f.target === 'short');
  assert.equal(short.status, 'waived');
  assert.equal(short.waiver.approvedBy, '用户');
  assert.ok(r2.env.warnings.some(w => /agent 自己/.test(w)), '署名 agent 的豁免要被忽略并报 warning');
});

test('读字单位与字体简写解析（纯函数）', () => {
  assert.equal(readingUnits('远洋聘书 · 回复截止 06:00'), 10);
  assert.equal(readingUnits('BEIMING ENGINE · WEBGL TOON'), 4);
  assert.deepEqual(parseFontSpec('italic 600 22px "BM HUD SC", "Noto Sans SC", sans-serif'), { style: 'italic', weight: 600, families: ['BM HUD SC', 'Noto Sans SC', 'sans-serif'] });
  assert.deepEqual(parseFontSpec('22px Barlow').families, ['Barlow']);
});

test('对比度测量：白字压黑底约 21:1，灰字压灰底低于 3:1（纯函数）', () => {
  const mk = (w, h, fill) => ({ width: w, height: h, data: new Uint8Array(w * h * 4).map((_, i) => (i % 4 === 3 ? 255 : fill)) });
  const paint = (img, box, v) => { for (let y = box[1]; y < box[3]; y++) for (let x = box[0]; x < box[2]; x++) { const i = (y * img.width + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; } };
  const off = mk(80, 40, 0), on = mk(80, 40, 0);
  for (let k = 0; k < 6; k++) paint(on, [10 + k * 10, 12, 14 + k * 10, 28], 255);   // 6 道竖笔画
  const m = measureContrast(on, off, [8, 10, 72, 30]);
  assert.ok(m.separable && m.ratio > 20, JSON.stringify(m));
  const off2 = mk(80, 40, 90), on2 = mk(80, 40, 90);
  for (let k = 0; k < 6; k++) paint(on2, [10 + k * 10, 12, 14 + k * 10, 28], 140);
  const m2 = measureContrast(on2, off2, [8, 10, 72, 30]);
  assert.ok(m2.separable && m2.ratio < 3, JSON.stringify(m2));
});
