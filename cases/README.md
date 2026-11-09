# 北冥案例库

> 读者：要找旧作品源码、还原工程或核对状态的人｜状态：归档说明｜依据：2026-11-07 归档，`catalog.json` 第 1 版

把已经做过的作品、实验和两套完整风格库收在一个入口。**作品状态、原始来源和复现条件分别记录。**作品站展示其中有观看预览的 79 部（北冥代码动画风格 66、PPT 故事介绍片 7、发布会动画 6），其余记录只在这里归档。

[浏览全部案例](INDEX.md) · [打开画廊](index.html) · [两库源码对比](../docs/cases/comparison.md) · [PPT 动画流程](../docs/cases/ppt-animation.md) · [下载成片与素材包](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/tag/casebook-2026.11)

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

七部作品和发布会版本完整列在 [INDEX.md](INDEX.md)。`*-preview.mp4` 是从历史影片转码的 960 像素宽观看版；原画质、手机版和其他原始版本在 `original-films-*.zip` 中保留原始字节。观看版不是新的渲染成果。

## 找到代码，然后还原

```bash
python3 tools/casebook.py list --group ppt-stories
python3 tools/casebook.py check
python3 tools/casebook.py restore style-02-watercolor --source-only
```

只还原源码的目录不能用于完整出片。需要素材时，用**另一个不存在的输出目录**还原：

```bash
python3 tools/casebook.py restore style-02-watercolor --download --out out/casebook-full
# 若已经手动下载了素材包
python3 tools/casebook.py restore ppt-in-sight --packs /path/to/release-packs
```

默认还原到 `out/casebook/` 下的历史相对目录，保留跨目录关系。工具拒绝覆盖已有目录，校验素材包与文件的 SHA256，不执行安装、网络推理或渲染。`--download` 只取所需素材包，不下载全部成片；素材包是共享的，单个案例也可能需要多个包。

lemo-opuscar 的路径默认指向仓库内的 `cases/vendor/lemo-opuscar`；已经准备好另一套环境时用 `--lemo /path/to/lemo-opuscar`。原始构建方法和依赖原样保留，不保证换一个操作系统就能直接运行全部脚本。旧脚本中的远端主机以 `@@ROG_HOST@@` 标记，只有传 `--rog-host` 才替换。

## 怎样组织与去重

- `source/`：可浏览的历史项目源文件。相同文件只存一份，案例的文件映射指向规范副本。
- `vendor/`：两个上游固定提交的全部 Git 跟踪文件，共 2809 个，逐文件核对 Git blob 与 SHA256；完整目录、许可证、工具和资产都在。
- `catalog.json`：96 条记录、2554 个代码与文本文件位置、6656 个唯一二进制素材、97 个原始视频版本及还原映射。这些计数和独立影片数不是一回事。
- `entries/`：每个案例的入口、历史状态和文件下载。
- `references.json`：sy-style-100 的 100 个示例与 lemo-opuscar 66 种风格的固定版本源码链接，另有本机案例映射。
- `previews/`、`index.html`：小预览和无外部依赖的可筛选画廊。GitHub 不直接执行 HTML；克隆后可直接打开，或用本地静态服务预览。
- Release：输入素材、完整实验图、原始影片和压缩观看版；源码仓库不放视频缓存帧或虚拟环境。

素材与代码精确去重，避免了约 **764 MB** 重复保存；另有 137 处与 lemo-opuscar 逐字一致的代码直接引用 vendor 快照。不同参数、不同剪辑和不同分辨率按版本保留，不误删成“重复作品”。归档排除了安装依赖、秘密配置、缓存帧、原始 LiDAR 下载分块和预演参考的原电影片段，不是整块磁盘镜像。

## 继续制作前

先读案例卡的状态与入口，再读该片方案；修改还原后的副本，不改历史快照。延续北冥风格路线还是改走北冥原生路线，仍从 [ROUTES.md](../ROUTES.md) 选择。

《豹变》四版、北冥九分钟和部分 15 秒试验保留失败或未获认可的背景。**存在 MP4、代码通过技术检查、画面被认可，是三个不同状态。**

验证记录见 [归档验收](../docs/cases/verification.md)。权利范围见 [NOTICES.md](NOTICES.md)；完整外部代码不因存入北冥仓库而变成北冥原创。
