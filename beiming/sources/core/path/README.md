# 核心帧源 · 路径追踪内核

读者｜维护者与全部 agent　内部结构的条文｜[STRUCTURES.md](STRUCTURES.md)　来源与许可｜[PROVENANCE.md](PROVENANCE.md)、[LICENSE-upstream.txt](LICENSE-upstream.txt)

离线路径追踪渲染程序 `core-render` 的源码（Rust 加 WGSL）。从开源路径追踪器 ThreeRT 的一个固定提交分叉，只留离线渲染一路，由本仓库自己维护；照 Cycles 移植的闭包与面光在 [../shaders/](../shaders/)，内核直接读那里的文件。

## 目录

| 路径 | 内容 |
|---|---|
| `src/` | 渲染器：场景装载、加速结构、GPU 路径追踪、后期、内嵌的场景脚本引擎；`main.rs` 是命令行 |
| `shaders/` | 内核着色器，按阶段分文件：`pathtrace.wgsl`（开头：编译开关、常数、全局参数、各张表）、`intersect.wgsl`（求交）、`trace_hw.wgsl`（硬件求交）、`shader.wgsl`（材质求值）、`closure.wgsl`（闭包）、`light.wgsl`（灯光）、`volume.wgsl`（雾与介质）、`integrator.wgsl`（路径状态、光线、相机光线与积分主循环）、`film.wgsl`（输出）、`sample.wgsl`（采样序列与随机维度的编号）、`hash.wgsl`（照 Cycles 移植的哈希函数，Apache-2.0）、`records.wgsl`（共用记录）。拼接次序在 `src/gpu.rs` 的 `KERNEL_FILES` |
| `STRUCTURES.md`、`FREEZE.json` | 内核四样内部结构（材质记录、光线负载、随机维度、输出通道）的条文与冻结标记：每个字段的含义与状态、编号登记表、改动的规矩。标记钉住着色器里的结构定义、常数与函数签名，由 `../chassis/freeze.mjs` 核对 |
| `presets/` | 两档渲染预设 |
| `tests/render/data/` | 库测试读的一个小模型 |
| `Cargo.toml`、`Cargo.lock`、`rust-toolchain.toml` | 包清单、依赖锁、固定的 Rust 版本（1.100.0） |

## 编

要 Rust（rustup 会按 `rust-toolchain.toml` 自动取 1.100.0）。在本目录：

```sh
cargo build --locked --release     # 程序在 target/release/core-render
cargo test --locked                # 库测试，部分用例要能跑 wgpu 的显卡
```

`target/` 被忽略，不进 git。平时不用手动编：第 2 级的脚本会把构建目录放到仓库根被忽略的 `out/` 下。

## 测

改了本目录或 `../shaders/` 之后，在仓库根跑第 2 级（渲图对 Cycles 读数与解析值，外加负对照与确定性）：

```sh
node beiming/sources/core/chassis/level2.mjs
node beiming/sources/core/chassis/imaging.mjs    # 成像一路：像素滤波的刀口剖面、Cycles 口径的夹取、滤光泽对 Cycles、负对照（不要上游仓库）
```

退出码 0 全部过，4 有一项不过，3 缺工具链。场景仍用上游的场景库与打包工具，脚本第一次跑会按固定提交把上游仓库取到 `out/` 下（要网络），细节见 [PROVENANCE.md](PROVENANCE.md)。

改内核的内部结构、要求渲染结果不变时，另有一份回归基线：改之前在每台机器上记一次，每改一步核对一次。

```sh
node beiming/sources/core/chassis/regress.mjs --record   # 记基线，写 chassis/regress-baseline/<显卡加后端>.json，随改动一起提交
node beiming/sources/core/chassis/regress.mjs --check    # 与基线比：0 全同，4 有不同，3 缺工具链或这块显卡还没有基线
```

它比第 2 级的 24 个读数（逐位）、上游自带的全部渲染测试场景在软件求交与硬件求交下的状态和原始浮点输出摘要、`cargo test --locked` 的通过数，并记下着色器首次编译与稳态采样的耗时（只提示，不判定）。记基线时连跑两遍找出本来就不确定的场景，登记后只比状态。有意改变渲染结果的改动过后要重新 `--record`。

内核的四样内部结构已经冻结。改了着色器里的结构、常数或函数的参数表之后，核对冻结标记（纯文本检查，不要显卡）：

```sh
node beiming/sources/core/chassis/freeze.mjs             # 0 标记在且与代码一致，4 没有标记或不一致
node beiming/sources/core/chassis/freeze.mjs --update    # 有意改了之后，按现在的代码重写标记里钉住的值
```

### 显卡上限全文

`core-render info --limits` 在 stdout 打一行 JSON（`format` 是 `core-limits/0.1`），不渲帧：适配器信息 `adapter`（名字、厂商号、设备号、类型、驱动、后端、子组大小）、实际开没开硬件求交 `hwrt`、是不是合并的绑定布局 `merged`，适配器报的上限 `adapterLimits` 与特性 `adapterFeatures`，以及这台设备实际申请到的 `deviceLimits` 与 `deviceFeatures`。上限的键是 wgpu 的字段名，值都是整数。设备怎么申请照 `src/gpu.rs` 的 `new_async_with`：单个存储缓冲绑定、单个缓冲、二维纹理、纹理层数与加速结构的几项抬到适配器的上限，每阶段的存储缓冲数与缓冲加加速结构数不超过 31，其余取 wgpu 默认值与适配器两者中较差的；特性只请求硬件求交、时间戳查询、管线缓存三样（适配器有、开得起来时）。不加 `--limits` 时 `info` 照旧打一行摘要。

每台机器记一份，随提交入库：

```sh
node beiming/sources/core/chassis/limits.mjs [--bin core-render]   # 写 chassis/limits/<显卡加后端>.json（命名同回归基线）；--print 只打印
```

### 场景包同帧两遍

```sh
BEIMING_CORE_TEST_PACKS=<包目录>[:<包目录>…] node beiming/sources/core/chassis/rerender.mjs [--bin core-render] [--frame k] [--spp 256] [--width 1280 --height 720] [--seed 0]
```

同一个场景包、同一帧、同一个内核种子（`THREERT_SEED`），两个独立的 `render-pack` 进程各渲一遍，比每个产物的 sha256：`--passes` 的每个通道文件（`color.f32` 是未降噪的颜色）、`--hdr` 的线性颜色（降噪之后）、PNG。软件求交（`THREERT_HWRT=0`）与硬件求交（开得起来时）各两遍；第一遍的出层再转一次多层 EXR（`passes-exr.mjs`）读回逐位比。结果写 `chassis/rerender/<显卡加后端>.json`，随提交入库。场景包不进仓库，记录里只有包的 id 与内容摘要（包里全部文件按相对路径排序，路径加内容一起算 sha256），不写目录；`--frame` 不给时取包帧数的一半向下取整。两遍有不同或 EXR 往返不同退出 4（记录照写），没给场景包或拿不到显卡退出 3。

## 读场景包

内核除了跑场景脚本，还能直接读场景包契约（`beiming/kernel/contracts/scene-pack/`）的包：`src/pack.rs` 读清单、GLB、实例表与每帧状态表，逐字段校验，选一帧建成内核的场景。

```sh
core-render pack-info <包目录> [--frame k] [--record 核对记录.json]       # 不渲，stdout 一行统计（三角形数是从几何文件实际读到的每个网格的三角形数，乘以这一帧画出来的实例）；--record 写场景包核对记录
core-render render-pack <包目录> -o out.png [--frame k] [--spp N] [--width W --height H] [--hdr out.raw] [--no-denoise] [--stats s.json] [--passes 目录]
                       [--pixel-filter box|gaussian|blackman-harris] [--filter-width 像素] [--clamp-direct 上限] [--clamp-indirect 上限] [--filter-glossy 模糊]
```

- 像素滤波、夹取、滤光泽照 Cycles 的口径（`src/main.rs` 的 `CyclesFilm`），取值范围照 Blender 界面的属性：
  - `--pixel-filter`、`--filter-width`（0.01 到 10 像素）：像素滤波，默认盒式宽 1。不是盒式宽 1 时宿主一侧照 Cycles `scene/film.cpp` 建一张重要性采样表（`src/pixel_filter.rs`），相机射线的像素内偏移拿一个随机数查它（编译开关 `pixel_filter`），每个样本的权重是 1。盒式宽 1 不查表，与不加参数逐位相同。Blender 同步到 Cycles 时盒式强制宽 1（界面上的默认宽度 1.5 只对高斯、Blackman-Harris 起作用），所以参考包的 `pixelFilter: "box"` 就是这里的默认。
  - `--clamp-direct`、`--clamp-indirect`（0 到 1e8）：Cycles 的直接光、间接光夹取上限。写进全局参数时乘 3（Cycles 比的是一次贡献三个分量绝对值之和），0 是不夹（默认）。有一个不是 0 时内核用编译开关 `sample_clamp` 的变体。背景与路上找到的发光按「弹射数减 1」选上限：相机直接看到的、经一次反射看到的天空走直接光的上限，两次反射以上才走间接光的。
  - `--filter-glossy`（0 到 10）：滤光泽，写进全局参数的是 1 / 用户值，0 是不滤（默认）。
  - 要对 Blender 的 Cycles：`render-pack` 默认的预设（cinematic）能量补偿是 0、弹射上限 8，而原理化 BSDF 默认的分布是多重散射 GGX。对拍时加 `--override '{"native":{"energyCompensation":1,"maxBounces":128}}'`（第 2 级的滤光泽一项就是这样渲的）。
  - `render-pack` 一路不用上游的亮度夹取（场景预设的 `clampIndirect` 换算出的 `misc.x`，电影预设是 64）：物理参考是不夹的。从场景脚本进来的渲染照旧用它。
  - 第 2 级判据与负对照在 `../chassis/imaging.mjs`（刀口剖面、经奇异镜子看天空的夹取、焦散场景的滤光泽对 Cycles 的读数 `../chassis/cycles-filter-glossy.json`），测试 `../chassis/imaging.test.mjs`。

- 场景包本身的毛病（清单、文件、帧号）读不对时，stderr 最后一行是 `{"error":{"code","at","message"}}`：`at` 是出错字段的路径（如 `lights[2].watts`），码取错误码表里已有的（结构不对 `contract.bad-value`、没定义的键 `contract.unknown-key`、未知的图案节点 `contract.unknown-node`、契约允许但这里装不了的 `contract.unsupported-input`、帧号出界 `usage.bad-argument`），退出码照码的前缀。命令行参数本身的错（如 `--override` 不是合法的 JSON）不走这一行。
- 文件整个读进内存，所以读之前先查大小：单个文件不超过 1 GiB，三张每帧状态表照 shape 合计不超过 2 GiB，超了报 `contract.bad-value`（`at` 是那张表的 shape，或几何文件的 `geometry.file`）。
- 实例矩阵原样进实例表；镜像实例（第四列是 1）平铺时翻转绕序，实体编号与镜像位写进物体扩展表。灯的功率照 Cycles 的口径换算，式子与出处写在 `src/pack.rs` 的 `kernel_light`。图案节点与灯光链接只解析、校验，还不生效。
- 一行实例这一帧画不画：左上 3×3 的九个数全为 0 的不建（契约 5.4）；九个数不全为 0 但行列式为 0 的（压扁成一个面、一条线），内核建场景时也不画（按 32 位浮点算，行列式的绝对值不超过 1e-30 就算 0），即行列式为 0 的那一帧这个实例不画。`pack-info` 的 `drawn` 与 `triangles` 都不算它。
- 镜像在画面上量不出来：内核着色时把几何法线翻向来路、再让着色法线与它同侧（`shaders/shader.wgsl` 的 `surface` 与 `surface_proc`），不透明表面画出来与三角形的绕序无关，去掉翻转画面只差浮点末位。所以没有显卡上的负对照，镜像由核对记录的 SP7 与它的负对照（去掉翻转后 SP7 必须不过）守着。
- `--passes 目录`：照输出通道契约（`beiming/kernel/contracts/passes/`）出层，每个通道一个文件，没有文件头、行主序（行从上到下，像素从左到右，一个像素里各分量挨着）、每个数 4 字节小端，文件名「通道名.类型」：`color.f32`（R、G、B、A；RGB 是样本均值、已经预乘 A）、`depth.f32`（Z，平面深度，米；什么都没打到 1e10）、`objectId.u32`（id，实体编号；0 是没打到任何实体）、`objectId.coverage.f32`（coverage：objectId 的两个分量类型不同，另放一个形状相同的文件）、`normal.f32`（X、Y、Z，相机空间：看 -Z、Y 向上）、`denoiseAlbedo.f32`（R、G、B）、`denoiseNormal.f32`（X、Y、Z，Cycles 降噪特征的相机空间：看 +Z、Y 向上）；外加通道声明 `passes.json`（`passes/0.1`，只列这六个通道）。stdout 统计多一段 `passes`：每个通道的文件、形状 `[高, 宽, 分量数]`、分量名与类型。depth、objectId、normal 取辅助样本（每个像素一条，过像素中心、针孔，不取随机数），不做平均；coverage 是首次命中的实体编号等于它的颜色样本所占的比例。背景对相机不可见（`world.visibleToCamera` 是 false）时，相机射线什么都没打到的样本 A 与 RGB 记 0。不出 motion（场景包只有整数帧的状态）与分灯组。通道声明里没有 motion，PS1 对出层方的要求这一项不满足，原因是场景包只有整数帧的状态。要辅助层不改颜色：同一个包加不加 `--passes`，颜色逐位相同。要辅助层时用内核的另一个变体（编译开关 `aux`：多一个入口 `aux_sample` 跑辅助样本，颜色样本数覆盖率）；不加 `--passes` 时编出来的颜色内核里没有这两样，不为辅助层多花时间。计时在 stdout 统计的 `timings_ms.aux_ms`。
- 测试在 `../chassis/scenepack.test.mjs`（写出器是同目录的 `scenepack.mjs`，自己拼 GLB）：`BEIMING_CHASSIS_E2E=1` 时现编渲染程序。从 Blender 导出的场景包不进仓库，用环境变量 `BEIMING_CORE_TEST_PACKS` 列出它们的目录（按系统的路径分隔符隔开，每个目录旁边放「目录名.blender-stats.json」），不设就跳过。出层的测试在 `../chassis/passes.test.mjs`：两块前后错开的板（`scenepack.mjs` 的 `platesPack`），测试照内核的取数在 JS 里重算每个颜色样本落在像素里的哪一点、照场景规格自己求交，逐像素对编号、深度、法线与覆盖率，写通道核对记录交给 `passes/check.mjs` 判，并以「辅助层换成颜色样本的平均」做负对照；同一个文件还查透明度、加辅助层不改颜色、两份从 Blender 导出的包每个通道的文件。
- 出层转多层 EXR：`node beiming/sources/core/chassis/passes-exr.mjs <出层目录> --width W --height H [-o frame.exr] [--zip]`。读 `passes.json` 与逐通道文件（层文件没有文件头，尺寸照出层时给），每个分量一个 32 位通道，通道名是「通道名.分量名」（`color.R`、`depth.Z`、`objectId.id`、`objectId.coverage`、`normal.X`、`denoiseAlbedo.R`、`denoiseNormal.Z`…，照输出通道契约 3.1 的登记表；`objectId.id` 是 u32，其余 f32），用 `beiming/verify/exr/exr.mjs` 的 `writeExr` 写单部件扫描线 EXR（默认不压缩，`--zip` 按扫描线 ZIPS），再用 `readExr` 读回逐通道逐字节比，通道名逐个过 `isPassChannel`。往返不逐位相同或名字不在登记表里退出 4。出层目录里有几个通道就转几个，现在是六个固定通道的十六个分量（不出 motion 与分灯组，见上）。

## 降噪的口径

`render-pack` 与 `render` 的 `--hdr`、PNG 是降噪之后的（`--no-denoise` 或预设里 `native.denoise` 为假时不降噪；`--passes` 的 `color` 永远不降噪）。编进了 OIDN（cargo 特性 `oidn`）时先试 `src/denoise.rs` 的 `oidn()`，拿不到设备或出错就退回自带的小波降噪，stats 的 `denoise` 记 `oidn` 或 `atrous`。仓库里现成的构建都没开这个特性（`../chassis/build.mjs` 不加 `--features`），所以到现在出的帧都是小波降噪。

`oidn()` 的参数对着 Cycles（Blender 5.2.3）最终渲染的降噪接法。能读到的 Cycles 源码只有内核里写降噪特征的 `kernel/film/denoising_passes.h` 与界面属性 `blender/addon/properties.py`；宿主一侧的 `integrator/denoiser_oidn.cpp`、`integrator/denoiser_oidn_gpu.cpp`、`device/` 下的 OIDN 设备接法、`scene/` 里 film 与 pass 的设置都没读到，那几行标「未读到」，写的是 OIDN 接口的默认值与对 Cycles 的记忆，要拿到源码核。

| 参数 | Cycles | 改之前（上游原样） | 现在 |
|---|---|---|---|
| 过滤器 | `RT`（未读到） | `RT` | `RT` |
| 输入的层 | 颜色、反照率、法线：界面属性 `denoising_input_passes` 默认 `RGB_ALBEDO_NORMAL` | 同 | 同 |
| 法线 | 相机空间（`denoising_passes.h` 用 `worldtocamera` 变过去），样本累积的均值，乘不透明度与特征权重，不归一 | 世界空间，逐像素归一 | 相机空间的均值，不归一：与出层的 `denoiseNormal` 是同一份 |
| 反照率 | 首次命中处漫反射类闭包的反照率（`denoising_passes.h`） | 内核的反照率均值 | 不变（就是出层的 `denoiseAlbedo`） |
| `hdr` | 开（未读到） | 开 | 开 |
| `hdrScale`（2.x 叫 `inputScale`） | 不设，库从图上估（未读到） | 设成曝光系数 | 不设 |
| `srgb` | 关（未读到） | 关 | 关 |
| 输入乘不乘曝光 | 场景线性的样本均值，曝光在显示变换里（未读到） | 颜色不乘，但曝光经 `hdrScale` 进了降噪 | 不乘，也不进降噪 |
| 预过滤、`cleanAux` | 界面属性 `denoising_prefilter` 默认 `ACCURATE`：先单独降噪反照率与法线，再按干净的辅助层降噪颜色；`FAST` 是颜色与辅助层一起降噪；`NONE` 当辅助层没有噪声。各档在 OIDN 上怎么设（`ACCURATE` 另开两个过滤器预过滤、`cleanAux` 开；`FAST` 关）未读到 | 不预过滤，`cleanAux` 取默认（关） | 不变：相当于 `FAST`。`ACCURATE` 还没做：要单独降噪辅助层的接口，没见到 crate 的源码，不敢写 |
| 质量 | 界面属性 `denoising_quality` 默认 `HIGH`（视口是 `BALANCED`） | `High` | `High` |
| 设备 | 界面属性 `denoising_use_gpu` 默认关：最终渲染在 CPU 上降噪，勾上才用渲染所在的显卡 | 库的默认设备（OIDN 挑最快的一个） | 不变 |

所以要和 Blender 对拍降噪，Blender 那边要设 `denoising_prefilter = 'FAST'`、`denoising_quality = 'HIGH'`，两边的设备要一样（Blender 勾「在 GPU 上降噪」对这里的显卡设备，或这里改用 CPU 设备）。还没实测的：上面标「未读到」的每一行、`oidn()` 能不能编过（本机与工作站的 cargo 缓存里都没有 `oidn` 这个 crate）、编进去之后两边喂同一份带噪输入差多少。没编进 OIDN 的构建不受这次改动影响：小波降噪的输入与代码都没动，相机空间的法线只在编进了 OIDN 时才算。

### 链接 Blender 自带的 OIDN（构建档的设计，还没落地）

不起单独的降噪服务，降噪在 core-render 进程里做；链接的是 Blender 安装里自带的那一份 OIDN 动态库，按 sha256 钉住，与 Blender 降噪时用的逐字节是同一个库。

| 机器 | 库在哪 | 版本 | 文件与 sha256 |
|---|---|---|---|
| 苹果 M5 Pro | Blender 5.2.0 的 `Blender.app/Contents/Resources/lib/` | 2.5.0（`otool -L` 报的 current version；装载名 `@rpath/libOpenImageDenoise.dylib`） | `libOpenImageDenoise.dylib` `f5b32f2f72bcc9797861845c78a48e1e3db45872c5e00db4c2517f2b67a24e92`，`_core` `042318cf91982a50a54aa3a94940508b2b83a9ad953782329898d6a9ef6b212b`，`_device_cpu` `0390327a30062ac90653fa15e9dec931c6d0b83ac3e92eded405fbb70ab936e3`，`_device_metal` `4e9937ed9c8f9244627a3b014f526d4f707c2be29a2fb2aed4c88a9ed191592a`；`libtbb.dylib` `c777383fc753a2cdcda8c3b4c26b3b91629891502e79db1042bb0d4add902926` |
| RTX 5090（Linux） | Blender 5.2.3 官方 Linux 包的 `lib/` | 2.5.0 | `libOpenImageDenoise.so.2.5.0` `640b85e907e420ca4c4c1a320a0c648dd80d746e38e30cd6915c081eede682a1`（`.so`、`.so.2` 是指向它的链接），`_core` `b25bebf5e9ba5058fdecdcabe5c9e990398c072ce2ef7ee5c217636300cc6ed2`，`_device_cpu` `43bac84a37fe6b2083dbf230c10a9166514a5f7432d92c052c97970c51936809`，`_device_cuda` `baa354f85b236ba55719f6f2e6f42c3e43e490b40188685a3b6a7388e2368cd7`；`libtbb.so.12.17` 同目录 |
| RTX 5090（Linux），对 Blender 4.5 | Blender 4.5.16 官方 Linux 包的 `lib/` | 2.3.3 | `libOpenImageDenoise.so.2.3.3` `9a220453d6a7ea32a036559e6579768a312653c9da12b819282f91bf8b2acc11`，`_core` `5ee271c174239386fa68fcad392a0f3e054aefeb9bc36741d409553b06fc09a3`，`_device_cuda` `82521b91a0efb74b5bddbd0976e4cfb42438cb593635120a8727adbfd79edfe8` |

三处都只有动态库：没有头文件（`oidn.h`）、没有 pkg-config 的 `.pc`、没有 CMake 的配置文件。

Rust 一侧用 `oidn` crate（`Cargo.lock` 钉 2.5.1）。从 crates.io 的索引能看到的（本机 cargo 的索引缓存里有这一条，crate 本身没有）：`links = "OpenImageDenoise"`；构建依赖 `pkg-config`（默认特性）；可选特性 `bundled` 会在构建时下载 OIDN 的二进制包（`ureq`、`sha2`、`flate2`、`tar`、`zip`），这里不许开；普通依赖 `bitflags`、`num_enum`。它的构建脚本没读到（crate 不在本机），照记忆：设了 `OIDN_DIR` 就加 `$OIDN_DIR/lib` 进链接路径、链接 `OpenImageDenoise`，没设才用 pkg-config 去找；C 接口的绑定是 crate 里写好的，不现场生成，所以不要头文件。这两点拿到 crate 之后先核，核不上就照实改这一节。

构建档要做的：

1. `../chassis/build.mjs` 加一个开关（比如 `buildRenderer({ oidn: <库目录> })`）：编之前逐个核对上表的 sha256，对不上就拒绝；把 `OIDN_DIR` 设成库目录的上一级（两处 Blender 的布局正好是 `<上一级>/lib/`），`cargo build --locked --release --features oidn`；`RUSTFLAGS` 加 `-C link-arg=-Wl,-rpath,<库目录>`，运行时不靠 `DYLD_LIBRARY_PATH` / `LD_LIBRARY_PATH` 就找得到（OIDN 的核心库再从同一目录装设备库：Mac 上是 `_device_metal`，5090 上是 `_device_cuda`）。
2. 程序的名字（`sourceKey`）把「开了 oidn」和库的 sha256 算进去，与不开的构建分开存；编好后跑一次 `info`，再出一帧看 stats 的 `denoise` 是不是 `oidn`。
3. 2.3.3 一份另编：`Cargo.lock` 只能钉一个 `oidn` 版本，在 `out/` 下的源码拷贝里把它降到 2.3.3（crates.io 上有，依赖相同）再编，库目录指 Blender 4.5.16 的 `lib/`；排在 2.5.0 跑通之后。
4. 许可：只从本机已装的 Blender 动态链接，库不进仓库、不随仓库分发。OIDN（Apache-2.0）的动态链接在 `docs/rights/register.md` 的 R15 已登记；它依赖的 TBB（Apache-2.0）还没登记，落地时补上。

要先取到本机（两台机器都缺；5090 的 cargo 缓存里已有 `proc-macro-crate 3.5.0`，`toml_edit` 有 0.25.15 与 0.25.20、没有锁文件要的 0.25.17），来源都是 crates.io，校验和照 `Cargo.lock`：

| crate | 版本 | 校验和（前 16 位） |
|---|---|---|
| `oidn` | 2.5.1 | `5c750490adf2813d` |
| `num_enum` | 0.7.6 | `5d0bca838442ec21` |
| `num_enum_derive` | 0.7.6 | `680998035259dcfc` |
| `proc-macro-crate` | 3.5.0（只 Mac 缺） | `e67ba7e9b2b56446` |
| `toml_edit` | 0.25.17+spec-1.1.0 | `e3641d5bbb5349a7` |

## 改之前

- 每个文件第一行的来源注释保留。
- 要动材质记录、全局参数、路径状态、着色点与闭包、随机数的编号、输出缓冲，先读 [STRUCTURES.md](STRUCTURES.md)：哪些能直接加、哪些要先拿号、哪些是破坏性的改动，都写在「改动的规矩」里。要新号（闭包种类号、材质标志位、随机维度、全局参数的追加块、新表首地址的格子、输出缓冲的格子）向核心帧源的负责人要，登记进那里的登记表。
- 要求渲染结果不变的改动，改一小步就跑一次上面的 `regress.mjs --check`。显卡的着色器编译器会按上下文合并或重排浮点运算：把一段语句抽成函数、把两个量合到一个函数里算、按值返回一个大结构、把一个除法挪到调用方去做，都可能让像素末位变化，而且两块显卡各有各的敏感处，两台都要跑。已经踩到的几处写在 [PROVENANCE.md](PROVENANCE.md)「北冥加了什么」里。
- 环境变量与场景运行时接口暂时沿用上游的名字，原因见 [PROVENANCE.md](PROVENANCE.md)。
- 从上游挑新改动进来时，在 [PROVENANCE.md](PROVENANCE.md) 末节登记。
