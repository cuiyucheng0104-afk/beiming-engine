# 北冥仓库：给创作与工程 agent 的入口

开始制作前先读 [ROUTES.md](ROUTES.md)，选择 **北冥风格路线** 或 **RAEA 原生路线**。路线与渲染后端是两个概念，不要把所有任务统一套进一个已有示例。

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
