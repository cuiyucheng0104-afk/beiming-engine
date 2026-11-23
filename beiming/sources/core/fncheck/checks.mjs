// 采样一类函数的统计检验，被测函数都在显卡上算（WGSL 原文由调用方拼好）。
//   directionChi2：采样出的方向分箱，与概率密度在各箱上的数值积分比，做 χ² 检验（采样与概率密度配不配对）。
//   ggxAlbedo：对出射半球数值积分求值结果，得到方向反照率（能量守恒）。
//   gridChi2：样本先映射到单位正方形上（例如面光：采样方向打在灯面上的局部坐标），按网格分箱做 χ² 检验。
//   mcMean：一个采样估计量在显卡上逐样本算、回到 JS 用双精度求平均（面光辐照度对解析形状因子）。
// 两者都不依赖 Cycles：比的是我方采样函数与我方概率密度函数彼此是否一致，以及求值的积分是否不超过 1。
import { makeInputs } from './run.mjs';
import { runGpu } from './gpu.mjs';

/** 包一个计算着色器：每线程执行 body，inp 至少被读一次（自动布局只收被用到的绑定） */
const job = (source, helpers, body) => `${source}
${helpers}
@group(0) @binding(0) var<storage, read> inp: array<f32>;
@group(0) @binding(1) var<storage, read_write> outp: array<f32>;
@compute @workgroup_size(64)
fn fncheck_main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let i = gid.y * nwg.x * 64u + gid.x;
  _ = inp[0];
  ${body}
}
`;

/** ln Γ(x)，Lanczos 近似（g = 7，9 项），x > 0 时相对误差约 1e-15 */
function lnGamma(x) {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let k = 1; k < 9; k++) a += c[k] / (x + k);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** 正则化上不完全伽马函数 Q(a, x) = Γ(a, x)/Γ(a)：x < a + 1 用级数求 P 再取 1 − P，否则用连分式（Lentz 法） */
export function gammaQ(a, x) {
  if (x <= 0) return 1;
  const lead = -x + a * Math.log(x) - lnGamma(a);
  if (x < a + 1) {
    let sum = 1 / a, term = sum;
    for (let n = 1; n < 100_000 && Math.abs(term) > Math.abs(sum) * 1e-15; n++) sum += (term *= x / (a + n));
    return 1 - sum * Math.exp(lead);
  }
  const tiny = 1e-300;
  let b = x + 1 - a, c = 1 / tiny, d = 1 / b, h = d;
  for (let n = 1; n < 100_000; n++) {
    const an = -n * (n - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.exp(lead) * h;
}

/**
 * Pearson χ² 拟合优度检验。期望频数小于 minExpected 的箱合成一箱；合起来仍不够时并进期望最小的那一箱。
 * 有箱期望为 0 却落了样本，说明采样到了概率密度为零的地方，直接判 p = 0。自由度 = 合并后的箱数 − 1。
 */
export function chi2Test(observed, expected, { minExpected = 5 } = {}) {
  for (let i = 0; i < expected.length; i++) if (expected[i] <= 0 && observed[i] > 0) return { chi2: Infinity, dof: 0, p: 0, bins: 0, zeroBin: i };
  const kept = [];
  const pool = { o: 0, e: 0 };
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] < minExpected) { pool.o += observed[i]; pool.e += expected[i]; } else kept.push({ o: observed[i], e: expected[i] });
  }
  if (pool.e > 0) {
    if (pool.e >= minExpected || !kept.length) kept.push(pool);
    else { const m = kept.reduce((a, b) => (b.e < a.e ? b : a)); m.o += pool.o; m.e += pool.e; }
  }
  const chi2 = kept.reduce((s, { o, e }) => s + (o - e) ** 2 / e, 0);
  const dof = kept.length - 1;
  return { chi2, dof, p: dof > 0 ? gammaQ(dof / 2, chi2 / 2) : 1, bins: kept.length };
}

/**
 * 方向采样的 χ² 检验。cases: [{ name, sample, pdf, ...其余原样带回 }]：
 *   sample 是 WGSL 表达式，用变量 u（vec3f，[0,1) 均匀数）给出 vec4f(方向, 1 有效 | 0 被拒)；
 *   pdf 是 WGSL 表达式，用变量 wo（单位向量）给出立体角测度的概率密度。
 * 分箱：θ ∈ [0, π] 等分 nTheta 份、φ ∈ [0, 2π) 等分 nPhi 份，覆盖整个球面；另加一箱「被拒」，
 * 它的期望是 n·(1 − 全部箱的积分)。各箱期望 = n·∫箱 pdf dω，每箱内 sub×sub 个点的中点法，被积函数 pdf·sinθ。
 * 所有 case 共用同一串均匀数 u（mulberry32，种子 seed）。返回每个 case 的 { chi2, dof, p, bins, lost: { observed, expected } }。
 */
export async function directionChi2({ source, cases, n = 1_000_000, seed = 1, nTheta = 64, nPhi = 64, sub = 32 }) {
  const u = makeInputs({ name: 'directionChi2', inputs: [['u', 'vec3f', [0, 1]]] }, n, seed);
  const nb = nTheta * nPhi;
  const jobs = cases.flatMap((c, k) => [
    { name: `s${k}`, input: u, n, nOut: 4, code: job(source, `fn chi2_sample(u: vec3f) -> vec4f { return ${c.sample}; }`, `
  if (i >= ${n}u) { return; }
  let r = chi2_sample(vec3f(inp[i * 3u], inp[i * 3u + 1u], inp[i * 3u + 2u]));
  outp[i * 4u] = r.x; outp[i * 4u + 1u] = r.y; outp[i * 4u + 2u] = r.z; outp[i * 4u + 3u] = r.w;`) },
    { name: `p${k}`, input: new Float32Array(1), n: nb, nOut: 1, code: job(source, `fn chi2_pdf(wo: vec3f) -> f32 { return ${c.pdf}; }`, `
  if (i >= ${nb}u) { return; }
  let dt = ${Math.PI / nTheta / sub};
  let dp = ${(2 * Math.PI) / nPhi / sub};
  var sum = 0.0;
  for (var a = 0u; a < ${sub}u; a++) {
    let theta = (f32((i / ${nPhi}u) * ${sub}u + a) + 0.5) * dt;
    for (var b = 0u; b < ${sub}u; b++) {
      let phi = (f32((i % ${nPhi}u) * ${sub}u + b) + 0.5) * dp;
      sum += chi2_pdf(vec3f(sin(theta) * cos(phi), sin(theta) * sin(phi), cos(theta))) * sin(theta);
    }
  }
  outp[i] = sum * dt * dp;`) },
  ]);
  const { outputs } = await runGpu(jobs);
  return cases.map((c, k) => {
    const s = outputs[2 * k], integral = outputs[2 * k + 1];
    const observed = new Float64Array(nb + 1), expected = new Float64Array(nb + 1);
    for (let i = 0; i < n; i++) {
      if (s[4 * i + 3] === 0) { observed[nb]++; continue; }
      const x = s[4 * i], y = s[4 * i + 1], z = s[4 * i + 2];
      const t = Math.min(nTheta - 1, Math.floor((Math.acos(Math.max(-1, Math.min(1, z / Math.hypot(x, y, z)))) / Math.PI) * nTheta));
      const p = Math.min(nPhi - 1, Math.floor((((Math.atan2(y, x) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI)) * nPhi));
      observed[t * nPhi + p]++;
    }
    let total = 0;
    for (let b = 0; b < nb; b++) total += (expected[b] = n * integral[b]);
    // 被拒那一箱的期望是两个大数之差，数值积分的误差全落在它上面；算出来略小于 0 时按 0
    expected[nb] = Math.max(0, n - total);
    return { ...c, ...chi2Test(observed, expected), lost: { observed: observed[nb], expected: expected[nb] } };
  });
}

/**
 * 单位正方形上的 χ² 检验，用于支撑集是一块有界区域的采样（面光）：在球面 θ、φ 箱上，指示函数形状的概率密度在区域边上
 * 被中点法积成 0 的细条里仍会落样本，误判为采样到了概率密度为零的地方；映射到区域自己的坐标上，箱的边界与支撑集的边界重合。
 * cases: [{ name, sample, density, ...其余原样带回 }]：sample 是用变量 u（vec3f，[0,1) 均匀数）写的 WGSL 表达式，给出
 * vec3f(x, y, 1 有效 | 0 被拒)，x、y ∈ [0, 1]；density 是用变量 p（vec2f）写的 WGSL 表达式，给出对 dx·dy 的概率密度。
 * nx×ny 个箱，每箱 sub×sub 个点的中点法，另加一箱「被拒」，期望 n·(1 − 全部箱的积分)。返回同 directionChi2。
 */
export async function gridChi2({ source, cases, n = 1_000_000, seed = 1, nx = 64, ny = 64, sub = 8 }) {
  const u = makeInputs({ name: 'gridChi2', inputs: [['u', 'vec3f', [0, 1]]] }, n, seed);
  const nb = nx * ny;
  const jobs = cases.flatMap((c, k) => [
    { name: `s${k}`, input: u, n, nOut: 3, code: job(source, `fn grid_sample(u: vec3f) -> vec3f { return ${c.sample}; }`, `
  if (i >= ${n}u) { return; }
  let r = grid_sample(vec3f(inp[i * 3u], inp[i * 3u + 1u], inp[i * 3u + 2u]));
  outp[i * 3u] = r.x; outp[i * 3u + 1u] = r.y; outp[i * 3u + 2u] = r.z;`) },
    { name: `p${k}`, input: new Float32Array(1), n: nb, nOut: 1, code: job(source, `fn grid_density(p: vec2f) -> f32 { return ${c.density}; }`, `
  if (i >= ${nb}u) { return; }
  var sum = 0.0;
  for (var a = 0u; a < ${sub}u; a++) {
    for (var b = 0u; b < ${sub}u; b++) {
      sum += grid_density(vec2f((f32((i % ${nx}u) * ${sub}u + a) + 0.5) / ${nx * sub}.0, (f32((i / ${nx}u) * ${sub}u + b) + 0.5) / ${ny * sub}.0));
    }
  }
  outp[i] = sum / ${nx * ny * sub * sub}.0;`) },
  ]);
  const { outputs } = await runGpu(jobs);
  return cases.map((c, k) => {
    const s = outputs[2 * k], integral = outputs[2 * k + 1];
    const observed = new Float64Array(nb + 1), expected = new Float64Array(nb + 1);
    for (let i = 0; i < n; i++) {
      if (s[3 * i + 2] === 0) { observed[nb]++; continue; }
      const x = Math.min(nx - 1, Math.max(0, Math.floor(s[3 * i] * nx))), y = Math.min(ny - 1, Math.max(0, Math.floor(s[3 * i + 1] * ny)));
      observed[y * nx + x]++;
    }
    let total = 0;
    for (let b = 0; b < nb; b++) total += (expected[b] = n * integral[b]);
    expected[nb] = Math.max(0, n - total);
    return { ...c, ...chi2Test(observed, expected), lost: { observed: observed[nb], expected: expected[nb] } };
  });
}

/**
 * GGX 一类闭包的方向反照率 ∫ eval(wi, wo) dωo（eval 是 Cycles 约定的求值结果，已含出射方向的余弦，不再乘）。
 * cases: [{ alpha, cosI, eval }]，eval 是 WGSL 表达式，可用 N = (0,0,1)、wi = (sinθi, 0, cosθi)、wo、alpha（各向同性）。
 * 积分换到半向量 h 上：∫ f(wo) dωo = ∫_{wi·h>0} f(wo(h))·4(wi·h) dωh。h 按 GGX 的 D(h)·cos θh 做确定的分层：
 * ξ1、ξ2 各取 m 个中点，tan²θh = t² = alpha²·ξ1/(1−ξ1)、φ = 2πξ2，权重 4(wi·h)/(D·cos θh)/m²。
 * 这里的 D 用 t² 写成 alpha²(1+t²)²/(π(t²+alpha²)²)，不经 1 − cos²，免得求积自己带进 float32 的相消噪声。
 * 被积函数在 h 上是平滑的（D 已被约掉），低粗糙度也不会漏掉尖峰。每个线程累加一行，回到 JS 用双精度相加。
 */
export async function ggxAlbedo({ source, cases, m = 1024 }) {
  const jobs = cases.map((c, k) => ({ name: `a${k}`, input: new Float32Array(1), n: m, nOut: 1, code: job(source, `fn albedo_eval(N: vec3f, wi: vec3f, wo: vec3f, alpha: f32) -> f32 { return ${c.eval}; }`, `
  if (i >= ${m}u) { return; }
  let alpha = f32(${c.alpha});
  let cos_i = f32(${c.cosI});
  let N = vec3f(0.0, 0.0, 1.0);
  let wi = vec3f(sqrt(max(1.0 - cos_i * cos_i, 0.0)), 0.0, cos_i);
  let xi1 = (f32(i) + 0.5) / ${m}.0;
  let t2 = alpha * alpha * xi1 / (1.0 - xi1);
  let cos_h = 1.0 / sqrt(1.0 + t2);
  let sin_h = sqrt(max(1.0 - cos_h * cos_h, 0.0));
  let a2 = alpha * alpha;
  let pdf_h = a2 * sqr(1.0 + t2) / (M_PI_F * sqr(t2 + a2)) * cos_h;
  var sum = 0.0;
  for (var j = 0u; j < ${m}u; j++) {
    let phi = 6.283185307179586 * (f32(j) + 0.5) / ${m}.0;
    let h = vec3f(sin_h * cos(phi), sin_h * sin(phi), cos_h);
    let wi_h = dot(wi, h);
    if (wi_h <= 0.0) { continue; }
    sum += albedo_eval(N, wi, 2.0 * wi_h * h - wi, alpha) * 4.0 * wi_h / pdf_h;
  }
  outp[i] = sum;`) }));
  const { outputs } = await runGpu(jobs);
  return outputs.map(rows => rows.reduce((s, v) => s + v, 0) / (m * m));
}

/** 蒙特卡洛均值。cases: [{ expr }]，expr 是用变量 u（vec3f，[0,1) 均匀数）写的 WGSL 表达式，给出一个样本的估计值。
 *  所有 case 共用同一串 u。返回每个 case 的 { mean, stderr }（标准误差 = 样本标准差 / √n） */
export async function mcMean({ source, cases, n = 1_000_000, seed = 1 }) {
  const u = makeInputs({ name: 'mcMean', inputs: [['u', 'vec3f', [0, 1]]] }, n, seed);
  const { outputs } = await runGpu(cases.map((c, k) => ({ name: `m${k}`, input: u, n, nOut: 1, code: job(source, `fn mc_sample(u: vec3f) -> f32 { return ${c.expr}; }`, `
  if (i >= ${n}u) { return; }
  outp[i] = mc_sample(vec3f(inp[i * 3u], inp[i * 3u + 1u], inp[i * 3u + 2u]));`) })));
  return outputs.map(o => {
    let s = 0, s2 = 0;
    for (const v of o) { s += v; s2 += v * v; }
    const mean = s / n;
    return { mean, stderr: Math.sqrt(Math.max(0, s2 / n - mean * mean) / n) };
  });
}
