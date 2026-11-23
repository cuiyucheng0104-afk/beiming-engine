# r187 编号图与后期回归：对 r170 金标准

本页由 `node engine/look/r187-look-regression.mjs --write` 生成，数据在同名的 `.json` 里；不要手改，重跑即可。卡通着色层那一半见 [r187-toon-regression.md](r187-toon-regression.md)。

结论：**过门**。`engine/look`（ID 图与整条后期链）在 three r187 下实渲的结果对 r170 金标准：版本门（按两张渲染页实际发出的模块请求）过；ID 图的离散编号 0 个像素不同（要 0；低段 0、高段 0，各比各的），非有限数（NaN / Infinity）的像素 0 个（要 0），线宽 / 可见度通道最大差 0（容差 0.001）；逐级与整帧 18 / 18 项过门（PSNR ≥ 50 dB、差 > 1 级的像素 ≤ 0.1%、差 > 5 级的像素 ≤ 0.1%），其中 18 项逐字节相同；负对照 3 / 3 组跌破 35 dB；逐道消融 20 / 20 组被门拦住；r170 对冻结的金标准（基线 `5b47179`）没变；两版页面控制台告警 0 条。

- 实际运行平台：darwin-arm64，Node v24.13.1，无头 Chrome 153.0.8010.12，ANGLE 后端 metal
- WebGL 渲染器：ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Unspecified Version)
- 两页的 three 实报 r170 / r187
- 两张渲染页实际请求的 OutputPass：`/node_modules/three/examples/jsm/postprocessing/OutputPass.js`（r170） / `/node_modules/three-webgpu/examples/jsm/postprocessing/OutputPass.js`（r187）；请求到另一版包里的文件 0 / 0 个（都要 0）
- 这份读数只代表上面这台机器；别的显卡或软件渲染要在那台机器上重跑

## 怎么比的

两张互相独立的测试页，各自的 import map 把 `three` 与 `three/addons/` 一起指到 r170（`three`）或 r187（`three-webgpu` 别名包），渲同一个确定性标定场景（`engine/look/r187-look-regression.scene.mjs`，640 × 480），渲染器设置与 `createFilm` 相同（sRGB 输出、不做色调映射、不开抗锯齿、软阴影），后期用 `createLook`（墨线超采样 2 倍、主场景 MSAA 4 倍、像素量按本画幅标定）。场景里有卡通材质、three 自带材质与 ShaderMaterial，投影、顶点形变、线性 HDR 的亮点都在。

## ID 图（物体 / 实例编号）

`createIdPass` 单独渲到与成片同样配置的渲染目标（半浮点 RGBA、Nearest、带深度纹理），读回半浮点原值，RGBA = （编号低 11 位，编号高位，线宽系数，线可见度）。编号是离散值，不留容差。

| 项 | 编号不同的像素（低段 / 高段） | 非有限数的像素 | 线宽 / 可见度超出容差的像素 | 线宽最大差 | 可见度最大差 | 判定 |
|---|---|---|---|---|---|---|
| r187 对 r170 | 0（0 / 0） | 0 | 0 | 0 | 0 | 相同 |
| `same-id`：变体路径正对照：不改参数，重建场景再渲 ID 图 | 0 | 0 | 0 | | | 相同 |

编号按半浮点原值的两个通道各比各的：低段（编号 mod 2048）与高段（编号 ÷ 2048 取整）有一个不同就算不同，(0, 1) 写成 (2048, 0) 这种合起来相等的也算。四个通道里任一侧出现 NaN / Infinity 的像素单独计数，有一个就不过。

各版自己的 ID 图里，原值要合规（低段是 0 到 2047 的整数、高段是非负整数、线宽与可见度是有限数），预期的 12 个编号都要在（各占 16 个像素以上）、不能有多出来的编号。彩屑是 2100 个实例的 InstancedMesh，露出的 6 个实例编号 1、2、2047、2048、2049、2100，跨过 11 位低段（2048 = 低段 0、高段 1）；它后面的物体编号 2101 到 2106，全在高段。球的线宽系数给的是 1.6，可见度 0.7，被不透明度 0.45 的半透明玻璃挡着的那一半应当是 0.7 × 0.55。

| 版本 | 原值不合规的像素 | 没找到的编号 | 多出来的编号 | 高段（≥ 2048）像素 | 球：线宽不对的像素 | 球：露出 / 玻璃后 / 可见度不对的像素 | 判定 |
|---|---|---|---|---|---|---|---|
| r170 | 0 | 无 | 无 | 65682 | 0 | 11854 / 5126 / 0 | 对上 |
| r187 | 0 | 无 | 无 | 65682 | 0 | 11854 / 5126 / 0 | 对上 |

| 场景里的物体 | 走的分支 |
|---|---|
| 彩屑（InstancedMesh × 2100） | 逐实例编号（`outlinePerInstance` 默认），低 / 高两段 |
| 球 | 普通网格，`outlineWidth` / `outlineAlpha` |
| 卵石（InstancedMesh × 5） | `outlinePerInstance: false`，整批共用一个编号 |
| 躯干 + 头 | `outlineGroup` 写在父节点上，子物体继承，同组一个编号 |
| 叶片 | three 自带材质 + 带 alpha 的贴图，按 `alphaTest` 镂空（CUTOUT），贴图带 repeat / offset |
| 芦苇 | 材质里的顶点位移经 `outlineVertex` 交给 ID 图；自带阴影深度材质与法线钩子 |
| 双材质方块 | 两个面用 `noId` 材质，这两组不进 ID 图 |
| 地面、灯 | 实心挡线（自动判定的与显式 `'solid'`） |
| 玻璃、挡块、柱子、幽灵块 | 透明材质半挡（soft）、ShaderMaterial 自动判成 own、卡通材质显式 `'own'`、`outlineOccluder: false` 不挡 |

## 逐级与整帧：r187 对 r170

`view-*` 是 `look.render` 的 debug 视图（中间缓冲原样画出来），`solo-*` 是只开一道后期、其余都关的整条链，`final` 是各道全开的整帧。都从画布读回 RGBA8，只比 RGB。

| 项 | 内容 | PSNR | 最大单通道差 | 差 > 1 级的像素 | 差 > 5 级的像素 |
|---|---|---|---|---|---|
| `view-id` | 中间缓冲：超采样 2 倍的 ID 图（按编号上色） | 逐字节相同 | 0 | 0.000% | 0.000% |
| `view-depth` | 中间缓冲：ID 图的深度 | 逐字节相同 | 0 | 0.000% | 0.000% |
| `view-edge` | 中间缓冲：边缘检测（强度 / 半线宽 / 深度差） | 逐字节相同 | 0 | 0.000% | 0.000% |
| `view-line` | 中间缓冲：墨线笔画 | 逐字节相同 | 0 | 0.000% | 0.000% |
| `view-bloom` | 中间缓冲：bloom 光晕 | 逐字节相同 | 0 | 0.000% | 0.000% |
| `view-paper` | 中间缓冲：程序化纸纹 | 逐字节相同 | 0 | 0.000% | 0.000% |
| `view-kuwahara` | 中间缓冲：雾 → bloom → 调色 → OutputPass → Kuwahara 之后的颜色 | 逐字节相同 | 0 | 0.000% | 0.000% |
| `solo-output` | 各道都关：主场景（MSAA、半浮点线性）直接过 OutputPass | 逐字节相同 | 0 | 0.000% | 0.000% |
| `solo-outline` | 只开墨线，其余各道都关 | 逐字节相同 | 0 | 0.000% | 0.000% |
| `solo-fog` | 只开空气透视雾，其余各道都关 | 逐字节相同 | 0 | 0.000% | 0.000% |
| `solo-bloom` | 只开 bloom，其余各道都关 | 逐字节相同 | 0 | 0.000% | 0.000% |
| `solo-grade` | 只开调色，其余各道都关 | 逐字节相同 | 0 | 0.000% | 0.000% |
| `solo-kuwahara` | 只开 Kuwahara，其余各道都关 | 逐字节相同 | 0 | 0.000% | 0.000% |
| `solo-paper` | 只开纸纹，其余各道都关 | 逐字节相同 | 0 | 0.000% | 0.000% |
| `solo-vignette` | 只开暗角，其余各道都关 | 逐字节相同 | 0 | 0.000% | 0.000% |
| `solo-grain` | 只开颗粒，其余各道都关 | 逐字节相同 | 0 | 0.000% | 0.000% |
| `final` | 整帧合成（各道全开） | 逐字节相同 | 0 | 0.000% | 0.000% |
| `same-final` | 变体路径正对照：不改参数，重建场景再渲整帧 | 逐字节相同 | 0 | 0.000% | 0.000% |

## r170 对冻结的金标准

上面的 r170 与 r187 跑的是同一份 `engine/look`，两版一起改坏时互比照样全等。所以 r170 这边另外对一份冻结的金标准（`engine/look/r187-look-regression.golden.json`，基线 `5b47179`，冻结于 metal：ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Unspecified Version)），它不随待测代码重生：

- 着色器摘要：标定场景这一趟在 r170 下交给 WebGL 编译的全部着色器源码（three 展开 `#include`、加完前缀之后的最终文本，共 47 段）各自的 SHA-256，逐字节比。没有变化。
- 缩略图：逐级画面各一张 16 × 12 的缩略图，每块 40 × 40 像素，存 RGB 均值与粗糙度（块内绿色通道相邻像素差的平均值 × 8；均值看不出的颗粒、纸纹、笔触靠它）。均值差最大不超过 4 级、平均不超过 0.6 级（按 RGB 里最差的通道），粗糙度差最大不超过 8、平均不超过 0.6。容差是给不同显卡 / 软件渲染留的：macOS Metal 对 SwiftShader 实测均值最大差 1 级、平均不到 0.28 级，粗糙度最大差 3、平均不到 0.22；只关一道后期时至少有一项远超容差（关颗粒：粗糙度平均 5；关 Kuwahara：粗糙度最大 32；关 bloom：均值最大 24）。离散的 ID / 深度 / 边缘视图（`view-id`、`view-depth`、`view-edge`）不存缩略图：物体边缘差一个像素块差就很大，ID 由下一条的编号像素数管，深度与边缘的结果落在墨线里。
- ID 图：冻结的每个编号都要在、不能多，像素数与冻结时相差不超过 24 个或 4%（取大的）。本次 12 / 12 个编号对上。

| 画面 | 均值最大差 | 均值平均差 | 粗糙度最大差 | 粗糙度平均差 | 判定 |
|---|---|---|---|---|---|
| `view-line` | 0 级 | 0 级 | 0 | 0 | 没变 |
| `view-bloom` | 0 级 | 0 级 | 0 | 0 | 没变 |
| `view-paper` | 0 级 | 0 级 | 0 | 0 | 没变 |
| `view-kuwahara` | 0 级 | 0 级 | 0 | 0 | 没变 |
| `solo-output` | 0 级 | 0 级 | 0 | 0 | 没变 |
| `solo-outline` | 0 级 | 0 级 | 0 | 0 | 没变 |
| `solo-fog` | 0 级 | 0 级 | 0 | 0 | 没变 |
| `solo-bloom` | 0 级 | 0 级 | 0 | 0 | 没变 |
| `solo-grade` | 0 级 | 0 级 | 0 | 0 | 没变 |
| `solo-kuwahara` | 0 级 | 0 级 | 0 | 0 | 没变 |
| `solo-paper` | 0 级 | 0 级 | 0 | 0 | 没变 |
| `solo-vignette` | 0 级 | 0 级 | 0 | 0 | 没变 |
| `solo-grain` | 0 级 | 0 级 | 0 | 0 | 没变 |
| `final` | 0 级 | 0 级 | 0 | 0 | 没变 |

有意改画面时才重冻（`--freeze <基线提交>`），先按 `docs/style-baselines/POLICY.md` 审批；不是有意改的，这里变红就是回退。

## 负对照（在 r187 上故意改坏，再对 r170 金标准的整帧）

必须 < 35 dB 才算被拦住。

| 项 | 改了什么 | PSNR | 最大单通道差 | 差 > 1 级的像素 | 差 > 5 级的像素 |
|---|---|---|---|---|---|
| `neg-exposure` | 调色曝光 1.1 → 1.8 | 19.11 dB | 134 | 99.347% | 96.697% |
| `neg-fog-dense` | 雾的密度 0.035 → 0.5、从 0 起 | 13.68 dB | 189 | 99.283% | 76.757% |
| `neg-ink-thick` | 墨线线宽 3 → 14 | 16.65 dB | 219 | 12.386% | 12.203% |

## 逐道消融（在 r187 上只关一道后期，再对 r170 金标准的整帧）

必须过不了门：说明这一道确实在整帧里，坏了门看得见。

| 项 | 关掉了什么 | PSNR | 最大单通道差 | 差 > 1 级的像素 | 差 > 5 级的像素 |
|---|---|---|---|---|---|
| `abl-outline` | 关掉墨线 | 19.92 dB | 222 | 6.603% | 6.464% |
| `abl-fog` | 关掉空气透视雾 | 24.86 dB | 83 | 98.174% | 94.050% |
| `abl-bloom` | 关掉 bloom | 38.05 dB | 129 | 7.620% | 3.255% |
| `abl-grade` | 调色换回中性默认（OutputPass 仍在） | 25.01 dB | 125 | 98.985% | 96.559% |
| `abl-kuwahara` | 关掉 Kuwahara 笔触 | 39.73 dB | 134 | 3.069% | 1.717% |
| `abl-paper` | 关掉纸纹 | 36.17 dB | 23 | 73.679% | 22.354% |
| `abl-vignette` | 关掉暗角 | 19.28 dB | 83 | 75.970% | 66.864% |
| `abl-grain` | 关掉颗粒 | 46.87 dB | 4 | 27.829% | 0.000% |

## ID 图消融（在 r187 上只改坏 ID 图的一个分支，再对 r170 金标准的 ID 图）

必须有 16 个以上的像素编号不同（低段或高段）、或线宽 / 可见度超出容差。

| 项 | 改了什么 | 编号不同的像素 | 线宽 / 可见度超出容差的像素 | 判定 |
|---|---|---|---|---|
| `abl-id-instance` | 彩屑不再逐实例编号（整批实例同一个 ID） | 67869 | 0 | 拦住 |
| `abl-id-shared` | 卵石改成逐实例编号（本来整批共用一个 ID） | 41555 | 0 | 拦住 |
| `abl-id-group` | 躯干与头不再同组（各编各的号，相接处出线） | 29496 | 0 | 拦住 |
| `abl-id-cutout` | 叶片不按贴图 alpha 镂空 | 8842 | 8842 | 拦住 |
| `abl-id-cut-uv` | 叶片贴图的 UV 变换（repeat / offset）不生效 | 8755 | 8755 | 拦住 |
| `abl-id-vertex` | 芦苇的顶点位移不交给 ID 图（不给 outlineVertex） | 13181 | 11768 | 拦住 |
| `abl-id-width` | 球的线宽系数 1.6 → 1 | 0 | 16980 | 拦住 |
| `abl-id-alpha` | 球的线可见度 0.7 → 1 | 0 | 16980 | 拦住 |
| `abl-id-soft` | 半透明玻璃不再半挡（改成不挡线） | 0 | 5126 | 拦住 |
| `abl-id-own` | ShaderMaterial 挡块不再用自身材质挡线（改成不挡线） | 3345 | 3345 | 拦住 |
| `abl-id-false` | 不挡线的幽灵块改成实心挡线 | 2680 | 2680 | 拦住 |
| `abl-id-noid` | 双材质方块的 noId 那一组照常进 ID 图 | 3021 | 3021 | 拦住 |

## 两版之间的差异与处理

- 结论：这条链路上 `engine/look` 的着色器与渲染流程不用为 r187 改一行。相对基线提交，`engine/look/*.js` 只动了两处出错路径（`ids.js` 不再吞着色器补丁的错，`compose.js` 纸纹变体对不上时改借 `engine/shade/patch.js` 的 `inject` 报错，见下面 FX22 两条），正常路径交给 WebGL 的着色器源码与冻结金标准里的 47 段摘要逐字节相同，r170 的输出没变。ID 图的半浮点原值、七张中间缓冲、九张只开一道的画面与整帧，本执行器在 macOS Metal 与 SwiftShader 上实测都是两版逐字节相同。
- OutputPass：两页各用自己那一版的 `three/addons/postprocessing/OutputPass.js`。版本门按两张渲染页实际发出的模块请求核，不看页面自己解析 import map 的结果：r170 页要请求过 `node_modules/three/` 下的 OutputPass、一次也没请求 `node_modules/three-webgpu/`，r187 页反过来；r187 的核配 r170 的 OutputPass（import map 写错，或 `engine/look` 里的导入写成直指 r170 的相对路径）报 `env.three-revision-mismatch` 或版本门不过，`candidateAddons` 照实写错载的那一版。逐行比对两版：r187 把内部的 `fsQuad` 改名 `_fsQuad`、加了 `isOutputPass` 标记与 CustomToneMapping 分支，NoToneMapping + sRGB 输出这一路的着色器相同；`createLook` 只调 `out.render` 与 `out.material.dispose()`，两版都在。
- 渲染目标与深度：主场景（MSAA 4 倍、半浮点、FloatType 深度纹理）与 ID 图（Nearest、半浮点、FloatType 深度纹理）两版读回一致；`readRenderTargetPixels` 读半浮点目标两版都要给 Uint16Array。ID 图的顶点着色器用的 three 块（batching、morphtarget、morphinstance、skinning、begin_vertex、project_vertex）r187 里都在，InstancedMesh 的 `gl_InstanceID` 编号两版相同。
- 投影：标定场景里的卡通材质带平行光投影。r187 删掉了 PCFSoftShadowMap，场景在 r187 下设 PCFShadowMap，采样核由 `engine/shade` 的 `quantizeShadow` 换回 r170 的（见 [r187-toon-regression.md](r187-toon-regression.md)）；`engine/stage/film.js` 的 `createFilm` 默认值仍写死 PCFSoftShadowMap（不在本次改动范围），整条出片链切到 r187 时要跟着改。
- 片段补丁没命中算构建失败（FX22）：`engine/shade/patch.js` 收紧了三处以前会悄悄放过的地方。给了 `vertexNormal` 钩子而着色器里没有 `#include <beginnormal_vertex>` 时现在抛错（以前不打这段补丁、照常出图）；投影块既不是 r187 的写法、也没有 r170 自带的软阴影核（`SHADOWMAP_TYPE_PCF_SOFT`）时抛错（以前按 r170 的路走、不换核）；投影量化的那句返回在投影块里不止一处（r170 两处、r187 五处），漏换一处画面就错、却没有任何编译错误，所以现在只认对拍过的投影块原文（three r170 / r187 发行包里的：两版的 build，加 r187 `src/` 里带注释的那份；按长度与正反两个摘要认）：这段文本有任何改动都抛错，包括只坏其中一处返回、某个函数的形参连同返回一起改名，以及合法且语义没变的改写（返回里夹一段块注释、用块注释顶替空格、宏给函数或 `return` 起别名、预处理死分支里留原句；按文本数函数体与返回的核法在这些改写上都放行过，头一处漏换、照常出图）；three 升级后投影块变了，重新对拍再把新的摘要加进 `SHADOW_CHUNKS`。`inject` 只按当前未展开文本排除 `//` 与 `/* */` 常规注释（注释记号中间、行注释末尾夹着「反斜杠 + 换行」的，照 GLSL ES 3.00 先接行再认注释的规矩认）及以前的 `inject` 插进去的文本（材质钩子、引擎自己的片段），`#include` 照 three 自己展开它的正则认（顶着行首），不模拟 GLSL 预处理与 three 循环展开，也不防页面改写 three 着色器模板与 chunk 来藏锚点（见 `patch.js` 文件头的 `shortcut:`）；命中的一处都没有、或者不止一处都抛错；以前照第一次出现的位置换，材质参数 `fragmentPars` 里一段注释先提到 `#include <shadowmap_pars_fragment>`，量化过的投影块就整段写进注释里，生效的那条展开成没量化的原版，照常出图；钩子文本在预处理死分支里把几处锚点另写一套、再用注释把原来的盖住，补丁也曾整段落进死分支。`quantizeShadow` 先核投影块是不是字符串：three 升级把这个块整个拿掉时抛的是补丁错（以前是 `TypeError`，不记进补丁错误记录，页面接住就照常画回退帧）。`engine/look/compose.js` 的纸纹变体也改成用 `inject` 换。r170 下打完补丁的着色器源码与改动前逐字节相同（`engine/shade/r187-toon-regression.golden.json` 的 64 段摘要没变）。
- 构建失败的实测（`engine/look/r187-look-regression.test.mjs` 的 FX22 用例）：两版页面里故意改错十种着色器原文（卡通合成替换的那一行光照、两处 `#include` 被展开成原文、投影块里 `getShadow` 的返回写法全改、只改头一处、头一个的形参连同返回一起改名、头一处返回里夹一段块注释、头一个的函数头与返回各用一段块注释顶替空格、阴影深度材质的 `#include <begin_vertex>`、软阴影采样核），`renderer.compile`、`look.render`、单独的 ID 图三条编译路径都同步抛错并点名锚点（阴影深度材质只在渲阴影时编译，`renderer.compile` 与单独的 ID 图碰不到它，整条后期链那一路抛）；ID 图里物体自己的 `onBeforeRender` 出的错照旧忽略，但着色器补丁的错（`ShaderPatchError`）原样抛出，材质 `onBeforeCompile` 的错照常抛出。渲染器这边（`engine/render/page.mjs` + `lib/patch-check.mjs`）：补丁抛错时同时在 `patch.js` 的模块闭包里记一条结构化记录，页面代码没有写它的入口（不挂 `globalThis`、不导出写入函数），渲染器读只读副本（`patchCheck(page)`），哪些地址算 `patch.js` 由渲染器这边定：页面实际请求过、路径以 `/shade/patch.js` 结尾的地址；页面实际加载过、响应内容与引擎的 `patch.js` 原文逐字相同的脚本（`//patch.js`、大小写不同、`patch%2Ejs`、改了名的副本；内容在渲染器这边比，页面的 CSP、改写 `fetch` 都碰不到）。同一个地址带上不同的 `#片段` 导入是各记各的模块实例，而请求地址里没有 `#片段`，所以开页面时先于页面任何脚本放一个登记口（不可写、不可重配，取出来要这一页的随机口令），`patch.js` 每个模块实例求值时把自己的模块地址登记进去；谁都能调登记口，所以只收地址、不收函数，而且去掉 `#片段` 之后要是渲染器认下来的地址才读，页面登记一个自己没加载过的地址，渲染器不去 import。`blob:` / `data:` 地址渲染器这边收不到响应，只核验正文。创建 `blob:` 地址时在内存中比对，注销后仍保留结果。`data:` 直接解码，正文与引擎源码逐字相同才读取模块记录。认下来的地址在页面里 import 同一个模块实例来读，落到同一个实例的只读一次；读到的记录只认带机器前缀的，不看排第几。置 READY 之后读一次，此后这一页每次 `page.evaluate` 把结果交回调用方之前都读（开页面时加的守卫；`renderFrame`、超采样 / GPU 直出的 `captureGpuFrame`、收尾都是经 `page.evaluate` 驱动 `render(t)` 的，不用各自调）；所以这个错不管是置 READY 之前的未捕获异常、`render(t)` 抛错、被页面接住后打到 `console.error`，还是接住后把 `console.error` 静音、照常画回退帧，单采样与 `--samples 4`，`still.mjs` 都以退出码 1（`failure.shader-error`）失败、不留图，`--allow-gl-errors` 不放行；出错的 `inject` 来自 `patch.js#calibration` 或 `patch%2Ejs` 那个实例时也一样（`--samples 4` 读出 4 条）。夹具换成 r187 那一套（`?three=187`）时，五处返回只坏头一处、头一处返回里夹块注释、用块注释顶替空格，同样退出码 1、不留图。`render(t)` 返回之后才冒出来的补丁错（页面里没等的异步活，页面接住后画回退帧）由截图之后补读的那一次拦住：`capture` 走 CDP 截图、不经 `page.evaluate`，截完再读一次记录，回退帧不落盘。反过来，着色器没出错的页面往以前那个全局键 `Symbol.for('beiming.shaderPatchErrors')` 塞一条合成记录、再往 `console.error` 打一行带机器前缀的字，照常退出码 0 出图（带前缀的 `console.error` 只是线索，渲染器当场去读模块里的记录，没有就不判）；作品自己用 `console.info` / `console.warn` 打一句「字幕变体对不上了」也照常出图。四审的两项与交付前红队的四项（FX22-5，两版都跑）：材质的片元参数里用块注释 / 行注释先提到投影块的 `#include`、或写在预处理死分支里，照常出图且与不带这段参数的那一帧逐字节相同；片元参数在死分支里把片元补丁要找的几处原文另写一套、再把原来的盖住，用带行续接的合法注释（`/* *\换行/`）的照常出图且与正常帧相同，把 `/*` 放进 three 会整段删掉的 0 次循环里的退出码 1；把生效的那条注释掉，退出码 1、不留图。页面赶在 `patch.js` 之前往登记口塞只回空消息的读出口，真的补丁错照样判（单采样 1 处、`--samples 4` 4 处，空消息不计数）；着色器没出错的页面往登记口塞合成的读出口（单塞函数、函数配假地址或真的 `patch.js` 地址、自造一个报错模块的 `data:` 地址、页面没加载过的 `…/shade/patch.js` 地址），照常退出码 0，图与正常帧相同；`patch.js` 的原文装进 `blob:` 地址再导入，它记的错照样读到；页面给自己加一条 CSP 挡住 `fetch` 时，`patch.js#calibration`、`//patch.js`、`blob:`、`data:` 那个实例记的错也照样判。
- FX22-6 在两版的单采样与 `--samples 4` 下补验 CSP（`connect-src 'none'`）与内存模块核验：主文档导入同源 iframe 创建的 `blob:` 补丁模块后立即注销地址，仍能按创建时缓存的正文比对结果读到真实补丁错，退出 1 且无 PNG；同时登记正文不同的 `blob:`（含同源 iframe 创建的等长异文模块）与 `data:` 的健康对照退出 0，PNG 与同版同采样的正常帧逐字节相同。跨源 iframe 或 Worker 创建的 `blob:` 地址未登记，见 `patch-check.mjs` 文件头的 `shortcut:`；`inject` 只按当前未展开文本排除常规注释与历史注入区间，不模拟 GLSL 预处理或循环展开，不防页面改写 three 着色器模板与 chunk 来藏锚点（`quantizeShadow` 仍保留 `SHADOW_CHUNKS` 原文摘要校验），见 `patch.js` 文件头的 `shortcut:`。
- 没有覆盖的：不经 `openFilm` 自己开页面调 `window.render` 的工具（`tools/baseline`、`tools/qa`，不是出片入口，不在本次改动范围）不读补丁错误记录，只在错误没被页面接住时失败；在 iframe / Worker 里自己执行的 `patch.js` 渲染器读不到（出片页都在主文档里建材质；主文档导入同源 iframe 创建的 `blob:` 已核验，跨源 iframe 或 Worker 创建的 `blob:` 未登记）；不防页面改写 three 着色器模板与 chunk 来藏锚点（`inject` 不模拟 GLSL 预处理与循环展开；投影块仍由 `SHADOW_CHUNKS` 按原文摘要校验）；不防页面改写运行环境（内建原型、`Promise.allSettled`、`URL` 这类静态方法与全局），也不防页面用 import map 把某个 `patch.js` 地址改指到别的模块（同样的手法能把引擎的 `patch.js` 整个换成不抛错的，页面里怎么读都拦不住）；作品自己在一个路径以 `/shade/patch.js` 结尾的地址上放一个模块并加载它，它报的带机器前缀的记录照认（页面自己让构建失败，不会让该失败的放行）；改过的 `patch.js` 副本放在别的路径上（或装进 `blob:`）时不认，它记的错读不到；`inject` 只按文本认「上一次的结果」，调用方在两次 `inject` 之间自己改过着色器文本的，钩子文本里的假锚点只按注释认；出完最后一帧之后才冒出来的补丁错不读（图已经是对的）；页面真的调 `inject` 去找一个没有的锚点，记下的是真的补丁错，照样判失败；r187 新加的 `getSunShadow`（SunLight 的级联投影）经 `getShadow` 量化，没有单独对拍；OutputPass 的色调映射各分支（出片链用 NoToneMapping）；外部图片纸纹（`paperUrl`、纸纹锚点与面积取样变体）；Kuwahara 的各向异性分支与远近换半径；蒙皮、变形目标、BatchedMesh 的 ID；Sprite / Points / Line 的挡线判定；非 1080 标定的像素缩放（本场景按自己的画幅标定，k = 1）；r187 的 WebGPURenderer（它不走 `onBeforeCompile`，是另一条路线）。
