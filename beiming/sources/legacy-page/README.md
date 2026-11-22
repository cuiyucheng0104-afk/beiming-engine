# 旧页面作品帧源

将旧的页面作品接入帧源接口，按该接口交付帧产物。

通过帧源接口契约接收输入和交付帧产物。旧页面对本组件保持零反向引用。跨组件通过契约交接，引用旧目录须命中白名单（这里只懒加载 `engine/render/page.mjs` 和 `tools/baseline/lib/png.mjs`）。

业务契约：[帧源接口](../../kernel/contracts/source/CONTRACT.md)（能力声明与合规档）、[每帧元数据](../../kernel/contracts/meta/CONTRACT.md)（本帧源可减免的字段）。

通用约定见[契约目录](../../kernel/contracts/)、[契约写法约定](../../kernel/contracts/CONVENTIONS.md)和[目录归属契约](../../kernel/contracts/ownership/CONTRACT.md)。

## 能力

| 项 | 取值 |
| --- | --- |
| 合规档 | `limited`（F10） |
| 宿主 / 作者模式 | `page` / `native-code`，入口必须是 `index.html` |
| 锁定版本 | 帧源 1.0.0 = 页面约定 v1；three 0.170.0 |
| 输出 | `color`（f32 线性，Rec.709 原色，显示参考）+ `meta`；深度、编号、法线、运动都没有 |
| 场景查询 | `sceneQuery: []`，`query` 一律报 `contract.unsupported-query` |
| 档位 | 草稿缩放 0.5、终渲 1；每像素 1 个样本 |

## 用法

```js
import * as legacyPage from './index.mjs';
const s = await legacyPage.open(shotInput, { lock, tier: 'final', workspace, filmDir });
s.manifest();                              // { frames, entities: [] }
await s.render(f, {}, ['color', 'meta']);  // { meta, layers: { color } }；只要 ['meta'] 时不出像素
await s.close();
```

- 颜色层：页面截出的 8 位 sRGB 按 IEC 61966-2-1 分段传递函数解码成线性 f32，透明度恒为 1；快门子帧在线性空间平均。
- 元数据：`camera`、`entities` 为 null，`lights` 为空，`texts` 来自 `window.TEXTS(t)`（`box: [x, y, w, h]` 换成 `bbox2d: [x0, y0, x1, y1]`，透明度为 0 或空文字的不算）。只取一个子帧时附 `ext["legacy-page.pixelSha256"]`，和 P9 金标清单同口径。
- 卡、叠加层、资产、`colorRef: scene` 都装不进旧页面，`open` 时报 `contract.unsupported-input`（没锁时先报 `env.lock-required`）。
- 测试和别的宿主可以注入 `open(input, env, { driver })`，接口见 `host.mjs` 文件头。

## 已发布作品的锁与基线

`locks/<作品>.lock.json` 是 `beiming-10s`、`chendu`、`du` 的本机锁（`lock/1.0`），按 `film-upgrade` 升级后的片子描述生成，过 `lock-check/0.1`：种子照锁文件契约 5.7 派生，卡的版本和摘要取自 `beiming/cards` 里的真卡。镜头标识按契约改成小写（`A` → `a`、`S1` → `s1`）。

- `loadLegacyLock(workId)`：读锁。
- `getBaselineHashes(workId)`：P9 金标（`tests/golden/darwin-metal/manifest.json` 的 `beiming-core`、`beiming-detail`，不含带调试参数的帧）里的像素哈希表。
- `verifyBaselineHashes(workId, renderedHashes)`：先核锁的帧源版本与基线出片环境（three 0.170.0），再逐帧比对，返回 `{ ok, mismatched, missing }`。晨渡、渡还没进金标，返回 `reason: 'no-baseline'`。

单测：`node --test beiming/sources/legacy-page/legacy-page.test.mjs`。
