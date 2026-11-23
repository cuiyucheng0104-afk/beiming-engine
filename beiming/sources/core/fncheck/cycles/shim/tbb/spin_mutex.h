// shortcut: 本机没装 TBB；Cycles 的 util/thread.h 只用它定义 thread_spin_lock 类型别名，
// 与要测的数学函数无关，所以用 std::mutex 顶替。要链接完整 Cycles 时换成真 TBB。
#pragma once
#include <mutex>
namespace tbb {
using spin_mutex = std::mutex;
}
