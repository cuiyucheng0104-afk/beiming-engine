# 画风锁定：字段说明（style-lock）

> **解决什么**：画风要能交接、能复核、能延续。仓库目前只有两种"锁法"，都失败过：九分钟版锁源文件哈希（锁死数值，色彩脚本整段丢失），纸上江山 E 组导出一组常量（没有版本、没有允许范围）——两件都被用户否定（`cases/source/local-beiming-film-9min/docs/style-lock.json:2-12`；`cases/source/lab-2026-11-05-e-paper-15s/src/style.js:1-8`）。仓库手册的原则是**锁规则，不要求每镜数值相同**；允许调整的字段、范围和理由写进版本记录；换色板、光照公式或后期顺序要建新版本（`docs/routes/beiming-style.md:175`）。[style-lock.json](style-lock.json) 是按这条原则写的结构草案。
> **怎么用**：新作品先复制 `style-lock.json`，改 `styleId`、`version`、`derivedFrom`，只改有理由的字段，并在 `allowedOverrides` 写清范围和理由。阐述 §9 只引用它（`id@version`）并列本片的覆盖项。风格帧要给用户确认（[../DIRECTING.md](../DIRECTING.md) 关口 2），确认结果写进 `status`。
> 凡括号里给出 `文件:行号` 或命令的说法，都属【仓库实证】，正文不再逐条加标签；没有路径的判断，要么标【通用工艺】或【推断】，要么是对前后实证的归纳。
> **状态**：设计草案【未实现】——渲染器不读取它；A 路线的风格版本数据结构是计划任务 T06（`docs/routes/work-plan.json`）。示例值取自《北冥》10 秒样片，源提交 `3b97946`。

## 1. 和现有契约怎么接

| 现有字段 | 位置 | 与 style-lock 的关系 |
|---|---|---|
| `style.id`、`style.version`、`style.baseline` | `docs/routes/templates/project-beiming.json:10`；`engine/production/project.js:219-249` 校验 | 等于 style-lock 的 `styleId`、`version` 和 `baselines` 里 `primary: true` 的那张。北冥风格路线必须有 baseline |
| `style.migration` | `engine/production/project.js:235-248` | 北冥画风搬到原生后端时必填（design-only／partial／verified）；style-lock 的规则是迁移要对照的目标 |
| `lookPreset` | `docs/routes/templates/shot.json:11`（如 `beiming-original@v1`） | 引用 `styleId@version` |
| `creativeAcceptance.styleComparison` | `docs/routes/templates/render-result.json:18`；`project.js` 要求 accepted 时非空 | 按 `baselines` 逐张做的同帧对照结果 |

建议在 ProjectSpec 里加 `style.lock: "style/lock.json"` 指向本文件（见 [../PRODUCTION-SPEC.md §2](../PRODUCTION-SPEC.md)）。现有校验会忽略这个未知字段，也不检查它的路径【仓库实证·实测】，复跑命令见 PRODUCTION-SPEC §2。

## 2. 字段

### 身份与状态

| 字段 | 必填 | 说明 |
|---|---|---|
| `schema` | 是 | 固定 `beiming.style-lock/1` |
| `styleId`、`version` | 是 | 稳定 ID 与版本号；改 `newVersionWhen` 列出的任何一项就升版本 |
| `route` | 是 | `beiming` 或 `raea`（与 ProjectSpec 一致）；C 路线方法落回 A 或 B 执行，填执行所在的路线 |
| `derivedFrom` | 否 | 派生自哪个 `id@version`；从零建写 null |
| `sourceCommit` | 是 | 写这份锁定时仓库的提交 |
| `status.output` | 是 | `none`／`rendered` |
| `status.technical` | 是 | `not-reviewed`／`passed`／`failed`，附证据 |
| `status.userApproval` | 是 | `none`／`indirect`／`approved`／`rejected`。**只有用户本人的话才能写 approved**；rejected 要写维度和"下次必须改什么" |
| `status.approvalEvidence`、`approvedBy`、`approvedAt` | approved 时必填 | 记录在哪、谁、何时 |

### 基准

| 字段 | 说明 |
|---|---|
| `baselines[]` | 静帧基准：`file`、`sha256`、`shot`、`t`、`frame`（`t×fps` 是整数时填，否则 null 并写 note）、`primary`（与 ProjectSpec 的 baseline 一致的那张） |
| `motionBaselines[]` | 运动基准：每条一拍 n 轨道一组相邻帧（建议 6 帧）。【未实现】样片没有，新版本应补，因为静帧证明不了节拍 |

逐帧比对时时刻用 `f/24`，不用两位小数的秒（`engine/render/still.mjs:14` 的 `--range` 会格式化成两位小数）；严格比对要无损 PNG，仓库现有静帧工具只出 JPEG（[../craft/video.md §2.7](../craft/video.md)）。

### 色

| 字段 | 说明 |
|---|---|
| `palette.colors[]` | `id`、`hex`、`role`（职责）、`only`（只给谁）、`never`（禁用场合）。强调色必须有 `only` |
| `palette.rules` | 跨颜色的规则：灯只给方向、阴影换色相、显示层颜色专属…… |
| `palette.knownDuplicates` | 同一套颜色在别处又写了一份的位置，改色板时一起改 |
| `colorScript.segments[]` | 色彩脚本每段：`id`、`colors`、`meaning`、`valueKey`（明度键：主体、背景、最暗、最亮，以及明暗面积比）、`shots`、`implemented`。没落成参数的段写 `implemented: false`；`valueKey` 是目标还是实测，用 `valueKeySource` 写明 |

为什么要写 `only`：只给十六进制，agent 常把强调色用到别处；写清职责，新镜头才能正确用色（仓库里写得好的：`cases/source/ppt-jianlong/制作规范.md:44-48`、`cases/source/style-74-isometric-picture-book/TREATMENT.md:33`，后者的"强调色只给规则"来自 `$甲/styles/isometric-picture-book/STYLE.md:29`）。

### 光、着色、线、笔触、纹理、调色

| 字段 | 说明 |
|---|---|
| `light.key` | 主光模型（A 路线：第一盏投影平行光只取方向与投影）、本风格的意图（例如北冥日出段选低角度逆光；它只描述本风格，不是新作品的默认）、仰角范围、每镜方向 |
| `light.fill`、`light.sky` | 补光与天光的方向、含义、每镜倍率 |
| `light.script[]` | 光的剧本：哪个镜头、哪段帧、哪些参数从多少变到多少、叙事含义 |
| `shading` | 渲染模型、色调映射（A 路线 `NoToneMapping`）、默认阈值与过渡宽度、预设 |
| `line` | 屏幕墨线参数与每镜覆盖；材质内画线的时钟（目标：沸腾节拍等于该物体的绘制节拍）、现状与已知问题 |
| `brush` | Kuwahara 默认值与每镜近／远半径；理由 |
| `texture` | 纸纹强度与尺度、颗粒、暗角；分辨率一致性说明 |
| `grade` | 调色与泛光默认值 |

参数名与含义见 [../craft/toon.md §3](../craft/toon.md)；调法见 §4 配方。B 路线不能照抄这些参数名：原生材质要按视觉目标另写（`docs/routes/beiming-style.md:184-185`），只共享"规则"和"基准"。

### 字体、版式、镜头、节拍、显示层

| 字段 | 说明 |
|---|---|
| `typography.fonts[]` | 每项写家族名、文件、角色、`license`；`typography.licenseFile` 指许可全文；`typography.rules` 写子集覆盖、易混字 |
| `layout` | 设计高、后期标定高、显示层缩放、像素比、片名位置 |
| `camera` | 镜头语法规则（默认运镜、禁用运镜、连续性）与每镜视场 |
| `motion.tracks[]` | 每条轨道：`id`、一拍几 `step`；未实现的写 `implemented: false`（`id` 与作品工程描述的 `tracks[].id` 用同一套名字） |
| `overlay` | 显示层规则与主题 |

### 造型、明度、声音与辅助数字（本规范新增）

| 字段 | 说明 |
|---|---|
| `form` | 造型语言：主体比例、剪影要点、近中远各允许多少细节、比例对照表的文件 |
| `valueStructure` | 明度结构：主体与紧邻背景的最小明度差（OKLab ΔL），差不够时由哪几项承担分离（墨线、边缘光、色相、彩度） |
| `soundPalette` | 声音调色板：发声器家族、哪些声音只属于哪一层、静默规则 |
| `metrics` | 给"同帧对照"配的辅助数字：调色后像素到最近色板色的 OKLab 距离分布、每百万像素的墨线长度、Kuwahara 有效半径。只作对照，不作通过门槛；计算脚本【未实现】 |

### 允许范围、新版本条件、禁用、证据

| 字段 | 说明 |
|---|---|
| `allowedOverrides[]` | 允许镜头级调整的参数、适用范围（哪些镜头或按什么条件）、数值范围、理由。不在这里的改动都算越界 |
| `newVersionWhen` | 必须升版本的改动：换色板、换光照公式、换后期顺序、换色调映射 |
| `forbidden` | 本风格明确不做的事 |
| `lockedFiles[]` | 风格来源文件的 sha256。**只是证据**：证明来源没被改动，不证明画风合格 |
| `sources` | 本文件里各值的出处 |

## 3. 版本规则

1. 改 `allowedOverrides` 范围内的参数：不升版本，在阐述 §9 写明。
2. 改范围外的参数或加新规则：升小版本（`v1` → `v1.1`），写 `derivedFrom`，重做受影响镜头的同帧对照。
3. 改 `newVersionWhen` 里的任何一项：升大版本（`v1` → `v2`），重做跨镜头对照（远、中、近景同时刻），并重新走用户确认（`docs/routes/beiming-style.md:169,175`）。
4. 九张不同景别、不同照明的素材，不能各挑一组互不相关的参数就称"统一风格"；先选有代表性的几类场景验证同一个版本，再允许有记录的镜头级调整（`docs/routes/beiming-style.md:169`）。

## 4. 交付前检查（建议，【未实现】）

| 检查 | 做法 |
|---|---|
| 字段齐全 | JSON 可解析；必填字段非空；强调色都有 `only`；`typography.fonts[]` 每项有 `license` |
| 基准存在 | `baselines[].file` 存在且 sha256 一致（ProjectSpec 的 `checkFiles` 目前只查入口文件，不查 baseline，见 PRODUCTION-SPEC §13） |
| 越界检测 | 镜头代码里实际用到的参数是否落在 `allowedOverrides` 的范围内 |
| 颜色漂移 | `palette.knownDuplicates` 列出的副本与主色板一致 |
| 状态诚实 | `userApproval` 为 approved 时有证据；没有就不能写 |
| 明度分离 | 按 `valueStructure` 在基准帧上取样核对（[../VISUAL-DESIGN.md §3](../VISUAL-DESIGN.md)） |
| 辅助数字 | 新版本与基准的 `metrics` 并排列出，差异要能在版本记录里找到理由 |

## 5. 出处与许可

- 锁规则的原则出自本仓库手册（`docs/routes/beiming-style.md:175`）；示例值全部取自《北冥》10 秒样片的源码（`sources` 字段逐项给出）。
- 分项改编自第三方风格库甲的风格模板：它把"本质与不是什么、材质与渲染、色彩逻辑、字体、运动、镜头词汇、声音调色板、原生招式、陷阱、引擎、变化空间"分成固定编号的十一节写风格不变量（`$甲/styles/_template/STYLE.md:18-72`）；本结构沿用这种分法，再按三渲二和北冥的需要加了明度结构、造型语言、显示层、版本规则与状态字段。
- 文中提到的 C 路线写法及其来源：设计系统写成 token（`cases/source/style-16-swiss-motion/TREATMENT.md:34-39`，token 逐项来自 `$甲/styles/swiss-motion/STYLE.md`，三种灰线里两种已与 `film.js:4` 漂移）；配方加"一版测试"（`cases/source/style-12-risograph/TREATMENT.md:31-36`，"一版测试"来自 `$甲/styles/risograph/STYLE.md:34`）；按光照分套的色指定（`cases/source/style-27-cel-anime-80s/pal.js:34-58`，结构来自 `$甲/styles/cel-anime-80s/demo/pal.js:32-54`）；颜色职责白名单（`cases/source/ppt-jianlong/制作规范.md:44-48`，本仓库自有）。
- 转述，未复制原文。`$甲` = `cases/vendor/lemo-opuscar`（MIT，LemoLab），见 [../SOURCES.md](../SOURCES.md)。
