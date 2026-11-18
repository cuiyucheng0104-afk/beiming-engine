# 离屏出片 M6 实施计划：GPU 侧 YUV420p 读回加速、单卡异构并发调度、免浏览器 QA 与研发工具全闭环

> 前置：M5 已完成（分支 `zz8011/offscreen-m5`）。本计划在 `zz8011/offscreen-m6` 上推进并已完成。
> 目标：把离屏链路推进到「高并发高速出片 + 纯 `backend: "webgpu"` 作品全流程不依赖无头浏览器」的完整工程态。

## 任务拆分

### T1 GPU 侧 RGBA→BT.709 TV YUV420p 转换与读回加速（`engine/offscreen/yuv.mjs`、`host.mjs`、`frames.mjs`、`encode.mjs`、`cli.mjs`）
> **已完成**（2026-11-18）：新增 `yuv.mjs` 16 位定点 WGSL 计算管线与 `MAP_READ` 读回缓冲池（任意中性灰严格 `Cb = Cr = 128`，CPU 与 GPU 逐字节相同；对 FFmpeg `COLOR.png` 亮度 `Y` 最大差 ≤ 1、PSNR 69.3 dB，整体 PSNR 54.0–55.0 dB），读回与管道字节降 62.5%（4 → 1.5 B/px）并免除 CPU `swscale`。1080p NVENC 单路 **71.0 → 114.7 fps（+61.5%）**、4 路并发 **84.0 → 136.3 fps（+62.3%）**；4K NVENC 单路 **27.7 → 35.1 fps（+26.7%）**、2 路并发 **34.3 → 42.1 fps（+22.7%）**。

### T2 生产级单卡异构多作业并发调度器（`engine/offscreen/batch.mjs`、`engine/offscreen/cli.mjs`）
> **已完成**（2026-11-18）：新增 `parseBatchJobs` / `runBatch` 与 `offscreen batch <清单.json | 作品.mjs…>`；同时修复 `host.mjs` 并发 `createHost` 时 `renderer.init()` 争用全局帧时钟 `self` 的竞态。异构多作业（`chendu` + `peng-glint` + `ink`）同卡并发逐帧哈希与单跑逐位一致，内置编码器信号量限流与单作业异常隔离、半成品自动清理。

### T3 `engine/overlay` 全库解锁与免浏览器机器 QA（`texts` + `plates` + 纯离屏 `probe`）
> **已完成**（2026-11-18）：`canvas.mjs` 统一安装画布 `document` 垫片、字体登记表与零开销画字探针，`engine/overlay/{brush,kinetic,text}.js` 与 `engine/paint/xuan.js` 在 A/C 离屏作品中直接可用；新增 `tools/qa/lib/offscreen.mjs`，使 `qa texts`、`qa plates` 与 `film build` 在纯 `backend: "webgpu"` 或 `--renderer offscreen` 下免启动浏览器完成全部文字（越界、安全区、时长、禁则、字形 cmap、WCAG 对比度）与底板（直线露边、贴图密度，对《晨渡》检出 `sky_dawn 1.319` 与浏览器版逐位一致）核查；`offscreen probe --events-out` 支持纯离屏作品导出 `events.json` / `timeline.json`。

### T4 研发与质控工具链支持离屏（`determinism`、`lookdev:sweep`、`env:doctor`）
> **已完成**（2026-11-18）：`determinism.mjs` 新增 `--renderer offscreen`（纯 `webgpu` 自动选用），跑新宿主单帧、乱序、顺序流水线（`inflight=3`）、同卡双宿主并发四路比对（并抓出修掉工作区《化鹏闪羽》先 `setPose` 后设组旋转导致的 34 像素瞳孔朝向跨帧泄漏，修复后《晨渡》14 帧、《化鹏闪羽》11 帧四路全过）；`lookdev:sweep` 支持 `--renderer offscreen` 与 `globalThis.__LOOKDEV` 免浏览器高速扫参；`env:doctor` 新增 `offscreen.deps` 与 `offscreen.gpu` 体检项。
