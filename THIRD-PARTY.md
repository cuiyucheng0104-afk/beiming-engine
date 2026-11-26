# 第三方来源、固定版本与许可义务

本仓库整合了三类上游材料。**许可证与署名文件是仓库的一部分，不可删除、不可改写、不可在改写后冒充原创。** 本页列出固定版本、用途与义务；逐文件清单见 `cases/catalog.json` 与 `cases/vendor/lock.json`，逐路径的机器可读许可对照见 [REUSE.toml](REUSE.toml)，许可全文在 [LICENSES/](LICENSES/)，授权登记见 [docs/rights/register.md](docs/rights/register.md)。作品站构建时另外用到的依赖与字体见第 6 节；FSL 使用边界、派生代码、署名区块、CC BY 署名与路线模版、声音的第三方材料见第 7–11 节。

## 1. 上游仓库

| 来源 | 固定提交 | 许可 | 在仓库中的位置 | 用途 | 义务 |
|---|---|---|---|---|---|
| [xiaoxiong20xx-code/sy-style-100](https://github.com/xiaoxiong20xx-code/sy-style-100) | `e41dee31a5c05dffa12b2f241378e648d2a22df6` | MIT（XIAOXIONG） | `cases/vendor/sy-style-100/`（331 个跟踪文件，原样） | 20 风格 / 100 示例、lib、渲染与声音工具；画风参照 | 保留版权声明与 MIT 许可（`cases/licenses/XIAOXIONG-MIT.txt`） |
| [lemomo-ai/lemo-opuscar](https://github.com/lemomo-ai/lemo-opuscar) | `bebbbe1aa92a3cb4bb6f83500e61b23a17d1aa00` | 代码 MIT（LemoLab）；例片与静帧 CC BY 4.0 | `cases/vendor/lemo-opuscar/`（2478 个跟踪文件，原样） | 66 风格、demo、core、导演与技术文档；历史 66 部风格实验的方法来源 | 保留版权声明与 MIT 许可（`cases/licenses/LemoLab-MIT.txt`）；例片与静帧按 CC BY 4.0 署名 LemoLab；本仓库主体的派生代码见第 8 节 |
| [shinyobjectz/raea](https://github.com/shinyobjectz/raea) | 源码对照 `fb3f70844e03cc40185e3a06c394060d26c5cd38`；运行发行版 v0.1.4（对应提交 `d870159c4686bd1fcda094934602463549b26683`，2026-11-15 发布，2028-11-15 转为 Apache-2.0；早期基线 v0.1.0-canary.2 为 2026-10-31 → 2028-10-31） | FSL-1.1-ALv2（Functional Source License 1.1，到期转 Apache-2.0；版权人 Shane Murphy） | **运行时与 SDK 不随本仓库分发**；仓库仅含源码对照、集成方案与自有的调用代码（`engine/native/`、`examples/raea/`） | B 路线（北冥原生 · BNE）的原生运行时 | 单独取得并按 FSL 条款使用；只作内部制作层（D03），不对外提供基于它的产品、SDK 或渲染服务；不分发运行时、不复制其源码；边界见第 7 节与 [docs/rights/fsl-boundary.md](docs/rights/fsl-boundary.md)；升级版本时同步更新本行的版本、发布日与转换日期 |
| [voyager-so/vork](https://github.com/voyager-so/vork) | 运行发行版 0.5.1（2026-11-11 发布；`--version` 报的短提交 `626653ebf900`） | vork Preview License（上游自定义的预览许可，不是开源许可；版权人 Nullframe, Inc.） | **渲染器不随本仓库分发**，仓库也不含它的源码、着色器与文档原文；仓库只有自有的调用代码与锁定记录（`engine/native/rt.mjs`、`engine/native/rt.lock.json`）和自有的分层风格化（`engine/look/layers.js`） | B 路线（北冥原生 · BNE）的光追外部后端 rt，实验阶段：出写实光照的分层图，北冥做风格化 | 单独取得官方发行包并核对 sha256；只作内部制作层与学术研究，不分发、不复制其代码、不做对外渲染服务；许可只覆盖这一版，升级前重读新版本的许可；边界见 [docs/rights/rt-boundary.md](docs/rights/rt-boundary.md) |
| [meshy-dev/ThreeRT](https://github.com/meshy-dev/ThreeRT) | 短提交 `c946cc9`（完整 40 位提交与三平台二进制 `sha256` 锁在 `engine/pathtrace/runtime.lock.json`，运行包版本 `0.1.1-beiming.1`） | MIT（2026 Meshy LLC；若运行包开启 `--features oidn` 则动态链接 Intel Open Image Denoise，Apache-2.0） | D 路线：**可执行文件不进本仓库 git，`engine/pathtrace/` 与 `routes/d-pathtrace/` 两个目录内不放 Rust / WESL / WGSL 源码**（D10、D13），运行包存放在仓库外本地缓存 `~/.cache/beiming/pathtrace/` 或由 `BEIMING_PT_BIN` 指向，这两个目录仅含自有的 MIT 调用与场景封装层。核心帧源：路径追踪内核从同一固定提交分叉、只留离线渲染一路，源码在 `beiming/sources/core/path/`（上游许可全文 `LICENSE-upstream.txt`，来源说明 `PROVENANCE.md`），源码边界见[核心帧源的源码边界](docs/decisions/2026-11-23-core-source-boundary.md)（D14）；编出的程序与构建缓存不进 git；跑测试时 `beiming/sources/core/chassis/build.mjs` 仍按同一固定提交把上游取到被忽略的 `out/chassis/`，只用它的场景打包工具与自带的测试脚本 | D 路线（北冥光追 · 物理路径追踪）的原生 wgpu 硬件光追与 Compute BVH 运行时；核心帧源路径追踪内核的分叉起点 | 保留上游 MIT 版权与许可声明（核心帧源的分叉源码随附许可全文，每个源文件注明来源与改过，见第 8 节）；分发含 OIDN 的预编译运行包时一并附 Apache-2.0 许可与 NOTICE；遵守 D04 命名规则，不用上游项目名作我方产品名、路线名或目录名（登记见 [docs/rights/register.md](docs/rights/register.md) R15） |

## 2. 仓库自有内容

| 内容 | 许可 | 说明 |
|---|---|---|
| `engine/`、`src/`、`lab/`、`tools/`、`routes/`、`site/` 等自有代码 | MIT | 见根 [LICENSE](LICENSE)；文件头标注第三方版权的派生文件按上游许可（目前都是 MIT），见第 8 节与 [docs/rights/licensing.md](docs/rights/licensing.md) |
| 《北冥》影片、底板、展示图（含作品站 `site/assets/` 的海报与静帧） | 保留所有权利 | 不因仓库开源而变更；绘画底板由 AI 生成（Midjourney V8 / GPT Image 2.5）后人工整理。含 AI 生成内容的画面、配音与配乐按所在作品的权利，标识办法见 [docs/rights/aigc.md](docs/rights/aigc.md) |
| 字体 | SIL OFL 1.1 | 仓库字体见 [fonts/LICENSE.md](fonts/LICENSE.md)；C 模版片名字体见第 11 节；原生例片内嵌字体见 [examples/raea/README.md](examples/raea/README.md)；作品站字体见第 6 节 |
| 历史 PPT 影片、发布会影片、配音、生成音乐、原画与素材包 | 原项目权利范围 | 仅作展示与学习参考，归档不额外授予商业复用权 |
| Three.js 等随片依赖 | MIT | 见 `cases/licenses/three-MIT.txt` 与各工程原有声明 |

## 3. 归档与快照的校验方式

```sh
node tools/env/py.mjs tools/casebook.py check   # 通过：96 条记录、2243 个唯一源文件、2809 个 vendor 文件（2 个快照）
node tools/env/py.mjs -m unittest discover -s tools -p test_casebook.py
```

`cases/vendor/lock.json` 为每个文件记录 `path / mode / gitBlob(SHA1) / sha256 / size`；`cases/catalog.json` 为案例源文件记录 `sha256 / originalSha256 / size`。带还原标记（templated）的条目不记 `originalSha256`：公开脱敏前的哈希能反推出标记原值（2026-11-10 删除）；归档后在新提交里改过的文件记 `redactions`，例如 `signed-url-query`。校验覆盖全部跟踪文件，任何改动都会被抓到。

## 4. 使用规则

1. 外部快照**只读**：不就地修改 `cases/vendor/`；需要改就复制到独立工程，并保留来源说明。
2. 案例还原用 `node tools/env/py.mjs tools/casebook.py restore <id>`（即 `npm run cases:restore -- <id>`）；源码里的 `@@CASE_ROOT@@ / @@WORKSPACE_ROOT@@ / @@LEMO_ROOT@@ / @@ROG_HOST@@` 是显式还原标记，**不能把归档路径当可执行项目**。还原只替换已知工作区路径，不自动修复历史构建逻辑。
3. 引用上游代码写自己的模块时，保留派生说明与许可，并在第 8 节登记；「整合、改写、调参」不改变原作者权利。
4. 对外发布时随附本页与 `cases/NOTICES.md`；不要删除 `LICENSE`、`cases/licenses/` 与 vendor 目录内的许可文件。
5. 状态按实际证据写：历史成片、技术通过、用户认可分别标注；《豹变》四版与北冥九分钟的后续否定反馈优先于旧文件措辞。

## 5. Windows 注意

- 仓库按 LF 检出：根目录的 `.gitattributes` 已规定文本一律 LF、`cases/source/` 与 `cases/vendor/` 按原字节不做转换，新克隆无需额外设置。如果是在加入 `.gitattributes` 之前克隆、用 CRLF 检出的旧工作区，先提交或备份未提交的改动（下面这条命令会丢弃它们），再执行 `git rm --cached -r -q . && git reset --hard` 按新规则重新检出，否则文本文件字节变化会让 `casebook.py check` 报 `Checksum mismatch`，Git blob 校验也会失败。
- npm 脚本经 `node tools/env/py.mjs` 启动 Python，Windows 上自动找到仓库的 `.venv`（`npm run setup` 建），不依赖 python3 别名。换行由 `.gitattributes` 固定，不需要再设 core.autocrlf。
- 符号链接相关的还原测试需要「开发者模式」或管理员权限，否则 Windows 上会有 1 个环境性失败。

<!-- 第 6 节起引用了上游的版权行：REUSE 工具不把它们当成本文件自己的版权声明（本文件的许可与版权按 REUSE.toml） -->
<!-- REUSE-IgnoreStart -->

## 6. 作品站（`site/`）的依赖与字体

作品站用 `npm run site:build`（即 `tools/build-showcase.py`）构建到 `out/site/`，GitHub Pages 发布的是同一份构建产物。下列文件在构建时从 `node_modules/` 或 Google Fonts 取出放进产物，**不提交进仓库**；npm 依赖的版本由 `package.json` 与 `package-lock.json` 固定，字体取构建当时 Google Fonts 提供的版本。

| 依赖 | 固定版本 | 许可与版权 | 进入构建产物的文件 | 义务 |
|---|---|---|---|---|
| [three.js](https://github.com/mrdoob/three.js) | `0.170.0` | MIT，Copyright © 2010-2024 three.js authors | `vendor/three/three.module.min.js` 与实际用到的 `addons` | 保留文件内的版权与许可声明；全文见 [cases/licenses/three-MIT.txt](cases/licenses/three-MIT.txt) |
| [GSAP](https://gsap.com)，含 ScrollTrigger、Flip 插件 | `3.15.1` | GSAP 标准免费许可（Standard "No Charge" License，现由 Webflow 授予），条款见 <https://gsap.com/standard-license>；Copyright 2008-2026 GreenSock | `vendor/gsap/gsap.min.js`、`ScrollTrigger.min.js`、`Flip.min.js` | 用在网站与应用上免费，商业项目也可以；不得用于与 Webflow 竞争的无代码动画搭建工具。它**不是 MIT 等开源许可**，不随本仓库的 MIT 再授权；保留每个文件头的版权与许可声明 |
| [Ma Shan Zheng](https://github.com/googlefonts/mashanzheng)（马善政毛笔楷书） | 构建当时的 Google Fonts 版本 | SIL OFL 1.1，Copyright 2018 The MaShanZheng Project Authors | `css/fonts.css` 及按页面实际用字生成的子集 | 子集由 Google Fonts CSS2 API 的 `text=` 参数生成，不改字形、不改字体名；许可全文见 [fonts/LICENSE.md](fonts/LICENSE.md) |
| [Barlow](https://github.com/jpt/barlow)，300 / 400 / 500 / 600 | 构建当时的 Google Fonts 版本 | SIL OFL 1.1，Copyright 2017 The Barlow Project Authors | 同上，只取数字与西文 | 同上 |

- 字体子集下载后放进产物，由站点自己提供，访客浏览时不连 Google Fonts；[fonts/LICENSE.md](fonts/LICENSE.md) 也随产物复制，`css/fonts.css` 文件头写明字体与许可。
- 构建时连不上 Google Fonts，构建器打印警告，改用仓库 `fonts/` 里自带的子集（毛笔字只有“北冥”两个字，Barlow 只有 300、400、500）并退回系统字体，构建本身不失败。
- 站上播放的作品预览来自 [casebook-2026.11](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/tag/casebook-2026.11) Release，海报来自 `cases/previews/`，样片是仓库里的 `media/beiming.mp4`（与 [v1.0](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/tag/v1.0) Release 的 1080p 版逐字节相同）。它们的权利范围同第 2 节的影片与历史素材，不因进入站点而改变。
- 作品站可见文字只用对外名称（见 [AGENTS.md](AGENTS.md)「命名」）；上游来源与许可仍以本页第 1 节为准，不因对外改名而省略。

## 7. FSL 使用边界（B 路线 · 北冥原生 · BNE）

B 路线调用的原生运行时 RAEA 以 FSL-1.1-ALv2 发布：每个版本发布满两年后转为 Apache-2.0，在此之前排除「竞争性使用」。本仓库只把它当内部制作工具：自制影片、为客户制作并交付成片、为本身持有 RAEA 许可的客户提供专业服务。

- 不把 BNE、`engine/native/` 或任何基于 RAEA 的东西作为对外的商业产品、SDK 或托管渲染服务；不分发运行时与 SDK；不复制或改写其源码；上游名只在技术说明、署名区块与许可说明里出现。
- 现用版本 v0.1.4（标签提交 `d870159c4686bd1fcda094934602463549b26683`），2026-11-15 发布，2028-11-15 转为 Apache-2.0（早期基线 v0.1.0-canary.2 于 2026-10-31 发布、2028-10-31 转换）；`docs/raea/` 源码对照固定在完整提交 `fb3f70844e03cc40185e3a06c394060d26c5cd38`。每个版本的转换日期按它自己的发布日单独算。
- 商业化之前须先取得上游书面许可或法律意见。全文见 [docs/rights/fsl-boundary.md](docs/rights/fsl-boundary.md)。

## 8. 派生代码（LemoLab MIT）

本仓库主体中以下文件的部分代码改写自 LemoLab 的 lemo-opuscar（固定提交 `bebbbe1aa92a3cb4bb6f83500e61b23a17d1aa00`，MIT，Copyright (c) 2026 LemoLab，许可全文 [cases/licenses/LemoLab-MIT.txt](cases/licenses/LemoLab-MIT.txt)）。改写部分的版权归 LemoLab，按其 MIT 许可使用；文件头写明了具体函数与上游路径（`@provenance`）。

| 文件 | 改写自（lemo-opuscar@bebbbe1） |
|---|---|
| `engine/core/math.js` | clamp、lerp、seg、ss、ei、eo、eio、monotone 改写自 `core/lib.js`；hashi 的常数与同库 `styles/hd-2d/demo/px.js` 相同 |
| `engine/form/curves.js` | `catmull()` 改写自 `styles/rubber-hose/demo/toon.js` 的 spline |
| `engine/form/sdf.js` | `edt1d` / `edt2d` 的两趟写法改写自 `styles/woodcut/demo/engine/hatch.js`（算法本身是公开的 Felzenszwalb–Huttenlocher） |
| `engine/overlay/brush.js` | `chamfer()`，以及「字形当蒙版、沿笔画中线揭开」的做法，改写自 `styles/chalkboard/demo/js/chalk.js`；hash1 / vnoise 与 `core/lib.js` 相同 |
| `engine/paint/affine.js` | mul、translate、rotate、scale、apply 与矩阵约定改写自 `styles/papercut-red/demo/rig.js` |
| `engine/paint/curve.js` | `catmullRom()` 改写自 `styles/urban-sketch/demo/engine.js`；曲线对象与 pointAt / project 的做法取自 `styles/transit-map/demo/film.js` |
| `tools/contact_sheet.py` | 旧用法的参数解析与格子排法改写自 `core/render/sheet.py` |
| `tools/rtx/gpucheck.mjs` | WebGL 全屏三角形的编译与绑定写法改写自 `styles/urban-sketch/demo/engine.js` |

- 其他来源：`engine/shade/noise.glsl.js` 的 toonHash33、toonHash13 公式取自 David Hoskins「Hash without Sine」（2014，MIT，<https://www.shadertoy.com/view/4djSRW>），版权与许可原文写在文件头。
- 其他来源：`beiming/sources/core/shaders/microfacet.wgsl` 逐行移植自 Blender Cycles 内核（标签 `v5.2.3`，提交 `e13b728c6880d3084d9d57c30031ed5df8b39dee`）的 `intern/cycles/kernel/closure/bsdf_microfacet.h`、`bsdf_util.h`、`bsdf_diffuse.h`、`emissive.h` 与 `kernel/sample/mapping.h`（BSD-3-Clause，Copyright 2009-2010 Sony Pictures Imageworks Inc., et al.；2011-2022 Blender Foundation；改编自 Open Shading Language）。版权与许可写在文件头，许可全文 [LICENSES/BSD-3-Clause.txt](LICENSES/BSD-3-Clause.txt)。核对工具在编译时包含的 Cycles 源码不随本仓库分发。
- 其他来源：同一提交的 Cycles 还派生出七处。`beiming/sources/core/shaders/microfacet.wgsl` 里金属反射闭包与电介质高光（广义 Schlick）的建立、求值、采样、反照率估计与能量补偿移植自 `intern/cycles/kernel/closure/bsdf_microfacet.h`，电介质的菲涅耳与层间权重移植自 `bsdf_util.h`，漫反射闭包移植自 `bsdf_diffuse.h`，发光值移植自 `emissive.h`，同心圆盘与余弦半球采样移植自 `intern/cycles/kernel/sample/mapping.h`（都是 BSD-3-Clause，版权人同上）。`beiming/sources/core/shaders/util.wgsl` 的工具函数移植自 `intern/cycles/util/math_base.h`、`math_float3.h`、`math_intersect.h`、`projection.h`、`transform.h`、`color.h` 与 `intern/cycles/kernel/util/lookup_table.h`、`kernel/types.h`、`kernel/svm/closure.h`、`kernel/integrator/surface_shader.h`（Apache-2.0，Copyright 2011-2013 Intel Corporation；2011-2022 Blender Foundation）。`beiming/sources/core/shaders/ggx_tables.wgsl` 与 `ggx_gen_schlick.tables` 是 `intern/cycles/scene/shader.tables` 里 `table_ggx_E`、`table_ggx_Eavg`（前一个文件）与 `table_ggx_gen_schlick_ior_s`、`table_ggx_gen_schlick_s`（后一个文件）四张表的数值原样照抄（Apache-2.0，Copyright 2011-2022 Blender Foundation）。`beiming/sources/core/shaders/area_light.wgsl` 的矩形面光采样、求值与求交移植自 `intern/cycles/kernel/light/area.h`，返回值结构对应 `kernel/light/common.h` 的 `LightSample`、`LightEval`（Apache-2.0，Copyright 2011-2022 Blender Foundation）。`beiming/sources/core/path/shaders/hash.wgsl` 与 `beiming/sources/core/path/src/cycles_hash.rs` 里算每个像素随机数种子的哈希函数 `hash_iqnt2d` 移植自 `intern/cycles/util/hash.h`（Apache-2.0，Copyright 2011-2022 Blender Foundation）。`beiming/sources/core/shaders/imaging.wgsl` 的像素滤波查表与贡献的夹取移植自 `intern/cycles/kernel/util/lookup_table.h`、`kernel/camera/camera.h`、`kernel/film/light_passes.h`、`util/math_base.h`、`util/math_float3.h`，`beiming/sources/core/path/src/pixel_filter.rs` 的三个滤波函数与建表移植自 `intern/cycles/scene/film.cpp`、`util/math_cdf.h`、`util/math_cdf.cpp`（都是 Apache-2.0，Copyright 2011-2022 Blender Foundation）。版权与许可写在各文件头，Apache-2.0 许可全文 [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt)。
- 其他来源：`beiming/sources/core/path/` 这一批（`src/` 下 21 个 Rust 文件、`shaders/` 下 11 个 WGSL 文件（其中 7 个是从上游的 `pathtrace.wgsl` 按阶段分出来的；另有两个照 Cycles 移植的哈希文件，见上一条）、`presets/` 两个预设、`tests/render/data/` 一个测试模型，以及 `Cargo.toml`、`Cargo.lock`、`rust-toolchain.toml`）派生自 ThreeRT（<https://github.com/meshy-dev/ThreeRT>，固定提交 `c946cc96bdb08979224e851a7fc67a066b1b456b`，MIT，版权人 Meshy LLC）：只留离线渲染一路，并把上面几条的 Cycles 移植着色器接进内核。每个源文件第一行注明对应的上游路径；逐文件对照、切掉了什么、北冥加了什么见 [PROVENANCE.md](beiming/sources/core/path/PROVENANCE.md)，上游许可全文见 [LICENSE-upstream.txt](beiming/sources/core/path/LICENSE-upstream.txt)，两个版权人登记在 [REUSE.toml](REUSE.toml)。`shaders/` 下另有六个文件（`integrator.wgsl`、`sample.wgsl`、`shader.wgsl`、`closure.wgsl`、`pathtrace.wgsl`、`intersect.wgsl`）在上游与北冥自己的代码之外，带着照同一提交的 Cycles 取的名字、数值或函数骨架（没有整段搬代码）：路径标志位与可见类、随机维度的枚举、着色点与物体的标志、采样标签、局部求交的上限，路径状态、光线、着色点、闭包、积分器参数块与物体扩展表的字段名，`path_state_next`、`path_rng_*`、`trace_local` 的骨架与像素种子的式子，`surface_shader_*`、`bsdf_eval`、`bsdf_sample`、`bsdf_albedo`、`bsdf_eval_accum`、`closure_sample_weight` 与原理化 BSDF 建闭包的次序与权重（照原式重写），分别来自 `intern/cycles/kernel/` 下的 `types.h`、`data_template.h`、`svm/types.h`、`svm/closure.h`、`integrator/state_template.h`、`integrator/path_state.h`、`integrator/surface_shader.h`、`sample/pattern.h`、`closure/bsdf.h`、`closure/alloc.h`、`film/light_passes.h`、`film/denoising_passes.h`、`bvh/bvh.h`（Apache-2.0，Copyright 2011-2022 Blender Foundation）；`shader.wgsl` 里菲涅耳种类的名字与次序来自 `intern/cycles/kernel/closure/bsdf_microfacet.h`（BSD-3-Clause，Copyright 2009-2010 Sony Pictures Imageworks Inc., et al.；2011-2022 Blender Foundation）。`src/` 下另有三个 Rust 文件带着同一类内容在 CPU 上的镜像：`gpu.rs`（积分器参数块的字段名，`data_template.h`）、`sample.rs`（每次弹射的随机维度个数与像素种子的式子，`types.h`、`sample/pattern.h`）、`scene.rs`（物体扩展表的字段名与物体标志的位，`types.h`）。这九个文件的文件头写成多方许可（MIT 与 Apache-2.0，`shader.wgsl` 另加 BSD-3-Clause），逐文件对照见 PROVENANCE.md 的「照 Cycles 取的部分」。
- 只借做法、没有搬代码（不列入上表）：`engine/core/stroke.js` 只借用了 perfect-freehand（Steve Ruiz，MIT）的参数约定和三条默认公式，文件头已注明；`engine/render/lib/lock.mjs`、`engine/render/lib/slots.mjs` 的输出锁与渲染槽位借鉴 lemo-opuscar `core/render/video.mjs`、`core/render/slot.mjs` 的做法，代码是独立实现。
- 新增派生文件时在上表加一行；判定办法见 [docs/rights/licensing.md](docs/rights/licensing.md)。

## 9. 署名区块（对外物料的固定写法）

README 署名节与 Release 说明末尾都用这一句（作品站页脚已有同义文字）：

> 北冥原生 · BNE 基于第三方原生运行时 RAEA（shinyobjectz/raea，FSL-1.1-ALv2，版权人 Shane Murphy）。运行时不随本仓库分发，需单独取得并遵守其许可。北冥光追 · 物理路径追踪调用第三方开源路径追踪运行时 ThreeRT（meshy-dev/ThreeRT，MIT）。核心帧源的路径追踪内核派生自 ThreeRT（MIT，版权人 Meshy LLC）与 Blender Cycles（BSD-3-Clause 与 Apache-2.0，版权人见各文件头）。北冥代码动画风格的画法库部分来自 MIT 开源项目 lemo-opuscar（LemoLab）与 sy-style-100（肖雄 XIAOXIONG），版权与许可原样保留。

## 10. CC BY 署名

鼓组采样 MuldjordKit（Lars Muldjord，FreePats 版，CC BY 4.0）用于 11 个案例，钢琴采样 Salamander Grand Piano V3（Alexander Holm，CC BY 3.0）用于 3 个案例；署名原文与案例清单见 [cases/NOTICES.md](cases/NOTICES.md) 的「CC BY 署名」。用到它们的成片在分发时随附署名。lemo-opuscar 的例片与静帧（CC BY 4.0）署名 LemoLab，见第 1 节。

## 11. 路线模版与声音的第三方材料

| 材料 | 许可与版权 | 位置 | 说明 |
|---|---|---|---|
| 马善政毛笔楷书（Ma Shan Zheng）全部 7015 个字符，按码位切成 13 片 | SIL OFL 1.1，Copyright 2018 The Ma Shan Zheng Project Authors | `routes/c-style/fonts/mashanzheng-*.woff2`，许可全文 [routes/c-style/fonts/OFL.txt](routes/c-style/fonts/OFL.txt) | 来源 google/fonts@406197b，生成方法与各片 sha256 见 `routes/c-style/fonts/fonts.json`；C 模版的片名与印文用它 |
| 配乐采样库 VS Chamber Orchestra: Community Edition 与 Versilian Community Sample Library | CC0-1.0，Versilian Studios | 不随仓库分发 | 固定提交、逐文件地址与 sha256 见 `engine/audio/samples.json`，下载用 `npm run audio:samples`；《北冥》声音署名见 [audio/CREDITS](audio/CREDITS) |
| 音效分类与中英检索同义词表 Universal Category System (UCS) v8.2.1 | 公有领域（CC0-1.0），Tim Nielsen、Justin Drury、Kai Paquin 等（<https://universalcategorysystem.com>） | `engine/audio/ucs_vocab.json` | 抽自官方 `UCS v8.2.1 Full Translations.xlsx`（82 大类、753 子类、9973 个英文检索词、3020 个中文同义词），修正上游中文译表 8 处子类错位，供 `engine/audio/sfx_vocab.py` 与 `tools/fetch_sfx.py --vocab` 检索 |

## 12. 离屏出片的可选依赖（实验）

这条链路只用于新的 `engine/offscreen/`，不依赖 B 路线的运行时。通过 npm 取得并锁在 `package-lock.json`，不把二进制拷进仓库。用法与验证边界见 [离屏出片](docs/offscreen/README.md)。

| 依赖 | 锁定版本 | 实际许可 | 用途与义务 |
|---|---|---|---|
| [three.js](https://github.com/mrdoob/three.js)，npm 别名 `three-webgpu` | `0.187.0` | MIT，Copyright © 2010-2026 three.js authors | WebGPURenderer 与 TSL；旧链路仍用 `three@0.170.0`。保留包内 `LICENSE`，升级时重做预览对拍与确定性验证 |
| [Dawn Node 绑定](https://github.com/dawn-gpu/node-webgpu)，npm 包 `webgpu` | `0.6.2` | npm 元数据声明 MIT，但发行包 `LICENSE.md` 实际为 BSD-3-Clause，Copyright 2017-2025 The Dawn & Tint Authors；按包内原文履行义务 | Node 离屏 GPU 设备；保留包内版权与免责声明，分发二进制时随附这些内容，不用上游名称背书。不把 npm 元数据代替发行包许可；若以后分发该依赖，另核对二进制附带的全部第三方义务 |
| [@napi-rs/canvas](https://github.com/Brooooooklyn/canvas)，含平台包 `@napi-rs/canvas-linux-x64-gnu` | `1.1.1` | 包与平台包的 npm 元数据都声明 MIT，主包 `LICENSE` 为 MIT（Copyright (c) 2020，作者署名见包内 `LICENSE`）；平台二进制内含 Skia 等 138 个组件，随包 `sbom.cdx.json` 列出的许可有 MIT / Apache-2.0 / BSD / Zlib / ISC，另有 MPL-2.0 4 项、FTL（FreeType）1 项、未声明 9 项（待补） | 离屏出片的 Canvas 2D（程序化贴图、片名与显示层，可选依赖）；只作内部制作，不分发。若以后分发，先按 SBOM 逐项核对义务（MPL-2.0 的源码提供、FTL 的署名），未声明的 9 项先查清 |

Skia Canvas 仅在仓库外做过 C 模版对照实验（MIT），没有加入产品依赖，也没有复制其代码。

## 13. 做法参考（没有搬代码）

下面几项只借了做法或规则，代码是本仓库自己写的，所以不带上游版权行；列在这里是如实说明出处。

| 参考 | 许可 | 我方文件 | 借了什么 |
|---|---|---|---|
| W3C《中文排版需求》（[clreq](https://www.w3.org/TR/clreq/)） | 以原文页面的许可声明为准 | `engine/overlay/cjk.js` | 行首行尾禁则、符号分离禁则、标点宽度调整、汉字与西文间距的规则 |
| [852wa/JIZURA](https://github.com/852wa/JIZURA) | MIT，Copyright (c) 2026 hakoniwa | `engine/overlay/kinetic.js` | 文字入场部件的分类方式；用它在中文上渲过样张来挑动效 |
| [dososo/blcaptain-measure-cjk](https://github.com/dososo/blcaptain-measure-cjk)（分寸 · Measure） | 代码 Apache-2.0；规则文本与数据 CC BY 4.0，作者 爆裂队长NEXT（BLCaptain） | `engine/overlay/cjk.js`、QA 检查 `texts.cjk-break` | 行高取值区间的建议（默认行高 1.7 落在它建议的 1.6–1.9 内）、把排版规则做成机器检查的做法 |
| [feitangyuan/onetake@4e024be4c6c696b260f39a35aee6bd56d303b679](https://github.com/feitangyuan/onetake/tree/4e024be4c6c696b260f39a35aee6bd56d303b679) | [PolyForm Noncommercial License 1.0.0（上游 LICENSE）](https://github.com/feitangyuan/onetake/blob/4e024be4c6c696b260f39a35aee6bd56d303b679/LICENSE)，版权人 Patrick | [长镜头与媒介交接](routes/directing/craft/continuous-take.md)、[技术考察](routes/directing/craft/onetake-study.md)、[《校准环》](films/calibration-ring/README.md) | 参考节拍间视觉承接、连续运镜与量测复查。未引入上游源码、文档文字、成片、字体、音效、其他素材或运行时 |

<!-- REUSE-IgnoreEnd -->
