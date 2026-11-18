# 更新日志

本文件记录北冥引擎每个版本的变更。格式遵循 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)。分类标题沿用规范的英文关键字（Added、Changed、Deprecated、Removed、Fixed、Security），方便工具解析；条目用中文。

- 每个合入 main 的改动，在 [Unreleased] 的对应分类下加一条：写清改了什么，以及对作品或 agent 有什么影响。只写已经合入的改动，不写计划。
- 会改变《北冥》画面或混音的改动，条目里写明改了哪些镜头、是否只在 4K 生效；接口不兼容的改动在条目开头标「不兼容」。
- 发布时，把 [Unreleased] 的条目移到新的 `## [X.Y.Z] - YYYY-MM-DD` 下，同步 `package.json` 的 version，提交后打 `vX.Y.Z` 标签。`.github/workflows/release.yml` 会先跑整套 CI，再用本文件的对应段落建一个草稿 Release，人工核对后再发布。步骤见 [tests/ci/README.md](tests/ci/README.md#发布)。
- 校验：`node tests/ci/changelog.mjs check`，它也是 `node tools/check-all.mjs`（`npm run check`）的一步。

## [Unreleased]

这一段汇总从 v1.0 到工业级交付升级完成前的全部变更，按合入顺序归类。升级以 [docs/decisions/2026-11-10-industrial-baseline.md](docs/decisions/2026-11-10-industrial-baseline.md) 的 D01–D11 为准，拆成多个工作包推进，目标是让仓库成为按 A、B、C 三条路线组织的技术模版仓库：agent 读完入口文档就能选对路线，按模版建作品，用统一的命令出片；成片先过机器 QA 与人工创作闸门，才标为交付；每个 PR 都有测试、无显卡冒烟出片与 Windows 路径检查把关。各工作包合入时，在下面的分类里追加自己的条目。

### Added

- 新系统的地基（草案，没冻结）：顶层新增 `beiming/`，和现有三条路线并排，不改旧目录，对现有作品和出片命令没有影响。里面有 18 份契约草案（`beiming/kernel/contracts/`，每份带结构定义、正例和反例，`node beiming/kernel/contracts/lint.mjs` 查结构）、五份片子样例、核心线的闸文件（`beiming/sources/core/GATES.md`）、六个带标准答案的校准场景和检查器（`node beiming/calib/check.mjs`）、three 与 Blender 两个一次性探针适配器加探针数据表（`beiming/calib/table/`，只有 Mac 读数，确定性和耗时两行待服务器补跑）、多代理施工的总则、角色提示词、任务书模板和派工前的拒发检查（`beiming/crew/`）。契约版本都是 `0.1.0-draft`，没有任何代码照它实现。契约的正例和反例现在能真的跑：`node beiming/kernel/contracts/validate.mjs` 用结构定义（新增开发依赖 `ajv` 8.20.0）加各契约目录里的判定函数 `check.mjs` 逐个判，正例必须通过，反例必须正好被它声明违反的那一条拒掉；目前只有时间键契约写了判定函数（13 条全拒），其余 17 份的 147 个反例还没有东西拒。
- A 路线模版：片名逐字按字形自己的墨迹外框竖直居中（原来的 `textBaseline = 'middle'` 在字体子集不含空格时取后备字体的度量，片名高低随机器的系统字体变）；`?previs=1`（`film animatic` 传的参数）与 `?animatic=1` 一样进入预演模式，预演才真的关掉笔触与纸纹。模版有片名的 3 帧金标准截帧变了（只有片名字形），待按 POLICY 第 6 节审批。
- 离屏出片第一个里程碑（实验，D12）：`engine/offscreen/` 用 Node + Dawn 与 three.js r187 WebGPURenderer 出片，不经过浏览器；提供流水线读回、RGBA → BT.709 编码、Chrome WebGPU 同帧对拍与单 GPU 多部片基准。命令 `offscreen`、`offscreen:compare`、`offscreen:bench`；可选依赖与旧 r170 隔离，不修改旧路线与 `film` 出片链。当前演示仅含三档着色、反向外壳线和纸纹，不代表北冥完整后期迁移或生产并发调度已完成。实测范围与后续阻塞项见 `docs/offscreen/README.md`。
- 离屏出片可选 NVENC 编码：`offscreen render` 与 `offscreen:bench` 加 `--encoder x264|nvenc`（默认 x264，码流不变；nvenc 用 h264_nvenc 恒定质量 `--cq`，色彩换算与 BT.709 标记相同）。同码率下 NVENC 平均低约 2 dB，终渲母版仍走 x264；4 部并发 1080p 带编码实测中位数约 71 对 126 帧/秒（单机、有波动，详见 `docs/offscreen/README.md` 7.4）。
- 离屏出片的 TSL 版 Kuwahara 笔触（`engine/offscreen/tsl/kuwahara.js`；T2b 起支持 `far` 深度换半径，与 GLSL 对拍 PSNR 61 dB、最大差 1 级，并验证了 `pass()` 深度纹理的约定）：与 `engine/look/kuwahara.js` 的 GLSL 在同一张合成输入上对拍，PSNR 约 61 dB、最大差 1 级；对拍的参考侧助手 `tests/offscreen/glsl-reference.mjs` 可复用于后续的墨线与合成。
- 离屏出片的 TSL 版 ID 通道与屏幕空间墨线（`engine/offscreen/tsl/idpass.js`、`engine/offscreen/tsl/ink.js`，`engine/look/{ids,ink}.js` 的子集）：同一个场景与 GLSL 在无头 Chrome 里对拍，三组用例逐字节相同或最大差 1 级；ID 语义只覆盖不透明 Mesh 的 outline / outlineWidth / outlineAlpha / outlineGroup 与实心遮挡，其余（实例化、蒙皮、镂空、soft / own 遮挡等）抛 `unsupported.outline`，不静默画错。
- 离屏出片的 A 风格后期链（`engine/offscreen/tsl/{bloom,grade,paper,compose,look}.js`，`engine/look/index.js` 的对应）：bloom、调色、输出变换、Kuwahara、墨线、纸纹（程序化与图片）、暗角、颗粒按同一个顺序串起来，参数合并复用 `engine/look/index.js` 的纯函数；同一场景、风格锁定的真实参数下与 GLSL 在无头 Chrome 里对拍，三组用例最大差 1 级。雾、debug 视图、纸纹 scaleMode / anchor 抛 `unsupported.*`，不静默画错。
- 离屏出片 M3 起步：Node 里的 Canvas 2D（`engine/offscreen/canvas.mjs`，新增可选依赖 `@napi-rs/canvas` 1.1.1，字体子集注册与缺字报错同浏览器版）与几何桥（`engine/offscreen/bridge.mjs`，`engine/form` 的造型直接拷进 r187）；`engine/style/fonts.js` 抽出 `fontsOf` 供两边共用。
- 离屏出片的 TSL 版三档卡通材质（`engine/offscreen/tsl/toon.js`，接口与参数同 `engine/shade/toon.js`，投影滤波照搬 r170 PCFSoft）与斑块表面层（`tsl/surface.js`）：同一场景对 GLSL 版对拍，含投影、表面层与材质钩子，最大差 1 级。
- 离屏墨线的 ID 通道支持 `outlineOccluder` 的 soft / own（半透明底板与精灵按自身 alpha 半挡线）：对拍与 GLSL 版逐字节相同。
- 离屏底板工具 `engine/offscreen/tsl/plates.js`（`engine/stage/plates.js` 的同名 r187 版：读登记底板 PNG、Skia 画布贴图、软边裁片、抠像、加色辉光），对 A 路线对拍 PSNR 61.9 dB；离屏作品模块的 `build` 可以是 async。
- 出片链支持离屏渲染与 GPU 硬编：`npm run film -- build|animatic <作品> --renderer offscreen`（渲作品目录的 `offscreen.mjs`，其余步骤不变），`build|animatic|assemble` 新增 `--encoder x264|nvenc`（`nvenc` 让离屏渲染与网页版编码均走 `h264_nvenc`）；离屏作品模块的 `build` 收 `query`。验收片 `films/chendu/`（A 路线模版的双实现）离屏整片过机器 QA 门，look / animatic / final 三道闸用户已认可。
- 离屏出片 M4 复杂角色与场景补齐及 D12 登记：新增屏幕空间空气透视雾 `engine/offscreen/tsl/fog.js` 与墨线 `fogFade`（对 GLSL 对拍 PSNR 60.5–60.7 dB、最大差 1 级）；ID 通道支持 `InstancedMesh`（逐实例/共享 ID）、`SkinnedMesh`、变形目标、贴图镂空与顶点位移；TSL 卡通材质支持 `InstancedMesh`、`rest` 静止坐标、`vertexBegin`/`vertexNormal`/`fragmentNormal` 钩子、`translucent` 半透明，新增敦煌壁画风化层 `muralLayer`（综合对拍 PSNR 74.38 dB、最大差 1 级）；`bridge.mjs` 支持 `InstancedBufferAttribute` 与 `mirrorObject` 整树镜像（不改只读 `src/` 即可桥接 `kun_peng` 动态角色）；按 D12 在 `routes/routes.json` 与 `engine/production/` 登记 `offscreen` 渲染器与 `webgpu` 后端（`backend: "webgpu"` 作品在 `film build` 中默认走离屏）。
- 离屏出片 M5 后期收口、静帧/探测闭环与 C 路线宿主适配：`tsl/paper.js` 与 `tsl/compose.js` 补齐 `scaleMode: 'refHeight'` 面积取样、`paperAnchor` 锚点跟移与 `canvasPaper` 每帧贴图；新增 `tsl/debug.js` 支持全部 8 种后期调试视图（对 GLSL 对拍最大差 ≤ 1 级）；`engine/offscreen/cli.mjs` 新增无损静帧 `stills` 与只读探测 `probe`，`film check/stills/render/animatic/build` 全面支持 `--renderer offscreen` 及纯 `backend: "webgpu"` 作品；新增 C 路线（86 式）离屏宿主 `engine/offscreen/c2d.mjs`（按需注册分片 woff2 字体、兼容 `canvasFor`、可选 GPU 纸纹/暗角/颗粒后期）。
- 离屏出片 M6 GPU 侧 YUV420p 加速、单卡异构并发与免浏览器 QA/工具全闭环：新增 `engine/offscreen/yuv.mjs`（WGSL 定点计算管线 + 读回缓冲池，`--pix-fmt yuv420p` 省 62.5% 读回与 CPU `swscale`，1080p NVENC 4 路并发吞吐提升 62% 达 136.3 fps）；新增单卡异构并发调度器 `engine/offscreen/batch.mjs` 与 `offscreen batch` 子命令（含并发编码会话信号量、单任务故障隔离，并修复并发 `createHost` 帧时钟绑定竞态）；`canvas.mjs` 统一画布垫片与字体登记，解锁 `engine/overlay` 与 `engine/paint` 全库；新增 `tools/qa/lib/offscreen.mjs` 使 `qa texts/plates` 与 `film build` 在纯 `backend: "webgpu"` 及 `--renderer offscreen` 下免启动浏览器执行全量文字与底板检查；`determinism`、`lookdev:sweep` 与 `env:doctor` 全面接入离屏支持。
- 离屏出片 M7 同源跨端底座、WebGPU 审片工作台、`--backend webgpu` 脚手架与分层风格化离屏化：新增零顶层 `node:*` 静态导入的跨端底座 `engine/offscreen/io.mjs` 并升级 `film.mjs`、`c2d.mjs`、`paper.mjs`、`tsl/plates.js` 与 `films/chendu/offscreen.mjs`，使真实多镜头作品在 Chrome WebGPU 与 Node + Dawn 共跑同一份模块（《晨渡》同源对拍 PSNR 62.8–66.3 dB）；修复 `preview.js` 异步构建与 `query` 透传，升级 `lab/offscreen/index.html` 为支持自动读取 `film.json` 切点/事件刻度、实时播控与 8 种后期调试视图的 WebGPU 工作台；`new-film` 与 `film new` 新增 `--backend webgpu`（A/C 路线生成免浏览器全链路可出片的同源新片）；新增外部光追分层风格化的 TSL 版 `engine/offscreen/tsl/layers.js`（对 GLSL 版 5 种视图对拍最大差 ≤ 2 级、大差像素 0）。
- 三条路线的模版仓库结构：`routes/README.md` 是总指引；A（北冥风格路线 · WebGL 三渲二）、B（北冥原生 · BNE）、C（北冥代码动画风格 · 86 式）各有一份路线手册和一个可直接出片的模版。`node tools/new-film.mjs <a|b|c> <名字>` 从模版新建作品到 `films/<名字>/`。
- 导演与画面规范 `routes/directing/`：导演方法、画面设计、六章工艺（含音效设计与拟音工艺 `craft/sound.md`），以及阐述与画风锁定模版；`tools/check_directing_docs.py` 检查其中的命名与路径。
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
- 渲染管线升级（`engine/render/`，默认参数与既有金标准逐像素一致）：`--capture yuv420` 在浏览器 WebGL2 内直接合成画布并按有限范围 BT.709 矩阵转成 `yuv420p` 裸流喂给 FFmpeg，省去 PNG 编解码与 CPU 色彩空间换算；`--samples <N> --shutter <0–1>` 在线性光下累积子帧实现物理快门运动模糊；`engine/render/daemon.mjs` 与 `still.mjs --daemon` 提供常驻热 GPU 浏览器守护与依赖变动自动热重载。
- 自动书法毛笔骨架提取 `engine/overlay/skeleton.js`：从任意字体渲染出的二值掩码直接提取拓扑单线骨架、交叉直通合并、传统汉字笔顺与收笔飞白权重（`traceMaskSkeleton`、`buildAutoBrushGlyph`），并支持把外部标准笔顺中线沿距离变换脊线吸附到当前字体（`alignMediansToMask`），免除逐字手标骨架。
- 各向异性 Kuwahara 笔触与湿叠水彩皴擦：`engine/look/kuwahara.js` 新增可选 `anisotropy`（局部结构张量方向场驱动切向椭圆 8 扇区桑原滤波，默认 `0` 保持原单 pass 不变）；`engine/paint/watercolor.js` 提供递归湿边扩散、毛细水渍暗边（`fillWatercolor`）与披麻皴 / 斧劈皴矢量场均匀流线生成（`ridgeField`、`flowHatch`、`drawFlowHatch`）；新增宽松开源原生渲染演进对照文档 `docs/raea/open-native-survey.md`。
- 算力池远端 GPU 并行渲染 `tools/dstack-render.mjs` 与基础镜像定义 `tools/dstack/Dockerfile`：支持经 dstack 控制面把影片调度到远端独显节点做多路 `ANGLE Vulkan` 无头浏览器并行渲染与响度封装，支持预装镜像 0 秒冷启或宿主 `runtime-layer.tar` 亚秒级增量解包；默认固定 `backends: [ssh]` 只调度自有机队（防误触云端计费实例），支持 `--gpu none` 适配 UMA 统一内存节点；`engine/render/lib/gpu.mjs` 在 Linux 容器环境自动追加无头浏览器沙箱兼容参数。
- CC0 真实录音音效库与可选切换链路（默认程序化合成逐样本不变）：`engine/audio/library.py` 提供 48 kHz 保音高重采样、起音静音裁剪、等功率底噪循环、翼音短事件包络切片与署名生成；`audio/sfx_manifest.json` 登记《北冥》样片 18 项 CC0 录音映射，`audio/mix.py --real-sfx`（及 `tools/audio/build.mjs --real-sfx`）支持一键切换真实音效并单独写出 `out/CREDITS.real-sfx`；`tools/fetch_sfx.py` 提供 Freesound CC0 六线程并发下载与基于投票数及专业录音描述信号的候选重排。
- 导演声学谱、感知 HDR 混音、Sound Designer 实录复合拟音、零训练音效取证与工艺规范（默认成片与既有合成链路逐样本兼容）：新增 `routes/directing/craft/sound.md` 第六章音效设计与拟音工艺手册（八条音效法则、九步闭环、微机械与高科技 HUD 配方库、A/B/C 跨路线矩阵、听感词物理量翻译表与审片十问）并同步更新 `DIRECTING.md` 步骤 8；新增 `engine/audio/director.py`（听觉视角预设 `POA_PRESETS`、按景别声像上限 `SHOT_PAN_CAP`、跨切点 `render_shot_poa`、冲击前负空间抽空 `carve_negative_space`、配乐调性协和吸附 `harmonic_freq`、精密工程制图微声 `subtle_precision_cue`、防刺耳高频镭射脉冲走线 `hitech_laser_trace` 与支持双层强调泛音的玻璃态菜单微提示音 `hitech_micro_beep`，以及离线前视 `HDRMixer`：Murch 2.5 声部聚簇裁剪 + 6 临界频带 `sosfiltfilt` 零相位侧链动态让位）；新增 `engine/audio/foley.py`（前导/接触瞬态 MSI/腔体重量/余波四段子事件复合、三层实录认知锚点复合配方 `composite_mechanism`、无源精密齿轮转动与双阶落锁咬合 `precision_gear_turn`、薄壁圆管早反射、保材质移调 `shift_material`、防机关枪重复的 `RoundRobinDeck`、有机颗粒声床 `granular_bed`、剑风/剑鸣/衣袂/断水原型，以及粘滑摩擦 `stick_slip_friction`、精密螺纹 `helical_thread`、色散螺旋弹簧 `spring_coil` 与棘齿卡扣 `ratchet_detent`）；`engine/audio/library.py` 新增洁净增益取证切片加载 `load_slice`（拦截低 `raw_pk` 高噪归一化）、高频加权感知冲击中心检测 `sync_anchor`（P-Center）、亚 20 ms 微瞬态切片 `min_len`、轻柔去底噪/混响门 `de_room_gate` 与无损格式优先加载；`engine/audio/dsp.py` 新增四点三次 Hermite 分数延迟线、物理多普勒 `doppler` 与瑞利双工单声道兼容空间同化摆位 `space_place`；新增 `engine/audio/sfx_judge.py` 零训练物理形态与因果本体取证（含脉冲门控 Schroeder RT20、清单裁剪/滤波意图感知、`mechanical` / `motorized` / `low_drone` / `sustained_tonal` 原型、无源机构电机嗡鸣与循环检测 `judge_ontology` 及多事件独立切片包络测量），接入 `tools/fetch_sfx.py`（支持无源机械物件防电机污染守卫、`hitech`/UI 电子类标签放行、无 `FREESOUND_TOKEN` 时的公开 CC0 双路检索、许可核验与 `sfx_judge` 下载自动筛查）；`engine/audio/qa.py` 新增分轨临界频带听觉窥视掩蔽检查 `audio.masking` 与逐 100 ms 窗左右平衡检查 `audio.balance`；`engine/render/events.mjs` 新增 `--telemetry` 逐帧 GPU 画面运动能量、横向重心声像、切点跳变与 `AUDIO_TELEMETRY` 真遥测采集，对接 `engine/audio/cues.py` 48 kHz 重采样与 `engine/audio/cuecheck.py`、`tools/qa` 的 `syncMode: "pcenter"` 感知锚点对齐校验。
- 取帧方式对比实验（不改出片链路）：`tools/rtx/capture-bench.mjs` 比较截图与「读画布、显卡里转 YUV、原始流喂 FFmpeg」的用时和画面一致性；RTX 5090 工作站上的实测与没有接入的原因见 [docs/capture-experiment.md](docs/capture-experiment.md)。

### Changed

- 引擎从 v1.0 的 7 个文件重构成九层：core（时间与数学）、form（程序化造型）、shade（卡通着色）、stage（镜头与舞台）、look（后期）、paint（Canvas 2D 绘画）、overlay（显示层）、audio（声音）、render（出片），外加 production（生产契约）。《北冥》样片改为调用这些层，`src/` 只留本片的镜头、造型与色板。
- 三条路线的对外品牌名统一为：北冥风格路线 · WebGL 三渲二、北冥原生 · BNE、北冥代码动画风格 · 86 式（D04）。README 重写，新增 `docs/README.md` 导航；作品文案改为如实口径（由代码合成出片，素材来源见案例卡）。
- 出片色彩全链路改为 BT.709 有限范围，并完整标注矩阵、原色、传递特性与范围（成片为 yuv420p / tv / bt709）；以前标的是全范围 BT.601，按 BT.709 解读时绿色通道偏差约 22 级。
- 成片响度由 −14.9 LUFS 校正到 −14.0 LUFS（线性增益，不改变动态范围）。
- 《北冥》1080p 画面有三处有意变化：R24 渡船的红绿航行灯换到正确的舷侧，R30 鸽群的黑边消失，R66 导航线的线头。只在 4K 生效的修复：R17、R19、R31、R32、R45。
- `npm run showcase:build` 改名为 `npm run site:build`，另有 `site:serve`、`site:qa`。
- B 路线（北冥原生 · BNE）锁定的上游原生运行时由 `0.1.0-canary.2` 升级到正式版 `0.1.4`（`v0.1.4`，提交 `d870159c4686bd1fcda094934602463549b26683`，2026-11-15 发布，2028-11-15 转为 Apache-2.0）：同步更新 `engine/native/runtime.lock.json` 与 `tools/env/spec.json` 的 macOS arm64、Windows x64、Linux x64 三平台归档与可执行文件 SHA256，并在 Linux RTX 4070（Vulkan / OpenH264）完成模版出片、四类画面配方与机器 QA 验收；`engine/render/native.mjs` 兼容 `raea check` 新版 `findings`（`error / warn / note`）与旧版 `issues`（`P0–P3`）输出，并接入 `BEIMING_GPU_BUSY_UTIL` / `--max-gpu-util` 守卫阈值。
- 分块渲染（`engine/render/lib/chunks.mjs`，`video.mjs` 与 `shots.mjs` 共用）：一块的帧喂完后，FFmpeg 收尾（编完、核对帧数、改名）放到后台，同一路先渲下一块，每路最多一块在后台收尾。码流逐字节不变；RTX 4070 笔记本上 A、C 模版 192 帧 4 路交替实测中位快 6–10%（16 组配对 15 组更快）。

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
- 授权登记册 `docs/rights/register.md` 的核对不再随语言环境变化：`tools/compliance/lib/rights.mjs` 排序固定用 `en`，中文环境下 `rights-inventory --check` 不再误报「过期」（CI 英文环境本来就通过）；`tests/comp/cli.test.mjs` 新增中、英、C 三种环境下的核对。
- 测试判断「有没有无头浏览器」改用与 `npm test` 的 `requires: browser` 同一个探测（`tests/ci/browser.mjs`）：原先用 `chromium.executablePath()` 指向完整 Chromium，而渲染器与 CI 装的是 chromium-headless-shell，渲染管线、生产管线、重排切点、确定性与金标准、例片资产桥共 5 个测试文件在 CI 里一直显示「跳过」而没有运行；`tests/ci/browser-skip.test.mjs` 防止再写回去。
- 例片资产桥测试 `tests/native/bridge.test.mjs`：GLB 总字节数含贴图的 PNG 编码，随平台变化，改为与 sha256 一样只在登记过哈希的平台上比对（与 `examples/raea/expected-assets.json` 的 `$note` 一致），其余结构摘要仍在任何平台比对；基准文件未改。

## [1.0.0] - 2026-11-04

### Added

- 首次公开发布（标签 `v1.0`）：《北冥》10 秒概念样片，包括三个镜头、六种鲲造型、卡通着色、墨线后期和显示层（`src/`）。
- 引擎 `engine/`：确定性数学、单纯形噪声、手绘笔触；用无头 Chrome 加 FFmpeg 逐帧渲染，另有静帧与音画封装。
- 声音 `audio/`：程序化音效、采样配乐、混音与自检。
- 支持任意分辨率的原生渲染，RTX 工作站走 Vulkan 后端。Release 附 1920×1040 成片 `beiming.mp4` 和原生 3840×2080 成片 `beiming_4k.mp4`。

[Unreleased]: https://github.com/cuiyucheng0104-afk/beiming-engine/compare/v1.0...HEAD
[1.0.0]: https://github.com/cuiyucheng0104-afk/beiming-engine/releases/tag/v1.0
