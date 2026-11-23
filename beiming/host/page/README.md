# host/page/：页面宿主

three 帧源这一对里的宿主：拥有设备（无头、静音的浏览器）、装载镜头、把时刻写进场景、量元数据、把各层落盘。帧源对上层的接口也在这里。

| 文件 | 在哪跑 | 管什么 |
|---|---|---|
| `host.mjs` | node | `startSource({ cards })`：起本机静态服务和一个浏览器进程，交回 `{ caps, open, stop }`。`caps`、`open` 是帧源接口；`stop` 关掉这个进程，起、停进程不属于帧源接口。`cards` 是给帧源的卡目录（相对 `beiming/`），默认空。`loadCards(dirs)`：读卡文件、过校验、算内容哈希 |
| `runtime.js` | 页面 | 搭 `ctx`、调一次 `build`（「卡加数据」模式跑固定装载脚本）、`ctx.cards.use`、驱动 `state`、量元数据、把卡交的文字框和读数并进元数据 |
| `measure.js` | 页面、node | 量元数据的算式：投影到屏幕、包围盒、屏占、平面深度范围、锚点、画面统计；场景查询的算式 `answerQuery` |
| `clock.js` | 页面 | 量耗时的单调时钟。全链路只有这一处读时钟，读数只进元数据的 `timing` |
| `cards-probe.shot.js` | 页面 | 测试探针镜头（`beiming/cards/m1a-cards.test.mjs` 用，不给片子用）：经 `ctx.cards.use` 装卡，把 Handle 成员摊成读数交出 |

`open(input, env)`：`input` 是镜头输入（求值核的 `shotInput` 算出来的，镜头条目原样；条目带 `renderer` 对象时出帧用它里面的那一套），`env` 是 `{ lock, tier, workspace, filmDir }`，四项必填，无锁写 `null`。每会话独占新页面，互不共享页面状态。装不了的输入报带错误码的错，不起页面。入口文件相对 `env.filmDir` 找。

细则在 `DETAILS.md`：镜头输入的四个可选字段（`events`、`assets`、`overlays`、`tokens`）、场景参考通路、卡和固定装载脚本、锚点、元数据怎么填。

`render(f, opts, want)` 交回 `{ meta, layers }`，`layers` 的值是层引用 `{ file, shape, components, hash }`。层文件写在 `env.workspace` 下面：

```
r<这个会话第几次成功的 render>-f<帧号>/color.f32      RGBA，32 位浮点，小端，行序从上到下，场景线性，预乘透明度
r<…>-f<帧号>/depth.f32      一个分量，米
r<…>-f<帧号>/objectId.u32   一个分量，32 位无符号整数
r<…>-f<帧号>/normal.f32     三个分量
```

文件没有文件头；`shape` 是 `[高, 宽, 分量数]`。元数据里的 `hash.color` 就是颜色层文件内容的哈希。

`query(f, q)` 答 `bbox3d`、`anchor`、`belowGround` 三种场景查询，在 `(f, sub = 0)` 上求值；没声明的种类报 `contract.unsupported-query`，错上的 `next` 是替代办法。每种交什么、怎么排、报错的先后见 `beiming/sources/three/DETAILS.md`。

场景参考通路（04 §4.1）：场景参考镜头（`colorRef: scene`）出了像素时，`render` 另交 `exr`（`frame.exr`：成片落 RGBA16F 目标读回的半浮点，连同这一帧要了的辅助层）和 `objectId2x`（`objectId2x.u32`：宽高各两倍的编号层，要了 `objectId` 才有）。这种镜头的场景画进 RGBA16F 目标，`color.f32` 里的数只有半浮点精度。

node 和页面之间：`open`、`render`、`query` 进页面前先落成纯数据快照（镜头输入、锁文件、档位、提供的卡、渲染选项与查询）；`render` 时页面把读回的各层（含半浮点成片与 2 倍编号层）编成 base64 交回，带错误码的错换成普通对象过序列化。页面宿主保留浏览器原生的全局 `Proxy`（不做全局替换），页面内入口只收纯数据的普通对象与数组，不防调用方自造的 `Proxy`。这一段和渲染器的五个服务（见 `beiming/sources/three/README.md`）都属内部实现，契约不管。

## 现在的边界

只配 three 的渲染器；不接资产，`ctx.assets.load`、`ctx.anchor` 一调就报错（锚点来自镜头的 `meta(f)` 和所装的卡的 `meta(f)`；落在相机平面上、透视除法除数 `w = 0` 的，元数据那一帧报错，`anchor` 查询只要世界坐标、照答，见 `DETAILS.md`）；叠加层展开要用的那张卡还没有，带叠加层的镜头装不了；带入口文件的镜头没有数据轨道（`ctx.tracks.apply` 是空操作）；数据卡产出的轨道除了相机都没有地方写，带着这种卡的镜头装不了；带入口文件的镜头里后期类的卡没有地方放（后期链只有固定装载脚本接）；卡交的文字框按 `ctx.size`（输出尺寸）算，档位带缩放时和这一帧的 `size` 对不上，没验证；片子描述所在的目录必须在静态服务放行的目录里。

浏览器启动参数沿用旧渲染器的 `chromeArgs()`，另加 `--mute-audio`。静态服务只绑本机地址，只放行 `beiming/`、three 的构建目录，以及 `fonts/` 与 `routes/c-style/fonts/` 下锁定的字体文件（woff2 与 `fonts.json`）。

测试：`node --test 'beiming/host/page/*.test.mjs'`；卡和固定装载的实渲核对在 `beiming/cards/m1a-cards.test.mjs`。
