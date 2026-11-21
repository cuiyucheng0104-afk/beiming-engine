# 离屏出片性能优化架构规格书（第一性原理版）

> 读者｜引擎工程师、离线渲染维护者与执行 agent　状态｜阶段 1（WP0.1–WP0.3）与阶段 2（WP1.2–WP1.3；WP1.1 按 2026-11-22 裁定撤回）已实测回填，其余阶段仍为草案（2026-11-22）　依据｜[决定书 D03 / D08 / D12](../decisions/2026-11-10-industrial-baseline.md)、[离屏出片设计与实测记录](README.md) §7.17–7.21

**一句话**：在严守「画质不降」与「预览 / 出片同源（D12）」两条红线的前提下，按物理瓶颈从大到小逐层消除固定启动、无效数据搬运、显存带宽浪费与采样复杂度上限，并通过无状态帧级切片把规模吞吐解耦到多卡 / 多机。

---

## 1. 问题定义与第一性原理模型

离线渲染从「场景数学描述 + 整数帧号 $f$」到「磁盘上合规的 H.264 成片」，端到端耗时由四类物理开销决定：

$$T_{\text{total}} = T_{\text{固定启动}} + \frac{N_{\text{帧}} \times \max\big(T_{\text{CPU}},\; T_{\text{GPU算力}},\; T_{\text{显存/总线带宽}},\; T_{\text{编码}}\big)}{\text{有效并行度 } P}$$

### 1.1 当前基线实测（2026-11-21）

测试平台：Linux x64，NVIDIA Lovelace 移动端 GPU（RTX 4070 Laptop），Node v26.8.2，`webgpu` 0.6.2，`three-webgpu` 0.187.0。下表是规格草稿形成时的历史测量，作品 `films/peng-glint/offscreen.mjs` 未入库，只用于定位结构，不作为本 PR 的验收基线。当时显式走 `--mode fast → h264_nvenc (cq 7)`、读回 `yuv420p`；**`main`（#38，a84819a3）的当前默认是 `--mode pro → libx264 High + rgba`，Fast 才是显式 NVENC 档**。测量期间本机另有常驻 ASR 进程占用约 2.4 GiB 显存与 11%–35% 算力，以下数字用于定位结构与相对比例，正式验收须按 §4.1 隔离基线复测。

| 维度 | 实测基线（作品：`films/peng-glint/offscreen.mjs`） | 物理瓶颈判定 |
|---|---|---|
| 1080p 144 帧端到端 | **3.82 s**（3.82–3.84 s），其中固定启动 **~2.6 s（68%）** | **启动主导**：着色器编译 ~0.80 s、`probeNvenc` 同步试编 0.25 s、PNG 解码 ~0.19 s、`createHost` ~0.15 s |
| 1080p 稳态单帧 | 端到端斜率 **6–9 ms/帧**；GPU 中位 **7.11 ms**（`scene` 3.02、`kuwahara` 1.38、`ink` 三遍 1.87）；主线程 `sha256` **1.65 ms/帧** | **GPU + 可消除的 CPU 哈希**：JS 业务逻辑本身仅 ~0.7 ms/帧 |
| 4K 稳态单帧 | 渲染+读回 **33.8 ms**（29.7 fps）：`kuwahara` **11.8 ms（35%）**、`scene` **10.6 ms（31%）**、`grade` **~4.5 ms（13%）**、`ink:stroke` **4.2 ms（12%）** | **GPU 采样吞吐与显存带宽**：Kuwahara 4K（`KR=10`，317 taps/px）已触及硬件约 225 G taps/s 取样上限 |
| 本机 WebGPU 硬件能力实测 | `adapter.limits.maxComputeWorkgroupStorageSize = 49152`（48 KB），但 `host.mjs` 未传 `requiredLimits` 实际仅申请到 **16384（16 KB）**；支持 `shader-f16`、`subgroups`、`timestamp-query`；`maxColorAttachments = 8` | 共享内存与 MRT 均有硬件余量，当前未启用 |

### 1.2 两条效率目标与两条品质红线

| 维度 | 定义 | 适用场景 |
|---|---|---|
| **目标 A：迭代时延（Latency）** | 单次短片（如 1080p 48–144 帧）或 lookdev 改参后看到结果的墙钟时间 | 创作调光、逐帧回归、CI 冒烟 |
| **目标 B：量产吞吐（Throughput）** | 单位时间内 1080p / 4K 终渲总帧数（长片 / 批量成片） | 多镜头成片、批量交付 |
| **红线 T0（零差异）** | 与改前输出逐字节相同，或因浮点/半精度舍入差 ≤ 1 级且 PSNR ≥ 75 dB、大差像素（≥ 5 级）为 0 | **无需重过 look 闸**；优先推进 |
| **红线 T1（同品质）** | 改变算法或采样策略以降低复杂度，视觉品质不降但像素允许可控变化 | **必须过 D08 look 闸**并由批准人签认后才能设为默认 |

**阶段 1 收紧**：WP0 全是调度、计数、Canvas 调用与内存生命周期优化，不涉及浮点算法；本阶段 T0 只接受**全部输出逐字节相同**，不允许拿上表给浮点优化预留的“差 1 级”条款放行。后续 WP1/WP2 若确需浮点或 Pass 合并，应单列为 T0f 验收，不与本阶段混写。

---

## 2. 架构红线与全局约束

1. **守住 D12 同源架构**：绝不为追逐 < 10% 的宿主 JS 开销而另起独立的 C++/Rust 渲染引擎。作品模块 `build(ctx) → { render(f) }` 仍须在 Chrome WebGPU 与 Node + Dawn 上零分叉运行。仅允许在**无作品侵入的底层输出通道**（见 WP4）评估极薄原生桥接。
2. **严守许可与边界（D03 / D12）**：不引入 `engine/native/`、RAEA、vork；新增依赖仅限宽松许可（MIT / BSD / Apache-2.0），放 `optionalDependencies` 并登记 `THIRD-PARTY.md`。文档、代码与 CLI 中**不把离屏出片称为「原生」**，对外命名不带 RTX。
3. **确定性不可破坏**：同一提交、同一机器、同一参数下，单跑、流水线（不同 `inflight`）、乱序单帧、常驻复用与多机切片合并的结果必须严格确定（像素级或码流级，按各工作包验收条款界定）。
4. **遵循仓库契约**：新命令使用 `tools/lib/cli.mjs` 的 `defineCommand` / `runCli`（支持 `--help`、`--json` 信封与统一退出码）；`engine/` 下新模块带中文头注释；所有新增能力先写失败测试（红）再实现（绿），含变异检查。

---

## 3. 分层工作包规格（WP0 – WP5）

### WP0：纯浪费清理（优先级 P0｜品质线 T0 零差异）

目标：不动架构、不改算法，先消掉已经实测证实的纯浪费项。

#### WP0.1 `probeNvenc` 异步化与初始化重叠
- **现状问题**：`engine/offscreen/encode.mjs` 的 `probeNvenc()` 用 `spawnSync` 同步试编一帧，阻塞主线程 233–286 ms，且排在 `host.load()` 与着色器编译之前。
- **规格**：
  - 新增 `probeNvencAsync(bin)`（基于 `child_process.spawn`，复用 `nvencProbeCache`，并发调用复用同一个 in-flight Promise，避免同一进程重复探测）。
  - `resolveEncodeAsync({ mode, encoder, pixFmt, width, height, probe })` 在 `cli.mjs` 与 `batch.mjs` 中与 `createHost()` / `host.load()` **并发启动**（`Promise.all`），在 `startEncoder()` 前 `await` 结果。
  - 保留同步 `probeNvenc` / `resolveEncoder` 供现有单元测试与同步调用方兼容。
- **验收**：
  - `offscreen render` 12 帧冷启动墙钟时间相对基线下降 ≥ 200 ms（探测时间完全隐藏在着色器编译中）。
  - 所有现有 `tests/offscreen/encode.test.mjs`、`batch.test.mjs`、`cli.test.mjs` 通过；新增并发重复调用只触发 1 次子进程的单元测试。

#### WP0.2 逐帧 `sha256` 按需化
- **现状问题**：`cli.mjs`（视频与静帧）和 `batch.mjs` 对每帧完整 YUV/RGBA 缓冲同步算 `sha256`（1080p 1.65 ms/帧，4K 约 6.5 ms/帧），但常规出片并不消费 `frameHashes`。
- **规格**：
  - 新增选项 `--frame-hashes <mode>`，可选值：`auto`（默认）、`on`、`off`。
    - 兼容策略：`--frame-hashes on` 保持当前行为；`--frame-hashes off` 跳过逐帧哈希，JSON 信封中 `frameHashes` 为 `null`（明确语义“未计算”，不输出空数组避免与 0 帧混淆）；`auto` 在 `--json` 时保持 `on`，人读模式为 `off`。`film build` 只消费实际编码器、画幅、帧数等字段，最终验收另做解码后 `framemd5`，所以显式传 `off`；直接调用 `runBatch()` 的兼容默认值仍为计算，CLI batch 按同一 `auto` 规则传值。`tools/baseline/determinism.mjs` 直接调用 `renderFrames` 并自行算哈希，不消费 CLI 的这个字段。
  - 备选增强：当 `--frame-hashes on` 且帧数 ≥ 24 时，可将缓冲拷贝或分批交由 `worker_threads` 异步算哈希，与 GPU 提交并行，退出前 `await` 汇齐（不改变任何输出值）。
- **验收**：
  - `--frame-hashes off` 下 1080p 稳态单帧 CPU 耗时下降 ≥ 1.4 ms/帧，成片 MP4 逐字节与 `--frame-hashes on` 一致。
  - `determinism.mjs` 与所有对拍测试通过。

#### WP0.3 2D 显示层（`overlay`）空帧跳过与脏帧检测
- **现状问题**：`engine/offscreen/film.mjs` 中只要作品传入 `draw`，即便某帧无字幕/图形或与上一帧静态字幕相同，每帧都会执行 `ctx.clearRect` + `ctx.getImageData(0, 0, W, H)` + 上传全幅纹理（4K 33 MB/帧）。
- **规格**：
  - 约定 `draw(ctx, t, shot, sctx)` 可选返回布尔值或状态标记（如返回 `false` 表示本帧空画布，无需上传；不返回值则按原语义执行以保持 100% 向后兼容）。
  - 在 `film.mjs` 内维护 `overlayEmpty` 布尔态：若连续空帧，直接跳过 `clearRect`、`getImageData` 与 `ovTex.needsUpdate = true`，并在同一条合成管线中置 `uOverlayOn = 0`（实现变量名 `overlayOn`，以 `ov.a * overlayOn` 保持空帧与透明叠图逐字节等价）；不另建第二套后期管线。
  - 进阶（透明加速，无需改作品代码）：借助 `canvas.mjs` 已有的 2D 探针，包装 `ctx` 的绘制方法（`fillText`、`strokeText`、`fillRect`、`drawImage`、`fill`、`stroke`、`putImageData`）计数 `drawCalls`——若 `draw()` 返回后 `drawCalls === 0`，自动判定本帧空画布，跳过 `getImageData` 与上传。
- **验收**：
  - 含 `draw` 但大段帧无字幕的作品（如 `films/chendu/offscreen.mjs`），全片渲染像素哈希与改前**逐字节相同**；空字幕帧 GPU `overlay` 段耗时趋近 0 ms。
  - 变异测试：某帧只画 1 个像素的 `fillRect`，探针必须检出 `drawCalls > 0` 并正常上传，不得漏画。

#### WP0.4 YUV 读回缓冲零多余拷贝（及 `srcBuf` 避坑契约）
- **实测约束（必读）**：已验证 `host.mjs` 创建的 `SRGBColorSpace` `RenderTarget` 底层 `GPUTexture` 格式为 **`rgba8unorm-srgb`**，且 three r187 未声明 `viewFormats: ['rgba8unorm']`。因此：
  - **禁止**直接对 `gpuTex` 创建 `rgba8unorm` 视图（触发 Dawn validation error）；
  - **禁止**在 Compute Shader 中直接对 `rgba8unorm-srgb` 做 `textureLoad` 再用近似公式重算 sRGB OETF，除非经实测证明对全部 256 个 8-bit 码值（0..255）**零误差精确还原**（`round(oetf(eotf(v/255)) * 255) === v` 对所有 $v \in [0, 255]$ 成立）。
- **规格**：
  1. **CPU 侧零额外拷贝（阶段 1 试作后撤回）**：曾实现 `packTexture(gpuTexture, { retain: true }) → { bytes, release }`，连续平面直接给编码器 mapped 视图，并等真实写回调后才 `release()/unmap()`。隔离复测显示它使 4K V8 堆峰值与 GC 时间上升，未过本项验收，所以 PR 不采用；`yuv.mjs`、`host.mjs`、`frames.mjs` 保持 `main` 的原拷贝路径。实测见 §5.1。
  2. **GPU 侧 `srcBuf` 评估**：先用 `gputimer` 单独量出 `copyTextureToBuffer → srcBuf` 在 4K 下的耗时（理论值 ~0.13 ms）；仅当其 > 0.5 ms 且完成 256 码值精确往返验证（或上游支持 `viewFormats`）时才移除 `srcBuf`。
- **验收**：
  - `rgbaToYuv420pCpu` 与 GPU `packTexture` 对拍仍保持**逐字节一致**（`tests/offscreen/yuv.test.mjs` 全绿）。
  - 144 帧 4K 渲染过程中 V8 堆峰值与 GC 耗时下降 ≥ 30%。

---

### WP1：显存带宽消除与常驻渲染架构（优先级 P1｜品质线 T0 零差异）

#### WP1.1 后处理 Pass 合并（`engine/offscreen/tsl/grade.js`、`look.js`）
- **现状问题**：`look.js` 中 `T.grade` 仅被紧随其后的 `grade.output(T.grade.texture, T.out)` 消费一次，连调试视图（`debug.js`）也不读 `T.grade`；这平白多出一次 4K `HalfFloat`（66 MB）全屏写与读。此外，当 `bloom` 关闭时，`T.fog` 也无邻域消费者。
- **规格**：
  1. **无条件合并 `grade + output`**：在 `grade.js` 中将 `sRGBTransferOETF(c)` 直接合入 `grade` 片段着色器末尾，输出 `vec4(sRGBTransferOETF(c), prot)` 直写 `T.out`；删除 `T.grade` 渲染目标与 `grade.output()` 遍。
  2. **按需内联 `fog`（仅当 `bloom` 关闭时）**：`bloom` 开启时，`bloom` 软阈值必须读取雾后图像，故 `T.fog` 保持独立一遍；当 `!(BL && BL.strength > 0)` 时，`grade` 变体直接复用 `fogNodes` 在同遍计算雾并跳过 `T.fog` 读写。
  3. **`gputimer` 兼容**：合并后 `grade` 段涵盖调色与输出变换，不新增误导性空段。
- **验收**：
  - 4K `grade` 耗时下降 ≥ 35%，显存占用减少 1 张 4K `HalfFloat`（~66 MB）。
  - 像素一致性：对优化前副本，全链路（含 bloom 开/关、fog 开/关、protect 开/关）**最大差 ≤ 1 级，PSNR ≥ 75 dB，大差像素 = 0**；`look.test.mjs`、`layers.test.mjs` 与 Chrome WebGPU 对拍原样通过。

#### WP1.2 常驻渲染守护进程（`offscreen daemon`）
- **目标**：把单次短片 / 迭代出片的 2.6 s 冷启动压到 < 0.3 s，同时为 `lookdev:sweep`、CI 与批量短片提供共享预热池。
- **架构与协议**：
  - CLI 入口：`node engine/offscreen/cli.mjs daemon [--socket <路径>] [--idle-timeout 600] [--max-cached-works 4]`。
  - 传输：只走本机 IPC，不监听 TCP 端口。Linux/macOS 用 Unix Domain Socket，放在当前用户专属、非符号链接、权限 `0700` 的目录里（`$XDG_RUNTIME_DIR/beiming-offscreen.sock`，否则 `<临时目录>/beiming-offscreen-<uid>/daemon.sock`），先校验目录再 listen，socket 再 `chmod 0600`；客户端连接前校验 socket 与父目录属主为当前用户。Windows 用 Named Pipe（`\\.\pipe\beiming-offscreen-<仓库与用户名哈希>`）：Node 不能给命名管道设 ACL，只有系统默认访问控制，**不保证仅限同用户**，多用户共用的 Windows 机器上不要开守护进程。
  - 协议：行分隔 JSON-RPC（`render` / `stills` / `probe` / `profile` / `stats` / `shutdown`），返回与 CLI `--json` 完全一致的信封格式。
  - **资源复用与隔离**：
    - 进程级常驻：单个 `GPUDevice`、已探测编码器能力缓存、公共后期管线（`YuvPacker`、`Kuwahara` 编译变体、`Ink`、`Grade`、`Bloom`）与按路径+mtime 缓存的静态贴图/字体字节。
    - 作品模块失效：每次请求检查作品模块及依赖文件（或 `mtime` 签名）；文件变动时用带 `?v=<mtime>` 的 ESM 导入并销毁旧 `work`，避免陈旧代码。
    - 故障隔离：注册 `device.lost` 与未捕获 GPU 错误监听；一旦设备丢失，中止当前作业并返回 `failure.gpu`，守护进程自动重建设备或优雅退出由客户端拉起。
  - 客户端透明接入：`offscreen render/stills/profile` 支持 `--daemon [auto|off|<socket>]`（默认 `off`，显式启用或经环境变量 `BEIMING_OFFSCREEN_DAEMON=1` 开启，未连通时 `auto` 自动退回冷启动）。
- **验收**：
  - 热态下重复渲染 `films/peng-glint/offscreen.mjs` 1080p 144 帧端到端耗时 **≤ 1.5 s**（相对冷启动 3.82 s 提速 ≥ 2.5×）。
  - 连续跑 20 次不同画幅 / 作品后，显存增长 ≤ 5%（无 `RenderTarget` / `GPUBuffer` 泄漏）。
  - 常驻渲染输出与冷启动输出**逐字节相同**；修改作品文件后下一次请求立刻反映新代码。

#### WP1.3 着色器管线持久化缓存（调研项）
- 核查当前 `webgpu@0.6.2`（Dawn）及系统 Vulkan 驱动（`__GL_SHADER_DISK_CACHE` / `MESA_SHADER_CACHE_DIR`）的持久化管线缓存生效情况。
- 若环境变量即可启用驱动级 SPIR-V/ISA 磁盘缓存，在 `host.mjs` / `docs/ENVIRONMENT.md` 中规范化缓存目录（落入 `.cache/`，不入 git）并实测冷启动二次运行 `createRenderPipeline` 降幅。

---

### WP2：4K GPU 核心算子破壁（优先级 P2｜T0 优先，T1 备选过 look 闸）

#### WP2.1 Kuwahara 4K 破采样墙（`engine/offscreen/tsl/kuwahara.js`）
- **物理分析**：4K 下 `KR=10` 每像素采 317 次，已打满硬件 225 G taps/s 取样上限。邻近像素窗口高度重叠，用片上 Shared Memory 可将 L1/L2 纹理取样量降 15×–60×。
- **前置硬件配置**：`engine/offscreen/host.mjs` 在 `adapter.requestDevice()` 时，按需申请 `requiredLimits.maxComputeWorkgroupStorageSize = Math.min(adapter.limits.maxComputeWorkgroupStorageSize, 49152)`（当适配器支持时，从 16 KB 升至 48 KB），同时保留 16 KB 设备回退路径。
- **路径 A（T0 零差异 · WGSL Compute + Shared Memory）**：
  - 仅在 `KR ≥ 8`（1440p / 4K）时启用 Compute 路径；`KR ≤ 7` 继续走现有片段着色器。
  - 工作组布局：
    - 48 KB 共享内存：`16×16` 线程块，光晕半径 $H = \lceil \max(r, r_f) \rceil + 1$（4K `maxRad=14` 时 $H=15$，块尺寸 $46\times 46 = 2116$ 纹素）；每个纹素用 `vec4<f16>`（或 2×`u32` `pack2x16float`）存 8 字节，共 **16.9 KB**。
    - 16 KB 共享内存回退：`8×8` 线程块，$38\times 38 \times 8\text{ B} = 11.5\text{ KB} < 16\text{ KB}$。
  - 组内先协作把 $(W_{\text{blk}}+2H)\times(H_{\text{blk}}+2H)$ 整数纹素加载入 `workgroup` 数组，`workgroupBarrier()` 后每个线程在共享内存上做双线性插值并跑标量方差累加。
  - **强制 Micro-benchmark 闸门（防负优化）**：共享内存里的软件双线性插值（4 次 LDS 读 + 3 次 mix）不一定比硬件 TMU 快。必须先做独立原型对拍：
    - **Go 条件**：4K `kuwahara` 实测下降 **≥ 20%**（即 11.8 ms → ≤ 9.4 ms），且与原实现对比 `maxDelta ≤ 1, PSNR ≥ 78 dB, bigPixels = 0`。
    - **No-Go 回退**：若因 LDS 带宽或寄存器溢出未达标，立即放弃路径 A，记录实测数据入 `docs/offscreen/README.md`，转评估路径 B。
- **路径 B（T1 同品质 · 过 D08 look 闸，备选）**：
  - 当开启 `far` 且 `farRadius > radius` 时，在 1/2 分辨率下以 `farRadius / 2`、`KR_far = ceil(farRadius / 2)` 计算远景大笔触（工作量降为 1/16），全分辨率仅以小 `KR` 算前景笔触并按深度混合。
  - 必须产出一组对比静帧 + 视频，经用户 look 闸签认后通过显式参数开关引入，不得静默替换旧语义。

#### WP2.2 `ss=1` 时主场景与 ID 通道 MRT 合并（T0 零差异）
- **现状问题**：`ss=1` 时 `scene` 与 `ink:ids` 同分辨率，但 `idpass.js` 将整个场景重新遍历、换材质、提交 Draw Call 并光栅化第二遍。
- **规格**：
  - 仅在 `ss === 1 && msaa === 0` 且场景中所有描边物体均使用 `toonKind` TSL 材质、无 `soft` / `own` 混合遮挡物、无独立 `outlineVertex` 时，自动启用 MRT 快速路径。
  - `T.scene` 升级为双颜色附件（`count: 2`）：Attachment 0 = 线性 HDR 颜色，Attachment 1 = `(idLo, idHi, width, alpha)`，共用同一张 `FloatType` 深度纹理。
  - 凡检测到不满足前置条件的物体（如自定义 `outlineVertex`、半透明 `soft` 挡线），自动无缝回退双遍 `idpass.render()`，不抛错、不静默画错。
- **验收**：
  - 满足 MRT 条件的场景在 `ss=1` 下 `ink:ids` 耗时降为 **0 ms**；渲染像素与双遍回退路径**逐字节相同**。
  - 变异测试：加入 `soft` 透明挡线物体与自定义 `outlineVertex` 物体，验证自动回退且输出与原路径一致。

#### WP2.3 时间维度静态帧 / 一拍二复用（T0 零差异，可选契约）
- **规格**：作品模块可选实现 `stateKey(f) → string | null`（纯函数，返回当前帧所有影响画面的状态摘要，如镜头号 + 量化后的节拍号）。
- 若 `stateKey(f) !== null && stateKey(f) === prevKey`，`frames.mjs` 跳过 `host.renderFrameYuv(work, f)`，直接复用上一帧已打包的 YUV 字节流喂给编码器。
- **验收**：对含一拍二或定格镜头的作品，重复帧 GPU 耗时为 0，成片码流与未启用 `stateKey` 时**逐字节相同**；`stateKey` 缺省时不改变任何现有行为。

---

### WP3：无状态帧级多卡 / 多机切片分发（优先级 P3｜品质线 T0 零差异）

目标：利用 `work.render(f)` 帧间无状态依赖的物理特性，把长片（如 3–10 分钟 4K）吞吐按可用 GPU 数量线性放大。

- **架构**：复用 `tools/remote/`（工作树同步、整机槽位锁、sha256 产物核对）与 `engine/render/lib/chunks.mjs` 的分块思想，新增编排器 `tools/offscreen/farm.mjs`（或接入 `tools/remote/cli.mjs` 子命令 `shard`）。
- **切片与无损拼接契约**：
  1. **切片规则**：按 `[from, to)` 切成 $M$ 个连续帧段（优先对齐镜头切点；若单镜过长则按固定块长如 120/240 帧切分）。
  2. **编码对齐要求（保证 `ffmpeg -c copy` 无缝）**：
     - 所有工作节点必须使用相同提交 SHA、相同分辨率、相同 fps、相同编码器参数（`nvenc cq 7` 或 `x264 crf 14`，含完整 BT.709 色彩标记）与一致的像素格式（`yuv420p`）。
     - 每个切片输出独立的封闭 GOP（首帧为 IDR 关键帧，`-g` 与时间基 `-video_track_timescale` 固定统一），避免拼接处出现 B 帧跨段引用或时间戳跳变。
  3. **拼接与核验**：
     - 本地通过 FFmpeg `concat` demuxer（`-f concat -safe 0 -i list.txt -c copy`）零重编码合并，耗时毫秒级。
     - 核验总帧数严格等于 `to - from`、无 PTS 倒退/空洞、色彩标签完整、逐段 sha256 留痕。
  4. **容错**：单块失败仅重试该块（可调度到另一台健康节点），不重跑已完成切片。
  5. **混卡注意**：不同型号 GPU / 驱动版本的 NVENC 比特流可能不逐字节相同，但均满足画质门槛；若需要跨机严格逐字节一致，切片编排支持指定 `--encoder x264`（同版 FFmpeg）或限定同构节点标签。
- **验收**：
  - 本机 `--transport local` 模拟双槽位分片端到端跑通：合并成片帧数精确、PTS 严格单调、解码后抽帧像素与单机整段渲染在拼接边界处**逐像素无接缝误差**（`diffRgba` 对无损中间/同参数对比通过）。
  - 在 2 台以上 GPU 工作站实测 4K 长片，端到端吞吐达到单机的 **≥ 1.7×**（含传输与拼接）。

---

### WP4：VRAM → NVENC 零拷贝原生输出桥接（优先级 P4｜品质线 T0 零差异｜按条件触发）

- **触发门槛（避免过早优化）**：**仅当** WP0–WP2 完成后，在 4K 单卡高吞吐场景下实测「`mapAsync` 读回 + Pipe 写入 + FFmpeg 上传」合计占比 **> 15%** 时，才立项实施 WP4。
- **架构约束**：
  - 严守 D12：只替换「像素读回 + Pipe → NVENC」这最后一公里，**不碰** three.js / TSL / 作品代码。
  - 实现形态：独立的宽松许可（MIT / BSD-3-Clause）可选原生 N-API 插件（C++ 或 Rust），封装为可选依赖；缺插件或非 NVIDIA/Linux/Windows 支持环境时自动无缝回退到 `yuv.mjs + FFmpeg Pipe`。
  - 数据通路：从 Dawn 导出渲染/YUV 纹理的外部显存句柄（Linux `OpaqueFD` / DMA-BUF，Windows `DXGI SharedHandle`）→ 导入 CUDA / NVENC（或 Vulkan Video Encode）直接编码输出 H.264 Annex-B 码流 → 封装进 MP4。
- **验收**：
  - 4K 渲染时 PCIe 帧数据回传带宽降为 **0**，CPU 占用率下降 ≥ 50%。
  - 编码画质（PSNR-Y / SSIM / VMAF）与 `nvenc cq 7` 基线持平，四项 BT.709 色彩标签与帧数契约完全通过 `probe` 检查。

---

### WP5：制作流中间层缓存（优先级与 WP1/WP2 并行｜品质线 T0 零差异）

- **物理原理**：lookdev 调光、调纸纹、调墨线或改字幕时，3D 几何与光照（`scene` + `depth` + `idTarget`）完全没变，重渲 3D 属于 100% 重复计算。
- **规格**：
  - 在 `offscreen` 侧增加可选的中间层快照能力（供 `tools/lookdev/sweep.mjs` 与交互审片台使用）：对指定帧号把 `T.scene`（HalfFloat）、`T.scene.depthTexture`（Float32）与 `ink.idTarget` 暂存在显存（常驻模式下）或临时无损缓冲中。
  - 参数扫频（`lookdev:sweep`）改变 `grade / fog / bloom / kuwahara / paper / vignette / grain` 时，跳过 `scene` 与 `ink:ids`，只重跑后期段。
- **验收**：
  - 4K `lookdev:sweep` 扫 10 组调色/雾参数，总耗时相对完整重渲下降 **≥ 40%**，输出画面与完整重渲**逐字节相同**。

---

## 4. 统一验证、质量门与基准协议

### 4.1 性能测量纪律（必守）
所有进入文档与 PR 的性能数字必须满足：
1. **环境声明**：记录 GPU 型号、驱动版本、FFmpeg 版本、Node 版本，以及 `nvidia-smi` 是否存在并发占卡进程；正式对比尽量在独占 GPU 下完成，无法独占时必须采用**交替 A/B 多轮（至少 3 轮）**并报中位数与区间。
2. **口径分离**：永远分开报告三项数字——① 固定启动耗时（秒）、② 稳态渲染+读回（ms/帧、fps，由两档帧数差斜率或预热后测量）、③ GPU 分段中位（`offscreen profile`）。不把冷启动摊进短片 fps 制造假象。
3. **测试矩阵**：至少覆盖两档分辨率（`1920x1080`、`3840x2160`）与两类作品（重后期 3D 片如《化鹏闪羽》/《晨渡》+ 轻演示片 `lab/offscreen/ink.mjs`）。

### 4.2 质量与回归验收矩阵

| 变更等级 | 必跑验证 | 通过门槛 |
|---|---|---|
| **T0（零差异）** | 1. 单元 + 变异测试（`node --test tests/offscreen/*.test.mjs`）<br>2. 实片像素对拍（1080p + 4K，旧实现 vs 新实现）<br>3. `npm run determinism -- films/chendu --renderer offscreen --seams`<br>4. Chrome WebGPU 同源对拍（`npm run offscreen:compare`）<br>5. 仓库全检（`npm run check`、`npm run comp:scan -- --staged`） | 纯逻辑/拷贝优化：**最大差 = 0（逐字节相同）**；<br>浮点/Pass 合并优化：**最大差 ≤ 1、PSNR ≥ 75 dB、大差像素 = 0**；<br>预览对出片：**PSNR ≥ 50 dB、大差像素 ≤ 0.1%** |
| **T1（同品质）** | 以上全部 + 1080p/4K 对比静帧与成片包 + **D08 look 闸签认** | 必须有用户原话认可记录，不得由 agent 自行放行或静默改默认 |

---

## 5. 推进顺序与 Go/No-Go 闸门

| 阶段 | 包含工作包 | 预计改动面 | 阶段目标与闸门 |
|---|---|---|---|
| **阶段 1（M8）** | WP0.1 – WP0.3（WP0.4 试作后已撤回，见 §5.1） | `encode.mjs`、`cli.mjs`、`batch.mjs`、`film.mjs` | 零架构变动；1080p 144 帧冷启动 ≤ 3.3 s，稳态 CPU 余量降到 < 1 ms/帧，全项 T0 逐字节等价 |
| **阶段 2（M9）** | WP1.2 – WP1.3（WP1.1 试作后按 2026-11-22 裁定撤回，见 §5.2） | 新增 `daemon.mjs`、`cli.mjs`、`host.mjs`、`load.mjs`、`film.mjs`、`canvas.mjs` | 4K `grade` 降 ≥ 35%（WP1.1 撤回，未达）；常驻热出片 1080p 144 帧 ≤ 1.5 s（轻/中片达标，重后期《晨渡》2.744 s 受稳态渲染限制）；20 轮无显存泄漏（达标） |
| **阶段 3（M10）** | WP2.1 – WP2.3 + WP5 | `host.mjs`、`tsl/kuwahara.js`、`tsl/idpass.js`、`frames.mjs` | WP2.1 必须先过 Micro-benchmark 闸门（4K Kuwahara ≥ 20% 提速），不达标即停并转评估 T1 方案；`ss=1` MRT 零像素差 |
| **阶段 4（M11）** | WP3 | `tools/offscreen/farm.mjs`、`tools/remote/` | 多卡/多机切片 + `ffmpeg -c copy` 合并跑通，长片吞吐随卡数近线性增长 |
| **按需（M12）** | WP4 | 独立宽松许可可选 N-API 模块 | 仅当 4K 读回+Pipe 实测占比 > 15% 时立项，否则不做 |

### 5.1 阶段 1 实测回填（2026-11-21，基线 `a84819a3`）

**环境**：Linux x64，RTX 4070 Laptop（驱动 620.73.04），Node v26.8.2，FFmpeg n9.1，`webgpu` 0.6.2，`three-webgpu` 0.187.0。本机并非独占 GPU：常驻 ASR 进程占约 2.4 GiB 显存、`mpv` 占约 0.4 GiB，每次出片前 `nvidia-smi` 读到的利用率在 11%–54% 之间波动。因此全部对比按 §4.1 做**交替 A/B、各 3 轮**（基线为隔离的 `git worktree` 检出，改前默认带逐帧哈希，改后显式 `--frame-hashes off`），下表取中位数。原始日志在 `out/wp0-results/`（不入库）。

**与 `main` 现状的对齐**（规格书草稿写于 #38 之前）：默认已是 `--mode pro`（x264 High + rgba），Fast 才是显式 NVENC；因此冷启动目标、WP0.1 的探测重叠只对 Fast 有意义（Pro 不探测）；T0 一律按**逐字节相同**验收，不使用草稿里给浮点优化预留的“差 1 级”条款；草稿里的《化鹏闪羽》未入库，测量作品换为库内的《晨渡》《度》。

| 作品与档位（1080p） | 改前中位 | 改后中位 | 变化 |
|---|---:|---:|---:|
| 《晨渡》Fast 12 帧 | 2.458 s | 2.132 s | −0.326 s |
| 《晨渡》Fast 144 帧 | 5.872 s | 5.106 s | −0.766 s |
| 《晨渡》Pro 144 帧 | 8.760 s | 6.924 s | −1.836 s（独立复核 4 轮交替每轮都更快，中位 8.705 → 7.048 s，−1.658 s） |
| 《度》Fast 96 帧 | 1.993 s | 1.736 s | −0.257 s |
| 《度》Pro 96 帧 | 3.522 s | 3.481 s | −0.041 s |

各项结论：

- **WP0.1 达标**：Fast 12 帧冷启动下降 0.326 s（目标 ≥ 0.2 s）；并发探测只起 1 个子进程由 `encode.test.mjs` 的真实子进程计数用例保证。
- **WP0.2 部分达标**：`--frame-hashes off` 单帧哈希主线程耗时 1.27–1.34 ms → 0.0007 ms（未达草稿的 ≥ 1.4 ms，草稿估值偏高）；MP4 与 `on` 逐字节相同。Pro 档的收益是真实的：独立复核 4 轮交替每一轮改后都更快（中位 8.705 → 7.048 s）。原因有两个：Pro 读回 rgba，1080p 一帧约 8.3 MB，`sha256` 比 Fast 的 yuv420p（约 3.1 MB）贵约 2.7 倍；《晨渡》前 96 帧显示层为空，省掉了每帧 `getImageData` 与全幅上传。《度》没有显示层，Pro 几乎没变（−0.04 s），印证了后者。Fast 单帧哈希本身约 1.3 ms/帧。
- **WP0.3 达标（功能）**：`draw` 返回 `false` 表示本帧不叠图，但画布是否脏（需要下帧先清）单独按「是否发生过绘制调用」跟踪，所以“画了又返回 false”的下一帧没有残留（`film.test.mjs` 有用例）；《晨渡》空字幕帧不再 `clearRect`/`getImageData`/上传；测试覆盖“只画 1 像素的 `fillRect` 不漏画”。`profile`（帧 0、24、48 为空显示层，3 轮）的 `compose` 段由 2.6–9.4 ms 降到 0.13 ms；帧 96、120（有片名）仍为 16–43 ms，与改前一致（此段含 GPU 等待与跑间波动，只看量级）。
- **WP0.4 No-Go（已撤回）**：试作了 `retain` 视图零拷贝（等 `enc.write` 的真实写回调后再 `unmap`）。4K 144 帧、同代码仅开关零拷贝的隔离对照：V8 堆峰值 75.7 → 100.5 MB，GC 总耗时 225 → 288 ms（GC 次数 246 → 245，几乎不变），未达“堆峰值与 GC 耗时下降 ≥ 30%”，反而变差，故不采用，`yuv.mjs`、`host.mjs`、`frames.mjs` 保持 `main` 原样。`srcBuf` 评估与 `rgba8unorm-srgb` 限制本阶段未动。
- **阶段闸门未达**：① 1080p 144 帧冷启动 ≤ 3.3 s——库内 Fast 《晨渡》144 帧为 5.106 s（改前 5.872 s），启动之外还有渲染本身（稳态 GPU 约 25–30 ms/帧量级），WP0 范围的纯浪费清理到不了 3.3 s，需要 WP1 的常驻进程与管线缓存；② 稳态 CPU 余量 < 1 ms/帧——主线程 `work.render` 同步段实测 18–25 ms/帧（见下），未验证到。
- **稳态主线程口径**：`work.render` 同步段 18–25 ms/帧（跑间波动大，on/off 差在噪声内），哈希段 1.3 ms/帧 → ≈ 0；`process.cpuUsage()` 会把 Dawn 原生线程计入，不能当主线程成本。

**T0 逐字节核对**（改前 `a84819a3` 对改后，同命令同帧段，`cmp` 与仓库 `diffRgba`）：

- MP4：《晨渡》（0:4、96:100）、《度》（0:4、72:76）× 1080p/4K × Pro/Fast 共 16 组，《晨渡》92:100 过渡段 × 1080p × Pro/Fast 共 2 组，另有交替基准中的 15 组（《晨渡》12/144 帧、《度》96 帧，Pro/Fast），共 33 组，全部逐字节相同。
- 无损 PNG：《晨渡》（帧 0、3、96、99）、《度》（帧 0、3、72、75）× 1080p/4K 共 16 张，`maxDelta = 0`、`differPixels = 0`。
- 《晨渡》第 96 帧是片名首次出现，92:100 段覆盖了显示层由空变非空的过渡。
- 仓库 `npm run determinism`、Chrome WebGPU 对拍（`offscreen:compare`）、`golden` 本阶段未单独复跑（Chrome 对拍需要无头浏览器，`golden` 在本机缺 Python 3.12 锁会退出码 3）。

### 5.2 阶段 2 实测回填（2026-11-22，基线 `4e95369a`）

**环境**：Linux x64，RTX 4070 Laptop（驱动 620.73.04），Node v26.8.2，FFmpeg n9.1，`webgpu` 0.6.2，`three-webgpu` 0.187.0。本机非独占 GPU：常驻 ASR 进程（`recordian/.venv-asr`）占用约 2464 MiB 显存，测量期间 `nvidia-smi` 利用率在 4%–37% 间波动。全部耗时对比按 §4.1 做**同条件交替 3 轮**取中位数（统一 `--frame-hashes off`，原始日志在 `out/wp1-results/`，不入库）。

#### 1) WP1.1（后处理 Pass 合并）— 按 2026-11-22 裁定撤回

- **试作实测**：将 `grade + output` 合并（省 1 张 4K `HalfFloat` ≈ 66 MB）并在 `bloom` 关闭时内联 `fog`，4K `offscreen profile` 交替 3 轮中位：`grade` 段《晨渡》`0.72 → 0.39 ms`（−46%）、《度》`0.66 → 0.39 ms`（−41%），整帧收益约 0.33 ms（占 4K 整帧 20–24 ms 的 ~1.5%）。
- **像素与裁定**：与 `main` 对拍《晨渡》《度》1080p/4K 共 12 张 PNG，全部为 `maxDelta = 1`、大差像素 = 0，但 **PSNR ≈ 64.1–64.4 dB**（约 2.6% 通道 ±1 级），既未达 T0 逐字节相同，也低于规格书 T0f 预留的 75 dB 门槛（即便在着色器内插入防驱动对消的 `pack2x16float/unpack2x16float` 仍无法逐位复现硬件 `rgba16float` 中转舍入与重编译调度差异）。
- **结论**：按主人 2026-11-22 裁定**撤回 WP1.1 全部像素改动**（分支上不留开关、不留死代码，`tsl/grade.js` 与 `tsl/look.js` 保持 `main` 原样）；阶段 2 闸门「4K `grade` 降 ≥ 35%」如实记为**未达**。

#### 2) WP1.2（常驻渲染守护进程 `offscreen daemon`）— 达标（除重后期片受 GPU 稳态下限约束外）

默认路径完全不变（不传 `--daemon` 且不设 `BEIMING_OFFSCREEN_DAEMON` 时走原有一次性进程）；显式开启 `offscreen daemon` 后，客户端通过 `--daemon auto|on|<socket>`（或 `BEIMING_OFFSCREEN_DAEMON`）经本机 Unix Domain Socket（当前用户 `0700` 私有目录内、权限 `0600`）或 Windows Named Pipe（仅系统默认访问控制）接入，复用单个 `GPUDevice`、编码器探测缓存与 LRU 作品池（默认 4 槽，文件或本地依赖变更即通过 `?v=<sig>` 与同步 `resolve` hook 热失效；`device.lost` 自动清理并重建设备；启动时探测清理崩溃残留 socket——只删 socket，路径上是普通文件或符号链接时以用法错误拒绝启动、原样保留——已有存活实例时返退出码 5 `busy.daemon`）。共享模块（`engine/`、`tools/` 等）不参与热重载、保持单实例，改了它们要重启守护进程。

**冷启动 vs 常驻热出片（3 轮交替中位数，端到端墙钟含 CLI 启动与 IPC，括号内为 3 轮原始值）**：

| 作品与档位 | 冷启动中位（`--daemon off`） | 常驻热出片中位（`--daemon`） | 降幅 / 加速 | 热出片稳态 fps |
|---|---:|---:|---:|---:|
| `lab/offscreen/ink.mjs` 1080p 144 帧 Fast | 1.457 s（1.457, 1.469, 1.310） | **1.119 s**（1.119, 1.135, 1.010） | −0.338 s（1.30×） | 153.6 fps |
| 《度》1080p 96 帧 Fast | 1.510 s（1.613, 1.510, 1.510） | **0.794 s**（0.802, 0.794, 0.784） | −0.716 s（1.90×） | 154.1 fps |
| 《度》1080p 96 帧 Pro | 2.932 s（2.783, 2.966, 2.932） | **2.162 s**（2.162, 2.155, 2.190） | −0.770 s（1.36×） | 47.8 fps |
| 《晨渡》1080p 12 帧 Fast（短片迭代） | 1.973 s（1.973, 2.023, 1.931） | **0.442 s**（0.426, 0.515, 0.442） | −1.531 s（**4.46×**） | 39.9 fps |
| 《晨渡》1080p 144 帧 Fast | 4.542 s（4.644, 4.542, 4.307） | **2.744 s**（3.012, 2.721, 2.744） | −1.798 s（1.66×） | 56.1 fps |
| 《晨渡》1080p 144 帧 Pro | 6.187 s（5.858, 6.187, 6.267） | **4.440 s**（4.440, 4.439, 4.543） | −1.747 s（1.39×） | 33.7 fps |
| `lab/offscreen/ink.mjs` 4K 24 帧 Fast | 1.437 s（1.532, 1.437, 1.425） | **0.969 s**（0.981, 0.960, 0.969） | −0.468 s（1.48×） | 36.4 fps |
| 《晨渡》4K 24 帧 Fast | 2.776 s（2.835, 2.753, 2.776） | **1.249 s**（1.387, 1.249, 1.160） | −1.527 s（**2.22×**） | 26.3 fps |

- **口径拆解（回应阶段 1「1080p 144 帧冷启动 ≤ 3.3 s」与阶段 2「常驻热出片 1080p 144 帧 ≤ 1.5 s」）**：
  - **冷启动口径**（一次性进程，含 Node + Dawn + `host.load` + 着色器编译 + 编码探测）：《晨渡》1080p 144 帧 Fast 为 **4.542 s**（较阶段 1 的 5.106 s 进一步下降约 0.56 s，仍 > 3.3 s，因为固定启动约 1.8 s + 144 帧稳态渲染约 2.6 s）；轻/中作品 `ink` 144 帧冷启动 **1.457 s**、《度》96 帧冷启动 **1.510 s**（按稳态 154 fps 折合 144 帧约 1.82 s）均已 ≤ 3.3 s。
  - **常驻热出片口径**（`offscreen daemon` 热缓存命中，固定开销被压至 **~0.14–0.18 s**，含 CLI 启动 + IPC + 编码器启停）：
    - `ink` 1080p 144 帧 Fast = **1.119 s ≤ 1.5 s**（达标）；《度》96 帧 Fast = **0.794 s**（按 154.1 fps 折合 144 帧约 **1.11 s ≤ 1.5 s**，达标）。
    - 《晨渡》1080p 144 帧 Fast = **2.744 s**（已显著低于阶段 1 的 3.3 s 线，但未达 1.5 s 线）：原因在渲染本身而非启动——《晨渡》每帧含 4×MSAA + `ss=2` 墨线 + Kuwahara，稳态约 17.8 ms/帧（56.1 fps），144 帧纯渲染+编码物理下限就是 **~2.57 s**，与规格书草稿里单帧 7.11 ms 的未入库样片《化鹏闪羽》负载量级不同。要再降重后期片 144 帧热出片时间，属于 WP2（GPU 核心算子优化）范畴。
- **20 轮连续不同作品 / 画幅显存泄漏曲线（`--max-cached-works 4`，8 种 `(作品, 画幅)` 组合含 720p/1080p/1440p/4K 轮转 20 轮，每轮触发 LRU 淘汰与 `host.dispose()`）**：
  - 实测先暴露并根治了两处常驻场景才浮出的资源释放缺口：① `engine/offscreen/film.mjs` 的 `dispose()` 原先未释放各镜头 `scene` 挂载的 `geometry`/`material`/`texture`/`light.shadow`；② `engine/offscreen/canvas.mjs` 的 `loadFilmFonts()` 原先重复向 Skia 注册同一字体子集。修复后单作品连续建毁 6–8 次的进程专属显存：`ink` 恒定 `66 MiB`、`du` 恒定 `441 MiB`、`chendu` 恒定 `523 → 525 MiB`（0% 增长）。
  - 20 轮混跑进程专属 VRAM（`nvidia-smi` daemon PID）：第 4 轮填满 4 槽（1080p/720p）`1042 MiB` → 经第 7–8 轮首次 4K 峰值 `2896 MiB` 后，Vulkan 分配器保留约 60 MiB slab 池；进入稳态周期后同状态对比：第 11 轮 vs 第 19 轮（`chendu 1080p`）`1297 → 1299 MiB`（**+0.15%**），第 12 轮 vs 第 20 轮（`ink 720p`）`1102 → 1104 MiB`（**+0.18%**），第 8 轮 vs 第 16 轮（`ink 4K` 峰值）`2896 → 2924 MiB`（**+0.97%**）——远低于 **≤ 5%** 显存泄漏闸门，**达标**。

#### 3) WP1.3（着色器管线持久化缓存）— 调研完成并落地规范化目录

- **核查结论**：
  - `webgpu@0.6.2`（`node-webgpu`）仅导出 `{ create, globals, isMac }`，未暴露 Dawn `BlobCache` / `CachingInterface` 回调，因此 WGSL→SPIR-V 转换（`createShaderModule` 43 次约 65–73 ms）每次进程启动仍须重做。
  - NVIDIA Vulkan 驱动支持进程级环境变量 `__GL_SHADER_DISK_CACHE` / `__GL_SHADER_DISK_CACHE_PATH` / `__GL_SHADER_DISK_CACHE_SKIP_CLEANUP`（Mesa 对应 `MESA_SHADER_CACHE_DIR`），且在 Node 进程内于 `import('webgpu')` 前设置可被驱动实时生效。
- **落地**：在 `engine/offscreen/load.mjs` 新增 `configureShaderCacheEnv()`，于 `loadGpu()` 加载 `webgpu` 前自动将驱动级缓存规范到仓库 `.cache/offscreen-shader-cache/{nvidia,mesa}`（`.cache/` 已 git 忽略，支持 `BEIMING_SHADER_CACHE=0` 关闭或 `BEIMING_SHADER_CACHE_DIR` 覆写，完全尊重用户已有驱动环境变量；目录不可写时静默降级），并同步登记到 `tools/env/spec.json` 与 `docs/ENVIRONMENT.md`。
- **3 轮交替实测（《晨渡》1080p 冷启动到第 0 帧完成，隔离空缓存目录）**：

| 条件 | `createRenderPipeline`（26 次）中位 | `createComputePipeline`（1 次）中位 | 首帧耗时中位 | 总冷启动中位 |
|---|---:|---:|---:|---:|
| 禁用缓存（`__GL_SHADER_DISK_CACHE=0`） | 1187.1 ms（1187.1, 1192.3, 1179.9） | 13.4 ms | 1631.2 ms | 2485.0 ms |
| 新建空缓存目录（首次冷写） | 1177.3 ms（1190.4, 1177.3, 1169.2） | 14.2 ms | 1612.9 ms | 2457.0 ms |
| 同缓存目录二次运行（热读） | **142.2 ms**（142.2, 135.6, 192.3） | **1.8 ms** | **595.2 ms** | **1460.3 ms** |
| **二次相对冷写降幅** | **−87.9%（8.3×）** | **−87.3%** | **−63.1%** | **−40.6%（省 ~1.0 s）** |

#### 4) 阶段 2 T0 逐字节核对（`main` `4e95369a` 冷启动语义 vs 常驻热出片）

- **MP4**：《晨渡》（0:4、96:100）、《度》（0:4、72:76）× 1080p / 4K × Pro / Fast 共 **16/16 组**，sha256 **逐字节完全相同**。
- **无损 PNG**：《晨渡》（帧 0、3、96、99）、《度》（帧 0、3、72、75）× 1080p / 4K 共 **16/16 张**，sha256 **逐字节完全相同**。
- **作品模块零分叉（D12）**：未改动任何作品模块契约（`build(ctx) → { render(f) }` 在 Chrome WebGPU 与 Node + Dawn 零分叉）。

