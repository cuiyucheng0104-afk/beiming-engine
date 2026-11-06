# 北冥仓库：给创作与工程 agent 的入口

开始制作前先读 [ROUTES.md](ROUTES.md)，选择 **北冥风格路线** 或 **RAEA 原生路线**。路线与渲染后端是两个概念，不要把所有任务统一套进一个已有示例。

详细操作入口在 [docs/routes/README.md](docs/routes/README.md)。北冥风格、原生场景、接口和 QA 各有手册，不能只读本文件就假定所有能力已实现。

## 工程分工与多代理

- 使用 `npm run routes:check` 核对计划，用 `npm run routes:next -- --route beiming` 或 `--route raea` 找到依赖已满足的任务。该工具只读，不执行任务。
- 用户要求多代理时，按 [工作分解](docs/routes/work-breakdown.md) 分配互不重叠的写入范围。共享契约、根文档和工作状态由集成负责人统一维护。
- [work-plan.json](docs/routes/work-plan.json) 的 T 编号是跨路线任务状态源；各手册 A/R/V 编号只是局部步骤。完成任务必须填写真实证据，不因文档写完而把代码实现标完成。
- 子代理返回任务 ID、基线提交、实际改动、运行命令及结果、产物、未完成项。集成者复核后更新状态。
- 两条路线可以独立推进。RAEA 原生作品不必等待北冥 FrameState 或风格适配器完成。
- 先复用现有入口完成小样；21 项任务不是每部作品的前置清单。按实际需求引入契约和适配层，不提前实现整套框架。
- `blocked` 不释放写入范围；移交由集成人员调整。修改 work-plan.json 时同步任务卡，运行 `npm run test:routes` 验证内容一致。

## 路线选择

- 延续北冥画风、精确风格控制或参考图风格实验：优先北冥风格路线，先读 `engine/` 的相关模块和原版 `src/`。
- 用户明确要求直接使用 RAEA，或作品不依赖北冥美术规则：走 RAEA 原生路线，先读 `examples/raea/README.md` 和 `docs/raea/architecture.md`。
- 北冥画风结合 RAEA 能力：仍属于北冥风格路线，按 `docs/raea/integration.md` 实现对应适配，保留风格对照。
- 说明所选路线和理由；已有用户决定优先。不要只因内部架构命名而重复要求用户确认。

## 已实现和设计稿

- Three 主线：`npm run build`、`npm run stills`、`npm run video`。
- 独立原生实验：`npm run raea:prepare`、`npm run raea:check`、`npm run raea:render`。
- `docs/raea/integration.md` 的 `FrameState`、production/performance/style/backends 目录是架构方案，不能报告成已经存在的 API。
- 目前的原生例片验证资产转换和渲染；它不证明原版 ID 墨线/Kuwahara 已移植，也不证明完整人物表演已经实现。

## 制作要求

1. 新作品使用独立目录。默认保留原版 `src/` 与关键帧基准，除非任务要求直接修改原片。
2. 色彩、材质、光照、笔触、空间和动作分别验证。不要把给照片做后期滤镜描述成已完成三维建模。
3. 用整数帧驱动时间；区分全局时间、镜头局部时间和动作相位。对有状态模拟先验证顺序/跳帧，再决定是否分段并行。
4. 角色动作必须落实到可见姿态、视线、接触或形变。技术检查通过不能替代观看整片。
5. Three 的 GLSL 与 RAEA 的 WESL 分别实现；GLB 不会携带原有屏幕描边和后期。
6. 读取 RAEA 的固定版本资料。canary.2 没有 `--version` 命令，安装包的 `share/raea/VERSION` 提供版本声明。运行包装需设置 `RAEA_BIN` 完整路径。
7. 使用共享 GPU 时先检查已有队列与负载；不终止其他任务。记录实际 GPU、图形后端与编码器，不把 Vulkan 写成已经启用 NVENC/DLSS。
8. 按项目权限使用两套代码，保留来源和版权声明。仓库中的生成素材、运行时和交付文件按现有 `.gitignore` 处理，不自动提交。

## 修改后检查

- 文档改动核对相对链接与固定提交引用。
- 资产桥改动运行导出、结构验证和动画回读。
- 渲染路径改动运行相关示例，检查日志、输出帧数、关键帧和完整视频。
- 报告实际运行的平台；没有重跑 Windows/5090 时，不把 macOS 验证写成新的 5090 验证。
- 修改案例目录或 `tools/build-showcase.py` 后运行 `python tools/build-showcase.py` 并核对 `showcase/index.html`；再跑 casebook 校验。
- 不得删除或改写 `LICENSE`、`cases/licenses/`、`cases/vendor/` 内的许可证与署名；整合、改写、调参不改变原作者权利。详见 `THIRD-PARTY.md`。

## 查找已做过的案例

- 从 `cases/INDEX.md` / `cases/catalog.json` 找案例，再读 `docs/cases/comparison.md` 和相关案例卡。PPT项目读 `docs/cases/ppt-animation.md`。
- `cases/vendor/` 是SY100示例与Lemo全部风格的完整固定快照，不就地修改。沿用来源、许可证和版本；共用方法不等于所有影片都由同一引擎实现。
- 代码和素材已去重，用 `python3 tools/casebook.py restore <id>` 还原到独立工作区。源码里的 `@@...@@` 是显式还原标记，不能直接把归档路径当可执行项目。
- 已输出、历史声画通过、用户认可分别判断；《豹变》四版及北冥九分钟的后续否定反馈优先于旧文件里的“已完成”。
- 修改目录/还原工具后运行 `python3 tools/casebook.py check` 和 `python3 -m unittest discover -s tools -p test_casebook.py`。外部快照校验覆盖全部跟踪文件。
