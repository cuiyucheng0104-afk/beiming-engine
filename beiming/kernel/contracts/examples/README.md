# 契约样例

五份手写的片子，用来试已有的契约填不填得下去。这个目录不是一份契约，没有 `CONTRACT.md`，条文一律以各契约为准；样例和条文对不上时，算样例的缺陷。

## 1. 样例清单

| 目录 | 文件 | 是什么 | 镜头：帧源、宿主、作者模式 |
|---|---|---|---|
| `toon/` | `film.json`、`shots/s01/shot.js` | 卡通镜头：色阶着色写在入口文件里，相机和后期链用卡 | `s01`：`three`、`page`、`native-code` |
| `hard-surface/` | `film.json` | 硬表面拼装镜头：资产加六张卡，没有代码 | `s01`：`blender`、`cycles`、`cards-data` |
| `lab/` | `film.json` | 实验室镜头：由私有外部插件重放一个作品，只写结构 | `s01`：`ext.lab`、`plugin`、`native-code`，没有入口文件 |
| `film-min/` | `film.json` | 最小验收片：产品转台接片名落版，两个镜头都没有代码 | `s01`：`blender`、`cycles`、`cards-data`；`s02`：`three`、`page`、`cards-data` |
| `film-hard-surface/` | `film.json`、`shots/s02/shot.js` | 硬表面形态：拼装镜头接片名落版，带事件、叠加层、色彩脚本和追加断言 | `s01`：`blender`、`cycles`、`cards-data`；`s02`：`three`、`page`、`native-code` |

五份片子描述的 `format` 都是 `film/3.0`。卡名照首批技术卡清单；卡的参数名和参数值是示意，以卡文件为准。两份入口文件只用 `ctx.THREE`，宿主注入的版本是 `0.187.0`。

五份样例共同的写法：

- `shots[].cards` 是数组，每项 `{ as, use, params }`，书写顺序就是装载的书写顺序。`as` 是实例名，在一个镜头里不重复；路径按它寻址，例如 `shots/s01/cards/fit/params/margin`。
- 卡带进来的实体按实例名起名：带 `root: true` 的那个实体叫 `<as>`，别的叫 `<as>.<相对名>`。`film-min/` 和 `film-hard-surface/` 的 `s02` 里，`roles.hero` 写的 `title` 就是实例 `title` 的根实体。
- 指向文件的值都写资产别名，不写路径：拼装的烘焙数据（`asmPlan`）、私有外部插件重放的作品（`piece`）都在镜头的 `assets` 里。只有 `entry` 写路径。
- 时刻参数在片子描述里写全片帧号或时刻算式，卡拿到的是减去镜头 `in` 之后的镜头局部帧号。类型是 `data` 的参数里面的帧号（`camera.spline@1` 的 `keys[].f`）直接写镜头局部帧号。
- 角度参数用度，键名带 `Deg`。
- 断言里的帧区间是半开的 `[a,b)`。
- 每个叠加层由宿主展开成它那个镜头的一个卡实例：卡是 `two-d.overlay@1`，实例名是叠加层的 `id`，装在镜头自己的卡之后。所以叠加层的 `id`（`name`、`callout`）不和同一个镜头里的 `as` 重名。

## 2. 覆盖表

「静态」指只看这个目录里的文件就能判；「要记录」指要有核对记录（锁文件、镜头核对记录、装载核对记录、卡核对记录）或卡文件才能判，这个目录里没有，所以没判。别的契约在同一轮修订里新加的不变量，这张表不写编号，只写碰到的是哪件事。

| 样例 | 片子描述（D） | 镜头（S） | 卡的运行时接口（CR） | 卡文件格式（CF） |
|---|---|---|---|---|
| `toon/` | 静态：D1（单镜头）、D2（`event(pose) + 6`、`colorScript` 的键）、D8、D10、D11（宿主和模式都判）、D12（`native-code` 带 `entry`）、D13（事件和叠加层都在镜头区间里）。`cards` 的两项实例名不重复。可选键 `transitions`、`audio`、`style.finish`、`predicates.extra` 都不出现 | 静态：S3（一个出帧者）、S4 的写法（`hero`）、S7 和 S8（入口文件不读墙钟、不用随机，`meta` 只交 `anchors`）；`ctx.cards.use('post')` 只带声明过的实例名，不带参数。要记录：S1、S2、S5 | 静态：3.3 的引用写法；CR2 的用法（`camera.spline` 不经 `ctx.cards.use`，`post.hdr-chain` 经它）；CR3 的用法（`dispose` 里释放了 `Handle`）。要记录：CR1、CR4 到 CR7；叠加层 `name` 展开成的卡实例 | 没有卡文件，CF1 到 CF11 都要记录。碰到的条文：3.3 的 `data` 类型（`keys`，里面的 `f` 是镜头局部帧号） |
| `hard-surface/` | 静态：D1、D2（`event(lock) + 6`、卡参数里的 `event(lock)`）、D8、D10、D11（宿主和模式都判）、D12（`cards-data` 没有 `entry`）、D13。带 `handles`（留位）、`shutter`、`tiers`、`roles.mustSee`、`audio`（`mode` 之外都不写）、`predicates.extra`（半开区间 `[150,180)`）。烘焙数据经别名 `asmPlan` 进 `assets` | 静态：S3、S4 的写法（`kit`、`kit.rotor`、`kit.housing`）、S6（没有入口文件）。要记录：S1、S2 | 静态：3.3 的引用写法。要记录：CR8 到 CR12（六张卡的 `create` 次序、相机取 `tracks.camera` 还是卡）；叠加层 `callout` 展开成的卡实例 | 没有卡文件。碰到的条文：3.3 的 `time` 类型（`at`：片子描述里展开是全片第 150 帧，镜头的 `in` 是 0，卡拿到 150）、`asset` 类型（`plan`）、角度（`azimuthDeg`、`elevationDeg`，CF11） |
| `lab/` | 静态：D1、D8、D10、D12（`ext.lab` 的镜头是 `native-code`，没有 `entry`）、D13（没有事件）。重放的作品由 `assets` 里的别名 `piece` 说明，`params.piece` 写这个别名。D11 不判：登记表里没有 `ext.<名字>` 这一列。只有必填键加 `title`、`seed`、`assets`、`params`、`delivery.web` | 静态：S3。别的都要记录 | 没有卡 | 没有卡 |
| `film-min/` | 静态：D1（两个镜头首尾相接）、D2（`cut(180) + 12`、卡参数里的 `event(title)`）、D8（四个全片级的键都出现，都不写 `card`）、D10（转场带 `id`）、D11、D12、D13、D14（一项转场，落在切点上）。`s02` 带 `deliberate`：片名定住的 `[222, 300)` 声明成刻意的静止，落在 `s02` 的区间里 | 静态：S3、S4 的写法（`kit`、`title`）、S6（两个镜头都没有入口文件）。要记录：S1、S2 | 静态：3.3 的引用写法。要记录：CR8 到 CR12（两个镜头各装载一次）；`title` 这个实体名要卡的 `Handle` 交出带 `root: true` 的实体才成立 | 没有卡文件。碰到的条文：3.3 的 `time` 类型（`s02` 的 `enter` 写 `event(title)`，展开是全片第 192 帧，镜头的 `in` 是 180，卡拿到 12；`ctx.events.title` 也是 12）、`text` 类型（`text`）、`data` 类型（`keys`） |
| `film-hard-surface/` | 静态：D1、D2（`cut(180) + 12`、`event(lock) + 6`、`event(lock)`、`colorScript` 的两个键）、D8、D10（转场带 `id`）、D11、D12（一个镜头没有 `entry`，一个有）、D13、D14。`predicates.extra` 的帧区间是半开的 `[150,180)`。烘焙数据经别名 `asmPlan` 进 `assets` | 静态：S3、S4 的写法（`kit.fan_L`、`kit.fan_R`、`title`）、S6（`s01`）、S7 和 S8（`s02` 的入口文件）；`ctx.cards.use('title')` 只带声明过的实例名，文字写在片子描述里 | 静态：3.3 的引用写法；CR2 和 CR3 的用法（`s02` 的入口文件）。要记录：CR6（实例 `title` 的根实体并进来叫 `title`）、CR8 到 CR12（`s01`） | 没有卡文件。碰到的条文：3.3 的 `text` 类型（`s02` 的 `text`）、`asset` 类型（`plan`）、角度（CF11） |

D3、D4、D5、D6、D7、D9、D15 判的是锁文件、路径、写入和 `explain` 的结果，五份样例都不带这些，没判。

这一轮新加的可选字段，样例里用到的：`shots[].deliberate`（`film-min/`）。没用到的：`shots[].renderer`、`shutter.samples`、`audio.narration`、`delivery.layers`、`overlays[].anchor` 的 `screen` 和 `pos`。

## 3. 待定

| 项 | 样例里怎么写 | 等什么 |
|---|---|---|
| `three` 帧源的 `host` | `page`：帧源登记表里 `three` 登记的宿主（F 契约 3.4） | 按倾向定，合作者不同意时再改 |
| `ext.lab` 的 `host` | `plugin`，示意；帧源登记表里没有私有外部插件的宿主 | 帧源接口契约（F） |
| 入口文件里 `state(f, sub)`、`tracks.apply(f, sub)`、`apply(f, sub)` 的参数形状 | 照 `(f, sub)` 写 | `待定：离屏宿主的定位` |
| 入口文件里的着色语言 | 不出现；`toon/` 用渲染库内置的色阶材质，没有片段补丁 | `待定：three 帧源的渲染器主干` |
| `toon/` 的 `colorRef` | `scene`：页面宿主上的场景参考镜头，后期链把场景线性的颜色交给显示变换 | 页面宿主的场景参考通路 |
| `style.colorScript.*.tol` | `10`，示意 | `待探针：色彩脚本主色的色差公式和容差的量法` |
| 卡的参数名和参数值 | 示意 | 卡文件 |
| 入口文件里，卡带进来的实体由谁并进 `entities` | `film-hard-surface/` 的 `s02` 照镜头契约 3.5 的示意，由镜头代码交 `{ title: title.object }` | 镜头契约（S）、卡的运行时接口契约（CR） |
| 片名定住从哪一帧起 | `film-min/` 的 `deliberate` 写 `[222, 300)`，示意 | 卡文件 |

## 4. 样例里没有的文件

| 没有的文件 | 谁引用了它 | 为什么没有 |
|---|---|---|
| 资产 `asset:pump-asm-plan@1`、`asset:rtx-asm-plan@1` 的内容 | `hard-surface/`、`film-hard-surface/` 里 `assembly.schedule@1` 的 `plan`，经别名 `asmPlan` | 这份烘焙数据的格式没有契约管 |
| 资产 `asset:lab-piece@1` 的内容 | `lab/` 的 `params.piece`，经别名 `piece` | 私有外部插件重放的作品不进这个仓库 |
| 锁文件、核对记录、卡文件 | 覆盖表里写「要记录」的那些格子 | 锁文件由服务器生成；核对记录由一致性测试写；卡文件随卡交 |
