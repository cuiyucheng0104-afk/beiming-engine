# C 路线 · 北冥代码动画风格 · 86 式

写给第一次进仓库的 agent：读完这一页，就能用 C 模版出一部片、从 86 式里挑风格，或者复刻一部历史作品。命令都在仓库根目录执行，路径都相对仓库根。

## 这条路线是什么

- **定义**：C 是"页面型代码动画的方法库，外加可直接出片的 C 模版"。它和 A 共用页面渲染器 `engine/render`，不是第三个 GPU 后端。复刻历史作品是 C 的一个子流程。新片按需求在 A、B、C 三条路线里选（[决定 D01](../../docs/decisions/2026-11-10-industrial-baseline.md)）。
- **一部作品 = 一个网页 + 一份 film.json + 一个声音脚本。** 画面在 `index.html` 里画，多数用 Canvas 2D，也可以用 SVG、DOM/CSS，个别风格用 WebGL。`render(t)` 能画出任意时刻，无头 Chrome 逐帧截图，再由 FFmpeg 编码。C 路线没有统一着色器，每种风格自己实现画法。
- **一条时间线驱动一切。** 片长、速度、拍号和画面打点只写在 `film.json` 里。页面导出的事件表同时驱动拟音、配乐打点和拍点核对，声音与画面靠同一组数字对齐。
- **86 式是索引，不是我们原创的画法。** 它们来自两套第三方 MIT 风格库的固定快照，都只读：Lemo 66 种（`cases/vendor/lemo-opuscar`，lemo-opuscar@bebbbe1），SY 20 种（`cases/vendor/sy-style-100`，sy-style-100@e41dee3）。Lemo 的 66 种我们各做过一部风格实验，历史源码在 `cases/source/`。完整索引见 [STYLES.md](STYLES.md)。
- **三种用法**：
  1. **新片**：用 C 模版直接出片。
  2. **取方法**：在 STYLES.md 里找到一式，读它的 STYLE.md 和示例，然后在 C 模版里重写，或者落到 A、B 路线。
  3. **历史复刻**：把我们做过的一部原样重渲，见 [REPLICATE.md](REPLICATE.md)。

## 最快上手

### 新片

C 模版默认 8 秒、24 fps、1920×1080、有声。竖屏新建时加 `--profile vertical-1080x1920-30`，模版会自动换成竖屏构图。

```bash
npm run setup                                          # 首次运行：装 Node 依赖、无头浏览器，并按锁文件建仓库 .venv
npm run new -- c my-film --title 墨线                   # 复制模版到 films/my-film，生成 film.json v2，并打印下一步
node engine/render/still.mjs films/my-film 0.5 4 7.5 --size 1920x1080 --out films/my-film/out/stills   # 关键帧，给用户定画风（look 闸）
node engine/render/build.mjs films/my-film             # 出片：事件表 → 混音 → 拍点核对 → 逐帧 → 封装（−14 LUFS）→ 海报 → 规格核对
node tools/qa/cli.mjs report films/my-film/out/my-film.mp4 --film films/my-film   # 机器 QA：规格、色彩、响度、静帧、文字、缺字、声画
```

- **Python**：`build.mjs` 读环境变量 `BEIMING_PY`，没设就用 `python3`，而系统自带的 `python3` 多半没装 numpy。先运行 `node tools/env/py.mjs --which` 查看仓库选中的解释器（`npm run setup` 之后通常是 `.venv` 里那个），再把它设给 `BEIMING_PY`：
  - bash：`export BEIMING_PY=.venv/bin/python`
  - PowerShell：`$env:BEIMING_PY = '.venv\Scripts\python.exe'`

  统一出片命令 `npm run film -- build` 建好之后就不用再设。
- **片名字体**：模版自带马善政毛笔楷书的全部简体字（GB 2312 的 6763 个汉字，见 [fonts/](fonts/README.md)），页面只下载片名用到的那几片。片名里有繁体字或生僻字时，渲染日志会报 `[字体缺字]`，QA 的 `texts.glyphs` 不会通过。解决办法：把含这些字的 OFL 字体放进作品的 `fonts/` 目录，登记到 `film.js` 的 `FONTS` 最前面；或者改用简体字。
- **只要声音和拍点核对、不渲画面**：`build.mjs` 加 `--skip-video`。
- **三道闸**（D08）：先过 look（关键帧），再过 animatic（完整的低成本片：C 的短片完整出一遍只要十几秒），都拿到用户认可后才终渲。具体做法见 [routes/README.md](../README.md)「一部作品怎么做」第 4 步。
- **改哪里**：模版每一处示范了哪条工艺，见 [template/README.md](template/README.md)。

### 挑风格

```bash
node tools/c-styles.mjs find brand event typography          # 按题材、名称、画面描述排序给候选（中英文都行）
node tools/c-styles.mjs find poetry --tech canvas2d --made    # 只要 Canvas 2D、我们做过的
```

先按下表定大方向，再用 `find` 和 STYLES.md 收窄。向用户报候选时写清编号、理由、执行面和来源许可。

| 叙事任务 | 信息密度 | 画面要什么 | 先看这些（`lemo/…` 我们做过，`sy/…` 只有方法；执行面、渲染器以 STYLES.md 为准） |
|---|---|---|---|
| 意境、诗意、文化品牌 | 低（一两句字） | 笔触、纸、留白 | `lemo/ink-wash` `lemo/watercolor` `lemo/one-line` `lemo/ukiyoe` `sy/18-ink` |
| 童趣、绘本、睡前故事 | 低–中 | 手绘质感、角色 | `lemo/crayon-book` `lemo/paper-popup` `lemo/papercut-red` |
| 民俗、节庆、传统 | 低–中 | 剪纸、皮影、木刻的材质 | `lemo/shadow-puppet` `lemo/paper-lantern` `lemo/woodcut` |
| 品牌识别、活动开场、口号 | 中（关键词） | 大字排版、图形节奏 | `lemo/swiss-motion` `lemo/pictogram-motion` `lemo/spy-titles` `lemo/art-deco` `sy/15-variety` |
| 讲解、教程、科普 | 高（步骤、标注） | 图解、标注、逐步出现 | `lemo/whiteboard` `lemo/chalkboard` `lemo/iso-infographic` `lemo/isometric-picture-book` `sy/07-sticker` |
| 数据、报告、新闻 | 高（数字、图表） | 图表生长、数字、字幕条 | `lemo/dataviz` `lemo/caption-news` `lemo/news-package` `lemo/transit-map` `sy/17-editorial` |
| 产品发布、硬件、科技 | 中–高 | 产品质感、三维或界面 | `lemo/dark-keynote` `lemo/glass-product` `lemo/teardown` `lemo/hologram-hud` `sy/05-3d` `sy/10-glass` |
| 游戏感、复古、快节奏社媒 | 中 | 像素或扁平、快切 | `lemo/pixel-rpg` `lemo/microgame` `lemo/game-show` `lemo/halftone-dossier` `sy/13-pixel` |
| 纪实、调查、历史 | 中–高 | 素材、档案、标注 | `lemo/visual-investigation` `lemo/newsreel` `lemo/archive-lighttable` `lemo/kino-montage` |
| 体育、强节奏卡点 | 中 | 卡点排版、战术标注 | `lemo/telestrator` `lemo/countdown` `lemo/swiss-motion` `sy/12-synthwave` |
| 悬疑、氛围 | 低 | 光影、空间、声音 | `lemo/backrooms` `lemo/silent-film` |

选定之后，在作品 `film.json` 的 `credits` 里写清这一式的来源与许可（例：`cases/vendor/lemo-opuscar/styles/ink-wash/STYLE.md@bebbbe1`，MIT，LemoLab）。

### 历史复刻

完整步骤、三类案例与实测记录见 [REPLICATE.md](REPLICATE.md)，概要如下：

1. `node tools/c-runtime.mjs setup`：按固定提交建隔离运行时。
2. `node tools/env/py.mjs tools/casebook.py restore <案例> --download --lemo out/runtime/lemo-bebbbe1a`：还原作品。
3. `node tools/c-runtime.mjs build <还原目录>`：重渲。

三套渲染器各认各的环境变量，见 [docs/ENVIRONMENT.md「渲染器 × 环境变量」](../../docs/ENVIRONMENT.md)。

## 一部作品的目录

```
films/<名字>/
  film.json     作品描述 v2：id、title、route "c"、backend、output（交付档位、宽高、帧率、总帧数）、audio、credits、aigc、gates、
                posterFrame；C 路线另有 tempo（节拍段落）、cues（画面打点地址）、cuecheck（拍点核对参数）。dur / fps / size 是兼容镜像
  index.html    一个 <canvas id="c">，加载 main.js
  main.js       页面约定：登记字体 → 只下载用到的分片 → setup → 挂 window.FPS / DUR / render / READY / EV / TIMELINE / TEXTS
  timeline.js   只做换算：film.json → 打点秒数与整数帧、动作时间窗 ACT、声画事件 EV、TIMELINE
  film.js       画面：构图（横竖两套）、字体表 FONTS、setup(canvas)、render(t)、TEXTS(t)、声像
  brush.js paper.js seal.js type.js     模版的画法模块：毛笔笔触与山体的染、宣纸、白文印、字体与缺字检查（换风格时换掉）
  mix.py        声音：读 events.json / timeline.json → out/mix.wav、out/stems/、out/score_onsets.json
  README.md     改哪里、怎么出片、工艺对照
  events.json timeline.json   生成物：build 第 1 步由页面导出
  out/          生成物：video.mp4、mix.wav、stems/、score_onsets.json、<名字>.mp4、poster.jpg、qa/
```

模版里引用引擎用 `../../engine/...`，片名字体用 `../../routes/c-style/fonts/...`，所以作品必须放在 `films/<名字>/` 这一层（页面服务器以仓库根为根）。成片和中间文件只放在 `out/`，不提交。

## 能力清单

每项的写法：模块 → 能做什么 → 仓库里的例子。

**时间与声画（C 路线的骨架）**

- `engine/core/tempo.js` 的 `createTempo` / `createEvents` → 把节拍地址换成秒，算出离整帧、离网格的距离；记录声画事件，带 `cue` 的是画面打点 → `template/timeline.js`
- `engine/render/events.mjs` → 把 `window.EV` 写成 `events.json`、`window.TIMELINE` 写成 `timeline.json`
- `engine/audio/cues.py` → 读这两张表；`Tempo`；`Onsets` 登记"哪个音对哪个打点"；`dispatch` 按事件类型分派拟音；`write` 落盘（PCM 24 位） → `template/mix.py`
- `engine/audio/cuecheck.py` → 算出每个打点离整帧、离 1/grid 拍网格（`cuecheck.grid`：2 是八分，4 是十六分）、离时间线、离登记的音乐起音各差多少毫秒，可以查静默段，超差时退出码非零
- `engine/render/build.mjs` → 一条命令：事件表 → mix.py → 拍点核对 → 逐帧 → 封装 → 海报 → 规格核对
- `tools/qa/cli.mjs` → 机器 QA 门：交付规格、BT.709 色彩、响度、黑场与静帧、文字（越界、安全区、停留时长、对比度、缺字）、声画同步；硬门不过时退出码 4

**共享引擎里 C 直接用到的**

- `engine/render/video.mjs` / `still.mjs` / `page.mjs` → 页面约定、分段并行逐帧、静帧
- `engine/render/mux.sh` → 用 ebur128 测响度，整段线性增益到 −14 LUFS（真峰值 ≤ −1.2 dBTP）；画面已是标注完整的 BT.709 时直接拷贝
- `engine/core/math.js`（缓动、`mulberry` 种子随机、`monotone` 单调插值）、`clock.js`（`hold`：一拍二、一拍三）、`noise.js`（必须传种子）
- `engine/paint/curve.js`（Catmull-Rom 与按弧长取点，模版的毛笔用它）、`ink.js`（带笔压起伏、按拍换形的墨线）、`wash.js`、`path.js`、`light.js`、`strand.js`、`canvas.js`（离屏层，模版用它）
- `engine/overlay/text.js`（`loadFonts`、`fontSpec`、`measure`）、`brush.js`（毛笔逐笔写字）
- `engine/audio/dsp.py`、`synth.py`、`mixing.py`（`loudness_to`）、`meter.py`、`sampler.py`（多采样乐器，需要 `BEIMING_SAMPLES`）

**工具**

- `tools/c-styles.mjs` → 生成与核对 STYLES.md / styles.json；`find` 查候选
- `tools/c-runtime.mjs` → 历史复刻：
  - `setup`：建隔离运行时
  - `status`：查看运行时是否就绪
  - `assets`：装上游的采样乐器等大素材包（sha256 锁在快照里）
  - `build`：重跑还原出的作品
  - `sy`：给 SY 风格做适配页（见 REPLICATE.md）
- `routes/c-style/fonts/fetch.mjs` → 片名字体分片的离线核对（`--check`）与联网重新生成（`--fetch`）

**把一式的方法落到 C 模版 / A / B**（按上游 STYLE.md 的 11 节对照）

| STYLE.md 节 | C 模版里写在哪 | 落到 A（`engine/` 九层） | 落到 B（`engine/native/`） |
|---|---|---|---|
| §2 材质与渲染 | 作品目录里的画法模块（模版的 `brush.js`、`paper.js`），Canvas 2D 合成 | `engine/paint`（ink、wash、path、light）、`engine/look`（纸纹、颗粒、Kuwahara、墨线）、`engine/shade` | `post.ts` 的 `paperPass` / `gradePass`、`surface.ts`、`toon.tsx`；页面画法整段烘成图集用 `sequence.mjs` + `<SequencePlane>` |
| §3 色彩逻辑 | `film.js` 顶部的色板常量（模版：朱红只给印） | `engine/look` 调色与色彩脚本 | `palette.ts`（色板从 palette.json 读） |
| §4 字与字幕 | `film.js` 的 `FONTS` 与题字排法，缺字检查在 `type.js` | `engine/overlay` | `title.tsx`（`TitleCard`、`Caption`） |
| §5 运动质感 | `engine/core/clock.js` 的 `hold`、`math.js` 缓动、`film.json` 节拍 | 同左，加 `engine/stage` | 帧号驱动的组件时间（`layers.tsx` 的 `drift`） |
| §6 镜头语法 | `film.js` 的相机矩阵（模版：绕焦点缓推） | `engine/stage` 的相机与底板视差 | `camera.tsx` 的 `ShotCamera` |
| §7 声音 | `mix.py`（`engine/audio`） | 同左 | 同左，由 prepare 调用声音脚本 |
| §9 媒介陷阱 | 动手前逐条读，模版的修法写在 `brush.js` 注释里 | A 路的默认后期会把任何风格染成北冥味：先关掉后期，证明风格本体成立（[工艺手册 §6](../directing/craft/README.md)） | GLB 不带屏幕后期，墨线要重做 |

**未实现（别当成已有）**

- 字幕导出；配音与逐字时间戳对齐。历史作品各自实现过，没有抽成模块。
- "关键事件集合"式的拍点核对，即 `style-16-swiss-motion` 那种做法：在十六分网格上把一组关键画面事件逐个对音乐，不要求每个打点各登记一个音。`cuecheck.py` 不覆盖这种做法。
- SVG / DOM 作品的模版：只有 Canvas 2D 模版。SVG / DOM 风格按页面约定自己写 `render(t)`。
- 按作品自动子集化字体：C 模版带的是马善政全部简体字；别的字体要自己放进作品的 `fonts/`。

## 契约

- **页面约定**（见 `engine/render/page.mjs` 头注释）：
  - `window.DUR`：片长，单位秒。
  - `window.render(t)`：必须确定。不读 `Date.now()`，不用无种子随机，不依赖上一帧的状态，任意帧都能单独、乱序重渲。
  - `window.READY = true`：资源就绪后置上。
  - `window.FPS`：页面量化用的帧率。模版取 film.json 的帧率，渲染器默认按它出片，`--fps` 与它不一致时直接报错。
  - `window.TEXTS(t)`（可选）：返回 `[{ id, text, box:[x,y,w,h], x0, y0, x1, y1, alpha, font, missing }]`。
- **C 路线附加**：`window.EV = [{t, type, ...}]`，`t` 以秒计、保留 6 位小数，带 `cue` 的是画面打点；`window.TIMELINE = { fps, secs, dur, cues, t, act }`。
- **film.json**（附录 C6 的 v2）：
  - 时间只写在 `output.frameCount`、`output.fps`、`tempo: [{ id, t0, bpm, meter }]`、`cues: { 名字: [段落, 小节, 拍, 拍内分数] }` 里，`timeline.js` 从它们推导一切。
  - `cuecheck: { grid, tolMs, silence, quietDb }`。
  - `credits` 写字体与借鉴方法的来源与许可；`aigc` 写是否含 AI 生成内容（D11）。
  - `dur` / `fps` / `size` 是兼容镜像，`build.mjs` 还在读，改片长或画幅时与 `output` 一起改。
- **mix.py**：在仓库根目录用 `$BEIMING_PY films/<名字>/mix.py` 运行，读 `events.json` / `timeline.json`，写出：
  - `out/mix.wav`（48 kHz 立体声）
  - `out/stems/*.wav`
  - `out/score_onsets.json`（`{onsets: {cue: 秒}, notes: [秒...]}`）
- **整数帧**：打点必须落在整帧上。24 fps 下 90 BPM 一拍 16 帧、120 BPM 一拍 12 帧；30 fps 下 90 BPM 一拍 20 帧。cuecheck 默认容差 0.5 ms。
- **占位符**：模版只用 `{{NAME}}`（目录名）和 `{{TITLE}}`（片名）。
- **历史页面**：Lemo 的页面与我们是同一套约定（`DUR` / `render(t)` / `READY`），只是不声明 `window.FPS`。SY 用 `Reel.scene` 契约：带 `?render=1` 时暴露 `window.__seek(t)` / `__duration` / `__fps`，不能直接交给 `engine/render`。
- **渲染器与环境变量**：

| 渲染器 | 用在 | GPU 后端 | 其它变量 |
|---|---|---|---|
| `engine/render`（still / video / build） | 新片；自包含的历史页面；SY 适配页 | `BEIMING_ANGLE`（macOS 默认 metal；NVIDIA 用 vulkan） | `BEIMING_CHROME`、`BEIMING_READY_TIMEOUT`、`BEIMING_FRAME_TIMEOUT`、`BEIMING_PY`（build 用的 Python） |
| Lemo `core/render`（`c-runtime build` 调用历史 build.sh） | 依赖 `/core/` 的历史作品 | `LEMO_ANGLE` | `PLAYWRIGHT_CHROME`、`RENDER_SLOTS`；`LEMO_OPUSCAR_HOME` 由 c-runtime 设成隔离运行时 |
| SY `render.js`（上游自带） | SY 风格原样渲染 | 默认 SwiftShader 软件渲染；`--hwgpu` 或 `HWGPU=1` 用显卡 | `--nogpu`（纯 2D 页面更快） |

完整的变量表与三平台写法见 [docs/ENVIRONMENT.md](../../docs/ENVIRONMENT.md)。

## 验收

1. `node engine/render/build.mjs films/<名字>` 退出码 0，最后一行"画面 W×H、N 帧（应为 N）、音轨 48000 Hz × 2"与 film.json 一致。
2. 拍点核对打印 `CUECHECK OK`，最大偏差 ≤ 0.5 ms。
3. 渲染日志里没有 `[字体缺字]`、`[页面错误]`。
4. `node tools/qa/cli.mjs report films/<名字>/out/<名字>.mp4 --film films/<名字>` 退出码 0（"机器检查通过"），报告在 `out/qa/`。
5. 看片：用 `still.mjs` 渲 3–5 个打点前后的时刻；完整看一遍带声音的成片。"代理检查通过"不等于用户认可。
6. 确定性：同一 `--workers` 渲两次，`ffmpeg -i out/video.mp4 -f framemd5 -` 逐帧一致；`still.mjs` 乱序渲同一时刻得到同一张图。
7. 改了 C 的工具、索引或模版：跑 `node tools/c-styles.mjs --check`、`node tools/run-tests.mjs --only c-style`、`node tools/repo-check.mjs --only route-c`、`node tools/env/py.mjs tools/casebook.py check`。
8. 状态分开写：已出片、技术检查通过、人工认可是三件事。

## 边界与常见坑

- **不搬第三方代码。** `cases/vendor/` 只读，只用来学方法。我们的历史作品里也有从风格库改写来的文件（见各作品的 `CREDITS`）。确实要沿用代码时，按 [docs/rights/licensing.md「派生代码的来源头」](../../docs/rights/licensing.md) 写来源头（`@provenance`、SPDX、双方版权行），保留原作者版权与 MIT 许可。自查命令：`node tools/compliance/scan.mjs --only provenance`。只借思路、自己重写的，在注释里写一句"做法参考 <上游路径>"，模版的 `brush.js`、`paper.js`、`seal.js` 就是这样写的。
- **历史页面能不能交给 `engine/render`，分三种情况：**
  1. **自包含的 Lemo 页面**（STYLES.md "自包含"列为"是"，共 22 部）：素材齐全时（`restore --download`，有的还要先跑它 build.sh 里的准备步骤）可以直接用 `engine/render` 渲。它们不声明 `window.FPS`，要按原帧率给 `--fps`；原帧率不是 24 fps 时再加 `--any-fps`。
  2. **用了 `/core/` 绝对路径的 Lemo 页面**（共 44 部）：只能在 Lemo 库根目录下服务，用 `c-runtime build` 跑它自己的 build.sh。
  3. **SY 风格**：用的是 `__seek` 契约。用 `c-runtime sy` 生成适配页再交给 `engine/render`，或者只取方法。

  `--source-only` 还原的目录不带图片、字体等二进制素材，**不能拿它判断能不能渲**。
- **不要运行 vendor 自带的 `setup.sh`**（`cases/vendor/lemo-opuscar/plugin/skills/lemo-opuscar/scripts/setup.sh`）。在本仓库里运行它，它会去找或克隆 `~/lemo-opuscar`，对它自己管理的克隆执行 `fetch origin main` 和 `reset --hard`，拿到的是上游最新代码，而不是固定快照 bebbbe1。要运行环境，用 `node tools/c-runtime.mjs setup`。
- **SY 页面用的是本机字体名**（Noto CJK、Inter 等），字体不随库分发，换一台机器字形就会变。
- **逐帧比对时 `--workers` 要相同。** 分段数不同，关键帧的位置就不同，解码后的像素也会不同（画面本身是确定的：`still.mjs` 乱序重渲逐字节一致）。
- **FLOAT 子类型的 WAV 文件头带时间戳**，两次写出的字节不同。比对声音时读样本，不比文件哈希。模版写的是 PCM_24。
- **打点必须在整帧上。** 选每拍正好是整数帧的速度，拍内分数用 1/2、1/4；`timeline.js` 和 cuecheck 都会报出偏差。
- **作品目录必须在仓库内**（`page.mjs` 只服务仓库根），放在 `films/<名字>/`，引擎用 `../../engine/` 引用。
- **执行面不等于画法**：STYLES.md 的执行面是检测源码得到的，列着 WebGL 不代表画面主体画在 WebGL 上。落地前读示例源码确认。

## 参考作品

- **模版**：[template/](template/)。8 秒；三笔山 + 云 + 竖排题字 + 白文朱印；6 个打点；声音全部合成；横竖两套构图。
- **风格索引**：[STYLES.md](STYLES.md) 与 [styles.json](styles.json)。
- **两套库的导演与技术手册**（只读，MIT）：
  - Lemo（LemoLab）：[DIRECTOR.md](../../cases/vendor/lemo-opuscar/DIRECTOR.md)、[TECHNIQUE.md](../../cases/vendor/lemo-opuscar/TECHNIQUE.md)、[MY-STYLES.md](../../cases/vendor/lemo-opuscar/MY-STYLES.md)
  - SY（肖雄 XIAOXIONG）：[README.md](../../cases/vendor/sy-style-100/README.md)、[SKILL.md](../../cases/vendor/sy-style-100/SKILL.md)
- **我们的 66 部风格实验与 PPT 片**：[cases/README.md](../../cases/README.md)、[cases/INDEX.md](../../cases/INDEX.md)；两库源码对比见 [docs/cases/comparison.md](../../docs/cases/comparison.md)。
- **导演与工艺规范**：[routes/directing/](../directing/README.md)（导演十步、画面设计、五章工艺）。
- **C 的公共件**（tempo.js、cues.py、cuecheck.py、events.mjs、build.mjs）抽自我们 66 部风格实验的共同写法。抽取时做过改动前后的逐字节比对，记录在提交 d5b21ac 的说明里，之后没有重跑。
