# 离屏出片 M7 实施计划：同源跨端运行时、WebGPU 审片工作台、`new-film --backend webgpu` 脚手架与分层风格化离屏化

> 前置：M6 已完成（分支 `zz8011/offscreen-m6`）。本计划在 `zz8011/offscreen-m7` 上推进。
> 目标：彻底兑现决定 D12「A、C 新作品写成一份作品模块，在 Chrome 的 WebGPU 里实时预览，在 Node + Dawn 里离屏高速出片」，并补齐 `engine/look/layers.js` 的 TSL 离屏对等实现。

## 任务拆分

### T1 同源跨端运行时与真实作品同源化（`engine/offscreen/io.mjs`、`film.mjs`、`c2d.mjs`、`paper.mjs`、`tsl/plates.js`、`films/chendu/offscreen.mjs`）
- **问题**：此前 `film.mjs`、`c2d.mjs`、`paper.mjs`、`tsl/plates.js` 顶层静态导入了 `node:fs` / `node:path` / `@napi-rs/canvas`，导致真实 A/C 离屏作品模块无法在 Chrome WebGPU 中加载，只能只服务于 `lab/offscreen/` 的纯数学小样。
- **方案**：
  - 新增零顶层 `node:*` 静态导入的 `engine/offscreen/io.mjs`：提供 `IS_NODE`、`readBytes`、`readJson`、`decodeRgbaPng`（8/16 位 PNG → RGBA8，对齐 `tools/plates/png.mjs`）、`decodeLayerPng`（保留 16 位 `Uint16Array` 通道）、`loadCanvasIso`、`loadFilmFontsIso`（浏览器端走 `FontFace` + `document.fonts`，Node 端走 `@napi-rs/canvas` `GlobalFonts`）与 `registerCanvasFontsIso`（支持分片 woff2 按 `unicodeRange` 码位按需加载）。
  - 升级 `film.mjs`、`c2d.mjs`、`paper.mjs`（新增 `loadPaperAsync` 并保留同步 `loadPaper`）、`tsl/plates.js`（新增 `loadPlatesAsync` / `loadTextureAsync` 并保留同步 `loadPlates`），消除浏览器端模块解析阻断。
  - 将 `films/chendu/offscreen.mjs`（及工作区 `films/peng-glint/offscreen.mjs`）改为零 `node:*` 顶层导入的真同源模块，验证 Node + Dawn 端渲染哈希与改前逐字节 100% 相同。

### T2 `preview.js` 修复、零读回直出与交互式 WebGPU 审片工作台（`engine/offscreen/preview.js`、`lab/offscreen/index.html`）
- **问题**：`preview.js` 未 `await mod.build(...)` 且未透传 `query`，异步作品在浏览器直接报错；循环播放每帧读回 CPU 再 `putImageData`，阻塞实时帧率；预览页无播控与调试能力，且 importmap 缺 `three` 导致复用 `engine/form/*` 的作品在浏览器无法解析。
- **方案**：
  - `preview.js` 补齐 `await mod.build({ ..., query })`；保留 `renderFrame` / `show`（供 `?api=1` 与 `offscreen:compare` 逐像素读回对拍），新增零读回直出 `present(work, f)` 直接绘制到 WebGPU 画布交换链并对齐 sRGB 输出变换。
  - `lab/offscreen/index.html` 补齐 `three` / `three/addons/` importmap，自动探测同目录 `film.json`（读取片名、`fps`、`frameCount`、`shots` 切点与 `events` 标记），提供实时 `fps` 播控（播放/暂停、逐帧、切镜跳转、单镜循环、进度条拖拽）、8 种后期调试视图切换与 `notext` / `animatic` 开关；`?api=1` 与 `?f=<n>` 契约保持不变。
  - 在无头 Chrome WebGPU 下实测加载 `/films/chendu/offscreen.mjs` 与 C 路线同源模块验证渲染与对拍。

### T3 `new-film` 与 `film new` 的 `--backend webgpu` 同源脚手架（`tools/lib/webgpu-scaffold.mjs`、`tools/new-film.mjs`、`tools/film/commands/new.mjs`）
- **方案**：
  - 不改动受金标准保护的 `routes/a-webgl/template/` 与 `routes/c-style/template/`；在 `new-film.mjs` 与 `film new` 新增 `--backend <后端>` 选项（非法路线后端组合报 `usage.bad-backend` 退出码 2）。
  - A 路线 `--backend webgpu` 生成多镜头同源脚手架（`film.json` `backend: "webgpu"`、`offscreen.mjs`、`world.js`、`title.js`、`shots/s1.js`、`shots/s2.js`、`sound.py`、`TREATMENT.md`、`README.md`）；C 路线 `--backend webgpu` 生成基于 `createCanvasFilm` + 节拍时间表的同源脚手架（`offscreen.mjs`、`timeline.js`、`mix.py`、`README.md`）。
  - 实测 `new-film` → `fonts:subset` → `film check` → `film stills` → `film build`（免浏览器全量 QA）与 Chrome WebGPU 预览全链路通过。

### T4 分层风格化 TSL 离屏实现与对拍（`engine/offscreen/tsl/layers.js`、`tests/offscreen/layers.test.mjs`）
- **方案**：
  - 严守 D03 / D12 / `rt-boundary.md`（纯自写宽松许可代码，不依赖 `engine/native/` 与外部 `vork` / `RAEA`），对照 `engine/look/layers.js` 实现同源 `decodePng`、`loadLayers` 与 TSL 版 `createLayerLook({ THREE, TSL, renderer }, w, h, opts)`。
  - 完整复刻物体编号轮廓 + `1/z` 二阶差分折痕 + 法线夹角内线、圆头笔域扭曲抖动与笔压、保色相多档平滑色阶（含天空独立档数）、Kuwahara 笔触、纸纹及 5 种视图与 `split` 左右对照；对 WebGL 版逐视图对拍并验证变异拦截。
