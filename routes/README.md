# 三条路线 · 总指引

> 北冥仓库是一个按路线组织的技术模版仓库：先在下表选路线，再进对应手册；新作品一律用 `node tools/new-film.mjs <a|b|c> <名字>` 从模版生成，放在 `films/<名字>/`。

| 你的需求 | 走哪条路线 | 进哪个手册 |
|---|---|---|
| 延续《北冥》画风；做品牌片 / 概念片，要精确控制色阶、阴影、墨线、纸纹 | **A · 北冥风格路线 · WebGL 三渲二** | [routes/a-webgl/README.md](a-webgl/README.md) |
| 用一组参考图探索新的三渲二画风，要可逐帧对照、可重建 | A（需要成熟画法时先去 C 取方法） | [routes/a-webgl/README.md](a-webgl/README.md) |
| 通用三维 / 二维混合画面、骨骼角色、程序化场景、原生 GPU 与更重的着色器——render anything，不受北冥画风约束 | **B · 北冥原生 · BNE** | [routes/b-native/README.md](b-native/README.md) |
| 要高分辨率 / 原生 GPU 的性能证据 | B | [routes/b-native/README.md](b-native/README.md) |
| 找一种现成的代码动画风格（水墨、油画、浮世绘、白板讲解……）直接出片 | **C · 北冥代码动画风格 · 86 式** | [routes/c-style/README.md](c-style/README.md) |
| PPT / 故事介绍片、信息图、排版与剪辑节奏 | C | [routes/c-style/README.md](c-style/README.md) |
| 北冥画风 + 原生运行时的角色或执行能力 | A 为主，按 [集成指引](../docs/raea/integration.md) 加原生适配（设计稿，未实现） | [routes/a-webgl/README.md](a-webgl/README.md) |
| 同一镜头要在两个后端对比 | A + B，各自验收 | 两份手册 + [技术分档](../docs/TRACKS.md) |

用户已经指定路线时照用户的；没指定时按上表选，并在开工说明里写一句理由，不需要为路线名反复确认。

## 通用工作流

1. **选路线**：按上表；读对应手册的「这条路线是什么」「边界与常见坑」。
2. **生成作品**：

   ```sh
   node tools/new-film.mjs a my-film --title 我的短片     # 或 b / c；等价于 npm run new -- a my-film --title 我的短片
   ```

   它把 `routes/<路线>/template/` 复制到 `films/my-film/`，把 `{{NAME}}` / `{{TITLE}}` 换成名字与标题，拒绝覆盖已有目录，并打印下一步命令。
3. **改作品**：只改 `films/my-film/` 里的文件。共享能力缺了，先查手册「能力清单」；确实要加，放进 `engine/` 对应层（A 九层；B 的通用层放 `engine/native/`；C 抽出的公共件放进对应层），模块开头写中文注释（做什么 + 接口），不写死某部片的常量。
4. **按手册验收**：每条路线手册的「验收」一节给出命令与判据；再跑 `npm run check:repo`。
5. **提交**：只提交源码、模版、文档；`out/`、`films/*/out/`、帧序列、wav、mp4 不提交（`.gitignore` 已覆盖）。提交说明写中文，写清实际跑过的验收命令。

## 三条路线的定位与边界

| | 定位 | 边界 |
|---|---|---|
| **A · 北冥风格路线 · WebGL 三渲二** | 北冥画风的**确定性三渲二**：程序化造型 + 三档卡通着色 + 屏幕空间墨线 + Kuwahara 笔触 + 底板视差 + 显示层，无头 Chrome 逐帧出片 | 执行面是浏览器 WebGL；FrameState 跨后端适配、完整人物表演未实现；它的 GPU 数据只代表 WebGL |
| **B · 北冥原生 · BNE** | **通用原生渲染，render anything**：原生运行时（Rust + Bevy）直接组织场景、模型动画、着色器与后期，不必套北冥的卡通材质与镜头外壳 | 原生运行时不随仓库分发，需本机安装并设 `RAEA_BIN`；原版 ID 墨线 / Kuwahara 等价、人物表演未实现；设备、图形后端、编码器分别记录 |
| **C · 北冥代码动画风格 · 86 式** | **代码动画方法库**：Canvas 2D / SVG / DOM / WebGL 各自实现的成熟画法、排版、剪辑节奏与声画编排；可以单独出片，也可以给 A / B 提供方法 | 不是第三个渲染后端；`cases/vendor/` 是第三方风格库的固定快照、`cases/source/` 是历史源码归档，都只读，保留原作者许可与署名 |

三条路线共享：`engine/` 的通用部件、`films/` 的作品结构、`film.json` 的最小记录、`npm run check:repo` 的规范检查和「状态三分离」的验收口径。

## 仓库地图

| 目录 | 是什么 | 读写 |
|---|---|---|
| `routes/` | 本指引、三份路线手册、三个模版（`routes/<路线>/template/`） | 改模版要保证 `new-film` 后能直接出片 |
| `films/` | 新作品，一部一个目录，由 `tools/new-film.mjs` 生成 | 作品自己的目录可写；`films/*/out/` 不提交 |
| `engine/` | 共享引擎：A 的九层（`core form shade stage look paint overlay audio render`）+ `production/`；B 的通用层放 `engine/native/` | 可加模块；改已有模块要先出基线再逐帧比对 |
| `src/` | 《北冥》10 秒样片（A 路线参考实现与视觉基准） | 默认只读 |
| `lab/` | A 路线各模块自测页（`index.html?test=<名字>`） | 可加自测页 |
| `examples/raea/` | B 路线已实跑的 10 秒原生例片：TSX 场景、资产桥、声音、运行包装（目录名是历史工程代号） | 参考；新作品放 `films/` |
| `cases/` | C 路线：`cases/vendor/` 第三方风格库快照、`cases/source/` 历史源码归档、`cases/catalog.json` 目录、`cases/entries/` 案例卡、`cases/licenses/` 许可证 | `vendor/`、`source/`、`catalog.json`、`licenses/` 只读；用 `python3 tools/casebook.py restore <id>` 还原到别处再改 |
| `docs/` | 深入文档：路线详解、契约、21 项工作分解（`docs/routes/`）、原生运行时源码对照与集成方案（`docs/raea/`）、技术分档（`docs/TRACKS.md`） | 由集成负责人维护 |
| `audio/` | 《北冥》声音工程（混音、自检） | 参考 |
| `assets/`、`fonts/`、`media/` | 《北冥》底板与纸纹、字体子集（OFL）、样片与参考帧 | 只读；新素材放作品目录 |
| `showcase/` | 作品站页面（由 `tools/build-showcase.py` 生成） | 由作品站维护者改 |
| `tools/` | `new-film.mjs`（新建作品）、`repo-check.mjs`（规范检查）、`work-plan.mjs`（任务计划）、`casebook.py`（案例库）等 | 改工具要跑对应测试 |
| `tests/` | 引擎单元测试（如 `node --test tests/production/project.test.mjs`） | 可加 |
| 根文件 | `AGENTS.md`、`README.md`、`ROUTES.md`、`THIRD-PARTY.md`、`LICENSE`、`build.sh`（《北冥》一键重建） | 根文档由集成负责人统一改；`LICENSE` 不动 |

**命名规则**：对外只用「北冥风格路线 · WebGL 三渲二」「北冥原生 · BNE」「北冥代码动画风格 · 86 式」。内部工程代号只留在已有目录（`examples/raea/`、`docs/raea/`）、npm 命令（`npm run raea:prepare` 等）和环境变量（`RAEA_BIN`）里；新建的目录、文件名和 `routes/` 下的正文不用内部代号（`npm run check:repo` 会查）。

## 常用命令

```sh
npm run new -- <a|b|c> <名字> [--title 标题]   # 新建作品
npm run check:repo                            # 仓库规范检查（只读）；--json 输出机器可读结果
npm run build                                 # 重建《北冥》样片（A）
npm run raea:prepare                          # B 的原生例片：准备资产（GLB、底板、声音）
RAEA_BIN=/绝对路径/raea npm run raea:check     # B：检查运行时版本、命令与素材（不启动 GPU 渲染）
npm run cases:list && npm run cases:check     # C 的案例目录与快照校验
npm run routes:check                          # 21 项工作计划的一致性检查
```

## 多代理协作规则

吸收自 [AGENTS.md](../AGENTS.md) 与 [工作分解](../docs/routes/work-breakdown.md)，冲突时以那两份为准。

1. **写入范围不重叠**：开工前给每个代理分配唯一的写入范围（某个 `films/<名字>/`、某条路线的 `routes/<路线>/`、`engine/` 下的某个新模块）。两个任务碰同一文件就拆分或串行，不用后写覆盖前写，不恢复别人的文件。
2. **共享入口归集成负责人**：根 `README.md`、`ROUTES.md`、`AGENTS.md`、`docs/routes/work-plan.json` 与本指引由集成负责人统一改；代理在汇报里写修改建议。
3. **改共享契约先对齐**：`film.json` 字段、页面约定、`engine/` 已有接口要改，先通知集成负责人统一字段与版本，再改消费者。
4. **证据分路线**：A 的 WebGL / Vulkan 数据、B 的原生设备与编码器、C 的历史成片，互相不能当对方的成绩；没在 Windows / 5090 上重跑，就不写成 5090 验证。
5. **状态三分离**：**已输出**（文件在）、**技术检查通过**（帧数、尺寸、音轨、完整解码、确定性）、**人工认可**（用户看过并认可）分别记录；历史归档里的「已完成」不等于被认可。
6. **汇报格式**：任务 ID（如有 T 编号）、基线提交、实际改动文件、跑过的命令与结果原文、产物路径、未完成项。只读了源码就写「源码核对」。
7. **许可不可移除**：`cases/licenses/`、`cases/vendor/` 里的许可证与署名、`THIRD-PARTY.md` 列出的义务都保留；不把第三方代码复制进 `engine/` 或 `routes/`，借鉴方法时写明来源路径。
8. **新作品不碰基准**：《北冥》原片 `src/`、参考帧 `media/shot_*.jpg` 是 A 的视觉基准，实验放 `films/` 或 `lab/`。
