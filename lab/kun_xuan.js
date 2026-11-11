// 玄鲲（玄鲲云纹变体）自测页（?test=kun_xuan）。背景、天空、光线、机位、描边合成与 lab/kun.js 相同（共用 lab/kun_bench.js），方便横向对比。
// DUR = 4 秒，默认三段：0.0–1.5 大远景侧面；1.5–3.0 从下方仰视（镜头 C 渡船甲板机位）；3.0–4.0 眼睛特写。
// 停帧：身体一拍三（ts 由帧号量化）；飘带 / 须 / 背鳍一拍二（setPose 第二参数给原始时间 t，模块内部量化）。
// 可选参数：&view=side|top|far|eye|under|reveal|poster|tail|front（固定机位）&lod=0.5 &noink=1 &pass=1
//   &roll= &yaw= &pitch=（鲲整体转角，弧度）&look=1（眼珠看镜头）&check=1（飘带 / 须 / 背鳍穿插自检，结果打在控制台）
import * as THREE from 'three';
import { createKun } from '../src/kun_xuan.js';
import { PALETTE, setToonGlobals } from '../src/toon.js';
import { labRenderer, kunStats, keyLight, BASE_VIEWS, baseExtra, pickView, eyeCloseup, frameTimes, labPipeline, labPixelRatio } from './kun_bench.js';

const q = new URLSearchParams(location.search);
const ROLL = +(q.get('roll') || 0), YAW = +(q.get('yaw') || 0), PITCH = +(q.get('pitch') || 0), LOOK = !!q.get('look');
const { renderer, W, H, RW, RH } = labRenderer(labPixelRatio(q));

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, W / H, 5, 6000);
const t0 = performance.now();
const kun = createKun({ lod: +(q.get('lod') || 1) });
console.warn(`[kun_xuan] 构建 ${(performance.now() - t0).toFixed(0)} ms，描边网格 ${kun.outlineMeshes.length} 个`);
kunStats('kun_xuan', kun, `；飘带 ${kun.ribbons.length} 条`);
scene.add(kun.group);
// 调试：&hide=ribbon,barbel,dorsal,flakes,eye（按网格名包含的字串隐藏）
if (q.get('hide')) { const hs = q.get('hide').split(','); kun.group.traverse(o => { if (o.isMesh && hs.some(h => o.name.includes(h))) o.visible = false; }); }

const { key } = keyLight(scene, setToonGlobals);
if (q.get('city')) setToonGlobals({ fillGain: +q.get('city') });   // 调试：城市暖光倍率
if (q.get('skyg')) setToonGlobals({ skyGain: +q.get('skyg') });    // 调试：天空冷光倍率
if (q.get('noshadow')) key.castShadow = false;

const { skyCover, draw } = await labPipeline({ renderer, scene, W, H, RW, RH, PALETTE, q });   // 默认正片后期；&ink=lab 回退临时描边

// 机位：与 lab/kun.js 相同（横向对比用）；poster / tail / front 是本变体加的
const ev = new THREE.Vector3();
const EXTRA = {
  ...baseExtra(ev),
  poster: { fov: 34, sky: [1.25, 0.42, 0.62], cam: k => [430, -210, -560], look: k => [-70, -10, 0] },
  tail: { fov: 34, sky: [1.2, 0.6, 0.5], cam: k => [-300, -60, -620], look: k => [-330, -10, 0] },
  front: { fov: 30, sky: [1.4, 0.5, 0.7], cam: k => [760, -120, -420], look: k => [60, -10, 0] },
};
kun.group.rotation.set(ROLL, YAW, PITCH, 'YZX');
kun.fitShadow(key, { size: 4096 });
if (q.get('noshadow')) key.castShadow = false;
// 调试：自定义机位 &cam=x,y,z&at=x,y,z&fov=30&sky=zoom,ox,oy
if (q.get('cam')) EXTRA.custom = { fov: +(q.get('fov') || 30), sky: (q.get('sky') || '1.2,0.5,0.6').split(',').map(Number), cam: k => q.get('cam').split(',').map(Number), look: k => (q.get('at') || '0,0,0').split(',').map(Number) };
const forced = EXTRA[q.get('cam') ? 'custom' : q.get('view')];

if (q.get('check')) {
  const times = []; for (let f = 0; f < 120; f++) times.push(f / 24 * 2);     // 0–10 秒，每 2 帧一次
  const tc = performance.now(), r = kun.checkClearance(times);
  console.warn(`[kun_xuan] 穿插自检（${times.length} 个时刻，${(performance.now() - tc).toFixed(0)} ms）：飘带/须/背鳍两两最小间距 ${r.minPair.toFixed(2)}（${r.pair}）；扎进身体的采样点 ${r.bodyHits} 个 ${r.worst}`);
}

window.DUR = 4;
let tAcc = 0, nAcc = 0;
window.render = t => {
  const tw0 = performance.now();
  const { v, k } = pickView(BASE_VIEWS, forced, t, window.DUR);
  const { fr, ts, inkT } = frameTimes(t);                       // 身体：一拍三；墨线一拍二
  camera.fov = v.fov; camera.updateProjectionMatrix();
  kun.group.updateMatrixWorld(true); kun.eyeWorld(ev, -1);
  if (v.cam) { camera.position.set(...v.cam(k)); camera.lookAt(...v.look(k)); }
  else eyeCloseup(camera, kun, ev, k);
  camera.updateMatrixWorld();
  kun.setPose(ts, LOOK ? { look: camera.position, t } : { t });   // 飘带一拍二：给原始时间
  skyCover(...v.sky);
  draw({ camera, setToonGlobals, inkT, fr });
  tAcc += performance.now() - tw0; nAcc++;
  if (nAcc % 24 === 0) console.warn(`[kun_xuan] 平均每帧 CPU 提交 ${(tAcc / nAcc).toFixed(1)} ms（${nAcc} 帧）`);
};
const tw = performance.now();
window.render(0); window.render(1.6); window.render(3.2);
console.warn(`[kun_xuan] 预热（含着色器编译）${(performance.now() - tw).toFixed(0)} ms`);
window.READY = true;
