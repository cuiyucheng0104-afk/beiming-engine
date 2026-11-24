# 北冥 TSL 开发工作流与调试

从需求到合入的一条直线。每步只写「在哪做、跑什么、看什么」。

## 0　标准工作流

1. **路由**：按 [subject-routing.md](subject-routing.md) 把诉求映射到模块与符号；先查 [library-index.md](library-index.md) 确认符号与依赖没记错（`node tools/tsl-skill-index.mjs --check` 保证它不过期）。
2. **复用**：能用现有节点组合就不写新 pass——look 参数（`outline` / `kuwahara` / `bloom` / `grade` / `fog` / `paper` / `vignette` / `grain`）和 `toonKind` 的参数表覆盖大部分调参需求；surface 层（`patchLayer` / `muralLayer`）挂在 `toonKind({ layers })` 上。
3. **组合 / 扩展**：确实要新 pass 时用 `pass.js` 的 `createFullscreen({ THREE, renderer })` 建全屏遍（`material(fragmentNode)` 建材质、`draw(mat, target)` 指定渲染目标），坐标按需用 `glCoord(TSL, h)`（GL 左下角约定）或 `screenCoordinate`（WebGPU 左上角约定）。全屏 pass 的输出目标用 `THREE.RenderTarget`，中间层 HalfFloat。改 `look.js` 的组合顺序=改画风，走风格基线审批（见下）。
4. **单帧验证**：预览宿主 `lab/offscreen/index.html?work=/lab/offscreen/ink.mjs`（Chrome WebGPU）；出片宿主单帧：`npm run offscreen -- render <作品.mjs> --frames 0:1 --out /tmp/probe.mp4`。调中间层用 look 参数 `debug: '<视图名>'`（见「调试视图」）。
5. **确定性验证**：`npm run determinism -- films/<名字> --renderer offscreen --seams`；改了 `engine/`、`src/`、`lab/`、`assets/`、路线模版还要跑金标准（见「风格基线保护」）。
6. **闸门**：整片仍走 `npm run film -- stills / animatic / build --final` 三道用户闸（D08）；本 skill 只管技术层，不代替闸门。

## 1　管线位置（改哪里）

```
作品模块 build(ctx) → { render(f) }                契约见 docs/offscreen/README.md §2.1
  └─ engine/offscreen/film.mjs  createFilm().work({ shots, look, draw, texts, stateKey })
       └─ 镜头 update(t, f, ctx) / look(t, ctx)
            └─ engine/offscreen/tsl/look.js  createLook().render(scene, camera, p)     ← p = 镜头 look 参数
                 ├─ ① 主场景（MRT 可同遍写 ID）
                 ├─ ② tsl/idpass.js + tsl/ink.js        墨线（ID → 边缘 → 笔画）
                 ├─ ③ tsl/fog.js → tsl/bloom.js → tsl/grade.js（+输出变换）
                 └─ ④ tsl/kuwahara.js → tsl/compose.js（墨线×纸纹×暗角×颗粒）或 tsl/debug.js
```

- `pass.js` 是所有全屏 pass 的公共底座；`color.js` 是参数取色（`'#hex'` / `0x…` / `[r,g,b]` / THREE.Color 统一入口）。
- `plates.js` 是场景侧（底板面片进主场景），不是后期；`layers.js` 是独立管线（外部分层图 → 北冥画风），不走 createLook。
- `c2d.mjs` 用 `createPaper` + `createCompose` 做 C 路线 2D 页面的 GPU 合成（`tests/offscreen/c2d.test.mjs`）。

## 2　确定性红线（违反=出片不可复现）

- 时间只从整数帧号 `f` 来：不 import three 的 `time` / `deltaTime`，不用 `Date.now` / `performance.now` / `Math.random`（契约 §2.1）。随机一律 `engine/core/math.js` 的 `mulberry(种子)` 或 TSL `hash` / `noise.js` 的整数种子哈希。
- 作品模块不写 `import ... from 'three'`（仓库 `three` 锁 r170，离屏要 r187 的 `three-webgpu`）；THREE / TSL 由宿主注入。
- 不自己 `new RenderPipeline`，用宿主给的 `pipeline(outputNode)`（它已设 `outputColorTransform = false`，否则 sRGB 会叠两次变亮）。
- 墨线沸腾种子 `boilSeed(t, p, fps)`、颗粒种子 `grainSeedOf(t, fps, grainHold)` 都是 `(t, fps)` 的纯函数；同拍同种。
- `stateKey(f)`（可选）必须覆盖影响该帧画面的全部状态，复用帧的 `pixels` 是只读视图。

## 3　调试视图

镜头 look 参数 `debug: '<mode>'`（`tsl/debug.js` 的 `DEBUG_VIEWS`）：

| mode | 看 |
|---|---|
| `id` | ID 图按黄金分割色相着色（alpha 控明暗）——描边分组对不对 |
| `depth` | 对数视空间深度——雾与 Kuwahara 远近半径的输入 |
| `edge` | 边缘（浓度 / 半线宽 / 深度差）——线该出没出 |
| `line` | 白底黑线笔画覆盖率——线形、抖动、断线 |
| `bloom` | 辉光纹理 ×4 |
| `paper` | 纸纹灰度 |
| `kuwahara` | 笔触结果（未知视图名也退回它） |

配套：`npm run offscreen -- render` 带 `--query` 可透传作品自定义调试参数（作品侧读 `URLSearchParams`）；lookdev 批量扫参 `npm run lookdev:sweep`（快照白名单 `LOOKDEV_CACHE_KEYS`，fail-closed）。

## 4　单测与对拍

| 要跑 | 命令 | 覆盖 |
|---|---|---|
| tsl 全域 | `npm test -- --only offscreen` | 离屏全部测试（ink / kuwahara / toon / idpass / mrt / paper / fog / plates / layers / look / c2d / determinism…，`node tools/run-tests.mjs --list` 看现数） |
| 引擎层 | `node --test "tests/engine/**/*.test.mjs"` | 改了 engine/ 的 core、form、shade、stage、look、paint、overlay 时 |
| 预览↔出片对拍 | `npm run offscreen:compare` | 同机同帧 PSNR ≥ 50 dB、差 5 级以上像素 ≤ 0.1% |
| 确定性 | `npm run determinism -- <作品> --renderer offscreen --seams` | 同帧重渲逐字节相同、切点连续 |

测试要 GPU（Dawn）；没有 GPU 的机器设 `BEIMING_GPU=software-ok` 走软件适配器（慢但能跑）。环境缺依赖 exit 3，先 `npm run env:doctor -- --route a`。

## 5　风格基线保护（改画面前必读）

[docs/style-baselines/POLICY.md](../../../docs/style-baselines/POLICY.md)：改了会出画面的代码（含 `engine/offscreen/tsl/`），合入前 `npm run golden -- compare --set beiming-core,lab,templates,fixtures --strict` 要 exit 0。画面是**有意**改的：走 POLICY 第 6 节审批，agent 不得自己当批准人。不发 PR 直接改 `docs/style-baselines/` 下的参照与金标准清单 = 越权。

## 6　许可边界

`engine/offscreen/tsl/` 是纯自写宽松许可代码（MIT，REUSE.toml 兜底）；不 import `engine/native/`，不碰 RAEA。从 `cases/vendor/` / `cases/source/` 借方法要写来源头（[docs/rights/licensing.md](../../../docs/rights/licensing.md)）。**本 skill 不引入任何 Shadertoy / GLSL 片段代码**——上游 `gokayfem/shader-skills` 只借鉴了文档组织范式（subject-routing + 自动生成 library-index + 正负 evals），没有复制其 GLSL 内容。
