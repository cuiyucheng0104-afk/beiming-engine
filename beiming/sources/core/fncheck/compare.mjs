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
