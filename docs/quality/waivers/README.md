# QA 豁免记录

这里放「不改作品目录」时的豁免：`<作品 id>.json`。QA 跑 `report` / 各检查时自动读取与作品 id 同名的文件（作品 id 取 film.json 的 `id`，没有就取作品目录名）。规则见 [../QA-GATE.md §5](../QA-GATE.md)。

## 写法

```json
{
  "film": "beiming-10s",
  "waivers": [
    { "check": "texts.duration", "target": "subtitle", "frames": [228, 240],
      "reason": "为什么可以放行（一句话）",
      "approvedBy": "用户", "quote": "<用户原话，逐字>", "source": "<会话、日期、消息位置>", "date": "YYYY-MM-DD" }
  ]
}
```

- 一条只放行一项检查（`check`）里的一个对象（`target`：文字 id、事件 id、底板名）；`frames` 可选，半开区间。
- `approvedBy`、`quote`、`source` 必填。**agent 不得自己批准**（D08）：署名是 agent、AI、Claude、助手之类的，QA 直接忽略并报 warning。
- **agent 起草、用户批准**：agent 可以把建议写成 `"status": "proposed"`（`quote`、`source` 留空或写「待用户批准」），QA 不采用，只在报告里提示「有 N 条待用户批准的豁免」。用户在会话里明确同意后，由人把原话、出处、日期填上并删掉 `status`，豁免才生效；`tools/repo-check/rules/qa` 会检查生效的豁免字段齐全。
- 刻意的停顿、黑场、闪白不是豁免，写在作品 film.json 的 `qa.intentional`。

## 当前文件

| 文件 | 内容 | 状态 |
|---|---|---|
| [beiming-10s.json](beiming-10s.json) | 《北冥》显示层文字的停留与对比度（台账 QA-A-003）、片尾副标题 | 全部是待用户批准的草稿，未生效 |
