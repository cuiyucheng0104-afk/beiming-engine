// S18 见龙（176.0–188.0）
// 1) 0–2.6 s：S17 的水墨原画（图 18）被墨洞从中心吃开，刻线龙山（图 19）从洞里浮出；S17 的「心 / 白石立约 / 闪」版式随水墨一起退去。
// 2) 全段：纵深上升推近（参照纵深样片第三镜：sy 由正到负 = 机位上升，push 0→0.07 = 近景人比远山放大得快）。
// 3) 镜片框描出 → 依次标出六部件：角、眼、心、脊、鳞、爪（扫描角框收拢 + 嘀 → 圆点 + 引线 + 标签逐字打出）。
//    「鳞」字落在旁白念到「鳞」的那一刻（4.76 s）。标签位置全部用 P.toScreen 跟着画面走。
// 4) 9.0 s 标签收起，9.35 s 镜片框退去，最后只剩人与龙山，相机缓停，交给 S19。
// 时刻全部来自 sfx/S18.json（画面与音效同源）。
import { clamp, seg, eo, eio, ss } from '/core/lib.js';

export const uses = ['p19'];
// 返修第 9 条：原来 10 s 里 zoom 只从 1.09 到 1.15、cy 只走 25 px，看不出"纵深上升推近"。
// 现在一条长运动贯穿全段：机位从低处一路上升（取景中心 cy 620 → 470，画面整体下沉 = 镜头往上走），同时推近（zoom 1.08 → 1.34），
// 纵深视差 sy +34 → −30、push 0 → 0.10（近景的人和石头比远处龙山放大、位移得快，层次拉开）。前 2.6 s 先快一点（水墨退去时已在上升），之后缓推到停。
const A = { cx: 960, cy: 620, zoom: 1.08, sx: 0, sy: 34, push: 0.0 };   // 起：低机位，近景前压
const B = { cx: 960, cy: 470, zoom: 1.34, sx: 0, sy: -30, push: 0.10 }; // 推到位（= 交接相机）
function camAt(lt, api) {
  const u = seg(lt, 0, 12), p = 0.55 * eo(seg(lt, 0, 6)) + 0.45 * eio(u);   // 起步就动、全程不停、段尾缓停
  return { cx: 960, cy: A.cy + (B.cy - A.cy) * p, zoom: Math.exp(Math.log(A.zoom) + Math.log(B.zoom / A.zoom) * p), sx: 0, sy: A.sy + (B.sy - A.sy) * p, push: B.push * p, depth: 1 };
}
// 交接：S19 第一帧 = 图 19、相机 B、无镜片、无标签
export const exit = () => ({ plate: 'p19', cam: B });

// 六部件：at = 原图坐标的锚点；off = 标签框中心相对锚点的屏幕偏移
const PARTS = [
  { id: 'jiao', ch: '角', at: [1150, 105], off: [100, 34] },    // 右角根
  { id: 'yan',  ch: '眼', at: [1100, 246], off: [112, 34] },    // 右眼
  { id: 'xin',  ch: '心', at: [1010, 505], off: [104, -36] },   // 胸口（人头顶上方）
  { id: 'ji',   ch: '脊', at: [560, 400],  off: [-60, -88] },   // 左侧龙背山脊（红色火线）
  { id: 'lin',  ch: '鳞', at: [1500, 640], off: [44, -92] },    // 右侧梯田（鳞甲）
  { id: 'zhua', ch: '爪', at: [600, 800],  off: [-30, -96] },   // 左下山脚
];
const SIZE = 34;

export function render(lt, api) {
  const { P, ui, C, ctx } = api, c = id => api.cue(id).t, prev = api.prevExit();
  const cam = camAt(lt, api);
  api.clear('ink');

  // ① 水墨退去，刻线回来
  // 不用 ink.recede 的默认节奏（它的 eio 曲线把墨洞从出现到吃满压在约 0.4 s 内）：这里同样的两层画法，
  // 但遮罩阈值线性推进 2.4 s，墨洞从白石处（水墨图坐标）先开、一圈圈吃开，中段停留看得见，洞口带墨晕。
  const tr = c('recede'), k = seg(lt, tr + 0.2, tr + 2.6);
  if (prev && prev.plate && k < 1) {
    P.draw('p19', cam, { alpha: clamp(k * 4) });
    P.draw(prev.plate, prev.cam, { mask: { p: -0.35 + 1.75 * k, scale: 120, soft: 0.05, seed: 9, radial: 0.7, center: [1000, 500], rim: 1.0 } });
  } else P.draw('p19', cam);
  if (prev && k < 1) flashTitleOut(ui, ctx, prev, 1 - ss(seg(k, 0, 0.45)));

  // ② 镜片框描出（框外压暗），9.35 s 起退去
  const tl = c('lens'), tc = c('corner'), toff = c('lens_off');
  const lensA = 1 - ss(seg(lt, toff, toff + 1.0));
  ui.lens({ k: eio(seg(lt, tl, tl + 1.0)), corners: eo(seg(lt, tc, tc + 0.35)), darkK: ss(seg(lt, tl, tl + 1.2)), alpha: lensA });

  // ③ 六部件依次标出
  const tout = c('labels_out');
  PARTS.forEach((p, i) => {
    const ev = api.cue(p.id), tb = api.cue(p.id + '_b').t, outT = tout + i * 0.06;
    const fade = 1 - clamp((lt - outT) / 0.25);
    if (lt < tb || fade <= 0) return;
    const [ax, ay] = P.toScreen('p19', cam, p.at[0], p.at[1]);
    // 扫描角框：嘀一声起从外收拢到锚点（收拢完成 = 标签出现）
    const kc = seg(lt, tb, ev.t);
    ui.corners([ax - 26, ay - 26, ax + 26, ay + 26], kc, { alpha: fade * (1 - ss(seg(lt, ev.t + 0.25, ev.t + 0.7))), len: 13, w: 2 });
    if (lt < ev.t) return;
    const kb = clamp((lt - ev.t) / 0.25);
    ring(ctx, C, ax, ay, 7, kb, fade);
    // 标签框：中心 = 锚点 + off；ui.label 的 (x, y) 是字的左下基线
    const bx = ax + p.off[0], by = ay + p.off[1];
    const box = ui.label(ev, lt, bx - SIZE / 2 - 14, by + SIZE / 2 + 1, { size: SIZE, out: outT, id: 'lab_' + p.ch });
    if (box) {   // 引线：锚点圆圈边 → 标签框上离锚点最近的点
      const px = clamp(ax, box.x0, box.x1), py = clamp(ay, box.y0, box.y1);
      const d = Math.hypot(px - ax, py - ay) || 1, sx = ax + (px - ax) / d * 8, sy = ay + (py - ay) / d * 8;
      ui.stroke([[sx, sy], [px, py]], kb, { w: 1.5, alpha: 0.85 * fade });
    }
  });
}

// 锚点小圆圈：逐笔描一圈
function ring(ctx, C, x, y, r, k, a) {
  if (k <= 0 || a <= 0) return;
  ctx.save(); ctx.globalAlpha = a; ctx.strokeStyle = C.grn; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * k); ctx.stroke(); ctx.restore();
}

// S17 留在画面上的闪回版式：S17 若在段尾已把标题化开收走（exit().title 为空），这里什么也不画；
// 若 S17 把标题留到最后一帧（exit().title = {ch, title}），就随水墨退去一起淡出，避免字在交接帧硬切。位置与 ui.flashTitle 默认一致。
function flashTitleOut(ui, ctx, prev, a) {
  const t = prev.title; if (a <= 0 || !t) return;
  const ch = t.ch ?? t.char ?? '心', tt = t.title ?? '白石立约', x = t.x ?? 1735, y = t.y ?? 225;
  ui.inkChar(ch, x, y, 1, { size: 150, alpha: a });
  ctx.save(); ctx.globalAlpha = a; const yEnd = ui.vText(tt, x, y + 80, 1, { size: 40 }); ctx.restore();
  ui.seal(x, yEnd + 24, 44, 1, { alpha: a });
}
