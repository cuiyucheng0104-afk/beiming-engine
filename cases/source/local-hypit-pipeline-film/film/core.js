// core.js — 全片共用引擎。经典脚本，挂在全局 F 上（file:// 下不能用 ES 模块）。
// 契约：window.__film = { duration, ready, seek(t), shots, marks, events, wav? }；seek(t) 只依赖 t。
'use strict';
(function () {
const F = window.F = {};
const W = F.W = 1920, H = F.H = 1080;
F.FPS = 30; F.BPM = 120; F.BEAT = 0.5; F.BARLEN = 2; F.DURATION = 180;
F.beat = n => n * F.BEAT;           // 第 n 拍的时间（秒）
F.bar = n => n * F.BARLEN;          // 第 n 小节的时间（秒）
const params = new URLSearchParams(location.search);
const SS = F.SS = Math.max(1, Math.round(Number(params.get('ss')) || 1));
F.GRAIN = (window.FILM_GRAIN || 'none') !== 'none';

// ─── utils：全部只依赖参数 ───────────────────────────────────────────────────
const clamp = F.clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = F.smooth = x => { x = clamp(x); return x * x * (3 - 2 * x); };
F.easeIO = x => { x = clamp(x); return x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
F.easeOut = x => { x = clamp(x); return 1 - Math.pow(1 - x, 3); };
F.easeIn = x => { x = clamp(x); return x * x * x; };
F.easeBack = x => { x = clamp(x); const c = 1.4; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };
F.lerp = (a, b, k) => a + (b - a) * k;
F.env = (t, a, b, c, d) => Math.min(smooth((t - a) / (b - a)), 1 - smooth((t - c) / (d - c)));
F.win = (t, a, b) => clamp((t - a) / (b - a));
F.keyed = function (t, keys, log = false) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) if (t <= keys[i][0]) {
    const [t0, v0] = keys[i - 1], [t1, v1] = keys[i], k = F.easeIO((t - t0) / (t1 - t0));
    if (Array.isArray(v0)) return v0.map((v, j) => log ? v * Math.pow(v1[j] / v, k) : v + (v1[j] - v) * k);
    return log ? v0 * Math.pow(v1 / v0, k) : v0 + (v1 - v0) * k;
  }
  return keys[keys.length - 1][1];
};
// 单调三次样条（Fritsch–Carlson）：多个关键帧之间连续、不过冲、不在每个关键帧停住
F.mspline = function (keys) {
  const n = keys.length, xs = keys.map(k => k[0]), ys = keys.map(k => k[1]);
  const d = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], h = a * a + b * b;
    if (h > 9) { const k = 3 / Math.sqrt(h); m[i] = k * a * d[i]; m[i + 1] = k * b * d[i]; }
  }
  return t => {
    if (t <= xs[0]) return ys[0]; if (t >= xs[n - 1]) return ys[n - 1];
    let i = 0; while (t > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], u = (t - xs[i]) / h, u2 = u * u, u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * ys[i] + (u3 - 2 * u2 + u) * h * m[i] + (-2 * u3 + 3 * u2) * ys[i + 1] + (u3 - u2) * h * m[i + 1];
  };
};
F.rng = function (seed) {
  return () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
};
F.canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d')]; };
F.C = {                              // 全片配色（见 production/BIBLE.md）
  plaster: '#E9E4DA', plasterShade: '#C9C2B6', ink: '#1C2436', skyTop: '#0F1626', skyHorizon: '#2B3A55',
  gold: '#F2B45A', window: '#FFCF7A', teal: '#3FB7B0', cold: '#8C96A6', ivory: '#F7F1E5', red: '#D9695F',
};

// ─── 输出画布（2D）与超采样 ─────────────────────────────────────────────────
function supersample(g, k) {
  if (k === 1) return g;
  const C2 = CanvasRenderingContext2D.prototype, st = C2.setTransform;
  g.setTransform = function (a, b, c, d, e, f) { return st.call(this, a * k, b * k, c * k, d * k, e * k, f * k); };
  g.resetTransform = function () { return st.call(this, k, 0, 0, k, 0, 0); };
  for (const p of ['shadowBlur', 'shadowOffsetX', 'shadowOffsetY']) {
    const d = Object.getOwnPropertyDescriptor(C2, p);
    Object.defineProperty(g, p, { get() { return d.get.call(this) / k; }, set(v) { d.set.call(this, v * k); } });
  }
  const fd = Object.getOwnPropertyDescriptor(C2, 'filter');
  Object.defineProperty(g, 'filter', { get() { return fd.get.call(this); }, set(v) { fd.set.call(this, String(v).replace(/(-?[\d.]+)px/g, (m, n) => `${+n * k}px`)); } });
  g.setTransform(1, 0, 0, 1, 0, 0);
  return g;
}
const cv = document.getElementById('c');
cv.width = W * SS; cv.height = H * SS; cv.style.aspectRatio = `${W} / ${H}`;
const ctx = F.ctx = supersample(cv.getContext('2d'), SS);

// ─── three.js 渲染器与后期 ──────────────────────────────────────────────────
const glc = document.createElement('canvas');
const R = F.renderer = new THREE.WebGLRenderer({ canvas: glc, antialias: true, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
R.setPixelRatio(1); R.setSize(W * SS, H * SS, false);
R.outputColorSpace = THREE.SRGBColorSpace;
R.toneMapping = THREE.NeutralToneMapping; R.toneMappingExposure = 1.0;
R.shadowMap.enabled = true; R.shadowMap.type = THREE.PCFSoftShadowMap;
window.__errs = [];
R.debug.onShaderError = (gl, p, vs, fs) => window.__errs.push(gl.getShaderInfoLog(fs) || gl.getShaderInfoLog(vs));

const rt = new THREE.WebGLRenderTarget(W * SS, H * SS, { samples: 4, type: THREE.HalfFloatType });
const composer = new THREE.EffectComposer(R, rt);
composer.setPixelRatio(1); composer.setSize(W * SS, H * SS);
const renderPass = new THREE.RenderPass(new THREE.Scene(), new THREE.PerspectiveCamera());
const bloom = F.bloom = new THREE.UnrealBloomPass(new THREE.Vector2(W * SS, H * SS), .55, .55, 1.05);
const outPass = new THREE.OutputPass();
const grade = new THREE.ShaderPass({
  uniforms: { tDiffuse: { value: null }, uLift: { value: .035 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uLift; varying vec2 vUv;
    void main(){ vec3 c = texture2D(tDiffuse, vUv).rgb;
      vec3 ink = vec3(.075,.095,.15);                          // 暗部抬到深靛，不用纯黑
      c = ink * uLift * 6. + (1. - uLift * 1.2) * c;
      float l = dot(c, vec3(.299,.587,.114));
      c += (1. - smoothstep(0., .35, l)) * vec3(-.006,.004,.018);  // 暗部偏冷
      c += smoothstep(.6, 1., l) * vec3(.010,.004,-.008);        // 亮部偏暖
      gl_FragColor = vec4(clamp(c, 0., 1.), 1.); }`,
});
composer.addPass(renderPass); composer.addPass(bloom); composer.addPass(outPass); composer.addPass(grade);

// ─── 材质 ───────────────────────────────────────────────────────────────────
const col = h => new THREE.Color(h);
F.mat = {
  plaster: new THREE.MeshStandardMaterial({ color: col(F.C.plaster), roughness: .93, metalness: 0 }),
  plasterShade: new THREE.MeshStandardMaterial({ color: col(F.C.plasterShade), roughness: .95, metalness: 0 }),
  plasterDark: new THREE.MeshStandardMaterial({ color: col('#8E8A84'), roughness: .96, metalness: 0 }),
  ink: new THREE.MeshStandardMaterial({ color: col('#2A3246'), roughness: .9, metalness: 0 }),
};
// 发光材质：强度由 t 驱动，每个使用者自己克隆一份再改 emissiveIntensity
F.glow = (hex, intensity = 2) => new THREE.MeshStandardMaterial({ color: col('#000000'), emissive: col(hex), emissiveIntensity: intensity, roughness: 1 });
F.goldMat = () => new THREE.MeshStandardMaterial({ color: col('#B88A3E'), emissive: col(F.C.gold), emissiveIntensity: 0, roughness: .55, metalness: .2 });

// 石膏上"刻字"：画在画布上的凹刻效果，作为 map（字暗、下缘高光）
F.engrave = function (text, { w = 1024, h = 256, size = 120, weight = 600, bg = F.C.plaster, font } = {}) {
  const [c, x] = F.canvas(w, h);
  x.fillStyle = bg; x.fillRect(0, 0, w, h);
  x.font = font || `${weight} ${size}px "PingFang SC", "Hiragino Sans GB", sans-serif`;
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillStyle = 'rgba(255,255,255,.55)'; x.fillText(text, w / 2 + 2, h / 2 + 3);   // 下缘反光
  x.fillStyle = '#6F6A63'; x.fillText(text, w / 2, h / 2);                        // 凹槽阴影
  x.fillStyle = 'rgba(40,36,32,.35)'; x.fillText(text, w / 2 - 1.5, h / 2 - 2);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
};

// ─── 环境：蓝调天空、雾、灯光、模型底板 ─────────────────────────────────────
const SKY = (() => {
  const [c, x] = F.canvas(8, 512);
  const g = x.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0, F.C.skyTop); g.addColorStop(.55, F.C.skyHorizon); g.addColorStop(.72, '#3B4A66'); g.addColorStop(1, '#1C2436');
  x.fillStyle = g; x.fillRect(0, 0, 8, 512);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
})();
const GRID = (() => {
  const [c, x] = F.canvas(512, 512);
  x.fillStyle = F.C.plasterShade; x.fillRect(0, 0, 512, 512);
  x.strokeStyle = 'rgba(90,86,80,.22)'; x.lineWidth = 2;
  for (let i = 0; i <= 512; i += 64) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, 512); x.stroke(); x.beginPath(); x.moveTo(0, i); x.lineTo(512, i); x.stroke(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(60, 60); t.anisotropy = 8; return t;
})();
// makeEnv(scene, opts) → { key, fill, hemi, ground }。每个场景自己的 THREE.Scene 都调用一次。
F.makeEnv = function (scene, { fog = .018, keyDir = [-6, 9, 5], keyInt = 1.7, fillInt = .75, ground = true, shadowBox = 14, target = [0, 0, 0] } = {}) {
  scene.background = SKY;
  scene.fog = new THREE.FogExp2(col('#26324B'), fog);
  const hemi = new THREE.HemisphereLight(col('#8EA6D8'), col('#2C3246'), 1.05); scene.add(hemi);
  const key = new THREE.DirectionalLight(col('#FFDDB0'), keyInt);
  key.position.set(target[0] + keyDir[0], target[1] + keyDir[1], target[2] + keyDir[2]);
  key.target.position.set(...target); scene.add(key); scene.add(key.target);
  key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -.0004; key.shadow.normalBias = .03;
  const sc = key.shadow.camera; sc.left = sc.bottom = -shadowBox; sc.right = sc.top = shadowBox; sc.near = .5; sc.far = 60;
  const fill = new THREE.DirectionalLight(col('#7FA0D0'), fillInt); fill.position.set(target[0] + 7, target[1] + 4, target[2] - 6); scene.add(fill);
  let groundMesh = null;
  if (ground) {
    const gm = new THREE.MeshStandardMaterial({ color: col('#FFFFFF'), map: GRID, roughness: .96 });
    groundMesh = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), gm);
    groundMesh.rotation.x = -Math.PI / 2; groundMesh.receiveShadow = true; scene.add(groundMesh);
  }
  return { key, fill, hemi, ground: groundMesh };
};

// 石膏块：圆角盒子，投射并接收阴影
F.block = function (w, h, d, m = F.mat.plaster, r = .04) {
  const geo = new THREE.RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2 - .001, h / 2 - .001, d / 2 - .001));
  const mesh = new THREE.Mesh(geo, m); mesh.castShadow = true; mesh.receiveShadow = true; return mesh;
};

// ─── 分解图组装：零件从飞散位置回到原位（或反之） ───────────────────────────
// piece = F.piece(obj, { d:[x,y,z], axis:[x,y,z], ang, t0, t1, mode:'gather'|'scatter' })；每次 seek 调 F.poseAll(list, t)
F.piece = function (obj, o) {
  obj.updateMatrix();
  return { obj, home: obj.position.clone(), homeQ: obj.quaternion.clone(), homeS: obj.scale.clone(),
    d: new THREE.Vector3(...(o.d || [0, 3, 0])), axis: new THREE.Vector3(...(o.axis || [1, 0, 0])).normalize(),
    ang: o.ang ?? .35, t0: o.t0, t1: o.t1, mode: o.mode || 'gather', drift: o.drift ?? .25, onLock: o.onLock };
};
const _q = new THREE.Quaternion();
F.pose = function (p, t) {
  let a;
  if (p.mode === 'gather') a = 1 - F.easeOut((t - p.t0) / (p.t1 - p.t0));
  else a = F.easeIn((t - p.t0) / (p.t1 - p.t0)) + (t > p.t1 ? p.drift * (t - p.t1) : 0);
  p.obj.position.copy(p.home).addScaledVector(p.d, a);
  _q.setFromAxisAngle(p.axis, p.ang * a); p.obj.quaternion.copy(p.homeQ).multiply(_q);
  p.obj.scale.copy(p.homeS);
  p.obj.visible = !(p.mode === 'gather' && t < p.t0 - 20);
  return a;
};
F.poseAll = (list, t) => { for (const p of list) F.pose(p, t); };

// ─── 事件表：配乐读取（绝对时间） ───────────────────────────────────────────
// 类型：hit（段落重拍） lock（零件锁定，陶瓷轻碰） gate（关卡放行钟音） tick（数字跳动） whoosh（镜头大动，dur）
//       riser（转折前上升音，dur） thud（石膏块落地） pin（金属钉） paper（纸张展开） gear（齿轮咔哒） rain（雨声，dur） crack（石膏裂）
F.events = [];
F.ev = (t, type, p = {}) => { F.events.push(Object.assign({ t: +t.toFixed(4), type }, p)); };

// ─── 场景表与字幕 ──────────────────────────────────────────────────────────
F.scenes = [];
F.captions = [];                     // { t0, t1, title, body }（绝对时间）
F.addScene = s => { F.scenes.push(s); if (s.captions) F.captions.push(...s.captions); };
F.shots = [];

// 屏幕投影：世界坐标 → 胶片像素
const _v = new THREE.Vector3();
F.project = function (cam, p) {
  _v.set(p.x ?? p[0], p.y ?? p[1], p.z ?? p[2]).project(cam);
  if (_v.z > 1) return null;
  return { x: (_v.x * .5 + .5) * W, y: (-_v.y * .5 + .5) * H, z: _v.z };
};

// 文字：一次烘焙、按胶片像素绘制
const FONT = '"PingFang SC", "Hiragino Sans GB", "Noto Sans SC", sans-serif';
F.FONT = FONT;
const textCache = new Map();
F.bake = function (str, { size = 40, weight = 400, color = F.C.ivory, halo = true, mono = false, align = 'center', track = 0 } = {}) {
  const key = [str, size, weight, color, halo, mono, align, track].join('|');
  if (textCache.has(key)) return textCache.get(key);
  const font = `${weight} ${size}px ${mono ? '"SF Mono", Menlo, monospace' : FONT}`;
  const [, mx] = F.canvas(8, 8); mx.font = font; mx.letterSpacing = `${track}px`;
  const tw = Math.ceil(mx.measureText(str).width), pad = Math.ceil(size * .6);
  const w = tw + pad * 2, h = Math.ceil(size * 1.5) + pad * 2;
  const [c, x] = F.canvas(w * SS, h * SS); x.scale(SS, SS);
  x.font = font; x.letterSpacing = `${track}px`; x.textBaseline = 'middle'; x.textAlign = 'center';
  if (halo) { x.shadowColor = 'rgba(8,12,24,.75)'; x.shadowBlur = size * .45 * SS; x.fillStyle = color; x.fillText(str, w / 2, h / 2); x.shadowBlur = 0; }
  x.shadowColor = 'rgba(8,12,24,.9)'; x.shadowBlur = 1.5 * SS; x.shadowOffsetY = 1 * SS;
  x.fillStyle = color; x.fillText(str, w / 2, h / 2);
  const out = { c, w, h, tw, align };
  textCache.set(key, out); return out;
};
// 在 (x,y) 画一段烘焙文字；align 决定 x 是左/中/右；prog 0→1 做上浮+失焦显现
F.drawText = function (g, sp, x, y, { alpha = 1, prog = 1, align } = {}) {
  const a = alpha * prog; if (a <= .004) return;
  const al = align || sp.align;
  const dx = al === 'left' ? x - (sp.w - sp.tw) / 2 : al === 'right' ? x - sp.w + (sp.w - sp.tw) / 2 : x - sp.w / 2;
  g.save(); g.globalAlpha = Math.min(1, a);
  const blur = (1 - prog) * 6; if (blur > .3) g.filter = `blur(${blur.toFixed(1)}px)`;
  g.drawImage(sp.c, dx, y - sp.h / 2 + (1 - prog) * 14, sp.w, sp.h);
  g.restore();
};
F.label = (g, str, x, y, o = {}) => F.drawText(g, F.bake(str, o), x, y, o);

// 固定字幕块：下三分之一，居中；标题 + 金色细线 + 正文
const CAP_Y = 872;
function drawCaptions(t) {
  for (const c of F.captions) {
    if (t < c.t0 - .05 || t > c.t1 + .05) continue;
    const pin = F.easeOut((t - c.t0) / .45), out = 1 - smooth((t - (c.t1 - .3)) / .3);
    const a = Math.min(pin, out);
    if (a <= .004) continue;
    const hasBody = !!c.body;
    const ty = hasBody ? CAP_Y : CAP_Y + 28;
    if (c.title) F.drawText(ctx, F.bake(c.title, { size: 62, weight: 600 }), W / 2, ty, { prog: pin, alpha: out });
    if (hasBody) {
      const lw = 90 * F.easeOut((t - c.t0 - .12) / .5);
      ctx.save(); ctx.globalAlpha = out * .9; ctx.fillStyle = F.C.gold; ctx.fillRect(W / 2 - lw / 2, ty + 46, lw, 2); ctx.restore();
      const bp = F.easeOut((t - c.t0 - .18) / .45);
      F.drawText(ctx, F.bake(c.body, { size: 38, weight: 400, color: '#E8DFCF' }), W / 2, ty + 92, { prog: bp, alpha: out });
    }
  }
}

// ─── 画框：暗角、颗粒、首尾黑场 ─────────────────────────────────────────────
const VIGNETTE = (() => {
  const [c, x] = F.canvas(W, H);
  const g = x.createRadialGradient(W / 2, H / 2, H * .45, W / 2, H / 2, W * .72);
  g.addColorStop(0, 'rgba(8,10,20,0)'); g.addColorStop(1, 'rgba(8,10,20,.42)');
  x.fillStyle = g; x.fillRect(0, 0, W, H); return c;
})();
let GRAINS = null;
function grainAt(t) {
  if (!F.GRAIN) return;
  if (!GRAINS) GRAINS = [0, 1, 2].map(i => { const [c, x] = F.canvas(256, 256), id = x.createImageData(256, 256), r = F.rng(900 + i);
    for (let k = 0; k < id.data.length; k += 4) { const v = r() * 255; id.data[k] = id.data[k + 1] = id.data[k + 2] = v; id.data[k + 3] = 8; }
    x.putImageData(id, 0, 0); return ctx.createPattern(c, 'repeat'); });
  const f = Math.round(t * 30), gx = (f * 97) % 256, gy = (f * 57) % 256;
  ctx.setTransform(1, 0, 0, 1, gx, gy); ctx.fillStyle = GRAINS[f % 3]; ctx.fillRect(-gx, -gy, W, H); ctx.setTransform(1, 0, 0, 1, 0, 0);
}

// ─── seek ──────────────────────────────────────────────────────────────────
F.sceneAt = t => F.scenes.find(s => t >= s.t0 && t < s.t1) || F.scenes[F.scenes.length - 1];
F.fadeOut = [176, 179.6];            // 结尾渐隐到黑
function seek(t) {
  t = clamp(t, 0, F.DURATION - 1e-6);
  const s = F.sceneAt(t), tl = t - s.t0;
  s.seek(tl, t);
  bloom.strength = s.bloom ? s.bloom(tl, t) : .55;
  R.toneMappingExposure = s.exposure ? s.exposure(tl, t) : 1;
  renderPass.scene = s.scene3; renderPass.camera = s.camera;
  composer.render();
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  ctx.drawImage(glc, 0, 0, W, H);
  if (s.overlay) { ctx.save(); s.overlay(ctx, tl, t); ctx.restore(); }
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.filter = 'none';
  drawCaptions(t);
  ctx.drawImage(VIGNETTE, 0, 0, W, H);
  grainAt(t);
  const black = smooth((t - F.fadeOut[0]) / (F.fadeOut[1] - F.fadeOut[0]));
  if (black > 0) { ctx.fillStyle = `rgba(0,0,0,${black})`; ctx.fillRect(0, 0, W, H); }
}
F.seek = seek;

// ─── 启动：等字体、图片、编译完才 ready ────────────────────────────────────
F.images = [];                       // 复刻截帧 Image（frames.js 提供 base64）
F.seqImages = [];
function loadImg(src) { return new Promise(r => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = src; }); }
F.boot = async function () {
  await document.fonts.load(`600 62px ${FONT}`, '每一关都有证据');
  await document.fonts.load(`400 38px ${FONT}`, '结构');
  F.images = await Promise.all((window.FILM_FRAMES || []).map(loadImg));
  F.seqImages = await Promise.all((window.FILM_SEQ || []).map(loadImg));
  F.scenes.sort((a, b) => a.t0 - b.t0);
  for (const s of F.scenes) {
    const r = s.build(); s.scene3 = r.scene; s.camera = r.camera;
    s.camera.aspect = W / H; s.camera.updateProjectionMatrix();
    F.shots.push({ id: s.id, start: s.t0, end: s.t1 });
  }
  F.events.sort((a, b) => a.t - b.t);
  for (const s of F.scenes) { s.seek(0, s.t0); R.compile(s.scene3, s.camera); }
  for (const s of F.scenes) { seek(s.t0 + .01); }   // 每个场景热身一帧
  seek(0);
  window.__film.ready = true;
};

window.__film = { duration: F.DURATION, ready: false, seek, get shots() { return F.shots; }, get marks() { return F.scenes.map(s => s.t0); }, get events() { return F.events; } };
})();
