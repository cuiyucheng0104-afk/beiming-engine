# 北冥案例库

> 读者：要找旧作品源码、还原工程或核对状态的人｜状态：归档说明｜依据：2026-11-07 归档；`catalog.json` 第 2 版（2026-11-10 起技术状态、用户认可、权利三者分开记录）

把已经做过的作品、实验和两套完整风格库收在一个入口。**作品状态、原始来源、复现条件和权利分别记录。**作品站展示其中有观看预览的 79 部（北冥代码动画风格 66、PPT 故事介绍片 7、发布会动画 6），其余记录只在这里归档。

[浏览全部案例](INDEX.md) · [打开画廊](index.html) · [案例库工具](../docs/cases/casebook.md) · [两库源码对比](../docs/cases/comparison.md) · [PPT 动画流程](../docs/cases/ppt-animation.md) · [下载成片与素材包](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/tag/casebook-2026.11)

| 内容 | 数量 | 保存方式 |
|---|---:|---|
| 北冥代码动画风格（风格实验） | 66 | 原故事与源代码、时间轴、声音程序、素材及成片 |
| PPT 故事介绍片 | 7 | 原画分层、配音字幕、生成与剪辑脚本、版本与成片 |
| 发布会动画 | 6 + 1 | 6 个工程与 1 组共用资源 |
| 北冥画风实验 | 4 | 色阶 40 组、九景 360 图、九景三维与 15 秒四组试验，完整参数、模型和成图 |
| 其他动画与预演工程 | 12 | 含《豹变》四版、九分钟试作、机械动画、代码讲解等 |
| sy-style-100 完整风格库 | 20 种风格 / 100 个示例 | [331 个原仓库文件](vendor/sy-style-100/) |
| lemo-opuscar 完整风格库 | 66 种风格 | [2478 个原仓库文件](vendor/lemo-opuscar/) |

两套风格库是第三方开源项目的固定快照，来源与许可见 [THIRD-PARTY.md](../THIRD-PARTY.md) 与 [NOTICES.md](NOTICES.md)。

## 先看 PPT 改编成果

| 见龙 | 目之所及 | 她的舞蹈导师 |
|---|---|---|
| [![见龙](previews/ppt-jianlong.jpg)](entries/ppt-jianlong.md) | [![目之所及](previews/ppt-in-sight.jpg)](entries/ppt-in-sight.md) | [![她的舞蹈导师](previews/ppt-dance-mentor.jpg)](entries/ppt-dance-mentor.md) |

七部作品和发布会版本完整列在 [INDEX.md](INDEX.md)。`*-preview.mp4` 是从历史影片转码的 960 像素宽观看版；原画质、手机版和其他原始版本在 `original-films-*.zip` 中保留原始字节。观看版不是新的渲染成果。PPT 故事介绍片与发布会动画含客户材料与第三方 IP（权利标为内部，见下文）。

## 三种状态，分开看

| 状态 | 取值 | 怎么用 |
|---|---|---|
| 技术状态 | 历史成片、画风实验、技术预演、交互实验、共用资源 | 只说明输出过什么；归档时没有重渲，机器 QA 未跑 |
| 用户认可 | 用户认可、未获认可、未审 | 目前 0 条认可、3 条未获认可（原因未记录，待用户补充）、其余未审。**上作品站不等于用户认可**，挑参考片时不要当成“已认可” |
| 权利 | 公开、内部 | 内部＝含客户材料、第三方 IP 或参考图（[授权登记册](../docs/rights/register.md)）：已有的展示照旧（决定 D02），但素材不得用进新作品或对外物料，`restore` 默认不还原 |

状态写在每张案例卡的「状态与权利」表和 `catalog.json` 的 `technical`、`approval`、`rights` 字段里，字段说明见 [案例库工具](../docs/cases/casebook.md)。

## 找到代码，然后还原

命令在仓库根目录执行，三个平台写法一样（`tools/env/py.mjs` 会找到仓库选定的 Python；Windows 上通常没有 `python3`）：

```bash
node tools/env/py.mjs tools/casebook.py list --group ppt-stories
node tools/env/py.mjs tools/casebook.py check
node tools/env/py.mjs tools/casebook.py restore style-02-watercolor --source-only
```

`npm run cases:list`、`npm run cases:check` 是同样的命令。只还原源码的目录不能用于完整出片。需要素材时，先看要下载多少，再用**另一个不存在的输出目录**还原：

```bash
node tools/env/py.mjs tools/casebook.py restore style-02-watercolor --download --out out/casebook-full --dry-run
node tools/env/py.mjs tools/casebook.py restore style-02-watercolor --download --out out/casebook-full
# 若已经手动下载了素材包
node tools/env/py.mjs tools/casebook.py restore style-62-archive-lighttable --packs <素材包目录>
```

- 默认还原到 `out/casebook/` 下的历史相对目录，保留跨目录关系。工具拒绝覆盖已有目录（`--if-exists skip` 跳过），校验素材包与文件的 SHA256，不执行安装、网络推理或渲染。
- `--download` 只取所需素材包，边下边算 SHA256；中断后重跑同一条命令从断点续传，网络出错自动重试（`--retries`），也可以用 `--mirror <网址>` 从镜像取（同样按 catalog 的 SHA256 校验）。下载与还原前检查磁盘空间。素材包是共享的，单个案例也可能需要多个包。
- **内部素材默认不还原**：权利为内部的案例与素材（客户材料、第三方 IP、参考图）只在加 `--include-internal` 时写出，只为研究方法，产物不得对外。
- 还原目录里有 `ARCHIVE-RESTORED.json`（改写与残留标记的明细）、`RIGHTS.json`（权利、认可状态与署名）和 `ARCHIVE-LICENSES/`（字体 OFL、LemoLab MIT 等许可文本）。
- lemo-opuscar 的路径默认指向仓库内的 `cases/vendor/lemo-opuscar`；已经准备好另一套环境时用 `--lemo <目录>`。原始构建方法和依赖原样保留，不保证换一个操作系统就能直接运行全部脚本。
- 旧脚本中的远端主机以 `@@ROG_HOST@@` 标记，只有传 `--rog-host` 才替换；没替换的标记逐行写进报告的 `unresolvedTokens`，加 `--strict` 时拒绝还原（退出 3）。

## 怎样组织与去重

- `source/`：可浏览的历史项目源文件。相同文件只存一份，案例的文件映射指向规范副本。
- `vendor/`：两个上游固定提交的全部 Git 跟踪文件，共 2809 个，逐文件核对 Git blob 与 SHA256；完整目录、许可证、工具和资产都在。只读。
- `catalog.json`：96 条记录、2554 个代码与文本文件位置（2243 个唯一源文件）、6656 个唯一二进制素材、97 个原始视频版本及还原映射，以及每个案例的技术状态、用户认可与权利。这些计数和独立影片数不是一回事。
- `entries/`、`INDEX.md`、`index.html`：案例卡、目录与离线画廊，由 `casebook.py index` 从 catalog 生成，不要手改。
- `references.json`：sy-style-100 的 100 个示例与 lemo-opuscar 66 种风格的固定版本源码链接，另有本机案例映射。
- `licenses/`：随归档分发的许可文本（LemoLab、肖雄 XIAOXIONG、three.js 的 MIT 声明，字体的 OFL 1.1）。
- Release：输入素材、完整实验图、原始影片和压缩观看版；源码仓库不放视频缓存帧或虚拟环境。

素材与代码精确去重，避免了约 **764 MB** 重复保存；另有 137 处与 lemo-opuscar 逐字一致的代码直接引用 vendor 快照。不同参数、不同剪辑和不同分辨率按版本保留，不误删成“重复作品”。归档排除了安装依赖、缓存帧、原始 LiDAR 下载分块和预演参考的原电影片段，不是整块磁盘镜像。

隐私与脱敏：历史配音的 TTS 原始响应里过期的签名下载链接已在 2026-11-10 去掉查询串（281 个文件，catalog 里记 `redactions`）；还原标记文件不再公开脱敏前的哈希（`originalSha256`）。归档文本里仍有约 150 处原机的本机路径与工作站目录写法（只报告不阻塞，逐条清单：`node tools/compliance/scan.mjs --only local-paths --scope archive`）。

## 继续制作前

先读案例卡的状态与入口，再读该片方案；修改还原后的副本，不改历史快照。新作品从 [路线总指引](../routes/README.md) 选路线；C 路线的风格选型见 [风格索引](../routes/c-style/STYLES.md)。

《豹变》四版、北冥九分钟和部分 15 秒试验保留失败或未获认可的背景。**存在 MP4、代码通过技术检查、画面被用户认可，是三个不同状态。**

验证记录见 [归档验收](../docs/cases/verification.md)。权利范围见 [NOTICES.md](NOTICES.md) 与 [授权登记册](../docs/rights/register.md)；完整外部代码不因存入北冥仓库而变成北冥原创。
