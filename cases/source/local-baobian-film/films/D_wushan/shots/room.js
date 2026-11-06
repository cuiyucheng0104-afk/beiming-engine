// 《豹变》D 雾山 · 修复室（ROOM）：#01 S1（戴上眼镜）、#02 T1 前半（六爻浮起、钻进上六断口）、#17 S6（回现实、光斑、题字）
// 桌面 y = 0；书居中，书脊沿 z，读者在 +z，窗在 −z（北）。左页卦画 ䷰（自下而上：阳 阴 阳 阳 阳 阴）。
import * as THREE from 'three';
import { toon, bind, setToonGlobals } from '../lib/toond.js';
import { makeSprite, faceCam, rimOffset } from '../lib/sprite.js';
import { GLSL } from '../lib/glsl.js';
import { DEG, clamp, lerp, seg, ss, ss5, eo, ei, eio, track, aim, s2w, w2s, pxPerM, lin3, fovOf, hashi } from '../lib/util.js';

// ── 书的尺寸（米）──
const PB = .0075;                                  // 页面底（封板 3 mm + 页堆 4.5 mm）
const pageH = s => .005 * Math.sin(Math.PI * Math.min(s / .17, 1)) - .0012 * (1 - ss(s / .03)) + .0015 * ss((s - .17) / .03);   // s：离书脊的距离
const HEX = { x: -.105, len: .090, thick: .0085, z: [.015, -.001, -.017, -.033, -.049, -.065], yin: [0, 1, 0, 0, 0, 1], gap: .018 };
const PH = PB + pageH(.1);                         // 卦画处页面高度
export const ROOM_Y = PH;

const VS_W = /* glsl */`varying vec2 vUv; varying vec3 vW, vNW; void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; vNW = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`;

// 书页：贴图 + 代码卦画 + 无限放大的纸 + 受光两阶硬分 + 书沟暗面
const PAGE_FS = /* glsl */`
${GLSL}
uniform sampler2D uTex; uniform vec4 uCrop; uniform vec2 uTexPx; uniform float uBias, uLeft, uInk[6], uGlint, uMag, uDap, uDapT, uSoft;
uniform vec3 uKey, uLit, uShade; uniform vec4 uPage;   // 页面范围 x0, z0, x1, z1（米）
uniform vec2 uRes; uniform float uK; uniform vec4 uBeam;
varying vec2 vUv; varying vec3 vW, vNW;
float hexInk(vec2 q){
  // q：页面米制坐标 (x, z)。六爻：长 0.090、粗 0.0085、阴爻断口 0.018
  float ink = 0.;
  float zs[6] = float[6](${HEX.z.join(', ')});
  float yin[6] = float[6](${HEX.yin.join('., ')}.);
  for (int i = 0; i < 6; i++) {
    vec2 d = vec2(q.x - (${HEX.x}), q.y - zs[i]);
    vec2 rq = mat2(.8, .6, -.6, .8) * q;
    float n = (fbm2(rq * 700. + float(i) * 7.) - .5) * .0007 + (fbm2(rq * 180. + float(i)) - .5) * .0005;
    float bx = .045 + n, by = .00425 + n * .6, e = .00035 + uSoft;
    float m = (1. - smoothstep(bx - e, bx + e, abs(d.x))) * (1. - smoothstep(by - e, by + e, abs(d.y)));
    if (yin[i] > .5) m *= smoothstep(.009 - e, .009 + e, abs(d.x) + n * .5);
    float uneven = .86 + .14 * fbm2(rq * 160. + float(i) * 3.);
    ink = max(ink, m * uneven * uInk[i]);
  }
  return ink;
}
void main(){
  vec2 uv = uCrop.xy + vUv * uCrop.zw;
  vec3 c = srgb2lin(texture2D(uTex, uv, uBias).rgb);
  vec2 q = vW.xz;
  if (uLeft > .5) {
    float k = hexInk(q);
    c = mix(c, srgb2lin(vec3(.118, .102, .086)), k * .92);
    // 爻醒了：一道金色高光沿六爻扫过
    if (uGlint > 0.) { float g = exp(-pow((q.x - mix(-.16, -.05, uGlint)) / .012, 2.)) * k; c += vec3(.95, .55, .12) * g * .9; }
  }
  // 无限放大的纸：一个贴图像素在屏幕上大于 1 px 时淡入程序化纸纤维（0.4 / 1.2 / 4 mm 三级各向异性噪声）
  float tpp = length(fwidth(vUv * uCrop.zw * uTexPx));
  float mag = (1. - smoothstep(.35, 1.1, tpp)) * uMag;
  if (mag > 0.) {
    vec2 m = q * 1000.;     // 毫米
    float f1 = vnoise2(vec2(m.x / .4, m.y / 2.4)), f2 = vnoise2(vec2(m.x / 1.2, m.y / 7.) + 3.), f3 = vnoise2(vec2(m.x / 4., m.y / 20.) + 7.);
    float fib = .5 * f1 + .3 * f2 + .2 * f3;
    c *= mix(1., .86 + .28 * fib, mag);
  }
  // 受光：两阶硬分（阈值 0.5），书沟一侧落进暗面
  float ndl = dot(normalize(vNW), normalize(uKey)) * .5 + .5;
  float lit = smoothstep(.47, .53, ndl);
  c *= mix(uShade, uLit, lit);
  if (uDap > 0.) {
    // 光斑（S6）：书页上只落在窗光光束里，柔边光团，一簇簇；光束里先是叶影
    vec2 sp = vec2((gl_FragCoord.x - uRes.x * .5) / uK + 960., (uRes.y - gl_FragCoord.y) / uK);
    float bm = beamMaskAt(sp, uBeam.x, uBeam.yz);
    vec2 g = q / .03, gi = floor(g); float L = 0.;
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      vec2 cc = gi + vec2(float(i), float(j)); vec2 h = hash22(cc + 5.1);
      vec2 cp = (cc + .5 + (h - .5) * .8) * .03 + vec2(.004 * sin(.9 * uDapT), .002 * sin(1.3 * uDapT + 1.)) + vec2(.0015 * sin(1.7 * uDapT + h.x * 6.), 0.);
      if (vnoise2(cp * 11. + 2.) * .65 + vnoise2(cp * 30.) * .35 < .56) continue;
      vec2 p = (q - cp) / (.009 * (.8 + .4 * h.y)); p.x /= 1.25;
      L = max(L, lightBlob(p, h.x * 97., .6) * (.6 + .4 * h.y) * (.5 + .5 * (1. - smoothstep(0., 1.05, length(p)))));
    }
    c *= mix(1., .8, bm * uDap * (1. - L));
    c += c * vec3(1., .84, .52) * L * bm * uDap * 1.5 + vec3(1., .87, .53) * L * L * bm * uDap * .1;   // 返修 3：光照亮纸面（按纸色提亮），不是贴一块奶白
  }
  gl_FragColor = vec4(c, 1.);
}`;

// 桌面：底板贴图 + 窗棂方格光（乘法）+ 近视虚焦（mip 偏移）+ 光斑
const DESK_FS = /* glsl */`
${GLSL}
uniform sampler2D uTex; uniform float uBias, uLattice, uDap, uDapT; uniform vec3 uMul; uniform vec4 uCrop; uniform vec2 uRes; uniform float uK; uniform vec4 uBeam; uniform vec2 uDapC;
varying vec2 vUv; varying vec3 vW, vNW;
void main(){
  vec3 c = srgb2lin(texture2D(uTex, uCrop.xy + vUv * uCrop.zw, uBias).rgb) * uMul;
  // 窗棂光：从左上（窗）斜投在桌上的暖色方格（只在桌面）
  vec2 q = vW.xz;
  vec2 lq = mat2(.92, .38, -.38, .92) * (q - vec2(-.55, -.45)) / vec2(.085, .11);
  vec2 fq = abs(fract(lq) - .5);
  float bars = smoothstep(.40, .46, max(fq.x, fq.y));
  float pool = smoothstep(1.2, .2, length((q - vec2(-.34, -.30)) / vec2(.55, .4)));
  c *= 1. + uLattice * pool * (.55 * (1. - bars) - .25 * bars);
  if (uDap > 0.) {
    // 桌面上的光斑：只在光束里、只在书和手边（离书心越远越少），柔边光团
    vec2 sp = vec2((gl_FragCoord.x - uRes.x * .5) / uK + 960., (uRes.y - gl_FragCoord.y) / uK);
    float bm = beamMaskAt(sp, uBeam.x, uBeam.yz);
    vec2 g = q / .07, gi = floor(g); float L = 0.;
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      vec2 cc = gi + vec2(float(i), float(j)); vec2 h = hash22(cc + 9.3);
      vec2 cp = (cc + .5 + (h - .5) * .8) * .07 + vec2(.006 * sin(.9 * uDapT), .003 * sin(1.3 * uDapT + 1.));
      if (vnoise2(cp * 5. + 2.) * .65 + vnoise2(cp * 14.) * .35 < .6) continue;
      if (length(cp - uDapC) > .38) continue;
      vec2 p = (q - cp) / (.018 * (.8 + .5 * h.y)); p = mat2(.85, .53, -.53, .85) * p; p.x /= 1.3;
      L = max(L, lightBlob(p, h.x * 97., .6) * (.6 + .4 * h.y) * (.5 + .5 * (1. - smoothstep(0., 1.05, length(p)))));
    }
    c *= mix(1., .8, bm * uDap * (1. - L));
    c += c * vec3(1., .78, .45) * L * bm * uDap * 2.6 + vec3(1., .8, .45) * L * L * bm * uDap * .06;   // 返修 3：木面上的光斑是被照亮的暖琥珀色，不是白片
  }
  gl_FragColor = vec4(c, 1.);
}`;

// 卦爻浮条：墨 → 金 → 云白，印刷毛边 → 云的撕边，HDR 起晕
const BAR_FS = /* glsl */`
${GLSL}
uniform float uL, uSeed, uT, uFade; uniform vec3 uInkC, uGoldC, uCloudC, uRimC;
varying vec2 vUv; varying vec3 vW, vNW;
void main(){
  float u = vUv.x, v = vUv.y;
  // 静止时：和纸上那一画完全重合的印刷条；浮起后：边缘被撕开、两端拉成丝的云带
  float k = smoothstep(.12, .7, uL);
  float n1 = fbm2(vec2(u * 26. - uT * 1.2, v * 3.) + uSeed), n2 = fbm2(vec2(u * 7. - uT * .5, v * 1.5) + uSeed * 2.);   // 横向流动
  float y = (v - .5) * 2.;
  float halfT = mix(1., .78 + .5 * (n2 - .5), k);
  float endT = mix(.05, .22, k);
  float ends = smoothstep(0., endT, u + (n1 - .5) * .1 * k) * smoothstep(1., 1. - endT, u - (n1 - .5) * .1 * k);
  float body = 1. - smoothstep(halfT - mix(.08, .45, k), halfT, abs(y) + (n1 - .5) * .6 * k);
  float a = body * ends;
  a = mix(a, a * smoothstep(.15, .55, n1 + .25), k * .6);
  vec3 c = mix(uInkC, uGoldC, smoothstep(.08, .3, uL));
  c = mix(c, uCloudC, k * .72);
  // 墨色芯：云带中线留一线墨（印出来的那一画还在），撕边扩到整条
  c = mix(c, mix(uInkC, uGoldC, .35), (1. - smoothstep(.0, .32, abs(y + (n2 - .5) * .3))) * .32 * k);
  // 金色上沿：约 35% 的厚度
  float rim = smoothstep(.3, .75, y + (n1 - .5) * .3) * step(.3, uL);
  c = mix(c, uRimC * 1.15, rim * .85);
  float hdr = mix(1., 2.2, smoothstep(.3, .9, uL));
  gl_FragColor = vec4(c * hdr, clamp(a, 0., 1.) * mix(1., .9, k) * uFade);
}`;

// 镜片：近乎透明，菲涅耳边亮
const LENS_FS = /* glsl */`
uniform float uA; varying vec2 vUv; varying vec3 vW, vNW;
void main(){ vec3 V = normalize(cameraPosition - vW); float fr = pow(1. - abs(dot(normalize(vNW), V)), 3.); vec2 d = vUv - .5;
  float glint = smoothstep(.06, 0., abs(d.x + d.y * .6 - .12)) * .5;
  gl_FragColor = vec4(vec3(1., .95, .85), clamp((.06 + fr * .5 + glint) * uA, 0., 1.)); }`;

// 窗与墙（S6）：暖金过曝的远处亮窗、窗棂、窗外叶团，整体景深模糊（在着色器里按低频画出来）
const WIN_FS = /* glsl */`
${GLSL}
uniform float uT, uA; uniform vec2 uSize;
varying vec2 vUv;
void main(){
  vec2 p = vUv * uSize;                         // 米
  vec2 wc = vec2(uSize.x * .66, uSize.y * .62);  // 窗的中心
  vec2 ws = vec2(uSize.x * .22, uSize.y * .30);
  vec2 d = abs(p - wc) / ws;
  float win = 1. - smoothstep(.92, 1.06, max(d.x, d.y));
  // 窗外：过曝暖光 + 叶团（虚）：上部三团叶子剪影随风轻摆（和光斑同一相位），光斑就是从这里筛下来的
  vec2 wind = vec2(.06 * sin(.9 * uT), .03 * sin(1.3 * uT + 1.));
  float leaf = fbm2(p * 3.2 + vec2(uT * .05, 0.) + wind * 6.);
  float clumps = 0.;
  for (int i = 0; i < 3; i++) { float fi = float(i); vec2 cc = wc + vec2((fi - 1.) * ws.x * .75 + .08 * sin(fi * 2.3), ws.y * (.55 - .25 * mod(fi, 2.))) + wind * (1. + fi * .3);
    clumps = max(clumps, 1. - smoothstep(.55, 1.15, length((p - cc) / vec2(ws.x * .42, ws.y * .3)) + (leaf - .5) * .7)); }
  float lm = max(smoothstep(.56, .72, leaf) * (.35 + .45 * smoothstep(.2, .9, vUv.y)), clumps * .9);
  vec3 glow = mix(vec3(.92, .67, .26), vec3(1., .89, .58), smoothstep(.0, 1., 1. - length(d) * .7));
  vec3 outside = mix(glow * 1.25, mix(vec3(.36, .48, .12), vec3(.11, .19, .04), smoothstep(.62, .8, leaf)), lm * .78);   // 返修 3（story-04③）：叶团压深一档，看得出光斑是从这些叶缝里筛下来的
  // 窗棂：暖褐细格（虚）
  vec2 g = fract((p - wc) / vec2(ws.x * .5, ws.y * .5) + .5);
  float bar = 1. - smoothstep(.0, .06, min(min(g.x, 1. - g.x), min(g.y, 1. - g.y)));
  outside = mix(outside, vec3(.10, .045, .015), bar * .75 * win);
  // 墙：暗暖褐，靠窗处被照亮
  vec3 wall = mix(vec3(.018, .010, .006), vec3(.16, .07, .02), smoothstep(1.9, 1.0, max(d.x, d.y)));
  vec3 c = mix(wall, outside, win);
  gl_FragColor = vec4(c * uA, 1.);
}`;

export function buildRoom(ctx) {
  const { W, H, K, tex, M } = ctx;
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(31.13, W / H, .01, 30);
  const key = new THREE.DirectionalLight('#ffffff', 1); scene.add(key, key.target);
  const KEY = new THREE.Vector3(-.45, .75, -.5).normalize();
  const tagM = (m, order = 0) => { m.renderOrder = order; m.frustumCulled = false; m.userData.outline = false; return m; };

  // ── 桌面（A11）──
  const BEAM_U = () => ({ uRes: { value: new THREE.Vector2(W, H) }, uK: { value: K }, uBeam: { value: new THREE.Vector4((180 - 28) * DEG, 1760, -60, 1) } });
  const deskU = { uTex: { value: tex.desk }, uBias: { value: 0 }, uLattice: { value: .5 }, uDap: { value: 0 }, uDapT: { value: 0 }, uMul: { value: new THREE.Vector3(1, 1, 1) }, uCrop: { value: new THREE.Vector4(0, 0, 1, 1) }, uDapC: { value: new THREE.Vector2() }, ...BEAM_U() };
  const DW = 1.1, DD = .62;
  const desk = tagM(new THREE.Mesh(new THREE.PlaneGeometry(DW, DD), new THREE.ShaderMaterial({ uniforms: deskU, vertexShader: VS_W, fragmentShader: DESK_FS })), 0);
  desk.rotation.x = -Math.PI / 2; desk.position.set(-(0.523 - .5) * DW, 0, -(0.59 - .5) * DD); desk.userData.outlineOccluder = 'solid';
  scene.add(desk);
  // S6 用更大的桌面（同一张图，往远处延伸）
  //   返修 1：S6 的桌面只取 A11 中间那块空木面（不再把砚台、青瓷碗、笔按正俯视的样子斜着压扁）
  const deskU2 = { ...deskU, uBias: { value: 0 }, uLattice: { value: 0 }, uDap: { value: 1 }, uDapT: { value: 0 }, uMul: { value: new THREE.Vector3(.9, .86, .82) }, uCrop: { value: new THREE.Vector4(.2, .02, .62, .78) }, uDapC: { value: new THREE.Vector2() }, ...BEAM_U() };
  const desk2 = tagM(new THREE.Mesh(new THREE.PlaneGeometry(DW, DD), new THREE.ShaderMaterial({ uniforms: deskU2, vertexShader: VS_W, fragmentShader: DESK_FS })), 0);
  desk2.rotation.x = -Math.PI / 2; desk2.userData.outlineOccluder = 'solid'; desk2.scale.set(2.2, 2.2, 1); desk2.position.set(.1, -.0005, -.25); scene.add(desk2);

  // ── 书：封板 + 页堆 + 两页曲面 ──
  // 返修 3（style-20）：靛蓝布面上一层细密的织物斑驳（不再是平涂的卡纸）
  const mCover = toon('book_cover', { dabAmt: .07, dabScale: 260 }), mStack = toon('wood', { color: '#E3D5B8', shade1: '#A8946E', rimAmt: .3, outline: .7 });
  const book = new THREE.Group(); scene.add(book);
  const cover = bind(new THREE.Mesh(new THREE.BoxGeometry(.43, .003, .30), mCover), mCover); cover.position.y = .0015; book.add(cover);
  for (const sx of [-1, 1]) { const st = bind(new THREE.Mesh(new THREE.BoxGeometry(.192, .0045, .274), mStack), mStack, { group: 'stack' }); st.position.set(sx * .104, .003 + .00225 - .0016, 0); book.add(st); }
  // 左页画布：R01 左页降饱和 ×0.65、往 #E3D5B8 拉 + 「革」+ 两小列字（马善政楷书）；卦画在着色器里画
  const leftCv = (() => {
    const cv = document.createElement('canvas'); cv.width = 2048; cv.height = 2867; const g = cv.getContext('2d');
    const P = M.book['左页纸'].px, img = tex.book.image;
    g.drawImage(img, P[0], P[1], P[2] - P[0], P[3] - P[1], 0, 0, 2048, 2867);
    const id = g.getImageData(0, 0, 2048, 2867), d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      const l = .2126 * d[i] + .7152 * d[i + 1] + .0722 * d[i + 2];
      for (let k = 0; k < 3; k++) { const v = l + (d[i + k] - l) * .65; d[i + k] = v * .7 + [227, 213, 184][k] * .3; }
    }
    g.putImageData(id, 0, 0);
    // 文字：页面米 → 画布像素（x：−0.205 → 0；z：−0.14 → 0）
    const X = x => (x + .205) / .2 * 2048, Z = z => (z + .14) / .28 * 2867;
    g.fillStyle = 'rgba(30,26,22,.9)'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `${.022 / .28 * 2867}px MSZ`; g.fillText('革', X(-.105), Z(-.095));
    g.font = `${.016 / .28 * 2867}px MSZ`;
    [['君子豹变', -.090], ['其文蔚也', -.120]].forEach(([s, x]) => [...s].forEach((ch, i) => g.fillText(ch, X(x), Z(.035 + i * .0235 + .008))));
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.NoColorSpace; t.anisotropy = 8; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.needsUpdate = true;
    return t;
  })();
  const mkPage = left => {
    const g = new THREE.PlaneGeometry(.2, .28, 64, 72); g.rotateX(-Math.PI / 2);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) { const lx = p.getX(i); const s = left ? (.1 - lx) : (lx + .1); p.setY(i, pageH(s)); }
    g.computeVertexNormals();
    const P = left ? M.book['左页纸'].px : M.book['右页纸'].px, iw = tex.book.image.width, ih = tex.book.image.height;
    const u = { uTex: { value: left ? leftCv : tex.book }, uCrop: { value: left ? new THREE.Vector4(0, 0, 1, 1) : new THREE.Vector4(P[0] / iw, 1 - P[3] / ih, (P[2] - P[0]) / iw, (P[3] - P[1]) / ih) },
      uTexPx: { value: left ? new THREE.Vector2(2048, 2867) : new THREE.Vector2(iw, ih) }, uBias: { value: 0 }, uLeft: { value: left ? 1 : 0 }, uSoft: { value: 0 }, uInk: { value: [1, 1, 1, 1, 1, 1] }, uGlint: { value: 0 }, uMag: { value: 1 },
      uKey: { value: KEY.clone() }, uLit: { value: new THREE.Vector3(1.04, 1, .95) }, uShade: { value: new THREE.Vector3(.74, .66, .56) }, uPage: { value: new THREE.Vector4() }, uDap: { value: 0 }, uDapT: { value: 0 }, ...BEAM_U() };
    const m = tagM(new THREE.Mesh(g, new THREE.ShaderMaterial({ uniforms: u, vertexShader: VS_W, fragmentShader: PAGE_FS })), 1);
    m.position.set(left ? -.105 : .105, PB, 0); m.userData.u = u; m.userData.outline = true; m.userData.outlineWidth = 1; m.userData.outlineGroup = 'page' + (left ? 'L' : 'R');
    book.add(m); return m;
  };
  const pageL = mkPage(true), pageR = mkPage(false);

  // ── 卦爻浮条（8 片）──
  const bars = [];
  HEX.z.forEach((z, i) => {
    const halves = HEX.yin[i] ? [-1, 1] : [0];
    for (const hs of halves) {
      const len = HEX.yin[i] ? (HEX.len - HEX.gap) / 2 : HEX.len;
      const g = new THREE.PlaneGeometry(len, HEX.thick, 96, 6); g.rotateX(-Math.PI / 2);
      const u = { uL: { value: 0 }, uSeed: { value: i * 3.7 + hs }, uT: { value: 0 }, uFade: { value: 1 }, uInkC: { value: lin3('#1E1A16') }, uGoldC: { value: lin3('#EAA628') }, uCloudC: { value: lin3('#F3EBD8') }, uRimC: { value: lin3('#F2B33D') } };
      const m = tagM(new THREE.Mesh(g, new THREE.ShaderMaterial({ uniforms: u, vertexShader: VS_W, fragmentShader: BAR_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide })), 3);
      m.userData.u = u; m.userData.i = i; m.userData.hs = hs; m.userData.len = len; m.userData.z = z;
      book.add(m); bars.push(m);
    }
  });
  function placeBars(fr, t) {
    for (const m of bars) {
      const i = m.userData.i, hs = m.userData.hs;
      const Li = eo((fr - (84 + 1.3 * i)) / 8);
      const hop = (fr >= 84.5 && fr <= 86.5) ? .002 : 0;
      const h = (.004 + .0016 * i) * Li + .0005 + hop * Li;
      const ext = i === 5 ? 1 + 2.5 * Li * Li : 1 + .9 * Li * Li;           // 返修 1：只有上六的两半出画，其余五画留在画里、跟着纸一起放大
      let x = HEX.x;
      if (hs !== 0) {
        const half = m.userData.len / 2, c0 = HEX.gap / 2 + half;          // 每半的中心离卦心 0.027 m
        const door = i === 5 ? .0065 * Li : .004 * Li;                       // 上六两半像两扇门一样分开（镜头钻进断口时从画面两边擦过）
        x = HEX.x + hs * (c0 + half * (ext - 1) + door);
      }
      m.position.set(x, PH + h, m.userData.z);
      m.position.y += .0015 * Li * Math.sin(x * 180 - 9 * t + i);
      m.scale.set(ext, 1, 1);
      m.userData.u.uL.value = Li; m.userData.u.uT.value = t;
      m.visible = Li > .001;
    }
  }
  // ── 镊子、眼镜（3D metal）──
  const mMetal = toon('metal');
  const tweez = new THREE.Group();
  for (const sz of [-1, 1]) { const b = bind(new THREE.Mesh(new THREE.BoxGeometry(.11, .0012, .004), mMetal), mMetal, { group: 'tweez' }); b.position.set(-.055, 0, sz * .0022); b.rotation.y = sz * .03; tweez.add(b); }
  scene.add(tweez);
  const glasses = new THREE.Group();
  const lensMat = new THREE.ShaderMaterial({ uniforms: { uA: { value: 1 } }, vertexShader: VS_W, fragmentShader: LENS_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const temples = [];
  for (const sx of [-1, 1]) {
    const rim = bind(new THREE.Mesh(new THREE.TorusGeometry(.021, .0011, 8, 48), mMetal), mMetal, { group: 'glasses' }); rim.position.set(sx * .025, 0, 0); glasses.add(rim);
    const lens = tagM(new THREE.Mesh(new THREE.CircleGeometry(.0205, 40), lensMat), 6); lens.position.set(sx * .025, 0, 0); glasses.add(lens);
    const hinge = new THREE.Group(); hinge.position.set(sx * .046, .004, 0); glasses.add(hinge);
    const tm = bind(new THREE.Mesh(new THREE.CylinderGeometry(.0008, .0008, .085, 6), mMetal), mMetal, { group: 'glasses' }); tm.rotation.x = Math.PI / 2; tm.position.z = -.0425; tm.position.y = sx * .0012; hinge.add(tm);
    temples.push({ hinge, sx });
  }
  const bridge = bind(new THREE.Mesh(new THREE.TorusGeometry(.0045, .0009, 6, 16, Math.PI), mMetal), mMetal, { group: 'glasses' }); bridge.position.set(0, .006, 0); glasses.add(bridge);
  scene.add(glasses);

  // ── 手（A07）──
  const hand = makeSprite(tex.handsDesk, null, { mode: 2, order: 8 });
  hand.u.uHT.value.set(.65, .50);
  hand.poses = { p1: { rect: M.handsDesk[0].rect }, p2: { rect: M.handsDesk[1].rect } };
  scene.add(hand.group);
  // 陆蔚伏案（A06，S6）
  const lu = makeSprite(tex.luDesk, null, { mode: 2, order: 9 });
  lu.setRect([0, 0, tex.luDesk.image.width, tex.luDesk.image.height]); lu.u.uHT.value.set(.65, .51);
  scene.add(lu.group);
  // 窗与墙（S6）：整面墙，窗开在右上
  const winU = { uT: { value: 0 }, uA: { value: 1 }, uSize: { value: new THREE.Vector2(6, 3.4) } };
  const win = tagM(new THREE.Mesh(new THREE.PlaneGeometry(6, 3.4), new THREE.ShaderMaterial({ uniforms: winU, vertexShader: VS_W, fragmentShader: WIN_FS })), -1);
  scene.add(win);
  // 椅背（S6 拉镜时从画面下缘进来，压住他的后背）
  const mChair = toon('wood', { color: '#4A2A14', shade1: '#1E110A', rimColor: '#F3C77A', rimAmt: .9, outline: 1 });
  const chair = new THREE.Group();
  { const back = bind(new THREE.Mesh(new THREE.BoxGeometry(.52, .42, .03, 4, 4, 1), mChair), mChair, { group: 'chair' }); back.position.y = .21; chair.add(back);
    const rail = bind(new THREE.Mesh(new THREE.CylinderGeometry(.022, .022, .6, 12), mChair), mChair, { group: 'chair' }); rail.rotation.z = Math.PI / 2; rail.position.y = .43; chair.add(rail); }
  scene.add(chair);

  // ── 机位 ──
  const S1 = track([
    [0, [0, .46, .30, 0, -56.5, 0, 35]],
    [46, [0, .46, .30, 0, -56.5, 0, 35]],
    [70, [-.05, .385 + (PH - .0012) * .2, .20, 13.7, -59.0, -.8, 40]],
  ]);
  const dy0 = PH - .0012;   // 设计里的页面高 → 本片页面高
  const T1 = track([
    [70, [-.05, .385 + dy0 * .2, .20, 13.7, -59.0, -.8, 40]],
    [84, [-.075, .33 + dy0 * .4, .13, 11, -64.4, -1.2, 40]],
    [92, [-.105, .251 + dy0, .011, 0, -72.3, 0, 32]],
    [97, [-.105, .038 + dy0, -.061, 0, -80, 0, 26]],
    [98, [-.105, .027 + dy0, -.063, 0, -83, 0, 25]],
    [99.999, [-.105, .015 + dy0, -.065, 0, -86.5, 0, 23.6]],
  ]);
  // 曲线：f46–f70 ss5，f70–f84 ei（各分量单调插值上再套缓动）
  function camS1(fr) {
    if (fr <= 46) return S1(fr);
    if (fr <= 70) { const u = ss5(seg(fr, 46, 70)); return S1(46 + 24 * u); }
    if (fr <= 84) { const u = ei(seg(fr, 70, 84)) * .6 + seg(fr, 70, 84) * .4; return T1(70 + 14 * u); }
    const u = seg(fr, 84, 100); const e = u < .5 ? u * .9 : .45 + (u - .5) * 1.1; return T1(84 + 16 * Math.min(1, e));
  }
  // S6：过右肩近景 → 中景
  const C17 = { pos0: new THREE.Vector3(.02, .62, .78), yaw0: 0, pitch0: -32 };

  // 手的关键帧（设计像素：锚点 = 镊尖 / 食指尖 / 捏合点；sc 缩放；rot 屏幕内旋转，度）
  function handPose(f2) {
    if (f2 <= 11) return { pose: 'p1', at: [1420 + 2 * Math.sin(f2), 500], sc: 1, rot: .4 * Math.sin(f2 * 1.7), anchor: 'tip' };
    if (f2 <= 30) { const u = eio(seg(f2, 12, 30)); return { pose: 'p1', at: [lerp(1420, 1640, u), lerp(500, 900, u)], sc: lerp(1, .96, u), rot: 0, anchor: 'tip' }; }
    if (f2 <= 33) return { pose: 'p1', at: [1640, 900], sc: .96, rot: 0, anchor: 'tip' };
    if (f2 <= 40) { const u = eo(seg(f2, 34, 40)); return { pose: 'p2', at: [lerp(1600, 1450, u), lerp(860, 700, u)], sc: .96, rot: -8 * u, anchor: 'index' }; }
    if (f2 <= 45) return { pose: 'p2', at: [1450, 700], sc: .96, rot: -8, anchor: 'index' };
    if (f2 <= 47) return { pose: 'p2', at: [1390, 830], sc: .97, rot: -4, anchor: 'index' };
    if (f2 <= 49) return { pose: 'p1', at: [1330, 950], sc: .98, rot: 0, anchor: 'pinch' };
    // f50–f58（返修 1）：手捏着镜梁，和眼镜绑在一起——捏合点就是眼镜的屏幕位置；先升起一点，再朝镜头送过来，
    //   手放大 1 → 2.5 倍，f58 和眼镜一起从画面下缘出画（眼镜不再自己飘、不再穿进桌面）
    const g = glassPath(f2);
    return { pose: 'p1', at: [g[0], g[1]], sc: lerp(.98, 2.5, ss(seg(f2, 50, 58))), rot: lerp(0, 8, seg(f2, 50, 58)), anchor: 'pinch' };
  }
  const glassPath = track([[48, [1330, 950]], [50, [1325, 935]], [53, [1240, 845]], [56, [1110, 890]], [58, [1010, 1065]], [60, [960, 1300]]]);

  const st = {};
  function update(t, f, shot) {
    const fr = t * 24, f2 = f - (f % 2);
    const isS6 = shot === 17;
    desk.visible = !isS6; desk2.visible = isS6; win.visible = isS6; lu.visible(isS6); chair.visible = isS6;
    hand.visible(!isS6 && f2 <= 58);
    tweez.visible = !isS6; glasses.visible = !isS6 && f2 <= 58;
    if (!isS6) {
      const v = camS1(Math.min(fr, 99.999));
      const br = fr < 70 ? .0015 * Math.sin(2 * Math.PI * t / 3.2) : 0;
      cam.fov = fovOf(v[6]); cam.updateProjectionMatrix();
      aim(cam, [v[0], v[1] + br, v[2]], v[3], v[4], v[5] + (fr < 70 ? .6 * Math.sin(2 * Math.PI * t / 5) : 0));
      // 近视虚焦：f0–f61 页面和桌面取 mip 偏移（约 2·K px）
      const myo = fr < 62 ? 1 : fr < 70 ? 1 - seg(fr, 62, 70) : 0;
      deskU.uBias.value = 1.6 * myo; pageL.userData.u.uBias.value = pageR.userData.u.uBias.value = 1.4 * myo; pageL.userData.u.uSoft.value = .0009 * myo;
      // 卦爻：f80 起透金（爻醒了），f84 起浮起；纸上那一画淡到 15% 的墨影
      placeBars(fr, t);
      // 返修 3（self-01 / story-06②）：下面五画的屏幕位置交给总合成——f92.5–f95 这五画从页面上"升"成五道横带（叠加层接手，3D 浮条淡掉），
      //   横带跨过 f99 的纤维闪留在画面里（切点两边是同一组五道横带），到山里再从中线往上下分开、拉平时落成 #03 的五层
      if (fr >= 90 && fr < 100) {
        cam.updateMatrixWorld(true);
        const acc = [0, 1, 2, 3, 4].map(() => ({ p: new THREE.Vector3(), n: 0 }));
        for (const m of bars) { const i = m.userData.i; if (i > 4) continue; m.updateMatrixWorld(true); acc[i].p.add(m.getWorldPosition(new THREE.Vector3())); acc[i].n++; }
        st.bars = acc.map(a => { const c = a.p.multiplyScalar(1 / Math.max(1, a.n)); const s0 = w2s(cam, c), s1 = w2s(cam, c.clone().add(new THREE.Vector3(0, 0, HEX.thick * .5))); return { y: s0.y, th: clamp(Math.abs(s1.y - s0.y) * 2, 6, 120) }; });
        const fade = 1 - ss(seg(fr, 92.5, 95));
        for (const m of bars) m.userData.u.uFade.value = m.userData.i <= 4 ? fade : 1;
      } else { st.bars = null; for (const m of bars) m.userData.u.uFade.value = 1; }
      HEX.z.forEach((z, i) => { const Li = eo((fr - (84 + 1.3 * i)) / 8); pageL.userData.u.uInk.value[i] = lerp(1, .15, Li); });
      pageL.userData.u.uGlint.value = fr >= 78 && fr < 86 ? seg(fr, 78, 84) : 0;
      // 镊子：挂在捏合点上；f34 起留在页边
      const hp = handPose(f2);
      hand.setRect(hand.poses[hp.pose].rect); hand.pose = hp.pose;
      const R = hand.poses[hp.pose].rect;
      const keyPx = hp.pose === 'p1' ? (hp.anchor === 'tip' ? M.handsDesk[0].keys.pinch : M.handsDesk[0].keys.pinch) : M.handsDesk[1].keys.index_tip;
      const hpx = 640 * hp.sc;
      const s = hpx / R[3];
      // 锚点是镊尖时，捏合点在镊尖右下 120 px
      let ax = hp.at[0], ay = hp.at[1];
      if (hp.anchor === 'tip') { ax += 92 * hp.sc; ay += 78 * hp.sc; }
      const ox = (keyPx[0] - R[0] - R[2] / 2) * s, oy = (keyPx[1] - R[1] - R[3] / 2) * s;
      const cr = Math.cos(hp.rot * DEG), sr = Math.sin(hp.rot * DEG);
      const cx = ax - (cr * ox - sr * oy), cy = ay - (sr * ox + cr * oy);
      faceCam(hand, cam, cx, cy, hpx, .3, { rot: -hp.rot });
      hand.u.uLit.value.set(1.06, 1.0, .92); hand.u.uShade.value.set(.70, .74, .82);
      hand.u.uRimAmt.value = .7; hand.u.uRimCol.value.copy(lin3('#FFD9A0')); rimOffset(hand, -.55, .83, 3.5 * K, hpx * K); hand.u.uInkGrow.value = Math.min(6, 1.2 * hand.u.uRect.value.w / Math.max(hpx, 1));
      // 指尖墨渍（母题第一次）：姿态 2 的食指尖，R 13·K
      // 返修 1：冷蓝黑墨覆盖（不是乘在暖色皮肤上），R ≈ 18·K；f40–f46 停住时给 2 帧湿亮点
      if (hp.pose === 'p2') { const k = M.handsDesk[1].keys.index_tip; hand.u.uStain.value.set(k[0], k[1] + 4, 18 / s, 1); hand.u.uStainP.value.set(.6, .85, 3, .56); hand.u.uStainWob.value = .25; }
      else { const k = M.handsDesk[0].keys.index_tip; hand.u.uStain.value.set(k[0] + 4, k[1] + 6, 15 / s, .95); hand.u.uStainP.value.set(.6, .85, 3, .56); }
      hand.u.uStainGloss.value = f2 >= 42 && f2 <= 44 ? 1 : .25;
      hand.u.uStainSeed.value = 7;
      // 镊子
      const tipD = .3;
      if (f2 <= 33) {
        const tip = s2w(cam, hp.at[0], hp.at[1], tipD), pin = s2w(cam, ax, ay, tipD);
        const dir = pin.clone().sub(tip).normalize();
        tweez.position.copy(tip); tweez.quaternion.setFromUnitVectors(new THREE.Vector3(-1, 0, 0), dir);
        tweez.scale.setScalar(1);
        if (f2 >= 32) tweez.position.y += .001 * (f2 === 32 ? 1 : 0);
      }
      if (f2 > 33) {
        const h33 = handPose(32), R33 = hand.poses.p1.rect, s33 = 640 * h33.sc / R33[3];
        const tip = s2w(cam, h33.at[0], h33.at[1], tipD), pin = s2w(cam, h33.at[0] + 92 * h33.sc, h33.at[1] + 78 * h33.sc, tipD);
        tweez.position.copy(tip); tweez.quaternion.setFromUnitVectors(new THREE.Vector3(-1, 0, 0), pin.clone().sub(tip).normalize());
        void s33;
      }
      // 眼镜：折好放在右页下边距，f49 捏起，朝镜头升起，镜腿 0° → 95°（f52、f54、f56 三档）
      const g = glassPath(Math.max(48, Math.min(60, f2 < 50 ? 48 : f2)));
      if (fr < 50) { glasses.position.set(.09, PB + .007, .128); glasses.rotation.set(-Math.PI / 2, 0, .25); glasses.scale.setScalar(1); }
      else {
        // 从书页上捏起（f50–f52 从书页的位置过渡到手里），之后跟着捏合点朝镜头送过来；深度始终在桌面以上
        const held = s2w(cam, g[0], g[1], lerp(.30, .17, ss(seg(f2, 52, 60))));
        const onBook = new THREE.Vector3(.09, PB + .007, .128);
        const k = ss(seg(f2, 49, 52));
        glasses.position.copy(onBook).lerp(held, k);
        const qBook = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, .25));
        const qHeld = cam.quaternion.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), lerp(-.9, 0, ss(seg(f2, 50, 58)))));
        glasses.quaternion.copy(qBook).slerp(qHeld, k);
        glasses.scale.setScalar(1);
      }
      const unfold = f2 < 52 ? 0 : f2 < 54 ? .35 : f2 < 56 ? .7 : 1;
      temples.forEach(({ hinge, sx }) => { hinge.rotation.y = sx * ((1 - unfold) * 1.62 - unfold * .14); });
      // 光
      book.position.set(0, 0, 0); book.rotation.set(0, 0, 0); deskU.uLattice.value = .5;
      setToonGlobals({ keyDir: KEY.toArray(), skyGain: 0, inkTime: Math.floor(f / 2) });
      key.position.copy(KEY); key.updateMatrixWorld();
      deskU.uDap.value = 0; pageL.userData.u.uDap.value = pageR.userData.u.uDap.value = 0;
      pageL.userData.u.uMag.value = pageR.userData.u.uMag.value = 1;
      st.myo = myo;
    } else {
      // ── S6 ──：一个连续镜头，从过右肩的近景拉成中景（相机到后脑 0.99 → 1.4 m，ss5），升 0.06 m、yaw −3°、pitch −32° → −38°
      const u = ss5(seg(fr, 652, 706));
      const head = new THREE.Vector3(.0, .50, .40);
      const camAt = (k) => { const d = lerp(.99, 1.4, k), yw = lerp(0, -3, k), pt = lerp(-32, -38, k);
        const dir = new THREE.Vector3(-Math.sin(yw * DEG) * Math.cos(pt * DEG), Math.sin(pt * DEG), -Math.cos(yw * DEG) * Math.cos(pt * DEG));
        const p = head.clone().addScaledVector(dir, -d); p.y += .06 * k; p.x += .05; return { p, yw, pt }; };
      const c = camAt(u);
      cam.fov = 31.13; cam.updateProjectionMatrix(); aim(cam, c.p.toArray(), c.yw, c.pt);
      const r0 = new THREE.PerspectiveCamera(31.13, W / H, .01, 30); { const c0 = camAt(0); aim(r0, c0.p.toArray(), c0.yw, c0.pt); r0.updateProjectionMatrix(); }
      const r1 = new THREE.PerspectiveCamera(31.13, W / H, .01, 30); { const c1 = camAt(1); aim(r1, c1.p.toArray(), c1.yw, c1.pt); r1.updateProjectionMatrix(); }
      // 陆蔚精灵：固定在世界里；f652 右镜片外缘对 P*，精灵下沿始终在画外（或被椅背压住）
      const sc = 1.1, hpx = 1024 * sc;
      const le = M.desk.lensEdge, ox = (le[0] - 1448 / 2) * sc, oy = (le[1] - 1024 / 2) * sc;
      // 返修 3（story-16）：右镜片的外缘弧（A06 的 lens_rim_polyline）在精灵平面上取世界点，再按当前镜头投影——叠加层画一道金属细弧，
      //   f652 正好过 P*，弧度接得上 A 侧上眼睑的右半段；镜片一闪就有了"镜片"
      cam.updateMatrixWorld(true); r0.updateMatrixWorld(true);
      st.lensRim = M.desk.rim.map(([x, y]) => w2s(cam, s2w(r0, 1236 + (x - le[0]) * sc, 438 + (y - le[1]) * sc, .99)));
      faceCam(lu, r0, 1236 - ox, 438 - oy, hpx, .99);
      lu.u.uLit.value.set(1.06, 1.0, .92); lu.u.uShade.value.set(.70, .74, .82);
      lu.u.uRimAmt.value = .8; lu.u.uRimCol.value.copy(lin3('#FFD9A0')); rimOffset(lu, .6, .8, 3.5 * K, hpx * K * lerp(1, .7, u)); lu.u.uInkGrow.value = Math.min(6, 1.3 * tex.luDesk.image.height / Math.max(hpx, 1));
      lu.clearBones();
      const strokes = [[660, 668], [670, 678], [681, 689]];
      let off = 0; for (const [a, b] of strokes) if (f2 >= a && f2 <= b) off = Math.sin(Math.PI * (f2 - a) / (b - a)) * 14 / (sc * lerp(1, .7, u));
      if (off) lu.boneT(0, M.desk.keys.right_hand, 150, 330, off, 0);
      // 光斑（母题第三次）：格点在精灵 uv 里，单元/身高比例与豹身环斑相同；右手食指尖那一枚用 SEED_STAIN
      // 光斑：只在窗光光束里（和后期光束同一组参数）、只在受光面；柔边光团一簇簇，肩背上聚成一片
      lu.u.uDap.value = 1; lu.u.uDapT.value = t; lu.u.uDapCell.value = 50; lu.u.uDapR.value = 24;   // 返修 3：格子加密（肩背上 25–40 枚聚成一片）
      lu.u.uBeam.value.set((180 - 28) * DEG, 1760, -60, 1);
      const ti = M.desk.keys.right_index_tip; lu.u.uDapTip.value.set(ti[0], ti[1]); lu.u.uDapTipSeed.value = 7;
      // 中景时（f699–f701）食指尖那一枚 SEED_STAIN 光斑亮 2–3 帧：和 S1 的墨渍同形同位，母题收回来
      lu.u.uDapTipA.value = .5 + .55 * (1 - ss(Math.abs(fr - 700) / 2.2));
      // 书：放在左手下面（按 f706 的构图：书 x 900–1750、y 760–1040）
      { const lh = M.desk.keys.left_hand; const sx = 1236 - ox + (lh[0] - 724) * sc, sy = 438 - oy + (lh[1] - 512) * sc;
        const pt = s2w(r0, sx, sy, .99); const hit = (() => { const v = pt.clone().sub(r0.position).normalize(); const k = -r0.position.y / v.y; return r0.position.clone().addScaledVector(v, k); })();
        book.position.set(hit.x + .09, 0, hit.z - .02); book.rotation.set(0, -.08, 0); }
      // 椅背：在他背后，f706 时压住精灵下沿
      { const p = s2w(r1, 760, 980, 1.05); chair.position.set(p.x, p.y - .43, p.z); chair.rotation.set(-.1, c.yw * DEG, 0); }
      deskU2.uDap.value = 1; deskU2.uDapT.value = t; deskU2.uBias.value = 0; deskU2.uLattice.value = 0;
      { const bc = book.position; deskU2.uDapC.value.set(bc.x, bc.z); }
      pageL.userData.u.uDap.value = pageR.userData.u.uDap.value = 1; pageL.userData.u.uDapT.value = pageR.userData.u.uDapT.value = t;
      pageL.userData.u.uBias.value = pageR.userData.u.uBias.value = 0; pageL.userData.u.uSoft.value = 0;
      HEX.z.forEach((z, i) => pageL.userData.u.uInk.value[i] = 1);
      bars.forEach(b => b.visible = false);
      winU.uT.value = t;
      { const wc = s2w(r1, 1100, 260, 3.4); win.position.copy(wc); win.quaternion.copy(r1.quaternion); }
      setToonGlobals({ keyDir: [.45, .7, -.55], skyGain: 0, inkTime: Math.floor(f / 2) });
    }
  }

  function look(t, f, shot) {
    const fr = t * 24;
    const OL = { width: 2.4, color: '#2B2119', wobble: .5, warp: 70, boilFps: 12, pressure: .35, breakup: .10, inner: .5, farScale: .6, tint: .2, darken: .5, near: .3, far: 2 };
    let grade = { exposure: 1, warmth: .28, lift: [.030, .020, .015], gamma: .97, gain: 1.03, saturation: 1.06, shoulder: .9 };
    let bloom = { strength: .6, threshold: .78, radius: .7, tint: '#FFE2A8' };
    let kuw = { radius: 2, farRadius: 3, farStart: .8, farEnd: 2, strength: .85, protect: null };
    let paper = { strength: .05 }, vignette = .28;
    if (shot === 2) {
      const k = ss(seg(fr, 92, 99));
      grade.exposure = lerp(1, 1.35, ei(seg(fr, 92, 99))); bloom.strength = lerp(.6, .9, k); kuw.radius = lerp(2, 3, k); paper.strength = lerp(.05, .12, k); vignette = lerp(.28, .18, k);
    }
    if (shot === 17) { grade.warmth = .30; OL.near = .8; OL.far = 3; kuw.farStart = 1.5; kuw.farEnd = 4; }
    return { outline: OL, grade, bloom, kuwahara: kuw, paper, vignette, fog: null };
  }
  function post(t, f, shot) {
    const fr = t * 24;
    const p = { uBeam: 1, uDust: 1, uDustT: t, uBeamAng: 28 * DEG, uBeamO: [180, -40], uCold: shot === 1 ? 1 : shot === 2 ? 1 - ss(seg(t * 24, 88, 96)) : .32 };
    if (shot === 17) { p.uBeamAng = (180 - 28) * DEG; p.uBeamO = [1760, -60]; p.uDustPar = [-(seg(fr, 652, 706)) * 60, 0]; }
    if (shot <= 2) {
      // 近视：f62–f69 镜片圈内清楚、圈外模糊并压暗 10%；镜片圈扩张出画
      const lensR = lerp(240, 1400, eo(seg(fr, 56, 69)));
      const lensW = lerp(40, 140, seg(fr, 56, 69));
      const fin = ss(seg(fr, 56, 60));        // 镜片圈和圈外虚焦都淡入（不再在 f58 一帧全开）
      p.uMyo = fr < 56 ? 0 : fr < 70 ? fin * (1 - seg(fr, 66, 70)) : 0;
      p.uLens = [960, 560, fr < 56 ? 0 : lensR, lensW]; p.uLensA = fr >= 56 && fr < 70 ? fin * (1 - seg(fr, 66, 70) * .6) : 0;
      if (fr >= 70) { p.uLensA = 0; }
      p.uBeam = shot === 2 ? 1 - ss(seg(fr, 92, 99)) : 1;
      p.uDust = p.uBeam;
    }
    return p;
  }
  // 叠加层（S6）：右镜片外缘的金属细弧（2–3·K 宽，#C9B48A，外侧一线高光），切点前后更亮
  function overlay(t, f, shot) {
    if (shot !== 17 || !st.lensRim) return;
    const fr = t * 24, g = ctx.OV.use(), X = ctx.OV.X, Y = ctx.OV.Y, Kk = ctx.OV.K;
    const flash = Math.max(0, 1 - Math.abs(fr - 652.5) / 6);
    g.save(); g.lineCap = 'round'; g.lineJoin = 'round';
    const path = () => { g.beginPath(); st.lensRim.forEach((q, i) => { if (i) g.lineTo(X(q.x), Y(q.y)); else g.moveTo(X(q.x), Y(q.y)); }); };
    g.strokeStyle = `rgba(58,52,48,${(.85).toFixed(3)})`; g.lineWidth = 3.2 * Kk; path(); g.stroke();
    g.strokeStyle = `rgba(201,180,138,${(.9).toFixed(3)})`; g.lineWidth = 2.2 * Kk; path(); g.stroke();
    g.strokeStyle = `rgba(255,241,200,${(.35 + .65 * flash).toFixed(3)})`; g.lineWidth = (1 + 1.5 * flash) * Kk; g.translate(-.8 * Kk, -.8 * Kk); path(); g.stroke();
    g.restore();
  }
  return { scene, camera: cam, update, look, post, st, overlay };
}
