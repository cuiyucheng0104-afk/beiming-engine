# Blender 场景查询与拼装烘焙

## 拼装烘焙

`bakeAssembly` 是一次性离线作业，与 `startSource`、渲染帧和求值核无关。输入是初始**世界坐标**下的代理三角网格，零件名对应卡应用姿态时的对象。顶点用右手 Y-up；实体表面的三角面要一致朝外，以便区分穿入和贴合。默认单位是米，`units: 'mm'` 将输入网格和配方长度一起换算为米，方向、分位数和角度不缩放。

```js
import { bakeAssembly, loadBakedAssembly } from './bake.mjs';

const meshes = {
  stop: { vertices: [[0, 0, 0], [0, 2, 0], [0, 0, 2]], faces: [[0, 1, 2]] },
  tab: { vertices: [[1, 0, 0], [1, 1, 0], [1, 0, 1]], faces: [[0, 1, 2]] },
};
const recipe = { root: 'stop', steps: [
  { op: 'slide', target: 'tab', onto: 'stop', dir: [-1, 0, 0] },
  { op: 'move', target: 'stop+', delta: [0, 0.02, 0] },
] };
await bakeAssembly({ recipe, meshes, outPath: 'asm.baked.json' });
const { parts } = await loadBakedAssembly('asm.baked.json');
// parts.tab.matrix4x4 的平移列为 [-1, 0.02, 0]，parent 为 'stop'。
```

`engine: 'auto'` 优先用 Blender BVHTree，没有 Blender 时用纯 Python。指定 `'python'` 或 `'blender'` 可强制后端；显式指定的程序启动失败或求解失败直接报错。可传 `pythonBin`、`blenderBin`。`meshes` 也可写在 `recipe.meshes`。省略 `outPath` 直接返回内存对象；传路径时返回同一对象，并在成功后将结果写入该路径。

| `op` | 除 `target` 外的参数 | 几何含义 |
| --- | --- | --- |
| `slide` | `onto, dir, push?, quantile?` | 动件顶点向定件投射，定件顶点反向投射。沿单位方向移动到首个命中，或取命中距离分位数，再加 `push`。 |
| `seat` | `onto, dir, maxExtra?, tol?, step?` | 从首次接触开始继续试探；用最近三角面的有符号法线距离计数穿入顶点。默认试探上限 30 mm、容差 0.35 mm、步长 0.25 mm。 |
| `fit` | `onto, rangeX, rangeY, rangeZ, tol?, touchTol?` | 每轴给 `[起点, 终点, 步长]`，固定轴写 `0`。枚举平移，在安全位置中优先选贴合顶点多者。默认穿入容差 0.35 mm、贴合容差 0.4 mm。 |
| `move` / `attach` | `delta` / `parent` | 前者做世界空间平移；后者只登记从属，不改矩阵。 |
| `rot` | `pivot, axis, angleDeg` | 绕经过 `pivot` 的世界轴按右手定则旋转，角度单位为度。 |
| `mirror` | `ref` | 平移到 `ref` 包围盒中心关于 `recipe.centerX` 的镜像位置，不反转网格绕序；省略对称面报错。 |

`slide`/`seat` 无射线命中、`fit` 没有满足容差的候选位置时会报错，不把原位当成成功解。`fit` 的贴合分数来自代理网格样点，不是连续曲面的接触面积；范围、网格细分和法线朝向都会影响结果。用于薄壁或细榫的代理网格要保留接合面的几何。

选择器可写名字、逗号列表或数组。`name+` 包含自身及当时登记的递归子件，`*` 包含已动件和起始 `root`；普通名字只指该件。碰撞步骤成功后自动登记从属。要整体移动已装子树，显式写 `name+`；只改这一步不会对无关件重复施加变换。

每个步骤推荐写成表中的对象，也可按 `[target, op, ...参数]` 排成数组，参数顺序同表。`asm-baked/0.1` 中的 `parts` 按零件名 UTF-8 字节序写出。每件有 `matrix4x4`（行优先、相对于初始世界姿态的刚体变换，平移在最后一列）、`parent`、`touched`。另有 `steps` 摘要和 `recipeSha256` 配方指纹。变换已在世界空间累计，回放时**不要再乘父件矩阵**。时间、进程与文件路径不参与序列化。

回放时给 `assembly.dsl` 的 `baked` 参数传上述对象或已烘焙 JSON 的文件名；`assetAlias: 'kit'` 将 `tab` 对应到镜头物体 `kit.tab`。`progress` 默认 1；`animate: true` 时按镜头从 0 到 `progress` 对相对旋转和平移做线性进度插值（`u=0`/`u=1` 精确对齐初/终姿态）。卡从创建时的世界姿态计算每一帧，不依赖上一帧，且 `exams` 符合 card-file 题号格式（`cal:assembly.dsl`），可直接通过 `cards-data` 装载。

## 场景查询

按[帧源接口契约 §3.7](../../kernel/contracts/source/CONTRACT.md#37-场景查询-scenequery-和-queryresult)的 `SceneQuery` 和 `QueryResult` 交付。查询帧号必须是 `[0, manifest().frames)` 里的整数。查询在该镜头局部整帧的 `sub = 0` 读取评值依赖图。构建脚本的 `state(f)` 临时应用到对象和插口，退出时还原，渲染仍由 `StateKernel` 写自己的关键帧。`cards-data` 用同一套轨道与卡求值，在查询后重新应用上次渲染的姿态，首次渲染前恢复到起始姿态。

```js
const cuts = await session.query(24, { kind: 'intersect', of: ['part.*'], tol: 0.0003 });
const fit = await session.query(24, { kind: 'contact', of: ['part.peg'], against: ['part.bracket'] });
const touches = fit.items.some(({ value }) => value <= 0.0005);
```

`prefix.*` 匹配 `prefix.` 下的所有名字，同名目标去重并按 UTF-8 字节序展开，通配可以匹配零项。直接点名的实体必须在清单里。`intersect` 和 `contact` 使用 `of × against`，省略 `against` 则枚举 `of` 内两两组合。跳过自身，每个无序对只量一次。显式 `against` 时保留首次匹配的 `a` 来自 `of`、`b` 来自 `against`。其余查询照常校验 `against` 的写法和名字。

| 查询 | `value`（米） | `at`（北冥世界坐标，米） |
| --- | --- | --- |
| `bbox3d` | 评值网格世界 AABB 的对角线 | `[minX, minY, minZ, maxX, maxY, maxZ]` |
| `anchor` | 锚点到世界原点的欧氏距离 | `[x, y, z]`，`a` 写成 `entity#anchorName` |
| `belowGround` | `-minY`，只返回严格大于 `tol` 的下陷 | 评值网格的最低顶点 `[x, minY, z]`（同 `y` 按 `x`、`z` 升序确定性破平，与 `three`/`core` 同口径） |
| `intersect` | 最大采样穿插深度，只返回严格大于 `tol` 的读数 | 取得该深度的世界坐标 |
| `contact` | 两实体的最小欧氏间隙，相接或相穿时为零 | 最近两点的中点，相交时可为交点 |

Blender 坐标 `(x, y, z)` 换为北冥 `(x, z, -y)`。实体几何包括登记对象、子对象、集合实例和 `entity.` 前缀下的零件。AABB 和成对检查量修改器生效后的网格。没有网格的实体可以查锚点，几何查询略过无可量对象的项。具名锚点沿用 `MetaCollector.add_anchor` 或 `meta(f)` 的 `anchors` 字段，世界坐标直接交回，`blender=True` 时由注册方法换轴。无具名锚点时用 `entity#origin` 交第一个登记对象的原点。纯逻辑装配取其首个登记的子实体对象，连子实体也没有时取世界原点。

穿插用 AABB 粗筛，再用 Blender `BVHTree.overlap` 找相交三角面。用顶点、三角面中心、被交线切分的边和交线围出的区域采样，对封闭网格做内外分类并量到最近表面的距离。完全包含的网格也参与检测。读数是样点中的最大入内深度，会受网格细分与 Blender 浮点精度影响。`1e-8 m` 以内的深度按表面数值噪声处理，两张开放曲面可报接触，它们自身没有可定义的实体内部。`build(ctx)` 可加 `ignore_pairs: [('part.arm', 'part.hinge')]` 豁免指定关节邻接对的穿插检查，接触查询照常量该对。

接触先用 Blender BVH 找零距离候选和最近面，再以三角面 AABB 下界剪枝，用双精度量顶点到面、边到边及边与面的交点。这也覆盖最近点落在两条边内部的情形。封闭实体完全包含时按穿插记零。传了 `tol > 0` 时也照样返回每对实测间隙，`tol` 既不裁掉超差的对也不将容差内的正间隙改成零。调用方用 `value <= max` 判断接触，正间隙可直接用于悬空诊断。

所有查询按 `value` 降序、再按 `a` 和 `b` 的 UTF-8 字节序排序。超过 50 项时保留前 50 项并用 `truncated` 写省略数，正好 50 项或更少时省略该键。坐标和读数必须有限，零统一写成 `0`。

## 资产装载

`startSource({ assets })` 接收资产引用到文件路径的映射，可覆盖自带资产。`.json` 用 `kit-spec/0.1` 搭硬表面几何、材质、灯和环境光（米、右手 Y-up、线性光）。`.glb` 和 `.gltf` 用 glTF 导入器，`.stl` 原样当 Blender Z-up 米，`.blend` 追加物体并跳过相机。每个网格一个零件，名字只留字母、数字、下划线，重名加 `_2`、`_3`。自带 `rtx-card.json`（`asset:rtx-card@1`）是 `film-min` 的 `s01` 用的三件双槽显卡。
