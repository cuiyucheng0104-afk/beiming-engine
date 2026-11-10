// 青铜古鲲自测页（?test=kun_bronze）。背景、天空、主光、城市光、机位与 lab/kun.js 完全相同（共用 lab/kun_bench.js），方便横向对比：
//   0.0–1.5  ① 大远景侧面全身（镜头 C 的朝向：头朝画左，逆光从画左后方来）
//   1.5–3.0  ② 从下方仰视腹部和头（镜头 C 渡船甲板机位）
//   3.0–4.0  ③ 眼睛特写
// 描边：临时屏幕空间描边（深度 + 法线 + 物体/实例 ID，按一拍二抖动），与 lab/kun.js 同一段代码，只为看效果。
// 可选参数：&lod=0.3 &noink=1 &pass=1 &view=side|top|far|eye|under|reveal|hero|hero_full|hero_low|front|tail &roll=-0.5 &look=1（玉眼看镜头）
//   &dbg=pattern（不渲染 3D，直接看身体纹样展开图）&dbg=fins（看各类鳍的离缘距离场）
import * as THREE from 'three';
import { createKun } from '../src/kun_bronze.js';
import { PALETTE, setToonGlobals } from '../src/toon.js';
import { labRenderer, kunStats, keyLight, inkComposite, BASE_VIEWS, baseExtra, pickView, eyeCloseup, frameTimes, drawPasses } from './kun_bench.js';

const q = new URLSearchParams(location.search);
const ROLL = +(q.get('roll') || 0), LOOK = !!q.get('look');
const W = innerWidth, H = innerHeight;
const t0 = performance.now();
const kun = createKun({ lod: +(q.get('lod') || 1) });
console.warn(`[kun_bronze] 构建 ${(performance.now() - t0).toFixed(0)} ms ${JSON.stringify(kun.debug.timings)}，描边网格 ${kun.outlineMeshes.length} 个，${JSON.stringify(kun.debug.counts)}`);

// —— 调试：2D 看纹样展开图 / 鳍的距离场 ——
const DBG = q.get('dbg');
if (DBG) {
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; document.body.appendChild(cv);
  const g = cv.getContext('2d');
  g.fillStyle = '#1b1d24'; g.fillRect(0, 0, W, H);
  if (DBG === 'pattern') {
    const P = kun.debug.pattern, w0 = P.band.width, h0 = P.band.height, sc = Math.min(W / w0, H / h0), dw = w0 * sc, dh = h0 * sc;
    const layer = (c, col, op) => { const t = document.createElement('canvas'); t.width = w0; t.height = h0; const tg = t.getContext('2d'); tg.drawImage(c, 0, 0); tg.globalCompositeOperation = 'multiply'; tg.fillStyle = col; tg.fillRect(0, 0, w0, h0); g.globalCompositeOperation = 'lighter'; g.globalAlpha = op; g.drawImage(t, 0, 0, dw, dh); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; };
    layer(P.zone, '#2a8f84', 0.8); layer(P.band, '#d8c49a', 1); layer(P.jade, '#ffffff', 1); layer(P.groove, '#ff3030', 1);
    // 背中线 / 腹中线
    const PRM = kun.debug.PRM, PAT = kun.debug.PAT;
    g.strokeStyle = '#9fe8ff'; g.lineWidth = 1; g.beginPath();
    for (let x = -192; x <= 303; x += 2) { const u = PRM.Ux(x) * PAT.K * sc, v = (PAT.smax - PRM.st(x)) * PAT.K * sc; x === -192 ? g.moveTo(u, v) : g.lineTo(u, v); }
    for (let x = 303; x >= -192; x -= 2) { const u = PRM.Ux(x) * PAT.K * sc, v = (PAT.smax + PRM.sb(x)) * PAT.K * sc; g.lineTo(u, v); }
    g.stroke();
  } else {
    const F = kun.debug.finFields; let x = 10;
    for (const k in F) { const c = F[k], s = Math.min(1, (H - 20) / c.height, 600 / c.width); g.drawImage(c, x, 10, c.width * s, c.height * s); g.fillStyle = '#fff'; g.fillText(k, x + 4, 24); x += c.width * s + 12; }
  }
  window.DUR = 1; window.render = () => {}; window.READY = true;
  await new Promise(() => {});   // 调试模式到此为止：模块停在这里，不再建 3D 场景
}

const { renderer, RW, RH } = labRenderer(2);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, W / H, 5, 6000);
kunStats('kun_bronze', kun);
scene.add(kun.group);

const { key } = keyLight(scene, setToonGlobals);
const { rtC, rtN, comp, skyCover } = await inkComposite({ RW, RH, W, H, PALETTE, q });

const ev = new THREE.Vector3();
const EXTRA = {
  ...baseExtra(ev),
  // 海报帧：前方 3/4 略仰的「肖像」——下撇的厚唇挂着垂苔、玉眼直视镜头（AR 里「它看见你了」）、背上苔藓花与戈形背鳍剪影
  hero: { fov: 31, sky: [1.25, 0.4, 0.6], cam: k => [600 - 10 * k, -110, -360], look: k => [130, 4, 0], eyeContact: true },
  hero_full: { fov: 30, sky: [1.25, 0.42, 0.62], cam: k => [470 - 20 * k, -170, -560 + 10 * k], look: k => [70, 22, 0] },
  hero_low: { fov: 34, sky: [1.3, 0.45, 0.7], cam: k => [430 - 10 * k, -250, -390], look: k => [110, 12, 0], eyeContact: true },
  front: { fov: 34, sky: [1.3, 0.5, 0.6], cam: k => [560, -60, -260], look: k => [120, 10, 0] },
  tail: { fov: 34, sky: [1.3, 0.5, 0.6], cam: k => [-520, -80, -420], look: k => [-120, 0, 0] },
};
kun.group.rotation.x = ROLL;
kun.fitShadow(key, { size: 4096 });
const forced = EXTRA[q.get('view')];

window.DUR = 4;
window.render = t => {
  const { v, k } = pickView(BASE_VIEWS, forced, t, window.DUR);
  const { ts, inkT } = frameTimes(t);                       // 鲲：一拍三（8 fps）；墨线一拍二
  camera.fov = v.fov; camera.updateProjectionMatrix();
  kun.group.updateMatrixWorld(true); kun.eyeWorld(ev, -1);
  if (v.cam) { camera.position.set(...v.cam(k)); camera.lookAt(...v.look(k)); }
  else eyeCloseup(camera, kun, ev, k);
  kun.setPose(ts, LOOK || v.eyeContact ? { look: camera.position } : {});
  skyCover(...v.sky);
  drawPasses({ renderer, scene, camera, comp, rtC, rtN, setToonGlobals, inkT });
};
const tw = performance.now();
window.render(0); window.render(1.6); window.render(3.2);
console.warn(`[kun_bronze] 预热（含着色器编译）${(performance.now() - tw).toFixed(0)} ms`);
window.READY = true;
