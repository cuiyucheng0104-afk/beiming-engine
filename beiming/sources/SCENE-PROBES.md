# 场景探针

Three 和 Blender 的 `caps().ext["scene.probes"]` 列出各自支持的探针。会话在镜头局部整帧的快门起点量测。

```js
const request = { kind: 'probe.ground', of: ['hand.*'], tol: 0.001 };
const result = await session.query(24, request);
```

把同样的请求列表写进镜头的 `params.sceneProbes`，每次 `render` 就按列表顺序把各项读数写进 `meta.ext["scene.probes"]`。只请求元数据时也会量测。列表最多 16 项。`of` 支持实体名和 `前缀.*`，省略时取已登记实体。各探针最多交回 50 项明细，省略的数量记为 `truncated`。相机探针按本次输出画幅量测。直接 `query` 时用镜头的基准画幅。这里的 `query` 是帧源会话方法。HTTP 的 `/observe/query` 继续查询已保存的元数据。

| kind | 帧源 | 读数 |
| --- | --- | --- |
| `probe.ground` | Three、Blender | 世界坐标 Y=0 以下的最大穿地深度和对应顶点。只报告深于 `tol` 的实体，默认容差 0 米。 |
| `probe.contact` | Blender | S12 接触距离。可给 `against` 选择另一组配对实体，`tol` 是最小报告间隙。穿插深度仍可用 S12 的 `intersect` 查询单独量。 |
| `probe.section` | Blender | 求值网格与指定平面的交线，`axis` 默认 `y`，`offset` 默认 0 米。每项有所属实体 `a` 和一对三维端点 `ends`。面与平面共面时跳过该面。 |
| `probe.deform` | Three、Blender | 当前网格和静止帧 `rest`（默认 0）对应顶点的最大位移，单位米。先分别消去实体根节点的平移和转动，保留缩放、蒙皮和子零件的局部位移。无法识别唯一根节点或拓扑发生变化时交 `unavailable`。 |
| `probe.footslide` | Three | 脚的最低顶点在前后两帧均距地面不超过 `tol`（默认 0.005 米）时，量实体原点在 XZ 平面的位移。单位米/帧，未满足两帧着地条件时 `value` 为 `null`。 |
| `probe.joint-vel` | Three、Blender | 相邻整帧间最短旋转角，单位弧度/帧。按最近 `window` 个间隔（默认 24，最多 120）数连续零速区段。速度小于等于 `tol`（默认 1e-6 弧度/帧）视为零速。可用 `against` 指定主关节，两者各取这段内最早的速度峰值并报告有符号帧差。默认量实体局部旋转，可用 `bone` 和 `againstBone` 指定骨骼。 |
| `probe.near-clip` | Three、Blender | 判断相机前方 `distance`（默认 1 米）的取景锥内有没有网格，并交回最浅的相机轴向深度。会查到位于实际近裁剪面之前的网格。 |
| `probe.tri-budget` | Three、Blender | 统计与取景锥有非零投影面积交集的原始三角面，含实例和部分出画面。省略 `of` 时包括场景里的未登记网格。可给 `limit`，并读 `over`。统计包含互相遮挡的三角面。 |

查询走几何求值，不分配额外像素层。Three 探针读 CPU 上可求值的网格，Blender 探针读依赖图里的求值网格与实例。着色器位移、Cycles 自适应细分、材质透明像素等只在渲染时发生的变化超出几何探针的量测范围。

```sh
node --test beiming/sources/o11.test.mjs beiming/sources/three/s7.test.mjs beiming/sources/blender/s12.test.mjs
```

校准场景植入 0.0019 米穿地、0.139 米形变、0.025 米/帧滑步、2 帧滞后、1 米镜头边界，以及已知的三角面数和剖面交线。现场资产额外核对了 024 僵尸手工程的评值网格。Blender 5.2.0 逐帧检查原工程 1–600 帧，`ZH_Hand` 的最低点出现在第 379 帧，实测下陷 0.00190464046，四舍五入为原记录的 0.0019。同一帧导入 Blender 帧源后，`query` 和渲染返回的每帧元数据读数相同。

其余数值的校准证据来自可执行夹具。Robot Pop 的位移定义和绑定工程未公开，03C 的截面脚本所需装配矩阵和网格缓存缺失，22-1 的 12,121,208 面来自原视频视口读数。05-3 的 1 米规则和 VOWLORN 的 0.025 米/帧上限以已知阈值校准。13-2 和 024-1 的原始关节滞后读数有待选定对应关节和帧段后复核。
