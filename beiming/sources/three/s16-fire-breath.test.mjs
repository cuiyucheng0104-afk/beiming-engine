import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { launchBrowser } from '../../../engine/render/lib/gpu.mjs';
import { loadCards, startServer } from '../../host/page/host.mjs';
import { createCardRegistry, scanCardLeaks } from '../../cards/index.mjs';
import { loadCardLibrary } from '../../api/runtime.mjs';
import { loadContracts } from '../../kernel/contracts/validate.mjs';
import { shotInput } from '../../kernel/eval/input.mjs';
import { resolveFilmLock } from './fire-breath/lock.mjs';
import film from './fire-breath/film.json' with { type: 'json' };

const folder = new URL('./fire-breath/', import.meta.url);
const lock = JSON.parse(await readFile(new URL('film.lock', folder)));
const { validate } = await loadContracts();
const size = [320, 180];
const base = '/beiming/sources/three/fire-breath/';
const library = loadCardLibrary();
const shot = film.shots[0];
const cardIds = [...shot.cards.map((c) => c.use), ...shot.params.dataCards].map((ref) => ref.split('@')[0]);
const valid = (obj) => {
  const { schemaErrors, violations } = validate(obj);
  assert.deepEqual(schemaErrors, []);
  assert.deepEqual(violations, {});
};

test('独立 96 帧片单、锁、全部局部和全片依赖均过契约并匹配卡库字节', () => {
  valid(film);
  valid(lock);
  valid({ format: 'lock-check/0.1', lock, film });
  assert.deepEqual([shot.in, shot.out, film.output.frames, film.output.fps], [0, 96, 96, '60/1']);
  assert.equal(new Set(cardIds).size, 20);
  assert.deepEqual(resolveFilmLock(film, library), lock);
  const registry = createCardRegistry(Object.values(library).map((v) => v.card));
  for (const id of cardIds) assert.equal(lock.cards[id].version, registry.getCard(id).version);
});

test('交付模块无私有资料定位符或游离的内容指纹', async () => {
  // 只有实时从本库文件重算吻合的契约具名摘要是锁的一部分，除此之外不放行哈希。
  const verified = resolveFilmLock(film);
  for (const name of await readdir(folder)) {
    let text = await readFile(new URL(name, folder), 'utf8');
    if (name === 'film.lock') {
      const data = JSON.parse(text);
      for (const [id, card] of Object.entries(data.cards)) {
        assert.equal(card.sha256, verified.cards[id].sha256);
        delete card.sha256;
      }
      assert.deepEqual(data.view, verified.view);
      delete data.view;
      text = JSON.stringify(data);
    }
    assert.deepEqual(scanCardLeaks(text), [], name);
  }
});

test('镜头状态按绝对时钟求值：乱序拍回包含粒子历史的同一份结果', async () => {
  const { sampleFrame } = await import('./fire-breath/scene.js');
  const { samplePostState } = await import('./fire-breath/pipeline.js');
  const frames = [2796, 2820, 2856, 2882],
    seq = new Map();
  // 按 IEEE-754 64 位位型与二进制视图逐位规范化，避免 v8.serialize 受 Smi/HeapNumber 隐藏类升级影响。
  const f64 = new Float64Array(1);
  const u64 = new BigUint64Array(f64.buffer);
  const canonical = (value) =>
    JSON.stringify(value, (_key, item) => {
      if (typeof item === 'number') {
        f64[0] = item;
        return `f64:${u64[0].toString(16).padStart(16, '0')}`;
      }
      if (ArrayBuffer.isView(item)) {
        return `bin:${item.constructor.name}:${Buffer.from(item.buffer, item.byteOffset, item.byteLength).toString('hex')}`;
      }
      return item;
    });
  const digest = (f) =>
    createHash('sha256')
      .update(canonical([sampleFrame(f, 0.25, {}), samplePostState(f, 0.25, {})]))
      .digest('hex');
  for (let f = 2790; f < 2886; f++) {
    const hash = digest(f);
    if (frames.includes(f)) seq.set(f, hash);
  }
  assert.equal(new Set(seq.values()).size, frames.length);
  for (const f of [2882, 2820, 2856, 2796]) assert.equal(digest(f), seq.get(f), `乱序 ${f}`);
});

async function withPage(t, run) {
  let browser;
  try {
    browser = await launchBrowser();
  } catch (e) {
    if (e.code !== 'env.browser-launch') throw e;
    return t.skip(e.message);
  }
  try {
    const server = await startServer();
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(msg.text());
      });
      await page.goto(server.origin);
      await page.waitForFunction(() => typeof window.__open === 'function');
      await run(page, server.origin);
      assert.deepEqual(errors, [], '不接受着色器编译失败后继续画出的像素');
    } finally {
      await server.close();
    }
  } finally {
    await browser.close();
  }
}

const view = (b64, T) => {
  const bytes = Buffer.from(b64, 'base64');
  return new T(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
};

test('页面场景参考：HDR/深度纹理、2 倍实体编号及同帧乱序复渲', async (t) =>
  withPage(t, async (page, origin) => {
    const input = shotInput(film, shot.id);
    input.output.size = size;
    const cards = await loadCards(shot.cards.map((c) => library[c.use.split('@')[0]].dir));
    const opened = await page.evaluate((config) => window.__open(config), {
      input,
      cards,
      env: { tier: 'final', lock },
      filmBase: origin + base,
    });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    const draw = (f) => page.evaluate((f) => window.__session.render(f, {}, ['color', 'depth', 'objectId']), f);
    const a = await draw(48),
      other = await draw(30),
      b = await draw(48);
    for (const r of [a, b, other]) assert.equal(r.ok, true, r.message);
    valid(a.meta);
    assert.equal(a.meta.readings['target.halfFloat'], 1);
    assert.equal(a.meta.readings['target.depthFloat'], 1);
    assert.notEqual(a.meta.hash.color, other.meta.hash.color);
    assert.equal(a.meta.hash.color, b.meta.hash.color);
    assert.ok(a.extra.rgba16f === b.extra.rgba16f && a.extra.objectId2x === b.extra.objectId2x);
    const color = view(a.layers.color.base64, Float32Array),
      z = view(a.layers.depth.base64, Float32Array);
    assert.ok(color.every(Number.isFinite) && color.some((x, i) => i % 4 !== 3 && x > 1));
    assert.ok(z.every(Number.isFinite) && z.some((v) => v > 0 && v < a.meta.camera.far));
    const id = view(a.extra.objectId2x, Uint32Array),
      hero = a.meta.entities.find((e) => e.name === shot.roles.hero);
    assert.equal(id.length, size[0] * size[1] * 4);
    assert.ok(id.includes(hero.id) && hero.visible > 0);
    for (const box of [hero.bbox2d, hero.bbox3d]) assert.ok(box.every(Number.isFinite) && box[0] < box[box.length / 2]);
    assert.ok(hero.anchors.mouth.screen.every(Number.isFinite));
    await page.evaluate(() => window.__session.close());
  }));

// 小画幅实渲探针只查可观测性；验收的固定画幅、七帧与同口径逐层对拍在外部运行。
async function capture(page, frame, disableCards = []) {
  return page
    .evaluate(
      async ({ base, frame, size, disableCards }) => {
        const THREE = await import('three');
        const { build } = await import(base + 'shot.js');
        const renderer = (window.probeRenderer ??= new THREE.WebGLRenderer({ antialias: false }));
        const model = build({ THREE, size, params: { disableCards: new Set(disableCards) } });
        try {
          const passes = model.renderPasses(renderer, frame);
          const read = (rt) => {
            const type = rt.texture.type;
            const A = type === THREE.HalfFloatType ? Uint16Array : type === THREE.FloatType ? Float32Array : Uint8Array;
            const pixels = new A(rt.width * rt.height * 4);
            renderer.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, pixels);
            const rgba =
              A === Uint8Array
                ? Float32Array.from(pixels, (x) => x / 255)
                : A === Uint16Array
                  ? Float32Array.from(pixels, THREE.DataUtils.fromHalfFloat)
                  : pixels;
            const bytes = new Uint8Array(rgba.buffer);
            let binary = '';
            for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
            return btoa(binary);
          };
          return { hdr: read(passes.hdrFx), final: read(passes.finalSrgb) };
        } finally {
          model.dispose();
        }
      },
      { base, frame, size, disableCards },
    )
    .then((pair) => Object.fromEntries(Object.entries(pair).map(([k, v]) => [k, view(v, Float32Array)])));
}

// 与大画幅读数同类的几何量：亮核质心、主轴投影跨度、暖光横向 RMS、相邻帧并集上的亮度绝对差。
function probe({ hdr, final }) {
  const luma = (p, i) => 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];
  const fire = [],
    warm = [];
  let peak = 0,
    m = 0,
    cx = 0,
    cy = 0;
  for (let i = 0; i < hdr.length; i += 4) {
    const x = (i / 4) % size[0],
      y = Math.floor(i / 4 / size[0]);
    const l = luma(hdr, i),
      s = luma(final, i),
      w = final[i] - final[i + 2];
    if (l >= 1 && hdr[i] - hdr[i + 2] >= 0.25) {
      fire.push({ i, x, y, l });
      m += l;
      cx += x * l;
      cy += y * l;
      peak = Math.max(peak, l);
    }
    if (s >= 0.18 && w > 0.1) warm.push({ x, y, w: (w - 0.1) * s });
  }
  cx /= m;
  cy /= m;
  let xx = 0,
    xy = 0,
    yy = 0,
    bx = 0,
    by = 0,
    bm = 0;
  for (const { x, y, l } of fire) {
    xx += (x - cx) ** 2 * l;
    xy += (x - cx) * (y - cy) * l;
    yy += (y - cy) ** 2 * l;
    if (l >= peak / 4) {
      bx += x * l;
      by += y * l;
      bm += l;
    }
  }
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy),
    u = Math.cos(angle),
    v = Math.sin(angle);
  let lo = Infinity,
    hi = -Infinity,
    mass = 0,
    transverse = 0;
  for (const { x, y } of fire) {
    const d = x * u + y * v;
    lo = Math.min(lo, d);
    hi = Math.max(hi, d);
  }
  for (const { x, y, w } of warm) {
    transverse += w * ((y - cy) * u - (x - cx) * v) ** 2;
    mass += w;
  }
  return {
    features: { peakX: bx / bm, peakY: by / bm, length: hi - lo, radius: Math.sqrt(transverse / mass) },
    mask: fire.map((p) => p.i),
    luma,
  };
}

test('四项像素特征非退化，逐卡关闭确实改变相关的渲染截面', async (t) =>
  withPage(t, async (page) => {
    const a = await capture(page, 2838),
      b = await capture(page, 2856);
    const p = probe(a),
      q = probe(b),
      union = new Set([...p.mask, ...q.mask]);
    for (const channel of ['hdr', 'final']) {
      let sum = 0;
      for (const i of union) sum += Math.abs(p.luma(a[channel], i) - p.luma(b[channel], i));
      const vigor = sum / union.size;
      assert.ok(Number.isFinite(vigor) && vigor > 0, `${channel} 活力`);
    }
    for (const [k, v] of Object.entries(p.features)) assert.ok(Number.isFinite(v) && v > 0, k);
    assert.ok(p.features.peakX < size[0] && p.features.peakY < size[1]);
    const neutral = await capture(page, 2838, ['post.lens-fx']);
    assert.ok(
      Buffer.from(neutral.final.buffer).equals(Buffer.from(a.final.buffer)),
      '非撞击帧只用基础色差，不能靠关闭透镜制造差异',
    );
    for (const [id, channel] of [
      ['post.ao', 'hdr'],
      ['post.bloom', 'final'],
      ['post.volumetric', 'final'],
      ['fx.breath', 'hdr'],
      ['motion.sweep-body', 'hdr'],
    ]) {
      const off = await capture(page, 2838, [id]);
      let err = 0;
      for (let i = 0; i < a[channel].length; i++) if (i % 4 !== 3) err += (a[channel][i] - off[channel][i]) ** 2;
      const rmse = Math.sqrt(err / (size[0] * size[1] * 3));
      assert.ok(Number.isFinite(rmse) && rmse > 1e-5, `${id} 对 ${channel} 的 RMSE=${rmse}`);
      t.diagnostic(`${id}: ${channel} RMSE ${rmse.toPrecision(5)}`);
    }
  }));
