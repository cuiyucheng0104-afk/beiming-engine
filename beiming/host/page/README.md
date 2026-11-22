# host/page/：页面宿主

three 帧源这一对里的宿主：拥有设备（无头、静音的浏览器）、装载镜头、把时刻写进场景、量元数据、把各层落盘。帧源对上层的接口也在这里。

| 文件 | 在哪跑 | 管什么 |
|---|---|---|
| `host.mjs` | node | `startSource({ cards })`：起本机静态服务和一个浏览器进程，交回 `{ caps, open, stop }`。`caps`、`open` 是帧源接口；`stop` 关掉这个进程，起、停进程不属于帧源接口。`cards` 是提供给帧源的卡目录（相对 `beiming/`），不给就是一张卡都没有。`loadCards(dirs)`：读卡文件、过校验、算内容哈希 |
| `runtime.js` | 页面 | 搭 `ctx`、调一次 `build`（「卡加数据」模式跑固定装载脚本）、`ctx.cards.use`、驱动 `state`、量元数据、把卡交的文字框和读数并进元数据 |
| `measure.js` | 页面、node | 量元数据的算式：投影到屏幕、包围盒、屏占、平面深度范围、锚点、画面统计 |
| `clock.js` | 页面 | 量耗时的单调时钟。全链路只有这一处读时钟，读数只进元数据的 `timing` |
| `cards-probe.shot.js` | 页面 | 探针镜头，测试工具的一部分（`beiming/cards/m1a-cards.test.mjs` 用），不是给片子用的：经 `ctx.cards.use` 装卡，把 Handle 上实际有什么摊成读数交出去 |

`open(input, env)`：`input` 是镜头输入（求值核的 `shotInput` 算出来的，镜头条目原样；条目带 `renderer` 对象时出帧用它里面的那一套），`env` 是 `{ lock, tier, workspace, filmDir }`，四个都要写出来，`lock` 没有就写 `null`。每个会话一个新页面，互不共用页面里的任何状态。装不了的输入报带错误码的错，不起页面。入口文件相对 `env.filmDir` 找。

镜头输入的四个可选字段：`events`（已经展开成全片帧号的事件表）进 `ctx.events`（每个命名条目一项，值是全片帧号减这个镜头的起始帧，不截断）和元数据的 `events`（帧号等于这一帧全片帧号的条目）；不带时两处都是空的，宿主不从片子描述再展开。`assets`（全片的资产表）和镜头条目的 `assets` 一样算「用了资产」。`overlays` 要展开成卡的实例，算「用了卡」：没有锁文件时报 `env.lock-required`；带着锁文件来时每个卡实例要对得上提供的卡和锁文件（逐项见 `beiming/sources/three/README.md`），对不上的、带了资产的报 `contract.unsupported-input`。`tokens`（片子描述的画风令牌）原样进 `ctx.tokens`，不带时是空对象。

`render(f, opts, want)` 交回 `{ meta, layers }`，`layers` 的值是层引用 `{ file, shape, components, hash }`。层文件写在 `env.workspace` 下面：

```
r<这个会话第几次成功的 render>-f<帧号>/color.f32      RGBA，32 位浮点，小端，行序从上到下，场景线性，预乘透明度
r<…>-f<帧号>/depth.f32      一个分量，米
r<…>-f<帧号>/objectId.u32   一个分量，32 位无符号整数
r<…>-f<帧号>/normal.f32     三个分量
```

文件没有文件头；`shape` 是 `[高, 宽, 分量数]`。元数据里的 `hash.color` 就是颜色层文件内容的哈希。

### 场景参考通路（04 §4.1）

场景参考镜头（`colorRef: scene`）出了像素时，`render` 在 `{ meta, layers }` 之外另交两样，文件写在同一个目录里；显示参考镜头、只要元数据的调用没有这两样：

| 返回值的键 | 文件 | 内容 |
|---|---|---|
| `exr`：`{ file, hash, channels }` | `frame.exr` | 单部件扫描线 EXR，32 位通道，不压缩，行序从上到下，`beiming/verify/exr/exr.mjs` 读得回。`color.R/G/B/A`：成片（子帧平均、过完后期链之后）在页面里落到 RGBA16F 目标、读回的半浮点，在 node 一侧解成数，场景线性，大于 1 的不截。这一帧要了的辅助层照输出通道契约的名字带上（`depth.Z`、`objectId.id`、`normal.X/Y/Z`），数和层文件逐位相同 |
| `objectId2x`：层引用 | `objectId2x.u32` | 要了 `objectId` 才有：宽高各两倍的编号层，`sub = 0`、点采样、不抗锯齿，一个分量。EXR 里另有 `objectId2x.coverage`：每个像素的 2×2 个子样本里编号和 `objectId.id` 相同的占几成。它不是输出通道契约的 `coverage`（那个从颜色层的样本数，这个帧源不交） |

层文件 `color.f32` 不变，仍是 32 位浮点目标读回的（帧源接口契约 3.4 的登记表）；EXR 里的颜色过了一道半浮点，和它差不到半浮点的一级（相对 2 的 −10 次方）。RGBA16F 目标读不回半浮点的机器上 `render` 抛错，不交黑图。每个场景参考帧因此多一趟读回、多一个和颜色层一样大的文件；实测帧率在 `beiming/calib/table/README.md`。

node 和页面之间：`open` 时 node 把镜头输入、锁文件、档位和提供的卡（卡文件加内容哈希）交给页面；`render` 时页面把读回的各层（连同场景参考通路的半浮点成片和 2 倍编号层）编成 base64 交回，带错误码的错换成普通对象交回（错误码过不了那道序列化）。这一段和渲染器的四个服务（见 `beiming/sources/three/README.md`）都是这一对里面的事，契约不管。

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

## 现在的边界

只配 three 的渲染器；不接资产，`ctx.assets.load`、`ctx.anchor` 一调就报错（锚点只接了镜头代码经 `meta(f)` 交的，见下）；叠加层展开要用的那张卡还没有，带叠加层的镜头装不了；带入口文件的镜头没有数据轨道（`ctx.tracks.apply` 是空操作）；数据卡产出的轨道除了相机都没有地方写，带着这种卡的镜头装不了；带入口文件的镜头里后期类的卡没有地方放（后期链只有固定装载脚本接）；卡交的文字框按 `ctx.size`（输出尺寸）算，档位带缩放时和这一帧的 `size` 对不上，没验证；片子描述所在的目录必须在静态服务放行的目录里。

锚点：镜头代码的 `meta(f)` 交 `anchors: { "实体名#锚点名": [x, y, z] }`（世界坐标，米），宿主照元数据契约 5.2 投到屏幕，写进那个实体的 `anchors: { 锚点名: { world, screen } }`；只要元数据的调用也有。卡的 `meta(f)` 交的锚点只能挂在它自己带进来的实体上，实体名换成并进镜头之后的名字（这一支还没有卡用，没实渲过）。写法不对、实体不认识、同一个锚点交了两次、坐标不是三个有限的数，这一帧报错。

`visible`（可见比例）由渲染器在编号层上数了交过来，只有出了像素、带角色的实体才有，别的写 `null`；量法见 `beiming/sources/three/README.md`。

元数据量的是这一帧 `sub = 0` 的状态，和辅助层同一个样本；只要元数据的调用也先把这个状态写进场景再量。`seed` 填这次装载生效的镜头种子，`size` 填这次输出的宽和高（档位带缩放时是缩放之后的；只要元数据时照要是出像素会交回的颜色层填），`source.tier` 填这次装载的档位。`source.id` 填镜头条目顶层的 `source`，`source.renderer` 填出帧的帧源，`source.host` 填出帧用的宿主。溢出和压死的占比只给显示参考镜头算（按通道判）。

浏览器启动参数沿用旧渲染器的 `chromeArgs()`，另加 `--mute-audio`。静态服务只绑本机地址，只放行 `beiming/` 和 three 的构建目录。

测试：`node --test 'beiming/host/page/*.test.mjs'`；卡和固定装载的实渲核对在 `beiming/cards/m1a-cards.test.mjs`。
