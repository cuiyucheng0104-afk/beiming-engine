// 时间键契约的判定函数：每条不变量一个，照 CONTRACT.md 第 4 节「怎么查」一栏写。
// 输入是一份时间核对记录（time-check/0.1），返回这条不变量下发现的问题；空数组表示没违反。
// 记录里没出现的段不判。本契约的内嵌值（时间键、帧率）单独出现时不归这些条文管，一律返回空数组。

const shotOf = (rec, id) => rec.shots.find((s) => s.id === id);
const gcd = (a, b) => (b ? gcd(b, a % b) : a); // 用 BigInt 调：字符串里的整数不设上限（写法约定「数值」）
const sameKey = (k, frame) => k.frame === frame && k.sub === 0;
/** 这一帧生效的快门角，记录里每帧都写 */
const angleOf = (rec, fr) => fr.shutterAngleDeg;

/** 把条目按 key 分组，返回摘要不止一种的组的 key */
function mixedDigests(items, keyOf) {
  const seen = new Map();
  for (const it of items ?? []) {
    const k = keyOf(it);
    seen.set(k, (seen.get(k) ?? new Set()).add(it.digest));
  }
  return [...seen].filter(([, digests]) => digests.size > 1).map(([k]) => k);
}

/** 记录里除了顶层 fps 之外还有哪些地方出现了名叫 fps 的字段 */
function extraFps(node, path, out) {
  if (Array.isArray(node)) node.forEach((v, i) => extraFps(v, `${path}[${i}]`, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'fps' && path !== '') out.push(`${path}.fps`);
      extraFps(v, path === '' ? k : `${path}.${k}`, out);
    }
  }
  return out;
}

const onRecord = (fn) => (obj) => (obj?.format === 'time-check/0.1' ? fn(obj) : []);

const raw = {
  T1: (rec) => mixedDigests(rec.evaluations, (e) => `${e.shot} f=${e.f} sub=${e.sub}`)
    .map((k) => `同一个时刻求出了不同的状态：${k}`),

  T2: (rec) => (rec.scan?.wallClock ?? []).map((h) => `读了墙钟：${h.path} ${h.call}`),

  T3: (rec) => {
    const m = /^([1-9]\d*)\/([1-9]\d*)$/.exec(rec.fps);
    if (!m) return [`帧率写法不对：${rec.fps}`];
    if (gcd(BigInt(m[1]), BigInt(m[2])) !== 1n) return [`帧率没有约到最简：${rec.fps}`];
    return extraFps(rec, '', []).map((p) => `别处又出现了帧率：${p}`);
  },

  T4: (rec) => (rec.frames ?? []).flatMap((fr) => {
    const shot = shotOf(rec, fr.shot);
    return fr.samples.flatMap((s, i) => [
      ...(s.frame >= shot.start && s.frame < shot.start + shot.frames ? [] : [`第 ${fr.frame} 帧的采样 ${i} 落在镜头 ${fr.shot} 的帧区间之外`]),
      ...(s.shot === fr.shot ? [] : [`第 ${fr.frame} 帧的采样 ${i} 求的是镜头 ${s.shot} 的状态`]),
    ]);
  }),

  T5: (rec) => (rec.frames ?? []).flatMap((fr) => {
    const angle = angleOf(rec, fr);
    if (angle === 0) {
      return fr.samples.length === 1 && sameKey(fr.samples[0], fr.frame) ? [] : [`第 ${fr.frame} 帧：快门角是 0，必须只有 sub = 0 一个采样`];
    }
    return fr.samples
      .filter((s) => s.frame !== fr.frame || s.sub >= angle / 360)
      .map((s) => `第 ${fr.frame} 帧的采样 (${s.frame}, ${s.sub}) 不在快门窗口里`);
  }),

  T6: (rec) => (rec.frames ?? [])
    .filter((fr) => fr.accumulation?.linearErr > 1e-4) // 没量出来就不出现，不判
    .map((fr) => `第 ${fr.frame} 帧的累积颜色层对线性平均的预言图差了 ${fr.accumulation.linearErr}，超过 1e-4`),

  T7: (rec) => (rec.frames ?? [])
    .filter((fr) => fr.accumulation?.postRuns !== undefined && (fr.accumulation.postRuns !== 1 || fr.accumulation.postInput !== 'average'))
    .map((fr) => `第 ${fr.frame} 帧的后期链跑了 ${fr.accumulation.postRuns} 次，输入是 ${fr.accumulation.postInput}`),

  T8: (rec) => (rec.frames ?? []).flatMap((fr) => {
    const out = [];
    if (fr.aux && !sameKey(fr.aux, fr.frame)) out.push(`第 ${fr.frame} 帧的辅助层取在 (${fr.aux.frame}, ${fr.aux.sub})`);
    if (fr.postDepth && !sameKey(fr.postDepth, fr.frame)) out.push(`第 ${fr.frame} 帧后期用的深度取在 (${fr.postDepth.frame}, ${fr.postDepth.sub})`);
    if (fr.auxMismatch > 0) out.push(`第 ${fr.frame} 帧的编号层对 sub = 0、针孔、像素中心的预言图，边缘带之外有 ${fr.auxMismatch} 个像素对不上`); // 没量出来就不出现，不判
    return out;
  }),

  T9: (rec) => [
    ...(rec.frames ?? [])
      .filter((fr) => fr.f !== fr.frame - shotOf(rec, fr.shot).start)
      .map((fr) => `第 ${fr.frame} 帧交给镜头代码的帧号是 ${fr.f}`),
    ...(rec.localized ?? [])
      .filter((l) => l.f !== l.frame - shotOf(rec, l.shot).start)
      .map((l) => `全片第 ${l.frame} 帧交给镜头 ${l.shot} 的镜头代码或卡时成了 ${l.f}`),
  ],

  T10: (rec) => (rec.holds ?? [])
    .filter((h) => h.result !== h.f - (h.f % h.n))
    .map((h) => `hold(${h.f}, ${h.n}) 返回了 ${h.result}`),

  T11: (rec) => (rec.scan?.unseededRandom ?? []).map((h) => `用了不带种子的随机：${h.path} ${h.call}`),

  T12: (rec) => (rec.rng ?? [])
    .filter((r) => !/^[^/\s]+\/[^/\s]+$/.test(r.arg) || r.name !== `${shotOf(rec, r.shot).seed}/${r.shot}/${r.arg}`)
    .map((r) => `流名 ${r.name} 和参数 ${r.arg} 对不上`),

  T13: (rec) => mixedDigests(rec.rng, (r) => r.name).map((k) => `同名的随机流出了不同的序列：${k}`),

  T14: (rec) => (rec.frames ?? []).filter((fr) => fr.accumulation).flatMap((fr) => {
    const n = fr.samples.length, win = angleOf(rec, fr) / 360;
    return fr.samples.map((s) => s.sub).sort((a, b) => a - b)
      .flatMap((sub, i) => (sub === ((i + 0.5) / n) * win ? [] : [`第 ${fr.frame} 帧按相位数的第 ${i} 个采样在 ${sub}，居中分层应该在 ${((i + 0.5) / n) * win}`]));
  }),
};

export const checks = Object.fromEntries(Object.entries(raw).map(([id, fn]) => [id, onRecord(fn)]));
