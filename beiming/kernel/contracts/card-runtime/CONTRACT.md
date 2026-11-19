# 卡的运行时接口与装载顺序

版本：0.1.0-draft

## 1. 范围

管：

- 卡的实现对外的两种卡入口形状：`create` 和 `evaluate`。
- `create` 交回的 `Handle` 有哪些成员。
- 卡的引用写法 `<卡名>@<主版本>`。
- 固定装载脚本搭镜头的六步顺序，叠加层展开出的卡实例装在哪里。
- 判定以上各条用的「卡核对记录」和「装载核对记录」。

不管：

- 卡文件里写什么（卡名的写法、参数表、端口、`ports.order` 的词汇、实现文件挂在哪些宿主）：卡文件格式契约（CF）。
- `ctx` 的字段、镜头对象、实体名的写法：镜头契约（S）。
- 时间键、纯函数、状态摘要：时间键契约（T）。
- `texts`、`anchors`、`readings` 里面的结构：每帧元数据契约（M）。
- 镜头的资产清单、`cards` 数组和叠加层写在片子描述的哪个字段：片子描述契约（D）。
- 镜头输入有哪些字段、怎么从片子描述算出来：帧源接口契约（F）。
- `tracks` 的数据格式：不归本契约，归属见第 6 节。

## 2. 术语

镜头局部帧号、子帧相位、纯函数、状态摘要、核对记录：见时间键契约（T）第 2 节。帧源、宿主、镜头输入：见帧源接口契约（F）第 2 节。`ctx`、镜头对象、母语对象、实体、实体名、「卡加数据」模式、固定装载脚本：见镜头契约（S）第 2 节。

| 词 | 含义 |
|---|---|
| 卡 | 一份有名字、有版本、带参数表和自带测试的可复用技术做法；卡文件的格式见卡文件格式契约（CF）。 |
| 卡的实现 | 一张卡在某个落点上的那份代码，对外只有一个卡入口。 |
| 形状 | 卡入口的调用形式，只有 `create` 和 `evaluate` 两种。 |
| `create` 形状 | 工厂函数：拿 `ctx` 和参数，往场景或后期里放东西，交回一个 `Handle`。 |
| `evaluate` 形状 | 纯函数：拿数据和参数，算出 `tracks` 的一段，不碰场景。 |
| `Handle` | `create` 的返回值，宿主和镜头代码通过它驱动这张卡。 |
| 卡的引用 | 指明用哪张卡哪个主版本的字符串 `<卡名>@<主版本>`。 |
| 卡实例 | 一个镜头里对一张卡的一次使用：片子描述里这个镜头 `cards` 数组的一项 `{ as, use, params }`，或者宿主由一个叠加层展开出的一项（见 5.5）；同一张卡可以在一个镜头里用多次。 |
| 实例名 | 卡实例在本镜头里的名字：`cards` 数组那一项的 `as`；叠加层展开出的卡实例的实例名是叠加层的 `id`。在一个镜头里不得重复，不得是 `tracks`、`host`（这两个词在装载核对记录的次序里另有所指，见 5.3）。 |
| 实例前缀 | 就是实例名；用来给这个卡实例带进来的实体名、文字框的 `id`、读数的名字加前缀。 |
| 相对名 | `Handle.entities` 里的名字：卡内部给实体起的名字，还没加实例前缀。 |
| 求值核 | 在渲染之前把片子描述算成 `tracks` 的那部分程序。 |
| `tracks` | 求值核算好的、按时刻取值的数据轨道。 |
| 相机类卡 | 卡文件里的类别是相机的卡。 |

## 3. 结构

### 3.1 两种卡入口

| 函数 | 参数 | 返回 | 谁调 | 说明 |
|---|---|---|---|---|
| `create(ctx, params)` | `ctx`：见 S 契约 3.2；`params`：这个卡实例的参数，只从片子描述来，里面的时刻一律是镜头局部帧号（T9） | `Handle`，见 3.2 | `ctx.cards.use(as, runtime?)`（见 S 契约 5.8），或固定装载脚本的第 3 步 | 帧源里和合成里的卡用这种 |
| `evaluate(inputs, params, f, sub)` | `inputs`：包围盒轨道、事件表这类数据；`params`：参数，里面的时刻一律是镜头局部帧号（T9）；`f`：镜头局部帧号，整数帧；`sub`：子帧相位 | `tracks` 的一段 | 求值核在算 `tracks` 时调 | 产出 `tracks` 的卡用这种；不经 `ctx.cards.use` |

卡内部怎么分函数由卡自己定。两种语言写法相同。

### 3.2 `Handle`

| 成员 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `object` | 母语对象 | 否 | three 的 `Object3D`、Blender 的物体或集合；后期类的卡没有 |
| `entities` | 对象，`{ 相对名: 母语对象 }`；至多一项的值可以写成 `{ object: 母语对象, root: true }` | 否 | 这张卡带进场景的实体。键是相对名，照 5.4 加上实例前缀后并进镜头的 `entities`；带 `root: true` 的那个并进来就叫实例名，不带后缀 |
| `apply(f, sub)` | 函数，没有返回值 | 否 | 把 `(f, sub)` 这一时刻的状态写进场景。由镜头的 `state` 或固定装载脚本的第 5 步调 |
| `meta(f)` | 函数，返回 `{ texts?, anchors?, readings? }` | 否 | 只交宿主量不出来的三样。文字框的 `id` 和读数的名字并进镜头时照 5.4 加实例前缀；锚点只交这张卡自己带进来的实体的 |
| `dispose()` | 函数，没有返回值 | 是 | 释放这张卡占的资源 |

### 3.3 卡的引用

`<卡名>@<主版本>`，就是片子描述里 `cards` 数组每项的 `use`。卡名的写法见卡文件格式契约（CF）5.1。主版本是十进制整数。例：`post.hdr-chain@1`。

### 3.4 固定装载脚本的六步

「卡加数据」模式的镜头由宿主按下面的顺序搭，两个帧源相同。第 1 到 4 步每次装载跑一遍，第 5、6 步每帧跑一遍。

| 步 | 记录里的名字 | 做什么 |
|---|---|---|
| 1 | `assets` | 载入镜头输入里镜头条目的 `assets`（这个镜头的资产清单）列出的资产，零件名进 `entities`。镜头输入的 `assets`（全片的 `assets` 表）不在这一步整张载入，它的零件名不进 `entities`，见第 6 节 |
| 2 | `tracks` | 接上求值核算好的 `tracks` |
| 3 | `create` | 把这个镜头 `cards` 数组里的卡实例按卡文件里 `ports.order` 声明的先后排好，逐个 `create(ctx, params)`；没声明先后的按书写顺序，书写顺序就是数组顺序。然后把镜头输入的 `overlays` 里的每个叠加层展开成一个卡实例（卡是 `two-d.overlay@1`，实例名是叠加层的 `id`），装在镜头自己的卡之后，见 5.5 |
| 4 | `collect` | 收集每个 `Handle.entities`，照 5.4 加实例前缀；相机取 `tracks.camera`，没有就取相机类卡交出的对象 |
| 5 | 每帧 | 先 `tracks.apply(f, sub)`，再按第 3 步的顺序调各张卡的 `apply(f, sub)` |
| 6 | 每帧 | 宿主先量元数据，再并进各张卡的 `meta(f)`，文字框的 `id` 和读数的名字照 5.4 加实例前缀。叠加层的文字框由它展开出的那个卡实例的 `meta(f)` 交，归 `origin.shot` 名下（见 M 契约） |

### 3.5 卡核对记录

顶层对象，`format` 是 `card-check/0.1`。一份记录说一张卡的一个实现。

「来历」一栏的四个词见契约写法约定 3.1。格式标识、`ext` 和 `handle` 这个段本身不是观测，来历写「—」，段里的字段各自标。来历是相对测试工具说的：测试工具在被测的那一对（渲染器加宿主，见 F 契约第 2 节）之外，也在被测的卡之外。那一对里面任何代码产出的值，包括宿主和固定装载脚本自己记的账，都是 `自报`，不得填进 `旁观` 或 `量的` 的字段；测试工具放进夹具镜头代码里的观测点得到的值是 `旁观`，前提是观测点是测试工具自己的代码，不是渲染器、宿主或被测的卡的代码；测试工具自己读文件、读产物算出来的是 `量的`。`handle` 段里来历是 `旁观` 的字段这样取：测试工具用一个带入口文件的夹具镜头装这张卡，入口文件是测试工具自己的代码，在 `ctx.cards.use` 交回的 `Handle` 上数；宿主记的不得填进这几个字段。这份记录判两方：CR1、CR3、CR4、CR5、CR7、CR13 判卡的实现；CR2、CR6、CR14 判调这张卡、并它交出的名字的一方；CR17 管记录自己前后对不对得上。哪几条的查法只靠 `自报` 的字段，见第 6 节。

| 字段 | 类型 | 单位 | 必填 | 值域 | 来历 | 说明 |
|---|---|---|---|---|---|---|
| `format` | 字符串 | 无 | 是 | `card-check/0.1` | — | 格式标识 |
| `card` | 字符串 | 无 | 是 | 见 3.3 | `请求` | 卡的引用：测试工具装的是哪张卡 |
| `impl` | 字符串 | 无 | 否 | 相对路径 | `请求` | 实现文件：测试工具装的是哪一份 |
| `shape` | 字符串 | 无 | 是 | `create`、`evaluate` | `请求` | 卡文件声明的形状，测试工具从卡文件里读 |
| `entries` | 数组 | 无 | 是 | 字符串 | `量的` | 实现文件对外提供的全部卡入口名；测试工具自己读实现文件数，不取宿主报的 |
| `calledVia` | 字符串 | 无 | 是 | `cards.use`、`tracks` | `自报` | 实际由谁调：`ctx.cards.use`（含固定装载脚本的第 3 步），还是求值核算 `tracks` 时；调的一方自己记的 |
| `handle` | 对象 | 无 | 否 | | — | `create` 交回的 `Handle` 的观测；`evaluate` 形状不得出现（CR3） |
| `handle.members` | 数组 | 无 | 是 | 字符串 | `旁观` | `Handle` 上出现的成员名 |
| `handle.prefix` | 字符串 | 无 | `handle.merged` 或 `handle.mergedMetaIds` 出现时必填 | 实例名的写法，见 5.4 | `请求` | 实例前缀，就是这个卡实例的实例名；测试工具在夹具的片子描述里写的 `as` |
| `handle.entities` | 数组 | 无 | 否 | 字符串 | `旁观` | `Handle.entities` 的键，都是相对名 |
| `handle.roots` | 数组 | 无 | 否 | `handle.entities` 里的名字（CR17） | `旁观` | 带 `root: true` 的实体的相对名；不出现表示一个也没有 |
| `handle.merged` | 数组 | 无 | 否 | 字符串 | `自报` | 这些实体并进镜头 `entities` 之后的名字，次序和 `handle.entities` 一一对应，项数相同；宿主在并名字的地方记的 |
| `handle.metaKeys` | 数组 | 无 | 否 | 字符串 | `旁观` | `Handle.meta(f)` 的返回值里出现过的键；夹具镜头代码自己调 `meta(f)`，在返回值上数 |
| `handle.metaIds` | 数组 | 无 | 否 | 字符串 | `旁观` | `Handle.meta(f)` 交出的文字框的 `id` 和读数的名字；取法同 `handle.metaKeys` |
| `handle.mergedMetaIds` | 数组 | 无 | 否 | 字符串 | `自报` | 它们并进镜头之后的名字，次序和 `handle.metaIds` 一一对应，项数相同；宿主在并名字的地方记的 |
| `evaluations` | 数组 | 无 | 否 | 每项 `{ f, sub, mode, digest }` | `f`、`sub`、`mode`：`请求`；`digest`：`量的` | 纯函数门的观测。`create` 形状比的是 `apply` 之后的状态摘要，`evaluate` 形状比的是返回值的摘要；`mode` 的值域是 `single`、`shuffled`、`sequential`。`digest` 由测试工具自己的代码算（T 契约 5.2），不取卡报的，也不取宿主算的 |
| `ext` | 对象 | 无 | 否 | 键带点分前缀 | — | 私有数据 |

### 3.6 装载核对记录

顶层对象，`format` 是 `load-check/0.1`。一份记录说固定装载脚本对一个镜头的一次装载。

「来历」一栏的口径同 3.5，`camera` 这个段本身来历写「—」。这份记录判的是装载这个镜头的那一对里的宿主；CR16 例外，它判的是片子描述里的名字。`steps`、`createOrder`、`applyOrder`、`metaOrder`、`camera.from` 是固定装载脚本自己记的账，在被测的那一对里面，标 `自报`。哪几条的查法只靠它们，见第 6 节。

| 字段 | 类型 | 单位 | 必填 | 值域 | 来历 | 说明 |
|---|---|---|---|---|---|---|
| `format` | 字符串 | 无 | 是 | `load-check/0.1` | — | 格式标识 |
| `shot` | 字符串 | 无 | 是 | 见 D 契约 5.1 | `请求` | 镜头的标识：测试工具装载的是哪个镜头 |
| `build` | 字符串 | 无 | 是 | `ok`、`failed` | `量的` | 这一次装载的构建结论：装载这个镜头的那次调用成功还是报错 |
| `error` | 字符串 | 无 | 否 | 错误码，写法见 ER 契约 5.2，必须是错误码表登记过的码（CR18）；`build` 是 `ok` 时不得出现 | `量的` | 构建失败时报的错误码；没报错误码就不出现 |
| `steps` | 数组 | 无 | 是 | `assets`、`tracks`、`create`、`collect` | `自报` | 搭建阶段实际执行的次序；`build` 是 `failed` 时只记失败之前做过的那几步（5.6）。固定装载脚本自己记的 |
| `cards` | 数组 | 无 | 是 | 实例名（`as`，写法见 S 契约 5.2 的一段），不重复，不得是 `tracks`、`host` | `请求` | 这个镜头自己的卡实例，按片子描述里 `cards` 数组的顺序；测试工具从片子描述（它据此算出交给帧源的镜头输入）里读 |
| `overlays` | 数组 | 无 | 否 | 叠加层的 `id`（写法见 D 契约 5.1），不重复，不得是 `tracks`、`host`；和 `cards` 里的名字也不得重复（CR16） | `请求` | 这个镜头的叠加层展开出的卡实例，按片子描述里 `overlays` 的书写顺序；不出现表示没有。测试工具从片子描述（它据此算出交给帧源的镜头输入）里读：`shot` 等于这个镜头的 `id` 的那几项，就是镜头输入的 `overlays` 里的那几项 |
| `orderPairs` | 数组 | 无 | 否 | 每项 `[先, 后]`，名字是字符串；提到了 `cards` 里没有的名字时排不出次序（5.2、CR9） | `请求` | 从各张卡的 `ports.order` 解出来的先后要求；测试工具自己读卡文件解，不取宿主解的 |
| `createOrder` | 数组 | 无 | 是 | `build` 是 `ok` 时是 `cards` 加 `overlays` 的一个排列；`build` 是 `failed` 时是失败之前已经 `create` 过的那几个，可以是空数组；这时管次序的各条怎么判见 5.6 | `自报` | 实际调 `create` 的次序；固定装载脚本自己记的 |
| `applyOrder` | 数组 | 无 | 否 | 至少 1 项；`tracks`，或 `cards`、`overlays` 里的名字 | `自报` | 一帧里实际的写状态次序；`tracks` 表示 `tracks.apply`。固定装载脚本自己记的 |
| `metaOrder` | 数组 | 无 | 否 | 至少 1 项；`host`，或 `cards`、`overlays` 里的名字 | `自报` | 一帧里元数据的合并次序；`host` 表示宿主量的那部分。固定装载脚本自己记的 |
| `camera` | 对象 | 无 | 否 | | — | 相机从哪里来 |
| `camera.tracksHasCamera` | 布尔 | 无 | 是 | | `请求` | `tracks` 里有没有相机轨道；测试工具从交给那一对的 `tracks` 里读，不取宿主报的 |
| `camera.from` | 字符串 | 无 | 是 | `tracks`、`card` | `自报` | 实际取的是 `tracks.camera`，还是相机类卡交出的对象；固定装载脚本自己记的 |
| `ext` | 对象 | 无 | 否 | 键带点分前缀 | — | 私有数据 |

## 4. 不变量

| 编号 | 条文 | 怎么查 | 反例文件 |
|---|---|---|---|
| CR1 | 卡的一个实现对外必须正好有一个卡入口，是 `create` 或 `evaluate`，并且和卡文件声明的形状相同。 | `entries` 必须正好 1 项，等于 `shape` | `CR1-two-entries.json` |
| CR2 | `create` 形状的卡必须经 `ctx.cards.use` 调，`evaluate` 形状的卡必须由求值核调，不得经 `ctx.cards.use`。 | `shape` 是 `create` 时 `calledVia` 必须是 `cards.use`；是 `evaluate` 时必须是 `tracks` | `CR2-evaluate-via-cards-use.json` |
| CR3 | `create` 交回的 `Handle` 必须有 `dispose`；`evaluate` 形状的卡不得交回 `Handle`。 | `shape` 是 `create` 时必须出现 `handle`，`handle.members` 里必须有 `dispose`；`shape` 是 `evaluate` 时不得出现 `handle` | `CR3-handle-without-dispose.json`、`CR3-create-without-handle.json`、`CR3-evaluate-with-handle.json` |
| CR4 | `Handle.apply(f, sub)` 必须是纯函数。 | `shape` 是 `create` 时，`evaluations` 里 `f`、`sub` 相同的观测条目 `digest` 必须逐位相同 | `CR4-apply-keeps-state.json` |
| CR5 | `Handle.meta(f)` 返回的键只能是 `texts`、`anchors`、`readings`。 | `handle.metaKeys` 每项必须是这三个之一 | `CR5-meta-reports-bbox.json` |
| CR6 | `Handle.entities` 里的相对名并进镜头的 `entities` 时必须写成 `<as>.<相对名>`，带 `root: true` 的那个必须写成 `<as>`；`<as>` 是这个卡实例的实例名。 | `handle.merged` 和 `handle.entities` 的项数必须相同（`handle.entities` 没出现算 0 项）；`handle.merged` 的第 i 项：`handle.entities` 的第 i 项在 `handle.roots` 里时必须等于 `handle.prefix`，不在时必须等于 `handle.prefix`、`.`、`handle.entities` 的第 i 项连起来 | `CR6-entities-without-prefix.json`、`CR6-root-with-suffix.json`、`CR6-merged-length-mismatch.json` |
| CR7 | `evaluate(inputs, params, f, sub)` 必须是这四个参数的纯函数。 | `shape` 是 `evaluate` 时，`evaluations` 里 `f`、`sub` 相同的观测条目 `digest` 必须逐位相同 | `CR7-evaluate-order-dependent.json` |
| CR8 | 固定装载脚本的搭建阶段必须按载入资产、接 `tracks`、逐张 `create`、收集实体和相机的次序各做一次；构建失败时，失败之前做过的那几步必须是这个次序的开头一段。 | `build` 是 `ok` 时 `steps` 必须正好是 `["assets", "tracks", "create", "collect"]`；是 `failed` 时必须是这四项的开头一段（可以是空数组），见 5.6。排不出 `create` 次序时本条不判，见 5.2 | `CR8-create-before-tracks.json`、`CR8-failed-steps-not-prefix.json` |
| CR9 | `create` 的次序必须满足 `ports.order` 声明的全部先后，没声明先后的卡之间必须保持书写顺序；声明的先后排不出次序时必须判构建失败。 | 照 5.2 排不出次序（`orderPairs` 成环，或提到了 `cards` 里没有的名字）时，`build` 必须是 `failed`，次序不再比。排得出时，`createOrder` 去掉 `overlays` 里的名字之后：`build` 是 `ok` 时必须等于 5.2 的排法算出的结果，是 `failed` 时必须是这个结果的开头一段（见 5.6）；`cards` 和 `overlays` 有重名时这一半不判，归 CR16 | `CR9-declared-order-ignored.json`、`CR9-writing-order-swapped.json`、`CR9-order-cycle-build-ok.json`、`CR9-order-unknown-name-build-ok.json`、`CR9-failed-created-not-prefix.json` |
| CR10 | 每帧必须先调 `tracks.apply(f, sub)`，再按 `create` 的次序调各张卡的 `apply(f, sub)`。 | `applyOrder` 的第一项必须是 `tracks`，其余各项必须都在 `createOrder` 里，位置必须递增，见 5.3。排不出 `create` 次序时本条不判，见 5.2 | `CR10-card-apply-before-tracks.json`、`CR10-apply-not-in-create-order.json`、`CR10-apply-name-not-created.json` |
| CR11 | 每帧必须由宿主先量元数据，再按 `create` 的次序并进各张卡的 `meta(f)`。 | `metaOrder` 的第一项必须是 `host`，其余各项必须都在 `createOrder` 里，位置必须递增，见 5.3。排不出 `create` 次序时本条不判，见 5.2 | `CR11-card-meta-before-host.json`、`CR11-meta-not-in-create-order.json`、`CR11-meta-name-not-created.json` |
| CR12 | `tracks` 里有相机轨道时相机必须取 `tracks.camera`，没有时才取相机类卡交出的对象。 | `camera.tracksHasCamera` 是 `true` 时 `camera.from` 必须是 `tracks`，是 `false` 时必须是 `card` | `CR12-card-camera-over-tracks.json` |
| CR13 | 一个 `Handle` 的 `entities` 里带 `root: true` 的实体不得多于 1 个。 | `handle.roots` 出现时至多 1 项 | `CR13-two-roots.json` |
| CR14 | `Handle.meta(f)` 交出的文字框的 `id` 和读数的名字并进镜头时必须写成 `<as>.<名字>`。 | `handle.mergedMetaIds` 和 `handle.metaIds` 的项数必须相同（`handle.metaIds` 没出现算 0 项）；`handle.mergedMetaIds` 的第 i 项必须等于 `handle.prefix`、`.`、`handle.metaIds` 的第 i 项连起来 | `CR14-text-id-without-prefix.json`、`CR14-merged-ids-length-mismatch.json` |
| CR15 | 叠加层展开出的卡实例必须装在镜头自己的全部卡之后，彼此之间必须保持 `overlays` 的书写顺序。 | `build` 是 `ok` 时：`overlays` 的每个名字必须在 `createOrder` 里，必须全部排在 `cards` 的名字之后，相互的先后必须和 `overlays` 相同。`build` 是 `failed` 时：`createOrder` 里出现的叠加层必须排在 `cards` 的名字之后，必须是 `overlays` 的开头一段；出现了叠加层时，`cards` 的每个名字都必须已经在 `createOrder` 里（见 5.6）。排不出 `create` 次序（见 5.2）、或 `cards` 和 `overlays` 有重名（归 CR16）时本条不判 | `CR15-overlay-before-cards.json`、`CR15-overlays-out-of-order.json`、`CR15-overlay-not-created.json`、`CR15-failed-overlay-before-remaining-card.json`、`CR15-failed-overlays-skip-first.json` |
| CR16 | 叠加层展开出的卡实例的实例名不得和镜头自己的卡实例的实例名重复。 | `overlays` 的每一项都不得出现在 `cards` 里 | `CR16-overlay-name-same-as-card.json`、`CR16-overlay-clash-and-out-of-order.json` |
| CR17 | 卡核对记录里 `handle.roots` 的每一项必须是 `handle.entities` 里的名字。 | `handle.roots` 出现时，每一项都必须在 `handle.entities` 里；`handle.entities` 没出现算空数组 | `CR17-root-not-in-entities.json` |
| CR18 | 装载核对记录里的 `error` 必须是错误码表登记过的码。 | `error` 出现时，错误码表（`errors/errors.json`）的 `codes` 里必须有一项的 `code` 和它逐字符相同；`error` 不出现时本条不判 | `CR18-error-not-registered.json` |

## 5. 口径

### 5.1 纯函数门

求值方式同 T 契约 5.4，「逐位相同」同 T 契约 5.2。`create` 形状：对同一个 `Handle` 调 `apply(f, sub)` 之后取状态摘要。`evaluate` 形状：`inputs` 和 `params` 固定不变，对返回的那段 `tracks` 取摘要。

### 5.2 `create` 的排法

输入是镜头自己的卡实例的书写顺序 `cards`（就是片子描述里 `cards` 数组的顺序）和先后要求 `orderPairs`；叠加层展开出的卡实例不参加这个排法，见 5.5。每一步在「所有必须排在它前面的卡都已经排好」的卡里，取书写顺序最靠前的那一张。先后要求成环，或者提到了 `cards` 里没有的名字，就排不出次序，宿主必须判构建失败，错误码是 `contract.order-cycle`：装载核对记录的 `build` 必须是 `failed`（CR9；CR9 不比码，码对不对现在不判）。排不出次序的记录，CR8、CR10、CR11、CR15 和 CR9 里比次序的那一半都不判；CR12、CR16、CR18 照判。次序排得出、因为别的原因构建失败的记录见 5.6。

### 5.3 位置递增

`applyOrder`、`metaOrder` 里除第一项之外的每个名字，都在 `createOrder` 里找它的下标；这串下标必须严格递增。不在 `createOrder` 里的名字算没按次序排：出现在 `applyOrder` 里违反 CR10，出现在 `metaOrder` 里违反 CR11。没有 `apply` 或没有 `meta` 的卡可以不出现。第一项的 `tracks`、`host` 不是实例名：实例名不得用这两个词。

### 5.4 加前缀

- 实例前缀就是实例名 `as`。`Handle.entities` 里的名字是卡内的相对名，并进镜头时叫 `<as>.<相对名>`，中间一个 `.`。
- 每个 `Handle` 至多一个实体带 `root: true`，它并进来就叫 `<as>`，不带后缀。
- 文字框的 `id`、读数的名字同样加 `<as>.` 前缀。
- 锚点名在实体内唯一即可，不加前缀。「卡加数据」模式下，一个实体的锚点由带进这个实体的那张卡经 `Handle` 交。资产带进来的实体，锚点由资产交。
- `as` 的写法是 S 契约 5.2 的一段。拼出来的实体名必须符合 S 契约 5.2 的写法，并且受 S4 管。

### 5.5 叠加层

- 宿主把镜头输入的 `overlays` 里的每个叠加层展开成这个镜头的一个卡实例：卡是 `two-d.overlay@1`，实例名是叠加层的 `id`。镜头输入的 `overlays` 是片子描述里 `shot` 等于这个镜头的 `id` 的叠加层条目，原样（F 契约 3.2）；不出现表示这个镜头上没有叠加层，一个也不展开。宿主不从片子描述里另拿叠加层。
- 这些卡实例装在镜头自己的卡之后，彼此之间按 `overlays` 的书写顺序。每帧的 `apply`、`meta` 跟着 `create` 的次序（CR10、CR11）。
- 叠加层的文字框由这个卡实例的 `meta(f)` 交，归 `origin.shot` 名下。
- 这个卡实例进锁，见锁文件契约（LK）。

### 5.6 构建失败的记录

`build` 是 `failed`、次序排得出时，失败之前做过的部分照样要守次序，只是没做完：

- `steps` 是 `["assets", "tracks", "create", "collect"]` 的开头一段，可以是空数组（CR8）。
- `createOrder` 去掉 `overlays` 里的名字之后，是 5.2 的排法算出的结果的开头一段（CR9）。
- `createOrder` 里出现的叠加层排在镜头自己的卡之后，是 `overlays` 的开头一段；出现了叠加层，镜头自己的卡必须已经全部 `create` 过（CR15）。
- `applyOrder`、`metaOrder` 照 5.3 判，不分 `build`（CR10、CR11）。

「开头一段」指从第一项起连续的若干项，项数可以是 0 到全部。排不出次序的失败照 5.2，不在这一节。

## 6. 待定

| 项 | 现在怎么写 | 等什么 |
|---|---|---|
| `apply(f, sub)`、`evaluate(…, f, sub)` 的参数形状 | 照 `(f, sub)` 写 | 离屏宿主的定位：离屏宿主是核心帧源的出片宿主，three 帧源照旧用页面宿主。按倾向定，合作者不同意时再改 |
| 卡的实现挂在哪些宿主，three 一侧的取值和着色语言 | 本契约不写，归卡文件格式契约（CF） | three 帧源的渲染器主干：过渡期用 WebGL 加 GLSL。按倾向定，合作者不同意时再改 |
| 形状按什么分 | 【起草者补】按产出分：产出 `tracks` 的一段用 `evaluate`，往场景或后期里放东西用 `create`。落点暂时在帧源一侧、但产出 `tracks` 的卡同样用 `evaluate` | 集成负责人确认 |
| 落点在帧源一侧的 `evaluate` 卡由谁调 | 按「求值核」写，`calledVia` 记 `tracks` | 集成负责人确认 |
| `Handle` 上能不能有另外的成员 | 【起草者补】不禁止，宿主不得依赖 | 集成负责人确认 |
| 没声明先后的卡怎么排 | 【起草者补】5.2 的排法；成环判构建失败 | 集成负责人确认 |
| 各张卡 `meta(f)` 的合并次序 | 【起草者补】按 `create` 的次序 | 集成负责人确认 |
| `tracks` 里没有相机轨道、也没有相机类卡，或者有多张相机类卡 | 不定 | 集成负责人确认 |
| 第 1 步零件名进 `entities` 时加不加前缀 | 不定 | 片子描述契约（D） |
| 镜头输入的 `assets`（全片的 `assets` 表）在第 1 步载不载 | 【起草者补】不整张载入，它的零件名不进 `entities`：全片的表里有音轨这类不是场景零件的东西，也有别的镜头的零件，整张载入会把它们带进这个镜头的实体清单。镜头里的值指到全片表里的别名时照 D 契约 5.5 找得到；这样找到的资产在哪一步载入、零件名进不进 `entities`：不定。选错了要改 3.4 第 1 步 | 集成负责人确认；第一个用全片资产的「卡加数据」镜头 |
| `tracks` 的数据格式、`evaluate` 的 `inputs` 和返回值的结构归哪份契约 | 不定 | 集成负责人指派 |
| `ctx.cards.use` 的 `runtime` 怎么交到 `create` | 不定；`create(ctx, params)` 的签名没动 | 集成负责人定 |
| 多个叠加层展开出的卡实例之间的先后 | 【起草者补】按 `overlays` 的书写顺序 | 集成负责人确认 |
| 有入口文件的镜头里，叠加层展开出的卡实例在哪一步装 | 不定；3.4 只管「卡加数据」模式 | 集成负责人定 |
| 核对记录里的 `handle.roots`、`handle.metaIds`、`handle.mergedMetaIds`、`overlays` | 【起草者补】为了让 CR6、CR13、CR14、CR15 能用数据判定而加 | 集成负责人确认 |
| 装载核对记录里的 `build`、`error` | 为了分清「宿主正确地判了构建失败」和「违反」而加。【起草者补】`build` 必填，和镜头核对记录一样；`error` 可选 | 集成负责人确认 |
| 排不出 `create` 次序时报哪个错误码 | 不定；CR9 只要求 `build` 是 `failed` | 集成负责人定 |
| 因为别的原因构建失败（`build` 是 `failed`、次序排得出）时，管装载顺序的各条判不判 | 【起草者补】照判，但只判失败之前做过的部分：按 5.6 比开头一段。原来照完整次序判，3.6 允许的「失败之前已经 `create` 过的那几个」却过不了 CR8、CR9，诚实的失败记录没有合法的写法；改成全都不判又会放过失败之前就排错了的宿主。选错了要改 5.6 和 CR8、CR9、CR15 的「怎么查」 | 集成负责人确认 |
| 核对记录里的 `error` 必须是登记过的码（CR18）、`build` 是 `ok` 时不得出现 `error` | 【起草者补】原来只查写法，报一个没登记的码、或者构建通过却带着码，都没有一层拦。前一半立 CR18，后一半写进结构定义 | 集成负责人确认 |
| `handle.merged` 和 `handle.entities`、`handle.mergedMetaIds` 和 `handle.metaIds` 项数不同 | 【起草者补】「一一对应」读成项数必须相同，不同算违反 CR6、CR14 | 集成负责人确认 |
| 只有声明、没有判定的条文 | CR2：`calledVia` 是调的一方自己记的。CR8：`steps` 是固定装载脚本自己记的。CR9 里比次序的那一半、CR15：`createOrder` 是固定装载脚本自己记的，拿它去对从片子描述和卡文件算出来的次序，查的是「记得对不对」。CR10、CR11：`applyOrder`、`metaOrder`、`createOrder` 都是固定装载脚本自己记的。CR12：`camera.from` 是固定装载脚本自己记的。宿主把次序做错、把相机取错而照旧记对时，记录不变。这几处现在只有声明，没有判定。CR9 里「排不出次序必须判构建失败」那一半读的是量出来的 `build`，不在此列 | 观测点挪到被测的那一对外面。测试工具自己写的夹具卡在 `create`、`apply`、`meta` 里各记一笔，数得到卡和卡之间这三样被调的先后；`steps` 里另外三步、`applyOrder` 第一项的 `tracks`、`metaOrder` 第一项的 `host`、`calledVia`、`camera.from` 在卡里看不到，要另找办法。挪不挪、挪了以后记录怎么写，由集成负责人定；定了以后来历改成 `旁观` 或 `量的` |
| 只对了宿主自己的说法的条文 | CR6、CR14 拿 `自报` 的 `handle.merged`、`handle.mergedMetaIds` 去对 `旁观` 的相对名和 `请求` 的实例名：宿主并错了名字、记的却是对的时，这两条判不出来。它们还读了旁观到的字段，所以不算只有声明 | 有了从那一对交回的实体清单（F 契约 3.6）和每帧元数据里认出这些名字的办法；和上一行一起定 |
| 两份核对记录里几个字段的来历 | 【起草者补】`handle` 段的 `members`、`entities`、`roots`、`metaKeys`、`metaIds` 标 `旁观`，前提是用带入口文件的夹具镜头装这张卡、在 `ctx.cards.use` 交回的 `Handle` 上数。`entries` 标 `量的`，测试工具自己读实现文件。`camera.tracksHasCamera` 标 `请求`，前提是测试工具读得到交给那一对的 `tracks`；`tracks` 怎么交还没定，见上面「`tracks` 的数据格式」一行。选错了要改 3.5、3.6 这几格的来历和说明 | 集成负责人确认 |

## 7. 变更记录

| 日期 | 改了哪条 | 为什么 |
|---|---|---|
| 2026-11-18 | 全部 | 首稿 |
| 2026-11-18 | 第 1、2 节、3.1 到 3.6、CR1、CR6、CR9、新加 CR13 到 CR15、5.2、5.4、新加 5.5、第 6 节 | 照红队和跨契约一致性复核的处理结果改 |
| 2026-11-18 | 5.4、第 6 节；装载核对记录结构定义里叠加层 `id` 的正则 | 修订后的对齐收尾 |
| 2026-11-19 | 3.5、3.6（加 `build`、`error`）、CR3、CR6、CR8 到 CR11、CR14、CR15、新加 CR16、CR17、5.2、5.3、第 6 节 | 排不出次序时分不清「正确地判了失败」和「违反」，给装载核对记录加构建结论；条文里写了却没有任何一层去查的搭配（`evaluate` 形状带 `handle`、`overlays` 和 `cards` 重名、`handle.roots` 不在 `handle.entities` 里、实例名叫 `tracks` 或 `host`）落到不变量或结构定义；每种违反方式补齐反例；两个待定按倾向定下来 |
| 2026-11-19 | 3.5、3.6 加「来历」一栏和口径；第 6 节加三行。不变量的条文、结构定义和判定函数没动 | 核对记录的每个字段要写明来历；固定装载脚本自己记的次序、相机来源和调用方是自报，只靠它们的条文登记成只有声明 |
| 2026-11-19 | 第 1、2 节各一句；3.4 第 1、3 步；3.6 的 `cards`、`overlays` 两行的说明；5.5 第一条；第 6 节加一行。不变量的条文、结构定义、例子和判定函数没动 | 和帧源接口契约、片子描述契约对齐：片子的内容只从镜头输入进帧源，宿主展开的叠加层来自镜头输入的 `overlays`，第 1 步载入的是镜头输入里镜头条目的 `assets`；测试工具读的是它据以算出镜头输入的片子描述，不是把片子描述交给那一对 |
| 2026-11-19 | 装载核对记录 `error` 的值域和结构定义 | 错误码的写法统一引用错误码表的结构定义，不再只要求不空 |
| 2026-11-19 | 3.6 的 `error`、`steps`、`orderPairs`、`createOrder` 四行，结构定义（`build` 是 `ok` 时不得出现 `error`），5.2 末句，CR8 的条文，CR8、CR9、CR15 的「怎么查」，新加 5.6、CR18，CR8、CR9、CR15、CR16、CR18 的反例，正例一个，第 6 节改一行、加一行 | 次序排得出的构建失败原来没有合法的记录可写：3.6 允许只记失败前做过的，CR8、CR9 却照完整次序判，改成按开头一段判；`orderPairs` 的值域和 CR9 处理未知名字的写法相反；CR15 在重名时不判这一句没有反例看着；`error` 报了没登记的码、构建通过却带着码，原来没人拦 |
| 2026-11-19 | CR18 的反例 | 原来用的码将来可能被登记，到时反例会变成合规；改用一个专为反例编的、不会被登记的码 |
| 2026-11-19 | 5.2 写明排不出次序时报的码 | 错误码表登记了 `contract.order-cycle`；CR18 要求报的码登记过，原来这种失败没有码可报 |
