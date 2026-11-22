# engine/audio/erb：96 带 ERB 复基带分析-再合成

从一段声音（真录音、程序化合成器的输出、文生音效模型的输出都行）学出一个**不含原始波形**的 ERB 模型，再按新种子合成「同一件东西的另一下」：起音一样脆，细节是新抽的，连敲时每下都不一样。

| 文件 | 作用 |
|---|---|
| `core.py` | CPU 参考实现。`analyze` 分析成模型；`plan` 做采样点级的轻量规划并抽好这一下的全部随机数；`_execute_numpy` 做重计算（载波、交替投影、合成）；`render = plan + _execute_numpy`。多下录音：`analyze_takes` / `takes_args` / `render_takes` |
| `erb_cuda.cu` | GPU 内核（CUDA + cuFFT）：执行同一份 `Plan` |
| `gpu.py` | GPU 执行器：nvcc 现场编译（缓存在 `<仓库>/.cache/erb/`）、ctypes 调用、整批打包、显存不够自动折半分块 |
| `__init__.py` | `erb.render_many(jobs, device='auto')`：有 GPU 就整批上 GPU，没有（或单条超出显存）退回 CPU |
| `__main__.py` | 命令行：`npm run audio:erb`（即 `python -m engine.audio.erb`） |

## 用法

命令行（从一段录音渲染 N 个新 take，写 24 bit WAV，第 k 下用种子 `seed + k`）：

```sh
npm run audio:erb -- films/<名字>/audio/hit.wav --out films/<名字>/out/takes --n 8
npm run audio:erb -- hit.wav --out takes --device cpu --json      # 强制 CPU，stdout 只有一个 JSON 信封
```

Python：

```python
from engine.audio import erb
from engine.audio.erb import core, gpu

model = core.analyze(x)                                   # x：48 kHz 单声道 (n,) 或立体声 (n, 2)
y = core.render(model, seed=3, vary=1.0, exact=8)         # CPU
y = gpu.render(model, seed=3, vary=1.0, exact=8)          # GPU，参数相同

# 连敲：一批 take 一起上 GPU（同一个模型、同样的 m_base 与开关的 take 合成一批做 FFT）
ys = erb.render_many([(model, dict(seed=s, vary=1.0, exact=8)) for s in range(64)])

# 从同一动作的几下录音学变化
ts = core.analyze_takes([take_a, take_b, take_c])
jobs = []
for s in range(8):
    m, args = core.takes_args(ts, seed=s, base=s)         # 借哪一下的时间骨架 + 学来的「咔」/声身频谱
    jobs.append((m, dict(args, exact=8)))
ys = erb.render_many(jobs)
```

`gpu.available()` 为 False（没有 nvcc 或 NVIDIA GPU）时，`erb.render_many(device='auto')` 自动走 CPU；`device='gpu'` 则抛 `gpu.GpuUnavailable`。编译失败这类「有 nvcc 也有 GPU 却出错」抛普通 `gpu.GpuError`，不会被当成「没有 GPU」悄悄跳过。

## 环境

- nvcc（CUDA Toolkit，开发时用 13.5）与 NVIDIA GPU；找不到 nvcc 时设 `BEIMING_NVCC` 指向它。Python 依赖（numpy、scipy、soundfile）都在 `requirements.in` 里，没有新增。
- 第一次调用会编译（约 10 秒），之后按「源码 + nvcc 版本 + GPU 型号」的哈希命中缓存；缓存目录可用 `BEIMING_ERB_CACHE` 改。
- 本机验证：RTX 4070 Laptop（sm_89）、CUDA 13.5。其他显卡没验证过。
- 进程内 GPU 状态（cuFFT 计划缓存等）是全局的，`gpu.py` 用一把锁串行化调用；多卡时用 `CUDA_VISIBLE_DEVICES` 选卡（只用 0 号设备）。
- `gpu.release()` 销毁缓存的 cuFFT 计划并把 CUDA 内存池里攒着的空闲显存还给系统（进程退出时会自动调用）。

## 随机数与可复现

- 默认（`host_noise=False`）：噪声在设备端用 Philox 生成，种子取自 `plan.rng`；同一份 `Plan` 重跑逐采样相同；整批、分块与单条跑的结果一致（信噪比 > 120 dB）。
- 与 CPU 版的关系：随机数不是同一组，逐采样对不上，但在「合成对原录音」的各项度量上没有系统偏移。
- `host_noise=True`：按 `_execute_numpy` 的抽取顺序在主机抽好随机数再上传，用同一份 `Plan` 与 CPU 版逐波形对照（测试用，慢）。
- 带时长抖动（`vary > 0` 且没给 `eq_db`）的任务，`gpu.plan` 把 FFT 点数定在「抖动 +2σ 的上界」，使同一批 take 共用一个 `m_base`、整批只有一组；多出来的是静音补零。所以 `gpu.render` 与 `core.render` 即使随机数相同，FFT 点数也不同，两者不会逐采样相等。

## 验证（本机，2026-11-22）

| 项目 | 结果 |
|---|---|
| GPU 对 CPU 逐波形（同一份 Plan、同一组主机随机数） | 24 条素材 × 8 种配置（单声道 / 立体声 / 单声道转立体声、起音、颗粒、纹理重抽、变时长尺寸音高），信噪比 ≥ 101 dB（float32 多轮迭代的累积误差） |
| 设备端随机数 vs CPU（vary = 0） | 24 条素材 × 8 个度量、每边 12 个种子：192 个检验 \|z\| > 3 为 0 个，各度量平均 z 在 −0.25…+0.20（标准误约 0.2） |
| 设备端随机数 + `m_floor` vs CPU（vary = 1，配对种子） | 24 条素材 × 6 个度量、每素材 8 对：跨素材平均差均 < 0.1 dB（\|t\| ≤ 0.91），标准差比在 ±6% 以内，144 项检验 \|z\| > 3 仅 1 个（随机期望 2.9） |
| compute-sanitizer | memcheck、initcheck、racecheck 均零错误、零泄漏 |
| `core.py` 对 Python 原型 | 64 个用例逐采样一致 |
| 显存与 OOM 边界（5.0 GB 空闲显存） | 按实测峰值校准 `_bytes_per_take`（大批量估算/实测比 1.03–1.49），64 条整批零 OOM 重试；单声道最长实测 100 s（663 ms），120 s 触发真 `GpuOutOfMemory` 后显存恢复、`auto` 退回 CPU |
| 速度（exact = 8、vary = 1） | 单条 5.6–54 ms（随 0.1–2.6 s 长度与声道数；CPU 86–1726 ms）；64 条整批 0.14–3.3 s，约为 CPU 的 30–43 倍 |

## 边界

- 起音检测要求「先静后响」；纹理类（风、水）没有起音约束。
- 立体声模型按 ILD / ICC 重构，单声道模型可输出双声道（`stereo_out=True`）。
- 命令行输入不超过 60 秒（模型约为原 WAV 的 24 倍，这是做音效的，不是做长片的）。
- 拟音链路的接入见下一节；作品默认不走 ERB，要在作品里显式打开。

## 接进拟音链路（`engine/audio/erb_foley.py`，默认关闭）

同一个动作重复出现时（连剪、连敲、脚步），不再「同一段样本反复播 / 变调」，而是每个事件各渲一条新的 take，不含来源的任何一段原始波形。

```python
from engine.audio import editorial, erb_foley

if erb_foley.enabled(film_json):                      # film.json 的 audio.erb.enabled === true；缺省 False，现有作品逐比特不变
    et = erb_foley.ErbTakes(device='auto', cache_dir='out/erb-cache')
    et.want('snip_q', takes_q, events=4)              # cue 标识、一到几段来源、事件数（事件 k 取第 k % len 段来源）
    et.want('snip_e', takes_e, events=4)
    takes = et.render()                               # 整片的全部候选合成一次 erb.render_many；et.report 是耗时与命中数
    series = editorial.schedule_action_series(times, takes=[w for w, _ in takes['snip_q']], policy='erb')
```

- 种子 = `take_seed(cue, 事件序号, 候选序号)`（sha256，不依赖 `hash()`），同一设备上重渲逐比特相同；GPU 与 CPU 的随机数不是同一组，缓存键里带设备。
- 缓存（`cache_dir`，每条一对 `<键>.npz` / `<键>.json`，键含来源波形、参数、cue、事件、erb 与本模块的代码哈希、设备）：命中就不再渲；读到坏文件按未命中重渲。
- 保真闸：每个事件默认渲 4 个候选（都在同一次批量里），取第一个「95% 带宽、>12 kHz 占比、>12 kHz 能量相对来源的偏差都 < 1.5 dB 且过 `sfx_judge`」的；都不达标取偏差最小的并标 `gate: 'fallback'`（`report['fallback']` 计数）。这是挑选，不是拼接。
- `ActionVariationDeck(policy='erb')`：takes 就是上面渲好的、每个事件一条，按事件顺序取，只按力度定增益，不变调、不均衡、不叠副层。
