// 逐组比对被测与标准答案。合格：|被测−标准| ≤ rel·|标准| + abs；任一边非有限数单独计数并判不合格。
// 一组有多个输出分量时，任一分量不合格整组不合格。最差的几组按「差值 / 容差」排序。
// maxRel 统计全部分量；maxRelNonTiny 只统计 rel·|标准| ≥ abs 的分量，即不靠绝对容差兜底的地方。
// zeroRef 是标准答案整组为 0 的组数：带「返回零」分支的函数（半球检查不过等）用它报走到那一支的比例。
// skip(标准答案这一组, 被测这一组, 这一组的输入) 为真的组不比，只计数到 skipped：给登记表里写明了理由的病态区域用。
// needAbs 是让全部有限分量都合格所需的最小 abs（只靠 rel 时为 0），用来定 abs、核对「实测差值在 abs 的一半以内」。

/** @returns {{ groups, fails, nonFinite, zeroRef, skipped, needAbs, maxRel, maxRelNonTiny, worst: { index, input, ref, test, relErr, ratio }[] }} */
export function compare({ input, nIn, ref, test, nOut, rel, abs, skip, worst: keep = 5 }) {
  const groups = ref.length / nOut;
  let fails = 0, nonFinite = 0, zeroRef = 0, skipped = 0, needAbs = 0, maxRel = 0, maxRelNonTiny = 0;
  const worst = [];
  for (let g = 0; g < groups; g++) {
    if (skip?.(ref.subarray(g * nOut, (g + 1) * nOut), test.subarray(g * nOut, (g + 1) * nOut), input.subarray(g * nIn, (g + 1) * nIn))) { skipped++; continue; }
    let ratio = 0, relErr = 0, bad = false, zero = true;
    for (let k = g * nOut; k < (g + 1) * nOut; k++) {
      const r = ref[k], t = test[k];
      if (r !== 0) zero = false;
      if (!Number.isFinite(r) || !Number.isFinite(t)) { bad = true; ratio = Infinity; relErr = Infinity; continue; }
      const d = Math.abs(t - r), tol = rel * Math.abs(r) + abs;
      needAbs = Math.max(needAbs, d - rel * Math.abs(r));
      if (d > tol) bad = true;
      ratio = Math.max(ratio, d === 0 ? 0 : d / tol);
      if (r !== 0) relErr = Math.max(relErr, d / Math.abs(r));
      if (r !== 0 && rel * Math.abs(r) >= abs) maxRelNonTiny = Math.max(maxRelNonTiny, d / Math.abs(r));
    }
    if (relErr === Infinity) nonFinite++; else maxRel = Math.max(maxRel, relErr);
    if (bad) fails++;
    if (zero) zeroRef++;
    if (ratio > 0 && (worst.length < keep || ratio > worst[worst.length - 1].ratio)) {
      worst.push({ index: g, input: [...input.subarray(g * nIn, (g + 1) * nIn)], ref: [...ref.subarray(g * nOut, (g + 1) * nOut)], test: [...test.subarray(g * nOut, (g + 1) * nOut)], relErr, ratio });
      worst.sort((a, b) => b.ratio - a.ratio);
      if (worst.length > keep) worst.pop();
    }
  }
  return { groups, fails, nonFinite, zeroRef, skipped, needAbs, maxRel, maxRelNonTiny, worst };
}

/** float32 数 x 处的一个末位（相邻 float32 的间距）；0 与非规格数取最小规格数的末位 2^-149 */
export function ulpOf(x) {
  const e = (new Uint32Array(Float32Array.of(x).buffer)[0] >>> 23) & 0xff;
  return 2 ** (Math.max(e, 1) - 150);
}

/**
 * 分段平均偏差（以末位计）：默认对单输入、单输出的函数，被测减标准除以标准处的末位，按输入在每一段里对数等分成 bins 个小段求平均，
 * 每段取小段平均的绝对值最大者，超过这一段的 max 记一段不合格。查的是「误差随位置光滑变化、一段里同号」这种逐组比查不出的偏差。
 * segments：[{ lo, hi, bins, max }]，分段的量落在 [lo, hi) 的组进这一段。
 * of：可选，(标准这一组, 被测这一组, 输入这一组) => [分段的量, 以末位计的差]，给多输入、多输出或要折算的项用；差不是有限数的组不算
 * @returns {{ fails, segments: { lo, hi, max, worst, worstBin: [number, number], n }[] }}
 */
export function ulpBias({ input, ref, test, segments, nIn = 1, nOut = 1, of = (r, t, i) => [i[0], (t[0] - r[0]) / ulpOf(r[0])] }) {
  const groups = ref.length / nOut, xs = new Float64Array(groups), ds = new Float64Array(groups);
  for (let g = 0; g < groups; g++) [xs[g], ds[g]] = of(ref.subarray(g * nOut, (g + 1) * nOut), test.subarray(g * nOut, (g + 1) * nOut), input.subarray(g * nIn, (g + 1) * nIn));
  const out = segments.map(({ lo, hi, bins, max }) => {
    const sum = new Float64Array(bins), cnt = new Float64Array(bins), w = Math.log(hi / lo) / bins;
    for (let g = 0; g < groups; g++) {
      const x = xs[g];
      if (!(x >= lo && x < hi) || !Number.isFinite(ds[g])) continue;
      const k = Math.min(bins - 1, Math.floor(Math.log(x / lo) / w));
      sum[k] += ds[g];
      cnt[k]++;
    }
    let worst = 0, at = 0;
    for (let k = 0; k < bins; k++) if (cnt[k] && Math.abs(sum[k] / cnt[k]) >= Math.abs(worst)) { worst = sum[k] / cnt[k]; at = k; }
    return { lo, hi, max, worst, worstBin: [lo * Math.exp(at * w), lo * Math.exp((at + 1) * w)], n: cnt.reduce((a, b) => a + b, 0) };
  });
  return { fails: out.filter(s => !(Math.abs(s.worst) <= s.max) || s.n === 0).length, segments: out };
}
