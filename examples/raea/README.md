# 《北冥》10 秒原生例片（北冥原生 · BNE）

已在 RTX 5090 与 macOS 上完成原生渲染的实验片，现在是 `engine/native` 组件库的完整用法示范：`film.tsx` 只写这 10 秒的编排，镜头、面片视差、卡通材质、片名、后期、水面 / 尾迹着色器、确定性数学都来自 `engine/native/`；准备与出片用通用入口。路线手册见 [routes/b-native/README.md](../../routes/b-native/README.md)。

## 文件与调用关系

```text
film.json（素材清单）
  → engine/native/prepare.mjs
      images     assets/plates 的 6 张底板 + 字体许可 → media/
      models     鲲：配方 tools/export-kun-browser.mjs（GPU 弯曲 → 骨骼 / morph，反照率烘焙）
                 渡船：通用「模块 + 导出名」src/ferry.js:createFerry
                 → engine/native/bridge/export.mjs → GLB + 结构检查 + 回读报告
      audio      tools/sound.py（engine/audio）→ media/mix.wav
film.tsx + media/ → engine/render/native.mjs → 原生运行时 → out/native.mp4 → engine/render/mux.sh → delivery/
```

| 文件 | 作用 |
|---|---|
| [film.tsx](film.tsx) | 编排：三个镜头、站位与运动、材质分组、片名时间 |
| [film.json](film.json) | 片长 / 帧率 / 尺寸与 native 素材清单（唯一配置源） |
| [palette.json](palette.json) | 色板 |
| [title-font.ts](title-font.ts) | 片名字体（「北冥」两字子集，内嵌 data URL，OFL） |
| [film.board](film.board) | 时间、画面、摄影和声音安排 |
| [tools/export-kun-browser.mjs](tools/export-kun-browser.mjs) | 鲲的资产桥配方 |
| [tools/sound.py](tools/sound.py) | 片中声音事件（环境声、摆位、母带用 engine/audio） |
| [tools/prepare.mjs](tools/prepare.mjs) / [tools/render.mjs](tools/render.mjs) / [tools/export-kun.mjs](tools/export-kun.mjs) / [tools/export-kun-validate.mjs](tools/export-kun-validate.mjs) | 原命令的薄入口，分别转到 engine/native 与 engine/render 的通用实现 |

## 1. 环境

```sh
npm run setup
python3 -m pip install -r requirements.txt     # 或把 PYTHON 指向已有 numpy / scipy / soundfile / numba 的解释器
```

另需 FFmpeg / ffprobe、`sh`（封装脚本；Windows 用 Git Bash）和原生运行时 **v0.1.0-canary.2**：从 [上游发行页](https://github.com/shinyobjectz/raea/releases/tag/v0.1.0-canary.2) 获取对应平台包，完整保留 `bin` 与 `share` 目录，先读其 [许可](https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/LICENSE)。TSX 里的 `raea/*` 导入由运行时解析，不通过 npm 安装。Node.js 需要 20+。

## 2. 准备素材

```sh
npm run raea:prepare        # = node engine/native/prepare.mjs examples/raea；加 -- --preview 另存 kun-preview.png
```

产物在 `examples/raea/media/`（不提交）：底板、`kun.glb` / `ferry.glb` 与 `kun-report.json` / `ferry-report.json`、`mix.wav`、`prepared.json`（全部 SHA256）。资产桥用 Chromium 的软件 GL 做转换与烘焙，不占独显。细节见 [ASSET-BRIDGE.md](ASSET-BRIDGE.md)。

## 3. 原生渲染

```sh
export RAEA_BIN="/absolute/path/to/raea/bin/raea"
npm run raea:check          # 版本、工具、素材预检，不启动 GPU
npm run raea:render         # = node engine/render/native.mjs examples/raea
```

Windows PowerShell：`$env:RAEA_BIN = 'D:\北冥\tools\raea-canary2\raea\bin\raea.exe'`；`WGPU_BACKEND` 默认设为 `vulkan`；工具不在 PATH 时设 `FFMPEG`、`FFPROBE`、`PYTHON`。新入口尚未在 Windows / 5090 上重跑。

渲染前查询 ComfyUI 队列和 `nvidia-smi` 利用率，有任务就退出，不停止其他进程。输出：

- `examples/raea/delivery/beiming-raea-10s.mp4`（默认经 `engine/render/mux.sh`：x264 重编码 + −14 LUFS；`npm run raea:render -- --mux copy` 则逐位保留原生画面）
- `examples/raea/delivery/technical.json`（帧数 / 尺寸 / 帧率 / AAC / 时长核对结果）
- `examples/raea/out/native.mp4`、`out/render.json` 与标准输出 / 错误日志
- `npm run raea:render -- --at 0,84,200` 只渲三帧 PNG 到 `out/stills/`

## 4. 如何修改

- 改摄影：`film.tsx` 的 `SHOTS`（每段 `until / eye / at / fov`，可加 `ease`）。
- 改角色动作：`ToonModel animation="Swim" time=…`；`heldTime(f, 3, FPS)` 是一拍三。要新动作就改配方重导 clip，不要只挪模型整体。
- 改材质：`KUN_PARTS` 按材质名分组覆盖；带贴图 / 顶点色的部位不要写 `base_color`。
- 改水面 / 尾迹：`waterWesl` / `ribbonWesl` 的参数；纹理路径写 `media/river.png`。
- 改颜色：`palette.json`。改后期：`paperPass`（当前只是轻颗粒与暗角，没有 A 路的 Kuwahara）。
- 改时长或分辨率：改 `film.json` 的 `dur / size`，同时调整 `SHOTS` 与声音事件时间；渲染入口按 film.json 自动核对。

## 5. 已知限制与许可

没有真人物表演；鲲的视线 / 高光已烘焙，只有眼睑有动画；城市 / 云是 2.5D 绘画面片（原稿里一段未接入画面的程序化城市已在重构时删除）。它证明资产与运行路径可迁移，不证明 A 路笔触已完整复现。

本目录原创代码遵循仓库 MIT。片名嵌入的马善政字体数据遵循 [fonts/LICENSE.md](../../fonts/LICENSE.md) 中的 OFL；影片、底板和艺术资产沿用仓库保留权利的范围。外部原生运行时及其 SDK 由上游许可约束，不包含在本仓库 MIT 授权内。
