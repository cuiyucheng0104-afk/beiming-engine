// three 帧源里的渲染器（页面一侧）：只有这个文件碰 WebGL 渲染器。它是一对里算像素的那一半，不是帧源对上层的接口；
// 对上层的接口在页面宿主的 node 一侧。渲染库由宿主注入（THREE），这里不自己引入。宿主在建渲染器时交进来四个服务：
//   host.load(shot, { THREE, renderer })   装载镜头：搭 ctx、调一次 build（「卡加数据」模式是跑固定装载脚本），交回 { object, size, post? }
//   host.apply(loaded, f, sub)             把 (f, sub) 的状态写进场景
//   host.measure(loaded, f, facts)         量这一帧的元数据（相机、实体、统计、哈希）
// 后期链：loaded.post 是 post 类的卡交出的全屏通道（一张网格，材质带 uniforms.tInput），按次序排好。颜色层每个子帧渲完，
// 依次把每个通道画一遍：tInput 填上一遍的输出，画到另一个同样的浮点目标，最后一遍的输出才读回。辅助层不过这条链。
//   host.now()                             单调时钟，毫秒；读数只进元数据的 timing
import { renderingOf } from '../../kernel/eval/input.mjs';
import { caps, VERSION } from './caps.mjs';
import { planRender, SourceError } from './plan.mjs';

// 辅助样本什么都没打到时深度层写的数，米
const NO_HIT_DEPTH = 1e10;

const AUX_VS = `
varying vec3 vView;
varying vec3 vNormal;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = mv.xyz;
  vNormal = normalMatrix * normal;
  gl_Position = projectionMatrix * mv;
}`;
// uPass 0：平面深度（米）和编号；uPass 1：相机空间的法线。第四个分量写 1：清屏值是 0，读回时靠它分出「什么都没打到」
const AUX_FS = `
uniform float uId;
uniform int uPass;
varying vec3 vView;
varying vec3 vNormal;
void main() {
  if (uPass == 0) { gl_FragColor = vec4(-vView.z, uId, 0.0, 1.0); return; }
  vec3 n = normalize(vNormal);
  gl_FragColor = vec4(gl_FrontFacing ? n : -n, 1.0);
}`;

/** 辅助层画不了的对象：看得见、会被画出来、又不是网格的（点、线、精灵） */
export function unrenderableInAux(scene) {
  const out = [];
  scene.traverseVisible((o) => { if (o.isPoints || o.isLine || o.isSprite) out.push(o); });
  return out;
}

export function createThreeSource({ THREE, host }) {
  if (`0.${THREE.REVISION}.0` !== VERSION) throw new Error(`three 帧源要的渲染库是 ${VERSION}，注入的是 r${THREE.REVISION}`);
  const CAPS = caps();
  let shared = null;

  // 一个帧源一个渲染器，各会话共用；每次 render 自己设目标、自己清屏，不留跨帧的状态
  function renderer() {
    if (shared) return shared;
    const r = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    r.setPixelRatio(1);
    const gl = r.getContext();
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    shared = { r, gl, gpu: String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER)) };
    return shared;
  }

  /** shot 是镜头条目（原样，带 renderer 对象时出帧用的是它里面的那一套），tier 是档位，locked 是装载计划（planOpen 的返回值）。装得了装不了由宿主先用 planOpen 判 */
  async function open(shot, tier, locked) {
    const { r, gl, gpu } = renderer();
    const loaded = await host.load(shot, { THREE, renderer: r }, locked);
    const { scene, camera, entities } = loaded.object;
    const post = loaded.post ?? [];
    // 有角色的实体：可见比例只对它们算
    const roles = new Set([shot.roles?.hero, ...(shot.roles?.mustSee ?? [])].filter((n) => n !== undefined));

    // 这个帧源的镜头都是镜头代码自己搭的，没有场景包：编号由这里分配，实体名按字节序排、从 1 起。实体名只有 ASCII，默认的排序就是字节序。
    // 0 不是任何实体的编号。类别从母语对象的形态推
    const names = Object.keys(entities).sort();
    const manifest = {
      frames: shot.out - shot.in,
      entities: names.map((name, i) => ({
        id: i + 1,
        name,
        class: entities[name].isPoints ? 'particles' : names.some((n) => n.startsWith(`${name}.`)) ? 'assembly' : 'part',
      })),
    };
    // 编号层写叶子实体的编号：先短名后长名，长名盖掉短名
    const idOf = new Map();
    for (const e of [...manifest.entities].sort((a, b) => a.name.length - b.name.length)) {
      entities[e.name].traverse((o) => { if (o.isMesh) idOf.set(o, e.id); });
    }

    // 颜色层和辅助层都渲到同一个 32 位浮点目标：层文件是 32 位，渲染时不先过一道半精度
    const target = () => new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    const rt = target(), rtPost = post.length ? target() : null;
    const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    // 最近一遍场景画了多少三角形：后期链的全屏通道不算在里面
    let sceneTris = null;
    const auxMaterials = new Map();
    const auxFor = (mesh) => {
      const key = `${idOf.get(mesh) ?? 0}/${mesh.material.side}`;
      if (!auxMaterials.has(key)) {
        auxMaterials.set(key, new THREE.ShaderMaterial({
          uniforms: { uId: { value: idOf.get(mesh) ?? 0 }, uPass: { value: 0 } },
          vertexShader: AUX_VS, fragmentShader: AUX_FS, side: mesh.material.side,
        }));
      }
      return auxMaterials.get(key);
    };

    /** 渲进目标（chain 不空时再过一遍后期链）再读回成 RGBA 浮点，行序翻成画面从上到下。readPixels 会等绘制做完，所以显卡上的耗时大半记在读回里 */
    function draw([w, h], timed, chain = []) {
      rt.setSize(w, h);
      r.setRenderTarget(rt);
      // 每一遍自己定清屏值 (0, 0, 0, 0)，渲完还原，不把状态留给下一次。镜头设了背景色时渲染库改用背景色、透明度 1 清屏
      const clearColor = r.getClearColor(new THREE.Color()), clearAlpha = r.getClearAlpha();
      r.setClearColor(0x000000, 0);
      try {
        timed('renderMs', () => r.render(scene, camera));
        sceneTris = r.info.render.triangles;
        let from = rt;
        for (const pass of chain) {
          const to = from === rt ? rtPost : rt;
          to.setSize(w, h);
          pass.material.uniforms.tInput.value = from.texture;
          r.setRenderTarget(to);
          timed('renderMs', () => r.render(pass, postCamera));
          from = to;
        }
      } finally {
        r.setClearColor(clearColor, clearAlpha);
      }
      const raw = new Float32Array(w * h * 4);
      timed('readbackMs', () => gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, raw));
      const out = new Float32Array(raw.length);
      for (let y = 0; y < h; y++) out.set(raw.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
      return out;
    }

    /** 辅助层：换上辅助材质、去掉背景，渲一遍 */
    function drawAux(size, pass, timed) {
      const swapped = [];
      scene.traverse((o) => {
        if (!o.isMesh) return;
        swapped.push([o, o.material]);
        o.material = auxFor(o);
        o.material.uniforms.uPass.value = pass;
      });
      const background = scene.background;
      scene.background = null;
      try {
        return draw(size, timed);
      } finally {
        scene.background = background;
        for (const [o, m] of swapped) o.material = m;
      }
    }

    const pick = (rgba, channels) => {
      const n = rgba.length / 4, out = new Float32Array(n * channels.length);
      for (let i = 0; i < n; i++) channels.forEach((c, k) => { out[i * channels.length + k] = rgba[i * 4 + c]; });
      return out;
    };

    let closed = false;
    const session = {
      manifest: () => structuredClone(manifest),

      async render(f, opts, want) {
        if (closed) throw new Error('会话已经关了');
        if (!Number.isInteger(f) || f < 0 || f >= manifest.frames) throw new SourceError('usage.bad-argument', `镜头局部帧号必须在 [0, ${manifest.frames})，给的是 ${f}`);
        const plan = planRender(CAPS, shot, loaded.size, tier, opts ?? {}, want, locked);
        const timing = { stateMs: 0, renderMs: 0, readbackMs: 0 };
        const timed = (key, fn) => { const t0 = host.now(); const v = fn(); timing[key] += host.now() - t0; return v; };
        const layers = {};
        let color = null, tris = null;

        const applyAt = (sub) => timed('stateMs', () => {
          host.apply(loaded, f, sub);
          if (camera.isPerspectiveCamera) {
            const wantAspect = plan.size[0] / plan.size[1];
            if (camera.aspect !== wantAspect) {
              camera.aspect = wantAspect;
              camera.updateProjectionMatrix();
            }
          }
        });

        if (plan.layers.length) {
          // 逐子帧累积：每个子帧渲到场景线性的浮点目标，读回后逐像素取算术平均
          const sum = new Float64Array(plan.size[0] * plan.size[1] * 4);
          for (const sub of plan.subs) {
            applyAt(sub);
            const px = draw(plan.size, timed, post);
            tris = sceneTris;
            for (let i = 0; i < sum.length; i++) sum[i] += px[i];
          }
          color = Float32Array.from(sum, (v) => v / plan.subs.length);
          layers.color = { type: 'f32', components: ['R', 'G', 'B', 'A'], size: plan.size, data: color };
        }

        // 辅助层和元数据取同一个样本：sub = 0，针孔，不累积，像素中心
        applyAt(0);
        // 辅助材质只会画网格。点、线、精灵照画就会把自己的颜色写进深度和编号，漏画又等于少交，所以有它们在就报错
        const strangers = plan.aux ? unrenderableInAux(scene) : [];
        if (strangers.length) throw new SourceError('contract.unsupported-object', `场景里有辅助层画不了的对象（${strangers.map((o) => o.name || o.type).join('、')}），交不出 ${plan.layers.filter((n) => n !== 'color').join('、')}`);
        if (plan.layers.includes('depth') || plan.layers.includes('objectId')) {
          const px = drawAux(plan.size, 0, timed);
          if (plan.layers.includes('depth')) {
            const depth = pick(px, [0]);
            for (let i = 0; i < depth.length; i++) if (px[i * 4 + 3] === 0) depth[i] = NO_HIT_DEPTH;
            layers.depth = { type: 'f32', components: ['Z'], size: plan.size, data: depth };
          }
          // shortcut: 编号经 32 位浮点目标读回，超过 16777216 会丢精度；实体多到那个量级时换整数目标
          if (plan.layers.includes('objectId')) layers.objectId = { type: 'u32', components: ['id'], size: plan.size, data: Uint32Array.from(pick(px, [1])) };
        }
        if (plan.layers.includes('normal')) {
          const px = drawAux(plan.size, 1, timed);
          layers.normal = { type: 'f32', components: ['X', 'Y', 'Z'], size: plan.size, data: pick(px, [0, 1, 2]) };
        }

        // 可见比例（每帧元数据契约 5.3）：合渲时这个实体在编号层里占的像素数，除以它单独渲时占的像素数，两个数都在四分之一分辨率的编号层上数。
        // 只在出了像素的帧上、只对有角色的实体算；场景里有辅助材质画不了的对象时量不了，不算。单独渲时一个像素也不占（整个在画面外，或者没画）记 0
        let visible = null;
        const roled = manifest.entities.filter((e) => roles.has(e.name));
        if (plan.layers.length && roled.length && !unrenderableInAux(scene).length) {
          const quarter = plan.size.map((n) => Math.max(1, Math.round(n / 4)));
          const count = (px, ids) => { let n = 0; for (let i = 0; i < px.length; i += 4) if (px[i + 3] !== 0 && ids.has(px[i + 1])) n++; return n; };
          const together = drawAux(quarter, 0, timed);
          visible = {};
          for (const e of roled) {
            // 一个实体占的像素：编号是它自己的，或者是名字以它的名字加点号开头的实体的
            const ids = new Set(manifest.entities.filter((x) => x.name === e.name || x.name.startsWith(`${e.name}.`)).map((x) => x.id));
            const hidden = [];
            scene.traverse((o) => { if (o.isMesh && o.visible && !ids.has(idOf.get(o))) { o.visible = false; hidden.push(o); } });
            let alone;
            try {
              alone = count(drawAux(quarter, 0, timed), ids);
            } finally {
              for (const o of hidden) o.visible = true;
            }
            visible[e.name] = alone ? Math.min(1, count(together, ids) / alone) : 0;
          }
        }

        const meta = await host.measure(loaded, f, {
          size: plan.size,
          shutterAngleDeg: plan.angleDeg,
          color,
          tris,
          timing,
          manifest,
          visible,
          // id 是镜头条目顶层写的帧源，renderer 是真的出了这一帧的帧源；条目带 renderer 对象时两个可以不同
          source: { id: shot.source, renderer: CAPS.id, host: renderingOf(shot).host, version: VERSION, tier, gpu, backend: 'webgl2', samples: plan.pixelSamples },
        });
        return { meta, layers };
      },

      async close() {
        if (closed) return;
        closed = true;
        loaded.object.dispose();
        rt.dispose();
        rtPost?.dispose();
        for (const m of auxMaterials.values()) m.dispose();
      },
    };
    return session;
  }

  return { open };
}
