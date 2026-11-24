# 来源说明 · 核心帧源的路径追踪内核

读者｜维护者与全部 agent　依据｜[核心帧源的源码边界](../../../../docs/decisions/2026-11-23-core-source-boundary.md)（D14）、[THIRD-PARTY.md](../../../../THIRD-PARTY.md)

本目录的 Rust 与 WGSL 源码从开源路径追踪器 ThreeRT 的一个固定提交分叉而来，只留离线渲染一路，之后由本仓库自己维护。

## 上游

| 项 | 值 |
|---|---|
| 项目 | ThreeRT，<https://github.com/meshy-dev/ThreeRT> |
| 固定提交 | `c946cc96bdb08979224e851a7fc67a066b1b456b` |
| 许可 | MIT，版权人 Meshy LLC（2026）。许可全文原样放在 [LICENSE-upstream.txt](LICENSE-upstream.txt) |
| 本目录的许可 | 默认 MIT：上游的部分版权归 Meshy LLC，北冥改写与新增的部分版权归北冥引擎，逐路径登记在仓库根的 `REUSE.toml`。有十二个文件带着照 Blender Cycles 取的东西，版权与许可写在各自的文件头（文件头优先于 `REUSE.toml`），见下面「照 Cycles 取的部分」 |

每个源自上游的 `.rs` 与 `.wgsl` 文件第一行都写了它对应上游的哪个路径。

### 照 Cycles 取的部分

Cycles 是 Blender v5.2.3 的（提交 `e13b728c6880d3084d9d57c30031ed5df8b39dee`），下面的路径相对 `intern/cycles/`。没有整段搬代码的地方只取了名字、数值或函数的骨架，也照实标出来，和共用目录 `../shaders/` 下几个移植着色器的做法一致。

| 本目录的文件 | 许可 | 照 Cycles 取了什么 | Cycles 的文件（许可） |
|---|---|---|---|
| `shaders/hash.wgsl`、`src/cycles_hash.rs` | Apache-2.0 | 像素种子的哈希函数 `hash_iqnt2d`，逐行移植 | `util/hash.h`（Apache-2.0） |
| `shaders/integrator.wgsl` | MIT 与 Apache-2.0 | 路径标志位 `PATH_RAY_*`、可见类 `PATH_RAY_VISIBILITY_*`、`PRNG_BOUNCE_NUM`、`LABEL_VOLUME_SCATTER` 的名字与数值，光线的字段名；路径状态的字段名；`path_state_next` 的骨架 | `kernel/types.h`、`kernel/integrator/state_template.h`、`kernel/integrator/path_state.h`（都是 Apache-2.0） |
| `shaders/sample.wgsl` | MIT 与 Apache-2.0 | 随机维度的枚举 `PRNG_*` 的名字与数值；取数接口 `path_rng_1D`、`path_rng_2D`、`path_rng_3D`、`path_branched_rng_2D`；像素种子的式子 | `kernel/types.h`、`kernel/integrator/path_state.h`、`kernel/sample/pattern.h`（都是 Apache-2.0） |
| `shaders/shader.wgsl` | MIT、Apache-2.0 与 BSD-3-Clause | 着色点标志 `SD_BACKFACING` 的名字与数值，着色点与闭包的字段名；闭包种类 `CLOSURE_*` 的名字（数值是这里自己的）；菲涅耳种类 `FRESNEL_*` 的名字与次序；`shader_setup_closures` 里原理化 BSDF 建金属、电介质高光、漫反射三个闭包的次序与权重的算法（`kernel/svm/closure.h` 的 `svm_node_closure_bsdf` 原理化分支，照原式重写） | `kernel/types.h`、`kernel/svm/types.h`（Apache-2.0）；菲涅耳种类来自 `kernel/closure/bsdf_microfacet.h`（BSD-3-Clause，版权人 Sony Pictures Imageworks Inc. 等与 Blender Foundation） |
| `shaders/closure.wgsl` | MIT 与 Apache-2.0 | 采样标签 `LABEL_TRANSMIT` 的名字与数值；`surface_shader_*` 这一组函数的名字与分工，多个闭包之间的选择、求值求和与按 `sample_weight` 加权的概率密度（`surface_shader_bsdf_bssrdf_pick`、`_surface_shader_bsdf_eval_mis`、`surface_shader_bsdf_sample_closure`）、滤光泽与发光，逐函数照原式移植；`bsdf_eval`、`bsdf_sample` 按闭包种类分发、`bsdf_albedo`；求值的漫反射与光泽两份（`bsdf_eval_accum`）；闭包的取样权重（`closure_sample_weight`）；降噪反照率取哪些闭包 | `kernel/types.h`、`kernel/integrator/surface_shader.h`、`kernel/closure/bsdf.h`、`kernel/film/light_passes.h`、`kernel/closure/alloc.h`、`kernel/film/denoising_passes.h`（都是 Apache-2.0） |
| `shaders/pathtrace.wgsl` | MIT 与 Apache-2.0 | 物体标志 `SD_OBJECT_NEGATIVE_SCALE` 的名字与数值；积分器参数块 `KernelIntegrator` 的字段名；物体扩展表 `ObjectExt` 的四个字段名（`receiver_light_set`、`lightgroup`、两个阴影终止偏移） | `kernel/types.h`、`kernel/data_template.h`（都是 Apache-2.0） |
| `shaders/intersect.wgsl` | MIT 与 Apache-2.0 | `LOCAL_MAX_HITS` 的名字与数值、`LocalIntersection` 的字段名；`trace_local` 这个问法 | `kernel/types.h`、`kernel/bvh/bvh.h`（都是 Apache-2.0） |
| `src/gpu.rs` | MIT 与 Apache-2.0 | 积分器参数块 `KernelIntegrator` 的字段名（着色器里那一份在 CPU 上的镜像） | `kernel/data_template.h`（Apache-2.0） |
| `src/sample.rs` | MIT 与 Apache-2.0 | `PRNG_BOUNCE_NUM` 的名字与数值；像素种子的式子 `rng_pixel` | `kernel/types.h`、`kernel/sample/pattern.h`（都是 Apache-2.0） |
| `src/pixel_filter.rs` | Apache-2.0 | 像素滤波的三个滤波函数与建重要性采样表（`filter_func_box`、`filter_func_gaussian`、`filter_func_blackman_harris`、`filter_table`），与它用的累积分布求值、反函数（对称的一支），逐行移植 | `scene/film.cpp`、`util/math_cdf.h`、`util/math_cdf.cpp`（都是 Apache-2.0） |
| `src/scene.rs` | MIT 与 Apache-2.0 | 物体扩展表 `GpuObjectExt` 的四个字段名与物体标志的位（着色器里那一份在 CPU 上的镜像） | `kernel/types.h`（Apache-2.0） |

许可全文在仓库根的 `LICENSES/`（`MIT.txt`、`Apache-2.0.txt`、`BSD-3-Clause.txt`）。其余文件（`shaders/` 下的 `film`、`light`、`volume`、`records`、`trace_hw` 与 `src/` 下表里没列的那些）没有照 Cycles 定义什么，是 MIT。这张表按「在哪个文件里定义」算：结构的字段、常数、式子写在哪个文件，哪个文件就标；别的文件只是用到这些名字的（比如 `src/merged.rs` 与 `src/gpu.rs` 的库测试里按名字核对两侧的字段表与编号、`src/lib.rs` 填积分器参数），不另标。

## 切掉了什么，为什么能切

上游是一个游戏引擎：同一套内核既给实时预览用，也给离线出图用。核心帧源只要离线出图，所以按下面七类逐类删掉，每删一类都重新编译、重跑库测试，并核对第 2 级的 24 个渲染读数与删之前逐个相等。

| 类 | 删掉的东西 | 为什么能切 |
|---|---|---|
| 游戏运行时外围 | 联网、音频、窗口查看器、宿主通道、用户文件存取、图像对比子命令，以及它们的依赖 | 离线出图不联网、不出声、不开窗口；这些模块不在出图的调用链上 |
| 实时预览 | 实时渲染的整个模块与它的着色器、浏览器里的实时视图、游戏会话、构建期生成表格的脚本 | 实时是另一条管线；离线出图走累积采样，不经过它 |
| 物理与体素 | 物理、体素、两者的内核箱、只为物理打过补丁的第三方箱、几个示例 | 离线出图拿到的是已经摆好的场景，不在渲染进程里解算物理 |
| 单元实例 | 软件遍历下的单元实例布局与它的着色器 | 离线本来就把实例拍平成世界空间三角形，单元布局只有显式打开开关才用 |
| 粒子与网格模拟 | 粒子、带状态的粒子、网格模拟、发光体回填、半透明粒子的着色器与 Rust 一侧 | 这些只随逐帧模拟出现；场景里出现粒子物体或带程序的密度网格时改为明确报错，不会悄悄渲成没有粒子的画面。静态密度网格保留 |
| 内核里只有实时才走的段 | 内核着色器里实时的入口与分支、辐射缓存、均匀介质等，以及 Rust 一侧对应的管线常量 | 「是否实时」从管线可覆盖常量改成普通常量 `false`，其余是因此不再被引用的函数与常量 |
| 收尾 | 清单与库文档里两处已经不存在的引用 | 只改注释 |

删完后依赖的箱从 444 个减到 237 个：只有删除，没有新增，留下的箱版本与校验和都没变。

上游仓库里渲染器以外的东西（JavaScript 的场景运行时与工具、游戏、站点、文档、测试脚本）一概没有带进来。

## 文件对照

「相对上游」一栏说的是文件正文，不算第一行的来源注释。

| 本目录 | 上游路径 | 相对上游 |
|---|---|---|
| `src/api.rs` | `renderer/src/api.rs` | 删去切掉的几类 |
| `src/bvh.rs` | `renderer/src/bvh.rs` | 没改 |
| `src/denoise.rs` | `renderer/src/denoise.rs` | 没改 |
| `src/desc.rs` | `renderer/src/desc.rs` | 删去切掉的几类 |
| `src/files.rs` | `renderer/src/files.rs` | 删去切掉的几类；预设的内嵌路径改指本目录的 `presets/` |
| `src/gpu.rs` | `renderer/src/gpu.rs` | 删去切掉的几类；接进北冥的五个着色器（见下一节）；全局参数追加四块（第四块是像素滤波表，见下一节「像素滤波与夹取」）、成像的两个编译开关、材质表与物体扩展表的上传、输出缓冲的分配与读回（见下一节末）；加了守着内核结构的测试（见下一节「四样内部结构的冻结」） |
| `src/heap.rs` | `renderer/src/heap.rs` | 删去切掉的几类；多一张物体扩展表（见下一节末） |
| `src/lib.rs` | `renderer/src/lib.rs` | 删去切掉的几类；文档里的程序名；填全局参数追加的四块 |
| `src/ltree.rs` | `renderer/src/ltree.rs` | 删去切掉的几类 |
| `src/main.rs` | `renderer/src/main.rs` | 删去切掉的几类；库名与程序名；`render-pack` 的像素滤波、夹取、滤光泽参数与关掉上游的亮度夹取（见下一节「像素滤波与夹取」）；比对外壳用的 `fncheck-host` 子命令 |
| `src/merged.rs` | `renderer/src/merged.rs` | 删去切掉的几类；加了锁住两侧格式与编号的测试（见下一节末与「四样内部结构的冻结」） |
| `src/pipeline_cache.rs` | `renderer/src/pipeline_cache.rs` | 没改 |
| `src/post.rs` | `renderer/src/post.rs` | 没改 |
| `src/procasset.rs` | `renderer/src/procasset.rs` | 没改 |
| `src/sample.rs` | `renderer/src/sample.rs` | 索引掩码换成具名常数，数值没变 |
| `src/scene.rs` | `renderer/src/scene.rs` | 删去切掉的几类；一个测试读夹具的根目录改成本目录；材质记录加长（见下一节末） |
| `src/script.rs` | `renderer/src/script.rs` | 删去切掉的几类 |
| `src/skin.rs` | `renderer/src/skin.rs` | 没改 |
| `src/sky.rs` | `renderer/src/sky.rs` | 没改 |
| `src/texpack.rs` | `renderer/src/texpack.rs` | 删去切掉的几类 |
| `src/world.rs` | `renderer/src/world.rs` | 删去切掉的几类 |
| `shaders/pathtrace.wgsl`、`intersect.wgsl`、`shader.wgsl`、`closure.wgsl`、`light.wgsl`、`volume.wgsl`、`integrator.wgsl`、`film.wgsl` | `renderer/shaders/pathtrace.wgsl` | 删去只有实时才走的段；加了北冥的接线（见下一节）；按阶段分成八个文件（见下一节末） |
| `shaders/sample.wgsl` | `renderer/shaders/sample.wgsl` | 少两个只给辐射缓存用的采样维度常量；随机数的状态换成读路径状态；种子的第一次哈希挪到 CPU 上；加了照 Cycles 的取数接口与维度枚举；编号办法、像素种子的算法换成 Cycles 的，上游的 `rng_dim` 换成 `rng_legacy`，索引掩码改读全局参数（见下一节「随机维度」） |
| `shaders/trace_hw.wgsl` | `renderer/shaders/trace_hw.wgsl` | 没改 |
| `shaders/records.wgsl` | `renderer/shaders/records.wgsl` | 去掉每个像素的输出结构 `Pixel`（换成了 `film.wgsl` 的输出缓冲，见下一节末） |
| `presets/cinematic.json`、`presets/preview.json` | `presets/` 下同名文件 | 没改 |
| `tests/render/data/panel-decal.glb` | `tests/render/data/panel-decal.glb` | 没改。库测试里一个实例拍平的用例要读它，3232 字节，是上游仓库 `tests/render/data/` 下的测试素材 |
| `Cargo.toml` | `renderer/Cargo.toml` | 包名、程序名、说明；去掉切掉的几类的依赖与特性 |
| `Cargo.lock` | `renderer/Cargo.lock` | 本包改名并按字母序挪到该在的位置；去掉不再需要的箱 |
| `rust-toolchain.toml` | `rust-toolchain.toml` | Rust 版本不变（1.100.0）；去掉只给浏览器构建用的 wasm32 目标，注释重写 |
| `LICENSE-upstream.txt` | `LICENSE` | 原样 |

`PROVENANCE.md`、`README.md`、`STRUCTURES.md`、`FREEZE.json`、`.gitignore` 是北冥新写的。`src/pack.rs`（场景包读入器）也是北冥新写的（MIT，文件头写明）：三种灯的换算是辐射度量学的式子，只对过 Cycles 的口径、没有搬代码，出处写在它的注释里。`shaders/hash.wgsl` 与 `src/cycles_hash.rs` 也不是上游的文件：照 Cycles 移植的哈希函数，见下一节「随机维度」。

## 北冥加了什么

把照 Cycles 逐行移植的 GGX 金属闭包与矩形面光接进内核。闭包与面光本身在 [../shaders/](../shaders/)（`microfacet.wgsl`、`util.wgsl`、`area_light.wgsl`、`ggx_tables.wgsl`，源自 Blender Cycles，许可与版权写在各自的文件头），仓库里只有那一份；内核用 `include_str!` 直接读它们，本目录不放副本。

- `src/gpu.rs`：内核的文件列表里加上面四个着色器，别的没动。
- `shaders/closure.wgsl`、`shaders/light.wgsl`、`shaders/integrator.wgsl`（分文件之前都在 `shaders/pathtrace.wgsl` 里），以「北冥」开头的注释标出，一百行上下：
  - 金属（metallic 为 1）的基础高光层改走移植的闭包：`bm_closure`、`bm_eval`，以及求值、概率密度、采样三处的分支。菲涅耳用 F82-tint，底色当 F0，边缘色取白；alpha 取粗糙度的平方；能量补偿由场景选项 `energyCompensation` 开关。
  - 不画卡片的矩形纯光改走移植的球面矩形采样，并与材质采样做多重重要性采样：`bm_rect`、`bm_rect_le`、`bm_rect_sample`、`bm_rect_hits`，以及光源一侧与主循环里的几处调用。

已知的一处简化：矩形纯光的高光倍率不是默认的 1 时，光源一侧的高光乘了倍率、材质一侧没乘，两侧权重配不上。要支持非 1 的倍率时，把材质一侧的贡献按高光与漫反射拆开再乘。

上游的 `pathtrace.wgsl` 是一个三千多行的文件。这里把它按阶段分成了八个文件，只搬位置：`pathtrace.wgsl` 留下开头（编译开关、常数、全局参数、各张表的绑定与读法）和各阶段共用的小函数，其余按求交、材质求值、闭包、灯光、体积、积分主循环、输出各一个文件，哪个函数去了哪里写在 `pathtrace.wgsl` 的开头。上游的注释原样跟着代码走。入口函数 `main` 末尾写累加缓冲的一段，因为一个函数不能跨文件，抽成了函数（`film.wgsl` 的 `accum_write_sample`，后来成了 `film_write_sample`，见本节末），语句没动。开头生成相机光线的一段留在 `main` 里：试过同样抽成函数，苹果显卡上相机三个轴都不贴坐标轴的场景，像素值的末位会变（相对差 2e-6，运算次序不同），所以没有单独的相机文件。`src/gpu.rs` 的文件列表与 `src/bvh.rs` 里一条读着色器源码的测试跟着改了文件名。Rust 源码的英文注释里仍写着「pathtrace.wgsl 的某某函数」，没有逐条改，按 `pathtrace.wgsl` 开头的对照表去找。从上游挑改动进来时，上游对 `pathtrace.wgsl` 的改动要按这张表落到对应的文件。

### 着色点与闭包

在上游的材质求值与积分主循环之间加了一层结构与函数，给以后照 Cycles 移植闭包、灯与图案节点留位置。渲染结果不变（逐位）。

- `shaders/shader.wgsl` 开头：着色点 `ShadingPoint`、闭包 `Closure`、材质输入值 `ShaderInputs`，与材质求值的三步 `shader_setup_from_hit`（几何量）、`shader_eval_inputs`（材质输入值，里面调上游的 `surface`）、`shader_setup_closures`（闭包）；另有只算透明度的一档 `shader_eval_shadow` 与灯采样点上的发光 `shader_eval_emission`，先转给上游。上游的 `surface`、`surface_proc` 只改了返回值：多带一份材质输入值。
- `shaders/closure.wgsl` 开头：积分器碰材质的一组函数（`surface_shader_prepare_closures`、`surface_shader_bsdf_eval`、`surface_shader_bsdf_bssrdf_pick`、`surface_shader_bsdf_sample_closure`、`surface_shader_emission`、`surface_shader_transparency`、`bsdf_albedo`），与把它们转给上游求值、采样的两个函数。
- 这一层刚加进来时所有材质（金属也在内）都是「上游顶替」这一种闭包：着色点的 `legacy` 里带着上游的 `Surface` 与 `Lobes`，求值与采样仍是上游的 `eval_bsdf_k`、`pdf_bsdf`、`sample_bsdf`，上一节的金属接线原样在里面。纯金属后来改走独立的闭包，见下一节。
- 上游的七个灯光函数（`direct_light`、`local_lights`、`sample_emitter_ris`、`env_light`、`sun_light`、`light_mis`、`pdf_spec`）与 `light_origin` 的参数从 `(Surface, Lobes, 视线)` 换成着色点，函数体里对应的几处读法跟着换，算法没动。
- `shaders/integrator.wgsl` 的主循环改经上面的函数碰材质。
- 还在直接读上游 `Surface`、`Lobes` 的地方列在 `shaders/closure.wgsl`「上游顶替」一节的例外清单里。

这一层有四处写法是为了逐位不变试出来的，各处的注释里写了原因：`shader_setup_from_hit` 往指针里填而不按值返回着色点；上游的 `Lobes` 在 `surface_shader_prepare_closures` 里算而不在填闭包时算；上游顶替的求值函数不一并算概率密度；上游顶替的采样在自己的函数里照上游原样的式子把权重算好（`BsdfSample.weight`），不交给主循环去除。前三处是苹果显卡上试出来的，第四处是英伟达显卡的软件求交上试出来的。两家的着色器编译器都会按上下文合并或重排浮点运算，同样的式子换一种组织法就可能换一种运算次序，像素末位随之变化（实测相对差 1e-7 到 2e-4）。

### 纯金属走独立的微表面闭包

金属度为 1、没有清漆、没有透射的材质不再经上游顶替，改成一个独立的闭包：种类 `CLOSURE_BSDF_MICROFACET_GGX`，菲涅耳 `FRESNEL_F82_TINT`。带清漆或透射的金属还在上游顶替里，上面的金属接线（`Lobes.bm`）为它们留着。

- `shaders/shader.wgsl`：`shader_setup_closures` 按材质输入值建立这个闭包（底色当 F0，边缘色读 `ShaderInputs.specular_tint`，现在恒为白；alpha 取粗糙度的平方；能量补偿的开关当时还读全局的 `energyCompensation`，后来改读材质记录的那一位，见「材质记录、全局参数、物体扩展表、输出缓冲」）。F82 的 B 项、能量补偿的倍率与权重在这里算一次、存进闭包，不再在每次求值、采样时重算。`ShaderInputs` 多了 `coat_weight`、`transmission_weight` 两项。粗糙度沿用上游的 0.02 下限。
- `shaders/closure.wgsl`：新增按闭包种类分发的 `bsdf_eval`（取出闭包的字段，调 `../shaders/microfacet.wgsl` 里移植的求值函数）；`surface_shader_bsdf_sample_closure` 对这个闭包调移植的采样函数，方向的两个随机数当时仍取上游材质采样那一组的后两维（后来改成照 Cycles 编号的 `PRNG_SURFACE_BSDF`，见「随机维度」），采到方向后再求值一遍取值与概率密度（与原来的接线一样）；上游的灯光函数用的 `surface_shader_bsdf_eval_legacy` 对它直接取闭包的求值，上游每盏灯的高光倍率只对上游顶替有效。
- 上游的 `light_mis` 没有改：纯金属的 `Lobes.bm` 仍为真，它经上游的 `pdf_bsdf` 拿到的就是同一个移植函数算的密度。所以纯金属的着色点上仍要算上游的 `Lobes`。

这一步的渲染结果允许末位变化（原来的接线求值时多一次「除以余弦再乘回」，建立闭包的几项也是每次现算）。实测：第 2 级 24 个读数与改之前的相对差不超过 2e-8；每个读数用 8 个种子取均值，改前改后的差不到合成标准误的百分之一；上游自带的渲染测试里不含纯金属的 121 个场景原始输出逐字节相同，含纯金属的 5 个（`cache/mirror-metal`、`cache/mirror-sun`、`furnace/metal-energy-compensated`、`material/metal-f0`、`surface/windows-mirror`）像素相对差的中位数在 1e-7 上下，每张图有零到三个孤立像素超过 1e-5（两台机器、两种求交合起来最大的一个是 7e-3；默认种子下全图均值的相对差不超过 1e-6）。它们是对末位变化敏感的病态像素：换一个种子它们换地方、个数相仿，同一个种子下两台机器超标的是同一批；关掉俄罗斯轮盘这几个像素照旧；只把求值结果的大小改一个末位，一个像素都不超。是哪一个离散判断翻了面没有逐个追，这里不下结论。两台机器的基线在这一步之后重记过。

写法上又踩到三处，都写在各自的注释里：`bsdf_eval` 收一个闭包而不收整个着色点（收整个着色点时苹果显卡上过程几何的阴影场景会随机丢样本）；上游的 `Lobes` 对所有闭包都算（只给上游顶替算时苹果显卡上别的材质像素末位会变）；`light_mis` 不按闭包种类分支（试过三种写法，不是苹果显卡就是英伟达显卡上别的材质像素末位会变）。

### 原理化 BSDF 的非金属那一半

在纯金属的闭包之外，把 Cycles 原理化 BSDF（`kernel/svm/closure.h` 的 `svm_node_closure_bsdf`）里「无清漆、无光泽、无次表面、无透射、无薄膜、各向同性、漫反射粗糙度 0」那一条路整条移进来：一个着色点至多三个闭包（金属、电介质高光、漫反射），层与层之间的权重、多个闭包之间的选择与求和、自发光、滤光泽都照 Cycles。冻结标记升到 1.2.0。

- `../shaders/microfacet.wgsl`（BSD-3-Clause）加：电介质的菲涅耳（`fresnel_dielectric_polarized`、`fresnel_dielectric_ccl`，后者对应 Cycles 的 `fresnel_dielectric`，内核里上游另有一个同名函数，所以带后缀）、`fresnel_dielectric_Fss`、`F0_from_ior`、`ior_from_F0`、`closure_layering_weight`（`kernel/closure/bsdf_util.h`）；广义 Schlick 的菲涅耳、反照率估计、建立、求值与采样（`generalized_schlick_fresnel`、`microfacet_fresnel` 的那一支、`bsdf_microfacet_estimate_albedo` 的广义 Schlick 与 F82 两支、`bsdf_microfacet_setup_fresnel_generalized_schlick`、`bsdf_microfacet_eval`、`bsdf_microfacet_sample` 的反射那一条路、`bsdf_microfacet_blur`，`kernel/closure/bsdf_microfacet.h`）；`sample_cos_hemisphere`（`kernel/sample/mapping.h`）；`bsdf_diffuse_eval`、`bsdf_diffuse_sample`（`kernel/closure/bsdf_diffuse.h`）；`emissive_pdf`、`emissive_simple_eval`（`kernel/closure/emissive.h`）。
- `../shaders/util.wgsl`（Apache-2.0）加：`lookup_table_read_3D`（`kernel/util/lookup_table.h`）、`inverse_lerp`、`reduce_max`、`safe_divide_color`（`util/`），按高光等级调折射率的那一段（`principled_specular_f0_eta`，`kernel/svm/closure.h`）与滤光泽的模糊粗糙度（`filter_glossy_roughness`，`kernel/integrator/surface_shader.h`；全局参数的 `filter_glossy` 照 Cycles 宿主一侧存 1 / blur_glossy，0 关，内核直接把它传进来）；采样标签 `LABEL_DIFFUSE` 从 `shaders/closure.wgsl` 挪到这里。
- `../shaders/ggx_gen_schlick.tables`（新文件，Apache-2.0，数据）：`scene/shader.tables` 的 `table_ggx_gen_schlick_ior_s`、`table_ggx_gen_schlick_s` 两张表（各 4096 个数，原样照抄，与源文件逐个相同）。内核把它们放进表缓冲（`src/heap.rs` 的 `Table::GgxGenSchlickIorS`、`GgxGenSchlickS`，首地址在 `table_first_ext[0].z`、`[0].w`，`src/lib.rs` 的 `ggx_gen_schlick_tables` 读这份文件），`../shaders/util.wgsl` 的 `lookup_table_read_3D` 经 `lookup_table_read_2D_buf`、`lookup_table_read_buf`（`kernel/util/lookup_table.h` 的 `lookup_table_read_2D`、`lookup_table_read` 读 `lookup_table` 的那一份）按偏移读，取数的 `lookup_table_fetch` 在 `shaders/pathtrace.wgsl`。起先照能量补偿表的做法接在 `ggx_tables.wgsl` 的常数数组后面，英伟达显卡上内核编译不出来（naga 按运行时下标取常数数组会把整个数组拷进临时变量），改成照 Cycles 放进内核数据按偏移读；`ggx_tables.wgsl` 回到原来的 1056 个数，一个字没改。函数级比对外壳把同一份数据绑成第 2 个存储缓冲（`../fncheck/gpu.mjs`）。
- `shaders/shader.wgsl`：`shader_setup_closures` 按上面那条路建闭包；不在这条路上的材质（带清漆、透射、漫反射粗糙度、不透明度小于 1 的）整个走上游顶替。移植的闭包不再带上游的 0.02 粗糙度下限。`shader_eval_emission` 照 Cycles 的口径取发光值。three.js 的无光照材质高光等级置 0。
- `shaders/closure.wgsl`：按种类分发的求值与采样（金属、电介质高光、漫反射），多个闭包的选择、求和与合起来的概率密度，采样之后的通量权重改用采样函数自己的求值与密度再并进其余闭包（原来是采到方向后再求值一遍），`bsdf_albedo` 照 Cycles 的口径，滤光泽，发光两面，降噪反照率。上游的灯光函数用的 `surface_shader_bsdf_eval_legacy` 与 `light_mis` 对移植的闭包改调 `surface_shader_bsdf_eval`（条文里点名的例外）。
- `shaders/light.wgsl`：`sample_emitter`、`sample_emitter_ris` 取发光值改经 `shader_eval_emission`（值不变：两个函数先按上游的规矩丢掉背对的单面卡片）。
- `shaders/integrator.wgsl`：主循环里「穿过光滑玻璃」只认奇异的透射一瓣（`LABEL_TRANSMIT | LABEL_SINGULAR`），移植的闭包的奇异反射走普通的一支；相机命中处的降噪反照率读 `surface_shader_denoising_albedo`。相机光线与累加那几段没动。
- `src/scene.rs`：`build_material` 按场景描述的 `specularIntensity` 填材质记录的高光等级（它的一半）。

这一步有意改变渲染结果：非金属材质从上游顶替换成移植的闭包，读数会变，回归基线要重记。纯金属的第 2 级读数仍在门内（采样的权重改成 Cycles 的做法，末位会变）。

### 像素滤波与夹取

照 Cycles（同一提交）把像素滤波与贡献的夹取接进内核，只在 `render-pack` 一路由命令行打开（参数见 [README.md](README.md)「读场景包」）。不加这些参数时内核与加它们之前逐字相同，渲染结果逐位不变。

- `src/pixel_filter.rs`（新文件，Apache-2.0）：宿主一侧建像素滤波的重要性采样表，照 `scene/film.cpp` 的 `filter_func_box`、`filter_func_gaussian`、`filter_func_blackman_harris`、`filter_table`（建表前高斯的宽度乘 3、Blackman-Harris 乘 2）与 `util/math_cdf.h`、`math_cdf.cpp` 的累积分布求值与反函数（对称的一支）逐行移植，全用 f32、次序照原式。`fncheck-host` 子命令把这几个函数交给函数级比对外壳逐项比 Cycles 自己建的表。
- `../shaders/imaging.wgsl`（新文件，Apache-2.0）：查表 `filter_table_read`（`kernel/util/lookup_table.h` 的 `lookup_table_read`，用法照 `kernel/camera/camera.h:460-465`）；夹取 `film_clamp_light`（`kernel/film/light_passes.h:126-148`，开了 `__CLAMP_SAMPLE__` 的那一支）与它用的 `isfinite_safe`、`ensure_finite3`（`util/math_base.h`、`util/math_float3.h`）。表放在哪里归调用方：本文件只调 `filter_table_value(i)`。
- `shaders/pathtrace.wgsl`、`src/gpu.rs`：全局参数末尾追加第四块 `filter_table`（`KernelFilterTable`，257 个 vec4：一个「查不查表」的标志、三格预留、1024 个数）；两个编译开关 `pixel_filter`、`sample_clamp`（`KernelVariant` 的两个字段，`FilmSwitches::of` 按全局参数决定，管线与着色器按它分开缓存）。起先写成运行时分支，不开的场景回归有 174 处不同（白炉读数差 1e-11 量级），所以放到编译开关后面。
- `shaders/film.wgsl`：`filter_table_value` 读全局参数的表；`film_clamp_contribution` 把两个上限里是 0 的换成浮点最大值再调 `film_clamp_light`。`shaders/integrator.wgsl` 的主循环在 `sample_clamp` 的变体里，十一处 `film_add_light` 之前各夹一次，弹射数照 Cycles 各调用处的口径（直接光用顶点号；发光、背景、雾、介质发光用顶点号减 1）。相机光线在 `pixel_filter` 的变体里拿像素滤波的两个随机数查表得到像素内的偏移，每个样本的权重是 1。
- `src/main.rs`：`render-pack` 的 `--pixel-filter`、`--filter-width`、`--clamp-direct`、`--clamp-indirect`、`--filter-glossy`（`CyclesFilm`）。两个夹取上限写进全局参数时乘 3、滤光泽写 1 / 用户值，照 `scene/integrator.cpp:269`、`:311-315`；用户给 0 时写 0（关），Cycles 在那里写浮点最大值。`render-pack` 一路把上游的亮度夹取 `misc.x`（原来是 `NativePreset::firefly_clamp` 算的 2^EV × 预设的 `clampIndirect`，场景包的曝光恒为 EV 0，所以电影预设是 64、预览 16）写成浮点最大值：物理参考是不夹的。
- 函数级比对外壳（`../fncheck/`）加成像一组：三个滤波函数、三种建表、三种查表与夹取，标准答案程序直接调 Cycles 的真函数（`scene/film.cpp` 里的 static 函数由 `cycles/build.mjs` 从源码缓存原样截出，不进仓库）。第 2 级在 `../chassis/imaging.mjs`：刀口剖面对 Cycles 表给出的分布，夹取经粗糙度 0 的金属（奇异闭包）看天空。

### 路径状态与光线

上游的路径状态散在各处：十几个模块级的私有量（当前顶点号、镜面路径标志、几样直接光的中间量、随机数的种子与样本号等），加主循环里的一组局部量（通量、上一次采样的概率密度、几个玻璃标志、射线锥）。这一步把它们收成两个结构，渲染结果不变（逐位）。

- `shaders/integrator.wgsl` 开头：路径状态 `PathState`，一个模块级的私有变量 `state`，所有函数直接读写。字段名照 Cycles 的 `IntegratorState.path`（像素下标、样本号、弹射数、四个分类计数、`rng_pixel`、`rng_offset`、`flag`、`mis_ray_pdf`、`min_ray_pdf`、`continuation_probability`、`throughput`、`visibility`、`mis_ray_object`）；照 Cycles 没有对应的上游状态圈在 `state.legacy`（`PathLegacy`）里。路径标志位与可见类的位照 Cycles 的 `PathRayFlag`、`PathRayVisibilityFlag`，现在只接了「下一次打到灯不做多重重要性采样」那一位（上游的 `specular_bounce`）。
- 并进去的上游私有量：`cur_depth`（成了 `state.bounce`）、`RNG_INDEX`、`RNG_SEED`（成了 `state.sample`、`state.rng_pixel`），以及进 `state.legacy` 的 `mirror_path`、`rays_off`、`split_frac`、`dl_spec`、`dl_det`、`dl_det_spec`、`sampled_spec`、`sampled_trans`、`mis_x`、`mis_n`、`shadow_hole`、`nee_alone`、`lights_only`、`RNG_PATH`。各文件里读写它们的地方只换了名字。没有并的：求交里过程几何的调用上下文（`gdata_first`、`gdata_count`、`media_voxels`）、灯光瓦片的每像素状态（`lt_list`、`lt_list_n`、`lt_fb`）、循环守卫的计数，它们不是路径状态。
- 主循环里的 `thr`、`last_pdf`、`specular_bounce`、`behind_glass`、`bent`、`straight` 与金属接线加的 `bm_surf` 换成 `state` 的字段。
- 新写入、暂时没人读的四项：`min_ray_pdf`、`mis_ray_object`（每次弹射处写）、`visibility`（初值与每次弹射后的更新，在新加的 `path_state_next` 里，只有骨架）、`rng_offset`。分类计数只定义。`src/gpu.rs` 的测试 `path_state_is_written` 锁住两个结构的字段名单，并查这四项的写入语句都在。
- 光线 `Ray`（起点、方向、`tmin`、`tmax`、`time`、`self_object`、`self_prim`、射线锥的两个量），主循环的 `o`、`d`、`cone_w`、`cone_a` 换成它的字段。相机光线的算式原样留在 `main` 里，算完填进 `Ray`。上游 `trace` 的签名没动。
- `shaders/intersect.wgsl`：「只查同一个物体、返回至多 4 个命中」的问法 `trace_local` 定了签名与返回的结构，函数体是空壳。

这一步踩到一处：`Ray` 里两个三维向量必须排在最后。两个向量排在前面、后面紧跟标量时，苹果显卡上两个带水的场景像素会变（相对差到 3e-4）；排到最后就逐位不变了。推测是后端把后面紧跟标量的三维向量按紧凑格式存，运算次序跟着变。

### 材质记录、全局参数、物体扩展表、输出缓冲

内核里进缓冲的几样格式在这里定形，给以后照 Cycles 移植闭包、灯、图案节点与接输出通道的人留好位置。渲染结果不变（逐位）。

**材质记录**（`shaders/pathtrace.wgsl` 的 `Material`，Rust 一侧 `src/scene.rs` 的 `GpuMaterial`）从 18 个 vec4 加长到 26 个，总长度从此冻结，以后只能往预留格里填。

- 第 18 格：边缘色 `specular_tint`（金属是 F82 的边缘色，非金属是乘在 F0 上的颜色）与高光等级 `specular_ior_level`。高光等级单独存，不与上游的 `params.z` 合用（两者只在折射率 1.5 时等价）；`params.z` 只给上游顶替读。
- 第 19 格是四个标量：漫反射粗糙度 `diffuse_roughness`、`flags`、图案节点表里的起点 `pattern_first` 与个数 `pattern_count`。`flags` 第 0 位是多重散射的能量补偿，第 1 位是「不走上游材质函数」，第 8 到 11 位是闭包大类（表面、自发光、透明、卡通）；位的常数两侧同名（`MATERIAL_FLAG_*`、`MATERIAL_CLASS_*`）。
- 第 20 到 25 格预留，全 0。
- `GpuMaterial` 的默认值改成手写：边缘色白、高光等级 0.5，其余 0；每个构造处都以它收尾。能量补偿那一位不在各构造处填，上传前由 `scene::with_energy_compensation` 一处按全局开关 `energyCompensation` 写；纯金属的闭包改读这一位（`ShaderInputs.flags`），上游顶替仍读全局的 `P.misc.z`。
- 纯金属的边缘色改从材质记录来（默认白，结果不变）。新加一个场景特性位 `F_SPECULAR_TINT`：场景里有材质的边缘色不是白时，材质求值才从记录读它，别的场景里内核编译期取白。原因是量出来的：一律从记录读时，F82 的 B 项不再是编译期的 0，没有金属的计时场景稳态也慢 4%（苹果显卡）。在苹果显卡上强开这一位（`THREERT_FEATURES_ON`）跑过全部回归，结果同样逐位不变。
- 库测试 `the_material_record_is_the_kernels`（`src/merged.rs`）逐字段比两侧的名字、偏移与总长度（合并布局里按 vec4 拼的那一份也比），逐个比 `flags` 各位的数值，并锁住默认值与能量补偿位的写法。

**全局参数**（`shaders/pathtrace.wgsl` 的 `Params`，Rust 一侧 `src/gpu.rs` 的 `Params`）在末尾追加三块。已有的块长度冻结；以后要加东西，在末尾再追加自己命名的一整块。

- `integrator`（`KernelIntegrator`，4 个 vec4）：字段名照 Cycles 的 `KernelIntegrator`，四类弹射上限、透明弹射的上下限、`min_bounce`、`sampling_pattern`、两个夹取、`filter_glossy`、`light_inv_rr_threshold`、`seed`、`sobol_index_mask`，外加 `pass_kind`（0 颜色样本、1 辅助样本）与 `background_transparent`。只定义、内核还没读的字段是 0。
- `seed` 里放的是用户种子过一次哈希之后的值：原来着色器里对种子现算的那一次哈希挪到了 CPU 上（`KernelIntegrator::new`），像素种子与原来逐位相同。`sobol_index_mask` 是上游写死的 `0xffff0000`，为 0 时开渲前报错。
- 这两个数起初是「已写未读」（内核还从上游的位置 `size.w` 读种子、掩码用着色器里的具名常数），因为单改读的位置在苹果显卡上会让别处的像素末位变化。换随机数编号办法的那一步（见「随机维度」，它本来就允许结果变化）把内核改成了读这两个字段；`size.w` 停写，标预留，恒 0。
- `film`（`KernelFilm`，1 个 vec4）：输出缓冲每个像素的步长 `film_stride`、灯组的起点 `film_lightgroup_first`、这次渲染请求的灯组数 `num_lightgroups`。
- `table_first_ext`（2 个 vec4、8 格）：北冥加的表的首地址（上游的 `table_first` 12 格已经占满）。登记了四个去向：物体扩展表、图案节点表、广义 Schlick 的两张能量表；后四格空闲。
- 库测试 `the_parameters_are_the_kernels`（`src/merged.rs`）逐字段比 `Params`、`KernelIntegrator`、`KernelFilm` 两侧的名字、偏移与总长度。

**物体扩展表**（`shaders/pathtrace.wgsl` 的 `ObjectExt` 与 `object_ext_at`，Rust 一侧 `scene::GpuObjectExt`，`heap::Table::ObjectExt`）：每个物体 2 个 vec4，与上游的物体表同下标、定长，首地址在 `table_first_ext` 的第一格。第 0 个 vec4 是实体编号 `entity_id`（存成浮点数值，小于 2^24）、物体标志 `object_flag`（位照 Cycles，第 3 位镜像）、接收者集合号 `receiver_light_set`、所属灯组 `lightgroup`；第 1 个是两个阴影终止偏移与两格预留。场景包读入器写实体编号与镜像位，辅助样本与覆盖率读实体编号；别的格子全是 0；各家以后只填自己的格子。

**输出缓冲 film**（`shaders/film.wgsl`，Rust 一侧 `src/gpu.rs` 的 `FILM_*`、`film_bytes`、`Gpu::film_buffer` 与读回）换掉了上游每个像素一个写死的结构（`records.wgsl` 的 `Pixel`，5 个 vec4）。

- 一块 vec4 的数组，每个像素占 `P.film.film_stride` 个。固定部分 10 个：0 颜色与样本数，1 降噪用的反照率（w 留给不透明度），2 降噪用的法线（w 留给覆盖率计数），3 上游降噪用的两个方差量（亮度的和、亮度平方的和；原来挤在反照率与法线的 w 里），4、5 上游 `--signals` 的两组，6、7 辅助样本的两格（深度、实体编号、运动矢量；法线），8、9 预留。灯组排在固定部分之后，从 `P.film.film_lightgroup_first` 起。步长与灯组的起点两侧都从全局参数读，不写死。
- film 只经三个函数读写：`film_add_light(L, bounce, 灯组槽位)` 每一次贡献调一次，把值加进这个样本的颜色（模块级私有变量 `film_sample` 的 `L`），槽位不是「无」时同一个值直接加进那个灯组；`film_write_aux(AuxSample)` 写辅助样本的两格（入口 `aux_sample` 调它）；`film_write_sample(SampleResult)` 在样本结束时写其余通道，语句是上游 `main` 末尾那一段，次序没动。主循环里原来的 11 处 `radiance += …` 改成调 `film_add_light`，槽位全填「无」，累加的次序不变。
- 灯组数是这次渲染请求的灯组数（`KernelFilm::new(组数)`），不是场景里的。开渲前按 `步长 × 16 × 宽 × 高` 算缓冲大小，超过显卡单个缓冲绑定的上限就报错，并写明这个分辨率下这次最多能要几组。`Frame` 多了 `lightgroups`（每组一层）。请求灯组的路是通的：库测试 `requested_lightgroups_leave_the_picture_alone` 把同一个场景不请求、请求 2 组各渲一遍，颜色、反照率、法线、方差逐位相同，两个灯组全 0。
- 步长由 Rust 一侧向上取到 4 的倍数（64 字节）：不请求灯组时是 12，不是 10。这是量出来的：苹果显卡上步长 10、11 的稳态比步长 12、16 慢 5%（同样只写前四格），每个像素的记录对不齐 64 字节时写起来就慢。多出来的格子没人读写；代价是缓冲大两成，个别分辨率下能请求的灯组数少至多 3 个（4K 下不变，仍是 6 个）。
- `film_write_sample` 里四格先都读出来再写回去（读一格写一格地交替，苹果显卡上稳态慢约 1%）。
- 降噪、`--hdr`、图像输出、`--signals` 读的还是颜色、反照率、法线、两个方差量与那两组，结果不变（三个场景开、关降噪各渲一遍，图像、`--hdr` 与三份 `--signals` 输出逐字节相同）。
- 辅助样本与覆盖率（冻结标记 1.1.0）：内核的第二个入口 `aux_sample`（编译开关 `aux` 的变体里才有），过像素中心打一条针孔射线，只求交与取几何量，写深度、实体编号（读物体扩展表）、相机空间的着色法线，经 `film_write_aux` 覆盖写辅助两格。`Gpu::render` 要辅助层时用 `aux` 的变体，在清零之后、第一个颜色样本之前从这个入口调度一次（起先是 `main` 开头按 `P.integrator.pass_kind` 分支、覆盖率每次都数，英伟达显卡上不要辅助层时稳态慢 4% 到 5%，所以拆开）。路径状态加了 `first_hit_object`（相机射线首次命中的物体），`aux` 的变体里 `film_write_sample` 拿它的实体编号与辅助那一格比，相等就给 `FILM_DENOISE_NORMAL.w` 加 1；不透明度（`SampleResult.alpha`，背景对相机不可见而相机射线没打到时 0）累加在 `FILM_DENOISE_ALBEDO.w`。这三处都只写各通道的 w 与新的两格，颜色、反照率、法线、方差的写法没动：两台机器上回归基线逐位相同，库测试 `requested_lightgroups_leave_the_picture_alone` 另查要辅助层时颜色、反照率、法线逐位相同。
- 库测试 `the_film_layout_is_the_kernels`（`src/merged.rs`）逐个比两侧的位置常数，查 film 只在 `film.wgsl` 里下标、步长只在一处乘，并锁住缓冲大小的算法与报错。

### 随机维度

发生器没有换（打乱索引加 Owen 扰动的 Sobol，上游与 Cycles 的盐值逐个相同）。换的是「哪个决定用哪一维」的编号办法、每个像素的种子，以及哪几个决定照 Cycles 取数。分两步做。

第一步只引入接口，渲染结果不变（逐位）：`shaders/sample.wgsl` 新增 `path_rng_1D`、`path_rng_2D`、`path_rng_3D`（对应 Cycles 的 `path_state_rng_1D` 到 `3D`）、分支版 `path_branched_rng_2D` 与维度的枚举 `PRNG_*`；上游的 `rng_dim` 改名 `rng_legacy`，原样返回旧编号。

第二步真正换，渲染结果随之改变（每个像素拿到的是另一串随机数；期望不变，按多个种子的均值判）：

- **编号**。上游是「路径号、顶点号、槽位拼成一个数」。现在照 Cycles 是「偏移加枚举」：路径状态里的 `rng_offset` 初值 16，每弹射一次加 16（`PRNG_BOUNCE_NUM`；介质里散射一次也加），编号 = `rng_offset` 加 `PRNG_*`。相机的两个决定不加偏移，直接用 `PRNG_FILTER`（0）与 `PRNG_LENS_TIME`（1）。枚举的数值照 Cycles 的 `PathTraceDimension`；每次弹射的 16 个位置里，0 到 5 有名字，6、10、11 是 Cycles 给路径引导的（这里不做、也不另作他用），7、8、9、12 到 15 空闲，取用须登记。
- **照 Cycles 取数的决定**：相机的像素滤波（`PRNG_FILTER` 的 2 维）与镜头（`PRNG_LENS_TIME` 的 3 维里后两个；第一个是时刻，现在不用）、俄罗斯轮盘（`PRNG_TERMINATE`）、表面散射（`PRNG_SURFACE_BSDF` 的 3 维：前两个定方向，第三个选闭包并复用；现在只有纯金属的微表面闭包用它，上游顶替闭包仍从上游的随机数里取）。镜头的两个数仍按上游的办法映到圆盘上。Cycles 在样本号为 0 时把像素滤波固定在像素中心，这里不照搬。
- **三个名字空间按编号的最高两位分开**，按构造互不相撞：照 Cycles 编号的最高位是 0；`rng_legacy(槽位)`（`rng_offset` 加槽位过一次哈希）最高两位是 10；上游在一个决定里再分子流的 `rng_sub` 最高两位改成 11。上游还没有照 Cycles 移植的决定（方向光、本地灯、发光体、环境光、雾、介质，上游顶替闭包自己的选瓣与方向）全部走 `rng_legacy`，新写的代码不许用它；哪个决定移植完了，就把它的槽位删掉、改用 `PRNG_*`。上游对父编号异或 `0x40000000`、`0x80000000` 派生兄弟流的写法原样保留（只当 `rng_sub` 的输入）。介质跟踪用的白噪声（`rng_hash`）的编号都从 `rng_sub` 来，种子与样本号读路径状态。相机与俄罗斯轮盘原来的两个槽位（0 与 2）退役，不再给别的决定用。
- **像素种子**照 Cycles 的 `path_rng_pixel_init`：像素坐标的二维哈希 `hash_iqnt2d` 异或全局种子，不再是上游的三重哈希。`hash_iqnt2d` 照 Cycles 的 `util/hash.h` 移植，放在新文件 `shaders/hash.wgsl`（Apache-2.0，CPU 上的同一份在 `src/cycles_hash.rs`）。全局种子读 `P.integrator.seed`（用户种子在 CPU 上过一次哈希之后的值）。
- **索引掩码**仍是上游写死的 `0xffff0000`，改从 `P.integrator.sobol_index_mask` 读；着色器里那个同值的常数删了。分支版取数把样本号乘以分支数，所以它的有效样本数是 65536 除以分支数，超过后重复同一批点；换掩码算法的人一并处理。
- `src/sample.rs`（发生器在 CPU 上的镜像）跟着加了 `rng1`、`rng3`、`rng_pixel`、`rng_legacy`、`rng_sub`；测试 `the_shader_is_this` 在显卡上把 `rng_legacy`、`rng_sub`、像素种子、`path_rng_*` 与分支版都对了一遍。
- 新测试 `the_dimension_ids_are_distinct`（纯 CPU）：照各着色器里的用法枚举弹射 0 到 64 的编号（照 Cycles 的每次弹射 16 个位置加相机 2 个；16 个上游槽位；各槽位之下登记过的子流序号区段），断言照 Cycles 的编号都小于 2^31、三个名字空间的最高两位各是各的、全部编号互不相同。测试里的常数就是子流序号区段的登记表（方向光 8 盏、本地灯 64 盏、本地灯候选 8 个加灯光瓦片候选 16 个、发光体候选 16 个），加槽位、加子流都要同步改它。

**这条测试管不到的一块**：介质跟踪每一步的白噪声编号（`media_tr` 与 `media_track` 里按步数 `rng_sub` 出来的）。它们挂在每一条阴影射线的编号之下，照上面的区段枚举约有八十万个（6,240 条阴影射线，每条 4 个介质各 32 步），而 `rng_sub` 的编号只有 30 位，「全部互不相同」按生日界做不到。实际试过把区段缩到方向光 4 盏、本地灯 16 盏、介质 2 个、每条射线 4 步，连跟踪步一共 23,098 个编号，就已经有一处：第 3 次与第 55 次弹射的两条阴影射线各有两步互相撞号。所以测试对它们只查「同一条射线之内互不相同」（介质 4 个、每个 32 步），不同射线的跟踪步之间每一对相撞的概率是 2^-30，没有保证。这不是换编号带来的：上游的子流编号原来是 31 位，同样没有这个保证。

### 四样内部结构的冻结

上面几节定下来的四样东西（材质记录、光线负载、随机维度、输出通道）合成了一份条文 [STRUCTURES.md](STRUCTURES.md)：每个字段的名字、类型、含义、谁写谁读与状态，两类结构各自的规矩，编号登记表，与 Cycles、与上游不一样的地方，判据，还没接的东西各等谁来接，以及改动的规矩。上面几节讲的是「相对上游改了什么、为什么这样写」，条文讲的是「现在是什么样、以后怎么改」；两处对不上时以代码为准。

这一步不改内核的行为（两台机器上回归基线逐位相同），加的是标记与检查：

- 冻结标记 [FREEZE.json](FREEZE.json)：四样结构、版本、冻结日期、条文与登记表的位置、改动的规矩，并按文件钉住着色器里的结构定义（去掉注释与空白之后的摘要）、常数（类型与数值的原文）与函数签名。[../chassis/freeze.mjs](../chassis/freeze.mjs) 从源码重算了比：标记在且一致退出 0，否则 4；名字属于登记类的常数（闭包种类号、材质标志位、路径标志位、随机维度、输出缓冲的位置等）声明了而没进标记也算不一致：这一条扫的是内核 `shaders/` 下的全部着色器加共用目录里编进内核的四个着色器（其中 `../shaders/util.wgsl` 放着四个采样标签，也钉进了标记），不只是标记已经钉住的文件；声明不写类型、前面带属性、写在一行里的第二个，都认。有意改了结构之后用 `--update` 重写钉住的值，标记的差异随改动一起提交。
- `src/merged.rs` 的三条测试：`the_closure_kinds_keep_their_numbers`（闭包种类号的快照：已有的数值不许变，新种类要先登记）、`the_bounce_stride_is_the_kernels`（每次弹射占的随机维度个数两侧同值）、`call_structs_are_not_built_by_position`（只活在一次调用里的结构没有位置式构造，按内核源码全文查；名字与括号之间有空白也认）。
- `src/gpu.rs` 的 `shading_point_is_written`：着色点、闭包、材质输入值的字段名单，与它们和光线里「现在只写不读」各项的写入语句，做法同 `path_state_is_written`；两条都按出现次数查写入语句（同一句有两处的，少一处也红）。
- [../chassis/freeze.test.mjs](../chassis/freeze.test.mjs)：仓库里的标记与代码一致；检查认得出该认的改动；条文提到了标记钉住的每个名字；照 Cycles 取值的常数（路径标志位与可见类、随机维度的枚举与每次弹射的个数、菲涅耳种类、着色点与物体的标志、采样标签）与 Cycles 头文件里的同名枚举逐个相等。最后一项要本机有函数级比对用的 Cycles 源码缓存，没有就跳过。
- 两处着色器只改了注释：`shaders/shader.wgsl` 开头指向条文；`shaders/closure.wgsl` 的例外清单补上灯光一侧直接读材质记录的几个上游函数。

## 沿用上游名字的地方

- **环境变量**。内核读的开关仍叫上游的名字（`THREERT_` 开头），例如 `THREERT_SEED`（随机数种子）、`THREERT_HWRT`、`THREERT_MERGED`、`THREERT_LOOP_GUARD`、`THREERT_PIPELINE_CACHE`、`THREERT_INSTANCING` 等。这次不改：上游自带的 JavaScript 工具还在给它们赋值，改名要和场景入口一起换。
- **场景运行时的接口**。场景包里的全局对象 `__threert` 与运行时模块名 `threert-runtime.js` 是上游 JavaScript 运行时与内核之间的约定，照旧。
- 注释与报错文字里提到上游项目、上游文档（如 `docs/RUNTIME.md`）与上游工具（如 `tools/bundle-game.ts`）的地方照旧，那些文件不在本仓库里。

## 场景入口暂时还是上游的

内核吃的是上游格式的场景包：用上游的 JavaScript 场景库写场景，再用上游的打包工具打成单个脚本，由内核里内嵌的脚本引擎运行。这一段还没有换成北冥自己的入口。所以跑第 2 级测试时，[../chassis/build.mjs](../chassis/build.mjs) 仍按上面的固定提交把上游仓库取到被忽略的 `out/` 下，核对提交号，只用其中的场景打包工具、场景库、自带的测试脚本与素材根目录；**渲染程序不再从那份取来的源码编，而是从本目录编**。

## 以后不再跟上游同步

这是一次性的分叉，不是定期合并的镜像。以后要用上游的某个新改动时，逐个挑、逐个改写进来，并在本页登记：上游的提交号、改了本目录哪些文件、为什么要。
