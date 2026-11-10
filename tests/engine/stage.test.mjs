// engine/stage 的纯函数测试（Node）：film.js 的页面约定 v1（__RENDER）、设计画幅适配、镜头表与局部时间、TEXTS 规整；
// camera.js 的 screenAnchor。浏览器里的整片验证（25 / 30 fps 帧号、镜头加长后像素一致、纸纹地址失败）在 film.browser.test.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { renderInfo, designFit, shotTable, normalizeTexts } from '../../engine/stage/film.js';
import { aimCamera, project, screenAnchor } from '../../engine/stage/camera.js';

const shot = (name = 's') => ({ name, scene: {}, camera: {}, update() {}, look: () => ({}) });

test('renderInfo：没注入返回 null；格式不对直接报错（渲染器注入错了不能悄悄按 24 fps 渲）', () => {
  assert.equal(renderInfo({}), null);
  assert.equal(renderInfo(undefined), null);
  assert.deepEqual(renderInfo({ __RENDER: { fps: 30, width: 1080, height: 1920, profile: 'vertical-1080x1920-30' } }),
    { fps: 30, width: 1080, height: 1920, profile: 'vertical-1080x1920-30' });
  assert.deepEqual(renderInfo({ __RENDER: { fps: 25 } }), { fps: 25, width: null, height: null, profile: null });
  const bad = [[{ fps: 0 }, 'fps 0'], [{ fps: -24 }, 'fps 负数'], [{ fps: NaN }, 'fps NaN'], [{ fps: Infinity }, 'fps 无穷'], [{ fps: '24' }, 'fps 字符串'],
    [{ fps: 24, width: 1920.5 }, '宽不是整数'], [{ fps: 24, height: -2 }, '高为负'], [{ fps: null, width: '1920' }, '宽是字符串'], [{ fps: 24, profile: 7 }, '档位不是字符串'],
    ['x', '不是对象'], [5, '不是对象']];
  for (const [v, what] of bad) assert.throws(() => renderInfo({ __RENDER: v }), TypeError, what);
});

test('renderInfo：渲染器的完整注入（engine/render/lib/inject.mjs）里 null = 没指定——fps 为 null 不报错，交给页面帧率', () => {
  // 没给 --fps、--profile、film.json：fps / profile / frameCount 都是 null，宽高是视口
  assert.deepEqual(renderInfo({ __RENDER: { fps: null, width: 1920, height: 1040, profile: null, frameCount: null, contract: 1 } }),
    { fps: null, width: 1920, height: 1040, profile: null });
  // 按档位出片：字段齐全；frameCount、contract 由渲染器自己核对，页面不读
  assert.deepEqual(renderInfo({ __RENDER: { fps: 24, width: 3840, height: 2160, profile: 'master-2160p24', frameCount: 240, contract: 1 } }),
    { fps: 24, width: 3840, height: 2160, profile: 'master-2160p24' });
  assert.deepEqual(renderInfo({ __RENDER: { fps: null, width: null, height: null, profile: null } }), { fps: null, width: null, height: null, profile: null });
  assert.deepEqual(renderInfo({ __RENDER: {} }), { fps: null, width: null, height: null, profile: null });
  // 冻结对象（inject.mjs 用 Object.freeze）照样能读
  assert.deepEqual(renderInfo({ __RENDER: Object.freeze({ fps: null, width: 320, height: 180, profile: null, frameCount: null, contract: 1 }) }),
    { fps: null, width: 320, height: 180, profile: null });
});

test('designFit：只给设计高时与改动前的式子逐位相同（K = H / designHeight，DW = W / K）', () => {
  for (const [W, H] of [[1920, 1040], [3840, 2080], [1920, 1080], [1280, 720], [1080, 1920], [2560, 1440], [1366, 768]]) {
    for (const dh of [1040, 1080, 720]) {
      const f = designFit({ width: W, height: H, designHeight: dh });
      const K = H / dh;
      assert.ok(Object.is(f.K, K) && Object.is(f.DW, W / K) && Object.is(f.DH, H / K), `${W}×${H} / ${dh}`);
      assert.equal(f.fit, 'height');
      assert.deepEqual(f.design, { x: 0, y: 0, w: W / K, h: dh });
    }
    const f = designFit({ width: W, height: H });
    assert.ok(f.K === 1 && f.DW === W && f.DH === H, '不给设计尺寸：K = 1');
  }
});

test('designFit：宽高都给时默认 contain（设计稿整块装进画面），cover 铺满，design 方框居中', () => {
  const c = designFit({ width: 1080, height: 1920, designWidth: 1920, designHeight: 1080 });
  assert.equal(c.fit, 'contain'); assert.equal(c.K, 1080 / 1920); assert.equal(c.DW, 1920);
  assert.ok(Math.abs(c.design.y - (c.DH - 1080) / 2) < 1e-9 && c.design.x === 0, '竖屏：设计稿在中间，上下多出来');
  const v = designFit({ width: 1080, height: 1920, designWidth: 1920, designHeight: 1080, fit: 'cover' });
  assert.equal(v.K, 1920 / 1080); assert.equal(v.DH, 1080); assert.ok(v.design.x < 0, 'cover：左右裁掉');
  const w = designFit({ width: 3840, height: 2160, designWidth: 1920 });
  assert.equal(w.fit, 'width'); assert.equal(w.K, 2);
  for (const [W, H] of [[1920, 1080], [3840, 2160], [1080, 1920], [1920, 1040]]) {
    const f = designFit({ width: W, height: H, designWidth: 1920, designHeight: 1080 });
    assert.ok(f.design.w <= f.DW + 1e-9 && f.design.h <= f.DH + 1e-9, 'contain：设计稿不出画');
    assert.ok(Math.abs(f.DW * f.K - W) < 1e-6 && Math.abs(f.DH * f.K - H) < 1e-6);
  }
  assert.throws(() => designFit({ width: 1920, height: 1080, designHeight: 1080, fit: 'cover' }), /designWidth/);
  assert.throws(() => designFit({ width: 1920, height: 1080, fit: 'zoom' }), /fit/);
  assert.throws(() => designFit({ width: 0, height: 1080 }), TypeError);
});

// 改动前 film.js 选镜头的写法
const oldPick = (shots, t) => { let s = shots[0].shot; for (const c of shots) if (t >= c.at) s = c.shot; return s; };

test('shotTable：老写法 { at } 选镜头与改动前逐位相同；inFrame 与整帧上的切换点一致', () => {
  const A = shot('A'), B = shot('B'), Cc = shot('C');
  for (const fps of [24, 25, 30]) {
    for (const ats of [[0, 3, 5], [0, 3.01, 5.33], [0.5, 2.2, 7.999]]) {
      const shots = [{ at: ats[0], shot: A }, { at: ats[1], shot: B }, { at: ats[2], shot: Cc }];
      const T = shotTable(shots, { fps, dur: 10 });
      for (let k = 0; k < 10 * fps; k++) {
        const t = k / fps, { entry, ctx } = T.at(t, k);
        assert.equal(entry.shot, oldPick(shots, t), `${fps} fps 第 ${k} 帧`);
        assert.ok(k >= ctx.inFrame && k < ctx.outFrame, '帧落在镜头的 [inFrame, outFrame)');
        assert.equal(ctx.localFrame, k - ctx.inFrame);
        assert.equal(ctx.localT, ctx.localFrame / fps, '整帧上 localT = localFrame / fps（逐位）');
      }
      // 连续时间（不在整帧上）：选镜头仍按 t ≥ at，局部量不为负；localT 与镜头第一帧的距离一致（夹到 0 以前）
      for (let i = 0; i < 2000; i++) {
        const t = i * 0.00517, { entry, ctx } = T.at(t, Math.round(t * fps));
        assert.equal(entry.shot, oldPick(shots, t));
        assert.ok(ctx.localT >= 0 && ctx.localFrame >= 0);
        assert.ok(Math.abs(ctx.localT - Math.max(0, t - ctx.inFrame / fps)) < 1e-9, `${fps} fps t=${t}：localT = t − 第一帧的时刻`);
      }
    }
  }
  // 第一镜的 at 晚于 0：改动前 t < at 时也用第一镜，所以它占第 0 帧起的全部帧
  const T = shotTable([{ at: 0.5, shot: A }, { at: 2, shot: B }], { fps: 24, dur: 4 });
  assert.deepEqual(T.list.map(e => [e.inFrame, e.outFrame]), [[0, 48], [48, 96]]);
  assert.equal(T.total, 96);
  // 镜头起点晚于片尾：前一镜的 outFrame 夹到总帧数
  assert.equal(shotTable([{ at: 0, shot: A }, { at: 9, shot: B }], { fps: 24, dur: 4 }).list[0].outFrame, 96);
});

test('shotTable：第一镜加长 12 帧，后一镜同一局部帧拿到的输入逐位相同（镜头可以重排、改长）', () => {
  const A = shot('A'), B = shot('B');
  for (const fps of [24, 30]) {
    const T0 = shotTable([{ in: 0, shot: A }, { in: 48, shot: B, id: 'B' }], { fps, dur: 6 });
    const T1 = shotTable([{ in: 0, shot: A }, { in: 60, shot: B, id: 'B' }], { fps, dur: 6.5 });
    for (let j = 0; j < 60; j++) {
      const a = T0.at((48 + j) / fps, 48 + j).ctx, b = T1.at((60 + j) / fps, 60 + j).ctx;
      assert.ok(Object.is(a.localT, b.localT) && a.localFrame === b.localFrame && a.shotId === 'B' && b.shotId === 'B', `局部第 ${j} 帧`);
    }
    const T2 = shotTable([{ at: 0, shot: A }, { at: 2, shot: B }], { fps, dur: 6 });
    const T3 = shotTable([{ at: 0, shot: A }, { at: 2.5, shot: B }], { fps, dur: 6.5 });
    for (let j = 0; j < 60; j++) assert.ok(Object.is(T2.at((2 * fps + j) / fps, 2 * fps + j).ctx.localT, T3.at((2.5 * fps + j) / fps, 2.5 * fps + j).ctx.localT));
  }
});

test('shotTable：帧号写法、id、outFrame；镜头表不合法时报清楚的错', () => {
  const T = shotTable([{ in: 0, shot: shot(), id: 'S1' }, { in: 72, shot: shot() }], { fps: 24, dur: 5 });
  assert.deepEqual(T.list.map(e => [e.id, e.inFrame, e.outFrame]), [['S1', 0, 72], ['S2', 72, 120]]);
  assert.equal(T.at(2.99, 72).entry.id, 'S2', '帧号写法按帧号选');
  assert.equal(T.at(0, 0).ctx.inFrame, 0);
  assert.ok(!Object.is(shotTable([{ at: 0, shot: shot() }], { fps: 24 }).list[0].inFrame, -0), '第一帧不是 -0');
  // film.json v2 的写法：in / out 相接、末镜 out = 总帧数
  const V = shotTable([{ in: 0, out: 48, shot: shot(), id: 'A' }, { in: 48, out: 72, shot: shot(), id: 'B' }], { fps: 24, dur: 3 });
  assert.deepEqual(V.list.map(e => [e.id, e.inFrame, e.outFrame]), [['A', 0, 48], ['B', 48, 72]]);
  assert.ok(V.list.every(e => !('out' in e)), 'list 里不留输入的 out');
  const bad = [
    [[], /非空数组/], [[{ at: 0, shot: shot() }, { in: 3, shot: shot() }], /只能用一种/], [[{ shot: shot() }], /缺 at/],
    [[{ at: 0, shot: {} }], /scene, camera/], [[{ in: 1.5, shot: shot() }], /整数帧号/], [[{ at: 2, shot: shot() }, { at: 1, shot: shot() }], /升序/],
    [[{ at: 0, shot: shot(), id: 'X' }, { at: 1, shot: shot(), id: 'X' }], /id 重复/], [[{ at: 'a', shot: shot() }], /秒数/],
    [[{ in: 12, shot: shot() }], /第 0 帧开始/], [[{ in: -1, shot: shot() }], /不小于 0/],
    [[{ in: 0, shot: shot() }, { in: 0, shot: shot() }], /一帧也不占/], [[{ in: 0, shot: shot() }, { in: 72, shot: shot() }], /不在影片里/],
    [[{ in: 0, out: 40, shot: shot() }, { in: 48, shot: shot() }], /不相接/], [[{ in: 0, out: 60, shot: shot() }], /总帧数/],
    [[{ in: 0, out: 0, shot: shot() }], /大于 in/], [[{ at: 0, out: 10, shot: shot() }], /帧号写法/], [[{ at: 0, shot: shot(), id: 3 }], /非空字符串/],
  ];
  for (const [shots, re] of bad) assert.throws(() => shotTable(shots, { fps: 24, dur: 3 }), re, JSON.stringify(shots.map(s => ({ ...s, shot: 0 }))));
  assert.throws(() => shotTable([{ at: 0, shot: shot() }], { fps: 0 }), /fps/);
});

test('normalizeTexts：老格式补 box、没写 alpha 记 1；只给 box 的补 x0..y1；不是数组原样交出', () => {
  const r = normalizeTexts([{ id: 'title', text: '北冥', x0: 166, y0: 326, x1: 671, y1: 583 }, { id: 'b', text: 'x', box: [10, 20, 30, 40], alpha: 0.5 }]);
  assert.deepEqual(r[0], { id: 'title', text: '北冥', x0: 166, y0: 326, x1: 671, y1: 583, box: [166, 326, 505, 257], alpha: 1 });
  assert.deepEqual(r[1], { id: 'b', text: 'x', box: [10, 20, 30, 40], alpha: 0.5, x0: 10, y0: 20, x1: 40, y1: 60 });
  assert.equal(normalizeTexts(null), null);
  const src = [{ id: 'a', text: 'a', x0: 0, y0: 0, x1: 1, y1: 1 }]; normalizeTexts(src);
  assert.equal(src[0].box, undefined, '不改调用方的对象');
});

test('camera.screenAnchor：屏幕位置与 project 一致，尺度按距离反比；锚点在背后报错', () => {
  const cam = new THREE.PerspectiveCamera(30, 16 / 9, 0.1, 1000);
  aimCamera(cam, new THREE.Vector3(0, 2, 20), 0.1, -0.05); cam.updateProjectionMatrix();
  const p = new THREE.Vector3(1.5, 1, 0), a = screenAnchor(cam, 1920, 1080, p), q = project(cam, 1920, 1080, p);
  assert.ok(Math.abs(a.x - q.x) < 1e-9 && Math.abs(a.y - q.y) < 1e-9);
  const far = screenAnchor(cam, 1920, 1080, new THREE.Vector3(1.5, 1, -20));
  assert.ok(far.s < a.s * 0.6, `远处的同长一段在屏幕上更短：${far.s} vs ${a.s}`);
  assert.ok(Math.abs(screenAnchor(cam, 1920, 1080, p, 2).s / a.s - 2) < 1e-6, 'span 线性');
  assert.throws(() => screenAnchor(cam, 1920, 1080, new THREE.Vector3(0, 2, 40)), RangeError);
  assert.throws(() => screenAnchor(cam, 1920, 1080, p, 0), TypeError);
});
