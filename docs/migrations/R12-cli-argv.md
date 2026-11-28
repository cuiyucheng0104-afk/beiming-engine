# R12 · 合规与环境工具的参数解析兼容矩阵

以提交 `490e76db` 的实际命令与调用者为基线。合规、环境命令继续用 Node 的严格 `parseArgs` 读取选项，共用解析错误的归类和中文消息，以及查找原样帮助标志的逻辑。两个外壳各自生成提示、错误对象、输出和退出码。共用函数位于现有的 [`tools/lib/cli.mjs`](../../tools/lib/cli.mjs)，该路径已纳入页面视频的依赖指纹。

| 输入 | 合规外壳 | 环境外壳 | 通用 `tools/lib/cli.mjs` |
| --- | --- | --- | --- |
| 短选项 | 声明 `-h` 为 `--help` 的别名。Node 允许 `-hh`，但这不会触发帮助预检 | 没有声明短选项，原样 `-h` 由帮助预检处理 | 根据声明识别布尔型短选项，预检也有 `--version` |
| 省略选项 | 各调用者自己提供默认值，Node 的 `values` 省略未出现的键 | 同左。远端 `compare` 按实际出现的键检查允许选项 | 布尔选项默认 `false`、列表默认 `[]`，其余填声明的默认值或 `null` |
| 重复与内联值 | 单值取最后一项。`scan --only`、`aigc --tool` 按顺序收集。接受 `--key=value`；布尔选项带值时报错 | 单值取最后一项。`doctor --route`、`preflight --need`、远端 `--route` 和 `--fetch` 按顺序收集。布尔选项带值时报错 | 非布尔单值重复时报错；列表可重复；布尔选项接受内联 `true/false/1/0` |
| 以 `-` 开头的值与 `--` | 分隔的选项状值报缺值。内联值可带 `-`；独立 `--` 之后的参数按位置处理 | 同左，`remote` 先截断传给环境外壳的参数，保留 `--` 之后的子命令原参 | 长选项读取下一个值时拒绝 `--` 或下一长选项，可读取短横线开头的值如负数 |
| 帮助与 JSON | 原样 `--help`、`-h` 抢先返回，原样 `--json` 决定信封，均扫描整个 argv。`scan` 的 JSON 帮助放在 `result.help`，其余命令的 `result` 为空 | 原样帮助标志抢先输出文本，原样 `--json` 选信封，均只扫描外壳收到的 argv | 全局扫描在 `--` 停止，也认 `--json=true`、`--json=1` |
| 未知选项、缺值、布尔选项带值 | 分别为 `usage.unknown-option`、`usage.missing-value`、`usage.bad-value`，提示有效选项清单 | 同三个码和消息，提示分别为 `全部选项见 --help`、内联值写法、直接写开关 | 有另外的提示和纠错规则，布尔型内联值规则见上 |
| 多余位置参数 | `scan` 和 `rights-inventory` 在 Node 解析时拒绝首个位置参数；`signed-urls` 接受一个且默认为 `list`；`aigc` 由子命令校验余项 | 普通环境入口先解析所有位置参数，再报出全部多余项；`remote` 最多三个，子命令自己的参数校验随后执行 | 按位置参数声明检查必填、默认值、变长及多余项 |

合规在语法错误时仍抛本地 `UsageError`，环境外壳使用本地 `CliError`，CLI 用法错误均退出 2。位置参数的先后校验会影响首条报错，例如 `scan first --bogus` 首先拒绝 `first`，`doctor first --bogus` 首先拒绝未知选项。合规 JSON 信封有 `result`，环境信封的命令数据在顶层。

P3 的 [remote](../../tools/remote/cli.mjs) 在第一个 `--` 切分本地与远端 argv，后半段不参与本地 help/JSON 检查。A18 的 `compare` 额外拒绝分隔符和比较以外的选项。工作站上传的 [agent](../../tools/remote/agent.mjs) 是独立单文件，命令执行从 Git 提交检出完整文件。[`env:py`](../../tools/env/py.mjs) 自己读取开头的标志，其余参数交给 Python。`check:repo --only env` 的 [独立入口](../../tools/repo-check/rules/env/index.mjs) 仍通过环境外壳解析。

实际入口回归见 [`tests/cli/r12-argv.test.mjs`](../../tests/cli/r12-argv.test.mjs)，远端传输、取回与清理由 [`tests/env/remote.test.mjs`](../../tests/env/remote.test.mjs) 覆盖。

macOS arm64 上，Node 24.13.1 与 25.6.0 分别在基线实现及改动后运行 `node --test tests/cli/r12-argv.test.mjs`，两边各通过 4 项（18 次真实命令调用及 1 项错误类型断言）。Linux 与 Windows 的实机结果由各平台的 CI 验证。
