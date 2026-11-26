# 帧源接口

版本：0.2.0-draft

## 1. 范围

管：

- 帧源名的值域。
- 帧源对外的接口：`caps`、`open`，会话的 `manifest`、`render`、`query`、`close`。
- `open` 收到的「镜头输入」和运行环境 `env`。
- 能力声明 `Caps` 的字段，合规档 `conformance`，档是 `limited` 时免哪几条。
- 一次 `render` 能要哪些输出、必须交回什么；层文件的格式和层引用。
- 帧源登记表 `source/0.1`：登记过的帧源各自能力的上限。
- 场景查询 `SceneQuery` 和它的结果 `QueryResult`。
- 帧源要求调用方声明的预算：准入、墙钟预算用完、本机动态库对不上钉住的哈希时报哪个码（5.15）。
- 帧源一致性套件测哪几样。
- 判定以上各条用的「帧源核对记录」。

不管：

- 每帧元数据里面的字段：每帧元数据契约（M）。
- 时间键、快门窗口、子帧累积、辅助层取哪个时刻：时间键契约（T）。
- 镜头入口 `build`、`ctx`、镜头对象：镜头契约（S）。
- 通道登记表，以及深度、物体编号、法线、运动矢量各层的数值定义：输出通道契约（PS）。
- 「镜头输入」里的镜头条目和锁文件里面的结构：片子描述契约（D）、锁文件契约（LK）。
- 帧源里面宿主和渲染器之间怎么接：各帧源自己定，不立契约。
- 辅助层被用层的一方拿去做什么：5.12 只写要求，等合成那一步的契约来判。
- 错误怎么包装、错误码的全表：信封契约（EN）、错误码表契约（ER）。
- 场景包的格式：场景包契约（SP）。
- 各种查询的结果拿去判什么：谓词登记表契约（PR）。

## 2. 术语

帧、镜头、镜头局部帧号、子帧相位、种子、快门角、子帧采样、逐子帧累积、辅助层、场景参考镜头、显示参考镜头、核对记录：见时间键契约（T）第 2 节。镜头代码、入口文件、实体、实体名、锚点、搭镜头的模式、「卡加数据」模式：见镜头契约（S）第 2 节。

| 词 | 含义 |
|---|---|
| 帧源 | 渲染器加宿主的一对：按镜头局部帧号交出一帧的颜色层、辅助层和元数据。对上层只有 3.2 的接口。 |
| 帧源名 | 帧源的标识，值域见 3.1。 |
| 宿主 | 帧源里拥有设备、推时钟、装载镜头、量元数据、把画面落盘的那一部分。一个帧源可以配哪几种宿主，列在能力声明的 `hosts` 里。 |
| 渲染器 | 帧源里算像素的那一部分。 |
| 镜头输入 | `open` 的第一个参数：这个镜头出片要读的片子内容，见 3.2。 |
| 能力声明 | 帧源说自己能交什么、怎么交的一个数据对象，`caps()` 的返回值。 |
| 会话 | 对一个镜头 `open` 之后得到的对象，到 `close` 为止。 |
| 输出 | 一次 `render` 能要的东西，名字在 `OutputName` 的值域里，见 3.3。 |
| 像素输出 | 除 `meta` 之外的输出，名字都是输出通道契约（PS）3.1 的通道名。 |
| 颜色层 | 名叫 `color` 的输出。 |
| 层文件 | 装一个像素输出的文件，一个通道一个文件，格式见 3.3。 |
| 层引用 | `FrameResult.layers` 里的一个值：指向一个层文件，带它的形状、分量和哈希，见 3.3。 |
| 运动矢量层 | 名叫 `motion` 的输出，辅助层之一。 |
| 声明过的输出 | 能力声明的 `outputs` 里出现并且取值不是 `false` 的输出；`lightgroup:<名>` 看 `lightgroup:*` 这个键，见 3.4。 |
| 静默降级 | 要的东西交不出，却不报错，少交或换一种交。 |
| 原生运动模糊 | 由渲染器自己在一次渲染里算出的运动模糊，不是逐子帧累积。 |
| 合规档 | 帧源要过多少条：`full` 是全部，`limited` 是按 3.5 的减免表免掉几条。 |
| 私有外部插件 | 不在本仓库里、按 `limited` 档接进来的第三方运行时。 |
| 档位 | 一次出片是草稿还是终稿：`draft`、`final`。 |
| 作者模式 | 帧源接受镜头用哪几种办法搭出来，列在能力声明的 `modes` 里。 |
| 实体清单 | `manifest()` 交回的、这个镜头全部实体的编号、名字和类别。 |
| 场景查询 | 不出像素、直接向场景问几何关系的一次调用。 |
| 哈希档 | 同一台机器上同一帧渲两遍，结果逐位相同。 |
| 容差档 | 同一帧渲两遍的结果不逐位相同，只在容差内相同。 |
| 帧源登记表 | 登记过的帧源各自能力的上限，见 3.4 和 3.9。 |
| 一致性套件 | 帧源注册和每次升级时跑的一组校准测试，见 5.3。 |
| 帧源核对记录 | 一致性测试把对一个帧源的一个镜头的观测写下来的数据对象，只用来判定不变量。 |

## 3. 结构

### 3.1 帧源名

| 帧源名 | 是什么 |
|---|---|
| `blender` | Blender 帧源 |
| `three` | three 帧源 |
| `core` | 核心帧源 |
| `legacy-page` | 本仓库 `sources/legacy-page` 里的旧页面作品，不交完整元数据 |
| `ext.<名字>` | 私有外部插件；`<名字>` 只含小写字母、数字、连字符，首字符必须是小写字母或数字 |

别的契约里出现「帧源名」，值域都是这一张表。

### 3.2 接口

| 函数 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `caps()` | 无 | `Caps`，见 3.4 | 不开会话就能调。同一个版本的帧源每次返回的内容必须相同 |
| `open(input, env)` | `input`：镜头输入，见下表；`env`：见下表 | `Session` | 装载这个镜头 |
| `session.manifest()` | 无 | `Manifest`，见 3.6 | 渲染之前拿实体清单 |
| `session.render(f, opts, want)` | `f`：镜头局部帧号，整数帧；`opts`：`RenderOpts`；`want`：`OutputName` 的数组 | `FrameResult` | 渲一帧，见 3.3 |
| `session.query(f, q)` | `f`：镜头局部帧号，整数帧；`q`：`SceneQuery`，见 3.7 | `QueryResult` | 问场景，不出像素 |
| `session.close()` | 无 | 无 | 释放会话 |

除 `caps` 和 `manifest` 之外都是异步的。签名的写法见 `types.d.ts`。

这六个函数是帧源对上层的全部接口。宿主和渲染器之间怎么接由各帧源自己定，不立契约；一对里谁管哪件事见 5.10。

镜头输入 `ShotInput`。接口值，不带 `format`，不得有别的字段。它由上层从片子描述算出来；片子的内容只从这里进帧源，`env` 只放这次运行的环境。后四个字段可选，不出现表示没有。

| 字段 | 类型 | 单位 | 必填 | 值域 | 说明 |
|---|---|---|---|---|---|
| `film` | 字符串 | 无 | 是 | 片子的 `id`，写法见 D 契约 5.1 | 片子标识 |
| `output` | 对象 | 无 | 是 | `{ size, fps }`，两个都必填；值域同 D 契约 3.2 的 `output.size`、`output.fps` | 画幅和帧率。`size` 是 `[宽, 高]`，单位像素 |
| `shot` | 对象 | 无 | 是 | 一个镜头条目，见 D 契约 3.3 | 片子描述里这个镜头的条目，原样传，不改写。镜头条目带 `renderer` 对象时也原样带着，帧源自己读它 |
| `assets` | 对象 | 无 | 否 | `{ 别名: 资产引用 }`，同 D 契约 3.1 的 `assets` | 全片的 `assets` 表，原样。镜头能用的资产是镜头条目的 `assets` 加这一张表 |
| `events` | 对象 | 无 | 否 | 一份事件表，见事件表契约（EV）3.1 | 已经展开成全片帧号的事件表，原样。时刻算式由上层展开一次，帧源不得再从片子描述展开 |
| `overlays` | 数组 | 无 | 否 | 每项是片子描述 `overlays[]` 的一个条目，见 D 契约 3.4 | 落在这个镜头上的叠加层条目：片子描述的 `overlays` 里 `shot` 等于这个镜头 `id` 的那几项，原样，保持片子描述里的书写顺序 |
| `tokens` | 对象 | 无 | 否 | 片子描述的 `style.tokens`，见 D 契约 3.5 | 片子描述的画风令牌，原样；片子描述没写就不出现。镜头代码的 `ctx.tokens` 就是它（S 契约 3.2）。色值是 `#RRGGBB`，显示空间（D 契约 5.9），宿主不换算；要场景线性值的镜头代码自己解码 |

「出帧用的那一套」：镜头条目带 `renderer` 对象时，是 `renderer` 对象里的 `source`、`host`、`mode`、`entry`；不带时，是镜头条目顶层的这四样。本契约说到一个镜头出帧用的 `host`、`mode`、`entry`，都照这一句取。镜头条目顶层的 `source` 不因为带了 `renderer` 而改写。

`env`：

| 字段 | 类型 | 单位 | 必填 | 值域 | 说明 |
|---|---|---|---|---|---|
| `lock` | 对象或 `null` | 无 | 是 | 见锁文件契约（LK） | 这部片子的锁文件。`null` 的原因只有一种：这次没有锁文件。没有锁时各值从哪来见 5.11 |
| `tier` | 字符串 | 无 | 是 | `draft`、`final` | 档位 |
| `workspace` | 字符串 | 无 | 是 | 不空 | 放产物的目录：层文件写在它下面，层引用的 `file` 相对它。运行时的值，可以是绝对路径，不进任何落盘的对象 |
| `filmDir` | 字符串 | 无 | 是 | 不空 | 片子描述所在的目录：出帧用的 `entry` 相对它。运行时的值，可以是绝对路径，不进任何落盘的对象 |

### 3.3 `RenderOpts`、`OutputName`、`FrameResult`

`RenderOpts`，三个字段都可以不出现。`samples`、`scale` 不出现时用能力声明和档位定下的值，依次看两处，前一处没有才看后一处：镜头条目的 `tiers` 里这个档位的值（D 契约 3.3），能力声明里这个档位的值（`draft` 或 `final`，见 3.4）。`shutter` 不出现时用镜头条目的快门，见 5.9：

| 字段 | 类型 | 单位 | 必填 | 值域 | 说明 |
|---|---|---|---|---|---|
| `samples` | 整数 | 次 | 否 | ≥ 1 | 每像素采样数 |
| `scale` | 双精度 | 无 | 否 | `(0, 1]` | 输出尺寸的缩放 |
| `shutter` | 对象 | 无 | 否 | | 快门 |
| `shutter.angleDeg` | 双精度 | 度 | 是 | `[0, 360]` | 快门角；0 表示没有运动模糊 |
| `shutter.samples` | 整数 | 次 | 是 | ≥ 1 | 子帧采样数 |

`OutputName` 的值域：`meta`，加输出通道契约（PS）3.1 登记表里的全部通道名（含 `lightgroup:<名>`）。本契约的条文点名用到的几个：

| 名字 | 是什么 |
|---|---|
| `meta` | 每帧元数据，结构见每帧元数据契约（M） |
| `color` | 颜色层 |
| `depth` | 深度层 |
| `objectId` | 物体编号层 |
| `normal` | 法线层 |
| `motion` | 运动矢量层 |

`FrameResult`：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `meta` | 每帧元数据 | 能力声明的 `outputs.meta` 是 `true` 时必填 | 能力声明的 `outputs.meta` 是 `true` 时，每次成功的 `render` 都有 |
| `layers` | 对象 | 是 | 像素输出。键是通道名，值是层引用，见下表；交了哪一层就有哪个键，一层都没交时是空对象 |

层引用 `LayerRef`。接口值，不带 `format`，不得有别的字段。

| 字段 | 类型 | 单位 | 必填 | 值域 | 说明 |
|---|---|---|---|---|---|
| `file` | 字符串 | 无 | 是 | 相对路径，写法照通用口径 | 层文件，相对 `env.workspace` |
| `shape` | 数组 | 无 | 是 | 3 个正整数 | `[高, 宽, 分量数]`；高和宽的单位是像素，分量数就是 `components` 的项数（F21） |
| `components` | 数组 | 无 | 是 | 至少 1 项，分量名，不重复 | 这次交了的分量，名字和次序照输出通道契约（PS）3.1 |
| `hash` | 字符串 | 无 | 是 | `sha256:` 加 64 位小写十六进制 | 层文件内容的哈希，写法照通用口径「哈希」；和每帧元数据契约（M）的 `hash.color` 是同一种写法，两个值能逐字符比 |

层文件的格式：

- 一个通道一个文件。文件里只有数，没有文件头；数值类型是能力声明里这个输出的 `type`，写法照通用口径「二进制表」。
- 按行主序排，最后一维变得最快：行从上到下（和每帧元数据契约（M）5.2 的屏幕原点一致），一行里像素从左到右，一个像素里各分量按 `components` 的次序挨着写。所以文件的字节数等于 `shape` 各项之积乘以 4。这和场景包契约（SP）5.2 的二进制表是同一种写法。
- 一个层文件里各分量的数值类型相同。`objectId` 带覆盖率时两个分量类型不同（`id` 是 `u32`，`coverage` 是 `f32`），怎么装：`待定：带覆盖率的 objectId 怎么装进文件`。只交 `id` 一个分量的 `objectId` 不受影响。

`want` 里没有 `color` 的 `render` 叫「只要元数据」：不出像素，只交回元数据。这时元数据里哪些字段是 `null`，由每帧元数据契约（M）管。

### 3.4 能力声明 `Caps`

顶层对象，`format` 是 `caps/0.1`。

| 字段 | 类型 | 单位 | 必填 | 值域 | 说明 |
|---|---|---|---|---|---|
| `format` | 字符串 | 无 | 是 | `caps/0.1` | 格式标识 |
| `id` | 字符串 | 无 | 是 | 帧源名，见 3.1 | 哪个帧源 |
| `version` | 字符串 | 无 | 是 | 不空 | 帧源的版本 |
| `language` | 字符串 | 无 | 是 | `python`、`js`、`wgsl` | 这个帧源里的代码用的语言；`python`、`js` 和镜头契约（S）的语言是同一组词 |
| `hosts` | 数组 | 无 | 是 | 至少 1 项，字符串 | 这个帧源可以配哪几种宿主；一个镜头配哪个，由这个镜头出帧用的 `host` 定，见 3.2 |
| `conformance` | 字符串 | 无 | 是 | `full`、`limited` | 合规档，见 3.5 |
| `outputs` | 对象 | 无 | 是 | `color`、`meta`、`depth`、`objectId`、`normal`、`motion` 六个键必须出现；别的键只能是 PS 3.1 的固定通道名或 `lightgroup:*` | 每个输出能不能交，见下表 |
| `sceneQuery` | 数组 | 无 | 是 | `bbox3d`、`anchor`、`intersect`、`contact`、`belowGround`，不重复 | 能答哪几种场景查询；一种都不能答写空数组 |
| `motionBlur` | 对象 | 无 | 是 | | 运动模糊怎么做，见下表 |
| `determinism` | 字符串 | 无 | 是 | `hash-same-machine`、`tolerance` | 哈希档还是容差档 |
| `draft` | 对象 | 无 | 是 | | 草稿档怎么出，见下表 |
| `final` | 对象 | 无 | 是 | | 终稿档怎么出，见下表 |
| `granularity` | 字符串 | 无 | 是 | `frame` | 最小能单独渲的单位 |
| `randomAccess` | 布尔 | 无 | 是 | | 能不能任意帧单独渲 |
| `modes` | 数组 | 无 | 是 | 至少 1 项：`cards-data`、`build-script`、`native-code`，不重复 | 作者模式，也就是搭镜头的模式；三个词的定义见下表 |
| `cost` | 对象 | 无 | 是 | `{ unit }`，`unit` 的值域是 `gpu-second` | 成本用什么单位记 |
| `input` | 字符串 | 无 | 否 | 格式标识 | 帧源直接吃的场景格式，例如 `scene-pack/0.1` |
| `solvers` | 数组 | 无 | 否 | `path` | 有哪几种求法；`path` 是路径追踪 |
| `channels` | 字符串 | 无 | 否 | 格式标识 | 这个帧源另外交全套输出通道时，通道表的格式标识，由输出通道契约（PS）定 |
| `metaNull` | 数组 | 无 | 否 | 见每帧元数据契约（M）3.6 的「可以声明」一类：`stats.noise`、`stats.tris`、`texts`、`lights`，不重复 | 这个帧源交不出、在元数据里一律写 `null` 的字段 |
| `ext` | 对象 | 无 | 否 | 键带点分前缀 | 私有数据 |

`modes` 的三个词。别的契约说到搭镜头的模式，都以这张表为准：

| 词 | 定义 |
|---|---|
| `cards-data` | 没有入口文件；就是「卡加数据」模式 |
| `build-script` | 入口文件只在构建时跑一次，把场景搭进帧源自己的场景和时间线，之后逐帧由帧源求值 |
| `native-code` | 入口文件是镜头代码，宿主每帧调它的 `apply` |

`source` 是 `ext.<名字>` 的镜头，`mode` 必须是 `native-code`，不得有 `entry`；这一条由片子描述契约（D）3.3 判。

`outputs`：

| 键 | 类型 | 值域 | 说明 |
|---|---|---|---|
| `color` | 对象 | `{ type, transfer, primaries, note? }` | 颜色层。`transfer` 必须是 `linear`，`primaries` 必须是 `rec709`：数值是线性编码，原色是 Rec.709 |
| `meta` | 布尔 | 帧源名不是 `ext.<名字>` 时必须是 `true`（F29）；是 `ext.<名字>` 时必须是 `false`（F28） | 交不交每帧元数据 |
| `depth`、`objectId`、`normal`、`motion` | `false` 或对象 | `false`，或 `{ type, note? }` | `false` 表示交不出 |
| PS 3.1 里别的固定通道名 | `false` 或对象 | `false`，或 `{ type, note? }` | 可以不出现；不出现和 `false` 一样，表示交不出 |
| `lightgroup:*` | `false` 或对象 | `false`，或 `{ type, note? }` | 可以不出现；不出现和 `false` 一样。取值不是 `false` 表示任何一个 `lightgroup:<名>` 都交得出。具体的 `lightgroup:<名>` 不得作键 |

`type` 是这个输出的层文件里的数值类型，值域 `f32`、`u32`；它不说渲染时用的精度。`note` 是给人看的补充说明，不空的字符串，机器不读。

`motionBlur`：

| 字段 | 类型 | 必填 | 值域 | 说明 |
|---|---|---|---|---|
| `mode` | 字符串 | 是 | `native`、`accumulate` | 原生运动模糊，还是逐子帧累积 |
| `auxAt` | 字符串 | 是 | `sub0` | 辅助层（输出通道契约（PS）3.1 登记表里取法是 `sub0` 的通道）取哪个样本。只有一种：时刻是这一帧的 `sub = 0`，镜头孔径按 0（针孔），快门按 0，像素内的位置取像素中心，只取这一个样本；定义见时间键契约（T）的 T8 |
| `samples` | 整数 | `mode` 是 `accumulate` 时必填，否则可以不出现 | ≥ 1，单位是次 | 默认的子帧采样数：这次调用和镜头条目都没写、生效的快门角又不是 0 时用它，见 5.9 |
| `conflicts` | 数组 | 否 | `OutputName`，不重复 | 开着原生运动模糊时不能同时要的输出 |

`draft`：

| 字段 | 类型 | 单位 | 必填 | 值域 | 说明 |
|---|---|---|---|---|---|
| `kind` | 字符串 | 无 | 是 | `cycles-low`、`scale`、`path-low` | 草稿档的做法 |
| `samples` | 整数 | 次 | 是 | ≥ 1 | 每像素采样数 |
| `scale` | 双精度 | 无 | 是 | `(0, 1]` | 输出尺寸的缩放 |
| `denoise` | 字符串 | 无 | 否 | 不空 | 用哪种降噪；不降噪就不出现 |

`final`，和 `draft` 对称，少一个 `kind`：

| 字段 | 类型 | 单位 | 必填 | 值域 | 说明 |
|---|---|---|---|---|---|
| `samples` | 整数 | 次 | 是 | ≥ 1 | 每像素采样数 |
| `scale` | 双精度 | 无 | 是 | `(0, 1]` | 输出尺寸的缩放 |
| `denoise` | 字符串 | 无 | 否 | 不空 | 用哪种降噪；不降噪就不出现 |

帧源登记表。下表登记的是三个帧源各自能力的上限，不是现状：一个帧源现在真的交得出什么，以它的 `caps()` 为准。登记表里有的帧源，能力声明必须落在登记表之内（F15）。「之内」逐字段这样算：

| 字段 | 怎么算在登记表之内 |
|---|---|
| `hosts`、`modes`、`sceneQuery` | 能力声明列的每一项，登记表里都有 |
| `outputs` 里除 `meta` 之外的键 | 登记表写了类型的输出：能力声明要么是 `false`（或不出现），要么 `type` 和登记表相同。登记表写 `false` 或不出现的输出：能力声明必须是 `false` 或不出现 |
| `motionBlur.mode`、`determinism` | 和登记表相同；登记表里这一格还是 `待探针` 时不比 |

别的行 F15 不比。上面三行用到的格子另存成数据，放在本目录的 `source.json`，结构见 3.9；别的契约要查登记表，查的也是这一份。片子用了登记表里有、帧源的能力声明里还没有的宿主或作者模式时，`open` 报错（F16）。登记表里没有的帧源（`legacy-page`、`ext.<名字>`）F15 不查。

已经登记的三个帧源各自的取值：

| 字段 | `blender` | `three` | `core` |
|---|---|---|---|
| `version` | Blender 的版本号 | `0.187.0` | 锁文件锁定的提交号 |
| `language` | `python` | `js` | `wgsl` |
| `hosts` | `cycles` | `page`（按倾向定，合作者不同意时再改） | `offscreen`（按倾向定，合作者不同意时再改）、`headless-page` |
| `conformance` | `full` | `full` | `full` |
| `outputs.color.type` | `f32` | `f32`（已定：32 位浮点渲染目标的探针过了，页面宿主的三种后端都量过，见第 6 节） | `f32` |
| `outputs.depth` | `f32` | `f32` | `f32` |
| `outputs.objectId` | `u32` | `u32` | `u32`，另带覆盖率 |
| `outputs.normal` | `f32` | `f32`（已定：依据同 `outputs.color.type` 那一格） | `f32` |
| `outputs.motion` | `false` | `false` | `f32` |
| `outputs` 里别的键 | 不出现 | 不出现 | `denoiseAlbedo`、`denoiseNormal`、`lightgroup:*`，都是 `f32` |
| `sceneQuery` | 五种全有 | `bbox3d`、`anchor`、`belowGround` | 五种全有 |
| `motionBlur.mode` | `native` | `accumulate` | `native` |
| `motionBlur.auxAt` | `sub0` | `sub0` | `sub0` |
| `motionBlur.samples` | 不出现 | `8`（已定，见第 6 节） | 不出现 |
| `motionBlur.conflicts` | `motion` | 不出现 | 不出现 |
| `determinism` | `tolerance` | `hash-same-machine`（探针数据表第 11 行和「5090 读数」一节，两台机器） | `待探针：核心帧源同机渲两遍是否逐位相同` |
| `draft` | `cycles-low`，24 次，0.5，降噪 `gpu` | `scale`，1 次，0.5 | `path-low`，24 次，0.5，降噪 `oidn-native` |
| `final` | `待定：blender 终稿档每像素采样数` | 1 次，1.0 | `待定：core 终稿档每像素采样数` |
| `granularity`、`randomAccess` | `frame`、`true` | `frame`、`true` | `frame`、`true` |
| `modes` | 三种全有 | 三种全有 | `cards-data`、`build-script` |
| `input`、`solvers`、`channels` | 不出现 | 不出现 | `scene-pack/0.1`、`path`、输出通道契约（PS）的格式标识 |
| `metaNull` | 本表不规定 | 至少列 `lights` | 本表不规定 |

核心帧源不执行镜头提交的着色器代码，所以它的 `modes` 里没有 `native-code`。

### 3.5 合规档和减免表

`limited` 免哪几条写死在下表，表里没写的一条不免。

| 帧源 | 档 | 免什么 | 另外必须过 |
|---|---|---|---|
| `blender`、`three` | `full` | 无 | 无 |
| `core` | `full` | 无 | 输出通道契约（PS）的通道口径 |
| `legacy-page` | `limited` | 元数据里的 `camera` 和 `entities`（写 `null`）；一致性套件里的深度口径、编号与元数据、法线空间、相机约定四项；T2、T11 对第三方源码的静态扫描（改判 T1 的行为门） | 文字框回读，见 5.3 |
| `ext.<名字>` | `limited` | 逐帧的元数据（`outputs.meta` 是 `false`，不交 `meta/0.1`，只交来源信息，见表后）；F4；T2、T11 对第三方源码的静态扫描（改判 T1 的行为门，T1 只判 `sequential` 重复两遍） | 整段成片过片子描述 `delivery` 里的交付规格和像素类检查 |

`ext.<名字>` 交的「来源信息」是一个接口值，不带 `format`：字段、必填和值域见每帧元数据契约（M）3.5 的 `source` 一段，本契约不另抄。它不是 `meta/0.1`。交几个、从哪个接口交，见第 6 节。

档是 `limited` 的帧源出的镜头，不参加依赖 `camera` 和 `entities` 的检查。

T2、T11 的静态扫描只扫本仓库里的文件；`limited` 帧源里第三方作品的源码不扫，见时间键契约（T）5.3。

「像素类检查」指谓词登记表契约（PR）登记表里 `reads` 只含成片的那些谓词；`reads` 的词见 PR 契约 5.2。

输出通道契约（PS）的 PS1（七个固定通道齐全）只管出层方 `core` 和 `oracle`。别的帧源在能力声明的 `outputs` 里声明自己交得出的通道就行。

### 3.6 实体清单 `Manifest`

`manifest()` 的返回值。接口值，不带 `format`，不得有别的字段。

| 字段 | 类型 | 单位 | 必填 | 值域 | 说明 |
|---|---|---|---|---|---|
| `frames` | 整数 | 帧 | 是 | ≥ 1 | 这个镜头的帧数：必须等于镜头输入里镜头条目的 `out` 减 `in`，算法同镜头契约（S）3.2 的 `ctx.frames` |
| `entities` | 数组 | 无 | 是 | | 这个镜头的全部实体，每项见下表 |

`entities[]`：

| 字段 | 类型 | 必填 | 值域 | 说明 |
|---|---|---|---|---|
| `id` | 整数 | 是 | ≥ 1 | 实体的编号，从哪来见表后。0 不是任何实体的编号：物体编号层里 0 表示这个样本没打到任何实体（输出通道契约（PS）5.1） |
| `name` | 字符串 | 是 | 实体名，写法见 S 契约 5.2 | 实体名 |
| `class` | 字符串 | 是 | 不空 | 实体的类别，和元数据里的 `class` 是同一个词 |

编号从哪来。别的契约说到实体编号的来源，都以这一段为准：

- 镜头由场景包描述时，编号以场景包实例表里的实体编号为准（场景包契约（SP）3.4）。它是数据，不是照规则算的。
- 镜头没有场景包时（镜头代码自己搭场景），由帧源分配：把实体清单里的实体名按字节序从小到大排，从 1 起依次编号（F20）。
- 编号只在一个镜头的一次装载里有意义。跨帧源比较一律按实体名对，不按编号对。

### 3.7 场景查询 `SceneQuery` 和 `QueryResult`

两个都是接口值，不带 `format`，不得有别的字段。

`SceneQuery`：

| 字段 | 类型 | 单位 | 必填 | 值域 | 说明 |
|---|---|---|---|---|---|
| `kind` | 字符串 | 无 | 是 | `bbox3d`、`anchor`、`intersect`、`contact`、`belowGround` | 问什么 |
| `of` | 数组 | 无 | 是 | 至少 1 项；实体名，或带通配的实体名（见 5.5） | 问谁 |
| `against` | 数组 | 无 | 否 | 至少 1 项；写法同 `of` | 和谁比；只有 `intersect`、`contact` 用 |
| `tol` | 双精度 | 米 | 否 | ≥ 0 | 容差 |

五种查询：

| `kind` | 问的是 |
|---|---|
| `bbox3d` | 实体的三维包围盒 |
| `anchor` | 实体上锚点的位置 |
| `intersect` | `of` 和 `against` 里的实体有没有互相穿插 |
| `contact` | `of` 和 `against` 里的实体有没有接触 |
| `belowGround` | 实体有没有落到地面以下 |

`QueryResult`：

| 字段 | 类型 | 单位 | 必填 | 值域 | 说明 |
|---|---|---|---|---|---|
| `kind` | 字符串 | 无 | 是 | 同 `SceneQuery.kind` | 答的是哪种查询 |
| `items` | 数组 | 无 | 是 | 最多 50 项 | 每项见下表 |
| `truncated` | 整数 | 项 | 否 | ≥ 1 | 被截掉几项；没截就不出现 |

`items[]`：

| 字段 | 类型 | 单位 | 必填 | 值域 | 说明 |
|---|---|---|---|---|---|
| `a` | 字符串 | 无 | 是 | 实体名 | 这一项说的实体 |
| `b` | 字符串 | 无 | 否 | 实体名 | 和它比的另一个实体 |
| `value` | 双精度 | 见 `unit` | 是 | | 量出来的数 |
| `unit` | 字符串 | 无 | 是 | 不空 | `value` 的单位，长度写 `m` |
| `at` | 数组 | 米 | 否 | 至少 1 项，双精度 | 世界坐标里的位置 |

### 3.8 帧源核对记录

顶层对象，`format` 是 `source-check/0.1`。一份记录说一个帧源的一个镜头。记录里出现哪一段，就判哪几条不变量；没出现的段不判。观测了、结果是空的写空数组；没观测的段和字段不出现。

「来历」一栏的四个词见契约写法约定 3.1。来历是相对测试工具说的：测试工具在被测的帧源之外；帧源里面任何代码（渲染器、宿主）产出的值，以及从元数据里直接抄出来的字段，都是 `自报`；测试工具自己读层文件、数调用的结果、照自己搭的夹具算出来的是 `量的`。格式标识、`ext` 和各段的数组本身不是观测，来历写「—」，段里的字段各自标。

| 字段 | 类型 | 单位 | 必填 | 值域 | 来历 | 说明 |
|---|---|---|---|---|---|---|
| `format` | 字符串 | 无 | 是 | `source-check/0.1` | — | 格式标识 |
| `shot` | 字符串 | 无 | 是 | 镜头的 `id`，写法见 D 契约 5.1 | `请求` | 这份记录说的是哪个镜头。记录里的 `shotFrame` 都是这个镜头的局部帧号 |
| `caps` | `Caps` | 无 | 是 | 见 3.4 | `自报` | 被测帧源的能力声明，`caps()` 的返回值整份收进来 |
| `opens` | 数组 | 无 | 否 | | — | 对 `open` 的观测，每项见下表 |
| `renders` | 数组 | 无 | 否 | | — | 对 `render` 的观测，每项见下表 |
| `orderRuns` | 数组 | 无 | 否 | | — | 乱序和重复渲的观测，每项见下表 |
| `failures` | 数组 | 无 | 否 | | — | 渲染失败的观测，每项见下表 |
| `queries` | 数组 | 无 | 否 | | — | 对 `query` 的观测，每项见下表 |
| `badArgs` | 数组 | 无 | 否 | | — | 故意把参数传出值域的调用，每项见下表 |
| `manifest` | `Manifest` | 无 | 否 | 见 3.6 | `自报` | `manifest()` 交回的实体清单，整份收进来 |
| `scenePack` | 布尔 | 无 | 否 | | `请求` | 这个镜头是不是由场景包描述；夹具镜头是测试工具自己备的，它自己知道。没记就不出现，F20 不查 |
| `metaEntities` | 数组 | 无 | 与 `manifest` 同时出现 | | — | 抽到的各帧元数据里的实体，每项见下表 |
| `textReadbacks` | 数组 | 无 | 否 | | — | 文字框回读的观测，每项见下表 |
| `ext` | 对象 | 无 | 否 | 键带点分前缀 | — | 私有数据 |

`opens[]`：一次 `open` 调用。镜头输入和 `env` 是测试工具自己备的，结构合乎 3.2。

| 字段 | 类型 | 必填 | 值域 | 来历 | 说明 |
|---|---|---|---|---|---|
| `hasLock` | 布尔 | 是 | | `请求` | 这次传的 `env.lock` 是锁文件（`true`），还是 `null`（`false`） |
| `hasSeed` | 布尔 | 是 | | `请求` | 镜头输入的镜头条目写没写 `seed` |
| `usesCards` | 布尔 | 是 | | `请求` | 镜头用没用卡：镜头条目的 `cards` 出现并且不空，或者镜头输入的 `overlays` 出现并且不空，两样有一样就是 `true`。叠加层要展开成卡的实例，见 5.11 |
| `usesAssets` | 布尔 | 是 | | `请求` | 镜头条目的 `assets`、镜头输入的 `assets` 里是不是有一个出现并且不空 |
| `host` | 字符串 | 是 | 不空 | `请求` | 这个镜头出帧用的 `host`，取法见 3.2 |
| `mode` | 字符串 | 是 | `cards-data`、`build-script`、`native-code` | `请求` | 这个镜头出帧用的 `mode`，取法见 3.2 |
| `unfitInput` | 数组 | 否 | `cards`、`assets`、`overlays`，不重复 | `请求` | 这次的镜头输入里，被测帧源装不了的是哪几样，三个词见 5.14。测试工具备的镜头输入带着卡、资产或叠加层时，先照被测帧源的说明核对过再记。不出现表示没有装不了的，按空数组算。靠什么知道装不了见第 6 节 |
| `status` | 字符串 | 是 | `ok`、`error` | `量的` | 这次调用成功还是报错 |
| `code` | 字符串 | 否 | 错误码，写法见 ER 契约 5.2 | `量的` | 报的错误码；`status` 是 `ok`、或者报的错不带错误码时不出现 |

`renders[]`：一次 `render` 调用，参数都在 5.13 的值域里。故意把参数传出值域的调用不记在这里，记在 `badArgs[]`。

| 字段 | 类型 | 单位 | 必填 | 值域 | 来历 | 说明 |
|---|---|---|---|---|---|---|
| `shotFrame` | 整数 | 帧 | 是 | ≥ 0 | `请求` | 镜头局部帧号 |
| `want` | 数组 | 无 | 是 | `OutputName`，不重复 | `请求` | 要了什么 |
| `shutterAngleDeg` | 双精度 | 度 | 是 | `[0, 360]` | `请求` | 这次调用生效的快门角，测试工具照 5.9 的次序从自己传的参数算；0 表示没开运动模糊。每次都写，不靠缺省；时间核对记录里同名的字段意思相同 |
| `shutterSamples` | 整数 | 次 | 否 | ≥ 1 | `请求` | 这次调用生效的子帧采样数，测试工具照 5.9 的次序从自己传的参数算；没记就不出现 |
| `size` | 数组 | 像素 | 否 | `[宽, 高]`，正整数 | `请求` | 这次输出的宽和高：镜头输入的 `output.size` 乘生效的缩放。缩放是 1 时就是 `output.size`；缩放不是 1 时乘出来怎么取整还没定（见第 6 节），没定之前这种调用不记这个字段 |
| `unsupportedOpts` | 数组 | 无 | 否 | `samples`、`scale`，不重复 | `请求` | 这次传的 `RenderOpts` 里，被测帧源交不出的是哪几项；测试工具故意要一个交不出的值时填。都交得出写空数组，没核对过就不出现。靠什么知道交不出见第 6 节 |
| `unfitOutputs` | 数组 | 无 | 否 | 像素输出的名字，不重复 | `请求` | 这次的夹具场景里有对象放不进的输出，不限于 `want` 里的；场景是测试工具自己搭的。没有这种对象写空数组，没核对过就不出现。靠什么知道放不进见第 6 节 |
| `status` | 字符串 | 无 | 是 | `ok`、`error` | `量的` | 这次调用成功还是报错 |
| `code` | 字符串 | 无 | 否 | 错误码，写法见 ER 契约 5.2 | `量的` | 报的错误码；`status` 是 `ok`、或者报的错不带错误码时不出现 |
| `meta` | 布尔 | 无 | `status` 是 `ok` 时必填 | | `量的` | 交回的 `FrameResult` 里有没有 `meta` |
| `layers` | 数组 | 无 | `status` 是 `ok` 时必填 | 通道名，不重复 | `量的` | 交回的 `FrameResult.layers` 的键 |
| `layerRefs` | 数组 | 无 | 否 | 每项见下表 | — | 交回的层引用和测试工具对层文件的重算；没核对层文件就不出现 |
| `metaShutterAngleDeg` | 双精度 | 度 | 否 | `[0, 360]` | `自报` | 交回的元数据里的 `camera.shutterAngleDeg`；没交元数据或 `camera` 是 `null` 就不出现 |
| `colorTransfer` | 字符串 | 无 | 否 | `linear`、`encoded` | `量的` | 量出来的颜色层数值是线性编码，还是过了传递函数；量法见 5.2 |
| `colorRef` | 字符串 | 无 | 否 | `scene`、`display` | `自报` | 交回的元数据里的 `colorRef` |
| `shotColorRef` | 字符串 | 无 | 与 `colorRef` 同时出现 | `scene`、`display` | `请求` | 镜头输入的镜头条目里声明的 `colorRef` |

`layerRefs[]`：一个交回的层。

| 字段 | 类型 | 必填 | 值域 | 来历 | 说明 |
|---|---|---|---|---|---|
| `output` | 字符串 | 是 | 通道名 | `量的` | 哪一层：`FrameResult.layers` 里的键 |
| `shape` | 数组 | 是 | 3 个正整数 | `自报` | 这一层的层引用里写的 `shape` |
| `hash` | 字符串 | 是 | `sha256:` 加 64 位小写十六进制 | `自报` | 这一层的层引用里写的 `hash` |
| `fileHash` | 字符串 | 是 | `sha256:` 加 64 位小写十六进制 | `量的` | 测试工具读层文件、自己重算的内容哈希 |
| `fileBytes` | 整数 | 是 | ≥ 0 | `量的` | 测试工具读到的层文件字节数 |

`orderRuns[]`：把同一帧用不同方式各渲一次。

| 字段 | 类型 | 单位 | 必填 | 值域 | 来历 | 说明 |
|---|---|---|---|---|---|---|
| `shotFrame` | 整数 | 帧 | 是 | ≥ 0 | `请求` | 镜头局部帧号 |
| `mode` | 字符串 | 无 | 是 | `single`、`shuffled`、`sequential`、`repeat` | `请求` | 渲的方式，见 5.4 |
| `digest` | 字符串 | 无 | 是 | `sha256:` 加 64 位小写十六进制 | `量的` | 这次结果的哈希，测试工具自己算，不是状态摘要，见 5.4 |

`failures[]`：故意造出来或者碰上的一次渲染失败。

| 字段 | 类型 | 单位 | 必填 | 值域 | 来历 | 说明 |
|---|---|---|---|---|---|---|
| `cause` | 字符串 | 无 | 是 | `gpu-error`、`other` | `自报` | 失败的原因；`gpu-error` 是显卡错误。故意造的失败照测试工具自己造的填；碰上的失败是不是显卡错误只有帧源自己说得出，所以整栏按 `自报` 算。F6 不读它 |
| `exitCode` | 整数 | 无 | 否 | | `旁观` | 帧源进程的退出码；到观测结束还没退出就不出现 |
| `elapsedMs` | 双精度 | 毫秒 | 是 | ≥ 0 | `旁观` | 从失败发生到进程退出（或观测结束）过了多久 |
| `limitMs` | 双精度 | 毫秒 | 是 | > 0 | `请求` | 这次给的时限 |

`queries[]`：一次 `query` 调用，帧号在 5.13 的值域里，问的实体都是夹具场景里有的。故意把帧号传出值域的调用不记在这里，记在 `badArgs[]`。

| 字段 | 类型 | 单位 | 必填 | 值域 | 来历 | 说明 |
|---|---|---|---|---|---|---|
| `kind` | 字符串 | 无 | 是 | 同 `SceneQuery.kind` | `请求` | 问的哪种 |
| `status` | 字符串 | 无 | 是 | `ok`、`error` | `量的` | 这次调用成功还是报错 |
| `code` | 字符串 | 无 | 否 | 错误码，写法见 ER 契约 5.2 | `量的` | 报的错误码；`status` 是 `ok`、或者报的错不带错误码时不出现 |
| `total` | 整数 | 项 | `status` 是 `ok` 时必填 | ≥ 0 | `量的` | 截断之前一共有几项：测试工具照自己搭的夹具场景算，不取帧源报的数 |
| `returned` | 整数 | 项 | `status` 是 `ok` 时必填 | ≥ 0 | `量的` | 测试工具数出来的 `items` 的项数 |
| `truncated` | 整数 | 项 | 否 | ≥ 1 | `自报` | 结果里的 `truncated`；结果里没有就不出现 |

`badArgs[]`：故意把一个参数传出值域的一次调用，值域见 5.13。一项只有一个参数出值域：别的参数都在值域里，要的输出都声明过，也不踩 F5、F13、F18、F19。

| 字段 | 类型 | 必填 | 值域 | 来历 | 说明 |
|---|---|---|---|---|---|
| `call` | 字符串 | 是 | `render`、`query` | `请求` | 调的哪个函数。`query` 的项问的是能力声明的 `sceneQuery` 里列了的种类；帧源一种都不答时不造这种项 |
| `arg` | 字符串 | 是 | `call` 是 `render` 时：`f`、`want`、`opts.samples`、`opts.scale`、`opts.shutter.angleDeg`、`opts.shutter.samples`；是 `query` 时：`f` | `请求` | 传出值域的是哪个参数，名字照 5.13 的表 |
| `status` | 字符串 | 是 | `ok`、`error` | `量的` | 这次调用成功还是报错 |
| `code` | 字符串 | 否 | 错误码，写法见 ER 契约 5.2 | `量的` | 报的错误码；`status` 是 `ok`、或者报的错不带错误码时不出现 |

`metaEntities[]`：一帧元数据里的实体。同一帧可以出现不止一项，各项独立判。

| 字段 | 类型 | 必填 | 值域 | 来历 | 说明 |
|---|---|---|---|---|---|
| `shotFrame` | 整数 | 是 | ≥ 0 | `请求` | 镜头局部帧号 |
| `entities` | 数组 | 是 | 每项 `{ id, name, class }`，同 3.6 | `自报` | 这一帧元数据里列出的实体 |

`textReadbacks[]`：一个文字框的回读。这一段现在不判任何不变量，过线定下来之前只留观测。

| 字段 | 类型 | 必填 | 值域 | 来历 | 说明 |
|---|---|---|---|---|---|
| `shotFrame` | 整数 | 是 | ≥ 0 | `请求` | 镜头局部帧号 |
| `text` | 字符串 | 是 | 不空 | `自报` | 元数据的 `texts` 里这个文字框的文字 |
| `read` | 字符串 | 是 | | `量的` | 从成片画面上这个文字框的矩形里读回的文字；什么都没读到写空串 |

哪几条的查法靠的是 `自报` 的字段，见第 6 节「只对了帧源自己的说法」一行。

### 3.9 帧源登记表

顶层对象，`format` 是 `source/0.1`。表本身是数据，放在本目录的 `source.json`；它装的是 3.4 登记表里判「之内」用到的那几格，两份必须一致（F22）。任何一层都不得出现本节没列的键。

| 字段 | 类型 | 必填 | 值域 | 说明 |
|---|---|---|---|---|
| `format` | 字符串 | 是 | `source/0.1` | 格式标识 |
| `sources` | 对象 | 是 | `{ 帧源名: 登记条目 }` | 登记过的帧源；没登记的帧源不出现 |
| `ext` | 对象 | 否 | 键带点分前缀 | 私有数据 |

登记条目：

| 字段 | 类型 | 必填 | 值域 | 说明 |
|---|---|---|---|---|
| `hosts` | 数组 | 是 | 同 `Caps.hosts` | 这个帧源最多能配的宿主 |
| `modes` | 数组 | 是 | 同 `Caps.modes` | 最多能有的作者模式 |
| `sceneQuery` | 数组 | 是 | 同 `Caps.sceneQuery` | 最多能答的场景查询 |
| `outputs` | 对象 | 是 | `{ 输出名: 类型或 false }`；键是除 `meta` 之外的输出名，`color`、`depth`、`objectId`、`normal`、`motion` 五个必须出现；类型是 `f32`、`u32` | 每个输出的层文件类型；`false` 和不出现都表示这个帧源交不出 |
| `motionBlur` | 对象 | 是 | `{ mode }`，`mode` 同 `Caps.motionBlur.mode` | 运动模糊的做法 |
| `determinism` | 字符串 | 否 | 同 `Caps.determinism` | 哈希档还是容差档；还在 `待探针` 的帧源不出现 |

## 4. 不变量

| 编号 | 条文 | 怎么查 | 反例文件 |
|---|---|---|---|
| F1 | 能力声明的 `outputs.meta` 是 `true` 时，成功的 `render` 必须交回元数据；`want` 里有 `color` 时，`layers` 的键必须正好是 `want` 里声明过的像素输出，不得多交；`want` 里没有 `color` 时 `layers` 必须是空的。 | `renders` 里 `status` 是 `ok` 的每一项：`caps.outputs.meta` 是 `true` 时 `meta` 必须是 `true`；`want` 含 `color` 时，`layers` 作为集合必须等于 `want` 去掉 `meta` 之后里面声明过的输出；不含 `color` 时 `layers` 必须是空数组 | `F1-color-not-delivered.json` |
| F2 | 颜色层的数值必须是线性编码，元数据里的 `colorRef` 必须等于镜头声明的 `colorRef`。 | `renders` 每一项：`colorTransfer` 出现时必须是 `linear`；`colorRef` 出现时必须等于 `shotColorRef` | `F2-color-encoded.json`、`F2-color-ref-differs.json` |
| F3 | `want` 里有没声明过的输出时，`render` 必须报错，错误码必须是 `contract.unsupported-output`，不得静默降级。 | `renders` 里 `want` 含有没声明过的输出（定义见第 2 节：`caps.outputs` 里不出现，或取值是 `false`）的每一项：`status` 必须是 `error`，`code` 必须是 `contract.unsupported-output` | `F3-silent-downgrade.json`、`F3-undeclared-key-absent.json` |
| F4 | 任意一帧必须能单独渲，哈希档的帧源同一帧不论单独渲、乱序渲、顺序渲还是重复渲，结果必须逐位相同。 | 帧源名是 `ext.<名字>` 时整条不查。能力声明（单独的，或记录里的 `caps`）：`randomAccess` 必须是 `true`。记录里 `caps.determinism` 是 `hash-same-machine` 时，`orderRuns` 里 `shotFrame` 相同的各项 `digest` 必须逐位相同。容差档怎么比见 5.4 | `F4-order-dependent.json`、`F4-caps-not-random-access.json` |
| F5 | 开着原生运动模糊时要了 `motionBlur.conflicts` 里列的声明过的输出，`render` 必须报错，错误码必须是 `contract.output-conflict`，不得出帧。 | `caps.motionBlur.mode` 是 `native` 时，`renders` 里 `shutterAngleDeg` 大于 0、`want` 里的输出都声明过、并且 `want` 和 `caps.motionBlur.conflicts` 有交集的每一项：`status` 必须是 `error`，`code` 必须是 `contract.output-conflict`。`want` 里有没声明过的输出的项归 F3 判 | `F5-motion-with-native-blur.json` |
| F6 | 渲染失败时帧源进程必须在时限内以非零退出码结束。 | `failures` 每一项：`exitCode` 必须出现并且不等于 0，`elapsedMs` 必须不大于 `limitMs`。显卡错误算不算渲染失败这里不判，见 5.6 | `F6-gpu-error-exit-zero.json` |
| F7 | 已撤。原句是对用层一方的要求，帧源核对记录判不了，挪到 5.12 | | |
| F8 | `query` 问了能力声明的 `sceneQuery` 里没列的种类时必须报错，错误码必须是 `contract.unsupported-query`，不得给结果。 | `queries` 里 `kind` 不在 `caps.sceneQuery` 里的每一项：`status` 必须是 `error`，`code` 必须是 `contract.unsupported-query` | `F8-undeclared-query-answered.json` |
| F9 | `QueryResult.items` 不得超过 50 项，超过时必须只交回最严重的 50 项，并且在 `truncated` 里写被截掉的项数。 | `queries` 里 `status` 是 `ok` 的每一项：`returned` 必须等于 `total` 和 50 里小的那个；`total` 大于 50 时 `truncated` 必须等于 `total − 50`，否则 `truncated` 不得出现。留下的是不是最严重的 50 项现在不判，见 5.7 | `F9-query-not-truncated.json`、`F9-returned-too-few.json`、`F9-truncated-wrong-count.json`、`F9-truncated-without-cut.json` |
| F10 | `blender`、`three`、`core` 的合规档必须是 `full`，`legacy-page` 和 `ext.<名字>` 的合规档必须是 `limited`。 | 能力声明（单独的，或记录里的 `caps`）：`id` 是前三个之一时 `conformance` 必须是 `full`，否则必须是 `limited` | `F10-blender-declares-limited.json`、`F10-legacy-declares-full.json` |
| F11 | 实体清单里的编号和名字都不得重复，每帧元数据里列出的每个实体的编号、名字、类别必须和实体清单里的同一项逐项相同。 | `manifest.entities` 的 `id` 没有重复、`name` 没有重复；`metaEntities` 每一项的每个实体，在 `manifest.entities` 里必须有一项 `id`、`name`、`class` 三样都相同 | `F11-entity-id-changes.json`、`F11-duplicate-id.json`、`F11-duplicate-name.json` |
| F12 | 元数据的 `camera.shutterAngleDeg` 必须等于这次 `render` 生效的快门角。 | `renders` 里 `metaShutterAngleDeg` 出现的每一项：它必须等于 `shutterAngleDeg`，没有容差 | `F12-meta-shutter-differs.json` |
| F13 | 生效的快门角是 0 而生效的子帧采样数大于 1 时，`render` 必须报错，错误码必须是 `contract.shutter-conflict`。 | `renders` 里 `shutterAngleDeg` 等于 0、`shutterSamples` 大于 1、并且 `want` 里的输出都声明过的每一项：`status` 必须是 `error`，`code` 必须是 `contract.shutter-conflict`。`want` 里有没声明过的输出的项归 F3 判 | `F13-zero-angle-multi-sample.json` |
| F14 | `env.lock` 是 `null` 时，镜头条目没写 `seed`、或者镜头用了卡（叠加层展开出的卡也算）或资产，`open` 必须报错，错误码必须是 `env.lock-required`。 | `opens` 里 `hasLock` 是 `false`、`host` 在 `caps.hosts` 里、`mode` 在 `caps.modes` 里，并且 `hasSeed` 是 `false`、或 `usesCards` 是 `true`、或 `usesAssets` 是 `true` 的每一项：`status` 必须是 `error`，`code` 必须是 `env.lock-required`。`host` 或 `mode` 不在能力声明里的项归 F16 判 | `F14-no-seed-opened.json`、`F14-cards-opened.json`、`F14-assets-opened.json`、`F14-borrowed-mode-code.json`、`F14-overlays-only-input-code.json` |
| F15 | 帧源登记表里有的帧源，能力声明必须落在登记表之内。 | 能力声明（单独的，或记录里的 `caps`）的 `id` 是登记表 `source.json` 的 `sources` 里的键时，拿那一项照 3.4 的「之内」比：`hosts`、`modes`、`sceneQuery` 的每一项登记表里都有；`outputs` 里除 `meta` 之外取值不是 `false` 的每个键，登记表里必须有这个键、取值不是 `false`，并且 `type` 相等；`motionBlur.mode` 相等；登记表有 `determinism` 时 `determinism` 相等 | `F15-host-not-registered.json`、`F15-mode-not-registered.json`、`F15-query-not-registered.json`、`F15-output-type-differs.json`、`F15-output-registered-false.json`、`F15-output-not-registered.json`、`F15-blur-mode-differs.json`、`F15-determinism-differs.json` |
| F16 | 镜头出帧用的 `host` 不在能力声明的 `hosts` 里、或者出帧用的 `mode` 不在 `modes` 里时，`open` 必须报错，错误码必须是 `contract.unsupported-mode`。 | `opens` 里 `host` 不在 `caps.hosts` 里、或 `mode` 不在 `caps.modes` 里的每一项：`status` 必须是 `error`，`code` 必须是 `contract.unsupported-mode` | `F16-host-not-declared.json`、`F16-mode-not-declared.json`、`F16-borrowed-lock-code.json` |
| F17 | 层引用的 `shape` 前两个数必须等于这次输出的高和宽，`hash` 必须等于层文件内容的哈希。 | `renders` 里 `layerRefs` 的每一项：`hash` 必须和 `fileHash` 逐字符相同；这次调用记了 `size` 时，`shape` 的第一个数必须等于 `size` 的第二个数（高），`shape` 的第二个数必须等于 `size` 的第一个数（宽） | `F17-shape-not-output-size.json`、`F17-hash-not-of-file.json` |
| F18 | `RenderOpts` 给了帧源交不出的每像素采样数或缩放时，`render` 必须报错，错误码必须是 `contract.unsupported-option`，不得换一个值出帧。 | `renders` 里 `unsupportedOpts` 不空、并且 `want` 里的输出都声明过的每一项：`status` 必须是 `error`，`code` 必须是 `contract.unsupported-option`。`want` 里有没声明过的输出的项归 F3 判 | `F18-samples-substituted.json`、`F18-scale-substituted.json`、`F18-borrowed-argument-code.json` |
| F19 | 场景里有对象放不进这次要的某个输出时，`render` 必须报错，错误码必须是 `contract.unsupported-object`，不得照画，也不得漏画。 | `renders` 里 `unfitOutputs` 和 `want` 有交集、并且 `want` 里的输出都声明过的每一项：`status` 必须是 `error`，`code` 必须是 `contract.unsupported-object`。`want` 里有没声明过的输出的项归 F3 判 | `F19-unfit-object-rendered.json`、`F19-borrowed-output-code.json` |
| F20 | 镜头没有场景包时，实体清单里每个实体的编号必须等于它的名字在全部实体名里按字节序从小到大排的名次，名次从 1 起。 | 记录里 `scenePack` 是 `false` 并且 `manifest` 出现时：把 `manifest.entities` 按 `name` 的字节序（UTF-8 编码后逐字节比）从小到大排，排在第 k 个（k 从 1 起）的实体的 `id` 必须等于 k。`scenePack` 是 `true` 或不出现时不查 | `F20-ids-not-in-name-order.json`、`F20-ids-skip-a-number.json` |
| F21 | 层引用的 `shape` 的第三个数必须等于 `components` 的项数。 | 层引用（单独的内嵌值）：`shape` 的第三个数等于 `components` 数组的项数。核对记录的 `layerRefs[]` 不记 `components`，测试工具把交回的每个层引用单独拿来判这一条 | `F21-shape-components-differ.json` |
| F22 | 帧源登记表 `source.json` 必须正好是 3.4 登记表里判「之内」用到的那几格。 | 帧源登记表（`source/0.1`）：`sources` 的键正好是 `blender`、`three`、`core`；每个帧源的 `hosts`、`modes`、`sceneQuery` 各自作为集合和 3.4 的表相等；`outputs` 里取值不是 `false` 的键和它的类型和 3.4 的表逐个相等（`false` 和不出现算一样）；`motionBlur.mode` 相等；3.4 的表里 `determinism` 这一格还是 `待探针` 的帧源 `determinism` 不得出现，别的帧源必须相等 | `F22-extra-source.json`、`F22-missing-source.json`、`F22-host-differs.json`、`F22-output-type-differs.json`、`F22-blur-mode-differs.json`、`F22-determinism-filled.json` |
| F23 | `render`、`query` 的参数出了 5.13 的值域时，调用必须报错，错误码必须是 `usage.bad-argument`。 | `badArgs` 每一项：`status` 必须是 `error`，`code` 必须是 `usage.bad-argument` | `F23-bad-frame-rendered.json`、`F23-borrowed-option-code.json` |
| F24 | `query` 问了能力声明的 `sceneQuery` 里列了的种类时必须给结果，不得报错。 | `queries` 里 `kind` 在 `caps.sceneQuery` 里的每一项：`status` 必须是 `ok` | `F24-declared-query-refused.json`、`F24-declared-query-uncoded-error.json` |
| F25 | 镜头出帧用的 `host` 在能力声明的 `hosts` 里、出帧用的 `mode` 在 `modes` 里时，`open` 必须成功；F14、F26 管的情形除外。 | `opens` 里 `host` 在 `caps.hosts` 里、`mode` 在 `caps.modes` 里、不满足 F14 的条件（`hasLock` 是 `true`，或者 `hasSeed` 是 `true` 并且 `usesCards`、`usesAssets` 都是 `false`）、并且 `unfitInput` 不出现或是空数组的每一项：`status` 必须是 `ok` | `F25-declared-mode-open-fails.json` |
| F26 | 镜头输入里有帧源装不了的卡、资产或叠加层时，`open` 必须报错，错误码必须是 `contract.unsupported-input`，不得少装一样照常装载。 | `opens` 里 `unfitInput` 不空、`host` 在 `caps.hosts` 里、`mode` 在 `caps.modes` 里、并且不满足 F14 的条件的每一项：`status` 必须是 `error`，`code` 必须是 `contract.unsupported-input`。`host` 或 `mode` 不在能力声明里的项归 F16 判，满足 F14 条件的项归 F14 判 | `F26-overlays-ignored.json`、`F26-borrowed-argument-code.json` |
| F27 | 层文件的字节数必须等于层引用的 `shape` 各项之积乘以 4。 | `renders` 里 `layerRefs` 的每一项：`fileBytes` 必须等于 `shape` 三个数之积乘以 4（3.3 的层文件格式） | `F27-file-shorter-than-shape.json` |
| F28 | 帧源名是 `ext.<名字>` 的能力声明，`outputs.meta` 必须是 `false`。 | 能力声明（单独的，或记录里的 `caps`）：`id` 以 `ext.` 开头时，`outputs.meta` 必须是 `false` | `F28-ext-declares-meta.json` |
| F29 | 帧源名不是 `ext.<名字>` 的能力声明，`outputs.meta` 必须是 `true`。 | 能力声明（单独的，或记录里的 `caps`）：`id` 不以 `ext.` 开头时，`outputs.meta` 必须是 `true` | `F29-three-declares-no-meta.json` |

## 5. 口径

### 5.1 坐标

长度、坐标系、相机朝向照通用口径，本契约不另定。Blender 的场景是 Z 向上，Blender 帧源的适配层必须把 Blender 里的 `(x, y, z)` 换成 `(x, z, −y)` 再交出来；元数据、场景查询的结果、锚点都是换过之后的坐标。

### 5.2 颜色层

- 颜色层的数值一律是线性编码，原色是 Rec.709。
- 数值的含义看镜头的 `colorRef`：`scene` 是场景线性，还要过显示变换才是成片；`display` 是显示空间的画面取了线性编码，只差一步 sRGB 编码就是成片。
- `colorTransfer` 的量法：渲一张已知反射率的灰阶，各级读数和反射率成正比（在一致性套件的线性度门槛内）记 `linear`，否则记 `encoded`。

### 5.3 一致性套件

帧源注册和每次升级时跑。过线的数都等实测。

| 测什么 | 校准场景 | 比什么 | 过线 |
|---|---|---|---|
| 颜色线性度 | 色卡、灰阶 | 灰阶各级的读数和已知反射率的相对误差 | `待探针：灰阶各级的相对误差` |
| 深度口径 | 已知距离的平面、一米长的标尺 | 深度层读数和已知距离的相对误差，取中位 | `待探针：深度读数的相对误差中位` |
| 编号与元数据 | 三个互相遮挡的方块 | 元数据里的屏幕包围盒，和从编号层反算出的包围盒的交并比。编号层要在只渲这一个实体（别的实体藏起来）时取：元数据的包围盒是整个实体的投影，不看遮挡，合在一起渲时被挡住大半的实体只有 0.72 | 不低于 0.95。三渲帧源单独渲时三个方块是 0.978 到 0.998（探针数据表「可见比例的成本」一行，Mac 和 5090 读数相同）；最小出帧链路在没被挡的主物体上是 0.9628 到 0.9926（链路入口自己打印的读数，这台 Mac 上量的） |
| 法线空间 | 已知朝向的球 | 法线层读数和已知法线的夹角，取中位 | `待探针：法线夹角中位，单位度` |
| 相机约定 | 带刻度的 L 形标尺 | 锚点的屏幕位置和已知位置的距离 | `待探针：锚点屏幕位置误差，单位像素` |
| 文字框回读 | 带已知文字的画面 | 元数据的 `texts` 里每个文字框的文字，和从成片画面上那个矩形里读回的文字 | `待探针：文字框回读的过线` |
| 乱序 | 任意镜头 | 见 5.4 | 见 5.4 |
| 重复渲两遍 | 任意镜头 | 见 5.4 | 见 5.4 |

一致性套件必须把能力声明的 `sceneQuery` 里列的每一种查询各问至少一次，`modes` 里列的每一种作者模式各 `open` 至少一次，期望照能力声明算，不写死成某个帧源现在的样子。哪一种没有夹具，套件的报告里必须写明这一种没验，不得算过。这一句是对套件的要求，不立不变量；问到、装到的每一次由 F8、F24、F16、F25 判。

「用编号层核对元数据」只有这一种比法：屏幕包围盒的交并比。别处要做这种核对，都用它。

从编号层反算一个实体的包围盒时，这个实体占的像素 = 编号是它自己、或者是名字以它的名字加 `.` 开头的实体的像素。编号层的一个像素写的是叶子实体的编号：打到的那些实体里名字最长的那个。装配体自己的编号不会出现在编号层里，它占的像素由名字前缀推出。

### 5.4 乱序和重复

- `single`：新开一个会话，只渲这一帧。`shuffled`：把一批帧打乱次序渲。`sequential`：按帧号从小到大渲。`repeat`：同一个会话里把这一帧再渲一遍。
- `digest` 是颜色层文件内容的 SHA-256，层文件的格式见 3.3；只要元数据时，是去掉 `timing` 之后的元数据的 SHA-256。写法照通用口径：`sha256:` 加 64 位小写十六进制。元数据怎么序列化由做一致性测试的工具定，同一份记录里必须用同一种。
- 哈希档：同一帧的 `digest` 作为字符串完全相等，没有容差。哪个帧源是哪一档、出处是什么，以 3.4 登记表的 `determinism` 一行为准，本节不另列。
- 辅助层：不论哪一档，同一帧渲两遍的辅助层必须逐位相同（探针数据表「5090 读数」一节，5090；探针量过的辅助层是深度、编号两层，`normal`、`motion` 没量；同时量过的位置层不是输出通道契约（PS）的通道，也逐位相同）。
- 容差档的颜色层：`blender` 帧源用 CPU 渲时，同一帧渲两遍的颜色层必须逐位相同；用显卡渲时，两遍的颜色层逐通道比相对差，相对差 = |a − b| ÷ max(|a|, 1e-12)，不得超过 1e-5（比值，没有单位）。出处：探针数据表第 11 行和「5090 读数」一节，Mac 的 CPU、5090 的 CPU 和显卡；这个数的适用范围见第 6 节。
- 容差档另比两样，峰值信噪比，和 8 位下差 5 级以上的像素占比。门槛是 `待探针：容差档两次渲染的峰值信噪比下限` 和 `待探针：容差档 8 位下差 5 级以上的像素占比上限`。门槛定下来之前不比这两样，核对记录不收这两个量。
- 核对记录里没有辅助层的哈希、没有两遍的相对差、也没有这次用的是 CPU 还是显卡，所以辅助层和容差档的这几句现在是对帧源的要求，不由 F4 判：F4 对容差档只查 `randomAccess`。

### 5.5 实体名的通配

`of` 和 `against` 的每一项，要么是一个实体名，要么是「前缀加 `.*`」，例如 `kit.*`。`kit.*` 指名字以 `kit.` 开头的全部实体，不含 `kit` 自己。`*` 不得出现在别的位置。

### 5.6 失败和时限

- 渲染失败指 `render` 没能交出要的东西，原因包括显卡错误（设备丢失、显存不足、驱动重置）。
- 显卡错误之后帧源不得把一张不完整的画面当成功交出来。这一句和上一句里「显卡错误算渲染失败」是对帧源的要求；核对记录里没有「这次调用期间出没出显卡错误」的量，F6 现在不判它们，见第 6 节。
- 时限由调用方在起帧源进程时给，记在 `limitMs` 里。

### 5.7 「最严重」

超过 50 项时留哪 50 项，按各种查询自己的严重程度排。排法见第 6 节。核对记录只记 `total`、`returned`、`truncated` 三个数，看不出留的是哪 50 项；排法定下来之前，F9 里「只交回最严重的 50 项」这半句不判。

### 5.8 减免怎么套

判一个 `limited` 帧源时，先照 3.5 把它免掉的几条划掉，剩下的几条和 `full` 帧源用同样的查法。`legacy-page` 没有免本契约的任何一条不变量。

### 5.9 生效的快门

- 一次 `render` 生效的快门角和子帧采样数：`RenderOpts.shutter` 出现就用它的 `angleDeg` 和 `samples`；不出现就用镜头条目的 `shutter.angleDeg` 和 `shutter.samples`（见片子描述契约（D）3.3）。
- 镜头条目的 `shutter.samples` 也不出现时：生效的快门角是 0 就取 1；不是 0 就用能力声明的 `motionBlur.samples`（能力声明里没有这个字段的帧源取什么，见第 6 节）。帧源不得在出帧时另定一个数。有锁文件时，锁文件的 `shots.<id>.shutterSamples` 记的就是照镜头条目、能力声明这个次序算出的值；它只顶替镜头条目和能力声明这两处，`RenderOpts.shutter` 出现时仍用它的 `samples`。
- 核对记录里的 `shutterAngleDeg`、`shutterSamples` 记的是照上面的次序定下的值。
- 元数据的 `camera.shutterAngleDeg` 写的就是生效的快门角（F12）。生效的快门角是 0 而子帧采样数大于 1 是自相矛盾的请求（F13）。

### 5.10 一对里谁管哪件事

帧源是渲染器加宿主的一对。下表说一对里哪个角色管哪件事、由哪条条文约束；两个角色之间怎么接不立契约，各帧源写在自己的说明里。镜头契约（S）、每帧元数据契约（M）、时间键契约（T）里说的「宿主」就是这里的宿主。

| 事 | 归谁 | 哪条管 |
|---|---|---|
| 装载镜头，`build` 正好跑一次 | 宿主 | S2 |
| 推时钟：每个子帧采样取哪个时刻，把那一刻的状态写进场景 | 宿主；原生运动模糊时，快门窗口里的时刻由渲染器自己取 | T4、T5、T14 |
| 逐子帧累积，后期链跑几次 | 宿主 | T6、T7 |
| 算像素：颜色层和辅助层 | 渲染器 | F1、F2；辅助层取哪个样本归 T8 |
| 量元数据：相机、实体、灯、统计、计时 | 宿主 | M2 |
| 把各层落盘，交回层引用 | 宿主 | F1、F17 |

### 5.11 没有锁文件时

本机不起服务器出帧时，先由本机的锁生成器生成本机锁（锁文件契约（LK）5.8），带着它 `open`；帧源不看锁的 `issuer`，带正式锁和带本机锁走同一条路。`env.lock` 是 `null` 只用在完全没有锁的情形，比如一致性测试里不带卡和资产的镜头。

`env.lock` 是 `null` 时各值从哪来：

- 镜头种子必须写在镜头条目的 `seed` 里。
- 子帧采样数照 5.9 的次序取：这次调用的 `RenderOpts`，镜头条目，能力声明的默认值。
- 镜头用了卡或资产时，它们的版本和哈希只有锁文件里有，`open` 必须报错（F14）。用了卡：镜头条目的 `cards` 出现并且不空，或者镜头输入的 `overlays` 出现并且不空。叠加层由宿主展开成卡 `two-d.overlay` 的实例（片子描述契约（D）5.11），这张卡不是内建卡，版本和哈希也只在锁文件里（锁文件契约（LK）的 LK10）。用了资产：镜头条目的 `assets`、镜头输入的 `assets` 里有一个出现并且不空。

有锁文件时，种子取锁文件里记的值（锁文件契约（LK）3.2）；子帧采样数在这次调用的 `RenderOpts.shutter` 不出现时取锁文件里记的值，出现时照 5.9 用 `RenderOpts.shutter.samples`。锁里的子帧采样数就是镜头条目和能力声明照 5.9 算出的那个值。

一致性套件里必须至少有一次 `open` 带着锁文件，没有锁的这条路不得是唯一跑过的路。这一句是对套件的要求，不立不变量。

### 5.12 辅助层拿去做什么

辅助层和运动矢量层只能用于感知和画风处理，不得用于两个帧源的画面之间的合并。这是对用层一方的要求，不是对出层的帧源的要求，帧源核对记录不判；等合成那一步有了契约，由它的核对记录判。

### 5.13 参数的值域

`render`、`query` 的参数「出了值域」，指下表里的任意一种；表里没列的不算，F23 不管。

| 调用 | 参数 | 出值域是指 |
|---|---|---|
| `render`、`query` | `f` | 不是整数，是负数，或者不小于镜头条目的 `out` 减 `in`。这个界由测试工具从它自己备的镜头输入算，不读帧源报的 `manifest.frames` |
| `render` | `want` | 里面有重复的名字 |
| `render` | `opts.samples` | 出现了，却不是不小于 1 的整数 |
| `render` | `opts.scale` | 出现了，却不在 `(0, 1]` 里 |
| `render` | `opts.shutter.angleDeg` | 不在 `[0, 360]` 里 |
| `render` | `opts.shutter.samples` | 不是不小于 1 的整数 |

- 出值域的调用不得出帧、不得给结果；帧源不得把值改进值域里再照做。
- 下面三种不算出值域，各归各的条文：每像素采样数或缩放在值域里、帧源却交不出，归 F18；快门角是 0 而子帧采样数大于 1，两个值各自都在值域里，归 F13；`want` 里有没声明过的输出，归 F3。
- 核对记录的 `renders[]`、`queries[]` 只记参数都在值域里的调用；出值域的调用记在 `badArgs[]`，一项只造一个出值域的参数。

### 5.14 装不了的镜头输入

- 「帧源装不了」指这个帧源的实现还没接上镜头输入里的某一样，一共三样：`cards`，镜头条目的 `cards` 不空而它没接卡；`assets`，镜头条目的 `assets` 或镜头输入的 `assets` 不空而它没接资产；`overlays`，镜头输入的 `overlays` 不空而它展开不了叠加层。
- 这时 `open` 必须报 `contract.unsupported-input`（F26），不得少装一样照常装载。
- 这不是减免：本契约没有给任何帧源免掉这三样，能力声明里也没有声明「装不了」的字段。F26 只管还装不了的那段时间里怎么失败；帧源接上之后，这一条对它不再触发。
- 先后：`host` 或 `mode` 不在能力声明里时报 `contract.unsupported-mode`（F16）；没有锁文件、又满足 F14 的条件时报 `env.lock-required`（F14）；这两种都不是时才报 `contract.unsupported-input`。

### 5.15 预算、准入和原生库

- 帧源可以要求调用方声明预算。要不要、要哪几项、每一档的上限，写在帧源自己的说明里；能力声明和登记表里没有这个字段，见第 6 节。现在要求预算的只有 `core`：每帧三角形数 `maxTriangles`、每像素采样数 `spp`、墙钟毫秒 `maxWallMs` 三项。
- 准入在作业起帧源之前判。判不过的作业不得起帧源、不得出帧：
  - 没带预算，少一项、多一项，或者一项的值出了帧源说明里写的值域：报 `usage.budget-required`。
  - 预算的一项超过这一档的上限；镜头在这一档生效的每像素采样数超过声明的 `spp`；场景包在要渲的某一帧上画出来的三角形数超过声明的 `maxTriangles`：报 `contract.over-budget`。准入本身有时限，到了时限还没数完，也报这个码。
- 起帧源之后，从起帧源算起用完了声明的墙钟预算：帧源起的进程必须连同它们的子进程一起被杀掉，这次调用必须报错，错误码是 `timeout.budget`，不得把渲到一半的帧当成功交回（5.6）。这个码说的是预算用完了，不是片子描述有毛病。
- 帧源要加载锁文件里钉了 sha256 的本机动态库时，读到的库的 sha256 和钉住的不同，必须报错，错误码是 `env.lib-mismatch`，不得换一份库照常出帧。这里的锁文件是帧源钉库的那份文件，放在哪由帧源自己的说明写，不是锁文件契约（LK）的锁。
- 这一节是对帧源和调用它的作业的要求，没有立不变量：核对记录里没有预算、准入的结论、墙钟和库的哈希这几样量，见第 6 节。

## 6. 待定

| 项 | 现在怎么写 | 等什么 |
|---|---|---|
| `render(f, …)`、`query(f, …)` 的时间参数 | 照整数的镜头局部帧号写，子帧相位由帧源在内部按时间键契约取。一致性测试不需要单独的子帧：判逐子帧累积是不是在线性值上取平均，拿的是帧源交回的累积颜色层，和照校准场景的规格算出来的预言图比，量法见时间键契约（T）5.6 | 按倾向定，合作者不同意时再改 |
| 单独渲某个子帧的口子 | 不加 | 出现测试之外的消费者 |
| `core` 的 `hosts` 里的 `offscreen` | 照「离屏宿主是核心帧源的出片宿主」写 | 按倾向定，合作者不同意时再改 |
| `three` 的 `hosts`，以及 three 一侧用哪种着色语言 | three 帧源照旧配页面宿主，过渡期渲染器用 WebGL、着色语言用 GLSL。`hosts` 写 `page`：页面宿主的名字，片子描述和锁文件的例子里 three 镜头用的都是这个词；`headless-page` 是另一个宿主（核心帧源的后备宿主），不是它；本契约没有着色语言字段，`language` 说的是镜头代码的语言 | 按倾向定，合作者不同意时再改 |
| `three` 的 `determinism` | 已定：`hash-same-machine` | 探针数据表第 11 行和「5090 读数」一节，两台机器 |
| `core` 的 `determinism` | 留空 | `待探针：核心帧源同机渲两遍是否逐位相同` |
| 容差档颜色层的相对差上限 1e-5 | 实测最大相对差 1.7e-6 和 1.52e-6（两遍，探针数据表「5090 读数」一节），留了约 6 倍余量；只在六个校准场景、64 采样、不降噪下量过 | 场景变大、采样数改变、打开降噪之后重新量 |
| 辅助层逐位相同、`blender` 用 CPU 时颜色层逐位相同、容差档的相对差 | 5.4 写成对帧源的要求，F4 现在不判；能力声明里也没有「用 CPU 还是显卡」的字段，`blender` 的 `determinism` 仍写 `tolerance` | 一致性测试工具要记这几个量时，在核对记录里加字段 |
| 显卡错误必须算渲染失败、之后不得把不完整的画面当成功交出 | 5.6 写成对帧源的要求，F6 现在不判 | 帧源实现时在 `renders[]` 加记显卡错误的字段 |
| 一致性套件的五个门槛、容差档的两个门槛 | 留空 | 5.3、5.4 里的七个 `待探针` |
| 文字框回读的过线 | 留空；核对记录的 `textReadbacks` 只留观测，不判 | `待探针：文字框回读的过线` |
| 文字框回读比什么、记什么 | 【起草者补】比元数据里的文字和从画面矩形里读回的文字；记录里一个文字框一项 `{ shotFrame, text, read }` | 过线定下来时一起确认 |
| 例子 `caps-core.json` 里的 `version`、`determinism`、`channels` | 为了让例子成形填的示意值，不是结论；`hosts` 已经照上面按倾向定的写法 | 上面几行定了以后改例子 |
| 私有外部插件的帧源名 | 【起草者补】`ext.<名字>` | 集成负责人确认 |
| `language` 的写法 | 【起草者补】和镜头契约一致，写 `js`，不写全称 | 集成负责人确认 |
| `outputs` 各项的形状 | 【起草者补】`false`，或 `{ type, note? }`；颜色层另带 `transfer`、`primaries`。各层的数值定义不在这里写 | 输出通道契约（PS） |
| `outputs` 里的 `lightgroup:*` | 【起草者补】分灯组的名字跟着场景走，能力声明里写不出每一个，所以用这一个键表示「任何分灯组都交得出」 | 集成负责人确认 |
| `FrameResult.layers` 一层都没交时 | 【起草者补】必填，写空对象，不省掉这个字段 | 集成负责人确认 |
| `metaNull` | 【起草者补】每帧元数据契约的 M4 要求「交不出的字段在能力声明里说明」，加这个字段来放 | 集成负责人确认 |
| `granularity` 的值域 | 只有 `frame`；整段出片的私有外部插件写什么不定 | 集成负责人确认 |
| `draft.kind`、`draft.denoise`、`solvers` 的值域 | 只收现在三个帧源用到的词；`denoise` 不限词 | 新帧源或新求法登记时加 |
| 能力声明的 `outputs.meta` 是 `false` 时，成功的 `render` 交回了元数据 | 不定：F1 只管 `outputs.meta` 是 `true` 的一半，交回了算不算违约没有条文；3.5 只说 `ext.<名字>` 不交 `meta/0.1` | 集成负责人定要不要在 F1 加「不得交回」一支 |
| `want` 里没有 `color`、却有别的像素输出 | 照「只要元数据」写：只交元数据。这和 F3 的「不得静默降级」有张力 | 集成负责人定：照现在这样，还是判成非法请求 |
| 一次 `render` 同时踩中 F3 和 F5（或 F13） | 【起草者补】`want` 里有没声明过的输出时只判 F3，错误码是 `contract.unsupported-output`；F5、F13 只管 `want` 全都声明过的调用。不这样写，同一次调用会被要求报两个不同的码 | 集成负责人确认 |
| F6 的时限是多少、谁给 | 【起草者补】调用方给，记录里带 `limitMs`；数值不定 | 集成负责人确认 |
| `failures[].cause` 的值域 | 【起草者补】`gpu-error`、`other` | 集成负责人确认 |
| `SceneQuery.against` 不出现时 `intersect`、`contact` 和谁比 | 不定 | 谓词登记表契约（PR） |
| 通配的写法 | 【起草者补】只收「前缀加 `.*`」 | 集成负责人确认 |
| `QueryResult.items[]` 在五种查询下各自的 `value` 量什么、`unit` 写什么、`at` 有几个数 | 不定；例子只给了 `intersect` 的一种写法 | 谓词登记表契约（PR） |
| 「最严重的 50 项」按什么排 | 不定；定下来之前 F9 的这半句不判，见 5.7 | 谓词登记表契约（PR） |
| `legacy-page` 除了减免表之外还要过哪些 | 两种说法：一种是「表里没写的一条不免」，一种只点了颜色层、F3、F4、F6 四样。取严的：本契约的不变量都不免 | 集成负责人确认 |
| 私有外部插件交的「来源信息」 | 结构照每帧元数据契约（M）3.5 的 `source` 一段，见 3.5；一段成片交几个、从哪个接口交：不定 | 集成负责人确认 |
| 5.15 的预算、准入、墙钟预算和原生库校验 | 写成对帧源和作业的要求，没有立不变量。要求预算的帧源、预算项和各档上限只写在帧源自己的说明里，能力声明里没有字段可读 | 一致性测试工具要判这几样时，在核对记录里加字段；要让上限从能力声明里读到时，在 3.4 加可选字段 |
| 本机的锁生成器 | 写法已定（LK 契约 5.8），程序还没有：本机出帧先生成本机锁再 `open`。生成器做出来之前，最小出帧链路带锁的那一次用照本机锁写法手写的夹具锁 | 卡、显示变换查找表在本机能跑时做生成器；接口不动 |
| 能力声明按帧源一份，还是按（帧源，宿主）一份 | 现在按帧源一份 | `待探针：核心帧源在两个宿主上各自的确定性和草稿档读数` |
| `three` 的 `motionBlur.samples` | 已定：8。最小出帧链路量 T6 的读数（线性平均差 1.8e-6）就是 8 个子帧时量的；要更顺的拖影，镜头条目写 `shutter.samples`，不改默认值 | 已定 |
| `blender`、`core` 的 `final` | `待定：blender 终稿档每像素采样数`、`待定：core 终稿档每像素采样数` | 各自的实现 |
| `three` 的 `color`、`normal` 写 `f32` 的依据 | 已定：页面宿主的三种后端（Metal、Vulkan、软件渲染）在 32 位浮点渲染目标上都能出帧、带混合，读回的都是期望值取单精度，同一帧渲两遍逐位相同（探针数据表「5090 读数」一节后面的表）；链路已经改用这种目标 | 已定 |
| 能力声明没有 `motionBlur.samples` 的帧源（原生运动模糊）默认的子帧采样数 | 【起草者补】`samples` 只在 `mode` 是 `accumulate` 时必填；原生运动模糊的帧源取什么：`待定：原生运动模糊的帧源默认的子帧采样数` | `blender`、`core` 的实现 |
| 生效的快门角是 0、哪里都没写子帧采样数时取几 | 【起草者补】取 1，不用能力声明的默认值：不这样写，默认值大于 1 的帧源每次不开快门的调用都会撞上 F13 | 集成负责人确认 |
| 带覆盖率的 `objectId` 怎么装进层文件 | `待定：带覆盖率的 objectId 怎么装进文件` | 参考包契约（RP）和核心帧源开始出层 |
| 缩放不是 1 时输出的宽高怎么取整 | `待定：缩放后的输出尺寸怎么取整`；没定之前核对记录不记这种调用的 `size`，F17 的宽高一半对它们不判 | 集成负责人确认 |
| `unsupportedOpts`、`unfitOutputs`、`unfitInput` 靠什么填 | 能力声明里没有「交得出哪些采样数和缩放」「哪类对象进不了哪个输出」「卡、资产、叠加层接没接」的字段；现在由测试工具照被测帧源自己的说明填 | 要机器能读时，在能力声明里加字段 |
| 一次 `open` 同时踩中 F14、F16、F26 里不止一条 | 【起草者补】`host` 或 `mode` 不在能力声明里时只判 F16，错误码是 `contract.unsupported-mode`；F14 只管 `host`、`mode` 都在能力声明里的调用；F26 排在最后，只管前两条都不踩的调用，见 5.14 | 集成负责人确认 |
| 一次 `render` 同时踩中 F5、F13、F18、F19、F23 里不止一条，或者参数出值域的同时 `want` 里还有没声明过的输出 | 不定：F5、F13、F18、F19 都只管 `want` 全都声明过的调用，彼此之间报哪个码没定；参数出值域和别的几条谁先谁后也没定。一致性夹具一次只造一种 | 集成负责人确认 |
| 只对了帧源自己的说法、不算对真值的验证的条文 | F11 拿帧源的两处输出（实体清单和元数据）互相对，F2 的后半和 F12 拿元数据里的字段对请求：查的都是「抄得对不对」。元数据里的编号和像素对不对得上，由 5.3 的「编号与元数据」一项验，过线是 0.95。F4 的「任意一帧必须能单独渲」只读了声明 `randomAccess`，行为由 `orderRuns` 里 `single` 那一项渲得出来间接覆盖。F20 只查实体清单自己的编号排法，清单是帧源交的。F17 的宽高一半拿层引用里自己写的 `shape` 对请求的 `size`；层文件真有多大由 F27 拿量到的字节数判，所以帧源把文件写成别的尺寸、`shape` 照请求填时 F27 会红；高和宽一起写错、乘积不变的情形仍判不出 | 有了带文件头、能独立读出高和宽的层文件格式再说 |
| 例子里 `blender` 和 `core` 的 `final` | 为了让例子成形填的示意值（64 次、缩放 1），不是结论；`three` 的 `motionBlur.samples` 是 8，已定，见上面那一行 | 上面几行定了以后改例子 |
| 帧源登记表的格式标识 | 已定：`source/0.1`，和别的登记表一样用目录名；收 `ext` | 已经登记在契约写法约定的格式标识总表 |
| 镜头输入的 `events` 是整份事件表，还是只有这个镜头的条目 | 【起草者补】整份事件表（`events/0.1` 的对象），原样，不裁：不用另定裁法 | 集成负责人确认 |
| 镜头输入的 `overlays` 条目里的时刻算式由谁求值 | 已定：照片子描述契约（D）5.3、5.11：条目原样传，算式由帧源里的宿主查镜头输入的 `events`、再加减偏移；对不对由 T9 判 | 已定 |
| 画风令牌怎么进镜头输入 | 已定：镜头输入加可选的 `tokens`，是片子描述的 `style.tokens` 原样（3.2）；和全片的 `assets`、事件表一样由上层放进去 | 已定 |
| 镜头输入的后四个字段和片子描述对不对得上 | 现在没人判：镜头输入由上层算，帧源核对记录里没有片子描述 | 上层有了自己的核对记录 |
| 没有锁文件时全片的资产 | 【起草者补】镜头输入的 `assets` 出现并且不空，和镜头条目的 `assets` 一样算「用了资产」（5.11、`opens[].usesAssets`）：全片资产的版本和哈希也只有锁文件里有。代价：带全片资产的片子没有锁时一个镜头都打不开 | 集成负责人确认 |
| 镜头由场景包描述时实体清单的编号 | 以场景包实例表为准（3.6）。帧源核对记录里没有实例表，这一半 F20 不查。实例表只列叶子实体，装配体的编号从哪来：`待定：场景包镜头里装配体的编号` | 场景包契约（SP）的核对记录；集成负责人定装配体 |
| 实体的类别 `class` 从哪来；镜头对象里没列出的名字前缀算不算实体；片子描述 `roles` 点名的名字不在实体清单里怎么办 | 三样都不定。`class` 现在只要求不空、和元数据里的相同（F11） | 集成负责人定 |
| `scenePack` 靠什么填 | 夹具镜头是测试工具自己备的，有没有场景包它自己知道。片子描述里怎么写一个镜头用了场景包，本契约不管 | 场景包接进片子描述时 |
| 层引用现在没人判的几样 | `renders[].layerRefs[].output` 在不在 `layers` 里；`layers` 有层而 `layerRefs` 是空数组；`components` 的名字和次序对不对得上输出通道契约（PS）3.1。都没有不变量管。层文件的字节数归 F27 | 一致性测试工具要判时，在 `layerRefs[]` 里加字段 |
| 「编号与元数据」的比法 | 交并比对大物体的尺寸误差不灵敏：大的实体四边各外扩 1 像素仍过 0.95。另外，最小出帧链路没有单独渲，用的是合渲的编号层，前提是主物体不被别的实体挡住，这个前提没人判 | 要抓大物体的尺寸误差时，另加「四条边各差不超过多少像素」的比法；链路接上单独渲时去掉这个前提 |
| 层文件交回前的转写 | 3.3 的层文件没有文件头、只有数。渲染器内部出的文件（例如 Blender 的 EXR）要由宿主转成这种格式再交，不然 F27 每帧都红。这一步要花多少时间：`待探针：Blender 转写层文件的耗时` | `blender` 帧源实现时量 |
| 3.4 的登记表和 `source.json` 怎么保持一致 | F22 的判定函数里抄了一份 3.4 的那几格，拿它比 `source.json`。改登记表时三处一起改：3.4 的表、`source.json`、本目录 `check.mjs` 里抄的那一份 | 已定 |
| 装不了卡、资产、叠加层时报什么 | 已定：三样共用一个码 `contract.unsupported-input`，立 F26，记录里加 `opens[].unfitInput`；写成过渡的失败方式，不是减免，见 5.14。不得少装一样照常出帧：那样上层看到的是一张缺东西却「成功」的帧，换不了帧源，也查不出原因 | 已定 |
| 实体清单的 `frames` 等不等于镜头条目的 `out` 减 `in` | 3.6 写成对帧源的要求，没有立不变量：核对记录里没有镜头条目的 `in`、`out`。F23 的帧号界不读 `manifest.frames`（5.13），帧源把它报错了不影响 F23 | 一致性测试工具要判时，在核对记录里加一个 `请求` 的镜头帧数字段 |
| 报的错不带错误码 | 记录里 `status` 是 `error`、`code` 不出现。条文点了码的情形（F3、F5、F8、F13、F14、F16、F18、F19、F23、F26），不带码就是码不对；条文要求成功的情形（F24、F25），不带码也是报错。别的情形下不带码的错本身算不算违约，本契约没有立条文 | 集成负责人定要不要立「帧源报的错必须带登记过的错误码」 |
| F23 没管到的参数 | 5.13 的表只列了 `render` 的参数和两个调用的帧号。`SceneQuery` 的字段出值域（`of` 是空数组、`tol` 是负数）、问的实体场景里没有、`open` 收到的镜头不是这个帧源的、`env` 不合 3.2、锁文件里缺这个镜头的值，这几种报什么：不定，一致性夹具现在不造 | 集成负责人确认 |
| F25 的「必须成功」管到哪 | 只管测试工具自己备的、结构合乎 3.2 的镜头输入和 `env`。入口文件自己出错这类失败不在夹具里，本契约不管它报什么 | 集成负责人确认 |
| 资产引用怎么取成内容 | 不定：镜头输入只带资产引用，锁文件只带哈希，`env` 只有 3.2 的四个字段，那一对凭什么把资产引用取成内容（`env` 加字段，还是由锁或资产库给地址）现在没有通道 | 第一个接资产的帧源开工时定；定的时候改 3.2 的 `env` 表和 `types.d.ts` 的 `Env` |
| 声明过的查询和作者模式有没有都验到 | 5.3 写成对套件的要求，没有立成不变量：一份记录只说一个镜头，看不出整套夹具漏了哪一种 | 套件有了自己的汇总记录 |
| 打了标签的契约版本行还带 `-draft` | 标签 `contracts-v0.1` 打过以后，各份契约的版本行仍写 `x.y.z-draft`，和写法约定第 2 节「冻结时去掉 `-draft`」对不上；本契约这一次照第 6 节升次版本，后缀照旧带着，没有改别的契约 | 集成负责人确认：各份契约的后缀什么时候、怎么一起去掉（冻结就是打 `contracts-v0.1` 这个标签，写法约定第 6 节已写明） |

## 7. 变更记录

| 日期 | 改了哪条 | 为什么 |
|---|---|---|
| 2026-11-18 | 全部 | 首稿 |
| 2026-11-18 | 第 2 节、3.1 到 3.5、3.8、F1、F4、F5、F8、新加 F12、F13、5.3、5.4、5.8、新加 5.9、第 6 节 | 照红队和跨契约一致性复核的处理结果改 |
| 2026-11-18 | 3.6 的 `orderRuns[].digest` 说明、第 6 节 | 修订后的对齐收尾 |
| 2026-11-19 | 3.1、3.4 的登记表、3.5、F3、F4、F6、F9、5.4、5.6、5.7、第 6 节 | 照判定函数落地时发现的问题的处理结果改：F3、F4 的查法写全，F6、F9 判不了的半句写明不判，补反例；回填 three 的确定性和容差档的相对差；两个宿主的取值按倾向定 |
| 2026-11-19 | 第 1、2 节，3.2 到 3.4、3.8，新加 3.9，F7 撤，新加 F14 到 F19，5.4、5.8、5.9，新加 5.10 到 5.12，第 6 节 | 第一条照契约出帧的最小链路暴露的问题照处理结果改：帧源重新定义成渲染器加宿主的一对；`open` 改收镜头输入，`env.lock` 可以是 `null`，加 `filmDir`；层引用和层文件的格式定下来；登记表写明是上限并另存成数据；`type` 去掉 `half`；能力声明加 `final` 和默认的子帧采样数；核对记录按镜头分、每个字段标来历、拿掉 `auxUses`。第 6 节「时间参数」一行和时间键契约 5.5 说的现在是同一件事：快门窗口里的时刻由帧源里面的宿主取 |
| 2026-11-19 | 3.2、3.3 的 `shape`、3.4 的 `hosts`、3.6、3.8、3.9，F16 的措辞，新加 F20 到 F22，5.10、5.11，第 6 节 | 契约之间接不上的地方收尾：镜头条目原样传、不再把 `renderer` 那一套换到顶层，镜头输入加 `assets`、`events`、`overlays`；实体编号从哪来定在 3.6，编号 0 的说法和输出通道契约统一；来历的口径统一成相对测试工具说，`failures[].cause` 改标 `自报`；层引用的分量数、登记表和 3.4 的表各立一条条文；职责表补 T14；「不需要单独的子帧」那一句照时间键契约现在的量法改写 |
| 2026-11-19 | 第 2 节的术语引用；3.3 层引用的 `sha256` 改名 `hash`，3.8 的 `layerRefs[].sha256`、`fileSha256` 跟着改名 `hash`、`fileHash`，F17 的措辞跟着改；3.8 三处 `code` 的值域；3.4 登记表 `three` 的 `color`、`normal` 两格；F14、F16、F18 各补一个反例；第 6 节改四行。不变量的判法没动 | 和别的契约对齐：字段名带算法名的哈希在锁文件、信封、场景包里都不带前缀，层引用的值带前缀，所以改用不带算法名的字段名；错误码的写法只在错误码表契约定，核对记录的结构定义改成引用它；「入口文件模式」镜头契约里没有这个词；32 位浮点渲染目标的探针过了，回填；叠加层条目里的时刻算式片子描述契约已经有规则，改成引用；F17 的宽高一半只对了自报，登记；三条「错误码必须是」的条文原来没有「报了错但码不对」的反例 |
| 2026-11-19 | 3.8 加 `opens[].unfitInput` 和 `badArgs[]`，四处 `code` 从「报错时必填」改成可选（报的错不带错误码时不出现），`opens[]`、`renders[]`、`queries[]` 各补一句记什么；新加 F23 到 F26、5.13、5.14；5.3 加一句对套件的要求；第 6 节改三行、加五行；F14 的判法没动，判定函数里它的条件抽成了和 F25、F26 共用的一个函数 | 声明了答不出的场景查询、声明了装不了的作者模式，原来没有条文管，只有没声明的有（F8、F16）：补上「声明了就得做到」的两条。参数出值域报 `usage.bad-argument` 原来没有条文点名，立成 F23。帧源装不了镜头输入里的卡、资产、叠加层时原来报的错不带码，立 F26 配一个新码。报错不带码的调用原来记不进记录，测试工具只能中断 |
| 2026-11-19 | 3.2 `overlays` | 写明保持片子描述里的书写顺序，CR15 靠它 |
| 2026-11-19 | 5.11「用了卡」、3.8 `opens[].usesCards` 的说明、F14 的条文，F14 补一个只带叠加层的反例，正例 `check-no-lock.json` 和 F26 的反例跟着改；3.6 `frames` 的说明、5.13 `f` 一行；第 6 节「装不了卡、资产、叠加层时报什么」改成已定，加「实体清单的 `frames`」一行。判定函数没动 | 叠加层展开成的卡 `two-d.overlay` 不是内建卡，版本和哈希只在锁文件里，原来「用了卡」只数镜头条目的 `cards`，没有锁、只带叠加层的镜头照 F25 必须装载成功；实体清单的帧数原来没写算法，F23 的帧号界读的是帧源自报的数，报大了判不出；装不了镜头输入时报的码已经确认 |
| 2026-11-19 | 第 6 节「`f32` 的依据」一行 | Vulkan 和软件渲染两种后端也量过了，读数记进了探针数据表，改成已定 |
| 2026-11-19 | 5.11 开头一段 | 本机出帧改成先生成本机锁再带着它 `open`，`null` 只留给完全没有锁的情形；F14 的条文和判法没动 |
| 2026-11-19 | 3.2 加 `tokens`；3.4 登记表 `three` 的 `motionBlur.samples` 定成 8；3.8 `renders[].shutterAngleDeg` 改必填、`layerRefs[]` 加 `fileBytes`；新立 F27；5.3「编号与元数据」一行定比法和过线；第 6 节改三行 | 几项待定定下来：画风令牌进镜头输入；three 默认 8 个子帧；快门角在两份核对记录里同义、不靠缺省；层文件字节数有人判；交并比单独渲时不低于 0.95 |
| 2026-11-19 | F2、F10、F11 各补反例；5.4 拿掉和 3.4 登记表重复的「`three` 是哈希档」一句；第 6 节加「`outputs.meta` 是 `false` 时交回了元数据」一行。条文和判定函数没动 | F2 的后半、F10 的 `limited` 一支、F11 的编号重复和名字重复原来没有单独的反例；同一件事存两处，改一处容易漏另一处；F1 没管 `outputs.meta` 是 `false` 的一半，登记 |
| 2026-11-19 | 新立 F28；3.4 `outputs.meta` 一行的值域、`motionBlur.auxAt` 一行的说明；第 2 节「运动矢量层」；5.4「辅助层」一句；F5 的反例原来用的是 `outputs.meta` 为 `true` 的 `ext.demo`，改成 `false` | `ext.<名字>` 不交每帧元数据原来只写在 3.5 的减免表里，没有条文判，每帧元数据契约要靠它；辅助层原来写死了四个名字，输出通道契约 3.1 加减 `sub0` 通道时会对不上，改成引用；探针量的位置层不是输出通道，原来被算进了辅助层 |
| 2026-11-19 | 5.9 第二条、5.11 末段；3.4 登记表 `three` 的 `outputs.color.type` 一格；第 6 节改「例子里的示意值」一行、加「资产引用怎么取成内容」一行。判定函数没动 | 有锁时子帧采样数听谁的两处说法相反，改成和 5.9 一致：`RenderOpts.shutter` 出现就用它的，锁里的值只顶替镜头条目和能力声明；32 位浮点目标三种后端都量过，登记表那一格还写着只量过一种；three 默认 8 个子帧已定，同一节另一行还说是示意值；资产内容进那一对没有通道，原来没登记 |
| 2026-11-19 | 新立 F29；3.4 `outputs.meta` 一行的值域写明对应的条文 | 3.4 说除 `ext.<名字>` 外 `outputs.meta` 是 `true`，结构定义只写了布尔、F28 只判 `ext.<名字>` 一半：`blender`、`three`、`core`、`legacy-page` 写 `false` 也全部合法，这一对就躲开了 F1 的元数据一半和每帧元数据契约的整份核对记录；两个校验器会判得不一样 |
| 2026-11-20 | 第 6 节「1e-5」一行的出处 | 显卡相对差重量了一遍（1.52e-6），读数记进探针数据表 |
| 2026-11-27 | 第 1 节加一条，新加 5.15，第 6 节加一行 | 核心帧源的预算准入、墙钟预算和原生库校验要报的四个码登记进错误码表（ER 5.3），要有条文点名它们。只加了一节口径和对要求预算的帧源的要求，没加字段，已有的条文、结构定义和判定函数都没动；版本见下一行 |
| 2026-11-27 | 版本行 0.1.0-draft 改成 0.2.0-draft；第 6 节加「打了标签的契约版本行还带 `-draft`」一行 | 上一行新立的 5.15 是冻结以后的修改，又不是加可选字段：照写法约定第 6 节的字面，算破坏性修改，要升次版本。上一行原来写的「不升次版本」引错了第 6 节，改掉。变更说明见下 |

### 0.2.0-draft 的变更说明

- 改了什么：第 1 节加一条范围；新加 5.15「预算、准入和原生库」；第 6 节加两行。3.x 的结构、能力声明 `caps/0.1`、帧源登记表 `source/0.1`、核对记录 `source-check/0.1` 的结构定义和格式标识、已有的不变量和判定函数都没动。
- 为什么是破坏性修改：写法约定第 6 节冻结以后只把「加可选字段」算作不破坏。5.15 给帧源和调用它的作业加了新的「必须」「不得」：要求预算的帧源判不过准入时不得起帧源，报 `usage.budget-required` 或 `contract.over-budget`；墙钟预算用完时必须连子进程一起杀掉、报 `timeout.budget`；钉了 sha256 的本机动态库对不上时必须报 `env.lib-mismatch`，不得换一份库出帧。原来合规的帧源和作业，照这几句可能不再合规。
- 依赖方怎么迁移：
  - 不要求预算、不钉本机动态库的帧源不用改。
  - 要求预算的帧源：在自己的说明里写明要哪几项、每一档的上限；准入、超时照 5.15 报码。
  - 钉了本机动态库的帧源：sha256 对不上这一种报 `env.lib-mismatch`（在途实现原来报 `env.missing-tool`）；找不到库、没有这个平台的库仍报 `env.missing-tool`。
  - 提交作业的调用方：处理这四个码；对依赖 main 的一方它们是新码，对在途实现是换掉了原来借的近义码（见错误码表契约第 7 节 0.2.0-draft 的变更说明）。
  - 读能力声明、登记表和核对记录的代码不用改：格式标识和结构定义都没变，已有的核对记录照旧合规。
