# beiming-original@v1 · 《北冥》认可画面参照

读者｜延续北冥画风的新作品、做风格校准的 agent、审片人　状态｜已登记（darwin-metal），**认可状态待用户确认**　登记提交｜`c49da14`（routes-template，含 main 62ad28e）　清单｜[darwin-metal.json](darwin-metal.json)　关键帧｜登记 [keyframes.json](keyframes.json)（PNG 不入库，在 darwin-metal 上本机重建）

《北冥》10 秒样片的画风，冻结成 20 张无损帧。新片说「延续北冥画风」，look 闸门（D08）就拿它的关键帧并排对照；引擎改动想知道「北冥原本的样子」变没变，也和它比。它不随代码走：代码有意改了画面，回归金标准跟着更新，这一份不动。规则见 [../POLICY.md](../POLICY.md)。

## 二十帧

六个关键时刻，各一张带显示层、一张不带（`?nohud=1`，纯画面）。`film.json` 里镜头的 `lookPreset` 写 `beiming-original@v1/<名字>`，对照的是**不带显示层**的那张。

这六张不带显示层的帧（1920×1040 原样 PNG，每张 2.7–3.0 MiB，共约 17 MiB）是渲染产物，按 D10 **不入库**。仓库里只有登记 [keyframes.json](keyframes.json)：每张对应的帧编号、像素哈希（与 [darwin-metal.json](darwin-metal.json) 里的同名帧相同）和首次导出时的 PNG 字节哈希。

要看图，在 darwin-metal（Apple 芯片的 Mac，与登记时同一版无头浏览器）上跑一次 `node tools/baseline/golden.mjs keyframes --reference beiming-original@v1`：工具现渲登记提交，逐张核对像素与清单完全一致后，写到 `out/style-baselines/beiming-original@v1/keyframes/<名字>.png`（`out/` 不入库）。别的平台渲不出逐位相同的像素，工具会拒绝（`env.no-reference-platform` 或 `contract.reference-drift`）。要给没有这类设备的人看，只能作为 Release 附件分发（公开动作，先经用户授权），下载后按登记里的字节哈希校验。规范检查 `baseline.references` 核对登记与参照清单一致，`baseline.no-render-products` 拒绝把这些 PNG 提交进仓库。

| 名字（关键帧图） | 时刻 | 镜头 | 画面 | 看什么 |
|---|---|---|---|---|
| `wide` | 1.5 秒 | A 远景 | 外滩与陆家嘴的天际线浮在黎明云海上，鲲背像一座岛从云里露出，江面上渡船与鸽群 | 底板与 3D 的融合、空气透视、云的水彩边 |
| `wide-out` | 2.95 秒 | A 末拍 | 同一远景，鸽群飞散，切镜前一拍 | 运动中的一拍二墨线、鸟群剪影 |
| `figure` | 4.0 秒 | B 人物近景 | 女孩侧脸剪影、眼镜、手指触镜腿，橙粉渐变天空 | 2D 手绘人物：墨线粗细、轮廓光、纸纹 |
| `eye` | 5.3 秒 | C 特写 | 第一视角，鲲眼从云里露出，显示层时间 05:54 | 卡通分档、眼睛高光、显示层的克制 |
| `underside` | 7.6 秒 | C 仰拍 | 鲲腹从头顶滑过，藤壶、海藻、海葵，显示层卡片与导航线 | 三渲二主体：分档、描边、Kuwahara 笔触、颗粒 |
| `title` | 9.6 秒 | C 片尾 | 毛笔片名「北冥」，鲲尾离开，远处天际线 | 片名笔触、片尾日光 |

另有八张：

| 名字 | 内容 | 看什么 |
|---|---|---|
| `4k/paper-sky` | 原生 3840×2080，1.5 秒，从 (1900, 60) 起 1280×720：鲲背与上海中心顶部 | 4K 下纸纹、云边、建筑墨线 |
| `4k/ink-figure` | 原生 4K，4.0 秒，从 (1000, 500) 起 1280×720：眼镜、耳廓、手指 | 4K 下人物墨线与轮廓光 |
| `4k/texture-kun` | 原生 4K，7.6 秒，从 (1500, 300) 起 1280×720：鲲眼、海藻、藤壶 | 4K 下卡通分档、描边与颗粒 |
| `dbg/id`、`dbg/edge`、`dbg/line`、`dbg/kuwahara`、`dbg/paper` | 7.6 秒无显示层的五个后期中间层 | 后期管线每一层的样子：物体 ID 图、边缘、墨线覆盖率、Kuwahara、纸纹 |

帧在清单里的编号形如 `film?nohud=1@1920x1040#t=1.5000`、`film@3840x2080[1900,60,1280,720]#t=1.5000`、`film?nohud=1&dbg=paper@1920x1040#t=7.6000`；集合定义是 `tools/baseline/sets.json` 的 `beiming-original-v1`。

## 这份画风的几个数

对照之外，延续画风时直接用这些数（都在 `src/look.js`、`src/toon.js`，像素量按 1080 高标定）：

- 墨线：外轮廓 2.6 px、内部线 0.55 倍，墨色 `#2A2D52`（深蓝灰，不用纯黑），吸收 15% 底色；抖动 1.2 px、波长 70 px，笔压 ±35%，偶尔断线（0.1）；沸腾 12 fps，即一拍二。
- Kuwahara 半径 5，纸纹强度 0.12，暗角 0.22，颗粒 0.65（画在显示层之下，封装时不再加）；bloom 0.55 / 阈值 0.72；调色偏暖 0.12、饱和度 1.04。
- 色板：天顶 `#4F5BBF`、薰衣草 `#9C8FD8`、粉 `#F2A0A6`、杏 `#FFB26B`；鲲 `#6E7BA8` / 一档阴影 `#4E5888` / 二档阴影 `#343D69`、轮廓光 `#FFD3B0`、腹 `#F2A36B`；海藻 `#5E8A5A` / `#3E6B4A`；显示层 `#EAF6FF` / `#9FE8FF`。
- 节奏：鲲一拍三，墨线一拍二（`engine/core/clock.js`）。

## 怎么用

| 要做的事 | 命令 |
|---|---|
| 现代码还是不是这份画面 | `node tools/baseline/golden.mjs compare --set beiming-original-v1 --reference beiming-original@v1`（darwin-metal 上应 20/20 逐像素一致；62ad28e 之后的画面改动都已在登记时包含） |
| 拿到登记提交渲出的二十张 PNG | `node tools/baseline/golden.mjs compare --set beiming-original-v1 --against c49da14`：参照 PNG 在 `out/golden/cache/c49da14…/<系统-后端>/beiming-original-v1/frames/`，当前工作树的在 `out/golden/compare/<运行编号>/current/` |
| 新片 look 闸门 | 先按上文在本机重建关键帧，新片的风格关键帧与 `out/style-baselines/beiming-original@v1/keyframes/` 里同名的图并排：远景对 `wide`，人物对 `figure`，特写对 `eye` / `underside`。看色板、墨线粗细与墨色、纸纹与颗粒的分寸。内容不同的画面之间不算 SSIM / PSNR，那没有意义 |
| 自动参考指标（评测题库 DF-A、DF-M） | `tools/eval` 用这六张图算色板 ΔE00 中位数、墨线覆盖率、纸纹与颗粒的高频能量，只作参考、不计分。图要先在本机重建；评测工具目前在本目录下找图，找不到时记「基线未入库」（改为也读 `out/style-baselines/` 的请求已提给集成负责人） |
| 拿到关键帧图 | `node tools/baseline/golden.mjs keyframes --reference beiming-original@v1`：现渲登记提交，像素与清单逐位一致才写到 `out/style-baselines/beiming-original@v1/keyframes/`；不改任何入库文件。只能在 darwin-metal 上做 |
| 其它平台 | 在那台机器上用同一提交 `golden reference --set beiming-original-v1 --id beiming-original@v1 --commit c49da14 …` 补登记 `<平台键>.json`；与 darwin-metal 之间按跨平台容差比 |

## 认可依据

| 依据 | 内容 |
|---|---|
| 07:40 版样片 | 用户项目档存档的「北冥样片_0740版」（1080、原生 4K、RTX 超分三版，4K 实测对比报告的对象）。v1.0 的代码渲出的就是它：仓库建立时逐帧比对，0、1.5、6、7 秒逐像素一致，人物墨线与导航线因笔触实现不同差 48–62 dB |
| PR #1（62ad28e） | 用户合并的 PR 列明了改变画面的修复：R24 渡船红绿航行灯换到正确舷侧（0–2.8 秒）、R30 鸽群黑边（1.0–2.8 秒）、R66 7.5 秒前后导航线线头；只在 4K 生效的 R17、R19、R31、R32、R45。这份参照包含这些修复 |
| 不采用公开成片 | `media/beiming.mp4` 的红珊瑚版是 v1.0 提交前噪声初稿的残留产物，与任何一个提交都对不上，见 [D05 调查](../records/2026-11-10-d05-media-provenance.md) |

登记人是 P08 工作包代理，它只记录依据，不代替用户认可（D08）。用户确认后，在本页「状态」一栏写「已认可」并引用用户原话与出处；用户若裁定红珊瑚版才是认可画面，按 D05 调查第 5 节 B 修回，另立 `beiming-original@v2`，本版本保留。

## 版本

- v1（2026-11-10）：20 帧，darwin-metal，登记提交 `c49da14`。冻结，不改。同日补入六张关键帧的登记 `keyframes.json`，像素即清单里的同名帧，不算改版。关键帧 PNG 曾随登记一起入库，11-11 按 D10 移出仓库，改为本机重建。
