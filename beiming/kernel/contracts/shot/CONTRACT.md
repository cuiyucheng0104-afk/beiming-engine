# 镜头契约

版本：0.1.0-draft

## 1. 范围

管：

- 镜头入口 `build(ctx)` 的形状，两种语言相同。
- `ctx` 的字段。
- `build` 交回的镜头对象有哪些成员。
- 镜头代码和宿主谁交什么。
- 搭镜头的三种模式：`cards-data`、`build-script`、`native-code`。
- 判定以上各条用的「镜头核对记录」。

不管：

- 时间键、帧率、种子、流名、`hold`、快门：时间键契约（T）。
- 卡的 `Handle`、`create`、`evaluate`，固定装载脚本的步骤：卡的运行时接口契约（CR）。
- 镜头在片子描述里怎么声明（参数、资产、`cards` 数组）：片子描述契约（D）。
- `texts`、`anchors`、`readings` 里面的结构，宿主量出的元数据：每帧元数据契约（M）。
- 帧源名的值域、帧源的求帧接口：帧源接口契约（F）。
- `tracks` 的数据格式、片段补丁的写法、资产引用的写法：不归本契约，归属见第 6 节。

## 2. 术语

镜头、镜头局部帧号、子帧相位、种子、命名随机流、纯函数、墙钟、状态摘要、核对记录：见时间键契约（T）第 2 节。帧源、宿主、帧源名：见帧源接口契约（F）第 2 节。

| 词 | 含义 |
|---|---|
| 镜头代码 | 一个镜头自己写的那份代码，镜头入口是 `build`。 |
| 入口文件 | 放镜头代码的那一个文件，对外只导出 `build`。 |
| 语言 | 镜头代码用的编程语言，值域是 `js`、`python`。 |
| `ctx` | 宿主调用 `build` 时传进去的上下文对象，镜头代码的全部依赖都从它取。 |
| 镜头对象 | `build` 的返回值。 |
| 母语对象 | 帧源所在环境里的原生对象，例如 three 的 `Object3D`、Blender 的物体。 |
| 句柄 | 交给宿主、让宿主能直接量场景的母语对象：`camera`、`entities`、`scene`。 |
| 实体 | 镜头里一个有名字的母语对象，感知和元数据都按这个名字指它。 |
| 实体名 | 实体的名字，点分路径，例如 `kit.fan_L`。 |
| 锚点 | 实体上一个有名字的点，写成 `实体名#锚点名`，例如 `kit.fan_L#hub`。 |
| 画风令牌 | 片子描述里统一定下的画风取值（颜色、线宽这类），镜头代码只读。 |
| 搭镜头的模式 | 一个镜头用哪种办法搭出来，值域是 `cards-data`、`build-script`、`native-code` 三个词，以 F 契约 3.4 为准；对应表在本节末尾。 |
| 「卡加数据」模式 | 就是 `cards-data`：镜头没有入口文件，只在片子描述里列出资产、卡和参数，宿主替它搭镜头。 |
| 出帧者 | 一次出片里实际出这个镜头的帧的那个帧源：片子描述的镜头条目带 `renderer` 时是 `renderer.source`，不带时是 `source`；见片子描述契约（D）3.3。 |
| 固定装载脚本 | 宿主里替「卡加数据」模式的镜头搭镜头的那一份脚本；步骤见卡的运行时接口契约（CR）。 |
| 片段补丁 | 往渲染库内置着色器的源码里按锚点插入或替换的一段着色器代码。 |
| 可信边界 | 元数据里由宿主直接从场景量出、镜头代码改不了的那一部分和其余部分之间的分界。 |

搭镜头的三种模式：

| `mode` | 入口文件 | 怎么搭、每帧谁求值 |
|---|---|---|
| `native-code` | 有，是镜头代码 | 宿主调它的 `build`，之后每帧调它的 `apply`：在本契约里就是镜头对象的 `state(f, sub)` |
| `build-script` | 有，只在构建时跑一次 | 入口文件把场景搭进帧源自己的场景和时间线，之后逐帧由帧源求值 |
| `cards-data` | 没有 | 宿主用固定装载脚本搭，步骤见 CR 契约 3.4 |

`source` 是 `ext.<名字>` 的镜头：`mode` 必须是 `native-code`，不得有入口文件；重放哪个作品怎么写见 D 契约 3.3。

## 3. 结构

### 3.1 镜头入口

| 函数 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `build(ctx)` | `ctx`，见 3.2 | 镜头对象，见 3.3 | JS 里可以是异步函数。Python 里返回字典，键名和 JS 的成员名相同 |

### 3.2 `ctx` 的字段

| 字段 | 类型 | 单位 | 必填 | 值域 | 说明 |
|---|---|---|---|---|---|
| `tracks` | 对象 | 无 | 是 | | 求值核算好的数据轨道。`tracks.apply(f, sub)` 把这一时刻的轨道值写进场景；有相机轨道时带 `tracks.camera` |
| `cards` | 对象 | 无 | 是 | | 技术卡运行库。`cards.use(as, runtime?)` 返回 `Handle`（见 CR 契约）：`as` 是片子描述里这个镜头 `cards` 声明过的实例名，卡的参数只从片子描述来，`runtime` 只放写不进 JSON 的东西；见 5.8 |
| `params` | 对象 | 无 | 是 | | 片子描述里这个镜头的参数 |
| `seed` | 整数 | 无 | 是 | 见 T 契约 3.3 | 这个镜头的镜头种子 |
| `rng` | 函数 | 无 | 是 | | `rng("<用途>/<对象>")` 返回一条命名随机流，流名展开见 T 契约 3.4 |
| `assets` | 对象 | 无 | 是 | | 资产。`assets.load("asset:<名>@<版本>")` 返回资产 |
| `anchor` | 函数 | 米 | 是 | | `anchor("<实体名>", "<锚点名>")` 返回这个锚点的世界坐标 `[x, y, z]` |
| `tokens` | 对象 | 无 | 是 | | 画风令牌。颜色类令牌是场景线性还是显示空间，由片子描述契约（D）逐个写明 |
| `size` | 数组 | 像素 | 是 | `[宽, 高]`，正整数 | 输出尺寸 |
| `fps` | 字符串 | 帧每秒 | 是 | 见 T 契约 3.2 | 全片帧率 |
| `frames` | 整数 | 帧 | 是 | ≥ 1 | 这个镜头的帧数 |
| `shot` | 对象 | 帧 | 是 | `{ id, in, frames }` | 只读。这个镜头的标识、起始帧、帧数；`in` 是全片帧号 |
| `events` | 对象 | 帧 | 是 | 键是事件名，值是整数 | 只读。值是事件展开后减去 `in` 的镜头局部帧号，可以是负数或不小于镜头帧数；只含落在全片范围内的事件。换算见 T 契约 5.8 |
| `THREE`、`renderer` | 母语对象 | 无 | three 帧源必填 | 版本 `0.187.0` | 宿主注入的渲染库和渲染器 |
| `bpy`、`hostScene` | 母语对象 | 无 | Blender 帧源必填 | | 宿主注入的 Blender 模块和场景 |

`ctx` 里没有当前帧号。交给镜头代码和卡的帧号一律是镜头局部帧号（T9）。Python 里 `cards.use` 的 `runtime` 用关键字参数传，JS 里用一个对象传。

### 3.3 镜头对象

| 成员 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `state(f, sub)` | 函数，没有返回值 | 是 | 把 `(f, sub)` 这一时刻的状态写进场景。`f` 是镜头局部帧号，`sub` 是子帧相位 |
| `meta(f)` | 函数，返回对象 | 是 | 交宿主量不出来的三样：`texts`（文字框）、`anchors`（锚点）、`readings`（自定义读数），三个键都可以不出现 |
| `dispose()` | 函数，没有返回值 | 是 | 释放这个镜头占的资源 |
| `camera` | 母语对象 | 是 | 相机句柄 |
| `entities` | 对象，`{ 实体名: 母语对象 }` | 是 | 实体句柄 |
| `scene` | 母语对象 | three 帧源必填，Blender 帧源不出现 | 场景句柄 |

### 3.4 谁交什么

| 东西 | 谁交 | 说明 |
|---|---|---|
| `camera`、`entities`、`scene` | 镜头代码交句柄 | 宿主靠它们出元数据和辅助层 |
| 文字框、锚点、自定义读数 | 镜头代码经 `meta(f)` 交 | 宿主量不出来的只有这三样 |
| 相机参数、包围盒、可见比例、深度范围、渲染统计 | 宿主直接从场景里量 | 镜头代码不得交，也改不了 |

### 3.5 写法示意

两段里的 `title`、`light` 是片子描述里这个镜头 `cards` 声明过的实例名。

three 帧源，JS：

```js
export async function build(ctx) {
  const { THREE } = ctx
  const scene = new THREE.Scene()
  const title = ctx.cards.use('title')
  scene.add(title.object)
  const camera = new THREE.PerspectiveCamera(35, ctx.size[0] / ctx.size[1], 0.1, 100)
  camera.position.set(0, 0, 6)
  return {
    scene, camera,
    entities: { title: title.object },
    state(f, sub) { title.apply(f, sub) },
    meta(f) { return title.meta(f) },
    dispose() { title.dispose() },
  }
}
```

Blender 帧源，Python：

```python
def build(ctx):
    kit = ctx.assets.load("asset:rtx-card@3")
    ctx.cards.use("light")

    def state(f, sub):
        ctx.tracks.apply(f, sub)

    def meta(f):
        return {"anchors": {"kit.fan_L#hub": ctx.anchor("kit.fan_L", "hub")}}

    def dispose():
        pass

    return {"camera": ctx.hostScene.camera, "entities": kit.by_name,
            "state": state, "meta": meta, "dispose": dispose}
```

### 3.6 镜头核对记录

顶层对象，`format` 是 `shot-check/0.1`。出现哪一段就判哪几条，没出现的段不判。

| 字段 | 类型 | 单位 | 必填 | 值域 | 说明 |
|---|---|---|---|---|---|
| `format` | 字符串 | 无 | 是 | `shot-check/0.1` | 格式标识 |
| `shot` | 字符串 | 无 | 是 | 见 D 契约 5.1 | 镜头的标识 |
| `mode` | 字符串 | 无 | 是 | `cards-data`、`build-script`、`native-code` | 搭镜头的模式，见第 2 节的对应表 |
| `entry` | 字符串 | 无 | `mode` 是 `build-script` 或 `native-code` 时必填，`sources` 里有 `ext.<名字>` 的除外 | 相对路径 | 入口文件 |
| `sources` | 数组 | 无 | 是 | 至少 1 项，帧源名 | 这一次出片里出这个镜头的帧的帧源，数法见 5.1 |
| `languages` | 数组 | 无 | 是 | 至少 1 项，`js`、`python` | 这个镜头用到的语言，数法见 5.1 |
| `buildCalls` | 整数 | 次 | 是 | ≥ 0 | 一次装载里 `build` 跑了几次；「卡加数据」模式下数固定装载脚本的搭建步骤跑了几遍 |
| `build` | 字符串 | 无 | 是 | `ok`、`failed` | 构建的结论 |
| `error` | 字符串 | 无 | 否 | 错误码，见错误码表契约（ER） | 构建失败时报的错误码；没报错误码就不出现 |
| `entities` | 数组 | 无 | 是 | 字符串 | 构建交出的全部实体名，含卡带进来的 |
| `omittable` | 数组 | 无 | 否 | `entities` 里的名字，不重复 | `entities` 里类别是 `part`、没有角色的实体名；不出现表示一个也没有 |
| `metaEntities` | 数组 | 无 | 否 | 每项 `{ f, names, omittedParts? }` | 抽帧时每帧元数据里列出的实体名；`f` 是镜头局部帧号，`names` 是实体名的数组，`omittedParts` 是这一帧元数据的 `omittedParts`（整数，≥ 1，单位个；不出现表示这一帧一个也没省） |
| `evaluations` | 数组 | 无 | 否 | 每项 `{ f, sub, mode, digest }` | 对 `state` 的纯函数门观测；`mode` 的值域是 `single`、`shuffled`、`sequential`、`after-other-shot`，`digest` 是状态摘要 |
| `patches` | 数组 | 无 | 否 | 每项 `{ id, hits }` | 片段补丁；`id` 是补丁的名字，`hits` 是命中处数，整数，≥ 0 |
| `metaKeys` | 数组 | 无 | 否 | 字符串 | `meta(f)` 的返回值里出现过的键 |
| `declaredCards` | 数组 | 无 | `cardUses` 出现时必填 | 字符串，不重复 | 片子描述里这个镜头 `cards` 声明过的实例名 |
| `cardUses` | 数组 | 无 | 否 | 每项 `{ as, runtimeKeys?, paramKeys? }` | 镜头代码对 `ctx.cards.use` 的每一次调用，不记内建卡；`as` 是传进去的实例名，`runtimeKeys` 是 `runtime` 的键，`paramKeys` 是这张卡声明的参数名 |
| `scan` | 对象 | 无 | 否 | `{ wallClock, unseededRandom }` | 对镜头代码的静态扫描命中，结构同 T 契约 3.6 的 `scan` |
| `ext` | 对象 | 无 | 否 | 键带点分前缀 | 私有数据 |

## 4. 不变量

| 编号 | 条文 | 怎么查 | 反例文件 |
|---|---|---|---|
| S1 | `state(f, sub)` 必须是纯函数，每次调用把本帧状态整组写全，镜头之间不留状态。 | `evaluations` 里 `f`、`sub` 相同的观测条目，`digest` 必须逐位相同 | `S1-state-accumulates.json` |
| S2 | `build` 在一个镜头的一次装载里必须正好跑 1 次，不得依赖帧号。 | `buildCalls` 必须等于 1 | `S2-rebuilt-every-frame.json` |
| S3 | 一次出片里，一个镜头必须只由一个出帧者出，只用一种语言。 | `sources` 正好 1 项，`languages` 正好 1 项 | `S3-two-sources.json` |
| S4 | `entities` 的名字必须是点分路径，在镜头内唯一；每帧元数据里的实体名必须是 `entities` 的子集，缺的个数必须等于这一帧的 `omittedParts`，缺的只能是类别为 `part`、没有角色的实体。 | `entities` 每项符合 5.2 的写法且没有重复；`metaEntities` 每一项：`names` 每个名字都在 `entities` 里，`entities` 里不在 `names` 里的名字的个数等于 `omittedParts`（不出现算 0），并且这些名字都在 `omittable` 里。见 5.3 | `S4-duplicate-entity.json` |
| S5 | 片段补丁没有命中时必须判构建失败，不得只报警告。 | `patches` 里有 `hits` 等于 0 的项时，`build` 必须是 `failed` | `S5-patch-miss-ignored.json` |
| S6 | 「卡加数据」模式（`cards-data`）的镜头不得有入口文件，必须由宿主用固定装载脚本搭出来。 | `mode` 是 `cards-data` 时不得出现 `entry`；搭建的顺序按 CR 契约判 | `S6-cards-mode-with-entry.json` |
| S7 | 镜头代码不得读墙钟，不得用不带种子的随机。 | `scan.wallClock` 和 `scan.unseededRandom` 都必须是空数组 | `S7-math-random.json` |
| S8 | `meta(f)` 返回的键只能是 `texts`、`anchors`、`readings`。 | `metaKeys` 每项必须是这三个之一 | `S8-meta-overrides-camera.json` |
| S9 | `ctx.cards.use(as, runtime?)` 的 `as` 必须是这个镜头 `cards` 里声明过的实例名，`runtime` 的键不得和这张卡声明的参数同名；违反前一项必须判构建失败并报 `contract.undeclared-card`，违反后一项必须判构建失败并报 `contract.runtime-shadows-param`。 | `cardUses` 里有 `as` 不在 `declaredCards` 里的项时，`build` 必须是 `failed`，`error` 必须是 `contract.undeclared-card`；有 `runtimeKeys` 和 `paramKeys` 含同一个名字的项时，`build` 必须是 `failed`，`error` 必须是 `contract.runtime-shadows-param`。见 5.8 | `S9-undeclared-card.json` |

## 5. 口径

### 5.1 帧源和语言怎么数

只数这一次出片的出帧者那一套：片子描述的镜头条目带 `renderer` 时，留作对照的 `source` 那一套不计入。数入口文件，加上它经 `ctx.cards.use` 用到的每张卡的实现。「卡加数据」模式下数片子描述里这个镜头列出的、形状是 `create` 的卡的实现。形状是 `evaluate` 的卡在求值核里跑，不计入。

### 5.2 实体名的写法

一段或多段，用 `.` 连接；每段只含 ASCII 字母、数字和下划线，不空。`#` 留给锚点，不得出现在实体名里。两个名字逐字符相同才算同一个。

### 5.3 元数据里的实体名怎么查

每次 `verify` 抽帧，把抽到的每一帧元数据里列出的实体名和构建交出的 `entities` 比：元数据里的名字必须是 `entities` 的子集；缺的个数必须等于这一帧的 `omittedParts`（不出现算 0）；缺的只能是类别为 `part`、没有角色的实体。类别、角色、`omittedParts` 见 M 契约。

### 5.4 纯函数门

求值方式 `single`、`shuffled`、`sequential` 同 T 契约 5.4。`after-other-shot` 是先把另一个镜头从构建跑到 `dispose`，再求这个时刻。「逐位相同」同 T 契约 5.2。

### 5.5 片段补丁「命中」

在目标着色器的源码里找到补丁的锚点并完成了插入或替换，算命中 1 处。`hits` 是 0 就是没命中。

### 5.6 坐标

`ctx.anchor` 返回的是世界坐标，单位和坐标系照通用口径。

### 5.7 静态扫描

扫描清单同 T 契约 5.3，扫描范围是入口文件和它直接引用的本镜头文件。

### 5.8 `ctx.cards.use`

- `as` 必须是片子描述里这个镜头 `cards` 声明过的实例名（`cards[].as`，见 D 契约）。没声明就是构建失败，码是 `contract.undeclared-card`。
- 卡的参数只从片子描述来，入口文件不提供参数层（D 契约 5.8）。
- `runtime` 只放写不进 JSON 的东西：宿主对象、函数。它的键不得和这张卡声明的参数同名，同名是构建失败，码是 `contract.runtime-shadows-param`。
- 内建卡不用声明。哪几张是内建卡见目录归属表契约（OW）。

## 6. 待定

| 项 | 现在怎么写 | 等什么 |
|---|---|---|
| `state(f, sub)`、`tracks.apply(f, sub)` 的参数形状 | 照 `(f, sub)` 写 | `待定：离屏宿主的定位` |
| S5 的片段补丁针对哪种着色语言 | 条文不分语言 | `待定：three 帧源的渲染器主干` |
| `sources` 的值域 | 例子只用 `three`、`blender` | 帧源接口契约（F） |
| `ctx.frames` 的含义 | 【起草者补】这个镜头的帧数 | 集成负责人确认 |
| `ctx.size` 的形状 | 【起草者补】`[宽, 高]`，像素 | 集成负责人确认 |
| `ctx.anchor` 的返回值 | 【起草者补】三个数的数组 `[x, y, z]` | 每帧元数据契约（M）起草时确认 |
| `ctx.rng` 返回的随机流有哪些取数方法 | 不定 | 求值核的施工条目 |
| `state`、`meta` 能不能是异步 | 【起草者补】按同步写；`build` 在 JS 里可以异步 | 集成负责人确认 |
| 镜头代码能不能自己引入依赖 | 不成条文；3.5 的写法是全部从 `ctx` 取 | 集成负责人定要不要立一条 |
| 实体名每段的字符集 | 【起草者补】ASCII 字母、数字、下划线 | 集成负责人确认 |
| S3 怎么数 | 【起草者补】形状是 `evaluate` 的卡不计入 | 集成负责人确认 |
| S2 的「不依赖帧号」 | 【起草者补】靠 `ctx` 里没有当前帧号，加上 S1 的门来保证，没有单独的数据判法 | 集成负责人确认 |
| `tracks` 的数据格式归哪份契约 | 不定 | 集成负责人指派 |
| 片段补丁、资产引用的写法归哪份契约 | 不定 | 集成负责人指派 |
| `native-code` 的每帧函数叫什么 | 搭镜头的模式的定义说宿主每帧调入口文件的 `apply`；3.3 的镜头对象里这个函数叫 `state(f, sub)`，没有改名，对应表里写明两者是同一个 | 集成负责人确认 |
| `build-script` 模式下镜头对象的 `state` 还调不调 | 3.3 照旧写成必填，不分模式 | 集成负责人定 |
| `ctx.cards.use` 的 `runtime` 怎么交到卡的 `create` | 不定；`create` 的签名没动 | 集成负责人定，定了以后改这里和 CR 契约 |
| 内建卡不声明时 `ctx.cards.use` 的第一个参数写什么 | 不定；只写「内建卡不用声明」 | 集成负责人定 |
| S3 的「只用一种语言」、S4 的「点分路径，镜头内唯一」 | 【起草者补】改写 S3、S4 时保留了原条文里没被点到的这两半句 | 集成负责人确认 |
| 核对记录里的 `error`、`omittable`、`declaredCards`、`cardUses` | 【起草者补】为了让 S4、S9 能用数据判定而加 | 集成负责人确认 |

## 7. 变更记录

| 日期 | 改了哪条 | 为什么 |
|---|---|---|
| 2026-11-18 | 全部 | 首稿 |
| 2026-11-18 | 第 1、2 节、3.1、3.2、3.5、3.6、S3、S4、S6、新加 S9、5.1、5.3、5.7、新加 5.8、第 6 节 | 照红队和跨契约一致性复核的处理结果改 |
