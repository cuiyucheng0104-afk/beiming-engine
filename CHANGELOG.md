# 更新日志

本文件记录北冥引擎每个版本的变更。格式遵循 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)。分类标题沿用规范的英文关键字（Added、Changed、Deprecated、Removed、Fixed、Security），方便工具解析；条目用中文。

- 每个合入 main 的改动，在 [Unreleased] 的对应分类下加一条：写清改了什么，以及对作品或 agent 有什么影响。只写已经合入的改动，不写计划。
- 会改变《北冥》画面或混音的改动，条目里写明改了哪些镜头、是否只在 4K 生效；接口不兼容的改动在条目开头标「不兼容」。
- 发布时，把 [Unreleased] 的条目移到新的 `## [X.Y.Z] - YYYY-MM-DD` 下，同步 `package.json` 的 version，提交后打 `vX.Y.Z` 标签。`.github/workflows/release.yml` 会先跑整套 CI，再用本文件的对应段落建一个草稿 Release，人工核对后再发布。步骤见 [tests/ci/README.md](tests/ci/README.md#发布)。
- 校验：`node tests/ci/changelog.mjs check`，它也是 `node tools/check-all.mjs`（`npm run check`）的一步。

## [Unreleased]

这一段汇总从 v1.0 到工业级交付升级完成前的全部变更，按合入顺序归类。升级以 [docs/decisions/2026-11-10-industrial-baseline.md](docs/decisions/2026-11-10-industrial-baseline.md) 的 D01–D11 为准，拆成多个工作包推进，目标是让仓库成为按 A、B、C 三条路线组织的技术模版仓库：agent 读完入口文档就能选对路线，按模版建作品，用统一的命令出片；成片先过机器 QA 与人工创作闸门，才标为交付；每个 PR 都有测试、无显卡冒烟出片与 Windows 路径检查把关。各工作包合入时，在下面的分类里追加自己的条目。

### Added

- 三条路线的模版仓库结构：`routes/README.md` 是总指引；A（北冥风格路线 · WebGL 三渲二）、B（北冥原生 · BNE）、C（北冥代码动画风格 · 86 式）各有一份路线手册和一个可直接出片的模版。`node tools/new-film.mjs <a|b|c> <名字>` 从模版新建作品到 `films/<名字>/`。
- 导演与画面规范 `routes/directing/`：导演方法、画面设计、五章工艺，以及阐述与画风锁定模版；`tools/check_directing_docs.py` 检查其中的命名与路径。
- 工业级交付基线决策 `docs/decisions/2026-11-10-industrial-baseline.md`（D01–D11）。
- 仓库规范检查 `tools/repo-check.mjs`（`npm run check:repo`）：检查路线手册的章节、模版的 `film.json`、相对链接、引擎模块的中文头注释、内部代号，以及作品记录。
- B 路线通用原生层 `engine/native/`：three.js 对象经资产桥导出 GLB（含骨骼与形变动作，导出后做结构检查和回读），另有素材准备、序列帧图集和原生渲染入口 `engine/render/native.mjs`。原生运行时不随仓库分发。
- C 路线公共件：86 式风格索引 `routes/c-style/STYLES.md`（由 `tools/c-styles.mjs` 生成并校验）、节拍与声画事件 `engine/core/tempo.js`、事件导出 `engine/render/events.mjs`、页面型作品的一条命令出片 `engine/render/build.mjs`，以及拍点核对 `engine/audio/cuecheck.py`。
- 案例库 `cases/`：收录历史作品源码，以及两套第三方风格库的固定快照。`tools/casebook.py` 提供 list、check、restore（按 SHA256 校验去重后的归档，可还原到独立工作区）；素材包放在 Release `casebook-2026.11`。
- 作品站「黄昏纸上」（`site/`）：首屏用 `src/kun_qinglv.js` 实时渲染青绿仙山鲲，毛笔标题按笔顺写出；滚动拆层讲解引擎；79 部作品排成接触印样与胶片条；减少动态、无 WebGL、无 JS 三种降级。整站构建 `tools/build-showcase.py`，浏览器验收 `tools/site-qa.mjs`（S1–S9），`.github/workflows/pages.yml` 发布到 GitHub Pages。
- 生产契约的最小实现 `engine/production/project.js`：校验 ProjectSpec 与 RenderResult 的字段。
- `.gitattributes`：文本一律按 LF 检出（Windows 也一样），`cases/source`、`cases/vendor` 按原字节保存。
- 回归测试：引擎各层（`engine/{form,look,overlay,paint,shade,stage}/*.test.mjs`，其中 `engine/look/gpu.test.mjs` 在无头 Chrome 里读回像素）、正片源码（`lab/regress.test.mjs`）、声音（`engine/audio/test_audio.py`、`audio/test_*.py`）、渲染管线的失败路径与色彩标注（`tests/production/render-*.test.mjs`）。
- 测试总入口 `tools/run-tests.mjs`（登记为 `npm test`）：发现仓库自己的全部 Node 与 Python 测试（`tests/**`、与源码放在一起的 `*.test.mjs`、`test_*.py`），不进 `cases/`、`films/` 和夹具目录；按域筛选（`--only`、`--skip`）、按名字筛选与隔离（`--grep`、`--skip-grep`）、`--json` 运行记录；测试因缺声明过的依赖而导入失败时判为环境缺失（退出码 3）并给出安装命令；超时与中断时结束整棵进程树。
- 检查总入口 `tools/check-all.mjs`（登记为 `npm run check`）：依次跑仓库规范、工程计划、测试、风格索引、案例库、导演规范、语法（JS、Python、JSON、sh）和更新日志；另外统计 eslint 与 ruff 的告警数量，只报告、不阻塞（`npm run lint`）。
- 持续集成 `.github/workflows/ci.yml`，五个 job：unit（Node 24 与 22、Python 3.12）；check；smoke-render（SwiftShader 软件 WebGL 与 FFmpeg 8 下再跑一遍全部测试，A、C 模版小尺寸出片并核对尺寸、帧数、BT.709 标注、−14 LUFS 与真峰值，B 模版资产桥导出并核对两次逐字节相同，渲《北冥》与 lab 静帧，与 linux-swiftshader 金标准比对或首次采集）；env-smoke（Linux、macOS、Windows 三平台按锁文件装环境并自检）；windows-paths（PowerShell、无 Git Bash 下的测试、检查、目录联接与中文路径、GBK 管道）。actions 都固定到提交哈希。本机复现方法见 `tests/ci/README.md`。
- 发布流程 `.github/workflows/release.yml`：推 `v*` 标签后核对标签、版本号与本文件，跑整套 CI，再用本文件的对应段落建草稿 Release，附 CI 接触印与 1920×1040 静帧，人工核对后发布。`tests/ci/changelog.mjs` 校验本文件并取出各版本的说明。
- 编辑器与静态检查配置：`.editorconfig`；`eslint.config.js` 与 `ruff.toml`（只开真错误类规则，先只报告）；`.github/dependabot.yml`，每周检查 npm、pip、GitHub Actions 的更新（新版本发布满 14 天才提；three 与 playwright-core 不自动升级）。

### Changed

- 引擎从 v1.0 的 7 个文件重构成九层：core（时间与数学）、form（程序化造型）、shade（卡通着色）、stage（镜头与舞台）、look（后期）、paint（Canvas 2D 绘画）、overlay（显示层）、audio（声音）、render（出片），外加 production（生产契约）。《北冥》样片改为调用这些层，`src/` 只留本片的镜头、造型与色板。
- 三条路线的对外品牌名统一为：北冥风格路线 · WebGL 三渲二、北冥原生 · BNE、北冥代码动画风格 · 86 式（D04）。README 重写，新增 `docs/README.md` 导航；作品文案改为如实口径（由代码合成出片，素材来源见案例卡）。
- 出片色彩全链路改为 BT.709 有限范围，并完整标注矩阵、原色、传递特性与范围（成片为 yuv420p / tv / bt709）；以前标的是全范围 BT.601，按 BT.709 解读时绿色通道偏差约 22 级。
- 成片响度由 −14.9 LUFS 校正到 −14.0 LUFS（线性增益，不改变动态范围）。
- 《北冥》1080p 画面有三处有意变化：R24 渡船的红绿航行灯换到正确的舷侧，R30 鸽群的黑边消失，R66 导航线的线头。只在 4K 生效的修复：R17、R19、R31、R32、R45。
- `npm run showcase:build` 改名为 `npm run site:build`，另有 `site:serve`、`site:qa`。

### Removed

- 不兼容：`engine/core/noise.js` 的 `createNoise2D` / `createNoise3D` 不再接受无种子调用（以前默认用 `Math.random`，分段并行渲染时各段画面会对不上）。调用时传入种子随机源，例如 `createNoise3D(mulberry(7))`。
- 旧作品站的生成物 `showcase/`（由 `site/` 与 `tools/build-showcase.py` 取代）。

### Fixed

- 渲染失败不再挂起：`render(t)` 抛错、页面异常、等 READY 或单帧超时、FFmpeg 中途退出、收到 SIGTERM 时，`engine/render/video.mjs` 在有限时间内以非零码退出，并清掉分段临时目录与子进程；`DUR`、`FPS` 写错直接报出收到的值。
- 音频比画面短几毫秒时，封装不再丢掉最后一帧。
- 姿态与动画只依赖时刻，不在调用之间留状态，逐帧单独重渲与顺序渲染得到相同画面。
- 案例库还原不再读写家目录。
- 作品站首屏剧照 404：Pages 构建现在会传入 media 前缀。

## [1.0.0] - 2026-11-04

### Added

- 首次公开发布（标签 `v1.0`）：《北冥》10 秒概念样片，包括三个镜头、六种鲲造型、卡通着色、墨线后期和显示层（`src/`）。
- 引擎 `engine/`：确定性数学、单纯形噪声、手绘笔触；用无头 Chrome 加 FFmpeg 逐帧渲染，另有静帧与音画封装。
- 声音 `audio/`：程序化音效、采样配乐、混音与自检。
- 支持任意分辨率的原生渲染，RTX 工作站走 Vulkan 后端。Release 附 1920×1040 成片 `beiming.mp4` 和原生 3840×2080 成片 `beiming_4k.mp4`。

[Unreleased]: https://github.com/cuiyucheng0104-afk/beiming-engine/compare/v1.0...HEAD
[1.0.0]: https://github.com/cuiyucheng0104-afk/beiming-engine/releases/tag/v1.0
