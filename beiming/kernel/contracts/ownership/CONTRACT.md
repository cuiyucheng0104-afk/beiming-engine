# 目录归属表

版本：0.1.0-draft

## 1. 范围

管：

- 目录归属表 `ownership/0.1` 的结构。表本身是数据，放在本目录的 `ownership.json`。
- `beiming/` 下每个目录归哪个属主。
- 三样东西各放在哪：卡文件、求值核内建能力的实现、其余数据层卡的实现。
- 内建能力和内建卡怎么对应。
- 工作包的写入范围怎么登记、怎么判重叠。

不管：

- 卡文件里面写什么、落点的值域：卡文件格式契约（CF）。
- 契约文件谁能改、怎么改：契约写法约定。
- 新目录能引用哪些旧模块：不归本契约，归属见第 6 节。
- `beiming/` 之外的目录。

## 2. 术语

卡、求值核：见卡的运行时接口契约（CR）第 2 节。帧源、宿主：见帧源接口契约（F）第 2 节。落点：见锁文件契约（LK）第 2 节。卡文件：见卡文件格式契约（CF）第 2 节。

| 词 | 含义 |
|---|---|
| 属主 | 一个组件或一个角色的标识。一个目录的属主是唯一能改这个目录的一方；别人要改，提变更单。 |
| 归属条目 | 表里的一项：一个目录归一个属主。 |
| 根条目 | `path` 是 `.` 的归属条目，管 `beiming/` 下不在任何子目录里的文件。 |
| 放置规则 | 表里的一项：某一样东西必须放在哪个目录。 |
| 数据层卡 | 落点是 `data` 的卡。 |
| 内建能力 | 求值核自带的四样：时间线、事件、随机流、插值。 |
| 内建卡 | 实现是内建能力的卡，一共三张，见 5.6。 |
| 工作包 | 派给一个代理的一件事，有编号。 |
| 写入范围 | 一个工作包被允许改的那些路径。 |

## 3. 结构

目录归属表的任何一层都不得出现本节没列的键。

### 3.1 目录归属表

顶层对象，`format` 是 `ownership/0.1`。

| 字段 | 类型 | 必填 | 值域 | 说明 |
|---|---|---|---|---|
| `format` | 字符串 | 是 | `ownership/0.1` | 格式标识 |
| `root` | 字符串 | 是 | `beiming` | 表里的路径都从这个目录算 |
| `entries` | 数组 | 是 | 每项见 3.2 | 归属条目 |
| `placements` | 数组 | 是 | 每项见 3.3 | 放置规则 |
| `packages` | 数组 | 否 | 每项见 3.4 | 工作包的写入范围 |
| `ext` | 对象 | 否 | 键带点分前缀 | 私有数据 |

### 3.2 `entries[]`

| 字段 | 类型 | 必填 | 值域 | 说明 |
|---|---|---|---|---|
| `path` | 字符串 | 是 | `.`，或一段到多段用 `/` 连接；每段是小写字母、数字、连字符，以字母开头 | 目录，从 `root` 算 |
| `owner` | 字符串 | 是 | 小写字母、数字、连字符，以字母开头 | 属主 |
| `holds` | 字符串 | 是 | 不空 | 这个目录放什么 |

### 3.3 `placements[]`

| 字段 | 类型 | 必填 | 值域 | 说明 |
|---|---|---|---|---|
| `what` | 字符串 | 是 | `card-file`、`builtin-impl`、`data-card-impl` | 哪一样东西：卡文件、内建能力的实现、其余数据层卡的实现 |
| `where` | 字符串 | 是 | 目录，从 `root` 算；可以带 `<kind>`、`<name>` 两个占位段 | 必须放在哪 |
| `covers` | 数组 | `what` 是 `builtin-impl` 时必填 | 出现时至少 1 项；`timeline`、`events`、`rng`、`interp`，不重复 | 管哪几样内建能力：时间线、事件、随机流、插值。没有要管的内建能力时不出现，不得写成空数组 |

### 3.4 `packages[]`

| 字段 | 类型 | 必填 | 值域 | 说明 |
|---|---|---|---|---|
| `id` | 字符串 | 是 | 字母、数字、连字符，以字母开头 | 工作包的编号，不得重复，见 OW5 |
| `writes` | 数组 | 是 | 至少 1 项；每项是从 `root` 算的目录或文件，写法见通用口径「路径」；任何一段不得是 `.` 或 `..` | 写入范围 |

## 4. 不变量

| 编号 | 条文 | 怎么查 | 反例文件 |
|---|---|---|---|
| OW1 | `entries` 里不得有两项的 `path` 相同。 | 没有两项的 `path` 逐字符相同 | `OW1-two-owners-for-cards.json` |
| OW2 | 5.1 表里的每一行，`entries` 里必须有 `path` 和 `owner` 都相同的一项。 | 逐行在 `entries` 里找；表外的归属条目可以有 | `OW2-calib-missing.json` |
| OW3 | `placements` 必须正好是 5.3 表里的三条，`what`、`where`、`covers` 都相同。 | 两边按 `what` 对：项数相等，`where` 逐字符相同，`covers` 作为集合相等 | `OW3-data-card-impl-in-eval.json` |
| OW4 | 任意两个工作包的写入范围不得重叠。 | 取不同工作包的两条 `writes`，照 5.4 判；任何一对重叠就不满足 | `OW4-packages-overlap.json`、`OW4-same-path.json` |
| OW5 | `packages` 里不得有两项的 `id` 相同。 | 没有两项的 `id` 逐字符相同 | `OW5-duplicate-package-id.json` |

## 5. 口径

### 5.1 必有的归属条目

| `path` | `owner` | 放什么 |
|---|---|---|
| `.` | `integrator` | 根目录下的文件 |
| `api` | `api` | 协议 |
| `jobs` | `jobs` | 作业 |
| `kernel` | `integrator` | `kernel` 下不在子目录里的文件 |
| `kernel/contracts` | `integrator` | 契约 |
| `kernel/eval` | `kernel-eval` | 求值核：时间线、事件、随机流、插值的实现 |
| `sources` | `integrator` | `sources` 下不在子目录里的文件 |
| `sources/three` | `source-three` | three 帧源 |
| `sources/blender` | `source-blender` | Blender 帧源 |
| `sources/legacy-page` | `source-legacy-page` | 旧的页面作品帧源 |
| `sources/core` | `source-core` | 核心帧源 |
| `host` | `host` | 宿主 |
| `comp` | `comp` | 合成收尾 |
| `observe` | `observe` | 感知 |
| `verify` | `verify` | 验收 |
| `cards` | `cards` | 技术卡：全部卡文件，以及内建能力之外的数据层卡的实现 |
| `bench` | `bench` | 考题 |
| `harvest` | `harvest` | 收获 |
| `calib` | `calib` | 校准场景 |
| `crew` | `integrator` | 多代理施工 |

`integrator` 是集成负责人，`calib` 是校准场景，其余属主是同名的组件。

### 5.2 一个路径归谁

把路径和每个归属条目的 `path` 按段比，取「整段整段地是它的开头」的归属条目里段数最多的那一个；一个都对不上就归根条目。例：`kernel/eval/timeline.mjs` 归 `kernel-eval`，`kernel/README.md` 归 `integrator`，`cards/camera/fit/evaluate.mjs` 归 `cards`。卡的目录是 `cards/<类>/<卡名的最后一段>/`。

OW1 加这条规则，保证 `beiming/` 下每个目录、每个文件正好有一个属主。

### 5.3 三条放置规则

| `what` | `where` | `covers` | 意思 |
|---|---|---|---|
| `card-file` | `cards` | 不出现 | 卡文件一律在 `cards/` 下面，落点是什么都一样 |
| `builtin-impl` | `kernel/eval` | `timeline`、`events`、`rng`、`interp` | 时间线、事件、随机流、插值的实现在 `kernel/eval` |
| `data-card-impl` | `cards/<kind>/<name>` | 不出现 | 其余数据层卡的实现在 `cards/<类>/<名>/`；`<kind>` 是卡的类别，`<name>` 是卡名的最后一段，见 5.2 |

### 5.4 两条路径重叠

两条路径逐字符相同，或者其中一条整段整段地是另一条的开头，就算重叠。例：`cards/camera` 和 `cards/camera/fit` 重叠；`cards/camera` 和 `cards/camera-rig` 不重叠。

### 5.5 实际的目录和表对不对得上

仓库里 `beiming/` 的每个一级目录，以及 `kernel/`、`sources/` 下的每个二级目录，都必须在 `entries` 里有 `path` 相同的一项。这一条由仓库检查对着目录树判，判定用的数据不在表里，所以没有立成不变量。

### 5.6 内建能力和内建卡

| 内建能力 | 实现在哪 | 对应的内建卡 |
|---|---|---|
| `timeline` | `kernel/eval` | `time.timeline` |
| `events` | `kernel/eval` | `time.events` |
| `rng` | `kernel/eval` | `time.seeded` |
| `interp` | `kernel/eval` | 没有单独的卡；它是给 `time.timeline` 用的函数 |

内建能力四样，内建卡三张。三张内建卡的卡文件照 5.3 的 `card-file` 一条放在 `cards/` 下面，实现照 `builtin-impl` 一条放在 `kernel/eval`。

## 6. 待定

| 项 | 现在怎么写 | 等什么 |
|---|---|---|
| 工作包的写入范围和属主的关系 | 【起草者补】没有规定一个工作包只能写一个属主的目录 | 集成负责人确认 |
| 根条目，`kernel`、`sources` 两个上层目录的归属条目 | 【起草者补】归集成负责人，这样不在子目录里的文件也有属主 | 集成负责人确认 |
| `host` 放什么 | 只写「宿主」 | 离屏宿主的定位：按倾向定，合作者不同意时再改 |
| 帧源一侧和合成一侧的卡，实现放在哪 | 不定；本版只定了数据层 | 集成负责人确认 |
| 私有外部插件的目录 | 不在这个仓库里，表里没有 | 已定，不用等 |
| 新旧目录的依赖边界 | 由 [依赖检查](../../guard.mjs) 执行 | 拆仓前跑 `node beiming/kernel/guard.mjs --standalone` |
| 每个组件的行数上限 | 没收进本表 | 集成负责人指派 |
| 属主要不要单独列一张表、带中文名 | 【起草者补】不列，中文名写在 5.1 | 集成负责人确认 |

## 7. 变更记录

| 日期 | 改了哪条 | 为什么 |
|---|---|---|
| 2026-11-18 | 全部 | 首稿 |
| 2026-11-18 | 第 2 节、5.6、第 6 节、`ownership.json` | 照红队和跨契约一致性复核的处理结果改 |
| 2026-11-18 | 5.2、5.3、第 6 节 | 修订后的对齐收尾 |
| 2026-11-19 | 3.3、3.4、OW4 的反例、新立 OW5、第 6 节 | 写判定函数时暴露的毛病：`covers` 的空数组、`writes` 里的 `.` 和 `..` 交给结构定义拦，工作包编号不重复立成不变量，OW4「逐字符相同」一支补反例；`host` 一行按倾向定 |
| 2026-11-19 | 结构定义。条文、不变量和判定函数没动 | 3.3 写 `what` 是 `builtin-impl` 时 `covers` 必填，结构定义原来没表达这个搭配，漏写 `covers` 要等 OW3 才拒 |
