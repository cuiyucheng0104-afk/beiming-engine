# 三条路线 · 总指引

> 北冥仓库是按路线组织的技术模版仓库。新片先在下表选一条路线（A、B、C 都能直接出片），再读那条路线的手册；作品一律用 `npm run new -- <a|b|c> <名字>` 从模版生成，放在 `films/<名字>/`。路线的机器可读定义在 [routes.json](routes.json)（new-film、规范检查与以后的出片命令都读它），命令约定见 [docs/CLI.md](../docs/CLI.md)。

## 选路线

| 你的需求 | 路线 | 手册 |
|---|---|---|
| 延续《北冥》画风；品牌片、概念片里要精确控制色阶、阴影、墨线、纸纹与二维三维比例 | **A · 北冥风格路线 · WebGL 三渲二** | [a-webgl/README.md](a-webgl/README.md) |
| 用一组参考图探索新的三渲二画风，要能逐帧对照、能重建 | A（成熟的代码画法先到 C 取方法，再回 A 落地） | [a-webgl/README.md](a-webgl/README.md) |
| 通用三维 / 二维混合画面、外部模型、骨骼或 morph 动画、程序化场景、原生 GPU 与更重的着色器 | **B · 北冥原生 · BNE** | [b-native/README.md](b-native/README.md) |
| 要高分辨率或原生 GPU 的性能证据 | B | [b-native/README.md](b-native/README.md) |
| 一种现成的代码动画风格（水墨、油画、浮世绘、白板讲解……）直接出片 | **C · 北冥代码动画风格 · 86 式** | [c-style/README.md](c-style/README.md) |
| PPT 或故事介绍片、信息图、排版与剪辑节奏；复刻历史作品 | C | [c-style/README.md](c-style/README.md) |
| 同一镜头要在两个后端对比 | A + B，各自验收、证据不混用 | 两份手册 |

用户已经指定路线时照用户的；没指定时按上表选，在开工说明里写一句理由，不为路线名反复确认。

三条路线的定位（与 [routes.json](routes.json) 的 `summary` 一致）：

- **A · 北冥风格路线 · WebGL 三渲二**：北冥画风的确定性三渲二。程序化造型、三档卡通着色、屏幕空间墨线、Kuwahara 笔触、底板视差，无头 Chrome 的 WebGL 逐帧出片。
- **B · 北冥原生 · BNE**：通用原生渲染（render anything），可以复用北冥资产，但不要求北冥画风。作品写成一个 TSX 编排，由原生 GPU 运行时逐帧确定性渲出。BNE 是「北冥原生」的英文缩写（Beiming Native Edition），不表示自研运行时：底层是上游的 RAEA 原生运行时（FSL-1.1-ALv2，不随仓库分发），本路线只做内部制作层，用于自制影片与向客户交付成片（D03）。
- **C · 北冥代码动画风格 · 86 式**：页面型代码动画的方法库，外加可直接出片的 C 模版。Canvas 2D、SVG、DOM、WebGL 各自实现画法，一张时间表同时驱动画面与声音；与 A 共用页面渲染器 `engine/render`，不是第三个 GPU 后端；复刻历史作品是 C 的一个子流程（D01）。

## 一部作品怎么做

1. **定调**：按 [导演方法](directing/README.md) 写阐述、出对标；结构与对标给用户确认（⛔1）。路线手册的「这条路线是什么」「边界与常见坑」先读。
2. **生成作品**：在仓库根目录执行

   ```sh
   npm run new -- a my-film --title 我的短片     # 或 b / c；等价于 node tools/new-film.mjs a my-film --title 我的短片
   ```

   它把模版复制到 `films/my-film/`，生成 `film.json`（v2：id、交付档位默认 `web-1080p24`、三道创作闸门、AIGC 标识），拒绝覆盖已有目录，并打印这条路线的下一步命令；`--dry-run` 只列不写，`--json` 给机器读。
3. **改作品**：只改 `films/my-film/` 里的文件。共享能力缺了先查手册「能力清单」；确实要加，放进 `engine/` 对应层，模块开头写中文注释（做什么 + 接口），不写死某部片的常量。
4. **过三道闸**（D08）：先出风格关键帧给用户定画风（look），再做由正片时间轴驱动的动态预演（animatic），两道都拿到用户确认，才终渲（final）。豁免要引用用户原话并注明出处，agent 不能自己批准；「已交付」「用户已认可」只能写用户亲口确认过的。阶段、产物、闸门与审片标尺的总表是作品描述包在建的生产链 SOP（`docs/creative-review/SOP.md`）。
5. **出片与验收**：出片命令由 `npm run new` 打印（各路线不同，见下表）；按手册「验收」一节核对，再跑 `npm run check:repo`。
6. **提交**：只提交源码、模版、文档；产物只写到 `films/<名字>/out/`，不提交。提交说明写中文，写清实际跑过的验收命令。

| 路线 | 先看关键帧 | 出片 |
|---|---|---|
| A | `node engine/render/still.mjs films/my-film 0 1.5 2.958 --size 1920x1080 --out films/my-film/out/stills` | `sh films/my-film/build.sh` |
| B | `node engine/native/prepare.mjs films/my-film`，再 `node engine/render/native.mjs films/my-film --at 0,36,71` | `node engine/render/native.mjs films/my-film`（需 `RAEA_BIN`） |
| C | `node engine/render/still.mjs films/my-film 0.5 1.5 2.958 --size 1920x1080 --out films/my-film/out/stills` | `node engine/render/build.mjs films/my-film` |

三条路线统一的出片入口 `npm run film -- build films/<名字>` 在建；建好之前按上表或 `npm run new` 打印的命令走。声音脚本要装了 `requirements.txt` 的 Python（A、B 读 `PYTHON`，C 读 `BEIMING_PY`）。

三条路线共享：`engine/` 的通用部件、`films/` 的作品结构、`film.json` 作品描述、`npm run check:repo` 的规范检查，以及「已输出 / 技术检查通过 / 用户认可」分开记录的验收口径。

## 仓库地图

| 目录 | 是什么 | 读写 |
|---|---|---|
| `routes/` | 本指引、[routes.json](routes.json) 路线注册表、三份路线手册与模版（`routes/<路线>/template/`）、[导演方法与画面规范](directing/README.md) | 改模版要保证 `npm run new` 之后能直接出片 |
| `films/` | 新作品，一部一个目录，由 `npm run new` 生成 | 作品目录可写；`films/*/out/` 不提交 |
| `engine/` | 共享引擎：A 的九层（`core form shade stage look paint overlay audio render`）、`production/`；B 的通用原生层 `engine/native/` | 可加模块；改已有模块要先出基线再逐帧比对 |
| `src/` | 《北冥》10 秒样片（A 的参考实现与视觉基准） | 只读 |
| `lab/` | A 路线各模块自测页（`index.html?test=<名字>`） | 可加自测页 |
| `examples/raea/` | B 路线已实跑的 10 秒原生例片（目录名沿用上游项目名） | 参考；新作品放 `films/` |
| `cases/` | C 的资料：`vendor/` 第三方风格库快照、`source/` 历史源码归档、`catalog.json` 目录、`entries/` 案例卡、`licenses/` | `vendor/`、`source/`、`catalog.json`、`licenses/` 只读；用 `npm run cases:list` 查、`python3 tools/casebook.py restore <id>` 还原到别处再看 |
| `docs/` | 深入文档、命令约定 [CLI.md](../docs/CLI.md)、[决定书](../docs/decisions/2026-11-10-industrial-baseline.md) | 由集成负责人维护 |
| `tools/` | `new-film.mjs`、`repo-check.mjs`（规则在 `tools/repo-check/rules/`）、命令约定库 `tools/lib/`、`casebook.py` 等 | 改工具要跑 `node --test tests/cli tests/governance` |
| `audio/`、`assets/`、`fonts/`、`media/` | 《北冥》的声音工程、底板与纸纹、字体子集（OFL）、样片与参考帧 | 只读；新素材放作品目录 |
| `site/` | 作品站源码 | 由作品站维护者改 |

**命名**（D04）：对外只用「北冥风格路线 · WebGL 三渲二」「北冥原生 · BNE」「北冥代码动画风格 · 86 式」，产品名不带 RTX。上游项目名（RAEA、两套风格库名）在技术说明、署名与许可说明里如实写，例如「基于 RAEA 原生运行时（FSL-1.1-ALv2）」；不得当我方的产品名、路线名、目录名或文件名。已有内部目录 `examples/raea/`、`docs/raea/`、npm 命令 `raea:*` 与变量 `RAEA_BIN` 沿用上游项目名。来源与许可见 [THIRD-PARTY.md](../THIRD-PARTY.md)。

## 常用命令

```sh
npm run new -- <a|b|c> <名字> [--title 片名] [--dry-run] [--json]   # 新建作品，打印下一步
npm run check:repo                       # 仓库规范检查（只读）；--only core、--json、--list、--strict
npm run cases:list && npm run cases:check  # C 的案例目录与快照校验
npm run build                            # 重建《北冥》样片（A）
```

每个命令加 `--help` 看用法；已接入命令约定的命令（`new`、`check:repo`）的 `--help` 不执行任何操作，其他命令正在改造，`build` 这类出片命令的 `--help` 目前会直接渲染：先看 [docs/CLI.md](../docs/CLI.md) 第 9 节的清单再调。

## 多代理协作

1. **写入范围不重叠**：开工前给每个代理分唯一的写入范围（某个 `films/<名字>/`、某条路线的 `routes/<路线>/`、`engine/` 下的某个新模块）。两个任务碰同一文件就拆分或串行，不用后写覆盖前写。
2. **共享入口归集成负责人**：根目录的 `README.md`、`AGENTS.md`、`ROUTES.md`、本指引与 `routes.json` 由集成负责人统一改；代理在汇报里写修改建议。
3. **改共享契约先对齐**：`film.json` 字段、页面约定、`engine/` 已有接口要改，先通知集成负责人统一字段与版本，再改消费者。
4. **证据分路线**：A 的 WebGL 数据、B 的原生设备与编码器、C 的历史成片互不代替；没在 Windows / 5090 上重跑，就不写成 5090 验证。
5. **许可不可移除**：`cases/licenses/`、`cases/vendor/` 里的许可证与署名、`THIRD-PARTY.md` 列出的义务都保留；不把第三方代码复制进 `engine/` 或 `routes/`，借鉴方法写明来源路径。
6. **新作品不碰基准**：《北冥》原片 `src/`、参考帧 `media/shot_*.jpg` 是 A 的视觉基准，实验放 `films/` 或 `lab/`。
7. **汇报**：基线提交、实际改动文件、跑过的命令与结果原文、产物路径、未完成项；只读了源码就写「源码核对」。
