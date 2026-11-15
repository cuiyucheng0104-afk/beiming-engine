# 纯开源宽松协议原生渲染方案调研与对照

> 读者：负责北冥原生 · BNE 长期演进与技术选型的维护者｜状态：架构调研储备｜许可约束：见 [docs/rights/fsl-boundary.md](../rights/fsl-boundary.md)

当前北冥原生 · BNE 基于上游原生运行时 RAEA 构建，受其源可用许可约束（决定 D03：只作内部自制影片与向客户交付成片使用，不对外分发运行时或提供托管渲染服务，详见 [docs/rights/fsl-boundary.md](../rights/fsl-boundary.md)）。本文梳理社区中采用宽松开源许可（MIT / Apache-2.0）的同类程序化视频与原生 GPU 渲染项目，评估其在「完全无源可用边界限制」场景下的可借鉴点与演进路径。

## 1. 候选开源项目概览

| 上游项目 | 开源许可 | 核心技术栈 | 解决的核心问题 | 与北冥架构的契合点 |
|---|---|---|---|---|
| [Leonxlnx/shanshui](https://github.com/Leonxlnx/shanshui) | MIT | TypeScript + WebGL Shader + FFmpeg | 代码优先的声明式动效合成、GPU 着色器直转 YUV420 喂 FFmpeg、帧内多子帧运动模糊 | 其「免 PNG 编解码直出 YUV420」与「线性光时间超采样」思路已在 A/C 共用渲染器（`engine/render/lib/yuv.mjs`）自研落地 |
| [0xS4N4TG/kinetograph](https://github.com/0xS4N4TG/kinetograph) | Apache-2.0 | Rust + Skia + FFmpeg | 编译型领域语言描述节奏与弹簧/缓动约束，原生进程直出 MP4，彻底脱离浏览器 | 适合高密度 2D 矢量图形、字幕题跋与节拍驱动层的高吞吐无浏览器渲染 |
| [heygen-com/hyperframes](https://github.com/heygen-com/hyperframes) | Apache-2.0 | Rust / Node 确定性捕获引擎 + HTML/WebGL | 面向 AI Agent 编排的确定性逐帧时间虚拟化与多通道并行合成 | 时间轴虚拟化、确定性帧调度及子合成组织方式可与 `engine/render/` 互相对照 |
| [linebender/vello](https://github.com/linebender/vello) + [gfx-rs/wgpu](https://github.com/gfx-rs/wgpu) | Apache-2.0 / MIT | Rust + Compute-Shader 2D 光栅 + 跨平台 WebGPU（Metal / Vulkan / DX12） | 纯 GPU 计算着色器驱动的高分辨率矢量描边、混合与离屏帧缓冲读回 | 若未来自研纯 MIT/Apache-2.0 原生后端，这是同时覆盖 3D（`wgpu`）与 2D 水墨笔触（`vello`）最干净的底层底座 |

## 2. 三条演进层级对比

| 维度 | 现行方案（A/C 路线 `engine/render` + BNE 基于上游 RAEA） | 近期增强（已落地：`engine/render` GPU 直出 YUV420 + 热守护） | 远期纯宽松许可原生后端（`wgpu` + `vello` + `libavcodec`） |
|---|---|---|---|
| **开源与商用边界** | A/C 路线全栈 MIT；BNE 遵守 D03 内部制作边界 | 100% MIT 自研，可任意对外开源或做成云端渲染服务 | 100% MIT / Apache-2.0，无任何源可用条款约束 |
| **Three.js / Canvas 2D 资产复用** | A/C 直接运行，BNE 经 GLB 桥接（[例片说明](../../examples/raea/README.md)） | 零改动直接加速现有全部 A/C 作品与样片 | 需将 `engine/look` 的 GLSL 迁至 WGSL（与 BNE 的着色器迁移工作同构） |
| **单帧出片吞吐** | PNG 截图受限于无损压缩与进程间拷贝 | `--capture yuv420` 省去 PNG 编解码与 CPU 色彩矩阵；`daemon.mjs` 省去浏览器冷启动 | 无 Chromium 进程开销，GPU 纹理映射经环形缓冲直喂硬件/软件编码器 |
| **手绘风格化能力** | ID 图墨线、各向异性 Kuwahara、湿叠水彩与自动书法骨架齐备 | 完整保留全部 A/C 手绘工艺并新增线性光运动模糊 | 需在原生渲染图中重现多目标 G-Buffer（颜色 + 深度 + 物体 ID）与后期链 |

## 3. 工程结论与分步建议

1. **日常制作与对外技术输出优先走已增强的 MIT 管线**：通过 `engine/render/video.mjs --capture yuv420 --samples 4` 与 `engine/render/daemon.mjs`，A/C 路线已经具备零中间图片落盘、BT.709 硬件色彩直出、物理快门运动模糊与毫秒级热预览能力，且代码 100% 归属本仓库 MIT 许可。
2. **共享资产与场景描述保持后端中立**：遵循 [README.md](README.md) 的「共享创作输入」原则，`film.json` v2 镜头表、相机关键帧、色板以及 GLB 骨骼资产不绑定特定原生运行时。
3. **何时启动 `wgpu + vello` 自研原生层**：仅当业务明确需要对外分发独立原生渲染二进制或提供对外商业云渲染 API（触发 D03 中上游许可的外部服务红线）时，再以 `wgpu`（承接 3D 场景与 `engine/look` 的 WGSL 后期链）+ `vello`（承接 `engine/paint` 与 `engine/overlay` 的 2D 矢量水墨题跋）构建纯宽松协议原生执行器。
