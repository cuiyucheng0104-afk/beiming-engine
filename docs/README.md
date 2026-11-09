# 文档导航

> 读者：第一次来、不知道先看哪篇的人｜状态：导航｜依据：2026-11-09 仓库内容

仓库首页 [README.md](../README.md) 讲是什么、怎么跑；这里按你要做的事列出该读的文档。`docs/` 下每篇文档（以及 ROUTES.md 与案例库的两页）开头都有一行“读者｜状态｜依据”，先看它再决定要不要往下读，约定见文末。

## 想看作品

| 先看 | 讲什么 |
|---|---|
| [作品站](https://cuiyucheng0104-afk.github.io/beiming-engine/) | 浏览器里实时渲染的鲲，79 部代码动画成片，点开即播 |
| [《北冥》样片](北冥样片.md) | 10 秒样片的故事、世界观、人物、镜头与色板 |
| [样片下载](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/tag/v1.0) | 有声完整版，1080p 与原生 4K |
| [案例目录](../cases/INDEX.md) | 归档的全部 96 条记录、状态与时长，含没上站的实验和预演 |
| [PPT 怎样变成代码动画](cases/ppt-animation.md) | 7 部故事介绍片与 6 个发布会工程的做法 |
| [成片与素材包](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/tag/casebook-2026.11) | 原始画质成片、观看版与素材包，105 个文件 |

## 想用引擎做片（北冥风格路线 · WebGL 三渲二）

| 顺序 | 文档 | 讲什么 |
|---:|---|---|
| 1 | [ROUTES.md](../ROUTES.md) | 选北冥风格路线还是北冥原生路线，路线与后端怎么分开记 |
| 2 | [三条执行路线](TRACKS.md) | 三条路线各自在哪里执行、做到哪一步、怎么验收 |
| 3 | [北冥风格路线手册](routes/beiming-style.md) | 真实模块与默认参数、色阶怎么算、墨线与笔触、从参考图到新画风 |
| 4 | [渲染与 4K](渲染与4K.md) | 原生 4K、RTX 超分与普通放大的画质和计时对比 |
| 5 | [在 RTX 工作站上渲染](RTX工作站.md) | 让无头 Chrome 用上独显的设置、命令与常见坑 |
| 6 | [验收与 RTX 5090 执行](routes/validation-and-rtx.md) | 交付契约、阶段门槛、共享工作站的占用检查与证据 |

## 想了解原生路线（北冥原生路线 · BNE）

| 顺序 | 文档 | 讲什么 |
|---:|---|---|
| 1 | [原生路线总览](raea/README.md) | 当前状态、版本基线、各篇入口 |
| 2 | [原生路线手册](routes/raea-native.md) | 新建独立工程、模块选择、帧时间、常见故障 |
| 3 | [示例与复现命令](../examples/raea/README.md) | 已跑通的 10 秒例片怎么准备、检查、渲染 |
| 4 | [资产桥](../examples/raea/ASSET-BRIDGE.md) | 鲲的着色器形变怎样转成 GLB 骨骼动画 |
| 5 | [10 秒原生实验](raea/experiment.md) | 实测数据、兼容问题与尚未验证的部分 |
| 6 | [运行时源码对照](raea/architecture.md) | 调用链、编码路径、确定性与许可的源码证据 |
| 7 | [技术集成指引](raea/integration.md) | 把原生能力接进北冥风格路线的设计稿 |
| 8 | [制作层改进](raea/production.md) | 长片需要补的表演与验收能力 |

## 想维护案例库与归档

| 文档 | 讲什么 |
|---|---|
| [cases/README.md](../cases/README.md) | 案例库怎么组织、怎么还原、怎么去重 |
| [案例目录](../cases/INDEX.md) | 96 条记录的入口与状态 |
| [风格、工程与作品：三个仓库如何合用](cases/comparison.md) | 两套风格库与北冥的源码差异、20 类风格怎么去重 |
| [归档验收记录](cases/verification.md) | 2026-11-07 归档的检查项与结果 |
| [THIRD-PARTY.md](../THIRD-PARTY.md) | 上游来源、固定版本与许可义务，作品站依赖也在这里 |

```bash
python3 tools/casebook.py check                                  # 校验 96 条记录与两套风格库快照
python3 -m unittest discover -s tools -p test_casebook.py         # 还原工具测试
```

## 想分派工程任务或改作品站

| 文档 | 讲什么 |
|---|---|
| [双路线工程手册](routes/README.md) | 阅读顺序、现状和可执行的计划检查 |
| [数据与模块契约](routes/contracts.md) | 项目、镜头、帧状态、资产与结果的字段约定 |
| [工作分解](routes/work-breakdown.md) | 21 项任务的负责人、依赖、写入范围与完成条件 |
| [作品站产品说明](../site/PRODUCT.md)、[设计说明](../site/DESIGN.md) | 作品站给谁看、怎么设计、定稿文案与数字出处 |

```bash
npm run routes:check && npm run test:routes      # 计划校验与任务卡一致性
node --test tests/production/project.test.mjs    # 项目与结果记录的契约校验（T01，13 项）
npm run site:build && npm run site:serve         # 构建作品站到 out/site/，在 8090 端口预览
```

## 对外名称与工程代号

对外（作品站、README、发布说明）只用左列名称。工程目录、npm 命令和环境变量沿用历史代号，只用于追溯；技术文档里可以写运行时和上游仓库的真名，因为命令、版本与许可要对得上。

| 对外名称 | 是什么 | 工程里的目录与代号 |
|---|---|---|
| 北冥风格路线 · WebGL 三渲二 | 主线：浏览器里的 WebGL 与 Canvas 2D 逐帧出片 | `engine/`、`src/`、`lab/`；后端字段 `three` |
| 北冥原生路线 · BNE | 原生运行时与独立 GPU 出片 | `docs/raea/`、`examples/raea/`、`npm run raea:*`、`RAEA_BIN`；运行时是第三方项目，许可见 [THIRD-PARTY.md](../THIRD-PARTY.md) |
| 北冥代码动画风格 · 86 式 | 66 部成片 + 20 种方法模板的画法库 | `cases/`；风格库快照在 `cases/vendor/`，来源见 [THIRD-PARTY.md](../THIRD-PARTY.md) |

“三条路线”是对外的说法；开工时真正要选的是前两条（见 [ROUTES.md](../ROUTES.md)），第三条是已有画法的资料库，新片从中取方法，再落到前两条上执行。

## 文档约定

- 每篇文档在标题下面写一行：`> 读者：……｜状态：……｜依据：……`。
- 状态用这几种说法：**导航**、**创作设定**、**实测记录**、**操作手册**、**实施手册**（含待做步骤）、**源码分析**、**设计稿**（接口或目录还没实现）、**归档记录**。
- 依据写核对日期，以及当时的提交、运行包版本或机器；没有重跑的平台不写成新的验证。
- 已有成片、技术检查通过、画面被认可是三种状态，分开写。
- 数字要能在仓库里查到出处；对外名称按上表；正文不用破折号。
- 改完文档，核对相对链接、锚点与固定提交链接（[AGENTS.md](../AGENTS.md)“修改后检查”）。
