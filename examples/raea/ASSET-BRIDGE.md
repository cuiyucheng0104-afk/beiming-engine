# 北冥 → 原生 GLB 资产（鲲与渡船）

入口：`node examples/raea/tools/export-kun.mjs [--preview] [--lod=0.5]`（等同 `node engine/native/bridge/export.mjs examples/raea`；`npm run raea:prepare` 会顺带执行）。

通用资产桥在 `engine/native/bridge/`：`export.mjs` 起只读的随机回环端口服务（根目录 = 仓库根）和无头 Chromium（SwiftShader 软件 GL），加载 `browser.mjs`；`bake.mjs`（engine/shade 反照率烘焙）、`geometry.mjs`（放样 UV、站点权重、实例合并与 morph）、`rig.mjs`（engine/form/bend 弯曲波 → 骨骼）、`validate.mjs`（GLB 结构检查）都与具体生物无关。本目录只留鲲的配方 `tools/export-kun-browser.mjs`；渡船走通用的「模块 + 导出名」路径（`film.json` 里 `module: ../../src/ferry.js, export: createFerry, length: 2`）。复用仓库根 `node_modules` 的 three r170 与 playwright-core，不占独显，不渲视频，退出时关闭 Chromium 和服务。`--lod` 允许 0.4–0.6，输出受十进制 20 MB 上限检查。

写入仅限 film.json 声明的文件：`examples/raea/media/kun.glb`、`ferry.glb`、`kun-report.json`、`ferry-report.json`，`--preview` 时另有 `kun-preview.png`。重构为通用资产桥后，两件 GLB 的 SHA256 与重构前逐字节一致（`75b00f72…41dd`、`1c627f59…173e`，2026-11-09 macOS 实测）。

## 鲲

- 18,062,776 bytes（18.06 MB / 17.23 MiB），489,858 个三角面，322,699 顶点，20 个网格节点、16 个普通 PBR 材质、6 张内嵌 PNG，无必需扩展及外部依赖。
- 直接调用原版 `createKun({lod:0.5,seed:20261103,wisps:false})`。原版身体、胸鳍、尾鳍、眼珠、眼睑几何保留；3,748 个装饰实例的位置、尺寸和配色保留，仅小装饰单体降面后合并。原版 LOD 0.5 为 1,198,662 三角面。
- 原坐标缩小 20 倍并烘入顶点和动画，不需加载后再缩小。前向 +X，上方 +Y；零时刻包围盒约 **29.614 × 9.208 × 16.933**（X/Y/Z），名义长度 30 米。原点仍在身体中央。
- 身体斑纹、白腹、嘴线、腹褶、眼睛虹膜/瞳孔/高光、眼睑褶线直接用原 GLSL 反照率钩子烘焙；植被和装饰配色烘入线性 `COLOR_0`。灯光和 Toon 阶调由原生运行时决定。

`Swim` 是 10 秒、30 Hz 的真实形变循环：

- **42 个骨骼节点**：1 个共同根骨 + 41 个独立脊柱采样站，身体和尾鳍每顶点双权重蒙皮，装饰按原实例锚点跟随弯曲，10 个 SkinnedMesh。
- 直接重用 `pitchWave('kun', {e0:0.22,sMax:1.15}).js(uniforms).bend`，将原 GPU 的位移和俯仰写成骨骼 TRS。
- 两侧胸鳍使用原轴向和振幅，记录枢轴平移/旋转；附着藤壶一起运动。
- 四个眼睑枢轴使用原 `autoBlink` 和 `setPose` 的姿态，保留 0.125 秒停帧风格，STEP 旋转动画；在 1.625–1.75、6.625–6.75 秒完全闭眼。
- 海草额外有四个解析 morph targets（前后及侧向的正弦/余弦基），由原 `aSway` 公式转换，包含位置与法线。
- 73 个 glTF 通道：34 translation、38 rotation、1 weights。根模型不做整体漂浮运动。
- 为十秒无缝循环：脊柱保持原 5 秒周期；胸鳍从 6 秒改为 5 秒；眨眼从 4 秒改为 5 秒；海草两频率量化为每 10 秒 3/4 周期。所有通道首尾值完全一致。

原生端用模型的 **`Swim`** clip，并开启循环播放。glTF 格式自身没有循环标志。覆盖为 ToonMaterial 时须保留各 primitive 的 **baseColorTexture、COLOR_0 和 doubleSided**；统一纯色覆盖会丢掉体色、眼睛和苔藓。

## 渡船

直接调用 `src/ferry.js:createFerry()`，32 米原船缩为 2 米；**81,560 bytes、1,000 三角面**，包围盒 **2.004 × 0.875 × 0.568**（X/Y/Z）。前向 +X，上方 +Y，原点在水线船中。

红船身、米白船舱、深蓝屋顶和所有窗灯保留，21 个发光网格包括红/绿航行灯、桅顶白灯、船尾灯与17扇窗，转为普通 PBR emissive，HDR 强度用可选标准扩展 `KHR_materials_emissive_strength` 保存。原 `createFerry` 本身没有 PointLight，故没有凭空添加点光源。静态 GLB 不含片外尾迹、倒影或水面。

## 验证与限制

独立二进制结构检查：

```sh
node examples/raea/tools/export-kun-validate.mjs examples/raea/media/kun.glb
node examples/raea/tools/export-kun-validate.mjs examples/raea/media/ferry.glb --static
```

检查文件大小、glTF 2 头部、访问器和索引、有限值、权重和、骨骼引用、内嵌纹理、PBR 材质、动画名/时长/严格递增时间/首尾一致。随后用 **GLTFLoader 回读导出的二进制**，用 AnimationMixer 采样真实网格顶点及眼睑；预览也来自回读文件。

验证结果：尾端 Y 总摆幅 **1.497**，右胸鳍尖 Y 总摆幅 **1.786**，吻端位移 **0**，闭眼旋转 **0.630 rad**，回读首尾误差 **0**。对原 JS 波形的 43,040 个采样，骨骼近似误差最大 **0.00244 米**、RMS **0.000673 米**。详细数据和源文件 SHA256 见 `kun-report.json`。

导出工具执行 three 的 GLB 回读和结构验证。导出资产随后已在 5090 与 macOS 上原生渲染，见 [实测记录](../../docs/raea/experiment.md)。原 Toon 光照、屏幕描边、墨线抖动和鳍尖云丝不属于 GLB；眼睛保留中立视线下的烘焙高光，不含程序化视线追踪。装饰降面、骨骼插值、8 位线性顶点色与皮肤权重有轻微近似。预览中的普通 PBR 灯光不是最终原生 Toon 灯光。
