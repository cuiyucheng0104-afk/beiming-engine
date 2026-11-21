# Blender 帧源

在帧源侧与 Blender 交互，按帧源接口交付帧产物。

通过帧源接口契约接收输入和交付帧产物，渲染器依赖留在本帧源侧。跨组件通过契约交接，引用旧目录须命中白名单。

业务契约：[帧源接口](../../kernel/contracts/source/CONTRACT.md)（能力声明与会话接口）、[场景包](../../kernel/contracts/scene-pack/CONTRACT.md)（几何、实例表与每帧状态的交换格式）、[输出通道](../../kernel/contracts/passes/CONTRACT.md)（交付的通道）。

通用约定见[契约目录](../../kernel/contracts/)、[契约写法约定](../../kernel/contracts/CONVENTIONS.md)和[目录归属契约](../../kernel/contracts/ownership/CONTRACT.md)。

## 文件

| 文件 | 在哪跑 | 管什么 |
|---|---|---|
| `caps.mjs` | node | 能力声明 `caps(version, library)`。`library` 是起帧源时提供的卡：提供了卡，作者模式里才有 `cards-data` |
| `host.mjs` | node | 帧源对上层的接口：`startSource` 起一个常驻的后台 Blender，交回 `caps`、`open`、`stop`；`planOpen`、`planRender` 是不碰 Blender 的纯函数，装不了、交不出就报带错误码的错。「卡加数据」模式里数据层的卡（`evaluate` 形状）也在这里的求值核里跑 |
| `worker.py` | Blender | 常驻进程：按行收 JSON 请求，装载镜头、写每帧状态、渲各层、量元数据 |
| `loader.py` | Blender | 「卡加数据」模式的固定装载脚本，六步里碰场景的部分 |
| `assets.py` | Blender | 把一个资产文件载进场景，交回它的零件 |
| `rtx-card.json` | 数据 | 帧源自带的演示资产 `asset:rtx-card@1` |

## 两种作者模式

- `build-script`：镜头写 `entry`，帧源调入口文件搭场景。不接卡、资产、叠加层，带着来报 `contract.unsupported-input`。
- `cards-data`：镜头不写一行代码，只有 `cards`、`assets`、`roles` 这些数据，帧源跑固定装载脚本。起帧源时用 `startSource({ cards })` 提供了卡目录才声明这个模式；不提供卡时能力声明里只有 `build-script`。

## 「卡加数据」的六步装载

照卡的运行时接口契约 3.4，和页面宿主的固定装载同构。node 一侧做装载之前的检查、解参数、解先后要求；碰场景的部分在 Blender 里。

| 步 | 做什么 |
|---|---|
| 1 `assets` | 载入镜头条目 `assets` 里的每个资产。别名是装配体，零件各是一个实体 `<别名>.<零件名>`。全片的 `assets` 到卡调 `ctx.assets.load` 时才载，零件不进实体表 |
| 2 `tracks` | 数据层的卡在 node 一侧的求值核里按书写顺序求值，算出数据轨道；有卡产出相机轨道时在场景里备一台相机。这个帧源有地方写的轨道现在只有 `tracks.camera` |
| 3 `create` | 照各卡 `ports.order` 排出次序，逐个调 `create` 形状的卡（`source:blender` 的实现，Python）；叠加层展开出的实例排在镜头自己的卡之后 |
| 4 `collect` | 定相机：先取相机轨道，没有就取相机类卡交出的相机，再没有用宿主备的那台（世界原点，朝 −Z，竖直视场角 40 度）。汇总实体表，按镜头的 `roles` 标 `hero`、`mustSee` |
| 5 `state` | 每帧把状态写进场景。出第 f 帧时 node 一侧现算 f − 1、f、f + 1 三个整帧的轨道值交过来，`tracks.apply` 只认这三个时刻 |
| 6 `meta` | 每帧量元数据，并上各卡交的文字、锚点、读数 |

装载的账（做了哪几步、`create` 的次序、相机从哪来、每个卡实例是谁调的、并进镜头之后叫什么）经每帧元数据的 `ext["blender.load"]` 交出去。

装载之前的检查，先后照帧源接口契约 5.14：

- 宿主或作者模式不在能力声明里，报 `contract.unsupported-mode`。
- 没有锁文件（`env.lock` 是 `null`）：镜头没写 `seed`，或者用了卡、资产、叠加层，报 `env.lock-required`。「卡加数据」的镜头总要用卡，所以必须带锁文件。
- 带着锁文件：每个卡实例要起帧源时提供了这张卡、主版本对得上、锁文件锁的版本和内容哈希就是提供的这一份、有落在这个帧源或数据层的实现，数据层的卡产出的轨道这个帧源都有地方写；每个资产要提供了、锁文件里记了、哈希对得上。有一样对不上报 `contract.unsupported-input`，不少装一样照常装载。

相机样条卡的关键帧 `look` 写实体名（例如 `"look": "kit"`）时，装载完先量出每个实体逐帧的世界包围盒交给求值核，相机朝这个实体包围盒的中心看。

两张机制卡在这条路上各管一段：`blender.cycles` 定渲染器（只用 Cycles）、降噪器和快门位置；`blender.state-keys` 在渲第 f 帧时把 f − 1、f、f + 1 的状态写成关键帧，运动模糊由 Blender 的快门自己算。每像素采样数和开不开降噪由帧源按档位定：草稿档低采样加降噪，终稿档取镜头的 `tiers.final.samples`。

## 资产

起帧源时用 `startSource({ assets })` 给 `{ 资产引用: 文件路径 }`；帧源自带的不用给，同一个引用两边都有时用给的那份。文件按扩展名分四种：

| 扩展名 | 怎么载 |
|---|---|
| `.json` | 本帧源自己的零件清单（`kit-spec/0.1`）：合成硬表面几何，带材质，清单里的灯和环境光一起搭进场景。长度米，右手系 Y 向上，颜色线性光 |
| `.glb`、`.gltf` | Blender 自带的 glTF 导入器 |
| `.stl` | Blender 自带的导入器；坐标原样当 Blender 的坐标（Z 向上），单位当米 |
| `.blend` | 把文件里的全部物体追加进来，相机不要 |

导入的文件里每个网格物体是一个零件；零件名只留字母、数字、下划线，重名的加 `_2`、`_3`。

自带的 `asset:rtx-card@1` 是一张双槽显卡的合成几何：三个零件 `body`、`fan_L`、`fan_R`，卡的中心在原点，长边沿 X，风扇一面朝 +Z；带三盏面光和一个低亮度的环境光，载进来就能渲。契约样例片子 `film-min` 的 `s01` 用的就是它（别名 `kit`）。

帧源接口契约还没定资产的文件经哪条通道交给帧源，现在由起帧源的人给路径；契约定了以后改从那里取。

## 自检

- `node --test beiming/sources/blender/source.test.mjs`：计划函数、两种作者模式、资产的四种载法。
- `node --test beiming/cards/blender-cards.test.mjs`：两张机制卡的卡文件，加 `film-min` 的 `s01` 实渲。

机器上没有 Blender 时，要起进程的那几项跳过，不算失败。找 Blender 的次序：环境变量 `BEIMING_BLENDER`，macOS 的应用目录，`PATH` 里的 `blender`。
