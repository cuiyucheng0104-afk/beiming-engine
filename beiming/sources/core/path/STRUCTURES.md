# 核心帧源 · 内核的四样内部结构

读者｜要改内核、或要在内核里移植闭包、灯、图案节点、降噪、输出通道的人与 agent　冻结标记｜[FREEZE.json](FREEZE.json)（版本 1.0.0，2026-11-24）　来源与历史｜[PROVENANCE.md](PROVENANCE.md)

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
| 已定义、无调用者 | 函数写好了签名（有的还有函数体），内核里还没有任何地方调它。只过了校验与两个后端的代码生成，没有被任何场景跑到过 |

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
| 18 | `specular_ior_level` | f32 | 高光等级，默认 0.5 | 已写未读（进了 `ShaderInputs`，那里没人读） |
| 19 | `diffuse_roughness` | f32 | 漫反射粗糙度，0 是朗伯 | 已写未读（同上） |
| 19 | `flags` | u32 | 按位的标志，见登记表 | 第 0 位已落地，其余已定义 |
| 19 | `pattern_first`、`pattern_count` | u32 | 这个材质的图案节点在节点表里的起点与个数 | 已定义，恒 0 |
| 20 到 25 | `reserved` | 6 个 vec4 f32 | 预留，全 0。给各向异性、清漆、绒面、透射、薄膜、次表面的参数；用到的人在这里起名 | 预留 |

几条说明：

- 前 18 格是上游原样的，不搬成 Cycles 的排法。其中 `base_color`、`params.x`、`params.y`、`layer.y`、`emissive.rgb` 的含义与 Cycles 的同名输入相同，照 Cycles 移植的闭包直接用它们，不另存一份。
- 高光等级单独存，不与上游的 `params.z` 合用：两者只在折射率 1.5 时等价。
- 第 19 格在着色器里声明成四个标量，不用向量再做位转换。
- 图案节点（倒角、环境光遮蔽等）的参数不放进材质记录。材质记录只带 `pattern_first`、`pattern_count` 指向一张单独的节点表（首地址的格子见登记表）；节点表的格式归做图案节点的人。上游的 `mp`、`mt` 继续只归上游的材质函数。
- **默认值**在 Rust 一侧手写（`GpuMaterial::default`）：边缘色白、高光等级 0.5，其余全 0；每个构造处都以它收尾。
- **能量补偿那一位**（`MATERIAL_FLAG_MULTISCATTER`）不在各构造处填：上传前由 `scene::with_energy_compensation` 一处按全局开关 `energyCompensation` 统一写。纯金属的闭包读这一位；上游顶替仍读全局的 `P.misc.z`。
- **边缘色由一个场景特性位决定读不读材质记录**。特性位 `F_SPECULAR_TINT`（`src/gpu.rs` 的 `features_of` 按材质表定）：场景里有材质的边缘色不是白时，材质求值才从记录读 `specular_tint`；别的场景里内核编译期取白，不读这一格。这是量出来的：一律从记录读时，F82 的 B 项不再是编译期的 0，没有金属的场景稳态也慢 4%（苹果显卡）。现在没有任何场景入口能把边缘色设成非白，所以这一位平时恒关；强开它（环境变量 `THREERT_FEATURES_ON`）跑过全部回归，结果逐位不变。

谁写：Rust 的 `scene::build_material`（从场景描述压出来）与 `scene::card_material`；以后是场景包读入器。

谁读：新写的代码里**只有 `shader_eval_inputs` 读材质记录**（现在经它调的上游 `surface`、`surface_proc`）。积分器不读。上游留下的直接读者是已知的例外：求交一侧的镂空测试 `alpha_pass`、阴影穿玻璃 `glass_at`、硬件求交的 `cutout`；灯光一侧读发光三角材质的 `emitter_radiance`、`emitter_sel`、`emit_mis`、`sample_emitter`、`sample_emitter_ris`；给材质函数备输入的 `mat_in_at`。

### 材质输入值 `ShaderInputs`

定义：`shaders/shader.wgsl`。贴图、材质函数、图案节点都算完之后，一个着色点上的材质参数。取值范围照 Cycles 读出节点输入之后的夹取。写的人：`shader_eval_inputs`（现在是它调的上游 `surface` 里的 `legacy_shader_inputs`）。读的人：`shader_setup_closures`。

| 字段 | 类型 | 含义 | 状态 |
|---|---|---|---|
| `base_color` | vec3 | 底色，不小于 0 | 已落地（纯金属的闭包读） |
| `metallic` | f32 | 金属度，0 到 1 | 已落地 |
| `roughness` | f32 | 粗糙度，0 到 1。**不带上游的 0.02 下限** | 已落地 |
| `ior` | f32 | 折射率，不小于 1e-5 | 已写未读 |
| `specular_ior_level` | f32 | 高光等级，不小于 0 | 已写未读 |
| `specular_tint` | vec3 | 边缘色，不小于 0；特性位关着时恒白 | 已落地（纯金属的闭包读） |
| `emission` | vec3 | 这个点的自发光辐亮度，**已乘物体的功率倍数** | 已落地 |
| `alpha` | f32 | 不透明度，0 到 1。现在只是材质记录里的值，不含贴图的透明度（镂空在求交那一侧判） | 已写未读 |
| `diffuse_roughness` | f32 | 漫反射粗糙度，0 到 1 | 已写未读 |
| `flags` | u32 | 材质记录的 `flags` 原样带过来 | 能量补偿位已落地；闭包大类已定义 |
| `coat_weight` | f32 | 清漆的份额，0 到 1 | 已落地（只用来判「无清漆」） |
| `transmission_weight` | f32 | 透射的份额，0 到 1 | 已落地（只用来判「无透射」） |
| `N` | vec3 | 闭包用的法线：含法线贴图、材质函数，以后还有倒角 | 已落地 |

### 着色点 `ShadingPoint`

定义：`shaders/shader.wgsl`。一次命中上的几何量与闭包，照 Cycles 的 `ShaderData` 取子集。它是积分主循环里的一个局部变量。

| 字段 | 类型 | 含义 | 谁写 | 状态 |
|---|---|---|---|---|
| `P` | vec3 | 位置（世界空间） | `shader_setup_from_hit` | 已落地 |
| `N` | vec3 | 插值后的平滑法线，打在背面时与 `Ng` 一起翻向来路；不含法线贴图、不含倒角。过程几何的命中里等于 `Ng` | 同上 | 已写未读 |
| `Ng` | vec3 | 几何法线，翻向来路 | 同上 | 已落地 |
| `wi` | vec3 | 指向来路的方向 | 同上 | 已落地 |
| `object` | u32 | 物体表的下标，软件、硬件两条求交路上都有；不是实例记录号 | 同上 | 已写未读（只被抄进同样没人读的 `state.mis_ray_object`） |
| `prim` | u32 | 全局三角下标；过程几何的命中里是上游的命中码（最高位是 1） | 同上 | 已写未读 |
| `u`、`v` | f32 | 重心坐标；过程几何的命中里是上游编码过的法线与属性 | 同上 | 已写未读 |
| `ray_length` | f32 | 这一段光线走了多远 | 同上 | 已写未读 |
| `flag` | u32 | 着色点标志，位照 Cycles。`SD_BACKFACING`（第 0 位）：打在背面 | 同上 | 已落地 |
| `object_flag` | u32 | 物体标志，位照 Cycles。第 3 位 `SD_OBJECT_NEGATIVE_SCALE`：物体是镜像的 | 没人写 | 已定义 |
| `time` | f32 | 这条光线的时刻 | 没人写 | 已定义，恒 0 |
| `lcg_state` | u32 | 局部求交随机取子集用的小随机数状态 | 没人写 | 已定义 |
| `emission` | vec3 | 这个点的自发光，单独一个量，不占闭包 | `shader_setup_closures` | 已落地 |
| `num_closure` | u32 | 闭包个数。0：只发光、不散射，路径到这里结束 | 同上 | 已落地 |
| `closure` | `Closure` 的数组，长 `MAX_CLOSURE` | 闭包 | 同上 | 已落地（现在至多 1 个） |
| `legacy` | `ShadingLegacy` | 上游的 `Surface` 与 `Lobes`，给上游顶替读 | `shader_eval_inputs`、`surface_shader_prepare_closures` | 已落地，闭包与灯移植完后删 |

`MAX_CLOSURE` 是 4，只在一处定义。它不是缓冲格式，改它不算破坏；数组越长每个着色点占的栈越大。

背面的判法沿用上游：几何法线与光线方向的点积不小于 0 就算背面。Cycles 是小于 0 才算背面，两者只在恰好垂直时不同。

### 闭包 `Closure`

定义：`shaders/shader.wgsl`。一个结构装所有种类（这门着色器语言没有联合体）。微表面的菲涅耳参数在 Cycles 里另放在四个结构里，这里摊平放进来。写的人：`shader_setup_closures`。

| 字段 | 类型 | 含义 | 状态 |
|---|---|---|---|
| `kind` | u32 | 闭包种类 `CLOSURE_*`，见登记表。Cycles 里叫 `type`，那是这门语言的保留字 | 已落地 |
| `weight` | vec3 | 彩色权重 | 已落地 |
| `sample_weight` | f32 | 在多个闭包之间选哪个去采样的权重 | 已写未读（恒 1） |
| `N` | vec3 | 这个闭包用的法线 | 已落地 |
| `alpha_x`、`alpha_y` | f32 | 微表面两个方向的粗糙度（各向同性时相等） | 已落地（只读 `alpha_x`） |
| `ior` | f32 | 折射率 | 已定义 |
| `energy_scale` | f32 | 能量补偿的标量倍率。必须与 `weight` 分开存，合进去会把颜色通道弄乱 | 已落地 |
| `fresnel_type` | u32 | 菲涅耳种类 `FRESNEL_*`，数值照 Cycles 的 `MicrofacetFresnel` | 已写未读（只有 `FRESNEL_F82_TINT` 一种在用，求值不看它） |
| `f0` | vec3 | F82 型与广义 Schlick 型的 F0 | 已落地 |
| `f90_or_b` | vec3 | F82 型：预先算好的 b；广义 Schlick 型：F90 | 已落地（F82 的 b） |
| `exponent` | f32 | 广义 Schlick 的指数；负数表示「按折射率算真菲涅耳再重映射」 | 已定义 |
| `reflection_tint`、`transmission_tint` | vec3 | 反射与透射的染色。广义 Schlick 里 Cycles 把真正的染色乘进了 F0，`reflection_tint` 只取 1 或 0，实际是「要不要反射焦散」的开关：照搬它的用法，别当颜色用 | 已定义 |

`kind`、`weight`、`sample_weight`、`N` 所有闭包都填；`alpha_x`、`alpha_y`、`energy_scale`、`fresnel_type`、`f0`、`f90_or_b` 现在只有纯金属的微表面闭包填。

菲涅耳种类：`FRESNEL_NONE`（0）、`FRESNEL_DIELECTRIC`（1）、`FRESNEL_DIELECTRIC_TINT`（2）、`FRESNEL_CONDUCTOR`（3）、`FRESNEL_GENERALIZED_SCHLICK`（4）、`FRESNEL_F82_TINT`（5）。只有最后一个已落地。`FRESNEL_CONDUCTOR` 要一个复数折射率（实部、虚部各三个通道），闭包里还没有放它的字段：种类号先占着，用到时加两个字段。各向异性的切线、薄膜的参数同样是用到时加字段。

**现在的实际情况**：一个着色点至多一个闭包。

- 金属度为 1、没有清漆、没有透射的材质：`CLOSURE_BSDF_MICROFACET_GGX` 加 `FRESNEL_F82_TINT`。底色当 F0，边缘色取 `ShaderInputs.specular_tint`，alpha 取粗糙度的平方。F82 的 b、能量补偿的倍率与权重在填闭包时算一次、存进闭包。粗糙度在这里沿用上游的 0.02 下限（Cycles 没有）：去掉它画面会变，而且低于这个下限闭包会落进奇异的一支，积分主循环现在把奇异的标签当「穿过光滑玻璃」处理，要一并改。
- 别的（带清漆或透射的金属也在内）：一个 `CLOSURE_LEGACY`，求值与采样转给上游。
- 发光卡片（上游的 `card`：只发光、不散射）：没有闭包。
- `CLOSURE_BSDF_DIFFUSE`、`CLOSURE_BSDF_TRANSPARENT` 只占了种类号。

### 材质求值的三步，与只算透明度的一档

都在 `shaders/shader.wgsl`。

| 函数 | 做什么 | 状态 |
|---|---|---|
| `shader_setup_from_hit(sd, o, d, h)` | 填着色点的几何量，不读材质。往整变量的指针里填，不按值返回（按值返回时苹果显卡上像素末位会变） | 已落地 |
| `shader_eval_inputs(sd, o, d, h, width) → ShaderInputs` | 解出材质输入值。现在装上游的贴图与材质函数逻辑，顺带把上游的 `Surface` 留在 `sd.legacy` 里。图案节点接在这里；以后的节点图编译器整段替换它 | 已落地 |
| `shader_setup_closures(sd, inputs)` | 只读 `ShaderInputs`，填闭包与自发光。归移植闭包的人 | 已落地 |
| `shader_eval_shadow(h, d, t) → vec3` | 只算透明度的一档：命中点放过多少光。不许发任何光线，不许调图案节点。求交函数与阴影透射里只许调这一档，不许调上面的全量求值（这门语言不许调用图里有环，而全量求值以后会回头发光线）。现在转给上游的镂空测试与阴影穿玻璃 | 已定义、无调用者（上游的求交与阴影射线仍直接调那两处） |
| `shader_eval_emission(em, b1, b2, l) → vec3` | 灯采样点上的发光。现在转给上游的 `emitter_radiance` | 已定义、无调用者（上游的灯光函数仍直接调 `emitter_radiance`） |

### 积分器碰材质只经这一组函数

都在 `shaders/closure.wgsl`，名字照 Cycles 的 `integrator/surface_shader.h`。它们是分发函数。

| 函数 | 做什么 | 状态 |
|---|---|---|
| `surface_shader_prepare_closures(sd)` | 闭包填好之后、算直接光与采样之前的事后处理。「滤光泽」以后做在这里。**现在不是空壳**：上游的 `Lobes` 在这里算，而且对所有闭包都算（纯金属的也算，上游的 `light_mis` 还经它拿概率密度） | 已落地 |
| `bsdf_eval(c, wi, wo) → ClosureEval { eval, pdf }` | 一个闭包在一个方向上的求值（已含余弦，没乘闭包的 `weight`）与概率密度。照 Cycles 的 `bsdf_eval`。收一个闭包，不收整个着色点。上游顶替不走这里 | 已落地 |
| `surface_shader_bsdf_eval(sd, wo, light_shader_flags) → BsdfEval` | 对所有闭包求值求和。`light_shader_flags` 是灯的着色标志，现在没人读 | 已定义、无调用者 |
| `surface_shader_bsdf_bssrdf_pick(sd, rand) → BsdfPick { closure, rand }` | 按 `sample_weight` 选一个闭包去采样；用三个随机数里的第三个来选，选完重新拉伸回 0 到 1。**现在恒选第 0 个，随机数原样返回** | 已落地（骨架） |
| `surface_shader_bsdf_sample_closure(sd, k, rand) → BsdfSample` | 在第 k 个闭包上采样方向，用 `rand` 的前两个定方向。上游顶替不用 `rand`，自己从上游的随机数里取 | 已落地 |
| `surface_shader_emission(sd) → vec3` | 这个点朝来路发出的光。上游的发光卡片是单面的 | 已落地 |
| `surface_shader_transparency(sd) → vec3` | 阴影射线穿过这个点时放过多少光。恒 0 | 已定义、无调用者 |
| `bsdf_albedo(sd, k) → vec3` | 第 k 个闭包的反照率。口径还是上游的：上游顶替返回上游的底色，微表面闭包返回 F0 | 已落地（上游的口径） |

返回的结构：

| 结构 | 字段 | 状态 |
|---|---|---|
| `BsdfEval` | `diffuse`、`glossy`（vec3）：漫反射与光泽闭包各自的部分；`sum`（vec3）：全部闭包之和，已含余弦；`pdf`（f32）：各闭包的密度按 `sample_weight` 的加权平均 | `sum`、`pdf`、`glossy` 有人填；整个结构现在没有读者（采样函数的权重已经在函数里算好） |
| `BsdfSample` | `wo`（vec3）采到的方向，全 0 表示没采到；`eval`（`BsdfEval`）；`pdf`（f32），奇异的一瓣为 0；`label`（i32）采样标签 `LABEL_*`，位照 Cycles；`sampled_roughness`（vec2）；`eta`（f32）折射率比；`weight`（vec3）通量的权重 | `wo`、`pdf`、`label`、`sampled_roughness`、`weight` 已落地；`eval` 已写未读（上游顶替不填）；`eta` 已写未读（恒 1） |
| `BsdfPick` | `closure`（u32）选中的下标；`rand`（vec3）重新拉伸后的随机数 | 已落地 |
| `ClosureEval` | `eval`（vec3）、`pdf`（f32） | 已落地 |

采样标签：`LABEL_NONE`（0）、`LABEL_TRANSMIT`（1）、`LABEL_REFLECT`（2）、`LABEL_DIFFUSE`（4）、`LABEL_GLOSSY`（8）、`LABEL_SINGULAR`（16）、`LABEL_VOLUME_SCATTER`（64），数值照 Cycles。

上游顶替专用、灯移植完后删的两个：`surface_shader_bsdf_eval_legacy(sd, wo, k) → { eval, spec_frac }`（上游的灯光函数专用的求值，`k` 是上游每盏灯的高光倍率，只对上游顶替有效）与 `surface_shader_bsdf_sample_legacy(sd)`。

上游的七个灯光函数（`direct_light`、`local_lights`、`sample_emitter_ris`、`env_light`、`sun_light`、`light_mis`、`pdf_spec`）与 `light_origin` 收的是着色点。灯记录（`Light`，5 个 vec4）的格式与「把灯压成记录的那一个函数」都归做灯的人独占，这里不定；灯记录里以后带「写进 `film` 的第几个灯组槽位」。

## 光线负载

### 路径状态 `PathState`

定义：`shaders/integrator.wgsl`。照 Cycles 的 `IntegratorState.path` 取子集，字段名不改。本内核是「一个像素一条线程，一条路径走到底」，不做波前调度，所以阴影射线没有独立的状态结构。

**路径状态是一个模块级的私有变量 `state`**，所有函数直接读写，不当参数传。

| 字段 | 类型 | 含义 | 谁写 | 状态 |
|---|---|---|---|---|
| `render_pixel_index` | u32 | 写缓冲用的像素下标 | `main` 开头 | 已落地 |
| `sample` | u32 | 第几个样本 | `rng_start` | 已落地 |
| `bounce` | u32 | 总弹射数，也就是当前着色点是路径上第几个顶点 | 主循环每轮开头 | 已落地 |
| `diffuse_bounce`、`glossy_bounce`、`transmission_bounce`、`transparent_bounce` | u32 | 分类计数：照采样标签累加并接各自的上限 | 没人写 | 已定义 |
| `rng_pixel` | u32 | 随机数的像素种子 | `rng_start` | 已落地 |
| `rng_offset` | u32 | 当前弹射的随机维度偏移，初值 `PRNG_BOUNCE_NUM`，每弹射一次加一个 | `main` 开头、`path_state_next` | 已落地 |
| `flag` | u32 | 路径标志位 `PATH_RAY_*` | 主循环 | `PATH_RAY_MIS_SKIP` 已落地，其余已定义 |
| `mis_ray_pdf` | f32 | 上一个散射点采样的概率密度：下一次打到灯时算多重重要性采样的权重 | 主循环 | 已落地 |
| `min_ray_pdf` | f32 | 这条路径上最小的采样概率密度，初值为浮点最大值。有概率密度的弹射才记（表面的非穿透一支、介质散射） | 主循环 | 已写未读 |
| `continuation_probability` | f32 | 这一次弹射俄罗斯轮盘的存活概率，不掷时为 1 | 主循环 | 已落地 |
| `throughput` | vec3 | 路径的通量权重 | 主循环 | 已落地 |
| `visibility` | u32 | 这一段光线的可见类 `PATH_RAY_VISIBILITY_*` | `main` 开头、`path_state_next` | 已写未读（只有骨架） |
| `mis_ray_object` | u32 | 上一个散射点所在的物体（物体表的下标）；介质散射记 `OBJECT_NONE` | 主循环 | 已写未读 |
| `legacy` | `PathLegacy` | 上游的路径状态，照 Cycles 没有对应 | 各处 | 已落地，对应功能移植后删 |

已登记、还没加的字段（加字段不算破坏，这里只占名字）：`pass_diffuse_weight`、`pass_glossy_weight`（分通道对拍用）、`denoising_feature_throughput`（降噪特征用）、`first_hit_object`（覆盖率用）。

`PathLegacy` 里现在有：`behind_glass`、`bent`、`straight`、`mirror_path`、`bm_surf`、`rays_off`、`split_frac`、`dl_spec`、`sampled_spec`、`sampled_trans`、`mis_x`、`mis_n`、`dl_det`、`dl_det_spec`、`shadow_hole`、`nee_alone`、`lights_only`、`rng_path`。没有并进来的上游私有量不是路径状态：求交里过程几何的调用上下文（`gdata_first`、`gdata_count`、`media_voxels`）、灯光瓦片的每像素状态（`lt_list`、`lt_list_n`、`lt_fb`）、循环守卫的计数。

`path_state_next(label)` 在每次弹射之后更新路径状态，照 Cycles 的同名函数，**现在只有骨架**：下一段光线的可见类与随机维度的偏移。分类计数、各类弹射上限、其余路径标志位归移植闭包的人照 Cycles 补。`PATH_RAY_MIS_SKIP` 还按上游的规矩在主循环里设与清（上游的「镜面弹射」与 Cycles 的「奇异的一瓣」不是同一个判法）。

### 路径标志位与可见类

两个枚举，位都照 Cycles（`PathRayFlag` 与 `PathRayVisibilityFlag`）。

路径标志位（`state.flag`）：`PATH_RAY_REFLECT`（第 0 位）、`PATH_RAY_SINGULAR`（1）、`PATH_RAY_TRANSPARENT`（2）、`PATH_RAY_DIFFUSE_ANCESTOR`（4）、`PATH_RAY_EMISSION`（5）、`PATH_RAY_MIS_HAD_TRANSMISSION`（6）、`PATH_RAY_MIS_SKIP`（7）、`PATH_RAY_SINGLE_PASS_DONE`（8）、`PATH_RAY_TRANSPARENT_BACKGROUND`（9）、`PATH_RAY_TERMINATE_ON_NEXT_SURFACE`（10）、`PATH_RAY_TERMINATE_AFTER_TRANSPARENT`（12）、`PATH_RAY_DENOISING_FEATURES`（17）、`PATH_RAY_SURFACE_PASS`（18）、`PATH_RAY_SHADOW_FOR_AO`（20）、`PATH_RAY_SHADOW_FOR_LIGHT_LINKING`（25）。只有 `PATH_RAY_MIS_SKIP` 已落地（相机射线和镜面弹射之后，下一次打到灯不做多重重要性采样）；其余已定义。

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

上游的接口原样冻结：`trace(o, d, tmax_in, mode) → Hit { t, tri, u, v, inst }`，硬件与软件两条求交路径返回同一个结构；没打到时 `tri` 是 `0xffffffff`。调用处从 `Ray` 里取字段。

以后要的新问法各加一个新函数，不改已有的。现在定了签名的一个：

`trace_local(ray, object, lcg_state, max_hits) → LocalIntersection { num_hits, hits, lcg_state }`：只查同一个物体、返回至多 `LOCAL_MAX_HITS`（4）个命中，每个是 `LocalHit { t, tri, u, v }`。倒角与遮蔽这类图案节点用。用过之后的小随机数状态在返回值里带回（这门语言没法把成员的指针传进函数）。**已定义、无调用者，函数体是空壳**（恒返回 0 个命中）。

实现它时的限制：硬件求交下不许新增光线查询的源码位置，只能在现有的 `trace` 之上逐次步进、按物体号过滤来拼，不用候选循环（上游记录过候选循环在苹果显卡上丢命中）。这样拼出来的多命中在硬件求交下是否可靠、代价多大**还没有量过**；不可靠的话只在软件求交上保证图案节点。阴影类的问法只许判断挡没挡住，不许读返回的三角号。硬件求交下按物体过滤可见类同样是已知限制，之前只在软件求交上保证。

### 全局参数 `Params` 末尾追加的三块（进缓冲）

定义：`shaders/pathtrace.wgsl` 的 `Params`、`KernelIntegrator`、`KernelFilm`；Rust 一侧 `src/gpu.rs` 的同名结构。上游原有的字段不动（实时预览留下的字段这次不清）。放在统一缓冲里的嵌套结构，第一个成员带 `@align(16)`。

**`integrator`**（`KernelIntegrator`，4 个 vec4，字段名照 Cycles 的同名结构）。写的人：`KernelIntegrator::new(用户种子)`。

| 格 | 字段 | 类型 | 含义 | 状态 |
|---|---|---|---|---|
| 0 | `max_bounce`、`max_diffuse_bounce`、`max_glossy_bounce`、`max_transmission_bounce` | u32 | 各类弹射的上限 | 已定义，全 0（弹射上限现在读上游的 `counts.z`） |
| 1 | `transparent_max_bounce`、`transparent_min_bounce`、`min_bounce` | u32 | 透明弹射的上下限；俄罗斯轮盘的起始深度 | 已定义，0（轮盘的起始深度现在读上游的 `counts.w`） |
| 1 | `sampling_pattern` | u32 | 采样图案，只有 0（Sobol-Burley） | 已定义 |
| 2 | `sample_clamp_direct`、`sample_clamp_indirect` | f32 | 夹取 | 已定义，0（现在用上游的亮度夹取 `misc.x`） |
| 2 | `filter_glossy`、`light_inv_rr_threshold` | f32 | 滤光泽；灯的轮盘阈值 | 已定义，0 |
| 3 | `seed` | u32 | 随机数的全局种子 | 已落地，见下 |
| 3 | `sobol_index_mask` | u32 | Sobol 打乱后的索引取哪几位 | 已落地，见下 |
| 3 | `pass_kind` | u32 | 这一趟调度写什么：`PASS_KIND_COLOR`（0）颜色样本，`PASS_KIND_AUX`（1）辅助样本 | 已定义，恒 0（辅助那一趟调度还没有） |
| 3 | `background_transparent` | u32 | 背景对相机不可见 | 已定义，恒 0 |

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

**`table_first_ext`**（2 个 vec4、8 格）：北冥加的表在表缓冲里的首地址。上游的 `table_first` 12 格已经占满，新表只许用这里的格子，取用前要登记（见登记表）。

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

状态：表已上传（全 0，个数等于物体数），**所有字段已定义、没有人写非 0 的值；`object_ext_at` 已定义、无调用者**。各家以后只填自己的格子。运动矢量要的前后两刻变换不放这里，到做运动模糊时另定。

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
| | `PRNG_SURFACE_BSDF` | 3 | 3：前两个定方向，第三个选闭包并复用 | 已落地（只有纯金属的微表面闭包用前两个；上游顶替不用它） |
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
| 1 | `FILM_DENOISE_ALBEDO` | rgb 降噪用的反照率的累加和；w 不透明度的累加和 | 累加 | 反照率已落地，但是上游的口径（相机首次命中的底色）；不透明度已定义，恒 0 |
| 2 | `FILM_DENOISE_NORMAL` | xyz 降噪用的法线的累加和；w 覆盖率计数 | 累加 | 法线已落地，但是上游的口径（世界空间）；覆盖率计数已定义，恒 0 |
| 3 | `FILM_LEGACY_VARIANCE` | 上游降噪用的两个量：x 亮度的和，y 亮度平方的和 | 累加 | 已落地（上游）。换降噪器时腾出来 |
| 4 | `FILM_LEGACY_EMIT` | 上游 `--signals` 的一组：相机直接看到的光 | 累加 | 已落地（上游，只在开了 `--signals` 时写） |
| 5 | `FILM_LEGACY_SPEC` | 上游 `--signals` 的一组：首次命中处的高光部分 | 累加 | 同上 |
| 6 | `FILM_AUX_DATA` | x 深度，y 实体编号（存成浮点数值），zw 运动矢量 | 辅助样本覆盖写一次 | 已定义 |
| 7 | `FILM_AUX_NORMAL` | xyz 法线（相机空间，长度 1） | 同上 | 已定义 |
| 8、9 | | 预留 | | 预留 |
| `film_lightgroup_first` 起 | | 第 k 个灯组的 rgb 累加和 | 累加 | 已定义，没有场景走到过 |

**步长的规矩**：

- **步长只许读全局参数**（`P.film.film_stride`；灯组的起点读 `P.film.film_lightgroup_first`）。**任何一侧都不许自己算**，也不许写死数字：内核里步长只在 `film_pixel_first` 一处乘；Rust 一侧读回时按参数里的步长分块。
- **步长不小于 10 加灯组数。** 实际由 `KernelFilm::new` 向上取到 4 的倍数（每个像素的记录对齐到 64 字节）：不请求灯组时是 12，不是 10。这是量出来的：苹果显卡上步长 10、11 的稳态比步长 12、16 慢 5%。末尾多出来的格子没人读写；代价是缓冲大两成，个别分辨率下能请求的灯组数少至多 3 个。
- `FILM_FIXED` 只用来让两侧对数；内核读的是全局参数。

**灯组**：

- 灯组数是这次渲染请求的灯组数，不是场景里的。开渲之前按 `步长 × 16 × 宽 × 高` 算缓冲大小（`film_bytes`），超过显卡单个缓冲绑定的上限就报错，并写明这个分辨率下这次最多能要几组。参考数：英伟达那块显卡上单个缓冲最大 2 GiB，4K 时每像素最多 16 个 vec4，也就是 6 个灯组。
- 输出通道的灯组在代码里统一叫 `lightgroup`。它与上游那个「每 16 盏灯一组的包围球表」（`LIGHT_GROUP`、`light_group_at`）不是一回事。
- 请求灯组的入口现在只有 Rust 的 `Params.film = KernelFilm::new(n)`；命令行与任务描述里还没有请求灯组的字段。读回在 `Frame.lightgroups`（每组一层，每个像素的均值）。

几条写死的语义（通道的名字、单位、取法照仓库里已经冻结的通道契约，这里只定它们在缓冲里的位置）：

- 深度是相机 Z 方向的平面深度，不是到相机的距离。什么都没打到：编号 0、深度 1e10、法线与运动全 0。
- 深度、编号、法线、运动四个量每个像素取同一个**辅助样本**，不做平均。辅助样本是独立的一条射线：过像素中心、孔径按 0、快门按 0；它不是颜色样本里的某一个，也不计入样本数；不取任何随机数、不调图案节点，两遍必须逐位相同。它在清零之后、第一个颜色样本之前跑，同一个入口按 `pass_kind` 分支。
- 覆盖率 = 颜色样本里「首次命中的编号（没打到或打到非实体记 0）等于辅助样本的编号」的个数，除以颜色样本数。
- 灯组的贡献和颜色的贡献是同一个值（夹取之后的），在同一处写。
- Cycles 自己只有深度和编号是首个样本覆盖写，法线和运动是累加再平均；它在背景处写的深度是 0。对拍时那边另渲一遍辅助层并换算，不拿 Cycles 的累加值比。

### 只经 `film_` 开头的函数读写

积分器不直接下标 `film`（库测试查：`film[` 只出现在 `film.wgsl` 里）。

| 函数 | 做什么 | 状态 |
|---|---|---|
| `film_pixel_first()` | 这个像素在 `film` 里的第一个 vec4。步长只在这里乘 | 已落地 |
| `film_add_light(L, bounce, lightgroup)` | 路径上的一次贡献（已乘通量、已夹取）：加进这个样本的颜色；`lightgroup` 不是 `LIGHTGROUP_NONE` 时，同一个值直接加进那个灯组（还要求槽位小于请求的灯组数、值是有限的）。`bounce`：这次贡献出在路径的第几个顶点，现在没人用（留给按直接光、间接光分夹取上限） | 加进颜色的一支已落地（主循环 11 处调用）。**往灯组里写的那一支已定义，没有场景走到过**：各处传的都是 `LIGHTGROUP_NONE` |
| `film_write_aux(AuxSample)` | 写辅助样本的两格，覆盖写 | 已定义、无调用者（辅助那一趟调度还没有） |
| `film_write_sample(SampleResult)` | 样本结束时写其余通道。每个样本调一次。四格先都读出来再写回去（读一格写一格地交替，苹果显卡上稳态慢约 1%） | 已落地 |

`SampleResult`（一个样本的结果）是模块级的私有变量 `film_sample`，随路径推进累加：

| 字段 | 类型 | 含义 | 状态 |
|---|---|---|---|
| `alpha` | f32 | 这个样本的不透明度 | 已定义，恒 0 |
| `L` | vec3 | 颜色：这条路径上各次贡献之和。只由 `film_add_light` 加 | 已落地 |
| `albedo`、`normal` | vec3 | 降噪用的反照率与法线（上游的口径） | 已落地 |
| `legacy` | `SampleLegacy` | 上游 `--signals` 要的几样 | 已落地，接上正式的通道之后删 |

`AuxSample`：`depth`（f32）、`object_id`（u32，小于 2^24）、`motion`（vec2）、`normal`（vec3）。已定义。

现在一次 `film_add_light` 里还是几盏灯的和，夹取也还留在调用处（上游的亮度夹取）。把算灯的函数改成逐盏调用、带上灯组槽位是做灯的人的活；把夹取换成 Cycles 的口径是移植闭包的人的活。

读回与写文件：Rust 读回时按 `FILM_*` 取，除以样本数。上游的 `--hdr`、图像输出、CPU 降噪读的还是颜色、反照率、法线与两个方差量，结果不变。

## 落地时与当初设计不一样的地方

设计是先写下来的，落地时有些地方照不了字面。都列在这里；各处的原因在对应代码的注释与 [PROVENANCE.md](PROVENANCE.md) 里。

**材质**

1. 闭包的种类字段叫 `kind`，不叫 `type`（保留字）。
2. 材质求值不是一个函数，是三步加只算透明度的一档；`shader_setup_from_hit` 往指针里填，不按值返回。
3. 背面的判法沿用上游（点积不小于 0 算背面），不是 Cycles 的（小于 0 才算）。
4. `surface_shader_prepare_closures` 不是空壳：上游的 `Lobes` 在这里算，而且纯金属的着色点上也算。它不收路径状态参数。
5. 纯金属闭包的粗糙度带着上游的 0.02 下限；`ShaderInputs.roughness` 自己不带。
6. `ShaderInputs` 比原定的字段表多三项：`flags`、`coat_weight`、`transmission_weight`。
7. `BsdfSample` 多一个 `weight`。上游顶替的采样在自己的函数里照上游原样的式子把权重算好，不填 `eval`。
8. 微表面闭包的采样没有用采样函数自己返回的求值与密度（Cycles 的做法），而是采到方向后再求值一遍。换成 Cycles 的做法会再有一次像素末位的变化。
9. `sampled_roughness` 的口径是粗糙度（alpha 的平方根），不是 Cycles 的 alpha：积分器拿它算射线锥与「镜面路径」。
10. 上游顶替专用的求值返回 `{ eval, spec_frac }`，不带概率密度；要密度的地方直接调上游的 `pdf_bsdf`。
11. 灯光一侧的多重重要性采样（上游的 `light_mis`）没有经闭包的分发：纯金属的密度仍经上游的 `pdf_bsdf` 拿（它里面调的是同一个移植函数）。
12. 新增按闭包种类分发的 `bsdf_eval`，收一个闭包而不收整个着色点。
13. `shader_eval_shadow` 收的是命中、方向与距离，不是着色点。
14. 能量补偿对纯金属的闭包读材质记录的那一位，对上游顶替仍读全局开关。
15. 边缘色按场景特性位决定读不读材质记录。
16. `ShaderInputs.alpha` 只是材质记录里的值，不含贴图的透明度。

**光线负载**

17. 路径状态是模块级的私有变量，不当参数传。
18. `legacy` 里的东西比原定的多（十八项，见上），射线锥不在里面，挪到了 `Ray`。
19. `PATH_RAY_MIS_SKIP` 的设与清留在主循环里，没有挪进 `path_state_next`。
20. 路径标志位与可见类是两个枚举（原来只列了前一个）。
21. `Ray` 的两个向量排在最后；相机光线没有单独的函数与文件。
22. `trace_local` 的返回值多一个 `lcg_state`。
23. 弹射上限、轮盘起始深度、夹取没有接到 `integrator` 块：仍读上游的字段。

**随机维度**

24. `path_rng_*` 不带状态参数；`PRNG_BOUNCE_NUM` 在 `integrator.wgsl`，不在 `sample.wgsl`。
25. `rng_legacy` 的编号是「偏移加槽位」过一次哈希取 30 位、最高两位置成 10，不只是「最高位置 1」；`rng_sub` 的最高两位是 11。
26. 上游的相机与俄罗斯轮盘两个槽位（0 与 2）退役。
27. 「全部编号互不相同」没有做到介质跟踪步那一块（见上）。
28. `seed` 里放的是哈希之后的用户种子；全局种子与掩码都从 `integrator` 块读，`size.w` 停用。

**输出通道**

29. 固定部分是 10 格（原定 8 格加灯组），多两格预留。
30. 步长取到 4 的倍数，不等于 10 加灯组数。
31. 上游的两个方差量从反照率、法线两格的 w 里挪到了第 3 格。
32. 一个样本的结果是模块级的私有变量；`film_add_light` 往它上面加，不直接写颜色那一格。
33. 灯组数没有「上限 254」：上限由显卡的单个缓冲大小在开渲前算。
34. 辅助那一趟调度没有做，`film_write_aux` 没有调用者。

**分文件**

35. 内核的主着色器按阶段分成了八个文件（多一个体积），没有相机文件。

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

再要加东西：在末尾追加自己命名的一整块，在这里登记块名与主人。上游的 `size.w` 是停用后的预留格。

### 新表首地址的 8 格（`Params.table_first_ext`）

| 格 | 去向 | 状态 |
|---|---|---|
| `[0].x` | 物体扩展表 | 已落地（表全 0） |
| `[0].y` | 图案节点表 | 已定义，0 |
| `[0].z`、`[0].w` | 广义 Schlick 的两张能量表 | 已定义，0 |
| `[1].x` 到 `[1].w` | | 空闲 |

### 输出缓冲的各格（`film` 每个像素的固定部分）

| 格 | 名字 | 状态 |
|---|---|---|
| 0 | `FILM_COMBINED` | 已落地 |
| 1 | `FILM_DENOISE_ALBEDO` | rgb 已落地；w 已定义 |
| 2 | `FILM_DENOISE_NORMAL` | xyz 已落地；w 已定义 |
| 3 | `FILM_LEGACY_VARIANCE` | 已落地（上游）；zw 空着。换降噪器时整格改标预留 |
| 4 | `FILM_LEGACY_EMIT` | 已落地（上游）；w 空着。接上正式通道后改标预留 |
| 5 | `FILM_LEGACY_SPEC` | 同上 |
| 6 | `FILM_AUX_DATA` | 已定义 |
| 7 | `FILM_AUX_NORMAL` | 已定义；w 空着 |
| 8、9 | | 预留 |
| 10 起 | 灯组，每组一格 | 已定义 |

### 场景特性位

内核按场景用到的功能编出不同的变体（上游的办法，`FEAT` 的各位）。北冥加的一位：`F_SPECULAR_TINT`（第 28 位），见「材质记录」。两侧同名，库测试 `feature_bits_are_distinct` 查各位互不相同、两侧同值。

### 不靠机器、靠人复核的

- `legacy` 的例外清单（哪些地方还在读上游的结构）是注释里的一张表，没有机器检查。
- 「新写的代码不许用 `rng_legacy`」「新写的代码里只有 `shader_eval_inputs` 读材质记录」「进函数级比对的函数签名只收标量与向量」靠复核把关。

## 锁

改了这四样而没同步，下面的检查会红。

| 检查 | 在哪 | 守什么 |
|---|---|---|
| `freeze.mjs` | `../chassis/freeze.mjs`，测试 `../chassis/freeze.test.mjs` | 冻结标记在；标记钉住的结构定义、常数、函数签名与着色器一致；登记类的编号都进了标记；条文提到了标记钉住的每个名字 |
| `the_material_record_is_the_kernels` | `src/merged.rs` | `Material` 两侧逐字段同名、同偏移、同总长度（合并布局的那一份也比）；`flags` 各位两侧同值；默认值；能量补偿位的写法 |
| `the_parameters_are_the_kernels` | `src/merged.rs` | `Params`、`KernelIntegrator`、`KernelFilm`、`ObjectExt` 两侧逐字段同名、同偏移、同总长度；种子是哈希后的值；步长取整的规矩 |
| `the_film_layout_is_the_kernels` | `src/merged.rs` | `FILM_*` 两侧同值；`film` 只在 `film.wgsl` 里下标；步长只在一处乘；缓冲大小的算法与报错 |
| `the_closure_kinds_keep_their_numbers` | `src/merged.rs` | 闭包种类号的快照：已有的数值不变，新种类要先登记 |
| `the_bounce_stride_is_the_kernels` | `src/merged.rs` | `PRNG_BOUNCE_NUM` 两侧同值 |
| `call_structs_are_not_built_by_position` | `src/merged.rs` | 只活在一次调用里的结构没有位置式构造。名单在测试里，新加这类结构要补 |
| `every_kernel_variant_generates_spirv_and_msl` | `src/gpu.rs` | 内核的每个变体（80 个）都过 SPIR-V 与 MSL 两个后端的代码生成 |
| `path_state_is_written` | `src/gpu.rs` | `PathState`、`Ray` 的字段名单；路径状态里「已写未读」各项的写入语句都在 |
| `shading_point_is_written` | `src/gpu.rs` | `ShadingPoint`、`Closure`、`ShaderInputs` 的字段名单；它们与 `Ray` 里「已写未读」各项的写入语句都在 |
| `the_dimension_ids_are_distinct` | `src/sample.rs` | 随机编号在登记的区段里互不相同（范围见上） |
| `the_shader_is_this` | `src/sample.rs` | 取数接口在显卡上的数与 CPU 上的镜像相同（要显卡） |
| `requested_lightgroups_leave_the_picture_alone` | `src/gpu.rs` | 请求灯组不改变画面，读回的灯组层数对（要显卡） |
| 照 Cycles 取值的常数 | `../chassis/freeze.test.mjs` | 路径标志位与可见类、随机维度的枚举与 `PRNG_BOUNCE_NUM`（两侧）、菲涅耳种类、两个着色点标志、采样标签，与 Cycles 头文件里的同名枚举逐个相等。**本机有 Cycles 源码缓存时才比，没有就跳过** |

两条静态测试（`path_state_is_written`、`shading_point_is_written`）查的是写入语句在不在，不是运行时的值。「已写未读」的字段运行时的值对不对，要等读它的人接上之后由读数来验。

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
3. 每张图：全图均值的相对差不超过 1e-6；超过 1e-5 的像素不超过全图像素的千分之一。
4. 超过 1e-5 的像素要有交代：换种子后位置不固定，或者在改之前的程序里加一个末位的扰动能在同样的位置复现。

不设「最大像素相对差」这样的逐像素上界：路径追踪里有硬边（灯的边沿、物体轮廓、分支判断），只要允许末位变化，个别像素打中与没打中就会翻。

**用统计判据的地方，种子至少 32 个。** 8 个种子估出来的标准误尾巴很重：落地过程中出现过三次「差 3.5 到 4.6 个标准误」，加种子（64 个）重判都回到 1 以内。遇到落在 3 到 5 个标准误之间的，先加种子，别急着找原因。

**第 2 级解析场景的判法**（两个矩形面光读数，种子 1 到 8、每个 4096 采样）：像素均值对解析值的相对差在 **0.2% 以内，且在 3 个标准误或相对 1e-5 以内**（`level2.mjs` 的 `GATES` 与 `analyticOk`）。

后一半那条「相对 1e-5」是**单精度的底**，是量出来的：

- 这两个读数的标准误小到相对 1e-6 以下，比读数自己的数值精度还小。
- 同一串随机数在两块显卡上算出来，系统地差 2e-7 到 6e-7；两块显卡对解析值都有 3e-6 以内的固定偏离。偏离从哪来没有查清。
- 只按 3 个标准误判时，同一个内核换一组种子就有四分之一上下的概率不过：800 个种子分成 100 组（每组 8 个）实测 28 组不过。原先能过是那一组种子的运气。
- 加上这条底之后同样的 100 组 0 组不过，各组均值对解析值的偏离最大 5.2e-6。

代价：相对 1e-5 以下的系统误差这条门看不见了。三个负对照不走这条判法（它们按 0.2% 判，读数远在门外），不受影响。

**计时**：回归工具每次量两个数（着色器首次编译的毫秒数、一个固定场景 256 采样的稳态秒数）。稳态对结构落地之前累计慢 10% 以上要停下来报告；首次编译只记录。结构落地之前是苹果显卡 1.522 秒、英伟达显卡 0.114 秒；落地之后是 1.60 秒与 0.123 秒上下，英伟达显卡上余量很小。

## 还没接的

每个「已定义」「已写未读」「无调用者」的字段或函数，等后面哪一类工作来接。

| 东西 | 现在 | 等谁来接 |
|---|---|---|
| `Closure` 的 `ior`、`exponent`、`reflection_tint`、`transmission_tint`；`sample_weight`、`fresnel_type` 的读者；`alpha_y` 的读者 | 已定义或已写未读 | 移植闭包 |
| `CLOSURE_BSDF_DIFFUSE`、`CLOSURE_BSDF_TRANSPARENT`；`FRESNEL_*` 里除 F82 之外的五种 | 只占了号 | 移植闭包 |
| `ShaderInputs` 的 `ior`、`specular_ior_level`、`alpha`、`diffuse_roughness`；`Material` 的 `specular_ior_level`、`diffuse_roughness` 的读者 | 已写未读 | 移植闭包 |
| `MATERIAL_FLAG_CLASS_*`、`MATERIAL_CLASS_*`；材质记录的 6 个预留格 | 已定义 | 移植闭包 |
| `surface_shader_bsdf_bssrdf_pick` 的多闭包选法；`surface_shader_bsdf_sample_closure` 里并入其余闭包的贡献 | 骨架 | 移植闭包 |
| `surface_shader_transparency`、`shader_eval_shadow`；`CLOSURE_BSDF_TRANSPARENT`；`PATH_RAY_VISIBILITY_SHADOW_*` | 已定义、无调用者 | 移植闭包（透明闭包），并把上游求交里的镂空与穿玻璃改道过来 |
| `PathState` 的四个分类计数；`path_state_next` 里的计数、上限与其余 `PATH_RAY_*` 位；`min_ray_pdf` 的读者（滤光泽）；`integrator` 块的弹射上限、`min_bounce`、两个夹取、`filter_glossy` | 已定义或已写未读 | 移植闭包 |
| `BsdfEval` 的 `diffuse`、`glossy`；`BsdfSample` 的 `eval`、`eta` 的读者；`pass_diffuse_weight`、`pass_glossy_weight` | 已定义或已写未读 | 移植闭包（分通道对拍） |
| `surface_shader_bsdf_eval`（与它的 `light_shader_flags`）、`shader_eval_emission` | 已定义、无调用者 | 做灯 |
| `PRNG_LIGHT`、`PRNG_LIGHT_TERMINATE`；`integrator` 块的 `light_inv_rr_threshold` | 已定义 | 做灯 |
| `state.visibility`、`state.mis_ray_object`、着色点的 `object` 的读者；`ObjectExt` 的 `receiver_light_set`、`lightgroup` | 已写未读或已定义 | 做灯（灯光链接、灯组） |
| `film_add_light` 往灯组里写的那一支、它的 `bounce` 参数；把算灯的函数改成逐盏调用 | 已定义，没有场景走到过 | 做灯 |
| 上游的灯光函数、`surface_shader_bsdf_eval_legacy`、`light_mis` 与 `pdf_spec` 里读 `Lobes` 的地方、各 `D_*` 槽位 | 上游顶替 | 做灯（移植完删） |
| `trace_local`；着色点的 `lcg_state`、`object_flag`、`prim`、`u`、`v`、`N`、`ray_length` 的读者；`Ray` 的 `self_object`、`self_prim`、`tmin` 的读者 | 已定义、无调用者，或已写未读 | 图案节点（倒角、遮蔽） |
| `PRNG_SURFACE_AO`、`PRNG_SURFACE_BEVEL`、`path_branched_rng_2D`、`path_rng_2D` | 已定义、无调用者 | 图案节点 |
| `Material` 的 `pattern_first`、`pattern_count`；`MATERIAL_FLAG_NO_LEGACY_FUNCTION`；`table_first_ext` 的图案节点表一格；`ObjectExt.object_flag` 的写入 | 已定义 | 图案节点 |
| `table_first_ext` 的两格能量表；`FRESNEL_GENERALIZED_SCHLICK` | 已定义 | 移植闭包（广义 Schlick） |
| `film_write_aux`、`AuxSample`、`FILM_AUX_DATA`、`FILM_AUX_NORMAL`；`pass_kind` 与辅助那一趟调度；`FILM_DENOISE_ALBEDO.w`（不透明度）、`FILM_DENOISE_NORMAL.w`（覆盖率）；`SampleResult.alpha`；`background_transparent`；`first_hit_object` | 已定义、无调用者 | 接输出通道 |
| 请求灯组的命令行与任务描述字段 | 没有 | 接输出通道 |
| `ObjectExt.entity_id` 的写入；`object_ext_at` 的第一个调用者 | 已定义、无调用者 | 场景读入与接输出通道 |
| `FILM_DENOISE_ALBEDO`、`FILM_DENOISE_NORMAL` 换成 Cycles 的口径；`bsdf_albedo` 的口径；`FILM_LEGACY_VARIANCE`；`denoising_feature_throughput`；`PATH_RAY_DENOISING_FEATURES` | 上游的口径 | 降噪 |
| `sobol_index_mask` 的算法、`sampling_pattern`、分支版取数的有效样本数 | 上游写死的值 | 降噪与采样 |
| 着色点与光线的 `time` | 已定义，恒 0 | 运动模糊 |
| `ObjectExt` 的两个阴影终止偏移 | 已定义 | 平滑网格 |
| 介质一侧的 `rng_legacy` 槽位（`D_FOG`、`D_MEDIA`、`D_PHASE`、`D_VOL_LIGHT`）；跨射线的跟踪步编号相撞 | 上游顶替 | 移植体积 |
| 主循环相机命中处那批没人读的局部量（实时预览留下的），与只为它们活着的 `pdf_spec` 调用 | 死量 | 做灯时顺手删（删它要再过一遍两台机器的回归） |

## 改动的规矩

1. **不算破坏的**（直接做，过回归）：给只活在一次调用里的结构加字段；加新函数；给返回结构加字段；往预留格里填并起名；在 `Params` 末尾追加一块；删 `legacy` 的字段与函数；把「已定义」的字段接上。
2. **要先拿号的**：闭包种类号、材质 `flags` 的位、每次弹射的随机维度、全局参数的追加块、新表首地址的格子、输出缓冲的格子。向核心帧源的负责人要，登记进上面的登记表。
3. **破坏性的**（改已有字段的名字、含义、位置；改进缓冲的格式的长度；改已有函数的参数表；改已有编号的数值）：先经核心帧源的负责人同意。
4. 凡是动到冻结标记钉住的东西（第 1 条里的加字段、第 2 条、第 3 条都会）：改这份条文里对应的字段表或登记表，升 [FREEZE.json](FREEZE.json) 里的版本号（不算破坏的升末位，破坏性的升首位），运行 `node beiming/sources/core/chassis/freeze.mjs --update`，把标记的差异与改动放在同一个提交里。
5. 每一步：`cargo test --locked`、`freeze.mjs`、两台机器上的 `regress.mjs --check`。有意改变渲染结果的改动过后，两台机器各重记一次基线。
