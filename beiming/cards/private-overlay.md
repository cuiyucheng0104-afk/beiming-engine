# 私有覆盖层与对拍

实验室在自己的 `cards-overlay/` 目录内按卡的完整 ID 保存 YAML。向 `mergeOverlay(card, overlayDir)` 传这个目录。读取器优先使用同名 `.yaml`，文件缺失时读取旧版 `.json`，文件存在但损坏则报错。YAML 支持缩进、行内映射和列表；字段使用普通字符串，文档拒绝重复键、自定义标签和别名。

覆盖层可填 `provenance.studied`、`provenance.lab`、`verify.parity.truth`、`priors[].source`。共同的 `ablation.lab` 会附到每条公开消融记录，也可按数组索引逐项填写。合并结果只在内存中用于本地对拍。测试通过 `runCardParity(t, card, overlayDir, compare)` 登记真值依赖；覆盖层或真值字段缺失时，测试运行器记录跳过。有真值时调用该卡的比对函数，比对失败会使测试失败。

提交门禁与 CI 通过 `comp.card-private` 对 `beiming/cards/` 下各卡目录中的 `card.json` 扫描原文，包括重复键和转义值。门禁报告泄漏类型；状态记录中的规范报告摘要可提交。源码与锁文件由已有合规规则检查。
