# 文档与工具索引

> 读者：第一次来、不知道先看哪篇的人｜状态：导航｜依据：2026-11-12 仓库内容

仓库首页 [README.md](../README.md) 讲是什么、怎么跑；agent 从 [AGENTS.md](../AGENTS.md) 开始。这里按要做的事列出该读的文档与该用的工具。`docs/` 下每篇文档开头都有一行「读者｜状态｜依据」，先看它再决定要不要往下读，约定见文末。命名与术语见 [GLOSSARY.md](GLOSSARY.md)。

## 想看作品

| 先看 | 讲什么 |
|---|---|
| [作品站](https://cuiyucheng0104-afk.github.io/beiming-engine/) | 浏览器里实时渲染的鲲，97 部成片，点开即播 |
| [《北冥》样片](北冥样片.md) | 10 秒样片的故事、世界观、人物、镜头与色板 |
| [样片下载](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/tag/v1.0) | 有声完整版，1080p 与 4K |
| [案例目录](../cases/INDEX.md) | 归档的全部 96 条记录、状态与时长，含没上站的实验和预演 |
| [PPT 怎样变成代码动画](cases/ppt-animation.md) | 7 部故事介绍片与 6 个发布会工程的做法 |
| [成片与素材包](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/tag/casebook-2026.11) | 原始画质成片、观看版与素材包，105 个文件 |

## 想做一部片（三条路线）

| 文档 | 讲什么 |
|---|---|
| [三条路线总指引](../routes/README.md) | 选路线的唯一判据、一部作品怎么做、仓库地图；路线注册表 [routes.json](../routes/routes.json) |
| [A · 北冥风格路线 · WebGL 三渲二](../routes/a-webgl/README.md) | 手册：最快上手、能力清单、契约、验收、边界与常见坑 |
| [B · 北冥原生 · BNE](../routes/b-native/README.md) | 手册：运行时获取、准备素材、草图帧、出片、画面工艺、FSL 使用边界 |
| [C · 北冥代码动画风格 · 86 式](../routes/c-style/README.md) | 手册：C 模版出片、挑风格（[STYLES.md](../routes/c-style/STYLES.md)）、复刻历史作品（[REPLICATE.md](../routes/c-style/REPLICATE.md)）；片名字体见 [fonts/README.md](../routes/c-style/fonts/README.md) |
| [导演与画面规范](../routes/directing/README.md) | 导演十步、画面设计、五章工艺（[craft/](../routes/directing/craft/README.md)）、阐述与画风锁定模板 |
| [执行面技术分档](TRACKS.md) | 三条路线各自在哪里执行、做到哪一步、怎么验收 |
| [出片编排 tools/film](../tools/film/README.md) | 子命令、运行目录、出片链、闸门记录、run.json 与退出码 |
| [作品描述 engine/production](../engine/production/README.md) | film.json v2、整数帧时间轴、改切点、交付档位、创作闸门与状态机 |
| [创作闸门与审片](creative-review/README.md) | 什么时候能终渲、什么时候能说「已交付」；生产链 SOP 与审片落分 |
| [渲染器 engine/render](../engine/render/README.md) | 渲染器 v2 规格：页面约定（含 `__RENDER`）、编码链、错误码、镜头缓存与续跑 |
| [配音、字幕与口型](../engine/audio/voice/README.md) | `dialogue.json` 写法、配音服务、字幕与口型提示 |
| [渲染与 4K](渲染与4K.md) | 4K 实测与怎么出 4K（含底板分辨率预算） |

## 环境与工作站

| 文档 | 讲什么 |
|---|---|
| [运行环境](ENVIRONMENT.md) | 三平台安装（含 PowerShell 写法）、doctor 与 setup、版本要求、环境变量总表、镜像与离线、存储分层 |
| [在 RTX 工作站上渲染](RTX工作站.md) | 装环境、让 WebGL 用上独显、渲染器与环境变量对照、从控制机远程出片（[tools/remote](../tools/remote/README.md)） |
| [验收与 RTX 5090 执行](routes/validation-and-rtx.md) | 交付契约、阶段门槛、共享工作站的占用检查与证据 |

## 质量、测试与发布

| 文档 | 讲什么 |
|---|---|
| [质量](quality/README.md) | 机器 QA 门 [QA-GATE.md](quality/QA-GATE.md)（命令、每项判据、豁免）、评分标尺 [RUBRIC.md](quality/RUBRIC.md)、已知问题台账 `quality/known-issues.json` |
| [画面基线](style-baselines/README.md) | 回归金标准与认可参照、怎么比、平台键与容差、画面有意改了怎么审批（[POLICY.md](style-baselines/POLICY.md)） |
| [《北冥》认可画面参照](style-baselines/beiming-original@v1/README.md) | 二十帧清单、六张关键帧的登记、画风的几个数 |
| [测试、检查、CI 与发布](../tests/ci/README.md) | 命令、测试放在哪里、每个 job 的本机复现、金标准首次采集、发布步骤、已知问题 |
| [引擎测试](../tests/engine/README.md) | 改了 `engine/` 各层之后先跑的单测与 GPU 测试 |
| [CHANGELOG.md](../CHANGELOG.md) | 版本变更记录；会改变《北冥》画面或混音的改动写明镜头 |
| [agent 验收题库](../evals/agent/README.md) | 评测方用：8 道题、无头驱动与回复注入、会话隔离、硬门与评分；做作品的 agent 不需要读 |

## 权利与许可

| 文档 | 讲什么 |
|---|---|
| [THIRD-PARTY.md](../THIRD-PARTY.md) | 上游来源、固定版本与许可义务；FSL 边界、署名区块、派生代码、CC BY 署名、作品站依赖 |
| [rights/](rights/README.md) | 素材授权登记、许可范围、FSL 边界、AI 生成内容标识、合规扫描命令 |

## 想维护案例库与归档

| 文档 | 讲什么 |
|---|---|
| [cases/README.md](../cases/README.md) | 案例库怎么组织、怎么还原、怎么去重 |
| [案例库工具](cases/casebook.md) | `tools/casebook.py` 的子命令、catalog 字段、权利字段与校验 |
| [风格、工程与作品：三个仓库如何合用](cases/comparison.md) | 两套风格库与北冥的源码差异、20 类风格怎么去重 |
| [归档验收记录](cases/verification.md) | 2026-11-07 归档的检查项与结果 |

```sh
npm run cases:check      # 校验 96 条记录与两套风格库快照
npm run test:cases       # 案例库工具与相关规则的测试
```

## 引擎工程与作品站（仅在用户明确要求时）

| 文档 | 讲什么 |
|---|---|
| [A/B 引擎工程手册](routes/README.md) | 改引擎、加共享能力的阅读顺序与现状；`npm run plan:check`、`npm run plan:next` |
| [工程待办与分工](routes/work-breakdown.md) | T / H 任务的负责人、依赖、写入范围与完成条件 |
| [数据与模块契约](routes/contracts.md) | film.json、镜头、帧状态、资产与结果的字段约定（FrameState 仍是设计） |
| [北冥风格路线工程手册](routes/beiming-style.md)、[原生路线工程手册](routes/raea-native.md) | A、B 的引擎层细节与历史实验 |
| [原生运行时源码与集成](raea/README.md) | B 路线底层：运行时源码对照、10 秒原生实验、集成设计稿 |
| [命令约定](CLI.md) | 退出码、`--json` 信封、参数规则、全部 npm 脚本的清单与状态 |
| [决定书](decisions/2026-11-10-industrial-baseline.md) | D01–D11：三条路线、FSL 边界、命名、交付档位、创作闸门、运行时版本、存储、AI 标识 |
| [作品站产品说明](../site/PRODUCT.md)、[设计说明](../site/DESIGN.md)、[构建契约](../site/CONTRACT.md) | 作品站给谁看、怎么设计、定稿文案与数字出处、构建器做什么 |

## 对外名称与上游项目名

对外（作品站、README、发布说明）只用左列名称，产品名不带 RTX。上游项目名在技术说明、署名区块与许可说明里如实写；工程目录、npm 命令和环境变量沿用上游项目名（内部目录沿用），不是我方的产品名。完整词条见 [GLOSSARY.md](GLOSSARY.md)。

| 对外名称 | 是什么 | 工程里的目录与命令 |
|---|---|---|
| 北冥风格路线 · WebGL 三渲二 | 浏览器里的 WebGL 与 Canvas 2D 逐帧出片 | `routes/a-webgl/`、`engine/`、`src/`、`lab/`；后端字段 `three` |
| 北冥原生 · BNE | 通用原生渲染，基于上游 RAEA 原生运行时（FSL-1.1-ALv2） | `routes/b-native/`、`engine/native/`；沿用上游项目名的 `examples/raea/`、`docs/raea/`、`npm run raea:*`、`RAEA_BIN` |
| 北冥代码动画风格 · 86 式 | 页面型代码动画的方法库与 C 模版 | `routes/c-style/`；风格库快照在 `cases/vendor/`，来源见 [THIRD-PARTY.md](../THIRD-PARTY.md) |

三条路线都能直接出片，按需求在 A、B、C 里选（[routes/README.md](../routes/README.md)）。

## 文档约定

- 每篇文档在标题下面写一行：`> 读者：……｜状态：……｜依据：……`。
- 状态用这几种说法：**导航**、**创作设定**、**实测记录**、**操作手册**、**实施手册**（含待做步骤）、**源码分析**、**设计稿**（接口或目录还没实现）、**归档记录**。
- 依据写核对日期，以及当时的提交、运行包版本或机器；没有重跑的平台不写成新的验证。
- 已输出、技术检查通过、用户认可是三种状态，分开写。
- 数字要能在仓库里查到出处；对外名称按上表；正文不用破折号。
- 改完文档跑 `npm run check:repo`：它核对相对链接、锚点与入口口径。
