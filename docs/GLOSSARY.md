# 术语与命名表

> 读者：读文档时遇到不认识的词、写对外材料前要确认能不能用某个词的人与 agent｜状态：导航｜依据：2026-11-12；命名口径以[决定书](decisions/2026-11-10-industrial-baseline.md) D01、D03、D04 为准

「对外」一栏：**可以** = 作品站、README、发布说明与对外交流里可以直接用；**限定** = 只在技术说明、署名区块与许可说明里如实写，不当我方的产品名、路线名、目录名；**内部** = 工程术语，对外材料里不出现或要先换成白话。每条的出处链接是详细说明，以出处为准。

## 命名表

| 词 | 是什么 | 对外 | 出处 |
|---|---|---|---|
| 北冥风格路线 · WebGL 三渲二（A） | A 路线：北冥画风的确定性三渲二，无头 Chrome 的 WebGL 逐帧出片 | 可以 | [A 手册](../routes/a-webgl/README.md) |
| 北冥原生 · BNE（B） | B 路线：通用原生渲染（render anything），可以复用北冥资产，但不要求北冥画风 | 可以；产品名不带 RTX，技术说明写「基于 RAEA 原生运行时（FSL-1.1-ALv2）」 | [B 手册](../routes/b-native/README.md) |
| BNE | Beiming Native Edition，「北冥原生」的英文缩写；不表示自研运行时，不写成「BEIMING NATIVE ENGINE」「自研原生引擎」 | 可以（只作 B 路线名的一部分） | [fsl-boundary.md](rights/fsl-boundary.md) |
| 北冥代码动画风格 · 86 式（C） | C 路线：页面型代码动画的方法库，外加可直接出片的 C 模版；与 A 共用页面渲染器，不是第三个 GPU 后端 | 可以 | [C 手册](../routes/c-style/README.md) |
| 86 式 | 两套第三方 MIT 风格库固定快照合起来的风格索引：86 式 = Lemo 66 + SY 20。是索引，不是我方原创的画法 | 可以；说明来源时带上两套库的署名 | [STYLES.md](../routes/c-style/STYLES.md) |
| Lemo / lemo-opuscar | 第三方风格库（LemoLab，MIT），快照在 `cases/vendor/lemo-opuscar`，固定提交 `bebbbe1`；66 种风格 | 限定 | [THIRD-PARTY.md](../THIRD-PARTY.md) |
| SY / sy-style-100 | 第三方风格库（肖雄 XIAOXIONG，MIT），快照在 `cases/vendor/sy-style-100`，固定提交 `e41dee3`；20 种风格 | 限定 | [THIRD-PARTY.md](../THIRD-PARTY.md) |
| RAEA | 上游原生 GPU 运行时（shinyobjectz/raea，FSL-1.1-ALv2，版权人 Shane Murphy）；不随仓库分发，B 路线只把它当内部制作层 | 限定 | [fsl-boundary.md](rights/fsl-boundary.md) |
| 上游项目名（内部目录沿用） | `examples/raea/`、`docs/raea/`、`npm run raea:*`、`RAEA_BIN` 这类沿用上游名的内部目录、命令与变量（旧文档里的旧称已停用） | 内部 | [AGENTS.md「命名」](../AGENTS.md#命名) |
| canary.2 | RAEA 现用发行版 `v0.1.0-canary.2`：2026-10-31 发布，2028-10-31 转为 Apache-2.0；版本锁在 `engine/native/runtime.lock.json`，升级要先重跑 B 路线验收，不能随手换 | 限定 | [THIRD-PARTY.md 第 7 节](../THIRD-PARTY.md#7-fsl-使用边界b-路线--北冥原生--bne) |
| FSL-1.1-ALv2 | Functional Source License 1.1：每个版本发布满两年后转为 Apache-2.0，在此之前排除「竞争性使用」 | 限定 | [fsl-boundary.md](rights/fsl-boundary.md) |
| RTX 工作站、shared5090 | 执行环境，不是路线名或产品名；shared5090 是共享 RTX 5090 工作站的执行目标名称，不是仓库自带的调度服务 | 内部 | [RTX工作站.md](RTX工作站.md)、[validation-and-rtx.md](routes/validation-and-rtx.md) |

## 制作与时间

| 词 | 是什么 | 对外 | 出处 |
|---|---|---|---|
| 三渲二 | 三维造型用卡通着色、墨线与笔触渲出二维手绘的观感 | 可以 | [toon.md](../routes/directing/craft/toon.md) |
| 页面约定（v1） | 页面暴露 `window.DUR`、`window.render(t)`、`window.READY`（可选 `TEXTS`、`EV`、`TIMELINE`、`FPS`），渲染器据此逐帧截图；`render(t)` 必须只依赖 t | 内部 | [engine/render/README.md](../engine/render/README.md#2-页面约定-v1附录-c5) |
| `__RENDER` | 渲染器在页面脚本之前注入的只读对象 `{ fps, width, height, profile, frameCount, contract }`；字段为 null 表示没指定，fps 为 null 时页面按自己的帧率出帧并用 `window.FPS` 报回；跟着交付帧率走的页面写 `window.FPS = window.__RENDER?.fps ?? 24` | 内部 | 同上 |
| 镜头上下文 ctx | `film.run` 每帧交给镜头的 `{ shotId, index, inFrame, outFrame, localFrame, localT, fps }`；镜头动作按 `localT` 写，镜头就可以重排、改长 | 内部 | `engine/stage/film.js` 开头注释 |
| 一拍 n | 每张画停 n 个输出帧（一拍二、一拍三），按影片帧率算，25 / 30 fps 下同样成立；用 `engine/core/clock.js` 的 `hold / heldTime / holdAt / heldAt` | 可以 | [animation.md](../routes/directing/craft/animation.md) |
| film.json v2 | 每部作品唯一的作品描述 `films/<名>/film.json`：镜头表与事件表是唯一时间源，一律整数帧 | 内部 | [engine/production/README.md](../engine/production/README.md) |
| 切点（cut） | 镜头的边界帧；镜头是半开区间 `[in, out)`。改切点用 `film.js retime`（ripple 整体平移 / roll 只挪本镜与下一镜之间） | 可以 | 同上 |
| 结果帧 | 事件帧上画面已经变了；声音同帧起音，或晚一帧以内 | 内部 | 同上 |
| 刻意画面（qa.intentional） | film.json 里声明的刻意静帧、黑场、闪白（半开区间、写理由）；是设计声明，不是豁免 | 内部 | [QA-GATE.md](quality/QA-GATE.md) |
| cue id | 声音表里的英文 id；中文说明写在 `visual` / `desc` | 内部 | [engine/production/README.md](../engine/production/README.md) |
| 共享逐帧状态 | 几个镜头共用的材质，逐帧要改的值只在每镜每帧都调用的那一处写（A 模版是 `setToon`），否则 `render(t)` 会依赖渲染历史 | 内部 | `routes/a-webgl/template/world.js` |
| 题款 | A 模版的片名做法：墨色题在亮天上，与山石墨线同一种墨 | 可以 | [A 手册](../routes/a-webgl/README.md) |
| 纸纹锚点 | 后期纸纹跟着画面里的某一点平移和缩放（`paperAnchor` + `screenAnchor`），默认关；推镜时位置误差 ≤ 1 像素 | 内部 | `engine/look/paper.js` |
| 确定性检查 | 新页面、乱序、顺序三种渲法逐像素一致，是多 worker 分段出片的前提（`npm run determinism`） | 内部 | [POLICY.md](style-baselines/POLICY.md) |
| 自包含页面 | 页面源码里没有 `/core/` 绝对路径，素材齐全时可以直接交给 `engine/render` 渲染 | 内部 | [C 手册](../routes/c-style/README.md) |
| 隔离运行时 | `npm run c:setup` 在 `out/runtime/lemo-<提交>/` 下按固定快照建的上游运行环境，不碰家目录 | 内部 | [REPLICATE.md](../routes/c-style/REPLICATE.md) |
| FrameState | 跨后端的镜头与帧状态快照（只传单位与数值，不传运行时对象）；**仍是设计，没有实现成引擎 API**，不报告成已有 | 内部 | [contracts.md](routes/contracts.md) |
| 交付档位 | 画幅、帧率、编码、色彩与响度的一组规格；新作品默认 `web-1080p24`，《北冥》用 `beiming-1040p24`（D07） | 可以 | `engine/production/profiles.json` |

## 闸门、运行与状态

| 词 | 是什么 | 对外 | 出处 |
|---|---|---|---|
| 闸门 look / animatic / final | 三道创作闸（D08）：风格关键帧 → 动态预演 → 终渲；每道都由用户看过、按原话记录，agent 不得自己批准 | 可以 | [creative-review](creative-review/README.md) |
| accepted | 用户认可了这一版终渲后 run.json 的状态；「已交付」「用户已认可」只能由它生成 | 内部；对外写「已交付」也只在 accepted 时 | [tools/film/README.md](../tools/film/README.md) |
| 代理审片（comment） | agent 自己的审片结论，用 `review note` 记成 comment，留证据、不放行任何闸 | 内部 | 同上 |
| 审片记录 | `films/<名>/review/<闸>-<日期>.json`，只记用户原话；没有原话的豁免只记为内部说明（comment），不放行终渲 | 内部 | 同上 |
| 运行目录 | 一次出片的全部产物所在目录 `films/<名>/out/<run-id>/`；run-id 的格式是 `YYYYMMDD-HHMMSS-<提交前 8 位>[-dirty]` | 内部 | 同上 |
| latest 指针 | `out/latest` 文件，内容是最近一次完整跑完且没失败的出片的 run-id（含 `--no-qa` 与 `--size` 工作版，那次是否可交付看它的 run.json）；不是符号链接 | 内部 | 同上 |
| 生效作品描述 | `film.effective.json`：`--profile` 换了画幅或帧率时，运行目录里按档位换算好的作品描述，机器 QA 读这份；作品目录里的 film.json 不改 | 内部 | 同上 |
| 机器 QA 门 | `tools/qa` 的全部检查（规格、画面、文字、底板、声画）；exit 0 才能写「代理检查通过」，不等于交付 | 内部 | [QA-GATE.md](quality/QA-GATE.md) |
| 状态三分离 | 已输出、技术检查通过、用户认可分开记录。案例目录里对应三种互相独立的字段：技术状态（rendered、experiment、previs、interactive、support）、用户认可（approved、rejected、unreviewed，只能由用户原话产生）、权利（public、internal、client-confidential） | 可以 | [案例库工具](cases/casebook.md) |
| 内部素材 | `rights.clearance=internal` 的素材（客户、IP、参考图）：restore 默认不还原，不得用进新作品或对外物料；已有展示按 D02 不下线 | 内部 | 同上 |

## 基线

| 词 | 是什么 | 对外 | 出处 |
|---|---|---|---|
| 回归金标准 | `tests/golden/<平台键>/manifest.json`：像素哈希清单，跟着经审批的画面改动更新 | 内部 | [style-baselines](style-baselines/README.md) |
| 认可参照 | `docs/style-baselines/<名>@v<版本>/`：冻结不改；用户认可了新画面就另立新版本 | 内部 | 同上 |
| 关键帧登记 | 认可参照目录里的 `keyframes.json`（名字 → 帧编号与像素哈希）；图不入库，用 `golden keyframes` 在登记平台上重建到 `out/style-baselines/` | 内部 | 同上 |
| 平台键 | `<系统>-<WebGL 后端>`，例如 `darwin-metal`、`linux-swiftshader` | 内部 | [POLICY.md](style-baselines/POLICY.md) |
| 候选 | 在别的机器上采集、还没经审批的基线 | 内部 | 同上 |

## 工程计划

| 词 | 是什么 | 对外 | 出处 |
|---|---|---|---|
| 集成负责人 | 统一改根文档、注册文件与工程计划状态的角色；单代理会话默认兼任 | 内部 | [AGENTS.md](../AGENTS.md#多代理与集成负责人) |
| T / H 编号 | 引擎工程待办里的任务编号：T 是早先拆出的工程任务，H 是工业级加固的工作包；做作品不用它们 | 内部 | [work-breakdown.md](routes/work-breakdown.md) |
| D01–D11 | 决定书里的十一项决定（三条路线、FSL 边界、命名、交付档位、创作闸门、运行时版本、存储、AI 标识等） | 内部 | [决定书](decisions/2026-11-10-industrial-baseline.md) |
