# 卡的运行时接口与装载顺序

版本：0.1.0-draft

## 1. 范围

管：

- 卡的实现对外的两种入口形状：`create` 和 `evaluate`。
- `create` 交回的 `Handle` 有哪些成员。
- 卡的引用写法 `<卡名>@<版本>`。
- 固定装载脚本搭镜头的六步顺序。
- 判定以上各条用的「卡核对记录」和「装载核对记录」。

不管：

- 卡文件里写什么（参数表、端口、`ports.order` 的词汇、实现文件挂在哪些宿主）：卡文件格式契约（CF）。
- `ctx` 的字段、镜头对象、实体名的写法：镜头契约（S）。
- 时间键、纯函数、状态摘要：时间键契约（T）。
- `texts`、`anchors`、`readings` 里面的结构：每帧元数据契约（M）。
- 镜头的资产和卡的清单写在片子描述的哪个字段：片子描述契约（D）。
- `tracks` 的数据格式：不归本契约，归属见第 6 节。

## 2. 术语

镜头局部帧号、子帧相位、纯函数、状态摘要、帧源、宿主、核对记录：见时间键契约（T）第 2 节。`ctx`、镜头对象、母语对象、实体、实体名、「卡加数据」模式、固定装载脚本：见镜头契约（S）第 2 节。

| 词 | 含义 |
|---|---|
| 卡 | 一份有名字、有版本、带参数表和自带测试的可复用技术做法；卡文件的格式见卡文件格式契约（CF）。 |
| 卡的实现 | 一张卡在某个落点上的那份代码，对外只有一个入口。 |
| 形状 | 入口的调用形式，只有 `create` 和 `evaluate` 两种。 |
| `create` 形状 | 工厂函数：拿 `ctx` 和参数，往场景或后期里放东西，交回一个 `Handle`。 |
| `evaluate` 形状 | 纯函数：拿数据和参数，算出 `tracks` 的一段，不碰场景。 |
| `Handle` | `create` 的返回值，宿主和镜头代码通过它驱动这张卡。 |
| 卡的引用 | 指明用哪张卡哪个版本的字符串 `<卡名>@<版本>`。 |
| 卡实例 | 一个镜头里对一张卡的一次使用；同一张卡可以在一个镜头里用多次。 |
| 实例前缀 | 一个卡实例在本镜头里的名字，用来给它带进来的实体名加前缀。 |
| 求值核 | 在渲染之前把片子描述算成 `tracks` 的那部分程序。 |
| `tracks` | 求值核算好的、按时刻取值的数据轨道。 |
| 相机类卡 | 卡文件里的类别是相机的卡。 |

## 3. 结构

### 3.1 两种入口

| 函数 | 参数 | 返回 | 谁调 | 说明 |
|---|---|---|---|---|
| `create(ctx, params)` | `ctx`：见 S 契约 3.2；`params`：这个卡实例的参数 | `Handle`，见 3.2 | `ctx.cards.use("<卡名>@<版本>", 参数)`，或固定装载脚本的第 3 步 | 帧源里和合成里的卡用这种 |
| `evaluate(inputs, params, f, sub)` | `inputs`：包围盒轨道、事件表这类数据；`params`：参数；`f`：镜头局部帧号，整数帧；`sub`：子帧相位 | `tracks` 的一段 | 求值核在算 `tracks` 时调 | 产出 `tracks` 的卡用这种；不经 `ctx.cards.use` |

卡内部怎么分函数由卡自己定。两种语言写法相同。

### 3.2 `Handle`

| 成员 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `object` | 母语对象 | 否 | three 的 `Object3D`、Blender 的物体或集合；后期类的卡没有 |
| `entities` | 对象，`{ 名字: 母语对象 }` | 否 | 这张卡带进场景的实体。名字加上实例前缀后并进镜头的 `entities` |
| `apply(f, sub)` | 函数，没有返回值 | 否 | 把 `(f, sub)` 这一时刻的状态写进场景。由镜头的 `state` 或固定装载脚本的第 5 步调 |
| `meta(f)` | 函数，返回 `{ texts?, anchors?, readings? }` | 否 | 只交宿主量不出来的三样 |
| `dispose()` | 函数，没有返回值 | 是 | 释放这张卡占的资源 |

### 3.3 卡的引用

`<卡名>@<版本>`。卡名是点分小写，至少两段，例如 `post.hdr-chain`。版本是 1 到 3 段十进制数，用 `.` 连接，例如 `@1`。

### 3.4 固定装载脚本的六步

「卡加数据」模式的镜头由宿主按下面的顺序搭，两个帧源相同。第 1 到 4 步每次装载跑一遍，第 5、6 步每帧跑一遍。

| 步 | 记录里的名字 | 做什么 |
|---|---|---|
| 1 | `assets` | 按片子描述里这个镜头的资产清单载入资产，零件名进 `entities` |
| 2 | `tracks` | 接上求值核算好的 `tracks` |
| 3 | `create` | 把这个镜头的卡清单按卡文件里 `ports.order` 声明的先后排好，逐张 `create(ctx, params)`；没声明先后的按书写顺序 |
| 4 | `collect` | 收集每个 `Handle.entities`；相机取 `tracks.camera`，没有就取相机类卡交出的对象 |
| 5 | 每帧 | 先 `tracks.apply(f, sub)`，再按第 3 步的顺序调各张卡的 `apply(f, sub)` |
| 6 | 每帧 | 宿主先量元数据，再并进各张卡的 `meta(f)` |

### 3.5 卡核对记录

顶层对象，`format` 是 `card-check/0.1`。一份记录说一张卡的一个实现。

| 字段 | 类型 | 单位 | 必填 | 值域 | 说明 |
|---|---|---|---|---|---|
| `format` | 字符串 | 无 | 是 | `card-check/0.1` | 格式标识 |
| `card` | 字符串 | 无 | 是 | 见 3.3 | 卡的引用 |
| `impl` | 字符串 | 无 | 否 | 相对路径 | 实现文件 |
| `shape` | 字符串 | 无 | 是 | `create`、`evaluate` | 卡文件声明的形状 |
| `entries` | 数组 | 无 | 是 | 字符串 | 实现文件对外提供的全部入口名 |
| `calledVia` | 字符串 | 无 | 是 | `cards.use`、`tracks` | 实际由谁调：`ctx.cards.use`（含固定装载脚本的第 3 步），还是求值核算 `tracks` 时 |
| `handle` | 对象 | 无 | 否 | | `create` 交回的 `Handle` 的观测；`evaluate` 形状不出现 |
| `handle.members` | 数组 | 无 | 是 | 字符串 | `Handle` 上出现的成员名 |
| `handle.prefix` | 字符串 | 无 | 否 | 实体名的写法 | 实例前缀 |
| `handle.entities` | 数组 | 无 | 否 | 字符串 | `Handle.entities` 的键 |
| `handle.merged` | 数组 | 无 | 否 | 字符串 | 这些实体并进镜头 `entities` 之后的名字，次序和 `handle.entities` 一一对应 |
| `handle.metaKeys` | 数组 | 无 | 否 | 字符串 | `Handle.meta(f)` 的返回值里出现过的键 |
| `evaluations` | 数组 | 无 | 否 | 每项 `{ f, sub, mode, digest }` | 纯函数门的观测。`create` 形状比的是 `apply` 之后的状态摘要，`evaluate` 形状比的是返回值的摘要；`mode` 的值域是 `single`、`shuffled`、`sequential` |
| `ext` | 对象 | 无 | 否 | 键带点分前缀 | 私有数据 |

### 3.6 装载核对记录

顶层对象，`format` 是 `load-check/0.1`。一份记录说固定装载脚本对一个镜头的一次装载。

| 字段 | 类型 | 单位 | 必填 | 值域 | 说明 |
|---|---|---|---|---|---|
| `format` | 字符串 | 无 | 是 | `load-check/0.1` | 格式标识 |
| `shot` | 字符串 | 无 | 是 | 小写字母、数字、连字符 | 镜头的标识 |
| `steps` | 数组 | 无 | 是 | `assets`、`tracks`、`create`、`collect` | 搭建阶段实际执行的次序 |
| `cards` | 数组 | 无 | 是 | 字符串，不重复 | 这个镜头的卡实例，按片子描述里的书写顺序 |
| `orderPairs` | 数组 | 无 | 否 | 每项 `[先, 后]`，都是 `cards` 里的名字 | 从各张卡的 `ports.order` 解出来的先后要求 |
| `createOrder` | 数组 | 无 | 是 | `cards` 的一个排列 | 实际调 `create` 的次序 |
| `applyOrder` | 数组 | 无 | 否 | `tracks` 或 `cards` 里的名字 | 一帧里实际的写状态次序；`tracks` 表示 `tracks.apply` |
| `metaOrder` | 数组 | 无 | 否 | `host` 或 `cards` 里的名字 | 一帧里元数据的合并次序；`host` 表示宿主量的那部分 |
| `camera` | 对象 | 无 | 否 | | 相机从哪里来 |
| `camera.tracksHasCamera` | 布尔 | 无 | 是 | | `tracks` 里有没有相机轨道 |
| `camera.from` | 字符串 | 无 | 是 | `tracks`、`card` | 实际取的是 `tracks.camera`，还是相机类卡交出的对象 |
| `ext` | 对象 | 无 | 否 | 键带点分前缀 | 私有数据 |

## 4. 不变量

| 编号 | 条文 | 怎么查 | 反例文件 |
|---|---|---|---|
| CR1 | 卡的一个实现对外必须正好有一个入口，是 `create` 或 `evaluate`，并且和卡文件声明的形状相同。 | `entries` 必须正好 1 项，等于 `shape` | `CR1-two-entries.json` |
| CR2 | `create` 形状的卡必须经 `ctx.cards.use` 调，`evaluate` 形状的卡必须由求值核调，不得经 `ctx.cards.use`。 | `shape` 是 `create` 时 `calledVia` 必须是 `cards.use`；是 `evaluate` 时必须是 `tracks` | `CR2-evaluate-via-cards-use.json` |
| CR3 | `create` 交回的 `Handle` 必须有 `dispose`。 | `shape` 是 `create` 时必须出现 `handle`，`handle.members` 里必须有 `dispose` | `CR3-handle-without-dispose.json` |
| CR4 | `Handle.apply(f, sub)` 必须是纯函数。 | `shape` 是 `create` 时，`evaluations` 里 `f`、`sub` 相同的条目 `digest` 必须逐位相同 | `CR4-apply-keeps-state.json` |
| CR5 | `Handle.meta(f)` 返回的键只能是 `texts`、`anchors`、`readings`。 | `handle.metaKeys` 每项必须是这三个之一 | `CR5-meta-reports-bbox.json` |
| CR6 | `Handle.entities` 里的名字并进镜头的 `entities` 时必须加实例前缀，写成 `<实例前缀>.<名字>`。 | `handle.merged` 的第 i 项必须等于 `handle.prefix`、`.`、`handle.entities` 的第 i 项连起来 | `CR6-entities-without-prefix.json` |
| CR7 | `evaluate(inputs, params, f, sub)` 必须是这四个参数的纯函数。 | `shape` 是 `evaluate` 时，`evaluations` 里 `f`、`sub` 相同的条目 `digest` 必须逐位相同 | `CR7-evaluate-order-dependent.json` |
| CR8 | 固定装载脚本的搭建阶段必须按载入资产、接 `tracks`、逐张 `create`、收集实体和相机的次序各做一次。 | `steps` 必须正好是 `["assets", "tracks", "create", "collect"]` | `CR8-create-before-tracks.json` |
| CR9 | `create` 的次序必须满足 `ports.order` 声明的全部先后，没声明先后的卡之间必须保持书写顺序。 | `createOrder` 必须等于 5.2 的排法算出的结果 | `CR9-declared-order-ignored.json` |
| CR10 | 每帧必须先调 `tracks.apply(f, sub)`，再按 `create` 的次序调各张卡的 `apply(f, sub)`。 | `applyOrder` 的第一项必须是 `tracks`，其余各项在 `createOrder` 里的位置必须递增 | `CR10-card-apply-before-tracks.json` |
| CR11 | 每帧必须由宿主先量元数据，再按 `create` 的次序并进各张卡的 `meta(f)`。 | `metaOrder` 的第一项必须是 `host`，其余各项在 `createOrder` 里的位置必须递增 | `CR11-card-meta-before-host.json` |
| CR12 | `tracks` 里有相机轨道时相机必须取 `tracks.camera`，没有时才取相机类卡交出的对象。 | `camera.tracksHasCamera` 是 `true` 时 `camera.from` 必须是 `tracks`，是 `false` 时必须是 `card` | `CR12-card-camera-over-tracks.json` |

## 5. 口径

### 5.1 纯函数门

求值方式同 T 契约 5.4，「逐位相同」同 T 契约 5.2。`create` 形状：对同一个 `Handle` 调 `apply(f, sub)` 之后取状态摘要。`evaluate` 形状：`inputs` 和 `params` 固定不变，对返回的那段 `tracks` 取摘要。

### 5.2 `create` 的排法

输入是书写顺序 `cards` 和先后要求 `orderPairs`。每一步在「所有必须排在它前面的卡都已经排好」的卡里，取书写顺序最靠前的那一张。先后要求成环，或者提到了 `cards` 里没有的名字，判构建失败。

### 5.3 位置递增

`applyOrder`、`metaOrder` 里除第一项之外的每个名字，都在 `createOrder` 里找它的下标；这串下标必须严格递增。没有 `apply` 或没有 `meta` 的卡可以不出现。

### 5.4 加前缀

实例前缀和名字之间用一个 `.` 连接，拼出来的名字必须符合 S 契约 5.2 的写法，并且受 S4 管。

## 6. 待定

| 项 | 现在怎么写 | 等什么 |
|---|---|---|
| `apply(f, sub)`、`evaluate(…, f, sub)` 的参数形状 | 照 `(f, sub)` 写 | `待定：离屏宿主的定位` |
| 卡的实现挂在哪些宿主，three 一侧的取值和着色语言 | 本契约不写，归卡文件格式契约（CF） | `待定：three 帧源的渲染器主干` |
| 形状按什么分 | 【起草者补】按产出分：产出 `tracks` 的一段用 `evaluate`，往场景或后期里放东西用 `create`。落点暂时在帧源一侧、但产出 `tracks` 的卡同样用 `evaluate` | 集成负责人确认 |
| 落点在帧源一侧的 `evaluate` 卡由谁调 | 按「求值核」写，`calledVia` 记 `tracks` | 集成负责人确认 |
| 卡的引用里版本写几段 | 【起草者补】1 到 3 段都收，例子只用主版本 | 卡文件格式契约（CF） |
| 实例前缀从哪里来 | 【起草者补】只规定拼法 `<实例前缀>.<名字>`，前缀的取值不定 | 片子描述契约（D） |
| `Handle` 上能不能有另外的成员 | 【起草者补】不禁止，宿主不得依赖 | 集成负责人确认 |
| 没声明先后的卡怎么排 | 【起草者补】5.2 的排法；成环判构建失败 | 集成负责人确认 |
| 各张卡 `meta(f)` 的合并次序 | 【起草者补】按 `create` 的次序 | 集成负责人确认 |
| 两张卡交出同名的文字框、锚点或读数 | 不定 | 每帧元数据契约（M） |
| `tracks` 里没有相机轨道、也没有相机类卡，或者有多张相机类卡 | 不定 | 集成负责人确认 |
| 第 1 步零件名进 `entities` 时加不加前缀 | 不定 | 片子描述契约（D） |
| `tracks` 的数据格式、`evaluate` 的 `inputs` 和返回值的结构归哪份契约 | 不定 | 集成负责人指派 |
| CR1 到 CR12 的编号 | 【起草者补】本契约自己编的 | 集成负责人确认 |
| 卡核对记录、装载核对记录这两个对象 | 【起草者补】为了让每条不变量都能用数据判定而加 | 集成负责人确认 |

## 7. 变更记录

| 日期 | 改了哪条 | 为什么 |
|---|---|---|
| 2026-11-18 | 全部 | 首稿 |
