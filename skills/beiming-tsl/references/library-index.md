# 北冥 TSL 模块与符号索引

由 `node tools/tsl-skill-index.mjs` 从 `engine/offscreen/tsl/*.js` 静态生成，不要手改；源码改了就重跑生成（漂移会被 `--check` 与 `tests/offscreen/tsl-skill.test.mjs` 拦下）。
模块职责、参数与调用时机见 [subject-routing.md](subject-routing.md)；怎么调试见 [workflow-and-debugging.md](workflow-and-debugging.md)。

| 模块 | 导出 | 依赖 | 摘要 |
|---|---|---|---|
| [`engine/offscreen/tsl/bloom.js`](../../../engine/offscreen/tsl/bloom.js) | `createBloom` | `engine/offscreen/tsl/pass.js` | bloom（TSL）：engine/look/bloom.js 的对应——软阈值预滤（4×4 盒）→ 13 抽头下采样 mip 链 → 帐篷上采样逐级混回（radius 决定大光晕的权重）。 |
| [`engine/offscreen/tsl/color.js`](../../../engine/offscreen/tsl/color.js) | `toColor`、`linVec`、`srgbVec`、`vec3Of` | — | 颜色参数换算（engine/look/params.js 的 r187 版：那份顶层 import 了仓库的 three r170，这里用宿主注入的 THREE）。 |
| [`engine/offscreen/tsl/compose.js`](../../../engine/offscreen/tsl/compose.js) | `createCompose` | `engine/offscreen/tsl/noise.js`、`engine/offscreen/tsl/pass.js`、`engine/offscreen/tsl/color.js` | 最终合成（TSL）：engine/look/compose.js 的对应——叠墨线 → 纸纹（支持 anchor 跟移与 refHeight 面积取样）→ 暗角 → 颗粒，输出 sRGB 数值。 |
| [`engine/offscreen/tsl/debug.js`](../../../engine/offscreen/tsl/debug.js) | `createDebugView`、`DEBUG_VIEWS` | — | 后期调试视图（TSL）：engine/look/debug.js 的对应——把中间缓冲画到输出看。 |
| [`engine/offscreen/tsl/fog.js`](../../../engine/offscreen/tsl/fog.js) | `fogUniforms`、`setFog`、`fogNodes`、`createFog` | `engine/offscreen/tsl/color.js`、`engine/offscreen/tsl/pass.js` | 空气透视雾（TSL）：engine/look/fog.js 的对应。 |
| [`engine/offscreen/tsl/grade.js`](../../../engine/offscreen/tsl/grade.js) | `createGrade` | `engine/offscreen/tsl/pass.js`、`engine/offscreen/tsl/color.js` | 调色（TSL）：engine/look/grade.js 的对应，常数与顺序逐项照搬——曝光 → 加 bloom → 白平衡（warmth）→ 饱和度 → lift/gamma/gain（2.2 伽马空间）→ 高光肩。 |
| [`engine/offscreen/tsl/idpass.js`](../../../engine/offscreen/tsl/idpass.js) | `createIdPass` | — | 物体 / 实例 ID 通道（TSL）：engine/look/ids.js 的对应。按 userData 开关把场景临时换成 ID 材质渲一遍，供屏幕空间墨线做边缘检测。 |
| [`engine/offscreen/tsl/ink.js`](../../../engine/offscreen/tsl/ink.js) | `boilSeed`、`inkTilePad`、`createInk` | `engine/offscreen/tsl/idpass.js`、`engine/offscreen/tsl/fog.js`、`engine/offscreen/tsl/noise.js`、`engine/offscreen/tsl/pass.js`、`engine/offscreen/gputimer.mjs` | 屏幕空间手绘墨线（TSL）：engine/look/ink.js 的对应，算法与常数逐项照搬。 |
| [`engine/offscreen/tsl/kuwahara.js`](../../../engine/offscreen/tsl/kuwahara.js) | `kuwaharaTaps`、`kuwahara` | — | Kuwahara 颜料笔触的 TSL 版：engine/look/kuwahara.js 的 GLSL（Papari 2007 的思路，8 扇区； |
| [`engine/offscreen/tsl/layers.js`](../../../engine/offscreen/tsl/layers.js) | `decodePng`、`loadLayers`、`createLayerLook` | `engine/offscreen/io.mjs`、`engine/offscreen/tsl/pass.js`、`engine/offscreen/tsl/noise.js`、`engine/offscreen/tsl/kuwahara.js`、`engine/offscreen/tsl/paper.js`、`engine/offscreen/tsl/color.js` | 分层风格化（TSL / WebGPU，同源跨端）：engine/look/layers.js 的对应实现。 |
| [`engine/offscreen/tsl/look.js`](../../../engine/offscreen/tsl/look.js) | `createLook`、`LOOKDEV_CACHE_KEYS` | `engine/look/index.js`、`engine/offscreen/tsl/ink.js`、`engine/offscreen/tsl/fog.js`、`engine/offscreen/tsl/grade.js`、`engine/offscreen/tsl/bloom.js`、`engine/offscreen/tsl/paper.js`、`engine/offscreen/tsl/compose.js`、`engine/offscreen/tsl/debug.js`、`engine/offscreen/tsl/kuwahara.js`、`engine/offscreen/tsl/pass.js`、`engine/offscreen/gputimer.mjs` | A 风格后期管线（TSL）：engine/look/index.js 的对应，按同一个顺序串起来： |
| [`engine/offscreen/tsl/noise.js`](../../../engine/offscreen/tsl/noise.js) | `noise` | — | 整数哈希与值噪声（TSL）：engine/look/glsl.js 的 HASH_NOISE 逐式照搬（PCG，Jarzynski & Olano 2020）。种子是整数，结果逐帧可复现。 |
| [`engine/offscreen/tsl/paper.js`](../../../engine/offscreen/tsl/paper.js) | `paperAnchor`、`canvasPaper`、`createPaper` | `engine/offscreen/tsl/pass.js`、`engine/offscreen/tsl/noise.js` | 纸纹（TSL）：engine/look/paper.js 的对应。 |
| [`engine/offscreen/tsl/pass.js`](../../../engine/offscreen/tsl/pass.js) | `createFullscreen`、`glCoord` | — | 全屏 pass 的公共底座：QuadMesh + NodeMaterial，把片元节点画进渲染目标（null = 当前宿主目标不动，用 draw(mat, target) 显式指定）。 |
| [`engine/offscreen/tsl/plates.js`](../../../engine/offscreen/tsl/plates.js) | `createPlates` | `engine/offscreen/io.mjs` | 底板面片（TSL / r187，同源跨端）：engine/stage/plates.js 的对应，同名同参数。面片都是 1×1 的单位平面，大小和位置交给 |
| [`engine/offscreen/tsl/surface.js`](../../../engine/offscreen/tsl/surface.js) | `patchLayer`、`muralLayer` | `engine/shade/surface.js`、`engine/shade/util.glsl.js` | 卡通材质的表面层（TSL）：engine/shade/surface.js 的对应，交给 tsl/toon.js 的 toonKind({ layers: [...] })。 |
| [`engine/offscreen/tsl/toon.js`](../../../engine/offscreen/tsl/toon.js) | `toonNoise`、`makeToonShared`、`useR170Shadow`、`toonKind`、`setToonShared`、`TOON_BASE` | `engine/shade/toon.js`、`engine/shade/patch.js` | 三档卡通材质（TSL）：engine/shade/toon.js 的对应。参数表（TOON_BASE）、乘法色调（tintFrom）、 |
