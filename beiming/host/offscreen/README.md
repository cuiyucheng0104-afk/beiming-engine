# host/offscreen/：three 离屏实验宿主（Node + Dawn WebGPU）

给 `three` 帧源做 `host: 'any'` 双宿主像素对拍的 Node + Dawn（`webgpu` + `three-webgpu`）实验宿主，**严格隔离于主线验收成片与基准考题之外**（默认 `caps().hosts` 仍固定为 `['page']`）。

| 文件 | 管什么 |
|---|---|
| `host.mjs` | `openOffscreenHost(opts)`（别名 `startOffscreenSource`）：装载并离屏渲染 `host: 'any'`（或实验模式下 `offscreen`）镜头；`probeOffscreenGpu()`：探测 Dawn WebGPU 适配器；`compareHostFrames(pageRgba, offscreenRgba, opts)`：双宿主像素对拍（默认门槛 PSNR ≥ 50 dB 且单通道差 > 5/255 的像素占比 ≤ 0.1%）；`linearRgbaToUint8(data)`：线性浮点 RGBA 转 8 位 RGBA |

## 隔离与对拍规则

- 正式写片与签锁边界（零改动冻结契约）：主线正式 `film.json` / `film.lock` 全链路（`applyFilmWrite` → `L1` → `lock-gen` → 冻结 `LK4` 与 `source/registry.json`）只收具体宿主 `'page'`，一致拒绝 `'any'` 与 `'offscreen'`，从源头杜绝离屏实验宿主混入主线正式锁。
- `host: 'any'` 仅作为 three 帧源与双宿主实验对拍入口（`resolveThreeHost`、`openOffscreenHost`、`page` 宿主对拍）的宿主选择器工作：主线验收（`mainline: true`）、基准考题（`exam: true` 或由 `shotInput` 非枚举 Symbol `SHOT_INPUT_EXAM` 携带的考题片，保持冻结 `shot-input.schema.json` 零额外可枚举键）或默认未显式开启 `allowExperimental: true` 时，`resolveThreeHost` 将 `host: 'any'` 仅解析到 `'page'`，显式 `host: 'offscreen'` 与 `openOffscreenHost` 一律报 `SourceError('contract.unsupported-mode')`。
- 实验对拍模式（`allowExperimental: true` 且非主线、非考题）下，`host: 'any'` 展开为 `['page', 'offscreen']`，由页面宿主（Chromium WebGL2）与本宿主（Node + Dawn WebGPU）对同一镜头逐子帧线性累积渲染后经 `compareHostFrames` 核对（默认门槛 `PSNR ≥ 50 dB` 且单通道差 `> 5/255` 的像素占比 `≤ 0.1%`）。

测试：`node --test beiming/sources/three/s8.test.mjs`。
