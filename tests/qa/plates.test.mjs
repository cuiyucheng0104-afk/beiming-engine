// qa plates：静态找边（直线淡出 / 硬切边 / 自然起伏的云边不报 / 画里的锐利直线不报）、页面逐帧投影与贴图密度、
// 仓库底板里 clouds_back / clouds_front_a / clouds_front_b 的直线淡出（P07 验收第 3 条）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { qa, check, haveBrowser, haveFfmpeg, ROOT, FIXTURES, TEST_PROFILES } from './helpers.mjs';
import { analyzeAlpha, analyzePlate } from '../../tools/qa/lib/plate-edges.mjs';

// 合成 alpha：主体是一块不透明的矩形，左端按 edge(y) 给出淡出带起点
function plate(W, H, edge, fade = 40) {
  const a = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    if (y < H * 0.2 || y > H * 0.8) continue;
    const x0 = edge(y);
    for (let x = 0; x < W; x++) a[y * W + x] = x < x0 ? 0 : x < x0 + fade ? Math.round(255 * (x - x0) / fade) : x > W - 30 ? 0 : 255;
  }
  return { width: W, height: H, alpha: a };
}

test('直线淡出：左端沿一条竖线线性淡出，报 left / straight-fade', () => {
  const r = analyzeAlpha(plate(800, 400, () => 60));
  const e = r.edges.find(x => x.side === 'left');
  assert.ok(e, JSON.stringify(r.edges));
  assert.equal(e.kind, 'straight-fade');
  assert.ok(Math.abs(e.posPx - 80) <= 2);
  assert.ok(e.coverage > 0.9);
});

test('自然起伏的边（云边）不报', () => {
  const r = analyzeAlpha(plate(800, 400, y => 120 + 80 * Math.sin(y / 23) + 40 * Math.sin(y / 7)));
  assert.equal(r.edges.filter(x => x.side === 'left').length, 0, JSON.stringify(r.edges));
});

test('贴着图边、没有淡出的截断：报 hard-cut；离图边远的锐利直边（楼的侧墙）不报', () => {
  const cut = analyzeAlpha(plate(800, 400, () => 0, 1));
  assert.equal(cut.edges.find(x => x.side === 'left')?.kind, 'hard-cut');
  const wall = analyzeAlpha(plate(800, 400, () => 300, 1));
  assert.equal(wall.edges.filter(x => x.side === 'left').length, 0, JSON.stringify(wall.edges));
});

test('仓库底板：clouds_back 左右、clouds_front_a 左、clouds_front_b 右都有直线淡出；不透明的天空不查', { skip: haveFfmpeg ? false : '没有 FFmpeg' }, async () => {
  const sides = async n => (await analyzePlate(path.join(ROOT, 'assets/plates', `${n}.png`))).edges.filter(e => e.kind === 'straight-fade' && (e.side === 'left' || e.side === 'right')).map(e => e.side).sort();
  assert.deepEqual(await sides('clouds_back'), ['left', 'right']);
  assert.ok((await sides('clouds_front_a')).includes('left'));
  assert.ok((await sides('clouds_front_b')).includes('right'));
  assert.deepEqual((await analyzePlate(path.join(ROOT, 'assets/plates/sky_dawn.png'))).edges, []);
});

test('B 路线例片（只有 film.json 的 native.images，没有页面）：静态报出三张云片的直线淡出，密度记不适用', { skip: haveFfmpeg ? false : '没有 FFmpeg' }, () => {
  const r = qa(['plates', '--film', path.join(ROOT, 'examples/raea')]);
  assert.equal(r.code, 0, r.stderr);
  const targets = new Set(check(r.env, 'plates.straight-fade').findings.map(f => f.target));
  for (const n of ['clouds_back', 'clouds_front_a', 'clouds_front_b']) assert.ok(targets.has(n), `${n} 没报`);
  assert.equal(check(r.env, 'plates.density').status, 'warn');
});

test('页面逐帧投影：夹具的左端直线淡出露在画内（x≈246–266），密度约 0.32 texel/px 不通过', { skip: haveBrowser() ? false : '没有无头浏览器' }, () => {
  const r = qa(['plates', '--film', path.join(FIXTURES, 'plates-page'), '--profiles-file', TEST_PROFILES]);
  assert.equal(r.code, 4, r.stderr);
  assert.equal(check(r.env, 'plates.inventory').status, 'pass');
  const fade = check(r.env, 'plates.straight-fade');
  assert.equal(fade.status, 'warn');
  const v = fade.evidence.visible.find(x => x.plate === 'fade' && x.side === 'left');
  assert.ok(v && v.screenBox[0] >= 240 && v.screenBox[2] <= 272, JSON.stringify(v));
  const d = check(r.env, 'plates.density');
  assert.equal(d.status, 'fail');
  assert.ok(Math.abs(d.evidence.rows[0].texelPerPx - 0.32) < 0.02, JSON.stringify(d.evidence.rows));
});

test('直接给图片：只做静态找边', { skip: haveFfmpeg ? false : '没有 FFmpeg' }, () => {
  const r = qa(['plates', path.join(FIXTURES, 'plates-page', 'fade.png')]);
  assert.equal(r.code, 0);
  assert.ok(check(r.env, 'plates.straight-fade').findings.some(f => f.target === 'fade' && /左边/.test(f.message)));
  assert.ok(fs.existsSync(path.join(FIXTURES, 'plates-page', 'fade.png')));
});
