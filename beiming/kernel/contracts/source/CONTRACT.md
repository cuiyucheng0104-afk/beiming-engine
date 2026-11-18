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
- 深度、物体编号、法线、运动矢量各层的数值定义，以及 `OutputName` 之外的通道：输出通道契约（PS）。
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
| 宿主 | 帧源里装载镜头、驱动逐帧求值并出帧的那层程序；一个帧源可以有多个宿主，列在能力声明的 `hosts` 里。 |
| 能力声明 | 帧源说自己能交什么、怎么交的一个数据对象，`caps()` 的返回值。 |
| 会话 | 对一个镜头 `open` 之后得到的对象，到 `close` 为止。 |
| 输出 | 一次 `render` 能要的东西，名字是 `OutputName` 里的六个之一。 |
| 像素输出 | 除 `meta` 之外的五个输出。 |
| 颜色层 | 名叫 `color` 的输出。 |
| 运动矢量层 | 名叫 `motion` 的输出；本契约里它和辅助层按同样的规矩管。 |
| 声明过的输出 | 能力声明的 `outputs` 里取值不是 `false` 的输出。 |
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
| `legacy-page` | 旧的页面作品，不交完整元数据 |
| `ext.<名字>` | 私有外部插件；`<名字>` 是小写字母、数字、连字符 |

别的契约里出现「帧源名」，值域都是这一张表。

### 3.2 接口

| 函数 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `caps()` | 无 | `Caps`，见 3.4 | 不开会话就能调。同一个版本的帧源每次返回的内容必须相同 |
| `open(shot, env)` | `shot`：片子描述里的一个镜头条目；`env`：见下表 | `Session` | 装载这个镜头 |
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

`RenderOpts`，三个字段都可以不出现，不出现时用能力声明和档位定下的值：

| 字段 | 类型 | 单位 | 必填 | 值域 | 说明 |
|---|---|---|---|---|---|
| `samples` | 整数 | 次 | 否 | ≥ 1 | 每像素采样数 |
| `scale` | 双精度 | 无 | 否 | `(0, 1]` | 输出尺寸的缩放 |
| `shutter` | 对象 | 无 | 否 | | 快门 |
| `shutter.angleDeg` | 双精度 | 度 | 是 | `[0, 360]` | 快门角；0 表示没有运动模糊 |
| `shutter.samples` | 整数 | 次 | 是 | ≥ 1 | 子帧采样数 |

`OutputName` 的值域：

| 名字 | 是什么 |
|---|---|
| `color` | 颜色层 |
| `meta` | 每帧元数据，结构见每帧元数据契约（M） |
| `depth` | 深度层 |
| `objectId` | 物体编号层 |
| `normal` | 法线层 |
| `motion` | 运动矢量层 |

`FrameResult`：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `meta` | 每帧元数据 | 是 | 每次成功的 `render` 都有 |
| `color`、`depth`、`objectId`、`normal`、`motion` | 对落盘文件的引用 | 否 | 交了哪一层就出现哪一个 |

`want` 里没有 `color` 的 `render` 叫「只要元数据」：不出像素，只交回元数据。这时元数据里哪些字段是 `null`，由每帧元数据契约（M）管。

### 3.4 能力声明 `Caps`

顶层对象，`format` 是 `caps/0.1`。

| 字段 | 类型 | 单位 | 必填 | 值域 | 说明 |
|---|---|---|---|---|---|
| `format` | 字符串 | 无 | 是 | `caps/0.1` | 格式标识 |
| `id` | 字符串 | 无 | 是 | 帧源名，见 3.1 | 哪个帧源 |
| `version` | 字符串 | 无 | 是 | 不空 | 帧源的版本 |
| `language` | 字符串 | 无 | 是 | `python`、`js`、`wgsl` | 这个帧源里的代码用的语言；`python`、`js` 和镜头契约（S）的语言是同一组词 |
| `hosts` | 数组 | 无 | 是 | 至少 1 项，字符串 | 这个帧源有哪些宿主 |
| `conformance` | 字符串 | 无 | 是 | `full`、`limited` | 合规档，见 3.5 |
| `outputs` | 对象 | 无 | 是 | 六个键都必须出现 | 每个输出能不能交，见下表 |
| `sceneQuery` | 数组 | 无 | 是 | `bbox3d`、`anchor`、`intersect`、`contact`、`belowGround`，不重复 | 能答哪几种场景查询；一种都不能答写空数组 |
| `motionBlur` | 对象 | 无 | 是 | | 运动模糊怎么做，见下表 |
| `determinism` | 字符串 | 无 | 是 | `hash-same-machine`、`tolerance` | 哈希档还是容差档 |
| `draft` | 对象 | 无 | 是 | | 草稿档怎么出，见下表 |
| `granularity` | 字符串 | 无 | 是 | `frame` | 最小能单独渲的单位 |
| `randomAccess` | 布尔 | 无 | 是 | | 能不能任意帧单独渲 |
| `modes` | 数组 | 无 | 是 | 至少 1 项：`cards-data`、`build-script`、`native-code`，不重复 | 作者模式；`cards-data` 就是「卡加数据」模式 |
| `cost` | 对象 | 无 | 是 | `{ unit }`，`unit` 的值域是 `gpu-second` | 成本用什么单位记 |
| `input` | 字符串 | 无 | 否 | 格式标识 | 帧源直接吃的场景格式，例如 `scene-pack/0.1` |
| `solvers` | 数组 | 无 | 否 | `path` | 有哪几种求法；`path` 是路径追踪 |
| `channels` | 字符串 | 无 | 否 | 格式标识 | 这个帧源另外交全套输出通道时，通道表的格式标识，由输出通道契约（PS）定 |
| `metaNull` | 数组 | 无 | 否 | 见每帧元数据契约（M）3.6 的「可以声明」一类，不重复 | 这个帧源交不出、在元数据里一律写 `null` 的字段 |
| `ext` | 对象 | 无 | 否 | 键带点分前缀 | 私有数据 |

`outputs`：

| 键 | 类型 | 值域 | 说明 |
|---|---|---|---|
| `color` | 对象 | `{ type, transfer, primaries, note? }` | 颜色层。`transfer` 必须是 `linear`，`primaries` 必须是 `rec709`：数值是线性编码，原色是 Rec.709 |
| `meta` | 布尔 | `true`；私有外部插件可以是 `false` | 交不交每帧元数据 |
| `depth`、`objectId`、`normal`、`motion` | `false` 或对象 | `false`，或 `{ type, note? }` | `false` 表示交不出 |

`type` 是每个通道的数值类型，值域 `half`、`f32`、`u32`。`note` 是给人看的补充说明，不空的字符串，机器不读。

`motionBlur`：

| 字段 | 类型 | 必填 | 值域 | 说明 |
|---|---|---|---|---|
| `mode` | 字符串 | 是 | `native`、`accumulate` | 原生运动模糊，还是逐子帧累积 |
| `auxAt` | 字符串 | 是 | `sub0`、`first-sample` | 辅助层取 `sub = 0` 那个采样，还是取这一帧的首个采样 |
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
| `version` | Blender 的版本号 | `待定：three 的精确版本` | 锁文件锁定的提交号 |
| `language` | `python` | `js` | `wgsl` |
| `hosts` | `cycles` | `待定：three 帧源的渲染器主干` | `offscreen`（`待定：离屏宿主的定位`）、`headless-page` |
| `conformance` | `full` | `full` | `full` |
| `outputs.color.type` | `half` | `half` | `f32` |
| `outputs.depth` | `f32` | `f32` | `f32` |
| `outputs.objectId` | `u32` | `u32` | `u32`，另带覆盖率 |
| `outputs.normal` | `half` | `half` | `f32` |
| `outputs.motion` | `false` | `false` | `f32` |
| `sceneQuery` | 五种全有 | `bbox3d`、`anchor`、`belowGround` | 五种全有 |
| `motionBlur.mode` | `native` | `accumulate` | `native` |
| `motionBlur.auxAt` | `sub0` | `sub0` | `first-sample` |
| `motionBlur.conflicts` | `motion` | 不出现 | 不出现 |
| `determinism` | `tolerance` | `待探针：three 帧源同机渲两遍是否逐位相同` | `待探针：核心帧源同机渲两遍是否逐位相同` |
| `draft` | `cycles-low`，24 次，0.5，降噪 `gpu` | `scale`，1 次，0.5 | `path-low`，24 次，0.5，降噪 `oidn-native` |
| `granularity`、`randomAccess` | `frame`、`true` | `frame`、`true` | `frame`、`true` |
| `modes` | 三种全有 | 三种全有 | `cards-data`、`build-script` |
| `input`、`solvers`、`channels` | 不出现 | 不出现 | `scene-pack/0.1`、`path`、输出通道契约（PS）的格式标识 |

核心帧源不执行镜头提交的着色器代码，所以它的 `modes` 里没有 `native-code`。

### 3.5 合规档和减免表

`limited` 免哪几条写死在下表，表里没写的一条不免。

| 帧源 | 档 | 免什么 | 另外必须过 |
|---|---|---|---|
| `blender`、`three` | `full` | 无 | 无 |
| `core` | `full` | 无 | 输出通道契约（PS）的通道口径 |
| `legacy-page` | `limited` | 元数据里的 `camera` 和 `entities`（写 `null`）；一致性套件里的深度口径、编号与元数据、法线空间、相机约定四项 | 文字框回读 |
| `ext.<名字>` | `limited` | 逐帧的元数据（只交来源信息，`outputs.meta` 是 `false`）；F4 | 整段成片过交付规格和像素类检查 |

档是 `limited` 的帧源出的镜头，不参加依赖 `camera` 和 `entities` 的检查。

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
| `ext` | 对象 | 无 | 否 | 键带点分前缀 | 私有数据 |

`renders[]`：一次 `render` 调用。

| 字段 | 类型 | 单位 | 必填 | 值域 | 说明 |
|---|---|---|---|---|---|
| `shotFrame` | 整数 | 帧 | 是 | ≥ 0 | 镜头局部帧号 |
| `want` | 数组 | 无 | 是 | `OutputName`，不重复 | 要了什么 |
| `shutterAngleDeg` | 双精度 | 度 | 否 | `[0, 360]` | 这次调用生效的快门角；不出现表示没开运动模糊 |
| `status` | 字符串 | 无 | 是 | `ok`、`error` | 成功还是报错 |
| `code` | 字符串 | 无 | `status` 是 `error` 时必填 | 点分小写 | 错误码 |
| `delivered` | 数组 | 无 | `status` 是 `ok` 时必填 | `OutputName`，不重复 | 实际交回了什么 |
| `colorTransfer` | 字符串 | 无 | 否 | `linear`、`encoded` | 量出来的颜色层数值是线性编码，还是过了传递函数；量法见 5.2 |
| `colorRef` | 字符串 | 无 | 否 | `scene`、`display` | 交回的元数据里的 `colorRef` |
| `shotColorRef` | 字符串 | 无 | 与 `colorRef` 同时出现 | `scene`、`display` | 片子描述里这个镜头声明的 `colorRef` |

`orderRuns[]`：把同一帧用不同方式各渲一次。

| 字段 | 类型 | 单位 | 必填 | 值域 | 说明 |
|---|---|---|---|---|---|
| `shotFrame` | 整数 | 帧 | 是 | ≥ 0 | 镜头局部帧号 |
| `mode` | 字符串 | 无 | 是 | `single`、`shuffled`、`sequential`、`repeat` | 渲的方式，见 5.4 |
| `digest` | 字符串 | 无 | 是 | 小写十六进制，8 到 64 位 | 这次结果的摘要，见 5.4 |

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

## 4. 不变量

| 编号 | 条文 | 怎么查 | 反例文件 |
|---|---|---|---|
| F1 | 成功的 `render` 必须交回元数据；`want` 里有 `color` 时还必须交回 `want` 里每一个声明过的输出，不得多交；`want` 里没有 `color` 时不得交任何像素输出。 | `renders` 里 `status` 是 `ok` 的每一项：`want` 含 `color` 时，`delivered` 作为集合必须等于 `meta` 加上 `want` 里声明过的输出；不含 `color` 时必须正好是 `meta` | `F1-color-not-delivered.json` |
| F2 | 颜色层的数值必须是线性编码，元数据里的 `colorRef` 必须等于镜头声明的 `colorRef`。 | `renders` 每一项：`colorTransfer` 出现时必须是 `linear`；`colorRef` 出现时必须等于 `shotColorRef` | `F2-color-encoded.json` |
| F3 | `want` 里有没声明过的输出时，`render` 必须报错，错误码必须是 `contract.unsupported-output`，不得静默降级。 | `renders` 里 `want` 含有 `caps.outputs` 取值是 `false` 的输出的每一项：`status` 必须是 `error`，`code` 必须是 `contract.unsupported-output` | `F3-silent-downgrade.json` |
| F4 | 任意一帧必须能单独渲，哈希档的帧源同一帧不论单独渲、乱序渲、顺序渲还是重复渲，结果必须逐位相同。 | `caps.randomAccess` 必须是 `true`（`ext.<名字>` 不查）；`caps.determinism` 是 `hash-same-machine` 时，`orderRuns` 里 `shotFrame` 相同的条目 `digest` 必须逐位相同。容差档怎么比见 5.4 | `F4-order-dependent.json` |
| F5 | 开着原生运动模糊时要了 `motionBlur.conflicts` 里列的输出，`render` 必须报错，不得出帧。 | `caps.motionBlur.mode` 是 `native` 时，`renders` 里 `shutterAngleDeg` 大于 0 并且 `want` 和 `caps.motionBlur.conflicts` 有交集的每一项：`status` 必须是 `error` | `F5-motion-with-native-blur.json` |
| F6 | 渲染失败时帧源进程必须在时限内以非零退出码结束，显卡错误必须算渲染失败。 | `failures` 每一项：`exitCode` 必须出现并且不等于 0，`elapsedMs` 必须不大于 `limitMs` | `F6-gpu-error-exit-zero.json` |
| F7 | 辅助层和运动矢量层只能用于感知和画风处理，不得用于两个帧源的画面之间的合并。 | `auxUses` 每一项的 `use` 不得是 `cross-source-merge` | `F7-depth-merge-across-sources.json` |
| F8 | `query` 问了能力声明的 `sceneQuery` 里没列的种类时必须报错，不得给结果。 | `queries` 里 `kind` 不在 `caps.sceneQuery` 里的每一项：`status` 必须是 `error` | `F8-undeclared-query-answered.json` |
| F9 | `QueryResult.items` 不得超过 50 项，超过时必须只交回最严重的 50 项，并且在 `truncated` 里写被截掉的项数。 | `queries` 里 `status` 是 `ok` 的每一项：`returned` 必须等于 `total` 和 50 里小的那个；`total` 大于 50 时 `truncated` 必须等于 `total − 50`，否则 `truncated` 不得出现 | `F9-query-not-truncated.json` |
| F10 | `blender`、`three`、`core` 的合规档必须是 `full`，`legacy-page` 和 `ext.<名字>` 的合规档必须是 `limited`。 | 能力声明（单独的，或记录里的 `caps`）：`id` 是前三个之一时 `conformance` 必须是 `full`，否则必须是 `limited` | `F10-blender-declares-limited.json` |
| F11 | 实体清单里的编号和名字都不得重复，每帧元数据里列出的每个实体的编号、名字、类别必须和实体清单里的同一项逐项相同。 | `manifest.entities` 的 `id` 没有重复、`name` 没有重复；`metaEntities` 每一项的每个实体，在 `manifest.entities` 里必须有一项 `id`、`name`、`class` 三样都相同 | `F11-entity-id-changes.json` |

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
| 乱序 | 任意镜头 | 见 5.4 | 见 5.4 |
| 重复渲两遍 | 任意镜头 | 见 5.4 | 见 5.4 |

「用编号层核对元数据」只有这一个口径：屏幕包围盒的交并比。别处要做这种核对，都用它。

### 5.4 乱序和重复

- `single`：新开一个会话，只渲这一帧。`shuffled`：把一批帧打乱次序渲。`sequential`：按帧号从小到大渲。`repeat`：同一个会话里把这一帧再渲一遍。
- `digest` 是颜色层文件内容的摘要；只要元数据时，是去掉 `timing` 之后的元数据的摘要。摘要算法由做一致性测试的工具定，同一份记录里必须用同一种。
- 哈希档：同一帧的 `digest` 作为字符串完全相等，没有容差。
- 容差档：两次结果比两样，峰值信噪比，和 8 位下差 5 级以上的像素占比。门槛是 `待探针：容差档两次渲染的峰值信噪比下限` 和 `待探针：容差档 8 位下差 5 级以上的像素占比上限`。门槛定下来之前，核对记录不收这两个量，F4 对容差档只查 `randomAccess`。

### 5.5 实体名的通配

`of` 和 `against` 的每一项，要么是一个实体名，要么是「前缀加 `.*`」，例如 `kit.*`。`kit.*` 指名字以 `kit.` 开头的全部实体，不含 `kit` 自己。`*` 不得出现在别的位置。

### 5.6 失败和时限

- 渲染失败指 `render` 没能交出要的东西，原因包括显卡错误（设备丢失、显存不足、驱动重置）。
- 显卡错误之后帧源不得把一张不完整的画面当成功交出来。
- 时限由调用方在起帧源进程时给，记在 `limitMs` 里。

### 5.7 「最严重」

超过 50 项时留哪 50 项，按各种查询自己的严重程度排。排法见第 6 节。

### 5.8 减免怎么套

判一个 `limited` 帧源时，先照 3.5 把它免掉的条目划掉，剩下的条目和 `full` 帧源用同样的查法。`legacy-page` 没有免 F1 到 F11 里的任何一条。

## 6. 待定

| 项 | 现在怎么写 | 等什么 |
|---|---|---|
| `render(f, …)`、`query(f, …)` 的时间参数 | 照整数的镜头局部帧号写，子帧相位由帧源在内部按时间键契约取 | `待定：离屏宿主的定位` |
| `core` 的 `hosts` 里的 `offscreen` | 照「离屏宿主是核心的出片宿主」写 | `待定：离屏宿主的定位` |
| `three` 的 `hosts`，以及 three 一侧用哪种着色语言 | `hosts` 的取值留空；本契约没有着色语言字段，`language` 说的是镜头代码的语言 | `待定：three 帧源的渲染器主干` |
| `three` 的 `version` | 留空 | `待定：three 的精确版本` |
| `three`、`core` 的 `determinism` | 留空 | `待探针：three 帧源同机渲两遍是否逐位相同`、`待探针：核心帧源同机渲两遍是否逐位相同` |
| 一致性套件的五个门槛、容差档的两个门槛 | 留空 | 5.3、5.4 里的七个 `待探针` |
| 例子 `caps-core.json` 里的 `version`、`hosts`、`determinism`、`channels` | 为了让例子成形填的示意值，不是结论 | 上面几行定了以后改例子 |
| `Caps` 带 `format` | 【起草者补】通用口径要求顶层对象带格式标识，定成 `caps/0.1` | 集成负责人确认 |
| `Manifest`、`SceneQuery`、`QueryResult` 不带 `format` | 【起草者补】当成接口值，不落盘 | 信封契约（EN）起草时确认 |
| 私有外部插件的帧源名 | 【起草者补】`ext.<名字>` | 集成负责人确认 |
| `language` 的写法 | 【起草者补】和镜头契约一致，写 `js`，不写全称 | 集成负责人确认 |
| `outputs` 各项的形状 | 【起草者补】`false`，或 `{ type, note? }`；颜色层另带 `transfer`、`primaries`。各层的数值定义不在这里写 | 输出通道契约（PS） |
| `motionBlur.auxAt` 的 `first-sample` | 照核心帧源的声明收进值域。时间键契约的 T8 要求辅助层取 `sub = 0`，两处说法不一样：一处说首个采样，一处说 `sub = 0` | 集成负责人定：要么首个采样固定在 `sub = 0`，要么改 T8 |
| `metaNull` | 【起草者补】每帧元数据契约的 M4 要求「交不出的字段在能力声明里说明」，加这个字段来放 | 集成负责人确认 |
| `granularity` 的值域 | 只有 `frame`；整段出片的私有外部插件写什么不定 | 集成负责人确认 |
| `draft.kind`、`draft.denoise`、`solvers` 的值域 | 只收现在三个帧源用到的词；`denoise` 不限词 | 新帧源或新求法登记时加 |
| `modes` 的三个词和镜头契约两种搭镜头模式的对应 | `cards-data` 是「卡加数据」模式；`build-script`、`native-code` 都走入口文件，两者的分界不定 | 镜头契约（S）、片子描述契约（D） |
| `open` 的 `env.workspace` 是相对路径还是绝对路径 | 不定 | 集成负责人确认 |
| `FrameResult` 里「对落盘文件的引用」的结构 | 不定 | 信封契约（EN） |
| `want` 里没有 `color`、却有别的像素输出 | 照「只要元数据」写：只交元数据。这和 F3 的「不得静默降级」有张力 | 集成负责人定：照现在这样，还是判成非法请求 |
| F5 报错用哪个错误码 | 只要求报错，不定错误码 | 错误码表契约（ER） |
| F8 报错用哪个错误码 | 只要求报错，不定错误码 | 错误码表契约（ER） |
| F6 的时限是多少、谁给 | 【起草者补】调用方给，记录里带 `limitMs`；数值不定 | 集成负责人确认 |
| `failures[].cause` 的值域 | 【起草者补】`gpu-error`、`other` | 集成负责人确认 |
| F7 管不管运动矢量层 | 【起草者补】管，和辅助层一样 | 集成负责人确认 |
| `SceneQuery.against` 不出现时 `intersect`、`contact` 和谁比 | 不定 | 谓词登记表契约（PR） |
| 通配的写法 | 【起草者补】只收「前缀加 `.*`」 | 集成负责人确认 |
| `QueryResult.items[]` 在五种查询下各自的 `value` 量什么、`unit` 写什么、`at` 有几个数 | 不定；例子只给了 `intersect` 的一种写法 | 谓词登记表契约（PR） |
| 「最严重的 50 项」按什么排 | 不定 | 谓词登记表契约（PR） |
| `legacy-page` 除了减免表之外还要过哪些 | 两种说法：一种是「表里没写的一条不免」，一种只点了颜色层、F3、F4、F6 四样。取严的：F1 到 F11 都不免 | 集成负责人确认 |
| 私有外部插件交的「来源信息」是什么结构 | 不定 | 集成负责人确认 |
| F8 到 F11 的编号 | 【起草者补】F1 到 F7 之外的四条是本契约自己编的 | 集成负责人确认 |
| 帧源核对记录这个对象 | 【起草者补】为了让每条不变量都能用数据判定而加，不是帧源要产出的东西 | 集成负责人确认 |

## 7. 变更记录

| 日期 | 改了哪条 | 为什么 |
|---|---|---|
| 2026-11-18 | 全部 | 首稿 |
