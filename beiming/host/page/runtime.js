// 页面宿主（页面一侧）：three 帧源这一对里的宿主。装载镜头（有入口文件的搭 ctx、调一次 build；「卡加数据」模式的跑固定装载脚本）、
// 把时刻写进场景、量元数据、把卡交的文字框和读数并进元数据；
// 渲染库由这里引入再注入渲染器和镜头代码。node 一侧（host.mjs）是帧源对上层的接口，它经 window.__open、window.__session 调这里。
import * as THREE from 'three';
import { createOrder, expandOverlays, implFor, mergeEntities, mergeMeta, orderPairs, parseCardRef, resolveParams } from '../../cards/runtime.mjs';
import { renderingOf } from '../../kernel/eval/input.mjs';
import { stream, streamName } from '../../kernel/eval/rng.mjs';
import { globalFrame } from '../../kernel/eval/time.mjs';
import { caps } from '../../sources/three/caps.mjs';
import { planOpen } from '../../sources/three/plan.mjs';
import { createThreeSource } from '../../sources/three/source.js';
import { monotonicMs } from './clock.js';
import { answerQuery, clipStats, lumaStats, measureEntity, pickAnchors, placeAnchors } from './measure.js';

const META_KEYS = ['texts', 'anchors', 'readings'];
const CARD_ENTRIES = ['create', 'evaluate'];
// 「卡加数据」模式的镜头既没有相机轨道、也没有相机类卡时，宿主自己备的那台透视相机（契约没定这种情形，定在这里）：
// 放在世界原点，朝 −Z，Y 向上；竖直视场角 40 度，近裁剪面 0.1 米，远裁剪面 100 米。相机轨道写的那台相机用同样的裁剪面
const HOST_CAMERA = { fovYDeg: 40, nearM: 0.1, farM: 100 };
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
 * 装载一个镜头，交回页面里的会话 { manifest, render, query, close }。
 * input：镜头输入；env：{ lock, tier }；filmBase：片子描述所在目录的地址，入口文件相对它找；cards：提供给帧源的卡 { 卡名: { card, sha256 } }。
 * 事件只从镜头输入的 events 拿（上层已经展开成全片帧号），这里不从片子描述再展开。
 */
export async function openSession({ input, env, filmBase, cards = {} }) {
  const { film, output, shot } = input;
  const CAPS = caps(cards);
  const locked = planOpen(CAPS, input, env, cards);
  const rng = (arg) => stream(streamName(locked.seed, shot.id, arg));
  const events = input.events?.events ?? [];
  // 这次装载里宿主自己记的账：固定装载脚本做了哪几步、create 的次序、每帧写状态和并元数据的次序、相机从哪来，
  // 每个卡实例是谁调的、Handle 上有什么、并进镜头之后叫什么。经每帧元数据的 ext["page.load"] 交出去；镜头没用卡时不出现
  const account = { cards: [] };

  /** 这个镜头的卡实例：镜头条目的 cards 在前，叠加层展开出的在后。各带卡文件、用的那份实现、装进来的模块、换算好的参数 */
  async function instancesOf(entry) {
    const listed = [...(entry.cards ?? []).map((c) => ({ ...c, overlay: false })), ...expandOverlays(input.overlays).map((c) => ({ ...c, overlay: true }))];
    return Promise.all(listed.map(async (c) => {
      const { card } = cards[parseCardRef(c.use).name], impl = implFor(card, CAPS.id);
      const module = await import(new URL(`/beiming/${impl.entry}`, filmBase).href);
      // 一份实现对外只能有一个卡入口，并且就是卡文件声明的形状
      const entries = CARD_ENTRIES.filter((k) => typeof module[k] === 'function');
      if (entries.length !== 1 || entries[0] !== impl.shape) throw new Error(`卡 ${c.use} 的实现 ${impl.entry} 对外的卡入口是 ${entries.join('、') || '没有'}，卡文件声明的是 ${impl.shape}`);
      const row = { as: c.as, card: c.use, impl: impl.entry, shape: impl.shape };
      return { as: c.as, use: c.use, overlay: c.overlay, card, impl, module, row, params: resolveParams(card, c.params, { events, shotIn: entry.in }) };
    }));
  }

  /** 调一张 create 形状的卡，交回 Handle；实体名加上实例前缀，记进账里 */
  function createInstance(inst, ctx) {
    const handle = inst.module.create(ctx, structuredClone(inst.params));
    if (typeof handle?.dispose !== 'function') throw new Error(`卡 ${inst.use} 的 create 交回的 Handle 没有 dispose()`);
    inst.handle = handle;
    inst.merged = mergeEntities(inst.as, handle.entities);
    Object.assign(inst.row, { calledVia: 'cards.use', members: Object.keys(handle), entities: inst.merged.map((m) => m.rel), roots: inst.merged.filter((m) => m.root).map((m) => m.rel), merged: inst.merged.map((m) => m.name) });
    account.cards.push(inst.row);
    return handle;
  }

  /** ctx.cards.use：as 必须是这个镜头 cards 里声明过的实例名，runtime 的键不得和这张卡声明的参数同名（镜头契约 S9） */
  function cardsUse(entry, instances, ctx) {
    return (as, runtime) => {
      const inst = instances.find((i) => i.as === as && !i.overlay);
      if (!inst) throw coded('contract.undeclared-card', `镜头 ${entry.id} 没有声明卡实例 ${as}`);
      const keys = Object.keys(runtime ?? {}), shadow = keys.filter((k) => Object.hasOwn(inst.card.params, k));
      if (shadow.length) throw coded('contract.runtime-shadows-param', `ctx.cards.use(${as}) 的 runtime 里的 ${shadow.join('、')} 和卡 ${inst.use} 声明的参数同名`);
      if (inst.impl.shape !== 'create') throw new Error(`卡实例 ${as} 是 evaluate 形状，由 tracks 求值，不经 ctx.cards.use`);
      // shortcut: runtime 怎么交到 create 契约还没定（create 的签名没动），带了东西来就报错，不丢掉照常装；定了以后在这里交过去
      if (keys.length) throw new Error(`ctx.cards.use(${as}) 带了 runtime（${keys.join('、')}），怎么交到 create 契约还没定，页面宿主不接`);
      return inst.handle ?? createInstance(inst, ctx());
    };
  }

  function makeCtx(entry, natives, tracks, use) {
    return {
      tracks,
      cards: { use },
      params: entry.params ?? {},
      seed: locked.seed,
      rng,
      assets: { load(ref) { throw new Error(`资产 ${ref} 不在这个镜头能用的资产里（镜头条目的 assets 加全片的 assets）`); } },
      anchor(entity, name) { throw new Error(`没有锚点 ${entity}#${name}`); },
      tokens: structuredClone(input.tokens ?? {}),
      size: [...output.size],
      fps: output.fps,
      frames: entry.out - entry.in,
      shot: Object.freeze({ id: entry.id, in: entry.in, frames: entry.out - entry.in }),
      // 每个命名条目一项，值是它的全片帧号减这个镜头的起始帧；可以是负数，也可以不小于镜头帧数
      events: Object.freeze(Object.fromEntries(events.filter((e) => e.kind === 'named').map((e) => [e.id, e.frame - entry.in]))),
      THREE: natives.THREE,
      renderer: natives.renderer,
    };
  }

  /**
   * 数据轨道：evaluate 形状的卡实例按书写顺序逐个求值，每个时刻现算，不留跨帧的状态。这个宿主有地方写的只有相机轨道
   * （一段里的 camera：{ pos 米, quat, fovDeg 度 }），写到 tracks.camera 这台相机上；没有产出相机轨道的卡时 tracks.camera 不出现。
   */
  function makeTracks(entry, data) {
    const inputs = Object.freeze({
      fps: output.fps, size: [...output.size], seed: locked.seed, shot: { id: entry.id, in: entry.in, frames: entry.out - entry.in },
      events: events.map((e) => ({ id: e.id, kind: e.kind, f: e.frame - entry.in, sub: e.sub })),
    });
    const filming = data.filter((i) => i.card.ports.out.some((p) => p.type === 'tracks.camera'));
    if (filming.length > 1) throw new Error(`镜头 ${entry.id} 有 ${filming.length} 个产出相机轨道的卡实例，取哪一个契约还没定`);
    const camera = filming.length ? new THREE.PerspectiveCamera(HOST_CAMERA.fovYDeg, output.size[0] / output.size[1], HOST_CAMERA.nearM, HOST_CAMERA.farM) : undefined;
    for (const i of data) account.cards.push(Object.assign(i.row, { calledVia: 'tracks' }));
    return {
      apply(f, sub) {
        for (const i of data) {
          const segment = i.module.evaluate(inputs, i.params, f, sub);
          if (!segment.camera) continue;
          camera.position.fromArray(segment.camera.pos);
          camera.quaternion.fromArray(segment.camera.quat);
          camera.fov = segment.camera.fovDeg;
          camera.updateProjectionMatrix();
        }
      },
      ...(camera ? { camera } : {}),
    };
  }

  /**
   * 固定装载脚本（卡的运行时接口契约 3.4）：assets → tracks → create → collect，每步做完记一笔。
   * create 的次序照 ports.order 排（排不出报 contract.order-cycle），叠加层展开出的实例装在镜头自己的卡之后；evaluate 形状的实例
   * 在第 2 步已经接进 tracks，轮到它时只记次序，不调 create。Handle.object 放哪：post 类的进后期链，two-d 类的挂在相机下面
   * （它的局部坐标就是相机空间），别的放在场景根下。相机取 tracks.camera，没有就取相机类卡交出的相机，再没有用宿主备的那台。
   */
  function loadFixed(entry, natives, instances) {
    const steps = [], created = [], own = instances.filter((i) => !i.overlay), pairs = orderPairs(own);
    Object.assign(account, { steps, orderPairs: pairs, createOrder: created });
    // shortcut: 第 1 步现在没有东西可载：镜头条目带资产的，planOpen 已经报了装不了；接资产时在这里载入、零件名进 entities
    steps.push('assets');
    const tracks = makeTracks(entry, instances.filter((i) => i.impl.shape === 'evaluate'));
    steps.push('tracks');

    const order = [...createOrder(own.map((i) => i.as), pairs), ...instances.filter((i) => i.overlay).map((i) => i.as)];
    const ctx = makeCtx(entry, natives, tracks, cardsUse(entry, instances, () => ctx));
    for (const as of order) {
      const inst = instances.find((i) => i.as === as);
      if (inst.impl.shape === 'create' && !inst.handle) createInstance(inst, ctx);
      created.push(as);
    }
    steps.push('create');

    const made = order.map((as) => instances.find((i) => i.as === as)).filter((i) => i.handle);
    const cameraCards = made.filter((i) => i.card.kind === 'camera' && i.handle.object?.isCamera);
    if (!tracks.camera && cameraCards.length > 1) throw new Error(`镜头 ${entry.id} 有 ${cameraCards.length} 张相机类卡，取哪一张契约还没定`);
    const camera = tracks.camera ?? cameraCards[0]?.handle.object ?? new THREE.PerspectiveCamera(HOST_CAMERA.fovYDeg, output.size[0] / output.size[1], HOST_CAMERA.nearM, HOST_CAMERA.farM);
    if (tracks.camera || cameraCards.length) account.camera = { tracksHasCamera: Boolean(tracks.camera), from: tracks.camera ? 'tracks' : 'card' };
    const scene = new THREE.Scene(), entities = {}, post = [];
    scene.add(camera);
    for (const inst of made) {
      const { object } = inst.handle;
      if (object && object !== camera) {
        if (inst.card.kind === 'post') post.push(object);
        else (inst.card.kind === 'two-d' ? camera : scene).add(object);
      }
      for (const m of inst.merged) {
        if (entities[m.name]) throw new Error(`实体名 ${m.name} 重复`);
        entities[m.name] = m.object;
      }
    }
    steps.push('collect');

    const appliers = made.filter((i) => typeof i.handle.apply === 'function');
    Object.assign(account, { applyOrder: ['tracks', ...appliers.map((i) => i.as)], metaOrder: ['host', ...made.filter((i) => typeof i.handle.meta === 'function').map((i) => i.as)] });
    return {
      post,
      object: {
        scene, camera, entities,
        state(f, sub) {
          tracks.apply(f, sub);
          for (const i of appliers) i.handle.apply(f, sub);
        },
        meta: () => ({}),
        dispose() { for (const i of made) i.handle.dispose(); },
      },
    };
  }

  const services = {
    now: monotonicMs,

    async load(entry, natives) {
      const { mode, entry: file } = renderingOf(entry), instances = await instancesOf(entry);
      let built;
      if (mode === 'cards-data') {
        try {
          built = loadFixed(entry, natives, instances);
        } catch (e) {
          // 带错误码的失败把到这时为止记的账带上，上层才写得出这次装载的核对记录
          throw e.code ? Object.assign(e, { load: account }) : e;
        }
      } else {
        const { build } = await import(new URL(file, filmBase).href);
        // 片子没给这个镜头数据轨道：空操作，不带 camera
        const ctx = makeCtx(entry, natives, { apply() {} }, cardsUse(entry, instances, () => ctx));
        const object = await build(ctx);
        for (const k of ['state', 'meta', 'dispose']) if (typeof object?.[k] !== 'function') throw new Error(`镜头对象缺 ${k}()`);
        for (const k of ['camera', 'entities', 'scene']) if (!object[k]) throw new Error(`镜头对象缺 ${k}`);
        // 镜头代码经 ctx.cards.use 装的卡：带进来的实体照实例前缀并进镜头的 entities；Handle.object 放哪、apply 什么时候调归镜头代码
        const entities = { ...object.entities };
        for (const m of instances.flatMap((i) => i.merged ?? [])) {
          if (entities[m.name]) throw new Error(`实体名 ${m.name} 重复`);
          entities[m.name] = m.object;
        }
        built = { object: Object.create(object, { entities: { value: entities, enumerable: true } }) };
      }
      if (!built.object.camera.isPerspectiveCamera) throw new Error('页面宿主现在只量透视相机');
      // 交了 meta 的卡实例，按 create 的次序
      const reporters = instances.filter((i) => typeof i.handle?.meta === 'function').sort((a, b) => account.cards.indexOf(a.row) - account.cards.indexOf(b.row));
      return { ...built, size: [...output.size], entry, reporters };
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
      // 宿主量完，再按 create 的次序并进各张卡的 meta(f)：文字框的 id、读数的名字加实例前缀；文字框从基准画幅换算到本帧实际尺寸 facts.size
      const [rx, ry] = [facts.size[0] / loaded.size[0], facts.size[1] / loaded.size[1]];
      const scaleText = (t) => ((rx === 1 && ry === 1) || !Array.isArray(t.bbox2d)
        ? t
        : { ...t, bbox2d: [t.bbox2d[0] * rx, t.bbox2d[1] * ry, t.bbox2d[2] * rx, t.bbox2d[3] * ry] });
      const texts = (extra.texts ?? []).map(scaleText), readings = { ...extra.readings };
      // 锚点：镜头代码交「实体名#锚点名」到世界坐标，宿主投到屏幕、挂到那个实体上。同一个锚点交了两次这一帧算失败，不让后来的盖掉先来的
      const anchorPairs = Object.entries(extra.anchors ?? {});
      for (const i of loaded.reporters) {
        const m = mergeMeta(i.as, i.handle.meta(f) ?? {});
        texts.push(...m.texts.map(scaleText));
        Object.assign(readings, m.readings);
        anchorPairs.push(...cardAnchors(i, m));
        Object.assign(i.row, { metaIds: m.ids, mergedMetaIds: m.merged });
      }
      const anchors = placeAnchors(view, proj, facts.size, anchorPairs, facts.manifest.entities.map((e) => e.name));
      const nulls = CAPS.metaNull ?? [];
      if (!nulls.includes('lights') || !nulls.includes('stats.noise')) throw new Error('页面宿主不会量灯和噪声，帧源必须在 metaNull 里声明');

      const entities = facts.manifest.entities.map((e) => {
        const m = measureEntity(view, proj, facts.size, pointsOf(object, e.name));
        const role = entry.roles?.hero === e.name ? 'hero' : entry.roles?.mustSee?.includes(e.name) ? 'mustSee' : null;
        // 可见比例由渲染器在编号层上数了交过来：只有出了像素、这个实体有角色时才有，别的写 null
        return { id: e.id, name: e.name, class: e.class, ...(role ? { role } : {}), bbox2d: m.bbox2d, bbox3d: m.bbox3d, visible: (role && facts.visible?.[e.name]) ?? null, pxArea: m.pxArea, depth: m.depth, ...(Object.hasOwn(anchors, e.name) ? { anchors: anchors[e.name] } : {}) };
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
        texts,
        ...(Object.keys(readings).length ? { readings } : {}),
        // 溢出和压死的占比只对显示参考镜头有定义
        stats: facts.color ? { luma: lumaStats(facts.color), ...(entry.colorRef === 'display' ? clipStats(facts.color) : {}), noise: null, tris: facts.tris } : null,
        source: facts.source,
        timing: facts.timing,
        origin: { host: ['camera', 'entities', 'lights', 'stats', 'source', 'timing'], shot: ['entities.*.anchors', 'texts', 'readings'], kernel: ['events'] },
        hash: { color: facts.color ? `sha256:${await sha256(facts.color.buffer)}` : null },
        ...(account.steps || account.cards.length ? { ext: { 'page.load': structuredClone(account) } } : {}),
      };
    },

    /**
     * 场景查询：渲染器已经把 (f, sub = 0) 写进场景，这里只量不改。q 是 planQuery 判过的 { kind, of: 配上的实体名, tol }。
     * 包围盒、最低点和元数据的 bbox3d 是同一批顶点；锚点和元数据的是同一份来源（镜头的 meta(f) 加各张卡的），但只取世界坐标、不投到屏幕：
     * 落在相机平面上的锚点元数据交不出（那一帧报错），这里照答；只看挂在 of 里的实体上的锚点，别的实体上的写坏了也不牵连（pickAnchors）。
     */
    query(loaded, f, q) {
      const { object } = loaded;
      sync(object);
      if (q.kind !== 'anchor') return answerQuery(q.kind, q.of.map((name) => [name, pointsOf(object, name)]), q.tol);
      const pairs = [...Object.entries(object.meta(f)?.anchors ?? {}), ...loaded.reporters.flatMap((i) => cardAnchors(i, mergeMeta(i.as, i.handle.meta(f) ?? {})))];
      return answerQuery('anchor', pickAnchors(pairs, q.of));
    },
  };

  /** 卡交的锚点只能挂在它自己带进来的实体上（卡的运行时接口契约 3.2）：实体名换成并进镜头之后的名字。m 是这张卡并好的 meta(f) */
  function cardAnchors(i, m) {
    return Object.entries(m.anchors ?? {}).map(([key, world]) => {
      const rel = key.split('#')[0], own = i.merged.find((x) => x.rel === rel);
      if (!own) throw new Error(`卡实例 ${i.as} 交的锚点 ${key} 不在它自己带进来的实体上`);
      return [own.name + key.slice(rel.length), world];
    });
  }

  /**
   * 一个实体全部顶点的世界坐标（先 sync）。实例网格每个实例各算一遍：世界矩阵是对象的世界矩阵乘上那个实例的矩阵，一个实例都没有（count 是 0）就没有顶点。
   * 没有几何的实体量不出包围盒，报错。
   * shortcut: 实例网格逐实例逐顶点算，实例数乘顶点数上百万时每帧量元数据会慢，到时改成只变换几何的凸包；蒙皮、变形目标的形变不算，用到时在这里接
   */
  function pointsOf(object, name) {
    const points = [], v = new THREE.Vector3(), world = new THREE.Matrix4();
    object.entities[name].traverse((o) => {
      const pos = o.geometry?.attributes.position;
      if (!pos) return;
      for (let k = 0; k < (o.isInstancedMesh ? o.count : 1); k++) {
        if (o.isInstancedMesh) { o.getMatrixAt(k, world); world.premultiply(o.matrixWorld); } else world.copy(o.matrixWorld);
        for (let i = 0; i < pos.count; i++) points.push(v.fromBufferAttribute(pos, i).applyMatrix4(world).toArray());
      }
    });
    if (!points.length) throw new Error(`实体 ${name} 没有几何，量不出包围盒`);
    return points;
  }

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
        // 场景参考通路另交的（半浮点的成片、2 倍编号层）也编成 base64，宽高 node 一侧照颜色层的算
        const extra = res.extra && Object.fromEntries(Object.entries(res.extra).map(([name, data]) => [name, base64(data)]));
        return { ok: true, meta: res.meta, layers, ...(extra && { extra }) };
      } catch (e) {
        if (!e.code) throw e;
        return { ok: false, code: e.code, message: e.message };
      }
    },

    /** 答一次场景查询。带错误码的错连同 next（替代办法）作为结果交回，别的错照常抛 */
    async query(f, q) {
      try {
        return { ok: true, result: await session.query(f, q) };
      } catch (e) {
        if (!e.code) throw e;
        return { ok: false, code: e.code, message: e.message, next: e.next };
      }
    },

    close: () => session.close(),
  };
}
