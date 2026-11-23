# 来源说明 · 核心帧源的路径追踪内核

读者｜维护者与全部 agent　依据｜[核心帧源的源码边界](../../../../docs/decisions/2026-11-23-core-source-boundary.md)（D14）、[THIRD-PARTY.md](../../../../THIRD-PARTY.md)

本目录的 Rust 与 WGSL 源码从开源路径追踪器 ThreeRT 的一个固定提交分叉而来，只留离线渲染一路，之后由本仓库自己维护。

## 上游

| 项 | 值 |
|---|---|
| 项目 | ThreeRT，<https://github.com/meshy-dev/ThreeRT> |
| 固定提交 | `c946cc96bdb08979224e851a7fc67a066b1b456b` |
| 许可 | MIT，版权人 Meshy LLC（2026）。许可全文原样放在 [LICENSE-upstream.txt](LICENSE-upstream.txt) |
| 本目录的许可 | MIT。上游的部分版权归 Meshy LLC，北冥改写与新增的部分版权归北冥引擎；逐路径登记在仓库根的 `REUSE.toml` |

每个源自上游的 `.rs` 与 `.wgsl` 文件第一行都写了它对应上游的哪个路径。

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
| `src/gpu.rs` | `renderer/src/gpu.rs` | 删去切掉的几类；接进北冥的四个着色器（见下一节） |
| `src/heap.rs` | `renderer/src/heap.rs` | 删去切掉的几类 |
| `src/lib.rs` | `renderer/src/lib.rs` | 删去切掉的几类；文档里的程序名 |
| `src/ltree.rs` | `renderer/src/ltree.rs` | 删去切掉的几类 |
| `src/main.rs` | `renderer/src/main.rs` | 删去切掉的几类；库名与程序名 |
| `src/merged.rs` | `renderer/src/merged.rs` | 删去切掉的几类；加了锁住两侧格式的测试（见下一节末） |
| `src/pipeline_cache.rs` | `renderer/src/pipeline_cache.rs` | 没改 |
| `src/post.rs` | `renderer/src/post.rs` | 没改 |
| `src/procasset.rs` | `renderer/src/procasset.rs` | 没改 |
| `src/sample.rs` | `renderer/src/sample.rs` | 没改 |
| `src/scene.rs` | `renderer/src/scene.rs` | 删去切掉的几类；一个测试读夹具的根目录改成本目录；材质记录加长（见下一节末） |
| `src/script.rs` | `renderer/src/script.rs` | 删去切掉的几类 |
| `src/skin.rs` | `renderer/src/skin.rs` | 没改 |
| `src/sky.rs` | `renderer/src/sky.rs` | 没改 |
| `src/texpack.rs` | `renderer/src/texpack.rs` | 删去切掉的几类 |
| `src/world.rs` | `renderer/src/world.rs` | 删去切掉的几类 |
| `shaders/pathtrace.wgsl`、`intersect.wgsl`、`shader.wgsl`、`closure.wgsl`、`light.wgsl`、`volume.wgsl`、`integrator.wgsl`、`film.wgsl` | `renderer/shaders/pathtrace.wgsl` | 删去只有实时才走的段；加了北冥的接线（见下一节）；按阶段分成八个文件（见下一节末） |
| `shaders/sample.wgsl` | `renderer/shaders/sample.wgsl` | 少两个只给辐射缓存用的采样维度常量 |
| `shaders/trace_hw.wgsl` | `renderer/shaders/trace_hw.wgsl` | 没改 |
| `shaders/records.wgsl` | `renderer/shaders/records.wgsl` | 没改 |
| `presets/cinematic.json`、`presets/preview.json` | `presets/` 下同名文件 | 没改 |
| `tests/render/data/panel-decal.glb` | `tests/render/data/panel-decal.glb` | 没改。库测试里一个实例拍平的用例要读它，3232 字节，是上游仓库 `tests/render/data/` 下的测试素材 |
| `Cargo.toml` | `renderer/Cargo.toml` | 包名、程序名、说明；去掉切掉的几类的依赖与特性 |
| `Cargo.lock` | `renderer/Cargo.lock` | 本包改名并按字母序挪到该在的位置；去掉不再需要的箱 |
| `rust-toolchain.toml` | `rust-toolchain.toml` | Rust 版本不变（1.100.0）；去掉只给浏览器构建用的 wasm32 目标，注释重写 |
| `LICENSE-upstream.txt` | `LICENSE` | 原样 |

`PROVENANCE.md`、`README.md`、`.gitignore` 是北冥新写的。

## 北冥加了什么

把照 Cycles 逐行移植的 GGX 金属闭包与矩形面光接进内核。闭包与面光本身在 [../shaders/](../shaders/)（`microfacet.wgsl`、`util.wgsl`、`area_light.wgsl`、`ggx_tables.wgsl`，源自 Blender Cycles，许可与版权写在各自的文件头），仓库里只有那一份；内核用 `include_str!` 直接读它们，本目录不放副本。

- `src/gpu.rs`：内核的文件列表里加上面四个着色器，别的没动。
- `shaders/closure.wgsl`、`shaders/light.wgsl`、`shaders/integrator.wgsl`（分文件之前都在 `shaders/pathtrace.wgsl` 里），以「北冥」开头的注释标出，一百行上下：
  - 金属（metallic 为 1）的基础高光层改走移植的闭包：`bm_closure`、`bm_eval`，以及求值、概率密度、采样三处的分支。菲涅耳用 F82-tint，底色当 F0，边缘色取白；alpha 取粗糙度的平方；能量补偿由场景选项 `energyCompensation` 开关。
  - 不画卡片的矩形纯光改走移植的球面矩形采样，并与材质采样做多重重要性采样：`bm_rect`、`bm_rect_le`、`bm_rect_sample`、`bm_rect_hits`，以及光源一侧与主循环里的几处调用。

已知的一处简化：矩形纯光的高光倍率不是默认的 1 时，光源一侧的高光乘了倍率、材质一侧没乘，两侧权重配不上。要支持非 1 的倍率时，把材质一侧的贡献按高光与漫反射拆开再乘。

上游的 `pathtrace.wgsl` 是一个三千多行的文件。这里把它按阶段分成了八个文件，只搬位置：`pathtrace.wgsl` 留下开头（编译开关、常数、全局参数、各张表的绑定与读法）和各阶段共用的小函数，其余按求交、材质求值、闭包、灯光、体积、积分主循环、输出各一个文件，哪个函数去了哪里写在 `pathtrace.wgsl` 的开头。上游的注释原样跟着代码走。入口函数 `main` 末尾写累加缓冲的一段，因为一个函数不能跨文件，抽成了函数（`film.wgsl` 的 `accum_write_sample`），语句没动。开头生成相机光线的一段留在 `main` 里：试过同样抽成函数，苹果显卡上相机三个轴都不贴坐标轴的场景，像素值的末位会变（相对差 2e-6，运算次序不同），所以没有单独的相机文件。`src/gpu.rs` 的文件列表与 `src/bvh.rs` 里一条读着色器源码的测试跟着改了文件名。Rust 源码的英文注释里仍写着「pathtrace.wgsl 的某某函数」，没有逐条改，按 `pathtrace.wgsl` 开头的对照表去找。从上游挑改动进来时，上游对 `pathtrace.wgsl` 的改动要按这张表落到对应的文件。

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

- `shaders/shader.wgsl`：`shader_setup_closures` 按材质输入值建立这个闭包（底色当 F0，边缘色读 `ShaderInputs.specular_tint`，现在恒为白；alpha 取粗糙度的平方；能量补偿的开关还读全局的 `energyCompensation`）。F82 的 B 项、能量补偿的倍率与权重在这里算一次、存进闭包，不再在每次求值、采样时重算。`ShaderInputs` 多了 `coat_weight`、`transmission_weight` 两项。粗糙度沿用上游的 0.02 下限。
- `shaders/closure.wgsl`：新增按闭包种类分发的 `bsdf_eval`（取出闭包的字段，调 `../shaders/microfacet.wgsl` 里移植的求值函数）；`surface_shader_bsdf_sample_closure` 对这个闭包调移植的采样函数，方向的两个随机数仍取上游材质采样那一组的后两维，采到方向后再求值一遍取值与概率密度（与原来的接线一样）；上游的灯光函数用的 `surface_shader_bsdf_eval_legacy` 对它直接取闭包的求值，上游每盏灯的高光倍率只对上游顶替有效。
- 上游的 `light_mis` 没有改：纯金属的 `Lobes.bm` 仍为真，它经上游的 `pdf_bsdf` 拿到的就是同一个移植函数算的密度。所以纯金属的着色点上仍要算上游的 `Lobes`。

这一步的渲染结果允许末位变化（原来的接线求值时多一次「除以余弦再乘回」，建立闭包的几项也是每次现算）。实测：第 2 级 24 个读数与改之前的相对差不超过 2e-8；每个读数用 8 个种子取均值，改前改后的差不到合成标准误的百分之一；上游自带的渲染测试里不含纯金属的 121 个场景原始输出逐字节相同，含纯金属的 5 个（`cache/mirror-metal`、`cache/mirror-sun`、`furnace/metal-energy-compensated`、`material/metal-f0`、`surface/windows-mirror`）像素相对差的中位数在 1e-7 上下，每张图有零到三个孤立像素超过 1e-5（两台机器、两种求交合起来最大的一个是 7e-3；换一个种子它们换地方、个数相仿，全图均值的相对差不超过 1e-6）：路径上的离散判断（俄罗斯轮盘等）在末位变化时翻了面。两台机器的基线在这一步之后重记过。

写法上又踩到三处，都写在各自的注释里：`bsdf_eval` 收一个闭包而不收整个着色点（收整个着色点时苹果显卡上过程几何的阴影场景会随机丢样本）；上游的 `Lobes` 对所有闭包都算（只给上游顶替算时苹果显卡上别的材质像素末位会变）；`light_mis` 不按闭包种类分支（试过三种写法，不是苹果显卡就是英伟达显卡上别的材质像素末位会变）。

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

## 沿用上游名字的地方

- **环境变量**。内核读的开关仍叫上游的名字（`THREERT_` 开头），例如 `THREERT_SEED`（随机数种子）、`THREERT_HWRT`、`THREERT_MERGED`、`THREERT_LOOP_GUARD`、`THREERT_PIPELINE_CACHE`、`THREERT_INSTANCING` 等。这次不改：上游自带的 JavaScript 工具还在给它们赋值，改名要和场景入口一起换。
- **场景运行时的接口**。场景包里的全局对象 `__threert` 与运行时模块名 `threert-runtime.js` 是上游 JavaScript 运行时与内核之间的约定，照旧。
- 注释与报错文字里提到上游项目、上游文档（如 `docs/RUNTIME.md`）与上游工具（如 `tools/bundle-game.ts`）的地方照旧，那些文件不在本仓库里。

## 场景入口暂时还是上游的

内核吃的是上游格式的场景包：用上游的 JavaScript 场景库写场景，再用上游的打包工具打成单个脚本，由内核里内嵌的脚本引擎运行。这一段还没有换成北冥自己的入口。所以跑第 2 级测试时，[../chassis/build.mjs](../chassis/build.mjs) 仍按上面的固定提交把上游仓库取到被忽略的 `out/` 下，核对提交号，只用其中的场景打包工具、场景库、自带的测试脚本与素材根目录；**渲染程序不再从那份取来的源码编，而是从本目录编**。

## 以后不再跟上游同步

这是一次性的分叉，不是定期合并的镜像。以后要用上游的某个新改动时，逐个挑、逐个改写进来，并在本页登记：上游的提交号、改了本目录哪些文件、为什么要。
