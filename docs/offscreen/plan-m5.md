# 离屏出片 M5 实施计划：后期全特性收口、静帧/检查 CLI 闭环、C 路线适配与《化鹏闪羽》整片验证

> 前置：M4 已完成（分支 `zz8011/offscreen-m4`，雾、实例化/蒙皮 ID 通道、TSL 卡通材质进阶与 `muralLayer`、`mirrorObject` 角色桥及 D12 注册表登记均已完成）。本计划在 `zz8011/offscreen-m5` 上推进并已完成。
> 目标：消除离屏后期链余下的 `unsupported.paper` / `unsupported.look` 缺口，打通 `offscreen stills/probe` 与 `film stills / render / check` 全命令闭环，补齐 C 路线（86 式）离屏宿主适配，并在含复杂鲲鹏表演、羽根铰链波、微面法线瓣闪光与流萤落羽的《化鹏闪羽》（`films/peng-glint`）上验证双实现离屏出片。

## 任务拆分

### T1 纸纹锚点 / 面积取样与后期调试视图补齐（`tsl/paper.js`、`tsl/compose.js`、`tsl/debug.js`、`tsl/look.js`）
> **已完成**（2026-11-18）：补齐 `scaleMode: 'refHeight'`（面积加权取样）、`anchor`（`paperAnchor` 跟移）与每帧 `p.tex` / `canvasPaper`；新增 `tsl/debug.js` 支持全部 8 种调试视图（`id/depth/edge/line/bloom/paper/kuwahara/scene`），在 `ss = 1` 下全部对拍最大差 ≤ 1 级，变异全拦下。

### T2 离屏静帧与 `film` 全命令闭环（`engine/offscreen/cli.mjs`、`tools/film/commands/{frames,check}.mjs`）
> **已完成**（2026-11-18）：`cli.mjs` 新增 `stills`（无损 PNG，不依赖 FFmpeg）与 `probe`（只读契约与 GPU 探测）；`film stills` 与 `film render` 支持 `--renderer offscreen`（`backend = webgpu` 默认）及独立缓存与 `--clip`；`film check`、`planSession`、`build` 与 `deliver` 支持双实现及无 `index.html` 的纯 `backend = webgpu` 作品。

### T3 C 路线（86 式）离屏宿主适配（`engine/offscreen/c2d.mjs`）
> **已完成**（2026-11-18）：新增 `registerCanvasFonts`（按需加载 C 路线分片 woff2 毛笔字体）与 `createCanvasFilm`（自动垫好 `canvasFor` 所需的画布 shim，支持直出 sRGB 或在 Dawn GPU 上叠纸纹/暗角/颗粒，导出规范化 `TEXTS`）。

### T4 复杂主角片《化鹏闪羽》双实现离屏验证（`films/peng-glint`）
> **已完成**（2026-11-18）：不改动 `src/` 与页面 `world.js`/`main.js`，新增 `peng-tsl.mjs` 与 `offscreen.mjs` 完整映射 `kun_peng` 七种矿物色材质、微面法线瓣闪光、流萤落羽与海面日轮；1920×1080 · 144 帧全 GPU 离屏渲染 + NVENC 编码仅耗时 5.90 秒（稳态 28.9 fps），机器 QA 门 37/37 全过（注意 0 项）。
