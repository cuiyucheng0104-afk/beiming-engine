# 在 NVIDIA RTX 工作站上渲染

> 读者｜在 Windows RTX 工作站上出片的人与 agent，以及从控制机（通常是 Mac）向工作站派活的人　状态｜操作手册；性能数字是 2026-11-04 在 RTX 5090 + Vulkan 上的实测　依据｜[决定 D09、D10](decisions/2026-11-10-industrial-baseline.md)；版本要求的唯一来源是 [`tools/env/spec.json`](../tools/env/spec.json)，安装细节见 [运行环境](ENVIRONMENT.md)

工作站和其它机器装同一套锁定的环境（`npm run setup`）。渲染前先用 `doctor --gpu required` 确认 WebGL 跑在独显上；从控制机派活用 [`tools/remote`](../tools/remote/README.md)，它按指定提交出片，取回成片后逐个核对哈希。

## 1. 装环境

在 PowerShell 里执行（winget 装完要重开窗口，PATH 才会生效）：

```powershell
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Gyan.FFmpeg -e
winget install --id astral-sh.uv -e
winget install --id Git.Git -e
# 重开 PowerShell 后：
git config --global core.quotepath off
git clone <仓库地址> D:\beiming\repo
cd D:\beiming\repo
npm ci
npm run setup
```

- 仓库放在短的 ASCII 路径下，例如 `D:\beiming\repo`。中文路径下，部分老工具会出编码问题，例如运行时的字体加载失败；过长的路径会撞上 Windows 的路径长度限制。运行时、缓存、输出目录也一样放在 ASCII 路径下。
- `core.quotepath off` 让 `git status` 直接显示中文文件名（例如本页），而不是 `"docs/RTX\345…"` 这样的转义。
- 换行不用另外设置：仓库的 `.gitattributes` 让文本一律按 LF 检出，`core.autocrlf` 设成什么都不影响。
- `npm run setup` 会装锁定版本的无头浏览器（chromium-headless-shell 153，不是系统 Chrome），并在仓库里建 Python 3.12 的 `.venv`。不需要系统里有 Python：uv 会自己取 3.12。
- PowerShell 拦截 `npm` 时（报「此系统上禁止运行脚本」），把命令里的 `npm` 换成 `npm.cmd`。

| 组件 | 要求 | 说明 |
|---|---|---|
| Node.js | 22 以上，推荐 24 | `.nvmrc` |
| 无头浏览器 | chromium-headless-shell r1243（153.0.8010.12） | setup 安装。下面的性能数字是用系统 Chrome 156 测的，换回锁定浏览器后要按第 3 节重测 |
| FFmpeg | 7 以上，完整构建（带 libx264） | Gyan 的 full 版满足；Playwright 顺带下载的精简版 ffmpeg 不能用 |
| Python | 3.12 | setup 建 `.venv`；所有 Python 命令经 `node tools/env/py.mjs` 启动 |
| 显卡驱动 | 支持 Vulkan 的当前稳定版 | 换驱动后重做第 2 节 |
| sh（过渡期） | Git for Windows 的 `Git\bin` 在 PATH 里 | 出片封装还要调用 `engine/render/mux.sh`，见[运行环境 · sh 入口盘点](ENVIRONMENT.md#sh-入口盘点) |

## 2. 让 WebGL 用上独显

北冥引擎在无头浏览器里用 WebGL 逐帧渲染。在同时装有核显和独显的机器上，浏览器默认的 ANGLE 后端（Windows 上是 D3D11）会选中核显：three.js 连 WebGL 上下文都建不起来，页面直接报错。把 ANGLE 切到 Vulkan，浏览器才会用上 RTX 独显。引擎读 `BEIMING_ANGLE`，给浏览器传 `--use-angle=vulkan`：

```powershell
$env:BEIMING_ANGLE = 'vulkan'                              # 只对当前窗口有效
npm run env:doctor -- --route a --gpu required             # gpu.renderer 一行应显示 NVIDIA 显卡
node tools/rtx/gpucheck.mjs                                # 逐个后端对比，标 ★ 的是渲染器会用的那个
[Environment]::SetEnvironmentVariable('BEIMING_ANGLE', 'vulkan', 'User')   # 长期生效（新开的窗口才读到）
```

```bash
# Git Bash 里：
export BEIMING_ANGLE=vulkan
npm run env:doctor -- --route a --gpu required
node tools/rtx/gpucheck.mjs
```

- `--gpu required` 时，软件渲染（SwiftShader、WARP 即「Microsoft Basic Render Driver」），以及「有 NVIDIA 显卡却落到核显」，都判失败、退出码 3。交付渲染前一定要过这一步。
- doctor 用的浏览器与启动参数和渲染器完全相同（直接取 `engine/render/page.mjs` 导出的参数），所以它看到的 GPU 就是渲染时用的 GPU。
- `BEIMING_CHROME` 可以换成系统 Chrome，但系统 Chrome 会自动升级，跨机器的像素一致性与金标准比对都不再成立。只在排查问题时用。

## 3. 渲染

新作品用统一出片命令 `npm run film -- build films/<名>`，用法见各路线手册（[routes/README.md](../routes/README.md)）。下面是直接调用渲染器的写法，例如出《北冥》样片的原生 4K：

```powershell
$env:BEIMING_ANGLE = 'vulkan'
node engine/render/video.mjs . --size 3840x2080 --workers 8 --out out/film_4k.mp4
```

```bash
BEIMING_ANGLE=vulkan node engine/render/video.mjs . --size 3840x2080 --workers 8 --out out/film_4k.mp4
```

- `.` 是作品目录（这里是仓库根的《北冥》样片）。
- `--size` 是实际输出像素。镜头按 1040 高的设计尺寸摆位，任意分辨率下构图一致。
- `--workers` 是并行的浏览器进程数。实测 6 个与 10 个只差约 2 秒，设 6 到 10 即可。
- 输出目录放在空间充裕的盘上：4K 逐帧渲染与分段编码要占不少临时空间（doctor 的 `disk.free` 一项低于 10 GiB 会告警）。

2026-11-04 的实测（系统 Chrome 156 + Vulkan）：

| 项 | RTX 5090（Vulkan） | Mac M5 Pro（Metal） |
|---|---|---|
| 重着色器帧时（每像素 400 次噪声循环，1920×1040） | **0.52 ms** | 5.17 ms |
| 《北冥》原生 4K 整片（10 秒，240 帧，3840×2080） | 约 **31 秒** | — |

跑 4K 时（6 个 worker）：GPU 平均占用 46%，显存最高约 18.8 GB，功耗平均 108 W。引擎的 3D 样例在 RTX 5090 + Vulkan 下渲出的画面与 Mac 上一致；只有显示层文字边缘因字体光栅化不同而有肉眼不可见的差别。换成锁定的无头浏览器之后，这两组数字要重测，并把浏览器版本一起记下（`gpu.renderer` 一项的 `data.browser`）。

## 4. 渲染器与环境变量

同一台机器上有四套渲染器，各认各的变量。设好 `BEIMING_ANGLE` 去复刻 C 路线的历史作品，是不起作用的：

| 渲染器 | 用在哪里 | GPU 后端 | 浏览器 | 并发 |
|---|---|---|---|---|
| `engine/render`（本仓库） | A、C 新作品，《北冥》样片 | `BEIMING_ANGLE` | `BEIMING_CHROME` | `--workers`、`WORKERS` |
| 风格库甲的渲染核心 | C 路线 66 部历史作品的 `build.sh` | `LEMO_ANGLE` | `PLAYWRIGHT_CHROME` | `RENDER_SLOTS` |
| 风格库乙的 `render.js` | C 路线 20 种方法模板 | `--hwgpu` 或 `HWGPU=1`（不设就是软件渲染） | 该库默认 | — |
| 原生运行时 | B 路线 | `WGPU_BACKEND`（Windows 上 native.mjs 默认 vulkan） | 不用浏览器 | 运行时自己管理 |

在工作站上复刻历史作品时，几套变量一起设：

```powershell
$env:BEIMING_ANGLE = 'vulkan'; $env:LEMO_ANGLE = 'vulkan'; $env:HWGPU = '1'
```

```bash
export BEIMING_ANGLE=vulkan LEMO_ANGLE=vulkan HWGPU=1
```

全部变量的作用与默认值见[运行环境 · 环境变量](ENVIRONMENT.md#环境变量)。

## 5. 共用工作站

这台机器同时跑别的 GPU 任务（例如 ComfyUI）。开工前先看占用，计时只在空闲时做：

```powershell
nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv
```

- B 路线的 `native.mjs` 开工前会查 ComfyUI 的队列（地址来自 `COMFY_URL`）和 `nvidia-smi`：队列里有任务、或显卡占用超过 10% 就直接退出，从不结束别人的进程。
- 远程任务由 `tools/remote` 的整机槽位锁串行（机器档案的 `slots`，默认 1）：槽位被占时直接退出 5，加 `--wait <秒>` 排队。
- 不改别人的路径、环境与安装包；Python 依赖装在仓库的 `.venv` 里（远程任务按锁文件哈希共享），不往系统 Python 里装东西。

## 6. 从控制机派活

控制机（通常是 Mac）上的 agent 不用登录工作站，一条命令让它按指定提交出片：

```bash
node tools/remote/cli.mjs check rtx                                 # 连得上吗、远端 Node / git / 显卡
node tools/remote/cli.mjs doctor rtx --route a --gpu required       # 在该提交上建环境并体检
node tools/remote/cli.mjs render rtx films/<名> --commit <提交>     # 出片，取回成片与运行记录
```

`rtx` 是机器档案里的名字。档案放在仓库外（`~/.config/beiming/machines.json`，或 `BEIMING_MACHINES` 指定的文件），主机名、账号、盘符都不进仓库；格式与工作站这边的一次性准备（OpenSSH 服务、密钥登录）见 [`tools/remote/README.md`](../tools/remote/README.md)。

每次运行做这些事：用 git bundle 只发工作站缺的提交 → 在工作站的缓存仓库里按提交建一个独立工作树 → 拿整机槽位锁 → 按该提交的锁文件建环境 → 运行命令（日志实时转回控制机）→ 取回产物，逐个核对 sha256 → 删除工作树。运行记录（机器指纹、提交、命令、耗时、每个文件的哈希）写到控制机的 `out/remote/<机器>/<run-id>.json`。中途按 Ctrl+C 或断网，工作站上的任务会随之停止，并清理工作树、释放锁。

## 7. RTX Video Super Resolution

RTX Video Super Resolution 是 NVIDIA 的视频超分。实测它对手绘风镜头不合适：

- 大块平涂区会长出蚯蚓状纹理，像过度锐化的油画，纸感被破坏。
- 端到端约 3 分钟，其中模型只占每帧 0.017 秒，大头是逐帧 PNG 的读写。
- 画质不如直接渲染原生 4K。

所以北冥的手绘风镜头一律走**原生 4K**。超分适合拿不到原生分辨率、只有低分辨率成片的素材，例如 AI 生成的视频镜头；对这类素材，先把逐帧读写改为显存内直通，可以去掉大部分耗时。

## 8. 常见坑

| 现象 | 原因与处理 |
|---|---|
| 页面报错，建不起 WebGL 上下文 | ANGLE 落到了核显。`$env:BEIMING_ANGLE = 'vulkan'`，再跑 `npm run env:doctor -- --gpu required` |
| 渲染很慢，日志提示软件渲染 | 后端拼错或没设，落到了 SwiftShader / WARP。doctor 的 `gpu.angle` 一项会指出拼错的值 |
| `sh` 不是内部或外部命令 | 出片封装还要 sh：`$env:Path += ';C:\Program Files\Git\bin'`；不要加 `Git\usr\bin` |
| `python3` 打开应用商店或没反应 | 应用商店的空壳。Python 命令一律写 `node tools/env/py.mjs …` |
| `UnicodeEncodeError: 'gbk' codec …` | Python 输出被管道捕获时按 GBK 编码。经 `node tools/env/py.mjs` 运行就不会出现 |
| 与 Mac 的画面有细微差别 | 只在显示层文字边缘，由字体光栅化不同造成，肉眼不可见；金标准跨平台按容差比较 |
| 工作站上 1080p 不比 Mac 快 | 启动浏览器的固定开销占比高，差距在 4K 才拉开 |
| 加 worker 没变快 | 实测 6 个之后收益很小，不必一味加大 |
| 远程任务退出 5 | 工作站槽位被别的远程任务占着。等它结束，或加 `--wait <秒>` 排队 |
