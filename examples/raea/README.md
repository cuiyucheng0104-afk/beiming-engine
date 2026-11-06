# 北冥 × RAEA：可运行的 10 秒资产桥示例

这是已在 RTX 5090 上完成原生渲染的实验源码，整理为仓库内独立示例。默认北冥构建继续使用 Three.js；本示例不安装、打包或替换 RAEA 运行时。

## 文件与调用关系

```text
原版 src/kun.js、src/ferry.js
  → tools/export-kun.mjs / export-kun-browser.mjs
  → GLB + 结构检查 + 动画回读
原版 assets/plates → media/ 绘画底板
tools/sound.py → sound.wav → 两遍 loudnorm → mix.wav
film.tsx + media/ → 外部 RAEA → 原生视频
tools/render.mjs → FFmpeg 复制视频轨并封装 AAC → delivery/
```

| 文件 | 作用 |
|---|---|
| [film.tsx](film.tsx) | 三个镜头、分层背景、Toon 材质、水面/尾迹 WESL、片名 |
| [film.board](film.board) | 时间、画面、摄影和声音安排 |
| [tools/prepare.mjs](tools/prepare.mjs) | 整理底板、生成 GLB、声音和输入哈希 |
| [tools/export-kun-browser.mjs](tools/export-kun-browser.mjs) | 程序形变到骨骼/morph、反照率烘焙和回读 |
| [tools/export-kun-validate.mjs](tools/export-kun-validate.mjs) | GLB 二进制与动作结构检查 |
| [tools/render.mjs](tools/render.mjs) | 版本预检、共享 GPU 检查、原生渲染、封装与输出检查 |

## 1. 环境

在仓库根目录安装原项目依赖：

```sh
npm run setup
python3 -m pip install -r requirements.txt
```

另需 FFmpeg / ffprobe 和 **RAEA v0.1.0-canary.2**。从 [上游发行页](https://github.com/shinyobjectz/raea/releases/tag/v0.1.0-canary.2) 获取对应平台包，完整保留 `bin` 与 `share` 目录。先阅读其 [许可](https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/LICENSE)。`raea/*` 导入由该运行时解析，不通过 npm 安装同名包。

Windows 的 Python 命令通常为 `python`；已建虚拟环境时，将 `PYTHON` 指向解释器即可。Node.js 需要 20+。

## 2. 准备资产

```sh
npm run raea:prepare
```

生成内容在 `examples/raea/media/`，不提交 Git：6 张现有底板、鲲与渡船 GLB、音频及检查记录。导出默认使用 Chromium 的软件图形路径进行反照率烘焙，目的是资产转换；最终影片由外部原生运行时渲染。

可配置 `PYTHON`、`FFMPEG`、`BEIMING_CHROME`。导出工具单独运行时可用 `BEIMING_SOURCE` 指向另一个北冥检出目录；通常无需设置。

## 3. 原生渲染

macOS / Linux shell（本实验已验证 macOS，未验证 Linux）：

```sh
export RAEA_BIN="/absolute/path/to/raea/bin/raea"
npm run raea:check
npm run raea:render
```

Windows PowerShell 示例路径：

```powershell
$env:RAEA_BIN = 'D:\北冥\tools\raea-canary2\raea\bin\raea.exe'
$env:WGPU_BACKEND = 'vulkan'
# 如工具不在 PATH，将 FFMPEG、FFPROBE、PYTHON 分别设为完整可执行文件路径。
npm run raea:check
npm run raea:render
```

`raea:check` 仅检查版本、命令与素材；它不启动 GPU 渲染。渲染前会查询 ComfyUI 队列和可用的 `nvidia-smi` 利用率：已有任务时退出，不停止其他进程。运行中开始的新任务仍可能影响速度，因此结果不自动作为性能基准。

输出：

- `examples/raea/delivery/beiming-raea-10s.mp4`
- `examples/raea/delivery/technical.json`
- `examples/raea/out/render.json` 与标准输出/错误日志

尺寸 1920×1040、24fps、240 帧；脚本验证完整解码帧数和 AAC 音轨。还需查看整片、检查黑场/静帧与响度。原实验完整验证见 [实测记录](../../docs/raea/experiment.md)。

## 4. 如何修改

- 改摄影：`Piece` 中按 3.5 秒 / 6 秒划分的 `eye / at / fov` 曲线。
- 改角色动作：`Model animation="Swim" time=...`；`q` 控制一拍三。若需新的动作，重新导出 clip，而非只调模型整体位置。
- 改灯光/色阶：`AmbientLight`、`DirectionalLight` 与分材质 `ToonMaterial`。
- 改水面/尾迹：`WATER`、`WAKE` WESL 字符串；纹理路径为项目相对路径。
- 改屏幕后期：`PAPER` / `FramePass`；当前只是轻颗粒与暗角，没有实现原版 Kuwahara。
- 改时长或分辨率：同时修改 Composition、时间曲线、音频生成和渲染脚本中的输出契约。当前示例专为 10 秒编排，并非任意时长模板。

## 5. 已知限制与许可

本例没有真人物表演；鲲的视线/高光已烘焙，仅眼睑有动画；城市/云为 2.5D。它证明资产与运行路径可迁移，不证明原版笔触已完整复现。

本目录原创代码遵循仓库 MIT。片名中嵌入的马善政字体数据遵循 [fonts/LICENSE.md](../../fonts/LICENSE.md) 中的 OFL；影片、底板和艺术资产沿用仓库保留权利的范围。外部 RAEA 及其 SDK 由上游许可约束，不包含在本仓库 MIT 授权内。
