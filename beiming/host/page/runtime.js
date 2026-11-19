// 页面宿主（页面一侧）：three 帧源这一对里的宿主。装载镜头（搭 ctx、调一次 build）、把时刻写进场景、量元数据；
// 渲染库由这里引入再注入渲染器和镜头代码。node 一侧（host.mjs）是帧源对上层的接口，它经 window.__open、window.__session 调这里。
import * as THREE from 'three';
import { renderingOf } from '../../kernel/eval/input.mjs';
import { stream, streamName } from '../../kernel/eval/rng.mjs';
import { globalFrame } from '../../kernel/eval/time.mjs';
import { caps } from '../../sources/three/caps.mjs';
import { planOpen } from '../../sources/three/plan.mjs';
import { createThreeSource } from '../../sources/three/source.js';
import { monotonicMs } from './clock.js';
import { clipStats, lumaStats, measureEntity } from './measure.js';

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

/**
 * 装载一个镜头，交回页面里的会话 { manifest, render, close }。
 * input：镜头输入；env：{ lock, tier }；filmBase：片子描述所在目录的地址，入口文件相对它找。
 * 事件只从镜头输入的 events 拿（上层已经展开成全片帧号），这里不从片子描述再展开。
 */
export async function openSession({ input, env, filmBase }) {
  const { film, output, shot } = input;
  const CAPS = caps();
  const locked = planOpen(CAPS, input, env);
  const rng = (arg) => stream(streamName(locked.seed, shot.id, arg));
  const events = input.events?.events ?? [];

  const services = {
    now: monotonicMs,

    async load(entry, natives) {
      const { build } = await import(new URL(renderingOf(entry).entry, filmBase).href);
      const ctx = {
        tracks: { apply() {} }, // 片子没给这个镜头数据轨道：空操作，不带 camera
        cards: {
          use(as) {
            throw coded('contract.undeclared-card', `镜头 ${entry.id} 没有声明卡实例 ${as}`);
          },
        },
        params: entry.params ?? {},
        seed: locked.seed,
        rng,
        assets: { load(ref) { throw new Error(`资产 ${ref} 不在这个镜头能用的资产里（镜头条目的 assets 加全片的 assets）`); } },
        anchor(entity, name) { throw new Error(`没有锚点 ${entity}#${name}`); },
        tokens: {}, // 画风令牌还没进镜头输入
        size: [...output.size],
        fps: output.fps,
        frames: entry.out - entry.in,
        shot: Object.freeze({ id: entry.id, in: entry.in, frames: entry.out - entry.in }),
        // 每个命名条目一项，值是它的全片帧号减这个镜头的起始帧；可以是负数，也可以不小于镜头帧数
        events: Object.freeze(Object.fromEntries(events.filter((e) => e.kind === 'named').map((e) => [e.id, e.frame - entry.in]))),
        THREE: natives.THREE,
        renderer: natives.renderer,
      };
      const object = await build(ctx);
      for (const k of ['state', 'meta', 'dispose']) if (typeof object?.[k] !== 'function') throw new Error(`镜头对象缺 ${k}()`);
      for (const k of ['camera', 'entities', 'scene']) if (!object[k]) throw new Error(`镜头对象缺 ${k}`);
      if (!object.camera.isPerspectiveCamera) throw new Error('页面宿主现在只量透视相机');
      return { object, size: ctx.size, entry };
    },

    apply(loaded, f, sub) {
      loaded.object.state(f, sub);
    },

    async measure(loaded, f, facts) {
      const { object, entry } = loaded, { camera } = object, frame = globalFrame(f, entry.in);
      const view = sync(object);
      const proj = camera.projectionMatrix.elements;
      const extra = object.meta(f) ?? {};
      const bad = Object.keys(extra).filter((k) => !META_KEYS.includes(k));
      if (bad.length) throw new Error(`meta(f) 交了不许交的键：${bad.join('、')}`);
      if (extra.anchors) throw new Error('页面宿主还没接锚点');
      const nulls = CAPS.metaNull ?? [];
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
        film,
        shot: entry.id,
        // 量的是这一帧 sub = 0 的状态：渲染器先把它写进场景、出完辅助层，才来量
        frame,
        shotFrame: f,
        seed: locked.seed,
        fps: output.fps,
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
        events: events.filter((e) => e.frame === frame).map((e) => ({ id: e.id, frame: e.frame })),
        texts: extra.texts ?? [],
        ...(extra.readings ? { readings: extra.readings } : {}),
        // 溢出和压死的占比只对显示参考镜头有定义
        stats: facts.color ? { luma: lumaStats(facts.color), ...(entry.colorRef === 'display' ? clipStats(facts.color) : {}), noise: null, tris: facts.tris } : null,
        source: facts.source,
        timing: facts.timing,
        origin: { host: ['camera', 'entities', 'lights', 'stats', 'source', 'timing'], shot: ['entities.*.anchors', 'texts', 'readings'], kernel: ['events'] },
        hash: { color: facts.color ? `sha256:${await sha256(facts.color.buffer)}` : null },
      };
    },
  };

  /** 把矩阵更新到当前状态，返回相机到世界的矩阵的逆 */
  function sync({ scene, camera }) {
    scene.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    return camera.matrixWorldInverse.elements;
  }

  const session = await createThreeSource({ THREE, host: services }).open(shot, env.tier, locked);
  return {
    manifest: () => session.manifest(),

    /** 渲一帧。带错误码的错作为结果交回（错误码过得了页面和 node 之间那道序列化），别的错照常抛 */
    async render(f, opts, want) {
      try {
        const res = await session.render(f, opts, want);
        const layers = {};
        for (const [name, l] of Object.entries(res.layers)) layers[name] = { type: l.type, components: l.components, size: l.size, base64: base64(l.data) };
        return { ok: true, meta: res.meta, layers };
      } catch (e) {
        if (!e.code) throw e;
        return { ok: false, code: e.code, message: e.message };
      }
    },

    close: () => session.close(),
  };
}
