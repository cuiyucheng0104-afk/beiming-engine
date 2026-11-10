# 路线共享验收与 RTX 5090 执行手册

> 读者：做验收、在共享 5090 上出片的人｜状态：验收手册（编写时只做只读检查，没有重跑 5090）｜依据：北冥 `21ed1b1`，RAEA 源码 `fb3f708`，运行包 `0.1.0-canary.2`
>
> **2026-11-10 起统一口径**：交付规格以 [D07 交付档位](../decisions/2026-11-10-industrial-baseline.md)为准（默认 `web-1080p24`，《北冥》样片 `beiming-1040p24`；数值见 `node tools/qa/cli.mjs profiles`）；技术验收（S5）由机器 QA 门判定：`node tools/qa/cli.mjs report <成片>`，硬门不通过 exit 4，说明见 [docs/quality/QA-GATE.md](../quality/QA-GATE.md)；评分口径见 [docs/quality/RUBRIC.md](../quality/RUBRIC.md)；已知问题见 [docs/quality/known-issues.json](../quality/known-issues.json)。本页其余部分保留为 5090 工作站的执行与取证手册；与 D07、QA 门冲突时以它们为准。A、B、C 三条路线（D01）共用这套验收：C 与 A 共用页面渲染器，按 A 的页面检查执行。

本页把[路线选择](../../ROUTES.md)落实到输入、执行证据、失败定位和交付门槛。适用组合是 `beiming + three`、`raea + raea`，以及尚需风格适配的 `beiming + raea`。路线决定视觉目标，实际后端、设备和编码器另行记录。

核对基线：北冥提交 `21ed1b10164a94a4fc0d7cf3973934d0f21f301f`；RAEA 源码提交 `fb3f70844e03cc40185e3a06c394060d26c5cd38`；运行包 `0.1.0-canary.2`。本页编写只做源码和已有产物的只读检查，没有启动 GPU、重跑 5090 或产生新的性能结果。执行命令供后续任务使用，未运行的命令不能登记为已通过。

全局分派沿用 [work-plan.json](work-plan.json) 中的 **T00…** 编号与状态。下文 **V01…V06 只是本手册的实施步骤**，挂到相应全局任务的验收项和证据中，不创建第二套调度状态。项目、镜头和结果字段沿用[共享契约](contracts.md)及其模板；模板当前未被渲染器消费。

## 1. 现有能力与证据边界

| 分类 | 已落实的内容 | 不能据此宣称 |
|---|---|---|
| 已实现：Three 执行 | [`openFilm`](../../engine/render/page.mjs) 等待 `window.READY`；[`video.mjs`](../../engine/render/video.mjs) 按 `f / FPS` 调用 `window.render`，独立浏览器分段截图，libx264 编码后拼接 | 任意有状态影片都能分段；软件图形回退会强制失败；`npm run video` 已有声音 |
| 已实现：资产准备 | [`prepare.mjs`](../../examples/raea/tools/prepare.mjs) 复制底板、调用导出和声音生成、两遍 loudnorm，生成 `prepared.json`；[`roundTrip`](../../examples/raea/tools/export-kun-browser.mjs) 回读 GLB 动作 | 所有输入和 SDK 都已做哈希；底板已成为完整三维城市；全部材质和墨线已迁移 |
| 已实现：RAEA 包装 | [`render.mjs`](../../examples/raea/tools/render.mjs) 校验 VERSION、工具可启动、9 项媒体存在；渲染前查询队列和 GPU，保存日志、渲染清单、输出 SHA256，校验部分音视频规格 | 资产存在检查等于哈希检查；队列查询等于独占锁；`technical.json.backend` 是实际 adapter 检测结果 |
| 已实测：历史 Windows | [原实验记录](../raea/experiment-qa.json)：5090、Vulkan、240 帧、OpenH264；47.74fps 含编码且有其他负载 | 同内容同画质受控跑分；NVENC；新版 Node 包装脚本已在 Windows 复测 |
| 已实测：入库后 macOS | [路径迁移记录](../raea/publication-validation.json)：完整解码 240 帧、音轨、响度与资产哈希复核 | 新的 5090 结果；全部艺术验收已通过。已有云片截断边问题见[实验说明](../raea/experiment.md) |
| 建议、待实现 | 统一验收报告、跨后端色彩基准、状态回放用例、分项性能报告、任务占用记录 | 自动排队、互斥锁、断点续跑、检查点恢复或统一 `BackendAdapter` 已上线 |

`raea:check` 的 `--check-only` 分支在队列查询前返回，**不检查共享机是否空闲**。渲染包装的队列请求失败、非成功响应或 `nvidia-smi` 不可用，当前都可能继续执行；其 GPU 门槛仅为一次采样中任一显卡利用率 `>10%` 时退出。这是现有实现，不能当作可靠的共享资源预约机制。

已实现的[只读任务计划工具](../../tools/work-plan.mjs)检查依赖、列出可做任务和写入范围冲突，但不获取 shared5090、执行命令、重试或改变任务状态。本文补的是人工可执行步骤与证据要求，不扩展为自动化平台。

## 2. 先固定共同交付契约

以下是**建议的首轮验收配置，尚非两条路线统一执行的配置文件**。当前原生例片恰好采用相同尺寸、帧率和时长；新作品要把它写入项目模板，再逐项同步实际代码。

| 项目 | 建议约定与检查 | 当前实现入口/限制 |
|---|---|---|
| 时间 | 帧率取档位（默认 24/1 fps）；整数全局帧 `[0,frameCount)`（《北冥》例片 `[0,240)`、10 秒），`frameCount = round(dur×fps)` 写在 film.json；镜头边界使用含头不含尾。最后一帧时间是 `(frameCount−1)/fps`，不是片长 | Three 总帧数为 `round(DUR*FPS)`，场景 fps 与 CLI 必须一致；RAEA [`Composition`](../../examples/raea/film.tsx) 固定 240 帧 |
| 尺寸 | 按档位（D07）：默认 `web-1080p24` 1920×1080；《北冥》样片与本页例片 `beiming-1040p24` 1920×1040；方形像素、宽高为偶数。改变尺寸时复查构图、字幕、线宽和 shader 中硬编码的像素尺度（`qa texts` 的安全区、`qa plates --size` 的贴图密度） | `--size` 只影响 Three；RAEA 固定 Composition 不能假定可被任意 CLI 尺寸参数覆盖 |
| 时钟 | 全局帧、镜头局部帧、角色动作起点分别记录。角色一拍三为 `floor(f/3)*3/24`；摄影和水面仍每帧更新 | [`Piece`](../../examples/raea/film.tsx) 的 `t`、`q` 已区分；统一 FrameState 仍为设计接口 |
| 色彩 | 交付（D07）：H.264、8-bit `yuv420p`、BT.709 原色/传递函数/矩阵、有限范围 `tv`，四项标注齐全，像素也确实落在 16–235（`qa delivery` 的 `delivery.color`、`delivery.range-pixels`）；保留经确认的 sRGB 静帧基准 | 三维线性工作空间、屏幕 sRGB、YUV 矩阵、传递函数、容器标签是不同环节，必须分别确认 |
| 色彩转换 | 用灰阶、肤色/鲲体色、墨线黑位和高光样张核对。先确认输入 transfer/range，再执行一次明确的转换并写标签 | Three [`createFilm`](../../engine/stage/film.js) 输出 sRGB，浏览器固定 sRGB；[RAEA NV12 内核][raea-nv12]实现 BT.709 有限范围矩阵，不独自证明 transfer 正确 |
| Alpha / 后期 | 记录直通或预乘 alpha、雾/遮罩参与、tone mapping、描边、颗粒和二维叠层顺序；最终 MP4 无 alpha | 不用全局改曝光掩盖预乘黑边；北冥的 OutputPass 后 Kuwahara 与原生 FramePass 不自动等价 |
| 音频 | 中间音频 48kHz、双声道 PCM；最终 AAC、48kHz、双声道，起点与视频对齐。24fps 下每帧对应 2000 个采样；10 秒母带为 480000 个采样/声道 | `sound.py` 与 `prepare.mjs` 已生成此例片的 PCM；`video.mjs` 只生成视频。AAC 解码可有填充，不能要求解码音频块数等于视频帧数 |
| 响度 | 按档位（D07）：综合响度 `−14 ±1 LU`（`broadcast-1080p25` 为 `−23 ±0.5`）、真峰值 `≤ −1.0 dBTP`；按**最终 AAC 文件**复测（`delivery.loudness`、`delivery.true-peak`）。混音阶段的真峰值宜留在 −1.5 到 −2 dBTP，给 AAC 的样本间峰值留余量 | 这是待验证的验收门槛，不是所有作品已有结果。原例片历史值保留在其记录，不挪作新作品证据 |
| 拼接 | 拼接前核对 codec/profile/pixel format、尺寸、fps、time base、色彩与音轨参数。不能证明兼容时，从统一中间帧重新编码 | `concat -c copy` 不校正画风、颜色或错帧；Three 分段 H.264 与 RAEA 原生 H.264 不能因同为 H.264 就直接混拼 |

不能仅追加 `-color_trc bt709` 等标签就声称完成 sRGB→BT.709 转换；它不会修改已有像素。标签缺失要查生成路径并做基准帧对照，不能凭分辨率猜测。也不要用 `fps` 滤镜或补帧先“修正”错误产物再验收，原始缺帧应先作为失败记录。

## 3. 阶段门槛：输入、命令、记录、通过条件

所有命令默认从**本任务独占的仓库检出目录根部**运行。`out/validation/<本次编号>/` 是建议的本地证据目录；发布记录使用相对路径并清除机器私人路径。固定输出名的现有工具只在自己的检出目录运行，先归档已有成果，不能覆盖另一个任务的 `media/`、`out/` 或 `delivery/`。

| 阶段 | 必要输入 | 检查/执行入口 | 本地输出记录 | 通过条件 |
|---|---|---|---|---|
| S0 范围与版本 | T00…任务、路线、项目模板、镜头表、工作区状态 | `git rev-parse HEAD`、`git status --short`；第 4 节包版本与哈希检查 | `source.txt`、项目配置副本、运行包哈希、已改文件清单 | 写入范围明确；源码提交与未提交改动均记录；模板与实际入口参数一致 |
| S1 输入与资产 | 资产版本、原生例片输入或 Three 自有场景 | 原生例片 `npm run raea:prepare`；已有 GLB 用独立结构检查命令；第 4 节重算哈希 | `prepared.json`、`kun-report.json`、母带、准备日志 | 所有必需输入齐全且哈希一致；GLB 结构与回读断言通过；新人物另有姿态/接触证据 |
| S2 目标机就绪 | 包版本、SDK、ffmpeg/ffprobe、共享机当前占用 | `npm run raea:check`；第 4 节 ComfyUI、进程、显存/利用率连续采样 | `preflight.log`、`queue-before.json`、GPU/进程快照、占用说明 | 版本正确；设备可确认；无排队/运行冲突；未知占用先定位，不按空闲处理 |
| S3 小样与重渲 | 完整种子、切点、关键动作帧、`evaluation` 类型 | 第 5 节单帧/乱序/顺序测试；相同内容无损帧比较 | PNG、请求序列→全局帧映射、差分、状态摘要 | 先满足状态与帧重现，再开放分段；画面包含所需动作、材质与字体 |
| S4 完整输出 | S0–S3 证据、已确认独占时段 | Three 指定单 worker 起跑；原生 `npm run raea:render`，关闭导出缓存 | 原生视频、最终音画文件、stdout/stderr、`render.json`、`technical.json` | 进程成功退出且无未处置渲染错误；输出清单与当前输入对应 |
| S5 技术验收 | 最终交付文件、作品描述 film.json、原始日志 | `node tools/qa/cli.mjs report <成片> --film films/<名>`（第 7 节；工作站上另可跑手工命令交叉核对） | `qa/report.json`、`report.md`、`contact.jpg`（报告含文件 SHA256、每项实测与期望） | exit 0（硬门全过）；「注意」项逐条复核并在 review 里写结论；豁免只能由用户批准（D08） |
| S6 视觉与声音验收 | 整片、原始关键帧、参考图、事件表 | 第 8 节人工全片观看、带声播放、切点逐帧及风格对照 | `review.md`、失败帧/事件、复核人和日期 | 技术和创作分别签认；原生路线按自身目标，北冥路线必须保留风格对照 |
| S7 性能与复现归档 | 已通过质量检查的同内容输入；空闲窗口 | 第 6 节分项运行；检查实际 adapter 和编码统计 | `performance.json`、负载记录、第 9 节复现记录 | 只对同质量、无竞争且无缓存命中的样本比较；缺失项留空，不能填 0 |

S1 的 `raea:prepare` 虽默认用 SwiftShader 做浏览器资产烘焙，仍会启动浏览器并生成文件；**本次文档任务未执行它**。已有资产可先只读检查：

```sh
node examples/raea/tools/export-kun-validate.mjs examples/raea/media/kun.glb
node examples/raea/tools/export-kun-validate.mjs examples/raea/media/ferry.glb --static
```

[`validateGLB`](../../examples/raea/tools/export-kun-validate.mjs) 的现有断言含有限数值/缓冲区范围、内嵌纹理、骨骼和 morph、`Swim` 10 秒 clip、首尾误差 `<1e-6`；浏览器 `roundTrip` 另检查尾部/胸鳍运动、眼睑闭合、头部无全局漂移和回读循环缝 `<1e-5`。这些是**此资产的既有断言**，不是人物骨骼通用阈值，也不是本页新增实测。

## 4. shared5090 操作顺序

### 4.1 本任务目录和运行包预检

用已有访问方式进入 `shared5090`，再打开 Windows PowerShell。`shared5090` 是执行目标名称，不是仓库附带的调度服务。以下假设已经进入本任务自己的检出目录，且 `RAEA_BIN` 指向完整发行包中的 `bin/raea.exe`；不改其他任务的路径、环境或安装包。

```powershell
$ErrorActionPreference = 'Stop'
$repoRoot = (Get-Location).Path
$caseId = 'raea-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
$qa = Join-Path $repoRoot ('out/validation/' + $caseId)
if (Test-Path $qa) { throw '本次证据目录已存在，请使用新的编号' }
New-Item -ItemType Directory -Path $qa | Out-Null
git rev-parse HEAD | Set-Content -Encoding utf8 (Join-Path $qa 'source.txt')
git status --short | Set-Content -Encoding utf8 (Join-Path $qa 'working-tree.txt')

if (-not $env:RAEA_BIN) { throw '先设置 RAEA_BIN 为发行包内的完整可执行文件路径' }
$raeaExe = (Resolve-Path $env:RAEA_BIN).Path
$versionFile = Join-Path (Split-Path $raeaExe -Parent) '../share/raea/VERSION'
$runtimeVersion = (Get-Content -Raw $versionFile).Trim()
if ($runtimeVersion -ne '0.1.0-canary.2') { throw '运行包版本不匹配，停止本轮比较' }
$runtimeVersion | Set-Content -Encoding utf8 (Join-Path $qa 'runtime-version.txt')
Get-FileHash -Algorithm SHA256 $raeaExe | Select-Object Hash |
    ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $qa 'runtime-binary-hash.json')
$ffmpeg = if ($env:FFMPEG) { $env:FFMPEG } else { 'ffmpeg' }
$ffprobe = if ($env:FFPROBE) { $env:FFPROBE } else { 'ffprobe' }
node --version
& $ffmpeg -version
if ($LASTEXITCODE -ne 0) { throw 'FFmpeg 不可用' }
& $ffprobe -version
if ($LASTEXITCODE -ne 0) { throw 'ffprobe 不可用' }
npm run raea:check
if ($LASTEXITCODE -ne 0) { throw '原生例片预检失败' }
```

另保存 Node、FFmpeg/ffprobe 的版本输出、Windows 版本、驱动版本、发行包压缩包 SHA256，以及包内 `share/raea` 文件树的相对路径和哈希。`VERSION` 只是包的版本声明，不能证明可执行文件和 SDK 未被替换；本地源码固定提交也不能独自证明某个二进制由该提交构建。`raea --version` 在 canary.2 不存在，不能用其失败判断安装损坏。

`prepared.json` 当前只覆盖六张底板、两个 GLB 和 `mix.wav`，还应为本次 TSX、着色器/字体、资产导出源文件、配置和锁文件保存 SHA256。以下命令在仓库根重新校验既有资产清单，无需渲染：

```sh
node --input-type=module -e 'import fs from "node:fs"; import {createHash} from "node:crypto"; const base="examples/raea/media/"; const m=JSON.parse(fs.readFileSync(base+"prepared.json","utf8")); for(const [file,want] of Object.entries(m.assets)){const got=createHash("sha256").update(fs.readFileSync(base+file)).digest("hex"); if(got!==want) throw Error("资产哈希不匹配: "+file);} console.log("已有资产清单哈希一致");'
```

### 4.2 队列、进程与占用检查

在 shared5090 **本机**查询 ComfyUI；未设置 `COMFY_URL` 时沿用示例默认 `http://127.0.0.1:8188`。不要在控制电脑上查自己的 localhost 并当成工作站空闲。

```powershell
$comfyBase = if ($env:COMFY_URL) { $env:COMFY_URL.TrimEnd('/') } else { 'http://127.0.0.1:8188' }
$queue = Invoke-RestMethod -Uri ($comfyBase + '/queue') -TimeoutSec 5
$queue | ConvertTo-Json -Depth 20 |
    Set-Content -Encoding utf8 (Join-Path $qa 'queue-before.json')
if ($null -eq $queue.queue_running -or $null -eq $queue.queue_pending) {
    throw '队列结构未知，需要人工核对'
}
if ($queue.queue_running.Count -gt 0 -or $queue.queue_pending.Count -gt 0) {
    throw '共享机已有 ComfyUI 任务，等待原队列完成'
}
nvidia-smi | Set-Content -Encoding utf8 (Join-Path $qa 'gpu-processes-before.txt')
if ($LASTEXITCODE -ne 0) { throw '无法确认显卡占用，不启动正式 5090 任务' }
nvidia-smi --query-gpu=index,uuid,name,driver_version,utilization.gpu,memory.used,memory.total --format=csv |
    Set-Content -Encoding utf8 (Join-Path $qa 'gpu-before.csv')
if ($LASTEXITCODE -ne 0) { throw 'GPU 状态查询失败' }
Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name |
    ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $qa 'processes-before.json')
```

建议连续观察至少 30 秒，每秒采样 GPU 利用率/显存，同时核对正在排队的非 ComfyUI 任务与机器使用记录。一次利用率低、队列为空、或 `--query-compute-apps` 没有条目都不能证明无人使用：Windows WDDM 图形任务可能不会完整出现在计算进程查询里，常驻模型也可能低利用率但仍占显存。

在单独终端记录负载，可用 `nvidia-smi --query-gpu=timestamp,index,name,utilization.gpu,memory.used,memory.total --format=csv -l 1`；将输出保存到本次目录，结束时只对自己启动的采样命令按 Ctrl+C。若某字段不受驱动支持，保存报错并去掉该字段重试，不能把缺值补成 0。

先与已有任务协调使用时段，在本次 `review.md` 写明任务 T 编号、操作者、预计时段、开始/结束时间、自己的 PID 和输出目录。这是**人工占用记录，不是互斥锁**。立即开跑前再查队列；过程中若出现其他负载，标记该次性能样本受污染，等待后重测。不能 `kill`、`taskkill`、重启驱动或服务、清空别人队列来获得空闲。ComfyUI 不可达时先确认是服务未启用还是连接异常；只有人工确认所有其他占用来源后才决定继续，不凭包装脚本的容错当作放行。

### 4.3 执行并保留原始输出

原生例片执行前确认整个 `examples/raea` 输出区属于本任务：现有包装会覆盖固定输出名。以下命令不用于多人共用同一检出目录。

```powershell
$env:WGPU_BACKEND = 'vulkan'
$env:RAEA_EXPORT_CACHE = '0'
$watch = [System.Diagnostics.Stopwatch]::StartNew()
npm run raea:render
$renderExit = $LASTEXITCODE
$watch.Stop()
@{ exitCode=$renderExit; wallSeconds=$watch.Elapsed.TotalSeconds } |
    ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $qa 'wall.json')
if (Test-Path 'examples/raea/out') {
    Copy-Item -Recurse 'examples/raea/out' (Join-Path $qa 'native-out')
}
if (Test-Path 'examples/raea/delivery') {
    Copy-Item -Recurse 'examples/raea/delivery' (Join-Path $qa 'delivery')
}
if ($renderExit -ne 0) { throw '渲染失败，保留日志后按故障表定位' }
```

Three 目标机用 `BEIMING_ANGLE=vulkan`，它与原生 `WGPU_BACKEND` 是两套环境。初次检查使用一个 worker：

```powershell
$env:BEIMING_ANGLE = 'vulkan'
node engine/render/video.mjs . --size 1920x1040 --fps 24 --workers 1 --out (Join-Path $qa 'three-silent.mp4')
if ($LASTEXITCODE -ne 0) { throw 'Three 视频生成失败' }
```

这条命令不生成音轨；随后按本作品声音表生成、归一化和封装。原项目 [`build.sh`](../../build.sh) 与 [`mux.sh`](../../engine/render/mux.sh) 是 POSIX shell 脚本，不能直接当 PowerShell 语法执行。`mux.sh` 会以 libx264 重新编码视频，RAEA 包装则 `-c:v copy` 后编码 AAC；性能和损失比较必须记录这种差异。

核对三类现有清单：`prepared.json` 是部分输入哈希；`out/render.json` 是实际帧内容/文本/声音/穿插记录；`delivery/technical.json` 是包装检查与成品哈希。它们都不等于完整的复现记录。RAEA 渲染清单的 `frames` 是数组，不是帧数整数；已有例片可只读检查：

```sh
node --input-type=module -e 'import fs from "node:fs"; const m=JSON.parse(fs.readFileSync("examples/raea/out/render.json","utf8")); if(m.width!==1920||m.height!==1040||m.fps!==24||!Array.isArray(m.frames)||m.frames.length!==240||m.frames.some((v,i)=>v.frame!==i)) throw Error("渲染清单的尺寸、帧率或帧索引不匹配"); console.log(JSON.stringify({frames:m.frames.length,clipping:m.clipping,sounds:m.sounds}));'
```

穿插记录要人工逐项判定，不能因它是数组就判通过。视频流 `codec_name=h264` 不能区分 OpenH264、x264、NVENC；必须同时查 `render.stderr.log` 的 `video` 编码统计和实际命令。`technical.json` 中的后端字符串来自环境变量，只表明请求值；需从运行日志、实际 adapter 及 OS 图形进程信息佐证 5090 正在承担渲染。无法确认时填“未知”，不写“已验证 5090”。

## 5. 逐帧重渲与分段状态边界

### 5.1 为什么单帧接口不等于随机访问安全

Three [`createFilm.run`](../../engine/stage/film.js) 会预热镜头并调用 `update(t,f)`，不替场景重置累计状态。每个 video worker 是全新页面；依赖累计 `dt`、可变 PRNG 调用次数、上一帧纹理的内容可能在片段首帧改变。`still.mjs --range` 以两位小数格式化时间，精确逐帧测试应直接给 `f/24` 或调用 `window.render(f/24)`，不能把两位小数当作通用精确帧接口。

RAEA 已有[注册插件补帧/倒退重建][raea-catchup]机制，但仅作用于该插件路径；补帧成本可能随目标帧增加。[Compute 存储缓冲区][raea-compute]跨帧保留，源码明确说明从中途开始会重新初始化。JS 闭包状态、物理、粒子、历史纹理、运动模糊与音频事件必须分别检查；不能推断所有内容都由 `catch_up` 自动恢复，也不能承诺跨平台逐位一致。

### 5.2 最小可执行对照

首轮对每条实际使用的后端分别做下表；跨后端的美术对照另做，不要求两种渲染器像素相同。

| 用例 | 输入/步骤 | 记录与建议通过条件 |
|---|---|---|
| 顺序基准 | 新进程完整求值 `0..239`，保存无损帧及状态摘要 | 每帧对应唯一全局帧；重复两次同后端同设备时，绝对求值场景解码像素一致 |
| 单帧 | 新进程直接求值 `0,1,2,3,83,84,85,143,144,145,194,195,239` | 与顺序基准同帧比较；84、144 是当前例片切点，195 是 8.1 秒后首个整数帧，动作峰值另按事件表添加 |
| 乱序/重复 | 请求 `145,0,84,84,239,143`，保存每个请求，不覆盖重复帧 | 重复 84 一致；回退与跳转不残留此前镜头、曝光或模拟状态 |
| 分段 | 先顺序，再独立渲 `[0,120)` 与 `[120,240)`；额外检查切点 84、144 | 在每个边界前后至少 3 帧逐帧比较；没有重复/漏帧、动作相位重置、跳曝光或音频截断 |

**RAEA 命令模板：** 在第 4 节 PowerShell 环境中，保持仓库根目录、准备好的媒体与本任务 GPU 使用时段。先关闭导出缓存；静帧指令直接调用外部 RAEA，**绕过包装的队列预检**，因此每轮都要手动执行占用检查。

```powershell
$env:RAEA_EXPORT_CACHE = '0'
$env:RAEA_BAKE_WORKERS = '1'
$allFrames = (0..239) -join ','
& $env:RAEA_BIN render examples/raea/film.tsx -o (Join-Path $qa 'sequential-png') --at $allFrames
if ($LASTEXITCODE -ne 0) { throw '顺序无损帧失败' }
& $env:RAEA_BIN render examples/raea/film.tsx -o (Join-Path $qa 'single-00084.png') --frame 84
if ($LASTEXITCODE -ne 0) { throw '单帧失败' }
& $env:RAEA_BIN render examples/raea/film.tsx -o (Join-Path $qa 'shuffled-png') --at '145,0,84,84,239,143'
if ($LASTEXITCODE -ne 0) { throw '乱序帧失败' }
```

[静帧输出分支][raea-stills]可能按请求**序号**写 `frame-00000.png`，所以乱序用例的 `frame-00000.png` 对应全局 145，`frame-00002.png` 与 `frame-00003.png` 都对应 84。保存请求列表与文件映射，不从文件名猜帧号。[场景行采样][raea-fed]可分多个 JS runtime，因此顺序基准显式设 `RAEA_BAKE_WORKERS=1`，后续另测多 worker；它只控制该采样并发，不自动重置自定义模拟。静帧导出可能走不同于 MP4 的路径，顺序 PNG 一致后仍须对最终解码视频复核；单次 PNG 成功不能替代整片测试。

**Three 命令模板：** 快速检查用既有工具指定单帧秒值；严格比较由 V02 的小型验证入口通过 `openFilm()`→`page.evaluate(f => window.render(f/24), f)`→PNG 截图实现，每种序列用新页面，不改旧影片。

```powershell
node engine/render/still.mjs . 3.5 --size 1920x1040 --out (Join-Path $qa 'three-frame84')
```

现有静帧工具输出 JPEG，只适合定位；它和 PNG 或 H.264 不能用文件哈希直接证明像素一致。无损图可用 FFmpeg `-f framemd5` 比较解码像素；相同分辨率、色彩解释、像素格式是前提。**建议门槛：** 同设备同后端纯绝对求值用例先要求解码像素一致；有证据证明 GPU 浮点差异不可消除时，可另批准“最大通道差 ≤2/255、超出 1/255 的像素比例 ≤0.1%”的暂定阈值，同时保留差分图与状态断言。这些是待验证建议，不是既有测试结果，不适用于掩盖明显动作差异。

### 5.3 有状态镜头如何分段

按镜头契约填写 `evaluation: absolute | baked | sequential`：

1. `absolute`：全部状态由全局帧、固定种子、固定输入求值。先通过上表，再按半开区间分派；动作起点不能随分段改变。
2. `baked`：模拟先顺序烘焙成确定的逐帧轨道/网格/缓存，保存帧范围、种子、版本和哈希；确认烘焙覆盖末帧和边界，渲染只采样缓存。
3. `sequential`：目前默认整段顺序执行。从起点回放到片段头后丢弃预热帧，再输出 `[start,end)`；若成本过高，先烘焙。**检查点恢复是未来能力**，不能在任务记录中写成已有命令。

设计检查点时应覆盖帧/固定步长、PRNG 状态、物理位置速度与求解器状态、粒子池、GPU storage、历史颜色/深度、上一帧相机/姿态和声音事件游标。只保存对象 transform 不够。有限长度预热只有通过顺序对照证明收敛后才可使用，不能固定预热 10 帧就宣称等价。切镜时要明确哪些历史缓冲清空、哪些角色/世界继续；硬切不应拖出上一镜的运动模糊，连续动作不应重新从 clip 0 秒开始。

分段只生成视觉帧；混音优先在全片全局时间一次完成，避免片段边缘的混响、淡出和 AAC 编码填充断裂。长片必须分音频时，先用 PCM 按采样索引切分、保留效果尾音，再统一编码。

## 6. GPU、CPU、图形与编码分开测

Windows 默认编码链为 `media_backend() → soft → OpenH264`；设置 `RAEA_MEDIA` 或调用方 codec 可以改变选择，因此每次仍需查日志。[默认选择][raea-media]、[编码线程][raea-encode]、[OpenH264 push_nv12/push_i420][raea-h264]可核对这一链路。Vulkan 既不是 NVENC，也不证明 DLSS 或光追正在启用。

| 测量项 | 可执行办法/源码入口 | 输出与解释边界 |
|---|---|---|
| 总墙钟 | 第 4 节 Stopwatch，覆盖该次命令并记录是否包含准备/封装；重复受控运行 | `wall.json`、原始日志。不能用 `240 / fps_incl_encode` 替代完整端到端耗时 |
| CPU 工作 | 独立记录准备/打包耗时；Windows 用进程 PID 的 CPU 时间增量，纳入自己创建的子进程；检查 React/布局/解码统计 | CPU 秒和墙钟秒分开；RAEA `fed` 包含调用方生成页面等工作，不等于“纯 GPU”或“纯 CPU”时间 |
| GPU 负载 | `nvidia-smi` 连续采样、adapter/驱动、显存峰值、进程快照 | 负载证明竞争情况，不能直接当 GPU 帧耗时。`utilization.memory` 不是已用显存容量 |
| 图形/转换/读回 | 独立诊断轮设置 `RAEA_GPU_TIMES=1`，保存 `times.ms_per_frame` 与 `gpu_ms_per_frame` | [GpuView 计时][raea-gpu-times]覆盖上传、合成、NV12、读回拷贝，**不等于完整 Bevy 3D 所有 pass 的计时**。无 timestamp 支持则为缺测 |
| 编码 | 查原生 `video` 字段；同一组无损输入另跑编码命令。记录输入读取/颜色转换/编码/封装共同耗时 | 当前示例未提供纯 OpenH264 独立计时；若缺仪表留空。FFmpeg/libx264 编码对照不是原生 OpenH264 的速度 |
| 音频与封装 | 对已完成视频轨和已确认母带单独计时 `-c:v copy`+AAC；与重新编码的视频流程区分 | 音频生成、loudnorm、AAC 和 MP4 封装分别记录是否包含 |

**缓存与计时陷阱：** [export_cache][raea-cache]会返回旧视频并附带缓存提示；换输出文件名不能保证重新渲染。重渲和基准轮设置 `RAEA_EXPORT_CACHE=0`，记录打包/烘焙缓存策略；不要清别人的缓存。冷启动和预热后运行分组记录，建议每组至少 3 次，报告中位数与范围，不从 3 个总耗时虚构逐帧 p95。若无逐帧数据，该项为空。

`RAEA_GPU_TIMES=1` 会把正常三帧在途的读回变成逐帧诊断，因此它的总 fps 不能与未开启诊断的吞吐直接排名。诊断轮结束后从**自己的会话**移除该变量，再做正常吞吐轮。CPU 路径只用于源码支持的具体用例，不能把 `RAEA_CPU` 当作任意 3D 片的等价 CPU 渲染开关。

以下是**建议的 CPU 编码隔离实验**，输入必须已经统一颜色并按 24fps 连续保存为 RGB PNG。它含图片解码/磁盘读取和格式转换，不能称为纯编码内核微基准；原生例片默认 PNG 编号需先核对映射。`$frames` 指向本次自己的帧目录：

```powershell
$frames = Join-Path $qa 'approved-color-png'
& $ffmpeg -hide_banner -n -benchmark -framerate 24 -start_number 0 -i (Join-Path $frames 'frame-%05d.png') -frames:v 240 -an -c:v libx264 -preset medium -crf 14 -pix_fmt yuv420p (Join-Path $qa 'encode-only-x264.mp4') 2> (Join-Path $qa 'encode-only-x264.log')
if ($LASTEXITCODE -ne 0) { throw '编码隔离实验失败' }
```

这里未承担正式色彩转换和交付标签写入；不能将实验文件替代最终交付。以后若专门试 NVENC，应记录 FFmpeg 构建、真实 `h264_nvenc`/`hevc_nvenc` 命令、编码日志和画质对照，独立归档为新实验。`ffmpeg -encoders` 列出某编码器只能证明构建包含它，不能证明一次导出用了它。当前任务不要求实施硬编路线。

建议首轮性能门槛仅设为“设备/负载/编码器可确认、无缓存命中、质量先通过、重复样本完整”。暂不设“必须快于某后端”或“必须达到某 fps”；实际内容、镜头、字体、画质和后期不同的两部片只能比较运行事实。

## 7. 实际输出验证命令

**首选：机器 QA 门**（三平台同一条命令，PowerShell 里照样运行）：

```powershell
node tools/qa/cli.mjs report films/<名>/out/<run-id>/master.mp4 --json   # 全部检查组 → qa/report.json、report.md、contact.jpg
node tools/qa/cli.mjs delivery examples/raea/delivery/beiming-raea-10s.mp4 --film examples/raea --profile beiming-1040p24
node tools/qa/cli.mjs plates --film examples/raea                          # B 路线：底板静态找边（云片直线淡出，台账 QA-B-001）
```

它覆盖下表与本节手工命令的全部技术项（完整解码、帧数、PTS 等间隔、尺寸、SAR、色彩标注与像素范围、音轨、音画首尾、响度与真峰值、黑场、静帧、闪帧、切点、文字、底板、声画同步），阈值与出处见 [QA-GATE.md](../quality/QA-GATE.md)。下面的 PowerShell 手工命令保留给工作站取原始证据、或 QA 门报「运行失败」时定位用。

以下 PowerShell 继续使用第 4 节的 `$qa`、`$ffmpeg`、`$ffprobe`。例片路径如下；其他作品显式替换 `$video` 为最终交付文件，不能误验上一轮文件。

```powershell
$video = Join-Path $repoRoot 'examples/raea/delivery/beiming-raea-10s.mp4'
& $ffprobe -v error -count_frames -show_entries 'stream=index,codec_type,codec_name,profile,width,height,pix_fmt,sample_aspect_ratio,r_frame_rate,avg_frame_rate,time_base,start_time,duration,nb_read_frames,color_range,color_space,color_transfer,color_primaries,sample_rate,channels,channel_layout:format=duration,size' -of json $video |
    Set-Content -Encoding utf8 (Join-Path $qa 'probe.json')
if ($LASTEXITCODE -ne 0) { throw 'ffprobe 失败' }
& $ffmpeg -hide_banner -v error -xerror -i $video -map 0:v:0 -map 0:a:0 -f null - 2> (Join-Path $qa 'decode.log')
if ($LASTEXITCODE -ne 0) { throw '完整音画解码失败' }
& $ffprobe -v error -select_streams v:0 -show_frames -show_entries 'frame=best_effort_timestamp_time,duration_time' -of json $video |
    Set-Content -Encoding utf8 (Join-Path $qa 'timestamps.json')
if ($LASTEXITCODE -ne 0) { throw '时间戳读取失败' }
& $ffmpeg -hide_banner -nostats -i $video -map 0:v:0 -an -vf 'blackdetect=d=0.08:pix_th=0.02,freezedetect=n=-50dB:d=0.75' -f null - 2> (Join-Path $qa 'black-freeze.log')
if ($LASTEXITCODE -ne 0) { throw '黑场/静帧检测失败' }
& $ffmpeg -hide_banner -nostats -i $video -map 0:a:0 -vn -af 'ebur128=peak=true' -f null - 2> (Join-Path $qa 'loudness.log')
if ($LASTEXITCODE -ne 0) { throw '响度检测失败' }
Get-FileHash -Algorithm SHA256 $video | Select-Object Hash |
    ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $qa 'delivery-sha256.json')
```

检测命令不修改视频，也不证明画风正确。静帧/黑场阈值是**建议筛查参数**；一拍三角色不应被当作静帧失败，刻意停顿/黑场要对应分镜逐项豁免，而不能放宽阈值掩盖卡帧。容器时长不能替代视频帧数，`nb_frames` 元数据也不能替代 `-count_frames` 完整读取。

机器 QA 门（`tools/qa`，即原计划的 V01 验证器）按以下条件判定；括号里是对应的检查 id：

| 检查 | 通过条件/失败处理 |
|---|---|
| 尺寸、帧数、帧率 | 档位尺寸（本例片 1920×1040）、解码帧数等于 film.json 的 `frameCount`（本例片 240），`r_frame_rate` 和 `avg_frame_rate` 均为档位帧率（`delivery.size`、`delivery.frame-count`、`delivery.frame-rate`）；不采用播放器显示帧率 |
| 时间戳 | 视频解码呈现顺序的 PTS 严格递增；相邻差应为 1/24 秒，允许一个流 time base tick 的舍入；首帧 0、末帧约 9.958333 秒。缺 duration 字段时用相邻 PTS 检查，不能当 0 |
| 时长和同步 | 音画起点/末端差 `≤1/fps`（`delivery.av-align`）；事件同步按 craft/animation.md §5.7 的不对称容差（`sync.events`），仍要带声听。AAC priming 由 MP4 编辑列表在解码时扣掉，母带采样数另核对 |
| 色彩 | `pix_fmt=yuv420p`，`color_range=tv`、三项 bt709，SAR 1:1（`delivery.pix-fmt`、`delivery.color`、`delivery.sar`）；标签缺失判不通过，不默认为通过。灰阶/黑位/高光基准仍要人工对照 |
| 音轨 | AAC、48000Hz、2 声道；整个片段可解码，无缺轨/意外静音/截断/爆音；最终综合响度与真峰值满足档位（`delivery.audio-stream`、`delivery.loudness`、`delivery.true-peak`） |
| 日志与清单 | 退出码为 0；无未处置 shader、资源、字体、3D 错误；清单全局帧连续，文件 SHA256 与归档一致 |

抽取全片每秒 4 帧和切点邻帧，供视觉表使用；这不替代观看整片：

```powershell
New-Item -ItemType Directory -Path (Join-Path $qa 'sample4fps') | Out-Null
& $ffmpeg -v error -n -i $video -vf 'fps=4' (Join-Path $qa 'sample4fps/%03d.png')
if ($LASTEXITCODE -ne 0) { throw '全片抽帧失败' }
New-Item -ItemType Directory -Path (Join-Path $qa 'cuts') | Out-Null
& $ffmpeg -v error -n -i $video -vf 'select=between(n,81,87)+between(n,141,147)+between(n,192,198)' -fps_mode vfr (Join-Path $qa 'cuts/%03d.png')
if ($LASTEXITCODE -ne 0) { throw '切点抽帧失败' }
```

抽帧文件按输出顺序编号，另保存“文件→全局帧/时间”映射。`81..87`、`141..147`、`192..198` 对应当前例片；其他作品从自己的镜头表和动作事件推导，不能机械照抄。

## 8. 视觉验收表与故障分诊

记录每行“通过/失败/不适用”、复核帧和原因；未看过的项目写“未复核”。`technicalAcceptance` 与 `creativeAcceptance` 分开保存，失败问题必须有截图或时间点。

| 视觉/声音项 | A 北冥风格路线 | B 北冥原生路线 | 最小证据 |
|---|---|---|---|
| 造型与空间 | 原版鲲/渡船比例、二维/三维比例、透视与构图对照 | 项目自身造型、尺度、相机和空间目标 | 远/中/近景同时间关键帧；单位和包围盒记录 |
| 色阶/材质/光照 | 对照基准色板、阴影档位、轮廓墨色；逐项解释变化 | 检查所选 Toon/PBR/自写材质是否达成意图 | 灰阶、主体和高光裁切放大图，曝光配置 |
| 墨线/笔触/后期 | ID 交界墨线、Kuwahara、纸纹粒度和顺序分别验收 | 仅验本作品承诺的效果；不用北冥风格作为默认门槛 | 同画幅局部图、启停效果对照；不以“有 Toon”冒充迁移完成 |
| 底板与 Alpha | 云片/城市边缘、遮挡、雾、视差不破坏北冥画面 | 检查本场景合成边界、透明排序、层级 | 最大相机运动处；既有云片竖边不能默认放行（台账 QA-B-001）。`qa plates` 报直线淡出露在画内的帧号与屏幕位置、4K 下的贴图密度 |
| 动作与表演 | 动作有预备、可见变化和结果；未来人物需眼神/接触对应事件表 | GLB clip、眨眼、朝向、接触和形变可见且符合目标 | 起点/峰值/终点帧与带声片段；例片不含完整人物表演 |
| 时序与边界 | 一拍三只作用于指定角色轨道，摄影连续；切镜后相位正确 | 全局/局部时钟、模型循环与有状态效果一致 | 切点和分段边界前后至少 3 帧 |
| 字体与文字 | 字体、字形、留白与原版或新基准相符 | 字体已加载，不是静默替代；可读时长符合内容 | 中文字形放大图、首次/末次文字帧；页面型作品先过 `qa texts`（缺字按 cmap 判、安全区、停留、对比度） |
| 全片与声音 | 从头到尾带声播放，无突兀节奏、爆音或音画错位 | 同左，按本作品叙事而非仅按编码规格评审 | 播放器、日期、复核人、问题时间点；播放器掉帧与文件缺帧分别诊断 |

| 症状 | 先查证据/可能来源 | 处置与复验 |
|---|---|---|
| 预检通过但输入变了 | `render.mjs` 仅 `access()`；比较 `prepared.json` 与当前文件哈希 | 在自己的目录重新准备，保存新旧哈希；不能继续套用旧报告 |
| 包版本/SDK 不匹配 | `share/raea/VERSION`、二进制/包哈希、SDK 树 | 恢复完整固定包；升级另立验证记录，不修改他人公共包 |
| Vulkan 但很慢/没用 5090 | adapter、浏览器 renderer、SwiftShader/lavapipe、进程与显存 | 核对本任务环境和设备；Three 软件回退仅警告，验收需主动判失败 |
| 极快完成、性能异常好 | stdout 的 `from the export cache`；是否保存当次统计 | 用 `RAEA_EXPORT_CACHE=0` 新跑；缓存命中不计渲染吞吐 |
| 帧数正常但物体/后期缺失 | stderr 的 shader、纹理、字体、3D 错误；[bevy_fed_gpu][raea-bevy-frame]可记录错误后继续取纹理 | 隔离单帧与最小材质/模型；修复后重看全片，不只看退出码 |
| 天空/云片露边、雾矩形 | Alpha 预乘、面片尺寸、摄影范围、雾参与与合成顺序 | 做固定相机/关雾/单层对照；修好后复验最大运动处 |
| 皮肤/纸张变灰、黑位抬升 | sRGB/线性重复转换、601/709 矩阵、full/limited、transfer 标签 | 从已知灰阶重建一次明确转换；标签修补不能替代像素修正 |
| 分段接缝/跳帧不同 | 全局帧映射、PRNG、物理/Compute buffer、上一帧历史 | 退回顺序或完整烘焙；比较边界状态和无损帧，不先加转场掩盖 |
| H.264 被标为 NVENC | 原生 `video` 字段、命令行、平台默认链路 | 更正为实用编码器；默认 Windows OpenH264 另记 CPU 成本 |
| 文件可播放但声音截断 | 原生音轨、最终封装 `-t 10`、母带时长和尾音、AAC padding | 新时长须同步 TSX、音频和包装契约；重验同步/响度/末尾 |
| 只在播放器卡顿 | 完整解码计数/错误日志与播放器掉帧统计 | 解码完整则独立排查播放能力；不把显示掉帧算文件漏帧，也不略过整片复核 |
| 显存增长或中途失败 | 输出尺寸、worker 数、纹理/模型、缓存、其他进程 | 只降低本任务并行/规模并保留失败日志；不终止他人任务。新设置须重新过质量门槛 |

## 9. 复现记录模板

复制[结果模板](templates/render-result.json)到本任务证据目录，填实际已知值；未测字段保持 `null`。不要把计划中的 `execution.target` 抄成 `actualDevice`，也不要从平均耗时推算未测的 `renderSeconds`/`encodeSeconds`。

另在同目录写下列人工记录。它是模板的补充证据，不是新运行时 API 或调度数据库：

```markdown
# 本次复现记录

- 全局任务：T编号；实施步骤：V编号；操作者/复核人：待填
- 本次编号、开始/结束时间与时区：待填
- 路线 / 后端 / evaluation：待填
- 源码提交与未提交变更摘要：待填
- 入口、项目/镜头/风格/事件表相对路径：待填
- RAEA 源码快照、包 VERSION、包/二进制/SDK 哈希：待填或不适用
- Three、浏览器、Node、Python、FFmpeg/ffprobe 版本：待填或不适用
- 操作系统、驱动、实际 adapter、请求/实际图形后端、实际编码器：待填
- 素材清单/哈希、字体、种子、音频母带哈希：待填
- 尺寸、fps、帧范围、全局/角色时钟起点：待填
- 输入/工作/输出色彩、Alpha、后期顺序与转换命令：待填
- 命令和工作目录：相对项目根；运行所需环境白名单：待填
- 缓存策略、冷/预热轮、worker 数、诊断开关：待填
- shared5090 占用协调、队列/负载日志、自己的 PID：待填
- 原始 stdout/stderr、退出码、渲染清单：相对路径
- 单帧/顺序/乱序/边界对照、帧号映射：相对路径或未执行
- 技术检查：解码帧数/PTS/音轨/响度/黑场/静帧/色彩；证据路径
- 创作检查：逐项结论、失败帧/事件、复核人；证据路径
- 计时：墙钟/准备/图形/CPU/读回/编码/音频；未测项明确留空
- 最终文件相对路径与 SHA256：待填
- 已知限制、复现失败命令、最小失败帧、下一步责任人：待填
```

环境只记录 `RAEA_BIN` 的包内位置、`WGPU_BACKEND`、`BEIMING_ANGLE`、`RAEA_MEDIA`、相关缓存/诊断开关与自定义工具版本等必要项；公开副本不导出整套环境或机器私人路径。实际地址、共享机进程详情和调试日志留在本地证据包；公开摘要保留复现所需参数与相对引用。

## 10. 可分派实施步骤 V01–V06

这些步骤的状态均应由全局 `work-plan.json` 的所属 T 任务承载；下表只规定工作包内容，不宣称功能已完成。建议实现文件名也不代表文件已经存在。每个执行者只改其获分派的范围，GPU 工作串行预约；本次文档编辑不实施这些代码或 GPU 任务。

当前清单的对应关系：V01/V02 归入 **T15** 的 `tools/qa/` 与 `tests/qa/`；V03 是 **T14** 的工作站运行证据，并为 T13 的包装复测提供输入；V04 归入 **T16**；V05 归入 **T17**；V06 将证据交回各所属任务及最终 T20 汇总。下表局部依赖只表达验收顺序，实际任务依赖和写入授权以全局清单为准。

| 步骤 / 角色 | 输入与依赖 | 具体工作及建议写入范围 | 输出与验收 |
|---|---|---|---|
| **V01 共同技术验收 / 媒体工程** | 共享项目/结果模板、本页 S5、各路线已输出文件 | **已实现为机器 QA 门 `tools/qa`（2026-11-10）**：`node tools/qa/cli.mjs report <成片>`；合成反例（25 fps、缺音轨、截短、全范围、黑场、静帧、闪帧、多余切点、缺字、出画）在 `tests/qa/` 里各自被拒绝 | 报告结构见 QA-GATE §6；人工创作状态保持未复核 |
| **V02 逐帧与分段回归 / 渲染工程** | V01、固定种子/镜头/事件；`openFilm`、`window.render`、RAEA `--frame/--at` | 建议独立 `tools/qa/validate-frame-order.mjs` 与 `tests/qa/` 夹具；记录顺序、单帧、乱序、重复请求映射；加入一个累计状态反例，证明检查能发现中途初始化 | 无损帧与解码差分、边界表；absolute/baked 才获分段资格，sequential 明确回放/烘焙方案；不改 RAEA 内核 |
| **V03 5090 复现 / 工作站执行** | V01–V02 所需方案、canary.2 完整包、准备好的例片、空闲时段 | 只在任务专用输出目录按第 4 节运行新版 Node 包装；记录版本/资产哈希、队列、负载、adapter、编码器、日志；补失败信息，不写自动队列服务 | 一次可追溯的 Windows 全流程记录，240 帧/AAC/实际设备证据；未知设备或并发污染不报告成受控性能通过 |
| **V04 色彩与视觉对照 / 美术技术** | V01、S3/S4 产物；A 的原版基准或 B 自身视觉目标 | 在任务的夹具/输出目录建立灰阶、Alpha 边缘、线条与主体色对照；明确转换和后期顺序；逐项执行第 8 节，记录云片边缘等遗留问题 | 技术/创作两份结论；A 的风格差异逐项解释，B 的动作目标可见；问题有具体帧，未达标不填 accepted |
| **V05 分项性能 / 性能工程** | V03、V04 质量通过后的相同输入；已协调的共享机窗口 | 只写本次 `out/validation/...`；关闭导出缓存，分冷/热正常轮和 timestamp 诊断轮；CPU、GPU、读回、编码、封装分项记录，缺项留空 | 至少 3 次同组正常样本及原始日志、独立诊断结果；实际 OpenH264 与外部 x264 分开；没有跨内容速度排名或未测 p95 |
| **V06 证据汇总 / 验收负责人** | V01–V05、结果模板、视觉表和失败记录 | 只维护所属任务结果与证据索引；核对哈希、相对链接、版本、帧映射与未提交变更；将结论回填所属 T 任务的 evidence，由任务负责人决定状态 | 第三人可按记录复现；已实现/已实测/建议清晰，未测项不伪造；最终技术和创作都通过才接受交付 |

并行边界：V01 工具实现与 V04 基准整理可在不同写入范围并行；V02 的 GPU 对照、V03 与 V05 的实机运行要协调 shared5090 时段。V06 不以文档、模板或只读计划工具的完成代替实际作品验收。

## 固定源码依据

除北冥相对链接外，以下 RAEA 引用均锁定本次检查提交。保留外部运行包和 SDK，不复制其实现进入本仓库。

- [导出入口、单帧/乱序参数与静帧编号][raea-stills]；[整片导出缓存与禁用条件][raea-cache]。
- [注册插件 catch_up：跳帧补更新、倒退重建 App][raea-catchup]；[Compute 跨帧状态说明][raea-compute]。
- [fed 编码、容量四的通道与统计][raea-encode]；[三帧读回、timestamp 诊断范围][raea-gpu-times]。
- [非 Apple 默认 soft 后端][raea-media]；[OpenH264 的 NV12→I420 与编码][raea-h264]。
- [BT.709 有限范围 NV12 内核][raea-nv12]；[3D 合成与错误记录][raea-bevy-frame]。

[raea-stills]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/runtime/export/src/render.rs
[raea-fed]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/runtime/export/src/fed.rs#L24
[raea-cache]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/runtime/bundle/src/cache.rs
[raea-catchup]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/engine/render/src/engine.rs#L265
[raea-compute]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/systems/compute/src/lib.rs#L1
[raea-encode]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/runtime/encode/src/render.rs#L18
[raea-gpu-times]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/runtime/view/src/gpuview/render.rs#L25
[raea-media]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/systems/frame/src/lib.rs#L240
[raea-h264]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/io/soft/src/h264.rs#L138
[raea-nv12]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/core/k/kernels/nv12buf.k
[raea-bevy-frame]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/runtime/export/src/bevy_frame.rs#L156
