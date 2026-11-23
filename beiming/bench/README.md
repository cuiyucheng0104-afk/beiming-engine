# 考题

存放用于比较和验证系统表现的考题。

通过契约交接考题输入、运行产物和验收条件。跨组件通过契约交接，引用旧目录须命中白名单。

业务契约：[题目文件格式](../kernel/contracts/question-file/CONTRACT.md)（题面、判分与预算）、[谓词登记表](../kernel/contracts/predicates/CONTRACT.md)（题目引用的谓词）。

通用约定见[契约目录](../kernel/contracts/)、[契约写法约定](../kernel/contracts/CONVENTIONS.md)和[目录归属契约](../kernel/contracts/ownership/CONTRACT.md)。

## 题目文件校验

入口 `index.mjs`，测试 `node --test beiming/bench/schema.test.mjs`。

`validateQuestion(input)` 收题目对象或 JSON 原文，回 `{ ok, schemaErrors, violations: { 规则编号: [问题] }, leaks, parseError? }`，不抛错。重复的键和里面夹带的泄露只有原文查得出。按顺序查，不过就停：

1. **泄露门禁**（`scanQuestionLeaks`）：`lab://`、原包源码与私有覆盖层、`复刻/` 路径、`exams-hidden`、本机路径、裸的 64 位十六进制哈希（规范写法 `sha256:` 加 64 位小写十六进制放行），全角、夹零宽字符的也认。只回类型和位置（对象回 `path`，原文回 `line`），不回显内容；对象里的取值器不调，记 `accessor-property`，Symbol 键记 `symbol-key`，不可枚举属性记 `non-enumerable-property`，有空洞或带附加属性的数组记 `invalid-array`（里面照扫）。
2. **结构**：[`question.schema.json`](../kernel/contracts/question-file/schema/question.schema.json)。类实例、取值器、Symbol 键、不可枚举属性、数组的空洞和附加属性、非有限数、超出安全整数的整数字段、不成对的代理码元、开头的 BOM、环、原文里重复的键直接拒。`parseError` 是固定的一句，不回显原文。
3. **规则**，违反的记在 `violations`；`B1_*` 是契约不变量之外的增补：

| 编号 | 查什么 |
|---|---|
| `QF1`、`QF2` | 契约的不变量：权重和为 1；一项一条断言，谓词名登记过 |
| `B1_PREDICATE_SYNTAX` | 断言的语法和实参对登记表核（复用 `verify/predicates.mjs`）；`planned` 的谓词可以先写 |
| `B1_METRIC_NAMESPACE` | 这道题的指标名不得出现在 `needs` 里；在 `title`、`brief`、`pass`、`source`、`controls`、`calibration.source`、`blockedBy` 里单独提到要带 `metric:` 前缀 |
| `B1_REF_PATH` | `refs` 照通用路径口径：不含 `:` 和控制字符，不以 `/` 开头或结尾，没有空段和 `.` 段 |
| `B1_FPS` | `deliverable.fps` 的分子分母互质（时间键契约 3.2） |
| `B1_BLOCKED_BY` | `expectedFail` 是 `true` 时 `blockedBy` 不空，是 `false` 时为空 |

## 指标名

指标名和卡名都是点分小写（契约 5.3）。`scoring[].metric` 里只写指标名；别处单独提到指标一律带前缀，卡名不带。`formatMetricRef('loop.closure-psnr')` 回 `'metric:loop.closure-psnr'`，`parseMetricRef` 反过来；没带前缀、名字空、带版本都抛 `TypeError`。

## 起草形态

`normalizeQuestionDraft(draft)` 把起草写法换成 `question/0.1`，只换不校验，细则见 [DETAILS.md](DETAILS.md#起草形态)。

## 隐藏题

`projectPublicQuestion(question)` 回给做题方的副本，没过校验就抛错。隐藏题只留 `id`、`level`、`title`、`brief`、`deliverable`、`assets`（契约 5.5）；公开题只去掉私有的 `ext`。

## 跑题器

`node beiming/bench/runner.mjs run --question <题目> --root <仓库外目录> (--solver-cmd <命令> | --model <模型>)`，代码里用 `runExamQuestion()`。

题目先过校验（不过 exit 4），在 `<root>/<题号>/<runId>/` 下建 `worktree/`（只放公开投影 `question.json`），判完分写 `result.json`、`meta.json`、`observation.json`。exit 0 只表示跑完落盘，及格看 `pass`（布尔）与 `status`。隐藏题只落总分；`expectedFail` 题加 `--force-expected-fail` 才跑。

宿主判分（`defaultJudge`，缺 `ffprobe` exit 3）：实测做题目录的 `deliverable.mp4`，自报不算；没接量测器的项一律不过，条数记 `unmeasured`。

做题进程和宿主同用户：macOS 用 `sandbox-exec` 挡原题和别的运行，别的平台没有边界（看 `observation.json` 的 `isolation`）。细则见 [DETAILS.md](DETAILS.md)。

## 看板

`node beiming/bench/board.mjs build --out-dir <目录>` 把结果、账本、卡和先验汇成 `board.json`（`bench-board/0.1`）、每天一行的 `history.json` 和离线的 `index.html`；代码里用纯函数 `buildBoard`、`renderBoardHtml`、`appendBoardHistory`。帧源缺能力的格写「这个帧源没有这项能力」，不进均分；隐藏题只落总分。细则见 [DETAILS.md](DETAILS.md#看板)。

## 已知限制

- 没有指标登记表，指标名只认这道题 `scoring` 里的；卡和指标同名会被 `B1_METRIC_NAMESPACE` 拦。
- 比较后面的单位后缀（样题的 `in [359, 361] deg`）一律放行，不核单位和谓词对不对得上；`verify` 的解析器还不认。
- 不限输入大小。
