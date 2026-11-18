// 页面宿主（页面一侧）：装载镜头（搭 ctx、调一次 build）、驱动 state、量元数据，并把自己看到的每一步记下来。
// 渲染库由这里引入再注入帧源和镜头代码；出帧只经帧源的接口。node 一侧（host.mjs）经 window.__host 调这里的方法。
import * as THREE from 'three';
import { stream, streamName } from '../../kernel/eval/rng.mjs';
import { globalFrame } from '../../kernel/eval/time.mjs';
import { createThreeSource } from '../../sources/three/source.js';
import { monotonicMs } from './clock.js';
import { CLIP_HIGH, CLIP_LOW, lumaStats, measureEntity, toScreen } from './measure.js';

const META_KEYS = ['texts', 'anchors', 'readings'];
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (bytes) => hex(await crypto.subtle.digest('SHA-256', bytes));
const coded = (code, message) => Object.assign(new Error(message), { code });

function base64(view) {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** 给人看的 8 位预览：线性值截到 [0, 1] 再做 sRGB 编码。不是片子描述里的显示变换。 */
function previewPng(rgba, [w, h]) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const g = canvas.getContext('2d'), img = g.createImageData(w, h);
  const enc = (x) => { const c = Math.min(1, Math.max(0, x)); return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)); };
  for (let i = 0; i < w * h; i++) { for (let k = 0; k < 3; k++) img.data[i * 4 + k] = enc(rgba[i * 4 + k]); img.data[i * 4 + 3] = 255; }
  g.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png').split(',')[1];
}

/** film：片子描述；shotId：装哪个镜头；tier：档位；filmBase：片子描述所在目录的地址，入口文件相对它找 */
export function createHost({ film, shotId, tier, filmBase }) {
  const shot = film.shots.find((s) => s.id === shotId);
  if (!shot) throw new Error(`片子描述里没有镜头 ${shotId}`);
  if (shot.source !== 'three' || shot.renderer) throw new Error('页面宿主现在只驱动 three 帧源，不接 renderer 换帧源');
  if (shot.cards?.length || film.events?.length || film.overlays?.length) throw new Error('页面宿主还没接卡、事件表和叠加层');
  // 镜头种子在片子描述里没写时要由服务器从全片种子派生并记进锁文件；这里没有服务器
  if (!Number.isInteger(shot.seed)) throw new Error(`镜头 ${shotId} 没写 seed`);

  const log = { loads: [], cardUses: [], metaKeys: [], renders: [] };
  let current = null, lastLoaded = null, session = null;
  const rng = (arg) => stream(streamName(shot.seed, shot.id, arg));

  const services = {
    now: monotonicMs,

    async load(entry, natives) {
      const record = { buildCalls: 0 };
      log.loads.push(record);
      const { build } = await import(new URL(entry.entry, filmBase).href);
      const ctx = {
        tracks: { apply() {} }, // 这个镜头没有数据轨道，没有东西要写
        cards: {
          use(as, runtime) {
            log.cardUses.push(runtime ? { as, runtimeKeys: Object.keys(runtime) } : { as });
            throw coded('contract.undeclared-card', `镜头 ${entry.id} 没有声明卡实例 ${as}`);
          },
        },
        params: entry.params ?? {},
        seed: entry.seed,
        rng,
        assets: { load(ref) { throw new Error(`资产 ${ref} 不在这个镜头的 assets 里`); } },
        anchor(entity, name) { throw new Error(`没有锚点 ${entity}#${name}`); },
        tokens: film.style.tokens ?? {},
        size: [...film.output.size],
        fps: film.output.fps,
        frames: entry.out - entry.in,
        shot: Object.freeze({ id: entry.id, in: entry.in, frames: entry.out - entry.in }),
        events: Object.freeze({}),
        THREE: natives.THREE,
        renderer: natives.renderer,
      };
      record.buildCalls += 1;
      const object = await build(ctx);
      for (const k of ['state', 'meta', 'dispose']) if (typeof object?.[k] !== 'function') throw new Error(`镜头对象缺 ${k}()`);
      for (const k of ['camera', 'entities', 'scene']) if (!object[k]) throw new Error(`镜头对象缺 ${k}`);
      if (!object.camera.isPerspectiveCamera) throw new Error('页面宿主现在只量透视相机');
      lastLoaded = { object, size: ctx.size, entry };
      return lastLoaded;
    },

    apply(loaded, f, sub, purpose) {
      loaded.object.state(f, sub);
      loaded.last = { f, sub };
      current?.applies.push({ f, sub, purpose });
    },

    async measure(loaded, f, facts) {
      const { object, entry } = loaded, { camera } = object;
      const view = sync(object);
      const proj = camera.projectionMatrix.elements;
      const extra = object.meta(f) ?? {};
      for (const k of Object.keys(extra)) if (!log.metaKeys.includes(k)) log.metaKeys.push(k);
      const bad = Object.keys(extra).filter((k) => !META_KEYS.includes(k));
      if (bad.length) throw new Error(`meta(f) 交了不许交的键：${bad.join('、')}`);
      if (extra.anchors) throw new Error('页面宿主还没接锚点');
      const nulls = source.caps().metaNull ?? [];
      if (!nulls.includes('lights') || !nulls.includes('stats.noise')) throw new Error('页面宿主不会量灯和噪声，帧源必须在 metaNull 里声明');

      const entities = facts.manifest.entities.map((e) => {
        const points = [];
        object.entities[e.name].traverse((o) => {
          const pos = o.geometry?.attributes.position;
          for (let i = 0; i < (pos?.count ?? 0); i++) points.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).toArray());
        });
        if (!points.length) throw new Error(`实体 ${e.name} 没有几何，量不出包围盒`);
        const m = measureEntity(view, proj, facts.size, points);
        const role = entry.roles?.hero === e.name ? 'hero' : entry.roles?.mustSee?.includes(e.name) ? 'mustSee' : null;
        // visible 这次没算：要给每个有角色的实体单独多渲一遍编号层，这条链路没做
        return { id: e.id, name: e.name, class: e.class, ...(role ? { role } : {}), bbox2d: m.bbox2d, bbox3d: m.bbox3d, visible: null, pxArea: m.pxArea, depth: m.depth };
      });

      return {
        format: 'meta/0.1',
        film: film.id,
        shot: entry.id,
        // 这份元数据量的是最后一次写进场景的那个状态：帧号和相位都照那一次记
        frame: globalFrame(loaded.last.f, entry.in),
        shotFrame: loaded.last.f,
        sub: loaded.last.sub,
        seed: entry.seed,
        fps: film.output.fps,
        size: facts.size,
        colorRef: entry.colorRef,
        units: { meter: 1, up: 'Y', hand: 'right' },
        camera: {
          world: [...camera.matrixWorld.elements],
          proj: [...proj],
          fovYDeg: camera.fov,
          near: camera.near,
          far: camera.far,
          shutterAngleDeg: facts.shutterAngleDeg,
        },
        entities,
        lights: null,
        events: [],
        texts: extra.texts ?? [],
        ...(extra.readings ? { readings: extra.readings } : {}),
        stats: facts.color ? { ...lumaStats(facts.color), noise: null, tris: facts.tris } : null,
        source: facts.source,
        timing: facts.timing,
        origin: { host: ['camera', 'entities', 'lights', 'stats', 'source', 'timing'], shot: ['entities.*.anchors', 'texts', 'readings'], kernel: ['events'] },
        hash: { color: facts.color ? `sha256:${await sha256(facts.color.buffer)}` : null },
        ext: { 'beiming.stats': { clipHighAtLuma: CLIP_HIGH, clipLowAtLuma: CLIP_LOW } },
      };
    },
  };

  const source = createThreeSource({ THREE, host: services });
  const env = { lock: null, tier, workspace: '.' }; // 没有服务器，交不出锁文件

  /** 把矩阵更新到当前状态，返回相机到世界的矩阵的逆 */
  function sync({ scene, camera }) {
    scene.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    return camera.matrixWorldInverse.elements;
  }

  /**
   * 状态摘要：相机的两个矩阵，加场景里每个对象的名字、类型、可见性、世界矩阵、顶点位置和材质的基本颜色。
   * shortcut: 不含自定义着色器的参数和贴图内容，镜头用到它们时在这里加
   */
  async function stateDigest(object) {
    sync(object);
    const nums = [...object.camera.matrixWorld.elements, ...object.camera.projectionMatrix.elements], names = [], parts = [];
    object.scene.traverse((o) => {
      names.push(o.name, o.type);
      nums.push(o.visible ? 1 : 0, ...o.matrixWorld.elements);
      for (const m of [].concat(o.material ?? [])) nums.push(m.opacity, ...(m.color?.toArray() ?? []), ...(m.emissive?.toArray() ?? []));
      const pos = o.geometry?.attributes.position?.array;
      if (pos) parts.push(new Uint8Array(pos.buffer, pos.byteOffset, pos.byteLength));
    });
    parts.push(new Uint8Array(new Float64Array(nums).buffer), new TextEncoder().encode(names.join('\n')));
    const all = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
    let at = 0;
    for (const x of parts) { all.set(x, at); at += x.length; }
    return sha256(all);
  }

  return {
    caps: () => source.caps(),
    async openSession() { session = await source.open(shot, env); },
    async closeSession() { await session.close(); session = null; },
    manifest: () => session.manifest(),

    /** 调帧源渲一帧。帧源报的带错误码的错作为结果交回，别的错照常抛 */
    async render(f, opts, want) {
      current = { call: log.renders.length, f, opts, want, applies: [], metas: 0 };
      log.renders.push(current);
      try {
        const res = await session.render(f, opts, want);
        current.status = 'ok';
        current.metas = Array.isArray(res.meta) ? res.meta.length : res.meta ? 1 : 0;
        const layers = {};
        for (const [name, l] of Object.entries(res.layers)) layers[name] = { type: l.type, components: l.components, size: l.size, base64: base64(l.data) };
        const png = res.layers.color ? previewPng(res.layers.color.data, res.layers.color.size) : null;
        return { call: current.call, ok: true, meta: res.meta, layers, png };
      } catch (e) {
        if (!e.code) throw e;
        Object.assign(current, { status: 'error', code: e.code });
        return { call: current.call, ok: false, code: e.code, message: e.message };
      } finally {
        current = null;
      }
    },

    async query(f, q) {
      try {
        return { ok: true, result: await session.query(f, q) };
      } catch (e) {
        if (!e.code) throw e;
        return { ok: false, code: e.code, message: e.message };
      }
    },

    /**
     * 纯函数门：对一批时刻求状态摘要。fresh 是 true 时每个时刻新开一次装载，否则一次装载里按给的次序求。
     * 另交每个实体原点投到屏幕上的位置，给校准对答案用。
     */
    async evaluate(moments, fresh) {
      const out = [];
      let s = null;
      for (const { f, sub } of moments) {
        if (!s) s = await source.open(shot, env);
        const loaded = lastLoaded;
        services.apply(loaded, f, sub, 'eval');
        const digest = await stateDigest(loaded.object);
        const view = sync(loaded.object), origins = {};
        for (const [name, o] of Object.entries(loaded.object.entities)) {
          origins[name] = toScreen(view, loaded.object.camera.projectionMatrix.elements, loaded.size, o.getWorldPosition(new THREE.Vector3()).toArray()).screen;
        }
        out.push({ f, sub, digest, origins });
        if (fresh) { await s.close(); s = null; }
      }
      await s?.close();
      return out;
    },

    /** 用交给镜头代码的同一个 rng 开几条流，轮流各取 count 个数，交回流名和序列摘要 */
    async rngProbe(args, count) {
      const streams = args.map((arg) => ({ arg, name: streamName(shot.seed, shot.id, arg), s: rng(arg), values: new Uint32Array(count) }));
      for (let i = 0; i < count; i++) for (const x of streams) x.values[i] = x.s.u32();
      return Promise.all(streams.map(async ({ arg, name, values }) => ({ arg, name, digest: await sha256(values.buffer) })));
    },

    observations: () => log,
  };
}
