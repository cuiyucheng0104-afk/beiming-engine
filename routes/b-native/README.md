# B · 北冥原生 · BNE 路线手册

## 这条路线是什么

**北冥原生 · BNE**（Beiming Native Edition，北冥原生版）是本仓库的通用原生渲染路线，定位 **render anything**：作品写成一个 TSX 编排文件，由外部原生 GPU 运行时逐帧、确定性地渲出来；程序化造型、外部模型、绘画底板、视频、A / C 路线的页面作品都能进同一个原生场景，不必套北冥画风。**基于 `RAEA` 原生运行时（FSL-1.1-ALv2）**：BNE 是我方路线名，不是自研运行时；运行时与 SDK 归上游所有，不随仓库分发，本路线只作内部制作层（自制影片、向客户交付成片，决定 D03）。许可边界见下文「边界与常见坑」与 [docs/rights/fsl-boundary.md](../../docs/rights/fsl-boundary.md)。

- **执行面**：React/TypeScript 编排 → Rust 引擎（三维走 Bevy，页面层走原生排版）→ GPU 合成 → 编码。画面只由帧号决定（`useCurrentFrame()`），同一帧重渲在可复现误差内一致。
- **仓库里的部分**：`engine/native/`（TSX 组件库 + 准备阶段工具 + 资产桥 + 交付）、`engine/render/native.mjs`（唯一出片入口）、`routes/b-native/template/`（最小作品模版）、`routes/b-native/recipes/`（四类画面配方样张）、`examples/raea/`（《北冥》10 秒例片；目录名是上游项目名，内部沿用）。
- **运行时版本锁**：`engine/native/runtime.lock.json` 记版本 `0.1.0-canary.2`、上游源码提交、许可、三平台归档 sha256 与可执行文件 sha256；`RAEA_BIN` 指向它的可执行文件。**作品必须在 git 工作树里**：运行时按工作树认「项目目录」，`git archive` 导出的目录会被拒绝（REFUSED「outside raea's home and the project's folder」），入口预检时就以 exit 3 说明。
- **什么时候选它**：要原生 GPU、要把多种来源的画面放进一个三维空间、要骨骼 / morph 动画模型、或作品不依赖 A 路的屏幕墨线与 Kuwahara 笔触。要逐帧延续《北冥》原画风选 A。

## 最快上手

在仓库根目录（macOS / Linux 用 export，Windows PowerShell 用 `$env:RAEA_BIN = '…'`；不需要 Git Bash）：

```sh
npm run setup                                         # node 依赖、无头 Chromium、仓库内 .venv（声音脚本的 numpy / scipy / soundfile / numba）
node engine/native/runtime.mjs fetch --accept-license # 读过上游许可后获取运行时、校验哈希，打印 RAEA_BIN 应设的值
export RAEA_BIN=/absolute/path/to/raea/bin/raea

node tools/new-film.mjs b my-film --title 我的片子     # 从 routes/b-native/template 复制到 films/my-film/（名字只用小写 ASCII）
node engine/native/prepare.mjs films/my-film           # 素材进 media/：底板（含软边）、道具 GLB（Idle 动作）、声音，写 prepared.json
node engine/render/native.mjs films/my-film --check-only    # 预检：运行时版本与哈希、git 工作树、FFmpeg、素材哈希；不启动 GPU
node engine/render/native.mjs films/my-film --at 0,30,107   # 草图帧 → films/my-film/out/<run-id>/stills/f<帧号>.png
node engine/render/native.mjs films/my-film                 # 出片 + 成片检查 + 机器 QA → films/my-film/out/<run-id>/
node tools/run-tests.mjs --only native                 # 版式逐帧核对与工具单测（不启动 GPU）
```

每个命令都用仓库的命令约定（[docs/CLI.md](../../docs/CLI.md)）：`--help` 只打印用法、无副作用；`--json` 时 stdout 只输出一个信封 `{schemaVersion, ok, exitCode, command, error:{code,message,hint}, outputs, runJson, warnings, data}`，日志走 stderr；未知参数 exit 2。退出码：0 成功 · 1 渲染 / 编码失败（含运行时日志里的 ERROR）· 2 用法 · 3 运行时 / 工具 / 素材缺失或不合格（含不在 git 工作树里）· 4 契约、交付规格、成片检查或机器 QA 硬门不通过 · 5 共享 GPU 忙 · 124 超时 · 130 / 143 中断（已清理）。出错时 stderr 写「错误[码]：原因」与「提示：下一步」两行；出片入口在运行目录建好之后的失败（QA 门、成片检查、编码、中断）信封里照样有 `runJson` 和已产出的文件（`outputs` 按 `kind` 取：master、web、run-json、raea-check、qa-report、contact-sheet、player、log）。超时一律用选项给：`native.mjs --timeout <秒>`（原生渲染与母版封装各自的上限，默认 120 + 2 × 帧数）、`prepare.mjs --timeout <秒>`（资产桥整批 / 声音脚本，默认 900 / 600）与 `--frame-timeout <秒>`（页面序列帧每帧，默认 30），非数字或小于 1 是用法错误。Python 走仓库统一的查找（`.venv` → `BEIMING_PYTHON` / `PYTHON`），FFmpeg 认 `FFMPEG` / `FFPROBE`。

## 一部作品的目录

```text
films/<名字>/
  film.json      唯一配置源：片长、帧率、尺寸、events（帧号）、aigc、credits、native 段（素材清单）
  film.tsx       编排；只能从作品目录之外 import engine/native/index.ts
  layout.js      机位、主体、片名框、面片（纯函数；tests/native 逐帧核对）
  motion.js      道具动作公式（纯函数，prop.js 与 film.tsx 共用）
  palette.json   色板（按名字取色）     prop.js   造型（浏览器端 three.js，准备阶段导出 GLB）     sound.py   声音
  media/         prepare 生成，不提交   out/<run-id>/  渲染产物，不提交；out/latest 是最近一次成功的 run-id
```

`out/<run-id>/`（run-id = `YYYYMMDD-HHMMSS-<短提交>[-dirty]`）：`master.mp4`（原生视频轨**逐位复制** + AAC 48 kHz，母版不二次有损）、`web.mp4`（交付网页版：H.264 High、yuv420p、BT.709 有限范围且四个色彩标签写全、AAC 48 kHz 立体声、−14 LUFS ±1、真峰值 ≤ −1 dBTP；交付档位按 film.json 或尺寸帧率推断，见 `engine/native/delivery.mjs`）、`check.json`（运行时自带的成片检查：字幕裁切、安全区、对比度、冻帧、响度；P0 / P1 即 exit 4）、`qa/report.json` 与 `qa/report.md`（仓库的机器 QA 门 `tools/qa`：规格、色彩、响度、画面、声画、底板；硬门不通过 exit 4）、`run.json`、`contact.jpg`、`player.html`、`framemd5.txt`、`render.log`。

`run.json`（附录 C8）：`tools.raea` 是运行时版本，`runtime` 记平台、可执行文件实测与锁定 sha256；`actualDevice`（显卡）、`actualGraphicsBackend`（运行时日志里认出的 metal / vulkan / dx12）、`softwareFallback`、`actualEncoder`（母版的原生编码器与网页版的 libx264）；`inputs` 记作品每个源文件（含 film.tsx）与每个素材的 sha256、准备阶段的工具版本；`output` 是交付件的路径、哈希、尺寸、帧数、像素格式与色彩；`frameHashes`、`audio`（实测响度与增益）、`aigc`、`timing`。`status`：机器 QA 通过记 `passed`（`technicalAcceptance` 同时记 passed 并附报告路径），`--skip-qa` 或草图帧记 `rendered`，失败记 `failed`；`creativeAcceptance` 始终是 not-reviewed——技术通过不等于用户认可（D08）。末尾用 `engine/production/project.js` 的校验器自检，结论在 `selfCheck`。

## 能力清单

| 输入（render anything） | 做法 | 状态 |
|---|---|---|
| 浏览器里能用 engine 搭的 three.js 对象 | `models` 写 `module / export / args`：资产桥在无头 Chromium 里导出 GLB（材质转 PBR，源材质有名字就沿用），`clip` 逐帧调 `pose(t)` 采样动作 | 已实测：渡船、模版浮标（Idle） |
| GPU 着色器里的程序形变 | 写配方 `recipe`：`bridge/rig.mjs` 把弯曲波换成骨骼、`geometry.mjs` 合并实例 / morph、`bake.mjs` 烘反照率 | 已实测：鲲（回归基准 `examples/raea/expected-assets.json`） |
| 外部 GLB / glTF | `models` 写 `from`；`.glb` 复制后做结构检查 | `.glb` 已实测；`.gltf` 未实测 |
| 图片 | `images`（`edge` 有机软边 / 圆形收边，`crop` 裁一块、`flip` 翻转）；`<Backdrop>` 二维底板、`<PlateCard>` 三维面片 | 已实测（`crop` / `flip` 只有单测） |
| A / C 路线的页面作品 | `sequences` 写 `page`：逐帧渲成图集（`<SequencePlane>`）或透明逐帧 PNG（`<FrameSequence>`） | 已实测：《北冥》页面 → 面片；毛笔片名页面 → 透明叠层 |
| 视频 / 图片序列 | `sequences` 写 `video` / `frames` | 视频已实测；图片目录未单独实测 |

组件库 `engine/native/index.ts`：`math.ts`（re-export `engine/core` 的确定性数学与一拍二 / 一拍三时钟）、`palette.ts`、`camera.tsx`（`ShotCamera` 分段机位）、`view.js`（投影 / 反投影、`cardInView` 按屏幕框摆卡片、`skyShift` 天空跟镜头、`headingYaw` / `behind` 载具朝向与尾迹）、`layers.tsx`（`Backdrop`、`PlateCard`、`SequencePlane`、`FrameSequence`、`PaperOverlay`、`Vignette`、`Glow`）、`toon.tsx`（`ToonModel` 分材质卡通覆盖、`ToonBox`）、`title.tsx`（`TitleReveal` 逐字落定、`Caption` 字幕）、`post.ts`（`gradePass`、`paperPass`）、`surface.ts`（`waterWesl`、`ribbonWesl`）。Node 侧：`prepare.mjs`、`sequence.mjs`、`edge.mjs`、`film.mjs`、`delivery.mjs`、`runtime.mjs`、`cli.mjs`、`bridge/*.mjs`。

**未实现**（不要报告成已有）：A 路的屏幕 ID 墨线、Kuwahara、三色双羽化卡通材质的原生移植；`gradePass` 与 A 路同参数的逐像素等价；人物表演；视频直接作动态纹理；超过 8192 像素的图集；Windows / 5090 上用新入口重跑。

## 契约

- **film.json**：v1 `{ route: "b", title, dur, fps, size: [宽, 高], events?, aigc?, credits?, native }`，或 v2（`output.{profile,width,height,fps,frameCount}`，见加固计划附录 C6）。帧数 = `round(dur × fps)`；尺寸是 ≥ 16 的偶数。交付档位取 `output.profile`，否则按尺寸与帧率推断，对不上用自定义档并提示。v2 里 `dur` / `fps` / `size` 是 v1 兼容镜像，必须与 `output` 相同——**改画幅、帧率、时长时两处一起改**（换画幅时 `output.profile` 也换成匹配的档位，或删掉它与 `deliveries` 落到自定义档）；不一致 exit 4，不会悄悄按其中一处渲。
- **film.tsx**：`registerRoot` 一个 `Composition`，宽高帧率帧数从 film.json 读（模版直接 `import film from './film.json'`），`id` 只用字母、数字、连字符。画面只读 `useCurrentFrame()`；不用 `useState`、计时器、`Date.now`、无种子随机。
- **import**：`film.tsx` 用 `import … from '../../engine/native/index.ts'` 取通用件（作品放在仓库内两级深的目录）；作品目录里的其他模块只能 import 作品目录里的文件；组件库不 import three 或 Node 模块。
- **素材路径**：`staticFile('x')` = 作品 `media/x`；`ShaderMesh` 的纹理写 `'media/x.png'`。渲染入口按 film.json 与源码里的字面量逐个检查素材，并核对 `media/prepared.json` 的 sha256（prepare 之后被改过 → exit 4）。
- **资产桥**：`export(args)` 返回 `Object3D` 或 `{ group | scene | root | object, length?, pose?(t) }`；动作只在 `pose(t)` 改子节点；`loop` 时最后一帧用 `pose(0)`。先写 `.part`，回读与结构检查都过才换名。
- **序列帧**：图集 `{ grid, frames, fps, cell, source, sha256 }`；逐帧目录 `{ output: "frames", frames, fps, size, source }`。第 n 帧 = `floor((t − start) · fps)`。
- **声音**：`audio.script` 由 prepare 调用，环境变量 `BNE_OUT`、`BNE_DUR`、`BNE_FILM`，`PYTHONPATH` = 仓库根；脚本自己母带到 −14 LUFS、真峰值限 −1.5 dBTP，渲染入口只做线性增益核对（峰值与响度之比太大 → exit 4）。没有 `audio` 时母版无声、网页版补静音立体声。

`film.json` 的 native 段（路径相对作品目录，`to` 是 `media/` 下的名字）：

```json
{
  "entry": "film.tsx",
  "images":    [{ "to": "mist.png", "from": "../../assets/plates/mist_low.png", "edge": { "left": 0.16, "right": 0.16, "jitter": 0.7, "lobes": 3 } }],
  "models":    [{ "to": "prop.glb", "module": "prop.js", "export": "createProp", "length": 1.6,
                  "clip": { "name": "Idle", "pose": "pose", "duration": 3, "fps": 24 }, "validate": { "animated": true, "clip": "Idle" } },
                { "to": "boat.glb", "from": "../../examples/raea/media/ferry.glb" }],
  "sequences": [{ "to": "title", "page": "title", "until": 1.0, "output": "frames", "alpha": true }],
  "audio":     { "script": "sound.py", "out": "mix.wav" }
}
```

## 画面工艺

技术通过只是下限。照 [routes/directing](../directing/README.md) 的规范做，模版和例片已经把下面几条落到代码里（改它们时保持住）：

1. **构图与读字**：主体在三分线，片名 / 字幕在安全区（左右各 ≥ 5% 画宽、上下各 ≥ 120/1080 画高）、不压主体、与背后像素对比 ≥ 3:1。机位与版式写进 `layout.js`，`tests/native/layout.test.mjs` 每一帧投影核对；`raea check` 再核对成片里的文字。
2. **片名有动画**：`TitleReveal` 逐字落定（模版）；要书法笔顺就用 A 路页面经 `sequences` 渲透明逐帧 PNG、`<FrameSequence>` 叠上（例片的毛笔「北冥」）。片名起笔 / 落定的帧号写在 film.json `events`，声音脚本读同一个帧号。
3. **纸纹不钉在屏幕上**：`<PaperOverlay>` 页面层整幅 multiply，一拍二换一张「纸」，按 H/1040 缩放；不要用只盖三维层、逐像素固定的颗粒冒充纸纹。
4. **雾与云片不露截断边**：卡片按镜头摆（`cardInView`：先定屏幕框和深度再换算世界坐标，与画面平行），被画幅截断的竖边每一帧都在画外；上下截断边若进画，`images[].edge` 给那条边烘有机软边（安全网，不是借口）。确实要在画内结束的远景云堤（原图两端是沿竖线的线性淡出），把端头烘成**圆形收边**：`edge` 宽 ≥ 0.15、`round` ≥ 0.5，淡出线弯成圆弧并带低频起伏（相当于 A 路 `cropPlate` 的椭圆软边），QA 门的找边检测对处理后的图报「没有直线边」；收边的半透明区不要压在后面的实物（楼、船）上，否则它们会「透」出来——例片把云堤挪到近景云后面。不开距离雾（见「边界与常见坑」），空气感靠画出来的雾层和远层冷色；三维物体的空气透视还没做（QA-B-002，未关闭）。
5. **天空像在无穷远**：页面层天空加 `skyShift(t)`，随摇 / 仰反向移动；铺法按原图等比、按镜头运动范围留出血。
6. **一个时钟**：角色的位置、姿态、动作片段同一个量化时钟（例片鲲一拍三）；摄影、船、水面按 24 帧。载具朝速度方向，尾迹与船同一个偏航。
7. **发光体**：灯的材质单独一层卡通覆盖并保留自发光，灯晕用页面层 `<Glow>`（投影锚点）——layered 画布里三维 Bloom 的光晕在天空前看不到。

**画面配方**（每类给灯光、色板、材质、后期顺序；四类的可渲实现在 [recipes/](recipes/README.md)，样张用 `node engine/render/native.mjs routes/b-native/recipes --at 12,36,60,84` 现渲，不入库）：

| 配方 | 灯光 | 色板 | 材质 | 后期顺序 | 样张 |
|---|---|---|---|---|---|
| Toon 三渲二（模版） | 一盏暖主光从天空底板太阳一侧来 + 偏冷环境光 | 暗部偏冷紫，主体明度与天空拉开 ≥ 0.15（OKLab L） | `ToonModel` steps 3、shadow_color、rim（暖）、outline 1.6 px 墨色；发光件单独覆盖 | 三维 → 灯晕 → 纸纹 → 暗角 → 片名 | 模版 `--at 0,30,107`；recipes `--at 12` |
| 绘画卡片合成（例片） | 同上，阴影级联只给近处 | 远层冷、近层暖；底板向共享色板对齐 | `PlateCard` 直通 alpha、截断边软边、`cardInView` 按屏幕框摆；水面 `waterWesl`、尾迹 `ribbonWesl` | 天空（skyShift）→ 卡片 → 三维 → 纸纹 → 暗角 → 毛笔片名 | 例片 `--at 0,111,239`；recipes `--at 60` |
| PBR 风格化 | 三点光（暖主光、冷补光、背后轮廓光）；AgX 色调映射 | 低饱和中间调 + 一个强调色 | 不覆盖颜色，按材质名给粗糙度 / 金属度 / 清漆（`StandardMaterial material=…`） | 三维 → `gradePass` → 灯晕 → 暗角 | recipes `--at 36` |
| 水墨线描 | 顶光平光，steps 2 | 纸白、淡墨、一条朱砂 | 按材质名逐个给色（全局覆盖不换色）、outline 2.8 px、灯关掉自发光 | 三维 → 纸纹（opacity 0.22）、不加暗角 | recipes `--at 84` |

## 验收

| 项 | 命令 | 判据 / 2026-11-10 macOS（Apple M5 Pro、Metal、VideoToolbox）实测 |
|---|---|---|
| 工具与版式 | `node tools/run-tests.mjs --only native` | 全过（97 项，约 5–10 秒：资产桥重导出与基准逐字节比对、R01 睑缘墨线断言、逐帧版式、云堤收边的找边回归、预检拒绝路径、GPU 守卫与成片检查两道闸、失败信封、命令约定、仓库规则） |
| 仓库规则 | `node tools/repo-check.mjs --only route-b` | 八条 0 错误 0 提示（三平台可执行文件哈希都已锁定；Windows / Linux 的哈希由官方归档解包计算，尚未在该平台运行验收） |
| 中断与清理 | 出片中途 Ctrl+C | exit 130，原生进程被整组终止，`.part` 删除，run.json 记 interrupted |
| 缺运行时 | `node engine/render/native.mjs films/<名字> --check-only`（不设 `RAEA_BIN`） | exit 3，stderr 两行：`错误[env.no-runtime]：…` 与 `提示：…runtime.mjs fetch --accept-license` |
| 预检拒绝 | `tests/native/preflight.test.mjs`（假运行时） | 不在 git 工作树 exit 3；素材被改 exit 4；素材清单改了没重新准备 exit 4（提示 `--only <类>`） |
| 两道闸 | `tests/native/gates.test.mjs`（假运行时 + FFmpeg 造片） | ComfyUI 队列忙时草图帧也 exit 5、不建运行目录；成片检查 P1 → exit 4、`checks.raeaCheck.ok = false`；失败信封带 `runJson` 与成片 |
| 模版出片 | `new-film b` → `prepare` → `native.mjs` | exit 0：1920×1080 / 24fps / 108 帧，web-1080p24，−14.1 LUFS / −1.5 dBTP，`raea check` 文字全过（含对比度 ≥ 3:1），机器 QA 通过（29 过 2 提示），run.json `status: passed`、`selfCheck.ok` |
| 例片出片 | `prepare examples/raea` → `native.mjs examples/raea` | 1920×1040 / 240 帧，beiming-1040p24，−14.0 LUFS / −3.2 dBTP，`raea check` 无问题；机器 QA 唯一的硬门是 `known-issues.open`（台账里 QA-B-001 仍是 open，待 QA 包核对关闭；QA-B-002 未修）→ 目前 exit 4，这是如实的结论 |
| 可复现性 | 同一提交渲两次，比对两次的 `framemd5.txt` | 模版与例片的母版解码后逐帧相同；网页版视频与音频码流逐字节相同（只有 comment 里的运行 id 不同）；原生 VideoToolbox 码流两次不同。（历史 5090 记录：197/240 相同、最大差 6，所以阈值仍写「最大差 ≤ 8、PSNR ≥ 70 dB」） |

看片规则：技术检查通过 ≠ 画面通过。至少看 `contact.jpg` 与整片，切点邻帧、片名、截断边、黑场与静帧；原生速度与画风质量分别评价，不把 A 路的 WebGL 数据当原生证据。

## 边界与常见坑

- **FSL 使用边界（决定 D03，全文见 [docs/rights/fsl-boundary.md](../../docs/rights/fsl-boundary.md)）**：上游运行时以 FSL-1.1-ALv2 发布（每个版本发布满两年转 Apache-2.0；canary.2 于 2028-10-31 转换）。本仓库**只把它用作内部制作层**——自制影片、向客户交付成片。agent 照这五条做：
  1. RAEA 是第三方 FSL 软件：只在本机或工作站上调用，不提交、不打包、不随成片给出（`runtime.mjs fetch` 必须显式 `--accept-license`，装在仓库外的缓存目录）。
  2. `engine/native/` 只写调用 RAEA 公开接口的自有代码；不复制 SDK 或运行时源码，不加 Rust / WESL 文件（读上游文档与类型定义来写调用代码可以；着色器写成我方 `.ts` 里的字符串）。
  3. 交付物只有影片；有人要「把渲染做成服务」「把 BNE 给别人用」，停下来问用户。商业化对外提供之前，先取得上游书面许可或法律意见。
  4. 对外只用「北冥原生 · BNE」，并带署名句「北冥原生 · BNE 基于第三方原生运行时 RAEA（shinyobjectz/raea，FSL-1.1-ALv2，版权人 Shane Murphy）。运行时不随本仓库分发，需单独取得并遵守其许可。」；不写「自研原生引擎」。
  5. 升级运行时版本：同一提交里更新 `engine/native/runtime.lock.json`、`engine/render/native.mjs` 的 `VALIDATED`、fsl-boundary.md 与 THIRD-PARTY.md 的版本、发布日和 Apache-2.0 转换日期，并重跑本手册「验收」。
- **作品必须在 git 工作树里**：运行时按 git 工作树认「项目目录」，在 `git archive` 导出的目录或仓库外的拷贝里渲染会 REFUSED「outside raea's home and the project's folder」（P07 实测）；入口预检时就 exit 3 并说明。作品放仓库检出的 `films/<名字>/`，CI 或临时检出用 `git clone` / `git worktree`，不用 `git archive`。
- **辅助模块不能 import 作品目录之外**：运行时把作品模块复制到临时目录打包，只有入口 `film.tsx` 的外部相对 import 被改写；`layout.js` 之类再 import `../../engine/…` 会 REFUSED。辅助模块写成纯函数，需要的引擎函数由 `film.tsx` 传进去；也不能 import three。
- **GLB 不带屏幕后期**：墨线、Kuwahara、视角相关卡通光都不在模型里，原生端用 `ToonMaterial` 重新给光；覆盖时保留 `baseColorTexture` 与 `COLOR_0`（带贴图 / 顶点色的部位不写 `base_color`）。
- **同名实体跨帧沿用**：运行时按 `name` 跨帧沿用实体；同一个模型在不同镜头换材质覆盖时，每个镜头给不同的 `name`，否则后面镜头的覆盖不生效。全局卡通覆盖只换明暗处理、不换各材质自己的颜色，换色要按材质名逐个给（`parts`）。
- **透明面片别开距离雾**：canary 的预乘雾会露出面片矩形边（图片卡的透明区被染成雾色，整张卡变成一块雾色矩形，实测盖住页面层天空）。换成 `Mesh3d` + `StandardMaterial`（`unlit`、`alpha_mode="Blend"`、`fog_enabled={false}`）的卡片不吃雾、三维物体照常吃雾，但同一张雾带比 `ImagePlane` 更实更饱和（同帧 PSNR 27.5 dB），要改卡片实现就得重调全部卡片的不透明度——这是 QA-B-002 的下一步，还没做。**Bloom 在 layered 画布里只落在三维像素上**；**页面层「径向渐变 + mix-blend-mode」不出图**（纯色块加 blend 可以）。
- **字体**：外部字体在 Windows 中文路径下曾加载失败；片名用 A 路页面渲成 PNG（例片），或内嵌 data URL。模版字幕用系统字体，换机器字形可能不同。
- **Composition id** 只能是字母、数字、连字符（模版固定 `id="film"`）；作品目录名可以是中文。
- **图集上限** 8192 像素且整张进显存；长序列用 `output: "frames"`。
- **资产桥用软件 GL**（SwiftShader）：只做转换与烘焙，不占独显；换成硬件 GL 可能改变贴图字节。
- **原生 GPU 与编码器分开记录**（run.json 自动记）：macOS 是 VideoToolbox；Windows canary 默认 OpenH264 软件编码，不能写成 NVENC。共享工作站先查队列（入口自动查，`--require-idle-check` 查不到也拒绝）。
- **换运行时版本**：入口只放行锁文件里的版本与哈希；新版本先重跑本手册「验收」，再用 `BNE_ALLOW_VERSION` 临时放行，补齐锁文件后再去掉。各平台可执行文件哈希不必在该平台上算：`node engine/native/runtime.mjs fetch --accept-license --platform <平台> --from <官方归档> --dest <新目录> --json` 的 `data.binarySha256` 就是。
- **`fetch --dest` 只认新目录**：给的目录已有内容、又不是上次 fetch 装的（没有 `.beiming-runtime.json` 标记）时拒绝覆盖（exit 2；不给 `--dest` 时用的默认缓存目录归工具管理，照常替换）；先解包到旁边的临时目录、哈希通过才替换，失败时旧安装原样不动。
- **对外命名**：对外只叫「北冥原生 · BNE」；`raea` 只留在 `examples/raea`、`raea:*` 命令、`RAEA_BIN`、`import … from 'raea'` 与许可署名里。
- **AI 生成内容标识（决定 D11）**：用了 AI 生成底板的作品，film.json 写 `aigc: { contains: true, note }`，渲染入口在 mp4 comment 与 `player.html` 写「含 AI 生成画面」。

## 参考作品

- `routes/b-native/template/`：最小作品——程序化浮标（Idle）+ 天空底板 + 前后两层云海（软边、截断端在画外）+ 灯晕 + 纸纹 + 逐字片名 + 声音，新作品从这里复制。
- `examples/raea/`：《北冥》10 秒例片——三个镜头、骨骼鲲（配方导出）、渡船（通用导出、朝速度方向）、绘画水面与尾迹着色器、按镜头摆的云、天空跟镜头、毛笔片名、事件表驱动的声音；资产桥细节见 `examples/raea/ASSET-BRIDGE.md`。
- 深入资料：[原生运行时模块详解](../../docs/routes/raea-native.md)、[源码对照、实验记录与集成设计](../../docs/raea/README.md)。运行时自带写作指南：`$(dirname $RAEA_BIN)/../share/raea/skills/raea/SKILL.md`。
