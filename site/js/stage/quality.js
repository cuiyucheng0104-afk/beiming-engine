// 舞台画质：按设备选初始档位，运行时按帧时间自适应调像素比；另有一个很短的 CPU 探针，用来预估建鲲要占多久主线程。
//
//   pickTier(quality, { w, h }?) → { name, mobile, prCap, ladder, lod, shadow, msaa, adaptive }
//     quality: 'auto' | 'high' | 'low'；w, h 是画布的布局尺寸（CSS 像素，默认视口），用来算超采样的像素预算。
//     桌面：像素比上限 1.5。1 倍屏也往上超采样：墨线是后期按深度、法线、物体编号算出来的，MSAA 管不到，
//           像素比 1 时下颌、鳍边的墨线成阶梯。超采样后的像素量不超过 2160×1350（QA 实测 60 fps 的
//           MacBook 视网膜屏 1440×900×1.5 的量），所以 1440×900 的 1 倍屏是 1.5，1080p 外接屏约 1.19，
//           2560×1440 的 1 倍屏仍是 1；2 倍屏照旧 1.5。
//     手机：上限 min(dpr, 1.5)，阶梯 [1.5, 1.25, 1, 0.85]。3 倍屏上 1 倍像素会把画布拉伸三倍，鱼头、须子、
//           鳍边全是锯齿，比海报还糊；跑不动由降档兜底（未在真机上测过帧率，见汇报）。
//   createGovernor(tier, onChange) → { frame(dtMs, now, drawMs), reset(), pr, step, ema, drawEma, log }
//     调用方每帧在绘制之前调 frame（FINAL-10）：onChange 里改像素比会改画布尺寸、清空绘图缓冲，画完再改就会空白一帧。
//     所以 drawMs 传的是上一帧绘制的主线程耗时。
//     降档：帧间隔（平滑后）连续 1 秒 > 22 ms → 降一档；降档后先稳 1.5 秒再看。
//     升档：帧间隔稳定在刷新节奏（< 17.5 ms，没有掉帧），且每帧绘制的主线程耗时 < 9 ms，连续 5 秒 → 试升一档。
//           试用 4 秒内只要连续 0.5 秒 > 20 ms 就退回，这一档的重试等待翻倍（10 秒起，最长 2 分钟），不会来回抖。
//           以前的条件是平滑帧间隔 < 13 ms，而舞台最多画约 60 帧每秒（帧间隔 ≥ 16.7 ms），一次卡顿降档后再也升不回来。
//   cpuProbe(reps) → 毫秒：一小段和建鲲同类的几何计算（three 生成几何体、算法线、合并），跑 reps 遍取平均，按比例预估建鲲耗时。
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const SS_BUDGET = 2160 * 1350;          // 超采样的像素预算（画布实际像素）
const DESK_STEPS = [1.25, 1, 0.85, 0.7];
const MOBILE_STEPS = [1.25, 1, 0.85];

export function isMobile() {
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const small = Math.min(screen.width || 0, screen.height || 0) < 820;
  const ua = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
  return (coarse && small) || (ua && small);
}

const r2 = x => Math.round(x * 100) / 100;
// 阶梯：第一档是上限，后面只留明显低于上限的档（差不到 0.05 的不算一档）
const ladderFrom = (cap, steps) => [cap, ...steps.filter(v => v < cap - 0.05)];

export function pickTier(quality = 'auto', { w = window.innerWidth, h = window.innerHeight } = {}) {
  const mobile = isMobile();
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  if (quality === 'low') {
    const pr = Math.min(dpr, 1);
    return { name: 'low', mobile, prCap: pr, ladder: [pr, 0.8, 0.67].filter(v => v <= pr), lod: 0.3, shadow: 1024, msaa: 2, adaptive: true };
  }
  if (mobile) {
    const cap = r2(Math.min(dpr, 1.5));
    return { name: quality === 'high' ? 'high' : 'mobile', mobile, prCap: cap, ladder: ladderFrom(cap, MOBILE_STEPS), lod: 0.3, shadow: 1024, msaa: 4, adaptive: quality !== 'high' };
  }
  const ss = Math.sqrt(SS_BUDGET / Math.max(1, w * h));
  const cap = r2(Math.min(1.5, Math.max(Math.min(dpr, 1.5), ss)));
  // lod 0.75：首屏尺寸下与 lod 1 看不出差别（实测 63.7 万对 78.3 万三角形），给帧率留余量
  return { name: quality === 'high' ? 'high' : 'desktop', mobile, prCap: cap, ladder: ladderFrom(cap, DESK_STEPS), lod: quality === 'high' ? 1 : 0.75, shadow: 2048, msaa: 4, adaptive: quality !== 'high' };
}

export function createGovernor(tier, onChange) {
  const ladder = tier.ladder;
  let step = 0, ema = 16.7, drawEma = 4, slowSince = -1, fastSince = -1, hold = 0, last = -1, trialUntil = -1;
  const wait = ladder.map(() => 10000);          // 升回这一档之前要等的时间（试失败一次翻倍）
  const retryAt = ladder.map(() => 0);
  const log = [];

  function change(to, now, dir) {
    step = to; last = now; slowSince = fastSince = -1;
    log.push({ t: Math.round(now), pr: ladder[step], dir });
    if (log.length > 40) log.shift();
    onChange(ladder[step], step, dir);
  }

  function frame(dt, now, drawMs = -1) {
    if (!tier.adaptive || !(dt > 0)) return;
    ema += (Math.min(dt, 120) - ema) * 0.12;
    if (drawMs >= 0) drawEma += (Math.min(drawMs, 60) - drawEma) * 0.1;
    if (now < hold) { slowSince = fastSince = -1; return; }
    const trial = now < trialUntil;
    if (ema > (trial ? 20 : 22)) {
      fastSince = -1;
      if (slowSince < 0) slowSince = now;
      if (now - slowSince > (trial ? 500 : 1000) && step < ladder.length - 1) {
        // 撑不住当前这一档：记下多久以后才能再试它（刚升上来就撑不住的，等待翻倍）
        if (trial) wait[step] = Math.min(wait[step] * 2, 120000);
        retryAt[step] = now + wait[step];
        trialUntil = -1; hold = now + 1500;
        change(step + 1, now, 'down');
      }
      return;
    }
    slowSince = -1;
    if (step > 0 && !trial && ema < 17.5 && drawEma < 9 && now >= retryAt[step - 1]) {
      if (fastSince < 0) fastSince = now;
      if (now - fastSince > 5000 && now - last > 8000) {
        hold = now + 600; trialUntil = now + 600 + 4000;
        change(step - 1, now, 'up');
      }
    } else fastSince = -1;
  }

  return {
    frame,
    reset() { slowSince = fastSince = -1; ema = 16.7; },
    get pr() { return ladder[step]; },
    get step() { return step; },
    get ema() { return ema; },
    get drawEma() { return drawEma; },
    get log() { return log.slice(); },
  };
}

// CPU 探针：生成几个环面结几何体、重算法线、转成非索引再合并（建鲲的大头也是 three 的几何生成、法线和合并）。
// 一遍在 M5 Pro 上热身后约 3 ms（第一遍含 JIT 编译约 15 ms）；Safari 的计时精度是 1 ms，所以调用方热身之后每次跑 3 遍。
// 返回每遍的毫秒数，调用方按标定比例换算成建鲲耗时。
export function cpuProbe(reps = 1) {
  const t0 = performance.now();
  for (let r = 0; r < reps; r++) {
    const parts = [];
    for (let i = 0; i < 3; i++) {
      const g = new THREE.TorusKnotGeometry(10, 3 + i * 0.4, 110, 16, 2, 3 + i);
      g.computeVertexNormals();
      parts.push(g.toNonIndexed());
      g.dispose();
    }
    const merged = mergeGeometries(parts);
    merged.computeVertexNormals();
    merged.computeBoundingSphere();
    parts.forEach(g => g.dispose()); merged.dispose();
  }
  return (performance.now() - t0) / reps;
}
