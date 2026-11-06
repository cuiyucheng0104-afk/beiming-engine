// 《豹变》D 雾山 · 长卷（SCROLL，#15 化开之后）：南山底板当画心，代码云带、近处雾丝、白鹤，金豹滑过整幅青绿长卷
// 正交相机，坐标就是设计像素（x 0..1920 居中、y 0..1040 向下），K 缩放由画布尺寸自动完成
import * as THREE from 'three';
import { makeSprite, rimOffset } from '../lib/sprite.js';
import { ribbon } from '../lib/env.js';
import { GLSL } from '../lib/glsl.js';
import { card, cardCol, cropPx } from '../lib/card.js';
import { DEG, clamp, lerp, seg, ss, ss5, eo, lin3, hashi } from '../lib/util.js';

const VS_UV = /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`;
const PAPER_FS = /* glsl */`${GLSL}
uniform vec3 uCol; varying vec2 vUv;
void main(){ float n = vnoise2(vUv * vec2(90., 50.)) * .5 + vnoise2(vUv * vec2(300., 160.)) * .5; gl_FragColor = vec4(uCol * (.96 + .06 * n), 1.); }`;
const PAINT_FS = /* glsl */`${GLSL}
uniform sampler2D uMap; uniform float uOff; uniform vec3 uMul; uniform float uSat;
varying vec2 vUv;
void main(){
  vec2 uv = vec2(vUv.x * .72 + uOff, vUv.y);       // 画心只取底板的一段，向右平移
  vec4 c = texture2D(uMap, uv);
  float sky = smoothstep(20., 48., length(c.rgb - vec3(.996, .973, .902)) * 255.);
  sky *= 1. - smoothstep(.86, .93, vUv.y);           // 返修 3（v2-08）：远山以上一律是平涂的卷纸（底板天空里那排竖向的淡条纹不再透出来）
  vec3 s = c.rgb; float l = lumS(s); s = mix(vec3(l), s, uSat);
  vec3 col = srgb2lin(s) * uMul;
  vec3 paper = srgb2lin(vec3(.933, .953, .910));
  gl_FragColor = vec4(mix(paper, col, sky), 1.);
}`;
// 返修 4（story-18）：白鹤是一只看得出形的鹤——白身、前伸的长颈和小头、黑翅尖、后拖的腿，外面一线淡墨边，在青山和白雾上都读得出
const CRANE_FS = /* glsl */`${GLSL}
uniform float uFlap; varying vec2 vUv;
float seg2(vec2 p, vec2 a, vec2 b, float r){ vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0., 1.); return length(pa - ba * h) - r; }
void main(){
  vec2 p = (vUv - .5) * vec2(2., 1.2);
  float d = length((p - vec2(.05, 0.)) * vec2(1., 2.6)) - .2;                 // 身
  d = min(d, seg2(p, vec2(-.12, .02), vec2(-.62, .1), .035));                   // 颈
  d = min(d, length(p - vec2(-.66, .11)) - .06);                                // 头
  d = min(d, seg2(p, vec2(.22, -.02), vec2(.78, -.08), .022));                  // 腿
  float wy = uFlap * .45;
  float dw = seg2(p, vec2(-.02, .02), vec2(-.32, .05 + wy), .07);
  dw = min(dw, seg2(p, vec2(.08, .02), vec2(.3, .07 + wy * 1.1), .07));
  dw = min(dw, seg2(p, vec2(-.32, .05 + wy), vec2(-.5, .02 + wy * 1.6), .045));
  dw = min(dw, seg2(p, vec2(.3, .07 + wy * 1.1), vec2(.46, .05 + wy * 1.7), .045));
  float dAll = min(d, dw);
  float aa = .02;
  float a = 1. - smoothstep(-aa, aa, dAll - .025);
  float edge = smoothstep(-.02, .0, dAll) * a;                                   // 淡墨边
  float tips = (1. - smoothstep(-aa, aa, dw)) * smoothstep(.25, .4, abs(p.x));    // 黑翅尖
  vec3 c = mix(vec3(.96, .965, .945), vec3(.2, .23, .25), max(edge * .85, tips));
  gl_FragColor = vec4(srgb2lin(c), a);
}`;

export function buildScroll(ctx) {
  const { W, H, K, tex, M } = ctx;
  const scene = new THREE.Scene();
  const Wd = 1040 * W / H;
  const cam = new THREE.OrthographicCamera(960 - Wd / 2, 960 + Wd / 2, 0, -1040, -100, 100);   // y 取负：设计 y 向下
  cam.position.set(0, 0, 50); cam.updateProjectionMatrix();
  const put = (m, x, y, w, h, z) => { m.position.set(x, -y, z); m.scale.set(w, h, 1); return m; };
  const tag = (m, order) => { m.renderOrder = order; m.frustumCulled = false; m.userData.outline = false; m.userData.outlineOccluder = false; return m; };
  // 卷纸（长卷留白）
  const paper = tag(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({ uniforms: { uCol: { value: lin3('#EEF3E8') } }, vertexShader: VS_UV, fragmentShader: PAPER_FS })), 0);
  put(paper, 960, 520, Wd + 40, 1080, -10); scene.add(paper);
  // 画心：南山底板
  const pu = { uMap: { value: tex.pano }, uOff: { value: 0 }, uMul: { value: new THREE.Vector3(1, 1, 1) }, uSat: { value: 1.04 } };
  const paint = tag(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({ uniforms: pu, vertexShader: VS_UV, fragmentShader: PAINT_FS })), 1);
  scene.add(paint);
  // 中层云带、近层雾丝
  // 返修 4（qa2-14）：中层云带换成 A18 手绘云带卡；近层雾丝换成 A18 软纱（不再有两道细白直线）
  const RIB = M.env.A18.items.filter(q => q.kind === 'ribbon').map(q => cropPx(tex.ribbons, ...q.bbox_px)), VEIL = M.env.A18.items.filter(q => q.kind === 'veil').map(q => cropPx(tex.ribbons, ...q.bbox_px));
  const bands = [...Array(4)].map((_, i) => { const r = card(tex.ribbons, { order: 3, crop: RIB[(i * 3 + 1) % RIB.length], depthTest: false }); cardCol(r, { fade: [.1, .1, 0, 0] }); scene.add(r); return r; });
  const mists = [...Array(2)].map((_, i) => { const r = card(tex.ribbons, { order: 6, crop: VEIL[i], depthTest: false }); cardCol(r, { fade: [.2, .2, .3, .3] }); scene.add(r); return r; });
  // 返修 4（style-22）：化开结束时手卷两端露出卷轴——左端轴头、右端天杆（暗木色 + 一线金），随后滑出画外
  const ROLL_FS = `${GLSL}
uniform float uSide; varying vec2 vUv;
void main(){
  float x = vUv.x, y = vUv.y;
  float cyl = clamp(sin(x * 3.14159), 0., 1.);                     // 圆柱的明暗（夹到 ≥ 0：pow 负数会出 NaN，经 bloom 扩成黑块）
  vec3 wood = mix(vec3(.10, .055, .03), vec3(.36, .2, .1), pow(cyl, 1.6)) * (.9 + .15 * vnoise2(vec2(x * 4., y * 60.)));
  float cap = step(y, .045) + step(.955, y);                       // 两端轴头（金）
  float band = (1. - smoothstep(.0, .006, abs(y - .06))) + (1. - smoothstep(.0, .006, abs(y - .94)));
  vec3 gold = mix(vec3(.45, .3, .1), vec3(.95, .78, .4), pow(cyl, 1.2));
  vec3 c = mix(wood, gold, clamp(cap + band, 0., 1.));
  gl_FragColor = vec4(srgb2lin(c), 1.);
}`;
  // 卷轴外侧压一块和裱边同色的绫（画心不会露到轴外）
  const mats = [0, 1].map(() => { const m = tag(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: new THREE.Color('#1D2C31') })), 8.9); scene.add(m); return m; });
  const rollers = [0, 1].map(i => { const m = tag(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({ uniforms: { uSide: { value: i } }, vertexShader: VS_UV, fragmentShader: ROLL_FS })), 9); scene.add(m); return m; });
  // 白鹤 ×7（V 字队，左下），扇翅一拍二（周期 8 帧）
  const cranes = [...Array(7)].map(() => { const m = tag(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({ uniforms: { uFlap: { value: 0 } }, vertexShader: VS_UV, fragmentShader: CRANE_FS, transparent: true, depthWrite: false })), 5); scene.add(m); return m; });
  // 金豹（姿态 4 收腿滑翔）
  const leo = makeSprite(tex.leoLeap, tex.leoLeapIn, { mode: 1, order: 8, poses: M.leoLeapPoses });
  leo.u.uGold.value = 1; leo.u.uSpot.value = 1; leo.u.uDry.value = 1; leo.u.uFlow.value = 1;   // 返修 4：格距随姿态（清单 spot_unit_px）
  scene.add(leo.group);

  // 豹在长卷里的位置：化开时和三维段同一处 (820, 470)、身长 600；f612 起从这里出发，ss 走到 (700, 430)、身长 300，正弦起伏 ±10（1.6 s 一周）
  //   返修 1：f611 → f612 不再跳 60 px、身长也不再突变（起点、缓动区间都从 f612 开始）
  const leoAt = fr => {
    if (fr < 612) return { x: 820, y: 470, len: 600 };
    const u = ss(seg(fr, 612, 635));
    return { x: lerp(820, 700, u), y: lerp(470, 430, u) + 10 * Math.sin((fr - 612) / 24 * 2 * Math.PI / 1.6) * u, len: lerp(600, 300, ss5(seg(fr, 612, 635))) };
  };
  function update(t, f, shot) {
    const fr = t * 24, f2 = f - (f % 2);
    const tt = Math.max(0, (fr - 596) / 24);
    // 画心：底板向右 140·K px/s（等于整幅手卷自右向左展开）
    // 返修 1：面片宽高比和采样区域一致（采样底板宽度的 72%，面片宽 = 高 × 0.72 × 2172 / 724），山形不再被横向拉宽
    const phh = 936, pw = phh * .72 * 2172 / 724;
    put(paint, 960, 520, pw, phh, -5);
    pu.uOff.value = .28 - tt * 140 / pw * .72;
    // 中层代码云带 230·K px/s，近层很淡的大雾丝 420·K px/s
    bands.forEach((b, i) => {
      const y = 130 + hashi(i * 5) * 200, len = 300 + 420 * hashi(i * 3), th = 18 + 14 * hashi(i * 7);   // 返修 4：云带只在天上（不压在山上读成白线）   // 返修 2（v1-10）：云带加宽、软边，只留 4 条、很淡
      const x = ((hashi(i * 11) * 2600 + tt * 230) % 2600) - 340;
      b.position.set(x, -y, 1); b.scale.set(len, len / b.userData.aspect * 2.2, 1); b.rotation.set(0, 0, 0); cardCol(b, { op: .22, mul: [1.0, 1.02, 1.0], sat: .8 }); void th;
    });
    mists.forEach((m, i) => {
      const y = 200 + hashi(i * 9) * 700, len = 900 + 600 * hashi(i), th = 60 + 60 * hashi(i * 3);
      const x = ((hashi(i * 13) * 3400 + tt * 420) % 3400) - 700;
      m.position.set(x, -y, 4); m.scale.set(len, len / m.userData.aspect, 1); cardCol(m, { op: .16 }); void th;
    });
    // 白鹤：V 字，左下
    // 白鹤：V 字队（领头在左），身 24–32 px，一拍二扇翅（周期 8 帧）
    cranes.forEach((c, i) => {
      const k = i - 3, x = 300 + Math.abs(k) * 70 + tt * 30, y = 720 + k * 36 + Math.abs(k) * 4;
      const fp = Math.floor((f2 + i * 2) / 2) % 4;
      c.material.uniforms.uFlap.value = [1, .3, -.6, .3][fp];
      const sz = 92 - Math.abs(k) * 6;   // 返修 4（story-18）：鹤身 30–40 px（面片 74–92 px）
      put(c, x, y, sz, sz * .6, 5);
    });
    // 卷轴两端：f610 起从画边滑进来停一下，f618–f626 再滑出画外（≥ 6 帧看得清）
    { const inK = ss(seg(fr, 606, 612)), outK = ss(seg(fr, 618, 626)), off = lerp(-90, 46, inK) - 150 * outK, rw = 34, rh = 1000;
      put(rollers[0], 960 - Wd / 2 + off, 520, rw, rh, 9); put(rollers[1], 960 + Wd / 2 - off, 520, rw * .8, rh * .96, 9);
      rollers.forEach(r => r.visible = fr < 627);
      put(mats[0], 960 - Wd / 2 + off - 17 - 200, 520, 400, 1100, 8.9); put(mats[1], 960 + Wd / 2 - off + 14 + 200, 520, 400, 1100, 8.9); mats.forEach(m => m.visible = fr < 627); }
    // 金豹
    const L = leoAt(fr);
    leo.setPose('4'); leo.clearBones();
    const pz = M.leoLeapPoses['4'];
    const s = L.len / pz.rect[2], hpx = pz.rect[3] * s;
    leo.group.position.set(L.x, -L.y, 8); leo.group.rotation.set(0, 0, 0); leo.group.scale.set(L.len, hpx, 1); leo.u.uFlip.value = 1;
    const ph = f2 / 24 * Math.PI * 2;
    leo.bone(1, pz.tail_root, pz.tail_tip, 40, 300, 5 * Math.sin(ph - 1.2), 0);
    leo.u.uTint.value.set(1, 1, 1); leo.u.uRimAmt.value = .6; leo.u.uRimCol.value.copy(lin3('#F3D27A')); rimOffset(leo, .3, .95, 3 * K, hpx * K);
    leo.u.uFlowT.value = (t % 1.5) - .2;
  }
  function look(t, f, shot) {
    return { outline: false, grade: { exposure: 1.02, warmth: .10, lift: [.02, .03, .035], gamma: .98, gain: 1.02, saturation: 1.04, shoulder: .9 },
      bloom: { strength: .35, threshold: .8, radius: .7, tint: '#FFE6A6' }, kuwahara: { radius: 2, farRadius: 2, farStart: 40, farEnd: 120, strength: .85, protect: null }, fog: null, paper: { strength: .12 }, vignette: .10 };
  }
  function post() { return {}; }
  // 化开时豹的遮罩：只画豹（透明底、不过 look），给总合成用来把豹排除在化开之外
  function maskRender(renderer, target) {
    const vis = scene.children.map(o => o.visible);
    scene.children.forEach(o => { o.visible = o === leo.group; });
    const cc = renderer.getClearColor(new THREE.Color()), ca = renderer.getClearAlpha();
    renderer.setRenderTarget(target); renderer.setClearColor(0x000000, 0); renderer.clear(true, true, true);
    renderer.render(scene, cam);
    renderer.setClearColor(cc, ca);
    scene.children.forEach((o, i) => { o.visible = vis[i]; });
  }
  return { scene, camera: cam, update, look, post, leoAt, maskRender };
}
