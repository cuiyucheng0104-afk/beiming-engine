// -*- coding: utf-8 -*-
// 北冥 96 带 ERB 再合成 · GPU 执行器（nvcc + cuFFT）。
// 执行 core.plan() 产出的一组 Plan：同一个模型、同一个 m_base、同样开关的 T 条 take 一起算，数值与 core._execute_numpy 一一对应
// （载波构造 → 纹理重抽 → exact 轮交替投影（含起音/颗粒时域约束）→ 合成 → 末轮起音约束 → 裁剪）。
// 由 gpu.py 用 nvcc 现场编译成共享库、ctypes 调用；结构体 ErbGroup 的字段顺序必须与 gpu.py 的 _Group 完全一致。
#include <cuda_runtime.h>
#include <cufft.h>
#include <curand_kernel.h>
#include <cub/block/block_reduce.cuh>
#include <cub/block/block_scan.cuh>

#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <algorithm>
#include <cstdio>
#include <map>
#include <string>
#include <tuple>
#include <vector>

extern "C" {
struct ErbGroup {
  int T, C, NB, M, N, MA, K, L, OUTM, OUTN, KTOT, NPEAK;
  int stereo_mode, use_on, use_grain, use_reseed, final_on, final_post, exact, noise_mode;
  int kw_on[4], kw_gr[3], kw_gs, pre_n, an_n, ramp_n;
  double floor2, eps_proj, onset_max_gain, grain_gmin, grain_gmax, post_len[3], hold_pre, hold_post, hold_ramp;
  const float *env, *kappa, *omega, *grain, *grain_w, *prof, *ild, *sq_p, *sq_m, *sg, *turn, *hf_wt, *sigma_b, *imp_scale;
  const int *grp, *rwin;
  const int *bin_b0, *bin_u0, *bin_b1, *bin_u1;
  const float *bin_w0, *bin_w1;
  const int *flat_b, *flat_u, *flat_k;
  const float *flat_w, *band_mask, *lo_m, *hi_m;
  const int* ti;
  const double *td, *src_pos;
  const float *imp_t, *w_atk;
  const int *rs_i0, *rs_mode;
  const float *rs_frac, *rs_roll, *glin, *eq;
  const int* peak_pos;
  const double* peak_amp;
  const float *peak_ph, *init_phi;
  const int* on_samp;
  const double *on_slope, *post_slope;
  const int *pre_lo, *pre_ci;
  const float *att_prot, *pan;
  const unsigned long long* seeds;
  const float *noise, *wtd;
  float* out;
};
}

namespace {

constexpr int TI = 7;      // 每条 take 的整数参数：out_n, out_m, pad_base, peak_off, npeak, has_eq, has_hard
constexpr int TD = 3;      // 每条 take 的浮点参数：freq_scale, hard, alpha(=min(1, vary))
constexpr int DEC = 8;
constexpr int BT = 256;    // 逐元素与逐行核的线程数
constexpr int SBT = 1024;  // 前缀和核的线程数

char g_err[1024];
bool g_prof = false;  // 分项计时（erb_profile(1) 打开）：每个内核前后同步，只用来看耗时分布，平时关着
std::map<std::string, std::pair<double, int>> g_times;
struct Tick {
  const char* name;
  std::chrono::steady_clock::time_point t0;
  bool on;
  explicit Tick(const char* n) : name(n), on(g_prof) {
    if (on) {
      cudaDeviceSynchronize();
      t0 = std::chrono::steady_clock::now();
    }
  }
  ~Tick() {
    if (on) {
      cudaDeviceSynchronize();
      auto& e = g_times[name];
      e.first += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
      e.second++;
    }
  }
};
bool g_oom = false;  // 本次失败是不是显存不够（主机侧据此减半分块重试）
size_t g_base_used = 0, g_peak = 0;  // 渲染开始时的已用显存、本次渲染相对它的最大增量（仅 g_prof 打开时采样）
void probe() {
  if (!g_prof) return;
  size_t f = 0, t = 0;
  if (cudaMemGetInfo(&f, &t) == cudaSuccess && t - f > g_base_used) g_peak = std::max(g_peak, t - f - g_base_used);
}
std::map<std::tuple<int, int, int>, cufftHandle> g_plans;

#define FAIL(...)                                    \
  do {                                               \
    snprintf(g_err, sizeof g_err, __VA_ARGS__);      \
    return -1;                                       \
  } while (0)
#define CK(x)                                                                                        \
  do {                                                                                               \
    cudaError_t e_ = (x);                                                                            \
    if (e_ != cudaSuccess) {                                                                         \
      if (e_ == cudaErrorMemoryAllocation) g_oom = true;                                             \
      FAIL("%s:%d %s -> %s", __FILE__, __LINE__, #x, cudaGetErrorString(e_));                        \
    }                                                                                                \
  } while (0)
#define CF(x)                                                                         \
  do {                                                                                \
    cufftResult r_;                                                                   \
    {                                                                                 \
      Tick tk_(#x);                                                                   \
      r_ = (x);                                                                       \
    }                                                                                 \
    if (r_ != CUFFT_SUCCESS) {                                                        \
      if (r_ == CUFFT_ALLOC_FAILED) g_oom = true;                                     \
      FAIL("%s:%d %s -> cufft %d", __FILE__, __LINE__, #x, (int)r_);                  \
    }                                                                                 \
  } while (0)
#define LAUNCH(k, total, ...)                                          \
  do {                                                                 \
    size_t n_ = (total);                                               \
    if (n_) {                                                          \
      {                                                                \
        Tick tk_(#k);                                                  \
        k<<<(unsigned)((n_ + BT - 1) / BT), BT>>>(__VA_ARGS__);        \
      }                                                                \
      CK(cudaGetLastError());                                          \
    }                                                                  \
  } while (0)
#define KL(k, grid, block, ...)                       \
  do {                                                \
    {                                                 \
      Tick tk_(#k);                                   \
      k<<<(grid), (block)>>>(__VA_ARGS__);            \
    }                                                 \
    CK(cudaGetLastError());                           \
  } while (0)
#define CALL(x)            \
  do {                     \
    if ((x) != 0) return -1; \
  } while (0)

struct Arena {  // 这一组用到的全部显存（流序分配，退出时统一释放）
  std::vector<void*> ptrs;
  bool bad = false;  // 任何一次分配失败都记下来，调用方统一检查（上传参数时一口气分配几十块）
  ~Arena() {
    for (void* p : ptrs)
      if (p) cudaFreeAsync(p, 0);
  }
  template <class T>
  T* get(size_t n) {
    void* p = nullptr;
    if (cudaMallocAsync(&p, (n ? n : 1) * sizeof(T), 0) != cudaSuccess) {
      bad = g_oom = true;
      cudaGetLastError();  // 清掉这次的错误码，别让它污染后面的检查
      return nullptr;
    }
    ptrs.push_back(p);
    return (T*)p;
  }
  void release(void* p) {
    for (auto& q : ptrs)
      if (q && q == p) {
        cudaFreeAsync(q, 0);
        q = nullptr;
      }
  }
};

struct Dev {  // 传给每个核的只读参数（设备指针 + 尺寸 + 常数）
  int T, C, NB, M, N, NBIN, MA, K, L, OUTM, OUTN, KTOT, NPEAK;
  int stereo_mode, use_on, use_grain, use_reseed;
  int kw_on[4], kw_gr[3], kw_gs, pre_n, an_n, ramp_n;
  float floor2, eps_proj;
  double onset_max_gain, grain_gmin, grain_gmax, post_len[3], hold_pre, hold_post, hold_ramp;
  const float *env, *kappa, *omega, *grain, *grain_w, *prof, *ild, *sq_p, *sq_m, *sg, *hf_wt, *sigma_b, *imp_scale;
  const float2* turn;
  const int *grp, *rwin, *bin_b0, *bin_u0, *bin_b1, *bin_u1, *flat_b, *flat_u, *flat_k;
  const float *bin_w0, *bin_w1, *flat_w, *band_mask, *lo_m, *hi_m;
  const int* ti;
  const double *td, *src_pos;
  const float *imp_t, *w_atk;
  const int *rs_i0, *rs_mode;
  const float *rs_frac, *rs_roll, *glin, *eq;
  const int* peak_pos;
  const double* peak_amp;
  const float2* peak_ph;
  const float* init_phi;
  const int* on_samp;
  const double *on_slope, *post_slope;
  const int *pre_lo, *pre_ci;
  const float *att_prot, *pan;
  const unsigned long long* seeds;
};

__device__ inline size_t gidx() { return (size_t)blockIdx.x * blockDim.x + threadIdx.x; }
__device__ inline float2 cmul(float2 a, float2 b) { return make_float2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }

// scipy.ndimage.uniform_filter1d 的窗口：[i - size/2, i + size - size/2 - 1]；S 是长度 n+1 的前缀和
__device__ inline double box_reflect(const double* S, int n, int i, int size) {
  int s1 = size / 2, s2 = size - s1 - 1, lo = i - s1, hi = i + s2;
  double tot = S[min(hi, n - 1) + 1] - S[max(lo, 0)];
  if (lo < 0) tot += S[-lo];
  if (hi >= n) tot += S[n] - S[2 * n - hi - 1];
  return tot / size;
}
__device__ inline double box_nearest(const double* S, const double* x, int n, int i, int size) {
  int s1 = size / 2, s2 = size - s1 - 1, lo = i - s1, hi = i + s2;
  double tot = S[min(hi, n - 1) + 1] - S[max(lo, 0)];
  if (lo < 0) tot += (double)(-lo) * x[0];
  if (hi >= n) tot += (double)(hi - n + 1) * x[n - 1];
  return tot / size;
}
__device__ inline double box9(const float* g, int n, int i) {  // uniform_filter1d(g, 9)，reflect 边界
  double s = 0.0;
  for (int k = i - 4; k <= i + 4; ++k) s += (double)g[k < 0 ? -k - 1 : (k >= n ? 2 * n - k - 1 : k)];
  return s / 9.0;
}
__device__ inline double interp1(double x, const float* fp, int n) {  // np.interp(x, arange(n), fp)
  if (x <= 0.0) return fp[0];
  if (x >= n - 1) return fp[n - 1];
  int j = (int)floor(x);
  return (double)fp[j] + (x - j) * ((double)fp[j + 1] - (double)fp[j]);
}

// ———— 张量构造：时间轴插值 + ERB 轴缩放 + 增益 + 静音门限 ————
__global__ void k_build(Dev d, float* A, float* Kf, float* OM) {
  size_t idx = gidx();
  if (idx >= (size_t)d.T * d.NB * d.M) return;
  int m = (int)(idx % d.M), b = (int)((idx / d.M) % d.NB), t = (int)(idx / ((size_t)d.M * d.NB));
  const int* ti = d.ti + t * TI;
  const double* td = d.td + t * TD;
  int mo = m - ti[2];
  float a = 0.f, kk = 0.f, om = 0.f;
  if (mo >= 0 && mo < ti[1]) {
    double sp = d.src_pos[(size_t)t * d.OUTM + mo];
    int i0t = min((int)floor(sp), d.MA - 1), i1t = min(i0t + 1, d.MA - 1);  // 主机保证 sp ≤ MA-1，这里再夹一道防越界
    float ft = (float)(sp - (double)i0t);
    int rb = t * d.NB + b, mode = d.rs_mode[rb];
    auto tv = [&](const float* arr, int bb) {
      return (1.f - ft) * arr[(size_t)bb * d.MA + i0t] + ft * arr[(size_t)bb * d.MA + i1t];
    };
    float e, k2, o;
    if (mode == 0) {
      int ia = d.rs_i0[rb], ib = min(ia + 1, d.NB - 1);
      float fb = d.rs_frac[rb], fa = 1.f - fb;
      e = fa * tv(d.env, ia) + fb * tv(d.env, ib);
      k2 = fa * tv(d.kappa, ia) + fb * tv(d.kappa, ib);
      o = fa * tv(d.omega, ia) + fb * tv(d.omega, ib);
    } else {
      int bb = (mode == 1) ? d.NB - 1 : 0;
      float r = d.rs_roll[rb];
      e = tv(d.env, bb) * r;
      k2 = tv(d.kappa, bb) * r;
      o = tv(d.omega, bb) * r;
    }
    kk = fminf(fmaxf(k2, 0.f), 1.f);
    om = o * (float)td[0];
    e = e * d.glin[rb];
    if (ti[5]) {
      float w = d.w_atk[(size_t)t * d.OUTM + mo], e0 = d.eq[(size_t)(t * 2) * d.NB + b], e1 = d.eq[(size_t)(t * 2 + 1) * d.NB + b];
      e = e * powf(10.f, (e1 + w * (e0 - e1)) / 20.f);
    }
    if (ti[6]) {
      float hd = (float)(4.5 * td[1]) * d.hf_wt[b] * fmaxf(d.imp_t[(size_t)t * d.OUTM + mo], 0.15f);
      e = e * powf(10.f, hd / 20.f);
    }
    a = (e < d.floor2) ? 0.f : e;
  }
  A[idx] = a;
  Kf[idx] = kk;
  OM[idx] = om;
}

// 相干载波：瞬时角频率沿时间积分（double 前缀和）再取 exp(i·beta)
__global__ void k_coh(Dev d, const float* OM, float2* coh) {
  int row = blockIdx.x;
  const float* x = OM + (size_t)row * d.M;
  float2* y = coh + (size_t)row * d.M;
  float phi = d.init_phi[row];
  typedef cub::BlockScan<double, BT> BS;
  __shared__ typename BS::TempStorage tmp;
  double carry = 0.0;
  for (int base = 0; base < d.M; base += BT) {
    int i = base + threadIdx.x;
    double v = (i < d.M) ? (double)x[i] : 0.0, incl, agg;
    BS(tmp).InclusiveSum(v, incl, agg);
    __syncthreads();
    if (i < d.M) {
      float beta = (float)(carry + incl) + phi, s, c;
      sincosf(beta, &s, &c);
      y[i] = make_float2(c, s);
    }
    carry += agg;
  }
}

// 跨带同相微冲激（相量与幅度由 core._impulse_peaks 在主机侧抽好，每条 take 的冲激按位置升序排好）：
// 每格一个线程，二分找到窗内第一个冲激，按位置顺序累加（不用原子加，同一输入必得同一输出），再单位化。
// 每个冲激只影响 ±54 帧，相邻冲激至少隔 9 帧，所以一格最多累加十几个。
__global__ void k_imp(Dev d, float2* impc, float* impw) {
  size_t idx = gidx();
  if (idx >= (size_t)d.T * d.NB * d.M) return;
  int m = (int)(idx % d.M), b = (int)((idx / d.M) % d.NB), t = (int)(idx / ((size_t)d.M * d.NB));
  const int* ti = d.ti + t * TI;
  int off = ti[3], np_ = ti[4], lo = 0, hi = np_;
  while (lo < hi) {
    int mid = (lo + hi) / 2;
    if (d.peak_pos[off + mid] < m - 54) lo = mid + 1;
    else hi = mid;
  }
  float2 acc = make_float2(0.f, 0.f);
  float wmax = 0.f, sb = d.sigma_b[b];
  double isc = (double)d.imp_scale[b];
  for (int p = lo; p < np_; ++p) {
    int pk = d.peak_pos[off + p];
    if (pk > m + 54) break;
    float q = ((float)m - (float)pk) / sb;
    float win = expf(-0.5f * q * q);
    double wt = d.peak_amp[off + p] * isc * (double)win;
    float2 ph = d.peak_ph[(size_t)(off + p) * d.NB + b];
    acc.x += (float)((double)ph.x * wt);
    acc.y += (float)((double)ph.y * wt);
    wmax = fmaxf(wmax, (float)wt);
  }
  float mg = hypotf(acc.x, acc.y);
  impc[idx] = (mg > 1e-6f) ? make_float2(acc.x / mg, acc.y / mg) : make_float2(0.f, 0.f);
  impw[idx] = fminf(fmaxf(wmax, 0.f), 0.88f);
}

// 噪声载波频域填充：主机给的高斯数（逐采样对照用）或设备 Philox；按子带半余弦窗带限
__global__ void k_noise_fill(Dev d, const float* host, float2* nz) {
  size_t idx = gidx(), blk = (size_t)d.C * d.NB * d.M;
  if (idx >= (size_t)d.T * blk) return;
  int t = (int)(idx / blk), u = (int)(idx % d.M), b = (int)((idx / d.M) % d.NB);
  size_t inner = idx % blk;
  float mask = d.band_mask[(size_t)b * d.M + u], re, im;
  if (host) {
    re = host[(size_t)t * 2 * blk + inner];
    im = host[(size_t)t * 2 * blk + blk + inner];
  } else {
    if (mask == 0.f) {
      nz[idx] = make_float2(0.f, 0.f);
      return;
    }
    curandStatePhilox4_32_10_t st;
    curand_init(d.seeds[t], inner, 0, &st);
    float2 g = curand_normal2(&st);
    re = g.x;
    im = g.y;
  }
  nz[idx] = make_float2(re * mask, im * mask);
}

// 去瑞利恒模化：bn / max(|bn|, 0.22 rms)，再归一到单位 RMS（逐行，一行 = 一个声道的一个子带）
__global__ void k_noise_norm(float2* nz, int M, float inv) {
  float2* x = nz + (size_t)blockIdx.x * M;
  typedef cub::BlockReduce<double, BT> BR;
  __shared__ typename BR::TempStorage tmp;
  __shared__ double sh;
  double s = 0.0;
  for (int i = threadIdx.x; i < M; i += BT) {
    float re = x[i].x * inv, im = x[i].y * inv, mg = hypotf(re, im);
    s += (double)(mg * mg);
  }
  double tot = BR(tmp).Sum(s);
  if (threadIdx.x == 0) sh = tot;
  __syncthreads();
  float rms = sqrtf((float)(sh / M) + 1e-14f);
  __syncthreads();
  s = 0.0;
  for (int i = threadIdx.x; i < M; i += BT) {
    float re = x[i].x * inv, im = x[i].y * inv, den = fmaxf(hypotf(re, im), 0.22f * rms);
    float ur = re / den, ui = im / den;
    x[i] = make_float2(ur, ui);
    s += (double)(ur * ur + ui * ui);
  }
  tot = BR(tmp).Sum(s);
  if (threadIdx.x == 0) sh = tot;
  __syncthreads();
  float orms = sqrtf((float)(sh / M) + 1e-14f);
  for (int i = threadIdx.x; i < M; i += BT) x[i] = make_float2(x[i].x / orms, x[i].y / orms);
}

// 逐行乘 scale 后归一到单位 RMS（纹理重抽白噪的子带）
__global__ void k_row_rms(float2* z, int M, float scale) {
  float2* x = z + (size_t)blockIdx.x * M;
  typedef cub::BlockReduce<double, BT> BR;
  __shared__ typename BR::TempStorage tmp;
  __shared__ double sh;
  double s = 0.0;
  for (int i = threadIdx.x; i < M; i += BT) {
    float re = x[i].x * scale, im = x[i].y * scale;
    s += (double)(re * re + im * im);
  }
  double tot = BR(tmp).Sum(s);
  if (threadIdx.x == 0) sh = tot;
  __syncthreads();
  float rms = sqrtf((float)(sh / M) + 1e-14f);
  for (int i = threadIdx.x; i < M; i += BT) x[i] = make_float2(x[i].x * scale / rms, x[i].y * scale / rms);
}

// 立体声：两路独立噪声按每带 ICC 混成左右（[T, 2, NB, M] 原地）
__global__ void k_stereo_mix(Dev d, float2* x) {
  size_t idx = gidx();
  if (idx >= (size_t)d.T * d.NB * d.M) return;
  int m = (int)(idx % d.M), b = (int)((idx / d.M) % d.NB), t = (int)(idx / ((size_t)d.M * d.NB));
  size_t i0 = (((size_t)t * 2) * d.NB + b) * d.M + m, i1 = i0 + (size_t)d.NB * d.M;
  float p = d.sq_p[b], q = d.sq_m[b], s = d.sg[b];
  float2 nc = make_float2(x[i0].x * p, x[i0].y * p), nd = make_float2(x[i1].x * q, x[i1].y * q);
  x[i0] = make_float2(nc.x + nd.x, nc.y + nd.y);
  x[i1] = make_float2(s * (nc.x - nd.x), s * (nc.y - nd.y));
}

__device__ inline float chan_gain(const Dev& d, int t, int c, int b, int m) {  // 时变声像 + 每带 ILD
  if (d.stereo_mode != 1) return 1.f;
  float r = powf(10.f, (d.ild[b] + d.pan[(size_t)t * d.M + m]) / 10.f);
  return (c == 0) ? sqrtf(2.f * r / (1.f + r)) : sqrtf(2.f / (1.f + r));
}

__global__ void k_ach(Dev d, const float* A, float* Ach) {
  size_t idx = gidx();
  if (idx >= (size_t)d.T * d.C * d.NB * d.M) return;
  int m = (int)(idx % d.M), b = (int)((idx / d.M) % d.NB);
  size_t tc = idx / ((size_t)d.NB * d.M);
  int c = (int)(tc % d.C), t = (int)(tc / d.C);
  Ach[idx] = chan_gain(d, t, c, b, m) * A[((size_t)t * d.NB + b) * d.M + m];
}

// ———— 颗粒约束的目标与权重 ————
__global__ void k_kap(Dev d, const float* A, const float* Kf, double* kap) {
  size_t idx = gidx();
  if (idx >= (size_t)d.T * d.M) return;
  int m = (int)(idx % d.M), t = (int)(idx / d.M);
  double s[3] = {0.0, 0.0, 0.0}, sk[3] = {0.0, 0.0, 0.0};
  for (int b = 0; b < d.NB; ++b) {
    size_t j = ((size_t)t * d.NB + b) * d.M + m;
    double p = (double)A[j] * (double)A[j];
    s[d.grp[b]] += p;
    sk[d.grp[b]] += p * (double)Kf[j];
  }
  for (int g = 0; g < 3; ++g) kap[((size_t)t * 3 + g) * d.M + m] = sk[g] / (s[g] + 1e-30);
}

__global__ void k_grain_tw(Dev d, const double* kap, float* gtgt, float* gw) {
  size_t idx = gidx();
  if (idx >= (size_t)d.T * d.N) return;
  int n = (int)(idx % d.N), t = (int)(idx / d.N);
  const int* ti = d.ti + t * TI;
  int out_n = ti[0], pad_samp = ti[2] * DEC, i = n - pad_samp, m = n / DEC;
  double hold = 0.0;
  if (d.use_on)
    for (int k = 0; k < d.K; ++k) {
      double o = (double)d.on_samp[t * d.K + k], s = d.on_slope[t * d.K + k];
      double a0 = o - d.hold_pre * s, a1 = o + d.hold_post * s;
      double v = fmin((double)n - (a0 - d.hold_ramp), (a1 + d.hold_ramp) - (double)n) / d.hold_ramp;
      hold = fmax(hold, fmin(fmax(v, 0.0), 1.0));
    }
  for (int j = 0; j < 3; ++j) {
    double gt = 0.0;
    if (i >= 0 && i < out_n) gt = interp1(d.src_pos[(size_t)t * d.OUTM + i / DEC], d.grain + (size_t)j * d.MA, d.MA);
    double w = (1.0 - kap[((size_t)t * 3 + j) * d.M + m]) * (double)d.grain_w[j];
    if (d.use_on) w *= 1.0 - hold;
    size_t o2 = ((size_t)t * 3 + j) * d.N + n;
    gtgt[o2] = (float)gt;
    gw[o2] = (float)w;
  }
}

// ———— 纹理重抽：宽带宏观包络 G(m) × 平滑频谱占比 ————
__global__ void k_g2(Dev d, const float* A, double* G2) {
  size_t idx = gidx();
  if (idx >= (size_t)d.T * d.M) return;
  int m = (int)(idx % d.M), t = (int)(idx / d.M);
  double s = 0.0;
  for (int b = 0; b < d.NB; ++b) {
    double a = A[((size_t)t * d.NB + b) * d.M + m];
    s += a * a;
  }
  G2[idx] = s;
}

__global__ void k_x(Dev d, const float* A, const double* G2, double* X) {
  size_t idx = gidx();
  if (idx >= (size_t)d.T * d.NB * d.M) return;
  int m = (int)(idx % d.M), t = (int)(idx / ((size_t)d.NB * d.M));
  double g = G2[(size_t)t * d.M + m], p = (double)A[idx] * (double)A[idx];
  X[idx] = (p / (g + 1e-30)) * g;
}

__global__ void k_scan(const double* x, double* S, int n) {  // 每行一个块：S[0]=0，S[i+1]=Σ x[0..i]
  int row = blockIdx.x;
  const double* xr = x + (size_t)row * n;
  double* Sr = S + (size_t)row * (n + 1);
  typedef cub::BlockScan<double, SBT> BS;
  __shared__ typename BS::TempStorage tmp;
  if (threadIdx.x == 0) Sr[0] = 0.0;
  double carry = 0.0;
  for (int base = 0; base < n; base += SBT) {
    int i = base + threadIdx.x;
    double v = (i < n) ? xr[i] : 0.0, incl, agg;
    BS(tmp).InclusiveSum(v, incl, agg);
    __syncthreads();
    if (i < n) Sr[i + 1] = carry + incl;
    carry += agg;
  }
}

__global__ void k_nsm(Dev d, const double* X, const double* SX, const double* G2, const double* SG, double* NSM) {
  size_t idx = gidx();
  if (idx >= (size_t)d.T * d.NB * d.M) return;
  int m = (int)(idx % d.M), b = (int)((idx / d.M) % d.NB), t = (int)(idx / ((size_t)d.NB * d.M));
  size_t row = (size_t)t * d.NB + b;
  int w = d.rwin[b];
  double num = box_nearest(SX + row * (d.M + 1), X + row * d.M, d.M, m, w);
  double den = box_nearest(SG + (size_t)t * (d.M + 1), G2 + (size_t)t * d.M, d.M, m, w) + 1e-30;
  NSM[idx] = fmax(num / den, 0.0);
}

__global__ void k_asm(Dev d, const double* NSM, const double* G2, float* Asm) {
  size_t idx = gidx();
  if (idx >= (size_t)d.T * d.M) return;
  int m = (int)(idx % d.M), t = (int)(idx / d.M);
  double s = 0.0;
  for (int b = 0; b < d.NB; ++b) s += NSM[((size_t)t * d.NB + b) * d.M + m];
  double g = G2[idx];
  for (int b = 0; b < d.NB; ++b) {
    size_t j = ((size_t)t * d.NB + b) * d.M + m;
    Asm[j] = (float)sqrt(NSM[j] / (s + 1e-30) * g);
  }
}

__global__ void k_wtd_fill(Dev d, const float* host, float* w) {
  size_t idx = gidx(), blk = (size_t)d.C * d.N;
  if (idx >= (size_t)d.T * blk) return;
  if (host) {
    w[idx] = host[idx];
    return;
  }
  curandStatePhilox4_32_10_t st;
  curand_init(d.seeds[idx / blk] ^ 0x9E3779B97F4A7C15ull, idx % blk, 0, &st);
  w[idx] = curand_normal(&st);
}

__global__ void k_wtd_grain(Dev d, const float2* Z, const float* gtgt, float* w) {  // 重抽白噪带上同一份颗粒起伏
  size_t idx = gidx(), tcn = (size_t)d.T * d.C * d.N;
  if (idx >= tcn) return;
  int n = (int)(idx % d.N), t = (int)(idx / ((size_t)d.C * d.N));
  double inv = 1.0 / d.N, s = 0.0;
  for (int j = 0; j < 3; ++j)
    s += (double)Z[j * tcn + idx].x * inv * exp2((double)d.grain_w[j] * (double)gtgt[((size_t)t * 3 + j) * d.N + n]);
  w[idx] = (float)s;
}

__global__ void k_x2(Dev d, float2* sp) {  // 单边谱：正频率乘 2（直流与 Nyquist 不动）
  size_t idx = gidx();
  if (idx >= (size_t)d.T * d.C * d.NBIN) return;
  int k = (int)(idx % d.NBIN);
  if (k >= 1 && k <= d.NBIN - 2) sp[idx] = make_float2(sp[idx].x * 2.f, sp[idx].y * 2.f);
}

__global__ void k_scatter(Dev d, const float2* sp, float2* dst) {  // 全带单边谱 → 各子带基带谱（每格至多一次赋值）
  size_t idx = gidx();
  if (idx >= (size_t)d.T * d.C * d.KTOT) return;
  int f = (int)(idx % d.KTOT);
  size_t tc = idx / d.KTOT;
  float2 v = sp[tc * d.NBIN + d.flat_k[f]];
  float w = d.flat_w[f];
  dst[tc * (size_t)d.NB * d.M + (size_t)d.flat_b[f] * d.M + d.flat_u[f]] = make_float2(v.x * w, v.y * w);
}

__global__ void k_reseed(Dev d, const float* A, const float* Asm, const float* Kf, const float2* zg, float2* nz, float* Ach) {
  int row = blockIdx.x, b = row % d.NB, tc = row / d.NB, c = tc % d.C, t = tc / d.C;
  const float2* z = zg + (size_t)row * d.M;
  float2* nn = nz + (size_t)row * d.M;
  float* ach = Ach + (size_t)row * d.M;
  size_t rb = ((size_t)t * d.NB + b) * d.M;
  float alpha = (float)d.td[t * TD + 2];
  typedef cub::BlockReduce<double, BT> BR;
  __shared__ typename BR::TempStorage tmp;
  __shared__ double sh;
  double s = 0.0;
  for (int m = threadIdx.x; m < d.M; m += BT) {
    float r = hypotf(z[m].x, z[m].y);
    s += (double)(r * r);
  }
  double tot = BR(tmp).Sum(s);
  if (threadIdx.x == 0) sh = tot;
  __syncthreads();
  float rn = sqrtf((float)(sh / d.M) + 1e-14f);
  __syncthreads();
  s = 0.0;
  for (int m = threadIdx.x; m < d.M; m += BT) {
    float r = hypotf(z[m].x, z[m].y), g = chan_gain(d, t, c, b, m);
    float a0 = g * A[rb + m], ars = (g * Asm[rb + m]) * (r / rn);
    float al = (alpha * (1.f - Kf[rb + m])) * (1.f - d.att_prot[(size_t)t * d.M + m]);
    ach[m] = sqrtf((1.f - al) * (a0 * a0) + al * (ars * ars));
    float den = fmaxf(r, 1e-4f);
    float2 v = make_float2((1.f - al) * nn[m].x + al * (z[m].x / den), (1.f - al) * nn[m].y + al * (z[m].y / den));
    nn[m] = v;
    s += (double)(v.x * v.x + v.y * v.y);
  }
  tot = BR(tmp).Sum(s);
  if (threadIdx.x == 0) sh = tot;
  __syncthreads();
  float nr = sqrtf((float)(sh / d.M) + 1e-14f);
  for (int m = threadIdx.x; m < d.M; m += BT) nn[m] = make_float2(nn[m].x / nr, nn[m].y / nr);
}

// 三路载波融合：y_b = A_ch · (κ·相干 + √(1-κ²)·(√(1-w²)·噪声 + w·冲激))
__global__ void k_fuse(Dev d, const float* Ach, const float* Kf, const float2* coh, const float2* impc, const float* impw,
                       const float2* nz, float2* yb) {
  size_t idx = gidx();
  if (idx >= (size_t)d.T * d.C * d.NB * d.M) return;
  int m = (int)(idx % d.M), b = (int)((idx / d.M) % d.NB);
  size_t tc = idx / ((size_t)d.NB * d.M);
  int c = (int)(tc % d.C), t = (int)(tc / d.C);
  size_t j = ((size_t)t * d.NB + b) * d.M + m;
  float w = impw[j], kk = Kf[j], sw = sqrtf(fmaxf(0.f, 1.f - w * w)), sk = sqrtf(fmaxf(0.f, 1.f - kk * kk));
  float2 n = nz[idx], im = impc[j], ch = coh[j];
  if (d.stereo_mode == 1 && c == 1) ch = cmul(ch, d.turn[b]);
  float2 st = make_float2(sw * n.x + w * im.x, sw * n.y + w * im.y);
  float a = Ach[idx];
  yb[idx] = make_float2(a * (kk * ch.x + sk * st.x), a * (kk * ch.y + sk * st.y));
}

__global__ void k_premask(Dev d, unsigned char* pm) {  // 起音前被滤网抹开的那段（只许压不许抬）
  size_t idx = gidx();
  if (idx >= (size_t)d.T * d.NB * d.M) return;
  int m = (int)(idx % d.M), b = (int)((idx / d.M) % d.NB), t = (int)(idx / ((size_t)d.NB * d.M));
  unsigned char v = 0;
  for (int k = 0; k < d.K; ++k)
    if (m >= d.pre_lo[((size_t)t * d.K + k) * d.NB + b] && m < d.pre_ci[t * d.K + k]) v = 1;
  pm[idx] = v;
}

// ———— 交替投影 ————
__global__ void k_gather(Dev d, const float2* W, float2* Ya) {  // 子带谱 → 全带单边谱（每个 bin 至多 2 个子带）
  size_t idx = gidx();
  if (idx >= (size_t)d.T * d.C * d.NBIN) return;
  int k = (int)(idx % d.NBIN);
  const float2* w = W + (idx / d.NBIN) * (size_t)d.NB * d.M;
  float2 a = w[(size_t)d.bin_b0[k] * d.M + d.bin_u0[k]], b = w[(size_t)d.bin_b1[k] * d.M + d.bin_u1[k]];
  float w0 = d.bin_w0[k], w1 = d.bin_w1[k];
  Ya[idx] = make_float2(a.x * 8.f * w0 + b.x * 8.f * w1, a.y * 8.f * w0 + b.y * 8.f * w1);
}

__global__ void k_halve(Dev d, const float2* Ya, float2* sp, int final_mode) {  // 解析谱 → 实信号单边谱
  size_t idx = gidx();
  if (idx >= (size_t)d.T * d.C * d.NBIN) return;
  int k = (int)(idx % d.NBIN);
  float2 v = Ya[idx];
  if (k >= 1 && k <= d.NBIN - 2)
    sp[idx] = make_float2(v.x * 0.5f, v.y * 0.5f);
  else
    sp[idx] = make_float2(v.x, 0.f);
  (void)final_mode;
}

__global__ void k_double(Dev d, const float2* sp, float2* Ya) {
  size_t idx = gidx();
  if (idx >= (size_t)d.T * d.C * d.NBIN) return;
  int k = (int)(idx % d.NBIN);
  float f = (k >= 1 && k <= d.NBIN - 2) ? 2.f : 1.f;
  Ya[idx] = make_float2(sp[idx].x * f, sp[idx].y * f);
}

__global__ void k_scale(size_t n, float* x, float s) {
  size_t idx = gidx();
  if (idx < n) x[idx] *= s;
}

__global__ void k_ratio(Dev d, const float2* W, const float* Ach, const unsigned char* pm, float2* yb, float inv) {
  size_t idx = gidx();
  if (idx >= (size_t)d.T * d.C * d.NB * d.M) return;
  float re = W[idx].x * inv * 0.125f, im = W[idx].y * inv * 0.125f, a = Ach[idx];
  float r = powf((a + d.eps_proj) / (hypotf(re, im) + d.eps_proj), 0.78f);
  r = fminf(fmaxf(r, 0.25f), 4.f);
  if (pm) {
    int m = (int)(idx % d.M), b = (int)((idx / d.M) % d.NB), t = (int)(idx / ((size_t)d.NB * d.M) / d.C);
    if (pm[((size_t)t * d.NB + b) * d.M + m]) r = fminf(r, 1.f);
  }
  yb[idx] = (a < d.floor2) ? make_float2(0.f, 0.f) : make_float2(re * r, im * r);
}

// ———— 起音 / 颗粒时域约束（低/中/高三段解析信号） ————
__global__ void k_analytic3(Dev d, const float2* sp, float2* Z) {
  size_t idx = gidx(), tcn = (size_t)d.T * d.C * d.N;
  if (idx >= 3 * tcn) return;
  int j = (int)(idx / tcn), n = (int)(idx % d.N);
  size_t tc = (idx % tcn) / d.N;
  float2 v = make_float2(0.f, 0.f);
  if (n <= d.N / 2) {
    float mk = (j == 0) ? d.lo_m[n] : ((j == 2) ? d.hi_m[n] : 1.f - d.lo_m[n] - d.hi_m[n]);
    float f = (n >= 1 && n < (d.N + 1) / 2) ? 2.f * mk : mk;
    float2 y = sp[tc * d.NBIN + n];
    v = make_float2(y.x * f, y.y * f);
  }
  Z[idx] = v;
}

__global__ void k_pow3(Dev d, const float2* Z, double* P) {  // 各声道平均的 |z|²，布局 [T][3][N]
  size_t idx = gidx(), tcn = (size_t)d.T * d.C * d.N;
  if (idx >= (size_t)d.T * 3 * d.N) return;
  int n = (int)(idx % d.N), j = (int)((idx / d.N) % 3), t = (int)(idx / ((size_t)3 * d.N));
  double inv = 1.0 / d.N, s = 0.0;
  for (int c = 0; c < d.C; ++c) {
    float2 z = Z[j * tcn + ((size_t)t * d.C + c) * d.N + n];
    double re = z.x * inv, im = z.y * inv;
    s += re * re + im * im;
  }
  P[idx] = s / d.C;
}

__global__ void k_env(Dev d, const double* S, float* E, int jn, int joff) {
  size_t idx = gidx();
  if (idx >= (size_t)d.T * jn * d.N) return;
  int n = (int)(idx % d.N);
  size_t row = idx / d.N;
  double v = box_reflect(S + row * (size_t)(d.N + 1), d.N, n, d.kw_on[joff + (int)(row % jn)]);
  E[idx] = (float)sqrt(fmax(v, 0.0) + 1e-30);
}

__global__ void k_anchor(Dev d, const float* E, int jn, int joff, double* anc) {  // 起音后 40 ms·斜率 内的平均能量
  int blk = blockIdx.x, jl = blk % jn, tk = blk / jn, t = tk / d.K;
  long o = d.on_samp[tk], hi = min((long)d.N, o + (long)(d.an_n * d.post_slope[tk]) + 1);
  const float* e = E + ((size_t)t * jn + jl) * d.N;
  double s = 0.0;
  for (long i = o + threadIdx.x; i < hi; i += BT)
    if (i >= 0) s += (double)e[i] * (double)e[i];
  typedef cub::BlockReduce<double, BT> BR;
  __shared__ typename BR::TempStorage tmp;
  double tot = BR(tmp).Sum(s);
  if (threadIdx.x == 0) anc[(size_t)tk * 4 + joff + jl] = (hi > o && o >= 0) ? sqrt(tot / (double)(hi - o)) + 1e-30 : 1e-30;
}

__global__ void k_gonset(Dev d, const float* E, int jn, int joff, const double* anc, float* G, int post) {
  size_t idx = gidx();
  if (idx >= (size_t)d.T * jn * d.N) return;
  int n = (int)(idx % d.N), jl = (int)((idx / d.N) % jn), t = (int)(idx / ((size_t)jn * d.N)), j = joff + jl;
  double e = E[idx], g = 1.0;
  if (post && j < 3)
    for (int k = d.K - 1; k >= 0; --k) {  // 后面的起音覆盖前面的（与 numpy 逐个赋值一致）
      int tk = t * d.K + k;
      long o = d.on_samp[tk];
      double sp = d.post_slope[tk];
      long bnd = min((long)d.N, o + (long)(d.post_len[j] * sp));
      if (o < 0 || o >= bnd || n < o || n >= bnd) continue;
      const float* pf = d.prof + ((size_t)k * 4 + j) * d.L;
      double tg = anc[(size_t)tk * 4 + j] * pow(10.0, interp1(d.pre_n + (double)(n - o) / (sp * DEC), pf, d.L) / 20.0);
      double gk = fmin(fmax(tg / (e + 1e-12), 0.0), d.onset_max_gain);
      double u = fmin(fmax(((double)(n - o) / (double)(bnd - o) - 0.7) / 0.3, 0.0), 1.0);
      g = 1.0 + (0.5 + 0.5 * cos(M_PI * u)) * (gk - 1.0);
      break;
    }
  for (int k = 0; k < d.K; ++k) {  // 起音前 30 ms：只压不抬
    int tk = t * d.K + k;
    long o = d.on_samp[tk];
    double s = d.on_slope[tk];
    long a = max(0L, o - (long)((double)(d.pre_n * DEC) * s));
    if (!(0 < o && o < d.N) || o <= a || n < a || n >= o) continue;
    const float* pf = d.prof + ((size_t)k * 4 + j) * d.L;
    double tg = anc[(size_t)tk * 4 + j] * pow(10.0, interp1(d.pre_n + (double)(n - o) / (s * DEC), pf, d.L) / 20.0);
    double gk = fmin(1.0, tg / (e + 1e-12));
    double ramp = (a > 0) ? fmin(fmax((double)(n - a) / d.ramp_n, 0.0), 1.0) : 1.0;
    g = fmin(g, 1.0 - ramp * (1.0 - gk));
  }
  G[idx] = (float)g;
}

__global__ void k_gapply(Dev d, const float2* Z, const float* G, double* outd) {  // Σ 三段实部 × 平滑后的增益
  size_t idx = gidx(), tcn = (size_t)d.T * d.C * d.N;
  if (idx >= tcn) return;
  int n = (int)(idx % d.N), t = (int)(idx / ((size_t)d.C * d.N));
  double inv = 1.0 / d.N, acc = 0.0;
  for (int j = 0; j < 3; ++j) acc += (double)Z[j * tcn + idx].x * inv * box9(G + ((size_t)t * 3 + j) * d.N, d.N, n);
  outd[idx] = acc;
}

__global__ void k_pow_full(Dev d, const double* outd, double* P) {
  size_t idx = gidx();
  if (idx >= (size_t)d.T * d.N) return;
  int n = (int)(idx % d.N), t = (int)(idx / d.N);
  double s = 0.0;
  for (int c = 0; c < d.C; ++c) {
    double v = outd[((size_t)t * d.C + c) * d.N + n];
    s += v * v;
  }
  P[idx] = s / d.C;
}

__global__ void k_gfinal(Dev d, const double* outd, const float* G, float* xt) {
  size_t idx = gidx();
  if (idx >= (size_t)d.T * d.C * d.N) return;
  int n = (int)(idx % d.N), t = (int)(idx / ((size_t)d.C * d.N));
  xt[idx] = (float)(outd[idx] * box9(G + (size_t)t * d.N, d.N, n));
}

__global__ void k_ggrain(Dev d, const double* S, const float* gtgt, const float* gw, float* G) {
  size_t idx = gidx();
  if (idx >= (size_t)d.T * 3 * d.N) return;
  int n = (int)(idx % d.N), j = (int)((idx / d.N) % 3);
  const double* Sr = S + (idx / d.N) * (size_t)(d.N + 1);
  double ef = sqrt(fmax(box_reflect(Sr, d.N, n, d.kw_gr[j]), 0.0) + 1e-30);
  double es = sqrt(fmax(box_reflect(Sr, d.N, n, d.kw_gs), 0.0) + 1e-30);
  double cur = log2(fmin(fmax(ef / es, 0.1), 10.0));
  double g = exp2((double)gw[idx] * ((double)gtgt[idx] - cur));
  G[idx] = (float)fmin(fmax(g, d.grain_gmin), d.grain_gmax);
}

__global__ void k_d2f(size_t n, const double* a, float* b) {
  size_t idx = gidx();
  if (idx < n) b[idx] = (float)a[idx];
}

__global__ void k_crop(Dev d, const float* xt, float* out) {
  size_t idx = gidx();
  if (idx >= (size_t)d.T * d.C * d.OUTN) return;
  int i = (int)(idx % d.OUTN);
  size_t tc = idx / d.OUTN;
  const int* ti = d.ti + (int)(tc / d.C) * TI;
  out[idx] = (i < ti[0]) ? xt[tc * d.N + (size_t)ti[2] * DEC + i] : 0.f;
}

int get_plan(cufftHandle* out, cufftType type, int n, int batch) {
  auto key = std::make_tuple((int)type, n, batch);
  auto it = g_plans.find(key);
  if (it != g_plans.end()) {
    *out = it->second;
    return 0;
  }
  cufftHandle h;
  int nn[1] = {n};
  CF(cufftPlanMany(&h, 1, nn, nullptr, 1, 0, nullptr, 1, 0, type, batch));
  g_plans[key] = h;
  *out = h;
  return 0;
}

struct Shape {  // 起音/颗粒约束的工作区
  cufftHandle r2c, z;
  float2 *spec, *Z;
  double *P, *S, *outd, *anc;
  float *E, *G;
};

int analytic(const Dev& d, Shape& s, const float* xt) {
  size_t tcn = (size_t)d.T * d.C * d.N;
  CF(cufftExecR2C(s.r2c, (cufftReal*)xt, (cufftComplex*)s.spec));
  LAUNCH(k_analytic3, 3 * tcn, d, s.spec, s.Z);
  CF(cufftExecC2C(s.z, (cufftComplex*)s.Z, (cufftComplex*)s.Z, CUFFT_INVERSE));
  LAUNCH(k_pow3, (size_t)d.T * 3 * d.N, d, s.Z, s.P);
  KL(k_scan, d.T * 3, SBT, s.P, s.S, d.N);
  return 0;
}

int onset_shape(const Dev& d, Shape& s, float* xt, int post) {
  size_t tcn = (size_t)d.T * d.C * d.N, tn = (size_t)d.T * d.N;
  CALL(analytic(d, s, xt));
  LAUNCH(k_env, 3 * tn, d, s.S, s.E, 3, 0);
  KL(k_anchor, d.T * d.K * 3, BT, d, s.E, 3, 0, s.anc);
  LAUNCH(k_gonset, 3 * tn, d, s.E, 3, 0, s.anc, s.G, post);
  LAUNCH(k_gapply, tcn, d, s.Z, s.G, s.outd);
  // 全带再压一遍起音前：分频本身也会把起音往前抹一点
  LAUNCH(k_pow_full, tn, d, s.outd, s.P);
  KL(k_scan, d.T, SBT, s.P, s.S, d.N);
  LAUNCH(k_env, tn, d, s.S, s.E, 1, 3);
  KL(k_anchor, d.T * d.K, BT, d, s.E, 1, 3, s.anc);
  LAUNCH(k_gonset, tn, d, s.E, 1, 3, s.anc, s.G, 0);
  LAUNCH(k_gfinal, tcn, d, s.outd, s.G, xt);
  return 0;
}

int grain_shape(const Dev& d, Shape& s, float* xt, const float* gtgt, const float* gw) {
  size_t tcn = (size_t)d.T * d.C * d.N;
  CALL(analytic(d, s, xt));
  LAUNCH(k_ggrain, (size_t)d.T * 3 * d.N, d, s.S, gtgt, gw, s.G);
  LAUNCH(k_gapply, tcn, d, s.Z, s.G, s.outd);
  LAUNCH(k_d2f, tcn, tcn, s.outd, xt);
  return 0;
}

template <class T>
T* up(Arena& ar, const void* h, size_t n) {
  if (!h) return nullptr;
  T* p = ar.get<T>(n);
  if (p && n) cudaMemcpyAsync(p, h, n * sizeof(T), cudaMemcpyHostToDevice, 0);
  return p;
}

int render(const ErbGroup& h) {
  if (h.N != h.M * DEC) FAIL("N（%d）必须等于 M（%d）× DEC（%d）：内核把 DEC 写死了，core.DEC 改了要一起改这里", h.N, h.M, DEC);
  Arena ar;
  if (g_prof) {
    size_t f = 0, t = 0;
    cudaDeviceSynchronize();
    if (cudaMemGetInfo(&f, &t) == cudaSuccess) g_base_used = t - f;
    g_peak = 0;
  }
  Dev d{};
  d.T = h.T, d.C = h.C, d.NB = h.NB, d.M = h.M, d.N = h.N, d.NBIN = h.N / 2 + 1, d.MA = h.MA, d.K = h.K, d.L = h.L;
  d.OUTM = h.OUTM, d.OUTN = h.OUTN, d.KTOT = h.KTOT, d.NPEAK = h.NPEAK;
  d.stereo_mode = h.stereo_mode, d.use_on = h.use_on, d.use_grain = h.use_grain, d.use_reseed = h.use_reseed;
  for (int i = 0; i < 4; ++i) d.kw_on[i] = h.kw_on[i];
  for (int i = 0; i < 3; ++i) d.kw_gr[i] = h.kw_gr[i], d.post_len[i] = h.post_len[i];
  d.kw_gs = h.kw_gs, d.pre_n = h.pre_n, d.an_n = h.an_n, d.ramp_n = h.ramp_n;
  d.floor2 = (float)h.floor2, d.eps_proj = (float)h.eps_proj, d.onset_max_gain = h.onset_max_gain;
  d.grain_gmin = h.grain_gmin, d.grain_gmax = h.grain_gmax, d.hold_pre = h.hold_pre, d.hold_post = h.hold_post;
  d.hold_ramp = h.hold_ramp;
  const int T = d.T, C = d.C, NB = d.NB, M = d.M, N = d.N, NBIN = d.NBIN, K = d.K;
  const size_t TBM = (size_t)T * NB * M, TCBM = (size_t)T * C * NB * M, TCN = (size_t)T * C * N;
  const size_t TCK = (size_t)T * C * NBIN, TN = (size_t)T * N;

  d.env = up<float>(ar, h.env, (size_t)NB * d.MA), d.kappa = up<float>(ar, h.kappa, (size_t)NB * d.MA);
  d.omega = up<float>(ar, h.omega, (size_t)NB * d.MA), d.grain = up<float>(ar, h.grain, (size_t)3 * d.MA);
  d.grain_w = up<float>(ar, h.grain_w, 3), d.prof = up<float>(ar, h.prof, (size_t)K * 4 * d.L);
  d.ild = up<float>(ar, h.ild, NB), d.sq_p = up<float>(ar, h.sq_p, NB), d.sq_m = up<float>(ar, h.sq_m, NB);
  d.sg = up<float>(ar, h.sg, NB), d.turn = up<float2>(ar, h.turn, NB), d.hf_wt = up<float>(ar, h.hf_wt, NB);
  d.sigma_b = up<float>(ar, h.sigma_b, NB), d.imp_scale = up<float>(ar, h.imp_scale, NB);
  d.grp = up<int>(ar, h.grp, NB), d.rwin = up<int>(ar, h.rwin, NB);
  d.bin_b0 = up<int>(ar, h.bin_b0, NBIN), d.bin_u0 = up<int>(ar, h.bin_u0, NBIN), d.bin_b1 = up<int>(ar, h.bin_b1, NBIN);
  d.bin_u1 = up<int>(ar, h.bin_u1, NBIN), d.bin_w0 = up<float>(ar, h.bin_w0, NBIN), d.bin_w1 = up<float>(ar, h.bin_w1, NBIN);
  d.flat_b = up<int>(ar, h.flat_b, d.KTOT), d.flat_u = up<int>(ar, h.flat_u, d.KTOT), d.flat_k = up<int>(ar, h.flat_k, d.KTOT);
  d.flat_w = up<float>(ar, h.flat_w, d.KTOT), d.band_mask = up<float>(ar, h.band_mask, (size_t)NB * M);
  d.lo_m = up<float>(ar, h.lo_m, NBIN), d.hi_m = up<float>(ar, h.hi_m, NBIN);
  d.ti = up<int>(ar, h.ti, (size_t)T * TI), d.td = up<double>(ar, h.td, (size_t)T * TD);
  d.src_pos = up<double>(ar, h.src_pos, (size_t)T * d.OUTM), d.imp_t = up<float>(ar, h.imp_t, (size_t)T * d.OUTM);
  d.w_atk = up<float>(ar, h.w_atk, (size_t)T * d.OUTM), d.rs_i0 = up<int>(ar, h.rs_i0, (size_t)T * NB);
  d.rs_mode = up<int>(ar, h.rs_mode, (size_t)T * NB), d.rs_frac = up<float>(ar, h.rs_frac, (size_t)T * NB);
  d.rs_roll = up<float>(ar, h.rs_roll, (size_t)T * NB), d.glin = up<float>(ar, h.glin, (size_t)T * NB);
  d.eq = up<float>(ar, h.eq, (size_t)T * 2 * NB);
  d.peak_pos = up<int>(ar, h.peak_pos, d.NPEAK);
  d.peak_amp = up<double>(ar, h.peak_amp, d.NPEAK), d.peak_ph = up<float2>(ar, h.peak_ph, (size_t)d.NPEAK * NB);
  d.init_phi = up<float>(ar, h.init_phi, (size_t)T * NB), d.on_samp = up<int>(ar, h.on_samp, (size_t)T * K);
  d.on_slope = up<double>(ar, h.on_slope, (size_t)T * K), d.post_slope = up<double>(ar, h.post_slope, (size_t)T * K);
  d.pre_lo = up<int>(ar, h.pre_lo, (size_t)T * K * NB), d.pre_ci = up<int>(ar, h.pre_ci, (size_t)T * K);
  d.att_prot = up<float>(ar, h.att_prot, (size_t)T * M), d.pan = up<float>(ar, h.pan, (size_t)T * M);
  d.seeds = up<unsigned long long>(ar, h.seeds, T);
  const float* noise = h.noise_mode ? up<float>(ar, h.noise, (size_t)T * 2 * C * NB * M) : nullptr;
  const float* wtd_host = (h.noise_mode && h.use_reseed) ? up<float>(ar, h.wtd, TCN) : nullptr;
  if (ar.bad) FAIL("显存不够（上传参数时）");
  CK(cudaGetLastError());
  probe();

  cufftHandle pb, pr2c, pc2r, pz;
  CALL(get_plan(&pb, CUFFT_C2C, M, T * C * NB));
  CALL(get_plan(&pr2c, CUFFT_R2C, N, T * C));
  CALL(get_plan(&pc2r, CUFFT_C2R, N, T * C));

  // 1. (NB, M) 张量与三路载波
  float *A = ar.get<float>(TBM), *Kf = ar.get<float>(TBM), *OM = ar.get<float>(TBM);
  float2 *coh = ar.get<float2>(TBM), *impc = ar.get<float2>(TBM), *nz = ar.get<float2>(TCBM);
  float *impw = ar.get<float>(TBM), *Ach = ar.get<float>(TCBM);
  if (!A || !Kf || !OM || !coh || !impc || !nz || !impw || !Ach) FAIL("显存不够（载波）");
  probe();
  LAUNCH(k_build, TBM, d, A, Kf, OM);
  KL(k_coh, T * NB, BT, d, OM, coh);
  ar.release(OM);
  LAUNCH(k_imp, TBM, d, impc, impw);

  float *gtgt = nullptr, *gw = nullptr;
  if (d.use_grain) {
    double* kap = ar.get<double>((size_t)T * 3 * M);
    gtgt = ar.get<float>((size_t)T * 3 * N), gw = ar.get<float>((size_t)T * 3 * N);
    if (!kap || !gtgt || !gw) FAIL("显存不够（颗粒）");
    LAUNCH(k_kap, (size_t)T * M, d, A, Kf, kap);
    LAUNCH(k_grain_tw, TN, d, kap, gtgt, gw);
    ar.release(kap);
  }

  LAUNCH(k_noise_fill, TCBM, d, noise, nz);
  CF(cufftExecC2C(pb, (cufftComplex*)nz, (cufftComplex*)nz, CUFFT_INVERSE));
  KL(k_noise_norm, T * C * NB, BT, nz, M, 1.f / M);
  if (d.stereo_mode == 1) LAUNCH(k_stereo_mix, TBM, d, nz);

  if (d.use_reseed) {
    double *G2 = ar.get<double>((size_t)T * M), *X = ar.get<double>(TBM), *SX = ar.get<double>((size_t)T * NB * (M + 1));
    double *SG = ar.get<double>((size_t)T * (M + 1)), *NSM = ar.get<double>(TBM);
    float* Asm = ar.get<float>(TBM);
    if (!G2 || !X || !SX || !SG || !NSM || !Asm) FAIL("显存不够（重抽）");
    probe();
    LAUNCH(k_g2, (size_t)T * M, d, A, G2);
    LAUNCH(k_x, TBM, d, A, G2, X);
    KL(k_scan, T * NB, SBT, X, SX, M);
    KL(k_scan, T, SBT, G2, SG, M);
    LAUNCH(k_nsm, TBM, d, X, SX, G2, SG, NSM);
    LAUNCH(k_asm, (size_t)T * M, d, NSM, G2, Asm);
    ar.release(X), ar.release(SX), ar.release(SG), ar.release(NSM);

    float* wtd = ar.get<float>(TCN);
    float2 *spec = ar.get<float2>(TCK), *zg = ar.get<float2>(TCBM);
    if (!wtd || !spec || !zg) FAIL("显存不够（重抽白噪）");
    probe();
    LAUNCH(k_wtd_fill, TCN, d, wtd_host, wtd);
    if (d.use_grain) {
      float2* Z = ar.get<float2>(3 * TCN);
      if (!Z) FAIL("显存不够（重抽颗粒）");
      CALL(get_plan(&pz, CUFFT_C2C, N, 3 * T * C));
      CF(cufftExecR2C(pr2c, (cufftReal*)wtd, (cufftComplex*)spec));
      LAUNCH(k_analytic3, 3 * TCN, d, spec, Z);
      CF(cufftExecC2C(pz, (cufftComplex*)Z, (cufftComplex*)Z, CUFFT_INVERSE));
      LAUNCH(k_wtd_grain, TCN, d, Z, gtgt, wtd);
      ar.release(Z);
    }
    CF(cufftExecR2C(pr2c, (cufftReal*)wtd, (cufftComplex*)spec));
    LAUNCH(k_x2, TCK, d, spec);
    CK(cudaMemsetAsync(zg, 0, TCBM * sizeof(float2), 0));
    LAUNCH(k_scatter, (size_t)T * C * d.KTOT, d, spec, zg);
    CF(cufftExecC2C(pb, (cufftComplex*)zg, (cufftComplex*)zg, CUFFT_INVERSE));
    KL(k_row_rms, T * C * NB, BT, zg, M, 1.f / N);
    if (d.stereo_mode == 1) LAUNCH(k_stereo_mix, TBM, d, zg);
    KL(k_reseed, T * C * NB, BT, d, A, Asm, Kf, zg, nz, Ach);
    ar.release(G2), ar.release(Asm), ar.release(wtd), ar.release(spec), ar.release(zg);
  } else {
    LAUNCH(k_ach, TCBM, d, A, Ach);
  }

  float2* yb = ar.get<float2>(TCBM);
  if (!yb) FAIL("显存不够（子带）");
  LAUNCH(k_fuse, TCBM, d, Ach, Kf, coh, impc, impw, nz, yb);
  ar.release(coh), ar.release(impc), ar.release(impw), ar.release(nz), ar.release(Kf);
  unsigned char* pm = nullptr;
  if (d.use_on) {
    pm = ar.get<unsigned char>(TBM);
    if (!pm) FAIL("显存不够（起音掩码）");
    LAUNCH(k_premask, TBM, d, pm);
  }
  ar.release(A);

  // 2. exact 轮交替投影
  float2 *work = ar.get<float2>(TCBM), *Ya = ar.get<float2>(TCK);
  float* xt = ar.get<float>(TCN);
  Shape s{};
  s.r2c = pr2c;
  s.spec = ar.get<float2>(TCK);
  if (!work || !Ya || !xt || !s.spec) FAIL("显存不够（投影）");
  if (d.use_on || d.use_grain || h.final_on) {
    CALL(get_plan(&s.z, CUFFT_C2C, N, 3 * T * C));
    s.Z = ar.get<float2>(3 * TCN), s.P = ar.get<double>((size_t)T * 3 * N), s.S = ar.get<double>((size_t)T * 3 * (N + 1));
    s.E = ar.get<float>((size_t)T * 3 * N), s.G = ar.get<float>((size_t)T * 3 * N), s.outd = ar.get<double>(TCN);
    s.anc = ar.get<double>((size_t)T * K * 4 + 1);
    if (!s.Z || !s.P || !s.S || !s.E || !s.G || !s.outd || !s.anc) FAIL("显存不够（时域约束）");
  }
  probe();
  for (int it = 0; it < h.exact; ++it) {
    CF(cufftExecC2C(pb, (cufftComplex*)yb, (cufftComplex*)work, CUFFT_FORWARD));
    LAUNCH(k_gather, TCK, d, work, Ya);
    if (d.use_on || d.use_grain) {
      LAUNCH(k_halve, TCK, d, Ya, s.spec, 0);
      CF(cufftExecC2R(pc2r, (cufftComplex*)s.spec, (cufftReal*)xt));
      LAUNCH(k_scale, TCN, TCN, xt, 1.f / N);
      if (d.use_on) CALL(onset_shape(d, s, xt, 1));
      if (d.use_grain) CALL(grain_shape(d, s, xt, gtgt, gw));
      CF(cufftExecR2C(pr2c, (cufftReal*)xt, (cufftComplex*)s.spec));
      LAUNCH(k_double, TCK, d, s.spec, Ya);
    }
    CK(cudaMemsetAsync(work, 0, TCBM * sizeof(float2), 0));
    LAUNCH(k_scatter, (size_t)T * C * d.KTOT, d, Ya, work);
    CF(cufftExecC2C(pb, (cufftComplex*)work, (cufftComplex*)work, CUFFT_INVERSE));
    LAUNCH(k_ratio, TCBM, d, work, Ach, pm, yb, 1.f / M);
  }

  // 3. 合成到 48 kHz 实信号 → 末轮起音约束 → 裁回有效区间
  CF(cufftExecC2C(pb, (cufftComplex*)yb, (cufftComplex*)work, CUFFT_FORWARD));
  LAUNCH(k_gather, TCK, d, work, Ya);
  LAUNCH(k_halve, TCK, d, Ya, s.spec, 1);
  CF(cufftExecC2R(pc2r, (cufftComplex*)s.spec, (cufftReal*)xt));
  LAUNCH(k_scale, TCN, TCN, xt, 1.f / N);
  if (h.final_on) CALL(onset_shape(d, s, xt, h.final_post));
  float* outd = ar.get<float>((size_t)T * C * d.OUTN);
  if (!outd) FAIL("显存不够（输出）");
  probe();
  LAUNCH(k_crop, (size_t)T * C * d.OUTN, d, xt, outd);
  CK(cudaMemcpyAsync(h.out, outd, (size_t)T * C * d.OUTN * sizeof(float), cudaMemcpyDeviceToHost, 0));
  CK(cudaStreamSynchronize(0));
  return 0;
}

}  // namespace

extern "C" {
int erb_render_group(const ErbGroup* g) {
  g_err[0] = 0;
  g_oom = false;
  if (g_plans.size() > 16) {  // 尺寸攒太多时在两次渲染之间整体清掉（渲染中途清会让手里的句柄失效），免得工作区一直占着显存
    cudaDeviceSynchronize();
    for (auto& kv : g_plans) cufftDestroy(kv.second);
    g_plans.clear();
  }
  int r = render(*g);
  if (r != 0) {
    cudaDeviceSynchronize();
    cudaGetLastError();
  }
  return r == 0 ? 0 : (g_oom ? -2 : -1);
}
const char* erb_last_error() { return g_err; }
unsigned long long erb_peak_bytes() { return (unsigned long long)g_peak; }  // 最近一次渲染的显存峰值增量（字节）
void erb_profile(int on) {
  g_prof = on != 0;
  g_times.clear();
}
int erb_profile_report(char* buf, int cap) {  // 每行：毫秒 次数 名字（按耗时降序）
  std::vector<std::pair<double, std::string>> v;
  for (auto& kv : g_times) v.push_back({kv.second.first, kv.first});
  std::sort(v.rbegin(), v.rend());
  std::string out;
  char line[512];
  for (auto& e : v) {
    snprintf(line, sizeof line, "%10.3f %6d %s\n", e.first, g_times[e.second].second, e.second.c_str());
    out += line;
  }
  snprintf(buf, cap, "%s", out.c_str());
  return (int)out.size();
}
int erb_struct_size() { return (int)sizeof(ErbGroup); }
int erb_out_offset() { return (int)offsetof(ErbGroup, out); }
int erb_mem_info(unsigned long long* free_b, unsigned long long* total_b) {
  size_t f = 0, t = 0;
  if (cudaMemGetInfo(&f, &t) != cudaSuccess) return -1;
  *free_b = f, *total_b = t;
  return 0;
}
void erb_release() {  // 销毁缓存的 cuFFT 计划，并把 CUDA 内存池里攒着的空闲显存还给系统（别的进程要显存时不被我们占着）
  cudaDeviceSynchronize();
  for (auto& kv : g_plans) cufftDestroy(kv.second);
  g_plans.clear();
  int dev = 0;
  cudaMemPool_t pool;
  if (cudaGetDevice(&dev) == cudaSuccess && cudaDeviceGetDefaultMemPool(&pool, dev) == cudaSuccess) cudaMemPoolTrimTo(pool, 0);
  cudaGetLastError();
}
}
