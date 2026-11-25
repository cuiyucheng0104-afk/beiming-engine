# Blender 场景查询细则

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
| `belowGround` | `-minY`，只返回严格大于 `tol` 的下陷 | AABB 底面中心 `[cx, minY, cz]` |
| `intersect` | 最大采样穿插深度，只返回严格大于 `tol` 的读数 | 取得该深度的世界坐标 |
| `contact` | 两实体的最小欧氏间隙，相接或相穿时为零 | 最近两点的中点，相交时可为交点 |

Blender 坐标 `(x, y, z)` 换为北冥 `(x, z, -y)`。实体几何包括登记对象、子对象、集合实例和 `entity.` 前缀下的零件。AABB 和成对检查量修改器生效后的网格。没有网格的实体可以查锚点，几何查询略过无可量对象的项。具名锚点沿用 `MetaCollector.add_anchor` 或 `meta(f)` 的 `anchors` 字段，世界坐标直接交回，`blender=True` 时由注册方法换轴。无具名锚点时用 `entity#origin` 交第一个登记对象的原点。纯逻辑装配取其首个登记的子实体对象，连子实体也没有时取世界原点。

穿插用 AABB 粗筛，再用 Blender `BVHTree.overlap` 找相交三角面。用顶点、三角面中心、被交线切分的边和交线围出的区域采样，对封闭网格做内外分类并量到最近表面的距离。完全包含的网格也参与检测。读数是样点中的最大入内深度，会受网格细分与 Blender 浮点精度影响。`1e-8 m` 以内的深度按表面数值噪声处理，两张开放曲面可报接触，它们自身没有可定义的实体内部。`build(ctx)` 可加 `ignore_pairs: [('part.arm', 'part.hinge')]` 豁免指定关节邻接对的穿插检查，接触查询照常量该对。

接触先用 Blender BVH 找零距离候选和最近面，再以三角面 AABB 下界剪枝，用双精度量顶点到面、边到边及边与面的交点。这也覆盖最近点落在两条边内部的情形。封闭实体完全包含时按穿插记零。传了 `tol > 0` 时也照样返回每对实测间隙，`tol` 既不裁掉超差的对也不将容差内的正间隙改成零。调用方用 `value <= max` 判断接触，正间隙可直接用于悬空诊断。

所有查询按 `value` 降序、再按 `a` 和 `b` 的 UTF-8 字节序排序。超过 50 项时保留前 50 项并用 `truncated` 写省略数，正好 50 项或更少时省略该键。坐标和读数必须有限，零统一写成 `0`。

## 资产装载

`startSource({ assets })` 接收资产引用到文件路径的映射，可覆盖自带资产。`.json` 用 `kit-spec/0.1` 搭硬表面几何、材质、灯和环境光（米、右手 Y-up、线性光）。`.glb` 和 `.gltf` 用 glTF 导入器，`.stl` 原样当 Blender Z-up 米，`.blend` 追加物体并跳过相机。每个网格一个零件，名字只留字母、数字、下划线，重名加 `_2`、`_3`。自带 `rtx-card.json`（`asset:rtx-card@1`）是 `film-min` 的 `s01` 用的三件双槽显卡。
