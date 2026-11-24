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

## 改之前

- 每个文件第一行的来源注释保留。
- 要动材质记录、全局参数、路径状态、着色点与闭包、随机数的编号、输出缓冲，先读 [STRUCTURES.md](STRUCTURES.md)：哪些能直接加、哪些要先拿号、哪些是破坏性的改动，都写在「改动的规矩」里。要新号（闭包种类号、材质标志位、随机维度、全局参数的追加块、新表首地址的格子、输出缓冲的格子）向核心帧源的负责人要，登记进那里的登记表。
- 要求渲染结果不变的改动，改一小步就跑一次上面的 `regress.mjs --check`。显卡的着色器编译器会按上下文合并或重排浮点运算：把一段语句抽成函数、把两个量合到一个函数里算、按值返回一个大结构、把一个除法挪到调用方去做，都可能让像素末位变化，而且两块显卡各有各的敏感处，两台都要跑。已经踩到的几处写在 [PROVENANCE.md](PROVENANCE.md)「北冥加了什么」里。
- 环境变量与场景运行时接口暂时沿用上游的名字，原因见 [PROVENANCE.md](PROVENANCE.md)。
- 从上游挑新改动进来时，在 [PROVENANCE.md](PROVENANCE.md) 末节登记。
