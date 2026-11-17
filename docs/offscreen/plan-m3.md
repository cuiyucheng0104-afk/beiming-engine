# 离屏出片 M3 实施计划：离屏能出真片（以 A 路线模版为验收片）

> 前置：M2 已完成（分支 `zz8011/offscreen-m2`，T5 验收小片 `films/du/` 三道闸用户已认可）。本计划在 `zz8011/offscreen-m3` 上做。
> 用户的三个决定（2026-11-18 会话）：验收片用 **A 路线模版**；Node 里的 Canvas 2D 用可选依赖 **`@napi-rs/canvas`**；作品写法走 **双实现、逐步迁移**（引擎给 TSL 版、接口与 GLSL 版一致，A 路线页面照常出片，两边逐帧对拍；旧片不强制迁移）。
> 约束沿用 D12：只写 `engine/offscreen/`、`tools/offscreen/`、`docs/offscreen/`、测试与新建作品目录；不动 `engine/look`、`engine/shade`、`engine/form`、`engine/stage` 与路线模版（模版受金标准基线保护，改像素要按 POLICY 审批）。

## 现状：模版用到、离屏还没有的东西

| 模版里的用法 | 现在的 A 路线实现 | 离屏缺什么 |
|---|---|---|
| 峰、礁、松、船、篷的卡通材质（三档分色、投影量化、交界线噪声、两层边缘光、补光、天空冷光、墨色） | `engine/shade/toon.js`：往 r170 MeshToonMaterial 里注入 GLSL，约 290 行，外加 `surface.js` 的表面层（锈斑） | TSL 版 `toonKind`，同参数表、同钩子位置 |
| 作品往钩子里写的着色（皴线与层理、松的干枝色） | `world.js` 里的 GLSL 字符串 | 钩子要能收 TSL 节点；作品同时给 GLSL 与 TSL 两份 |
| 主光投影（2048² 阴影图，投影区压进阴影档） | three 的 `getShadow` | TSL 里取同一个阴影量（`shadow` 节点），量化窗口照搬 |
| 太阳日轮、日晕罩色、水面（倒影、波纹） | 作品里的 `ShaderMaterial`（GLSL） | 作品给 TSL 版 |
| 天空与手绘底板、抠像面片、加色辉光精灵 | `engine/stage/plates.js`（顶层 import r170） | r187 版底板与辉光材质；ID 通道的软遮挡（半透明底板 auto 判成 soft） |
| 远山、晨雾、前景三张程序化贴图 | `canvasLayer`（DOM 画布） | Node 里的 Canvas 2D |
| 片名题字与副标题（字体子集、逐字洇开） | `title.js` + 影片外壳的 2D 显示层 | Node 里的 Canvas 2D + 字体注册；显示层合成 |
| 两个镜头、切点、`mixLook`、`TEXTS(t)` 给 QA | `engine/stage/film.js` + 页面约定 | 离屏的影片外壳；文字框导出给 QA |
| 闸门、机器 QA、网页版 | `npm run film` 出片链 | 出片链能选离屏后端 |

**不用改的**：`engine/form`（造型）、`engine/stage/camera.js`（构图与投影）、`engine/core`。已验证（2026-11-18）：r170 造型函数产出的几何按属性拷进 r187 的 `BufferGeometry` 即可用（自定义属性 `aRock` 也在）；相机工具直接操作 r187 相机结果正确。所以离屏侧只换着色层。

## 任务拆分

### T0 依赖与 Canvas 2D 垫片

> **已完成**（2026-11-18）：`engine/offscreen/canvas.mjs`，实测见 [README 7.8](README.md)。
- `package.json` 的 `optionalDependencies` 加 `@napi-rs/canvas`（固定版本），`THIRD-PARTY.md` 按包内许可原文登记（包本身 MIT，内含 Skia 等第三方二进制，逐项核对）。
- `engine/offscreen/canvas.mjs`：缺依赖抛 `env.offscreen-deps`；提供 `createCanvas(w, h)` 与字体注册（读作品的字体子集 `fonts/fonts.json`），给作品与显示层用。
- 测试：画一段文字与渐变，结果与无头 Chrome 的 Canvas 2D 比（只要求同量级，字形光栅化两边不保证逐像素相同；差多少写进文档）。

### T1 几何与相机桥

> **已完成**（2026-11-18）：`engine/offscreen/bridge.mjs`。
- `engine/offscreen/bridge.mjs`：`geometry(THREE, g170)` 按属性拷贝（含 index、自定义属性、`userData`），供作品复用 `engine/form` 的造型。
- 测试：spire、mesa、pineTree、boatHull 拷过去后属性与包围盒一致。

### T2 TSL 卡通材质（`engine/offscreen/tsl/toon.js`）
- 同 `toonKind(spec) → { make(opts), bind(mesh, mat, opts), shared }` 接口、同 `TOON_BASE` 参数表、同 `makeToonShared / setToonShared`。光照合成逐式照搬 `shadeGlsl`；钩子（`vertexBegin`、`fragmentBase`、`fragmentAlbedo` 等）收 TSL 函数，读写同名变量。
- 表面层：`surface.js` 的 `patchLayer`（锈斑）给 TSL 版。
- 投影：主光的阴影量按同一个量化窗口进分档。
- 测试：一组不带钩子、一组带皴线钩子、一组带投影的场景，对 GLSL 版在无头 Chrome 里对拍（M1 质量门）；变异检查（改分档阈值、去掉边缘光亮芯）必须变红。

### T3 ID 通道补全：软遮挡与精灵
- `idpass.js` 支持 `outlineOccluder` 的 `'soft'`（半透明底板、精灵按自身 alpha 半挡线）与 `'own'`（自带材质实心挡线）；卡通材质的 `noId`、`translucent`。
- 测试：沿用 T3（M2）的场景，加一块半透明底板压在描边物体前，对 GLSL 版对拍。

### T4 底板、辉光与显示层
- `engine/offscreen/tsl/plates.js`：`plate / plateMat / cutoutPlane / glowSprite / tileRepeat` 的 r187 版（直通 alpha、不写深度、不受雾与色调映射影响；抠像面片的深度遮罩层）。底板贴图经 `tools/plates/png.mjs` 解码，读 `assets/plates/plates.json` 的登记信息。
- 显示层：作品的 `draw(ctx, t)` 画在 T0 的画布上，按 A 路线外壳的同一方式叠在后期之后。
- 测试：底板 + 辉光 + 片名的合成对 A 路线对拍；片名题字的差异单独统计（字形光栅化）。

### T5 离屏影片外壳与出片链接入
- `engine/offscreen/film.mjs`：读 `film.json` 的镜头表，按帧选镜头、`update(t, f, ctx)`、每镜 `look(t)`；导出每帧的 `TEXTS` 给 QA。
- `npm run film -- build <作品> --renderer offscreen`（或作品描述里声明）：闸门、机器 QA、网页版照走现有链路。具体接法先读 `tools/film/` 与 `engine/render/` 再定，改出片工具要跑 agent 验收（AGENTS.md「治理改动」）。

### T6 验收片：模版的双实现版
- 新建作品 `films/<名字>/`，内容照模版，场景与镜头写成注入 THREE 的模块，GLSL 钩子与自写着色器各给 TSL 版；A 路线页面出片与模版逐像素对照（证明双实现没改画面），离屏出片与 A 路线逐帧对拍。
- 走 look → animatic → final 三道闸（用户原话）。
- 之后再决定要不要把路线模版本身换成双实现写法（那一步改模版，要过金标准审批）。

## 风险

1. **卡通材质的 fwidth 与投影**：GLSL 版大量用 `fwidth` 做抗锯齿羽化，WebGPU 的导数在 2×2 像素块上算，与 WebGL 通常一致但不保证；投影图的采样与偏移在两个后端可能差一个纹素。先测出差距再定阈值，不悄悄调到过。
2. **字形光栅化**：Skia（`@napi-rs/canvas`）与 Chrome 的字形渲染不会逐像素一致，片名题字的对拍只能看量级；QA 的读字与安全区检查用文字框，不受影响。
3. **范围**：实例化、蒙皮、`outlineVertex`、雾，模版用不到，M3 不做；`peng-glint` 那类作品要等 M4。
