// 角色设定表：index.html?test=model（全部皮影 + 关键姿势，用真实的合成器渲染）
import { drawWukong } from './wukong.js';
import { drawRobed, drawSkeleton, drawPile, drawCloudP, drawPaper } from './robed.js';
import { drawRods, rodEnds, rivets, layer } from './rig.js';

const cam = (k, x, y) => [k, 0, 0, k, x, y];
export function modelSheet(tr, fr, v = '1') {
  const W = 1920, H = 1080;
  tr.setTransform(1, 0, 0, 1, 0, 0); tr.fillStyle = '#fff'; tr.fillRect(0, 0, W, H);
  fr.setTransform(1, 0, 0, 1, 0, 0); fr.clearRect(0, 0, W, H);
  const label = (x, y, s, size = 26) => { fr.save(); fr.font = `400 ${size}px "Ma Shan Zheng"`; fr.fillStyle = '#2b170d'; fr.textAlign = 'center'; fr.fillText(s, x, y); fr.restore(); };
  const put = (fn) => { const r = fn(); if (r && r.riv) rivets(tr, r.riv, r.K); if (r && r.rods) drawRods(tr, r.rods, rodEnds(r.rods, r.K * .5), 2, .55); };
  if (v === '1') {
    const k = .78, gy = 1010;
    // 悟空：站、搭凉棚、举棒、跪
    put(() => drawWukong(tr, cam(k, 0, 0), { x: 150 / k, plant: gy / k - 6, staff: { a: -1.35, f: .5, len: 300 }, fT: [44, 66], hF: -.3, bT: [-20, 98] }));
    put(() => drawWukong(tr, cam(k, 0, 0), { x: 400 / k, plant: gy / k - 6, fT: [34, -34], hF: -1.9, handF: 'flat', head: -.08, lean: .1, lF: [-.5, .5], lB: [.3, .3], staff: null, bT: [-20, 80] }));
    put(() => drawWukong(tr, cam(k, 0, 0), { x: 650 / k, plant: gy / k - 6, staff: { a: -.05, f: .5, len: 300 }, fT: [0, -118], hF: .2, twoHand: .28, lF: [-.6, .7], lB: [.5, .4], lean: -.08, head: -.1 }));
    put(() => drawWukong(tr, cam(k, 0, 0), { x: 880 / k, plant: gy / k - 6, lF: [-1.45, 1.5], lB: [.05, 1.62], lean: .5, head: .25, fT: [40, 70], bT: [30, 80], handF: 'flat', handB: 'flat', staff: null }));
    label(150, 60, '悟空·立'); label(400, 60, '搭凉棚'); label(650, 60, '举棒'); label(880, 60, '跪拜');
    // 唐僧、村姑、老妇、老翁
    put(() => drawRobed(tr, cam(k, 0, 0), 'tang', { x: 1080 / k, y: gy / k, fT: [46, 6], hF: -1.3, handF: 'flat', bT: [-12, 98] }));
    put(() => drawRobed(tr, cam(k, 0, 0), 'girl', { x: 1300 / k, y: gy / k, flip: -1, fT: [36, 52], basketA: 0, bT: [-16, 96] }));
    put(() => drawRobed(tr, cam(k, 0, 0), 'crone', { x: 1520 / k, y: gy / k, flip: -1, lean: .32, head: -.2, fT: [34, 70], caneA: 1.35, caneLen: 180, bT: [-14, 86] }));
    put(() => drawRobed(tr, cam(k, 0, 0), 'elder', { x: 1740 / k, y: gy / k, flip: -1, fT: [30, 40], caneA: 1.48, caneLen: 205, bT: [-12, 88], handB: 'fist' }));
    label(1080, 60, '唐僧'); label(1300, 60, '村姑'); label(1520, 60, '老妇'); label(1740, 60, '老翁');
    return { lamps: [[480, 420, 1.1, .9], [1440, 420, 1.1, .9]], sigB: 900, sigC: 160, amb: .45, expo: 1.3, cam: [960, 540, 1], vign: .25, sat: 1.1, contrast: .12, bloom: .2 };
  }
  // v2：白骨、X 光、骨堆、云、贬书、特写
  const gy = 1000;
  put(() => drawRobed(tr, cam(.9, 0, 0), 'girl', { x: 200 / .9, y: gy / .9, flip: -1, fT: [30, 50] }));
  drawSkeleton(tr, cam(.9, 0, 0), { x: 200 / .9, y: gy / .9, flip: -1 });
  drawSkeleton(tr, cam(.9, 0, 0), { x: 470 / .9, y: gy / .9, flip: -1 });
  drawPile(tr, cam(1.3, 0, 0), 800 / 1.3, 980 / 1.3);
  drawCloudP(tr, cam(1, 0, 0), 800, 420, 1.2);
  drawPaper(tr, cam(1.4, 0, 0), 1080 / 1.4, 300 / 1.4, .1);
  // 大特写：悟空头、唐僧头
  put(() => drawWukong(tr, cam(2.6, 0, 0), { x: 1320 / 2.6, y: 700 / 2.6, staff: null, fT: [10, 96] }));
  put(() => drawRobed(tr, cam(2.2, 0, 0), 'tang', { x: 1690 / 2.2, y: 1330 / 2.2 }));
  label(200, 60, 'X 光（村姑 + 白骨）'); label(470, 60, '白骨真身'); label(800, 200, '筋斗云'); label(800, 1060, '白骨夫人'); label(1080, 420, '贬书');
  return { lamps: [[480, 420, 1.1, .9], [1440, 420, 1.1, .9]], sigB: 900, sigC: 160, amb: .45, expo: 1.3, cam: [960, 540, 1], vign: .25, sat: 1.1, contrast: .12, bloom: .2 };
}
