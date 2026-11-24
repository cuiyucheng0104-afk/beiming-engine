---
name: beiming-tsl
description: 在北冥仓库里改 Three.js TSL / WebGPU 离屏渲染管线（engine/offscreen/tsl/）或为它调参、加 pass、扩展节点时用它：墨线、Kuwahara 笔触、三档卡通、纸纹颗粒、雾、bloom、调色、底板合成、ID 通道、分层风格化与调试视图的模块路由、参数表与确定性/风格基线约束。做整部片先走 beiming-film；纯 Canvas 2D 页面、音频、普通脚本、Shadertoy/GLSL 片段不触发本 skill。
---

# 北冥 TSL 离屏管线：模块路由与调参

服务对象是 `engine/offscreen/tsl/` 这条 Three.js r187 + WebGPU/TSL 的确定性出片管线（A/C 路线 `backend: webgpu` 的渲染核）。三个入口，按需读，不通读：

- 想做什么效果 → [references/subject-routing.md](references/subject-routing.md)（诉求 → 模块 · 符号 · 参数 · 仓内真实示例）
- 查某个符号在哪个模块、依赖谁 → [references/library-index.md](references/library-index.md)（脚本生成，`node tools/tsl-skill-index.mjs --check` 防漂移）
- 怎么验证、怎么调试 → [references/workflow-and-debugging.md](references/workflow-and-debugging.md)（管线位置图、确定性红线、调试视图、单测与对拍、基线保护）

## 触发边界

**触发**：改 `engine/offscreen/tsl/*.js` 或周边（`engine/offscreen/` 的宿主/管线）、给作品写/改 WebGPU 离屏作品模块（`films/<名字>/offscreen.mjs`，契约 `docs/offscreen/README.md` §2.1）、调 A 风格后期参数（墨线/笔触/分阶/纸纹/雾/bloom/调色）、写新的 TSL pass 或表面层、排查离屏渲染的画质或性能问题。

**不触发**：做整部片（选路线、建作品、过闸门 → `beiming-film`）；C 路线页面渲染器的 86 式风格（`engine/render`，页面约定不同）；纯 Canvas 2D 动画；音频链路；与渲染无关的脚本工程；页面渲染器（WebGL/GLSL ShaderMaterial）——那是另一条链，模块在 `engine/look` / `engine/shade`，只在「对应关系」上与本管线同源。**明确不受理 Shadertoy / GLSL 片段移植**：本管线是 TSL 节点图，不引入 Shadertoy 代码（见 workflow-and-debugging.md「许可边界」）。

## 一步上手

1. 拿诉求查 [subject-routing.md](references/subject-routing.md) 的总表，落到模块与符号。
2. 打开那个模块读**文件头注释**——参数、默认值、坑都写在头 30 行里（仓内约定，比任何二手文档准）。
3. 按现有作品抄结构：完整 A 风格接法看 `films/chendu/offscreen.mjs` + `films/chendu/world.js`，最小演示看 `lab/offscreen/ink.mjs`。
4. 单帧验证 → `debug` 视图 → 确定性 → 基线，流程照 [workflow-and-debugging.md](references/workflow-and-debugging.md) 第 0 节走完。

## 管线关键约束（改前自查）

- **确定性**：时间只从整数帧 `f` 来；随机只用 `mulberry(种子)` 或整数种子 TSL 哈希（`noise.js`）；同帧同参数必须逐字节相同。细节与 `stateKey` 语义见 workflow-and-debugging.md 第 2 节。
- **THREE / TSL 由宿主注入**：作品与 tsl 模块都不 `import 'three'`（仓库 `three` 锁 r170，离屏用 `three-webgpu` r187）；后期管线用宿主给的 `pipeline(outputNode)`，不自己 `new RenderPipeline`。
- **组合顺序是画风**：`look.js` 的 ①场景 → ②墨线 → ③雾/bloom/调色 → ④Kuwahara/纸纹/暗角/颗粒 顺序与各模块常数与页面渲染器（`engine/look/`）逐项对应；改了要过金标准与风格基线审批（POLICY 第 6 节），agent 不得自批。
- **色彩空间纪律**：场景与 grade 在线性 HDR，Kuwahara 与合成在 sRGB 数值空间；输出目标是 sRGB 且管线 `outputColorTransform = false`——自己加 pass 时别再叠一次 sRGB。
- **不支持就抛错**：BatchedMesh、多材质数组、GLSL-only 钩子等会抛 `unsupported.*`，不静默画错；遇到先改用法，不要绕。
- **性能**：全屏 pass 想快就学 `ink.js` / `kuwahara.js` 的做法（编译期常量表、块归约早退、按 KR 变体缓存）；`npm run offscreen -- profile <作品.mjs>` 看每段 GPU 占比。

## 维护

- 源码改了：`node tools/tsl-skill-index.mjs` 重新生成 library-index.md，`npm run tsl:index:check`（或 `npm test -- --only offscreen` 里的 tsl-skill 测试）拦漂移。
- 本 skill 的正负触发用例在 [evals/](evals/)：改触发边界（SKILL.md 的 description 或「触发边界」节）时同步改用例；`tests/offscreen/tsl-skill.test.mjs` 校验用例结构完备。
