# A/B 引擎工程手册

> 读者：改引擎、加共享能力、分派工程任务的人｜状态：工程手册入口｜依据：[决定书](../decisions/2026-11-10-industrial-baseline.md) D01、D06；任务状态以 [work-plan.json](work-plan.json) 为准

做作品不从这里开始：新片按[三路线总指引](../../routes/README.md)在 A、B、C 里选一条，用 `npm run new` 建作品，进度由作品的 `film.json` 与 `films/<名>/review/` 记录（D06）。本手册给要改 `engine/`、加共享能力或领取工程任务的人：A（北冥风格路线 · WebGL 三渲二）与 B（北冥原生 · BNE）各自的工程细节、两者共用的契约、验收与工作站，以及任务怎么领。C（北冥代码动画风格 · 86 式）与 A 共用页面渲染器 `engine/render`（D01），没有单独的后端工程。

## 按要做的事阅读

| 你要做什么 | 先读 | 接着 |
|---|---|---|
| 延续或扩展北冥画风的引擎能力（造型、着色、墨线、笔触、底板） | [北冥风格路线工程手册](beiming-style.md) | 找到真实参数与层级，在固定场景里做单变量实验 |
| 原生场景、外部模型、骨骼与材质（B） | [原生路线工程手册](raea-native.md) | 从 `engine/native/` 与 `engine/render/native.mjs` 的现有入口开始 |
| 两条执行线共用的数据与接口 | [模块契约](contracts.md) | 作品描述以 `film.json` v2 为准，校验器 `engine/production/film.js` 由作品描述包在建 |
| 在 5090 出片、比较质量与速度 | [验收与 RTX](validation-and-rtx.md) | 运行环境、画面、动作、技术输出与性能分开检查 |
| 分派多代理、领取工程任务 | [工作分解](work-breakdown.md) | `npm run plan:next`，按任务卡的写入范围分工 |
| 追问某项原生能力的实际源码 | [固定版本源码对照](../raea/architecture.md) | 沿函数、调用者与条件分支核对 |

## 三种状态分开写

| 状态 | 内容 |
|---|---|
| 已运行 | 《北冥》10 秒样片；B 路线 10 秒原生例片；GLB 转换与回读；历史 5090 与目录迁移后的 Mac 验证 |
| 已有工具 | 引擎工程待办 `npm run plan:check`、`npm run plan:next`；新建作品 `npm run new`；仓库规范检查 `npm run check:repo` |
| 设计与待实现 | FrameState、跨后端适配、风格等价、完整人物表演；以 work-plan.json 里 planned 的任务为准，不报告成已有 API |

## 引擎工程的顺序

1. **先出小样。** 复用现有入口做出可验收的画面（一个固定场景、一个看得见的事件），再处理实际遇到的共用问题；不提前建调度服务、插件系统或通用 SDK 包装。
2. **只在需要时跨后端。** 同一镜头要在两个后端执行时才实施 FrameState 与跨后端适配；只新增一部作品不需要它们。
3. **固定可比较的输入。** 模型、底板、相机尺度、时间、画幅与参考帧先定下来，否则参数变化解释不清。
4. **逐层验证。** 反照率、灯光分档、阴影、轮廓、笔触、底板与显示层分开看。
5. **改已有模块先出基线。** 改 `engine/` 已有模块前先渲基线，改后逐帧比对；技术验收与创作验收分开记录。
6. **保存证据再更新状态。** 源码版本、输入哈希、实际后端、命令、产物与未解决问题都写进任务的 evidence。

## 工程计划

```sh
npm run plan:check                  # 结构、依赖、认领与过期、证据与指引路径、写入范围冲突
npm run plan:next -- --route a      # 依赖已满足、可以领取的任务：a / b / c / shared（旧名 beiming、raea 也认）
node tools/work-plan.mjs --verify-diff <任务>   # 改动是否都在该任务的写入范围里
```

工具是 [tools/work-plan.mjs](../../tools/work-plan.mjs)：只读，不改状态、不执行任务、不启动渲染；旧名 `npm run routes:check`、`routes:next` 保留一个版本并提示改名。T 编号是早先拆出的工程任务，H 编号是工业级加固的工作包；领取、认领、取代与检查规则见[工作分解](work-breakdown.md)。改了 work-plan.json 要重新生成那一页的任务卡（`node tools/work-plan.mjs --cards`），`node --test tools/work-plan.test.mjs` 会逐字核对。

## 记录模板

- [北冥风格路线项目](templates/project-beiming.json) / [原生路线项目](templates/project-raea.json)
- [镜头和事件](templates/shot.json)
- [资产](templates/asset.json)
- [渲染结果与双重验收](templates/render-result.json)

这些是 ProjectSpec v1（T01，`engine/production/project.js`）的记录格式，渲染器不自动读取；新作品的描述写 `film.json` v2（附录 C6），由 `npm run new` 生成。不把模板里的目标 GPU、画幅或响度当作实测结果。

## 代理交付格式

每个子任务返回：任务 ID、基线提交、实际变更文件、运行过的命令、产物路径、验收结果、未完成项。只读了源码写「源码核对」；没在 Windows 执行，就不写「5090 验证完成」。共享入口和工作状态由集成负责人统一修改；重叠写入的任务必须串行或重新划分，不用恢复别人文件的方式解决冲突。
