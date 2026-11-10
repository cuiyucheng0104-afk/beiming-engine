# 案例库工具（tools/casebook.py）

> 读者：查找、还原、核对历史案例的人与 agent；维护案例库的人｜状态：生效（2026-11-10）｜依据：决定 D02、D08、D10（[docs/decisions/2026-11-10-industrial-baseline.md](../decisions/2026-11-10-industrial-baseline.md)），命令约定 [docs/CLI.md](../CLI.md)

`casebook.py` 是案例库 `cases/` 的唯一工具：列出、核对、还原历史案例，维护 `catalog.json` 的哈希与权利字段，并生成案例卡与目录。它从不执行构建、安装、推理或渲染。命令在仓库根目录执行，经统一的 Python 入口启动（三个平台写法一样）：

```bash
node tools/env/py.mjs tools/casebook.py <命令> [案例编号] [选项]
```

## 命令

| 命令 | 作用 | 常用选项 |
|---|---|---|
| `list` | 列出案例：编号、技术状态、标题；内部案例带「[内部]」 | `--group <分组>`（拼错退出 2 并列出可选值：beiming-labs、local-films、ppt-keynote、ppt-stories、styles） |
| `check` | 核对 catalog、源文件哈希、素材引用、案例卡与海报、`cases/source` 里未登记的文件、家目录路径、两套 vendor 快照（清单、字节、Git blob、执行位）与 schemaVersion 2 字段；**收集全部问题后再退出**，通过时打印记录数、唯一源文件数与 vendor 文件数 | `--rights`：另核对权利字段与授权登记册一致、公开素材包不含内部素材 |
| `restore <编号>` | 还原到独立目录（默认 `out/casebook/<workspacePath>`），写 `ARCHIVE-RESTORED.json`、`RIGHTS.json` 与 `ARCHIVE-LICENSES/` | `--source-only`、`--download`、`--packs <目录>`、`--mirror <网址>`、`--retries <次数>`、`--dry-run`、`--if-exists fail\|skip`、`--strict`、`--include-internal`、`--lemo <目录>`、`--rog-host <主机>`、`--reverify` |
| `rehash --patch <补丁>` | 按补丁更新源文件的 `sha256` 与 `size`（先核对 catalog 记录的是旧值、磁盘上已是新内容；重复执行不改动） | `--mark <标签>` 给改过的条目记 `redactions`；`--dry-run` |
| `rights` | 按 [授权登记册](../rights/register.json) 算出每个案例的权利字段 | `--write` 写回 catalog；`--check` 不一致时退出 4 |
| `index` | 由 catalog 生成 `cases/entries/*.md`、`cases/INDEX.md`、`cases/index.html` 的数据与 `cases/NOTICES.md` 的署名段 | `--check` 只核对（过期退出 4）；`--dry-run` 只列要改的文件 |

全部命令支持 `--json`（stdout 只有一个 [信封](../CLI.md#2-输出) 对象，日志与提示走 stderr）、`--quiet`、`-h/--help`（不读目录、不写文件）。选项只对列出的命令有效，用错命令退出 2。

### 退出码

| 码 | 情形 |
|---|---|
| 0 | 成功（只有提示也算）；`check` 通过；`restore --if-exists skip` 跳过已还原的目录 |
| 1 | 读写出错、工具内部错误（设 `BEIMING_DEBUG=1` 看堆栈） |
| 2 | 用法错误：未知选项、`--group` 拼错、案例编号不存在（给出相近的编号）、目标目录已存在、还原路径含空格或引号等不安全字符 |
| 3 | 环境问题：缺素材包（提示 `--download` 或 `--packs`）、下载中断或网络不通（重跑同一条命令续传）、磁盘空间不够、`--strict` 下有未替换的还原标记 |
| 4 | 核对不通过：校验和不符、目录或快照有问题、补丁对不上、权利字段或生成文件过期 |
| 130 / 143 | 被中断：临时目录已删，下载的 `.partial` 保留以便续传 |

### 还原的细节

- **原子**：先在内存里核对并改写全部源文件，下载与解包写进同目录下的临时目录，全部成功才改名为目标目录；失败不留半个目录。
- **下载**：只取这个案例需要的包；边下边算 SHA256（大包不进内存）；中断时保留 `<包名>.partial`，下次用 HTTP Range 续传；网络错误与 408/425/429/5xx 按 1、2、4…秒（最多 30 秒）重试 `--retries` 次；`--mirror` 换下载地址，但只接受 catalog 记录的 SHA256；下载与解包前按目标磁盘的剩余空间检查（另留 256 MB 或 5% 余量），不够时退出 3。`--dry-run` 报告要写多少、缺哪些包、要下载多少。
- **还原标记**：`@@CASE_ROOT@@`、`@@WORKSPACE_ROOT@@`、`@@LEMO_ROOT@@` 自动替换；`@@ROG_HOST@@` 只在给了 `--rog-host` 时替换。没替换的标记逐行写进 `ARCHIVE-RESTORED.json` 的 `unresolvedTokens` 并在 stderr 提示；`--strict` 时有残留就拒绝还原（退出 3，什么都不写）。原脚本经家目录解析的路径（`~/`、`$HOME`、`expanduser`、`Path.home()`）改写进还原目录；有意读取真实家目录的凭据与工具原样保留并列在报告里。
- **权利**：`rights.clearance` 为 `internal` 的案例，以及公开案例里逐文件标为 `internal` 的素材，默认不写出（列在报告的 `withheld`），加 `--include-internal` 才还原。源码与文本本来就在仓库里，照常写出。`RIGHTS.json` 记录权利字段、认可状态、登记类别的义务与 agent 规则；`ARCHIVE-LICENSES/` 放这个案例需要的许可文本（归档权利说明；带字体时 OFL 1.1；用到 LemoLab 代码时其 MIT 声明；打包 three.js 时其 MIT 声明；有 CC BY 4.0 署名时其全文）。

## catalog.json 第 2 版的字段

在第 1 版的 `id`、`group`、`title`、`files`、`artifacts`、`entrypoints`、`requirements`、`notes`、`workspacePath`、`preview`、`poster` 之上**只加不删**（作品站与合规工具照常读取）：

| 字段 | 含义 |
|---|---|
| `schemaVersion` | 2 |
| `rights`（顶层） | 权利字段的来源与说明：登记册路径、登记册日期、算作内部的登记类别种类 |
| `cases[].status` | 兼容字段（作品站按它策展）：由 `technical` 与 `approval` 推出，`check` 核对一致 |
| `cases[].technical` | `status`：`rendered`（历史成片）/ `experiment` / `previs` / `interactive` / `support`；`qa.status`：`not-run` / `pass` / `fail`，`qa.report` 指 QA 报告 |
| `cases[].approval` | 用户认可，与技术状态无关：`status` 为 `approved` / `rejected` / `unreviewed`；`by`、`date`、`reasons`、`evidence`（用户原话或评审记录的位置）、`related`（相关但不是用户理由的材料）、`history`。`approved` 必须写 `by`、`date`、`evidence`；**agent 不能自己写 approved**（D08）。查不到的写「待补」或「原因未记录，待用户补充」，不编造 |
| `cases[].rights` | 由 `rights --write` 按登记册算出，不要手改：`clearance`（`public` / `internal` / `client-confidential`）、`register`（登记类别）、`owner`、`license`、`sourceUrl`、`attributionText`（CC BY 署名原文，取自案例自己的 CREDITS）、`aiGenerated`、`evidence` |
| `cases[].displayTitle`、`summary`、`keyFiles` | 目录与案例卡用：清理过的片名、卡片摘要、入口之外值得看的文件 |
| `files[].register`、`files[].clearance` | 逐文件命中的登记类别；在公开案例里命中客户、IP、参考图或商标类的素材标 `internal` |
| `files[].redactions` | 归档后在新提交里改过的原因，如 `signed-url-query`（去掉过期签名链接的查询串）；这时 `sha256` 与 `originalSha256` 不同 |
| `files[].originalSha256` | 原文件的哈希。带还原标记（`templated`）的条目**没有**这个字段：公开脱敏前的哈希能反推出标记原来的值 |

`clearance` 只管「能不能还原、能不能用进新作品」，不是下线清单：已经公开的展示与 Release 按 D02 不下线、不改写历史。

## 维护流程

- **改了归档文件**（例如按合规要求去掉一段文字）：用产出补丁的工具改文件，再 `rehash --patch <补丁> --mark <原因>`，然后 `check`。签名链接的清理就是这样做的：`node tools/compliance/signed-urls.mjs strip --write --patch-out <补丁>` → `rehash --patch <补丁> --mark signed-url-query`。
- **改了授权登记册**（`docs/rights/register.json`）：`rights --write` → `index` → `check --rights`；登记册的生成页由合规工具 `node tools/compliance/rights-inventory.mjs --write` 更新。
- **改了 catalog 的状态、标题或摘要**：`index` 重新生成案例卡与目录；`index --check` 与规范检查的 `cases.index` 规则会发现漏生成。
- **规范检查**：`node tools/repo-check.mjs --only cases`（`cases.catalog`、`cases.index`、`cases.rights`、`cases.commands` 四条）。`cases.rights` 直接调用合规工具的 JS 实现交叉核对 `rights` 字段，两边算法不一致会报错。
- **测试**：`node tools/env/py.mjs -m unittest discover -s tools -p test_casebook.py`（或 `node tools/run-tests.mjs --only tools`）。

还没有的命令（计划中）：`ingest`（把新作品按同一格式入库）、`pack`（按公开 / 内部两套打包并附 SHA256SUMS）、`publish --dry-run`；在它们完成前，新作品不进 `cases/`。
