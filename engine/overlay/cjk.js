// 北冥引擎 · 中文排字：给 Canvas 2D 逐字画字用的断行与排版（纯函数，核心不碰 DOM）。
// 依据 W3C《中文排版需求》clreq（https://www.w3.org/TR/clreq/）：6.1.1 行首行尾禁则（取「严格处理」一档）、6.1.2 符号分离禁则、
// 6.3.2 标点符号的宽度调整（连续标点、行首行尾挤压）、3.2.2 汉字与西文的间距（四分之一字宽）。禁则集合与 engine/audio/voice/align.py 的
// CLOSE / OPEN 保持一致（字幕已在用，tests/engine/cjk.test.mjs 直接读那两行核对）。
//
//   layoutText(text, opts) → { glyphs, lines, width, height, fontSize, lineHeight, overflow }
//     glyphs: [{ ch, x, y, w, line, index }]   逐字。x = 画这个字的左缘（fillText 的 x，textAlign=left），y = 基线，原点在排版框左上；
//                                              w = 这个字占的前进宽度（已含挤压；不含字距 letterSpacing）；index = 它在原文里的下标（UTF-16，同 String.slice）。
//                                              行首被挤掉左半的开头标点，x 会是负的（字面贴着框边，空白伸到框外）；换行吊在行尾的空格 w 照实记，但不算进行宽
//     lines:  [{ start, end, width, y }]       glyphs 的下标区间 [start, end)、行实际宽度（墨迹到墨迹）、基线 y；空行 start = end
//     width = 对齐用的框宽（有限 maxWidth 时就是 maxWidth，否则是最宽一行）；height = 行数 × lineHeight；
//     fontSize = size；lineHeight = 行高（像素，= opts.lineHeight × size）；overflow = 行数超过 maxLines（超出的行照样排出来，由调用方决定怎么处理）
//   opts = { size, maxWidth = Infinity, measure, lineHeight = 1.7, letterSpacing = 0, autospace = 0.25, squeeze = true, align = 'left', maxLines, balance = false }
//     measure(str) → 像素宽：str 是一个字，或一串拉丁字符 / 数字（带字距的整串量）；核心只靠它，测试里可注入假的
//   canvasMeasure(font) → measure                              浏览器用：按 CSS font 串用 text.js 的量字上下文量
//   lintLine(str) → [{ kind: 'line-start' | 'line-end', index, ch, message }]   一行字的首尾有没有违反禁则（给 QA 检查用）
//   LINE_START / LINE_END / TRAIL_BLANK / LEAD_BLANK            规则表（Set，全角字符）：不得在行首 / 不得在行尾 / 右半留白（可挤）/ 左半留白（可挤）
//
// 假设（简体中文·中国大陆标点，GB/T 15834 的字面位置）：，。、；：！？ 和收尾括号引号 ）》」』】〕” ’ 的墨迹在字身框左半，右半是空白；
//   开头标点 （《「『【〔“‘ 的墨迹在右半，左半是空白；…… 与 —— 各占两个字宽、不挤。港台居中式标点的字体不适用（挤了会压字）。
//   基线取字身框顶往下 0.88 个字号（CJK 字身框基线在框底往上约 0.12 字号处，Noto Sans SC 等通用）。
// 做法：先按「原子」（一个汉字 / 标点、一整个拉丁词或数字连单位、成对的省略号或破折号）切开，原子之间才可断行；
//   行宽 = 原子宽之和 + 原子间距（中西文间隙 − 连续标点挤压）− 行首开头标点的左挤 − 行尾收尾标点的右挤，用前缀和 O(1) 求；
//   贪心取最长能放下的一行（行尾收尾标点已按挤掉半个字宽算，即 clreq「先挤进」），落在禁则上再逐个「推出」（把前一个原子带到下一行）。
//   clreq 6.1.1 的原话是「先挤进，后推出」，这里照它做；任务书写的是反过来，见汇报。
// 不做：竖排、标点悬挂、行内注音、两端对齐；连续三个标点的「局部不处理」救济；超长拉丁词不拆，独占一行并超出 maxWidth。
// 确定性：只有算术，没有随机数与时间，同输入同输出。

import { measure as measureCanvas } from './text.js';

// ── 规则表（全角部分与 align.py 的 CLOSE / OPEN 一一对应）──
export const LINE_START = new Set([...'，。、；：？！）》」』】〕…—”’']);   // 避头
export const LINE_END = new Set([...'（《「『【〔“‘']);                       // 避尾
export const TRAIL_BLANK = new Set([...'，。、；：？！）》」』】〕”’']);       // 右半空白
export const LEAD_BLANK = LINE_END;                                            // 左半空白（同一批开头标点）
const PAIR = new Set([...'…—']);            // 成对不拆
const ASCII_CLOSE = new Set([...',.;:?!)]}']), ASCII_OPEN = new Set([...'([{']), JOIN = new Set([...".,'’-:/_"]);
const SUFFIX = new Set([...'%‰°℃℉']), PREFIX = new Set([...'$¥€£+±−#@']);
const isAlnum = c => /[A-Za-z0-9À-ɏ]/.test(c);
const BASELINE = 0.88;

export const canvasMeasure = font => s => measureCanvas(s, font).w;

export function lintLine(str) {
  const s = String(str), cs = [...s], out = [];
  if (cs.length && LINE_START.has(cs[0])) out.push({ kind: 'line-start', index: 0, ch: cs[0], message: `行首不该是「${cs[0]}」（避头）` });
  const last = cs[cs.length - 1];
  if (cs.length && LINE_END.has(last)) out.push({ kind: 'line-end', index: s.length - last.length, ch: last, message: `行尾不该是「${last}」（避尾）` });
  return out;
}

// ── 切原子：每个原子 = 一串字（glyphs）+ 后面挂的空格（sp）──
const isSp = c => c === ' ' || c === '\t';
function atomize(items) {
  const atoms = [], N = items.length, ch = i => items[i]?.ch;
  const push = (glyphs, latin) => { const a = { glyphs, latin, sp: [] }; atoms.push(a); return a; };
  const opener = c => ASCII_OPEN.has(c) || c === '"' || c === "'";
  for (let i = 0; i < N;) {
    const c = ch(i), nx = ch(i + 1), prev = atoms[atoms.length - 1];
    if (isSp(c)) { if (prev) prev.sp.push(items[i]); else push([items[i]], false); i++; continue; }
    // 紧跟在前一个字后面的半角收尾标点 / 引号：粘在前一个原子上（不能到行首）
    if (prev && !prev.sp.length && (ASCII_CLOSE.has(c) || c === '"' || c === "'")) { prev.glyphs.push(items[i]); i++; continue; }
    if (isAlnum(c) || (PREFIX.has(c) && nx && isAlnum(nx)) || (opener(c) && nx && (isAlnum(nx) || PREFIX.has(nx)))) {
      const g = [];
      while (i < N && !isAlnum(ch(i)) && (opener(ch(i)) || PREFIX.has(ch(i))) && i + 1 < N && !isSp(ch(i + 1))) g.push(items[i++]);
      while (i < N) {
        if (isAlnum(ch(i))) g.push(items[i++]);
        else if (JOIN.has(ch(i)) && g.length && isAlnum(g[g.length - 1].ch) && i + 1 < N && isAlnum(ch(i + 1))) g.push(items[i++]);
        else break;
      }
      while (i < N && SUFFIX.has(ch(i))) g.push(items[i++]);
      while (i < N && (ASCII_CLOSE.has(ch(i)) || ch(i) === '"')) g.push(items[i++]);
      push(g, true); continue;
    }
    if (PAIR.has(c) && nx === c) { push([items[i], items[i + 1]], false); i += 2; continue; }
    push([items[i]], false); i++;
  }
  return atoms;
}

const edge = ch => (isAlnum(ch) || SUFFIX.has(ch) || PREFIX.has(ch) ? 'alnum' : (LINE_START.has(ch) || LINE_END.has(ch) || ASCII_CLOSE.has(ch) || ASCII_OPEN.has(ch) || ch === ' ' || ch === '"' || ch === "'" ? 'punct' : 'cjk'));

// ── 一段（硬换行之间）排成若干行：返回 [[atom 下标起, 止), …] 与摆放用的结构 ──
function prepare(items, o) {
  const { size, measure, letterSpacing: ls, autospace, squeeze } = o;
  const atoms = atomize(items), n = atoms.length;
  const sp1 = measure(' ');
  atoms.forEach(a => {
    a.str = a.glyphs.map(g => g.ch).join('');
    a.adv = [];
    if (a.latin) { let prev = 0; for (let k = 1; k <= a.glyphs.length; k++) { const m = measure(a.glyphs.slice(0, k).map(g => g.ch).join('')); a.adv.push(m - prev); prev = m; } }
    else a.adv = a.glyphs.map(g => measure(g.ch));
    a.pre = a.adv.map((_, k) => a.adv.slice(0, k).reduce((x, y) => x + y, 0));
    a.w = a.adv.reduce((x, y) => x + y, 0) + ls * a.glyphs.length;
    a.spW = a.sp.length * (sp1 + ls);
    const f = a.glyphs[0].ch, l = a.glyphs[a.glyphs.length - 1].ch, one = a.glyphs.length === 1;
    a.head = f; a.tail = l;
    a.l = a.glyphs[0].ch === ' ' ? 'punct' : edge(f); a.r = a.glyphs[a.glyphs.length - 1].ch === ' ' ? 'punct' : edge(l);
    a.pt = !one ? null : TRAIL_BLANK.has(f) ? 'close' : LEAD_BLANK.has(f) ? 'open' : null;   // 可挤标点
    a.half = a.pt ? a.adv[0] / 2 : 0;
  });
  // 相邻原子之间：空格 + 中西文间隙 − 连续标点挤压（挤压记在 rt / lt 里，摆放时用）
  const gap = new Array(n).fill(0), auto = new Array(n).fill(0), rt = new Array(n).fill(0), lt = new Array(n).fill(0);
  for (let k = 0; k + 1 < n; k++) {
    const a = atoms[k], b = atoms[k + 1];
    let g = a.spW;
    if (!a.sp.length && ((a.r === 'cjk' && b.l === 'alnum') || (a.r === 'alnum' && b.l === 'cjk'))) { auto[k] = autospace * size; g += auto[k]; }
    if (squeeze && !a.sp.length) {
      if (a.pt === 'close' && b.pt) { rt[k] = a.half; g -= a.half; }
      else if (a.pt === 'open' && b.pt === 'open') { lt[k + 1] = b.half; g -= b.half; }
    }
    gap[k] = g;
  }
  const P = [0];
  for (let k = 0; k < n; k++) P.push(P[k] + atoms[k].w + gap[k]);
  const lead = k => (squeeze && atoms[k].pt === 'open' ? atoms[k].half : 0);
  const trail = k => (squeeze && atoms[k].pt === 'close' ? atoms[k].half : 0);
  const lw = (i, j) => P[j] - P[i] - gap[j - 1] - lead(i) - trail(j - 1) - ls;
  const legal = k => !LINE_START.has(atoms[k].head) && !LEAD_BLANK.has(atoms[k - 1].tail);
  const breaks = W => {
    const out = [];
    for (let i = 0; i < n;) {
      let j = i + 1;
      while (j < n && lw(i, j + 1) <= W + 1e-6) j++;
      if (j < n) { let k = j; while (k > i + 1 && !legal(k)) k--; if (legal(k)) j = k; }   // 推出；推不动就保持原断点
      out.push([i, j]); i = j;
    }
    return out;
  };
  return { atoms, n, gap, auto, sp1, rt, lt, lead, trail, breaks };
}

export function layoutText(text, opts = {}) {
  const { size, maxWidth = Infinity, measure, lineHeight = 1.7, letterSpacing = 0, autospace = 0.25, squeeze = true, align = 'left', maxLines, balance = false } = opts;
  if (!(size > 0) || typeof measure !== 'function') throw new Error('layoutText 需要 opts.size（正数）与 opts.measure（函数）');
  const o = { size, measure, letterSpacing, autospace, squeeze };
  const src = String(text ?? ''), LH = lineHeight * size;
  const glyphs = [], lines = [];
  const paras = src === '' ? [] : src.split('\n');
  const rows = [];   // 先排出每行的相对位置，对齐要等整体宽度出来
  let off = 0;
  for (const p of paras) {
    const items = []; let u = off;
    for (const ch of p) { items.push({ ch, index: u }); u += ch.length; }
    off += p.length + 1;
    if (!items.length) { rows.push({ empty: true }); continue; }
    const S = prepare(items, o);
    let br = S.breaks(maxWidth);
    if (balance && Number.isFinite(maxWidth) && br.length > 1) {
      const K = br.length; let lo = 0, hi = maxWidth;
      for (let it = 0; it < 32; it++) { const mid = (lo + hi) / 2; if (S.breaks(mid).length <= K) hi = mid; else lo = mid; }
      br = S.breaks(hi);
    }
    for (const [i, j] of br) rows.push({ S, i, j });
  }
  const placed = rows.map(r => {
    if (r.empty) return { gl: [], width: 0 };
    const { S, i, j } = r, gl = []; let cur = 0;
    for (let k = i; k < j; k++) {
      const a = S.atoms[k], one = a.glyphs.length === 1, last = k === j - 1;
      a.glyphs.forEach((g, m) => {
        const l = one ? (k === i ? S.lead(k) : S.lt[k]) : 0, rr = one ? (last ? S.trail(k) : S.rt[k]) : 0;
        const w = a.adv[m] - l - rr;
        gl.push({ ch: g.ch, x: cur + (a.latin ? a.pre[m] + m * letterSpacing : 0) - l, w, index: g.index });
        if (!a.latin) cur += w + letterSpacing;
      });
      if (a.latin) cur += a.w;
      const end = cur;
      for (const g of a.sp) { gl.push({ ch: g.ch, x: cur, w: S.sp1, index: g.index }); cur += S.sp1 + letterSpacing; }
      if (last) { cur = end; } else cur += S.auto[k];
    }
    return { gl, width: cur - letterSpacing };
  });
  const widest = placed.reduce((m, r) => Math.max(m, r.width), 0);
  const box = Number.isFinite(maxWidth) ? maxWidth : widest;
  placed.forEach((r, ln) => {
    const y = ln * LH + (LH - size) / 2 + BASELINE * size;
    const ox = align === 'center' ? (box - r.width) / 2 : align === 'right' ? box - r.width : 0;
    const start = glyphs.length;
    for (const g of r.gl) glyphs.push({ ch: g.ch, x: g.x + ox, y, w: g.w, line: ln, index: g.index });
    lines.push({ start, end: glyphs.length, width: r.width, y });
  });
  return { glyphs, lines, width: box, height: lines.length * LH, fontSize: size, lineHeight: LH, overflow: maxLines != null && lines.length > maxLines };
}
