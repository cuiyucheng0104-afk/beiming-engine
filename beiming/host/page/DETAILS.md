# host/page/：细则

`README.md` 放接口和边界，这里放它指过来的细则；两份合起来是页面宿主的全部说明。

## 镜头输入的可选字段

镜头输入的四个可选字段：`events`（已经展开成全片帧号的事件表）进 `ctx.events`（每个命名条目一项，值是全片帧号减这个镜头的起始帧，不截断）和元数据的 `events`（帧号等于这一帧全片帧号的条目）；不带时两处都是空的，宿主不从片子描述再展开。`assets`（全片的资产表）和镜头条目的 `assets` 一样算「用了资产」。`overlays` 要展开成卡的实例，算「用了卡」：没有锁文件时报 `env.lock-required`；带着锁文件来时每个卡实例要对得上提供的卡和锁文件（逐项见 `beiming/sources/three/README.md`），对不上的、带了资产的报 `contract.unsupported-input`。`tokens`（片子描述的画风令牌）原样进 `ctx.tokens`，不带时是空对象。

## 场景参考通路（04 §4.1）

场景参考镜头（`colorRef: scene`）出了像素时，`render` 在 `{ meta, layers }` 之外另交两样，文件写在同一个目录里；显示参考镜头、只要元数据的调用没有这两样：

| 返回值的键 | 文件 | 内容 |
|---|---|---|
| `exr`：`{ file, hash, channels }` | `frame.exr` | 单部件扫描线 EXR，32 位通道，不压缩，行序从上到下，`beiming/verify/exr/exr.mjs` 读得回。`color.R/G/B/A`：成片（子帧平均、过完后期链之后）在页面里落到 RGBA16F 目标、读回的半浮点，在 node 一侧解成数，场景线性，大于 1 的不截。这一帧要了的辅助层照输出通道契约的名字带上（`depth.Z`、`objectId.id`、`normal.X/Y/Z`），数和层文件逐位相同 |
| `objectId2x`：层引用 | `objectId2x.u32` | 要了 `objectId` 才有：宽高各两倍的编号层，`sub = 0`、点采样、不抗锯齿，一个分量。EXR 里另有 `objectId2x.coverage`：每个像素的 2×2 个子样本里编号和 `objectId.id` 相同的占几成。它不是输出通道契约的 `coverage`（那个从颜色层的样本数，这个帧源不交） |

层文件 `color.f32` 不变，仍是 32 位浮点目标读回的（帧源接口契约 3.4 的登记表）；EXR 里的颜色过了一道半浮点，和它差不到半浮点的一级（相对 2 的 −10 次方）。RGBA16F 目标读不回半浮点的机器上 `render` 抛错，不交黑图。每个场景参考帧因此多一趟读回、多一个和颜色层一样大的文件；实测帧率在 `beiming/calib/table/README.md`。

## 卡

卡的实现从 `/beiming/<卡文件 impl 的 entry>` 装进页面；一份实现对外必须正好一个卡入口，就是卡文件声明的形状。参数照卡文件核对（不认识的参数、类型不对、数出了范围报 `usage.bad-argument`），没写的用默认值；类型是 `time` 的换成镜头局部帧号（默认值直接当局部帧号用）。

带入口文件的镜头（`native-code`）：`ctx.cards.use(as, runtime)` 调那张卡的 `create`，交回 Handle；同一个实例名再用交回同一个 Handle。`as` 没在镜头条目的 `cards` 里声明过报 `contract.undeclared-card`，`runtime` 的键和卡参数同名报 `contract.runtime-shadows-param`；`runtime` 带了东西、或者实例是 `evaluate` 形状的，抛不带错误码的错（`runtime` 怎么交到 `create` 契约还没定）。Handle 带进来的实体由宿主照实例前缀并进镜头的实体；`object` 放哪、`apply` 什么时候调、`dispose` 归镜头代码。

没有入口文件的镜头（`cards-data`）跑固定装载脚本，四步：

1. `assets`：现在没有东西可载（带资产的镜头装载之前就报了装不了）。
2. `tracks`：`evaluate` 形状的卡实例接成数据轨道，每个时刻照书写顺序现算。这个宿主有地方写的只有相机轨道（一段里的 `camera`：`pos` 米、`quat`、`fovDeg` 度），写到 `tracks.camera` 这台相机上。
3. `create`：照各张卡 `ports.order` 排出的次序调 `create`，排不出报 `contract.order-cycle`；叠加层展开出的实例排在镜头自己的卡之后。`evaluate` 形状的实例轮到时只记次序。
4. `collect`：定相机、搭场景、收实体。相机取 `tracks.camera`；没有就取相机类卡交出的相机；再没有，用宿主备的一台：世界原点、朝 −Z、Y 向上、竖直视场角 40 度、近 0.1 米、远 100 米（契约没定这种情形）。`Handle.object` 按卡的类别放：`post` 类进帧源的后期链，`two-d` 类挂在相机下面（它的局部坐标就是相机空间），别的放在场景根下。

每个时刻先 `tracks.apply(f, sub)`，再照 `create` 的次序调各张卡的 `apply(f, sub)`。量元数据时宿主先量，再照 `create` 的次序并进各张卡的 `meta(f)`：文字框的 `id`、读数的名字前面加 `<实例名>.`；两种镜头都这样。

宿主自己记的账（做了哪几步、先后要求、`create` 的次序、每帧写状态和并元数据的次序、相机从哪来、每个卡实例的 Handle 上有什么、并进来叫什么）放在每帧元数据的 `ext["page.load"]` 里，只在镜头用了卡时出现；固定装载半路失败时，账挂在抛出的错的 `load` 上。

## 锚点

镜头代码的 `meta(f)` 交 `anchors: { "实体名#锚点名": [x, y, z] }`（世界坐标，米），宿主照元数据契约 5.2 投到屏幕，写进那个实体的 `anchors: { 锚点名: { world, screen } }`；只要元数据的调用也有。卡的 `meta(f)` 交的锚点只能挂在它自己带进来的实体上，实体名换成并进镜头之后的名字（这一支还没有卡用，没实渲过）。写法不对、实体不认识、同一个锚点交了两次、坐标不是三个有限的数，这一帧报错。

## 元数据怎么填

`visible`（可见比例）由渲染器在编号层上数了交过来，只有出了像素、带角色的实体才有，别的写 `null`；量法见 `beiming/sources/three/README.md`。

元数据量的是这一帧 `sub = 0` 的状态，和辅助层同一个样本；只要元数据的调用也先把这个状态写进场景再量。`seed` 填这次装载生效的镜头种子，`size` 填这次输出的宽和高（档位带缩放时是缩放之后的；只要元数据时照要是出像素会交回的颜色层填），`source.tier` 填这次装载的档位。`source.id` 填镜头条目顶层的 `source`，`source.renderer` 填出帧的帧源，`source.host` 填出帧用的宿主。溢出和压死的占比只给显示参考镜头算（按通道判）。
