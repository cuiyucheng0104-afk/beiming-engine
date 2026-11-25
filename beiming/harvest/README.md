# 收获

从团队片里找出值得下一部片复用的东西。调用方在交付读回后把片号、验证记录和模块描述交给 [`draftHarvestCandidates`](./draft.mjs)；没渲染、没读回或基础谓词没全过，整个批次跳过。模块只从通过镜头谓词的母语代码里起草，纯卡加数据的片仍能贡献检查、参数读回和返修规则。

从 [`index.mjs`](./index.mjs) 导入公开接口：

```js
const { candidates, skippedReason, rejected } = await draftHarvestCandidates(delivery, { runCalibration });
const queue = createHarvestQueue(previousState);
for (const candidate of candidates) queue.enqueue(candidate, { asOf, filmId: delivery.filmId, unlocksExams });
const harvest = queue.getBoardHarvestStats(); // buildBoard({ asOf, harvest })
```

待审卡不出现在默认检索里。同一部片重跑不多计；第二部片复用只生成提案，不代表已经验证。晋升必须由独立会话提交自测、校准和纯函数门证据，确认每个参数的单位，再通过正式卡校验。模块不自行写卡库、模板、先验表或看板。

- [输入字段、去重、清理和晋升示例](./DETAILS.md)
- [卡文件格式](../kernel/contracts/card-file/CONTRACT.md) · [题目文件格式](../kernel/contracts/question-file/CONTRACT.md) · [目录归属契约](../kernel/contracts/ownership/CONTRACT.md)
- 自测：`node --test beiming/harvest/harvest.test.mjs`
