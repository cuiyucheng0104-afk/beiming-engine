// 北冥引擎 · 自动毛笔骨架提取的纯 Node 单测（不需要浏览器）：验证拓扑细化、十字交叉直通合并、传统笔顺与标准中线脊线吸附。
//   node --test engine/overlay/skeleton.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { thinMask, traceMaskSkeleton, alignMediansToMask } from './skeleton.js';

function makeMask(W, H, drawFn) {
  const m = new Uint8Array(W * H);
  drawFn((x, y) => {
    if (x >= 0 && y >= 0 && x < W && y < H) m[y * W + x] = 1;
  });
  return m;
}

function fillRect(put, x0, y0, x1, y1) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) put(x, y);
}

test('traceMaskSkeleton：「一」字粗横细化为单笔，且方向严格从左向右', () => {
  const W = 112, H = 112;
  const inside = makeMask(W, H, put => fillRect(put, 16, 51, 95, 60));
  const thin = thinMask(inside, W, H);
  let lit = 0;
  for (const v of thin) lit += v;
  assert.ok(lit >= 65 && lit <= 90, `细化后应为单像素长横，实际亮像素 ${lit}`);

  const { strokes, dry } = traceMaskSkeleton(inside, W, H, { emSize: 100 });
  assert.equal(strokes.length, 1);
  const s = strokes[0];
  assert.ok(s[0][0] < -0.25 && s[s.length - 1][0] > 0.25, `起收端点应在左右两侧：${JSON.stringify(s)}`);
  assert.ok(Math.abs(s[0][1]) < 0.05 && Math.abs(s[s.length - 1][1]) < 0.05);
  assert.equal(dry.length, 1);
  assert.ok(dry[0] > 0.2, `长横应自动带收笔飞白权重：${dry[0]}`);
});

test('traceMaskSkeleton：「十」字正交交叉不会碎成四截，合并为两笔且按「先横后竖」排序', () => {
  const W = 112, H = 112;
  const inside = makeMask(W, H, put => {
    fillRect(put, 16, 52, 95, 59); // 横
    fillRect(put, 52, 16, 59, 95); // 竖
  });
  const { strokes } = traceMaskSkeleton(inside, W, H, { emSize: 100 });
  assert.equal(strokes.length, 2, `十字交叉应直通合并为 2 笔而非 4 段：收到 ${strokes.length} 笔`);
  const [hStroke, vStroke] = strokes;
  // 第一笔应为横（从左往右）
  const hDx = hStroke.at(-1)[0] - hStroke[0][0];
  const hDy = Math.abs(hStroke.at(-1)[1] - hStroke[0][1]);
  assert.ok(hDx > 0.5 && hDy < 0.08, `第 1 笔应为从左到右的横：${JSON.stringify(hStroke)}`);
  // 第二笔应为竖（从上往下）
  const vDy = vStroke.at(-1)[1] - vStroke[0][1];
  const vDx = Math.abs(vStroke.at(-1)[0] - vStroke[0][0]);
  assert.ok(vDy > 0.5 && vDx < 0.08, `第 2 笔应为从上到下的竖：${JSON.stringify(vStroke)}`);
});

test('traceMaskSkeleton：挂在笔画分叉处的小顿笔毛刺会被剪除', () => {
  const W = 112, H = 112;
  const inside = makeMask(W, H, put => {
    fillRect(put, 18, 52, 94, 58); // 主横
    fillRect(put, 20, 48, 23, 51); // 起笔左上角 3px 顿笔小凸起
  });
  const { strokes } = traceMaskSkeleton(inside, W, H, { emSize: 100 });
  assert.equal(strokes.length, 1, `微小顿笔凸起不应拆出多余短枝：收到 ${strokes.length} 笔`);
});

test('alignMediansToMask：把 1024 字面 Y 朝上的标准笔顺中线仿射映射到实际字形掩码并向脊线中心吸附', () => {
  const W = 112, H = 112;
  // 偏下放置的一横一竖（「十」）
  const inside = makeMask(W, H, put => {
    fillRect(put, 26, 62, 86, 68); // 横中心 y ≈ 65
    fillRect(put, 53, 30, 59, 96); // 竖中心 x ≈ 56
  });
  // MakeMeAHanzi 风格的 1024 坐标（Y 朝上）
  const medians = [
    [[120, 480], [900, 480]],
    [[512, 840], [512, 100]],
  ];
  const { strokes, dry } = alignMediansToMask(medians, inside, W, H, { emSize: 100 });
  assert.equal(strokes.length, 2);
  assert.equal(dry.length, 2);
  // 第 1 笔（横）应当落在偏下位置（y > 0），且从左向右
  assert.ok(strokes[0][0][0] < strokes[0][1][0]);
  assert.ok(strokes[0][0][1] > 0.03 && strokes[0][0][1] < 0.16, `横中线应吸附到 y≈0.095em 附近：${strokes[0][0][1]}`);
  // 第 2 笔（竖）翻转 Y 后应从上往下（y 递增）
  assert.ok(strokes[1][0][1] < strokes[1][1][1], `Y 翻转后竖笔应从上往下：${JSON.stringify(strokes[1])}`);
});
