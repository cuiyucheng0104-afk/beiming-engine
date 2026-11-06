// 第五章 合作城 · 孟菲斯纸模型的材质与小部件（只被 ch5.js 使用）。
// 做法：平涂饱和色 + 深靛描边（每个面的棱线在着色器里按屏幕像素宽度画，等宽、不随距离变粗）+ 小图案（波点、斜纹、锯齿、水磨石）
//      + 阴影偏紫（间接光乘紫色），自身再补一点"纸面自亮"，让城在台灯下也是全片最明亮的一段。
// 所有图案都在物体自身坐标里算：物体缩放（弹起）时图案和棱线跟着物体走。
import * as THREE from 'three';

export const INKM = '#25214A';                       // 孟菲斯深靛（只用于描边、窗框、轮胎）
export const PAL = {
  yellow: '#FFD234', pink: '#FF7EB3', sky: '#5CC8FF', mint: '#5EDFB0', lilac: '#B9A0FF', peach: '#FF9C6B',
  cobalt: '#2F5BFF', green: '#2FCB7A', cream: '#FFF3DC', white: '#FFFCF6', butter: '#FFE89A', blush: '#FFC6DA',
  ice: '#BFE9FF', mintL: '#C2F2DE', lilacL: '#DCD0FF', peachL: '#FFD2B8',
};
const PATS = { none: 0, dots: 1, diag: 2, zig: 3, vstripe: 4, win: 5, hstripe: 6, terrazzo: 7, checker: 8 };

const VERT_DECL = 'varying vec3 vOP; varying vec3 vON;\n';
const FRAG_DECL = `
varying vec3 vOP; varying vec3 vON;
uniform vec3 uHalf, uCenter, uCol2, uTop, uTop2, uInk, uWinA, uWinB;
uniform float uPat, uPatTop, uScale, uScaleTop, uLine, uShape, uBoost, uWinOn, uLit, uSeed, uNoEdgeBottom;
uniform vec4 uWin;
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21) + uSeed * .137); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float aaStep(float e, float x){ float w = fwidth(x) * .75; return smoothstep(e - w, e + w, x); }
float patMask(vec2 p, float k, float s){
  if (k < .5) return 0.;
  if (k < 1.5) { vec2 c = fract(p / s) - .5; float d = length(c) * s; return 1. - aaStep(.2 * s, d); }
  if (k < 2.5) { float f = fract((p.x + p.y) / s); return aaStep(.0, f) * (1. - aaStep(.36, f)); }
  if (k < 3.5) { float y = p.y / s + abs(fract(p.x / s) - .5) * 1.1; float f = fract(y); return 1. - aaStep(.28, f); }
  if (k < 4.5) { float f = fract(p.x / s); return 1. - aaStep(.5, f); }
  if (k < 5.5) return 0.;
  if (k < 6.5) { float f = fract(p.y / s); return 1. - aaStep(.5, f); }
  if (k < 7.5) { vec2 g = floor(p / s), f = fract(p / s); float m = 0.;
    for (int i = 0; i < 2; i++) { vec2 o = vec2(h21(g + float(i) * 7.1), h21(g + 3.3 + float(i) * 5.7)); float r = .08 + .1 * h21(g + 9.1 + float(i));
      m = max(m, 1. - aaStep(r, length(f - o) )); }
    return m; }
  vec2 c = floor(p / s); return mod(c.x + c.y, 2.);
}
`;
const FRAG_MAIN = `
  vec3 q = vOP - uCenter; vec3 an = abs(vON); float edgeD = 1e5; vec2 fp = vec2(0.); bool top = false; float faceU = 0.;
  if (uShape < .5) {               // 盒子：到本面边界的距离
    if (an.y > .5) { edgeD = min(uHalf.x - abs(q.x), uHalf.z - abs(q.z)); fp = q.xz; top = vON.y > 0.; if (vON.y < 0.) edgeD = 1e5; }
    else if (an.x > .5) { edgeD = min(uHalf.y - abs(q.y), uHalf.z - abs(q.z)); fp = vec2(q.z * sign(vON.x), q.y); faceU = uHalf.z; }
    else { edgeD = min(uHalf.x - abs(q.x), uHalf.y - abs(q.y)); fp = vec2(-q.x * sign(vON.z), q.y); faceU = uHalf.x; }
    if (uNoEdgeBottom > .5 && an.y < .5 && q.y < -uHalf.y * .5) edgeD = min(uHalf.y + q.y + 1e3, (an.x > .5 ? uHalf.z - abs(q.z) : uHalf.x - abs(q.x)));
  } else if (uShape < 1.5) {       // 圆柱：只画上下沿
    if (an.y > .5) { edgeD = uHalf.x - length(q.xz); fp = q.xz; top = vON.y > 0.; }
    else { edgeD = uHalf.y - abs(q.y); fp = vec2(atan(q.z, q.x) * uHalf.x, q.y); }
  }
  vec3 base = diffuseColor.rgb;
  if (top) { base = uTop; float m = patMask(fp, uPatTop, uScaleTop); base = mix(base, uTop2, m); }
  else {
    float m = patMask(fp, uPat, uScale); base = mix(base, uCol2, m);
    if (uWinOn > .5 && uShape < .5 && an.y < .5) {   // 立面窗格：居中排布，底层留空（uWin.z 以下不开窗）
      float nx = floor((2. * faceU - .004) / uWin.x); float uu = fp.x / uWin.x + nx * .5;
      float vv = (fp.y + uHalf.y - uWin.z) / uWin.y; float nf = floor((2. * uHalf.y - uWin.z - .004) / uWin.y);
      if (nx >= 1. && uu >= 0. && uu < nx && vv >= 0. && vv < nf) {
        vec2 cell = fract(vec2(uu, vv)); vec2 id = floor(vec2(uu, vv));
        vec2 lo = vec2(.24, .22), hi = vec2(.76, .84);
        vec2 dl = (cell - lo) * uWin.xy, dh = (hi - cell) * uWin.xy; float dd = min(min(dl.x, dl.y), min(dh.x, dh.y));
        if (dd > 0.) { float px = dd / max(fwidth(dd), 1e-7);
          float lit = step(h21(id + vON.xz * 13.1 + floor(uCenter.xz * 50.)), uLit);
          vec3 wc = mix(uWinB, uWinA, lit);
          base = mix(uInk, wc, smoothstep(uLine * .55 - .6, uLine * .55 + .6, px));
        }
      }
    }
  }
  diffuseColor.rgb = base;
  float edgePx = edgeD / max(fwidth(edgeD), 1e-7);
  float inkA = (uLine > 0.) ? 1. - smoothstep(uLine - .7, uLine + .7, edgePx) : 0.;
`;

let progKey = 0;
// 孟菲斯材质：col 侧面底色、col2 图案色、pat 图案、top 顶面色（及 top2/patTop）、win 立面窗（{ w, h, base, lit, a, b }）、line 描边像素（2× 超采样下的像素）
export function memMat(o = {}) {
  const m = new THREE.MeshStandardMaterial({ color: o.col || PAL.cream, roughness: .95, metalness: 0, side: o.side || THREE.FrontSide, transparent: !!o.transparent, opacity: o.opacity ?? 1 });
  const U = {
    uHalf: { value: new THREE.Vector3(.01, .01, .01) }, uCenter: { value: new THREE.Vector3() },
    uCol2: { value: new THREE.Color(o.col2 || o.col || PAL.cream) }, uTop: { value: new THREE.Color(o.top || o.col || PAL.cream) }, uTop2: { value: new THREE.Color(o.top2 || o.top || o.col || PAL.cream) },
    uInk: { value: new THREE.Color(INKM) }, uWinA: { value: new THREE.Color(o.win?.a || '#FFD36E') }, uWinB: { value: new THREE.Color(o.win?.b || PAL.ice) },
    uPat: { value: PATS[o.pat || 'none'] }, uPatTop: { value: PATS[o.patTop || 'none'] }, uScale: { value: o.scale || .004 }, uScaleTop: { value: o.scaleTop || o.scale || .004 },
    uLine: { value: o.line ?? 3.2 }, uShape: { value: o.shape ?? 0 }, uBoost: { value: o.boost ?? .3 }, uWinOn: { value: o.win ? 1 : 0 }, uLit: { value: o.win?.lit ?? .5 },
    uSeed: { value: o.seed ?? 1 }, uNoEdgeBottom: { value: 0 },
    uWin: { value: new THREE.Vector4(o.win?.w || .007, o.win?.h || .008, o.win?.base ?? .006, 0) },
    uGlow: { value: 0 },
  };
  m.userData.U = U;
  m.onBeforeCompile = s => {
    Object.assign(s.uniforms, U);
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\n' + VERT_DECL).replace('#include <begin_vertex>', '#include <begin_vertex>\n vOP = position; vON = normal;');
    s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\n' + FRAG_DECL + 'uniform float uGlow;\n')
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_MAIN)
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n reflectedLight.indirectDiffuse *= vec3(.86, .74, 1.12);')
      .replace('#include <opaque_fragment>', ` outgoingLight += diffuseColor.rgb * (uBoost + uGlow);\n outgoingLight = mix(outgoingLight, uInk * .9, inkA);\n#include <opaque_fragment>`);
  };
  m.customProgramCacheKey = () => 'mem5';
  return m;
}
const setBox = (m, w, h, d, cy = h / 2) => { m.userData.U.uHalf.value.set(w / 2, h / 2, d / 2); m.userData.U.uCenter.value.set(0, cy, 0); };

// 盒子（原点 = 底面中心）
const boxGeo = new Map();
export function mbox(w, h, d, o = {}) {
  const g = new THREE.BoxGeometry(w, h, d); g.translate(0, h / 2, 0);
  const m = memMat(o); setBox(m, w, h, d);
  const mesh = new THREE.Mesh(g, m); mesh.castShadow = o.cast ?? true; mesh.receiveShadow = true; return mesh;
}
// 圆柱（原点 = 底面中心）：只画上下沿，侧面轮廓用外壳描边
export function mcyl(r, h, o = {}) {
  const g = new THREE.CylinderGeometry(r * (o.taper ?? 1), r, h, o.seg || 24); g.translate(0, h / 2, 0);
  const m = memMat({ ...o, shape: 1 }); m.userData.U.uHalf.value.set(r, h / 2, r); m.userData.U.uCenter.value.set(0, h / 2, 0);
  const mesh = new THREE.Mesh(g, m); mesh.castShadow = o.cast ?? true; mesh.receiveShadow = true;
  const grp = new THREE.Group(); grp.add(mesh); if (o.hull !== false) grp.add(hull(g, o.hullW ?? .0007)); return grp;
}
// 外壳描边（背面、沿法线外扩固定世界宽度）：球、圆柱、锥的轮廓
const hullMat = new THREE.MeshBasicMaterial({ color: INKM, side: THREE.BackSide });
hullMat.onBeforeCompile = s => { s.uniforms.uHW = { value: .0007 }; s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute float hw;').replace('#include <begin_vertex>', '#include <begin_vertex>\n transformed += normalize(normal) * hw;'); };
export function hull(geo, w = .0007) {
  const g = geo.clone(); const n = g.attributes.position.count; g.setAttribute('hw', new THREE.BufferAttribute(new Float32Array(n).fill(w), 1));
  if (!g.attributes.normal) g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, hullMat); mesh.castShadow = false; mesh.receiveShadow = false; mesh.userData.hull = true; return mesh;
}
// 球形树冠等：平涂 + 外壳描边
export function mball(r, o = {}) {
  const g = new THREE.SphereGeometry(r, 20, 14); if (o.sy) g.scale(1, o.sy, 1); if (o.y0 !== undefined) g.translate(0, o.y0, 0);
  const m = memMat({ ...o, shape: 2, line: 0 });
  const mesh = new THREE.Mesh(g, m); mesh.castShadow = o.cast ?? true; mesh.receiveShadow = true;
  const grp = new THREE.Group(); grp.add(mesh, hull(g, o.hullW ?? .0006)); return grp;
}
export function mcone(r, h, o = {}) {
  const g = new THREE.ConeGeometry(r, h, 20); g.translate(0, h / 2 + (o.y0 || 0), 0);
  const m = memMat({ ...o, shape: 2, line: 0 }); const mesh = new THREE.Mesh(g, m); mesh.castShadow = true; mesh.receiveShadow = true;
  const grp = new THREE.Group(); grp.add(mesh, hull(g, .0006)); return grp;
}
// 三棱柱屋顶（沿 x 方向的屋脊），原点 = 底面中心
export function mroof(w, h, d, o = {}) {
  const s = new THREE.Shape(); s.moveTo(-d / 2, 0); s.lineTo(d / 2, 0); s.lineTo(0, h); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: w, bevelEnabled: false }); g.translate(0, 0, -w / 2); g.rotateY(Math.PI / 2);
  g.computeVertexNormals();
  const m = memMat({ ...o, shape: 2, line: 0 }); const mesh = new THREE.Mesh(g, m); mesh.castShadow = true; mesh.receiveShadow = true;
  const grp = new THREE.Group(); grp.add(mesh, hull(g, .0005)); return grp;
}

// 一棵树：五种树冠（圆、锥、蛋、云、柱）
export function tree(kind, R, s = 1) {
  const g = new THREE.Group();
  const cols = [PAL.green, PAL.mint, '#7DDC6A', PAL.green, '#3FBF8F'], c = cols[Math.floor(R() * cols.length)];
  const trunk = mcyl(.0012 * s, .007 * s, { col: '#8A5A3C', top: '#8A5A3C', line: 0, hullW: .0004, seg: 8 }); g.add(trunk);
  const top2 = new THREE.Color(c).lerp(new THREE.Color('#FFFFFF'), .35).getStyle();
  if (kind === 0) { const b = mball(.0062 * s, { col: c }); b.position.y = .0105 * s; g.add(b); const l = mball(.003 * s, { col: top2 }); l.position.set(-.0028 * s, .0135 * s, .0022 * s); g.add(l); }
  else if (kind === 1) { const k = mcone(.0058 * s, .017 * s, { col: c }); k.position.y = .005 * s; g.add(k); }
  else if (kind === 2) { const b = mball(.0052 * s, { col: c, sy: 1.45 }); b.position.y = .0125 * s; g.add(b); }
  else if (kind === 3) { for (const [x, y, z, r] of [[-.0035, .0105, 0, .0045], [.0035, .0105, .001, .0045], [0, .0145, -.001, .005]]) { const b = mball(r * s, { col: c }); b.position.set(x * s, y * s, z * s); g.add(b); } }
  else { const k = mcyl(.0038 * s, .016 * s, { col: c, top: top2, line: 2.2, seg: 16 }); k.position.y = .005 * s; g.add(k); }
  return g;
}

// 小汽车（原点 = 底面中心，车头朝 +x）
export function car(col, R) {
  const g = new THREE.Group(), body = new THREE.Group(); g.add(body);
  const b = mbox(.015, .0042, .0072, { col, top: col, line: 2.6 }); b.position.y = .0016; body.add(b);
  const cab = mbox(.0078, .0034, .0062, { col: PAL.ice, top: col, line: 2.6, win: null }); cab.position.set(-.001, .0058, 0); body.add(cab);
  for (const [x, z] of [[-.0045, .0036], [.0045, .0036], [-.0045, -.0036], [.0045, -.0036]]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(.0018, .0018, .0014, 12), new THREE.MeshStandardMaterial({ color: INKM, roughness: .8 }));
    w.rotation.x = Math.PI / 2; w.position.set(x, .0018, z); g.add(w);
  }
  g.userData.body = body; return g;
}
// 背影小人（无脸）：身体 + 头 + 两条腿
export function person(col, R) {
  const g = new THREE.Group(), body = new THREE.Group(); g.add(body);
  const t = mcyl(.0016, .0042, { col, top: col, line: 0, hullW: .00035, seg: 10, taper: .8 }); t.position.y = .0028; body.add(t);
  const skins = ['#F2C9A0', '#C98E62', '#8A5A3C', '#E8B48A'];
  const h = mball(.0014, { col: skins[Math.floor(R() * 4)], hullW: .00035 }); h.position.y = .0084; body.add(h);
  const hair = mball(.00145, { col: INKM, sy: .6, hullW: .0002 }); hair.position.y = .0091; body.add(hair);
  const legs = [-1, 1].map(s => { const l = mcyl(.0006, .0028, { col: INKM, top: INKM, line: 0, hull: false, seg: 6 }); l.position.set(0, 0, s * .0008); g.add(l); return l; });
  g.userData = { body, legs }; return g;
}

// 平面印刷件（受光、无描边）：给地面图、门里的字面板等
export function printPlane(canvas, w, h, o = {}) {
  const t = new THREE.CanvasTexture(canvas); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 16;
  const m = memMat({ col: '#FFFFFF', line: 0, shape: 2, boost: o.boost ?? .3 }); m.map = t;
  if (o.transparent) { m.transparent = true; m.alphaTest = .02; }
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m); mesh.receiveShadow = true; mesh.castShadow = false; return mesh;
}
