# 主题路由：视觉诉求 → 北冥 TSL 模块

按需求找行：左边是用户或导演口径的诉求，右边是真实模块、导出符号、典型参数与仓内可抄的真实用法。**所有符号名都来自当前源码**，与 [library-index.md](library-index.md) 同源核对（`node tools/tsl-skill-index.mjs --check` 拦漂移）；参数语义以模块文件头注释为准，不确定就打开文件读头注释。

## 总表

| 诉求（用户口径） | 主题 | 模块 · 导出 | 仓内示例 / 测试 |
|---|---|---|---|
| 接整条 A 风格后期管线、改组合顺序 | `look-pipeline` | [look.js](../../../engine/offscreen/tsl/look.js)：`createLook`、`LOOKDEV_CACHE_KEYS` | `films/chendu/offscreen.mjs`、`films/du/offscreen.mjs`、`tests/offscreen/look.test.mjs` |
| 屏幕空间手绘墨线、勾边 | `ink-outline` | [ink.js](../../../engine/offscreen/tsl/ink.js)：`createInk`、`boilSeed`、`inkTilePad` | `tests/offscreen/ink.test.mjs`、`ink-fast.test.mjs`、`mrt.test.mjs` |
| 哪些物体描边 / 挡线 / 逐实例 | `id-pass` | [idpass.js](../../../engine/offscreen/tsl/idpass.js)：`createIdPass` | `tests/offscreen/idpass.test.mjs`、`mrt.test.mjs` |
| Kuwahara 颜料笔触、远景大笔触 | `kuwahara-brush` | [kuwahara.js](../../../engine/offscreen/tsl/kuwahara.js)：`kuwahara`、`kuwaharaTaps` | `tests/offscreen/kuwahara.test.mjs`、`kuwahara-fast.test.mjs` |
| 三档卡通分阶、边缘光、阴影 | `toon-bands` | [toon.js](../../../engine/offscreen/tsl/toon.js)：`toonKind`、`makeToonShared`、`setToonShared`、`useR170Shadow`、`toonNoise` | `films/chendu/world.js`、`tests/offscreen/toon.test.mjs` |
| 锈斑、藻斑、壁画风化、表面噪波 | `surface-texture` | [surface.js](../../../engine/offscreen/tsl/surface.js)：`patchLayer`、`muralLayer`；[noise.js](../../../engine/offscreen/tsl/noise.js)：`noise` | `tests/offscreen/toon.test.mjs` |
| 纸纹、宣纸画布、颗粒 | `paper-grain` | [paper.js](../../../engine/offscreen/tsl/paper.js)：`createPaper`、`canvasPaper`、`paperAnchor` | `tests/offscreen/paper.test.mjs`、`paper-debug.test.mjs` |
| 空气透视雾、远景大气 | `fog-atmosphere` | [fog.js](../../../engine/offscreen/tsl/fog.js)：`createFog`、`fogUniforms`、`setFog`、`fogNodes` | `tests/offscreen/fog.test.mjs` |
| 辉光、灯点光晕 | `bloom-glow` | [bloom.js](../../../engine/offscreen/tsl/bloom.js)：`createBloom` | `tests/offscreen/look.test.mjs` |
| 曝光、白平衡、lift/gamma/gain | `color-grade` | [grade.js](../../../engine/offscreen/tsl/grade.js)：`createGrade` | `tests/offscreen/look.test.mjs` |
| 底板 PNG、多层视差、裁片、辉光面片 | `plates-composite` | [plates.js](../../../engine/offscreen/tsl/plates.js)：`createPlates`（`plate`、`cropPlate`、`cutoutPlane`、`glowSprite`、`canvasLayer`…） | `films/chendu/offscreen.mjs`、`tests/offscreen/plates.test.mjs` |
| 诊断视图（id/depth/edge/line…） | `debug-views` | [debug.js](../../../engine/offscreen/tsl/debug.js)：`createDebugView`、`DEBUG_VIEWS` | `tests/offscreen/paper-debug.test.mjs` |
| 外部渲染器分层图 → 北冥画风 | `layer-look` | [layers.js](../../../engine/offscreen/tsl/layers.js)：`createLayerLook`、`loadLayers`、`decodePng` | `tests/offscreen/layers.test.mjs` |

底座（写新 pass 时用）：[pass.js](../../../engine/offscreen/tsl/pass.js) 的 `createFullscreen` / `glCoord`、[color.js](../../../engine/offscreen/tsl/color.js) 的 `toColor` / `linVec` / `srgbVec` / `vec3Of`。

## look-pipeline　整条后期管线

`engine/offscreen/tsl/look.js` 的 `createLook({ THREE, TSL, renderer }, { width, height, ss, msaa, refHeight, fps, defaults, paper, fogColor })` → `{ render(scene, camera, p), node, output, dispose }`。组合顺序固定（改顺序=改画风，要过风格基线）：

① 主场景（HalfFloat 线性 HDR + 深度纹理，`ss=1 && msaa=0` 且本帧开墨线时走 MRT 同遍写 ID）→ ② ID 图 → 边缘 → 笔画（ink.js）→ ③ 雾（fog.js）→ bloom（bloom.js）→ 调色（grade.js）→ 输出变换（线性→sRGB 数值）→ ④ Kuwahara（sRGB 空间，远景换半径）→ 叠墨线 → 纸纹 → 暗角 → 颗粒，或 `p.debug` 调试视图。每帧 `look.render(scene, camera, 镜头 look 参数)`；参数键（`outline`、`kuwahara`、`bloom`、`grade`、`fog`、`paper`、`vignette`、`grain`、`grainSize`、`grainHold`、`debug`、`t`）与默认值合并用 `engine/look/index.js` 的 `lookDefaults` / `lookParams`，不要自己抄一份语义。`renderer.toneMapping` 必须是 `NoToneMapping`，否则抛 `unsupported.look`。作品侧的标准接法见 `films/chendu/offscreen.mjs`：`createFilm({ ... })` → `film.work({ shots, look, draw })`。

`LOOKDEV_CACHE_KEYS` 是 lookdev 快照的白名单（`grade`、`fog`、`bloom`、`kuwahara`、`paper`、`vignette`、`grain`、`outline`），出现白名单外键 fail-closed 退回全量渲染（`tests/offscreen/lookdev-cache.test.mjs`）。

## ink-outline　墨线勾边

`engine/offscreen/tsl/ink.js` 的 `createInk({ THREE, TSL, renderer }, { width, height })`（width×height = 输出 × ss）→ `{ render({ scene, camera, p, fog, fogColor, t, k, ss, fps }), renderMrt, line, idTarget, ... }`。管线内部由 look.js 调用，作品一般不直接碰；要调的是镜头 look 参数 `outline` 的字段（像素量按标定高度给，内部乘 k·ss）：`width`、`wobble`、`warp`、`boilFps` / `boilHold`（沸腾种子，`boilSeed(t, p, fps)` 同拍不动）、`pressure`、`breakup`、`inner`、`silhouette`、`depthThreshold`、`near` / `far` / `farScale`（远景线宽衰减）、`opacity`、`fogFade`（线在雾里变淡）、`color` / `tint` / `darken`（合成阶段吃墨色）。边缘 = ID 跳变（近侧拥有线）+ 深度二阶差分折痕；笔画 = 圆头笔 + 域扭曲抖动 + 笔压 + 断线，性能版与旧实现逐像素对拍（`tests/offscreen/ink-fast.test.mjs` 的 fixtures/ink-legacy.js）。

## id-pass　物体 / 实例 ID 通道

`engine/offscreen/tsl/idpass.js` 的 `createIdPass({ THREE, TSL, renderer })` → `{ collect(scene), render(scene, camera, target, plan?), renderMrt(...), dispose }`。作品侧不直接调，而是给 `Object3D.userData` 写开关（子物体继承，显式写了以子物体为准）：`outline`、`outlineWidth`、`outlineAlpha`、`outlineGroup`（同组不出线）、`outlinePerInstance`（InstancedMesh 默认逐实例连续 ID）、`outlineVertex: { tsl }`（自定义顶点位移节点，只给 GLSL 会抛 `unsupported.outline`）、`outlineOccluder`（`'auto' | 'solid' | 'soft' | 'own' | false`）、材质级 `userData.noId`。不支持 BatchedMesh、多材质数组（抛错不静默画错）。MRT 单遍只在 `ss=1 && msaa=0` 且场景全部物体满足严格等价条件时启用，否则回退双遍（`tests/offscreen/mrt.test.mjs`）。

## kuwahara-brush　Kuwahara 笔触

`engine/offscreen/tsl/kuwahara.js`：`kuwahara(TSL, { input, KR, radius, q, strength, texel, far })` → vec4 节点（在 **sRGB 数值空间**做，输入 alpha 是灯点保护量）；`kuwaharaTaps(KR)` 是编译期格子表（KR 整数 2..10，每个 KR 一个着色器变体）。`far = { depth, radius, start, end, near, farClip }` 让远景换更大笔触（透视相机才用；深度 ≥ 0.9999999 当无穷远；KR 自己按 `ceil(max(radius, far.radius))` 取）。作品侧调镜头 look 参数 `kuwahara`：`radius`、`farRadius`、`farStart`、`farEnd`、`q`、`strength`、`protect`。look.js 里 KR 变体按需编译并缓存。

## toon-bands　三档卡通分阶

`engine/offscreen/tsl/toon.js`：`toonKind({ THREE, TSL }, spec)` → `{ make(opts), bind(mesh, mat, opts), shared }`。`spec`：`name`、`shared`、`firstId`、`featherMin`、`bandAA`、`skyStepUniform`、`rimCore`、`layers`（表面层，见 surface-texture）。`make(opts)` 的键在 `TOON_BASE` 参数表里（`color`、`shade1` / `shade1Tint`、`step1` / `feather1`、`step2` / `feather2`、`shadowDepth`、`castShade`、`shadowLo` / `shadowHi`、`edgeNoise` / `edgeNoiseScale`、`rimColor` / `rimAmt` / `rimPower` / `rimInside` / `rimDirK`、`rimLitColor` / `rimLitAmt`、`fillColor` / `fillAmt` / `fillStep`、`skyTint` / `skyAmt`、`inkColor`、`objectId`、`outlineW`、`rest`、`translucent` / `transparent`、`vertexColors`、`instanceId`、`tsl` 钩子）。GLSL 钩子（`vertexPars`、`fragmentAlbedo` 等）没给 `opts.tsl` 版会抛 `unsupported.toon`，不静默少画。共享状态：`makeToonShared({ THREE, TSL }, { fillDir, skyDir, keyDir })` 建 uniform 组，`setToonShared(S, g)` 运行时改（`engine/shade/toon.js` 导出、这里转出口）；主光投影必须先 `useR170Shadow(TSL, light)`（r170 PCFSoft 同式滤波，`shadow.intensity` 只支持 1）。真实用法：`films/chendu/world.js`。

## surface-texture　噪波与表面质感

`engine/offscreen/tsl/surface.js`：`patchLayer({ rust, core, algaeK })`（植被斑驳 dab、锈斑 rust（可带斑心 core）、藻斑、小斑点）与 `muralLayer`（褪色大斑、干笔飞白、剥落块、氧化暗斑、细碎点），作为 `toonKind({ layers: [...] })` 的表面层；参数与默认值同 GLSL 版（`rustAmt`、`rustThr`、`algaeAmt`、`spotAmt`、`muralAmt`、`fleckThr`…见 `make(opts)` 合并后的参数表）。底层噪波：`noise.js` 的 `noise(TSL)` → `{ pcgh, h21, vnoise }`（PCG 整数哈希 + 五次插值值噪声，种子是整数、逐帧可复现）；`toon.js` 的 `toonNoise(TSL)` → `{ hash33, noise, fbm }`（材质钩子 `opts.tsl` 的 `c.noise` 就是它）。

## paper-grain　纸纹与颗粒

`engine/offscreen/tsl/paper.js`：`createPaper({ THREE, TSL, renderer }, { refHeight, image })` → `{ resize, prepare, layer, mid, procMid, target, dispose }`。程序化纸纹（1 像素颗粒 + 颗粒团 + 纸齿浮雕 + 斑驳 + 纤维）为默认；图片纸纹构造时给 `image = { tex, mid }` 或每帧 `p.tex / p.mid`（PNG 要先用 `engine/offscreen/paper.mjs` 的 `loadPaper` 解码成 `{ tex, mid }`，不支持渲染期传 `paper.url` 字符串）。`canvasPaper(THREE, canvas, { strength })` 把画布（如 xuanPaper）变纸纹层；`paperAnchor(now, ref)` 让纸纹跟镜头推拉摇移（`{ pos, origin, zoom }`）。`scaleMode`：`'pixel'`（默认，整数倍 kp）与 `'refHeight'`（连续倍率 + 合成阶段面积取样）。颗粒在 compose.js：`grain`、`grainSeed`（`engine/look/index.js` 的 `grainSeedOf(t, fps, grainHold)`，`grainHold` 整数帧换种）、`grainCell`（`grainCellOf(grainSize, k, kp)`）。

## fog-atmosphere　空气透视雾

`engine/offscreen/tsl/fog.js`：`createFog({ THREE, TSL, renderer }, { width, height })` → `{ render(src, depthTex, fog, camera, target, fallbackColor), dispose }`；`fogUniforms` / `setFog(THREE, u, fog, camera, fallbackColor)` / `fogNodes(TSL, u)` 供墨线共用同一雾量公式做远雾淡出。参数：`color`、`colorHigh`、`density`（默认 .02）、`start`、`max`、`baseHeight` / `falloff`（越低越浓）、`cutoff`、`sky`（清屏处浓度）。雾量随真实视空间距离与世界高度变化，重建视空间与世界坐标用投影逆矩阵。

## bloom-glow　辉光

`engine/offscreen/tsl/bloom.js`：`createBloom({ THREE, TSL, renderer }, { levels, minSize, refHeight })` → `{ resize, render(src, { threshold, knee, radius }), skip, levels, dispose }`。软阈值预滤（4×4 盒）→ 13 抽头下采样 mip 链 → 帐篷上采样逐级混回；`refHeight` 给了时换分辨率光晕一致。作品侧调镜头 look 参数 `bloom`：`strength`、`threshold`、`knee`、`radius`、`tint`；灯点不被 Kuwahara 抹糊靠 grade.js 的 `protect`（高光保护量写进 alpha）。

## color-grade　调色分级

`engine/offscreen/tsl/grade.js`：`createGrade({ THREE, TSL, renderer }, { width, height })` → `{ render({ src, bloom, bloomAmount, bloomTint, grade, protect }, target), output, dispose }`。顺序固定：曝光 → 加 bloom → 白平衡（warmth）→ 饱和度 → lift/gamma/gain（2.2 伽马空间）→ 高光肩；线性进线性出。作品侧调镜头 look 参数 `grade`：`exposure`、`warmth`、`saturation`、`lift`、`gamma`、`gain`、`shoulder`。

## plates-composite　底板与多图层合成

`engine/offscreen/tsl/plates.js`：`await createPlates({ THREE, TSL })` → `{ loadPlates, loadPlatesAsync, loadTextureAsync, plateMat, plate, plateCopy, tileRepeat, canvasLayer, cropPlate, cutoutPlane, glowSprite }`。面片都是 1×1 单位平面，摆位交给 `engine/stage/camera.js` 的 placeOnScreen；全部不描边（`userData.outline = false`）、不吃雾。`plate` 直通 alpha；`cropPlate(map, rect, { soft, flip, tint })` 椭圆软边裁片；`cutoutPlane` 彩色层 + 只写深度的遮罩层（更远的透明底板 order 要小于 `order - 0.5`）；`glowSprite(color, { amt, core, squash })` 加色辉光；`canvasLayer(w, h)` Node 用 @napi-rs/canvas、浏览器用原生 canvas。贴图 sRGB、flipY、mip + 三线性 + 各向异性 8。底板清单 `assets/plates/plates.json`；工具 `npm run plates:check` / `plates:bleed`。

## debug-views　诊断调试视图

`engine/offscreen/tsl/debug.js`：`createDebugView({ THREE, TSL }, { width, height, depthTexture })` → `{ node, update(mode, buffers, camera), dispose }`。`DEBUG_VIEWS = ['id', 'depth', 'edge', 'line', 'bloom', 'paper', 'kuwahara', 'scene']`，未知视图名退回 kuwahara。用法：镜头 look 参数 `debug: 'edge'`（look.js 里 `p.debug` 切换），bloom 视图自动 ×4。深度纹理不能绑进普通颜色采样槽（WGSL 限制），单独走构造时绑定的 depthTexture。

## layer-look　外部分层图 → 北冥画风

`engine/offscreen/tsl/layers.js`：`loadLayers(dir, frame)` 读 `<dir>/<6 位帧号>.png / .depth.png / .object_index.png / .view_normal.png / meta.json`（16 位深度按 `meta.json` 的 `depth_unit_m` 换米）；`createLayerLook({ THREE, TSL, renderer }, w, h, opts)` → `{ render(layers, p), node, output, dispose }`。流程：4 邻域物体编号不连续（近侧拥有线）+ 1/z 二阶差分折痕 + 法线夹角内线 → 圆头笔域扭曲抖动与笔压 → 保色相多档色阶 → Kuwahara → 纸纹。`p`：`{ t, view: 'final'|'color'|'ids'|'edge'|'toon', split, outline, toon, kuwahara, paper, target }`。纯自写宽松许可代码，不依赖 `engine/native/`（D03 / D12 许可边界）。
