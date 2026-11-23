# 技术卡

卡在 `cards/<类>/<名>/`。[组件契约](../kernel/contracts/)

## 扫参

```js
import { sweepCard } from './index.mjs';
await sweepCard(card, { params: { fovDeg: [30, 60] }, metrics: ['camera.fovDeg'] });
```

`axes` 可用 `{ param, values }` 或字符串 `'fovDeg=30,60'`。轴覆盖 `baseParams`，最多 64 格，每格最多 6 个 `frames` 或 `times`（秒），默认第 0 帧、24 fps。`inputs` 固定场景与种子，`events`、`shotIn` 解析时刻。

数据参数先按卡内 schema 校验。数据卡直跑。第三参 `{ evaluateCell }` 接收 `params`、`resolvedParams`、`frame`、`time`、`cellIndex`，返回 `readings`、数值字段或 `{ rgb, width, height, channels, referenceRgb }`。字节像素归一化，浮点按原值。Rec.709 亮度指标有 `lumaMean`、`lumaMin`、`lumaMax`、`lumaP05`、`lumaP50`、`lumaP95`、`lumaP99` 和 `contrast`（P95−P05）。另有 `highlightClipRatio`、`shadowCrushRatio`，以及需参考帧的 `psnr`、`ssim`、`maxDiff`。

`rows` 按 `columns` 排，数值保留 4 位小数。响应 ≤800 字节（UTF-8），`totalCells` 含各时刻，`omittedRows` 为省略行数。`outDir` 下的 `artifacts.cellsPath` 指向含原始读数与逐格 SHA-256 的 `cells.json`。`outDir` 应由调用方独占。拒绝业务软链和外来文件，可替换已核验产物。入参或目录无效报 `usage.bad-argument`，求值、量测、表头超限或产物格式与摘要错误报 `contract.bad-value`。

## 先验表

`priors.mjs` 校验并检索参考值表 `{ format: 'priors/0.1', entries }`，结果 `{ ok, errors, leaks }` 只含类型码与位置，不回显内容。

```js
import { createPriorsStore } from './index.mjs';
createPriorsStore(table).query({ unit: 'LUFS', onlyVerified: true });
```

- 每条必填 `id`、`domain`、`topic`、`title`、`value`、`unit`、`conditions.appliesWhen`、`provenance`（`caseId`、`evidenceLevel`）和 `verifiedInOurStack`。词表见 `PRIOR_UNITS`、`PRIOR_DOMAINS`、`PRIOR_EVIDENCE_LEVELS`，冲突项 `conflicts[]` 同样要单位。
- `value` 是数、数值向量或数值对象；两元数组当区间 `[min, max]`。`rgb-linear` 配 `scene-linear-rec709`，`rgb-display` 配 `srgb-display`，其他单位不得带 `colorSpace`。
- `verifiedInOurStack: true` 必须带 `readbackEvidence` 对象（含字符串 `envKey`、`reportSha256`），`false` 不得带；`false` 的值没在我方读回，不能当默认值。`get`/`query` 返回条目带 `readbackLabel`，`get`/`query`/`stats` 返回深冻结只读视图。
- 汇总行用无重复的字符串 ID 数组 `summaryOf` 指回明细，默认不进查询，`stats().detailCount` 不计。同子题、同案例、同适用条件只收一条。
- 拒收私有路径（`复刻/`、`调研资料/`、`北冥引擎规划/`、`实验室/`、`原包源码`、`cards-overlay`、`exams-hidden`）、`lab://`、本机路径（含 `~`、`/tmp/`、`file:///`，公开 `http(s)` 路由不误伤）、不带规范小写 `sha256:` 前缀的 64 位十六进制，以及非纯 JSON、保留键、重复 JSON 键、超安全整数、孤立代理码元。自检：`node --test beiming/cards/priors.test.mjs`。

## 第二批先验（C11）

`priors-batch2.mjs` 载入三份参数汇编迁入的数据：`arch-scene`（建筑、场景、地形与水，526 条）、`motion-rig`（动作与骨骼，609 条）、`light-cam`（光照、天空大气与相机，687 条）。

```js
import { loadBatch2PriorsStore, getBatch2CardPriors } from './index.mjs';
loadBatch2PriorsStore('light-cam').query({ unit: 'mm' });
getBatch2CardPriors('camera.shake'); // 三份都查；第二参限定某一份
```

- `loadBatch2PriorsStore(collection)`（另有 `loadArchScenePriorsStore` 等三个别名）回可移植量的检索库，条目全部「未在我方读回」。
- `getBatch2CardPriors(cardId, collection?)` 回挂卡先验（`useAsDefault: false`，卡在目标帧源重新标定读回前只作参考）；`getBatch2Practices(collection?)` 回做法与修法。
- `getBatch2MigrationManifest(collection)` 回总账：`rows` 逐条记去向 `route`、案例 `caseId`、挂卡行的目标卡 `target`、汇总行指回的明细 `summaryOf`。有可移植量的汇总行用 `detailRefs` 列出明细先验 ID。`routeOverrides` 记二审改判理由，`audit` 保留旧裁决，`blindAudit` 记新冻结盲样及其实际分歧；已知源文修复见 `knownFixes`。集合名见 `C11_COLLECTIONS`，写错抛 `TypeError`。自检：`node --test beiming/cards/c11-priors.test.mjs`。
