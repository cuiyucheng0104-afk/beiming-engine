# 导演方法

> **解决什么**：把一个需求导成一部能交付、能复核的风格化动画短片。本文规定导演工作的十步：每一步交什么、怎样算过、常见错在哪、仓库里哪件作品可以照着看，以及 A／B／C 三条路线在哪几步做法不同。
> **按什么顺序用**：先对照 §2 的能力边界，再照 §1 的十步（加一道动态预演）走，上一步的产出物齐了再进下一步；标 ⛔ 的四个关口要拿到用户确认才往下做。小样怎么减负见 [README](README.md)"按规模选路径"。阐述按 [templates/TREATMENT.md](templates/TREATMENT.md) 写；画风规则按 [VISUAL-DESIGN.md](VISUAL-DESIGN.md)；"在本仓库里怎么做到"查 [craft/](craft/README.md)；时间、事件、声音的数据格式见 [PRODUCTION-SPEC.md](PRODUCTION-SPEC.md)；每一步的好例子和反例集中在 [EXEMPLARS.md](EXEMPLARS.md)。
> **适用**：A 北冥风格路线 · WebGL 三渲二、B 北冥原生路线 · BNE、C 北冥代码动画风格 · 86 式。路径里的 `raea`、`cases/vendor` 是工程历史代号，只用来定位文件，不是对外名称（`AGENTS.md:3`）。

## 0. 读前须知

**标注**：【仓库实证】后附 `文件:行号` 或命令输出；【通用工艺】是行业通行做法，不声称仓库已实现；【推断】是由证据推出、没有实测的判断；【未实现】是仓库里没有的能力。凡括号里给出 `文件:行号` 或命令的说法，都属【仓库实证】，正文不再逐条加标签；没有路径的判断，要么标【通用工艺】或【推断】，要么是对前后实证的归纳。本文不使用仓库外的测量。

**方法来源**：十步的前五步，以及步骤 2、3、5、6、8、10 的多数判定条目，改编自 `$甲/DIRECTOR.md`（MIT），在出现处标 `$甲/DIRECTOR.md §n`；本仓库作品用来补证据、补数字和提供反例。被引的 `style-*` 案例是按 `$甲` 方法做的，它们技法的来源见 [SOURCES.md §3](SOURCES.md)。

**路径简写**：不以 `docs/`、`engine/`、`src/`、`lab/`、`audio/`、`assets/`、`media/`、`examples/`、`tools/`、`cases/` 开头的案例路径（如 `style-46-living-screencast/TREATMENT.md`、`ppt-jianlong/jianlong/ARCH.md`）都在 `cases/source/` 下；`<案例 id>:行`（如 `keynote-B-kaitou:9`）指该案例 `TREATMENT.md` 的行号；`style-NN` 指 `cases/source/style-NN-*`。

**状态口径**【仓库实证】`cases/catalog.json` 共 96 条：historical-render 83、interactive 4、experiment 3、rejected 3、previs 2、support 1。

- historical-render 只表示"出过片"，不等于用户认可。本文说的"范例"只评阐述与工程写法；引用 support、experiment、previs 状态的案例时在引用处注明。
- rejected 的三件（`local-baobian-film` 豹变四版、`local-beiming-film-9min` 北冥九分钟、`lab-2026-11-05-e-paper-15s` 纸上江山 E 组）只能当反例，不作任何正面依据（包括"技法参考"和"字段先例"）。仓库只记了一句"用户不认可"，凡本文写到它们被否的原因，都是【推断】（`AGENTS.md:58`；`cases/entries/local-baobian-film.md:11`；`cases/entries/local-beiming-film-9min.md:5`；`cases/entries/lab-2026-11-05-e-paper-15s.md:11`）。
- 已输出、技术检查通过、用户认可是三件事，分开记录（`docs/TRACKS.md:57`）。

**唯一有用户认可痕迹的基准**：《北冥》10 秒样片。九分钟版的画风锁定文档记下"用户明确要求完全沿用"原版十秒（`cases/source/local-beiming-film-9min/docs/画风锁定.md:3`）。这是间接证据，不是对样片本身的验收记录。

## 1. 十步总览

| # | 步骤 | 产出物 | 写在哪 | 关口 |
|---|---|---|---|---|
| 1 | 接需求 | 需求单：用途、片长（秒与帧）、画幅、fps、语言、旁白字幕、交付档位、路线与理由、能力边界核对、素材与授权、brief 原文 | 阐述 §0–§2 | — |
| 2 | 找对标 | 对标表：作品｜学（可测规则，落在哪一镜）｜不学 | 阐述 §6 | — |
| 3 | 故事成形 | 一句话、起承转合（带帧或拍号）、三候选结构表、原生招式表 | 阐述 §4–§5、§7 | ⛔1 用户确认结构与对标 |
| 4 | 写阐述 | 完整 TREATMENT.md（模板 23 节；小样按模板开头的必填表） | `templates/TREATMENT.md` | — |
| 5 | 证明画风 | 风格帧或造型表与比例对照（真实渲染代码出图）、同帧对照、色彩脚本条、灰度与剪影检查、style-lock | 阐述 §8–§9；`style-lock.json` | ⛔2 用户确认画风与色彩脚本 |
| 6 | 镜头设计 | 镜头表（数据）、运镜动机、招牌镜头、转场语法、镜头间连续性 | 阐述 §10；`timeline.json` | — |
| 7 | 节奏与拍点网格 | 时间轴、事件表、cue map、逐拍节拍表 | 阐述 §11–§12；`timeline.json`、`events.json` | — |
| 7.5 | 动态预演 | 由正片时间轴驱动的整片预演（占位主体、临时声）及其联系表 | `preview/`；阐述 §21 第 0 轮 | ⛔3 用户确认节奏与镜头 |
| 8 | 声音设计 | 声音表、静默规格、"最重要的一声"、声音转场、响度目标 | 阐述 §13；`sound/cues.json` | — |
| 9 | 字幕与标题 | 文字白名单、字体清单、读字时长表、安全区与版式数字、片名设计 | 阐述 §14；`subs/` | — |
| 10 | 审片与返修 | 代理审片证据、人工观看记录、返修表、自检表、三种状态 | 阐述 §20–§22；`delivery/` | ⛔4 用户确认成片 |

第 6–9 步先在阐述里写成表；第 7.5 步用占位主体和临时声把第 6、7 步的表做成一条能看的整片，第 8、9 步的表可以同时起草。⛔3 之后才进入正式着色、后期、混音和字幕制作。制作中改了什么，回写阐述的"计划与实际"一节，并同步改前面的表。

**为什么要四个关口**：仓库里被否的三件作品都没有"用户在制作前看过结构、风格帧或节奏"的记录；豹变四版用内部六维评分（每项 ≥8 才交付）自评过关，用户仍不认可（`cases/source/local-baobian-film/SUBAGENT_STANDARD.md:55-66`；`cases/entries/local-baobian-film.md:11`）；纸上江山 E 组的技术检查全部通过（`cases/source/lab-2026-11-05-e-paper-15s/delivery/verification.json`），用户否定了画面方向。内部检查只能证明"没坏"，证明不了"好看"——豹变自己的标准也写明了（`SUBAGENT_STANDARD.md:53`）。【推断】段落过密、镜头单调这类节奏问题（见步骤 3 与 [EXEMPLARS §4](EXEMPLARS.md)）在纸面表格上不显眼，在动态预演里一眼可见，这是加 ⛔3 的理由。关口的位置是本规范的要求，属【通用工艺】加仓库教训，仓库没有强制机制。

## 2. 能力边界与三条路线的差异

### 2.1 能力边界速查

开工前对照需求。需求里出现"未有"一列的项，在 ⛔1 之前告诉用户，并给出替代方案；不要在阐述里许诺做不到的镜头。

| 路线 | 已有 | 未有【未实现】 |
|---|---|---|
| A 北冥风格路线 · WebGL 三渲二 | 三维非人生物与器物的三渲二（三档分档、换色相的阴影、两种边缘光、ID 墨线、Kuwahara 笔触、纸纹颗粒，见 [craft/toon.md](craft/toon.md)）；2.5D 底板、穹顶与抠像面片（[craft/two-five-d.md](craft/two-five-d.md)）；Canvas 2D 画的人物，靠矩阵层级和点形变做有限表演（`src/girl.js`；[craft/animation.md §4.4](craft/animation.md)）；不经后期的显示层文字 | 三维人物与人脸着色（[craft/toon.md](craft/toon.md) 判据 4 末尾）；通用骨骼表演、口型、换手型（`docs/routes/beiming-style.md:42,201`）；完整人物表演（`docs/TRACKS.md:15`，T03–T08）；群体角色；点光源卡通着色（卡通材质只取第一盏平行光的方向，`engine/shade/toon.js:107-112`）；运动模糊、景深；节拍网格与事件表模块 |
| B 北冥原生路线 · BNE | 独立 10 秒实验、资产转换与回读验证（`docs/TRACKS.md:27`） | 人物表演；原版 ID 墨线与 Kuwahara 的等价实现（`docs/TRACKS.md:29`）；GLB 不带屏幕墨线和后期（`AGENTS.md:39`） |
| C 北冥代码动画风格 · 86 式 | 96 个历史案例的方法、阐述与源码（只读快照，`python3 tools/casebook.py restore <id>` 还原，`AGENTS.md:57`） | 不是第三套后端；新片的执行落回 A 或 B（`docs/TRACKS.md:43`） |

替代方案的方向：北冥定调本来就偏好用手、背影、侧脸和镜片反光讲情绪（`docs/作品.md:71`），三维人脸特写、对白可以改成 2D 画布人物、剪影、背影与手。

### 2.2 三条路线在哪几步不同

| 步骤 | A 北冥风格路线 · WebGL 三渲二 | B 北冥原生路线 · BNE | C 北冥代码动画风格 · 86 式 |
|---|---|---|---|
| 1 接需求 | 延续《北冥》画风或要精确控制色阶、阴影、轮廓时选它；先读 `docs/作品.md` 与 `src/`（`AGENTS.md:21`） | 用户明确要原生、或作品不依赖北冥美术规则时选它；先读 `examples/raea/README.md`、`docs/raea/architecture.md`（`AGENTS.md:22`） | 方法资料层，不是第三套后端；取方法，新片落回 A 或 B 执行（`docs/TRACKS.md:43`）。先在 `cases/INDEX.md`、`cases/catalog.json` 找相近案例（`AGENTS.md:55`），再读该风格的 `$甲/styles/<风格>/STYLE.md` |
| 2 找对标 | 对标不能与 `docs/作品.md` 的定调冲突 | 同通则 | 对标是"这部片的"，不是"这种风格的"；风格默认参考在 `STYLE.md` 首行，不能整张照搬 |
| 4 写阐述 | 同模板 | 同模板；镜头表另存一份 `film.board` | 写完三候选才打开该风格的 `DEMO.md` 和示例代码；阐述要有"与示例片对照"一节（`$甲/AGENTS.md:34`） |
| 5 证明画风 | 与 `media/shot_*.jpg` 基准同帧对照；按灰模→反照率→分档→边缘光→底板→笔触的顺序（`docs/routes/beiming-style.md:140-147`）；画风变体要成为有记录的风格版本（`:175`） | `style.baseline` 可以为空；把北冥画风搬到原生后端时必须声明迁移状态 design-only／partial／verified（`engine/production/project.js:27,235-248`）；GLB 不带屏幕墨线和后期（`AGENTS.md:39`），样片里靠墨线承担的明度分离要重新核对；材质按视觉目标改写成原生材质，不机械照搬同名参数（`docs/routes/beiming-style.md:184`） | 风格不变量来自该风格的 `STYLE.md`；本片改了哪些写进 style-lock。改风格按"可放心改／改了会变性格／不能改"三组判断（`$甲/MY-STYLES.md:55-59`）。落到 A 路线时先关掉北冥默认后期，再逐道加回（[craft/README.md §6](craft/README.md) 对照表） |
| 6 镜头设计 | 定调：固定或缓推，不变焦、不甩、不斜；城市长焦、海面广角（`docs/作品.md:69-72`）。运镜种类少是北冥的取舍，不是缺陷。2.5D 按屏幕像素加深度摆面片（[craft/two-five-d.md](craft/two-five-d.md)） | 卡片按世界坐标和宽度摆（`docs/routes/raea-native.md:29`）；天空要能随相机旋转（two-five-d §6） | 镜头写成相机关键帧数据；标注与相机共用一个 world→screen 函数 |
| 7 节奏 | 仓库没有节拍网格或事件表模块【未实现】，新片在作品目录自建 `timeline.js`；现样片是画面主导 | Composition 以整数帧为准（`examples/raea/film.tsx:105`）；声音时刻硬编码在 `tools/sound.py`，没有事件导出 | 83 部 historical-render 里，时间轴、`events.json`、cuecheck 三者齐全的有 69 部（`cases/catalog.json` 文件清单统计），可以借写法；借代码前先查 catalog 的 `upstream` 字段，再与 vendor 逐行对照；沿用 `$甲` 代码时保留原作者的版权与许可声明（`THIRD-PARTY.md:36`；SOURCES §3） |
| 8 声音 | `audio/cues.json` → `audio/mix.py` → `audio/check.py`；封装时不要再做 loudnorm（[craft/video.md §5.8](craft/video.md)）；交付门槛见步骤 8 | `examples/raea/tools/prepare.mjs:34-42` 两遍 loudnorm，没检查是否走线性 | 混音按 `events.json` 放拟音 |
| 9 字幕 | 显示层是不经后期的最上层画布；`window.TEXTS` 有数据，但没有检查器读它【未实现】 | 原生运行时自带检查（`docs/raea/experiment-qa.json`）；字幕要在目标层级上（`docs/routes/raea-native.md:41`） | 有读字时长检查器（`$甲/core/render/readcheck.mjs`），但直接拿去查 A 片会 404（[craft/video.md §6](craft/video.md)） |
| 10 审片 | 证据只算 A 的 | 实际设备、图形后端、编码器分别记录（`docs/TRACKS.md:28`）；墨线、笔触、后期只验本作品承诺的效果，不拿北冥风格当默认门槛（`docs/routes/validation-and-rtx.md` 第 8 节） | 历史成片的编码参数不等于被认可的交付规格 |

证据分路线：A 的 WebGL 数据、B 的原生设备与编码器、C 的历史成片，三者不互相引用为对方成绩（`docs/TRACKS.md:56`）。

## 3. 十步详解

每步五段：**产出物**、**判定标准**（能检查的条目）、**常见错误**、**仓库范例**（更多见 EXEMPLARS）、**路线差异**（只写 §2 之外的补充）。

### 步骤 1 · 接需求

**产出物**：需求单，写进阐述的规格头和"简报与偏离"两节。

- 用途与观众；片长写成"帧数＝秒×fps"；画幅与分辨率；fps 及其依据；语言；有无旁白、字幕、画内文字；交付档位（母带／网页）；响度目标。
- 路线与理由。已有用户决定优先，不因内部架构命名反复要用户确认（`AGENTS.md:24`）。
- 用户自有素材、品牌与 IP 的授权范围、事实来源。需要下载外部素材时先告诉用户来源和许可（`$甲/DIRECTOR.md §1`）。
- brief 原文存进作品目录，阐述里写路径。
- 能力边界：对照 §2.1；需求里有"未有"项时，在 ⛔1 之前告诉用户并给替代方案。
- PPT 或原画转片：先读 `docs/cases/ppt-animation.md`（提取、分层、深度图、时间轴与声画；单张图估出的深度只支持受限机位，`:48`）和 `docs/cases/comparison.md:66-70` 的开工顺序（`AGENTS.md:55`）。2.5D 的深度图做法见 [craft/two-five-d.md §1.1](craft/two-five-d.md)。

**判定标准**

- 每个数字都能检查：宽高为偶数、fps 为正整数、时长由帧数推出（【仓库实证】`engine/production/project.js:181-206` 会拒绝独立填写且不等于 `frameCount/fps` 的时长）。
- 规格头写明上位规范，以及冲突时以谁为准（范例 `cases/source/keynote-B-kaitou/TREATMENT.md:3-4`）。
- 需要用户拍板的事（品牌、IP、事实口径、画风方向）列成问题，一次问完；做到一半遇到新的这类问题，停下来问，不自作主张。

**常见错误**

- brief 原文不入档。【仓库实证】75 份自有阐述里反复引用"分镜总表／分镜条目"，原件不在仓库（`cases/catalog.json` 里 storyboards 的引用数为 0），于是"为什么偏离简报"无法复核。
- 只写秒不写帧；30 fps 与 24 fps 的片子混着套同一套拍点。
- 把"问完一轮就别再问"用到品牌和 IP 决策上【通用工艺】。

**仓库范例**：`cases/source/keynote-C-kaitou/TREATMENT.md:3`（硬规范、冲突裁决、画面文字只用指定三组）；`cases/source/style-46-living-screencast/TREATMENT.md:3-4`（fps 依据，再按帧率反推 BPM）；`cases/source/style-25-dark-keynote/TREATMENT.md:5-14`（简报与风格规则冲突时逐条翻译）。

### 步骤 2 · 找对标

**产出物**：1–3 部对标，三栏表：作品｜学什么（写成能检查的规则，并写落在哪一镜）｜不学什么（角色、造型、旋律、字体、标志、具体构图）。"学／不拿"两栏与不拿的六类改编自 `$甲/DIRECTOR.md §2`；"落在哪一镜"和画面验收是本规范新增。

**判定标准**

- 至少一项是为这个题材找的，不是这种风格的默认参考。【仓库实证】`cases/source/style-48-midcentury-toon/TREATMENT.md:25-32` 四项全是题材专属，片中每项都找得到对应；`style-55`、`style-57`、`style-61`、`style-62` 的对标与风格库给的参考一致，学到的只是通用语法。
- 每条"学"能在镜头表里找到对应镜头。`cases/source/style-02-watercolor/TREATMENT.md:32` 写明了"情绪加速时笔触变快变碎"落在四季段。
- 学法能测：`cases/source/style-34-silent-film/TREATMENT.md:23-24` 把对标写成"跳开的下一帧电车头扫过那个位置""手合上时帽子已提前 3 帧跳走"。
- "不学"要有画面验收手段：成片抽帧对照。片中不出现对标作品名（`style-48:34`）。
- 结构、音乐形式、张力曲线也可以当对标（`style-53-engraving/TREATMENT.md:32` 用一种固定低音的变奏曲式；`style-58-white-model/TREATMENT.md:38` 只学张力曲线）。

**常见错误**

- 对标写成"学节奏"一类空话（`style-01-crayon-book` 第二项、`style-04-impasto/TREATMENT.md:22`）。
- 只声明不学，不查成片。【仓库实证】`style-44-glass-product/TREATMENT.md:28` 写明不学"三角棱镜＋水平光束＋彩虹带"的平面构图，案例海报 `cases/previews/style-44-glass-product.jpg` 用的恰是水平光束扇出的画面。

**路线差异**：C 路线学的是风格库示例的"技术"（笔刷引擎、骨骼、着色器、混音），不学示例的故事、弧线、镜头、道具和时间轴（`$甲/AGENTS.md:34`）。

### 步骤 3 · 故事成形

**产出物**：一句话；起承转合（每段写帧区间或拍号）；三候选结构表；原生招式表。

**判定标准**

- **一个主体、一个目标、一个转折**（`$甲/DIRECTOR.md §3`），转折落在哪一拍写明（`keynote-B-kaitou/TREATMENT.md:14-19`：转折钉在第 8 小节第一拍）。
- **一句话三合一**：画面、声音、主题都在一句里（`keynote-seg2-caizhi/TREATMENT.md:7-9`；`local-sanda-baigujing/TREATMENT.md:4`）。
- **钩子**：第一帧就有主体或事件，不从黑场开始（`style-31:46`、`style-36:52`、`style-42:12`）；前 3 秒内出现能抓住人的变化（`$甲/DIRECTOR.md §3`）。另一套 10 秒片的节奏模板把钩子定在 4.5 秒、片名在 6.5–7.2 秒（`$乙/styles/SKILL.md:73-82`）；钩子时刻要按片长缩放，不照搬秒数【通用工艺】。
- **结尾回声开场**（`$甲/DIRECTOR.md §3`）：同一物件、同一构图或同一动作，换了状态（`style-07-shadow-puppet/TREATMENT.md:9-12` 点灯／熄灯；`style-60-teardown/TREATMENT.md:15,44` 咔哒—拆开—咔哒；`ppt-painting-treasure/方案.md:5-7` 同一块展签从"私藏"改成"已归还"）。
- **媒介独有的一招**放在情绪峰值，写成"招式→剧情功能→出现位置"（`local-sanda-baigujing/TREATMENT.md:16-23` 灯即世界、离布变虚、镂空透光作 X 光、手持散架、绕到幕后；这些手段名是 `$甲/styles/shadow-puppet/STYLE.md:87-91` 菜单里的条目，本片的贡献是把它们映射到剧情功能和出现位置）。这一条改编自 `$甲/DIRECTOR.md §3`。
- **三候选**：否决理由指向本片目标——风格语法（`keynote-B-kaitou:9`）、内容口径（`keynote-C-kaitou:31`，倒计时会把 25 误读成 IP 数）、科学正确（`style-06-whiteboard:11`）、未来拼接（`keynote-seg1-kaijuan:16`）；并写出从落选方案回收了什么（`style-46:10`、`style-12:12`、`style-20:11`）。第一个想到的结构往往是这种风格的套路（`$甲/DIRECTOR.md §4`）。
- **候选怎么来**：同一个题材，换四条轴各出一版——镜头装置（固定、横移、环绕、升降、第一人称、屏中屏）、结构（一镜到底、三站、卡点硬切、加速蒙太奇、回放）、叙事框（角色噱头、工序、产品揭示、界面流程、数据故事、因果演示）、画中媒介（立轴、图谱、杂志、直播间、录像带、游戏）。风格库乙用这个办法让同一风格的三条行业片镜头、动效、叙事都不同（`$乙/industry/README.md:3`；`$乙/AGENTS.md` 行业示例一节）【通用工艺】。
- **读得懂**：把每一段讲给没看过的人听；讲不清的段落删掉，宁可删也不加（`$甲/styles/silent-film/DEMO.md:26` 记录过复杂版本缩成缩略图后读不懂）。

**常见错误**

- 套路开场：`style-48:13` 写明避开"厨房淡入"、`style-37-brick-toy/TREATMENT.md:11` 避开"一只手倒出一盒积木"——这是好做法，反过来就是常见错误。
- 信息片做成"动态 PPT"：只推拉静图加字幕。【仓库实证】《懂你的人》旧版因此被退回，改成书桌空间一镜到底（`docs/cases/ppt-animation.md:50`）；另一部提案片把这类教训写成三条规则：原图不能只做推拉、每个代码元素要有叙事理由、全片只有一张地图一条线一条弧（`cases/source/ppt-in-sight/方案.md:44-47`，原文称"沿用前两个项目的教训"）。
- 段落太密。【推断】豹变在 30 秒里放了 7 段、两次透视转场和一次匹配剪辑（`cases/source/local-baobian-film/BRIEF.md:15-24`），留给核心段的余量不够；该作品已被否。

**仓库范例**：`style-52-hologram-hud/TREATMENT.md:8-14`（候选表四列：结构、开场、结尾、配乐形状）；`style-13-halftone-dossier/TREATMENT.md:7-13`（"好处／问题"表，选 A 再改两处防止变成轮播）；`style-58-white-model/TREATMENT.md:16-20,111`（一句"一天→一米"立概念，再让实算出的漫堤阈值改写转折）。

**⛔ 关口 1**：一句话、三候选表、对标表给用户看，记下确认人、日期和原话，再写完整阐述。

**路线差异**：A 路线沿用《北冥》世界观时，三条规则是硬约束——鲲只出现在眼镜显示层、鲲趋光、眼镜只让人看见本来就在的东西（`docs/作品.md:21-23`）。注意样片镜头 A 是客观机位却看得见鲲背（`src/shotA.js:58-66`），与第一条有张力；新片要在阐述里写明是例外还是"暧昧显现"。

### 步骤 4 · 写阐述

**产出物**：`TREATMENT.md`，按 [templates/TREATMENT.md](templates/TREATMENT.md) 的 23 节写；小样按模板开头的"小样必填"表。

**判定标准**

- 必备节齐：规格头、简报与偏离、三候选、一句话与弧线、对标、原生招式、视觉系统（引用 style-lock）、镜头表、节拍表、cue map、声音表、文字设计、自检、审片与返修、状态。其余节按需。
- 偏离简报或风格规则，逐条写理由和算术（`style-29-pixel-rpg/TREATMENT.md:88` 比较了三种处理 150 BPM 的方案及各自误差；`style-36-backrooms/TREATMENT.md:5` 类型名本身是社区专有名，只作档案名、片内另起名）。
- 没人可问时写"决定日志"，每条一个理由（`keynote-C-kaitou/TREATMENT.md:5-23`，16 条）。
- H1 只写作品名。【仓库实证】带"处理方案／TREATMENT"后缀的 H1 被原样用作 catalog 标题和作品站卡片标题（`cases/INDEX.md:47-61`；`showcase/index.html:689-710`）。
- 多人分章制作时，另写一份分工契约：文件所有权、模块接口、时间函数、交稿自查（`keynote-C-quanpian/ARCH.md:61-75,79-87,115-150,369`；`ppt-jianlong/jianlong/ARCH.md:12-26,122-128`）。

**常见错误：阐述与代码漂移**。【仓库实证】表格是手抄的，返修后没回改：

| 作品 | 阐述写的 | 代码实际 |
|---|---|---|
| `style-24-iso-infographic` | 邮筒外皮 1.25 s、剖切线 2.25 s（`TREATMENT.md:97,100`） | 1.125 s、2.125 s（`timeline.js:13,48`） |
| `style-28-scifi-toon` | 时长 19.5 s（`TREATMENT.md:3`） | 474 帧＝19.75 s（`timeline.js:5`） |
| `style-43-lowpoly-island` | 顶灯和弦 B♭maj9（`TREATMENT.md:95-96`） | D♭ 大九（`mix.py:116,125`） |
| `style-64-newsreel` | 5017 英里（`TREATMENT.md:30`） | 5107（`TREATMENT.md:15`、`timeline.json:315`） |
| `style-76-circuit-board` | 触点弹跳三下（`TREATMENT.md:15,70`） | 四次（`src/timeline.js:10`） |
| `style-16-swiss-motion` | 灰线 `#D3D2CD / #C4C3BE / #E1E0DB`（`TREATMENT.md:34`） | `grid #DDDCD7`、`gridPage #CFCEC9`、`ghost #C4C3BE`（`film.js:4`）：三种里两种对不上 |

规则：规格头的时长、镜头时间、拍点表由时间轴导出，或者用脚本核对"阐述里的数字＝时间轴"【未实现】，见 PRODUCTION-SPEC §11。

**仓库范例**：`keynote-C-kaitou/TREATMENT.md`（全套：决定日志、候选、对标学／不学、带"为什么"的镜头表、写明量化规则的 cue map、声音表、版式网格、IP 自查、全数字自检、两轮返修）；`style-16-swiss-motion/TREATMENT.md`（设计系统写成 token、自检节完整；token 逐项来自 `$甲/styles/swiss-motion/STYLE.md`，且灰线已漂移，见上表）；`style-23-dataviz/TREATMENT.md`（事实、推算、示意三分，返修带"复查实测"列）。

### 步骤 5 · 证明画风

**产出物**

- 有角色：造型表（转面、3–4 个表情、2–3 个关键姿态、色板）＋比例对照表（主体与人、船、楼等参照物并排，标出尺度）＋ 2 张风格帧。没有角色：3 张风格帧，其中一张是招牌镜头。都用正片的绘制代码出图，不用概念图代替（改编自 `$甲/DIRECTOR.md §5`；比例对照表是本规范新增，北冥里鲲、渡船、人、楼之间的尺度关系正是叙事核心，`docs/作品.md:30`）。
- 同帧对照：基准画风与新画风在同一时刻、同一构图并排（`$甲/MY-STYLES.md §4`）。
- 色彩脚本条：每镜一张低分辨率关键帧，按时间顺序并排，用正片代码出（[VISUAL-DESIGN.md §2](VISUAL-DESIGN.md)）。
- 灰度缩略图与剪影图，按 [VISUAL-DESIGN.md §3](VISUAL-DESIGN.md) 的步骤和阈值做【通用工艺】。
- `style-lock.json`（见 [VISUAL-DESIGN.md §1](VISUAL-DESIGN.md) 与 [templates/STYLE-LOCK.md](templates/STYLE-LOCK.md)）。

**判定标准**

- 风格帧、造型表、色彩脚本条的文件与生成命令入档；每张记源提交、参数、资产哈希、相机与灯位、时刻（`docs/routes/beiming-style.md:149`）。
- 剪影测试：纯黑填充仍认得出物种和动作。【仓库实证】反例：豹变的评审记下 B 版的豹读成灵缇或黄鼠狼、豹头像老鼠或狐狸，C 版的小豹像泰迪熊、远山像富士山（`cases/source/local-baobian-film/tools/w2_review_render.js:25`）。
- 明度分离：主体与紧邻背景的明度差按 VISUAL §3 量；不够时写明由哪两项（墨线、边缘光、色相、彩度）承担分离，并写进 style-lock。【仓库实证·复算】北冥样片鲲一影 `#4E5888` 与天顶 `#4F5BBF` 的 OKLab 明度差只有约 0.04，分离靠墨线和暖补光（命令见 [craft/toon.md §5.2](craft/toon.md)）。
- 文化符号不误读；主角造型的可读性排在"参考语法"之前。
- 用户确认的记录（谁、何时、原话）。

**常见错误**

- 风格帧做了不入档：`keynote-C-kaitou/TREATMENT.md:183`、`style-71-memphis-diorama/TREATMENT.md:89`、`style-72-transit-map/TREATMENT.md:155` 提到的 `stills/` 都不在 catalog 文件清单里。
- 技术检查全过当成画风合格（纸上江山 E 组，见 §1）。
- 锁数值不锁规则。【仓库实证】九分钟版用源文件哈希锁画风（`cases/source/local-beiming-film-9min/docs/style-lock.json:2-12`），作品被否；【推断】由冷到暖的色彩脚本因此整段丢失，九分钟都停在破晓色里。仓库手册的原则是"锁规则，不要求每镜数值相同"（`docs/routes/beiming-style.md:175`）。
- 逐条照搬参考语法，压过主角可读性（豹变 B 版，【推断】）。
- 只看彩色帧，不看灰度：色相差撑起来的分离，在灰度里会并成一块。

**仓库范例**：`cases/source/local-sanda-baigujing/test.js:1`（`?test=model` 用真实合成器渲出全部皮影和关键姿势的设定表）；`cases/source/style-29-pixel-rpg/test.js:9-19`（代码版造型表：8 个姿势、走路循环、表情、头像）；`docs/routes/beiming-style.md:130-149`（参考图→可观察变量→校准场景→六步对照）。

**⛔ 关口 2**：风格帧、比例对照、同帧对照、色彩脚本条和 style-lock 给用户确认后再进入镜头制作。

**路线差异**：A 路线的校准场景（T05）和风格版本数据结构（T06）都是 planned（`docs/routes/work-plan.json`），这一步目前靠人工对照基准帧完成。B 路线把北冥画风搬过去时先复核明度分离：屏幕墨线不会随 GLB 迁移（`AGENTS.md:39`）。

### 步骤 6 · 镜头设计

**产出物**：镜头表——编号｜帧区间 `[in, out)`｜拍号｜景别与角度｜运镜（带参数与动机）｜内容｜主体占画高（量法）｜屏幕方向与视觉落点｜为什么｜验收点；招牌镜头；转场语法；连续性说明（每场的轴线与屏幕方向、跨切点的光向与色温）。镜头表存成数据（`timeline.json` 的 `shots`），阐述里的表从它生成。

**判定标准**

- 每镜写"为什么"。每个运镜写明动机（跟随、揭示、改变关系），没有动机的删掉；同一种运镜连用三镜以上要写理由。有一个招牌镜头；转场在媒介内完成，并成一套语法（改编自 `$甲/DIRECTOR.md §8`）。`$甲` 的"至少四种运镜"只当 C 路线风格库的参考：北冥定调是固定或缓推（`docs/作品.md:69`），数运镜种类会鼓励没有动机的运镜；`style-16-swiss-motion/TREATMENT.md:57` 也只有 5 种，变化来自版式。
- 不默认用叠化和黑场；例外写理由。
- 关键时刻主体要读得出：在灰度缩略图里是第一落点（VISUAL §3）。表演和情绪镜头的主体宜占画高 1/3 以上（`$甲/DIRECTOR.md §8`）；尺度揭示镜头例外，但画里要有参照物。量法写明：细长或稀疏的主体用轮廓面积或最短边像素，不用包围盒（`style-60-teardown/TREATMENT.md:39,115` 用包围盒给出 37–60%，细长零件的视觉面积远小于此）。
- 相机参数写成数：视场或焦距、距离、俯仰、缩放；2.5D 写每层的深度 D（[craft/two-five-d.md §3](craft/two-five-d.md)）。
- 所有标注、字幕锚点与相机共用一个 world→screen 函数（`style-13-halftone-dossier/TREATMENT.md:35`；标注不跟主体走是 `$甲/DIRECTOR.md §10` 列出的常见失败）。
- 切点落在所有一拍 n 轨道的公倍数帧上（一拍二＋一拍三取 6 的倍数，[craft/animation.md §2.3](craft/animation.md)）。
- 镜头间连续性按 [VISUAL-DESIGN.md §4.4](VISUAL-DESIGN.md)：轴线与屏幕方向、视线匹配、视觉落点、动作匹配、同场光向与色温、运动中切的速度衔接【通用工艺】。

**常见错误**：只写"缓推""轻推"；镜头表与代码漂移（`style-66-city-symphony/TREATMENT.md:36` 写 6×→22×，`timeline.json:330` 是另一组值）；"同镜延续"不标，读者以为切了（`style-26-rubber-hose` 表里 8 行，代码只有 6 个镜头，`timeline.js:44-51`）；跨切点的光向关系不写——样片镜头 A、C 的主光在画左，镜头 B 的光晕在画右（[craft/two-five-d.md §2.5](craft/two-five-d.md)），B 是不是反打，样片没有任何文字说明【推断】。

**仓库范例**：`style-41-paper-popup/TREATMENT.md:29`（位置／目标／视场／光圈／焦点五元组关键帧，换一组就是硬切）；`style-43-lowpoly-island/TREATMENT.md:28-39`（正交视锥高、俯角、方位全写成数）；`style-72-transit-map/TREATMENT.md:50-56`（倾角、每格像素、光圈）；`style-10-paper-lantern/TREATMENT.md:31-43`（一镜到底按"段"拆）；`ppt-jianlong/jianlong/ARCH.md:122-125`（段落交接帧完全一致，并排两张静帧自检）。

**路线差异**：A 的"海面段广角"在 10 秒样片里没有对应镜头【未实现】。B 的例片镜头表是 `examples/raea/film.board`（时间｜画面｜摄影｜声音｜目的），没有帧区间。

### 步骤 7 · 节奏与拍点网格

**产出物**：时间轴（唯一时间源）、事件表、cue map（速度段、每拍帧数、调性与配器、事件→拍→帧总表）、逐拍节拍表（画面列＋声音列）。

**判定标准**

- 写明主导方式：画面主导、节拍主导或旁白主导（[craft/animation.md §5.1](craft/animation.md)）。
- 速度让每拍落在整帧：每拍帧数＝fps×60/BPM。24 fps 下 72／90／120／144 BPM 是 20／16／12／10 帧；96 BPM 每拍 15 帧但半拍 7.5 帧；100 BPM 每拍 14.4 帧，不落整帧。子拍也要看：90 BPM 一路到三十二分音符都是整帧。做不到时用三连音或统一取整函数，并写明误差上限（`keynote-C-kaitou/TREATMENT.md:99`；`style-09-papercut-red/TREATMENT.md:110` 写明最大误差 20.8 ms）。
- 拍点那一帧已经是结果（撞击、落定、字落稳）；起步放在它之前（`style-34-silent-film/film.js:49-58` 字提前 3 帧落下，拍点上落稳）。
- 至少一次明显加速、一次减速或急停、一处喘息（`$甲/DIRECTOR.md §7`）。变速写成逐拍帧数（`style-66-city-symphony/timeline.js:6-27`；`style-19-blueprint/TREATMENT.md:73`）。
- 事件只写一处，画面、混音、字幕、核对都读它；有核对脚本：同源数值偏差 0；成片实测按 [craft/animation.md §5.7](craft/animation.md) 的同步容差表判定——声音可以比结果帧晚 0–1 帧，早于结果帧不超过约 10 ms（四方核对的写法见 `style-15-woodcut/tools/cuecheck.py:14-51`）。
- 一次性事件对画面帧，连续节奏型对音乐网格（`keynote-B-kaitou/TREATMENT.md:86`）；"画面时刻"有定义：落定类取第一次到位那一帧，起动类取第一帧变化（`keynote-C-kaitou/TREATMENT.md:17`）。

**常见错误**

- 用浮点秒量化：拍点舍入到 1e-6 s 后比 `f/24` 晚半微秒，画面晚一帧（`style-25-dark-keynote/TREATMENT.md:143`）；用秒数阈值圈拍，注释说两拍，实际圈了三拍（`src/girl.js:384`，[craft/animation.md §1.2](craft/animation.md)）。
- 速度不落整帧：`style-10-paper-lantern` 30 fps 下 96 BPM 每拍 18.75 帧，94 个事件里 70 个不在整帧上（【仓库实证·复算】`events.json` 与 30 fps）。
- 同一事件两处手抄：A 样片的显示层时间表在 `src/hud.js:49-57`（又被 `src/main.js:31` 改写），声音表在 `audio/cues.json` 里另写一遍；数值目前一致，但鸽群的只数、方向比例和扑翼频率在画面与声音里已经对不上（`src/birds.js:15-16,26`；`audio/cues.json:73`；`audio/design.py:99-101,108`）。

**仓库范例**：`style-66-city-symphony/timeline.js:6-27`（"每拍帧数"本身就是速度表）；`style-19-blueprint/TREATMENT.md:72`（90 而非 100 BPM：摆的半周期 0.667 s，对应图上标注的摆长）；`ppt-jianlong/jianlong/ARCH.md:69`（画面动作的时刻从声音事件表取，不在 JS 里另写数）。

**路线差异**：A 路线没有节拍网格模块和声画对位检查【未实现】；样片声音自检只查响度、频段和切点爆音（`audio/check.py:49-59`）。新片照 PRODUCTION-SPEC 在作品目录自建。

### 步骤 7.5 · 动态预演

**产出物**：一条由正片时间轴驱动的整片预演和它的联系表；阐述 §21 记成"第 0 轮"（版本、确认人、日期、原话）。

- 相机、切点、镜头时长全部取自正片的时间轴（第 7 步）；主体用占位（低 LOD、灰模、剪影或简化几何），显示层文字用占位框；后期可以全关，可以半分辨率。
- 声音用临时声：节拍器、拍点提示音或临时配乐，按 `events.json` 落点。

**怎么做（A 路线）**：在作品自己的 look 配方里加一个预演开关（例如 `?previs=1` 时把墨线、Kuwahara、纸纹、颗粒设成 false；每帧参数填 false 或 null 即关掉该道后期，`src/look.js:14`），再用现有渲染器出半分辨率整片：

```sh
node engine/render/video.mjs . --size 960x520 --query previs=1 --out <输出目录>/previs.mp4
```

`--size` 必须是不小于 16 的偶数（`engine/render/page.mjs:55-63`）；`--query` 原样传给页面（`engine/render/video.mjs:14`）。预演开关要在作品里自写，一键预演工具仓库没有【未实现】。B 路线用原生运行时的低质量档出片，同样配临时声。

**判定标准**

- 时长与切点等于时间轴；每个计划事件在预演里看得见。
- 不知情的人看完能复述故事（由人做）。
- 用户确认节奏与镜头之后，才进入正式着色、后期、混音和字幕；之后改切点必须回写时间轴和阐述。

**常见错误**：用纸面表格代替预演；预演用手调的剪辑点，与正片时间轴不一致，确认过的节奏落不到正片里。

**依据**：动态预演（animatic）是动画行业的通行做法【通用工艺】。仓库有两件技术预演作品（catalog 状态 previs：`local-tenet-highway-previs`、`local-fast5-train-previs`），说明预演是现成的工作类型，只是还没进入导演流程。`$甲/DIRECTOR.md §5` 也有"用户要分镜时出联系表、等确认"的做法。

**⛔ 关口 3**：预演和联系表给用户，记下确认人、日期、原话。

### 步骤 8 · 声音设计

**产出物**：声音表（段｜环境床｜拟音（标材质）｜音乐状态，三栏改编自 `$甲/DIRECTOR.md §4` 第 7 项）；静默清单（位置、时长、目标电平、是否留底噪、之后第一声是什么）；声音转场清单（J-cut／L-cut）；"最重要的一声"及其类型；混音总线与响度目标；乐器与采样的来源和许可。

**判定标准**

- 承担叙事的动作必须有声；次要动作由环境床覆盖；删声和加声都要写理由。环境、拟音、音乐三层；至少两处真静默，静默后的第一声专门选；至少两次用声音做转场；不用泛泛的钢琴加弦乐铺底（改编自 `$甲/DIRECTOR.md §6`。`$甲` 原文要求"每个可见动作都有声"；北冥定调是配乐稀疏、科技是环境，`docs/作品.md:88-90`，所以本规范改成按叙事取舍）。
- "最重要的一声"写明类型：A 类靠最响，要给出实测领先多少 LU（`style-32-microgame/TREATMENT.md:96` 写成"比全片任何峰值高 ≥2 LU"）；B 类靠前面的静默反衬，不必最响。测量口径统一报两个数：400 ms 瞬时响度和 50 ms 短窗 RMS【通用工艺·建议】。阐述里声称了"最重要的一声"却没写类型的，审片时按 A 类核对。
- 静默写目标电平，并在最终解码的 AAC 上测（`style-29-pixel-rpg/tools/cuecheck.py:65-69` 在解码后的 AAC 上验证静默为真零）。数字零与近静默按功能选：揭晓或爆发前一拍用数字零；叙事中段的近静默留房间底噪，免得听起来像掉音（`keynote-C-quanpian/TREATMENT.md:14`）。
- 声画同源：同一物件的声音和画面属于一个家族（`audio/design.py:3-5`：汽笛与鲲鸣同一发声器、同一谐波谱；`keynote-B-kaitou/TREATMENT.md:108`：电流嗡声与乐曲同为 G）。
- 响度门槛只在一处定义：混音目标写在 `sound/cues.json` 的 `premaster`（A 样片 −14 LUFS、−1.7 dBTP，`audio/cues.json:6-9`）；交付判定写在 ProjectSpec 的 `audio`，以最终 AAC 为准：积分响度 −14±1 LU、真峰值不高于 −1.2 dBTP（`docs/routes/validation-and-rtx.md:37`；`docs/routes/templates/project-beiming.json:12`）。10 秒左右的短片另报最大短期响度（3 s）和最大瞬时响度（400 ms）（[craft/video.md §5.8](craft/video.md)）。

**常见错误**：近静默只写"近乎静默"，不写目标电平；封装时再跑 loudnorm，把已母带化的 −14.1 LUFS 压成 −14.9（【仓库实证·实测】[craft/video.md §5.8](craft/video.md)）；在共享检出里跑 `audio/mix.py` 或 `sh audio/build.sh`（后者第 9 行调用前者），会重写被跟踪的 `audio/CREDITS`（`audio/mix.py:277`），`npm run build` 也会走到这一步。

**仓库范例**：`keynote-C-kaitou/TREATMENT.md:123-147`（声音表带"材质"列，两处静默与 J/L-cut 写清位置）；`style-65-countdown/TREATMENT.md:98`（低频分频管理，用倍频程能量核对）；`audio/cues.json`（每个镜头写"声场"：远闷宽／近窄干／第一视角最宽）。

### 步骤 9 · 字幕与标题设计

**产出物**：画面文字白名单；字体清单（角色分工、许可、子集）；每段文字的出现方式；读字时长表与例外登记；安全区与版式网格；片名设计。

**判定标准**

- 读字时长：中文停留不少于 字数÷4.5＋1.5 秒；字幕不少于 max(1.8 s, 台词时长＋0.6 s)；标题卡不少于 4 秒（`$甲/DIRECTOR.md §7`）。用检查器实测；刻意的例外逐条登记（`style-21-pictogram-motion/TREATMENT.md:93`：半拍快闪卡只停 6 帧，观众读到的是"多"）。
- 字幕跟着声音起止，不跨切点（[craft/animation.md §5.6](craft/animation.md)）；每行不超过 18 字（`ppt-jianlong/制作规范.md:93-96`）；双语时每种语言一行。
- 安全区、字号、明度对比、中文断行、字幕最长停留与最小间隔，按 [VISUAL-DESIGN.md §6.3](VISUAL-DESIGN.md) 的建议数字核对，并在目标设备上实看【通用工艺·建议】。
- 字体子集覆盖全部字形（缺字会静默回退到系统字体，`engine/overlay/text.js:28`）；在成片尺寸下检查易混字（`style-26-rubber-hose/TREATMENT.md:99` 换掉会把"床"认错的字体；`style-32-microgame/TREATMENT.md:153-155` 粗描边把"住"糊成"任"）。
- 片名属于画面世界：印字砖、屋顶灯箱、按笔顺写出的毛笔字（`style-37`、`style-42:90`、`src/hud.js:282-308`）。画在世界里的字要经过 Kuwahara、纸纹和颗粒；A 路线的读字数据 `window.TEXTS` 只报显示层（`src/hud.js:362-381`），世界内文字要自己投影成屏幕框再交给检查【未实现】。
- 文字不压主体，有底板（`style-52-hologram-hud/TREATMENT.md:137`）。
- A 路线显示层：最后叠加、不经后期、同时最多两行字（`src/hud.js:53`）。

**常见错误**：文字读不出来——`keynote-C-quanpian` 返修表的 12 条里有 7 条是文字可读性问题：被遮挡或出画 4 条（第 3、9、10、12 条），停留不足 2 条（第 5、6 条），字太小 1 条（第 8 条）（`cases/source/keynote-C-quanpian/TREATMENT.md:88-100`），读字检查另记 14 段不合格（`ARCH.md:416`）；打字机效果只报已打出的字，检查器判失败（`$甲/core/README.md:44`）；负号压在翻牌中缝上读成"="（`style-70-news-package/TREATMENT.md:149`）。

**仓库范例**：`style-63-caption-news/TREATMENT.md:132-135`（字幕参数完整到可以直接编码）；`local-sanda-baigujing/TREATMENT.md:64-67`（字幕做成说书人题板，并配可计算的停留时长）；`keynote-C-kaitou/TREATMENT.md:149-154`（12 栏版式网格、缓动曲线、"提前一个八分起动、落在拍上、不弹跳不淡入"）。

### 步骤 10 · 审片与返修

**产出物**：代理审片证据；人工观看记录（审片人、日期、看的版本、意见原话）；返修表；自检表；状态记录。

**判定标准**

- **代理审片（agent 做）**：每 1–2 秒一张联系表，至少看两遍；关键动作做 0.2 秒步长的帧条和 24 fps 连续帧条；切点和分段边界前后至少各 3 帧（`docs/routes/validation-and-rtx.md:321-322`），建议 6 帧；逐帧变化曲线，用来找卡帧、频闪和跳拍（命令见下）；声画对齐图（波形或声谱叠上事件帧号，画图脚本【未实现】）；读字与安全区检查（A 路线检查器【未实现】）。结论只能写"代理检查通过"。这一层的帧条与联系表做法改编自 `$甲/TECHNIQUE.md §8`。
- **人工观看（人做）**：全速、带声、从头到尾，由用户或指定审片人完成，记下原话（`AGENTS.md:38`；`docs/routes/validation-and-rtx.md:324`）。音色与混音好坏同样只能由人判断；agent 只提供响度、频谱、静默电平这些数据。agent 不得替人勾选这一项。
- 技术检查有工具、有数字、有证据路径：帧数、时间戳、尺寸、色彩标签、黑场、代理静帧、切点对照镜头表、响度、哈希（[craft/video.md §6](craft/video.md)）。
- 返修表六列：意见原话｜根因｜改法｜是否动拍点｜改了哪个文件｜复测数字。返修后回改阐述里所有受影响的表。
- 借用了风格库示例的作品，与示例片按七项对照（结构、开场、招牌镜头、运镜路径、配乐形状、结尾、视觉系统），至少四项不同（`$甲/DIRECTOR.md §11` 要求前六项；第七项是本规范新增，因为 `style-17-spy-titles` 的四个色值与示例文件逐字相同，六项对照没发现）。借用的是 C 路线历史作品时，对照对象是它所依据的 `$甲` 示例片（例：`style-62` 对应 `$甲/styles/archive-lighttable` 的示例，见 [SOURCES.md §3](SOURCES.md)）。
- 用户的否定写清维度（色彩、造型、表演、节奏、声音）和"下次必须改什么"。
- 状态三分离：已输出、技术通过、用户认可分别写，各附证据（`docs/routes/templates/render-result.json` 的 `technicalAcceptance` 与 `creativeAcceptance`）。

逐帧变化曲线（全帧差的平均亮度；连续接近 0 是卡帧，孤立尖峰是切点或跳变；只用来找可疑帧，不是通过标准）【通用工艺·建议】，在 FFmpeg 8.0.1 上试跑可用：

```sh
ffmpeg -hide_banner -nostats -i <成片>.mp4 -an -vf "scale=240:-2,gblur=sigma=2,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-" -f null - | grep -o "YAVG=[0-9.]*"
```

先缩小、模糊再比，是为了不让逐帧颗粒掩盖卡帧（[craft/video.md §6](craft/video.md)）。

**常见错误**：审片分数不写审片人（`keynote-B-kaitou/TREATMENT.md:142` 的 7.6 分、`keynote-C-quanpian/TREATMENT.md:83` 的 7.3 分）；agent 在清单里写"已带声看过"——agent 不能实时观看，这一项只能由人填；证据不入档（这批作品在 catalog 里大多只归档了海报，联系表和对拍报告不在库里）；rejected 只留一句"用户不认可"，后来的人学不到东西；返修只改了一张表（`style-55-satellite-briefing` 镜头表改了，逐秒表和 cue map 仍是旧数）。

**仓库范例**：`style-42-tilt-shift/TREATMENT.md:104-112`（现象→根因→改法→实测，查出灯塔光锥在焦外成斑、云影要同时压天空反射）；`style-23-dataviz/TREATMENT.md:126-133`（审片意见→改法→复查实测三列）；`keynote-B-kaitou/TREATMENT.md:142-153`（"卡拍影响"列）；`ppt-jianlong/jianlong/ARCH.md` 第 11–13 节（用户一句"结尾的龙不够有张力"拆成节奏表，换旁白后逐帧比对证明只改了该改的地方）。

**⛔ 关口 4**：成片、代理审片证据和自检表给用户，记下认可或否定的原话。

## 4. 交付前清单

- [ ] 阐述必填节齐全（小样按模板开头的必填表）；H1 只写作品名；阐述里的数字与时间轴一致。
- [ ] 风格帧、造型表与比例对照、色彩脚本条、style-lock 入档；用户对结构、画风、动态预演的确认有记录（⛔1–⛔3）。
- [ ] 时间轴是唯一时间源；所有切点、节拍切换在公倍数帧；拍点帧是结果帧；声画对位按 [craft/animation.md §5.7](craft/animation.md) 的容差表判定。
- [ ] 声音表每一行都真的在混音里（`$甲/DIRECTOR.md §11`）；静默与"最重要的一声"按口径实测；最终 AAC 的响度与真峰值在 ProjectSpec `audio` 的门槛内。
- [ ] 文字全在白名单；读字时长过检或登记了例外；字体子集无缺字；世界内文字另做了可读性检查。
- [ ] IP、品牌、事实、地图按 [VISUAL-DESIGN.md §7](VISUAL-DESIGN.md) 自查；每一件第三方作品、角色、品牌、地图数据都有权利依据，授权证据写进 CREDITS；事实片有 FACTS.md，虚构片写明"无事实陈述"。
- [ ] 成片里没有第三方风格库的署名或水印（`$甲/AGENTS.md:16`；`ppt-jianlong/制作规范.md:170`）；工程的 CREDITS 列全第三方素材和许可；沿用了 `$甲` 代码的文件保留版权与许可声明。
- [ ] 质检命令跑过并判定，不只打印；代理审片证据齐全。
- [ ] 人工全速带声观看：审片人／日期／原话（agent 不填这一项）。
- [ ] 三种状态分开记录，附证据。

## 5. 文档的层级

【仓库实证】发布会片组把上下游写得最清楚：设计原稿 → 共用制作规范（冲突时为准）→ 片段任务 JSON（风格与 brief）→ 阐述 → `timeline.js`（唯一时间源）→ `events.json` → 混音 → cuecheck（`cases/source/keynote-shared/制作规范.md`，该条目的 catalog 状态是 support；`keynote-shared/片段任务.json`；`keynote-C-quanpian/ARCH.md:3`）。新作品照这个顺序放文件：上位规范在前，阐述引用它；数据由时间轴生成；检查读数据。

## 6. 出处与许可

- 本文十步的前五步（接需求、找对标、故事成形、写阐述、证明画风），以及步骤 2、3、5、6、8、10 的判定条目，改编自 `$甲/DIRECTOR.md`（MIT）第 1–8、10–13 节；能力边界速查、步骤 7.5 动态预演、镜头间连续性、代理审片与人工观看的划分、按规模选路径是本规范新增。本仓库 75 份自有阐述（`cases/source/*/TREATMENT.md`）与发布会、PPT 片工程文档用来补证据和反例；其中 66 个 `style-*` 案例本身是按 `$甲` 的方法、在它的固定提交运行时上做的（`THIRD-PARTY.md:10`）。全部为转述，没有复制原文。
- `$甲` = `cases/vendor/lemo-opuscar`（风格库甲，MIT，LemoLab，固定提交 `bebbbe1a`）。本文改编或转述了它的 `DIRECTOR.md` 第 1–8、10–13 节，`TECHNIQUE.md` 第 3、8 节，`MY-STYLES.md` 第 2–4 节，`AGENTS.md:16,34`，`core/README.md:44` 的读字检查规则，`styles/silent-film/DEMO.md:26` 的一条制作记录，`styles/shadow-puppet/STYLE.md:87-91` 的原生手段名，以及 `styles/swiss-motion/STYLE.md` 的设计系统写法（经 `style-16` 间接引用）。随仓库分发时保留 `cases/licenses/LemoLab-MIT.txt`；单独发布本文须附该许可全文。
- `$乙` = `cases/vendor/sy-style-100`（风格库乙，MIT，肖雄 XIAOXIONG，固定提交 `e41dee31`）。本文转述了 `styles/SKILL.md:73-82` 的 10 秒片节奏模板，以及 `industry/README.md:3`"同一风格的几条片子镜头、动效、叙事各不相同"的做法。
- 详细出处、许可与义务见 [SOURCES.md](SOURCES.md)。快照只读，许可证与署名不得删改（`AGENTS.md:51,56`；`THIRD-PARTY.md:32-38`）。
