# 范例索引

> **解决什么**：做某一步之前，先看仓库里谁的写法可以借、谁在这一步栽过——直接打开对应文件的对应行，照着写，避开同样的坑。
> **怎么用**：按 §1 导演十步、§2 画面设计、§3 工艺五章查；每格 2–3 个好例子（路径＋为什么好）和反例（问题＋原因）。不知道从哪看起，先读 §0 的十二份范本。借 C 路线作品的写法或代码前，先查 [SOURCES.md §3](SOURCES.md) 它本身从哪来。
> **状态口径**：`cases/source/` 下的条目，除特别注明外，在 `cases/catalog.json` 里都是 **historical-render——出过片，不等于用户认可**；这里的"好"只评阐述与工程写法。注明 support、experiment 的，按其状态理解。**rejected 的三件只出现在反例栏和 §4，不作任何正面依据。** `src/`、`engine/` 是《北冥》10 秒样片与引擎，样片只有间接认可痕迹（`cases/source/local-beiming-film-9min/docs/画风锁定.md:3`）。
> **来源口径**：66 个 `style-*` 案例是按第三方风格库甲（`$甲`）的方法、在它的运行时上做的；表里"为什么好"说的是本案例的写法，技法本身的出处在标注里给出。
> 本页每条都给出可直接打开的 `文件:行号`，均属【仓库实证】；"可能原因"一律是【推断】。
> 路径缩写：`S/` = `cases/source/`。`$甲` 的展开见文末「出处与许可」。

## 0. 先读这十二份

| # | 文件 | 为什么 |
|---|---|---|
| 1 | `S/keynote-C-kaitou/TREATMENT.md` | 一份阐述把所有该有的都写全了：决定日志、三候选、对标学／不学、带"为什么"的镜头表、写明量化规则的 cue map、带材质列的声音表、12 栏版式网格、IP 自查、全数字自检、两轮返修 |
| 2 | `S/keynote-C-quanpian/ARCH.md` | 多人分章制作的契约：文件所有权、模块接口、时间函数、相机衔接窗口、声音按 id 引用画面事件、每章交稿自查 |
| 3 | `S/style-16-swiss-motion/TREATMENT.md` | 设计系统写成可执行的 token；"例外"在数据和检查两层都建了模；自检节工具与数字齐全。token 逐项来自 `$甲/styles/swiss-motion/STYLE.md`；页面、纸、墨、信号红与 `film.js:4` 一致，**三种灰线里两种已漂移**（`TREATMENT.md:34` 对 `film.js:4`），正好说明"阐述与代码互引"也要核对 |
| 4 | `S/style-23-dataviz/TREATMENT.md` ＋ `FACTS.md` | 事实、推算、示意三分；数据到声音的映射；返修表带"复查实测"列 |
| 5 | `S/style-42-tilt-shift/TREATMENT.md` | 返修按"现象→根因→改法→实测"写，查出 three.js 风格化渲染的几个通用坑 |
| 6 | `S/style-29-pixel-rpg/TREATMENT.md` | 不用简报速度的算术论证；保护色从叙事到实现一以贯之；在解码后的 AAC 上验静默 |
| 7 | `S/style-66-city-symphony/timeline.js` | "每拍帧数"本身就是速度表，渐快渐慢仍全落整帧 |
| 8 | `S/local-sanda-baigujing/TREATMENT.md` | 把媒介手段映射到剧情功能与出现位置，"风格不是滤镜"的示范；字幕做成剧中物件。手段名来自 `$甲/styles/shadow-puppet/STYLE.md:87-91`，刻工、舞台、幕后、幕布合成器取自上游示例（`CREDITS:4-6`） |
| 9 | `S/style-74-isometric-picture-book/TREATMENT.md` | 世界规格、颜色只给"规则"、画框边缘检查、检查放在出视频之前。"强调色只给规则"来自 `$甲/styles/isometric-picture-book/STYLE.md:29` |
| 10 | `S/style-75-printed-long-take/TREATMENT.md` | 风格化三维守则落到着色器：一点红只给一个主体、刀线锁世界坐标、每帧至少三层 |
| 11 | `S/ppt-jianlong/jianlong/ARCH.md` 第 11–13 节 | 用户一句反馈→节奏表→改旁白后逐帧比对的完整闭环 |
| 12 | `docs/作品.md` ＋ `src/toon.js`、`src/look.js` | 北冥导演定调与它落成的参数：两层世界、色彩脚本、帧节奏、灯只给方向 |

## 1. 导演十步

### 步骤 1 · 接需求

| 好例子 | 为什么 |
|---|---|
| `S/keynote-B-kaitou/TREATMENT.md:3-4` | 规格头写满精确数字，并写明上位规范和冲突时以谁为准 |
| `S/style-46-living-screencast/TREATMENT.md:3-4` | 帧率有依据，再按帧率反推 BPM（900/7，每拍正好 14 帧） |
| `S/style-25-dark-keynote/TREATMENT.md:5-14` | 简报与风格规则冲突时，把简报逐条翻译成风格允许的形态 |

另：PPT 或原画转片的开工顺序在 `docs/cases/ppt-animation.md:28-52`（提取→时间轴→空间方法→动作承担信息→声音独立）。
反例：75 份阐述反复引用"分镜总表／分镜条目"，原件不在仓库，偏离理由无法复核。

### 步骤 2 · 找对标

| 好例子 | 为什么 |
|---|---|
| `S/style-48-midcentury-toon/TREATMENT.md:25-34` | 四项全是题材专属，每项在片中找得到对应；规定片中不出现对标名 |
| `S/style-34-silent-film/TREATMENT.md:23-24` | 对标写成帧级可测的表演规则 |
| `S/style-58-white-model/TREATMENT.md:38` | 结构型对标：只学"恒定→加密→掐断→重击"的张力曲线 |

反例：`S/style-44-glass-product/TREATMENT.md:28` 声明不学的构图，在海报 `cases/previews/style-44-glass-product.jpg` 里出现了；`style-55`、`57`、`61`、`62` 的对标全是风格库给的默认参考。

### 步骤 3 · 故事成形

| 好例子 | 为什么 |
|---|---|
| `S/style-52-hologram-hud/TREATMENT.md:8-14` | 候选表四列（结构、开场、结尾、配乐形状），一眼看出高潮位置差在哪 |
| `S/style-58-white-model/TREATMENT.md:16-20,111` | 一句"一天→一米"立概念；实算出的漫堤阈值改写了转折 |
| `S/local-sanda-baigujing/TREATMENT.md:16-23` | 把媒介能力映射到剧情功能与位置（手段名来自 `$甲` 皮影风格的菜单，见 §0 第 8 条） |

另：`S/style-13-halftone-dossier/TREATMENT.md:7-13`（"好处／问题"表，选 A 再改两处防止变成轮播）；`S/style-05-one-line/TREATMENT.md:12`（先定终图再倒推每段小插画的落点）。
反例：《懂你的人》旧版只推拉静图被退回（`docs/cases/ppt-animation.md:50`）；豹变 30 秒塞 7 段（rejected，见 §4）。

### 步骤 4 · 写阐述

| 好例子 | 为什么 |
|---|---|
| `S/keynote-C-kaitou/TREATMENT.md:5-23` | 没人可问时的决定日志，16 条，每条有理由 |
| `S/style-29-pixel-rpg/TREATMENT.md:88` | 偏离简报时把三种方案的误差量化比较 |
| `S/style-02-watercolor/TREATMENT.md:138-143` | "计划与实际"一节，阐述与成片对齐的诚实做法 |

反例（文档与代码漂移）：`S/style-24-iso-infographic/TREATMENT.md:97,100` 对 `timeline.js:13,48`；`S/style-28-scifi-toon/TREATMENT.md:3` 对 `timeline.js:5`；`S/style-43-lowpoly-island/TREATMENT.md:95-96` 对 `mix.py:116,125`；`S/style-64-newsreel/TREATMENT.md:30` 对 `:15`；`S/style-76-circuit-board/TREATMENT.md:15` 对 `src/timeline.js:10`；`S/style-16-swiss-motion/TREATMENT.md:34` 对 `film.js:4`（灰线）；`S/ppt-jianlong/jianlong/TREATMENT.md` 只有 49 行，设计全在别的文件且旁白信息过期。

### 步骤 5 · 证明画风

| 好例子 | 为什么 |
|---|---|
| `S/local-sanda-baigujing/test.js:1` | `?test=model` 用真实合成器渲出全部皮影和关键姿势 |
| `S/style-29-pixel-rpg/test.js:9-19` | 代码版造型表：8 个姿势、走路循环、表情、头像 |
| `docs/routes/beiming-style.md:130-149` | 参考图拆成可观察变量，校准场景，六步对照，每张记全参数 |

反例：纸上江山 E 组技术全过、用户否定；豹变四版主角剪影读错；九分钟只锁文件哈希（均 rejected，§4）。`S/style-71-memphis-diorama/TREATMENT.md:89` 风格帧自查写得好，但 `stills/` 没入档。

### 步骤 6 · 镜头设计

| 好例子 | 为什么 |
|---|---|
| `S/style-41-paper-popup/TREATMENT.md:29,38` | 相机五元组关键帧、换组即硬切；翻页写成物理过程，咬合点每帧绑定 |
| `S/style-43-lowpoly-island/TREATMENT.md:28-39` | 正交视锥高、俯角、方位全是数；相机旋转加光源反向旋转，阴影"走针" |
| `S/style-72-transit-map/TREATMENT.md:50-56` | 2.5D 倾斜相机写倾角、每格像素、光圈 |

另：`S/style-10-paper-lantern/TREATMENT.md:31-43`（一镜到底按段拆）；`S/style-75-printed-long-take/TREATMENT.md:125`（升机路径实测灯笼屏幕 y ≤ 980 px）；`S/ppt-jianlong/jianlong/ARCH.md:122-125`（段落交接帧完全一致，并排两张静帧自检）。
反例：`S/style-60-teardown/TREATMENT.md:115` 用包围盒报主体占比，细长零件被高估；`S/style-66-city-symphony/TREATMENT.md:36` 与 `timeline.json:330` 不一致；`style-26` 表里 8 行、代码 6 个镜头；样片三镜的光向关系（A、C 主光在画左，B 光晕在画右）没有任何文字说明（[craft/two-five-d.md §2.5](craft/two-five-d.md)）。

### 步骤 7 · 节奏与拍点网格

| 好例子 | 为什么 |
|---|---|
| `S/style-66-city-symphony/timeline.js:6-27` | 逐拍帧长速度表，真变速也全落整帧 |
| `S/style-19-blueprint/TREATMENT.md:72-73` | 速度、物理公式、图面标注三者互证；渐慢与延长写成帧网格 |
| `S/keynote-C-kaitou/TREATMENT.md:17,99` | "画面时刻"的定义加统一量化规则，画面与音效共用量化时刻 |

另：`S/keynote-B-kaitou/TREATMENT.md:86`（一次性事件对画面帧、连续节奏型对音乐网格）；`S/style-15-woodcut/tools/cuecheck.py`（画面、帧格、拟音、配乐四方核对，静默窗验 RMS）；`S/ppt-jianlong/jianlong/ARCH.md:69`（画面读声音事件表）。
反例：`S/style-25-dark-keynote/TREATMENT.md:143`（浮点取整晚一帧）；`style-10` 30 fps 下 96 BPM 每拍 18.75 帧，70/94 个事件不落整帧；A 样片 `src/hud.js:49-57` 与 `audio/cues.json` 两处手抄。

### 步骤 7.5 · 动态预演

仓库没有作品把动态预演当成用户关口来做。现成的工作类型是两件技术预演（catalog 状态 previs：`local-tenet-highway-previs`、`local-fast5-train-previs`），只作"预演可以做成什么样"的参照，不是导演流程的范例。

### 步骤 8 · 声音设计

| 好例子 | 为什么 |
|---|---|
| `S/keynote-C-kaitou/TREATMENT.md:123-147` | 声音表带材质列；两处静默、J-cut 与 L-cut 写清位置 |
| `S/style-32-microgame/TREATMENT.md:96` | "最重要的一声"写成工程指标：比全片任何峰值高 ≥2 LU |
| `audio/design.py:3-7` | 汽笛与鲲鸣同一发声器；提示音干声、居中、不进世界混响 |

另：`S/style-65-countdown/TREATMENT.md:98`（低频分频管理）；`S/style-23-dataviz/TREATMENT.md:111-120`（数据→音高与音色）。
反例：多数阐述声称了"最重要的一声"，却没写它靠最响还是靠静默反衬，审片无从核对；A 样片封装后 −14.9 LUFS（[craft/video.md §5.8](craft/video.md)）。

### 步骤 9 · 字幕与标题

| 好例子 | 为什么 |
|---|---|
| `S/style-63-caption-news/TREATMENT.md:132-135` | 字号、颜色、坐标、入场时长、过冲、块间隔全写成数，可直接编码 |
| `S/local-sanda-baigujing/TREATMENT.md:64-67` | 字幕做成说书人题板，停留时长有公式 |
| `src/hud.js:282-308` | 书法片名按笔顺写骨架，只给收笔快的笔画加飞白 |

另：`S/style-21-pictogram-motion/TREATMENT.md:93`（可读性例外显式登记）；`S/style-26-rubber-hose/TREATMENT.md:99`、`S/style-32-microgame/TREATMENT.md:153-155`（为可读性换字体并记原因）；`S/ppt-jianlong/制作规范.md:93-96`（每行不超过 18 字、底部 5% 安全区）。
反例：`S/keynote-C-quanpian/TREATMENT.md:88-100` 返修表 12 条里 7 条是文字被遮挡、出画、停留不足或太小；`ARCH.md:416` 记下 14 段读字检查不合格，返修后没给新的计数；`S/style-70-news-package/TREATMENT.md:149` 负号压中缝读成"="（已修，可当检查项）。

### 步骤 10 · 审片与返修

| 好例子 | 为什么 |
|---|---|
| `S/style-42-tilt-shift/TREATMENT.md:104-112` | 现象→根因→改法→实测 |
| `S/style-23-dataviz/TREATMENT.md:126-133` | 审片意见→改法→复查实测三列 |
| `S/keynote-B-kaitou/TREATMENT.md:142-153` | 返修表带"卡拍影响"列 |

另：`S/style-74-isometric-picture-book/TREATMENT.md:139-155`（返修后实测）；`S/ppt-jianlong/jianlong/ARCH.md` 第 11–13 节（用户原话的闭环）。
反例：`S/keynote-B-kaitou/TREATMENT.md:138-140` 自检只写"见 out/…"，而这些文件没入档；审片分数不写审片人；rejected 只有一句话。

## 2. 画面设计

| 项 | 好例子（为什么） | 反例 |
|---|---|---|
| 画风锁定 | `S/style-12-risograph/TREATMENT.md:31-36`（两版配方＋"一版测试"；"一版测试"来自 `$甲/styles/risograph/STYLE.md:34`，合成器 `riso.js` 大部分沿用上游示例）；`S/ppt-jianlong/制作规范.md:44-48`（每种颜色只给一类东西）；`S/style-16-swiss-motion/TREATMENT.md:34-39`（token 写法可借，但三种灰线有两种与 `film.js:4` 不符，借写法时连"由一处导出"一起借） | 九分钟 `docs/style-lock.json`（锁哈希，rejected）；E 组 `src/style.js`（一组常量，rejected）；`style-17` 色值与示例文件逐字相同 |
| 色彩脚本 | `docs/作品.md:55-65`（五段，每段写色与含义）；`S/style-20-stained-glass/TREATMENT.md:107`（光强剧本，成片亮度量得出来）；`S/style-43-lowpoly-island/TREATMENT.md:118`（保亮度的夜色混合） | 九分钟全片停在破晓色、关灯场整体乘 0.11（rejected，【推断】）；北冥色彩脚本只写了色与含义，没有明度键（VISUAL §2） |
| 风格帧 | `S/local-sanda-baigujing/test.js`；`S/style-29-pixel-rpg/test.js`；`S/style-71-memphis-diorama/TREATMENT.md:89`（对照风格不变量自查） | E 组（技术过、画面被否）；豹变 B／C 版主角剪影与远山误读（`S/local-baobian-film/tools/w2_review_render.js:25`） |
| 明度与剪影 | — （仓库没有作品写出明度差的数字） | 样片鲲一影与天顶的 OKLab 明度差约 0.04，可读性全靠墨线和暖补光（VISUAL §3） |
| 构图与镜头语法 | `S/style-13-halftone-dossier/TREATMENT.md:35`（世界坐标＋单一相机函数）；`S/style-24-iso-infographic/film.js:196`（关键拍去饱和只留主体）；`src/shotA.js:2-4,25-51`（12 层按屏幕像素加深度摆放） | 镜头 A 的 veil 端头与云片截断边进画（[craft/two-five-d.md §5](craft/two-five-d.md)） |
| 镜头间连续性 | `S/ppt-jianlong/jianlong/ARCH.md:122-125`（交接帧一致） | 样片三镜的光向关系没有说明 |
| 分层时钟 | `docs/作品.md:74-84` 与 `src/shotA.js:95-142`；`S/style-07-shadow-puppet/TREATMENT.md:3`（浪片 12 fps、人偶 24 fps）；`S/style-34-silent-film/TREATMENT.md:88`（每拍起点必是一次采样；手摇采样本身来自 `$甲/styles/silent-film/STYLE.md:39-40`） | `src/shotC.js:168` 一拍三停帧里眼珠单独跳；`src/birds.js:26,67` 扑翼混叠 |
| 显示层与字幕 | `docs/作品.md:45-53` 与 `engine/stage/film.js:30-33`；`S/ppt-in-sight/方案.md:12-20`（镜片层与故事层绝不混用）；`src/hud.js:53,131`（同时最多两行字、克制的抖动） | `src/hud.js:8,67` 默认主题是单色绿，复用时不改主题会得到绿色界面 |
| IP 与品牌 | `S/keynote-shared/制作规范.md:25-29`（catalog 状态 support；规则适用于已获授权的 IP）；`S/keynote-seg1-kaijuan/TREATMENT.md:179`（逐帧实测 IP 占比）；`S/keynote-C-quanpian/ARCH.md:227`（IP 卡工厂函数强制）；`S/style-63-caption-news/FACTS.md:11-17`（措辞按证据强度降级） | `S/style-59-data-physical/set.js:37`（高潮珠子变大，FACTS 未披露）；`style-52` 满屏读数未声明虚构 |
| 地图 | `S/style-64-newsreel/TREATMENT.md:123`（不画国界） | 仓库没有作品写全 VISUAL §7.4 的中国地图规则 |
| 画面 QA | `S/style-18-art-deco/tools/motioncheck.py`（成片帧差验证拍点上真的动了）；`S/style-20-stained-glass/tools/statecheck.mjs`（逐帧读画面状态变量）；`S/style-74-isometric-picture-book/tools/edgecheck.mjs`（道具半截入画检查） | 多数作品的联系表、对拍报告没入档，只有海报 |

## 3. 工艺五章

| 章 | 好例子（为什么） | 反例或已知坑 |
|---|---|---|
| [toon](craft/toon.md) | `src/toon.js:14-76`（色板单一来源、灯只给方向、预设分层）；`src/shotC.js:197-210`（色彩脚本写成参数曲线）；`S/style-27-cel-anime-80s/pal.js:34-58`（按光照分套的色指定，肤色手工指定；结构来自 `$甲/styles/cel-anime-80s/demo/pal.js:32-54`） | 原生 4K 下材质内画线被 Kuwahara 抹掉（toon §5.3）；`lab/look.js:35-40` 是测试材质，不能当正片证据；用 HSL 判断阴影饱和度会得出反结论（toon §5.2） |
| [two-five-d](craft/two-five-d.md) | `engine/stage/camera.js:30-38` 与 `src/shotA.js`（先排版再给深度）；`src/shotC.js:43-52`（穹顶解决摇镜变形）；`engine/stage/plates.js:77-86` 与 `src/shotB.js:19-23`（抠像面片让人脸得细笔触）；`S/ppt-jianlong/jianlong/tools/depth.py:1-8` 与 `src/core/plates.js:1-3`（每张图版配一张深度图，手工分层与估计深度融合后引导滤波）；`engine/paint/light.js:52` 与 `src/girl.js:592`（2D 画布层的光包裹） | B 例片页面层天空不随相机旋转（`examples/raea/film.tsx:74`）；`assets/plates/plates.json` 的视差与层级字段和代码不一致；镜头 C 片尾下摇超出硬边速度的经验上限（two-five-d §3.3） |
| [animation](craft/animation.md) | `S/style-34-silent-film/timeline.js:5-75`（段、拍、采样锚点；骨架有 7 行来自 `$甲/styles/silent-film/demo/timeline.js`）；`S/style-66-city-symphony/timeline.js:6-27`（逐拍帧长）；`src/girl.js:284-389`（接触：指尖原点、挂在头部、压入、光、声四条通道） | `src/girl.js:384`（秒数阈值多圈一拍）；`S/style-25-dark-keynote/TREATMENT.md:143`（浮点错拍）；鲲 5 秒游动周期与 0.5 秒眨眼是动物量级，读不出"大"（animation §3.9） |
| [video](craft/video.md) | `S/style-29-pixel-rpg/tools/cuecheck.py:65-69`（在解码后的 AAC 上验静默）；`S/style-74-isometric-picture-book/build.sh:13-17`（检查放在出视频之前）；`S/keynote-C-kaitou/TREATMENT.md:162-177`（自检全给数字和工具名） | A 管线成片 −14.9 LUFS、BT.601 全范围且原色传递未标、软件渲染只告警（video §0） |
| [threejs](craft/threejs.md) | `engine/shade/patch.js:18-27`（锚点缺失即报错、程序缓存键）；`engine/shade/toon.js:260-276` 与 `engine/stage/outline.js:9-25`（形变在彩色、投影、墨线三处一致）；`src/kun.js:519-534`（阴影相机每帧贴合主体） | `src/kun_peng.js:900-904` 裸 `replace` 绕过锚点检查；`src/shotA.js:85` 鸽群画布没乘 K；`src/kun.js:531` 的 `radius` 在 PCFSoft 下不起作用 |

运动模糊的写法可以参照三件 C 路线作品（A 路线都【未实现】）：`S/keynote-B-kaitou/main.js:583-590`（按屏幕速度取 4–20 个子采样）；`S/style-52-hologram-hud/film.js:432-440` 与 `S/style-77-desktop-flythrough/src/main.js:39-50`（这两段代码来自 `$甲` 示例，见 SOURCES §3）。

## 4. 被否作品的技术备忘（不作范例，不可作依据）

仓库对这三件只记了一句"用户不认可"，没有原话、日期和否定维度。下表只陈述事实与【推断】的原因，**不评价、不推荐其中任何写法**；需要类似做法时，从 §1–§3 的非 rejected 案例或【通用工艺】里找依据。

| 作品 | 记录 | 可能原因【推断】 | 技术事实（只作备忘） |
|---|---|---|---|
| `local-beiming-film-9min` 北冥九分钟 | `cases/entries/local-beiming-film-9min.md:5`：技术上输出了 540 秒影片，用户不认可效果 | 锁数值不锁规则，色彩脚本丢失（`docs/style-lock.json:2-12`）；镜头单调，大量镜头共用固定机位（`src/storyboard.js`；`src/world.js:18-19`）；两秒的侧脸资产被反复使用；合成配音 | 分镜里有"文字描述不等于动画已实现"的自我约束（`docs/分镜表.md:11-13`）；音量驱动口型只能粗同步（`README.md:43`） |
| `local-baobian-film` 豹变四版 | `cases/entries/local-baobian-film.md:11` | 内部六维评分（≥8 才交付）与用户判断脱节；主角剪影读错物种、远山读成富士山（`tools/w2_review_render.js:25`）；30 秒 7 段过密；参考语法压过可读性 | 设计文件围绕第三方受版权保护的动画作品写成：参考图逐张取自这些作品的静帧（`films/A_shuimo/STYLE.md:1-3`；`films/A_shuimo/DESIGN.md:7`），规则从参考图实测得出。工作规范称参考静帧已获版权方授权（`SUBAGENT_STANDARD.md:39`），但仓库里没有授权文件；即便有，也只限该项目。**新作品不得调用 `refs/` 或其裁切图，不得复用针对具体作品的规则（人物画法、具体场景）** |
| `lab-2026-11-05-e-paper-15s` 纸上江山 E 组 | `cases/entries/lab-2026-11-05-e-paper-15s.md:11`：用户明确不认可这一版的画面方向 | 低饱和灰绿＋全面减弱的后期丢了原版粉紫暖金和厚笔触的辨识度；底板是约 2400 px 实验图放大到 4K（`S/lab-2026-11-05-e-paper-15s/README.md:42`） | 技术检查全部通过（`delivery/verification.json`），用户仍否定画面方向——"技术通过不等于好看"的直接证据 |

## 5. 不能直接照搬的写法

- **改编自上游示例却没做示例对照**：`style-62-archive-lighttable`《十二秒》的题材（同一次首飞的玻璃负片与电报）、道具、开场、"放大镜抬起 1.35"、签名镜头"镜圈长出画面进入照片"都沿用 `$甲/styles/archive-lighttable` 的示例片（`DEMO.md:7,23-24,31-32`，MIT）；`film.js` 579 行里 166 行与上游 `demo/film.js` 逐字相同。示例页要求不复用示例的故事、镜头、道具和时值（`DEMO.md:3`），本案例没有做示例对照，CREDITS 却写"原创"。引用它的代码时，按上游文件的行号注明出处并保留版权与许可声明（`THIRD-PARTY.md:36`）；它不作导演写法的模板。修正 catalog 的派生标记和该案例的 CREDITS 需另开任务（本规范只读，不改历史文件）。
- **复用了上游示例代码却没做对照**：`local-sanda-baigujing` 的刻工、舞台、幕后、幕布合成器取自风格库示例（`CREDITS:4-6`），没有与示例片的差异核对；`style-27-cel-anime-80s/cel.js` 除首行注释外与上游 `demo/cel.js` 相同，因哈希不同没被 catalog 标成上游文件；`style-77-desktop-flythrough/src/main.js` 68 行里 48 行与上游示例相同。
- **只引用了未入档证据**：阐述写"见 out/…"或 `stills/`，catalog 里没有这些文件（`keynote-B-kaitou`、`keynote-C-kaitou:183`、`style-71`、`style-72`）。
- **catalog 的 `upstreamStyle` 为空但实际有来源**：发布会片组、`local-sanda-baigujing`、`ppt-jianlong` 的风格来源写在规范或 CREDITS 里，按风格检索会漏掉它们。
- **历史源文件里有对外不该出现的名字**：部分 PPT 片的方案与台词文件含品牌名，部分阐述正文点名了上游库或 TTS 服务商（例 `S/lab-2026-11-05-e-paper-15s/TREATMENT.md:13`、`S/keynote-C-quanpian/ARCH.md:17,413`、`S/ppt-jianlong/jianlong/TREATMENT.md:39`）。引用时只给路径，不复述原文。

## 6. 出处与许可

本索引只指向本仓库文件。§4 引用的 `films/`、`docs/`、`src/`、`README.md`、`SUBAGENT_STANDARD.md` 都在对应的 `cases/source/<作品 id>/` 下。`$甲` = `cases/vendor/lemo-opuscar`（风格库甲，MIT，LemoLab）：本文在标注里指出了若干范例的 `$甲` 来源（`styles/swiss-motion`、`risograph`、`cel-anime-80s`、`silent-film`、`shadow-puppet`、`archive-lighttable`、`hologram-hud`、`desktop-flythrough` 的风格说明或示例代码），全部来源见 [SOURCES.md §3](SOURCES.md)。
