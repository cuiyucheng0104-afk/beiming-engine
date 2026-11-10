# 出处、许可与引用声明

> **解决什么**：列出这套规范用到的全部第三方方法、文件、章节与许可，写清哪些是改编、引用方式和使用义务。其他文件正文里出现的 `$甲`、`$乙` 都在这里展开。
> **怎么用**：引用第三方做法前先查 §2，看清许可与义务；借 C 路线历史作品的写法或代码前先查 §3，弄清它本身从哪来；写新文档时照 §0 的纪律。

## 0. 声明与纪律

1. **方法来源是改编，不是巧合一致**。导演十步的前五步（接需求、找对标、故事成形、写阐述、证明画风），以及步骤 2、3、5、6、8、10 的判定条目，改编自 `$甲/DIRECTOR.md`（MIT）第 1–8、11–13 节；阐述模板的八项骨架改编自其第 4 节；style-lock 的分项改编自 `$甲/styles/_template/STYLE.md` 的十一节；作品工程描述里 `events.json` 的 `{dur, ev}` 外形与页面约定（`window.EV`、`window.TEXTS`、`timeline.js` 的"段，拍"写法）沿用 `$甲/core/render/events.mjs:9-10`、`$甲/TECHNIQUE.md` §2–§3（第 38–42、84–93 行）和 `$甲/core/README.md:24-26`。本仓库作品用来补证据、补数字、提供反例。被引的 66 个 `style-*` 案例本身就是按 `$甲` 的方法、在 `$甲` 的固定提交运行时上做的（`THIRD-PARTY.md:10`；`cases/catalog.json` 里这 66 个案例的 `requirements` 都写明依赖该运行时，`upstreamStyle` 都不为空）。凡改编之处，在出现处标 `$甲/文件 §节` 或 `$甲/文件:行`，内容是用自己的话转述。
2. **原文引用**：本规范没有直接引用第三方原文。研究稿里有过五处短引或近似原文（`$甲/styles/cel-anime-80s/STYLE.md:10`、`$甲/TECHNIQUE.md:67` 两句英文；`$乙/AGENTS.md:14` 一句中文；`$甲/styles/woodcut/STYLE.md:10` 一句的中译；`$乙` 同一句的变体），定稿时都改写成了转述，并保留文件与行号。
3. **代码**：规范里的代码片段是本仓库自写的建议写法，没有复制第三方代码；其中 `timeline.js` 的"段＋拍"结构沿用 `$甲/TECHNIQUE.md` §3 的写法。工艺手册提到风格库甲渲染核心里的工程防护（输出锁、残留清理、信号处理、静音处理、BT.709 开关、读字检查），只作对照。**C 路线历史作品里有逐字来自 `$甲` 示例的代码**（见 §3），借用它们等于借用 `$甲` 的代码：保留 LemoLab 的版权与 MIT 许可声明和派生说明（`THIRD-PARTY.md:36`）。
4. **画面**：没有嵌入第三方示例影片或剧照。风格库甲的示例影片与剧照是 CC BY 4.0，日后引用要署名 LemoLab、附该仓库链接与许可链接，并注明改动（`$甲/README.md:387`）。
5. **命名**：第三方风格库名、作者名只出现在各文件的「出处与许可」段落和本文；正文用 `$甲`、`$乙`。对外名称遵守 `AGENTS.md:3`：北冥风格路线 · WebGL 三渲二、北冥原生路线 · BNE、北冥代码动画风格 · 86 式；`raea` 是上游项目名（内部目录沿用），`cases/vendor` 是第三方快照目录，都只用于定位文件。作品站生成器把这些名字与第三方库名列为页面禁用词（`tools/build-showcase.py:88`）。入库前用 `python3 tools/check_directing_docs.py <规范目录>`（随本规范提交，见 [README](README.md)）检查命名与路径。
6. **快照只读**：不就地修改 `cases/vendor/`；不删改 `LICENSE`、`cases/licenses/` 与 vendor 目录内的许可文件和署名（`AGENTS.md:51,56`；`THIRD-PARTY.md:32-38`）。
7. **随仓库分发**：本规范包含对 MIT 文档的改编。随本仓库分发时，`cases/licenses/LemoLab-MIT.txt` 与 `cases/vendor/lemo-opuscar/LICENSE` 已在仓库里；把本规范单独拿出去发布时，必须附上该 MIT 许可全文和 LemoLab 的版权行。

## 1. 第三方来源一览

| 缩写 | 位置 | 上游与固定提交 | 许可 | 许可文件 | 义务 |
|---|---|---|---|---|---|
| `$甲` 风格库甲 | `cases/vendor/lemo-opuscar` | lemomo-ai/lemo-opuscar `bebbbe1aa92a3cb4bb6f83500e61b23a17d1aa00` | 代码与文档 MIT，Copyright (c) 2026 LemoLab；示例影片与剧照 CC BY 4.0；示例里的第三方素材各自保留许可；三条配音轨不在 CC BY 4.0 范围内（`$甲/README.md:382-392`） | `cases/vendor/lemo-opuscar/LICENSE`；`cases/licenses/LemoLab-MIT.txt` | 保留许可与署名；改编文档、移植代码都保留派生说明；引用示例画面署名 LemoLab、附仓库链接与许可链接并注明改动；用户用它做的片子不带库方署名与水印（`$甲/AGENTS.md:16`） |
| `$乙` 风格库乙 | `cases/vendor/sy-style-100` | xiaoxiong20xx-code/sy-style-100 `e41dee31a5c05dffa12b2f241378e648d2a22df6` | MIT，Copyright (c) 2026 肖雄 XIAOXIONG | `cases/vendor/sy-style-100/LICENSE`（`vol2/LICENSE` 相同）；`cases/licenses/XIAOXIONG-MIT.txt` | 保留版权与许可声明；作者另外请求转载或二次分发时保留作者署名（`$乙/README.md:23`）；示例画面里带作者署名，`make.js brand` 命令可替换，但不覆盖 `industry/` 下的 6 个文件 |
| three.js | `node_modules/three`（不进 git） | 0.170.0（`package.json:26`；`package-lock.json:28-32`） | MIT | `cases/licenses/three-MIT.txt`；`THIRD-PARTY.md:21` | 保留声明 |
| playwright-core | `node_modules` | 1.63.0（`package-lock.json:16-20`） | Apache-2.0 | 随包 | 渲染脚本驱动无头浏览器用 |
| 原生运行时 | 不在仓库 | 固定版本 `0.1.0-canary.2`（`examples/raea/tools/render.mjs:14`），源码快照见 `docs/raea/architecture.md` | FSL-1.1-ALv2（`THIRD-PARTY.md:11`） | — | 不在本仓库分发，单独取得；**含 Competing Use 限制**（不得用于与许可方竞争的用途），两年后转为 Apache-2.0；B 路线做商用交付前先核对条款 |
| 字体（A 路线） | `fonts/` | Barlow、Noto Sans SC、Ma Shan Zheng 的子集（`src/hud.js:32-42`） | SIL OFL 1.1 | `fonts/LICENSE.md`（含 OFL 1.1 全文与各字体版权行） | 按用字子集化、本地托管；不单独出售字体 |
| 字体（C 路线案例） | 各案例 `fonts/` | 各案例自带 | 多为 SIL OFL 1.1 | 各案例 `fonts/OFL-*.txt` 或 `fonts/LICENSE.md`（例 `cases/source/style-18-art-deco/fonts/OFL-zcoolxiaowei.txt`） | 借用前核对该案例的许可文件 |
| 底板生成工具 | — | Midjourney V8、GPT Image 2.5（`assets/plates/plates.json:3`；`docs/作品.md:94`） | 各工具服务条款 | — | 《北冥》影片、底板、展示图保留所有权利，代码许可不授权直接使用（`THIRD-PARTY.md:18`；`docs/raea/architecture.md:189`） |

## 2. 本规范改编或转述的第三方方法

### 2.1 风格库甲（`$甲` = `cases/vendor/lemo-opuscar`，MIT）

| 用在本规范哪里 | 第三方文件与章节 | 要点（转述） |
|---|---|---|
| DIRECTING 步骤 1 | `DIRECTOR.md` §1（第 9–24 行） | 一次问清；给出默认片长、画幅、帧率、语言与响度；用户自有素材优先，下载外部素材前说明来源与许可 |
| DIRECTING 步骤 2 | `DIRECTOR.md` §2（第 26–33 行） | 选 1–2 部对标，分"学什么／不拿什么"；对标对质量的提升大于后面任何一条规则 |
| DIRECTING 步骤 3 | `DIRECTOR.md` §3（第 35–41 行） | 一个主体、一个目标、一个转折；前 3 秒钩子；结尾呼应；只有这种媒介能做的一下放在情绪峰值；读不懂就删 |
| DIRECTING 步骤 4、阐述模板 | `DIRECTOR.md` §4（第 43–54 行）；`$甲/AGENTS.md:34` | 阐述八项（三候选、一句话与弧线、对标、镜头表、逐秒节拍表、拍点表、声音设计表、字幕与片名）；第一个想到的结构往往是套路；写完三候选再看示例 |
| DIRECTING 步骤 5；VISUAL §3 | `DIRECTOR.md` §5（第 56–65 行）；`MY-STYLES.md` §4（第 99 行起） | 有角色出造型表加两张风格帧，无角色出三张风格帧，都用真实绘制代码；改风格时出原风格与新风格的同帧对照；用户要分镜时出联系表并等确认 |
| DIRECTING 步骤 8 | `DIRECTOR.md` §6（第 67–73 行） | 动作配声、三层、至少两处真静默、静默后第一声专门选、至少两次声音转场（本规范按北冥定调改写了"每个动作都有声"，见 DIRECTING 步骤 8） |
| DIRECTING 步骤 7、9 | `DIRECTOR.md` §7（第 75–85 行）；`core/README.md:44` | 先写拍点表再做动画；快慢交替、要有一次加速或减速和一次喘息；字幕与标题的最短停留与中文读字公式；读字检查从文字第一次出现起计 |
| DIRECTING 步骤 6；VISUAL §4.1、§4.3 | `DIRECTOR.md` §8（第 87–92 行）；`styles/_template/STYLE.md` §6（第 38–49 行） | 运镜要有变化、一个招牌镜头、转场在媒介内完成且成套、关键时刻主体够大；运镜词汇三列、不规定开场高潮结尾用哪招（本规范把"至少四种运镜""主体至少占画高 1/3"改写成可判定、不偏向某种风格的版本） |
| craft/animation | `DIRECTOR.md` §9（第 94–102 行）；`TECHNIQUE.md:67`；`core/lib.js:9,17-18` | 预备—动作—跟随；姿态用关键帧与缓动混合，不在条件分支里硬切；人物可步进而镜头和光平滑，步进的镜头会被读成卡顿；回弹缓动与单调三次插值 |
| DIRECTING 步骤 10、交付清单 | `DIRECTOR.md` §11（第 113–132 行）；`TECHNIQUE.md` §8（第 124–129 行） | 审片循环、一轮修完；与示例片按六项比较至少四项不同（本规范加了第七项"视觉系统"）；声音设计表每行都要在混音里；检查成片无库署名；联系表、关键动作帧条、带声全速看一遍（本规范把"看一遍"拆成代理审片与人工观看） |
| VISUAL §7.1、§7.4 | `DIRECTOR.md` §12（第 134–138 行） | 参考只学语法；用户没有权利的作品、品牌、角色、事件不进片，否则画虚构替身 |
| VISUAL §7.4 地图 | `DIRECTOR.md` §13（第 140–149 行） | 地图默认不画边界；中国入画必须画全；默认边界数据不能用来画中国；文字口径同地图；交付前放大核对，CREDITS 写明地图数据与视角 |
| DIRECTING 步骤 3 | `styles/silent-film/DEMO.md:26` | 复杂版本缩成缩略图读不懂，宁可删也不加 |
| DIRECTING §2、步骤 5 | `MY-STYLES.md` §2（第 55–59 行） | 改库风格时把各节分成"可放心改／改了会变性格／不能改"三组 |
| PRODUCTION-SPEC 原则 2、§4 | `TECHNIQUE.md` §2–§3（第 38–42、84–93 行）；`core/render/events.mjs:9-10`；`core/README.md:24-26` | 一份时间线驱动画面、配乐、混音、字幕和核对，事件写成"段，拍"，核对到 0 ms；页面导出 `window.EV`，工具写出 `{dur, ev}`；`window.TEXTS(t)` 报告每一时刻的文字与方框 |
| craft/video | `TECHNIQUE.md` §2（第 33 行起）、§6（第 113–117 行）；`core/render/video.mjs`、`mux.sh`、`readcheck.mjs`、`slot.mjs`、`browser.mjs` | 页面契约与确定性；颗粒画面的编码建议；渲染核心的工程防护（只作对照） |
| VISUAL §1 | `styles/spy-titles/demo/paper.js:5-6` | 用来核对 `cases/source/style-17-spy-titles` 的色值来源 |
| VISUAL §7.3、§7.4 | `styles/hd-2d/STYLE.md:5`；`styles/city-symphony/STYLE.md:108` | 风格名是商标时只作描述；可识别的普通人不做慢动作主体 |
| VISUAL §3 | `styles/woodcut/STYLE.md` 第 1 节（第 6–12 行） | 浮雕版画的三条物理规则：墨色是留下的木面、白是刻掉的部分，亮处靠多刻；画面是刻出来的；版是镜像，揭纸才回正 |
| templates/STYLE-LOCK | `styles/_template/STYLE.md`（第 18–72 行，十一节） | 风格不变量分成固定编号的十一节（本质与不是什么、材质与渲染、色彩逻辑、字体、运动、镜头词汇、声音调色板、原生招式、陷阱、引擎、变化空间）；本规范的分项由此改编 |
| craft/toon | `styles/cel-anime-80s/STYLE.md` §1–§3、§9 | 每套光照一份色指定、线用填充色的深色版而不用纯黑、肤色每套单独给、边缘光宽度控制 |
| C 路线范例 | 见 §3 | 各范例技法的 `$甲` 来源 |

### 2.2 风格库乙（`$乙` = `cases/vendor/sy-style-100`，MIT）

| 用在本规范哪里 | 第三方文件与位置 | 要点（转述） |
|---|---|---|
| DIRECTING 步骤 3 | `styles/SKILL.md:73-82` | 10 秒片的节奏模板：第一帧就有主体、4.5 秒钩子、约 6.5 秒出片名、动画时间写成常量表 |
| DIRECTING 步骤 3 | `industry/README.md:3`；`AGENTS.md:47-49`（行业示例一节） | 同一风格的几条片子画风统一，镜头、动效、叙事各不相同 |
| VISUAL §3 | `AGENTS.md:10-14`（第一节"质量标准"） | 动手造一种风格之前，先弄清它在现实里对应什么材料和工序，再照那套工序去造 |

研究阶段还读过它的风格注册表（`comp/meta.js`）、出片管线（`make.js`、`render.js`）与声音系统（`audio/synth.py`），本规范正文没有引用。

### 2.3 标准、算法与通行规范

以下都是【通用工艺】的依据，不声称仓库已实现。

| 用在哪里 | 来源 | 用途 |
|---|---|---|
| craft/animation §5.7；DIRECTING 步骤 7 | ITU-R BT.1359（声画同步的可察觉阈：声音超前约 45 ms、滞后约 125 ms）；EBU R37（端到端声画容差 +40／−60 ms） | 同步容差表为什么不对称、为什么生产环节要给播放链留余量 |
| craft/video §5.8；DIRECTING 步骤 8 | ITU-R BS.1770、EBU R128 | 积分、短期（3 s）、瞬时（400 ms）响度与真峰值的测量口径 |
| craft/video §4 | ITU-R BT.709、BT.601 | YUV 矩阵、范围与标签 |
| VISUAL §6.3 | EBU R95、SMPTE ST 2046-1（安全区）；W3C《中文排版需求》clreq（避头尾）；WCAG 2.x（对比度量级）；流媒体平台字幕规范（字幕时长、间隔、切点吸附，以平台原文为准） | 版式与字幕的建议数字 |
| craft/toon §5.2；VISUAL §2–§3 | OKLab／OKLCH（Björn Ottosson，2020） | 感知均匀的明度、彩度、色相，用来查阴影是否发灰、主体与背景的明度差 |
| craft/toon §9、craft/threejs §10 | Papari 2007（广义 Kuwahara）；Mikkelsen 2010（无切线凹凸）；Jarzynski & Olano 2020（PCG 整数哈希） | 引擎源码注明的算法出处（`engine/look/kuwahara.js:1`；`engine/shade/util.glsl.js:10`；`engine/look/glsl.js:2`） |

## 3. C 路线范例的第三方来源

C 路线历史作品是"按 `$甲` 方法、在 `$甲` 运行时上做的本仓库作品"。本规范引用它们时，下表是已经逐项核对过的技法与代码来源；表外的 `style-*` 范例，技法也多出自对应风格的 `$甲/styles/<风格>/STYLE.md`，引用前自行对照。`cases/catalog.json` 只给 45 个案例中 137 个与上游逐字相同的文件打了 `upstream` 标记；改过一行（哪怕只是注释）的文件就不会被标出，所以没有标记不等于原创（`cases/NOTICES.md` 第 2 条）。借代码前先查 `upstream` 字段，再与 vendor 文件逐行对照。

| 范例 | 技法或代码的 `$甲` 来源 | 本案例自己的部分或问题 |
|---|---|---|
| `style-62-archive-lighttable`《十二秒》 | 题材（同一次首飞的玻璃负片与电报）、道具、开场（灯台闪亮）、"放大镜抬起 1.35"、签名镜头"镜圈长出画面进入照片、飞机层前漂"都沿用示例片《差两秒》（`$甲/styles/archive-lighttable/DEMO.md:7,23-24,31-32`）；`film.js` 579 行里 166 行与 `$甲/styles/archive-lighttable/demo/film.js` 逐字相同（例 `film.js:96-101` ↔ 上游 `:124-129`；`toW`、`w2s` ↔ 上游 `:48,99`）；"进入照片后推轨加视差"是 `$甲/styles/archive-lighttable/STYLE.md:77` 的原生招式；字体分工（等宽给目录号与读数、无衬线给标签、衬线只给标题）来自同文件第 41 行 | 示例页要求不复用示例的故事、镜头、道具和时值（`DEMO.md:3`），本案例没有做示例对照，阐述里也没有"与示例片对照"一节；CREDITS 写"原创"。**不作正面模板**，只在 EXEMPLARS §5 登记为问题 |
| `style-16-swiss-motion` | 网格（12 栏、边距、栏距、基线）、两条曲线、无阴影无颗粒、擦除入场、例外元素线性不吸附且读数"在网格→离网格"、大数字光学左齐，逐项对应 `$甲/styles/swiss-motion/STYLE.md:17,19,34,40,42,45`；`film.js:9-12` 与 `$甲/styles/swiss-motion/demo/ease.js:7-10` 逐字相同 | 把这些写成阐述里的 token 并与代码互引（页面、纸、墨、信号红一致；三种灰线中两种已漂移，见 EXEMPLARS） |
| `style-12-risograph` | "一版测试"来自 `$甲/styles/risograph/STYLE.md:34`；合成器 `riso.js` 163 行里 121 行与 `$甲/styles/risograph/demo/riso.js` 逐字相同 | 改成两版油墨与新纸色；第三色只出现两次的叙事用法 |
| `style-27-cel-anime-80s` | `pal.js` 的 `mul`／`LIGHTS`／`palette()`／`PAL` 结构与"肤色每套手指定"来自 `$甲/styles/cel-anime-80s/demo/pal.js:32-54`（12 行逐字相同，文件头注释是上游英文注释的中译）；`cel.js` 除首行注释外与 `$甲/styles/cel-anime-80s/demo/cel.js` 逐字相同 | 四套光照的具体系数与主角强调色 |
| `style-34-silent-film`《追帽子》 | 手摇采样与"速度就是情绪"（散步、追逐、狂奔换采样率）来自 `$甲/styles/silent-film/STYLE.md:39-40`；`timeline.js` 有 7 行、`film.js` 有 33 行与上游示例逐字相同 | 本片的故事、笑点与逐拍落字 |
| `style-10-paper-lantern` | "深度＝距离"的分层行进来自 `$甲/styles/paper-lantern/STYLE.md:88` | — |
| `style-74-isometric-picture-book` | "强调色只给规则"来自 `$甲/styles/isometric-picture-book/STYLE.md:29` | 本片的世界规格与画框边缘检查脚本 |
| `style-77-desktop-flythrough` 的颜色 | 紫给此刻最重要的、绿只给成功、红只给失败，以及这组色值，来自 `$甲/styles/desktop-flythrough/STYLE.md:31,35` | — |
| `local-sanda-baigujing`《三打白骨精》 | 原生手段名（灯即世界、离布变虚、绕到幕后、镂空透光、手持）是 `$甲/styles/shadow-puppet/STYLE.md:87-91` 菜单里的条目；刻工、舞台、幕后、幕布合成器取自上游示例（`cases/source/local-sanda-baigujing/CREDITS:4-6`） | 把菜单条目映射到本片的剧情功能与出现位置 |
| `style-77-desktop-flythrough` | 按相机角速度自适应的快门、子帧累积与 Halton 抖动，以及把世界内文字投影成屏幕框交给读字检查，与 `$甲/styles/desktop-flythrough/demo/src/main.js` 基本相同（`src/main.js` 68 行里 48 行逐字相同） | — |
| `style-52-hologram-hud` | 甩镜内 5 子帧、180° 快门、显示层只画一次的运动模糊，来自 `$甲/styles/hologram-hud/demo/film.js:112-121` | — |
| 作品工程描述的 `events.json` | `{dur, ev:[{t, type, …}]}` 是 `$甲/core/render/events.mjs:9-10` 的输出格式；`window.EV`、`window.TEXTS`、`timeline.js` 的 `SECS`／`HIT`（段，拍）和 cuecheck 是 `$甲/TECHNIQUE.md:38-42,84-93` 与 `$甲/core/README.md:24-26` 规定的页面约定 | 本稿新增的 `id`、`frame`、`beat`、`domain` 等字段与校验规则 |

本表只列本规范引用到的范例，不是全量清单。逐字对照的方法：取案例文件与 `cases/vendor/lemo-opuscar/styles/<风格>/demo/` 下同名文件，比较去掉首尾空白、长度不少于 16 字符的行。

## 4. 本仓库自有材料的权利

- 自有代码按根 `LICENSE`（MIT）；《北冥》影片、底板、展示图保留所有权利（`THIRD-PARTY.md:17-18`）。
- 历史 PPT 原画、设定、品牌标识、演员配音、生成音乐、影片和素材包只作展示与学习参考，归档不额外授予商业复用权（`cases/NOTICES.md:9`）。本规范引用这些作品只为说明方法。
- 历史风格项目使用、复制或改写过风格库甲的模块；能逐字核对的文件，`cases/catalog.json` 的 `upstream` 字段给出固定提交和路径；没有该字段不等于证明完全原创（`cases/NOTICES.md` 第 2 条；本文 §3）。
- 新作品里出现的任何第三方作品、角色、品牌、事件或地图数据，都要有权利依据（用户拥有或书面授权），授权证据写进 CREDITS 和阐述 §2；没有就画虚构替身（`$甲/DIRECTOR.md` §12；VISUAL §7）。历史作品的授权只限那个项目，不随归档转给新作品。

## 5. 研究期材料（未入库）

本规范定稿时有一批研究期的核算脚本、静帧、日志和专家手册原稿放在会话的临时目录里，没有进入仓库，正文用 `<研究工作区>` 指代。入库前的规则：

- 正文里凡是只能靠 `<研究工作区>` 复核的数字，都已在出现处给出可在仓库根重跑的命令；给不出命令的，已降为【推断】或删去。
- 研究期还用过本机的历史原片做过几项测量（声音峰值、近静默电平、开场主体占比），这些数字仓库里无法复核，定稿已全部删去，相关规则只保留做法。
- 研究期还见过一份分镜条目原件（`storyboards.json`），许可与隐私未核对，本规范不引用其内容。
- 建议把仍有价值的核算脚本整理成只读仓库、不写文件的工具，随规范放进 craft 目录下的 `tools/`，再把正文的 `<研究工作区>` 换成仓库路径【未实现】。
