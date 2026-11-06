// 《豹变》D 雾山 · 崖顶与云上（SKY）：#13 崖顶坐定 + 起跳、#14 穿三层云、#15 侧跟（化开之前的三维段）、#16 豹眼
// 返修 1：
//   · #13 改成 ref_03 的低调逆光：以太阳为心的四段渐变天（淡金 → 焦橙 → 暗赭 → 墨褐）、HDR 太阳 + 大辉光、
//     三道岩层台阶的崖台（唇口金线）、翻滚的云团（受光顶面带金边）、右上松枝；豹压暗成剪影、金边贴在墨线内侧
//   · 起跳在 #13 的机位里完成（f515–f520：蓄满 → 蹲伏 → 蹬出，碎石飞起、后爪甩墨），f521 才切 #14
//   · #14 从豹的侧后下方仰着追：每层云两片（底面暗青团块、顶面受光），豹先扎进去被云遮住、镜头随后穿出；
//     层间至少 6 帧看得清；f546 冲破第三层云后给 12 帧金色云海全景；白场 ≤ 40%；速度线是一条条卧着的云带
//   · #15 侧跟方向改对：豹朝左飞，静止的山峰在画面里向右掠过（近峰每帧 60 px 以上）；
//     山峰的着色法线用低通高度场，山脚按世界高度化进云海；远排改成从底板抠出来的 2.5D 山卡
// 返修 2：
//   · #13 的云海改成和 #14 同一套云团公告板（近大远小、一团团的受光顶和背光面，不再是一排排重复的扇贝）；
//     崖沿金线细到 2–4 px、断续，只留在崖沿和台阶唇口的几段；右上的松改成 2D 针叶簇 + 枝干剪影（叠加层画）
//   · f517 在全曲第二强低频起音上硬切一个侧面低机位（#13 的第二个机位）：蹲伏 → 蹬出 → 拉直，脚踩在崖沿上，
//     逆光压暗 + 金边与 #13 一致，f519–f522 四帧都看得到头肩；#14 从 f523 起
//   · #14 三层云改成云团公告板：从下面看是暗青 / 暖灰赭的云底，豹先扎进去被近处的云团挡住、再从洞里冲出，
//     洞口的云团往外撕开；冲破第三层（f546）后镜头从豹的侧后下方甩到右后上方，脚下是一团团的金色云海（近大远小），
//     远处有几座暗峰冒出云海；天从 #13 的金褐一路亮成金色
import * as THREE from 'three';
import { toon, bind, setToonGlobals } from '../lib/toond.js';
import { makeSprite, standAt, faceCam, rimOffset } from '../lib/sprite.js';
import { cloudLayer, cloudMass, massCol, panoPlate, skyDome, sunDisc, glow, ribbon, fogSheet, onScreen } from '../lib/env.js';
import { rock, peakField, pineTree, ledgeSlab, fbm2 as fbm2s } from './geo.js';
import { GLSL } from '../lib/glsl.js';
import { card, cardCol, cropPx } from '../lib/card.js';
import { DEG, clamp, lerp, seg, ss, ss5, eo, ei, eio, aim, s2w, w2s, hitPlaneY, pxPerM, lin3, hashi } from '../lib/util.js';

const DLEAP = new THREE.Vector3(-.45, .62, -.64).normalize();
// #15 侧跟：45 m/s 向左（−x）、爬升 12°
const Q0 = new THREE.Vector3(-40, 40, -45);
export const glideQ = f => { const s = (f - 559) / 24 * 45; return Q0.clone().add(new THREE.Vector3(-Math.cos(12 * DEG) * s, Math.sin(12 * DEG) * s, 0)); };
// 尾迹大环斑：f526、f538、f550、f565、f580、f596、f612（第 7 枚对应第七天）
export const TRAIL_F = [526, 538, 550, 565, 580, 596, 612];
const LEAP_PXCM = 3.9;      // A02 的像素/厘米
// 三层云：豹分别在 f527、f535.5、f544 扎进去（镜头晚约 2.5 帧穿出），层间有 6 帧以上看得清
const LAYER_F = [527, 535.5, 544];

export function buildSky(ctx) {
  const { W, H, K, tex, M, OV } = ctx;
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(40, W / H, .05, 9000);
  const key = new THREE.DirectionalLight('#ffffff', 1); scene.add(key, key.target);
  const sky = skyDome({ low: '#F6E9C4', high: '#EEF3E8' }); scene.add(sky);
  sky.userData.u.uSunPow.value = 6; sky.userData.u.uSunCol.value.copy(lin3('#F0C46A'));

  // ── #13：崖顶岩台（顶面 y ≈ 0.27，三道台阶往镜头一侧落）、前景暗岩、松 ──
  const mDeep = toon('rock_deep', { rimColor: '#E8C45C', rimAmt: .8, streak: .1 });
  const C13 = [-.2, .5, 3.2];
  const ref13 = new THREE.PerspectiveCamera(40, W / H, .05, 9000); aim(ref13, C13, 8, 6); ref13.updateProjectionMatrix();
  const cA = hitPlaneY(ref13, -160, 925, .27), cB = hitPlaneY(ref13, 2080, 700, .27);
  const tw = new THREE.Vector3().subVectors(cB, cA).setY(0).normalize(); const toward = new THREE.Vector3(-tw.z, 0, tw.x);
  if (toward.dot(new THREE.Vector3(C13[0], 0, C13[2]).sub(cA)) < 0) toward.negate();
  // 逆光：崖顶全在影档（暗赭黑），只靠崖沿和台阶唇口的金线出形（ref_03）
  const mLedge = toon('rock_deep', { color: '#2A1A10', shade1: '#140C07', step1: .72, rimColor: '#E8C45C', rimAmt: 0, streak: .14, moss: .2, side: THREE.DoubleSide, ink: '#120A05' });
  const ledgeGeo = ledgeSlab(cA, cB, toward, { Y: .27, depth: 10, drop: 9 });
  const ridge = bind(new THREE.Mesh(ledgeGeo, mLedge), mLedge, { group: 'ridge' }); scene.add(ridge);
  // 崖沿 + 台阶唇口：断续的细金线（返修 2：2–4 px，只留几段；不再有横贯右侧的 S 形长线）
  const lipMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#F3D27A').multiplyScalar(1.15) });
  const lipMat2 = new THREE.MeshBasicMaterial({ color: new THREE.Color('#E8C45C').multiplyScalar(1.1) });
  const lips = [];
  { const pts = []; const ab = new THREE.Vector3().subVectors(cB, cA), L = ab.length(); ab.normalize();
    for (let i = 0; i <= 200; i++) { const u = i / 200; const e = (fbm2s(u * L * .45 + 3, 1.3, 3) * .55 + fbm2s(u * L * 1.7, 7.7, 2) * .18); const p = cA.clone().addScaledVector(ab, u * L).addScaledVector(toward, e - .01); p.y = ledgeGeo.userData.crestY(u) + .006; pts.push(p); }
    // 崖沿金线断成几段，越远越细（离 #13 镜头近的那头 0.35 cm、远端 0.5 cm ≈ 2–4 px）
    for (const [u0, u1] of [[.0, .13], [.17, .34], [.39, .47], [.52, .7], [.75, .86], [.9, 1]]) {
      const sub = pts.slice(Math.floor(u0 * 200), Math.ceil(u1 * 200) + 1);
      if (sub.length < 3) continue;
      lips.push(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(sub), 120, .00115 * (1.3 + 9.7 * (u0 + u1) * .5), 5, false), lipMat));   // 屏幕上约 3 px
    }
  }
  ledgeGeo.userData.lips.forEach((pts, k) => {
    // 唇口线：每道台阶只留一两小段（左半，近处），不画到画面右侧
    for (const [u0, u1] of [[[.04, .16], [.24, .31]], [[.08, .2]], [[.02, .1], [.3, .38]]][k]) {
      const sub = pts.slice(Math.floor(u0 * 120), Math.ceil(u1 * 120) + 1);
      if (sub.length < 3) continue;
      { const lm = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(sub), 60, .0009 * (1.3 + 9.7 * (u0 + u1) * .5), 5, false), lipMat2); lm.userData.ledgeLip = true; lips.push(lm); }
    }
  });
  lips.forEach(l => { l.userData.outline = false; l.userData.outlineOccluder = false; l.frustumCulled = false; ridge.add(l); });
  const mFg = toon('rock_deep', { color: '#1C120B', shade1: '#0F0906', step1: .9, rimColor: '#E8C45C', rimAmt: .5, rimPower: .5, rimInside: .58, streak: .1, ink: '#0E0805' });
  const fgRock = bind(new THREE.Mesh(rock(99, 4, .28), mFg), mFg); scene.add(fgRock);
  const mPine = toon('pine', { color: '#120E09', shade1: '#0D0A06', step1: .99, rimColor: '#E8C45C', rimAmt: 0, dabAmt: .04, ink: '#0A0704' }), mBark = toon('bark', { color: '#140E09', shade1: '#0D0906', step1: .99, rimColor: '#E8C45C', rimAmt: 0, ink: '#0A0704' });
  const pine = new THREE.Group(); { const t = pineTree({ seed: 13, h: 5, lean: [-.8, 0, -.2], clumps: 9, spread: 2.2 }); pine.add(bind(new THREE.Mesh(t.trunk, mBark), mBark, { group: 'pine13' })); for (const l of t.leaves) pine.add(bind(new THREE.Mesh(l, mPine), mPine, { group: 'pine13' })); }
  scene.add(pine);
  const sunGlow = glow('#FFE6A6', { order: 1.6, a: .6, core: .8 }); scene.add(sunGlow);
  // 太阳的世界方向（#13、#13 侧面、#14 共用一个；#13 里它在画面 (430, 330)）
  const SUN = s2w(ref13, 430, 330, 100).sub(ref13.position).normalize();
  const sunU = { value: new THREE.Vector2(-.7, .7) };          // 云团共用：屏幕上指向太阳的方向
  const setSun2D = c => { const v = SUN.clone().applyQuaternion(c.quaternion.clone().invert()); sunU.value.set(v.x, v.y); if (sunU.value.lengthSq() < 1e-6) sunU.value.set(-.7, .7); sunU.value.normalize(); };
  const bill = (m, c, pos, w, h) => { const k = m.userData.pad || 1; m.position.copy(pos); m.quaternion.copy(c.quaternion); m.scale.set(w * k, h * k, 1); };
  const billC = (m, c, pos, w, flip) => { m.position.copy(pos); m.quaternion.copy(c.quaternion); m.scale.set(w, w / m.userData.aspect, 1); m.userData.u.uFlip.value = flip ? 1 : 0; };
  const mixA = (a, b, k) => a.map((v, i) => lerp(v, b[i], clamp(k)));
  const pc = (o, k, v) => { const c = new THREE.Color(v); o.userData.u[k].value.set(c.r, c.g, c.b); };
  const hexLerp = (a, b, k) => '#' + new THREE.Color(a).lerp(new THREE.Color(b), clamp(k)).getHexString();
  // #13 的云海（返修 3，v2-02 / v1-13）：ref_03 那样的一片金雾云海——五排大云块（每块 4–7 个软团叠成一道云岗），
  //   一排压一排，下缘化进下一排的金雾；逆光：朝太阳的边透光发亮、云心暗一档，只在朝光外轮廓留一线细金边；远排化进金雾
  //   行：[深度 m, 团顶屏幕 y, 宽 px 下限, 上限, 个数]（按 #13 参考机位换算到世界）
  // 返修 4（style-05 / v2-02 / main3-02）：#13 的云海整段换成手绘卡片——远处是 A16 金色云海底板（屏幕锁定的远景，地平线随机位俯仰），
  //   近处三排是 A17 云岸卡（染成逆光的金褐，越近越暗），全是画出来的云，不再用着色器生成云形
  const MASS = M.env.A17.masses.map(q => cropPx(tex.clouds, q.bbox_px[0], q.bbox_px[1], q.bbox_px[2], q.bbox_px[3]));
  const RIB = M.env.A18.items.filter(q => q.kind === 'ribbon').map(q => cropPx(tex.ribbons, q.bbox_px[0], q.bbox_px[1], q.bbox_px[2], q.bbox_px[3]));
  const VEIL = M.env.A18.items.filter(q => q.kind === 'veil').map(q => cropPx(tex.ribbons, q.bbox_px[0], q.bbox_px[1], q.bbox_px[2], q.bbox_px[3]));
  const G16 = M.env.A16, G16Y0 = 118;     // A16 裁掉上面的天（天由天穹画），地平线在原图 y = horizon_y_px
  const goldSeaC = card(tex.goldSea, { order: 1.1, crop: cropPx(tex.goldSea, 0, G16Y0, 1961, 802) }); scene.add(goldSeaC);
  const g16H = (G16.horizon_y_px - G16Y0) / (802 - G16Y0);      // 地平线在卡片里的相对位置（从上往下）
  // 把 A16 摆到屏幕：地平线落在 hzY、中心 x = cx、宽 wpx
  const placeSea = (c, cx, hzY, wpx) => { const hpx = wpx / goldSeaC.userData.aspect; onScreen(goldSeaC, c, cx, hzY - g16H * hpx + hpx / 2, wpx, 2900, hpx); };
  const sea13 = [];
  [[420, 612, 1250, 1650, 3], [200, 700, 1450, 1950, 3], [110, 800, 1800, 2400, 2]].forEach(([D, y, w0, w1, n], r) => {
    for (let j = 0; j < n; j++) {
      const h = k => hashi(r * 131 + j * 17 + k + 7);
      const x = -300 + (2520 / n) * (j + .5 + (h(1) - .5) * .55);
      const wpx = lerp(w0, w1, h(2));
      const m = card(tex.clouds, { order: 1.3 + r * .05, crop: MASS[(r * 3 + j) % 4] }); scene.add(m);
      const hpx = wpx / m.userData.aspect;
      const pos = s2w(ref13, x, y + .3 * hpx + (h(4) - .5) * 30, D * (.92 + .16 * h(5)));
      m.userData.place = { pos, w: wpx / pxPerM(ref13, D), row: r, D, flip: h(8) > .5 };
      sea13.push(m);
    }
  });

  // ── 云海（#15 用）、#14 三层云（云团公告板）──
  const sea = [0, 1, 2].map(i => { const c = cloudLayer({ size: 8000, lit: '#F6EBCB', shade: '#B9CBC4', under: '#BFD0C8', thr: [.36, .46, .55][i], scale: [200, 120, 70][i], seed: 40 + i, order: 1.5 + i * .1, feather: .12 }); scene.add(c); return c; });
  const leapPoint = f => { const tau = (f - 517) / 24; return st.P0.clone().addScaledVector(DLEAP, 27 * tau).add(new THREE.Vector3(0, -tau * tau, 0)); };
  const st = { P: new THREE.Vector3(), P0: new THREE.Vector3(0, .9, 0) };
  // #14 三层云（返修 3，v2-02 / v1-02 / style-05）：每层 = 5 块"洞口"云块（围在豹的入云点、挡在镜头和豹之间，豹扎进去时被遮住，
  //   随后往外撕开）+ 10 块四周的云块（越远越大）+ 3 张大片半透明软纱；全是正对镜头的云块，没有面片直边、没有掠射角拉丝
  const layers = [];
  const m14h = new THREE.Vector3(DLEAP.x, 0, DLEAP.z).normalize(), s14h = new THREE.Vector3(-m14h.z, 0, m14h.x);
  const camSideDir = new THREE.Vector3().addScaledVector(s14h, -3.4).addScaledVector(m14h, -3.0).normalize();   // 入云点 → 镜头（水平）
  LAYER_F.forEach((lf, L) => {
    const ac = Math.atan2(camSideDir.z, camSideDir.x);
    // [种类, 方位角（相对"入云点 → 镜头"）, 半径 m, 宽 m, 宽高比]
    const plan = [['path', -.5, 1.4, 7.5, 2.3], ['path', .55, 2.2, 6.5, 2.2],
      ['bank', Math.PI, 17, 52, 3.6], ['bank', Math.PI / 2, 14, 36, 3.2], ['bank', -Math.PI / 2, 15, 38, 3.4], ['bank', Math.PI * .78, 34, 70, 4.2],
      ['veil', Math.PI - .5, 10, 58, 4.4], ['veil', Math.PI + .6, 12, 64, 4.6]];
    plan.forEach(([kind, da, r0, w0, asp0], j) => {
      const h = k => hashi(L * 977 + j * 31 + k);
      const a = ac + da + (h(1) - .5) * .5, r = r0 * (.85 + .3 * h(2));
      let off = new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
      const w = w0 * (.85 + .3 * h(3)) * (L === 2 && kind === 'bank' ? 1.2 : 1), y = kind === 'path' ? -.4 + .8 * h(4) : (h(4) - .5) * 1.6;
      if (kind !== 'path') {
        // 镜头穿层的地方（入云点往前 2.2 m、再往镜头那边 4.5 m）周围要空出来：穿层时不会糊一大片
        const xc = new THREE.Vector3().addScaledVector(m14h, 2.2).addScaledVector(s14h, -3.4).addScaledVector(m14h, -3.0);
        const dv = off.clone().sub(xc), need = (kind === 'veil' ? 8 : 4.5) + w * (kind === 'veil' ? .22 : .38); if (dv.length() < need) off = xc.clone().add(dv.setLength(need));
      }
      const asp = asp0 * (.9 + .2 * h(6));
      // 返修 4：云块 = A17 手绘云岸卡（洞口、四周），软纱 = A18 的软纱卡
      const m = card(kind === 'veil' ? tex.ribbons : tex.clouds, { order: 7 + L * .1 + j * .01, crop: kind === 'veil' ? VEIL[(L + j) % 2] : MASS[(L * 5 + j * 3 + Math.floor(h(7) * 4)) % 4] });
      m.userData.flip = h(8) > .5; void asp;
      scene.add(m);
      m.userData.lay = { L, lf, off, w: kind === 'veil' ? w * 1.3 : w * 1.1, y, path: kind === 'path', veil: kind === 'veil' };
      layers.push(m);
    });
  });
  // 冲破第三层以后的金色云海：第三层往外铺到 1.5 km（一道道云岗，近大远小，远处化进金色天光）；中间夹几条卧着的细长云带（ref_07）
  // 返修 4：冲破第三层以后的金色全景 = A16 底板打底 + 9 块 A17 云岸卡染金（近大远小；近处背光面压暗当暗部锚点）
  const goldSea = [];
  for (let j = 0; j < 9; j++) {
    const h = k => hashi(5003 + j * 37 + k);
    const r = 170 + 760 * Math.pow(j / 8, 1.3) * (.85 + .3 * h(1)), a = (h(2) - .5) * 1.4 + (j % 2 ? .22 : -.22);
    const m = card(tex.clouds, { order: 2 + (8 - j) * .02, crop: MASS[(j * 3 + 1) % 4] }); scene.add(m);
    m.userData.sea = { r, a, w: (30 + r * .3) * (.8 + .4 * h(3)), y: 14 + (h(5) - .5) * 8, flip: h(6) > .5 };
    goldSea.push(m);
  }
  // 卧着的云带（#14 速度线）：世界里固定的细长横带，镜头往上冲时一条条从画面上方扫下来（ref_07 的云带，两端收尖、成对）
  const strata = [...Array(14)].map((_, i) => { const r = card(tex.ribbons, { order: 7.2, crop: RIB[i % RIB.length] }); scene.add(r); return r; });   // 返修 4：A18 手绘云带卡
  // ── 中景圆顶山峰（从云海里冒出），#14 远处 / #15 近排 5 座 ──
  // 返修 2：山峰身上贴南山底板的笔触（侧面投影：峰顶取底板山脊下沿，山脚取山腰），亮档就是底板原来的青绿皴擦，
  //   影档乘暗青；描线、竖皴、脊上点苔、金边照旧——和后面的底板、山卡是同一种画法
  const panoS = tex.pano.clone(); panoS.colorSpace = THREE.SRGBColorSpace; panoS.needsUpdate = true;
  const mPeak = toon('rock_sun', { map: panoS, color: '#FFFFFF', shade1: '#5E8088', rimColor: '#E8C45C', rimAmt: .35, rimPower: .55, rimInside: .62, rimDirK: .25, streak: .22, streakF: [.9, .04], moss: .55, mossClust: .09, skyAmt: .2, algaeAmt: 0, outline: .8 });
  const peaks = [];
  for (let i = 0; i < 5; i++) { const m = bind(new THREE.Mesh(peakField({ w: 84, d: 72, H: 64, seed: 20 + i, uvSide: { u0: .04 + i * .17, du: .22, v0: .24, v1: .62 } }), mPeak), mPeak); peaks.push(m); scene.add(m); }
  // 返修 3（style-02 / self-04）：近排山峰不再用 3D（底板贴图 + 两阶 + 描线，读成一排玻璃穹顶），改成从南山底板抠出来的单峰山卡（2.5D）——
  //   和后面四层山卡同一种画法（顺坡竖皴、脊上树点、山脚化进雾），侧向 28–135 m、世界里静止，镜头飞过时照样大视差、向右掠过；
  //   #14 冲出云层后，其中三张压暗当云海里冒出的逆光暗峰（全景的暗部锚点）
  //   单峰图：A14 peaks_qinglu.png（三座峰，透明底，山脚化成雾）；五个位置轮流用三座峰，偶数位置水平翻转
  const PK = M.peaks || [[.0078, .0483, .3126, .8494], [.3398, .0483, .3168, .8494], [.6782, .0483, .3172, .8494]];
  const PEAK_CROP = [PK[1], PK[0], PK[2], PK[1], PK[0]];
  const peakCards = PEAK_CROP.map((cr, i) => { const c = panoPlate(tex.peaks, { order: 12 }); c.userData.u.uCrop.value.set(...cr); c.userData.u.uUseA.value = 1; c.userData.asp = (cr[2] * 2172) / (cr[3] * 724); c.userData.flip = i % 2 ? -1 : 1; scene.add(c); return c; });
  // 山脚贴着云面的雾带（每座近峰一张）
  const footFog = peaks.map((_, i) => { const f = fogSheet({ w: 160, h: 36, col: '#F2E6C4', op: .85, seed: 80 + i, top: .62, ns: 14, order: 2.6, tear: .22, bot: .05, dens: .1 }); scene.add(f); return f; });
  // 远排：从南山底板里抠出来的 2.5D 山卡（450 m、800 m），越远越淡
  // 返修 2：#15 的中景改成四层山卡（160 / 320 / 600 / 1100 m，从南山底板里抠的四段），层间是雾带——下半幅是一层层的青绿山，不再是一大片平的云海
  const CARD_D = [160, 320, 600, 1100];
  // 返修 4（v3-04 / v3-05）：近、中两排换成 A19 深青绿山带（自带干净 alpha，不再按色差抠天，没有亮边）；远两排用 D01（底板的干净 alpha 版）
  const cards = CARD_D.map((D, i) => { const near = i < 2, c = panoPlate(near ? tex.ridges : tex.panoA, { order: 1.4 - i * .05 });
    if (near) c.userData.u.uCrop.value.set(i === 0 ? 0 : .4, 0, .6, 1); else c.userData.u.uCrop.value.set([.0, .55, .1, .5][i], .3, [.45, .45, .45, .5][i], .68);
    c.userData.u.uUseA.value = 1; c.userData.u.uEdge.value = .1; c.userData.skyV = near ? 1 - 100 / 643 : 1 - 158 / 724; scene.add(c); return c; });
  const cardFog = CARD_D.map((D, i) => { const f = fogSheet({ w: D * 2.6, h: D * .1, col: '#EEF2EA', op: .4, seed: 90 + i, top: .62, ns: D * .05, order: 1.42 - i * .05, tear: .22, bot: .45, dens: .02 }); scene.add(f); return f; });
  const pano = panoPlate(tex.pano, { order: 1 }); scene.add(pano);
  const sun = sunDisc({ order: .6 }); scene.add(sun);
  const goldFog = glow('#F0C46A', { order: 2, a: .8, core: .4, squash: .7 }); scene.add(goldFog);
  const goldFog2 = glow('#F6E0A0', { order: 8, a: .5, core: .2, squash: 1.4 }); scene.add(goldFog2);
  // 返修 4（v3-11）：侧面起跳机位的近处崖沿换成 A23 手绘暗岩剪影卡（写深度；3D 岩台在这个机位里不画，没有直边、没有溅痕和泡沫树丛）
  const ledgeC = card(tex.ledge, { order: 10.5, depth: true }); ledgeC.userData.u.uFlip.value = 1; scene.add(ledgeC);
  const A23 = M.env.A23.top_edge_px_every16;
  const speed = [...Array(20)].map((_, i) => { const r = card(tex.ribbons, { order: 7.5, crop: RIB[(i * 3) % RIB.length] }); scene.add(r); return r; });   // 返修 4（v3-08）：速度线 = A18 手绘云带卡（两端收尖、成对）

  // ── 豹：坐（A01 姿态 B）、跃（A02）、头（A03）——金、满身环斑 ──
  const leoSit = makeSprite(tex.leoSit, tex.leoSitIn, { mode: 1, order: 12, poses: M.leoSitPoses }); leoSit.setPose('B');
  const leoLeap = makeSprite(tex.leoLeap, tex.leoLeapIn, { mode: 1, order: 12, poses: M.leoLeapPoses });
  const leoHead = makeSprite(tex.leoHead, tex.leoHeadIn, { mode: 1, order: 12, poses: { H: M.leoHead } }); leoHead.setPose('H');
  scene.add(leoSit.group, leoLeap.group, leoHead.group);
  [leoSit, leoLeap, leoHead].forEach(S => { S.u.uGold.value = 1; S.u.uSpot.value = 1; S.u.uDry.value = 1; S.u.uFlow.value = 1; });
  // 返修 4：豹头没有躯干胶囊，全是实心小点（按 PLAN 3.1）
  // 豹眼：代码虹膜（琥珀径向纤维、外缘一圈深色角膜缘环）、瞳孔收缩、眯眼
  const IRIS_FS = /* glsl */`
  ${GLSL}
  uniform float uPupil, uOpen, uA; varying vec2 vUv;
  void main(){
    vec2 p = (vUv - .5) * 2.; float r = length(p), a = atan(p.y, p.x);
    if (r > 1.) discard;
    float fib = vnoise2(vec2(cos(a), sin(a)) * 9. + r * 3.) * .5 + vnoise2(vec2(cos(a), sin(a)) * 23.) * .5;
    vec3 c = mix(vec3(.62, .30, .03), vec3(.95, .70, .23), smoothstep(.2, 1., r * .7 + fib * .5));
    c = mix(c, vec3(.08, .05, .02), smoothstep(.84, .95, r));
    float pu = 1. - smoothstep(uPupil * .34 - .02, uPupil * .34 + .02, length(p * vec2(1.7, 1.)));
    c = mix(c, vec3(.02, .02, .02), pu);
    float lid = smoothstep(uOpen - .04, uOpen + .04, -p.y + .9);
    gl_FragColor = vec4(srgb2lin(c), (1. - smoothstep(.95, 1., r)) * lid * uA);
  }`;
  const iris = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({ uniforms: { uPupil: { value: 1 }, uOpen: { value: 2 }, uA: { value: 1 } }, vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }', fragmentShader: IRIS_FS, transparent: true, depthWrite: false }));
  iris.renderOrder = 13; iris.frustumCulled = false; iris.userData.outline = false; scene.add(iris);

  const vis = (o, v) => { o.visible = v; };
  const leapH = pz => pz.rect[3] / LEAP_PXCM / 100 * 1.15;    // 姿态包围盒的世界高（米）
  // #13 豹坐的位置（脚在崖沿内侧），起跳点 = 脚上方 0.45 m
  const foot13 = hitPlaneY(ref13, 1040, 818, .27);
  st.P0.copy(foot13).add(new THREE.Vector3(0, .45, 0));
  const LH = LAYER_F.map(f => leapPoint(f).y);
  const goldRim = (S, rx, ry, hpx, amt = 1, col = '#FFE08A') => { S.u.uRimAmt.value = amt; S.u.uRimCol.value.copy(lin3(col)); rimOffset(S, rx, ry, 5.5 * K, hpx); };

  // #14 机位：豹的侧后下方仰着追（镜头晚约 2.5 帧穿过每层云）；f546 冲破第三层以后甩到豹的右后上方，低头看金色云海
  const m14 = new THREE.Vector3(DLEAP.x, 0, DLEAP.z).normalize();
  const side14 = new THREE.Vector3(-m14.z, 0, m14.x);
  const UP = new THREE.Vector3(0, 1, 0);
  function cam14(fr) {
    const P = leapPoint(fr);
    const u = ss(seg(fr, 545.5, 552));
    const lowK = 1 - ss(seg(fr, 523, 527));          // 开头几帧贴着崖顶：崖沿压在画面下角当暗部锚点
    const o0 = new THREE.Vector3().addScaledVector(side14, -3.4).addScaledVector(m14, -3.0).addScaledVector(UP, -1.75 - .8 * lowK);
    const o1 = new THREE.Vector3().addScaledVector(side14, 3.4).addScaledVector(m14, -7.8).addScaledVector(UP, 1.3);
    const cp = P.clone().add(o0.lerp(o1, u));
    return { P, cp, u };
  }
  // 把世界点 P 摆到屏幕设计像素 (sx, sy)：绕相机自身的 Y、X 轴各转一点（两次迭代）
  function frameAt(c, P, sx, sy) {
    const Wd = 1040 * c.aspect, ty = Math.tan(c.fov * DEG / 2), tx = ty * c.aspect;
    for (let it = 0; it < 2; it++) {
      c.updateMatrixWorld(true); const p = w2s(c, P);
      const ax = Math.atan((p.x - 960) / (Wd / 2) * tx) - Math.atan((sx - 960) / (Wd / 2) * tx);
      const ay = Math.atan((520 - p.y) / 520 * ty) - Math.atan((520 - sy) / 520 * ty);
      c.rotateY(-ax); c.rotateX(ay);
    }
    c.updateMatrixWorld(true);
  }
  // #13 第二个机位（f517–f522）：侧面低机位，镜头方向从豹的右侧朝前转 25°（太阳在画左外面，画左天最亮）
  const V13B = new THREE.Vector3().addScaledVector(side14, Math.cos(25 * DEG)).addScaledVector(m14, Math.sin(25 * DEG)).normalize();
  const leapS13 = f => [0, 0, .14, .38, .72, 1.15][clamp(Math.floor(f) - 517, 0, 5)];     // 沿起跳方向离开崖沿的距离（米，先慢后快）
  // 天：以太阳为心的四段渐变；k = 0 是 #13 的低调金褐，k = 1 是冲出云层后的金色天光（远离太阳处是淡青）
  function skyRad(k) {
    const u = sky.userData.u; u.uRad.value = 1; u.uSunDir.value.copy(SUN); u.uSunAmt.value = 0;
    const L = (a, b) => lin3('#' + new THREE.Color(a).lerp(new THREE.Color(b), k).getHexString());
    u.uR0.value.copy(L('#F6E0A0', '#FFF2CC')); u.uR1.value.copy(L('#E99F21', '#F3C46C')); u.uR2.value.copy(L('#69310C', '#E6BE82')); u.uR3.value.copy(L('#2E1203', '#D6C7A0'));
    u.uRA.value.set(lerp(.10, .14, k), lerp(.42, .62, k), lerp(1.05, 1.7, k));
  }
  // 太阳放在世界方向上（镜头转到哪，太阳在哪）
  function sunAt(c, wpx, hdr, a) {
    const p = c.position.clone().addScaledVector(SUN, 3500); const s = w2s(c, p);
    if (s.z <= 0) { sun.visible = false; sunGlow.visible = false; return s; }
    onScreen(sun, c, s.x, s.y, wpx, 3500, wpx); sun.userData.u.uHDR.value = hdr; sun.userData.u.uA.value = a;
    onScreen(sunGlow, c, s.x, s.y + 10, wpx * 3.6, 3400, wpx * 3.3);
    return s;
  }

  function update(t, f, shot) {
    const fr = t * 24, f2 = f - (f % 2);
    const leapIn13 = shot === 13 && f >= 517;           // f517 硬切侧面机位：f517–f518 蹲伏、f519–f520 蹬出、f521–f522 拉直（一拍二）
    vis(leoSit.group, shot === 13 && !leapIn13); vis(leoLeap.group, leapIn13 || shot === 14 || shot === 15); vis(leoHead.group, shot === 16); vis(iris, false);   // 返修 3（style-12）：A03 重出后眼睛本身就是琥珀虹膜 + 竖缝瞳孔，不再叠代码的圆虹膜
    vis(ridge, (shot === 13 && !leapIn13) || (shot === 14 && fr < 528)); vis(ledgeC, leapIn13); vis(goldSeaC, shot === 13 || (shot === 14 && fr >= 541)); vis(fgRock, shot === 13 && !leapIn13); vis(pine, false);
    // 返修 3（v2-03②）：侧面起跳机位和 #14 里不画台阶唇口的金线（换个角度看就成了崖顶上爬的几条"霓虹管"），只留崖沿外轮廓那几段断续的
    lips.forEach(l => { l.visible = !l.userData.ledgeLip || (shot === 13 && !leapIn13); });
    sea13.forEach(m => m.visible = shot === 13); vis(sunGlow, shot === 13 || shot === 14);
    layers.forEach(l => l.visible = shot === 14); goldSea.forEach(m => m.visible = shot === 14 && fr >= 541);
    peaks.forEach(p => p.visible = false); footFog.forEach(g => g.visible = shot === 15);
    peakCards.forEach((c, i) => c.visible = shot === 15 || (shot === 14 && fr >= 544 && i < 3));
    cards.forEach(c => c.visible = shot === 15); cardFog.forEach(c => c.visible = shot === 15); strata.forEach(r => r.visible = false);
    speed.forEach(s => s.visible = false); vis(sun, shot <= 14); vis(goldFog, shot <= 15); vis(goldFog2, shot === 16);
    pano.visible = shot !== 16; sea.forEach(c => c.visible = false);
    pano.userData.u.uBias.value = 0; pano.userData.u.uHiC.value.set(1, 1, 1); pano.userData.u.uMap.value = tex.pano; pano.userData.u.uUseA.value = 0; sky.userData.u.uRange.value.set(0, .55); sky.userData.u.uRad.value = 0;
    sea.forEach(c => { c.userData.u.uOp.value = 1; c.userData.u.uFadeR.value = 0; });
    mPeak.userData.toon.uSeaFade.value.set(0, 0, 0, 0);
    const pu = pano.userData.u;
    sun.userData.u.uHDR.value = 1;
    if (shot === 13) {
      // ref_03 的调度：低机位仰拍，崖台对角线，金豹逆光坐着；低调——暗赭的天、焦橙的中间调、太阳一团白热
      const u = ss5(seg(fr, 494, 516));
      if (!leapIn13) { aim(cam, [C13[0] + .05 * u, C13[1], C13[2] - .3 * u], 8, 6); cam.fov = 40; }
      else {
        // 侧面机位：离豹 3.1 m、和豹差不多高，略仰；豹在画面中偏右，起跳朝画左上（太阳那边）
        const T = foot13.clone().add(new THREE.Vector3(0, .3, 0));
        const cp = T.clone().addScaledVector(V13B, -3.1).add(new THREE.Vector3(0, -.02, 0));
        cam.fov = 40; cam.position.copy(cp); cam.up.set(0, 1, 0); cam.lookAt(T.clone().addScaledVector(V13B, 3)); cam.updateProjectionMatrix();
        frameAt(cam, T, 1120, 640);
      }
      cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
      const ref = ref13;
      ridge.position.set(0, 0, 0); ridge.rotation.set(0, 0, 0); ridge.scale.set(1, 1, 1);
      const D = ref.position.distanceTo(foot13);
      if (!leapIn13) {
        // 豹：姿态 B，背对镜头、望向左上的太阳；f496 尾巴一甩，f503 耳朵前竖，f509–f516 蓄力
        const pz = M.leoSitPoses.B; leoSit.clearBones();
        const tail = f2 >= 496 && f2 <= 502 ? [0, 9, 14, 6][Math.min(3, (f2 - 496) / 2)] : 0;
        const crouch = ss(seg(f2, 509, 516));
        leoSit.bone(0, pz.tail_root, pz.tail_tip, 80, 360, tail + 8 * crouch, 0);
        leoSit.squash([pz.rect[0] + pz.rect[2] / 2, pz.rect[1] + pz.rect[3]], 1, 1 - .07 * crouch);
        leoSit.bone(1, pz.neck_root, pz.head_center, 90, 240, -6 * crouch + (f2 >= 503 ? -2 : 0), 0);
        leoSit.bone(2, pz.ear_r, [pz.ear_r[0], pz.ear_r[1] - 20], 25, 50, f2 >= 503 && f2 < 509 ? -8 : 10 * crouch, 0);
        leoSit.boneT(0, pz.head_center, 120, 420, -14 * crouch / .45, 6 * crouch);
        standAt(leoSit, cam, foot13, 400 / pxPerM(ref, D), { flip: false });
        leoSit.u.uTint.value.set(.25, .2, .19); goldRim(leoSit, -.75, .66, 400 * K);
        leoSit.u.uFlowT.value = (t % 1.5) - .2; leoSit.u.uCell.value = pz.cell;
      } else {
        // f517–f518 蹲伏（姿态 1，四爪踩在崖顶上）→ f519–f520 蹬出（姿态 2）→ f521–f522 拉直（姿态 3）；位移先慢后快
        const pose = f <= 518 ? '1' : f <= 520 ? '2' : '3';      // 一拍二按切点对齐：f517–f518 / f519–f520 / f521–f522
        leoLeap.setPose(pose); leoLeap.clearBones();
        const pz = M.leoLeapPoses[pose];
        const Hw = leapH(pz) * (pose === '2' ? .8 : .66);
        const s = lerp(leapS13(fr), leapS13(fr + 1), fr - Math.floor(fr));
        if (pose === '1') {
          standAt(leoLeap, cam, foot13.clone().addScaledVector(V13B, .05), Hw, { flip: true });
          leoLeap.squash([pz.rect[0] + pz.rect[2] / 2, pz.rect[1] + pz.rect[3]], 1.03, .94);
        } else {
          const P = foot13.clone().add(new THREE.Vector3(0, Hw * .5, 0)).addScaledVector(DLEAP, s);
          const sp = w2s(cam, P);
          faceCam(leoLeap, cam, sp.x, sp.y, Hw * pxPerM(cam, sp.z), sp.z, { flip: true, rot: pose === '2' ? -8 : -30 });
        }
        const hpx = Hw * pxPerM(cam, Math.max(.5, cam.position.distanceTo(foot13)));
        leoLeap.u.uTint.value.set(.32, .26, .23); goldRim(leoLeap, -.85, .52, hpx * K, 1, '#FFE08A');
        leoLeap.u.uFlowT.value = (t % 1.5) - .2; leoLeap.u.uCell.value = pz.cell;
        st.leapS = w2s(cam, foot13); st.leapH = hpx;
      }
      fgRock.position.copy(s2w(ref, 1500, 1110, 1.6)); fgRock.scale.set(.42, .2, .3); fgRock.rotation.set(.3, .8, .1);
      // 太阳：白热的芯（HDR ×2.2）+ 大辉光；侧面机位里太阳在画左外，只剩辉光从左边漫进来
      const su = sun.userData.u; su.uR.value = .3; su.uDisc.value.copy(lin3('#FFF3D6')); su.uCore.value.copy(lin3('#FFF8E0')); su.uHalo.value.copy(lin3('#FFD98A')); su.uHaloA.value = .55; su.uStretch.value = 1;
      st.sunS = sunAt(cam, 300, 2.2, 1); sunGlow.userData.u.uA.value = .7;
      onScreen(goldFog, cam, leapIn13 ? 260 : 560, 430, 2600, 3000, 1100); goldFog.userData.u.uA.value = leapIn13 ? .4 : .32;
      { const s = w2s(cam, cam.position.clone().addScaledVector(SUN, 2800)); const Wp = 2700;
        onScreen(pano, cam, leapIn13 ? 700 : 1000, (leapIn13 ? 620 : 600) - (158 / 724 - .5) * Wp / 3, Wp, 2800); void s; }
      pu.uMul.value.set(.9, .55, .28); pu.uSat.value = .6; pu.uHaze.value.copy(lin3('#E99F21')); pu.uHazeAmt.value = .45; pu.uHazeLow.value = .3;
      skyRad(0);
      if (leapIn13) { const u2 = sky.userData.u; u2.uR2.value.copy(lin3('#93501A')); u2.uR3.value.copy(lin3('#4A2008')); u2.uRA.value.set(.12, .55, 1.45); }
      // 云海：一团团的积云（受光顶面金、背光面焦橙，朝光鼓包顶缘一线亮），远处化进金雾
      setSun2D(cam);
      // 返修 4：云海 = A16 底板（地平线 y ≈ 520 / 侧面机位 560）+ 三排 A17 云岸卡，逆光：越近越暗（暗赭褐），受光顶面留金
      pano.visible = false;
      placeSea(cam, leapIn13 ? 900 : 1000, leapIn13 ? 560 : 520, leapIn13 ? 3300 : 3000);
      cardCol(goldSeaC, { mul: [.92, .74, .5], lo: [.62, .46, .34], hi: [1.05, .98, .9], sat: 1.05, op: 1, haze: '#F2C878', hazeAmt: .08, hazeLow: 0, fade: [0, 0, 0, .1] });
      sea13.forEach(m => {
        const P = m.userData.place; billC(m, cam, P.pos, P.w, P.flip);
        cardCol(m, { lo: [[.92, .6, .34], [.66, .42, .24], [.44, .27, .15]][P.row], hi: [[1.3, 1.0, .58], [1.18, .86, .48], [1.02, .72, .4]][P.row], sat: .9, op: 1,
          haze: '#F2C878', hazeAmt: [.22, .08, .02][P.row], hazeLow: .3, hazeH: .45 });
      });
      if (leapIn13) {
        // A23 暗岩剪影：翻转后崖口在左，豹脚落在上沿 x = 1500（原图）那一点
        const fs = w2s(cam, foot13), Wc = 2300, Hc = Wc * 697 / 2172, xa = 1500, ya = A23[Math.round(xa / 16)][1];
        const cx = fs.x + (xa / 2172 - .5) * Wc, cy = fs.y + 6 - ya / 697 * Hc + Hc / 2;
        onScreen(ledgeC, cam, cx, cy, Wc, 3.6, Hc);
        cardCol(ledgeC, { mul: [.62, .5, .44], lo: [.8, .72, .7], hi: [1.15, .95, .7], sat: 1, op: 1 });
      }
    } else if (shot === 14) {
      const { P, cp, u } = cam14(fr);
      const fov = lerp(42, 47, seg(fr, 523, 532)) * (1 - u) + 44 * u;
      cam.fov = fov; cam.updateProjectionMatrix(); cam.position.copy(cp); cam.up.set(0, 1, 0);
      // 豹从画面下 1/3 冲到上 1/3；冲破第三层以后停在画面左上 1/3，朝左上飞
      const tgt = P.clone().addScaledVector(DLEAP, 1.2);
      const look = tgt.clone().lerp(P.clone().addScaledVector(m14, 60).add(new THREE.Vector3(0, -9, 0)), u);
      cam.lookAt(look); cam.updateMatrixWorld(true);
      const sp0 = w2s(cam, P);
      const sy = lerp(lerp(690, 380, ss(seg(fr, 523, 546))), 470, u), sx = lerp(sp0.x, 800, u);
      frameAt(cam, P, sx, sy);
      if (f2 === 523 || f2 === 524) { cam.rotateX(5 / 520 * fov * .5 * DEG); cam.updateMatrixWorld(true); }
      const pose = '3';
      leoLeap.setPose(pose); leoLeap.clearBones();
      const pz = M.leoLeapPoses[pose];
      const sp = w2s(cam, P);
      const vel = w2s(cam, leapPoint(fr + 1));
      let rot = clamp(Math.atan2(-(vel.y - sp.y), -(vel.x - sp.x)) / DEG, -40, 40);   // 身子顺着屏幕上的运动方向
      rot = lerp(rot, 24, u);                                                         // 全景：头朝左上
      const hpx = leapH(pz) * pxPerM(cam, sp.z);
      faceCam(leoLeap, cam, sp.x, sp.y, hpx, sp.z, { flip: true, rot: -rot });
      // 逆光：暗一档 + 金边（冲出云层以后受光，亮回来）
      const lit = ss(seg(fr, 544, 552));
      leoLeap.u.uTint.value.set(lerp(.62, .95, lit), lerp(.55, .9, lit), lerp(.5, .86, lit)); goldRim(leoLeap, -.6, .75, hpx * K, 1, '#FFE08A');
      leoLeap.u.uFlowT.value = (t % 1.5) - .2; leoLeap.u.uCell.value = pz.cell;   // 返修 4（main3-01）：格距按清单，不再写死 17.5
      st.P = P; st.leapS = sp; st.leapH = hpx; st.leapRot = rot;
      const su = sun.userData.u; su.uR.value = .3; su.uDisc.value.copy(lin3('#FFF3D6')); su.uCore.value.copy(lin3('#FFF8E0')); su.uHaloA.value = .5;
      sunAt(cam, 300, 1.9, 1); sunGlow.userData.u.uA.value = .45 + .3 * u;
      onScreen(goldFog, cam, 520, 300, 2400, 3000, 1600); goldFog.userData.u.uA.value = .18 + .12 * u;
      // 远山：全景时才在远处露头（金色调）
      { const hz = w2s(cam, cam.position.clone().add(m14.clone().multiplyScalar(2800))); const Wp = 3200;
        onScreen(pano, cam, 900, hz.y + 30 - (158 / 724 - .5) * Wp / 3, Wp, 2800); }
      // 逆光里的远山：暗青褐剪影（全景的暗部锚点），上沿被金色天光吃掉一点
      pu.uMul.value.set(.3, .27, .24); pu.uSat.value = .55; pu.uHaze.value.copy(lin3('#B88A52')); pu.uHazeAmt.value = .1; pu.uHazeLow.value = 0;
      // 远处几座暗峰冒出云海（全景的暗部锚点，也接 #15 的山）
      const seaY = -30;
      const P546 = leapPoint(546);
      peaks.forEach((p, i) => { const a = i * .9; const c = P546.clone().addScaledVector(m14, 230 + i * 120).addScaledVector(side14, [-120, 90, -260, 210, -10][i]); p.position.set(c.x, seaY - 38 + [14, 6, 20, 10, 16][i], c.z); p.rotation.y = a; });
      mPeak.userData.toon.uSeaFade.value.set(seaY + 4, 8, 3, 1); mPeak.userData.toon.uSeaCol.value.set('#F1DCA6');
      // 云海里冒出的三座逆光暗峰（山卡压暗，山脚埋进金色云岗），全景的暗部锚点
      peakCards.forEach((c, i) => {
        if (i > 2) return;
        const W = [120, 90, 150][i], Hc = W / c.userData.asp, top = seaY + [50, 38, 62][i];   // 返修 4：三座逆光暗峰退远、缩小（不再糊满前景）
        const P = P546.clone().addScaledVector(m14, [560, 760, 980][i]).addScaledVector(side14, [-260, 190, -520][i]);
        P.y = top - Hc * .5;
        c.position.copy(P); c.quaternion.copy(cam.quaternion); c.scale.set(W * c.userData.flip, Hc, 1);
        const cu = c.userData.u; cu.uMul.value.set(.24, .27, .26); cu.uSat.value = .7; cu.uHaze.value.copy(lin3('#E2B060')); cu.uHazeAmt.value = .05 + .05 * i; cu.uHazeLow.value = .75; cu.uHiC.value.set(.6, .6, .56); cu.uOp.value = ss(seg(fr, 544, 547));
      });
      skyRad(ss(seg(fr, 523, 552)));
      setSun2D(cam);
      // 三层云团：豹扎进去的那一层，洞口那几团在镜头和豹之间（挡住豹），豹过去以后往外撕开、变淡
      const gold = ss(seg(fr, 544, 552));
      layers.forEach(m => {
        const Ly = m.userData.lay, C = leapPoint(Ly.lf);
        let off = Ly.off.clone();
        const tear = ss(seg(fr, Ly.lf + .4, Ly.lf + 3.4));
        // 洞口那几块：豹扎进去以后 2 帧内往外撕开（被推到画外），不是半透明地化掉
        if (Ly.path) { const tp = ss(seg(fr, Ly.lf + .5, Ly.lf + 2.5)); off.multiplyScalar(1 + 4.5 * tp); off.y = 0; }
        else if (off.length() < 8) off.multiplyScalar(1 + tear * .5);
        const pos = new THREE.Vector3(C.x + off.x, LH[Ly.L] + Ly.y - (Ly.L === 2 ? 9 * ss(seg(fr, 545, 553)) : 0), C.z + off.z);
        billC(m, cam, pos, Ly.w, m.userData.flip);
        const d = pos.distanceTo(cam.position);
        const below = ss(seg(pos.y - cam.position.y, -1.2, 1.2));        // 1 = 云在镜头上方（看到的是云底）
        const g = Ly.L === 2 ? gold : 0;
        const op = (Ly.veil ? .38 : 1) * (Ly.path ? 1 - ss(seg(fr, Ly.lf + 3, Ly.lf + 7)) : 1)   // 洞口那几块撕开以后淡掉
          * (Ly.L < 2 ? 1 - ss(seg(fr, 544, 548)) : 1 - ss(seg(fr, 547.5, 552)))                       // 冲出第三层以后，三层都沉进云海（全景交给 A16 + 云海卡）
          * (Ly.veil ? 1 - ss(seg(fr, Ly.lf + 2, Ly.lf + 6)) : 1)                                      // 软纱只在穿层那一下用
          * ss(seg(d, 2.4, 4.6));                                                                       // 离镜头不到 3 m 的卡淡出（不糊一大片）
        // 返修 4：从下往上看是画好的暗青云底（再压一档），朝光的顶缘一线暖金；第三层冲破时转金
        cardCol(m, { lo: mixA([.42, .56, .62], [.75, .45, .25], g), hi: mixA([1.08, 1.0, .86], [1.3, 1.02, .58], g), sat: .95, op,
          fade: Ly.veil ? [.22, .22, .3, .3] : [.04, .04, .06, .04], grad: Ly.veil ? 0 : .55 * below, gradC: [.5, .6, .64], haze: hexLerp('#C49A62', '#F2D59A', ss(seg(fr, 523, 550))), hazeAmt: .5 * ss(seg(d, 22, 90)), hazeLow: 0 });
      });
      // 金色云海（全景）：第三层往前铺开的一道道云岗，近大远小；迎着太阳看，云岗大半在背光面（近处压到暗青），朝光的边透光、一线金边
      goldSea.forEach(m => {
        if (!m.visible) return;
        const S = m.userData.sea, C = leapPoint(LAYER_F[2]);
        const dir = m14.clone().applyAxisAngle(UP, S.a);
        const pos = C.clone().addScaledVector(dir, S.r); pos.y = seaY + S.y;
        billC(m, cam, pos, S.w, S.flip);
        const nearK = 1 - ss(seg(S.r, 60, 560));
        cardCol(m, { lo: mixA([1.08, .7, .36], [.34, .19, .1], nearK), hi: mixA([1.5, 1.12, .58], [1.2, .86, .45], nearK), sat: 1.1, op: ss(seg(fr, 541, 545)),
          haze: '#F3D9A0', hazeAmt: .5 * ss(seg(S.r, 220, 800)), hazeLow: .35, hazeH: .4 });
      });
      if (fr >= 541) { const hz = w2s(cam, cam.position.clone().addScaledVector(m14, 2800).add(new THREE.Vector3(0, -70, 0))); placeSea(cam, hz.x, hz.y, 3800);
        cardCol(goldSeaC, { mul: [1, .93, .8], lo: [.7, .62, .55], hi: [1.02, 1, .96], sat: 1.05, op: ss(seg(fr, 541, 546)), haze: '#F3D9A0', hazeAmt: .06, hazeLow: 0, fade: [0, 0, 0, .1] }); }
      // 卧着的云带（速度线）：世界里固定的长云带（粗、成对、两端收尖），镜头往上冲时从上往下扫过
      if (fr < 547) strata.forEach((r, i) => {
        const hh = 2 + 26 * hashi(i * 3 + 1), along = 5 + 16 * hashi(i * 5 + 2), lat = (hashi(i * 7 + 3) - .5) * 2 * (5 + 16 * hashi(i * 11));
        const base = st.P0.clone().addScaledVector(m14, along * (hh / 18)).addScaledVector(side14, lat);
        r.position.set(base.x, hh, base.z);
        r.rotation.set(-Math.PI / 2, 0, Math.atan2(-m14.z, m14.x) + (hashi(i * 13) - .5) * .5);
        { const L = 6 + 10 * hashi(i * 17); r.scale.set(L, L / r.userData.aspect * (1.6 + 1.4 * hashi(i * 19)), 1); }
        r.visible = true; cardCol(r, { op: .32, mul: [1.08, 1.0, .88], sat: .8 });
      });
    } else if (shot === 15) {
      const Q = glideQ(fr), Q559 = glideQ(559);
      // 侧跟：豹侧 9 m、同高、略俯 6°（下半幅是一层层的山）；f586–f603 滑动变焦 31 → 10°、后拉 9 → 28 m，豹在画里大小不变
      const k = ss(seg(fr, 586, 603));
      const fov = lerp(31, 10, k), d = 9 * Math.tan(31 * DEG / 2) / Math.tan(fov * DEG / 2);
      cam.fov = fov; cam.updateProjectionMatrix();
      aim(cam, [Q.x + 1.2, Q.y + .4, Q.z + d], 0, -8);
      const pose = fr >= 596 ? '4' : '3';
      leoLeap.setPose(pose); leoLeap.clearBones();
      const pz = M.leoLeapPoses[pose];
      const ph = f2 / 24 * Math.PI * 2;
      leoLeap.bone(0, pz.neck_root, [(pz.neck_root[0] + pz.tail_root[0]) / 2, (pz.neck_root[1] + pz.tail_root[1]) / 2], 60, 260, 1.6 * Math.sin(ph), 0);
      leoLeap.bone(1, pz.tail_root, pz.tail_tip, 40, 300, 7 * Math.sin(ph - 1.2), 0);
      leoLeap.bone(2, pz.ear_r, pz.ear_r, 0, 30, 3 * Math.sin(ph * 2), 0);
      const s = 600 / pz.rect[2];
      faceCam(leoLeap, cam, 820, 470, pz.rect[3] * s, d * .999, { flip: true });
      leoLeap.u.uTint.value.set(1, 1, 1); goldRim(leoLeap, -.35, .94, pz.rect[3] * s * K, .9, '#F3D27A');
      leoLeap.u.uFlowT.value = (t % 1.5) - .2; leoLeap.u.uCell.value = pz.cell;   // 返修 4（main3-01）：格距按清单，不再写死 17.5
      // 金 → 青绿：开头几帧接 #14 的金色（雾、山卡的空气色偏金），f559–f580 退成青绿山水的冷白雾
      const warm = 1 - ss(seg(fr, 559, 580));
      const mist = new THREE.Color('#DDE6E0').lerp(new THREE.Color('#E9B860'), warm);
      const camY = Q559.y + .4;
      // 近排 5 座山峰：世界里静止（侧向 40–150 m），镜头跟着豹往左飞、往上爬，山峰在画面里向右掠过、慢慢往下沉
      const lat = [28, 45, 66, 95, 135], span = 260;     // 返修 2：最近那座拉到侧向 28 m（画面里每帧约 90 px 向右掠过）
      peaks.forEach((p, i) => {
        const x0 = [-12, -48, -20, -70, 6][i];
        const rel = x0 - (Q.x - Q0.x);
        const r = ((((rel + span / 2) % span) + span) % span) - span / 2;
        p.position.set(Q.x + r, camY - [80, 82, 87, 93, 101][i], Q.z - lat[i]); p.rotation.y = i * 1.3;
        { const c = peakCards[i], W = [96, 104, 120, 140, 170][i], Hc = W / c.userData.asp, top = camY - [14, 13, 15, 18, 22][i];
          c.position.set(Q.x + r, top - Hc * .5, Q.z - lat[i]); c.rotation.set(0, 0, 0); c.scale.set(W * c.userData.flip, Hc, 1);
          // 压平时近峰淡出（长焦下它们的雾脚会铺满画面，成了一片青色剪纸）
          const cu = c.userData.u; cu.uOp.value = 1 - ss(seg(k, 0, .55)); cu.uSat.value = [1.14, 1.12, 1.1, 1.06, 1.02][i]; cu.uMul.value.set(...[[.5, .58, .6], [.54, .62, .64], [.58, .66, .68], [.64, .7, .72], [.7, .76, .78]][i]);   // 返修 4（v3-05）：近峰压暗到 0.5–0.6
          cu.uHaze.value.set(mist.r, mist.g, mist.b); cu.uHazeAmt.value = [.0, .02, .05, .09, .13][i] + .2 * warm; cu.uHazeLow.value = .3; cu.uHiC.value.set(.78, .86, .86); }
        const fg = footFog[i]; fg.position.set(p.position.x, camY - 62, Q.z - lat[i] + 18); fg.rotation.set(0, 0, 0);
        fg.userData.u.uOp.value = .32;   // 返修 4（v3-05）：近峰脚下的雾片减淡（不再把近景整片洗灰）
        fg.userData.u.uDrift.value.set(t * 2, 0); fg.userData.u.uCol.value.set(mist.r, mist.g, mist.b); fg.userData.u.uColTop.value.set(mist.r, mist.g, mist.b);
      });
      mPeak.userData.toon.uSeaFade.value.set(camY - 58, 14, 3, 1); mPeak.userData.toon.uSeaCol.value.copy(mist);
      // 四层山卡：世界里静止；山脊线落在画面 y ≈ 640 / 560 / 480 / 400（近的低、远的高），越远越淡、越青
      const skyY = [600, 515, 435, 360], HZ = 257;          // HZ：俯 8° 时地平线在画面 y ≈ 257
      CARD_D.forEach((D, i) => {
        const c = cards[i], cu = c.userData.u, im = cu.uMap.value.image, asp = (cu.uCrop.value.z * im.width) / (cu.uCrop.value.w * im.height);
        const Wm = Math.max(320, D * 1.45 + 120), Hm = Wm / asp;
        const ridgeH = camY + (HZ - skyY[i]) * Math.tan(15.5 * DEG) / 520 * D;      // 山脊（底板天际线中位）的世界高度
        const ridgeV = (c.userData.skyV - cu.uCrop.value.y) / cu.uCrop.value.w;          // 天际线在山卡里的相对高度
        c.position.set(Q559.x - 41 - D * .05, ridgeH - (ridgeV - .5) * Hm, Q.z - D); c.rotation.set(0, 0, 0); c.scale.set(Wm, Hm, 1);
        cu.uSat.value = [1.08, 1.12, 1.1, 1.0][i] * (1 + .3 * k); cu.uHaze.value.set(mist.r, mist.g, mist.b);
        // 返修 3（v2-10）：压平到长焦时山卡被放大成没有笔触的青色剪纸——淡出，交给远处的南山底板（笔触、V 形缺口都在，正好是长卷画心的那一层）
        cu.uOp.value = 1 - (i < 2 ? .55 : 1) * ss(seg(k, .2, .8));   // 返修 4：手绘山带压平时不再整排消失（留一半，画心不发白）
        // 底板上半是很淡的远山脊：整体压暗一档、提一点饱和，让它们落成 #709894 / #8DADA4 这一族中山、远山，不再发白
        // 返修 3（v2-10）：滑动变焦压平时（k → 1）雾减掉六成，山卡的笔触和明暗留住，不被洗成平涂的青色剪纸
        // 返修 4（v3-05）：近排压到 #1F3942 一族的青黛暗部，雾只吃山脚；开头 f559–f575 带一层退下去的金雾
        cu.uHazeAmt.value = ([.0, .02, .06, .1][i] + .2 * warm) * (1 - .8 * k); cu.uHazeLow.value = [.12, .16, .2, .24][i] * (1 - .8 * k); cu.uMul.value.set(...[[.42, .52, .55], [.55, .65, .68], [.68, .76, .78], [.76, .83, .84]][i].map(v => v * (1 - .2 * k)));
        cu.uHiC.value.set(lerp(.82, 1, k), lerp(.88, 1, k), lerp(.88, 1, k));
        // 雾带：上沿落在这一层山脊下面约 70 px（吃掉这一层的山脚，下一层近山从雾里冒出来）
        const fogTop = camY + (HZ - (skyY[i] + 95)) * Math.tan(15.5 * DEG) / 520 * (D - 6);
        const fg = cardFog[i]; fg.position.set(Q559.x - 41, fogTop - (fg.userData.u.uTop.value - .5) * D * .1, Q.z - D + 6); fg.rotation.set(0, 0, 0); fg.visible = i === 3;
        fg.userData.u.uCol.value.set(mist.r, mist.g, mist.b); fg.userData.u.uColTop.value.set(mist.r, mist.g, mist.b); fg.userData.u.uDrift.value.set(t * 3, 0);
      });
      // 最远的南山底板：每帧向右 1.5 px，山脊在 y ≈ 350
      pu.uMap.value = tex.panoA; pu.uUseA.value = 1;   // 返修 4（v3-04）：远排南山用干净 alpha 版
      const Wp = 3200; onScreen(pano, cam, 960 + (fr - 559) * 1.5, 290 - (158 / 724 - .5) * Wp / 3, Wp, 2800); pu.uMul.value.set(.86, .92, .92); pu.uSat.value = .95; pu.uHaze.value.set(mist.r, mist.g, mist.b); pu.uHazeAmt.value = .2; pu.uHazeLow.value = .2; pu.uHiC.value.set(.84, .9, .9);
      onScreen(goldFog, cam, 1500, 200, 2600, 3000, 1500); goldFog.userData.u.uA.value = .3 * warm;   // 返修 4（v1-06）：金雾只在 f559–f580，接住 #14 的金、退成青绿
      // 速度线：2 条又长又近的软云带 + 6 条远一点的细云带（自左向右），透明度低
      speed.forEach((r, i) => {
        if (i > 7) return; r.visible = true;
        const big = i < 2;
        const y = big ? [150, 260][i] : 90 + hashi(i * 3) * 230, D = big ? 12 + 3 * i : 25 + hashi(i) * 60;
        const vpx = big ? 2800 : 2600 * 9 / D;
        const x = ((hashi(i * 7) * 3600 + fr / 24 * vpx) % 3600) - 800;
        r.position.copy(s2w(cam, x, y, D)); r.quaternion.copy(cam.quaternion);
        r.scale.set((big ? 900 + 500 * hashi(i + 5) : 400 + 500 * hashi(i + 5)) / pxPerM(cam, D), (big ? 16 + 6 * hashi(i + 2) : 4 + 4 * hashi(i + 2)) / pxPerM(cam, D), 1);
        cardCol(r, { op: (big ? .3 : .26) * (1 - k * .8), mul: [1.04, 1.04, 1.0], sat: .9 });
      });
      // 返修 4（v3-09）：化开前（f584–f596）三维层的天拉到卷纸色 #EEF3E8，化开的潮线落在天上时不再是灰褐的脏斑
      { const pk = ss(seg(fr, 584, 596)); const lo = new THREE.Color('#F3EBD0').lerp(new THREE.Color('#F2CF84'), warm).lerp(new THREE.Color('#EEF3E8'), pk); sky.userData.u.uLow.value.set(...lin3('#' + lo.getHexString()).toArray());
        sky.userData.u.uHigh.value.copy(lin3('#' + new THREE.Color('#B7D0CB').lerp(new THREE.Color('#EEF3E8'), pk).getHexString())); } sky.userData.u.uRange.value.set(-.05, .3);
      sky.userData.u.uSunAmt.value = .5; sky.userData.u.uSunDir.value.copy(new THREE.Vector3(.5, .5, -.7).normalize());
      st.P = Q;
    } else if (shot === 16) {
      // 豹眼特写：眼睛正好在 P*；以 P* 为中心缓推 1.00 → 1.06（ei）
      const u = ei(seg(fr, 636, 651));
      cam.fov = 30; cam.updateProjectionMatrix(); aim(cam, [0, 100, 0], 0, 0);
      const pz = M.leoHead;
      const IW = pz.rect[2], IH = pz.rect[3];      // 返修 4：新 A03（1415×1000）按清单尺寸，不再写死旧图的 1369×1014
      const hpx = IH * .86 * (1 + .06 * u), s = hpx / IH;
      const cx0 = 1236 + (pz.cornea[0] - IW / 2) * s, cy0 = 438 - (pz.cornea[1] - IH / 2) * s;
      faceCam(leoHead, cam, cx0, cy0, hpx, 3, { flip: true });
      leoHead.clearBones();
      leoHead.bone(0, pz.nose, pz.ex0 ? [pz.ex0[0], pz.ex0[1]] : pz.nose, 80, 260, .8 * Math.sin(f2 * 1.7), 0);
      leoHead.bone(1, pz.head_center, pz.head_center, 120, 420, .6 * Math.sin(f2 * 1.3 + 1), 0);
      leoHead.u.uTint.value.set(1, 1, 1); goldRim(leoHead, .55, .8, hpx * K, .9, '#F3D27A');
      leoHead.u.uCell.value = 190;   // 返修 4（main3-01）：头上 25–45 枚实心点、每枚 10–20 px leoHead.u.uFlowT.value = (t % 1.5) - .2;
      const irisX = cx0 - (pz.iris[0] - IW / 2) * s, irisY = cy0 + (pz.iris[1] - IH / 2) * s;
      onScreen(iris, cam, irisX, irisY, pz.irisR * 2.1 * s, 2.99, pz.irisR * 2.1 * s);
      iris.material.uniforms.uPupil.value = lerp(1, .82, ss(seg(fr, 638, 644)));
      iris.material.uniforms.uOpen.value = f2 === 642 ? 1.55 : f2 === 644 ? 1.35 : f2 >= 646 ? 2.2 : 2;
      onScreen(goldFog2, cam, 1650, 180, 1900, 50, 1300); goldFog2.userData.u.uA.value = .55;
      speed.forEach((r, i) => {
        r.visible = true; const y = 40 + hashi(i * 3) * 980, D = 20 + hashi(i) * 30;
        const x = ((hashi(i * 7) * 3400 + fr / 24 * 1400 * (1 + hashi(i + 9))) % 3400) - 700;
        r.position.copy(s2w(cam, x, y, D)); r.quaternion.copy(cam.quaternion);
        // 返修 3（v2-08）：不再有 1–2 px 的白色细线（像划痕）——细的也加宽到 10–30 px、软边、两端收尖、透明度 ≤ 0.3
        const thick = 50 + 60 * hashi(i + 2); r.visible = i < 10;   // 返修 4（v3-08）：只留 10 条宽的软云带（细的读成划痕）
        r.scale.set((500 + 700 * hashi(i + 5)) / pxPerM(cam, D), thick / pxPerM(cam, D), 1);
        cardCol(r, { op: i < 8 ? .3 : .22, mul: [1.05, 1.02, .95], sat: .9 });
      });
      // 远处的山影（糊）：底板压在画面下沿，左 → 右匀速（不再取模回跳）
      // 返修 4（qa2-15 / v3-07）：背景是长卷世界的延续——青绿远山淡影（D01）+ 云带从左往右流，P* 那一侧压一团暖金逆光
      { const Wp = 3600; onScreen(pano, cam, 960 + (fr - 636) * 30, 860, Wp, 2800); pano.visible = true; pu.uMap.value = tex.panoA; pu.uUseA.value = 1; pu.uMul.value.set(.78, .9, .9); pu.uSat.value = 1.05; pu.uHaze.value.copy(lin3('#DCE8E2')); pu.uHazeAmt.value = .22; pu.uHazeLow.value = .2; pu.uBias.value = 2.5; }
      sky.userData.u.uLow.value.copy(lin3('#E4ECE4')); sky.userData.u.uHigh.value.copy(lin3('#8FB8B4')); sky.userData.u.uRange.value.set(-.25, .3);
      sky.userData.u.uSunAmt.value = .7; sky.userData.u.uSunDir.value.copy(new THREE.Vector3(.4, .3, -1).normalize());
    }
    sea.forEach((c, i) => c.userData.u.uOff.value.set(t * (4 + i * 2), t * 1.5));
    const kd = shot === 13 ? new THREE.Vector3(-.5, .3, -.8) : new THREE.Vector3(-.5, .45, -.7);
    key.position.copy(kd.normalize()); key.updateMatrixWorld();
    setToonGlobals({ keyDir: kd.toArray(), skyDir: [0, 1, 0], skyGain: 1, inkTime: Math.floor(f / 2) });
    // 自检用（门禁不带）：?dbg=hide:pano,hide:cards… 逐层关掉看是哪一层的问题
    if (ctx.DBG.size) { const H = { pano: [pano], cards, cardFog, peaks, footFog, goldFog: [goldFog], speed, sea13, layers, goldSea, sun: [sun, sunGlow], strata, peakCards, veils: layers.filter(m => m.userData.lay.veil), paths: layers.filter(m => m.userData.lay.path), goldSeaC: [goldSeaC], ledgeC: [ledgeC] };
      for (const k in H) if (ctx.DBG.has('hide:' + k)) H[k].forEach(o => o.visible = false); }
    st.fr = fr; st.shot = shot;
  }
  // 尾迹（#14）：挂在世界里的墨点（尾根处落下），投影到屏幕给总合成画；大斑世界直径 0.8–1.1 m，两枚之间撒 5 颗小墨点
  function trailWorld(tf) { return leapPoint(tf).addScaledVector(DLEAP, -.9).addScaledVector(side14, 1.6).add(new THREE.Vector3(0, -.3, 0)); }
  function trail(t, f, shot) {
    const fr = t * 24, out = [];
    if (shot !== 14) return out;
    TRAIL_F.forEach((tf, k) => {
      if (fr < tf || tf >= 559) return;
      const age = fr - tf;
      const s = w2s(cam, trailWorld(tf)); if (s.z <= 6) return;          // 镜头从后面追上来的那几枚不画（免得一枚巨斑糊在镜头上）
      if (fr >= 546 && (s.z < 30 || s.y > 820)) return;                     // 返修 3（v2-09）：冲出云层后的全景里，离镜头太近、落在画面下沿的那几枚不画
      const R = (.42 + .12 * (1 - k / 6)) * pxPerM(cam, s.z) * (1 + .12 * (1 - ss(age / 7)));
      out.push({ x: s.x, y: s.y, R: Math.min(R, 46), seed: 20 + k * 7, gold: .65 * (1 - ss(seg(age, 0, 7))) });
      for (let j = 1; j <= 5 && k > 0; j++) {
        const tf2 = lerp(TRAIL_F[k - 1], tf, j / 6);
        const s1 = w2s(cam, trailWorld(tf2)); if (s1.z <= 6) continue;
        out.push({ x: s1.x, y: s1.y, R: Math.max(3, Math.min(30, (.05 + .04 * hashi(k * 9 + j)) * pxPerM(cam, s1.z))), seed: 50 + k * 9 + j, gold: 0, dot: 1 });
      }
    });
    return out;
  }
  // 叠加层：起跳时崖沿碎石飞起、后爪甩墨（带飞白拖尾）；一拍二
  // 一滴甩出去的墨（返修 2：不再是"圆头 + 竖直细线"的钉子）：不规则的墨团头 + 逆着运动方向收尖的拖尾，拖尾断成两三截（飞白），边上带一两颗小墨点
  function inkFlick(g, x, y, vx, vy, r, seed, a = .95) {
    const X = OV.X, Y = OV.Y, vl = Math.hypot(vx, vy) || 1, dx = vx / vl, dy = vy / vl, nx = -dy, ny = dx;
    g.fillStyle = `rgba(30,36,38,${a.toFixed(3)})`;
    g.beginPath();
    for (let i = 0; i <= 12; i++) { const an = i / 12 * 6.2832; const rr = r * (.8 + .4 * hashi(seed * 31 + i)) * (1 + .25 * Math.cos(an) * 0); const px = x + Math.cos(an) * rr * 1.15, py = y + Math.sin(an) * rr; if (i) g.lineTo(X(px), Y(py)); else g.moveTo(X(px), Y(py)); }
    g.closePath(); g.fill();
    const L = r * (5 + 4 * hashi(seed * 7 + 1));
    const cuts = [[.0, .42], [.52, .78], [.86, 1]];
    for (const [c0, c1] of cuts) {
      if (hashi(seed * 13 + c0 * 10) < .2 && c0 > 0) continue;
      const w0 = r * .9 * (1 - c0), w1 = r * .9 * (1 - c1);
      const ax = x - dx * L * c0, ay = y - dy * L * c0, bx = x - dx * L * c1, by = y - dy * L * c1;
      g.beginPath(); g.moveTo(X(ax + nx * w0), Y(ay + ny * w0)); g.lineTo(X(bx + nx * w1 * .4), Y(by + ny * w1 * .4)); g.lineTo(X(bx - nx * w1 * .4), Y(by - ny * w1 * .4)); g.lineTo(X(ax - nx * w0), Y(ay - ny * w0)); g.closePath(); g.fill();
    }
    for (let k = 0; k < 2; k++) { const u = .3 + .5 * hashi(seed * 17 + k), side = (hashi(seed * 19 + k) - .5) * 2; g.beginPath(); g.arc(X(x - dx * L * u + nx * r * 1.6 * side), Y(y - dy * L * u + ny * r * 1.6 * side), r * (.18 + .15 * hashi(seed + k)) * OV.K, 0, 6.283); g.fill(); }
  }
  // #13 右上压框的松（返修 2）：2D 剪影——一根弯干、几根枝，枝头是一扇扇放射的针叶簇（国画松针的画法），朝光的一侧挑一线金
  function pine2D(g, u) {
    const X = OV.X, Y = OV.Y, K = OV.K, sx = 22 * u;
    const ink = 'rgba(16,10,5,1)';
    g.save(); g.lineCap = 'round'; g.lineJoin = 'round';
    // 干：从画右上角外伸进来，向左下弯
    const trunk = [[2010, 70], [1900, 112], [1800, 150], [1712, 196], [1650, 236]];
    g.strokeStyle = ink;
    for (let i = 0; i < trunk.length - 1; i++) { g.lineWidth = (34 - i * 6) * K; g.beginPath(); g.moveTo(X(trunk[i][0] + sx), Y(trunk[i][1])); g.lineTo(X(trunk[i + 1][0] + sx), Y(trunk[i + 1][1])); g.stroke(); }
    // 枝与针叶簇：[枝根, 枝梢, 簇半径]
    const br = [[[1900, 112], [1855, 40], 64], [[1800, 150], [1745, 92], 58], [[1712, 196], [1660, 300], 54], [[1650, 236], [1548, 222], 66], [[1855, 128], [1820, 215], 46], [[1760, 170], [1690, 140], 50]];
    br.forEach(([a, b, R], k) => {
      g.lineWidth = 9 * K; g.strokeStyle = ink; g.beginPath(); g.moveTo(X(a[0] + sx), Y(a[1])); g.quadraticCurveTo(X((a[0] + b[0]) / 2 + sx + 8), Y((a[1] + b[1]) / 2 - 10), X(b[0] + sx), Y(b[1])); g.stroke();
      // 针叶簇：从簇心放射的短直线，扇形（上半多、下半少），簇底压一团实心
      const cx = b[0] + sx, cy = b[1];
      g.fillStyle = ink; g.beginPath(); g.ellipse(X(cx), Y(cy + R * .12), R * .5 * K, R * .22 * K, 0, 0, 6.283); g.fill();
      for (let i = 0; i < 46; i++) {
        const h = hashi(k * 997 + i * 13);
        const an = -Math.PI * (.02 + .96 * (i / 45)) + (h - .5) * .12;
        const len = R * (.65 + .45 * hashi(k * 31 + i));
        const x1 = cx + Math.cos(an) * len, y1 = cy + Math.sin(an) * len * .62;
        g.lineWidth = (2.4 + 1.2 * h) * K; g.strokeStyle = ink;
        g.beginPath(); g.moveTo(X(cx), Y(cy)); g.lineTo(X(x1), Y(y1)); g.stroke();
        // 朝光（左上）的针叶挑一线金
        if (Math.cos(an) < -.2 && Math.sin(an) < -.25 && h > .45) { g.lineWidth = 1.3 * K; g.strokeStyle = 'rgba(232,196,92,.85)'; g.beginPath(); g.moveTo(X(cx + Math.cos(an) * len * .55 - 1.5), Y(cy + Math.sin(an) * len * .62 * .55 - 1.5)); g.lineTo(X(x1 - 1.5), Y(y1 - 1.5)); g.stroke(); }
      }
    });
    g.restore();
  }
  // 叠加层：#13 右上的松；起跳时崖沿岩粉飞起、后爪甩墨（带飞白拖尾）；一拍二
  function overlay(t, f, shot) {
    const fr = t * 24, f2 = f - (f % 2);
    if (shot === 13 && f < 517) { const g = OV.use(); pine2D(g, ss5(seg(fr, 494, 516))); return; }
    const fp = f - ((f - 1) % 2);                     // 一拍二按 f517 的切点对齐（f519–f520 一档）
    if (!((shot === 13 && fp >= 519) || (shot === 14 && f2 <= 532))) return;
    const g = OV.use();
    // 起点：#13 侧面机位里是后爪（崖沿上豹身后），#14 里是后爪（豹的屏幕位置往尾巴那头）
    let ox, oy, sc, age;
    if (shot === 13) { const p = w2s(cam, foot13.clone().addScaledVector(m14, -.45)); ox = p.x; oy = p.y - 6; sc = 1; age = (fp - 519) / 24; }
    else { const s = st.leapS || { x: 900, y: 600 }; const rr = (st.leapRot || 0) * DEG; ox = s.x + Math.cos(rr) * (st.leapH || 200) * 1.05; oy = s.y - Math.sin(rr) * (st.leapH || 200) * 1.05 + 25; sc = .8; age = (f2 - 519) / 24; }
    // 岩粉 30 粒（侧面机位，蹬出那一刻从后爪下面迸起）
    if (shot === 13) for (let i = 0; i < 30; i++) {
      const a = -Math.PI * (.05 + .55 * hashi(i * 3)), v = 260 + 420 * hashi(i * 5);
      const x = ox + Math.cos(a) * v * age * 1.2 + (hashi(i) - .5) * 30, y = oy + Math.sin(a) * v * age + 900 * age * age;
      const r = (1.5 + 3 * hashi(i * 7)) * OV.K;
      g.fillStyle = `rgba(217,196,150,${(.9 * clamp(1 - age * 2.2)).toFixed(3)})`; g.beginPath(); g.arc(OV.X(x), OV.Y(y), r, 0, 6.283); g.fill();
    }
    // 甩墨 10 滴：往身后（画右）、先上后落，墨团头 + 断续的收尖拖尾
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI * (.04 + .3 * hashi(i * 13 + 1)), v = (300 + 380 * hashi(i * 17 + 2)) * sc;
      const x = ox + Math.cos(a) * v * age, y = oy + Math.sin(a) * v * age + 900 * age * age * sc;
      const vx = Math.cos(a) * v, vy = Math.sin(a) * v + 1800 * age * sc;
      const r = (3 + 6 * hashi(i * 19 + 3)) * sc;
      inkFlick(g, x, y, vx, vy, r, i + 3, clamp(1.1 - age * 1.2));
    }
  }
  function look(t, f, shot) {
    const fr = t * 24;
    const OL = { width: 2.4, color: '#1C2622', wobble: .7, warp: 70, boilFps: 12, pressure: .35, breakup: .12, inner: .5, farScale: .5, tint: .2, darken: .5, fogFade: .9, near: 3, far: 3000 };
    const grade = { exposure: 1.03, warmth: .15, lift: [.020, .030, .035], gamma: .98, gain: 1.02, saturation: 1.08, shoulder: .9 };
    const bloom = { strength: .55, threshold: .78, radius: .70, tint: '#FFE6A6' };
    const kuw = { radius: 2, farRadius: 4.5, farStart: 40, farEnd: 2500, strength: .85, protect: null };
    const fog = { color: '#E3ECE4', colorHigh: '#EEF3E8', density: .0009, start: 20, max: .75, cutoff: 5000, sky: 0 };
    const paper = { strength: .03 }; let vignette = .15;
    if (shot === 13) { fog.color = '#E9A23A'; fog.colorHigh = '#F6D890'; fog.density = .0014; fog.start = 20; fog.max = .5; OL.near = 1; OL.far = 60; OL.color = '#120A05';
      grade.warmth = .18; grade.lift = [.012, .006, .002]; grade.gamma = 1.04; bloom.strength = .6; bloom.threshold = .8; vignette = .32; }
    if (shot === 14) { const g = ss(seg(fr, 523, 552)); fog.max = .25; fog.density = .0006; fog.start = 30; vignette = lerp(lerp(.3, .2, g), .4, ss(seg(fr, 545, 550)));   // 返修 3：金色云海全景四角压暗（每帧都留一块暗部）
      // 雾色跟着天从金褐亮到金（只给 3D 山峰一点空气透视；云团自己按距离化进天光）
      fog.color = '#' + new THREE.Color('#B9864C').lerp(new THREE.Color('#F0D49A'), g).getHexString(); fog.colorHigh = '#' + new THREE.Color('#D9B072').lerp(new THREE.Color('#F6E6BC'), g).getHexString();
      grade.warmth = lerp(.18, .22, g); grade.lift = [0, 0, 0]; grade.gamma = 1.08; bloom.strength = lerp(.55, .38, ss(seg(fr, 545, 551))); }
    if (shot === 15) { paper.strength = lerp(.03, .10, seg(fr, 586, 611)); fog.max = .1; fog.density = .0004; bloom.strength = .25; bloom.threshold = .9; grade.exposure = .97; grade.gamma = 1.1; grade.lift = [0, 0, 0]; vignette = .22; }   // 返修 4（v3-05）：不抬黑，暗部能落到青黛   // 山卡、雾带自己管空气色；look 的雾只给 3D 峰一点点
    if (shot === 16) { grade.warmth = .20; bloom.strength = .7; bloom.threshold = .7; bloom.radius = .75; kuw.radius = 1.5; kuw.farRadius = 3; kuw.farStart = .3; kuw.farEnd = 3; paper.strength = .03; vignette = .2; OL.near = .3; OL.far = 3; }
    return { outline: OL, grade, bloom, kuwahara: kuw, fog, paper, vignette };
  }
  function post(t, f, shot) {
    const fr = t * 24, p = {};
    // 返修 3（v2-02⑤）：#13 金雾里的体积光与浮尘（ref_03）——从太阳出发的径向光束 + 满画面的浮光点
    if (shot === 13) {
      const s = st.sunS || { x: 430, y: 330 };
      p.uGod = f >= 517 ? .2 : .3; p.uGodPos = [s.x, s.y]; p.uGodThr = .72; p.uGodCol = [1, .74, .36];
      p.uDust = .3; p.uDustT = t; p.uDustAll = 1;   // 返修 4（v3-10）：数量减到三分之二、只落在亮处（post.js 里按场景亮度遮罩）
    }
    if (shot === 14) {
      // 穿云白场：镜头穿过每层云的那 1–2 帧，最多 40%，豹的墨线和暗剪影始终在
      let w = 0; const cy = cam.position.y;
      for (const h of LH) for (const hh of [h, h + .6]) w = Math.max(w, 1 - smoothstep01(Math.abs(cy - hh) / 1.2));
      p.uWhite = w * .1; p.uWhiteC = [.96, .9, .76];   // 返修 3：穿层白场 0.22 → 0.1（每帧都留住暗部）
    }
    return p;
  }
  const smoothstep01 = x => { x = clamp(x); return x * x * (3 - 2 * x); };
  return { scene, camera: cam, update, look, post, trail, overlay, st };
}
