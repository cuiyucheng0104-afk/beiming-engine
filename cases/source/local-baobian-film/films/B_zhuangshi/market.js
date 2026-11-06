// market.js — 场景 M：面具集市（S3a 横掠·面具递到眼前、S3b 手抬起又放下、S3c 转身走回雾里）+ S3d 推进眼孔（门户 → 场景 Y）
// 大闹天宫式：满、吵、热——集市底板（A16）、三条朱砂幡、无五官人头剪影（脸侧一线金面具边 = 小人革面）、
// 朱砂金假光轮（躁动的火舌）、3D 金面具（A15，椭球弯面 + alphaTest 镂空眼孔 + 受光金边 + 扫光）、摊主握杆的手（A14）。
import * as THREE from 'three';
import { makeToonMaterial, bindToon } from '/films/_lib/toon.js';
import {
  W, H, K, SHARED, lin, lin3, GLSL_COMMON, cardMat, card, putCard, makeSprite, placeSprite, clearDeform,
  DEG, clamp, lerp, seg, ss, ss5, eio, eo, hashi, aimCamera, screenToWorld, project, mulberry, fseg, loglin, inkAnchors, THICK_FS,
} from './lib.js';

const FPX35 = 520 / Math.tan(31.13 / 2 * DEG), FPX50 = 520 / Math.tan(22.07 / 2 * DEG);

// 幡：朱砂 + 金边，无字
const BANNER_FS = /* glsl */`
uniform vec3 uC, uG, uS;
void main(){
  vec2 u = vUv;
  float bw = .07;
  float edge = step(u.x, bw) + step(1. - bw, u.x) + step(u.y, bw * .45);
  vec3 c = mix(uC, uG, clamp(edge, 0., 1.));
  // 下端燕尾
  float tail = abs(u.x - .5) * 2.;
  if (u.y < .12 && u.y < .12 * tail) discard;
  c *= 1. - .10 * smoothstep(.3, .9, abs(u.x - .5) * 2.);
  c = mix(c, uS, .25 * (1. - smoothstep(0., .5, u.y)));
  gl_FragColor = vec4(c, 1.);
}`;
// 人头剪影（fix3，v2-04）：原来是正圆头 + 小圆髻 + 圆角矩形肩、同一深朱褐、四个一样大，读成网页默认头像图标。
// 改成大闹天宫式的剪纸人群：四种头饰（幞头 + 两条飘带、展脚官帽、盔 + 缨、高髻 + 簪），斜肩 + 立领，
// 帽 / 发与衣两种深色平涂（立领亮一档），外缘 1–2 px 干笔起伏；大小差 15–25%、各自轻微倾斜（在 update 里摆）；
// 脸侧一线金面具边（小人革面）沿外轮廓走。飘带按一拍二轻摆。
const HEAD_FS = /* glsl */`
uniform vec3 uC, uC2, uG; uniform float uFace, uType, uSeed;
float sdBox(vec2 p, vec2 b){ vec2 d = abs(p) - b; return length(max(d, 0.)) + min(max(d.x, d.y), 0.); }
float sdSeg(vec2 p, vec2 a, vec2 b){ vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0., 1.); return length(pa - ba * h); }
float sdEll(vec2 p, vec2 r){ return (length(p / r) - 1.) * min(r.x, r.y); }
float smaxK(float a, float b, float k){ return -bbSmin(-a, -b, k); }
// 飘带：从 a 出发、沿方向角 ang（y 向上）长 L，带 S 弯，根宽 w0 收到 0.35
float ribbon(vec2 p, vec2 a, float ang, float L, float w0, float ph){
  vec2 d = vec2(cos(ang), sin(ang)), n = vec2(-d.y, d.x);
  vec2 q = p - a; float u = dot(q, d), v = dot(q, n);
  float t = clamp(u / L, 0., 1.);
  float dd = abs(v - .06 * sin(t * 3.4 + ph) * t) - w0 * (1. - .65 * t);
  return max(dd, max(-u, u - L));
}
void main(){
  vec2 p = (vUv - vec2(.5, 0.)) * vec2(1., 1.25);
  float F = uFace;
  float wob = .0030 * (bbVN(p * 38. + uSeed) - .5) * 2. + .0014 * (bbVN(p * 95. + uSeed * 1.7) - .5) * 2.;
  // 身：斜肩 + 立领 + 颈 + 头
  float ax = abs(p.x);
  float dTop = (p.y - (.50 - .55 * max(ax - .10, 0.))) * .876;
  float dSide = ax - (.44 + .06 * clamp(.36 - p.y, 0., 1.));
  float body = smaxK(dTop, dSide, .06);
  float neck = sdBox(p - vec2(0., .56), vec2(.085, .08));
  float collar = sdBox(p - vec2(0., .505), vec2(.125, .032)) - .012;
  float head = length(p - vec2(0., .78)) - .185;
  float dB = bbSmin(bbSmin(body, collar, .02), bbSmin(neck, head, .03), .03);
  // 头饰
  float dH = 1e5;
  if (uType < .5) {                     // 幞头（贴头的圆顶 + 脑后一个结）+ 两条飘带（飘向脸的反侧、往下）
    dH = max(sdEll(p - vec2(0., .855), vec2(.198, .150)), .785 - p.y);         // 包住上半个头的圆顶
    dH = min(dH, length(p - vec2(-.030 * F, .995)) - .050);                      // 脑后的结
    dH = min(dH, length(p - vec2(-.090 * F, .968)) - .030);
    float sw = .22 * sin(uTc * 2.6 + uSeed);
    float a1 = F > 0. ? 3.1416 + .50 + sw : -.50 - sw, a2 = F > 0. ? 3.1416 + .95 + sw * .7 : -.95 - sw * .7;
    dH = min(dH, ribbon(p, vec2(-.10 * F, .86), a1, .42, .026, uSeed + uTc * 2.6));
    dH = min(dH, ribbon(p, vec2(-.11 * F, .82), a2, .34, .022, uSeed + 1.7 + uTc * 2.6));
  } else if (uType < 1.5) {             // 展脚官帽：贴着头的圆顶帽身 + 后山 + 两条平伸的长翅
    dH = sdBox(p - vec2(0., .875), vec2(.125, .075)) - .062;
    dH = min(dH, sdEll(p - vec2(0., .985), vec2(.105, .075)));
    float wing = sdSeg(p, vec2(-.455, .905), vec2(.455, .925)) - .015;
    wing = min(wing, length(p - vec2(-.455, .905)) - .028);
    wing = min(wing, length(p - vec2(.455, .925)) - .028);
    dH = min(dH, wing);
  } else if (uType < 2.5) {             // 盔 + 护颈 + 盔尖 + 缨（缨倒向脸的反侧）
    dH = length(p - vec2(0., .80)) - .205;
    dH = min(dH, sdBox(p - vec2(0., .655), vec2(.215, .042)) - .02);
    dH = min(dH, sdEll(p - vec2(0., 1.0), vec2(.03, .065)));
    // 缨：从盔尖向后上方甩出的一束长缨（根细、梢宽、末端分两绺），倒向脸的反侧
    vec2 qy = bbRot(p - vec2(0., 1.05), -.95 * F);      // 局部 y 沿缨
    float ty = clamp(qy.y / .17, 0., 1.);
    float tas = max(abs(qy.x - .012 * F * sin(ty * 3.)) - mix(.010, .040, smoothstep(0., .8, ty)) * (1. - .35 * smoothstep(.85, 1., ty)), max(-qy.y, qy.y - .17));
    tas = min(tas, length(qy - vec2(-.018, .175)) - .024);
    tas = min(tas, length(qy - vec2(.020, .165)) - .022);
    dH = min(dH, tas);
  } else {                              // 高髻 + 一小环 + 横簪
    dH = sdEll(p - vec2(.015 * F, 1.0), vec2(.085, .125));
    dH = min(dH, length(p - vec2(-.07 * F, 1.07)) - .048);
    dH = min(dH, sdSeg(p, vec2(-.17, 1.05), vec2(.18, .97)) - .008);
    dH = min(dH, length(p - vec2(.18, .97)) - .020);
    dH = min(dH, length(p - vec2(-.17, 1.05)) - .014);
  }
  float d = min(dB, dH) + wob;
  float aa = fwidth(d) * 1.2;
  float a = 1. - smoothstep(-aa, aa, d);
  if (a <= 0.) discard;
  float isH = 1. - smoothstep(-aa, aa, dH + wob - .002);
  vec3 c = mix(uC, uC2, isH);
  c = mix(c, min(uC * 1.55, vec3(1.)), (1. - smoothstep(-aa, aa, collar)) * (1. - isH) * .85);   // 立领亮一档
  // 脸侧金面具边：沿外轮廓、朝脸一侧、耳到下颌一段
  float rim = (1. - smoothstep(0., aa * 3. * uK, abs(d + .010))) * smoothstep(.06, .15, p.x * F) * smoothstep(.60, .64, p.y) * (1. - smoothstep(.80, .86, p.y)) * (1. - isH);
  c = mix(c, uG, rim);
  gl_FragColor = vec4(c, a);
}`;
// 假光轮：朱砂盘 + 躁动的金火舌（⑬，N = 36，一拍二跳动）。fix1：根→身→尖平滑过渡；抗锯齿用连续量（去放射状虚线）；不再整体提亮 ×1.25
const HALO_FS = /* glsl */`
uniform float uR, uLen, uA, uF2, uOmega, uSwell;
uniform vec3 uDisk, uRoot, uBody, uTip;
void main(){
  vec2 d = (vUv - .5) * 2.;                 // 卡片半宽 = 1（对应 0.5 m）
  float r = length(d) * .5, th = atan(d.y, d.x);
  float R0 = uR * uSwell;
  float aa = fwidth(r) * 1.2;
  float disk = 1. - smoothstep(R0 - aa, R0 + aa, r);
  vec3 col = uDisk; float cov = disk;
  float N = 36., sp = 6.28318 / N;
  float aaX = fwidth(r) / (sp * max(R0, 1e-3)) * 1.5 + 1e-4;
  float kc = floor((th - uOmega) / sp + .5);
  for (int j = -1; j <= 1; j++) {
    float k = kc + float(j), kk = mod(k, N);
    float lenK = (mod(kk, 2.) < .5 ? 1. : .7) * (1. + .12 * (bbH2(vec2(kk, uF2)) * 2. - 1.));
    float L = uLen * lenK;
    if (L <= 1e-5) continue;
    float rho = (r - R0 * .98) / L;
    if (rho < 0. || rho > 1.) continue;
    float ang = uOmega + k * sp;
    float dth = atan(sin(th - ang), cos(th - ang));
    float x = dth * r / (sp * R0);
    float hw = .34 * pow(1. - rho, .8);
    float off = .35 * sin(3.14159 * rho * 1.4) * (mod(kk, 2.) < .5 ? 1. : -1.);
    float c = 1. - smoothstep(-aaX, aaX, abs(x - off) - hw);
    vec3 cc = mix(mix(uRoot, uBody, smoothstep(.18, .42, rho)), uTip, smoothstep(.65, .92, rho));
    col = mix(col, cc, c * (1. - disk)); cov = max(cov, c);
  }
  gl_FragColor = vec4(col, cov * uA);
}`;
const PLATE_FS = /* glsl */`
uniform sampler2D map; uniform float uDark, uSat, uAir;
void main(){
  vec3 c = texture2D(map, vUv).rgb; float l = bbLum(c);
  // 天空区：一层杏 → 淡紫的喷绘渐变（ref_07），只盖亮而不绿不红的像素
  vec3 air = mix(vec3(.6795, .5841, .3185), vec3(.6795, .4508, .4233), smoothstep(.55, 1., vUv.y));
  float sky = smoothstep(.56, .70, vUv.y) * smoothstep(.30, .45, l) * (1. - smoothstep(.02, .08, c.g - c.r)) * (1. - smoothstep(.30, .55, c.r - c.b));
  c = mix(c, air, sky * uAir);
  c = mix(vec3(bbLum(c)), c, uSat) * (1. - uDark); gl_FragColor = vec4(c, 1.); }`;
// 冷雾墙
const FOG_FS = /* glsl */`
uniform float uTop, uA; uniform vec3 uC;
void main(){
  float y = vUv.y;
  float e = .03 * (bbFbm(vec2(vUv.x * 6., uT * .2)) - .5) * 2.;
  float a = (1. - smoothstep(uTop - .06 + e, uTop + .02 + e, y)) * uA;
  float n = .85 + .15 * bbFbm(vUv * vec2(8., 3.) + uT * .1);
  gl_FragColor = vec4(uC, a * n);
}`;
// 门户卡片（眼孔后面）：屏幕空间取样门户渲染目标（sRGB → 线性）
const PORTAL_FS = /* glsl */`
uniform sampler2D tPortal;
void main(){ gl_FragColor = vec4(bbS2L(texture2D(tPortal, gl_FragCoord.xy / uRes).rgb), 1.); }`;

export function buildMarket({ tex }) {
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(31.13, W / H, 0.005, 200);
  const add = o => { scene.add(o); return o; };

  // —— 集市底板（A16）：13 m 宽，视平线（图像 y 510）对眼高 1.55 ——
  const plateMat = cardMat(PLATE_FS, { map: { value: tex.market_plate }, uDark: { value: 0 }, uSat: { value: 0.92 }, uAir: { value: 0.15 } }, { transparent: false });
  const plate = add(card(plateMat, 0));
  const PW = 13, PH = 13 * 941 / 1671;
  const PLATE0 = new THREE.Vector3(0.4, 1.55 + (510 / 941 - 0.5) * PH, -8);
  plate.scale.set(PW, PH, 1);

  // —— 幡 ×3 ——
  const banners = [0, 1, 2].map(i => {
    const g = new THREE.PlaneGeometry(0.35, 1.6, 1, 12); g.translate(0, -0.8, 0);
    const m = cardMat(BANNER_FS, { uC: { value: lin(i === 1 ? '#951E41' : '#B5402A') }, uG: { value: lin('#E2B93B') }, uS: { value: lin('#7E2A1F') } }, { transparent: false, side: THREE.DoubleSide });
    const b = add(card(m, 1, g)); b.userData.outline = false;
    return b;
  });
  const BAN_X = [-1.1, 0.25, 1.55];

  // —— 人头剪影 ×4 ——
  // fix3（v2-04）：四人四种头饰、两种深色、大小差 15–25%、各自轻微倾斜
  const HEAD_K = [
    { type: 0, c: '#4A1F16', c2: '#22120E', s: 1.00, tilt: -3.0 },
    { type: 1, c: '#3A1A14', c2: '#1B0F0C', s: 1.20, tilt: 2.5 },
    { type: 2, c: '#4E2119', c2: '#2A1410', s: 0.92, tilt: -4.0 },
    { type: 3, c: '#41201B', c2: '#1E1210', s: 1.10, tilt: 3.0 },
  ];
  const heads = HEAD_K.map((k, i) => {
    const m = cardMat(HEAD_FS, { uC: { value: lin(k.c) }, uC2: { value: lin(k.c2) }, uG: { value: lin('#E2B93B') }, uFace: { value: i % 2 ? 1 : -1 }, uType: { value: k.type }, uSeed: { value: 3.7 + i * 5.3 } });
    const h = add(card(m, 9)); h.scale.set(0.42 * k.s, 0.42 * 1.25 * k.s, 1);
    h.userData.hk = k;
    return h;
  });

  // —— 假光轮 ——
  const haloMat = cardMat(HALO_FS, { uR: { value: 0.34 }, uLen: { value: 0.11 }, uA: { value: 1 }, uF2: { value: 0 }, uOmega: { value: 0 }, uSwell: { value: 1 },
    uDisk: { value: lin('#B5402A') }, uRoot: { value: lin('#A27A3E') }, uBody: { value: lin('#D9B45E') }, uTip: { value: lin('#EAD49C') } });   // fix2（style-11）：火舌金预先压饱和——集市调色（暖 +0.25、饱和 1.12）后落在 S ≈ 0.75，不再是 #E3B700 的荧光黄
  const halo = add(card(haloMat, 3)); halo.scale.set(1.0, 1.0, 1);

  // —— 3D 金面具（A15）——
  const MW = 0.30, MH = 0.30 * 1129 / 1171;
  const mg = new THREE.PlaneGeometry(MW, MH, 48, 40);
  { const p = mg.attributes.position; for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i); p.setZ(i, -0.06 * (x / 0.15) ** 2 - 0.04 * (y / (MH / 2)) ** 2); } mg.computeVertexNormals(); }
  const HOLES = tex.manifest.A15.锚点.eye_holes;
  const maskMat = makeToonMaterial({
    map: tex.mask_face, color: '#EDDEB8', shade1Tint: [0.78, 0.70, 0.62], shade2Tint: [0.78, 0.70, 0.62], step1: 0.52, feather1: 0.02, step2: 0.0,
    edgeNoise: 0.01, edgeNoiseScale: 20, rimAmt: 0, rimLitAmt: 0.8, rimLitColor: '#FFF1B8', rimLitInside: 0.12, cityAmt: 0, skyAmt: 0, fog: false, side: THREE.FrontSide,
    fragmentPars: GLSL_COMMON + /* glsl */`
      uniform float uSweepPos, uSweepOn, uHoleGold, uK2; uniform vec4 uHole0, uHole1;`,
    fragmentAlbedo: /* glsl */`
      { vec2 px = vec2(vMapUv.x, 1. - vMapUv.y) * vec2(1171., 1129.);
        diffuseColor.rgb = mix(vec3(dot(diffuseColor.rgb, vec3(.2126, .7152, .0722))), diffuseColor.rgb, .85);
        // 扫光：屏幕空间斜 35° 硬边细亮带（fix3，v2-03：原来是约 140 px 宽的柔边乳白雾带，像 CG 高光；
        //   改成宽约 70 px 的硬边平涂亮带 + 旁边一道约 8 px 的细线，α 0.40，和平涂画风一致）
        float b = dot(gl_FragCoord.xy / uK2, vec2(.8192, .5736)) / 1400. - uSweepPos;
        float eB = 1.2 / 1400.;
        float sw = max(1. - smoothstep(.025 - eB, .025 + eB, abs(b)), 1. - smoothstep(.0028 - eB, .0028 + eB, abs(b + .043))) * uSweepOn;
        toonOverlay = vec4(vec3(1., .965, .82), sw * .40);
        // 眼孔金边：到眼孔边界 < 8 像素的地方混金
        float g = 0.;
        for (int i = 0; i < 2; i++) {
          vec4 h = i == 0 ? uHole0 : uHole1;
          float e = length((px - h.xy) / h.zw);
          float dpx = (e - 1.) * min(h.z, h.w);
          float spp = 1. / max(length(fwidth(px)), 1e-4);
          g = max(g, 1. - smoothstep(0., 8. * uK2 / max(spp, 1e-3) + 2., dpx));
        }
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.9216, .6795, .1946), g * uHoleGold);
      }`,
    uniforms: { uSweepPos: { value: -1 }, uSweepOn: { value: 0 }, uHoleGold: { value: 0 }, uK2: { value: K },
      uHole0: { value: new THREE.Vector4(HOLES[0].center_px[0], HOLES[0].center_px[1], HOLES[0].rx_px * 1.04, HOLES[0].ry_px * 1.04) },
      uHole1: { value: new THREE.Vector4(HOLES[1].center_px[0], HOLES[1].center_px[1], HOLES[1].rx_px * 1.04, HOLES[1].ry_px * 1.04) } },
  });
  maskMat.alphaTest = 0.5;
  const mask = new THREE.Group(); add(mask);
  const maskFront = new THREE.Mesh(mg, maskMat);
  bindToon(maskFront, maskMat, { castShadow: false, receiveShadow: false, outline: true });
  maskFront.userData.outlineWidth = 1.1; maskFront.userData.outlineAlpha = 1;
  mask.add(maskFront);
  const lining = new THREE.Mesh(mg, new THREE.MeshBasicMaterial({ color: '#7A2A1E', side: THREE.BackSide, map: tex.mask_face, alphaTest: 0.5, toneMapped: false }));
  lining.position.z = -0.002; lining.userData.outline = false; mask.add(lining);
  // 门户卡片：眼孔后 0.03 m
  const portalMat = cardMat(PORTAL_FS, { tPortal: { value: null } }, { transparent: false, depthWrite: true });
  const portal = card(portalMat, 2);
  portal.scale.set(0.10, 0.06, 1);
  const holeLocal = new THREE.Vector3((HOLES[0].center_px[0] / 1171 - 0.5) * MW, (0.5 - HOLES[0].center_px[1] / 1129) * MH, 0);
  holeLocal.z = -0.06 * (holeLocal.x / 0.15) ** 2 - 0.04 * (holeLocal.y / (MH / 2)) ** 2;
  portal.position.copy(holeLocal).add(new THREE.Vector3(0, 0, -0.03));
  mask.add(portal); portal.visible = false;

  // —— 摊主握杆的手（A14）——
  const A14 = tex.manifest.A14.锚点;
  const vendor = makeSprite(tex.vendor_hand, { order: 4, lineCol: '#3A1A10' });
  vendor.crop.set(0, 0.22, 1, 1);
  add(vendor.group);
  const STICK_TOP = [A14.stick_top_px[0], 0.22 * 1490 + 6];
  const VEN_PPM = 2600;

  // —— 陆蔚的手（S3b）：A11 抬起、A10 一蜷；指尖墨渍与 S1 同一套（湿墨 + 蹭痕，A 点那枚带环）——
  const INK_FS = {
    pars: /* glsl */`uniform vec4 uInk[3]; uniform vec4 uInkB[3]; uniform vec2 uInkS; uniform vec3 uGoldAdd;`,
    body: /* glsl */`
      // fix3（v2-03）：金光只勾手的上缘（指尖一带，图像上部约 30%，往下渐隐），墨渍处整块遮掉、不吃加色——
      //   墨渍保持和 S1 一样深（真的墨），只有皮肤被假的金光勾着
      float inkM = 0.;
      for (int i = 0; i < 3; i++) {
        if (uInk[i].z <= 0.) continue;
        vec2 p = (vPx - uInk[i].xy) / uInk[i].z;
        if (dot(p, p) > 7.5) continue;
        vec4 ik = bbInkSmudge(p, float(i) + 1., uInk[i].w, uInkB[i].x, uInkB[i].y, 0.);
        col = mix(col, ik.rgb, ik.a);
        inkM = max(inkM, smoothstep(.02, .25, ik.a) * (1. - smoothstep(1.6, 2.4, length(p))));
      }
      float gy = 1. - smoothstep(.04, .36, vPx.y / uImg.y);
      col += uGoldAdd * gy * (1. - inkM);`,
  };
  const mkHand = (t, an) => {
    const sp = makeSprite(t, { order: 8, frag: INK_FS, lineCol: '#2E2420', uniforms: { uInk: { value: [0, 1, 2].map(() => new THREE.Vector4()) }, uInkB: { value: [0, 1, 2].map(() => new THREE.Vector4()) }, uInkS: { value: new THREE.Vector2(1, 0) }, uGoldAdd: { value: new THREE.Vector3() } } });
    const ks = inkAnchors(an);
    ks.forEach((k, i) => { if (k) { sp.U.uInk.value[i].set(k.px[0], k.px[1], k.r, k.smearA); sp.U.uInkB.value[i].set(k.ringA, k.ringK, 0, 0); } });
    sp.inks = ks;
    add(sp.group); return sp;
  };
  const A10 = tex.manifest.A10.锚点, A11 = tex.manifest.A11.锚点;
  const hOpen = mkHand(tex.hand_open, A11), hPinch = mkHand(tex.hand_pinch, A10);
  // S3c 脚下的低雾：在背影前面，f324 前漫过小腿
  const fogLowMat = cardMat(FOG_FS, { uTop: { value: 0 }, uA: { value: 0.9 }, uC: { value: lin('#E3EFEB') } });
  const fogLow = add(card(fogLowMat, 6.5));

  // —— 陆蔚背影（S3c，A08）——
  const A08 = tex.manifest.A08.锚点;
  const walker = makeSprite(tex.lw_walk_back, { order: 6, lineCol: '#2E2420', frag: THICK_FS, uniforms: { uThick: { value: 1.0 } } });
  add(walker.group);
  // —— 冷雾墙 ——
  const fogMat = cardMat(FOG_FS, { uTop: { value: 0 }, uA: { value: 0.85 }, uC: { value: lin('#E3EFEB') } });
  const fog = add(card(fogMat, 5));
  const ridgeMat = cardMat(/* glsl */`
    uniform float uA;
    void main(){ float h = .55 + .18 * sin(vUv.x * 7.) + .10 * sin(vUv.x * 17. + 1.); float a = (1. - smoothstep(h - .01, h + .01, vUv.y)) * uA;
      gl_FragColor = vec4(vec3(.6795, .7605, .7454), a); }`, { uA: { value: 0 } });
  const fogRidge = add(card(ridgeMat, 4.9));

  const Q0 = new THREE.Quaternion();
  const _v = new THREE.Vector3();
  function hideAll() {
    for (const h of heads) h.visible = false;
    hOpen.group.visible = hPinch.group.visible = false; walker.group.visible = false;
    fog.visible = false; fogRidge.visible = false; fogLow.visible = false; portal.visible = false;
    vendor.group.visible = true; mask.visible = true; halo.visible = true;
    maskMat.userData.toon.uSweepOn.value = 0; maskMat.userData.toon.uHoleGold.value = 0;
    haloMat.uniforms.uA.value = 1; haloMat.uniforms.uSwell.value = 1; haloMat.uniforms.uLen.value = 0.085; haloMat.uniforms.uR.value = 0.24;
    plateMat.uniforms.uDark.value = 0; plateMat.uniforms.uSat.value = 0.92;
    plate.position.copy(PLATE0);
    for (let i = 0; i < 3; i++) banners[i].visible = true;
  }
  // 面具 + 杆 + 握杆的手：面具中心 P，朝向 q
  function placeMask(P, q) {
    mask.position.copy(P); mask.quaternion.copy(q); mask.updateMatrixWorld(true);
    // 杆顶接面具下巴：下巴 = 面具局部 (0, -MH/2 + 0.01)
    const chin = new THREE.Vector3(0, -MH / 2 + 0.012, -0.03).applyMatrix4(mask.matrixWorld);
    placeSprite(vendor, chin, q, STICK_TOP, VEN_PPM);
    halo.position.copy(new THREE.Vector3(0, 0.0, -0.25).applyMatrix4(mask.matrixWorld)); halo.quaternion.copy(q);
  }
  function banner(t, cx, camX) {
    for (let i = 0; i < 3; i++) {
      const b = banners[i];
      b.position.set(BAN_X[i] + cx, 3.55, -1.2);
      b.rotation.set(0, 0, Math.sin(1.3 * t + i) * 3 * DEG);
    }
  }
  const api = {
    scene, cam,
    setPortal(tx) { portalMat.uniforms.tPortal.value = tx; },
    update(t) {
      hideAll();
      const f = t * 24, fi = Math.round(f), f2 = fi - (fi & 1), tc = f2 / 24;
      SHARED.uTc.value = tc;
      haloMat.uniforms.uF2.value = f2; haloMat.uniforms.uOmega.value = 0.25 * t;
      const info = { portal: false, fx: null };
      if (fi < 279) {
        // ── S3a 集市横掠，面具被直直递到眼前 ──
        cam.fov = 31.13; cam.updateProjectionMatrix();
        const px = fi < 268 ? lerp(-0.60, 0.60, eio((f - 260) / 8)) : 0.60;
        const pz = fi < 268 ? 2.00 : lerp(2.00, 1.92, eo((f - 268) / 11));
        aimCamera(cam, new THREE.Vector3(px, 1.55, pz), 0, -1.5 * DEG);
        banner(t, 0, px);
        // 人头剪影：横掠中从右向左扫过下缘
        heads.forEach((h, i) => {
          h.visible = true;
          const k = h.userData.hk;
          h.position.set(-0.85 + i * 0.52 - 0.12 * (i % 2), 1.19 + 0.04 * (i % 3) + 0.10 * (k.s - 1), 0.6 - 0.06 * i);
          h.quaternion.copy(Q0).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), k.tilt * DEG));
        });
        // 面具：f268–f273 从右下画外直冲到画心（ease-out 三次），f274 过冲 3%，f276 停稳
        const target = new THREE.Vector3(0.60 + 0.05, 1.50, 1.05), from = new THREE.Vector3(0.60 + 0.85, 1.20, 0.30);
        let P;
        const fm = f2;          // 面具被摊主的手举着：一拍二
        if (fm < 268) P = from.clone().add(new THREE.Vector3(0.6, -0.4, -0.5));
        else if (fm < 273) P = from.clone().lerp(target, eo((fm - 268) / 5));
        else { const o = fm < 274 ? 0.03 * (fm - 273) : fm < 276 ? 0.03 * (1 - (fm - 274) / 2) : 0; P = target.clone().add(new THREE.Vector3(0, 0, o)); }
        placeMask(P, Q0);
        vendor.group.visible = f >= 266;
        // 扫光 f276–f279；f278–f279 假光轮一胀
        if (f >= 276) { maskMat.userData.toon.uSweepOn.value = 1; maskMat.userData.toon.uSweepPos.value = lerp(-0.2, 1.4, (f - 276) / 3); }
        haloMat.uniforms.uSwell.value = 1 + 0.08 * ss(fseg(f, 278, 279));
        plate.position.copy(PLATE0);
      } else if (fi < 308) {
        // ── S3b 沾墨的手抬起又放下 ──
        cam.fov = 22.07; cam.updateProjectionMatrix();
        cam.position.set(0.60, 1.55, 1.95); cam.up.set(0, 1, 0); cam.lookAt(0.63, 1.48, 1.00); cam.updateMatrixWorld(true);
        banner(t, 0, 0.6);
        plateMat.uniforms.uDark.value = 0.15;
        const P = new THREE.Vector3(0.65, 1.50 + 0.012, 1.05);
        placeMask(P, Q0);
        // 手（story-15）：f279 画外 → f290 指尖到最高、停在面具下巴下方（屏幕 ≈ (1010, 640)）→ f290–f296 悬停微颤，
        //   扫光此时正好扫过面具、金光勾着指尖 → f296 换 A10 蜷指保持 4 帧 → f300–f307 落出画下缘
        // （面具在本片里居中、下巴下沿约 y 880；锚点是食指墨渍，指尖在它上方约 150 px——锚点取 (1015, 1030)，指尖正好停在下巴下面，不压到面具脸上）
        // fix2（story-15）：手改从右下进画、和摊主握杆的手分开；最高点停在面具右下颊外缘（最高的指尖约 (1235, 760)，离面具边不到一指），
        //   不再停在杆旁边、离脸一百多像素
        const HD = 0.62;
        const hi = screenToWorld(cam, W, H, 1205 * K, 915 * K, HD), lo = screenToWorld(cam, W, H, 1380 * K, 1520 * K, HD);
        let Ph;
        if (f2 < 290) Ph = lo.clone().lerp(hi, eo((f2 - 279) / 11));
        else if (f2 < 300) Ph = hi.clone().add(new THREE.Vector3((hashi(f2) - 0.5) * 0.0012, (hashi(f2 + 9) - 0.5) * 0.0012, 0));
        else Ph = hi.clone().lerp(lo.clone().add(new THREE.Vector3(0, -0.10, 0)), Math.pow((f2 - 300) / 7, 2));
        const near = 1 - clamp(Ph.distanceTo(hi) / 0.30);
        const useP = f2 >= 296 && f2 < 300;
        const sp = useP ? hPinch : hOpen;
        const q = new THREE.Quaternion(); cam.getWorldQuaternion(q);
        placeSprite(sp, Ph, q, sp.inks[0].px, useP ? 6400 : 6800);
        sp.group.visible = true;
        const sweep = fseg(f, 286, 298);
        maskMat.userData.toon.uSweepOn.value = f >= 286 && f < 298 ? 1 : 0; maskMat.userData.toon.uSweepPos.value = lerp(-0.2, 1.4, sweep);
        const lick = Math.exp(-Math.pow((f - 292) / 2.5, 2));
        sp.U.uGoldAdd.value.copy(lin3('#E2B93B')).multiplyScalar(0.40 * near + 0.20 * lick * near);   // fix3（v2-03）：只勾指尖一带的上缘（墨渍遮掉），强度 ≤ 0.6
      } else if (fi < 331) {
        // ── S3c 转身走回雾里（客观镜头）──
        cam.fov = 22.07; cam.updateProjectionMatrix();
        cam.position.set(-0.90, 1.45, 2.40); cam.up.set(0, 1, 0); cam.lookAt(0.40, 1.35, -2.00); cam.updateMatrixWorld(true);
        // 撤景：集市底板与幡整体向右滑开（eio），冷雾 f308–f328 由膝升到肩
        const sl = eio(fseg(f, 308, 331)) * 240 / FPX50 * 10;
        plate.position.copy(PLATE0).add(new THREE.Vector3(sl * 0.9, 0, 0));
        banner(t, sl * 0.32, 0);
        const P = screenToWorld(cam, W, H, 90 * K, 430 * K, 0.95);
        const q = new THREE.Quaternion(); cam.getWorldQuaternion(q); q.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.30, 0)));
        placeMask(P, q);
        haloMat.uniforms.uA.value = 0.0;
        // 陆蔚：走姿每 6 帧水平镜像一次，躯干上下 4 px（一拍二）
        const u = fseg(f2, 308, 331);
        const Pw = new THREE.Vector3(lerp(0.35, 0.52, u), 0, lerp(-1.60, -2.40, u));
        const cq = new THREE.Quaternion(); cam.getWorldQuaternion(cq);
        const bob = (Math.floor(f2 / 6) % 2 ? 1 : -1) * 0.004 * 4 * 0.25;
        placeSprite(walker, Pw.clone().add(new THREE.Vector3(0, bob, 0)), cq, A08.foot_pivot_px, (A08.bbox_px[3] - A08.bbox_px[1]) / 1.73);   // 人高 1.73 m（fix2 新 A08 按外接框换算）
        walker.U.uGlo.value.set(A08.mirror_axis_x_px, 700, Math.floor(f2 / 6) % 2 ? -1 : 1, 1);
        walker.group.visible = true;
        // 冷雾墙（竖向）从街尾升起
        fog.visible = true; fogRidge.visible = true;
        fog.position.set(0.9, 0.9, -3.4); fog.quaternion.copy(cq); fog.scale.set(9, 3.4, 1);
        fogMat.uniforms.uTop.value = lerp(0.42, 0.72, ss(fseg(f, 308, 328)));
        fogRidge.position.set(1.2, 1.6, -3.45); fogRidge.quaternion.copy(cq); fogRidge.scale.set(9, 1.2, 1);
        fogLow.visible = true; fogLow.position.set(0.6, 0.30, -2.05); fogLow.quaternion.copy(cq); fogLow.scale.set(6, 0.9, 1);
        fogLowMat.uniforms.uTop.value = lerp(0.0, 0.62, ss(fseg(f, 310, 324)));
        ridgeMat.uniforms.uA.value = 0.35 * fseg(f, 312, 328);
      } else {
        // ── S3d 推进眼孔：相机始终对准左眼孔中心，距离对数线性逼近；光轮缩回 ──
        cam.fov = 22.07; cam.updateProjectionMatrix();
        const P = new THREE.Vector3(0.65, 1.512, 1.05);
        placeMask(P, Q0);
        plateMat.uniforms.uDark.value = 0.25;
        banner(t, 0, 0.6);
        const hole = holeLocal.clone().applyMatrix4(mask.matrixWorld);
        const D = loglin([[331, 0.95], [337, 0.60], [340, 0.30], [341, 0.20], [342, 0.08], [343, 0.02]])(f);
        cam.position.copy(hole).add(new THREE.Vector3(0, 0, D)); cam.up.set(0, 1, 0); cam.lookAt(hole); cam.updateMatrixWorld(true);
        haloMat.uniforms.uR.value = 0.24 * (1 - 0.8 * seg(f, 333, 341));
        haloMat.uniforms.uA.value = 1 - seg(f, 337, 343);
        haloMat.uniforms.uLen.value = 0.085 * (1 - seg(f, 333, 340));
        maskMat.userData.toon.uHoleGold.value = seg(f, 335, 343);
        portal.visible = true;
        info.portal = true;
      }
      return info;
    },
  };
  return api;
}
