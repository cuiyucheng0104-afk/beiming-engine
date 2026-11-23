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
| `src/merged.rs` | `renderer/src/merged.rs` | 删去切掉的几类 |
| `src/pipeline_cache.rs` | `renderer/src/pipeline_cache.rs` | 没改 |
| `src/post.rs` | `renderer/src/post.rs` | 没改 |
| `src/procasset.rs` | `renderer/src/procasset.rs` | 没改 |
| `src/sample.rs` | `renderer/src/sample.rs` | 没改 |
| `src/scene.rs` | `renderer/src/scene.rs` | 删去切掉的几类；一个测试读夹具的根目录改成本目录 |
| `src/script.rs` | `renderer/src/script.rs` | 删去切掉的几类 |
| `src/skin.rs` | `renderer/src/skin.rs` | 没改 |
| `src/sky.rs` | `renderer/src/sky.rs` | 没改 |
| `src/texpack.rs` | `renderer/src/texpack.rs` | 删去切掉的几类 |
| `src/world.rs` | `renderer/src/world.rs` | 删去切掉的几类 |
| `shaders/pathtrace.wgsl` | `renderer/shaders/pathtrace.wgsl` | 删去只有实时才走的段；加了北冥的接线（见下一节） |
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
- `shaders/pathtrace.wgsl`，以「北冥」开头的注释标出，一百行上下：
  - 金属（metallic 为 1）的基础高光层改走移植的闭包：`bm_closure`、`bm_eval`，以及求值、概率密度、采样三处的分支。菲涅耳用 F82-tint，底色当 F0，边缘色取白；alpha 取粗糙度的平方；能量补偿由场景选项 `energyCompensation` 开关。
  - 不画卡片的矩形纯光改走移植的球面矩形采样，并与材质采样做多重重要性采样：`bm_rect`、`bm_rect_le`、`bm_rect_sample`、`bm_rect_hits`，以及光源一侧与主循环里的几处调用。

已知的一处简化：矩形纯光的高光倍率不是默认的 1 时，光源一侧的高光乘了倍率、材质一侧没乘，两侧权重配不上。要支持非 1 的倍率时，把材质一侧的贡献按高光与漫反射拆开再乘。

## 沿用上游名字的地方

- **环境变量**。内核读的开关仍叫上游的名字（`THREERT_` 开头），例如 `THREERT_SEED`（随机数种子）、`THREERT_HWRT`、`THREERT_MERGED`、`THREERT_LOOP_GUARD`、`THREERT_PIPELINE_CACHE`、`THREERT_INSTANCING` 等。这次不改：上游自带的 JavaScript 工具还在给它们赋值，改名要和场景入口一起换。
- **场景运行时的接口**。场景包里的全局对象 `__threert` 与运行时模块名 `threert-runtime.js` 是上游 JavaScript 运行时与内核之间的约定，照旧。
- 注释与报错文字里提到上游项目、上游文档（如 `docs/RUNTIME.md`）与上游工具（如 `tools/bundle-game.ts`）的地方照旧，那些文件不在本仓库里。

## 场景入口暂时还是上游的

内核吃的是上游格式的场景包：用上游的 JavaScript 场景库写场景，再用上游的打包工具打成单个脚本，由内核里内嵌的脚本引擎运行。这一段还没有换成北冥自己的入口。所以跑第 2 级测试时，[../chassis/build.mjs](../chassis/build.mjs) 仍按上面的固定提交把上游仓库取到被忽略的 `out/` 下，核对提交号，只用其中的场景打包工具、场景库、自带的测试脚本与素材根目录；**渲染程序不再从那份取来的源码编，而是从本目录编**。

## 以后不再跟上游同步

这是一次性的分叉，不是定期合并的镜像。以后要用上游的某个新改动时，逐个挑、逐个改写进来，并在本页登记：上游的提交号、改了本目录哪些文件、为什么要。
