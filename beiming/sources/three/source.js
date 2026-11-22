// three 帧源里的渲染器（页面一侧）：只有这个文件碰 WebGL 渲染器。它是一对里算像素的那一半，不是帧源对上层的接口；
// 对上层的接口在页面宿主的 node 一侧。渲染库由宿主注入（THREE），这里不自己引入。宿主在建渲染器时交进来四个服务：
//   host.load(shot, { THREE, renderer })   装载镜头：搭 ctx、调一次 build（「卡加数据」模式是跑固定装载脚本），交回 { object, size, post? }
//   host.apply(loaded, f, sub)             把 (f, sub) 的状态写进场景
//   host.measure(loaded, f, facts)         量这一帧的元数据（相机、实体、统计、哈希）
// 后期链：loaded.post 是 post 类的卡交出的全屏通道（一张网格，材质带 uniforms.tInput），按次序排好。各子帧只渲后期之前的场景、
// 在线性光里平均之后，依次把每个通道画一遍（只跑一次）：tInput 填上一遍的输出，画到另一个同样的浮点目标，最后一遍的输出才读回；
// 跑之前状态先回到 sub = 0（后期通道的参数也取这一刻），通道声明了 uniforms.tDepth 时填 sub = 0 的深度。辅助层不过这条链。
//   host.now()                             单调时钟，毫秒；读数只进元数据的 timing
// 场景参考通路（04 §4.1）：场景参考镜头的成片另落到一张 RGBA16F 目标、读回半浮点，由宿主送出浏览器落成 EXR；要了编号层时再渲一张 2 倍超采样的。
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

const SRGB_TO_LINEAR = Float64Array.from({ length: 256 }, (_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });

/**
 * 显示参考的镜头（没有 HDR 目标）逐子帧累积：各子帧是 8 位 sRGB 编码的 RGBA，先线性化再取算术平均。
 * 交回线性光的 RGBA 浮点；透明度本来就是线性的，只除以 255。
 */
export function averageDisplaySrgbFrames(frames) {
  if (!frames.length || frames.some((x) => x.length !== frames[0].length || x.length % 4)) throw new SourceError('usage.bad-argument', '子帧必须是一样长的 RGBA 8 位数组，至少一张');
  const sum = new Float64Array(frames[0].length);
  for (const px of frames) for (let i = 0; i < px.length; i++) sum[i] += i % 4 === 3 ? px[i] / 255 : SRGB_TO_LINEAR[px[i]];
  return Float32Array.from(sum, (v) => v / frames.length);
}

/** IEEE 754 binary16 的位型（0 到 65535）解成数；半浮点表示得出的数单精度都表示得出 */
export function float16ToFloat32(bits) {
  const e = (bits >> 10) & 0x1f, m = bits & 0x3ff;
  const v = e === 0 ? m * 2 ** -24 : e === 31 ? (m ? NaN : Infinity) : (m + 1024) * 2 ** (e - 25);
  return bits & 0x8000 ? -v : v;
}

/**
 * 2 倍超采样编号层的覆盖率：id 是输出尺寸 [w, h] 的编号层（像素中心），id2x 是宽高各两倍的编号层（点采样）。
 * 每个像素交回它的 2×2 个子样本里编号和像素中心相同的占几成。不是输出通道契约的 coverage（那个从颜色层的样本数）。
 */
export function coverage2x(id, id2x, [w, h]) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const want = id[y * w + x], at = 4 * y * w + 2 * x, below = at + 2 * w;
    out[y * w + x] = ((id2x[at] === want) + (id2x[at + 1] === want) + (id2x[below] === want) + (id2x[below + 1] === want)) / 4;
  }
  return out;
}

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
    // 场景参考通路：成片另落到这张 RGBA16F 目标再读回半浮点。层文件 color 照旧取 32 位目标（帧源接口契约 3.4 的登记表），不从这里解
    const sceneRef = shot.colorRef === 'scene';
    const rtHalf = sceneRef ? new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false }) : null;
    const copy = sceneRef ? new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      uniforms: { tInput: { value: null } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'uniform sampler2D tInput; varying vec2 vUv; void main() { gl_FragColor = texture2D(tInput, vUv); }',
      depthTest: false, depthWrite: false,
    })) : null;
    // 后期链要深度时才建：sub = 0 的辅助层第 0 遍
    let rtDepth = null;
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

    // 每一遍自己定清屏值 (0, 0, 0, 0)，渲完还原，不把状态留给下一次。镜头设了背景色时渲染库改用背景色、透明度 1 清屏
    function cleared(fn) {
      const clearColor = r.getClearColor(new THREE.Color()), clearAlpha = r.getClearAlpha();
      r.setClearColor(0x000000, 0);
      try {
        return fn();
      } finally {
        r.setClearColor(clearColor, clearAlpha);
      }
    }

    /** 场景渲进目标 into（默认 rt），不过后期链 */
    function drawScene([w, h], timed, into = rt) {
      into.setSize(w, h);
      r.setRenderTarget(into);
      cleared(() => timed('renderMs', () => r.render(scene, camera)));
      sceneTris = r.info.render.triangles;
    }

    /** 读回 from 目标成 RGBA 浮点，行序是 GL 的（从下到上）。readPixels 会等绘制做完，所以显卡上的耗时大半记在读回里 */
    function readRaw(from, [w, h], timed) {
      r.setRenderTarget(from);
      const raw = new Float32Array(w * h * 4);
      timed('readbackMs', () => gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, raw));
      return raw;
    }

    const flipRows = (raw, [w, h]) => {
      const out = new raw.constructor(raw.length);
      for (let y = 0; y < h; y++) out.set(raw.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
      return out;
    };

    /** RGBA 浮点数组（GL 的行序）传成纹理，用完由调用方 dispose */
    const upload = (raw, [w, h]) => {
      const tex = new THREE.DataTexture(raw, w, h, THREE.RGBAFormat, THREE.FloatType);
      tex.minFilter = tex.magFilter = THREE.NearestFilter;
      tex.needsUpdate = true;
      return tex;
    };

    /**
     * 成片（raw，GL 的行序）落到 RGBA16F 目标，读回半浮点的位型，行序还是 GL 的。
     * shortcut: 成片一律从内存再传一次纹理（不动的单子帧、过了后期链的本来就在显存里）；大画幅上这一趟显出来时改成直接拿那张纹理
     */
    function readHalf(raw, [w, h], timed) {
      const tex = upload(raw, [w, h]);
      try {
        rtHalf.setSize(w, h);
        copy.material.uniforms.tInput.value = tex;
        r.setRenderTarget(rtHalf);
        cleared(() => timed('renderMs', () => r.render(copy, postCamera)));
        const half = new Uint16Array(w * h * 4);
        while (gl.getError() !== gl.NO_ERROR) { /* 清掉之前留下的错误标志，下面只看这一次读回 */ }
        timed('readbackMs', () => gl.readPixels(0, 0, w, h, gl.RGBA, gl.HALF_FLOAT, half));
        // 读不回时 readPixels 不抛错、数组留着全 0：不能把一张黑图当成片交出去
        if (gl.getError() !== gl.NO_ERROR) throw new Error('这台机器的 RGBA16F 目标读不回半浮点，场景参考通路出不了 EXR');
        return half;
      } finally {
        tex.dispose();
      }
    }

    /** 后期链：从 input 纹理起依次过各个通道，rt、rtPost 来回倒；声明了 uniforms.tDepth 的通道拿到 depth。交回最后写的目标 */
    function drawChain([w, h], timed, chain, input, depth) {
      let from = input, last = null;
      cleared(() => {
        for (const pass of chain) {
          const to = last === rt ? rtPost : rt;
          to.setSize(w, h);
          pass.material.uniforms.tInput.value = from;
          if (pass.material.uniforms.tDepth) pass.material.uniforms.tDepth.value = depth;
          r.setRenderTarget(to);
          timed('renderMs', () => r.render(pass, postCamera));
          from = to.texture;
          last = to;
        }
      });
      return last;
    }

    /** 场景渲进 rt 再读回，行序翻成画面从上到下 */
    const draw = (size, timed) => {
      drawScene(size, timed);
      return flipRows(readRaw(rt, size, timed), size);
    };

    /** 换上辅助材质、去掉背景跑 fn，跑完换回 */
    function withAux(pass, fn) {
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
        return fn();
      } finally {
        scene.background = background;
        for (const [o, m] of swapped) o.material = m;
      }
    }
    /** 辅助层：换上辅助材质渲一遍，读回 */
    const drawAux = (size, pass, timed) => withAux(pass, () => draw(size, timed));

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
        const plan = planRender(CAPS, shot, loaded.size, tier, opts, want, locked);
        const timing = { stateMs: 0, renderMs: 0, readbackMs: 0 };
        const timed = (key, fn) => { const t0 = host.now(); const v = fn(); timing[key] += host.now() - t0; return v; };
        const layers = {};
        // 场景参考镜头出了像素时另交的：rgba16f 是成片的半浮点位型，objectId2x 是 2 倍超采样的编号层
        let color = null, tris = null, extra = null;

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
          // 逐子帧累积（04 §3.1）：每个子帧只渲后期链之前的场景线性浮点目标，读回后在线性光里逐像素取算术平均
          const sum = new Float64Array(plan.size[0] * plan.size[1] * 4);
          for (const sub of plan.subs) {
            applyAt(sub);
            drawScene(plan.size, timed);
            tris = sceneTris;
            const px = readRaw(rt, plan.size, timed);
            for (let i = 0; i < sum.length; i++) sum[i] += px[i];
          }
          let raw = Float32Array.from(sum, (v) => v / plan.subs.length);
          // 后期链对平均后的结果只跑一次；它要的深度取 sub = 0（R 是平面深度，米；A 是 0 表示没打到）
          if (post.length) {
            // 后期通道自己的参数也取 (f, sub = 0)，不管要不要深度：不然加一个读深度的通道会改掉别的通道取值的时刻
            applyAt(plan.auxSub);
            let depth = null;
            if (post.some((p) => p.material.uniforms.tDepth)) {
              const strangers = unrenderableInAux(scene);
              if (strangers.length) throw new SourceError('contract.unsupported-object', `场景里有辅助层画不了的对象（${strangers.map((o) => o.name || o.type).join('、')}），后期链要的深度交不出`);
              rtDepth ??= target();
              withAux(0, () => drawScene(plan.size, timed, rtDepth));
              depth = rtDepth.texture;
            }
            const mean = upload(raw, plan.size);
            try {
              raw = readRaw(drawChain(plan.size, timed, post, mean, depth), plan.size, timed);
            } finally {
              mean.dispose();
            }
          }
          color = flipRows(raw, plan.size);
          layers.color = { type: 'f32', components: ['R', 'G', 'B', 'A'], size: plan.size, data: color };
          if (sceneRef) extra = { rgba16f: flipRows(readHalf(raw, plan.size, timed), plan.size) };
        }

        // 辅助层和元数据取同一个样本：sub = 0，针孔，不累积，像素中心
        applyAt(plan.auxSub);
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
          if (plan.layers.includes('objectId')) {
            layers.objectId = { type: 'u32', components: ['id'], size: plan.size, data: Uint32Array.from(pick(px, [1])) };
            // 场景参考通路的编号层另渲一张宽高各两倍的：照样点采样、不抗锯齿，子样本落在各自的中心上，编号还是整数。
            // 层文件 objectId 不从它来：像素中心不是它的任何一个子样本（输出通道契约 PS4 要的是像素中心）
            if (extra) extra.objectId2x = Uint32Array.from(pick(drawAux(plan.size.map((n) => n * 2), 0, timed), [1]));
          }
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
        return { meta, layers, ...(extra && { extra }) };
      },

      async close() {
        if (closed) return;
        closed = true;
        loaded.object.dispose();
        rt.dispose();
        rtPost?.dispose();
        rtDepth?.dispose();
        rtHalf?.dispose();
        copy?.geometry.dispose();
        copy?.material.dispose();
        for (const m of auxMaterials.values()) m.dispose();
      },
    };
    return session;
  }

  return { open };
}
