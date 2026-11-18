# `engine/pathtrace/` · 物理路径追踪引擎适配层

本目录提供 **D · 北冥光追 · 物理路径追踪**（`routes/d-pathtrace/`，决定 D13）的运行时定位、场景确定性 SDK、三维晶片 HUD 标准件与打包探针，全部为北冥自有的纯 ESM JavaScript（配套 `.d.ts` 类型声明，兼容任意 Node 22.0+）MIT 代码。底层渲染可执行文件与上游场景库来自开源项目 `ThreeRT`（`meshy-dev/ThreeRT`，MIT），按版本锁存放在本机缓存目录，不入 git 仓库。

## 模块与契约

| 文件 | 作用与核心导出 |
|---|---|
| [runtime.lock.json](runtime.lock.json) | 锁定上游基准提交、构建版本号（`0.1.1-beiming.1`）、各平台相对二进制路径、64 位 `binarySha256` 与 `oidn` 链接布尔标记。 |
| [runtime.mjs](runtime.mjs) | 导出 `LOCK_PATH`、`loadLock()`、`resolvePathtrace()` 与 `probePathtraceGpu()`；命令行提供 `status` 与 `check`（遵循 [docs/CLI.md](../../docs/CLI.md) 信封与退出码 `0/2/3/4`）。依次从 `BEIMING_PT_BIN` 或 `~/.cache/beiming/pathtrace/<version>/bin/threert-render` 解析二进制并核验 `sha256`。 |
| [index.js](index.js) / [index.d.ts](index.d.ts) | 作品 `scene.ts` 的唯一引擎入口：导出 `definePathtraceFilm(factory)` 及 `camera.js`、`hud.js` 的全部工具函数。强制 `evaluation: "absolute"`（纯整数帧函数，禁止跨帧累加状态），在 QuickJS `threert-render serve` 中读取 `state.frame` 与 `state.hideTexts` 求值，在 Node 探针中暴露 `probeFilm({ film, width, height, fps })`。 |
| [camera.js](camera.js) / [camera.d.ts](camera.d.ts) | 导出确定性帧种子 `frameSeed(seed, frame)`、近裁面像素级视锥贴合 `placeInCameraFrustum(mesh, camera, dist, pxBox, screenW, screenH)`（自动钳制局部厚度 `z <= 0.0015` 米）与透视包围盒反算 `projectBoxToPixels(target, camera, screenW, screenH)`。 |
| [hud.js](hud.js) / [hud.d.ts](hud.d.ts) | 导出 `createWaferHudMaterial(texMap, { boost })`、`createLiveAtlasHudMaterial(atlasTex, ...)` 与 `enforceWaferThickness(mesh)`。自动注入 `o.base = vec3<f32>(0.0); o.specular = 0.0;` WGSL 材质代码，彻底消除 PBR 介电菲涅尔高光对暗底 HUD 晶片的冲灰。 |
| [bundle.mjs](bundle.mjs) | 导出 `bundlePathtraceFilm(...)` 与同名 CLI：通过 `esbuild` 插件（兼容 `index.js` 与 `index.ts` 导入；无 `esbuild` 环境自动回退至内置轻量类型擦除打包器）解析缓存 `sdk/` 内的 `@threert/scene` 与 `@threert/gameplay`，产出 `work/scene.bundle.js` 并运行 Node 探针写出 `events.json`、`timeline.json` 与 `work/texts.json`。 |

## 常用命令

```sh
node engine/pathtrace/runtime.mjs status --json
node engine/pathtrace/runtime.mjs check --probe-gpu
node engine/pathtrace/bundle.mjs films/<名字> --json
```
