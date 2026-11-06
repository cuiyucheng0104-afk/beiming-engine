# 两条创作路线

北冥仓库提供两条路线：**北冥风格路线**和 **RAEA 原生路线**。路线决定创作与工程组织方式；后端决定画面在哪里执行。两者分开选择。执行后端的技术分档（WebGL / RAEA 原生 / 纯代码风格基座）见 [docs/TRACKS.md](docs/TRACKS.md)，本页只管创作组织与任务分派。

## 从路线进入工程

| 工程入口 | 包含什么 |
|---|---|
| [双路线工程手册](docs/routes/README.md) | 阅读顺序、现状与可执行命令 |
| [北冥风格路线详解](docs/routes/beiming-style.md) | 真实模块和参数、变量实验、动作与画风扩展步骤 |
| [RAEA 原生路线详解](docs/routes/raea-native.md) | 原生 SDK、独立项目、场景/模型/材质、故障与运行步骤 |
| [数据与模块契约](docs/routes/contracts.md) | 字段、单位、时钟、生命周期和失败语义 |
| [验收与 5090 执行](docs/routes/validation-and-rtx.md) | 技术、视觉、动作和受控性能验证 |
| [21 项工作分解](docs/routes/work-breakdown.md) | 负责人、依赖、输入、写入范围、交付和完成条件 |

```sh
npm run routes:next -- --route beiming
npm run routes:next -- --route raea
```

上述命令只列计划，不启动渲染。状态以 [work-plan.json](docs/routes/work-plan.json) 为准，待实现接口明确标注为设计稿。

## A · 北冥风格路线

以北冥的造型、绘画、色阶、墨线、底板、分层动画和后期体系为基础，继续发展有辨识度的画风。RAEA 的场景组织、角色目标、动画和原生能力用于完善这套体系。

适用于：延续已有作品的视觉规范；开发新的风格预设；需要精确控制色阶、阴影、轮廓、纸纹与二维/三维比例。

工作入口：

- [`engine/`](engine)：美术和制作模块。
- [`src/`](src)：当前北冥影片及造型/材质预设的参考实现。
- [`lab/`](lab)：造型、材质、人物和后期自测。
- [技术集成指引](docs/raea/integration.md)：如何将 RAEA 的能力接入北冥制作层。

工作顺序：选定视觉基准 → 拆解造型/材质/光照/笔触 → 固定参数版本 → 完成一个动作事件 → 扩展镜头和时长。用户要求延续原预告片时，保留原预告片作为基准，逐层比较。

当前后端是 Three.js / Canvas 2D；未来可以增加原生执行适配器。**北冥路线的身份由美术与制作体系决定，不由 Three.js 这个实现依赖单独决定。**

## B · RAEA 原生路线

直接使用 RAEA 的 React/TypeScript、原生页面与 Bevy 场景、模型动画、自定义着色器、后期及其他 SDK 能力来组织作品。可以复用北冥资产，也可以使用独立艺术设定；不必套用北冥的卡通材质、Kuwahara 或既有镜头外壳。

适用于：通用二维/三维混合画面、骨骼角色、程序化场景、原生 GPU 实验，以及不要求延续北冥既有画风的作品。

工作入口：

- [`examples/raea/README.md`](examples/raea/README.md)：已实跑项目的准备、检查、渲染命令。
- [`examples/raea/film.tsx`](examples/raea/film.tsx)：可运行 TSX 场景参考。
- [`examples/raea/tools/`](examples/raea/tools)：自有资产桥、声音和运行包装。
- [源码对照](docs/raea/architecture.md)：运行时与 SDK 的具体来源。

工作顺序：选定 RAEA 组件与运行版本 → 建立原生场景 → 配置资产/动画/材质 → 验证目标 GPU → 输出与人工验收。新作品应有自己的项目目录；现有 10 秒例片是可运行参考，不是任意剧情的万能模板。

## 如何选择

| 需求 | 优先路线 | 必须保留的证据 |
|---|---|---|
| “继续原版北冥”“保持预告片同画风” | A 北冥风格 | 原版关键帧、风格参数、差异记录 |
| “用这一组参考图探索新画风” | A 北冥风格 | 色阶/材质/光照拆解与同场景变体 |
| “直接用 RAEA 做一段原生动画” | B RAEA 原生 | TSX 场景、运行版本、输出检查 |
| “做更通用的原生场景或角色实验” | B RAEA 原生 | 功能实跑、资产与动作验证 |
| “北冥画风 + RAEA 的角色/执行能力” | A 北冥风格，增加原生适配 | 风格对齐、角色表演和后端差异分别验收 |

未明确指定时，根据视觉目标与已确认方向选择，并在开工说明中写清理由。不需要仅为路线命名重复询问用户。

## 路线和后端是两个字段

以下是项目记录建议，**不是已经实现的统一配置解析器**：

```json
{
  "route": "beiming",
  "backend": "three",
  "visualBaseline": "beiming-original",
  "styleVersion": "v1",
  "fps": 24,
  "width": 1920,
  "height": 1040
}
```

| 组合 | 当前状态 |
|---|---|
| `beiming + three` | 已有主线，`npm run build` |
| `raea + raea` | 已有独立 10 秒实验，`npm run raea:prepare/check/render` |
| `beiming + raea` | 资产已打通；通用制作接口、原版材质/笔触等价与人物表演仍待实现 |

两条路线共享自有素材、资产转换、版本记录和交付检查。RAEA 原生路线可以直接编写 TSX，不必等待北冥的统一 FrameState 层完成。需要把北冥作品迁往原生执行时，再按 [集成指引](docs/raea/integration.md) 建立统一状态与适配器。

## GPU 与交付

RAEA 原生 GPU 管线是 B 路线的执行基础，也可以成为 A 路线未来的执行选项。Windows Vulkan 图形执行、GPU 读回、视频编码是不同阶段，分别记录实际后端；当前 canary 的默认 OpenH264 编码不能标为 NVENC。

两条路线都记录尺寸、帧率、资产版本、完整解码帧数、音轨和人工视觉验收。原生速度与画风质量分别评价；延续北冥画风必须有对照帧，通用原生作品则按自己的视觉目标验收。
