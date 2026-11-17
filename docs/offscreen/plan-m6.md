# 离屏出片 M6 实施计划：GPU 侧 YUV420p 读回加速、单卡异构并发调度、免浏览器 QA 与研发工具全闭环

> 前置：M5 已完成（分支 `zz8011/offscreen-m5`，纸纹进阶与 8 种后期调试视图、`offscreen stills/probe` 与 `film` 命令闭环、C 路线宿主 `c2d.mjs` 及《化鹏闪羽》整片验证均已通过）。本计划在 `zz8011/offscreen-m6` 上推进。
> 目标：围绕「高并发高速出片」与「纯 `backend: "webgpu"` 作品不依赖无头浏览器的一等公民闭环」推进四项核心工程：
> 1. 把 `docs/offscreen/README.md` §3 预留的 **GPU 侧 RGBA→BT.709 TV YUV420p 转换与打包** 落地，将读回与管道带宽从 4 B/px 降到 1.5 B/px（减少 62.5%），省去 FFmpeg 的 CPU `swscale` 色彩换算；
> 2. 落地生产级 **单卡多作业异构并发调度器**（`engine/offscreen/batch.mjs` + `offscreen batch`），共用单 `GPUDevice`、控制编码会话上限、隔离单任务故障并保持像素哈希确定性；
> 3. 统一离屏 2D 画布垫片以解锁 `engine/overlay`（毛笔笔顺、墨迹场动态字）与 `engine/paint` 全库，并打通 **免浏览器的机器 QA（`texts` + `plates`）与纯离屏事件表导出**；
> 4. 补齐 **`determinism`**、**`lookdev:sweep`** 与 **`env:doctor`** 对离屏链路的完整支持。

## 任务拆分

### T1 GPU 侧 RGBA→BT.709 TV YUV420p 转换与读回加速（`engine/offscreen/yuv.mjs`、`host.mjs`、`frames.mjs`、`encode.mjs`、`cli.mjs`）
- [ ] 新增 `engine/offscreen/yuv.mjs`：在同一 `GPUDevice` 上用 WGSL 计算着色器将渲染目标的 sRGB RGBA8 纹素转换为有限范围 BT.709 `yuv420p` 平面字节流（`Y` 16..235，`Cb/Cr` 16..240，2×2 色度下采样），支持 `inflight` 读回缓冲池复用。
- [ ] `host.mjs` / `frames.mjs` 支持 `renderFrameYuv(work, f)` 与 `format: 'rgba' | 'yuv420p'` 流水线读回；`encode.mjs` 支持 `pixFmt: 'rgba' | 'yuv420p'`（`yuv420p` 直通 `-f rawvideo -pix_fmt yuv420p` 并打齐 BT.709 限范围四项色彩标记，免除 CPU `-vf`）。
- [ ] `engine/offscreen/cli.mjs` 与 `tools/offscreen/bench.mjs` 支持 `--pix-fmt rgba|yuv420p`；实测对 `rgba` 路径的 PSNR、QA `delivery` 合规性与 1080p/4K 单路及多路并发吞吐。

### T2 生产级单卡异构多作业并发调度器（`engine/offscreen/batch.mjs`、`engine/offscreen/cli.mjs`）
- [ ] 新增 `engine/offscreen/batch.mjs`：`runBatch(jobs, opts)` 共用单 `GPUDevice`，按并发槽位调度不同作品、不同画幅/帧率/查询串的 `render` 与 `stills` 作业，内置编码器并发信号量（防止多路 `nvenc` 超消费卡会话上限）与单作业异常隔离、半成品清理。
- [ ] `cli.mjs` 新增子命令 `offscreen batch <清单.json | 作品.mjs…>`；测试验证异构并发逐帧哈希与单跑逐位一致、坏作业不影响同批其余作业。

### T3 `engine/overlay` 全库解锁与免浏览器机器 QA（`texts` + `plates` + 纯离屏 `probe`）
- [ ] `engine/offscreen/canvas.mjs` 提供统一的 `installCanvasDocument`，在 `film.mjs` 与 `c2d.mjs` 中自动就绪，使 `engine/overlay/{brush,kinetic,text}.js` 与 `engine/paint/{xuan,wash}.js` 在 A/C 离屏作品中直接可用。
- [ ] `engine/offscreen/cli.mjs probe` 与 `engine/render/build.mjs` 支持导出离屏模块的 `EV` / `TIMELINE` 至运行目录 `events.json` / `timeline.json`，打通纯离屏作品的 `cuecheck` 与 `qa sync`。
- [ ] 新增 `tools/qa/lib/offscreen.mjs` 并接入 `tools/qa/cli.mjs`、`checks/texts.mjs`、`checks/plates.mjs` 与 `tools/film/lib/{deliver,qa}.mjs`：纯 `backend: "webgpu"` 作品及 `--renderer offscreen` 构建直接在 Dawn 宿主里完成文字（越界、安全区、时长、禁则、字形 cmap、开/关文字对比度）与底板（直线露边、贴图密度）检查，零浏览器进程。

### T4 研发与质控工具链支持离屏（`determinism`、`lookdev:sweep`、`env:doctor`）
- [ ] `tools/baseline/determinism.mjs` 支持 `--renderer offscreen`（纯 `webgpu` 作品自动选用），核对新建宿主单帧、乱序、顺序流水线（`inflight=3`）与同卡并发四路像素哈希一致。
- [ ] `tools/lookdev/sweep.mjs` 支持 `--renderer offscreen`（纯 `webgpu` 作品自动选用），在 Dawn 中直接扫 `--look` 与 `--q` 参数网格并生成离线对照页。
- [ ] `tools/env/doctor.mjs` 与 `tools/env/lib/checks.mjs` 新增离屏可选依赖、Dawn 适配器与 `h264_nvenc` 体检项。

### T5 全链路实测、评测回归与文档收口
- [ ] 跑齐受影响测试域、`check-all`、`comp:scan`、评测题库自检，并将实测吞吐与 PSNR 数据回填 `docs/offscreen/README.md` 与 `CHANGELOG.md`。
