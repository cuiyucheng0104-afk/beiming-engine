# sources/three/ 细则

`README.md` 放不下的两段：快门相位的实测，场景查询。

## 快门相位的实测

`s4.test.mjs`：实渲 `probe-moving-cube` 第 24 帧，180 度 8 个子帧，像素质心和解析位置差 < 0.5 px；用整帧位移（f=24 → 25）标定速度，拖影中点在 f + 0.25 附近，和 Blender START 读数一致。Metal `SUBPIXEL_BITS=4` 下用 0.25 帧短基线标定有约 0.02308 帧量化差。

## 场景查询

会话的 `query(f, q)`（帧源接口契约 3.7）。能力声明列了三种：`bbox3d`、`anchor`、`belowGround`。都在 `(f, sub = 0)` 上求值：渲染器先把这一刻写进场景，宿主再量；`render` 每次自己写状态，查询写的不会留到下一次调用里。坐标都是世界坐标，米，右手、Y 向上。算式在 `beiming/host/page/measure.js` 的 `answerQuery`，判参数在 `plan.mjs` 的 `planQuery`。

| 种类 | 每项的 `a` | `value`（`unit` 都是 `m`） | `at` |
|---|---|---|---|
| `bbox3d` | 实体名 | 包围盒的对角线长度 | `[minX, minY, minZ, maxX, maxY, maxZ]` |
| `anchor` | `实体名#锚点名` | 锚点到世界原点的距离 | 锚点的位置 `[x, y, z]` |
| `belowGround` | 实体名 | 最低顶点陷在地面以下多深（`−minY`） | 最低的那个顶点 `[x, minY, z]` |

- 包围盒和最低点取实体全部网格顶点的世界坐标，和元数据的 `bbox3d` 是同一批顶点；没有几何的实体报错（不带错误码）。
- 锚点就是这一帧元数据里的那一份：镜头的 `meta(f)` 交的，加各张卡交的；只交挂在 `of` 配上的实体上的。它们过的是元数据的同一道检查，所以写法不对、交了两次、落在相机平面上的锚点在查询里同样报错。
- `belowGround`：地面是 `y = 0`，容差 `tol` 没写是 0；只有 `minY < −tol`（严格小于）的实体才出现在结果里。贴着地面的实体会因为单精度顶点带出 1e-9 米量级的负数，要滤掉就给一个小的 `tol`。
- `of` 的每一项是实体名或「前缀.*」（契约 5.5）：`kit.*` 配名字以 `kit.` 开头的全部实体，不含 `kit` 自己；一个都没配上交回空的 `items`，不报错。写了的实体名这个镜头里没有，报 `usage.bad-argument`。配上的实体去重。
- 「最严重」（契约 5.7 没定排法，这里定的）：`value` 大的在前，一样大的按 `a` 的字节序；不管截没截断都这样排。超过 50 项只留前 50 项，`truncated` 写截掉了几项；没超过不出现 `truncated`（F9）。`bbox3d` 里一样大的方块，对角线会差在浮点的末位上，它们之间的先后不要当成按名字排。
- `against` 这三种查询都不用：写了照样判写法（至少一项、实体要有），不参与求值。`tol` 对 `bbox3d`、`anchor` 同样只判不用。

报错的先后：

1. `f` 不是整数、是负数、不小于镜头帧数：`usage.bad-argument`（F23），哪怕查询本身也有问题。
2. 查询不是普通对象，或者 `kind` 不是字符串：`usage.bad-argument`。
3. `kind` 不在能力声明里（`intersect`、`contact`，或者契约里没有的名字）：`contract.unsupported-query`（F8）。错对象的 `next` 是一组字符串，写着替代办法：`intersect`、`contact` 是换一个声明了它的帧源（登记表里 `blender`、`core` 的上限含这两种；现在答不答以那个帧源的 `caps().sceneQuery` 为准，写这一段时 `blender` 还一种都没声明），或者用 `bbox3d` 取两边的包围盒自己判相交（只是近似）；别的名字是只问声明过的三种。
4. 别的写法不对（多了契约外的键、键是取值器或在原型上、`of` 或 `against` 是空的或有一项不合写法、`tol` 是负数、非数、无穷、显式 `null` 或者不是数）：`usage.bad-argument`。契约第 6 节这几种还没定报什么，这里先都报这个码。

测试：`s7.test.mjs`。实渲 `probe-plane-steps`、`probe-axes-turntable`（第 0、12、24 帧，转台转过的角度不同）和一个 62 个实体、其中 60 个陷在地面以下的夹具（探针镜头 `s7-probe.shot.js`）；`planQuery`、`answerQuery` 另有不起浏览器的两条。一致性套件 `beiming/kernel/conformance/run.mjs` 把三种各问一次、问一次 `intersect`、把 `query` 的帧号传出值域一次。
