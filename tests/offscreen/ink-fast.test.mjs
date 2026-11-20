// TSL 墨线的 GPU 开销优化（engine/offscreen/tsl/ink.js）：
//   ① 边缘遍：空白背景（id < 0.5 或 alpha < 0.002）直接早退，四邻域深度复用，仅真实边缘像素算视空间雾；
//   ② 笔画遍：8×8 块归约（每块存局部最大半宽 + 紧凑边缘包围盒）→ 可分离块膨胀 → 空白块在 vnoise 前整体早退，活跃块按局部半宽与紧包围盒剪枝。
// 这里证明两件事：① 块膨胀半径 inkTilePad 严格覆盖任意抖动与采样半径；② 各种参数/尺寸/相机/雾/空场景下，与优化前原样副本（fixtures/ink-legacy.js）逐像素一致（最大差 0）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import * as INK from '../../engine/offscreen/tsl/ink.js';
import { diffRgba } from '../../engine/offscreen/diff.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE = `${ROOT}tests/offscreen/fixtures/ink-work.mjs`;
const opaque = a => { const o = Uint8Array.from(a); for (let i = 3; i < o.length; i += 4) o[i] = 255; return o; };
const P = { width: 2.5, wobble: 1, boilFps: 12, boilHold: 2, warp: 60, pressure: 0.3, breakup: 0, inner: 0.6, silhouette: 0.12, depthThreshold: 0.03, near: 4, far: 80, farScale: 0.6, opacity: 1 };

test('inkTilePad：对任意采样半径 R、抖动 wobble 与块尺寸，块膨胀范围严格覆盖像素可触及的全部边缘块', () => {
  assert.equal(typeof INK.inkTilePad, 'function', 'ink.js 应导出 inkTilePad 供单测校验');
  for (const tile of [8, 16]) {
    for (const R of [0, 2, 5, 8, 12, 16]) {
      for (const wobble of [0, 0.5, 1, 2.3, 4, 8, -3.5]) {
        const pad = INK.inkTilePad(R, wobble, tile);
        assert.ok(Number.isInteger(pad) && pad >= 0, `pad 应为非负整数：R=${R} wobble=${wobble} tile=${tile} → ${pad}`);
        // 穷举块内每个像素位置 px ∈ [0, tile-1] 和两档值噪声极值（±1.3 * |wobble|）
        const maxWarp = 1.3 * Math.abs(wobble);
        for (let px = 0; px < tile; px++) {
          for (const sign of [-1, 1]) {
            const q = px + 0.5 + sign * maxWarp;
            const b0 = Math.floor(q);
            for (const off of [-R, R]) {
              const ex = b0 + off;
              const tileOfEx = Math.floor(ex / tile);
              assert.ok(Math.abs(tileOfEx) <= pad,
                `漏块：tile=${tile} R=${R} wobble=${wobble} px=${px} q=${q} ex=${ex} 落在块 ${tileOfEx}，超出 pad=${pad}`);
            }
          }
        }
      }
    }
  }
});

async function setup(t) {
  try {
    const { loadGpu } = await import('../../engine/offscreen/load.mjs');
    const { createHost } = await import('../../engine/offscreen/host.mjs');
    const gpu = await loadGpu();
    (await createHost({ gpu, width: 64, height: 64 })).dispose();
    return async (o, W = 320, H = 180) => {
      globalThis.__INK = { fps: 24, ss: 1, ...o };
      const host = await createHost({ gpu, width: W, height: H });
      try { return opaque(await host.renderFrame(await host.load(FIXTURE), 0)); }
      finally { host.dispose(); globalThis.__INK = undefined; }
    };
  } catch (e) { if (String(e.code).startsWith('env.')) { t.skip(`墨线优化对照不可用：${e.message}`); return null; } throw e; }
}

test('对优化前的原样副本逐像素一致（最大差 = 0）：标准、大半径+大抖动+断线、零抖动/零笔压、非 8 倍数与 8 倍数画幅、雾、正交相机、空场景', { timeout: 240000 }, async t => {
  const render = await setup(t);
  if (!render) return;
  const cases = [
    { name: '标准 320×180（非 8 倍数高）', W: 320, H: 180, o: { p: P, t: 0, k: 1 } },
    { name: '标准 320×176（8 倍数整块）', W: 320, H: 176, o: { p: P, t: 0, k: 1 } },
    { name: '大半径 R=16 + 大抖动 + 笔压 + 断线', W: 320, H: 180, o: { p: { ...P, width: 5, wobble: 4, pressure: 0.6, breakup: 0.4 }, t: 5 / 24, k: 2, ss: 2 } },
    { name: '零抖动 + 零笔压 + 折痕分支', W: 320, H: 180, o: { p: { ...P, wobble: 0, pressure: 0, depthThreshold: 0.004, inner: 0.4, farScale: 0.3, opacity: 0.8 }, t: 7 / 24, k: 1.5 } },
    { name: '空气透视雾淡出', W: 320, H: 180, o: { p: { ...P, fogFade: 0.9 }, fog: { start: 4, end: 40, max: 0.85, height: 12, heightFalloff: 0.1 }, fogColor: '#8899aa', t: 2 / 24, k: 1 } },
    { name: '正交相机', W: 320, H: 180, o: { p: P, t: 3 / 24, k: 1, ortho: true } },
    { name: '空场景（全空块早退）', W: 320, H: 180, o: { p: P, t: 0, k: 1, empty: true } },
  ];
  for (const c of cases) {
    const legacy = await render({ ...c.o, impl: 'legacy' }, c.W, c.H);
    const fast = await render(c.o, c.W, c.H);
    const d = diffRgba(fast, legacy, { width: c.W, height: c.H });
    assert.equal(d.maxDelta, 0, `${c.name}：最大差 ${d.maxDelta}（PSNR ${d.psnr}，大差像素 ${d.bigPixels}），优化应逐像素一致`);
    assert.equal(d.bigPixels, 0, c.name);
  }
});
