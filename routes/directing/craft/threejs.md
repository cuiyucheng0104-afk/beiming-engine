# three.js r170 实践

> 适用：**A 北冥风格路线 · WebGL 三渲二** 的执行层——渲染器、色彩、材质补丁、实例化、阴影、后期、资源与调试。路线身份由美术与制作体系决定，three 只是 A 路线当前的执行依赖（`ROUTES.md:40`）。
> 解决什么：在锁定的 three 0.170.0 上安全地扩展材质、保住色板、让形变在彩色/投影/墨线三处一致，并知道升级时会坏在哪里。着色美学见 [toon.md](toon.md)，2.5D 摆位见 [two-five-d.md](two-five-d.md)，出片与色彩交付见 [video.md](video.md)。
> 怎么用：先读"要点速查"十二条；改材质读 §3；改后期读 §6；升级 three 按 §1.5；排查查 §9。
> 标注与术语统一见 [README](README.md)：【仓库实证】（含·复算／·渲染／·实测／·文档／·代码）、【通用工艺】、【推断】、【未实现】（正文里不加括号的"未实现"同义）。`$甲`、`$乙`、`<研究工作区>` 三个路径缩写的展开见本章「出处与许可」与 README。基线 `origin/main 3b97946`，只读检出。
> 本章没有启动 GPU 渲染。唯一执行的命令是一次 Node 下的锚点干跑（§1.4），不写入仓库。本章里 `node_modules/three/...` 指 lockfile 锁定的 three 0.170.0 安装（`package-lock.json:28-32`；§1.4 输出 `REVISION 170`），不进 git。

## 0. 路径缩写与适用范围

路径缩写：

- `src/`、`lab/` 下的文件一律写全路径。
- 不带目录的引擎文件指 `engine/` 下对应的层：
  - shade：`patch.js`、`toon.js`、`surface.js`、`noise.glsl.js`、`util.glsl.js`
  - look：`index.js`、`ids.js`、`ink.js`、`bloom.js`、`grade.js`、`fog.js`、`compose.js`、`kuwahara.js`、`paper.js`、`params.js`、`pass.js`、`debug.js`、`glsl.js`
  - stage：`film.js`、`plates.js`、`dome.js`、`camera.js`、`outline.js`
  - form：`scatter.js`、`bend.js`
  - render：`page.mjs`、`still.mjs`、`video.mjs`
  - production：`project.js`
- 其它缩写：
  - `gpucheck.mjs` 指 `tools/rtx/gpucheck.mjs`。
  - `contracts.md`、`validation-and-rtx.md` 指 `docs/routes/` 下的同名文件。
  - `WebGL*.js`、`Material.js` 指 `node_modules/three/src/` 下的同名文件。
  - `OutputPass.js`、`Pass.js` 指 `node_modules/three/examples/jsm/postprocessing/`。
  - `ShaderChunk/…`、`ShaderLib/…`、`meshtoon.glsl.js`、`depth.glsl.js`、`shadowmap_*.glsl.js`、`lights_*.glsl.js` 指 `node_modules/three/src/renderers/shaders/` 下的文件。

适用范围：

- 本章只讲 A 路线（北冥风格路线 · WebGL 三渲二）。B 路线（北冥原生路线 · BNE）用 WESL 与原生材质，本章的 GLSL 不能直接搬过去【仓库实证】AGENTS.md:39；docs/routes/beiming-style.md:184。
- B 路线的资产桥也用同一份 three 导出 GLB【仓库实证】examples/raea/tools/export-kun-browser.mjs:1-5；examples/raea/tools/export-kun.mjs:39（内部目录名沿用历史代号）。所以升级 three 会同时影响 B 路线的资产导出（§1.5 第 8 步）。
- C 路线（北冥代码动画风格 · 86 式）是方法资料层，不是第三套后端（docs/TRACKS.md:43）。`cases/source` 里用到 three 的历史作品各自锁定版本，例如 `cases/source/local-threejs-demo/package.json:15`（^0.183.2）、`cases/source/local-clapperboard-3d/index.html:56`（CDN 0.160.0）、`cases/source/lab-2026-11-05-beiming-nine-3d/package.json:15`（0.170.0，自带一份 engine 副本）。还原后按各自的版本运行（AGENTS.md:57），不要套用本章的 r170 锚点约定。`historical-render` 只说明出过片，不代表用户认可（AGENTS.md:58）。

## 要点速查（给进入仓库的 agent）

1. three 锁定 `0.170.0`。升级要作为独立任务做：改版本 → Node 干跑 → 浏览器控制台 → 对照帧 → 全片（§1）。
2. 改内置材质只走 `engine/shade/patch.js` 的 `inject`，锚点缺失时它会直接报错。不要用裸 `String.replace` 绕过（§1.2、§3.1）。
3. 每个材质族用唯一的 `name`。凡是会改动 GLSL 文本的选项（钩子、defines），都要进 `programKey`（§3.2）。
4. 渲染器固定输出 sRGB、`NoToneMapping`、像素比 1。在 look 管线里，材质上的 `toneMapped:false` 不起作用（§2）。
5. 颜色贴图标 sRGB，数据贴图标 NoColorSpace。2D 画布层按实际像素建，即设计尺寸乘 K（§2.3、§2.4）。
6. 后期在 OutputPass 之前是线性空间，之后是 sRGB 编码值。颜色参数按所在空间选 `linVec` 或 `srgbVec`。OutputPass 之后不要再编码（§6.3）。
7. 顶点形变必须三处一致：主材质、`customDepthMaterial`、ID 通道的 `outlineVertex`。用 `bindToon` 加 `wireOutlines` 完成。另一种做法是改用 CPU 形变加 `aRest`（§3.4）。
8. 共享 uniform 只改 `.value`。镜头每帧整组写全（§3.3）。
9. ID 图用 Nearest 过滤、不开 MSAA、用 `texelFetch` 读取。实例之间要不要出线，由 `instanceId`、`outlinePerInstance`、`outlineGroup` 决定（§4）。
10. 主光是第一盏投影平行光。r170 的 PCFSoft 不读 `shadow.radius`。`fitShadow` 每帧贴合，`normalBias` 按模型尺度给（§5）。
11. 透明物体显式写 `renderOrder`；双面透明可考虑 `forceSinglePass`（§7.2、§9）。
12. 着色器编译错误、软件渲染、版本警告都不会让渲染自动失败。交付前要自己看 stderr 里的 `[页面]` 行和 GPU 串（§1.3、§7.5）。

---

## 1. 版本固定与升级

### 1.1 固定在哪里

| 位置 | 内容 | 证据 |
|---|---|---|
| package.json | `"three": "0.170.0"`，精确版本，不带 `^` | 【仓库实证】package.json:26 |
| package-lock.json | 解析地址与 integrity | 【仓库实证】package-lock.json:28-32 |
| 页面 importmap | `three` 与 `three/addons/` 都指向本地 `/node_modules`，不走 CDN | 【仓库实证】index.html:4-6 |
| 运行时自检 | `THREE.REVISION !== '170'` 时 `console.warn` | 【仓库实证】engine/shade/patch.js:18 |
| 项目记录 | Three 后端必须填 `runtime.three` | 【仓库实证】engine/production/project.js:213；docs/routes/templates/project-beiming.json:8 |
| 对外说明 | README 徽章 r170；B 路线说明表 | 【仓库实证】README.md:16；docs/raea/README.md:26；docs/raea/architecture.md:17 |

【通用工艺】精确版本、lockfile、本地 importmap 三处一起锁：npm 不会漂到别的补丁版本，页面也不会从 CDN 拉到另一版。three 的 npm 版本号 `0.NNN.x` 对应 `REVISION 'NNN'`。

### 1.2 为什么必须固定：补丁依赖的不止锚点

`inject(src, anchor, code, mode, who)` 找不到锚点时抛错，报错信息里带调用方和当前 revision【仓库实证】engine/shade/patch.js:20-24。仓库用到的锚点在 r170 中的位置如下。

| 锚点 | 用途 | 注入方 | r170 位置（node_modules/three/src/renderers/shaders/…） |
|---|---|---|---|
| `#include <common>`（顶点、片元） | 声明 uniform、varying、函数 | patch.js:34；toon.js:236 | ShaderLib/meshtoon.glsl.js:6、58；ShaderLib/depth.glsl.js:2 |
| `void main() {`（顶点） | `vertexMainStart`，例如先把实例矩阵弯好 | patch.js:35 | meshtoon.glsl.js:19；depth.glsl.js:16 |
| `#include <beginnormal_vertex>` | 改 `objectNormal`，可选 | patch.js:36（锚点存在才注入） | meshtoon.glsl.js:27；depth 只在 `USE_DISPLACEMENTMAP` 分支里有 |
| `#include <begin_vertex>` | 改 `transformed`（形变） | patch.js:37 | meshtoon.glsl.js:34；depth.glsl.js:33 |
| `#include <project_vertex>` | 写 `vToonInst` | patch.js:38；toon.js:76 | meshtoon.glsl.js:38 |
| `#include <shadowmap_pars_fragment>` | 整段换成量化版 | patch.js:46 | meshtoon.glsl.js:76 |
| `return mix( 1.0, shadow, shadowIntensity );` | 投影结果过 `smoothstep(lo, hi)` | patch.js:42-47 | ShaderChunk/shadowmap_pars_fragment.glsl.js:202、322 |
| `#include <color_fragment>` | 反照率与表面层 | toon.js:238 | meshtoon.glsl.js:92 |
| `#include <normal_fragment_maps>` | 法线钩子 | toon.js:239 | meshtoon.glsl.js:97 |
| `vec3 outgoingLight = …;` | 整行换成三档合成 | toon.js:78、240 | meshtoon.glsl.js:109 |
| `#include <dithering_fragment>` | 输出模式（法线加 ID） | toon.js:241 | meshtoon.glsl.js:116 |

锚点检查覆盖不到下面五类耦合。升级时这些问题会以着色器编译失败或画面变化的形式出现，不会以锚点报错的形式出现。

1. **注入代码直接调用 three 的内部名字**【仓库实证】：
   - `getShadow(…, shadowIntensity, …)` 的参数表：toon.js:116 ↔ ShaderChunk/shadowmap_pars_fragment.glsl.js:109。
   - `DirectionalLightShadow` 的字段：shadowmap_pars_fragment.glsl.js:21-27。
   - `geometryViewDir`：toon.js:106 ↔ ShaderChunk/lights_fragment_begin.glsl.js:18。
   - `receiveShadow`：toon.js:116 ↔ ShaderChunk/lights_pars_begin.glsl.js:2。
   - `directionalLights[ 0 ]`：toon.js:109。
2. **ShaderMaterial 直接 `#include` 内部块**【仓库实证】：ID 通道的顶点着色器引用了 `batching_*`、`morphinstance_vertex`、`skinning_*`（engine/look/ids.js:25-42）。块不存在时 three 抛 `Can not resolve #include <…>`（node_modules/three/src/renderers/webgl/WebGLProgram.js:284）。
3. **深度打包方式与 r170 的阴影实现配套**【仓库实证】：自定义深度材质用 `RGBADepthPacking`（patch.js:52），与 three 自己的默认深度材质一致（node_modules/three/src/renderers/webgl/WebGLShadowMap.js:24）。【通用工艺】若后续版本改变阴影贴图的存储方式，`depthPacking` 要一起核对。
4. **addons 的行为**【仓库实证】：OutputPass 按 `renderer.toneMapping` 和 `outputColorSpace` 重建 defines（node_modules/three/examples/jsm/postprocessing/OutputPass.js:51-58）。
5. **绕开 inject 的裸替换**【仓库实证】：src/kun_peng.js:900-904 用 `String.replace` 改 toon 片元。找不到原文时它不报错，只是静默失效，而且沿用原来的缓存键。lab/look.js:46-66 也是这种写法（自测页）。升级后这两处要人工核对。docs/raea/architecture.md:142 也要求升级时一起检查深度 shader。

### 1.3 三种失败形态：升级后去哪里看

| 形态 | 触发 | 表现 | 离线渲染能否发现 | 证据 |
|---|---|---|---|---|
| 锚点缺失 | `inject` / `quantizeShadow` 抛错 | 材质第一次编译时抛错，预热阶段就中断 | 能。页面错误，或 180 秒内等不到 READY，都会让脚本失败 | 【仓库实证】patch.js:21、45；engine/render/page.mjs:74、83；film.js:51 |
| GLSL 编译或链接失败 | 内部函数改签名、变量改名、块改名 | three 输出 `console.error` 的 Shader Error；该物体不画，渲染照常继续 | 只能在 stderr 的 `[页面]` 行里看到；帧数照样正常 | 【仓库实证】node_modules/three/src/renderers/webgl/WebGLProgram.js:943；page.mjs:75；docs/routes/validation-and-rtx.md:332；docs/routes/contracts.md:150 |
| 警告 | REVISION 不符、弃用、精度降级 | `console.warn` | 看不到：page.mjs 只转发 error 级别 | 【仓库实证】patch.js:18；page.mjs:75；node_modules/three/src/renderers/webgl/WebGLCapabilities.js:84-89 |

【通用工艺】因此升级验收要做两件事：把 stderr 里的 `[页面]` 行视为失败；另外在可见的浏览器里打开控制台，或者临时写一个转发 warning 的脚本来看警告。仓库现有的脚本不转发警告（未实现）。three 提供 `renderer.debug.onShaderError` 钩子（WebGLProgram.js:932-934），可以把编译错误改成直接抛错。仓库没有接这个钩子（未实现）。

### 1.4 r170 现状核对（命令输出）

脚本 `<研究工作区>/scripts/three/anchor-dryrun.mjs` 在 Node 里加载锁定的 three，读取 `ShaderLib.toon` / `ShaderLib.depth` 的源码文本，用仓库自己的工厂函数构建各鲲变体，再逐个调用每个材质的 `onBeforeCompile`。输出保存在同目录的 `anchor-dryrun.out.txt`。关键行如下（行尾括号里是本章加的注释，`…` 表示省略的同类行）：

```text
REVISION 170
anchor … OK                      （15 个锚点全部命中）
shadow anchor count 2            （getShadow 与 getPointShadow 各一处）
getShadow has shadowIntensity param true
PCF_SOFT branch reads shadowRadius false
geometryViewDir defined true / uniform bool receiveShadow true
chunk batching_pars_vertex … packing OK（ID 通道用到的块都在）
default customProgramCacheKey onBeforeCompile( /* shaderobject, renderer */ ) {}
variant src/kun_bronze.js SKIP（Node 下无法构建） document is not defined
patched toon materials 107 custom depth materials 42 instanced meshes 34 inject failures 0
distinct program keys 70 keys mapping to >1 patched source 0
distinct patched sources 69 distinct keys if customProgramCacheKey were left default 3
```

【仓库实证】读法：

- 6 个鲲变体里有 5 个能在 Node 下构建，`kun_bronze` 需要 `document`，所以跳过了。
- 107 个补丁材质和 42 个深度材质的注入全部成功。
- 70 个缓存键里，没有一个键对应两份不同的补丁源码。
- 如果不设 `customProgramCacheKey`，69 份不同的源码只会落到 3 个默认键上（§3.2）。

这次干跑只证明文本注入成功、缓存键与源码一一对应。它没有编译 GLSL，也不证明画面一致。

### 1.5 升级流程（建议，仓库没有自动化）

1. **在 r170 上先出基准。** 用同一台机器、同一个 ANGLE 后端。
   - 时间用整数帧 `f/24`，不要用两位小数的秒数（docs/routes/validation-and-rtx.md:183；engine/render/still.mjs:14 的 `--range` 用 `toFixed(2)`）。镜头表是 A 0–3 s、B 3–5 s、C 5–10 s（src/main.js:40）。建议取帧 0、36、71 | 72、96、119 | 120、180、239，即每镜首、中、尾，外加切点两侧。另外加上已发布静帧的时刻 1.6、4.0、7.6、9.9（media/shot_*.jpg）。其中 1.6、7.6、9.9 不在整数帧上，只用于和已发布静帧做目视对照。
   - 加 `nohud=1`（src/main.js:42），排除显示层文字。文字光栅化是跨平台差异的主要来源（docs/渲染与4K.md:56）。
   - 关键帧再各出一组中间缓冲：`dbg=id|edge|line|depth`（src/main.js:39；engine/look/debug.js:29）。差异出现时可以据此定位到层。
   - 自测页也要出：`?test=look`、`?test=kun` 等（src/boot.js:1-5）。lab/look.js 覆盖了 CUTOUT、`own` 挡线和 `onBeforeRender` 保护（lab/look.js:11-12）。
   - 示例：`node engine/render/still.mjs . 3 5 --query 'nohud=1&dbg=edge' --out out/upgrade-base`。注意 still.mjs 只输出 JPEG（still.mjs:24），只适合定位问题。严格比对需要无损 PNG，要自己写 `openFilm → render(f/24) → PNG`（validation-and-rtx.md:214、220）。仓库还没有这个工具，`tools/qa/` 不存在，属于计划中的 V02（validation-and-rtx.md:384）。
2. **改版本。** 修改 package.json:26 和 lockfile（`npm install three@0.x.y --save-exact`）。importmap 不用改（index.html:4-6）。
3. **改自检。** 修改 patch.js:18 里的 `'170'`，以及写着 r170 的注释（patch.js:1、toon.js:1）。然后先跑 §1.4 那种 Node 干跑：不占 GPU，就能先发现锚点问题和缓存键问题。
4. **在可见浏览器里打开控制台，跑一遍正片和所有自测页。** 逐个处理抛错、Shader Error 和弃用警告（§1.3）。
5. **出同一批帧做差分。** 同设备、同后端时先要求像素一致。做不到时，validation-and-rtx.md:220 给了一个暂定阈值：最大通道差 ≤2/255，且差超过 1/255 的像素比例 ≤0.1%。这个阈值本身还是待验证的建议。同时按 docs/routes/beiming-style.md:140-147 的六层顺序逐层看。
6. **跑全片。** `npm run video` 之后检查 stderr、帧数和完整视频（AGENTS.md:48）。
7. **更新记录。** README.md:16、docs/raea/README.md:26、docs/raea/architecture.md:17，以及模板里的 `runtime.three`（docs/routes/templates/project-beiming.json:8）。
8. **重跑 B 路线资产桥。** 它的 GLB 导出用的是同一份 three，需要重跑导出、结构验证和动画回读（AGENTS.md:47）。`cases/source` 里自带 engine 副本的作品不随主线升级。

未实现：没有工具检查 `runtime.three` 是否与已安装版本、`THREE.REVISION` 一致（project.js:213 只检查字段是否存在）。

---

## 2. 渲染器与色彩

### 2.1 渲染器设置

| 设置 | 理由 | 证据 |
|---|---|---|
| `antialias:false` | 抗锯齿由场景目标的 MSAA 和墨线超采样负责；最后一道是全屏三角形，默认帧缓冲不需要 MSAA | 【仓库实证】film.js:23；engine/look/index.js:11-12、81 |
| `preserveDrawingBuffer:true` | 截图发生在 `render(t)` 返回之后，保留绘图缓冲，避免合成后被清掉而拍到空帧 | 【仓库实证】film.js:23；still.mjs:22-24；video.mjs:35-36。理由属【通用工艺】 |
| `powerPreference:'high-performance'` | 只是给浏览器的提示。无头 Chrome 里实际落在哪块 GPU 由 ANGLE 后端决定 | 【仓库实证】film.js:23；docs/RTX工作站.md:7-15 |
| `setPixelRatio(1)`、`deviceScaleFactor:1` | 画布像素等于输出像素（§2.4） | 【仓库实证】film.js:24；page.mjs:73 |
| `outputColorSpace = SRGBColorSpace`、`toneMapping = NoToneMapping` | 线性工作流，保色板（§2.2） | 【仓库实证】film.js:2、25 |
| 阴影：开启，默认 PCFSoft | §5 | 【仓库实证】film.js:19、26 |
| 显示层是独立的 2D 画布（z-index 10） | 导演规则：显示层最后叠加，不加颗粒，不受泛光影响 | 【仓库实证】film.js:2、30-33；docs/作品.md:47-50 |

### 2.2 色彩流水线

```text
色板十六进制（sRGB）……………… src/toon.js:13-20（导演定调给定）
  └ THREE.Color / colorOf → 线性工作空间 …… patch.js:30；toon.js:205、213
三档卡通着色（线性）
  └ 渲进 T.scene（HalfFloat 线性 HDR，MSAA）
     渲到渲染目标时，材质既不做色调映射也不做 sRGB 编码
     …… node_modules/three/src/renderers/webgl/WebGLPrograms.js:165-171、202
雾 → bloom → 调色（线性进、线性出）……… engine/look/index.js:121-125；grade.js:1-2
  └ OutputPass：toneMapping=No 不压；outputColorSpace=sRGB 编码 → T.out
     …… engine/look/index.js:126；OutputPass.js:51-66
Kuwahara（sRGB 空间）→ 合成（墨色用 srgbVec）…… kuwahara.js:2；compose.js:59；params.js:20
  └ 画到屏幕：FINAL_FS 里没有 colorspace_fragment，不再编码 …… compose.js:19-49
无头 Chrome --force-color-profile=srgb → JPEG 截图 → x264 …… page.mjs:51；video.mjs:31-36
```

规则：

1. **NoToneMapping 保色板。**【仓库实证】toon.js:4、src/toon.js:5：颜色全按参数绝对给定，所以用 NoToneMapping。docs/routes/beiming-style.md:77 指出，最终像素不必等于输入的十六进制值，雾、调色、纸纹之后会有变化。【通用工艺】ACES、AgX 这类全局曲线会压亮部，改变饱和度和色相，与逐材质给定颜色的三档卡通互相冲突。
2. **在 look 管线里，色调映射只在 OutputPass 发生一次。**【仓库实证】渲到渲染目标时，所有材质的 `toneMapping` 恒为 No（WebGLPrograms.js:165-171）；OutputPass 对整帧统一处理，不区分物体（OutputPass.js:51-66；engine/look/index.js:126）。所以 plates.js:30、70、80、101 和 src/ferry.js:42-43 里的 `toneMapped:false`，在这条管线中不起作用。保色板真正靠的是 film.js:25 的渲染器设置。如果有人把渲染器改成 ACES，底板也会被一起压。
3. **HDR 高光。**【仓库实证】窗灯、尾迹、倒影的线性值大于 1（src/ferry.js:11、42-43、101）。它们越过 bloom 阈值（engine/look/index.js:124；bloom.js:2），并被 Kuwahara 的高光保护挡住（grade.js:20、24；kuwahara.js:44、67），最后由调色的高光肩压缩，色相大体保住（grade.js:33-39；src/look.js:43 `shoulder: 0.9`）。【通用工艺】不做色调映射时，OutputPass 之后大于 1 的值会逐通道截断，高光肩是唯一一道高光处理。
4. **颜色参数用对应空间的换算。**【仓库实证】雾色和 bloom 染色在线性空间，用 `linVec`（fog.js:43；grade.js:53）；墨色在 sRGB 空间，用 `srgbVec`（compose.js:59）；params.js:3-5 说明了三个换算函数。新增一道 pass 时，先确定它在 OutputPass 之前（线性）还是之后（sRGB）。
5. **自写 ShaderMaterial 可以带 `#include <colorspace_fragment>`。**【仓库实证】plates.js:65、src/ferry.js:97。渲进 T.scene 时，这一行是恒等变换，因为渲染目标的输出空间是线性的（WebGLPrograms.js:202）；脱离 look 直接上屏时，它会正确编码。所以两种场景下都正确。

### 2.3 贴图 colorSpace

| 贴图 | colorSpace | 证据 |
|---|---|---|
| 手绘底板 | SRGB。GPU 以 `SRGB8_ALPHA8` 存储，采样结果已是线性 | 【仓库实证】plates.js:21；node_modules/three/src/renderers/webgl/WebGLTextures.js:213 |
| 数据贴图（`loadPlates` 的 `linear` 名单） | NoColorSpace | 【仓库实证】plates.js:4、21 |
| 2D 画布层 | SRGB | 【仓库实证】plates.js:50；lab/look.js:260 |
| 外部纸纹 | 默认 NoColorSpace。它在 sRGB 空间里当亮度调制用，不应解码 | 【仓库实证】paper.js:47；compose.js:33-36 |
| 查表或渐变 DataTexture | 默认 NoColorSpace | 【仓库实证】lab/look.js:35-36 |
| 实例色 | CPU 端 `Color.set` 转成线性 | 【仓库实证】scatter.js:52 |

【仓库实证】src/main.js:27 传了 `linear: ['paper']`，但 `paper` 不在加载名单里（src/main.js:26），这一项不生效。纸纹走的是另一条路：`paperUrl` → `createPaper`（src/main.js:24；paper.js:41-47）。

【通用工艺】法线、粗糙度、噪声、遮罩、ID 查表一律用 NoColorSpace；颜色图、手绘、照片、UI 一律用 SRGB。数据图错标成 sRGB，会被"解码"：数值变暗，法线方向被扭弯。颜色图错标成 None，输出编码时会整体发灰发亮。

### 2.4 像素比与分辨率

- **像素比固定为 1。**【仓库实证】film.js:24；page.mjs:73；engine/look/index.js:10。原因有三：look 的所有渲染目标按 W×H 分配（index.js:75-88）；合成着色器直接用 `gl_FragCoord` 取纸纹和颗粒（compose.js:34、43）；线宽、抖动、笔触半径按 `H/refHeight` 标定（index.js:15、93）。像素比一变，这些像素量就和画布的实际像素对不上。docs/routes/beiming-style.md:128 也写明，不要靠提高设备像素比来放大线宽。自测页 lab/kun.js:15-17 用像素比 2 配它自己的一套管线，不代表正片。
- **三套尺度**（镜头按设计高 1040 摆位、后期按 H/1080 标定、显示层按 H/1040 缩放）的来龙去脉以 [video.md §3.1](video.md) 为准（【仓库实证】`engine/stage/film.js:3-4、20-21`；`src/look.js:54`；`src/main.js:19`）。
- **2D 画布层要乘 K。**【仓库实证】镜头 B 按 `W×K` 建画布，并 `setTransform(K)`（src/shotB.js:16-17、36、50）。src/shotB.js:40 还特别注明，canvas 滤镜的长度不随变换缩放。镜头 A 的鸽群层用设计尺寸建（src/shotA.js:85；src/main.js:34 没有把 K 传进去）。4K 输出时，这一层是 1920×1040 的纹理被拉到 3840×2080。推断鸽群边缘在 4K 下会偏软，未出图核对。

---

## 3. 材质扩展

### 3.1 onBeforeCompile 加锚点注入

- `make()` 先建 `MeshToonMaterial`，再挂 `onBeforeCompile`，注入顺序见 toon.js:234 的注释：参数 → 量化投影 → 反照率 → 法线钩子 → 卡通合成 → 输出模式【仓库实证】toon.js:205-243。
- 选择包装内置材质而不是从零写 ShaderMaterial，是为了保留 three 的灯光、阴影、雾、实例化、蒙皮和变形这些块（docs/routes/beiming-style.md:39 "不是独立替换 Three 的渲染器"）。【通用工艺】
- uniform 对象同时存进 `mat.userData.toon`，运行时直接改 `.value` 即可调参【仓库实证】toon.js:19、231、245。
- 顶点钩子：`vertexPars` 放在 common 之后，`vertexMainStart` 放在 main 开头，`vertexNormal` 改 `objectNormal`，`vertexBegin` 改 `transformed`。材质自己的声明排在同位置的钩子前面【仓库实证】patch.js:7-8、32-40。

### 3.2 customProgramCacheKey

- 【仓库实证】three 的默认实现是返回 `onBeforeCompile.toString()`（node_modules/three/src/materials/Material.js:122-126）。程序缓存键由材质参数、defines 和这个值拼成，不包含补丁后的源码（WebGLPrograms.js:377-411）。
- 所有 toon 材质共用同一个闭包源码。如果保留默认键，钩子不同的材质会拿到同一个程序。§1.4 的干跑显示：69 份不同的补丁源码会只落到 3 个默认键上。
- 仓库的做法：`programKey(prefix, parts)` 等于 `名字 | 所有钩子字符串与 defines JSON 的哈希`【仓库实证】patch.js:26-27；toon.js:229；深度材质见 patch.js:53、59。
- 规则：
  - 每个材质族的 `name` 必须唯一。键只哈希单个材质的选项，不哈希材质族自己的 shade 或 layers 代码（这些在 toon.js:192 按 spec 生成，toon.js:229 不包含它们）。现有名字都不重复【仓库实证】src/toon.js:79、src/toon_refine.js:105、src/toon_qinglv.js:48、src/toon_xuan.js:138、src/toon_bronze.js:76、src/toon_peng.js:57。
  - 在 onBeforeCompile 里新增的 defines 必须写进键（toon.js:228-229）。
  - 链式改写 onBeforeCompile 的地方（src/kun_peng.js:900-904），当别的材质可能用同一组选项时也要扩展键。当前干跑没有发现冲突。
- 【通用工艺】uniform 的取值不进键，因为它不改变程序；一切会改变 GLSL 文本的东西都要进键，包括钩子、defines 和编译期常量。

### 3.3 共享 uniform

- 【仓库实证】`makeToonShared` 建一组全场共享的 uniform（toon.js:25-36）。每个材质把同一批对象展开进自己的 uniform 表（toon.js:226），`setToonShared` 只改 `.value`（toon.js:38-44）。
- 【仓库实证】镜头在每帧 `update` 里整组写全：src/shotA.js:142、src/shotC.js:198。这样任意跳到某一帧都不会残留上一镜的状态。规则：只改 `.value`，不替换 `{ value }` 对象本身；每帧把用到的字段全部写一遍。
- 【仓库实证】形变用的 uniform 在三处共用：
  - 鲲的 `U` 传进各个材质（src/kun.js:152-158）。
  - 深度材质 `Object.assign` 同一批对象（patch.js:55；toon.js:263）。
  - ID 通道的 `outlineVertex.uniforms` 就是 `mat.userData.toon`（engine/stage/outline.js:15-19），再进 ID 用的 ShaderMaterial（ids.js:76-79）。
  - 因此同一个 `uKunT` 同时驱动彩色、投影和墨线。
- 【仓库实证】材质里画的线和屏幕墨线同拍沸腾：`uInkTime = hold(f, 2)`（src/shotA.js:142；src/kun.js:183）；屏幕墨线的种子是 `floor(t×12)`（ink.js:2、128；src/look.js:27）。
- 【仓库实证】反例：模块级临时对象的状态泄漏。src/kun.js:514 在收到 `look` 参数后改了复用 Euler 的 `order`，造成历史依赖（docs/routes/beiming-style.md:205-226 测得角差 0.00025 / 0.00138 弧度）。【通用工艺】临时的 Euler、Quaternion、Vector3 每次使用前，显式设好全部状态，包括 `order`。

### 3.4 形变网格、深度材质与 ID 通道

同一个形变必须在三处生效：主材质、投影、墨线。否则颜色、投影和线条会分离【仓库实证】docs/routes/beiming-style.md:38、108。

| 环节 | 仓库做法 | 证据 |
|---|---|---|
| 投影 | `bindToon` → `bindPatched`：有顶点钩子时挂 `customDepthMaterial`；深度材质套用同样的 `vertexPars`、`MainStart`、`Begin`，跳过 `vertexNormal` | 【仓库实证】toon.js:260-276；patch.js:49、51-61、65 |
| 墨线 | `wireOutlines` 把材质的顶点钩子复制成 `outlineVertex`；ID 着色器把 head 放在 main 之前，body 放在 `begin_vertex` 之后 | 【仓库实证】outline.js:9-25；ids.js:16-17、33、39；bend.js:42-47、55 |
| 实例矩阵弯曲 | 用 `#define instanceMatrix pIM` 把实例矩阵换成弯过的版本。three 自带的块都读 `instanceMatrix`，所以彩色、深度、ID 三处自动一致 | 【仓库实证】bend.js:25-32 |
| 挂件 | 同一公式的 JS 镜像，用来给 CPU 摆位的鳍、眼睛定位 | 【仓库实证】bend.js:12、91-96；src/kun.js:503-511 |
| 另一种做法：CPU 形变 | 直接改顶点数据，阴影和 ID 自动一致，因此该材质族不挂深度材质；`rest:true` 时噪声坐标取 `aRest`，纹样不会随形变滑动 | 【仓库实证】src/toon_peng.js:56-57；toon.js:18、74-75；src/kun_peng.js:926、962 |

r170 的投影行为【仓库实证】：

- 平行光和聚光用 `object.customDepthMaterial`，点光源用 `object.customDistanceMaterial`（WebGLShadowMap.js:247）。仓库只设了前者，所有主光都是 DirectionalLight（src/shotA.js:54；src/shotC.js:111）。点光源下形变网格的投影属于未实现。
- three 每次画阴影时，会用主材质的 `shadowSide`（没设时取正反面翻转）覆盖深度材质的 `side`（WebGLShadowMap.js:31、297-301）。所以传给 `makeDepthMaterial` 的 `side`（patch.js:51；toon.js:264）会被覆盖。要控制投影面，请设主材质的 `shadowSide`。
- 接收阴影时，法线偏移用的是 `transformedNormal`（ShaderChunk/shadowmap_vertex.glsl.js:6、18）。所以 `vertexNormal` 钩子（弯过的法线）会影响投影偏移的方向。

### 3.5 2.5D 面片在 three 里的写法

| 做法 | 目的 | 证据 |
|---|---|---|
| 底板做成 1×1 单位面片，按屏幕像素加深度摆放；镜头运动时，视差由真实透视产生 | 2.5D 视差 | 【仓库实证】plates.js:1-2；camera.js:2、30-38 |
| 底板材质：透明、`depthWrite:false`、`fog:false`、`frustumCulled=false`、`outline=false` | 已画好空气透视，不吃雾，不描矩形外框 | 【仓库实证】plates.js:28-34 |
| 穹顶面片：按水平角和仰角贴在球面上 | 摇镜、仰拍时天际线不变形 | 【仓库实证】dome.js:1-4、33-37；src/shotC.js:45-52 |
| 抠像面片：彩色层正常混合；另有一个只写深度的遮罩层（`colorWrite:false` 加 `alphaTest`），遮罩层不挡墨线 | 让 Kuwahara 按深度给前景小笔触、背景大笔触 | 【仓库实证】plates.js:77-86；src/shotB.js:22-23、60 |

---

## 4. 实例化

- **生成。**【仓库实证】scatter.js:50-59：`InstancedMesh(geo, mat, n)`，然后 `setMatrixAt`、`setColorAt`，置 `needsUpdate`，设 `count`，并关掉视锥裁剪（scatter.js:56）。【通用工艺】实例矩阵在 GPU 端还会被弯曲（bend.js 的实例钩子），CPU 端的包围球不知道这些位移，裁剪可能误删。离线渲染不缺这点性能，宁可不裁。
- **`gl_InstanceID` 的三种用途。**【仓库实证】
  1. 每个实例的噪声坐标错开，斑块各不相同（toon.js:75）。
  2. `flat varying` 传实例号（toon.js:74、76；ids.js:31）。ID 不能插值，所以要用 flat。
  3. ID 通道：`vId = uBaseId + uPerInstance × gl_InstanceID`（ids.js:43-47）。分配 ID 时按 `count` 预留一段（ids.js:123-124）。编码是 `(id mod 2048, floor(id/2048))`；HalfFloat 能精确表示 0..2048 的整数，所以约可容纳 400 万个 ID（ids.js:2、60；ink.js:33）。
- **要不要在实例之间出线。**【仓库实证】材质选项 `instanceId`（toon.js:68）→ `bind` 推出 `perInstance`（toon.js:273）→ `userData.outlinePerInstance`（patch.js:70）→ ID 通道（ids.js:12、123）。例子：鲲背的海草团设了 `instanceId:false`，整团只留外轮廓（src/kun.js:351）；藤壶走默认值，每颗单独出线（src/kun.js:434、464）。多部件想共用一个 ID 时用 `outlineGroup`（ids.js:13、119-121；outline.js:23）。
- **出线归属。**【仓库实证】ID 跳变时只有较近的一侧画线；深度几乎相同时，固定让 ID 大的一侧画，避免两边轮流画出锯齿状的双线（ink.js:46-49）。
- **ID 图的硬性要求。**【仓库实证】Nearest 过滤、不开 MSAA、带深度纹理，读取用 `texelFetch`（index.js:82；ids.js:6；ink.js:32-33）。【通用工艺】ID 图一旦开 MSAA 或线性过滤，边缘会混出不存在的 ID，产生乱线。
- **自测页的另一条路。**【仓库实证】toon 的 `uToonPass = 1` 把 `fract` 哈希值写进 alpha（toon.js:179-183），这是 lab/kun.js 临时描边用的（lab/kun.js:6、148-155）。这种哈希可能撞值，只是近似。正片用 ids.js 的精确整数 ID（docs/routes/beiming-style.md:108、151）。

---

## 5. 阴影

- **类型。**【仓库实证】默认 PCFSoft（film.js:19、26），lab/look.js 用 PCF（lab/look.js:24）。
- **r170 的 PCFSoft 不读 `shadowRadius`。**【仓库实证】PCF_SOFT 分支是固定的 3×3 双线性加权采样（ShaderChunk/shadowmap_pars_fragment.glsl.js:154-189）；§1.4 输出 `PCF_SOFT branch reads shadowRadius false`。所以 `fitShadow` 里的 `radius = 2`（src/kun.js:531）在正片的 PCFSoft 下不起作用，只有换成 PCFShadowMap 才生效。
- **卡通量化。**【仓库实证】`getShadow` 的返回值过一次 `smoothstep(uShadowLo, uShadowHi)`，默认窗口 0.42–0.58（patch.js:42-47；toon.js:59、237）。投影区还会被强制压进阴影档（toon.js:122-125）。
- **主光。**【仓库实证】主光是第一盏投影平行光，只取方向和投影，不取灯色（toon.js:4、108-117）。three 会把投影灯排在数组最前面（WebGLLights.js:150-154、232）。灯的颜色只对非 toon 材质有意义。
- **`fitShadow` 贴合主体。**【仓库实证】src/kun.js:519-534 的做法：
  - 取鲲的中心和半径 R，光沿原方向退到 3R 处。
  - 正交阴影相机边界为 ±R，近平面 0.5R，远平面 5.5R。
  - `mapSize` 改变时先 dispose 旧贴图（src/kun.js:530）。
  - 每帧调用一次（src/shotA.js:109-110；src/shotC.js:173-174），远景用 2048，近景用 4096。
- **bias。**【仓库实证】`bias = -0.0005`，`normalBias = 1.5 × 模型缩放`（src/kun.js:531）。【通用工艺】`normalBias` 是世界单位，必须随模型尺度缩放。正交阴影相机的深度是线性的；按 5R 的深度跨度算，`bias -0.0005` 约等于 0.0025R 的世界距离。
- **ID 通道不更新阴影。**【仓库实证】渲 ID 图时临时关掉 `shadowMap.autoUpdate`，并清空背景（ids.js:151-152）。
- **【通用工艺】贴合式阴影相机的爬行问题。** 阴影相机跟着主体走，主体平移时阴影像素网格随之平移，不会爬行；主体转动或光向改变时仍会爬行。卡通量化窗口越窄，爬行越显眼。缓解办法：按阴影像素对齐、加大贴图、放宽窗口、阴影相机跟随一拍三的拍点更新。
- 未实现：阴影像素对齐、级联阴影、点光源的形变投影。

---

## 6. 后期

### 6.1 渲染目标一览

【仓库实证】engine/look/index.js:78-87；pass.js:29；paper.js:53；bloom.js:56-60。

| 目标 | 尺寸 | 类型 | 过滤 | MSAA | 深度 | 用途 |
|---|---|---|---|---|---|---|
| scene | W×H | HalfFloat | 线性 | `msaa`（默认 4） | DepthTexture Float | 主场景线性 HDR；深度供雾和 Kuwahara 使用 |
| id | W·ss×H·ss | HalfFloat | Nearest | 无 | DepthTexture Float | 物体与实例 ID；墨线深度 |
| edge | 同 id | HalfFloat | Nearest | 无 | 无 | 线浓度、半线宽、深度差 |
| line | 同 id | UnsignedByte | 线性 | 无 | 无 | 笔画覆盖率；合成时双线性下采样 |
| fog / grade / out / kuwa | W×H | HalfFloat | 线性 | 无 | 无 | 各道中间结果 |
| paper | W×H | UnsignedByte | 线性，Repeat | 无 | 无 | 程序化纸纹 |
| bloom mip 链 | W/2×H/2 起逐级减半，最多 7 级 | HalfFloat | 线性 | 无 | 无 | 下采样与上采样 |

- 【通用工艺】用 HalfFloat，是为了让线性值能大于 1（灯点），同时保住暗部精度；8 位线性存储会在阴影里出色带。
- 【仓库实证】FloatType 的深度纹理对应 `DEPTH_COMPONENT32F`，MSAA 深度渲染缓冲也是 32F（WebGLTextures.js:259、1467-1481）。MSAA 深度通过 `blitFramebuffer(…, NEAREST)` 解析（WebGLTextures.js:1997-2016），每个像素只取一个样本，没有抗锯齿。
- 【通用工艺】雾和 Kuwahara 用的是这份解析后的深度，在轮廓边缘与抗锯齿后的颜色并不完全对齐。本片默认关雾（src/look.js:44；src/shotA.js:151；src/shotC.js:209），影响很小。

### 6.2 顺序与每道所在的空间

【仓库实证】engine/look/index.js:3-6、107-138。

1. 主场景：线性 HDR，开 MSAA。
2. ID 图 → 边缘检测 → 笔画，都在超采样尺寸上算。
3. 雾（线性）→ bloom（线性，阈值比较最大通道）→ 调色（线性进出；bloom 在这里叠加，高光保护量写进 alpha）→ OutputPass（色调映射与 sRGB 编码）。
4. Kuwahara（sRGB）→ 合成（叠墨线、纸纹、暗角、颗粒）→ 屏幕或指定目标。

墨线叠在 Kuwahara 之后，所以不会被抹糊（docs/routes/beiming-style.md:108）。显示层不经过这条管线（film.js:2）。

### 6.3 OutputPass 何时做什么

- 【仓库实证】它把 T.grade 写进 T.out（index.js:126）：按 `renderer.toneMapping` 做色调映射（这里是 No，不做），按 `outputColorSpace` 做 sRGB 编码（OutputPass.js:51-66）。不管目标是屏幕还是渲染目标都这样做。只有渲染器设置变化时才重建 defines（OutputPass.js:51）。
- 之后的值都已是显示编码。合成着色器里没有 `colorspace_fragment`（compose.js:19-49），这是对的。【通用工艺】常见错误是在 OutputPass 之后又编码一次：多写了一行 `colorspace_fragment`，或者用内置材质去画一个上屏的四边形。结果是画面发灰。

### 6.4 全屏三角形

- 【仓库实证】pass.js:14-27：一个顶点为 `(-1,3)`、`(-1,-1)`、`(3,-1)` 的三角形，uv 为 `(0,2)`、`(0,0)`、`(2,0)`；正交相机；不做视锥裁剪；不测深度也不写深度（pass.js:24）。【通用工艺】一个三角形就能盖满全屏，没有两个三角形拼接时对角线上的重复着色。
- 【仓库实证】不用 three 的 FullScreenQuad，是因为它的 `dispose` 会删掉模块级共享的几何体（pass.js:2；node_modules/three/examples/jsm/postprocessing/Pass.js:59-73）。但 look 仍然建了一个 OutputPass（index.js:72），它内部带一个 FullScreenQuad：`look.dispose()` → `out.dispose()` → `fsQuad.dispose()`（OutputPass.js:88-91；index.js:147），还是会触发那块共享几何体的 dispose。【通用工艺】three 的几何体 dispose 只释放 GPU 缓冲，下次使用时会重新上传，结果是一次性能抖动，不会崩溃。只有同一页面里还有别的 FullScreenQuad 时才有影响，例如 lab/kun.js:47。

### 6.5 抗锯齿、状态与确定性

- 【仓库实证】场景 MSAA 默认 4 个样本，three 会把它限制在设备的 `MAX_SAMPLES` 以内（index.js:12、65、81；WebGLTextures.js:2080；WebGLCapabilities.js:109）。
- 【仓库实证】ID 图不开 MSAA。墨线的抗锯齿来自 ss=2 超采样：合成时双线性采样恰好等于 2×2 盒式下采样（index.js:11；compose.js:7、28）。【通用工艺】这个"恰好"只在 ss=2 时成立；ss=3 时双线性采样不等于 3×3 的盒式平均，线的软硬会变。
- 【仓库实证】look 会保存并恢复渲染目标、`autoClear` 和清屏色（index.js:100-102、139-141），所以之后还能再叠一层，例如 lab/look.js:276 的显示层实验。
- 【仓库实证】笔画搜索半径和 Kuwahara 采样半径是编译期常量，会按需编译多个变体（ink.js:108-112、124；kuwahara.js:13、72-79）。【通用工艺】如果线宽或半径随时间变化，渲染途中可能触发新编译，那一帧会卡顿。预热帧能覆盖大部分情况（film.js:14、51）。
- 【仓库实证】确定性：一切随时间变化的量只取决于 `p.t`（index.js:7）；墨线种子是 `floor(t×boilFps)`（ink.js:2、128）；颗粒种子是 `floor(t×fps)`（index.js:137）；哈希用 PCG 整数哈希（glsl.js:1-2、10）。 整片确定性的验证方法（无损帧哈希、顺序与跳帧对照、worker 数对码流的影响）见 [video.md §2](video.md)。

---

## 7. 资源与性能

### 7.1 dispose

- 【仓库实证】look 的释放是完整的（index.js:144-148；bloom.js:54、79；paper.js:78）。ID 材质在签名变化时会先释放旧的（ids.js:74）。
- 场景级的释放未实现：film.js 里没有（film.js:35-54），contracts.md:129 的 `dispose()` 还只是设计。【仓库实证】每个 video worker 是新开的浏览器，分段渲完就关闭（video.mjs:30、42），所以泄漏的范围限于单个进程的生命周期。
- 【通用工艺】长片或同页多镜头时，镜头切走后应释放几何、材质、纹理和渲染目标，并用 `renderer.info.memory` / `renderer.info.programs` 核对。仓库没有使用这两个统计（未实现）。

### 7.2 纹理与绘制

- 【仓库实证】底板开 mip，`LinearMipmapLinear` 加各向异性 8（plates.js:22）。three 会把各向异性限制在设备上限以内（WebGLTextures.js:653）。
- 【仓库实证】`plateCopy` 用 `clone` 复制纹理，共享同一份图像源（plates.js:40-45）。three 按 wrap、过滤、colorSpace 等参数决定是否共用一份 GPU 副本（WebGLTextures.js:487-506）：参数相同的副本共用一份；参数不同（例如 `wrapS` 改成 Repeat）才会另传一份。`offset` / `repeat` 走 uv 变换，不在这个键里，所以每个副本可以各自卷动，不额外占显存（src/shotA.js:31、40、44、96-98）。
- 【仓库实证】画布层每帧都重新上传（src/shotA.js:139；src/shotB.js:48、52）。【通用工艺】4K 下一张画布每帧约 32 MB。CanvasTexture 默认每次更新都重建 mip；屏幕对齐的画布用不到 mip，可以设 `minFilter = LinearFilter`、`generateMipmaps = false`。仓库没有这样做（未实现，属可选优化）。
- 【仓库实证】穹顶底板是双面加透明（dome.js:34）。three 对这类材质默认分两遍画，并在每次绘制时置 `needsUpdate`（node_modules/three/src/renderers/WebGLRenderer.js:1615-1623）。toon 的半透明分支已经用 `forceSinglePass` 关掉了这一行为（toon.js:249）；穹顶也可以照做，目前没有做。

### 7.3 WebGL2 上限与精度

- 【仓库实证】r170 只支持 WebGL2。仓库用到了 WebGL2 特性：`texelFetch`、`ivec2`（ink.js:32-33）、`uint` 哈希（glsl.js:10）、`flat varying`（toon.js:74）、`gl_InstanceID`。three 在初始化时会申请 `EXT_color_buffer_float` 等扩展（node_modules/three/src/renderers/webgl/WebGLExtensions.js:54-63），HalfFloat 和 Float 颜色附件依赖它们。
- 【仓库实证】MSAA 样本数会被限制（WebGLTextures.js:2080）。仓库不检查 `MAX_TEXTURE_SIZE` 或 `MAX_RENDERBUFFER_SIZE`：4K 加 ss=2 时，ID、edge、line 三个目标都是 7680×4160（index.js:78；package.json:12）。设备能力预检未实现，contracts.md:124 的 `inspectCapabilities()` 还只是设计。
- 【仓库实证】精度默认 highp（WebGLCapabilities.js:84；WebGLProgram.js:322-328）。设备不支持时 three 只发警告并降级，这条警告不会被 page.mjs 转发。PCG 整数哈希需要 32 位整数精度（glsl.js:10）。
- 【仓库实证】跨机器一致性：引擎的噪声用的是不含正弦的哈希（noise.glsl.js:4、11-15）和 PCG（glsl.js）。但有些着色器仍在用 `fract(sin(…))`（src/ferry.js:114；lab/look.js:52）。【通用工艺】正弦哈希在参数较大时，不同 GPU 和驱动的结果会不同；要求跨机器逐像素一致时，优先用整数哈希。实测 Mac 与 RTX 工作站的差异主要在文字边缘，另有零星墨线像素（docs/渲染与4K.md:50-56）。
- 【仓库实证】深度范围：镜头 A 为 5–40000，镜头 C 为 1–60000（src/shotA.js:19；src/shotC.js:23）。墨线用 1/z 的二阶差分加相对阈值，平面上恒为 0，所以掠射的地面不会误报（ink.js:52-58）。【通用工艺】标准（非反向）深度映射配合浮点深度，远处精度仍然下降。反向 Z 和对数深度都没有使用。

### 7.4 4K 显存估算

输入是 index.js:81-86 的分配方式，3840×2080、msaa 4、ss 2。字节数按 WebGL 常用的内部格式推算，属【通用工艺·估算】，不是实测。

| 项 | 每路约 |
|---|---|
| scene：MSAA 颜色 RGBA16F ×4 样本、MSAA 深度 32F ×4、解析后的颜色与深度纹理 | 244 + 122 + 61 + 30 ≈ 457 MiB |
| id：7680×4160 RGBA16F 加 32F 深度 | 244 + 122 ≈ 366 MiB |
| edge：RGBA16F | 244 MiB |
| line：RGBA8 | 122 MiB |
| fog / grade / out / kuwa：4 张 RGBA16F | 244 MiB |
| paper：RGBA8 | 30 MiB |
| bloom mip 链：7 级，每级下采样与上采样各一张 | ≈ 41 MiB |
| 阴影贴图：镜头 C 4096² 加镜头 A 2048²，RGBA8 加深度 | ≈ 160 MiB |
| 渲染目标合计 | ≈ 1.6 GiB |
| 底板纹理：本片加载的 11 张（其中 shotB_sky 只当画布源图），sRGB8 含 mip | ≈ 0.35 GiB |

- 每路约 2 GiB，6 路约 12 GiB。实测 6 路峰值约 18.8 GB【仓库实证】docs/RTX工作站.md:54；docs/渲染与4K.md:42。推断差额来自浏览器、驱动和画布层。
- 结论：4K 下，ss=2 的墨线链（约 730 MiB）比 MSAA 主场景（约 457 MiB，含解析）还大。
- 可调的手段，按影响画面的程度从小到大排：先减 worker（6 路和 10 路只差约 2 秒，docs/RTX工作站.md:52）；再评估 `msaa: 2`（每路省约 180 MiB）；最后才考虑 `ss: 1`（每路省约 550 MiB，但会改变线的抗锯齿，必须出对照帧）。这三个参数都是 `createLook` 已有的选项（index.js:11-12、65）。

### 7.5 ANGLE 后端与软件渲染识别

- 【仓库实证】`BEIMING_ANGLE=metal|vulkan|gl|default`。macOS 默认 metal，其它平台默认不加参数。另带 `--enable-gpu --ignore-gpu-blocklist --force-color-profile=srgb --font-render-hinting=none`（page.mjs:9-10、47-53）。
- 【仓库实证】Windows 默认的 D3D11 后端可能落到核显，连 WebGL 上下文都建不起来；切到 Vulkan 才会用上 RTX（docs/RTX工作站.md:7-15、72）。
- 【仓库实证】`node tools/rtx/gpucheck.mjs` 依次试 default、d3d11、vulkan、gl 四个后端，打印渲染器串和重着色器的每帧毫秒数（gpucheck.mjs:1-6、17-33）。实测 RTX 5090 Vulkan 0.52 ms，M5 Pro Metal 5.17 ms（docs/RTX工作站.md:17-22）。它没有单列 metal；macOS 上 default 即 metal（page.mjs:48）。
- 【仓库实证】软件渲染的识别：用正则 `swiftshader|llvmpipe|software` 匹配渲染器串，命中只打印提示，不让渲染失败（page.mjs:84-89）。验收手册要求主动判失败（docs/routes/validation-and-rtx.md:13、330；contracts.md:151）。video.mjs 会打印 GPU 串（video.mjs:23），still.mjs 不打印（still.mjs:19）。
- 【通用工艺】Windows 的 WARP 软件回退通常显示为 "Microsoft Basic Render Driver"，现有正则匹配不到。建议交付 RTX 任务时，渲染器串里不含目标 GPU 名就判失败（未实现）。另外，page.mjs 是另开一个 WebGL2 上下文读的渲染器串（page.mjs:84-88），一般与 three 的上下文落在同一块 GPU；严格起见可以改从 `renderer.getContext()` 读（未实现）。
- 实测的后端回退与计时（macOS：`gl` 静默回退 SwiftShader，READY 慢约 18 倍，像素也不同）见 [video.md §7.2](video.md)。

### 7.6 预热与编译

- 【仓库实证】`film.run` 的 `warm` 列表里每个时刻渲一帧，用来编译着色器、上传贴图、生成阴影贴图，最后回到 t=0（film.js:14、51-52；src/main.js:49）。
- 【仓库实证】每个 worker 都是新页面，都要再付一次编译和上传的代价（video.mjs:30）。1080 下工作站的耗时主要花在启动 Chrome 上（docs/渲染与4K.md:40）。
- 【通用工艺】`renderer.compileAsync` 或 `KHR_parallel_shader_compile` 可以缩短预热，仓库没有使用（未实现）。

---

## 8. 调试

### 8.1 look 调试视图

【仓库实证】engine/look/debug.js:6-7、20-25、29；engine/look/index.js:31、134-138。调试视图会替代最终合成，画面里不再叠墨线、纸纹和暗角。

| 视图 | 显示内容 | 用来查什么 |
|---|---|---|
| `id` | 每个 ID 一种色相，亮度表示线的可见度 | 形变部件的 ID 轮廓和彩色轮廓对不上，说明 `outlineVertex` 没接；实例是否各自独立 |
| `depth` | ID 图深度的对数显示 | 近远平面是否合理；透明物体是否写了深度 |
| `edge` | R 为浓度，G 为半线宽/6，B 为深度差 | 线来自 ID 跳变还是深度折痕；内部线和外轮廓的粗细比例 |
| `line` | 白底黑线 | 抖动、笔压、断线、一拍二的沸腾 |
| `bloom` | 光晕亮度乘 4 | 阈值和半径 |
| `paper` | 纸纹 | 颗粒尺度 |
| `kuwahara` | 合成前的最终颜色；未知模式也回落到这里 | 笔触半径、远近过渡 |
| `scene` | 原样显示线性 HDR，不编码，所以看起来偏暗 | bloom 之前的灯点、HDR 范围 |

调用方式【仓库实证】：

- 正片：`?dbg=edge`（src/main.js:39），例如 `node engine/render/still.mjs . 7.5 --query 'nohud=1&dbg=edge' --out out/dbg`（still.mjs:2、10）。
- lab/look.js：`cfg=` 单独开关某道效果，`ss=1|2` 切换超采样，`still=1` 冻结镜头只看沸腾，`window.bench(n, t)` 每帧用 `readPixels` 强制 GPU 同步后计时（lab/look.js:5-13、279-283）。
- lab/kun.js：`pass=1` 看 toon 的法线和 ID 通道，`noink=1` 关描边（lab/kun.js:7）。
- 构图标记：`markers=1` 或 `markers=log`（src/main.js:46；src/shotC.js:213-225）。

### 8.2 TEXTS

【仓库实证】页面可以选择性地暴露 `window.TEXTS(t)`，返回该时刻画面上的全部文字和方框（page.mjs:7；film.js:13、49；src/hud.js:7、364）。lab/hud.js 的 `boxes=1` 会把方框画出来（lab/hud.js:3）。手动调用方式：`page.evaluate(t => window.TEXTS(t), 9.8)`。在 tools 和 engine 里，`git grep TEXTS` 只能查到定义，没有调用者，自动文字检查未实现。

### 8.3 日志会转发什么

【仓库实证】page.mjs:74-80：

- `pageerror` → 进程以 1 退出。
- error 级别的 console 输出 → 打印为 `[页面]`，截断到 300 字。
- 脚本或文档请求返回 4xx/5xx → 退出。
- 警告不转发。

---

## 9. 常见坑与修法

| 现象 | 根因 | 修法 | 证据 |
|---|---|---|---|
| 升级 three 后报"着色器锚点缺失" | ShaderChunk 文本改了 | 按 §1.5 逐个锚点重新定位；保持 `inject` 的报错，不要改成静默替换 | 【仓库实证】patch.js:18-24、42-47；toon.js:78 |
| 升级后没报锚点错，但物体消失或全黑，stderr 有 `[页面] … Shader Error` | 注入代码依赖的内部签名或变量名变了（如 `getShadow`、`geometryViewDir`），或 `#include` 的块改名 | 对照新版 chunk 修改调用；把 `[页面]` 行当失败；可接 `debug.onShaderError` 改为直接抛错 | 【仓库实证】toon.js:106、116；ids.js:25-42；page.mjs:75；WebGLProgram.js:284、932-943 |
| 两个材质"串着色器"：改一个钩子，另一个也变 | 缓存键相同，three 复用了程序 | 每个材质族唯一 `name`；钩子和 defines 进 `programKey`；链式改写时扩展键 | 【仓库实证】Material.js:122-126；patch.js:26-27；toon.js:229；src/kun_peng.js:900-904；§1.4 |
| 颜色发灰、发白 | 颜色贴图或画布没标 sRGB；OutputPass 之后又编码了一次；数据图被当成颜色图 | 按 §2.3 标 colorSpace；OutputPass 之后的 pass 不再编码 | 【仓库实证】plates.js:21、50；compose.js:19-49 |
| 颜色发暗、过饱和 | 渲到渲染目标后漏了 OutputPass，线性值直接上屏；在 sRGB 空间的 pass 里用了线性颜色，或者反过来 | 保留 OutputPass；按 pass 所在空间选 `linVec` 或 `srgbVec` | 【仓库实证】index.js:126；params.js:19-20；compose.js:59；fog.js:43 |
| 色板整体偏移，亮部发灰发黄 | 渲染器开了 ACES、AgX 等色调映射；材质上的 `toneMapped:false` 在 look 管线内无效 | 回到 `NoToneMapping`；高光交给调色的 `shoulder` | 【仓库实证】film.js:25；WebGLPrograms.js:165-171；OutputPass.js:51-66；grade.js:33-39 |
| 橙色灯过曝成黄白 | 不做色调映射时逐通道截断 | `grade.shoulder < 1`；配合 Kuwahara 的 `protect` | 【仓库实证】grade.js:20-24、33-39；src/look.js:41、43 |
| 投影与形变错位（尾巴摆了，影子没摆） | 形变只写在主材质里 | 用 `bindToon` 自动挂 `customDepthMaterial`；或改做 CPU 形变；点光源需要 `customDistanceMaterial`（未实现） | 【仓库实证】toon.js:260-276；patch.js:51-66；WebGLShadowMap.js:247；src/toon_peng.js:56 |
| 投影面不对（正反面） | three 用主材质的 `shadowSide` 或翻转后的 `side` 覆盖了深度材质的 `side` | 在主材质上设 `shadowSide` | 【仓库实证】WebGLShadowMap.js:31、297-301 |
| 墨线不贴形变后的轮廓 | ID 通道没拿到同样的顶点形变 | `wireOutlines`，或用 `modeHooks` 带出 `outlineVertex` | 【仓库实证】outline.js:9-25；bend.js:42-47、55；ids.js:16-17 |
| 改了 `shadow.radius` 没有变化 | r170 的 PCFSoft 不读 radius | 换 PCF 再配 radius；或调 `shadowLo` / `shadowHi` | 【仓库实证】src/kun.js:531；shadowmap_pars_fragment.glsl.js:154-189；§1.4 |
| 阴影痤疮或影子悬空 | `bias` / `normalBias` 与模型尺度不匹配 | `normalBias` 按模型缩放给（1.5×sc）；`bias` 用小负值 | 【仓库实证】src/kun.js:531；shadowmap_vertex.glsl.js:6、18 |
| 阴影糊、锯齿大 | 阴影相机罩得太大 | 用 `fitShadow` 式贴合；按景别选 `mapSize` | 【仓库实证】src/kun.js:519-534；src/shotA.js:110；src/shotC.js:174 |
| 实例描边全连成一片，只剩一团外轮廓 | 整批共用一个 ID（`instanceId:false`、`outlinePerInstance:false` 或 `outlineGroup`） | 需要逐个出线时保持 `instanceId: true`（默认值） | 【仓库实证】toon.js:68、273；patch.js:70；ids.js:12、119-124 |
| 反过来：一团海草碎成很多小圈 | 每个实例一个 ID | `instanceId:false`（src/kun.js:351 的做法）或 `outlineGroup` | 【仓库实证】src/kun.js:351；ids.js:13 |
| ID 边缘出乱线、闪烁 | ID 图开了 MSAA 或线性过滤，或者用 `texture()` 采样 | Nearest 过滤、不开 MSAA、用 `texelFetch` | 【仓库实证】index.js:82；ids.js:6；ink.js:32-33 |
| 两部件穿插处出现锯齿状双线 | 两侧深度平局时轮流判为近侧 | 平局时让 ID 大的一侧画（已实现） | 【仓库实证】ink.js:46-49 |
| 透明物体前后顺序错 | three 按 groupOrder → renderOrder → z 排序 | 底板、尾迹、倒影都显式写 `renderOrder`；透明物体不写深度 | 【仓库实证】WebGLRenderLists.js:27-39；plates.js:29-34；src/shotA.js:71、78；src/ferry.js:106、131 |
| 双面透明物体每帧多画一遍 | three 对双面透明默认拆成两遍 | `forceSinglePass`；穹顶可以照做 | 【仓库实证】WebGLRenderer.js:1615-1623；toon.js:249；dome.js:34 |
| 半透明云片挡线不对 | `outlineOccluder` 模式选错 | 按需选 `auto` / `soft` / `own` / `solid` / `false` | 【仓库实证】ids.js:14-15、131-145；plates.js:82 |
| 4K 显存高或爆显存 | ss=2 墨线链、MSAA、多 worker 叠加 | 先减 worker，再评估 `msaa: 2` 或 `ss: 1`（需要出对照帧） | 【仓库实证】index.js:65、78-87；docs/RTX工作站.md:52-54；§7.4 |
| 4K 时线宽或笔触看起来变了 | 像素比不是 1，或者绕过了 `refHeight` 标定 | 保持像素比 1；参数按 1080 标定 | 【仓库实证】film.js:24；index.js:15、93；docs/routes/beiming-style.md:128 |
| 4K 时某个画布层发软 | 画布按设计尺寸建 | 按 K 建画布，并 `setTransform(K)` | 【仓库实证】src/shotB.js:16-17、36；src/shotA.js:85 |
| 跳帧或分段渲染时某帧不同 | 共享对象状态泄漏（如 Euler 的 `order`）等历史依赖 | 每次使用前显式设好状态；做顺序与跳帧对照 | 【仓库实证】src/kun.js:514；docs/routes/beiming-style.md:205-226；validation-and-rtx.md:183 |
| 渲得很慢，GPU 串是 SwiftShader 之类 | ANGLE 落到了软件渲染 | `BEIMING_ANGLE=vulkan`；先跑 gpucheck；交付时主动判失败 | 【仓库实证】page.mjs:84-89；tools/rtx/gpucheck.mjs；validation-and-rtx.md:330 |
| 跨机器有像素差 | 文字光栅化不同、GPU 浮点差异 | 比对 three 改动时加 `nohud=1`；噪声用整数哈希 | 【仓库实证】docs/渲染与4K.md:56；src/main.js:42；glsl.js:10 |

---

## 10. 出处与许可

- **路径缩写**：`$甲` = `cases/vendor/lemo-opuscar`（风格库甲，固定提交 `bebbbe1a`，MIT，LemoLab）；`$乙` = `cases/vendor/sy-style-100`（风格库乙，固定提交 `e41dee31`，MIT，肖雄 XIAOXIONG）；`<研究工作区>` = 研究期的临时目录，未入库（说明见 [README](README.md) §8）。快照只读，许可与署名不得删改（`AGENTS.md:51,56`；`THIRD-PARTY.md:32-38`）。

- three 0.170.0，MIT（node_modules/three/LICENSE；cases/licenses/three-MIT.txt；THIRD-PARTY.md:21；package-lock.json:28-32）。本章引用其源码行号只为核对行为，没有复制源码。
- playwright-core 1.63.0，Apache-2.0（package-lock.json:16-20），即渲染脚本驱动无头 Chrome 用的库（page.mjs:15）。
- 仓库代码注释里注明的算法来源：广义 Kuwahara（Papari 2007，kuwahara.js:1）、PCG 整数哈希（Jarzynski & Olano 2020，glsl.js:2）、无切线凹凸（Mikkelsen 2010，util.glsl.js:10）。

## 11. 未实现清单

- 自动对照帧与无损比对工具：`tools/qa/` 不存在，见验收手册 V02（validation-and-rtx.md:214、384）。still.mjs 只输出 JPEG（still.mjs:24）。
- `runtime.three` 与已安装版本、`THREE.REVISION` 的一致性检查（project.js:213 只检查字段是否存在）。
- 页面警告转发（page.mjs:75 只转发 error）；`renderer.debug.onShaderError` 未接，着色器错误不会让渲染失败。
- 软件渲染或非目标 GPU 时判失败（page.mjs:89 只打印提示）；WARP 类渲染器串识别。
- WebGL2 上限预检，如 `MAX_TEXTURE_SIZE`（contracts.md:124 的 `inspectCapabilities` 为设计稿）。
- 场景级 dispose 与长片资源回收（film.js 没有；contracts.md:129 为设计稿）；`renderer.info` 审计。
- 点光源下形变网格的 `customDistanceMaterial`；阴影像素对齐；级联阴影。
- `compileAsync` 或并行编译预热。
- TEXTS 的自动检查脚本。
- 屏幕对齐画布层关闭 mip、穹顶 `forceSinglePass` 等可选优化。
