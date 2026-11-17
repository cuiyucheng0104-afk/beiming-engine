# 离屏出片 M4 实施计划：复杂角色与场景能力补齐、D12 正式登记

> 前置：M3 已完成（分支 `zz8011/offscreen-m3`，PR #23，A 路线模版双实现验收片《晨渡》离屏终渲与三道闸已认可，出片链支持 `--renderer offscreen` 与 `--encoder nvenc`）。本计划在 `zz8011/offscreen-m4` 上推进并已完成。
> 目标：把 M2/M3 显式留给 M4 的能力缺口补齐——屏幕空间空气透视雾、实例化与蒙皮 ID 描边、TSL 卡通材质进阶（实例化、`aRest` 静止坐标、法线/顶点钩子、半透明、敦煌壁画风化表面层 `muralLayer`），完成决定书 D12 的路线注册表登记，并用含复杂鲲鹏角色的场景图桥验证整条 GPU 离屏链路。

## 任务拆分

### T1 屏幕空间空气透视雾与墨线雾淡出（`tsl/fog.js`、`tsl/ink.js`、`tsl/look.js`）
> **已完成**（2026-11-18）：`engine/offscreen/tsl/fog.js` 逐式对应 `engine/look/fog.js`，串入 `ink.js`（`fogFade`）与 `look.js`；透视/正交/高度衰减/天空/`cutoff` 三组对 WebGL 版对拍 PSNR 60.53–60.66 dB、最大差 1 级，变异全拦下。

### T2 ID 通道补全：实例化、蒙皮、变形目标、贴图镂空与顶点位移（`tsl/idpass.js`）
> **已完成**（2026-11-18）：`InstancedMesh` 逐实例连续 ID / `outlinePerInstance: false` 共享 ID、`SkinnedMesh`、变形目标、贴图 alpha 镂空，以及继承材质 `positionNode` / `toonPosInit` 或 `outlineVertex.tsl` 全部接通并通过测试。

### T3 TSL 卡通材质进阶与壁画风化层（`tsl/toon.js`、`tsl/surface.js`）
> **已完成**（2026-11-18）：`tsl/surface.js` 新增 `muralLayer`（支持 `c.muralP` / `c.muralK`）；`tsl/toon.js` 支持 `InstancedMesh`（含实例色与逐实例噪声偏移）、`rest: true`（`aRest`）、`vertexBegin` / `vertexNormal` / `fragmentNormal` 钩子与 `translucent` 半透明。对 WebGL 版对拍 PSNR 74.38 dB、最大差 1 级，五项变异全拦下。

### T4 决定书 D12 路线注册表与契约登记
> **已完成**（2026-11-18）：`routes/routes.json` 新增 `renderers.offscreen`（不含「原生」字样），A、C 路线的 `backends` 加 `webgpu`、`renderer` 加 `offscreen`；同步 `engine/production/routes.js`、`film.schema.json`、`docs/routes/contracts.md`；`film.json` 写 `"backend": "webgpu"` 时 `film build|animatic` 默认走 `offscreen`（并在开运行目录前校验 `offscreen.mjs`）。

### T5 复杂角色场景图桥与鲲鹏离屏验证（`bridge.mjs`）
> **已完成**（2026-11-18）：`engine/offscreen/bridge.mjs` 的 `geometry` 保留 `InstancedBufferAttribute`，新增 `mirrorObject(THREE, root170, { mapMaterial })`，不改动只读目录 `src/` 即可镜像 `src/kun_peng.js` 的完整角色树（多层实例化羽毛、CPU 顶点形变、实例矩阵、`matrixAutoUpdate = false` 眼丘），每帧 `setPose` + `sync()` 在 Dawn + `createLook` 下跑通（`tests/offscreen/bridge.test.mjs`）。
