# host/page/：页面宿主

three 帧源这一对里的宿主：拥有设备（无头、静音的浏览器）、装载镜头、把时刻写进场景、量元数据、把各层落盘。帧源对上层的接口也在这里。

| 文件 | 在哪跑 | 管什么 |
|---|---|---|
| `host.mjs` | node | `startSource()`：起本机静态服务和一个浏览器进程，交回 `{ caps, open, stop }`。`caps`、`open` 是帧源接口；`stop` 关掉这个进程，起、停进程不属于帧源接口 |
| `runtime.js` | 页面 | 搭 `ctx`、调一次 `build`、驱动 `state`、量元数据 |
| `measure.js` | 页面、node | 量元数据的算式：投影到屏幕、包围盒、屏占、平面深度范围、画面统计 |
| `clock.js` | 页面 | 量耗时的单调时钟。全链路只有这一处读时钟，读数只进元数据的 `timing` |

`open(input, env)`：`input` 是镜头输入（求值核的 `shotInput` 算出来的，镜头条目原样；条目带 `renderer` 对象时出帧用它里面的那一套），`env` 是 `{ lock, tier, workspace, filmDir }`，四个都要写出来，`lock` 没有就写 `null`。每个会话一个新页面，互不共用页面里的任何状态。装不了的输入报带错误码的错，不起页面。入口文件相对 `env.filmDir` 找。

镜头输入的三个可选字段：`events`（已经展开成全片帧号的事件表）进 `ctx.events`（每个命名条目一项，值是全片帧号减这个镜头的起始帧，不截断）和元数据的 `events`（帧号等于这一帧全片帧号的条目）；不带时两处都是空的，宿主不从片子描述再展开。`assets`（全片的资产表）和镜头条目的 `assets` 一样算「用了资产」。`overlays` 要展开成卡的实例，算「用了卡」：没有锁文件时报 `env.lock-required`，带着锁文件来也装不了，报 `contract.unsupported-input`；带着锁文件来的卡和资产同样。

`render(f, opts, want)` 交回 `{ meta, layers }`，`layers` 的值是层引用 `{ file, shape, components, hash }`。层文件写在 `env.workspace` 下面：

```
r<这个会话第几次成功的 render>-f<帧号>/color.f32      RGBA，32 位浮点，小端，行序从上到下，场景线性，预乘透明度
r<…>-f<帧号>/depth.f32      一个分量，米
r<…>-f<帧号>/objectId.u32   一个分量，32 位无符号整数
r<…>-f<帧号>/normal.f32     三个分量
```

文件没有文件头；`shape` 是 `[高, 宽, 分量数]`。元数据里的 `hash.color` 就是颜色层文件内容的哈希。

node 和页面之间：`open` 时 node 把镜头输入、锁文件和档位交给页面；`render` 时页面把读回的各层编成 base64 交回，带错误码的错换成普通对象交回（错误码过不了那道序列化）。这一段和渲染器的四个服务（见 `beiming/sources/three/README.md`）都是这一对里面的事，契约不管。

现在的边界：只配 three 的渲染器；不接卡、叠加层、资产、锚点和数据轨道（`ctx.tracks.apply` 是空操作，`ctx.cards.use`、`ctx.assets.load`、`ctx.anchor` 一调就报错）；画风令牌传空；`visible` 不算，写 `null`；片子描述所在的目录必须在静态服务放行的目录里。

元数据量的是这一帧 `sub = 0` 的状态，和辅助层同一个样本；只要元数据的调用也先把这个状态写进场景再量。`seed` 填这次装载生效的镜头种子，`size` 填这次输出的宽和高（档位带缩放时是缩放之后的；只要元数据时照要是出像素会交回的颜色层填），`source.tier` 填这次装载的档位。`source.id` 填镜头条目顶层的 `source`，`source.renderer` 填出帧的帧源，`source.host` 填出帧用的宿主。溢出和压死的占比只给显示参考镜头算（按通道判）。

浏览器启动参数沿用旧渲染器的 `chromeArgs()`，另加 `--mute-audio`。静态服务只绑本机地址，只放行 `beiming/` 和 three 的构建目录。

测试：`node --test 'beiming/host/page/*.test.mjs'`
