# 北冥原生路线：运行时源码与集成

> 读者：想了解北冥原生 · BNE 底层的人｜状态：深入资料目录页｜依据：版本基线见下表

**做片先读 [B 路线手册](../../routes/b-native/README.md)**：那里是唯一的操作入口（新建作品、准备素材、草图帧、出片、交付规格、画面工艺、FSL 使用边界）。本目录是它的深入资料：运行时源码对照、历史实验记录与集成设计。

北冥原生 · BNE（Beiming Native Edition）是本仓库的通用原生渲染路线，基于上游原生运行时 RAEA（FSL-1.1-ALv2；目录名 `docs/raea/` 与 `examples/raea/` 是上游项目名，内部沿用）。决定 D03：它只作内部制作层——自制影片、向客户交付成片——不作为对外的产品、SDK 或渲染服务；仓库不分发运行时、不复制其源码，版本与哈希锁在 `engine/native/runtime.lock.json`。许可边界全文与 agent 规则见 [docs/rights/fsl-boundary.md](../rights/fsl-boundary.md)。

**当前状态（2026-11-10）：** 通用原生层 `engine/native/`、唯一出片入口 `engine/render/native.mjs`（母版逐位复制 + BT.709 网页版 + run.json + 运行时自带成片检查）、最小作品模版与《北冥》例片均已在 macOS 实跑；角色表演系统、原版画风（ID 墨线、Kuwahara）的等价迁移、Windows / 5090 上用新入口重跑仍是待办。原有 A 路与 Three.js 主线不依赖原生运行时。

```sh
node engine/native/runtime.mjs status                   # 运行时版本与可执行文件哈希是否与锁一致
node engine/native/prepare.mjs examples/raea            # 例片素材（= npm run raea:prepare）
node engine/render/native.mjs examples/raea             # 例片出片 → examples/raea/out/<run-id>/
```

| 阅读目标 | 入口 |
|---|---|
| 看完整调用链、具体函数和源码证据 | [源码对照](architecture.md) |
| 决定改哪些文件、接口怎样设计、怎样验收 | [技术集成指引](integration.md) |
| 做一部新作品 | [B 路线手册](../../routes/b-native/README.md) |
| 复现已跑通的 GLB → 原生 10 秒流程 | [例片源码与运行说明](../../examples/raea/README.md) |
| 理解鲲的着色器变形如何转成骨骼动画 | [资产桥接说明](../../examples/raea/ASSET-BRIDGE.md) |
| 看实际测量与画面限制 | [实测记录](experiment.md)（含 2026-11-10 重构后复现）/ [原始指标](experiment-qa.json) |
| 理解长片需要补什么制作能力 | [制作层改进](production.md) |
| 程序化查询源码定位 | [source-map.json](source-map.json) |

## 版本基线

| 对象 | 固定版本 | 用途 |
|---|---|---|
| 北冥 | `a65c172246d04351e3e380f2d5925d2a6ff1950a` | 研究与原资产基线 |
| RAEA 源码 | `fb3f70844e03cc40185e3a06c394060d26c5cd38` | 源码引用定位 |
| RAEA 发行包 | `v0.1.0-canary.2` | Mac / Windows 实际运行版本；三平台归档与 macOS 可执行文件 sha256 见 `engine/native/runtime.lock.json` |
| Three.js | `0.170.0` | 原材质补丁、建模与资产导出 |

源码快照和发行包分别固定；本文不声称该 canary 二进制恰好由引用的 HEAD 构建。升级任一侧都需要重跑资产、颜色、动作与输出验证。

## 集成原则

1. **共享创作输入。** 镜头、动作、资产、色板与视觉要求逐步独立于执行后端。
2. **分别实现渲染。** Three 的 GLSL、RAEA 的 WESL、颜色管理和描边阶段分别校准；同名参数不直接等价。
3. **先证明一个事件。** 人物看到、反应、行动及环境反馈都要有真实画面，再扩大时长。
4. **保留原版作为基准。** 新后端的优势由同内容、同画幅、同画质要求的实测说明。

来源记录：RAEA 采用 [FSL-1.1-ALv2](https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/LICENSE)。本目录发布原创分析、影片代码和资产转换脚本，运行时/SDK 单独安装。架构按具备相应整合权限的项目方使用场景设计，工程职责与来源声明分别管理。
