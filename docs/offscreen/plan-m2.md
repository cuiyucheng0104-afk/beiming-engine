# 离屏出片 M2 实施计划：把 A 路线的墨线与笔触搬到 TSL，拿真实短片过 look 闸

> 前置：M1 已完成（分支 `zz8011/offscreen-m1`，PR #18）。本计划在新分支 `zz8011/offscreen-m2` 上做，避免把 M2 的改动混进 M1 的 PR。
> 约束沿用 D12：路线仍三条，backend `webgpu`、renderer `offscreen`，不叫「原生」，不依赖 `engine/native/`；只写 `engine/offscreen/`、`lab/offscreen/`、`tools/offscreen/`、`docs/offscreen/` 与新建作品目录 `films/<名字>/`。
> M2 回答的问题：**offscreen 能不能把 A 路线的画面做出来，质量能不能过客观阈值与 look 闸**。不是「再做一个渲染器」，而是把 `engine/look/` 已有的画法在 TSL 里复现。

## 现状盘点（读过的源码）

| A 路线模块 | 规模 | 移植难度 | 说明 |
|---|---|---|---|
| `engine/look/kuwahara.js` | 88 行 GLSL | 中 | 8 扇区 Generalized Kuwahara，编译期半径 KR 2..10，深度换远处半径，alpha = 保护量 |
| `engine/look/ink.js` | 150 行 GLSL | 中高 | ID 图 + 深度边缘 → 圆头笔 + 域扭曲 + 笔压 + 断线；`boilSeed(t,p,fps)` 是纯函数，可直接复用 |
| `engine/look/ids.js` | 199 行 JS | 高 | ID 通道的物体语义：outline/outlineWidth/outlineAlpha/outlineGroup/outlinePerInstance/outlineOccluder/alpha 镂空/蒙皮/实例化 |
| `engine/look/paper.js`、`grade.js`、`compose.js` | — | 低中 | 纸纹、调色与合成，M1 演示里已有简化版 |
| `engine/look/pass.js` | 29 行 | 低 | 全屏三角形底座；TSL 用 `QuadMesh` 或自带全屏 pass 替代 |

**范围裁定**：M2 的 ID 通道只覆盖选定短片实际用到的语义（不透明 Mesh、`outline` / `outlineWidth` / `outlineAlpha` / `outlineGroup`、遮挡）。蒙皮、InstancedMesh 逐实例 ID、`outlineOccluder` 的 soft/own、`outlineVertex` 自定义顶点位移**不在 M2**，代码里显式抛「未支持」而不是静默画错；要用的作品一旦用到这些，先扩范围再做片。

## 任务拆分

### T1 对拍脚手架：A 路线 WebGL 参考帧 vs offscreen TSL 帧
- 新增 `tools/offscreen/look-compare.mjs`：同一场景、同一帧号、同一尺寸，一边走现有 A 路线 Chromium 出静帧，一边走 offscreen 出帧，用 M1 的 `diffRgba` / `meetsGate` 出报告。
- 参考帧不进仓库，写到 `out/offscreen-look/<run>/`；阈值是工程门，不代替 look 闸。
- 测试：故意把 TSL 版参数调偏，对拍必须 exit 4。

### T2 TSL Kuwahara（8 扇区，含深度换半径与保护量）
- `engine/offscreen/tsl/kuwahara.js`：与 GLSL 版同一套扇区权重（cos⁸ 角向 × 高斯径向）、同一 alpha 保护语义。
- 测试：固定合成图（色块 + 灯点保护区 + 远近两级深度）在两种实现下对拍；先测出实际差距再定阈值，阈值写进测试注释。
- 记录 1080p 单帧耗时，KR 变体数量与 M1 一样按需编译。

### T3 ID 通道与屏幕空间墨线（子集）
- `engine/offscreen/tsl/idpass.js`：场景遍历换成 ID `NodeMaterial`，RGBA 编码沿用 `(id 低 11 位, id 高位, 线宽系数, 线可见度)`；目标带 DepthTexture、Nearest、无 MSAA。
- `engine/offscreen/tsl/ink.js`：边缘检测 + 圆头笔 + 域扭曲 + 笔压 + 断线；沸腾种子直接 `import { boilSeed } from '../../look/ink.js'`，保证与 A 同一拍一沸。
- 测试：两个相交方块 + 一个同组部件 + 一个不描边遮挡物，验证「同组不出内部线、近的一侧拥有这条线、boilHold 帧内不动」；再与 A 参考帧对拍。

### T4 纸纹 / 调色 / 合成对齐
- 把 M1 演示里的简化纸纹换成与 `engine/look/paper.js`、`grade.js` 相同的参数与顺序（墨色叠加 color/tint/darken 在合成步）。
- 测试：同一组参数下合成结果对拍。

### T5 一部真实短片走 look 闸
- 用 `npm run new -- a <名字>` 建作品（不动别人的 `films/`），镜头控制在 1–2 个、3–5 秒，画面要素覆盖：三渲二主体、墨线（外轮廓 + 折痕 + 沸腾）、Kuwahara 笔触、纸纹与底板。
- `npm run film -- stills` 出风格关键帧给用户看（look 闸，**用户原话批准**，agent 不自己批）；之后 animatic 闸；终渲仍走现有 Chromium 链，offscreen 出片作为对照版本，直到用户认可才讨论切换。
- `npm run determinism -- films/<名字> --seams --workers 4` 与 offscreen 自身的逐帧哈希都要过。

### T6 文档与收尾
- `docs/offscreen/README.md` 加 M2 实测节：对拍阈值与实测值、单帧耗时、与 M1 吞吐的对比、未支持的 ID 语义清单。
- CHANGELOG、独立代码审查、遗留 Minor 记录。

## 风险

1. **性能**：8 扇区 Kuwahara 在 1080p 上是每像素上百次采样，Dawn/ Vulkan 下的耗时可能直接吃掉 M1 的吞吐优势；T2 必须先量再决定要不要做半径变体或降采样。
2. **精度**：ID 用 HalfFloat 存整数、深度用 1/z 二阶差分，WebGPU 的深度范围与精度与 WebGL 不同，边缘阈值可能要重新标定——标定值差异要写进文档，不能悄悄调到过。
3. **范围蔓延**：`ids.js` 的完整语义接近一个小引擎，M2 只做子集并显式报错，不追求一次到位。
