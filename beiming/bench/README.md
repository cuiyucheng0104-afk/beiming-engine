# 考题

存放用于比较和验证系统表现的考题。

通过契约交接考题输入、运行产物和验收条件。跨组件通过契约交接，引用旧目录须命中白名单。

业务契约：[题目文件格式](../kernel/contracts/question-file/CONTRACT.md)（题面、判分与预算）、[谓词登记表](../kernel/contracts/predicates/CONTRACT.md)（题目引用的谓词）。

通用约定见[契约目录](../kernel/contracts/)、[契约写法约定](../kernel/contracts/CONVENTIONS.md)和[目录归属契约](../kernel/contracts/ownership/CONTRACT.md)。

## 题目文件校验

入口 `index.mjs`，测试 `node --test beiming/bench/schema.test.mjs`。

`validateQuestion(input)` 收题目对象或 JSON 原文，回 `{ ok, schemaErrors, violations: { 规则编号: [问题] }, leaks, parseError? }`，不抛错。重复的键和里面夹带的泄露只有原文查得出。按顺序查，不过就停：

1. **泄露门禁**（`scanQuestionLeaks`）：`lab://`、原包源码与私有覆盖层、`复刻/` 路径、`exams-hidden`、本机路径、64 位十六进制哈希，全角、夹零宽字符的也认。只回类型和位置（对象回 `path`，原文回 `line`），不回显内容。
2. **结构**：[`question.schema.json`](../kernel/contracts/question-file/schema/question.schema.json)。类实例、取值器、非有限数、环、原文里重复的键直接拒。
3. **规则**，违反的记在 `violations`；`B1_*` 是契约不变量之外的增补：

| 编号 | 查什么 |
|---|---|
| `QF1`、`QF2` | 契约的不变量：权重和为 1；一项一条断言，谓词名登记过 |
| `B1_PREDICATE_SYNTAX` | 断言的语法和实参对登记表核（复用 `verify/predicates.mjs`）；`planned` 的谓词可以先写 |
| `B1_METRIC_NAMESPACE` | 这道题的指标名不得出现在 `needs` 里；在 `title`、`brief`、`pass`、`controls`、`calibration.source`、`blockedBy` 里单独提到要带 `metric:` 前缀 |
| `B1_FPS` | `deliverable.fps` 的分子分母互质（时间键契约 3.2） |
| `B1_BLOCKED_BY` | `expectedFail` 是 `true` 时 `blockedBy` 不空，是 `false` 时为空 |

## 指标名

指标名和卡名都是点分小写（契约 5.3）。`scoring[].metric` 里只写指标名；别处单独提到指标一律带前缀，卡名不带。`formatMetricRef('loop.closure-psnr')` 回 `'metric:loop.closure-psnr'`，`parseMetricRef` 反过来；没带前缀、名字空、带版本都抛 `TypeError`。

## 起草形态

`normalizeQuestionDraft(draft)` 把起草写法（YAML 读成的对象）换成 `question/0.1`，只换不校验：下划线键改小驼峰（到 `scoring[].args` 第一层为止，`assets`、`ext` 里的不动），`width`、`height` 并成 `size`，整数 `fps` 写成 `"n/1"`，`wall_s`（秒）换成 `wallMs`，`gpu_s` 换成 `gpuSeconds`，`初值未校准` 换成 `uncalibrated`，`metric:` 前缀去掉。新旧键并存（`size` 和 `width`）不覆盖，留给校验报错；一个键两种拼法并存或草稿不是纯数据抛 `TypeError`。

## 隐藏题

`projectPublicQuestion(question)` 回给做题方的副本，没过校验就抛错。隐藏题只留 `id`、`level`、`title`、`brief`、`deliverable`、`assets`（契约 5.5）；公开题只去掉私有的 `ext`。

## 已知限制

- 没有指标登记表，指标名只认这道题 `scoring` 里的；卡和指标同名会被 `B1_METRIC_NAMESPACE` 拦。
- 比较后面的单位后缀（样题的 `in [359, 361] deg`）一律放行，不核单位和谓词对不对得上；`verify` 的解析器还不认。
- 不限输入大小。
