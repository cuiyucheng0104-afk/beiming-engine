# 离屏出片 M4 实施计划：复杂角色与场景能力补齐、D12 正式登记

> 前置：M3 已完成（分支 `zz8011/offscreen-m3`，PR #23，A 路线模版双实现验收片《晨渡》离屏终渲与三道闸已认可，出片链支持 `--renderer offscreen` 与 `--encoder nvenc`）。本计划在新分支 `zz8011/offscreen-m4` 上推进。
> 目标：把 M2/M3 显式留给 M4 的能力缺口补齐——屏幕空间空气透视雾、实例化与蒙皮 ID 描边、TSL 卡通材质进阶（实例化、`aRest` 静止坐标、法线/顶点钩子、半透明、敦煌壁画风化表面层 `muralLayer`），完成决定书 D12 的路线注册表登记，并用含复杂鲲鹏角色与微面闪羽的作品验证整条 GPU 离屏链路。

## 任务拆分

### T1 屏幕空间空气透视雾与墨线雾淡出（`tsl/fog.js`、`tsl/ink.js`、`tsl/look.js`）
- 新增 `engine/offscreen/tsl/fog.js`：逐式对应 `engine/look/fog.js`（深度重建视空间与世界坐标，指数雾 `density / start / max`、高度衰减 `baseHeight / falloff`、截止距离 `cutoff`、清屏天空雾 `sky`、仰角双色 `color / colorHigh`）。
- `engine/offscreen/tsl/ink.js`：接入 `fog` 与 `fogColor`，边缘强度乘 `1 - fogFade * fogAmount`，与 `engine/look/ink.js` 一致。
- `engine/offscreen/tsl/look.js`：在主场景与 bloom/grade 之间串入雾 pass，透传 `fogColor`（构造项）与每帧 `fog` 参数。
- 测试 `tests/offscreen/fog.test.mjs`：透视相机 + 正交相机、高度衰减 + 天空雾 + 远处截止 + 墨线 `fogFade`，与无头 Chrome WebGL 版对拍过质量门，并做变异检查。

### T2 ID 通道补全：实例化、蒙皮、变形目标、贴图镂空与顶点位移（`tsl/idpass.js`）
- `InstancedMesh`：`outlinePerInstance !== false`（且无 `outlineGroup`）时按 `instanceIndex` 分配连续实例 ID（`baseId + instanceIndex`），`outlinePerInstance === false` 或同组时共用单 ID；实心挡线（`solid`）写 0。
- `SkinnedMesh` 与 `morphTargetInfluences`：放开 `MeshBasicNodeMaterial` 原生骨骼蒙皮与变形目标路径。
- 带贴图的 alpha 镂空（`map` + `alphaTest` / `transparent`）：按 `map.matrix` 变换 UV 采样 alpha 并按阈值（`alphaTest > 0 ? alphaTest : 0.5`）丢弃片元。
- 顶点位移：支持继承原材质的 `positionNode` 或 `userData.outlineVertex.tsl` 节点函数，保证剪影与主渲染对齐。
- 测试 `tests/offscreen/idpass.test.mjs` 追加：逐实例描边 vs 整组描边、骨骼弯曲网格描边、贴图镂空描边，与 GLSL `engine/look/ids.js` 对拍。

### T3 TSL 卡通材质进阶与壁画风化层（`tsl/toon.js`、`tsl/surface.js`）
- `engine/offscreen/tsl/surface.js`：新增 `muralLayer`（逐式对应 `engine/shade/surface.js`：褪色大斑、干笔飞白、剥落块、氧化暗斑、细碎点，高频项按 `fwidth` 自动远景淡出；支持钩子读写 `c.muralP`、`c.muralK`）。
- `engine/offscreen/tsl/toon.js`：
  - 支持 `InstancedMesh`（`bind` 放开实例化并设 `outlinePerInstance: perInstance ?? true`；支持实例色 `instanceColor` 与钩子读取 `c.instanceIndex`）。
  - 支持 `rest: true`（`c.obj` 取顶点属性 `aRest`，供 CPU 形变网格固定纹理/风化坐标）。
  - 扩展 `opts.tsl` 钩子：`vertexBegin` / `vertexNormal`（写入 `positionNode` / `normalLocal`）与 `fragmentNormal(c)`（读写视空间法线 `c.normal` 并可读 `c.viewDir`、`c.lightDir`、`c.shadowAtt`，支撑羽簇微面法线瓣等自定义高光/叠色）。
  - 支持 `translucent: true` / `transparent: true`（半透明混合与钩子可写 `c.alpha`）。
- 测试 `tests/offscreen/toon.test.mjs` 追加：`muralLayer`、`InstancedMesh`（含实例色）、`rest: true` 形变网格、`fragmentNormal` 钩子、`translucent`，与 GLSL 版对拍过质量门。

### T4 决定书 D12 路线注册表与契约登记
- `routes/routes.json`：`renderers` 新增 `offscreen`（不出现「原生」字样，严守 D04/D12）；A、C 路线的 `backends` 加入 `webgpu`、`renderer` 加入 `offscreen`。
- 同步 `engine/production/routes.js`（`BUILTIN_ROUTES`）、`engine/production/` schema 与 `docs/routes/contracts.md`。
- `tools/film/`：作品 `film.json` 声明 `"backend": "webgpu"` 且命令行未显式指定 `--renderer` 时，默认走 `offscreen` 渲染器。
- 跑通 `npm run check:repo` 及 `cli` / `production` / `film` 测试集。

### T5 复杂角色双实现验证（鲲鹏角色 + 实例化羽簇闪光）
- 为 `films/peng-glint/`（或独立双实现入口）补齐离屏运行时与 TSL 着色（复用 `src/kun_peng.js` 造型与羽根波，不改动只读目录 `src/`），验证 CPU 形变体 `aRest` + `muralLayer` + 翼面 `InstancedMesh` 逐羽描边 + `fragmentNormal` 微面碧金瞬闪在 Node + Dawn + NVENC 下端到端出片，并与 WebGL 页面逐帧对拍记录实测数据。
