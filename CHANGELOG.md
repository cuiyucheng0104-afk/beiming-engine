# 更新日志

本文件记录北冥引擎每个版本的变更。格式遵循 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)。分类标题沿用规范的英文关键字（Added、Changed、Deprecated、Removed、Fixed、Security），方便工具解析；条目用中文。

- 每个合入 main 的改动，在 [Unreleased] 的对应分类下加一条：写清改了什么，以及对作品或 agent 有什么影响。只写已经合入的改动，不写计划。
- 发布时，把 [Unreleased] 的条目移到新的 `## [X.Y.Z] - YYYY-MM-DD` 下，同步 `package.json` 的 version，提交后打 `vX.Y.Z` 标签。`.github/workflows/release.yml` 会先跑整套 CI，再用本文件的对应段落建一个草稿 Release，人工核对后再发布。步骤见 [tests/ci/README.md](tests/ci/README.md#发布)。
- 校验：`node tests/ci/changelog.mjs check`，它也是 `npm run check` 的一步。

## [Unreleased]

这一段汇总从 v1.0 到工业级交付升级完成前的全部变更。工业级升级以 [docs/decisions/2026-11-10-industrial-baseline.md](docs/decisions/2026-11-10-industrial-baseline.md) 的 D01–D11 为准，拆成多个工作包推进。目标是让仓库成为一个按 A、B、C 三条路线组织的技术模版仓库：agent 读完入口文档就能选对路线、按模版建作品、用统一的命令出片，成片先过机器 QA 与人工创作闸门，才标为交付。各工作包合入时，在下面的分类里追加自己的条目。

### Added

- 三条路线的模版仓库结构：`routes/README.md` 总指引；A（北冥风格路线 · WebGL 三渲二）、B（北冥原生 · BNE）、C（北冥代码动画风格 · 86 式）各有一份路线手册和一个可直接出片的模版。`node tools/new-film.mjs <a|b|c> <名字>` 从模版新建作品到 `films/<名字>/`。
- 仓库规范检查 `npm run check:repo`（`tools/repo-check.mjs`）：检查路线手册的章节、模版的 `film.json`、相对链接、引擎模块的中文头注释、内部代号，以及作品记录。
- B 路线通用原生层 `engine/native/`：three.js 对象经资产桥导出 GLB（含骨骼与 morph 动作，导出后做结构检查和回读），另有素材准备、序列帧图集和原生渲染入口 `engine/render/native.mjs`。原生运行时不随仓库分发。
- C 路线公共件：86 式风格索引 `routes/c-style/STYLES.md`（由 `tools/c-styles.mjs` 生成并校验）、节拍与声画事件 `engine/core/tempo.js`、事件导出 `engine/render/events.mjs`、页面型作品的一条命令出片 `engine/render/build.mjs`，以及拍点核对 `engine/audio/cuecheck.py`。
- 案例库 `cases/`：收录历史作品源码，以及两套第三方风格库的固定快照。`tools/casebook.py` 提供 list、check、restore（按 SHA256 校验去重后的归档，可还原到独立工作区）；素材包放在 Release `casebook-2026.11`。
- 作品站：源码在 `site/`，由 `tools/build-showcase.py` 构建，`.github/workflows/pages.yml` 发布到 GitHub Pages。
- 生产契约的最小实现 `engine/production/project.js`：校验 ProjectSpec 与 RenderResult 的字段，附 13 项测试。
- 导演与画面规范 `routes/directing/`：导演方法、画面设计、五章工艺，以及阐述与画风锁定模版；`tools/check_directing_docs.py` 检查其中的命名与路径。
- 工业级交付基线决策 `docs/decisions/2026-11-10-industrial-baseline.md`（D01–D11）。
- 测试总入口 `tools/run-tests.mjs`（`npm test`）：显式发现 `tests/**` 与 `tools/` 下的 Node 测试和 Python unittest，不再跑进 `cases/` 下历史作品自带的 test.js。支持用 `--only`、`--skip` 按域筛选，`--json` 输出运行记录，退出码与超时清理遵守统一命令约定（附录 C1、C2）。域可以用 `tests/<域>/suite.json` 声明对浏览器、FFmpeg、Python 模块的要求，缺少时整域跳过并说明原因。
- 检查总入口 `tools/check-all.mjs`（`npm run check`）：依次跑规范检查、工程计划、测试、风格索引、案例库、导演规范、语法和更新日志；另外统计 eslint 与 ruff 的告警数量，只报告、不阻塞。
- 持续集成 `.github/workflows/ci.yml`，共四个 job：unit（Node 24 与 22、Python 3.12）；check；smoke-render（SwiftShader 软件 WebGL 下，以小尺寸为 A、C 模版出片，并渲《北冥》静帧；有金标准清单时比对，没有时首次采集并上传成工件）；windows-paths（PowerShell 下的目录联接与中文路径）。所有 actions 都固定到提交哈希。
- 发布流程 `.github/workflows/release.yml`：推 `v*` 标签后先跑整套 CI，再从本文件取对应段落生成 Release 说明，建成草稿，人工核对后发布。只附 CI 冒烟接触印，不上传大文件。
- 编辑器与静态检查配置：`.editorconfig`；`eslint.config.js` 与 `ruff.toml`，先只报告不阻塞；`.github/dependabot.yml`，每周检查 npm、pip、GitHub Actions 的更新。

### Changed

- 引擎从 v1.0 的 7 个文件重构成九层：core（时间与数学）、form（程序化造型）、shade（卡通着色）、stage（镜头与舞台）、look（后期）、paint（Canvas 2D 绘画）、overlay（显示层）、audio（声音）、render（出片），外加 production（生产契约）。《北冥》样片改为调用这些层，`src/` 只留本片的镜头、造型与色板。
- 三条路线的对外品牌名统一为：北冥风格路线 · WebGL 三渲二、北冥原生 · BNE、北冥代码动画风格 · 86 式（D04）。
- README、AGENTS、ROUTES 等入口文档改为按三条路线组织。按 D01 的整合仍在进行。

### Fixed

- 作品站首屏剧照 404：Pages 构建现在会传入 media 前缀。

## [1.0.0] - 2026-11-04

### Added

- 首次公开发布（标签 `v1.0`）：《北冥》10 秒概念样片，包括三个镜头、六种鲲造型、卡通着色、墨线后期和显示层（`src/`）。
- 引擎 `engine/`：确定性数学、单纯形噪声、手绘笔触；用无头 Chrome 加 FFmpeg 逐帧渲染，另有静帧与音画封装。
- 声音 `audio/`：程序化音效、采样配乐、混音与自检。
- 支持任意分辨率的原生渲染，RTX 工作站走 Vulkan 后端。Release 附 1080p 成片和原生 3840×2080 成片。

[Unreleased]: https://github.com/cuiyucheng0104-afk/beiming-engine/compare/v1.0...HEAD
[1.0.0]: https://github.com/cuiyucheng0104-afk/beiming-engine/releases/tag/v1.0
