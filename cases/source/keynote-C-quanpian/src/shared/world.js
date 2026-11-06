// 共用层：书（翻页 / 摊平 / 合书）、台灯（调光 / 转向）、相机（章节边界连续衔接）、章节图层显隐、章节模块调度。
// 全部是 t 的纯函数：任何一帧都可以单独渲染（多 worker、分段渲染、乱序出静帧都不受影响）。
// t < 20 s 时本层只把自己动过的东西复位到开头的原值，画面完全交给开头的 stage.update(t) —— 开头逐帧不变。
import * as THREE from 'three';
import { clamp, lerp, seg, ss, eio, ei, track } from '/core/lib.js';
import { T, BEAT, CH, CHAPTERS, BOOK, SPREADS, spreadWindow, CAM_BRIDGE, KAITOU_DUR, DUR } from '../timeline.js';
import { BW, BD, PG, texOf } from '../stage.js';
import * as A from '../art.js';
import * as K from './kit.js';
import { TEXT } from './texts.js';

const ZH = -BD / 2;                 // 书脊（铰链）z
const EPS = .0008;                  // 翻过去的书页之间的间隔（沿书页法线，米）
const PW = BW - .008, PD = BD - .006;   // 书页尺寸（与开头地面页一致）
const D2R = Math.PI / 180;

// ———————————————— 书：角度（度），纯函数 ————————————————
const TURN = n => BOOK.turns.find(x => x.page === n);
const FLAT = BOOK.turns.find(x => x.flat);
// 整摞（封面 + 已翻过的页）的角度：开头翻开后 90°；第 62 小节摊平到 FLAT_ANGLE；第 89 小节合上到 0°
export function stackAngle(t) {
  if (t < FLAT.t - BOOK.FLAT_D) return 90;
  if (t < BOOK.close - BOOK.CLOSE_D) return 90 + (BOOK.FLAT_ANGLE - 90) * flatEase(t);
  return BOOK.FLAT_ANGLE * (1 - closeEase(t));
}
function flatEase(t) {   // 0→1，落定在 FLAT.t，落地后一次小回弹（书页离开桌面 1.2% 再落下）
  const T0 = FLAT.t; if (t < T0) return eio(seg(t, T0 - BOOK.FLAT_D, T0));
  return 1 - .012 * Math.sin(Math.PI * seg(t, T0, T0 + .3));
}
function closeEase(t) {  // 0→1，加速合上（像落下），落定在 close，回弹 1.5° 再落定
  const T0 = BOOK.close; if (t < T0) return ei(seg(t, T0 - BOOK.CLOSE_D, T0));
  return 1 - 1.5 / BOOK.FLAT_ANGLE * Math.sin(Math.PI * seg(t, T0, T0 + .18));
}
// 第 n 页（1–6）的角度：未翻 0°；预备抬起 4°；主动作先慢后快，落定那一帧到 90°（拍到书页堆上），回弹 7° → 2° → 落定；之后随整摞走
export function pageAngle(n, t) {
  const tr = TURN(n); if (!tr) return 0;
  const T0 = tr.t;
  if (t < T0 - BOOK.PRE) return 0;
  if (tr.flat) {   // 翻页 + 摊平同一个动作：从 0° 直接落到摊平角
    const FS = BOOK.FLAT_SWING ?? BOOK.FLAT_D;   // 返修：地面页 121.25–121.5 只预备抬起 4°，121.5 起 0.5 s 翻过去（整摞背板仍 121.25 起向后摊平，两者不相交）
    if (t < T0 - FS) return 4 * ss(seg(t, T0 - BOOK.PRE, T0 - FS));
    if (t < T0) return lerp(4, BOOK.FLAT_ANGLE, eio(seg(t, T0 - FS, T0)));
    return stackAngle(t);
  }
  if (t < T0 - BOOK.SWING) return 4 * ss(seg(t, T0 - BOOK.PRE, T0 - BOOK.SWING));
  if (t < T0) { const u = seg(t, T0 - BOOK.SWING, T0); return lerp(4, 90, Math.pow(u, 1.6)); }
  const reb = 7 * Math.sin(Math.PI * seg(t, T0, T0 + .2)) + 2 * Math.sin(Math.PI * seg(t, T0 + .2, T0 + .34));
  return stackAngle(t) - reb;
}
// 跨页 n 上的立体件折叠量：书页抬起到 50° 时完全压平
const foldOf = n => t => n > 6 ? (t >= BOOK.close - BOOK.CLOSE_D ? ss(seg(stackAngle(t), BOOK.FLAT_ANGLE, BOOK.FLAT_ANGLE - 60)) : 0) : ss(seg(pageAngle(n, t), 0, 50));
export function bookState(t) {
  return { stack: stackAngle(t), pages: [1, 2, 3, 4, 5, 6].map(n => pageAngle(n, t)), spread: spreadAt(t) };
}
export function spreadAt(t) { let s = 1; for (const tr of BOOK.turns) if (t >= tr.t) s = tr.after; return s; }

// ———————————————— 台灯：转场序列 → 状态，纯函数 ————————————————
// 序列项 { t, dur = .18, dim?, yaw?, aim?: [x,y,z], color?, env?, sound? }：在 t 起、dur 秒内（eio）移到给定值；没给的属性保持
export const LAMP0 = { dim: 1, yaw: 0, aim: [.02, PG + .04, -.03], color: '#ffe2bd', env: null };
function lampProgram(list) {
  const L = [...list].sort((a, b) => a.t - b.t), froms = [];
  const at = (t, upto) => { let s = { ...LAMP0, aim: [...LAMP0.aim] };
    for (let i = 0; i < upto; i++) { const k = L[i]; if (t < k.t) break; const u = eio(seg(t, k.t, k.t + (k.dur ?? .18))), f = froms[i];
      s = { ...f, aim: [...f.aim] };
      for (const p of ['dim', 'yaw', 'env']) if (k[p] !== undefined && k[p] !== null) s[p] = lerp(f[p] ?? (p === 'env' ? envOf(f.dim) : 0), k[p], u);
      if (k.aim) s.aim = f.aim.map((v, j) => lerp(v, k.aim[j], u));
      if (k.color) { const c = new THREE.Color(f.color).lerp(new THREE.Color(k.color), u); s.color = '#' + c.getHexString(); } }
    return s; };
  for (let i = 0; i < L.length; i++) froms[i] = at(L[i].t, i);
  return { list: L, at: t => at(t, L.length) };
}
const envOf = dim => .35 + .65 * dim;    // 房间环境光默认跟着台灯走（灯暗了，屋里也暗）

// ———————————————— 相机：7 维机位 [log fov, 仰角°, 方位°, tx, ty, tz, log 可视高] ————————————————
export const camKey = (fov, el, az, tx, ty, tz, vis) => [Math.log(fov), el, az, tx, ty, tz, Math.log(vis)];
// 没给机位时的默认镜头（看当前跨页）
const DEFAULT_CAM = {
  ch2: camKey(26, 22, 0, 0, PG + .07, -.03, .36), ch3: camKey(26, 22, 0, 0, PG + .07, -.03, .36), ch4: camKey(26, 22, 0, 0, PG + .08, -.03, .4),
  ch5: camKey(30, 48, 0, 0, PG, -.06, .75), ch67: camKey(30, 48, 0, 0, PG, -.06, .75),
};
function hermite(p0, v0, p1, v1, u, L) {
  const u2 = u * u, u3 = u2 * u, h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
  return p0.map((_, i) => h00 * p0[i] + h10 * L * v0[i] + h01 * p1[i] + h11 * L * v1[i]);
}

export async function makeWorld(S, { coverRedraw }) {
  const H = S.H, scene = S.scene;
  const ctx = { THREE, scene, renderer: S.renderer, cam: S.cam, post: S.post, S, opening: H, kit: K, TEXT, camKey, PG, BW, BD, ZH, PW, PD };

  // ———————————————— 书页 ————————————————
  // 第 n 页：pivot（书脊）→ off（沿法线错开，免得叠在一起闪烁）→ inner（抵消 pivot 平移，回到"摊平时的世界坐标"）
  // 摊平时 pivot×off×inner = 单位阵（x − x = 0 精确成立），所以第 1 页（开头的地面页与纸舞台）在 t < 20 s 时与开头逐位相同
  const pages = [];
  const groundArtDefault = (seed) => defaultFloorArt(seed), backArtDefault = (seed) => defaultBackArt(seed);
  for (let n = 1; n <= SPREADS; n++) {
    const pivot = new THREE.Group(), off = new THREE.Group(), inner = new THREE.Group();
    pivot.position.set(0, PG, ZH); inner.position.set(0, -PG, -ZH); pivot.add(off); off.add(inner); H.book.add(pivot);
    let floor, root;
    if (n === 1) {   // 开头的地面页、纸舞台原物搬进第 1 页（世界坐标不变）
      floor = H.ground; inner.add(H.ground); inner.add(H.stage);
      root = new THREE.Group(); root.position.set(0, PG + .0004, 0); inner.add(root);
    } else {
      floor = new THREE.Mesh(new THREE.PlaneGeometry(PW, PD), new THREE.MeshStandardMaterial({ map: texOf(groundArtDefault(n)), roughness: .92 }));
      floor.rotation.x = -Math.PI / 2; floor.position.set(0, PG + .0001, .001); floor.receiveShadow = true; inner.add(floor);
      root = new THREE.Group(); root.position.set(0, PG + .0003, 0); inner.add(root);
    }
    // 这一页的背面 = 下一跨页的背板（第 7 页没有背面：它不翻）
    let back = null, backRoot = null;
    if (n < SPREADS) {
      back = new THREE.Mesh(new THREE.PlaneGeometry(PW, PD), new THREE.MeshStandardMaterial({ map: texOf(backArtDefault(n + 1)), roughness: .92 }));
      back.rotation.x = Math.PI / 2; back.position.set(0, PG + (n === 1 ? .00012 : .00005), .001); back.receiveShadow = true; inner.add(back);
      // 背板上的挂件坐标系：原点 = 背板底边（书脊）中点；页立起时 +y 朝上、+z 朝镜头
      backRoot = new THREE.Group(); backRoot.position.set(0, PG + (n === 1 ? .0001 : .00003), ZH); backRoot.rotation.x = Math.PI / 2; inner.add(backRoot);
    }
    const p = { n, pivot, off, inner, floor, root, back, backRoot, isOpening: n === 1 };
    if (n > 1) { pivot.visible = false; }
    pages.push(p);
  }
  // 跨页 1 的背板 = 封面内页（开头的天幕）；挂件坐标系挂在封面铰链上
  const coverBackRoot = new THREE.Group(); coverBackRoot.position.set(0, -.0004, 0); coverBackRoot.rotation.x = Math.PI / 2; H.hinge.add(coverBackRoot);
  const spreads = [];
  for (let n = 1; n <= SPREADS; n++) {
    const pg = pages[n - 1], prev = pages[n - 2];
    const backdrop = n === 1 ? H.sky : prev.back, backRoot = n === 1 ? coverBackRoot : prev.backRoot;
    spreads[n] = {
      n, root: pg.root, floor: pg.floor, backdrop, back: backRoot, page: pg, window: spreadWindow(n), fold: foldOf(n),
      autoFold: true,   // 翻走这一页时共用层把 root 压扁（立体件"合上"）；章节要自己折就设 false
      setFloor(art) { setMap(pg.floor, art); }, setBackdrop(art) { setMap(backdrop, art); },
    };
  }
  function setMap(mesh, art) { const t = art.isTexture ? art : texOf(art); mesh.material.map = t; mesh.material.needsUpdate = true; }
  ctx.book = { group: H.book, hinge: H.hinge, spread: n => spreads[n], spreads, state: bookState, stackAngle, pageAngle, spreadAt, PG, BW, BD, ZH, PW, PD, coverCanvas: null, setCoverOverlay: null };

  // ———————————————— 台灯 ————————————————
  const lampBase = H.spot ? S.lampG.position.clone() : new THREE.Vector3();
  const head0 = S.head.clone(), aim0 = H.spot.target.position.clone(), yaw0 = S.lampG.rotation.y, color0 = H.spot.color.clone();
  ctx.lamp = { spot: H.spot, fill: H.fill, rim: H.rim, model: S.lampG, head: head0, base: lampBase, LAMP0 };

  // ———————————————— 章节图层、发布区 ————————————————
  const layers = {};
  ctx.layer = id => { if (!layers[id]) { const g = new THREE.Group(); g.name = 'layer:' + id; g.visible = false; scene.add(g); layers[id] = g; } return layers[id]; };
  const pub = {}; ctx.publish = (k, v) => { pub[k] = v; }; ctx.use = k => { if (!(k in pub)) throw new Error(`没有人发布过 "${k}"（发布方要在 build() 里 ctx.publish）`); return pub[k]; };
  ctx.has = k => k in pub;
  const resets = []; ctx.onReset = fn => resets.push(fn);   // 章节改了开头物件上"开头代码不每帧重设"的属性：登记复位（t < 20 s 时调用）
  ctx.ip = K.ip; ctx.tex = K.tex;
  const v3 = new THREE.Vector3();
  ctx.project = (x, y, z) => S.project(x, y, z);
  // 物体在屏幕上的包围框（像素，1920×1080）：给 texts() / 几何检查用
  ctx.screenBox = obj => { obj.updateWorldMatrix(true, true); const b = new THREE.Box3().setFromObject(obj, true); if (b.isEmpty()) return null;
    const xs = [], ys = []; for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) { const p = S.project(x, y, z); xs.push(p[0]); ys.push(p[1]); }
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }; };

  // ———————————————— 章节模块 ————————————————
  const MODS = {}, cams = {}, lampList = [], EVS = [];
  async function load(ids) {
    for (const id of ids) {
      const m = await import(`../chapters/${id}.js`); MODS[id] = m;
      const keys = (m.camera || []).slice().sort((a, b) => a[0] - b[0]);
      const [a0, a1] = CH[id].range;
      for (const k of keys) { if (k[0] < a0 - 1 || k[0] > a1 + 1) console.warn(`[${id}] 相机关键帧 t=${k[0]} 超出本章区间 [${a0}, ${a1}]`); if (k[1].length !== 7) throw new Error(`[${id}] 相机关键帧必须是 7 维（用 ctx.camKey / camKey()）`); }
      cams[id] = keys.length ? track(keys) : (() => DEFAULT_CAM[id]);
      for (const L of (m.lamp || [])) { if (L.t < a0 - .5 || L.t > a1) console.warn(`[${id}] 台灯 t=${L.t} 超出本章区间`); lampList.push({ ...L, chap: id }); }
    }
    for (const id of ids) {   // 按顺序 build：后面的章节可以 ctx.use() 前面章节发布的东西
      const m = MODS[id];
      ctx.id = id; ctx.root = layers[id] ? layers[id] : ctx.layer(id);
      if (m.build) await m.build(ctx);
      for (const e of (m.events ? m.events(ctx) : [])) EVS.push({ ...e, chap: id, t: +(+e.t).toFixed(4) });
    }
    ctx.id = null;
  }
  const lampP = () => lampP._ || (lampP._ = lampProgram(lampList));

  // 相机：t ≥ 20 s
  const chOf = t => { for (const id of CHAPTERS) { const [a, b] = CH[id].range; if (t >= a && t < b) return id; } return CHAPTERS[CHAPTERS.length - 1]; };
  const evalCh = (id, t) => id === 'ch1' ? S.camKey(Math.min(t, KAITOU_DUR + .2)) : cams[id](t);
  const vel = (id, t, dir) => { const h = 1 / 240, a = evalCh(id, dir < 0 ? t - h : t), b = evalCh(id, dir < 0 ? t : t + h); return a.map((x, i) => (b[i] - x) / h); };
  function camAt(t) {
    for (const B of CAM_BRIDGE) {
      const a0 = B.t - B.w0, a1 = B.t + B.w1;
      if (t >= a0 && t < a1) {
        const pA = evalCh(B.from, a0), vA = vel(B.from, a0, -1), pB = evalCh(B.to, a1), vB = vel(B.to, a1, +1);
        return hermite(pA, vA, pB, vB, (t - a0) / (a1 - a0), a1 - a0);
      }
    }
    return evalCh(chOf(t), t);
  }

  // ———————————————— 每帧 ————————————————
  // 章节 update() 的调用窗口 = live ∪ 本章各跨页的可见窗口（跨页上的纸件在本章 live 之前就可能露出来，必须每帧由本章摆好，不能留上一帧的状态）
  const active = (id, t) => { if (t < KAITOU_DUR) return false; const [a, b] = CH[id].live; if (t >= a && t < b) return true;
    return (CH[id].spreads || []).some(n => { const [w0, w1] = spreadWindow(n); return t >= w0 && t < w1; }); };
  function resetOpening() {   // 把共用层动过的东西复位到开头原值（t < 20 s 时调用）
    for (const p of pages) { p.pivot.rotation.x = 0; p.off.position.y = 0; p.pivot.visible = p.n === 1; p.root.scale.y = 1; p.floor.visible = true; }
    H.stage.scale.y = 1;
    S.lampG.rotation.y = yaw0; H.spot.position.copy(head0); H.spot.target.position.copy(aim0); H.spot.color.copy(color0);
    for (const id in layers) layers[id].visible = false;
    for (const p of pages) p.root.visible = false;   // 第 1 页新加的 root 在开头里不出现（开头自己的纸舞台 H.stage 由 S.update 管）
    for (const p of pages) if (p.backRoot) p.backRoot.visible = false;
    coverBackRoot.visible = false;
    for (const fn of resets) fn();
  }
  const yAxis = new THREE.Vector3(0, 1, 0);
  function update(t) {
    if (t < KAITOU_DUR) { resetOpening(); S.update(t); return; }
    S.update(KAITOU_DUR, camAt(t));                       // 开头物件冻结在 20.000 s 的状态，机位由共用相机给
    // —— 书 ——
    const st = stackAngle(t);
    coverBackRoot.visible = st > 2;
    H.hinge.rotation.x = -st * D2R;
    for (const p of pages) {
      const n = p.n, th = n <= 6 ? pageAngle(n, t) : 0;
      p.pivot.rotation.x = -th * D2R;
      p.off.position.y = -n * EPS * ss(clamp(th / 8));
      const [w0] = spreadWindow(n), tr = TURN(n);
      p.pivot.visible = t >= w0 && st > 2;                // 合书之后只剩封面
      const fold = foldOf(n)(t), sp = spreads[n];
      const rootOn = t >= w0 && (!tr || t < tr.t) && fold < .999;
      p.root.visible = rootOn; if (n === 1) H.stage.visible = rootOn;
      if (sp.autoFold) { const sy = Math.max(.001, 1 - fold); p.root.scale.y = sy; if (n === 1) H.stage.scale.y = sy; }
      // 背板挂件（这一页的背面 = 跨页 n+1 的背板）只在跨页 n+1 的可见窗口里出现：翻走后不再穿过后面跨页的背板（合成阶段修，ch4/ch5 需求）
      if (p.backRoot) { const [b0, b1] = spreadWindow(n + 1); p.backRoot.visible = t >= b0 && t < b1; }
    }
    coverBackRoot.visible = coverBackRoot.visible && t < spreadWindow(1)[1];
    if (st <= 2) pages[SPREADS - 1].pivot.visible = true;  // 第 7 页（书芯顶页）一直在
    // —— 台灯 ——
    const L = lampP().at(t), yaw = L.yaw * D2R;
    S.lampG.rotation.y = yaw0 + yaw;
    H.spot.position.copy(head0).sub(lampBase).applyAxisAngle(yAxis, yaw).add(lampBase);
    H.spot.target.position.set(...L.aim); H.spot.color.set(L.color);
    H.spot.intensity *= L.dim; H.fill.intensity *= L.dim; if (H.bulbMat) H.bulbMat.emissiveIntensity *= L.dim;
    // 轮廓光跟着"熄灯"走：dim ≥ 0.25（2c 月夜、木偶追光段）保持原样，低于 0.25 按比例压暗（第 58 小节第 4 拍全黑那一拍不再有亮边；ch4 需求）
    if (H.rim) H.rim.intensity *= Math.min(1, L.dim / .25);
    scene.environmentIntensity *= (L.env ?? envOf(L.dim));
    // —— 章节 ——
    for (const id of CHAPTERS) {
      const [a, b] = CH[id].live, on = t >= a && t < b;
      if (layers[id]) layers[id].visible = on;
      if (active(id, t) && MODS[id].update) { ctx.id = id; MODS[id].update(t, ctx); }
    }
    ctx.id = null;
  }

  // ———————————————— 共用事件（翻页、摊平、合书、台灯）→ events.json → mix.py 自动配声 ————————————————
  function sharedEvents() {
    const E = [];
    for (const tr of BOOK.turns) E.push({ t: tr.t, type: tr.flat ? 'book_flat' : 'page_turn', id: `book.turn.${tr.page}`, page: tr.page, spread: tr.after, swing: tr.flat ? (BOOK.FLAT_SWING ?? BOOK.FLAT_D) : BOOK.SWING, pre: BOOK.PRE, chap: 'book' });
    E.push({ t: BOOK.close, type: 'book_close', id: 'book.close', swing: BOOK.CLOSE_D, chap: 'book' });
    for (const k of lampP().list) {
      const from = lampP().at(k.t - 1e-6), to = lampP().at(k.t + (k.dur ?? .18) + 1e-6);
      if (k.sound === false) continue;
      if (k.dim !== undefined && Math.abs(to.dim - from.dim) > 1e-3) E.push({ t: k.t, type: 'lamp_dim', id: `lamp.${k.chap}.${k.t}`, from: +from.dim.toFixed(3), to: +to.dim.toFixed(3), dur: k.dur ?? .18, chap: 'book' });
      if (k.yaw !== undefined && Math.abs(to.yaw - from.yaw) > .01) E.push({ t: k.t, type: 'lamp_swivel', id: `lamp.swivel.${k.chap}.${k.t}`, dur: k.dur ?? .18, chap: 'book' });
    }
    // 台灯亮度曲线（每帧一点），给 mix.py 做灯管嗡声的"电流变化"
    const curve = []; for (let f = Math.round(KAITOU_DUR * 30); f <= Math.round(DUR * 30); f += 3) curve.push(+lampP().at(f / 30).dim.toFixed(3));
    E.push({ t: KAITOU_DUR, type: 'lamp_curve', id: 'lamp.curve', step: 3 / 30, v: curve, chap: 'book' });
    return E;
  }
  function chapterTexts(t) {
    const out = [];
    for (const id of CHAPTERS) { if (active(id, t) && MODS[id].texts) for (const x of MODS[id].texts(t, ctx) || []) out.push({ ...x, chap: id }); }
    return out;
  }
  function probe(t) { const o = { book: bookState(t), lamp: lampP().at(t) }; for (const id of CHAPTERS) if (MODS[id].probe) o[id] = MODS[id].probe(t, ctx); return o; }
  return { ctx, load, update, camAt, sharedEvents, chapterEvents: () => EVS, chapterTexts, probe, layers, spreads, pages };
}

// —— 占位的书页美术（章节用 spread.setFloor / setBackdrop 换掉）：暖色纸 + 朱红双细框，与开头天幕/地面页同一套 ——
function defaultFloorArt(seed) {
  const w = PW * A.PX, h = PD * A.PX, c = A.cv(w, h), x = c.getContext('2d');
  x.fillStyle = ['#EAD7B0', '#E9D3AC', '#EDDDBD', '#E8D6B6', '#EEDCB8', '#F1E4C8', '#F3E8D2'][seed % 7]; x.fillRect(0, 0, w, h);
  const R = A.mulberry(seed * 13);
  for (let i = 0; i < 70; i++) { const px = R() * w, py = R() * h, r = (40 + R() * 220) * w / 2400, g = x.createRadialGradient(px, py, 0, px, py, r), dk = R() < .5;
    g.addColorStop(0, dk ? `rgba(120,90,60,${.06 * R()})` : `rgba(255,255,255,${.08 * R()})`); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; x.fillRect(px - r, py - r, 2 * r, 2 * r); }
  const gg = x.createLinearGradient(0, 0, 0, .03 * A.PX); gg.addColorStop(0, 'rgba(60,40,20,.25)'); gg.addColorStop(1, 'rgba(60,40,20,0)'); x.fillStyle = gg; x.fillRect(0, 0, w, .03 * A.PX);
  x.strokeStyle = A.VERM; x.lineWidth = 8; x.strokeRect(.012 * A.PX, .012 * A.PX, w - .024 * A.PX, h - .024 * A.PX);
  x.save(); x.globalCompositeOperation = 'source-atop'; x.globalAlpha = .9; x.fillStyle = x.createPattern(A.GRAIN, 'repeat'); x.fillRect(0, 0, w, h); x.restore();
  return c;
}
function defaultBackArt(seed) {
  const w = PW * A.PX, h = PD * A.PX, c = A.cv(w, h), x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#F1D6A6'); g.addColorStop(.6, '#F5E3BE'); g.addColorStop(1, '#F7EBD2'); x.fillStyle = g; x.fillRect(0, 0, w, h);
  x.strokeStyle = A.VERM; x.lineWidth = 10; x.strokeRect(.012 * A.PX, .012 * A.PX, w - .024 * A.PX, h - .024 * A.PX);
  x.lineWidth = 3; x.strokeRect(.017 * A.PX, .017 * A.PX, w - .034 * A.PX, h - .034 * A.PX);
  x.save(); x.globalCompositeOperation = 'source-atop'; x.globalAlpha = .9; x.fillStyle = x.createPattern(A.GRAIN, 'repeat'); x.fillRect(0, 0, w, h); x.restore();
  const gg = x.createLinearGradient(0, h, 0, h - .03 * A.PX); gg.addColorStop(0, 'rgba(60,40,20,.22)'); gg.addColorStop(1, 'rgba(60,40,20,0)'); x.fillStyle = gg; x.fillRect(0, h - .03 * A.PX, w, .03 * A.PX);
  return c;
}
