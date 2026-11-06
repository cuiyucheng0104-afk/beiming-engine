# 北冥 · 九分钟

完整故事由 15 场、84 个镜头构成，总长 540 秒、24 fps。画面以原版十秒样片为基准：手绘环境与人物、程序化三维鲲、相同的色阶、墨线与纸面后期。新增鹏、渡轮操作动作和水面效果；不采用后续实验的 E 组配色。

## 观看

- `delivery/index.html`：完整影片播放器，可按十五场跳转。
- `delivery/beiming_9min_4k.mp4`：3840 × 2080 原生渲染成片。
- `delivery/beiming_9min_1080.mp4`：1920 × 1040 观看版。
- `delivery/qa/report.json`：实际交付视频的帧数、时长、解码、声音和校验记录。

## 工程

- Mac：`@@CASE_ROOT@@`
- RTX5090：`D:\北冥\projects\beiming-9min`，`D:\beiming` 为同一目录的别名。
- `src/storyboard.js`：完整时间轴，逐镜动作与时长。
- `src/film.js`：影片入口和镜头调度。
- `src/world.js`：环境、相机、人物和角色的镜头编排。
- `src/actors.js` 及 `actor-*.js`：人物和船上操作动作。
- `src/peng.js`、`peng-feathers.js`：鹏与羽化过程。
- `src/locked-look.js`：复用原片 A/B/C 三组后期参数。
- `audio/`：35 句合成对白、环境声、音效、三段配乐和完整混音。
- `docs/`：剧本执行稿、分镜表、画风锁定和声音说明。

`docs/style-lock.json` 记录七个原片源文件的 SHA-256。原版鲲和人物基础画法、着色器与后期源文件保留；`?trailer` 可加载十秒参考片页面。工程默认加载完整九分钟时间轴。

## 在 5090 重建

```powershell
cd D:\beiming\projects\beiming-9min
powershell -NoProfile -ExecutionPolicy Bypass -File tools/full-film.ps1
```

脚本先检查 GPU 与 ComfyUI 队列，不停止其他任务。Chrome 使用 Vulkan；分十五场渲染并支持按源文件校验值恢复。截图前同步Canvas覆盖层，防止空白覆盖层保留上一镜界面。后续把完整混音和章节信息封装到 MP4，导出观看版并验证交付文件。封装优先使用 RTX NVENC，实际使用的编码器写入报告；不可用时才回退到软件编码。编码器不改变画面中的材质和艺术参数。

单场重建或抽帧：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/render.ps1 --scenes 13
powershell -NoProfile -ExecutionPolicy Bypass -File tools/render.ps1 probe 75 193 443 470 510 533
```

音频重建见 `audio/reproduce.ps1`。35 句声音使用通用合成音色，口型为十二帧的音量驱动动画。486–488 秒的定格与全轨静音为剧情设计。语音回信按原剧本保留为概念情节，产品功能与品牌应用尚未经过品牌审定。

本目录与原十秒工程隔离。未向公开仓库发布该完整剧集。
