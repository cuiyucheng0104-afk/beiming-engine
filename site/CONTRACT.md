# 北冥作品站 · 多代理开发契约（CONTRACT）

适用于 2026-11 作品站重做（分支 `site-redesign-2026-11`）。所有子代理开工前读完：本文件、`site/PRODUCT.md`、`site/DESIGN.md`、`site/css/tokens.css`、仓库根的 `AGENTS.md`。

## 0. 铁律

1. **只写自己负责的文件**（见第 1 节表格）。别人的文件只读；发现别人的问题，写进汇报的 `cross_role_issues`，不要替别人改。
2. **不做任何 git 写操作**：不 commit、不 checkout、不 stash、不 reset、不 push、不建分支。只改工作区文件；删除文件用 `rm`，移动用 `mv`。主会话统一提交。
3. **不碰许可与署名**：`LICENSE`、`cases/licenses/`、`cases/vendor/`、`cases/NOTICES.md`、`fonts/LICENSE.md` 只读。
4. **对外名称**按 `AGENTS.md`：站点可见文字里不出现 RAEA / raea / Lemo / opuscar / SY100 等上游项目名，唯一例外是页脚的署名区块 `[data-attribution]`（决定 D04，2026-11-10：上游名在署名与许可语境如实出现，但不作我方产品名）。构建器与 site-qa 的 S8 都按这个例外检查，破折号检查仍覆盖署名区块。
5. **不准用破折号**（“——”“--”）写站点文案；全中文，英文只做小标签。
6. **结论要有证据**：说“完成”之前，必须真的跑过构建、在浏览器里打开并截图看过（Read 打开截图）。没验证的写“未验证”。
7. 临时文件放 `out/`（已在 .gitignore），不要在仓库里留调试垃圾。
8. 文档、注释、汇报一律简体中文。

## 1. 角色与写入范围

| 角色 | 只能写 | 交付 |
|---|---|---|
| **主会话**（集成） | `site/PRODUCT.md`、`site/DESIGN.md`、`site/CONTRACT.md`、`site/css/tokens.css` | 设计与契约；最终集成与提交 |
| **舞台 stage**（实时引擎） | `site/js/stage.js`、`site/js/stage/**`、`site/assets/hero-*`、`site/assets/stage-*`、`site/assets/og.jpg`、`site/dev/stage/**` | 第 2 节的 Stage API；海报与五张拆层静帧；OG 图 |
| **骨架 shell**（页面与编排） | `site/index.html`、`site/css/base.css`、`site/css/sections.css`、`site/js/main.js`、`site/js/brush-title.js`、`site/assets/ui-*` | 页面结构、全局样式、GSAP 编排、毛笔标题、主题切换、导航、页脚 |
| **作品 works**（画廊与构建） | `tools/build-showcase.py`、`site/css/works.css`、`site/js/works.js`、`site/data/**`、`package.json`、`package-lock.json`、`.github/workflows/pages.yml`、`.gitignore`、删除旧的 `showcase/` | 作品数据清洗、作品区标记与交互、整站构建器、Pages 部署 |
| **文档 docs**（仓库整理） | `README.md`、`ROUTES.md`、`AGENTS.md`、`THIRD-PARTY.md`（只改呈现，不删署名）、`docs/**`、`cases/README.md`、`cases/INDEX.md`（若它是生成物，则改生成它的地方并在汇报里说明） | 仓库文字呈现与导航整理 |
| **审查 review**（只读） | 无（报告写到 `out/review/`） | 结构化问题单 |

后续阶段（集成 QA、评审、返修）在 workflow 里另行指定范围。

## 2. Stage API（`site/js/stage.js`，ES module）

```js
export async function createStage(canvas, {
  reducedMotion = false,        // true：只渲一帧静态画面，不启动循环
  quality = 'auto',             // 'auto' | 'high' | 'low'（auto 按设备与实测帧时自适应，见下文“画质与像素比”）
  onStats = null,               // (s) => void，约每秒一次：{ fps, triangles, drawCalls, pixelRatio, gpu }
  defer = true,                 // 预估建鲲较慢时等访客停下来再建（见下文“建鲲时机”）；开发测试页可传 false 立即建
  lod = null,                   // 只给开发测试页：覆盖鲲的细分（0.1..1）
} = {})  // → Promise<Stage | null>；null = 不支持 WebGL2、软件渲染、没有浮点渲染目标、这台设备建鲲太慢或初始化失败
         //   （调用方继续显示海报；软件渲染与建鲲太慢会先派发 stage:skipped 说明原因）

Stage = {
  layers,                       // [{ key:'form', glyph:'形', module:'engine/form' }, shade 光 engine/shade, look 笔 engine/look, stage 景 engine/stage, time 时 engine/core/clock.js]（同 export 的 LAYERS）
  setScene(name, progress),     // name: 'hero' | 'layers' | 'idle'；progress 0..1 是该场景内的机位进度
  setLayer(x),                  // 0..4，可取小数（相邻两层在着色器里交叉过渡）；首屏为 4（全部开启）
  setPointer(nx, ny),           // -1..1，鼠标位置：轻微视差与鲲的目光
  play(), pause(),              // 渲染循环开关（离开视口 / 标签页隐藏时由 shell 调 pause；舞台自己也监听 visibilitychange）
  resize(),                     // 尺寸变化（stage 也自行监听 ResizeObserver）
  firstFrame,                   // Promise：第一帧实时画面已画出，resolve { ms }（shell 在此之后交叉淡出海报）；
                                //   在播放且页面可见的时间累计 15 秒还画不出来就 reject（调用方保持海报）；dispose 时 resolve { disposed: true }
  dispose(),
  debug,                        // 只给开发测试页（site/dev/stage/）用：定格渲染、改像素比、模拟丢上下文、读构建与画质数据
}
```

- 画布由 shell 放在 `<div class="stage" id="stage">` 里，`position: fixed` 铺满视口，位于 `#hero` 与 `#engine` 之后的内容之下；`#works` 起的篇章用不透明背景盖住它，此时 shell 调 `pause()`。
- 画布要**透明背景**（`alpha: true`，premultiplied）：第 0–2 层（形、光、笔）只画鲲，透出纸色；第 3 层（景）起天空在画布里铺满。
- 机位：`hero` 场景鲲在画面右上大半、头朝左；`layers` 场景鲲在画面右侧 7/12 栏区域，手机上在上半屏。
- 只从这些地方 import：`three`、`three/addons/...`（importmap）、`@engine/...`、`@film/...`（importmap 别名，分别映射到构建产物里的 `engine/`、`src/`）、以及 `site/js/stage/` 内的相对路径。
- 需要额外静态文件（贴图等）时，放进 `site/assets/stage-*`（先压缩，单张 ≤ 400 KB），不要直接引用 `assets/plates/` 里几 MB 的原图。
- 实时站点不受影片“确定性”铁律约束（可以用 rAF 时间）。第 4 层（首屏与“时”这一步）鲲按一拍三（8 fps）换姿态，和影片一致；拆层的形、光、笔、景（第 0–3 层）姿态平滑，3 → 4 层之间按比例过渡。墨线从第 1.5 层起一拍二抖动。最多约 60 帧每秒（高刷屏攒够一帧的时间再画）。

### 舞台事件（画布上派发的 CustomEvent，契约之外的补充，调用方可以不理）

| 事件 | `detail` | 什么时候派发；调用方怎么做 |
|---|---|---|
| `stage:skipped` | `{ reason: 'software' }` 或 `{ reason: 'cpu', estMs, judgeMs }` | `createStage` 即将返回 null 的原因：软件渲染（SwiftShader、llvmpipe 等），或建鲲判档值 > 800 ms。shell 据此把读数写成“浏览器没有开启显卡加速”或“这台设备较慢，没有启动实时画面”。不支持 WebGL2、没有浮点渲染目标、初始化出错时不派发（读数写“不支持实时画面”） |
| `stage:deferred` | `{ estMs, judgeMs, needScroll }` | 判档值在 300–800 ms 之间：舞台等访客停下来（0.8 秒没有操作、主线程空闲；`needScroll` 为 true 时还要先滚动过）再建鲲，在那之前 `createStage` 不返回，海报一直在 |
| `stage:beat` | `{ frame, beat, scene, layer }` | 实时画面里鲲一拍三换姿态的那一帧（只在第 4 层，约每秒 8 次）。`frame` 是 24 fps 的全局帧号，`beat` = `hold(frame, 3)` = ⌊frame / 3⌋。shell 用它驱动“时”这一步的帧条（`#frames`），与画面同拍 |
| `stage:lost` | `{ reason: 'context' }` 或 `{ reason: 'slow' }` | `context`：WebGL 上下文丢失，之后可能还有 `stage:restored`；`slow`：像素比降到最低档后仍连续约 3 秒低于 15 fps（每帧都慢，帧间隔中位数也 > 1/15 秒；低于 5 fps 不用等降到底），舞台已自行销毁，不会再恢复。两种都由调用方把海报接回来 |
| `stage:restored` | 无 | 上下文恢复、管线重新预热完，时间回到 t = 0（与海报同一姿态），调用方可以再交叉淡入一次 |

### 画质与像素比（`site/js/stage/quality.js`）

- 初始档（`pickTier`）：
  - 桌面：像素比上限 1.5（取设备像素比与超采样值里大的那个，再封顶 1.5）。1 倍屏也往上超采样（墨线是后期按深度、法线和物体编号算的，MSAA 管不到，像素比 1 时下颌、鳍边的墨线成阶梯），超采样只补到画布实际像素约 2160×1350 为止（QA 实测 60 fps 的 1440×900×1.5）：1440×900 的 1 倍屏是 1.5，1080p 外接屏约 1.19，2560×1440 的 1 倍屏是 1；2 倍屏是 1.5。鲲的细分 lod 0.75（`high` 为 1），阴影贴图 2048，MSAA 4。
  - 手机（粗指针且屏幕短边 < 820，或手机 UA 且屏幕短边 < 820）：像素比上限 min(设备像素比, 1.5)，lod 0.3，阴影贴图 1024，MSAA 4。
  - `quality: 'low'`：像素比 min(设备像素比, 1)，lod 0.3，阴影贴图 1024，MSAA 2。`'high'` 不自适应。
- 降档阶梯：上限之后接桌面 1.25 → 1 → 0.85 → 0.7、手机 1.25 → 1 → 0.85（只留比上限明显低的档）。
- 自适应（`createGovernor`，每帧在绘制之前判）：平滑后的帧间隔连续 1 秒 > 22 ms 降一档，降完先稳 1.5 秒再看；帧间隔稳定在刷新节奏（< 17.5 ms）且每帧绘制的主线程耗时 < 9 ms 连续 5 秒（距上次换档也超过 8 秒），试升一档；试用的 4 秒里只要连续 0.5 秒 > 20 ms 就退回，这一档的重试等待翻倍（10 秒起，最长 2 分钟）。
- 降到最低档仍跑不动：见上表 `stage:lost`（`slow`），交回海报。

### 建鲲时机

建鲲（`src/kun_qinglv.js` 的 `createKun`）是一整块同步计算，拆不开，也挪不进 Worker，只能挑时机：

1. shell 先等海报到（最多 1.2 秒）再动态 import 舞台，再等“北冥”写完（最多 2.6 秒）才调 `createStage`，期间海报一直在。减少动态与省流量（Save-Data）时不加载舞台。
2. 舞台先让出一帧，用 CPU 探针（`cpuProbe`，热身后取最快一次）× 46 预估建鲲要占多久主线程，判档值 = 预估 × 1.2。
3. 判档值 ≤ 300 ms 直接建；≤ 500 ms 派发 `stage:deferred`，等访客停下来、主线程空闲再建；≤ 800 ms 还要等访客先滚动过；> 800 ms 不建，派发 `stage:skipped`（`cpu`）后返回 null，只留海报与拆层静帧。减少动态或 `defer: false` 时不判档，直接建。
4. 建完先把网格与贴图分帧传上 GPU、着色器并行编译，管线按材质分组逐帧预热，再画第一帧。

## 3. 页面骨架与 DOM 约定（shell 负责）

```html
<html lang="zh-CN">
<head>
  <!-- 样式顺序固定 -->
  <link rel="stylesheet" href="css/fonts.css">     <!-- 构建器生成（字体子集） -->
  <link rel="stylesheet" href="css/tokens.css">
  <link rel="stylesheet" href="css/base.css">
  <link rel="stylesheet" href="css/sections.css">
  <link rel="stylesheet" href="css/works.css">
  <script type="importmap">{ "imports": {
    "three": "./vendor/three/three.module.min.js",
    "three/addons/": "./vendor/three/addons/",
    "@engine/": "./engine/",
    "@film/": "./src/"
  } }</script>
  <script src="vendor/gsap/gsap.min.js" defer></script>
  <script src="vendor/gsap/ScrollTrigger.min.js" defer></script>
  <script src="vendor/gsap/Flip.min.js" defer></script>
  <script type="module" src="js/main.js"></script>
</head>
<body>
  <a class="skip-link" href="#main">跳到正文</a>
  <header class="nav" id="nav">…</header>
  <div class="stage" id="stage" aria-hidden="true">
    <picture><source media="(max-aspect-ratio: 999/1000)" srcset="assets/hero-poster-portrait.jpg"><img class="stage-poster" src="assets/hero-poster.jpg" alt=""></picture>
    <canvas id="stage-canvas"></canvas>
  </div>
  <main id="main" tabindex="-1">
    <section id="hero"   data-theme="dusk">…</section>
    <section id="engine" data-theme="paper">…</section>
    <section id="works"  data-theme="night"><!-- @works --></section>
    <section id="method" data-theme="night">…</section>
  </main>
  <footer>…</footer>
</body>
```

- `<!-- @works -->` 由构建器替换成作品区完整标记（无 JS 也能看到 79 部作品与链接）。作品区内部的标记、样式、交互全部归 works 角色；shell 只负责 `#works` 这个容器在篇章流里的位置与主题。
- 需要毛笔字的元素加 `class="f-brush"`，构建器按这些元素里的字子集化 Ma Shan Zheng。
- `main.js` 负责：开场编排、动态 `import('./stage.js')` 并调 Stage API、拆层滚动叙事、主题插值、导航、调用 `initWorks()`、减少动态时的降级。
- GSAP 用 UMD 全局：`const { gsap, ScrollTrigger, Flip } = window;`，在 `main.js` 里统一 `gsap.registerPlugin(ScrollTrigger, Flip)`。

## 4. 作品区（works 负责）

```js
// site/js/works.js
export function initWorks(root /* #works */, { gsap, ScrollTrigger, Flip, reducedMotion }) // → { destroy() }
```

- 数据：`site/data/works-meta.json`（人工策展，提交进仓库，`_说明` 字段写了口径）：按案例 id 给出干净的中文片名 `title`、中文画风名 `styleName`、画风家族 `family`（只给北冥代码动画风格，其余为 null）、≤ 40 字的一句话简介 `blurb`（从案例的 TREATMENT、方案、旁白等原文里提炼，不编造）、`previewStart`（海报在预览视频里的时间点，秒，悬停从这一帧起播）；可选 `order`（组内排序）、`poster`（覆盖案例自带的海报，路径相对 `site/data/`，只能是 `posters/` 下的 `.jpg`）。
- 构建器生成 `data/works.json`（只在构建产物里）：
  ```json
  { "counts": { "all": 79, "styles": 66, "ppt-stories": 7, "ppt-keynote": 6, "archived": 96 },
    "groups": [ { "key": "styles", "title": "北冥代码动画风格", "count": 66 }, … ],
    "families": [ { "key": "paint", "title": "手绘与水墨", "count": 8 }, … ],
    "works": [ { "id", "group", "family", "n", "title", "styleName", "blurb", "duration", "durationLabel",
                 "poster", "preview", "previewBytes", "previewStart", "caseUrl", "sourceUrl",
                 "hover" } ] }   // hover 可选：剪了悬停短循环才有，站内相对路径 media/hover/<id>-hover.mp4
  ```
- 作品区每一格（`li.wk-frame`）带 `data-id`、`data-group`、`data-family`、`data-n`（两位编号）、`data-preview`、`data-start`（= `previewStart`）、`data-hover`（有短循环才有）、`data-case`、`data-source`、`data-duration`、`data-bytes`；链接 `a.wk-link` 直接指向预览 mp4，没有 JS 也能看。
- 时长标签：`20 秒`、`2 分 51 秒`，整分钟写 `3 分钟`；不补零（修掉旧站“2 分 0051 秒”的格式错误）。
- 预览视频：构建时若给了 `--previews-dir`，把 `<id>-preview.mp4` 放进 `media/previews/`（本地默认软链接，`--copy-previews` 时复制），`preview` 用站内相对路径；没给就退回 Release 下载地址。海报复制到 `media/posters/`。
- 悬停短循环：有本地预览且有 ffmpeg 时，构建器从 `previewStart` 起剪 4 秒、480 宽、无音轨、最高 30 帧的 H.264（每段约 100–300 KB），放进 `media/hover/`（与预览视频一样软链接或复制），标记里写 `data-hover`。悬停只播它；点开放映台才用完整预览。没有短循环时悬停播整部预览，用媒体片段 `#t=<previewStart>` 从海报那一帧起播（要服务器支持 Range；`python3 -m http.server` 不支持，会从片头播）。
- 交互：海报 `loading="lazy"`、带宽高；悬停（精确指针）或键盘聚焦 180 ms 后才加载并静音循环，离开就停并移除；减少动态、省流量（Save-Data）与触屏都不自动播。点击在原地展开“放映台”（`section#works-screen`，插在本行行尾，胶片条则在条下方）：有声、带控件，正在放映的那一格用窗灯金的油性笔圈出来；链接带 `aria-expanded`，展开时 `aria-controls="works-screen"`。
- 放映台焦点（主会话定的口径）：打开后焦点落在放映台的片名 `h4#works-screen-title`（`tabindex="-1"`）上，键盘打开时显示窗灯金 2px 描边（`:focus-visible`；鼠标点开按全站惯例不画）；Tab 一次进入视频控件；Esc 或「收起」按钮收起放映台，焦点回到原来那一格（这一次聚焦不起播悬停预览）。焦点在片名上时空格暂停 / 继续。标记顺序是 题注 → 视频 → 收起 → 链接：Chromium 的原生控件在焦点进到控件内部之后会吞掉 Esc，所以「收起」紧跟在视频后面。

## 5. 构建与命令（works 负责实现，docs 负责写进文档）

```bash
npm run site:build              # = python3 tools/build-showcase.py → out/site/
npm run site:serve              # = python3 -m http.server 8090 -d out/site
python3 tools/build-showcase.py --out _site --previews-dir <目录> [--copy-previews]
```

依赖：Python 3.9 以上（CI 用 3.12）；`npm ci` 装好的 `three` 与 `gsap`（缺了构建失败）；ffmpeg 可选（构建时只用来剪悬停短循环，找不到就跳过，悬停退回整部预览；`--make-film-1280` 重转手机版样片时必须有）；联网可选（取字体子集，失败退回）。

构建器步骤：

1. 读 `cases/catalog.json` + 策展规则 + `site/data/works-meta.json` → 作品列表（79 部；数字与旧规则一致；片名残留、简介字数、时长与分组文案的范围、`previewStart` 都在这里校验）。接着剪悬停短循环：要同时有 `--previews-dir` 和 ffmpeg，没给 `--no-hover-clips`；剪好的放在缓存目录 `out/.cache/hover/<id>-<key>.mp4`，key 由预览文件的 sha256（`catalog.json` 里记的，没有就用文件大小）、`previewStart` 与剪辑参数算出，预览、起播点或参数一变就重剪；哪一部剪失败，那一部退回整部预览，ffmpeg 的完整命令与报错原文写进构建日志。
2. 复制 `site/`（不含 `*.md`、`dev/`、`data/works-meta.json`、`data/posters/`）→ 输出目录；把作品区标记填进 `<!-- @works -->`；写 `data/works.json`。
3. 从 `site/js/` 下**每一个** `.js` 文件出发解析 import 图（静态与动态 import、`new URL(…, import.meta.url)`；相对路径、`@engine/`、`@film/`、`three/addons/`），只复制用到的 `engine/`、`src/` 文件到 `engine/`、`src/`，以及 `node_modules/three/build/three.module.min.js` 和用到的 addons 到 `vendor/three/`。缺文件就报错退出。
4. 复制 `node_modules/gsap/dist/{gsap,ScrollTrigger,Flip}.min.js` → `vendor/gsap/`（`package.json` 锁定 `"gsap": "3.15.1"`）。
5. 字体：收集 `.f-brush` 元素与 Stage 层名里的汉字，通过 Google Fonts CSS2 API 的 `text=` 参数取 Ma Shan Zheng 子集；Barlow 取 300/400/500/600 的 ASCII 子集；写出 `css/fonts.css`。取到的 CSS 与字体文件缓存在 `out/.cache/fonts/`（`--offline` 只用缓存）。网络失败时打印警告，退回仓库自带子集与系统字体（构建不失败）。
6. 媒体：海报（含 `works-meta.json` 指定的覆盖海报）→ `media/posters/`；预览视频 → `media/previews/`、悬停短循环 → `media/hover/`（两者本地软链接，`--copy-previews` 时复制）；样片 `media/beiming.mp4`，以及手机版样片 `media/beiming-1280.mp4`（提交在仓库里，页面在窄屏用 `<source media>` 选它；构建核对它不超过 6 MB、是从现在这份原片转的，换了原片用 `--make-film-1280` 重转）。
7. 校验：输出目录里所有本地 `src` / `href` / `poster` / `srcset` / CSS `url()` 都能解析到文件，页内锚点都存在，页面可见文字里没有破折号、内部代号和工程残留；否则报错退出。

构建开始先写 `.site-build.json`（`{"status": "building"}`），全部通过后改写成 `{ builder, counts, previews, hoverClips, fonts, gsap }`；输出目录非空却没有这个标记时拒绝覆盖。

其余选项：`--template <路径>`（默认 `site/index.html`，方便在 shell 交付之前用临时模板自测）、`--site <目录>`（换站点源目录）、`--offline`、`--no-hover-clips`、`--lenient`（校验错误降为警告，只用于并行开发时本地自测，CI 不用）、`--make-film-1280`（只重转手机版样片，不构建站点）。

`.github/workflows/pages.yml`：`npm ci` → Python 3.12 → `gh release download casebook-2026.11 --pattern '*-preview.mp4' --dir _previews`（`GH_TOKEN: ${{ github.token }}`）→ 装 ffmpeg（`continue-on-error`，装不上不挡发布，悬停退回整部预览）→ `actions/cache` 缓存 `out/.cache/hover`（key 取 `cases/catalog.json`、`site/data/works-meta.json`、`tools/build-showcase.py` 的哈希）→ `python tools/build-showcase.py --out _site --previews-dir _previews --copy-previews` → 上传。触发路径：`site/**`、`engine/**`、`src/**`、`fonts/**`、`cases/catalog.json`、`cases/previews/**`、两份样片、`tools/build-showcase.py`、`package.json`、`package-lock.json` 与 workflow 本身。

本地预览视频副本在 `~/beiming-case-audit-20261107/release/`（86 个 `*-preview.mp4`，共 406 MB），本地构建用 `--previews-dir` 指向它（软链接，不复制）。

### 并行开发时的自测隔离

多个角色同时开发时，各自构建到自己的目录、用自己的端口，互不覆盖：

| 角色 | 构建输出 | 本地端口 |
|---|---|---|
| stage | `out/dev-stage/`（或直接用 `site/dev/stage/` 的独立测试页，从仓库根起服务） | 8101 |
| shell | `out/dev-shell/` | 8102 |
| works | `out/dev-works/` | 8103 |
| 集成 QA | `out/site/` | 8110 |
| 返修 stage / shell / works | `out/fix-stage/` / `out/fix-shell/` / `out/fix-works/` | 8121 / 8122 / 8123 |
| 终检 | `out/site-final/` | 8130 |
| 第二轮集成（site-integrator） | `out/r2-integrator/` | 8221 |

之后各轮新增角色的目录与端口由 workflow 指定，同样不许和上表重复。works 的构建器还没写好时，其他角色可以在 `out/` 下写临时装配脚本自测（不提交），最终一律以 `tools/build-showcase.py` 为准。服务一律用 `python3 -m http.server <端口> -d <目录>` 在后台起，用完关掉自己起的进程，不要动别人的端口。

无头浏览器测试用仓库已装的 playwright-core：`import { chromium } from 'playwright-core'`，Mac 上加 `--use-angle=metal --enable-gpu --ignore-gpu-blocklist` 才走 GPU（参考 `engine/render/page.mjs` 的 `chromeArgs()` 与 `BEIMING_ANGLE`）。

毛笔标题“北冥”的笔画骨架与飞白参数在 `src/hud.js` 第 284–309 行（`SKEL`、`DRY`，已导出 `__TITLE_SKEL`），写字函数是 `engine/overlay/brush.js` 的 `buildBrushGlyph` / `paintBrushGlyph`；字形字体用 `fonts/MaShanZheng-400.woff2`（只含“北冥”两个字的子集）。截图放 `out/<自己的目录>/shots/`，并用 Read 亲眼看过。

## 6. 验收门禁（集成 QA 逐条跑，全部 PASS 才算能交）

门禁脚本是 `tools/site-qa.mjs`：`npm run site:qa -- --dir <构建目录> --port <端口> --out <输出目录>`（可加 `--build --previews-dir <目录>` 先构建、`--only desktop,mobile` 只跑部分场景、`--server range` 换成支持 Range 的内置服务）。S1 在 Node 里静态核对产物，S2–S9 用 playwright-core 分六轮打开页面（性能、桌面、手机、减少动态、关掉 JS、禁用 WebGL），结果写进 `<输出目录>/report.json`，截图存 JPG；9 项全部 PASS 退出码才是 0。截图要逐张用 Read 看过。

| 项 | 查什么 |
|---|---|
| S1 构建 | `npm run site:build` 退出码 0；`out/site/` 里所有本地引用都存在 |
| S2 加载 | 桌面 1440×900 无头 Chromium：无页面报错、无控制台错误、无 404；Stage 就绪并画出实时画面 |
| S3 拆层 | 滚过 `#engine` 时五层依次出现，文字与画面同步；截图逐张看过 |
| S4 作品 | 关掉 JS 也能看到 79 部作品；开 JS 时筛选、悬停预览（有短循环就播短循环）、原地放映、Esc 关闭、键盘焦点都正常。放映台按第 4 节的焦点口径验：点开后焦点落在 `#works-screen` 的片名上；键盘打开时片名的窗灯金 2px 描边看得见（计算样式与截图像素都核对）；Tab 一次进视频控件；Esc 收起、焦点回到原来那一格 |
| S5 降级 | `prefers-reduced-motion` 与禁用 WebGL 两种情况：显示海报和静帧，无报错，内容完整 |
| S6 手机 | 390×844：无横向滚动，文字可读，截图看过 |
| S7 性能 | 首屏海报与文字 2.5 秒内出现；除视频外首次加载 ≤ 2.5 MB；实时画面中位帧率 ≥ 50（Mac 有 GPU 时） |
| S8 文案 | 可见文字里无破折号、无内部代号、无 TREATMENT 等残留；数字与 DESIGN.md 第 7 节一致；作品口径是新说法（引言“79 部成片，每一部都由代码合成出片”，注写明素材来源在每部的案例卡里），旧说法“每一帧都由代码渲染，不是素材剪辑”不再出现；作品标题只写片名，时长标签格式见第 4 节 |
| S9 无障碍 | 地标与标题层级正确，图片有 alt，焦点可见，正文对比度 ≥ 4.5:1 |

## 7. 汇报格式

最后一条消息就是交付物，用结构化字段：`role`、`summary`、`files_changed`、`commands_run`（命令与结果）、`evidence`（截图等路径）、`gates`（自查结果）、`open_issues`、`cross_role_issues`。不写过程流水账。
