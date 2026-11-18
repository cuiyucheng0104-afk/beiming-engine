# sources/three/：three 帧源

照帧源接口契约出帧的 WebGL 帧源，渲染库是 0.187.0 的 three。只有 `source.js` 碰渲染器。

| 文件 | 在哪跑 | 管什么 |
|---|---|---|
| `caps.mjs` | 页面、node | 能力声明 `caps()` |
| `plan.mjs` | 页面、node | 一次 `render` 的计划：要的输出交不交得出、生效的快门、子帧相位、输出尺寸；交不出就报带错误码的错 |
| `source.js` | 页面 | `createThreeSource({ THREE, host })`，交回 `{ caps, open }`；会话有 `manifest`、`render`、`query`、`close` |

怎么出一帧：

- 颜色层：每个子帧采样渲到半精度的浮点目标，读回后在线性光里逐像素取算术平均。不过显示变换，不截到 `[0, 1]`。
- 辅助层：取 `sub = 0`、针孔、像素中心的一个样本，不抗锯齿。`depth` 是平面深度（米），`objectId` 是叶子实体的编号，`normal` 是相机空间的法线。背景的编号是 0，深度和法线写 0。
- 清屏：每一遍（颜色、辅助层）自己把清屏值定成 `(0, 0, 0, 0)`，渲完还原，不留给下一次。镜头设了背景色时颜色层的背景是背景色、透明度 1；没设时是 `(0, 0, 0, 0)`。
- 辅助材质只画网格。场景里有看得见的点、线、精灵时，要辅助层就报 `contract.unsupported-output`，不照画。不在 `entities` 里的网格照画：编号是 0，深度是它自己的。
- 元数据：每次成功的 `render` 都交一份，由宿主量。

现在的边界（能力声明里照实写了）：

- `motion` 交不出；场景查询一种都不答；作者模式只有 `native-code`；每像素只取 1 个样本。
- 实体的编号按实体名的字典序从 1 起；类别从母语对象的形态推：点云是 `particles`，名下还有别的实体的是 `assembly`，其余是 `part`。

宿主在建帧源时交进来四个服务：`load`（装载镜头）、`apply`（把一个时刻的状态写进场景）、`measure`（量元数据）、`now`（单调时钟）。

测试：`node --test 'beiming/sources/three/*.test.mjs'`。`source.test.mjs` 不起浏览器；`render.test.mjs` 起两次无头、静音的浏览器实渲，查清屏值不跨 render 残留。
