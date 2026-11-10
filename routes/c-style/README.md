# C 路线 · 北冥代码动画风格 · 86 式

给第一次进仓库的 agent：读完这一页就能用 C 模版出一部片、从 86 式里挑风格，或者复刻一部历史作品。命令都在仓库根目录执行，路径都是仓库相对路径。

## 这条路线是什么

- **定义**：C 是"页面型代码动画的方法库，外加可直接出片的 C 模版"。它和 A 共用页面渲染器 `engine/render`，不是第三个 GPU 后端；复刻历史作品是 C 的一个子流程。新片按需求在 A、B、C 三条里选（[决定 D01](../../docs/decisions/2026-11-10-industrial-baseline.md)）。
- **一部作品 = 一个网页 + 一份 film.json + 一个声音脚本。** 画面在 `index.html` 里用 Canvas 2D（也可以 SVG、DOM/CSS，个别风格用 WebGL）画，`render(t)` 能画出任意时刻；无头 Chrome 逐帧截图，FFmpeg 编码。没有统一着色器，每种风格自己实现画法。
- **一条时间线驱动一切。** 速度、拍号和画面打点只写在 `film.json`；页面导出的事件表同时驱动拟音、配乐打点和拍点核对，声画对齐靠同一组数字。
- **86 式是索引，不是我们原创的画法。** 它们来自两套第三方 MIT 风格库的固定快照：Lemo 66 种（`cases/vendor/lemo-opuscar`，lemo-opuscar@bebbbe1）＋ SY 20 种（`cases/vendor/sy-style-100`，sy-style-100@e41dee3），只读。66 种 Lemo 风格我们各做过一部风格实验，历史源码在 `cases/source/`。索引见 [STYLES.md](STYLES.md)。
- **三种用法**：① **新片**——用 C 模版直接出片；② **取方法**——在 STYLES.md 里找到一式，读它的 STYLE.md 和示例，在 C 模版里重写，或落到 A / B；③ **历史复刻**——把我们做过的一部原样重渲（[REPLICATE.md](REPLICATE.md)）。

## 最快上手

### 新片

用 C 模版（8 秒、24 fps、1920×1080、有声）：

```bash
npm run setup                                   # 首次：装 playwright-core 与 Chrome headless shell
node tools/new-film.mjs c my-film --title 北冥   # 复制 routes/c-style/template → films/my-film（不写 --title 就用名字当片名）
BEIMING_PY=/path/to/python node engine/render/build.mjs films/my-film
#   → films/my-film/out/my-film.mp4（−14 LUFS）、out/poster.jpg；最后一行核对帧数、尺寸、音轨
node engine/render/still.mjs films/my-film 0.25 1.33 2.67 6 7.5 --size 1920x1080 --out films/my-film/out/stills
```

- `BEIMING_PY` 指向装了 numpy、scipy、numba、soundfile 的 Python，不设就用 `python3`。只要声音和拍点核对、不渲画面：加 `--skip-video`。
- 仓库自带的毛笔字体子集只有"北冥"两个字：换别的片名，渲染日志会报 `[字体缺字]`，先按模版 README 的"字体"一节做子集，否则不能交付。
- 模版改哪里、示范了哪条工艺，见 [template/README.md](template/README.md)。

### 挑风格

```bash
node tools/c-styles.mjs find brand event typography          # 按题材、名称、画面描述排序给候选（中英文都行）
node tools/c-styles.mjs find poetry --tech canvas2d --made    # 只要 Canvas 2D、我们做过的
```

先按下表定大方向，再用 `find` 和 STYLES.md 收窄；给用户报候选时写清编号、理由、执行面和来源许可。

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

### 历史复刻

完整步骤、三类案例与实测见 [REPLICATE.md](REPLICATE.md)；概要：`node tools/c-runtime.mjs setup` 按固定提交建隔离运行时 → `python3 tools/casebook.py restore <案例> --download --lemo out/runtime/lemo-bebbbe1a` → `node tools/c-runtime.mjs build <还原目录>`。

## 一部作品的目录

```
films/<名字>/
  film.json     route "c"、title、dur、fps、size、poster（秒）、tempo（节拍段落）、cues（画面打点地址）、cuecheck（拍点核对参数）
  index.html    一个 <canvas id="c">，加载 main.js
  main.js       页面约定：加载字体与缺字探针 → setup → 挂 window.FPS / DUR / render / READY / EV / TIMELINE / TEXTS
  timeline.js   只做换算：film.json → 打点秒数与整数帧、动作时间窗 ACT、声画事件 EV、TIMELINE
  film.js       画面：构图（横竖两套）、setup(canvas)、render(t)、TEXTS(t)、声像
  brush.js paper.js seal.js type.js     模版的画法模块：毛笔笔触与山体的染、宣纸、白文印、缺字检查（换风格时换掉）
  mix.py        声音：读 events.json / timeline.json → out/mix.wav、out/stems/、out/score_onsets.json
  README.md     改哪里、怎么出片、工艺对照
  events.json timeline.json   生成物：build 第 1 步由页面导出
  out/          生成物：video.mp4、mix.wav、stems/、score_onsets.json、<名字>.mp4、poster.jpg
```

模版里引用引擎用 `../../engine/...`、字体用 `../../fonts/...`，所以作品必须放在 `films/<名字>/` 这一层（页面服务器以仓库根为根）。成片和中间文件只放 `out/`，不提交。

## 能力清单

每项：模块 → 能做什么 → 仓库里的例子。

**时间与声画（C 路线的骨架）**

- `engine/core/tempo.js` `createTempo` / `createEvents` → 节拍地址换成秒、离整帧 / 离网格的距离；记声画事件，带 `cue` 的是画面打点 → `template/timeline.js`
- `engine/render/events.mjs` → 把 `window.EV` 写成 `events.json`、`window.TIMELINE` 写成 `timeline.json`
- `engine/audio/cues.py` → 读两张表、`Tempo`、`Onsets` 登记"哪个音对哪个打点"、`dispatch` 按事件类型分派拟音、`write` 落盘 → `template/mix.py`
- `engine/audio/cuecheck.py` → 每个打点离整帧、离 1/grid 拍网格（`cuecheck.grid`：2 = 八分、4 = 十六分）、离时间线、离登记的音乐起音的毫秒数，可查静默段，超差退出非零
- `engine/render/build.mjs` → 一条命令：事件表 → mix.py → 拍点核对 → 逐帧 → 封装 → 海报 → 规格核对

**共享引擎里 C 直接用到的**

- `engine/render/video.mjs` / `still.mjs` / `page.mjs` → 页面约定、分段并行逐帧、静帧；`mux.sh` → 用 ebur128 量响度、整段线性增益到 −14 LUFS（真峰值 ≤ −1.2 dBTP），画面已是标注完整的 BT.709 时直接拷贝
- `engine/core/math.js`（缓动、`mulberry` 种子随机、`monotone` 单调插值）、`clock.js`（`hold` 一拍二 / 一拍三）、`noise.js`（必须传种子）
- `engine/paint/curve.js`（Catmull-Rom 与弧长取点，模版毛笔用它）、`ink.js`（带笔压起伏、按拍换形的墨线）、`wash.js`、`path.js`、`light.js`、`strand.js`、`canvas.js`（离屏层，模版用它）
- `engine/overlay/text.js`（`loadFonts`、`fontSpec`、`measure`）、`brush.js`（毛笔逐笔写字）
- `engine/audio/dsp.py`、`synth.py`、`mixing.py`（`loudness_to`）、`meter.py`、`sampler.py`（多采样乐器，需 `BEIMING_SAMPLES`）

**工具**

- `tools/c-styles.mjs` → 生成与核对 STYLES.md / styles.json，`find` 查候选
- `tools/c-runtime.mjs` → 历史复刻：`setup` 建隔离运行时、`status` 看是否就绪、`assets` 装上游采样乐器等大素材包（sha256 锁在快照里）、`build` 重跑还原出的作品、`sy` 给 SY 风格做适配页（见 REPLICATE.md）

**把一式的方法落到 C 模版 / A / B**（按上游 STYLE.md 的 11 节对照）

| STYLE.md 节 | C 模版里写在哪 | 落到 A（`engine/` 九层） | 落到 B（`engine/native/`） |
|---|---|---|---|
| §2 材质与渲染 | 作品目录里的画法模块（模版的 `brush.js`、`paper.js`），Canvas 2D 合成 | `engine/paint`（ink、wash、path、light）、`engine/look`（纸纹、颗粒、Kuwahara、墨线）、`engine/shade` | `post.ts` 的 `paperPass` / `gradePass`、`surface.ts`、`toon.tsx`；页面画法整段烘成图集用 `sequence.mjs` + `<SequencePlane>` |
| §3 色彩逻辑 | `film.js` 顶部的色板常量（模版：朱红只给印） | `engine/look` 调色与色彩脚本 | `palette.ts`（色板从 palette.json 读） |
| §4 字与字幕 | `film.js` + `engine/overlay/text.js`，缺字检查 `type.js` | `engine/overlay` | `title.tsx`（`TitleCard`、`Caption`） |
| §5 运动质感 | `engine/core/clock.js` 的 `hold`、`math.js` 缓动、`film.json` 节拍 | 同左，加 `engine/stage` | 帧号驱动的组件时间（`layers.tsx` 的 `drift`） |
| §6 镜头语法 | `film.js` 的相机矩阵（模版：绕焦点缓推） | `engine/stage` 的相机与底板视差 | `camera.tsx` 的 `ShotCamera` |
| §7 声音 | `mix.py`（`engine/audio`） | 同左 | 同左，由 prepare 调用声音脚本 |
| §9 媒介陷阱 | 动手前逐条读，模版的修法写在 `brush.js` 注释里 | A 路默认后期会把任何风格染成北冥味：先关后期证明风格本体（[工艺手册 §6](../directing/craft/README.md)） | GLB 不带屏幕后期，墨线要重做 |

**未实现（别当成已有）**

- 仓库自己的"画面文字停留时长"检查、字幕导出；配音与逐字时间戳对齐（历史作品各自实现，没抽成模块）。
- "关键事件集合"式的拍点核对（`style-16-swiss-motion` 那种：十六分网格上一组关键画面事件逐个对音乐，不要求每个打点各登记一个音）：`cuecheck.py` 不覆盖。
- SVG / DOM 作品的模版：只有 Canvas 2D 模版，SVG / DOM 风格按页面约定自己写 `render(t)`。
- 完整字体与自动子集化：仓库只带《北冥》用到的字体子集。

## 契约

- **页面约定**（`engine/render/page.mjs` 头注释）：`window.DUR` 秒；`window.render(t)` 确定（不读 `Date.now()`、不用无种子随机、不依赖上一帧状态，任意帧可单独、乱序重渲）；资源就绪后 `window.READY = true`；`window.FPS` 是页面量化用的帧率（模版取 film.json 的 fps，渲染器默认按它出片，`--fps` 不一致直接报错）；可选 `window.TEXTS(t)` → `[{ id, text, box:[x,y,w,h], x0, y0, x1, y1, alpha, font, missing }]`。
- **C 路线附加**：`window.EV = [{t, type, ...}]`（`t` 秒、6 位小数，带 `cue` 的是画面打点）；`window.TIMELINE = { fps, secs, dur, cues, t, act }`。
- **film.json**：`route: "c"`、`title`、`dur`、`fps`（正整数）、`size: [宽, 高]`（偶数）；`poster`（秒）；`tempo: [{ id, t0, bpm, meter }]`；`cues: { 名字: [段落, 小节, 拍, 拍内分数] }`；`cuecheck: { grid, tolMs, silence, quietDb }`。时间只写在这里：`timeline.js` 从它推导，第 2 版写法（`output.fps`、`output.frameCount`）也认。
- **mix.py**：仓库根目录下 `$BEIMING_PY films/<名字>/mix.py`；读 `events.json` / `timeline.json`；写 `out/mix.wav`（48 kHz 立体声）、`out/stems/*.wav`、`out/score_onsets.json`（`{onsets: {cue: 秒}, notes: [秒...]}`）。
- **整数帧**：打点落在整帧上（24 fps 下 90 BPM 一拍 16 帧、120 BPM 12 帧；30 fps 下 90 BPM 20 帧）；cuecheck 默认容差 0.5 ms。
- **占位符**：模版只用 `{{NAME}}`（目录名）和 `{{TITLE}}`（片名）。
- **历史页面**：Lemo 的页面与我们同一套约定（`DUR` / `render(t)` / `READY`），只是不声明 `window.FPS`；SY 用 `Reel.scene` 契约（`?render=1` 后暴露 `window.__seek(t)` / `__duration` / `__fps`），不能直接交给 `engine/render`。
- **渲染器与环境变量**：

| 渲染器 | 用在 | GPU 后端 | 其它变量 |
|---|---|---|---|
| `engine/render`（still / video / build） | 新片；自包含的历史页面；SY 适配页 | `BEIMING_ANGLE`（macOS 默认 metal；RTX 用 vulkan） | `BEIMING_CHROME`、`BEIMING_READY_TIMEOUT`、`BEIMING_FRAME_TIMEOUT`、`BEIMING_PY`（build 用的 Python） |
| Lemo `core/render`（`c-runtime build` 调用历史 build.sh） | 依赖 `/core/` 的历史作品 | `LEMO_ANGLE` | `PLAYWRIGHT_CHROME`、`RENDER_SLOTS`；`LEMO_OPUSCAR_HOME` 由 c-runtime 设成隔离运行时 |
| SY `render.js`（上游自带） | SY 风格原样渲染 | 默认 SwiftShader 软件渲染；`--hwgpu` 或 `HWGPU=1` 用显卡 | `--nogpu`（纯 2D 页面更快） |

## 验收

1. `node engine/render/build.mjs films/<名字>` 退出码 0，最后一行"画面 W×H、N 帧（应为 N）、音轨 48000 Hz × 2"与 film.json 一致。
2. 拍点核对打印 `CUECHECK OK`，最大偏差 ≤ 0.5 ms。
3. 渲染日志里没有 `[字体缺字]`、`[页面错误]`。
4. 看片：`still.mjs` 渲 3–5 个打点前后的时刻；完整看一遍带声音的成片（"代理检查通过"不等于用户认可）。
5. 确定性：同一 `--workers` 两次渲染 `ffmpeg -i out/video.mp4 -f framemd5 -` 逐帧一致；`still.mjs` 乱序渲同一时刻得到同一张图。
6. 改了 C 的工具或索引：`node tools/c-styles.mjs --check`、`node --test "tests/c-style/*.test.mjs"`、`node tools/repo-check/rules/route-c/index.mjs`、`python3 tools/casebook.py check`。
7. 状态分开写：已出片、技术检查通过、人工认可是三件事。

## 边界与常见坑

- **不搬第三方代码。** `cases/vendor/` 只读学方法；我们的历史作品里也有从风格库改写来的文件（见各作品 `CREDITS`）。确需引用就保留原作者版权与 MIT 许可、在作品 `CREDITS` 写明来源，规则见 [THIRD-PARTY.md](../../THIRD-PARTY.md)。
- **历史页面能不能交给 `engine/render`，分三种：** ① 自包含的 Lemo 页面（STYLES.md "自包含"列为"是"，22 部）在素材齐全（`restore --download`，有的还要先跑它 build.sh 里的准备步骤）时可以直接用 `engine/render` 渲；它们不声明 `window.FPS`，按原帧率给 `--fps`，不是 24 fps 时再加 `--any-fps`；② 用了 `/core/` 绝对路径的 Lemo 页面（44 部）只能在 Lemo 库根目录下服务，用 `c-runtime build` 跑它自己的 build.sh；③ SY 风格是 `__seek` 契约，用 `c-runtime sy` 生成适配页再交给 `engine/render`，或者只取方法。`--source-only` 还原的目录不带图片、字体等二进制素材，**不能拿它判断能不能渲**。
- **不要运行 vendor 自带的 `setup.sh`**（`cases/vendor/lemo-opuscar/plugin/skills/lemo-opuscar/scripts/setup.sh`）：在本仓库里运行它会去找或克隆 `~/lemo-opuscar`，对它自己管理的克隆执行 `fetch origin main` + `reset --hard`，拿到的是上游最新代码而不是固定快照 bebbbe1。要运行环境用 `node tools/c-runtime.mjs setup`。
- **SY 页面用本机字体名**（Noto CJK、Inter 等），字体不随库分发：换机器字形就变。
- **比对逐帧时 `--workers` 要相同。** 分段数不同则关键帧位置不同，解码后的像素会不同（画面本身是确定的，`still.mjs` 乱序重渲逐字节一致）。
- **FLOAT 子类型的 WAV 文件头带时间戳**，两次写出的字节不同；比对声音读样本，不比文件哈希。模版写 PCM_24。
- **打点必须在整帧上。** 速度选每拍整帧的值，拍内分数用 1/2、1/4；`timeline.js` 和 cuecheck 都会报出偏差。
- **作品目录必须在仓库内**（`page.mjs` 只服务仓库根）；放在 `films/<名字>/`，引擎用 `../../engine/`。
- **执行面不等于画法**：STYLES.md 的执行面是源码检测，WebGL 列出来不代表画面主体在 WebGL 上；落地前读示例源码确认。

## 参考作品

- 模版：[template/](template/)（8 秒，三笔山 + 云 + 竖排题字 + 白文朱印，6 个打点，声音全部合成；横竖两套构图）。
- 风格索引：[STYLES.md](STYLES.md) 与 [styles.json](styles.json)；两套库的导演与技术手册（只读，MIT）：Lemo 的 [DIRECTOR.md](../../cases/vendor/lemo-opuscar/DIRECTOR.md)、[TECHNIQUE.md](../../cases/vendor/lemo-opuscar/TECHNIQUE.md)、[MY-STYLES.md](../../cases/vendor/lemo-opuscar/MY-STYLES.md)（LemoLab），SY 的 [README.md](../../cases/vendor/sy-style-100/README.md)、[SKILL.md](../../cases/vendor/sy-style-100/SKILL.md)（肖雄 XIAOXIONG）。
- 我们的 66 部风格实验与 PPT 片：[cases/README.md](../../cases/README.md)、[cases/INDEX.md](../../cases/INDEX.md)；两库源码对比 [docs/cases/comparison.md](../../docs/cases/comparison.md)。
- 导演与工艺规范：[routes/directing/](../directing/README.md)（导演十步、画面设计、五章工艺）。
- C 的公共件（tempo.js、cues.py、cuecheck.py、events.mjs、build.mjs）抽自我们 66 部风格实验的共同写法；抽取时的改前改后逐字节比对记在提交 e76c9d5 的说明里（本次未重跑）。
