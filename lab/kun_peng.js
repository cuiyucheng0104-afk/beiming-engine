// 鲲鹏将化 自测页（?test=kun_peng）。背景、天空、光线、机位与 lab/kun.js 相同（共用 lab/kun_bench.js，方便和旧版横向对比）。
// DUR = 4 秒，三个机位按时间分段（同 lab/kun.js）：
//   0.0–1.5  ① 大远景侧面全身   1.5–3.0  ② 从下方仰视（镜头 C 渡船甲板机位）   3.0–4.0  ③ 眼睛特写
// 身体一拍三（8 fps），翅膀一拍二（12 fps），墨线抖动一拍二。
// 可选参数：&view=side|top|far|eye|under|reveal|hero|wing|tail（固定机位）&roll=-0.5（鲲侧倾）&look=1（眼珠看镜头）
//   &lod=0.4 &noink=1 &pass=1 &wt=<秒>（翅膀时钟固定在某一刻，调扇翅姿态用）&bt=<秒>（身体时钟固定）
import * as THREE from 'three';
import { createKun } from '../src/kun_peng.js';
import { PALETTE, setToonGlobals } from '../src/toon.js';
import { heldTime } from '../engine/core/clock.js';
import { labRenderer, kunStats, keyLight, inkComposite, BASE_VIEWS, baseExtra, pickView, eyeCloseup, frameTimes, drawPasses } from './kun_bench.js';

const q = new URLSearchParams(location.search);
const ROLL = +(q.get('roll') || 0), LOOK = !!q.get('look');
const { renderer, W, H, RW, RH } = labRenderer(2);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, W / H, 5, 6000);
const t0 = performance.now();
const kun = createKun({ lod: +(q.get('lod') || 1) });
console.warn(`[kun_peng] 构建 ${(performance.now() - t0).toFixed(0)} ms，描边网格 ${kun.outlineMeshes.length} 个`);
kunStats('kun_peng', kun);
scene.add(kun.group);

// 主光：破晓地平线低角度逆光（同 lab/kun.js）；合成：同 lab/kun.js 的屏幕空间描边 + 空气透视
const { key } = keyLight(scene, setToonGlobals);
const { rtC, rtN, comp, skyCover } = await inkComposite({ RW, RH, W, H, PALETTE, q });

// 固定机位（前六个与 lab/kun.js 相同；hero / wing / tail 是本变体新增的）
const ev = new THREE.Vector3();
const EXTRA = {
  ...baseExtra(ev),
  // 海报帧：侧下方略偏前，鲲向镜头侧倾 0.5 弧度——远侧翅膀从背后举起、近侧翅膀横在身前（设定图的构图），翅膀在下扑起始的展开位
  hero: { fov: 40, sky: [1.2, 0.45, 0.45], cam: k => [120, -60, -700], look: k => [-70, 50, 0], roll: -0.5, wt0: 0, bt0: 0.5 },
  wing: { fov: 30, sky: [1.4, 0.5, 0.3], cam: k => [60, 260, -360], look: k => [40, 80, -150] },
  tail: { fov: 30, sky: [1.4, 0.6, 0.6], cam: k => [-260, -40, -420], look: k => [-300, 10, 0] },
};
// &cam=x,y,z&at=x,y,z&fov=f&sky=zoom,ox,oy：自由机位（找海报角度用）
if (q.has('cam')) {
  const c = q.get('cam').split(',').map(Number), a = (q.get('at') || '0,0,0').split(',').map(Number);
  EXTRA.custom = { fov: +(q.get('fov') || 32), sky: (q.get('sky') || '1.2,0.5,0.5').split(',').map(Number), cam: () => c, look: () => a };
}
kun.group.rotation.x = ROLL;
kun.fitShadow(key, { size: 4096 });
const forced = EXTRA[q.get('view')];
const WT = q.has('wt') ? +q.get('wt') : null, BT = q.has('bt') ? +q.get('bt') : null;

window.DUR = 4;
window.render = t => {
  const { v, k } = pickView(BASE_VIEWS, forced, t, window.DUR);
  const { fr, ts: tb, inkT } = frameTimes(t);
  const ts = BT ?? tb + (v.bt0 || 0);                       // 身体：一拍三（8 fps）
  const tw = WT ?? heldTime(fr, 2) + (v.wt0 || 0);          // 翅膀：一拍二（12 fps）
  kun.group.rotation.x = q.has('roll') ? ROLL : (v.roll || 0);
  camera.fov = v.fov; camera.updateProjectionMatrix();
  kun.setPose(ts, { wingT: tw });
  kun.group.updateMatrixWorld(true); kun.eyeWorld(ev, -1);
  if (v.cam) { camera.position.set(...v.cam(k)); camera.lookAt(...v.look(k)); }
  else eyeCloseup(camera, kun, ev, k);
  if (LOOK) kun.setPose(ts, { wingT: tw, look: camera.position });
  skyCover(...v.sky);
  drawPasses({ renderer, scene, camera, comp, rtC, rtN, setToonGlobals, inkT });
};
// 性能：连渲 n 帧（每帧 readPixels 强制同步），返回每帧毫秒
window.bench = (n = 24, tStart = 0) => {
  const px = new Uint8Array(4), gl = renderer.getContext(), out = [];
  for (let i = 0; i < n; i++) { const a = performance.now(); window.render(tStart + i / 24); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); out.push(performance.now() - a); }
  const pose = []; for (let i = 0; i < n; i++) { const a = performance.now(); kun.setPose(i / 8, { wingT: i / 12 }); pose.push(performance.now() - a); }
  return { frame: out.reduce((s, x) => s + x, 0) / n, pose: pose.reduce((s, x) => s + x, 0) / n };
};
const tw0 = performance.now();
window.render(0); window.render(1.6); window.render(3.2);
console.warn(`[kun_peng] 预热（含着色器编译）${(performance.now() - tw0).toFixed(0)} ms`);
window.READY = true;
