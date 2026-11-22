// 北冥 QA · visual：画面异常。一次解码缩成 ≤480 宽的亮度流（按标签换算成观众看到的 0–255），逐帧算：
// 平均亮度、黑像素比例、与上一帧 / 与静帧起点的差（16 列分块取最大，免得局部小动作被整帧平均掩盖）、边缘暗带、笔直竖边、分块亮度。
// 判定：黑场、静帧、闪帧、切点对照镜头表、跳帧、大面积闪烁、边缘露底、截断竖边。film.json 的 qa.intentional 声明的停顿 / 黑场 / 闪白不算问题。
//
// 阈值都在档位的 visual 段（tools/qa/profiles.builtin.json，含义与出处见 docs/quality/QA-GATE.md）：
//   黑场：像素亮度 ≤ blackPixel×255 的比例 ≥ blackRatio（同 ffmpeg blackdetect 的 pix_th=0.02 / pic_th=0.98）
//   静帧：与静帧起点帧的分块平均绝对差都 < 10^(freezeNoiseDb/20)×255（同 freezedetect 的 n=−50 dB），持续 ≥ freezeMinSec
//   闪帧：|该帧平均亮度 − 前后各 flickerHalfWindow 帧的中值| ≥ flickerLevels，切点 ±1 帧除外
//   切点：分数 = min(帧差%, |帧差% − 上一帧帧差%|)（同 ffmpeg scdet 的算法）≥ cutScore，±cutNmsFrames 内非极大值抑制，与镜头表 ±cutTolFrames 对应
//   跳帧：帧差 ≥ jumpRatio × 前后 6 帧帧差中值，且至少高出 jumpMinLevels 级（方法借鉴 cases/source/style-18-art-deco/tools/motioncheck.py@1046c14 的帧差对中值倍数，代码重写）
//
//   runVisual({ input, profile, film, probe, timeoutMs, telemetryFile, telemetryExplicit }) → { checks, series, framesOfInterest, source, warnings }
import fs from 'node:fs/promises';
import { makeCheck, finding, settle, notRun } from '../lib/checks.mjs';
import { probeFile, rate, recordVideoVerifier } from '../lib/probe.mjs';
import { streamLuma } from '../lib/frames.mjs';
import { usageError } from '../lib/cli-kit.mjs';
import { fpsOf } from '../lib/profiles.mjs';
import { createAnalyzer, hexLuma, telemetrySize, validateVisualTelemetry } from '../../../engine/render/lib/visual-telemetry.mjs';

export { createAnalyzer };

const median = a => { if (!a.length) return 0; const s = Float64Array.from(a).sort(); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const runs = (flags, n) => { const out = []; let s = -1; for (let i = 0; i <= n; i++) { if (i < n && flags[i]) { if (s < 0) s = i; } else if (s >= 0) { out.push([s, i]); s = -1; } } return out; };
const fmtRange = (r, fps) => `第 ${r[0]}–${r[1] - 1} 帧（${(r[0] / fps).toFixed(2)}–${(r[1] / fps).toFixed(2)} 秒，${r[1] - r[0]} 帧）`;
const covered = (r, list, tol = 1) => list.some(x => r[0] >= x.from - tol && r[1] <= x.to + tol);
const near = (i, set, d) => { for (const c of set) if (Math.abs(i - c) <= d) return true; return false; };
const srgbLin = v => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };

export async function runVisual({ input, profile, film = null, probe = null, timeoutMs, telemetryFile, telemetryExplicit = false, verifyVideo = recordVideoVerifier(input, { timeoutMs }) }) {
  const pr = probe || await probeFile(input, { timeoutMs });
  const v = pr.video;
  const checks = [], warnings = [];
  const ids = ['visual.black', 'visual.freeze', 'visual.flicker', 'visual.cuts', 'visual.jumps', 'visual.flash-rate', 'visual.edge-clear', 'visual.edge-line'];
  if (!v) {
    if (telemetryExplicit) throw usageError('没有视频流，无法核对 --telemetry');
    for (const id of ids) checks.push(notRun(makeCheck(id), '没有视频流'));
    return { checks, series: null, framesOfInterest: [], source: null, warnings };
  }
  const V = profile.visual, clearColor = film?.qa?.clearColor;
  const fps = (rate(v.avg_frame_rate) || rate(v.r_frame_rate) || fpsOf(profile)).value;
  const nb = Number(v.nb_frames) || 0;
  const size = telemetrySize(v.width, v.height, nb);
  let S, source = 'decode';
  if (telemetryFile) {
    try {
      const doc = JSON.parse(await fs.readFile(telemetryFile, 'utf8'));
      const series = validateVisualTelemetry(doc, { width: v.width, height: v.height, frames: nb, fps, visual: V, clearColor });
      await verifyVideo(doc, telemetryFile, v);
      S = series;
      source = 'telemetry';
    } catch (e) {
      const why = `画面遥测 ${telemetryFile} 不可用：${e.message}`;
      if (telemetryExplicit) throw usageError(why, '使用本片渲染生成的 telemetry.json，或去掉 --telemetry 按成片解码');
      warnings.push(`${why}；改用成片解码`);
    }
  }
  if (!S) {
    const an = createAnalyzer({ ...size, visual: V, clearLuma: hexLuma(clearColor) });
    await streamLuma(input, { ...size, timeoutMs, onFrame: (lum, i) => an.push(lum, i) });
    S = an.end();
  }
  const n = S.n;
  const intentional = film?.qa?.intentional || [];
  const ofKind = k => intentional.filter(x => x.kind === k);
  const foi = new Set();
  const scale = v.width / size.w;

  // ── 黑场 ──
  const black = makeCheck('visual.black', { expected: `无未声明黑场（亮度 ≤ ${V.blackPixel * 100}% 的像素占比 ≥ ${V.blackRatio * 100}%）` });
  const isBlack = S.blackRatio.map(r => r >= V.blackRatio);
  const blackRuns = runs(isBlack, n);
  black.value = blackRuns.length ? `${blackRuns.length} 段黑场` : '无黑场';
  black.evidence = { segments: blackRuns };
  for (const r of blackRuns) {
    const ok = covered(r, ofKind('black'));
    finding(black, { key: `black@${r[0]}`, frames: r, status: ok ? 'pass' : undefined, message: `${ok ? '已声明的黑场' : '黑场'}：${fmtRange(r, fps)}`, hint: ok ? null : '刻意的黑场（开场、结尾、转场）写进 film.json 的 qa.intentional：{ "kind": "black", "from": 起帧, "to": 止帧 }' });
    if (!ok) foi.add(r[0]);
  }
  checks.push(settle(black));

  // ── 静帧 ──
  const minFreeze = Math.max(2, Math.round(V.freezeMinSec * fps));
  const freeze = makeCheck('visual.freeze', { expected: `无未声明的整帧静止 ≥ ${minFreeze} 帧（${V.freezeMinSec} 秒）` });
  const freezes = S.freezeRuns.filter(r => r[1] - r[0] >= minFreeze && !isBlack.slice(r[0], r[1]).every(Boolean));
  freeze.value = freezes.length ? `${freezes.length} 段静帧` : '无静帧';
  freeze.evidence = { segments: freezes, minFrames: minFreeze, noiseLevels: +(10 ** (V.freezeNoiseDb / 20) * 255).toFixed(2) };
  for (const r of freezes) {
    const ok = covered(r, ofKind('freeze'));
    finding(freeze, { key: `freeze@${r[0]}`, frames: r, status: ok ? 'pass' : undefined, message: `${ok ? '已声明的停顿' : '静帧'}：${fmtRange(r, fps)}`, hint: ok ? null : '画面卡住（颗粒照动也算）。若是刻意停顿，写进 film.json 的 qa.intentional：{ "kind": "freeze", "from", "to", "reason" }；不要为过检放宽阈值' });
    if (!ok) foi.add(r[0]);
  }
  checks.push(settle(freeze));

  // ── 切点（先算，闪帧与跳帧要排除切点）──
  const pct = S.mafd.map(x => (x / 255) * 100);
  const score = pct.map((x, i) => (i === 0 ? 0 : Math.min(x, Math.abs(x - pct[i - 1]))));
  const cand = score.map((s, i) => [i, s]).filter(([i, s]) => i > 0 && s >= V.cutScore).sort((a, b) => b[1] - a[1]);
  const detected = [];
  for (const [i, s] of cand) if (!detected.some(d => Math.abs(d.frame - i) <= V.cutNmsFrames)) detected.push({ frame: i, score: +s.toFixed(2) });
  detected.sort((a, b) => a.frame - b.frame);
  const cuts = makeCheck('visual.cuts', { expected: film?.cuts?.length ? `镜头表切点 ${film.cuts.map(c => c.frame).join('、')}（±${V.cutTolFrames} 帧）` : '有镜头表时逐一对应' });
  const flashes = ofKind('flash');
  const soft = (film?.cuts || []).filter(c => c.transition && c.transition !== 'cut');
  const hard = (film?.cuts || []).filter(c => !c.transition || c.transition === 'cut');
  const matched = new Set();
  const offsets = [];
  if (film?.shots?.length) {
    for (const c of hard) {
      const d = detected.find(x => Math.abs(x.frame - c.frame) <= V.cutTolFrames && !matched.has(x));
      if (d) { matched.add(d); offsets.push({ expected: c.frame, detected: d.frame, offset: d.frame - c.frame, score: d.score }); }
      else finding(cuts, { key: `missing@${c.frame}`, target: c.shot, frames: [c.frame, c.frame + 1], status: 'warn', message: `镜头表在第 ${c.frame} 帧（进 ${c.shot}）有切点，画面上没检出硬切`, hint: '若是溶、划、动作匹配剪辑，在该镜头写 transition（如 "dissolve" / "match"）；否则检查切点是否漂移' });
    }
    for (const d of detected) {
      if (matched.has(d)) continue;
      if (soft.some(c => Math.abs(c.frame - d.frame) <= 2) || covered([d.frame, d.frame + 1], flashes, 1)) continue;
      finding(cuts, { key: `extra@${d.frame}`, frames: [d.frame, d.frame + 1], message: `第 ${d.frame} 帧（${(d.frame / fps).toFixed(2)} 秒）检出镜头表里没有的切点（分数 ${d.score}）`, hint: '镜头表与画面不一致：改 film.json 的 shots 或修画面；刻意的闪白写进 qa.intentional（kind: "flash"）' });
      foi.add(d.frame);
    }
  } else {
    finding(cuts, { key: 'no-shots', status: 'warn', message: `没有镜头表（film.json 的 shots），只列出检出的切点：${detected.map(d => d.frame).join('、') || '无'}` });
  }
  cuts.value = `检出 ${detected.length} 个切点${detected.length ? `（${detected.map(d => d.frame).join('、')}）` : ''}`;
  cuts.evidence = { detected, matched: offsets, topScores: score.map((s, i) => [i, +s.toFixed(2)]).sort((a, b) => b[1] - a[1]).slice(0, 6) };
  checks.push(settle(cuts));
  const cutFrames = new Set([...detected.map(d => d.frame), ...(film?.cuts || []).map(c => c.frame)]);

  // ── 闪帧 ──
  // 中值窗只取同一镜头内的帧（不跨切点）；另要求相对前后两帧均值也跳变 ≥ 阈值的一半，
  // 这样镜头里平滑的明暗推移（开场渐亮、曝光爬升）不会被当成闪帧，单帧、两帧的突变照样抓到
  const flick = makeCheck('visual.flicker', { expected: `|平均亮度 − 同镜头前后 ${V.flickerHalfWindow} 帧中值| < ${V.flickerLevels} 级` });
  const dev = new Float64Array(n);
  const flagged = new Array(n).fill(false);
  const bounds = [0, ...[...cutFrames].filter(c => c > 0 && c < n).sort((a, b) => a - b), n];
  const segOf = i => { let k = 0; while (k + 1 < bounds.length && bounds[k + 1] <= i) k++; return [bounds[k], bounds[k + 1]]; };
  let maxDev = 0, maxAt = -1;
  for (let i = 0; i < n; i++) {
    const [s0, s1] = segOf(i);
    const nb2 = [];
    for (let k = Math.max(s0, i - V.flickerHalfWindow); k <= Math.min(s1 - 1, i + V.flickerHalfWindow); k++) if (k !== i) nb2.push(S.yavg[k]);
    if (nb2.length < 2) continue;
    dev[i] = S.yavg[i] - median(nb2);
    const a = i > s0 ? S.yavg[i - 1] : S.yavg[i + 1], b = i + 1 < s1 ? S.yavg[i + 1] : S.yavg[i - 1];
    const local = a === undefined || b === undefined ? dev[i] : S.yavg[i] - (a + b) / 2;
    if (near(i, cutFrames, 1) || covered([i, i + 1], flashes, 0)) continue;
    if (Math.abs(dev[i]) > maxDev) { maxDev = Math.abs(dev[i]); maxAt = i; }
    if (Math.abs(dev[i]) >= V.flickerLevels && Math.abs(local) >= V.flickerLevels / 2) flagged[i] = true;
  }
  flick.value = `最大偏差 ${maxDev.toFixed(2)} 级${maxAt >= 0 ? `（第 ${maxAt} 帧）` : ''}`;
  flick.evidence = { maxDeviation: +maxDev.toFixed(2), at: maxAt };
  for (const r of runs(flagged, n)) {
    const peak = Math.max(...Array.from(dev.slice(r[0], r[1])).map(Math.abs));
    finding(flick, { key: `flicker@${r[0]}`, frames: r, message: `闪帧：${fmtRange(r, fps)}，亮度跳变 ${peak.toFixed(1)} 级`, hint: '单帧亮度突变多半是渲染异常（资源没就绪、后期参数跳变）；刻意的闪白写进 qa.intentional（kind: "flash"）' });
    foi.add(r[0]);
  }
  checks.push(settle(flick));

  // ── 跳帧 ──
  const jump = makeCheck('visual.jumps', { expected: `帧差 < ${V.jumpRatio}× 邻近中值` });
  const jumpFlags = new Array(n).fill(false);
  for (let i = 2; i < n - 1; i++) {
    if (near(i, cutFrames, 2) || flagged[i] || flagged[i - 1] || covered([i, i + 1], flashes, 1)) continue;
    const nb3 = [];
    for (let k = Math.max(1, i - 6); k <= Math.min(n - 1, i + 6); k++) if (k !== i && !near(k, cutFrames, 0)) nb3.push(S.mafd[k]);
    const m = median(nb3);
    if (!(S.mafd[i] >= V.jumpRatio * m && S.mafd[i] - m >= V.jumpMinLevels)) continue;
    // 一拍二、一拍三的分层动画会让帧差每 2、3 帧来一次尖峰：附近 ±2…±4 帧也有相近尖峰的，是节拍不是跳帧
    let periodic = false;
    for (const d of [2, 3, 4]) for (const k of [i - d, i + d]) if (k > 0 && k < n && S.mafd[k] >= 0.6 * S.mafd[i]) periodic = true;
    if (!periodic) jumpFlags[i] = true;
  }
  const jumpRuns = runs(jumpFlags, n);
  jump.value = jumpRuns.length ? `${jumpRuns.length} 处可疑` : '无';
  for (const r of jumpRuns.slice(0, 8)) {
    finding(jump, { key: `jump@${r[0]}`, frames: r, message: `疑似跳帧：第 ${r[0]} 帧帧差 ${S.mafd[r[0]].toFixed(1)} 级，是邻近中值的数倍`, hint: '逐帧看这几帧：动作是否突然跳一截（漏帧、重复帧、相机参数跳变）' });
    foi.add(r[0]);
  }
  checks.push(settle(jump));

  // ── 大面积闪烁（BT.1702 近似：亮度变化 ≥ 20 cd/m²、暗的一端 < 160 cd/m²，1 秒内 > 3 次闪烁，面积 ≥ 25%）──
  const fr = makeCheck('visual.flash-rate', { expected: `任意 1 秒内大面积闪烁 ≤ ${V.flashMaxPerSec} 次` });
  const nbk = S.gx * S.gy, trans = Array.from({ length: nbk }, () => []);
  // 每块记录「相反方向的亮度变化」：上一次是变亮就盯着峰值等变暗，反之亦然；亮度按 sRGB 解码后乘 200 cd/m²（普通显示器）近似
  const D = V.flashLumDelta;
  for (let b = 0; b < nbk && n; b++) {
    let lo = srgbLin(S.blockLum[0][b]) * 200, hi = lo, dir = 0;
    for (let i = 1; i < n; i++) {
      const L = srgbLin(S.blockLum[i][b]) * 200;
      if (dir === 0) {
        lo = Math.min(lo, L); hi = Math.max(hi, L);
        if (L - lo >= D && lo < 160) { trans[b].push(i); dir = 1; hi = L; } else if (hi - L >= D && L < 160) { trans[b].push(i); dir = -1; lo = L; }
      } else if (dir === 1) {
        if (L > hi) hi = L; else if (hi - L >= D && L < 160) { trans[b].push(i); dir = -1; lo = L; }
      } else if (L < lo) lo = L; else if (L - lo >= D && lo < 160) { trans[b].push(i); dir = 1; hi = L; }
    }
  }
  const win = Math.max(1, Math.round(fps));
  let worst = { frac: 0, at: -1 };
  const badWins = [];
  for (let s = 0; s + 1 < Math.max(2, n - win + 1); s += Math.max(1, Math.round(win / 4))) {
    let k = 0;
    for (let b = 0; b < nbk; b++) if (trans[b].filter(t => t >= s && t < s + win).length >= 2 * V.flashMaxPerSec + 1) k++;
    const frac = k / nbk;
    if (frac > worst.frac) worst = { frac, at: s };
    if (frac >= V.flashAreaFrac && !covered([s, s + win], flashes, 0)) badWins.push([s, Math.min(n, s + win)]);
  }
  fr.value = `最大闪烁面积 ${(worst.frac * 100).toFixed(0)}%${worst.at >= 0 ? `（从第 ${worst.at} 帧起的 1 秒）` : ''}`;
  if (badWins.length) {
    const r = [badWins[0][0], badWins[badWins.length - 1][1]];
    finding(fr, { key: `flash@${r[0]}`, frames: r, message: `${fmtRange(r, fps)} 内有 ≥ ${(V.flashAreaFrac * 100).toFixed(0)}% 画面每秒闪烁超过 ${V.flashMaxPerSec} 次（光敏性癫痫风险的近似筛查，不等于认证测试）`, hint: '降低闪烁频率或面积；对外播出前用专业 PSE 工具复测' });
    foi.add(r[0]);
  }
  checks.push(settle(fr));

  // ── 边缘露底（清屏色暗带）──
  const ec = makeCheck('visual.edge-clear', { expected: '画面四边没有清屏色暗带' });
  const sideName = { top: '上', right: '右', bottom: '下', left: '左' };
  const groups = new Map();
  for (const b of S.bands) { const k = `${b.side}:${b.seg}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(b); }
  for (const [k, list] of groups) {
    const [side, seg] = k.split(':');
    const fl = new Array(n).fill(false); for (const b of list) fl[b.frame] = true;
    const rr = runs(fl, n).filter(r => !covered(r, ofKind('black')));
    if (!rr.length) continue;
    const px = Math.round(Math.max(...list.map(b => b.px)) * scale);
    const always = list.length >= 0.95 * n;
    finding(ec, { key: `edge@${side}${seg}`, target: `${side}-${seg}`, frames: [rr[0][0], rr[rr.length - 1][1]], message: `${sideName[side]}边第 ${+seg + 1}/4 段有约 ${px} px 的清屏色暗带（${always ? '整片都有，像固定黑边' : `${list.length} 帧，首次 ${fmtRange(rr[0], fps)}`}）`, hint: always ? '整片固定黑边：检查画幅、信箱或底板是否整体没盖到边' : '只在部分帧出现：多半是相机运动时底板没盖满画框（底板出血不足），按 routes/directing/craft/two-five-d.md §2.1 的出血公式补' });
    foi.add(rr[0][0]);
  }
  ec.value = groups.size ? `${ec.findings.length} 处` : '无';
  checks.push(settle(ec));

  // ── 截断竖边（笔直、贯穿 ≥30% 画高、连续 ≥3 帧）──
  const el = makeCheck('visual.edge-line', { expected: `无贯穿 ≥ ${V.edgeLineMinFrac * 100}% 画高的笔直竖边` });
  const tracks = [];
  for (const L of S.lines) {
    const t = tracks.find(tr => tr.last === L.frame - 1 && Math.abs(tr.x - L.x) <= 2);
    if (t) { t.last = L.frame; t.x = L.x; t.n++; t.run = Math.max(t.run, L.run); }
    else tracks.push({ first: L.frame, last: L.frame, x: L.x, x0: L.x, n: 1, run: L.run, y0: L.y0, y1: L.y1 });
  }
  const long = tracks.filter(t => t.n >= 3).sort((a, b) => b.n * b.run - a.n * a.run);
  for (const t of long.slice(0, 8)) {
    finding(el, { key: `line@${t.first}:${t.x0}`, frames: [t.first, t.last + 1], message: `x≈${Math.round(t.x0 * scale)} px 处有一条笔直竖边，长 ${(t.run / size.h * 100).toFixed(0)}% 画高，持续 ${fmtRange([t.first, t.last + 1], fps)}`, hint: '人工看这几帧：若是底板 / 云片的截断边或直线淡出，按 craft/two-five-d.md 留出血或做软遮罩；建筑等真实竖线可忽略（这是启发式筛查）' });
    foi.add(t.first);
  }
  el.value = long.length ? `${long.length} 条候选` : '无';
  checks.push(settle(el));

  return {
    checks, source, warnings,
    series: { frames: n, yavg: S.yavg.map(x => +x.toFixed(2)), cutScore: score.map(x => +x.toFixed(2)), analysis: `${size.w}×${size.h}` },
    framesOfInterest: [...foi].sort((a, b) => a - b),
  };
}
