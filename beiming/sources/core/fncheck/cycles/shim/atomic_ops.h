// shortcut: 本机的 Cycles 源码缓存不带 Blender 的 intern/atomic；Cycles 的 util/atomic.h 拿它在 CPU 上做写渲染缓冲的原子加，
// util/stats.h 拿它记 ccl::vector 的内存用量。标准答案程序只调夹取、不写缓冲，内存统计也不读，所以这几个函数用 C++20 的
// std::atomic_ref 顶替。要链接完整 Cycles 时换成 intern/atomic。
#pragma once
#include <algorithm>
#include <atomic>
#include <cassert>
#include <cstddef>
#include <cstdint>
inline float atomic_add_and_fetch_fl(float *p, const float x) { return std::atomic_ref<float>(*p).fetch_add(x) + x; }
inline float atomic_cas_float(float *p, float old_val, const float new_val)
{
  std::atomic_ref<float>(*p).compare_exchange_strong(old_val, new_val);
  return old_val;
}
inline uint32_t atomic_fetch_and_add_uint32(uint32_t *p, const uint32_t x) { return std::atomic_ref<uint32_t>(*p).fetch_add(x); }
inline uint32_t atomic_fetch_and_or_uint32(uint32_t *p, const uint32_t x) { return std::atomic_ref<uint32_t>(*p).fetch_or(x); }
inline size_t atomic_add_and_fetch_z(size_t *p, const size_t x) { return std::atomic_ref<size_t>(*p).fetch_add(x) + x; }
inline size_t atomic_sub_and_fetch_z(size_t *p, const size_t x) { return std::atomic_ref<size_t>(*p).fetch_sub(x) - x; }
inline size_t atomic_fetch_and_update_max_z(size_t *p, const size_t x)
{
  std::atomic_ref<size_t> a(*p);
  size_t prev = a.load();
  while (prev < x && !a.compare_exchange_weak(prev, x)) {
  }
  return prev;
}
