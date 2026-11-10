# 授权与权利登记册

> 本页由 `node tools/compliance/rights-inventory.mjs --write` 从 [register.json](register.json) 与 `cases/catalog.json` 生成，**不要手改**：改登记内容请改 register.json，再重新生成；`--check` 核对本页是否过期（规范检查 `comp.rights-register` 也会查）。登记日期：2026-11-10。

## 登记口径

- **用户声明**（2026-11-10）：「上海美术电影制片厂相关 IP、乐奇相关客户材料与参考图已获授权」。记录于 docs/decisions/2026-11-10-industrial-baseline.md 的 D02（不下线、不改写历史、在 docs/rights/ 登记）。
- 字段写「待补」表示用户还没有提供，**不推断、不编造**；合同与授权书正文不进仓库，只登记存放位置。
- 「仓库内自述」是历史文件自己写的口径，只作线索，不等于授权范围；与授权范围冲突时以书面授权为准，书面授权补齐前按更严的口径执行。
- **授权不等于可以复用**：登记在册的第三方与客户素材只用于登记所列的作品；要用到新作品、模版、作品站新页面或其他对外物料，先在本册对应条目写明授权范围覆盖该用途，否则不用。
- 相关规则：许可范围与派生代码的来源头见 [licensing.md](licensing.md)；B 路线的 FSL 边界见 [fsl-boundary.md](fsl-boundary.md)；AI 生成内容的标识见 [aigc.md](aigc.md)；总览与命令见 [README.md](README.md)。
- 受影响清单按 `cases/catalog.json`（Release `casebook-2026.11`）计算：「整个案例」= 全部文件、成片、预览与海报；「部分文件」= 只有列出的文件（同一张图出现在别的案例里也算上）；「成片用到」= 成片、预览与海报。

## 一览

| 编号 | 类别 | 权利方 | 授权方 | 授权范围 | 期限 | 书面证据 | 状态 | 受影响案例 |
|---|---|---|---|---|---|---|---|---|
| R01 | 上海美术电影制片厂（上美影）相关 IP：IP 图、剧照与据此制作的发布会动画 | 上海美术电影制片厂及相关权利方 | 待补 | 待补 | 待补 | 待补 | 用户声明已获授权，书面证据待补 | 8 |
| R02 | 乐奇（Rokid）相关客户材料：PPT 原画与文本、品牌标识、产品资料转述，以及据此制作的故事介绍片与九分钟片 | 乐奇 / Rokid（法律主体名称待补） | 待补 | 待补 | 待补 | 待补 | 用户声明已获授权，书面证据待补 | 7 |
| R03 | 参考图：非上美影作品的静帧与用户提供的参考图，以及据此生成的实验图 | 待补 | 待补 | 待补 | 待补 | 待补 | 用户声明已获授权，书面证据待补 | 5 |
| R04 | 《见龙》故事提案的 PPT 原画（委托方待补） | 待补 | 待补 | 待补 | 待补 | 待补 | 授权状态待用户确认 | 1 |
| R05 | IP 联名图里的第三方品牌：星巴克、古茗、中信出版 | 星巴克（Starbucks）、古茗、中信出版（名称依文件名，法律主体待补） | 待补 | 待补 | 待补 | 待补 | 授权状态待用户确认 | 2 |
| R06 | 钢琴采样 Salamander Grand Piano V3（CC BY 3.0） | Alexander Holm | Alexander Holm（按 CC BY 3.0 公开许可） | CC BY 3.0：可复制、改编、商用，须署名并注明修改 | 公开许可，无期限 | 许可地址 https://creativecommons.org/licenses/by/3.0/（记录在各案例 CREDITS） | 公开许可，按许可义务使用 | 3 |
| R07 | 鼓组采样 MuldjordKit（FreePats 版，CC BY 4.0） | Lars Muldjord（drumgizmo.org） | Lars Muldjord（按 CC BY 4.0 公开许可） | CC BY 4.0：可复制、改编、商用，须署名并注明修改 | 公开许可，无期限 | 许可地址 https://creativecommons.org/licenses/by/4.0/（记录在各案例 CREDITS） | 公开许可，按许可义务使用 | 11 |
| R08 | 图像与视频生成服务：Midjourney、OpenAI GPT Image、Qwen-Image 等生成的画面 | 生成内容的权利归属以各服务条款为准（待补） | Midjourney、OpenAI（按各自服务条款）；Qwen-Image（本地运行的开放权重模型，按模型许可，许可名称待补核） | 待补（各服务的使用条款与套餐：例如审计 COMP-04 提示 Midjourney 对年收入超过 100 万美元的公司要求 Pro 或 Mega 套餐，需核对实际账号） | 待补 | 待补（条款快照与账号套餐记录的存放位置） | 服务条款与套餐待核对 | 12 |
| R09 | 语音与音乐生成：MiniMax 语音合成、MiniMax-Music3、Edge TTS | 合成语音与音乐的权利归属以各服务或模型的条款为准（待补） | MiniMax（法律主体待补）、微软（Edge 在线朗读服务）等服务方，按各自条款；MiniMax-Music3 本机部署部分按模型许可（待补） | 待补（音色的商用范围、MiniMax-Music3 本机部署所用模型权重的许可） | 待补 | 待补 | 服务条款与套餐待核对 | 9 |
| R10 | 上游开源快照与随库字体：LemoLab、肖雄 XIAOXIONG、Poly Haven、three.js、OFL 字体 | LemoLab；肖雄 XIAOXIONG；Poly Haven；three.js authors；各字体的版权人（见 REUSE.toml） | 同权利方（公开许可） | lemo-opuscar：代码与文档 MIT，例片与静帧 CC BY 4.0；sy-style-100：MIT；Poly Haven：CC0；three.js：MIT；字体：SIL OFL 1.1 | 公开许可，无期限 | 许可全文在 LICENSES/ 与 cases/licenses/；逐路径对照在 REUSE.toml | 公开许可，按许可义务使用 | — |
| R11 | 公有领域与开放数据的图像、影像与数据（NASA、美国国会图书馆、USGS、NOAA、Wikimedia 公有领域图、Natural Earth 等） | 各素材来源（见各案例 CREDITS） | 公有领域或 CC0 / PDDL 等开放许可 | 按各自许可；公有领域无署名义务，案例 CREDITS 里的署名是致谢。另：大量风格案例用到 CC0 采样（VSCO 2 CE、VCSL、FreePats 的 CC0 部分），CC0 无署名义务，不逐案登记 | 公开许可，无期限 | 各案例 CREDITS 记录的来源链接 | 公开许可，按许可义务使用 | 17 |
| R12 | 《北冥》样片与本项目自有影像（底板、样片、展示图、作品站画面） | 待补（根 LICENSE 与 REUSE.toml 暂写「北冥引擎 Beiming Engine」，这是项目名，不是法律主体） | 不适用（自有作品）；如属委托作品，委托方与权利约定待补 | 保留所有权利（LICENSES/LicenseRef-AllRightsReserved.txt） | 待补 | 待补（若《北冥》属于乐奇项目的委托作品，合同中的权利约定存放位置） | 本项目作品，权利主体待补 | — |
| R13 | 上游原生运行时 RAEA（B 路线 · 北冥原生 · BNE 调用，不随仓库分发） | Shane Murphy（上游仓库 shinyobjectz/raea 的版权人） | 同权利方（按 FSL-1.1-ALv2 公开许可） | FSL-1.1-ALv2：允许内部使用、为本身持有许可的客户提供专业服务；排除竞争性使用（对外提供替代 RAEA 或功能实质相似的商业产品或服务）；每个版本发布满两年转为 Apache-2.0 | 实际运行的 v0.1.0-canary.2（2026-10-31 发布）于 2028-10-31 转为 Apache-2.0；升级版本时按新版本的发布日另算 | 公开许可，以上游固定提交的 LICENSE 为准；若要对外商业化，所需的书面商业许可或法律意见：待补 | 公开许可，按许可义务使用 | — |

## R01 上海美术电影制片厂（上美影）相关 IP：IP 图、剧照与据此制作的发布会动画

- **权利方**：上海美术电影制片厂及相关权利方（依据：仓库内自述 cases/source/keynote-B-kaitou/CREDITS:7、cases/source/keynote-seg1-kaijuan/CREDITS:6；各 IP 的具体权利人名单待补）
- **授权方**：待补
- **授权范围**：待补
- **仓库内自述（不等于授权范围）**：keynote-B-kaitou/CREDITS:7「本片仅作内部沟通样片」；keynote-seg1-kaijuan/CREDITS:6「本片为内部沟通样片，使用者对素材的使用范围负责」；keynote-C-quanpian/CREDITS:42「使用者对片中所用素材（尤其是 IP 图片）的授权负责」；keynote-B-kaitou/main.js:360 片中字幕「内容资源概念发布｜内部沟通」。豹变参考图另见 local-baobian-film/SUBAGENT_STANDARD.md:36、:39（只当生图参考，不原样入画）
- **期限**：待补
- **书面证据存放位置**：待补
- **状态**：用户声明已获授权，书面证据待补；这些素材在公开 Release、作品站和仓库海报里分发；书面授权的范围是否覆盖公开分发待用户确认
- **证据位置**：
  - 用户声明：docs/decisions/2026-11-10-industrial-baseline.md D02
  - IP 图来源：cases/source/keynote-shared/制作规范.md:100（上影元官网 sfi-sh.com，经 PPT《上美影IP全景》整理后超分）
  - 权利方自述：cases/source/keynote-B-kaitou/CREDITS:7、cases/source/keynote-seg1-kaijuan/CREDITS:6
  - 豹变参考静帧（水墨、装饰、奇谭三版，均为上美影作品）：cases/source/local-baobian-film/films/A_shuimo/STYLE.md:1、B_zhuangshi/STYLE.md:1、C_qitan/STYLE.md:1
  - 审计记录：COMP-01 ①（29 张 IP 图分布在 assets-01 至 06）
- **义务与做法**：授权书补齐前按仓库内自述的最严口径执行：随片保留现有 CREDITS 的权利声明；不拆出 IP 图单独分发；不改动 IP 图的作品署名；新的分发渠道（新页面、新物料、新平台）先确认授权范围
- **agent 规则**：不得把 IP 图、剧照、联名图或它们的局部用进新作品、模版、作品站新页面或其他对外物料；还原 keynote-* 与 local-baobian-film 只为研究方法，产物不对外。确需新用途先问用户，并在本条写明授权范围
- **对外分发点**：Release casebook-2026.11（附件见下）；作品站的 6 部发布会动画（site/ 构建时从 Release 取预览）；仓库内海报 cases/previews/keynote-*.jpg

**受影响案例（8）**

| 案例 | 标题 | 分组 | 受影响范围 | 文件数 |
|---|---|---|---|---|
| `keynote-B-kaitou` | 方案 B《片库之夜》20 秒开头 · 导演阐述（TREATMENT） | ppt-keynote | 整个案例 | 23 |
| `keynote-C-kaitou` | 方案 C《打开》20 秒开头 | ppt-keynote | 整个案例 | 26 |
| `keynote-C-quanpian` | 方案 C《打开》全片 | ppt-keynote | 整个案例 | 108 |
| `keynote-seg1-kaijuan` | 片段一「开卷」TREATMENT | ppt-keynote | 整个案例 | 26 |
| `keynote-seg2-caizhi` | 片段二「材料变奏」TREATMENT | ppt-keynote | 整个案例 | 30 |
| `keynote-seg3-ranbiwa` | 片段三「燃比娃与揭晓」TREATMENT | ppt-keynote | 整个案例 | 33 |
| `keynote-shared` | 上影发布会共用资源 | ppt-keynote | 整个案例 | 42 |
| `local-baobian-film` | 豹变四版 | local-films | 部分文件 | 41 |

- **Release 附件（casebook-2026.11）**：`assets-01.zip`、`assets-02.zip`、`assets-03.zip`、`assets-04.zip`、`assets-05.zip`、`assets-06.zip`、`original-films-07.zip`
- **Release 预览（6）**：`keynote-B-kaitou-preview.mp4`、`keynote-C-kaitou-preview.mp4`、`keynote-C-quanpian-preview.mp4`、`keynote-seg1-kaijuan-preview.mp4`、`keynote-seg2-caizhi-preview.mp4`、`keynote-seg3-ranbiwa-preview.mp4`
- **成片（包内路径，6）**：`original-films-07.zip:keynote-B-kaitou/B-kaitou.mp4`、`original-films-07.zip:keynote-C-kaitou/C-kaitou.mp4`、`original-films-07.zip:keynote-C-quanpian/C-quanpian.mp4`、`original-films-07.zip:keynote-seg1-kaijuan/seg1-kaijuan.mp4`、`original-films-07.zip:keynote-seg2-caizhi/seg2-caizhi.mp4`、`original-films-07.zip:keynote-seg3-ranbiwa/seg3-ranbiwa.mp4`
- **仓库内的海报（6）**：`cases/previews/keynote-B-kaitou.jpg`、`cases/previews/keynote-C-kaitou.jpg`、`cases/previews/keynote-C-quanpian.jpg`、`cases/previews/keynote-seg1-kaijuan.jpg`、`cases/previews/keynote-seg2-caizhi.jpg`、`cases/previews/keynote-seg3-ranbiwa.jpg`
- **仓库内的归档源文件**：131 个（如 `cases/source/keynote-B-kaitou/build.sh`；完整清单用 `node tools/compliance/rights-inventory.mjs --json`）

## R02 乐奇（Rokid）相关客户材料：PPT 原画与文本、品牌标识、产品资料转述，以及据此制作的故事介绍片与九分钟片

- **权利方**：乐奇 / Rokid（法律主体名称待补）（依据：仓库内文字：cases/source/ppt-understands-you/素材/ppt文本.md:18（用户提供的 Rokid 公司介绍 PDF）、cases/source/ppt-in-sight/film/build.py:831（片尾贴 rokid_logo.png）、成片文件名「乐奇AR_她的舞蹈导师_故事介绍.mp4」（cases/entries/ppt-dance-mentor.md:35））
- **授权方**：待补
- **授权范围**：待补
- **仓库内自述（不等于授权范围）**：cases/entries/ppt-*.md:11「入库不等于重新渲染或品牌终审」；ppt-understands-you/素材/ppt文本.md:18、:22 有「需甲方确认」「以甲方指定型号确认为准」的口径
- **期限**：待补
- **书面证据存放位置**：待补
- **状态**：用户声明已获授权，书面证据待补；作品站把这批片子作为作品展示；是否经过品牌方终审、可否公开展示待用户确认
- **证据位置**：
  - 用户声明：docs/decisions/2026-11-10-industrial-baseline.md D02
  - 客户资料转述：cases/source/ppt-understands-you/素材/ppt文本.md:18、:22
  - 品牌标识入片：cases/source/ppt-in-sight/film/build.py:831、cases/source/ppt-in-sight/tools/stills.py:342
  - 片中品牌字样：cases/source/ppt-before-sunset/film/build.py:649、cases/source/ppt-new-year-street/film/build.py:226
  - 九分钟片属于乐奇项目：cases/source/local-beiming-film-9min/WORK_STATE.md:11、audio/dialogue.json:4（说话人「乐奇」）
  - 审计记录：COMP-01 ②、⑤
- **义务与做法**：授权书补齐前：不改动品牌标识；不把客户的产品资料转述（ppt文本.md 等）当作公开说明引用；对外展示附「客户提案作品」说明；客户要求下线时由用户决定并在新提交里删除（D02 不改写历史）
- **agent 规则**：不得把乐奇的标识、产品外观、PPT 原画或文本用进新作品、模版或对外物料；不得以客户名义对外描述产品能力。新项目需要用到时先问用户
- **对外分发点**：Release casebook-2026.11（附件见下）；作品站的 7 部 PPT 故事介绍片中的 6 部；仓库内海报 cases/previews/ppt-*.jpg 与作品站海报 site/data/posters/ppt-understands-you.jpg
- **仓库主体里的相关文件**：`site/data/posters/ppt-understands-you.jpg`

**受影响案例（7）**

| 案例 | 标题 | 分组 | 受影响范围 | 文件数 |
|---|---|---|---|---|
| `local-beiming-film-9min` | 北冥九分钟 | local-films | 整个案例 | 325 |
| `ppt-before-sunset` | 日落之前 | ppt-stories | 整个案例 | 125 |
| `ppt-dance-mentor` | 她的舞蹈导师 | ppt-stories | 整个案例 | 129 |
| `ppt-in-sight` | 目之所及 | ppt-stories | 整个案例 | 105 |
| `ppt-new-year-street` | 这条街照常过年 | ppt-stories | 整个案例 | 1008 |
| `ppt-painting-treasure` | 画境追宝 | ppt-stories | 整个案例 | 176 |
| `ppt-understands-you` | 懂你的人 | ppt-stories | 整个案例 | 217 |

- **Release 附件（casebook-2026.11）**：`assets-01.zip`、`assets-02.zip`、`assets-03.zip`、`assets-04.zip`、`assets-05.zip`、`assets-06.zip`、`original-films-04.zip`、`original-films-05.zip`、`original-films-06.zip`、`original-films-07.zip`、`original-films-09.zip`
- **Release 预览（7）**：`local-beiming-film-9min-preview.mp4`、`ppt-before-sunset-preview.mp4`、`ppt-dance-mentor-preview.mp4`、`ppt-in-sight-preview.mp4`、`ppt-new-year-street-preview.mp4`、`ppt-painting-treasure-preview.mp4`、`ppt-understands-you-preview.mp4`
- **成片（包内路径，13）**：`original-films-04.zip:ppt-dance-mentor/乐奇AR_她的舞蹈导师_故事介绍_手机版.mp4`、`original-films-04.zip:ppt-in-sight/IN_SIGHT_目之所及_故事介绍_手机版.mp4`、`original-films-04.zip:ppt-in-sight/IN_SIGHT_目之所及_故事介绍.mp4`、`original-films-05.zip:ppt-before-sunset/日落之前_故事介绍_手机版.mp4`、`original-films-05.zip:ppt-dance-mentor/乐奇AR_她的舞蹈导师_故事介绍.mp4`、`original-films-05.zip:ppt-understands-you/懂你的人_书桌版_手机版.mp4`、`original-films-05.zip:ppt-understands-you/懂你的人_书桌版.mp4`、`original-films-06.zip:ppt-before-sunset/日落之前_故事介绍.mp4`、`original-films-06.zip:ppt-new-year-street/这条街照常过年_故事介绍_手机版.mp4`、`original-films-06.zip:ppt-painting-treasure/画境追宝_故事介绍_手机版.mp4`、`original-films-06.zip:ppt-painting-treasure/画境追宝_故事介绍.mp4`、`original-films-07.zip:ppt-new-year-street/这条街照常过年_故事介绍.mp4`、`original-films-09.zip:local-beiming-film-9min/beiming_9min_1080.mp4`
- **仓库内的海报（7）**：`cases/previews/local-beiming-film-9min.jpg`、`cases/previews/ppt-before-sunset.jpg`、`cases/previews/ppt-dance-mentor.jpg`、`cases/previews/ppt-in-sight.jpg`、`cases/previews/ppt-new-year-street.jpg`、`cases/previews/ppt-painting-treasure.jpg`、`cases/previews/ppt-understands-you.jpg`
- **仓库内的归档源文件**：490 个（如 `cases/source/lab-2026-11-05-beiming-nine-3d/engine/audio/__init__.py`；完整清单用 `node tools/compliance/rights-inventory.mjs --json`）

## R03 参考图：非上美影作品的静帧与用户提供的参考图，以及据此生成的实验图

- **权利方**：待补（依据：雾山五行参考（cases/source/local-baobian-film/films/D_wushan/STYLE.md:1）；北冥实验的 9 张参考图原文件名为哈希，来源未记录（cases/source/lab-2026-11-05-beiming-nine-3d/refs/manifest.json））
- **授权方**：待补
- **授权范围**：待补
- **仓库内自述（不等于授权范围）**：local-baobian-film/SUBAGENT_STANDARD.md:36「参考静帧只能当生图的参考图，不能原样放进画面」、:39 与 BRIEF.md:40 自称版权方已授权且只作参考图；但 lab-2026-11-05-nine-scenes-360/README.md:20 把参考图直接建成带纹理的网格并输出 360 张图（experiment-images 包），已超出「只作参考」——授权范围是否覆盖这种派生展示待用户确认
- **期限**：待补
- **书面证据存放位置**：待补
- **状态**：用户声明已获授权，书面证据待补
- **证据位置**：
  - 用户声明：docs/decisions/2026-11-10-industrial-baseline.md D02
  - 仓库内自述：cases/source/local-baobian-film/SUBAGENT_STANDARD.md:36、:39，cases/source/local-baobian-film/BRIEF.md:40
  - 派生展示：cases/source/lab-2026-11-05-nine-scenes-360/README.md:20
  - 审计记录：COMP-01 ③（公开包里 61 张不重复参考图）
- **义务与做法**：参考图只作生图与画风参考，不原样或近似原样进入对外画面；派生的实验图（experiment-images 包）不再扩散到新渠道
- **agent 规则**：新作品要用参考图，先在本册登记来源与授权范围；没有登记的参考图只能在本机临时使用，不得入库、不得进 Release。不得把参考图直接贴进画面或建成纹理
- **对外分发点**：Release casebook-2026.11 的 assets 包与 experiment-images-01/02 包

**受影响案例（5）**

| 案例 | 标题 | 分组 | 受影响范围 | 文件数 |
|---|---|---|---|---|
| `lab-2026-11-05-beiming-nine-3d` | 北冥九景 · 三维重建与画风试验 | beiming-labs | 部分文件 | 120 |
| `lab-2026-11-05-e-paper-15s` | 纸上江山｜北冥 E 组动画试作 | beiming-labs | 部分文件 | 3 |
| `lab-2026-11-05-nine-scenes-360` | 北冥 · 九景画风实验 | beiming-labs | 部分文件 | 836 |
| `lab-2026-11-05-tonal-40` | 北冥引擎 · 色阶实验 01 | beiming-labs | 部分文件 | 162 |
| `local-baobian-film` | 豹变四版 | local-films | 部分文件 | 10 |

- **Release 附件（casebook-2026.11）**：`assets-01.zip`、`assets-02.zip`、`assets-03.zip`、`assets-04.zip`、`assets-05.zip`、`assets-06.zip`、`experiment-images-01.zip`、`experiment-images-02.zip`
- **Release 预览（0）**：无
- **仓库内的海报（0）**：无
- **仓库内的归档源文件**：10 个（如 `cases/source/lab-2026-11-05-beiming-nine-3d/delivery/index.html`；完整清单用 `node tools/compliance/rights-inventory.mjs --json`）

## R04 《见龙》故事提案的 PPT 原画（委托方待补）

- **权利方**：待补（依据：cases/source/ppt-jianlong/jianlong/CREDITS:4「全部 19 张画面原画来自用户提供的《见龙v3》」；仓库里没有写明委托方，也没有乐奇字样）
- **授权方**：待补
- **授权范围**：待补
- **仓库内自述（不等于授权范围）**：cases/entries/ppt-jianlong.md:11「入库不等于重新渲染或品牌终审」
- **期限**：待补
- **书面证据存放位置**：待补
- **状态**：授权状态待用户确认；用户 2026-11-10 的声明点名的是上美影 IP、乐奇客户材料与参考图；《见龙》原画属于哪一方、是否在声明范围内待用户确认
- **证据位置**：
  - 原画来源：cases/source/ppt-jianlong/jianlong/CREDITS:4
  - 工作目录名为「上影ppt」：cases/entries/ppt-jianlong.md:19（只说明存放位置，不说明权属）
- **义务与做法**：归属确认前按客户材料对待：不改动原画、不复用、不扩散到新渠道
- **agent 规则**：不得复用《见龙》原画或据此做新作品；归属确认前不写进新的对外物料
- **对外分发点**：Release casebook-2026.11（附件见下）；作品站的 7 部 PPT 故事介绍片中的 1 部

**受影响案例（1）**

| 案例 | 标题 | 分组 | 受影响范围 | 文件数 |
|---|---|---|---|---|
| `ppt-jianlong` | 见龙 | ppt-stories | 整个案例 | 322 |

- **Release 附件（casebook-2026.11）**：`assets-01.zip`、`assets-02.zip`、`assets-03.zip`、`assets-04.zip`、`assets-05.zip`、`assets-06.zip`、`original-films-04.zip`
- **Release 预览（1）**：`ppt-jianlong-preview.mp4`
- **成片（包内路径，2）**：`original-films-04.zip:ppt-jianlong/见龙_印刷水墨版_v2新旁白_3分14秒_手机版.mp4`、`original-films-04.zip:ppt-jianlong/见龙_印刷水墨版_v2新旁白_3分14秒.mp4`
- **仓库内的海报（1）**：`cases/previews/ppt-jianlong.jpg`
- **仓库内的归档源文件**：137 个（如 `cases/source/ppt-jianlong/jianlong/ARCH.md`；完整清单用 `node tools/compliance/rights-inventory.mjs --json`）

## R05 IP 联名图里的第三方品牌：星巴克、古茗、中信出版

- **权利方**：星巴克（Starbucks）、古茗、中信出版（名称依文件名，法律主体待补）（依据：cases/source/keynote-shared 的「IP图_超分/P17_大闹天宫x星巴克.png」「P17_葫芦兄弟x古茗.png」「P17_中国奇谭x中信出版立体书.png」（资产在 Release 素材包里））
- **授权方**：待补
- **授权范围**：待补
- **期限**：待补
- **书面证据存放位置**：待补
- **状态**：授权状态待用户确认；用户 2026-11-10 的声明只提到上美影 IP，没有提到联名品牌方；联名图里的商标与联名设计是否在授权范围内待用户确认
- **证据位置**：
  - 文件名：cases/catalog.json 中 keynote-shared 的 IP图_超分/P17_* 三条记录
  - 审计记录：COMP-01 ① 与影响分析（星巴克、古茗、中信联名标识）
- **义务与做法**：不得以任何方式暗示品牌方背书；授权确认前不进入新渠道
- **agent 规则**：不得使用联名图或其中的品牌标识

**受影响案例（2）**

| 案例 | 标题 | 分组 | 受影响范围 | 文件数 |
|---|---|---|---|---|
| `keynote-C-quanpian` | 方案 C《打开》全片 | ppt-keynote | 部分文件 | 3 |
| `keynote-shared` | 上影发布会共用资源 | ppt-keynote | 部分文件 | 3 |

- **Release 附件（casebook-2026.11）**：`assets-02.zip`、`assets-04.zip`、`assets-05.zip`
- **Release 预览（0）**：无
- **仓库内的海报（0）**：无
- **仓库内的归档源文件**：0 个

## R06 钢琴采样 Salamander Grand Piano V3（CC BY 3.0）

- **权利方**：Alexander Holm（依据：各案例 CREDITS，如 cases/source/keynote-B-kaitou/CREDITS:18）
- **授权方**：Alexander Holm（按 CC BY 3.0 公开许可）
- **授权范围**：CC BY 3.0：可复制、改编、商用，须署名并注明修改
- **期限**：公开许可，无期限
- **书面证据存放位置**：许可地址 https://creativecommons.org/licenses/by/3.0/（记录在各案例 CREDITS）
- **状态**：公开许可，按许可义务使用
- **证据位置**：
  - 署名原文：cases/source/keynote-B-kaitou/CREDITS:18、cases/source/ppt-understands-you/film/desk/credits_music.txt:1、cases/source/style-62-archive-lighttable/CREDITS:21
- **义务与做法**：分发用到该采样的成片（original-films 包与预览）时随附署名：作品名、作者、许可与链接，并注明经过混音处理；Release 说明与 NOTICE 目前没有这段署名，由案例库属主补上（审计 COMP-06 / QUAL-16）
- **agent 规则**：新作品用到它时，在作品的 film.json credits 与片尾或说明里写署名

**受影响案例（3）**

| 案例 | 标题 | 分组 | 受影响范围 | 文件数 |
|---|---|---|---|---|
| `keynote-B-kaitou` | 方案 B《片库之夜》20 秒开头 · 导演阐述（TREATMENT） | ppt-keynote | 成片用到 | — |
| `ppt-understands-you` | 懂你的人 | ppt-stories | 成片用到 | — |
| `style-62-archive-lighttable` | 十二秒 · 档案灯台（Archive Light Table）风格样片 | styles | 成片用到 | — |

- **Release 附件（casebook-2026.11）**：`original-films-02.zip`、`original-films-05.zip`、`original-films-07.zip`
- **Release 预览（3）**：`keynote-B-kaitou-preview.mp4`、`ppt-understands-you-preview.mp4`、`style-62-archive-lighttable-preview.mp4`
- **成片（包内路径，4）**：`original-films-02.zip:style-62-archive-lighttable/62-archive-lighttable.mp4`、`original-films-05.zip:ppt-understands-you/懂你的人_书桌版_手机版.mp4`、`original-films-05.zip:ppt-understands-you/懂你的人_书桌版.mp4`、`original-films-07.zip:keynote-B-kaitou/B-kaitou.mp4`
- **仓库内的海报（3）**：`cases/previews/keynote-B-kaitou.jpg`、`cases/previews/ppt-understands-you.jpg`、`cases/previews/style-62-archive-lighttable.jpg`
- **仓库内的归档源文件**：0 个

## R07 鼓组采样 MuldjordKit（FreePats 版，CC BY 4.0）

- **权利方**：Lars Muldjord（drumgizmo.org）（依据：各案例 CREDITS，如 cases/source/keynote-C-kaitou/CREDITS:21）
- **授权方**：Lars Muldjord（按 CC BY 4.0 公开许可）
- **授权范围**：CC BY 4.0：可复制、改编、商用，须署名并注明修改
- **期限**：公开许可，无期限
- **书面证据存放位置**：许可地址 https://creativecommons.org/licenses/by/4.0/（记录在各案例 CREDITS）
- **状态**：公开许可，按许可义务使用
- **证据位置**：
  - 署名原文：cases/source/keynote-C-kaitou/CREDITS:21、cases/source/keynote-C-quanpian/CREDITS:35、cases/source/style-16-swiss-motion/CREDITS:11 等
- **义务与做法**：同 R06：分发成片时随附署名；Release 说明与 NOTICE 目前缺这段署名，由案例库属主补上
- **agent 规则**：新作品用到它时，在作品的 film.json credits 与片尾或说明里写署名

**受影响案例（11）**

| 案例 | 标题 | 分组 | 受影响范围 | 文件数 |
|---|---|---|---|---|
| `keynote-C-kaitou` | 方案 C《打开》20 秒开头 | ppt-keynote | 成片用到 | — |
| `keynote-C-quanpian` | 方案 C《打开》全片 | ppt-keynote | 成片用到 | — |
| `style-16-swiss-motion` | TEMPO · 节拍 —— 瑞士动态排版风格样片（19.75 秒） | styles | 成片用到 | — |
| `style-18-art-deco` | 《落成之夜》TREATMENT · 装饰艺术（Art Deco）风格样片 | styles | 成片用到 | — |
| `style-27-cel-anime-80s` | 追电车的夏天 | styles | 成片用到 | — |
| `style-32-microgame` | 四连关 | styles | 成片用到 | — |
| `style-33-game-show` | 节奏猜动物 | styles | 成片用到 | — |
| `style-46-living-screencast` | 《逃跑的周报》处理方案（活体实机录屏 · 风格样片） | styles | 成片用到 | — |
| `style-48-midcentury-toon` | 明日早晨 | styles | 成片用到 | — |
| `style-63-caption-news` | 会用工具的海獭 | styles | 成片用到 | — |
| `style-69-telestrator` | 《那一脚》 TREATMENT — 体育战术板 Sports Telestrator | styles | 成片用到 | — |

- **Release 附件（casebook-2026.11）**：`original-films-01.zip`、`original-films-02.zip`、`original-films-03.zip`、`original-films-07.zip`
- **Release 预览（11）**：`keynote-C-kaitou-preview.mp4`、`keynote-C-quanpian-preview.mp4`、`style-16-swiss-motion-preview.mp4`、`style-18-art-deco-preview.mp4`、`style-27-cel-anime-80s-preview.mp4`、`style-32-microgame-preview.mp4`、`style-33-game-show-preview.mp4`、`style-46-living-screencast-preview.mp4`、`style-48-midcentury-toon-preview.mp4`、`style-63-caption-news-preview.mp4`、`style-69-telestrator-preview.mp4`
- **成片（包内路径，11）**：`original-films-01.zip:style-16-swiss-motion/16-swiss-motion.mp4`、`original-films-01.zip:style-18-art-deco/18-art-deco.mp4`、`original-films-02.zip:style-27-cel-anime-80s/27-cel-anime-80s.mp4`、`original-films-02.zip:style-32-microgame/32-microgame.mp4`、`original-films-02.zip:style-33-game-show/33-game-show.mp4`、`original-films-02.zip:style-46-living-screencast/46-living-screencast.mp4`、`original-films-02.zip:style-48-midcentury-toon/48-midcentury-toon.mp4`、`original-films-02.zip:style-63-caption-news/63-caption-news.mp4`、`original-films-03.zip:style-69-telestrator/69-telestrator.mp4`、`original-films-07.zip:keynote-C-kaitou/C-kaitou.mp4`、`original-films-07.zip:keynote-C-quanpian/C-quanpian.mp4`
- **仓库内的海报（11）**：`cases/previews/keynote-C-kaitou.jpg`、`cases/previews/keynote-C-quanpian.jpg`、`cases/previews/style-16-swiss-motion.jpg`、`cases/previews/style-18-art-deco.jpg`、`cases/previews/style-27-cel-anime-80s.jpg`、`cases/previews/style-32-microgame.jpg`、`cases/previews/style-33-game-show.jpg`、`cases/previews/style-46-living-screencast.jpg`、`cases/previews/style-48-midcentury-toon.jpg`、`cases/previews/style-63-caption-news.jpg`、`cases/previews/style-69-telestrator.jpg`
- **仓库内的归档源文件**：0 个

## R08 图像与视频生成服务：Midjourney、OpenAI GPT Image、Qwen-Image 等生成的画面

- **权利方**：生成内容的权利归属以各服务条款为准（待补）（依据：《北冥》底板：assets/plates/plates.json:3（Midjourney V8 与 GPT Image 2.5 生成后人工整理）；参考图 assets/ref/sky_test.png 带 OpenAI 签名的 C2PA 清单（ChatGPT / gpt-image，digitalSourceType = trainedAlgorithmicMedia））
- **授权方**：Midjourney、OpenAI（按各自服务条款）；Qwen-Image（本地运行的开放权重模型，按模型许可，许可名称待补核）
- **授权范围**：待补（各服务的使用条款与套餐：例如审计 COMP-04 提示 Midjourney 对年收入超过 100 万美元的公司要求 Pro 或 Mega 套餐，需核对实际账号）
- **期限**：待补
- **书面证据存放位置**：待补（条款快照与账号套餐记录的存放位置）
- **状态**：服务条款与套餐待核对；AI 生成内容的标识办法见 docs/rights/aigc.md；派生底板丢失了原图的 C2PA 信息（处理流程会丢隐式标识，需要修复）
- **证据位置**：
  - assets/plates/plates.json:3
  - assets/ref/sky_test.png（PNG 的 caBX 块，C2PA 清单签名方 OpenAI）
  - keynote 材质由本地 Qwen-Image 生成：cases/source/keynote-B-kaitou/CREDITS:10、keynote-C-kaitou/CREDITS:9、keynote-C-quanpian/CREDITS:13
  - 动画 PV 关键帧由 Qwen 编辑生成：cases/source/local-anime-pv/shots.py:3
  - 豹变资产图经 Magpie 调用 gpt-image-2.5：cases/source/local-baobian-film/films/A_shuimo/assets/manifest.json:2706
  - 客户 PPT 原画由图像生成工具制作：cases/source/ppt-understands-you/素材/ppt文本.md:22
  - 生成工作流记录：cases/source/local-hypit-pipeline-film/assets/film_data.json:543
- **义务与做法**：对外发布含 AI 生成画面的成片时做显式与隐式标识（docs/rights/aigc.md）；生成原图保留 C2PA，派生图在 plates.json 一类清单里记录来源链；不把 AI 生成的画面描述成手绘或纯代码绘制
- **agent 规则**：用生成工具出图时，在作品的资产清单里记下工具、模型版本、日期、提示词位置与人工修改；成片按 aigc.md 标识
- **仓库主体里的相关文件**：`assets/plates/**`、`assets/ref/sky_test.png`

**受影响案例（12）**

| 案例 | 标题 | 分组 | 受影响范围 | 文件数 |
|---|---|---|---|---|
| `keynote-B-kaitou` | 方案 B《片库之夜》20 秒开头 · 导演阐述（TREATMENT） | ppt-keynote | 成片用到 | — |
| `keynote-C-kaitou` | 方案 C《打开》20 秒开头 | ppt-keynote | 成片用到 | — |
| `keynote-C-quanpian` | 方案 C《打开》全片 | ppt-keynote | 成片用到 | — |
| `keynote-seg1-kaijuan` | 片段一「开卷」TREATMENT | ppt-keynote | 成片用到 | — |
| `keynote-seg2-caizhi` | 片段二「材料变奏」TREATMENT | ppt-keynote | 部分文件 | 6 |
| `keynote-seg3-ranbiwa` | 片段三「燃比娃与揭晓」TREATMENT | ppt-keynote | 成片用到 | — |
| `keynote-shared` | 上影发布会共用资源 | ppt-keynote | 部分文件 | 8 |
| `local-anime-pv` | AFTERGLOW 动画PV | local-films | 成片用到 | — |
| `local-baobian-film` | 豹变四版 | local-films | 成片用到 | — |
| `local-beiming-film-9min` | 北冥九分钟 | local-films | 成片用到 | — |
| `local-hypit-pipeline-film` | 每一关都有证据 | local-films | 成片用到 | — |
| `ppt-understands-you` | 懂你的人 | ppt-stories | 成片用到 | — |

- **Release 附件（casebook-2026.11）**：`assets-01.zip`、`assets-03.zip`、`assets-04.zip`、`assets-05.zip`、`original-films-05.zip`、`original-films-07.zip`、`original-films-08.zip`、`original-films-09.zip`、`original-films-10.zip`
- **Release 预览（10）**：`keynote-B-kaitou-preview.mp4`、`keynote-C-kaitou-preview.mp4`、`keynote-C-quanpian-preview.mp4`、`keynote-seg1-kaijuan-preview.mp4`、`keynote-seg3-ranbiwa-preview.mp4`、`local-anime-pv-preview.mp4`、`local-baobian-film-preview.mp4`、`local-beiming-film-9min-preview.mp4`、`local-hypit-pipeline-film-preview.mp4`、`ppt-understands-you-preview.mp4`
- **成片（包内路径，14）**：`original-films-05.zip:ppt-understands-you/懂你的人_书桌版_手机版.mp4`、`original-films-05.zip:ppt-understands-you/懂你的人_书桌版.mp4`、`original-films-07.zip:keynote-B-kaitou/B-kaitou.mp4`、`original-films-07.zip:keynote-C-kaitou/C-kaitou.mp4`、`original-films-07.zip:keynote-C-quanpian/C-quanpian.mp4`、`original-films-07.zip:keynote-seg1-kaijuan/seg1-kaijuan.mp4`、`original-films-07.zip:keynote-seg3-ranbiwa/seg3-ranbiwa.mp4`、`original-films-07.zip:local-baobian-film/豹变_B_zhuangshi.mp4`、`original-films-07.zip:local-baobian-film/豹变_C_qitan.mp4`、`original-films-07.zip:local-baobian-film/豹变_D_wushan.mp4`、`original-films-08.zip:local-baobian-film/豹变_A_shuimo.mp4`、`original-films-09.zip:local-beiming-film-9min/beiming_9min_1080.mp4`、`original-films-10.zip:local-anime-pv/AFTERGLOW_PV.mp4`、`original-films-10.zip:local-hypit-pipeline-film/film_upload.mp4`
- **仓库内的海报（10）**：`cases/previews/keynote-B-kaitou.jpg`、`cases/previews/keynote-C-kaitou.jpg`、`cases/previews/keynote-C-quanpian.jpg`、`cases/previews/keynote-seg1-kaijuan.jpg`、`cases/previews/keynote-seg3-ranbiwa.jpg`、`cases/previews/local-anime-pv.jpg`、`cases/previews/local-baobian-film.jpg`、`cases/previews/local-beiming-film-9min.jpg`、`cases/previews/local-hypit-pipeline-film.jpg`、`cases/previews/ppt-understands-you.jpg`
- **仓库内的归档源文件**：0 个

## R09 语音与音乐生成：MiniMax 语音合成、MiniMax-Music3、Edge TTS

- **权利方**：合成语音与音乐的权利归属以各服务或模型的条款为准（待补）（依据：MiniMax 语音合成：cases/source/ppt-jianlong/jianlong/CREDITS 旁白一节、各 ppt-* 案例的 tools/minimax_tts.py 与配音原始响应；MiniMax-Music3：cases/source/ppt-before-sunset/film/build.py:7、cases/source/local-baobian-film/tools/rog_music.sh:2；Edge TTS：cases/source/local-beiming-film-9min/audio/make_voices.py:12）
- **授权方**：MiniMax（法律主体待补）、微软（Edge 在线朗读服务）等服务方，按各自条款；MiniMax-Music3 本机部署部分按模型许可（待补）
- **授权范围**：待补（音色的商用范围、MiniMax-Music3 本机部署所用模型权重的许可）
- **期限**：待补
- **书面证据存放位置**：待补
- **状态**：服务条款与套餐待核对；历史 TTS 原始响应里留有已过期的签名下载链接，清单与处理脚本见 docs/rights/signed-urls.md
- **证据位置**：
  - cases/source/ppt-dance-mentor/方案.md:55（MiniMax 音色名）
  - cases/source/ppt-before-sunset/film/build.py:7（MiniMax 旁白与 Music3 分幕配乐）
  - cases/source/local-baobian-film/tools/rog_music.sh:2（MiniMax-Music3）
  - cases/source/local-beiming-film-9min/audio/make_voices.py:12（edge_tts）
- **义务与做法**：成片说明里写明「配音为 AI 合成」「配乐含 AI 生成」（aigc.md）；不复用来源不明的音色
- **agent 规则**：新作品的配音与配乐写进 film.json 的 credits 与 aigc 字段；没核对条款的音色不用于对外交付

**受影响案例（9）**

| 案例 | 标题 | 分组 | 受影响范围 | 文件数 |
|---|---|---|---|---|
| `local-baobian-film` | 豹变四版 | local-films | 成片用到 | — |
| `local-beiming-film-9min` | 北冥九分钟 | local-films | 成片用到 | — |
| `ppt-before-sunset` | 日落之前 | ppt-stories | 成片用到 | — |
| `ppt-dance-mentor` | 她的舞蹈导师 | ppt-stories | 成片用到 | — |
| `ppt-in-sight` | 目之所及 | ppt-stories | 成片用到 | — |
| `ppt-jianlong` | 见龙 | ppt-stories | 成片用到 | — |
| `ppt-new-year-street` | 这条街照常过年 | ppt-stories | 成片用到 | — |
| `ppt-painting-treasure` | 画境追宝 | ppt-stories | 成片用到 | — |
| `ppt-understands-you` | 懂你的人 | ppt-stories | 成片用到 | — |

- **Release 附件（casebook-2026.11）**：`original-films-04.zip`、`original-films-05.zip`、`original-films-06.zip`、`original-films-07.zip`、`original-films-08.zip`、`original-films-09.zip`
- **Release 预览（9）**：`local-baobian-film-preview.mp4`、`local-beiming-film-9min-preview.mp4`、`ppt-before-sunset-preview.mp4`、`ppt-dance-mentor-preview.mp4`、`ppt-in-sight-preview.mp4`、`ppt-jianlong-preview.mp4`、`ppt-new-year-street-preview.mp4`、`ppt-painting-treasure-preview.mp4`、`ppt-understands-you-preview.mp4`
- **成片（包内路径，19）**：`original-films-04.zip:ppt-dance-mentor/乐奇AR_她的舞蹈导师_故事介绍_手机版.mp4`、`original-films-04.zip:ppt-in-sight/IN_SIGHT_目之所及_故事介绍_手机版.mp4`、`original-films-04.zip:ppt-in-sight/IN_SIGHT_目之所及_故事介绍.mp4`、`original-films-04.zip:ppt-jianlong/见龙_印刷水墨版_v2新旁白_3分14秒_手机版.mp4`、`original-films-04.zip:ppt-jianlong/见龙_印刷水墨版_v2新旁白_3分14秒.mp4`、`original-films-05.zip:ppt-before-sunset/日落之前_故事介绍_手机版.mp4`、`original-films-05.zip:ppt-dance-mentor/乐奇AR_她的舞蹈导师_故事介绍.mp4`、`original-films-05.zip:ppt-understands-you/懂你的人_书桌版_手机版.mp4`、`original-films-05.zip:ppt-understands-you/懂你的人_书桌版.mp4`、`original-films-06.zip:ppt-before-sunset/日落之前_故事介绍.mp4`、`original-films-06.zip:ppt-new-year-street/这条街照常过年_故事介绍_手机版.mp4`、`original-films-06.zip:ppt-painting-treasure/画境追宝_故事介绍_手机版.mp4`、`original-films-06.zip:ppt-painting-treasure/画境追宝_故事介绍.mp4`、`original-films-07.zip:local-baobian-film/豹变_B_zhuangshi.mp4`、`original-films-07.zip:local-baobian-film/豹变_C_qitan.mp4`、`original-films-07.zip:local-baobian-film/豹变_D_wushan.mp4`、`original-films-07.zip:ppt-new-year-street/这条街照常过年_故事介绍.mp4`、`original-films-08.zip:local-baobian-film/豹变_A_shuimo.mp4`、`original-films-09.zip:local-beiming-film-9min/beiming_9min_1080.mp4`
- **仓库内的海报（9）**：`cases/previews/local-baobian-film.jpg`、`cases/previews/local-beiming-film-9min.jpg`、`cases/previews/ppt-before-sunset.jpg`、`cases/previews/ppt-dance-mentor.jpg`、`cases/previews/ppt-in-sight.jpg`、`cases/previews/ppt-jianlong.jpg`、`cases/previews/ppt-new-year-street.jpg`、`cases/previews/ppt-painting-treasure.jpg`、`cases/previews/ppt-understands-you.jpg`
- **仓库内的归档源文件**：0 个

## R10 上游开源快照与随库字体：LemoLab、肖雄 XIAOXIONG、Poly Haven、three.js、OFL 字体

- **权利方**：LemoLab；肖雄 XIAOXIONG；Poly Haven；three.js authors；各字体的版权人（见 REUSE.toml）（依据：cases/licenses/、cases/vendor/lemo-opuscar/README.md「Licence」节、cases/vendor/lemo-opuscar/core/assets/polyhaven/SOURCES.md、fonts/LICENSE.md）
- **授权方**：同权利方（公开许可）
- **授权范围**：lemo-opuscar：代码与文档 MIT，例片与静帧 CC BY 4.0；sy-style-100：MIT；Poly Haven：CC0；three.js：MIT；字体：SIL OFL 1.1
- **期限**：公开许可，无期限
- **书面证据存放位置**：许可全文在 LICENSES/ 与 cases/licenses/；逐路径对照在 REUSE.toml
- **状态**：公开许可，按许可义务使用
- **证据位置**：
  - REUSE.toml
  - THIRD-PARTY.md
  - cases/vendor/lock.json（固定提交与逐文件哈希）
- **义务与做法**：保留版权与许可声明；从上游改写进本仓库主体的代码写来源头（docs/rights/licensing.md）；复用 LemoLab 的例片静帧要按 CC BY 4.0 署名
- **agent 规则**：不就地修改 cases/vendor/；借鉴上游代码写进 engine/ 等目录时必须加来源头，规范检查 comp.provenance 会查
- **仓库主体里的相关文件**：`cases/vendor/**`、`cases/licenses/**`、`fonts/**`

## R11 公有领域与开放数据的图像、影像与数据（NASA、美国国会图书馆、USGS、NOAA、Wikimedia 公有领域图、Natural Earth 等）

- **权利方**：各素材来源（见各案例 CREDITS）
- **授权方**：公有领域或 CC0 / PDDL 等开放许可
- **授权范围**：按各自许可；公有领域无署名义务，案例 CREDITS 里的署名是致谢。另：大量风格案例用到 CC0 采样（VSCO 2 CE、VCSL、FreePats 的 CC0 部分），CC0 无署名义务，不逐案登记
- **期限**：公开许可，无期限
- **书面证据存放位置**：各案例 CREDITS 记录的来源链接
- **状态**：公开许可，按许可义务使用
- **证据位置**：
  - cases/source/style-56-briefing-board/CREDITS、style-57-lidar-survey/CREDITS、style-58-white-model/CREDITS、style-62-archive-lighttable/CREDITS、style-65-countdown/CREDITS 等
- **义务与做法**：保留来源说明；不暗示来源机构背书（如 style-57-lidar-survey/CREDITS:11 的写法）
- **agent 规则**：新用公有领域素材时在 CREDITS 或 film.json credits 写来源链接与许可依据

**受影响案例（17）**

| 案例 | 标题 | 分组 | 受影响范围 | 文件数 |
|---|---|---|---|---|
| `style-23-dataviz` | 地球的一秒 | styles | 成片用到 | — |
| `style-55-satellite-briefing` | 后退的冰川 | styles | 成片用到 | — |
| `style-56-briefing-board` | 悬索桥为何不倒 | styles | 成片用到 | — |
| `style-57-lidar-survey` | 火山口 | styles | 成片用到 | — |
| `style-58-white-model` | 涨潮一米 | styles | 成片用到 | — |
| `style-59-data-physical` | 一年的雨 · 处理方案（Treatment） | styles | 成片用到 | — |
| `style-61-microscope` | 一滴池塘水 | styles | 成片用到 | — |
| `style-62-archive-lighttable` | 十二秒 · 档案灯台（Archive Light Table）风格样片 | styles | 成片用到 | — |
| `style-63-caption-news` | 会用工具的海獭 | styles | 成片用到 | — |
| `style-64-newsreel` | 64 · 1920s 新闻影片 ·《空中竞速》TREATMENT | styles | 成片用到 | — |
| `style-65-countdown` | T−15 · 实时倒计时分屏 — 导演阐述 | styles | 成片用到 | — |
| `style-66-city-symphony` | 城市的一天 | styles | 成片用到 | — |
| `style-67-visual-investigation` | 大桥的五十九分钟 | styles | 成片用到 | — |
| `style-68-kino-montage` | 《大坝》TREATMENT · 构成主义蒙太奇（kino-montage） | styles | 成片用到 | — |
| `style-69-telestrator` | 《那一脚》 TREATMENT — 体育战术板 Sports Telestrator | styles | 成片用到 | — |
| `style-70-news-package` | 《本周天气》 · 电视新闻包装 风格样片（19.75 s） | styles | 成片用到 | — |
| `style-73-chalkboard` | 三个正方形 —— 黑板粉笔 · 风格样片 73 | styles | 成片用到 | — |

- **Release 附件（casebook-2026.11）**：`original-films-01.zip`、`original-films-02.zip`、`original-films-03.zip`
- **Release 预览（17）**：`style-23-dataviz-preview.mp4`、`style-55-satellite-briefing-preview.mp4`、`style-56-briefing-board-preview.mp4`、`style-57-lidar-survey-preview.mp4`、`style-58-white-model-preview.mp4`、`style-59-data-physical-preview.mp4`、`style-61-microscope-preview.mp4`、`style-62-archive-lighttable-preview.mp4`、`style-63-caption-news-preview.mp4`、`style-64-newsreel-preview.mp4`、`style-65-countdown-preview.mp4`、`style-66-city-symphony-preview.mp4`、`style-67-visual-investigation-preview.mp4`、`style-68-kino-montage-preview.mp4`、`style-69-telestrator-preview.mp4`、`style-70-news-package-preview.mp4`、`style-73-chalkboard-preview.mp4`
- **成片（包内路径，17）**：`original-films-01.zip:style-23-dataviz/23-dataviz.mp4`、`original-films-02.zip:style-55-satellite-briefing/55-satellite-briefing.mp4`、`original-films-02.zip:style-56-briefing-board/56-briefing-board.mp4`、`original-films-02.zip:style-57-lidar-survey/57-lidar-survey.mp4`、`original-films-02.zip:style-58-white-model/58-white-model.mp4`、`original-films-02.zip:style-59-data-physical/59-data-physical.mp4`、`original-films-02.zip:style-61-microscope/61-microscope.mp4`、`original-films-02.zip:style-62-archive-lighttable/62-archive-lighttable.mp4`、`original-films-02.zip:style-63-caption-news/63-caption-news.mp4`、`original-films-03.zip:style-64-newsreel/64-newsreel.mp4`、`original-films-03.zip:style-65-countdown/65-countdown.mp4`、`original-films-03.zip:style-66-city-symphony/66-city-symphony.mp4`、`original-films-03.zip:style-67-visual-investigation/67-visual-investigation.mp4`、`original-films-03.zip:style-68-kino-montage/68-kino-montage.mp4`、`original-films-03.zip:style-69-telestrator/69-telestrator.mp4`、`original-films-03.zip:style-70-news-package/70-news-package.mp4`、`original-films-03.zip:style-73-chalkboard/73-chalkboard.mp4`
- **仓库内的海报（17）**：`cases/previews/style-23-dataviz.jpg`、`cases/previews/style-55-satellite-briefing.jpg`、`cases/previews/style-56-briefing-board.jpg`、`cases/previews/style-57-lidar-survey.jpg`、`cases/previews/style-58-white-model.jpg`、`cases/previews/style-59-data-physical.jpg`、`cases/previews/style-61-microscope.jpg`、`cases/previews/style-62-archive-lighttable.jpg`、`cases/previews/style-63-caption-news.jpg`、`cases/previews/style-64-newsreel.jpg`、`cases/previews/style-65-countdown.jpg`、`cases/previews/style-66-city-symphony.jpg`、`cases/previews/style-67-visual-investigation.jpg`、`cases/previews/style-68-kino-montage.jpg`、`cases/previews/style-69-telestrator.jpg`、`cases/previews/style-70-news-package.jpg`、`cases/previews/style-73-chalkboard.jpg`
- **仓库内的归档源文件**：0 个

## R12 《北冥》样片与本项目自有影像（底板、样片、展示图、作品站画面）

- **权利方**：待补（根 LICENSE 与 REUSE.toml 暂写「北冥引擎 Beiming Engine」，这是项目名，不是法律主体）（依据：审计 COMP-07；《北冥》与乐奇项目的关系：fonts/fetch_fonts.sh:11（「AI眼镜·品牌短片·概念样片」）、src/girl.js:13（眼镜外形照 AI 眼镜产品图）、审计 COMP-01 ⑤）
- **授权方**：不适用（自有作品）；如属委托作品，委托方与权利约定待补
- **授权范围**：保留所有权利（LICENSES/LicenseRef-AllRightsReserved.txt）
- **期限**：待补
- **书面证据存放位置**：待补（若《北冥》属于乐奇项目的委托作品，合同中的权利约定存放位置）
- **状态**：本项目作品，权利主体待补；绘画底板是 AI 生成后人工整理（R08），对外描述不得写成手绘或代码逐帧绘制
- **证据位置**：
  - LICENSE 第 3 行（项目名作版权人）
  - assets/plates/plates.json:3
  - Release v1.0：beiming.mp4、beiming_4k.mp4
- **义务与做法**：对外发布时带 AIGC 标识（aigc.md）；法律主体补来后同步改 LICENSE、REUSE.toml 与本条
- **agent 规则**：新作品可以学《北冥》的方法与代码（MIT），不得直接拿它的底板、画面或成片当素材
- **对外分发点**：Release v1.0（beiming.mp4、beiming_4k.mp4）；仓库 media/ 与作品站首页
- **仓库主体里的相关文件**：`media/**`、`assets/**`、`site/assets/**`、`docs/raea/media/**`、`audio/score_cache.npz`

## R13 上游原生运行时 RAEA（B 路线 · 北冥原生 · BNE 调用，不随仓库分发）

- **权利方**：Shane Murphy（上游仓库 shinyobjectz/raea 的版权人）（依据：上游 LICENSE（固定提交 fb3f70844e03cc40185e3a06c394060d26c5cd38）；THIRD-PARTY.md 第 1 节）
- **授权方**：同权利方（按 FSL-1.1-ALv2 公开许可）
- **授权范围**：FSL-1.1-ALv2：允许内部使用、为本身持有许可的客户提供专业服务；排除竞争性使用（对外提供替代 RAEA 或功能实质相似的商业产品或服务）；每个版本发布满两年转为 Apache-2.0
- **期限**：实际运行的 v0.1.0-canary.2（2026-10-31 发布）于 2028-10-31 转为 Apache-2.0；升级版本时按新版本的发布日另算
- **书面证据存放位置**：公开许可，以上游固定提交的 LICENSE 为准；若要对外商业化，所需的书面商业许可或法律意见：待补
- **状态**：公开许可，按许可义务使用；按 D03 只作内部制作层：用于自制影片与向客户交付成片，不作为对外的产品、SDK 或渲染服务；运行时与 SDK 不随本仓库分发
- **证据位置**：
  - docs/decisions/2026-11-10-industrial-baseline.md D03、D04
  - docs/rights/fsl-boundary.md（允许与禁止、固定版本与转换日期、对外署名句）
  - docs/raea/README.md（源码固定提交与运行版本）
  - THIRD-PARTY.md 第 1 节
- **义务与做法**：不分发运行时、不复制或改写其源码；对外署名用 fsl-boundary.md 的固定署名句；升级运行时版本的同一提交里更新转换日期
- **agent 规则**：B 路线只写调用 RAEA 公开接口的自有代码，不加 Rust / WESL 文件；有人要把渲染做成服务、把 BNE 给别人用或承诺商业化，先问用户
- **对外分发点**：不分发（每台机器单独取得，用 RAEA_BIN 指向）
- **仓库主体里的相关文件**：`engine/native/**`、`examples/raea/**`、`docs/raea/**`

## AI 生成内容的标识（D11）

- 作品含 AI 生成的画面、配音或配乐：片尾与作品说明写显式标识（「含 AI 生成画面」「配音为 AI 合成」「配乐含 AI 生成」），成片 mp4 的 comment 写 `AIGC{…}` 隐式标识（`node tools/compliance/aigc.mjs label` 生成、`check` 核对）。
- 生成的原图保留 C2PA；处理过的派生图写入引用原图的新清单，或在底板清单里逐张记录来源链。《北冥》13 张底板目前只有清单级的生成记录，逐张来源待补（R08）。
- 对外不把 AI 生成的底板写成「手绘」或「代码逐帧绘制」；生成服务的条款与套餐登记在 R08、R09。
- 全文：[aigc.md](aigc.md)。

## B 路线的 FSL 使用边界（D03）

- 上游原生运行时 RAEA 的许可是 FSL-1.1-ALv2（R13）。允许：内部制作、给客户做片并交付成片、为本身持有许可的客户提供专业服务。
- 不允许：把 BNE、engine/native 或任何基于 RAEA 的东西做成对外的商业产品、SDK、托管渲染服务；分发运行时；把上游源码搬进本仓库；用上游名当我方产品名。
- 固定版本：源码对照 fb3f70844e03cc40185e3a06c394060d26c5cd38；运行 v0.1.0-canary.2（2026-10-31 发布），2028-10-31 转为 Apache-2.0。
- 商业化之前先取得上游书面许可或法律意见，结论登记进本册。全文：[fsl-boundary.md](fsl-boundary.md)。

## 怎么更新

1. 用户补来授权信息：改 `docs/rights/register.json` 对应字段（权利方、授权方、范围、期限、书面证据存放位置），把 status 改成相应状态。
2. 新增第三方或客户素材：先在 register.json 加一类或扩展 match，再入库或发布。
3. 重新生成并核对：`node tools/compliance/rights-inventory.mjs --write`，然后 `node tools/compliance/rights-inventory.mjs --check`。
