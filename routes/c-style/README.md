# C 路线 · 北冥代码动画风格 · 86 式

给第一次进仓库的 agent：读完这一页就能用 C 模版出一部片，或者从 86 式里找方法落到 A / B。命令都在仓库根目录执行，路径都是仓库相对路径。

## 这条路线是什么

- **一部作品 = 一个网页 + 一张时间表 + 一个声音脚本。** 画面是 `index.html` 里的 Canvas 2D（也可以是 SVG、DOM/CSS，个别风格用 WebGL），`render(t)` 把任意时刻画出来；无头 Chrome 逐帧截图、FFmpeg 编码。没有统一着色器，每种风格各自实现画法。
- **一条时间线驱动一切。** 节拍表（段落、速度、拍号）与画面打点写在 `timeline.js`；页面导出的事件表 `events.json` 同时驱动拟音、配乐打点和拍点核对，声画对齐靠同一组数字，不靠手对。
- **86 式是方法库，不是运行时。** `cases/vendor/` 里两套第三方风格库（SY 20 种 + Lemo 66 种，均 MIT）的固定快照只读，用来学画法；`cases/source/` 是我们自己 66 部风格实验、7 部 PPT 片与发布会动画的历史源码（用 `python3 tools/casebook.py restore` 还原）。风格索引见 [STYLES.md](STYLES.md)。
- **两种用法**：① 用 C 模版直接做一部 Canvas 2D 风格片；② 在 STYLES.md 里找到方法，用到 WebGL / 三维的拿到 A 路线（WebGL 三渲二，`engine/`）落地，原生运行时的需求走 B 路线（北冥原生 · BNE）。

## 最快上手

**用法一：C 模版出一部片**（3 秒、24 fps、1920×1080、有声）

```bash
npm run setup                                   # 首次：装 playwright-core 与 Chrome headless shell
node tools/new-film.mjs c my-film               # 复制 routes/c-style/template → films/my-film，替换 {{NAME}} / {{TITLE}}
BEIMING_PY=/path/to/python node engine/render/build.mjs films/my-film
#   → films/my-film/out/my-film.mp4（−14 LUFS）、out/poster.jpg；最后一行打印帧数、尺寸、音轨核对结果
node engine/render/still.mjs films/my-film 0.5 2.75 --size 1920x1080 --out films/my-film/out/stills   # 看关键帧
```

- `BEIMING_PY` 指向装了 `requirements.txt`（numpy、scipy、numba、soundfile）的 Python；不设就用 `python3`。
- `tools/new-film.mjs` 由仓库统一提供（只做"复制 + 替换占位符"）；还没有时手工 `cp -R routes/c-style/template films/my-film` 再把文件里的 `{{NAME}}`、`{{TITLE}}` 换掉。
- 只要声音和核对、不渲画面：`node engine/render/build.mjs films/my-film --skip-video`。

**用法二：找方法，再落到 A / B**

```bash
npm run c:styles:check                          # 确认 STYLES.md 与快照同步
python3 tools/casebook.py restore style-03-ink-wash --source-only --out out/casebook   # 还原我们做过的那一部，看源码
```

1. 在 [STYLES.md](STYLES.md) 按风格名找到一行：看"执行面"和"建议怎么落地"。
2. 读"方法参考"里的 `STYLE.md` / 示例入口；我们做过的，读还原出来的 `timeline.js`、`film.js`、`mix.py`。
3. 只用 Canvas 2D / SVG / DOM 的，在 C 模版里重写画法；用到 WebGL / three.js 的，按 A 路线手册在 `engine/` 的分层里实现。**自己写，不搬**（见"边界与常见坑"）。

## 一部作品的目录

```
films/<名字>/
  film.json        { route: "c", title, dur, fps, size: [w, h] } + 可选 poster（秒）、cuecheck（拍点核对参数）
  index.html       一个 <canvas id="c">，加载 main.js
  main.js          页面约定：加载字体 → setup → 挂 window.DUR / render / READY / EV / TIMELINE / TEXTS
  timeline.js      节拍表、画面打点（CUES → T）、声画事件（EV）、TIMELINE；页面与 mix.py 共用的唯一时间源
  film.js          画面：setup(canvas) 与 render(t)，Canvas 2D；TEXTS(t) 报告画面上的字
  mix.py           声音：读 events.json / timeline.json → out/mix.wav、out/stems/、out/score_onsets.json
  README.md        改哪里、怎么出片
  events.json      生成物：window.EV 导出（build 第 1 步写入）
  timeline.json    生成物：window.TIMELINE 导出
  out/             生成物：video.mp4、mix.wav、stems/、score_onsets.json、<名字>.mp4、poster.jpg（已被 .gitignore）
```

模版里引用引擎用 `../../engine/...`、字体用 `../../fonts/...`，所以作品必须放在 `films/<名字>/` 这一层（页面服务器以仓库根为根，影片目录必须在仓库内）。`events.json` / `timeline.json` 每次 build 重新生成，是否提交跟作品的提交约定走；成片和中间文件只放 `out/`，不提交。

## 能力清单

每项：模块 → 能做什么 → 仓库里的例子。

**C 路线的时间与声画（本路线新增，抽自我们自己的历史作品）**

- `engine/core/tempo.js` `createTempo` → 段落（bpm、拍号、起点）上的"小节·拍·拍内分数"地址换成秒（6 位小数），一拍/一小节时长、所在段落、离整帧/离网格的距离、`toJSON()` → `routes/c-style/template/timeline.js`
- `engine/core/tempo.js` `createEvents` → 记声画事件 `{t, type, ...}`，带 `cue` 的是画面打点 → 同上
- `engine/render/events.mjs` → 打开页面，把 `window.EV` 写成 `events.json`，`window.TIMELINE` 写成 `timeline.json` → `node engine/render/events.mjs films/<名字>`
- `engine/audio/cues.py` → `load` 读两张表；`Tempo`（与 tempo.js 同一公式）；`Onsets` 登记"哪个音符对哪个打点"并写 `score_onsets.json`；`dispatch` 按事件类型分派拟音（可带 `prepare` 逐事件先抽随机数），返回没有处理器的类型；`write` 写混音与分轨 → `routes/c-style/template/mix.py`
- `engine/audio/cuecheck.py` → 每个打点离整帧、离 1/grid 拍网格、离时间线、离音乐起音的毫秒数，可选静默段检查，超差退出码 1 → `python -m engine.audio.cuecheck films/<名字>`，或在 `film.json` 写 `cuecheck`
- `engine/render/build.mjs` → 页面型作品一条命令：事件表 → mix.py → 拍点核对 → 逐帧 → 封装 → 海报 → ffprobe 核对 → `npm run c:build -- films/<名字>`

**共享引擎里 C 模版直接用到的**

- `engine/render/video.mjs` / `still.mjs` / `page.mjs` → 页面约定、分段并行逐帧渲染、静帧 → 所有作品
- `engine/render/mux.sh` → 两遍 loudnorm 线性归一到 −14 LUFS / −1.2 dBTP，音频短于画面补静音 → build 第 5 步
- `engine/core/math.js`（clamp、seg、缓动、`mulberry` 种子随机）、`clock.js`（`tick` 一拍二/一拍三）、`noise.js`（`createNoise2D`）→ 模版的抖动与时序
- `engine/paint/ink.js` `createInk` → 有笔压起伏、按拍换形的墨线 → 模版三笔远山
- `engine/paint/wash.js` → 水彩斑驳 + 纸纹纹理 → 模版宣纸底
- `engine/paint/canvas.js`、`path.js`、`curve.js`、`light.js`、`strand.js`、`affine.js` → 离屏层、路径采样、曲线、边缘光、发丝、仿射（A 路线《北冥》在用，C 可直接调）
- `engine/overlay/text.js`（`loadFonts`、`fontSpec`、`measure`、带晕的字）、`brush.js`（毛笔逐笔写字）、`widgets.js` → 片名与显示层 → 模版片名用 `loadFonts` + `fontSpec`
- `engine/audio/dsp.py`（滤波、摆位 `place`、混响、限制器）、`synth.py`（玻璃音、气泡、颗粒流）、`mixing.py`（镜头窗、让路、定响度）、`meter.py`（响度、真峰值）、`sampler.py`（多采样乐器，需 `BEIMING_SAMPLES` 指向采样库）→ 模版 mix.py 用 dsp + synth

**未实现（别当成已有）**

- 仓库自己的"画面文字停留时长"检查（历史作品用的是 Lemo 的 `core/render/readcheck.mjs`，第三方）；模版只把 `window.TEXTS` 暴露出来。
- 配音生成与逐字时间戳对齐、字幕导出：66 部里只有 2 部有配音，PPT 片各自实现，没有抽成通用模块。
- SVG / DOM 作品的模版：只有 Canvas 2D 模版；SVG / DOM 风格按页面约定自己写 `render(t)`。

## 契约

- **页面约定**（`engine/render/page.mjs` 头注释）：`window.DUR` 秒；`window.render(t)` 确定性——不读 `Date.now()`、不用无种子随机、不依赖上一帧状态，任意帧可单独、乱序重渲；资源就绪后 `window.READY = true`；可选 `window.TEXTS(t)` → `[{id, text, x0, y0, x1, y1}]`。
- **C 路线附加**：`window.EV = [{t, type, ...}]`，`t` 是秒（6 位小数），带 `cue` 的是画面打点；`window.TIMELINE = { fps, secs, dur, cues, t }`（`secs` = `[{id, t0, bpm, meter, t1?}]`，`t` = `{cue: 秒}`）。
- **film.json**：`{ route: "c", title, dur, fps, size: [w, h] }`，`size` 两边都是偶数；可选 `poster`（秒）、`cuecheck: { grid, tolMs, silence: [段落id], quietDb }`。`dur` 必须与 `timeline.js` 的 `DUR` 一致。
- **mix.py**：在仓库根目录用 `$BEIMING_PY films/<名字>/mix.py <影片目录>` 运行；读 `events.json` / `timeline.json`；写 `out/mix.wav`（48 kHz 立体声）、可选 `out/stems/*.wav`、`out/score_onsets.json`（`{onsets: {cue: 秒}, notes: [秒...]}`，cuecheck 读它）。不写响度：统一由 `mux.sh` 归一。
- **整数帧**：每个打点落在整帧上（24 fps 下 120 BPM 一拍 12 帧、90 BPM 一拍 16 帧）；cuecheck 默认容差 0.5 ms。
- **占位符**：模版里只有 `{{NAME}}`（目录名）和 `{{TITLE}}`（片名）两个。

## 验收

1. `node engine/render/build.mjs films/<名字>` 退出码 0，最后一行"画面 W×H、N 帧（应为 N）、音轨 48000 Hz × 2"与 `film.json` 一致（build 自己用 ffprobe 核对，不符退出 1）。
2. 拍点核对打印 `CUECHECK OK`，最大偏差 ≤ 0.5 ms。
3. 看关键帧：`still.mjs` 渲 3–5 个打点前后的时刻，或 `ffmpeg -i out/<名字>.mp4 -vf "select='eq(n\,12)+eq(n\,48)',tile=2x1" -frames:v 1 sheet.jpg`；完整看一遍带声音的成片。
4. 确定性：同一 `--workers` 两次渲染 `ffmpeg -i out/video.mp4 -f framemd5 -` 逐帧一致；`still.mjs` 乱序渲同一时刻得到同一张图。
5. 改了 `engine/` 里 C 路线的模块：`npm run c:styles:check`、`python3 tools/casebook.py check`，并用还原出来的历史作品做改前/改后逐帧、逐样本比对（做法见下方"参考作品"里的比对记录）。
6. 状态分开写：已出片、技术检查通过、人工认可是三件事。

## 边界与常见坑

- **不搬第三方代码。** `cases/vendor/` 只读学方法；我们历史作品里有一部分文件本身就是从风格库改写来的（如 `crayon.js`、`gl.js`，见各作品 `CREDITS`；catalog 记录 66 部风格实验里有 137 个文件与 Lemo 逐字一致），抽公共件时只取我们自己写的。确需引用时保留原作者版权与 MIT 许可、在作品 `CREDITS` 写明来源，规则见 [THIRD-PARTY.md](../../THIRD-PARTY.md)。
- **历史作品跑在 Lemo 运行时上**：页面用绝对路径 `/core/lib.js`，`build.sh` 依赖 `$LIB` 下的 `core/render/*.mjs`、`.venv` 与采样库。还原出来的源码不能直接用北冥的 `engine/render/*` 渲；要重跑就把 `LIB` 指向装好依赖的 Lemo 目录，在 `out/` 或临时目录里跑，不改归档。`--source-only` 还原不带字体等二进制素材，缺字体时页面会回落到系统字体。
- **比对逐帧时 `--workers` 要相同。** `video.mjs` 每段单独编码，分段数不同则关键帧位置不同，解码后的像素会不同（画面本身是确定的，`still.mjs` 乱序重渲逐字节一致）。
- **FLOAT 子类型的 WAV 文件头带时间戳**（PEAK 块），两次写出的字节不同；比对声音要读样本比，不要比文件哈希。模版默认写 PCM_24，文件可逐字节比对。
- **打点必须在整帧上。** 速度和段落起点选成整帧（例如 120 BPM@24 fps），拍内分数用 0.5、0.25；`tempo.offFrame` / cuecheck 会报出偏差。
- **字体**：`fonts/NotoSansSC-var.woff2` 是子集，片名里不在子集的字会回落到系统字体，换机器字形会变；要固定字形就按 `fonts/fetch_fonts.sh` 的方法做子集放进作品目录。
- **作品目录必须在仓库内**（`page.mjs` 只服务仓库根）；放在 `films/<名字>/`，引擎用 `../../engine/`。
- **执行面不等于画法**：STYLES.md 的执行面是正则检测，WebGL 列出来不代表画面主体在 WebGL 上；落地前读示例源码确认。

## 参考作品

- 模版：[routes/c-style/template/](template/)（3 秒，墨线远山 + 片名 + 朱印，5 个打点，声音全部合成）。
- 风格索引：[STYLES.md](STYLES.md)（86 式，执行面、方法参考、我们做过的作品与预览、落地建议；`npm run c:styles` 重建）。
- 我们的 66 部风格实验与 PPT 片：[cases/README.md](../../cases/README.md)、[cases/INDEX.md](../../cases/INDEX.md)；两库源码对比 [docs/cases/comparison.md](../../docs/cases/comparison.md)，PPT 片流程 [docs/cases/ppt-animation.md](../../docs/cases/ppt-animation.md)。
- 抽取依据（盘点 66 部风格实验，还原后统计）：66 部都有 `build.sh` 与 `index.html`；65 部 `events.json`（由 `window.EV` 导出）；61 部 `timeline.js` 与根目录 `mix.py`；47 部的声音脚本用 `if/elif ty ==` 按事件类型分派拟音；65 部有拍点核对脚本（`cuecheck.py` 或 `cuecheck.mjs`，写法各异）；61 部用 `document.fonts.load` 等字体（`engine/overlay/text.js` 的 `loadFonts` 已覆盖，未另抽）；44 部用 Lemo 的 readcheck、66 部用 Lemo 的 events/video/mux（第三方，未抽，北冥 `engine/render` 有自己的 video/still/mux）。
- 抽取正确性的比对（scratch 里改历史作品调用新模块，归档不改）：
  - `style-01-crayon-book`《小纸船遇上大雨》：`timeline.js` 改用 `createTempo`、`film.js` 改用 `createEvents`、`mix.py` 改用 `cues.load / Tempo / Onsets / dispatch / write`、`tools/cuecheck.py` 改为调用 `engine.audio.cuecheck`。与原版相比 `timeline.json`、`events.json`、`mix.wav` 与三条分轨、`score_onsets.json`、cuecheck 报告逐字节一致，475 帧逐帧一致。
  - `style-16-swiss-motion`《TEMPO》：拟音分派改用 `dispatch(..., prepare)`、落盘改用 `write`。`mix.wav` 976800×2 个样本全等（FLOAT 文件头时间戳不同），`score.json` 与标准输出一致。它的拍点核对是另一种写法（十六分网格 + 关键事件集合），`engine/audio/cuecheck.py` 不覆盖。
