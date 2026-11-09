# 北冥作品站 · 多代理开发契约（CONTRACT）

适用于 2026-11 作品站重做（分支 `site-redesign-2026-11`）。所有子代理开工前读完：本文件、`site/PRODUCT.md`、`site/DESIGN.md`、`site/css/tokens.css`、仓库根的 `AGENTS.md`。

## 0. 铁律

1. **只写自己负责的文件**（见第 1 节表格）。别人的文件只读；发现别人的问题，写进汇报的 `cross_role_issues`，不要替别人改。
2. **不做任何 git 写操作**：不 commit、不 checkout、不 stash、不 reset、不 push、不建分支。只改工作区文件；删除文件用 `rm`，移动用 `mv`。主会话统一提交。
3. **不碰许可与署名**：`LICENSE`、`cases/licenses/`、`cases/vendor/`、`cases/NOTICES.md`、`fonts/LICENSE.md` 只读。
4. **对外名称**按 `AGENTS.md`：站点可见文字里不出现 RAEA / raea / Lemo / opuscar / SY100 等内部代号。
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
  quality = 'auto',             // 'auto' | 'high' | 'low'（auto 按设备与实测帧时自适应）
  onStats = null,               // (s) => void，约每秒一次：{ fps, triangles, drawCalls, pixelRatio, gpu }
} = {})  // → Promise<Stage | null>；null = 不支持 WebGL2 或初始化失败（调用方继续显示海报）

Stage = {
  layers,                       // [{ key:'form', glyph:'形', module:'engine/form' }, shade 光 engine/shade, look 笔 engine/look, stage 景 engine/stage, time 时 engine/core/clock.js]
  setScene(name, progress),     // name: 'hero' | 'layers' | 'idle'；progress 0..1 是该场景内的机位进度
  setLayer(x),                  // 0..4，可取小数（相邻两层在着色器里交叉过渡）；首屏为 4（全部开启）
  setPointer(nx, ny),           // -1..1，鼠标位置：轻微视差与鲲的目光
  play(), pause(),              // 渲染循环开关（离开视口 / 标签页隐藏时由 shell 调 pause）
  resize(),                     // 尺寸变化（stage 也可自行监听 ResizeObserver）
  firstFrame,                   // Promise：第一帧实时画面已画出（shell 在此之后交叉淡出海报）
  dispose(),
}
```

- 画布由 shell 放在 `<div class="stage" id="stage">` 里，`position: fixed` 铺满视口，位于 `#hero` 与 `#engine` 之后的内容之下；`#works` 起的篇章用不透明背景盖住它，此时 shell 调 `pause()`。
- 画布要**透明背景**（`alpha: true`，premultiplied）：第 0–2 层（形、光、笔）只画鲲，透出纸色；第 3 层（景）起天空在画布里铺满。
- 机位：`hero` 场景鲲在画面右上大半、头朝左；`layers` 场景鲲在画面右侧 7/12 栏区域，手机上在上半屏。
- 只从这些地方 import：`three`、`three/addons/...`（importmap）、`@engine/...`、`@film/...`（importmap 别名，分别映射到构建产物里的 `engine/`、`src/`）、以及 `site/js/stage/` 内的相对路径。
- 需要额外静态文件（贴图等）时，放进 `site/assets/stage-*`（先压缩，单张 ≤ 400 KB），不要直接引用 `assets/plates/` 里几 MB 的原图。
- 性能：桌面像素比上限 1.5、手机 1；帧时间连续 1 秒 > 22 ms 就降一档像素比；阴影贴图 ≤ 2048；构建鲲的主线程阻塞尽量拆成 ≤ 200 ms 的块（做不到就在首屏标题写完之后再建，期间海报一直在）。
- 实时站点不受影片“确定性”铁律约束（可以用 rAF 时间），但鲲的动作仍按一拍三（8 fps）步进，墨线一拍二抖动，和影片一致。

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
  <header class="nav">…</header>
  <div class="stage" id="stage" aria-hidden="true"><img class="stage-poster" src="assets/hero-poster.jpg" alt=""><canvas id="stage-canvas"></canvas></div>
  <main>
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

- 数据：`site/data/works-meta.json`（人工策展，提交进仓库）：按案例 id 给出干净的中文片名 `title`、中文画风名 `styleName`、画风家族 `family`、≤ 40 字的一句话简介 `blurb`（从案例的 TREATMENT 里提炼，不编造）、可选 `featured` / `order`。
- 构建器生成 `data/works.json`（只在构建产物里）：
  ```json
  { "counts": { "all": 79, "styles": 66, "ppt-stories": 7, "ppt-keynote": 6, "archived": 96 },
    "groups": [ { "key": "styles", "title": "北冥代码动画风格", "count": 66 }, … ],
    "families": [ { "key": "ink", "title": "水墨与书画", "count": 7 }, … ],
    "works": [ { "id", "group", "family", "n", "title", "styleName", "blurb", "duration", "durationLabel",
                 "poster", "preview", "previewBytes", "caseUrl", "sourceUrl" } ] }
  ```
- 时长标签：`20 秒`、`2 分 51 秒`（修掉旧站“2 分 0051 秒”的格式错误）。
- 预览视频：构建时若给了 `--previews-dir`，把 `<id>-preview.mp4` 放进 `media/previews/`（本地默认软链接，`--copy-previews` 时复制），`preview` 用站内相对路径；没给就退回 Release 下载地址。海报复制到 `media/posters/`。
- 交互：海报 `loading="lazy"`、带宽高；视频 `preload="none"`，悬停/聚焦 180 ms 后才加载并静音循环；点击在原地展开“放映台”（有声、带控件、可键盘关闭、焦点进出正确）。减少动态时不自动播放。

## 5. 构建与命令（works 负责实现，docs 负责写进文档）

```bash
npm run site:build              # = python3 tools/build-showcase.py → out/site/
npm run site:serve              # = python3 -m http.server 8090 -d out/site
python3 tools/build-showcase.py --out _site --previews-dir <目录> [--copy-previews]
```

构建器步骤：

1. 读 `cases/catalog.json` + 策展规则 + `site/data/works-meta.json` → 作品列表（79 部；数字与旧规则一致）。
2. 复制 `site/`（不含 `*.md`、`dev/`）→ 输出目录；把作品区标记填进 `<!-- @works -->`；写 `data/works.json`。
3. 从 `site/js/` 下**每一个** `.js` 文件出发解析 import 图（静态与动态 import；相对路径、`@engine/`、`@film/`、`three/addons/`），只复制用到的 `engine/`、`src/` 文件到 `engine/`、`src/`，以及 `node_modules/three/build/three.module.min.js` 和用到的 addons 到 `vendor/three/`。缺文件就报错退出。
4. 复制 `node_modules/gsap/dist/{gsap,ScrollTrigger,Flip}.min.js` → `vendor/gsap/`（`package.json` 依赖加 `"gsap": "3.15.1"`）。
5. 字体：收集 `.f-brush` 元素与 Stage 层名里的汉字，通过 Google Fonts CSS2 API 的 `text=` 参数取 Ma Shan Zheng 子集；Barlow 取 300/400/500/600 的 ASCII 子集；写出 `css/fonts.css`。网络失败时打印警告并退回系统字体（构建不失败）。
6. 复制作品海报、预览视频、`media/beiming.mp4`（样片）到 `media/`。
7. 校验：输出目录里所有本地 `src`/`href` 都能解析到文件，否则报错退出。

`.github/workflows/pages.yml`：`npm ci` → `gh release download casebook-2026.11 --pattern '*-preview.mp4' --dir _previews`（`GH_TOKEN: ${{ github.token }}`）→ `python tools/build-showcase.py --out _site --previews-dir _previews --copy-previews` → 上传。触发路径加上 `site/**`、`engine/**`、`src/**`、`package.json`、`package-lock.json`。

本地预览视频副本在 `~/beiming-case-audit-20261107/release/`（86 个 `*-preview.mp4`，共 406 MB），本地构建用 `--previews-dir` 指向它（软链接，不复制）。

构建器另支持 `--template <路径>`（默认 `site/index.html`），方便在 shell 交付之前用临时模板自测。

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

works 的构建器还没写好时，其他角色可以在 `out/` 下写临时装配脚本自测（不提交），最终一律以 `tools/build-showcase.py` 为准。服务一律用 `python3 -m http.server <端口> -d <目录>` 在后台起，用完关掉自己起的进程，不要动别人的端口。

无头浏览器测试用仓库已装的 playwright-core：`import { chromium } from 'playwright-core'`，Mac 上加 `--use-angle=metal --enable-gpu --ignore-gpu-blocklist` 才走 GPU（参考 `engine/render/page.mjs` 的 `chromeArgs()` 与 `BEIMING_ANGLE`）。

毛笔标题“北冥”的笔画骨架与飞白参数在 `src/hud.js` 第 284–309 行（`SKEL`、`DRY`，已导出 `__TITLE_SKEL`），写字函数是 `engine/overlay/brush.js` 的 `buildBrushGlyph` / `paintBrushGlyph`；字形字体用 `fonts/MaShanZheng-400.woff2`（只含“北冥”两个字的子集）。截图放 `out/<自己的目录>/shots/`，并用 Read 亲眼看过。

## 6. 验收门禁（集成 QA 逐条跑，全部 PASS 才算能交）

| 项 | 查什么 |
|---|---|
| S1 构建 | `npm run site:build` 退出码 0；`out/site/` 里所有本地引用都存在 |
| S2 加载 | 桌面 1440×900 无头 Chromium：无页面报错、无控制台错误、无 404；Stage 就绪并画出实时画面 |
| S3 拆层 | 滚过 `#engine` 时五层依次出现，文字与画面同步；截图逐张看过 |
| S4 作品 | 关掉 JS 也能看到 79 部作品；开 JS 时筛选、悬停预览、原地放映、Esc 关闭、键盘焦点都正常 |
| S5 降级 | `prefers-reduced-motion` 与禁用 WebGL 两种情况：显示海报和静帧，无报错，内容完整 |
| S6 手机 | 390×844：无横向滚动，文字可读，截图看过 |
| S7 性能 | 首屏海报与文字 2.5 秒内出现；除视频外首次加载 ≤ 2.5 MB；实时画面中位帧率 ≥ 50（Mac 有 GPU 时） |
| S8 文案 | 可见文字里无破折号、无内部代号、无 TREATMENT 等残留；数字与 DESIGN.md 第 7 节一致 |
| S9 无障碍 | 地标与标题层级正确，图片有 alt，焦点可见，正文对比度 ≥ 4.5:1 |

## 7. 汇报格式

最后一条消息就是交付物，用结构化字段：`role`、`summary`、`files_changed`、`commands_run`（命令与结果）、`evidence`（截图等路径）、`gates`（自查结果）、`open_issues`、`cross_role_issues`。不写过程流水账。
