# 帧源接口

版本：0.1.0-draft

## 1. 范围

管：

- 帧源名的值域。
- 帧源对外的接口：`caps`、`open`，会话的 `manifest`、`render`、`query`、`close`。
- 能力声明 `Caps` 的字段，合规档 `conformance`，档是 `limited` 时免哪几条。
- 一次 `render` 能要哪些输出、必须交回什么。
- 场景查询 `SceneQuery` 和它的结果 `QueryResult`。
- 帧源一致性套件测哪几样。
- 判定以上各条用的「帧源核对记录」。

不管：

- 每帧元数据里面的字段：每帧元数据契约（M）。
- 时间键、快门窗口、子帧累积、辅助层取哪个时刻：时间键契约（T）。
- 镜头入口 `build`、`ctx`、镜头对象：镜头契约（S）。
- 通道登记表，以及深度、物体编号、法线、运动矢量各层的数值定义：输出通道契约（PS）。
- `open` 收到的镜头条目和锁文件里面的结构：片子描述契约（D）、锁文件契约（LK）。
- 错误怎么包装、错误码的全表：信封契约（EN）、错误码表契约（ER）。
- 场景包的格式：场景包契约（SP）。
- 各种查询的结果拿去判什么：谓词登记表契约（PR）。

## 2. 术语

帧、镜头、镜头局部帧号、子帧相位、种子、快门角、子帧采样、逐子帧累积、辅助层、场景参考镜头、显示参考镜头、核对记录：见时间键契约（T）第 2 节。镜头代码、实体、实体名、锚点、入口文件模式、「卡加数据」模式：见镜头契约（S）第 2 节。

| 词 | 含义 |
|---|---|
| 帧源 | 按镜头局部帧号交出一帧的颜色层、辅助层和元数据的渲染后端，对外只有 3.2 的接口。 |
| 帧源名 | 帧源的标识，值域见 3.1。 |
| 宿主 | 和帧源并列的一层程序，不在帧源里面：它装载镜头、驱动逐帧求值、调帧源出帧。一个帧源可以由多个宿主驱动，列在能力声明的 `hosts` 里。 |
| 能力声明 | 帧源说自己能交什么、怎么交的一个数据对象，`caps()` 的返回值。 |
| 会话 | 对一个镜头 `open` 之后得到的对象，到 `close` 为止。 |
| 输出 | 一次 `render` 能要的东西，名字在 `OutputName` 的值域里，见 3.3。 |
| 像素输出 | 除 `meta` 之外的输出，名字都是输出通道契约（PS）3.1 的通道名。 |
| 颜色层 | 名叫 `color` 的输出。 |
| 运动矢量层 | 名叫 `motion` 的输出，四个辅助层之一。 |
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
| 一致性套件 | 帧源注册和每次升级时跑的一组校准测试，见 5.3。 |
| 帧源核对记录 | 一致性测试把对一个帧源的观测写下来的数据对象，只用来判定不变量。 |

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
| `open(shot, env)` | `shot`：片子描述里的一个镜头条目；`env`：见下表 | `Session` | 装载这个镜头。镜头条目带 `renderer` 对象时（见片子描述契约（D）3.3），出帧者那一套已经由宿主换到顶层，帧源收到的顶层 `source` 就是它自己 |
| `session.manifest()` | 无 | `Manifest`，见 3.6 | 渲染之前拿实体清单 |
| `session.render(f, opts, want)` | `f`：镜头局部帧号，整数帧；`opts`：`RenderOpts`；`want`：`OutputName` 的数组 | `FrameResult` | 渲一帧，见 3.3 |
| `session.query(f, q)` | `f`：镜头局部帧号，整数帧；`q`：`SceneQuery`，见 3.7 | `QueryResult` | 问场景，不出像素 |
| `session.close()` | 无 | 无 | 释放会话 |

除 `caps` 和 `manifest` 之外都是异步的。签名的写法见 `types.d.ts`。

`env`：

| 字段 | 类型 | 单位 | 必填 | 值域 | 说明 |
|---|---|---|---|---|---|
| `lock` | 对象 | 无 | 是 | 见锁文件契约（LK） | 这部片子的锁文件 |
| `tier` | 字符串 | 无 | 是 | `draft`、`final` | 档位 |
| `workspace` | 字符串 | 无 | 是 | 不空 | 这次出片的工作目录 |

### 3.3 `RenderOpts`、`OutputName`、`FrameResult`

`RenderOpts`，三个字段都可以不出现。`samples`、`scale` 不出现时用能力声明和档位定下的值；`shutter` 不出现时用镜头条目的快门，见 5.9：

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
| `layers` | 对象 | 是 | 像素输出。键是通道名，值是对落盘文件的引用；交了哪一层就有哪个键，一层都没交时是空对象 |

`want` 里没有 `color` 的 `render` 叫「只要元数据」：不出像素，只交回元数据。这时元数据里哪些字段是 `null`，由每帧元数据契约（M）管。

### 3.4 能力声明 `Caps`

顶层对象，`format` 是 `caps/0.1`。

| 字段 | 类型 | 单位 | 必填 | 值域 | 说明 |
|---|---|---|---|---|---|
| `format` | 字符串 | 无 | 是 | `caps/0.1` | 格式标识 |
| `id` | 字符串 | 无 | 是 | 帧源名，见 3.1 | 哪个帧源 |
| `version` | 字符串 | 无 | 是 | 不空 | 帧源的版本 |
| `language` | 字符串 | 无 | 是 | `python`、`js`、`wgsl` | 这个帧源里的代码用的语言；`python`、`js` 和镜头契约（S）的语言是同一组词 |
| `hosts` | 数组 | 无 | 是 | 至少 1 项，字符串 | 哪些宿主能驱动这个帧源 |
| `conformance` | 字符串 | 无 | 是 | `full`、`limited` | 合规档，见 3.5 |
| `outputs` | 对象 | 无 | 是 | `color`、`meta`、`depth`、`objectId`、`normal`、`motion` 六个键必须出现；别的键只能是 PS 3.1 的固定通道名或 `lightgroup:*` | 每个输出能不能交，见下表 |
| `sceneQuery` | 数组 | 无 | 是 | `bbox3d`、`anchor`、`intersect`、`contact`、`belowGround`，不重复 | 能答哪几种场景查询；一种都不能答写空数组 |
| `motionBlur` | 对象 | 无 | 是 | | 运动模糊怎么做，见下表 |
| `determinism` | 字符串 | 无 | 是 | `hash-same-machine`、`tolerance` | 哈希档还是容差档 |
| `draft` | 对象 | 无 | 是 | | 草稿档怎么出，见下表 |
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
| `meta` | 布尔 | `true`；私有外部插件可以是 `false` | 交不交每帧元数据 |
| `depth`、`objectId`、`normal`、`motion` | `false` 或对象 | `false`，或 `{ type, note? }` | `false` 表示交不出 |
| PS 3.1 里别的固定通道名 | `false` 或对象 | `false`，或 `{ type, note? }` | 可以不出现；不出现和 `false` 一样，表示交不出 |
| `lightgroup:*` | `false` 或对象 | `false`，或 `{ type, note? }` | 可以不出现；不出现和 `false` 一样。取值不是 `false` 表示任何一个 `lightgroup:<名>` 都交得出。具体的 `lightgroup:<名>` 不得作键 |

`type` 是每个通道的数值类型，值域 `half`、`f32`、`u32`。`note` 是给人看的补充说明，不空的字符串，机器不读。

`motionBlur`：

| 字段 | 类型 | 必填 | 值域 | 说明 |
|---|---|---|---|---|
| `mode` | 字符串 | 是 | `native`、`accumulate` | 原生运动模糊，还是逐子帧累积 |
| `auxAt` | 字符串 | 是 | `sub0` | 四个辅助层（`depth`、`objectId`、`normal`、`motion`）取哪个样本。只有一种：时刻是这一帧的 `sub = 0`，镜头孔径按 0（针孔），快门按 0，像素内的位置取像素中心，只取这一个样本；定义见时间键契约（T）的 T8 |
| `conflicts` | 数组 | 否 | `OutputName`，不重复 | 开着原生运动模糊时不能同时要的输出 |

`draft`：

| 字段 | 类型 | 单位 | 必填 | 值域 | 说明 |
|---|---|---|---|---|---|
| `kind` | 字符串 | 无 | 是 | `cycles-low`、`scale`、`path-low` | 草稿档的做法 |
| `samples` | 整数 | 次 | 是 | ≥ 1 | 每像素采样数 |
| `scale` | 双精度 | 无 | 是 | `(0, 1]` | 输出尺寸的缩放 |
| `denoise` | 字符串 | 无 | 否 | 不空 | 用哪种降噪；不降噪就不出现 |

已经登记的三个帧源各自的取值：

| 字段 | `blender` | `three` | `core` |
|---|---|---|---|
| `version` | Blender 的版本号 | `0.187.0` | 锁文件锁定的提交号 |
| `language` | `python` | `js` | `wgsl` |
| `hosts` | `cycles` | `page`（按倾向定，合作者不同意时再改） | `offscreen`（按倾向定，合作者不同意时再改）、`headless-page` |
| `conformance` | `full` | `full` | `full` |
| `outputs.color.type` | `half` | `half` | `f32` |
| `outputs.depth` | `f32` | `f32` | `f32` |
| `outputs.objectId` | `u32` | `u32` | `u32`，另带覆盖率 |
| `outputs.normal` | `half` | `half` | `f32` |
| `outputs.motion` | `false` | `false` | `f32` |
| `outputs` 里别的键 | 不出现 | 不出现 | `denoiseAlbedo`、`denoiseNormal`、`lightgroup:*`，都是 `f32` |
| `sceneQuery` | 五种全有 | `bbox3d`、`anchor`、`belowGround` | 五种全有 |
| `motionBlur.mode` | `native` | `accumulate` | `native` |
| `motionBlur.auxAt` | `sub0` | `sub0` | `sub0` |
| `motionBlur.conflicts` | `motion` | 不出现 | 不出现 |
| `determinism` | `tolerance` | `hash-same-machine`（探针数据表第 11 行和「5090 读数」一节，两台机器） | `待探针：核心帧源同机渲两遍是否逐位相同` |
| `draft` | `cycles-low`，24 次，0.5，降噪 `gpu` | `scale`，1 次，0.5 | `path-low`，24 次，0.5，降噪 `oidn-native` |
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
| `frames` | 整数 | 帧 | 是 | ≥ 1 | 这个镜头的帧数 |
| `entities` | 数组 | 无 | 是 | | 这个镜头的全部实体，每项见下表 |

`entities[]`：

| 字段 | 类型 | 必填 | 值域 | 说明 |
|---|---|---|---|---|
| `id` | 整数 | 是 | ≥ 1 | 实体的编号；0 留给背景 |
| `name` | 字符串 | 是 | 实体名，写法见 S 契约 5.2 | 实体名 |
| `class` | 字符串 | 是 | 不空 | 实体的类别，和元数据里的 `class` 是同一个词 |

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

顶层对象，`format` 是 `source-check/0.1`。一份记录说一个帧源。记录里出现哪一段，就判哪几条不变量；没出现的段不判。

| 字段 | 类型 | 单位 | 必填 | 值域 | 说明 |
|---|---|---|---|---|---|
| `format` | 字符串 | 无 | 是 | `source-check/0.1` | 格式标识 |
| `caps` | `Caps` | 无 | 是 | 见 3.4 | 被测帧源的能力声明 |
| `renders` | 数组 | 无 | 否 | | 对 `render` 的观测，每项见下表 |
| `orderRuns` | 数组 | 无 | 否 | | 乱序和重复渲的观测，每项见下表 |
| `failures` | 数组 | 无 | 否 | | 渲染失败的观测，每项见下表 |
| `auxUses` | 数组 | 无 | 否 | | 辅助层和运动矢量层被拿去做什么，每项见下表 |
| `queries` | 数组 | 无 | 否 | | 对 `query` 的观测，每项见下表 |
| `manifest` | `Manifest` | 无 | 否 | 见 3.6 | `manifest()` 交回的实体清单 |
| `metaEntities` | 数组 | 无 | 与 `manifest` 同时出现 | | 抽到的各帧元数据里的实体，每项见下表 |
| `textReadbacks` | 数组 | 无 | 否 | | 文字框回读的观测，每项见下表 |
| `ext` | 对象 | 无 | 否 | 键带点分前缀 | 私有数据 |

`renders[]`：一次 `render` 调用。

| 字段 | 类型 | 单位 | 必填 | 值域 | 说明 |
|---|---|---|---|---|---|
| `shotFrame` | 整数 | 帧 | 是 | ≥ 0 | 镜头局部帧号 |
| `want` | 数组 | 无 | 是 | `OutputName`，不重复 | 要了什么 |
| `shutterAngleDeg` | 双精度 | 度 | 否 | `[0, 360]` | 这次调用生效的快门角，怎么定见 5.9；不出现表示没开运动模糊，按 0 算 |
| `shutterSamples` | 整数 | 次 | 否 | ≥ 1 | 这次调用生效的子帧采样数，怎么定见 5.9；没记就不出现 |
| `status` | 字符串 | 无 | 是 | `ok`、`error` | 成功还是报错 |
| `code` | 字符串 | 无 | `status` 是 `error` 时必填 | 点分小写 | 错误码 |
| `meta` | 布尔 | 无 | `status` 是 `ok` 时必填 | | 交回的 `FrameResult` 里有没有 `meta` |
| `layers` | 数组 | 无 | `status` 是 `ok` 时必填 | 通道名，不重复 | 交回的 `FrameResult.layers` 的键 |
| `metaShutterAngleDeg` | 双精度 | 度 | 否 | `[0, 360]` | 交回的元数据里的 `camera.shutterAngleDeg`；没交元数据或 `camera` 是 `null` 就不出现 |
| `colorTransfer` | 字符串 | 无 | 否 | `linear`、`encoded` | 量出来的颜色层数值是线性编码，还是过了传递函数；量法见 5.2 |
| `colorRef` | 字符串 | 无 | 否 | `scene`、`display` | 交回的元数据里的 `colorRef` |
| `shotColorRef` | 字符串 | 无 | 与 `colorRef` 同时出现 | `scene`、`display` | 片子描述里这个镜头声明的 `colorRef` |

`orderRuns[]`：把同一帧用不同方式各渲一次。

| 字段 | 类型 | 单位 | 必填 | 值域 | 说明 |
|---|---|---|---|---|---|
| `shotFrame` | 整数 | 帧 | 是 | ≥ 0 | 镜头局部帧号 |
| `mode` | 字符串 | 无 | 是 | `single`、`shuffled`、`sequential`、`repeat` | 渲的方式，见 5.4 |
| `digest` | 字符串 | 无 | 是 | `sha256:` 加 64 位小写十六进制 | 这次结果的哈希，不是状态摘要，见 5.4 |

`failures[]`：故意造出来或者碰上的一次渲染失败。

| 字段 | 类型 | 单位 | 必填 | 值域 | 说明 |
|---|---|---|---|---|---|
| `cause` | 字符串 | 无 | 是 | `gpu-error`、`other` | 失败的原因；`gpu-error` 是显卡错误 |
| `exitCode` | 整数 | 无 | 否 | | 帧源进程的退出码；到观测结束还没退出就不出现 |
| `elapsedMs` | 双精度 | 毫秒 | 是 | ≥ 0 | 从失败发生到进程退出（或观测结束）过了多久 |
| `limitMs` | 双精度 | 毫秒 | 是 | > 0 | 这次给的时限 |

`auxUses[]`：

| 字段 | 类型 | 必填 | 值域 | 说明 |
|---|---|---|---|---|
| `output` | 字符串 | 是 | `depth`、`objectId`、`normal`、`motion` | 哪一层 |
| `use` | 字符串 | 是 | `perception`、`look`、`cross-source-merge` | 拿去做感知，做画风处理，还是做两个帧源的画面之间的合并 |

`queries[]`：一次 `query` 调用。

| 字段 | 类型 | 单位 | 必填 | 值域 | 说明 |
|---|---|---|---|---|---|
| `kind` | 字符串 | 无 | 是 | 同 `SceneQuery.kind` | 问的哪种 |
| `status` | 字符串 | 无 | 是 | `ok`、`error` | 成功还是报错 |
| `code` | 字符串 | 无 | `status` 是 `error` 时必填 | 点分小写 | 错误码 |
| `total` | 整数 | 项 | `status` 是 `ok` 时必填 | ≥ 0 | 截断之前一共有几项 |
| `returned` | 整数 | 项 | `status` 是 `ok` 时必填 | ≥ 0 | `items` 里交回了几项 |
| `truncated` | 整数 | 项 | 否 | ≥ 1 | 结果里的 `truncated`；结果里没有就不出现 |

`metaEntities[]`：

| 字段 | 类型 | 必填 | 值域 | 说明 |
|---|---|---|---|---|
| `shotFrame` | 整数 | 是 | ≥ 0 | 镜头局部帧号 |
| `entities` | 数组 | 是 | 每项 `{ id, name, class }`，同 3.6 | 这一帧元数据里列出的实体 |

`textReadbacks[]`：一个文字框的回读。这一段现在不判任何不变量，过线定下来之前只留观测。

| 字段 | 类型 | 必填 | 值域 | 说明 |
|---|---|---|---|---|
| `shotFrame` | 整数 | 是 | ≥ 0 | 镜头局部帧号 |
| `text` | 字符串 | 是 | 不空 | 元数据的 `texts` 里这个文字框的文字 |
| `read` | 字符串 | 是 | | 从成片画面上这个文字框的矩形里读回的文字；什么都没读到写空串 |

## 4. 不变量

| 编号 | 条文 | 怎么查 | 反例文件 |
|---|---|---|---|
| F1 | 能力声明的 `outputs.meta` 是 `true` 时，成功的 `render` 必须交回元数据；`want` 里有 `color` 时，`layers` 的键必须正好是 `want` 里声明过的像素输出，不得多交；`want` 里没有 `color` 时 `layers` 必须是空的。 | `renders` 里 `status` 是 `ok` 的每一项：`caps.outputs.meta` 是 `true` 时 `meta` 必须是 `true`；`want` 含 `color` 时，`layers` 作为集合必须等于 `want` 去掉 `meta` 之后里面声明过的输出；不含 `color` 时 `layers` 必须是空数组 | `F1-color-not-delivered.json` |
| F2 | 颜色层的数值必须是线性编码，元数据里的 `colorRef` 必须等于镜头声明的 `colorRef`。 | `renders` 每一项：`colorTransfer` 出现时必须是 `linear`；`colorRef` 出现时必须等于 `shotColorRef` | `F2-color-encoded.json` |
| F3 | `want` 里有没声明过的输出时，`render` 必须报错，错误码必须是 `contract.unsupported-output`，不得静默降级。 | `renders` 里 `want` 含有没声明过的输出（定义见第 2 节：`caps.outputs` 里不出现，或取值是 `false`）的每一项：`status` 必须是 `error`，`code` 必须是 `contract.unsupported-output` | `F3-silent-downgrade.json`、`F3-undeclared-key-absent.json` |
| F4 | 任意一帧必须能单独渲，哈希档的帧源同一帧不论单独渲、乱序渲、顺序渲还是重复渲，结果必须逐位相同。 | 帧源名是 `ext.<名字>` 时整条不查。能力声明（单独的，或记录里的 `caps`）：`randomAccess` 必须是 `true`。记录里 `caps.determinism` 是 `hash-same-machine` 时，`orderRuns` 里 `shotFrame` 相同的各项 `digest` 必须逐位相同。容差档怎么比见 5.4 | `F4-order-dependent.json`、`F4-caps-not-random-access.json` |
| F5 | 开着原生运动模糊时要了 `motionBlur.conflicts` 里列的声明过的输出，`render` 必须报错，错误码必须是 `contract.output-conflict`，不得出帧。 | `caps.motionBlur.mode` 是 `native` 时，`renders` 里 `shutterAngleDeg` 大于 0、`want` 里的输出都声明过、并且 `want` 和 `caps.motionBlur.conflicts` 有交集的每一项：`status` 必须是 `error`，`code` 必须是 `contract.output-conflict`。`want` 里有没声明过的输出的项归 F3 判 | `F5-motion-with-native-blur.json` |
| F6 | 渲染失败时帧源进程必须在时限内以非零退出码结束。 | `failures` 每一项：`exitCode` 必须出现并且不等于 0，`elapsedMs` 必须不大于 `limitMs`。显卡错误算不算渲染失败这里不判，见 5.6 | `F6-gpu-error-exit-zero.json` |
| F7 | 辅助层和运动矢量层只能用于感知和画风处理，不得用于两个帧源的画面之间的合并。 | `auxUses` 每一项的 `use` 不得是 `cross-source-merge` | `F7-depth-merge-across-sources.json` |
| F8 | `query` 问了能力声明的 `sceneQuery` 里没列的种类时必须报错，错误码必须是 `contract.unsupported-query`，不得给结果。 | `queries` 里 `kind` 不在 `caps.sceneQuery` 里的每一项：`status` 必须是 `error`，`code` 必须是 `contract.unsupported-query` | `F8-undeclared-query-answered.json` |
| F9 | `QueryResult.items` 不得超过 50 项，超过时必须只交回最严重的 50 项，并且在 `truncated` 里写被截掉的项数。 | `queries` 里 `status` 是 `ok` 的每一项：`returned` 必须等于 `total` 和 50 里小的那个；`total` 大于 50 时 `truncated` 必须等于 `total − 50`，否则 `truncated` 不得出现。留下的是不是最严重的 50 项现在不判，见 5.7 | `F9-query-not-truncated.json`、`F9-returned-too-few.json`、`F9-truncated-wrong-count.json`、`F9-truncated-without-cut.json` |
| F10 | `blender`、`three`、`core` 的合规档必须是 `full`，`legacy-page` 和 `ext.<名字>` 的合规档必须是 `limited`。 | 能力声明（单独的，或记录里的 `caps`）：`id` 是前三个之一时 `conformance` 必须是 `full`，否则必须是 `limited` | `F10-blender-declares-limited.json` |
| F11 | 实体清单里的编号和名字都不得重复，每帧元数据里列出的每个实体的编号、名字、类别必须和实体清单里的同一项逐项相同。 | `manifest.entities` 的 `id` 没有重复、`name` 没有重复；`metaEntities` 每一项的每个实体，在 `manifest.entities` 里必须有一项 `id`、`name`、`class` 三样都相同 | `F11-entity-id-changes.json` |
| F12 | 元数据的 `camera.shutterAngleDeg` 必须等于这次 `render` 生效的快门角。 | `renders` 里 `metaShutterAngleDeg` 出现的每一项：它必须等于 `shutterAngleDeg`（不出现按 0 算），没有容差 | `F12-meta-shutter-differs.json` |
| F13 | 生效的快门角是 0 而生效的子帧采样数大于 1 时，`render` 必须报错，错误码必须是 `contract.shutter-conflict`。 | `renders` 里 `shutterAngleDeg` 不出现或等于 0、`shutterSamples` 大于 1、并且 `want` 里的输出都声明过的每一项：`status` 必须是 `error`，`code` 必须是 `contract.shutter-conflict`。`want` 里有没声明过的输出的项归 F3 判 | `F13-zero-angle-multi-sample.json` |

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
| 编号与元数据 | 三个互相遮挡的方块 | 元数据里的屏幕包围盒，和从编号层反算出的包围盒的交并比 | `待探针：元数据包围盒和编号层反算包围盒的交并比` |
| 法线空间 | 已知朝向的球 | 法线层读数和已知法线的夹角，取中位 | `待探针：法线夹角中位，单位度` |
| 相机约定 | 带刻度的 L 形标尺 | 锚点的屏幕位置和已知位置的距离 | `待探针：锚点屏幕位置误差，单位像素` |
| 文字框回读 | 带已知文字的画面 | 元数据的 `texts` 里每个文字框的文字，和从成片画面上那个矩形里读回的文字 | `待探针：文字框回读的过线` |
| 乱序 | 任意镜头 | 见 5.4 | 见 5.4 |
| 重复渲两遍 | 任意镜头 | 见 5.4 | 见 5.4 |

「用编号层核对元数据」只有这一种比法：屏幕包围盒的交并比。别处要做这种核对，都用它。

从编号层反算一个实体的包围盒时，这个实体占的像素 = 编号是它自己、或者是名字以它的名字加 `.` 开头的实体的像素。编号层的一个像素写的是叶子实体的编号：打到的那些实体里名字最长的那个。装配体自己的编号不会出现在编号层里，它占的像素由名字前缀推出。

### 5.4 乱序和重复

- `single`：新开一个会话，只渲这一帧。`shuffled`：把一批帧打乱次序渲。`sequential`：按帧号从小到大渲。`repeat`：同一个会话里把这一帧再渲一遍。
- `digest` 是颜色层文件内容的 SHA-256；只要元数据时，是去掉 `timing` 之后的元数据的 SHA-256。写法照通用口径：`sha256:` 加 64 位小写十六进制。元数据怎么序列化由做一致性测试的工具定，同一份记录里必须用同一种。
- 哈希档：同一帧的 `digest` 作为字符串完全相等，没有容差。`three` 帧源是哈希档：颜色层两遍逐位相同（探针数据表第 11 行和「5090 读数」一节，两台机器）。
- 辅助层：不论哪一档，同一帧渲两遍的辅助层必须逐位相同（探针数据表「5090 读数」一节，5090；探针量过的是深度、编号、位置三层，`normal`、`motion` 没量）。
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

判一个 `limited` 帧源时，先照 3.5 把它免掉的几条划掉，剩下的几条和 `full` 帧源用同样的查法。`legacy-page` 没有免 F1 到 F13 里的任何一条。

### 5.9 生效的快门

- 一次 `render` 生效的快门角和子帧采样数：`RenderOpts.shutter` 出现就用它的 `angleDeg` 和 `samples`；不出现就用镜头条目的 `shutter.angleDeg` 和 `shutter.samples`（见片子描述契约（D）3.3）。
- 镜头条目的 `shutter.samples` 也不出现时由帧源定，定下的值记进锁文件的 `shots.<id>.shutterSamples`。
- 核对记录里的 `shutterAngleDeg`、`shutterSamples` 记的是照上面的次序定下的值。
- 元数据的 `camera.shutterAngleDeg` 写的就是生效的快门角（F12）。生效的快门角是 0 而子帧采样数大于 1 是自相矛盾的请求（F13）。

## 6. 待定

| 项 | 现在怎么写 | 等什么 |
|---|---|---|
| `render(f, …)`、`query(f, …)` 的时间参数 | 照整数的镜头局部帧号写，子帧相位由帧源在内部按时间键契约取 | 按倾向定，合作者不同意时再改 |
| `core` 的 `hosts` 里的 `offscreen` | 照「离屏宿主是核心帧源的出片宿主」写 | 按倾向定，合作者不同意时再改 |
| `three` 的 `hosts`，以及 three 一侧用哪种着色语言 | three 帧源照旧由页面宿主驱动，过渡期渲染器用 WebGL、着色语言用 GLSL。`hosts` 写 `page`：页面宿主的名字，片子描述和锁文件的例子里 three 镜头用的都是这个词；`headless-page` 是另一个宿主（核心帧源的后备宿主），不是它；本契约没有着色语言字段，`language` 说的是镜头代码的语言 | 按倾向定，合作者不同意时再改 |
| `three` 的 `determinism` | 已定：`hash-same-machine` | 探针数据表第 11 行和「5090 读数」一节，两台机器 |
| `core` 的 `determinism` | 留空 | `待探针：核心帧源同机渲两遍是否逐位相同` |
| 容差档颜色层的相对差上限 1e-5 | 实测最大相对差 1.7e-6，留了约 6 倍余量；只在六个校准场景、64 采样、不降噪下量过 | 场景变大、采样数改变、打开降噪之后重新量 |
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
| `open` 的 `env.workspace` 是相对路径还是绝对路径 | 不定 | 集成负责人确认 |
| `FrameResult` 里「对落盘文件的引用」的结构 | 不定 | 信封契约（EN） |
| `want` 里没有 `color`、却有别的像素输出 | 照「只要元数据」写：只交元数据。这和 F3 的「不得静默降级」有张力 | 集成负责人定：照现在这样，还是判成非法请求 |
| 一次 `render` 同时踩中 F3 和 F5（或 F13） | 【起草者补】`want` 里有没声明过的输出时只判 F3，错误码是 `contract.unsupported-output`；F5、F13 只管 `want` 全都声明过的调用。不这样写，同一次调用会被要求报两个不同的码 | 集成负责人确认 |
| F6 的时限是多少、谁给 | 【起草者补】调用方给，记录里带 `limitMs`；数值不定 | 集成负责人确认 |
| `failures[].cause` 的值域 | 【起草者补】`gpu-error`、`other` | 集成负责人确认 |
| `SceneQuery.against` 不出现时 `intersect`、`contact` 和谁比 | 不定 | 谓词登记表契约（PR） |
| 通配的写法 | 【起草者补】只收「前缀加 `.*`」 | 集成负责人确认 |
| `QueryResult.items[]` 在五种查询下各自的 `value` 量什么、`unit` 写什么、`at` 有几个数 | 不定；例子只给了 `intersect` 的一种写法 | 谓词登记表契约（PR） |
| 「最严重的 50 项」按什么排 | 不定；定下来之前 F9 的这半句不判，见 5.7 | 谓词登记表契约（PR） |
| `legacy-page` 除了减免表之外还要过哪些 | 两种说法：一种是「表里没写的一条不免」，一种只点了颜色层、F3、F4、F6 四样。取严的：F1 到 F13 都不免 | 集成负责人确认 |
| 私有外部插件交的「来源信息」 | 结构照每帧元数据契约（M）3.5 的 `source` 一段，见 3.5；一段成片交几个、从哪个接口交：不定 | 集成负责人确认 |

## 7. 变更记录

| 日期 | 改了哪条 | 为什么 |
|---|---|---|
| 2026-11-18 | 全部 | 首稿 |
| 2026-11-18 | 第 2 节、3.1 到 3.5、3.8、F1、F4、F5、F8、新加 F12、F13、5.3、5.4、5.8、新加 5.9、第 6 节 | 照红队和跨契约一致性复核的处理结果改 |
| 2026-11-18 | 3.6 的 `orderRuns[].digest` 说明、第 6 节 | 修订后的对齐收尾 |
| 2026-11-19 | 3.1、3.4 的登记表、3.5、F3、F4、F6、F9、5.4、5.6、5.7、第 6 节 | 照判定函数落地时发现的问题的处理结果改：F3、F4 的查法写全，F6、F9 判不了的半句写明不判，补反例；回填 three 的确定性和容差档的相对差；两个宿主的取值按倾向定 |
