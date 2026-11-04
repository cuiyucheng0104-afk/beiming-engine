// src/birds.js — 镜头 A 的鸽群（学鸠母题）：2D 剪影，一拍二
// 0.80 起被汽笛惊起：从画面下方中间（近景、画外）陆续起飞，大多数飞向右上（约 7 成），少数向左上；
// 越飞越远（变小、变淡、混进雾里）。姿态（位置、扑翼）全部按一拍二取时间（snapTime(t, 12)），确定性（固定种子）。
// 画法：深蓝灰墨色剪影 + 朝向晨光（画左）一侧的一道粉金亮边 + 翼下浅薰衣草色。
import { mulberry } from '../engine/core/math.js';
import { snapTime } from '../engine/core/clock.js';

const INK = '#2A2D52', BELLY = '#4E5888', RIM = 'rgba(255,211,176,0.9)';
const T0 = 0.8;

// 每只鸽子：起飞时刻、起点（画面比例，可在画外）、方向、速度、大小、扑翼频率
const FLOCK = (() => {
  const R = mulberry(8080);
  const b = [];
  for (let i = 0; i < 12; i++) {
    const right = i < 9;                                   // 9/12 ≈ 75% 向右
    const t0 = T0 + (i / 12) * 0.32 + R() * 0.05;
    b.push({
      t0,
      x0: 0.38 + R() * 0.28, y0: 1.08 + R() * 0.12,       // 画面下方偏中、画外
      vx: (right ? 0.17 + R() * 0.16 : -(0.08 + R() * 0.1)),   // 画面宽 / 秒
      vy: -(0.5 + R() * 0.2),                              // 先猛地上冲
      ax: (right ? 0.05 : -0.02), ay: 0.16,                // 上冲后慢慢变平（离镜头远去）
      s0: (i % 4 === 0 ? 0.1 : 0.15) + R() * 0.08,        // 初始翼展（画面高的比例，近处大）
      shrink: 0.55 + R() * 0.25,                           // 远去变小的速度
      flap: 7.5 + R() * 2.5, ph: R() * 6.28,
      tilt: (R() - 0.5) * 0.4,
    });
  }
  return b;
})();

// 一只鸽子的剪影（局部坐标：翼展 1，机头朝 +x），phase：扑翼相位 0..1（0 = 翅膀最高）
function drawPigeon(ctx, phase, dir, rimOn) {
  const up = Math.cos(phase * Math.PI * 2);                // 1 高 → -1 低
  const wingY = -0.34 * up, tipY = -0.5 * up - 0.06, fold = 0.5 + 0.5 * Math.abs(up);
  ctx.save(); ctx.scale(dir, 1);
  // 身体：纺锤 + 头 + 扇形尾
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.moveTo(0.2, -0.02);
  ctx.bezierCurveTo(0.17, -0.07, 0.05, -0.07, -0.08, -0.04);
  ctx.lineTo(-0.2, -0.05); ctx.lineTo(-0.27, 0.0); ctx.lineTo(-0.2, 0.05); ctx.lineTo(-0.08, 0.04);
  ctx.bezierCurveTo(0.05, 0.07, 0.17, 0.05, 0.2, 0.02);
  ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.arc(0.21, -0.015, 0.035, 0, 7); ctx.fill();
  // 两只翅膀：远侧翅膀略短略暗（透视），近侧翅膀完整
  const wing = (k, col) => {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(0.07, -0.01);
    ctx.bezierCurveTo(0.06, wingY * 0.6 * k, 0.0, tipY * 0.85 * k, -0.06 * fold, tipY * k);
    ctx.bezierCurveTo(-0.1, tipY * 0.7 * k, -0.08, wingY * 0.35 * k, -0.06, 0.0);
    ctx.closePath(); ctx.fill();
  };
  wing(0.8, BELLY);
  wing(1.0, INK);
  if (rimOn) {                                            // 朝光一侧（画左 = 机头后方）的亮边：只描翅膀前缘一小段
    ctx.strokeStyle = RIM; ctx.lineWidth = 0.018; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(0.07, -0.01); ctx.bezierCurveTo(0.06, wingY * 0.6, 0.0, tipY * 0.85, -0.06 * fold, tipY); ctx.stroke();
  }
  ctx.restore();
}

// 画整群：ctx 是透明画布（w×h 像素）。t 全局秒；返回画了几只
export function drawBirds(ctx, t, w, h) {
  const tq = snapTime(t, 12);                             // 一拍二时钟
  let n = 0;
  for (const b of FLOCK) {
    const u = tq - b.t0; if (u < 0 || u > 2.6) continue;
    const x = (b.x0 + b.vx * u + 0.5 * b.ax * u * u) * w;
    const y = (b.y0 + b.vy * u + 0.5 * b.ay * u * u) * h;
    const span = b.s0 * h / (1 + b.shrink * u * u * 0.55 + 0.35 * u);
    if (span < 2.5 || y < -span || x < -span || x > w + span) continue;
    const dir = b.vx >= 0 ? 1 : -1;
    const ang = Math.atan2(b.vy + b.ay * u, Math.abs(b.vx + b.ax * u)) * 0.45 + b.tilt;
    const phase = (u * b.flap + b.ph / 6.28) % 1;
    const fade = 1 - Math.min(1, Math.max(0, (u - 1.5) / 1.1)) * 0.55;   // 远去混进雾里
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.translate(x, y); ctx.rotate(dir * ang); ctx.scale(span, span);
    drawPigeon(ctx, phase, dir, span > 22);
    ctx.restore();
    n++;
  }
  return n;
}
