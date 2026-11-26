# 核心帧源 · 内核的四样内部结构

读者｜要改内核、或要在内核里移植闭包、灯、图案节点、降噪、输出通道的人与 agent　冻结标记｜[FREEZE.json](FREEZE.json)（版本 1.2.1，2026-11-25）　来源与历史｜[PROVENANCE.md](PROVENANCE.md)

这份条文定死路径追踪内核内部四样东西的形状：**材质记录、光线负载、随机维度、输出通道**。定下来是为了让后面几类移植能分给不同的人同时做：各改各的函数，不改这四样的形状。

条文照代码里实际落地的样子写。与代码对不上时以代码为准，并请改这份条文。

机器检查（在仓库根）：

```sh
node beiming/sources/core/chassis/freeze.mjs     # 冻结标记在、且与着色器里的定义一致：退出 0；否则 4
```

## 状态用语

每个字段、每个函数标一种状态：

| 状态 | 意思 |
|---|---|
| 已落地 | 有写有读，参与出图 |
| 已写未读 | 现在就写，还没有人读。给后面的移植留的；有一条静态测试守着写入语句不被悄悄删掉（见「锁」） |
| 已定义 | 名字与含义定了，值恒为 0 或没有人写，等后面某一类工作来接 |
| 已定义、无调用者 | 函数写好了签名（有的还有函数体），内核里还没有任何地方调它。只过了校验与两个后端的代码生成，没有被任何场景跑到过。**这类函数的签名是暂定的**，见「改动的规矩」第 6 条 |

「谁来接」统一列在末尾的「还没接的」一节。

## 总则

### 两类结构，规矩不一样

**进缓冲的格式**：材质记录 `Material`、全局参数 `Params`、物体扩展表 `ObjectExt`、输出缓冲 `film`。字段的位置就是格式，着色器与 Rust 两侧各有一份定义，库测试逐字段比。

| 格式 | 冻结的是什么 | 以后怎么加东西 |
|---|---|---|
| `Material` | 总长度 26 个 vec4，每一格的位置与含义 | 只能往预留格里填并起名，不许追加 |
| `Params` | 已有各块的长度与块内字段的位置 | 在末尾追加自己命名的一整块，登记块名与主人 |
| `ObjectExt` | 每个物体 2 个 vec4，各格的位置 | 各家只填自己的格子，不改长度 |
| `film` | 固定部分 10 格各自的位置 | 加固定通道只能填预留的两格；灯组排在固定部分之后 |

进缓冲的格式里标「上游」的格子，「删除」的意思是停止读写、把那一格改标预留；位置与长度不动。

**只活在一次调用里的结构**：`PathState`、`Ray`、`ShadingPoint`、`Closure`、`ShaderInputs`、`SampleResult`、`AuxSample`，以及各函数的返回结构（`BsdfEval`、`BsdfSample`、`BsdfPick`、`ClosureEval`、`LocalHit`、`LocalIntersection` 等）。它们没有落盘的格式，冻结的是字段的名字与含义。

- 加字段不算破坏；改已有字段的名字或含义算破坏。
- **不许位置式构造**（`Closure(a, b, …)`）：先取零值（`Closure()`）再按名字赋值。这样加字段才不会破坏别处。库测试 `call_structs_are_not_built_by_position` 按内核源码全文查。
- **函数实参里不许出现指向结构成员或数组元素的指针**（`f(&sd.N)`、`f(&sd.closure[i])`、`f(&state.throughput)`）。前两种在苹果显卡上一切正常，在英伟达显卡上建管线时着色器后端会崩；第三种（指向模块级私有变量的成员）两块显卡都编不过。要改某个闭包就传下标，或传整个变量的指针（`ptr<function, ShadingPoint>`）。库测试 `every_kernel_variant_generates_spirv_and_msl` 让内核的每个变体都过 SPIR-V 与 MSL 两个后端的代码生成，在任何一台机器上都拦得住。
- 进函数的结构里，三维向量后面不要紧跟标量；`Ray` 的两个向量因此排在最后（见「光线」）。
- **不要按变量下标读写着色点的闭包数组**（`sd.closure[i]`、`(*sd).closure[n] = c`）：苹果显卡上整个着色点会被挪到内存里，有 24 盏灯的计时场景稳态从 2.1 秒上下慢到 15 秒（1.2.0 落地时实测）。英伟达显卡上也一样要紧（1.2.0 落地时实测）：着色点按值传进函数时，按变量下标取它的闭包数组，SPIR-V 后端先把整个数组（4 × 128 字节）拷进函数内的临时变量再取，这份拷贝落在本地内存里。`surface_shader_bsdf_sample_closure` 原来的 `sd.closure[k]` 一处就让每个线程的本地内存从 336 字节涨到 1200 字节（驱动编出来的统计，见「判据」的计时一条），计时场景稳态慢 12.8%；苹果显卡上把这一处与 `bsdf_blur` 一起改成常数下标之后，回归工具量的稳态从 2.06 秒变成 1.45 秒（两次回归各 3 次的中位，不是轮流量的）。循环按下标展开成常数（`closure_store`、`surface_shader_bsdf_eval_mis`），要取第 k 个的地方（`surface_shader_bsdf_sample_closure`、`bsdf_blur`、`bsdf_albedo`）用 `switch` 分到常数下标；读数两台机器逐位不变。库测试 `closures_are_indexed_by_constants` 按内核源码全文查（注释不算），变量下标的读写一处都不许有。
- 不要再加按值收整个 `ShadingPoint` 的函数层。它有一千多字节；七个灯光函数已经按值收它，再往下多传一层，苹果显卡上出现过随机丢样本。新写的分发函数收一个闭包或标量。

### 函数的规矩

- 加新函数、给返回结构加字段不算破坏；**改已有函数的参数表算破坏**。所以以后可能加东西的参数一律收进结构传。
- 字段的归属按「写它的函数归谁」定，不按谁用它定。
- 照 Cycles 逐函数移植、要进函数级比对的函数（[../shaders/](../shaders/) 下的那些）签名只收标量与向量，不收上面的结构。收结构的只有内核里的分发函数：它们取出字段，再调标量签名的函数。分发函数由第 2 级读数与回归基线管。
- 冻结了签名的函数列在冻结标记里（`functions`），改了参数表而没更新标记，`freeze.mjs` 不过。

### 上游顶替

还没有照 Cycles 移植的部分先由上游原来的代码顶着，圈在名字带 `legacy` 的字段与函数里。

- 新写的代码不许读 `legacy`，也不许调名字带 `legacy` 的函数。
- 每移植完一块，就删掉它对应的 `legacy` 字段与函数；**删除不算破坏**。上游共用的结构（`Surface`、`Lobes`）按字段删：搜不到读者的字段，由最后删掉读者的那次移植顺手删。
- 眼下读着 `legacy` 的地方是一张例外清单，正本在 `shaders/closure.wgsl`「上游顶替」一节，哪次移植删掉了读者就从那里划掉。新代码不许往清单里加。
- 冻结标记不钉 `legacy` 结构的内容（`PathLegacy`、`ShadingLegacy`、`SampleLegacy`、`Surface`、`Lobes`），所以删它们的字段不用动标记。

### 逐位相等对写法敏感

显卡的着色器编译器会按上下文合并或重排浮点运算。把一段语句抽成函数、把两个量合到一个函数里算、按值返回一个大结构、把除法挪到调用方、让一个整数从另一个缓冲字段读，都可能让别处的像素末位变化，而且两块显卡敏感的地方不一样。要求渲染结果不变的改动，改一小步就在两台机器上各跑一次回归基线。已经踩到的各处写在 [PROVENANCE.md](PROVENANCE.md)「北冥加了什么」与对应代码的注释里。

## 材质

Cycles 里「材质」是两层：每个材质一份的输入参数，和每个着色点现算出来的一组闭包。这里两层都定：进缓冲的 `Material`，与只活在函数里的 `ShaderInputs`、`ShadingPoint`、`Closure`。

### 材质记录 `Material`（进缓冲）

定义：`shaders/pathtrace.wgsl` 的 `Material`；Rust 一侧 `src/scene.rs` 的 `GpuMaterial`。26 个 vec4（416 字节）；合并布局里按 vec4 拼的那一份用常数 `MATERIAL_VEC4`。

| 格 | 字段 | 类型 | 含义 | 状态 |
|---|---|---|---|---|
| 0 | `base_color` | vec4 f32 | rgb 底色；a 不透明度 | 已落地 |
| 1 | `emissive` | vec4 f32 | rgb 自发光辐亮度（发光色乘强度，读入场景时乘好），不含物体的功率倍数 | 已落地 |
| 2 | `params` | vec4 f32 | x 金属度，y 粗糙度（alpha 等于粗糙度的平方），z 上游的高光强度，w 法线贴图强度 | 已落地。z 只给上游顶替读 |
| 3、4 | `tex0`、`tex1` | vec4 i32 | 上游的贴图槽、材质种类、材质函数号 | 已落地（上游） |
| 5、6 | `uv`、`uv2` | vec4 f32 | 上游的贴图变换、镂空阈值等 | 已落地（上游） |
| 7 | `layer` | vec4 f32 | x 透射份额，y 折射率，z 清漆份额，w 清漆粗糙度 | 已落地 |
| 8 到 15 | `mp` | 8 个 vec4 f32 | 上游材质函数的参数 | 已落地。只归上游的材质函数 |
| 16、17 | `mt` | 8 个 i32 | 上游材质函数的贴图槽 | 已落地。只归上游的材质函数 |
| 18 | `specular_tint` | vec3 f32 | 金属：F82 的边缘色；非金属：乘在 F0 上的颜色。默认白 | 已落地，见下面「边缘色」 |
| 18 | `specular_ior_level` | f32 | 高光等级，默认 0.5。从场景描述压出来时取 three.js `specularIntensity`（默认 1）的一半 | 已落地（电介质高光读） |
| 19 | `diffuse_roughness` | f32 | 漫反射粗糙度，0 是朗伯 | 已落地（只用来判「漫反射粗糙度 0」；不为 0 的材质走上游顶替） |
| 19 | `flags` | u32 | 按位的标志，见登记表 | 第 0 位已落地，其余已定义 |
| 19 | `pattern_first`、`pattern_count` | u32 | 这个材质的图案节点在节点表里的起点与个数 | 已定义，恒 0 |
| 20 到 25 | `reserved` | 6 个 vec4 f32 | 预留，全 0。给各向异性、清漆、绒面、透射、薄膜、次表面的参数；用到的人在这里起名 | 预留 |

几条说明：

- 前 18 格是上游原样的，不搬成 Cycles 的排法。其中 `base_color`、`params.x`、`params.y`、`layer.y`、`emissive.rgb` 的含义与 Cycles 的同名输入相同，照 Cycles 移植的闭包直接用它们，不另存一份。
- 高光等级单独存，不与上游的 `params.z` 合用：两者只在折射率 1.5 时等价。
- 第 19 格在着色器里声明成四个标量，不用向量再做位转换。
- 图案节点（倒角、环境光遮蔽等）的参数不放进材质记录。材质记录只带 `pattern_first`、`pattern_count` 指向一张单独的节点表（首地址的格子见登记表）；节点表的格式归做图案节点的人。上游的 `mp`、`mt` 继续只归上游的材质函数。
- **默认值**在 Rust 一侧手写（`GpuMaterial::default`）：边缘色白、高光等级 0.5，其余全 0；每个构造处都以它收尾。`scene::build_material` 另按场景描述的 `specularIntensity` 填高光等级（等级 = 强度的一半：three.js 的强度乘在 F0 上，Blender 的等级乘 2 之后乘在 F0 上），所以 `specularIntensity: 0` 的材质没有电介质高光。
- **能量补偿那一位**（`MATERIAL_FLAG_MULTISCATTER`）不在各构造处填：上传前由 `scene::with_energy_compensation` 一处按全局开关 `energyCompensation` 统一写。移植的闭包（金属、电介质高光）读这一位；上游顶替仍读全局的 `P.misc.z`。
- **边缘色由一个场景特性位决定读不读材质记录**。特性位 `F_SPECULAR_TINT`（`src/gpu.rs` 的 `features_of` 按材质表定）：场景里有材质的边缘色不是白时，材质求值才从记录读 `specular_tint`；别的场景里内核编译期取白，不读这一格。这是量出来的：一律从记录读时，F82 的 B 项不再是编译期的 0，没有金属的场景稳态也慢 4%（苹果显卡）。现在没有任何场景入口能把边缘色设成非白，所以这一位平时恒关；强开它（环境变量 `THREERT_FEATURES_ON`）跑过全部回归，结果逐位不变。

谁写：Rust 的 `scene::build_material`（从场景描述压出来）与 `scene::card_material`。场景包读入器（`src/pack.rs`）把包里的材质先换成场景描述（底色、金属度、粗糙度，其余取默认），也经 `scene::build_material` 压。

谁读：新写的代码里**只有 `shader_eval_inputs` 读材质记录**（现在经它调的上游 `surface`、`surface_proc`）。积分器不读。上游留下的直接读者是已知的例外：求交一侧的镂空测试 `alpha_pass`、阴影穿玻璃 `glass_at`、硬件求交的 `cutout`；灯光一侧读发光三角材质的 `emitter_radiance`、`emitter_sel`、`emit_mis`、`sample_emitter`、`sample_emitter_ris`；给材质函数备输入的 `mat_in_at`。

### 材质输入值 `ShaderInputs`

定义：`shaders/shader.wgsl`。贴图、材质函数、图案节点都算完之后，一个着色点上的材质参数。取值范围照 Cycles 读出节点输入之后的夹取。写的人：`shader_eval_inputs`（现在是它调的上游 `surface` 里的 `legacy_shader_inputs`）。读的人：`shader_setup_closures`。

| 字段 | 类型 | 含义 | 状态 |
|---|---|---|---|
| `base_color` | vec3 | 底色，不小于 0 | 已落地 |
| `metallic` | f32 | 金属度，0 到 1 | 已落地 |
| `roughness` | f32 | 粗糙度，0 到 1。**不带上游的 0.02 下限** | 已落地 |
| `ior` | f32 | 折射率，不小于 1e-5 | 已落地（电介质高光读） |
| `specular_ior_level` | f32 | 高光等级，不小于 0。three.js 的无光照材质在这里置 0 | 已落地（电介质高光读） |
| `specular_tint` | vec3 | 边缘色，不小于 0；特性位关着时恒白 | 已落地（金属读夹到 1 以内的值当 F82 的边缘色，电介质高光乘在 F0 上） |
| `emission` | vec3 | 这个点的自发光辐亮度，**已乘物体的功率倍数** | 已落地 |
| `alpha` | f32 | 不透明度，0 到 1。现在只是材质记录里的值，不含贴图的透明度（镂空在求交那一侧判） | 已落地（只用来判「不透明度 1」；小于 1 的材质走上游顶替） |
| `diffuse_roughness` | f32 | 漫反射粗糙度，0 到 1 | 已落地（只用来判「漫反射粗糙度 0」） |
| `flags` | u32 | 材质记录的 `flags` 原样带过来 | 能量补偿位已落地（金属与电介质高光都读）；闭包大类已定义 |
| `coat_weight` | f32 | 清漆的份额，0 到 1 | 已落地（只用来判「无清漆」） |
| `transmission_weight` | f32 | 透射的份额，0 到 1 | 已落地（只用来判「无透射」） |
| `N` | vec3 | 闭包用的法线：含法线贴图、材质函数，以后还有倒角 | 已落地 |

### 着色点 `ShadingPoint`

定义：`shaders/shader.wgsl`。一次命中上的几何量与闭包，照 Cycles 的 `ShaderData` 取子集。它是积分主循环里的一个局部变量。

| 字段 | 类型 | 含义 | 谁写 | 状态 |
|---|---|---|---|---|
| `P` | vec3 | 位置（世界空间）。三角形上照 Cycles 的 `triangle_point_from_uv` 用重心坐标重建，经实例的再乘实例矩阵（第 52 条）；过程几何是 `o + d·t` | `shader_setup_from_hit` | 已落地 |
| `N` | vec3 | 插值后的平滑法线，打在背面时与 `Ng` 一起翻向来路；不含法线贴图、不含倒角。过程几何的命中里等于 `Ng` | 同上 | 已落地（1.2.1 起凹凸阴影项读它，见 `bsdf_eval_mis_bump_one`） |
| `Ng` | vec3 | 几何法线，翻向来路 | 同上 | 已落地 |
| `wi` | vec3 | 指向来路的方向 | 同上 | 已落地 |
| `object` | u32 | 物体表的下标，软件、硬件两条求交路上都有；不是实例记录号 | 同上 | 已落地（灯光链接的接收者、阴影终止偏移读物体扩展表；也抄进 `state.mis_ray_object`） |
| `prim` | u32 | 全局三角下标；过程几何的命中里是上游的命中码（最高位是 1） | 同上 | 已落地（阴影射线的起点偏移取三角形的顶点与顶点法线） |
| `u`、`v` | f32 | 重心坐标；过程几何的命中里是上游编码过的法线与属性 | 同上 | 已落地（同上） |
| `ray_length` | f32 | 这一段光线走了多远 | 同上 | 已写未读 |
| `flag` | u32 | 着色点标志，位照 Cycles。`SD_BACKFACING`（第 0 位）：打在背面 | 同上 | 已落地 |
| `object_flag` | u32 | 物体标志，位照 Cycles。第 3 位 `SD_OBJECT_NEGATIVE_SCALE`：物体是镜像的 | 没人写 | 已定义 |
| `time` | f32 | 这条光线的时刻 | 没人写 | 已定义，恒 0 |
| `lcg_state` | u32 | 局部求交随机取子集用的小随机数状态 | 没人写 | 已定义 |
| `inst` | u32 | 放置这个三角形的实例记录（`NO_INST`：没经实例，三角形本身在世界空间；过程几何也记 `NO_INST`）。Cycles 没有这个字段（它从物体取变换） | `shader_setup_from_hit` | 已落地（1.2.3 加；阴影射线的起点偏移 `light.wgsl` 的 `shadow_tri` 读） |
| `emission` | vec3 | 这个点的自发光，单独一个量，不占闭包 | `shader_setup_closures` | 已落地 |
| `num_closure` | u32 | 闭包个数。0：只发光、不散射，路径到这里结束 | 同上 | 已落地 |
| `closure` | `Closure` 的数组，长 `MAX_CLOSURE` | 闭包 | 同上 | 已落地（移植的至多 3 个，上游顶替 1 个） |
| `legacy` | `ShadingLegacy` | 上游的 `Surface` 与 `Lobes`，给上游顶替读 | `shader_eval_inputs`、`surface_shader_prepare_closures` | 已落地，闭包与灯移植完后删 |

`MAX_CLOSURE` 是 4，只在一处定义。它不是缓冲格式，改它不算破坏；数组越长每个着色点占的栈越大。

背面的判法沿用上游：几何法线与光线方向的点积不小于 0 就算背面。Cycles 是小于 0 才算背面，两者只在恰好垂直时不同。

### 闭包 `Closure`

定义：`shaders/shader.wgsl`。一个结构装所有种类（这门着色器语言没有联合体）。微表面的菲涅耳参数在 Cycles 里另放在四个结构里，这里摊平放进来。写的人：`shader_setup_closures`。

| 字段 | 类型 | 含义 | 状态 |
|---|---|---|---|
| `kind` | u32 | 闭包种类 `CLOSURE_*`，见登记表。Cycles 里叫 `type`，那是这门语言的保留字 | 已落地 |
| `weight` | vec3 | 彩色权重 | 已落地 |
| `sample_weight` | f32 | 在多个闭包之间选哪个去采样的权重：分配时取权重的平均，微表面的再乘估出来的反照率的平均与能量补偿的 darkening 的平均（次序照 Cycles） | 已落地（选闭包、合起来的概率密度读它） |
| `N` | vec3 | 这个闭包用的法线 | 已落地 |
| `alpha_x`、`alpha_y` | f32 | 微表面两个方向的粗糙度（各向同性时相等） | 已落地（求值与采样只读 `alpha_x`；滤光泽两个都读写） |
| `ior` | f32 | 折射率。电介质高光：按高光等级调过的 eta；金属：1 | 已落地（电介质高光读） |
| `energy_scale` | f32 | 能量补偿的标量倍率。必须与 `weight` 分开存，合进去会把颜色通道弄乱 | 已落地 |
| `fresnel_type` | u32 | 菲涅耳种类 `FRESNEL_*`，数值照 Cycles 的 `MicrofacetFresnel` | 已落地（`bsdf_eval`、`bsdf_sample`、`closure_albedo` 按它分 F82 与广义 Schlick） |
| `f0` | vec3 | F82 型与广义 Schlick 型的 F0 | 已落地 |
| `f90_or_b` | vec3 | F82 型：预先算好的 b；广义 Schlick 型：F90 | 已落地 |
| `exponent` | f32 | 广义 Schlick 的指数；负数表示「按折射率算真菲涅耳再重映射」（原理化 BSDF 取 −eta） | 已落地 |
| `reflection_tint`、`transmission_tint` | vec3 | 反射与透射的染色。广义 Schlick 里 Cycles 把真正的染色乘进了 F0，`reflection_tint` 只取 1 或 0，实际是「要不要反射焦散」的开关：照搬它的用法，别当颜色用 | 已落地（电介质高光取 1 与 0） |

`kind`、`weight`、`sample_weight`、`N` 所有闭包都填；`alpha_x`、`alpha_y`、`energy_scale`、`fresnel_type`、`f0`、`f90_or_b` 只有微表面闭包填；`ior`、`exponent`、`reflection_tint`、`transmission_tint` 只有电介质高光填（金属的 `ior` 填 1）。

菲涅耳种类：`FRESNEL_NONE`（0）、`FRESNEL_DIELECTRIC`（1）、`FRESNEL_DIELECTRIC_TINT`（2）、`FRESNEL_CONDUCTOR`（3）、`FRESNEL_GENERALIZED_SCHLICK`（4）、`FRESNEL_F82_TINT`（5）。`FRESNEL_GENERALIZED_SCHLICK`（电介质高光）与 `FRESNEL_F82_TINT`（金属）已落地，其余已定义。`FRESNEL_CONDUCTOR` 要一个复数折射率（实部、虚部各三个通道），闭包里还没有放它的字段：种类号先占着，用到时加两个字段。各向异性的切线、薄膜的参数同样是用到时加字段。

**现在的实际情况**（`shader_setup_closures`）：

- 没有清漆、透射、漫反射粗糙度，不透明度是 1 的材质，照 Cycles 的原理化 BSDF（`kernel/svm/closure.h` 的 `svm_node_closure_bsdf`）里「无清漆、无光泽、无次表面、无透射、无薄膜、各向同性、漫反射粗糙度 0」那一条路，至多三个闭包，次序与 Cycles 相同：
  1. 金属：金属度大于 1e-5（Cycles 的 `CLOSURE_WEIGHT_CUTOFF`）时，`CLOSURE_BSDF_MICROFACET_GGX` 加 `FRESNEL_F82_TINT`，权重是金属度乘剩下的权重；F0 是夹到 1 以内的底色，边缘色夹到 1 以内。之后剩下的权重乘 (1 − 金属度)。
  2. 电介质高光：`CLOSURE_BSDF_MICROFACET_GGX` 加 `FRESNEL_GENERALIZED_SCHLICK`，只有反射。F0 由折射率与高光等级算（`principled_specular_f0_eta`：等级不是 0.5 时 F0 乘 2 倍等级、eta 由 F0 反算），乘高光染色；F90 是 1，指数是 −eta，反射染色 1、透射染色 0。eta 为 1（比如高光等级 0）时不建。剩下的权重按它的反照率衰减（`closure_layering_weight`）。
  3. 漫反射：`CLOSURE_BSDF_DIFFUSE`，权重是底色乘剩下的权重。
  每个闭包照 Cycles 的 `bsdf_alloc`：权重的平均小于 1e-5 就不建（纯金属因此只有一个闭包）。alpha 取粗糙度的平方，**不带上游的 0.02 下限**：粗糙度 0 时微表面闭包是奇异的一瓣，求值为 0，采样的求值与概率密度乘 1e6，积分主循环照 Cycles 把它当普通的一次弹射（见「与 Cycles、与上游不一样的地方」）。能量补偿读材质记录的 `MATERIAL_FLAG_MULTISCATTER`（Cycles 的多重散射 GGX，原理化 BSDF 节点的默认分布）。
- 别的（带清漆或透射的、漫反射粗糙度不为 0 的、不透明度小于 1 的）：一个 `CLOSURE_LEGACY`，求值与采样转给上游。一个材质要么全走移植的闭包、要么全走上游，不混。
- 发光卡片（上游的 `card`：只发光、不散射）：没有闭包。所有闭包的权重都太小（比如无光照材质：底色、高光都是 0）时也没有闭包，路径到这里结束。
- `CLOSURE_BSDF_TRANSPARENT` 只占了种类号。
- 金属与电介质高光的闭包法线照 Cycles 取 `valid_reflection_N`（`maybe_ensure_valid_specular_reflection`：着色法线让镜面反射方向落到几何面以下时往几何法线拧），漫反射用原来的法线（1.2.1 起）。Cycles 只在材质带凹凸校正标志 `SD_USE_BUMP_MAP_CORRECTION` 时这样做，但这个标志由材质属性 `use_bump_map_correction` 决定、Blender 里默认开着，场景包里又没有这个参数，所以这里视为开：没有法线贴图的光滑球在轮廓附近也会拧。求值与采样的入口照 Cycles 乘凹凸阴影项（见「积分器碰材质只经这一组函数」）。
- 这条路上没有移的几步：发光被光泽与清漆衰减（这条路上衰减是 1）、各向异性的切线、阴影终止偏移（`shift_cos_in`）。材质函数改了上游的高光强度时，移植的闭包不认（读的是材质记录的高光等级）。

### 材质求值的三步，与只算透明度的一档

都在 `shaders/shader.wgsl`。

| 函数 | 做什么 | 状态 |
|---|---|---|
| `shader_setup_from_hit(sd, o, d, h)` | 填着色点的几何量，不读材质。往整变量的指针里填，不按值返回（按值返回时苹果显卡上像素末位会变） | 已落地 |
| `shader_eval_inputs(sd, o, d, h, width) → ShaderInputs` | 解出材质输入值。现在装上游的贴图与材质函数逻辑，顺带把上游的 `Surface` 留在 `sd.legacy` 里。图案节点接在这里；以后的节点图编译器整段替换它 | 已落地 |
| `closure_store(sd, n, c)` | 把闭包放进第 n 格，下标写成常数（按变量下标往闭包数组里写，苹果显卡上整个着色点会被挪到内存里，实测稳态慢几倍） | 已落地（1.2.0 加） |
| `shader_setup_closures(sd, inputs)` | 只读 `ShaderInputs`，填闭包与自发光（见上「现在的实际情况」）。归移植闭包的人 | 已落地 |
| `shader_eval_shadow(h, d, t) → vec3` | 只算透明度的一档：命中点放过多少光。不许发任何光线，不许调图案节点。求交函数与阴影透射里只许调这一档，不许调上面的全量求值（这门语言不许调用图里有环，而全量求值以后会回头发光线）。现在转给上游的镂空测试与阴影穿玻璃 | 已定义、无调用者（上游的求交与阴影射线仍直接调那两处） |
| `shader_eval_emission(em, b1, b2, l) → vec3` | 灯采样点上的发光：口径照 Cycles（发光量乘 `emissive_simple_eval`，两面都发光），发光量仍由上游的 `emitter_radiance` 给 | 已落地（上游采样发光三角的 `sample_emitter`、`sample_emitter_ris` 调它取发光值；采样的概率密度归做灯的人） |

### 积分器碰材质只经这一组函数

都在 `shaders/closure.wgsl`，名字照 Cycles 的 `integrator/surface_shader.h`。它们是分发函数。

| 函数 | 做什么 | 状态 |
|---|---|---|
| `surface_shader_prepare_closures(sd)` | 闭包填好之后、算直接光与采样之前的事后处理。滤光泽照 Cycles：全局参数的 `filter_glossy`（存的就是内核里的量 1 / blur_glossy，0 关）大于 0 时，`blur_pdf` = 它乘 `state.min_ray_pdf`，小于 1 时各微表面闭包的 alpha 与 `sqrt(1 − blur_pdf)·0.5` 取大（`bsdf_microfacet_blur`）；上游顶替不模糊。上游的 `Lobes` 也在这里算，对所有闭包都算（上游的灯光函数还读它的 `two_sided`） | 已落地 |
| `bsdf_eval(c, wi, wo) → ClosureEval { eval, pdf }` | 一个闭包在一个方向上的求值（已含余弦，没乘闭包的 `weight`）与概率密度。照 Cycles 的 `bsdf_eval`，按种类与菲涅耳种类分到金属、电介质高光、漫反射。收一个闭包，不收整个着色点。上游顶替不走这里 | 已落地 |
| `bsdf_sample(c, Ng, wi, rand) → MicrofacetSample` | 一个闭包上采样方向，照 Cycles 的 `bsdf_sample` 分发；用 `rand` 的前两个 | 已落地（1.2.0 加） |
| `bsdf_eval_mis_bump_one(c, Ns, wi, wo, e) → vec2` | `surface_shader_bsdf_eval_mis` 循环里的一个闭包：先照 Cycles `bsdf_eval` 的入口算凹凸阴影项（`Ns` 是着色点的平滑法线 `sd.N`；为 0 时求值与密度都是 0），再求值、乘上它，累加进 `e`，返回 (密度乘取样权重, 取样权重) | 已落地（1.2.1 加） |
| `bsdf_eval_mis_one(c, wi, wo, e) → vec2` | 同上，不乘凹凸阴影项 | 1.2.1 起没有调用者（由上一行代替）；签名在冻结标记里，删不删等核心帧源的负责人定 |
| `bsdf_blur(sd, k, roughness) → Closure` | 第 k 个闭包模糊之后的样子，照 Cycles 的 `closure/bsdf.h` `bsdf_blur`（微表面闭包的 alpha 与模糊粗糙度取大）；滤光泽用 | 已落地（1.2.0 加） |
| `bsdf_eval_accum(e, kind, value)` | 求值累加进漫反射或光泽那一份与 `sum`，照 Cycles 的 `film/light_passes.h` | 已落地（1.2.0 加） |
| `surface_shader_bsdf_eval_mis(sd, wo, skip, e, sum_pdf, sum_sample_weight) → f32` | 除第 `skip` 个之外的闭包求值累加进 `e`，返回按 `sample_weight` 加权的平均概率密度。照 Cycles 的 `_surface_shader_bsdf_eval_mis`；`skip` 取 `MAX_CLOSURE` 时不跳过 | 已落地（1.2.0 加） |
| `surface_shader_bsdf_eval(sd, wo, light_shader_flags) → BsdfEval` | 对所有闭包求值求和、概率密度按 `sample_weight` 加权平均（照 Cycles 的同名函数）。`light_shader_flags` 是灯的着色标志，现在没人读 | 已落地（上游的灯光函数经 `surface_shader_bsdf_eval_legacy` 与 `light_mis` 调它） |
| `surface_shader_bsdf_bssrdf_pick(sd, rand) → BsdfPick { closure, rand }` | 按 `sample_weight` 选一个闭包去采样；用三个随机数里的第三个来选，选完重新拉伸回 0 到 1。照 Cycles 的同名函数 | 已落地 |
| `surface_shader_bsdf_sample_closure(sd, k, rand) → BsdfSample` | 在第 k 个闭包上采样方向，用 `rand` 的前两个定方向，再并进其余闭包在这个方向上的求值与概率密度；通量的权重是求值之和除以合起来的概率密度（照 Cycles 的同名函数与 `integrate_surface_bsdf_bssrdf_bounce`）。采到了、又不是透射时，求值照 Cycles `bsdf_sample` 的出口乘凹凸阴影项（1.2.1 起）。上游顶替不用 `rand`，自己从上游的随机数里取 | 已落地 |
| `surface_shader_emission(sd) → vec3` | 这个点朝来路发出的光：照 Cycles，发光量乘 `emissive_simple_eval`（两面都发光）。上游的发光卡片例外，照旧是单面的 | 已落地 |
| `surface_shader_transparency(sd) → vec3` | 阴影射线穿过这个点时放过多少光。恒 0 | 已定义、无调用者 |
| `bsdf_albedo(sd, k) → vec3` | 第 k 个闭包的反照率，口径照 Cycles 的 `bsdf_albedo`（`closure_albedo`：闭包权重，微表面的再乘 `bsdf_microfacet_estimate_albedo`）。上游顶替返回上游的底色 | 已落地 |
| `closure_albedo(c, wi) → vec3` | 一个移植的闭包的反照率（`bsdf_albedo` 与层间权重都用它） | 已落地（1.2.0 加） |
| `closure_sample_weight(weight) → f32` | 分配闭包时的取样权重，照 Cycles 的 `closure/alloc.h`；小于 1e-5 时为 0，不建这个闭包 | 已落地（1.2.0 加） |
| `surface_shader_denoising_albedo(sd) → vec3` | 降噪用的反照率：照 Cycles 的 `film/denoising_passes.h` 在「首次命中、不跟反射、不按粗糙度加权」时的值，漫反射类闭包的 `bsdf_albedo` 之和。上游顶替取上游的底色 | 已落地（1.2.0 加；主循环在相机命中处读它） |

返回的结构：

| 结构 | 字段 | 状态 |
|---|---|---|
| `BsdfEval` | `diffuse`、`glossy`（vec3）：漫反射与光泽闭包各自的部分；`sum`（vec3）：全部闭包之和，已含余弦；`pdf`（f32）：各闭包的密度按 `sample_weight` 的加权平均 | `sum`、`pdf` 已落地（直接光读 `sum`，`light_mis` 读 `pdf`，采样在 `surface_shader_bsdf_sample_closure` 里读它算权重）；`diffuse`、`glossy` 已写未读（`glossy` 只拿来算上游的高光份额）。积分器不读这个结构（权重已经在采样函数里算好） |
| `BsdfSample` | `wo`（vec3）采到的方向，全 0 表示没采到；`eval`（`BsdfEval`）；`pdf`（f32），奇异的一瓣为 0；`label`（i32）采样标签 `LABEL_*`，位照 Cycles；`sampled_roughness`（vec2）；`eta`（f32）折射率比；`weight`（vec3）通量的权重 | `wo`、`pdf`、`label`、`sampled_roughness`、`weight` 已落地；`eval` 已写未读（上游顶替不填）；`eta` 已写未读（移植的闭包只有反射，恒 1） |
| `BsdfPick` | `closure`（u32）选中的下标；`rand`（vec3）重新拉伸后的随机数 | 已落地 |
| `ClosureEval` | `eval`（vec3）、`pdf`（f32） | 已落地 |

采样标签：`LABEL_NONE`（0）、`LABEL_TRANSMIT`（1）、`LABEL_REFLECT`（2）、`LABEL_DIFFUSE`（4）、`LABEL_GLOSSY`（8）、`LABEL_SINGULAR`（16）、`LABEL_VOLUME_SCATTER`（64），数值照 Cycles。它们分在三个文件里：`LABEL_NONE`、`LABEL_REFLECT`、`LABEL_DIFFUSE`、`LABEL_GLOSSY`、`LABEL_SINGULAR` 在共用目录的 `../shaders/util.wgsl`（移植的闭包用到的五个；`LABEL_DIFFUSE` 在 1.2.0 从 `shaders/closure.wgsl` 挪过来，漫反射闭包要它），`LABEL_TRANSMIT` 在 `shaders/closure.wgsl`，`LABEL_VOLUME_SCATTER` 在 `shaders/integrator.wgsl`。七个都进了冻结标记。

上游顶替专用、灯移植完后删的两个：`surface_shader_bsdf_eval_legacy(sd, wo, k) → { eval, spec_frac }`（上游的灯光函数专用的求值，`k` 是上游每盏灯的高光倍率，只对上游顶替有效）与 `surface_shader_bsdf_sample_legacy(sd)`。

灯光函数里收着色点的是上游留下的五个（`direct_light`、`local_lights`、`sample_emitter_ris`、`env_light`、`sun_light`）与 `light_origin`（1.2.3 起 `light_mis`、`pdf_spec` 删掉）；照 Cycles 新写的灯的辅助函数只收标量（`shadow_tri`、`shadow_ray`、`shadow_ray_vis`、`shadow_ray_sky`、`light_linked`、`light_receiver_set`、`light_lightgroup`、`local_atten`、`film_add_direct`、`film_add_forward`），逐盏的直接光原地写在 `direct_light` 里，不另加收着色点的一层。灯记录（`Light`，6 个 vec4：上游的五个，加照 Cycles 的 `cy`，整数格：eval_fac 与平行光 one_minus_cosangle 的位、灯光链接的成员掩码、灯组槽位与 `SHADER_USE_MIS`，见 `src/scene.rs` 的 `GpuLight`）的格式与「把灯压成记录的那一个函数」都归做灯的人独占，这里不定。

## 光线负载

### 路径状态 `PathState`

定义：`shaders/integrator.wgsl`。照 Cycles 的 `IntegratorState.path` 取子集，字段名不改。本内核是「一个像素一条线程，一条路径走到底」，不做波前调度，所以阴影射线没有独立的状态结构。

**路径状态是一个模块级的私有变量 `state`**，所有函数直接读写，不当参数传。

| 字段 | 类型 | 含义 | 谁写 | 状态 |
|---|---|---|---|---|
| `render_pixel_index` | u32 | 写缓冲用的像素下标 | 两个入口（`main`、`aux_sample`）开头 | 已落地 |
| `sample` | u32 | 第几个样本 | `rng_start` | 已落地 |
| `bounce` | u32 | 总弹射数，也就是当前着色点是路径上第几个顶点 | 主循环每轮开头 | 已落地 |
| `diffuse_bounce`、`glossy_bounce`、`transmission_bounce` | u32 | 分类计数：照采样标签累加，数到 `integrator` 块里各自的上限置 `PATH_RAY_TERMINATE_AFTER_TRANSPARENT` | `path_state_next` | 已落地 |
| `transparent_bounce` | u32 | 透明的计数 | 没人写 | 已定义 |
| `rng_pixel` | u32 | 随机数的像素种子 | `rng_start` | 已落地 |
| `rng_offset` | u32 | 当前弹射的随机维度偏移，初值 `PRNG_BOUNCE_NUM`，每弹射一次加一个 | `main` 开头、`path_state_next` | 已落地 |
| `flag` | u32 | 路径标志位 `PATH_RAY_*` | 主循环 | `PATH_RAY_MIS_SKIP` 已落地，其余已定义 |
| `mis_ray_pdf` | f32 | 上一个散射点采样的概率密度：下一次打到灯时算多重重要性采样的权重 | 主循环 | 已落地 |
| `min_ray_pdf` | f32 | 这条路径上最小的采样概率密度，初值为浮点最大值。有概率密度的弹射才记（表面的非穿透一支，含移植的闭包奇异的那一瓣、介质散射） | 主循环 | 已落地（滤光泽读） |
| `continuation_probability` | f32 | 这一次弹射俄罗斯轮盘的存活概率，不掷时为 1 | 主循环 | 已落地 |
| `throughput` | vec3 | 路径的通量权重 | 主循环 | 已落地 |
| `visibility` | u32 | 这一段光线的可见类 `PATH_RAY_VISIBILITY_*` | `main` 开头、`path_state_next` | 已写未读（只有骨架） |
| `mis_ray_object` | u32 | 上一个散射点所在的物体（物体表的下标）；介质散射记 `OBJECT_NONE` | 主循环 | 已落地（灯光链接的前向接收者：`light.wgsl` 的 `bm_rect_hits`、`sun_disks`） |
| `first_hit_object` | u32 | 相机射线首次命中的物体（物体表的下标）；没打到表面（含在介质里先散射了）记 `OBJECT_NONE`。覆盖率用：`film_write_sample` 读它的实体编号 | `main` 开头、主循环第 0 个顶点；只在要辅助层的变体（编译开关 `aux`）里写 | 已落地（1.1.0 加） |
| `mis_origin_P` | vec3 | 上一个散射点本身（没有沿法线挪开；介质散射处就是散射点）：材质采样的射线打到矩形纯光时从它算命中与概率密度、打到发光三角时从它算灯光树的选灯概率，与光源采样一侧用同一个点。Cycles 没有这个字段（它不挪射线起点，`ray.P` 就是这个点），名字照 `mis_origin_n` 取 | 主循环（表面弹射与介质散射）、`volume.wgsl` | 已落地（1.2.2 加，替掉上游的 `legacy.bm_x` 与 `legacy.mis_x`） |
| `legacy` | `PathLegacy` | 上游的路径状态，照 Cycles 没有对应 | 各处 | 已落地，对应功能移植后删 |

已登记、还没加的字段（加字段不算破坏，这里只占名字）：`pass_diffuse_weight`、`pass_glossy_weight`（分通道对拍用）、`denoising_feature_throughput`（降噪特征用）。

`PathLegacy` 里现在有：`behind_glass`、`bent`、`straight`、`mirror_path`、`bm_surf`、`rays_off`、`split_frac`、`dl_spec`、`sampled_spec`、`sampled_trans`、`mis_n`、`shadow_hole`、`lights_only`、`rng_path`（1.2.2 起 `bm_x`、`mis_x` 并成正式字段 `mis_origin_P`；1.2.3 删掉没人读的 `dl_det`、`dl_det_spec` 与从来没人写成真的 `nee_alone`）。没有并进来的上游私有量不是路径状态：求交里过程几何的调用上下文（`gdata_first`、`gdata_count`、`media_voxels`）、灯光瓦片的每像素状态（`lt_list`、`lt_list_n`、`lt_fb`）、循环守卫的计数。

`path_state_next(label)` 在每次弹射之后更新路径状态，照 Cycles 的同名函数：下一段光线的可见类、随机维度的偏移，表面散射的分类计数与各类上限（见下面「弹射上限」）。其余路径标志位归移植闭包的人照 Cycles 补。`PATH_RAY_MIS_SKIP` 在主循环里设与清：相机射线、上游顶替的穿过光滑玻璃，以及（1.2.0 起）移植的闭包采到的奇异一瓣（`LABEL_SINGULAR`，照 Cycles `path_state_next` 的 `PATH_RAY_SINGULAR | PATH_RAY_MIS_SKIP`）之后设，别的弹射清。

### 路径标志位与可见类

两个枚举，位都照 Cycles（`PathRayFlag` 与 `PathRayVisibilityFlag`）。

路径标志位（`state.flag`）：`PATH_RAY_REFLECT`（第 0 位）、`PATH_RAY_SINGULAR`（1）、`PATH_RAY_TRANSPARENT`（2）、`PATH_RAY_DIFFUSE_ANCESTOR`（4）、`PATH_RAY_EMISSION`（5）、`PATH_RAY_MIS_HAD_TRANSMISSION`（6）、`PATH_RAY_MIS_SKIP`（7）、`PATH_RAY_SINGLE_PASS_DONE`（8）、`PATH_RAY_TRANSPARENT_BACKGROUND`（9）、`PATH_RAY_TERMINATE_ON_NEXT_SURFACE`（10）、`PATH_RAY_TERMINATE_AFTER_TRANSPARENT`（12）、`PATH_RAY_DENOISING_FEATURES`（17）、`PATH_RAY_SURFACE_PASS`（18）、`PATH_RAY_SHADOW_FOR_AO`（20）、`PATH_RAY_SHADOW_FOR_LIGHT_LINKING`（25）。`PATH_RAY_MIS_SKIP` 已落地（相机射线、穿过光滑玻璃、奇异的一瓣之后，下一次打到发光面、天空、太阳盘、矩形纯光不做多重重要性采样，权重取 1：`emit_mis` 的调用处、`sky_mis`、`sun_disks`、`bm_rect_hits` 都认它）；`PATH_RAY_TERMINATE_AFTER_TRANSPARENT` 已落地（某一类散射数到了上限，见下面「弹射上限」）；其余已定义。

可见类（`state.visibility`）：`PATH_RAY_VISIBILITY_NONE`（0）、`PATH_RAY_VISIBILITY_CAMERA`（第 0 位）、`PATH_RAY_VISIBILITY_TRANSMIT`（1）、`PATH_RAY_VISIBILITY_DIFFUSE`（2）、`PATH_RAY_VISIBILITY_GLOSSY`（3）、`PATH_RAY_VISIBILITY_VOLUME_SCATTER`（4）、`PATH_RAY_VISIBILITY_SHADOW_OPAQUE`（5）、`PATH_RAY_VISIBILITY_SHADOW_TRANSPARENT`（6）。相机、透射、漫反射、光泽、介质散射五位有人写；两位阴影类已定义。没有读者。

### 光线 `Ray`

定义：`shaders/integrator.wgsl`。照 Cycles 的 `Ray`，加上游的射线锥（它跟着光线走，不随闭包的移植删除）。它是主循环里的一个局部变量。

| 字段 | 类型 | 含义 | 状态 |
|---|---|---|---|
| `tmin` | f32 | 起始距离 | 已定义（上游靠把起点沿法线挪开来避开自己） |
| `tmax` | f32 | 最远距离 | 已落地 |
| `time` | f32 | 时刻 | 已定义，恒 0 |
| `self_object`、`self_prim` | u32 | 光线出发处的物体与图元，求交时跳过自己用 | 已写未读（恒为 `OBJECT_NONE`） |
| `cone_w`、`cone_a` | f32 | 射线锥：起点处的宽度与张角，贴图取级用 | 已落地 |
| `P` | vec3 | 起点 | 已落地 |
| `D` | vec3 | 方向（单位向量） | 已落地 |

两个三维向量排在最后是有意的：它们排在前面、后面紧跟标量时，苹果显卡上两个带水的场景像素会变。**往这个结构里加字段请加在两个向量之前。**

相机光线的算式原样留在 `main` 里，算完填进 `Ray`：把那一段抽成函数时，苹果显卡上相机三个轴都不贴坐标轴的场景像素末位会变。所以没有单独的相机文件。

### 求交

上游的接口原样冻结：`trace(o, d, tmax_in, mode) → Hit { t, tri, u, v, inst }`，硬件与软件两条求交路径返回同一个结构；没打到时 `tri` 是 `0xffffffff`。调用处从 `Ray` 里取字段。要跳过的图元（Cycles 的 `Ray.self`）不进参数，放在模块级的私有变量 `trace_self` 里，只有阴影射线设它（第 51 条）。软件求交的三角形求交是照 Cycles 移植的、防水的那一个，三角形缓冲存三个原顶点（「与 Cycles、与上游不一样的地方」第 46 条）；苹果显卡的硬件求交在公共边上漏是平台限制（第 47 条）。

以后要的新问法各加一个新函数，不改已有的。现在定了签名的一个：

`trace_local(ray, object, lcg_state, max_hits) → LocalIntersection { num_hits, hits, lcg_state }`：只查同一个物体、返回至多 `LOCAL_MAX_HITS`（4）个命中，每个是 `LocalHit { t, tri, u, v }`。倒角与遮蔽这类图案节点用。用过之后的小随机数状态在返回值里带回（这门语言没法把成员的指针传进函数）。**已定义、无调用者，函数体是空壳**（恒返回 0 个命中）。

实现它时的限制：硬件求交下不许新增光线查询的源码位置，只能在现有的 `trace` 之上逐次步进、按物体号过滤来拼，不用候选循环（上游记录过候选循环在苹果显卡上丢命中）。这样拼出来的多命中在硬件求交下是否可靠、代价多大**还没有量过**；不可靠的话只在软件求交上保证图案节点。阴影类的问法只许判断挡没挡住，不许读返回的三角号。硬件求交下按物体过滤可见类同样是已知限制，之前只在软件求交上保证。

### 全局参数 `Params` 末尾追加的四块（进缓冲）

定义：`shaders/pathtrace.wgsl` 的 `Params`、`KernelIntegrator`、`KernelFilm`、`KernelFilterTable`；Rust 一侧 `src/gpu.rs` 的同名结构。上游原有的字段不动（实时预览留下的字段这次不清）。放在统一缓冲里的嵌套结构，第一个成员带 `@align(16)`。

**`integrator`**（`KernelIntegrator`，4 个 vec4，字段名照 Cycles 的同名结构）。写的人：`KernelIntegrator::new(用户种子)`。

| 格 | 字段 | 类型 | 含义 | 状态 |
|---|---|---|---|---|
| 0 | `max_bounce` | u32 | 总弹射的上限 | 已定义，0（总上限读上游的 `counts.z`） |
| 0 | `max_diffuse_bounce`、`max_glossy_bounce`、`max_transmission_bounce` | u32 | 漫反射、光泽（含奇异的反射）、透射各自的上限，口径见表下「弹射上限」 | 已落地：`Params::set_preset` 照预设的 `maxDiffuseBounces`、`maxGlossyBounces`、`maxTransmissionBounces` 原样写，预设不写就是 `u32::MAX`（不限）；`path_state_next` 读 |
| 1 | `transparent_max_bounce`、`transparent_min_bounce`、`min_bounce` | u32 | 透明弹射的上下限；俄罗斯轮盘的起始深度 | 已定义，0（轮盘的起始深度现在读上游的 `counts.w`） |
| 1 | `sampling_pattern` | u32 | 采样图案，只有 0（Sobol-Burley） | 已定义 |
| 2 | `sample_clamp_direct`、`sample_clamp_indirect` | f32 | 夹取的直接光、间接光上限：存**用户值 × 3**（照 Cycles 宿主一侧 `scene/integrator.cpp:311-315` 的存法），0 关（Cycles 关着时存浮点最大值，见「与 Cycles、与上游不一样的地方」第 38 条）。内核照 Cycles 的 `film_clamp_light` 比的是一次贡献**三个分量绝对值之和**（`reduce_add`），超了按比例缩到上限，所以灰的贡献每个分量夹到用户值；按「弹射数」选上限：大于 0 用间接光的 | 已落地：`render-pack` 照 `--clamp-direct`、`--clamp-indirect` 写；内核在编译开关 `sample_clamp` 的变体里经 `film.wgsl` 的 `film_clamp_contribution` 读。别的入口恒 0，照旧用上游的亮度夹取 `misc.x` |
| 2 | `filter_glossy`、`light_inv_rr_threshold` | f32 | 滤光泽：存 1 / blur_glossy（照 Cycles 宿主一侧 `scene/integrator.cpp:269` 的存法），内核直接用，不再取倒数；0 关（Cycles 关着时存浮点最大值，见「与 Cycles、与上游不一样的地方」第 38 条）。写它的是命令行（换算在写的那一侧：`render-pack --filter-glossy <用户值>` 写 1 / 用户值，用户值 0 写 0）。灯的轮盘阈值 | `filter_glossy` 已落地（`surface_shader_prepare_closures` 读，`render-pack` 写，别的入口恒 0）；`light_inv_rr_threshold` 已定义，0 |
| 3 | `seed` | u32 | 随机数的全局种子 | 已落地，见下 |
| 3 | `sobol_index_mask` | u32 | Sobol 打乱后的索引取哪几位 | 已落地，见下 |

**弹射上限**的口径（总的与分类的同一种，都是 Cycles 内核一侧的值）：上限 N 的意思是第 N 次散射（总的数全部散射，分类的只数这一类）之后的那个顶点是最后一个。总上限在主循环里比 `depth == P.counts.z`；分类上限照 Cycles `kernel/integrator/path_state.h:176-209` 在 `path_state_next` 里数（采样标签带 `LABEL_REFLECT` 的，再带 `LABEL_DIFFUSE` 记漫反射、不带的记光泽，奇异的反射也记光泽；不带 `LABEL_REFLECT` 的记透射，上游顶替的穿过光滑玻璃也记透射），数到 `max_*_bounce` 置 `PATH_RAY_TERMINATE_AFTER_TRANSPARENT`。带这一位的顶点照 Cycles（`surface_shader.h:1262-1266` 的 `max_closures` 取 0）只收射线路上打到的灯（发光面、天空、矩形纯光照常加，多重重要性采样的权重照常），闭包不参与（主循环照旧建了闭包才判这一位，建出来的不用）、不做直接光、不再散射，`last_direct`、`last_sun` 变体里也一样；路径在介质里撞上就停（Cycles `shade_volume.h:1738-1742` 只衰减不散射，期望里乘的是透过率）。总上限到了的那个顶点在 `last_direct`、`last_sun` 变体里还做直接光，这是上游的开关，桌面默认关。

**Cycles 界面值换到这里一律加一**：界面上总上限或某一类上限是 G，这里写 G + 1。依据是内核一侧的用法：Cycles 每次散射之后先把计数加一，再比 `计数 >= kernel_data.integrator.max_*`（`path_state.h:143-146`、`183`、`190`、`206`），所以内核值 N 让第 N 次散射之后的顶点只收灯；界面值 0 是「只有直接光」（相机看到的顶点还做直接光，它之后的顶点只收灯），对应内核值 1。宿主一侧把界面值加一写进内核的那个文件（`scene/integrator.cpp`）不在本机的 Cycles 源码缓存里，没有逐行对过；另用 Blender 5.2 在一个高光包上按几组界面值各渲 16 个种子，球下影区的均值与核心逐顶点累加的直接光比：加一对得上，不加一少一个顶点的直接光，影区暗三成多。`render-pack` 的预设（`cinematic` 的 `maxBounces: 8`）本来就是内核值；第 3、4 级照参考包清单的 `bounces` 加一传进来（`../chassis/level3.mjs` 的 `MATCH`）。
| 3 | `pass_kind` | u32 | 这一趟调度写什么：`PASS_KIND_COLOR`（0）颜色样本，`PASS_KIND_AUX`（1）辅助样本。两侧同名常数 | Rust 一侧照实填（要辅助层时清零之后、第一个颜色样本之前以 1 调度一次）；内核不读：两种样本各走自己的入口（见「编号登记表」的「编译开关与入口」） |
| 3 | `background_transparent` | u32 | 背景对相机不可见：相机射线没打到表面的样本不透明度与颜色都记 0 | 已落地：`render-pack` 照场景包的 `world.visibleToCamera` 填；别的入口恒 0 |

**种子与掩码现在从哪里读**：内核读 `P.integrator.seed` 与 `P.integrator.sobol_index_mask`。

- `seed` 里放的是**用户种子在 CPU 上过一次 `hash_hp` 之后的值**（原来着色器里对种子现算的那一次哈希挪到了 CPU 上）。所以只差低位的用户种子给出的序列也互不相干。上游放种子的位置 `size.w` 停写，标预留，恒 0。
- `sobol_index_mask` 现在固定是上游写死的 `0xffff0000`（Rust 一侧的常数 `SOBOL_INDEX_MASK`）。为 0 时每个样本取同一个点，开渲前报错。Cycles 里它是按采样数算出来的；换掩码算法的人只改 CPU 上填它的那一处。

**`film`**（`KernelFilm`，1 个 vec4）。写的人：`KernelFilm::new(请求的灯组数)`。

| 字段 | 类型 | 含义 | 状态 |
|---|---|---|---|
| `film_stride` | u32 | 输出缓冲里每个像素占几个 vec4 | 已落地 |
| `film_lightgroup_first` | u32 | 第 0 个灯组在像素里的位置（固定部分的长度） | 已落地（内核里读它的那一支没有场景走到过） |
| `num_lightgroups` | u32 | 这次渲染请求的灯组数，不是场景里的灯组数 | 同上 |
| `reserved` | u32 | 预留 | 预留 |

**`filter_table`**（`KernelFilterTable`，257 个 vec4，1.2.0 加，归成像）：像素滤波的重要性采样表。写的人：`KernelFilterTable::new(种类, 宽度)`（`render-pack` 照 `--pixel-filter`、`--filter-width` 调；别的入口与默认是 `KernelFilterTable::default()`，全 0）。

| 格 | 字段 | 类型 | 含义 | 状态 |
|---|---|---|---|---|
| 0 | `use_filter_table` | u32 | 1：相机射线的像素内偏移查下面这张表；0：不查表，像素内均匀抖动（盒式宽 1 与默认就是这样） | 已落地 |
| 0 | `reserved0`、`reserved1`、`reserved2` | u32 | 预留 | 预留，0 |
| 1–256 | `table` | vec4 × 256 | 表的 1024 个数（`FILTER_TABLE_SIZE`），每个 vec4 装四个：照 Cycles `scene/film.cpp` 的 `filter_table` 在宿主一侧建（`src/pixel_filter.rs`），内核经 `film.wgsl` 的 `filter_table_value(i)` 读、`../shaders/imaging.wgsl` 的 `filter_table_read` 查（`kernel/util/lookup_table.h` 的 `lookup_table_read`，`kernel/camera/camera.h:460-465` 的用法） | 已落地：`use_filter_table` 为 1 时（编译开关 `pixel_filter` 的变体）读 |

**`table_first_ext`**（2 个 vec4、8 格）：北冥加的表在表缓冲里的首地址。上游的 `table_first` 12 格已经占满，新表只许用这里的格子，取用前要登记（见登记表）。Rust 一侧北冥加的表是 `heap::Table` 第 12 张起，各占哪一格由 `heap::EXT_SLOTS` 定（不按次序：`[0].y` 留给还没有的图案节点表，那一格是 0）。

**广义 Schlick 的两张反照率表**（1.2.0 加，占 `[0].z`、`[0].w`）：Cycles `scene/shader.tables` 的 `table_ggx_gen_schlick_ior_s`、`table_ggx_gen_schlick_s`，各 4096 个 f32（16×16×16），数据在 `../shaders/ggx_gen_schlick.tables`（`lib.rs` 的 `ggx_gen_schlick_tables` 读），在表缓冲里各占一段（`heap::Table::GgxGenSchlickIorS`、`GgxGenSchlickS`）。内核里按 float 读：`pathtrace.wgsl` 的 `lookup_table_fetch(i)`（i 是整个表缓冲里的第几个 float）与 `table_ggx_gen_schlick_ior_s()`、`table_ggx_gen_schlick_s()`（首地址乘 4），给 `../shaders/util.wgsl` 的 `lookup_table_read_3D` 用，对应 Cycles 的 `kernel_data_fetch(lookup_table, …)` 与 `kernel_data.tables.ggx_gen_schlick_*`。不放进常数数组：naga 生成 SPIR-V 时按运行时下标取常数数组，会先把整个数组拷进函数内的临时变量，这两张表放进去之后英伟达显卡上内核编译不出来。能量补偿的两张旧表（1056 个数）照旧在 `../shaders/ggx_tables.wgsl` 的常数数组里，量小没卡住，冻结只许加，没动。

### 物体扩展表 `ObjectExt`（进缓冲）

定义：`shaders/pathtrace.wgsl` 的 `ObjectExt` 与读它的 `object_ext_at(object)`；Rust 一侧 `scene::GpuObjectExt`、`heap::Table::ObjectExt`。每个物体 2 个 vec4（`OBJECT_EXT_VEC4`），与上游的物体表同下标（着色点的 `object`），定长，首地址在 `table_first_ext` 的第 0 格。

单开一张扩展表、而不是放进实例表，是因为软件求交那条路从不返回实例号，每个三角都有的是物体号。

| 格 | 字段 | 类型 | 含义 |
|---|---|---|---|
| 0 | `entity_id` | f32 | 实体编号，**存成浮点数值**（小于 2^24）；0 表示不属于任何实体。整数的位直接进浮点通道会被驱动冲成 0 |
| 0 | `object_flag` | u32 | 物体标志，位照 Cycles 的 `SD_OBJECT_*`（第 3 位：物体是镜像的） |
| 0 | `receiver_light_set` | u32 | 灯光链接：这个物体属于哪个接收者集合 |
| 0 | `lightgroup` | u32 | 这个物体（发光时）属于哪个灯组 |
| 1 | `shadow_terminator_shading_offset`、`shadow_terminator_geometry_offset` | f32 | 阴影终止的两个偏移（平滑网格用） |
| 1 | `reserved0`、`reserved1` | f32 | 预留 |

状态：表已上传（个数等于物体数）。**场景包读入器（`src/pack.rs`）写 `entity_id`（实例表的实体编号）与 `object_flag` 的第 3 位（实例表第四列是 1 的镜像实例），经 `Scene::object_ext` 带进上传；库测试 `mirrored_instances_have_flipped_geometric_normals_and_their_ids` 守着写入。`entity_id` 已落地：辅助样本（`aux_sample`）读它写编号层，`film_write_sample` 读它数覆盖率；`object_flag` 已写未读。** 从场景脚本建的场景这张表仍是全 0（编号层全 0）；其余字段已定义、没有人写非 0 的值。`object_ext_at` 的调用者就是上面两处。各家以后只填自己的格子。运动矢量要的前后两刻变换不放这里，到做运动模糊时另定。

**这张表放不下、也不放的**：阴影链接的集合号，与发光网格的两个 64 位成员集（Cycles 物体记录里的 `light_set_membership`、`shadow_set_membership`、`blocker_shadow_set`）。表里只有接收者集合号与灯组两格，剩下两格 f32 的预留装不下它们，表的长度又是冻结的。做灯的人要用时另开一张表，首地址取 `table_first_ext` 的一个空格并登记。

## 随机维度

### 发生器与取数接口

发生器没有换：打乱索引加 Owen 扰动的 Sobol，上游与 Cycles 的盐值逐个相同。每个决定有一个编号，编号决定它用哪一串随机数；一个编号可以取 1 到 4 维。定下来的是「哪个决定用哪个编号」的办法。

照 Cycles 的取数接口（`shaders/sample.wgsl`），对应 Cycles 的 `path_state_rng_1D` 到 `3D` 与 `path_branched_rng_2D`：

| 函数 | 取法 |
|---|---|
| `path_rng_1D(dimension)`、`path_rng_2D(dimension)`、`path_rng_3D(dimension)` | 编号是 `state.rng_offset + dimension`，像素种子与样本号读路径状态 |
| `path_branched_rng_2D(branch, num_branches, dimension)` | 样本号换成 `state.sample × num_branches + branch`，其余同上 |

- 它们不带状态参数：路径状态是模块级的私有变量，直接读。
- `rng_offset` 初值 `PRNG_BOUNCE_NUM`（16），每弹射一次加 16；介质里散射一次也加。常数在 `shaders/integrator.wgsl`，Rust 一侧 `sample::PRNG_BOUNCE_NUM` 同值。
- 相机的两个决定不加偏移，直接用 `PRNG_FILTER`（0）与 `PRNG_LENS_TIME`（1）。
- 分支版的有效样本数是 65536 除以分支数，超过之后重复同一批点（不偏，但噪声不再降）；换掩码算法的人一并处理。

`path_rng_2D` 与 `path_branched_rng_2D` 现在**已定义、无调用者**（分支版在显卡上对过数）。

### 维度的枚举

数值照 Cycles 的 `PathTraceDimension`。

| 场合 | 名字 | 值 | 取几维 | 状态 |
|---|---|---|---|---|
| 相机（不加偏移） | `PRNG_FILTER` | 0 | 2 | 已落地（像素滤波） |
| | `PRNG_LENS_TIME` | 1 | 3：时刻、镜头 x、镜头 y | 镜头的两维已落地（只在开了景深时取），时刻不用 |
| 每次弹射 | `PRNG_TERMINATE` | 0 | 1 | 已落地（俄罗斯轮盘） |
| | `PRNG_LIGHT` | 1 | 3 | 已定义 |
| | `PRNG_LIGHT_TERMINATE` | 2 | 1 | 已定义 |
| | `PRNG_SURFACE_BSDF` | 3 | 3：前两个定方向，第三个选闭包并复用 | 已落地（移植的闭包用前两个定方向、第三个选闭包；上游顶替不用它） |
| | `PRNG_SURFACE_AO` | 4 | 2，分支版 | 已定义 |
| | `PRNG_SURFACE_BEVEL` | 5 | 2，分支版 | 已定义 |

每次弹射 16 个位置里其余的去向见登记表。

与 Cycles 不一样的两处，都是有意的：

- Cycles 在样本号为 0 时把像素滤波固定在像素中心。这里不照搬：每个样本都抖动。辅助通道另有一条独立的射线，用不着它。
- 发生器和盐值与 Cycles 逐个相同，但索引掩码不同（见上），所以现在的序列与 Cycles 不是逐位相同。

镜头的两个数仍按上游的办法映到圆盘上。

### 三个名字空间

编号进种子之前还要过一次哈希，所以编号本身只要互不相同。三个名字空间按编号的最高两位分开，按构造互不相撞：

| 最高两位 | 谁用 | 编号怎么来 |
|---|---|---|
| 0x（最高位是 0） | 照 Cycles 编号的决定 | `state.rng_offset + PRNG_*`，相机的两个直接用枚举值。数都很小 |
| 10 | `rng_legacy(slot)`：还没有照 Cycles 移植的决定 | `rng_offset + slot` 过一次哈希，取 30 位。`slot` 是上游的槽位 `D_*`，必须小于 16 |
| 11 | `rng_sub(d, k)`：一个决定里再分的子流（循环的第几次、第几盏灯） | 父编号与序号的哈希，30 位 |

- **新写的代码不许用 `rng_legacy`。** 哪个决定照 Cycles 移植完了，就把它的槽位删掉、改用 `PRNG_*`。
- 上游对父编号异或 `0x40000000`、`0x80000000` 派生兄弟流的写法原样保留（它们只当 `rng_sub` 的输入）。
- 介质跟踪用的白噪声（`rng_hash`）的编号都从 `rng_sub` 来，种子与样本号读路径状态。
- 以后移植次表面时要重新核一次：Cycles 的次表面把整个偏移哈希成一个 32 位的数，要确认它不落进后两个名字空间。

上游槽位现在的占用见登记表。

### 像素种子

照 Cycles 的 `path_rng_pixel_init`：像素坐标的二维哈希 `hash_iqnt2d` 异或全局种子（`P.integrator.seed`）。`hash_iqnt2d` 照 Cycles 的 `util/hash.h` 移植，在 `shaders/hash.wgsl`，CPU 上的同一份在 `src/cycles_hash.rs`（这两个文件是 Apache-2.0）。入口是 `rng_start(pix, index, seed, path)`。

### 「互不相同」的保证范围

一条路径上两个决定拿到同一个编号，就是用同一串随机数，结果有偏，而且白炉这类读数看不出来。后两个名字空间里的编号是哈希出来的，互不相同靠枚举来保。

**保证范围就是 `src/sample.rs` 那条枚举测试 `the_dimension_ids_are_distinct` 里登记的区段，不多不少**：

| 登记的区段 | 范围 |
|---|---|
| 弹射 | 0 到 64 |
| 照 Cycles 的位置 | 每次弹射 16 个全算，加相机 2 个 |
| 上游槽位 | 16 个全算（用着的、退役的、空着的） |
| 方向光 | 8 盏 |
| 本地灯逐盏求值 | 64 盏 |
| 本地灯重采样的候选 | 8 个，加灯光瓦片给的候选 16 个 |
| 发光体重采样的候选 | 16 个 |

在这个范围里一共 19,697 个编号，测试断言它们全部互不相同、照 Cycles 的都小于 2^31、三个名字空间的最高两位各是各的。超出区段的序号（比如第 65 盏本地灯）没有枚举过：每一对相撞的概率是 2^-30，没有保证。

**介质跟踪步的白噪声编号只保证同一条射线之内互不相同。** 它们是 `rng_sub` 出来的 30 位哈希编号，挂在每一条阴影射线的编号之下：照上面的区段有 6,240 条阴影射线，每条 4 个介质各 32 步，约八十万个编号，30 位装不下「全部互不相同」。实际枚举过小得多的区段（两万多个编号）就已经有一处跨射线相撞。所以测试对它们只查同一条射线之内（介质 4 个、每个 32 步）；**跨射线相撞是允许的**。这不是换编号带来的：上游的子流编号原来是 31 位，同样没有这个保证。要真正消除它得改上游介质跟踪取白噪声的办法。

**登记的区段比着色器实际允许的范围小的地方**（着色器里这六处都不设上限；超出之后只是没有枚举过）：

| 序号是什么 | 着色器里到多少 | 登记到多少 |
|---|---|---|
| 弹射数 | 主循环到 `P.counts.z`，场景给，没有上限 | 64 |
| 方向光的盏数 | 到 `P.counts2.x` | 8 |
| 本地灯逐盏求值的灯号 | 灯表的下标，到 `P.counts.x` | 64 |
| 灯光瓦片给的候选 | `0x1000 + k`，到候选数加 `P.ltile.w`（离线内核里这一项是 0，走不到） | 16 |
| 发光体重采样的候选 | 到 `P.ltree.w`（离线取 6） | 16 |
| 一条射线穿过的介质个数与跟踪步数 | 介质到 32 个，步数没有上限 | 4 个、32 步 |

其中有一处超出之后是按构造相撞，不只是「没枚举过」：雾里方向光的阴影射线序号是 `0x30 + 第几盏`，第 17 盏起与发光体阴影射线的 `0x40` 重合，第 33 盏起与本地灯的 `0x50` 重合。相撞的是相加的独立估计或白噪声，不会单凭相撞造成偏差，但那几项的噪声不再互相独立。这些都是上游原有的写法，移植灯与体积的人换编号时一并收掉。

**加槽位、加子流、改子流序号的区段，都要同步改那条测试里的登记表**，否则测试管不到。

### 不在这次定的

采样图案只有 Sobol-Burley 一种。表式 Sobol、蓝噪声、每像素序列长度的掩码是降噪与采样那一类工作的事；它们是全局参数和查表，不改这里的形状。

## 输出通道

### 输出缓冲 `film`（进缓冲）

定义：`shaders/film.wgsl`；Rust 一侧 `src/gpu.rs` 的 `FILM_*`、`KernelFilm`、`film_bytes`、`Gpu::film_buffer` 与读回。一块 vec4 的数组，每个像素占 `P.film.film_stride` 个：前面是固定部分，后面是这次渲染请求的灯组。

固定部分 10 格（`FILM_FIXED`），各格的位置两侧各有一份同名常数：

| 位置 | 常数 | 内容 | 取法 | 状态 |
|---|---|---|---|---|
| 0 | `FILM_COMBINED` | rgb 颜色的累加和；w 样本数 | 每个样本累加 | 已落地 |
| 1 | `FILM_DENOISE_ALBEDO` | rgb 降噪用的反照率的累加和；w 不透明度的累加和 | 累加 | 反照率已落地：相机首次命中处的 `surface_shader_denoising_albedo`（移植的闭包照 Cycles 取漫反射类闭包的反照率之和，上游顶替取底色）；不透明度已落地 |
| 2 | `FILM_DENOISE_NORMAL` | xyz 降噪用的法线的累加和；w 覆盖率计数 | 累加 | 法线已落地，但是上游的口径（世界空间；出层时换到 Cycles 降噪特征的相机空间，见下）；覆盖率计数已落地 |
| 3 | `FILM_LEGACY_VARIANCE` | 上游降噪用的两个量：x 亮度的和，y 亮度平方的和 | 累加 | 已落地（上游）。换降噪器时腾出来 |
| 4 | `FILM_LEGACY_EMIT` | 上游 `--signals` 的一组：相机直接看到的光 | 累加 | 已落地（上游，只在开了 `--signals` 时写） |
| 5 | `FILM_LEGACY_SPEC` | 上游 `--signals` 的一组：首次命中处的高光部分 | 累加 | 同上 |
| 6 | `FILM_AUX_DATA` | x 深度，y 实体编号（存成浮点数值），zw 运动矢量 | 辅助样本覆盖写一次 | 深度、编号已落地；运动矢量已定义，恒 0 |
| 7 | `FILM_AUX_NORMAL` | xyz 法线（相机空间，长度 1） | 同上 | 已落地 |
| 8、9 | | 预留 | | 预留 |
| `film_lightgroup_first` 起 | | 第 k 个灯组的 rgb 累加和 | 累加 | 已定义，没有场景走到过 |

**步长的规矩**：

- **步长只许读全局参数**（`P.film.film_stride`；灯组的起点读 `P.film.film_lightgroup_first`）。**任何一侧都不许自己算**，也不许写死数字：内核里步长只在 `film_pixel_first` 一处乘；Rust 一侧读回时按参数里的步长分块。
- **步长不小于 10 加灯组数。** 实际由 `KernelFilm::new` 向上取到 4 的倍数（每个像素的记录对齐到 64 字节）：不请求灯组时是 12，不是 10。这是量出来的：苹果显卡上步长 10、11 的稳态比步长 12、16 慢 5%。末尾多出来的格子没人读写；代价是缓冲大两成，个别分辨率下能请求的灯组数少至多 3 个。
- `FILM_FIXED` 只用来让两侧对数；内核读的是全局参数。

**灯组**：

- 灯组数是这次渲染请求的灯组数，不是场景里的。开渲之前按 `步长 × 16 × 宽 × 高` 算缓冲大小（`film_bytes`），超过显卡单个缓冲绑定的上限就报错，并写明这个分辨率下这次最多能要几组。参考数：英伟达那块显卡上单个缓冲最大 2 GiB，4K 时每像素最多 16 个 vec4，也就是 6 个灯组。
- 输出通道的灯组在代码里统一叫 `lightgroup`。它与上游那个「每 16 盏灯一组的包围球表」（`LIGHT_GROUP`、`light_group_at`）不是一回事。
- 请求灯组：`core-render render-pack --passes` 请求场景包里的全部灯组（组名按在灯清单里第一次出现的次序，下标就是灯记录里的槽位），层文件 `lightgroup-<名>.f32`，通道声明里是 `lightgroup:<名>`；Rust 的入口是 `Params.film = KernelFilm::new(n)`。任务描述里还没有请求灯组的字段。读回在 `Frame.lightgroups`（每组一层，每个像素的均值）。

几条写死的语义（通道的名字、单位、取法照仓库里已经冻结的通道契约，这里只定它们在缓冲里的位置）：

- 深度是相机 Z 方向的平面深度，不是到相机的距离。什么都没打到：编号 0、深度 1e10、法线与运动全 0。
- 深度、编号、法线、运动四个量每个像素取同一个**辅助样本**，不做平均。辅助样本是独立的一条射线：过像素中心、孔径按 0、快门按 0；它不是颜色样本里的某一个，也不计入样本数；不取任何随机数、不调图案节点，两遍必须逐位相同。它在清零之后、第一个颜色样本之前跑，是内核的另一个入口（`aux_sample`），只在要辅助层的变体里有（编译开关 `aux`，见「编号登记表」的「编译开关与入口」）。
- 覆盖率 = 颜色样本里「首次命中的编号（没打到或打到非实体记 0）等于辅助样本的编号」的个数，除以颜色样本数。每个颜色样本在 `film_write_sample` 里拿 `state.first_hit_object` 的实体编号与辅助那一格的编号比，相等就给 `FILM_DENOISE_NORMAL.w` 加 1；读回时除以样本数。只在要辅助层的变体里数（首次命中的物体也只在那里写）：不要辅助层时编出来的颜色样本不读辅助那一格，`FILM_DENOISE_NORMAL.w` 恒 0。
- 不透明度（颜色的 A）：每个样本 1；背景对相机不可见（`background_transparent`）而相机射线什么都没打到时这个样本记 0，颜色也记 0（路上加过的雾不算）。累加在 `FILM_DENOISE_ALBEDO.w`，读回时除以样本数。颜色不除以它（预乘）。
- 辅助样本的实现：`integrator.wgsl` 的入口 `aux_sample`（`@if(aux)`）；`Gpu::render` 要辅助层时从这个入口调度一次，颜色样本仍从 `main` 调度。内核不读 `pass_kind`（Rust 一侧照实填）。相机射线照 `main` 里那一段的式子、像素内取中心、不加镜头偏移；只调 `trace` 与 `shader_setup_from_hit`（几何量），不调材质与图案节点，不取随机数。法线取 `shader_setup_from_hit` 翻过向的着色法线（顶点法线插值；背对来路的面连同几何法线一起翻向相机），变到相机空间：`(N·right, N·up, −N·forward)`。深度是命中距离乘射线方向在相机前方上的分量。
- **降噪特征的法线换坐标系**（出层时做，不在内核里）：内核累加的是世界空间的法线（上游的口径）。Cycles 的降噪特征把法线经 `worldtocamera` 变到它的相机空间再累加（`kernel/film/denoising_passes.h` 第 151 到 153 行）；那个相机空间看向 +Z（同一个文件第 243 行把介质散射处的法线写成视线方向 `(0, 0, −1)`；`kernel/camera/camera.h` 第 165 行景深按 `1 / normalize(Pcamera).z` 算焦平面，前方的 z 是正的）。X 向右、Y 向上是从 Blender 把相机矩阵的 Z 取反后交给 Cycles 推的，本机 Cycles 源码缓存里没有那一段（`blender/camera.cpp`），没有核对。所以 `denoiseNormal` 层是 `(n·right, n·up, n·forward)`，`n` 是世界空间法线的样本均值（不重新归一化，Cycles 也是累加不归一）。它与辅助层 `normal` 的 Z 符号相反，这是有意的：前者照 Cycles 降噪特征，后者照输出通道契约 5.5。
- 灯组的贡献和颜色的贡献是同一个值（夹取之后的），在同一处写。
- Cycles 自己只有深度和编号是首个样本覆盖写，法线和运动是累加再平均；它在背景处写的深度是 0。对拍时那边另渲一遍辅助层并换算，不拿 Cycles 的累加值比。

### 只经 `film_` 开头的函数读写

积分器不直接下标 `film`（库测试查：`film[` 只出现在 `film.wgsl` 里）。

| 函数 | 做什么 | 状态 |
|---|---|---|
| `film_pixel_first()` | 这个像素在 `film` 里的第一个 vec4。步长只在这里乘 | 已落地 |
| `film_add_light(L, bounce, lightgroup)` | 路径上的一次贡献（已乘通量、已夹取）：加进这个样本的颜色；`lightgroup` 不是 `LIGHTGROUP_NONE` 时，同一个值直接加进那个灯组（还要求槽位小于请求的灯组数、值是有限的）。`bounce`：这次贡献出在路径的第几个顶点，现在没人用（留给按直接光、间接光分夹取上限） | 加进颜色的一支已落地。往灯组里写的那一支 1.2.2 起落地：`light.wgsl` 的 `film_add_direct`（逐盏的直接光）、`film_add_forward`（材质采样打中矩形纯光、落进平行光的盘）带灯的槽位；主循环里别的调用（雾、介质、天空、发光三角）照旧传 `LIGHTGROUP_NONE` |
| `film_write_aux(AuxSample)` | 写辅助样本的两格，覆盖写 | 已落地（入口 `aux_sample` 调它） |
| `film_write_sample(SampleResult)` | 样本结束时写其余通道。每个样本调一次。四格先都读出来再写回去（读一格写一格地交替，苹果显卡上稳态慢约 1%） | 已落地 |

`SampleResult`（一个样本的结果）是模块级的私有变量 `film_sample`，随路径推进累加：

| 字段 | 类型 | 含义 | 状态 |
|---|---|---|---|
| `alpha` | f32 | 这个样本的不透明度：1，背景对相机不可见而相机射线没打到表面时 0 | 已落地 |
| `L` | vec3 | 颜色：这条路径上各次贡献之和。只由 `film_add_light` 加 | 已落地 |
| `albedo`、`normal` | vec3 | 降噪用的反照率与法线（反照率见 `FILM_DENOISE_ALBEDO`；法线是上游的口径） | 已落地 |
| `legacy` | `SampleLegacy` | 上游 `--signals` 要的几样 | 已落地，接上正式的通道之后删 |

`AuxSample`：`depth`（f32）、`object_id`（u32，小于 2^24）、`motion`（vec2）、`normal`（vec3）。`motion` 已定义、恒 0，其余已落地。

场景包的三种灯（移植的闭包上，本地灯不超过 `RIS_EXACT` 盏时）逐盏调用 `film_add_light`、逐盏夹取：上游的亮度夹取 `misc.x` 与编译开关 `sample_clamp` 的变体里照 Cycles 口径的 `film_clamp_contribution`，都按每一盏灯的贡献夹（Cycles 的 `film_write_direct_light` 按每条阴影射线夹），灯组与颜色加的是同一个值。上游顶替的闭包、多于 `RIS_EXACT` 盏的本地灯、发光三角与天空的直接光仍是几样的和，在主循环的调用处夹。弹射数照 Cycles 各调用处的口径：直接光用着色点所在的顶点号，路上找到的发光、背景、雾、介质发光、矩形纯光与平行光的盘用那一段射线的顶点号减 1（相机射线是 −1）。

读回与写文件：Rust 读回时按 `FILM_*` 取，除以样本数（辅助两格是覆盖写的原值，不除）。上游的 `--hdr`、图像输出、CPU 降噪读的还是颜色、反照率、法线与两个方差量，结果不变。不透明度进 `Frame::alpha`；要辅助层时（`Gpu::render` 的 `aux`：用编译开关 `aux` 的变体，颜色样本与辅助样本两个管线）辅助层与覆盖率进 `Frame::aux`。`core-render render-pack --passes DIR` 把它们照输出通道契约写成层文件，见 [README.md](README.md)「读场景包」。

## 与 Cycles、与上游不一样的地方

下面这些地方，内核的写法与 Cycles 不一样、与上游不一样，或者做了一个不显然的取舍。各处的原因在对应代码的注释与 [PROVENANCE.md](PROVENANCE.md) 里。

**材质**

1. 闭包的种类字段叫 `kind`：Cycles 里叫 `type`，那是这门着色器语言的保留字。
2. 材质求值是三步加只算透明度的一档，不是一个函数；`shader_setup_from_hit` 往指针里填，不按值返回。
3. 背面的判法沿用上游（点积不小于 0 算背面），不是 Cycles 的（小于 0 才算）。
4. `surface_shader_prepare_closures` 不是空壳：滤光泽之外，上游的 `Lobes` 也在这里算，而且移植的闭包的着色点上也算（上游的灯光函数还读它）。它不收路径状态参数（滤光泽直接读模块级的路径状态）。
5. （1.2.0 起删掉：移植的闭包不再带上游的 0.02 粗糙度下限。）
6. `ShaderInputs` 除了材质的输入，还带三项：`flags`（材质记录的标志原样带过来）、`coat_weight`、`transmission_weight`（只用来判「无清漆、无透射」）。
7. `BsdfSample` 带一个 `weight`（通量的权重）。上游顶替的采样在自己的函数里照上游原样的式子把权重算好，不填 `eval`。
8. （1.2.0 起删掉：微表面闭包的采样照 Cycles 用采样函数自己返回的求值与密度，再并进其余闭包。）
9. `sampled_roughness` 的口径是粗糙度（alpha 的平方根），不是 Cycles 的 alpha：积分器拿它算射线锥与「镜面路径」。
10. 上游顶替专用的求值返回 `{ eval, spec_frac }`，不带概率密度；要密度的地方直接调上游的 `pdf_bsdf`。
11. 直接光每盏灯各采一次、选灯概率按 1（Cycles 按光源树或灯的分布每个点抽一盏），两侧的概率密度都不乘选灯概率：期望相同，噪声更小，逐样本对不上。移植的闭包上逐盏的灯与环境的求值经 `surface_shader_bsdf_eval`，不再多查几何法线（1.2.3 起与 Cycles 相同）；上游顶替的闭包、多于 `RIS_EXACT` 盏的本地灯与发光三角仍经 `surface_shader_bsdf_eval_legacy`，它对移植的闭包另查一次几何法线（Cycles 的求值不查）。环境的光源采样照 Cycles 的开关：场景包那一路（`render-pack`）的世界只有常量颜色、没有入口光，照 `scene/light.cpp:548`（`is_enabled = has_portal || (use_mis && has_surface_spatial_varying)`）整盏关掉，宿主把 `counts2[1]` 写 0，环境只经材质采样逃逸的射线拿到、权重取 1（`src/main.rs` 的 `Job::background_light`）；场景脚本那一路照旧由上游的判法定。
12. 按闭包种类分发的 `bsdf_eval` 收一个闭包，不收整个着色点。
13. `shader_eval_shadow` 收的是命中、方向与距离，不是着色点。
14. 能量补偿对移植的闭包读材质记录的那一位，对上游顶替仍读全局开关。
15. 边缘色按场景特性位决定读不读材质记录。
16. `ShaderInputs.alpha` 只是材质记录里的值，不含贴图的透明度。

**光线负载**

17. 路径状态是模块级的私有变量，不当参数传（Cycles 当参数传）。
18. `legacy` 里有十四项（见「路径状态」）；射线锥不在里面，在 `Ray`。
19. `PATH_RAY_MIS_SKIP` 的设与清留在主循环里，不在 `path_state_next` 里。
20. 路径标志位与可见类是两个枚举，照 Cycles 分开。
21. `Ray` 的两个向量排在最后；相机光线没有单独的函数与文件。
22. `trace_local` 的返回值带一个 `lcg_state`（用过之后的小随机数状态）。
23. 弹射上限、轮盘起始深度、夹取没有接到 `integrator` 块：仍读上游的字段。
24. 射线的起点沿法线挪开（上游的做法；Cycles 不挪，靠「不打中自己」的图元号）。所以凡是要和光源采样一侧配多重重要性采样权重的地方，要用没挪动的着色点，不能用 `ray.P`：它是路径状态的 `mis_origin_P`（1.2.2 起，替掉上游的 `bm_x`、`mis_x`）。阴影射线到灯上那一点为止（不缩短）；材质一侧拿「遮挡物离着色点本身的距离」（`hit.t` 加两个起点之差在方向上的分量）与灯距比，两侧是同一条判法。阴影射线不再沿法线挪开（1.2.3 之后）：照 Cycles 先 `shadow_ray_offset`，再照 `integrate_surface_ray_offset` 决定抬不抬（自交测中不抬，测不中抬 `ray_offset` 的 256 个末位），求交时跳过自己的图元（`light.wgsl` 的 `shadow_ray`，见第 51 条）；过程几何照旧挪开。

**随机维度**

25. `path_rng_*` 不带状态参数；`PRNG_BOUNCE_NUM` 在 `integrator.wgsl`，不在 `sample.wgsl`。
26. `rng_legacy` 的编号是「偏移加槽位」过一次哈希取 30 位、最高两位置成 10；`rng_sub` 的最高两位是 11。
27. 上游的相机与俄罗斯轮盘两个槽位（0 与 2）退役。
28. 「全部编号互不相同」的保证不包括介质跟踪步，登记的区段之外也没有保证（见「互不相同的保证范围」）。
29. `seed` 里放的是哈希之后的用户种子；全局种子与掩码都从 `integrator` 块读，`size.w` 停用。

**输出通道**

30. 固定部分是 10 格，其中两格预留。
31. 步长取到 4 的倍数，不等于 10 加灯组数。
32. 上游的两个方差量从反照率、法线两格的 w 里挪到了第 3 格。
33. 一个样本的结果是模块级的私有变量；`film_add_light` 往它上面加，不直接写颜色那一格。
34. 灯组数没有写死的上限：上限由显卡的单个缓冲大小在开渲前算。
35. 辅助样本是内核的另一个入口（`aux_sample`）的一趟调度，不是颜色样本里的第 0 个；覆盖率只在要辅助层的变体里数。Cycles 自己的深度、编号取首个样本覆盖写，法线累加。
36. 降噪特征的法线在内核里是世界空间，出层时才换到 Cycles 的相机空间。反照率照 Cycles 取首次命中处漫反射类闭包的反照率之和，但不跟反射（Cycles 开着「跟反射」时，光泽闭包的那一份推迟到下一个顶点写），也不按粗糙度加权（见「还没接的」）。

**分文件**

37. 内核的主着色器按阶段分成八个文件，其中体积单独一个；没有单独的相机文件。

**全局参数与表**（1.2.0 加）

38. `integrator.filter_glossy` 与两个夹取上限 `sample_clamp_direct`、`sample_clamp_indirect` 为 0 表示关：Cycles 关着时存浮点最大值（`scene/integrator.cpp:269`、`:311-315`）。全局参数各处零初始化，0 必须等于关；开着时存的与 Cycles 一样：`filter_glossy` 是 1 / blur_glossy，夹取是用户值 × 3（内核比的是三个分量之和，见「全局参数」）。命令行上用户给 0 写 0。
39. Cycles 的查找表都在一个 `lookup_table` 里按偏移读。这里只有广义 Schlick 的两张在表缓冲里按偏移读；能量补偿的两张仍在常数数组里，一维、二维查表函数各有读常数数组与读表缓冲（`_buf`）两份，三维的只读表缓冲。
40. 像素滤波的表放在全局参数末尾的一块（`filter_table`），不在表缓冲里：Cycles 放在 `lookup_table` 里按 `film.filter_table_offset` 读。
41. 盒式宽 1（默认）不查表，像素内均匀抖动，与加像素滤波之前逐位相同。Cycles 的盒式宽 1 也查表，它的表最后一格是 0（`scene/film.cpp` 建表前全 0、对称的一支只写到倒数第二格），查表在最后一段从 1 插回 0；宽 1 时前面 1022 段把随机数的 1022/1023 均匀铺满 [0, 1]，最后一段把余下的 1/1023 反着再铺满一遍，合起来恰好是均匀分布，所以不查表与 Cycles 同分布，只是随机数到偏移的映射不同（`gpu.rs` 的 `KernelFilterTable` 注释同此）。宽度不是 1 时最后一段从表的最大值插回 0，不是均匀的，这一段照 Cycles 保留。别的种类与宽度照 Cycles 查同一张表，判据对的是 Cycles 表给出的分布（见「判据」）。
42. `render-pack` 一路把上游的亮度夹取（`misc.x`，原来是 2^EV × 预设的 `clampIndirect`，电影预设 64、预览 16）关掉（写浮点最大值），只认 Cycles 的两个上限：物理参考是不夹的。上游的场景脚本照旧用 `misc.x`。
43. Cycles 口径的夹取与像素滤波各在一个编译开关后面（`sample_clamp`、`pixel_filter`），不是运行时分支：写成运行时分支时，不开的场景回归有 174 处不同（白炉读数差 1e-11 量级，上游场景的原始输出不同）。
44. 滤光泽只模糊移植的微表面闭包：Cycles 的 `surface_shader_prepare_closures` 对所有 BSDF 闭包都调 `bsdf_blur`（含玻璃、清漆），这里上游顶替的闭包不模糊。场景开着滤光泽时，走上游顶替的材质（带清漆、透射、漫反射粗糙度不为 0 或不透明度小于 1 的，分流条件见「闭包 `Closure`」一节）的光泽一瓣与 Cycles 不同。
45. 凹凸阴影项 `bump_shadowing_term`（Cycles 在 `closure/bsdf.h` 的求值与采样入口都乘它）1.2.1 起照移，凹凸校正标志视为开（场景包里没有这个材质参数，取 Blender 的默认：开）。不一样的地方：Cycles 做在 `bsdf_eval`、`bsdf_sample` 里，这里那两个函数只收一个闭包，所以做在收着色点的一层（求值一侧在 `bsdf_eval_mis_bump_one`，采样一侧在 `surface_shader_bsdf_sample_closure`），式子与乘的次序照 Cycles；同在那两处的阴影终止偏移（`shift_cos_in`）没有移。带法线贴图或材质函数改了法线的材质，漫反射的柔化照 Cycles 做；上游顶替的闭包不走这两处，不乘。

**求交**

46. 软件求交（Compute BVH 回退）的三角形求交是照 Cycles 移植的 `ray_triangle_intersect`（`util/math_intersect.h`，Embree 的 Plücker 边测试，在 `../shaders/util.wgsl`），不是上游的 Möller–Trumbore：上游的那个闭区间、无容差，网格的公共边上两个三角形可能都判不中，相机射线从缝里穿过去。接受的范围照上游（`0 < t < tmax`，与沿法线挪开的起点配套，见第 24 条），不是 Cycles 的 `tmin ≤ t ≤ tmax`。为此三角形缓冲（`tri_verts`，每个三角形 3 行）存三个原顶点，不再存上游的 v0、e1 = b − a、e2 = c − a：Plücker 要原顶点，且公共边两端在两个三角形里要逐位相同，v0 + e1 还原不出来。着色处要边向量时现算 v1 − v0、v2 − v0（与宿主一侧原来算的 b − a 是同一次单精度减法）；硬件求交的 BLAS 直接用原顶点建，不再由 v0 + e1 还原。
47. 平台限制：苹果显卡（Metal）的硬件求交器本身在网格的公共边上漏相机射线。两个三角形的平面、公共边两端在 BLAS 里逐位相同时，英伟达显卡的硬件求交一条不漏，苹果显卡漏得比改之前的软件求交还多（第 2 级「网格的公共边」：64×64、1024 采样、看原点周围约 1 mm 的窄视角下少 65 个像素，最差一个像素少 0.98%，全图均值少 8.1e-5）。内核里修不了，默认的求交照旧走硬件；第 2 级只钉上限（实测数的约 1.5 倍），不断言等于某个数。镜中的矩形纯光一项的平面放在原点，公共边斜穿看的那一小块，读数里带着这一点（在 0.2% 的门内）。

**几何**

48. 场景包那一路的顶点法线照搬 Cycles 内部的存储精度：Cycles 把顶点法线与角法线存成两个 16 位整数的八面体编码（`util/types_normal.h` 的 `packed_normal`，同步时编码：`blender/mesh.cpp:672`、`:765`），渲染静态 BVH 时只被一个物体用的网格把物体变换烘进几何、法线解码后乘逆转置再编码一次（`scene/object.cpp:1172-1238` 的 `apply_static_transforms`，`scene/mesh.cpp:552-585` 的 `Mesh::apply_transform`），着色时用 SIMD 版解码（`packed_normal_decode_simd`，`geom/attribute.h` 的 `attribute_data_fetch_normals`）。轴对齐的法线因此偏开约 2^-16 弧度，低粗糙度的高光对这么大的偏差就敏感。宿主一侧（`src/pack.rs` 的 `kernel_geometry`，函数在 `src/packed_normal.rs`）上传前照这三步过一遍，内核与着色器不动：内核仍存模型空间的法线、按实例矩阵变换，所以烘过的世界空间法线 nw 换回模型空间存（normalize(Lᵀ·nw)，L 是实例矩阵的线性部分），乘回去只差单精度的舍入。位置不烘（照 Cycles 烘进世界空间试过，第 4 级读数没有可见改善）。镜像的行与共用网格的行只编码再解码。场景脚本那一路不变。

**灯**

49. `safe_asinf`（`../shaders/util.wgsl`）不用显卡内建的 `asin`：Cycles 在处理器上调 C 库的 `asinf`，近乎正确舍入，误差在相邻输入之间像随机数；内建 `asin` 的偏差是输入位置的光滑函数（苹果显卡上一段输入里同号地平均偏 0.3 到 2 个末位）。矩形面光的立体角是四个 `asin` 相加抵消出来的，这种偏差进了画面就是一片一片的弧纹，像素抖动平均不掉。改成自己算：|x| ≤ 0.5 用泰勒级数，|x| > 0.5 用 π/2 − 2·asin(√((1 − |x|)/2))，π/2 的低位经 `fma` 并进去。三种写法（内建、级数加半角、`atan2`）对 C 库的段内平均偏差比过，取这一种；函数级比对照旧对 Cycles（`safe_asinf` 一项），另加一项守着这个选择：`safe_asinf_ulp_bias`（`../fncheck/registry.mjs`）在 [1e-6, 1) 上按对数均匀取 100 万组正数，对 C 库 `asinf` 求分段平均偏差（以末位计，每段再按对数等分成小段，取小段平均的绝对值最大者），|x| < 0.5 一段门槛 0.05、0.5 到 0.9 门槛 0.5、0.9 以上门槛 0.2。【实测】苹果显卡上现用的写法三段是 0.007、−0.364、0.100，内建 `asin` 是 1.500、0.709、0.590，`atan2` 是 −1.000、0.484、0.395，去掉 π/2 低位那一步 `fma` 是 0.007、0.720、0.376；负对照「改回内建 `asin`」与「去掉低位那一步 `fma`」都必须判不过（`fncheck.test.mjs`）。

50. 矩形面光（`../shaders/area_light.wgsl` 的 `area_light_rect_sample`）做概率密度 1/S 的那个 S，在远场不用 Cycles 的原式：原式的 S 是四个 `asin` 相加抵消出来的，远场只剩几个末位。Cycles 在处理器上也带着这份单精度偏差，不是像素抖动平均得掉的【实测：Cycles 单精度四项相消的 S 在 96 个抖动平均之后仍偏 +2e-6 到 +4e-6，参考图里带着它】；显卡上偏差更大、形状不同（随位置光滑变化，第 4 级低粗糙度高光的暗区出 ±7e-5 的弧纹）。参考一侧的这份偏差不进内核、不改门，远场暗地板帧因它留下的残差记为已知缺口。远场（原式的 S 不小于 5e-5，且四个角从着色点看两两夹角小于 90°）改用 Van Oosterom–Strackee 的两个三角形（`rect_solid_angle_pdf_S`；三重积在灯的局部坐标里就是 |z0|·len_u·len_v，分母四项同号），带「两个分母都大于 0」的守卫（在前面「四个角两两点积都是正的」判断成立时恒真，现在走不到，留着防以后放宽点积判断）；近场与 S 小于 5e-5 照旧用原式。采样映射与「S 小于 1e-5 退到平面」的判断不变，照旧用原式的 S。阈值扫过 1e-5、5e-5、2e-4、1e-3 定的（第 4 级 r006、r013 的低粗糙度高光：阴影射线改成跳过自己之前，光面掠过地板那一帧 Welch 显著比例 2.1e-2、1.4e-2、1.5e-2、1.6e-2；之后在 r006 四个取值点上 1e-5 多一帧不过，5e-5 与 2e-4 互有高低，都不过的是同样的三帧）。函数级比对：远场一项比双精度里照原式算的真值，近场一项（两个三角形之一大于 π）比单精度的 Cycles。

51. 阴影射线的起点与跳过自己（直接光逐盏的灯与环境一支；材质采样继续弹射的射线、发光三角与上游顶替那一路照旧沿法线挪开）照 Cycles：`shadow_ray_offset` 之后，跳过自己时照 `integrate_surface_ray_offset`（`kernel/integrator/shade_surface.h:42-93`）从着色点沿射线方向对自己的三角形做自交测试，测中不抬、测不中抬 `ray_offset`（`kernel/bvh/util.h:70`）；方向与距离从 `shadow_ray_offset` 挪过的点算，不跟着抬改。求交时跳过自己的图元：不改 `trace` 的签名，要跳过的（全局三角下标, 实例记录）放在 `intersect.wgsl` 的私有变量 `trace_self` 里，`shadow_ray_vis`、`shadow_ray_sky` 测前设、测完清。软件求交在叶子里跳过它。硬件求交（`trace_hw.wgsl` 的 `trace_opaque`）强制不透明、遍历器不报三角形的候选，没法在候选里跳过；改成同一个查询语句里再查：最近命中是自己时从它的距离往后的下一个 f32 再查一次；任意命中先找到自己时，先查它之前、再查它之后。与 Cycles 不一样的地方：恰好与自己同一个距离上的别的面跟着被跳过（Cycles 留着它）。经实例放置的三角形，自交测试在模型空间做（射线照实例记录的逆矩阵行 `proc_point`、`proc_dir` 变过去，与硬件求交同一个空间）。Cycles 的注释说这一步要求「物体的逆变换与求交用的逐位相同」；硬件求交用的是驱动从实例矩阵自己求的逆（`world_to_object`），与宿主一侧算的逆矩阵行不保证逐位相同，这一处差异留着，实测影响见第 52 条。过程几何的一个图元是一整个形体，跳过它就没了自己投在自己身上的影子，所以照旧沿几何法线挪开、不跳过。

52. 着色点的位置（`shaders/shader.wgsl` 的 `shader_setup_from_hit`）在三角形上照 Cycles 的 `triangle_point_from_uv`（`kernel/geom/triangle_intersect.h:123-143`）用命中的重心坐标重建：`tri_a + u·(tri_b − tri_a) + v·(tri_c − tri_a)`，在顶点所在的空间里算；软件求交的三角形已经铺进世界空间，直接得世界坐标，硬件求交的模型实例在模型空间算完再乘实例矩阵（`inst_vec` 加平移，即 Cycles 没把变换烘进几何时的 `transform_point`）。上游原来取 `o + d·t`，点离开三角形所在平面一个舍入量级，第 51 条的自交测试「测中不抬」就失了前提（Cycles 的 `integrate_surface_ray_offset` 以重建的点为前提）。继续弹射的射线、AO 与上游顶替那一路的起点都从这个点挪开，跟着变（挪法不变）；过程几何照旧取 `o + d·t`。硬件求交那条路自交测试的模型空间变换（第 51 条，宿主一侧的逆矩阵行）与驱动求交用的 `world_to_object` 不保证逐位相同，没有统一（驱动的逆在命中时可以从已确定的命中取到 `world_to_object`，没有带进着色点）；【实测】苹果显卡上把自交测试改在世界空间做（顶点乘实例矩阵、射线不变）对照，第 4 级 r006 的 k1、k10 六帧 Welch 显著比例逐位相同，HDR-FLIP 平均值三帧相同、三帧相对差不到 1.2e-5，场景包的地板实例是 x、z 各放大 2.5 倍，逆矩阵里有不能精确表示的 0.4。

53. 矩形面光采样映射（`../shaders/area_light.wgsl` 的 `area_light_rect_sample`，`kernel/light/area.h:67`）里的 `cos(au)`、`sin(au)` 不用显卡内建，改调 `../shaders/util.wgsl` 的 `sincosf`，理由同第 49 条：Cycles 在处理器上调 C 库的 `sinf`、`cosf`，近乎正确舍入；内建的偏差随输入位置光滑变化、一段里同号，采样点整片同号地挪，像素抖动平均不掉。`sincosf` 是教科书的写法：Cody–Waite 两段约简 x = k·π/2 + rh + rl（π/2 拆单精度高低两位，rh 经 `fma` 精确），|rh| ≤ π/4 上 sin 的泰勒级数到 r¹³、cos 到 r¹²，低位 rl 当一阶修正、在最后一次舍入之前并进去，再按象限换位变号；只为 |x| 不过几个 π 的输入（au 在 (−π, π)）。误差形状对 C 库量过（苹果显卡，100 万组，[1e-6, π) 按对数均匀取，分段平均偏差以末位计，sin / cos）：现用的写法三段（[1e-6, 0.5)、[0.5, 1.5)、[1.5, π)）是 −0.034 / −0.001、0.030 / −0.033、−0.030 / −0.016，逐组最大相对误差 1.2e-7（一个末位）；低位先并进约简结果的写法是 −0.034 / −0.002、0.099 / 0.166、0.115 / 0.248（约简结果落在 x 的末位网格上，加低位的舍入对一段输入是同一个量）；先把 cos 舍入成单精度再减修正量的写法在 [0.5, 1.5) 的 sin 偏 −0.30（修正量不到一个末位、整段被同一个方向舍掉）；内建 `sin`、`cos` 是 −0.399 / 0.688、0.202 / −0.216、0.153 / 0.139。函数级比对加三项：`sincosf`（逐组对 C 库，[−3.5, 3.5]）、`sinf_ulp_bias`、`cosf_ulp_bias`（分段平均偏差，三段门槛都是 0.1）；负对照「改回内建 `sin`、`cos`」两项分段平均偏差必须都判不过（`fncheck.test.mjs`）。同一个文件与 `light.wgsl` 里别的内建三角函数（点光与平行光圆盘采样经 `polar_to_cartesian`、远场立体角的 `atan2`、环境与场景脚本那一路的采样方向）这一处没有改；其中 `polar_to_cartesian` 后来也改调 `sincosf`（同心圆映射给平行光的锥、点光与面光的圆盘、GGX 可见法线采样取点，phi 在 [−π/4, 3π/4]）：【实测】第 4 级平行光照抛光金属那一个取值点，苹果显卡对参考的 Welch 读数由 1.1e-3 降到 0，英伟达上不变。

54. GGX 两处求值（`../shaders/microfacet.wgsl` 的 `bsdf_microfacet_eval_ggx`、`bsdf_microfacet_eval_ggx_generalized_schlick`，`kernel/closure/bsdf_microfacet.h:726`）里半向量的 1/|H| 不照原式写成 `safe_divide(1.0, len_ccl(H))`，改调 `../shaders/util.wgsl` 的 `inverse_len`：内建 `inverseSqrt` 再做一次牛顿迭代 y ← y + y/2·(1 − |H|²·y²)，两步都经 `fma`，|H| 为零时给 0。理由：Cycles 在处理器上 `sqrtf` 与除法都正确舍入，误差在相邻输入之间像随机数；显卡上照原式写，1/sqrt 被编成近似指令，偏向一边。`bsdf_D_ggx` 的 1 − cos_NH² 在半向量贴近法线时相消，cos_NH 的偏差被放大约 4/alpha² 倍（alpha = 0.017 时峰顶一个末位是高光亮度的 8e-4），抛光金属的高光整片同号地偏，像素抖动平均不掉：第 4 级平行光照抛光金属那一个取值点，英伟达上照原式写判不过（系统性偏暗约 3.6e-4），改了之后判过，苹果显卡对英伟达的差别也消失。逐组比查不出（alpha 小于 0.1 时 cos_NH 差一两个末位就超过 1e-4），函数级比对加两项守着：`bsdf_microfacet_eval_ggx_peak_bias`、`bsdf_microfacet_eval_ggx_generalized_schlick_peak_bias`（`../fncheck/registry.mjs`），alpha 在 [0.005, 0.1) 按对数均匀取、半向量与法线的夹角在 0 到 2·alpha 的球冠上按面积均匀取，100 万组，把两边概率密度的相对差除以 d ln D/dcos 折回 cos_NH，以 1 以下的末位计，alpha 分 4 小段求平均，门槛 0.03。量取 cos_NH 而不取 D：根源在它，D 的末位随 alpha 放大的倍数不同，做不了一个统一的门槛；单看 1/|H| 又漏掉 H = wi + wo 与 dot(N, H) 两步。【实测】（种子 1，小段平均的绝对值最大者，F82 / 广义 Schlick）现用的写法苹果显卡 −0.001 / 0.005、英伟达 RTX 5090 −0.002 / 0.005；原式苹果显卡 0.048 / 0.052、英伟达 −0.089 / −0.089；内建 `inverseSqrt` 不加迭代与 `1.0 / sqrt` 两台上都与原式相同到小数第三位；结果再偏半个末位是 ±1.51。负对照「改回原式」与「偏半个末位」两台都必须判不过（`fncheck.test.mjs`）。同类写法（由 1/len 或 `normalize` 得到方向、再进贴近 1 的余弦与 1 − cos² 一类相消）别处没有改：可见法线采样的两次 `normalize_ccl` 在采样一侧，求值与概率密度同乘 D、比值约掉；`bsdf_lambda_ggx` 的 1/cos² − 1 在正入射附近相消，但 λ 很小、只进 1 + λ；点光、面光与 `make_orthonormals` 的归一化不进相消；着色法线用的内建 `normalize`（`shaders/shader.wgsl`）是同一类，量过确实偏，改了，见第 55 条；相机射线方向的内建 `normalize`（`shaders/integrator.wgsl`）没有改：H = wi + wo，wo 的长度误差在镜面峰上一阶相消（H ∥ N 时 cos_NH 对 |wo| 的偏导为 0），不被 1 − cos_NH² 放大。

55. 着色法线的单位化不用内建 `normalize`，改调 `../shaders/util.wgsl` 新加的 `normalize_unbiased`（乘第 54 条的 `inverse_len`；长度为零时给零向量）：`shaders/shader.wgsl` 里插值法线（`shader_setup_from_hit`、`mat_in_at`、`surface`，以及给材质函数的 `nv`）、法线贴图（`surface` 里的 `pn`、`tangent_normal`）共六处。理由：|N| 的偏差原样进 cos_NH = dot(N, H)（cos_NH 对 |N| 的偏导约等于 1），经 `bsdf_D_ggx` 的 1 − cos_NH² 放大的倍数与第 54 条的 1/|H| 相同，曲面网格（平滑法线）上的抛光金属会整片同号地偏；平面上法线本来精确，第 4 级那个取值点查不出它。Cycles 的 `triangle_smooth_normal`（`kernel/geom/triangle.h:162`）在处理器上用 `safe_normalize`，正确舍入。函数级比对加一项守着：`normalize_unbiased_len_bias`（`../fncheck/registry.mjs`），对 `safe_normalize` 量 |N| − 1 的平均偏差，以 1 以下的末位计（与第 54 条 cos_NH 的单位相同），方向在整个球面上均匀、长度在 [0.25, 4) 按对数均匀取、分 4 小段，100 万组，门槛 0.03，逐组照常比。【实测】（种子 1，小段平均的绝对值最大者）现用的写法苹果显卡 −0.004、英伟达 RTX 5090 −0.005；内建 `normalize` 苹果显卡 0.050、英伟达 −0.094；`a / len_ccl(a)`（`normalize_ccl` 的式子）0.048、−0.095。负对照「改回内建 `normalize`」两台都必须判不过（`fncheck.test.mjs`）。没有改的：几何法线（`normalize(cross(e1, e2))`）只用来判正反面、换法线的门槛与射线起点，不进 cos_NH；切线不进各向同性的闭包；`ensure_valid_specular_reflection`（`../shaders/microfacet.wgsl`）拧法线的那一支照 Cycles 的式子（`safe_normalize_fallback` 与 Nx·X + Nz·Ng），只在镜面反射方向落到几何面以下时走，结果离着色法线有一个角度，不在镜面峰贴着法线的那一段；过程几何与材质函数返回的法线由各自的代码给出。

## 编号登记表

**要新号向核心帧源的负责人要；改登记表不算变更。** 拿到号之后：在这里登记，在着色器（与 Rust 一侧）加常数，运行 `freeze.mjs --update` 把新常数补进冻结标记。

### 闭包种类号（`Closure.kind`）

名字照 Cycles，数值是内核自己的。往后追加，已有的数值不改。库测试 `the_closure_kinds_keep_their_numbers` 是快照。

| 号 | 名字 | 状态 | 给谁 |
|---|---|---|---|
| 0 | `CLOSURE_NONE` | 已落地 | |
| 1 | `CLOSURE_LEGACY` | 已落地 | 上游顶替，闭包移植完后删（号不回收） |
| 2 | `CLOSURE_BSDF_MICROFACET_GGX` | 已落地（只接了 F82 菲涅耳、各向同性） | 移植闭包 |
| 3 | `CLOSURE_BSDF_DIFFUSE` | 已定义 | 移植闭包 |
| 4 | `CLOSURE_BSDF_TRANSPARENT` | 已定义 | 移植闭包 |
| 5 起 | | 空闲 | |

### 材质 `flags` 的位（`Material.flags`）

两侧同名（`scene::MATERIAL_FLAG_*`），库测试逐个比数值。

| 位 | 名字 | 状态 | 给谁 |
|---|---|---|---|
| 0 | `MATERIAL_FLAG_MULTISCATTER` | 已落地 | 微表面做多重散射的能量补偿 |
| 1 | `MATERIAL_FLAG_NO_LEGACY_FUNCTION` | 已定义 | 不走上游的材质函数（图案节点、节点图编译器） |
| 2 到 7 | | 空闲 | |
| 8 到 11 | `MATERIAL_FLAG_CLASS_SHIFT`、`MATERIAL_FLAG_CLASS_MASK` | 已定义，恒 0 | 闭包大类：`MATERIAL_CLASS_SURFACE`（0）、`MATERIAL_CLASS_EMISSION`（1）、`MATERIAL_CLASS_TRANSPARENT`（2）、`MATERIAL_CLASS_TOON`（3）；4 到 15 空闲 |
| 12 到 31 | | 空闲 | |

材质记录的预留格：第 20 到 25 格，共 6 个 vec4，都空着。

### 每次弹射的随机维度（`state.rng_offset` 加这个数）

| 位置 | 名字 | 状态 | 给谁 |
|---|---|---|---|
| 0 | `PRNG_TERMINATE` | 已占，已落地 | 俄罗斯轮盘 |
| 1 | `PRNG_LIGHT` | 已占，已定义 | 做灯 |
| 2 | `PRNG_LIGHT_TERMINATE` | 已占，已定义 | 做灯 |
| 3 | `PRNG_SURFACE_BSDF` | 已占，已落地 | 表面散射 |
| 4 | `PRNG_SURFACE_AO` | 已占，已定义 | 图案节点 |
| 5 | `PRNG_SURFACE_BEVEL` | 已占，已定义 | 图案节点 |
| 6 | | 不许用 | Cycles 给了路径引导，这里不做，也不另作他用 |
| 7、8、9 | | 空闲，取用须登记 | |
| 10、11 | | 不许用 | 同第 6 个 |
| 12 到 15 | | 空闲，取用须登记 | |

Cycles 的体积散射与表面复用 3 到 9 这一段（同一次弹射要么是表面要么是体积）；移植体积的人照 Cycles 的 `PRNG_VOLUME_*` 取，不另占位置。次表面不占这里。

相机的两个（不加偏移）：0 `PRNG_FILTER`，1 `PRNG_LENS_TIME`。

上游槽位（`rng_legacy` 的参数；新代码不许用，只减不增）：

| 槽位 | 名字 | 决定 |
|---|---|---|
| 0 | | 退役（相机，改用 `PRNG_FILTER`、`PRNG_LENS_TIME`），不再给别的决定用 |
| 1 | `D_BSDF` | 上游顶替闭包的选瓣与方向 |
| 2 | | 退役（俄罗斯轮盘，改用 `PRNG_TERMINATE`），不再给别的决定用 |
| 3 | `D_PICK` | 选哪一类灯 |
| 4、5 | `D_SUN`、`D_SUN_VIS` | 方向光与它的阴影射线 |
| 6 | `D_LOCAL` | 本地灯 |
| 7、8 | `D_EMIT`、`D_EMIT_VIS` | 发光体与它的阴影射线 |
| 9、10 | `D_ENV`、`D_ENV_VIS` | 环境光与它的阴影射线 |
| 11 | `D_FOG` | 高度雾的内散射 |
| 12 | `D_MEDIA` | 有界介质的跟踪 |
| 13 | `D_PHASE` | 介质里散射的方向 |
| 14 | `D_VOL_LIGHT` | 介质里一点上的灯 |
| 15 | | 空着 |

子流序号的区段登记在 `src/sample.rs` 的 `the_dimension_ids_are_distinct` 里（见「互不相同的保证范围」）。

### 全局参数的追加块（`Params` 末尾）

| 块 | 长度 | 主人 | 块里空着的 |
|---|---|---|---|
| `integrator` | 4 个 vec4 | 核心帧源 | 没有空位（16 个字段都起了名） |
| `film` | 1 个 vec4 | 核心帧源 | `reserved` 一格 |
| `table_first_ext` | 2 个 vec4 | 核心帧源 | 见下一张表 |
| `filter_table` | 257 个 vec4（1.2.0 加） | 核心帧源（成像） | `reserved0`、`reserved1`、`reserved2` 三格 |

再要加东西：在末尾追加自己命名的一整块，在这里登记块名与主人。上游的 `size.w` 是停用后的预留格。

### 新表首地址的 8 格（`Params.table_first_ext`）

| 格 | 去向 | 状态 |
|---|---|---|
| `[0].x` | 物体扩展表 | 已落地（表全 0） |
| `[0].y` | 图案节点表 | 已定义，0 |
| `[0].z`、`[0].w` | 广义 Schlick 的两张反照率表（`table_ggx_gen_schlick_ior_s`、`table_ggx_gen_schlick_s`） | 已落地（`lookup_table_read_3D` 读） |
| `[1].x` 到 `[1].w` | | 空闲 |

### 输出缓冲的各格（`film` 每个像素的固定部分）

| 格 | 名字 | 状态 |
|---|---|---|
| 0 | `FILM_COMBINED` | 已落地 |
| 1 | `FILM_DENOISE_ALBEDO` | rgb 已落地；w（不透明度）已落地 |
| 2 | `FILM_DENOISE_NORMAL` | xyz 已落地；w（覆盖率计数）已落地 |
| 3 | `FILM_LEGACY_VARIANCE` | 已落地（上游）；zw 空着。换降噪器时整格改标预留 |
| 4 | `FILM_LEGACY_EMIT` | 已落地（上游）；w 空着。接上正式通道后改标预留 |
| 5 | `FILM_LEGACY_SPEC` | 同上 |
| 6 | `FILM_AUX_DATA` | xy 已落地；zw（运动矢量）已定义 |
| 7 | `FILM_AUX_NORMAL` | xyz 已落地；w 空着 |
| 8、9 | | 预留 |
| 10 起 | 灯组，每组一格 | 已定义 |

### 编译开关与入口

内核的条件翻译开关（`@if`，`src/gpu.rs` 的 `KernelVariant::flags`，`pathtrace.wgsl` 开头有一份说明）与计算入口。开关名、入口名两侧各写一处（入口名在 `src/gpu.rs` 的 `COLOR_ENTRY`、`AUX_ENTRY`），库测试 `the_aux_switch_is_only_the_aux_layers` 查入口与开关的对应。

| 名字 | 种类 | 状态 | 给谁 |
|---|---|---|---|
| `hwrt`、`strict`、`cutout_lite`、`cutout_lite2`、`last_direct`、`last_sun`、`light_pick`、`merged`、`uniform_tables`、`whole_tables`、`guard` | 开关 | 已落地（上游） | 显卡与布局 |
| `aux` | 开关 | 已落地（1.1.0 加） | 输出通道：这次渲染要辅助层。开了多一个入口 `aux_sample`，颜色样本写首次命中的物体、数覆盖率；关着时颜色内核里没有这几样。由 `Gpu::render` 的 `aux` 决定，不是显卡的开关 |
| `pixel_filter` | 开关 | 已落地（1.2.0 加） | 成像：这次渲染查像素滤波表。开了相机射线的像素内偏移经 `filter_table_read` 查全局参数的 `filter_table`；关着时偏移就是像素滤波的两个随机数本身（盒式宽 1），内核与加这个开关之前逐字相同。由 `FilmSwitches::of` 按 `filter_table.use_filter_table` 决定 |
| `sample_clamp` | 开关 | 已落地（1.2.0 加） | 成像：这次渲染照 Cycles 的口径夹取。开了每次贡献经 `film_clamp_contribution`；关着时只有上游的亮度夹取，内核与加这个开关之前逐字相同。由 `FilmSwitches::of` 按 `integrator` 的两个夹取上限有没有一个不是 0 决定 |
| `main` | 入口 | 已落地（上游） | 颜色样本，每个变体都有 |
| `aux_sample` | 入口 | 已落地（1.1.0 加），只在 `aux` 的变体里 | 输出通道：辅助样本 |

再加开关或入口：先登记在这里，再加进 `KernelVariant::flags`（或两侧的入口名常数），并把它带进 `every_kernel_variant_generates_spirv_and_msl`。

### 场景特性位

内核按场景用到的功能编出不同的变体（上游的办法，`FEAT` 的各位）。北冥加的一位：`F_SPECULAR_TINT`（第 28 位），见「材质记录」。两侧同名，库测试 `feature_bits_are_distinct` 查各位互不相同、两侧同值。

### 不靠机器、靠人复核的

- `legacy` 的例外清单（哪些地方还在读上游的结构）是注释里的一张表，没有机器检查。
- 「新写的代码不许用 `rng_legacy`」「新写的代码里只有 `shader_eval_inputs` 读材质记录」「进函数级比对的函数签名只收标量与向量」靠复核把关。
- **条文登记表里写的数。** 机器只查条文提到了冻结标记钉住的每个名字，不查表里写的号与代码里的数值是不是同一个：只把上面登记表里的某个号改错（比如把一个闭包种类号写成另一个数），三道检查都过。改登记表的人自己对一遍着色器里的常数，复核的人再对一遍；两处对不上时以代码与冻结标记为准。
- **只有冻结标记这一道守着的**：上游槽位 `D_*` 的数值、路径标志位（本机没有 Cycles 源码缓存时）、冻结了签名的函数的参数表。它们改了之后库测试照过，红的只有 `freeze.mjs` 与它的测试；所以 `--update` 之前先看清标记的差异里有没有不是自己想改的行。
- 位置式构造的那条测试是文本匹配，不是语法树：给结构起别名再按位置构造，它认不出来。
- 查写入语句的两条测试同样是文本匹配：把一处「已写未读」的写入包进永不成立的分支，语句还在，测试照过。
- **内核里的几处修法只有第 2 级拦得住，CI 里看不见。** 矩形纯光命中一侧用的那个没挪动的着色点的写入（`state.mis_origin_P = sd.P`）、遮挡距离加上两个起点之差的那一处、移植的闭包只在采到方向（概率密度不为 0）时才算权重的那个判断（`surface_shader_bsdf_sample_closure` 里的 `if (m.pdf != 0.0)`）：删掉或改回去，冻结检查、不用显卡的库测试、CI 全过，只有第 2 级（`../chassis/level2.mjs`，要显卡，只在本机跑）的解析场景与负对照会不过。改积分主循环、闭包采样、灯的人，每次都在本机跑一遍第 2 级；复核的人看差异时对着这三处看一眼。

## 锁

改了这四样而没同步，下面的检查会红。

| 检查 | 在哪 | 守什么 |
|---|---|---|
| `freeze.mjs` | `../chassis/freeze.mjs`，测试 `../chassis/freeze.test.mjs` | 冻结标记在；标记钉住的结构定义、常数、函数签名与着色器一致；登记类的编号都进了标记（扫内核 `shaders/` 下的全部着色器加共用目录里编进内核的五个着色器，标记没钉住的文件里声明了这类常数也算不一致；声明不写类型、前面带属性、写在一行里的第二个、写在函数里面，都认）；条文提到了标记钉住的每个名字 |
| `the_material_record_is_the_kernels` | `src/merged.rs` | `Material` 两侧逐字段同名、同偏移、同总长度（合并布局的那一份也比）；`flags` 各位两侧同值；默认值；能量补偿位的写法 |
| `the_parameters_are_the_kernels` | `src/merged.rs` | `Params`、`KernelIntegrator`、`KernelFilm`、`ObjectExt` 两侧逐字段同名、同偏移、同总长度；种子是哈希后的值；步长取整的规矩 |
| `the_film_layout_is_the_kernels` | `src/merged.rs` | `FILM_*` 两侧同值；`film` 只在 `film.wgsl` 里下标；步长只在一处乘；缓冲大小的算法与报错 |
| `the_closure_kinds_keep_their_numbers` | `src/merged.rs` | 闭包种类号的快照：已有的数值不变，新种类要先登记 |
| `the_bounce_stride_is_the_kernels` | `src/merged.rs` | `PRNG_BOUNCE_NUM` 两侧同值 |
| `call_structs_are_not_built_by_position` | `src/merged.rs` | 只活在一次调用里的结构没有位置式构造（先去掉注释再查；名字与括号之间有空白、换行、注释都认）。名单在测试里，新加这类结构要补 |
| `closures_are_indexed_by_constants` | `src/merged.rs` | 着色点的闭包数组没有按变量下标的读写（先去掉注释再查；`.closure[` 后面不是纯数字就算） |
| `every_kernel_variant_generates_spirv_and_msl` | `src/gpu.rs` | 内核的 120 个变体都过 SPIR-V 与 MSL 两个后端的代码生成（每个入口都生成）。120 个是：8 组编译开关（默认、六个取值各单开一个、全开）乘缓冲布局（软件求交 9 种、硬件求交 6 种，其中要辅助层的 `aux` 软件求交 3 种、硬件求交 2 种；成像的 `pixel_filter`、`sample_clamp` 与 `aux` 一起开的一种，软件、硬件各一）。**不是开关的全部组合** |
| `the_aux_switch_is_only_the_aux_layers` | `src/gpu.rs` | 编译开关 `aux` 管的东西：开了入口是 `aux_sample` 与 `main` 两个，关着只有 `main`；关着的变体里没有辅助样本、首次命中物体的写入、读辅助那一格；两种变体都不读 `pass_kind` |
| `path_state_is_written` | `src/gpu.rs` | `PathState`、`Ray` 的字段名单；路径状态里「已写未读」各项的写入语句都在，先去掉注释再按出现次数查（同一句有两处的，删掉一处也红；注释掉不算在） |
| `shading_point_is_written` | `src/gpu.rs` | `ShadingPoint`、`Closure`、`ShaderInputs` 的字段名单；它们与 `Ray` 里「已写未读」各项的写入语句都在，先去掉注释再按出现次数查 |
| `the_dimension_ids_are_distinct` | `src/sample.rs` | 随机编号在登记的区段里互不相同（范围见上） |
| `the_shader_is_this` | `src/sample.rs` | 取数接口在显卡上的数与 CPU 上的镜像相同（要显卡） |
| `requested_lightgroups_leave_the_picture_alone` | `src/gpu.rs` | 请求灯组不改变画面，读回的灯组层数对（要显卡） |
| 照 Cycles 取值的常数 | `../chassis/freeze.test.mjs` | 路径标志位与可见类、随机维度的枚举与 `PRNG_BOUNCE_NUM`（两侧）、菲涅耳种类、两个着色点标志、采样标签，与 Cycles 头文件里的同名枚举逐个相等。**本机有 Cycles 源码缓存时才比，没有就跳过** |

**这些检查在哪里跑**：CI 里没有 Rust 工具链，也没有显卡。上表里 CI 跑得到的只有第一行（`freeze.test.mjs` 在全仓库的测试里），最后一行在 CI 上没有 Cycles 源码缓存、会跳过。其余 14 条库测试只在本机跑：`cargo test --locked`，或回归工具 `regress.mjs --check`（它把库测试的通过数与基线比，少了算不同）。所以改内核的人每一步都要在本机跑一遍，不能等 CI 报。

两条静态测试（`path_state_is_written`、`shading_point_is_written`）查的是写入语句在不在，不是运行时的值：语句还在、却包进永不成立的分支（`if (false) { … }`），它们认不出来。「已写未读」的字段运行时的值对不对，要等读它的人接上之后由读数来验。

## 判据

**默认：渲染结果不变。** 改这四样结构、或改内核的组织法，要求两台机器（苹果显卡与英伟达显卡）上回归基线逐位相同：

```sh
node beiming/sources/core/chassis/regress.mjs --check   # 第 2 级 24 个读数逐位相等；上游渲染测试的原始输出逐字节相同；库测试不少过
node beiming/sources/core/chassis/level2.mjs            # 对 Cycles 的读数、解析值、负对照、确定性
```

**做不到逐位相等时**：先把改动再拆小，找出引起变化的那一处；确认只是运算次序变化之后，这一处按下面的统计判据过，在提交说明里记下是哪一处、哪台机器。不许因此放宽别处。

**允许像素末位变化的比较**（有意改变结果的改动，或上一条），四条都要过：

1. 第 2 级的 24 个读数在门内；不是换随机数的改动，改前改后的相对差不超过 1e-6。
2. 固定一组种子的均值，改前改后的差不超过 3 个合成标准误（两侧标准误平方和开方）。
3. 每张图（默认种子）：全图均值的相对差不超过 1e-6；超过 1e-5 的像素不超过全图像素的千分之一。换别的种子时个别场景的均值相对差会略过 1e-6（量到过 1.5e-6），那时按第 2 条的多种子均值判。
4. 超过 1e-5 的像素要有交代：换种子后位置不固定，或者在改之前的程序里加一个末位的扰动能在同样的位置复现。

不设「最大像素相对差」这样的逐像素上界：路径追踪里有硬边（灯的边沿、物体轮廓、分支判断），只要允许末位变化，个别像素打中与没打中就会翻。

**用统计判据的地方，种子至少 32 个。** 8 个种子估出来的标准误尾巴很重：落地过程中出现过三次「差 3.5 到 4.6 个标准误」，加种子（64 个）重判都回到 1 以内。遇到落在 3 到 5 个标准误之间的，先加种子，别急着找原因。

**电介质与混合白炉**（1.2.0 加）：底色 1 的原理化 BSDF 球，金属度 0 的粗糙度 0、0.1 … 1.0 共 11 档，金属度 0.5 的粗糙度 0.2、0.5、0.8 三档，开能量补偿、弹射上限 128；对 Cycles（`../chassis/cycles-furnace-principled.json`，Blender 5.2.3 处理器渲染，做法同金属白炉，出读数之前用同一脚本重出金属白炉粗糙度 0.5 与原读数逐位相同）每球 ±0.5%，门同金属白炉。这一组读数都在 1 附近（Cycles 的层间权重本来就近乎守恒），±0.5% 的门分辨不出小的接线错，那一类由函数级比对与负对照守。**Pharr 自发光球**（1.2.0 加）：相机在解析球里面，球面反照率 0.5、自发光 0.5 的朗伯面，处处趋近 1；判法同下面的解析场景。

**第 2 级解析场景的判法**（矩形纯光照漫反射平面，正对、斜向、近灯、灯后有板四种几何；种子 1 到 32、每个 4096 采样）：像素均值对解析值的相对差在 **0.2% 以内，且在 3 个标准误或相对 2e-6 以内**（`level2.mjs` 的 `GATES` 与 `analyticOk`）。靠后一半那条底才过的读数，工具的输出里会打一行提示。

后一半那条「相对 2e-6」是数值精度的底，来历照实写在这里：

- 正对、斜向两个读数曾经对解析值有固定的偏离（正对高百万分之二点五，两块显卡都有）。它**不是数值精度**：光源采样一侧从着色点本身算矩形灯，材质采样一侧打到矩形灯时却从沿法线挪开之后的射线起点算，两侧的多重重要性采样权重配不平，估计量有偏。偏离随「挪开的距离 ÷ 灯距」放大，灯高 0.25 m 时是万分之二。这一条已经修了（命中一侧改从没挪动的着色点算，现在是 `state.mis_origin_P`）。
- 修好之后的残差才是数值精度的量级：两台机器各用 800 个种子量，正对、斜向对解析值的偏离都在百万分之零点五以内；同一串随机数在两块显卡上算出来还系统地差 2e-7 到 6e-7。底取相对 2e-6，约为残差的五倍。
- 这两个读数的标准误可以小到相对 1e-6 以下，与残差同量级，所以只按标准误判就是在判这点残差：这是要有一条底的原因。
- 种子用 32 个，不用 8 个：8 个种子估出来的标准误尾巴很重，均值超过 3 个标准误的概率约 2%（两台机器各 100 组、每组 8 个种子，近灯这个读数都是 2 组不过；它的标准误比那条底大，底帮不上它）。同一批读数按每组 32 个种子分成 25 组，三个场景、两台机器共 150 次判定全过。
- 解析值是双精度的中点求积，取 1024 格（求积误差在相对 4e-8 以下；256 格时近灯是 6.8e-7，与残差同量级）。

近灯这个几何是守上面第一条的：把命中一侧改回从挪开的起点算，正对、斜向的偏离只有百万分之二上下，会被那条底放过，近灯上是万分之二（四十个标准误上下）。它的噪声大，只进第 2 级的判定，不进回归基线逐位比的那 24 个读数。

灯后有板这个几何（斜向那一种，灯背后 30 微米放一块 0.7 m 见方、与灯平行的黑板；黑板不反光，解析值与斜向相同）守的是遮挡的判法：材质采样打到矩形纯光时，遮挡物的距离是从沿法线挪开的射线起点量的，灯的距离是从着色点本身量的，两个起点不同。光源采样一侧的阴影射线从挪开的起点打、长度取灯距乘 0.999；材质采样一侧用同一条判法（遮挡距离除以 0.999 再与灯距比）。直接拿两个距离比的话，板离灯不到挪开的那一点距离时这一侧把灯判成被挡住、整份丢掉，读数偏低千分之一点五，而另外三种几何上完全看不出来。它也只进第 2 级的判定。

**成像的第 2 级**（1.2.0 加，`../chassis/imaging.mjs`）：像素滤波的刀口剖面（半平面黑白分界，三种滤波、两种宽度）每一列对「Cycles 的滤波表给出的分布与刀口的卷积」不超过 4 个标准误，对连续滤波函数的卷积只记录不判；盒式宽 1 显式给出与不加参数逐位相同。夹取用粗糙度 0 的金属（奇异闭包）看亮度已知的均匀天空：单面镜里的天空走直接光的上限、直角反射器里两次反射之后的天空走间接光的上限，逐通道对照 Cycles 的式子手算的值 ±3 个标准误（每个样本相同、标准误为 0 时相对误差 ≤ 1e-5），不该起作用的那个上限与不夹逐位相同；上限给 0 与不设逐位相同。滤光泽用「漫反射地面经一块粗糙度 0.05 的金属板看小面光的焦散」（相机直接看到的面不模糊，先弹过一次才模糊），关与开（blur_glossy 0.25）各对 Blender 5.2.3 的 Cycles 渲的同一场景（`../chassis/cycles-filter-glossy.json`，处理器渲染，8 个种子）取画面中央 16×16 像素的均值，±4 个合并标准误；开与关之差在两边都要超过 5 个合并标准误，否则这个场景判不出、算不过；滤光泽给 0 与不给逐位相同。这一项的渲染用 `--override` 把能量补偿开、弹射上限改成 128（Cycles 原理化 BSDF 默认的分布是多重散射 GGX；render-pack 默认的预设能量补偿是 0、弹射上限 8，不改时板的粗糙度一大读数就差几个百分点）。负对照七项：高斯、Blackman-Harris、盒式的建表宽度，宿主没乘 3，背景的弹射数没减 1，按最大分量比上限，内核里对 `filter_glossy` 再取一次倒数（blur_glossy 取 0.25 而不是 1，是因为 1 的倒数还是 1，这一项就抓不到）。

**负对照有十一项**，每项故意改错一处，必须不过，而且读数要落在登记值的容差之内（读数挪了位置说明接线变了）：粗的八项（遮蔽项写错、面光换算多乘 1%、材质采样一侧不取光；电介质高光的菲涅耳不随角度变、电介质高光下面的漫反射不衰减、漫反射采样一侧的求值少乘 2%、选闭包的随机数只用一半、发光多乘 1%）读数远在门外，容差 ±5%；细的三项（面光换算多乘十万分之二、命中一侧改回从挪开的起点算、遮挡距离改回直接拿来比）要的是解析场景的判法判它不过，守的是那条底没有把这个量级的错放过去，它们的读数里噪声与残差占的份额大，容差 ±30%。

**换了随机数的编号之后，某个解析场景碰巧落在 3 个标准误之外（又不在那条底以内）时**：把种子加到 64 个（1 到 64），按合起来的 64 个判一次。仍然不过就是不过，去找原因；不许反复换种子或换种子组直到过为止。

**只比原始输出的上游场景**（1.2.0 加，`../chassis/regress.mjs` 的 `OUTPUT_ONLY`）：`surface/wet-layer-gltf` 判的是湿与干的亮度比，上游测试的解析值 0.549 照上游自己的高光模型算；材质改走移植的原理化 BSDF 之后读数是 0.5689，上游测试判它不过。回归核对对它只比原始输出逐位、不比状态；它的原始输出变了照样算不同。

**一个上游原有的偶发**：苹果显卡软件求交下，上游场景 `voxel/shadow-axis` 偶尔少一个样本（原始输出里一到三个数差六十四分之一的整数倍）。没改过的上游内核连跑 40 遍出现 3 遍，不是哪一步改动引进的，根因没有查。它没有登记成不稳定场景：回归核对里只有它一处不同时，重跑一遍；连着两遍不同才当真。

**计时**：回归工具每次量两个数（着色器首次编译的毫秒数、一个固定场景 1920×1080、256 采样的稳态秒数）。

- **稳态那条线按出片的那台机器（英伟达显卡）判**：对结构落地之前累计慢 10% 以上要停下来报告。量法：把结构落地之前的程序与现在的程序轮流各量至少 7 次，各取中位数来比。那台机器被别的任务占满时量到的数不算（同一个程序前后能差 5% 到 15%）。
- 苹果显卡上只记录，不设线；单独一步让它的稳态慢 3% 以上的，在提交说明里写明慢在哪、试过哪些写法。
- 首次编译两台机器都只记录。
- 参考数（结构落地之前与之后的程序轮流量，取中位）：稳态，苹果显卡累计慢 10.8%（1.52 秒 → 1.69 秒；四遍各 9 次轮流的中位一致），英伟达显卡慢 6% 到 7%（0.115 秒上下 → 0.123 秒上下，几遍之间不一样）；首次编译两台机器都慢两成上下（英伟达显卡 1.8 秒 → 2.2 秒，苹果显卡 1.03 秒 → 1.27 秒）。
- **英伟达显卡上那个计时场景一次只有 0.12 秒上下**，同一个程序各次之间能差 3% 到 6%：这条线的分辨率只有两三个百分点，离 10% 的余量约三个百分点。要判得准，得把采样数加到一渲一秒以上再比（还没做，见「还没接的」）。
- **输出通道接上之后（冻结标记 1.1.0：辅助样本、覆盖率计数、透明度），不要辅助层时**（改前改后的程序轮流量，回归工具的计时场景）：苹果显卡各 7 次，中位 1.926 秒 → 1.913 秒，在散布之内；英伟达显卡慢 4% 到 5%（一遍各 7 次 0.1274 → 0.1325 秒，一遍各 9 次 0.1222 → 0.1284 秒，两组几乎不重叠）。同一遍里拆开量（各 9 次）：去掉覆盖率计数 +1.4%，只去掉读辅助那一格（物体扩展表照读）+0.7%，只去掉 `main` 开头按 `pass_kind` 的分支 +2.8%：慢主要在每个颜色样本多读一次输出缓冲的辅助那一格（每个像素记录的第二个 64 字节）。后来把辅助样本改成单独的入口、覆盖率计数放到编译开关 `aux` 后面（只在要辅助层的那次渲染打开），不要辅助层时编出来的颜色内核与改前只差三处：路径状态多一个字段（`first_hit_object`，不写）、每个样本开头置不透明度为 1、相机射线没打到时按 `background_transparent` 的那个分支（后两处是颜色层的 A，与要不要辅助层无关）。改完之后的量法与读数见下一条。要辅助层时多出的是辅助那一趟调度本身：1920×1080 一趟，苹果显卡约 20 毫秒、英伟达显卡约 0.6 毫秒（同一帧 64 采样的求交分别约 430、40 毫秒）。
- **辅助样本改成单独的入口、覆盖率计数放到编译开关 `aux` 后面之后**：不要辅助层时，英伟达显卡上改前（场景包读入器那一版）与改后轮流各 9 次，中位 0.1227 秒 → 0.1242 秒（+1.2%）；同一台机器另一遍把改前、改后、改前的一份拷贝三个程序轮流各 9 次，中位 0.1223、0.1237、0.1209 秒：同一个程序与它的拷贝之间就差 1.1%，这个计时场景分不出 1% 上下的差别（见上面「分辨率只有两三个百分点」一条）。要辅助层时多出的（同一个程序、同一个场景包，加不加 `--passes` 轮流各 7 次，1920×1080，求交的毫秒数含辅助那一趟）：苹果显卡 256 采样，从 Blender 导出的两份包 +7.7%（1340 → 1444 毫秒，辅助那一趟 23 毫秒）、+2.2%（1593 → 1629，24 毫秒）；英伟达显卡 1024 采样，+8.6%（499 → 542，0.5 毫秒）、+5.9%（574 → 607，0.5 毫秒）。多出的大头在颜色样本数覆盖率（每个样本读一次辅助那一格、查一次物体扩展表），不在辅助那一趟本身。
- 苹果显卡上慢的那 10.8% 里，约一半来自修矩形纯光两侧不从同一个点算的那一条：主循环多带一个三维向量（`bm_x`）过求交。新加一个变量的七种放法都一样慢。不新加变量、复用路径状态里已经带过求交的那个量（`state.legacy.mis_x`）的写法不慢（苹果显卡累计 6.4%），但要把发光体一侧算选灯概率的起点一起换成射线起点；粗糙玻璃透射时这两个点不同，等于在那一侧引进同一类「两侧不从同一个点算」的不一致。所以当时没有换。1.2.2 做灯时统一了：`bm_x` 与 `mis_x` 并成正式字段 `mis_origin_P`，发光体一侧选灯与算距离也改从没挪动的着色点取；苹果显卡上计时场景的稳态从 1.59 秒回到 1.56 秒（回归工具各 3 次的中位）。
- **原理化 BSDF 非金属那一半移植之后（冻结标记 1.2.0）**，英伟达显卡上量法改成：计时场景同上，采样数加到 2560（改前的程序一渲 1.2 秒上下；回归工具的计时场景不动，加采样只在对比脚本里），每次新起进程，几个程序轮流各 9 次（奇数轮倒序），取中位；量的时候机器上别人的负载（一分钟平均）在 2.8 到 4.8 之间。三个程序：结构落地之前的 97ece29e、移植之后的 c2765305、把闭包数组的变量下标改成常数之后的版本（「只活在一次调用里的结构」里那一条）。稳态中位 1.2096、1.3644（+12.8%）、1.2724 秒（+5.2%）；同一进程接着再渲一遍，中位 1.2144、1.3647、1.2837 秒。驱动编出来的统计（`VK_KHR_pipeline_executable_properties`，同一份 WGSL 经 naga 生成 SPIR-V 交给驱动；三个程序都是 255 个寄存器）：每个线程的本地内存 336、1200、480 字节，代码 237、385、383 KB；首次编译 3.1、6.1、6.0 秒。改之后还多的那 5% 没有再拆。苹果显卡上同一处改动之后稳态 2.06 → 1.45 秒。
- **稳态分两档（256 采样时约 0.147 与 0.30 秒）的原因是首次编译变长之后显卡空闲降频，不是着色**：读数是新进程里暖机那一帧（16×16、1 采样）之后的第一渲。移植之后着色器首次编译从 3 秒上下变成 6 秒上下，这段时间显卡空着；空得久了会降到低频档，第一渲开头要等它升频。证据（英伟达显卡，256 采样，轮流各 9 次）：结构落地之前的程序在暖机帧之后先空等 8 秒再渲，稳态中位从 0.1226 秒变成 0.3172 秒（0.236 到 0.437 秒），前 4 个样本那一批从 2.2 毫秒变成 47 毫秒；空等 3 秒时 9 次里有 1 次落到慢档（0.235 秒，那一批 19.7 毫秒）。同一个进程接着再渲一遍都回到 0.12 秒上下。慢档出现与否看机器当时的状态：同一个移植之后的程序，一遍里 9 次有 5 次在慢档（2560 采样时 1.50 到 1.61 秒，快档 1.36 秒），另两遍一次都没有；改成常数下标之后的程序编译照旧 6 秒上下，2560 采样的那一遍 9 次里有 2 次落到慢档（1.44、1.38 秒，那一批 19 毫秒）。所以回归工具的 256 采样计时会偶尔报出这一档（它只量第一渲）：要判英伟达上的稳态，按上一条的量法轮流量，并看同一进程里的第二渲。首次编译只记录。

## 还没接的

每个「已定义」「已写未读」「无调用者」的字段或函数，等后面哪一类工作来接。

| 东西 | 现在 | 等谁来接 |
|---|---|---|
| `Closure` 的 `alpha_y` 在求值与采样里的读者（各向异性） | 已写，求值与采样只读 `alpha_x` | 移植闭包（各向异性） |
| `CLOSURE_BSDF_TRANSPARENT`；`FRESNEL_*` 里除 F82、广义 Schlick 之外的四种 | 只占了号 | 移植闭包 |
| 清漆、透射、光泽、次表面、薄膜、各向异性、漫反射粗糙度不为 0、不透明度小于 1 的材质（现在整个走上游顶替） | 上游顶替 | 移植闭包 |
| `MATERIAL_FLAG_CLASS_*`、`MATERIAL_CLASS_*`；材质记录的 6 个预留格 | 已定义 | 移植闭包 |
| 移植的闭包之间按灯的着色标志排除某类闭包（`SHADER_EXCLUDE_*`） | 没做（不用多重重要性采样的灯把材质一侧的密度置 0 已做） | 做灯 |
| `surface_shader_transparency`、`shader_eval_shadow`；`CLOSURE_BSDF_TRANSPARENT`；`PATH_RAY_VISIBILITY_SHADOW_*` | 已定义、无调用者 | 移植闭包（透明闭包），并把上游求交里的镂空与穿玻璃改道过来 |
| `PathState` 的透明计数；`path_state_next` 里其余的 `PATH_RAY_*` 位；`integrator` 块的 `max_bounce`、透明弹射的上下限、`min_bounce`；介质散射的上限（Cycles 的 `max_volume_bounce`） | 已定义或没做 | 移植闭包 |
| `BsdfEval` 的 `diffuse`、`glossy`（已写）；`BsdfSample` 的 `eval`、`eta` 的读者；`pass_diffuse_weight`、`pass_glossy_weight` | 已写未读或已定义 | 移植闭包（分通道对拍） |
| `PRNG_LIGHT`、`PRNG_LIGHT_TERMINATE`；`integrator` 块的 `light_inv_rr_threshold` | 已定义（逐盏的灯照旧取上游的 `D_SUN`、`D_LOCAL` 槽位；Cycles 开着光源树时不做灯的轮盘终止） | 做灯 |
| `state.visibility` 的读者；`ObjectExt` 的 `lightgroup`（发光网格的灯组） | 已写未读或已定义 | 做灯（发光网格） |
| `film_add_light` 的 `bounce` 参数 | 已定义，没人读 | 降噪与采样（分直接光、间接光的夹取上限） |
| 上游的灯光函数（上游顶替的闭包、多于 `RIS_EXACT` 盏的本地灯、发光三角、体积还走它们）、`surface_shader_bsdf_eval_legacy`、各 `D_*` 槽位 | 上游顶替 | 移植闭包与体积之后删 |
| `trace_local`；着色点的 `lcg_state`、`object_flag`、`prim`、`u`、`v`、`N`、`ray_length` 的读者；`Ray` 的 `self_object`、`self_prim`、`tmin` 的读者 | 已定义、无调用者，或已写未读 | 图案节点（倒角、遮蔽） |
| `PRNG_SURFACE_AO`、`PRNG_SURFACE_BEVEL`、`path_branched_rng_2D`、`path_rng_2D` | 已定义、无调用者 | 图案节点 |
| `Material` 的 `pattern_first`、`pattern_count`；`MATERIAL_FLAG_NO_LEGACY_FUNCTION`；`table_first_ext` 的图案节点表一格；`ObjectExt.object_flag` 的读者（镜像位场景包读入器已写） | 已定义 | 图案节点 |
| `AuxSample.motion`、`FILM_AUX_DATA` 的 zw（运动矢量） | 已定义，恒 0：场景包只有整数帧的状态，快门两端的位置算不出来 | 运动模糊与运动矢量 |
| 请求灯组的任务描述字段（命令行 `render-pack --passes` 已出全部组） | 没有 | 帧源接口 |
| 场景包里解析过、校验过、还没生效的：图案节点（`pack::Node`）；`pack-info` 的统计列在 `notApplied`（灯光链接与分灯组 1.2.2 起生效） | 已读未生效 | 图案节点 |
| `FILM_DENOISE_NORMAL` 换成 Cycles 的口径；降噪反照率的「跟反射」与按粗糙度加权；`FILM_LEGACY_VARIANCE`；`denoising_feature_throughput`；`PATH_RAY_DENOISING_FEATURES` | 只取相机首次命中那一点。反照率已照 Cycles 取漫反射类闭包的 `bsdf_albedo` 之和（上游顶替取底色，只发光的面取归一化的发光色），法线是闭包用的法线（含法线贴图）。Cycles（`kernel/film/denoising_passes.h`）开着「跟反射」时沿光滑的反射、透射一直跟到够粗糙的面才写，乘降噪特征的通量，法线是全部闭包按权重的平均。只有法线的坐标系出层时换成了 Cycles 的（见「输出通道」）；两侧差多少还没量 | 降噪与采样 |
| `sobol_index_mask` 的算法、`sampling_pattern`、分支版取数的有效样本数 | 上游写死的值 | 降噪与采样 |
| 着色点与光线的 `time` | 已定义，恒 0 | 运动模糊 |
| `ObjectExt` 的阴影终止着色偏移 `shadow_terminator_shading_offset` | 已定义（几何偏移场景包读入器写 0.1、阴影射线读） | 移植闭包（`shift_cos_in`） |
| 介质一侧的 `rng_legacy` 槽位（`D_FOG`、`D_MEDIA`、`D_PHASE`、`D_VOL_LIGHT`）；跨射线的跟踪步编号相撞 | 上游顶替 | 移植体积 |
| 带卡片的矩形灯（上游的发光卡片那条路）：一个侧灯几何（灯 0.2 m 见方、高 0.25 m）下读数对解析值偏高约千分之五（整个场景平移到离原点 100 m 时约百分之一点六），同一个几何不带卡片时在噪声内 | 原因没查；带卡片时那个解析值是否适用也没核对 | 做灯 |
| 第 2 级没有离原点远的解析场景（射线起点挪开的距离跟着坐标变大，偏差在那里放得最大） | 没有 | 做灯或下一次动第 2 级的人。平移量与灯位要取单精度能精确表示的数（比如 x = 128、灯高 0.25）：x = 100.3 这样的数存下来差百万分之三米，读数会因此偏十万分之一点六，那是场景坐标的表示误差，不是内核的错 |
| 英伟达显卡上的计时场景加采样数（现在一次 0.12 秒上下），并在暖机帧之后多渲一遍再计时（首次编译之后显卡空闲降频，见「判据」的计时一条） | 没做；1.2.0 落地时只在对比脚本里加过 | 下一次动回归工具的人；改了场景要重记两台机器的基线 |

### 三条线之间的分工

移植闭包、做灯、做图案节点三条线会同时动内核。下面几件事落在两条线的交界上，先说定归谁：

- **多闭包的直接光归移植闭包的人（1.2.0 已做）。** 上游的灯光函数拿材质求值经 `surface_shader_bsdf_eval_legacy`，它对移植的闭包改成调 `surface_shader_bsdf_eval` 对全部闭包求和；`light_mis` 对移植的闭包的密度改成经闭包分发。这是「新代码不碰名字带 `legacy` 的函数」的点名例外，只限这两处。
- **凹凸阴影项与阴影终止偏移**（Cycles 做在它的求值入口里，要用着色点）做在收着色点的分发函数里（`surface_shader_bsdf_eval` 那一层），不做在 `bsdf_eval(c, wi, wo)` 里：后者只收一个闭包，签名不为它改。凹凸阴影项 1.2.1 已做（求值一侧 `bsdf_eval_mis_bump_one`、采样一侧 `surface_shader_bsdf_sample_closure`）；阴影终止的着色偏移（`shift_cos_in`）还没做（Blender 的默认值 0 时它不起作用）。阴影终止的几何偏移（阴影射线的起点，`kernel/light/sample.h` 的 `shadow_ray_offset`）1.2.3 已做，在 `light.wgsl` 的 `shadow_ray`。
- **主循环里的「穿过光滑玻璃」（1.2.0 已改）**：只有奇异的透射一瓣（`LABEL_TRANSMIT | LABEL_SINGULAR`，上游顶替的光滑玻璃）算穿过；移植的闭包的奇异反射一瓣照 Cycles 带着乘了 1e6 的概率密度走普通的一支（多重重要性采样的密度、最小密度照记），并照 Cycles 的 `path_state_next` 置 `PATH_RAY_MIS_SKIP`：这个着色点上光源一侧对奇异的一瓣求值为 0，所以下一次打到发光面、天空、太阳盘、矩形纯光（`bm_rect_hits`）时权重取 1，不按 `power_heuristic` 加权。
- **阴影链接与发光网格的成员集**由做灯的人另开一张表（见「物体扩展表」）。**直接光调用处的夹取**改成逐盏夹（1.2.2 已做，见「输出通道」）。
- **图案节点的结果在闭包移植完之前只到得了已移植的闭包。** 倒角改的是 `ShaderInputs.N`、遮蔽改的是底色，而上游顶替的闭包与上游的灯光函数读的是 `sd.legacy.surface`。过渡期不许为了让效果到达上游顶替而去写 `legacy` 的表面量；图案节点先在已移植的闭包上验。
- **材质的图案节点表位置**（`pattern_first`、`pattern_count`）现在没有带进 `ShaderInputs`。做图案节点的人用到时加字段带出来，不另读一次材质记录（过程几何的材质号算法不一样）。
- **三条线各自加字段，会在冻结标记上相撞**（同一个结构的摘要、版本号那一行）。合并时不手工解这几行：合并之后重跑 `freeze.mjs --update`，版本号由做合并的人定；`src/gpu.rs` 里两条测试的字段名单照合并后的结构补齐。

## 改动的规矩

1. **不算破坏的**（直接做，过回归）：给只活在一次调用里的结构加字段；加新函数；给返回结构加字段；往预留格里填并起名；在 `Params` 末尾追加一块；删 `legacy` 的字段与函数；把「已定义」的字段接上。
2. **要先拿号的**：闭包种类号、材质 `flags` 的位、每次弹射的随机维度、全局参数的追加块、新表首地址的格子、输出缓冲的格子。向核心帧源的负责人要，登记进上面的登记表。
3. **破坏性的**（改已有字段的名字、含义、位置；改进缓冲的格式的长度；改已有函数的参数表；改已有编号的数值）：先经核心帧源的负责人同意。
4. 凡是动到冻结标记钉住的东西（第 1 条里的加字段、第 2 条、第 3 条都会）：改这份条文里对应的字段表或登记表，升 [FREEZE.json](FREEZE.json) 里的版本号（不算破坏的升末位，破坏性的升首位），运行 `node beiming/sources/core/chassis/freeze.mjs --update`，把标记的差异与改动放在同一个提交里。
5. 每一步：`cargo test --locked`、`freeze.mjs`、两台机器上的 `regress.mjs --check`。有意改变渲染结果的改动过后，两台机器各重记一次基线。
6. **五个没有调用者的函数，签名是暂定的**：`surface_shader_transparency`、`shader_eval_shadow`、`trace_local`、`path_rng_2D`、`path_branched_rng_2D`。（`film_write_aux`、`object_ext_at` 已经有调用者，并在两台机器上过了回归，签名定下来了；`surface_shader_bsdf_eval`、`shader_eval_emission` 在 1.2.0 有了调用者，在两台机器上过了第 2 级，签名定下来了。）它们只过了校验与两个后端的代码生成，没有在显卡上跑过；按值传大结构这类问题只有真跑才暴露。第一个调用者落地、并在两台机器上过了回归之后，签名才算定下来（那时把它从这张名单里划掉）。在这之前改它们的参数表不算破坏性的改动，不用先经同意：改条文与冻结标记（第 4 条）就行。
