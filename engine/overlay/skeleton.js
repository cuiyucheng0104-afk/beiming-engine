// 北冥引擎 · 字形自动毛笔骨架提取与笔顺推导：直接从任意字体渲染出的二值掩码提取连续笔画中线、书写方向、传统笔顺与飞白权重，
// 亦可把外部标准笔顺中线（如 MakeMeAHanzi / hanzi-writer 坐标）吸附到实际书法字体的笔画脊线上，免除逐字手工标骨架。
// 算法依据 Zhang–Suen（1984）二值拓扑细化与倒角距离脊线吸附；几何分治思路参考开源项目 LingDong-/skeleton-tracing 与
// chanind/hanzi-writer，本模块为纯自研干净室实现。
//
//   thinMask(inside, W, H)                          二值掩码（Uint8Array 0/1）→ 单像素宽拓扑骨架掩码（Uint8Array 0/1）
//   traceMaskSkeleton(inside, W, H, opts)           零外部数据：从字形掩码提取 { strokes, dry }（单位 em，原点在字心，直通 buildBrushGlyph）
//   alignMediansToMask(medians, inside, W, H, opts) 有标准笔顺中线时：仿射对齐到当前字形墨迹外框并沿距离变换脊线吸附，返回 { strokes, dry }
//   extractGlyphStrokes(ch, opts)                   浏览器端：把单字 ch 按 font/size 栅格化并提取 { strokes, dry }
//   buildAutoBrushGlyph(ch, opts)                   浏览器端一步到位：自动提取骨架并调用 buildBrushGlyph(ch, …) 返回可绘制 glyph
import { clamp } from '../core/math.js';
import { chamfer, buildBrushGlyph } from './brush.js';

// 8 邻域顺时针偏移：P2(上), P3(右上), P4(右), P5(右下), P6(下), P7(左下), P8(左), P9(左上)
const DX8 = [0, 1, 1, 1, 0, -1, -1, -1];
const DY8 = [-1, -1, 0, 1, 1, 1, 0, -1];

/**
 * Zhang–Suen 两子步拓扑细化 + L 型阶梯冗余角点清理：输出单像素宽连通骨架（Uint8Array，W × H）。
 */
export function thinMask(inside, W, H) {
  const pw = W + 2, ph = H + 2;
  const g = new Uint8Array(pw * ph);
  for (let y = 0; y < H; y++) {
    const srcOff = y * W, dstOff = (y + 1) * pw + 1;
    for (let x = 0; x < W; x++) g[dstOff + x] = inside[srcOff + x] ? 1 : 0;
  }

  const drop = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      drop.length = 0;
      for (let y = 1; y <= H; y++) {
        const row = y * pw;
        for (let x = 1; x <= W; x++) {
          const idx = row + x;
          if (!g[idx]) continue;
          const p2 = g[idx - pw], p3 = g[idx - pw + 1], p4 = g[idx + 1], p5 = g[idx + pw + 1];
          const p6 = g[idx + pw], p7 = g[idx + pw - 1], p8 = g[idx - 1], p9 = g[idx - pw - 1];
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;
          const A = (p2 === 0 && p3 === 1 ? 1 : 0) + (p3 === 0 && p4 === 1 ? 1 : 0)
            + (p4 === 0 && p5 === 1 ? 1 : 0) + (p5 === 0 && p6 === 1 ? 1 : 0)
            + (p6 === 0 && p7 === 1 ? 1 : 0) + (p7 === 0 && p8 === 1 ? 1 : 0)
            + (p8 === 0 && p9 === 1 ? 1 : 0) + (p9 === 0 && p2 === 1 ? 1 : 0);
          if (A !== 1) continue;
          if (pass === 0) {
            if (p2 * p4 * p6 !== 0 || p4 * p6 * p8 !== 0) continue;
          } else if (p2 * p4 * p8 !== 0 || p2 * p6 * p8 !== 0) {
            continue;
          }
          drop.push(idx);
        }
      }
      if (drop.length) {
        changed = true;
        for (let i = 0; i < drop.length; i++) g[drop[i]] = 0;
      }
    }
  }

  // 清理 90° 阶梯冗余像素（保证斜线是纯 8 邻接单线，避免把斜线误判成度为 3 的伪分叉）
  for (let y = 1; y <= H; y++) {
    const row = y * pw;
    for (let x = 1; x <= W; x++) {
      const idx = row + x;
      if (!g[idx]) continue;
      const n = g[idx - pw], e = g[idx + 1], s = g[idx + pw], w = g[idx - 1];
      const ne = g[idx - pw + 1], se = g[idx + pw + 1], sw = g[idx + pw - 1], nw = g[idx - pw - 1];
      if ((n && e && !sw && !nw && !se && !w && !s)
        || (e && s && !nw && !ne && !sw && !w && !n)
        || (s && w && !ne && !nw && !se && !e && !n)
        || (w && n && !se && !ne && !sw && !e && !s)) {
        g[idx] = 0;
      }
    }
  }

  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const dstOff = y * W, srcOff = (y + 1) * pw + 1;
    for (let x = 0; x < W; x++) out[dstOff + x] = g[srcOff + x];
  }
  return out;
}

// Ramer–Douglas–Peucker 折线简化（像素坐标）
function simplifyPolyline(pts, tol) {
  if (pts.length <= 2 || !(tol > 0)) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const tol2 = tol * tol;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a <= 1) continue;
    const ax = pts[a][0], ay = pts[a][1], bx = pts[b][0], by = pts[b][1];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let bestD2 = -1, bestIdx = -1;
    for (let i = a + 1; i < b; i++) {
      let px = ax, py = ay;
      if (len2 > 1e-9) {
        const u = clamp(((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / len2, 0, 1);
        px = ax + u * dx;
        py = ay + u * dy;
      }
      const d2 = (pts[i][0] - px) ** 2 + (pts[i][1] - py) ** 2;
      if (d2 > bestD2) { bestD2 = d2; bestIdx = i; }
    }
    if (bestD2 > tol2 && bestIdx > a) {
      keep[bestIdx] = 1;
      stack.push([a, bestIdx], [bestIdx, b]);
    }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

function polylineLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

// 从链的一端向内走 lookahead 像素，估稳定的切向单位向量（从端点指向链内部）
function chainEndTangent(pts, fromEnd, lookahead = 6) {
  if (pts.length < 2) return [1, 0];
  const x0 = fromEnd ? pts[pts.length - 1][0] : pts[0][0];
  const y0 = fromEnd ? pts[pts.length - 1][1] : pts[0][1];
  let acc = 0, tx = x0, ty = y0;
  if (!fromEnd) {
    for (let i = 1; i < pts.length; i++) {
      acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      tx = pts[i][0]; ty = pts[i][1];
      if (acc >= lookahead) break;
    }
  } else {
    for (let i = pts.length - 2; i >= 0; i--) {
      acc += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
      tx = pts[i][0]; ty = pts[i][1];
      if (acc >= lookahead) break;
    }
  }
  const dx = tx - x0, dy = ty - y0, m = Math.hypot(dx, dy) || 1;
  return [dx / m, dy / m];
}

function orient2d(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function pointSegDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const u = l2 > 1e-12 ? clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1) : 0;
  return (px - (ax + u * dx)) ** 2 + (py - (ay + u * dy)) ** 2;
}

// 判断两条折线是否在空间上相交或紧邻（用于「十」「丰」等先横后竖裁决）
function strokesCross(a, b, thresh = 0.04) {
  const t2 = thresh * thresh;
  for (let i = 0; i < a.length - 1; i++) {
    const ax0 = a[i][0], ay0 = a[i][1], ax1 = a[i + 1][0], ay1 = a[i + 1][1];
    for (let j = 0; j < b.length - 1; j++) {
      const bx0 = b[j][0], by0 = b[j][1], bx1 = b[j + 1][0], by1 = b[j + 1][1];
      const o1 = orient2d(ax0, ay0, ax1, ay1, bx0, by0);
      const o2 = orient2d(ax0, ay0, ax1, ay1, bx1, by1);
      const o3 = orient2d(bx0, by0, bx1, by1, ax0, ay0);
      const o4 = orient2d(bx0, by0, bx1, by1, ax1, ay1);
      if (o1 * o2 <= 0 && o3 * o4 <= 0) return true;
      if (pointSegDist2(ax0, ay0, bx0, by0, bx1, by1) <= t2
        || pointSegDist2(ax1, ay1, bx0, by0, bx1, by1) <= t2
        || pointSegDist2(bx0, by0, ax0, ay0, ax1, ay1) <= t2
        || pointSegDist2(bx1, by1, ax0, ay0, ax1, ay1) <= t2) return true;
    }
  }
  return false;
}

// 按传统汉字书写习惯定每笔方向：横从左到右；竖、撇、捺、点从上到下；闭合圈从左上顺时针起笔
function orientStrokeEm(pts) {
  if (pts.length < 2) return pts;
  const first = pts[0], last = pts[pts.length - 1];
  const closed = Math.hypot(last[0] - first[0], last[1] - first[1]) < 0.04 && pts.length > 5;
  if (closed) {
    let best = 0, bestScore = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      const sc = pts[i][1] * 1.4 + pts[i][0];
      if (sc < bestScore) { bestScore = sc; best = i; }
    }
    const core = pts.slice(0, -1);
    const rot = [...core.slice(best), ...core.slice(0, best), core[best]];
    return rot;
  }
  const dx = last[0] - first[0], dy = last[1] - first[1];
  const absX = Math.abs(dx), absY = Math.abs(dy);
  // 近乎水平（横 / 提）：一律从左往右
  if (absY <= 0.45 * absX) return dx >= 0 ? pts : pts.slice().reverse();
  // 其余（竖 / 撇 / 捺 / 点）：从上往下；若高度几乎相同则从左往右
  if (Math.abs(dy) > 0.02) return dy >= 0 ? pts : pts.slice().reverse();
  return dx >= 0 ? pts : pts.slice().reverse();
}

function classifyStrokeEm(pts) {
  const first = pts[0], last = pts[pts.length - 1];
  const dx = last[0] - first[0], dy = last[1] - first[1];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, sumX = 0, sumY = 0;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    sumX += x; sumY += y;
  }
  const len = polylineLength(pts);
  const isHoriz = Math.abs(dy) <= 0.42 * Math.abs(dx) && Math.abs(dx) > 0.08;
  const isVert = Math.abs(dx) <= 0.35 * Math.abs(dy) && Math.abs(dy) > 0.08;
  return {
    pts, len, dx, dy, minX, minY, maxX, maxY,
    cx: sumX / pts.length, cy: sumY / pts.length,
    startX: first[0], startY: first[1],
    isHoriz, isVert,
  };
}

// 传统汉字笔顺启发式排序：从上到下 → 相交处先横后竖 → 从左到右
function sortStrokesTraditional(strokesEm) {
  const items = strokesEm.map(classifyStrokeEm);
  items.sort((a, b) => {
    if (strokesCross(a.pts, b.pts, 0.045)) {
      if (a.isHoriz && b.isVert) return -1;
      if (b.isHoriz && a.isVert) return 1;
    }
    const bandA = Math.floor((a.startY + 0.6) / 0.13);
    const bandB = Math.floor((b.startY + 0.6) / 0.13);
    if (bandA !== bandB) return bandA - bandB;
    if (Math.abs(a.startY - b.startY) > 0.07) return a.startY - b.startY;
    if (a.isHoriz !== b.isHoriz && Math.abs(a.cy - b.cy) < 0.09) return a.isHoriz ? -1 : 1;
    return a.startX - b.startX;
  });
  return items.map(x => x.pts);
}

// 根据笔画长度与走向估算收笔飞白强度（0..0.85）
export function estimateDryWeights(strokesEm) {
  return strokesEm.map(pts => {
    const info = classifyStrokeEm(pts);
    // 长撇、长捺、长横、长竖收笔带飞白，短点几乎不露白
    const sweep = Math.hypot(info.dx, info.dy);
    const diagBoost = !info.isHoriz && !info.isVert && sweep > 0.22 ? 0.16 : 0;
    return +clamp((info.len - 0.12) * 0.95 + diagBoost, 0.05, 0.85).toFixed(3);
  });
}

/**
 * 从二值字形掩码（inside: Uint8Array 0/1, W × H）零资产提取毛笔骨架与笔顺。
 * 返回 { strokes, dry }，坐标与 engine/overlay/brush.js 的 buildBrushGlyph 完全一致（单位 em，原点在画布中心）。
 */
export function traceMaskSkeleton(inside, W, H, {
  emSize = W / 1.12,
  minSpurPx = Math.max(3, Math.round(emSize * 0.045)),
  simplifyTolPx = Math.max(0.8, emSize * 0.008),
  mergeAngleDeg = 38,
} = {}) {
  const skel = thinMask(inside, W, H);
  const deg = new Uint8Array(W * H);
  const pixels = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!skel[i]) continue;
      pixels.push(i);
      let c = 0;
      for (let d = 0; d < 8; d++) {
        const nx = x + DX8[d], ny = y + DY8[d];
        if (nx >= 0 && ny >= 0 && nx < W && ny < H && skel[ny * W + nx]) c++;
      }
      deg[i] = c;
    }
  }
  if (!pixels.length) return { strokes: [], dry: [] };

  // 1) 把相邻的分叉像素（deg >= 3）聚合成交叉超节点（junction cluster）
  const juncId = new Int32Array(W * H).fill(-1);
  const junctions = []; // [{ pixels: number[], cx, cy }]
  for (const p of pixels) {
    if (deg[p] < 3 || juncId[p] >= 0) continue;
    const id = junctions.length;
    const comp = [p];
    juncId[p] = id;
    for (let q = 0; q < comp.length; q++) {
      const cur = comp[q], cx = cur % W, cy = (cur / W) | 0;
      for (let d = 0; d < 8; d++) {
        const nx = cx + DX8[d], ny = cy + DY8[d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (skel[ni] && deg[ni] >= 3 && juncId[ni] < 0) {
          juncId[ni] = id;
          comp.push(ni);
        }
      }
    }
    let sx = 0, sy = 0;
    for (const px of comp) { sx += px % W; sy += (px / W) | 0; }
    junctions.push({ pixels: comp, cx: sx / comp.length, cy: sy / comp.length });
  }

  // 2) 追踪连接「端点 / 交叉超节点」之间的普通骨架像素链，以及独立闭合环
  const visited = new Uint8Array(W * H);
  const chains = []; // { pts: [x,y][], j0: number, j1: number, active: boolean }

  const traceWalk = (startPx, prevPx, startJunc) => {
    const pts = [];
    if (startJunc >= 0) pts.push([junctions[startJunc].cx, junctions[startJunc].cy]);
    let cur = startPx, prev = prevPx;
    while (cur >= 0) {
      visited[cur] = 1;
      const cx = cur % W, cy = (cur / W) | 0;
      pts.push([cx, cy]);
      // 检查是否邻接某个交叉超节点（且不是刚出发且仍在第 0 步的那个像素）
      let hitJunc = -1;
      for (let d = 0; d < 8; d++) {
        const nx = cx + DX8[d], ny = cy + DY8[d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (ni === prev) continue;
        if (juncId[ni] >= 0 && (juncId[ni] !== startJunc || pts.length > 2)) {
          hitJunc = juncId[ni];
          break;
        }
      }
      if (hitJunc >= 0) {
        pts.push([junctions[hitJunc].cx, junctions[hitJunc].cy]);
        return { pts, j0: startJunc, j1: hitJunc, active: true };
      }
      // 找下一个尚未访问的普通骨架像素（优先正交邻接）
      let next = -1;
      for (const d of [0, 2, 4, 6, 1, 3, 5, 7]) {
        const nx = cx + DX8[d], ny = cy + DY8[d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (skel[ni] && juncId[ni] < 0 && !visited[ni]) { next = ni; break; }
      }
      prev = cur;
      cur = next;
    }
    return { pts, j0: startJunc, j1: -1, active: true };
  };

  // 2a) 从所有交叉超节点向外生长的普通像素出发
  for (let j = 0; j < junctions.length; j++) {
    for (const jp of junctions[j].pixels) {
      const jx = jp % W, jy = (jp / W) | 0;
      for (const d of [0, 2, 4, 6, 1, 3, 5, 7]) {
        const nx = jx + DX8[d], ny = jy + DY8[d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (!skel[ni]) continue;
        if (juncId[ni] >= 0 && juncId[ni] > j) {
          // 两个不同交叉团直接相贴
          chains.push({
            pts: [[junctions[j].cx, junctions[j].cy], [junctions[juncId[ni]].cx, junctions[juncId[ni]].cy]],
            j0: j, j1: juncId[ni], active: true,
          });
        } else if (juncId[ni] < 0 && !visited[ni]) {
          chains.push(traceWalk(ni, jp, j));
        }
      }
    }
  }

  // 2b) 从自由端点（deg <= 1）出发追踪独立笔画（如「一」「二」「八」）
  for (const p of pixels) {
    if (juncId[p] >= 0 || visited[p] || deg[p] > 1) continue;
    if (deg[p] === 0) {
      visited[p] = 1;
      const x = p % W, y = (p / W) | 0;
      chains.push({ pts: [[x - 0.5, y], [x + 0.5, y]], j0: -1, j1: -1, active: true });
    } else {
      chains.push(traceWalk(p, -1, -1));
    }
  }

  // 2c) 剩余未访问像素必为无分叉闭合环（如「〇」或圆圈）
  for (const p of pixels) {
    if (juncId[p] >= 0 || visited[p]) continue;
    const ch = traceWalk(p, -1, -1);
    if (ch.pts.length > 2) ch.pts.push([ch.pts[0][0], ch.pts[0][1]]);
    chains.push(ch);
  }

  // 3) 剪除挂在分叉点上的短毛刺（楷书起笔顿笔、收笔出锋形成的小分叉），但如果该分叉只剩唯一主干则保留避免吞字
  for (const c of chains) {
    const oneEndFree = (c.j0 >= 0 && c.j1 < 0) || (c.j1 >= 0 && c.j0 < 0);
    if (oneEndFree && polylineLength(c.pts) < minSpurPx) {
      const j = c.j0 >= 0 ? c.j0 : c.j1;
      const incident = chains.filter(x => x.active && (x.j0 === j || x.j1 === j));
      if (incident.length >= 3) c.active = false;
    }
  }

  // 4) 交叉点切向连续配对合并（如「十」在中心交叉处的左右两段横合并为一横，上下两段竖合并为一竖）
  const cosThr = -Math.cos((mergeAngleDeg * Math.PI) / 180);
  const lookahead = Math.max(4, emSize * 0.045);

  for (let j = 0; j < junctions.length; j++) {
    for (;;) {
      const inc = [];
      for (let idx = 0; idx < chains.length; idx++) {
        const c = chains[idx];
        if (!c.active) continue;
        if (c.j0 === j && c.j1 !== j) inc.push({ idx, atEnd: false, t: chainEndTangent(c.pts, false, lookahead) });
        else if (c.j1 === j && c.j0 !== j) inc.push({ idx, atEnd: true, t: chainEndTangent(c.pts, true, lookahead) });
      }
      if (inc.length < 2) break;
      let bestPair = null, bestDot = 1;
      for (let a = 0; a < inc.length; a++) {
        for (let b = a + 1; b < inc.length; b++) {
          const dot = inc[a].t[0] * inc[b].t[0] + inc[a].t[1] * inc[b].t[1];
          if (dot < bestDot) { bestDot = dot; bestPair = [inc[a], inc[b]]; }
        }
      }
      // 度为 2 的伪节点无条件合并；真实分叉只合并方向互成 ~180° 的直通笔画对
      if (!bestPair || (inc.length > 2 && bestDot > cosThr)) break;

      const [A, B] = bestPair;
      const ca = chains[A.idx], cb = chains[B.idx];
      const ptsA = A.atEnd ? ca.pts : ca.pts.slice().reverse(); // 末尾在 j
      const ptsB = B.atEnd ? cb.pts.slice().reverse() : cb.pts; // 开头在 j
      const otherA = A.atEnd ? ca.j0 : ca.j1;
      const otherB = B.atEnd ? cb.j0 : cb.j1;
      ca.pts = [...ptsA, ...ptsB.slice(1)];
      ca.j0 = otherA;
      ca.j1 = otherB;
      cb.active = false;
    }
  }

  // 5) 简化折线、换算为 em 坐标、定书写方向并按传统汉字笔顺排序
  const halfW = W / 2, halfH = H / 2;
  const toEm = ([x, y]) => [
    +((x + 0.5 - halfW) / emSize).toFixed(4),
    +((y + 0.5 - halfH) / emSize).toFixed(4),
  ];

  const rawStrokes = [];
  for (const c of chains) {
    if (!c.active || c.pts.length < 2) continue;
    const simp = simplifyPolyline(c.pts, simplifyTolPx);
    if (simp.length < 2) continue;
    const emPts = orientStrokeEm(simp.map(toEm));
    if (polylineLength(emPts) < 0.015 && chains.length > 1) continue;
    rawStrokes.push(emPts);
  }

  const strokes = sortStrokesTraditional(rawStrokes);
  return { strokes, dry: estimateDryWeights(strokes) };
}

/**
 * 把标准汉字笔顺中线（如 hanzi-writer-data / MakeMeAHanzi 的 1024×1024 Y 轴朝上 medians，或已归一的 em 折线）
 * 仿射映射到当前字体掩码的墨迹包围盒，并沿倒角距离变换梯度向笔画中心脊线柔和吸附。
 */
export function alignMediansToMask(medians, inside, W, H, {
  emSize = W / 1.12,
  yFlip = null,
  snapSteps = 3,
} = {}) {
  if (!Array.isArray(medians) || !medians.length) return traceMaskSkeleton(inside, W, H, { emSize });

  // 求掩码墨迹像素外框
  let mx0 = W, my0 = H, mx1 = -1, my1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (inside[y * W + x]) {
        if (x < mx0) mx0 = x;
        if (x > mx1) mx1 = x;
        if (y < my0) my0 = y;
        if (y > my1) my1 = y;
      }
    }
  }
  if (mx1 < mx0) return { strokes: [], dry: [] };

  // 求源 medians 的外框；若数值超过 2 自动识别为 hanzi-writer 的 1024 字面坐标系（Y 朝上，默认翻转 Y）
  let sx0 = Infinity, sy0 = Infinity, sx1 = -Infinity, sy1 = -Infinity, maxAbs = 0;
  for (const s of medians) {
    for (const [x, y] of s) {
      maxAbs = Math.max(maxAbs, Math.abs(x), Math.abs(y));
      if (x < sx0) sx0 = x;
      if (x > sx1) sx1 = x;
      if (y < sy0) sy0 = y;
      if (y > sy1) sy1 = y;
    }
  }
  const flipY = yFlip ?? (maxAbs > 2);
  const dt = chamfer(inside, W, H);
  const sw = Math.max(1e-6, sx1 - sx0), sh = Math.max(1e-6, sy1 - sy0);
  const mw = Math.max(1, mx1 - mx0), mh = Math.max(1, my1 - my0);
  // 留出半个笔宽的内边距，使笔画起收落在墨迹脊线而非外沿
  const insetX = Math.min(mw * 0.06, emSize * 0.03), insetY = Math.min(mh * 0.06, emSize * 0.03);
  const tx0 = mx0 + insetX, tw = Math.max(1, mw - 2 * insetX);
  const ty0 = my0 + insetY, th = Math.max(1, mh - 2 * insetY);

  const halfW = W / 2, halfH = H / 2;
  const strokes = medians.map(stroke => {
    const mapped = stroke.map(([x, y]) => {
      const u = sw > 1e-4 ? (x - sx0) / sw : 0.5;
      const vRaw = sh > 1e-4 ? (y - sy0) / sh : 0.5;
      const v = flipY ? 1 - vRaw : vRaw;
      let px = tx0 + u * tw;
      let py = ty0 + v * th;
      // 沿距离变换梯度把中线轻推向当前字体的真实笔画脊线中心
      for (let step = 0; step < snapSteps; step++) {
        const ix = clamp(Math.round(px), 1, W - 2);
        const iy = clamp(Math.round(py), 1, H - 2);
        const gx = (dt[iy * W + (ix + 1)] - dt[iy * W + (ix - 1)]) * 0.5;
        const gy = (dt[(iy + 1) * W + ix] - dt[(iy - 1) * W + ix]) * 0.5;
        const gm = Math.hypot(gx, gy);
        if (gm < 1e-3) break;
        px = clamp(px + (gx / gm) * 0.85, 0, W - 1);
        py = clamp(py + (gy / gm) * 0.85, 0, H - 1);
      }
      return [
        +((px + 0.5 - halfW) / emSize).toFixed(4),
        +((py + 0.5 - halfH) / emSize).toFixed(4),
      ];
    });
    return mapped.length >= 2 ? mapped : [[0, 0], [0.02, 0]];
  });

  return { strokes, dry: estimateDryWeights(strokes) };
}

/**
 * 浏览器端：按与 buildBrushGlyph 完全相同的画布规格把单字 ch 栅格化，自动提取 { strokes, dry }。
 */
export function extractGlyphStrokes(ch, { font, size: F = 180, medians = null, ...opts } = {}) {
  if (typeof document !== 'undefined' && document.fonts && !document.fonts.check(font, ch)) {
    throw new Error(`extractGlyphStrokes：字体还没加载好（${font}，“${ch}”）；先等 loadFonts / document.fonts.load 完成`);
  }
  const size = Math.ceil(F * 1.12);
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const c = cv.getContext('2d', { willReadFrequently: true });
  c.font = font;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillStyle = '#fff';
  c.fillText(ch, size / 2, size / 2);
  const src = c.getImageData(0, 0, size, size).data;
  const inside = new Uint8Array(size * size);
  for (let i = 0; i < inside.length; i++) inside[i] = src[i * 4 + 3] > 127 ? 1 : 0;
  return medians
    ? alignMediansToMask(medians, inside, size, size, { emSize: F, ...opts })
    : traceMaskSkeleton(inside, size, size, { emSize: F, ...opts });
}

/**
 * 浏览器端一步到位：无需手标 strokes，自动提取骨架与飞白权重并返回 buildBrushGlyph 的结果，直接传给 paintBrushGlyph。
 */
export function buildAutoBrushGlyph(ch, {
  font, size = 180, span = [0, 1], medians = null, dry = null, dryScale = 1, gap = 0.012, hold = 0.14, ...skelOpts
} = {}) {
  const auto = extractGlyphStrokes(ch, { font, size, medians, ...skelOpts });
  const strokes = auto.strokes.length ? auto.strokes : [[[-0.1, 0], [0.1, 0]]];
  return buildBrushGlyph(ch, {
    font,
    size,
    strokes,
    span,
    dry: dry ?? auto.dry,
    dryScale,
    gap,
    hold,
  });
}
