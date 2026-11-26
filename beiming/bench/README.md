# 考题

存放用于比较和验证系统表现的考题。跨组件通过契约交接。

业务契约：[题目文件格式](../kernel/contracts/question-file/CONTRACT.md)（题面、判分与预算）、[谓词登记表](../kernel/contracts/predicates/CONTRACT.md)（题目引用的谓词）；通用约定见[契约目录](../kernel/contracts/)、[契约写法约定](../kernel/contracts/CONVENTIONS.md)与[目录归属契约](../kernel/contracts/ownership/CONTRACT.md)。

## 题目文件校验

入口 `index.mjs`，测试 `node --test beiming/bench/schema.test.mjs`。

`validateQuestion(input)` 收题目对象或 JSON 原文，回 `{ ok, schemaErrors, violations: { 规则编号: [问题] }, leaks, parseError? }`，不抛错。重复键与夹带泄露仅原文可查。按顺序查，不过即停：

1. **泄露门禁**（`scanQuestionLeaks`）：挡 `lab://`、原包源码/私有覆盖层、`复刻/` 路径、`exams-hidden`、本机路径、裸 64 位十六进制哈希（规范 `sha256:` 放行），全角与零宽字符同认。只回类型与位置不回显内容；取值器不调（`accessor-property`），Symbol 键、不可枚举属性与非密实数组照报。
2. **结构**：[`question.schema.json`](../kernel/contracts/question-file/schema/question.schema.json)。非普通对象、取值器、Symbol 键、不可枚举属性、数组空洞/附加属性、非有限数、超安全整数、不成对代理码元、BOM、环与重复键直接拒；`parseError` 固定文案不回显原文。
3. **规则**（`B1_*` 为增补规则）：

| 编号 | 查什么 |
|---|---|
| `QF1`、`QF2` | 契约不变量：权重和为 1；一项一条断言，谓词名已登记 |
| `B1_PREDICATE_SYNTAX` | 断言语法与实参核登记表（复用 `verify/predicates.mjs`）；`planned` 谓词可先写 |
| `B1_METRIC_NAMESPACE` | 指标名不得入 `needs`；文本字段单提指标须带 `metric:` 前缀 |
| `B1_REF_PATH` | `refs` 照通用路径口径：无 `:`、控制字符、首尾 `/`、空段和 `.` 段 |
| `B1_FPS` | `deliverable.fps` 分子分母互质（时间键契约 3.2） |
| `B1_BLOCKED_BY` | `expectedFail` 为 `true` 时 `blockedBy` 非空，为 `false` 时为空 |

## 指标名与起草/隐藏投影

- 指标名与卡名均为点分小写（契约 5.3）；`scoring[].metric` 写裸名，别处单提指标带前缀。`formatMetricRef('loop.closure-psnr')` ⇄ `parseMetricRef`，不合规抛 `TypeError`。
- `normalizeQuestionDraft(draft)` 将起草形态转为 `question/0.1`（只换不校验），见 [DETAILS.md](DETAILS.md#起草形态)。
- `projectPublicQuestion(question)` 生成做题方副本（未过校验抛错）：隐藏题只留 `id`、`level`、`title`、`brief`、`deliverable`、`assets`；公开题去私有 `ext`。

## 跑题器

`node beiming/bench/runner.mjs run --question <题目> --root <仓库外目录> (--solver-cmd <命令> | --model <模型>)`，代码入口 `runExamQuestion()`。

先过校验（不过 exit 4），在 `<root>/<题号>/<runId>/` 建 `worktree/`（只放公开投影 `question.json`），判完写 `result.json`、`meta.json`、`observation.json`。exit 0 仅表示跑完落盘，及格看 `pass` 与 `status`。隐藏题只落总分；`expectedFail` 题加 `--force-expected-fail` 才跑。宿主判分（`defaultJudge`，缺 `ffprobe` exit 3）实测 `deliverable.mp4`，未接量测器一律不过（计 `unmeasured`）。macOS 用 `sandbox-exec` 隔离，其余平台无边界，见 [DETAILS.md](DETAILS.md)。

## 离线考试核验

`node beiming/bench/exam.mjs [--out <目录>] [--json] [--dry-run] [--questions <题库目录>]`（测试 `node --test beiming/bench/exam.test.mjs`，代码入口 `runExam()`）。校验全部公开题、参考夹具内容与公开投影，再经 `runExamQuestion` 如实求值基础谓词并跑正负对照，写 `<out>/report.json`（`bench-exam-report/0.1`）。题库空或契约/夹具不过 exit 4，评测失败、负对照失守或全跳过无实跑 exit 1，绝不假绿。

## 看板

`node beiming/bench/board.mjs build --out-dir <目录>` 汇出 `board.json`（`bench-board/0.1`）、`history.json` 与离线 `index.html`（纯函数 `buildBoard`、`renderBoardHtml`、`appendBoardHistory`），见 [DETAILS.md](DETAILS.md#看板)。

## 已知限制

- 无独立指标登记表，仅认本题 `scoring` 指标；与卡同名由 `B1_METRIC_NAMESPACE` 拦截。
- 比较后单位后缀（如 `in [359, 361] deg`）暂放行，不核单位与谓词匹配。
- 不限输入大小。
