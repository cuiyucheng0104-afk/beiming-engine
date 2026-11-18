// TSL Kuwahara 的 GPU 开销优化：权重只取决于 (i, j, KR)，在编译期算成常量并展开，圆外的格子不再采样，每个格子只累加权重非零的扇区。
// 这里证明三件事：① 格子表（kuwaharaTaps）的不变量；② 着色器只采样圆内格子；③ 对优化前的原样副本（fixtures/kuwahara-legacy.js）逐像素一致。
// 对 GLSL 参考的质量门仍由 kuwahara.test.mjs 负责。缺可选依赖或拿不到 GPU 适配器时，②③ 跳过。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import * as K from '../../engine/offscreen/tsl/kuwahara.js';
import { diffRgba } from '../../engine/offscreen/diff.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE = `${ROOT}tests/offscreen/fixtures/kuwahara-work.mjs`;
const W = 320, H = 180;
const opaque = a => { const o = Uint8Array.from(a); for (let i = 3; i < o.length; i += 4) o[i] = 255; return o; };

test('kuwaharaTaps：KR 2..10 的格子数等于圆内格子数；中心格 8 扇区各 0.125；其余格只有 3–4 个扇区非零；扇区总权重 = 各格之和', () => {
  for (let KR = 2; KR <= 10; KR++) {
    const { taps, W: sum } = K.kuwaharaTaps(KR);
    let inside = 0;
    for (let j = -KR; j <= KR; j++) for (let i = -KR; i <= KR; i++) if ((i * i + j * j) / (KR * KR) <= 1.0001) inside++;
    assert.equal(taps.length, inside, `KR=${KR} 的格子数`);
    const c = taps.find(t => t.i === 0 && t.j === 0);
    assert.deepEqual(c.w, Array(8).fill(0.125), `KR=${KR} 中心格`);
    for (const t of taps) {
      assert.ok(t.w.every(x => x >= 0 && Number.isFinite(x)), `KR=${KR} (${t.i},${t.j}) 权重要是非负有限数`);
      if (t === c) continue;
      const nz = t.w.filter(x => x > 0).length;
      assert.ok(nz >= 3 && nz <= 4, `KR=${KR} (${t.i},${t.j}) 非零扇区数 ${nz} 应为 3–4`);
    }
    for (let k = 0; k < 8; k++) {
      const s = taps.reduce((a, t) => a + t.w[k], 0);
      assert.ok(Math.abs(s - sum[k]) < 1e-9 * Math.max(1, s), `KR=${KR} 扇区 ${k} 总权重 ${sum[k]} 应等于 ${s}`);
      assert.ok(sum[k] > 0.1, `KR=${KR} 扇区 ${k} 总权重不能接近 0`);
    }
  }
  assert.throws(() => K.kuwaharaTaps(1), RangeError);
  assert.throws(() => K.kuwaharaTaps(11), RangeError);
});

async function setup(t) {
  try {
    const { loadGpu } = await import('../../engine/offscreen/load.mjs');
    const { createHost } = await import('../../engine/offscreen/host.mjs');
    const gpu = await loadGpu();
    (await createHost({ gpu, width: 64, height: 64 })).dispose();
    // 渲一次，返回 { px, samples }：samples 是着色器构建期间 input.sample() 被调用的次数
    return async o => {
      globalThis.__KUWA = o;
      globalThis.__KUWA_SAMPLES = 0;
      const host = await createHost({ gpu, width: W, height: H });
      try { const px = await host.renderFrame(await host.load(FIXTURE), 0); return { px: opaque(px), samples: globalThis.__KUWA_SAMPLES }; }
      finally { host.dispose(); globalThis.__KUWA = undefined; }
    };
  } catch (e) { if (String(e.code).startsWith('env.')) { t.skip(`Kuwahara 优化对照不可用：${e.message}`); return null; } throw e; }
}

test('着色器只采样圆内格子：input.sample 次数 = 1 + 圆内格子数（优化前是 2：中心 1 次 + 循环体 1 次，圆外格子也算在循环里）', { timeout: 120000 }, async t => {
  const render = await setup(t);
  if (!render) return;
  for (const radius of [2, 4, 8]) {
    const KR = Math.min(10, Math.max(2, Math.ceil(radius)));
    const legacy = await render({ radius, impl: 'legacy' });
    const fast = await render({ radius });
    const { taps } = K.kuwaharaTaps(KR);
    // 构建次数 m 未知（TSL 可能多次构建函数体），所以比比值：fast / legacy = (1 + 格子数) / 2
    assert.equal(fast.samples * 2, legacy.samples * (1 + taps.length), `KR=${KR}：fast ${fast.samples} 次、legacy ${legacy.samples} 次、圆内格子 ${taps.length}`);
  }
});

test('对优化前的原样副本逐像素一致：KR 2、4、8、10，强度 0.7，q 5，深度换半径（近 3 → 远 8、近 6 → 远 10）', { timeout: 240000 }, async t => {
  const render = await setup(t);
  if (!render) return;
  const far = { radius: 8, start: 20, end: 120 };
  for (const o of [
    { radius: 2, q: 8, strength: 1 },
    { radius: 4, q: 8, strength: 1 },
    { radius: 8, q: 8, strength: 0.7 },
    { radius: 10, q: 5, strength: 1 },
    { radius: 3, q: 8, strength: 1, far },
    { radius: 6, q: 8, strength: 1, far: { radius: 10, start: 20, end: 120 } },
  ]) {
    const a = await render({ ...o, impl: 'legacy' });
    const b = await render(o);
    const d = diffRgba(b.px, a.px, { width: W, height: H });
    const msg = `${JSON.stringify(o)} PSNR ${d.psnr} 最大差 ${d.maxDelta} 大差像素 ${d.bigPixels}`;
    assert.ok(d.maxDelta <= 1, `${msg}：优化不得改变画面（最大差应在舍入范围内）`);
    assert.equal(d.bigPixels, 0, msg);
    // 只看最大差抓不到小的权重扰动（轴系数偏 1% 时最大差仍是 1）；合法的舍入差实测 PSNR ≥ 81 dB，偏 1% 的权重是 75 dB，门槛卡在中间
    assert.ok(d.psnr >= 78, `${msg}：PSNR 应 ≥ 78 dB（只允许浮点舍入差）`);
  }
});
