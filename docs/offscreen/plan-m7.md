# 离屏出片 M7 实施计划：同源跨端运行时、WebGPU 审片工作台、`new-film --backend webgpu` 脚手架与分层风格化离屏化

> 前置：M6 已完成（分支 `zz8011/offscreen-m6`）。本计划在 `zz8011/offscreen-m7` 上推进并已完成。
> 目标：彻底兑现决定 D12「A、C 新作品写成一份作品模块，在 Chrome 的 WebGPU 里实时预览，在 Node + Dawn 里离屏高速出片」，并补齐 `engine/look/layers.js` 的 TSL 离屏对等实现。

## 任务拆分

### T1 同源跨端运行时与真实作品同源化（`engine/offscreen/io.mjs`、`film.mjs`、`c2d.mjs`、`paper.mjs`、`tsl/plates.js`、`films/chendu/offscreen.mjs`）
> **已完成**（2026-11-18）：新增零顶层 `node:*` 静态导入的 `engine/offscreen/io.mjs`（统一 `readBytes`/`readJson`、与 `tools/plates/png.mjs` 逐字节一致的 8/16 位 `decodeRgbaPng`、保留 16 位 `Uint16Array` 的 `decodeLayerPng`、跨端画布 `loadCanvasIso` 及 `FontFace`/`GlobalFonts` 字体加载 `loadFilmFontsIso`/`registerCanvasFontsIso`）；消除 `film.mjs`、`c2d.mjs`、`paper.mjs`、`tsl/plates.js` 的静态 Node 绑定，并将《晨渡》与工作区《化鹏闪羽》的 `offscreen.mjs` 升级为真同源模块（Node + Dawn 端渲染帧哈希与改前逐字节 100% 相同）。

### T2 `preview.js` 修复与交互式 WebGPU 审片工作台（`engine/offscreen/preview.js`、`lab/offscreen/index.html`、`tools/offscreen/compare.mjs`）
> **已完成**（2026-11-18）：修复 `preview.js` 漏 `await mod.build(...)` 与 `query` 透传；保留离屏 sRGB `RenderTarget` + 2D 显示画布架构（规避 Linux Chromium Vulkan `OpaqueFD` 交换链外部内存尺寸校验异常，显示像素与 `renderFrame` 逐字节相同）；`lab/offscreen/index.html` 补入 `three` importmap、自动探测同目录 `film.json`（片名、帧率、总帧数、镜头切点与声画事件刻度），提供实时播控、逐帧/切镜跳转、单镜循环与 8 种后期调试视图切换；`compare.mjs` 新增 `--query`。实测真实多镜头片 `films/chendu/offscreen.mjs` 在 Chrome WebGPU 与 Node + Dawn 对拍 PSNR 62.8–66.3 dB（过 M1 门），《化鹏闪羽》两帧逐字节相同。

### T3 `new-film` 与 `film new` 的 `--backend webgpu` 同源脚手架（`tools/lib/webgpu-scaffold.mjs`、`tools/new-film.mjs`、`tools/film/commands/new.mjs`）
> **已完成**（2026-11-18）：不改动受金标准保护的路线模版目录，新增 `--backend <后端>` 选项（非法组合退出码 2 `usage.bad-backend`）；同时补齐 `canvas.mjs` 的 `Path2D`/`ImageData` 全局注入、`offscreen probe --events-out` 的 `{ dur, ev }` 事件契约对齐，以及 `session.mjs` / `build.mjs` 离屏预检免 `browser` 要求。A、C 两条路线 `--backend webgpu` 生成的新片在 `BEIMING_CHROME=/nonexistent` 下从 `new` → `check` → `stills` → `build`（含 `mix`、`cuecheck` 与免浏览器 `qa` 38 项）全链路一次跑通，并可直接在 Chrome WebGPU 预览。

### T4 分层风格化 TSL 离屏实现与对拍（`engine/offscreen/tsl/layers.js`、`tests/offscreen/layers.test.mjs`）
> **已完成**（2026-11-18）：严守 D03 / D12 / `rt-boundary.md`（纯自写宽松许可代码，零 `engine/native/` 与专有外部渲染器依赖），对照 `engine/look/layers.js` 实现同源 `decodePng`、`loadLayers` 与 `createLayerLook`。对 WebGL 版逐视图对拍：`color` / `ids` 逐字节相同，`edge` PSNR 52.98 dB（最大差 1），`toon` PSNR 63.84 dB（最大差 1），`final` PSNR 61.31 dB（最大差 2、大差像素 0），`split` PSNR 64.10 dB（最大差 2、大差像素 0），关描边/色阶/笔触变异全部拦下。
