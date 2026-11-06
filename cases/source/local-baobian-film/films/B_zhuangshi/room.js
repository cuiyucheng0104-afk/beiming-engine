// room.js — 场景 R：修复室（S1 修复桌、T1 卦爻成轮 → 日轮门户、S6 回现实）
// 3D：书桌（木纹两档 + 窗光 gobo）、线装书（两页弧面 + 画布贴图）、砚 / 笔 / 纸叠 / 镊子 / 眼镜（toon + 墨线）、
//     T1 的 8 段金条（CPU 逐帧弯曲的条带）、火舌环、日盘 + 虹膜门户；S6 的墙。
// 2D：手（A10 捏 / A11 张，朝相机的面片 + 指尖墨渍文斑 + 平影）、S6 越肩背影（A09，衬衫上光斑 → 豹纹）、补书的手（A13）。
import * as THREE from 'three';
import { makeToonMaterial, bindToon, tintFrom } from '/films/_lib/toon.js';
import {
  W, H, K, SHARED, lin, lin3, GLSL_COMMON, cardMat, card, makeSprite, placeSprite, clearDeform,
  DEG, clamp, lerp, seg, ss, ss5, eio, eo, hashi, aimCamera, screenToWorld, project, mulberry, loglin, fseg, monotone, inkAnchors, THICK_PARS, THICK_BODY,
} from './lib.js';

// ───────────────────────── 常量（世界单位：米） ─────────────────────────
export const H0 = new THREE.Vector3(0.110, 0.021, -0.030);       // 右页卦画中心
export const H1 = new THREE.Vector3(0.110, 0.051, -0.030);       // 光轮平面中心
const LDIR = new THREE.Vector3(-0.55, 0.62, 0.56).normalize();    // 指向窗光
const zk = k => H0.z + (3.5 - k) * 0.016;                         // 第 k 爻（1..6，自下而上）的 z
const RING_R = { 2: 0.020, 3: 0.028, 4: 0.036, 5: 0.044, 6: 0.052 };
const pageY = u => 0.006 + 0.020 * (1 - Math.exp(-u / 0.07)) - 0.010 * u;   // 离书沟 u 米处的页面高度

// ───────────────────────── GLSL：窗光 gobo（S1/S6 共用） ─────────────────────────
const GOBO_GLSL = /* glsl */`
uniform float uGoboT, uGoboOn;
uniform vec4 uWin;          // 窗（窗平面 x = -1.4 上的 z0, y0, z1, y1）
float bbLeafD(vec2 q, vec2 c, float ang, float len, float wid){
  vec2 d = q - c; float co = cos(ang), si = sin(ang);
  vec2 l = vec2(co * d.x + si * d.y, -si * d.x + co * d.y);
  return (length(l / vec2(len * .5, wid * .5)) - 1.) * wid * .5;
}
// 返回 (受光 0..1, 叶影 0..1)
vec2 bbGobo(vec3 P){
  const vec3 L = vec3(-.54977, .61974, .55977);
  float s = (-1.4 - P.x) / L.x;
  if (s < 0.) return vec2(0.);
  vec3 Q = P + s * L;
  vec2 w = vec2(Q.z, Q.y);
  float pen = mix(.0012, .0045, clamp(s / 4., 0., 1.)) + .0008;     // fix1：两档硬边（style-16），不再是摄影式大半影
  vec2 lo = uWin.xy, hi = uWin.zw;
  vec2 a = smoothstep(lo - pen, lo + pen, w) * (1. - smoothstep(hi - pen, hi + pen, w));
  float win = a.x * a.y;
  float mun = 0.;
  for (int i = 1; i <= 2; i++) { float zc = mix(lo.x, hi.x, float(i) / 3.); mun = max(mun, 1. - smoothstep(.015 - pen, .015 + pen, abs(w.x - zc))); }
  { float yc = mix(lo.y, hi.y, .5); mun = max(mun, 1. - smoothstep(.015 - pen, .015 + pen, abs(w.y - yc))); }
  float lit = win * (1. - mun);
  // 柳叶：三条从窗顶垂下、随风摆动的枝条，叶子鱼骨状交错排列
  float lf = 0.;
  for (int b = 0; b < 3; b++) {
    float fb = float(b);
    float zb = mix(lo.x, hi.x, .30 + .22 * fb) + .05 * sin(fb * 2.3);
    float topY = hi.y + .12, botY = mix(lo.y, hi.y, .52 - .14 * fb);
    if (w.y < botY - .08 || w.y > topY + .05) continue;
    float sw = sin(.9 * uGoboT + fb * 1.7) * .03;
    float sp = .036;
    float kk = floor((topY - w.y) / sp);
    for (int j = -1; j <= 1; j++) {
      float k = kk + float(j);
      float yk = topY - k * sp;
      if (yk < botY || k < 0.) continue;
      float dn = (topY - yk) / (topY - botY);
      float bz = zb + sw * dn + .06 * dn * dn;
      float side = mod(k, 2.) < .5 ? 1. : -1.;
      float ang = -1.5708 + side * .62;                       // 叶尖朝下、向外斜
      vec2 dir = vec2(cos(ang), sin(ang));
      vec2 c = vec2(bz, yk) + dir * .03;
      float d = bbLeafD(w, c, ang, .06, .018);
      float pl = pen * .45;
      lf = max(lf, 1. - smoothstep(-pl, pl, d));
    }
    float dn = clamp((topY - w.y) / (topY - botY), 0., 1.);
    float bz = zb + sw * dn + .06 * dn * dn;
    lf = max(lf, (1. - smoothstep(.003, .003 + pen, abs(w.x - bz))) * step(botY, w.y) * step(w.y, topY));
  }
  return vec2(lit, lf);
}
vec3 bbGoboMul(vec3 P){
  vec2 g = bbGobo(P);
  vec3 warm = vec3(1.0, .7913, .4793);                          // #FFE6B8（线性）
  vec3 leaf = vec3(.3325, .1946, .0844);                        // #9C7A52（线性）
  vec3 shadeW = mix(vec3(1.), warm, .30) * .90;               // 背光处：略暗、仍偏暖（不发青）
  vec3 litW = mix(vec3(1.), warm, .62) * 1.14;                 // 受光处：×1.14 并偏暖
  float L1 = g.x * (1. - g.y);
  vec3 m = mix(shadeW, litW, L1);
  m *= mix(vec3(1.), leaf * 1.6, .30 * g.x * g.y);             // 叶影
  return mix(vec3(1.), m, uGoboOn);
}
`;
const WPOS_VS_PARS = 'varying vec3 vWP;';
const WPOS_VS_BEGIN = 'vWP = (modelMatrix * vec4(transformed, 1.0)).xyz;';
const goboUniforms = { uGoboT: { value: 0 }, uGoboOn: { value: 1 }, uWin: { value: new THREE.Vector4(-0.35, 1.10, 2.15, 2.60) } };

function toon(opts, { gobo = true, extraPars = '', extraAlbedo = '', uniforms = {} } = {}) {
  return makeToonMaterial({
    rimAmt: 0, rimLitAmt: 0, cityAmt: 0, skyAmt: 0, rustAmt: 0, algaeAmt: 0, spotAmt: 0, fog: false,
    vertexPars: WPOS_VS_PARS, vertexBegin: WPOS_VS_BEGIN,
    fragmentPars: GLSL_COMMON + '\nvarying vec3 vWP;\n' + GOBO_GLSL + extraPars,
    fragmentAlbedo: (extraAlbedo || '') + (gobo ? '\ndiffuseColor.rgb *= bbGoboMul(vWP);\n' : ''),
    uniforms: { ...goboUniforms, ...uniforms },
    ...opts,
  });
}
function bindT(mesh, { outline = false, w = 1, a = 1 } = {}) {
  bindToon(mesh, mesh.material, { castShadow: false, receiveShadow: false, outline });
  mesh.userData.outlineWidth = w; mesh.userData.outlineAlpha = a;
  return mesh;
}

// ───────────────────────── 书页画布 ─────────────────────────
const PW = 2048, PH = 2900, PAGE_W = 0.21, PAGE_H = 0.30;
function drawPage(side, woodcut) {
  const cv = document.createElement('canvas'); cv.width = PW; cv.height = PH;
  const g = cv.getContext('2d'), R = mulberry(side === 'L' ? 1101 : 2203);
  g.fillStyle = '#EFE6CF'; g.fillRect(0, 0, PW, PH);
  // 纸面：大块斑驳 + 纤维
  for (let i = 0; i < 260; i++) {
    const x = R() * PW, y = R() * PH, r = 60 + R() * 260;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    const d = R() < 0.5;
    gr.addColorStop(0, d ? 'rgba(150,120,70,0.045)' : 'rgba(255,250,235,0.05)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
  g.lineCap = 'round';
  for (let i = 0; i < 2600; i++) {
    const x = R() * PW, y = R() * PH, l = 8 + R() * 46, a = R() * Math.PI;
    g.strokeStyle = R() < 0.55 ? `rgba(120,95,60,${0.05 + R() * 0.07})` : `rgba(255,252,240,${0.08 + R() * 0.08})`;
    g.lineWidth = 1 + R() * 1.6;
    g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + Math.cos(a) * l * 0.5 + (R() - 0.5) * 6, y + Math.sin(a) * l * 0.5, x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
  // 版框：外粗内细；书口一侧留版心（鱼尾）
  const INK = '#3A2E26';
  const fx0 = side === 'L' ? 300 : 150, fx1 = side === 'L' ? PW - 150 : PW - 300, fy0 = 220, fy1 = PH - 230;
  const wob = (v, s) => v + (R() - 0.5) * s;
  g.strokeStyle = INK; g.globalAlpha = 0.9;
  const frame = (inset, lw) => {
    g.lineWidth = lw; g.beginPath();
    g.moveTo(wob(fx0 + inset, 3), wob(fy0 + inset, 3)); g.lineTo(wob(fx1 - inset, 3), wob(fy0 + inset, 3));
    g.lineTo(wob(fx1 - inset, 3), wob(fy1 - inset, 3)); g.lineTo(wob(fx0 + inset, 3), wob(fy1 - inset, 3)); g.closePath(); g.stroke();
  };
  frame(0, 14); frame(22, 5);
  // 版心（书口侧窄条 + 上下鱼尾）
  const bx = side === 'L' ? fx0 + 22 : fx1 - 22, bw = 120, bx0 = side === 'L' ? bx : bx - bw, bx1 = bx0 + bw;
  g.lineWidth = 5; g.beginPath(); g.moveTo(side === 'L' ? bx1 : bx0, fy0 + 22); g.lineTo(side === 'L' ? bx1 : bx0, fy1 - 22); g.stroke();
  g.fillStyle = INK;
  for (const fy of [fy0 + 520, fy1 - 520]) {
    const up = fy < PH / 2;
    g.beginPath(); g.moveTo(bx0 + 6, fy); g.lineTo(bx1 - 6, fy); g.lineTo(bx1 - 6, fy + (up ? 60 : -60)); g.lineTo((bx0 + bx1) / 2, fy + (up ? 26 : -26)); g.lineTo(bx0 + 6, fy + (up ? 60 : -60)); g.closePath(); g.fill();
  }
  // 界行（竖格）
  const cols = 9, ix0 = side === 'L' ? bx1 + 10 : fx0 + 22, ix1 = side === 'L' ? fx1 - 22 : bx0 - 10, cw = (ix1 - ix0) / cols;
  g.globalAlpha = 0.15; g.lineWidth = 3;
  for (let i = 1; i < cols; i++) { const x = ix0 + i * cw; g.beginPath(); g.moveTo(wob(x, 2), fy0 + 22); g.lineTo(wob(x, 2), fy1 - 22); g.stroke(); }
  g.globalAlpha = 1;
  // 伪字（fix1，tech-08）：每格 2–3 笔，各占一个象限、互不相接；一格里横、竖各至多一笔（拼不出 十 丁 上 二 三），
  // 其余是点、撇、捺；低对比赭墨。看得出是一行行字，认不出是哪个字。
  const glyphs = (x0, x1, y0, y1, size, alpha) => {
    for (let y = y0; y + size <= y1; y += size * 1.28) {
      if (R() < 0.06) continue;
      const cx = (x0 + x1) / 2 + (R() - 0.5) * 6, n = 2 + (R() < 0.45 ? 1 : 0);
      g.strokeStyle = `rgba(58,46,38,${alpha * 0.78})`; g.fillStyle = g.strokeStyle;
      const quads = [0, 1, 2, 3].sort(() => 0).map(q => ({ q, k: R() })).sort((p1, p2) => p1.k - p2.k).slice(0, n).map(o => o.q);
      let hasH = false, hasV = false;
      for (const q of quads) {
        const qx = cx + (q % 2 ? 0.24 : -0.24) * size + (R() - 0.5) * size * 0.06, qy = y + size * (q < 2 ? 0.28 : 0.72) + (R() - 0.5) * size * 0.06;
        let type = ['dot', 'pie', 'na', 'hor', 'ver'][Math.floor(R() * 5)];
        if (type === 'hor') { if (hasH) type = 'dot'; else hasH = true; }
        if (type === 'ver') { if (hasV) type = 'pie'; else hasV = true; }
        const L = size * (type === 'dot' ? 0.13 : 0.26 + R() * 0.06);
        g.lineWidth = size * (0.085 + R() * 0.03);
        g.beginPath();
        if (type === 'hor') { g.moveTo(qx - L / 2, qy); g.lineTo(qx + L / 2, qy + (R() - 0.5) * 3); }
        else if (type === 'ver') { g.moveTo(qx, qy - L / 2); g.lineTo(qx + (R() - 0.5) * 3, qy + L / 2); }
        else if (type === 'pie') { g.moveTo(qx + L * 0.35, qy - L * 0.45); g.quadraticCurveTo(qx, qy, qx - L * 0.40, qy + L * 0.42); }
        else if (type === 'na') { g.moveTo(qx - L * 0.38, qy - L * 0.40); g.quadraticCurveTo(qx + L * 0.05, qy + L * 0.05, qx + L * 0.42, qy + L * 0.36); }
        else { g.ellipse(qx, qy, L * 0.5, L * 0.32, 0.7, 0, 6.2832); g.fill(); continue; }
        g.stroke();
      }
    }
  };
  if (side === 'L') {
    // 左页：版框内木刻豹（赭墨正片叠底）+ 下方四行伪字
    if (woodcut) {
      const tmp = document.createElement('canvas'); tmp.width = woodcut.width; tmp.height = woodcut.height;
      const t = tmp.getContext('2d'); t.fillStyle = INK; t.fillRect(0, 0, tmp.width, tmp.height);
      t.globalCompositeOperation = 'destination-in'; t.drawImage(woodcut, 0, 0);
      const iw = ix1 - ix0 - 60, ih = iw * woodcut.height / woodcut.width;
      g.globalCompositeOperation = 'multiply'; g.globalAlpha = 0.92;
      g.drawImage(tmp, ix0 + 30, fy0 + 160, iw, ih);
      g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
      for (let i = 0; i < 4; i++) glyphs(ix0 + i * cw * 2.25, ix0 + (i + 1) * cw * 2.25, fy0 + 220 + ih, fy1 - 60, 78, 0.55);
    }
  } else {
    // 右页：卦名（大字位，伪字）、卦画位置留白（由着色器画 ䷰）、下半部伪字
    const hx = (H0.x - 0.005) / PAGE_W * PW, hy = (H0.z + 0.15) / PAGE_H * PH;
    glyphs(ix1 - cw, ix1, fy0 + 60, fy0 + 560, 120, 0.6);
    for (let i = 0; i < cols - 1; i++) {
      const x0 = ix0 + i * cw, x1 = x0 + cw;
      const yA = (Math.abs((x0 + x1) / 2 - hx) < 560) ? hy + 560 : fy0 + 80;
      glyphs(x0, x1, yA, fy1 - 60, 82, 0.55);
    }
    // 右下角撕口：缺一块（露出下一叶纸，略深）+ 纤维
    const cx = PW - 260, cy = PH - 420;
    g.fillStyle = '#E0D2B0'; g.beginPath(); g.moveTo(cx - 230, PH); g.lineTo(cx - 200, cy + 210);
    for (let i = 0; i < 18; i++) { const u = i / 17; g.lineTo(cx - 200 + u * 300 + (R() - 0.5) * 22, cy + 210 - u * 230 + (R() - 0.5) * 22); }
    g.lineTo(PW, cy - 60); g.lineTo(PW, PH); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(180,160,120,0.9)'; g.lineWidth = 3;
    for (let i = 0; i < 3; i++) { const sx = cx - 120 + i * 80, sy = cy + 120 - i * 70; g.beginPath(); g.moveTo(sx, sy); g.quadraticCurveTo(sx + 40, sy + 30, sx + 60 + R() * 30, sy + 70); g.stroke(); }
  }
  // 纸边略旧：四周一圈暖暗
  const ed = g.createLinearGradient(0, 0, PW, 0);
  ed.addColorStop(0, 'rgba(140,110,60,0.10)'); ed.addColorStop(0.06, 'rgba(0,0,0,0)'); ed.addColorStop(0.94, 'rgba(0,0,0,0)'); ed.addColorStop(1, 'rgba(140,110,60,0.10)');
  g.fillStyle = ed; g.fillRect(0, 0, PW, PH);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 16; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true;
  return tex;
}

// 页面几何：世界坐标直接写进顶点（mesh 保持单位变换，vToonObj = 世界坐标）
function pageGeo(side) {
  const g = new THREE.PlaneGeometry(PAGE_W, PAGE_H, 40, 6);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const lx = p.getX(i), ly = p.getY(i);            // 平面 x∈[-.105,.105], y∈[-.15,.15]
    const u = side === 'L' ? (0.105 - lx) : (lx + 0.105);      // 离书沟距离
    const x = side === 'L' ? -(u + 0.005) : (u + 0.005);
    p.setXYZ(i, x, pageY(u), -ly);
  }
  g.computeVertexNormals();
  // 修正法线朝上
  const n = g.attributes.normal; for (let i = 0; i < n.count; i++) if (n.getY(i) < 0) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  return g;
}

// ───────────────────────── 卦爻金条（CPU 弯曲条带） ─────────────────────────
const NSEG = 96;
function makeBar() {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array((NSEG + 1) * 2 * 3), uv = new Float32Array((NSEG + 1) * 2 * 2), idx = [];
  for (let i = 0; i <= NSEG; i++) { uv.set([i / NSEG, 0, i / NSEG, 1], i * 4); }
  for (let i = 0; i < NSEG; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setIndex(idx);
  const mat = cardMat(/* glsl */`
    uniform float uGold, uFoilA, uFoilOn, uEmis, uLight; uniform vec3 uC;
    void main(){
      vec3 ink = vec3(.0242, .0194, .0159);
      vec3 gl = vec3(.6939, .3967, .0497), gd = vec3(.3325, .1559, .0161), gf = vec3(.9216, .7305, .2705);
      float v = vUv.y;
      vec3 g = v < .34 ? gd : (v < .67 ? mix(gd, gl, .55) : gl);
      float a = atan(vWorld.z - uC.z, vWorld.x - uC.x);
      float df = abs(mod(a - uFoilA + 3.14159, 6.28318) - 3.14159);
      g = mix(g, gf, (1. - smoothstep(.05, .09, df)) * uFoilOn);
      g *= 1.25 * uLight;
      vec3 c = mix(ink, g + gf * uEmis, uGold);
      gl_FragColor = vec4(c, 1.);
    }`, { uGold: { value: 0 }, uFoilA: { value: 0 }, uFoilOn: { value: 0 }, uEmis: { value: 0 }, uLight: { value: 1 }, uC: { value: H1.clone() } },
  { transparent: false, depthWrite: true, side: THREE.DoubleSide });
  const m = new THREE.Mesh(g, mat); m.frustumCulled = false; m.userData.outline = false; m.userData.outlineOccluder = false; m.renderOrder = 3;
  return m;
}
const _p = new THREE.Vector3(), _t = new THREE.Vector3(), _n = new THREE.Vector3(), _w = new THREE.Vector3(), _a = new THREE.Vector3();
const UPV = new THREE.Vector3(0, 1, 0);
// M 中点、T 切向、N 指向弯心（都在水平面里）；kap 曲率；L 弧长；wd 宽；psi 绕长轴翻转角；rot 绕 H1 的整体旋转；sc 绕 H1 缩放
function setBar(bar, M, T, N, kap, L, wd, psi, rot = 0, sc = 1) {
  const pos = bar.geometry.attributes.position.array;
  const yOff = (bar.userData.layer || 0) * 0.00035;        // 每段金条各占一层高度，交叉时不打架（z-fighting）
  const cr = Math.cos(rot), sr = Math.sin(rot);
  for (let i = 0; i <= NSEG; i++) {
    const s = (i / NSEG - 0.5) * L;
    if (Math.abs(kap) < 1e-6) { _p.copy(M).addScaledVector(T, s); _n.copy(N); }
    else {
      const ks = kap * s;
      _p.copy(M).addScaledVector(T, Math.sin(ks) / kap).addScaledVector(N, (1 - Math.cos(ks)) / kap);
      _n.copy(N).multiplyScalar(Math.cos(ks)).addScaledVector(T, -Math.sin(ks));
    }
    _w.copy(_n).multiplyScalar(Math.cos(psi)).addScaledVector(UPV, Math.sin(psi));
    for (let e = 0; e < 2; e++) {
      _a.copy(_p).addScaledVector(_w, (e === 0 ? 0.5 : -0.5) * wd);   // v=0 内侧（朝弯心）
      // 绕 H1 的整体旋转（水平面内，屏幕顺时针 = 绕 +y 负方向）与缩放
      const dx = _a.x - H1.x, dz = _a.z - H1.z;
      const rx = cr * dx - sr * dz, rz = sr * dx + cr * dz;
      pos.set([H1.x + rx * sc, H1.y + (_a.y - H1.y) * sc + yOff, H1.z + rz * sc], (i * 2 + e) * 3);
    }
  }
  bar.geometry.attributes.position.needsUpdate = true;
}

// ───────────────────────── 构建 ─────────────────────────
export function buildRoom({ tex }) {
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(22.07, W / H, 0.004, 40);
  const objs = [];
  const add = (o) => { scene.add(o); objs.push(o); return o; };

  // —— 书桌 ——
  const deskMat = toon({ color: '#8C5A3A', shade1: '#6A4129', shade2: '#4E2F1E', step1: 0.50, feather1: 0.008, step2: 0.15, feather2: 0.008, edgeNoise: 0.02, edgeNoiseScale: 6 },
    { extraAlbedo: /* glsl */`
      { float gn = toonNoise(vec3(vWP.x * 2.2, vWP.z * 26., 1.7)) + .35 * toonNoise(vec3(vWP.x * 5., vWP.z * 55., 4.1));
        float aw = max(fwidth(gn), 1e-3); diffuseColor.rgb *= mix(1.0, .88, smoothstep(.15 - aw, .15 + aw, gn));
        // 木纹线：顺纹细线 #7A4A2E（约 1.2 px），平涂两档之上只加线，不加渐变
        float gl = toonNoise(vec3(vWP.x * 1.4, vWP.z * 62., 3.3)) + .25 * toonNoise(vec3(vWP.x * 3.1, vWP.z * 130., 8.8));
        float lw = max(fwidth(gl), 1e-4) * 1.1;
        float ln = (1. - smoothstep(lw * .5, lw * 1.2, abs(gl - .38))) * step(.2, toonNoise(vec3(vWP.x * 3.7, vWP.z * 9., 5.)) + .5);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.1946, .0685, .0273), ln * .85); }` });
  const desk = add(bindT(new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.04, 1.0, 1, 1, 1), deskMat), { outline: true, w: 1.0, a: 0.8 }));
  desk.position.set(0, -0.02, 0);

  // —— 书：封面、两页、页厚 ——
  const cover = add(bindT(new THREE.Mesh(new THREE.BoxGeometry(0.445, 0.005, 0.312), toon({ color: '#5E6B7A', shade1: '#3E4A58', shade2: '#3E4A58', step1: 0.5, feather1: 0.008, step2: 0.0, edgeNoise: 0.01, edgeNoiseScale: 30 })), { outline: true, w: 1.0, a: 0.8 }));
  cover.position.set(0, 0.0025, 0);
  const pageTexL = drawPage('L', tex.woodcut.image), pageTexR = drawPage('R', null);
  const pageU = {
    uYaoA: { value: [1, 1, 1, 1, 1, 1] }, uYaoGlow: { value: 0 }, uYaoDark: { value: 0 },
    uYaoSh: { value: [...Array(6)].map(() => new THREE.Vector4(0, 0, 0, 0)) }, uContrast: { value: 1 }, uIsRight: { value: 1 },
    uBookM: { value: new THREE.Vector4(0, 0, 1, 0) },
  };
  const YAO_GLSL = /* glsl */`
    uniform float uYaoA[6]; uniform float uYaoGlow, uYaoDark, uContrast, uIsRight; uniform vec4 uYaoSh[6]; uniform vec4 uBookM;
    float yaoD(vec2 p, int k, vec2 off){
      float fk = float(k + 1);
      vec2 c = vec2(${H0.x.toFixed(4)}, ${H0.z.toFixed(4)} + (3.5 - fk) * .016) + off;
      vec2 d = abs(p - c) - vec2(.045, .0045);
      float box = length(max(d, 0.)) + min(max(d.x, d.y), 0.);
      if (k == 1 || k == 5) box = max(box, .007 - abs(p.x - c.x));   // 阴爻中缺
      return box;
    }`;
  const pageAlbedo = /* glsl */`
    { vec3 m = vec3(dot(diffuseColor.rgb, vec3(.333)));
      diffuseColor.rgb = mix(m, diffuseColor.rgb, uContrast);
      if (uIsRight > .5) {
        vec2 dB = vWP.xz - uBookM.xy;
        vec2 p = vec2(uBookM.z * dB.x - uBookM.w * dB.y, uBookM.w * dB.x + uBookM.z * dB.y);   // 书的本地坐标（S6 挪书，w3）
        float ink = 0., glow = 0., sh = 0.;
        for (int k = 0; k < 6; k++) {
          float d = yaoD(p, k, vec2(0.));
          float wobble = .0003 * (toonNoise(vec3(p * 900., float(k))) );
          float c = bbFill(d + wobble);
          ink = max(ink, c * uYaoA[k]);
          glow = max(glow, (1. - smoothstep(0., .0035, abs(d))) * step(0., -d + .0035));
          if (uYaoSh[k].z > 0.) sh = max(sh, bbFillF(yaoD(p, k, uYaoSh[k].xy), .0012) * uYaoSh[k].z);
        }
        vec3 inkC = vec3(.0242, .0194, .0159) * (1. - uYaoDark);
        diffuseColor.rgb = mix(diffuseColor.rgb, inkC, ink * .93);
        diffuseColor.rgb *= mix(vec3(1.), vec3(.1022, .0666, .0510), sh);
        totalEmissiveRadiance += vec3(.6939, .3967, .0497) * glow * uYaoGlow;
      }
    }`;
  const pageMat = (texture, isRight) => {
    const m = toon({ color: '#ffffff', map: texture, shade1Tint: tintFrom('#EFE6CF', '#D9CBA9'), shade2Tint: tintFrom('#EFE6CF', '#D9CBA9'), step1: 0.46, feather1: 0.010, step2: 0.0, edgeNoise: 0.01, edgeNoiseScale: 30 },
      { extraPars: YAO_GLSL, extraAlbedo: pageAlbedo, uniforms: { ...pageU, uIsRight: { value: isRight ? 1 : 0 } } });
    return m;
  };
  const pageL = add(bindT(new THREE.Mesh(pageGeo('L'), pageMat(pageTexL, false)), { outline: true, w: 1.0, a: 0.8 }));
  const pageR = add(bindT(new THREE.Mesh(pageGeo('R'), pageMat(pageTexR, true)), { outline: true, w: 1.0, a: 0.8 }));
  // 书口页厚（两侧窄面）
  const edgeMat = toon({ color: '#C9B48A', shade1: '#A8936A', shade2: '#A8936A', step1: 0.5, feather1: 0.008, step2: 0 });
  const edges = [];
  for (const sgn of [-1, 1]) {
    const e = add(bindT(new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.012, 0.300), edgeMat), { outline: true, w: 1.0, a: 0.8 }));
    e.position.set(sgn * 0.2155, 0.0065, 0); edges.push(e);
  }
  // 撕开的小纸片（右页右下角，镊子挑起）
  const flapGeo = new THREE.BufferGeometry();
  flapGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0.026, 0, 0.004, 0.006, 0, 0.022], 3));
  flapGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0.9, 0.12, 1, 0.1, 0.92, 0.05], 2));
  flapGeo.computeVertexNormals();
  const flapMat = toon({ color: '#E9DFC4', shade1: '#CFC09C', shade2: '#CFC09C', step1: 0.4, step2: 0, side: THREE.DoubleSide });
  const flap = add(bindT(new THREE.Mesh(flapGeo, flapMat), { outline: true, w: 0.6, a: 0.7 }));
  const FLAP0 = new THREE.Vector3(0.158, pageY(0.153) + 0.0006, 0.098);
  // w3（v3-04）：整本书（封面、两页、书口、撕口小纸片）收进一个组。S1 / T1 里组是单位变换（和原来一模一样）；
  //   S6 里整本书沿桌面挪到他右前方、转向他，让右页（带撕口）和左页木刻豹露出来。页面着色器里画 ䷰ 用的是世界坐标，
  //   这里同步把组的变换（偏移 x、z 与转角的 cos、sin）传给它，换回书的本地坐标，卦画跟着书走
  const bookG = new THREE.Group(); scene.add(bookG);
  for (const o of [cover, pageL, pageR, ...edges, flap]) bookG.add(o);
  const setBook = (x = 0, z = 0, rot = 0) => {
    bookG.position.set(x, 0, z); bookG.rotation.set(0, rot, 0); bookG.updateMatrixWorld(true);
    pageU.uBookM.value.set(x, z, Math.cos(rot), Math.sin(rot));
  };

  // —— 器物：砚、笔、纸叠 ——
  const propOpts = (c, s1, s2) => ({ color: c, shade1: s1, shade2: s1, step1: 0.50, feather1: 0.008, step2: 0.0, feather2: 0.008, edgeNoise: 0.015, edgeNoiseScale: 25 });   // fix1：器物只留两档平涂（self-01 / style-16）
  const ink = add(bindT(new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.02, 0.08), toon(propOpts('#3A3632', '#2A2724', '#201D1B'))), { outline: true }));
  ink.position.set(-0.33, 0.01, -0.17);
  const pool = add(bindT(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.002, 40), toon(propOpts('#1B1918', '#141211', '#100E0D'))), { outline: true, w: 0.6 }));
  pool.position.set(-0.345, 0.0205, -0.17); pool.scale.set(1, 1, 0.7);
  const brushRest = add(bindT(new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.016, 0.10), toon(propOpts('#6A4E2A', '#4E3A20', '#3A2A16'))), { outline: true }));
  brushRest.position.set(-0.335, 0.008, -0.04);
  const brush = new THREE.Group(); add(brush);
  const bstick = bindT(new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.18, 12), toon(propOpts('#B58A4E', '#8A6638', '#6A4E2A'))), { outline: true });
  bstick.rotation.z = Math.PI / 2; brush.add(bstick);
  const btip = bindT(new THREE.Mesh(new THREE.ConeGeometry(0.0055, 0.03, 12), toon(propOpts('#1E1A17', '#161311', '#100E0D'))), { outline: true });
  btip.rotation.z = Math.PI / 2; btip.position.set(0.105, 0, 0); brush.add(btip);
  brush.position.set(-0.335, 0.020, -0.04); brush.rotation.y = 0.12;
  const paperMat = toon({ color: '#EFE6CF', shade1: '#D9CBA9', shade2: '#D9CBA9', step1: 0.5, feather1: 0.008, step2: 0.0 });
  for (let i = 0; i < 5; i++) {
    const p = add(bindT(new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.0018, 0.20), paperMat), { outline: true, w: 0.5, a: 0.6 }));
    p.position.set(-0.335 + (hashi(i * 3) - 0.5) * 0.008, 0.001 + i * 0.002, 0.13 + (hashi(i * 5 + 1) - 0.5) * 0.008);
    p.rotation.y = (hashi(i * 7 + 2) - 0.5) * 0.06;
  }

  // —— 镊子 ——
  const tweezers = new THREE.Group(); add(tweezers);
  const twMat = toon(propOpts('#9AA1A6', '#6E767C', '#555B60'));
  for (const sgn of [-1, 1]) {
    const g = new THREE.BoxGeometry(0.11, 0.003, 0.006, 8, 1, 1);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) { const x = p.getX(i), u = (x + 0.055) / 0.11; p.setZ(i, p.getZ(i) * lerp(0.3, 1, u)); }
    g.computeVertexNormals();
    const m = bindT(new THREE.Mesh(g, twMat), { outline: true });
    m.position.set(0.055, 0, sgn * 0.0019); m.rotation.y = -sgn * 2 * DEG;   // 尾端合拢、尖端张开
    tweezers.add(m);
  }

  // —— 眼镜（圆框、折叠、镜片朝下） ——
  const glasses = new THREE.Group(); add(glasses);
  const gMat = toon(propOpts('#3A2E26', '#2A211B', '#1E1813'));
  const rimL = bindT(new THREE.Mesh(new THREE.TorusGeometry(0.024, 0.0013, 8, 48), gMat), { outline: true, w: 0.9 });
  const rimR = bindT(new THREE.Mesh(new THREE.TorusGeometry(0.024, 0.0013, 8, 48), gMat), { outline: true, w: 0.9 });
  rimL.position.set(-0.033, 0, 0); rimR.position.set(0.033, 0, 0);
  const bridge = bindT(new THREE.Mesh(new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(new THREE.Vector3(-0.009, 0.004, 0), new THREE.Vector3(0, 0.011, 0), new THREE.Vector3(0.009, 0.004, 0)), 12, 0.0011, 6), gMat), { outline: true, w: 0.9 });
  const lensMat = cardMat(/* glsl */`uniform float uSweep; void main(){ float b = 1. - smoothstep(.0, .12, abs(vUv.x + vUv.y - 1. - uSweep)); gl_FragColor = vec4(vec3(1.), .03 + .55 * b); }`, { uSweep: { value: -9 } });
  const lensL = card(lensMat, 4, new THREE.CircleGeometry(0.0235, 40)); lensL.position.copy(rimL.position);
  const lensR = card(lensMat, 4, new THREE.CircleGeometry(0.0235, 40)); lensR.position.copy(rimR.position);
  const temple = (sgn) => {
    const g = new THREE.Group();
    const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -0.065), new THREE.Vector3(0, 0, -0.13), new THREE.Vector3(0, -0.012, -0.152), new THREE.Vector3(0, -0.028, -0.158)]);
    const m = bindT(new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.0010, 6), gMat), { outline: true, w: 0.9 });
    g.add(m); g.position.set(sgn * 0.058, 0.001, 0);
    return g;
  };
  const templeL = temple(-1), templeR = temple(1);
  glasses.add(rimL, rimR, bridge, lensL, lensR, templeL, templeR);

  // —— 手（A10 捏 / A11 张）：精灵 + 指尖墨渍 ——
  const INK_FS = {
    pars: /* glsl */`uniform vec4 uInk[3]; uniform vec4 uInkB[3]; uniform vec4 uInkS; uniform vec3 uGoldAdd; uniform vec4 uGoldGrad; uniform float uHandBri;`,
    body: /* glsl */`
      // 指尖墨渍（fix1）：一团湿墨在指尖皮肤上 + 拖向掌心的蹭痕；只有 A 点那枚（食指）内部隐约是四瓣环
      col *= uHandBri;
      for (int i = 0; i < 3; i++) {
        if (uInk[i].z <= 0.) continue;
        vec2 p = (vPx - uInk[i].xy) / uInk[i].z;
        if (dot(p, p) > 7.5) continue;
        vec4 ik = bbInkSmudge(p, float(i) + 1., uInk[i].w, uInkB[i].x, uInkB[i].y, uInkS.y);
        col = mix(col, ik.rgb, ik.a * uInkS.x);
      }
      // 金光在勾他：手背上缘一层金色加色渐变（S3b）
      col += uGoldAdd * smoothstep(uGoldGrad.x, uGoldGrad.y, vPx.y < 0. ? 0. : (1. - vPx.y / uImg.y));
    `,
  };
  const handU = () => ({ uInk: { value: [0, 1, 2].map(() => new THREE.Vector4()) }, uInkB: { value: [0, 1, 2].map(() => new THREE.Vector4()) }, uInkS: { value: new THREE.Vector2(1, 0) }, uGoldAdd: { value: new THREE.Vector3() }, uGoldGrad: { value: new THREE.Vector4(0.4, 1.0, 0, 0) }, uHandBri: { value: 1 } });
  const pinch = makeSprite(tex.hand_pinch, { order: 20, frag: INK_FS, uniforms: handU(), lineCol: '#2E2420' });
  const open = makeSprite(tex.hand_open, { order: 20, frag: INK_FS, uniforms: handU(), lineCol: '#2E2420' });
  add(pinch.group); add(open.group);
  const A10 = tex.manifest.A10.锚点, A11 = tex.manifest.A11.锚点;
  const INK10 = inkAnchors(A10), INK11 = inkAnchors(A11);
  const setInk = (sp, inks) => {
    inks.forEach((k, i) => { if (!k) return; sp.U.uInk.value[i].set(k.px[0], k.px[1], k.r, k.smearA); sp.U.uInkB.value[i].set(k.ringA - 0 * k.smearA, k.ringK, 0, 0); });
  };
  setInk(pinch, INK10); setInk(open, INK11);
  // 手影：同一张剪影沿光方向投到页面上，正片叠底
  const shadowMat = new THREE.ShaderMaterial({
    uniforms: { map: { value: tex.hand_open }, uY0: { value: 0.0235 }, uA: { value: 0.25 } },
    vertexShader: /* glsl */`
      uniform float uY0; varying vec2 vUv;
      void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position, 1.);
        vec3 L = vec3(-.54977, .61974, .55977);
        w.xyz -= L * ((w.y - uY0) / L.y);
        gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */`
      uniform sampler2D map; uniform float uA; varying vec2 vUv;
      void main(){ float a = texture2D(map, vUv).a; vec3 sh = vec3(.1022, .0666, .0510);
        gl_FragColor = vec4(mix(vec3(1.), sh, a * uA), 1.); }`,
    transparent: true, depthWrite: false, depthTest: false,
    blending: THREE.CustomBlending, blendSrc: THREE.DstColorFactor, blendDst: THREE.ZeroFactor, toneMapped: false,
  });
  const handShadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shadowMat);
  handShadow.matrixAutoUpdate = false; handShadow.frustumCulled = false; handShadow.renderOrder = 2; handShadow.userData.outline = false; handShadow.userData.outlineOccluder = false;
  add(handShadow);

  // —— T1：卦爻金条 ×8、火舌环、日盘 + 门户 ——
  const bars = [];
  const segs = [{ k: 1, part: 0 }, { k: 2, part: -1 }, { k: 2, part: 1 }, { k: 3, part: 0 }, { k: 4, part: 0 }, { k: 5, part: 0 }, { k: 6, part: -1 }, { k: 6, part: 1 }];
  // w3（self-08 / qa2-02）：层高重排——阴爻两段（收成光珠赶路时）在阳爻下面一层，交错时被阳爻盖住、不在上面压出斜线
  const LAYER = { '1,0': 0, '2,-1': 1, '2,1': 2, '6,-1': 3, '6,1': 4, '3,0': 5, '4,0': 6, '5,0': 7 };
  //   （只在 f101 之前用这套层高；成轮之后回到原来的层高，俯冲时离得极近，层高差会放大成几 px 的环径差，保持和 v2 一致）
  segs.forEach((s, i) => { const b = makeBar(); b.userData.seg = s; b.userData.layerA = LAYER[`${s.k},${s.part}`] ?? i; b.userData.layerB = i; b.userData.layer = i; bars.push(b); add(b); });
  // 火舌环（⑬）：H1 平面上的方卡。fix1（style-09 / tech-06）：舌数 28 → 44、色由根到尖平滑过渡、
  // 后面再叠一排更长更浅的火舌（#F2DEC4 α0.7）；3/9 点钟缺口两侧舌长平滑收到 0（不再被竖直截断）；
  // 抗锯齿宽度用连续量（不对按舌号跳变的 x 求导，去掉放射状虚线）
  const flameMat = cardMat(/* glsl */`
    uniform vec3 uC; uniform float uR0, uLen, uGrow, uOmega, uJit, uF2, uStretch, uN;
    vec4 tongue(float r, float th, float N, float ofs, float lenMul, float hwMul, vec3 c0, vec3 c1, vec3 c2, float aaW, float gapK){
      float sp = 6.28318 / N;
      float kc = floor((th - uOmega - ofs) / sp + .5);
      float cov = 0.; vec3 col = vec3(0.);
      for (int j = -1; j <= 1; j++) {
        float k = kc + float(j);
        float kk = mod(k, N);
        float ang = uOmega + ofs + k * sp;
        float lenK = (mod(kk, 2.) < .5 ? 1. : .72) * (1. + uJit * (bbH2(vec2(kk + ofs * 7., uF2)) * 2. - 1.));
        // 缺口（3/9 点钟 = 角 0 与 π）两侧：舌长平滑收到 0
        float gd = min(abs(atan(sin(ang), cos(ang))), abs(atan(sin(ang - 3.14159), cos(ang - 3.14159))));
        lenK *= smoothstep(gapK, gapK + .16, gd);
        float L = uLen * lenK * lenMul * uGrow * (1. + 2. * uStretch);
        if (L <= 1e-5) continue;
        float rho = (r - uR0) / L;
        if (rho < -.25 || rho > 1.) continue;
        float dth = atan(sin(th - ang), cos(th - ang));
        float x = dth * r / (sp * uR0);
        float rr = clamp(rho, 0., 1.);
        float hw = .30 * hwMul * pow(1. - rr, .8) * (1. - .25 * uStretch);
        float off = .32 * sin(3.14159 * rr * 1.3) * (mod(kk, 2.) < .5 ? 1. : -1.);
        float dd = abs(x - off) - hw;
        // 舌根圆帽：根部收成半圆，不再是一道径向截口
        float cap = length(vec2(x, min(rho, 0.) * L / (sp * uR0) * 3.)) - .30 * hwMul;
        dd = rho < 0. ? cap : dd;
        float c = 1. - smoothstep(-aaW, aaW, dd);
        vec3 cc = mix(mix(c0, c1, smoothstep(.18, .42, rr)), c2, smoothstep(.65, .92, rr));
        col = mix(col, cc, c); cov = max(cov, c);
      }
      return vec4(col, cov);
    }
    void main(){
      vec2 d = vWorld.xz - uC.xz;
      float r = length(d), th = atan(d.y, d.x);
      float aaW = length(fwidth(vWorld.xz)) / (6.28318 / uN * uR0) * 1.5 + 1e-4;
      vec3 cRoot = vec3(.4125, .1878, .0423), cBody = vec3(.6795, .3916, .1022), cTip = vec3(.9047, .7605, .4342), cPale = vec3(.8879, .7305, .5521);
      vec4 back = tongue(r, th, uN, 3.14159 / uN, 1.38, 1.15, cBody, cPale, cPale, aaW, .26);
      vec4 front = tongue(r, th, uN, 0., 1.0, 1.0, cRoot, cBody, cTip, aaW, .22);
      vec3 col = mix(back.rgb, front.rgb, front.a);
      float a = max(front.a, back.a * .7);
      if (a < .002) discard;
      gl_FragColor = vec4(col, a);
    }`, { uC: { value: H1.clone() }, uR0: { value: 0.0545 }, uLen: { value: 0.0115 }, uGrow: { value: 0 }, uOmega: { value: 0 }, uJit: { value: 0.06 }, uF2: { value: 0 }, uStretch: { value: 0 }, uN: { value: 44 } },
  { side: THREE.DoubleSide });
  const flame = add(card(flameMat, 2.5)); flame.position.copy(H1).add(new THREE.Vector3(0, -0.0002, 0)); flame.rotation.x = -Math.PI / 2; flame.scale.set(0.3, 0.3, 1);
  flame.userData.outlineOccluder = false;
  flameMat.uniforms.uLen.value = 0.016;
  // 日盘 + 细粉环 + 虹膜门户。fix1（style-09 ④）：胭脂日铺满光轮内径（R 0.0485，约占火舌环内径 89%），
  // 五道金环压在胭脂日上，日缘外一道细粉环线——读成"日轮"，不再是金色靶心
  const SUN_R = 0.0485;
  const sunMat = cardMat(/* glsl */`
    uniform vec3 uC; uniform float uR, uRing, uIris, uPortalOn; uniform sampler2D tPortal; uniform float uLight;
    void main(){
      float r = length(vWorld.xz - uC.xz);
      float aa = fwidth(r) * 1.2 + 1e-6;
      float disk = (1. - smoothstep(uR - aa, uR + aa, r)) * step(1e-6, uR);
      vec3 car = vec3(.2961, .0129, .0529) * uLight;                       // #951E41
      vec3 col = car;
      // 外缘一道深一档带
      col = mix(col, car * .78, smoothstep(uR * .955 - aa, uR * .955 + aa, r));
      float a = disk;
      // 细粉环线（日缘外）
      float ring = (1. - smoothstep(.00028 - aa, .00028 + aa, abs(r - uR * 1.045))) * uRing;
      col = mix(col, vec3(.7991, .3916, .3564), ring * (1. - disk)); a = max(a, ring);
      // 虹膜门户
      if (uPortalOn > .5 && r < uIris + aa * 2.) {
        vec3 pc = bbS2L(texture2D(tPortal, gl_FragCoord.xy / uRes).rgb);
        float m = 1. - smoothstep(uIris - aa, uIris + aa, r);
        col = mix(col, pc, m);
        float pw = fwidth(r);
        float gl = 1. - smoothstep(1.5 * uK * pw - pw, 1.5 * uK * pw + pw, abs(r - uIris));
        col = mix(col, vec3(.7605, .4851, .0437) * 1.6, gl * step(.00001, uIris));
        a = max(a, m);
      }
      gl_FragColor = vec4(col, a);
    }`, { uC: { value: H1.clone() }, uR: { value: 0 }, uRing: { value: 0 }, uIris: { value: 0 }, uPortalOn: { value: 0 }, tPortal: { value: null }, uLight: { value: 1 } },
  { side: THREE.DoubleSide });
  const sun = add(card(sunMat, 2.8)); sun.position.copy(H1).add(new THREE.Vector3(0, -0.0001, 0)); sun.rotation.x = -Math.PI / 2; sun.scale.set(0.12, 0.12, 1);
  sun.userData.outlineOccluder = false;
  // 门户：日心的虹膜（单独一张盘，画在金环之上，门里是场景 Y）
  const irisMat = cardMat(/* glsl */`
    uniform vec3 uC; uniform float uIris; uniform sampler2D tPortal;
    void main(){
      float r = length(vWorld.xz - uC.xz);
      float aa = fwidth(r) * 1.2 + 1e-6;
      if (r > uIris + aa * 2. || uIris <= 1e-6) discard;
      vec3 pc = bbS2L(texture2D(tPortal, gl_FragCoord.xy / uRes).rgb);
      float m = 1. - smoothstep(uIris - aa, uIris + aa, r);
      float pw = fwidth(r);
      float gl = 1. - smoothstep(1.5 * uK * pw - pw, 1.5 * uK * pw + pw, abs(r - uIris));
      vec3 col = mix(pc, vec3(.7605, .4851, .0437) * 1.6, gl);
      gl_FragColor = vec4(col, max(m, gl));
    }`, { uC: { value: H1.clone() }, uIris: { value: 0 }, tPortal: { value: null } }, { side: THREE.DoubleSide });
  const iris = add(card(irisMat, 4.0)); iris.position.copy(H1).add(new THREE.Vector3(0, 0.0012, 0)); iris.rotation.x = -Math.PI / 2; iris.scale.set(0.12, 0.12, 1);
  iris.userData.outlineOccluder = false;

  // —— S6：墙、越肩背影、补书的手 ——
  const wallMat = toon({ color: '#D9C48F', shade1: '#B89A68', shade2: '#B89A68', step1: 0.3, step2: 0, edgeNoise: 0 },
    { extraAlbedo: /* glsl */`
      { vec2 q = vWP.xy;
        float mott = bbFbm(q * 3.6) - .5; diffuseColor.rgb *= 1. + .07 * mott;
        float fl = bbFbm(q * 9.0 + 3.1);
        float m = smoothstep(.745, .76, fl);
        diffuseColor.rgb = mix(diffuseColor.rgb, mix(diffuseColor.rgb, vec3(.8069, .7230, .5647), .18), m);
        float edge = smoothstep(.70, .72, fl) - m; diffuseColor.rgb *= 1. - .10 * edge; }` });
  const wall = add(bindT(new THREE.Mesh(new THREE.PlaneGeometry(7.0, 3.6), wallMat)));
  wall.position.set(-0.4, 0.9, -0.65);
  const winWallMat = cardMat(/* glsl */`
    uniform vec4 uWin; uniform vec3 uWall, uWallS, uLightC, uLeafC; uniform float uGoboT;
    void main(){
      vec2 w = vec2(vWorld.z, vWorld.y);
      vec2 lo = uWin.xy, hi = uWin.zw;
      float aa = fwidth(w.x) * 1.5;
      vec2 a = smoothstep(lo - aa, lo + aa, w) * (1. - smoothstep(hi - aa, hi + aa, w));
      float win = a.x * a.y;
      float mun = 0.;
      for (int i = 1; i <= 2; i++) { float zc = mix(lo.x, hi.x, float(i) / 3.); mun = max(mun, 1. - smoothstep(.015 - aa, .015 + aa, abs(w.x - zc))); }
      { float yc = mix(lo.y, hi.y, .5); mun = max(mun, 1. - smoothstep(.015 - aa, .015 + aa, abs(w.y - yc))); }
      // 窗外柳：几条垂枝的剪影（与 gobo 同一套枝条）
      float lf = 0.;
      for (int b = 0; b < 3; b++) {
        float fb = float(b);
        float zb = mix(lo.x, hi.x, .30 + .22 * fb) + .05 * sin(fb * 2.3);
        float topY = hi.y + .12, botY = mix(lo.y, hi.y, .52 - .14 * fb);
        float sw = sin(.9 * uGoboT + fb * 1.7) * .03;
        float dn = clamp((topY - w.y) / (topY - botY), 0., 1.);
        float bz = zb + sw * dn + .06 * dn * dn;
        float k = floor((topY - w.y) / .036);
        for (int j = -1; j <= 1; j++) {
          float kk = k + float(j); float yk = topY - kk * .036; if (yk < botY || kk < 0.) continue;
          float dnk = (topY - yk) / (topY - botY); float bzk = zb + sw * dnk + .06 * dnk * dnk;
          float side = mod(kk, 2.) < .5 ? 1. : -1.; float ang = -1.5708 + side * .62;
          vec2 c = vec2(bzk, yk) + vec2(cos(ang), sin(ang)) * .03;
          vec2 d = w - c; float co = cos(ang), si = sin(ang); vec2 l = vec2(co * d.x + si * d.y, -si * d.x + co * d.y);
          lf = max(lf, 1. - smoothstep(.9, 1.1, length(l / vec2(.03, .009))));
        }
        lf = max(lf, (1. - smoothstep(.002, .004, abs(w.x - bz))) * step(botY, w.y));
      }
      vec3 wallC = mix(uWallS, uWall, smoothstep(0., 1.2, w.y));
      wallC *= 1. + .05 * (bbFbm(w * 3.) - .5);
      vec3 glow = mix(uLightC, uLightC * vec3(1., .97, .9), w.y - lo.y);
      vec3 c = mix(wallC, glow, win);
      c = mix(c, uWallS * .55, win * mun);
      c = mix(c, uLeafC, win * lf * .85);
      gl_FragColor = vec4(c, 1.);
    }`, { uWin: { value: goboUniforms.uWin.value }, uWall: { value: lin('#C9B07A') }, uWallS: { value: lin('#8F7650') }, uLightC: { value: lin('#FFF1C8').multiplyScalar(1.25) }, uLeafC: { value: lin('#7A6A40') }, uGoboT: goboUniforms.uGoboT },
  { transparent: false, depthWrite: true, side: THREE.DoubleSide });
  const winWall = add(card(winWallMat, 0));
  winWall.position.set(-1.4, 1.0, 0.9); winWall.rotation.y = Math.PI / 2; winWall.scale.set(4.6, 4.0, 1);
  const SPOT_FS = {
    pars: /* glsl */`uniform vec4 uLs[18]; uniform vec4 uLsB[18]; uniform float uLsOn, uLsMorph; uniform vec4 uLsPhase;` + THICK_PARS,
    body: THICK_BODY + /* glsl */`
      // 人身上的光斑（fix1，style-15 / story-10）：人整个压在一档暖色树荫里，叶隙漏下的日光是加上去的暖光（#FFF1C8，带 HDR 让 bloom 吃到），
      // 先是软边椭圆（小孔成像的日影），再一齐变成「光斑态」文斑（豹纹：瓣亮、心 18%、外缘一线亮边、外面一圈柔光晕），随叶影轻闪
      if (uLsOn > 0.) {
        float acc = 0., glow = 0., rimA = 0., fl = 1.;
        for (int i = 0; i < 18; i++) {
          vec4 s = uLs[i]; vec4 b = uLsB[i];
          if (s.z <= 0.) continue;
          float mph = b.w;
          vec2 c = mix(b.xy, s.xy, mph);
          float R = mix(b.z, s.z, mph);
          vec2 q = (vPx - c) / R;
          if (dot(q, q) > 5.) continue;
          vec2 qe = bbRot(q, s.w + 1.1) * vec2(1., 1.6);
          float ell = 1. - smoothstep(.55, 1.0, length(qe));
          vec2 qr = bbRot(q, s.w);
          float d = bbWbPetal(qr, float(i) + 40., vec4(.8029, .2443, .2443, .2443), .36);
          float aa = fwidth(d) * 1.2 + .004;
          float wb = 1. - smoothstep(-aa, aa, d);
          float th = atan(qr.y, qr.x); if (th < 0.) th += 6.2831853;
          float cen = (1. - smoothstep(.55 * bbWbRho(th, float(i) + 40.) - .05, .55 * bbWbRho(th, float(i) + 40.) + .05, length(qr))) * .18;
          float k = smoothstep(.0, .6, mph);
          float v = mix(ell, max(wb, cen), k);
          float fi = 1. + .08 * sin(uT * 5.3 + float(i) * 1.7);
          if (v * fi > acc) { acc = v * fi; fl = fi; }
          float gd = mix(length(qe) - 1., d, k);
          glow = max(glow, (1. - smoothstep(0., .32, gd)) * step(0., gd) * fi);
          rimA = max(rimA, (1. - smoothstep(.0, .045 + aa, abs(d + .015))) * k);
        }
        vec3 sunC = vec3(1., .8796, .5776);                            // #FFF1C8
        vec3 shade = col * vec3(.80, .73, .60);                         // 树荫：暖色暗一档（不再压成灰紫）
        vec3 lit = (col * vec3(1.22, 1.05, .62) + vec3(.04, .03, 0.)) * 1.06;   // 叶隙日光：暖黄（约 #FFF0BC），比树荫里的衬衫亮 35 以上，略带 HDR
        vec3 c2 = mix(shade, lit, clamp(acc, 0., 1.1));
        c2 += sunC * glow * .05;
        c2 = mix(c2, sunC * 1.05, rimA * .35);
        col = mix(col, c2, uLsOn);
      }`,
  };
  const desk6 = makeSprite(tex.lw_desk_back, { order: 30, frag: SPOT_FS, lineCol: '#2E2420',
    uniforms: { uLs: { value: [...Array(18)].map(() => new THREE.Vector4()) }, uLsB: { value: [...Array(18)].map(() => new THREE.Vector4()) }, uLsOn: { value: 0 }, uLsMorph: { value: 0 }, uLsPhase: { value: new THREE.Vector4() }, uThick: { value: 1.0 } } });
  add(desk6.group);
  const mendR = makeSprite(tex.hands_mending, { order: 31, frag: SPOT_FS, lineCol: '#2E2420',
    uniforms: { uLs: { value: [...Array(18)].map(() => new THREE.Vector4()) }, uLsB: { value: [...Array(18)].map(() => new THREE.Vector4()) }, uLsOn: { value: 0 }, uLsMorph: { value: 0 }, uLsPhase: { value: new THREE.Vector4() }, uThick: { value: 1.0 } } });
  const mendL = makeSprite(tex.hands_mending, { order: 29, frag: SPOT_FS, lineCol: '#2E2420',
    uniforms: { uLs: { value: [...Array(18)].map(() => new THREE.Vector4()) }, uLsB: { value: [...Array(18)].map(() => new THREE.Vector4()) }, uLsOn: { value: 0 }, uLsMorph: { value: 0 }, uLsPhase: { value: new THREE.Vector4() }, uThick: { value: 1.0 } } });
  for (const sp of [desk6, mendR, mendL]) { sp.color.material.depthTest = false; sp.mask.visible = false; }
  mendR.crop.set(0.50, 0.0, 1.0, 1.0);       // 右手（执笔）+ 袖口（袖口出画下缘）
  mendL.crop.set(0.0, 0.0, 0.46, 1.0);       // 左手（按页）+ 袖口
  add(mendR.group); add(mendL.group);
  // 前臂（代码画：肤色平涂 + 深赭墨线，从衬衫袖口接到手腕）
  const armMat = cardMat(/* glsl */`
    uniform vec2 uA0, uA1; uniform float uR0, uR1;   // 屏幕设计像素：袖口端点/半径 → 腕端点/半径
    void main(){
      vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uK;
      vec2 ba = uA1 - uA0; float h = clamp(dot(p - uA0, ba) / dot(ba, ba), 0., 1.);
      float r = mix(uR0, uR1, h);
      float d = length(p - uA0 - ba * h) - r;
      float aa = 1. / uK;
      float fill = 1. - smoothstep(-aa, aa, d);
      float line = 1. - smoothstep(2.2 * .5 - aa, 2.2 * .5 + aa, abs(d + 1.1));
      vec3 skin = vec3(.7682, .4508, .3419), ink = vec3(.0273, .0176, .0144);
      vec3 c = mix(skin, ink, line * step(.001, h) * step(h, .999));
      gl_FragColor = vec4(c, fill);
    }`, { uA0: { value: new THREE.Vector2() }, uA1: { value: new THREE.Vector2() }, uR0: { value: 30 }, uR1: { value: 20 } }, { depthTest: false });
  const arm = add(card(armMat, 30.5));

  // —— 每帧 ——
  const _c = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _m = new THREE.Matrix4();
  const camAt = (pos, yaw, pitch) => aimCamera(cam, pos, yaw, pitch);
  const camLook = (pos, target) => { cam.position.copy(pos); cam.up.set(0, 1, 0); cam.lookAt(target); cam.updateMatrixWorld(true); };
  function hideAll() {
    for (const b of bars) b.visible = false;
    flame.visible = sun.visible = iris.visible = false;
    pinch.group.visible = open.group.visible = false; handShadow.visible = false;
    desk6.group.visible = mendR.group.visible = mendL.group.visible = arm.visible = false;
    wall.visible = false; glasses.visible = false; winWall.visible = false;
    pageU.uYaoGlow.value = 0; pageU.uYaoDark.value = 0; for (let k = 0; k < 6; k++) { pageU.uYaoA.value[k] = 1; pageU.uYaoSh.value[k].z = 0; }
    pageU.uContrast.value = 1;
    goboUniforms.uGoboOn.value = 1;
    setTweezers(new THREE.Vector3(0.171, 0.0205, 0.104), new THREE.Vector3(0.255, 0.0235, 0.165));
    flap.position.copy(FLAP0); flap.rotation.set(0, 0, 0);
    setBook();
  }
  // S1 机位
  function camS1(f) {
    cam.fov = 22.07; cam.updateProjectionMatrix();     // S6 会改焦段，这里每帧还原
    const u = ss5(f / 81);
    const T = _c.set(lerp(0.030, 0.080, u), lerp(0.012, 0.015, u), lerp(-0.010, -0.022, u));
    const D = lerp(1.055, 0.900, u);
    const pos = new THREE.Vector3(T.x, T.y + D * Math.sin(60 * DEG), T.z + D * Math.cos(60 * DEG));
    camAt(pos, 0, -60 * DEG);
  }
  // T1 机位
  const diveD = loglin([[116, 0.370], [122, 0.330], [128, 0.180], [134, 0.080], [139, 0.030]]);
  function camT1(t) {
    cam.fov = 22.07; cam.updateProjectionMatrix();
    const f = t * 24;
    let pitch, D; const T = new THREE.Vector3();
    if (f < 100) {
      const u = ss5((f - 81) / 19);
      pitch = lerp(60, 90, u) * DEG; T.set(lerp(0.080, H1.x, u), lerp(0.015, H1.y, u), lerp(-0.022, H1.z, u)); D = lerp(0.900, 0.420, u);
    } else if (f < 116) { pitch = 90 * DEG; T.copy(H1); D = lerp(0.420, 0.370, (f - 100) / 16); }
    else { pitch = 90 * DEG; T.copy(H1); D = diveD(f); }
    const pos = new THREE.Vector3(T.x, T.y + D * Math.sin(pitch), T.z + D * Math.cos(pitch));
    camAt(pos, 0, -pitch);
    return D;
  }
  // 手：朝相机的面片
  const QFLAT = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
  function placeHand(sp, anchorPx, P, pxPerM, toCam = 0) {
    cam.getWorldQuaternion(_q);
    const q = QFLAT.clone().slerp(_q, toCam);
    placeSprite(sp, P, q, anchorPx, pxPerM);
    sp.group.visible = true;
  }
  function shadowOf(sp) {
    handShadow.visible = true;
    shadowMat.uniforms.map.value = sp.U.map.value;
    sp.color.updateMatrixWorld(true);
    handShadow.matrix.copy(sp.group.matrixWorld);
    handShadow.matrixWorld.copy(sp.group.matrixWorld);
  }
  // 世界点：屏幕 (x,y) 视线与平面 y=y0 的交点
  const rayToY = (sx, sy, y0) => {
    const n = screenToWorld(cam, W, H, sx * K, sy * K, 1);
    const d = n.sub(cam.position).normalize();
    const s = (y0 - cam.position.y) / d.y;
    return cam.position.clone().addScaledVector(d, s);
  };

  // 镊子姿态
  const TW_TIP = new THREE.Vector3(0.170, 0.019, 0.105), TW_END = new THREE.Vector3(0.255, 0.024, 0.165);
  function setTweezers(tip, end) {
    tweezers.position.copy(tip);
    const d = end.clone().sub(tip); const len = d.length();
    tweezers.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), d.normalize());
    tweezers.scale.set(len / 0.11, 1, 1);
  }
  // 眼镜：静置（折叠、镜片朝下）
  const GL_REST = new THREE.Vector3(0.215, 0.0075, -0.200);
  const GL_Q0 = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2 - 0.05, 0.3, 0.02, 'YXZ'));

  const api = {
    scene, cam, H0, H1, bars, sun, sunMat, flame, iris, pageU, goboUniforms, pinch, open,
    // S1：返回叠加层需要的信息
    updateS1(t) {
      hideAll();
      const f = t * 24, fi = Math.round(f), f2 = fi - (fi & 1), tc = f2 / 24;
      camS1(f);
      goboUniforms.uGoboT.value = t;
      pageU.uContrast.value = lerp(0.92, 1.0, fseg(f, 62, 66));
      const info = { glints: [], band: 0, dot: null, lineOpacity: lerp(0.55, 1.0, fseg(f, 62, 66)) };
      // 纸片
      const fl = fi < 21 ? 0 : fi < 27 ? 12 * eo((fi - 21) / 3) : fi < 32 ? 12 + 8 * eo((fi - 27) / 3) : 20 * (1 - eo((f - 32) / 5));
      flap.position.copy(FLAP0); flap.rotation.set(0, 0, 0); flap.rotateOnAxis(new THREE.Vector3(0.6, 0, -0.8).normalize(), -fl * DEG);
      // 卦画收尾：墨色加深、六爻边缘透金
      pageU.uYaoDark.value = 0.08 * fseg(f, 74, 81); pageU.uYaoGlow.value = 0.3 * fseg(f, 74, 81);
      // 镊子
      const held = f < 32;
      if (held) {
        const j = (hashi(f2) - 0.5) * 0.0024;
        const lift = fi >= 21 && fi < 24 ? 0.002 : fi >= 27 && fi < 30 ? 0.0025 : 0;
        const tip = new THREE.Vector3(0.171 + j, 0.0215 + lift, 0.104);
        const end = new THREE.Vector3(0.246 + j, 0.052 + lift, 0.152);
        setTweezers(tip, end);
        // 捏手：捏合点在镊柄上（距尖 62%）
        const grip = tip.clone().lerp(end, 0.62).add(new THREE.Vector3(0, 0.004, 0));
        placeHand(pinch, A10.pinch_point.px, grip, 5200);
        shadowOf(pinch);
      } else {
        const u = clamp((f - 32) / 3), bounce = f >= 35 && f < 37 ? 0.001 * Math.sin((f - 35) / 2 * Math.PI) : 0;
        const tip = new THREE.Vector3(0.171, lerp(0.0215, 0.0205, u) + bounce, 0.104);
        const end = new THREE.Vector3(lerp(0.246, 0.255, u), lerp(0.052, 0.0235, eio(u)) + bounce, lerp(0.152, 0.165, u));
        setTweezers(tip, end);
      }
      // 张开的手：f32–f50，f36–f44 食指尖墨渍落在 A
      if (!api._PA) { camS1(40); api._PA = rayToY(1188, 592, 0.021 + 0.012); camS1(f); }
      const PA = api._PA;
      const fh = f2;            // 角色（手）与手里的道具（眼镜）一拍二
      if (!held && f < 50) {
        const slide = ss(fseg(fh, 44, 50));
        const P = PA.clone().add(new THREE.Vector3(0.05, 0.010, -0.115).multiplyScalar(slide));
        const settle = fh < 36 ? (1 - eo((fh - 32) / 4)) * 0.008 : 0;
        P.y += settle; P.x += (hashi(f2 + 3) - 0.5) * 0.0006;
        placeHand(open, INK11[0].px, P, 5400);
        open.U.uHandBri.value = 1 + 0.08 * (fh >= 36 && fh < 46 ? 1 : 0);
        shadowOf(open);
      }
      // 眼镜
      glasses.visible = true;
      // 眼镜：f52 捏住右镜腿 → 升起、转向镜头、变大 → f62 右镜框扫过（一闪）→ f66 从右上出画（他戴上了）
      if (f < 52) {
        glasses.position.copy(GL_REST);
        glasses.quaternion.copy(GL_Q0);
        // 折起：两条镜腿向内折到镜框后面（右腿压在左腿上）
        templeL.rotation.set(0, -Math.PI / 2 * 0.97, 0); templeR.rotation.set(0, Math.PI / 2 * 0.97, 0);
        templeR.position.y = 0.0035;
        lensMat.uniforms.uSweep.value = -9;
      } else {
        if (!api._GLK) {
          camS1(52); const r = project(cam, W, H, GL_REST);
          api._GLK = [[52, r.x / K, r.y / K, r.z], [56, 1400, 260, 0.78], [60, 1470, 300, 0.52], [62, 1590, 230, 0.43], [66, 2400, -360, 0.32]];
          api._GLX = monotone(api._GLK.map(k => [k[0], k[1]])); api._GLY = monotone(api._GLK.map(k => [k[0], k[2]])); api._GLD = monotone(api._GLK.map(k => [k[0], Math.log(k[3])]));
          camS1(f);
        }
        const x = api._GLX(fh), y = api._GLY(fh), D = Math.exp(api._GLD(fh));
        glasses.position.copy(screenToWorld(cam, W, H, x * K, y * K, D));
        const q1 = cam.quaternion.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.10, -0.30 + 0.5 * fseg(fh, 56, 66), -0.06)));
        glasses.quaternion.copy(GL_Q0).slerp(q1, ss(fseg(fh, 52, 60)));
        const unf = ss(fseg(fh, 53, 59));
        templeL.rotation.set(0, -Math.PI / 2 * 0.97 * (1 - unf), 0); templeR.rotation.set(0, Math.PI / 2 * 0.97 * (1 - unf), 0);
        templeR.position.y = 0.0035 * (1 - unf) + 0.001;
        lensMat.uniforms.uSweep.value = lerp(-1.2, 1.2, fseg(f, 59, 64));
      }
      glasses.updateMatrixWorld(true);
      // 捏住镜腿的手
      if (f >= 50 && f < 67) {
        let P;
        if (f < 52) {
          const grab = templeR.localToWorld(new THREE.Vector3(0, 0, -0.06));
          const from = PA.clone().add(new THREE.Vector3(0.05, 0.010, -0.115));
          P = from.lerp(grab.add(new THREE.Vector3(0, 0.006, 0)), ss(fseg(fh, 50, 52)));
        } else P = templeR.localToWorld(new THREE.Vector3(0, 0, -0.05));
        placeHand(pinch, A10.pinch_point.px, P, 5200, ss(fseg(fh, 53, 60)));
        if (f < 56) shadowOf(pinch);
      }
      // f62 镜片一闪：在右镜框此刻的屏幕点；满画面斜 35° 亮带 f62–f65
      if (f >= 61 && f < 66) {
        const rp = rimR.localToWorld(new THREE.Vector3(0.021, 0.012, 0));
        const s = project(cam, W, H, rp);
        const k = f < 62 ? (f - 61) : 1 - eo((f - 62) / 4);
        info.glints.push([s.x / K, s.y / K, 220, Math.max(0, k)]);
        info.band = f >= 62 ? 0.40 * (1 - fseg(f, 62, 65)) : 0;
        info.bandOff = lerp(-700, 700, fseg(f, 62, 65));
      }
      // 暖色小光点：f66–f74 从左页滑到卦画中心，f74–f81 呼吸
      if (f >= 66) {
        const hs = project(cam, W, H, H0);
        const u = ss(fseg(f, 66, 74));
        const x = lerp(700, hs.x / K, u), y = lerp(640, hs.y / K, u);
        const br = f >= 74 ? 1 + 0.06 * Math.sin((f - 74) / 24 * Math.PI * 2 * 1.4) : 1;
        info.dot = [x, y, 24 * br, 0.55 * fseg(f, 66, 68)];
      }
      info.dust = 0.8;
      return info;
    },
    updateT1(t, portalTex) {
      hideAll();
      const f = t * 24, fi = Math.round(f), f2 = fi - (fi & 1);
      const D = camT1(t);
      goboUniforms.uGoboT.value = t;
      const info = { glints: [], dot: null, line: 0, iris: 0, portal: false, D };
      // 页上爻影淡到 25%
      for (let k = 1; k <= 6; k++) {
        const f0 = 81 + 2 * (k - 1);
        pageU.uYaoA.value[k - 1] = lerp(1, 0.25, ss(fseg(f, f0, f0 + 4)));
      }
      pageU.uYaoDark.value = 0.08; pageU.uYaoGlow.value = 0.3 * (1 - fseg(f, 81, 90));
      const mBend = ss(fseg(f, 94, 102));
      // fix3（self-08）：弯曲途中金条互相穿插——原来中点移动、曲率、弧长三件事同时走（曲率 = m/R），
      //   半弯的金条是一段段圆心各不相同的大圆弧，上下两侧的臂在环外交叉。改成分三步、全程同心：
      //   ① f94–f97 中点先平移到各自环位（直条沿径向散开，阴爻两段同时转 90°）；② f96–f99 在短条长度下曲率升到 1/R
      //   （中点已就位，各段是以 H1 为圆心的同心弧，半径不同、不相交）；③ f97.5–f103 弧长沿各自的圆周长到整环 / 半环。
      const mMove = ss(fseg(f, 94, 97)), mKap = ss(fseg(f, 96, 99)), mLen = ss(fseg(f, 97.5, 103));
      const lockS = f >= 106 ? lerp(1.04, 1.0, eo(fseg(f, 106, 110))) : (f >= 102 ? lerp(1.0, 1.04, fseg(f, 102, 106)) : 1);
      for (const b of bars) {
        const { k, part } = b.userData.seg;
        b.userData.layer = f < 101 ? b.userData.layerA : b.userData.layerB;
        const f0 = 81 + 2 * (k - 1);
        b.visible = f >= f0;
        if (!b.visible) continue;
        const h = 0.0005 + 0.030 * eo(fseg(f, f0, f0 + 8));
        // w3（self-08）：翻面最晚在 f95.5 翻完——上六（f0 = 91）原来 f92–f98 才翻完，f95 正好侧立成两道黑细线斜压在九五两端
        const psi = Math.PI * ss(fseg(f, f0 + 1, Math.min(f0 + 7, 95.5)));
        const yBase = H0.y + h;
        const gold = psi > Math.PI / 2 ? 1 : 0;
        b.material.uniforms.uGold.value = gold;
        b.material.uniforms.uFoilA.value = -Math.PI + 2 * Math.PI * fseg(f, 106, 116) - Math.PI / 2;
        b.material.uniforms.uFoilOn.value = f >= 106 && f < 117 ? 1 : 0;
        b.material.uniforms.uLight.value = 1;
        // 爻影（只在弯曲前）
        if (k <= 6) {
          const off = h - 0.0005;
          pageU.uYaoSh.value[k - 1].set(-LDIR.x / LDIR.y * off, -LDIR.z / LDIR.y * off, lerp(0.30, 0.18, off / 0.03) * (1 - mBend) * (off > 0.0008 ? 1 : 0), 0);
        }
        if (k === 1) {
          // 初九：地平线
          const m1 = ss(fseg(f, 94, 106));
          const M = new THREE.Vector3(H0.x, lerp(yBase, H1.y - 0.001, m1), lerp(zk(1), H1.z, ss(fseg(f, 94, 102))));
          const L = lerp(0.090, 2.0, m1 * m1);
          const wd = lerp(0.009, 0.0008, ss(fseg(f, 94, 104)));
          setBar(b, M, new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), 0, L, wd, psi);
          b.visible = f < 106.5;
          if (f >= 106) info.line = 1;
          continue;
        }
        const R = RING_R[k];
        const wd = lerp(0.009, 0.0034, mBend);     // fix1：金环收细，胭脂日在环间透出来（读成日轮，不是金色靶心）
        if (part === 0) {
          const sgnN = Math.sign(H1.z - zk(k)) || 1;
          const N = new THREE.Vector3(0, 0, sgnN);
          const Mpage = new THREE.Vector3(H0.x, yBase, zk(k));
          const Mring = H1.clone().addScaledVector(N, -R); Mring.y = H1.y;
          const M = Mpage.lerp(Mring, mMove);
          M.y = lerp(yBase, H1.y, ss(fseg(f, 94, 98)));
          const kap = mKap / R, L = lerp(0.090, 2 * Math.PI * R, mLen);
          setBar(b, M, new THREE.Vector3(1, 0, 0), N, kap, L, wd, psi, 0, lockS);
        } else {
          // 阴爻：两段先在平面内转 90°（左段到 9 点侧、右段到 3 点侧），再弯成左右两个半环；f98–f106 整环再转 90°
          // w3：阴爻的转向与赶路都晚一点起、快一点走（f95 时还在原位收成短珠，f95–f96 之间一步跨过阳爻，渲出来的帧里不交叠）
          const turn = ss(fseg(f, 95, 97)), mMoveY = ss(fseg(f, 94.8, 97));
          const al = part * (Math.PI / 2) * turn;     // T = (cos α, 0, sin α)；左段 α→−90°（弯心在 +x）、右段 α→+90°（弯心在 −x）
          const T = new THREE.Vector3(Math.cos(al), 0, Math.sin(al));
          const N = new THREE.Vector3(-Math.sin(al), 0, Math.cos(al));
          const Mpage = new THREE.Vector3(H0.x + part * 0.026, yBase, zk(k));
          const Mring = new THREE.Vector3(H1.x + part * R, H1.y, H1.z);
          const M = Mpage.lerp(Mring, mMoveY); M.y = lerp(yBase, H1.y, ss(fseg(f, 94, 98)));
          // w3（self-08 / qa2-02）：fix3 剩下 f95–f96 两帧——阴爻两段一边转 90° 一边斜着赶路，端点顶在九三 / 九五的横条上，
          //   排成梯形（Λ）。六二要从九三下面换到最内圈、上六要从九五上面绕到最外圈，拓扑上必须和阳爻交错，躲不开。
          //   换思路：阴爻两段先顺着自己收成一颗短光珠（f94–f95.5，长 0.038 → 0.007 m），以光珠的样子赶到环位（在阳爻下面一层，
          //   交错时被阳爻盖住），到位后再沿各自的圆周展开成半环（f96.5–f102.5）。转向发生在光珠上，看不出斜线；f98–f106 整环转 90° 不变
          const Lb = lerp(0.038, 0.007, ss(fseg(f, 94, 95.5)));
          const kap = mKap / R, L = lerp(Lb, Math.PI * R * 0.86, ss(fseg(f, 96.5, 102.5)));
          const spin = (k === 2 ? 1 : -1) * (Math.PI / 2) * ss(fseg(f, 98, 106));
          setBar(b, M, T, N, kap, L, wd, psi, spin, lockS);
        }
      }
      // 火舌（f106 起生长，一拍二跳动；俯冲时沿半径拉长）
      const vDive = f > 116 ? clamp((Math.log(0.370) - Math.log(Math.max(D, 0.03))) / (Math.log(0.37) - Math.log(0.03))) : 0;
      flame.visible = f >= 105;
      flameMat.uniforms.uGrow.value = eo(fseg(f, 106, 112)) * lockS;
      flameMat.uniforms.uOmega.value = 0.07 * t;
      flameMat.uniforms.uF2.value = f2;
      flameMat.uniforms.uStretch.value = vDive;
      flame.scale.set(0.3 * lockS, 0.3 * lockS, 1);
      // 日盘：光点升起胀成日盘（铺满光轮内径）
      sun.visible = f >= 94;
      sunMat.uniforms.uR.value = SUN_R * eo(fseg(f, 94, 104)) * lockS;
      sunMat.uniforms.uRing.value = fseg(f, 100, 106);
      sunMat.uniforms.uPortalOn.value = 0;
      const irisR = 0.014 * eo(fseg(f, 116, 124)) * lockS;
      iris.visible = f >= 116;
      irisMat.uniforms.uIris.value = irisR;
      irisMat.uniforms.tPortal.value = portalTex;
      info.portal = f >= 116;
      info.irisPx = f >= 116 ? irisR * (520 / Math.tan(22.07 / 2 * DEG)) / Math.max(D - 0.0012, 1e-4) : 0;
      if (f < 94) {
        camT1(t);
        const hs = project(cam, W, H, H0);
        info.dot = [hs.x / K, hs.y / K, 24 * (1 + 0.06 * Math.sin(t * 9)), 0.55];
      } else if (f < 104) {
        const hs = project(cam, W, H, H1);
        info.dot = [hs.x / K, hs.y / K, 24, 0.55 * (1 - fseg(f, 94, 100))];
      }
      return info;
    },
    updateS6(t) {
      hideAll();
      const f = t * 24, fi = Math.round(f), f2 = fi - (fi & 1), tc = f2 / 24;
      goboUniforms.uGoboT.value = t;
      wall.visible = true; winWall.visible = true;
      glasses.visible = false; tweezers.position.set(0.29, 0.002, 0.2); setTweezers(new THREE.Vector3(0.33, 0.0015, 0.21), new THREE.Vector3(0.42, 0.0015, 0.27));
      flap.position.copy(FLAP0); flap.rotation.set(0, 0, 0);
      // 机位：越过右肩的 3/4 背后，40 mm；f658–f668 后拉 8%
      cam.fov = 27.40; cam.updateProjectionMatrix();
      const u = eo(fseg(f, 658, 668));
      const pos = new THREE.Vector3(lerp(0.95, 1.02, u), lerp(1.25, 1.30, u), lerp(2.35, 2.52, u));
      camLook(pos, new THREE.Vector3(0.10, 0.20, 0.20));
      return { cam };
    },
    s6: { desk6, mendR, mendL, arm, armMat, wall, setBook, tweezers, setTweezers },
    setFov(v) { cam.fov = v; cam.updateProjectionMatrix(); },
    rimR, glasses, tweezers,
  };
  return api;
}
