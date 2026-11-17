# 离屏出片 M5 实施计划：后期全特性收口、静帧/检查 CLI 闭环、C 路线适配与《化鹏闪羽》整片验证

> 前置：M4 已完成（分支 `zz8011/offscreen-m4`，雾、实例化/蒙皮 ID 通道、TSL 卡通材质进阶与 `muralLayer`、`mirrorObject` 角色桥及 D12 注册表登记均已完成）。本计划在 `zz8011/offscreen-m5` 上推进。
> 目标：消除离屏后期链余下的 `unsupported.paper` / `unsupported.look` 缺口，打通 `offscreen stills` 与 `film stills / render / check` 全命令闭环，补齐 C 路线（86 式）离屏宿主适配，并在含复杂鲲鹏表演、羽根铰链波、微面法线瓣闪光与流萤落羽的《化鹏闪羽》（`films/peng-glint`）上验证双实现离屏出片。

## 任务拆分

### T1 纸纹锚点 / 面积取样与后期调试视图补齐（`tsl/paper.js`、`tsl/compose.js`、`tsl/debug.js`、`tsl/look.js`）
- `tsl/paper.js` + `tsl/compose.js`：补齐 `scaleMode: 'refHeight'`（按输出像素覆盖纸纹格的面积加权取样，4K 缩回 1080 不丢高频）、`anchor`（`paperAnchor` 跟镜头推拉摇移，消除「玻璃钉纸」）以及每帧 `p.tex` / `p.mid` 覆盖；导出 `paperAnchor` 与 `canvasPaper` 供离屏作品直接复用。
- `tsl/debug.js` + `tsl/look.js`：补齐 `DEBUG_VIEWS`（`id`、`depth`、`edge`、`line`、`bloom`、`paper`、`kuwahara`、`scene`），与 `engine/look/debug.js` 同公式，支持 `--query dbg=...` 调色查错。
- 测试：`tests/offscreen/paper-debug.test.mjs` 对无头 Chrome WebGL 参考逐项对拍，含变异检查。

### T2 离屏静帧与 `film` 全命令闭环（`engine/offscreen/cli.mjs`、`tools/film/commands/{frames,check}.mjs`）
- `engine/offscreen/cli.mjs`：新增 `stills <作品.mjs> --out <目录> --frames <帧列表或区间>`（输出无损 PNG `f000048.png`，核对画幅与帧数，返回逐帧 `sha256`）。
- `tools/film/commands/frames.mjs`：`film stills` 与 `film render` 新增 `--renderer page|offscreen`（`backend === 'webgpu'` 时默认 `offscreen`），走离屏静帧渲染、独立帧缓存键、联系表与 `--clip` 拼片。
- `tools/film/commands/check.mjs`：作品含 `offscreen.mjs` 或 `backend === 'webgpu'` 时核对离屏入口模块与可选依赖；纯 `backend === 'webgpu'` 且无 `index.html` 的作品不再误报缺页面。
- 测试：`tests/offscreen/cli.test.mjs`、`tests/film/cli.test.mjs` 先红后绿覆盖新子命令与路由。

### T3 C 路线（86 式）离屏宿主适配（`engine/offscreen/c2d.mjs`）
- 新增 `engine/offscreen/c2d.mjs`：封装 `@napi-rs/canvas` 画布、作品字体子集注册（`loadFilmFonts`）、整数帧时钟到 `draw(ctx, t, f)` 的桥接，以及经 WebGPU DataTexture 上屏输出（可叠加离屏纸纹/暗角或直出 sRGB），统一满足离屏作品模块契约 `build(ctx) → { render(f), dispose() }`。
- 测试：`tests/offscreen/c2d.test.mjs` 验证 C 路线笔触、印章、排字在离屏 `render` 与 `stills` 下的确定性出片。

### T4 复杂主角片《化鹏闪羽》双实现离屏验证（`films/peng-glint`）
- 不破环既有 WebGL 页面入口（`films/peng-glint/main.js`），抽离双实现着色钩子并新增 `films/peng-glint/offscreen.mjs`：
  - `mirrorObject` 桥接 `src/kun_peng.js` 角色树，每帧同步 `setPose` + `applyHinges`（羽根铰链波更新 `InstancedMesh` 矩阵）与 `aClump` 羽簇属性；
  - TSL 版 `fragmentNormal` 微面法线瓣闪光（含覆瓦六角鱼鳞格、半程向量瓣、HDR `toonOverlay` 触发 Kuwahara 高光保护与 `toonInk` 墨线遮罩）；
  - TSL 版流萤落羽（`buildFeatherMotes`）、海面（`buildWater`）、日轮与日晕（`sunDisc`、`sunGlaze`）。
- 实测关键帧对拍（`0, 58, 66, 72, 120`）与 `film stills` / `film build --renderer offscreen --encoder nvenc`，结果记入 `docs/offscreen/README.md`。
