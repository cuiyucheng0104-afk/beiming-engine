# engine/render · 页面渲染器 v2（规格）

读者｜写作品页面、调渲染命令、编排出片的人与 agent　状态｜生效（加固计划 P04 的 R1–R4）　命令约定｜[docs/CLI.md](../../docs/CLI.md)　测试｜`node tools/run-tests.mjs --only render`

把一个满足**页面约定**的网页（`films/<名字>/index.html`，或仓库根的《北冥》样片）在无头 Chrome 里逐帧渲染：静帧、整片、逐镜头缓存，再与混音封装成成片。A 路线（WebGL 三渲二）与 C 路线（代码动画）都用它；B 路线的原生渲染在 `native.mjs`（不归本规格）。

## 1. 命令

| 命令 | 做什么 | 例子 |
|---|---|---|
| `node engine/render/still.mjs` | 静帧：按秒（样张、联系表，默认 JPEG）或按整数帧（QA、金标准，默认无损 PNG） | `node engine/render/still.mjs films/x --frame 0,72,191 --out films/x/out/stills` |
| `node engine/render/video.mjs` | 整片或区间：逐帧无损截图 → 一次色彩换算 → H.264；不写 `--out` 时出到运行目录 | `node engine/render/video.mjs films/x --profile web-1080p24` |
| `node engine/render/shots.mjs` | 按 film.json 的镜头表逐镜头渲染并缓存，只重渲变了的镜头；`--out` 拼成一部 | `node engine/render/shots.mjs films/x --out films/x/out/cut.mp4` |
| `node engine/render/lib/mux.mjs` | 音画封装：响度线性归一、画面能拷贝就拷贝、写 AIGC 隐式标识（`mux.sh` 是调用它的兼容壳） | `node engine/render/lib/mux.mjs v.mp4 mix.wav out.mp4 --film films/x` |
| `node engine/render/serve.mjs` | 本地预览服务，只听 127.0.0.1（`npm run serve`） | `node engine/render/serve.mjs --port 8080` |
| `node tools/rtx/gpucheck.mjs` | GPU 自检：逐个 ANGLE 后端看 WebGL 落在哪块 GPU（`npm run env:gpu`） | `node tools/rtx/gpucheck.mjs --json` |

所有命令都遵守 docs/CLI.md：`--help` 只打印用法（不开浏览器、不写文件）；不认识的选项退出 2 并给「是不是想写」；`--json` 时 stdout 只有一个信封对象（`{schemaVersion, ok, exitCode, command, error, outputs, runJson, warnings, data}`），日志全在 stderr；`--quiet` 关进度。完整选项看各命令的 `--help`。

先跑这几条：

```sh
node tools/rtx/gpucheck.mjs                                   # ★ 后端要落在硬件 GPU 上，否则按提示设 BEIMING_ANGLE
node engine/render/still.mjs films/x 0 1.5 2.9 --out films/x/out/stills   # 三张关键帧
node engine/render/video.mjs films/x --plan                   # 估算整片耗时与磁盘
node engine/render/video.mjs films/x                          # 出到 films/x/out/<运行号>/master.mp4
```

## 2. 页面约定 v1（附录 C5）

页面在置 `window.READY` 之前设好下面这些。渲染器打开页面后先核对，不合约定退出 4（错误码 `contract.*`），信息里点名是哪一条、收到的值是什么。

| 字段 | 要求 |
|---|---|
| `window.DUR` | 必选。片长（秒），有限正数；帧数 = `round(DUR × fps)`，要等于 film.json 的 `output.frameCount`（不等退出 4） |
| `window.render(t)` | 必选。把画面画到时刻 `t`（秒），可同步也可返回 Promise。**必须确定**：只依赖 `t`，任意帧可单独、乱序重渲 |
| `window.READY` | 必选。贴图、字体、着色器都就绪后置 `true`；上限 180 秒（`--ready-timeout`），15 秒还没好先打印已看到的报错与没回来的请求 |
| `window.FPS` | 可选。页面按什么帧率量化一拍二 / 一拍三；不写按 24。与请求的帧率不同退出 4（`--any-fps` 放行并记警告） |
| `window.TEXTS(t)` | 推荐。该时刻画面上的文字：`[{ text, box: [x, y, w, h], alpha, font }]`（画布像素、0–1 不透明度、CSS 字体串）。QA 用它查安全区、停留、对比度与缺字。旧写法 `{ id, text, x0, y0, x1, y1 }` 仍认，但会提示补 `alpha`、`font`；`still.mjs --texts` 逐张读回核对 |
| `window.EV`、`window.TIMELINE` | 可选。声画事件表 / 节拍表（`events.mjs` 导出） |
| `window.BEIMING_CONTRACT` | 可选，缺省 1；本渲染器只认 1 |
| `window.__RENDER` | 渲染器在页面脚本之前注入（只读）：`{ fps, width, height, profile, frameCount, contract }`。页面要按交付档位的帧率量化时读 `__RENDER.fps` |

禁止：渲染路径里用 `Math.random`、`Date.now`、`performance.now`（计时除外）；渲染时读回 GPU 画布（会把画布从 GPU 光栅切到 CPU 光栅，破坏分段一致）；访问外网（默认拦截并判失败，`--allow-network` 放行并记进运行记录）。

判为致命、立即停下的页面问题：未捕获的异常、`render(t)` 抛错或返回 reject、页面崩溃、着色器编译失败（控制台 `Shader Error` / `VALIDATE_STATUS false`，three.js 的写法）、WebGL 上下文丢失（每个 WebGL 画布的 `webglcontextlost` 都被监测）、任何本地文件返回 ≥ 400 或请求失败（`--lenient-assets` 只放行非脚本类的 404）、单帧超过 120 秒（`--frame-timeout`）。

## 3. 帧、时间与区间

- 帧号是整数，`t = 帧号 / fps`。区间一律**含头不含尾**：`--frames 72:120` 是第 72–119 帧，共 48 帧。`still --frame N` 与 `video` 的第 N 帧是同一时刻、同一张截图（测试核对截图哈希相同）。
- 帧率的来源（先到先得）：`--fps` / `--profile` 的档位 / film.json 的 `output.fps` / 页面的 `window.FPS` / 24。显式写法互相冲突是用法错误（退出 2）。
- `--shot S2` 等于该镜头的 `--frames in:out`；镜头 `evaluation: "sequential"`（有状态、只能从头顺序渲）的只能整镜渲。

## 4. 输出位置与运行记录（附录 C4、C8）

- 写了 `--out`：成片就是它，运行记录是 `<输出>.run.json`。
- 不写 `--out`：作品出到 `films/<名字>/out/<运行号>/master.mp4`，《北冥》样片出到 `out/beiming/<运行号>/master.mp4`；运行记录是同目录的 `run.json`；成功后把运行号写进指针文件 `…/out/latest`（不用符号链接）。运行号 `YYYYMMDD-HHMMSS-<短提交>[-dirty]`。
- 写盘一律先写临时名再改名：失败或被中断不留半成品；分段临时目录 `<输出目录>/.segs-*` 任何结局都删。

运行记录每次都写，失败也写（开渲前先写一份占位，旧记录不会被误当成这次的结果）。主要字段：

| 字段 | 内容 |
|---|---|
| `status`、`stage` | 渲染器只写 `running`（`stage: rendered` 表示已出片、待 QA）或 `failed`；`passed` / `accepted` 由 QA 门与人工评审之后的出片编排改写 |
| `projectId`、`shotId`、`route`、`backend`、`runId` | film.json 的 id 与路线；整片 `shotId` 为 `film` |
| `sourceCommit`、`dirty`、`argv` | 提交号、是否有未提交改动、完整命令行（仓库内路径写相对路径） |
| `tools` | `node`、`playwright`、`three`、`browser`（实际浏览器版本）、`ffmpeg` |
| `actualDevice`、`actualGraphicsBackend`、`softwareFallback` | 实测的 GPU（UNMASKED_RENDERER）、`ANGLE <后端>`、是否落到软件渲染 |
| `output` | `{path, sha256, width, height, fps, frames, duration, codec, pixFmt, color}`，全部来自 ffprobe 实测 |
| `frameHashes` | 逐帧截图的 sha256 前 16 位（确定性核对、续跑与金标准用） |
| `timing` | `setupSeconds`、`renderSeconds`、`encodeSeconds`、`totalSeconds` |
| `technicalAcceptance`、`creativeAcceptance` | 渲染器只写 `not-run` / `not-reviewed` |
| `error` | 失败时 `{code, message, hint, exitCode}` |
| `selfCheck` | 用作品描述包的校验器（`engine/production/film.js` 落地后用它，否则 `project.js` 的 `validateRenderResult`）自检的结果，只提示 |

## 5. 交付档位（附录 C7）

`--profile <档位>` 给出画幅与帧率；不写时读 film.json 的 `output.profile`。档位表的唯一来源是 `engine/production/profiles.json`，读取与 D07 兜底统一走 `tools/lib/profiles.mjs`。新作品默认 `web-1080p24`；《北冥》样片用 `beiming-1040p24`（1920×1040）。`master-*` 档位默认用 crf 10 / slow 的高码率母版。

## 6. 编码链

1. 每帧 `render(t)` 之后用 CDP 截**无损 PNG**（`optimizeForSpeed`，与 Playwright 的 PNG 逐像素相同）。`--fast` 改用 JPEG q95（快约 2 倍、多一代有损，只用于预览）。
2. FFmpeg 只做**一次**显式色彩换算：sRGB → 有限范围 BT.709 yuv420p（`scale=out_range=limited:out_color_matrix=bt709:flags=accurate_rnd+full_chroma_int`），并用 `setparams` 加 `-colorspace/-color_primaries/-color_trc bt709 -color_range tv` 写明全部标记（只加输出参数时 FFmpeg 8 的原色与传递特性仍是 unknown）。中性灰 128 → Y 126、Cb/Cr 128，色卡按标记解码误差 ≤ 2 级。
3. 主输出 libx264 crf 14 / medium（档位可改）；`--web` 同一遍再出网页版（crf 20、码率上限 14M、2 秒关键帧、宽 > 1920 时缩到 1920）——母版与网页版各自只编一代。
4. 帧区间切成固定的块（`--chunk`，默认总帧 / 8、夹在 1–10 秒，按镜头边界切），几路浏览器取块，块拼接用 concat 复制、不重编码；拼接前核对每块的编码、像素格式、画幅、帧率、时间基与色彩标记相同。**块的边界与 `--workers` 无关，成片不随路数变**；同一提交、同一浏览器构建、同一 GPU 后端下逐字节可复现——前提是页面通过了确定性检查（`render(t)` 只依赖 `t`）。
5. 封装（`lib/mux.mjs`）：
   - 画面：`grain` 为 0 且输入已是完整标记的有限范围 BT.709（`video.mjs` 的产物）时视频轨**原样拷贝**，只编码音频；需要颗粒或输入标记不全时才换算并重编码一次。
   - 帧率与帧数：传了期望帧率（第 4 个参数或 `--fps`）或 `--frames` 而与输入不符，退出 4——不用 fps 滤镜“修正”（那会静默丢帧或重复帧）。
   - 响度：用 ebur128（BS.1770）实测积分响度，整段乘同一个线性增益到目标（默认 −14 LUFS，`--profile` / `--target-lufs` 可改），不压动态；编成 AAC 后真峰值仍高于上限 − 0.2 dB 时才在 4 倍过采样上限幅，再补回响度。最后核对 |I − 目标| ≤ 0.5 LU、真峰值 ≤ −1.0 dBTP，不达标退出 4。音频按画面时长补静音或截断，不丢末帧。无声片把音频写成 `-`。
   - AIGC 隐式标识（D11，[docs/rights/aigc.md](../../docs/rights/aigc.md)）：film.json 的 `aigc.contains` 为 true（`--film` 指定），或 `--aigc visual,voice,music` 时，用 `tools/compliance/lib/aigc.mjs` 的 `ffmpegMetadataArgs` 把 `AIGC{…}` 加人读说明写进 `comment`，`ProduceID` 是 `<作品>@<运行号>`。`video.mjs` / `shots.mjs` 出的无声片同样带上。

## 7. GPU、并发与共享工作站

- **ANGLE 后端**：`--angle` / `BEIMING_ANGLE` / 平台默认（macOS `metal`、Windows `vulkan`、Linux `default`）。先转小写再按平台校验：Mac 上写 `vulkan`、Windows 上写 `metal` 直接退出 2（以前会静默落到软件渲染）。`default` 表示不传 `--use-angle`。
- **GPU 策略**：`--gpu required`（默认）落到软件渲染（SwiftShader、llvmpipe、WARP）退出 3；`any` 放行并记警告；`software-ok` 明确要软件渲染（CI 冒烟、没有 GPU 的机器）。没写 `--gpu` 时读 `BEIMING_GPU`，写错同样退出 2。实测设备记进运行记录的 `actualDevice`、`softwareFallback`。
- **浏览器**：Playwright 自带、`package.json` 锁定的 chromium-headless-shell（`BEIMING_CHROME` 可换）。渲染器、`gpucheck.mjs` 与 `npm run env:doctor` 用同一个启动函数和同一组参数，所以自检看到的就是渲染时的 GPU。Windows Vulkan 下 `--settle auto` 会在截图前多等两帧（显示层残留的对策，`tests/render/fixtures/residue` 是回归页）。
- **输出锁**：`<输出>.lock`（记 pid 与心跳）。同一个输出第二次渲染退出 5；崩溃留下的锁按 pid 与心跳自动接管。
- **渲染槽位**（可选）：设 `RENDER_SLOTS=N`（或 `--slots N`）时整台机器同时最多 N 个渲染，多出来的排队（`--no-wait` 直接退出 5，等超过 `--wait-timeout` 退出 124）。
- **共享 GPU 守卫**：有 `nvidia-smi` 的工作站开渲前采样，任一卡占用 > `BEIMING_GPU_BUSY_UTIL`（默认 10%）、空闲显存 < `BEIMING_GPU_MIN_FREE_MB`（默认 2048）或 ComfyUI 队列（`COMFY_URL`）有任务就等；从不终止别人的进程。`--no-guard` 关掉。

## 8. 失败、信号与退出码

任何失败都停下其余各路，杀掉 FFmpeg、关掉浏览器、删掉临时目录、释放锁与槽位，写 `status: failed` 的运行记录，然后按下表退出——渲染错误 30 秒内退出（`tests/render/failure.test.mjs` 逐个夹具核对，含进程残留检查）。收到 SIGINT / SIGTERM 同样收尾，退出 130 / 143；SIGHUP 按 SIGTERM 处理；收尾时再按一次 Ctrl-C 立即退出。

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 运行失败：页面报错、render 抛错、着色器错误、上下文丢失、缺素材、FFmpeg 出错 |
| 2 | 用法错误：不认识的选项、取值不合法、找不到影片目录、ANGLE / GPU 策略写错 |
| 3 | 环境不合格：要求 GPU 却落到软件渲染、缺 FFmpeg / 浏览器、磁盘不够 |
| 4 | 契约不通过：页面约定、帧率 / 帧数、片段参数、响度 |
| 5 | 资源忙：输出锁、渲染槽位、共享 GPU、端口 |
| 124 | 超时：等 READY、单帧、排队 |
| 130 / 143 | 收到 SIGINT / SIGTERM（或 SIGHUP），已清理 |

## 9. 错误码

`--json` 信封与运行记录里的 `error.code` 是稳定标识，前缀决定退出码（`tools/lib/cli.mjs`）。编排器按退出码分支，按错误码细分；不要解析报错文字。`npm run check:repo` 的 `render.error-codes` 核对本表与代码一致。

| 错误码 | 退出码 | 什么时候 | 下一步 |
|---|---|---|---|
| `usage.unknown-option` | 2 | 不认识的选项（命令约定库） | 看「是不是想写」的提示与 `--help` |
| `usage.bad-value` | 2 | 取值不合法：`--size` 不是偶数、`--frames` 写反、数值不大于 0、`--range` 步长为 0 | 按提示改写法 |
| `usage.missing-value`、`usage.repeated-option`、`usage.extra-argument`、`usage.missing-argument` | 2 | 选项缺值、写了两次、多余或缺少位置参数（命令约定库） | 按提示改 |
| `usage.conflict` | 2 | 两处写法冲突：`--frames` 与 `--shot`、`--size` / `--fps` 与档位、位置参数与选项 | 只留一处 |
| `usage.duplicate` | 2 | still 的两个时刻 / 帧号会写到同一个文件 | 去掉重复 |
| `usage.film-not-found` | 2 | 影片目录不在仓库里或没有 index.html | 作品放在 `films/<名字>/` |
| `usage.film`、`usage.film-json` | 2 | 旧接口的用法错误；`mux --film` 读不了作品描述 | 按提示改 |
| `usage.frames-out-of-range` | 2 | 帧区间或帧号超出片长 | 整片是 `--frames 0:<帧数>` |
| `usage.angle` | 2 | ANGLE 后端不认识或不属于这个平台 | 跑 `node tools/rtx/gpucheck.mjs` 选后端 |
| `usage.gpu-policy` | 2 | `--gpu` / `BEIMING_GPU` 不是 required、any、software-ok | 改成三者之一 |
| `usage.profile-unknown` | 2 | 不认识的交付档位 | 提示里列出可用档位 |
| `usage.no-shots`、`usage.shot-unknown`、`usage.sequential-partial` | 2 | 没有镜头表、镜头 id 不存在、从 sequential 镜头中间起渲 | 按提示改 |
| `usage.input-missing` | 2 | 封装时找不到画面或声音文件 | 先出无声视频；无声片写 `-` |
| `usage.bad-root` | 2 | `serve --root` 不是目录 | 写仓库里的目录 |
| `env.software-gl` | 3 | `--gpu required` 却落到软件渲染 | 换 `BEIMING_ANGLE`，或明确用 `--gpu software-ok` |
| `env.webgl-unavailable` | 3 | 建不起 WebGL2 上下文 | 查显卡驱动，跑 gpucheck |
| `env.gpu-not-hardware` | 3 | gpucheck：渲染器会用的后端不是硬件 GPU | 按推荐设 `BEIMING_ANGLE` |
| `env.browser-launch` | 3 | 无头浏览器起不来 | `npm run setup` 装锁定的 headless shell |
| `env.ffmpeg-missing`、`env.ffprobe-missing`、`env.ffmpeg-encoder-missing`、`env.ffmpeg-spawn` | 3 | 找不到 FFmpeg / ffprobe、缺 libx264 或 aac、起不来 | 装 FFmpeg ≥ 7，或设 `FFMPEG` / `FFPROBE` |
| `env.disk-insufficient` | 3 | `--plan` 估算磁盘不够 1.5 倍余量 | 换输出目录或清理磁盘 |
| `env.lock-io`、`env.listen` | 3 | 输出目录不可写；预览服务监听失败 | 查权限 |
| `contract.dur`、`contract.render`、`contract.fps`、`contract.texts`、`contract.version` | 4 | 页面约定不符（第 2 节） | 按报错改页面 |
| `contract.fps-mismatch` | 4 | 请求的帧率与页面帧率不同 | 去掉 `--fps`，或页面读 `__RENDER.fps`，或 `--any-fps` |
| `contract.frame-count` | 4 | 页面帧数与 film.json 不一致；块或拼接后的帧数不对 | 页面时长从 film.json 推出 |
| `contract.film-json`、`contract.film-shots` | 4 | film.json 不是合法 JSON、镜头表帧号不对 | 修好文件（档位表读不出时按 D07 兜底，并记一条警告） |
| `contract.concat-mismatch`、`contract.concat-empty` | 4 | 待拼接的片段参数不一致；区间为空 | 去掉 `--resume` 或加 `--force` 重渲 |
| `contract.input-fps-mismatch`、`contract.input-frames-mismatch`、`contract.input-vfr`、`contract.input-fps`、`contract.input-frames`、`contract.input-color`、`contract.no-video` | 4 | 封装的画面帧率 / 帧数 / 色彩不合规 | 按正确规格重渲画面 |
| `contract.audio-silent`、`contract.loudness-measure`、`contract.loudness`、`contract.output-frames` | 4 | 混音静音或测不出、成片响度不达标、成片帧数不对 | 回混音阶段留峰值余量 |
| `contract.probe`、`contract.decode` | 4 | 读不出媒体信息、解码失败 | 重新生成文件 |
| `busy.output-locked` | 5 | 同一输出正在被另一次渲染写 | 换 `--out` 或等它结束 |
| `busy.slots-full`、`busy.gpu`、`busy.port` | 5 | 渲染槽位满、共享 GPU 正忙（`--no-wait`）、端口被占 | 排队或换时段 / 端口 |
| `timeout.ready`、`timeout.frame`、`timeout.page` | 124 | 等 READY、单帧 render、打开页面超时 | 看报错；重场景调大 `--ready-timeout` / `--frame-timeout` |
| `timeout.slot`、`timeout.gpu-busy` | 124 | 排队等槽位 / 共享 GPU 超时 | 查卡住的渲染 |
| `failure.render-throw`、`failure.page-error`、`failure.page-crash` | 1 | render 抛错、页面未捕获异常、页面崩溃 | `still.mjs <目录> --frame <帧>` 单独复现 |
| `failure.shader-error`、`failure.context-lost` | 1 | 着色器编译失败、WebGL 上下文丢失 | 修 GLSL；减路数或尺寸，查共享 GPU |
| `failure.asset-missing`、`failure.asset-failed`、`failure.network-blocked` | 1 | 缺本地文件、读文件失败、页面访问外网 | 修路径、准备素材；确需联网加 `--allow-network` |
| `failure.ffmpeg`、`failure.ffmpeg-exited` | 1 | FFmpeg 出错或中途退出 | 看 FFmpeg 自己的报错（磁盘满、参数不支持） |
| `failure.film` | 1 | 旧接口 FilmError 的运行失败 | 看报错 |
| `failure.internal` | 1 | 渲染器自身的问题（命令约定库） | `BEIMING_DEBUG=1` 重跑看堆栈并报告 |
| `signal.sigint`、`signal.sigterm` | 130 / 143 | 收到信号，已清理 | — |

## 10. 镜头缓存、续跑与估算（R4）

- `shots.mjs` 每个镜头存成 `films/<名>/out/cache/shots/<镜头>.<键>.mp4` 与同名 `.json`。键 = sha256（渲染器版本、画幅、帧率、档位、截图与编码参数、URL 参数、film.json 里与画面有关的作品级字段、这个镜头的条目与它的事件、页面实际加载过的本地文件的内容哈希——减去别的镜头独有的模块）。
- 只改镜头 B 的模块只重渲 B；改 B 的 `out` 帧，B 和后面接着的镜头重渲；改共享代码（`main.js`、`engine/`、`node_modules`）或底板贴图，全部重渲（保守、不漏）。约定：镜头模块之间不互相 import，共享的东西放作品级文件。
- `video.mjs --resume`：块放在 `<输出>.parts/`，失败或中断后保留；再跑只补渲没完成的块（参数或源文件变了就清空重渲），成片与一次跑完逐帧相同。`--keep-segments` 成功后也保留。
- `--progress ndjson`：stderr 每行一个 JSON 事件（`{event: "progress", done, total, reused, fps, elapsedSec, etaSec}`、`{event: "log", level, …}`）；命令约定库收尾时另打的「错误／提示」两行是纯文本，解析时跳过不以 `{` 开头的行，结果以 `--json` 信封为准。
- `--plan`：试渲 8 帧、真编一遍，量出单帧渲染 + 截图与编码耗时、每帧字节数，按路数（并行效率按 0.75 估）推算总时长与磁盘；可用空间不够估算的 1.5 倍退出 3。不写任何输出。

## 11. 预览服务

`node engine/render/serve.mjs`（`npm run serve`）取代 `python3 -m http.server` 与 `npx http-server`（它们监听所有网卡，并且会把 `.git` 发出去）。渲染器内部用的是同一个服务器（`lib/server.mjs`）：只听 127.0.0.1；只回答 GET / HEAD；`Host` 必须是 `127.0.0.1` 或 `localhost` 加本端口（挡 DNS 重绑定）；路径里任何一段以 `.` 开头一律 404；越出仓库根（含符号链接逃逸）403，`node_modules` 与登记过的影片目录真实路径例外；不列目录；支持 Range；一律 `Cache-Control: no-store`。

## 12. 环境变量

只作默认值，每个都有同名或对应的选项可覆盖（docs/CLI.md 第 3 节）。完整清单见 [docs/ENVIRONMENT.md](../../docs/ENVIRONMENT.md)。

| 变量 | 作用 |
|---|---|
| `BEIMING_GPU` | `--gpu` 的默认值：required / any / software-ok |
| `BEIMING_ANGLE` | `--angle` 的默认值 |
| `BEIMING_CHROME` | 换浏览器可执行文件（默认锁定的 headless shell） |
| `BEIMING_READY_TIMEOUT`、`BEIMING_FRAME_TIMEOUT` | 等 READY、单帧的上限（秒） |
| `FFMPEG`、`FFPROBE` | FFmpeg / ffprobe 的完整路径（`tools/env/lib/ffmpeg.mjs` 的 `ffmpegBins`） |
| `RENDER_SLOTS`、`BEIMING_SLOT_DIR` | 机器级渲染槽位数与槽位目录（默认系统临时目录下 `beiming-render-slots-<用户>`） |
| `BEIMING_GPU_BUSY_UTIL`、`BEIMING_GPU_MIN_FREE_MB`、`COMFY_URL` | 共享 GPU 守卫的阈值与 ComfyUI 地址 |
| `BEIMING_DEBUG` | 出内部错误时打印堆栈 |
| `NODE` | `mux.sh` 兼容壳用哪个 node |

## 13. 文件

| 文件 | 内容 |
|---|---|
| `page.mjs` | 打开影片页面：静态服务、无头 Chrome、注入 `__RENDER` 与故障监测、等 READY、核对页面约定、逐帧 `renderFrame`、截图。兼容导出 `chromeArgs`、`SOFTWARE_RENDERER`、`defaultAngle`、`takeSize`、`FilmError` 等（`tools/env`、`engine/native/sequence.mjs`、测试在用；`render.compat-exports` 规则守护） |
| `still.mjs`、`video.mjs`、`shots.mjs`、`serve.mjs` | 四个命令 |
| `mux.sh` | 兼容壳：`exec node lib/mux.mjs "$@"`（CRLF 检出时自行去掉 CR 重跑） |
| `args.mjs` | 旧的参数小工具（`--range` 与时刻），still 仍在用 |
| `lib/command.mjs` | 渲染命令外壳：收尾（子进程、浏览器、临时目录、锁、失败记录）、信号、日志与 NDJSON 进度、参数取值、共用选项 |
| `lib/errors.mjs` | `RenderError`（继承命令约定库的 `CliError`）、错误归类、退出码表 |
| `lib/gpu.mjs` | ANGLE 后端与 GPU 策略、浏览器启动、读实际 GPU、软件渲染判定 |
| `lib/server.mjs`、`lib/inject.mjs`、`lib/contract.mjs` | 静态服务；注入页面的 `__RENDER` 与上下文丢失监测；文字报告核对 |
| `lib/chunks.mjs`、`lib/ffmpeg.mjs` | 分块逐帧渲染与拼接；FFmpeg 预检、色彩换算参数、探测 |
| `lib/record.mjs`、`lib/profiles.mjs`、`lib/film.mjs` | 运行记录；交付档位；读 film.json 的渲染相关字段 |
| `lib/lock.mjs`、`lib/slots.mjs`、`lib/deps.mjs` | 输出锁；渲染槽位与共享 GPU 守卫；镜头的静态 import 图 |
| `lib/mux.mjs` | 音画封装（第 6 节） |
| `build.mjs`、`events.mjs`、`native.mjs` | 不归本规格（出片编排与 B 路线） |

## 14. 来源

输出锁（`<out>.lock` 记 pid、过期接管）与渲染槽位（目录即槽位、心跳、过期接管）的做法借鉴 `cases/vendor/lemo-opuscar/core/render/video.mjs`、`core/render/slot.mjs`（固定提交 bebbbe1，MIT），这里是独立实现，没有复制代码。GPU 自检里 WebGL 全屏三角形的写法改写自同一快照的 `styles/urban-sketch/demo/engine.js`，来源头写在 `tools/rtx/gpucheck.mjs`。
