# 纸上江山 · 北冥引擎 E 组

15 秒代码动画试作。一纸离案，化鹤入山河。

## 成片与工程

- Windows 工程：`D:\北冥\experiments\e-paper-15s`（`D:\beiming` 为同目录的连接）。
- 4K：`delivery/paper-rivers_E_4k.mp4`，3840×2080、24 fps。
- 预览：`delivery/paper-rivers_E_preview.mp4`，1920×1040。
- 观看页：`delivery/index.html`。
- 核查：`delivery/verification.json`、`verification.log`、`contact_sheet.jpg`、`fold_strip.jpg`。

## 5090 一键重建

在工作站 PowerShell 执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File D:\beiming\experiments\e-paper-15s\tools\render.ps1
```

只出关键帧：在命令末尾加 `probe`。只对当前进程使用 Bypass，不修改全局执行策略。依赖使用工作站既有工具；`node_modules` 连接到 `D:\beiming\tools\lemo-opuscar\node_modules`。实际运行引擎是本工程内的北冥 `engine/` 快照。

核心依赖为 three.js 0.170.0、playwright-core 1.63.0、FFmpeg、Python numpy/scipy/soundfile/Pillow。渲染器强制 RTX 5090 / Vulkan，探针会校验设备；不要与其他高负载 GPU 作业同时跑。

## 源码分工

| 文件 | 内容 |
|---|---|
| src/style.js | E 组原始色板、主体光色、全片后期参数和时间常数 |
| src/hero.js | 布面纸张卷曲、纸面绘画、16 面纸鹤顶点形变与振翼 |
| src/background.js | 三张绘画底板、二维取景、局部水波和烛光、雾刷转场 |
| src/atmosphere.js | 光尘、雾、远景鸟群 |
| src/main.js | 三段运动、全片构图及引擎接线 |
| engine/ | 北冥引擎快照：shade、look、stage、render 等 |
| audio/make.py | 原创合成弹拨、纸、风、水声及双遍响度归一 |
| tools/ | 工作站构建、GPU/重复帧验证、成片核查与联系表 |

## 与此前九景实验的区别

此处以二维画面为主体，保留 E3 底板的构图和灰绿暖纸色；三维只服务飞纸和纸鹤。不是九座完整三维场景的镜头游览，也没有生成式视频。

背景采用本轮 E3 实验的 01 书案、07 楼阁、08 山水图。背景图约 2400 像素宽；原生 4K 的新增精细度主要体现在代码主体、墨线、合成和粒子上，不代表背景重新获得 4K 细节。人物是保持的绘画，不是三维人物表演。

纸鹤变化是风格化顶点插值，不是经过可折叠性验证的物理折纸模拟。分面中间态有意表现纸的拆合。场景内既有飞纸属于底板图像；新增前景纸页才有独立运动。

引擎基线 `a65c172`。唯一的渲染器兼容改动是规范化 Windows 目录连接路径；画风覆盖集中在 src，不改原始北冥工程。

lemo-opuscar skill 的研究与对应关系见 [docs/lemo-skill与北冥.md](docs/lemo-skill与北冥.md)。本地 lemo 指南版本 `bebbbe1`，未更新共享库。
