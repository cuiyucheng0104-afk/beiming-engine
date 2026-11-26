# sources/core/：核心帧源

照帧源接口契约（`beiming/kernel/contracts/source/`）出帧的路径追踪帧源。渲染器是 [path/](path/README.md) 里的内核 `core-render`；宿主是 node 这一侧的 `source.mjs`：每次 `render` 起一次 `core-render render-pack --passes` 从场景包出层，每帧元数据直接读场景包算。只进看板、不出成片。

| 文件 | 管什么 |
|---|---|
| `caps.mjs` | 能力声明 `caps(version)`，纯数据，默认值都在这里（草稿档 24 个样本、缩放 0.5） |
| `source.mjs` | `startSource({ bin })` → `{ caps, open, stop }`，会话的 `manifest`、`render`、`query`、`close`；`planRender` 是一次 `render` 的计划（纯函数） |
| `probe.mjs` | 一致性探针：把校准场景写成场景包，经帧源接口出层，七项读数交给 `beiming/kernel/conformance/suite.mjs` 的 `evaluateSourceConformance` 判 |
| `source.test.mjs` | 能力声明、成片档与快门角被拒、元数据与层引用过契约、从 Blender 导出的场景包、探针七项 |
| `path/`、`shaders/`、`chassis/` | 内核源码、照 Cycles 移植的着色器、渲染底盘（构建、第 2 级、回归、冻结、场景包写出器） |

## 怎么用

```js
import { startSource } from './beiming/sources/core/source.mjs';
const src = await startSource();            // 渲染程序：bin 参数 → 环境变量 BEIMING_CORE_RENDER → chassis/build.mjs 现编（要 cargo）
const s = await src.open(input, { lock: null, tier: 'draft', workspace, filmDir });
s.manifest();                               // { frames, entities: [{ id, name, class }] }，编号照场景包实例表
const { meta, layers } = await s.render(0, { samples: 64, scale: 1 }, ['meta', 'color', 'depth', 'objectId', 'normal']);
await s.query(0, { kind: 'bbox3d', of: ['kit.*'] });
await s.close(); await src.stop();
```

- 出片链：`beiming/api/pipeline.mjs` 的帧源池按镜头条目的 `source: core` 起这个帧源，渲染程序只用编好的那份（`findRenderer()`：环境变量 `BEIMING_CORE_RENDER`，再没有就取 `chassis/build.mjs` 按这份内核源码编好、放在 `out/chassis/bin/` 下的那份），都没有报 `env.missing-tool`，作业里不现编。只开草稿档（看板用）；终渲档照下面「拒绝的请求」一表在 `open` 时拒，错误码不变。核对：`beiming/api/core-source.test.mjs`（一个场景包经队列里的作业出一帧，和直接调 `core-render render-pack` 出的颜色层、编号层逐字节相同；设 `BEIMING_CHASSIS_E2E=1` 又有编好的程序才跑）。
- 镜头条目：`source: core`、`host: offscreen`、`mode: build-script`，`entry` 是场景包（`scene-pack/0.1`）的目录或它的 `pack.json`，相对片子描述所在的目录。场景包第 f 帧就是镜头局部第 f 帧，包的帧数要不少于镜头的 `out − in`。片子描述里怎么写一个镜头用了场景包，帧源接口契约没定（第 6 节），这是这里的写法。
- 装载之前的判定（宿主、作者模式、锁、卡、资产、叠加层）与 three 帧源共用 `../three/plan.mjs` 的 `planOpen`；卡、资产、叠加层这个帧源都没接，带着来报 `contract.unsupported-input`。
- 层写在 `env.workspace/r<会话内序号>-f<帧号>/` 下，文件名与格式见 [path/README.md](path/README.md)「读场景包」；同目录另有一张 `preview.png`。
- 尺寸是镜头输入的 `output.size` 乘生效的缩放再四舍五入；采样数、缩放的取值次序：这次调用 → 镜头条目的 `tiers` → 能力声明。

## 出了哪些通道，没出哪些

| 通道 | 出没出 | 说明 |
|---|---|---|
| `color` | 出 | R、G、B、A，场景线性，不降噪的样本均值，RGB 已预乘 A |
| `depth`、`objectId`、`normal` | 出 | 取辅助样本（sub = 0、针孔、像素中心，每像素一个），不做平均；`objectId` 的层引用只带 `id`，覆盖率在同目录的 `objectId.coverage.f32`（帧源接口契约 3.3「带覆盖率的 objectId 怎么装进文件」待定，层引用没有放第二个文件的格子） |
| `denoiseAlbedo`、`denoiseNormal` | 出 | 法线照 Cycles 降噪特征的相机空间；反照率照 Cycles 取相机首次命中处漫反射类闭包的反照率之和（不跟反射、不按粗糙度加权；带清漆或透射的材质还是上游口径的底色） |
| `motion` | 不出 | 场景包只有整数帧的状态，快门打开到关上的位置算不出来（场景包契约第 6 节帧间怎么取待定）；能力声明写 `false`。输出通道契约 PS1 对出层方要七个固定通道，这一条现在不满足 |
| `lightgroup:*` | 不出 | 逐盏写灯组要改直接光的夹取，还没做 |

## 拒绝的请求

| 请求 | 错误码 |
|---|---|
| `open` 时 `env.tier` 是 `final` | `contract.unsupported-mode`，信息「核心帧源还没过门：只进看板、不出成片」 |
| 生效的快门角大于 0 | `contract.unsupported-option`：内核没有运动模糊 |
| 快门角 0 配多个子帧 | `contract.shutter-conflict` |
| 要了 `motion`、`lightgroup:<名>` | `contract.unsupported-output` |
| 场景查询 `anchor`、`intersect`、`contact` | `contract.unsupported-query`：场景包里没有锚点，网格之间的穿插与接触没算 |
| 场景包读不对 | 内核报的码（`contract.bad-value` 等），见 path/README.md |

成片档的拒绝与帧源契约的 F25 冲突：F25 不看档位，宿主与作者模式都声明过时 `open` 就该成功；错误码表里 `contract.unsupported-mode` 也只指宿主或作者模式。所以帧源核对记录里只记 draft 档的 `open`，这一条待契约改（给只进看板的帧源留出 `final` 的例外，或者登记专用码）。

## 元数据

- `source.renderer` 是 `core`，`host` 是 `offscreen`，`version` 是内核源码的内容摘要（`chassis/build.mjs` 的 `sourceKey`，编好的程序按它命名）。帧源契约 3.4 的表里 core 的 `version` 写的是锁文件锁定的提交号，两者对不上：带锁文件 `open` 会被拒，待契约定用哪一个。
- 相机：`world` 是场景包相机表的 `mat16`，`proj` 照每帧元数据契约 5.1 从 `fovY`、清单的 `near`、`far` 和输出尺寸算；相机表带景深两列时带 `focusDist`、`fstop`、`sensorHeightM`。
- 实体：这一帧画出来的实体（实例矩阵左上 3×3 行列式不为 0）逐顶点投影，算 `bbox2d`、`bbox3d`、`pxArea`、`depth`（算式与页面宿主共用 `../../host/page/measure.js`，同样不做近裁剪面的裁剪：跨到相机后面的实体 `bbox2d` 不对）。`visible` 写 `null`（场景包里没有角色）。
- `lights`、`stats.noise` 写 `null`，在能力声明的 `metaNull` 里；`texts` 是空数组。
- 镜头种子照实写进 `seed`，也就是内核采样用的种子（起 core-render 时设 `THREERT_SEED`，外层环境里的 `THREERT_SEED`、`THREERT_HWRT` 不传下去）。

## 确定性与一致性探针

```sh
node beiming/sources/core/probe.mjs [--out 报告.json] [--machine 名字]   # 退出码 0 七项都过，4 有一项不过
```

- 七项用的场景、读数名与门限和 three、blender 两个帧源的探针相同，量法写在 `probe.mjs` 文件头。差别：相机约定少了转台摆臂的变换先后（只比 8 个锚点）；转台快门角是 0；用 draft 档；场景包的材质还没有发光闭包，灰阶的色块写成对相机可见的矩形面光。
- 确定性：能力声明写 `hash-same-machine`。依据：苹果 M5 Pro（Metal）与 RTX 5090（Vulkan）两台机器上，转台第 0、12、24、36、48 帧顺序渲、同一会话再渲一遍、另起帧源乱序渲，颜色层与法线层逐字节相同；两份从 Blender 导出的场景包同一帧渲两遍，颜色、深度、编号、覆盖率、法线层逐字节相同（苹果显卡上量的）。跨机器不比。
