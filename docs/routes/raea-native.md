# 北冥原生路线：从独立工程到可验收影片

> 读者：直接用原生运行时做片的人｜状态：实施手册（文中命令与新工程在编写时都没有运行）｜依据：北冥 `21ed1b1`，RAEA 源码 `fb3f708`，运行包 `0.1.0-canary.2`

> **先读 [B 路线手册](../../routes/b-native/README.md)。** 2026-11-10 起，北冥原生 · BNE（基于上游运行时 RAEA，FSL-1.1-ALv2）的操作入口只有那一份：新建作品、准备素材、草图帧、出片、交付规格（母版逐位复制 + BT.709 网页版 + run.json + 运行时自带成片检查）、画面工艺与 FSL 使用边界都在那里。本页保留为**原生运行时模块与接口的深入资料**；与新入口冲突时以手册为准。下表是本页旧内容到新实现的对应：
>
> | 本页旧内容 | 现在 |
> |---|---|
> | §3 建议新建的 `examples/raea-starter/`、`settings.mjs` | `node tools/new-film.mjs b <名字>`（模版 `routes/b-native/template/`），设置在 `film.json` 与 `layout.js` |
> | §4 `raea:prepare / raea:check / raea:render` 与 `delivery/` | `node engine/native/prepare.mjs <作品>`、`node engine/render/native.mjs <作品> [--check-only \| --at …]`，产物在 `<作品>/out/<run-id>/`；`npm run raea:*` 只是例片的别名 |
> | §5「只改 Composition 不能复用包装」的写死常量 | 已去掉：帧数、尺寸、帧率、交付档位、素材清单都从 `film.json` 读；`tests/native/contract.test.mjs` 与 `layout.test.mjs` 核对 |
> | §7 手册步骤 R01（起步工程）、R02（项目运行包装） | 由 `engine/native/` 与 `engine/render/native.mjs` 取代；其余步骤（分层夹具、角色等）仍是待办，编号只在本页有效，与代码审查问题单的 R01–R14 无关 |

本路线直接用 RAEA 的 TSX、原生页面与三维组件组织作品，适合独立画风的二维、三维、程序化画面和角色实验。先读 [路线入口](../../ROUTES.md) 与 [仓库规范](../../AGENTS.md)。原生工程可以立即编写 TSX；[契约页](contracts.md)中的 `ProjectSpec / FrameState / BackendAdapter` 是接口设计，尚未接入运行时，不是本路线的前置 SDK。

本文以北冥仓库 `21ed1b10164a94a4fc0d7cf3973934d0f21f301f` 中的示例为基线，核对 RAEA 源码提交 `fb3f70844e03cc40185e3a06c394060d26c5cd38`，运行包固定 `0.1.0-canary.2`。源码快照与发行包版本分别记录，不能因接口在快照中存在，就断言发行包的每项功能均已验证。本文不包含 RAEA 内核或 SDK 副本。

## 1. 先分清证据和本次产物

| 标记 | 含义 | 本路线的证据 |
|---|---|---|
| 已实现 | 找到真实导出、参数检查和执行代码；不代表本项目已运行 | 下文固定提交源码链接 |
| 已实测 | 已有平台、版本与产物记录；只覆盖记录中的场景 | [原实验](../raea/experiment.md)、[5090 检查记录](../raea/experiment-qa.json)、[macOS 入库复现](../raea/publication-validation.json) |
| 建议／待验证 | 本文提出的工程组织、短例和任务；尚未有运行证据 | 新工程模板、四类演示、R01–R08 |

已有 10 秒实验验证了模型资产桥、`Swim` 动画、绘画面片、Toon、水面／尾迹 WESL 和场景后期；输出为 1920×1040、24fps、240 帧及 AAC。5090 的 Vulkan 原实验与 macOS 的入库复现是两次记录，不能混成新的 Windows 包装脚本验证。人物接触、完整三维城市、原版 ID 墨线／Kuwahara 等价仍未验证。macOS 复现还留有部分云片截断边缘的美术问题。

**本次只编写文档、核对源码和链接，没有执行资产准备、GPU 渲染或全部 SDK 测试。** 下文命令是后续实施步骤，不是本次运行日志。

## 2. 输入清单与真实模块选择

开工输入应包含：作品说明与参考图、输出宽高／fps／整数总帧数、镜头帧区间、资产及 SHA256、模型单位／轴向／clip 名、字体文件、声音时码、目标平台和验收事件。参照 [原生项目模板](templates/project-raea.json)、[资产模板](templates/asset.json) 和 [结果模板](templates/render-result.json)记录；空值必须靠实际检查补齐，不能预填成功。

| 模块与入口 | 实际职责、约束 | 能力状态与采用范围 |
|---|---|---|
| `Composition / registerRoot`，`raea` | 注册入口与 `width / height / fps / durationInFrames`；尺寸和帧数必须是正整数；ID 用字母、数字、连字符。[注册器][注册器] | 已实现；已有例片实测。项目 JSON 不会自动改写 Composition |
| `AbsoluteFill / Sequence / useCurrentFrame / useVideoConfig`，`raea` | 页面分层、镜头时间窗、局部帧和画幅。Sequence 使用半开区间。[时间线][时间线]、[时钟][时钟] | 页面叠层和帧驱动已有实测；本文 Sequence 拆镜模板待验证。原生页面不是完整浏览器兼容承诺 |
| `Canvas3D`，`raea/3d`；`Camera3d`，`raea/camera` | 组织旧式场景入口；`layered` 将三维纹理放进页面树顺序，先写的页面在下面，后写的定位元素在上面。源码把 Canvas3D 标为可由 Camera3d 视图取代的旧入口，但仍导出。[Canvas3D][画布] | 已实现；例片的 `Canvas3D layered` 已实测。新工程可先沿用这条已跑通路径 |
| `Model`，`raea/3d` | 加载 GLB/glTF；整体变换、单 clip、加权混合、图、morph、骨骼挂接、按材质名覆盖。[接口与检查][模型]；运行时由 `sync_models / sync_morphs / sync_bones` 更新。[动画执行][动画执行]、[骨骼同步][骨骼同步] | 单 clip、蒙皮／morph 资产桥和 Toon 覆盖已有实测；混合图、挂接、自定义 bones 待本工程验证 |
| `ImagePlane`，`raea/3d` | 世界空间的无光照图片卡；宽度为场景单位，高度默认随图比例；`grid / frame` 选精灵图单元；`shadow` 默认 true。[图片组件][图片]、[图片参数][图片参数] | 静态透明底板已有实测；精灵图待验证。它仍是平面，不会生成背面几何或真实体积 |
| `Mesh3d` 与几何体，`raea/mesh`；`StandardMaterial / ToonMaterial`，`raea/pbr` | 原生几何、标准材质或分阶光照。没有要求本路线必须使用 Toon 的规则 | 现有例片使用原生几何与 Toon；新画风应从自己的材质目标选择 |
| `ToonMaterial / ToonExtension / MeshToonMaterial` | Toon 的真实接口，不存在应当照抄的通用 `<Toon>` 组件。分阶、阴影色、轮廓光、高光和反向外壳描边；`ToonMaterial` 用 `base_color / shadow_color`，旧 `MeshToonMaterial` 用 `color / shadowColor`。[Toon 包装][卡通接口]、[外壳执行][卡通执行] | 已实现；分阶与模型外壳已有实测。不是北冥 ID 屏幕墨线，也不自带 Kuwahara；Toon 不接 roughness／metal 参数 |
| `ShaderMesh`，`raea/3d` | 几何体配自定义 WESL／WGSL 材质；`wesl / wgsl` 二选一；最多 16 个 uniform、4 个普通纹理槽，另有纹理数组。`fn shade(in: VertexOutput)` 为快捷入口。[组件][着色网格]、[材质构建][着色执行] | 水面／尾迹已有实测。适合程序纹理、溶解、全息；不自动继承 PBR 光照，也不自动转换 Three GLSL |
| `FramePass`，`raea/3d` 或 `raea/post_process` | 场景相机全屏后期，按声明顺序执行；默认 `after-tonemap`，可用 `before-tonemap`；读 `frame(uv)`，启用 prepass 后可读深度／法线并关闭该相机多重采样。[接口][帧后期]、[执行][帧后期执行] | 轻颗粒／暗角已有实测；深度／法线短例待验证。它处理场景相机画面，不保证覆盖之后合成的页面标题 |
| `Character`，`raea/character` | 姿态与世界空间的手／脚／视线／座位目标；先 `goalsToBody → solve → pose`，再把关节变成命名 Model，通过 `Model.bones` 驱动皮肤。[角色实现][角色] | 已实现且有[上游一致性测试源码][角色测试]；本仓库没有真人物影片实测。需要配套 Skeleton、body.glb、joint.glb，默认描边还需 body.hull.glb；不是任意 GLB 的自动绑定器 |

### 按演示目标挑最小模块

| 演示 | 具体输入 | 组合与步骤 | 可见输出与验收 |
|---|---|---|---|
| 二维排版／信息动画 | 一张图片、一款明确字体、两句文案，6 秒 | `AbsoluteFill + img + Sequence`；逐帧求位置／透明度；先不放 Canvas3D | 文字按时出现，无缺字、越界、替代字体；逐帧可定位入场、停留和退场 |
| 二维／三维混合 | 透明 PNG、相机移动范围、一个 GLB | 页面背景 → `Canvas3D layered` 中 `ImagePlane + Model` → 页面字幕；检查卡片宽高与阴影参与 | 前后层真实视差；近／远机位均不露图片矩形边；字幕在目标层级 |
| 独立三维产品／空间 | 具有明确尺寸的 GLB、材质清单、单个灯光方案 | `Camera3d + Model + StandardMaterial + DirectionalLight + Shadows`；先灰模、后材质、最后后期 | 模型比例、遮挡、地面接触、阴影正确；材质转动时符合该项目参考，不沿用北冥参数作为默认 |
| 程序化画面 | 几何尺度、颜色、确定性种子、时间函数 | `Mesh3d` 几何或 `ShaderMesh`；先固定 shader，后用 `globals.time` 驱动；需要屏幕变换才加 FramePass | 同帧重放结果在约定容差内一致，动画持续变化，无编译失败或贴图缺失 |
| 骨骼／人物演示 | 带 clip 的 GLB；或 Character 专用资产、骨架和目标位置 | 单 clip 先用 Model；需要手碰道具／注视再用 Character。先固定姿态，再单目标，最后串动作 | 骨骼局部形变可见；手到达目标、眼头朝向正确、脚不滑；不能用整体平移冒充动作完成 |

## 3. 新建一个非北冥画风工程

以下 `examples/raea-starter/` 是**建议新目录**，本次未创建。例子取独立的蓝灰工业演示：6 秒、1280×720、24fps、144 帧，不导入北冥底板、配色、片名或后期。目录名不影响路线判定。

```text
examples/raea-starter/
  project.json             # 按共用项目模板记录；目前无自动运行时消费
  film.tsx                 # registerRoot 与 Composition
  settings.mjs             # 本工程自有常量，由 TSX 和将来的包装脚本显式 import
  film.board               # 镜头帧区间、可见事件、声音时码
  shots/                   # 按镜头拆组件
  shaders/                 # 自写 WESL 字符串模块
  media/                   # 图片、模型、字体、音频；staticFile 的根
  asset-manifest.json      # 路径、SHA256、轴向、clip 与采样说明
  tools/                   # 后续本工程准备／检查／渲染脚本
  out/                     # 原生输出、manifest、日志、诊断帧
  delivery/                # 成片、技术结果、人工验收记录
```

`project.json` 按共用模板填写 `route: "raea" / backend: "raea"`，把 `entry` 与 `outputDir` 改为本工程的仓库相对路径；更新输出规格与独立 `style.id`。`execution` 是计划，实际设备另写 RenderResult。新目录的生成物忽略规则由所属任务确认，不修改旧示例的文件来借用其忽略路径。

### 3.1 无外部素材的最小 TSX

以下是原创调用短例，接口已核对，**未在本次运行**。`settings.mjs` 是工程代码，不是新增的 RAEA 配置解析器；后续 R02 应检查它与项目记录是否一致。

```js
// settings.mjs
export const output = { width: 1280, height: 720, fps: 24, frameCount: 144 };
```

```tsx
// film.tsx
import { AbsoluteFill, Composition, registerRoot,
  useCurrentFrame, useVideoConfig } from 'raea';
import { Canvas3D } from 'raea/3d';
import { Camera3d } from 'raea/camera';
import { Transform, Quat } from 'raea/transform';
import { Mesh3d, Cuboid } from 'raea/mesh';
import { StandardMaterial } from 'raea/pbr';
import { AmbientLight, DirectionalLight } from 'raea/light';
import { output } from './settings.mjs';

function Piece() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  return <AbsoluteFill style={{ background: '#202b35' }}>
    <Canvas3D layered>
      <Camera3d transform={Transform.fromXyz(3, 2, 5).lookingAt([0, 0, 0])}
        projection={{ Perspective: { fov: Math.PI / 4, near: 0.1, far: 100 } }} />
      <AmbientLight brightness={160} />
      <DirectionalLight illuminance={8000}
        transform={Transform.fromXyz(-3, 5, 4).lookingAt([0, 0, 0])} />
      <Mesh3d name="sample" transform={Transform.fromXyz(0, 0, 0)
        .withRotation(Quat.fromEuler('XYZ', 0, t * 0.35, 0))}>
        <Cuboid half_size={[0.7, 0.7, 0.7]} />
        <StandardMaterial base_color="#7daec2" />
      </Mesh3d>
    </Canvas3D>
  </AbsoluteFill>;
}
registerRoot(() => <Composition id="native-orbit" component={Piece}
  width={output.width} height={output.height} fps={output.fps}
  durationInFrames={output.frameCount} />);
```

调用方式与[现有 film.tsx](../../examples/raea/film.tsx)相同，入口验证在[注册器][注册器]。先取得这个无资产画面的首、中、末帧，再逐项加字体、GLB 和材质；新增一层就保留对应诊断帧。

### 3.2 帧时间必须有三个名字

影片根部 `useCurrentFrame()` 是全局帧；进入 Sequence 后变成该段局部帧。总长 `N` 对应 `[0, N)`，最后有效帧是 `N - 1`，不是 N。不要用 `Date.now()`、墙钟或未播种随机推进镜头。[时钟实现][时钟]、[Sequence 实现][时间线]

```tsx
// 放在 Sequence 子组件内；startFrame、actorClockOrigin 由镜头记录传入。
const localFrame = useCurrentFrame();
const { fps } = useVideoConfig();
const globalFrame = startFrame + localFrame;
const cameraSeconds = globalFrame / fps;
const actorFrame = globalFrame - actorClockOrigin;
const actorSeconds = Math.floor(actorFrame / 3) * 3 / fps;
```

`startFrame` 与 `actorClockOrigin` 是本工程参数，不是 Hook 返回值；这里的 `actorClockOrigin` 应取镜头映射中的当前轨道值（非负整数全局帧号），不是整个映射对象。若动作从影片起点连续播放，`actorClockOrigin = 0`；若需要重启动作，显式指定起始帧。相机通常每帧更新；一拍三只用于角色轨道。Model 未给 `time` 时使用当前局部帧／fps，因此跨 Sequence 的同一角色应显式传入连续的 `actorSeconds`，避免切镜头重播。

本例可分 `[0,72)`、`[72,144)` 两镜；重点检查 71、72、73 帧。未来接入物理、Compute 或运动匹配时，先比较顺序播放、直接跳帧、逆序取帧和重复取同帧；有历史状态的求解不能直接按镜头并行。按[共用采样契约](contracts.md)记录 `absolute / baked / sequential`。

### 3.3 模型、图片与 Toon 的接入短例

假设已经准备 `media/actor.glb`（确有 `Idle` clip）和 `media/card.png`。以下片段放在 Canvas3D 中，`actorSeconds` 来自上面的时钟。先列出资产真实 clip／材质名，再填入字符串；这里的 `Idle` 只是输入约定。

```tsx
import { staticFile } from 'raea';
import { Model, ImagePlane } from 'raea/3d';
import { ToonMaterial } from 'raea/pbr';

function Layers({ actorSeconds }: { actorSeconds: number }) {
  return <>
    <Model name="actor" src={staticFile('actor.glb')}
      animation="Idle" time={actorSeconds} loop={true}>
      <ToonMaterial base_color="#8fb5c4" shadow_color="#354e62"
        steps={3} outline={{ width: 1.2, color: '#17242b' }} />
    </Model>
    <ImagePlane name="card" src={staticFile('card.png')}
      width={3} position={[0, 1.5, -2]} shadow={false} />
  </>;
}
```

Model 的 `animation / animations / graph` 三选一；混合列表最多 4 个 clip，图最多 16 节点，显式 morph 权重最多 8 项。需要按材质覆盖时用真实 glTF 材质名填写 `material`。`ToonMaterial` 的贴图暂不接受 sampler 对象，不要照搬 StandardMaterial 的完整参数。[Model 检查][模型]、[Toon 转换][卡通接口]

### 3.4 自写 shader 与场景后期

下面两段分别声明材质色彩和屏幕操作，没有复制 SDK 实现。加入 Canvas3D 后需要真实 shader 编译与目标平台图像检查，不能以 TSX 能解析代替验收。

```tsx
import { ShaderMesh, FramePass } from 'raea/3d';

function Effects() {
  return <>
    <ShaderMesh name="pulse" shape={{ primitive: 'Sphere', radius: 0.7 }}
      wesl={`fn shade(in: VertexOutput) -> vec4<f32> {
        let k = 0.5 + 0.5 * sin(in.world_position.y * 8.0 + globals.time);
        return vec4<f32>(0.1, 0.25 + 0.5 * k, 0.8, 1.0);
      }`} />
    <FramePass at="after-tonemap"
      wesl={`fn shade(in: FullscreenVertexOutput) -> vec4<f32> {
        let c = frame(in.uv);
        return vec4<f32>(c.rgb * vec3<f32>(0.97, 1.0, 1.0), c.a);
      }`} />
  </>;
}
```

ShaderMesh 的源码在载入时构建材质；本例用 `globals.time` 动画，不假定逐帧改 `uniforms` 对象就能成为已验证的动态轨道。纹理绑定使用 `tex_NAME / samp_NAME`，uniform 读 `u_NAME()`；纯 WGSL 输入也经 WESL 体系编译，不支持旧式 `#import`。详细入口是 [ShaderMesh][着色网格] 和 [`module / build`][着色执行]。深度／法线后期先用[上游双 pass 测试场景][后期测试]作验证参考，不直接叠进成片。

### 3.5 Character 是资产与姿态协议

在已有专用资产目录 `media/characters/demo/` 后，最小接入可写为：

```tsx
import { Character, registerBody, held, type Skeleton } from 'raea/character';
import skeletonData from './media/characters/demo/skeleton.json';

const skeleton = skeletonData as Skeleton;
registerBody(skeleton);
const restWithArm = held(skeleton, { RightArm: [-0.2, -0.6, 0.75] });

<Character name="demo-one" body={skeleton.name} pose={restWithArm}
  position={[0, 0, 0]} yaw={0} outline={false}
  goals={{ look: [0, 1.4, 2], hands: { R: { at: [-0.3, 1.0, 0.4] } } }} />
```

输入骨架必须符合上游 Skeleton 和命名约定，`skeleton.name` 应为此处目录名 `demo`，并确有 `RightArm` 等关节；类型断言不能验证 JSON。至少提供 `skeleton.json / body.glb / joint.glb`，启用 outline 时再提供 `body.hull.glb`。上游生成入口为 [character.py][角色资产]；本文不要求现在生成或下载人物资产。`held` 的向量是角色空间骨骼朝向，不是欧拉角；`goals` 是场景世界坐标。[姿态求解][姿态]、[角色放置和绘制][角色]

Character 必须用自身 `position / yaw / scale` 放置，不能套 Group 来移动全身；同一个骨架的多个实例必须有不同 `name`。先做静止骨架与皮肤对齐，再测视线、右手触点和脚底；保留接触前／接触／释放的帧与误差。需要动作片段时另接姿态采样，不要把 Model 的 `animation` 属性直接贴到 Character 上。上游一致性测试的存在不代表 canary.2 本项目人物实跑通过。

## 4. 现有例片的准备、检查、渲染

完整说明见 [examples/raea/README.md](../../examples/raea/README.md)；以下命令从仓库根运行（2026-11-10 在 macOS 实跑通过，见[实测记录](../raea/experiment.md)末节）。

```sh
npm run setup
python3 -m pip install -r requirements.txt             # 或 PYTHON 指向已装 numpy / scipy / soundfile / numba 的解释器
node engine/native/runtime.mjs fetch --accept-license  # 读过上游许可后获取运行时并校验哈希
export RAEA_BIN="<RAEA安装包绝对目录>/bin/raea"
node engine/native/prepare.mjs examples/raea           # = npm run raea:prepare
node engine/render/native.mjs examples/raea --check-only
node engine/render/native.mjs examples/raea            # 产物在 examples/raea/out/<run-id>/
```

> 下表是重构前包装脚本的职责记录，保留作对照；现行行为（母版逐位复制、网页版 BT.709、运行时自带成片检查、run.json）见 B 路线手册。

`<RAEA安装包绝对目录>` 需替换为实际绝对目录。Windows 使用 PowerShell 设置 `$env:RAEA_BIN` 为完整 exe 路径，按需要设置 `$env:WGPU_BACKEND = 'vulkan'`；工具不在 PATH 时设置 `PYTHON / FFMPEG / FFPROBE`。安装包必须保留 `bin` 与 `share` 相对布局。canary.2 没有 `--version` 命令，包装脚本从实际可执行文件旁的 `../share/raea/VERSION` 读取版本。

| 阶段／文件与函数 | 输入与步骤 | 输出及失败判断 |
|---|---|---|
| 准备：[prepare.mjs](../../examples/raea/tools/prepare.mjs) 的 `run` 与主流程 | 检查 Python numpy/scipy/soundfile 和 FFmpeg；复制 6 张底板；导出鲲／船；生成声音；两遍 loudnorm；计算哈希 | `media/kun.glb / ferry.glb / sound.wav / mix.wav / prepared.json` 与底板。缺依赖、缺底板、响度非有限值立即失败 |
| 资产回读：[export-kun-browser.mjs](../../examples/raea/tools/export-kun-browser.mjs)、[validateGLB](../../examples/raea/tools/export-kun-validate.mjs) | 程序几何转蒙皮／morph，GLTFLoader 回读；检查动画轨道、纹理内嵌及循环 | 导出／回读报告。源码 GLSL 形变不会随 GLB 自动带出；导出完成也要看实际动作 |
| 无渲染预检：[render.mjs](../../examples/raea/tools/render.mjs) 的 `--check-only` 分支 | 核对 canary.2、FFmpeg／ffprobe 可调用、9 个必需输入存在 | 控制台通过或异常；不启动 RAEA、不查 GPU 队列、不检查 shader 编译、字体和素材内容正确性 |
| 渲染前占用检查：同文件的队列检查与 `runOptionalGpu` | 查询 `COMFY_URL` 或本机默认队列；可用时查询 nvidia-smi；队列有任务或利用率超过 10% 则退出 | 不终止其他任务。查询不可用只表示未知；它不是 GPU 锁，也无法排除启动后出现的新负载 |
| 原生渲染：同文件的 `run / requireSuccess` | 以例片目录为 cwd，运行 `render film.tsx --quality master --manifest …` | `out/native-10s.mp4 / render.json / render.stdout.log / render.stderr.log`；非零退出就不继续封装 |
| 封装与校验：同文件的 FFmpeg／ffprobe 分支 | 复制视频轨，混入 `mix.wav` 编 AAC，截到 10 秒；完整解码计数 | `delivery/beiming-raea-10s.mp4 / technical.json`；核对 1920×1040、24/1、240 帧、AAC、时长误差 ≤0.05 秒，再记录 SHA256 |

不要把预检（`native.mjs --check-only`，旧名 `raea:check`）与上游 `raea check` 混为一谈：前者只是本仓库的文件／工具预检；上游的成片检查现在由出片入口自动运行，结果在 `out/<run-id>/check.json`，P0 / P1 问题判失败。技术通过后仍需检查整片、切点、黑场／意外静帧、声音起止和响度。历史实测的视觉与声音证据见[实验记录](../raea/experiment.md)，不能由本次预检推导。

## 5. 为什么不能只改 Composition 就复用包装

| 固定点 | 精确位置 | 新工程必须做的事 |
|---|---|---|
| 例片目录与命令目标 | [package.json](../../package.json) 的 `raea:*`；[prepare.mjs](../../examples/raea/tools/prepare.mjs)、[render.mjs](../../examples/raea/tools/render.mjs) 从脚本位置求 `project` | 根命令仍操作 `examples/raea`；切换 cwd 或复制 film.tsx 不会改变它。新工程使用独立命令或新参数包装 |
| 240 帧／24fps／1920×1040 | [film.tsx](../../examples/raea/film.tsx) 的 `Piece / Composition` | 时间不再写死 `f/24`；所有尺寸、帧数与目标记录一致 |
| 镜头与片名时码 | `Piece` 中 3.5 秒、6 秒切镜，8.1 秒片名，最后段分母 4 | 按新 `film.board` 重排镜头，不让新时长超出旧摄影曲线 |
| 十秒循环与一拍三 | `Piece` 中 `q=floor(f/3)*3/24`、`time={(q+2)%10}` | clip 时长与影片时长独立记录；不是所有角色都一拍三，也不能用 `%10` 截断新动作 |
| GLB 的 10 秒／30Hz 采样 | [export-kun-browser.mjs](../../examples/raea/tools/export-kun-browser.mjs) 中 `DURATION=10, FPS=30`、`Swim`、blinkTimes 及 morph 相位；[validateGLB](../../examples/raea/tools/export-kun-validate.mjs) 断言 clip 为 Swim 且 10 秒 | 该导出器和验证器是鲲专用，不是通用角色工具。更换资产需新导出／检查；30Hz 烘焙、24fps 输出、一拍三是三件事 |
| 音频时长与事件 | [sound.py](../../examples/raea/tools/sound.py) 的 `sr*10`、`(10-t)` 淡出和 3.7／5.9／8.1 秒提示 | 新声音按帧时码制作；修改总样本数同时修改淡出和事件位置 |
| 封装和验收硬编码 | [render.mjs](../../examples/raea/tools/render.mjs) 的 `-t 10`、`native-10s`、输出名和 240 帧断言 | 新包装从本工程设置计算时长／帧数；短片、长片和竖屏都要重新校验，不沿用例片阈值 |
| 画幅相关画面参数 | `PAPER` 的 1920×1040 噪声坐标，背景图 2040×1105、标题位置与字号 | 改分辨率／比例时检查像素尺度、裁切和安全区；自动缩放未实现 |
| 固定资产和字体 | prepare／render 的底板名、kun/ferry/mix 清单，film.tsx 内嵌字体 | 新工程声明自己的资产依赖和字体；不要借北冥准备脚本覆盖独立作品 |

### 新工程的直接运行顺序

独立工程未接入新包装前，可以直接调用外部 RAEA。先完成静态输入检查与共享 GPU 占用确认；下面直接 CLI **不会执行旧包装的占用检查**，单帧 PNG 同样会启动 GPU。

```sh
cd examples/raea-starter
mkdir -p out delivery
"$RAEA_BIN" render film.tsx --frame 0 -o out/frame-000.png
"$RAEA_BIN" render film.tsx --frame 72 -o out/frame-072.png
"$RAEA_BIN" render film.tsx --frame 143 -o out/frame-143.png
"$RAEA_BIN" render film.tsx -o out/native.mp4 --quality master \
  --manifest out/render.json > out/render.stdout.log 2> out/render.stderr.log
```

CLI 的帧输出参数见[导出入口][导出入口]；此处仅演示 6 秒／144 帧工程。每步检查退出码，失败先看日志，不继续封装。示例无声音时不应要求 AAC；若作品声明有声，再提供本工程 `media/mix.wav` 并显式混入。对于上述 6 秒设置：

```sh
ffmpeg -hide_banner -y -i out/native.mp4 -i media/mix.wav \
  -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 320k \
  -t 6 -movflags +faststart delivery/native-orbit.mp4
ffprobe -v error -count_frames \
  -show_entries stream=codec_type,codec_name,width,height,r_frame_rate,nb_read_frames:format=duration,size \
  -of json delivery/native-orbit.mp4
ffmpeg -v error -i delivery/native-orbit.mp4 -f null -
```

6 秒这里是示例值；R02 应从 `frameCount / fps` 计算传给 FFmpeg，并核对视频恰为 144 帧、1280×720、24/1，音轨符合项目声明。宽高、音频、运行包、资产哈希、实际设备／图形后端／编码器均写进结果记录。`WGPU_BACKEND=vulkan` 是请求，不足以证明实际 adapter；Vulkan 不等于 NVENC。canary.2 的历史 Windows 实验使用 OpenH264，软件编码实现见 [io/soft][软件编码]。

## 6. 常见故障：先保留最小复现，再定位

以下按当前源码与历史实验列出诊断方向，建议操作并非均已在本次验证。

| 现象 | 优先诊断与修复步骤 | 定位源码／证据 | 复验要求 |
|---|---|---|---|
| `raea/*` 导入失败、版本检查失败 | 核对外部完整发行包和 RAEA_BIN；读取 package VERSION；不要用 npm 同名包代替。确认入口由 RAEA 执行 | [本仓库 render.mjs](../../examples/raea/tools/render.mjs)、[公开导出][公开导出] | 预检通过，再做无资产 TSX 单帧；预检本身不执行 RAEA |
| GLB／图片找不到 | `staticFile('actor.glb')` 返回媒体根 URL，不是磁盘绝对路径；检查 cwd、大小写、空格／中文路径及 `.gltf` 外部依赖。ShaderMesh 纹理先用项目相对 `media/river.png`，这是例片验证过的写法 | [`staticFile`][素材路径]、[`Model`][模型]、[`await_models`][模型载入]、[历史路径问题](../raea/experiment.md) | 离线重开可加载，资源哈希对应清单；不把默认占位画面当成功 |
| 字体缺字／悄悄替换 | 使用实际字体文件和显式 font-family；检查正文、标点、字重与行宽。例片在 Windows 中文路径失败后用内嵌 TTF；内嵌是该例的处理，不是所有字体唯一方案 | [例片字体与实测](../raea/experiment.md)、[字体注册][字体注册]、[网页字体规则][字体规则] | 目标平台的中文测试句和片名截图与字形基准一致；不能只看文本存在 |
| 透明 PNG 带黑边／雾中出现矩形 | 先关闭 Fog／Bloom／FramePass，放纯色底看 alpha；图片卡的 mip_chain 将直通 alpha 在线性空间预乘，输入不要重复预乘。检查透明区颜色与缩放边缘。例片关闭距离雾并把天空放页面底层；本次没有修复上游 alpha | [历史实测](../raea/experiment.md)、[图片采样与预乘][图片预乘]、[材质 alpha 映射][材质贴图]、[层叠实现][画布] | 深／浅背景、远／近机位和运动全程不露卡边。layered 场景透明不等于 H.264 成片带透明通道 |
| 阴影缺失／轮廓投出错误影子 | 检查光源 `shadow_maps_enabled`、接收面与物体尺度、Shadows 的 distance／firstCascade／mapSize，确认未使用关闭阴影的预览路径。图片卡不需投影时 `shadow={false}` | [灯光执行][灯光]、[阴影配置][相机配置]、[Toon 外壳不投影][卡通执行] | 固定模型与相机，只移动光源；接触阴影正确且外壳不额外投影。不是给后期加深就算阴影修复 |
| Toon 颜色不变／参数报错 | 检查材质名与全局覆盖关系；用 `base_color / shadow_color`；移除 roughness／metal 和 Toon 贴图 sampler 对象。不要把 StandardMaterial 参数全部透传 | [`toon / ToonMaterial`][卡通接口]、[`toon_models`][模型载入] | 单材质与多材质各一帧；模型转动时色阶、轮廓和阴影符合基准 |
| 贴图发糊、闪烁或 wrap 不对 | 在支持处设置 `filter / mipmap / wrap / anisotropy`；nearest 会关闭各向异性。同一纹理以不同 sampler 加载会以后者为准，需分离资产身份或统一策略；ImagePlane 没有公开 sampler 属性 | [`SamplerSpec / samplerSpec`][采样接口]、[`Sampling::over / sync_samplers`][采样执行] | 棋盘纹理近景与倾斜远景对照；确认预期像素边界，而非盲目提高分辨率 |
| WESL 编译失败／效果静止 | 保留 stderr；检查 `VertexOutput` 与 `FullscreenVertexOutput` 是否混用，shade 签名、纹理名、uniform 类型／数量；先单色再加纹理。ShaderMesh 动画先用 globals.time | [ShaderMesh 参数检查][着色网格]、[shader 构建][着色执行]、[FramePass 构建][帧后期执行] | shader 日志无错误；两帧间预期区域变化。普通 CPU 类型检查不能替代 GPU shader 编译 |
| 后期没有影响字幕／开 prepass 后边缘改变 | FramePass 在场景相机内执行，页面叠字在后；需要整页后期应另立合成任务。prepass 会改变多重采样条件，重新检查边缘，不同时调所有后期 | [FramePass 接口][帧后期]、[导出合成][合成执行] | 同帧分离三维、页面和后期的诊断图，确认每层的处理范围 |
| 动画不动／切镜重启／蒙皮爆开 | 查真实 clip 名、time 秒值和局部时钟；对照独立 GLB 回读。Character 查骨架命名、资产目录、唯一实例名、scale、是否错误套 Group | [Model 检查][模型]、[动画执行][动画执行]、[Character][角色] | 局部关节有变化；切点连续；手／脚／视线按事件验收，不只检查包围盒位置 |
| 视频变成 10 秒／没声音／帧数错误 | 检查是否误调根 `raea:render`；查旧 `-t 10`、240 帧断言与新音轨长度。先看原生输出，再看封装，定位在哪一段改变 | [包装脚本](../../examples/raea/tools/render.mjs)、[软件编码][软件编码] | ffprobe 完整计数、FFmpeg 全解码通过；时长、尺寸、fps、音轨均匹配新项目 |

## 7. R01–R08：可分派的本手册实施步骤

**R 编号只定位本手册步骤，不是新的全局任务或状态机。** 跨路线分派、负责人、依赖、写入范围与完成证据统一归入 `docs/routes/work-plan.json` 的 T00…任务；分派时在对应 T 任务中注明本页 R 编号。同一个全局任务可以覆盖多个 R 步骤。下表为待实施建议，不因文档完成而标记实现完成。

路径与全局任务卡保持一致。6 秒 `examples/raea-starter/` 用于 T09 的独立起步验证；后续能力放在各自夹具目录，最后在 T19 的 `examples/raea-sequence/` 集成 30 秒作品。不要让各代理都改起步工程的 `film.tsx`，也不要为每个项目复制一套准备／预检／渲染包装。

| 步骤／全局任务 | 输入 | 写入位置与具体工作 | 产物与验收 | 前置 |
|---|---|---|---|---|
| R01 起步工程／T09 | 6 秒蓝灰视觉目标、24fps／144 帧、固定运行包 | `examples/raea-starter/`；建立本页 settings、TSX、项目记录与两镜时间窗 | 无资产工程首中末及切点帧；输出字段一致。能直接用原生 CLI 完成初次渲染，不等待通用包装 | T00 |
| R02 项目运行包装／T13 | 起步工程、T01 契约、已有 prepare/render 的职责 | `engine/backends/raea/run.mjs`、`tests/backends/raea/`；从项目设置取得入口、帧数与音轨，复用已有检查逻辑 | 缺资源和错版本会失败；6 秒及另一个短规格均不受旧 10 秒常量限制；Windows 执行另留证据 | T09、T01 |
| R03 分层与字体／T10 | 自有字体、透明卡片、相机边界 | `examples/raea-fixtures/layers/`；独立入口、media 与输出，测试层级/Alpha/字体 | 深浅背景诊断帧，无缺字、替代字体和矩形边缘；当前可用原生 CLI 验证，不等待 R02 | T09 |
| R04 GLB 与材质／T11 | 自有模型、单位／轴向／clip、现有资产检查方法 | `examples/raea-fixtures/materials/`；结构回读、StandardMaterial、可选 Toon 与阴影对照。通用资产清单代码归 T02，不在本任务越界重写 | 比例正确、局部 clip 形变可见、贴图与接触阴影可复现 | T10 |
| R05 程序材质与后期／T11 | 基础几何、固定种子、目标效果时码 | 同一 materials 目录，复用 R04 工程；检查 ShaderMesh、纹理绑定、FramePass 插入阶段与 prepass | 首中末和重复帧，无未处理 shader 错误；区分场景后期与页面叠层 | T10；与 R04 同一负责人或串行 |
| R06 人物接触／T12 | T02 资产记录、匹配 Skeleton／GLB、可达手部与视线目标 | `examples/raea-fixtures/character/`；先静态对齐，再单目标、接触、停留、释放，检查跳帧 | 姿态、手部接触、脚底和视线可见；数值与视觉分别验收。没有匹配资产就记录阻塞 | T09、T02 |
| R07 段落集成／T19 | 已通过的分层、人物与运行包装；至少两个事件 | 单一负责人写 `examples/raea-sequence/`；复用夹具组件、续接角色时间并混音 | 30 秒独立原生作品；24fps 时为 720 帧，按项目参数验证，不沿用起步工程 144 帧断言 | T10、T12、T13、T15、T16 |
| R08 交付复核／T19 | R07 成片与实际设备／编码日志 | 在同一作品目录保存 technical、review、抽帧与哈希；共用 QA 工具归 T15，视觉检查规则归 T16 | 全解码计数、音画、关键事件与完整观看通过；未测平台不标通过；证据交回 T19，汇总发布归 T20 | R07 |

并行范围按全局 T 任务分派。R04/R05 共用同一任务目录，不能拆给两个同时写入的代理；R03/R06 的独立夹具可在各自前置满足后推进。代码编写可并行，GPU 运行仍需协调共享设备。RAEA 起步工程不依赖北冥 FrameState，也不要求先完成所有原生能力夹具。

## 8. 完成定义

交付必须同时有入口与资产记录、运行版本与目标设备证据、完整解码计数、音频检查（若声明有声）、关键事件帧和整片人工验收。接口在源码存在、预检通过、生成了 MP4、或文档任务结束，任何一项都不能单独替代作品验收。

本文的当前完成范围是原生路线实施手册；R01–R08 仍按全局 T 任务推进，所有新工程和扩展能力的运行结果保持待验证。

[注册器]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/sdk/video/src/registry.tsx#L8
[公开导出]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/sdk/raea/src/index.tsx#L1
[时间线]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/sdk/video/src/timeline.tsx#L107
[时钟]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/sdk/app/src/clock.tsx#L112
[画布]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/sdk/render/src/3d/shapes.tsx#L9
[模型]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/sdk/render/src/3d/model.tsx#L135
[动画执行]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/runtime/scene3d/src/lib.rs#L174
[骨骼同步]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/runtime/scene3d/src/sync.rs#L327
[图片]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/sdk/render/src/3d/effects.tsx#L5
[图片参数]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/sdk/render/src/3d/model.tsx#L330
[卡通接口]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/sdk/render/src/bevy3d/materials.tsx#L326
[卡通执行]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/systems/material/src/toon.rs#L1
[着色网格]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/sdk/render/src/3d/bevy.tsx#L70
[着色执行]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/systems/material/src/shader_material.rs#L151
[帧后期]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/sdk/render/src/3d/materials.tsx#L202
[帧后期执行]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/systems/framepass/src/lib.rs#L59
[后期测试]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/sdk/raea/bench/bevy-ts/cases/frame-pass.tsx#L1
[角色]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/sdk/character/src/character/drawing.tsx#L49
[姿态]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/sdk/character/src/character/skeleton.ts#L97
[角色测试]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/sdk/raea/conformance/character.test.ts#L1
[角色资产]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/sdk/raea/tools/anny/character.py#L1
[素材路径]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/sdk/video/src/media.tsx#L210
[模型载入]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/runtime/scene3d/src/model.rs#L246
[字体注册]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/systems/fonts/src/lib.rs#L18
[字体规则]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/sdk/ui/src/html/fonts.ts#L1
[材质贴图]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/systems/material/src/maps.rs#L220
[图片预乘]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/systems/material/src/maps.rs#L318
[灯光]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/runtime/scene3d/src/light.rs#L10
[相机配置]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/runtime/scene3d/src/camera.rs#L17
[采样接口]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/sdk/render/src/3d/materials.tsx#L131
[采样执行]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/systems/sampler/src/lib.rs#L1
[导出入口]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/runtime/export/src/lib.rs#L17
[合成执行]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/runtime/export/src/bevy_frame.rs#L156
[软件编码]: https://github.com/shinyobjectz/raea/blob/fb3f70844e03cc40185e3a06c394060d26c5cd38/io/soft/src/h264.rs#L1
