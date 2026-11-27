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

两份记录（上限与下面的两遍）都记 `kernel` 与 `binSha256`：`kernel` 是跑记录的这个程序自己的源码摘要（现编的照 `build.mjs` 的摘要；`--bin` 或环境变量 `BEIMING_CORE_RENDER` 给的程序，从文件名 `core-render-<摘要>` 里取，取不到记 `null`，不拿当前源码的摘要顶替），`binSha256` 是程序文件本身的 sha256。

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
- 实例矩阵原样进实例表；镜像实例（第四列是 1）平铺时翻转绕序，实体编号与镜像位写进物体扩展表。灯的功率照 Cycles 的口径换算，式子与出处写在 `src/pack.rs` 的 `kernel_light`。灯光链接与分灯组生效（照 Blender 的建法算接收者集合号与成员掩码，见 `src/pack.rs` 的 `Pack::light_links`）；图案节点只解析、校验，还不生效。平行光张角取 Blender 新建灯的默认 0.526°，物体的阴影终止几何偏移取 0.1。
- 一行实例这一帧画不画：左上 3×3 的九个数全为 0 的不建（契约 5.4）；九个数不全为 0 但行列式为 0 的（压扁成一个面、一条线），内核建场景时也不画（按 32 位浮点算，行列式的绝对值不超过 1e-30 就算 0），即行列式为 0 的那一帧这个实例不画。`pack-info` 的 `drawn` 与 `triangles` 都不算它。
- 镜像在画面上量不出来：内核着色时把几何法线翻向来路、再让着色法线与它同侧（`shaders/shader.wgsl` 的 `surface` 与 `surface_proc`），不透明表面画出来与三角形的绕序无关，去掉翻转画面只差浮点末位。所以没有显卡上的负对照，镜像由核对记录的 SP7 与它的负对照（去掉翻转后 SP7 必须不过）守着。
- `--passes 目录`：照输出通道契约（`beiming/kernel/contracts/passes/`）出层，每个通道一个文件，没有文件头、行主序（行从上到下，像素从左到右，一个像素里各分量挨着）、每个数 4 字节小端，文件名「通道名.类型」：`color.f32`（R、G、B、A；RGB 是样本均值、已经预乘 A）、`depth.f32`（Z，平面深度，米；什么都没打到 1e10）、`objectId.u32`（id，实体编号；0 是没打到任何实体）、`objectId.coverage.f32`（coverage：objectId 的两个分量类型不同，另放一个形状相同的文件）、`normal.f32`（X、Y、Z，相机空间：看 -Z、Y 向上）、`motion.f32`（X、Y，像素每帧，见下）、`denoiseAlbedo.f32`（R、G、B）、`denoiseNormal.f32`（X、Y、Z，Cycles 降噪特征的相机空间：看 +Z、Y 向上）；分灯组每组一个 `lightgroup-<名>.f32`（R、G、B；组名按场景包灯清单里第一次出现的次序，没写 `group` 的灯组名就是灯名；文件名里的冒号换成连字符）；外加通道声明 `passes.json`（`passes/0.1`，列这七个固定通道与 `lightgroup:<名>`）。stdout 统计多一段 `passes`：每个通道的文件、形状 `[高, 宽, 分量数]`、分量名与类型。depth、objectId、normal 取辅助样本（每个像素一条，过像素中心、针孔，不取随机数），不做平均；coverage 是首次命中的实体编号等于它的颜色样本所占的比例。背景对相机不可见（`world.visibleToCamera` 是 false）时，相机射线什么都没打到的样本 A 与 RGB 记 0。motion 照输出通道契约 5.6（0.2.0-draft，快门角为 0）：辅助样本的命中点在第 F + 1 帧的屏幕位置减它在第 F 帧的（原点左上、y 向下），最后一帧向后差分（第 F 帧减第 F − 1 帧；有没有第 F + 1 帧按场景包的帧数判，不看镜头的 out），只有一帧的包全 0，没打到、某一帧落到相机平面上或背后、命中的实例在另一帧里被隐藏（左上 3×3 九个数全 0）的像素 0；另一帧的位置按两帧的实例矩阵求（M_G × M_F⁻¹ × X），两帧各用自己那一行相机投影。内核只写命中点与物体号（输出缓冲第 8 格），另一帧的位置与投影在宿主一侧用双精度算（`src/motion.rs`），见 [STRUCTURES.md](STRUCTURES.md)「输出通道」。动态网格按命中三角形的重心坐标取点的那一支（`motion::dynamic_point`）只有库测试，端到端没接，差两样：场景包契约的动态网格文件写法还没定（读入器不收带 `dynamic` 的包）；内核的辅助样本现在只写命中点与物体号，还要把命中的三角形号和重心坐标写进输出缓冲第 9 格（现在预留），这是改内核的输出缓冲，冻结标记要升版本。要辅助层不改颜色：同一个包加不加 `--passes`，颜色逐位相同。要辅助层时用内核的另一个变体（编译开关 `aux`：多一个入口 `aux_sample` 跑辅助样本，颜色样本数覆盖率）；不加 `--passes` 时编出来的颜色内核里没有这两样，不为辅助层多花时间。计时在 stdout 统计的 `timings_ms.aux_ms`。
- 测试在 `../chassis/scenepack.test.mjs`（写出器是同目录的 `scenepack.mjs`，自己拼 GLB）：`BEIMING_CHASSIS_E2E=1` 时现编渲染程序。从 Blender 导出的场景包不进仓库，用环境变量 `BEIMING_CORE_TEST_PACKS` 列出它们的目录（按系统的路径分隔符隔开，每个目录旁边放「目录名.blender-stats.json」），不设就跳过。出层的测试在 `../chassis/passes.test.mjs`：两块前后错开的板（`scenepack.mjs` 的 `platesPack`），测试照内核的取数在 JS 里重算每个颜色样本落在像素里的哪一点、照场景规格自己求交，逐像素对编号、深度、法线与覆盖率，写通道核对记录交给 `passes/check.mjs` 判，并以「辅助层换成颜色样本的平均」做负对照；同一个文件还查透明度、加辅助层不改颜色、只有一帧的包 motion 全 0、两份从 Blender 导出的包每个通道的文件。motion 的解析对拍在 `../chassis/motion.test.mjs`：`scenepack.mjs` 的 `movingPack` 写三帧的包（板平移、板旋转、相机移动并转动），测试照场景规格自己求交、照两帧的矩阵在双精度里投影，第 0、1 帧往后差分、最后一帧往前差分，物体内部（离板边 2 厘米以上）的像素每个分量差不超过 1e-4 像素，软件求交与默认求交各一遍，方向取反的负对照必须对不上。
- 和 Cycles 的 Vector 通道交叉核对（一次，不当门）：Cycles 的 `primitive_motion_vector`（`kernel/geom/primitive.h`，读的是 Blender v5.2.3 的源码）返回 `(上一帧 − 本帧, 本帧 − 下一帧)` 的光栅位置差；光栅坐标 y 向上、关掉运动模糊时上一帧与下一帧取整帧的 F − 1 与 F + 1，这两样是从下面的读数推出来的（宿主一侧同步相机与物体运动的源码本机没有，没核）。所以换成输出通道契约 5.6 的口径是 `(−Z, +W)`：后两个分量取负得到「下一帧减本帧」，再把 y 翻成向下（−W 取负）。核法：苹果 M5 Pro 上的 Blender 5.2.0（Cycles，CPU），把 03B 零件 L-1 的场景包第 11、12、13 帧的实例矩阵与相机打成关键帧、关运动模糊、开 Vector 与物体编号，渲第 12 帧 320×180、每像素 1 个样本、高斯像素滤波宽 0.01（样本贴着像素中心）；核心同一帧同尺寸出 motion。比编号层 3×3 邻域都是同一个实体、两边编号也相同的 51281 个像素（核心 motion 的长度中位 0.571、最大 1.410 像素）：`(−Z, +W)` 和核心的差，中位 1.59e-4、99% 分位 2.08e-4、最大 2.51e-4 像素；`(−Z, −W)`（不翻 y）最大差 2.08 像素；`(−X, +Y)`（向后差分）中位 0.0116、最大 0.507 像素；`(Z, W)` 中位 1.0。差的那 1e-4 像素多半来自关键帧按位置、旋转、缩放拆回矩阵的舍入与像素滤波的抖动，没有往下查。核对用的 Blender 脚本与比对脚本没进仓库（读的场景包不在仓库里）。
- 读回一致性：调试开关 `BEIMING_CORE_FILM_DUMP=<文件>` 让 `core-render` 把读回的输出缓冲原样写进这个文件（小端 f32，每个像素 `film_stride` 个 vec4），全局参数原样写进「文件.params」。`../chassis/readback.test.mjs` 照读回的写法（`src/gpu.rs` 的 `Gpu::render`、`src/main.rs` 的 `write_passes`）在 JS 里从原值重算每个通道，和落盘的通道文件逐位比（七个文件全部逐位相同）；motion 不是着色器写的，拿缓冲第 8 格的命中点在双精度里重算，差不超过 1e-6 像素。负对照：每个文件改一位都被查出，换另一帧的缓冲去对，颜色、深度、覆盖率都对不上。
- 逐帧推进：`../chassis/advance.test.mjs` 拿 10 帧的包（`movingPack`，板与相机每帧都挪）按帧号 0 到 9 连续渲、再打乱次序渲一遍，场景包每帧状态表第 k 行就是镜头局部帧号 k、`sub = 0` 的状态（场景包契约 5.2、第 6 节）。测试自己从产物量、自己断言三件事：编号层逐像素对每一行状态的解析编号图，恰好第 k 行对得上；板内部覆盖率全是 1（颜色样本在板内部打到的都是辅助样本那块板）；同一帧两种出帧次序的状态摘要（颜色与辅助四层的字节）相同。时间核对记录只写 `evaluations`（帧号、`sub`、次序是请求的，摘要是量的），交给时间键契约的 T1；`frames[]` 的帧号、采样与辅助样本时刻来历是「旁观」，要镜头代码里的观测点，核心帧源没有，所以不写，T4、T5、T8、T9 这里不判。负对照：摘要改掉 T1 要拒，相邻两行状态的编号图分得开。三份测试共用的几何在 `../chassis/moving.mjs`。
- 出层转多层 EXR：`node beiming/sources/core/chassis/passes-exr.mjs <出层目录> --width W --height H [-o frame.exr] [--zip]`。读 `passes.json` 与逐通道文件（层文件没有文件头，尺寸照出层时给），每个分量一个 32 位通道，通道名是「通道名.分量名」（`color.R`、`depth.Z`、`objectId.id`、`objectId.coverage`、`normal.X`、`denoiseAlbedo.R`、`denoiseNormal.Z`…，照输出通道契约 3.1 的登记表；`objectId.id` 是 u32，其余 f32），用 `beiming/verify/exr/exr.mjs` 的 `writeExr` 写单部件扫描线 EXR（默认不压缩，`--zip` 按扫描线 ZIPS），再用 `readExr` 读回逐通道逐字节比，通道名逐个过 `isPassChannel`。往返不逐位相同或名字不在登记表里退出 4。出层目录里有几个通道就转几个，现在是七个固定通道的十八个分量，外加每个分灯组 R、G、B 三个分量。

## 降噪的口径

`render-pack` 与 `render` 的 `--hdr`、PNG 是降噪之后的（`--no-denoise` 或预设里 `native.denoise` 为假时不降噪；`--passes` 的 `color` 永远不降噪）。编进了 OIDN（cargo 特性 `oidn`，构建档见下一节）时先试 `src/denoise.rs` 的 `oidn()`，拿不到设备或出错就在 stderr 记一行 `oidn: …`、退回自带的小波降噪，stats 的 `denoise` 记 `oidn` 或 `atrous`。默认档（`../chassis/build.mjs` 的 `buildRenderer`，第 2 级与回归用的就是它）不编 OIDN，出的帧是小波降噪。

降噪后的颜色不进出层：输出通道契约（`beiming/kernel/contracts/passes/`）第 1 节写明降噪之后的颜色不在那一套通道里，也没给它起名字，所以降噪后的线性颜色只从 `--hdr <文件>` 出（RGB f32 小端、行主序、没有文件头，与出层的层文件同一种写法；编进 OIDN 时就是 OIDN 的结果），`--passes` 里的 `color` 仍是未降噪的样本均值。同一次渲染里，`--hdr` 与把出层的 `color`（取 RGB）、`denoiseAlbedo`、`denoiseNormal` 喂给下面的 `denoise` 子命令（按 Cycles 的行序翻过去再翻回来）得到的结果逐位相同（Mac 上 `part_03B` 第 12 帧实测）。

`oidn()` 照 Cycles（Blender 5.2）最终渲染的 OIDN 降噪接法。Cycles 宿主一侧的源码（`integrator/denoiser_oidn*.cpp`）本机仍没有；下表「Cycles」一栏里写「对拍」的，是由下面「和 Blender 对拍」的读数定下来的：照这一栏设，两边差在 1e-3 以内（Metal 逐位相同）；对 Cycles 的 `ACCURATE` 结果，这边不翻行序、或用 `FAST`、`NONE` 的设法，最大绝对差都在 2.6 以上。

| 参数 | Cycles | 改之前（上游原样） | 现在 |
|---|---|---|---|
| 过滤器 | `RT` | `RT` | `RT`，经 C 接口建（见下） |
| 输入的层 | 颜色、反照率、法线：界面属性 `denoising_input_passes` 默认 `RGB_ALBEDO_NORMAL` | 同 | 同 |
| 法线 | 相机空间（`denoising_passes.h` 用 `worldtocamera` 变过去），样本累积的均值，不归一 | 世界空间，逐像素归一 | 相机空间的均值，不归一：与出层的 `denoiseNormal` 是同一份 |
| 反照率 | 首次命中处漫反射类闭包的反照率（`denoising_passes.h`） | 内核的反照率均值 | 不变（就是出层的 `denoiseAlbedo`） |
| `hdr` / `srgb` | 开 / 关（对拍） | 开 / 关 | 开 / 关 |
| `inputScale`（旧名 `hdrScale`） | 不设，库从图上估（对拍） | 设成曝光系数 | 不设（OIDN 2.5 的默认是 NaN，即自己估） |
| 输入乘不乘曝光 | 场景线性的样本均值，曝光在显示变换里 | 颜色不乘，但曝光经 `hdrScale` 进了降噪 | 不乘，也不进降噪 |
| 预过滤、`cleanAux` | 界面属性 `denoising_prefilter` 默认 `ACCURATE`：先各用一个 `RT` 过滤器原地降噪反照率与法线（同一质量），颜色那一遍开 `cleanAux`；`FAST` 不预过滤、`cleanAux` 关；`NONE` 不预过滤、`cleanAux` 开（对拍：三档在 Blender 与这边各设成同一档，CPU 上最大相对差都不到 7e-6） | 不预过滤，`cleanAux` 取默认（关） | `ACCURATE`（`render-pack`）；`denoise` 子命令三档都能选 |
| 质量 | 界面属性 `denoising_quality` 默认 `HIGH` | `High` | `HIGH`，预过滤的两个过滤器也是 |
| 设备 | 界面属性 `denoising_use_gpu` 默认关：最终渲染在 CPU 上降噪 | 库的默认设备（OIDN 挑最快的一个） | `render-pack` 固定 CPU；`denoise` 子命令 `--device cpu|cuda|metal|default` |
| 行序 | 渲染缓冲第一行是画面最下面一行（对拍：不翻时最大绝对差 2.66） | 画面第一行是最上面一行 | 喂进去之前上下翻成 Cycles 的行序，出来再翻回 |

`oidn` crate 2.5.1（源码在 cargo 缓存里，已读）的 `RayTracing` 不够用：它的 `clean_aux()` 设的参数名是 `clean_aux`，OIDN 2.5 只认 `cleanAux`（Blender 自带库里只有这个字串），设了等于没设；它也没有单独降噪辅助层的接口。所以 `oidn()` 只用 crate 的设备与缓冲（`Device::cpu()` 等、`create_buffer`、`read`），过滤器全走它带的 C 绑定 `oidn::sys`（`oidnNewFilter`、`oidnSetFilterImage`、`oidnSetFilterBool`、`oidnSetFilterInt`、`oidnCommitFilter`、`oidnExecuteFilter`），参数名照 OIDN：`hdr`、`srgb`、`cleanAux`、`quality`。

OIDN 2.3 那一档（特性 `oidn23`，`oidn` crate 2.3.3，源码在 cargo 缓存里，已读）用同一段：C 绑定里这几个函数的参数一样，`OIDN_FORMAT_FLOAT3` 与 `OIDN_QUALITY_HIGH`（6）的值一样，过滤器名 `RT`，设备枚举 CPU、SYCL、CUDA、HIP、METAL 的编号一样（2.5.1 的绑定把枚举类型从无符号改成了有符号，值没变）；Blender 4.5.16 自带的 OIDN 2.3.3 库里同样只有 `cleanAux`、`quality`、`srgb`、`inputScale` 这些字串，而 crate 2.3.3 的 `RayTracing` 同样把它写成 `clean_aux`。差别只在 crate 的安全接口：2.3.3 的 `Device::cpu()`、`new()` 直接返回设备（不查空句柄，所以建完先查一次错），`cuda()`、`metal()` 返回 `Option`，`create_buffer` 返回 `Option`，`read` 直接返回数据，`get_error` 的错是（错误码，库的说明）；2.5.1 这些都返回 `Result`。`denoise.rs` 把这几处收进按特性二选一的 `api` 模块；两个特性同开是编译错误。

现成的三张图也能直接降噪，给对拍用（编进了 OIDN 才有，否则报错退出）：

```sh
core-render denoise --width W --height H --color c.f32 --albedo a.f32 --normal n.f32 -o out.f32 [--device cpu] [--prefilter accurate]
```

三张输入与输出都是 RGB f32 小端、行主序、没有文件头，原样喂给 `oidn()`（不翻行序）；stdout 一行统计（设备、预过滤、质量、耗时）。

### 和 Blender 对拍

```sh
node beiming/sources/core/chassis/oidn-parity.mjs [--device cpu|cuda|metal] [--prefilter accurate|fast|none] [--spp 16] [--width 320 --height 240] [--build oidn|oidn23]
```

本机的 Blender 现搭一个小场景（脚本在 `../chassis/oidn-parity.mjs` 的 `SCENE`：地面、漫反射方块、金属球、面光、弱环境光，16 采样、不自适应、种子 0），Cycles 用 OIDN、质量 `HIGH`、给定的预过滤与设备（`cpu` 关「在 GPU 上降噪」；`cuda`、`metal` 用那块显卡渲并在上面降噪），存多层 EXR（32 位、不压缩；Blender 5 是多部件，4.5 是单部件），取 `Noisy Image`、`Denoising Albedo`、`Denoising Normal` 与降噪后的 `Combined`。前三层按 Cycles 的行序翻过来喂给带 OIDN 的 `core-render denoise`（同设备、同预过滤、`HIGH`），结果翻回来和 `Combined` 逐分量比。判据：每个分量 |差| ≤ 1e-3 × max(1, |Combined|)。EXR 与场景都在临时目录里，不进仓库；记录写 `../chassis/oidn-parity/<平台>-<设备>-<预过滤>.json`（`--build oidn23` 写 `<平台>-oidn23-<设备>-<预过滤>.json`；Blender 与 OIDN 的版本、库的 sha256、程序摘要、EXR 的 sha256、读数）。脚本先过 `verifyOidnLibs`：Blender 降噪用的库就是这边链接的那一份。`--build oidn23` 对 Blender 4.5 与 OIDN 2.3：`BEIMING_BLENDER` 指向 Blender 4.5 的可执行文件（参考由它渲、库从它的 `lib/` 找），渲参考的 Blender 报的版本与锁文件这一项不同就不比，退出码 3。

| 机器 | Blender | 设备 | 预过滤 | 最大绝对差 | 最大相对差 | 判据 |
|---|---|---|---|---|---|---|
| 苹果 M5 Pro | 5.2.0 | CPU | `ACCURATE` | 1.49e-4 | 5.37e-6 | 过 |
| 苹果 M5 Pro | 5.2.0 | CPU | `FAST` | 2.33e-4 | 6.80e-6 | 过 |
| 苹果 M5 Pro | 5.2.0 | CPU | `NONE` | 2.48e-4 | 6.07e-6 | 过 |
| 苹果 M5 Pro | 5.2.0 | Metal | `ACCURATE` | 0（逐位相同） | 0 | 过 |
| RTX 5090（Linux） | 5.2.3 | CPU | `ACCURATE` | 1.49e-4 | 6.29e-6 | 过 |
| RTX 5090（Linux） | 5.2.3 | CPU | `FAST` | 1.91e-4 | 6.09e-6 | 过 |
| RTX 5090（Linux） | 5.2.3 | CPU | `NONE` | 1.49e-4 | 5.85e-6 | 过 |
| RTX 5090（Linux） | 5.2.3 | CUDA | `ACCURATE` | 0（逐位相同） | 0 | 过 |
| RTX 5090（Linux），2.3 档 | 4.5.16 | CPU | `ACCURATE` | 1.68e-4 | 5.06e-6 | 过 |
| RTX 5090（Linux），2.3 档 | 4.5.16 | CPU | `FAST` | 1.72e-4 | 4.99e-6 | 过 |
| RTX 5090（Linux），2.3 档 | 4.5.16 | CPU | `NONE` | 1.87e-4 | 5.67e-6 | 过 |
| RTX 5090（Linux），2.3 档 | 4.5.16 | CUDA | `ACCURATE` | 0（逐位相同） | 0 | 过 |

前八行是 OIDN 2.5 档；后四行是 OIDN 2.3 档（`--build oidn23`，链接 Blender 4.5.16 自带的 OIDN 2.3.3，参考也由它渲），记录是 `linux-x64-oidn23-*.json`。Blender 4.5 存的多层 EXR 是单部件，读法同样支持。Mac 上没有 Blender 4.5，2.3 档只在 Linux 上编过、对拍过。

同一份带噪输入，降噪前后最大绝对差约 8.7（`ACCURATE`），所以这一帧的降噪确实动了画面。5090 上 `render-pack` 同包同帧（`part_03B` 第 12 帧）默认档与 OIDN 档的出层逐位相同，stats 的 `denoise` 分别是 `atrous` 与 `oidn`。CPU 上留下的那点差（两台机器都约是判据的 0.5%）没再追：Metal 与 CUDA 都逐位相同，说明参数与输入的取法一致；CPU 一侧的差可能来自 Cycles 读渲染缓冲时乘 1/采样数与 EXR 里存的均值在末位上的不同，没有验证。

### 链接 Blender 自带的 OIDN：带 OIDN 的构建档

不起单独的降噪服务，降噪在 core-render 进程里做；链接的是 Blender 安装里自带的那一份 OIDN 动态库，按 sha256 钉住，与 Blender 降噪时用的逐字节是同一个库。这是另一个构建档，默认档不变。

```sh
node -e "import('./beiming/sources/core/chassis/build.mjs').then(m => console.log(m.buildOidnRenderer().bin))"
# OIDN 2.3 那一档（只在有 Blender 4.5 的 linux-x64 上）：
BEIMING_BLENDER=<Blender 4.5 的可执行文件> node -e "import('./beiming/sources/core/chassis/build.mjs').then(m => console.log(m.buildOidnRenderer(process.env, 'oidn23').bin))"
```

- 找库：环境变量 `BEIMING_OIDN_LIB`（Blender 的 lib 目录）；没设时找 Blender（`BEIMING_BLENDER`、macOS 的 `/Applications/Blender.app`、PATH 里的 `blender`），取它真实路径旁的库目录：macOS 是 `Contents/Resources/lib/`，Linux 官方包是可执行文件同级的 `lib/`（PATH 里的 `blender` 是链接时先解开）。
- 核对：[../chassis/oidn-lock.json](../chassis/oidn-lock.json) 按平台（`darwin-arm64`、`linux-x64`；OIDN 2.3 档在它的 `oidn23` 一项里，只有 `linux-x64`）列出库目录里全部 `libOpenImageDenoise*` 与 `libtbb*`（链接照它指向的内容）的 sha256，`build.mjs` 的 `verifyOidnLibs` 逐个比：多一个、少一个、对不上都拒绝，抛 env 类的错（退出码 3）：sha256 对不上或多出锁文件里没有的库报 `env.lib-mismatch`（帧源接口契约 5.15），缺库、缺平台报 `env.missing-tool`。构建前核一次；跑带 OIDN 的程序之前（对拍脚本）再核一次。
- 链接：`oidn` crate 2.5.1 的构建脚本（`build.rs`，已读）没开 `bundled` 时，设了 `OIDN_DIR` 就把 `$OIDN_DIR/lib` 加进链接路径、链接 `OpenImageDenoise`，不走 pkg-config；C 接口的绑定是 crate 里写好的，不要头文件。所以 `OIDN_DIR` 设成库目录的上一级（库目录必须叫 `lib`），`cargo rustc --locked --release --features oidn --bin core-render -- -C link-arg=-Wl,-rpath,<库目录>`；不开 `bundled`（它会在构建时下载）。构建目录另用 `out/chassis/target-oidn`；程序名的摘要把构建档与锁文件这个平台的一项算进去，与默认档分开存。
- OIDN 2.3 那一档（`buildOidnRenderer(env, 'oidn23')`）：`oidn` crate 2.3.3 与 2.5.1 在 Cargo 看来是兼容的两个版本（同一个大版本 2），又都声明 `links = "OpenImageDenoise"`，所以不能在本目录的 `Cargo.toml` 里写成两个可选依赖（试过：解析报 `failed to select a version for oidn`）。`build.mjs` 把进构建的文件拷到 `out/chassis/oidn23/`，在拷过去的清单里把 `oidn` 依赖改成 `=2.3.3`、特性 `oidn` 改名 `oidn23`，用本目录的 `Cargo-oidn23.lock` 换掉 `Cargo.lock`，`cargo rustc --locked --release --features oidn23`，构建目录 `out/chassis/target-oidn23`；工作树不动。crate 2.3.3 的构建脚本（已读）同样认 `OIDN_DIR`（有它就不走 pkg-config），链接与 rpath 同上。`Cargo-oidn23.lock` 与 `Cargo.lock` 只差 `oidn` 这一个包（2.3.3 不依赖 `bitflags`），`oidn-parity.test.mjs` 核这一点：改了 `Cargo.lock` 之后照它重新生成（拷到 `out/` 下改清单、`cargo update -p oidn --precise 2.3.3 --offline`）。
- 运行时找库：只靠编进程序的 rpath（`LC_RPATH` / `RUNPATH`，指向上面的库目录），不用 `DYLD_LIBRARY_PATH` / `LD_LIBRARY_PATH`。OIDN 的主库再按它自己的 rpath（macOS `@loader_path`、Linux `$ORIGIN`）从同一目录装核心库与设备库（macOS 有 CPU 与 Metal，Linux 有 CPU、CUDA、HIP、SYCL）。所以 Blender 升级或挪走之后这个程序就装不上库了，要重编；锁文件对不上时先改锁文件（换了 Blender 就是换了库，要重新对拍）。

| 平台 | 库目录 | Blender | OIDN |
|---|---|---|---|
| `darwin-arm64`（苹果 M5 Pro） | `Blender.app/Contents/Resources/lib/` | 5.2.0 | 2.5.0 |
| `linux-x64`（RTX 5090） | 官方 Linux 包的 `lib/` | 5.2.3 | 2.5.0 |
| `linux-x64`（RTX 5090），`oidn23` 档 | Blender 4.5.16 官方 Linux 包的 `lib/` | 4.5.16 | 2.3.3（oneTBB 2021.13） |

各文件的 sha256 只写在锁文件里。几处 Blender 都只有动态库：没有头文件、没有 pkg-config 的 `.pc`、没有 CMake 的配置文件（用不着）。苹果 M5 Pro 上没有 Blender 4.5，所以没有 `oidn23` 档的库，那里只编默认档与 OIDN 2.5 档。

许可：只从本机已装的 Blender 动态链接，库不进仓库、不随仓库分发。OIDN 2.5.0 与 2.3.3（Apache-2.0）、它们装载的 oneTBB（Apache-2.0）与 `oidn` crate 2.5.1、2.3.3（MIT）登记在 `docs/rights/register.md` 的 R17 与 [THIRD-PARTY.md](../../../../THIRD-PARTY.md) 第 14 节；以后要对外分发带 OIDN 的程序，随附两份 Apache-2.0 许可（OIDN、oneTBB 各一份）与各自的 NOTICE，并保留 `oidn` crate 的 MIT 声明。

把 OIDN 档接进出片链时（宿主或作业起带 OIDN 的 `core-render` 之前），先照 `oidn-lock.json` 核一遍库的 sha256（`verifyOidnLibs`），对不上就不起程序：编好之后库目录里的文件被换掉、程序照样装得上，运行时自己不核。

`oidn` 2.5.1 与它的依赖（`num_enum`、`num_enum_derive` 0.7.6，`proc-macro-crate` 3.5.0，`toml_edit` 0.25.17+spec-1.1.0）已按 `Cargo.lock` 的校验和取进两台机器的 cargo 缓存；`oidn` 2.3.3 按 `Cargo-oidn23.lock` 的校验和取进两台机器的缓存（只有它一个包，20388 字节：它的依赖 `num_enum` 0.7.6 与构建依赖 `pkg-config` 已在缓存里）。之后的构建一律不联网。

## 03C 的显存估算

不用真包，按 03C 的规模算：373 个实例、按实例计 1,595 万个三角形、去重后 668 万个，两级结构（每个网格一个 BLAS、一个 TLAS 放实例）。各缓冲的字节数照代码里的写法（`src/gpu.rs` 的 `upload` 与 `Gpu::render`、`src/lib.rs` 的 `prepare_as`）算；加速结构的字节数是驱动自己给的预建尺寸，`core-render as-size` 在两台机器上问出来的（只问尺寸，不建，不要几何）。没算的：贴图、材质表、灯表、全局参数这些与三角形数无关的小表。

| 项 | 怎么算 | 字节数 |
|---|---|---|
| 三角形顶点 `tri_verts` | 每个三角形 3 个 vec4（48 字节），668 万个，加编辑预留 25%（实例化的场景走硬件求交时 `EditRoom` 多留四分之一） | 400,800,000（382.2 MiB） |
| 三角形属性 `attrs` | `GpuTriAttr` 6 个 vec4（96 字节），同上 | 801,600,000（764.5 MiB） |
| BLAS 的顶点 `blas_verts` | 每个三角形 3 个 f32×3（36 字节），同上 | 300,600,000（286.7 MiB） |
| 实例记录 | `GpuInstance` 10 个 vec4（160 字节），373 个加预留 1024 个 | 223,520 |
| BLAS（668 万个三角形） | `as-size`：苹果 M5 Pro（Metal）636,191,104（每个三角形 95.2 字节）；RTX 5090（Vulkan）413,127,680（61.8 字节）。拆成 100 个 6.68 万的 BLAS 各家只多 0.01% 到 0.05% | Metal 636.2 MB；Vulkan 413.1 MB |
| TLAS | 实例上限照 `create_tlas`：8 个分组 + 373 个实例 + 预留 1024 个 = 1405 | Metal 304,512；Vulkan 425,344 |
| 建加速结构的临时缓冲 | 668 万个三角形的那一个 BLAS（建完就放） | Metal 248,127,744；Vulkan 95,818,624 |
| 输出缓冲 film（1920×1080） | 每个像素 `film_stride` 个 vec4：没有灯组 12、4 个灯组 16、8 个灯组 20 | 398,131,200（379.7 MiB）、530,841,600（506.2 MiB）、663,552,000（632.8 MiB） |
| 读回用的缓冲 | 与 film 一样大（`MAP_READ`，独立显卡上在主机内存一侧） | 同上 |

合计（硬件求交、4 个灯组、不算读回与临时缓冲）：苹果 M5 Pro 约 2.67 GB（2,546.8 MiB），RTX 5090 约 2.45 GB（2,334.2 MiB）。

- 镜像实例：镜像的实例在建场景时平铺成世界坐标的三角形（不进共享网格），每个三角形另要 180 字节（加预留 225 字节）再加它在分组 BLAS 里的那一份（Metal 约 95 字节、Vulkan 约 62 字节）。03C 有多少镜像件这里没有，上面的合计按 0 个算；每 100 万个镜像三角形多约 0.29 到 0.32 GB。
- 软件求交（`THREERT_HWRT=0`）：实例全部平铺，1,595 万个三角形：顶点 765,600,000、属性 1,531,200,000，BVH 节点每个 32 字节，按 03B 零件包的比例（23130 个三角形 16035 个节点）约 353,837,600，最多（每个叶子一个三角形）1,020,799,968；合计约 2.65 GB，最多 3.32 GB，再加 film。属性那一块 1.53 GB 是最大的单个缓冲。
- 对上限（`chassis/limits/`）：单个缓冲上限两台都是 4 GiB（`max_buffer_size` 4,294,967,295）；单个存储缓冲绑定上限 Metal 4 GiB、RTX 5090 2 GiB（`max_storage_buffer_binding_size` 2,147,483,644），最大的单个缓冲（软件求交的属性 1.53 GB、硬件求交的属性 0.80 GB、8 个灯组的 film 0.66 GB）都在 2 GiB 以内；一个 BLAS 的三角形上限 Metal 268,435,456、Vulkan 536,870,911，TLAS 实例上限约 1,677 万，都远在上面。显存总量不在上限记录里（wgpu 不报）：RTX 5090 是 32,607 MiB（`nvidia-smi`），苹果 M5 Pro 是统一内存，没量。
- 这是估算：读数是驱动的预建尺寸与代码里的写法，没有拿真包在显卡上量占用。

## 改之前

- 每个文件第一行的来源注释保留。
- 要动材质记录、全局参数、路径状态、着色点与闭包、随机数的编号、输出缓冲，先读 [STRUCTURES.md](STRUCTURES.md)：哪些能直接加、哪些要先拿号、哪些是破坏性的改动，都写在「改动的规矩」里。要新号（闭包种类号、材质标志位、随机维度、全局参数的追加块、新表首地址的格子、输出缓冲的格子）向核心帧源的负责人要，登记进那里的登记表。
- 要求渲染结果不变的改动，改一小步就跑一次上面的 `regress.mjs --check`。显卡的着色器编译器会按上下文合并或重排浮点运算：把一段语句抽成函数、把两个量合到一个函数里算、按值返回一个大结构、把一个除法挪到调用方去做，都可能让像素末位变化，而且两块显卡各有各的敏感处，两台都要跑。已经踩到的几处写在 [PROVENANCE.md](PROVENANCE.md)「北冥加了什么」里。
- 环境变量与场景运行时接口暂时沿用上游的名字，原因见 [PROVENANCE.md](PROVENANCE.md)。
- 从上游挑新改动进来时，在 [PROVENANCE.md](PROVENANCE.md) 末节登记。
