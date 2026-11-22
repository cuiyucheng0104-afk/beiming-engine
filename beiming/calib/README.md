# calib/：合成校准场景

带标准答案的小场景。每个场景是一份和渲染器无关的 JSON（`scene.json`，格式 `calib-scene/0.1`）：针孔相机、解析形体（盒子、平面、球、圆柱）、自发光材质（可选受光的标准材质和点光源）、匀速运动，外加一节从规格直接算得出的标准答案 `expected`。没有贴图和模型文件，不引用任何外部素材。字段、单位、算式和每个场景的标准答案见[规格细则](DETAILS.md)。

## 两组场景

**探针场景（7 个，`probe-*`）**：量帧源口径用，各服务探针表的几行。`probe-gray-chart`（线性度、显示变换）、`probe-plane-steps`（深度）、`probe-thin-geometry`（编号层边缘）、`probe-axes-turntable`（坐标与相机）、`probe-moving-cube`（时间键、快门）、`probe-occlusion`（可见比例）、`probe-aux-sample`（辅助层取样）。两个帧源的读数在 [table/](table/README.md)。

**公开校准场景（4 个，带版本号）**：给后期链、灯光材质标定、爆炸拆解和取景考题复用，各带 three 和 Blender 两个帧源的镜头入口。物体名是 `meta/0.1` 认的实体名（`ball.gray`、`head.visor` 这样点分的），两个帧源交回的元数据直接过正式契约。

| 引用 | 里面有什么 | 帧 |
|---|---|---|
| `calib/hdr-post@1` | 六级曝光阶（1/16 到 64）、亮度 8 的三原色、灰白黑、亮度 1000 和 100 的小球、亮度 50 的细条 | 0 |
| `calib/studio-balls@1` | 受光地台上灰、铬、白、黑四个受光球，主灯、辅灯、轮廓灯三个点光源；六块自发光色卡，1 米标尺杆 | 0 |
| `calib/boxes-explode@1` | 八个方块从拼合态沿对角方向匀速散开，后排从前排外侧露出来 | 0 到 24 |
| `calib/mech-head-proxy@1` | 头壳、面罩、下颌、耳轴、天线、传感器拼的机械头代理体，整体每 48 帧转一圈；机位满足考题 28-1 的取景限制（1920 × 824 下四边留白都不少于 15%） | 0 到 48 |

受光的球和地台没有标准答案：读回多少要看渲染器（three 只有直接光，Blender 是路径追踪），自发光的色卡和标尺才有。两个宿主的元数据现在不带灯（`lights` 是 `null`），灯位用 `calibMetaLights(scene)` 取。

## 用法

```js
import { checkScene } from './beiming/calib/check.mjs';
import { PUBLIC_CALIB_SCENES, calibMetaLights, listCalibScenes, materializeCalibWorkspace, resolveCalibScene } from './beiming/calib/index.mjs';

const { id, scene } = resolveCalibScene('calib/hdr-post@1');   // 也认 'hdr-post@1'；结果深冻结
resolveCalibScene('probe-gray-chart', { allowProbes: true });  // 探针场景要显式放行，不然报 RangeError
checkScene(scene, id);                                         // 问题清单，空数组就是通过
listCalibScenes({ includeProbes: true });                      // 4 个公开场景，加 7 个探针场景

// 备好两个帧源的镜头输入；片子描述写到 outDir/film.json，已经有这个文件就报 EEXIST、不覆盖
const { filmDir, threeShotInput, blenderShotInput } = await materializeCalibWorkspace('calib/hdr-post@1', outDir);
const session = await source.open(threeShotInput, { lock: null, tier: 'draft', workspace, filmDir });
const { meta, layers } = await session.render(0, {}, ['color', 'depth', 'objectId']);
```

`source` 是 `beiming/host/page/host.mjs`（three）或 `beiming/sources/blender/host.mjs`（Blender）的 `startSource()` 交回的帧源，Blender 那边换成 `blenderShotInput`。引用不是字符串抛 `TypeError`，场景不存在或名字不合法（带 `..`、斜杠、反斜杠等）抛 `RangeError`。`filmDir` 是场景目录，不是 `outDir`：页面宿主只放行 `beiming/` 下的入口文件。探针场景没有镜头入口，`materializeCalibWorkspace` 不接。`calibMetaLights(scene)` 把规格的灯表换成 `meta/0.1` 的 `lights` 写法。

## 改场景

答案字段不手填：由检查器从规格重算一遍再比，写的和重算的对不上就报「写的是 …，重算是 …」。公开场景的内容定了就不改，要改规格另起 `@2`。

## 自检

```sh
node beiming/calib/check.mjs              # 全部 11 个场景（7 个探针加 4 个公开）：查格式、查单位、查裁剪面、重算 expected 并比对
node --test 'beiming/calib/*.test.mjs'    # 检查器自测；四个公开场景过检查器，并在 three 和 Blender 上实渲
```

只有机器上确实没有浏览器或 Blender 时，实渲的两项才跳过；帧源起来之后出的错都算失败。验收要看跳过数是 0。
