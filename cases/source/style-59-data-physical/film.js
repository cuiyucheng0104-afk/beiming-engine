// 《一年的雨》— 数据实物化
// render(t)：摄影机（一镜到底）→ 落珠 → 景深 → 2D 叠层（读数牌、计数器、来源行、标题）；EV 驱动拟音与配乐核对；TEXTS 供 readcheck
import * as THREE from 'three';
import { makePost } from '/core/three/post.js';
import { clamp, seg, eo, eio, ss, lerp, track } from '/core/lib.js';
import { DUR, BEAT, b, T, IN, MM, TOTAL, LABELS, WETTEST, FEED_ON, MONTH_NOTE, UNIT_BEATS } from './timeline.js';
import { buildSet, BEADS, LAST, LAST_TOP, LAST_R, az, cyl, tubeC, slot, landed, landedAll, levelY, R, BASE_H, TUBE_H, Y0, BD } from './set.js';

const W = 1920, H = 1080;
const BG = new THREE.Color('#c4beb4');
const INK = '#1c1d20', INK2 = 'rgba(28,29,32,.62)', ACC = '#d4521c';

await Promise.all(['500 30px NotoSC', '400 21px NotoSC', '600 80px NotoSerifSC', '200 150px Inter', '300 52px Inter', '400 26px Inter', '500 24px JBMono', '400 22px JBMono'].map(f => document.fonts.load(f)));
await document.fonts.ready;

const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(2); renderer.setSize(W, H);
renderer.toneMapping = THREE.NeutralToneMapping; renderer.toneMappingExposure = 1.06;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('stage').appendChild(renderer.domElement);
const scene = new THREE.Scene(); scene.background = BG.clone(); scene.fog = new THREE.Fog(BG.clone(), 12, 34);
const camera = new THREE.PerspectiveCamera(30, W / H, .02, 80);
const post = makePost(renderer, scene, camera, W, H, { ssaa: 2, ao: true, aoRadius: .06, aoThickness: .25, aoScale: 1.4, aoAmt: .7 });
post.bloom.strength = .06; post.bloom.threshold = 1.7;
post.vig.uniforms.amt.value = .26; post.vig.uniforms.warm.value = .2; post.vig.uniforms.contrast.value = .16;
const set = await buildSet(scene, renderer);

// ———————————————— 摄影机：一镜到底 ————————————————
const D = d => d * Math.PI / 180;
const J = tubeC(0);
// 第一段（0–12 s）：柱坐标关键帧 [机位方位, 半径, 高, 目标方位, 半径, 高, 视角, 光圈]
const CK = track([
  [0.0, [D(30), 2.36, .232, D(30), 1.55, .214, 24, 34]],         // 微距：一月管底
  [b(6), [D(30.8), 2.13, .236, D(30), 1.55, .222, 24, 34]],      // 推进到铜珠占满
  [b(8), [D(31.4), 2.09, .25, D(30.2), 1.55, .238, 24, 30]],
  [b(11), [D(46), 3.55, .82, D(64), 1.55, .36, 30, 11]],          // 起升后撤：旱季四个月同框
  [b(14), [D(158), 4.3, 1.5, D(180), 1.4, .95, 30, 8]],       // 雨季：镜头跟着顶升高
  [b(17), [D(260), 4.3, 1.7, D(282), 1.4, 1.05, 30, 8]],
  [b(19.4), [D(332), 4.3, 1.62, D(350), 1.4, .92, 30, 8]],
  [b(20), [D(336), 4.32, 1.66, D(353), 1.38, .9, 30, 8]],
]);
// —— 第二段（12 s 以后）：长焦、远机位，管子保持接近竖直 ——
// 钟面机位：从六点钟一侧约 70° 俯角看整座钟（管身高差仍可读）；长焦 20°，机位远，不再有广角透视外倾
const sph = (tgt, azDeg, elDeg, dist) => { const a = D(azDeg), e = D(elDeg); return tgt.clone().add(new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)).multiplyScalar(dist)); };
const JC = tubeC(WETTEST);                                       // 六月管（六点钟，+z）
const TOPT = new THREE.Vector3(0, .95, .12);
const EL = 68;                                                  // 钟面与推镜同一俯角：推镜是沿视线的纯推进
const TOP = { pos: sph(TOPT, 180, EL, 14), tgt: TOPT, fov: 20, aper: 4 };
// 静默推镜终点：六月管口占满画面上半，管身占画面高度 2/3
const HEROT = new THREE.Vector3(JC.x, 1.9, JC.z);
const HERO = { pos: sph(HEROT, 180, EL, 7.4), tgt: HEROT, fov: 18, aper: 9 };
// 结尾：高位 3/4，整座装置在画面右侧，底部给来源行让出空白
const ENDT = new THREE.Vector3(-.95, .74, .2);
const END = { pos: sph(ENDT, 148, 23, 14.4), tgt: ENDT, fov: 21, aper: 6 };
const bez = (a, c, d, u) => a.clone().multiplyScalar((1 - u) * (1 - u)).add(c.clone().multiplyScalar(2 * u * (1 - u))).add(d.clone().multiplyScalar(u * u));
// 越过 12 点钟上空时用四元数插值"上"方向：无翻滚、无万向锁
const qOf = (pos, tgt) => new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(pos, tgt, new THREE.Vector3(0, 1, 0)));
let QA = null, QB = null;
function pose(t) {
  if (t <= T.reveal) {
    const c = CK(t);
    return { pos: cyl(c[0], c[1], c[2]), tgt: cyl(c[3], c[4], c[5]), fov: c[6], aper: c[7] };
  }
  const A = pose(T.reveal);
  if (t <= T.top) {      // 拉开 + 升起：越过 12 点钟上空，落到六点钟一侧的 70° 钟面机位；视角同时收窄（长焦）
    const x0 = seg(t, T.reveal, T.top), x = (x0 < .2 ? x0 * x0 / .4 : x0 - .1) / .9, u = 1 - (1 - x) ** 2.2;   // 拉开：0.24 s 内加速起步，迅速脱离广角近景，越到钟面越慢
    const cp = new THREE.Vector3(A.pos.x * 2.8, 20, A.pos.z * 2.8), ct = new THREE.Vector3(0, .6, -.6);
    QA = QA || qOf(A.pos, A.tgt); QB = QB || qOf(TOP.pos, TOP.tgt);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(QA.clone().slerp(QB, u));
    return { pos: bez(A.pos, cp, TOP.pos, u), tgt: bez(A.tgt, ct, TOP.tgt, u), fov: lerp(A.fov, TOP.fov, ss(seg(u, 0, .35))), aper: lerp(A.aper, TOP.aper, u), up };
  }
  if (t <= T.last) {     // 静默：从钟面全景推向六月管口（推镜 + 下降），焦点跟着最后一颗下沉
    const u = eio(seg(t, T.top + .05, T.last - .02));
    const tgt = TOP.tgt.clone().lerp(HERO.tgt, u);
    return { pos: sph(tgt, 180, EL, lerp(14, 7.4, u)), tgt, fov: lerp(TOP.fov, HERO.fov, u), aper: lerp(TOP.aper, HERO.aper, u) };
  }
  // 落定之后：先在六月管口停半拍，再缓慢环绕 + 拉开 + 下降到高位 3/4（俯仰慢变，管子保持竖直）
  const u = ss(seg(t, T.last + .3, DUR + .25));
  const az = lerp(180, 148, u), el = lerp(EL, 23, ss(seg(u, 0, .92))), dist = lerp(7.4, 14.4, eo(u));
  const tgt = HERO.tgt.clone().lerp(ENDT, eo(u));
  return { pos: sph(tgt, az, el, dist), tgt, fov: lerp(HERO.fov, END.fov, u), aper: lerp(HERO.aper, END.aper, u) };
}
// 焦点
const bp = new THREE.Vector3();
function focusPoint(t, cam) {
  if (t < b(5)) return slot(0, 0);
  if (t < b(8)) { const u = ss(seg(t, b(5), b(6))); return slot(0, 0).lerp(slot(0, 9), u); }
  if (t < T.reveal) {
    // 跟正在进料的那根管的顶
    const mf = clamp((t / BEAT) - 8, 0, 11.5), m0 = Math.floor(mf), m1 = Math.min(11, m0 + 1), u = ss(mf - m0);
    const f = m => { const c = tubeC(m); return new THREE.Vector3(c.x, levelY(m, landed(m, t)), c.z); };
    const p = f(m0).lerp(f(m1), u);
    if (t < b(9)) return slot(0, 9).lerp(p, ss(seg(t, b(8), b(9))));
    return p;
  }
  if (t < T.top) return TOP.tgt.clone();
  if (t <= T.last) {
    const v = set.beadPos(LAST, t, bp);
    if (v && v.y < cam.y - .5) return v.clone();          // 入画后焦点跟着珠下沉
    return new THREE.Vector3(LAST.p.x, LAST.p.y, LAST.p.z);
  }
  return LAST.p.clone().lerp(ENDT, ss(seg(t, T.last + .3, DUR)));
}
const fwd = new THREE.Vector3();
function setCamera(t) {
  const p = pose(t);
  camera.position.copy(p.pos); camera.fov = p.fov; camera.updateProjectionMatrix();
  camera.up.copy(p.up || new THREE.Vector3(0, 1, 0));
  camera.lookAt(p.tgt);
  // 最后一颗落定：画面被震一下（纵向 9 px、横向 5 px，0.25 s 内衰减完）
  const dt = t - T.last;
  if (dt >= 0 && dt < .25) {
    // 震动与帧锁定（24 fps 下逐帧换向），避免高频振荡被采样掉：约 +9 / −6 / +4 / −2 px
    const env = (1 - dt / .25) ** 1.5, px = 2 * Math.tan(D(p.fov) / 2) / H, k = dt * 24 - .4;
    camera.rotateX(10 * px * env * Math.cos(Math.PI * k)); camera.rotateY(6 * px * env * Math.cos(Math.PI * k / 2));
  }
  camera.updateMatrixWorld();
  camera.getWorldDirection(fwd);
  // 雾跟着机位距离走：远机位不发灰
  const dist = p.pos.distanceTo(p.tgt); scene.fog.near = Math.max(12, dist + 3); scene.fog.far = scene.fog.near + 22;
  post.dof.focus = Math.max(.05, focusPoint(t, p.pos).sub(camera.position).dot(fwd)); post.dof.aper = p.aper; post.dof.maxCoc = 18;
}
const proj = v => { const p = v.clone().project(camera); return [(p.x + 1) / 2 * W, (1 - p.y) / 2 * H, p.z]; };

// ———————————————— 2D 叠层 ————————————————
const ov = document.getElementById('ov'), g = ov.getContext('2d');
let TXT = [], REPORT = true;
function text(id, s, x, y, font, color, a = 1, align = 'left', report = s) {
  if (a <= .01) return 0;
  g.globalAlpha = a; g.font = font; g.fillStyle = color; g.textAlign = align; g.fillText(s, x, y);
  const w = g.measureText(s).width, sz = parseFloat(font.split(' ')[1]);
  const x0 = align === 'left' ? x : align === 'right' ? x - w : x - w / 2;
  if (REPORT && a > .5) TXT.push({ id, text: report, x0, y0: y - sz, x1: x0 + w, y1: y + sz * .25 });
  g.globalAlpha = 1; return w;
}
const width = (s, font) => { g.font = font; return g.measureText(s).width; };
function line(pts, a, color = INK, w = 1.4) { if (a <= .01) return; g.globalAlpha = a; g.strokeStyle = color; g.lineWidth = w; g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.stroke(); g.globalAlpha = 1; }
function dot(x, y, a, color = INK, r = 3.4) { if (a <= .01) return; g.globalAlpha = a; g.fillStyle = color; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1; }
function plate(x, y, w, h, a) { if (a <= .01) return; g.globalAlpha = a * .84; g.fillStyle = '#efebe4'; g.beginPath(); g.roundRect(x, y, w, h, 4); g.fill(); g.globalAlpha = 1; }
function swatch(x, y, kind, a) {
  if (a <= .01) return; g.globalAlpha = a; g.strokeStyle = INK; g.lineWidth = 1;
  const gr = g.createRadialGradient(x + 5, y - 10, 1, x + 7.5, y - 7.5, 9);
  if (kind === 'brass') { gr.addColorStop(0, '#f3dfb2'); gr.addColorStop(1, '#a8834a'); } else if (kind === 'steel') { gr.addColorStop(0, '#ffffff'); gr.addColorStop(1, '#8a9099'); } else { gr.addColorStop(0, '#ffffff'); gr.addColorStop(1, '#9fcfc8'); }
  g.fillStyle = gr; g.beginPath(); g.arc(x + 7.5, y - 7.5, 7.5, 0, Math.PI * 2); g.fill(); g.stroke(); g.globalAlpha = 1;
}
// 读数：物体上一点 → 引线 → 纸色底板（材质色块 + 类别行 + 数值与单位）；16 px 上升淡入，只淡出
const FV = '300 52px Inter', FU = '500 24px JBMono', FT = '500 28px NotoSC';
function reading(id, world, cat, val, unit, kind, a, side = 1, lift = 150, out = 140, accent = false) {
  if (a <= .01) return;
  const [ax, ay] = proj(world), k = eo(a), rise = 16 * (1 - eo(a));
  const wv = width(val, FV), wu = unit ? width(unit, FU) + 10 : 0, wc = width(cat, FT) + 26, tw = Math.max(wv + wu, wc);
  let ex = ax + side * out, ey = ay - lift;
  ex = side > 0 ? clamp(ex, 100, W - 110 - tw) : clamp(ex, 110 + tw, W - 100); ey = clamp(ey, 220, 820);
  const x0 = side > 0 ? ex : ex - tw, yb = ey + rise;
  plate(x0 - 16, yb - 110, tw + 32, 124, a);
  dot(ax, ay, a, accent ? ACC : INK); line([[ax, ay], [lerp(ax, side > 0 ? x0 - 8 : x0 + tw + 8, k), lerp(ay, yb - 40, k)]], a * .85, accent ? ACC : INK);
  swatch(x0, yb - 72, kind, a);
  text(id + 'c', cat, x0 + 26, yb - 74, FT, INK2, a);
  const w1 = text(id + 'v', val, x0, yb - 12, FV, accent ? ACC : INK, a);
  if (unit) text(id + 'u', unit, x0 + w1 + 10, yb - 14, FU, accent ? ACC : INK2, a);
}
const fade = (t, t0, t1, fo = .3) => seg(t, t0, t0 + IN) * (1 - seg(t, t1 - fo, t1));

function overlay(t) {
  g.clearRect(0, 0, W, H); TXT = [];
  // ① 单位：第 1 颗 = 1 毫米
  reading('r1', slot(0, 0).add(new THREE.Vector3(0, BD * .45, 0)), LABELS.r1cat, LABELS.r1val, '', 'glass', fade(t, T.r1[0], T.r1[1]), 1, 250, 330);
  // ② 第 10 颗是铜珠 = 10 毫米
  reading('r2', slot(0, 9).add(new THREE.Vector3(0, -BD * .3, 0)), LABELS.r2cat, LABELS.r2val, '', 'brass', fade(t, T.r2[0], T.r2[1]), -1, -60, 300);
  // ③ 计数器：随落定的珠子数滚动（不按时间）；最后一颗落定时转为强调色
  {
    const a = seg(t, T.counter, T.counter + IN);
    if (a > .01) {
      const n = landedAll(t), done = n >= TOTAL, x = 110, y = 118 + 16 * (1 - eo(a));
      plate(x - 22, y - 46, 420, 230, a);
      text(done ? 'cnt2' : 'cnt', done ? LABELS.cntEnd : LABELS.cnt, x, y, '500 30px NotoSC', INK, a);
      line([[x, y + 20], [x + 330, y + 20]], a * .6, done ? ACC : INK, 1.2);
      const w = text('cntv', String(n), x - 6, y + 168, '200 150px Inter', done ? ACC : INK, a, 'left', String(TOTAL));
      text('cntu', LABELS.mm, x + w + 12, y + 160, '500 34px NotoSC', done ? ACC : INK2, a);
    }
  }
  // ④ 六月：全年最多
  {
    const a = seg(t, T.june, T.june + IN);
    reading('jun', LAST.p.clone().add(new THREE.Vector3(0, LAST_R * .6, 0)), LABELS.junCat, LABELS.junVal, LABELS.mm, 'glass', a, 1, 120, 260, true);
  }
  // ④' 最后一颗：静默中读数钉在下落的珠上，一路跟进六月管
  {
    const v = set.beadPos(LAST, t, bp), a = fade(t, T.lastTag, T.june);
    if (v && a > .01) reading('lst', v.clone(), LABELS.lastCat, LABELS.lastVal, '', 'steel', a, -1, 90, 220);
  }
  // ⑤ 标题
  {
    const a = seg(t, T.title, T.title + BEAT), a2 = seg(t, T.sub, T.sub + IN), x = 110, y = 430;
    text('title', LABELS.title, x, y + 16 * (1 - eo(a)), '600 84px NotoSerifSC', INK, a);
    line([[x, y + 34], [x + 360 * eo(a2), y + 34]], a2, INK, 1.2);
    text('sub', LABELS.sub, x, y + 76 + 16 * (1 - eo(a2)), '400 22px JBMono', INK2, a2);
  }
  // ⑥ 来源行：从第一块读数起一直在右下
  { const a = seg(t, T.src, T.src + IN), w = width(LABELS.source, '400 21px NotoSC');
    plate(W - 90 - w - 14, H - 62 - 26, w + 28, 38, a);        // 来源行自带纸色底板：压在基座上也读得清
    text('src', LABELS.source, W - 90, H - 62, '400 21px NotoSC', INK2, a, 'right'); }
}

// ———————————————— 帧 ————————————————
window.DUR = DUR;
window.render = t => {
  set.update(t);
  setCamera(t);
  post.composer.render();
  overlay(t);
};
window.TEXTS = t => { window.render(t); return TXT; };

// 声音与卡点事件：每颗珠的落定、每月首颗、读数、镜头大动作、抽空、最后一颗
const EV = [];
for (const d of BEADS) EV.push({ t: +d.land.toFixed(4), type: 'bead', m: d.m, k: d.k, brass: d.brass, mode: d.mode });
for (let m = 0; m < 12; m++) {
  const feed = BEADS.filter(d => d.m === m && d.mode === 'feed').map(d => d.land).sort((x, y) => x - y);
  EV.push({ t: +feed[0].toFixed(4), type: 'month', m, n: feed.length, d: feed[feed.length - 1] - feed[0], note: MONTH_NOTE[m], cue: `month${m + 1}` });
}
EV.push(
  { t: BEADS[0].land, type: 'cue', cue: 'bead1' },
  { t: BEADS.find(d => d.m === 0 && d.k === 9).land, type: 'cue', cue: 'brass10' },
  { t: T.r1[0] + IN, type: 'text', cue: 'r1' }, { t: T.r2[0] + IN, type: 'text', cue: 'r2' },
  { t: T.counter + IN, type: 'text', cue: 'counter' }, { t: T.src + IN, type: 'text', cue: 'source', v: .3 },
  { t: T.june + IN, type: 'text', cue: 'june' }, { t: T.lastTag + IN, type: 'text', cue: 'lastTag', v: .25 }, { t: T.title + BEAT, type: 'text', cue: 'title' }, { t: T.sub + IN, type: 'text', cue: 'sub' },
  { t: T.crane, type: 'whoosh', d: 2.4, v: .45, cue: 'crane' },
  { t: T.reveal, type: 'whoosh', d: T.top - T.reveal + .3, v: .8, cue: 'reveal' },
  { t: T.top, type: 'cue', cue: 'top' },
  { t: T.suck, type: 'suck', d: T.last - T.suck, cue: 'suck' },
  { t: LAST.land, type: 'last', cue: 'last' },
  { t: T.last + Math.PI / 22, type: 'bounce' },
  { t: T.recap, type: 'recap', cue: 'recap' }, { t: T.final, type: 'final', cue: 'final' },
);
EV.sort((x, y) => x.t - y.t);
window.EV = EV;
window.render(0);
window.READY = true;
