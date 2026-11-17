# 更新日志

本文件记录北冥引擎每个版本的变更。格式遵循 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)。分类标题沿用规范的英文关键字（Added、Changed、Deprecated、Removed、Fixed、Security），方便工具解析；条目用中文。

- 每个合入 main 的改动，在 [Unreleased] 的对应分类下加一条：写清改了什么，以及对作品或 agent 有什么影响。只写已经合入的改动，不写计划。
- 会改变《北冥》画面或混音的改动，条目里写明改了哪些镜头、是否只在 4K 生效；接口不兼容的改动在条目开头标「不兼容」。
- 发布时，把 [Unreleased] 的条目移到新的 `## [X.Y.Z] - YYYY-MM-DD` 下，同步 `package.json` 的 version，提交后打 `vX.Y.Z` 标签。`.github/workflows/release.yml` 会先跑整套 CI，再用本文件的对应段落建一个草稿 Release，人工核对后再发布。步骤见 [tests/ci/README.md](tests/ci/README.md#发布)。
- 校验：`node tests/ci/changelog.mjs check`，它也是 `node tools/check-all.mjs`（`npm run check`）的一步。

## [Unreleased]

这一段汇总从 v1.0 到工业级交付升级完成前的全部变更，按合入顺序归类。升级以 [docs/decisions/2026-11-10-industrial-baseline.md](docs/decisions/2026-11-10-industrial-baseline.md) 的 D01–D11 为准，拆成多个工作包推进，目标是让仓库成为按 A、B、C 三条路线组织的技术模版仓库：agent 读完入口文档就能选对路线，按模版建作品，用统一的命令出片；成片先过机器 QA 与人工创作闸门，才标为交付；每个 PR 都有测试、无显卡冒烟出片与 Windows 路径检查把关。各工作包合入时，在下面的分类里追加自己的条目。

### Added

- 离屏出片第一个里程碑（实验，D12）：`engine/offscreen/` 用 Node + Dawn 与 three.js r187 WebGPURenderer 出片，不经过浏览器；提供流水线读回、RGBA → BT.709 编码、Chrome WebGPU 同帧对拍与单 GPU 多部片基准。命令 `offscreen`、`offscreen:compare`、`offscreen:bench`；可选依赖与旧 r170 隔离，不修改旧路线与 `film` 出片链。当前演示仅含三档着色、反向外壳线和纸纹，不代表北冥完整后期迁移或生产并发调度已完成。实测范围与后续阻塞项见 `docs/offscreen/README.md`。
- 离屏出片可选 NVENC 编码：`offscreen render` 与 `offscreen:bench` 加 `--encoder x264|nvenc`（默认 x264，码流不变；nvenc 用 h264_nvenc 恒定质量 `--cq`，色彩换算与 BT.709 标记相同）。同码率下 NVENC 平均低约 2 dB，终渲母版仍走 x264；4 部并发 1080p 带编码实测中位数约 71 对 126 帧/秒（单机、有波动，详见 `docs/offscreen/README.md` 7.4）。
- 离屏出片的 TSL 版 Kuwahara 笔触（`engine/offscreen/tsl/kuwahara.js`；T2b 起支持 `far` 深度换半径，与 GLSL 对拍 PSNR 61 dB、最大差 1 级，并验证了 `pass()` 深度纹理的约定）：与 `engine/look/kuwahara.js` 的 GLSL 在同一张合成输入上对拍，PSNR 约 61 dB、最大差 1 级；对拍的参考侧助手 `tests/offscreen/glsl-reference.mjs` 可复用于后续的墨线与合成。
- 离屏出片的 TSL 版 ID 通道与屏幕空间墨线（`engine/offscreen/tsl/idpass.js`、`engine/offscreen/tsl/ink.js`，`engine/look/{ids,ink}.js` 的子集）：同一个场景与 GLSL 在无头 Chrome 里对拍，三组用例逐字节相同或最大差 1 级；ID 语义只覆盖不透明 Mesh 的 outline / outlineWidth / outlineAlpha / outlineGroup 与实心遮挡，其余（实例化、蒙皮、镂空、soft / own 遮挡等）抛 `unsupported.outline`，不静默画错。
- 离屏出片的 A 风格后期链（`engine/offscreen/tsl/{bloom,grade,paper,compose,look}.js`，`engine/look/index.js` 的对应）：bloom、调色、输出变换、Kuwahara、墨线、纸纹（程序化与图片）、暗角、颗粒按同一个顺序串起来，参数合并复用 `engine/look/index.js` 的纯函数；同一场景、风格锁定的真实参数下与 GLSL 在无头 Chrome 里对拍，三组用例最大差 1 级。雾、debug 视图、纸纹 scaleMode / anchor 抛 `unsupported.*`，不静默画错。
- 离屏出片 M3 起步：Node 里的 Canvas 2D（`engine/offscreen/canvas.mjs`，新增可选依赖 `@napi-rs/canvas` 1.1.1，字体子集注册与缺字报错同浏览器版）与几何桥（`engine/offscreen/bridge.mjs`，`engine/form` 的造型直接拷进 r187）；`engine/style/fonts.js` 抽出 `fontsOf` 供两边共用。
- 离屏出片的 TSL 版三档卡通材质（`engine/offscreen/tsl/toon.js`，接口与参数同 `engine/shade/toon.js`，投影滤波照搬 r170 PCFSoft）与斑块表面层（`tsl/surface.js`）：同一场景对 GLSL 版对拍，含投影、表面层与材质钩子，最大差 1 级。
- 离屏墨线的 ID 通道支持 `outlineOccluder` 的 soft / own（半透明底板与精灵按自身 alpha 半挡线）：对拍与 GLSL 版逐字节相同。
- 离屏底板工具 `engine/offscreen/tsl/plates.js`（`engine/stage/plates.js` 的同名 r187 版：读登记底板 PNG、Skia 画布贴图、软边裁片、抠像、加色辉光），对 A 路线对拍 PSNR 61.9 dB；离屏作品模块的 `build` 可以是 async。
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
- 中文排字 `engine/overlay/cjk.js`（实验）：给 Canvas 逐字画字用的断行与排版纯函数 `layoutText`，按 W3C《中文排版需求》做行首行尾禁则、省略号与破折号不拆、拉丁词与「数字加单位」不拆、标点挤压、中西文间距、两行等长与三种对齐；结果是逐字的位置，可直接交给文字动效。机器 QA 新增软项 `texts.cjk-break`（行首不是收尾标点、行尾不是开头标点，只告警）。自测页 `?test=cjk`。
- 文字动效 `engine/overlay/kinetic.js`（实验）：12 个逐字或逐碎片的入场 / 出场动效（回弹落位、打字机、字距收拢、翻牌、乱码解析、霓虹点亮、墨洇显影、大小波浪、模糊对焦、遮罩擦出、碎片聚合、碎片依次显现），画面只取决于进度，可一拍二，可任意跳帧。自测页 `?test=kinetic`。
- B 路线的光追外部后端 rt（实验）：`engine/native/rt.mjs`（`npm run b:rt -- status | render`）按 `engine/native/rt.lock.json` 核对外部光追渲染器的版本并调用它出分层图（颜色、深度、物体编号、视空间法线）；`engine/look/layers.js` 在浏览器里把一帧分层图做成描边、色阶、笔触与纸纹的北冥画风，自测页 `?test=rt_look`。渲染器是第三方预览许可软件，不随仓库分发，边界见 `docs/rights/rt-boundary.md`。现有三条路线的出片链路与画面不受影响。

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
- 首次在 GitHub 上跑 CI 时暴露的问题：各 job 改为检出完整历史（工程计划的证据提交、金标准源提交在浅克隆里找不到）；smoke-render 先取锁定的 OFL 字体，A 模版才能出片；软件渲染下冒烟只比对 `ci` 金标准集合（`beiming-core` 含原生 4K，SwiftShader 下采不完）；env-smoke 先装 FFmpeg 再自检，A、C 两份自检都写出报告；金标准截图沿用 `--frame-timeout`（原来用 playwright 自带的 30 秒，SwiftShader 下重的自测页会先撞上），冒烟在软件渲染下单帧放宽到 180 秒；护栏钩子去掉 PowerShell 7 管道带的 UTF-8 BOM 再解析；几处测试在 Windows 上的跨盘改名、8.3 短路径、反斜杠与 CRLF 写法。
- 作品站的画风筛选写进地址栏（`?f=<家族>`，锚点不动）：刷新、分享、代理直接打开某一家族都能还原；选「全部」时去掉参数，不认识的值按「全部」处理（取自 PR #3 的前一半）。

## [1.0.0] - 2026-11-04

### Added

- 首次公开发布（标签 `v1.0`）：《北冥》10 秒概念样片，包括三个镜头、六种鲲造型、卡通着色、墨线后期和显示层（`src/`）。
- 引擎 `engine/`：确定性数学、单纯形噪声、手绘笔触；用无头 Chrome 加 FFmpeg 逐帧渲染，另有静帧与音画封装。
- 声音 `audio/`：程序化音效、采样配乐、混音与自检。
- 支持任意分辨率的原生渲染，RTX 工作站走 Vulkan 后端。Release 附 1920×1040 成片 `beiming.mp4` 和原生 3840×2080 成片 `beiming_4k.mp4`。

[Unreleased]: https://github.com/cuiyucheng0104-afk/beiming-engine/compare/v1.0...HEAD
[1.0.0]: https://github.com/cuiyucheng0104-afk/beiming-engine/releases/tag/v1.0
