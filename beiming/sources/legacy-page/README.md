# 旧页面作品帧源

将旧的页面作品接入帧源接口，按该接口交付帧产物。

按帧源接口契约接收输入和交付帧产物。浏览器兼容实现位于 `browser/`，调用时加载。旧页面仍可通过原入口运行。

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
- 时刻：`render(f)` 把 `(shot.in + f) / fps` 交给页面的 `window.render(t)`，页面按全片帧数打开（`events.frames`，没有就读 `film.json` 的 `output.frameCount`）。要取帧内的精确时刻传 `render(f, { timeSec })`，只限单子帧，且必须落在这一帧的区间里。
- 页面目录：`filmDir` 里没有入口、`film.json` 又写了 `mirror.paths: "repo"`（`films/beiming-10s`）时，自动改到仓库根的页面入口。
- 元数据：`camera`、`entities` 为 null，`lights` 为空，`texts` 来自 `window.TEXTS(t)`，透明度为 0 或空文字的不算。文字框认 `box: [x, y, w, h]`、`box: { x0, y0, x1, y1 }`、`box: { x, y, w, h }` 和条目顶层的 `x0..y1`，统一换成 `bbox2d: [x0, y0, x1, y1]`；可见文字的坐标不是有限数就报 `failure.render`。序列化后不超过 65536 字节：单条文字截到 1024 个字符，还塞不下的文字框丢弃，数目记在 `ext["legacy-page.texts-trimmed"]`。只取一个子帧时附 `ext["legacy-page.pixelSha256"]`，和 P9 金标清单同口径。
- 写文件：层文件只写进 `env.workspace`。镜头标识不合 `^[a-z][a-z0-9-]*$`、目标经符号链接或 `..` 落到工作区外，都报 `usage.bad-argument`，外面不留文件。
- 卡、叠加层、资产、`colorRef: scene` 都装不进旧页面，`open` 时报 `contract.unsupported-input`（没锁时先报 `env.lock-required`）。
- 进程退出：真浏览器会话共用 `engine/render` 的一个静态服务。开页失败、或最后一个会话 `close()` 之后，服务随即关掉，进程能自己退出；`browserSessions()` 返回还开着的会话数。
- 测试和别的宿主可以注入 `open(input, env, { driver })`，接口见 `host.mjs` 文件头。

## 已发布作品的锁与基线

`locks/<作品>.lock.json` 是 `beiming-10s`、`chendu`、`du` 的本机锁（`lock/1.0`），按 `film-upgrade` 升级后的片子描述生成，过 `lock-check/0.1`：种子照锁文件契约 5.7 派生，卡的版本和摘要取自 `beiming/cards` 里的真卡。镜头标识按契约改成小写（`A` → `a`、`S1` → `s1`）。

以下三种基线共用像素哈希 `sha256("RGB8 <宽>x<高>\n" + RGB 字节)`：

| 基线 | 文件 | 覆盖 | 帧标识 |
| --- | --- | --- | --- |
| `published`（默认） | `baselines/published-baselines.json` | 三部作品，每个镜头至少一帧，含全片首帧和末帧 | `f000010`（全片帧号补 6 位） |
| `golden` | `tests/golden/darwin-metal/manifest.json` 的 `beiming-core`、`beiming-detail` | 只有《北冥》10 秒样片，不含带调试参数的帧 | 同清单 |
| `style` | `docs/style-baselines/beiming-original@v1/darwin-metal.json` | 《北冥》冻结风格参照中无页面查询参数的成片帧，含 4K 裁切 | 同清单 |

`published` 的每一帧都由两条链各自算出、逐帧相同后才登记：旧截图链 `node engine/render/still.mjs <目录> --frame …` 的 PNG 解码后算一次，`legacy-page` 从 `films/<作品>` 加锁打开渲一次。基线绑定出片环境，`env` 记 `platform`、`arch`、`three`、`renderer`（另记 `os` 备查）；登记这份基线的机器（darwin 27.2.0 arm64）抽查《北冥》样片两帧，摘要与 P9 金标（darwin 25.5.0 arm64 上登记）不同，所以换机器要重新实测登记，不能照抄；环境不符时核对返回 `env-mismatch`，不算通过。

- `loadLegacyLock(workId)`：读锁。
- `getBaselineHashes(workId, { baseline })` 默认读取 `golden`。传 `baseline: 'style'` 读取冻结风格参照。
- `verifyBaselineHashes(workId, renderedHashes, { baseline, env })`：先核锁的帧源版本与 three，再核基线本身，最后逐帧比对，返回 `{ ok, mismatched, missing, reason? }`。缺集合、缺作品（`no-baseline`）、缺 `env.three`、three 不是 0.170.0、帧表为空（`empty-baseline`）、少帧、摘要不匹配、给了 `env` 而与基线不符（`env-mismatch`），一律 `ok: false` 并写明原因。
- `rebuildAndVerifyWork(workId, options)`：从真实的 `films/<作品>` 和锁打开 `legacy-page`，渲出基线规定的帧，从落盘的 f32 颜色层逐像素还原 RGB8 后计算摘要并对账。没有基线时不开页面；中途失败也会关净会话、清掉临时工作区。

```js
const r = await legacyPage.rebuildAndVerifyWork('du');   // { ok: true, mismatched: [], missing: [] }
```

单测：`node --test beiming/sources/legacy-page/legacy-page.test.mjs`。
