# 从成片到候选卡

## 起草：交付方传入什么

`await draftHarvestCandidates(input, options)` 返回 `{ format: 'harvest-candidate/0.1', candidates, rejected, skippedReason }`。`skippedReason` 表示整部片没有准入，`rejected` 列出准入后个别材料被拒收的类别和原因码。输入是团队交付记录，不是对外部片子的扫描入口。共同条件为 `scope: 'team'`，且 `rendered`、`readbackVerified`、`basePredicatesPassed` 均为布尔 `true`。`filmId` 用脱敏片号；`authorSessionId` 是写片会话标识，不是作者姓名。

| `kind` | 输入 | 判成同一样的条件 |
|---|---|---|
| `module` | `nativeModules[]` 的 `sourceCode` 或模块描述。镜头 `shotPredicatesPassed: true`；`belongsToCard` 和 `cards-data` 模式不收此类。 | 去空白和注释的源码 SHA-256 相同，或入口签名相同、共有参数名数 ≥ 较大参数集合的 80%。 |
| `check` | `passedExtraPredicates[]`、`reviewSuggestedPredicates[]` 中的断言；检查登记表，按 `filmType` 写 `targetTemplate`。 | 按谓词登记表绑定参数后比较；命名实参的顺序和数值阈值不影响结果，目标不同或比较方向不同则不同。 |
| `prior` | `cardParamReadbacks[]` 的 `cardId, paramName, value, unit, readback`；`sceneScale, fps, viewTransform` 可由行或片子提供。 | 同卡、同参数。记录保留设置值和读回量，不能把设置值充当量测；缺证据、单位、上下文或有私有内容都不收。 |
| `pitfall` | `reworkRecords[]` 的 `code` 或 `category`，可带 `filmId, checkTarget, fixHint`。默认两条记录才起草；`options.minOccurrences` 可覆盖。 | `errorCode` 或 `ruleId` 任一相同。`occurrences` 是故障次数，队列的 `usedCount` 则数不同的片。 |

每个输入模块描述一个入口。可从 JS `function`（含对象解构）和 Python `def` 提取名称、默认值；`paramValues` 可提供片中实际使用的值，`params` 可补足类型、范围、单位等元数据。起草不执行源码。只有新卡才生成 `cardDraft` 并试跑注入的 `runCalibration(candidate, calibration, module)` 一次，支持异步回调；结果在 `calibrationCheck`。不提供渲染器时记录未跑，绝不当成校准通过。正式卡有真实落点时，请在模块描述中提供 `entry, selftest, calibration, exams`，以免使用草稿的约定位置。

`existingCards` 接收卡或带 `id, contentHash, entrySignature, params` 的索引行。相近项只给 `mergeIntoCard` 建议，没有新卡可检索或晋升。源码指纹只用于队列/比对，不能作为公开卡的验证证据。`computeCandidateKey` 供精确索引；80% 重合和 L1 规则别名都必须走 `isSameThing`，不能仅比较键字符串。

## 待审：怎样计数和清理

`createHarvestQueue(initialState?)` 接收 `getState()` 返回的 `{ pending, archived, promoted }` 快照。队列只改内存，不读系统时间；改变状态的操作必须给出 `YYYY-MM-DD` 日历日期 `asOf`。返回的条目和快照均是副本。调用方负责按事件顺序提交、落盘和恢复快照。

- `enqueue(candidate, { asOf, filmId, unlocksExams })` 返回入队后的条目。重复起草先合并，`usedByFilms` 以不同片号去重，出生片计一次；补充题号不重复。第二部片生成一次 `promotionProposal`，后续重复提交不重复提案。
- 只有待审集合占用 30 个名额。新条目遇到满队列，按 `lastUsedAt`、`createdAt`、`id` 升序淘汰一张，保留 `evicted-lru` 历史。
- 维护方（如周全卷）调用 `pruneExpired({ asOf })`：按创建日与给定日期的 UTC 日历日差，单片候选第 14 天保留，第 15 天以 `expired-14d` 归档。出生片重跑不延长截止日，已获第二片复用的候选不按该规则过期。
- `listCandidateCards()` 只投影待审模块卡，用 `ext['registry.candidate'] = true` 隐藏；可交给 `createCardRegistry`，`getCard` 按名可读，`searchCards` 不展示。
- `getBoardHarvestStats()` 只返回四个非负整数：`drafted` 是累计创建条目数（含已归档/晋升，不含去重重跑），`promoted`、`archived` 是对应历史条目数，`reproducedPromotions` 是晋升结果中达到 `reproduced` 的数量。直接传 `buildBoard({ asOf, harvest: queue.getBoardHarvestStats() })`。

## 晋升：提案不等于入库

```js
const result = promoteCandidateCard(item.promotionProposal, {
  harvestAgentSessionId: 'independent-review',
  selftestPassed: true, calibrationPassed: true, pureFunctionGatePassed: true,
  confirmedUnits: { distance: 'm' },
  host: 'node', source: 'three', gpu: 'software',
}, { asOf, queue });
if (result.ok) {
  // result.promotedCard 是已校验的 card/0.1；queue.getState() 已记录晋升。
}
```

`createPromotionProposal(item, { asOf })` 可独立检查复用门槛。`promoteCandidateCard` 不带 `queue` 是纯预检；带 `queue`（或直接 `queue.promote`）才提交状态变化。队列按自己的待审条目重新核验片号、写片会话和单位，不接受调用方改写的提案作为证据。三道门的布尔值和宿主环境应来自独立代理完成的实际试跑，不从候选草稿推断。未满两片返回 `harvest.insufficient-reuse`，写片会话自己晋升返回 `harvest.independent-agent-required`；缺证据返回 `harvest.missing-evidence` 和逐项 `missing`。正式卡契约未通过返回 `harvest.invalid-card` 及 `validateCard` 的诊断。失败不改变待审和看板；成功移除候选标记、写入带 `asOf` 的 `reproduced` 状态，只计一次晋升。
